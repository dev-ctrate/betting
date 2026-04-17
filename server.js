const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const ODDS_API_KEY = process.env.ODDS_API_KEY || "";

const SPORT_KEY = "basketball_nba";
const REGIONS = "us";
const ODDS_FORMAT = "decimal";
const FEATURED_MARKETS = "h2h,spreads,totals";

const PLAYER_PROP_MARKETS = [
  "player_points",
  "player_rebounds",
  "player_assists",
  "player_points_rebounds_assists",
  "player_threes"
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

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Request failed ${response.status}: ${text}`);
  }
  return await response.json();
}

function buildUrl(pathname, params) {
  const base = `https://api.the-odds-api.com${pathname}`;
  const sp = new URLSearchParams(params);
  return `${base}?${sp.toString()}`;
}

function requireApiKey() {
  return !!ODDS_API_KEY;
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

async function getUpcomingEvents() {
  const cacheKey = "events";
  const hit = cacheGet(currentCache, cacheKey);
  if (hit) return hit;

  const url = buildUrl(`/v4/sports/${SPORT_KEY}/events`, {
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

  const url = buildUrl(`/v4/sports/${SPORT_KEY}/events/${eventId}/odds`, {
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

  const url = buildUrl(`/v4/sports/${SPORT_KEY}/events/${eventId}/odds`, {
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

  const url = buildUrl(`/v4/historical/sports/${SPORT_KEY}/odds`, {
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
    event =>
      event.home_team === homeTeam &&
      event.away_team === awayTeam
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
      homePrice: bookHomePrice,
      awayPrice: bookAwayPrice,
      homeSpread: bookHomeSpread,
      awaySpread: bookAwaySpread,
      total: bookTotal
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
    bookCount: books.filter(b => typeof b.homePrice === "number" && typeof b.awayPrice === "number").length,
    books
  };
}

function extractPropSummary(propsEventOdds) {
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

  const result = [];

  for (const [market, outcomes] of Object.entries(groupedMarkets)) {
    const grouped = {};

    for (const o of outcomes) {
      const key = `${o.player}__${o.side}__${o.point}`;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(o.price);
    }

    const rows = Object.entries(grouped).map(([key, prices]) => {
      const [player, side, point] = key.split("__");
      return {
        market,
        player,
        side,
        point: point === "null" ? null : Number(point),
        avgPrice: average(prices),
        booksCount: prices.length
      };
    });

    rows.sort((a, b) => b.booksCount - a.booksCount);

    result.push({
      market,
      count: rows.length,
      top: rows.slice(0, 8)
    });
  }

  return result;
}

function buildPropSignal(propSummary) {
  if (!propSummary || !propSummary.length) {
    return {
      adj: 0,
      depth: 0
    };
  }

  let strength = 0;
  let observations = 0;

  for (const market of propSummary) {
    for (const row of market.top || []) {
      if (typeof row.point !== "number" || typeof row.avgPrice !== "number") {
        continue;
      }

      const booksBoost = clamp((row.booksCount - 1) * 0.0015, 0, 0.01);
      const priceStrength = clamp((2.2 - row.avgPrice) * 0.01, -0.01, 0.02);
      const pointStrength = clamp(row.point * 0.0006, 0, 0.02);

      strength += booksBoost + priceStrength + pointStrength;
      observations += 1;
    }
  }

  const adj = clamp((strength / Math.max(observations, 1)) * 0.4, 0, 0.01);

  return {
    adj,
    depth: observations
  };
}

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
            homeMarketProb: extracted.homeMarketProb,
            awayMarketProb: extracted.awayMarketProb,
            spreadAdj: extracted.spreadAdj,
            totalConsensus: extracted.totalConsensus,
            avgHomeSpread: extracted.avgHomeSpread,
            avgTotal: extracted.avgTotal
          };
        }
      }
    } catch (err) {
      comparisons[lookback.label] = { error: err.message };
    }
  }

  return comparisons;
}

function buildMode(commenceTime) {
  const startMs = new Date(commenceTime).getTime();
  return Date.now() >= startMs ? "live" : "pregame";
}

function buildConfidence(currentConsensus, historicalComparisons, propSignal) {
  let score = 50;

  score += clamp((currentConsensus.bookCount - 3) * 6, 0, 25);
  score -= clamp(currentConsensus.disagreementPenalty * 800, 0, 22);

  if (historicalComparisons["2h"] && !historicalComparisons["2h"].error) score += 8;
  if (historicalComparisons["24h"] && !historicalComparisons["24h"].error) score += 8;

  score += clamp(propSignal.depth * 0.7, 0, 12);

  score = clamp(score, 0, 100);

  let label = "Low";
  if (score >= 75) label = "High";
  else if (score >= 55) label = "Medium";

  return { score, label };
}

function buildStakeSuggestion(edge, confidenceLabel) {
  if (edge < 0.02) {
    return { tier: "No bet", fraction: 0 };
  }
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
  if (rawEdge < 0.015) {
    return "No edge";
  }

  if (confidence.label === "Low" || disagreementPenalty > 0.025) {
    return "Low confidence";
  }

  if (mode === "live") {
    if (rawEdge >= 0.05 && confidence.score >= 75) return "Bet now";
    if (rawEdge >= 0.025) return "Watch";
    return "Avoid";
  }

  if (rawEdge >= 0.045 && confidence.score >= 70) return "Bet now";
  if (rawEdge >= 0.02) return "Watch";
  return "Avoid";
}

function buildProbabilityModel(currentConsensus, historicalComparisons, propSignal, mode) {
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

  let homeTrueProb =
    homeMarketProb +
    currentConsensus.spreadAdj +
    currentConsensus.totalAdj +
    lineMovementAdj +
    propAdj -
    currentConsensus.disagreementPenalty;

  let awayTrueProb =
    awayMarketProb -
    currentConsensus.spreadAdj -
    currentConsensus.totalAdj -
    lineMovementAdj -
    propAdj -
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
    propAdj
  };
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    apiKeyAdded: requireApiKey(),
    mode: requireApiKey() ? "live" : "mock",
    timestamp: new Date().toISOString()
  });
});

