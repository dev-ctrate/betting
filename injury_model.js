"use strict";

/**
 * injury_model.js
 *
 * Computes injury-adjusted offensive/defensive ratings.
 *
 * Without this, the model treats a team missing Giannis the same as a full-
 * strength Bucks — the single biggest accuracy gap in the previous version.
 *
 * Algorithm:
 *   For each injured player:
 *     1. Find on/off split data (how team performs with/without them)
 *     2. Apply severity multiplier (OUT=1.0, DOUBTFUL=0.80, QUESTIONABLE=0.40)
 *     3. Adjust team ORtg/DRtg by: (on_rating - off_rating) × min_fraction × severity × shrinkage
 *
 *   If no on/off data: fall back to USG% × PIE estimate
 *   Shrinkage factor (0.70) prevents overcorrection on small samples
 */

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function safeNum(v, fb = 0) { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function round2(n) { return Math.round(n * 100) / 100; }
function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

// ─── severity weights ─────────────────────────────────────────────────────────
const SEVERITY = {
  "out":              1.00,
  "out for season":   1.00,
  "doubtful":         0.80,
  "questionable":     0.40,
  "gtd":              0.50,   // game-time decision
  "day-to-day":       0.30,
  "probable":         0.12,
  "available":        0.00,
};

function getSeverity(injuryRow) {
  const text = JSON.stringify(injuryRow || "").toLowerCase();
  for (const [keyword, factor] of Object.entries(SEVERITY)) {
    if (text.includes(keyword)) return factor;
  }
  return 0.35; // unknown → conservative estimate
}

// ─── player name matching ─────────────────────────────────────────────────────
function namesMatch(a, b) {
  const na = normName(a);
  const nb = normName(b);
  if (na === nb) return true;
  // Partial match: last name or first+last partial
  const partsA = na.split(" ");
  const partsB = nb.split(" ");
  if (partsA.length > 1 && partsB.length > 1) {
    return partsA[partsA.length - 1] === partsB[partsB.length - 1] &&
           (partsA[0][0] === partsB[0][0]); // same last name + same first initial
  }
  return false;
}

function findOnOffData(onOffList, playerName) {
  if (!Array.isArray(onOffList) || !playerName) return null;
  return onOffList.find(r => namesMatch(r.player_name || "", playerName)) || null;
}

function findPlayerStats(playerList, playerName) {
  if (!Array.isArray(playerList) || !playerName) return null;
  return playerList.find(p => namesMatch(p.name || "", playerName)) || null;
}

function extractPlayerName(injuryRow) {
  if (!injuryRow) return "";
  for (const k of ["playerName","PlayerName","name","Name","player","full_name"]) {
    if (typeof injuryRow[k] === "string" && injuryRow[k].length > 2) return injuryRow[k];
  }
  if (injuryRow.player && typeof injuryRow.player === "object") {
    const fn = injuryRow.player.first_name || "";
    const ln = injuryRow.player.last_name  || "";
    if (fn || ln) return `${fn} ${ln}`.trim();
  }
  return "";
}

// ─── on/off based adjustment (most accurate) ─────────────────────────────────
function adjustFromOnOff(onOffEntry, severity) {
  const SHRINK = 0.72; // regression to mean — prevents overcorrection on small samples

  // Impact = how much better team is WITH this player on court vs off court
  // Positive on_net vs off_net means player helps the team
  const ortgImpact = safeNum(onOffEntry.ortg_impact) * severity * SHRINK;
  const drtgImpact = safeNum(onOffEntry.drtg_impact) * severity * SHRINK;
  const netImpact  = safeNum(onOffEntry.net_impact)  * severity * SHRINK;

  // When player is OUT, team's offense drops by ortgImpact, defense worsens
  return {
    ortg_delta: -ortgImpact,              // losing player hurts offense
    drtg_delta: drtgImpact > 0 ? drtgImpact : 0,  // losing good defender hurts defense
    net_delta:  -netImpact,
    method:     "on_off_split",
    confidence: "high"
  };
}

// ─── PIE/USG based estimate (fallback when no on/off data) ───────────────────
function adjustFromPlayerStats(playerStats, teamStats, severity) {
  const SHRINK = 0.55; // more shrinkage for estimates vs actual splits

  const usg        = safeNum(playerStats.usg_pct, 0.20);
  const minFrac    = clamp(safeNum(playerStats.min, 20) / 240, 0.05, 0.50);
  const playerPIE  = safeNum(playerStats.pie, 0.10);
  const teamPIE    = safeNum(teamStats.pie, 0.50);
  const playerOrtg = safeNum(playerStats.off_rtg || playerStats.off_rating, teamStats.off_rating);
  const playerDrtg = safeNum(playerStats.def_rtg || playerStats.def_rating, teamStats.def_rating);
  const teamOrtg   = safeNum(teamStats.off_rating, 108);
  const teamDrtg   = safeNum(teamStats.def_rating, 112);

  // Offensive contribution: how much above/below average is this player's offense
  const ortgContrib = (playerOrtg - teamOrtg) * usg * minFrac;
  // Defensive contribution: positive if player's DRtg is better (lower) than team's
  const drtgContrib = (teamDrtg - playerDrtg) * (1 - usg) * minFrac * 0.6;

  // PIE cross-check: sanity bound the adjustment
  const pieBonus    = (playerPIE - teamPIE / 5) * 12 * minFrac;
  const clampedAdj  = clamp(ortgContrib * 0.5 + pieBonus * 0.5, -8, 8);

  return {
    ortg_delta: -(clampedAdj * severity * SHRINK),
    drtg_delta: (drtgContrib < 0 ? Math.abs(drtgContrib) : 0) * severity * SHRINK,
    net_delta:  -(clampedAdj * severity * SHRINK),
    method:     "usg_pie_estimate",
    confidence: "medium"
  };
}

// ─── main export ──────────────────────────────────────────────────────────────
/**
 * Compute injury-adjusted team ratings.
 *
 * @param {object} teamStats       — from advanced_stats merged data (off_rating, def_rating, net_rating, pie, etc.)
 * @param {Array}  injuredPlayers  — array of injury rows from BDL
 * @param {Array}  onOffData       — array from nba_service.py on/off endpoint
 * @returns {{ adjusted_ortg, adjusted_drtg, adjusted_net, baseline_net, total_impact, adjustments, significant }}
 */
function computeInjuryImpact(teamStats, injuredPlayers, onOffData) {
  const baseOrtg = safeNum(teamStats?.off_rating, 108);
  const baseDrtg = safeNum(teamStats?.def_rating, 112);
  const baseNet  = baseOrtg - baseDrtg;

  if (!injuredPlayers?.length) {
    return {
      adjusted_ortg: baseOrtg,
      adjusted_drtg: baseDrtg,
      adjusted_net:  baseNet,
      baseline_net:  baseNet,
      total_impact:  0,
      adjustments:   [],
      significant:   false
    };
  }

  let ortg = baseOrtg;
  let drtg  = baseDrtg;
  const adjustments = [];

  for (const injuryRow of injuredPlayers) {
    const playerName = extractPlayerName(injuryRow);
    if (!playerName) continue;

    const severity = getSeverity(injuryRow);
    if (severity < 0.05) continue; // probable barely matters

    // Try on/off data first (most accurate)
    const onOff = findOnOffData(onOffData, playerName);

    let adj;
    if (onOff && Math.abs(safeNum(onOff.net_impact)) > 0.1) {
      adj = adjustFromOnOff(onOff, severity);
    } else {
      // Fall back to player stats estimate
      const playerStat = findPlayerStats(teamStats?.players, playerName);
      if (!playerStat) {
        adjustments.push({
          player: playerName,
          severity,
          ortg_delta: 0,
          drtg_delta: 0,
          net_delta: 0,
          method: "no_data",
          confidence: "low"
        });
        continue;
      }
      adj = adjustFromPlayerStats(playerStat, teamStats, severity);
    }

    ortg = clamp(ortg + adj.ortg_delta, 90, 130);
    drtg = clamp(drtg + adj.drtg_delta, 95, 125);

    adjustments.push({
      player:      playerName,
      severity:    round2(severity),
      ortg_delta:  round2(adj.ortg_delta),
      drtg_delta:  round2(adj.drtg_delta),
      net_delta:   round2(adj.net_delta),
      method:      adj.method,
      confidence:  adj.confidence
    });
  }

  const totalImpact = adjustments.reduce((s, a) => s + Math.abs(a.net_delta || 0), 0);
  const adjustedNet = ortg - drtg;

  return {
    adjusted_ortg: round2(ortg),
    adjusted_drtg: round2(drtg),
    adjusted_net:  round2(adjustedNet),
    baseline_net:  round2(baseNet),
    net_change:    round2(adjustedNet - baseNet),
    total_impact:  round2(totalImpact),
    adjustments,
    significant:   totalImpact > 1.5,  // > 1.5 pts/100poss is meaningful
    playerCount:   adjustments.filter(a => a.method !== "no_data").length
  };
}

/**
 * Compute team-specific home court advantage from game log splits.
 * Returns a logit-space bump (replacing fixed 0.112 for all teams).
 */
function computeTeamHCA(homeFormData) {
  const LEAGUE_AVG_HCA_LOGIT = 0.112;    // NBA average ~+2.8% at p=0.50
  const MIN_GAMES = 8;                   // need this many games to trust split

  const homeWR = safeNum(homeFormData?.home_win_rate, null);
  const awayWR = safeNum(homeFormData?.away_win_rate, null);

  if (homeWR == null || awayWR == null) return LEAGUE_AVG_HCA_LOGIT;

  const homeGames = safeNum(homeFormData?.games, 0) / 2; // rough estimate
  if (homeGames < MIN_GAMES) return LEAGUE_AVG_HCA_LOGIT;

  // Home vs away win rate difference → logit
  const split = clamp(homeWR - awayWR, -0.30, 0.50);
  // Convert to logit space: 0.10 win rate diff ≈ 0.04 logit
  const hcaLogit = split * 0.45;

  // Blend with league average (regression to mean)
  const sampleWeight = clamp(homeGames / 40, 0, 1);
  const blended = LEAGUE_AVG_HCA_LOGIT * (1 - sampleWeight) + hcaLogit * sampleWeight;

  return clamp(blended, 0.04, 0.30); // never < 1% or > 7% advantage
}

module.exports = { computeInjuryImpact, computeTeamHCA, getSeverity, extractPlayerName };
