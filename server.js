const express  = require("express");
const path     = require("path");
const learning = require("./learning");
const { buildEliteLiveModel }    = require("./live_model");
const { getLiveTrackerData }     = require("./live_tracker");
const { buildElitePregameModel } = require("./pregame_model");
const { buildModelReview }       = require("./model_review");
const { computeIndependentWinProb, computeEdge } = require("./stats_model");
const { startAutoGradeScheduler }                = require("./auto_grader");
const { loadLearnedWeights, applyLearnedWeights, DEFAULT_WEIGHTS } = require("./weight_learner");

const app  = express();
const PORT = process.env.PORT || 3000;
const ODDS_API_KEY         = process.env.ODDS_API_KEY        || "";
const BALLDONTLIE_API_KEY  = process.env.BALLDONTLIE_API_KEY || "";
const FANTASYNERDS_API_KEY = process.env.FANTASYNERDS_API_KEY|| "";

const SPORT_KEY        = "basketball_nba";
const REGIONS          = "us";
const ODDS_FORMAT      = "decimal";
const FEATURED_MARKETS = "h2h,spreads,totals";
const PLAYER_PROP_MARKETS = ["player_points","player_rebounds","player_assists","player_points_rebounds_assists"].join(",");
const HISTORICAL_LOOKBACKS = [{ label:"2h", ms:2*60*60*1000 },{ label:"24h", ms:24*60*60*1000 }];

const currentCache=new Map(), historicalCache=new Map(), sideInfoCache=new Map();
const edgeHistoryStore={}, snapshotLogStore={};
const CURRENT_TTL=25*1000, HISTORICAL_TTL=30*60*1000, SIDEINFO_TTL=10*60*1000, SNAP_RET=500;

// ── learned weights: reload every 30 min ──────────────────────────────────────
let learnedWeights = loadLearnedWeights();
setInterval(()=>{ learnedWeights=loadLearnedWeights(); },30*60*1000);

app.use(express.json());
process.on("unhandledRejection",r=>console.error("UNHANDLED:",r));
process.on("uncaughtException", e=>console.error("UNCAUGHT:",e));

// ─── math helpers ─────────────────────────────────────────────────────────────
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const r2=n=>{if(typeof n!=="number"||!Number.isFinite(n))return null;return Math.round(n*100)/100;};
const avg=vs=>{const ns=(vs||[]).filter(v=>typeof v==="number"&&Number.isFinite(v));return ns.length?ns.reduce((s,v)=>s+v,0)/ns.length:null;};
const wAvg=ps=>{if(!ps.length)return null;let n=0,d=0;for(const p of ps){n+=p.value*p.weight;d+=p.weight;}return d===0?null:n/d;};
const noVig=(a,b)=>{if(typeof a!=="number"||!Number.isFinite(a)||a<=1||typeof b!=="number"||!Number.isFinite(b)||b<=1)return{a:0.5,b:0.5};const ra=1/a,rb=1/b,t=ra+rb;return{a:ra/t,b:rb/t};};
const d2a=d=>{if(typeof d!=="number"||!Number.isFinite(d)||d<=1)return null;return d>=2?Math.round((d-1)*100):Math.round(-100/(d-1));};
const p2d=p=>{if(typeof p!=="number"||!Number.isFinite(p)||p<=0||p>=1)return null;return 1/p;};
const p2a=p=>d2a(p2d(p));
const oddsFormats=d=>{if(typeof d!=="number"||!Number.isFinite(d)||d<=1)return{decimal:null,american:null,impliedPercent:null};return{decimal:r2(d),american:d2a(d),impliedPercent:r2(1/d)};};
const probFormats=p=>({percent:r2(p),american:p2a(p)});
const bookWeight=k=>{if(["pinnacle","circasports","matchbook"].includes(k))return 1.4;if(["draftkings","fanduel","betmgm","betrivers"].includes(k))return 1.15;return 1.0;};
const vari=vs=>{const ns=(vs||[]).filter(v=>typeof v==="number"&&Number.isFinite(v));if(!ns.length)return 0;const a=avg(ns);return avg(ns.map(v=>(v-a)**2))||0;};
const normTeam=s=>String(s||"").toLowerCase().replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ").trim();
const teamsMatch=(e,h,a)=>normTeam(e?.home_team)===normTeam(h)&&normTeam(e?.away_team)===normTeam(a);
const buildMode=t=>Date.now()>=new Date(t).getTime()?"live":"pregame";
const fmtClock=s=>{if(typeof s!=="number"||!Number.isFinite(s))return"-";return`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,"0")}`;};
const toIso=ms=>new Date(ms).toISOString();
const todayYmd=()=>new Date().toISOString().slice(0,10);

// ─── cache ────────────────────────────────────────────────────────────────────
const cg=(m,k)=>{const h=m.get(k);if(!h)return null;if(Date.now()>h.e){m.delete(k);return null;}return h.v;};
const cs=(m,k,v,t)=>m.set(k,{v,e:Date.now()+t});

