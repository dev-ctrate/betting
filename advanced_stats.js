"use strict";

/**
 * advanced_stats.js  v5
 *
 * Data sources (in priority order):
 *   1. BallDontLie API  — ALWAYS available (paid key). Fetches real season stats,
 *                         recent games, H2H, player stats directly.
 *   2. nba_service.py   — Optional Python service. Adds official ORtg/DRtg/PIE/
 *                         clutch/hustle/shot quality when running.
 *
 * The Python service was previously the ONLY source, which caused all stats
 * to fall back to identical defaults when it was offline. Fixed here.
 */

const NBA_URL = process.env.NBA_SERVICE_URL || "http://localhost:5001";
const BDL_KEY = process.env.BALLDONTLIE_API_KEY || "";

// Cache TTLs
const TTL_NBA    = 22 * 60 * 1000;
const TTL_SEASON = 6  * 60 * 60 * 1000;   // season stats change slowly
const TTL_RECENT = 20 * 60 * 1000;
const TTL_PLAYER = 30 * 60 * 1000;
const TTL_TEAM   = 24 * 60 * 60 * 1000;

const _c = new Map();
const cg = k => { const h = _c.get(k); if (!h) return null; if (Date.now() > h.e) { _c.delete(k); return null; } return h.v; };
const cs = (k, v, t) => { _c.set(k, { v, e: Date.now() + t }); return v; };

const sn    = (v, f = 0) => { const n = Number(v); return Number.isFinite(n) ? n : f; };
const r4    = n => Math.round(n * 10000) / 10000;
const r2    = n => Math.round(n * 100) / 100;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const norm  = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const avg   = arr => { const ns = arr.filter(v => Number.isFinite(v)); return ns.length ? ns.reduce((s, v) => s + v, 0) / ns.length : null; };

