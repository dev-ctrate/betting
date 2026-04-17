const express = require("express");
const path = require("path");
const learning = require("./learning");

const app = express();
const PORT = process.env.PORT || 3000;

const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const FANTASYNERDS_API_KEY = process.env.FANTASYNERDS_API_KEY || "";
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
const sideInfoCache = new Map();

const edgeHistoryStore = {};
const snapshotLogStore = {};

const CURRENT_TTL_MS = 25 * 1000;
const HISTORICAL_TTL_MS = 30 * 60 * 1000;
const SIDEINFO_TTL_MS = 10 * 60 * 1000;
const SNAPSHOT_RETENTION = 500;

const TEAM_ALIASES = {
  "Atlanta Hawks": ["hawks", "atl", "atlanta"],
  "Boston Celtics": ["celtics", "bos", "boston"],
  "Brooklyn Nets": ["nets", "bkn", "brooklyn"],
  "Charlotte Hornets": ["hornets", "cha", "charlotte"],
  "Chicago Bulls": ["bulls", "chi", "chicago"],
  "Cleveland Cavaliers": ["cavaliers", "cavs", "cle", "cleveland"],
  "Dallas Mavericks": ["mavericks", "mavs", "dal", "dallas"],
  "Denver Nuggets": ["nuggets", "den", "denver"],
  "Detroit Pistons": ["pistons", "det", "detroit"],
  "Golden State Warriors": ["warriors", "gsw", "golden state"],
  "Houston Rockets": ["rockets", "hou", "houston"],
  "Indiana Pacers": ["pacers", "ind", "indiana"],
  "Los Angeles Clippers": ["clippers", "lac", "la clippers"],
  "Los Angeles Lakers": ["lakers", "lal", "la lakers"],
  "Memphis Grizzlies": ["grizzlies", "mem", "memphis"],
  "Miami Heat": ["heat", "mia", "miami"],
  "Milwaukee Bucks": ["bucks", "mil", "milwaukee"],
  "Minnesota Timberwolves": ["timberwolves", "wolves", "min", "minnesota"],
  "New Orleans Pelicans": ["pelicans", "nop", "no", "new orleans"],
  "New York Knicks": ["knicks", "nyk", "new york"],
  "Oklahoma City Thunder": ["thunder", "okc", "oklahoma city"],
  "Orlando Magic": ["magic", "orl", "orlando"],
  "Philadelphia 76ers": ["76ers", "sixers", "phi", "philadelphia"],
  "Phoenix Suns": ["suns", "phx", "phoenix"],
  "Portland Trail Blazers": ["trail blazers", "blazers", "por", "portland"],
  "Sacramento Kings": ["kings", "sac", "sacramento"],
  "San Antonio Spurs": ["spurs", "sas", "san antonio"],
  "Toronto Raptors": ["raptors", "tor", "toronto"],
  "Utah Jazz": ["jazz", "uta", "utah"],
  "Washington Wizards": ["wizards", "was", "washington"]
};

