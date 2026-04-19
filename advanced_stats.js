"use strict";

/**
 * advanced_stats.js  v6
 *
 * Uses nba_service.js (JavaScript NBA Stats API) as PRIMARY source.
 * BDL used only for H2H current season.
 */

const { getNbaMatchup, getCurrentSeason } = require("./nba_service");

const BDL_KEY = process.env.BALLDONTLIE_API_KEY || "";
const TTL_BDL = 20 * 60 * 1000;
const TTL_TEAM = 24 * 60 * 60 * 1000;

const _c = new Map();
const cg = k => { const h = _c.get(k); if (!h) return null; if (Date.now() > h.e) { _c.delete(k); return null; } return h.v; };
const cs = (k, v, t) => { _c.set(k, { v, e: Date.now() + t }); return v; };

const r4 = n => Math.round(n * 10000) / 10000;
const sn = (v, f = 0) => { const n = Number(v); return Number.isFinite(n) ? n : f; };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

// ─── BDL for H2H ─────────────────────────────────────────────────────────────
async function bdlFetch(path) {
  if (!BDL_KEY) throw new Error("Missing BALLDONTLIE_API_KEY");
  const res = await fetch(`https://api.balldontlie.io/v1${path}`, {
    headers: { Authorization: BDL_KEY }, signal: AbortSignal.timeout(12000)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`BDL ${res.status}`);
  return JSON.parse(txt);
}
const bdlRows = p => Array.isArray(p) ? p : Array.isArray(p?.data) ? p.data : [];

async function getAllBdlTeams() {
  const k = "bdl:teams"; const h = cg(k); if (h) return h;
  try { return cs(k, bdlRows(await bdlFetch("/teams?per_page=100")), TTL_TEAM); }
  catch { return []; }
}

async function resolveBdlTeamId(name) {
  const teams = await getAllBdlTeams();
  const tgt = norm(name);
  let m = teams.find(t => norm(t.full_name) === tgt);
  if (m) return m.id;
  const nick = tgt.split(" ").pop() || "";
  if (nick.length > 3) m = teams.find(t => norm(t.full_name).includes(nick));
  return m?.id || null;
}

async function fetchH2H(homeId, awayId) {
  const season = getCurrentSeason();
  const k = `bdl:h2h:${homeId}:${awayId}:${season}`;
  const h = cg(k); if (h) return h;
  try {
    const r = await bdlFetch(
      `/games?team_ids[]=${homeId}&team_ids[]=${awayId}&seasons[]=${season}&per_page=100&postseason=false`
    );
    const bdlSeason = Number(season.split("-")[0]);
    const all = bdlRows(r).filter(g => {
      const ids = [g.home_team?.id, g.home_team_id, g.visitor_team?.id, g.visitor_team_id].filter(Boolean);
      return ids.includes(homeId) && ids.includes(awayId) &&
             String(g.status || "").toLowerCase().includes("final");
    }).slice(-8);
    return cs(k, all, TTL_BDL);
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
  const n = diffs.length, avgD = diffs.reduce((s, v) => s + v, 0) / n, wr = wins / n;
  return { games: n, winRate: r4(wr), avgDiff: r4(avgD), h2h_prob: clamp(0.5 + avgD * 0.012 + (wr - 0.5) * 0.18, 0.22, 0.78) };
}

// ─── Main export ──────────────────────────────────────────────────────────────
async function getAdvancedMatchup(homeTeam, awayTeam) {
  // Primary: NBA Stats API via nba_service.js
  const [nbaData, homeId, awayId] = await Promise.all([
    getNbaMatchup(homeTeam, awayTeam).catch(e => { console.warn("[adv_stats] NBA service:", e.message); return null; }),
    resolveBdlTeamId(homeTeam).catch(() => null),
    resolveBdlTeamId(awayTeam).catch(() => null),
  ]);

  // H2H from BDL
  const h2hGames = (homeId && awayId) ? await fetchH2H(homeId, awayId).catch(() => []) : [];
  const h2h = computeH2H(h2hGames, homeId);

  if (!nbaData) {
    console.warn("[adv_stats] No NBA data available for", homeTeam, "vs", awayTeam);
    return null;
  }

  const homeData = nbaData.home;
  const awayData = nbaData.away;
  const matchup  = nbaData.deltas;

  // Attach ref profile if available
  matchup.ref_impact    = 0;
  matchup.travel_fatigue = 0;

  console.log(`[adv_stats] ${homeTeam} net=${homeData.net_rating?.toFixed(1)} | ${awayTeam} net=${awayData.net_rating?.toFixed(1)} | H2H: ${h2h ? h2h.games + " games" : "none"}`);

  return {
    matchup, homeData, awayData,
    homeId, awayId,
    h2h,
    homeOnOff: nbaData.home_on_off || [],
    awayOnOff: nbaData.away_on_off || [],
    refProfile: null,
    dataSource: {
      nbaServiceAvailable: true,
      bdlH2HAvailable: h2hGames.length > 0,
    }
  };
}

module.exports = { getAdvancedMatchup, resolveTeamId: resolveBdlTeamId, getCurrentSeason };
