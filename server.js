"use strict";

const express  = require("express");
const path     = require("path");
const learning = require("./learning");
const { buildEliteLiveModel }    = require("./live_model");
const { getLiveTrackerData }     = require("./live_tracker");
const { buildElitePregameModel } = require("./pregame_model");
const { computeIndependentWinProb, computeEdge } = require("./stats_model");
const { startAutoGradeScheduler }                = require("./auto_grader");
const { loadLearnedWeights, applyLearnedWeights, DEFAULT_WEIGHTS } = require("./weight_learner");
const { predictGameProps }       = require("./prop_model");
const {
  recordPropSnap,
  getPropLearningSummary,
  gradeUngraded:          gradeProps,
  startPropGradeScheduler,
  getPropSnapshots,
}                                = require("./prop_learning");

let buildModelReview;
try { buildModelReview = require("./model_review").buildModelReview; }
catch { buildModelReview = () => ({}); }

const app  = express();
const PORT = process.env.PORT || 3000;

const ODDS_API_KEY         = process.env.ODDS_API_KEY        || "";
const BALLDONTLIE_API_KEY  = process.env.BALLDONTLIE_API_KEY || "";
const FANTASYNERDS_API_KEY = process.env.FANTASYNERDS_API_KEY || "";

const SPORT_KEY           = "basketball_nba";
const REGIONS             = "us";
const ODDS_FORMAT         = "decimal";
const FEATURED_MARKETS    = "h2h,spreads,totals";
const PLAYER_PROP_MARKETS = ["player_points","player_rebounds","player_assists","player_threes","player_threes_made","player_three_pointers_made"].join(",");
const HISTORICAL_LOOKBACKS = [{ label: "2h", ms: 2*60*60*1000 }, { label: "24h", ms: 24*60*60*1000 }];

const currentCache    = new Map();
const historicalCache = new Map();
const sideInfoCache   = new Map();
const edgeHistoryStore  = {};
const snapshotLogStore  = {};

const CURRENT_TTL    = 25 * 1000;
const HISTORICAL_TTL = 30 * 60 * 1000;
const SIDEINFO_TTL   = 10 * 60 * 1000;
const SNAP_RET       = 500;

let learnedWeights = loadLearnedWeights();
setInterval(() => { learnedWeights = loadLearnedWeights(); }, 30 * 60 * 1000);

app.use(express.json());
process.on("unhandledRejection", r => console.error("UNHANDLED:", r));
process.on("uncaughtException",  e => console.error("UNCAUGHT:", e));

