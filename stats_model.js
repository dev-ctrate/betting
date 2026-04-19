"use strict";

/**
 * stats_model.js  v4  —  independent win probability engine
 *
 * 22 signals. Two new ones vs v3:
 *   • referee       — foul tendency + pace effect vs team FTR/pace style
 *   • travelFatigue — timezone change + altitude + road B2B for away team
 *
 * Accuracy reality check:
 *   NBA overall: best models ~55-60% correct on all games
 *   Our target:  ≥62% overall, ≥70% on "Bet now" picks (edge ≥ 0.045)
 *   Signal optimizer targets THESE numbers, not 70-90% overall.
 *
 * Weights are learned from graded snapshots via signal_optimizer.js.
 * Falls back to research-backed defaults on first run.
 */

const fs   = require("fs");
const path = require("path");
const { getAdvancedMatchup } = require("./advanced_stats");
const { computeInjuryImpact, computeTeamHCA } = require("./injury_model");

const SIG_W_FILE = path.join(__dirname, "data", "signal_weights.json");

// ─── default weights ──────────────────────────────────────────────────────────
const DEFAULT_W = {
  officialNetRating:   0.17,
  injuryAdjNetRating:  0.10,
  predictedSpread:     0.10,
  pie:                 0.08,
  recentForm:          0.08,
  clutch:              0.07,
  starPower:           0.06,
  shooting:            0.05,
  turnover:            0.04,
  rest:                0.04,
  hustle:              0.03,
  rebound:             0.03,
  shotQuality:         0.03,
  h2h:                 0.03,
  momentum:            0.03,
  referee:             0.03,  // NEW — foul tendencies + pace match
  travelFatigue:       0.03,  // NEW — timezone + altitude + road B2B
  opponentMatchup:     0.02,
  splits:              0.02,
  pace:                0.02,
  threePointVariance:  0.01,
  defense:             0.01,
};

// ─── load learned weights ─────────────────────────────────────────────────────
let SIGNAL_W = { ...DEFAULT_W };

