function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function roundToTwo(num) {
  if (typeof num !== "number" || !Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}

function average(values) {
  const nums = (values || []).filter(v => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

function variance(values) {
  const nums = (values || []).filter(v => typeof v === "number" && Number.isFinite(v));
  if (!nums.length) return 0;
  const avg = average(nums);
  return average(nums.map(v => (v - avg) ** 2)) || 0;
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
      book: bookmaker.title || bookmaker.key || "book",
      homePrice: roundToTwo(homePrice),
      awayPrice: roundToTwo(awayPrice),
      homeAmerican: decimalToAmerican(homePrice),
      awayAmerican: decimalToAmerican(awayPrice),
      homeSpread: roundToTwo(homeSpread),
      awaySpread: roundToTwo(awaySpread),
      total: roundToTwo(total),
      weight
    });
  }

  if (!homeProbPairs.length || !awayProbPairs.length) {
    return null;
  }

  const homeMarketProb = weightedAverage(homeProbPairs);
  const awayMarketProb = weightedAverage(awayProbPairs);
  const spreadAdj = spreadSignals.length ? weightedAverage(spreadSignals) : 0;
  const totalConsensus = totalSignals.length ? weightedAverage(totalSignals) : 0;

  let totalAdj = 0;
  if (typeof totalConsensus === "number" && Number.isFinite(totalConsensus)) {
    if (totalConsensus < 216) totalAdj = 0.006;
    else if (totalConsensus > 238) totalAdj = -0.006;
  }

  const disagreementPenalty = clamp(
    (variance(homeProbRaw) + variance(awayProbRaw)) * 12,
    0,
    0.05
  );

  const bestHomePrice = Math.max(
    ...books.map(b => (typeof b.homePrice === "number" ? b.homePrice : -Infinity))
  );

  const bestAwayPrice = Math.max(
    ...books.map(b => (typeof b.awayPrice === "number" ? b.awayPrice : -Infinity))
  );

  return {
    homeMarketProb,
    awayMarketProb,
    spreadAdj,
    totalAdj,
    totalConsensus,
    disagreementPenalty,
    bestHomePrice: Number.isFinite(bestHomePrice) ? bestHomePrice : null,
    bestAwayPrice: Number.isFinite(bestAwayPrice) ? bestAwayPrice : null,
    avgHomePrice: average(books.map(b => b.homePrice)),
    avgAwayPrice: average(books.map(b => b.awayPrice)),
    avgHomeSpread: average(books.map(b => b.homeSpread)),
    avgTotal: average(books.map(b => b.total)),
    bookCount: books.length,
    books
  };
}

function buildScoreState(liveState, featuredOdds) {
  const homeScore = Number(liveState?.homeScore || 0);
  const awayScore = Number(liveState?.awayScore || 0);
  const scoreDiff = homeScore - awayScore;

  const period = Number(liveState?.period || 1);
  const clockSec =
    typeof liveState?.clockSec === "number" && Number.isFinite(liveState.clockSec)
      ? liveState.clockSec
      : 12 * 60;

  const regulationPeriods = 4;
  const maxGameSeconds = regulationPeriods * 12 * 60;
  const elapsedSeconds = clamp(((period - 1) * 12 * 60) + (12 * 60 - clockSec), 0, maxGameSeconds);
  const progress = clamp(elapsedSeconds / maxGameSeconds, 0, 1);

  const timeRemaining = clamp(maxGameSeconds - elapsedSeconds, 0, maxGameSeconds);
  const timeLeverage = clamp(1 - (timeRemaining / maxGameSeconds), 0, 1);

  const scoreAdj = clamp(scoreDiff * 0.018, -0.30, 0.30);

  const trailingBy = scoreDiff < 0 ? Math.abs(scoreDiff) : 0;
  const leadingBy = scoreDiff > 0 ? scoreDiff : 0;

  let comebackAdj = 0;
  if (trailingBy > 0) {
    comebackAdj = clamp(trailingBy * timeLeverage * 0.01, 0, 0.08);
  }

  const momentumAdj = clamp(Number(liveState?.momentumAdj || 0), -0.08, 0.08);
  const pacePressureAdj = clamp(Number(liveState?.pacePressureAdj || 0), -0.05, 0.05);

  let garbageTimePenalty = 0;
  if (timeLeverage > 0.82 && leadingBy >= 16) {
    garbageTimePenalty = clamp((leadingBy - 15) * 0.004, 0, 0.08);
  }

  return {
    homeScore,
    awayScore,
    scoreDiff,
    period,
    clock: liveState?.clock || "12:00",
    clockSec,
    progress,
    timeRemaining,
    timeLeverage,
    scoreAdj,
    comebackAdj,
    momentumAdj,
    pacePressureAdj,
    garbageTimePenalty,
    liveFound: !!liveState?.liveFound,
    gameId: liveState?.gameId || featuredOdds?.id || null
  };
}

function buildConfidence(rawEdge, scoreState, currentConsensus) {
  let pct = 0.55;

  pct += clamp(rawEdge * 3.2, -0.12, 0.22);
  pct += clamp(scoreState.timeLeverage * 0.08, 0, 0.08);
  pct -= clamp(currentConsensus.disagreementPenalty * 1.2, 0, 0.08);

  if (!scoreState.liveFound) {
    pct -= 0.03;
  }

  pct = clamp(pct, 0.5, 0.92);

  let label = "Low";
  if (pct >= 0.75) label = "High";
  else if (pct >= 0.62) label = "Medium";

  return {
    percent: roundToTwo(pct),
    label
  };
}

function buildVerdict(calibratedEdge, confidence, noBetFilter) {
  if (noBetFilter.blocked) return "Avoid";
  if (calibratedEdge >= 0.045 && confidence.percent >= 0.62) return "Bet now";
  if (calibratedEdge >= 0.02) return "Watch";
  return "Avoid";
}

