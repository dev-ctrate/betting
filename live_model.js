function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function roundToTwo(num) {
  if (typeof num !== "number" || !Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function average(values) {
  if (!Array.isArray(values) || !values.length) return null;
  const nums = values.filter(v => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function variance(values) {
  if (!Array.isArray(values) || !values.length) return 0;
  const avg = average(values);
  if (avg == null) return 0;
  const nums = values.filter(v => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return 0;
  return nums.reduce((sum, v) => sum + (v - avg) ** 2, 0) / nums.length;
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
  if (typeof decimalOdds !== "number" || !Number.isFinite(decimalOdds) || decimalOdds <= 1) {
    return null;
  }
  if (decimalOdds >= 2) return Math.round((decimalOdds - 1) * 100);
  return Math.round(-100 / (decimalOdds - 1));
}

function probabilityToDecimal(probability) {
  if (
    typeof probability !== "number" ||
    !Number.isFinite(probability) ||
    probability <= 0 ||
    probability >= 1
  ) {
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

  if (sharpBooks.includes(bookKey)) return 1.45;
  if (strongBooks.includes(bookKey)) return 1.15;
  return 1.0;
}

function findMarket(bookmaker, marketKey) {
  return bookmaker?.markets?.find(m => m.key === marketKey) || null;
}

function extractLiveMarketConsensus(eventOdds) {
  const homeProbPairs = [];
  const awayProbPairs = [];
  const homeProbRaw = [];
  const awayProbRaw = [];
  const spreadSignals = [];
  const totalSignals = [];
  const books = [];

  for (const bookmaker of eventOdds?.bookmakers || []) {
    const weight = getBookWeight(bookmaker.key || "");
    const h2h = findMarket(bookmaker, "h2h");
    const spreads = findMarket(bookmaker, "spreads");
    const totals = findMarket(bookmaker, "totals");

    let homePrice = null;
    let awayPrice = null;
    let homeSpread = null;
    let awaySpread = null;
    let total = null;

    if (h2h?.outcomes?.length >= 2) {
      const homeOutcome = h2h.outcomes.find(o => o.name === eventOdds.home_team);
      const awayOutcome = h2h.outcomes.find(o => o.name === eventOdds.away_team);

      if (homeOutcome && awayOutcome) {
        homePrice = homeOutcome.price;
        awayPrice = awayOutcome.price;

        const nv = noVigTwoWayProb(homeOutcome.price, awayOutcome.price);
        homeProbPairs.push({ value: nv.a, weight });
        awayProbPairs.push({ value: nv.b, weight });
        homeProbRaw.push(nv.a);
        awayProbRaw.push(nv.b);
      }
    }

    if (spreads?.outcomes?.length >= 2) {
      const homeSpreadOutcome = spreads.outcomes.find(o => o.name === eventOdds.home_team);
      const awaySpreadOutcome = spreads.outcomes.find(o => o.name === eventOdds.away_team);

      if (homeSpreadOutcome && typeof homeSpreadOutcome.point === "number") {
        homeSpread = homeSpreadOutcome.point;
        spreadSignals.push({
          value: clamp((-homeSpreadOutcome.point) * 0.0105, -0.16, 0.16),
          weight
        });
      }

      if (awaySpreadOutcome && typeof awaySpreadOutcome.point === "number") {
        awaySpread = awaySpreadOutcome.point;
      }
    }

    if (totals?.outcomes?.length >= 2) {
      const over = totals.outcomes.find(o => o.name === "Over");
      if (over && typeof over.point === "number") {
        total = over.point;
        totalSignals.push({ value: over.point, weight });
      }
    }

    books.push({
      book: bookmaker.key,
      homePrice,
      awayPrice,
      homeSpread,
      awaySpread,
      total,
      homeDecimal: homePrice,
      homeAmerican: decimalToAmerican(homePrice),
      awayDecimal: awayPrice,
      awayAmerican: decimalToAmerican(awayPrice)
    });
  }

  if (!homeProbPairs.length || !awayProbPairs.length) return null;

  const homeMarketProb = homeProbPairs.reduce((s, x) => s + x.value * x.weight, 0) /
    homeProbPairs.reduce((s, x) => s + x.weight, 0);

  const awayMarketProb = awayProbPairs.reduce((s, x) => s + x.value * x.weight, 0) /
    awayProbPairs.reduce((s, x) => s + x.weight, 0);

  const spreadAdj = spreadSignals.length
    ? spreadSignals.reduce((s, x) => s + x.value * x.weight, 0) / spreadSignals.reduce((s, x) => s + x.weight, 0)
    : 0;

  const totalConsensus = totalSignals.length
    ? totalSignals.reduce((s, x) => s + x.value * x.weight, 0) / totalSignals.reduce((s, x) => s + x.weight, 0)
    : 0;

  let totalAdj = 0;
  if (
    typeof totalConsensus === "number" &&
    Number.isFinite(totalConsensus)
  ) {
    if (totalConsensus < 216) totalAdj = 0.006;
    else if (totalConsensus > 238) totalAdj = -0.006;
  }

  const disagreementPenalty = clamp(
    (variance(homeProbRaw) + variance(awayProbRaw)) * 12,
    0,
    0.05
  );

  const homePrices = books.map(b => b.homePrice).filter(v => typeof v === "number");
  const awayPrices = books.map(b => b.awayPrice).filter(v => typeof v === "number");
  const homeSpreads = books.map(b => b.homeSpread).filter(v => typeof v === "number");
  const totals = books.map(b => b.total).filter(v => typeof v === "number");

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

function estimateTotalGameSeconds(period) {
  const p = safeNumber(period, 1);
  if (p <= 4) return 48 * 60;
  return 48 * 60 + (p - 4) * 5 * 60;
}

function estimateElapsedSeconds(period, clockSec) {
  const p = Math.max(1, Math.floor(safeNumber(period, 1)));
  const quarterLength = p <= 4 ? 12 * 60 : 5 * 60;
  const completed = p <= 4
    ? (p - 1) * 12 * 60
    : 48 * 60 + (p - 5) * 5 * 60;
  return completed + clamp(quarterLength - safeNumber(clockSec, quarterLength), 0, quarterLength);
}

function buildConfidence(currentConsensus, scoreState, liveFound) {
  let score = 52;
  score
