"use strict";

/**
 * prop_model.js
 *
 * Independent player prop prediction engine.
 *
 * For each prop (player + stat type + line from sportsbook):
 *   1. Fetch rich player stats via player_stats.js
 *   2. Build 9 independent prediction features
 *   3. Weighted sigmoid → over probability
 *   4. Compare to sportsbook implied prob for edge
 *   5. Weights improve automatically via prop_learning.js
 *
 * Stat types supported:
 *   points | rebounds | assists | pra | blocks | steals | threes | turnovers
 */

const fs   = require("fs");
const path = require("path");
const { buildPlayerProfile } = require("./player_stats");

const WEIGHTS_FILE = path.join(__dirname, "data", "prop_weights.json");

// ─── Default feature weights (sum to ~1) ─────────────────────────────────────
// These will be overwritten by learned weights after enough graded games
const DEFAULT_W = {
  seasonAvgDelta:  0.25,  // (season_avg - line) relative to line — most stable signal
  l5AvgDelta:      0.22,  // recent 5 games average vs line — hot/cold streaks
  l10AvgDelta:     0.13,  // 10 game average vs line — medium term form
  hitRate5:        0.12,  // % of last 5 games hit over — direct hit rate
  hitRate10:       0.09,  // % of last 10 games hit over
  vsOppDelta:      0.06,  // historical performance vs this specific opponent
  locationSplit:   0.05,  // home/away advantage for this stat
  minsTrend:       0.05,  // more minutes recently = more stat opportunities
  consistency:     0.03,  // low variance = more predictable outcome
};

const WEIGHT_BOUNDS = {
  seasonAvgDelta: { lo: 0.05, hi: 0.60 },
  l5AvgDelta:     { lo: 0.05, hi: 0.55 },
  l10AvgDelta:    { lo: 0.02, hi: 0.40 },
  hitRate5:       { lo: 0.02, hi: 0.35 },
  hitRate10:      { lo: 0.01, hi: 0.25 },
  vsOppDelta:     { lo: 0.00, hi: 0.20 },
  locationSplit:  { lo: 0.00, hi: 0.20 },
  minsTrend:      { lo: 0.00, hi: 0.20 },
  consistency:    { lo: 0.00, hi: 0.15 },
};

let PROP_W = { ...DEFAULT_W };

function reloadPropWeights() {
  try {
    if (!fs.existsSync(WEIGHTS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(WEIGHTS_FILE, "utf8"));
    if (raw?.weights && Object.keys(raw.weights).length >= 5) {
      PROP_W = { ...DEFAULT_W, ...raw.weights };
      console.log("[prop_model] Loaded learned weights");
    }
  } catch {}
}
reloadPropWeights();
setInterval(reloadPropWeights, 30 * 60 * 1000);

// ─── Math ─────────────────────────────────────────────────────────────────────
const clamp   = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sigmoid = x => 1 / (1 + Math.exp(-clamp(x, -50, 50)));
const r4 = n => (typeof n === "number" && Number.isFinite(n)) ? Math.round(n * 10000) / 10000 : null;
const r2 = n => (typeof n === "number" && Number.isFinite(n)) ? Math.round(n * 100) / 100 : null;
const flt = (v, fb = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };

// ─── Feature builder ──────────────────────────────────────────────────────────
// All features are centred at 0 — positive = bullish for OVER
function buildFeatures(profile) {
  const { seasonAvg, l5Avg, l10Avg, vsOppAvg, hitRate5, hitRate10,
          homeAvg, awayAvg, l5StdDev, l10StdDev, minsTrend, line } = profile;

  const safeLine = Math.max(line || 1, 0.5);

  // Delta features: (avg - line) / line
  // If avg > line by 20%, feature = +0.20 → bullish for over
  const seasonDelta = seasonAvg != null ? (seasonAvg - safeLine) / safeLine : 0;
  const l5Delta     = l5Avg    != null ? (l5Avg    - safeLine) / safeLine : 0;
  const l10Delta    = l10Avg   != null ? (l10Avg   - safeLine) / safeLine : 0;
  const oppDelta    = vsOppAvg != null && vsOppAvg > 0
                      ? (vsOppAvg - safeLine) / safeLine
                      : 0;

  // Hit rate centred at 0.5 — positive = tends to go over
  const hr5  = hitRate5  != null ? hitRate5  - 0.5 : 0;
  const hr10 = hitRate10 != null ? hitRate10 - 0.5 : 0;

  // Location split: if home avg >> away avg, positive = home advantage
  const locSplit = (homeAvg != null && awayAvg != null && safeLine > 0)
    ? (homeAvg - awayAvg) / safeLine
    : 0;

  // Minutes trend: >1.0 means player is playing more recently
  const minsBoost = flt(minsTrend, 1.0) - 1.0;

  // Consistency: low std dev relative to line = more predictable
  // Negative because we subtract from score — high variance = less signal
  const stdDev  = flt(l5StdDev ?? l10StdDev, safeLine * 0.25);
  const consScore = -Math.min(stdDev / safeLine, 1.0); // always 0 or negative

  return {
    seasonAvgDelta: clamp(seasonDelta,  -1.5, 1.5),
    l5AvgDelta:     clamp(l5Delta,      -1.5, 1.5),
    l10AvgDelta:    clamp(l10Delta,     -1.5, 1.5),
    hitRate5:       clamp(hr5,          -0.5, 0.5),
    hitRate10:      clamp(hr10,         -0.5, 0.5),
    vsOppDelta:     clamp(oppDelta,     -1.0, 1.0),
    locationSplit:  clamp(locSplit,     -0.6, 0.6),
    minsTrend:      clamp(minsBoost,    -0.5, 0.5),
    consistency:    clamp(consScore,    -1.0, 0.0),
  };
}

// ─── Prediction ───────────────────────────────────────────────────────────────
function predictOverProb(features, weights) {
  const w = weights || PROP_W;
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [k, feat] of Object.entries(features)) {
    const wt = flt(w[k], 0);
    weightedSum += feat * wt;
    totalWeight += Math.abs(wt);
  }

  // Scale factor: 1.0 unit of weighted avg → meaningful probability shift
  // 6.0 scale means 1.0 weighted delta → sigmoid(6) = 0.998 (very confident)
  // In practice most deltas are 0.1-0.3, giving meaningful but not extreme shifts
  const SCALE = 5.5;
  const scaledScore = totalWeight > 0 ? (weightedSum / totalWeight) * SCALE : 0;

  return clamp(sigmoid(scaledScore), 0.04, 0.96);
}

