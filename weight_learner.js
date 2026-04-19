"use strict";

/**
 * weight_learner.js
 *
 * Learns the optimal weight for every signal in the model using logistic
 * regression on historically graded snapshots.
 *
 * Signals it optimises:
 *   market       — how much to trust the no-vig market probability baseline
 *   spread       — multiplier on spreadAdj
 *   total        — multiplier on totalAdj
 *   lineMove     — multiplier on lineMovementAdj
 *   disagreement — multiplier on disagreementPenalty
 *   statsBlend   — replaces the hardcoded STATS_MODEL_BLEND (0.45)
 *   injury       — multiplier on injuryAdjHome
 *   prop         — multiplier on propAdj
 *   bias         — learned intercept (catches systematic home/away bias)
 *
 * Algorithm: Adam optimiser (adaptive gradient) minimising binary cross-entropy
 *            with L2 regularisation that penalises deviation from safe defaults.
 *
 * Saved to:  data/learned_weights.json
 * Loaded by: server.js at startup and after every learning pass.
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR     = path.join(__dirname, "data");
const WEIGHTS_FILE = path.join(DATA_DIR, "learned_weights.json");

// ─── hyper-parameters ─────────────────────────────────────────────────────────
const MIN_SAMPLES          = 30;     // refuse to train with fewer graded samples
const LEARNING_RATE        = 0.005;  // Adam base LR
const MAX_EPOCHS           = 3000;
const L2_LAMBDA            = 0.08;   // regularisation — pulls weights toward defaults
const CONVERGENCE_EPS      = 1e-7;   // stop when loss change < this
const PROB_TO_LOGIT_SCALE  = 4.0;    // converts small %-point adjustments to logit delta
                                     // (approx derivative of logit at p=0.5 is 4)

// ─── default weights (reproduce current hardcoded model behaviour) ─────────────
const DEFAULT_WEIGHTS = {
  bias:         0.0,
  market:       1.0,   // logit(marketProb) weight — should stay near 1
  spread:       1.0,   // spreadAdj multiplier
  total:        1.0,   // totalAdj multiplier
  lineMove:     1.0,   // lineMovementAdj multiplier
  disagreement: 1.0,   // disagreementPenalty multiplier
  statsBlend:   0.45,  // stats-model blend weight (was STATS_MODEL_BLEND constant)
  injury:       1.0,   // injuryAdjHome multiplier
  prop:         1.0    // propAdj multiplier
};

// Bounds for each weight to prevent degenerate solutions
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
  // clamp to avoid over/underflow
  const cx = Math.max(-50, Math.min(50, x));
  return 1 / (1 + Math.exp(-cx));
}

function logit(p) {
  const cp = Math.max(1e-7, Math.min(1 - 1e-7, p));
  return Math.log(cp / (1 - cp));
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// ─── file I/O ─────────────────────────────────────────────────────────────────
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Load previously saved weights (or return defaults if nothing saved yet).
 */
function loadLearnedWeights() {
  try {
    ensureDir();
    if (!fs.existsSync(WEIGHTS_FILE)) return { ...DEFAULT_WEIGHTS };
    const raw = fs.readFileSync(WEIGHTS_FILE, "utf8").trim();
    if (!raw) return { ...DEFAULT_WEIGHTS };
    const saved = JSON.parse(raw);
    // Merge: new keys in DEFAULT_WEIGHTS get their default value
    return { ...DEFAULT_WEIGHTS, ...(saved.weights || {}) };
  } catch (err) {
    console.error("[weight_learner] loadLearnedWeights failed:", err.message);
    return { ...DEFAULT_WEIGHTS };
  }
}

