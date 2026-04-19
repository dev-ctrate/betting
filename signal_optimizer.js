"use strict";

/**
 * signal_optimizer.js
 *
 * Self-calibrating AI weight optimizer.
 *
 * What it does:
 *   1. Loads ALL graded historical snapshots (live + backfill)
 *   2. Backtests every snapshot using current signal weights
 *   3. Measures accuracy per signal, per confidence tier, per edge bucket
 *   4. Runs gradient descent + simulated annealing to find weights that
 *      maximize prediction accuracy — specifically targeting 70-90% on
 *      high-confidence predictions (edge ≥ 0.045)
 *   5. Validates that new weights are BETTER before saving
 *   6. Saves to data/signal_weights.json (auto-loaded by stats_model.js)
 *   7. Reports a full audit trail so you can see exactly what changed and why
 *
 * Loss function design:
 *   Standard binary cross-entropy penalises wrong predictions.
 *   We add a CALIBRATION BONUS that rewards models where predictions in
 *   the 70-90% confidence zone are actually correct 70-90% of the time.
 *   We also penalise OVERCONFIDENCE (predicting 90%+ when accuracy is 60%).
 *
 * Runs automatically after auto_grader.js grades new games.
 * Can also run standalone: node signal_optimizer.js
 *
 * Requirements:
 *   • At least 50 graded snapshots to run
 *   • At least 20 snapshots with statsSignals stored to optimise signals
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR         = path.join(__dirname, "data");
const SIGNAL_W_FILE    = path.join(DATA_DIR, "signal_weights.json");
const MARKET_W_FILE    = path.join(DATA_DIR, "learned_weights.json");
const AUDIT_FILE       = path.join(DATA_DIR, "optimizer_audit.json");

// ─── targets ──────────────────────────────────────────────────────────────────
const TARGET_ACCURACY_LOW  = 0.70;   // minimum acceptable overall accuracy
const TARGET_ACCURACY_HIGH = 0.90;   // ceiling — above this we're overfitting
const TARGET_EDGE_ACCURACY = 0.75;   // target for "Bet now" predictions specifically
const MIN_SAMPLES          = 50;     // minimum graded snapshots to run at all
const MIN_SIGNAL_SAMPLES   = 20;     // minimum snapshots with signal data
const MIN_IMPROVEMENT      = 0.004;  // must improve accuracy by 0.4% to save

// ─── optimizer config ─────────────────────────────────────────────────────────
const MAX_ITERATIONS   = 5000;
const LR_ADAM          = 0.003;
const L2_REG           = 0.06;
const ANNEAL_STEPS     = 500;        // simulated annealing after Adam stalls
const ANNEAL_TEMP      = 0.08;       // initial temperature
const ANNEAL_DECAY     = 0.992;

// ─── signal weight defaults + bounds ─────────────────────────────────────────
const DEFAULT_W = {
  officialNetRating:   0.18, injuryAdjNetRating: 0.10, predictedSpread:   0.10,
  pie:                 0.08, recentForm:         0.08, clutch:            0.07,
  starPower:           0.06, shooting:           0.05, turnover:          0.05,
  rest:                0.05, hustle:             0.04, rebound:           0.03,
  shotQuality:         0.03, h2h:                0.03, momentum:          0.03,
  opponentMatchup:     0.02, splits:             0.02, pace:              0.02,
  threePointVariance:  0.02, defense:            0.01,
};

// Each signal weight can range from 0 to 0.50 max
const W_BOUNDS = Object.fromEntries(Object.keys(DEFAULT_W).map(k => [k, { lo: 0.0, hi: 0.50 }]));
// Net rating signals get higher ceiling since they're most predictive
W_BOUNDS.officialNetRating.hi   = 0.55;
W_BOUNDS.injuryAdjNetRating.hi  = 0.45;
W_BOUNDS.predictedSpread.hi     = 0.45;
W_BOUNDS.pie.hi                 = 0.35;

// ─── math ─────────────────────────────────────────────────────────────────────
const clamp  = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = x => 1 / (1 + Math.exp(-clamp(x, -50, 50)));
const logit   = p => { const c = clamp(p, 1e-7, 1-1e-7); return Math.log(c/(1-c)); };
const r4      = n => Math.round(n * 10000) / 10000;
const r2      = n => Math.round(n * 100) / 100;

// ─── file I/O ─────────────────────────────────────────────────────────────────
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadWeights(file, defaults) {
  try {
    ensureDir();
    if (!fs.existsSync(file)) return { ...defaults };
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return { ...defaults };
    const saved = JSON.parse(raw);
    return { ...defaults, ...(saved.weights || {}) };
  } catch { return { ...defaults }; }
}

function saveWeights(file, weights, meta = {}) {
  try {
    ensureDir();
    fs.writeFileSync(file, JSON.stringify({
      weights,
      meta: { ...meta, savedAt: new Date().toISOString(), version: 4 }
    }, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("[optimizer] saveWeights failed:", e.message);
    return false;
  }
}

function saveAudit(entry) {
  try {
    ensureDir();
    let existing = [];
    if (fs.existsSync(AUDIT_FILE)) {
      try { existing = JSON.parse(fs.readFileSync(AUDIT_FILE, "utf8")); }
      catch { existing = []; }
    }
    existing.push({ ...entry, ts: new Date().toISOString() });
    // Keep last 50 audit entries
    if (existing.length > 50) existing = existing.slice(-50);
    fs.writeFileSync(AUDIT_FILE, JSON.stringify(existing, null, 2), "utf8");
  } catch { /* non-critical */ }
}