// ─── BallDontLie fetch ─────────────────────────────────────────────────────────
async function bdlFetch(urlPath) {
  if (!BDL_KEY) throw new Error("Missing BALLDONTLIE_API_KEY");
  const res = await fetch(`https://api.balldontlie.io/v1${urlPath}`, {
    headers: { Authorization: BDL_KEY },
    signal: AbortSignal.timeout(15000)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`BDL ${res.status}: ${txt.slice(0, 100)}`);
  return JSON.parse(txt);
}
const bdlRows = p => Array.isArray(p) ? p : Array.isArray(p?.data) ? p.data : [];

// ─── NBA service fetch (optional) ────────────────────────────────────────────
async function nbaFetch(path, ms = 12000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(`${NBA_URL}${path}`, { signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json();
    } finally { clearTimeout(t); }
  } catch { return null; }
}

async function getNbaMatchup(home, away) {
  const k = `nba:${norm(home)}:${norm(away)}`;
  const h = cg(k); if (h) return h;
  const d = await nbaFetch(`/matchup?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}`);
  if (!d || d.error) return null;
  return cs(k, d, TTL_NBA);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getCurrentSeason() {
  const d = new Date(); const m = d.getUTCMonth() + 1;
  return m >= 10 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

// ─── BDL: Team lookup ─────────────────────────────────────────────────────────
async function getAllTeams() {
  const k = "bdl:teams"; const h = cg(k); if (h) return h;
  try { return cs(k, bdlRows(await bdlFetch("/teams?per_page=100")), TTL_TEAM); }
  catch { return []; }
}

async function resolveTeamId(name) {
  const teams = await getAllTeams();
  const tgt = norm(name);
  let m = teams.find(t => norm(t.full_name) === tgt);
  if (m) return m.id;
  const nick = tgt.split(" ").pop() || "";
  if (nick.length > 3) m = teams.find(t => norm(t.full_name).includes(nick));
  return m?.id || null;
}

// ─── BDL: Season stats (per-game averages) ────────────────────────────────────
async function fetchBdlSeasonStats(teamId, season) {
  const k = `bdl:stats:${teamId}:${season}`;
  const h = cg(k); if (h) return h;
  try {
    const raw = await bdlFetch(`/teams/${teamId}/stats?seasons[]=${season}&postseason=false`);
    const data = bdlRows(raw)[0] || null;
    return cs(k, data, TTL_SEASON);
  } catch (e) {
    console.warn(`[adv_stats] BDL season stats failed for ${teamId}:`, e.message);
    return null;
  }
}

/**
 * Derive advanced metrics from BDL per-game stats.
 * These are real numbers, not defaults.
 */
function computeBdlAdvanced(s) {
  if (!s) return null;

  const pts  = sn(s.pts);
  const reb  = sn(s.reb);
  const ast  = sn(s.ast);
  const stl  = sn(s.stl);
  const blk  = sn(s.blk);
  const tov  = sn(s.turnover);
  const pf   = sn(s.pf);
  const oreb = sn(s.oreb, sn(s.offensive_rebounds));
  const dreb = sn(s.dreb, sn(s.defensive_rebounds, reb * 0.77));
  const fgm  = sn(s.fgm, sn(s.field_goals_made));
  const fga  = sn(s.fga, sn(s.field_goals_attempted, fgm > 0 ? fgm / sn(s.fg_pct, 0.47) : pts * 0.42));
  const fg3m = sn(s.fg3m, 0);
  const fg3a = sn(s.fg3a, fga > 0 ? fga * 0.40 : 0);
  const ftm  = sn(s.ftm, 0);
  const fta  = sn(s.fta, ftm > 0 ? ftm / sn(s.ft_pct, 0.77) : pts * 0.22);
  const fg_pct  = sn(s.fg_pct,  fga > 0 ? fgm  / fga  : 0.47);
  const fg3_pct = sn(s.fg3_pct, fg3a > 0 ? fg3m / fg3a : 0.36);
  const ft_pct  = sn(s.ft_pct,  fta > 0 ? ftm  / fta  : 0.77);
  const gp = sn(s.games_played, sn(s.gp, 40));

  if (pts === 0 && fgm === 0) return null;  // no real data

  // Possession estimate
  const poss = Math.max(fga - oreb + tov + 0.44 * fta, 50);

  // ORtg = pts per 100 possessions
  const ortg = (pts / poss) * 100;

  // TS%
  const tsa = fga + 0.44 * fta;
  const ts_pct = tsa > 0 ? pts / (2 * tsa) : fg_pct * 1.1;

  // eFG%
  const efg_pct = fga > 0 ? (fgm + 0.5 * fg3m) / fga : fg_pct;

  // TOV rate per 100
  const tov_rate = (tov / poss) * 100;

  // OREB%
  const oreb_pct = Math.max(fga - fgm, 1) > 0 ? oreb / Math.max(fga - fgm, 1) : 0.25;

  // FTR, 3PAr
  const ftr     = fga > 0 ? fta / fga : 0.22;
  const fg3_rate = fga > 0 ? fg3a / fga : 0.40;

  // AST/TO
  const ast_to = tov > 0 ? ast / tov : 2.0;

  // STL/BLK rates
  const stl_rate = (stl / poss) * 100;
  const blk_rate = fga > 0 ? blk / fga : 0.06;

  return {
    pts, reb, ast, stl, blk, tov, pf, oreb, dreb,
    fgm, fga, fg3m, fg3a, ftm, fta, gp,
    fg_pct: r4(fg_pct), fg3_pct: r4(fg3_pct), ft_pct: r4(ft_pct),
    poss:     r4(poss),
    ortg:     r4(ortg),
    ts_pct:   r4(ts_pct),
    efg_pct:  r4(efg_pct),
    tov_pct:  r4(tov_rate),   // named tov_pct to match downstream code
    oreb_pct: r4(oreb_pct),
    dreb_pct: r4(dreb > 0 ? dreb / reb : 0.77),
    ftr:      r4(ftr),
    fg3_rate: r4(fg3_rate),
    ast_to:   r4(ast_to),
    stl_rate: r4(stl_rate),
    blk_rate: r4(blk_rate),
    // Estimates for fields the NBA service would normally provide
    net_rating: null,   // computed after DRtg available from game log
    pace:       r4(poss),
    pie:        null,   // PIE needs league data, not available from BDL alone
    w_pct:      sn(s.win_pct, sn(s.w_pct)),
  };
}

// ─── BDL: Recent games ────────────────────────────────────────────────────────
async function fetchRecentGames(teamId, n = 20) {
  const season = getCurrentSeason();
  const k = `bdl:recent:${teamId}:${season}:${n}`;
  const h = cg(k); if (h) return h;
  try {
    const raw = await bdlFetch(
      `/games?team_ids[]=${teamId}&seasons[]=${season}&per_page=${n}&postseason=false`
    );
    const all = bdlRows(raw)
      .filter(g => String(g.status || "").toLowerCase().includes("final"))
      .sort((a, b) => new Date(a.date || a.datetime || 0) - new Date(b.date || b.datetime || 0));
    return cs(k, all.slice(-n), TTL_RECENT);
  } catch (e) {
    console.warn(`[adv_stats] recent games failed:`, e.message);
    return [];
  }
}

function analyzeRecentGames(games, teamId) {
  if (!games?.length) return null;

  const diffs = [], pts_scored = [], pts_allowed = [];
  const homeWL = [], awayWL = [];
  let streak = 0, streakSign = 0;

  for (const g of games) {
    const isHome  = g.home_team?.id === teamId || g.home_team_id === teamId;
    const myScore = isHome ? sn(g.home_team_score) : sn(g.visitor_team_score);
    const opScore = isHome ? sn(g.visitor_team_score) : sn(g.home_team_score);
    if (!myScore && !opScore) continue;

    const diff = myScore - opScore;
    const won  = diff > 0;
    diffs.push(diff);
    pts_scored.push(myScore);
    pts_allowed.push(opScore);
    if (isHome) homeWL.push(won); else awayWL.push(won);

    const sign = won ? 1 : -1;
    if (sign === streakSign) streak += sign;
    else { streak = sign; streakSign = sign; }
  }

  if (!diffs.length) return null;

  const n       = diffs.length;
  const winRate  = diffs.filter(d => d > 0).length / n;
  const last5    = diffs.slice(-5);
  const last10   = diffs.slice(-10);
  const win5     = last5.filter(d => d > 0).length / last5.length;
  const win10    = last10.length ? last10.filter(d => d > 0).length / last10.length : winRate;
  const avgDiff  = avg(diffs) || 0;
  const avgDiff5 = avg(last5) || 0;
  const momentum = win5 - winRate;

  // DRtg from actual points allowed
  const avgAllowed = avg(pts_allowed) || 112;
  const avgScored  = avg(pts_scored)  || 110;

  // Home/away net rating
  const homeDiffs = games.filter(g => g.home_team?.id === teamId || g.home_team_id === teamId).map(g => sn(g.home_team_score) - sn(g.visitor_team_score));
  const awayDiffs = games.filter(g => !(g.home_team?.id === teamId || g.home_team_id === teamId)).map(g => sn(g.visitor_team_score) - sn(g.home_team_score));

  // Rest
  const lastGame = games[games.length - 1];
  const lastDate = new Date(lastGame?.date || lastGame?.datetime || Date.now() - 3 * 86400000);
  const today    = new Date(); today.setHours(0, 0, 0, 0);
  const restDays = Math.max(0, Math.round((today - lastDate) / 86400000));

  return {
    games:     n,
    winRate:   r4(winRate),
    winRate5:  r4(win5),
    winRate10: r4(win10),
    avgDiff:   r4(avgDiff),
    avgDiff5:  r4(avgDiff5),
    avgDiff10: r4(avg(last10) || 0),
    momentum:  r4(momentum),
    streak,
    avgPtsScored:  r4(avgScored),
    avgPtsAllowed: r4(avgAllowed),
    drtg_proxy:    r4(avgAllowed),
    homeWinRate:   homeWL.length ? r4(homeWL.filter(Boolean).length / homeWL.length) : null,
    awayWinRate:   awayWL.length ? r4(awayWL.filter(Boolean).length / awayWL.length) : null,
    home_net_rtg:  avg(homeDiffs) != null ? r4(avg(homeDiffs)) : null,
    away_net_rtg:  avg(awayDiffs) != null ? r4(avg(awayDiffs)) : null,
    rest_days:     restDays,
    is_b2b:        restDays <= 1,
    lastGameDate:  lastGame?.date || lastGame?.datetime || null,
  };
}

// ─── BDL: Player stats ────────────────────────────────────────────────────────
async function fetchTopPlayers(teamId, n = 8) {
  const season = getCurrentSeason();
  const k = `bdl:players:${teamId}:${season}`;
  const h = cg(k); if (h) return h;
  try {
    const raw = await bdlFetch(
      `/players/stats?team_ids[]=${teamId}&seasons[]=${season}&per_page=100&postseason=false`
    );
    const filtered = bdlRows(raw)
      .filter(r => sn(r.min) >= 10 && sn(r.games_played, 1) >= 5)
      .sort((a, b) => sn(b.pts) - sn(a.pts))
      .slice(0, n);
    return cs(k, filtered, TTL_PLAYER);
  } catch { return []; }
}

function buildPlayerMetrics(players) {
  if (!players?.length) return null;

  const scored = players.map(p => {
    const pts  = sn(p.pts); const ast = sn(p.ast); const reb = sn(p.reb);
    const stl  = sn(p.stl); const blk = sn(p.blk); const tov = sn(p.turnover);
    const fgm  = sn(p.fgm); const fga = sn(p.fga, fgm / Math.max(sn(p.fg_pct, 0.47), 0.01));
    const fg3m = sn(p.fg3m); const ftm = sn(p.ftm); const fta = sn(p.fta, ftm / Math.max(sn(p.ft_pct, 0.77), 0.01));
    const minPG = sn(p.min, 20);

    const tsa    = fga + 0.44 * fta;
    const ts_pct = tsa > 0 ? pts / (2 * tsa) : sn(p.fg_pct, 0.50);
    const efg    = fga > 0 ? (fgm + 0.5 * fg3m) / fga : sn(p.fg_pct, 0.50);
    const ast_to = tov > 0 ? ast / tov : ast;
    const usg    = (fga + 0.44 * fta + tov);  // raw, normalised later
    const star   = pts * 0.8 + ast * 0.6 + reb * 0.4 + (stl + blk) * 0.5 + (ts_pct - 0.52) * 30 - tov * 0.5;

    return {
      name:       `${p.player?.first_name || ""} ${p.player?.last_name || ""}`.trim(),
      pts, ast, reb, stl, blk, tov, min: minPG,
      ts_pct:  r4(ts_pct),
      efg_pct: r4(efg),
      ast_to:  r4(ast_to),
      usg_pct: r4(usg),
      star_score: r4(star),
      net_rating: 0,  // BDL doesn't provide per-player net rating
      pie: r4(ts_pct * 0.4 + (pts / 20) * 0.3 + (ast / 8) * 0.15 + (reb / 8) * 0.15)
    };
  });

  scored.sort((a, b) => b.star_score - a.star_score);
  const star_power = scored.reduce((s, p, i) => s + p.star_score / (i + 1), 0);
  const top_pie    = scored[0]?.pie || 0.12;

  return { players: scored, star_power: r4(star_power), top_pie: r4(top_pie), top_usg: r4(scored[0]?.usg_pct || 0), avg_net_rtg_top3: 0 };
}

// ─── BDL: H2H ────────────────────────────────────────────────────────────────
async function fetchH2H(homeId, awayId) {
  const season = getCurrentSeason();
  const k = `bdl:h2h:${homeId}:${awayId}:${season}`;
  const h = cg(k); if (h) return h;
  try {
    const r = await bdlFetch(
      `/games?team_ids[]=${homeId}&team_ids[]=${awayId}&seasons[]=${season}&per_page=100&postseason=false`
    );
    const all = bdlRows(r).filter(g => {
      const ids = [g.home_team?.id, g.home_team_id, g.visitor_team?.id, g.visitor_team_id].filter(Boolean);
      return ids.includes(homeId) && ids.includes(awayId) &&
             String(g.status || "").toLowerCase().includes("final");
    }).slice(-8);
    return cs(k, all, TTL_RECENT);
  } catch { return []; }
}

function computeH2H(games, homeId) {
  if (!games?.length) return null;
  let wins = 0; const diffs = [];
  for (const g of games) {
    const isHome = g.home_team?.id === homeId || g.home_team_id === homeId;
    const my = isHome ? sn(g.home_team_score) : sn(g.visitor_team_score);
    const op = isHome ? sn(g.visitor_team_score) : sn(g.home_team_score);
    if (!my && !op) continue;
    const d = my - op; if (d > 0) wins++; diffs.push(d);
  }
  if (!diffs.length) return null;
  const n = diffs.length, avgD = avg(diffs) || 0, wr = wins / n;
  return { games: n, winRate: r4(wr), avgDiff: r4(avgD), h2h_prob: clamp(0.5 + avgD * 0.012 + (wr - 0.5) * 0.18, 0.22, 0.78) };
}

// ─── Schedule context ─────────────────────────────────────────────────────────
function computeSchedule(recentGames) {
  if (!recentGames?.length) return { restDays: 2, isBackToBack: false };
  const sorted = [...recentGames].sort((a, b) =>
    new Date(a.date || a.datetime || 0) - new Date(b.date || b.datetime || 0)
  );
  const lastGame  = sorted[sorted.length - 1];
  const prevGame  = sorted.length > 1 ? sorted[sorted.length - 2] : null;
  const lastDate  = new Date(lastGame?.date || lastGame?.datetime || Date.now() - 3 * 86400000);
  const today     = new Date(); today.setHours(0, 0, 0, 0);
  const restDays  = Math.max(0, Math.round((today - lastDate) / 86400000));
  const isB2B     = restDays <= 1;
  let is3in4 = false;
  if (prevGame) {
    const prevDate = new Date(prevGame?.date || prevGame?.datetime || 0);
    const span = (lastDate - prevDate) / 86400000;
    if (span <= 3 && restDays <= 1) is3in4 = true;
  }
  return { restDays, isBackToBack: isB2B, isThirdInFourDays: is3in4 };
}

// ─── Team-specific HCA ───────────────────────────────────────────────────────
function computeTeamHCA(formData) {
  const LEAGUE_AVG = 0.112;
  const homeWR = formData?.homeWinRate, awayWR = formData?.awayWinRate;
  if (homeWR == null || awayWR == null) return LEAGUE_AVG;
  const n = formData?.games || 0;
  if (n < 15) return LEAGUE_AVG;
  const split = clamp((homeWR || 0.5) - (awayWR || 0.5), -0.30, 0.50);
  const logit  = split * 0.45;
  const weight = clamp(n / 60, 0, 1);
  return clamp(LEAGUE_AVG * (1 - weight) + logit * weight, 0.04, 0.30);
}

// ─── Merge: combine BDL stats + optional NBA service ──────────────────────────
function buildTeamProfile(bdlStats, formData, playerData, nbaProfile) {
  const b  = bdlStats  || {};    // from computeBdlAdvanced
  const f  = formData  || {};    // from analyzeRecentGames
  const p  = playerData || {};   // from buildPlayerMetrics
  const np = nbaProfile || {};   // from NBA service (optional)

  // Prefer official NBA numbers when available; fall back to BDL estimates
  const off_rating  = sn(np.off_rating)  || sn(b.ortg)         || 108;
  const drtg_from_gl= sn(f.drtg_proxy)   || sn(f.avgPtsAllowed) || 112;
  // Use official DRtg if available; else derive from game log
  const def_rating  = sn(np.def_rating)  || drtg_from_gl;
  const net_rating  = sn(np.net_rating)  || (off_rating - def_rating);

  const pace = sn(np.pace) || sn(b.poss) || 98;
  const pie  = sn(np.pie)  || null;   // PIE only from official NBA API

  return {
    // Core efficiency (real numbers)
    off_rating:  r4(off_rating),
    def_rating:  r4(def_rating),
    net_rating:  r4(net_rating),
    pace:        r4(pace),
    pie:         pie != null ? r4(pie) : 0.50,
    poss:        r4(sn(b.poss, pace)),
    w_pct:       sn(np.w_pct) || sn(b.w_pct) || sn(f.winRate, 0.5),

    // Shooting (BDL is accurate for these)
    ts_pct:   sn(np.ts_pct)  || sn(b.ts_pct,  0.55),
    efg_pct:  sn(np.efg_pct) || sn(b.efg_pct, 0.52),
    fg_pct:   sn(b.fg_pct,  0.47),
    fg3_pct:  sn(b.fg3_pct, 0.36),
    ft_pct:   sn(b.ft_pct,  0.77),
    fg3_rate: sn(b.fg3_rate, 0.40),
    ftr:      sn(b.ftr,     0.22),

    // Ball movement
    tov_pct:  sn(np.tov_pct) || sn(b.tov_pct, 14),
    ast_to:   sn(np.ast_to)  || sn(b.ast_to,  2.0),
    ast_pct:  sn(np.ast_pct, 0.60),

    // Rebounding
    oreb_pct: sn(np.oreb_pct) || sn(b.oreb_pct, 0.24),
    dreb_pct: sn(np.dreb_pct) || sn(b.dreb_pct, 0.76),

    // Defensive
    stl_rate: sn(b.stl_rate, sn(np.stl, 8) / Math.max(pace, 1) * 100),
    blk_rate: sn(b.blk_rate, sn(np.blk, 5) / Math.max(sn(b.fga, 88), 1)),

    // Clutch (only from NBA service)
    clutch_w_pct:      sn(np.clutch?.w_pct,      sn(f.winRate, 0.5)),
    clutch_plus_minus: sn(np.clutch?.plus_minus,  0),
    clutch_ft_pct:     sn(np.clutch?.ft_pct,      sn(b.ft_pct, 0.77)),

    // Hustle (only from NBA service)
    hustle_score:    sn(np.hustle?.score,          20),
    contested_shots: sn(np.hustle?.contested_shots, 15),
    charges_drawn:   sn(np.hustle?.charges_drawn,   0.5),

    // Defense zone (only from NBA service)
    defense: np.defense || {},

    // Players
    star_power:       sn(np.star_power) || sn(p.star_power, 10),
    top_pie:          sn(np.top_pie)    || sn(p.top_pie, 0.12),
    top_usg:          sn(np.top_usg)    || sn(p.top_usg, 0.28),
    avg_net_rtg_top3: sn(np.avg_net_rtg_top3, 0),
    players:          np.players?.length ? np.players : (p.players || []),
    best_lineup:      np.best_lineup || null,

    // Recent form (from BDL game log — real-time)
    win_rate:    sn(f.winRate,   sn(np.w_pct, 0.5)),
    win_rate5:   sn(f.winRate5,  sn(f.winRate, 0.5)),
    win_rate10:  sn(f.winRate10, sn(f.winRate, 0.5)),
    avg_diff:    sn(f.avgDiff,   0),
    avg_diff5:   sn(f.avgDiff5,  0),
    avg_diff10:  sn(f.avgDiff10, 0),
    momentum:    sn(f.momentum,  0),
    streak:      sn(f.streak,    0),
    avg_pts:     sn(f.avgPtsScored,  sn(off_rating * 0.97, 110)),
    avg_pts_allowed: drtg_from_gl,
    home_win_rate:   f.homeWinRate ?? null,
    away_win_rate:   f.awayWinRate ?? null,
    home_net_rtg:    f.home_net_rtg ?? null,
    away_net_rtg:    f.away_net_rtg ?? null,

    // Schedule
    rest_days: sn(f.rest_days, 2),
    is_b2b:    !!f.is_b2b,

    // Altitude / timezone (from NBA service)
    altitude_ft: sn(np.altitude_ft, 500),
    timezone:    np.timezone || "",
  };
}

// ─── Matchup deltas ───────────────────────────────────────────────────────────
function buildDeltas(home, away, nbaDeltas, refProfile) {
  const nd  = nbaDeltas || {};
  const get = (k, fb) => nd[k] != null ? sn(nd[k]) : fb;

  const hp = home.off_rating * (away.def_rating / 100);
  const ap = away.off_rating * (home.def_rating / 100);

  const re = clamp((home.rest_days - away.rest_days) * 0.015, -0.06, 0.06) +
             (away.is_b2b ? 0.04 : 0) - (home.is_b2b ? 0.04 : 0);

  const ts = sn(home.star_power) + sn(away.star_power);
  const hwR = home.home_win_rate ?? home.win_rate;
  const aaR = away.away_win_rate ?? away.win_rate;

  // Referee impact (from NBA service if available)
  const refImpact = (() => {
    if (!refProfile?.fouls_pg) return 0;
    const foulDiff = sn(refProfile.fouls_pg) - 46.5;
    const ftrEdge  = sn(home.ftr) - sn(away.ftr);
    const paceEff  = sn(refProfile.pace_effect, 0);
    const paceEdge = (sn(home.pace) - sn(away.pace)) * paceEff * 0.0004;
    return r4(clamp(foulDiff * ftrEdge * 0.15 + paceEdge, -0.035, 0.035));
  })();

  const travelImpact = get("travel_penalty", 0) + get("altitude_factor", 0) + (away.is_b2b ? 0.02 : 0);

  return {
    net_diff:             get("net_diff",           r4(home.net_rating - away.net_rating)),
    predicted_spread:     get("predicted_spread",   r4(hp - ap)),
    home_predicted_pts:   get("home_predicted_pts", r4(hp)),
    away_predicted_pts:   get("away_predicted_pts", r4(ap)),
    pie_edge:             get("pie_edge",            r4(home.pie - away.pie)),
    ts_edge:              get("ts_edge",             r4(home.ts_pct - away.ts_pct)),
    efg_edge:             get("efg_edge",            r4(home.efg_pct - away.efg_pct)),
    shot_quality_edge:    get("shot_quality_edge",   0),
    three_matchup_edge:   get("three_matchup_edge",  r4(home.fg3_pct - away.fg3_pct)),
    rim_edge:             get("rim_edge",            r4(home.ftr - away.ftr)),
    tov_edge:             get("tov_edge",            r4(sn(away.tov_pct) - sn(home.tov_pct))),
    ast_to_edge:          get("ast_to_edge",         r4(home.ast_to - away.ast_to)),
    oreb_edge:            get("oreb_edge",           r4(home.oreb_pct - away.oreb_pct)),
    dreb_edge:            get("dreb_edge",           r4(home.dreb_pct - away.dreb_pct)),
    clutch_w_pct_edge:    r4(home.clutch_w_pct - away.clutch_w_pct),
    clutch_pm_edge:       r4(home.clutch_plus_minus - away.clutch_plus_minus),
    clutch_ft_edge:       get("clutch_ft_edge",      r4(home.clutch_ft_pct - away.clutch_ft_pct)),
    hustle_edge:          r4(home.hustle_score - away.hustle_score),
    contested_edge:       r4(home.contested_shots - away.contested_shots),
    charges_edge:         get("charges_edge",        r4(home.charges_drawn - away.charges_drawn)),
    pace_edge:            get("pace_edge",           r4((home.pace - away.pace) * 0.003)),
    pace_mismatch:        Math.abs(home.pace - away.pace),
    variance_factor:      r4((home.fg3_rate + away.fg3_rate) / 2),
    star_power_edge:      get("star_power_edge",     r4(ts > 0 ? (sn(home.star_power) - sn(away.star_power)) / ts : 0)),
    pie_player_edge:      get("pie_player_edge",     r4(home.top_pie - away.top_pie)),
    net_rtg_top3_edge:    get("net_rtg_top3_edge",  r4(home.avg_net_rtg_top3 - away.avg_net_rtg_top3)),
    form_edge:            r4(sn(home.win_rate10) - sn(away.win_rate10)),
    diff5_edge:           r4(sn(home.avg_diff5) - sn(away.avg_diff5)),
    momentum_edge:        r4(sn(home.momentum) - sn(away.momentum)),
    streak_edge:          clamp((sn(home.streak) - sn(away.streak)) * 0.015, -0.06, 0.06),
    rest_edge:            r4(re),
    home_rest:            home.rest_days,
    away_rest:            away.rest_days,
    home_b2b:             home.is_b2b,
    away_b2b:             away.is_b2b,
    split_prob:           clamp(((hwR ?? 0.5) + (1 - (aaR ?? 0.5))) / 2, 0.25, 0.75),
    home_home_wr:         hwR,
    away_away_wr:         aaR,
    home_home_net:        home.home_net_rtg,
    away_away_net:        away.away_net_rtg,
    ref_impact:           refImpact,
    travel_fatigue:       r4(clamp(travelImpact, 0, 0.08)),
    travel_penalty:       get("travel_penalty", 0),
    altitude_factor:      get("altitude_factor", 0),
    home_altitude:        home.altitude_ft,
    away_altitude:        away.altitude_ft,
    nba_service_used:     !!nbaDeltas,
  };
}

// ─── Main exported function ───────────────────────────────────────────────────
async function getAdvancedMatchup(homeTeam, awayTeam) {
  const season = getCurrentSeason();

  // Resolve BDL team IDs + fetch optional NBA service concurrently
  const [homeId, awayId, nbaData] = await Promise.all([
    resolveTeamId(homeTeam).catch(() => null),
    resolveTeamId(awayTeam).catch(() => null),
    getNbaMatchup(homeTeam, awayTeam),
  ]);

  if (!homeId || !awayId) {
    console.warn(`[adv_stats] Could not resolve BDL IDs: ${homeTeam}=${homeId}, ${awayTeam}=${awayId}`);
  }

  // Fetch BDL data in parallel (primary source — always real)
  const [
    homeSeasonStats, awaySeasonStats,
    homeGames, awayGames,
    homePlayers, awayPlayers,
    h2hGames
  ] = await Promise.all([
    homeId ? fetchBdlSeasonStats(homeId, season) : Promise.resolve(null),
    awayId ? fetchBdlSeasonStats(awayId, season) : Promise.resolve(null),
    homeId ? fetchRecentGames(homeId) : Promise.resolve([]),
    awayId ? fetchRecentGames(awayId) : Promise.resolve([]),
    homeId ? fetchTopPlayers(homeId) : Promise.resolve([]),
    awayId ? fetchTopPlayers(awayId) : Promise.resolve([]),
    (homeId && awayId) ? fetchH2H(homeId, awayId) : Promise.resolve([]),
  ]);

  // Compute from BDL
  const homeBdlAdv   = computeBdlAdvanced(homeSeasonStats);
  const awayBdlAdv   = computeBdlAdvanced(awaySeasonStats);
  const homeForm     = analyzeRecentGames(homeGames, homeId);
  const awayForm     = analyzeRecentGames(awayGames, awayId);
  const homePlayerM  = buildPlayerMetrics(homePlayers);
  const awayPlayerM  = buildPlayerMetrics(awayPlayers);
  const h2h          = computeH2H(h2hGames, homeId);

  // Merge: BDL base + optional NBA service enhancement
  const homeData = buildTeamProfile(homeBdlAdv, homeForm, homePlayerM, nbaData?.home || null);
  const awayData = buildTeamProfile(awayBdlAdv, awayForm, awayPlayerM, nbaData?.away || null);

  const refProfile = nbaData?.referee || null;
  const matchup    = buildDeltas(homeData, awayData, nbaData?.deltas || null, refProfile);

  const nbaAvailable = !!(nbaData && !nbaData.error);
  console.log(
    `[adv_stats] ${homeTeam} vs ${awayTeam} — BDL: ${homeBdlAdv ? "✓" : "✗"} NBA: ${nbaAvailable ? "✓" : "✗"} ` +
    `homeNet=${homeData.net_rating} awayNet=${awayData.net_rating}`
  );

  return {
    matchup, homeData, awayData, homeId, awayId, h2h,
    homeOnOff: nbaData?.home_on_off || [],
    awayOnOff: nbaData?.away_on_off || [],
    refProfile,
    dataSource: {
      nbaServiceAvailable: nbaAvailable,
      bdlAvailable:        !!(homeBdlAdv && awayBdlAdv),
      bdlH2HAvailable:     h2hGames.length > 0,
    }
  };
}

module.exports = { getAdvancedMatchup, resolveTeamId, getCurrentSeason, computeTeamHCA };
