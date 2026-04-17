const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const FANTASYNERDS_API_KEY = process.env.FANTASYNERDS_API_KEY || "";

const SPORT_KEY = "basketball_nba";
const REGIONS = "us";
const ODDS_FORMAT = "decimal";
const FEATURED_MARKETS = "h2h,spreads,totals";
const PROP_MARKETS = [
  "player_points",
  "player_assists",
  "player_rebounds",
  "player_points_rebounds_assists"
].join(",");

const CURRENT_TTL_MS = 20 * 1000;
const HISTORICAL_TTL_MS = 10 * 60 * 1000;
const SIDEINFO_TTL_MS = 10 * 60 * 1000;
const SNAPSHOT_FILE = path.join(__dirname, "model_snapshots.jsonl");

const currentCache = new Map();
const historicalCache = new Map();
const sideInfoCache = new Map();
const priceHistoryStore = {};

function round2(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 100) / 100
    : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function variance(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const avg = average(values);
  return average(values.map(v => (v - avg) ** 2));
}

function decimalToAmerican(decimalOdds) {
  if (typeof decimalOdds !== "number" || !Number.isFinite(decimalOdds) || decimalOdds <= 1) {
    return null;
  }
  if (decimalOdds >= 2) {
    return Math.round((decimalOdds - 1) * 100);
  }
  return Math.round(-100 / (decimalOdds - 1));
}

function probabilityToAmerican(probPercent) {
  if (typeof probPercent !== "number" || !Number.isFinite(probPercent)) return null;
  const probability = probPercent / 100;
  if (probability <= 0 || probability >= 1) return null;
  const decimalOdds = 1 / probability;
  return decimalToAmerican(decimalOdds);
}

function decimalToImpliedPercent(decimalOdds) {
  if (typeof decimalOdds !== "number" || !Number.isFinite(decimalOdds) || decimalOdds <= 1) {
    return null;
  }
  return 100 / decimalOdds;
}

function toAmericanString(numberValue) {
  if (typeof numberValue !== "number" || !Number.isFinite(numberValue)) return null;
  return numberValue > 0 ? `+${numberValue}` : `${numberValue}`;
}

function noVigTwoWayProbPercent(priceA, priceB) {
  if (
    typeof priceA !== "number" ||
    typeof priceB !== "number" ||
    !Number.isFinite(priceA) ||
    !Number.isFinite(priceB) ||
    priceA <= 1 ||
    priceB <= 1
  ) {
    return { a: null, b: null };
  }

  const rawA = 1 / priceA;
  const rawB = 1 / priceB;
  const total = rawA + rawB;

  return {
    a: (rawA / total) * 100,
    b: (rawB / total) * 100
  };
}

function getBookWeight(bookKey) {
  const sharpBooks = ["pinnacle", "circasports", "matchbook"];
  const solidBooks = ["draftkings", "fanduel", "betmgm", "betrivers"];
  if (sharpBooks.includes(bookKey)) return 1.4;
  if (solidBooks.includes(bookKey)) return 1.15;
  return 1.0;
}

function weightedAverage(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return null;
  let numerator = 0;
  let denominator = 0;

  for (const pair of pairs) {
    if (
      typeof pair?.value === "number" &&
      Number.isFinite(pair.value) &&
      typeof pair?.weight === "number" &&
      Number.isFinite(pair.weight)
    ) {
      numerator += pair.value * pair.weight;
      denominator += pair.weight;
    }
  }

  return denominator > 0 ? numerator / denominator : null;
}

function buildOddsFormatsFromDecimal(decimalOdds) {
  const impliedPercent = decimalToImpliedPercent(decimalOdds);
  const american = decimalToAmerican(decimalOdds);

  return {
    american,
    americanText: toAmericanString(american),
    decimal: round2(decimalOdds),
    impliedPercent: round2(impliedPercent)
  };
}

function buildProbabilityFormats(probPercent) {
  const american = probabilityToAmerican(probPercent);

  return {
    percent: round2(probPercent),
    american,
    americanText: toAmericanString(american)
  };
}

function toIso(ms) {
  return new Date(ms).toISOString();
}

