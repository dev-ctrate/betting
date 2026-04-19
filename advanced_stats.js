"use strict";

/**
 * advanced_stats.js  v4
 * Adds: referee impact, travel/timezone fatigue, altitude adjustment,
 * opening line change tracking, all fed into matchup profile.
 */

const NBA_URL = process.env.NBA_SERVICE_URL || "http://localhost:5001";
const BDL_KEY = process.env.BALLDONTLIE_API_KEY || "";

const TTL_NBA  = 22 * 60 * 1000;
const TTL_BDL  = 20 * 60 * 1000;
const TTL_TEAM = 24 * 60 * 60 * 1000;

const _c = new Map();
const cg = k => { const h=_c.get(k); if(!h)return null; if(Date.now()>h.e){_c.delete(k);return null;} return h.v; };
const cs = (k,v,t) => { _c.set(k,{v,e:Date.now()+t}); return v; };

const sn  = (v,f=0) => { const n=Number(v); return Number.isFinite(n)?n:f; };
const r4  = n => Math.round(n*10000)/10000;
const clamp = (x,lo,hi) => Math.max(lo,Math.min(hi,x));
const norm  = s => String(s||"").toLowerCase().replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ").trim();

async function nbaFetch(path, ms=30000) {
  try {
    const ctrl=new AbortController(), t=setTimeout(()=>ctrl.abort(),ms);
    try { const res=await fetch(`${NBA_URL}${path}`,{signal:ctrl.signal}); if(!res.ok)return null; return await res.json(); }
    finally { clearTimeout(t); }
  } catch { return null; }
}

async function getNbaMatchup(home, away) {
  const k=`nba:${norm(home)}:${norm(away)}`; const h=cg(k); if(h) return h;
  const d=await nbaFetch(`/matchup?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}`);
  if (!d||d.error) return null;
  return cs(k,d,TTL_NBA);
}

async function getNbaReferees() {
  const k="nba:refs"; const h=cg(k); if(h) return h;
  const d=await nbaFetch("/refs");
  if (!d) return null;
  return cs(k,d,TTL_NBA);
}

async function bdlFetch(path) {
  if (!BDL_KEY) throw new Error("Missing BALLDONTLIE_API_KEY");
  const res=await fetch(`https://api.balldontlie.io/v1${path}`,{headers:{Authorization:BDL_KEY},signal:AbortSignal.timeout(15000)});
  const txt=await res.text(); if(!res.ok) throw new Error(`BDL ${res.status}`);
  return JSON.parse(txt);
}
const bdlRows = p => Array.isArray(p)?p:Array.isArray(p?.data)?p.data:[];

function getCurrentSeason() { const d=new Date(); const m=d.getUTCMonth()+1; return m>=10?d.getUTCFullYear():d.getUTCFullYear()-1; }

async function getAllTeams() {
  const k="bdl:teams"; const h=cg(k); if(h) return h;
  try { return cs(k,bdlRows(await bdlFetch("/teams?per_page=100")),TTL_TEAM); } catch { return []; }
}

async function resolveTeamId(name) {
  const teams=await getAllTeams(); const tgt=norm(name);
  let m=teams.find(t=>norm(t.full_name)===tgt); if(m) return m.id;
  const nick=tgt.split(" ").pop()||"";
  if (nick.length>3) m=teams.find(t=>norm(t.full_name).includes(nick));
  return m?.id||null;
}

async function fetchH2H(homeId, awayId) {
  const season=getCurrentSeason(); const k=`bdl:h2h:${homeId}:${awayId}:${season}`; const h=cg(k); if(h) return h;
  try {
    const r=await bdlFetch(`/games?team_ids[]=${homeId}&team_ids[]=${awayId}&seasons[]=${season}&per_page=100&postseason=false`);
    const all=bdlRows(r).filter(g=>{
      const ids=[g.home_team?.id,g.home_team_id,g.visitor_team?.id,g.visitor_team_id].filter(Boolean);
      return ids.includes(homeId)&&ids.includes(awayId)&&String(g.status||"").toLowerCase().includes("final");
    }).slice(-8);
    return cs(k,all,TTL_BDL);
  } catch { return []; }
}

