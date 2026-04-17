const express = require("express");
const path = require("path");
const app = express();

const PORT = process.env.PORT || 3000;

// LIVE MODE:
// const API_KEY = process.env.API_KEY;

// MOCK MODE FOR TESTING:
const API_KEY = null;

// Store last 15 minutes of edge history per game
const historyStore = {};

// Create a stable game id
function makeGameId(game) {
  return `${game.away_team}-at-${game.home_team}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Keep only last 15 minutes of history
function trimHistory(gameId) {
  const cutoff = Date.now() - 15 * 60 * 1000;
  historyStore[gameId] = (historyStore[gameId] || []).filter(point => {
    return new Date(point.timestamp).getTime() >= cutoff;
  });
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function variance(values) {
  if (!values.length) return 0;
  const avg = average(values);
  return average(values.map(v => (v - avg) ** 2));
}

function weightedAverage(pairs) {
  if (!pairs.length) return null;

  let numerator = 0;
  let denominator = 0;

  for (const pair of pairs) {
    numerator += pair.value * pair.weight;
    denominator += pair.weight;
  }

  return denominator === 0 ? null : numerator / denominator;
}

function noVigTwoWayProb(priceA, priceB) {
  const rawA = 1 / priceA;
  const rawB = 1 / priceB;
  const total = rawA + rawB;

  return {
    a: rawA / total,
    b: rawB / total
  };
}

function getBookWeight(bookKey) {
  const sharpBooks = ["pinnacle", "circasports", "matchbook"];
  const solidBooks = ["draftkings", "fanduel", "betmgm"];

  if (sharpBooks.includes(bookKey)) return 1.35;
  if (solidBooks.includes(bookKey)) return 1.1;
  return 1.0;
}

// Fetch real NBA odds
async function fetchNbaOdds() {
  const url =
    `https://api.the-odds-api.com/v4/sports/basketball_nba/odds/` +
    `?apiKey=${API_KEY}` +
    `&regions=us` +
    `&markets=h2h,spreads,totals` +
    `&oddsFormat=decimal`;

  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Odds API error ${response.status}: ${text}`);
  }

  return await response.json();
}

// Best possible "true probability" from odds-only inputs
function getGameData(rawGame) {
  if (!rawGame.bookmakers || rawGame.bookmakers.length === 0) {
    return null;
  }

  const homeProbPairs = [];
  const awayProbPairs = [];
  const homeProbUnweighted = [];
  const awayProbUnweighted = [];
  const spreadSignals = [];
  const totalSignals = [];

  for (const bookmaker of rawGame.bookmakers) {
    const weight = getBookWeight(bookmaker.key || "");

    const h2hMarket = bookmaker.markets?.find(m => m.key === "h2h");
    const spreadsMarket = bookmaker.markets?.find(m => m.key === "spreads");
    const totalsMarket = bookmaker.markets?.find(m => m.key === "totals");

    // Moneyline consensus
    if (h2hMarket?.outcomes?.length >= 2) {
      const homeOutcome = h2hMarket.outcomes.find(
        o => o.name === rawGame.home_team
      );
      const awayOutcome = h2hMarket.outcomes.find(
        o => o.name === rawGame.away_team
      );

      if (homeOutcome && awayOutcome) {
        const nv = noVigTwoWayProb(homeOutcome.price, awayOutcome.price);

        homeProbPairs.push({ value: nv.a, weight });
        awayProbPairs.push({ value: nv.b, weight });

        homeProbUnweighted.push(nv.a);
        awayProbUnweighted.push(nv.b);
      }
    }

    // Spread context
    if (spreadsMarket?.outcomes?.length >= 2) {
      const homeSpread = spreadsMarket.outcomes.find(
        o => o.name === rawGame.home_team
      );

      if (homeSpread && typeof homeSpread.point === "number") {
        // More negative home spread means stronger home team
        const spreadAdj = clamp((-homeSpread.point) * 0.010, -0.08, 0.08);
        spreadSignals.push({ value: spreadAdj, weight });
      }
    }

    // Total context
    if (totalsMarket?.outcomes?.length >= 2) {
      const over = totalsMarket.outcomes.find(o => o.name === "Over");
      if (over && typeof over.point === "number") {
        totalSignals.push({ value: over.point, weight });
      }
    }
  }

  if (!homeProbPairs.length || !awayProbPairs.length) {
    return null;
  }

  // Base fair probabilities from no-vig consensus
  const homeMarketProb = weightedAverage(homeProbPairs);
  const awayMarketProb = weightedAverage(awayProbPairs);

  // Penalize disagreement between books
  const homeDisagreement = variance(homeProbUnweighted);
  const awayDisagreement = variance(awayProbUnweighted);
  const disagreementPenalty = clamp(
    (homeDisagreement + awayDisagreement) * 8,
    0,
    0.03
  );

  // Spread signal
  const spreadAdj = weightedAverage(spreadSignals) || 0;

  // Totals signal
  const totalConsensus = weightedAverage(totalSignals) || 0;
  let totalAdj = 0;
  if (totalConsensus < 220) totalAdj = 0.004;
  if (totalConsensus > 235) totalAdj = -0.004;

  // Build "true" probabilities from available market info
  let homeTrueProbability =
    homeMarketProb + spreadAdj + totalAdj - disagreementPenalty;
  let awayTrueProbability =
    awayMarketProb - spreadAdj - totalAdj - disagreementPenalty;

  homeTrueProbability = clamp(homeTrueProbability, 0.01, 0.99);
  awayTrueProbability = clamp(awayTrueProbability, 0.01, 0.99);

  // Normalize back to 100%
  const totalProb = homeTrueProbability + awayTrueProbability;
  homeTrueProbability = homeTrueProbability / totalProb;
  awayTrueProbability = awayTrueProbability / totalProb;

  const homeEdge = homeTrueProbability - homeMarketProb;
  const awayEdge = awayTrueProbability - awayMarketProb;

  const pickSide = homeEdge >= awayEdge ? "home" : "away";

  const impliedProbability =
    pickSide === "home" ? homeMarketProb : awayMarketProb;

  const trueProbability =
    pickSide === "home" ? homeTrueProbability : awayTrueProbability;

  const edge =
    pickSide === "home" ? homeEdge : awayEdge;

  const pick =
    pickSide === "home"
      ? `${rawGame.home_team} to win`
      : `${rawGame.away_team} to win`;

  // Display chosen side's odds from first bookmaker for UI
  let sportsbookOddsDecimal = null;
  const firstBookH2H = rawGame.bookmakers[0]?.markets?.find(m => m.key === "h2h");

  if (firstBookH2H?.outcomes?.length >= 2) {
    const chosenOutcome = firstBookH2H.outcomes.find(o =>
      o.name === (pickSide === "home" ? rawGame.home_team : rawGame.away_team)
    );

    if (chosenOutcome) {
      sportsbookOddsDecimal = chosenOutcome.price;
    }
  }

  let verdict = "Bad value";
  if (edge >= 0.04) {
    verdict = "Good value";
  } else if (edge >= 0.015) {
    verdict = "Small edge";
  }

  return {
    id: makeGameId(rawGame),
    sport: "NBA",
    homeTeam: rawGame.home_team,
    awayTeam: rawGame.away_team,
    commenceTime: rawGame.commence_time,
    sportsbookOddsDecimal,
    impliedProbability,
    trueProbability,
    edge,
    verdict,
    pick,
    disagreementPenalty,
    totalConsensus,
    timestamp: new Date().toISOString()
  };
}

// Homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    apiKeyAdded: !!API_KEY,
    mode: API_KEY ? "live" : "mock",
    timestamp: new Date().toISOString()
  });
});

// Games list
app.get("/games", async (req, res) => {
  try {
    if (!API_KEY) {
      return res.json({
        mode: "mock",
        games: [
          {
            id: "warriors-at-suns",
            label: "Golden State Warriors @ Phoenix Suns",
            homeTeam: "Phoenix Suns",
            awayTeam: "Golden State Warriors",
            commenceTime: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
          },
          {
            id: "hornets-at-magic",
            label: "Charlotte Hornets @ Orlando Magic",
            homeTeam: "Orlando Magic",
            awayTeam: "Charlotte Hornets",
            commenceTime: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString()
          }
        ]
      });
    }

    const rawGames = await fetchNbaOdds();

    const now = Date.now();
    const next24Hours = now + 24 * 60 * 60 * 1000;

    const filteredGames = rawGames
      .filter(game => {
        const commence = new Date(game.commence_time).getTime();
        return commence >= now && commence <= next24Hours;
      })
      .map(game => ({
        id: makeGameId(game),
        label: `${game.away_team} @ ${game.home_team}`,
        homeTeam: game.home_team,
        awayTeam: game.away_team,
        commenceTime: game.commence_time
      }));

    res.json({
      mode: "live",
      games: filteredGames
    });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      games: []
    });
  }
});

// Selected game dashboard data
app.get("/odds", async (req, res) => {
  try {
    const gameId = req.query.gameId;

    if (!gameId) {
      return res.status(400).json({
        error: "Missing gameId query parameter"
      });
    }

    if (!API_KEY) {
      const mockGames = {
        "warriors-at-suns": {
          id: "warriors-at-suns",
          homeTeam: "Phoenix Suns",
          awayTeam: "Golden State Warriors",
          pick: "Phoenix Suns to win",
          sportsbookOddsDecimal: 2.15
        },
        "hornets-at-magic": {
          id: "hornets-at-magic",
          homeTeam: "Orlando Magic",
          awayTeam: "Charlotte Hornets",
          pick: "Orlando Magic to win",
          sportsbookOddsDecimal: 1.80
        }
      };

      const game = mockGames[gameId];

      if (!game) {
        return res.status(404).json({
          error: "Mock game not found"
        });
      }

      const rawHome = 1 / game.sportsbookOddsDecimal;
      const rawAway = 1 / (game.sportsbookOddsDecimal + 0.25);
      const total = rawHome + rawAway;
      const impliedProbability = rawHome / total;

      let trueProbability = impliedProbability + 0.02 + Math.random() * 0.02;
      trueProbability = clamp(trueProbability, 0.01, 0.99);

      let edge = trueProbability - impliedProbability;

      if (!historyStore[gameId]) {
        historyStore[gameId] = [];
      }

      if (historyStore[gameId].length > 0) {
        const previousEdge = historyStore[gameId][historyStore[gameId].length - 1].edge;
        edge = previousEdge * 0.65 + edge * 0.35;
      }

      let verdict = "Bad value";
      if (edge >= 0.04) {
        verdict = "Good value";
      } else if (edge >= 0.015) {
        verdict = "Small edge";
      }

      const current = {
        ...game,
        impliedProbability,
        trueProbability,
        edge,
        verdict,
        timestamp: new Date().toISOString()
      };

      historyStore[gameId].push({
        timestamp: current.timestamp,
        edge: current.edge
      });

      trimHistory(gameId);

      return res.json({
        ...current,
        history: historyStore[gameId]
      });
    }

    const rawGames = await fetchNbaOdds();
    const selectedRawGame = rawGames.find(game => makeGameId(game) === gameId);

    if (!selectedRawGame) {
      return res.status(404).json({
        error: "Game not found"
      });
    }

    const current = getGameData(selectedRawGame);

    if (!current) {
      return res.status(500).json({
        error: "Could not extract odds for game"
      });
    }

    if (!historyStore[gameId]) {
      historyStore[gameId] = [];
    }

    if (historyStore[gameId].length > 0) {
      const previousEdge = historyStore[gameId][historyStore[gameId].length - 1].edge;
      current.edge = previousEdge * 0.65 + current.edge * 0.35;
    }

    historyStore[gameId].push({
      timestamp: current.timestamp,
      edge: current.edge
    });

    trimHistory(gameId);

    res.json({
      ...current,
      history: historyStore[gameId]
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});