function buildOddsUrl(pathname, params) {
  const url = new URL(`https://api.the-odds-api.com${pathname}`);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed ${response.status}: ${text}`);
  }
  return await response.json();
}

function cacheGet(map, key) {
  const item = map.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    map.delete(key);
    return null;
  }
  return item.value;
}

function cacheSet(map, key, value, ttlMs) {
  map.set(key, {
    value,
    expiresAt: Date.now() + ttlMs
  });
}

function requireOddsKey() {
  return !!ODDS_API_KEY;
}

function requireFantasyNerdsKey() {
  return !!FANTASYNERDS_API_KEY;
}

function findMarket(bookmaker, marketKey) {
  return bookmaker?.markets?.find(m => m?.key === marketKey) || null;
}

function gameMode(commenceTime) {
  const start = new Date(commenceTime).getTime();
  return Date.now() >= start ? "live" : "pregame";
}

function logSnapshot(payload) {
  try {
    fs.appendFileSync(SNAPSHOT_FILE, JSON.stringify(payload) + "\n", "utf8");
  } catch (_) {}
}

function updatePriceHistory(gameId, value) {
  if (!priceHistoryStore[gameId]) {
    priceHistoryStore[gameId] = [];
  }

  priceHistoryStore[gameId].push({
    timestamp: new Date().toISOString(),
    value
  });

  const cutoff = Date.now() - 15 * 60 * 1000;
  priceHistoryStore[gameId] = priceHistoryStore[gameId].filter(point => {
    return new Date(point.timestamp).getTime() >= cutoff;
  });

  return priceHistoryStore[gameId];
}

async function getUpcomingEvents() {
  const cacheKey = "events";
  const cached = cacheGet(currentCache, cacheKey);
  if (cached) return cached;

  const url = buildOddsUrl(`/v4/sports/${SPORT_KEY}/events`, {
    apiKey: ODDS_API_KEY
  });

  const data = await fetchJson(url);
  cacheSet(currentCache, cacheKey, data, CURRENT_TTL_MS);
  return data;
}

async function getEventFeaturedOdds(eventId) {
  const cacheKey = `featured:${eventId}`;
  const cached = cacheGet(currentCache, cacheKey);
  if (cached) return cached;

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
  const cached = cacheGet(currentCache, cacheKey);
  if (cached) return cached;

  const url = buildOddsUrl(`/v4/sports/${SPORT_KEY}/events/${eventId}/odds`, {
    apiKey: ODDS_API_KEY,
    regions: REGIONS,
    markets: PROP_MARKETS,
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
  const cacheKey = `history:${dateIso}`;
  const cached = cacheGet(historicalCache, cacheKey);
  if (cached) return cached;

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

function matchHistoricalEvent(events, homeTeam, awayTeam) {
  return (events || []).find(event =>
    event?.home_team === homeTeam && event?.away_team === awayTeam
  ) || null;
}

function extractMarketSnapshot(eventOdds) {
  const homeProbPairs = [];
  const awayProbPairs = [];
  const homeProbRaw = [];
  const awayProbRaw = [];
  const spreadSignals = [];
  const totalSignals = [];
  const rows = [];

  for (const bookmaker of eventOdds?.bookmakers || []) {
    const weight = getBookWeight(bookmaker?.key || "");
    const h2h = findMarket(bookmaker, "h2h");
    const spreads = findMarket(bookmaker, "spreads");
    const totals = findMarket(bookmaker, "totals");

    let homePrice = null;
    let awayPrice = null;
    let homeSpread = null;
    let awaySpread = null;
    let total = null;

    if (h2h?.outcomes?.length >= 2) {
      const homeOutcome = h2h.outcomes.find(o => o?.name === eventOdds?.home_team);
      const awayOutcome = h2h.outcomes.find(o => o?.name === eventOdds?.away_team);

      if (homeOutcome && awayOutcome) {
        homePrice = homeOutcome.price;
        awayPrice = awayOutcome.price;

        const nv = noVigTwoWayProbPercent(homePrice, awayPrice);
        if (typeof nv.a === "number") {
          homeProbPairs.push({ value: nv.a, weight });
          homeProbRaw.push(nv.a);
        }
        if (typeof nv.b === "number") {
          awayProbPairs.push({ value: nv.b, weight });
          awayProbRaw.push(nv.b);
        }
      }
    }

    if (spreads?.outcomes?.length >= 2) {
      const homeSpreadOutcome = spreads.outcomes.find(o => o?.name === eventOdds?.home_team);
      const awaySpreadOutcome = spreads.outcomes.find(o => o?.name === eventOdds?.away_team);

      if (typeof homeSpreadOutcome?.point === "number") {
        homeSpread = homeSpreadOutcome.point;
        spreadSignals.push({
          value: homeSpread,
          weight
        });
      }

      if (typeof awaySpreadOutcome?.point === "number") {
        awaySpread = awaySpreadOutcome.point;
      }
    }

    if (totals?.outcomes?.length >= 2) {
      const overOutcome = totals.outcomes.find(o => o?.name === "Over");
      if (typeof overOutcome?.point === "number") {
        total = overOutcome.point;
        totalSignals.push({
          value: total,
          weight
        });
      }
    }

    rows.push({
      book: bookmaker?.key || "n/a",
      homeDecimal: round2(homePrice),
      homeAmerican: decimalToAmerican(homePrice),
      awayDecimal: round2(awayPrice),
      awayAmerican: decimalToAmerican(awayPrice),
      homeSpread: round2(homeSpread),
      awaySpread: round2(awaySpread),
      total: round2(total)
    });
  }

  const bestHome = Math.max(...rows.map(r => r.homeDecimal).filter(v => typeof v === "number"), -Infinity);
  const bestAway = Math.max(...rows.map(r => r.awayDecimal).filter(v => typeof v === "number"), -Infinity);
  const avgHome = average(rows.map(r => r.homeDecimal).filter(v => typeof v === "number"));
  const avgAway = average(rows.map(r => r.awayDecimal).filter(v => typeof v === "number"));
  const avgSpread = weightedAverage(spreadSignals);
  const avgTotal = weightedAverage(totalSignals);

  return {
    marketProbabilityHome: round2(weightedAverage(homeProbPairs)),
    marketProbabilityAway: round2(weightedAverage(awayProbPairs)),
    bestHomeDecimal: bestHome === -Infinity ? null : round2(bestHome),
    bestAwayDecimal: bestAway === -Infinity ? null : round2(bestAway),
    avgHomeDecimal: round2(avgHome),
    avgAwayDecimal: round2(avgAway),
    avgHomeSpread: round2(avgSpread),
    avgTotal: round2(avgTotal),
    disagreementPenaltyPercent: round2(
      (() => {
        const hv = variance(homeProbRaw);
        const av = variance(awayProbRaw);
        if (hv === null || av === null) return null;
        return clamp((hv + av) * 10, 0, 3.5);
      })()
    ),
    bookCount: rows.filter(r => typeof r.homeDecimal === "number" && typeof r.awayDecimal === "number").length,
    bookmakerTable: rows
  };
}

function groupPropMarkets(propsEventOdds) {
  const grouped = {};

  for (const bookmaker of propsEventOdds?.bookmakers || []) {
    for (const market of bookmaker?.markets || []) {
      if (!grouped[market.key]) grouped[market.key] = [];

      for (const outcome of market?.outcomes || []) {
        grouped[market.key].push({
          book: bookmaker?.key || "n/a",
          player: outcome?.description || "",
          side: outcome?.name || "",
          line: outcome?.point ?? null,
          decimal: outcome?.price ?? null
        });
      }
    }
  }

  return grouped;
}

function confidenceWord(probabilityPercent) {
  if (typeof probabilityPercent !== "number") return "N/A";
  if (probabilityPercent < 52) return "DON'T";
  if (probabilityPercent < 57) return "Maybe";
  if (probabilityPercent < 65) return "Do";
  return "YES";
}

function confidenceColor(probabilityPercent) {
  if (typeof probabilityPercent !== "number") return "gray";
  if (probabilityPercent < 52) return "red";
  if (probabilityPercent < 57) return "orange";
  if (probabilityPercent < 65) return "gold";
  return "green";
}

function buildPropSections(propsEventOdds) {
  const raw = groupPropMarkets(propsEventOdds);

  const marketToSection = {
    player_points: "points",
    player_assists: "assists",
    player_rebounds: "rebounds",
    player_points_rebounds_assists: "pra"
  };

  const output = {
    points: [],
    assists: [],
    rebounds: [],
    pra: []
  };

  for (const [marketKey, section] of Object.entries(marketToSection)) {
    const rows = raw[marketKey] || [];
    const bucket = {};

    for (const row of rows) {
      const key = `${row.player}__${row.line}`;
      if (!bucket[key]) {
        bucket[key] = {
          player: row.player,
          line: row.line,
          overPrices: [],
          underPrices: []
        };
      }

      if ((row.side || "").toLowerCase() === "over" && typeof row.decimal === "number") {
        bucket[key].overPrices.push(row.decimal);
      }
      if ((row.side || "").toLowerCase() === "under" && typeof row.decimal === "number") {
        bucket[key].underPrices.push(row.decimal);
      }
    }

    output[section] = Object.values(bucket)
      .map(item => {
        const overDecimal = average(item.overPrices);
        const underDecimal = average(item.underPrices);
        const overAmerican = decimalToAmerican(overDecimal);
        const underAmerican = decimalToAmerican(underDecimal);

        let overProb = null;
        let underProb = null;

        if (typeof overDecimal === "number" && typeof underDecimal === "number") {
          const nv = noVigTwoWayProbPercent(overDecimal, underDecimal);
          overProb = nv.a;
          underProb = nv.b;
        }

        let recommendedSide = "N/A";
        let recommendedDecimal = null;
        let recommendedAmerican = null;
        let recommendedChance = null;

        if (typeof overProb === "number" && typeof underProb === "number") {
          if (overProb >= underProb) {
            recommendedSide = "Over";
            recommendedDecimal = overDecimal;
            recommendedAmerican = overAmerican;
            recommendedChance = overProb;
          } else {
            recommendedSide = "Under";
            recommendedDecimal = underDecimal;
            recommendedAmerican = underAmerican;
            recommendedChance = underProb;
          }
        }

        return {
          player: item.player || "N/A",
          line: round2(item.line),
          overDecimal: round2(overDecimal),
          overAmerican,
          underDecimal: round2(underDecimal),
          underAmerican,
          recommendedSide,
          recommendedDecimal: round2(recommendedDecimal),
          recommendedAmerican,
          hitChancePercent: round2(recommendedChance),
          confidenceText: confidenceWord(recommendedChance),
          confidenceColor: confidenceColor(recommendedChance),
          coverage: item.overPrices.length + item.underPrices.length
        };
      })
      .filter(row => row.player && typeof row.line === "number")
      .sort((a, b) => (b.coverage - a.coverage) || ((b.hitChancePercent || 0) - (a.hitChancePercent || 0)))
      .slice(0, 8);
  }

  return output;
}

function buildPlayerImpact(propSections) {
  const allProps = [
    ...(propSections.points || []),
    ...(propSections.assists || []),
    ...(propSections.rebounds || []),
    ...(propSections.pra || [])
  ];

  const playerMap = {};

  for (const row of allProps) {
    const name = (row.player || "").toLowerCase().trim();
    if (!name) continue;

    const strength =
      clamp((row.line || 0) * 0.01, 0, 1.5) +
      clamp(((row.hitChancePercent || 50) - 50) * 0.03, 0, 1.5);

    if (!playerMap[name]) playerMap[name] = 0;
    playerMap[name] += strength;
  }

  return playerMap;
}

function normalizeFantasyRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.Data)) return payload.Data;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.players)) return payload.players;
  if (Array.isArray(payload?.lineups)) return payload.lineups;
  if (Array.isArray(payload?.depthcharts)) return payload.depthcharts;
  return [];
}

async function getFantasyInjuries() {
  if (!requireFantasyNerdsKey()) return { rows: [], available: false };

  const key = "fn-injuries";
  const cached = cacheGet(sideInfoCache, key);
  if (cached) return cached;

  const url = `https://api.fantasynerds.com/v1/nba/injuries?apikey=${encodeURIComponent(FANTASYNERDS_API_KEY)}`;
  const raw = await fetchJson(url);
  const value = { rows: normalizeFantasyRows(raw), available: true };
  cacheSet(sideInfoCache, key, value, SIDEINFO_TTL_MS);
  return value;
}