// ─── Confidence calculation ───────────────────────────────────────────────────
function buildConfidence(overProb, profile, bookOverProb) {
  // How far from 50/50 is our prediction
  const edge = Math.abs(overProb - 0.5);

  // Data quality score — having all sources = more reliable
  let dataQuality = 0;
  if (profile.l5Avg     != null) dataQuality += 0.04;
  if (profile.l10Avg    != null) dataQuality += 0.03;
  if (profile.homeAvg   != null) dataQuality += 0.02;
  if (profile.vsOppAvg  != null) dataQuality += 0.02;
  if (profile.hitRate5  != null) dataQuality += 0.02;
  if (profile.hitRate10 != null) dataQuality += 0.01;

  // Consistency bonus — predictable player = more confidence
  const stdDev = profile.l5StdDev || (Math.abs((profile.l5Avg || profile.line) - profile.line) * 1.5);
  const consistencyBonus = profile.line > 0
    ? Math.max(0, 0.04 - (stdDev / profile.line) * 0.04)
    : 0;

  // Agreement bonus — if multiple signals agree
  const agreementBonus = edge > 0.15 ? 0.03 : edge > 0.10 ? 0.01 : 0;

  // AI vs book agreement bonus — when our model agrees with the book
  const bookAgreement = bookOverProb != null
    ? ((overProb > 0.5) === (bookOverProb > 0.5) ? 0.02 : -0.01)
    : 0;

  const rawConf = 0.50 + edge + dataQuality + consistencyBonus + agreementBonus + bookAgreement;
  const finalConf = clamp(rawConf, 0.50, 0.93);

  let label = "Low";
  if (finalConf >= 0.75) label = "High";
  else if (finalConf >= 0.62) label = "Medium";

  return {
    percent:    r4(finalConf),
    label,
    edge:       r4(edge),
    dataQuality: r4(dataQuality),
  };
}

// ─── Verdict builder ──────────────────────────────────────────────────────────
function buildVerdict(pickProb, confidence, aiEdgeVsBook) {
  const strong  = pickProb >= 0.65 && (confidence.label === "High"   || confidence.label === "Medium");
  const medium  = pickProb >= 0.58 && confidence.label !== "Low";
  const hasEdge = typeof aiEdgeVsBook === "number" && Math.abs(aiEdgeVsBook) >= 0.05;

  if (strong && hasEdge) return "Bet now";
  if (strong || (medium && hasEdge)) return "Watch";
  return "Skip";
}