// ---------- helpers ----------
function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function roundToTwo(num) {
  if (typeof num !== "number" || !Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
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
  let num = 0;
  let den = 0;
  for (const pair of pairs) {
    num += pair.value * pair.weight;
    den += pair.weight;
  }
  return den === 0 ? null : num / den;
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

function decimalToImpliedPercent(decimalOdds) {
  if (typeof decimalOdds !== "number" || decimalOdds <= 1) return null;
  return 1 / decimalOdds;
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
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed ${response.status}: ${text}`);
  }
  return await response.json();
}

function buildOddsUrl(pathname, params) {
  const base = `https://api.the-odds-api.com${pathname}`;
  const sp = new URLSearchParams(params);
  return `${base}?${sp.toString()}`;
}

function requireOddsKey() {
  return !!ODDS_API_KEY;
}

function requireFantasyNerdsKey() {
  return !!FANTASYNERDS_API_KEY;
}

function requireBallDontLieKey() {
  return !!BALLDONTLIE_API_KEY;
}

function findMarket(bookmaker, marketKey) {
  return bookmaker.markets?.find(m => m.key === marketKey) || null;
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

// ---------- odds conversions ----------
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

// ---------- odds api ----------
async function getUpcomingEvents() {
  const cacheKey = "events";
  const hit = cacheGet(currentCache, cacheKey);
  if (hit) return hit;

  const url = buildOddsUrl(`/v4/sports/${SPORT_KEY}/events`, {
    apiKey: ODDS_API_KEY
  });

  const data = await fetchJson(url);
  cacheSet(currentCache, cacheKey, data, CURRENT_TTL_MS);
  return data;
}

async function getEventFeaturedOdds(eventId) {
  const cacheKey = `featured:${eventId}`;
  const hit = cacheGet(currentCache, cacheKey);
  if (hit) return hit;

  const url = buildOddsUrl(`/v4/sports/${SPORT_KEY}/events/${eventId}/odds`, {
    apiKey: ODDS_API_KEY,
    regions: REGIONS,
    markets: FEATURED_MARKETS,
    oddsFormat: ODDS_FORMAT
  });

  const data = await fetchJson(url);
  cacheSet(currentCache, cacheKey, data, CURRENT_TTL_MS);
  return data;
}

async function getEventPlayerProps(eventId) {
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
  } catch {
    return { bookmakers: [] };
  }
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

function matchHistoricalEvent(snapshotEvents, homeTeam, awayTeam) {
  return (snapshotEvents || []).find(
    event => event.home_team === homeTeam && event.away_team === awayTeam
  ) || null;
}

function extractFeaturedConsensus(eventOdds) {
  const homeProbPairs = [];
  const awayProbPairs = [];
  const homeProbRaw = [];
  const awayProbRaw = [];
  const spreadSignals = [];
  const totalSignals = [];
  const books = [];

  for (const bookmaker of eventOdds.bookmakers || []) {
    const weight = getBookWeight(bookmaker.key || "");
    const h2h = findMarket(bookmaker, "h2h");
    const spreads = findMarket(bookmaker, "spreads");
    const totals = findMarket(bookmaker, "totals");

    let bookHomePrice = null;
    let bookAwayPrice = null;
    let bookHomeSpread = null;
    let bookAwaySpread = null;
    let bookTotal = null;

    if (h2h?.outcomes?.length >= 2) {
      const homeOutcome = h2h.outcomes.find(o => o.name === eventOdds.home_team);
      const awayOutcome = h2h.outcomes.find(o => o.name === eventOdds.away_team);

      if (homeOutcome && awayOutcome) {
        bookHomePrice = homeOutcome.price;
        bookAwayPrice = awayOutcome.price;

        const nv = noVigTwoWayProb(homeOutcome.price, awayOutcome.price);
        homeProbPairs.push({ value: nv.a, weight });
        awayProbPairs.push({ value: nv.b, weight });
        homeProbRaw.push(nv.a);
        awayProbRaw.push(nv.b);
      }
    }

    if (spreads?.outcomes?.length >= 2) {
      const homeSpread = spreads.outcomes.find(o => o.name === eventOdds.home_team);
      const awaySpread = spreads.outcomes.find(o => o.name === eventOdds.away_team);

      if (homeSpread && typeof homeSpread.point === "number") {
        bookHomeSpread = homeSpread.point;
        spreadSignals.push({
          value: clamp((-homeSpread.point) * 0.0105, -0.10, 0.10),
          weight
        });
      }

      if (awaySpread && typeof awaySpread.point === "number") {
        bookAwaySpread = awaySpread.point;
      }
    }

    if (totals?.outcomes?.length >= 2) {
      const over = totals.outcomes.find(o => o.name === "Over");
      if (over && typeof over.point === "number") {
        bookTotal = over.point;
        totalSignals.push({
          value: over.point,
          weight
        });
      }
    }

    books.push({
      book: bookmaker.key,
      homePrice: roundToTwo(bookHomePrice),
      awayPrice: roundToTwo(bookAwayPrice),
      homeSpread: roundToTwo(bookHomeSpread),
      awaySpread: roundToTwo(bookAwaySpread),
      total: roundToTwo(bookTotal),
      homeDecimal: roundToTwo(bookHomePrice),
      homeAmerican: decimalToAmerican(bookHomePrice),
      awayDecimal: roundToTwo(bookAwayPrice),
      awayAmerican: decimalToAmerican(bookAwayPrice)
    });
  }

  if (!homeProbPairs.length || !awayProbPairs.length) {
    return null;
  }

  const homeMarketProb = weightedAverage(homeProbPairs);
  const awayMarketProb = weightedAverage(awayProbPairs);
  const spreadAdj = weightedAverage(spreadSignals) || 0;
  const totalConsensus = weightedAverage(totalSignals) || 0;

  let totalAdj = 0;
  if (totalConsensus < 220) totalAdj = 0.005;
  else if (totalConsensus > 236) totalAdj = -0.005;

  const disagreementPenalty = clamp(
    (variance(homeProbRaw) + variance(awayProbRaw)) * 10,
    0,
    0.035
  );

  const homePrices = books.map(b => b.homePrice).filter(v => typeof v === "number");
  const awayPrices = books.map(b => b.awayPrice).filter(v => typeof v === "number");
  const totals = books.map(b => b.total).filter(v => typeof v === "number");
  const homeSpreads = books.map(b => b.homeSpread).filter(v => typeof v === "number");

  return {
    homeMarketProb,
    awayMarketProb,
    spreadAdj,
    totalConsensus,
    totalAdj,
    disagreementPenalty,
    bestHomePrice: homePrices.length ? Math.max(...homePrices) : null,
    bestAwayPrice: awayPrices.length ? Math.max(...awayPrices) : null,
    avgHomePrice: average(homePrices),
    avgAwayPrice: average(awayPrices),
    avgHomeSpread: average(homeSpreads),
    avgTotal: average(totals),
    bookCount: books.filter(
      b => typeof b.homePrice === "number" && typeof b.awayPrice === "number"
    ).length,
    books
  };
}

// ---------- props ----------
function groupPlayerPropMarkets(propsEventOdds) {
  const groupedMarkets = {};

  for (const bookmaker of propsEventOdds.bookmakers || []) {
    for (const market of bookmaker.markets || []) {
      if (!groupedMarkets[market.key]) groupedMarkets[market.key] = [];

      for (const outcome of market.outcomes || []) {
        groupedMarkets[market.key].push({
          book: bookmaker.key,
          player: outcome.description || "",
          side: outcome.name || "",
          point: outcome.point ?? null,
          price: outcome.price ?? null
        });
      }
    }
  }

  return groupedMarkets;
}

function decidePropSide(row) {
  if (typeof row.hitProbability !== "number") return null;

  if (row.hitProbability > 0.5) {
    return {
      pick: "over",
      probability: row.hitProbability
    };
  }

  return {
    pick: "under",
    probability: 1 - row.hitProbability
  };
}

function buildStructuredPropSections(propsEventOdds) {
  const groupedMarkets = groupPlayerPropMarkets(propsEventOdds);

  const marketMap = {
    player_points: "points",
    player_assists: "assists",
    player_rebounds: "rebounds",
    player_points_rebounds_assists: "pra"
  };

  const sections = {
    points: [],
    assists: [],
    rebounds: [],
    pra: []
  };

  for (const [marketKey, displayKey] of Object.entries(marketMap)) {
    const outcomes = groupedMarkets[marketKey] || [];
    const grouped = {};

    for (const o of outcomes) {
      const key = `${o.player}__${o.point}`;
      if (!grouped[key]) {
        grouped[key] = {
          player: o.player,
          point: o.point,
          overPrices: [],
          underPrices: []
        };
      }

      if ((o.side || "").toLowerCase() === "over" && typeof o.price === "number") {
        grouped[key].overPrices.push(o.price);
      } else if ((o.side || "").toLowerCase() === "under" && typeof o.price === "number") {
        grouped[key].underPrices.push(o.price);
      }
    }

    const rows = Object.values(grouped)
      .map(item => {
        const avgOver = average(item.overPrices);
        const avgUnder = average(item.underPrices);

        let hitProb = null;
        if (typeof avgOver === "number" && typeof avgUnder === "number") {
          hitProb = noVigTwoWayProb(avgOver, avgUnder).a;
        } else if (typeof avgOver === "number") {
          hitProb = decimalToImpliedPercent(avgOver);
        }

        const decision = decidePropSide({ hitProbability: hitProb });

        return {
          player: item.player,
          line: roundToTwo(item.point),
          overDecimal: roundToTwo(avgOver),
          overAmerican: decimalToAmerican(avgOver),
          hitProbability: roundToTwo(hitProb),
          coverage: item.overPrices.length + item.underPrices.length,
          pick: decision?.pick || null,
          pickProbability: roundToTwo(decision?.probability)
        };
      })
      .filter(row => row.player && typeof row.line === "number")
      .sort((a, b) => {
        return (b.coverage - a.coverage) || ((b.pickProbability || 0) - (a.pickProbability || 0));
      })
      .slice(0, 12);

    sections[displayKey] = rows;
  }

  return sections;
}

function buildPropSignal(propSections) {
  const allRows = [
    ...(propSections.points || []),
    ...(propSections.assists || []),
    ...(propSections.rebounds || []),
    ...(propSections.pra || [])
  ];

  if (!allRows.length) {
    return { adj: 0, depth: 0 };
  }

  let strength = 0;
  let observations = 0;

  for (const row of allRows) {
    const coverageBoost = clamp((row.coverage - 1) * 0.0015, 0, 0.01);
    const lineStrength = clamp((row.line || 0) * 0.0005, 0, 0.02);
    const probStrength = clamp(((row.hitProbability || 0.5) - 0.5) * 0.05, -0.015, 0.015);

    strength += coverageBoost + lineStrength + probStrength;
    observations += 1;
  }

  return {
    adj: clamp((strength / Math.max(observations, 1)) * 0.4, 0, 0.01),
    depth: observations
  };
}

// ---------- historical ----------
async function buildHistoricalComparisons(homeTeam, awayTeam) {
  const comparisons = {};

  for (const lookback of HISTORICAL_LOOKBACKS) {
    const dateIso = toIso(Date.now() - lookback.ms);
    try {
      const snapshot = await getHistoricalSnapshot(dateIso);
      const matched = matchHistoricalEvent(snapshot.data || snapshot, homeTeam, awayTeam);

      if (matched) {
        const extracted = extractFeaturedConsensus(matched);
        if (extracted) {
          comparisons[lookback.label] = {
            timestampRequested: dateIso,
            homeMarketProb: roundToTwo(extracted.homeMarketProb),
            awayMarketProb: roundToTwo(extracted.awayMarketProb),
            spreadAdj: roundToTwo(extracted.spreadAdj),
            totalConsensus: roundToTwo(extracted.totalConsensus),
            avgHomeSpread: roundToTwo(extracted.avgHomeSpread),
            avgTotal: roundToTwo(extracted.avgTotal)
          };
        }
      }
    } catch (err) {
      comparisons[lookback.label] = { error: err.message };
    }
  }

  return comparisons;
}

// ---------- Fantasy Nerds + Ball Don't Lie ----------
function normalizeFantasyNerdsRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.Data)) return payload.Data;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.players)) return payload.players;
  if (Array.isArray(payload?.lineups)) return payload.lineups;
  if (Array.isArray(payload?.depthcharts)) return payload.depthcharts;
  return [];
}

function normalizeBallDontLieRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function buildBallDontLieHeaders() {
  return {
    Authorization: BALLDONTLIE_API_KEY
  };
}

async function getBallDontLieInjuries() {
  if (!requireBallDontLieKey()) return { available: false, rows: [], source: "none" };

  const cacheKey = "bdl:injuries";
  const hit = cacheGet(sideInfoCache, cacheKey);
  if (hit) return hit;

  try {
    const url = "https://api.balldontlie.io/v1/player_injuries?per_page=100";
    const raw = await fetchJson(url, { headers: buildBallDontLieHeaders() });
    const value = {
      available: true,
      rows: normalizeBallDontLieRows(raw),
      raw,
      source: "balldontlie"
    };
    cacheSet(sideInfoCache, cacheKey, value, SIDEINFO_TTL_MS);
    return value;
  } catch {
    return { available: false, rows: [], source: "none" };
  }
}

async function getBallDontLieLineups(dateStr = "") {
  if (!requireBallDontLieKey()) return { available: false, rows: [], source: "none" };

  const resolvedDate = dateStr || todayYmd();
  const cacheKey = `bdl:lineups:${resolvedDate}`;
  const hit = cacheGet(sideInfoCache, cacheKey);
  if (hit) return hit;

  try {
    const url = `https://api.balldontlie.io/v1/lineups?dates[]=${encodeURIComponent(resolvedDate)}&per_page=100`;
    const raw = await fetchJson(url, { headers: buildBallDontLieHeaders() });
    const value = {
      available: true,
      rows: normalizeBallDontLieRows(raw),
      raw,
      source: "balldontlie"
    };
    cacheSet(sideInfoCache, cacheKey, value, SIDEINFO_TTL_MS);
    return value;
  } catch {
    return { available: false, rows: [], source: "none" };
  }
}

