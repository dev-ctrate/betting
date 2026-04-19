"use strict";

/**
 * pregame_model.js — Pre-game market probability model
 * Extracts consensus from sportsbook odds and applies adjustments.
 */

const clamp   = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r2      = n => typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) / 100 : null;

function noVig(a, b) {
  if (!a || !b || a <= 1 || b <= 1) return { a: 0.5, b: 0.5 };
  const ra = 1 / a, rb = 1 / b, t = ra + rb;
  return { a: ra / t, b: rb / t };
}

function bookWeight(key) {
  if (["pinnacle","circasports","matchbook"].includes(key)) return 1.4;
  if (["draftkings","fanduel","betmgm","betrivers"].includes(key)) return 1.15;
  return 1.0;
}

function wAvg(pairs) {
  if (!pairs.length) return null;
  let n = 0, d = 0;
  for (const p of pairs) { n += p.value * p.weight; d += p.weight; }
  return d === 0 ? null : n / d;
}

function avg(arr) {
  const ns = (arr || []).filter(v => typeof v === "number" && Number.isFinite(v));
  return ns.length ? ns.reduce((s, v) => s + v, 0) / ns.length : null;
}

function variance(values) {
  const ns = (values || []).filter(v => typeof v === "number" && Number.isFinite(v));
  if (!ns.length) return 0;
  const m = avg(ns);
  return avg(ns.map(v => (v - m) ** 2)) || 0;
}

