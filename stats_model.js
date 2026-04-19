"use strict";

/**
 * stats_model.js  —  Fully independent win probability engine v2
 *
 * Uses advanced_stats.js for every metric. Does NOT use sportsbook odds.
 *
 * ─── 13 signals (weights sum to 1.0) ────────────────────────────────────────
 *
 *  1. Net Rating matchup     0.24  ORtg vs DRtg cross-comparison (most predictive)
 *  2. Predicted spread       0.14  derived from projected pts both sides
 *  3. Recent form            0.13  last-10 win% + point diff
 *  4. Star power             0.10  player quality differential
 *  5. Shooting efficiency    0.08  TS% / eFG% matchup
 *  6. Turnover battle        0.07  TOV% differential
 *  7. Rest / schedule        0.07  rest days + B2B penalties
 *  8. Rebound battle         0.05  OREB% advantage
 *  9. H2H history            0.05  current season head-to-head
 * 10. Momentum               0.04  recent form trend (last-5 vs season)
 * 11. Defense quality        0.03  STL + BLK rates
 * 12. Home/away splits       0.03  contextual home vs away record
 * 13. Pace / ball movement   0.03  pace edge + AST/TOV quality
 *
 * Each signal produces a home-win probability in [0.1, 0.9].
 * Signals are blended in logit space (more stable than linear for probs).
 * Home court advantage added as a calibrated logit bump.
 * Live score adjustment applied when a game is in progress.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { getAdvancedMatchup } = require("./advanced_stats");

// ─── signal weights ───────────────────────────────────────────────────────────
const W = {
  netRating:    0.24,
  predictedSpread: 0.14,
  recentForm:   0.13,
  starPower:    0.10,
  shooting:     0.08,
  turnover:     0.07,
  rest:         0.07,
  rebound:      0.05,
  h2h:          0.05,
  momentum:     0.04,
  defense:      0.03,
  splits:       0.03,
  pace:         0.03
};

// Sanity check: weights should sum to ~1
const W_TOTAL = Object.values(W).reduce((s, v) => s + v, 0);

const HOME_COURT_LOGIT_BUMP = 0.112;  // ≈ +2.8% win prob at p=0.5

// ─── math ─────────────────────────────────────────────────────────────────────
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function sigmoid(x) { return 1 / (1 + Math.exp(-clamp(x, -50, 50))); }
function logit(p)   { const cp = clamp(p, 1e-6, 1 - 1e-6); return Math.log(cp / (1 - cp)); }
function roundTo(n, d = 4) { return Math.round(n * (10 ** d)) / (10 ** d); }

// ─── signal builders (each returns prob in [0.1, 0.9]) ───────────────────────

/**
 * 1. Net Rating matchup
 * NRtg diff of +7.5 pts/100poss → sigmoid produces ≈ 70% win prob for better team.
 * Scale = 7.5 is calibrated from historical NBA data.
 */
function signalNetRating(matchup) {
  const diff = matchup?.net_diff;
  if (typeof diff !== "number" || !Number.isFinite(diff)) return 0.5;
  return clamp(sigmoid(diff / 7.5), 0.12, 0.88);
}

/**
 * 2. Predicted spread
 * Translates projected point differential directly to win probability.
 * Each 3.5 pts of spread ≈ sigmoid unit.
 */
function signalPredictedSpread(matchup) {
  const spread = matchup?.predicted_spread;
  if (typeof spread !== "number" || !Number.isFinite(spread)) return 0.5;
  return clamp(sigmoid(spread / 3.5), 0.10, 0.90);
}

/**
 * 3. Recent form (last 10 games win% + point differential)
 */
function signalRecentForm(matchup) {
  const formEdge = matchup?.form_edge  || 0;   // win% diff last 10
  const diffEdge = matchup?.diff5_edge || 0;    // point diff diff last 5
  // Combine: win% difference of 0.20 → ≈ 60% vs 0.40 differential
  const combined = formEdge * 0.60 + clamp(diffEdge / 15, -0.3, 0.3) * 0.40;
  return clamp(0.5 + combined * 0.45, 0.12, 0.88);
}