// ─── helpers ──────────────────────────────────────────────────────────────────
const clamp   = (x, a, b) => Math.max(a, Math.min(b, x));
const r2      = n => (typeof n === "number" && Number.isFinite(n)) ? Math.round(n * 100) / 100 : null;
const avg     = vs => { const ns = (vs||[]).filter(v => typeof v==="number"&&Number.isFinite(v)); return ns.length ? ns.reduce((s,v)=>s+v,0)/ns.length : null; };
const wAvg    = ps => { if(!ps.length) return null; let n=0,d=0; for(const p of ps){n+=p.value*p.weight;d+=p.weight;} return d===0?null:n/d; };
const noVig   = (a,b) => { if(!a||!b||a<=1||b<=1) return{a:0.5,b:0.5}; const ra=1/a,rb=1/b,t=ra+rb; return{a:ra/t,b:rb/t}; };
const d2a     = d => { if(typeof d!=="number"||!Number.isFinite(d)||d<=1) return null; return d>=2?Math.round((d-1)*100):Math.round(-100/(d-1)); };
const p2d     = p => (typeof p==="number"&&Number.isFinite(p)&&p>0&&p<1) ? 1/p : null;
const p2a     = p => d2a(p2d(p));
const normTeam= s => String(s||"").toLowerCase().replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ").trim();
const teamsMatch = (e,h,a) => normTeam(e?.home_team)===normTeam(h) && normTeam(e?.away_team)===normTeam(a);
const buildMode = t => Date.now() >= new Date(t).getTime() ? "live" : "pregame";
const fmtClock  = s => { if(typeof s!=="number"||!Number.isFinite(s)) return "-"; return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`; };
const toIso     = ms => new Date(ms).toISOString();
const todayYmd  = () => new Date().toISOString().slice(0, 10);

// ─── cache ────────────────────────────────────────────────────────────────────
const cg = (m,k) => { const h=m.get(k); if(!h) return null; if(Date.now()>h.e){m.delete(k);return null;} return h.v; };
const cs = (m,k,v,t) => m.set(k, {v, e: Date.now()+t});

// ─── fetch ────────────────────────────────────────────────────────────────────
async function fetchJson(url, opts={}) {
  const ctrl = new AbortController(), t = setTimeout(()=>ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {...opts, signal: ctrl.signal}), txt = await res.text();
    if (!res.ok) throw new Error(`${res.status}: ${txt.slice(0,200)}`);
    try { return JSON.parse(txt); } catch { throw new Error(`Bad JSON: ${txt.slice(0,200)}`); }
  } catch(e) { throw new Error(`fetchJson ${url}: ${e.message}`); }
  finally { clearTimeout(t); }
}

const oddsUrl = (p,q) => `https://api.the-odds-api.com${p}?${new URLSearchParams(q)}`;
const reqOdds = () => !!ODDS_API_KEY;
const reqBdl  = () => !!BALLDONTLIE_API_KEY;
const reqFn   = () => !!FANTASYNERDS_API_KEY;

// ─── Odds API ─────────────────────────────────────────────────────────────────
async function getEvents() {
  const k="events", h=cg(currentCache,k); if(h) return h;
  const d = await fetchJson(oddsUrl(`/v4/sports/${SPORT_KEY}/events`, {apiKey:ODDS_API_KEY}));
  cs(currentCache,k,d,CURRENT_TTL); return d;
}
async function getBoard() {
  const k="board", h=cg(currentCache,k); if(h) return h;
  const d = await fetchJson(oddsUrl(`/v4/sports/${SPORT_KEY}/odds`, {apiKey:ODDS_API_KEY,regions:REGIONS,markets:FEATURED_MARKETS,oddsFormat:ODDS_FORMAT}));
  cs(currentCache,k,d,CURRENT_TTL); return d;
}
async function resolveFeatured({gameId,homeTeam,awayTeam}) {
  if (gameId) {
    try {
      const k=`f:${gameId}`, h=cg(currentCache,k);
      if (h&&h.home_team) return h;
      const d = await fetchJson(oddsUrl(`/v4/sports/${SPORT_KEY}/events/${gameId}/odds`, {apiKey:ODDS_API_KEY,regions:REGIONS,markets:FEATURED_MARKETS,oddsFormat:ODDS_FORMAT}));
      cs(currentCache,k,d,CURRENT_TTL); if(d?.home_team) return d;
    } catch(e) { if(!String(e.message||"").match(/422|INVALID/)) throw e; }
  }
  if (!homeTeam||!awayTeam) throw new Error("Missing team fallback");
  const board = await getBoard();
  const m = (board||[]).find(e => teamsMatch(e,homeTeam,awayTeam));
  if (!m) throw new Error(`No event for ${awayTeam} @ ${homeTeam}`);
  return m;
}
async function getHistSnap(dateIso) {
  const k=`hist:${dateIso}`, h=cg(historicalCache,k); if(h) return h;
  const d = await fetchJson(oddsUrl(`/v4/historical/sports/${SPORT_KEY}/odds`, {apiKey:ODDS_API_KEY,regions:REGIONS,markets:FEATURED_MARKETS,oddsFormat:ODDS_FORMAT,date:dateIso}));
  cs(historicalCache,k,d,HISTORICAL_TTL); return d;
}
async function getProps(evtId) {
  if (!evtId) return {bookmakers:[]};
  const k=`props:${evtId}`, h=cg(currentCache,k); if(h) return h;
  const url = oddsUrl(`/v4/sports/${SPORT_KEY}/events/${evtId}/odds`, {apiKey:ODDS_API_KEY,regions:REGIONS,markets:PLAYER_PROP_MARKETS,oddsFormat:ODDS_FORMAT});
  try { const d=await fetchJson(url); cs(currentCache,k,d,CURRENT_TTL); return d; }
  catch(e) { console.error("props:", e.message); return {bookmakers:[]}; }
}

// ─── Historical comparisons ───────────────────────────────────────────────────
async function buildHistComps(homeTeam, awayTeam) {
  const out = {};
  for (const lb of HISTORICAL_LOOKBACKS) {
    try {
      const snap  = await getHistSnap(toIso(Date.now()-lb.ms));
      const found = (snap?.data||snap||[]).find(e => teamsMatch(e,homeTeam,awayTeam));
      if (!found) { out[lb.label]=null; continue; }
      const hPP=[], aPP=[];
      for (const bm of found?.bookmakers||[]) {
        const h2h = bm.markets?.find(m=>m.key==="h2h");
        if (!h2h) continue;
        const ho=h2h.outcomes?.find(o=>o.name===found.home_team), ao=h2h.outcomes?.find(o=>o.name===found.away_team);
        if (ho&&ao&&ho.price>1&&ao.price>1) {
          const nv=noVig(ho.price,ao.price);
          hPP.push({value:nv.a,weight:1}); aPP.push({value:nv.b,weight:1});
        }
      }
      const hMP = wAvg(hPP), aMP = wAvg(aPP);
      if (hMP) out[lb.label] = { homeMarketProb:r2(hMP), awayMarketProb:r2(aMP) };
      else out[lb.label] = null;
    } catch { out[lb.label] = null; }
  }
  return out;
}

// ─── Props (sportsbook de-vig) ────────────────────────────────────────────────
function buildProps(propsEvt) {
  const gm = {};
  for (const bm of propsEvt?.bookmakers||[])
    for (const mkt of bm.markets||[]) {
      if (!gm[mkt.key]) gm[mkt.key] = [];
      for (const o of mkt.outcomes||[])
        gm[mkt.key].push({book:bm.key, player:o.description||"", side:o.name||"", point:o.point??null, price:o.price??null});
    }

  // Log all available market keys so we can see what the API returns
  const allKeys = Object.keys(gm);
  console.log("[props] Available market keys:", allKeys.join(", "));
  const mm = {
    "player_points":"points",
    "player_assists":"assists",
    "player_rebounds":"rebounds",
    "player_threes":"threes",
    "player_threes_made":"threes",
    "player_three_pointers_made":"threes",
    "player_threes_alternate":"threes",
  };
  const sec = {points:[],assists:[],rebounds:[],threes:[]};
  for (const [mk,dk] of Object.entries(mm)) {
    const grouped = {};
    for (const o of gm[mk]||[]) {
      const key = `${o.player}__${o.point}`;
      if (!grouped[key]) grouped[key] = {player:o.player, point:o.point, overPrices:[], underPrices:[]};
      if ((o.side||"").toLowerCase()==="over"  && typeof o.price==="number") grouped[key].overPrices.push(o.price);
      if ((o.side||"").toLowerCase()==="under" && typeof o.price==="number") grouped[key].underPrices.push(o.price);
    }
    sec[dk] = Object.values(grouped).map(item => {
      const ao=avg(item.overPrices), au=avg(item.underPrices);
      let hp=null;
      if (typeof ao==="number"&&typeof au==="number") hp=noVig(ao,au).a;
      else if (typeof ao==="number") hp=1/ao;
      const dec = hp!=null ? (hp>0.5 ? {pick:"over",probability:hp} : {pick:"under",probability:1-hp}) : null;
      return {player:item.player, line:r2(item.point), overDecimal:r2(ao), overAmerican:d2a(ao),
              hitProbability:r2(hp), coverage:item.overPrices.length+item.underPrices.length,
              pick:dec?.pick||null, pickProbability:r2(dec?.probability)};
    }).filter(r=>r.player&&typeof r.line==="number")
      .sort((a,b)=>(b.coverage-a.coverage)||((b.pickProbability||0)-(a.pickProbability||0)))
      .slice(0,12);
  }
  const all = [...sec.points,...sec.assists,...sec.rebounds,...sec.threes];
  if (!all.length) return {sections:sec, signal:{adj:0,depth:0}};
  let str=0, obs=0;
  for (const r of all) {
    str += clamp((r.coverage-1)*0.0015,0,0.01) + clamp((r.line||0)*0.0005,0,0.02) + clamp(((r.hitProbability||0.5)-0.5)*0.05,-0.015,0.015);
    obs++;
  }
  return {sections:sec, signal:{adj:clamp((str/Math.max(obs,1))*0.4,0,0.01), depth:obs}};
}

// ─── Injury helpers ───────────────────────────────────────────────────────────
const TEAM_ALIASES = {
  "Atlanta Hawks":["hawks","atl","atlanta"],
  "Boston Celtics":["celtics","bos","boston"],
  "Brooklyn Nets":["nets","bkn","brooklyn"],
  "Charlotte Hornets":["hornets","cha","charlotte"],
  "Chicago Bulls":["bulls","chi","chicago"],
  "Cleveland Cavaliers":["cavaliers","cavs","cle","cleveland"],
  "Dallas Mavericks":["mavericks","mavs","dal","dallas"],
  "Denver Nuggets":["nuggets","den","denver"],
  "Detroit Pistons":["pistons","det","detroit"],
  "Golden State Warriors":["warriors","gsw","golden state","golden"],
  "Houston Rockets":["rockets","hou","houston"],
  "Indiana Pacers":["pacers","ind","indiana"],
  "Los Angeles Clippers":["clippers","lac","la clippers"],
  "Los Angeles Lakers":["lakers","lal","la lakers"],
  "Memphis Grizzlies":["grizzlies","mem","memphis"],
  "Miami Heat":["heat","mia","miami"],
  "Milwaukee Bucks":["bucks","mil","milwaukee"],
  "Minnesota Timberwolves":["timberwolves","wolves","min","minnesota"],
  "New Orleans Pelicans":["pelicans","nop","new orleans"],
  "New York Knicks":["knicks","nyk","new york"],
  "Oklahoma City Thunder":["thunder","okc","oklahoma"],
  "Orlando Magic":["magic","orl","orlando"],
  "Philadelphia 76ers":["76ers","sixers","phi","philadelphia","phila"],
  "Phoenix Suns":["suns","phx","phoenix"],
  "Portland Trail Blazers":["trail blazers","blazers","por","portland"],
  "Sacramento Kings":["kings","sac","sacramento"],
  "San Antonio Spurs":["spurs","sas","san antonio"],
  "Toronto Raptors":["raptors","tor","toronto"],
  "Utah Jazz":["jazz","uta","utah"],
  "Washington Wizards":["wizards","was","washington"],
};

function getTeamTokens(name) {
  const nm = normTeam(name);
  const aliases = TEAM_ALIASES[name] || [];
  const tokens = new Set([nm, ...aliases]);
  const last = nm.split(" ").pop();
  if (last && last.length > 3) tokens.add(last);
  return [...tokens].filter(Boolean);
}

function rowBelongsToTeam(row, teamName) {
  const teamFields = [
    row?.team?.full_name, row?.team?.abbreviation,
    row?.player?.team?.full_name, row?.player?.team?.abbreviation,
    row?.TeamName, row?.team_name, row?.teamName,
  ].filter(Boolean);
  const tokens = getTeamTokens(teamName);
  for (const field of teamFields) {
    const fn = normTeam(String(field));
    if (tokens.some(t => fn === t || fn.includes(t))) return true;
  }
  const nm  = normTeam(teamName);
  const j   = JSON.stringify(row).toLowerCase();
  const last = nm.split(" ").pop();
  if (last && last.length >= 4 && j.includes(`"${last}"`)) return true;
  if (j.includes(nm.replace(/[^a-z0-9]/g," ").trim())) return true;
  return false;
}

const nbdl = p => Array.isArray(p) ? p : Array.isArray(p?.data) ? p.data : [];

async function getBdlInjuries() {
  if (!reqBdl()) return {available:false, rows:[], source:"none"};
  const k="bdl:inj", h=cg(sideInfoCache,k); if(h) return h;
  try {
    const r = await fetchJson("https://api.balldontlie.io/v1/player_injuries?per_page=100", {headers:{Authorization:BALLDONTLIE_API_KEY}});
    const v = {available:true, rows:nbdl(r), source:"balldontlie"};
    cs(sideInfoCache,k,v,SIDEINFO_TTL); return v;
  } catch(e) { console.error("bdl inj:", e.message); return {available:false,rows:[],source:"none"}; }
}
async function getBdlLineups(d="") {
  if (!reqBdl()) return {available:false,rows:[],source:"none"};
  const date=d||todayYmd(), k=`bdl:lu:${date}`, h=cg(sideInfoCache,k); if(h) return h;
  try {
    const r = await fetchJson(`https://api.balldontlie.io/v1/lineups?dates[]=${encodeURIComponent(date)}&per_page=100`, {headers:{Authorization:BALLDONTLIE_API_KEY}});
    const v = {available:true, rows:nbdl(r), source:"balldontlie"};
    cs(sideInfoCache,k,v,SIDEINFO_TTL); return v;
  } catch(e) { return {available:false,rows:[],source:"none"}; }
}
async function getFnInjuries() {
  if (!reqFn()) return {available:false,rows:[],source:"none"};
  const k="fn:inj", h=cg(sideInfoCache,k); if(h) return h;
  try {
    const r = await fetchJson(`https://api.fantasynerds.com/v1/nba/injuries?apikey=${encodeURIComponent(FANTASYNERDS_API_KEY)}`);
    const rows = Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : [];
    const v = {available:true, rows, source:"fantasynerds"};
    cs(sideInfoCache,k,v,SIDEINFO_TTL); return v;
  } catch { return {available:false,rows:[],source:"none"}; }
}
async function bestInjuries() {
  const b = await getBdlInjuries().catch(()=>({available:false,rows:[]}));
  if (b.available && b.rows.length) return b;
  return getFnInjuries().catch(()=>({available:false,rows:[],source:"none"}));
}
async function bestLineups(d="") {
  return getBdlLineups(d).catch(()=>({available:false,rows:[],source:"none"}));
}

function extractPlayerName(obj) {
  if (!obj) return "";
  if (obj.player && typeof obj.player === "object") {
    const full = `${obj.player.first_name||""} ${obj.player.last_name||""}`.trim();
    if (full.length > 1) return full;
  }
  for (const k of ["PlayerName","playerName","name","Name","full_name","player_name"])
    if (typeof obj[k]==="string" && obj[k].length>1) return obj[k];
  return "";
}
function injSeverity(r) {
  const t = JSON.stringify(r).toLowerCase();
  if (t.includes("out"))          return 1.0;
  if (t.includes("doubtful"))     return 0.8;
  if (t.includes("questionable")) return 0.5;
  if (t.includes("probable"))     return 0.2;
  return 0.4;
}
function depthRole(r) {
  const t = JSON.stringify(r).toLowerCase();
  if (t.includes("starter")||t.includes('"1"')||t.includes("1st")) return 1.0;
  if (t.includes("2nd")||t.includes('"2"')) return 0.55;
  if (t.includes("3rd")||t.includes('"3"')) return 0.25;
  return 0.45;
}

function summarizeInjury(homeTeam, awayTeam, injRows, linRows) {
  const homeInj = injRows.filter(r => rowBelongsToTeam(r, homeTeam));
  const awayInj = injRows.filter(r => rowBelongsToTeam(r, awayTeam));
  const homeLin = linRows.filter(r => rowBelongsToTeam(r, homeTeam));
  const awayLin = linRows.filter(r => rowBelongsToTeam(r, awayTeam));

  function calcPenalty(inj, lin) {
    let penalty=0, startersOut=0, projStarters=0;
    for (const i of inj) {
      const sev = injSeverity(i);
      const pn  = extractPlayerName(i).toLowerCase();
      const lm  = pn ? lin.find(r => JSON.stringify(r).toLowerCase().includes(pn)) : null;
      const rw  = lm ? depthRole(lm) : 0.4;
      penalty += 0.005 + sev*0.012 + rw*0.010;
      if (sev >= 0.8 && rw >= 0.8) startersOut++;
    }
    for (const l of lin) if (depthRole(l) >= 0.8) projStarters++;
    return {
      penalty:          clamp(penalty, 0, 0.12),
      startersOut,
      starterCertainty: lin.length ? clamp(projStarters/5, 0, 1) : 0,
    };
  }

  const hc = calcPenalty(homeInj, homeLin);
  const ac = calcPenalty(awayInj, awayLin);

  return {
    available:            injRows.length > 0 || linRows.length > 0,
    homeInjuriesCount:    homeInj.length,
    awayInjuriesCount:    awayInj.length,
    homePenalty:          hc.penalty,
    awayPenalty:          ac.penalty,
    homeStartersOut:      hc.startersOut,
    awayStartersOut:      ac.startersOut,
    homeStarterCertainty: hc.starterCertainty,
    awayStarterCertainty: ac.starterCertainty,
    lineupRowsCount:      homeLin.length + awayLin.length,
    homeInjuries:         homeInj,
    awayInjuries:         awayInj,
    lineups:              [...homeLin, ...awayLin],
  };
}

// ─── Live tracker ─────────────────────────────────────────────────────────────
async function safeGetLive({gameId, homeTeam, awayTeam}) {
  try {
    return await getLiveTrackerData({gameId, homeTeam, awayTeam})
      || {liveFound:false, homeScore:0, awayScore:0, period:1, clockSec:720, clock:"12:00"};
  } catch(e) {
    console.error("liveTracker:", e.message);
    return {liveFound:false, homeScore:0, awayScore:0, period:1, clockSec:720, clock:"12:00"};
  }
}

// ─── Edge / snapshot ──────────────────────────────────────────────────────────
function addEdgeHist(gid, edge, ts) {
  if (!edgeHistoryStore[gid]) edgeHistoryStore[gid] = [];
  let sm = edge;
  if (edgeHistoryStore[gid].length > 0) {
    const prev = edgeHistoryStore[gid].at(-1).edge;
    sm = prev * 0.55 + edge * 0.45;
  }
  edgeHistoryStore[gid].push({timestamp:ts, edge:sm});
  const cut = Date.now() - 15*60*1000;
  edgeHistoryStore[gid] = edgeHistoryStore[gid].filter(p => new Date(p.timestamp).getTime() >= cut);
  return sm;
}
function logSnap(gid, snap) {
  if (!snapshotLogStore[gid]) snapshotLogStore[gid] = [];
  snapshotLogStore[gid].push(snap);
  if (snapshotLogStore[gid].length > SNAP_RET)
    snapshotLogStore[gid] = snapshotLogStore[gid].slice(-SNAP_RET);
}

// ─── Learning wrappers ────────────────────────────────────────────────────────
const safeLS  = () => typeof learning.getLearningSummary    === "function" ? learning.getLearningSummary()    : {};
const safeCT  = () => typeof learning.getCalibrationTable   === "function" ? learning.getCalibrationTable()   : {};
const safeBCT = () => typeof learning.buildCalibrationTable === "function" ? learning.buildCalibrationTable() : {};
const safeRS  = s  => { if (typeof learning.recordSnapshot  === "function") learning.recordSnapshot(s); };
const safeGS  = () => typeof learning.getSnapshots          === "function" ? learning.getSnapshots()          : [];
const safeUGR = p  => typeof learning.updateGameResult      === "function" ? learning.updateGameResult(p)     : 0;
const safeAC  = p  => typeof learning.applyCalibration      === "function" ? learning.applyCalibration(p)     : p;

const stakeLabel = raw => {
  const text = String(raw||"No bet");
  const map  = {"No bet":0, "0.5u":0.5, "1u":1, "1.5u":1.5};
  return {tier:text, fraction:Object.prototype.hasOwnProperty.call(map,text)?map[text]:0};
};

function buildOddsFormats(d) {
  if (typeof d!=="number"||!Number.isFinite(d)||d<=1) return {decimal:null,american:null,impliedPercent:null};
  return {decimal:r2(d), american:d2a(d), impliedPercent:r2(1/d)};
}

function buildVerdict(edge, noBet, conf) {
  if (noBet?.blocked) return "Avoid";
  if (edge >= 0.045 && (conf?.percent||0) >= 0.62) return "Bet now";
  if (edge >= 0.02)  return "Watch";
  return "Avoid";
}

// ── 2. KELLY CRITERION stake sizing ──────────────────────────────────────────
// Tells you exactly how much to bet, not just whether to bet
// Uses quarter-Kelly (25%) for safety with 5% bankroll cap
function computeKelly(trueProb, decimalOdds) {
  if (!trueProb || !decimalOdds || decimalOdds <= 1 || trueProb <= 0) return 0;
  const b = decimalOdds - 1;
  const q = 1 - trueProb;
  const fullKelly = (b * trueProb - q) / b;
  return Math.max(0, Math.min(fullKelly * 0.25, 0.05)); // quarter-Kelly, max 5%
}

// ── 6. REFEREE TENDENCIES ─────────────────────────────────────────────────────
// High-foul refs inflate FT-dependent scorers and slow pace
const HIGH_FOUL_REFS = new Set([
  "Tony Brothers","Scott Foster","Ed Malloy","Rodney Mott",
  "James Williams","Bill Kennedy","Zach Zarba"
]);
const LOW_FOUL_REFS = new Set([
  "Marc Davis","Monty McCutchen","Josh Tiven","Kevin Scott"
]);

async function fetchGameRefs(gameId) {
  if (!gameId) return null;
  const k = `nba:refs:${gameId}`, h = cg(sideInfoCache, k); if (h) return h;
  try {
    const j = await fetchJson(
      `https://stats.nba.com/stats/boxscoresummaryv2?GameID=${gameId}`,
      { headers: {
        "User-Agent": "Mozilla/5.0", "Referer": "https://www.nba.com/",
        "x-nba-stats-origin": "stats", "x-nba-stats-token": "true",
      }}
    );
    const refs = [];
    for (const rs of j?.resultSets || []) {
      if (rs.name === "Officials") {
        const hdrs = rs.headers || [];
        for (const row of rs.rowSet || []) {
          const r = Object.fromEntries(hdrs.map((h, i) => [h, row[i]]));
          refs.push(`${r.FIRST_NAME} ${r.LAST_NAME}`.trim());
        }
      }
    }
    const refData = {
      names: refs,
      highFoul:  refs.some(n => HIGH_FOUL_REFS.has(n)),
      lowFoul:   refs.some(n => LOW_FOUL_REFS.has(n)),
      // High-foul ref = more free throws = pace slows, FT-reliant scorers benefit
      paceAdj:   refs.some(n => HIGH_FOUL_REFS.has(n)) ? -1.5 : refs.some(n => LOW_FOUL_REFS.has(n)) ? +1.5 : 0,
      foulAdj:   refs.some(n => HIGH_FOUL_REFS.has(n)) ? 0.02  : refs.some(n => LOW_FOUL_REFS.has(n)) ? -0.01 : 0,
    };
    return cs(sideInfoCache, k, refData, 6 * 60 * 60 * 1000);
  } catch { return null; }
}

// ── 7. TRAVEL FATIGUE ─────────────────────────────────────────────────────────
const TEAM_TIMEZONES = {
  "Los Angeles Lakers":-8,"Los Angeles Clippers":-8,"Golden State Warriors":-8,
  "Sacramento Kings":-8,"Phoenix Suns":-7,"Denver Nuggets":-7,"Utah Jazz":-7,
  "Portland Trail Blazers":-8,"Dallas Mavericks":-6,"Houston Rockets":-6,
  "San Antonio Spurs":-6,"New Orleans Pelicans":-6,"Oklahoma City Thunder":-6,
  "Memphis Grizzlies":-6,"Minnesota Timberwolves":-6,"Chicago Bulls":-6,
  "Milwaukee Bucks":-6,"Indiana Pacers":-5,"Detroit Pistons":-5,
  "Cleveland Cavaliers":-5,"Atlanta Hawks":-5,"Charlotte Hornets":-5,
  "Orlando Magic":-5,"Miami Heat":-5,"Washington Wizards":-5,
  "Philadelphia 76ers":-5,"New York Knicks":-5,"Brooklyn Nets":-5,
  "Boston Celtics":-5,"Toronto Raptors":-5,
};

function computeTravelFatigue(homeTeam, awayTeam, homeForm, awayForm) {
  const homeTZ = TEAM_TIMEZONES[homeTeam] || -6;
  const awayTZ = TEAM_TIMEZONES[awayTeam] || -6;
  const tzDiff = Math.abs(homeTZ - awayTZ);

  // Away team traveling across many timezones + back-to-back = significant fatigue
  const awayFatigue = (awayForm?.is_b2b ? 0.03 : 0) + (tzDiff >= 3 ? 0.02 : tzDiff >= 2 ? 0.01 : 0);
  const homeFatigue = homeForm?.is_b2b ? 0.015 : 0;

  return {
    awayFatigue:   r2(awayFatigue),
    homeFatigue:   r2(homeFatigue),
    timezoneDiff:  tzDiff,
    // Positive = helps home team (away team is fatigued)
    netFatigueAdj: r2(awayFatigue - homeFatigue),
  };
}

// ── 9. CORRELATED PARLAY DETECTION ───────────────────────────────────────────
// Returns correlation score between game pick and player prop (0-1)
function detectParlayCorrelation(pickTeam, propPlayer, propSection) {
  // If we're betting a team to win AND a player from that same team to go over
  // those are highly correlated (~0.7-0.85 depending on role)
  const ptsCorrHigh = ["points", "threes"]; // strongly correlated with team winning
  const ptsCorrMed  = ["assists"];        // moderately correlated
  if (ptsCorrHigh.includes(propSection)) return 0.80;
  if (ptsCorrMed.includes(propSection))  return 0.65;
  return 0.55;
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

app.get("/health", (req, res) => {
  const s   = safeLS();
  const pls = getPropLearningSummary();
  res.json({
    status: "ok",
    oddsKey: reqOdds(), bdlKey: reqBdl(), fnKey: reqFn(),
    learning: {
      total:   s.totalSnapshots  || 0,
      graded:  s.gradedSnapshots || 0,
      winRate: s.overallWinRate  != null ? (s.overallWinRate*100).toFixed(1)+"%" : "n/a",
    },
    propLearning: {
      total:    pls.total    || 0,
      graded:   pls.graded   || 0,
      accuracy: pls.accuracy != null ? (pls.accuracy*100).toFixed(1)+"%" : "n/a",
    },
    learnedWeightsActive: JSON.stringify(learnedWeights) !== JSON.stringify(DEFAULT_WEIGHTS),
    ts: new Date().toISOString(),
  });
});

app.get("/games", async (req, res) => {
  try {
    if (!reqOdds()) return res.status(400).json({error:"Missing ODDS_API_KEY", games:[]});
    const evts = await getEvents(), now = Date.now(), nxt = now + 24*60*60*1000;
    const games = (evts||[])
      .filter(e => new Date(e.commence_time).getTime() <= nxt)
      .map(e => ({
        id: e.id, label: `${e.away_team} @ ${e.home_team}`,
        homeTeam: e.home_team, awayTeam: e.away_team,
        commenceTime: e.commence_time, mode: buildMode(e.commence_time),
      }));
    res.json({games});
  } catch(e) { res.status(500).json({error:e.message, games:[]}); }
});

// ─── Main /odds route ─────────────────────────────────────────────────────────
app.get("/odds", async (req, res) => {
  try {
    if (!reqOdds()) return res.status(400).json({error:"Missing ODDS_API_KEY"});

    const gameId   = req.query.gameId   || "";
    const homeTeam = req.query.homeTeam || "";
    const awayTeam = req.query.awayTeam || "";
    if (!gameId && (!homeTeam||!awayTeam))
      return res.status(400).json({error:"Need gameId or homeTeam+awayTeam"});

    const featured   = await resolveFeatured({gameId, homeTeam, awayTeam});
    const mode       = buildMode(featured.commence_time);
    const lineupDate = (featured.commence_time||"").slice(0,10) || todayYmd();

    // ── Fetch everything concurrently ──────────────────────────────────────
    const [props, histComps, injInfo, linInfo, liveRaw, refData] = await Promise.allSettled([
      getProps(featured.id),
      buildHistComps(featured.home_team, featured.away_team),
      bestInjuries(),
      bestLineups(lineupDate),
      mode === "live"
        ? safeGetLive({gameId:featured.id, homeTeam:featured.home_team, awayTeam:featured.away_team})
        : Promise.resolve(null),
      // 6. REFEREE TENDENCIES — fetch who's calling the game
      fetchGameRefs(featured.id).catch(() => null),
    ]).then(rs => rs.map(r => r.status === "fulfilled" ? r.value : null));

    const injRows = injInfo?.rows || [];
    const linRows = linInfo?.rows || [];

    // ── Sportsbook de-vigged prop sections ────────────────────────────────
    const { sections: rawPropSections, signal: propSignal } = buildProps(props || {bookmakers:[]});

    // ── AI independent prop predictions ──────────────────────────────────
    let aiPropSections = rawPropSections;
    try {
      aiPropSections = await predictGameProps(
        rawPropSections, featured.home_team, featured.away_team,
        // 4. Pass injuries so cascade can boost teammates
        { homeInjuries: injSummary?.homeInjuries || [], awayInjuries: injSummary?.awayInjuries || [] }
      );
    } catch (e) {
      console.error("[server] AI props failed:", e.message);
      aiPropSections = rawPropSections;
    }

    // ── Record prop snapshots for learning + 5. LINE MOVEMENT TRACKING ──────
    const gameDate  = (featured.commence_time || new Date().toISOString()).slice(0, 10);
    const statTypeMap = { points:"points", assists:"assists", rebounds:"rebounds", threes:"threes" };
    for (const [section, rows] of Object.entries(aiPropSections)) {
      for (const row of rows || []) {
        if (!row.playerId || row.line == null || !row.aiPick) continue;
        const snapId = `${featured.id}_${row.playerId}_${section}`;
        // Track first-seen line vs current line — significant move = sharp signal
        const existingSnap = (snapshotLogStore[snapId] || [])[0];
        const firstSeenLine = existingSnap?.line ?? row.line;
        const lineMovement  = r2(row.line - firstSeenLine);
        recordPropSnap({
          id:           `${snapId}_${row.line}`,
          gameId:       featured.id,
          gameDate,
          player:       row.player,
          playerId:     row.playerId,
          statType:     statTypeMap[section] || section,
          line:         row.line,
          firstSeenLine,
          lineMovement,
          pick:         row.aiPick,
          overProb:     row.aiOverProb,
          pickProb:     row.aiPickProb,
          verdict:      row.aiVerdict,
          features:     row.features,
          homeTeam:     featured.home_team,
          awayTeam:     featured.away_team,
        });
        // Attach line movement to the prop row for display
        row.lineMovement  = lineMovement;
        row.firstSeenLine = firstSeenLine;
      }
    }

    // ── Injury summary ────────────────────────────────────────────────────
    const injSummary = summarizeInjury(
      featured.home_team, featured.away_team, injRows, linRows
    );

    // ── Independent stats model ───────────────────────────────────────────
    let statsResult = null;
    try {
      statsResult = await computeIndependentWinProb(
        featured.home_team, featured.away_team, liveRaw,
        { homeInjuries: injSummary.homeInjuries, awayInjuries: injSummary.awayInjuries }
      );
    } catch(e) { console.error("[stats_model] failed:", e.message); }

    // ── Market / Live model ───────────────────────────────────────────────
    let marketModel, liveScoreState = null;
    if (mode === "live") {
      marketModel = buildEliteLiveModel({
        featuredOdds:    featured,
        liveState:       liveRaw,
        pregameBaseline: statsResult ? {homeMarketProb: statsResult.homeWinProb} : null,
        calibrationFn:   safeAC,
      });
      liveScoreState = marketModel.scoreState ? {
        ...marketModel.scoreState,
        formattedClock: fmtClock(marketModel.scoreState.clockSec),
      } : null;
    } else {
      marketModel = buildElitePregameModel({
        featuredOdds:          featured,
        historicalComparisons: histComps || {},
        propSignal,
        injurySummary:         injSummary,
        calibrationFn:         safeAC,
      });
    }

    // ── PURE AI PREDICTION — zero market interference ─────────────────────────
    // Stats model is the ONLY source for pick and win probability.
    // Market is used ONLY for edge calculation and display.

    const statsHomeProb = statsResult?.homeWinProb ?? null;

    // Pick from stats model only
    const pickSide = statsHomeProb !== null
      ? (statsHomeProb >= 0.5 ? "home" : "away")
      : marketModel.pickSide; // fallback only if stats completely unavailable
    const pickTeam = pickSide === "home" ? featured.home_team : featured.away_team;
    const pick     = `${pickTeam} to win`;

    // True probability = pure stats output, no market blending
    const trueProb = statsHomeProb !== null
      ? (pickSide === "home" ? statsHomeProb : 1 - statsHomeProb)
      : marketModel.trueProbability;

    // Market probability — for display and edge only
    const homeMarketProb = r2(
      marketModel.modelDetails?.homeMarketProb ??
      (marketModel.pickSide === "home"
        ? marketModel.impliedProbability
        : 1 - (marketModel.impliedProbability || 0.5))
    );
    const marketImplied = pickSide === "home" ? homeMarketProb : 1 - homeMarketProb;

    // Edge = how much AI disagrees with market (positive = AI more bullish on pick)
    const finalEdge  = r2(trueProb - marketImplied);

    // ── 2. KELLY CRITERION stake sizing ──────────────────────────────────────
    const bestDecimal = marketModel.sportsbookDecimal || 2.0;
    const kellyFraction = computeKelly(trueProb, bestDecimal);
    const kellyStake = {
      fraction:    r2(kellyFraction),
      units:       r2(kellyFraction * 100), // % of bankroll
      label:       kellyFraction >= 0.04 ? "Strong bet" : kellyFraction >= 0.02 ? "Small bet" : "Pass",
      explanation: kellyFraction > 0
        ? `Bet ${(kellyFraction*100).toFixed(1)}% of bankroll at ${bestDecimal.toFixed(2)} odds`
        : "No positive expected value",
    };

    // ── 7. TRAVEL FATIGUE ────────────────────────────────────────────────────
    const homeForm = statsResult?.matchupProfile?.homeStats;
    const awayForm = statsResult?.matchupProfile?.awayStats;
    const travelFatigue = computeTravelFatigue(
      featured.home_team, featured.away_team, homeForm, awayForm
    );

    // ── 6. REFEREE TENDENCIES ────────────────────────────────────────────────
    const refs = refData || { names: [], highFoul: false, lowFoul: false, paceAdj: 0, foulAdj: 0 };

    // ── 9. CORRELATED PARLAY DETECTION ───────────────────────────────────────
    // Pre-calculate correlation between team pick and top prop
    const topProp = Object.values(aiPropSections).flat().find(p => p.aiPickProb >= 0.65);
    const parlayCorrelation = topProp ? {
      player:      topProp.player,
      statType:    Object.keys(aiPropSections).find(k => aiPropSections[k].includes(topProp)),
      correlation: detectParlayCorrelation(pickTeam, topProp.player, topProp.statType),
      warning:     "Betting team ML + same-team prop reduces diversification",
    } : null;

    const finalVerdict = buildVerdict(finalEdge, marketModel.noBetFilter, {});

    // ── Snapshot + edge history ───────────────────────────────────────────
    const ts      = new Date().toISOString();
    const ek      = featured.id || gameId || `${featured.home_team}_${featured.away_team}`;
    const smoothed = addEdgeHist(ek, finalEdge, ts);

    const snapshot = {
      id: `${ek}_${ts}`, gameId: ek, timestamp: ts,
      commenceTime: featured.commence_time,
      homeTeam: featured.home_team, awayTeam: featured.away_team,
      mode, pickSide, pickTeam, pick,
      impliedProbability:        r2(marketImplied),
      trueProbability:           r2(trueProb),
      calibratedTrueProbability: r2(trueProb),
      rawEdge:  r2(finalEdge), edge: r2(smoothed), calibratedEdge: r2(finalEdge),
      sportsbookDecimal: r2(marketModel.sportsbookDecimal),
      verdict: finalVerdict,
      statsModelHomeProb: statsHomeProb ? r2(statsHomeProb) : null,
      statsSignals: statsResult?.signals || null,
      ...(marketModel.modelDetails||{}),
      source: mode,
    };
    logSnap(ek, snapshot);
    safeRS({...snapshot, result:null});

    const ls  = safeLS();
    const pls = getPropLearningSummary();

    // ── Response ──────────────────────────────────────────────────────────
    res.json({
      id: featured.id,
      homeTeam: featured.home_team,
      awayTeam: featured.away_team,
      commenceTime: featured.commence_time,
      gameMode: mode,
      pick,
      verdict: finalVerdict,
      // Confidence purely from AI edge (not market internal)
      confidence: (() => {
        const e = Math.abs(finalEdge);
        const label = e >= 0.10 ? "High" : e >= 0.05 ? "Medium" : "Low";
        const pct   = e >= 0.10 ? 0.80   : e >= 0.05 ? 0.65     : 0.50;
        return { label, percent: r2(pct) };
      })(),
      noBetFilter: marketModel.noBetFilter || {blocked:false,reasons:[]},

      // AI probabilities (pure stats, no market)
      pickSide,
      trueProbability:           r2(trueProb),
      homeAiProb:                r2(statsHomeProb ?? 0.5),
      awayAiProb:                r2(1 - (statsHomeProb ?? 0.5)),

      // Market probabilities (for display/edge only)
      impliedProbability:        r2(marketImplied),
      homeMarketProb:            r2(homeMarketProb),
      awayMarketProb:            r2(1 - homeMarketProb),

      edge:           r2(smoothed),
      rawEdge:        r2(finalEdge),
      calibratedEdge: r2(finalEdge),

      // ── 2. Kelly Criterion ──────────────────────────────────────────────
      kellyStake,

      // ── 6. Referee tendencies ───────────────────────────────────────────
      referees: refs,

      // ── 7. Travel fatigue ───────────────────────────────────────────────
      travelFatigue,

      // ── 9. Correlated parlay ────────────────────────────────────────────
      parlayCorrelation,

      aiModel: {
        statsHomeWinProb:    statsHomeProb ? r2(statsHomeProb) : null,
        statsAwayWinProb:    statsHomeProb ? r2(1-statsHomeProb) : null,
        signals:             statsResult?.signals || null,
        injuryAdjustments:   statsResult?.injuryAdjustments || null,
        matchupProfile:      statsResult?.matchupProfile || null,
        meta:                statsResult?.meta || null,
        usingLearnedWeights: false,
        // 1. Playoff mode flag
        playoffMode:         statsResult?.meta?.playoffMode ?? false,
        // 3. Strength of schedule
        sosHome:             statsResult?.meta?.sosHome ?? 1.0,
        sosAway:             statsResult?.meta?.sosAway ?? 1.0,
        propLearning: {
          total:    pls.total    || 0,
          graded:   pls.graded   || 0,
          accuracy: pls.accuracy,
          byType:   pls.byType   || {},
        },
      },

      oddsFormats:     buildOddsFormats(marketModel.sportsbookDecimal),
      stakeSuggestion: stakeLabel(marketModel.stakeSuggestion),

      learningSummary: {
        totalSnapshots:  ls.totalSnapshots  || 0,
        gradedSnapshots: ls.gradedSnapshots || 0,
        overallWinRate:  ls.overallWinRate  != null ? ls.overallWinRate  : null,
        recentWinRate:   ls.recentWinRate   != null ? ls.recentWinRate   : null,
        betNowWinRate:   ls.betNowWinRate   != null ? ls.betNowWinRate   : null,
        watchWinRate:    ls.watchWinRate    != null ? ls.watchWinRate    : null,
        byVerdict:       ls.byVerdict       || {},
      },

      calibrationTable: safeCT(),
      history: (edgeHistoryStore[ek]||[]).map(p => ({timestamp:p.timestamp, edge:r2(p.edge)})),

      modelDetails: {
        ...(marketModel.modelDetails||{}),
        historicalComparisons: histComps || {},
        propSignal,
        homeMarketProb: r2(homeMarketProb),
        awayMarketProb: r2(1 - homeMarketProb),
      },

      bookmakerTable: marketModel.bookmakerTable || [],

      // ── AI-enhanced prop sections ──────────────────────────────────────
      propSections: aiPropSections,

      injuryStatus: {
        available:            injSummary.available,
        homeInjuriesCount:    injSummary.homeInjuriesCount,
        awayInjuriesCount:    injSummary.awayInjuriesCount,
        lineupRowsCount:      injSummary.lineupRowsCount,
        homePenalty:          r2(injSummary.homePenalty),
        awayPenalty:          r2(injSummary.awayPenalty),
        homeStartersOut:      injSummary.homeStartersOut,
        awayStartersOut:      injSummary.awayStartersOut,
        homeStarterCertainty: r2(injSummary.homeStarterCertainty),
        awayStarterCertainty: r2(injSummary.awayStarterCertainty),
        sourceSelection:      {injuries: injInfo?.source||"none", lineups: linInfo?.source||"none"},
        homeInjuries:         injSummary.homeInjuries,
        awayInjuries:         injSummary.awayInjuries,
      },

      scoreState: liveScoreState,
      updatedAt:  ts,
    });

  } catch(e) { console.error("/odds error:", e); res.status(500).json({error: e.message}); }
});

// ─── Game model endpoints ─────────────────────────────────────────────────────
app.get("/snapshots", (req, res) => {
  const gid = req.query.gameId;
  if (!gid) return res.status(400).json({error:"Missing gameId"});
  res.json({
    gameId: gid,
    snapshots: (snapshotLogStore[gid]||[]).map(s => ({
      ...s,
      impliedProbability: r2(s.impliedProbability),
      trueProbability:    r2(s.trueProbability),
      edge:               r2(s.edge),
      calibratedEdge:     r2(s.calibratedEdge),
    })),
  });
});

app.get("/learning/summary",     (req,res) => { try { res.json(safeLS()); }      catch(e) { res.status(500).json({error:e.message}); } });
app.get("/learning/calibration", (req,res) => { try { res.json({calibration:safeCT()}); } catch(e) { res.status(500).json({error:e.message}); } });
app.get("/learning/weights", (req,res) => {
  try {
    let sw = null;
    try { sw = require("./data/signal_weights.json"); } catch {}
    res.json({
      marketWeights:  learnedWeights,
      signalWeights:  sw?.weights||null,
      marketDefaults: DEFAULT_WEIGHTS,
      usingLearned:   JSON.stringify(learnedWeights)!==JSON.stringify(DEFAULT_WEIGHTS),
    });
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.post("/learning/run", async (req,res) => {
  try {
    const {gradeAllUngraded} = require("./auto_grader");
    const r = await gradeAllUngraded();
    learnedWeights = loadLearnedWeights();
    res.json({...r, weightsReloaded:true});
  } catch(e) { res.status(500).json({error:e.message}); }
});
app.get("/model/review", (req,res) => {
  try { res.json(buildModelReview(safeGS())); }
  catch(e) { res.status(500).json({error:e.message}); }
});
app.post("/learning/grade", (req,res) => {
  try {
    const {gameId,finalWinner,finalHomeScore,finalAwayScore} = req.body||{};
    if (!gameId||!finalWinner) return res.status(400).json({error:"Missing gameId or finalWinner"});
    if (!["home","away"].includes(finalWinner)) return res.status(400).json({error:'finalWinner must be "home" or "away"'});
    const updated = safeUGR({gameId,finalWinner,finalHomeScore,finalAwayScore});
    const cal     = safeBCT();
    learnedWeights = loadLearnedWeights();
    res.json({updatedSnapshots:updated, calibrationBuckets:Object.keys(cal).length, learningSummary:safeLS()});
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ─── Prop learning endpoints ──────────────────────────────────────────────────
app.get("/props/learning", (req, res) => {
  try {
    res.json(getPropLearningSummary());
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post("/props/grade", async (req, res) => {
  try {
    const result = await gradeProps();
    res.json(result);
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get("/props/snapshots", (req, res) => {
  const { player, statType, graded, limit = 100 } = req.query;
  try {
    let snaps = getPropSnapshots();
    if (player)   snaps = snaps.filter(s => (s.player||"").toLowerCase().includes(player.toLowerCase()));
    if (statType) snaps = snaps.filter(s => s.statType === statType);
    if (graded === "true")  snaps = snaps.filter(s => s.result);
    if (graded === "false") snaps = snaps.filter(s => !s.result);
    const total  = snaps.length;
    const gradedCount = snaps.filter(s => s.result).length;
    const correct     = snaps.filter(s => s.result?.modelCorrect).length;
    res.json({
      total,
      graded:   gradedCount,
      accuracy: gradedCount ? Math.round(correct / gradedCount * 10000) / 10000 : null,
      snaps:    snaps.slice(-Number(limit)),
    });
  } catch(e) { res.status(500).json({error:e.message}); }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`[server] Running on port ${PORT}`);
  console.log(`[server] Learned weights active: ${JSON.stringify(learnedWeights) !== JSON.stringify(DEFAULT_WEIGHTS)}`);

  if (reqBdl()) {
    // Game result grader (every 1 hour)
    startAutoGradeScheduler(60 * 60 * 1000);
    // Prop outcome grader (every 2 hours)
    startPropGradeScheduler(2 * 60 * 60 * 1000);
  } else {
    console.warn("[server] No BALLDONTLIE_API_KEY — auto-graders disabled");
  }
});
