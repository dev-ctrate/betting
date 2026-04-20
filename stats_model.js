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

const DEFAULT_W = {
  officialNetRating:  0.20, injuryAdjNetRating: 0.08, predictedSpread:   0.12,
  pie:                0.07, recentForm:         0.09, clutch:            0.06,
  starPower:          0.05, shooting:           0.06, turnover:          0.05,
  rest:               0.04, hustle:             0.03, rebound:           0.03,
  shotQuality:        0.03, h2h:                0.03, momentum:          0.03,
  referee:            0.01, travelFatigue:      0.01, opponentMatchup:   0.02,
  splits:             0.02, pace:               0.02, threePointVariance: 0.01, defense: 0.02,
};

let SIGNAL_W = { ...DEFAULT_W };

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

// ─── signal builders ──────────────────────────────────────────────────────────
function sigNetRating(m)       { const d = sn(m?.net_diff); return hasData(d) ? clamp(sigmoid(d/7.5),0.12,0.88) : 0.5; }
function sigInjuryNet(ia)      { if (!ia?.home||!ia?.away) return 0.5; const d=sn(ia.home?.adjusted_net)-sn(ia.away?.adjusted_net); return hasData(d)?clamp(sigmoid(d/7.0),0.12,0.88):0.5; }
function sigPredSpread(m)      { const s=sn(m?.predicted_spread); return hasData(s)?clamp(sigmoid(s/3.5),0.10,0.90):0.5; }
function sigPIE(m)             { const e=sn(m?.pie_edge); return hasData(e)?clamp(0.5+e*7,0.15,0.85):0.5; }
function sigForm(m)            { const f=sn(m?.form_edge),d=sn(m?.diff5_edge); return (hasData(f)||hasData(d))?clamp(0.5+(f*0.60+clamp(d/14,-0.3,0.3)*0.40)*0.45,0.12,0.88):0.5; }
function sigClutch(m)          { const wp=sn(m?.clutch_w_pct_edge),pm=sn(m?.clutch_pm_edge); return (hasData(wp)||hasData(pm))?clamp(0.5+(wp*0.55+clamp(pm/8,-0.3,0.3)*0.45)*0.60,0.15,0.85):0.5; }
function sigStars(m)           { const se=sn(m?.star_power_edge),pe=sn(m?.pie_player_edge); return (hasData(se)||hasData(pe))?clamp(0.5+(se*0.65+pe*7*0.35)*0.55,0.15,0.85):0.5; }
function sigShooting(m)        { const ts=sn(m?.ts_edge),efg=sn(m?.efg_edge); return (hasData(ts)||hasData(efg))?clamp(0.5+(ts*0.65+efg*0.35)*7.0,0.15,0.85):0.5; }
function sigTurnover(m)        { const te=sn(m?.tov_edge),ate=sn(m?.ast_to_edge); return (hasData(te)||hasData(ate))?clamp(0.5+te*0.022+ate*0.045,0.15,0.85):0.5; }
function sigRest(m)            { const re=sn(m?.rest_edge); return hasData(re)?clamp(0.5+re,0.18,0.82):0.5; }
function sigHustle(m)          { const he=sn(m?.hustle_edge); return hasData(he)?clamp(0.5+clamp(he/25,-0.15,0.15),0.22,0.78):0.5; }
function sigRebound(m)         { const oe=sn(m?.oreb_edge),de=sn(m?.dreb_edge); return (hasData(oe)||hasData(de))?clamp(0.5+(oe*0.70+de*0.30)*0.9,0.25,0.75):0.5; }
function sigShotQ(m)           { const sq=sn(m?.shot_quality_edge); return hasData(sq)?clamp(0.5+sq*5.0,0.22,0.78):0.5; }
function sigH2H(h2h)           { return h2h?.games>0?clamp(sn(h2h.h2h_prob,0.5),0.22,0.78):0.5; }
function sigMomentum(m)        { const me=sn(m?.momentum_edge),se=sn(m?.streak_edge); return (hasData(me)||hasData(se))?clamp(0.5+(me*0.70+se*0.30)*0.65,0.25,0.75):0.5; }
function sigReferee(m)         { const ri=sn(m?.ref_impact); return hasData(ri)?clamp(0.5+ri,0.28,0.72):0.5; }
function sigTravel(m)          { const tf=sn(m?.travel_fatigue); return hasData(tf)?clamp(0.5+tf,0.28,0.72):0.5; }
function sigOppMatch(hd,ad,m)  { const h=hd?.home_net_rtg||sn(hd?.net_rating,999),a=ad?.away_net_rtg||sn(ad?.net_rating,999); return (h!==999&&a!==999&&hasData(h-a))?clamp(sigmoid((h-a)/8.0),0.20,0.80):0.5; }
function sigSplits(m)          { const sp=sn(m?.split_prob); return hasData(sp-0.5)?clamp(sp,0.25,0.75):0.5; }
function sigPace(m)            { const pe=sn(m?.pace_edge),ate=sn(m?.ast_to_edge); return (hasData(pe)||hasData(ate))?clamp(0.5+pe+clamp(ate*0.03,-0.04,0.04),0.25,0.75):0.5; }
function sig3PVar(m,nd)        { const vf=sn(m?.variance_factor,0.40),ls=clamp(1-vf*1.5,0,0.4); return clamp(nd>=0?0.5+ls*0.05:0.5-ls*0.05,0.35,0.65); }
function sigDefense(hd,ad)     { const hS=sn(hd?.stl_rate),hB=sn(hd?.blk_rate),aS=sn(ad?.stl_rate),aB=sn(ad?.blk_rate); return (hS>0||aS>0)?clamp(0.5+(hS+hB*50-aS-aB*50)*0.008,0.25,0.75):0.5; }

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
  try { data = await getAdvancedMatchup(homeTeam, awayTeam); }
  catch (e) { console.warn("[stats_model]", e.message); }

  if (!data) {
    const fb = clamp(sigmoid(0.112), 0.45, 0.60);
    return { homeWinProb: r4(fb), pregameHomeProb: r4(fb), signals: { fallback: true }, weights: SIGNAL_W, matchupProfile: null, meta: { error: "no_data" } };
  }

  const { matchup: m, homeData: hd, awayData: ad, h2h, homeOnOff, awayOnOff, dataSource } = data;

  const hInj = computeInjuryImpact(hd, injCtx?.homeInjuries || [], homeOnOff || []);
  const aInj = computeInjuryImpact(ad, injCtx?.awayInjuries || [], awayOnOff || []);

  const hcaLogit = (() => {
    const LEAGUE = 0.112;
    const hw = hd?.home_win_rate, aw = hd?.away_win_rate;
    if (hw == null || aw == null) return LEAGUE;
    const split = clamp((hw||0.5)-(aw||0.5),-0.30,0.50);
    const wt = clamp((hd?.games||0)/60, 0, 1);
    return clamp(LEAGUE*(1-wt)+split*0.45*wt, 0.04, 0.30);
  })();

  const W = SIGNAL_W;
  const netDiff = sn(m?.net_diff);

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
    momentum:           sigMomentum(m),
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
