const express = require("express");
const path = require("path");

const learning = require("./learning");
const { buildEliteLiveModel }    = require("./live_model");
const { getLiveTrackerData }     = require("./live_tracker");
const { buildElitePregameModel } = require("./pregame_model");
const { buildModelReview }       = require("./model_review");
const {
  computeIndependentWinProb,
  computeEdge
} = require("./stats_model");

const app  = express();
const PORT = process.env.PORT || 3000;

const ODDS_API_KEY        = process.env.ODDS_API_KEY        || "";
const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY || "";
const FANTASYNERDS_API_KEY = process.env.FANTASYNERDS_API_KEY || "";

const SPORT_KEY        = "basketball_nba";
const REGIONS          = "us";
const ODDS_FORMAT      = "decimal";
const FEATURED_MARKETS = "h2h,spreads,totals";
const PLAYER_PROP_MARKETS = [
  "player_points",
  "player_rebounds",
  "player_assists",
  "player_points_rebounds_assists"
].join(",");

const HISTORICAL_LOOKBACKS = [
  { label: "2h",  ms: 2  * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 }
];

const currentCache    = new Map();
const historicalCache = new Map();
const sideInfoCache   = new Map();
const edgeHistoryStore  = {};
const snapshotLogStore  = {};

const CURRENT_TTL_MS    = 25 * 1000;
const HISTORICAL_TTL_MS = 30 * 60 * 1000;
const SIDEINFO_TTL_MS   = 10 * 60 * 1000;
const SNAPSHOT_RETENTION = 500;

// ─── blend weights: how much to trust stats model vs market ──────────────────
// 0 = pure market, 1 = pure stats model
// At 0.45 the independent model has meaningful influence while the
// market's information still anchors the estimate.
const STATS_MODEL_BLEND = 0.45;

const TEAM_ALIASES = {
  "Atlanta Hawks": ["hawks","atl","atlanta"],
  "Boston Celtics": ["celtics","bos","boston"],
  "Brooklyn Nets": ["nets","bkn","brooklyn"],
  "Charlotte Hornets": ["hornets","cha","charlotte"],
  "Chicago Bulls": ["bulls","chi","chicago"],
  "Cleveland Cavaliers": ["cavaliers","cavs","cle","cleveland"],
  "Dallas Mavericks": ["mavericks","mavs","dal","dallas"],
  "Denver Nuggets": ["nuggets","den","denver"],
  "Detroit Pistons": ["pistons","det","detroit"],
  "Golden State Warriors": ["warriors","gsw","golden state"],
  "Houston Rockets": ["rockets","hou","houston"],
  "Indiana Pacers": ["pacers","ind","indiana"],
  "Los Angeles Clippers": ["clippers","lac","la clippers"],
  "Los Angeles Lakers": ["lakers","lal","la lakers"],
  "Memphis Grizzlies": ["grizzlies","mem","memphis"],
  "Miami Heat": ["heat","mia","miami"],
  "Milwaukee Bucks": ["bucks","mil","milwaukee"],
  "Minnesota Timberwolves": ["timberwolves","wolves","min","minnesota"],
  "New Orleans Pelicans": ["pelicans","nop","no","new orleans"],
  "New York Knicks": ["knicks","nyk","new york"],
  "Oklahoma City Thunder": ["thunder","okc","oklahoma city"],
  "Orlando Magic": ["magic","orl","orlando"],
  "Philadelphia 76ers": ["76ers","sixers","phi","philadelphia"],
  "Phoenix Suns": ["suns","phx","phoenix"],
  "Portland Trail Blazers": ["trail blazers","blazers","por","portland"],
  "Sacramento Kings": ["kings","sac","sacramento"],
  "San Antonio Spurs": ["spurs","sas","san antonio"],
  "Toronto Raptors": ["raptors","tor","toronto"],
  "Utah Jazz": ["jazz","uta","utah"],
  "Washington Wizards": ["wizards","was","washington"]
};

app.use(express.json());

process.on("unhandledRejection", reason => { console.error("UNHANDLED REJECTION:", reason); });
process.on("uncaughtException",  err    => { console.error("UNCAUGHT EXCEPTION:",  err);    });

