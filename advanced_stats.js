"use strict";

/**
 * advanced_stats.js  v2
 *
 * Data layer for the prediction model. Two sources, merged:
 *
 *   nba_service.py (Python)  — official NBA API: ORtg, DRtg, NetRtg, Pace,
 *                              PIE, TS%, clutch, hustle, shot quality, players
 *   BallDontLie              — game logs (rest/B2B), H2H current season
 *
 * If the Python service is unreachable, BDL-only fallbacks are used.
 */

const NBA_SERVICE_URL     = process.env.NBA_SERVICE_URL || "http://localhost:5001";
const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY || "";

const TTL_NBA  = 22 * 60 * 1000;
const TTL_BDL  = 20 * 60 * 1000;
const TTL_TEAM = 24 * 60 * 60 * 1000;

const _cache = new Map();
function cacheGet(k) { const h = _cache.get(k); if (!h) return null; if (Date.now() > h.e) { _cache.delete(k); return null; } return h.v; }
function cacheSet(k, v, ttl) { _cache.set(k, { v, e: Date.now() + ttl }); return v; }

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function safeNum(v, fb = 0) { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function avg(arr) { const n = (arr||[]).filter(v=>Number.isFinite(Number(v))).map(Number); return n.length ? n.reduce((s,v)=>s+v,0)/n.length : null; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function sigmoid(x) { return 1 / (1 + Math.exp(-clamp(x,-50,50))); }
function logit(p) { const c = clamp(p,1e-6,1-1e-6); return Math.log(c/(1-c)); }
function normName(s) { return String(s||"").toLowerCase().replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ").trim(); }

// ─── NBA service ──────────────────────────────────────────────────────────────
async function fetchNbaService(path, ms = 28000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(`${NBA_SERVICE_URL}${path}`, { signal: ctrl.signal });
      if (!res.ok) return null;
      return await res.json();
    } finally { clearTimeout(t); }
  } catch { return null; }
}

async function getNbaMatchup(home, away) {
  const k = `nba:${normName(home)}:${normName(away)}`;
  const h = cacheGet(k);
  if (h) return h;
  const d = await fetchNbaService(`/matchup?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}`);
  if (!d || d.error) return null;
  return cacheSet(k, d, TTL_NBA);
}

// ─── BallDontLie ──────────────────────────────────────────────────────────────
async function bdlFetch(path) {
  if (!BALLDONTLIE_API_KEY) throw new Error("Missing BALLDONTLIE_API_KEY");
  const res = await fetch(`https://api.balldontlie.io/v1${path}`, {
    headers: { Authorization: BALLDONTLIE_API_KEY },
    signal: AbortSignal.timeout(15000)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`BDL ${res.status}: ${txt.slice(0,200)}`);
  return JSON.parse(txt);
}
function bdlRows(p) { return Array.isArray(p) ? p : Array.isArray(p?.data) ? p.data : []; }

function getCurrentSeason() { const d = new Date(); const m = d.getUTCMonth()+1; return m>=10 ? d.getUTCFullYear() : d.getUTCFullYear()-1; }

async function getAllBdlTeams() {
  const k = "bdl:teams"; const h = cacheGet(k); if (h) return h;
  try { const r = await bdlFetch("/teams?per_page=100"); return cacheSet(k, bdlRows(r), TTL_TEAM); }
  catch { return []; }
}

async function resolveTeamId(name) {
  const teams = await getAllBdlTeams();
  const tgt = normName(name);
  let m = teams.find(t => normName(t.full_name) === tgt);
  if (m) return m.id;
  const nick = tgt.split(" ").pop()||"";
  if (nick.length > 3) m = teams.find(t => normName(t.full_name).includes(nick));
  return m?.id || null;
}

async function fetchH2H(homeId, awayId) {
  const season = getCurrentSeason();
  const k = `bdl:h2h:${homeId}:${awayId}:${season}`;
  const h = cacheGet(k); if (h) return h;
  try {
    const r = await bdlFetch(`/games?team_ids[]=${homeId}&team_ids[]=${awayId}&seasons[]=${season}&per_page=100&postseason=false`);
    const all = bdlRows(r).filter(g => {
      const ids = [g.home_team?.id, g.home_team_id, g.visitor_team?.id, g.visitor_team_id].filter(Boolean);
      return ids.includes(homeId) && ids.includes(awayId) && String(g.status||"").toLowerCase().includes("final");
    }).slice(-8);
    return cacheSet(k, all, TTL_BDL);
  } catch { return []; }
}

function computeH2H(games, homeId) {
  if (!games?.length) return null;
  let wins = 0; const diffs = [];
  for (const g of games) {
    const isHome = g.home_team?.id === homeId || g.home_team_id === homeId;
    const my = isHome ? safeNum(g.home_team_score) : safeNum(g.visitor_team_score);
    const op = isHome ? safeNum(g.visitor_team_score) : safeNum(g.home_team_score);
    if (!my && !op) continue;
    const d = my - op;
    if (d > 0) wins++;
    diffs.push(d);
  }
  if (!diffs.length) return null;
  const n = diffs.length;
  const avgDiff = avg(diffs)||0;
  const winRate = wins / n;
  return { games: n, winRate: round4(winRate), avgDiff: round4(avgDiff), h2h_prob: clamp(0.5 + avgDiff*0.012 + (winRate-0.5)*0.18, 0.22, 0.78) };
}

// ─── merge NBA service + BDL form data into one team object ───────────────────
function mergeTeam(nbaProfile, formData) {
  const p = nbaProfile || {};
  const f = formData   || {};

  const poss          = safeNum(p.poss, 97);
  const avgPtsAllowed = safeNum(f.avg_pts_allowed, safeNum(p.def_rating, 112) * 0.97);
  const drtgActual    = avgPtsAllowed > 0 ? (avgPtsAllowed / poss) * 100 : safeNum(p.def_rating, 112);

  return {
    // Official NBA efficiency
    off_rating:  safeNum(p.off_rating,  108),
    def_rating:  drtgActual,
    net_rating:  safeNum(p.net_rating, safeNum(p.off_rating,108) - drtgActual),
    pace:        safeNum(p.pace,        98),
    pie:         safeNum(p.pie,         0.50),
    poss,

    // Official shooting
    ts_pct:   safeNum(p.ts_pct,  0.55),
    efg_pct:  safeNum(p.efg_pct, 0.52),
    fg_pct:   safeNum(p.fg_pct,  0.47),
    fg3_pct:  safeNum(p.fg3_pct, 0.36),
    ft_pct:   safeNum(p.ft_pct,  0.77),
    fg3_rate: safeNum(p.fg3_rate, 0.40),
    ftr:      safeNum(p.ftr,     0.22),

    // Ball movement
    tov_pct:  safeNum(p.tov_pct,  14),
    ast_to:   safeNum(p.ast_to,   2.0),
    ast_pct:  safeNum(p.ast_pct,  0.60),

    // Rebounding
    oreb_pct: safeNum(p.oreb_pct, 0.24),
    dreb_pct: safeNum(p.dreb_pct, 0.76),

    // Raw
    pts:  safeNum(p.pts,  110), reb: safeNum(p.reb, 44),
    ast:  safeNum(p.ast,  26),  stl: safeNum(p.stl, 8),
    blk:  safeNum(p.blk,  5),   tov: safeNum(p.tov, 14),
    stl_rate: safeNum(p.stl, 8) / poss * 100,
    blk_rate: safeNum(p.blk, 5) / Math.max(safeNum(p.fga, 88), 1),

    // Clutch (official NBA)
    clutch_w_pct:      safeNum(p.clutch?.w_pct,      safeNum(f.win_rate, 0.5)),
    clutch_plus_minus: safeNum(p.clutch?.plus_minus,  0),
    clutch_fg_pct:     safeNum(p.clutch?.fg_pct,      0.45),
    clutch_ft_pct:     safeNum(p.clutch?.ft_pct,      0.77),
    clutch_tov:        safeNum(p.clutch?.tov,         14),

    // Hustle (official NBA)
    hustle_score:    safeNum(p.hustle?.score,         20),
    contested_shots: safeNum(p.hustle?.contested_shots, 15),
    contested_3pt:   safeNum(p.hustle?.contested_3pt,  7),
    charges_drawn:   safeNum(p.hustle?.charges_drawn,  0.5),
    screen_ast_pts:  safeNum(p.hustle?.screen_ast_pts, 20),

    // Defense shot quality
    defense: p.defense || {},

    // Players
    star_power:       safeNum(p.star_power, 15),
    top_pie:          safeNum(p.top_pie,    0.12),
    top_usg:          safeNum(p.top_usg,    0.28),
    avg_net_rtg_top3: safeNum(p.avg_net_rtg_top3, -2),
    players:          p.players || [],
    best_lineup:      p.best_lineup || null,
    w_pct:            safeNum(p.w_pct, 0.5),

    // Form (from BDL game logs — more timely)
    win_rate:    safeNum(f.win_rate,    safeNum(p.w_pct, 0.5)),
    win_rate5:   safeNum(f.win_rate5,   safeNum(f.win_rate, 0.5)),
    win_rate10:  safeNum(f.win_rate10,  safeNum(f.win_rate, 0.5)),
    avg_diff:    safeNum(f.avg_diff,    safeNum(p.net_rating,-2)*0.4),
    avg_diff5:   safeNum(f.avg_diff5,   0),
    avg_diff10:  safeNum(f.avg_diff10,  0),
    momentum:    safeNum(f.momentum,    0),
    streak:      safeNum(f.streak,      0),
    avg_pts:     safeNum(f.avg_pts,     safeNum(p.pts, 110)),
    avg_pts_allowed: avgPtsAllowed,
    home_win_rate: f.home_win_rate != null ? safeNum(f.home_win_rate) : null,
    away_win_rate: f.away_win_rate != null ? safeNum(f.away_win_rate) : null,

    // Schedule (from BDL game log dates)
    rest_days: safeNum(f.rest_days, 2),
    is_b2b:    !!f.is_b2b,
  };
}

// ─── matchup deltas ───────────────────────────────────────────────────────────
function buildDeltas(home, away, nbaDeltas) {
  const nd  = nbaDeltas || {};
  const get = (k, fb) => nd[k] != null ? safeNum(nd[k]) : fb;

  const homePred = home.off_rating * (away.def_rating / 100);
  const awayPred = away.off_rating * (home.def_rating / 100);

  const restEdge =
    clamp((home.rest_days - away.rest_days) * 0.015, -0.06, 0.06) +
    (away.is_b2b ? 0.04 : 0) - (home.is_b2b ? 0.04 : 0);

  const totalStar = safeNum(home.star_power) + safeNum(away.star_power);
  const starEdge  = totalStar > 0 ? (safeNum(home.star_power) - safeNum(away.star_power)) / totalStar : 0;

  const homeHomeWR = home.home_win_rate ?? home.win_rate;
  const awayAwayWR = away.away_win_rate ?? away.win_rate;

  return {
    // Core efficiency (official NBA)
    net_diff:            get("net_diff",           round4(home.net_rating - away.net_rating)),
    predicted_spread:    get("predicted_spread",   round4(homePred - awayPred)),
    home_predicted_pts:  get("home_predicted_pts", round4(homePred)),
    away_predicted_pts:  get("away_predicted_pts", round4(awayPred)),

    // PIE
    pie_edge:            get("pie_edge",            round4(home.pie - away.pie)),

    // Shooting
    ts_edge:             get("ts_edge",             round4(home.ts_pct   - away.ts_pct)),
    efg_edge:            get("efg_edge",            round4(home.efg_pct  - away.efg_pct)),
    shot_quality_edge:   get("shot_quality_edge",   0),
    three_matchup_edge:  get("three_matchup_edge",  round4(home.fg3_pct  - away.fg3_pct)),
    rim_edge:            get("rim_edge",            round4(home.ftr      - away.ftr)),

    // Turnovers (lower = better → invert)
    tov_edge:            get("tov_edge",            round4(away.tov_pct  - home.tov_pct)),
    ast_to_edge:         get("ast_to_edge",         round4(home.ast_to   - away.ast_to)),

    // Rebounding
    oreb_edge:           get("oreb_edge",           round4(home.oreb_pct - away.oreb_pct)),
    dreb_edge:           get("dreb_edge",           round4(home.dreb_pct - away.dreb_pct)),

    // Clutch
    clutch_w_pct_edge:       round4(home.clutch_w_pct      - away.clutch_w_pct),
    clutch_plus_minus_edge:  round4(home.clutch_plus_minus  - away.clutch_plus_minus),
    clutch_ft_edge:          get("clutch_ft_edge",          round4(home.clutch_ft_pct - away.clutch_ft_pct)),

    // Hustle
    hustle_edge:         round4(home.hustle_score   - away.hustle_score),
    contested_edge:      round4(home.contested_shots - away.contested_shots),
    charges_edge:        get("charges_edge",         round4(home.charges_drawn - away.charges_drawn)),

    // Pace / ball movement
    pace_edge:           get("pace_edge",            round4((home.pace - away.pace) * 0.003)),
    pace_mismatch:       Math.abs(home.pace - away.pace),
    variance_factor:     round4((home.fg3_rate + away.fg3_rate) / 2),

    // Players
    star_power_edge:     get("star_power_edge",     round4(starEdge)),
    pie_player_edge:     get("pie_player_edge",     round4(home.top_pie - away.top_pie)),
    net_rtg_top3_edge:   get("net_rtg_top3_edge",   round4(home.avg_net_rtg_top3 - away.avg_net_rtg_top3)),

    // Form
    form_edge:      round4(safeNum(home.win_rate10) - safeNum(away.win_rate10)),
    diff5_edge:     round4(safeNum(home.avg_diff5)  - safeNum(away.avg_diff5)),
    momentum_edge:  round4(safeNum(home.momentum)   - safeNum(away.momentum)),
    streak_edge:    clamp((safeNum(home.streak)  - safeNum(away.streak)) * 0.015, -0.06, 0.06),

    // Schedule
    rest_edge:  round4(restEdge),
    home_rest:  home.rest_days,
    away_rest:  away.rest_days,
    home_b2b:   home.is_b2b,
    away_b2b:   away.is_b2b,

    // Splits
    split_prob:   clamp(((homeHomeWR??0.5) + (1-(awayAwayWR??0.5))) / 2, 0.25, 0.75),
    home_home_wr: homeHomeWR,
    away_away_wr: awayAwayWR,

    nba_service_used: !!nbaDeltas,
  };
}

// ─── main export ──────────────────────────────────────────────────────────────
async function getAdvancedMatchup(homeTeam, awayTeam) {
  const [nbaData, homeId, awayId] = await Promise.all([
    getNbaMatchup(homeTeam, awayTeam),
    resolveTeamId(homeTeam).catch(() => null),
    resolveTeamId(awayTeam).catch(() => null)
  ]);

  const h2hGames = (homeId && awayId)
    ? await fetchH2H(homeId, awayId).catch(() => [])
    : [];
  const h2h = computeH2H(h2hGames, homeId);

  const homeData = mergeTeam(nbaData?.home || null, nbaData?.home_form || null);
  const awayData = mergeTeam(nbaData?.away || null, nbaData?.away_form || null);
  const matchup  = buildDeltas(homeData, awayData, nbaData?.deltas || null);

  return {
    matchup, homeData, awayData, homeId, awayId, h2h,
    dataSource: {
      nbaServiceAvailable: !!nbaData,
      bdlH2HAvailable:     h2hGames.length > 0
    }
  };
}

module.exports = { getAdvancedMatchup, resolveTeamId, getCurrentSeason, getNbaMatchup };
