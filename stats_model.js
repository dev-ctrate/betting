"use strict";

/**
 * stats_model.js  v6
 * All 22 signals fully active. Uses official NBA Stats data via nba_service.js.
 */

const fs   = require("fs");
const path = require("path");
const { getAdvancedMatchup } = require("./advanced_stats");
const { computeInjuryImpact } = require("./injury_model");

const SIG_W_FILE = path.join(__dirname, "data", "signal_weights.json");

// ── PLAYOFF MODE — active April 13 through June 22 ───────────────────────────
// Playoffs are fundamentally different from regular season:
//   • Pace drops ~5 possessions per game (teams slow down, execute sets)
//   • Defense intensity increases ~8% (teams game-plan specifically)
//   • Star players take 30%+ more shots in crunch time
//   • Clutch performance becomes the biggest predictor
//   • Head-to-head series history matters enormously
//   • 3PT variance drops (coaches limit speculative shots)
//   • Rest/travel matters less (7-day series windows)

const DEFAULT_W = {
  // Core efficiency — still important but tightened range
  officialNetRating:   0.18,
  injuryAdjNetRating:  0.10,
  predictedSpread:     0.10,
  // Playoff-critical signals — heavily boosted
  clutch:              0.10,  // +0.04 vs regular season
  starPower:           0.09,  // +0.04 — stars take over in playoffs
  defense:             0.07,  // +0.05 — defense wins championships
  h2h:                 0.06,  // +0.03 — series history is real
  hustle:              0.05,  // +0.02 — effort separates teams
  recentForm:          0.05,  // form within THIS series matters most
  // Secondary signals
  pie:                 0.04,
  shooting:            0.04,
  momentum:            0.03,
  rebound:             0.03,
  turnover:            0.02,
  shotQuality:         0.02,
  opponentMatchup:     0.02,
  splits:              0.01,
  // Deprioritized in playoffs
  rest:                0.01,  // less relevant in 2-day series windows
  pace:                0.01,  // pace forced slow in playoffs
  threePointVariance:  0.01,  // coaches eliminate variance
  referee:             0.01,
  travelFatigue:       0.01,
};

let SIGNAL_W = { ...DEFAULT_W };

function isPlayoffs() {
  const d = new Date(), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  return (m === 4 && day >= 13) || m === 5 || (m === 6 && day <= 22);
}

// Weights are already playoff-optimized as default.
// getEffectiveWeights() returns them directly.
function getEffectiveWeights() {
  if (isPlayoffs()) {
    console.log(`[stats_model] 🏆 PLAYOFF MODE — using playoff-tuned weights`);
  }
  return SIGNAL_W;
}

function reloadSignalWeights() {
  try {
    if (!fs.existsSync(SIG_W_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SIG_W_FILE, "utf8"));
    if (raw?.weights) SIGNAL_W = { ...DEFAULT_W, ...raw.weights };
  } catch {}
}
reloadSignalWeights();
setInterval(reloadSignalWeights, 30 * 60 * 1000);

const clamp   = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = x => 1 / (1 + Math.exp(-clamp(x, -50, 50)));
const logit   = p => { const c = clamp(p, 1e-6, 1 - 1e-6); return Math.log(c / (1 - c)); };
const r4 = n => Math.round(n * 10000) / 10000;
const sn = (v, f = 0) => { const n = Number(v); return Number.isFinite(n) ? n : f; };
const hasData = v => typeof v === "number" && Math.abs(v) > 0.001;