/**
 * 4. Star power (normalised player quality differential)
 * star_edge is normalised to roughly [-0.5, 0.5]
 */
function signalStarPower(matchup) {
  const se = matchup?.star_edge  || 0;   // normalised [-0.5, 0.5]
  const de = matchup?.depth_edge || 0;
  const combined = se * 0.75 + de * 0.25;
  return clamp(0.5 + combined * 0.55, 0.15, 0.85);
}

/**
 * 5. Shooting efficiency
 * TS% difference of 0.03 (3%) → meaningful edge.
 */
function signalShooting(matchup) {
  const ts_edge  = matchup?.ts_edge  || 0;
  const efg_edge = matchup?.efg_edge || 0;
  // Weight TS% more (more comprehensive than eFG%)
  const combined = ts_edge * 0.65 + efg_edge * 0.35;
  return clamp(0.5 + combined * 6.5, 0.15, 0.85);
}

/**
 * 6. Turnover battle
 * TOV% diff of 2 percentage points → meaningful edge.
 */
function signalTurnover(matchup) {
  const tov_edge    = matchup?.tov_edge    || 0;   // away_tov - home_tov (+ = home advantage)
  const ast_tov_edge = matchup?.ast_tov_edge || 0;
  const combined = tov_edge * 0.022 + ast_tov_edge * 0.04;
  return clamp(0.5 + combined, 0.15, 0.85);
}

/**
 * 7. Rest / schedule
 * rest_edge already includes B2B penalties and rest day differential.
 */
function signalRest(matchup) {
  const re = matchup?.rest_edge || 0;
  return clamp(0.5 + re, 0.18, 0.82);
}

/**
 * 8. Rebounding battle
 * OREB% edge of 0.05 (5 percentage points) → ~2% win prob swing.
 */
function signalRebounding(matchup) {
  const ore = matchup?.oreb_edge || 0;
  return clamp(0.5 + ore * 0.8, 0.25, 0.75);
}

/**
 * 9. H2H — current season only
 */
function signalH2H(h2h) {
  if (!h2h) return 0.5;
  return clamp(h2h.h2h_prob || 0.5, 0.22, 0.78);
}

/**
 * 10. Momentum (recent form trend — improving or declining)
 * momentum = winRate_last5 - winRate_season
 */
function signalMomentum(matchup) {
  const me = matchup?.momentum_edge || 0;
  const se = matchup?.streak_edge   || 0;
  const combined = me * 0.70 + se * 0.30;
  return clamp(0.5 + combined * 0.7, 0.25, 0.75);
}

/**
 * 11. Defensive quality (steals + blocks)
 */
function signalDefense(matchup) {
  const de = matchup?.def_edge || 0;
  // def_edge: combined stl+blk advantage (e.g. ±5 raw)
  return clamp(0.5 + de * 0.008, 0.25, 0.75);
}

/**
 * 12. Home / away splits (contextual)
 */
function signalSplits(homeData, awayData) {
  const homeHomeWR = homeData?.recent?.homeWinRate;
  const awayAwayWR = awayData?.recent?.awayWinRate;

  const homeRate  = homeHomeWR ?? homeData?.recent?.winRate ?? 0.5;
  const awayRate  = awayAwayWR ?? awayData?.recent?.winRate ?? 0.5;

  // Combine: home's at-home record vs away's on-road record
  const total = homeRate + (1 - awayRate);
  return clamp(total / 2, 0.25, 0.75);
}

/**
 * 13. Pace / ball movement quality
 */
function signalPace(matchup) {
  const pe  = matchup?.pace_edge || 0;
  const ate = clamp(matchup?.ast_tov_edge * 0.03 || 0, -0.04, 0.04);
  return clamp(0.5 + pe + ate, 0.25, 0.75);
}

// ─── weighted logit blend ──────────────────────────────────────────────────────
/**
 * Combine all signal probabilities in logit space.
 * This is more principled than linear averaging (avoids probability ceiling issues).
 */
