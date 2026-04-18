/**
 * stats_model.js
 *
 * Fully independent win probability engine.
 * Does NOT use sportsbook odds as an input.
 *
 * Signals used:
 *   1. Offensive / Defensive efficiency ratings (season)
 *   2. Recent form  — last 10 games (W%, point-diff)
 *   3. Head-to-head history (current season)
 *   4. Player impact — top-player usage & scoring share
 *   5. Home-court advantage
 *   6. Home/Away splits
 *   7. Live score-state adjustment (when in-game)
 *
 * Outputs a probability between 0 and 1 that the HOME team wins.
 * Combine with market probability externally to compute edge.
 */

"use strict";

const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY || "";

// ─── constants ────────────────────────────────────────────────────────────────
const HOME_COURT_BOOST   = 0.028;   // ~3 pts → ~2.8% win prob lift
const RECENT_GAMES_N     = 10;
const H2H_GAMES_N        = 5;
const RATING_WEIGHT      = 0.35;
const FORM_WEIGHT        = 0.25;
const H2H_WEIGHT         = 0.10;
const PLAYER_WEIGHT      = 0.15;
const SPLIT_WEIGHT       = 0.15;

const PER_GAME_CACHE_TTL = 6 * 60 * 60 * 1000;   // 6 h  — season stats move slowly
const RECENT_CACHE_TTL   = 20 * 60 * 1000;         // 20 min
const PLAYER_CACHE_TTL   = 30 * 60 * 1000;         // 30 min

// ─── tiny in-process cache ────────────────────────────────────────────────────
const _cache = new Map();

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.exp) { _cache.delete(key); return null; }
  return hit.val;
}
function cacheSet(key, val, ttl) {
  _cache.set(key, { val, exp: Date.now() + ttl });
  return val;
}

