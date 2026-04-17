const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY || "";

// ---------- helpers ----------
function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function round(num) {
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 1000) / 1000;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  if (!res.ok) throw new Error(text);
  return JSON.parse(text);
}

// ---------- core live model ----------

function estimateWinProbability({ scoreDiff, secondsRemaining }) {
  // Base: score impact
  let prob = 0.5 + scoreDiff * 0.035;

  // Time decay: less time = stronger effect of score
  const timeFactor = clamp(1 - secondsRemaining / (48 * 60), 0, 1);

  prob += scoreDiff * 0.02 * timeFactor;

  return clamp(prob, 0.01, 0.99);
}

function extractGameState(game) {
  const homeScore = game.home_team_score;
  const awayScore = game.visitor_team_score;

  const scoreDiff = homeScore - awayScore;

  const period = game.period || 1;

  const clock = game.clock || "12:00";
  const [min, sec] = clock.split(":").map(Number);
  const secondsLeftInQuarter = min * 60 + sec;

  let secondsRemaining;

  if (period <= 4) {
    secondsRemaining =
      secondsLeftInQuarter + (4 - period) * 12 * 60;
  } else {
    secondsRemaining =
      secondsLeftInQuarter + (period - 5) * 5 * 60;
  }

  return {
    homeScore,
    awayScore,
    scoreDiff,
    period,
    secondsRemaining
  };
}

// ---------- main ----------

async function getLivePrediction(homeTeam, awayTeam) {
  const url = "https://api.balldontlie.io/v1/games";

  const data = await fetchJson(url, {
    headers: {
      Authorization: BALLDONTLIE_API_KEY
    }
  });

  const game = data.data.find(g =>
    g.home_team.full_name === homeTeam &&
    g.visitor_team.full_name === awayTeam
  );

  if (!game) return null;

  const state = extractGameState(game);

  const homeProb = estimateWinProbability(state);
  const awayProb = 1 - homeProb;

  return {
    state,
    homeProb,
    awayProb
  };
}

module.exports = {
  getLivePrediction
};
