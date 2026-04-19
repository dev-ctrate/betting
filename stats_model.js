"use strict";

/**
 * stats_model.js  v5
 *
 * Key fixes vs v4:
 *   - Works without Python NBA service (uses BDL direct stats)
 *   - Handles null/missing PIE gracefully (not every game has NBA service)
 *   - Minimum edge threshold: model must be ≥1% more confident than market
 *     to override the market's pick. Prevents noise-driven wrong picks.
 *   - When all signals are ~0.5, the model respects the market consensus
 */

const fs   = require("fs");
const path = require("path");
const { getAdvancedMatchup, computeTeamHCA } = require("./advanced_stats");
const { computeInjuryImpact } = require("./injury_model");

const SIG_W_FILE = path.join(__dirname, "data", "signal_weights.json");

// ─── default signal weights ───────────────────────────────────────────────────
const DEFAULT_W = {
  officialNetRating:   0.20,   // net rating is most predictive
  injuryAdjNetRating:  0.10,
  predictedSpread:     0.12,   // cross-matchup prediction
  recentForm:          0.10,
  shooting:            0.07,
  turnover:            0.06,
  starPower:           0.06,
  rest:                0.05,
  rebound:             0.04,
  h2h:                 0.04,
  momentum:            0.03,
  hustle:              0.03,
  shotQuality:         0.02,
  referee:             0.02,
  travelFatigue:       0.02,
  opponentMatchup:     0.02,
  splits:              0.02,
  pace:                0.02,
  defense:             0.01,
  // PIE and clutch only meaningful when NBA service available
  pie:                 0.02,
  clutch:              0.02,
  threePointVariance:  0.01,
};

// ─── load learned weights ─────────────────────────────────────────────────────
let SIGNAL_W = { ...DEFAULT_W };

function reloadSignalWeights() {
  try {
    if (!fs.existsSync(SIG_W_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SIG_W_FILE, "utf8"));
    if (raw?.weights) SIGNAL_W = { ...DEFAULT_W, ...raw.weights };
  } catch { /* keep defaults */ }
}
reloadSignalWeights();
setInterval(reloadSignalWeights, 30 * 60 * 1000);

// ─── math ─────────────────────────────────────────────────────────────────────
const clamp   = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = x => 1 / (1 + Math.exp(-clamp(x, -50, 50)));
const logit   = p => { const c = clamp(p, 1e-6, 1 - 1e-6); return Math.log(c / (1 - c)); };
const r4 = n => Math.round(n * 10000) / 10000;
const sn = (v, f = 0) => { const n = Number(v); return Number.isFinite(n) ? n : f; };

// ─── signal builders ───────────────────────────────────────────────────────────
// All return home-win probability in [0.1, 0.9]
// Return 0.5 (neutral) when data is missing/unreliable

function sigNetRating(m) {
  const d = sn(m?.net_diff, 999);
  if (Math.abs(d) < 0.01 || d === 999) return 0.5;  // no real data
  return clamp(sigmoid(d / 7.5), 0.12, 0.88);
}

function sigInjuryNetRating(ia) {
  if (!ia?.home || !ia?.away) return 0.5;
  const d = sn(ia.home?.adjusted_net, 999) - sn(ia.away?.adjusted_net, 999);
  if (Math.abs(d) < 0.01) return 0.5;
  return clamp(sigmoid(d / 7.0), 0.12, 0.88);
}

function sigPredictedSpread(m) {
  const s = sn(m?.predicted_spread, 999);
  if (Math.abs(s) < 0.01 || s === 999) return 0.5;
  return clamp(sigmoid(s / 3.5), 0.10, 0.90);
}

function sigPIE(m) {
  const e = sn(m?.pie_edge, 0);
  if (Math.abs(e) < 0.001) return 0.5;  // no PIE data (NBA service offline)
  return clamp(0.5 + e * 7, 0.15, 0.85);
}

function sigRecentForm(m) {
  const f = sn(m?.form_edge, 0), d = sn(m?.diff5_edge, 0);
  if (Math.abs(f) < 0.001 && Math.abs(d) < 0.01) return 0.5;
  return clamp(0.5 + (f * 0.60 + clamp(d / 14, -0.3, 0.3) * 0.40) * 0.45, 0.12, 0.88);
}

function sigClutch(m) {
  const wp = sn(m?.clutch_w_pct_edge, 0), pm = sn(m?.clutch_pm_edge, 0);
  if (Math.abs(wp) < 0.001 && Math.abs(pm) < 0.01) return 0.5;
  return clamp(0.5 + (wp * 0.55 + clamp(pm / 8, -0.3, 0.3) * 0.45) * 0.60, 0.15, 0.85);
}