// ─── helpers ──────────────────────────────────────────────────────────────────
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function roundTo(n, d = 4) {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
function avg(arr) {
  const nums = arr.filter(v => typeof v === "number" && Number.isFinite(v));
  return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
}
function logit(p) { return Math.log(p / (1 - p)); }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// ─── BallDontLie fetch ─────────────────────────────────────────────────────
async function bdlFetch(path) {
  if (!BALLDONTLIE_API_KEY) throw new Error("Missing BALLDONTLIE_API_KEY");
  const base = "https://api.balldontlie.io/v1";
  const url  = `${base}${path}`;
  const res  = await fetch(url, {
    headers: { Authorization: BALLDONTLIE_API_KEY },
    signal: AbortSignal.timeout(12000)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`BDL ${res.status}: ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); } catch { throw new Error(`BDL bad JSON: ${txt.slice(0, 200)}`); }
}

function normalizeRows(payload) {
  if (Array.isArray(payload))        return payload;
  if (Array.isArray(payload?.data))  return payload.data;
  return [];
}

// ─── Team lookup ─────────────────────────────────────────────────────────────
async function getTeams() {
  const key = "bdl:teams";
  const hit = cacheGet(key);
  if (hit) return hit;
  const raw = await bdlFetch("/teams?per_page=100");
  return cacheSet(key, normalizeRows(raw), PER_GAME_CACHE_TTL);
}

async function findTeamId(fullName) {
  const teams = await getTeams();
  const norm  = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const target = norm(fullName);

  // exact match first
  let match = teams.find(t => norm(t.full_name) === target);
  if (match) return match.id;

  // partial: last word (nickname)
  const lastWord = target.split(" ").pop();
  match = teams.find(t => norm(t.full_name).includes(lastWord));
  if (match) return match.id;

  // partial: any word
  match = teams.find(t => target.split(" ").some(w => norm(t.full_name).includes(w)));
  return match ? match.id : null;
}

// ─── Season stats (offensive / defensive ratings) ────────────────────────────
function getCurrentSeason() {
  const now   = new Date();
  const year  = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  return month >= 10 ? year : year - 1;
}

async function getTeamSeasonStats(teamId, season) {
  const key = `bdl:season:${teamId}:${season}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  try {
    const raw  = await bdlFetch(`/teams/${teamId}/stats?seasons[]=${season}&postseason=false`);
    const rows = normalizeRows(raw);
    return cacheSet(key, rows[0] || null, PER_GAME_CACHE_TTL);
  } catch {
    return null;
  }
}

/**
 * Build a simple offensive/defensive efficiency rating for a team.
 * Returns { offRating, defRating, pace } all in points-per-100-possessions space
 * or null if data unavailable.
 *
 * BallDontLie /teams/:id/stats returns averaged per-game fields including:
 *   pts, fg_pct, fg3_pct, ft_pct, reb, ast, stl, blk, turnover, pf, min
 * We derive pace proxy from reb + ast + turnover as possession estimate.
 */
function buildEfficiencyRating(stats) {
  if (!stats) return null;

  const pts = Number(stats.pts)      || 0;
  const reb = Number(stats.reb)      || 0;
  const ast = Number(stats.ast)      || 0;
  const tov = Number(stats.turnover) || 0;
  const stl = Number(stats.stl)      || 0;
  const blk = Number(stats.blk)      || 0;
  const fgPct  = Number(stats.fg_pct)  || 0;
  const fg3Pct = Number(stats.fg3_pct) || 0;
  const ftPct  = Number(stats.ft_pct)  || 0;

  // Rough possession proxy per game
  const possProxy = Math.max(reb + ast + tov + 1, 1);

  // Offensive efficiency  = pts per possession (scaled to 100)
  const offRating = (pts / possProxy) * 100;

  // Defensive proxy: blocks + steals relative to possession
  const defRating = ((stl + blk) / possProxy) * 100;

  // Shooting quality index (0-1 scale, weighted)
  const shootingIndex = fgPct * 0.5 + fg3Pct * 0.3 + ftPct * 0.2;

  return { offRating, defRating, shootingIndex, pts, reb, ast, tov, possProxy };
}

// ─── Recent form (last N games) ───────────────────────────────────────────────
async function getRecentGames(teamId, n = RECENT_GAMES_N) {
  const key = `bdl:recent:${teamId}:${n}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const season = getCurrentSeason();
  try {
    const raw  = await bdlFetch(
      `/games?team_ids[]=${teamId}&seasons[]=${season}&per_page=${n}&postseason=false`
    );
    const rows = normalizeRows(raw)
      .filter(g => String(g.status || "").toLowerCase().includes("final"))
      .slice(-n);
    return cacheSet(key, rows, RECENT_CACHE_TTL);
  } catch {
    return [];
  }
}

function buildFormSignal(games, teamId) {
  if (!games || !games.length) return null;

  let wins = 0, totalDiff = 0, homeWins = 0, homeGames = 0, awayWins = 0, awayGames = 0;

  for (const g of games) {
    const isHome   = g.home_team?.id === teamId || g.home_team_id === teamId;
    const teamScore = isHome ? g.home_team_score : g.visitor_team_score;
    const oppScore  = isHome ? g.visitor_team_score : g.home_team_score;
    if (typeof teamScore !== "number" || typeof oppScore !== "number") continue;

    const won  = teamScore > oppScore;
    const diff = teamScore - oppScore;

    if (won) wins++;
    totalDiff += diff;

    if (isHome) {
      homeGames++;
      if (won) homeWins++;
    } else {
      awayGames++;
      if (won) awayWins++;
    }
  }

  const n        = games.length;
  const winRate  = wins / n;
  const avgDiff  = totalDiff / n;

  // Normalize avgDiff: ~5 pts per game → 0.1 prob swing
  const diffProb = clamp(0.5 + avgDiff * 0.01, 0.1, 0.9);
  const formProb = (winRate * 0.6 + diffProb * 0.4);

  return {
    winRate,
    avgDiff,
    formProb,
    homeWinRate: homeGames ? homeWins / homeGames : null,
    awayWinRate: awayGames ? awayWins / awayGames : null,
    games: n
  };
}

// ─── Home / Away splits ───────────────────────────────────────────────────────
function buildSplitSignal(homeForm, awayForm) {
  // homeForm: form object for the home team (playing at home)
  // awayForm: form object for the away team (playing away)
  if (!homeForm || !awayForm) return 0.5;

  const homeRate  = homeForm.homeWinRate ?? homeForm.winRate ?? 0.5;
  const awayRate  = awayForm.awayWinRate ?? awayForm.winRate ?? 0.5;
  const total     = homeRate + (1 - awayRate);
  return total / 2;
}

// ─── Head-to-head ─────────────────────────────────────────────────────────────
async function getH2HGames(homeTeamId, awayTeamId, n = H2H_GAMES_N) {
  const key = `bdl:h2h:${homeTeamId}:${awayTeamId}:${n}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const season = getCurrentSeason();
  try {
    // Fetch games involving both teams this season
    const raw  = await bdlFetch(
      `/games?team_ids[]=${homeTeamId}&team_ids[]=${awayTeamId}&seasons[]=${season}&per_page=100&postseason=false`
    );
    const all  = normalizeRows(raw).filter(g =>
      String(g.status || "").toLowerCase().includes("final")
    );

    // Keep only matchups between these two teams
    const h2h = all.filter(g => {
      const ids = [g.home_team?.id, g.home_team_id, g.visitor_team?.id, g.visitor_team_id];
      return ids.includes(homeTeamId) && ids.includes(awayTeamId);
    }).slice(-n);

    return cacheSet(key, h2h, RECENT_CACHE_TTL);
  } catch {
    return [];
  }
}

function buildH2HSignal(h2hGames, homeTeamId) {
  if (!h2hGames || !h2hGames.length) return null;

  let homeWins = 0;
  let homeDiff = 0;

  for (const g of h2hGames) {
    const isHome   = g.home_team?.id === homeTeamId || g.home_team_id === homeTeamId;
    const homeScore = g.home_team_score;
    const awayScore = g.visitor_team_score;
    if (typeof homeScore !== "number" || typeof awayScore !== "number") continue;

    const teamScore = isHome ? homeScore : awayScore;
    const oppScore  = isHome ? awayScore : homeScore;
    const diff      = teamScore - oppScore;

    if (diff > 0) homeWins++;
    homeDiff += diff;
  }

  const n       = h2hGames.length;
  const winRate = homeWins / n;
  const avgDiff = homeDiff / n;
  const h2hProb = clamp(0.5 + avgDiff * 0.01 + (winRate - 0.5) * 0.15, 0.2, 0.8);

  return { winRate, avgDiff, h2hProb, games: n };
}

// ─── Player impact signal ─────────────────────────────────────────────────────
async function getTopPlayerStats(teamId, n = 5) {
  const season = getCurrentSeason();
  const key    = `bdl:players:${teamId}:${season}`;
  const hit    = cacheGet(key);
  if (hit) return hit;

  try {
    const raw  = await bdlFetch(
      `/players/stats?team_ids[]=${teamId}&seasons[]=${season}&per_page=100&postseason=false`
    );
    const rows = normalizeRows(raw)
      .filter(r => (Number(r.min) || 0) >= 10)   // at least 10 mpg
      .sort((a, b) => (Number(b.pts) || 0) - (Number(a.pts) || 0))
      .slice(0, n);
    return cacheSet(key, rows, PLAYER_CACHE_TTL);
  } catch {
    return [];
  }
}

function buildPlayerSignal(homePlayers, awayPlayers) {
  if (!homePlayers.length && !awayPlayers.length) return null;

  function teamScore(players) {
    // Weighted star power: top scorer weighted more
    const pts  = players.map(p => Number(p.pts) || 0);
    const ast  = players.map(p => Number(p.ast) || 0);
    const reb  = players.map(p => Number(p.reb) || 0);
    const fgPct = players.map(p => Number(p.fg_pct) || 0);

    // Approximate "value" per player
    const values = pts.map((p, i) =>
      p * 1.0 + ast[i] * 0.75 + reb[i] * 0.5 + fgPct[i] * 10
    );

    // Apply diminishing returns for top-heavy lineups
    const sorted = values.slice().sort((a, b) => b - a);
    return sorted.reduce((s, v, i) => s + v / (i + 1), 0);
  }

  const homeVal = teamScore(homePlayers);
  const awayVal = teamScore(awayPlayers);
  const total   = homeVal + awayVal;

  if (total === 0) return null;
  return { homeVal, awayVal, playerProb: homeVal / total };
}

// ─── Efficiency matchup signal ────────────────────────────────────────────────
function buildEfficiencyMatchupProb(homeEff, awayEff) {
  if (!homeEff || !awayEff) return null;

  // Offense vs Defense matchup: home offRating vs away defRating
  const homeOffAdv = homeEff.offRating - awayEff.defRating;
  const awayOffAdv = awayEff.offRating - homeEff.defRating;

  // Net advantage in home team's favor
  const netAdv = homeOffAdv - awayOffAdv;

  // Shooting efficiency delta
  const shootDelta = homeEff.shootingIndex - awayEff.shootingIndex;

  // Combine: 1 point of offRating diff ≈ 0.5% win prob
  const effProb = clamp(0.5 + netAdv * 0.004 + shootDelta * 0.3, 0.1, 0.9);

  return { netAdv, shootDelta, effProb };
}

// ─── Live game adjustment ─────────────────────────────────────────────────────
/**
 * Given a live game state, adjust pregame probability using score and time remaining.
 * Uses a simple "win probability model":
 *   - Lead size relative to expected scoring rate for remaining time
 *   - Returns adjusted probability for the currently leading team
 */
function buildLiveAdjustment(pregameHomeProb, liveState) {
  if (!liveState || !liveState.liveFound) return pregameHomeProb;

  const homeScore = Number(liveState.homeScore || 0);
  const awayScore = Number(liveState.awayScore || 0);
  const scoreDiff = homeScore - awayScore;

  const period    = Number(liveState.period || 1);
  const clockSec  = typeof liveState.clockSec === "number"
    ? liveState.clockSec
    : 12 * 60;

  // Total regulation seconds = 4 * 12 * 60 = 2880
  const totalSec    = 4 * 12 * 60;
  const elapsedSec  = clamp((period - 1) * 12 * 60 + (12 * 60 - clockSec), 0, totalSec);
  const remainSec   = clamp(totalSec - elapsedSec, 0, totalSec);
  const progress    = clamp(elapsedSec / totalSec, 0, 1);

  if (progress < 0.03) return pregameHomeProb;   // too early, trust pregame

  // Expected points per second (NBA averages ~100 pts per team per game)
  // Each team scores ~100/2880 pts/sec ≈ 0.0347
  // So remaining scoring ≈ 2 * 100 * (remainSec/2880)
  const ptPerSec     = 100 / 2880;
  const remainPts    = remainSec * ptPerSec * 2;   // both teams combined

  // "Critical number": pts needed vs expected
  // If up by X with Y pts remaining, P(win) for leader
  // Use logistic model: logit(baseProb) + lead_factor
  const leadFactor   = scoreDiff / Math.max(Math.sqrt(remainPts), 1);

  // At progress=1 (game over), leadFactor dominates; at 0 it doesn't
  const blendWeight  = Math.pow(progress, 1.4);

  const logitBase    = logit(clamp(pregameHomeProb, 0.05, 0.95));
  const logitLive    = logitBase + leadFactor * 1.8;

  const liveProb     = sigmoid(logitLive);
  const blended      = pregameHomeProb * (1 - blendWeight) + liveProb * blendWeight;

  return clamp(blended, 0.01, 0.99);
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * computeIndependentWinProb
 *
 * @param {string} homeTeam   - Full team name, e.g. "Boston Celtics"
 * @param {string} awayTeam   - Full team name, e.g. "Miami Heat"
 * @param {object} [liveState] - Optional live game state (from live_tracker)
 * @returns {Promise<{
 *   homeWinProb: number,
 *   signals: object,
 *   meta: object
 * }>}
 */
async function computeIndependentWinProb(homeTeam, awayTeam, liveState = null) {
  // ── 1. Resolve team IDs ──────────────────────────────────────────────────
  const [homeId, awayId] = await Promise.all([
    findTeamId(homeTeam),
    findTeamId(awayTeam)
  ]);

  if (!homeId || !awayId) {
    console.warn(`[stats_model] Could not resolve team IDs: ${homeTeam}=${homeId}, ${awayTeam}=${awayId}`);
    // Fall back to coin flip + home court
    return {
      homeWinProb: 0.5 + HOME_COURT_BOOST,
      signals:     { fallback: true },
      meta:        { homeId, awayId, error: "team_id_not_found" }
    };
  }

  // ── 2. Fetch all data in parallel ─────────────────────────────────────────
  const season = getCurrentSeason();

  const [
    homeStats, awayStats,
    homeRecent, awayRecent,
    h2hGames,
    homePlayers, awayPlayers
  ] = await Promise.allSettled([
    getTeamSeasonStats(homeId, season),
    getTeamSeasonStats(awayId, season),
    getRecentGames(homeId),
    getRecentGames(awayId),
    getH2HGames(homeId, awayId),
    getTopPlayerStats(homeId),
    getTopPlayerStats(awayId)
  ]).then(results => results.map(r => r.status === "fulfilled" ? r.value : null));

  // ── 3. Build individual signals ───────────────────────────────────────────
  const homeEff   = buildEfficiencyRating(homeStats);
  const awayEff   = buildEfficiencyRating(awayStats);
  const effMatch  = buildEfficiencyMatchupProb(homeEff, awayEff);

  const homeForm  = buildFormSignal(homeRecent, homeId);
  const awayForm  = buildFormSignal(awayRecent, awayId);

  const h2hSignal = buildH2HSignal(h2hGames, homeId);

  const playerSig = buildPlayerSignal(
    homePlayers || [],
    awayPlayers || []
  );

  const splitProb = buildSplitSignal(homeForm, awayForm);

  // ── 4. Assemble weighted blend ─────────────────────────────────────────────
  const components = [];

  // Efficiency matchup
  if (effMatch) {
    components.push({ prob: effMatch.effProb, weight: RATING_WEIGHT, label: "efficiency" });
  }

  // Recent form — blend home's formProb vs away's formProb
  if (homeForm && awayForm) {
    const homeFormP = homeForm.formProb;
    const awayFormP = awayForm.formProb;
    const formTotal = homeFormP + awayFormP;
    const formProb  = formTotal > 0 ? homeFormP / formTotal : 0.5;
    components.push({ prob: clamp(formProb, 0.1, 0.9), weight: FORM_WEIGHT, label: "form" });
  } else if (homeForm) {
    components.push({ prob: homeForm.formProb, weight: FORM_WEIGHT * 0.5, label: "form_home_only" });
  }

  // H2H
  if (h2hSignal) {
    components.push({ prob: clamp(h2hSignal.h2hProb, 0.2, 0.8), weight: H2H_WEIGHT, label: "h2h" });
  }

  // Player impact
  if (playerSig) {
    components.push({ prob: clamp(playerSig.playerProb, 0.2, 0.8), weight: PLAYER_WEIGHT, label: "player" });
  }

  // Home/away splits
  if (splitProb !== null) {
    components.push({ prob: clamp(splitProb, 0.2, 0.8), weight: SPLIT_WEIGHT, label: "splits" });
  }

  // If we have zero components, return informed coin flip
  if (!components.length) {
    const fallback = clamp(0.5 + HOME_COURT_BOOST, 0.4, 0.65);
    return {
      homeWinProb: fallback,
      signals:     { fallback: true },
      meta:        { homeId, awayId, season }
    };
  }

  // Weighted average in logit space (better than linear for probabilities)
  let logitSum    = 0;
  let weightSum   = 0;

  for (const c of components) {
    const safeP  = clamp(c.prob, 0.01, 0.99);
    logitSum    += logit(safeP) * c.weight;
    weightSum   += c.weight;
  }

  let statsHomeProb = sigmoid(logitSum / weightSum);

  // Add home court advantage as additive logit bump
  statsHomeProb = sigmoid(logit(clamp(statsHomeProb, 0.01, 0.99)) + logit(0.5 + HOME_COURT_BOOST) - logit(0.5));
  statsHomeProb = clamp(statsHomeProb, 0.01, 0.99);

  // ── 5. Live adjustment ────────────────────────────────────────────────────
  let finalProb = statsHomeProb;
  if (liveState && liveState.liveFound) {
    finalProb = buildLiveAdjustment(statsHomeProb, liveState);
  }

  // ── 6. Return ─────────────────────────────────────────────────────────────
  return {
    homeWinProb: roundTo(finalProb, 4),
    pregameHomeProb: roundTo(statsHomeProb, 4),
    signals: {
      efficiency: effMatch ? {
        effProb:    roundTo(effMatch.effProb, 4),
        netAdv:     roundTo(effMatch.netAdv, 2),
        shootDelta: roundTo(effMatch.shootDelta, 4)
      } : null,
      form: homeForm ? {
        home: { winRate: roundTo(homeForm.winRate, 3), avgDiff: roundTo(homeForm.avgDiff, 2) },
        away: awayForm ? { winRate: roundTo(awayForm.winRate, 3), avgDiff: roundTo(awayForm.avgDiff, 2) } : null
      } : null,
      h2h: h2hSignal ? {
        h2hProb: roundTo(h2hSignal.h2hProb, 4),
        winRate: roundTo(h2hSignal.winRate, 3),
        avgDiff: roundTo(h2hSignal.avgDiff, 2),
        games:   h2hSignal.games
      } : null,
      player: playerSig ? {
        playerProb: roundTo(playerSig.playerProb, 4),
        homeVal:    roundTo(playerSig.homeVal, 2),
        awayVal:    roundTo(playerSig.awayVal, 2)
      } : null,
      splits: { splitProb: roundTo(splitProb, 4) },
      homeCourt: HOME_COURT_BOOST,
      liveAdjusted: !!(liveState && liveState.liveFound)
    },
    meta: {
      homeId,
      awayId,
      season,
      componentWeights: components.map(c => ({ label: c.label, weight: c.weight, prob: roundTo(c.prob, 4) }))
    }
  };
}

/**
 * computeEdge
 *
 * Compare independent model probability against sportsbook implied probability
 * to find true edge.
 *
 * @param {number} modelProb   - Independent win prob for pick side
 * @param {number} marketProb  - Sportsbook implied prob (no-vig) for same side
 * @returns {{ edge: number, verdict: string, confidence: string }}
 */
function computeEdge(modelProb, marketProb) {
  const edge = modelProb - marketProb;

  let verdict = "Avoid";
  if (edge >= 0.05)  verdict = "Bet now";
  else if (edge >= 0.025) verdict = "Watch";

  let confidence = "Low";
  if (edge >= 0.08)  confidence = "High";
  else if (edge >= 0.04) confidence = "Medium";

  return {
    edge:       roundTo(edge, 4),
    modelProb:  roundTo(modelProb, 4),
    marketProb: roundTo(marketProb, 4),
    verdict,
    confidence
  };
}

module.exports = {
  computeIndependentWinProb,
  computeEdge,
  buildLiveAdjustment,
  // exposed for testing
  _internals: {
    buildEfficiencyRating,
    buildFormSignal,
    buildH2HSignal,
    buildPlayerSignal,
    buildSplitSignal,
    buildEfficiencyMatchupProb,
    buildLiveAdjustment
  }
};