async function getFantasyNerdsInjuries() {
  if (!requireFantasyNerdsKey()) return { available: false, rows: [], source: "none" };

  const cacheKey = "fn:injuries";
  const hit = cacheGet(sideInfoCache, cacheKey);
  if (hit) return hit;

  try {
    const url = `https://api.fantasynerds.com/v1/nba/injuries?apikey=${encodeURIComponent(FANTASYNERDS_API_KEY)}`;
    const raw = await fetchJson(url);
    const value = {
      available: true,
      rows: normalizeFantasyNerdsRows(raw),
      raw,
      source: "fantasynerds"
    };
    cacheSet(sideInfoCache, cacheKey, value, SIDEINFO_TTL_MS);
    return value;
  } catch {
    return { available: false, rows: [], source: "none" };
  }
}

async function getFantasyNerdsLineups(dateStr = "") {
  if (!requireFantasyNerdsKey()) return { available: false, rows: [], source: "none" };

  const cacheKey = `fn:lineups:${dateStr || "today"}`;
  const hit = cacheGet(sideInfoCache, cacheKey);
  if (hit) return hit;

  try {
    const url = `https://api.fantasynerds.com/v1/nba/lineups?apikey=${encodeURIComponent(FANTASYNERDS_API_KEY)}&date=${encodeURIComponent(dateStr)}`;
    const raw = await fetchJson(url);
    const value = {
      available: true,
      rows: normalizeFantasyNerdsRows(raw),
      raw,
      source: "fantasynerds"
    };
    cacheSet(sideInfoCache, cacheKey, value, SIDEINFO_TTL_MS);
    return value;
  } catch {
    return { available: false, rows: [], source: "none" };
  }
}

async function getFantasyNerdsDepthCharts() {
  if (!requireFantasyNerdsKey()) return { available: false, rows: [], source: "none" };

  const cacheKey = "fn:depthcharts";
  const hit = cacheGet(sideInfoCache, cacheKey);
  if (hit) return hit;

  try {
    const url = `https://api.fantasynerds.com/v1/nba/depth?apikey=${encodeURIComponent(FANTASYNERDS_API_KEY)}`;
    const raw = await fetchJson(url);
    const value = {
      available: true,
      rows: normalizeFantasyNerdsRows(raw),
      raw,
      source: "fantasynerds"
    };
    cacheSet(sideInfoCache, cacheKey, value, SIDEINFO_TTL_MS);
    return value;
  } catch {
    return { available: false, rows: [], source: "none" };
  }
}

async function getBestInjuries() {
  const bdl = await getBallDontLieInjuries();
  if (bdl.available && bdl.rows.length) return bdl;

  const fn = await getFantasyNerdsInjuries();
  if (fn.available) return fn;

  return { available: false, rows: [], source: "none" };
}

async function getBestLineups(dateStr = "") {
  const bdl = await getBallDontLieLineups(dateStr);
  if (bdl.available && bdl.rows.length) return bdl;

  const fn = await getFantasyNerdsLineups(dateStr);
  if (fn.available) return fn;

  return { available: false, rows: [], source: "none" };
}

async function getBestDepthCharts() {
  const fn = await getFantasyNerdsDepthCharts();
  if (fn.available) return fn;

  return { available: false, rows: [], source: "none" };
}