async function getFantasyLineups() {
  if (!requireFantasyNerdsKey()) return { rows: [], available: false };

  const key = "fn-lineups";
  const cached = cacheGet(sideInfoCache, key);
  if (cached) return cached;

  const url = `https://api.fantasynerds.com/v1/nba/lineups?apikey=${encodeURIComponent(FANTASYNERDS_API_KEY)}`;
  const raw = await fetchJson(url);
  const value = { rows: normalizeFantasyRows(raw), available: true };
  cacheSet(sideInfoCache, key, value, SIDEINFO_TTL_MS);
  return value;
}

async function getFantasyDepth() {
  if (!requireFantasyNerdsKey()) return { rows: [], available: false };

  const key = "fn-depth";
  const cached = cacheGet(sideInfoCache, key);
  if (cached) return cached;

  const url = `https://api.fantasynerds.com/v1/nba/depthcharts?apikey=${encodeURIComponent(FANTASYNERDS_API_KEY)}`;
  const raw = await fetchJson(url);
  const value = { rows: normalizeFantasyRows(raw), available: true };
  cacheSet(sideInfoCache, key, value, SIDEINFO_TTL_MS);
  return value;
}

function textContainsTeam(row, teamName) {
  return JSON.stringify(row || {}).toLowerCase().includes(teamName.toLowerCase()) ||
    JSON.stringify(row || {}).toLowerCase().includes(teamName.split(" ").slice(-1)[0].toLowerCase());
}

