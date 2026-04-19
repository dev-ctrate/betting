"use strict";

/**
 * auto_grader.js  v2
 * Full automated learning loop:
 *   1. Grade ungraded snapshots from BDL
 *   2. Rebuild calibration
 *   3. Run market weight learner
 *   4. Run signal optimizer (targets 70-90% accuracy)
 */

const learning = require("./learning");
const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY || "";
const MIN_FOR_LEARNING    = 50;
const MIN_FOR_SIGNAL_OPT  = 50;
const GAME_BUFFER_HOURS   = 5;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

async function bdlFetch(path) {
  if (!BALLDONTLIE_API_KEY) throw new Error("Missing BALLDONTLIE_API_KEY");
  const res = await fetch(`https://api.balldontlie.io/v1${path}`, {
    headers: { Authorization: BALLDONTLIE_API_KEY },
    signal: AbortSignal.timeout(15000)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`BDL ${res.status}: ${txt.slice(0, 200)}`);
  return JSON.parse(txt);
}
const bdlRows = p => Array.isArray(p) ? p : Array.isArray(p?.data) ? p.data : [];

function normName(s) { return String(s||"").toLowerCase().replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ").trim(); }
function ymdFromIso(iso) { return String(iso||"").slice(0,10); }
function getSeasonFromDate(ymd) { const d=new Date(`${ymd}T00:00:00Z`); const m=d.getUTCMonth()+1; return m>=10?d.getUTCFullYear():d.getUTCFullYear()-1; }

function bdlGameMatches(g, homeTeam, awayTeam) {
  const bh=normName(g.home_team?.full_name||""), ba=normName(g.visitor_team?.full_name||"");
  if (bh===normName(homeTeam)&&ba===normName(awayTeam)) return true;
  const last=s=>normName(s).split(" ").pop()||"";
  return last(bh)===last(normName(homeTeam))&&last(ba)===last(normName(awayTeam));
}

async function getFinishedGamesForDate(ymd) {
  try {
    const season=getSeasonFromDate(ymd);
    const raw=await bdlFetch(`/games?dates[]=${encodeURIComponent(ymd)}&seasons[]=${season}&per_page=100`);
    return bdlRows(raw).filter(g=>String(g.status||"").toLowerCase().includes("final"));
  } catch(e) { console.error(`[grader] ${ymd}:`,e.message); return []; }
}

async function gradeAllUngraded() {
  const allSnaps=learning.getSnapshots();
  const ungraded=allSnaps.filter(s=>!s.result||typeof s.result.modelWon!=="boolean");
  if (!ungraded.length) { console.log("[grader] Nothing to grade."); return{graded:0,checked:0}; }
  console.log(`[grader] ${ungraded.length} ungraded snapshots.`);

  const gameMap=new Map();
  for (const s of ungraded) {
    const date=ymdFromIso(s.commenceTime||s.timestamp);
    if (!date) continue;
    const startMs=new Date(s.commenceTime||`${date}T00:00:00Z`).getTime();
    if (Date.now()<startMs+GAME_BUFFER_HOURS*3600000) continue;
    const key=`${date}__${normName(s.homeTeam)}__${normName(s.awayTeam)}`;
    if (!gameMap.has(key)) gameMap.set(key,{date,homeTeam:s.homeTeam,awayTeam:s.awayTeam,gameId:s.gameId});
  }

  if (!gameMap.size) { console.log("[grader] All games too recent."); return{graded:0,checked:ungraded.length}; }

  const uniqueDates=[...new Set([...gameMap.values()].map(g=>g.date))];
  const bdlByDate=new Map();
  for (const date of uniqueDates) bdlByDate.set(date,await getFinishedGamesForDate(date));

  let totalGraded=0;
  for (const [,game] of gameMap) {
    const bdlGames=bdlByDate.get(game.date)||[];
    const bdlGame=bdlGames.find(g=>bdlGameMatches(g,game.homeTeam,game.awayTeam));
    if (!bdlGame) continue;
    const homeScore=bdlGame.home_team_score, awayScore=bdlGame.visitor_team_score;
    if (typeof homeScore!=="number"||typeof awayScore!=="number"||homeScore===awayScore) continue;
    const finalWinner=homeScore>awayScore?"home":"away";
    const updated=learning.updateGameResult({gameId:game.gameId,finalWinner,finalHomeScore:homeScore,finalAwayScore:awayScore});
    if (updated>0) {
      console.log(`[grader] ✓ ${game.awayTeam} @ ${game.homeTeam} → ${finalWinner} won ${awayScore}-${homeScore} [${updated} snaps]`);
      totalGraded+=updated;
    }
  }

  if (totalGraded>0) {
    learning.buildCalibrationTable();
    const summary=learning.getLearningSummary();
    const wr=summary.overallWinRate!=null?(summary.overallWinRate*100).toFixed(1)+"%":"n/a";
    console.log(`[grader] graded=${summary.gradedSnapshots} win_rate=${wr}`);

    if (summary.gradedSnapshots>=MIN_FOR_LEARNING) {
      try {
        const{runWeightLearning}=require("./weight_learner");
        const r=await runWeightLearning(learning.getSnapshots());
        if (r.improved) console.log(`[grader] Market weights improved`);
      } catch(e) { console.error("[grader] weight_learner:",e.message); }
    }

    if (summary.gradedSnapshots>=MIN_FOR_SIGNAL_OPT) {
      try {
        const{runSignalOptimizer}=require("./signal_optimizer");
        console.log("[grader] Running signal optimizer...");
        const r=await runSignalOptimizer(learning.getSnapshots());
        if (r.saved) console.log(`[grader] Signal weights updated → ${r.optimized?.overall!=null?(r.optimized.overall*100).toFixed(1)+"%":"n/a"} accuracy`);
      } catch(e) { console.error("[grader] signal_optimizer:",e.message); }
    } else {
      console.log(`[grader] Need ${MIN_FOR_SIGNAL_OPT-summary.gradedSnapshots} more for signal optimization.`);
    }
  }

  return{graded:totalGraded,checked:ungraded.length};
}

function startAutoGradeScheduler(intervalMs=DEFAULT_INTERVAL_MS) {
  console.log(`[grader] Scheduler started (every ${Math.round(intervalMs/60000)} min)`);
  setTimeout(async()=>{try{await gradeAllUngraded();}catch(e){console.error("[grader]",e.message);}},45000);
  setInterval(async()=>{try{await gradeAllUngraded();}catch(e){console.error("[grader]",e.message);}},intervalMs);
}

if (require.main===module) {
  if (!BALLDONTLIE_API_KEY){console.error("Set BALLDONTLIE_API_KEY");process.exit(1);}
  gradeAllUngraded().then(r=>{console.log(`Done. Graded:${r.graded}`);process.exit(0);}).catch(e=>{console.error(e);process.exit(1);});
}

module.exports={gradeAllUngraded,startAutoGradeScheduler};