function extractPlayerName(obj) {
  if (!obj) return "";

  if (typeof obj.PlayerName === "string") return obj.PlayerName;
  if (typeof obj.Name === "string") return obj.Name;
  if (typeof obj.player === "string") return obj.player;
  if (typeof obj.full_name === "string") return obj.full_name;
  if (typeof obj.playername === "string") return obj.playername;

  if (obj.player && typeof obj.player === "object") {
    const fn = obj.player.first_name || "";
    const ln = obj.player.last_name || "";
    const full = `${fn} ${ln}`.trim();
    if (full) return full;
    if (typeof obj.player.name === "string") return obj.player.name;
  }

  if (typeof obj.first_name === "string" || typeof obj.last_name === "string") {
    return `${obj.first_name || ""} ${obj.last_name || ""}`.trim();
  }

  return "";
}

function getTeamTokens(teamName) {
  const aliases = TEAM_ALIASES[teamName] || [];
  const tokens = new Set([teamName.toLowerCase(), ...aliases.map(x => x.toLowerCase())]);

  const words = teamName.toLowerCase().split(" ").filter(Boolean);
  for (const word of words) {
    tokens.add(word);
  }

  const lastWord = words[words.length - 1];
  if (lastWord) tokens.add(lastWord);

  return [...tokens].filter(Boolean);
}

function teamNameLooseMatch(sourceText, teamName) {
  if (!sourceText || !teamName) return false;
  const hay = sourceText.toLowerCase();
  const teamTokens = getTeamTokens(teamName);
  return teamTokens.some(token => hay.includes(token));
}

function rowContainsTeam(row, teamName) {
  return teamNameLooseMatch(JSON.stringify(row), teamName);
}

function lineupCertaintyValue(row) {
  const text = JSON.stringify(row).toLowerCase();
  if (text.includes("confirmed")) return 1.0;
  if (text.includes("starting")) return 0.85;
  if (text.includes("starter")) return 0.8;
  if (text.includes("projected")) return 0.55;
  if (text.includes("expected")) return 0.5;
  return 0.25;
}

function injurySeverityValue(row) {
  const text = JSON.stringify(row).toLowerCase();
  if (text.includes("out")) return 1.0;
  if (text.includes("doubtful")) return 0.8;
  if (text.includes("questionable")) return 0.5;
  if (text.includes("probable")) return 0.2;
  return 0.4;
}

function depthRoleValue(row) {
  const text = JSON.stringify(row).toLowerCase();
  if (text.includes("starter") || text.includes("1st")) return 1.0;
  if (text.includes("2nd")) return 0.55;
  if (text.includes("3rd")) return 0.25;
  return 0.45;
}

function buildPlayerValueMap(propSections) {
  const map = {};
  const weights = {
    points: 1.0,
    assists: 0.9,
    rebounds: 0.8,
    pra: 1.2
  };

  for (const [sectionName, rows] of Object.entries(propSections)) {
    for (const row of rows || []) {
      const player = (row.player || "").toLowerCase().trim();
      if (!player) continue;

      const lineComponent = clamp((row.line || 0) * 0.01, 0, 0.6);
      const probBase = typeof row.pickProbability === "number" ? row.pickProbability : row.hitProbability || 0.5;
      const probComponent = clamp(probBase - 0.5, 0, 0.25);
      const coverageComponent = clamp((row.coverage || 0) * 0.015, 0, 0.15);

      const score =
        (lineComponent + probComponent + coverageComponent) *
        (weights[sectionName] || 1.0);

      if (!map[player]) map[player] = 0;
      map[player] += score;
    }
  }

  return map;
}

function findBestPlayerValue(name, playerValueMap) {
  if (!name) return 0;
  const key = name.toLowerCase().trim();

  if (playerValueMap[key]) return playerValueMap[key];

  const parts = key.split(" ").filter(Boolean);
  if (!parts.length) return 0;

  let best = 0;

  for (const [candidate, value] of Object.entries(playerValueMap)) {
    const matchCount = parts.filter(part => candidate.includes(part)).length;
    if (matchCount >= Math.min(2, parts.length)) {
      best = Math.max(best, value);
    }
  }

  return best;
}