// ─── fetch ────────────────────────────────────────────────────────────────────
async function fetchJson(url,opts={}) {
  const ctrl=new AbortController(),t=setTimeout(()=>ctrl.abort(),12000);
  try {
    const res=await fetch(url,{...opts,signal:ctrl.signal}),txt=await res.text();
    if(!res.ok)throw new Error(`${res.status}: ${txt}`);
    try{return JSON.parse(txt);}catch{throw new Error(`Bad JSON: ${txt.slice(0,200)}`);}
  }catch(e){throw new Error(`fetchJson ${url}: ${e.message}`);}
  finally{clearTimeout(t);}
}
const oddsUrl=(p,q)=>`https://api.the-odds-api.com${p}?${new URLSearchParams(q)}`;
const reqOdds=()=>!!ODDS_API_KEY, reqBdl=()=>!!BALLDONTLIE_API_KEY, reqFn=()=>!!FANTASYNERDS_API_KEY;

// ─── Odds API ─────────────────────────────────────────────────────────────────
async function getEvents(){
  const k="events",h=cg(currentCache,k);if(h)return h;
  const d=await fetchJson(oddsUrl(`/v4/sports/${SPORT_KEY}/events`,{apiKey:ODDS_API_KEY}));
  cs(currentCache,k,d,CURRENT_TTL);return d;
}
async function getBoard(){
  const k="board",h=cg(currentCache,k);if(h)return h;
  const d=await fetchJson(oddsUrl(`/v4/sports/${SPORT_KEY}/odds`,{apiKey:ODDS_API_KEY,regions:REGIONS,markets:FEATURED_MARKETS,oddsFormat:ODDS_FORMAT}));
  cs(currentCache,k,d,CURRENT_TTL);return d;
}
async function resolveFeatured({gameId,homeTeam,awayTeam}){
  if(gameId){
    try{
      const k=`f:${gameId}`,h=cg(currentCache,k);
      if(h&&h.home_team)return h;
      const d=await fetchJson(oddsUrl(`/v4/sports/${SPORT_KEY}/events/${gameId}/odds`,{apiKey:ODDS_API_KEY,regions:REGIONS,markets:FEATURED_MARKETS,oddsFormat:ODDS_FORMAT}));
      cs(currentCache,k,d,CURRENT_TTL);if(d?.home_team)return d;
    }catch(e){if(!String(e.message||"").match(/422|INVALID/))throw e;}
  }
  if(!homeTeam||!awayTeam)throw new Error("Missing team fallback");
  const board=await getBoard();
  const m=(board||[]).find(e=>teamsMatch(e,homeTeam,awayTeam));
  if(!m)throw new Error(`No event for ${awayTeam} @ ${homeTeam}`);
  return m;
}
async function getHistSnap(dateIso){
  const k=`hist:${dateIso}`,h=cg(historicalCache,k);if(h)return h;
  const d=await fetchJson(oddsUrl(`/v4/historical/sports/${SPORT_KEY}/odds`,{apiKey:ODDS_API_KEY,regions:REGIONS,markets:FEATURED_MARKETS,oddsFormat:ODDS_FORMAT,date:dateIso}));
  cs(historicalCache,k,d,HISTORICAL_TTL);return d;
}
async function getProps(evtId){
  if(!evtId)return{bookmakers:[]};
  const k=`props:${evtId}`,h=cg(currentCache,k);if(h)return h;
  const url=oddsUrl(`/v4/sports/${SPORT_KEY}/events/${evtId}/odds`,{apiKey:ODDS_API_KEY,regions:REGIONS,markets:PLAYER_PROP_MARKETS,oddsFormat:ODDS_FORMAT});
  try{const d=await fetchJson(url);cs(currentCache,k,d,CURRENT_TTL);return d;}
  catch(e){console.error("props:",e.message);return{bookmakers:[]};}
}

