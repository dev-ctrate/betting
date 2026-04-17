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
    console.error(`readJson failed for ${filePath}:`, err.message);
    return fallback;
  }
}

function writeJson(filePath, value) {
  try {
    ensureDir();
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
  } catch (err) {
    console.error(`writeJson failed for ${filePath}:`, err.message);
  }
}

let snapshots = readJson(SNAPSHOT_FILE, []);
let calibrationTable = readJson(CALIBRATION_FILE, {});

function persistSnapshots() {
  writeJson(SNAPSHOT_FILE, snapshots);
}

function persistCalibration() {
  writeJson(CALIBRATION_FILE, calibrationTable);
}

function probabilityBucket(prob) {
  const p = Number(prob);
  if (!Number.isFinite(p)) return "unknown";

  const lower = Math.floor(p * 20) / 20;
  const upper = lower + 0.05;

  const loPct = Math.round(lower * 100);
  const hiPct = Math.round(upper * 100);

  return `${loPct}-${hiPct}`;
}

function cloneSnapshotRow(row) {
  return JSON.parse(JSON.stringify(row));
}

function normalizeSnapshot(row) {
  return {
    ...row,
    impliedProbability: roundToTwo(row.impliedProbability),
    trueProbability: roundToTwo(row.trueProbability),
    calibratedProbability: roundToTwo(row.calibratedProbability),
    rawEdge: roundToTwo(row.rawEdge),
    calibratedEdge: roundToTwo(row.calibratedEdge),
    sportsbookDecimal: roundToTwo(row.sportsbookDecimal),
    confidencePercent: roundToTwo(row.confidencePercent),
    spreadAdj: roundToTwo(row.spreadAdj),
    totalAdj: roundToTwo(row.totalAdj),
    lineMovementAdj: roundToTwo(row.lineMovementAdj),
    propAdj: roundToTwo(row.propAdj),
    injuryAdjHome: roundToTwo(row.injuryAdjHome),
    disagreementPenalty: roundToTwo(row.disagreementPenalty),
    avgHomeSpread: roundToTwo(row.avgHomeSpread),
    avgTotal: roundToTwo(row.avgTotal),
    totalConsensus: roundToTwo(row.totalConsensus),
    scoreAdj: roundToTwo(row.scoreAdj),
    comebackAdj: roundToTwo(row.comebackAdj),
    momentumAdj: roundToTwo(row.momentumAdj),
    pacePressureAdj: roundToTwo(row.pacePressureAdj),
    garbageTimePenalty: roundToTwo(row.garbageTimePenalty),
    timeLeverage: roundToTwo(row.timeLeverage)
  };
}

function recordSnapshot(row) {
  const normalized = normalizeSnapshot(row);
  snapshots.push(cloneSnapshotRow(normalized));

  if (snapshots.length > 100000) {
    snapshots = snapshots.slice(-100000);
  }

  persistSnapshots();
  return normalized;
}

function getSnapshots() {
  return snapshots;
}

function getLearningSummary() {
  const graded = snapshots.filter(s => s?.result && typeof s.result.modelWon === "boolean");
  const wins = graded.filter(s => s.result.modelWon).length;

  const byMode = {};
  const byVerdict = {};

  for (const row of graded) {
    const mode = row.mode || row.source || "unknown";
    const verdict = row.verdict || "unknown";

    if (!byMode[mode]) byMode[mode] = { bets: 0, wins: 0, winRate: null };
    if (!byVerdict[verdict]) byVerdict[verdict] = { bets: 0, wins: 0, winRate: null };

    byMode[mode].bets += 1;
    byVerdict[verdict].bets += 1;

    if (row.result.modelWon) {
      byMode[mode].wins += 1;
      byVerdict[verdict].wins += 1;
    }
  }

  for (const key of Object.keys(byMode)) {
    byMode[key].winRate = byMode[key].bets ? byMode[key].wins / byMode[key].bets : null;
  }

  for (const key of Object.keys(byVerdict)) {
    byVerdict[key].winRate = byVerdict[key].bets ? byVerdict[key].wins / byVerdict[key].bets : null;
  }

  return {
    totalSnapshots: snapshots.length,
    gradedSnapshots: graded.length,
    wins,
    overallWinRate: graded.length ? wins / graded.length : null,
    byMode,
    byVerdict
  };
}

function buildCalibrationTable() {
  const graded = snapshots.filter(
    s => s?.result && typeof s.result.modelWon === "boolean" && Number.isFinite(s.calibratedProbability ?? s.trueProbability)
  );

  const buckets = {};

  for (const row of graded) {
    const prob = Number(row.calibratedProbability ?? row.trueProbability);
    const bucket = probabilityBucket(prob);

    if (!buckets[bucket]) {
      buckets[bucket] = {
        predictions: 0,
        wins: 0,
        predictedAverage: 0,
        actualRate: 0,
        bias: 0
      };
    }

    buckets[bucket].predictions += 1;
    buckets[bucket].predictedAverage += prob;
    if (row.result.modelWon) buckets[bucket].wins += 1;
  }

  for (const bucket of Object.keys(buckets)) {
    const row = buckets[bucket];
    row.predictedAverage = row.predictions
      ? row.predictedAverage / row.predictions
      : 0;
    row.actualRate = row.predictions
      ? row.wins / row.predictions
      : 0;
    row.bias = row.actualRate - row.predictedAverage;
  }

  calibrationTable = buckets;
  persistCalibration();

  return calibrationTable;
}

function getCalibrationTable() {
  return calibrationTable;
}

function applyCalibration(prob) {
  const p = Number(prob);
  if (!Number.isFinite(p)) return prob;

  const bucket = probabilityBucket(p);
  const row = calibrationTable[bucket];

  if (!row || !Number.isFinite(row.bias)) {
    return clamp(p, 0.01, 0.99);
  }

  return clamp(p + row.bias, 0.01, 0.99);
}

function updateGameResult({ gameId, finalWinner, finalHomeScore, finalAwayScore }) {
  let updated = 0;

  snapshots = snapshots.map(row => {
    if (String(row.gameId) !== String(gameId)) return row;
    if (!["home", "away"].includes(finalWinner)) return row;

    updated += 1;

    return {
      ...row,
      result: {
        finalWinner,
        modelWon: row.pickSide === finalWinner,
        finalHomeScore,
        finalAwayScore,
        gradedAt: new Date().toISOString()
      }
    };
  });

  persistSnapshots();
  buildCalibrationTable();

  return updated;
}

module.exports = {
  recordSnapshot,
  getSnapshots,
  getLearningSummary,
  getCalibrationTable,
  buildCalibrationTable,
  updateGameResult,
  applyCalibration
};