// ─── math helpers ─────────────────────────────────────────────────────────────
function clamp(x, min, max) { return Math.max(min, Math.min(max, x)); }
function roundToTwo(num) {
  if (typeof num !== "number" || !Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}
function average(values) {
  const nums = (values || []).filter(v => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((s, v) => s + v, 0) / nums.length;
}
function variance(values) {
  const nums = (values || []).filter(v => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return 0;
  const a = average(nums);
  return average(nums.map(v => (v - a) ** 2)) || 0;
}
function weightedAverage(pairs) {
  if (!pairs.length) return null;
  let num = 0, den = 0;
  for (const p of pairs) { num += p.value * p.weight; den += p.weight; }
  return den === 0 ? null : num / den;
}
function noVigTwoWayProb(priceA, priceB) {
  if (typeof priceA !== "number" || !Number.isFinite(priceA) || priceA <= 1 ||
      typeof priceB !== "number" || !Number.isFinite(priceB) || priceB <= 1) {
    return { a: 0.5, b: 0.5 };
  }
  const rawA = 1 / priceA, rawB = 1 / priceB, total = rawA + rawB;
  return { a: rawA / total, b: rawB / total };
}
function decimalToAmerican(d) {
  if (typeof d !== "number" || !Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}
function decimalToImpliedPercent(d) {
  if (typeof d !== "number" || !Number.isFinite(d) || d <= 1) return null;
  return 1 / d;
}
function probabilityToDecimal(p) {
  if (typeof p !== "number" || !Number.isFinite(p) || p <= 0 || p >= 1) return null;
  return 1 / p;
}
function probabilityToAmerican(p) { return decimalToAmerican(probabilityToDecimal(p)); }
function buildOddsFormatsFromDecimal(d) {
  if (typeof d !== "number" || !Number.isFinite(d) || d <= 1) return { decimal: null, american: null, impliedPercent: null };
  return { decimal: roundToTwo(d), american: decimalToAmerican(d), impliedPercent: roundToTwo(1 / d) };
}
function buildProbabilityFormats(p) { return { percent: roundToTwo(p), american: probabilityToAmerican(p) }; }
function getBookWeight(bookKey) {
  if (["pinnacle","circasports","matchbook"].includes(bookKey)) return 1.4;
  if (["draftkings","fanduel","betmgm","betrivers"].includes(bookKey)) return 1.15;
  return 1.0;
}

// ─── cache helpers ─────────────────────────────────────────────────────────────
function cacheGet(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) { map.delete(key); return null; }
  return hit.value;
}
function cacheSet(map, key, value, ttl) { map.set(key, { value, expiresAt: Date.now() + ttl }); }

// ─── fetch ────────────────────────────────────────────────────────────────────
async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text     = await response.text();
    if (!response.ok) throw new Error(`Request failed ${response.status}: ${text}`);
    try { return JSON.parse(text); }
    catch { throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 300)}`); }
  } catch (err) { throw new Error(`fetchJson failed for ${url}: ${err.message}`); }
  finally { clearTimeout(timeout); }
}
function buildOddsUrl(pathname, params) {
  const sp = new URLSearchParams(params);
  return `https://api.the-odds-api.com${pathname}?${sp.toString()}`;
}
function requireOddsKey()         { return !!ODDS_API_KEY; }
function requireBallDontLieKey()  { return !!BALLDONTLIE_API_KEY; }
function requireFantasyNerdsKey() { return !!FANTASYNERDS_API_KEY; }
function toIso(ms)     { return new Date(ms).toISOString(); }
function todayYmd()    { return new Date().toISOString().slice(0, 10); }
function buildMode(t)  { return Date.now() >= new Date(t).getTime() ? "live" : "pregame"; }
function formatClockFromSeconds(s) {
  if (typeof s !== "number" || !Number.isFinite(s)) return "-";
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

// ─── team name helpers ────────────────────────────────────────────────────────
function normalizeTeamName(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}
function teamsMatch(event, homeTeam, awayTeam) {
  return normalizeTeamName(event?.home_team) === normalizeTeamName(homeTeam) &&
         normalizeTeamName(event?.away_team) === normalizeTeamName(awayTeam);
}
function getTeamTokens(name) {
  const aliases = TEAM_ALIASES[name] || [];
  const tokens  = new Set([name.toLowerCase(), ...aliases.map(x => x.toLowerCase())]);
  name.toLowerCase().split(" ").filter(Boolean).forEach(w => tokens.add(w));
  return [...tokens].filter(Boolean);
}
function teamNameLooseMatch(src, name) {
  if (!src || !name) return false;
  const hay = src.toLowerCase();
  return getTeamTokens(name).some(t => hay.includes(t));
}
function rowContainsTeam(row, name) { return teamNameLooseMatch(JSON.stringify(row), name); }

// ─── edge / snapshot helpers ──────────────────────────────────────────────────
function trimEdgeHistory(gameId) {
  const cutoff = Date.now() - 15 * 60 * 1000;
  edgeHistoryStore[gameId] = (edgeHistoryStore[gameId] || []).filter(
    p => new Date(p.timestamp).getTime() >= cutoff
  );
}
function addEdgeHistory(gameId, edge, timestamp) {
  if (!edgeHistoryStore[gameId]) edgeHistoryStore[gameId] = [];
  let smoothed = edge;
  if (edgeHistoryStore[gameId].length > 0) {
    const prev = edgeHistoryStore[gameId].at(-1).edge;
    smoothed   = prev * 0.55 + edge * 0.45;
  }
  edgeHistoryStore[gameId].push({ timestamp, edge: smoothed });
  trimEdgeHistory(gameId);
  return smoothed;
}
function logSnapshot(gameId, snap) {
  if (!snapshotLogStore[gameId]) snapshotLogStore[gameId] = [];
  snapshotLogStore[gameId].push(snap);
  if (snapshotLogStore[gameId].length > SNAPSHOT_RETENTION)
    snapshotLogStore[gameId] = snapshotLogStore[gameId].slice(-SNAPSHOT_RETENTION);
}

// ─── learning wrappers ────────────────────────────────────────────────────────
const safeLearningSummary    = () => typeof learning.getLearningSummary === "function"    ? learning.getLearningSummary()    : {};
const safeCalibrationTable   = () => typeof learning.getCalibrationTable === "function"   ? learning.getCalibrationTable()   : {};
const safeBuildCalibration   = () => typeof learning.buildCalibrationTable === "function" ? learning.buildCalibrationTable() : {};
const safeRecordSnapshot     = s  => { if (typeof learning.recordSnapshot === "function") learning.recordSnapshot(s); };
const safeGetSnapshots       = () => typeof learning.getSnapshots === "function"          ? learning.getSnapshots()          : [];
const safeUpdateGameResult   = p  => typeof learning.updateGameResult === "function"      ? learning.updateGameResult(p)     : 0;
const safeApplyCalibration   = p  => typeof learning.applyCalibration === "function"      ? learning.applyCalibration(p)     : p;
function safeStakeSuggestion(raw) {
  const text = String(raw || "No bet");
  const map  = { "No bet": 0, "0.5u": 0.5, "1u": 1, "1.5u": 1.5 };
  return { tier: text, fraction: Object.prototype.hasOwnProperty.call(map, text) ? map[text] : 0 };
}

// ─── independent model blending ───────────────────────────────────────────────
/**
 * Blend the market-based model probability with the independent stats model.
 *
 * marketProb  – no-vig market implied prob for the pick side
 * statsProb   – our independent model prob for the HOME team
 * pickSide    – "home" | "away"
 *
 * Returns blended probability for the pick side.
 */
function blendModelWithStats(marketProb, statsHomeProb, pickSide) {
  const statsPickProb = pickSide === "home" ? statsHomeProb : 1 - statsHomeProb;
  const blended = marketProb * (1 - STATS_MODEL_BLEND) + statsPickProb * STATS_MODEL_BLEND;
  return clamp(blended, 0.01, 0.99);
}

// ─── Odds API helpers ─────────────────────────────────────────────────────────
async function getUpcomingEvents() {
  const key = "events";
  const hit = cacheGet(currentCache, key);
  if (hit) return hit;
  const url  = buildOddsUrl(`/v4/sports/${SPORT_KEY}/events`, { apiKey: ODDS_API_KEY });
  const data = await fetchJson(url);
  cacheSet(currentCache, key, data, CURRENT_TTL_MS);
  return data;
}
async function getCurrentFeaturedBoard() {
  const key = "featured-board";
  const hit = cacheGet(currentCache, key);
  if (hit) return hit;
  const url  = buildOddsUrl(`/v4/sports/${SPORT_KEY}/odds`, { apiKey: ODDS_API_KEY, regions: REGIONS, markets: FEATURED_MARKETS, oddsFormat: ODDS_FORMAT });
  const data = await fetchJson(url);
  cacheSet(currentCache, key, data, CURRENT_TTL_MS);
  return data;
}
async function resolveFeaturedOdds({ gameId, homeTeam, awayTeam }) {
  if (gameId) {
    try {
      const key = `featured:${gameId}`;
      const hit = cacheGet(currentCache, key);
      if (hit && hit.home_team) return hit;
      const url  = buildOddsUrl(`/v4/sports/${SPORT_KEY}/events/${gameId}/odds`, { apiKey: ODDS_API_KEY, regions: REGIONS, markets: FEATURED_MARKETS, oddsFormat: ODDS_FORMAT });
      const data = await fetchJson(url);
      cacheSet(currentCache, key, data, CURRENT_TTL_MS);
      if (data?.home_team) return data;
    } catch (err) {
      const m = String(err.message || "");
      if (!m.includes("INVALID_EVENT_ID") && !m.includes("422")) throw err;
    }
  }
  if (!homeTeam || !awayTeam) throw new Error("Could not resolve odds event. Missing homeTeam/awayTeam fallback.");
  const board   = await getCurrentFeaturedBoard();
  const matched = (board || []).find(e => teamsMatch(e, homeTeam, awayTeam));
  if (!matched) throw new Error(`Could not find Odds API event for ${awayTeam} @ ${homeTeam}`);
  return matched;
}
async function getHistoricalSnapshot(dateIso) {
  const key = `hist:${dateIso}`;
  const hit = cacheGet(historicalCache, key);
  if (hit) return hit;
  const url  = buildOddsUrl(`/v4/historical/sports/${SPORT_KEY}/odds`, { apiKey: ODDS_API_KEY, regions: REGIONS, markets: FEATURED_MARKETS, oddsFormat: ODDS_FORMAT, date: dateIso });
  const data = await fetchJson(url);
  cacheSet(historicalCache, key, data, HISTORICAL_TTL_MS);
  return data;
}
async function getEventPlayerPropsByResolvedEvent(eventId) {
  if (!eventId) return { bookmakers: [] };
  const key = `props:${eventId}`;
  const hit = cacheGet(currentCache, key);
  if (hit) return hit;
  const url = buildOddsUrl(`/v4/sports/${SPORT_KEY}/events/${eventId}/odds`, { apiKey: ODDS_API_KEY, regions: REGIONS, markets: PLAYER_PROP_MARKETS, oddsFormat: ODDS_FORMAT });
  try {
    const data = await fetchJson(url);
    cacheSet(currentCache, key, data, CURRENT_TTL_MS);
    return data;
  } catch (err) {
    console.error("getEventPlayerPropsByResolvedEvent failed:", err.message);
    return { bookmakers: [] };
  }
}

// ─── consensus extraction ─────────────────────────────────────────────────────
function findMarket(bookmaker, key) { return bookmaker?.markets?.find(m => m.key === key) || null; }
function extractFeaturedConsensus(eventOdds) {
  const homeProbPairs = [], awayProbPairs = [], homeProbRaw = [], awayProbRaw = [];
  const spreadSignals = [], totalSignals  = [], books = [];

  for (const bm of eventOdds?.bookmakers || []) {
    const weight = getBookWeight(bm.key || "");
    const h2h    = findMarket(bm, "h2h");
    const spreads = findMarket(bm, "spreads");
    const totals  = findMarket(bm, "totals");
    let bHP = null, bAP = null, bHS = null, bAS = null, bT = null;

    if (h2h?.outcomes?.length >= 2) {
      const ho = h2h.outcomes.find(o => o.name === eventOdds.home_team);
      const ao = h2h.outcomes.find(o => o.name === eventOdds.away_team);
      if (ho && ao) {
        bHP = ho.price; bAP = ao.price;
        const nv = noVigTwoWayProb(ho.price, ao.price);
        homeProbPairs.push({ value: nv.a, weight }); awayProbPairs.push({ value: nv.b, weight });
        homeProbRaw.push(nv.a); awayProbRaw.push(nv.b);
      }
    }
    if (spreads?.outcomes?.length >= 2) {
      const hs = spreads.outcomes.find(o => o.name === eventOdds.home_team);
      const as_ = spreads.outcomes.find(o => o.name === eventOdds.away_team);
      if (hs && typeof hs.point === "number") { bHS = hs.point; spreadSignals.push({ value: clamp((-hs.point) * 0.0105, -0.10, 0.10), weight }); }
      if (as_ && typeof as_.point === "number") bAS = as_.point;
    }
    if (totals?.outcomes?.length >= 2) {
      const ov = totals.outcomes.find(o => o.name === "Over");
      if (ov && typeof ov.point === "number") { bT = ov.point; totalSignals.push({ value: ov.point, weight }); }
    }
    books.push({ book: bm.title || bm.key || "book", homePrice: roundToTwo(bHP), awayPrice: roundToTwo(bAP), homeSpread: roundToTwo(bHS), awaySpread: roundToTwo(bAS), total: roundToTwo(bT), homeAmerican: decimalToAmerican(bHP), awayAmerican: decimalToAmerican(bAP) });
  }
  if (!homeProbPairs.length) return null;

  const homeMarketProb  = weightedAverage(homeProbPairs);
  const awayMarketProb  = weightedAverage(awayProbPairs);
  const spreadAdj       = weightedAverage(spreadSignals) || 0;
  const totalConsensus  = weightedAverage(totalSignals)  || 0;
  let totalAdj = 0;
  if (totalConsensus < 220) totalAdj = 0.005;
  else if (totalConsensus > 236) totalAdj = -0.005;
  const disagreementPenalty = clamp((variance(homeProbRaw) + variance(awayProbRaw)) * 10, 0, 0.035);
  const homePrices  = books.map(b => b.homePrice).filter(v => typeof v === "number");
  const awayPrices  = books.map(b => b.awayPrice).filter(v => typeof v === "number");
  const homeSpreads = books.map(b => b.homeSpread).filter(v => typeof v === "number");
  const totals      = books.map(b => b.total).filter(v => typeof v === "number");

  return {
    homeMarketProb, awayMarketProb, spreadAdj, totalConsensus, totalAdj, disagreementPenalty,
    bestHomePrice: homePrices.length ? Math.max(...homePrices) : null,
    bestAwayPrice: awayPrices.length ? Math.max(...awayPrices) : null,
    avgHomePrice: average(homePrices), avgAwayPrice: average(awayPrices),
    avgHomeSpread: average(homeSpreads), avgTotal: average(totals),
    bookCount: books.filter(b => typeof b.homePrice === "number" && typeof b.awayPrice === "number").length,
    books
  };
}

async function buildHistoricalComparisons(homeTeam, awayTeam) {
  const out = {};
  for (const lb of HISTORICAL_LOOKBACKS) {
    const dateIso = toIso(Date.now() - lb.ms);
    try {
      const snap  = await getHistoricalSnapshot(dateIso);
      const found = (snap?.data || snap || []).find(e => teamsMatch(e, homeTeam, awayTeam));
      if (!found) { out[lb.label] = null; continue; }
      const c = extractFeaturedConsensus(found);
      if (!c) { out[lb.label] = null; continue; }
      out[lb.label] = { homeMarketProb: roundToTwo(c.homeMarketProb), awayMarketProb: roundToTwo(c.awayMarketProb), spreadAdj: roundToTwo(c.spreadAdj), totalAdj: roundToTwo(c.totalAdj), totalConsensus: roundToTwo(c.totalConsensus), disagreementPenalty: roundToTwo(c.disagreementPenalty) };
    } catch { out[lb.label] = null; }
  }
  return out;
}

// ─── props ────────────────────────────────────────────────────────────────────
function groupPlayerPropMarkets(propsEventOdds) {
  const g = {};
  for (const bm of propsEventOdds?.bookmakers || []) {
    for (const mkt of bm.markets || []) {
      if (!g[mkt.key]) g[mkt.key] = [];
      for (const o of mkt.outcomes || []) g[mkt.key].push({ book: bm.key, player: o.description || "", side: o.name || "", point: o.point ?? null, price: o.price ?? null });
    }
  }
  return g;
}
function decidePropSide(row) {
  if (typeof row.hitProbability !== "number" || !Number.isFinite(row.hitProbability)) return null;
  return row.hitProbability > 0.5 ? { pick: "over", probability: row.hitProbability } : { pick: "under", probability: 1 - row.hitProbability };
}
function buildStructuredPropSections(propsEventOdds) {
  const gm = groupPlayerPropMarkets(propsEventOdds);
  const marketMap = { player_points: "points", player_assists: "assists", player_rebounds: "rebounds", player_points_rebounds_assists: "pra" };
  const sections  = { points: [], assists: [], rebounds: [], pra: [] };
  for (const [mk, dk] of Object.entries(marketMap)) {
    const outcomes = gm[mk] || {};
    const grouped  = {};
    for (const o of gm[mk] || []) {
      const key = `${o.player}__${o.point}`;
      if (!grouped[key]) grouped[key] = { player: o.player, point: o.point, overPrices: [], underPrices: [] };
      if ((o.side || "").toLowerCase() === "over"  && typeof o.price === "number") grouped[key].overPrices.push(o.price);
      if ((o.side || "").toLowerCase() === "under" && typeof o.price === "number") grouped[key].underPrices.push(o.price);
    }
    sections[dk] = Object.values(grouped)
      .map(item => {
        const avgOver  = average(item.overPrices), avgUnder = average(item.underPrices);
        let hitProb = null;
        if (typeof avgOver === "number" && typeof avgUnder === "number") hitProb = noVigTwoWayProb(avgOver, avgUnder).a;
        else if (typeof avgOver === "number") hitProb = decimalToImpliedPercent(avgOver);
        const dec = decidePropSide({ hitProbability: hitProb });
        return { player: item.player, line: roundToTwo(item.point), overDecimal: roundToTwo(avgOver), overAmerican: decimalToAmerican(avgOver), hitProbability: roundToTwo(hitProb), coverage: item.overPrices.length + item.underPrices.length, pick: dec?.pick || null, pickProbability: roundToTwo(dec?.probability) };
      })
      .filter(r => r.player && typeof r.line === "number")
      .sort((a, b) => (b.coverage - a.coverage) || ((b.pickProbability || 0) - (a.pickProbability || 0)))
      .slice(0, 12);
  }
  return sections;
}
function buildPropSignal(ps) {
  const all = [...(ps.points||[]),...(ps.assists||[]),...(ps.rebounds||[]),...(ps.pra||[])];
  if (!all.length) return { adj: 0, depth: 0 };
  let strength = 0, obs = 0;
  for (const r of all) {
    strength += clamp((r.coverage-1)*0.0015,0,0.01) + clamp((r.line||0)*0.0005,0,0.02) + clamp(((r.hitProbability||0.5)-0.5)*0.05,-0.015,0.015);
    obs++;
  }
  return { adj: clamp((strength/Math.max(obs,1))*0.4,0,0.01), depth: obs };
}

// ─── injury / lineup helpers ──────────────────────────────────────────────────
function buildNeutralInjuryStatus() {
  return { available: false, homeInjuriesCount: 0, awayInjuriesCount: 0, lineupRowsCount: 0, homePenalty: 0, awayPenalty: 0, homeStartersOut: 0, awayStartersOut: 0, homeStarterCertainty: 0, awayStarterCertainty: 0, sourceSelection: { injuries: "not_enabled", lineups: "not_enabled", depth: "not_enabled" }, homeInjuries: [], awayInjuries: [], lineups: [] };
}
function normalizeRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.Data)) return payload.Data;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.players)) return payload.players;
  if (Array.isArray(payload?.lineups)) return payload.lineups;
  if (Array.isArray(payload?.depthcharts)) return payload.depthcharts;
  return [];
}
function buildBallDontLieHeaders() { return { Authorization: BALLDONTLIE_API_KEY }; }
function normalizeBdlRows(p) { return Array.isArray(p) ? p : Array.isArray(p?.data) ? p.data : []; }