function blendSignals(components) {
  if (!components.length) return 0.5;

  let logitSum  = 0;
  let weightSum = 0;

  for (const c of components) {
    const safeP = clamp(c.prob, 0.01, 0.99);
    logitSum  += logit(safeP) * c.weight;
    weightSum += c.weight;
  }

  return sigmoid(logitSum / weightSum);
}

// ─── live score adjustment ─────────────────────────────────────────────────────
/**
 * Adjust pregame probability using live score and time remaining.
 * Uses a logistic model blended with pregame estimate.
 */
function applyLiveAdjustment(pregameProb, liveState) {
  if (!liveState?.liveFound) return pregameProb;

  const homeScore = Number(liveState.homeScore || 0);
  const awayScore = Number(liveState.awayScore || 0);
  const scoreDiff = homeScore - awayScore;

  const period   = Number(liveState.period || 1);
  const clockSec = typeof liveState.clockSec === "number" ? liveState.clockSec : 12 * 60;

  const totalSec   = 4 * 12 * 60;   // 2880
  const elapsedSec = clamp((period - 1) * 12 * 60 + (12 * 60 - clockSec), 0, totalSec);
  const remainSec  = clamp(totalSec - elapsedSec, 0, totalSec);
  const progress   = clamp(elapsedSec / totalSec, 0, 1);

  // Too early to meaningfully adjust
  if (progress < 0.04) return pregameProb;

  // Expected points remaining per team ≈ 100 * remainSec / totalSec
  const remainPts  = remainSec * (100 / totalSec) * 2;
  const leadFactor = scoreDiff / Math.max(Math.sqrt(remainPts), 1);

  // Blend weight: exponential curve so late-game score matters a lot more
  const blendWeight = Math.pow(progress, 1.5);

  const liveLogit = logit(clamp(pregameProb, 0.05, 0.95)) + leadFactor * 1.9;
  const liveProb  = sigmoid(liveLogit);

  return clamp(pregameProb * (1 - blendWeight) + liveProb * blendWeight, 0.01, 0.99);
}

// ─── main export ──────────────────────────────────────────────────────────────
/**
 * computeIndependentWinProb
 *
 * @param {string} homeTeam
 * @param {string} awayTeam
 * @param {object|null} liveState  — from live_tracker (optional)
 * @returns {Promise<{
 *   homeWinProb, pregameHomeProb,
 *   signals, weights, matchupProfile, meta
 * }>}
 */
async function computeIndependentWinProb(homeTeam, awayTeam, liveState = null) {

  // ── 1. Fetch all advanced data ──────────────────────────────────────────
  let advancedData = null;
  try {
    advancedData = await getAdvancedMatchup(homeTeam, awayTeam);
  } catch (err) {
    console.warn(`[stats_model] getAdvancedMatchup failed: ${err.message}`);
  }

  // Graceful fallback: no data → home court only
  if (!advancedData) {
    const fallback = clamp(sigmoid(HOME_COURT_LOGIT_BUMP), 0.45, 0.60);
    return {
      homeWinProb:     roundTo(fallback, 4),
      pregameHomeProb: roundTo(fallback, 4),
      signals:         { fallback: true, reason: "advanced_data_unavailable" },
      weights:         W,
      matchupProfile:  null,
      meta:            { error: "no_advanced_data" }
    };
  }

  const { matchup, homeData, awayData, h2h, homeId, awayId } = advancedData;

  // ── 2. Build each signal ─────────────────────────────────────────────────
  const sig = {
    netRating:       signalNetRating(matchup),
    predictedSpread: signalPredictedSpread(matchup),
    recentForm:      signalRecentForm(matchup),
    starPower:       signalStarPower(matchup),
    shooting:        signalShooting(matchup),
    turnover:        signalTurnover(matchup),
    rest:            signalRest(matchup),
    rebound:         signalRebounding(matchup),
    h2h:             signalH2H(h2h),
    momentum:        signalMomentum(matchup),
    defense:         signalDefense(matchup),
    splits:          signalSplits(homeData, awayData),
    pace:            signalPace(matchup)
  };

  // ── 3. Weighted logit blend ──────────────────────────────────────────────
  const components = Object.entries(sig).map(([label, prob]) => ({
    label,
    prob,
    weight: W[label] || 0
  }));

  let statsHomeProb = blendSignals(components);

  // ── 4. Home court advantage ──────────────────────────────────────────────
  statsHomeProb = sigmoid(logit(clamp(statsHomeProb, 0.01, 0.99)) + HOME_COURT_LOGIT_BUMP);
  statsHomeProb = clamp(statsHomeProb, 0.01, 0.99);

  // ── 5. Live adjustment ───────────────────────────────────────────────────
  let finalProb = statsHomeProb;
  if (liveState?.liveFound) {
    finalProb = applyLiveAdjustment(statsHomeProb, liveState);
  }

  // ── 6. Build diagnostics ─────────────────────────────────────────────────
  const signalDiagnostics = {};
  for (const [label, prob] of Object.entries(sig)) {
    signalDiagnostics[label] = {
      prob:         roundTo(prob, 4),
      weight:       W[label] || 0,
      contribution: roundTo((prob - 0.5) * (W[label] || 0), 4)
    };
  }

  return {
    homeWinProb:     roundTo(finalProb, 4),
    pregameHomeProb: roundTo(statsHomeProb, 4),
    signals: signalDiagnostics,
    weights: W,
    matchupProfile: {
      // Key matchup numbers the UI can display
      net_diff:          matchup?.net_diff         != null ? roundTo(matchup.net_diff, 2) : null,
      predicted_spread:  matchup?.predicted_spread != null ? roundTo(matchup.predicted_spread, 1) : null,
      home_predicted_pts: matchup?.home_predicted_pts != null ? roundTo(matchup.home_predicted_pts, 1) : null,
      away_predicted_pts: matchup?.away_predicted_pts != null ? roundTo(matchup.away_predicted_pts, 1) : null,
      ts_edge:           matchup?.ts_edge           != null ? roundTo(matchup.ts_edge, 4) : null,
      tov_edge:          matchup?.tov_edge          != null ? roundTo(matchup.tov_edge, 2) : null,
      oreb_edge:         matchup?.oreb_edge         != null ? roundTo(matchup.oreb_edge, 4) : null,
      rest_edge:         matchup?.rest_edge         != null ? roundTo(matchup.rest_edge, 4) : null,
      home_rest:         matchup?.home_rest,
      away_rest:         matchup?.away_rest,
      home_b2b:          matchup?.home_b2b,
      away_b2b:          matchup?.away_b2b,
      star_edge:         matchup?.star_edge         != null ? roundTo(matchup.star_edge, 4) : null,
      variance_factor:   matchup?.variance_factor   != null ? roundTo(matchup.variance_factor, 3) : null,
      // Raw advanced stats for display
      homeAdv: homeData?.adv  ? {
        ortg:     roundTo(homeData.adv.ortg, 1),
        ts_pct:   roundTo(homeData.adv.ts_pct, 3),
        efg_pct:  roundTo(homeData.adv.efg_pct, 3),
        tov_rate: roundTo(homeData.adv.tov_rate, 1),
        oreb_pct: roundTo(homeData.adv.oreb_pct, 3),
        ftr:      roundTo(homeData.adv.ftr, 3),
        fg3_rate: roundTo(homeData.adv.fg3_rate, 3),
        ast_tov:  roundTo(homeData.adv.ast_tov, 2),
        stl_rate: roundTo(homeData.adv.stl_rate, 1),
        blk_rate: roundTo(homeData.adv.blk_rate, 3)
      } : null,
      awayAdv: awayData?.adv ? {
        ortg:     roundTo(awayData.adv.ortg, 1),
        ts_pct:   roundTo(awayData.adv.ts_pct, 3),
        efg_pct:  roundTo(awayData.adv.efg_pct, 3),
        tov_rate: roundTo(awayData.adv.tov_rate, 1),
        oreb_pct: roundTo(awayData.adv.oreb_pct, 3),
        ftr:      roundTo(awayData.adv.ftr, 3),
        fg3_rate: roundTo(awayData.adv.fg3_rate, 3),
        ast_tov:  roundTo(awayData.adv.ast_tov, 2),
        stl_rate: roundTo(awayData.adv.stl_rate, 1),
        blk_rate: roundTo(awayData.adv.blk_rate, 3)
      } : null,
      homeNet: homeData?.netRating,
      awayNet: awayData?.netRating,
      homePlayers: {
        star_power:   roundTo(homeData?.players?.star_power || 0, 2),
        depth_score:  roundTo(homeData?.players?.depth_score || 0, 2),
        top_ts:       homeData?.players?.top_ts,
        per_proxy_avg: homeData?.players?.per_proxy_avg,
        top_players:  (homeData?.players?.players || []).slice(0, 3).map(p => ({
          name:      p.name,
          pts:       p.pts,
          ast:       p.ast,
          reb:       p.reb,
          ts_pct:    p.ts_pct,
          per_proxy: p.per_proxy,
          bpm_proxy: p.bpm_proxy
        }))
      },
      awayPlayers: {
        star_power:   roundTo(awayData?.players?.star_power || 0, 2),
        depth_score:  roundTo(awayData?.players?.depth_score || 0, 2),
        top_ts:       awayData?.players?.top_ts,
        per_proxy_avg: awayData?.players?.per_proxy_avg,
        top_players:  (awayData?.players?.players || []).slice(0, 3).map(p => ({
          name:      p.name,
          pts:       p.pts,
          ast:       p.ast,
          reb:       p.reb,
          ts_pct:    p.ts_pct,
          per_proxy: p.per_proxy,
          bpm_proxy: p.bpm_proxy
        }))
      },
      homeSchedule: homeData?.schedule,
      awaySchedule: awayData?.schedule,
      homeForm: homeData?.recent ? {
        winRate:    homeData.recent.winRate,
        winRate5:   homeData.recent.winRate5,
        winRate10:  homeData.recent.winRate10,
        avgDiff:    homeData.recent.avgDiff,
        avgDiff5:   homeData.recent.avgDiff5,
        momentum:   homeData.recent.momentum,
        streak:     homeData.recent.streak,
        avgPtsScored:  homeData.recent.avgPtsScored,
        avgPtsAllowed: homeData.recent.avgPtsAllowed
      } : null,
      awayForm: awayData?.recent ? {
        winRate:    awayData.recent.winRate,
        winRate5:   awayData.recent.winRate5,
        winRate10:  awayData.recent.winRate10,
        avgDiff:    awayData.recent.avgDiff,
        avgDiff5:   awayData.recent.avgDiff5,
        momentum:   awayData.recent.momentum,
        streak:     awayData.recent.streak,
        avgPtsScored:  awayData.recent.avgPtsScored,
        avgPtsAllowed: awayData.recent.avgPtsAllowed
      } : null,
      h2h
    },
    meta: {
      homeId, awayId,
      season:       require("./advanced_stats").getCurrentSeason(),
      weightTotal:  roundTo(W_TOTAL, 4),
      liveAdjusted: !!(liveState?.liveFound),
      signalCount:  components.filter(c => c.prob !== 0.5).length
    }
  };
}

/**
 * computeEdge — compare model prob to market implied prob for pick side.
 */
function computeEdge(modelProb, marketProb) {
  const edge = modelProb - marketProb;

  let verdict = "Avoid";
  if (edge >= 0.05)       verdict = "Bet now";
  else if (edge >= 0.025) verdict = "Watch";

  let confidence = "Low";
  if (edge >= 0.08)       confidence = "High";
  else if (edge >= 0.04)  confidence = "Medium";

  return {
    edge:       roundTo(edge, 4),
    modelProb:  roundTo(modelProb, 4),
    marketProb: roundTo(marketProb, 4),
    verdict,
    confidence
  };
}

module.exports = {
  computeIndependentWinProb,
  computeEdge,
  applyLiveAdjustment,
  SIGNAL_WEIGHTS: W,
  // expose internals for testing
  _signals: {
    signalNetRating, signalPredictedSpread, signalRecentForm,
    signalStarPower, signalShooting, signalTurnover, signalRest,
    signalRebounding, signalH2H, signalMomentum, signalDefense,
    signalSplits, signalPace
  }
};
