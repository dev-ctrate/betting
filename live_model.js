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
  if (typeof totalConsensus === "number" && Number.isFinite(totalConsensus)) {
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

function parseClockToSeconds(clockLike) {
  if (typeof clockLike === "number" && Number.isFinite(clockLike)) {
    return clamp(clockLike, 0, 12 * 60);
  }

  if (typeof clockLike !== "string") return null;

  const trimmed = clockLike.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(":").map(Number);
  if (parts.length !== 2 || parts.some(n => !Number.isFinite(n))) return null;

  const [mins, secs] = parts;
  return clamp(mins * 60 + secs, 0, 12 * 60);
}

function inferPeriod(rawState) {
  const candidates = [
    rawState?.period,
    rawState?.quarter,
    rawState?.game?.period,
    rawState?.game?.quarter,
    rawState?.boxscore?.period,
    rawState?.boxscore?.quarter
  ];

  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return 1;
}

function inferClock(rawState) {
  const candidates = [
    rawState?.clock,
    rawState?.gameClock,
    rawState?.time_remaining,
    rawState?.timeRemaining,
    rawState?.game?.clock,
    rawState?.boxscore?.clock
  ];

  for (const c of candidates) {
    const sec = parseClockToSeconds(c);
    if (sec != null) return sec;
  }

  return null;
}

function inferScores(rawState, homeTeam, awayTeam) {
  const directHome = [
    rawState?.homeScore,
    rawState?.home_score,
    rawState?.game?.home_score,
    rawState?.boxscore?.home_score
  ];

  const directAway = [
    rawState?.awayScore,
    rawState?.away_score,
    rawState?.game?.away_score,
    rawState?.boxscore?.away_score
  ];

  for (let i = 0; i < directHome.length; i += 1) {
    const h = Number(directHome[i]);
    const a = Number(directAway[i]);
    if (Number.isFinite(h) && Number.isFinite(a)) {
      return { homeScore: h, awayScore: a };
    }
  }

  const teamStats = rawState?.teams || rawState?.boxscore?.teams || [];
  if (Array.isArray(teamStats) && teamStats.length >= 2) {
    let homeScore = null;
    let awayScore = null;

    for (const t of teamStats) {
      const name = String(t?.name || t?.full_name || t?.team || "").trim();
      const score = Number(t?.score ?? t?.points ?? t?.pts);
      if (!Number.isFinite(score)) continue;

      if (name === homeTeam) homeScore = score;
      if (name === awayTeam) awayScore = score;
    }

    if (Number.isFinite(homeScore) && Number.isFinite(awayScore)) {
      return { homeScore, awayScore };
    }
  }

  return { homeScore: 0, awayScore: 0 };
}

function inferRecentRun(rawState, homeTeam, awayTeam) {
  const plays = rawState?.plays || rawState?.recentPlays || rawState?.playByPlay || [];
  if (!Array.isArray(plays) || !plays.length) {
    return {
      homeRun: 0,
      awayRun: 0,
      netRun: 0,
      momentumAdj: 0,
      pacePressureAdj: 0
    };
  }

  const lastPlays = plays.slice(-12);

  let homeRun = 0;
  let awayRun = 0;
  let scoringEvents = 0;

  for (const play of lastPlays) {
    const text = String(
      play?.description ||
      play?.text ||
      play?.event ||
      play?.msg ||
      ""
    ).toLowerCase();

    const pts = Number(play?.points ?? play?.pts ?? play?.score_value ?? 0) || 0;

    const teamName = String(play?.team || play?.team_name || play?.teamName || "").trim();

    if (pts > 0) scoringEvents += 1;

    const looksHome = teamName === homeTeam || text.includes(homeTeam.toLowerCase());
    const looksAway = teamName === awayTeam || text.includes(awayTeam.toLowerCase());

    if (looksHome) homeRun += pts;
    if (looksAway) awayRun += pts;
  }

  const netRun = homeRun - awayRun;
  const momentumAdj = clamp(netRun * 0.0035, -0.05, 0.05);
  const pacePressureAdj = clamp((scoringEvents - 5) * 0.003, -0.02, 0.02);

  return {
    homeRun,
    awayRun,
    netRun,
    momentumAdj,
    pacePressureAdj
  };
}

function inferTimeState(rawState) {
  const period = inferPeriod(rawState);
  const clockSec = inferClock(rawState);

  let regulationRemainingSec;
  if (clockSec == null) {
    regulationRemainingSec = clamp((4 - Math.min(period, 4)) * 12 * 60, 0, 48 * 60);
  } else if (period <= 4) {
    regulationRemainingSec = ((4 - period) * 12 * 60) + clockSec;
  } else {
    regulationRemainingSec = clockSec;
  }

  const gameProgress = clamp(1 - (regulationRemainingSec / (48 * 60)), 0, 1);

  return {
    period,
    clockSec,
    regulationRemainingSec,
    gameProgress
  };
}

function buildTimeLeverage(period, regulationRemainingSec, scoreMarginAbs) {
  let leverage = 0;

  if (period === 1) leverage = 0.25;
  else if (period === 2) leverage = 0.45;
  else if (period === 3) leverage = 0.65;
  else leverage = 1.0;

  if (regulationRemainingSec <= 180) leverage += 0.25;
  else if (regulationRemainingSec <= 360) leverage += 0.15;
  else if (regulationRemainingSec <= 720) leverage += 0.07;

  if (scoreMarginAbs >= 18) leverage -= 0.18;
  else if (scoreMarginAbs >= 12) leverage -= 0.08;

  return clamp(leverage, 0.15, 1.25);
}

function buildScoreAdj(scoreMargin, leverage) {
  return clamp(scoreMargin * 0.0095 * leverage, -0.24, 0.24);
}

function buildComebackAdj(scoreMargin, regulationRemainingSec) {
  const marginAbs = Math.abs(scoreMargin);

  if (regulationRemainingSec > 8 * 60) {
    return clamp((-scoreMargin) * 0.0012, -0.03, 0.03);
  }

  if (regulationRemainingSec > 4 * 60) {
    return clamp((-scoreMargin) * 0.0008, -0.02, 0.02);
  }

  if (marginAbs <= 6 && regulationRemainingSec <= 2 * 60) {
    return clamp((-scoreMargin) * 0.0004, -0.01, 0.01);
  }

  return 0;
}

function buildGarbageTimePenalty(scoreMarginAbs, regulationRemainingSec) {
  if (regulationRemainingSec > 10 * 60) return 0;
  if (scoreMarginAbs >= 22) return 0.05;
  if (scoreMarginAbs >= 18) return 0.035;
  if (scoreMarginAbs >= 14) return 0.02;
  return 0;
}

function buildVolatilityPenalty(momentumAdj, disagreementPenalty, regulationRemainingSec) {
  let penalty = 0;

  penalty += Math.abs(momentumAdj) * 0.35;
  penalty += disagreementPenalty;

  if (regulationRemainingSec <= 120) {
    penalty += 0.012;
  }

  return clamp(penalty, 0, 0.06);
}

function buildConfidence({
  consensus,
  timeLeverage,
  scoreMarginAbs,
  momentumAdj,
  garbageTimePenalty,
  volatilityPenalty
}) {
  let score = 52;

  score += clamp((consensus.bookCount - 3) * 5, 0, 24);
  score -= clamp(consensus.disagreementPenalty * 820, 0, 24);
  score += clamp(timeLeverage * 12, 0, 14);
  score -= clamp(Math.abs(momentumAdj) * 180, 0, 10);
  score -= clamp(garbageTimePenalty * 180, 0, 10);
  score -= clamp(volatilityPenalty * 220, 0, 12);

  if (scoreMarginAbs <= 6) score += 4;
  if (scoreMarginAbs >= 18) score -= 6;

  score = clamp(score, 0, 100);

  let label = "Low";
  if (score >= 76) label = "High";
  else if (score >= 56) label = "Medium";

  return {
    label,
    percent: score / 100
  };
}

function buildStakeSuggestion(edge, confidenceLabel) {
  if (edge < 0.015) return { tier: "No bet", fraction: 0 };
  if (edge < 0.03) {
    return confidenceLabel === "High"
      ? { tier: "Small", fraction: 0.25 }
      : { tier: "Tiny", fraction: 0.1 };
  }
  if (edge < 0.055) {
    return confidenceLabel === "High"
      ? { tier: "Normal", fraction: 0.5 }
      : { tier: "Small", fraction: 0.25 };
  }
  return confidenceLabel === "High"
    ? { tier: "Strong", fraction: 0.75 }
    : { tier: "Normal", fraction: 0.5 };
}

function buildVerdict(edge, confidence, timeLeverage, volatilityPenalty) {
  if (edge < 0.012) return "No edge";
  if (volatilityPenalty > 0.04) return "Low confidence";
  if (confidence.label === "Low") return "Low confidence";

  if (timeLeverage >= 0.9 && edge >= 0.04 && confidence.percent >= 0.72) {
    return "Bet now";
  }

  if (edge >= 0.022) return "Watch";
  return "Avoid";
}

function buildEliteLiveModel({
  featuredOdds,
  liveState,
  pregameBaseline = null,
  calibrationFn = null
}) {
  if (!featuredOdds?.home_team || !featuredOdds?.away_team) {
    throw new Error("featuredOdds with home_team and away_team is required");
  }

  const consensus = extractLiveMarketConsensus(featuredOdds);
  if (!consensus) {
    throw new Error("Could not extract live market consensus");
  }

  const homeTeam = featuredOdds.home_team;
  const awayTeam = featuredOdds.away_team;

  const { homeScore, awayScore } = inferScores(liveState, homeTeam, awayTeam);
  const scoreMargin = homeScore - awayScore;
  const scoreMarginAbs = Math.abs(scoreMargin);

  const timeState = inferTimeState(liveState);
  const period = timeState.period;
  const regulationRemainingSec = timeState.regulationRemainingSec;

  const runState = inferRecentRun(liveState, homeTeam, awayTeam);

  const timeLeverage = buildTimeLeverage(period, regulationRemainingSec, scoreMarginAbs);
  const scoreAdj = buildScoreAdj(scoreMargin, timeLeverage);
  const comebackAdj = buildComebackAdj(scoreMargin, regulationRemainingSec);
  const garbageTimePenalty = buildGarbageTimePenalty(scoreMarginAbs, regulationRemainingSec);

  let lineMovementAdj = 0;
  if (pregameBaseline && typeof pregameBaseline.homeMarketProb === "number") {
    const delta = consensus.homeMarketProb - pregameBaseline.homeMarketProb;
    lineMovementAdj = clamp(delta * 0.75, -0.05, 0.05);
  }

  const momentumAdj = runState.momentumAdj;
  const pacePressureAdj = runState.pacePressureAdj;
  const volatilityPenalty = buildVolatilityPenalty(
    momentumAdj,
    consensus.disagreementPenalty,
    regulationRemainingSec
  );

  let homeTrueProb =
    consensus.homeMarketProb +
    consensus.spreadAdj +
    consensus.totalAdj +
    lineMovementAdj +
    scoreAdj +
    comebackAdj +
    momentumAdj +
    pacePressureAdj -
    consensus.disagreementPenalty -
    garbageTimePenalty -
    volatilityPenalty;

  let awayTrueProb =
    consensus.awayMarketProb -
    consensus.spreadAdj -
    consensus.totalAdj -
    lineMovementAdj -
    scoreAdj -
    comebackAdj -
    momentumAdj -
    pacePressureAdj -
    consensus.disagreementPenalty -
    garbageTimePenalty -
    volatilityPenalty;

  homeTrueProb = clamp(homeTrueProb, 0.01, 0.99);
  awayTrueProb = clamp(awayTrueProb, 0.01, 0.99);

  const total = homeTrueProb + awayTrueProb;
  homeTrueProb /= total;
  awayTrueProb /= total;

  const homeEdge = homeTrueProb - consensus.homeMarketProb;
  const awayEdge = awayTrueProb - consensus.awayMarketProb;

  const pickSide = homeEdge >= awayEdge ? "home" : "away";
  const pickTeam = pickSide === "home" ? homeTeam : awayTeam;
  const impliedProbability = pickSide === "home" ? consensus.homeMarketProb : consensus.awayMarketProb;
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
    timeLeverage,
    scoreMarginAbs,
    momentumAdj,
    garbageTimePenalty,
    volatilityPenalty
  });

  const verdict = buildVerdict(
    calibratedEdge,
    confidence,
    timeLeverage,
    volatilityPenalty
  );

  const stakeSuggestion = buildStakeSuggestion(calibratedEdge, confidence.label);

  return {
    pickSide,
    pickTeam,
    homeTeam,
    awayTeam,

    scoreState: {
      homeScore,
      awayScore,
      scoreMargin,
      period,
      clockSec: timeState.clockSec,
      regulationRemainingSec,
      gameProgress: roundToTwo(timeState.gameProgress),
      homeRun: runState.homeRun,
      awayRun: runState.awayRun,
      netRun: runState.netRun
    },

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

    stakeSuggestion: {
      tier: stakeSuggestion.tier,
      fraction: roundToTwo(stakeSuggestion.fraction)
    },

    oddsFormats: buildOddsFormatsFromDecimal(chosenDecimal),
    sportsbookDecimal: roundToTwo(chosenDecimal),

    modelDetails: {
      homeMarketProb: roundToTwo(consensus.homeMarketProb),
      awayMarketProb: roundToTwo(consensus.awayMarketProb),
      spreadAdj: roundToTwo(consensus.spreadAdj),
      totalAdj: roundToTwo(consensus.totalAdj),
      totalConsensus: roundToTwo(consensus.totalConsensus),
      lineMovementAdj: roundToTwo(lineMovementAdj),
      scoreAdj: roundToTwo(scoreAdj),
      comebackAdj: roundToTwo(comebackAdj),
      momentumAdj: roundToTwo(momentumAdj),
      pacePressureAdj: roundToTwo(pacePressureAdj),
      disagreementPenalty: roundToTwo(consensus.disagreementPenalty),
      garbageTimePenalty: roundToTwo(garbageTimePenalty),
      volatilityPenalty: roundToTwo(volatilityPenalty),
      timeLeverage: roundToTwo(timeLeverage),
      avgHomePrice: roundToTwo(consensus.avgHomePrice),
      avgAwayPrice: roundToTwo(consensus.avgAwayPrice),
      bestHomePrice: roundToTwo(consensus.bestHomePrice),
      bestAwayPrice: roundToTwo(consensus.bestAwayPrice),
      avgHomeSpread: roundToTwo(consensus.avgHomeSpread),
      avgTotal: roundToTwo(consensus.avgTotal),
      bookCount: consensus.bookCount
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
  buildEliteLiveModel
};