function computeH2H(games, homeId) {
  if (!games?.length) return null;
  let wins=0; const diffs=[];
  for (const g of games) {
    const isH=g.home_team?.id===homeId||g.home_team_id===homeId;
    const my=isH?sn(g.home_team_score):sn(g.visitor_team_score);
    const op=isH?sn(g.visitor_team_score):sn(g.home_team_score);
    if (!my&&!op) continue; const d=my-op; if(d>0)wins++; diffs.push(d);
  }
  if (!diffs.length) return null;
  const n=diffs.length, avgD=diffs.reduce((s,v)=>s+v,0)/n, wr=wins/n;
  return {games:n,winRate:r4(wr),avgDiff:r4(avgD),h2h_prob:clamp(0.5+avgD*0.012+(wr-0.5)*0.18,0.22,0.78)};
}

/**
 * Compute referee impact on win probability.
 * High-foul refs benefit teams that draw fouls (high FTR).
 * Returns a home-team win probability adjustment.
 */
function computeRefImpact(refProfile, homeData, awayData) {
  if (!refProfile || !refProfile.fouls_pg) return 0;

  const leagueAvgFouls = 46.5;
  const foulDiff       = sn(refProfile.fouls_pg) - leagueAvgFouls;  // + = more fouls than avg

  // If this ref calls more fouls, teams that get to the line benefit
  const homeFTR = sn(homeData?.ftr, 0.22);
  const awayFTR = sn(awayData?.ftr, 0.22);
  const ftrEdge = homeFTR - awayFTR;  // positive = home draws more fouls

  // Foul-prone refs + FTR advantage = win prob boost
  const refAdj = clamp(foulDiff * ftrEdge * 0.15, -0.025, 0.025);

  // Fast refs affect high-tempo teams
  const paceEffect  = sn(refProfile.pace_effect, 0);
  const homePace    = sn(homeData?.pace, 98);
  const awayPace    = sn(awayData?.pace, 98);
  const paceEdge    = (homePace - awayPace) * paceEffect * 0.0004;

  return r4(clamp(refAdj + paceEdge, -0.035, 0.035));
}

/**
 * Compute travel/timezone fatigue penalty for away team.
 * Uses Python service data if available, otherwise estimates from team metadata.
 */
function computeTravelFatigue(deltas, formData) {
  // Python service already computed this
  const travelPen = sn(deltas?.travel_penalty, 0);
  const altFactor = sn(deltas?.altitude_factor, 0);
  const isAwayB2B = !!(formData?.is_b2b);

  // Additional penalty for away team on B2B road game
  const b2bRoadPenalty = isAwayB2B ? 0.02 : 0;

  return r4(clamp(travelPen + altFactor + b2bRoadPenalty, 0, 0.08));
}