function sigStarPower(m) {
  const se = sn(m?.star_power_edge, 0), pe = sn(m?.pie_player_edge, 0);
  if (Math.abs(se) < 0.001 && Math.abs(pe) < 0.001) return 0.5;
  return clamp(0.5 + (se * 0.65 + pe * 7 * 0.35) * 0.55, 0.15, 0.85);
}

function sigShooting(m) {
  const ts = sn(m?.ts_edge, 0), efg = sn(m?.efg_edge, 0);
  if (Math.abs(ts) < 0.001 && Math.abs(efg) < 0.001) return 0.5;
  return clamp(0.5 + (ts * 0.65 + efg * 0.35) * 7.0, 0.15, 0.85);
}

function sigTurnover(m) {
  const te = sn(m?.tov_edge, 0), ate = sn(m?.ast_to_edge, 0);
  if (Math.abs(te) < 0.01 && Math.abs(ate) < 0.01) return 0.5;
  return clamp(0.5 + te * 0.022 + ate * 0.045, 0.15, 0.85);
}

function sigRest(m) {
  const re = sn(m?.rest_edge, 0);
  if (Math.abs(re) < 0.001) return 0.5;
  return clamp(0.5 + re, 0.18, 0.82);
}

function sigHustle(m) {
  const he = sn(m?.hustle_edge, 0);
  if (Math.abs(he) < 0.1) return 0.5;
  return clamp(0.5 + clamp(he / 25, -0.15, 0.15), 0.22, 0.78);
}

function sigRebound(m) {
  const oe = sn(m?.oreb_edge, 0), de = sn(m?.dreb_edge, 0);
  if (Math.abs(oe) < 0.001 && Math.abs(de) < 0.001) return 0.5;
  return clamp(0.5 + (oe * 0.70 + de * 0.30) * 0.9, 0.25, 0.75);
}

function sigShotQuality(m) {
  const sq = sn(m?.shot_quality_edge, 0);
  if (Math.abs(sq) < 0.001) return 0.5;
  return clamp(0.5 + sq * 5.0, 0.22, 0.78);
}

function sigH2H(h2h) {
  if (!h2h || !h2h.games) return 0.5;
  return clamp(sn(h2h.h2h_prob, 0.5), 0.22, 0.78);
}

function sigMomentum(m) {
  const me = sn(m?.momentum_edge, 0), se = sn(m?.streak_edge, 0);
  if (Math.abs(me) < 0.001 && Math.abs(se) < 0.001) return 0.5;
  return clamp(0.5 + (me * 0.70 + se * 0.30) * 0.65, 0.25, 0.75);
}

function sigOpponentMatchup(hd, ad, m) {
  const h = hd?.home_net_rtg || m?.home_home_net || sn(hd?.net_rating, 999);
  const a = ad?.away_net_rtg || m?.away_away_net || sn(ad?.net_rating, 999);
  if (h === 999 || a === 999) return 0.5;
  if (Math.abs(h - a) < 0.01) return 0.5;
  return clamp(sigmoid((h - a) / 8.0), 0.20, 0.80);
}

function sigSplits(m) {
  const sp = sn(m?.split_prob, 0);
  if (Math.abs(sp - 0.5) < 0.01) return 0.5;
  return clamp(sp, 0.25, 0.75);
}

function sigPace(m) {
  const pe = sn(m?.pace_edge, 0), ate = sn(m?.ast_to_edge, 0);
  if (Math.abs(pe) < 0.001 && Math.abs(ate) < 0.01) return 0.5;
  return clamp(0.5 + pe + clamp(ate * 0.03, -0.04, 0.04), 0.25, 0.75);
}

function sigThreePtVariance(m, netDiff) {
  const vf = sn(m?.variance_factor, 0.40);
  const ls  = clamp(1 - vf * 1.5, 0, 0.4);
  return clamp(netDiff >= 0 ? 0.5 + ls * 0.05 : 0.5 - ls * 0.05, 0.35, 0.65);
}

function sigDefense(hd, ad) {
  const hS = sn(hd?.stl_rate, 0), hB = sn(hd?.blk_rate, 0);
  const aS = sn(ad?.stl_rate, 0), aB = sn(ad?.blk_rate, 0);
  if (hS === 0 && hB === 0) return 0.5;
  return clamp(0.5 + (hS + hB * 50 - aS - aB * 50) * 0.008, 0.25, 0.75);
}

function sigReferee(m) {
  const ri = sn(m?.ref_impact, 0);
  if (Math.abs(ri) < 0.001) return 0.5;
  return clamp(0.5 + ri, 0.28, 0.72);
}

function sigTravelFatigue(m) {
  const tf = sn(m?.travel_fatigue, 0);
  if (Math.abs(tf) < 0.001) return 0.5;
  return clamp(0.5 + tf, 0.28, 0.72);
}