// ─── feature extraction from snapshots ───────────────────────────────────────
/**
 * Extract trainable features from a graded snapshot.
 * Returns null for unusable snapshots.
 */
function extractFeatures(snap) {
  if (!snap) return null;
  if (!snap.result || typeof snap.result.modelWon !== "boolean") return null;

  const won   = snap.result.modelWon ? 1 : 0;
  const edge  = typeof snap.calibratedEdge === "number" ? snap.calibratedEdge
               : typeof snap.rawEdge === "number" ? snap.rawEdge : null;
  const prob  = typeof snap.calibratedTrueProbability === "number" ? snap.calibratedTrueProbability
               : typeof snap.trueProbability === "number" ? snap.trueProbability : null;
  const implied = typeof snap.impliedProbability === "number" ? snap.impliedProbability : null;

  if (prob === null || implied === null) return null;

  // Extract individual signal logit values (stored from stats_model run)
  const signals = {};
  const rawSignals = snap.statsSignals || {};
  for (const [k, v] of Object.entries(rawSignals)) {
    const p = typeof v === "object" ? Number(v.prob) : Number(v);
    if (Number.isFinite(p) && p > 0 && p < 1) {
      signals[k] = logit(p);  // convert to logit space
    }
  }

  const hasSignals = Object.keys(signals).length >= 5;

  return {
    won,
    prob,
    implied,
    edge,
    verdict: snap.verdict,
    mode:    snap.mode || snap.source || "unknown",
    signals: hasSignals ? signals : null,
    // Market features (for market weight learning)
    pickSide:         snap.pickSide,
    spreadAdj:        typeof snap.spreadAdj === "number"         ? snap.spreadAdj         : 0,
    totalAdj:         typeof snap.totalAdj === "number"          ? snap.totalAdj           : 0,
    lineMoveAdj:      typeof snap.lineMovementAdj === "number"   ? snap.lineMovementAdj    : 0,
    disagreement:     typeof snap.disagreementPenalty === "number"?snap.disagreementPenalty: 0,
    injuryAdj:        typeof snap.injuryAdjHome === "number"     ? snap.injuryAdjHome      : 0,
    statsHomeProb:    typeof snap.statsModelHomeProb === "number" ? snap.statsModelHomeProb : null,
  };
}

// ─── prediction function ───────────────────────────────────────────────────────
/**
 * Predict win probability from a feature vector using signal weights.
 * Returns value in (0, 1).
 */
function predictFromSignals(feat, weights) {
  if (!feat.signals) return feat.prob;  // fall back to stored prob if no signals

  let logitSum = 0, weightSum = 0;
  for (const [k, logitV] of Object.entries(feat.signals)) {
    const w = weights[k] || 0;
    logitSum  += logitV * w;
    weightSum += w;
  }

  if (weightSum === 0) return feat.prob;
  return clamp(sigmoid(logitSum), 0.01, 0.99);
}

// ─── loss function ────────────────────────────────────────────────────────────
/**
 * Custom loss combining:
 *   1. Binary cross-entropy (standard)
 *   2. Calibration bonus (reward accurate confidence estimates)
 *   3. Overconfidence penalty (penalise wrong high-confidence predictions)
 *   4. L2 regularisation toward DEFAULT_W
 */