// ─── consensus ───────────────────────────────────────────────────────────────
function findMkt(bm,key){return bm?.markets?.find(m=>m.key===key)||null;}
function extractConsensus(evt){
  const hPP=[],aPP=[],hPR=[],aPR=[],spS=[],totS=[],books=[];
  for(const bm of evt?.bookmakers||[]){
    const w=bookWeight(bm.key||""),h2h=findMkt(bm,"h2h"),sp=findMkt(bm,"spreads"),tot=findMkt(bm,"totals");
    let bHP=null,bAP=null,bHS=null,bAS=null,bT=null;
    if(h2h?.outcomes?.length>=2){
      const ho=h2h.outcomes.find(o=>o.name===evt.home_team),ao=h2h.outcomes.find(o=>o.name===evt.away_team);
      if(ho&&ao){bHP=ho.price;bAP=ao.price;const nv=noVig(ho.price,ao.price);hPP.push({value:nv.a,weight:w});aPP.push({value:nv.b,weight:w});hPR.push(nv.a);aPR.push(nv.b);}
    }
    if(sp?.outcomes?.length>=2){
      const hs=sp.outcomes.find(o=>o.name===evt.home_team),as_=sp.outcomes.find(o=>o.name===evt.away_team);
      if(hs&&typeof hs.point==="number"){bHS=hs.point;spS.push({value:clamp((-hs.point)*0.0105,-0.10,0.10),weight:w});}
      if(as_&&typeof as_.point==="number")bAS=as_.point;
    }
    if(tot?.outcomes?.length>=2){const ov=tot.outcomes.find(o=>o.name==="Over");if(ov&&typeof ov.point==="number"){bT=ov.point;totS.push({value:ov.point,weight:w});}}
    books.push({book:bm.title||bm.key||"book",homePrice:r2(bHP),awayPrice:r2(bAP),homeSpread:r2(bHS),awaySpread:r2(bAS),total:r2(bT),homeAmerican:d2a(bHP),awayAmerican:d2a(bAP)});
  }
  if(!hPP.length)return null;
  const hMP=wAvg(hPP),aMP=wAvg(aPP),spA=wAvg(spS)||0,totC=wAvg(totS)||0;
  let tAdj=0;if(totC<220)tAdj=0.005;else if(totC>236)tAdj=-0.005;
  const dp=clamp((vari(hPR)+vari(aPR))*10,0,0.035);
  const hPs=books.map(b=>b.homePrice).filter(v=>typeof v==="number");
  const aPs=books.map(b=>b.awayPrice).filter(v=>typeof v==="number");
  return{homeMarketProb:hMP,awayMarketProb:aMP,spreadAdj:spA,totalConsensus:totC,totalAdj:tAdj,disagreementPenalty:dp,
    bestHomePrice:hPs.length?Math.max(...hPs):null,bestAwayPrice:aPs.length?Math.max(...aPs):null,
    avgHomePrice:avg(hPs),avgAwayPrice:avg(aPs),avgHomeSpread:avg(books.map(b=>b.homeSpread).filter(v=>typeof v==="number")),
    avgTotal:avg(books.map(b=>b.total).filter(v=>typeof v==="number")),
    bookCount:books.filter(b=>typeof b.homePrice==="number"&&typeof b.awayPrice==="number").length,books};
}
async function buildHistComps(homeTeam,awayTeam){
  const out={};
  for(const lb of HISTORICAL_LOOKBACKS){
    try{
      const snap=await getHistSnap(toIso(Date.now()-lb.ms));
      const found=(snap?.data||snap||[]).find(e=>teamsMatch(e,homeTeam,awayTeam));
      if(!found){out[lb.label]=null;continue;}
      const c=extractConsensus(found);
      out[lb.label]=c?{homeMarketProb:r2(c.homeMarketProb),awayMarketProb:r2(c.awayMarketProb),spreadAdj:r2(c.spreadAdj),totalAdj:r2(c.totalAdj),totalConsensus:r2(c.totalConsensus),disagreementPenalty:r2(c.disagreementPenalty)}:null;
    }catch{out[lb.label]=null;}
  }
  return out;
}

// ─── props ────────────────────────────────────────────────────────────────────
function buildProps(propsEvt){
  const gm={};
  for(const bm of propsEvt?.bookmakers||[])for(const mkt of bm.markets||[]){if(!gm[mkt.key])gm[mkt.key]=[];for(const o of mkt.outcomes||[])gm[mkt.key].push({book:bm.key,player:o.description||"",side:o.name||"",point:o.point??null,price:o.price??null});}
  const mm={"player_points":"points","player_assists":"assists","player_rebounds":"rebounds","player_points_rebounds_assists":"pra"};
  const sec={points:[],assists:[],rebounds:[],pra:[]};
  for(const[mk,dk]of Object.entries(mm)){
    const grouped={};
    for(const o of gm[mk]||[]){const key=`${o.player}__${o.point}`;if(!grouped[key])grouped[key]={player:o.player,point:o.point,overPrices:[],underPrices:[]};if((o.side||"").toLowerCase()==="over"&&typeof o.price==="number")grouped[key].overPrices.push(o.price);if((o.side||"").toLowerCase()==="under"&&typeof o.price==="number")grouped[key].underPrices.push(o.price);}
    sec[dk]=Object.values(grouped).map(item=>{
      const ao=avg(item.overPrices),au=avg(item.underPrices);
      let hp=null;if(typeof ao==="number"&&typeof au==="number")hp=noVig(ao,au).a;else if(typeof ao==="number")hp=1/ao;
      const dec=hp!=null?(hp>0.5?{pick:"over",probability:hp}:{pick:"under",probability:1-hp}):null;
      return{player:item.player,line:r2(item.point),overDecimal:r2(ao),overAmerican:d2a(ao),hitProbability:r2(hp),coverage:item.overPrices.length+item.underPrices.length,pick:dec?.pick||null,pickProbability:r2(dec?.probability)};
    }).filter(r=>r.player&&typeof r.line==="number").sort((a,b)=>(b.coverage-a.coverage)||((b.pickProbability||0)-(a.pickProbability||0))).slice(0,12);
  }
  const all=[...sec.points,...sec.assists,...sec.rebounds,...sec.pra];
  if(!all.length)return{sections:sec,signal:{adj:0,depth:0}};
  let str=0,obs=0;
  for(const r of all){str+=clamp((r.coverage-1)*0.0015,0,0.01)+clamp((r.line||0)*0.0005,0,0.02)+clamp(((r.hitProbability||0.5)-0.5)*0.05,-0.015,0.015);obs++;}
  return{sections:sec,signal:{adj:clamp((str/Math.max(obs,1))*0.4,0,0.01),depth:obs}};
}

