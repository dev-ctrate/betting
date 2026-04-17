const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const SNAPSHOT_FILE = path.join(DATA_DIR, "learning_snapshots.json");
const CALIBRATION_FILE = path.join(DATA_DIR, "learning_calibration.json");

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function roundToTwo(num) {
  if (typeof num !== "number" || !Number.isFinite(num)) return null;
  return Math.round(num * 100) / 100;
}

function readJson(filePath, fallback) {
  try {
    ensureDir();
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2), "utf8");
      return fallback;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(⁠ readJson failed for ${filePath}: ⁠, err.message);
    return fallback;
  }
}

function writeJson(filePath, value) {
  try {
    ensureDir();
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
    return true;
  } catch (err) {
    console.error(⁠ writeJson failed for ${filePath}: ⁠, err.message);
    return false;
  }
}

function probabilityBucket(probability) {
  if (typeof probability !== "number") return null;
  return (Math.floor(probability * 20) / 20).toFixed(2); // 5% buckets
}

function getSnapshots() {
  return readJson(SNAPSHOT_FILE, []);
}

function saveSnapshots(rows) {
  return writeJson(SNAPSHOT_FILE, rows);
}

function getCalibrationTable() {
  return readJson(CALIBRATION_FILE, {});
}

function saveCalibrationTable(table) {
  return writeJson(CALIBRATION_FILE, table);
}

function recordSnapshot(row) {
  const snapshots = getSnapshots();

  snapshots.push({
    id: row.id || ⁠ ${row.gameId}_${Date.now()} ⁠,
    gameId: row.gameId,
    timestamp: row.timestamp || new Date().toISOString(),
    commenceTime: row.commenceTime || null,
    homeTeam: row.homeTeam || "",
    awayTeam: row.awayTeam || "",
    pickSide: row.pickSide || "",
    pickTeam: row.pickTeam || "",
    impliedProbability: row.impliedProbability ?? null,
    trueProbability: row.trueProbability ?? null,
    calibratedProbability: row.calibratedProbability ?? null,
    rawEdge: row.rawEdge ?? null,
    calibratedEdge: row.calibratedEdge ?? null,
    sportsbookDecimal: row.sportsbookDecimal ?? null,
    verdict: row.verdict || "",
    confidenceLabel: row.confidenceLabel || "",
    confidencePercent: row.confidencePercent ?? null,
    source: row.source || "live",
    features: {
      spreadAdj: row.spreadAdj ?? null,
      totalAdj: row.totalAdj ?? null,
      lineMovementAdj: row.lineMovementAdj ?? null,
      propAdj: row.propAdj ?? null,
      injuryAdjHome: row.injuryAdjHome ?? null,
      disagreementPenalty: row.disagreementPenalty ?? null,
      avgHomeSpread: row.avgHomeSpread ?? null,
      avgTotal: row.avgTotal ?? null,
      bookCount: row.bookCount ?? null
    },
    result: {
      finalWinner: row.result?.finalWinner ?? null,
      modelWon: row.result?.modelWon ?? null,
      finalHomeScore: row.result?.finalHomeScore ?? null,
      finalAwayScore: row.result?.finalAwayScore ?? null,
      gradedAt: row.result?.gradedAt ?? null
    }
  });

  saveSnapshots(snapshots.slice(-50000));
}