function extractPlayerName(row) {
  return (
    row?.PlayerName ||
    row?.Name ||
    row?.player ||
    row?.playername ||
    row?.full_name ||
    "N/A"
  );
}

function injurySeverity(row) {
  const text = JSON.stringify(row || {}).toLowerCase();
  if (text.includes("out")) return 1.0;
  if (text.includes("doubtful")) return 0.8;
  if (text.includes("questionable")) return 0.5;
  if (text.includes("probable")) return 0.2;
  return 0.4;
}

function lineupConfidence(row) {
  const text = JSON.stringify(row || {}).toLowerCase();
  if (text.includes("confirmed")) return 1.0;
  if (text.includes("starting")) return 0.85;
  if (text.includes("projected")) return 0.55;
  return 0.25;
}

function depthRoleWeight(row) {
  const text = JSON.stringify(row || {}).toLowerCase();
  if (text.includes("starter") || text.includes("1st")) return 1.0;
  if (text.includes("2nd")) return 0.6;
  if (text.includes("3rd")) return 0.3;
  return 0.45;
}

function bestPlayerMatchValue(name, playerImpactMap) {
  const key = (name || "").toLowerCase().trim();
  if (!key) return 0;
  if (playerImpactMap[key]) return playerImpactMap[key];

  let best = 0;
  const parts = key.split(" ").filter(Boolean);

  for (const [candidate, value] of Object.entries(playerImpactMap)) {
    const matches = parts.filter(part => candidate.includes(part)).length;
    if (matches >= Math.min(parts.length, 2)) {
      best = Math.max(best, value);
    }
  }

  return best;
}

