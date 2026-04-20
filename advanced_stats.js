"use strict";

/**
 * advanced_stats.js  v9
 *
 * 3-source waterfall for every data category.
 * Source 1 fails → Source 2 → Source 3. Never returns null.
 *
 * Team Stats:    ESPN team/statistics  → ESPN standings       → BDL game aggregation
 * Player Stats:  BDL season_averages  → BDL recent game agg  → ESPN roster stats
 * Game Logs:     BDL games endpoint   → NBA Stats teamgamelogs → ESPN team schedule
 * Clutch/Hustle: NBA Stats API        → estimated from BDL close games
 */

const BDL_KEY = process.env.BALLDONTLIE_API_KEY || "";

const TTL_ESPN   = 15 * 60 * 1000;
const TTL_LEAGUE = 6  * 60 * 60 * 1000;
const TTL_GAME   = 20 * 60 * 1000;
const TTL_PLAYER = 30 * 60 * 1000;
const TTL_TEAM   = 24 * 60 * 60 * 1000;

const _cache = new Map();
const cg = k => { const h = _cache.get(k); if (!h) return null; if (Date.now() > h.e) { _cache.delete(k); return null; } return h.v; };
const cs = (k, v, t) => { _cache.set(k, { v, e: Date.now() + t }); return v; };