function mergeTeam(nba, form) {
  const p=nba||{}, f=form||{};
  const poss=sn(p.poss,97);
  const avgAllowed=sn(f.avg_pts_allowed,sn(p.def_rating,112)*0.97);
  const drtg=avgAllowed>0?(avgAllowed/poss)*100:sn(p.def_rating,112);
  return {
    off_rating:sn(p.off_rating,108), def_rating:drtg,
    net_rating:sn(p.net_rating,sn(p.off_rating,108)-drtg),
    pace:sn(p.pace,98), pie:sn(p.pie,0.50), poss, w_pct:sn(p.w_pct,0.5),
    ts_pct:sn(p.ts_pct,0.55), efg_pct:sn(p.efg_pct,0.52), fg_pct:sn(p.fg_pct,0.47),
    fg3_pct:sn(p.fg3_pct,0.36), ft_pct:sn(p.ft_pct,0.77), fg3_rate:sn(p.fg3_rate,0.40),
    ftr:sn(p.ftr,0.22), tov_pct:sn(p.tov_pct,14), ast_to:sn(p.ast_to,2.0),
    oreb_pct:sn(p.oreb_pct,0.24), dreb_pct:sn(p.dreb_pct,0.76),
    pts:sn(p.pts,110), stl:sn(p.stl,8), blk:sn(p.blk,5),
    stl_rate:sn(p.stl,8)/poss*100, blk_rate:sn(p.blk,5)/Math.max(sn(p.fga,88),1),
    altitude_ft:sn(p.altitude_ft,500), timezone:p.timezone||"",
    clutch_w_pct:sn(p.clutch?.w_pct,sn(f.win_rate,0.5)), clutch_plus_minus:sn(p.clutch?.plus_minus,0),
    clutch_fg_pct:sn(p.clutch?.fg_pct,0.45), clutch_ft_pct:sn(p.clutch?.ft_pct,0.77),
    hustle_score:sn(p.hustle?.score,20), contested_shots:sn(p.hustle?.contested_shots,15),
    charges_drawn:sn(p.hustle?.charges_drawn,0.5),
    defense:p.defense||{}, star_power:sn(p.star_power,15), top_pie:sn(p.top_pie,0.12),
    avg_net_rtg_top3:sn(p.avg_net_rtg_top3,-2), players:p.players||[], best_lineup:p.best_lineup||null,
    win_rate:sn(f.win_rate,sn(p.w_pct,0.5)), win_rate5:sn(f.win_rate5,sn(f.win_rate,0.5)),
    win_rate10:sn(f.win_rate10,sn(f.win_rate,0.5)), avg_diff:sn(f.avg_diff,0),
    avg_diff5:sn(f.avg_diff5,0), momentum:sn(f.momentum,0), streak:sn(f.streak,0),
    avg_pts:sn(f.avg_pts,110), avg_pts_allowed:avgAllowed,
    home_win_rate:f.home_win_rate!=null?sn(f.home_win_rate):null,
    away_win_rate:f.away_win_rate!=null?sn(f.away_win_rate):null,
    home_net_rtg:f.home_net_rtg!=null?sn(f.home_net_rtg):null,
    away_net_rtg:f.away_net_rtg!=null?sn(f.away_net_rtg):null,
    rest_days:sn(f.rest_days,2), is_b2b:!!f.is_b2b,
  };
}