function summarizeSideInfo(homeTeam, awayTeam, injuriesRows, lineupRows, depthRows, propSections) {
  const playerImpactMap = buildPlayerImpact(propSections);

  const homeInjuries = injuriesRows.filter(row => textContainsTeam(row, homeTeam));
  const awayInjuries = injuriesRows.filter(row => textContainsTeam(row, awayTeam));
  const homeLineups = lineupRows.filter(row => textContainsTeam(row, homeTeam));
  const awayLineups = lineupRows.filter(row => textContainsTeam(row, awayTeam));
  const homeDepth = depthRows.filter(row => textContainsTeam(row, homeTeam));
  const awayDepth = depthRows.filter(row => textContainsTeam(row, awayTeam));

  function teamBreakdown(teamInjuries, teamLineups, teamDepth) {
    let penalty = 0;
    let startersOut = 0;

    for (const injury of teamInjuries) {
      const name = extractPlayerName(injury);
      const severity = injurySeverity(injury);
      const lineupMatch = teamLineups.find(row => JSON.stringify(row).toLowerCase().includes(name.toLowerCase()));
      const depthMatch = teamDepth.find(row => JSON.stringify(row).toLowerCase().includes(name.toLowerCase()));

      const lineWeight = lineupMatch ? lineupConfidence(lineupMatch) : 0;
      const roleWeight = depthMatch ? depthRoleWeight(depthMatch) : (lineupMatch ? 0.85 : 0.45);
      const playerImpact = bestPlayerMatchValue(name, playerImpactMap);

      const playerPenalty =
        0.5 +
        severity * 0.8 +
        roleWeight * 0.8 +
        lineWeight * 0.8 +
        playerImpact * 0.35;

      penalty += playerPenalty;

      if (roleWeight >= 0.8 || lineWeight >= 0.8) {
        startersOut += 1;
      }
    }

    const starterCertaintyRaw = teamLineups.length
      ? clamp(average(teamLineups.map(lineupConfidence)) || 0, 0, 1)
      : 0;

    return {
      penaltyPoints: round2(penalty),
      startersOut,
      starterCertaintyPercent: round2(starterCertaintyRaw * 100)
    };
  }

  const home = teamBreakdown(homeInjuries, homeLineups, homeDepth);
  const away = teamBreakdown(awayInjuries, awayLineups, awayDepth);

  return {
    available: injuriesRows.length > 0 || lineupRows.length > 0 || depthRows.length > 0,
    homeInjuries,
    awayInjuries,
    lineups: [...homeLineups, ...awayLineups],
    homeInjuriesCount: homeInjuries.length,
    awayInjuriesCount: awayInjuries.length,
    homeStartersOut: home.startersOut,
    awayStartersOut: away.startersOut,
    homeStarterCertaintyPercent: home.starterCertaintyPercent,
    awayStarterCertaintyPercent: away.starterCertaintyPercent,
    homePenaltyPoints: home.penaltyPoints,
    awayPenaltyPoints: away.penaltyPoints
  };
}