function summarizeInjuryLineup(homeTeam, awayTeam, injuriesRows, lineupsRows, depthRows, propSections) {
  const homeInjuries = injuriesRows.filter(row => rowContainsTeam(row, homeTeam));
  const awayInjuries = injuriesRows.filter(row => rowContainsTeam(row, awayTeam));

  const homeLineups = lineupsRows.filter(row => rowContainsTeam(row, homeTeam));
  const awayLineups = lineupsRows.filter(row => rowContainsTeam(row, awayTeam));

  const homeDepth = depthRows.filter(row => rowContainsTeam(row, homeTeam));
  const awayDepth = depthRows.filter(row => rowContainsTeam(row, awayTeam));

  const playerValueMap = buildPlayerValueMap(propSections);

  function computeTeamPenalty(injuries, lineupRowsForTeam, depthRowsForTeam) {
    let totalPenalty = 0;
    let startersOut = 0;
    let projectedStarters = 0;

    for (const injury of injuries) {
      const playerName = extractPlayerName(injury);
      const severity = injurySeverityValue(injury);

      const lineupMatch = lineupRowsForTeam.find(row => {
        return JSON.stringify(row).toLowerCase().includes(playerName.toLowerCase());
      });

      const depthMatch = depthRowsForTeam.find(row => {
        return JSON.stringify(row).toLowerCase().includes(playerName.toLowerCase());
      });

      const lineupWeight = lineupMatch ? lineupCertaintyValue(lineupMatch) : 0;
      const roleWeight = depthMatch ? depthRoleValue(depthMatch) : (lineupMatch ? 0.9 : 0.4);
      const playerValue = findBestPlayerValue(playerName, playerValueMap);

      const basePenalty =
        0.006 +
        severity * 0.010 +
        roleWeight * 0.010 +
        lineupWeight * 0.010 +
        playerValue * 0.008;

      totalPenalty += basePenalty;

      if (roleWeight >= 0.8 || lineupWeight >= 0.8) {
        startersOut += 1;
      }
    }

    for (const lineup of lineupRowsForTeam) {
      if (lineupCertaintyValue(lineup) >= 0.8) {
        projectedStarters += 1;
      }
    }

    const starterCertainty =
      lineupRowsForTeam.length > 0
        ? clamp(projectedStarters / 5, 0, 1)
        : 0;

    return {
      penalty: clamp(totalPenalty, 0, 0.10),
      startersOut,
      starterCertainty
    };
  }

  const homeCalc = computeTeamPenalty(homeInjuries, homeLineups, homeDepth);
  const awayCalc = computeTeamPenalty(awayInjuries, awayLineups, awayDepth);

  const homeLineupBoost = homeCalc.starterCertainty * 0.01;
  const awayLineupBoost = awayCalc.starterCertainty * 0.01;

  return {
    available: injuriesRows.length > 0 || lineupsRows.length > 0 || depthRows.length > 0,
    homeInjuriesCount: homeInjuries.length,
    awayInjuriesCount: awayInjuries.length,
    homePenalty: homeCalc.penalty,
    awayPenalty: awayCalc.penalty,
    homeStartersOut: homeCalc.startersOut,
    awayStartersOut: awayCalc.startersOut,
    homeStarterCertainty: homeCalc.starterCertainty,
    awayStarterCertainty: awayCalc.starterCertainty,
    homeLineupBoost,
    awayLineupBoost,
    lineupRowsCount: homeLineups.length + awayLineups.length,
    homeInjuries,
    awayInjuries,
    lineups: [...homeLineups, ...awayLineups]
  };
}

// ---------- model ----------
function buildConfidence(currentConsensus, historicalComparisons, propSignal, injurySummary) {
  let score = 50;

  score += clamp((currentConsensus.bookCount - 3) * 6, 0, 25);
  score -= clamp(currentConsensus.disagreementPenalty * 800, 0, 22);

  if (historicalComparisons["2h"] && !historicalComparisons["2h"].error) score += 8;
  if (historicalComparisons["24h"] && !historicalComparisons["24h"].error) score += 8;

  score += clamp(propSignal.depth * 0.7, 0, 12);

  if (injurySummary.available) {
    score += 5;
    score += clamp(
      (injurySummary.homeStarterCertainty + injurySummary.awayStarterCertainty) * 8,
      0,
      8
    );
    score -= clamp(
      (injurySummary.homeStartersOut + injurySummary.awayStartersOut) * 2,
      0,
      10
    );
  }

  score = clamp(score, 0, 100);

  let label = "Low";
  if (score >= 75) label = "High";
  else if (score >= 55) label = "Medium";

  return { label, percent: score / 100 };
}

function buildStakeSuggestion(edge, confidenceLabel) {
  if (edge < 0.02) return { tier: "No bet", fraction: 0 };
  if (edge < 0.04) {
    return confidenceLabel === "High"
      ? { tier: "Small", fraction: 0.25 }
      : { tier: "Tiny", fraction: 0.1 };
  }
  if (edge < 0.07) {
    return confidenceLabel === "High"
      ? { tier: "Normal", fraction: 0.5 }
      : { tier: "Small", fraction: 0.25 };
  }
  return confidenceLabel === "High"
    ? { tier: "Strong", fraction: 0.75 }
    : { tier: "Normal", fraction: 0.5 };
}

function buildVerdict(rawEdge, confidence, mode, disagreementPenalty) {
  if (rawEdge < 0.015) return "No edge";
  if (confidence.label === "Low" || disagreementPenalty > 0.025) return "Low confidence";

  if (mode === "live") {
    if (rawEdge >= 0.05 && confidence.percent >= 0.75) return "Bet now";
    if (rawEdge >= 0.025) return "Watch";
    return "Avoid";
  }

  if (rawEdge >= 0.045 && confidence.percent >= 0.70) return "Bet now";
  if (rawEdge >= 0.02) return "Watch";
  return "Avoid";
}