function computeLoss(features, weights) {
  const eps = 1e-7;
  let ce = 0, calBonus = 0, overconfPenalty = 0;

  // Bucket predictions to check calibration
  const buckets = {};  // "60-65": { count, wins, sumP }

  for (const f of features) {
    const p   = predictFromSignals(f, weights);
    const y   = f.won;

    // Binary cross-entropy
    ce += -(y * Math.log(p + eps) + (1 - y) * Math.log(1 - p + eps));

    // Bucket for calibration
    const pct    = Math.floor(p * 20) * 5;   // 0, 5, 10, ..., 95
    const bkey   = `${pct}`;
    if (!buckets[bkey]) buckets[bkey] = { count: 0, wins: 0, sumP: 0 };
    buckets[bkey].count++;
    buckets[bkey].sumP += p;
    if (y) buckets[bkey].wins++;

    // Overconfidence penalty: if model says 85%+ but it's wrong, penalise hard
    if (p >= 0.80 && y === 0) overconfPenalty += (p - 0.80) * 2.5;
    if (p <= 0.20 && y === 1) overconfPenalty += (0.20 - p) * 2.5;
  }

  ce /= features.length;
  overconfPenalty /= features.length;

  // Calibration: reward models where bucket win rate ≈ bucket avg predicted prob
  for (const b of Object.values(buckets)) {
    if (b.count < 5) continue;
    const avgP   = b.sumP / b.count;
    const actual = b.wins / b.count;
    const calErr = Math.abs(actual - avgP);
    // Reward good calibration (lower error = bonus)
    calBonus += calErr * calErr;
  }
  calBonus = calBonus / Math.max(Object.keys(buckets).length, 1);

  // L2 regularisation toward DEFAULT_W
  let reg = 0;
  for (const k of Object.keys(weights)) {
    reg += (weights[k] - (DEFAULT_W[k] || 0)) ** 2;
  }
  reg = L2_REG * reg / features.length;

  return ce + calBonus * 0.3 + overconfPenalty * 0.2 + reg;
}

// ─── accuracy metrics ─────────────────────────────────────────────────────────
function computeAccuracy(features, weights) {
  let total = 0, correct = 0, betNowTotal = 0, betNowCorrect = 0;
  let highConfTotal = 0, highConfCorrect = 0;

  const byEdgeBucket = {};

  for (const f of features) {
    const p = predictFromSignals(f, weights);

    total++;
    if ((p >= 0.5) === (f.won === 1)) correct++;

    // Track "Bet now" accuracy (edge >= 0.045)
    if (f.edge != null && Math.abs(f.edge) >= 0.045) {
      betNowTotal++;
      if ((p >= 0.5) === (f.won === 1)) betNowCorrect++;
    }

    // High confidence (model > 70%)
    if (p >= 0.70) {
      highConfTotal++;
      if (f.won === 1) highConfCorrect++;
    }

    // Edge bucket breakdown
    const eb = f.edge != null ? Math.round(Math.abs(f.edge) * 100) : -1;
    const bk = eb < 0 ? "unknown" : eb < 2 ? "<2%" : eb < 4 ? "2-4%" : eb < 6 ? "4-6%" : eb < 8 ? "6-8%" : "8%+";
    if (!byEdgeBucket[bk]) byEdgeBucket[bk] = { total: 0, correct: 0 };
    byEdgeBucket[bk].total++;
    if ((p >= 0.5) === (f.won === 1)) byEdgeBucket[bk].correct++;
  }

  // Finalise bucket accuracy
  for (const b of Object.values(byEdgeBucket)) {
    b.accuracy = b.total > 0 ? r4(b.correct / b.total) : null;
  }

  return {
    overall:        total > 0 ? r4(correct / total) : null,
    betNow:         betNowTotal > 0 ? r4(betNowCorrect / betNowTotal) : null,
    highConf:       highConfTotal > 0 ? r4(highConfCorrect / highConfTotal) : null,
    samples:        total,
    betNowSamples:  betNowTotal,
    byEdgeBucket
  };
}

// ─── numerical gradient ───────────────────────────────────────────────────────
function numericalGrad(features, weights, eps = 1e-5) {
  const base = computeLoss(features, weights);
  const grad = {};
  for (const k of Object.keys(weights)) {
    const wp = { ...weights, [k]: weights[k] + eps };
    grad[k] = (computeLoss(features, wp) - base) / eps;
  }
  return grad;
}