async function buildHistoricalComparisons(homeTeam, awayTeam) {
  const result = {};

  for (const lookback of HISTORICAL_LOOKBACKS) {
    const iso = toIso(Date.now() - lookback.ms);
    try {
      const snapshot = await getHistoricalSnapshot(iso);
      const matched = matchHistoricalEvent(snapshot?.data || snapshot, homeTeam, awayTeam);
      if (!matched) {
        result[lookback.label] = null;
        continue;
      }

      const extracted = extractMarketSnapshot(matched);
      result[lookback.label] = extracted;
    } catch {
      result[lookback.label] = null;
    }
  }

  return result;
}

function classifyLineMove(currentPercent, oldPercent) {
  if (typeof currentPercent !== "number" || typeof oldPercent !== "number") return "N/A";
  const delta = currentPercent - oldPercent;

  if (Math.abs(delta) < 1) return "Flat";
  if (delta >= 3) return "Steam up";
  if (delta <= -3) return "Steam down";
  if (delta > 0) return "Moving up";
  return "Moving down";
}

function buildMatchupFlags(currentSnapshot) {
  const flags = [];

  if (typeof currentSnapshot?.avgHomeSpread === "number") {
    if (currentSnapshot.avgHomeSpread <= -7) flags.push("Big favorite");
    if (currentSnapshot.avgHomeSpread >= 7) flags.push("Big underdog");
  }

  if (typeof currentSnapshot?.avgTotal === "number") {
    if (currentSnapshot.avgTotal >= 235) flags.push("High total");
    if (currentSnapshot.avgTotal <= 220) flags.push("Low total");
  }

  return flags;
}