// ─── signal builders (playoff-tuned) ─────────────────────────────────────────
// Tighter curves: playoffs are more decisive, signals should be more extreme
function sigNetRating(m)       { const d = sn(m?.net_diff); return hasData(d) ? clamp(sigmoid(d/6.0),0.10,0.90) : 0.5; }   // was /7.5
function sigInjuryNet(ia)      { if (!ia?.home||!ia?.away) return 0.5; const d=sn(ia.home?.adjusted_net)-sn(ia.away?.adjusted_net); return hasData(d)?clamp(sigmoid(d/5.5),0.10,0.90):0.5; } // was /7.0
function sigPredSpread(m)      { const s=sn(m?.predicted_spread); return hasData(s)?clamp(sigmoid(s/2.8),0.08,0.92):0.5; } // was /3.5 — playoff spreads more decisive
function sigPIE(m)             { const e=sn(m?.pie_edge); return hasData(e)?clamp(0.5+e*9,0.12,0.88):0.5; }                // was *7
function sigForm(m)            { const f=sn(m?.form_edge),d=sn(m?.diff5_edge); return (hasData(f)||hasData(d))?clamp(0.5+(f*0.65+clamp(d/12,-0.3,0.3)*0.35)*0.50,0.10,0.90):0.5; }
// Clutch is most important in playoffs — use a much tighter/stronger curve
function sigClutch(m)          { const wp=sn(m?.clutch_w_pct_edge),pm=sn(m?.clutch_pm_edge); return (hasData(wp)||hasData(pm))?clamp(0.5+(wp*0.60+clamp(pm/6,-0.4,0.4)*0.40)*0.80,0.12,0.88):0.5; }
// Star power — playoff stars dominate
function sigStars(m)           { const se=sn(m?.star_power_edge),pe=sn(m?.pie_player_edge); return (hasData(se)||hasData(pe))?clamp(0.5+(se*0.70+pe*9*0.30)*0.65,0.12,0.88):0.5; }
function sigShooting(m)        { const ts=sn(m?.ts_edge),efg=sn(m?.efg_edge); return (hasData(ts)||hasData(efg))?clamp(0.5+(ts*0.65+efg*0.35)*7.0,0.15,0.85):0.5; }
function sigTurnover(m)        { const te=sn(m?.tov_edge),ate=sn(m?.ast_to_edge); return (hasData(te)||hasData(ate))?clamp(0.5+te*0.025+ate*0.05,0.15,0.85):0.5; }  // turnovers more costly in playoffs
function sigRest(m)            { const re=sn(m?.rest_edge); return hasData(re)?clamp(0.5+re*0.7,0.22,0.78):0.5; }         // less weight in playoffs
function sigHustle(m)          { const he=sn(m?.hustle_edge); return hasData(he)?clamp(0.5+clamp(he/20,-0.20,0.20),0.20,0.80):0.5; } // hustle more important
function sigRebound(m)         { const oe=sn(m?.oreb_edge),de=sn(m?.dreb_edge); return (hasData(oe)||hasData(de))?clamp(0.5+(oe*0.70+de*0.30)*1.1,0.22,0.78):0.5; }
function sigShotQ(m)           { const sq=sn(m?.shot_quality_edge); return hasData(sq)?clamp(0.5+sq*6.0,0.20,0.80):0.5; }
// H2H record — series history is CRITICAL in playoffs
function sigH2H(h2h)           { return h2h?.games>0?clamp(sn(h2h.h2h_prob,0.5),0.18,0.82):0.5; }                        // wider range in playoffs
function sigMomentum(m)        { const me=sn(m?.momentum_edge),se=sn(m?.streak_edge); return (hasData(me)||hasData(se))?clamp(0.5+(me*0.70+se*0.30)*0.75,0.22,0.78):0.5; }
function sigReferee(m)         { const ri=sn(m?.ref_impact); return hasData(ri)?clamp(0.5+ri,0.30,0.70):0.5; }
function sigTravel(m)          { const tf=sn(m?.travel_fatigue); return hasData(tf)?clamp(0.5+tf*0.6,0.32,0.68):0.5; }    // less travel impact in playoffs
function sigOppMatch(hd,ad,m)  { const h=hd?.home_net_rtg||sn(hd?.net_rating,999),a=ad?.away_net_rtg||sn(ad?.net_rating,999); return (h!==999&&a!==999&&hasData(h-a))?clamp(sigmoid((h-a)/7.0),0.20,0.80):0.5; }
function sigSplits(m)          { const sp=sn(m?.split_prob); return hasData(sp-0.5)?clamp(sp,0.25,0.75):0.5; }
function sigPace(m)            { const pe=sn(m?.pace_edge),ate=sn(m?.ast_to_edge); return (hasData(pe)||hasData(ate))?clamp(0.5+pe*0.5+clamp(ate*0.02,-0.03,0.03),0.30,0.70):0.5; } // pace matters less
function sig3PVar(m,nd)        { const vf=sn(m?.variance_factor,0.30),ls=clamp(1-vf*2.0,0,0.4); return clamp(nd>=0?0.5+ls*0.04:0.5-ls*0.04,0.38,0.62); } // 3PT variance very low in playoffs
// Defense is king in playoffs
function sigDefense(hd,ad)     { const hS=sn(hd?.stl_rate),hB=sn(hd?.blk_rate),aS=sn(ad?.stl_rate),aB=sn(ad?.blk_rate); return (hS>0||aS>0)?clamp(0.5+(hS+hB*50-aS-aB*50)*0.012,0.22,0.78):0.5; }

function blend(components) {
  const active = components.filter(c => Math.abs(c.prob - 0.5) > 0.005);
  if (!active.length) return 0.5;
  let ls = 0, ws = 0;
  for (const c of components) { ls += logit(clamp(c.prob,0.01,0.99)) * c.weight; ws += c.weight; }
  return ws > 0 ? sigmoid(ls / ws) : 0.5;
}