app.get("/games", async (req, res) => {
  try {
    if (!requireApiKey()) {
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
    if (!requireApiKey()) {
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

    const propSummary = extractPropSummary(props);
    const propSignal = buildPropSignal(propSummary);

    const model = buildProbabilityModel(
      currentConsensus,
      historicalComparisons,
      propSignal,
      mode
    );

    const confidence = buildConfidence(
      currentConsensus,
      historicalComparisons,
      propSignal
    );

    const verdict = buildVerdict(
      model.rawEdge,
      confidence,
      mode,
      currentConsensus.disagreementPenalty
    );

    const stake = buildStakeSuggestion(model.rawEdge, confidence.label);

    const pickTeam =
      model.pickSide === "home" ? featured.home_team : featured.away_team;

    const sportsbookOddsDecimal =
      model.pickSide === "home"
        ? currentConsensus.bestHomePrice
        : currentConsensus.bestAwayPrice;

    const pick = `${pickTeam} to win`;
    const timestamp = new Date().toISOString();
    const smoothedEdge = addEdgeHistory(gameId, model.rawEdge, timestamp);

    const snapshot = {
      timestamp,
      mode,
      impliedProbability: model.impliedProbability,
      trueProbability: model.trueProbability,
      edge: smoothedEdge,
      rawEdge: model.rawEdge,
      verdict,
      confidenceScore: confidence.score,
      confidenceLabel: confidence.label,
      bestPrice: sportsbookOddsDecimal,
      pick,
      stakeTier: stake.tier
    };

    logSnapshot(gameId, snapshot);

    res.json({
      id: featured.id,
      homeTeam: featured.home_team,
      awayTeam: featured.away_team,
      commenceTime: featured.commence_time,
      gameMode: mode,
      sportsbookOddsDecimal,
      impliedProbability: model.impliedProbability,
      trueProbability: model.trueProbability,
      edge: smoothedEdge,
      verdict,
      pick,
      confidence,
      stakeSuggestion: stake,
      history: edgeHistoryStore[gameId] || [],
      modelDetails: {
        spreadAdj: currentConsensus.spreadAdj,
        totalConsensus: currentConsensus.totalConsensus,
        totalAdj: currentConsensus.totalAdj,
        disagreementPenalty: currentConsensus.disagreementPenalty,
        lineMovementAdj: model.lineMovementAdj,
        propAdj: model.propAdj,
        avgHomePrice: currentConsensus.avgHomePrice,
        avgAwayPrice: currentConsensus.avgAwayPrice,
        bestHomePrice: currentConsensus.bestHomePrice,
        bestAwayPrice: currentConsensus.bestAwayPrice,
        avgHomeSpread: currentConsensus.avgHomeSpread,
        avgTotal: currentConsensus.avgTotal,
        bookCount: currentConsensus.bookCount,
        historicalComparisons
      },
      bookmakerTable: currentConsensus.books,
      propsSummary: propSummary,
      injuryStatus: {
        available: false,
        note: "No injury/lineup source connected yet"
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
    snapshots: snapshotLogStore[gameId] || []
  });
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});