// ─── injury / lineup helpers ──────────────────────────────────────────────────
function normRows(p){if(Array.isArray(p))return p;if(Array.isArray(p?.Data))return p.Data;if(Array.isArray(p?.data))return p.data;if(Array.isArray(p?.players))return p.players;if(Array.isArray(p?.lineups))return p.lineups;if(Array.isArray(p?.depthcharts))return p.depthcharts;return[];}
const bdlHdr=()=>({Authorization:BALLDONTLIE_API_KEY});
const nbdl=p=>Array.isArray(p)?p:Array.isArray(p?.data)?p.data:[];
const mkTeamTokens=n=>{const a={"Atlanta Hawks":["hawks","atl"],"Boston Celtics":["celtics","bos"],"Brooklyn Nets":["nets","bkn"],"Charlotte Hornets":["hornets","cha"],"Chicago Bulls":["bulls","chi"],"Cleveland Cavaliers":["cavs","cle"],"Dallas Mavericks":["mavs","dal"],"Denver Nuggets":["nuggets","den"],"Detroit Pistons":["pistons","det"],"Golden State Warriors":["warriors","gsw"],"Houston Rockets":["rockets","hou"],"Indiana Pacers":["pacers","ind"],"Los Angeles Clippers":["clippers","lac"],"Los Angeles Lakers":["lakers","lal"],"Memphis Grizzlies":["grizzlies","mem"],"Miami Heat":["heat","mia"],"Milwaukee Bucks":["bucks","mil"],"Minnesota Timberwolves":["wolves","min"],"New Orleans Pelicans":["pelicans","nop"],"New York Knicks":["knicks","nyk"],"Oklahoma City Thunder":["thunder","okc"],"Orlando Magic":["magic","orl"],"Philadelphia 76ers":["sixers","phi"],"Phoenix Suns":["suns","phx"],"Portland Trail Blazers":["blazers","por"],"Sacramento Kings":["kings","sac"],"San Antonio Spurs":["spurs","sas"],"Toronto Raptors":["raptors","tor"],"Utah Jazz":["jazz","uta"],"Washington Wizards":["wizards","was"]};const tokens=new Set([n.toLowerCase(),...(a[n]||[])]);n.toLowerCase().split(" ").forEach(w=>tokens.add(w));return[...tokens].filter(Boolean);};
const rowHasTeam=(r,n)=>mkTeamTokens(n).some(t=>JSON.stringify(r).toLowerCase().includes(t));
async function getBdlInjuries(){if(!reqBdl())return{available:false,rows:[],source:"none"};const k="bdl:inj",h=cg(sideInfoCache,k);if(h)return h;try{const r=await fetchJson("https://api.balldontlie.io/v1/player_injuries?per_page=100",{headers:bdlHdr()});const v={available:true,rows:nbdl(r),source:"balldontlie"};cs(sideInfoCache,k,v,SIDEINFO_TTL);return v;}catch(e){console.error("bdl inj:",e.message);return{available:false,rows:[],source:"none"};}}
async function getBdlLineups(d=""){if(!reqBdl())return{available:false,rows:[],source:"none"};const date=d||todayYmd();const k=`bdl:lu:${date}`,h=cg(sideInfoCache,k);if(h)return h;try{const r=await fetchJson(`https://api.balldontlie.io/v1/lineups?dates[]=${encodeURIComponent(date)}&per_page=100`,{headers:bdlHdr()});const v={available:true,rows:nbdl(r),source:"balldontlie"};cs(sideInfoCache,k,v,SIDEINFO_TTL);return v;}catch(e){return{available:false,rows:[],source:"none"};}}
async function getFnInjuries(){if(!reqFn())return{available:false,rows:[],source:"none"};const k="fn:inj",h=cg(sideInfoCache,k);if(h)return h;try{const r=await fetchJson(`https://api.fantasynerds.com/v1/nba/injuries?apikey=${encodeURIComponent(FANTASYNERDS_API_KEY)}`);const v={available:true,rows:normRows(r),source:"fantasynerds"};cs(sideInfoCache,k,v,SIDEINFO_TTL);return v;}catch{return{available:false,rows:[],source:"none"};}}
async function getFnLineups(d=""){if(!reqFn())return{available:false,rows:[],source:"none"};const k=`fn:lu:${d||"today"}`,h=cg(sideInfoCache,k);if(h)return h;try{const r=await fetchJson(`https://api.fantasynerds.com/v1/nba/lineups?apikey=${encodeURIComponent(FANTASYNERDS_API_KEY)}&date=${encodeURIComponent(d)}`);const v={available:true,rows:normRows(r),source:"fantasynerds"};cs(sideInfoCache,k,v,SIDEINFO_TTL);return v;}catch{return{available:false,rows:[],source:"none"};}}
async function getFnDepth(){if(!reqFn())return{available:false,rows:[],source:"none"};const k="fn:dep",h=cg(sideInfoCache,k);if(h)return h;try{const r=await fetchJson(`https://api.fantasynerds.com/v1/nba/depth?apikey=${encodeURIComponent(FANTASYNERDS_API_KEY)}`);const v={available:true,rows:normRows(r),source:"fantasynerds"};cs(sideInfoCache,k,v,SIDEINFO_TTL);return v;}catch{return{available:false,rows:[],source:"none"};}}
async function bestInjuries(){const b=await getBdlInjuries().catch(()=>({available:false,rows:[]}));if(b.available&&b.rows.length)return b;return getFnInjuries().catch(()=>({available:false,rows:[],source:"none"}));}
async function bestLineups(d=""){const b=await getBdlLineups(d).catch(()=>({available:false,rows:[]}));if(b.available&&b.rows.length)return b;return getFnLineups(d).catch(()=>({available:false,rows:[],source:"none"}));}
async function bestDepth(){return getFnDepth().catch(()=>({available:false,rows:[],source:"none"}));}