async function getBallDontLieInjuries() {
  if (!requireBallDontLieKey()) return { available: false, rows: [], source: "none" };
  const key = "bdl:injuries";
  const hit = cacheGet(sideInfoCache, key);
  if (hit) return hit;
  try {
    const raw = await fetchJson("https://api.balldontlie.io/v1/player_injuries?per_page=100", { headers: buildBallDontLieHeaders() });
    const val = { available: true, rows: normalizeBdlRows(raw), source: "balldontlie" };
    cacheSet(sideInfoCache, key, val, SIDEINFO_TTL_MS);
    return val;
  } catch (err) { console.error("getBallDontLieInjuries failed:", err.message); return { available: false, rows: [], source: "none" }; }
}
async function getBallDontLieLineups(dateStr = "") {
  if (!requireBallDontLieKey()) return { available: false, rows: [], source: "none" };
  const d = dateStr || todayYmd();
  const key = `bdl:lineups:${d}`;
  const hit = cacheGet(sideInfoCache, key);
  if (hit) return hit;
  try {
    const raw = await fetchJson(`https://api.balldontlie.io/v1/lineups?dates[]=${encodeURIComponent(d)}&per_page=100`, { headers: buildBallDontLieHeaders() });
    const val = { available: true, rows: normalizeBdlRows(raw), source: "balldontlie" };
    cacheSet(sideInfoCache, key, val, SIDEINFO_TTL_MS);
    return val;
  } catch (err) { console.error("getBallDontLieLineups failed:", err.message); return { available: false, rows: [], source: "none" }; }
}
async function getFantasyNerdsInjuries() {
  if (!requireFantasyNerdsKey()) return { available: false, rows: [], source: "none" };
  const key = "fn:injuries";
  const hit = cacheGet(sideInfoCache, key);
  if (hit) return hit;
  try {
    const raw = await fetchJson(`https://api.fantasynerds.com/v1/nba/injuries?apikey=${encodeURIComponent(FANTASYNERDS_API_KEY)}`);
    const val = { available: true, rows: normalizeRows(raw), source: "fantasynerds" };
    cacheSet(sideInfoCache, key, val, SIDEINFO_TTL_MS);
    return val;
  } catch (err) { console.error("getFantasyNerdsInjuries failed:", err.message); return { available: false, rows: [], source: "none" }; }
}
async function getFantasyNerdsLineups(dateStr = "") {
  if (!requireFantasyNerdsKey()) return { available: false, rows: [], source: "none" };
  const key = `fn:lineups:${dateStr || "today"}`;
  const hit = cacheGet(sideInfoCache, key);
  if (hit) return hit;
  try {
    const raw = await fetchJson(`https://api.fantasynerds.com/v1/nba/lineups?apikey=${encodeURIComponent(FANTASYNERDS_API_KEY)}&date=${encodeURIComponent(dateStr)}`);
    const val = { available: true, rows: normalizeRows(raw), source: "fantasynerds" };
    cacheSet(sideInfoCache, key, val, SIDEINFO_TTL_MS);
    return val;
  } catch (err) { console.error("getFantasyNerdsLineups failed:", err.message); return { available: false, rows: [], source: "none" }; }
}
async function getFantasyNerdsDepthCharts() {
  if (!requireFantasyNerdsKey()) return { available: false, rows: [], source: "none" };
  const key = "fn:depthcharts";
  const hit = cacheGet(sideInfoCache, key);
  if (hit) return hit;
  try {
    const raw = await fetchJson(`https://api.fantasynerds.com/v1/nba/depth?apikey=${encodeURIComponent(FANTASYNERDS_API_KEY)}`);
    const val = { available: true, rows: normalizeRows(raw), source: "fantasynerds" };
    cacheSet(sideInfoCache, key, val, SIDEINFO_TTL_MS);
    return val;
  } catch (err) { console.error("getFantasyNerdsDepthCharts failed:", err.message); return { available: false, rows: [], source: "none" }; }
}
async function getBestInjuries() {
  const bdl = await getBallDontLieInjuries().catch(() => ({ available: false, rows: [] }));
  if (bdl.available && bdl.rows.length) return bdl;
  return await getFantasyNerdsInjuries().catch(() => ({ available: false, rows: [], source: "none" }));
}
async function getBestLineups(dateStr = "") {
  const bdl = await getBallDontLieLineups(dateStr).catch(() => ({ available: false, rows: [] }));
  if (bdl.available && bdl.rows.length) return bdl;
  return await getFantasyNerdsLineups(dateStr).catch(() => ({ available: false, rows: [], source: "none" }));
}
async function getBestDepthCharts() {
  return await getFantasyNerdsDepthCharts().catch(() => ({ available: false, rows: [], source: "none" }));
}

