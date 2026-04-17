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
  if (typeof totalConsensus === "number" && Number.isFinite(totalConsensus)) {
    if (totalConsensus < 220) totalAdj = 0.005;
    else if (totalConsensus > 236) totalAdj = -0.005;
  }

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

function buildPregameMovementAdj(historicalComparisons, homeMarketProb) {
  let lineMovementAdj = 0;

  const h24 = historicalComparisons?.["24h"];
  const h2 = historicalComparisons?.["2h"];

  if (h24 && typeof h24.homeMarketProb === "number") {
    const delta24 = homeMarketProb - h24.homeMarketProb;
    lineMovementAdj += clamp(delta24 * 0.55, -0.03, 0.03);
  }

  if (h2 && typeof h2.homeMarketProb === "number") {
    const delta2 = homeMarketProb - h2.homeMarketProb;
    lineMovementAdj += clamp(delta2 * 0.80, -0.03, 0.03);
  }

  return clamp(lineMovementAdj, -0.05, 0.05);
}

function buildFeatureWeights() {
  return {
    spreadAdj: 1.0,
    totalAdj: 1.0,
    lineMovementAdj: 1.0,
    propAdj: 1.0,
    injuryAdjHome: 1.0,
    disagreementPenalty: 1.0
  };
}

function applyNoBetFilter({
  rawEdge,
  consensus,
  confidence,
  injurySummary
}) {
  const reasons = [];

  if (rawEdge < 0.018) reasons.push("edge_too_small");
  if ((consensus?.bookCount || 0) < 3) reasons.push("low_book_count");
  if ((consensus?.disagreementPenalty || 0) > 0.028) reasons.push("high_disagreement");
  if (confidence.label === "Low") reasons.push("low_confidence");
  if (
    injurySummary?.available &&
    ((injurySummary.homeStartersOut || 0) + (injurySummary.awayStartersOut || 0) >= 3)
  ) {
    reasons.push("injury_instability");
  }

  return {
    blocked: reasons.length > 0,
    reasons
  };
}

