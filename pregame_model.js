function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function roundToTwo(num) {
  if (typeof num !== "number" || !Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
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

  if (sharpBooks.includes(bookKey)) return 1.4;
  if (strongBooks.includes(bookKey)) return 1.15;
  return 1.0;
}

function findMarket(bookmaker, marketKey) {
  return bookmaker?.markets?.find(m => m.key === marketKey) || null;
}

function extractPregameConsensus(eventOdds) {
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
          value: clamp((-homeSpreadOutcome.point) * 0.0105, -0.10, 0.10),
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

function buildConfidence(currentConsensus, historicalComparisons, propSignal, injurySummary) {
  let score = 50;

  score += clamp((currentConsensus.bookCount - 3) * 6, 0, 25);
  score -= clamp(currentConsensus.disagreementPenalty * 800, 0, 22);

  const h24 = historicalComparisons?.["24h"];
  const h2 = historicalComparisons?.["2h"];

  if (h24 && typeof h24.homeMarketProb === "number") score += 6;
  if (h2 && typeof h2.homeMarketProb === "number") score += 6;

  score += clamp((propSignal?.depth || 0) * 0.6, 0, 10);

  if (injurySummary?.available) {
    score += 4;
    score += clamp((injurySummary.lineupRowsCount || 0) * 0.4, 0, 8);
  }

  score = clamp(score, 1, 99);

  let label = "Low";
  if (score >= 75) label = "High";
  else if (score >= 60) label = "Medium";

  return {
    percent: score / 100,
    label
  };
}

function buildVerdict(rawEdge, confidence, noBetFilter) {
  if (noBetFilter.blocked) return "Avoid";
  if (rawEdge >= 0.045 && confidence.percent >= 0.72) return "Bet now";
  if (rawEdge >= 0.02) return "Watch";
  return "Avoid";
}

function buildStakeSuggestion(rawEdge, confidence, noBetFilter) {
  if (noBetFilter.blocked) return "No bet";
  if (rawEdge >= 0.06 && confidence.percent >= 0.78) return "1.5u";
  if (rawEdge >= 0.04 && confidence.percent >= 0.72) return "1u";
  if (rawEdge >= 0.02) return "0.5u";
  return "No bet";
}

function buildElitePregameModel({
  featuredOdds,
  historicalComparisons = {},
  propSignal = { adj: 0, depth: 0 },
  injurySummary = { available: false },
  calibrationFn = null
}) {
  const currentConsensus = extractPregameConsensus(featuredOdds);
  if (!currentConsensus) {
    throw new Error("Could not extract pregame consensus from featured odds.");
  }

  let lineMovementAdj = 0;
  const h24 = historicalComparisons?.["24h"];
  const h2 = historicalComparisons?.["2h"];

  if (h24 && typeof h24.homeMarketProb === "number") {
    const delta24 = currentConsensus.homeMarketProb - h24.homeMarketProb;
    lineMovementAdj += clamp(delta24 * 0.45, -0.03, 0.03);
  }

  if (h2 && typeof h2.homeMarketProb === "number") {
    const delta2 = currentConsensus.homeMarketProb - h2.homeMarketProb;
    lineMovementAdj += clamp(delta2 * 0.8, -0.03, 0.03);
  }

  const propAdj = clamp(propSignal?.adj || 0, 0, 0.01);

  const injuryAdjHome = injurySummary?.available
    ? clamp(
        ((injurySummary.awayPenalty || 0) - (injurySummary.homePenalty || 0)) +
        ((injurySummary.homeLineupBoost || 0) - (injurySummary.awayLineupBoost || 0)),
        -0.06,
        0.06
      )
    : 0;

  let homeTrueProb =
    currentConsensus.homeMarketProb +
    currentConsensus.spreadAdj +
    currentConsensus.totalAdj +
    lineMovementAdj +
    propAdj +
    injuryAdjHome -
    currentConsensus.disagreementPenalty;

  let awayTrueProb =
    currentConsensus.awayMarketProb -
    currentConsensus.spreadAdj -
    currentConsensus.totalAdj -
    lineMovementAdj -
    propAdj -
    injuryAdjHome -
    currentConsensus.disagreementPenalty;

  homeTrueProb = clamp(homeTrueProb, 0.01, 0.99);
  awayTrueProb = clamp(awayTrueProb, 0.01, 0.99);

  const totalProb = homeTrueProb + awayTrueProb;
  homeTrueProb /= totalProb;
  awayTrueProb /= totalProb;

  const homeEdge = homeTrueProb - currentConsensus.homeMarketProb;
  const awayEdge = awayTrueProb - currentConsensus.awayMarketProb;

  const pickSide = homeEdge >= awayEdge ? "home" : "away";
  const pickTeam = pickSide === "home" ? featuredOdds.home_team : featuredOdds.away_team;
  const impliedProbability = pickSide === "home" ? currentConsensus.homeMarketProb : currentConsensus.awayMarketProb;
  const trueProbability = pickSide === "home" ? homeTrueProb : awayTrueProb;
  const sportsbookDecimal = pickSide === "home" ? currentConsensus.bestHomePrice : currentConsensus.bestAwayPrice;
  const rawEdge = pickSide === "home" ? homeEdge : awayEdge;

  const calibratedTrueProbability = typeof calibrationFn === "function"
    ? calibrationFn(trueProbability)
    : trueProbability;

  const calibratedEdge = calibratedTrueProbability - impliedProbability;

  const noBetFilter = {
    blocked: false,
    reasons: []
  };

  if (currentConsensus.bookCount < 2) {
    noBetFilter.blocked = true;
    noBetFilter.reasons.push("Low book coverage");
  }

  if (currentConsensus.disagreementPenalty > 0.03) {
    noBetFilter.blocked = true;
    noBetFilter.reasons.push("High market disagreement");
  }

  const confidence = buildConfidence(currentConsensus, historicalComparisons, propSignal, injurySummary);
  const verdict = buildVerdict(calibratedEdge, confidence, noBetFilter);
  const stakeSuggestion = buildStakeSuggestion(calibratedEdge, confidence, noBetFilter);

  return {
    pickSide,
    pickTeam,
    impliedProbability,
    trueProbability,
    calibratedTrueProbability,
    rawEdge,
    calibratedEdge,
    sportsbookDecimal,
    confidence: {
      label: confidence.label,
      percent: roundToTwo(confidence.percent)
    },
    verdict,
    noBetFilter,
    stakeSuggestion,
    oddsFormats: buildOddsFormatsFromDecimal(sportsbookDecimal),
    impliedProbabilityFormats: buildProbabilityFormats(impliedProbability),
    trueProbabilityFormats: buildProbabilityFormats(calibratedTrueProbability),
    bookmakerTable: currentConsensus.books,
    modelDetails: {
      homeMarketProb: roundToTwo(currentConsensus.homeMarketProb),
      awayMarketProb: roundToTwo(currentConsensus.awayMarketProb),
      bestHomePrice: roundToTwo(currentConsensus.bestHomePrice),
      bestAwayPrice: roundToTwo(currentConsensus.bestAwayPrice),
      avgHomePrice: roundToTwo(currentConsensus.avgHomePrice),
      avgAwayPrice: roundToTwo(currentConsensus.avgAwayPrice),
      avgHomeSpread: roundToTwo(currentConsensus.avgHomeSpread),
      avgTotal: roundToTwo(currentConsensus.avgTotal),
      totalConsensus: roundToTwo(currentConsensus.totalConsensus),
      bookCount: currentConsensus.bookCount,
      spreadAdj: roundToTwo(currentConsensus.spreadAdj),
      totalAdj: roundToTwo(currentConsensus.totalAdj),
      lineMovementAdj: roundToTwo(lineMovementAdj),
      propAdj: roundToTwo(propAdj),
      injuryAdjHome: roundToTwo(injuryAdjHome),
      disagreementPenalty: roundToTwo(currentConsensus.disagreementPenalty)
    },
    featureSnapshot: {
      spreadAdj: roundToTwo(currentConsensus.spreadAdj),
      totalAdj: roundToTwo(currentConsensus.totalAdj),
      lineMovementAdj: roundToTwo(lineMovementAdj),
      propAdj: roundToTwo(propAdj),
      injuryAdjHome: roundToTwo(injuryAdjHome),
      disagreementPenalty: roundToTwo(currentConsensus.disagreementPenalty),
      avgHomeSpread: roundToTwo(currentConsensus.avgHomeSpread),
      avgTotal: roundToTwo(currentConsensus.avgTotal),
      totalConsensus: roundToTwo(currentConsensus.totalConsensus),
      scoreAdj: 0,
      comebackAdj: 0,
      momentumAdj: 0,
      pacePressureAdj: 0,
      garbageTimePenalty: 0,
      timeLeverage: 0
    }
  };
}

module.exports = {
  buildElitePregameModel
};