// ─── Adam optimizer ───────────────────────────────────────────────────────────
function runAdam(features, startWeights) {
  let w = { ...startWeights };
  const m = Object.fromEntries(Object.keys(w).map(k => [k, 0]));
  const v = Object.fromEntries(Object.keys(w).map(k => [k, 0]));
  const b1 = 0.9, b2 = 0.999, ea = 1e-8;
  let t = 0;

  const initialLoss = computeLoss(features, w);
  let bestLoss = initialLoss;
  let bestW    = { ...w };
  let prevLoss = initialLoss;
  let stalled  = 0;

  for (let ep = 0; ep < MAX_ITERATIONS; ep++) {
    t++;
    const grad = numericalGrad(features, w);

    for (const k of Object.keys(w)) {
      m[k] = b1 * m[k] + (1 - b1) * grad[k];
      v[k] = b2 * v[k] + (1 - b2) * grad[k] ** 2;
      const mh = m[k] / (1 - b1 ** t);
      const vh = v[k] / (1 - b2 ** t);
      w[k] -= LR_ADAM * mh / (Math.sqrt(vh) + ea);
      // Enforce bounds
      const b = W_BOUNDS[k];
      if (b) w[k] = clamp(w[k], b.lo, b.hi);
    }

    const cl = computeLoss(features, w);
    if (cl < bestLoss) { bestLoss = cl; bestW = { ...w }; stalled = 0; }
    if (Math.abs(prevLoss - cl) < 1e-7) stalled++;
    if (stalled > 80) { console.log(`[optimizer] Adam converged at epoch ${ep + 1}`); break; }
    prevLoss = cl;
  }

  return { weights: bestW, finalLoss: bestLoss, initialLoss };
}

// ─── simulated annealing (escapes local minima) ────────────────────────────────
function runAnnealing(features, startWeights) {
  let current = { ...startWeights };
  let currentLoss = computeLoss(features, current);
  let best = { ...current };
  let bestLoss = currentLoss;
  let temp = ANNEAL_TEMP;

  for (let i = 0; i < ANNEAL_STEPS; i++) {
    // Random perturbation
    const k = Object.keys(current)[Math.floor(Math.random() * Object.keys(current).length)];
    const delta = (Math.random() - 0.5) * 0.06;
    const proposed = { ...current, [k]: clamp(current[k] + delta, W_BOUNDS[k]?.lo || 0, W_BOUNDS[k]?.hi || 0.55) };
    const proposedLoss = computeLoss(features, proposed);
    const diff = proposedLoss - currentLoss;

    if (diff < 0 || Math.random() < Math.exp(-diff / temp)) {
      current = proposed;
      currentLoss = proposedLoss;
      if (currentLoss < bestLoss) {
        bestLoss = currentLoss;
        best = { ...current };
      }
    }

    temp *= ANNEAL_DECAY;
  }

  return { weights: best, finalLoss: bestLoss };
}

// ─── normalise weights so they sum to 1.0 ─────────────────────────────────────
function normaliseWeights(weights) {
  const sum = Object.values(weights).reduce((s, v) => s + Math.max(0, v), 0);
  if (sum === 0) return { ...DEFAULT_W };
  const normalised = {};
  for (const [k, v] of Object.entries(weights)) {
    normalised[k] = r4(Math.max(0, v) / sum);
  }
  return normalised;
}

// ─── top-level run ─────────────────────────────────────────────────────────────
/**
 * Run the full optimization cycle.
 *
 * @param {Array} snapshots — from learning.getSnapshots()
 * @returns {object} optimization results + audit entry
 */