function extractPName(obj){if(!obj)return"";for(const k of["PlayerName","playerName","name","Name","player","full_name"])if(typeof obj[k]==="string")return obj[k];if(obj.player&&typeof obj.player==="object")return`${obj.player.first_name||""} ${obj.player.last_name||""}`.trim();return"";}
function injSev(r){const t=JSON.stringify(r).toLowerCase();if(t.includes("out"))return 1.0;if(t.includes("doubtful"))return 0.8;if(t.includes("questionable"))return 0.5;if(t.includes("probable"))return 0.2;return 0.4;}
function depRole(r){const t=JSON.stringify(r).toLowerCase();if(t.includes("starter")||t.includes("1st"))return 1.0;if(t.includes("2nd"))return 0.55;if(t.includes("3rd"))return 0.25;return 0.45;}
function luCert(r){const t=JSON.stringify(r).toLowerCase();if(t.includes("confirmed"))return 1.0;if(t.includes("starting")||t.includes("starter"))return 0.85;if(t.includes("projected"))return 0.55;return 0.25;}

function summarizeInjury(homeTeam,awayTeam,injRows,linRows,depRows,propSecs){
  const hInj=injRows.filter(r=>rowHasTeam(r,homeTeam)),aInj=injRows.filter(r=>rowHasTeam(r,awayTeam));
  const hLin=linRows.filter(r=>rowHasTeam(r,homeTeam)),aLin=linRows.filter(r=>rowHasTeam(r,awayTeam));
  const hDep=depRows.filter(r=>rowHasTeam(r,homeTeam)),aDep=depRows.filter(r=>rowHasTeam(r,awayTeam));
  const pvMap={};
  for(const[sn,rows]of Object.entries(propSecs))for(const r of rows||[]){const p=(r.player||"").toLowerCase().trim();if(!p)continue;const s=clamp((r.line||0)*0.01,0,0.6)+clamp((r.pickProbability||r.hitProbability||0.5)-0.5,0,0.25)+clamp((r.coverage||0)*0.015,0,0.15);pvMap[p]=(pvMap[p]||0)+s;}
  function pvLookup(name){if(!name)return 0;const k=name.toLowerCase().trim();if(pvMap[k])return pvMap[k];const parts=k.split(" ").filter(Boolean);let best=0;for(const[c,v]of Object.entries(pvMap))if(parts.filter(p=>c.includes(p)).length>=Math.min(2,parts.length))best=Math.max(best,v);return best;}
  function calcPenalty(inj,lin,dep){let pen=0,sOut=0,pStarters=0;
    for(const i of inj){const pn=extractPName(i),sev=injSev(i);const lm=lin.find(r=>JSON.stringify(r).toLowerCase().includes(pn.toLowerCase()));const dm=dep.find(r=>JSON.stringify(r).toLowerCase().includes(pn.toLowerCase()));const lw=lm?luCert(lm):0;const rw=dm?depRole(dm):(lm?0.9:0.4);const pv=pvLookup(pn);pen+=0.006+sev*0.010+rw*0.010+lw*0.010+pv*0.008;if(rw>=0.8||lw>=0.8)sOut++;}
    for(const l of lin)if(luCert(l)>=0.8)pStarters++;
    return{penalty:clamp(pen,0,0.10),startersOut:sOut,starterCertainty:lin.length?clamp(pStarters/5,0,1):0};}
  const hc=calcPenalty(hInj,hLin,hDep),ac=calcPenalty(aInj,aLin,aDep);
  return{available:injRows.length>0||linRows.length>0||depRows.length>0,homeInjuriesCount:hInj.length,awayInjuriesCount:aInj.length,homePenalty:hc.penalty,awayPenalty:ac.penalty,homeStartersOut:hc.startersOut,awayStartersOut:ac.startersOut,homeStarterCertainty:hc.starterCertainty,awayStarterCertainty:ac.starterCertainty,homeLineupBoost:hc.starterCertainty*0.01,awayLineupBoost:ac.starterCertainty*0.01,lineupRowsCount:hLin.length+aLin.length,homeInjuries:hInj,awayInjuries:aInj,lineups:[...hLin,...aLin]};}