// ─── Helpers ──────────────────────────────────────────────────────────────────
const r4    = n  => Math.round(n * 10000) / 10000;
const flt   = (v, fb = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const norm  = s  => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const mean  = arr => { const ns = (arr||[]).filter(v => Number.isFinite(v)); return ns.length ? ns.reduce((s,v)=>s+v,0)/ns.length : 0; };
const bdlRows = p => Array.isArray(p) ? p : Array.isArray(p?.data) ? p.data : [];

function getCurrentSeason() {
  const d = new Date(), m = d.getUTCMonth() + 1, y = d.getUTCFullYear();
  return m >= 10 ? `${y}-${String(y+1).slice(2)}` : `${y-1}-${String(y).slice(2)}`;
}
function getBdlSeason() {
  const d = new Date(), m = d.getUTCMonth() + 1, y = d.getUTCFullYear();
  return m >= 10 ? y : y - 1;
}
function getPreviousSeason(s) {
  const yr = parseInt(s.split("-")[0], 10);
  return `${yr-1}-${String(yr).slice(2)}`;
}

// ─── NBA Team IDs ─────────────────────────────────────────────────────────────
const NBA_TEAM_IDS = {
  "Atlanta Hawks":1610612737,"Boston Celtics":1610612738,"Brooklyn Nets":1610612751,
  "Charlotte Hornets":1610612766,"Chicago Bulls":1610612741,"Cleveland Cavaliers":1610612739,
  "Dallas Mavericks":1610612742,"Denver Nuggets":1610612743,"Detroit Pistons":1610612765,
  "Golden State Warriors":1610612744,"Houston Rockets":1610612745,"Indiana Pacers":1610612754,
  "Los Angeles Clippers":1610612746,"Los Angeles Lakers":1610612747,"Memphis Grizzlies":1610612763,
  "Miami Heat":1610612748,"Milwaukee Bucks":1610612749,"Minnesota Timberwolves":1610612750,
  "New Orleans Pelicans":1610612740,"New York Knicks":1610612752,"Oklahoma City Thunder":1610612760,
  "Orlando Magic":1610612753,"Philadelphia 76ers":1610612755,"Phoenix Suns":1610612756,
  "Portland Trail Blazers":1610612757,"Sacramento Kings":1610612758,"San Antonio Spurs":1610612759,
  "Toronto Raptors":1610612761,"Utah Jazz":1610612762,"Washington Wizards":1610612764,
};
function getNbaTeamId(name) {
  if (NBA_TEAM_IDS[name]) return NBA_TEAM_IDS[name];
  const nick = norm(name).split(" ").pop();
  return Object.entries(NBA_TEAM_IDS).find(([n]) => norm(n).includes(nick))?.[1] || null;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────
async function espnFetch(url) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ESPN ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

async function bdlFetch(path) {
  if (!BDL_KEY) throw new Error("Missing BDL key");
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(`https://api.balldontlie.io/v1${path}`, {
      headers: { Authorization: BDL_KEY },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`BDL ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

const NBA_HEADERS = {
  "User-Agent":         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Referer":            "https://www.nba.com/",
  "Origin":             "https://www.nba.com",
  "Accept":             "application/json, text/plain, */*",
  "Accept-Language":    "en-US,en;q=0.9",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token":  "true",
};
async function nbaFetch(endpoint, params = {}) {
  const url  = `https://stats.nba.com/stats/${endpoint}?${new URLSearchParams(params)}`;
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: NBA_HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error(`NBA ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}
function parseRS(json, idx = 0) {
  try {
    const rs = json?.resultSets?.[idx] || json?.resultSet;
    if (!rs) return [];
    const hdrs = rs.headers || [];
    return (rs.rowSet || []).map(row => Object.fromEntries(hdrs.map((h, i) => [h, row[i]])));
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── ESPN ID LOOKUP ───────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
const ESPN_IDS = {
  "Atlanta Hawks":"1","Boston Celtics":"2","Brooklyn Nets":"17","Charlotte Hornets":"30",
  "Chicago Bulls":"4","Cleveland Cavaliers":"5","Dallas Mavericks":"6","Denver Nuggets":"7",
  "Detroit Pistons":"8","Golden State Warriors":"9","Houston Rockets":"10","Indiana Pacers":"11",
  "Los Angeles Clippers":"12","Los Angeles Lakers":"13","Memphis Grizzlies":"29",
  "Miami Heat":"14","Milwaukee Bucks":"15","Minnesota Timberwolves":"16","New Orleans Pelicans":"3",
  "New York Knicks":"18","Oklahoma City Thunder":"25","Orlando Magic":"19",
  "Philadelphia 76ers":"20","Phoenix Suns":"21","Portland Trail Blazers":"22",
  "Sacramento Kings":"23","San Antonio Spurs":"24","Toronto Raptors":"28",
  "Utah Jazz":"26","Washington Wizards":"27",
};
function getEspnId(name) {
  if (ESPN_IDS[name]) return ESPN_IDS[name];
  const nm = norm(name);
  return Object.entries(ESPN_IDS).find(([n]) => norm(n).includes(nm.split(" ").pop()))?.[1] || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── BDL TEAM ID LOOKUP ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
let _bdlTeamMap = null;
async function getBdlTeamMap() {
  if (_bdlTeamMap) return _bdlTeamMap;
  const h = cg("bdl:teammap"); if (h) { _bdlTeamMap = h; return h; }
  if (!BDL_KEY) return {};
  try {
    const data = await bdlFetch("/teams?per_page=35");
    const map  = {};
    for (const t of bdlRows(data)) {
      const f=norm(t.full_name||""), n=norm(t.name||""), a=(t.abbreviation||"").toLowerCase();
      if (f) map[f]=t.id; if (n) map[n]=t.id; if (a) map[a]=t.id;
    }
    _bdlTeamMap = map;
    return cs("bdl:teammap", map, TTL_TEAM);
  } catch { _bdlTeamMap = {}; return {}; }
}
async function getBdlTeamId(name) {
  const map = await getBdlTeamMap();
  const nm  = norm(name);
  return map[nm] || map[nm.split(" ").pop()] || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── SOURCE 1: ESPN TEAM STATISTICS ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
function parseEspnStatsMap(data) {
  const sm = {};
  if (!data) return sm;

  // Try every known response structure
  const catSources = [
    data?.results?.stats?.categories,
    data?.statistics?.splits?.categories,
    data?.statistics?.categories,
    data?.stats?.categories,
    data?.team?.statistics?.splits?.categories,
  ].filter(Boolean);

  for (const cats of catSources) {
    for (const cat of cats) {
      for (const s of cat?.stats || []) {
        if (!s?.name) continue;
        const v = typeof s.value === "number" ? s.value
                : Number.isFinite(parseFloat(s.displayValue)) ? parseFloat(s.displayValue)
                : NaN;
        if (Number.isFinite(v)) sm[s.name] = v;
      }
    }
  }

  // Top-level stats arrays
  for (const s of [...(data?.results?.stats?.stats||[]), ...(data?.stats||[])]) {
    if (s?.name) {
      const v = typeof s.value === "number" ? s.value : parseFloat(s.displayValue||"");
      if (Number.isFinite(v)) sm[s.name] = v;
    }
  }
  return sm;
}

async function fetchEspnTeamStats(espnId) {
  if (!espnId) return null;
  const k = `espn:stats:${espnId}`, h = cg(k); if (h) return h;

  // Try two ESPN endpoints
  const urls = [
    `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnId}/statistics`,
    `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/seasons/2025/teams/${espnId}/statistics?lang=en&region=us`,
  ];

  for (const url of urls) {
    try {
      const data = await espnFetch(url);
      const sm   = parseEspnStatsMap(data);
      if (Object.keys(sm).length > 3) {
        console.log(`[adv] ESPN stats for ${espnId}: ${Object.keys(sm).length} fields`);
        return cs(k, sm, TTL_ESPN);
      }
    } catch {}
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── SOURCE 2: ESPN STANDINGS ─────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
let _espnStandings = null, _espnStandingsTs = 0;
async function fetchEspnStandings() {
  if (_espnStandings && Date.now() - _espnStandingsTs < TTL_ESPN) return _espnStandings;
  const h = cg("espn:standings"); if (h) { _espnStandings = h; return h; }

  const urls = [
    "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/standings",
    "https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?season=2025",
  ];

  for (const url of urls) {
    try {
      const data = await espnFetch(url);
      const map  = {};
      const children = data?.children || data?.standings?.entries ? [data] : [];
      const allChildren = [...children, ...(data?.children || [])];

      for (const conf of allChildren) {
        for (const entry of conf?.standings?.entries || []) {
          const id = entry.team?.id;
          if (!id) continue;
          const stats = {};
          for (const s of entry.stats || []) {
            if (s.name) stats[s.name] = flt(s.value ?? s.displayValue);
          }
          const gp  = flt(stats.gamesPlayed || (flt(stats.wins)+flt(stats.losses)) || 1);
          // Multiple field names ESPN uses
          const pf  = stats.avgPointsFor     ?? stats.avgPoints         ?? (stats.pointsFor    > 500 ? stats.pointsFor    / gp : stats.pointsFor)    ?? 0;
          const pa  = stats.avgPointsAgainst ?? stats.avgPointsAllowed  ?? (stats.pointsAgainst> 500 ? stats.pointsAgainst/ gp : stats.pointsAgainst) ?? 0;
          map[id] = {
            wins:       flt(stats.wins),
            losses:     flt(stats.losses),
            gp,
            ptsFor:     flt(pf),
            ptsAgainst: flt(pa),
            winPct:     gp > 0 ? flt(stats.wins) / gp : 0,
          };
        }
      }
      if (Object.keys(map).length > 5) {
        _espnStandings = map; _espnStandingsTs = Date.now();
        return cs("espn:standings", map, TTL_ESPN);
      }
    } catch (e) { console.warn("[adv] ESPN standings:", e.message); }
  }
  return {};
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── SOURCE 3: BDL GAME AGGREGATION ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
async function fetchBdlTeamGames(bdlTeamId, season) {
  if (!BDL_KEY || !bdlTeamId) return [];
  const k = `bdl:tgames:${bdlTeamId}:${season}`, h = cg(k); if (h) return h;
  try {
    const data  = await bdlFetch(`/games?team_ids[]=${bdlTeamId}&seasons[]=${season}&per_page=100`);
    const games = bdlRows(data).filter(g =>
      String(g.status || "").toLowerCase().includes("final") &&
      typeof g.home_team_score === "number" &&
      typeof g.visitor_team_score === "number"
    );
    return cs(k, games, TTL_GAME);
  } catch (e) { console.warn("[adv] BDL team games:", e.message); return []; }
}

function aggregateBdlTeamGames(games, bdlTeamId) {
  if (!games?.length) return null;

  // Sort ascending by date so newest game is always last
  const sorted = [...games].sort((a, b) => {
    const da = new Date(a.date || a.datetime || 0).getTime();
    const db = new Date(b.date || b.datetime || 0).getTime();
    return da - db;
  });

  const results = sorted.map(g => {
    const isHome = g.home_team?.id === bdlTeamId || g.home_team_id === bdlTeamId;
    const myPts  = isHome ? g.home_team_score  : g.visitor_team_score;
    const oppPts = isHome ? g.visitor_team_score : g.home_team_score;
    return {
      myPts, oppPts, isHome,
      won:    myPts > oppPts,
      margin: myPts - oppPts,
      date:   g.date || (g.datetime ? g.datetime.slice(0, 10) : null),
    };
  }).filter(r => Number.isFinite(r.myPts) && Number.isFinite(r.oppPts));

  if (!results.length) return null;

  const pts    = results.map(r => r.myPts);
  const opp    = results.map(r => r.oppPts);
  const marg   = results.map(r => r.margin);
  const last5  = results.slice(-5);
  const last10 = results.slice(-10);
  const homeR  = results.filter(r => r.isHome);
  const awayR  = results.filter(r => !r.isHome);

  // Streak
  let streak = 0;
  for (const r of [...results].reverse()) {
    if (streak === 0) { streak = r.won ? 1 : -1; continue; }
    if ((streak > 0) === r.won) streak += streak > 0 ? 1 : -1;
    else break;
  }

  // Rest days from most recent game
  let rest_days = 2, is_b2b = false;
  const lastDate = results[results.length - 1]?.date;
  if (lastDate) {
    try {
      const ld = new Date(lastDate), today = new Date(); today.setHours(0,0,0,0);
      rest_days = Math.max(0, Math.round((today - ld) / 86400000));
      is_b2b = rest_days <= 1;
    } catch {}
  }

  const wr = results.filter(r=>r.won).length / results.length;

  return {
    // Team stats proxies
    ptsFor:      mean(pts),
    ptsAgainst:  mean(opp),
    netPts:      mean(marg),
    gamesPlayed: results.length,
    // Form
    win_rate:    r4(wr),
    win_rate5:   r4(last5.filter(r=>r.won).length  / Math.max(last5.length, 1)),
    win_rate10:  r4(last10.filter(r=>r.won).length / Math.max(last10.length, 1)),
    avg_diff:    r4(mean(marg)),
    avg_diff5:   r4(mean(last5.map(r=>r.margin))),
    avg_diff10:  r4(mean(last10.map(r=>r.margin))),
    momentum:    r4(last5.filter(r=>r.won).length / Math.max(last5.length,1) - wr),
    streak,
    avg_pts:         r4(mean(pts)),
    avg_pts_allowed: r4(mean(opp)),
    home_win_rate:   homeR.length ? r4(homeR.filter(r=>r.won).length / homeR.length) : null,
    away_win_rate:   awayR.length ? r4(awayR.filter(r=>r.won).length / awayR.length) : null,
    home_net_rtg:    homeR.length ? r4(mean(homeR.map(r=>r.margin))) : null,
    away_net_rtg:    awayR.length ? r4(mean(awayR.map(r=>r.margin))) : null,
    rest_days,
    is_b2b,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── TEAM STATS MERGER: ESPN stats + standings + BDL game agg ─────────────
// ═══════════════════════════════════════════════════════════════════════════
function buildAdvFromSources(sm, sd, bdlAgg) {
  // pts per game — try every source
  let pts     = flt(sm?.avgPoints || sm?.avgPointsFor || 0);
  let opp_pts = flt(sm?.avgPointsAllowed || sm?.avgPointsAgainst || sm?.oppAvgPoints || sm?.avgOpponentPoints || 0);

  if (!pts && sd?.ptsFor     > 80) pts     = sd.ptsFor;
  if (!opp_pts && sd?.ptsAgainst > 80) opp_pts = sd.ptsAgainst;
  if (!pts && bdlAgg?.ptsFor     > 80) pts     = bdlAgg.ptsFor;
  if (!opp_pts && bdlAgg?.ptsAgainst > 80) opp_pts = bdlAgg.ptsAgainst;

  // If we still have no pts, we can't build advanced stats
  if (!pts || !opp_pts) return null;

  const s = sm || {};

  const fgm  = flt(s.avgFieldGoalsMade               || 0);
  const fga  = flt(s.avgFieldGoalsAttempted           || 0);
  const fg3m = flt(s.avgThreePointFieldGoalsMade      || 0);
  const fg3a = flt(s.avgThreePointFieldGoalsAttempted || 0);
  const ftm  = flt(s.avgFreeThrowsMade                || 0);
  const fta  = flt(s.avgFreeThrowsAttempted           || 0);
  // ESPN uses many field name variants depending on endpoint/season — try all
  const oreb = flt(s.avgOffRebounds || s.avgOffensiveRebounds || s.offReboundsPerGame || s.avgOffensiveReboundsPerGame || 0);
  const dreb = flt(s.avgDefRebounds || s.avgDefensiveRebounds || s.defReboundsPerGame || s.avgDefensiveReboundsPerGame || 0);
  const reb  = flt(s.avgRebounds || s.reboundsPerGame || (oreb+dreb) || 0);
  const ast  = flt(s.avgAssists  || s.assistsPerGame  || 0);
  const tov  = flt(s.avgTurnovers|| s.turnoversPerGame|| 0);
  const stl  = flt(s.avgSteals   || s.stealsPerGame   || 0);
  const blk  = flt(s.avgBlocks   || s.blocksPerGame   || 0);

  const ts_pct  = (fga+0.44*fta) > 0 ? pts  / (2*(fga+0.44*fta)) : 0;
  const efg_pct = fga > 0 ? (fgm+0.5*fg3m) / fga : 0;
  const tov_pct = (fga+0.44*fta+tov) > 0 ? 100*tov / (fga+0.44*fta+tov) : 0;
  const oreb_pct = reb > 0 ? oreb/reb : 0;
  const ast_to   = tov > 0 ? ast/tov  : 0;
  const ftr      = fga > 0 ? fta/fga  : 0;
  const fg3_rate = fga > 0 ? fg3a/fga : 0;

  let pace = fga > 0 ? fga - oreb + tov + 0.44*fta : 0;
  if (pace < 85 || pace > 120) pace = 100;

  const net_rating = pts - opp_pts;
  const pie = clamp((net_rating+15)/30*0.12 + ts_pct*0.04, 0.01, 0.20);

  return {
    off_rating: r4(pts), def_rating: r4(opp_pts), net_rating: r4(net_rating),
    pace: r4(pace), pie: r4(pie),
    ts_pct: r4(ts_pct), efg_pct: r4(efg_pct), tov_pct: r4(tov_pct),
    oreb_pct: r4(oreb_pct), ast_to: r4(ast_to), ftr: r4(ftr), fg3_rate: r4(fg3_rate),
    stl_rate: r4(stl), blk_rate: r4(fga > 0 ? blk/fga : 0),
    pts_per_game: r4(pts), opp_pts_per_game: r4(opp_pts),
    fgm, fga, fg3m, fg3a, ftm, fta, oreb, dreb, reb, ast, tov, stl, blk,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── PLAYER STATS ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// Source 1: BDL season averages
async function fetchBdlTeamPlayers(bdlTeamId) {
  if (!BDL_KEY || !bdlTeamId) return [];
  const k = `bdl:players:${bdlTeamId}`, h = cg(k); if (h) return h;
  try {
    const data = await bdlFetch(`/players?team_ids[]=${bdlTeamId}&per_page=20`);
    return cs(k, bdlRows(data), TTL_PLAYER);
  } catch { return []; }
}

async function fetchBdlSeasonAverages(playerIds) {
  if (!BDL_KEY || !playerIds.length) return [];
  const season = getBdlSeason();
  const k = `bdl:avgs:${season}:${playerIds.slice(0,5).join(",")}`, h = cg(k); if (h) return h;

  // BDL /season_averages only accepts player_id (singular) — make individual calls
  for (const s of [season, season - 1]) {
    try {
      const settled = await Promise.allSettled(
        playerIds.slice(0, 12).map(id => bdlFetch(`/season_averages?season=${s}&player_id=${id}`))
      );
      const rows = settled
        .filter(r => r.status === "fulfilled")
        .flatMap(r => bdlRows(r.value))
        .filter(Boolean);
      if (rows.length >= 2) {
        console.log(`[adv] BDL season avgs s=${s}: ${rows.length} players`);
        return cs(k, rows, TTL_PLAYER);
      }
    } catch {}
  }
  return [];
}

// Source 2: BDL recent game stats — fetch by game_ids so we always get
// whoever actually played, bypassing stale roster data
async function fetchBdlTeamRecentStats(bdlTeamId) {
  if (!BDL_KEY || !bdlTeamId) return [];
  const season = getBdlSeason();
  const k = `bdl:teamstats:${bdlTeamId}:${season}`, h = cg(k); if (h) return h;
  try {
    // Step 1: get the 8 most recent final games for this team
    const gData = await bdlFetch(
      `/games?team_ids[]=${bdlTeamId}&seasons[]=${season}&per_page=10`
    );
    const games = bdlRows(gData)
      .filter(g => String(g.status || "").toLowerCase().includes("final"))
      .slice(-8); // take most recent 8

    if (!games.length) { console.warn("[adv] No recent games for team", bdlTeamId); return []; }

    const gameIds = games.map(g => g.id).filter(Boolean);
    if (!gameIds.length) return [];

    // Step 2: get all player stats from those game IDs (max 100 per page, fetch 2 pages)
    const idsQ    = gameIds.map(id => `game_ids[]=${id}`).join("&");
    const [p1, p2] = await Promise.allSettled([
      bdlFetch(`/stats?${idsQ}&per_page=100`),
      bdlFetch(`/stats?${idsQ}&per_page=100&page=2`),
    ]);
    const allRows = [
      ...bdlRows(p1.status === "fulfilled" ? p1.value : []),
      ...bdlRows(p2.status === "fulfilled" ? p2.value : []),
    ].filter(r => flt(r.min) > 1);

    // Step 3: keep only rows belonging to our team
    const teamRows = allRows.filter(r => {
      const tid = r.team?.id ?? r.team_id;
      return tid === bdlTeamId || tid === String(bdlTeamId);
    });

    const rows = teamRows.length >= 5 ? teamRows : allRows; // fallback if team filter fails

    // Step 4: aggregate last 8 games per player
    const byPlayer = {};
    for (const r of rows) {
      if (flt(r.min) < 1) continue;
      const id = r.player_id ?? r.player?.id;
      if (!id) continue;
      if (!byPlayer[id]) byPlayer[id] = { player: r.player, rows: [] };
      byPlayer[id].rows.push(r);
    }

    const result = Object.values(byPlayer).map(({ player, rows: pRows }) => {
      const avg = f => mean(pRows.map(r => flt(r[f])).filter(v => v >= 0));
      const avgReb = () => mean(pRows.map(r => {
        const rb = flt(r.reb, -1);
        return rb >= 0 ? rb : flt(r.oreb, 0) + flt(r.dreb, 0);
      }).filter(v => v >= 0));

      return {
        id:       player?.id,
        name:     `${player?.first_name || ""} ${player?.last_name || ""}`.trim(),
        pts:      avg("pts"),  reb:      avgReb(),
        ast:      avg("ast"),  stl:      avg("stl"),
        blk:      avg("blk"),  fgm:      avg("fgm"),
        fga:      avg("fga"),  fg3m:     avg("fg3m"),
        ftm:      avg("ftm"),  fta:      avg("fta"),
        min:      avg("min"),  turnover: avg("turnover"),
        games:    pRows.length,
      };
    }).filter(p => p.min >= 3);

    console.log(`[adv] BDL recent stats via game_ids: ${result.length} players for team ${bdlTeamId}`);
    return cs(k, result, TTL_PLAYER);
  } catch (e) { console.warn("[adv] BDL team recent stats:", e.message); return []; }
}

// Source 3: ESPN roster stats
async function fetchEspnRosterStats(espnId) {
  if (!espnId) return [];
  const k = `espn:roster:${espnId}`, h = cg(k); if (h) return h;
  try {
    const data = await espnFetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnId}/roster`
    );
    const athletes = data?.athletes || [];
    const result = athletes.flatMap(group => group?.items || group?.athletes || (Array.isArray(group) ? group : []));
    const mapped = result.map(p => {
      const stats = {};
      for (const s of p?.statistics?.stats || p?.stats || []) {
        if (s.name) stats[s.name] = flt(s.value ?? s.displayValue);
      }
      return {
        id:   p.id,
        name: p.fullName || p.displayName || "",
        pts:  flt(stats.avgPoints || stats.points || 0),
        reb:  flt(stats.avgRebounds || stats.rebounds || 0),
        ast:  flt(stats.avgAssists || stats.assists || 0),
        min:  flt(stats.avgMinutes || stats.minutes || 0),
        fga:  flt(stats.avgFieldGoalsAttempted || 0),
        fgm:  flt(stats.avgFieldGoalsMade || 0),
        fg3m: flt(stats.avgThreePointFieldGoalsMade || 0),
        fta:  flt(stats.avgFreeThrowsAttempted || 0),
        ftm:  flt(stats.avgFreeThrowsMade || 0),
        stl:  flt(stats.avgSteals || 0),
        blk:  flt(stats.avgBlocks || 0),
        turnover: flt(stats.avgTurnovers || 0),
      };
    }).filter(p => p.name && p.min > 3);
    return cs(k, mapped, TTL_PLAYER);
  } catch { return []; }
}

function buildPlayersFromStats(rawPlayers, teamAdv) {
  if (!rawPlayers?.length) return [];
  const teamPts = teamAdv?.pts_per_game || 110;
  const gamePts = (teamAdv?.pts_per_game||110) + (teamAdv?.opp_pts_per_game||110);

  return rawPlayers.map(p => {
    const pts = flt(p.pts), fga = flt(p.fga), fta = flt(p.fta);
    const fg3m= flt(p.fg3m), fgm = flt(p.fgm);
    const reb = flt(p.reb), ast = flt(p.ast);
    const stl = flt(p.stl), blk = flt(p.blk);
    const tov = flt(p.turnover), min = flt(p.min);

    const ts_pct  = (fga+0.44*fta) > 0 ? pts/(2*(fga+0.44*fta)) : 0;
    const efg_pct = fga > 0 ? (fgm+0.5*fg3m)/fga : 0;
    const usg_pct = (teamPts > 0 && min > 0) ? clamp(pts/teamPts*(5*min/240), 0, 0.40) : 0;
    const pie     = gamePts > 0
      ? clamp((pts+reb+ast+stl+blk-(fga-fgm)-(fta-flt(p.ftm||0))*0.44-tov)/gamePts, -0.1, 0.3)
      : 0;

    return {
      name:       p.name || "",
      min:        r4(min),
      pts:        r4(pts),
      reb:        r4(flt(p.reb)),
      ast:        r4(flt(p.ast)),
      stl:        r4(stl),
      blk:        r4(blk),
      off_rating: 0, def_rating: 0, net_rating: 0,
      ts_pct:     r4(clamp(ts_pct, 0, 1)),
      efg_pct:    r4(efg_pct),
      usg_pct:    r4(usg_pct),
      pie:        r4(pie),
      star_score: usg_pct * Math.max(ts_pct-0.5, 0) * 50 + pie * 20,
    };
  })
  .sort((a, b) => b.star_score - a.star_score)
  .slice(0, 8);
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── GAME LOGS (FORM) ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

// Source 1: BDL games (most reliable)
async function fetchBdlGameLog(bdlTeamId) {
  const season = getBdlSeason();
  return fetchBdlTeamGames(bdlTeamId, season);
}

// Source 2: NBA Stats teamgamelogs
async function fetchNbaGameLog(nbaTeamId, season) {
  if (!nbaTeamId) return [];
  const k = `nba:gl:${nbaTeamId}:${season}`, h = cg(k); if (h) return h;
  try {
    const j = await nbaFetch("teamgamelogs", {
      TeamID: nbaTeamId, Season: season, SeasonType: "Regular Season",
      MeasureType: "Base", PerMode: "PerGame",
      Outcome:"", Location:"", Month:"0", SeasonSegment:"", DateFrom:"",
      DateTo:"", OpponentTeamID:"0", VsConference:"", VsDivision:"",
      LastNGames:"0", Period:"0", GameSegment:"", LeagueID:"00",
    });
    const rows = parseRS(j);
    for (const r of rows) r.OPP_PTS = flt(r.PTS) - flt(r.PLUS_MINUS);
    return cs(k, rows.slice(-25), TTL_GAME);
  } catch { return []; }
}

// Source 3: ESPN team schedule/results
async function fetchEspnTeamSchedule(espnId) {
  if (!espnId) return [];
  const k = `espn:sched:${espnId}`, h = cg(k); if (h) return h;
  try {
    const data = await espnFetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnId}/schedule`
    );
    const events = data?.events || [];
    const results = events
      .filter(e => e?.competitions?.[0]?.status?.type?.completed)
      .map(e => {
        const comp = e.competitions[0];
        const homeComp = comp.competitors?.find(c => c.homeAway === "home");
        const awayComp = comp.competitors?.find(c => c.homeAway === "away");
        const isHome   = homeComp?.team?.id === espnId;
        const myPts    = flt((isHome ? homeComp : awayComp)?.score || 0);
        const oppPts   = flt((isHome ? awayComp : homeComp)?.score || 0);
        return {
          PTS: myPts, OPP_PTS: oppPts,
          PLUS_MINUS: myPts - oppPts,
          WL: myPts > oppPts ? "W" : "L",
          MATCHUP: isHome ? "vs." : "@",
          GAME_DATE: e.date?.slice(0,10),
        };
      })
      .filter(r => r.PTS > 0);
    return cs(k, results.slice(-20), TTL_GAME);
  } catch { return []; }
}

// Analyze game logs (supports both BDL game objects and NBA Stats rows)
function analyzeFormData(raw, bdlTeamId) {
  // Could be BDL game objects or NBA Stats rows — handle both
  if (!raw?.length) return {};

  // Check if it's BDL game format
  const isBdl = typeof raw[0].home_team_score !== "undefined" ||
                typeof raw[0].home_team?.id !== "undefined";

  if (isBdl && bdlTeamId) {
    return aggregateBdlTeamGames(raw, bdlTeamId) || {};
  }

  // NBA Stats / ESPN format
  const diffs = [], pts_s = [], pts_a = [], home_wl = [], away_wl = [];
  let streak = 0;

  for (const g of raw) {
    const pts  = flt(g.PTS), opp = flt(g.OPP_PTS), diff = pts - opp;
    const won  = g.WL === "W";
    const isHome = String(g.MATCHUP||"").includes("vs.");
    diffs.push(diff); pts_s.push(pts); pts_a.push(opp);
    if (isHome) home_wl.push(won); else away_wl.push(won);
  }

  for (const g of [...raw].reverse()) {
    const won = g.WL === "W";
    if (streak === 0) { streak = won ? 1 : -1; continue; }
    if ((streak > 0) === won) streak += streak > 0 ? 1 : -1; else break;
  }

  const n  = diffs.length;
  const wr = diffs.filter(d=>d>0).length / n;
  const wr5= diffs.slice(-5).filter(d=>d>0).length / Math.min(5,n);
  const wr10=diffs.slice(-10).filter(d=>d>0).length / Math.min(10,n);

  let rest_days = 2, is_b2b = false;
  const lastDate = raw[raw.length-1]?.GAME_DATE;
  if (lastDate) {
    try {
      const ld=new Date(lastDate), today=new Date(); today.setHours(0,0,0,0);
      rest_days = Math.max(0, Math.round((today-ld)/86400000));
      is_b2b = rest_days <= 1;
    } catch {}
  }

  const hDiffs = raw.filter(g=>String(g.MATCHUP||"").includes("vs.")).map(g=>flt(g.PTS)-flt(g.OPP_PTS));
  const aDiffs = raw.filter(g=>String(g.MATCHUP||"").includes("@")).map(g=>flt(g.PTS)-flt(g.OPP_PTS));

  return {
    games: n, win_rate: r4(wr), win_rate5: r4(wr5), win_rate10: r4(wr10),
    avg_diff: r4(mean(diffs)), avg_diff5: r4(mean(diffs.slice(-5))), avg_diff10: r4(mean(diffs.slice(-10))),
    momentum: r4(wr5-wr), streak,
    avg_pts: r4(mean(pts_s)), avg_pts_allowed: r4(mean(pts_a)),
    home_win_rate: home_wl.length ? r4(home_wl.filter(Boolean).length/home_wl.length) : null,
    away_win_rate: away_wl.length ? r4(away_wl.filter(Boolean).length/away_wl.length) : null,
    home_net_rtg:  hDiffs.length ? r4(mean(hDiffs)) : null,
    away_net_rtg:  aDiffs.length ? r4(mean(aDiffs)) : null,
    rest_days, is_b2b,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── CLUTCH + HUSTLE (NBA Stats with estimation fallback) ─────────────────
// ═══════════════════════════════════════════════════════════════════════════
async function fetchLeagueClutch(season) {
  const k = `nba:clutch:${season}`, h = cg(k); if (h) return h;
  try {
    const j = await nbaFetch("leaguedashteamclutch", {
      Season: season, SeasonType: "Regular Season",
      ClutchTime: "Last 5 Minutes", PointDiff: "5", AheadBehind: "Ahead or Behind",
      MeasureType: "Base", PerMode: "PerGame", PlusMinus: "N", PaceAdjust: "N", Rank: "N",
      Month:"0", OpponentTeamID:"0", LastNGames:"0", Period:"0",
      DateFrom:"", DateTo:"", Outcome:"", Location:"", SeasonSegment:"",
      VsConference:"", VsDivision:"", GameScope:"", PlayerExperience:"", PlayerPosition:"", StarterBench:"",
    });
    return cs(k, parseRS(j), TTL_LEAGUE);
  } catch { return []; }
}

async function fetchLeagueHustle(season) {
  const k = `nba:hustle:${season}`, h = cg(k); if (h) return h;
  try {
    const j = await nbaFetch("leaguehustlestatsTeam", {
      Season: season, SeasonType: "Regular Season", PerMode: "PerGame",
      PaceAdjust:"N", Rank:"N", Month:"0", OpponentTeamID:"0", LastNGames:"0",
      DateFrom:"", DateTo:"", Outcome:"", Location:"", SeasonSegment:"",
      VsConference:"", VsDivision:"", College:"", Country:"", DraftYear:"",
      DraftPick:"", Height:"", Weight:"", PlayerExperience:"", PlayerPosition:"", StarterBench:"", TeamID:"0",
    });
    return cs(k, parseRS(j), TTL_LEAGUE);
  } catch { return []; }
}

function findRow(rows, teamName) {
  const tgt = norm(teamName), nick = tgt.split(" ").pop() || "";
  let r = (rows||[]).find(r => norm(r.TEAM_NAME || r.TEAM || "") === tgt);
  if (!r && nick.length > 3) r = (rows||[]).find(r => norm(r.TEAM_NAME || r.TEAM || "").includes(nick));
  return r || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── H2H (BDL) ───────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
async function fetchH2H(homeId, awayId) {
  if (!BDL_KEY || !homeId || !awayId) return [];
  const season = getBdlSeason();
  const k = `bdl:h2h:${homeId}:${awayId}:${season}`, h = cg(k); if (h) return h;
  try {
    const data = await bdlFetch(
      `/games?team_ids[]=${homeId}&team_ids[]=${awayId}&seasons[]=${season}&per_page=100`
    );
    const all = bdlRows(data).filter(g => {
      const ids = [g.home_team?.id, g.home_team_id, g.visitor_team?.id, g.visitor_team_id].filter(Boolean);
      return ids.includes(homeId) && ids.includes(awayId) &&
             String(g.status||"").toLowerCase().includes("final");
    }).slice(-8);
    return cs(k, all, TTL_GAME);
  } catch { return []; }
}

function computeH2H(games, homeId) {
  if (!games?.length) return null;
  let wins = 0; const diffs = [];
  for (const g of games) {
    const isHome = g.home_team?.id === homeId || g.home_team_id === homeId;
    const my = isHome ? flt(g.home_team_score) : flt(g.visitor_team_score);
    const op = isHome ? flt(g.visitor_team_score) : flt(g.home_team_score);
    if (!my && !op) continue;
    const d = my - op; if (d > 0) wins++; diffs.push(d);
  }
  if (!diffs.length) return null;
  const n = diffs.length, avgD = mean(diffs), wr = wins/n;
  return {games:n, winRate:r4(wr), avgDiff:r4(avgD), h2h_prob: clamp(0.5+avgD*0.012+(wr-0.5)*0.18, 0.22, 0.78)};
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── BUILD TEAM PROFILE ───────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
function buildProfile(teamName, advStats, form, clutchRows, hustleRows, players) {
  const e   = advStats || {};
  const f   = form || {};
  const cl  = findRow(clutchRows||[], teamName) || {};
  const hs  = findRow(hustleRows||[], teamName) || {};
  const bp  = players || [];

  // Use form for any missing advanced stats
  const off_rating = e.off_rating || f.avg_pts || 0;
  const def_rating = e.def_rating || f.avg_pts_allowed || 0;

  const hs_score = flt(hs.CONTESTED_SHOTS,0)*0.8 + flt(hs.CHARGES_DRAWN,0)*4 +
                   flt(hs.SCREEN_AST_PTS,0)*0.2  + flt(hs.BOX_OUTS,0)*0.4;

  const clutch = {
    w_pct:      flt(cl.W_PCT,      f.win_rate || 0),
    plus_minus: flt(cl.PLUS_MINUS, 0),
    fg_pct:     flt(cl.FG_PCT,     0),
    ft_pct:     flt(cl.FT_PCT,     0),
    fg3_pct:    flt(cl.FG3_PCT,    0),
  };
  const hustle = {
    score:           r4(hs_score || flt(hs.HUSTLE_POINTS,0)),
    contested_shots: flt(hs.CONTESTED_SHOTS,0),
    charges_drawn:   flt(hs.CHARGES_DRAWN,0),
    screen_ast_pts:  flt(hs.SCREEN_AST_PTS,0),
    box_outs:        flt(hs.BOX_OUTS,0),
  };

  const star_power = bp.slice(0,3).reduce((s,p)=>s+(p.star_score||0), 0);

  return {
    team: teamName,
    off_rating, def_rating, net_rating: off_rating - def_rating,
    pace:     e.pace     || 100,
    pie:      e.pie      || 0,
    ts_pct:   e.ts_pct   || 0,
    efg_pct:  e.efg_pct  || 0,
    tov_pct:  e.tov_pct  || 0,
    oreb_pct: e.oreb_pct || 0,
    dreb_pct: 0,
    ast_to:   e.ast_to   || 0,
    ftr:      e.ftr      || 0,
    fg3_rate: e.fg3_rate || 0,
    stl_rate: e.stl_rate || 0,
    blk_rate: e.blk_rate || 0,
    pts:      off_rating,
    clutch, hustle, defense: {},
    players: bp, star_power,
    top_pie:          bp[0]?.pie     || 0,
    top_usg:          bp[0]?.usg_pct || 0,
    avg_net_rtg_top3: off_rating - def_rating,
    hustle_score:     r4(hustle.score),
    // Form data
    win_rate:        f.win_rate    ?? 0,
    win_rate5:       f.win_rate5   ?? 0,
    win_rate10:      f.win_rate10  ?? 0,
    avg_diff:        f.avg_diff    ?? 0,
    avg_diff5:       f.avg_diff5   ?? 0,
    avg_diff10:      f.avg_diff10  ?? 0,
    momentum:        f.momentum    ?? 0,
    streak:          f.streak      ?? 0,
    avg_pts:         f.avg_pts     ?? off_rating,
    avg_pts_allowed: f.avg_pts_allowed ?? def_rating,
    home_win_rate:   f.home_win_rate   ?? null,
    away_win_rate:   f.away_win_rate   ?? null,
    home_net_rtg:    f.home_net_rtg    ?? null,
    away_net_rtg:    f.away_net_rtg    ?? null,
    rest_days:       f.rest_days ?? 2,
    is_b2b:          f.is_b2b    ?? false,
    altitude_ft: 0, timezone: "",
    pts_per_game:     e.pts_per_game     || off_rating,
    opp_pts_per_game: e.opp_pts_per_game || def_rating,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── BUILD DELTAS ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
const LEAGUE_AVG_PTS = 112;

function buildDeltas(home, away) {
  const hp = r4(home.off_rating + (away.def_rating - LEAGUE_AVG_PTS) / 2);
  const ap = r4(away.off_rating + (home.def_rating - LEAGUE_AVG_PTS) / 2);
  const re = clamp((home.rest_days-away.rest_days)*0.015,-0.06,0.06) + (away.is_b2b?0.04:0) - (home.is_b2b?0.04:0);
  const hwR = home.home_win_rate ?? home.win_rate;
  const aaR = away.away_win_rate ?? away.win_rate;

  return {
    net_diff:           r4(home.net_rating  - away.net_rating),
    predicted_spread:   r4(ap - hp),
    home_predicted_pts: hp > 80 ? hp : 0,
    away_predicted_pts: ap > 80 ? ap : 0,
    pie_edge:           r4((home.pie    ||0)-(away.pie    ||0)),
    ts_edge:            r4((home.ts_pct ||0)-(away.ts_pct ||0)),
    efg_edge:           r4((home.efg_pct||0)-(away.efg_pct||0)),
    shot_quality_edge:  r4((home.efg_pct||0)-(away.efg_pct||0)),
    three_matchup_edge: r4((home.fg3_rate||0)-(away.fg3_rate||0)),
    rim_edge:           r4((home.ftr    ||0)-(away.ftr    ||0)),
    tov_edge:           r4((away.tov_pct||0)-(home.tov_pct||0)),
    ast_to_edge:        r4((home.ast_to ||0)-(away.ast_to ||0)),
    oreb_edge:          r4((home.oreb_pct||0)-(away.oreb_pct||0)),
    dreb_edge:          0,
    clutch_w_pct_edge:  r4(home.clutch.w_pct     - away.clutch.w_pct),
    clutch_pm_edge:     r4(home.clutch.plus_minus - away.clutch.plus_minus),
    clutch_ft_edge:     r4(home.clutch.ft_pct     - away.clutch.ft_pct),
    hustle_edge:        r4(home.hustle.score      - away.hustle.score),
    contested_edge:     r4(home.hustle.contested_shots - away.hustle.contested_shots),
    charges_edge:       r4(home.hustle.charges_drawn   - away.hustle.charges_drawn),
    pace_edge:          r4((home.pace-away.pace)*0.003),
    pace_mismatch:      Math.abs(home.pace-away.pace),
    variance_factor:    r4((home.fg3_rate+away.fg3_rate)/2),
    star_power_edge:    r4(home.star_power-away.star_power),
    pie_player_edge:    r4((home.top_pie||0)-(away.top_pie||0)),
    net_rtg_top3_edge:  r4(home.avg_net_rtg_top3-away.avg_net_rtg_top3),
    form_edge:          r4((home.win_rate10||0)-(away.win_rate10||0)),
    diff5_edge:         r4((home.avg_diff5 ||0)-(away.avg_diff5 ||0)),
    momentum_edge:      r4((home.momentum  ||0)-(away.momentum  ||0)),
    streak_edge:        clamp(((home.streak||0)-(away.streak||0))*0.015,-0.06,0.06),
    rest_edge:          r4(re),
    home_rest:          home.rest_days, away_rest: away.rest_days,
    home_b2b:           home.is_b2b,   away_b2b:  away.is_b2b,
    split_prob:         clamp(((hwR??0.5)+(1-(aaR??0.5)))/2, 0.25, 0.75),
    home_home_wr:       hwR, away_away_wr: aaR,
    home_home_net:      home.home_net_rtg,
    away_away_net:      away.away_net_rtg,
    ref_impact: 0, travel_fatigue: 0, nba_service_used: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── MAIN EXPORT ──────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════
async function getAdvancedMatchup(homeTeam, awayTeam) {
  const season    = getCurrentSeason();
  const prevSzn   = getPreviousSeason(season);
  const nbaHomeId = getNbaTeamId(homeTeam);
  const nbaAwayId = getNbaTeamId(awayTeam);

  console.log(`[adv] ${homeTeam} vs ${awayTeam} — fetching all sources...`);

  // ── Resolve IDs concurrently ─────────────────────────────────────────────
  const [homeEspnId, awayEspnId, homeBdlId, awayBdlId] = await Promise.allSettled([
    Promise.resolve(getEspnId(homeTeam)),
    Promise.resolve(getEspnId(awayTeam)),
    getBdlTeamId(homeTeam),
    getBdlTeamId(awayTeam),
  ]).then(rs => rs.map(r => r.status === "fulfilled" ? r.value : null));

  // ── Fire ALL sources concurrently ────────────────────────────────────────
  const [
    homeEspnStats, awayEspnStats,
    standings,
    homeBdlGames,  awayBdlGames,
    clutchRows,    hustleRows,
    homeNbaGL,     awayNbaGL,
    homeEspnSched, awayEspnSched,
    homePlayersBdl, awayPlayersBdl,
    homeRecentStats, awayRecentStats,
    homeEspnRoster,  awayEspnRoster,
  ] = await Promise.allSettled([
    fetchEspnTeamStats(homeEspnId),
    fetchEspnTeamStats(awayEspnId),
    fetchEspnStandings(),
    homeBdlId ? fetchBdlTeamGames(homeBdlId, getBdlSeason()) : Promise.resolve([]),
    awayBdlId ? fetchBdlTeamGames(awayBdlId, getBdlSeason()) : Promise.resolve([]),
    fetchLeagueClutch(season).catch(() => fetchLeagueClutch(prevSzn)),
    fetchLeagueHustle(season).catch(() => fetchLeagueHustle(prevSzn)),
    nbaHomeId ? fetchNbaGameLog(nbaHomeId, season).catch(()=>fetchNbaGameLog(nbaHomeId,prevSzn)) : Promise.resolve([]),
    nbaAwayId ? fetchNbaGameLog(nbaAwayId, season).catch(()=>fetchNbaGameLog(nbaAwayId,prevSzn)) : Promise.resolve([]),
    fetchEspnTeamSchedule(homeEspnId),
    fetchEspnTeamSchedule(awayEspnId),
    homeBdlId ? fetchBdlTeamPlayers(homeBdlId) : Promise.resolve([]),
    awayBdlId ? fetchBdlTeamPlayers(awayBdlId) : Promise.resolve([]),
    homeBdlId ? fetchBdlTeamRecentStats(homeBdlId) : Promise.resolve([]),
    awayBdlId ? fetchBdlTeamRecentStats(awayBdlId) : Promise.resolve([]),
    fetchEspnRosterStats(homeEspnId),
    fetchEspnRosterStats(awayEspnId),
  ]).then(rs => rs.map(r => r.status === "fulfilled" ? r.value : null));

  const sd = standings || {};

  // ── Team stats: 3-source waterfall ──────────────────────────────────────
  const homeStandingEntry = homeEspnId && sd[homeEspnId] ? sd[homeEspnId] : null;
  const awayStandingEntry = awayEspnId && sd[awayEspnId] ? sd[awayEspnId] : null;
  const homeBdlAgg        = aggregateBdlTeamGames(homeBdlGames || [], homeBdlId);
  const awayBdlAgg        = aggregateBdlTeamGames(awayBdlGames || [], awayBdlId);

  const homeAdv = buildAdvFromSources(homeEspnStats, homeStandingEntry, homeBdlAgg);
  const awayAdv = buildAdvFromSources(awayEspnStats, awayStandingEntry, awayBdlAgg);

  console.log(`[adv] Team stats — home: ${homeAdv ? `${homeAdv.off_rating?.toFixed(1)} off / ${homeAdv.def_rating?.toFixed(1)} def` : "fallback to BDL"}`);
  console.log(`[adv] Team stats — away: ${awayAdv ? `${awayAdv.off_rating?.toFixed(1)} off / ${awayAdv.def_rating?.toFixed(1)} def` : "fallback to BDL"}`);

  // ── Game logs: BDL games → NBA Stats → ESPN schedule ────────────────────
  const homeFormRaw = (homeBdlGames?.length ? homeBdlGames : null)
                   || (homeNbaGL?.length    ? homeNbaGL    : null)
                   || (homeEspnSched?.length ? homeEspnSched: null)
                   || [];
  const awayFormRaw = (awayBdlGames?.length ? awayBdlGames : null)
                   || (awayNbaGL?.length    ? awayNbaGL    : null)
                   || (awayEspnSched?.length ? awayEspnSched: null)
                   || [];

  const isBdlFormat = r => typeof r.home_team_score !== "undefined";
  const homeForm = homeFormRaw.length
    ? (isBdlFormat(homeFormRaw[0]) ? aggregateBdlTeamGames(homeFormRaw, homeBdlId) : analyzeFormData(homeFormRaw))
    : {};
  const awayForm = awayFormRaw.length
    ? (isBdlFormat(awayFormRaw[0]) ? aggregateBdlTeamGames(awayFormRaw, awayBdlId) : analyzeFormData(awayFormRaw))
    : {};

  console.log(`[adv] Form — home: ${homeForm?.games||0} games, away: ${awayForm?.games||0} games`);

  // ── Player stats: BDL season avgs → BDL recent agg → ESPN roster ────────
  const homePIds = (homePlayersBdl||[]).map(p=>p.id).filter(Boolean);
  const awayPIds = (awayPlayersBdl||[]).map(p=>p.id).filter(Boolean);

  const [homeAvgs, awayAvgs] = await Promise.all([
    homePIds.length ? fetchBdlSeasonAverages(homePIds) : Promise.resolve([]),
    awayPIds.length ? fetchBdlSeasonAverages(awayPIds) : Promise.resolve([]),
  ]);

  // Build player rows — prefer season avgs, fall back to recent stats, then ESPN roster
  function resolvePlayerRows(seasonAvgs, bdlPlayers, recentStats, espnRoster) {
    // Source 1: BDL season averages merged with player info
    if (seasonAvgs?.length && bdlPlayers?.length) {
      const avgMap = {};
      for (const a of seasonAvgs) {
        const id = a.player_id || a.player?.id;
        if (id) avgMap[id] = a;
      }
      const merged = bdlPlayers.map(p => {
        const a = avgMap[p.id];
        if (!a) return null;
        return {
          name: `${p.first_name||""} ${p.last_name||""}`.trim(),
          pts: flt(a.pts), reb: flt(a.reb??(flt(a.oreb)+flt(a.dreb))),
          ast: flt(a.ast), stl: flt(a.stl), blk: flt(a.blk),
          fgm: flt(a.fgm), fga: flt(a.fga), fg3m: flt(a.fg3m),
          ftm: flt(a.ftm), fta: flt(a.fta),
          min: flt(a.min), turnover: flt(a.turnover||a.tov),
        };
      }).filter(Boolean);
      if (merged.length >= 3) return merged;
    }
    // Source 2: BDL recent game aggregation
    if (recentStats?.length >= 3) return recentStats;
    // Source 3: ESPN roster
    if (espnRoster?.length >= 3) return espnRoster;
    return [];
  }

  const homePlayerRows = resolvePlayerRows(homeAvgs, homePlayersBdl, homeRecentStats, homeEspnRoster);
  const awayPlayerRows = resolvePlayerRows(awayAvgs, awayPlayersBdl, awayRecentStats, awayEspnRoster);

  console.log(`[adv] Players — home: ${homePlayerRows.length}, away: ${awayPlayerRows.length}`);

  const homePlayers = buildPlayersFromStats(homePlayerRows, homeAdv);
  const awayPlayers = buildPlayersFromStats(awayPlayerRows, awayAdv);

  // ── Build final profiles ─────────────────────────────────────────────────
  const homeData = buildProfile(homeTeam, homeAdv, homeForm, clutchRows||[], hustleRows||[], homePlayers);
  const awayData = buildProfile(awayTeam, awayAdv, awayForm, clutchRows||[], hustleRows||[], awayPlayers);
  const matchup  = buildDeltas(homeData, awayData);

  // ── H2H ──────────────────────────────────────────────────────────────────
  const h2hGames = (homeBdlId && awayBdlId)
    ? await fetchH2H(homeBdlId, awayBdlId).catch(()=>[])
    : [];
  const h2h = computeH2H(h2hGames, homeBdlId);

  console.log(`[adv] Final — home ORtg=${homeData.off_rating} DRtg=${homeData.def_rating} | away ORtg=${awayData.off_rating} DRtg=${awayData.def_rating}`);
  console.log(`[adv] Predicted: ${matchup.home_predicted_pts?.toFixed(1)} — ${matchup.away_predicted_pts?.toFixed(1)}`);

  return {
    matchup, homeData, awayData,
    homeId: homeBdlId, awayId: awayBdlId,
    h2h,
    homeOnOff: [], awayOnOff: [],
    dataSource: {
      nbaServiceAvailable: false,
      espnAvailable:       !!(homeAdv?.off_rating > 0),
      bdlPlayersAvailable: homePlayers.length > 0,
      bdlH2HAvailable:     h2hGames.length > 0,
      sources: {
        teamStats:   homeAdv ? (homeEspnStats ? "ESPN" : homeStandingEntry ? "ESPN standings" : "BDL games") : "none",
        gameLogs:    homeFormRaw.length > 0 ? (homeBdlGames?.length ? "BDL" : homeNbaGL?.length ? "NBA Stats" : "ESPN") : "none",
        playerStats: homePlayerRows.length > 0 ? (homeAvgs?.length ? "BDL season avgs" : homeRecentStats?.length ? "BDL recent" : "ESPN roster") : "none",
      },
    },
  };
}

module.exports = { getAdvancedMatchup, getCurrentSeason };