function buildProbabilityModel(currentConsensus, historicalComparisons, propSignal, mode, injurySummary) {
  const homeMarketProb = currentConsensus.homeMarketProb;
  const awayMarketProb = currentConsensus.awayMarketProb;

  let lineMovementAdj = 0;
  const h24 = historicalComparisons["24h"];
  const h2 = historicalComparisons["2h"];

  if (h24 && typeof h24.homeMarketProb === "number") {
    const delta24 = homeMarketProb - h24.homeMarketProb;
    lineMovementAdj += clamp(delta24 * (mode === "pregame" ? 0.5 : 0.25), -0.03, 0.03);
  }

  if (h2 && typeof h2.homeMarketProb === "number") {
    const delta2 = homeMarketProb - h2.homeMarketProb;
    lineMovementAdj += clamp(delta2 * (mode === "live" ? 1.0 : 0.8), -0.03, 0.03);
  }

  const propAdj = clamp(propSignal.adj, 0, 0.01);

  const injuryAdjHome = injurySummary.available
    ? clamp(
        (injurySummary.awayPenalty - injurySummary.homePenalty) +
        (injurySummary.homeLineupBoost - injurySummary.awayLineupBoost),
        -0.06,
        0.06
      )
    : 0;

  let homeTrueProb =
    homeMarketProb +
    currentConsensus.spreadAdj +
    currentConsensus.totalAdj +
    lineMovementAdj +
    propAdj +
    injuryAdjHome -
    currentConsensus.disagreementPenalty;

  let awayTrueProb =
    awayMarketProb -
    currentConsensus.spreadAdj -
    currentConsensus.totalAdj -
    lineMovementAdj -
    propAdj -
    injuryAdjHome -
    currentConsensus.disagreementPenalty;

  homeTrueProb = clamp(homeTrueProb, 0.01, 0.99);
  awayTrueProb = clamp(awayTrueProb, 0.01, 0.99);

  const total = homeTrueProb + awayTrueProb;
  homeTrueProb /= total;
  awayTrueProb /= total;

  const homeEdge = homeTrueProb - homeMarketProb;
  const awayEdge = awayTrueProb - awayMarketProb;

  const pickSide = homeEdge >= awayEdge ? "home" : "away";
  const impliedProbability = pickSide === "home" ? homeMarketProb : awayMarketProb;
  const trueProbability = pickSide === "home" ? homeTrueProb : awayTrueProb;
  const rawEdge = pickSide === "home" ? homeEdge : awayEdge;

  return {
    pickSide,
    impliedProbability,
    trueProbability,
    rawEdge,
    lineMovementAdj,
    propAdj,
    injuryAdjHome
  };
}

