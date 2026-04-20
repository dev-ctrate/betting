"use strict";

/**
 * advanced_stats.js  v8
 *
 * stats.nba.com leaguedashteamstats returns zeros for 2025-26.
 *
 * Data sources:
 *   ESPN unofficial API  → pts/game, opp pts/game, FG%, 3P%, FT%, counting stats
 *   ESPN standings       → pts for/against per game (most reliable opp pts source)
 *   BallDontLie API      → active roster + player season averages
 *   stats.nba.com        → clutch, hustle, game log (still working ✓)
 */

const BDL_KEY = process.env.BALLDONTLIE_API_KEY || "";

// ─── cache ─────────────────────────────────────────────────────────────────────
const TTL_ESPN   = 15 * 60 * 1000;
const TTL_LEAGUE = 6  * 60 * 60 * 1000;
const TTL_GAME   = 20 * 60 * 1000;
const TTL_PLAYER = 30 * 60 * 1000;
const TTL_TEAM   = 24 * 60 * 60 * 1000;

const _cache = new Map();
const cg = k => {
  const h = _cache.get(k);
  if (!h) return null;
  if (Date.now() > h.e) { _cache.delete(k); return null; }
  return h.v;
};
const cs = (k, v, t) => { _cache.set(k, { v, e: Date.now() + t }); return v; };

// ─── helpers ───────────────────────────────────────────────────────────────────
const r4    = n => Math.round(n * 10000) / 10000;
const sn    = (v, f = 0) => { const n = Number(v); return Number.isFinite(n) ? n : f; };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const norm  = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
const avgArr= arr => { const n = (arr||[]).filter(v => Number.isFinite(v)); return n.length ? n.reduce((s, v) => s + v, 0) / n.length : 0; };
const flt   = (v, fb = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };

function getCurrentSeason() {
  const d = new Date(), m = d.getUTCMonth() + 1, y = d.getUTCFullYear();
  return m >= 10 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}
function getPreviousSeason(season) {
  const start = parseInt(season.split("-")[0], 10);
  return `${start - 1}-${String(start).slice(2)}`;
}
function getBdlSeason() {
  const d = new Date(), m = d.getUTCMonth() + 1, y = d.getUTCFullYear();
  return m >= 10 ? y : y - 1;
}