function extractPlayerName(obj) {
  if (!obj) return "";
  for (const k of ["PlayerName","playerName","name","Name","player","full_name","playername"]) if (typeof obj[k] === "string") return obj[k];
  if (obj.player && typeof obj.player === "object") {
    const full = `${obj.player.first_name||""} ${obj.player.last_name||""}`.trim();
    if (full) return full;
  }
  if (typeof obj.first_name === "string" || typeof obj.last_name === "string")
    return `${obj.first_name||""} ${obj.last_name||""}`.trim();
  return "";
}
function lineupCertaintyValue(row) {
  const t = JSON.stringify(row).toLowerCase();
  if (t.includes("confirmed")) return 1.0;
  if (t.includes("starting") || t.includes("starter")) return 0.85;
  if (t.includes("projected")) return 0.55;
  return 0.25;
}
function injurySeverityValue(row) {
  const t = JSON.stringify(row).toLowerCase();
  if (t.includes("out"))          return 1.0;
  if (t.includes("doubtful"))     return 0.8;
  if (t.includes("questionable")) return 0.5;
  if (t.includes("probable"))     return 0.2;
  return 0.4;
}
function depthRoleValue(row) {
  const t = JSON.stringify(row).toLowerCase();
  if (t.includes("starter") || t.includes("1st")) return 1.0;
  if (t.includes("2nd")) return 0.55;
  if (t.includes("3rd")) return 0.25;
  return 0.45;
}
function buildPlayerValueMap(ps) {
  const map = {}, weights = { points: 1.0, assists: 0.9, rebounds: 0.8, pra: 1.2 };
  for (const [sn, rows] of Object.entries(ps)) {
    for (const r of rows || []) {
      const player = (r.player || "").toLowerCase().trim();
      if (!player) continue;
      const score = (clamp((r.line||0)*0.01,0,0.6) + clamp((r.pickProbability||r.hitProbability||0.5)-0.5,0,0.25) + clamp((r.coverage||0)*0.015,0,0.15)) * (weights[sn]||1);
      map[player] = (map[player] || 0) + score;
    }
  }
  return map;
}
function findBestPlayerValue(name, map) {
  if (!name) return 0;
  const key = name.toLowerCase().trim();
  if (map[key]) return map[key];
  const parts = key.split(" ").filter(Boolean);
  let best = 0;
  for (const [c, v] of Object.entries(map)) if (parts.filter(p => c.includes(p)).length >= Math.min(2, parts.length)) best = Math.max(best, v);
  return best;
}
function summarizeInjuryLineup(homeTeam, awayTeam, injRows, linRows, depRows, ps) {
  const homeInj = injRows.filter(r => rowContainsTeam(r, homeTeam));
  const awayInj = injRows.filter(r => rowContainsTeam(r, awayTeam));
  const homeLin = linRows.filter(r => rowContainsTeam(r, homeTeam));
  const awayLin = linRows.filter(r => rowContainsTeam(r, awayTeam));
  const homeDep = depRows.filter(r => rowContainsTeam(r, homeTeam));
  const awayDep = depRows.filter(r => rowContainsTeam(r, awayTeam));
  const pvm     = buildPlayerValueMap(ps);
  function computePenalty(inj, lin, dep) {
    let penalty = 0, startersOut = 0, projStarters = 0;
    for (const i of inj) {
      const pn = extractPlayerName(i), sev = injurySeverityValue(i);
      const lm = lin.find(r => JSON.stringify(r).toLowerCase().includes(pn.toLowerCase()));
      const dm = dep.find(r => JSON.stringify(r).toLowerCase().includes(pn.toLowerCase()));
      const lw = lm ? lineupCertaintyValue(lm) : 0;
      const rw = dm ? depthRoleValue(dm) : (lm ? 0.9 : 0.4);
      const pv = findBestPlayerValue(pn, pvm);
      penalty += 0.006 + sev*0.010 + rw*0.010 + lw*0.010 + pv*0.008;
      if (rw >= 0.8 || lw >= 0.8) startersOut++;
    }
    for (const l of lin) if (lineupCertaintyValue(l) >= 0.8) projStarters++;
    return { penalty: clamp(penalty, 0, 0.10), startersOut, starterCertainty: lin.length ? clamp(projStarters/5,0,1) : 0 };
  }
  const hc = computePenalty(homeInj, homeLin, homeDep);
  const ac = computePenalty(awayInj, awayLin, awayDep);
  return {
    available: injRows.length > 0 || linRows.length > 0 || depRows.length > 0,
    homeInjuriesCount: homeInj.length, awayInjuriesCount: awayInj.length,
    homePenalty: hc.penalty, awayPenalty: ac.penalty,
    homeStartersOut: hc.startersOut, awayStartersOut: ac.startersOut,
    homeStarterCertainty: hc.starterCertainty, awayStarterCertainty: ac.starterCertainty,
    homeLineupBoost: hc.starterCertainty * 0.01, awayLineupBoost: ac.starterCertainty * 0.01,
    lineupRowsCount: homeLin.length + awayLin.length,
    homeInjuries: homeInj, awayInjuries: awayInj, lineups: [...homeLin, ...awayLin]
  };
}