async function safeGetLive({gameId,homeTeam,awayTeam}){
  try{return await getLiveTrackerData({gameId,homeTeam,awayTeam})||{liveFound:false,homeScore:0,awayScore:0,period:1,clockSec:720,clock:"12:00"};}
  catch(e){console.error("liveTracker:",e.message);return{liveFound:false,homeScore:0,awayScore:0,period:1,clockSec:720,clock:"12:00"};}
}

// ─── edge / snapshot ──────────────────────────────────────────────────────────
function addEdgeHist(gid,edge,ts){if(!edgeHistoryStore[gid])edgeHistoryStore[gid]=[];let sm=edge;if(edgeHistoryStore[gid].length>0){const prev=edgeHistoryStore[gid].at(-1).edge;sm=prev*0.55+edge*0.45;}edgeHistoryStore[gid].push({timestamp:ts,edge:sm});const cut=Date.now()-15*60*1000;edgeHistoryStore[gid]=edgeHistoryStore[gid].filter(p=>new Date(p.timestamp).getTime()>=cut);return sm;}
function logSnap(gid,snap){if(!snapshotLogStore[gid])snapshotLogStore[gid]=[];snapshotLogStore[gid].push(snap);if(snapshotLogStore[gid].length>SNAP_RET)snapshotLogStore[gid]=snapshotLogStore[gid].slice(-SNAP_RET);}

// ─── learning wrappers ────────────────────────────────────────────────────────
const safeLS=()=>typeof learning.getLearningSummary==="function"?learning.getLearningSummary():{};
const safeCT=()=>typeof learning.getCalibrationTable==="function"?learning.getCalibrationTable():{};
const safeBCT=()=>typeof learning.buildCalibrationTable==="function"?learning.buildCalibrationTable():{};
const safeRS=s=>{if(typeof learning.recordSnapshot==="function")learning.recordSnapshot(s);};
const safeGS=()=>typeof learning.getSnapshots==="function"?learning.getSnapshots():[];
const safeUGR=p=>typeof learning.updateGameResult==="function"?learning.updateGameResult(p):0;
const safeAC=p=>typeof learning.applyCalibration==="function"?learning.applyCalibration(p):p;
const stakeLabel=raw=>{const text=String(raw||"No bet");const map={"No bet":0,"0.5u":0.5,"1u":1,"1.5u":1.5};return{tier:text,fraction:Object.prototype.hasOwnProperty.call(map,text)?map[text]:0};};

// ─── routes ───────────────────────────────────────────────────────────────────
app.get("/", (req,res)=>res.sendFile(path.join(__dirname,"index.html")));

app.get("/health",(req,res)=>{
  const s=safeLS();
  res.json({status:"ok",oddsKey:reqOdds(),bdlKey:reqBdl(),fnKey:reqFn(),
    learning:{total:s.totalSnapshots||0,graded:s.gradedSnapshots||0,winRate:s.overallWinRate!=null?(s.overallWinRate*100).toFixed(1)+"%":"n/a"},
    learnedWeightsActive:JSON.stringify(learnedWeights)!==JSON.stringify(DEFAULT_WEIGHTS),
    ts:new Date().toISOString()});
});

app.get("/games",async(req,res)=>{
  try{
    if(!reqOdds())return res.status(400).json({error:"Missing ODDS_API_KEY",games:[]});
    const evts=await getEvents(), now=Date.now(), nxt=now+24*60*60*1000;
    const games=(evts||[]).filter(e=>new Date(e.commence_time).getTime()<=nxt).map(e=>({id:e.id,label:`${e.away_team} @ ${e.home_team}`,homeTeam:e.home_team,awayTeam:e.away_team,commenceTime:e.commence_time,mode:buildMode(e.commence_time)}));
    res.json({games});
  }catch(e){res.status(500).json({error:e.message,games:[]});}
});