function buildConfidence({
  consensus,
  historicalComparisons,
  propSignal,
  injurySummary
}) {
  let score = 50;

  score += clamp(((consensus?.bookCount || 0) - 3) * 6, 0, 25);
  score -= clamp((consensus?.disagreementPenalty || 0) * 800, 0, 22);

  if (historicalComparisons?.["2h"] && !historicalComparisons["2h"].error) score += 8;
  if (historicalComparisons?.["24h"] && !historicalComparisons["24h"].error) score += 8;

  score += clamp((propSignal?.depth || 0) * 0.7, 0, 12);

  if (injurySummary?.available) {
    score += 5;
    score += clamp(
      ((injurySummary.homeStarterCertainty || 0) + (injurySummary.awayStarterCertainty || 0)) * 8,
      0,
      8
    );
    score -= clamp(
      ((injurySummary.homeStartersOut || 0) + (injurySummary.awayStartersOut || 0)) * 2,
      0,
      10
    );
  }

  score = clamp(score, 0, 100);

  let label = "Low";
  if (score >= 75) label = "High";
  else if (score >= 55) label = "Medium";

  return {
    label,
    percent: score / 100
  };
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

function buildVerdict(edge, confidence, disagreementPenalty, noBetFilter) {
  if (noBetFilter.blocked) return "No bet";
  if (edge < 0.015) return "No edge";
  if (confidence.label === "Low" || disagreementPenalty > 0.025) return "Low confidence";
  if (edge >= 0.045 && confidence.percent >= 0.70) return "Bet now";
  if (edge >= 0.02) return "Watch";
  return "Avoid";
}

function buildElitePregameModel({
  featuredOdds,
  historicalComparisons = {},
  propSignal = { adj: 0, depth: 0 },
  injurySummary = { available: false },
  calibrationFn = null,
  featureWeights = null
}) {
  if (!featuredOdds?.home_team || !featuredOdds?.away_team) {
    throw new Error("featuredOdds with home_team and away_team is required");
  }

  const consensus = extractPregameConsensus(featuredOdds);
  if (!consensus) {
    throw new Error("Could not extract pregame market consensus");
  }

  const weights = {
    ...buildFeatureWeights(),
    ...(featureWeights || {})
  };

  const homeMarketProb = consensus.homeMarketProb;
  const awayMarketProb = consensus.awayMarketProb;

  const lineMovementAdj = buildPregameMovementAdj(historicalComparisons, homeMarketProb);

  const propAdj = clamp((propSignal?.adj || 0), 0, 0.01);

  const injuryAdjHome = injurySummary?.available
    ? clamp(
        ((injurySummary.awayPenalty || 0) - (injurySummary.homePenalty || 0)) +
        ((injurySummary.homeLineupBoost || 0) - (injurySummary.awayLineupBoost || 0)),
        -0.06,
        0.06
      )
    : 0;

  let homeTrueProb =
    homeMarketProb +
    (consensus.spreadAdj * weights.spreadAdj) +
    (consensus.totalAdj * weights.totalAdj) +
    (lineMovementAdj * weights.lineMovementAdj) +
    (propAdj * weights.propAdj) +
    (injuryAdjHome * weights.injuryAdjHome) -
    (consensus.disagreementPenalty * weights.disagreementPenalty);

  let awayTrueProb =
    awayMarketProb -
    (consensus.spreadAdj * weights.spreadAdj) -
    (consensus.totalAdj * weights.totalAdj) -
    (lineMovementAdj * weights.lineMovementAdj) -
    (propAdj * weights.propAdj) -
    (injuryAdjHome * weights.injuryAdjHome) -
    (consensus.disagreementPenalty * weights.disagreementPenalty);

  homeTrueProb = clamp(homeTrueProb, 0.01, 0.99);
  awayTrueProb = clamp(awayTrueProb, 0.01, 0.99);

  const total = homeTrueProb + awayTrueProb;
  homeTrueProb /= total;
  awayTrueProb /= total;

  const homeEdge = homeTrueProb - homeMarketProb;
  const awayEdge = awayTrueProb - awayMarketProb;

  const pickSide = homeEdge >= awayEdge ? "home" : "away";
  const pickTeam = pickSide === "home" ? featuredOdds.home_team : featuredOdds.away_team;
  const impliedProbability = pickSide === "home" ? homeMarketProb : awayMarketProb;
  const trueProbability = pickSide === "home" ? homeTrueProb : awayTrueProb;
  const rawEdge = pickSide === "home" ? homeEdge : awayEdge;

  const calibratedTrueProbability =
    typeof calibrationFn === "function"
      ? calibrationFn(trueProbability)
      : trueProbability;

  const calibratedEdge = calibratedTrueProbability - impliedProbability;

  const chosenDecimal = pickSide === "home"
    ? consensus.bestHomePrice
    : consensus.bestAwayPrice;

  const confidence = buildConfidence({
    consensus,
    historicalComparisons,
    propSignal,
    injurySummary
  });

  const noBetFilter = applyNoBetFilter({
    rawEdge: calibratedEdge,
    consensus,
    confidence,
    injurySummary
  });

  const verdict = buildVerdict(
    calibratedEdge,
    confidence,
    consensus.disagreementPenalty,
    noBetFilter
  );

  const stakeSuggestion = noBetFilter.blocked
    ? { tier: "No bet", fraction: 0 }
    : buildStakeSuggestion(calibratedEdge, confidence.label);

  return {
    pickSide,
    pickTeam,
    homeTeam: featuredOdds.home_team,
    awayTeam: featuredOdds.away_team,

    impliedProbability: roundToTwo(impliedProbability),
    trueProbability: roundToTwo(trueProbability),
    calibratedTrueProbability: roundToTwo(calibratedTrueProbability),

    impliedProbabilityFormats: buildProbabilityFormats(impliedProbability),
    trueProbabilityFormats: buildProbabilityFormats(trueProbability),

    edge: roundToTwo(calibratedEdge),
    rawEdge: roundToTwo(rawEdge),
    calibratedEdge: roundToTwo(calibratedEdge),

    verdict,
    confidence: {
      label: confidence.label,
      percent: roundToTwo(confidence.percent)
    },

    noBetFilter,

    stakeSuggestion: {
      tier: stakeSuggestion.tier,
      fraction: roundToTwo(stakeSuggestion.fraction)
    },

    oddsFormats: buildOddsFormatsFromDecimal(chosenDecimal),
    sportsbookDecimal: roundToTwo(chosenDecimal),

    modelDetails: {
      mode: "pregame",
      homeMarketProb: roundToTwo(consensus.homeMarketProb),
      awayMarketProb: roundToTwo(consensus.awayMarketProb),
      spreadAdj: roundToTwo(consensus.spreadAdj),
      totalAdj: roundToTwo(consensus.totalAdj),
      totalConsensus: roundToTwo(consensus.totalConsensus),
      lineMovementAdj: roundToTwo(lineMovementAdj),
      propAdj: roundToTwo(propAdj),
      injuryAdjHome: roundToTwo(injuryAdjHome),
      disagreementPenalty: roundToTwo(consensus.disagreementPenalty),
      avgHomePrice: roundToTwo(consensus.avgHomePrice),
      avgAwayPrice: roundToTwo(consensus.avgAwayPrice),
      bestHomePrice: roundToTwo(consensus.bestHomePrice),
      bestAwayPrice: roundToTwo(consensus.bestAwayPrice),
      avgHomeSpread: roundToTwo(consensus.avgHomeSpread),
      avgTotal: roundToTwo(consensus.avgTotal),
      bookCount: consensus.bookCount,
      historicalComparisons,
      featureWeights: weights
    },

    featureSnapshot: {
      mode: "pregame",
      spreadAdj: roundToTwo(consensus.spreadAdj),
      totalAdj: roundToTwo(consensus.totalAdj),
      lineMovementAdj: roundToTwo(lineMovementAdj),
      propAdj: roundToTwo(propAdj),
      injuryAdjHome: roundToTwo(injuryAdjHome),
      disagreementPenalty: roundToTwo(consensus.disagreementPenalty),
      bookCount: consensus.bookCount,
      totalConsensus: roundToTwo(consensus.totalConsensus),
      avgHomeSpread: roundToTwo(consensus.avgHomeSpread),
      avgTotal: roundToTwo(consensus.avgTotal)
    },

    bookmakerTable: consensus.books.map(row => ({
      ...row,
      homePrice: roundToTwo(row.homePrice),
      awayPrice: roundToTwo(row.awayPrice),
      homeSpread: roundToTwo(row.homeSpread),
      awaySpread: roundToTwo(row.awaySpread),
      total: roundToTwo(row.total),
      homeDecimal: roundToTwo(row.homeDecimal),
      awayDecimal: roundToTwo(row.awayDecimal)
    }))
  };
}

module.exports = {
  buildElitePregameModel
};
