"use strict";

/**
 * player_stats.js
 *
 * Fetches rich player data for independent prop prediction:
 *   - Season averages (BallDontLie)
 *   - Last 5 / Last 10 game logs
 *   - Home / Away splits
 *   - vs Opponent history
 *   - Minutes and usage trends
 *   - Opponent defensive stats (ESPN)
 */

const BDL_KEY = process.env.BALLDONTLIE_API_KEY || "";

const TTL_PLAYER = 30 * 60 * 1000;
const TTL_GAME   = 20 * 60 * 1000;
const TTL_DEF    = 10 * 60 * 1000;

const _cache = new Map();
const cg = k => {
  const h = _cache.get(k);
  if (!h) return null;
  if (Date.now() > h.e) { _cache.delete(k); return null; }
  return h.v;
};
const cs = (k, v, t) => { _cache.set(k, { v, e: Date.now() + t }); return v; };

const flt   = (v, fb = 0)  => { const n = Number(v); return Number.isFinite(n) ? n : fb; };
const fltN  = (v)           => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const norm  = s             => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const r2    = n             => (typeof n === "number" && Number.isFinite(n)) ? Math.round(n * 100) / 100 : null;

const avg = arr => {
  const ns = (arr || []).filter(v => Number.isFinite(v));
  return ns.length ? ns.reduce((s, v) => s + v, 0) / ns.length : null;
};

const stddev = arr => {
  const ns = (arr || []).filter(v => Number.isFinite(v));
  if (ns.length < 2) return null;
  const m = ns.reduce((s, v) => s + v, 0) / ns.length;
  return Math.sqrt(ns.map(v => (v - m) ** 2).reduce((s, v) => s + v, 0) / (ns.length - 1));
};

function getBdlSeason() {
  const d = new Date(), m = d.getUTCMonth() + 1, y = d.getUTCFullYear();
  return m >= 10 ? y : y - 1;
}

