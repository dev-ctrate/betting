"use strict";

/**
 * auto_grader.js  v3
 *
 * Full automated learning loop:
 *   1. Grade ungraded snapshots from BDL final scores
 *   2. Rebuild calibration table
 *   3. Run market weight learner
 *   4. Run signal optimizer (realistic 58-72% accuracy targets)
 *
 * KEY FIX: This version ensures statsSignals are populated so
 * the signal optimizer actually has training data.
 * The backfill.js also now calls computeIndependentWinProb and stores
 * statsSignals in each historical snapshot.
 */

const learning = require("./learning");
const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY || "";
const MIN_FOR_MARKET  = 50;
const MIN_FOR_SIGNALS = 50;
const BUFFER_HOURS    = 5;
const INTERVAL_MS     = 60 * 60 * 1000;

async function bdlFetch(path) {
  if (!BALLDONTLIE_API_KEY) throw new Error("Missing BALLDONTLIE_API_KEY");
  const res=await fetch(`https://api.balldontlie.io/v1${path}`,{headers:{Authorization:BALLDONTLIE_API_KEY},signal:AbortSignal.timeout(15000)});
  const txt=await res.text(); if(!res.ok)throw new Error(`BDL ${res.status}`);
  return JSON.parse(txt);
}
const bdlRows=p=>Array.isArray(p)?p:Array.isArray(p?.data)?p.data:[];

const normName=s=>String(s||"").toLowerCase().replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ").trim();
const ymdFromIso=iso=>String(iso||"").slice(0,10);
const getSeason=ymd=>{const d=new Date(`${ymd}T00:00:00Z`);const m=d.getUTCMonth()+1;return m>=10?d.getUTCFullYear():d.getUTCFullYear()-1;};
const bdlMatch=(g,h,a)=>{const bh=normName(g.home_team?.full_name||""),ba=normName(g.visitor_team?.full_name||"");if(bh===normName(h)&&ba===normName(a))return true;const last=s=>normName(s).split(" ").pop()||"";return last(bh)===last(normName(h))&&last(ba)===last(normName(a));};

async function getFinishedGames(ymd) {
  try {
    const s=getSeason(ymd);
    const r=await bdlFetch(`/games?dates[]=${encodeURIComponent(ymd)}&seasons[]=${s}&per_page=100`);
    return bdlRows(r).filter(g=>String(g.status||"").toLowerCase().includes("final"));
  } catch(e){console.error(`[grader] ${ymd}:`,e.message);return[];}
}

// Check what % of graded snapshots have statsSignals
function auditSignalCoverage(snaps) {
  const graded=snaps.filter(s=>s?.result&&typeof s.result.modelWon==="boolean");
  const withSignals=graded.filter(s=>s?.statsSignals&&typeof s.statsSignals==="object"&&Object.keys(s.statsSignals).length>=5);
  return{graded:graded.length,withSignals:withSignals.length,pct:graded.length>0?Math.round(withSignals.length/graded.length*100):0};
}