app.get("/odds",async(req,res)=>{
  try{
    if(!reqOdds())return res.status(400).json({error:"Missing ODDS_API_KEY"});
    const gameId=req.query.gameId||"",homeTeam=req.query.homeTeam||"",awayTeam=req.query.awayTeam||"";
    if(!gameId&&(!homeTeam||!awayTeam))return res.status(400).json({error:"Need gameId or homeTeam+awayTeam"});

    const featured=await resolveFeatured({gameId,homeTeam,awayTeam});
    const mode=buildMode(featured.commence_time);
    const lineupDate=(featured.commence_time||"").slice(0,10)||todayYmd();

    const [props,histComps,sideInfo,liveRaw]=await Promise.all([
      getProps(featured.id),
      buildHistComps(featured.home_team,featured.away_team),
      Promise.allSettled([bestInjuries(),bestLineups(lineupDate),bestDepth()]),
      mode==="live"?safeGetLive({gameId:featured.id,homeTeam:featured.home_team,awayTeam:featured.away_team}):Promise.resolve(null)
    ]);

    const injInfo = sideInfo[0].status==="fulfilled"?sideInfo[0].value:{available:false,rows:[],source:"none"};
    const linInfo = sideInfo[1].status==="fulfilled"?sideInfo[1].value:{available:false,rows:[],source:"none"};
    const depInfo = sideInfo[2].status==="fulfilled"?sideInfo[2].value:{available:false,rows:[],source:"none"};

    const {sections:propSections,signal:propSignal}=buildProps(props);
    const injSummary=summarizeInjury(featured.home_team,featured.away_team,injInfo.rows||[],linInfo.rows||[],depInfo.rows||[],propSections);

    // ── independent stats model (with injury context) ─────────────────────────
    let statsResult=null;
    try{
      statsResult=await computeIndependentWinProb(
        featured.home_team, featured.away_team, liveRaw,
        { homeInjuries:injSummary.homeInjuries, awayInjuries:injSummary.awayInjuries }
      );
    }catch(e){console.error("[stats_model]",e.message);}

    // ── market model ──────────────────────────────────────────────────────────
    let marketModel, liveState=null;
    if(mode==="live"){
      marketModel=buildEliteLiveModel({featuredOdds:featured,liveState:liveRaw,
        pregameBaseline:statsResult?{homeMarketProb:statsResult.homeWinProb}:null,calibrationFn:safeAC});
      liveState={...marketModel.scoreState,formattedClock:fmtClock(marketModel.scoreState?.clockSec)};
    }else{
      marketModel=buildElitePregameModel({featuredOdds:featured,historicalComparisons:histComps,
        propSignal,injurySummary:injSummary,calibrationFn:safeAC});
    }

    // ── apply learned weights (AI blend) ──────────────────────────────────────
    const pickSide=marketModel.pickSide;
    const pickTeam=marketModel.pickTeam;
    const marketImplied=marketModel.impliedProbability;

    const learnedTrue=applyLearnedWeights({
      marketProb:marketImplied, pickSide,
      modelDetails:marketModel.modelDetails,
      statsHomeProb:statsResult?statsResult.homeWinProb:null,
      weights:learnedWeights
    });
    const calibrated=safeAC(learnedTrue);
    const finalEdge=calibrated-marketImplied;

    // Stats model edge
    let statsEdge=null;
    if(statsResult){
      const spp=pickSide==="home"?statsResult.homeWinProb:1-statsResult.homeWinProb;
      statsEdge=computeEdge(spp,marketImplied);
    }

    // Verdict
    function verdict(edge,noBet,conf){
      if(noBet?.blocked)return"Avoid";
      if(edge>=0.045&&(conf?.percent||0)>=0.62)return"Bet now";
      if(edge>=0.02)return"Watch";
      return"Avoid";
    }
    const finalVerdict=verdict(finalEdge,marketModel.noBetFilter,marketModel.confidence);

    // ── snapshot ──────────────────────────────────────────────────────────────
    const ts=new Date().toISOString();
    const pick=`${pickTeam} to win`;
    const ek=featured.id||gameId||`${featured.home_team}_${featured.away_team}`;
    const smoothed=addEdgeHist(ek,finalEdge,ts);

    const snapshot={
      id:`${ek}_${ts}`, gameId:ek, timestamp:ts, commenceTime:featured.commence_time,
      homeTeam:featured.home_team, awayTeam:featured.away_team, mode, pickSide, pickTeam, pick,
      impliedProbability:r2(marketImplied),
      trueProbability:r2(learnedTrue), calibratedProbability:r2(calibrated), calibratedTrueProbability:r2(calibrated),
      rawEdge:r2(finalEdge), edge:r2(smoothed), calibratedEdge:r2(finalEdge),
      sportsbookDecimal:r2(marketModel.sportsbookDecimal),
      verdict:finalVerdict, confidenceLabel:marketModel.confidence?.label||"Low", confidencePercent:marketModel.confidence?.percent??null,
      statsModelHomeProb:statsResult?r2(statsResult.homeWinProb):null,
      // Store all stats model signals for signal weight learning
      statsSignals:statsResult?.signals||null,
      ...(marketModel.modelDetails||{}), ...(marketModel.featureSnapshot||{}),
      source:mode
    };

    logSnap(ek,snapshot);
    safeRS({...snapshot,result:null});

    // ── response ──────────────────────────────────────────────────────────────
    res.json({
      id:featured.id, homeTeam:featured.home_team, awayTeam:featured.away_team,
      commenceTime:featured.commence_time, gameMode:mode, pick, verdict:finalVerdict,
      confidence:{label:marketModel.confidence?.label||"Low",percent:r2(marketModel.confidence?.percent??null)},
      noBetFilter:marketModel.noBetFilter||{blocked:false,reasons:[]},

      impliedProbability:r2(marketImplied), trueProbability:r2(learnedTrue),
      calibratedTrueProbability:r2(calibrated),
      impliedProbabilityFormats:probFormats(marketImplied),
      trueProbabilityFormats:probFormats(calibrated),
      edge:r2(smoothed), rawEdge:r2(finalEdge), calibratedEdge:r2(finalEdge),

      aiModel:{
        activeWeights:learnedWeights,
        usingLearnedWeights:JSON.stringify(learnedWeights)!==JSON.stringify(DEFAULT_WEIGHTS),
        statsBlendWeight:r2(learnedWeights.statsBlend),
        statsEdge:statsEdge?r2(statsEdge.edge):null,
        statsVerdict:statsEdge?.verdict||null,
        statsHomeWinProb:statsResult?r2(statsResult.homeWinProb):null,
        signals:statsResult?.signals||null,
        injuryAdjustments:statsResult?.injuryAdjustments||null,
        matchupProfile:statsResult?.matchupProfile||null,
        meta:statsResult?.meta||null,
      },

      oddsFormats:oddsFormats(marketModel.sportsbookDecimal),
      stakeSuggestion:stakeLabel(marketModel.stakeSuggestion),
      learningSummary:safeLS(), calibrationTable:safeCT(),
      history:(edgeHistoryStore[ek]||[]).map(p=>({timestamp:p.timestamp,edge:r2(p.edge)})),
      modelDetails:{...(marketModel.modelDetails||{}),historicalComparisons:histComps,propSignal},
      bookmakerTable:marketModel.bookmakerTable||[],
      propSections,
      injuryStatus:{
        available:injSummary.available,
        homeInjuriesCount:injSummary.homeInjuriesCount, awayInjuriesCount:injSummary.awayInjuriesCount,
        lineupRowsCount:injSummary.lineupRowsCount,
        homePenalty:r2(injSummary.homePenalty), awayPenalty:r2(injSummary.awayPenalty),
        homeStartersOut:injSummary.homeStartersOut, awayStartersOut:injSummary.awayStartersOut,
        homeStarterCertainty:r2(injSummary.homeStarterCertainty), awayStarterCertainty:r2(injSummary.awayStarterCertainty),
        sourceSelection:{injuries:injInfo.source||"none",lineups:linInfo.source||"none",depth:depInfo.source||"none"},
        homeInjuries:injSummary.homeInjuries, awayInjuries:injSummary.awayInjuries, lineups:injSummary.lineups
      },
      scoreState:liveState, updatedAt:ts
    });
  }catch(e){console.error("/odds",e);res.status(500).json({error:e.message});}
});