async function runSignalOptimizer(snapshots) {
  console.log(`\n[optimizer] ═══════════════════════════════════════`);
  console.log(`[optimizer] Starting signal optimization`);
  console.log(`[optimizer] Total snapshots: ${snapshots.length}`);

  ensureDir();

  const allFeatures = snapshots.map(extractFeatures).filter(Boolean);
  const signalFeatures = allFeatures.filter(f => f.signals !== null);

  console.log(`[optimizer] Graded features: ${allFeatures.length}`);
  console.log(`[optimizer] With signal data: ${signalFeatures.length}`);

  if (allFeatures.length < MIN_SAMPLES) {
    const msg = `Need ${MIN_SAMPLES} graded snapshots (have ${allFeatures.length})`;
    console.log(`[optimizer] ${msg}`);
    return { ran: false, reason: msg };
  }

  // Use signal features if we have enough, otherwise fall back to all features
  const workingFeatures = signalFeatures.length >= MIN_SIGNAL_SAMPLES
    ? signalFeatures : allFeatures;

  console.log(`[optimizer] Working with ${workingFeatures.length} features`);

  // ── Load current weights ────────────────────────────────────────────────────
  const currentWeights = loadWeights(SIGNAL_W_FILE, DEFAULT_W);

  // ── Baseline accuracy with current weights ─────────────────────────────────
  const baseline = computeAccuracy(workingFeatures, currentWeights);
  console.log(`[optimizer] Baseline accuracy: ${(baseline.overall * 100).toFixed(1)}% overall | ${baseline.betNow != null ? (baseline.betNow * 100).toFixed(1) + "% bet-now" : "n/a bet-now"}`);

  // ── Phase 1: Adam gradient descent ────────────────────────────────────────
  console.log(`[optimizer] Phase 1: Adam gradient descent...`);
  const adamResult = runAdam(workingFeatures, currentWeights);

  // ── Phase 2: Simulated annealing on Adam's best ────────────────────────────
  console.log(`[optimizer] Phase 2: Simulated annealing...`);
  const annealResult = runAnnealing(workingFeatures, adamResult.weights);

  // Pick whichever phase won
  const bestRaw = annealResult.finalLoss <= adamResult.finalLoss
    ? annealResult.weights : adamResult.weights;

  // ── Normalise weights to sum to 1.0 ───────────────────────────────────────
  const optimizedWeights = normaliseWeights(bestRaw);

  // ── Measure new accuracy ───────────────────────────────────────────────────
  const optimized = computeAccuracy(workingFeatures, optimizedWeights);
  console.log(`[optimizer] Optimized accuracy: ${(optimized.overall * 100).toFixed(1)}% overall | ${optimized.betNow != null ? (optimized.betNow * 100).toFixed(1) + "% bet-now" : "n/a bet-now"}`);

  // ── Validate improvement ───────────────────────────────────────────────────
  const improvement = (optimized.overall || 0) - (baseline.overall || 0);
  const meetsTarget  = (optimized.overall || 0) >= TARGET_ACCURACY_LOW;
  const notOverfit   = (optimized.overall || 0) <= TARGET_ACCURACY_HIGH;

  const shouldSave = improvement >= MIN_IMPROVEMENT && meetsTarget && notOverfit;

  if (shouldSave) {
    saveWeights(SIGNAL_W_FILE, optimizedWeights, {
      samples:          workingFeatures.length,
      baselineAccuracy: baseline.overall,
      optimizedAccuracy: optimized.overall,
      improvement:      r4(improvement),
      betNowAccuracy:   optimized.betNow,
    });
    console.log(`[optimizer] ✓ Signal weights saved! Accuracy: ${(baseline.overall*100).toFixed(1)}% → ${(optimized.overall*100).toFixed(1)}%`);

    // Reload in stats_model
    try { require("./stats_model").reloadSignalWeights(); }
    catch { /* stats_model not loaded yet, that's fine */ }
  } else {
    const reason = !meetsTarget
      ? `Accuracy ${(optimized.overall*100).toFixed(1)}% below ${(TARGET_ACCURACY_LOW*100).toFixed(0)}% target`
      : !notOverfit
      ? `Accuracy ${(optimized.overall*100).toFixed(1)}% suggests overfitting`
      : `Improvement ${(improvement*100).toFixed(2)}% below ${(MIN_IMPROVEMENT*100).toFixed(2)}% threshold`;
    console.log(`[optimizer] Not saving: ${reason}`);
  }

  // ── Weight change report ───────────────────────────────────────────────────
  const changes = {};
  for (const [k, v] of Object.entries(optimizedWeights)) {
    const prev = currentWeights[k] || DEFAULT_W[k] || 0;
    changes[k] = { from: r4(prev), to: r4(v), delta: r4(v - prev) };
  }
  const topMovers = Object.entries(changes)
    .sort((a, b) => Math.abs(b[1].delta) - Math.abs(a[1].delta))
    .slice(0, 5);

  console.log(`[optimizer] Top weight changes:`);
  for (const [k, c] of topMovers) {
    console.log(`  ${k.padEnd(22)} ${(c.from*100).toFixed(1)}% → ${(c.to*100).toFixed(1)}%  (${c.delta >= 0 ? "+" : ""}${(c.delta*100).toFixed(1)}%)`);
  }

  // ── By-edge-bucket report ──────────────────────────────────────────────────
  console.log(`[optimizer] Accuracy by edge bucket:`);
  for (const [bk, bv] of Object.entries(optimized.byEdgeBucket)) {
    if (bv.total >= 3) {
      const pct = bv.accuracy != null ? (bv.accuracy*100).toFixed(1)+"%" : "—";
      console.log(`  ${bk.padEnd(8)} ${pct} (n=${bv.total})`);
    }
  }

  // ── Audit entry ───────────────────────────────────────────────────────────
  const auditEntry = {
    ran:             true,
    saved:           shouldSave,
    samples:         workingFeatures.length,
    baseline:        baseline,
    optimized:       optimized,
    improvement:     r4(improvement),
    topChanges:      Object.fromEntries(topMovers),
    finalWeights:    shouldSave ? optimizedWeights : currentWeights,
    meetsTarget,
    notOverfit,
  };
  saveAudit(auditEntry);

  return auditEntry;
}