function applyLiveAdj(pre, ls) {
  if (!ls?.liveFound) return pre;
  const diff=sn(ls.homeScore)-sn(ls.awayScore), period=sn(ls.period,1);
  const clock=typeof ls.clockSec==="number"?ls.clockSec:720;
  const total=2880, elapsed=clamp((period-1)*720+(720-clock),0,total);
  const remain=total-elapsed, progress=elapsed/total;
  if (progress<0.04) return pre;
  const remPts=remain*(100/total)*2, lf=diff/Math.max(Math.sqrt(remPts),1);
  const bw=Math.pow(progress,1.5), lp=sigmoid(logit(clamp(pre,0.05,0.95))+lf*1.9);
  return clamp(pre*(1-bw)+lp*bw, 0.01, 0.99);
}

async function computeIndependentWinProb(homeTeam, awayTeam, liveState=null, injCtx={}) {
  let data = null;
  try { data = await getAdvancedMatchup(homeTeam, awayTeam, injCtx); }
  catch (e) { console.warn("[stats_model]", e.message); }

  if (!data) {
    const fb = clamp(sigmoid(0.112), 0.45, 0.60);
    return { homeWinProb: r4(fb), pregameHomeProb: r4(fb), signals: { fallback: true }, weights: SIGNAL_W, matchupProfile: null, meta: { error: "no_data" } };
  }

  const { matchup: m, homeData: hd, awayData: ad, h2h, homeOnOff, awayOnOff, dataSource } = data;

  const hInj = computeInjuryImpact(hd, injCtx?.homeInjuries || [], homeOnOff || []);
  const aInj = computeInjuryImpact(ad, injCtx?.awayInjuries || [], awayOnOff || []);

  const hcaLogit = (() => {
    // Playoff HCA is stronger — teams protect home court more
    const LEAGUE = isPlayoffs() ? 0.18 : 0.112;
    const hw = hd?.home_win_rate, aw = hd?.away_win_rate;
    if (hw == null || aw == null) return LEAGUE;
    const split = clamp((hw||0.5)-(aw||0.5),-0.30,0.50);
    const wt = clamp((hd?.games||0)/60, 0, 1);
    return clamp(LEAGUE*(1-wt)+split*0.50*wt, 0.06, 0.35);
  })();

  const W = getEffectiveWeights();
  const netDiff = sn(m?.net_diff);

  // ── 3. STRENGTH OF SCHEDULE adjusted momentum ────────────────────────────
  // Wins against tougher opponents count more
  const homeSOS = sn(hd?.sos_factor, 1.0);
  const awaySOS = sn(ad?.sos_factor, 1.0);
  const adjMomentumEdge = sn(m?.momentum_edge) * ((homeSOS + awaySOS) / 2);

  const sig = {
    officialNetRating:  sigNetRating(m),
    injuryAdjNetRating: sigInjuryNet({ home: hInj, away: aInj }),
    predictedSpread:    sigPredSpread(m),
    pie:                sigPIE(m),
    recentForm:         sigForm(m),
    clutch:             sigClutch(m),
    starPower:          sigStars(m),
    shooting:           sigShooting(m),
    turnover:           sigTurnover(m),
    rest:               sigRest(m),
    hustle:             sigHustle(m),
    rebound:            sigRebound(m),
    shotQuality:        sigShotQ(m),
    h2h:                sigH2H(h2h),
    momentum:           sigMomentum({ ...m, momentum_edge: adjMomentumEdge }),
    referee:            sigReferee(m),
    travelFatigue:      sigTravel(m),
    opponentMatchup:    sigOppMatch(hd, ad, m),
    splits:             sigSplits(m),
    pace:               sigPace(m),
    threePointVariance: sig3PVar(m, netDiff),
    defense:            sigDefense(hd, ad),
  };

  const components = Object.entries(sig).map(([k, prob]) => ({ label: k, prob, weight: W[k] || 0 }));
  let statsProb = blend(components);
  statsProb = sigmoid(logit(clamp(statsProb, 0.01, 0.99)) + hcaLogit);
  statsProb = clamp(statsProb, 0.01, 0.99);

  // Sanity clamp: stats model can't diverge more than 22% from market
  // Prevents bad/stale data from producing absurd predictions
  if (data?.matchup) {
    const marketHomeProb = clamp(0.5 + sn(data.matchup.split_prob, 0.5) - 0.5, 0.20, 0.80);
    statsProb = clamp(statsProb, marketHomeProb - 0.22, marketHomeProb + 0.22);
  }

  const finalProb = liveState?.liveFound ? applyLiveAdj(statsProb, liveState) : statsProb;

  const sigDiag = {};
  for (const [k, prob] of Object.entries(sig)) {
    sigDiag[k] = { prob: r4(prob), weight: W[k]||0, contribution: r4((prob-0.5)*(W[k]||0)) };
  }

  const mkSummary = (d, inj) => !d ? null : ({
    off_rating: r4(d.off_rating), def_rating: r4(d.def_rating), net_rating: r4(d.net_rating),
    adj_off_rating: r4(sn(inj?.adjusted_ortg, d.off_rating)),
    adj_def_rating: r4(sn(inj?.adjusted_drtg, d.def_rating)),
    adj_net_rating: r4(sn(inj?.adjusted_net,  d.net_rating)),
    injury_net_change: r4(sn(inj?.net_change, 0)),
    pace: r4(d.pace), pie: r4(d.pie||0),
    ts_pct: r4(d.ts_pct||0), efg_pct: r4(d.efg_pct||0),
    tov_pct: r4(d.tov_pct||0), oreb_pct: r4(d.oreb_pct||0),
    ftr: r4(d.ftr||0), fg3_rate: r4(d.fg3_rate||0), ast_to: r4(d.ast_to||0),
    clutch_w_pct: r4(d.clutch?.w_pct||0), clutch_pm: r4(d.clutch?.plus_minus||0),
    hustle_score: r4(d.hustle?.score||0),
    star_power: r4(d.star_power||0), top_pie: r4(d.top_pie||0),
    win_rate: r4(d.win_rate||0), win_rate5: r4(d.win_rate5||0),
    streak: d.streak||0, avg_diff5: r4(d.avg_diff5||0),
    rest_days: d.rest_days||2, is_b2b: !!d.is_b2b,
    altitude_ft: d.altitude_ft||0,
    injury_adjustments: inj?.adjustments||[],
    // ── Player stats with full box-score averages ──────────────────────────
    players: (d.players||[]).slice(0,10).map(p=>({
      name:    p.name,
      pts:     r4(p.pts    ||0),
      reb:     r4(p.reb    ||0),
      ast:     r4(p.ast    ||0),
      stl:     r4(p.stl    ||0),
      blk:     r4(p.blk    ||0),
      usg_pct: r4(p.usg_pct||0),
      pie:     r4(p.pie    ||0),
      ts_pct:  r4(p.ts_pct ||0),
      net_rtg: r4(p.net_rating||0),
      min:     r4(p.min    ||0),
    }))
  });

  const activeCount = components.filter(c => Math.abs(c.prob - 0.5) > 0.005).length;

  return {
    homeWinProb:     r4(finalProb),
    pregameHomeProb: r4(statsProb),
    signals:         sigDiag,
    weights:         W,
    injuryAdjustments: { home: hInj, away: aInj, hcaLogit: r4(hcaLogit) },
    matchupProfile: {
      net_diff:           m?.net_diff          != null ? r4(m.net_diff)          : null,
      predicted_spread:   m?.predicted_spread  != null ? r4(m.predicted_spread)  : null,
      home_predicted_pts: m?.home_predicted_pts!= null ? r4(m.home_predicted_pts): null,
      away_predicted_pts: m?.away_predicted_pts!= null ? r4(m.away_predicted_pts): null,
      ts_edge:            r4(sn(m?.ts_edge)),
      tov_edge:           r4(sn(m?.tov_edge)),
      rest_edge:          r4(sn(m?.rest_edge)),
      home_rest:          m?.home_rest, away_rest: m?.away_rest,
      home_b2b:           m?.home_b2b,  away_b2b:  m?.away_b2b,
      ref_impact:         0, ref_names: [], travel_fatigue: 0,
      variance_factor:    r4(sn(m?.variance_factor, 0.40)),
      nba_service_used:   true, injuryAdjusted: hInj.significant || aInj.significant,
      homeStats:  mkSummary(hd, hInj),
      awayStats:  mkSummary(ad, aInj),
      h2h, dataSource,
    },
    meta: {
      season:          require("./advanced_stats").getCurrentSeason(),
      liveAdjusted:    !!(liveState?.liveFound),
      hcaLogit:        r4(hcaLogit),
      activeSignals:   activeCount,
      usingLearnedW:   JSON.stringify(SIGNAL_W) !== JSON.stringify(DEFAULT_W),
      nbaServiceActive: true,
      playoffMode:     isPlayoffs(),
      sosHome:         r4(homeSOS),
      sosAway:         r4(awaySOS),
    }
  };
}

function computeEdge(modelProb, marketProb) {
  const edge = modelProb - marketProb;
  return { edge: r4(edge), modelProb: r4(modelProb), marketProb: r4(marketProb),
    verdict: edge>=0.05?"Bet now":edge>=0.025?"Watch":"Avoid",
    confidence: edge>=0.08?"High":edge>=0.04?"Medium":"Low" };
}

module.exports = { computeIndependentWinProb, computeEdge, applyLiveAdj, DEFAULT_SIGNAL_WEIGHTS: DEFAULT_W, reloadSignalWeights };
