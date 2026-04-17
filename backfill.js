const learning = require("./learning");

const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY || "";

const SPORT_KEY = "basketball_nba";
const REGIONS = "us";
const ODDS_FORMAT = "decimal";
const FEATURED_MARKETS = "h2h,spreads,totals";

if (!ODDS_API_KEY) {
  throw new Error("Missing ODDS_API_KEY");
}

if (!BALLDONTLIE_API_KEY) {
  throw new Error("Missing BALLDONTLIE_API_KEY");
}

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

function getBookWeight(bookKey) {
  const sharpBooks = ["pinnacle", "circasports", "matchbook"];
  const strongBooks = ["draftkings", "fanduel", "betmgm", "betrivers"];
  if (sharpBooks.includes(bookKey)) return 1.4;
  if (strongBooks.includes(bookKey)) return 1.15;
  return 1.0;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

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
  } finally {
    clearTimeout(timeout);
  }
}

function buildOddsUrl(pathname, params) {
  const base = `https://api.the-odds-api.com${pathname}`;
  const sp = new URLSearchParams(params);
  return `${base}?${sp.toString()}`;
}

function toYmd(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function addDays(ymd, days) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toYmd(d);
}

function getSeasonFromDate(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  return month >= 10 ? year : year - 1;
}

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function namesMatch(a, b) {
  return normalizeName(a) === normalizeName(b);
}

function decimalToAmerican(decimalOdds) {
  if (typeof decimalOdds !== "number" || decimalOdds <= 1) return null;
  if (decimalOdds >= 2) return Math.round((decimalOdds - 1) * 100);
  return Math.round(-100 / (decimalOdds - 1));
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
        totalSignals.push({ value: over.point, weight });
      }
    }

    books.push({
      book: bookmaker.key,
      homePrice: bookHomePrice,
      awayPrice: bookAwayPrice,
      homeSpread: bookHomeSpread,
      awaySpread: bookAwaySpread,
      total: bookTotal,
      homeDecimal: bookHomePrice,
      homeAmerican: decimalToAmerican(bookHomePrice),
      awayDecimal: bookAwayPrice,
      awayAmerican: decimalToAmerican(bookAwayPrice)
    });
  }

  if (!homeProbPairs.length || !awayProbPairs.length) return null;

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

function buildSimpleHistoricalModel(consensus) {
  const homeMarketProb = consensus.homeMarketProb;
  const awayMarketProb = consensus.awayMarketProb;

  let homeTrueProb =
    homeMarketProb +
    consensus.spreadAdj +
    consensus.totalAdj -
    consensus.disagreementPenalty;

  let awayTrueProb =
    awayMarketProb -
    consensus.spreadAdj -
    consensus.totalAdj -
    consensus.disagreementPenalty;

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
    lineMovementAdj: 0,
    propAdj: 0,
    injuryAdjHome: 0
  };
}

async function getHistoricalOddsSnapshot(dateIso) {
  const url = buildOddsUrl(`/v4/historical/sports/${SPORT_KEY}/odds`, {
    apiKey: ODDS_API_KEY,
    regions: REGIONS,
    markets: FEATURED_MARKETS,
    oddsFormat: ODDS_FORMAT,
    date: dateIso
  });

  return fetchJson(url);
}

async function getBalldontlieGamesForDate(ymd) {
  const season = getSeasonFromDate(ymd);
  const url = `https://api.balldontlie.io/v1/games?dates[]=${encodeURIComponent(ymd)}&seasons[]=${season}&per_page=100`;

  const raw = await fetchJson(url, {
    headers: {
      Authorization: BALLDONTLIE_API_KEY
    }
  });

  return Array.isArray(raw?.data) ? raw.data : [];
}

function findHistoricalOddsEvent(oddsEvents, game) {
  return (oddsEvents || []).find(event => {
    return (
      namesMatch(event.home_team, game.home_team?.full_name) &&
      namesMatch(event.away_team, game.visitor_team?.full_name)
    );
  }) || null;
}

function deriveFinalWinner(game) {
  const homeScore = game.home_team_score;
  const awayScore = game.visitor_team_score;

  if (typeof homeScore !== "number" || typeof awayScore !== "number") return null;
  if (homeScore === awayScore) return null;

  return homeScore > awayScore ? "home" : "away";
}