// ─── BDL fetch ────────────────────────────────────────────────────────────────
async function bdlFetch(endpoint) {
  if (!BDL_KEY) throw new Error("Missing BALLDONTLIE_API_KEY");
  const res = await fetch(`https://api.balldontlie.io/v1${endpoint}`, {
    headers: { Authorization: BDL_KEY },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`BDL ${res.status} ${endpoint}`);
  return res.json();
}

const bdlRows = p => Array.isArray(p) ? p : Array.isArray(p?.data) ? p.data : [];

// ─── Player search ────────────────────────────────────────────────────────────
async function findPlayer(name) {
  if (!name) return null;
  const k = `bdl:find:${norm(name)}`, h = cg(k);
  if (h) return h;

  try {
    const data  = await bdlFetch(`/players?search=${encodeURIComponent(name)}&per_page=10`);
    const rows  = bdlRows(data);
    if (!rows.length) return null;

    const target = norm(name);
    // Exact full name match first
    let best = rows.find(p => norm(`${p.first_name} ${p.last_name}`) === target);
    // Last name match fallback
    if (!best) {
      const lastName = target.split(" ").pop();
      best = rows.find(p => norm(p.last_name) === lastName);
    }
    if (!best) best = rows[0];

    return cs(k, best, TTL_PLAYER);
  } catch (e) {
    console.warn("[player_stats] findPlayer:", e.message);
    return null;
  }
}

// ─── Season averages ──────────────────────────────────────────────────────────
async function getSeasonAverages(playerId) {
  if (!playerId) return null;
  const season = getBdlSeason();
  const k = `bdl:avg:${playerId}:${season}`, h = cg(k);
  if (h) return h;

  // Try current season, fall back to previous
  for (const s of [season, season - 1]) {
    try {
      const data = await bdlFetch(`/season_averages?player_ids[]=${playerId}&season=${s}`);
      const rows = bdlRows(data);
      if (rows.length) return cs(k, rows[0], TTL_PLAYER);
    } catch (e) {
      console.warn(`[player_stats] seasonAvg s=${s}:`, e.message);
    }
  }
  return null;
}

// ─── Recent game logs ─────────────────────────────────────────────────────────
async function getRecentGames(playerId, limit = 15) {
  if (!playerId) return [];
  const season = getBdlSeason();
  const k = `bdl:gl:${playerId}:${season}:${limit}`, h = cg(k);
  if (h) return h;

  try {
    const data = await bdlFetch(
      `/stats?player_ids[]=${playerId}&seasons[]=${season}&per_page=${limit}&sort_by=game_date&direction=desc`
    );
    const rows = bdlRows(data);
    return cs(k, rows, TTL_GAME);
  } catch (e) {
    console.warn("[player_stats] recentGames:", e.message);
    return [];
  }
}

// ─── Vs opponent history ──────────────────────────────────────────────────────
async function getVsOpponent(playerId, opponentTeamName) {
  if (!playerId || !opponentTeamName) return [];
  const season = getBdlSeason();
  const k = `bdl:vsOpp:${playerId}:${norm(opponentTeamName)}:${season}`, h = cg(k);
  if (h) return h;

  try {
    const data = await bdlFetch(
      `/stats?player_ids[]=${playerId}&seasons[]=${season}&per_page=100`
    );
    const rows = bdlRows(data);
    const oppNorm = norm(opponentTeamName);
    const oppNick = oppNorm.split(" ").pop();

    const filtered = rows.filter(g => {
      const ht = norm(g.game?.home_team?.full_name || "");
      const vt = norm(g.game?.visitor_team?.full_name || "");
      return ht.includes(oppNick) || vt.includes(oppNick);
    });

    return cs(k, filtered, TTL_GAME);
  } catch (e) {
    console.warn("[player_stats] vsOpp:", e.message);
    return [];
  }
}

// ─── Opponent defensive stats (ESPN) ─────────────────────────────────────────
const ESPN_TEAM_IDS = {
  "Atlanta Hawks": "1",         "Boston Celtics": "2",       "Brooklyn Nets": "17",
  "Charlotte Hornets": "30",    "Chicago Bulls": "4",         "Cleveland Cavaliers": "5",
  "Dallas Mavericks": "6",      "Denver Nuggets": "7",        "Detroit Pistons": "8",
  "Golden State Warriors": "9", "Houston Rockets": "10",      "Indiana Pacers": "11",
  "Los Angeles Clippers": "12", "Los Angeles Lakers": "13",   "Memphis Grizzlies": "29",
  "Miami Heat": "14",           "Milwaukee Bucks": "15",      "Minnesota Timberwolves": "16",
  "New Orleans Pelicans": "3",  "New York Knicks": "18",      "Oklahoma City Thunder": "25",
  "Orlando Magic": "19",        "Philadelphia 76ers": "20",   "Phoenix Suns": "21",
  "Portland Trail Blazers": "22","Sacramento Kings": "23",    "San Antonio Spurs": "24",
  "Toronto Raptors": "28",      "Utah Jazz": "26",            "Washington Wizards": "27",
};

function resolveEspnId(teamName) {
  if (ESPN_TEAM_IDS[teamName]) return ESPN_TEAM_IDS[teamName];
  const nm = norm(teamName);
  const entry = Object.entries(ESPN_TEAM_IDS).find(([n]) => norm(n).includes(nm.split(" ").pop()));
  return entry?.[1] || null;
}

async function getOpponentDefense(teamName) {
  if (!teamName) return null;
  const k = `espn:def:${norm(teamName)}`, h = cg(k);
  if (h) return h;

  const espnId = resolveEspnId(teamName);
  if (!espnId) return null;

  try {
    const res = await fetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnId}/statistics`,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();

    const sm = {};
    const cats = data?.results?.stats?.categories || data?.statistics?.splits?.categories || data?.statistics?.categories || [];
    for (const cat of cats)
      for (const s of cat.stats || [])
        if (s.name) sm[s.name] = flt(s.value ?? s.displayValue);

    return cs(k, sm, TTL_DEF);
  } catch (e) {
    return null;
  }
}

// ─── Extract a specific stat from a BDL row ───────────────────────────────────
function extractStat(row, statType) {
  if (!row) return null;
  const t = (statType || "").toLowerCase();

  if (t === "points"    || t === "pts")   return fltN(row.pts);
  if (t === "rebounds"  || t === "reb") {
    const r = fltN(row.reb);
    if (r !== null) return r;
    const o = flt(row.oreb, 0), d = flt(row.dreb, 0);
    return (o + d > 0) ? o + d : null;
  }
  if (t === "assists"   || t === "ast")   return fltN(row.ast);
  if (t === "pra"       || t === "points_rebounds_assists") {
    const p = fltN(row.pts), a = fltN(row.ast);
    const r = fltN(row.reb) ?? (flt(row.oreb,0) + flt(row.dreb,0) > 0 ? flt(row.oreb,0)+flt(row.dreb,0) : null);
    if (p === null || r === null || a === null) return null;
    return p + r + a;
  }
  if (t === "blocks"    || t === "blk")   return fltN(row.blk);
  if (t === "steals"    || t === "stl")   return fltN(row.stl);
  if (t === "turnovers" || t === "tov")   return fltN(row.turnover ?? row.to);
  if (t === "threes"    || t === "3pm")   return fltN(row.fg3m);
  return null;
}

// ─── Build full player profile ────────────────────────────────────────────────
async function buildPlayerProfile(playerName, statType, line, opponentTeam = null) {
  const player = await findPlayer(playerName);
  if (!player) return null;

  const teamId = player.team?.id;

  const [seasonAvgRaw, recentGames, oppGames, oppDef] = await Promise.allSettled([
    getSeasonAverages(player.id),
    getRecentGames(player.id, 15),
    opponentTeam ? getVsOpponent(player.id, opponentTeam) : Promise.resolve([]),
    opponentTeam ? getOpponentDefense(opponentTeam) : Promise.resolve(null),
  ]).then(rs => rs.map(r => r.status === "fulfilled" ? r.value : null));

  // Filter to games where player actually played meaningful minutes
  const played = (recentGames || []).filter(g => flt(g.min) > 5);

  // ── Stat extraction ──────────────────────────────────────────────────────
  const allVals   = played.map(g => extractStat(g, statType)).filter(v => v !== null);
  const l5        = allVals.slice(0, 5);
  const l10       = allVals.slice(0, 10);

  // ── Location splits ───────────────────────────────────────────────────────
  const homeGames = played.filter(g => g.game?.home_team_id === teamId || g.game?.home_team?.id === teamId);
  const awayGames = played.filter(g => g.game?.home_team_id !== teamId && g.game?.home_team?.id !== teamId);
  const homeVals  = homeGames.map(g => extractStat(g, statType)).filter(v => v !== null);
  const awayVals  = awayGames.map(g => extractStat(g, statType)).filter(v => v !== null);

  // ── Vs opponent ───────────────────────────────────────────────────────────
  const oppVals = (oppGames || []).map(g => extractStat(g, statType)).filter(v => v !== null);

  // ── Minutes trend ─────────────────────────────────────────────────────────
  const recentMins  = played.slice(0, 5).map(g => flt(g.min)).filter(v => v > 0);
  const seasonMins  = flt(seasonAvgRaw?.min, 0);
  const minsTrend   = recentMins.length && seasonMins > 0
    ? avg(recentMins) / seasonMins
    : 1.0;

  // ── Season average for this stat ──────────────────────────────────────────
  const seasonStatAvg = seasonAvgRaw ? extractStat(seasonAvgRaw, statType) : null;

  return {
    player,
    statType,
    line,
    // Averages
    seasonAvg:  r2(seasonStatAvg),
    l5Avg:      r2(avg(l5)),
    l10Avg:     r2(avg(l10)),
    vsOppAvg:   r2(avg(oppVals)),
    // Hit rates vs line
    hitRate5:   l5.length  ? l5.filter(v  => v > line).length / l5.length  : null,
    hitRate10:  l10.length ? l10.filter(v => v > line).length / l10.length : null,
    // Consistency
    l5StdDev:   r2(stddev(l5)),
    l10StdDev:  r2(stddev(l10)),
    // Splits
    homeAvg:    r2(avg(homeVals)),
    awayAvg:    r2(avg(awayVals)),
    // Minutes
    recentMins: r2(avg(recentMins)),
    seasonMins,
    minsTrend:  Number.isFinite(minsTrend) ? Math.round(minsTrend * 10000) / 10000 : 1.0,
    // Opponent defense stats
    oppDef: oppDef || null,
    // Raw values for context
    statValues: allVals.slice(0, 10),
  };
}

module.exports = {
  findPlayer,
  getSeasonAverages,
  getRecentGames,
  getVsOpponent,
  getOpponentDefense,
  buildPlayerProfile,
  extractStat,
};
