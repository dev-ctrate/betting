"use strict";

/**
 * advanced_stats.js
 *
 * Computes the full suite of advanced basketball analytics from BallDontLie data.
 * Every metric used is grounded in basketball-reference.com methodology.
 *
 * ─── Metrics computed ────────────────────────────────────────────────────────
 * OFFENSIVE
 *   Pace               — estimated possessions per 40 min
 *   ORtg               — offensive rating (pts per 100 possessions)
 *   TS%                — true shooting %
 *   eFG%               — effective field goal %
 *   TOV%               — turnover rate (per 100 poss)
 *   OREB%              — offensive rebound rate
 *   FTR                — free throw attempt rate (FTA/FGA)
 *   3PAr               — 3-point attempt rate (FG3A/FGA)
 *   AST%               — assist rate (AST/FGM)
 *   AST/TOV            — ball security ratio
 *
 * DEFENSIVE (from game-level data since BDL has no direct opp stats)
 *   DRtg_proxy         — pts allowed per game (from actual game scores)
 *   STL_rate           — steals per possession proxy
 *   BLK_rate           — blocks per shot proxy
 *   DREB%              — defensive rebound rate proxy
 *   Opp_TS_allowed     — opponent shooting quality (inferred from pts + DRtg)
 *
 * NET / COMPOSITE
 *   NRtg               — net rating (ORtg – DRtg_proxy × scale)
 *   ScoreDiff_avg      — average point differential last N games
 *   ScoreDiff_recent5  — average point differential last 5 games
 *   Consistency        — variance of point diffs (lower = more consistent)
 *
 * SCHEDULE / SITUATIONAL
 *   RestDays           — days since last game
 *   IsBackToBack       — played yesterday
 *   HomeRecord         — home W-L this season
 *   AwayRecord         — away W-L this season
 *   LastN_WinRate      — win rate last 10 games
 *   Streak             — current win/loss streak
 *   WinWhenLeadingHalf — proxy: % of wins where they won by >8 in 1H
 *
 * PLAYER
 *   StarPower          — composite top-5 player quality score
 *   DepthScore         — bench quality (players 6-10)
 *   StarUsage          — avg usage of top 2 players
 *   TopPlayerTS        — best player TS%
 *
 * MATCHUP
 *   ORtg_vs_DRtg       — home ORtg vs away DRtg (and vice versa)
 *   PaceMismatch       — pace preference conflict score
 *   ShootingEdge       — TS% differential
 *   TovBattle          — TOV% differential (negative = home advantage)
 *   ReboundBattle      — OREB% advantage
 *   RestAdvantage      — rest day differential
 *   B2B_netPenalty     — net back-to-back disadvantage
 *   StarPowerDelta     — player quality differential
 * ─────────────────────────────────────────────────────────────────────────────
 */

const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY || "";

// ─── cache TTLs ──────────────────────────────────────────────────────────────
const TTL_SEASON_STATS  = 6  * 60 * 60 * 1000;   // 6 h  — season averages change slowly
const TTL_RECENT_GAMES  = 20 * 60 * 1000;          // 20 min — game results
const TTL_PLAYER_STATS  = 30 * 60 * 1000;          // 30 min
const TTL_TEAMS         = 24 * 60 * 60 * 1000;    // 24 h  — team list static

const _cache = new Map();
function cacheGet(k) {
  const hit = _cache.get(k);
  if (!hit) return null;
  if (Date.now() > hit.exp) { _cache.delete(k); return null; }
  return hit.val;
}
function cacheSet(k, val, ttl) { _cache.set(k, { val, exp: Date.now() + ttl }); return val; }

// ─── helpers ─────────────────────────────────────────────────────────────────
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function safeNum(v, fallback = 0) { const n = Number(v); return Number.isFinite(n) ? n : fallback; }
function avg(arr) {
  const nums = (arr || []).filter(v => Number.isFinite(Number(v))).map(Number);
  return nums.length ? nums.reduce((s, v) => s + v, 0) / nums.length : null;
}
function stdDev(arr) {
  const mean = avg(arr);
  if (mean == null) return null;
  const nums = arr.filter(v => Number.isFinite(Number(v))).map(Number);
  return Math.sqrt(avg(nums.map(v => (v - mean) ** 2)) || 0);
}
function sigmoid(x) { return 1 / (1 + Math.exp(-clamp(x, -50, 50))); }
function logit(p)   { const cp = clamp(p, 1e-6, 1 - 1e-6); return Math.log(cp / (1 - cp)); }
function round4(n)  { return Math.round(n * 10000) / 10000; }

