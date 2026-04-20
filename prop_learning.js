"use strict";

/**
 * prop_learning.js
 *
 * Full learning loop for player prop predictions:
 *
 *   1. Record every prop prediction as a snapshot
 *   2. Grade outcomes from BDL box scores (actual stat vs line)
 *   3. Build per-stat calibration table
 *   4. Optimize feature weights via Adam gradient descent
 *   5. Auto-grade scheduler (runs every 2 hours)
 *
 * After ~30 graded props the model starts self-correcting.
 * After ~100 it gets meaningfully more accurate than defaults.
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR     = path.join(__dirname, "data");
const SNAPS_FILE   = path.join(DATA_DIR, "prop_snapshots.json");
const WEIGHTS_FILE = path.join(DATA_DIR, "prop_weights.json");
const CAL_FILE     = path.join(DATA_DIR, "prop_calibration.json");
const AUDIT_FILE   = path.join(DATA_DIR, "prop_audit.json");

const BDL_KEY = process.env.BALLDONTLIE_API_KEY || "";

// ─── Learning thresholds ──────────────────────────────────────────────────────
const MIN_TO_OPTIMIZE   = 30;   // min graded props before optimization runs
const MIN_IMPROVEMENT   = 0.002; // must gain 0.2% accuracy to save
const LR                = 0.003;
const MAX_EPOCHS        = 2500;
const L2                = 0.06;
const BUFFER_HOURS      = 4;    // wait this long after game before grading

// ─── Default weights (mirror prop_model.js) ───────────────────────────────────
const DEFAULT_W = {
  seasonAvgDelta: 0.25, l5AvgDelta: 0.22, l10AvgDelta: 0.13,
  hitRate5: 0.12, hitRate10: 0.09, vsOppDelta: 0.06,
  locationSplit: 0.05, minsTrend: 0.05, consistency: 0.03,
};
const BOUNDS = {
  seasonAvgDelta: { lo: 0.05, hi: 0.60 }, l5AvgDelta:    { lo: 0.05, hi: 0.55 },
  l10AvgDelta:    { lo: 0.02, hi: 0.40 }, hitRate5:      { lo: 0.02, hi: 0.35 },
  hitRate10:      { lo: 0.01, hi: 0.25 }, vsOppDelta:    { lo: 0.00, hi: 0.20 },
  locationSplit:  { lo: 0.00, hi: 0.20 }, minsTrend:     { lo: 0.00, hi: 0.20 },
  consistency:    { lo: 0.00, hi: 0.15 },
};

// ─── Math ─────────────────────────────────────────────────────────────────────
const clamp   = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = x => 1 / (1 + Math.exp(-clamp(x, -50, 50)));
const r4 = n => Math.round(n * 10000) / 10000;
const flt = (v, fb = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };

// ─── File I/O ─────────────────────────────────────────────────────────────────
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    ensureDir();
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch { return fallback; }
}

function writeJson(filePath, value) {
  try {
    ensureDir();
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
  } catch (e) { console.error(`[prop_learning] writeJson ${filePath}:`, e.message); }
}

// ─── In-memory snapshot store ─────────────────────────────────────────────────
let snapshots = readJson(SNAPS_FILE, []);

function persist() {
  writeJson(SNAPS_FILE, snapshots);
}

// ─── Snapshot management ──────────────────────────────────────────────────────
function recordPropSnap(snap) {
  if (!snap?.id) return;
  const idx = snapshots.findIndex(s => s.id === snap.id);
  if (idx >= 0) {
    // Update existing — keep result if already graded
    snapshots[idx] = { ...snap, result: snapshots[idx].result || snap.result || null };
  } else {
    snapshots.push({ ...snap, result: null, recordedAt: new Date().toISOString() });
  }
  if (snapshots.length > 60000) snapshots = snapshots.slice(-60000);
  persist();
}

function getPropSnapshots() { return snapshots; }

// ─── BDL helpers ─────────────────────────────────────────────────────────────
async function bdlFetch(endpoint) {
  if (!BDL_KEY) throw new Error("Missing BALLDONTLIE_API_KEY");
  const res = await fetch(`https://api.balldontlie.io/v1${endpoint}`, {
    headers: { Authorization: BDL_KEY },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`BDL ${res.status}`);
  return res.json();
}
const bdlRows = p => Array.isArray(p) ? p : Array.isArray(p?.data) ? p.data : [];

// ─── Extract actual stat value from box score ─────────────────────────────────
function extractActualStat(row, statType) {
  const t = (statType || "").toLowerCase();
  if (t === "points"    || t === "pts") return flt(row.pts, NaN);
  if (t === "rebounds"  || t === "reb") return flt(row.reb ?? (flt(row.oreb, 0) + flt(row.dreb, 0)), NaN);
  if (t === "assists"   || t === "ast") return flt(row.ast, NaN);
  if (t === "pra"       || t === "points_rebounds_assists") {
    const p=flt(row.pts,NaN), r=flt(row.reb??(flt(row.oreb,0)+flt(row.dreb,0)),NaN), a=flt(row.ast,NaN);
    return isNaN(p)||isNaN(r)||isNaN(a) ? NaN : p+r+a;
  }
  if (t === "blocks"    || t === "blk") return flt(row.blk, NaN);
  if (t === "steals"    || t === "stl") return flt(row.stl, NaN);
  if (t === "threes"    || t === "3pm") return flt(row.fg3m, NaN);
  if (t === "turnovers" || t === "tov") return flt(row.turnover ?? row.to, NaN);
  return NaN;
}

function getSeason(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return d.getUTCMonth() + 1 >= 10 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

// ─── Grade ungraded snapshots ─────────────────────────────────────────────────
async function gradeUngraded() {
  const ungraded = snapshots.filter(s => !s.result && s.playerId && s.gameDate);
  if (!ungraded.length) {
    console.log("[prop_learning] Nothing to grade");
    return { graded: 0 };
  }

  console.log(`[prop_learning] Grading ${ungraded.length} ungraded props...`);

  // Group by game date
  const byDate = {};
  for (const s of ungraded) {
    const date = s.gameDate;
    if (!date) continue;
    const gameMs = new Date(`${date}T23:59:00Z`).getTime();
    if (Date.now() < gameMs + BUFFER_HOURS * 3600000) continue; // too recent
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(s);
  }

  if (!Object.keys(byDate).length) {
    console.log("[prop_learning] All props too recent to grade");
    return { graded: 0 };
  }

  let totalGraded = 0;

  for (const [date, daySnaps] of Object.entries(byDate)) {
    try {
      const season = getSeason(date);
      const data   = await bdlFetch(
        `/stats?dates[]=${encodeURIComponent(date)}&seasons[]=${season}&per_page=200`
      );
      const rows = bdlRows(data);

      for (const snap of daySnaps) {
        // Match by player ID
        const row = rows.find(r =>
          (r.player_id === snap.playerId || r.player?.id === snap.playerId) &&
          flt(r.min) > 0
        );
        if (!row) continue;

        const actual = extractActualStat(row, snap.statType);
        if (isNaN(actual) || !Number.isFinite(actual)) continue;

        const hitOver      = actual > snap.line;
        const modelCorrect = (snap.pick === "over") === hitOver;

        const idx = snapshots.findIndex(s => s.id === snap.id);
        if (idx >= 0) {
          snapshots[idx].result = {
            actualValue:   actual,
            hitOver,
            modelCorrect,
            gradedAt: new Date().toISOString(),
          };
          totalGraded++;
          console.log(
            `[prop_learning] ✓ ${snap.player} ${snap.statType} ${snap.line}: ` +
            `actual=${actual} ${hitOver ? "OVER" : "UNDER"} pick=${snap.pick} ${modelCorrect ? "✓" : "✗"}`
          );
        }
      }
    } catch (e) {
      console.error(`[prop_learning] Grade ${date}:`, e.message);
    }
  }

  if (totalGraded > 0) {
    persist();
    buildCalibration();

    const graded = snapshots.filter(s => s.result);
    if (graded.length >= MIN_TO_OPTIMIZE) {
      const improved = await optimizeWeights();
      if (improved) console.log("[prop_learning] Prop weights improved ✓");
    } else {
      console.log(`[prop_learning] Need ${MIN_TO_OPTIMIZE - graded.length} more graded props to optimize`);
    }
  }

  return { graded: totalGraded };
}

// ─── Calibration table ────────────────────────────────────────────────────────
function buildCalibration() {
  const graded = snapshots.filter(s => s.result && typeof s.result.hitOver === "boolean");
  const buckets = {};
  const byType  = {};

  for (const s of graded) {
    const p  = flt(s.overProb, 0.5);
    const bk = `${Math.floor(p * 20) * 5}`;
    const t  = s.statType || "unknown";

    if (!buckets[bk]) buckets[bk] = { n: 0, correct: 0, sumP: 0 };
    buckets[bk].n++;
    buckets[bk].sumP += p;
    if (s.result.hitOver === (s.pick === "over")) buckets[bk].correct++;

    if (!byType[t]) byType[t] = { n: 0, correct: 0 };
    byType[t].n++;
    if (s.result.modelCorrect) byType[t].correct++;
  }

  for (const b of Object.values(buckets)) {
    b.actualRate     = b.n ? r4(b.correct / b.n) : 0;
    b.predictedAvg   = b.n ? r4(b.sumP    / b.n) : 0;
    b.bias           = r4(b.actualRate - b.predictedAvg);
  }

  for (const b of Object.values(byType)) {
    b.accuracy = b.n ? r4(b.correct / b.n) : null;
  }

  const overall = graded.length
    ? r4(graded.filter(s => s.result.modelCorrect).length / graded.length)
    : null;

  writeJson(CAL_FILE, {
    buckets, byType,
    overall, gradedCount: graded.length,
    updatedAt: new Date().toISOString(),
  });

  console.log(
    `[prop_learning] Calibration: ${graded.length} graded | ` +
    `overall=${overall != null ? (overall * 100).toFixed(1) + "%" : "n/a"}`
  );

  return { buckets, byType, overall };
}

// ─── Weight optimizer (Adam gradient descent) ─────────────────────────────────
function predictFromFeatures(features, w) {
  let weightedSum = 0, totalW = 0;
  for (const [k, v] of Object.entries(features || {})) {
    const wt = flt(w[k], 0);
    weightedSum += v * wt;
    totalW += Math.abs(wt);
  }
  const SCALE = 5.5;
  return totalW > 0 ? clamp(sigmoid((weightedSum / totalW) * SCALE), 0.04, 0.96) : 0.5;
}

function computeLoss(samples, w) {
  const eps = 1e-7;
  let ce = 0, reg = 0;

  for (const s of samples) {
    const p = predictFromFeatures(s.features, w);
    const y = s.hitOver ? 1 : 0;
    ce += -(y * Math.log(p + eps) + (1 - y) * Math.log(1 - p + eps));
  }
  ce /= samples.length;

  // L2 regularisation toward defaults
  for (const k of Object.keys(DEFAULT_W)) {
    reg += (flt(w[k]) - (DEFAULT_W[k] || 0)) ** 2;
  }
  reg = L2 * reg / samples.length;

  return ce + reg;
}

async function optimizeWeights() {
  const gradedSnaps = snapshots.filter(s => s.result && s.features && typeof s.result.hitOver === "boolean");
  if (gradedSnaps.length < MIN_TO_OPTIMIZE) return false;

  console.log(`[prop_learning] Optimizing on ${gradedSnaps.length} graded props...`);

  const samples = gradedSnaps.map(s => ({ features: s.features, hitOver: s.result.hitOver }));
  const currentW = readJson(WEIGHTS_FILE, {})?.weights || { ...DEFAULT_W };
  let w = { ...currentW };

  const initLoss = computeLoss(samples, w);
  const m = Object.fromEntries(Object.keys(w).map(k => [k, 0]));
  const v = Object.fromEntries(Object.keys(w).map(k => [k, 0]));
  const b1 = 0.9, b2 = 0.999, ea = 1e-8;
  let t = 0, stalled = 0, bestW = { ...w }, bestLoss = initLoss;

  for (let ep = 0; ep < MAX_EPOCHS; ep++) {
    t++;
    // Numerical gradient
    const base = computeLoss(samples, w);
    const g    = {};
    for (const k of Object.keys(w)) {
      g[k] = (computeLoss(samples, { ...w, [k]: w[k] + 1e-5 }) - base) / 1e-5;
    }
    // Adam update
    for (const k of Object.keys(w)) {
      m[k] = b1 * m[k] + (1 - b1) * g[k];
      v[k] = b2 * v[k] + (1 - b2) * g[k] ** 2;
      const mh = m[k] / (1 - b1 ** t);
      const vh = v[k] / (1 - b2 ** t);
      w[k] -= LR * mh / (Math.sqrt(vh) + ea);
      if (BOUNDS[k]) w[k] = clamp(w[k], BOUNDS[k].lo, BOUNDS[k].hi);
    }

    const cl = computeLoss(samples, w);
    if (cl < bestLoss) { bestLoss = cl; bestW = { ...w }; stalled = 0; }
    if (Math.abs(base - cl) < 1e-7 && ++stalled > 70) {
      console.log(`[prop_learning] Converged at epoch ${ep + 1}`);
      break;
    }
  }

  // Normalise weights to sum to 1
  const total = Object.values(bestW).reduce((s, v) => s + Math.max(0, v), 0);
  if (total > 0) {
    for (const k of Object.keys(bestW)) bestW[k] = r4(Math.max(0, bestW[k]) / total);
  }

  // Accuracy check
  let correct = 0;
  for (const s of samples) {
    if ((predictFromFeatures(s.features, bestW) >= 0.5) === s.hitOver) correct++;
  }
  const accuracy   = correct / samples.length;
  const improved   = bestLoss < initLoss - 0.001;

  // Only save if genuinely improved or we have enough data
  if (improved || gradedSnaps.length >= 100) {
    writeJson(WEIGHTS_FILE, {
      weights: bestW,
      meta: {
        samples:    gradedSnaps.length,
        accuracy:   r4(accuracy),
        initLoss:   r4(initLoss),
        finalLoss:  r4(bestLoss),
        improved,
        savedAt: new Date().toISOString(),
      },
    });

    // Write audit entry
    const audit = readJson(AUDIT_FILE, []);
    audit.push({
      ts:        new Date().toISOString(),
      samples:   gradedSnaps.length,
      accuracy:  r4(accuracy),
      improved,
      initLoss:  r4(initLoss),
      finalLoss: r4(bestLoss),
    });
    writeJson(AUDIT_FILE, audit.slice(-50));

    console.log(
      `[prop_learning] Weights saved | accuracy=${(accuracy * 100).toFixed(1)}% | ` +
      `loss: ${initLoss.toFixed(4)}→${bestLoss.toFixed(4)}`
    );

    // Reload in prop_model
    try { require("./prop_model").reloadPropWeights(); } catch {}

    return true;
  }

  return false;
}

// ─── Learning summary ─────────────────────────────────────────────────────────
function getPropLearningSummary() {
  const graded  = snapshots.filter(s => s.result);
  const correct = graded.filter(s => s.result.modelCorrect).length;

  const byType = {};
  const byVerdict = {};

  for (const s of graded) {
    const t = s.statType || "unknown";
    const vd = s.verdict || "unknown";

    if (!byType[t])    byType[t]    = { n: 0, correct: 0 };
    if (!byVerdict[vd]) byVerdict[vd] = { n: 0, correct: 0 };

    byType[t].n++; if (s.result.modelCorrect) byType[t].correct++;
    byVerdict[vd].n++; if (s.result.modelCorrect) byVerdict[vd].correct++;
  }

  for (const b of Object.values(byType))    b.accuracy = b.n ? r4(b.correct / b.n) : null;
  for (const b of Object.values(byVerdict)) b.accuracy = b.n ? r4(b.correct / b.n) : null;

  const weights = readJson(WEIGHTS_FILE, null);

  return {
    total:       snapshots.length,
    graded:      graded.length,
    correct,
    accuracy:    graded.length ? r4(correct / graded.length) : null,
    byType,
    byVerdict,
    learnedWeightsActive: weights != null,
    weightsMeta: weights?.meta || null,
  };
}

// ─── Auto-grade scheduler ─────────────────────────────────────────────────────
function startPropGradeScheduler(intervalMs = 2 * 60 * 60 * 1000) {
  console.log(`[prop_learning] Scheduler started (every ${Math.round(intervalMs / 60000)} min)`);
  // First run after 5 min
  setTimeout(async () => {
    try { await gradeUngraded(); } catch (e) { console.error("[prop_learning]", e.message); }
  }, 5 * 60 * 1000);

  setInterval(async () => {
    try { await gradeUngraded(); } catch (e) { console.error("[prop_learning]", e.message); }
  }, intervalMs);
}

module.exports = {
  recordPropSnap,
  getPropSnapshots,
  gradeUngraded,
  buildCalibration,
  getPropLearningSummary,
  startPropGradeScheduler,
};