function buildConfidenceBreakdown(currentSnapshot, historical, sideInfo, propSections) {
  const market = (() => {
    if (typeof currentSnapshot?.bookCount !== "number") return null;
    return round2(clamp((currentSnapshot.bookCount / 12) * 100, 0, 100));
  })();

  const injury = sideInfo?.available
    ? round2(
        clamp(
          60 +
            ((sideInfo.homeStarterCertaintyPercent || 0) + (sideInfo.awayStarterCertaintyPercent || 0)) * 0.2 -
            ((sideInfo.homeStartersOut || 0) + (sideInfo.awayStartersOut || 0)) * 6,
          0,
          100
        )
      )
    : null;

  const lineup = sideInfo?.available
    ? round2(
        clamp(
          average([
            sideInfo.homeStarterCertaintyPercent,
            sideInfo.awayStarterCertaintyPercent
          ]) || 0,
          0,
          100
        )
      )
    : null;

  const propCount =
    (propSections.points?.length || 0) +
    (propSections.assists?.length || 0) +
    (propSections.rebounds?.length || 0) +
    (propSections.pra?.length || 0);

  const props = round2(clamp(propCount * 8, 0, 100));

  const move =
    historical["15m"] && historical["2h"]
      ? 80
      : historical["2h"] || historical["24h"]
        ? 60
        : 35;

  const rawValues = [market, injury, lineup, props, move].filter(v => typeof v === "number");
  const overall = rawValues.length ? round2(average(rawValues)) : null;

  let label = "N/A";
  if (typeof overall === "number") {
    if (overall >= 75) label = "High";
    else if (overall >= 55) label = "Medium";
    else label = "Low";
  }

  return {
    overallPercent: overall,
    label,
    parts: {
      marketPercent: market,
      injuryPercent: injury,
      lineupPercent: lineup,
      propsPercent: props,
      movementPercent: move
    }
  };
}

function buildDerivedMetrics(currentSnapshot, historical, sideInfo) {
  const currentHomeProb = currentSnapshot.marketProbabilityHome;
  const prob15m = historical["15m"]?.marketProbabilityHome ?? null;
  const prob2h = historical["2h"]?.marketProbabilityHome ?? null;
  const prob24h = historical["24h"]?.marketProbabilityHome ?? null;

  const move15m = typeof currentHomeProb === "number" && typeof prob15m === "number"
    ? round2(currentHomeProb - prob15m)
    : null;
  const move2h = typeof currentHomeProb === "number" && typeof prob2h === "number"
    ? round2(currentHomeProb - prob2h)
    : null;
  const move24h = typeof currentHomeProb === "number" && typeof prob24h === "number"
    ? round2(currentHomeProb - prob24h)
    : null;

  const lineMoveClass = classifyLineMove(currentHomeProb, prob2h);

  const injuryDifference =
    sideInfo?.available
      ? round2((sideInfo.awayPenaltyPoints || 0) - (sideInfo.homePenaltyPoints || 0))
      : null;

  return {
    move15mPercent: move15m,
    move2hPercent: move2h,
    move24hPercent: move24h,
    lineMoveClass,
    injuryDifferencePoints: injuryDifference,
    matchupFlags: buildMatchupFlags(currentSnapshot)
  };
}