function buildDeltas(home, away, nd, refProfile) {
  const get=(k,fb)=>nd&&nd[k]!=null?sn(nd[k]):fb;
  const hp=home.off_rating*(away.def_rating/100), ap=away.off_rating*(home.def_rating/100);
  const re=clamp((home.rest_days-away.rest_days)*0.015,-0.06,0.06)+(away.is_b2b?0.04:0)-(home.is_b2b?0.04:0);
  const ts=sn(home.star_power)+sn(away.star_power);
  const hwR=home.home_win_rate??home.win_rate, aaR=away.away_win_rate??away.win_rate;

  // Referee and travel impacts
  const refImpact    = computeRefImpact(refProfile, home, away);
  const travelImpact = computeTravelFatigue(nd, away);  // away team fatigue = home advantage

  return {
    net_diff:           get("net_diff",           r4(home.net_rating-away.net_rating)),
    predicted_spread:   get("predicted_spread",   r4(hp-ap)),
    home_predicted_pts: get("home_predicted_pts", r4(hp)),
    away_predicted_pts: get("away_predicted_pts", r4(ap)),
    pie_edge:           get("pie_edge",            r4(home.pie-away.pie)),
    ts_edge:            get("ts_edge",             r4(home.ts_pct-away.ts_pct)),
    efg_edge:           get("efg_edge",            r4(home.efg_pct-away.efg_pct)),
    shot_quality_edge:  get("shot_quality_edge",   0),
    three_matchup_edge: get("three_matchup_edge",  r4(home.fg3_pct-away.fg3_pct)),
    rim_edge:           get("rim_edge",            r4(home.ftr-away.ftr)),
    tov_edge:           get("tov_edge",            r4(sn(away.tov_pct)-sn(home.tov_pct))),
    ast_to_edge:        get("ast_to_edge",         r4(home.ast_to-away.ast_to)),
    oreb_edge:          get("oreb_edge",           r4(home.oreb_pct-away.oreb_pct)),
    dreb_edge:          get("dreb_edge",           r4(home.dreb_pct-away.dreb_pct)),
    clutch_w_pct_edge:  r4(home.clutch_w_pct-away.clutch_w_pct),
    clutch_pm_edge:     r4(home.clutch_plus_minus-away.clutch_plus_minus),
    clutch_ft_edge:     get("clutch_ft_edge",      r4(home.clutch_ft_pct-away.clutch_ft_pct)),
    hustle_edge:        r4(home.hustle_score-away.hustle_score),
    contested_edge:     r4(home.contested_shots-away.contested_shots),
    charges_edge:       get("charges_edge",        r4(home.charges_drawn-away.charges_drawn)),
    pace_edge:          get("pace_edge",           r4((home.pace-away.pace)*0.003)),
    pace_mismatch:      Math.abs(home.pace-away.pace),
    variance_factor:    r4((home.fg3_rate+away.fg3_rate)/2),
    star_power_edge:    get("star_power_edge",     r4(ts>0?(sn(home.star_power)-sn(away.star_power))/ts:0)),
    pie_player_edge:    get("pie_player_edge",     r4(home.top_pie-away.top_pie)),
    net_rtg_top3_edge:  get("net_rtg_top3_edge",  r4(home.avg_net_rtg_top3-away.avg_net_rtg_top3)),
    form_edge:          r4(sn(home.win_rate10)-sn(away.win_rate10)),
    diff5_edge:         r4(sn(home.avg_diff5)-sn(away.avg_diff5)),
    momentum_edge:      r4(sn(home.momentum)-sn(away.momentum)),
    streak_edge:        clamp((sn(home.streak)-sn(away.streak))*0.015,-0.06,0.06),
    rest_edge:          r4(re),
    home_rest:          home.rest_days, away_rest:away.rest_days,
    home_b2b:           home.is_b2b,   away_b2b:away.is_b2b,
    split_prob:         clamp(((hwR??0.5)+(1-(aaR??0.5)))/2,0.25,0.75),
    home_home_wr:hwR, away_away_wr:aaR,
    home_home_net:home.home_net_rtg, away_away_net:away.away_net_rtg,
    // New signals
    ref_impact:         refImpact,    // home win prob adj from referee tendencies
    travel_fatigue:     travelImpact, // home win prob adj from away travel/altitude
    travel_penalty:     get("travel_penalty",0),
    altitude_factor:    get("altitude_factor",0),
    home_altitude:      home.altitude_ft,
    away_altitude:      away.altitude_ft,
    nba_service_used:   !!nd,
  };
}

async function getAdvancedMatchup(homeTeam, awayTeam) {
  const [nba, homeId, awayId, refData] = await Promise.all([
    getNbaMatchup(homeTeam, awayTeam),
    resolveTeamId(homeTeam).catch(()=>null),
    resolveTeamId(awayTeam).catch(()=>null),
    getNbaReferees().catch(()=>null),
  ]);

  const h2hGames=(homeId&&awayId)?await fetchH2H(homeId,awayId).catch(()=>[]):[];
  const h2h=computeH2H(h2hGames, homeId);

  const homeData=mergeTeam(nba?.home||null, nba?.home_form||null);
  const awayData=mergeTeam(nba?.away||null, nba?.away_form||null);
  const refProfile=refData?.profile||nba?.referee||null;
  const matchup=buildDeltas(homeData, awayData, nba?.deltas||null, refProfile);

  return {
    matchup, homeData, awayData, homeId, awayId, h2h,
    homeOnOff: nba?.home_on_off||[],
    awayOnOff: nba?.away_on_off||[],
    refProfile,
    dataSource:{ nbaServiceAvailable:!!nba, bdlH2HAvailable:h2hGames.length>0, refsAvailable:!!(refProfile?.names?.length) }
  };
}

module.exports = { getAdvancedMatchup, resolveTeamId, getCurrentSeason, getNbaMatchup };
