const express = require("express");
const path = require("path");
const app = express();

const PORT = process.env.PORT || 3000;

// LIVE MODE:
// const API_KEY = process.env.API_KEY;

// MOCK MODE FOR TESTING:
const API_KEY = null;

const historyStore = {};
const teamFeatureCache = {};

// Cache NBA Stats features for 30 minutes
const TEAM_FEATURE_TTL_MS = 30 * 60 * 1000;

// 2025-26 for April 2026
const NBA_SEASON = "2025-26";
const NBA_SEASON_TYPE = "Regular Season";

const TEAM_ID_MAP = {
  "Atlanta Hawks": 1610612737,
  "Boston Celtics": 1610612738,
  "Brooklyn Nets": 1610612751,
  "Charlotte Hornets": 1610612766,
  "Chicago Bulls": 1610612741,
  "Cleveland Cavaliers": 1610612739,
  "Dallas Mavericks": 1610612742,
  "Denver Nuggets": 1610612743,
  "Detroit Pistons": 1610612765,
  "Golden State Warriors": 1610612744,
  "Houston Rockets": 1610612745,
  "Indiana Pacers": 1610612754,
  "LA Clippers": 1610612746,
  "Los Angeles Lakers": 1610612747,
  "Memphis Grizzlies": 1610612763,
  "Miami Heat": 1610612748,
  "Milwaukee Bucks": 1610612749,
  "Minnesota Timberwolves": 1610612750,
  "New Orleans Pelicans": 1610612740,
  "New York Knicks": 1610612752,
  "Oklahoma City Thunder": 1610612760,
  "Orlando Magic": 1610612753,
  "Philadelphia 76ers": 1610612755,
  "Phoenix Suns": 1610612756,
  "Portland Trail Blazers": 1610612757,
  "Sacramento Kings": 1610612758,
  "San Antonio Spurs": 1610612759,
  "Toronto Raptors": 1610612761,
  "Utah Jazz": 1610612762,
  "Washington Wizards": 1610612764
};

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

function makeGameId(game) {
  return `${game.away_team}-at-${game.home_team}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function trimHistory(gameId) {
  const cutoff = Date.now() - 15 * 60 * 1000;
  historyStore[gameId] = (historyStore[gameId] || []).filter(point => {
    return new Date(point.timestamp).getTime() >= cutoff;
  });
}

function getNbaStatsHeaders() {
  return {
    "Host": "stats.nba.com",
    "Connection": "keep-alive",
    "Cache-Control": "max-age=0",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json, text/plain, */*",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.nba.com",
    "Referer": "https://www.nba.com/"
  };
}

function getResultSetRow(data, targetNameContains = null) {
  if (!data || !Array.isArray(data.resultSets)) return null;

  let resultSet = data.resultSets[0];
  if (targetNameContains) {
    const found = data.resultSets.find(rs =>
      typeof rs.name === "string" &&
      rs.name.toLowerCase().includes(targetNameContains.toLowerCase())
    );
    if (found) resultSet = found;
  }

  if (!resultSet || !Array.isArray(resultSet.headers) || !Array.isArray(resultSet.rowSet)) {
    return null;
  }

  if (!resultSet.rowSet.length) return null;

  const headers = resultSet.headers;
  const row = resultSet.rowSet[0];
  const obj = {};

  headers.forEach((header, index) => {
    obj[header] = row[index];
  });

  return obj;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed ${response.status}: ${text}`);
  }

  return await response.json();
}

async function fetchNbaOdds() {
  const url =
    `https://api.the-odds-api.com/v4/sports/basketball_nba/odds/` +
    `?apiKey=${API_KEY}` +
    `&regions=us` +
    `&markets=h2h,spreads,totals` +
    `&oddsFormat=decimal`;

  return await fetchJson(url);
}

async function fetchTeamDashboard({ teamId, measureType, lastNGames = 0, location = "" }) {
  const params = new URLSearchParams({
    DateFrom: "",
    DateTo: "",
    GameSegment: "",
    LastNGames: String(lastNGames),
    LeagueID: "00",
    Location: location,
    MeasureType: measureType,
    Month: "0",
    OpponentTeamID: "0",
    Outcome: "",
    PORound: "0",
    PaceAdjust: "N",
    PerMode: "PerGame",
    Period: "0",
    PlusMinus: "N",
    Rank: "N",
    Season: NBA_SEASON,
    SeasonSegment: "",
    SeasonType: NBA_SEASON_TYPE,
    ShotClockRange: "",
    TeamID: String(teamId),
    VsConference: "",
    VsDivision: ""
  });

  const url = `https://stats.nba.com/stats/teamdashboardbygeneralsplits?${params.toString()}`;
  return await fetchJson(url, getNbaStatsHeaders());
}