// ─── Main single prediction ───────────────────────────────────────────────────
async function predictProp(playerName, statType, line, opponentTeam = null, bookOverProb = null) {
  if (!playerName || line == null) {
    return { player: playerName, statType, line, pick: null, error: "Missing input" };
  }

  try {
    const profile = await buildPlayerProfile(playerName, statType, line, opponentTeam);

    if (!profile) {
      return {
        player: playerName, statType, line,
        pick: null, overProb: 0.5,
        confidence: { label: "Low", percent: 0.5, edge: 0 },
        error: "Player not found in database",
      };
    }

    const features   = buildFeatures(profile);
    const overProb   = predictOverProb(features, PROP_W);
    const pick       = overProb >= 0.5 ? "over" : "under";
    const pickProb   = overProb >= 0.5 ? overProb : 1 - overProb;
    const confidence = buildConfidence(overProb, profile, bookOverProb);

    // Edge vs what sportsbook implies
    const aiEdgeVsBook = bookOverProb != null ? overProb - bookOverProb : null;
    const verdict      = buildVerdict(pickProb, confidence, aiEdgeVsBook);

    console.log(
      `[prop_model] ${playerName} ${statType} ${line}: ${pick.toUpperCase()} ` +
      `${(pickProb * 100).toFixed(1)}% | conf=${confidence.label} | ${verdict}`
    );

    return {
      player:       playerName,
      playerId:     profile.player?.id,
      statType,
      line,
      // AI prediction
      pick,
      overProb:     r4(overProb),
      pickProb:     r4(pickProb),
      confidence,
      verdict,
      // Edge vs sportsbook
      aiEdgeVsBook: aiEdgeVsBook != null ? r4(aiEdgeVsBook) : null,
      // Player profile summary
      profile: {
        seasonAvg:  profile.seasonAvg,
        l5Avg:      profile.l5Avg,
        l10Avg:     profile.l10Avg,
        vsOppAvg:   profile.vsOppAvg,
        hitRate5:   profile.hitRate5  != null ? r4(profile.hitRate5)  : null,
        hitRate10:  profile.hitRate10 != null ? r4(profile.hitRate10) : null,
        homeAvg:    profile.homeAvg,
        awayAvg:    profile.awayAvg,
        l5StdDev:   profile.l5StdDev,
        minsTrend:  r4(profile.minsTrend),
        statValues: profile.statValues?.slice(0, 5),
      },
      // Raw features for learning
      features: Object.fromEntries(
        Object.entries(features).map(([k, v]) => [k, r4(v)])
      ),
    };
  } catch (e) {
    console.error("[prop_model] predictProp error:", e.message);
    return {
      player: playerName, statType, line,
      pick: null, overProb: 0.5,
      confidence: { label: "Low", percent: 0.5 },
      error: e.message,
    };
  }
}

// ─── Bulk predictions for a game ─────────────────────────────────────────────
// Takes propSections from the sportsbook, enhances with AI predictions
async function predictGameProps(propSections, homeTeam = null, awayTeam = null) {
  const statMap = {
    points:   "points",
    assists:  "assists",
    rebounds: "rebounds",
    pra:      "pra",
  };

  const results = {};

  for (const [section, statType] of Object.entries(statMap)) {
    const rows = (propSections[section] || []).slice(0, 8);
    if (!rows.length) { results[section] = []; continue; }

    // Run predictions concurrently
    const predictions = await Promise.allSettled(
      rows.map(row =>
        predictProp(row.player, statType, row.line, null, row.hitProbability)
      )
    );

    results[section] = rows.map((bookRow, i) => {
      const pred = predictions[i].status === "fulfilled" ? predictions[i].value : null;

      if (!pred || !pred.pick) {
        return {
          ...bookRow,
          aiPick:        null,
          aiPickProb:    null,
          aiConfidence:  null,
          aiVerdict:     "Skip",
          dataAvailable: false,
        };
      }

      // Book implied over probability (de-vigged)
      const bookOverProb = bookRow.hitProbability || 0.5;
      const aiEdge = r4(pred.overProb - bookOverProb);

      return {
        // Sportsbook fields
        player:       bookRow.player,
        line:         bookRow.line,
        overDecimal:  bookRow.overDecimal,
        overAmerican: bookRow.overAmerican,
        bookOverProb: r4(bookOverProb),
        coverage:     bookRow.coverage,
        // AI prediction
        aiPick:       pred.pick,
        aiOverProb:   pred.overProb,
        aiPickProb:   pred.pickProb,
        aiConfidence: pred.confidence,
        aiVerdict:    pred.verdict,
        aiEdge,
        // Profile context
        profile:      pred.profile,
        features:     pred.features,
        playerId:     pred.playerId,
        dataAvailable: pred.error == null,
        error:        pred.error || null,
      };
    });
  }

  return results;
}

module.exports = {
  predictProp,
  predictGameProps,
  buildFeatures,
  predictOverProb,
  buildConfidence,
  reloadPropWeights,
  DEFAULT_PROP_WEIGHTS: DEFAULT_W,
  WEIGHT_BOUNDS,
  getPropWeights: () => PROP_W,
};
