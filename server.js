const express = require("express");
const path = require("path");

const learning = require("./learning");
const { buildEliteLiveModel } = require("./live_model");
const { getLiveTrackerData } = require("./live_tracker");
const { buildElitePregameModel } = require("./pregame_model");
const { buildModelReview } = require("./model_review");

const app = express();
const PORT = process.env.PORT || 3000;

const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY || "";

const SPORT_KEY = "basketball_nba";
const REGIONS = "us";
const ODDS_FORMAT = "decimal";
const FEATURED_MARKETS = "h2h,spreads,totals";
const PLAYER_PROP_MARKETS = [
  "player_points",
  "player_rebounds",
  "player_assists",
  "player_points_rebounds_assists"
].join(",");

const HISTORICAL_LOOKBACKS = [
  { label: "2h", ms: 2 * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 }
];

const currentCache = new Map();
const historicalCache = new Map();
const edgeHistoryStore = {};
const snapshotLogStore = {};

const CURRENT_TTL_MS = 25 * 1000;
const HISTORICAL_TTL_MS = 30 * 60 * 1000;
const SNAPSHOT_RETENTION = 500;

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

function average(values) {
  const nums = (values || []).filter(v => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

function variance(values) {
  const nums = (values || []).filter(v => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return 0;
  const avg = average(nums);
  return average(nums.map(v => (v - avg) ** 2)) || 0;
}

function weightedAverage(pairs) {
  if (!pairs.length) return null;
  let num = 0;
  let den = 0;

  for (const pair of pairs) {
    num += pair.value * pair.weight;
    den += pair.weight;
  }

  return den === 0 ? null : num / den;
}

function noVigTwoWayProb(priceA, priceB) {
  if (
    typeof priceA !== "number" || !Number.isFinite(priceA) || priceA <= 1 ||
    typeof priceB !== "number" || !Number.isFinite(priceB) || priceB <= 1
  ) {
    return { a: 0.5, b: 0.5 };
  }

  const rawA = 1 / priceA;
  const rawB = 1 / priceB;
  const total = rawA + rawB;
  return {
    a: rawA / total,
    b: rawB / total
  };
}

function decimalToAmerican(decimalOdds) {
  if (typeof decimalOdds !== "number" || !Number.isFinite(decimalOdds) || decimalOdds <= 1) return null;
  if (decimalOdds >= 2) return Math.round((decimalOdds - 1) * 100);
  return Math.round(-100 / (decimalOdds - 1));
}

function probabilityToDecimal(probability) {
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability <= 0 || probability >= 1) {
    return null;
  }
  return 1 / probability;
}

function probabilityToAmerican(probability) {
  const decimal = probabilityToDecimal(probability);
  return decimalToAmerican(decimal);
}

function buildOddsFormatsFromDecimal(decimalOdds) {
  if (typeof decimalOdds !== "number" || !Number.isFinite(decimalOdds) || decimalOdds <= 1) {
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

function getBookWeight(bookKey) {
  const sharpBooks = ["pinnacle", "circasports", "matchbook"];
  const strongBooks = ["draftkings", "fanduel", "betmgm", "betrivers"];
  if (sharpBooks.includes(bookKey)) return 1.4;
  if (strongBooks.includes(bookKey)) return 1.15;
  return 1.0;
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function todayYmd() {
  return new Date().toISOString().slice(0, 10);
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

function requireBallDontLieKey() {
  return !!BALLDONTLIE_API_KEY;
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

function buildMode(commenceTime) {
  const startMs = new Date(commenceTime).getTime();
  return Date.now() >= startMs ? "live" : "pregame";
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

function safeStakeSuggestion(rawStake) {
  const text = String(rawStake || "No bet");
  const fractionMap = {
    "No bet": 0,
    "0.5u": 0.5,
    "1u": 1,
    "1.5u": 1.5
  };

  return {
    tier: text,
    fraction: Object.prototype.hasOwnProperty.call(fractionMap, text) ? fractionMap[text] : 0
  };
}

function findMarket(bookmaker, marketKey) {
  return bookmaker?.markets?.find(m => m.key === marketKey) || null;
}

function extractFeaturedConsensus(eventOdds) {
  const homeProbPairs = [];
  const awayProbPairs = [];
  const homeProbRaw = [];
  const awayProbRaw = [];
  const spreadSignals = [];
  const totalSignals = [];

  for (const bookmaker of eventOdds?.bookmakers || []) {
    const weight = getBookWeight(bookmaker.key || "");
    const h2h = findMarket(bookmaker, "h2h");
    const spreads = findMarket(bookmaker, "spreads");
    const totals = findMarket(bookmaker, "totals");

    if (h2h?.outcomes?.length >= 2) {
      const homeOutcome = h2h.outcomes.find(o => o.name === eventOdds.home_team);
      const awayOutcome = h2h.outcomes.find(o => o.name === eventOdds.away_team);

      if (homeOutcome && awayOutcome) {
        const nv = noVigTwoWayProb(homeOutcome.price, awayOutcome.price);
        homeProbPairs.push({ value: nv.a, weight });
        awayProbPairs.push({ value: nv.b, weight });
        homeProbRaw.push(nv.a);
        awayProbRaw.push(nv.b);
      }
    }

    if (spreads?.outcomes?.length >= 2) {
      const homeSpreadOutcome = spreads.outcomes.find(o => o.name === eventOdds.home_team);
      if (homeSpreadOutcome && typeof homeSpreadOutcome.point === "number") {
        spreadSignals.push({
          value: clamp((-homeSpreadOutcome.point) * 0.0105, -0.10, 0.10),
          weight
        });
      }
    }

    if (totals?.outcomes?.length >= 2) {
      const over = totals.outcomes.find(o => o.name === "Over");
      if (over && typeof over.point === "number") {
        totalSignals.push({ value: over.point, weight });
      }
    }
  }

  if (!homeProbPairs.length || !awayProbPairs.length) return null;

  const homeMarketProb = weightedAverage(homeProbPairs);
  const awayMarketProb = weightedAverage(awayProbPairs);
  const spreadAdj = spreadSignals.length ? weightedAverage(spreadSignals) : 0;
  const totalConsensus = totalSignals.length ? weightedAverage(totalSignals) : 0;

  let totalAdj = 0;
  if (typeof totalConsensus === "number" && Number.isFinite(totalConsensus)) {
    if (totalConsensus < 216) totalAdj = 0.006;
    else if (totalConsensus > 238) totalAdj = -0.006;
  }

  const disagreementPenalty = clamp(
    (variance(homeProbRaw) + variance(awayProbRaw)) * 12,
    0,
    0.05
  );

  return {
    homeMarketProb,
    awayMarketProb,
    spreadAdj,
    totalConsensus,
    totalAdj,
    disagreementPenalty
  };
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
    markets: PLAYER_PROP_MARKETS,
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

function buildStructuredPropSections(propsPayload) {
  const buckets = {
    points: [],
    rebounds: [],
    assists: [],
    pra: []
  };

  for (const bookmaker of propsPayload?.bookmakers || []) {
    for (const market of bookmaker.markets || []) {
      let key = null;
      if (market.key === "player_points") key = "points";
      if (market.key === "player_rebounds") key = "rebounds";
      if (market.key === "player_assists") key = "assists";
      if (market.key === "player_points_rebounds_assists") key = "pra";
      if (!key) continue;

      for (const outcome of market.outcomes || []) {
        buckets[key].push({
          book: bookmaker.title || bookmaker.key || "book",
          playerName: outcome.description || outcome.name || "Unknown",
          side: outcome.name || "",
          line: typeof outcome.point === "number" ? roundToTwo(outcome.point) : null,
          price: typeof outcome.price === "number" ? roundToTwo(outcome.price) : null
        });
      }
    }
  }

  for (const key of Object.keys(buckets)) {
    buckets[key] = buckets[key].slice(0, 20);
  }

  return buckets;
}

function buildPropSignal(propSections) {
  const allRows = [
    ...(propSections?.points || []),
    ...(propSections?.rebounds || []),
    ...(propSections?.assists || []),
    ...(propSections?.pra || [])
  ];

  let strength = 0;
  let observations = 0;

  for (const row of allRows) {
    const lineStrength = clamp((Number(row.line || 0)) * 0.0005, 0, 0.02);
    const priceStrength = clamp((Math.abs(Number(row.price || 0) - 2) || 0) * 0.01, 0, 0.015);
    strength += lineStrength + priceStrength;
    observations += 1;
  }

  return {
    adj: clamp((strength / Math.max(observations, 1)) * 0.4, 0, 0.01),
    depth: observations
  };
}

function buildNeutralInjuryStatus() {
  return {
    available: false,
    homeInjuriesCount: 0,
    awayInjuriesCount: 0,
    lineupRowsCount: 0,
    homePenalty: 0,
    awayPenalty: 0,
    homeStartersOut: 0,
    awayStartersOut: 0,
    homeStarterCertainty: 0,
    awayStarterCertainty: 0,
    sourceSelection: {
      injuries: "not_enabled",
      lineups: "not_enabled",
      depth: "not_enabled"
    },
    homeInjuries: [],
    awayInjuries: [],
    lineups: []
  };
}

async function getHistoricalSnapshot(dateIso) {
  const cacheKey = `hist:${dateIso}`;
  const hit = cacheGet(historicalCache, cacheKey);
  if (hit) return hit;

  const url = buildOddsUrl(`/v4/historical/sports/${SPORT_KEY}/odds`, {
    apiKey: ODDS_API_KEY,
    regions: REGIONS,
    markets: FEATURED_MARKETS,
    oddsFormat: ODDS_FORMAT,
    date: dateIso
  });

  const data = await fetchJson(url);
  cacheSet(historicalCache, cacheKey, data, HISTORICAL_TTL_MS);
  return data;
}

async function buildHistoricalComparisons(homeTeam, awayTeam) {
  const out = {};

  for (const lookback of HISTORICAL_LOOKBACKS) {
    const dateIso = toIso(Date.now() - lookback.ms);

    try {
      const snap = await getHistoricalSnapshot(dateIso);
      const found = (snap?.data || snap || []).find(event => teamsMatch(event, homeTeam, awayTeam));

      if (!found) {
        out[lookback.label] = null;
        continue;
      }

      const consensus = extractFeaturedConsensus(found);
      if (!consensus) {
        out[lookback.label] = null;
        continue;
      }

      out[lookback.label] = {
        homeMarketProb: roundToTwo(consensus.homeMarketProb),
        awayMarketProb: roundToTwo(consensus.awayMarketProb),
        spreadAdj: roundToTwo(consensus.spreadAdj),
        totalAdj: roundToTwo(consensus.totalAdj),
        totalConsensus: roundToTwo(consensus.totalConsensus),
        disagreementPenalty: roundToTwo(consensus.disagreementPenalty)
      };
    } catch {
      out[lookback.label] = null;
    }
  }

  return out;
}

function formatClockFromSeconds(clockSec) {
  if (typeof clockSec !== "number" || !Number.isFinite(clockSec)) return "-";
  const mins = Math.floor(clockSec / 60);
  const secs = Math.floor(clockSec % 60);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    oddsApiKeyAdded: requireOddsKey(),
    ballDontLieKeyAdded: requireBallDontLieKey(),
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

    const featured = await resolveFeaturedOdds({ gameId, homeTeam, awayTeam });
    const currentConsensus = extractFeaturedConsensus(featured);

    if (!currentConsensus) {
      return res.status(500).json({ error: "Could not extract featured odds consensus" });
    }

    const mode = buildMode(featured.commence_time);
    const historicalComparisons = await buildHistoricalComparisons(featured.home_team, featured.away_team);
    const props = await getEventPlayerPropsByResolvedEvent(featured.id);
    const propSections = buildStructuredPropSections(props);
    const propSignal = buildPropSignal(propSections);
    const injuryStatus = buildNeutralInjuryStatus();

    let finalModel;
    let liveScoreState = null;

    if (mode === "live") {
      let liveState = {
        gameId,
        homeTeam: featured.home_team,
        awayTeam: featured.away_team,
        period: 1,
        clock: "12:00",
        clockSec: 12 * 60,
        homeScore: 0,
        awayScore: 0,
        plays: [],
        recentPlays: [],
        liveFound: false,
        momentumAdj: 0,
        pacePressureAdj: 0
      };

      try {
        if (requireBallDontLieKey()) {
          liveState = await getLiveTrackerData({
            gameId,
            homeTeam: featured.home_team,
            awayTeam: featured.away_team
          });
        }
      } catch (err) {
        console.error("Live tracker failed, using neutral fallback:", err.message);
      }

      finalModel = buildEliteLiveModel({
        featuredOdds: featured,
        liveState,
        pregameBaseline: {
          homeMarketProb: currentConsensus.homeMarketProb
        },
        calibrationFn: safeApplyCalibration
      });

      liveScoreState = {
        ...finalModel.scoreState,
        formattedClock: formatClockFromSeconds(finalModel.scoreState?.clockSec)
      };
    } else {
      finalModel = buildElitePregameModel({
        featuredOdds: featured,
        historicalComparisons,
        propSignal,
        injurySummary: {
          available: false,
          lineups: [],
          lineupsRowsCount: 0,
          homePenalty: 0,
          awayPenalty: 0,
          homeLineupBoost: 0,
          awayLineupBoost: 0
        },
        calibrationFn: safeApplyCalibration
      });
    }

    const timestamp = new Date().toISOString();
    const pick = `${finalModel.pickTeam} to win`;
    const edgeKey = featured.id || gameId || `${featured.home_team}_${featured.away_team}`;
    const smoothedEdge = addEdgeHistory(edgeKey, finalModel.calibratedEdge, timestamp);

    const snapshot = {
      id: `${edgeKey}_${timestamp}`,
      gameId: edgeKey,
      timestamp,
      commenceTime: featured.commence_time,
      homeTeam: featured.home_team,
      awayTeam: featured.away_team,
      mode,
      pickSide: finalModel.pickSide,
      pickTeam: finalModel.pickTeam,
      pick,
      impliedProbability: finalModel.impliedProbability,
      trueProbability: finalModel.trueProbability,
      calibratedProbability: finalModel.calibratedTrueProbability,
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
      source: mode
    };

    logSnapshot(edgeKey, snapshot);
    safeRecordSnapshot({
      ...snapshot,
      result: null
    });

    const mergedModelDetails = {
      ...finalModel.modelDetails,
      historicalComparisons
    };

    res.json({
      id: featured.id,
      homeTeam: featured.home_team,
      awayTeam: featured.away_team,
      commenceTime: featured.commence_time,
      gameMode: mode,
      pick,
      verdict: finalModel.verdict,
      confidence: {
        label: finalModel.confidence.label,
        percent: roundToTwo(finalModel.confidence.percent)
      },
      noBetFilter: finalModel.noBetFilter || { blocked: false, reasons: [] },
      impliedProbability: roundToTwo(finalModel.impliedProbability),
      impliedPercentFromOdds: roundToTwo(finalModel.impliedProbability),
      trueProbability: roundToTwo(finalModel.calibratedTrueProbability),
      calibratedTrueProbability: roundToTwo(finalModel.calibratedTrueProbability),
      impliedProbabilityFormats: buildProbabilityFormats(finalModel.impliedProbability),
      trueProbabilityFormats: buildProbabilityFormats(finalModel.calibratedTrueProbability),
      edge: roundToTwo(smoothedEdge),
      rawEdge: roundToTwo(finalModel.rawEdge),
      calibratedEdge: roundToTwo(finalModel.calibratedEdge),
      oddsFormats: buildOddsFormatsFromDecimal(finalModel.sportsbookDecimal),
      sportsbookOddsDecimal: roundToTwo(finalModel.sportsbookDecimal),
      stakeSuggestion: safeStakeSuggestion(finalModel.stakeSuggestion),
      learningSummary: safeLearningSummary(),
      history: (edgeHistoryStore[edgeKey] || []).map(point => ({
        timestamp: point.timestamp,
        edge: roundToTwo(point.edge)
      })),
      modelDetails: mergedModelDetails,
      bookmakerTable: finalModel.bookmakerTable,
      propSections,
      injuryStatus,
      scoreState: liveScoreState,
      timestamp
    });
  } catch (error) {
    console.error("/odds failed:", error);
    res.status(500).json({ error: error.message });
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
      sportsbookDecimal: roundToTwo(s.sportsbookDecimal)
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
    res.json({ calibration: safeCalibrationTable() });
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
      return res.status(400).json({ error: "Missing gameId or finalWinner" });
    }

    const updated = safeUpdateGameResult({
      gameId,
      finalWinner,
      finalHomeScore,
      finalAwayScore
    });

    const calibration = safeBuildCalibrationTable();

    res.json({
      ok: true,
      updated,
      calibration
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
