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
const CURRENT_TTL_MS = 25 * 1000;
const HISTORICAL_TTL_MS = 30 * 60 * 1000;

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
    const previousEdge = edgeHistoryStore[gameId][edgeHistoryStore[gameId].length - 1].edge;
    smoothedEdge = previousEdge * 0.55 + edge * 0.45;
  }

  edgeHistoryStore[gameId].push({
    timestamp,
    edge: smoothedEdge
  });

  trimEdgeHistory(gameId);
  return smoothedEdge;
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
  const allHomePrices = [];
  const allAwayPrices = [];

  for (const bookmaker of eventOdds.bookmakers || []) {
    const weight = getBookWeight(bookmaker.key || "");
    const h2h = findMarket(bookmaker, "h2h");
    const spreads = findMarket(bookmaker, "spreads");
    const totals = findMarket(bookmaker, "totals");

    if (h2h?.outcomes?.length >= 2) {
      const homeOutcome = h2h.outcomes.find(o => o.name === eventOdds.home_team);
      const awayOutcome = h2h.outcomes.find(o => o.name === eventOdds.away_team);

      if (homeOutcome && awayOutcome) {
        allHomePrices.push(homeOutcome.price);
        allAwayPrices.push(awayOutcome.price);

        const nv = noVigTwoWayProb(homeOutcome.price, awayOutcome.price);
        homeProbPairs.push({ value: nv.a, weight });
        awayProbPairs.push({ value: nv.b, weight });
        homeProbRaw.push(nv.a);
        awayProbRaw.push(nv.b);
      }
    }

    if (spreads?.outcomes?.length >= 2) {
      const homeSpread = spreads.outcomes.find(o => o.name === eventOdds.home_team);
      if (homeSpread && typeof homeSpread.point === "number") {
        spreadSignals.push({
          value: clamp((-homeSpread.point) * 0.0105, -0.10, 0.10),
          weight
        });
      }
    }

    if (totals?.outcomes?.length >= 2) {
      const over = totals.outcomes.find(o => o.name === "Over");
      if (over && typeof over.point === "number") {
        totalSignals.push({
          value: over.point,
          weight
        });
      }
    }
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

  return {
    homeMarketProb,
    awayMarketProb,
    spreadAdj,
    totalConsensus,
    totalAdj,
    disagreementPenalty,
    bestHomePrice: Math.max(...allHomePrices),
    bestAwayPrice: Math.max(...allAwayPrices),
    avgHomePrice: average(allHomePrices),
    avgAwayPrice: average(allAwayPrices)
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

function buildPropTeamSignal(propSummary, homeTeam, awayTeam) {
  if (!propSummary || !propSummary.length) {
    return {
      homeAdj: 0,
      awayAdj: 0
    };
  }

  let homeStrength = 0;
  let awayStrength = 0;

  for (const market of propSummary) {
    for (const row of market.top || []) {
      if (!row.player || typeof row.point !== "number" || typeof row.avgPrice !== "number") {
        continue;
      }

      // Simple proxy:
      // If many books support a higher prop line at lower price, player is viewed stronger.
      const booksBoost = clamp((row.booksCount - 1) * 0.0015, 0, 0.01);
      const priceStrength = clamp((2.2 - row.avgPrice) * 0.01, -0.01, 0.02);
      const pointStrength = clamp(row.point * 0.0008, 0, 0.02);

      const strength = booksBoost + priceStrength + pointStrength;

      // Very light team assignment heuristic based on selected event teams:
      // We only use player props as a general strength pool and split it by side name presence if possible.
      const playerName = row.player.toLowerCase();

      if (
        playerName.includes(homeTeam.split(" ").slice(-1)[0].toLowerCase()) ||
        false
      ) {
        homeStrength += strength;
      } else if (
        playerName.includes(awayTeam.split(" ").slice(-1)[0].toLowerCase()) ||
        false
      ) {
        awayStrength += strength;
      }
    }
  }

  // Since player name doesn't include team reliably, keep this conservative.
  return {
    homeAdj: clamp(homeStrength, 0, 0.01),
    awayAdj: clamp(awayStrength, 0, 0.01)
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
            totalConsensus: extracted.totalConsensus
          };
        }
      }
    } catch (err) {
      comparisons[lookback.label] = {
        error: err.message
      };
    }
  }

  return comparisons;
}

function buildProbabilityModel(currentConsensus, historicalComparisons, propSignal) {
  const homeMarketProb = currentConsensus.homeMarketProb;
  const awayMarketProb = currentConsensus.awayMarketProb;

  let lineMovementAdj = 0;

  const h24 = historicalComparisons["24h"];
  const h2 = historicalComparisons["2h"];

  if (h24 && typeof h24.homeMarketProb === "number") {
    const delta24 = homeMarketProb - h24.homeMarketProb;
    lineMovementAdj += clamp(delta24 * 0.50, -0.03, 0.03);
  }

  if (h2 && typeof h2.homeMarketProb === "number") {
    const delta2 = homeMarketProb - h2.homeMarketProb;
    lineMovementAdj += clamp(delta2 * 0.85, -0.025, 0.025);
  }

  // Keep prop signal light so it doesn't overpower the market.
  const propAdj = clamp((propSignal.homeAdj - propSignal.awayAdj), -0.01, 0.01);

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

  let verdict = "Avoid";
  if (rawEdge >= 0.05) {
    verdict = "Bet now";
  } else if (rawEdge >= 0.02) {
    verdict = "Watch";
  }

  return {
    pickSide,
    impliedProbability,
    trueProbability,
    rawEdge,
    verdict,
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
        commenceTime: event.commence_time
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

    const historicalComparisons = await buildHistoricalComparisons(
      featured.home_team,
      featured.away_team
    );

    const propSummary = extractPropSummary(props);
    const propSignal = buildPropTeamSignal(
      propSummary,
      featured.home_team,
      featured.away_team
    );

    const model = buildProbabilityModel(
      currentConsensus,
      historicalComparisons,
      propSignal
    );

    const pickTeam =
      model.pickSide === "home" ? featured.home_team : featured.away_team;

    const sportsbookOddsDecimal =
      model.pickSide === "home"
        ? currentConsensus.bestHomePrice
        : currentConsensus.bestAwayPrice;

    const pick = `${pickTeam} to win`;

    const smoothedEdge = addEdgeHistory(
      gameId,
      model.rawEdge,
      new Date().toISOString()
    );

    res.json({
      id: featured.id,
      homeTeam: featured.home_team,
      awayTeam: featured.away_team,
      commenceTime: featured.commence_time,
      sportsbookOddsDecimal,
      impliedProbability: model.impliedProbability,
      trueProbability: model.trueProbability,
      edge: smoothedEdge,
      verdict: model.verdict,
      pick,
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
        historicalComparisons
      },
      propsSummary: propSummary,
      timestamp: new Date().toISOString()
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