function upsertBackfillRow(row) {
  const snapshots = getSnapshots();
  const idx = snapshots.findIndex(
    x => x.gameId === row.gameId && x.source === "backfill"
  );

  const finalRow = {
    id: row.id || ⁠ ${row.gameId}_backfill ⁠,
    gameId: row.gameId,
    timestamp: row.timestamp || new Date().toISOString(),
    commenceTime: row.commenceTime || null,
    homeTeam: row.homeTeam || "",
    awayTeam: row.awayTeam || "",
    pickSide: row.pickSide || "",
    pickTeam: row.pickTeam || "",
    impliedProbability: row.impliedProbability ?? null,
    trueProbability: row.trueProbability ?? null,
    calibratedProbability: row.calibratedProbability ?? null,
    rawEdge: row.rawEdge ?? null,
    calibratedEdge: row.calibratedEdge ?? null,
    sportsbookDecimal: row.sportsbookDecimal ?? null,
    verdict: row.verdict || "",
    confidenceLabel: row.confidenceLabel || "",
    confidencePercent: row.confidencePercent ?? null,
    source: "backfill",
    features: {
      spreadAdj: row.spreadAdj ?? null,
      totalAdj: row.totalAdj ?? null,
      lineMovementAdj: row.lineMovementAdj ?? null,
      propAdj: row.propAdj ?? null,
      injuryAdjHome: row.injuryAdjHome ?? null,
      disagreementPenalty: row.disagreementPenalty ?? null,
      avgHomeSpread: row.avgHomeSpread ?? null,
      avgTotal: row.avgTotal ?? null,
      bookCount: row.bookCount ?? null
    },
    result: {
      finalWinner: row.result?.finalWinner ?? null,
      modelWon: row.result?.modelWon ?? null,
      finalHomeScore: row.result?.finalHomeScore ?? null,
      finalAwayScore: row.result?.finalAwayScore ?? null,
      gradedAt: row.result?.gradedAt ?? null
    }
  };

  if (idx >= 0) snapshots[idx] = finalRow;
  else snapshots.push(finalRow);

  saveSnapshots(snapshots.slice(-50000));
}

function updateGameResult({ gameId, finalWinner, finalHomeScore = null, finalAwayScore = null }) {
  const snapshots = getSnapshots();
  let changed = 0;

  for (const row of snapshots) {
    if (row.gameId !== gameId) continue;
    row.result.finalWinner = finalWinner;
    row.result.modelWon = row.pickSide === finalWinner;
    row.result.finalHomeScore = finalHomeScore;
    row.result.finalAwayScore = finalAwayScore;
    row.result.gradedAt = new Date().toISOString();
    changed += 1;
  }

  saveSnapshots(snapshots);
  return changed;
}

function buildCalibrationTable() {
  const snapshots = getSnapshots();
  const grouped = {};

  for (const row of snapshots) {
    if (!row?.result || typeof row.result.modelWon !== "boolean") continue;
    if (typeof row.trueProbability !== "number") continue;

    const key = probabilityBucket(row.trueProbability);
    if (!key) continue;

    if (!grouped[key]) {
      grouped[key] = {
        games: 0,
        wins: 0,
        avgPredictedProbSum: 0
      };
    }

    grouped[key].games += 1;
    grouped[key].wins += row.result.modelWon ? 1 : 0;
    grouped[key].avgPredictedProbSum += row.trueProbability;
  }

  const table = {};

  for (const [key, stats] of Object.entries(grouped)) {
    const avgPredictedProb = stats.avgPredictedProbSum / stats.games;
    const actualWinRate = stats.wins / stats.games;

    table[key] = {
      games: stats.games,
      wins: stats.wins,
      avgPredictedProb: roundToTwo(avgPredictedProb),
      actualWinRate: roundToTwo(actualWinRate),
      correction: roundToTwo(actualWinRate - avgPredictedProb)
    };
  }

  saveCalibrationTable(table);
  return table;
}

function applyCalibration(probability, table = null) {
  if (typeof probability !== "number") return probability;

  const calibrationTable = table || getCalibrationTable();
  const bucket = probabilityBucket(probability);
  const stats = calibrationTable[bucket];

  if (!stats || typeof stats.games !== "number" || stats.games < 20) {
    return clamp(probability, 0.01, 0.99);
  }

  const correction = typeof stats.correction === "number" ? stats.correction : 0;
  return clamp(probability + correction * 0.6, 0.01, 0.99);
}

function getLearningSummary() {
  const snapshots = getSnapshots();
  const graded = snapshots.filter(x => typeof x?.result?.modelWon === "boolean");
  const wins = graded.filter(x => x.result.modelWon).length;

  return {
    totalSnapshots: snapshots.length,
    gradedGames: graded.length,
    wins,
    losses: graded.length - wins,
    hitRate: graded.length ? roundToTwo(wins / graded.length) : null,
    calibrationBuckets: Object.keys(getCalibrationTable()).length
  };
}

module.exports = {
  recordSnapshot,
  upsertBackfillRow,
  updateGameResult,
  buildCalibrationTable,
  applyCalibration,
  getSnapshots,
  getCalibrationTable,
  getLearningSummary
};