function buildStakeSuggestion(calibratedEdge, confidence, noBetFilter) {
  if (noBetFilter.blocked) return "No bet";
  if (calibratedEdge >= 0.07 && confidence.percent >= 0.75) return "1.5u";
  if (calibratedEdge >= 0.045 && confidence.percent >= 0.62) return "1u";
  if (calibratedEdge >= 0.025) return "0.5u";
  return "No bet";
}

function buildEliteLiveModel({
  featuredOdds,
  liveState,
  pregameBaseline,
  calibrationFn
}) {
  const currentConsensus = extractLiveMarketConsensus(featuredOdds);

  if (!currentConsensus) {
    throw new Error("Could not extract live market consensus");
  }

  const scoreState = buildScoreState(liveState, featuredOdds);

  const pregameHomeProb =
    typeof pregameBaseline?.homeMarketProb === "number" && Number.isFinite(pregameBaseline.homeMarketProb)
      ? pregameBaseline.homeMarketProb
      : currentConsensus.homeMarketProb;

  let trueProbabilityHome = pregameHomeProb;

  trueProbabilityHome += currentConsensus.spreadAdj;
  trueProbabilityHome += currentConsensus.totalAdj;
  trueProbabilityHome += scoreState.scoreAdj;
  trueProbabilityHome += scoreState.momentumAdj;
  trueProbabilityHome += scoreState.pacePressureAdj;

  if (scoreState.scoreDiff < 0) {
    trueProbabilityHome += scoreState.comebackAdj;
  } else {
    trueProbabilityHome -= scoreState.comebackAdj * 0.35;
  }

  if (scoreState.scoreDiff > 0) {
    trueProbabilityHome -= scoreState.garbageTimePenalty;
  } else {
    trueProbabilityHome += scoreState.garbageTimePenalty * 0.15;
  }

  trueProbabilityHome -= currentConsensus.disagreementPenalty * 0.4;
  trueProbabilityHome = clamp(trueProbabilityHome, 0.01, 0.99);

  const pickSide = trueProbabilityHome >= 0.5 ? "home" : "away";
  const pickTeam = pickSide === "home" ? featuredOdds.home_team : featuredOdds.away_team;

  const impliedProbability =
    pickSide === "home"
      ? currentConsensus.homeMarketProb
      : currentConsensus.awayMarketProb;

  const trueProbability =
    pickSide === "home"
      ? trueProbabilityHome
      : 1 - trueProbabilityHome;

  const calibratedTrueProbability =
    typeof calibrationFn === "function"
      ? clamp(calibrationFn(trueProbability), 0.01, 0.99)
      : trueProbability;

  const rawEdge = trueProbability - impliedProbability;
  const calibratedEdge = calibratedTrueProbability - impliedProbability;

  const sportsbookDecimal =
    pickSide === "home"
      ? currentConsensus.bestHomePrice
      : currentConsensus.bestAwayPrice;

  const noBetFilter = {
    blocked: false,
    reasons: []
  };

  if (currentConsensus.bookCount < 2) {
    noBetFilter.blocked = true;
    noBetFilter.reasons.push("Low book coverage");
  }

  if (currentConsensus.disagreementPenalty > 0.035) {
    noBetFilter.blocked = true;
    noBetFilter.reasons.push("High market disagreement");
  }

  const confidence = buildConfidence(rawEdge, scoreState, currentConsensus);
  const verdict = buildVerdict(calibratedEdge, confidence, noBetFilter);
  const stakeSuggestion = buildStakeSuggestion(calibratedEdge, confidence, noBetFilter);

  return {
    pickSide,
    pickTeam,
    impliedProbability: roundToTwo(impliedProbability),
    trueProbability: roundToTwo(trueProbability),
    calibratedTrueProbability: roundToTwo(calibratedTrueProbability),
    rawEdge: roundToTwo(rawEdge),
    calibratedEdge: roundToTwo(calibratedEdge),
    sportsbookDecimal: roundToTwo(sportsbookDecimal),
    confidence,
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
      scoreAdj: roundToTwo(scoreState.scoreAdj),
      comebackAdj: roundToTwo(scoreState.comebackAdj),
      momentumAdj: roundToTwo(scoreState.momentumAdj),
      pacePressureAdj: roundToTwo(scoreState.pacePressureAdj),
      garbageTimePenalty: roundToTwo(scoreState.garbageTimePenalty),
      timeLeverage: roundToTwo(scoreState.timeLeverage),
      disagreementPenalty: roundToTwo(currentConsensus.disagreementPenalty)
    },
    featureSnapshot: {
      spreadAdj: roundToTwo(currentConsensus.spreadAdj),
      totalAdj: roundToTwo(currentConsensus.totalAdj),
      lineMovementAdj: 0,
      propAdj: 0,
      injuryAdjHome: 0,
      disagreementPenalty: roundToTwo(currentConsensus.disagreementPenalty),
      avgHomeSpread: roundToTwo(currentConsensus.avgHomeSpread),
      avgTotal: roundToTwo(currentConsensus.avgTotal),
      totalConsensus: roundToTwo(currentConsensus.totalConsensus),
      scoreAdj: roundToTwo(scoreState.scoreAdj),
      comebackAdj: roundToTwo(scoreState.comebackAdj),
      momentumAdj: roundToTwo(scoreState.momentumAdj),
      pacePressureAdj: roundToTwo(scoreState.pacePressureAdj),
      garbageTimePenalty: roundToTwo(scoreState.garbageTimePenalty),
      timeLeverage: roundToTwo(scoreState.timeLeverage)
    },
    scoreState
  };
}

module.exports = {
  buildEliteLiveModel
};