function buildSignal(currentSnapshot, confidence, derived) {
  const bestHome = currentSnapshot.bestHomeDecimal;
  const avgHome = currentSnapshot.avgHomeDecimal;

  const bestLineValuePercent =
    typeof bestHome === "number" && typeof avgHome === "number"
      ? round2((decimalToImpliedPercent(avgHome) - decimalToImpliedPercent(bestHome)))
      : null;

  const signalReasons = [];

  if (bestLineValuePercent !== null && bestLineValuePercent > 1) {
    signalReasons.push("Best line beats market average");
  }
  if ((derived.move2hPercent || 0) > 1.5) {
    signalReasons.push("Recent market move up");
  }
  if ((derived.injuryDifferencePoints || 0) > 1) {
    signalReasons.push("Opponent injury burden higher");
  }

  let alert = "N/A";
  if (confidence.label === "High" && signalReasons.length >= 2) {
    alert = "YES";
  } else if (confidence.label === "Medium" && signalReasons.length >= 1) {
    alert = "Do";
  } else if (confidence.label === "Low" && signalReasons.length >= 1) {
    alert = "Maybe";
  } else if (signalReasons.length === 0) {
    alert = "DON'T";
  }

  return {
    alert,
    reasons: signalReasons,
    bestLineValuePercent
  };
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    oddsApiKeyAdded: requireOddsKey(),
    fantasyNerdsKeyAdded: requireFantasyNerdsKey(),
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
        mode: gameMode(event.commence_time)
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

    const [featured, props, injuriesInfo, lineupsInfo, depthInfo] = await Promise.all([
      getEventFeaturedOdds(gameId),
      getEventPlayerProps(gameId),
      getFantasyInjuries(),
      getFantasyLineups(),
      getFantasyDepth()
    ]);

    const currentSnapshot = extractMarketSnapshot(featured);
    if (!currentSnapshot) {
      return res.status(500).json({ error: "No market data available" });
    }

    const propSections = buildPropSections(props);

    const sideInfo = summarizeSideInfo(
      featured.home_team,
      featured.away_team,
      injuriesInfo.rows || [],
      lineupsInfo.rows || [],
      depthInfo.rows || [],
      propSections
    );

    const historical = await buildHistoricalComparisons(
      featured.home_team,
      featured.away_team
    );

    const derived = buildDerivedMetrics(currentSnapshot, historical, sideInfo);
    const confidence = buildConfidenceBreakdown(currentSnapshot, historical, sideInfo, propSections);
    const signal = buildSignal(currentSnapshot, confidence, derived);

    const selectedSide = currentSnapshot.marketProbabilityHome >= currentSnapshot.marketProbabilityAway
      ? "home"
      : "away";

    const selectedOddsDecimal =
      selectedSide === "home"
        ? currentSnapshot.bestHomeDecimal
        : currentSnapshot.bestAwayDecimal;

    const impliedProbability = selectedOddsDecimal
      ? round2(decimalToImpliedPercent(selectedOddsDecimal))
      : null;

    const history = updatePriceHistory(gameId, currentSnapshot.marketProbabilityHome);

    const payload = {
      id: featured.id,
      homeTeam: featured.home_team,
      awayTeam: featured.away_team,
      commenceTime: featured.commence_time,
      gameMode: gameMode(featured.commence_time),

      pick: selectedSide === "home" ? `${featured.home_team} ML` : `${featured.away_team} ML`,

      sportsbookOdds: buildOddsFormatsFromDecimal(selectedOddsDecimal),

      impliedProbabilityPercent: impliedProbability,
      impliedPercentFromOdds: impliedProbability,
      impliedProbabilityFormats: buildProbabilityFormats(impliedProbability),

      trueProbabilityPercent: null,
      trueProbabilityFormats: {
        percent: null,
        american: null,
        americanText: null
      },

      edgePercent: null,

      confidence: {
        label: confidence.label,
        percent: confidence.overallPercent
      },

      confidenceBreakdown: confidence.parts,

      currentMarket: currentSnapshot,
      historical,
      derived,
      signal,

      bookmakerTable: currentSnapshot.bookmakerTable,

      propSections,

      injuryStatus: sideInfo,

      graphHistory: history,

      timestamp: new Date().toISOString()
    };

    logSnapshot({
      gameId,
      timestamp: payload.timestamp,
      gameMode: payload.gameMode,
      pick: payload.pick,
      selectedOddsAmerican: payload.sportsbookOdds.american,
      selectedOddsDecimal: payload.sportsbookOdds.decimal,
      impliedProbabilityPercent: payload.impliedProbabilityPercent,
      move15mPercent: payload.derived.move15mPercent,
      move2hPercent: payload.derived.move2hPercent,
      move24hPercent: payload.derived.move24hPercent,
      lineMoveClass: payload.derived.lineMoveClass,
      alert: payload.signal.alert,
      reasons: payload.signal.reasons,
      confidenceLabel: payload.confidence.label,
      confidencePercent: payload.confidence.percent,
      homeInjuriesCount: payload.injuryStatus.homeInjuriesCount,
      awayInjuriesCount: payload.injuryStatus.awayInjuriesCount
    });

    res.json(payload);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.get("/snapshots", (req, res) => {
  try {
    if (!fs.existsSync(SNAPSHOT_FILE)) {
      return res.json({ snapshots: [] });
    }

    const lines = fs.readFileSync(SNAPSHOT_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-200)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    res.json({ snapshots: lines });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});