function saveLearnedWeights(weights, meta = {}) {
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
/**
 * Turn one learning snapshot into a numeric feature vector.
 * All values are expressed from the "pick side" perspective
 * (positive = helps the team we bet on).
 *
 * Returns null for snapshots that are not usable (no result, bad market prob, etc.)
 */
function extractFeatures(snapshot) {
  if (!snapshot) return null;
  if (!snapshot.result || typeof snapshot.result.modelWon !== "boolean") return null;

  const marketProb = Number(snapshot.impliedProbability);
  if (!Number.isFinite(marketProb) || marketProb <= 0.01 || marketProb >= 0.99) return null;

  // Sign convention: pick-side positive
  const side = snapshot.pickSide === "home" ? 1 : -1;

  const spreadAdj  = side * Number(snapshot.spreadAdj     || 0);
  const totalAdj   = side * Number(snapshot.totalAdj      || 0);
  const lineMoveAdj = side * Number(snapshot.lineMovementAdj || 0);
  // disagreement always hurts the pick
  const disagreement = -Math.abs(Number(snapshot.disagreementPenalty || 0));
  const injuryAdj  = side * Number(snapshot.injuryAdjHome  || 0);
  const propAdj    = side * Number(snapshot.propAdj        || 0);

  // Stats model signal: how much the independent model's pick-side probability
  // exceeds the market probability (positive = stats model is more bullish)
  let statsDelta = 0;
  const statsHomeProb = Number(snapshot.statsModelHomeProb);
  if (Number.isFinite(statsHomeProb) && statsHomeProb > 0 && statsHomeProb < 1) {
    const statsPickProb = snapshot.pickSide === "home" ? statsHomeProb : 1 - statsHomeProb;
    statsDelta = statsPickProb - marketProb;
  }

  return {
    logitMarket:  logit(marketProb),
    spreadAdj,
    totalAdj,
    lineMoveAdj,
    disagreement,
    statsDelta,
    injuryAdj,
    propAdj,
    won: snapshot.result.modelWon ? 1 : 0
  };
}

// ─── forward pass ─────────────────────────────────────────────────────────────
/**
 * Predicted win probability for a feature vector given a weight set.
 *
 * Model:
 *   logit(p) = market_w * logit(mktProb)
 *            + spread_w    * spreadAdj    * K
 *            + total_w     * totalAdj     * K
 *            + lineMove_w  * lineMoveAdj  * K
 *            + disagree_w  * disagreement * K
 *            + statsBlend  * statsDelta   * K
 *            + injury_w    * injuryAdj    * K
 *            + prop_w      * propAdj      * K
 *            + bias
 *
 * where K = PROB_TO_LOGIT_SCALE ≈ 4.0 converts %-point adjustments to logit.
 */
function predict(f, w) {
  const K = PROB_TO_LOGIT_SCALE;
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

// ─── loss (binary cross-entropy + L2 regularisation) ─────────────────────────
function computeLoss(samples, w) {
  const eps = 1e-7;
  let ce = 0;
  for (const f of samples) {
    const p  = predict(f, w);
    ce += -(f.won * Math.log(p + eps) + (1 - f.won) * Math.log(1 - p + eps));
  }
  ce /= samples.length;

  // L2: penalise deviation from DEFAULT_WEIGHTS (not from zero)
  let reg = 0;
  for (const k of Object.keys(DEFAULT_WEIGHTS)) {
    reg += (w[k] - DEFAULT_WEIGHTS[k]) ** 2;
  }
  reg = L2_LAMBDA * reg / samples.length;

  return ce + reg;
}

// ─── numerical gradient ───────────────────────────────────────────────────────
function computeGradient(samples, w, eps = 1e-5) {
  const base = computeLoss(samples, w);
  const grad = {};
  for (const k of Object.keys(w)) {
    const wPlus   = { ...w, [k]: w[k] + eps };
    grad[k] = (computeLoss(samples, wPlus) - base) / eps;
  }
  return grad;
}

// ─── Adam optimiser ───────────────────────────────────────────────────────────
function trainWeights(samples, startWeights) {
  if (samples.length < MIN_SAMPLES) {
    return {
      weights:     { ...DEFAULT_WEIGHTS },
      finalLoss:   null,
      initialLoss: null,
      improved:    false,
      reason:      `Too few samples (${samples.length} < ${MIN_SAMPLES})`
    };
  }

  let w         = { ...startWeights };
  const initialLoss = computeLoss(samples, w);
  let prevLoss  = initialLoss;

  // Adam state
  const m  = Object.fromEntries(Object.keys(w).map(k => [k, 0]));
  const v  = Object.fromEntries(Object.keys(w).map(k => [k, 0]));
  const b1 = 0.9, b2 = 0.999, eps_a = 1e-8;
  let   t  = 0;

  for (let epoch = 0; epoch < MAX_EPOCHS; epoch++) {
    t++;
    const grad = computeGradient(samples, w);

    for (const k of Object.keys(w)) {
      m[k]  = b1 * m[k] + (1 - b1) * grad[k];
      v[k]  = b2 * v[k] + (1 - b2) * grad[k] ** 2;
      const mh = m[k] / (1 - b1 ** t);
      const vh = v[k] / (1 - b2 ** t);
      w[k]  -= LEARNING_RATE * mh / (Math.sqrt(vh) + eps_a);
      // Enforce bounds
      const bnd = BOUNDS[k];
      if (bnd) w[k] = clamp(w[k], bnd.lo, bnd.hi);
    }

    const currentLoss = computeLoss(samples, w);
    if (epoch > 50 && Math.abs(prevLoss - currentLoss) < CONVERGENCE_EPS) {
      console.log(`[weight_learner] Converged at epoch ${epoch + 1}.`);
      break;
    }
    prevLoss = currentLoss;
  }

  const finalLoss = computeLoss(samples, w);
  const improved  = finalLoss < initialLoss - 1e-4;

  return { weights: w, finalLoss, initialLoss, improved };
}

// ─── accuracy diagnostics ─────────────────────────────────────────────────────
function diagnose(samples, w) {
  let correct = 0, totalWin = 0, predictedWin = 0;
  const buckets = {};  // "50-55%": { predictions, wins }

  for (const f of samples) {
    const p       = predict(f, w);
    const bucketLo = Math.floor(p * 20) * 5;  // 0,5,10,...,95
    const key     = `${bucketLo}-${bucketLo + 5}%`;
    if (!buckets[key]) buckets[key] = { predictions: 0, wins: 0, sumP: 0 };
    buckets[key].predictions++;
    buckets[key].sumP += p;
    if (f.won) { buckets[key].wins++; totalWin++; }
    if (p >= 0.5) predictedWin++;
    if ((p >= 0.5) === (f.won === 1)) correct++;
  }

  for (const b of Object.values(buckets)) {
    b.avgP    = b.sumP / b.predictions;
    b.winRate = b.wins / b.predictions;
    b.bias    = b.winRate - b.avgP;
    delete b.sumP;
  }

  return {
    accuracy:     correct / samples.length,
    baseRate:     totalWin / samples.length,
    predictedWinRate: predictedWin / samples.length,
    calibrationBuckets: buckets
  };
}

// ─── main export ──────────────────────────────────────────────────────────────
/**
 * Run a full weight-learning pass.
 *
 * @param {Array} snapshots  — from learning.getSnapshots()
 * @returns {Promise<{ weights, finalLoss, initialLoss, improved, samples }>}
 */
async function runWeightLearning(snapshots) {
  console.log(`[weight_learner] Starting on ${snapshots.length} total snapshots...`);

  const features = snapshots.map(extractFeatures).filter(Boolean);
  const gradedCount = features.length;
  console.log(`[weight_learner] Valid graded feature vectors: ${gradedCount}`);

  if (gradedCount < MIN_SAMPLES) {
    console.log(`[weight_learner] Not enough samples yet (${gradedCount} < ${MIN_SAMPLES}).`);
    return { weights: DEFAULT_WEIGHTS, improved: false, samples: gradedCount };
  }

  // Warm-start from previously saved weights
  const startWeights = loadLearnedWeights();
  console.log("[weight_learner] Starting weights:", JSON.stringify(startWeights, null, 2));

  const result = trainWeights(features, startWeights);

  // Diagnostics
  const diagnostics = diagnose(features, result.weights);
  console.log(`[weight_learner] Accuracy: ${(diagnostics.accuracy * 100).toFixed(1)}% ` +
              `(base rate: ${(diagnostics.baseRate * 100).toFixed(1)}%)`);
  console.log("[weight_learner] Learned weights:", JSON.stringify(result.weights, null, 2));

  // Save if improved or we have enough data to trust the result
  const shouldSave = result.improved || gradedCount >= 150;
  if (shouldSave) {
    saveLearnedWeights(result.weights, {
      samples:     gradedCount,
      finalLoss:   result.finalLoss,
      initialLoss: result.initialLoss,
      accuracy:    diagnostics.accuracy,
      baseRate:    diagnostics.baseRate
    });
    console.log(`[weight_learner] Weights saved to ${WEIGHTS_FILE}`);
  } else {
    console.log("[weight_learner] No significant improvement — keeping existing weights.");
  }

  return {
    ...result,
    samples:     gradedCount,
    diagnostics
  };
}

/**
 * Apply learned weights to compute a blended true probability.
 *
 * This is called from server.js after both the market model and stats model
 * have run, replacing the hardcoded blend logic.
 *
 * @param {object} params
 * @param {number} params.marketProb      — no-vig implied prob for pick side
 * @param {string} params.pickSide        — "home" | "away"
 * @param {object} params.modelDetails    — from pregame/live model
 * @param {number|null} params.statsHomeProb — from stats_model (or null)
 * @param {object} params.weights         — loaded learned weights
 * @returns {number} blended true probability (0.01–0.99)
 */
function applyLearnedWeights({ marketProb, pickSide, modelDetails, statsHomeProb, weights }) {
  const w    = weights || DEFAULT_WEIGHTS;
  const side = pickSide === "home" ? 1 : -1;
  const K    = PROB_TO_LOGIT_SCALE;

  const spreadAdj    = side * Number(modelDetails?.spreadAdj || 0);
  const totalAdj     = side * Number(modelDetails?.totalAdj  || 0);
  const lineMoveAdj  = side * Number(modelDetails?.lineMovementAdj || 0);
  const disagreement = -Math.abs(Number(modelDetails?.disagreementPenalty || 0));
  const injuryAdj    = side * Number(modelDetails?.injuryAdjHome  || 0);
  const propAdj      = side * Number(modelDetails?.propAdj  || 0);

  let statsDelta = 0;
  if (typeof statsHomeProb === "number" && Number.isFinite(statsHomeProb)) {
    const statsPickProb = pickSide === "home" ? statsHomeProb : 1 - statsHomeProb;
    statsDelta = statsPickProb - marketProb;
  }

  const safeMarket = clamp(marketProb, 0.01, 0.99);
  const logitP =
    w.market       * logit(safeMarket)
    + w.spread       * spreadAdj    * K
    + w.total        * totalAdj     * K
    + w.lineMove     * lineMoveAdj  * K
    + w.disagreement * disagreement * K
    + w.statsBlend   * statsDelta   * K
    + w.injury       * injuryAdj    * K
    + w.prop         * propAdj      * K
    + w.bias;

  return clamp(sigmoid(logitP), 0.01, 0.99);
}

// ─── run standalone: node weight_learner.js ──────────────────────────────────
if (require.main === module) {
  const learning = require("./learning");
  runWeightLearning(learning.getSnapshots())
    .then(r => {
      console.log(`\nDone. Improved: ${r.improved}, Samples: ${r.samples}`);
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = {
  runWeightLearning,
  loadLearnedWeights,
  applyLearnedWeights,
  extractFeatures,
  DEFAULT_WEIGHTS
};
