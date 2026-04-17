const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ===== REQUIRED ENV VAR =====
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";

// ===== CONFIG =====
const SPORT_KEY = "basketball_nba";
const REGIONS = "us";
const ODDS_FORMAT = "decimal";
const FEATURED_MARKETS = "h2h,spreads,totals";

// Keep prop markets limited or your usage will explode.
// You can trim or expand this list later.
const PLAYER_PROP_MARKETS = [
  "player_points",
  "player_rebounds",
  "player_assists",
  "player_points_rebounds_assists",
  "player_threes"
].join(",");

// Historical snapshots to compare against current line.
// These are expensive, so we cache them heavily.
const HISTORICAL_LOOKBACKS = [
  { label: "2h", ms: 2 * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 }
];

// Cache current game summaries briefly, historical snapshots longer.
const currentCache = new Map();
const historicalCache = new Map();
const CURRENT_TTL_MS = 25 * 1000;
const HISTORICAL_TTL_MS = 30 * 60 * 1000;

// ===== BASIC HELPERS =====
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
  // You can tune these later.
  const sharpBooks = ["pinnacle", "circasports", "matchbook"];
  const solidBooks = ["draftkings", "fanduel", "betmgm", "betrivers"];

  if (sharpBooks.includes(bookKey)) return 1.35;
  if (solidBooks.includes(bookKey)) return 1.12;
  return 1.0;
}

function toIso(dateMs) {
  return new Date(dateMs).toISOString();
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

function makeUiGameId(game) {
  return game.id;
}

function findMarket(bookmaker, marketKey) {
  return bookmaker.markets?.find(m => m.key === marketKey) || null;
}

function extractFeaturedConsensus(eventOdds) {
  const homeProbPairs = [];
  const awayProbPairs = [];
  const homeProbRaw = [];
  const awayProbRaw = [];
  const spreadSignals = [];
  const totalSignals = [];
  const displayedMoneylines = [];

  for (const bookmaker of eventOdds.bookmakers || []) {
    const weight = getBookWeight(bookmaker.key || "");
    const h2h = findMarket(bookmaker, "h2h");
    const spreads = findMarket(bookmaker, "spreads");
    const totals = findMarket(bookmaker, "totals");

    if (h2h?.outcomes?.length >= 2) {
      const homeOutcome = h2h.outcomes.find(o => o.name === eventOdds.home_team);
      const awayOutcome = h2h.outcomes.find(o => o.name === eventOdds.away_team);

      if (homeOutcome && awayOutcome) {
        displayedMoneylines.push({
          book: bookmaker.key,
          home: homeOutcome.price,
          away: awayOutcome.price
        });

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
        // More negative spread = stronger home team.
        const spreadAdj = clamp((-homeSpread.point) * 0.010, -0.08, 0.08);
        spreadSignals.push({ value: spreadAdj, weight });
      }
    }

    if (totals?.outcomes?.length >= 2) {
      const over = totals.outcomes.find(o => o.name === "Over");
      if (over && typeof over.point === "number") {
        totalSignals.push({ value: over.point, weight });
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
  if (totalConsensus < 220) totalAdj = 0.004;
  if (totalConsensus > 235) totalAdj = -0.004;

  const disagreementPenalty = clamp(
    (variance(homeProbRaw) + variance(awayProbRaw)) * 8,
    0,
    0.03
  );

  return {
    homeMarketProb,
    awayMarketProb,
    spreadAdj,
    totalConsensus,
    totalAdj,
    disagreementPenalty,
    displayedMoneylines
  };
}

function matchHistoricalEvent(snapshotEvents, homeTeam, awayTeam) {
  return (snapshotEvents || []).find(
    event =>
      event.home_team === homeTeam &&
      event.away_team === awayTeam
  ) || null;
}

function extractPropSummary(propsEventOdds) {
  const byMarket = {};

  for (const bookmaker of propsEventOdds.bookmakers || []) {
    for (const market of bookmaker.markets || []) {
      if (!byMarket[market.key]) {
        byMarket[market.key] = [];
      }

      for (const outcome of market.outcomes || []) {
        // outcome.description is commonly player name on prop markets.
        byMarket[market.key].push({
          book: bookmaker.key,
          description: outcome.description || "",
          name: outcome.name || "",
          point: outcome.point ?? null,
          price: outcome.price ?? null
        });
      }
    }
  }

  const summaries = [];

  for (const [marketKey, outcomes] of Object.entries(byMarket)) {
    // Group by player + point + side (Over/Under)
    const grouped = {};

    for (const o of outcomes) {
      const player = o.description || "Unknown";
      const side = o.name || "";
      const point = o.point ?? "";
      const key = `${player}__${side}__${point}`;

      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(o.price);
    }

    const rows = Object.entries(grouped).map(([key, prices]) => {
      const [player, side, point] = key.split("__");
      return {
        market: marketKey,
        player,
        side,
        point: point === "" ? null : Number(point),
        avgPrice: average(prices),
        booksCount: prices.length
      };
    });

    // Keep strongest / most-covered lines first.
    rows.sort((a, b) => b.booksCount - a.booksCount);

    summaries.push({
      market: marketKey,
      count: rows.length,
      top: rows.slice(0, 8)
    });
  }

  return summaries;
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
  } catch (err) {
    // Props coverage can be incomplete; don't kill the whole response.
    return { bookmakers: [] };
  }
}

async function getHistoricalSnapshot(dateIso) {
  const cacheKey = `hist-sport:${dateIso}`;
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

function buildProbabilityModel(currentConsensus, historicalComparisons, homeTeam, awayTeam) {
  const homeMarketProb = currentConsensus.homeMarketProb;
  const awayMarketProb = currentConsensus.awayMarketProb;

  let lineMovementAdj = 0;

  // Use 24h and 2h snapshots if available.
  const h24 = historicalComparisons["24h"];
  const h2 = historicalComparisons["2h"];

  if (h24 && typeof h24.homeMarketProb === "number") {
    const delta24 = homeMarketProb - h24.homeMarketProb;
    lineMovementAdj += clamp(delta24 * 0.60, -0.035, 0.035);
  }

  if (h2 && typeof h2.homeMarketProb === "number") {
    const delta2 = homeMarketProb - h2.homeMarketProb;
    lineMovementAdj += clamp(delta2 * 0.85, -0.030, 0.030);
  }

  // Spread + total + line movement - disagreement.
  let homeTrueProb =
    homeMarketProb +
    currentConsensus.spreadAdj +
    currentConsensus.totalAdj +
    lineMovementAdj -
    currentConsensus.disagreementPenalty;

  let awayTrueProb =
    awayMarketProb -
    currentConsensus.spreadAdj -
    currentConsensus.totalAdj -
    lineMovementAdj -
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
  const edge = pickSide === "home" ? homeEdge : awayEdge;
  const pick = pickSide === "home" ? `${homeTeam} to win` : `${awayTeam} to win`;

  let verdict = "Avoid";
  if (edge >= 0.04) {
    verdict = "Bet now";
  } else if (edge >= 0.015) {
    verdict = "Watch";
  }

  return {
    impliedProbability,
    trueProbability,
    edge,
    pick,
    verdict,
    lineMovementAdj,
    pickSide
  };
}

// ===== ROUTES =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    apiKeyAdded: requireApiKey(),
    sport: SPORT_KEY,
    timestamp: new Date().toISOString()
  });
});