// ─── NBA Stats API fetch ───────────────────────────────────────────────────────
const NBA_HEADERS = {
  "User-Agent":         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer":            "https://www.nba.com/",
  "Origin":             "https://www.nba.com",
  "Accept":             "application/json, text/plain, */*",
  "Accept-Language":    "en-US,en;q=0.9",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token":  "true",
  "Connection":         "keep-alive",
};
async function nbaFetch(endpoint, params = {}, ms = 20000) {
  const url  = `https://stats.nba.com/stats/${endpoint}?${new URLSearchParams(params)}`;
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: NBA_HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error(`NBA ${res.status} ${endpoint}`);
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
function findRow(rows, teamName) {
  const tgt = norm(teamName), nick = tgt.split(" ").pop() || "";
  let r = rows.find(r => norm(r.TEAM_NAME || r.TEAM || "") === tgt);
  if (!r && nick.length > 3) r = rows.find(r => norm(r.TEAM_NAME || r.TEAM || "").includes(nick));
  return r || null;
}

// ─── NBA Team IDs ──────────────────────────────────────────────────────────────
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

// ─── ESPN fetch helper ─────────────────────────────────────────────────────────
async function espnFetch(url) {
  const ctrl = new AbortController();
  const t    = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, {
      headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ESPN ${res.status}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

// ─── ESPN: team ID lookup (dynamic, 24h cache) ────────────────────────────────
let _espnTeamMap = null;
async function getEspnTeamMap() {
  if (_espnTeamMap) return _espnTeamMap;
  const h = cg("espn:teammap"); if (h) { _espnTeamMap = h; return h; }
  try {
    const data = await espnFetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams?limit=35");
    const map  = {};
    for (const entry of data?.sports?.[0]?.leagues?.[0]?.teams || []) {
      const t = entry.team;
      if (!t?.id) continue;
      const full = norm(t.displayName || `${t.location} ${t.name}`);
      const nick = norm(t.name || "");
      const abbr = (t.abbreviation || "").toLowerCase();
      map[full] = t.id; if (nick) map[nick] = t.id; if (abbr) map[abbr] = t.id;
    }
    _espnTeamMap = map;
    return cs("espn:teammap", map, TTL_TEAM);
  } catch(e) { console.warn("[espn] Team map:", e.message); _espnTeamMap = {}; return {}; }
}
async function getEspnId(teamName) {
  const map = await getEspnTeamMap();
  const nm  = norm(teamName);
  return map[nm] || map[nm.split(" ").pop()] || null;
}

// ─── ESPN: standings (pts for/against) ────────────────────────────────────────
let _espnStandings = null, _espnStandingsTs = 0;
async function getEspnStandings() {
  if (_espnStandings && Date.now() - _espnStandingsTs < TTL_ESPN) return _espnStandings;
  const h = cg("espn:standings"); if (h) { _espnStandings = h; return h; }
  try {
    const data = await espnFetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/standings");
    const map  = {};
    for (const conf of data?.children || []) {
      for (const entry of conf?.standings?.entries || []) {
        const id = entry.team?.id;
        if (!id) continue;
        const stats = {};
        for (const s of entry.stats || []) stats[s.name] = flt(s.value);
        const gp = flt(stats.gamesPlayed || (stats.wins||0) + (stats.losses||0) || 1);
        // Handle both total and per-game values from ESPN
        const pf = stats.avgPointsFor    || (stats.pointsFor    > 1000 ? stats.pointsFor    / gp : stats.pointsFor    || 0);
        const pa = stats.avgPointsAgainst|| (stats.pointsAgainst > 1000 ? stats.pointsAgainst / gp : stats.pointsAgainst || 0);
        map[id] = { wins: flt(stats.wins), losses: flt(stats.losses), gp, ptsFor: flt(pf), ptsAgainst: flt(pa) };
      }
    }
    _espnStandings = map; _espnStandingsTs = Date.now();
    return cs("espn:standings", map, TTL_ESPN);
  } catch(e) { console.warn("[espn] Standings:", e.message); return {}; }
}

// ─── ESPN: team statistics (shooting %, per-game counting) ────────────────────
async function fetchEspnTeamStats(teamName) {
  const espnId = await getEspnId(teamName);
  if (!espnId) return null;
  const k = `espn:stats:${espnId}`, h = cg(k); if (h) return h;
  try {
    const data = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnId}/statistics`);
    const sm   = {};
    const cats = data?.results?.stats?.categories ||
                 data?.statistics?.splits?.categories ||
                 data?.statistics?.categories || [];
    for (const cat of cats)
      for (const s of cat.stats || [])
        if (s.name) sm[s.name] = typeof s.value === "number" ? s.value : flt(s.displayValue);
    for (const s of data?.results?.stats?.stats || [])
      if (s.name) sm[s.name] = typeof s.value === "number" ? s.value : flt(s.displayValue);
    return cs(k, sm, TTL_ESPN);
  } catch(e) { console.warn(`[espn] Stats ${teamName}:`, e.message); return null; }
}

// ─── ESPN: derive advanced stats ──────────────────────────────────────────────
function buildAdvFromEspn(sm, sd) {
  if (!sm && !sd) return null;
  const s = sm || {};

  // Points — ESPN stats first, standings fallback
  let pts     = flt(s.avgPoints || 0);
  let opp_pts = flt(s.avgPointsAllowed || s.oppAvgPoints || s.avgOpponentPoints || 0);
  if (sd) {
    if (!pts     && sd.ptsFor     > 80) pts     = sd.ptsFor;
    if (!opp_pts && sd.ptsAgainst > 80) opp_pts = sd.ptsAgainst;
  }
  if (!pts && !opp_pts) return null;

  // Per-game counting
  const fgm  = flt(s.avgFieldGoalsMade               || 0);
  const fga  = flt(s.avgFieldGoalsAttempted           || 0);
  const fg3m = flt(s.avgThreePointFieldGoalsMade      || 0);
  const fg3a = flt(s.avgThreePointFieldGoalsAttempted || 0);
  const ftm  = flt(s.avgFreeThrowsMade                || 0);
  const fta  = flt(s.avgFreeThrowsAttempted           || 0);
  const oreb = flt(s.avgOffRebounds                   || 0);
  const dreb = flt(s.avgDefRebounds                   || 0);
  const reb  = flt(s.avgRebounds || (oreb + dreb)     || 0);
  const ast  = flt(s.avgAssists                       || 0);
  const tov  = flt(s.avgTurnovers                     || 0);
  const stl  = flt(s.avgSteals                        || 0);
  const blk  = flt(s.avgBlocks                        || 0);

  // Derived advanced metrics
  const ts_pct   = (fga + 0.44 * fta) > 0 ? pts  / (2 * (fga + 0.44 * fta)) : 0;
  const efg_pct  = fga > 0 ? (fgm + 0.5 * fg3m) / fga : 0;
  const tov_pct  = (fga + 0.44 * fta + tov) > 0 ? 100 * tov / (fga + 0.44 * fta + tov) : 0;
  const oreb_pct = reb > 0 ? oreb / reb : 0;
  const ast_to   = tov > 0 ? ast / tov : 0;
  const ftr      = fga > 0 ? fta / fga : 0;
  const fg3_rate = fga > 0 ? fg3a / fga : 0;

  // Pace estimate (possessions formula)
  let pace = fga > 0 ? fga - oreb + tov + 0.44 * fta : 100;
  if (pace < 85 || pace > 120) pace = 100;

  // Ratings: pts/game ≈ ORtg at ~100 pace
  const off_rating = pts;
  const def_rating = opp_pts;
  const net_rating = off_rating - def_rating;

  // PIE proxy
  const pie = clamp((net_rating + 15) / 30 * 0.12 + ts_pct * 0.04, 0.01, 0.20);

  console.log(`[espn] ${teamName || "team"}: pts=${pts.toFixed(1)} opp=${opp_pts.toFixed(1)} TS%=${(ts_pct*100).toFixed(1)} pace=${pace.toFixed(0)}`);

  return {
    off_rating: r4(off_rating), def_rating: r4(def_rating), net_rating: r4(net_rating),
    pace: r4(pace), pie: r4(pie),
    ts_pct: r4(ts_pct), efg_pct: r4(efg_pct), tov_pct: r4(tov_pct),
    oreb_pct: r4(oreb_pct), ast_to: r4(ast_to), ftr: r4(ftr), fg3_rate: r4(fg3_rate),
    stl_rate: r4(stl), blk_rate: r4(fga > 0 ? blk / fga : 0),
    pts_per_game: r4(pts), opp_pts_per_game: r4(opp_pts),
    fgm, fga, fg3m, fg3a, ftm, fta, oreb, dreb, reb, ast, tov, stl, blk,
  };
}

// ─── BallDontLie: players ─────────────────────────────────────────────────────
let _bdlTeamMap = null;
async function getBdlTeamMap() {
  if (_bdlTeamMap) return _bdlTeamMap;
  const h = cg("bdl:teammap"); if (h) { _bdlTeamMap = h; return h; }
  if (!BDL_KEY) { _bdlTeamMap = {}; return {}; }
  try {
    const res  = await fetch("https://api.balldontlie.io/v1/teams?per_page=35",
      { headers: { Authorization: BDL_KEY }, signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    const rows = Array.isArray(data) ? data : (data?.data || []);
    const map  = {};
    for (const t of rows) {
      const f = norm(t.full_name || ""), n = norm(t.name || ""), a = (t.abbreviation||"").toLowerCase();
      if (f) map[f] = t.id; if (n) map[n] = t.id; if (a) map[a] = t.id;
    }
    _bdlTeamMap = map;
    return cs("bdl:teammap", map, TTL_TEAM);
  } catch(e) { console.warn("[bdl] Team map:", e.message); _bdlTeamMap = {}; return {}; }
}
async function getBdlTeamId(teamName) {
  const map = await getBdlTeamMap();
  const nm  = norm(teamName);
  return map[nm] || map[nm.split(" ").pop()] || null;
}
async function fetchBdlActivePlayers(teamName) {
  if (!BDL_KEY) return [];
  const teamId = await getBdlTeamId(teamName);
  if (!teamId) { console.warn(`[bdl] No team ID for ${teamName}`); return []; }
  const k = `bdl:players:${teamId}`, h = cg(k); if (h) return h;
  try {
    const res  = await fetch(`https://api.balldontlie.io/v1/players?team_ids[]=${teamId}&per_page=15`,
      { headers: { Authorization: BDL_KEY }, signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    const rows = Array.isArray(data) ? data : (data?.data || []);
    return cs(k, rows, TTL_PLAYER);
  } catch(e) { console.warn(`[bdl] Players ${teamName}:`, e.message); return []; }
}
async function fetchBdlSeasonAverages(playerIds) {
  if (!BDL_KEY || !playerIds.length) return [];
  const season = getBdlSeason();
  const idsQ   = playerIds.slice(0, 15).map(id => `player_ids[]=${id}`).join("&");
  const k = `bdl:avgs:${season}:${playerIds.slice(0,5).join(",")}`, h = cg(k); if (h) return h;
  for (const s of [season, season - 1]) {
    try {
      const res  = await fetch(`https://api.balldontlie.io/v1/season_averages?season=${s}&${idsQ}`,
        { headers: { Authorization: BDL_KEY }, signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      const rows = Array.isArray(data) ? data : (data?.data || []);
      if (rows.length) {
        console.log(`[bdl] Season averages season=${s} got ${rows.length} players`);
        return cs(k, rows, TTL_PLAYER);
      }
    } catch(e) { console.warn(`[bdl] Averages s=${s}:`, e.message); }
  }
  return [];
}
function buildPlayersFromBdl(bdlPlayers, bdlAvgs, teamAdv) {
  const avgMap = {};
  for (const a of bdlAvgs) { const id = a.player_id || a.player?.id; if (id) avgMap[id] = a; }
  const result = [];
  for (const p of bdlPlayers) {
    const a = avgMap[p.id];
    if (!a) continue;
    const pts = flt(a.pts||0), reb = flt(a.reb||(flt(a.oreb||0)+flt(a.dreb||0))||0);
    const ast = flt(a.ast||0), stl = flt(a.stl||0), blk = flt(a.blk||0);
    const tov = flt(a.turnover||a.tov||0);
    const fgm = flt(a.fgm||0), fga = flt(a.fga||0), fg3m = flt(a.fg3m||0);
    const ftm = flt(a.ftm||0), fta = flt(a.fta||0), min = flt(a.min||0);
    const ts_pct = (fga + 0.44*fta) > 0 ? pts/(2*(fga+0.44*fta)) : 0;
    const teamPts = teamAdv?.pts_per_game || 110;
    const usg_pct = (teamPts > 0 && min > 0) ? clamp(pts/teamPts*(5*min/240), 0, 0.40) : 0;
    const gamePts = (teamAdv?.pts_per_game||110) + (teamAdv?.opp_pts_per_game||110);
    const pie = gamePts > 0
      ? clamp((pts+reb+ast+stl+blk-(fga-fgm)-(fta-ftm)*0.44-tov)/gamePts, -0.1, 0.3)
      : 0;
    result.push({
      name:       `${p.first_name||""} ${p.last_name||""}`.trim(),
      min:        r4(min),
      off_rating: 0, def_rating: 0, net_rating: 0,
      ts_pct:     r4(clamp(ts_pct, 0, 1)),
      efg_pct:    fga > 0 ? r4((fgm+0.5*fg3m)/fga) : 0,
      usg_pct:    r4(usg_pct),
      pie:        r4(pie),
      star_score: usg_pct * Math.max(ts_pct-0.5, 0) * 50 + pie * 20,
    });
  }
  result.sort((a,b) => b.star_score - a.star_score);
  return result.slice(0, 8);
}

// ─── NBA Stats: clutch + hustle + game log (still working) ────────────────────
async function fetchLeagueClutch(season) {
  const k = `nba:clutch:${season}`, h = cg(k); if (h) return h;
  try {
    const j = await nbaFetch("leaguedashteamclutch", {
      Season: season, SeasonType: "Regular Season",
      ClutchTime: "Last 5 Minutes", PointDiff: "5", AheadBehind: "Ahead or Behind",
      MeasureType: "Base", PerMode: "PerGame", PlusMinus: "N", PaceAdjust: "N", Rank: "N",
      Month: "0", OpponentTeamID: "0", LastNGames: "0", Period: "0",
      DateFrom: "", DateTo: "", Outcome: "", Location: "", SeasonSegment: "",
      VsConference: "", VsDivision: "", GameScope: "", PlayerExperience: "", PlayerPosition: "", StarterBench: "",
    });
    return cs(k, parseRS(j), TTL_LEAGUE);
  } catch { return []; }
}
async function fetchLeagueHustle(season) {
  const k = `nba:hustle:${season}`, h = cg(k); if (h) return h;
  try {
    const j = await nbaFetch("leaguehustlestatsTeam", {
      Season: season, SeasonType: "Regular Season", PerMode: "PerGame",
      PaceAdjust: "N", Rank: "N", Month: "0", OpponentTeamID: "0", LastNGames: "0",
      DateFrom: "", DateTo: "", Outcome: "", Location: "", SeasonSegment: "",
      VsConference: "", VsDivision: "", College: "", Country: "", DraftYear: "",
      DraftPick: "", Height: "", Weight: "", PlayerExperience: "", PlayerPosition: "", StarterBench: "", TeamID: "0",
    });
    return cs(k, parseRS(j), TTL_LEAGUE);
  } catch { return []; }
}
async function fetchTeamGameLog(teamId, season) {
  const k = `nba:gl:${teamId}:${season}`, h = cg(k); if (h) return h;
  try {
    const j = await nbaFetch("teamgamelogs", {
      TeamID: teamId, Season: season, SeasonType: "Regular Season",
      MeasureType: "Base", PerMode: "PerGame", PlusMinus: "N", PaceAdjust: "N", Rank: "N",
      Outcome: "", Location: "", Month: "0", SeasonSegment: "", DateFrom: "", DateTo: "",
      OpponentTeamID: "0", VsConference: "", VsDivision: "", LastNGames: "0",
      Period: "0", GameSegment: "", LeagueID: "00",
    });
    return cs(k, parseRS(j), TTL_GAME);
  } catch { return []; }
}

// ─── game log analysis ─────────────────────────────────────────────────────────
function analyzeGameLog(games) {
  if (!games?.length) return {};
  const diffs = [], pts_s = [], pts_a = [], home_wl = [], away_wl = [];
  let streak = 0;
  for (const g of games) {
    const pts = flt(g.PTS), opp = flt(g.OPP_PTS), diff = pts - opp, won = g.WL === "W";
    const isHome = String(g.MATCHUP || "").includes("vs.");
    diffs.push(diff); pts_s.push(pts); pts_a.push(opp);
    if (isHome) home_wl.push(won); else away_wl.push(won);
  }
  for (const g of [...games].reverse()) {
    const won = g.WL === "W";
    if (streak === 0) { streak = won ? 1 : -1; continue; }
    if ((streak > 0) === won) streak += streak > 0 ? 1 : -1; else break;
  }
  const n = diffs.length;
  const wr = diffs.filter(d => d > 0).length / n;
  const wr5 = diffs.slice(-5).filter(d => d > 0).length / Math.min(5, n);
  const wr10= diffs.slice(-10).filter(d => d > 0).length / Math.min(10, n);
  let rest_days = 2, is_b2b = false;
  const lastDate = games[games.length - 1]?.GAME_DATE;
  if (lastDate) {
    try {
      const ld = new Date(lastDate), today = new Date(); today.setHours(0,0,0,0);
      rest_days = Math.max(0, Math.round((today - ld) / 86400000));
      is_b2b = rest_days <= 1;
    } catch {}
  }
  const hDiffs = games.filter(g => String(g.MATCHUP||"").includes("vs.")).map(g => flt(g.PTS)-flt(g.OPP_PTS));
  const aDiffs = games.filter(g => String(g.MATCHUP||"").includes("@")).map(g => flt(g.PTS)-flt(g.OPP_PTS));
  return {
    games: n, win_rate: r4(wr), win_rate5: r4(wr5), win_rate10: r4(wr10),
    avg_diff: r4(avgArr(diffs)), avg_diff5: r4(avgArr(diffs.slice(-5))),
    avg_diff10: r4(avgArr(diffs.slice(-10))), momentum: r4(wr5 - wr), streak,
    avg_pts: r4(avgArr(pts_s)), avg_pts_allowed: r4(avgArr(pts_a)),
    home_win_rate: home_wl.length ? r4(home_wl.filter(Boolean).length/home_wl.length) : null,
    away_win_rate: away_wl.length ? r4(away_wl.filter(Boolean).length/away_wl.length) : null,
    home_net_rtg:  hDiffs.length ? r4(avgArr(hDiffs)) : null,
    away_net_rtg:  aDiffs.length ? r4(avgArr(aDiffs)) : null,
    rest_days, is_b2b,
  };
}

// ─── build team profile ────────────────────────────────────────────────────────
function buildProfile(teamName, clutchRows, hustleRows, form, espnAdv, bdlPlayers) {
  const cl = findRow(clutchRows||[], teamName) || {};
  const hs = findRow(hustleRows||[], teamName) || {};
  const f  = form || {};
  const e  = espnAdv || {};
  const bp = bdlPlayers || [];

  const off_rating = e.off_rating || 0;
  const def_rating = e.def_rating || 0;
  const net_rating = e.net_rating || 0;
  const pace       = e.pace       || 100;
  const pie        = e.pie        || 0;
  const ts_pct     = e.ts_pct     || 0;
  const efg_pct    = e.efg_pct    || 0;
  const tov_pct    = e.tov_pct    || 0;
  const oreb_pct   = e.oreb_pct   || 0;
  const ast_to     = e.ast_to     || 0;
  const ftr        = e.ftr        || 0;
  const fg3_rate   = e.fg3_rate   || 0;
  const stl_rate   = e.stl_rate   || 0;
  const blk_rate   = e.blk_rate   || 0;

  const clutch = {
    w_pct:      flt(cl.W_PCT,      f.win_rate || 0),
    plus_minus: flt(cl.PLUS_MINUS, 0),
    fg_pct:     flt(cl.FG_PCT,     0),
    ft_pct:     flt(cl.FT_PCT,     0),
    fg3_pct:    flt(cl.FG3_PCT,    0),
  };

  const hs_score = flt(hs.CONTESTED_SHOTS,0)*0.8 + flt(hs.CHARGES_DRAWN,0)*4 +
                   flt(hs.SCREEN_AST_PTS,0)*0.2  + flt(hs.BOX_OUTS,0)*0.4;
  const hustle = {
    score:           r4(hs_score || flt(hs.HUSTLE_POINTS,0)),
    contested_shots: flt(hs.CONTESTED_SHOTS,0),
    charges_drawn:   flt(hs.CHARGES_DRAWN,0),
    screen_ast_pts:  flt(hs.SCREEN_AST_PTS,0),
    box_outs:        flt(hs.BOX_OUTS,0),
  };

  const star_power = bp.slice(0,3).reduce((s,p) => s+(p.star_score||0), 0);

  return {
    team: teamName,
    off_rating, def_rating, net_rating, pace, pie,
    ts_pct, efg_pct, tov_pct, oreb_pct, dreb_pct: 0,
    ast_to, ftr, fg3_rate, stl_rate, blk_rate,
    pts: off_rating,
    clutch, hustle, defense: {},
    players: bp, star_power,
    top_pie:          bp[0]?.pie     || 0,
    top_usg:          bp[0]?.usg_pct || 0,
    avg_net_rtg_top3: net_rating,
    hustle_score:     r4(hustle.score),
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
    pts_per_game:     e.pts_per_game     || 0,
    opp_pts_per_game: e.opp_pts_per_game || 0,
  };
}

// ─── matchup deltas ────────────────────────────────────────────────────────────
const LEAGUE_AVG_PTS = 112; // NBA league avg pts/game 2024-25

function buildDeltas(home, away) {
  // Additive predicted score model (works with pts/game OR per-100 ratings):
  // home_pts = home_offense + (away_defense_allowed - league_avg) / 2
  // Interpretation: good defense (below avg) reduces predicted score; bad defense raises it
  const hp = r4(home.off_rating + (away.def_rating - LEAGUE_AVG_PTS) / 2);
  const ap = r4(away.off_rating + (home.def_rating - LEAGUE_AVG_PTS) / 2);

  const re = clamp((home.rest_days - away.rest_days)*0.015, -0.06, 0.06)
           + (away.is_b2b ? 0.04 : 0) - (home.is_b2b ? 0.04 : 0);
  const hwR = home.home_win_rate ?? home.win_rate;
  const aaR = away.away_win_rate ?? away.win_rate;

  return {
    net_diff:           r4(home.net_rating    - away.net_rating),
    predicted_spread:   r4(ap - hp),
    home_predicted_pts: hp > 80 ? hp : 0,
    away_predicted_pts: ap > 80 ? ap : 0,
    pie_edge:           r4((home.pie    ||0) - (away.pie    ||0)),
    ts_edge:            r4((home.ts_pct ||0) - (away.ts_pct ||0)),
    efg_edge:           r4((home.efg_pct||0) - (away.efg_pct||0)),
    shot_quality_edge:  r4((home.efg_pct||0) - (away.efg_pct||0)),
    three_matchup_edge: r4((home.fg3_rate||0)- (away.fg3_rate||0)),
    rim_edge:           r4((home.ftr    ||0) - (away.ftr    ||0)),
    tov_edge:           r4((away.tov_pct||0) - (home.tov_pct||0)),
    ast_to_edge:        r4((home.ast_to ||0) - (away.ast_to ||0)),
    oreb_edge:          r4((home.oreb_pct||0)- (away.oreb_pct||0)),
    dreb_edge:          0,
    clutch_w_pct_edge:  r4(home.clutch.w_pct      - away.clutch.w_pct),
    clutch_pm_edge:     r4(home.clutch.plus_minus  - away.clutch.plus_minus),
    clutch_ft_edge:     r4(home.clutch.ft_pct      - away.clutch.ft_pct),
    hustle_edge:        r4(home.hustle.score       - away.hustle.score),
    contested_edge:     r4(home.hustle.contested_shots - away.hustle.contested_shots),
    charges_edge:       r4(home.hustle.charges_drawn   - away.hustle.charges_drawn),
    pace_edge:          r4((home.pace - away.pace)*0.003),
    pace_mismatch:      Math.abs(home.pace - away.pace),
    variance_factor:    r4((home.fg3_rate + away.fg3_rate) / 2),
    star_power_edge:    r4(home.star_power - away.star_power),
    pie_player_edge:    r4((home.top_pie||0) - (away.top_pie||0)),
    net_rtg_top3_edge:  r4(home.avg_net_rtg_top3 - away.avg_net_rtg_top3),
    form_edge:          r4((home.win_rate10||0) - (away.win_rate10||0)),
    diff5_edge:         r4((home.avg_diff5 ||0) - (away.avg_diff5 ||0)),
    momentum_edge:      r4((home.momentum  ||0) - (away.momentum  ||0)),
    streak_edge:        clamp(((home.streak||0)-(away.streak||0))*0.015, -0.06, 0.06),
    rest_edge:          r4(re),
    home_rest:          home.rest_days,
    away_rest:          away.rest_days,
    home_b2b:           home.is_b2b,
    away_b2b:           away.is_b2b,
    split_prob:         clamp(((hwR??0.5)+(1-(aaR??0.5)))/2, 0.25, 0.75),
    home_home_wr:       hwR,
    away_away_wr:       aaR,
    home_home_net:      home.home_net_rtg,
    away_away_net:      away.away_net_rtg,
    ref_impact: 0, travel_fatigue: 0, nba_service_used: false,
  };
}

// ─── BDL H2H ───────────────────────────────────────────────────────────────────
const bdlRows = p => Array.isArray(p) ? p : Array.isArray(p?.data) ? p.data : [];

async function getAllBdlTeams() {
  const k = "bdl:allteams", h = cg(k); if (h) return h;
  if (!BDL_KEY) return [];
  try {
    const res  = await fetch("https://api.balldontlie.io/v1/teams?per_page=100",
      { headers: { Authorization: BDL_KEY }, signal: AbortSignal.timeout(10000) });
    return cs(k, bdlRows(await res.json()), TTL_TEAM);
  } catch { return []; }
}
async function resolveBdlTeamId(name) {
  const teams = await getAllBdlTeams();
  const tgt   = norm(name), nick = tgt.split(" ").pop() || "";
  let m = teams.find(t => norm(t.full_name) === tgt);
  if (!m && nick.length > 3) m = teams.find(t => norm(t.full_name).includes(nick));
  return m?.id || null;
}
async function fetchH2H(homeId, awayId) {
  if (!BDL_KEY) return [];
  const season = getBdlSeason();
  const k = `bdl:h2h:${homeId}:${awayId}:${season}`, h = cg(k); if (h) return h;
  try {
    const res  = await fetch(
      `https://api.balldontlie.io/v1/games?team_ids[]=${homeId}&team_ids[]=${awayId}&seasons[]=${season}&per_page=100&postseason=false`,
      { headers: { Authorization: BDL_KEY }, signal: AbortSignal.timeout(10000) });
    const all = bdlRows(await res.json()).filter(g => {
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
    const my = isHome ? sn(g.home_team_score) : sn(g.visitor_team_score);
    const op = isHome ? sn(g.visitor_team_score) : sn(g.home_team_score);
    if (!my && !op) continue;
    const d = my - op; if (d > 0) wins++; diffs.push(d);
  }
  if (!diffs.length) return null;
  const n = diffs.length, avgD = avgArr(diffs), wr = wins / n;
  return { games: n, winRate: r4(wr), avgDiff: r4(avgD), h2h_prob: clamp(0.5 + avgD*0.012 + (wr-0.5)*0.18, 0.22, 0.78) };
}

// ─── main export ───────────────────────────────────────────────────────────────
async function getAdvancedMatchup(homeTeam, awayTeam) {
  const season     = getCurrentSeason();
  const prevSeason = getPreviousSeason(season);
  const homeNbaId  = getNbaTeamId(homeTeam);
  const awayNbaId  = getNbaTeamId(awayTeam);
  console.log(`[adv_stats] ${homeTeam} vs ${awayTeam} season=${season}`);

  // Fire everything concurrently
  const [
    clutchRows, hustleRows,
    homeGL, awayGL,
    homeEspnStats, awayEspnStats,
    standings,
    homeEspnId, awayEspnId,
    homeBdlPlayers, awayBdlPlayers,
    homeId, awayId,
  ] = await Promise.allSettled([
    fetchLeagueClutch(season).catch(()=>fetchLeagueClutch(prevSeason)),
    fetchLeagueHustle(season).catch(()=>fetchLeagueHustle(prevSeason)),
    homeNbaId ? fetchTeamGameLog(homeNbaId,season).catch(()=>fetchTeamGameLog(homeNbaId,prevSeason)) : Promise.resolve([]),
    awayNbaId ? fetchTeamGameLog(awayNbaId,season).catch(()=>fetchTeamGameLog(awayNbaId,prevSeason)) : Promise.resolve([]),
    fetchEspnTeamStats(homeTeam),
    fetchEspnTeamStats(awayTeam),
    getEspnStandings(),
    getEspnId(homeTeam),
    getEspnId(awayTeam),
    fetchBdlActivePlayers(homeTeam),
    fetchBdlActivePlayers(awayTeam),
    resolveBdlTeamId(homeTeam),
    resolveBdlTeamId(awayTeam),
  ]).then(rs => rs.map(r => r.status === "fulfilled" ? r.value : null));

  // Build ESPN advanced stats
  const sd        = standings || {};
  const homeEntry = homeEspnId && sd[homeEspnId] || null;
  const awayEntry = awayEspnId && sd[awayEspnId] || null;
  const homeAdv   = buildAdvFromEspn(homeEspnStats, homeEntry);
  const awayAdv   = buildAdvFromEspn(awayEspnStats, awayEntry);

  // Game log form
  const homeForm = analyzeGameLog(homeGL || []);
  const awayForm = analyzeGameLog(awayGL || []);

  // BDL player averages
  const homeBdlArr = Array.isArray(homeBdlPlayers) ? homeBdlPlayers : [];
  const awayBdlArr = Array.isArray(awayBdlPlayers) ? awayBdlPlayers : [];
  const [homeAvgs, awayAvgs] = await Promise.all([
    homeBdlArr.length ? fetchBdlSeasonAverages(homeBdlArr.map(p=>p.id)).catch(()=>[]) : Promise.resolve([]),
    awayBdlArr.length ? fetchBdlSeasonAverages(awayBdlArr.map(p=>p.id)).catch(()=>[]) : Promise.resolve([]),
  ]);
  const homePlayers = buildPlayersFromBdl(homeBdlArr, homeAvgs, homeAdv);
  const awayPlayers = buildPlayersFromBdl(awayBdlArr, awayAvgs, awayAdv);

  const homeData = buildProfile(homeTeam, clutchRows||[], hustleRows||[], homeForm, homeAdv, homePlayers);
  const awayData = buildProfile(awayTeam, clutchRows||[], hustleRows||[], awayForm, awayAdv, awayPlayers);
  const matchup  = buildDeltas(homeData, awayData);

  const h2hGames = (homeId && awayId) ? await fetchH2H(homeId, awayId).catch(()=>[]) : [];
  const h2h      = computeH2H(h2hGames, homeId);

  console.log(`[adv_stats] ORtg: ${homeTeam}=${homeData.off_rating} ${awayTeam}=${awayData.off_rating}`);
  console.log(`[adv_stats] Predicted: ${matchup.home_predicted_pts} — ${matchup.away_predicted_pts}`);
  console.log(`[adv_stats] Players: ${homeTeam}=${homePlayers.length} ${awayTeam}=${awayPlayers.length}`);

  return {
    matchup, homeData, awayData, homeId, awayId, h2h,
    homeOnOff: [], awayOnOff: [],
    dataSource: {
      nbaServiceAvailable: false,
      espnAvailable:       !!(homeAdv?.off_rating > 0),
      bdlPlayersAvailable: homePlayers.length > 0,
      bdlH2HAvailable:     h2hGames.length > 0,
    },
  };
}

module.exports = { getAdvancedMatchup, resolveTeamId: resolveBdlTeamId, getCurrentSeason };