async function safeGetLiveState({ gameId, homeTeam, awayTeam }) {
  try {
    return await getLiveTrackerData({ gameId, homeTeam, awayTeam }) || { liveFound: false, homeScore: 0, awayScore: 0, period: 1, clockSec: 12*60, clock: "12:00" };
  } catch (err) {
    console.error("getLiveTrackerData failed:", err.message);
    return { liveFound: false, homeScore: 0, awayScore: 0, period: 1, clockSec: 12*60, clock: "12:00" };
  }
}

// ─── routes ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => { res.sendFile(path.join(__dirname, "index.html")); });

app.get("/health", (req, res) => {
  res.json({ status: "ok", oddsApiKeyAdded: requireOddsKey(), fantasyNerdsKeyAdded: requireFantasyNerdsKey(), ballDontLieKeyAdded: requireBallDontLieKey(), mode: requireOddsKey() ? "live" : "mock", timestamp: new Date().toISOString() });
});

app.get("/games", async (req, res) => {
  try {
    if (!requireOddsKey()) return res.status(400).json({ error: "Missing ODDS_API_KEY", games: [] });
    const events = await getUpcomingEvents();
    const now    = Date.now(), next24h = now + 24*60*60*1000;
    const games  = (events || [])
      .filter(e => new Date(e.commence_time).getTime() <= next24h)
      .map(e => ({ id: e.id, label: `${e.away_team} @ ${e.home_team}`, homeTeam: e.home_team, awayTeam: e.away_team, commenceTime: e.commence_time, mode: buildMode(e.commence_time) }));
    res.json({ games });
  } catch (err) { res.status(500).json({ error: err.message, games: [] }); }
});

