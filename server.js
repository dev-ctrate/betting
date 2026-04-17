const express = require("express");
const path = require("path");
const app = express();

const PORT = process.env.PORT || 3000;

// PASTE YOUR REAL API KEY HERE TOMORROW
const API_KEY = process.env.API_KEY;

// Store last 15 minutes of edge history per game
const historyStore = {};

// Create a stable game id
function makeGameId(game) {
  return `${game.away_team}-at-${game.home_team}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Keep only last 15 minutes of data
function trimHistory(gameId) {
  const cutoff = Date.now() - 15 * 60 * 1000;
  historyStore[gameId] = (historyStore[gameId] || []).filter(point => {
    return new Date(point.timestamp).getTime() >= cutoff;
  });
}

// Fetch real NBA odds
async function fetchNbaOdds() {
  const url =
    `https://api.the-odds-api.com/v4/sports/basketball_nba/odds/` +
    `?apiKey=${API_KEY}&regions=us&markets=h2h&oddsFormat=decimal`;

  const response = await fetch(url);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Odds API error ${response.status}: ${text}`);
  }

  return await response.json();
}

// Extract useful game data
function getGameData(rawGame) {
  if (!rawGame.bookmakers || rawGame.bookmakers.length === 0) {
    return null;
  }

  const bookmaker = rawGame.bookmakers[0];
  if (!bookmaker.markets || bookmaker.markets.length === 0) {
    return null;
  }

  const market = bookmaker.markets[0];
  if (!market.outcomes || market.outcomes.length < 2) {
    return null;
  }

  const homeOutcome = market.outcomes.find(
    outcome => outcome.name === rawGame.home_team
  );
  const awayOutcome = market.outcomes.find(
    outcome => outcome.name === rawGame.away_team
  );

  if (!homeOutcome || !awayOutcome) {
    return null;
  }

  const homeOdds = homeOutcome.price;
  const awayOdds = awayOutcome.price;

  const homeImpliedProbability = 1 / homeOdds;
  const awayImpliedProbability = 1 / awayOdds;

  // Temporary placeholder model for now
  const homeTrueProbability = Math.min(homeImpliedProbability + 0.03, 0.95);
  const awayTrueProbability = Math.min(awayImpliedProbability + 0.03, 0.95);

  const homeEdge = homeTrueProbability - homeImpliedProbability;
  const awayEdge = awayTrueProbability - awayImpliedProbability;

  const pickSide = homeEdge >= awayEdge ? "home" : "away";

  const selectedOdds = pickSide === "home" ? homeOdds : awayOdds;
  const impliedProbability =
    pickSide === "home" ? homeImpliedProbability : awayImpliedProbability;
  const trueProbability =
    pickSide === "home" ? homeTrueProbability : awayTrueProbability;
  const edge = pickSide === "home" ? homeEdge : awayEdge;
  const pick =
    pickSide === "home"
      ? `${rawGame.home_team} to win`
      : `${rawGame.away_team} to win`;

  let verdict = "Bad value";
  if (edge >= 0.05) {
    verdict = "Good value";
  } else if (edge > 0) {
    verdict = "Small edge";
  }

  return {
    id: makeGameId(rawGame),
    sport: "NBA",
    homeTeam: rawGame.home_team,
    awayTeam: rawGame.away_team,
    commenceTime: rawGame.commence_time,
    sportsbookOddsDecimal: selectedOdds,
    impliedProbability,
    trueProbability,
    edge,
    verdict,
    pick,
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
    apiKeyAdded: API_KEY !== "PASTE_YOUR_API_KEY_HERE",
    timestamp: new Date().toISOString()
  });
});

// List NBA games now to next 24 hours
app.get("/games", async (req, res) => {
  try {
    if (API_KEY === "PASTE_YOUR_API_KEY_HERE") {
      return res.json({
        mode: "setup",
        games: []
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

// Return selected game data + history
app.get("/odds", async (req, res) => {
  try {
    if (API_KEY === "PASTE_YOUR_API_KEY_HERE") {
      return res.status(400).json({
        error: "API key not added yet"
      });
    }

    const gameId = req.query.gameId;

    if (!gameId) {
      return res.status(400).json({
        error: "Missing gameId query parameter"
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
