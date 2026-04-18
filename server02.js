const express = require("express");
const path = require("path");

const learning = require("./learning");
const { buildEliteLiveModel } = require("./live_model");
const { getLiveTrackerData } = require("./live_tracker");
const { buildModelReview } = require("./model_review");

const app = express();
const PORT = process.env.PORT || 3000;

const ODDS_API_KEY = process.env.ODDS_API_KEY || "";

const SPORT_KEY = "basketball_nba";
const REGIONS = "us";
const ODDS_FORMAT = "decimal";
const FEATURED_MARKETS = "h2h,spreads,totals";
const CURRENT_TTL_MS = 20 * 1000;
const SNAPSHOT_RETENTION = 500;

const currentCache = new Map();
const edgeHistoryStore = {};
const snapshotLogStore = {};

app.use(express.json());

process.on("unhandledRejection", (reason) => {
  console.error("UNHANDLED REJECTION:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function roundToTwo(num) {
  if (typeof num !== "number" || !Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}

function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;

  if (Date.now() > hit.expiresAt) {
    map.delete(key);
    return null;
  }

  return hit.value;
}

function cacheSet(map, key, value, ttlMs) {
  map.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(`Request failed ${response.status}: ${text}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Invalid JSON response from ${url}: ${text.slice(0, 300)}`);
    }
  } catch (err) {
    throw new Error(`fetchJson failed for ${url}: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function buildOddsUrl(pathname, params) {
  const base = `https://api.the-odds-api.com${pathname}`;
  const sp = new URLSearchParams(params);
  return `${base}?${sp.toString()}`;
}

function requireOddsKey() {
  return !!ODDS_API_KEY;
}

function buildMode(commenceTime) {
  const startMs = new Date(commenceTime).getTime();
  return Date.now() >= startMs ? "live" : "pregame";
}

function decimalToAmerican(decimalOdds) {
  if (typeof decimalOdds !== "number" || decimalOdds <= 1) return null;
  if (decimalOdds >= 2) return Math.round((decimalOdds - 1) * 100);
  return Math.round(-100 / (decimalOdds - 1));
}

function probabilityToDecimal(probability) {
  if (typeof probability !== "number" || probability <= 0 || probability >= 1) {
    return null;
  }
  return 1 / probability;
}

function probabilityToAmerican(probability) {
  const decimal = probabilityToDecimal(probability);
  return decimalToAmerican(decimal);
}

function buildOddsFormatsFromDecimal(decimalOdds) {
  if (typeof decimalOdds !== "number" || decimalOdds <= 1) {
    return {
      decimal: null,
      american: null,
      impliedPercent: null
    };
  }

  const implied = 1 / decimalOdds;
  return {
    decimal: roundToTwo(decimalOdds),
    american: decimalToAmerican(decimalOdds),
    impliedPercent: roundToTwo(implied)
  };
}

function buildProbabilityFormats(probability) {
  return {
    percent: roundToTwo(probability),
    american: probabilityToAmerican(probability)
  };
}

function formatClockFromSeconds(clockSec) {
  if (typeof clockSec !== "number" || !Number.isFinite(clockSec)) return "-";
  const mins = Math.floor(clockSec / 60);
  const secs = Math.floor(clockSec % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function safeLearningSummary() {
  return typeof learning.getLearningSummary === "function"
    ? learning.getLearningSummary()
    : {};
}

function safeCalibrationTable() {
  return typeof learning.getCalibrationTable === "function"
    ? learning.getCalibrationTable()
    : {};
}

function safeBuildCalibrationTable() {
  return typeof learning.buildCalibrationTable === "function"
    ? learning.buildCalibrationTable()
    : {};
}

function safeRecordSnapshot(snapshot) {
  if (typeof learning.recordSnapshot === "function") {
    learning.recordSnapshot(snapshot);
  }
}

function safeGetSnapshots() {
  return typeof learning.getSnapshots === "function"
    ? learning.getSnapshots()
    : [];
}

function safeUpdateGameResult(payload) {
  if (typeof learning.updateGameResult === "function") {
    return learning.updateGameResult(payload);
  }
  return 0;
}

function safeApplyCalibration(prob) {
  return typeof learning.applyCalibration === "function"
    ? learning.applyCalibration(prob)
    : prob;
}

function normalizeTeamName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function teamsMatch(event, homeTeam, awayTeam) {
  return (
    normalizeTeamName(event?.home_team) === normalizeTeamName(homeTeam) &&
    normalizeTeamName(event?.away_team) === normalizeTeamName(awayTeam)
  );
}

function trimEdgeHistory(gameId) {
  const cutoff = Date.now() - 15 * 60 * 1000;
  edgeHistoryStore[gameId] = (edgeHistoryStore[gameId] || []).filter(point => {
    return new Date(point.timestamp).getTime() >= cutoff;
  });
}

function addEdgeHistory(gameId, edge, timestamp) {
  if (!edgeHistoryStore[gameId]) {
    edgeHistoryStore[gameId] = [];
  }

  let smoothedEdge = edge;
  if (edgeHistoryStore[gameId].length > 0) {
    const prev = edgeHistoryStore[gameId][edgeHistoryStore[gameId].length - 1].edge;
    smoothedEdge = prev * 0.55 + edge * 0.45;
  }

  edgeHistoryStore[gameId].push({
    timestamp,
    edge: smoothedEdge
  });

  trimEdgeHistory(gameId);
  return smoothedEdge;
}

function logSnapshot(gameId, snapshot) {
  if (!snapshotLogStore[gameId]) {
    snapshotLogStore[gameId] = [];
  }

  snapshotLogStore[gameId].push(snapshot);

  if (snapshotLogStore[gameId].length > SNAPSHOT_RETENTION) {
    snapshotLogStore[gameId] = snapshotLogStore[gameId].slice(-SNAPSHOT_RETENTION);
  }
}

async function getCurrentFeaturedBoard() {
  const cacheKey = "featured-board";
  const hit = cacheGet(currentCache, cacheKey);
  if (hit) return hit;

  const url = buildOddsUrl(`/v4/sports/${SPORT_KEY}/odds`, {
    apiKey: ODDS_API_KEY,
    regions: REGIONS,
    markets: FEATURED_MARKETS,
    oddsFormat: ODDS_FORMAT
  });

  const data = await fetchJson(url);
  cacheSet(currentCache, cacheKey, data, CURRENT_TTL_MS);
  return data;
}

async function resolveFeaturedOdds({ gameId, homeTeam, awayTeam }) {
  let featured = null;

  if (gameId) {
    try {
      const cacheKey = `featured:${gameId}`;
      const hit = cacheGet(currentCache, cacheKey);

      if (hit) {
        featured = hit;
      } else {
        const url = buildOddsUrl(`/v4/sports/${SPORT_KEY}/events/${gameId}/odds`, {
          apiKey: ODDS_API_KEY,
          regions: REGIONS,
          markets: FEATURED_MARKETS,
          oddsFormat: ODDS_FORMAT
        });

        featured = await fetchJson(url);
        cacheSet(currentCache, cacheKey, featured, CURRENT_TTL_MS);
      }

      if (featured?.home_team && featured?.away_team) {
        return featured;
      }
    } catch (err) {
      const msg = String(err.message || "");
      const invalidEvent =
        msg.includes("INVALID_EVENT_ID") ||
        msg.includes("invalid event_id parameter") ||
        msg.includes("422");

      if (!invalidEvent) {
        throw err;
      }
    }
  }

  if (!homeTeam || !awayTeam) {
    throw new Error("Could not resolve odds event. Missing homeTeam/awayTeam fallback.");
  }

  const board = await getCurrentFeaturedBoard();
  const matched = (board || []).find(event => teamsMatch(event, homeTeam, awayTeam));

  if (!matched) {
    throw new Error(`Could not find Odds API event for ${awayTeam} @ ${homeTeam}`);
  }

  return matched;
}

async function getEventPlayerPropsByResolvedEvent(eventId) {
  if (!eventId) return { bookmakers: [] };

  const cacheKey = `props:${eventId}`;
  const hit = cacheGet(currentCache, cacheKey);
  if (hit) return hit;

  const url = buildOddsUrl(`/v4/sports/${SPORT_KEY}/events/${eventId}/odds`, {
    apiKey: ODDS_API_KEY,
    regions: REGIONS,
    markets: "player_points,player_rebounds,player_assists,player_points_rebounds_assists",
    oddsFormat: ODDS_FORMAT
  });

  try {
    const data = await fetchJson(url);
    cacheSet(currentCache, cacheKey, data, CURRENT_TTL_MS);
    return data;
  } catch (err) {
    console.error("getEventPlayerPropsByResolvedEvent failed:", err.message);
    return { bookmakers: [] };
  }
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    oddsApiKeyAdded: requireOddsKey(),
    mode: requireOddsKey() ? "live" : "mock",
    timestamp: new Date().toISOString()
  });
});

app.get("/games", async (req, res) => {
  try {
    if (!requireOddsKey()) {
      return res.status(400).json({
        error: "Missing ODDS_API_KEY",
        games: []
      });
    }

    const board = await getCurrentFeaturedBoard();

    const games = (board || [])
      .map(event => ({
        id: event.id,
        label: `${event.away_team} @ ${event.home_team}`,
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        commenceTime: event.commence_time,
        mode: buildMode(event.commence_time)
      }))
      .sort((a, b) => {
        if (a.mode === "live" && b.mode !== "live") return -1;
        if (a.mode !== "live" && b.mode === "live") return 1;
        return new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime();
      });

    res.json({ games });
  } catch (error) {
    res.status(500).json({
      error: error.message,
      games: []
    });
  }
});

app.get("/odds", async (req, res) => {
  try {
    if (!requireOddsKey()) {
      return res.status(400).json({ error: "Missing ODDS_API_KEY" });
    }

    const gameId = req.query.gameId || "";
    const homeTeam = req.query.homeTeam || "";
    const awayTeam = req.query.awayTeam || "";

    if (!gameId && (!homeTeam || !awayTeam)) {
      return res.status(400).json({
        error: "Need either gameId or both homeTeam and awayTeam"
      });
    }

    const featured = await resolveFeaturedOdds({
      gameId,
      homeTeam,
      awayTeam
    });

    const props = await getEventPlayerPropsByResolvedEvent(featured.id);

    const liveState = await getLiveTrackerData({
      gameId,
      homeTeam: featured.home_team,
      awayTeam: featured.away_team
    });

    const finalModel = buildEliteLiveModel({
      featuredOdds: featured,
      liveState,
      pregameBaseline: null,
      calibrationFn: safeApplyCalibration
    });

    const timestamp = new Date().toISOString();
    const pick = `${finalModel.pickTeam} to win`;
    const edgeKey = featured.id || gameId || `${featured.home_team}_${featured.away_team}`;
    const smoothedEdge = addEdgeHistory(edgeKey, finalModel.calibratedEdge, timestamp);

    const liveScoreState = {
      ...finalModel.scoreState,
      formattedClock: formatClockFromSeconds(finalModel.scoreState?.clockSec)
    };

    const snapshot = {
      gameId: edgeKey,
      timestamp,
      commenceTime: featured.commence_time,
      homeTeam: featured.home_team,
      awayTeam: featured.away_team,
      mode: "live",
      pickSide: finalModel.pickSide,
      pickTeam: finalModel.pickTeam,
      pick,
      impliedProbability: finalModel.impliedProbability,
      trueProbability: finalModel.trueProbability,
      calibratedTrueProbability: finalModel.calibratedTrueProbability,
      rawEdge: finalModel.rawEdge,
      edge: smoothedEdge,
      calibratedEdge: finalModel.calibratedEdge,
      sportsbookDecimal: finalModel.sportsbookDecimal,
      verdict: finalModel.verdict,
      confidenceLabel: finalModel.confidence.label,
      confidencePercent: finalModel.confidence.percent,
      ...finalModel.modelDetails,
      ...(finalModel.featureSnapshot || {}),
      source: "live"
    };

    logSnapshot(edgeKey, snapshot);
    safeRecordSnapshot({
      ...snapshot,
      result: null
    });

    res.json({
      id: featured.id,
      homeTeam: featured.home_team,
      awayTeam: featured.away_team,
      commenceTime: featured.commence_time,
      gameMode: "live",
      pick,
      verdict: finalModel.verdict,
      confidence: {
        label: finalModel.confidence.label,
        percent: roundToTwo(finalModel.confidence.percent)
      },
      noBetFilter: finalModel.noBetFilter || { blocked: false, reasons: [] },
      impliedProbability: roundToTwo(finalModel.impliedProbability),
      impliedPercentFromOdds: roundToTwo(finalModel.impliedProbability),
      trueProbability: roundToTwo(finalModel.trueProbability),
      calibratedTrueProbability: roundToTwo(finalModel.calibratedTrueProbability),
      impliedProbabilityFormats: finalModel.impliedProbabilityFormats,
      trueProbabilityFormats: finalModel.trueProbabilityFormats,
      edge: roundToTwo(smoothedEdge),
      rawEdge: roundToTwo(finalModel.rawEdge),
      calibratedEdge: roundToTwo(finalModel.calibratedEdge),
      oddsFormats: finalModel.oddsFormats,
      sportsbookOddsDecimal: roundToTwo(finalModel.sportsbookDecimal),
      stakeSuggestion: finalModel.stakeSuggestion,
      learningSummary: safeLearningSummary(),
      history: (edgeHistoryStore[edgeKey] || []).map(point => ({
        timestamp: point.timestamp,
        edge: roundToTwo(point.edge)
      })),
      modelDetails: finalModel.modelDetails,
      bookmakerTable: finalModel.bookmakerTable,
      propSections: props?.bookmakers ? props : { bookmakers: [] },
      scoreState: liveScoreState,
      liveTracker: {
        liveFound: !!liveState.liveFound,
        gameId: liveState.gameId || null
      },
      timestamp
    });
  } catch (error) {
    console.error("/odds failed:", error);
    res.status(500).json({
      error: error.message
    });
  }
});

app.get("/snapshots", (req, res) => {
  const gameId = req.query.gameId;

  if (!gameId) {
    return res.status(400).json({ error: "Missing gameId query parameter" });
  }

  res.json({
    gameId,
    snapshots: (snapshotLogStore[gameId] || []).map(s => ({
      ...s,
      impliedProbability: roundToTwo(s.impliedProbability),
      trueProbability: roundToTwo(s.trueProbability),
      calibratedTrueProbability: roundToTwo(s.calibratedTrueProbability),
      edge: roundToTwo(s.edge),
      rawEdge: roundToTwo(s.rawEdge),
      calibratedEdge: roundToTwo(s.calibratedEdge),
      confidencePercent: roundToTwo(s.confidencePercent),
      bestPrice: roundToTwo(s.bestPrice)
    }))
  });
});

app.get("/learning/summary", (req, res) => {
  try {
    res.json(safeLearningSummary());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/learning/calibration", (req, res) => {
  try {
    res.json({
      calibration: safeCalibrationTable()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/model/review", (req, res) => {
  try {
    const snapshots = safeGetSnapshots();
    const review = buildModelReview(snapshots);
    res.json(review);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/learning/grade", (req, res) => {
  try {
    const { gameId, finalWinner, finalHomeScore, finalAwayScore } = req.body || {};

    if (!gameId || !finalWinner) {
      return res.status(400).json({
        error: "Missing gameId or finalWinner"
      });
    }

    if (!["home", "away"].includes(finalWinner)) {
      return res.status(400).json({
        error: 'finalWinner must be "home" or "away"'
      });
    }

    const updated = safeUpdateGameResult({
      gameId,
      finalWinner,
      finalHomeScore,
      finalAwayScore
    });

    const calibration = safeBuildCalibrationTable();

    res.json({
      updatedSnapshots: updated,
      calibrationBuckets: Object.keys(calibration).length,
      learningSummary: safeLearningSummary()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`server02 running on port ${PORT}`);
});