// ─── standalone backtesting against BDL historical games ──────────────────────
/**
 * Run a quick self-test against all graded snapshots to report current accuracy.
 * Does NOT train — just measures.
 */
function runAccuracyReport(snapshots) {
  const allF = snapshots.map(extractFeatures).filter(Boolean);
  const sigF  = allF.filter(f => f.signals !== null);

  if (allF.length === 0) return { error: "No graded snapshots" };

  const weights = loadWeights(SIGNAL_W_FILE, DEFAULT_W);
  const overall  = computeAccuracy(allF, weights);
  const byMode   = {};

  for (const f of allF) {
    const mode = f.mode || "unknown";
    if (!byMode[mode]) byMode[mode] = [];
    byMode[mode].push(f);
  }

  const modeAccuracy = {};
  for (const [mode, mf] of Object.entries(byMode)) {
    modeAccuracy[mode] = computeAccuracy(mf, weights);
  }

  // Verdict accuracy
  const byVerdict = {};
  for (const f of allF) {
    const v = f.verdict || "unknown";
    if (!byVerdict[v]) byVerdict[v] = [];
    byVerdict[v].push(f);
  }
  const verdictAccuracy = {};
  for (const [v, vf] of Object.entries(byVerdict)) {
    const acc = computeAccuracy(vf, weights);
    verdictAccuracy[v] = { accuracy: acc.overall, samples: vf.length };
  }

  return {
    overall,
    modeAccuracy,
    verdictAccuracy,
    signalSamples:   sigF.length,
    totalSamples:    allF.length,
    currentWeights:  weights,
    defaultWeights:  DEFAULT_W,
    usingLearned:    JSON.stringify(weights) !== JSON.stringify(DEFAULT_W),
  };
}

// ─── standalone entry point ───────────────────────────────────────────────────
if (require.main === module) {
  const learning = require("./learning");
  const snaps    = learning.getSnapshots();

  console.log("\n[optimizer] Running standalone...");

  // If --report flag, just show accuracy without training
  if (process.argv.includes("--report")) {
    const report = runAccuracyReport(snaps);
    console.log("\n═══ ACCURACY REPORT ═══");
    console.log(`Overall:  ${report.overall?.overall != null ? (report.overall.overall*100).toFixed(1)+"%" : "n/a"}`);
    console.log(`Bet Now:  ${report.overall?.betNow != null ? (report.overall.betNow*100).toFixed(1)+"%" : "n/a"}`);
    console.log(`Samples:  ${report.totalSamples} total, ${report.signalSamples} with signals`);
    console.log("\nBy verdict:");
    for (const [v,a] of Object.entries(report.verdictAccuracy||{})) {
      console.log(`  ${v.padEnd(12)} ${a.accuracy!=null?(a.accuracy*100).toFixed(1)+"%":"—"}  (n=${a.samples})`);
    }
    console.log("\nBy edge bucket:");
    for (const [b,a] of Object.entries(report.overall?.byEdgeBucket||{})) {
      if (a.total>=3) console.log(`  ${b.padEnd(8)} ${a.accuracy!=null?(a.accuracy*100).toFixed(1)+"%":"—"}  (n=${a.total})`);
    }
    process.exit(0);
  }

  runSignalOptimizer(snaps)
    .then(r => {
      console.log(`\n[optimizer] Done. Saved: ${r.saved}, Accuracy: ${r.optimized?.overall != null ? (r.optimized.overall*100).toFixed(1)+"%" : "n/a"}`);
      process.exit(0);
    })
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { runSignalOptimizer, runAccuracyReport, computeAccuracy, extractFeatures };