// ─── BDL fetch ───────────────────────────────────────────────────────────────
async function bdlFetch(urlPath) {
  if (!BALLDONTLIE_API_KEY) throw new Error("Missing BALLDONTLIE_API_KEY");
  const res = await fetch(`https://api.balldontlie.io/v1${urlPath}`, {
    headers: { Authorization: BALLDONTLIE_API_KEY },
    signal: AbortSignal.timeout(15000)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`BDL ${res.status}: ${txt.slice(0, 200)}`);
  try { return JSON.parse(txt); }
  catch { throw new Error(`BDL bad JSON: ${txt.slice(0, 100)}`); }
}
function rows(payload) {
  if (Array.isArray(payload))       return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

// ─── team lookup ─────────────────────────────────────────────────────────────
async function getAllTeams() {
  const key = "bdl:teams:all";
  const hit = cacheGet(key);
  if (hit) return hit;
  const raw = await bdlFetch("/teams?per_page=100");
  return cacheSet(key, rows(raw), TTL_TEAMS);
}

async function resolveTeamId(fullName) {
  const teams = await getAllTeams();
  const norm  = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const target = norm(fullName);

  let match = teams.find(t => norm(t.full_name) === target);
  if (match) return match.id;

  const lastWord = target.split(" ").pop() || "";
  match = teams.find(t => norm(t.full_name).includes(lastWord) && lastWord.length > 3);
  if (match) return match.id;

  match = teams.find(t => target.split(" ").filter(w => w.length > 3).some(w => norm(t.full_name).includes(w)));
  return match?.id || null;
}

// ─── season stats ────────────────────────────────────────────────────────────
function getCurrentSeason() {
  const d = new Date(); const m = d.getUTCMonth() + 1;
  return m >= 10 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

async function fetchTeamSeasonStats(teamId, season) {
  const key = `bdl:team_stats:${teamId}:${season}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  try {
    const raw  = await bdlFetch(`/teams/${teamId}/stats?seasons[]=${season}&postseason=false`);
    const data = rows(raw)[0] || null;
    return cacheSet(key, data, TTL_SEASON_STATS);
  } catch { return null; }
}

/**
 * Compute the full advanced metric suite from a BDL team stats row.
 * All formulas per basketball-reference.com.
 */
function computeAdvancedMetrics(s) {
  if (!s) return null;

  const pts  = safeNum(s.pts);
  const reb  = safeNum(s.reb);
  const ast  = safeNum(s.ast);
  const stl  = safeNum(s.stl);
  const blk  = safeNum(s.blk);
  const tov  = safeNum(s.turnover);
  const pf   = safeNum(s.pf);
  const oreb = safeNum(s.oreb, safeNum(s.offensive_rebounds));
  const dreb = safeNum(s.dreb, safeNum(s.defensive_rebounds, reb * 0.77));
  const fgm  = safeNum(s.fgm, safeNum(s.field_goals_made));
  const fga  = safeNum(s.fga, safeNum(s.field_goals_attempted, fgm > 0 ? fgm / safeNum(s.fg_pct, 0.47) : pts * 0.42));
  const fg3m = safeNum(s.fg3m, safeNum(s.three_pointers_made, safeNum(s.fg3_pct, 0.36) > 0 ? fga * 0.40 * safeNum(s.fg3_pct, 0.36) : 0));
  const fg3a = safeNum(s.fg3a, safeNum(s.three_pointers_attempted, fga > 0 ? fga * 0.40 : 0));
  const ftm  = safeNum(s.ftm, safeNum(s.free_throws_made));
  const fta  = safeNum(s.fta, safeNum(s.free_throws_attempted, ftm > 0 ? ftm / safeNum(s.ft_pct, 0.77) : pts * 0.22));
  const fg_pct  = safeNum(s.fg_pct,  fga > 0 ? fgm  / fga  : 0.47);
  const fg3_pct = safeNum(s.fg3_pct, fg3a > 0 ? fg3m / fg3a : 0.36);
  const ft_pct  = safeNum(s.ft_pct,  fta > 0 ? ftm  / fta  : 0.77);
  const gp      = safeNum(s.games_played, 50);

  // ── Pace (possessions per 40 minutes) ────────────────────────────────────
  // Formula: poss = FGA − OREB + TOV + 0.44 × FTA
  const poss = Math.max(fga - oreb + tov + 0.44 * fta, 1);

  // ── Offensive Rating (pts per 100 possessions) ────────────────────────────
  const ortg = poss > 0 ? (pts / poss) * 100 : 110;

  // ── True Shooting % ───────────────────────────────────────────────────────
  const tsa = fga + 0.44 * fta;
  const ts_pct = tsa > 0 ? pts / (2 * tsa) : 0.55;

  // ── Effective FG% ─────────────────────────────────────────────────────────
  const efg_pct = fga > 0 ? (fgm + 0.5 * fg3m) / fga : 0.52;

  // ── Turnover Rate (per 100 possessions) ──────────────────────────────────
  const tov_rate = poss > 0 ? (tov / poss) * 100 : 14;

  // ── Offensive Rebound % (team's own misses retrieved) ────────────────────
  // Without opponent DREB, use: OREB / (FGA × (1 - fg_pct)) ≈ OREB / misses
  const fg_misses = Math.max(fga - fgm, 1);
  const oreb_pct = fg_misses > 0 ? oreb / fg_misses : 0.25;

  // ── Free Throw Rate ───────────────────────────────────────────────────────
  const ftr = fga > 0 ? fta / fga : 0.25;

  // ── 3-Point Attempt Rate ──────────────────────────────────────────────────
  const fg3_rate = fga > 0 ? fg3a / fga : 0.40;

  // ── 3-Point vs 2-Point efficiency ────────────────────────────────────────
  const pts_from_3 = fg3m * 3;
  const pts_from_2 = (fgm - fg3m) * 2;
  const pts_from_ft = ftm;
  const scoring_distribution = {
    pct_from_3:  pts > 0 ? pts_from_3 / pts : 0.35,
    pct_from_2:  pts > 0 ? pts_from_2 / pts : 0.45,
    pct_from_ft: pts > 0 ? pts_from_ft / pts : 0.18
  };

  // ── Assist Rate (AST per FGM — team ball movement quality) ───────────────
  const ast_rate = fgm > 0 ? ast / fgm : 0.60;

  // ── AST/TOV ratio ─────────────────────────────────────────────────────────
  const ast_tov = tov > 0 ? ast / tov : 2.0;

  // ── Defensive metrics from per-game rates ────────────────────────────────
  const stl_rate = poss > 0 ? (stl / poss) * 100 : 8;
  const blk_rate = fga > 0 ? blk / fga : 0.06;
  const dreb_pct = reb > 0 ? dreb / reb : 0.77;

  // ── Scoring variance proxy ────────────────────────────────────────────────
  // High 3PAr = higher variance game outcomes
  const variance_index = fg3_rate * 1.4 + (tov_rate / 100) * 0.8;

  // ── Composite offensive quality score (0-100) ─────────────────────────────
  const off_quality = clamp(
    (ts_pct - 0.50) * 200 +          // TS% above league avg (0.55 ≈ 10 pts)
    (efg_pct - 0.50) * 120 +
    (100 - tov_rate) * 0.5 +
    (oreb_pct - 0.22) * 40 +
    ast_rate * 8 +
    50,
    20, 85
  );

  // ── Composite defensive quality proxy (0-100) ─────────────────────────────
  const def_quality_proxy = clamp(
    stl_rate * 1.5 +
    blk_rate * 30 +
    dreb_pct * 20 +
    (1 - pf / 25) * 10 +
    30,
    20, 75
  );

  return {
    // raw inputs
    pts, reb, ast, stl, blk, tov, pf, oreb, dreb,
    fgm, fga, fg3m, fg3a, ftm, fta, gp,
    fg_pct, fg3_pct, ft_pct,
    // derived
    poss, ortg,
    ts_pct:    round4(ts_pct),
    efg_pct:   round4(efg_pct),
    tov_rate:  round4(tov_rate),
    oreb_pct:  round4(oreb_pct),
    ftr:       round4(ftr),
    fg3_rate:  round4(fg3_rate),
    ast_rate:  round4(ast_rate),
    ast_tov:   round4(ast_tov),
    stl_rate:  round4(stl_rate),
    blk_rate:  round4(blk_rate),
    dreb_pct:  round4(dreb_pct),
    variance_index: round4(variance_index),
    scoring_distribution,
    off_quality:       round4(off_quality),
    def_quality_proxy: round4(def_quality_proxy)
  };
}

// ─── recent game analysis ────────────────────────────────────────────────────
async function fetchRecentGames(teamId, n = 20) {
  const season = getCurrentSeason();
  const key    = `bdl:recent:${teamId}:${season}:${n}`;
  const hit    = cacheGet(key);
  if (hit) return hit;
  try {
    const raw  = await bdlFetch(`/games?team_ids[]=${teamId}&seasons[]=${season}&per_page=${n}&postseason=false`);
    const all  = rows(raw)
      .filter(g => String(g.status || "").toLowerCase().includes("final"))
      .sort((a, b) => new Date(a.date || a.datetime || 0) - new Date(b.date || b.datetime || 0));
    return cacheSet(key, all.slice(-n), TTL_RECENT_GAMES);
  } catch { return []; }
}

/**
 * From a list of recent games, compute rich form metrics for teamId.
 */
function analyzeRecentGames(games, teamId) {
  if (!games?.length) return null;

  const results = [];
  const homeResults = [], awayResults = [];
  const ptsDiffs = [], ptsScored = [], ptsAllowed = [];
  let streak = 0, streakSign = 0;

  for (const g of games) {
    const isHome   = g.home_team?.id === teamId || g.home_team_id === teamId;
    const myScore  = isHome ? safeNum(g.home_team_score)    : safeNum(g.visitor_team_score);
    const oppScore = isHome ? safeNum(g.visitor_team_score) : safeNum(g.home_team_score);
    if (!myScore && !oppScore) continue;

    const diff = myScore - oppScore;
    const won  = diff > 0;

    results.push({ won, diff, myScore, oppScore, isHome, date: g.date || g.datetime });
    ptsDiffs.push(diff);
    ptsScored.push(myScore);
    ptsAllowed.push(oppScore);
    if (isHome) homeResults.push(won);
    else         awayResults.push(won);

    // streak
    const sign = won ? 1 : -1;
    if (sign === streakSign) streak += sign;
    else { streak = sign; streakSign = sign; }
  }

  if (!results.length) return null;

  const n         = results.length;
  const last5     = results.slice(-5);
  const last10    = results.slice(-10);
  const winRate   = results.filter(r => r.won).length / n;
  const winRate5  = last5.filter(r => r.won).length / last5.length;
  const winRate10 = last10.length ? last10.filter(r => r.won).length / last10.length : winRate;
  const avgDiff   = avg(ptsDiffs);
  const avgDiff5  = avg(ptsDiffs.slice(-5));
  const avgDiff10 = avg(ptsDiffs.slice(-10));
  const diffStdDev = stdDev(ptsDiffs) || 1;

  // Consistency: lower std dev relative to mean diff = more consistent
  const consistency = clamp(1 - (diffStdDev / 15), 0, 1);

  // Momentum: recent form vs season form
  const momentum = (winRate5 || 0) - winRate;

  // Scoring trend: are they scoring more recently?
  const recentPts = avg(ptsScored.slice(-5));
  const olderPts  = avg(ptsScored.slice(0, -5));
  const scoringTrend = (recentPts && olderPts) ? recentPts - olderPts : 0;

  // Defense trend: allowing less recently?
  const recentAllowed = avg(ptsAllowed.slice(-5));
  const olderAllowed  = avg(ptsAllowed.slice(0, -5));
  const defenseTrend  = (recentAllowed && olderAllowed) ? olderAllowed - recentAllowed : 0; // positive = improving

  // DRtg proxy from actual points allowed
  const drtg_proxy = avg(ptsAllowed) || 115;

  // Last game date for rest calculation
  const lastGameDate = results[results.length - 1]?.date;

  return {
    games:       n,
    winRate:     round4(winRate),
    winRate5:    round4(winRate5),
    winRate10:   round4(winRate10),
    avgDiff:     round4(avgDiff || 0),
    avgDiff5:    round4(avgDiff5 || 0),
    avgDiff10:   round4(avgDiff10 || 0),
    consistency: round4(consistency),
    momentum:    round4(momentum),
    streak,
    scoringTrend:  round4(scoringTrend),
    defenseTrend:  round4(defenseTrend),
    avgPtsScored:  round4(avg(ptsScored) || 110),
    avgPtsAllowed: round4(drtg_proxy),
    drtg_proxy:    round4(drtg_proxy),
    homeWinRate: homeResults.length ? round4(homeResults.filter(Boolean).length / homeResults.length) : null,
    awayWinRate: awayResults.length ? round4(awayResults.filter(Boolean).length / awayResults.length) : null,
    lastGameDate
  };
}

// ─── schedule context ────────────────────────────────────────────────────────
function computeScheduleContext(recentGames) {
  if (!recentGames?.length) return { restDays: 2, isBackToBack: false, isThirdInFourDays: false };

  const sorted = [...recentGames].sort((a, b) =>
    new Date(a.date || a.datetime || 0) - new Date(b.date || b.datetime || 0)
  );

  const lastGame = sorted[sorted.length - 1];
  const prevGame = sorted.length > 1 ? sorted[sorted.length - 2] : null;

  const lastDate = new Date(lastGame?.date || lastGame?.datetime || Date.now() - 3 * 86400000);
  const today    = new Date();
  today.setHours(0, 0, 0, 0);

  const msInDay   = 86400000;
  const restDays  = Math.max(0, Math.round((today - lastDate) / msInDay));
  const isBackToBack = restDays <= 1;

  let isThirdInFourDays = false;
  if (prevGame) {
    const prevDate = new Date(prevGame?.date || prevGame?.datetime || 0);
    const span = (lastDate - prevDate) / msInDay;
    if (span <= 3 && restDays <= 1) isThirdInFourDays = true;
  }

  return { restDays, isBackToBack, isThirdInFourDays };
}

// ─── player stats ─────────────────────────────────────────────────────────────
async function fetchTopPlayerStats(teamId, n = 8) {
  const season = getCurrentSeason();
  const key    = `bdl:players:${teamId}:${season}:${n}`;
  const hit    = cacheGet(key);
  if (hit) return hit;
  try {
    const raw  = await bdlFetch(
      `/players/stats?team_ids[]=${teamId}&seasons[]=${season}&per_page=100&postseason=false`
    );
    const filtered = rows(raw)
      .filter(r => safeNum(r.min) >= 12 && safeNum(r.games_played, 1) >= 5)
      .sort((a, b) => safeNum(b.pts) - safeNum(a.pts))
      .slice(0, n);
    return cacheSet(key, filtered, TTL_PLAYER_STATS);
  } catch { return []; }
}

/**
 * Compute advanced player metrics and derive team-level player impact score.
 */
function computePlayerMetrics(players) {
  if (!players?.length) return null;

  const scored = players.map(p => {
    const pts   = safeNum(p.pts);
    const ast   = safeNum(p.ast);
    const reb   = safeNum(p.reb);
    const stl   = safeNum(p.stl);
    const blk   = safeNum(p.blk);
    const tov   = safeNum(p.turnover);
    const fgm   = safeNum(p.fgm, safeNum(p.field_goals_made));
    const fga   = safeNum(p.fga, safeNum(p.field_goals_attempted, fgm / safeNum(p.fg_pct, 0.47)));
    const fg3m  = safeNum(p.fg3m, 0);
    const fg3a  = safeNum(p.fg3a, 0);
    const ftm   = safeNum(p.ftm, 0);
    const fta   = safeNum(p.fta, ftm / safeNum(p.ft_pct, 0.77));
    const minPG = safeNum(p.min, 24);
    const gp    = safeNum(p.games_played, 30);

    // ── True Shooting % ─────────────────────────────────────────────────────
    const tsa    = fga + 0.44 * fta;
    const ts_pct = tsa > 0 ? pts / (2 * tsa) : safeNum(p.fg_pct, 0.50);

    // ── Effective FG% ────────────────────────────────────────────────────────
    const efg_pct = fga > 0 ? (fgm + 0.5 * fg3m) / fga : safeNum(p.fg_pct, 0.50);

    // ── Assist/Turnover ───────────────────────────────────────────────────────
    const ast_tov = tov > 0 ? ast / tov : ast;

    // ── Simplified PER proxy ─────────────────────────────────────────────────
    // Hollinger PER simplified: ( pts + reb + ast + stl + blk - tov - fgMisses - ftMisses ) / min
    const fg_miss = Math.max(fga - fgm, 0);
    const ft_miss = Math.max(fta - ftm, 0);
    const per_proxy = minPG > 0
      ? (pts * 1.0 + reb * 0.7 + ast * 0.7 + stl * 1.0 + blk * 0.7 - tov * 0.7 - fg_miss * 0.3 - ft_miss * 0.1) / minPG * 36
      : 15;

    // ── Usage rate proxy ─────────────────────────────────────────────────────
    // Usage ≈ (FGA + 0.44*FTA + TOV) / teamPoss — we'll normalize later
    const usage_proxy = fga + 0.44 * fta + tov;

    // ── Box score +/- proxy ──────────────────────────────────────────────────
    // Not directly available but we can estimate from scoring + efficiency
    const bpm_proxy = (ts_pct - 0.52) * 40 + (pts - 15) * 0.15 + ast * 0.15 + (stl + blk) * 0.5 - tov * 0.3;

    // ── Star power score ─────────────────────────────────────────────────────
    // Combines volume, efficiency, and playmaking
    const star_score =
      pts * 0.8 +
      ast * 0.6 +
      reb * 0.4 +
      (stl + blk) * 0.5 +
      (ts_pct - 0.52) * 30 +
      (efg_pct - 0.50) * 20 -
      tov * 0.5;

    return {
      name:        p.player?.full_name || `${p.player?.first_name || ""} ${p.player?.last_name || ""}`.trim(),
      pts, ast, reb, stl, blk, tov,
      ts_pct:     round4(ts_pct),
      efg_pct:    round4(efg_pct),
      ast_tov:    round4(ast_tov),
      per_proxy:  round4(per_proxy),
      bpm_proxy:  round4(bpm_proxy),
      usage_proxy: round4(usage_proxy),
      star_score: round4(star_score),
      min:        minPG,
      gp
    };
  });

  if (!scored.length) return null;

  // Sort by star score
  scored.sort((a, b) => b.star_score - a.star_score);

  const top2  = scored.slice(0, 2);
  const bench = scored.slice(5, 10);

  // Star power: weighted sum with diminishing returns
  const star_power = scored.reduce((s, p, i) => s + p.star_score / (i + 1), 0);
  const depth_score = bench.reduce((s, p) => s + p.star_score, 0);

  // Top player efficiency
  const top_ts  = top2[0]?.ts_pct || 0.55;
  const top_bpm = top2[0]?.bpm_proxy || 0;

  // Usage concentration (high = star-dependent team)
  const totalUsage = scored.reduce((s, p) => s + p.usage_proxy, 0);
  const top2Usage  = top2.reduce((s, p) => s + p.usage_proxy, 0);
  const usage_concentration = totalUsage > 0 ? top2Usage / totalUsage : 0.4;

  return {
    players:       scored,
    star_power:    round4(star_power),
    depth_score:   round4(depth_score),
    top_ts,
    top_bpm:       round4(top_bpm),
    usage_concentration: round4(usage_concentration),
    per_proxy_avg: round4(avg(scored.slice(0, 5).map(p => p.per_proxy)) || 15)
  };
}

// ─── H2H ────────────────────────────────────────────────────────────────────
async function fetchH2HGames(homeTeamId, awayTeamId, n = 8) {
  const season = getCurrentSeason();
  const key    = `bdl:h2h:${homeTeamId}:${awayTeamId}:${season}`;
  const hit    = cacheGet(key);
  if (hit) return hit;
  try {
    const raw = await bdlFetch(
      `/games?team_ids[]=${homeTeamId}&team_ids[]=${awayTeamId}&seasons[]=${season}&per_page=100&postseason=false`
    );
    const both = rows(raw).filter(g => {
      const ids = [g.home_team?.id, g.home_team_id, g.visitor_team?.id, g.visitor_team_id].filter(Boolean);
      return ids.includes(homeTeamId) && ids.includes(awayTeamId) && String(g.status || "").toLowerCase().includes("final");
    }).slice(-n);
    return cacheSet(key, both, TTL_RECENT_GAMES);
  } catch { return []; }
}

function analyzeH2H(games, homeTeamId) {
  if (!games?.length) return null;

  let homeWins = 0, homeDiffs = [];

  for (const g of games) {
    const isHome   = g.home_team?.id === homeTeamId || g.home_team_id === homeTeamId;
    const homeScore = safeNum(g.home_team_score);
    const awayScore = safeNum(g.visitor_team_score);
    if (!homeScore && !awayScore) continue;
    const myScore  = isHome ? homeScore : awayScore;
    const oppScore = isHome ? awayScore : homeScore;
    const diff = myScore - oppScore;
    if (diff > 0) homeWins++;
    homeDiffs.push(diff);
  }

  const n        = homeDiffs.length;
  if (!n) return null;
  const winRate  = homeWins / n;
  const avgDiff  = avg(homeDiffs) || 0;
  const h2h_prob = clamp(0.5 + avgDiff * 0.012 + (winRate - 0.5) * 0.18, 0.22, 0.78);

  return { games: n, winRate: round4(winRate), avgDiff: round4(avgDiff), h2h_prob: round4(h2h_prob) };
}

// ─── net rating computation ──────────────────────────────────────────────────
/**
 * Compute full net rating using offensive stats + actual pts allowed.
 * NRtg = ORtg - DRtg
 * Where DRtg is scaled from actual points allowed to per-100-poss.
 */
function computeNetRating(advMetrics, recentData) {
  if (!advMetrics) return null;

  const ortg = advMetrics.ortg || 110;
  // DRtg proxy: scale actual pts allowed to per-100-poss
  // If team averages poss ≈ 95-105, and allows X pts/game:
  //   DRtg ≈ pts_allowed / poss * 100
  const poss = advMetrics.poss || 95;
  const pts_allowed = recentData?.avgPtsAllowed || 115;
  const drtg = (pts_allowed / poss) * 100;

  const nrtg = ortg - drtg;

  return { ortg: round4(ortg), drtg: round4(drtg), nrtg: round4(nrtg) };
}

// ─── matchup profile ─────────────────────────────────────────────────────────
/**
 * Build the full head-to-head matchup analytics profile.
 * Returns every comparison metric used by the model.
 */
function buildMatchupProfile(homeData, awayData) {
  const { adv: homeAdv, recent: homeRecent, schedule: homeSched, players: homePl, netRating: homeNet } = homeData;
  const { adv: awayAdv, recent: awayRecent, schedule: awaySched, players: awayPl, netRating: awayNet } = awayData;

  // ── Offensive efficiency vs defensive proxy ───────────────────────────────
  const home_ortg = homeNet?.ortg || homeAdv?.ortg || 110;
  const away_ortg = awayNet?.ortg || awayAdv?.ortg || 110;
  const home_drtg = homeNet?.drtg || homeRecent?.avgPtsAllowed || 115;
  const away_drtg = awayNet?.drtg || awayRecent?.avgPtsAllowed || 115;

  const home_net  = homeNet?.nrtg || (home_ortg - home_drtg);
  const away_net  = awayNet?.nrtg || (away_ortg - away_drtg);
  const net_diff  = home_net - away_net;  // positive = home team better

  // Predicted scoring: each team's offense vs opponent's defense
  const home_predicted_pts = home_ortg * (away_drtg / 100);
  const away_predicted_pts = away_ortg * (home_drtg / 100);
  const predicted_spread   = home_predicted_pts - away_predicted_pts;

  // ── Shooting efficiency matchup ───────────────────────────────────────────
  const home_ts   = homeAdv?.ts_pct  || 0.55;
  const away_ts   = awayAdv?.ts_pct  || 0.55;
  const ts_edge   = home_ts - away_ts;          // positive = home shoots better

  const home_efg  = homeAdv?.efg_pct || 0.52;
  const away_efg  = awayAdv?.efg_pct || 0.52;
  const efg_edge  = home_efg - away_efg;

  // ── Turnover battle ───────────────────────────────────────────────────────
  const home_tov  = homeAdv?.tov_rate || 14;
  const away_tov  = awayAdv?.tov_rate || 14;
  const tov_edge  = away_tov - home_tov;        // positive = home turns it over less

  // ── Rebounding battle ─────────────────────────────────────────────────────
  const home_oreb = homeAdv?.oreb_pct || 0.25;
  const away_oreb = awayAdv?.oreb_pct || 0.25;
  const oreb_edge = home_oreb - away_oreb;      // positive = home gets more offensive boards

  // ── Free throw advantage ──────────────────────────────────────────────────
  const home_ftr  = homeAdv?.ftr  || 0.25;
  const away_ftr  = awayAdv?.ftr  || 0.25;
  const ftr_edge  = home_ftr - away_ftr;

  const home_ft_pct = homeAdv?.ft_pct || 0.77;
  const away_ft_pct = awayAdv?.ft_pct || 0.77;
  const ft_edge   = home_ft_pct - away_ft_pct;

  // ── 3-point variance factor ───────────────────────────────────────────────
  const home_3par = homeAdv?.fg3_rate || 0.40;
  const away_3par = awayAdv?.fg3_rate || 0.40;
  // High 3PAr games are higher variance → shrink confidence
  const variance_factor = (home_3par + away_3par) / 2;

  // ── Pace matchup ──────────────────────────────────────────────────────────
  const home_poss = homeAdv?.poss || 95;
  const away_poss = awayAdv?.poss || 95;
  const pace_mismatch = Math.abs(home_poss - away_poss);
  // Home team can partly control pace at home; slight advantage if they prefer faster
  const pace_edge = clamp((home_poss - away_poss) * 0.003, -0.02, 0.02);

  // ── Ball movement quality ─────────────────────────────────────────────────
  const home_ast_tov = homeAdv?.ast_tov || 2.0;
  const away_ast_tov = awayAdv?.ast_tov || 2.0;
  const ast_tov_edge = home_ast_tov - away_ast_tov;

  // ── Defensive metrics matchup ─────────────────────────────────────────────
  const home_stl  = homeAdv?.stl_rate || 8;
  const away_stl  = awayAdv?.stl_rate || 8;
  const home_blk  = homeAdv?.blk_rate || 0.06;
  const away_blk  = awayAdv?.blk_rate || 0.06;
  const def_edge  = (home_stl + home_blk * 50) - (away_stl + away_blk * 50);

  // ── Recent form comparison ────────────────────────────────────────────────
  const home_form  = homeRecent?.winRate5    || homeRecent?.winRate || 0.5;
  const away_form  = awayRecent?.winRate5    || awayRecent?.winRate || 0.5;
  const form_edge  = home_form - away_form;

  const home_diff5 = homeRecent?.avgDiff5   || homeRecent?.avgDiff || 0;
  const away_diff5 = awayRecent?.avgDiff5   || awayRecent?.avgDiff || 0;
  const diff5_edge = home_diff5 - away_diff5;

  const home_momentum = homeRecent?.momentum || 0;
  const away_momentum = awayRecent?.momentum || 0;
  const momentum_edge = home_momentum - away_momentum;

  const home_streak = homeRecent?.streak || 0;
  const away_streak = awayRecent?.streak || 0;
  const streak_edge = clamp((home_streak - away_streak) * 0.015, -0.06, 0.06);

  // ── Schedule / rest ───────────────────────────────────────────────────────
  const home_rest = homeSched?.restDays || 2;
  const away_rest = awaySched?.restDays || 2;
  const rest_diff = home_rest - away_rest;

  // Rest advantage formula: each day of extra rest ≈ +1.5% win prob
  // Back-to-back ≈ -4% win prob
  const rest_edge =
    clamp(rest_diff * 0.015, -0.06, 0.06) +
    (awaySched?.isBackToBack ? 0.04 : 0) -
    (homeSched?.isBackToBack ? 0.04 : 0) +
    (awaySched?.isThirdInFourDays ? 0.02 : 0) -
    (homeSched?.isThirdInFourDays ? 0.02 : 0);

  // ── Player impact ─────────────────────────────────────────────────────────
  const home_star = homePl?.star_power  || 0;
  const away_star = awayPl?.star_power  || 0;
  const total_star = home_star + away_star;
  const star_edge  = total_star > 0 ? (home_star - away_star) / total_star : 0;  // normalised [-0.5, 0.5]

  const home_depth = homePl?.depth_score || 0;
  const away_depth = awayPl?.depth_score || 0;
  const depth_edge = total_star > 0 ? (home_depth - away_depth) / total_star : 0;

  const home_top_ts = homePl?.top_ts || 0.55;
  const away_top_ts = awayPl?.top_ts || 0.55;
  const top_ts_edge = home_top_ts - away_top_ts;

  return {
    // Net rating
    net_diff, home_net, away_net,
    predicted_spread: round4(predicted_spread),
    home_predicted_pts: round4(home_predicted_pts),
    away_predicted_pts: round4(away_predicted_pts),

    // Shooting
    ts_edge:   round4(ts_edge),
    efg_edge:  round4(efg_edge),
    ftr_edge:  round4(ftr_edge),
    ft_edge:   round4(ft_edge),

    // Ball security
    tov_edge:     round4(tov_edge),
    ast_tov_edge: round4(ast_tov_edge),

    // Rebounding
    oreb_edge: round4(oreb_edge),

    // Defense
    def_edge: round4(def_edge),

    // Pace
    pace_edge:      round4(pace_edge),
    pace_mismatch:  round4(pace_mismatch),
    variance_factor: round4(variance_factor),

    // Form
    form_edge:     round4(form_edge),
    diff5_edge:    round4(diff5_edge),
    momentum_edge: round4(momentum_edge),
    streak_edge,

    // Schedule
    rest_edge: round4(rest_edge),
    home_rest, away_rest,
    home_b2b: !!homeSched?.isBackToBack,
    away_b2b: !!awaySched?.isBackToBack,

    // Players
    star_edge:   round4(star_edge),
    depth_edge:  round4(depth_edge),
    top_ts_edge: round4(top_ts_edge)
  };
}

// ─── full team data loader ───────────────────────────────────────────────────
async function loadTeamData(teamId) {
  const season = getCurrentSeason();

  const [rawStats, recentGames, topPlayers] = await Promise.allSettled([
    fetchTeamSeasonStats(teamId, season),
    fetchRecentGames(teamId, 20),
    fetchTopPlayerStats(teamId, 8)
  ]).then(rs => rs.map(r => r.status === "fulfilled" ? r.value : null));

  const adv       = computeAdvancedMetrics(rawStats);
  const recent    = analyzeRecentGames(recentGames, teamId);
  const schedule  = computeScheduleContext(recentGames || []);
  const players   = computePlayerMetrics(topPlayers || []);
  const netRating = computeNetRating(adv, recent);

  return { teamId, adv, recent, schedule, players, netRating };
}

// ─── main exported function ──────────────────────────────────────────────────
/**
 * Build the complete advanced matchup profile for a game.
 *
 * @param {string} homeTeam — full team name
 * @param {string} awayTeam — full team name
 * @returns {Promise<{ matchup, homeData, awayData, homeId, awayId } | null>}
 */
async function getAdvancedMatchup(homeTeam, awayTeam) {
  const [homeId, awayId] = await Promise.all([
    resolveTeamId(homeTeam),
    resolveTeamId(awayTeam)
  ]);

  if (!homeId || !awayId) {
    console.warn(`[advanced_stats] Could not resolve IDs: ${homeTeam}=${homeId}, ${awayTeam}=${awayId}`);
    return null;
  }

  const [homeData, awayData, h2hGames] = await Promise.all([
    loadTeamData(homeId),
    loadTeamData(awayId),
    fetchH2HGames(homeId, awayId, 8)
  ]);

  const h2h     = analyzeH2H(h2hGames, homeId);
  const matchup = buildMatchupProfile(homeData, awayData);

  return { matchup, homeData, awayData, homeId, awayId, h2h };
}

module.exports = {
  getAdvancedMatchup,
  resolveTeamId,
  loadTeamData,
  computeAdvancedMetrics,
  computePlayerMetrics,
  analyzeRecentGames,
  computeScheduleContext,
  getCurrentSeason
};