function decimalToAmerican(d) {
  if (typeof d !== "number" || !Number.isFinite(d) || d <= 1) return null;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

function buildElitePregameModel({ featuredOdds, historicalComparisons, propSignal, injurySummary, calibrationFn }) {
  const cal = typeof calibrationFn === "function" ? calibrationFn : p => p;

  const homeProbPairs = [], awayProbPairs = [];
  const homeProbRaw  = [], awayProbRaw  = [];
  const spreadSignals = [], totalSignals = [];
  const books = [];

  for (const bm of featuredOdds?.bookmakers || []) {
    const w   = bookWeight(bm.key || "");
    const h2h = bm.markets?.find(m => m.key === "h2h");
    const sp  = bm.markets?.find(m => m.key === "spreads");
    const tot = bm.markets?.find(m => m.key === "totals");
    let bHP = null, bAP = null, bHS = null, bAS = null, bT = null;

    if (h2h?.outcomes?.length >= 2) {
      const ho = h2h.outcomes.find(o => o.name === featuredOdds.home_team);
      const ao = h2h.outcomes.find(o => o.name === featuredOdds.away_team);
      if (ho && ao && ho.price > 1 && ao.price > 1) {
        bHP = ho.price; bAP = ao.price;
        const nv = noVig(ho.price, ao.price);
        homeProbPairs.push({ value: nv.a, weight: w });
        awayProbPairs.push({ value: nv.b, weight: w });
        homeProbRaw.push(nv.a);
        awayProbRaw.push(nv.b);
      }
    }
    if (sp?.outcomes?.length >= 2) {
      const hs = sp.outcomes.find(o => o.name === featuredOdds.home_team);
      const as_ = sp.outcomes.find(o => o.name === featuredOdds.away_team);
      if (hs && typeof hs.point === "number") {
        bHS = hs.point;
        spreadSignals.push({ value: clamp((-hs.point) * 0.0105, -0.10, 0.10), weight: w });
      }
      if (as_ && typeof as_.point === "number") bAS = as_.point;
    }
    if (tot?.outcomes?.length >= 2) {
      const ov = tot.outcomes.find(o => o.name === "Over");
      if (ov && typeof ov.point === "number") {
        bT = ov.point;
        totalSignals.push({ value: ov.point, weight: w });
      }
    }
    books.push({
      book: bm.title || bm.key || "book",
      homePrice: r2(bHP), awayPrice: r2(bAP),
      homeAmerican: decimalToAmerican(bHP), awayAmerican: decimalToAmerican(bAP),
      homeSpread: r2(bHS), awaySpread: r2(bAS),
      total: r2(bT),
    });
  }

  if (!homeProbPairs.length) {
    // No bookmakers — can't build model
    return {
      pickSide: "home", pickTeam: featuredOdds?.home_team || "Home",
      impliedProbability: 0.5, trueProbability: 0.5,
      sportsbookDecimal: null, edge: 0,
      confidence: { label: "Low", percent: 0.5 },
      noBetFilter: { blocked: true, reasons: ["No bookmaker data"] },
      stakeSuggestion: "No bet",
      scoreState: null,
      modelDetails: {}, bookmakerTable: [],
    };
  }

  const homeMarketProb = wAvg(homeProbPairs);
  const awayMarketProb = wAvg(awayProbPairs);
  const spreadAdj      = wAvg(spreadSignals) || 0;
  const totalConsensus = wAvg(totalSignals)  || 0;
  const disagreementPenalty = clamp((variance(homeProbRaw) + variance(awayProbRaw)) * 10, 0, 0.035);

  let totalAdj = 0;
  if (totalConsensus < 220) totalAdj = 0.005;
  else if (totalConsensus > 236) totalAdj = -0.005;

  // Historical line movement
  const hc2h  = historicalComparisons?.["2h"];
  const hc24h = historicalComparisons?.["24h"];
  let moveAdj = 0;
  if (hc2h?.homeMarketProb && homeMarketProb) {
    moveAdj += clamp((homeMarketProb - hc2h.homeMarketProb) * 0.25, -0.03, 0.03);
  }
  if (hc24h?.homeMarketProb && homeMarketProb) {
    moveAdj += clamp((homeMarketProb - hc24h.homeMarketProb) * 0.15, -0.02, 0.02);
  }

  // Injury adjustment
  const injAdj = (injurySummary?.homePenalty || 0) - (injurySummary?.awayPenalty || 0);

  // Prop signal
  const propAdj = propSignal?.adj || 0;

  // Final probability
  let trueProbHome = homeMarketProb + spreadAdj + totalAdj + moveAdj - injAdj + propAdj;
  trueProbHome = clamp(cal(trueProbHome), 0.01, 0.99);

  // Pick
  const pickSide = trueProbHome >= 0.5 ? "home" : "away";
  const pickTeam = pickSide === "home" ? featuredOdds.home_team : featuredOdds.away_team;
  const truePickProb    = pickSide === "home" ? trueProbHome : 1 - trueProbHome;
  const impliedPickProb = pickSide === "home" ? homeMarketProb : awayMarketProb;
  const edge            = truePickProb - impliedPickProb;

  // Best prices
  const homePs = books.map(b => b.homePrice).filter(v => typeof v === "number");
  const awayPs = books.map(b => b.awayPrice).filter(v => typeof v === "number");
  const bestHome = homePs.length ? Math.max(...homePs) : null;
  const bestAway = awayPs.length ? Math.max(...awayPs) : null;
  const sportsbookDecimal = pickSide === "home" ? bestHome : bestAway;

  // Confidence
  let confidenceLabel = "Low", confidencePct = 0.5;
  if (Math.abs(edge) >= 0.06)      { confidenceLabel = "High";   confidencePct = 0.80; }
  else if (Math.abs(edge) >= 0.035) { confidenceLabel = "Medium"; confidencePct = 0.65; }

  // No-bet conditions
  const noBetFilter = { blocked: false, reasons: [] };
  if (disagreementPenalty > 0.025) {
    noBetFilter.reasons.push(`High book disagreement (${(disagreementPenalty * 100).toFixed(1)}%)`);
  }

  let stakeSuggestion = "No bet";
  if (Math.abs(edge) >= 0.045 && confidencePct >= 0.65) stakeSuggestion = "1u";
  else if (Math.abs(edge) >= 0.025) stakeSuggestion = "0.5u";

  const avgHomeSpread = avg(books.map(b => b.homeSpread).filter(v => typeof v === "number"));
  const avgTotal      = avg(books.map(b => b.total).filter(v => typeof v === "number"));

  return {
    pickSide,
    pickTeam,
    impliedProbability:  impliedPickProb,
    trueProbability:     truePickProb,
    sportsbookDecimal,
    edge,
    confidence:   { label: confidenceLabel, percent: confidencePct },
    noBetFilter,
    stakeSuggestion,
    scoreState: null,
    modelDetails: {
      homeMarketProb:   r2(homeMarketProb),
      awayMarketProb:   r2(awayMarketProb),
      spreadAdj:        r2(spreadAdj),
      totalAdj:         r2(totalAdj),
      totalConsensus:   r2(totalConsensus),
      disagreementPenalty: r2(disagreementPenalty),
      moveAdj:          r2(moveAdj),
      injAdj:           r2(injAdj),
      propAdj:          r2(propAdj),
      avgHomeSpread:    r2(avgHomeSpread),
      avgTotal:         r2(avgTotal),
      bookCount: books.filter(b => b.homePrice && b.awayPrice).length,
    },
    bookmakerTable: books,
  };
}

module.exports = { buildElitePregameModel };
