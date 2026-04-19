"use strict";

/**
 * weight_learner.js
 * Learns market-level blend weights from graded snapshots.
 * Exports: runWeightLearning, loadLearnedWeights, applyLearnedWeights, DEFAULT_WEIGHTS
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR      = path.join(__dirname, "data");
const WEIGHTS_FILE  = path.join(DATA_DIR, "learned_weights.json");

const MIN_SAMPLES   = 30;
const LEARNING_RATE = 0.005;
const MAX_EPOCHS    = 3000;
const L2_LAMBDA     = 0.08;
const K             = 4.0;

const DEFAULT_WEIGHTS = {
  bias:         0.0,
  market:       1.0,
  spread:       1.0,
  total:        1.0,
  lineMove:     1.0,
  disagreement: 1.0,
  statsBlend:   0.45,
  injury:       1.0,
  prop:         1.0
};

const BOUNDS = {
  bias:         { lo: -1.5, hi:  1.5 },
  market:       { lo:  0.6, hi:  1.8 },
  spread:       { lo:  0.0, hi:  6.0 },
  total:        { lo:  0.0, hi:  6.0 },
  lineMove:     { lo:  0.0, hi:  6.0 },
  disagreement: { lo:  0.0, hi:  6.0 },
  statsBlend:   { lo:  0.0, hi:  0.85 },
  injury:       { lo:  0.0, hi:  6.0 },
  prop:         { lo:  0.0, hi:  6.0 }
};

// ─── math ─────────────────────────────────────────────────────────────────────
function sigmoid(x) {
  const cx = Math.max(-50, Math.min(50, x));
  return 1 / (1 + Math.exp(-cx));
}

function logit(p) {
  const cp = Math.max(1e-7, Math.min(1 - 1e-7, p));
  return Math.log(cp / (1 - cp));
}

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// ─── file I/O ─────────────────────────────────────────────────────────────────
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadLearnedWeights() {
  try {
    ensureDir();
    if (!fs.existsSync(WEIGHTS_FILE)) {
      return { ...DEFAULT_WEIGHTS };
    }
    const raw = fs.readFileSync(WEIGHTS_FILE, "utf8").trim();
    if (!raw) return { ...DEFAULT_WEIGHTS };
    const saved = JSON.parse(raw);
    return { ...DEFAULT_WEIGHTS, ...(saved.weights || {}) };
  } catch (err) {
    console.error("[weight_learner] loadLearnedWeights failed:", err.message);
    return { ...DEFAULT_WEIGHTS };
  }
}

function saveLearnedWeights(weights, meta) {
  try {
    ensureDir();
    fs.writeFileSync(
      WEIGHTS_FILE,
      JSON.stringify({ weights, meta: { ...meta, savedAt: new Date().toISOString(), version: 3 } }, null, 2),
      "utf8"
    );
    return true;
  } catch (err) {
    console.error("[weight_learner] saveLearnedWeights failed:", err.message);
    return false;
  }
}

// ─── feature extraction ───────────────────────────────────────────────────────
function extractFeatures(snap) {
  if (!snap) return null;
  if (!snap.result || typeof snap.result.modelWon !== "boolean") return null;

  const mp = Number(snap.impliedProbability);
  if (!Number.isFinite(mp) || mp <= 0.01 || mp >= 0.99) return null;

  const side = snap.pickSide === "home" ? 1 : -1;

  const statsHomeProb = Number(snap.statsModelHomeProb);
  const statsDelta = Number.isFinite(statsHomeProb)
    ? (snap.pickSide === "home" ? statsHomeProb : 1 - statsHomeProb) - mp
    : 0;

  return {
    logitMarket:  logit(mp),
    spreadAdj:    side * Number(snap.spreadAdj      || 0),
    totalAdj:     side * Number(snap.totalAdj       || 0),
    lineMoveAdj:  side * Number(snap.lineMovementAdj || 0),
    disagreement: -Math.abs(Number(snap.disagreementPenalty || 0)),
    statsDelta,
    injuryAdj:    side * Number(snap.injuryAdjHome  || 0),
    propAdj:      side * Number(snap.propAdj        || 0),
    won:          snap.result.modelWon ? 1 : 0
  };
}

// ─── model ────────────────────────────────────────────────────────────────────
function predict(f, w) {
  const logitP =
    w.market       * f.logitMarket
    + w.spread       * f.spreadAdj    * K
    + w.total        * f.totalAdj     * K
    + w.lineMove     * f.lineMoveAdj  * K
    + w.disagreement * f.disagreement * K
    + w.statsBlend   * f.statsDelta   * K
    + w.injury       * f.injuryAdj    * K
    + w.prop         * f.propAdj      * K
    + w.bias;
  return sigmoid(logitP);
}

function computeLoss(samples, w) {
  const eps = 1e-7;
  let ce = 0;
  for (const f of samples) {
    const p = predict(f, w);
    ce += -(f.won * Math.log(p + eps) + (1 - f.won) * Math.log(1 - p + eps));
  }
  ce /= samples.length;

  let reg = 0;
  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    reg += (w[k] - DEFAULT_WEIGHTS[k]) ** 2;
  }
  reg = L2_LAMBDA * reg / samples.length;

  return ce + reg;
}

function numericalGradient(samples, w, eps = 1e-5) {
  const base = computeLoss(samples, w);
  const grad = {};
  for (const k of Object.keys(w)) {
    const wPlus = { ...w, [k]: w[k] + eps };
    grad[k] = (computeLoss(samples, wPlus) - base) / eps;
  }
  return grad;
}

// ─── Adam optimizer ───────────────────────────────────────────────────────────
async function runWeightLearning(snapshots) {
  console.log(`[weight_learner] Starting on ${snapshots.length} snapshots`);

  const features = snapshots.map(extractFeatures).filter(Boolean);
  console.log(`[weight_learner] Valid features: ${features.length}`);

  if (features.length < MIN_SAMPLES) {
    console.log(`[weight_learner] Not enough samples (${features.length} < ${MIN_SAMPLES})`);
    return { weights: DEFAULT_WEIGHTS, improved: false, samples: features.length };
  }

  let w = { ...loadLearnedWeights() };
  const initialLoss = computeLoss(features, w);
  let prevLoss = initialLoss;

  const m = Object.fromEntries(Object.keys(w).map(k => [k, 0]));
  const v = Object.fromEntries(Object.keys(w).map(k => [k, 0]));
  const b1 = 0.9, b2 = 0.999, eps_a = 1e-8;
  let t = 0, stalled = 0;

  for (let epoch = 0; epoch < MAX_EPOCHS; epoch++) {
    t++;
    const grad = numericalGradient(features, w);
    for (const k of Object.keys(w)) {
      m[k] = b1 * m[k] + (1 - b1) * grad[k];
      v[k] = b2 * v[k] + (1 - b2) * grad[k] ** 2;
      const mh = m[k] / (1 - b1 ** t);
      const vh = v[k] / (1 - b2 ** t);
      w[k] -= LEARNING_RATE * mh / (Math.sqrt(vh) + eps_a);
      const bnd = BOUNDS[k];
      if (bnd) w[k] = clamp(w[k], bnd.lo, bnd.hi);
    }

    const currentLoss = computeLoss(features, w);
    if (Math.abs(prevLoss - currentLoss) < 1e-7) {
      stalled++;
      if (stalled > 60) {
        console.log(`[weight_learner] Converged at epoch ${epoch + 1}`);
        break;
      }
    } else {
      stalled = 0;
    }
    prevLoss = currentLoss;
  }

  const finalLoss = computeLoss(features, w);
  const improved = finalLoss < initialLoss - 1e-4;

  let correct = 0;
  for (const f of features) {
    if ((predict(f, w) >= 0.5) === (f.won === 1)) correct++;
  }
  const accuracy = correct / features.length;

  console.log(`[weight_learner] Loss: ${initialLoss.toFixed(4)} → ${finalLoss.toFixed(4)} | Acc: ${(accuracy * 100).toFixed(1)}%`);

  if (improved || features.length >= 150) {
    saveLearnedWeights(w, { samples: features.length, finalLoss, initialLoss: initialLoss, accuracy });
    console.log("[weight_learner] Weights saved.");
  }

  return {
    weights: w, finalLoss, initialLoss: initialLoss, improved, samples: features.length,
    accuracy,
    marketResult: { improved, finalLoss, initialLoss: initialLoss },
    signalResult:  { improved: false }
  };
}

// ─── apply learned weights ────────────────────────────────────────────────────
function applyLearnedWeights({ marketProb, pickSide, modelDetails, statsHomeProb, weights }) {
  const w = weights || DEFAULT_WEIGHTS;
  const side = pickSide === "home" ? 1 : -1;

  let statsDelta = 0;
  if (typeof statsHomeProb === "number" && Number.isFinite(statsHomeProb)) {
    const spp = pickSide === "home" ? statsHomeProb : 1 - statsHomeProb;
    statsDelta = spp - marketProb;
  }

  const safeMarket = clamp(marketProb, 0.01, 0.99);
  const logitP =
    w.market       * logit(safeMarket)
    + w.spread       * side * Number(modelDetails?.spreadAdj       || 0) * K
    + w.total        * side * Number(modelDetails?.totalAdj        || 0) * K
    + w.lineMove     * side * Number(modelDetails?.lineMovementAdj || 0) * K
    + w.disagreement * -Math.abs(Number(modelDetails?.disagreementPenalty || 0)) * K
    + w.statsBlend   * statsDelta * K
    + w.injury       * side * Number(modelDetails?.injuryAdjHome   || 0) * K
    + w.prop         * side * Number(modelDetails?.propAdj         || 0) * K
    + w.bias;

  return clamp(sigmoid(logitP), 0.01, 0.99);
}

// ─── standalone ───────────────────────────────────────────────────────────────
if (require.main === module) {
  const learning = require("./learning");
  runWeightLearning(learning.getSnapshots())
    .then(r => { console.log(`Done. Improved: ${r.improved}`); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}

// ─── exports — explicitly listed, not compressed ──────────────────────────────
module.exports = {
  runWeightLearning,
  loadLearnedWeights,
  applyLearnedWeights,
  DEFAULT_WEIGHTS
};