app.get("/games", async (req, res) => {
  try {
    if (!requireApiKey()) {
      return res.status(400).json({
        error: "Missing ODDS_API_KEY"
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
        id: makeUiGameId(event),
        label: `${event.away_team} @ ${event.home_team}`,
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        commenceTime: event.commence_time
      }));

    res.json({
      games
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.get("/odds", async (req, res) => {
  try {
    if (!requireApiKey()) {
      return res.status(400).json({
        error: "Missing ODDS_API_KEY"
      });
    }

    const gameId = req.query.gameId;
    if (!gameId) {
      return res.status(400).json({
        error: "Missing gameId query parameter"
      });
    }

    const featured = await getEventFeaturedOdds(gameId);
    const props = await getEventPlayerProps(gameId);

    const currentConsensus = extractFeaturedConsensus(featured);
    if (!currentConsensus) {
      return res.status(500).json({
        error: "Could not extract featured odds consensus for event"
      });
    }

    const historicalComparisons = await buildHistoricalComparisons(
      featured.home_team,
      featured.away_team
    );

    const model = buildProbabilityModel(
      currentConsensus,
      historicalComparisons,
      featured.home_team,
      featured.away_team
    );

    const propSummary = extractPropSummary(props);

    // Choose displayed odds from first bookmaker for selected side
    let sportsbookOddsDecimal = null;
    const firstBookH2H = featured.bookmakers?.[0]?.markets?.find(m => m.key === "h2h");
    if (firstBookH2H?.outcomes?.length >= 2) {
      const chosen = firstBookH2H.outcomes.find(o =>
        o.name === (model.pickSide === "home" ? featured.home_team : featured.away_team)
      );
      if (chosen) sportsbookOddsDecimal = chosen.price;
    }

    res.json({
      id: featured.id,
      sport: featured.sport_key,
      homeTeam: featured.home_team,
      awayTeam: featured.away_team,
      commenceTime: featured.commence_time,
      sportsbookOddsDecimal,
      impliedProbability: model.impliedProbability,
      trueProbability: model.trueProbability,
      edge: model.edge,
      verdict: model.verdict,
      pick: model.pick,
      modelDetails: {
        spreadAdj: currentConsensus.spreadAdj,
        totalConsensus: currentConsensus.totalConsensus,
        totalAdj: currentConsensus.totalAdj,
        disagreementPenalty: currentConsensus.disagreementPenalty,
        lineMovementAdj: model.lineMovementAdj,
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

// Optional light endpoint for recent scores (The Odds API supports scores).
app.get("/scores", async (req, res) => {
  try {
    if (!requireApiKey()) {
      return res.status(400).json({
        error: "Missing ODDS_API_KEY"
      });
    }

    const url = buildUrl(`/v4/sports/${SPORT_KEY}/scores/`, {
      apiKey: ODDS_API_KEY,
      daysFrom: "3"
    });

    const data = await fetchJson(url);
    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});