async function gradeAllUngraded() {
  const allSnaps=learning.getSnapshots();
  const ungraded=allSnaps.filter(s=>!s.result||typeof s.result.modelWon!=="boolean");
  if (!ungraded.length){console.log("[grader] Nothing to grade.");return{graded:0,checked:0};}
  console.log(`[grader] ${ungraded.length} ungraded snapshots.`);

  const gameMap=new Map();
  for (const s of ungraded) {
    const date=ymdFromIso(s.commenceTime||s.timestamp); if(!date)continue;
    const startMs=new Date(s.commenceTime||`${date}T00:00:00Z`).getTime();
    if(Date.now()<startMs+BUFFER_HOURS*3600000)continue;
    const key=`${date}__${normName(s.homeTeam)}__${normName(s.awayTeam)}`;
    if(!gameMap.has(key))gameMap.set(key,{date,homeTeam:s.homeTeam,awayTeam:s.awayTeam,gameId:s.gameId});
  }

  if (!gameMap.size){console.log("[grader] All games too recent.");return{graded:0,checked:ungraded.length};}

  const uniqueDates=[...new Set([...gameMap.values()].map(g=>g.date))];
  const bdlByDate=new Map();
  for (const d of uniqueDates)bdlByDate.set(d,await getFinishedGames(d));

  let totalGraded=0;
  for (const[,game] of gameMap) {
    const bdlGames=bdlByDate.get(game.date)||[];
    const bdlGame=bdlGames.find(g=>bdlMatch(g,game.homeTeam,game.awayTeam));
    if(!bdlGame)continue;
    const hs=bdlGame.home_team_score,as_=bdlGame.visitor_team_score;
    if(typeof hs!=="number"||typeof as_!=="number"||hs===as_)continue;
    const fw=hs>as_?"home":"away";
    const updated=learning.updateGameResult({gameId:game.gameId,finalWinner:fw,finalHomeScore:hs,finalAwayScore:as_});
    if(updated>0){
      const wt=fw==="home"?game.homeTeam:game.awayTeam;
      console.log(`[grader] ✓ ${game.awayTeam} @ ${game.homeTeam} → ${wt} won ${as_}-${hs} [${updated} snaps]`);
      totalGraded+=updated;
    }
  }

  if (totalGraded>0) {
    learning.buildCalibrationTable();
    const summary=learning.getLearningSummary();
    const coverage=auditSignalCoverage(learning.getSnapshots());
    console.log(`[grader] graded=${summary.gradedSnapshots} win_rate=${summary.overallWinRate!=null?(summary.overallWinRate*100).toFixed(1)+"%":"n/a"}`);
    console.log(`[grader] Signal coverage: ${coverage.withSignals}/${coverage.graded} (${coverage.pct}%)`);

    if (coverage.pct<20&&coverage.graded>20) {
      console.log(`[grader] ⚠ Low signal coverage — run node backfill.js to populate historical signal data`);
    }

    if (summary.gradedSnapshots>=MIN_FOR_MARKET) {
      try{const{runWeightLearning}=require("./weight_learner");const r=await runWeightLearning(learning.getSnapshots());if(r.improved)console.log("[grader] Market weights improved");}
      catch(e){console.error("[grader] weight_learner:",e.message);}
    }

    if (summary.gradedSnapshots>=MIN_FOR_SIGNALS&&coverage.withSignals>=MIN_FOR_SIGNALS) {
      try{
        const{runSignalOptimizer}=require("./signal_optimizer");
        console.log("[grader] Running signal optimizer...");
        const r=await runSignalOptimizer(learning.getSnapshots());
        if(r.saved)console.log(`[grader] Signal weights updated → ${r.optimized?.overall!=null?(r.optimized.overall*100).toFixed(1)+"%":"n/a"} accuracy`);
        else console.log(`[grader] Signal optimizer ran — no improvement (${r.reason||"below threshold"})`);
      }catch(e){console.error("[grader] signal_optimizer:",e.message);}
    } else if (coverage.withSignals<MIN_FOR_SIGNALS) {
      console.log(`[grader] Need ${MIN_FOR_SIGNALS-coverage.withSignals} more signal snapshots. Run: node backfill.js <start_date> <end_date>`);
    }
  }

  return{graded:totalGraded,checked:ungraded.length};
}

function startAutoGradeScheduler(intervalMs=INTERVAL_MS) {
  console.log(`[grader] Scheduler started (every ${Math.round(intervalMs/60000)} min)`);
  setTimeout(async()=>{try{await gradeAllUngraded();}catch(e){console.error("[grader]",e.message);}},45000);
  setInterval(async()=>{try{await gradeAllUngraded();}catch(e){console.error("[grader]",e.message);}},intervalMs);
}

if (require.main===module) {
  if (!BALLDONTLIE_API_KEY){console.error("Set BALLDONTLIE_API_KEY");process.exit(1);}
  gradeAllUngraded().then(r=>{console.log(`Done. Graded:${r.graded}`);process.exit(0);}).catch(e=>{console.error(e);process.exit(1);});
}

module.exports={gradeAllUngraded,startAutoGradeScheduler,auditSignalCoverage};