async function getTeamFeatures(teamName) {
  const teamId = TEAM_ID_MAP[teamName];
  if (!teamId) {
    return null;
  }

  const cacheKey = `${teamId}`;
  const cached = teamFeatureCache[cacheKey];

  if (cached && (Date.now() - cached.timestamp < TEAM_FEATURE_TTL_MS)) {
    return cached.data;
  }

  const [
    seasonAdvancedRaw,
    last10AdvancedRaw,
    homeAdvancedRaw,
    roadAdvancedRaw,
    fourFactorsRaw
  ] = await Promise.all([
    fetchTeamDashboard({ teamId, measureType: "Advanced", lastNGames: 0, location: "" }),
    fetchTeamDashboard({ teamId, measureType: "Advanced", lastNGames: 10, location: "" }),
    fetchTeamDashboard({ teamId, measureType: "Advanced", lastNGames: 0, location: "Home" }),
    fetchTeamDashboard({ teamId, measureType: "Advanced", lastNGames: 0, location: "Road" }),
    fetchTeamDashboard({ teamId, measureType: "Four Factors", lastNGames: 0, location: "" })
  ]);

  const seasonAdvanced = getResultSetRow(seasonAdvancedRaw);
  const last10Advanced = getResultSetRow(last10AdvancedRaw);
  const homeAdvanced = getResultSetRow(homeAdvancedRaw);
  const roadAdvanced = getResultSetRow(roadAdvancedRaw);
  const fourFactors = getResultSetRow(fourFactorsRaw);

  const features = {
    teamId,
    netRating: Number(seasonAdvanced?.NET_RATING ?? 0),
    offRating: Number(seasonAdvanced?.OFF_RATING ?? 0),
    defRating: Number(seasonAdvanced?.DEF_RATING ?? 0),
    pace: Number(seasonAdvanced?.PACE ?? 0),
    pie: Number(seasonAdvanced?.PIE ?? 0),

    last10NetRating: Number(last10Advanced?.NET_RATING ?? 0),

    homeNetRating: Number(homeAdvanced?.NET_RATING ?? 0),
    roadNetRating: Number(roadAdvanced?.NET_RATING ?? 0),

    efgPct: Number(fourFactors?.EFG_PCT ?? 0),
    tovPct: Number(fourFactors?.TM_TOV_PCT ?? 0),
    orebPct: Number(fourFactors?.OREB_PCT ?? 0),
    ftRate: Number(fourFactors?.FTA_RATE ?? 0)
  };

  teamFeatureCache[cacheKey] = {
    timestamp: Date.now(),
    data: features
  };

  return features;
}

function buildStatsAdjustment(homeFeatures, awayFeatures) {
  if (!homeFeatures || !awayFeatures) {
    return 0;
  }

  // Season strength
  const seasonNetAdj = clamp(
    (homeFeatures.netRating - awayFeatures.netRating) * 0.0045,
    -0.08,
    0.08
  );

  // Recent form / momentum
  const formAdj = clamp(
    (homeFeatures.last10NetRating - awayFeatures.last10NetRating) * 0.003,
    -0.05,
    0.05
  );

  // Home/Road context
  const splitAdj = clamp(
    (homeFeatures.homeNetRating - awayFeatures.roadNetRating) * 0.0025,
    -0.04,
    0.04
  );

  // Four Factors blend
  const fourFactorScoreHome =
    (homeFeatures.efgPct * 0.40) -
    (homeFeatures.tovPct * 0.25) +
    (homeFeatures.orebPct * 0.20) +
    (homeFeatures.ftRate * 0.15);

  const fourFactorScoreAway =
    (awayFeatures.efgPct * 0.40) -
    (awayFeatures.tovPct * 0.25) +
    (awayFeatures.orebPct * 0.20) +
    (awayFeatures.ftRate * 0.15);

  const fourFactorAdj = clamp(
    (fourFactorScoreHome - fourFactorScoreAway) * 0.30,
    -0.03,
    0.03
  );

  return seasonNetAdj + formAdj + splitAdj + fourFactorAdj;
}

async function getGameData(rawGame) {
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

    if (spreadsMarket?.outcomes?.length >= 2) {
      const homeSpread = spreadsMarket.outcomes.find(
        o => o.name === rawGame.home_team
      );

      if (homeSpread && typeof homeSpread.point === "number") {
        const spreadAdj = clamp((-homeSpread.point) * 0.010, -0.08, 0.08);
        spreadSignals.push({ value: spreadAdj, weight });
      }
    }

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

  const homeMarketProb = weightedAverage(homeProbPairs);
  const awayMarketProb = weightedAverage(awayProbPairs);

  const homeDisagreement = variance(homeProbUnweighted);
  const awayDisagreement = variance(awayProbUnweighted);
  const disagreementPenalty = clamp(
    (homeDisagreement + awayDisagreement) * 8,
    0,
    0.03
  );

  const spreadAdj = weightedAverage(spreadSignals) || 0;

  const totalConsensus = weightedAverage(totalSignals) || 0;
  let totalAdj = 0;
  if (totalConsensus < 220) totalAdj = 0.004;
  if (totalConsensus > 235) totalAdj = -0.004;

  const [homeFeatures, awayFeatures] = await Promise.all([
    getTeamFeatures(rawGame.home_team),
    getTeamFeatures(rawGame.away_team)
  ]);

  const statsAdj = buildStatsAdjustment(homeFeatures, awayFeatures);

  let homeTrueProbability =
    homeMarketProb + spreadAdj + totalAdj + statsAdj - disagreementPenalty;
  let awayTrueProbability =
    awayMarketProb - spreadAdj - totalAdj - statsAdj - disagreementPenalty;

  homeTrueProbability = clamp(homeTrueProbability, 0.01, 0.99);
  awayTrueProbability = clamp(awayTrueProbability, 0.01, 0.99);

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

  const edge = pickSide === "home" ? homeEdge : awayEdge;

  const pick =
    pickSide === "home"
      ? `${rawGame.home_team} to win`
      : `${rawGame.away_team} to win`;

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
    statsAdj,
    homeFeatures,
    awayFeatures,
    timestamp: new Date().toISOString()
  };
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    apiKeyAdded: !!API_KEY,
    mode: API_KEY ? "live" : "mock",
    timestamp: new Date().toISOString()
  });
});

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

    const current = await getGameData(selectedRawGame);

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