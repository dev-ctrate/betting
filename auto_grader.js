"use strict";

/**
 * auto_grader.js
 *
 * Closes the learning feedback loop:
 *   1. Finds all snapshots in learning store that have no result yet
 *   2. Queries BallDontLie for final scores on those dates
 *   3. Matches games by home/away team name + date (Odds API IDs ≠ BDL IDs)
 *   4. Grades each unique game via learning.updateGameResult
 *   5. Rebuilds calibration table
 *   6. Triggers weight_learner when enough graded samples exist
 *
 * Usage (standalone):  node auto_grader.js
 * Usage (in server):   const { startAutoGradeScheduler } = require("./auto_grader");
 *                      startAutoGradeScheduler();
 */

const learning = require("./learning");

const BALLDONTLIE_API_KEY      = process.env.BALLDONTLIE_API_KEY || "";
const MIN_SAMPLES_FOR_LEARNING = 50;   // need this many graded snapshots before weight learning kicks in
const GAME_BUFFER_HOURS        = 5;    // wait N hours after commence time before trying to grade
const DEFAULT_INTERVAL_MS      = 60 * 60 * 1000;  // check every hour

// ─── BallDontLie fetch ────────────────────────────────────────────────────────
async function bdlFetch(urlPath) {
  if (!BALLDONTLIE_API_KEY) throw new Error("Missing BALLDONTLIE_API_KEY");
  const res = await fetch(`https://api.balldontlie.io/v1${urlPath}`, {
    headers: { Authorization: BALLDONTLIE_API_KEY },
    signal: AbortSignal.timeout(15000)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`BDL ${res.status}: ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); }
  catch { throw new Error(`BDL invalid JSON: ${txt.slice(0, 100)}`); }
}

function normalizeRows(payload) {
  if (Array.isArray(payload))       return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function getSeasonFromDate(ymd) {
  const d     = new Date(`${ymd}T00:00:00Z`);
  const year  = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  return month >= 10 ? year : year - 1;
}

function ymdFromIso(iso) {
  return String(iso || "").slice(0, 10);
}

function bdlGameMatchesSnapshot(bdlGame, homeTeam, awayTeam) {
  const bdlHome = normName(bdlGame.home_team?.full_name || "");
  const bdlAway = normName(bdlGame.visitor_team?.full_name || "");
  // Try exact normalized match first
  if (bdlHome === normName(homeTeam) && bdlAway === normName(awayTeam)) return true;
  // Fallback: last-word (nickname) match — handles e.g. "LA Lakers" vs "Los Angeles Lakers"
  const lastWord = s => normName(s).split(" ").pop() || "";
  return lastWord(bdlHome) === lastWord(normName(homeTeam)) &&
         lastWord(bdlAway) === lastWord(normName(awayTeam));
}

// ─── fetch finished games for one calendar date ───────────────────────────────
async function getFinishedGamesForDate(ymd) {
  try {
    const season = getSeasonFromDate(ymd);
    const raw    = await bdlFetch(
      `/games?dates[]=${encodeURIComponent(ymd)}&seasons[]=${season}&per_page=100`
    );
    return normalizeRows(raw).filter(g =>
      String(g.status || "").toLowerCase().includes("final")
    );
  } catch (err) {
    console.error(`[grader] Could not fetch games for ${ymd}:`, err.message);
    return [];
  }
}

// ─── core grading pass ────────────────────────────────────────────────────────
async function gradeAllUngraded() {
  const allSnapshots = learning.getSnapshots();
  const ungraded     = allSnapshots.filter(
    s => !s.result || typeof s.result.modelWon !== "boolean"
  );

  if (!ungraded.length) {
    console.log("[grader] Nothing to grade.");
    return { graded: 0, checked: 0 };
  }

  console.log(`[grader] Found ${ungraded.length} ungraded snapshot(s).`);

  // ── Deduplicate into unique games ──────────────────────────────────────────
  // Key: "date__homeTeam__awayTeam"  (multiple time-offset snapshots per game)
  const gameMap = new Map();  // key → { date, homeTeam, awayTeam, gameId }

  for (const s of ungraded) {
    const date = ymdFromIso(s.commenceTime || s.timestamp);
    if (!date) continue;

    // Don't try to grade games that might still be in progress
    const startMs = new Date(s.commenceTime || `${date}T00:00:00Z`).getTime();
    if (Date.now() < startMs + GAME_BUFFER_HOURS * 60 * 60 * 1000) continue;

    const key = `${date}__${normName(s.homeTeam)}__${normName(s.awayTeam)}`;
    if (!gameMap.has(key)) {
      gameMap.set(key, {
        date,
        homeTeam: s.homeTeam,
        awayTeam: s.awayTeam,
        gameId:   s.gameId   // Odds API event ID — used to update all snapshots for this game
      });
    }
  }

  if (!gameMap.size) {
    console.log("[grader] All ungraded games are too recent to grade yet.");
    return { graded: 0, checked: ungraded.length };
  }

  // ── Batch-fetch results by date ───────────────────────────────────────────
  const uniqueDates = [...new Set([...gameMap.values()].map(g => g.date))];
  const bdlByDate   = new Map();

  for (const date of uniqueDates) {
    bdlByDate.set(date, await getFinishedGamesForDate(date));
  }

  // ── Match & grade ──────────────────────────────────────────────────────────
  let totalGraded = 0;

  for (const [, game] of gameMap) {
    const bdlGames  = bdlByDate.get(game.date) || [];
    const bdlGame   = bdlGames.find(g => bdlGameMatchesSnapshot(g, game.homeTeam, game.awayTeam));

    if (!bdlGame) {
      // Could be a future game or one BDL doesn't have yet
      continue;
    }

    const homeScore = bdlGame.home_team_score;
    const awayScore = bdlGame.visitor_team_score;

    if (typeof homeScore !== "number" || typeof awayScore !== "number") continue;
    if (homeScore === awayScore) continue;  // NBA has no ties

    const finalWinner = homeScore > awayScore ? "home" : "away";

    const updated = learning.updateGameResult({
      gameId:         game.gameId,
      finalWinner,
      finalHomeScore: homeScore,
      finalAwayScore: awayScore
    });

    if (updated > 0) {
      const winnerTeam = finalWinner === "home" ? game.homeTeam : game.awayTeam;
      console.log(
        `[grader] ✓  ${game.awayTeam} @ ${game.homeTeam}  →  ` +
        `${winnerTeam} won  (${awayScore}-${homeScore})  ` +
        `[${updated} snapshot(s) graded]`
      );
      totalGraded += updated;
    }
  }

  // ── Post-grade: rebuild calibration + trigger weight learning ──────────────
  if (totalGraded > 0) {
    learning.buildCalibrationTable();
    console.log(`[grader] Calibration table rebuilt. Total newly graded: ${totalGraded}`);

    const summary = learning.getLearningSummary();
    console.log(
      `[grader] Learning summary — total: ${summary.totalSnapshots}, ` +
      `graded: ${summary.gradedSnapshots}, ` +
      `win rate: ${summary.overallWinRate != null ? (summary.overallWinRate * 100).toFixed(1) + "%" : "n/a"}`
    );

    if (summary.gradedSnapshots >= MIN_SAMPLES_FOR_LEARNING) {
      try {
        const { runWeightLearning } = require("./weight_learner");
        console.log("[grader] Triggering weight learning...");
        const wlResult = await runWeightLearning(learning.getSnapshots());
        if (wlResult.improved) {
          console.log(
            `[grader] Weight learning improved model.  ` +
            `Loss: ${wlResult.initialLoss?.toFixed(4)} → ${wlResult.finalLoss?.toFixed(4)}`
          );
        } else {
          console.log("[grader] Weight learning ran but no improvement over current weights.");
        }
      } catch (err) {
        console.error("[grader] Weight learning error:", err.message);
      }
    } else {
      const remaining = MIN_SAMPLES_FOR_LEARNING - summary.gradedSnapshots;
      console.log(`[grader] Need ${remaining} more graded samples before weight learning activates.`);
    }
  } else {
    console.log("[grader] No new grades this pass.");
  }

  return { graded: totalGraded, checked: ungraded.length };
}

// ─── scheduler ────────────────────────────────────────────────────────────────
function startAutoGradeScheduler(intervalMs = DEFAULT_INTERVAL_MS) {
  const intervalMin = Math.round(intervalMs / 60000);
  console.log(`[grader] Auto-grade scheduler started (every ${intervalMin} min).`);

  // First run: 45 seconds after startup (let server fully initialise)
  setTimeout(async () => {
    try   { await gradeAllUngraded(); }
    catch (e) { console.error("[grader] Startup run failed:", e.message); }
  }, 45 * 1000);

  // Recurring run
  setInterval(async () => {
    try   { await gradeAllUngraded(); }
    catch (e) { console.error("[grader] Scheduled run failed:", e.message); }
  }, intervalMs);
}

// ─── allow running standalone: node auto_grader.js ───────────────────────────
if (require.main === module) {
  if (!BALLDONTLIE_API_KEY) {
    console.error("Set BALLDONTLIE_API_KEY before running.");
    process.exit(1);
  }
  gradeAllUngraded()
    .then(r => {
      console.log(`\nDone. Graded: ${r.graded}, Checked: ${r.checked}`);
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { gradeAllUngraded, startAutoGradeScheduler };