// ---------- routes ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    oddsApiKeyAdded: requireOddsKey(),
    fantasyNerdsKeyAdded: requireFantasyNerdsKey(),
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

    const events = await getUpcomingEvents();
    const now = Date.now();
    const next24h = now + 24 * 60 * 60 * 1000;

    const games = (events || [])
      .filter(event => {
        const t = new Date(event.commence_time).getTime();
        return t >= now && t <= next24h;
      })
      .map(event => ({
        id: event.id,
        label: `${event.away_team} @ ${event.home_team}`,
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        commenceTime: event.commence_time,
        mode: buildMode(event.commence_time)
      }));

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

    const gameId = req.query.gameId;
    if (!gameId) {
      return res.status(400).json({ error: "Missing gameId query parameter" });
    }

    const featured = await getEventFeaturedOdds(gameId);
    const props = await getEventPlayerProps(gameId);

    const currentConsensus = extractFeaturedConsensus(featured);
    if (!currentConsensus) {
      return res.status(500).json({
        error: "Could not extract featured odds consensus"
      });
    }

    const mode = buildMode(featured.commence_time);
    const historicalComparisons = await buildHistoricalComparisons(
      featured.home_team,
      featured.away_team
    );

    const propSections = buildStructuredPropSections(props);
    const propSignal = buildPropSignal(propSections);

    const lineupDate = featured.commence_time ? featured.commence_time.slice(0, 10) : todayYmd();

    const [injuriesInfo, lineupsInfo, depthInfo] = await Promise.all([
      getBestInjuries(),
      getBestLineups(lineupDate),
      getBestDepthCharts()
    ]);

    const injurySummary = summarizeInjuryLineup(
      featured.home_team,
      featured.away_team,
      injuriesInfo.rows || [],
      lineupsInfo.rows || [],
      depthInfo.rows || [],
      propSections
    );

    const model = buildProbabilityModel(
      currentConsensus,
      historicalComparisons,
      propSignal,
      mode,
      injurySummary
    );

    const calibratedTrueProbability = learning.applyCalibration(model.trueProbability);
    const calibratedEdge = calibratedTrueProbability - model.impliedProbability;

    const confidence = buildConfidence(
      currentConsensus,
      historicalComparisons,
      propSignal,
      injurySummary
    );

    const verdict = buildVerdict(
      calibratedEdge,
      confidence,
      mode,
      currentConsensus.disagreementPenalty
    );

    const stake = buildStakeSuggestion(calibratedEdge, confidence.label);

    const pickTeam =
      model.pickSide === "home" ? featured.home_team : featured.away_team;

    const chosenDecimal =
      model.pickSide === "home"
        ? currentConsensus.bestHomePrice
        : currentConsensus.bestAwayPrice;

    const pick = `${pickTeam} to win`;
    const timestamp = new Date().toISOString();
    const smoothedEdge = addEdgeHistory(gameId, model.rawEdge, timestamp);

    const snapshot = {
      timestamp,
      mode,
      impliedProbability: roundToTwo(model.impliedProbability),
      trueProbability: roundToTwo(model.trueProbability),
      edge: roundToTwo(smoothedEdge),
      rawEdge: roundToTwo(model.rawEdge),
      verdict,
      confidencePercent: roundToTwo(confidence.percent),
      bestPrice: roundToTwo(chosenDecimal),
      pick,
      stakeTier: stake.tier
    };

    logSnapshot(gameId, snapshot);

    learning.recordSnapshot({
      gameId,
      timestamp,
      commenceTime: featured.commence_time,
      homeTeam: featured.home_team,
      awayTeam: featured.away_team,
      pickSide: model.pickSide,
      pickTeam,
      impliedProbability: model.impliedProbability,
      trueProbability: model.trueProbability,
      calibratedProbability: calibratedTrueProbability,
      rawEdge: model.rawEdge,
      calibratedEdge,
      sportsbookDecimal: chosenDecimal,
      verdict,
      confidenceLabel: confidence.label,
      confidencePercent: confidence.percent,
      spreadAdj: currentConsensus.spreadAdj,
      totalAdj: currentConsensus.totalAdj,
      lineMovementAdj: model.lineMovementAdj,
      propAdj: model.propAdj,
      injuryAdjHome: model.injuryAdjHome,
      disagreementPenalty:currentConsensus.disagreementPenalty,
      avgHomeSpread:currentConsensus.avgHomeSpread,
      avgTotal: currentConsensus.avgTotal,
      bookCount: currentConsensus.bookCount,
      source: "live"
    });

    res.json({
      id: featured.id,
      homeTeam: featured.home_team,
      awayTeam: featured.away_team,
      commenceTime: featured.commence_time,
      gameMode: mode,
      pick,
      verdict,
      confidence: {
        label: confidence.label,
        percent: roundToTwo(confidence.percent)
      },
      impliedProbability: roundToTwo(model.impliedProbability),
      impliedPercentFromOdds: roundToTwo(model.impliedProbability),
      trueProbability: roundToTwo(model.trueProbability),
      impliedProbabilityFormats: buildProbabilityFormats(model.impliedProbability),
      trueProbabilityFormats: buildProbabilityFormats(model.trueProbability),
      edge: roundToTwo(smoothedEdge),
      oddsFormats: buildOddsFormatsFromDecimal(chosenDecimal),
      sportsbookOddsDecimal: roundToTwo(chosenDecimal),
      stakeSuggestion: {
        tier: stake.tier,
        fraction: roundToTwo(stake.fraction)
      },
      history: (edgeHistoryStore[gameId] || []).map(point => ({
        timestamp: point.timestamp,
        edge: roundToTwo(point.edge)
      })),
      modelDetails: {
        spreadAdj: roundToTwo(currentConsensus.spreadAdj),
        totalConsensus: roundToTwo(currentConsensus.totalConsensus),
        totalAdj: roundToTwo(currentConsensus.totalAdj),
        disagreementPenalty: roundToTwo(currentConsensus.disagreementPenalty),
        lineMovementAdj: roundToTwo(model.lineMovementAdj),
        propAdj: roundToTwo(model.propAdj),
        injuryAdjHome: roundToTwo(model.injuryAdjHome),
        avgHomePrice: roundToTwo(currentConsensus.avgHomePrice),
        avgAwayPrice: roundToTwo(currentConsensus.avgAwayPrice),
        bestHomePrice: roundToTwo(currentConsensus.bestHomePrice),
        bestAwayPrice: roundToTwo(currentConsensus.bestAwayPrice),
        avgHomeSpread: roundToTwo(currentConsensus.avgHomeSpread),
        avgTotal: roundToTwo(currentConsensus.avgTotal),
        bookCount: currentConsensus.bookCount,
        historicalComparisons
      },
      bookmakerTable: currentConsensus.books,
      propSections,
      injuryStatus: {
        available: injurySummary.available,
        homeInjuriesCount: injurySummary.homeInjuriesCount,
        awayInjuriesCount: injurySummary.awayInjuriesCount,
        lineupRowsCount: injurySummary.lineupRowsCount,
        homePenalty: roundToTwo(injurySummary.homePenalty),
        awayPenalty: roundToTwo(injurySummary.awayPenalty),
        homeStartersOut: injurySummary.homeStartersOut,
        awayStartersOut: injurySummary.awayStartersOut,
        homeStarterCertainty: roundToTwo(injurySummary.homeStarterCertainty),
        awayStarterCertainty: roundToTwo(injurySummary.awayStarterCertainty),
        sourceSelection: {
          injuries: injuriesInfo.source || "none",
          lineups: lineupsInfo.source || "none",
          depth: depthInfo.source || "none"
        },
        homeInjuries: injurySummary.homeInjuries,
        awayInjuries: injurySummary.awayInjuries,
        lineups: injurySummary.lineups
      },
      timestamp
    });
  } catch (error) {
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
      edge: roundToTwo(s.edge),
      rawEdge: roundToTwo(s.rawEdge),
      confidencePercent: roundToTwo(s.confidencePercent),
      bestPrice: roundToTwo(s.bestPrice)
    }))
  });
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