function isFinalGame(game) {
  const status = String(game.status || "").toLowerCase();
  return status.includes("final");
}

async function backfillDate(ymd) {
  console.log(`Backfilling ${ymd}...`);

  const games = await getBalldontlieGamesForDate(ymd);
  const finalGames = games.filter(isFinalGame);

  if (!finalGames.length) {
    console.log(`  No final games for ${ymd}`);
    return { date: ymd, added: 0, skipped: 0 };
  }

  const snapshotIso = `${ymd}T16:00:00Z`;
  const historical = await getHistoricalOddsSnapshot(snapshotIso);
  const oddsEvents = historical?.data || historical || [];

  let added = 0;
  let skipped = 0;

  for (const game of finalGames) {
    const oddsEvent = findHistoricalOddsEvent(oddsEvents, game);

    if (!oddsEvent) {
      skipped += 1;
      continue;
    }

    const consensus = extractFeaturedConsensus(oddsEvent);
    if (!consensus) {
      skipped += 1;
      continue;
    }

    const model = buildSimpleHistoricalModel(consensus);
    const finalWinner = deriveFinalWinner(game);

    if (!finalWinner) {
      skipped += 1;
      continue;
    }

    const pickTeam =
      model.pickSide === "home"
        ? game.home_team?.full_name || oddsEvent.home_team
        : game.visitor_team?.full_name || oddsEvent.away_team;

    const chosenDecimal =
      model.pickSide === "home"
        ? consensus.bestHomePrice
        : consensus.bestAwayPrice;

    learning.upsertBackfillRow({
      gameId: String(game.id),
      timestamp: new Date().toISOString(),
      commenceTime: game.datetime || null,
      homeTeam: game.home_team?.full_name || oddsEvent.home_team,
      awayTeam: game.visitor_team?.full_name || oddsEvent.away_team,
      pickSide: model.pickSide,
      pickTeam,
      impliedProbability: roundToTwo(model.impliedProbability),
      trueProbability: roundToTwo(model.trueProbability),
      calibratedProbability: null,
      rawEdge: roundToTwo(model.rawEdge),
      calibratedEdge: null,
      sportsbookDecimal: chosenDecimal,
      verdict: "",
      confidenceLabel: "",
      confidencePercent: null,
      spreadAdj: roundToTwo(consensus.spreadAdj),
      totalAdj: roundToTwo(consensus.totalAdj),
      lineMovementAdj: 0,
      propAdj: 0,
      injuryAdjHome: 0,
      disagreementPenalty: roundToTwo(consensus.disagreementPenalty),
      avgHomeSpread: roundToTwo(consensus.avgHomeSpread),
      avgTotal: roundToTwo(consensus.avgTotal),
      bookCount: consensus.bookCount,
      result: {
        finalWinner,
        modelWon: model.pickSide === finalWinner,
        finalHomeScore: game.home_team_score,
        finalAwayScore: game.visitor_team_score,
        gradedAt: new Date().toISOString()
      }
    });

    added += 1;
  }

  console.log(`  Added ${added}, skipped ${skipped}`);
  return { date: ymd, added, skipped };
}

async function main() {
  const start = process.argv[2];
  const end = process.argv[3];

  if (!start || !end) {
    throw new Error("Usage: node backfill.js 2025-10-01 2025-10-31");
  }

  let current = start;
  let totalAdded = 0;
  let totalSkipped = 0;

  while (current <= end) {
    try {
      const result = await backfillDate(current);
      totalAdded += result.added;
      totalSkipped += result.skipped;
    } catch (err) {
      console.error(`Failed on ${current}:`, err.message);
    }

    current = addDays(current, 1);
  }

  const calibration = learning.buildCalibrationTable();
  const summary = learning.getLearningSummary();

  console.log("Backfill complete.");
  console.log({
    totalAdded,
    totalSkipped,
    calibrationBuckets: Object.keys(calibration).length,
    summary
  });
}

main().catch(err => {
  console.error("Backfill failed:", err);
  process.exit(1);
});