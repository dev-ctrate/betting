"use strict";

/**
 * stats_model.js  v3  —  fully independent win probability engine
 *
 * Uses advanced_stats.js (BallDontLie + nba_api via Python service).
 * Does NOT use sportsbook odds as input anywhere.
 *
 * ─── 16 signals ─────────────────────────────────────────────────────────────
 *
 *  Signal              Weight   Source           Notes
 *  ─────────────────────────────────────────────────────────────────────────
 *  officialNetRating   0.22     NBA API          ORtg–DRtg opponent-adjusted
 *  predictedSpread     0.12     NBA API          cross-matchup ORtg×DRtg
 *  recentForm          0.10     BDL game log     last-10 win% + point diff
 *  pie                 0.09     NBA API          Player Impact Estimate team avg
 *  starPower           0.08     NBA API          USG%×ORtg + PIE per player
 *  shooting            0.07     NBA API          official TS% + eFG%
 *  clutch              0.07     NBA API          win% within 5 last 5 min
 *  turnover            0.06     NBA API          official TM_TOV_PCT
 *  rest                0.05     BDL game log     rest days + B2B penalty
 *  hustle              0.04     NBA API          contested shots, charges
 *  rebound             0.04     NBA API          official OREB%
 *  h2h                 0.03     BDL              current season H2H
 *  momentum            0.03     BDL game log     recent form trend
 *  shotQuality         0.03     NBA API          shot location vs D allowed
 *  splits              0.02     BDL game log     home/away contextual
 *  pace                0.02     NBA API          pace conflict + AST/TO
 *  ─────────────────────────────────────────────────────────────────────────
 *  Total               1.00
 *
 * Blending: logit space (avoids linear probability ceiling issues).
 * Home court: additive logit bump calibrated to +2.8% at p=0.50.
 * Live adjustment: progress-weighted lead/deficit formula.
 */

const { getAdvancedMatchup } = require("./advanced_stats");

// ─── signal weights ────────────────────────────────────────────────────────
const W = {
  officialNetRating: 0.22,
  predictedSpread:   0.12,
  recentForm:        0.10,
  pie:               0.09,
  starPower:         0.08,
  shooting:          0.07,
  clutch:            0.07,
  turnover:          0.06,
  rest:              0.05,
  hustle:            0.04,
  rebound:           0.04,
  h2h:               0.03,
  momentum:          0.03,
  shotQuality:       0.03,
  splits:            0.02,
  pace:              0.02,
};

const HOME_COURT_LOGIT = 0.112;  // ≈ +2.8% at p=0.50

// ─── math ──────────────────────────────────────────────────────────────────
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function sigmoid(x)  { return 1 / (1 + Math.exp(-clamp(x, -50, 50))); }
function logit(p)    { const c = clamp(p, 1e-6, 1-1e-6); return Math.log(c / (1-c)); }
function roundTo(n, d=4) { return Math.round(n * (10**d)) / (10**d); }
function safeNum(v, fb=0) { const n = Number(v); return Number.isFinite(n) ? n : fb; }

// ─── individual signal builders ────────────────────────────────────────────
// Each returns a probability in [0.10, 0.90] for the HOME team.

/** Official NBA Net Rating (ORtg–DRtg opponent-adjusted). +7.5 pts = sigmoid unit. */
function sigNetRating(m) {
  const d = safeNum(m?.net_diff, 0);
  return clamp(sigmoid(d / 7.5), 0.12, 0.88);
}

/** Cross-matchup predicted score differential. Each 3.5 pts ≈ 1 logit. */
function sigPredictedSpread(m) {
  const s = safeNum(m?.predicted_spread, 0);
  return clamp(sigmoid(s / 3.5), 0.10, 0.90);
}

/** Last-10 win rate + recent point diff */
function sigRecentForm(m) {
  const f = safeNum(m?.form_edge,  0);   // win% diff, last-10
  const d = safeNum(m?.diff5_edge, 0);   // avg point diff last-5
  const c = f * 0.60 + clamp(d / 14, -0.30, 0.30) * 0.40;
  return clamp(0.5 + c * 0.45, 0.12, 0.88);
}

/** Official NBA PIE (Player Impact Estimate) — team average. */
function sigPIE(m) {
  const e = safeNum(m?.pie_edge, 0);
  // PIE difference of 0.04 (4 pct pts) → meaningful, scale ×7
  return clamp(0.5 + e * 7, 0.15, 0.85);
}

/** Player star power (official USG% × ORtg + PIE). */
function sigStarPower(m) {
  const se = safeNum(m?.star_power_edge, 0);       // normalised to ~[-0.5, 0.5]
  const pe = safeNum(m?.pie_player_edge, 0);        // top player PIE delta
  const ne = safeNum(m?.net_rtg_top3_edge, 0);      // top-3 player avg net rtg delta
  const c  = se * 0.50 + pe * 7 * 0.30 + clamp(ne / 8, -0.3, 0.3) * 0.20;
  return clamp(0.5 + c * 0.55, 0.15, 0.85);
}

/** Official TS% + eFG% differential. */
function sigShooting(m) {
  const ts  = safeNum(m?.ts_edge,  0);
  const efg = safeNum(m?.efg_edge, 0);
  const c   = ts * 0.65 + efg * 0.35;
  return clamp(0.5 + c * 7.0, 0.15, 0.85);
}

/** Clutch win% + clutch +/- (official NBA, last 5 min within 5 pts). */
function sigClutch(m) {
  const wp  = safeNum(m?.clutch_w_pct_edge,      0);   // win% diff in clutch
  const pm  = safeNum(m?.clutch_plus_minus_edge, 0);   // +/- diff in clutch
  const ft  = safeNum(m?.clutch_ft_edge,         0);   // FT% diff in clutch (pressure FTs)
  const c   = wp * 0.55 + clamp(pm / 8, -0.3, 0.3) * 0.30 + ft * 0.80 * 0.15;
  return clamp(0.5 + c * 0.60, 0.15, 0.85);
}

/** Official TM_TOV_PCT differential (lower = better → invert). */
function sigTurnover(m) {
  const te  = safeNum(m?.tov_edge,    0);   // away_tov - home_tov (+ = home adv)
  const ate = safeNum(m?.ast_to_edge, 0);   // AST/TOV ratio edge
  const c   = te * 0.022 + ate * 0.045;
  return clamp(0.5 + c, 0.15, 0.85);
}

/** Rest days differential + B2B penalty (from BDL game log dates). */
function sigRest(m) {
  const re = safeNum(m?.rest_edge, 0);
  return clamp(0.5 + re, 0.18, 0.82);
}

/** Hustle composite: contested shots, charges drawn, screen AST pts. */
function sigHustle(m) {
  const he = safeNum(m?.hustle_edge,   0);    // composite score delta
  const ce = safeNum(m?.charges_edge,  0);    // charges drawn delta
  const cte= safeNum(m?.contested_edge,0);    // contested shots delta
  const c  = clamp(he / 25, -0.15, 0.15) +
             clamp(ce * 0.04, -0.05, 0.05) +
             clamp(cte * 0.003, -0.04, 0.04);
  return clamp(0.5 + c, 0.22, 0.78);
}

/** Official OREB_PCT differential. */
function sigRebound(m) {
  const oe = safeNum(m?.oreb_edge, 0);
  const de = safeNum(m?.dreb_edge, 0);
  const c  = oe * 0.70 + de * 0.30;
  return clamp(0.5 + c * 0.9, 0.25, 0.75);
}

/** H2H current season (BDL). */
function sigH2H(h2h) {
  if (!h2h) return 0.5;
  return clamp(safeNum(h2h.h2h_prob, 0.5), 0.22, 0.78);
}

/** Momentum: recent win% trend + streak. */
function sigMomentum(m) {
  const me = safeNum(m?.momentum_edge, 0);
  const se = safeNum(m?.streak_edge,   0);
  return clamp(0.5 + (me * 0.70 + se * 0.30) * 0.65, 0.25, 0.75);
}

/**
 * Shot quality matchup: how well each offense's shot selection
 * matches up against the other team's shot defense.
 * Uses official NBA zone-by-zone defense data.
 */
function sigShotQuality(m) {
  const sq  = safeNum(m?.shot_quality_edge,  0);   // ts vs opp def quality
  const tm  = safeNum(m?.three_matchup_edge, 0);   // 3pt% vs opp 3pt D
  const rim = safeNum(m?.rim_edge,           0);   // rim frequency vs opp rim D
  const c   = sq * 5.0 + tm * 3.0 + rim * 2.5;
  return clamp(0.5 + c, 0.22, 0.78);
}

/** Home/away split context. */
function sigSplits(m) {
  const sp = safeNum(m?.split_prob, 0.5);
  return clamp(sp, 0.25, 0.75);
}

/** Pace preference conflict + AST/TO quality. */
function sigPace(m) {
  const pe  = safeNum(m?.pace_edge,   0);
  const ate = safeNum(m?.ast_to_edge, 0);
  return clamp(0.5 + pe + clamp(ate * 0.03, -0.04, 0.04), 0.25, 0.75);
}

// ─── logit-space weighted blend ────────────────────────────────────────────
function blendSignals(components) {
  if (!components.length) return 0.5;
  let ls = 0, ws = 0;
  for (const c of components) {
    ls += logit(clamp(c.prob, 0.01, 0.99)) * c.weight;
    ws += c.weight;
  }
  return sigmoid(ls / ws);
}

// ─── live adjustment ────────────────────────────────────────────────────────
function applyLiveAdjustment(pregame, ls) {
  if (!ls?.liveFound) return pregame;
  const diff   = safeNum(ls.homeScore) - safeNum(ls.awayScore);
  const period = safeNum(ls.period, 1);
  const clock  = typeof ls.clockSec === "number" ? ls.clockSec : 720;
  const total  = 2880;
  const elapsed = clamp((period-1)*720 + (720-clock), 0, total);
  const remain  = total - elapsed;
  const progress = elapsed / total;
  if (progress < 0.04) return pregame;
  const remPts   = remain * (100/total) * 2;
  const leadFactor = diff / Math.max(Math.sqrt(remPts), 1);
  const blend    = Math.pow(progress, 1.5);
  const liveProb = sigmoid(logit(clamp(pregame,0.05,0.95)) + leadFactor * 1.9);
  return clamp(pregame * (1 - blend) + liveProb * blend, 0.01, 0.99);
}

// ─── main ──────────────────────────────────────────────────────────────────
async function computeIndependentWinProb(homeTeam, awayTeam, liveState = null) {

  let data = null;
  try { data = await getAdvancedMatchup(homeTeam, awayTeam); }
  catch (e) { console.warn("[stats_model] getAdvancedMatchup failed:", e.message); }

  if (!data) {
    const fb = clamp(sigmoid(HOME_COURT_LOGIT), 0.45, 0.60);
    return { homeWinProb: roundTo(fb,4), pregameHomeProb: roundTo(fb,4),
             signals: { fallback:true }, weights: W, matchupProfile: null,
             meta: { error:"no_data" } };
  }

  const { matchup: m, homeData, awayData, h2h, dataSource } = data;

  // Build signals
  const sig = {
    officialNetRating: sigNetRating(m),
    predictedSpread:   sigPredictedSpread(m),
    recentForm:        sigRecentForm(m),
    pie:               sigPIE(m),
    starPower:         sigStarPower(m),
    shooting:          sigShooting(m),
    clutch:            sigClutch(m),
    turnover:          sigTurnover(m),
    rest:              sigRest(m),
    hustle:            sigHustle(m),
    rebound:           sigRebound(m),
    h2h:               sigH2H(h2h),
    momentum:          sigMomentum(m),
    shotQuality:       sigShotQuality(m),
    splits:            sigSplits(m),
    pace:              sigPace(m),
  };

  const components = Object.entries(sig).map(([k, prob]) => ({ label:k, prob, weight: W[k]||0 }));

  // Blend + home court
  let statsProb = blendSignals(components);
  statsProb = sigmoid(logit(clamp(statsProb,0.01,0.99)) + HOME_COURT_LOGIT);
  statsProb = clamp(statsProb, 0.01, 0.99);

  // Live adjustment
  const finalProb = liveState?.liveFound ? applyLiveAdjustment(statsProb, liveState) : statsProb;

  // Signal diagnostics
  const signalDiag = {};
  for (const [k, prob] of Object.entries(sig)) {
    signalDiag[k] = { prob: roundTo(prob,4), weight: W[k]||0, contribution: roundTo((prob-0.5)*(W[k]||0),4) };
  }

  return {
    homeWinProb:     roundTo(finalProb, 4),
    pregameHomeProb: roundTo(statsProb, 4),
    signals:         signalDiag,
    weights:         W,
    matchupProfile: {
      // Key numbers for display
      net_diff:          m?.net_diff          != null ? roundTo(m.net_diff,2)          : null,
      predicted_spread:  m?.predicted_spread  != null ? roundTo(m.predicted_spread,1)  : null,
      home_predicted_pts: m?.home_predicted_pts != null ? roundTo(m.home_predicted_pts,1) : null,
      away_predicted_pts: m?.away_predicted_pts != null ? roundTo(m.away_predicted_pts,1) : null,
      pie_edge:          m?.pie_edge          != null ? roundTo(m.pie_edge,4)          : null,
      ts_edge:           m?.ts_edge           != null ? roundTo(m.ts_edge,4)           : null,
      tov_edge:          m?.tov_edge          != null ? roundTo(m.tov_edge,2)          : null,
      oreb_edge:         m?.oreb_edge         != null ? roundTo(m.oreb_edge,4)         : null,
      rest_edge:         m?.rest_edge         != null ? roundTo(m.rest_edge,4)         : null,
      clutch_w_pct_edge: m?.clutch_w_pct_edge != null ? roundTo(m.clutch_w_pct_edge,4) : null,
      hustle_edge:       m?.hustle_edge       != null ? roundTo(m.hustle_edge,2)       : null,
      star_power_edge:   m?.star_power_edge   != null ? roundTo(m.star_power_edge,4)   : null,
      variance_factor:   m?.variance_factor   != null ? roundTo(m.variance_factor,3)   : null,
      home_rest:         m?.home_rest,
      away_rest:         m?.away_rest,
      home_b2b:          m?.home_b2b,
      away_b2b:          m?.away_b2b,
      nba_service_used:  m?.nba_service_used ?? false,

      // Full per-team advanced stats for the UI
      homeStats: homeData ? {
        off_rating:  roundTo(homeData.off_rating,1),
        def_rating:  roundTo(homeData.def_rating,1),
        net_rating:  roundTo(homeData.net_rating,1),
        pace:        roundTo(homeData.pace,1),
        pie:         roundTo(homeData.pie,4),
        ts_pct:      roundTo(homeData.ts_pct,3),
        efg_pct:     roundTo(homeData.efg_pct,3),
        tov_pct:     roundTo(homeData.tov_pct,1),
        oreb_pct:    roundTo(homeData.oreb_pct,3),
        ftr:         roundTo(homeData.ftr,3),
        fg3_rate:    roundTo(homeData.fg3_rate,3),
        ast_to:      roundTo(homeData.ast_to,2),
        clutch_w_pct: roundTo(homeData.clutch_w_pct,3),
        clutch_pm:   roundTo(homeData.clutch_plus_minus,1),
        hustle_score: roundTo(homeData.hustle_score,1),
        star_power:  roundTo(homeData.star_power,1),
        top_pie:     roundTo(homeData.top_pie,4),
        win_rate:    roundTo(homeData.win_rate,3),
        win_rate5:   roundTo(homeData.win_rate5,3),
        streak:      homeData.streak,
        avg_diff5:   roundTo(homeData.avg_diff5,1),
        rest_days:   homeData.rest_days,
        is_b2b:      homeData.is_b2b,
        players:     (homeData.players||[]).slice(0,4).map(p=>({
          name:p.name, ts_pct:roundTo(p.ts_pct||0,3), usg_pct:roundTo(p.usg_pct||0,3),
          pie:roundTo(p.pie||0,4), net_rtg:roundTo(p.net_rtg||0,1), min:p.min
        }))
      } : null,
      awayStats: awayData ? {
        off_rating:  roundTo(awayData.off_rating,1),
        def_rating:  roundTo(awayData.def_rating,1),
        net_rating:  roundTo(awayData.net_rating,1),
        pace:        roundTo(awayData.pace,1),
        pie:         roundTo(awayData.pie,4),
        ts_pct:      roundTo(awayData.ts_pct,3),
        efg_pct:     roundTo(awayData.efg_pct,3),
        tov_pct:     roundTo(awayData.tov_pct,1),
        oreb_pct:    roundTo(awayData.oreb_pct,3),
        ftr:         roundTo(awayData.ftr,3),
        fg3_rate:    roundTo(awayData.fg3_rate,3),
        ast_to:      roundTo(awayData.ast_to,2),
        clutch_w_pct: roundTo(awayData.clutch_w_pct,3),
        clutch_pm:   roundTo(awayData.clutch_plus_minus,1),
        hustle_score: roundTo(awayData.hustle_score,1),
        star_power:  roundTo(awayData.star_power,1),
        top_pie:     roundTo(awayData.top_pie,4),
        win_rate:    roundTo(awayData.win_rate,3),
        win_rate5:   roundTo(awayData.win_rate5,3),
        streak:      awayData.streak,
        avg_diff5:   roundTo(awayData.avg_diff5,1),
        rest_days:   awayData.rest_days,
        is_b2b:      awayData.is_b2b,
        players:     (awayData.players||[]).slice(0,4).map(p=>({
          name:p.name, ts_pct:roundTo(p.ts_pct||0,3), usg_pct:roundTo(p.usg_pct||0,3),
          pie:roundTo(p.pie||0,4), net_rtg:roundTo(p.net_rtg||0,1), min:p.min
        }))
      } : null,
      h2h,
      dataSource
    },
    meta: {
      season:       require("./advanced_stats").getCurrentSeason(),
      liveAdjusted: !!(liveState?.liveFound),
      signalCount:  components.filter(c => c.prob !== 0.5).length,
      nbaServiceActive: !!(data.dataSource?.nbaServiceAvailable),
    }
  };
}

function computeEdge(modelProb, marketProb) {
  const edge = modelProb - marketProb;
  return {
    edge:       roundTo(edge, 4),
    modelProb:  roundTo(modelProb, 4),
    marketProb: roundTo(marketProb, 4),
    verdict:    edge >= 0.05 ? "Bet now" : edge >= 0.025 ? "Watch" : "Avoid",
    confidence: edge >= 0.08 ? "High"    : edge >= 0.04  ? "Medium" : "Low"
  };
}

module.exports = {
  computeIndependentWinProb,
  computeEdge,
  applyLiveAdjustment,
  SIGNAL_WEIGHTS: W,
};