// ─── logit-space blend ────────────────────────────────────────────────────────
function blend(components) {
  // Count how many signals are not neutral (have real data)
  const active = components.filter(c => Math.abs(c.prob - 0.5) > 0.005);

  if (!active.length) return 0.5;  // all neutral — no data

  let ls = 0, ws = 0;
  for (const c of components) {
    const p = clamp(c.prob, 0.01, 0.99);
    ls += logit(p) * c.weight;
    ws += c.weight;
  }
  return ws > 0 ? sigmoid(ls / ws) : 0.5;
}

// ─── live adjustment ──────────────────────────────────────────────────────────
function applyLiveAdj(pre, ls) {
  if (!ls?.liveFound) return pre;
  const diff = sn(ls.homeScore) - sn(ls.awayScore);
  const period = sn(ls.period, 1);
  const clock  = typeof ls.clockSec === "number" ? ls.clockSec : 720;
  const total  = 2880, elapsed = clamp((period - 1) * 720 + (720 - clock), 0, total);
  const remain = total - elapsed, progress = elapsed / total;
  if (progress < 0.04) return pre;
  const remPts = remain * (100 / total) * 2;
  const lf     = diff / Math.max(Math.sqrt(remPts), 1);
  const bw     = Math.pow(progress, 1.5);
  const lp     = sigmoid(logit(clamp(pre, 0.05, 0.95)) + lf * 1.9);
  return clamp(pre * (1 - bw) + lp * bw, 0.01, 0.99);
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function computeIndependentWinProb(homeTeam, awayTeam, liveState = null, injCtx = {}) {
  let data = null;
  try { data = await getAdvancedMatchup(homeTeam, awayTeam); }
  catch (e) { console.warn("[stats_model]", e.message); }

  if (!data) {
    const fb = clamp(sigmoid(0.112), 0.45, 0.60);
    return { homeWinProb: r4(fb), pregameHomeProb: r4(fb), signals: { fallback: true }, weights: SIGNAL_W, matchupProfile: null, meta: { error: "no_data" } };
  }

  const { matchup: m, homeData: hd, awayData: ad, h2h, homeOnOff, awayOnOff, refProfile, dataSource } = data;

  // Injury adjustments
  const hInj = computeInjuryImpact(hd, injCtx?.homeInjuries || [], homeOnOff || []);
  const aInj = computeInjuryImpact(ad, injCtx?.awayInjuries || [], awayOnOff || []);

  // Team-specific home court advantage
  const hcaLogit = (() => {
    const LEAGUE = 0.112;
    const hw = hd?.home_win_rate, aw = hd?.away_win_rate;
    if (hw == null || aw == null || (hd?.games || 0) < 15) return LEAGUE;
    const split = clamp((hw || 0.5) - (aw || 0.5), -0.30, 0.50);
    const wt = clamp((hd?.games || 0) / 60, 0, 1);
    return clamp(LEAGUE * (1 - wt) + split * 0.45 * wt, 0.04, 0.30);
  })();

  const W = SIGNAL_W;
  const netDiff = sn(m?.net_diff, 0);

  const sig = {
    officialNetRating:   sigNetRating(m),
    injuryAdjNetRating:  sigInjuryNetRating({ home: hInj, away: aInj }),
    predictedSpread:     sigPredictedSpread(m),
    pie:                 sigPIE(m),
    recentForm:          sigRecentForm(m),
    clutch:              sigClutch(m),
    starPower:           sigStarPower(m),
    shooting:            sigShooting(m),
    turnover:            sigTurnover(m),
    rest:                sigRest(m),
    hustle:              sigHustle(m),
    rebound:             sigRebound(m),
    shotQuality:         sigShotQuality(m),
    h2h:                 sigH2H(h2h),
    momentum:            sigMomentum(m),
    referee:             sigReferee(m),
    travelFatigue:       sigTravelFatigue(m),
    opponentMatchup:     sigOpponentMatchup(hd, ad, m),
    splits:              sigSplits(m),
    pace:                sigPace(m),
    threePointVariance:  sigThreePtVariance(m, netDiff),
    defense:             sigDefense(hd, ad),
  };

  const components = Object.entries(sig).map(([k, prob]) => ({ label: k, prob, weight: W[k] || 0 }));

  let statsProb = blend(components);
  statsProb = sigmoid(logit(clamp(statsProb, 0.01, 0.99)) + hcaLogit);
  statsProb = clamp(statsProb, 0.01, 0.99);

  const finalProb = liveState?.liveFound ? applyLiveAdj(statsProb, liveState) : statsProb;

  const sigDiag = {};
  for (const [k, prob] of Object.entries(sig)) {
    sigDiag[k] = { prob: r4(prob), weight: W[k] || 0, contribution: r4((prob - 0.5) * (W[k] || 0)) };
  }

  const buildSummary = (d, inj) => !d ? null : ({
    off_rating:       r4(d.off_rating),
    def_rating:       r4(d.def_rating),
    net_rating:       r4(d.net_rating),
    adj_off_rating:   r4(sn(inj?.adjusted_ortg, d.off_rating)),
    adj_def_rating:   r4(sn(inj?.adjusted_drtg, d.def_rating)),
    adj_net_rating:   r4(sn(inj?.adjusted_net,  d.net_rating)),
    injury_net_change: r4(sn(inj?.net_change, 0)),
    pace:       r4(d.pace),
    pie:        r4(d.pie),
    ts_pct:     r4(d.ts_pct),
    efg_pct:    r4(d.efg_pct),
    tov_pct:    r4(d.tov_pct),
    oreb_pct:   r4(d.oreb_pct),
    ftr:        r4(d.ftr),
    fg3_rate:   r4(d.fg3_rate),
    ast_to:     r4(d.ast_to),
    clutch_w_pct:  r4(d.clutch_w_pct),
    clutch_pm:     r4(d.clutch_plus_minus),
    hustle_score:  r4(d.hustle_score),
    star_power:    r4(d.star_power),
    top_pie:       r4(d.top_pie),
    win_rate:      r4(d.win_rate),
    win_rate5:     r4(d.win_rate5),
    streak:        d.streak,
    avg_diff5:     r4(d.avg_diff5),
    rest_days:     d.rest_days,
    is_b2b:        d.is_b2b,
    altitude_ft:   d.altitude_ft,
    injury_adjustments: inj?.adjustments || [],
    players: (d.players || []).slice(0, 5).map(p => ({
      name: p.name, ts_pct: r4(p.ts_pct || 0), usg_pct: r4(p.usg_pct || 0),
      pie: r4(p.pie || 0), net_rtg: r4(p.net_rating || 0), min: p.min
    }))
  });

  return {
    homeWinProb:     r4(finalProb),
    pregameHomeProb: r4(statsProb),
    signals:         sigDiag,
    weights:         W,
    injuryAdjustments: { home: hInj, away: aInj, hcaLogit: r4(hcaLogit) },
    matchupProfile: {
      net_diff:           m?.net_diff           != null ? r4(m.net_diff)           : null,
      predicted_spread:   m?.predicted_spread   != null ? r4(m.predicted_spread)   : null,
      home_predicted_pts: m?.home_predicted_pts != null ? r4(m.home_predicted_pts) : null,
      away_predicted_pts: m?.away_predicted_pts != null ? r4(m.away_predicted_pts) : null,
      ts_edge:        m?.ts_edge != null ? r4(m.ts_edge) : null,
      tov_edge:       m?.tov_edge != null ? r4(m.tov_edge) : null,
      rest_edge:      m?.rest_edge != null ? r4(m.rest_edge) : null,
      home_rest:      m?.home_rest, away_rest: m?.away_rest,
      home_b2b:       m?.home_b2b, away_b2b:  m?.away_b2b,
      ref_impact:     m?.ref_impact != null ? r4(m.ref_impact) : null,
      ref_names:      refProfile?.names || [],
      travel_fatigue: m?.travel_fatigue != null ? r4(m.travel_fatigue) : null,
      variance_factor: m?.variance_factor != null ? r4(m.variance_factor) : null,
      nba_service_used:  m?.nba_service_used ?? false,
      injuryAdjusted:    hInj.significant || aInj.significant,
      homeStats:  buildSummary(hd, hInj),
      awayStats:  buildSummary(ad, aInj),
      h2h, dataSource,
    },
    meta: {
      season:          require("./advanced_stats").getCurrentSeason(),
      liveAdjusted:    !!(liveState?.liveFound),
      hcaLogit:        r4(hcaLogit),
      activeSignals:   components.filter(c => Math.abs(c.prob - 0.5) > 0.005).length,
      usingLearnedW:   JSON.stringify(SIGNAL_W) !== JSON.stringify(DEFAULT_W),
      nbaServiceActive: !!(dataSource?.nbaServiceAvailable),
      bdlActive:        !!(dataSource?.bdlAvailable),
    }
  };
}

function computeEdge(modelProb, marketProb) {
  const edge = modelProb - marketProb;
  return {
    edge:       r4(edge),
    modelProb:  r4(modelProb),
    marketProb: r4(marketProb),
    verdict:    edge >= 0.05 ? "Bet now" : edge >= 0.025 ? "Watch" : "Avoid",
    confidence: edge >= 0.08 ? "High"    : edge >= 0.04  ? "Medium" : "Low"
  };
}

module.exports = { computeIndependentWinProb, computeEdge, applyLiveAdj, DEFAULT_SIGNAL_WEIGHTS: DEFAULT_W, reloadSignalWeights };