function reloadSignalWeights() {
  try {
    if (!fs.existsSync(SIG_W_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(SIG_W_FILE, "utf8"));
    if (raw?.weights && typeof raw.weights === "object") {
      SIGNAL_W = { ...DEFAULT_W, ...raw.weights };
    }
  } catch { /* keep defaults */ }
}
reloadSignalWeights();
setInterval(reloadSignalWeights, 30 * 60 * 1000);

// ─── math ─────────────────────────────────────────────────────────────────────
const clamp   = (x,lo,hi) => Math.max(lo,Math.min(hi,x));
const sigmoid = x => 1/(1+Math.exp(-clamp(x,-50,50)));
const logit   = p => { const c=clamp(p,1e-6,1-1e-6); return Math.log(c/(1-c)); };
const r4 = n => Math.round(n*10000)/10000;
const sn = (v,f=0) => { const n=Number(v); return Number.isFinite(n)?n:f; };

// ─── signal builders ──────────────────────────────────────────────────────────

function sigNetRating(m)         { return clamp(sigmoid(sn(m?.net_diff,0)/7.5),0.12,0.88); }
function sigInjuryNetRating(ia)  { if(!ia)return 0.5; return clamp(sigmoid((sn(ia.home?.adjusted_net)-sn(ia.away?.adjusted_net))/7.0),0.12,0.88); }
function sigPredictedSpread(m)   { return clamp(sigmoid(sn(m?.predicted_spread,0)/3.5),0.10,0.90); }
function sigPIE(m)               { return clamp(0.5+sn(m?.pie_edge,0)*7,0.15,0.85); }
function sigRecentForm(m)        { const f=sn(m?.form_edge,0),d=sn(m?.diff5_edge,0); return clamp(0.5+(f*0.60+clamp(d/14,-0.3,0.3)*0.40)*0.45,0.12,0.88); }
function sigClutch(m)            { const wp=sn(m?.clutch_w_pct_edge,0),pm=sn(m?.clutch_pm_edge,0),ft=sn(m?.clutch_ft_edge,0); return clamp(0.5+(wp*0.55+clamp(pm/8,-0.3,0.3)*0.30+ft*0.80*0.15)*0.60,0.15,0.85); }
function sigStarPower(m)         { const se=sn(m?.star_power_edge,0),pe=sn(m?.pie_player_edge,0),ne=sn(m?.net_rtg_top3_edge,0); return clamp(0.5+(se*0.50+pe*7*0.30+clamp(ne/8,-0.3,0.3)*0.20)*0.55,0.15,0.85); }
function sigShooting(m)          { return clamp(0.5+(sn(m?.ts_edge,0)*0.65+sn(m?.efg_edge,0)*0.35)*7.0,0.15,0.85); }
function sigTurnover(m)          { return clamp(0.5+sn(m?.tov_edge,0)*0.022+sn(m?.ast_to_edge,0)*0.045,0.15,0.85); }
function sigRest(m)              { return clamp(0.5+sn(m?.rest_edge,0),0.18,0.82); }
function sigHustle(m)            { return clamp(0.5+clamp(sn(m?.hustle_edge,0)/25,-0.15,0.15)+clamp(sn(m?.charges_edge,0)*0.04,-0.05,0.05),0.22,0.78); }
function sigRebound(m)           { return clamp(0.5+(sn(m?.oreb_edge,0)*0.70+sn(m?.dreb_edge,0)*0.30)*0.9,0.25,0.75); }
function sigShotQuality(m)       { return clamp(0.5+sn(m?.shot_quality_edge,0)*5.0+sn(m?.three_matchup_edge,0)*3.0+sn(m?.rim_edge,0)*2.5,0.22,0.78); }
function sigH2H(h2h)             { return clamp(sn(h2h?.h2h_prob,0.5),0.22,0.78); }
function sigMomentum(m)          { return clamp(0.5+(sn(m?.momentum_edge,0)*0.70+sn(m?.streak_edge,0)*0.30)*0.65,0.25,0.75); }
function sigOpponentMatchup(hd,ad,m) { const h=(hd?.home_net_rtg||m?.home_home_net||sn(hd?.net_rating,0)),a=(ad?.away_net_rtg||m?.away_away_net||sn(ad?.net_rating,0)); return clamp(sigmoid((h-a)/8.0),0.20,0.80); }
function sigSplits(m)            { return clamp(sn(m?.split_prob,0.5),0.25,0.75); }
function sigPace(m)              { return clamp(0.5+sn(m?.pace_edge,0)+clamp(sn(m?.ast_to_edge,0)*0.03,-0.04,0.04),0.25,0.75); }
function sigThreePtVariance(m, netDiff) { const vf=sn(m?.variance_factor,0.40),ls=clamp(1-vf*1.5,0,0.4); return clamp(netDiff>=0?0.5+ls*0.05:0.5-ls*0.05,0.35,0.65); }
function sigDefense(hd,ad)       { return clamp(0.5+(sn(hd?.stl_rate,8)+sn(hd?.blk_rate,0.06)*50-sn(ad?.stl_rate,8)-sn(ad?.blk_rate,0.06)*50)*0.008,0.25,0.75); }

/**
 * Referee signal: does this crew's style (foul rate, pace) favour home team?
 * ref_impact is already computed in advanced_stats (home-win-prob-delta).
 */
function sigReferee(m) {
  const ri = sn(m?.ref_impact, 0);   // pre-computed home-win-prob adjustment
  return clamp(0.5 + ri, 0.28, 0.72);
}

/**
 * Travel fatigue: away team distance/timezone/altitude disadvantage.
 * travel_fatigue is pre-computed home win prob boost.
 */
function sigTravelFatigue(m) {
  const tf = sn(m?.travel_fatigue, 0);  // positive = home advantage
  return clamp(0.5 + tf, 0.28, 0.72);
}

// ─── logit-space blend ────────────────────────────────────────────────────────
function blend(components) {
  if (!components.length) return 0.5;
  let ls=0, ws=0;
  for (const c of components) { ls+=logit(clamp(c.prob,0.01,0.99))*c.weight; ws+=c.weight; }
  return sigmoid(ls/ws);
}

// ─── live adjustment ──────────────────────────────────────────────────────────
function applyLiveAdj(pre, ls) {
  if (!ls?.liveFound) return pre;
  const diff=sn(ls.homeScore)-sn(ls.awayScore), period=sn(ls.period,1);
  const clock=typeof ls.clockSec==="number"?ls.clockSec:720;
  const total=2880, elapsed=clamp((period-1)*720+(720-clock),0,total);
  const remain=total-elapsed, progress=elapsed/total;
  if (progress<0.04) return pre;
  const remPts=remain*(100/total)*2;
  const lf=diff/Math.max(Math.sqrt(remPts),1);
  const bw=Math.pow(progress,1.5);
  const lp=sigmoid(logit(clamp(pre,0.05,0.95))+lf*1.9);
  return clamp(pre*(1-bw)+lp*bw, 0.01, 0.99);
}

// ─── main ─────────────────────────────────────────────────────────────────────
async function computeIndependentWinProb(homeTeam, awayTeam, liveState=null, injCtx={}) {
  let data=null;
  try { data=await getAdvancedMatchup(homeTeam,awayTeam); }
  catch(e) { console.warn("[stats_model]",e.message); }

  if (!data) {
    const fb=clamp(sigmoid(0.112),0.45,0.60);
    return{homeWinProb:r4(fb),pregameHomeProb:r4(fb),signals:{fallback:true},weights:SIGNAL_W,matchupProfile:null,meta:{error:"no_data"}};
  }

  const{matchup:m,homeData:hd,awayData:ad,h2h,homeOnOff,awayOnOff,refProfile,dataSource}=data;

  // Injury adjustments
  const hInj=computeInjuryImpact(hd,injCtx?.homeInjuries||[],homeOnOff||[]);
  const aInj=computeInjuryImpact(ad,injCtx?.awayInjuries||[],awayOnOff||[]);

  // Team-specific home court
  const hcaLogit=computeTeamHCA(hd);

  const W=SIGNAL_W;
  const netDiff=sn(m?.net_diff,0);

  const sig = {
    officialNetRating:   sigNetRating(m),
    injuryAdjNetRating:  sigInjuryNetRating({home:hInj,away:aInj}),
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
    opponentMatchup:     sigOpponentMatchup(hd,ad,m),
    splits:              sigSplits(m),
    pace:                sigPace(m),
    threePointVariance:  sigThreePtVariance(m,netDiff),
    defense:             sigDefense(hd,ad),
  };

  const components=Object.entries(sig).map(([k,prob])=>({label:k,prob,weight:W[k]||0}));
  let statsProb=blend(components);
  statsProb=sigmoid(logit(clamp(statsProb,0.01,0.99))+hcaLogit);
  statsProb=clamp(statsProb,0.01,0.99);

  const finalProb=liveState?.liveFound?applyLiveAdj(statsProb,liveState):statsProb;

  const sigDiag={};
  for (const[k,prob] of Object.entries(sig)) {
    sigDiag[k]={prob:r4(prob),weight:W[k]||0,contribution:r4((prob-0.5)*(W[k]||0))};
  }

  const buildSummary = (d, inj) => d ? ({
    off_rating:r4(d.off_rating,1),def_rating:r4(d.def_rating,1),net_rating:r4(d.net_rating,1),
    adj_off_rating:r4(sn(inj?.adjusted_ortg,d.off_rating),1),adj_def_rating:r4(sn(inj?.adjusted_drtg,d.def_rating),1),
    adj_net_rating:r4(sn(inj?.adjusted_net,d.net_rating),1),injury_net_change:r4(sn(inj?.net_change,0),1),
    pace:r4(d.pace,1),pie:r4(d.pie,4),ts_pct:r4(d.ts_pct,3),efg_pct:r4(d.efg_pct,3),
    tov_pct:r4(d.tov_pct,1),oreb_pct:r4(d.oreb_pct,3),ftr:r4(d.ftr,3),fg3_rate:r4(d.fg3_rate,3),
    ast_to:r4(d.ast_to,2),clutch_w_pct:r4(d.clutch_w_pct,3),clutch_pm:r4(d.clutch_plus_minus,1),
    hustle_score:r4(d.hustle_score,1),star_power:r4(d.star_power,1),top_pie:r4(d.top_pie,4),
    win_rate:r4(d.win_rate,3),win_rate5:r4(d.win_rate5,3),streak:d.streak,avg_diff5:r4(d.avg_diff5,1),
    rest_days:d.rest_days,is_b2b:d.is_b2b,altitude_ft:d.altitude_ft,
    injury_adjustments:inj?.adjustments||[],
    players:(d.players||[]).slice(0,5).map(p=>({
      name:p.name,ts_pct:r4(p.ts_pct||0,3),usg_pct:r4(p.usg_pct||0,3),
      pie:r4(p.pie||0,4),net_rtg:r4(p.net_rating||0,1),min:p.min
    }))
  }) : null;

  return {
    homeWinProb:     r4(finalProb),
    pregameHomeProb: r4(statsProb),
    signals:         sigDiag,
    weights:         W,
    injuryAdjustments: {home:hInj,away:aInj,hcaLogit:r4(hcaLogit)},
    matchupProfile: {
      net_diff:m?.net_diff!=null?r4(m.net_diff):null,
      predicted_spread:m?.predicted_spread!=null?r4(m.predicted_spread):null,
      home_predicted_pts:m?.home_predicted_pts!=null?r4(m.home_predicted_pts):null,
      away_predicted_pts:m?.away_predicted_pts!=null?r4(m.away_predicted_pts):null,
      pie_edge:m?.pie_edge!=null?r4(m.pie_edge):null,
      ts_edge:m?.ts_edge!=null?r4(m.ts_edge):null,
      tov_edge:m?.tov_edge!=null?r4(m.tov_edge):null,
      clutch_w_pct_edge:m?.clutch_w_pct_edge!=null?r4(m.clutch_w_pct_edge):null,
      hustle_edge:m?.hustle_edge!=null?r4(m.hustle_edge):null,
      star_power_edge:m?.star_power_edge!=null?r4(m.star_power_edge):null,
      rest_edge:m?.rest_edge!=null?r4(m.rest_edge):null,
      home_rest:m?.home_rest,away_rest:m?.away_rest,home_b2b:m?.home_b2b,away_b2b:m?.away_b2b,
      ref_impact:m?.ref_impact!=null?r4(m.ref_impact):null,
      ref_names:refProfile?.names||[],ref_high_foul:refProfile?.high_foul_crew,
      travel_fatigue:m?.travel_fatigue!=null?r4(m.travel_fatigue):null,
      altitude_factor:m?.altitude_factor,
      home_altitude:m?.home_altitude,away_altitude:m?.away_altitude,
      variance_factor:m?.variance_factor!=null?r4(m.variance_factor):null,
      nba_service_used:m?.nba_service_used??false,
      injuryAdjusted:hInj.significant||aInj.significant,
      homeStats:buildSummary(hd,hInj),awayStats:buildSummary(ad,aInj),
      h2h,dataSource,
    },
    meta:{
      season:require("./advanced_stats").getCurrentSeason(),
      liveAdjusted:!!(liveState?.liveFound),
      hcaLogit:r4(hcaLogit),
      signalCount:components.filter(c=>c.prob!==0.5).length,
      usingLearnedW:JSON.stringify(SIGNAL_W)!==JSON.stringify(DEFAULT_W),
      nbaServiceActive:!!(dataSource?.nbaServiceAvailable),
      refsActive:!!(dataSource?.refsAvailable),
    }
  };
}

function computeEdge(modelProb, marketProb) {
  const edge=modelProb-marketProb;
  return{edge:r4(edge),modelProb:r4(modelProb),marketProb:r4(marketProb),
    verdict:edge>=0.05?"Bet now":edge>=0.025?"Watch":"Avoid",
    confidence:edge>=0.08?"High":edge>=0.04?"Medium":"Low"};
}

module.exports={computeIndependentWinProb,computeEdge,applyLiveAdj,DEFAULT_SIGNAL_WEIGHTS:DEFAULT_W,reloadSignalWeights};