app.get("/odds", async (req, res) => {
  try {
    if (!requireOddsKey()) return res.status(400).json({ error: "Missing ODDS_API_KEY" });

    const gameId   = req.query.gameId   || "";
    const homeTeam = req.query.homeTeam || "";
    const awayTeam = req.query.awayTeam || "";
    if (!gameId && (!homeTeam || !awayTeam)) return res.status(400).json({ error: "Need either gameId or both homeTeam and awayTeam" });

    // ── fetch all data concurrently ──────────────────────────────────────────
    const featured = await resolveFeaturedOdds({ gameId, homeTeam, awayTeam });
    const mode     = buildMode(featured.commence_time);

    const lineupDate = (featured.commence_time || "").slice(0, 10) || todayYmd();

    const [
      props,
      historicalComparisons,
      sideInfoResults,
      liveStateRaw
    ] = await Promise.all([
      getEventPlayerPropsByResolvedEvent(featured.id),
      buildHistoricalComparisons(featured.home_team, featured.away_team),
      Promise.allSettled([getBestInjuries(), getBestLineups(lineupDate), getBestDepthCharts()]),
      mode === "live" ? safeGetLiveState({ gameId: featured.id, homeTeam: featured.home_team, awayTeam: featured.away_team }) : Promise.resolve(null)
    ]);

    const injuriesInfo = sideInfoResults[0].status === "fulfilled" ? sideInfoResults[0].value : { available: false, rows: [], source: "none" };
    const lineupsInfo  = sideInfoResults[1].status === "fulfilled" ? sideInfoResults[1].value : { available: false, rows: [], source: "none" };
    const depthInfo    = sideInfoResults[2].status === "fulfilled" ? sideInfoResults[2].value : { available: false, rows: [], source: "none" };

    const propSections = buildStructuredPropSections(props);
    const propSignal   = buildPropSignal(propSections);

    const injurySummary = summarizeInjuryLineup(
      featured.home_team, featured.away_team,
      injuriesInfo.rows || [], lineupsInfo.rows || [], depthInfo.rows || [],
      propSections
    );

    // ── independent stats model ──────────────────────────────────────────────
    // Run concurrently with market model; if it fails we gracefully degrade
    let statsResult = null;
    try {
      statsResult = await computeIndependentWinProb(
        featured.home_team,
        featured.away_team,
        liveStateRaw
      );
    } catch (err) {
      console.error("[stats_model] computeIndependentWinProb failed:", err.message);
    }

    // ── market model (existing) ──────────────────────────────────────────────
    let marketModel;
    let liveScoreState = null;

    if (mode === "live") {
      marketModel = buildEliteLiveModel({
        featuredOdds:     featured,
        liveState:        liveStateRaw,
        pregameBaseline:  statsResult ? { homeMarketProb: statsResult.homeWinProb } : null,
        calibrationFn:    safeApplyCalibration
      });
      liveScoreState = { ...marketModel.scoreState, formattedClock: formatClockFromSeconds(marketModel.scoreState?.clockSec) };
    } else {
      marketModel = buildElitePregameModel({
        featuredOdds:         featured,
        historicalComparisons,
        propSignal,
        injurySummary,
        calibrationFn: safeApplyCalibration
      });
    }

    // ── blend market + stats ──────────────────────────────────────────────────
    // Determine pick side from the market model (it knows spreads, totals, etc.)
    const pickSide = marketModel.pickSide;
    const pickTeam = marketModel.pickTeam;

    // Market-based implied prob (no-vig, for the pick side)
    const marketImpliedProb = marketModel.impliedProbability;

    // Blended true probability
    let blendedTrueProb;
    if (statsResult) {
      blendedTrueProb = blendModelWithStats(
        marketModel.trueProbability,
        statsResult.homeWinProb,
        pickSide
      );
    } else {
      blendedTrueProb = marketModel.trueProbability;
    }

    // Apply calibration to blended prob
    const calibratedBlendedProb = safeApplyCalibration(blendedTrueProb);
    const blendedEdge           = calibratedBlendedProb - marketImpliedProb;

    // ── edge from PURE stats model (the truly independent signal) ────────────
    let statsEdgeResult = null;
    if (statsResult) {
      const statsPickProb = pickSide === "home" ? statsResult.homeWinProb : 1 - statsResult.homeWinProb;
      statsEdgeResult = computeEdge(statsPickProb, marketImpliedProb);
    }

    // ── final verdict uses blended edge ──────────────────────────────────────
    function buildFinalVerdict(edge, noBetFilter) {
      if (noBetFilter?.blocked) return "Avoid";
      if (edge >= 0.045 && (marketModel.confidence?.percent || 0) >= 0.62) return "Bet now";
      if (edge >= 0.02) return "Watch";
      return "Avoid";
    }
    const finalVerdict = buildFinalVerdict(blendedEdge, marketModel.noBetFilter);

    // ── snapshot & edge history ───────────────────────────────────────────────
    const timestamp = new Date().toISOString();
    const pick      = `${pickTeam} to win`;
    const edgeKey   = featured.id || gameId || `${featured.home_team}_${featured.away_team}`;
    const smoothedEdge = addEdgeHistory(edgeKey, blendedEdge, timestamp);

    const snapshot = {
      id: `${edgeKey}_${timestamp}`,
      gameId: edgeKey,
      timestamp,
      commenceTime:    featured.commence_time,
      homeTeam:        featured.home_team,
      awayTeam:        featured.away_team,
      mode,
      pickSide,
      pickTeam,
      pick,
      impliedProbability:         roundToTwo(marketImpliedProb),
      trueProbability:            roundToTwo(blendedTrueProb),
      calibratedProbability:      roundToTwo(calibratedBlendedProb),
      calibratedTrueProbability:  roundToTwo(calibratedBlendedProb),
      rawEdge:                    roundToTwo(blendedEdge),
      edge:                       roundToTwo(smoothedEdge),
      calibratedEdge:             roundToTwo(blendedEdge),
      sportsbookDecimal:          roundToTwo(marketModel.sportsbookDecimal),
      verdict:                    finalVerdict,
      confidenceLabel:            marketModel.confidence?.label || "Low",
      confidencePercent:          marketModel.confidence?.percent ?? null,
      ...(marketModel.modelDetails   || {}),
      ...(marketModel.featureSnapshot || {}),
      statsModelHomeProb:         statsResult ? roundToTwo(statsResult.homeWinProb) : null,
      source: mode
    };

    logSnapshot(edgeKey, snapshot);
    safeRecordSnapshot({ ...snapshot, result: null });

    // ── response ─────────────────────────────────────────────────────────────
    const trueProbForUI = calibratedBlendedProb;

    res.json({
      id:              featured.id,
      homeTeam:        featured.home_team,
      awayTeam:        featured.away_team,
      commenceTime:    featured.commence_time,
      gameMode:        mode,
      pick,
      verdict:         finalVerdict,
      confidence: {
        label:   marketModel.confidence?.label || "Low",
        percent: roundToTwo(marketModel.confidence?.percent ?? null)
      },
      noBetFilter: marketModel.noBetFilter || { blocked: false, reasons: [] },

      // ── probabilities ─────────────────────────────────────────────────────
      impliedProbability:         roundToTwo(marketImpliedProb),
      impliedPercentFromOdds:     roundToTwo(marketImpliedProb),
      trueProbability:            roundToTwo(trueProbForUI),
      calibratedTrueProbability:  roundToTwo(calibratedBlendedProb),
      impliedProbabilityFormats:  marketModel.impliedProbabilityFormats || buildProbabilityFormats(marketImpliedProb),
      trueProbabilityFormats:     marketModel.trueProbabilityFormats    || buildProbabilityFormats(trueProbForUI),

      // ── edges ─────────────────────────────────────────────────────────────
      edge:           roundToTwo(smoothedEdge),
      rawEdge:        roundToTwo(blendedEdge),
      calibratedEdge: roundToTwo(blendedEdge),

      // ── independent model output (for display) ────────────────────────────
      independentModel: statsResult ? {
        homeWinProb:    roundToTwo(statsResult.homeWinProb),
        awayWinProb:    roundToTwo(1 - statsResult.homeWinProb),
        pregameProb:    roundToTwo(statsResult.pregameHomeProb),
        pickSideProb:   roundToTwo(pickSide === "home" ? statsResult.homeWinProb : 1 - statsResult.homeWinProb),
        statsEdge:      statsEdgeResult ? roundToTwo(statsEdgeResult.edge) : null,
        statsVerdict:   statsEdgeResult?.verdict || null,
        signals:        statsResult.signals,
        meta:           statsResult.meta,
        blendWeight:    STATS_MODEL_BLEND
      } : null,

      // ── odds formats ──────────────────────────────────────────────────────
      oddsFormats:           marketModel.oddsFormats || buildOddsFormatsFromDecimal(marketModel.sportsbookDecimal),
      sportsbookOddsDecimal: roundToTwo(marketModel.sportsbookDecimal),
      stakeSuggestion:       safeStakeSuggestion(marketModel.stakeSuggestion),

      // ── learning ─────────────────────────────────────────────────────────
      learningSummary:  safeLearningSummary(),
      calibrationTable: safeCalibrationTable(),
      history: (edgeHistoryStore[edgeKey] || []).map(p => ({ timestamp: p.timestamp, edge: roundToTwo(p.edge) })),

      // ── details ───────────────────────────────────────────────────────────
      modelDetails: {
        ...(marketModel.modelDetails || {}),
        historicalComparisons,
        propSignal
      },
      bookmakerTable: marketModel.bookmakerTable || [],
      propSections,
      injuryStatus: {
        available:             injurySummary.available,
        homeInjuriesCount:     injurySummary.homeInjuriesCount,
        awayInjuriesCount:     injurySummary.awayInjuriesCount,
        lineupRowsCount:       injurySummary.lineupRowsCount,
        homePenalty:           roundToTwo(injurySummary.homePenalty),
        awayPenalty:           roundToTwo(injurySummary.awayPenalty),
        homeStartersOut:       injurySummary.homeStartersOut,
        awayStartersOut:       injurySummary.awayStartersOut,
        homeStarterCertainty:  roundToTwo(injurySummary.homeStarterCertainty),
        awayStarterCertainty:  roundToTwo(injurySummary.awayStarterCertainty),
        sourceSelection: { injuries: injuriesInfo.source || "none", lineups: lineupsInfo.source || "none", depth: depthInfo.source || "none" },
        homeInjuries: injurySummary.homeInjuries,
        awayInjuries: injurySummary.awayInjuries,
        lineups:      injurySummary.lineups
      },
      scoreState: liveScoreState,
      updatedAt:  timestamp
    });

  } catch (err) {
    console.error("/odds failed:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/snapshots", (req, res) => {
  const gameId = req.query.gameId;
  if (!gameId) return res.status(400).json({ error: "Missing gameId" });
  res.json({ gameId, snapshots: (snapshotLogStore[gameId] || []).map(s => ({ ...s, impliedProbability: roundToTwo(s.impliedProbability), trueProbability: roundToTwo(s.trueProbability), edge: roundToTwo(s.edge), calibratedEdge: roundToTwo(s.calibratedEdge) })) });
});

app.get("/learning/summary",      (req, res) => { try { res.json(safeLearningSummary()); }   catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/learning/calibration",  (req, res) => { try { res.json({ calibration: safeCalibrationTable() }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get("/model/review", (req, res) => {
  try { res.json(buildModelReview(safeGetSnapshots())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/learning/grade", (req, res) => {
  try {
    const { gameId, finalWinner, finalHomeScore, finalAwayScore } = req.body || {};
    if (!gameId || !finalWinner) return res.status(400).json({ error: "Missing gameId or finalWinner" });
    if (!["home","away"].includes(finalWinner)) return res.status(400).json({ error: 'finalWinner must be "home" or "away"' });
    const updated     = safeUpdateGameResult({ gameId, finalWinner, finalHomeScore, finalAwayScore });
    const calibration = safeBuildCalibration();
    res.json({ updatedSnapshots: updated, calibrationBuckets: Object.keys(calibration).length, learningSummary: safeLearningSummary() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });
