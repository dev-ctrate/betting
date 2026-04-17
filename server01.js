const express = require("express");
const live = require("./live_tracker");

const ODDS_API_KEY = process.env.ODDS_API_KEY || "";

const app = express();
const PORT = process.env.PORT || 3001;

// ---------- helpers ----------
function round(num) {
  return Math.round(num * 1000) / 1000;
}

async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return JSON.parse(text);
}

function noVig(priceA, priceB) {
  const a = 1 / priceA;
  const b = 1 / priceB;
  const total = a + b;
  return { a: a / total, b: b / total };
}

// ---------- route ----------

app.get("/live", async (req, res) => {
  try {
    const { gameId } = req.query;

    if (!gameId) {
      return res.status(400).json({ error: "Missing gameId" });
    }

    // get live odds
    const oddsUrl = `https://api.the-odds-api.com/v4/sports/basketball_nba/events/${gameId}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=decimal`;

    const odds = await fetchJson(oddsUrl);

    const book = odds.bookmakers?.[0];
    const market = book?.markets?.[0];

    if (!market) {
      return res.status(500).json({ error: "No odds" });
    }

    const home = odds.home_team;
    const away = odds.away_team;

    const homeOdds = market.outcomes.find(o => o.name === home);
    const awayOdds = market.outcomes.find(o => o.name === away);

    const nv = noVig(homeOdds.price, awayOdds.price);

    // get live game-based probability
    const liveModel = await live.getLivePrediction(home, away);

    if (!liveModel) {
      return res.json({ error: "No live game found yet" });
    }

    const homeTrue = liveModel.homeProb;
    const awayTrue = liveModel.awayProb;

    const homeEdge = homeTrue - nv.a;
    const awayEdge = awayTrue - nv.b;

    const pick = homeEdge > awayEdge ? home : away;

    res.json({
      game: `${away} @ ${home}`,

      score: {
        home: liveModel.state.homeScore,
        away: liveModel.state.awayScore
      },

      time: liveModel.state.secondsRemaining,

      model: {
        home: round(homeTrue),
        away: round(awayTrue)
      },

      market: {
        home: round(nv.a),
        away: round(nv.b)
      },

      edge: {
        home: round(homeEdge),
        away: round(awayEdge)
      },

      pick
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- start ----------
app.listen(PORT, () => {
  console.log(`LIVE SERVER running on ${PORT}`);
});