app.get("/snapshots",(req,res)=>{
  const gid=req.query.gameId;
  if(!gid)return res.status(400).json({error:"Missing gameId"});
  res.json({gameId:gid,snapshots:(snapshotLogStore[gid]||[]).map(s=>({...s,impliedProbability:r2(s.impliedProbability),trueProbability:r2(s.trueProbability),edge:r2(s.edge),calibratedEdge:r2(s.calibratedEdge)}))});
});

app.get("/learning/summary",  (req,res)=>{try{res.json(safeLS());}catch(e){res.status(500).json({error:e.message});}});
app.get("/learning/calibration",(req,res)=>{try{res.json({calibration:safeCT()});}catch(e){res.status(500).json({error:e.message});}});
app.get("/learning/weights",  (req,res)=>{
  try{
    const sw=require("./data/signal_weights.json");
    res.json({marketWeights:learnedWeights,signalWeights:sw?.weights||null,marketDefaults:DEFAULT_WEIGHTS,
      usingLearned:JSON.stringify(learnedWeights)!==JSON.stringify(DEFAULT_WEIGHTS),ts:sw?.meta?.savedAt});
  }catch{res.json({marketWeights:learnedWeights,signalWeights:null,marketDefaults:DEFAULT_WEIGHTS,usingLearned:false});}
});
app.post("/learning/run",async(req,res)=>{
  try{const{gradeAllUngraded}=require("./auto_grader");const r=await gradeAllUngraded();learnedWeights=loadLearnedWeights();res.json({...r,weightsReloaded:true});}
  catch(e){res.status(500).json({error:e.message});}
});
app.get("/model/review",(req,res)=>{try{res.json(buildModelReview(safeGS()));}catch(e){res.status(500).json({error:e.message});}});
app.post("/learning/grade",(req,res)=>{
  try{
    const{gameId,finalWinner,finalHomeScore,finalAwayScore}=req.body||{};
    if(!gameId||!finalWinner)return res.status(400).json({error:"Missing gameId or finalWinner"});
    if(!["home","away"].includes(finalWinner))return res.status(400).json({error:'finalWinner must be "home" or "away"'});
    const updated=safeUGR({gameId,finalWinner,finalHomeScore,finalAwayScore});
    const cal=safeBCT();learnedWeights=loadLearnedWeights();
    res.json({updatedSnapshots:updated,calibrationBuckets:Object.keys(cal).length,learningSummary:safeLS()});
  }catch(e){res.status(500).json({error:e.message});}
});

app.listen(PORT,()=>{
  console.log(`Server on port ${PORT}`);
  console.log(`Learned weights active: ${JSON.stringify(learnedWeights)!==JSON.stringify(DEFAULT_WEIGHTS)}`);
  if(reqBdl())startAutoGradeScheduler(60*60*1000);
  else console.warn("[server] No BALLDONTLIE_API_KEY — auto-grader disabled");
});
