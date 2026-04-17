const express = require("express");
const path = require("path");
const app = express();

const PORT = process.env.PORT || 3000;

// store last 15 minutes of data
let history = [];

// helper function to generate one NBA data point
function generateGameData() {
  const game = {
    sport: "NBA",
    homeTeam: "Lakers",
    awayTeam: "Warriors",
    pick: "Lakers to win",
    sportsbookOddsDecimal: 2.2
  };

  // simple simulated probability movement
  const trueProbability = 0.48 + Math.random() * 0.1; // between 0.48 and 0.58
  const impliedProbability = 1 / game.sportsbookOddsDecimal;
  const edge = trueProbability - impliedProbability;

  let verdict = "Bad value";
  if (edge >= 0.05) {
    verdict = "Good value";
  } else if (edge > 0) {
    verdict = "Small edge";
  }

  return {
    ...game,
    trueProbability,
    impliedProbability,
    edge,
    verdict,
    timestamp: new Date().toISOString()
  };
}

// seed first point if empty
if (history.length === 0) {
  history.push(generateGameData());
}

// update every 30 seconds
setInterval(() => {
  const newPoint = generateGameData();
  history.push(newPoint);

  const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;
  history = history.filter(point => {
    return new Date(point.timestamp).getTime() >= fifteenMinutesAgo;
  });
}, 30000);

// serve homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// return latest odds + history
app.get("/odds", (req, res) => {
  const latest = history[history.length - 1];

  res.json({
    ...latest,
    history: history.map(point => ({
      timestamp: point.timestamp,
      edge: point.edge
    }))
  });
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
