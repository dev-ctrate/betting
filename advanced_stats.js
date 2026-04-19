"use strict";

/**
 * advanced_stats.js  v7
 *
 * FULLY SELF-CONTAINED. No require("./nba_service") — all NBA Stats API
 * calls are inlined here so there are zero extra file dependencies.
 *
 * Data sources:
 *   1. NBA Stats API (stats.nba.com) — official ORtg/DRtg/NetRtg/Pace/PIE/
 *      clutch/hustle/shot quality/player stats. Same data as Python nba_api.
 *   2. BallDontLie — H2H current season + game logs for rest/form.
 */

const BDL_KEY = process.env.BALLDONTLIE_API_KEY || "";

// ─── cache ─────────────────────────────────────────────────────────────────────
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
const avg   = arr => { const n = arr.filter(v => Number.isFinite(v)); return n.length ? n.reduce((s, v) => s + v, 0) / n.length : 0; };
const flt   = (v, fb = 0) => { const n = Number(v); return Number.isFinite(n) ? n : fb; };

function getCurrentSeason() {
  const d = new Date(); const m = d.getUTCMonth() + 1;
  return m >= 10
    ? `${d.getUTCFullYear()}-${String(d.getUTCFullYear() + 1).slice(2)}`
    : `${d.getUTCFullYear() - 1}-${String(d.getUTCFullYear()).slice(2)}`;
}

// ─── NBA Stats API ─────────────────────────────────────────────────────────────
const NBA_HEADERS = {
  "User-Agent":        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer":           "https://www.nba.com/",
  "Origin":            "https://www.nba.com",
  "Accept":            "application/json, text/plain, */*",
  "Accept-Language":   "en-US,en;q=0.9",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token":  "true",
  "Connection":        "keep-alive",
};

async function nbaFetch(endpoint, params = {}, ms = 20000) {
  const sp  = new URLSearchParams(params);
  const url = `https://stats.nba.com/stats/${endpoint}?${sp}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: NBA_HEADERS, signal: ctrl.signal });
    if (!res.ok) throw new Error(`NBA Stats ${res.status} for ${endpoint}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function parseRS(json, idx = 0) {
  try {
    const rs = json?.resultSets?.[idx] || json?.resultSet;
    if (!rs) return [];
    const hdrs = rs.headers || [];
    return (rs.rowSet || []).map(row =>
      Object.fromEntries(hdrs.map((h, i) => [h, row[i]]))
    );
  } catch { return []; }
}

function findRow(rows, teamName) {
  const tgt = norm(teamName);
  let r = rows.find(r => norm(r.TEAM_NAME || r.TEAM || "") === tgt);
  if (r) return r;
  const nick = tgt.split(" ").pop() || "";
  if (nick.length > 3) r = rows.find(r => norm(r.TEAM_NAME || r.TEAM || "").includes(nick));
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
  const match = Object.entries(NBA_TEAM_IDS).find(([n]) => norm(n).includes(nick));
  return match?.[1] || null;
}

// ─── league-wide fetchers (all 30 teams, cached 6h) ───────────────────────────
async function fetchLeagueAdvanced(season) {
  const k = `nba:adv:${season}`;
  const h = cg(k); if (h) return h;
  try {
    console.log(`[adv_stats] Fetching NBA advanced stats ${season}...`);
    const json = await nbaFetch("leaguedashteamstats", {
      Season: season, SeasonType: "Regular Season",
      MeasureType: "Advanced", PerMode: "PerGame",
      PaceAdjust: "N", PlusMinus: "N", Rank: "N",
      LeagueID: "00",
    });
    const rows = parseRS(json);
    console.log(`[adv_stats] Got ${rows.length} team advanced rows`);
    return cs(k, rows, TTL_LEAGUE);
  } catch (e) {
    console.error("[adv_stats] fetchLeagueAdvanced failed:", e.message);
    return [];
  }
}

async function fetchLeagueBase(season) {
  const k = `nba:base:${season}`;
  const h = cg(k); if (h) return h;
  try {
    const json = await nbaFetch("leaguedashteamstats", {
      Season: season, SeasonType: "Regular Season",
      MeasureType: "Base", PerMode: "PerGame", LeagueID: "00",
    });
    return cs(k, parseRS(json), TTL_LEAGUE);
  } catch (e) {
    console.error("[adv_stats] fetchLeagueBase failed:", e.message);
    return [];
  }
}

async function fetchLeagueClutch(season) {
  const k = `nba:clutch:${season}`;
  const h = cg(k); if (h) return h;
  try {
    const json = await nbaFetch("leaguedashteamclutch", {
      Season: season, SeasonType: "Regular Season",
      MeasureType: "Base", PerMode: "PerGame",
      ClutchTime: "Last 5 Minutes", AheadBehind: "Ahead or Behind",
      PointDiff: 5, LeagueID: "00",
    });
    return cs(k, parseRS(json), TTL_LEAGUE);
  } catch (e) {
    console.error("[adv_stats] fetchLeagueClutch failed:", e.message);
    return [];
  }
}

async function fetchLeagueHustle(season) {
  const k = `nba:hustle:${season}`;
  const h = cg(k); if (h) return h;
  try {
    const json = await nbaFetch("leaguehustlestatsTeam", {
      Season: season, SeasonType: "Regular Season", PerMode: "PerGame", LeagueID: "00",
    });
    return cs(k, parseRS(json), TTL_LEAGUE);
  } catch (e) {
    console.error("[adv_stats] fetchLeagueHustle failed:", e.message);
    return [];
  }
}

async function fetchLeagueDefense(season) {
  const k = `nba:def:${season}`;
  const h = cg(k); if (h) return h;
  try {
    const results = {};
    const cats = ["Overall", "2 Pointers", "3 Pointers", "Less Than 6Ft", "Greater Than 15Ft"];
    for (const cat of cats) {
      try {
        const json = await nbaFetch("leaguedashptteamdefend", {
          Season: season, SeasonType: "Regular Season",
          PerMode: "PerGame", DefenseCategory: cat, LeagueID: "00",
        });
        for (const r of parseRS(json)) {
          const tn = r.TEAM_NAME || "";
          if (!results[tn]) results[tn] = {};
          results[tn][cat] = {
            freq:        flt(r.FREQ),
            fg_pct:      flt(r.FG_PCT),
            fg_pct_diff: flt(r.FG_PCT_DIFF),
          };
        }
      } catch { /* skip this category */ }
    }
    const data = Object.entries(results).map(([TEAM_NAME, zones]) => ({ TEAM_NAME, zones }));
    return cs(k, data, TTL_LEAGUE);
  } catch (e) {
    console.error("[adv_stats] fetchLeagueDefense failed:", e.message);
    return [];
  }
}

async function fetchLeaguePlayers(season) {
  const k = `nba:players:${season}`;
  const h = cg(k); if (h) return h;
  try {
    const json = await nbaFetch("leaguedashplayerstats", {
      Season: season, SeasonType: "Regular Season",
      MeasureType: "Advanced", PerMode: "PerGame", LeagueID: "00",
    });
    return cs(k, parseRS(json), TTL_PLAYER);
  } catch (e) {
    console.error("[adv_stats] fetchLeaguePlayers failed:", e.message);
    return [];
  }
}

async function fetchTeamGameLog(teamId, season) {
  const k = `nba:gl:${teamId}:${season}`;
  const h = cg(k); if (h) return h;
  try {
    const json = await nbaFetch("teamgamelogs", {
      TeamID: teamId, Season: season,
      SeasonType: "Regular Season", LeagueID: "00",
    });
    const rows = parseRS(json);
    for (const r of rows) {
      r.OPP_PTS = flt(r.PTS) - flt(r.PLUS_MINUS);
    }
    return cs(k, rows.slice(-25), TTL_GAME);
  } catch (e) {
    console.error(`[adv_stats] fetchTeamGameLog ${teamId} failed:`, e.message);
    return [];
  }
}

async function fetchOnOff(teamId, season) {
  const k = `nba:onoff:${teamId}:${season}`;
  const h = cg(k); if (h) return h;
  try {
    const json = await nbaFetch("teamplayeronoffdetails", {
      TeamID: teamId, Season: season, SeasonType: "Regular Season",
      MeasureType: "Advanced", PerMode: "PerGame", LeagueID: "00",
    });
    const onRows  = parseRS(json, 1);
    const offRows = parseRS(json, 2);
    const players = {};
    for (const r of onRows) {
      const name = r.VS_PLAYER_NAME || r.PLAYER_NAME || "";
      if (!name) continue;
      if (!players[name]) players[name] = {};
      players[name].on = { ortg: flt(r.OFF_RATING), drtg: flt(r.DEF_RATING), net: flt(r.NET_RATING), min: flt(r.MIN) };
    }
    for (const r of offRows) {
      const name = r.VS_PLAYER_NAME || r.PLAYER_NAME || "";
      if (!name) continue;
      if (!players[name]) players[name] = {};
      players[name].off = { ortg: flt(r.OFF_RATING), drtg: flt(r.DEF_RATING), net: flt(r.NET_RATING), min: flt(r.MIN) };
    }
    const result = [];
    for (const [name, d] of Object.entries(players)) {
      if (!d.on || !d.off) continue;
      const total = Math.max(d.on.min + d.off.min, 1);
      const mf = d.on.min / total;
      result.push({
        player_name:  name,
        ortg_impact:  r4((d.on.ortg - d.off.ortg) * mf),
        drtg_impact:  r4((d.on.drtg - d.off.drtg) * mf),
        net_impact:   r4((d.on.net  - d.off.net)  * mf),
        on_net:       d.on.net,
        off_net:      d.off.net,
        min_fraction: r4(mf),
      });
    }
    result.sort((a, b) => Math.abs(b.net_impact) - Math.abs(a.net_impact));
    return cs(k, result, TTL_PLAYER);
  } catch (e) {
    console.error(`[adv_stats] fetchOnOff ${teamId} failed:`, e.message);
    return [];
  }
}

// ─── game log analysis ─────────────────────────────────────────────────────────
function analyzeGameLog(games) {
  if (!games?.length) return {};
  const diffs = [], pts_s = [], pts_a = [], home_wl = [], away_wl = [];
  let streak = 0;

  for (const g of games) {
    const pts  = flt(g.PTS);
    const opp  = flt(g.OPP_PTS);
    const diff = pts - opp;
    const won  = g.WL === "W";
    const matchup = String(g.MATCHUP || "");
    const isHome  = matchup.includes("vs.");
    diffs.push(diff); pts_s.push(pts); pts_a.push(opp);
    if (isHome) home_wl.push(won); else away_wl.push(won);
  }

  for (const g of [...games].reverse()) {
    const won = g.WL === "W";
    if (streak === 0) { streak = won ? 1 : -1; continue; }
    if ((streak > 0) === won) streak += streak > 0 ? 1 : -1;
    else break;
  }

  const n    = diffs.length;
  const wr   = diffs.filter(d => d > 0).length / n;
  const wr5  = diffs.slice(-5).filter(d => d > 0).length / Math.min(5, n);
  const wr10 = diffs.slice(-10).filter(d => d > 0).length / Math.min(10, n);

  let rest_days = 2, is_b2b = false;
  const lastDate = games[games.length - 1]?.GAME_DATE;
  if (lastDate) {
    try {
      const ld = new Date(lastDate);
      const today = new Date(); today.setHours(0, 0, 0, 0);
      rest_days = Math.max(0, Math.round((today - ld) / 86400000));
      is_b2b = rest_days <= 1;
    } catch {}
  }

  const hDiffs = games.filter(g => String(g.MATCHUP || "").includes("vs.")).map(g => flt(g.PTS) - flt(g.OPP_PTS));
  const aDiffs = games.filter(g => String(g.MATCHUP || "").includes("@")).map(g => flt(g.PTS) - flt(g.OPP_PTS));

  return {
    games:         n,
    win_rate:      r4(wr),
    win_rate5:     r4(wr5),
    win_rate10:    r4(wr10),
    avg_diff:      r4(avg(diffs)),
    avg_diff5:     r4(avg(diffs.slice(-5))),
    avg_diff10:    r4(avg(diffs.slice(-10))),
    momentum:      r4(wr5 - wr),
    streak,
    avg_pts:          r4(avg(pts_s)),
    avg_pts_allowed:  r4(avg(pts_a)),
    home_win_rate:    home_wl.length ? r4(home_wl.filter(Boolean).length / home_wl.length) : null,
    away_win_rate:    away_wl.length ? r4(away_wl.filter(Boolean).length / away_wl.length) : null,
    home_net_rtg:     hDiffs.length ? r4(avg(hDiffs)) : null,
    away_net_rtg:     aDiffs.length ? r4(avg(aDiffs)) : null,
    rest_days, is_b2b,
  };
}

// ─── build team profile from NBA Stats rows ────────────────────────────────────
function buildProfile(teamName, advRows, baseRows, clutchRows, hustleRows, defRows, playerRows, form) {
  const a  = findRow(advRows,    teamName) || {};
  const b  = findRow(baseRows,   teamName) || {};
  const cl = findRow(clutchRows, teamName) || {};
  const hs = findRow(hustleRows, teamName) || {};
  const f  = form || {};

  // Find defense zones
  const tgt = norm(teamName);
  const nick = tgt.split(" ").pop() || "";
  const dr = defRows.find(r => {
    const tn = norm(r.TEAM_NAME || "");
    return tn === tgt || (nick.length > 3 && tn.includes(nick));
  });

  // Core efficiency — official NBA opponent-adjusted numbers
  const off_rating = flt(a.OFF_RATING, 0) || flt(a.E_OFF_RATING, 0) || 0;
  const def_rating = flt(a.DEF_RATING, 0) || flt(a.E_DEF_RATING, 0) || 0;
  const net_rating = flt(a.NET_RATING, 0) || flt(a.E_NET_RATING, 0) || (off_rating - def_rating);
  const pace       = flt(a.PACE, 0) || flt(a.E_PACE, 0) || 0;
  const pie        = flt(a.PIE, 0);
  const ts_pct     = flt(a.TS_PCT, 0);
  const efg_pct    = flt(a.EFG_PCT, 0);
  const tov_pct    = flt(a.TM_TOV_PCT, 0);
  const oreb_pct   = flt(a.OREB_PCT, 0);
  const dreb_pct   = flt(a.DREB_PCT, 0);
  const ast_to     = flt(a.AST_TO, 0);
  const poss       = flt(a.POSS, pace);

  const pts     = flt(b.PTS, 0);
  const fg_pct  = flt(b.FG_PCT, 0);
  const fg3_pct = flt(b.FG3_PCT, 0);
  const ft_pct  = flt(b.FT_PCT, 0);
  const fga     = flt(b.FGA, 0);
  const fg3a    = flt(b.FG3A, 0);
  const fta     = flt(b.FTA, 0);
  const stl     = flt(b.STL, 0);
  const blk     = flt(b.BLK, 0);
  const tov_r   = flt(b.TOV, 0);
  const w_pct   = flt(b.W_PCT, 0);
  const gp      = Math.round(flt(b.GP, 0));
  const ftr     = fga > 0 ? fta / fga : 0;
  const fg3_rate = fga > 0 ? fg3a / fga : 0;

  const clutch = {
    w_pct:      flt(cl.W_PCT,      f.win_rate || 0),
    plus_minus: flt(cl.PLUS_MINUS, 0),
    fg_pct:     flt(cl.FG_PCT,     fg_pct),
    ft_pct:     flt(cl.FT_PCT,     ft_pct),
    fg3_pct:    flt(cl.FG3_PCT,    fg3_pct),
  };

  const hs_score = flt(hs.CONTESTED_SHOTS, 0) * 0.8 + flt(hs.CHARGES_DRAWN, 0) * 4 +
                   flt(hs.SCREEN_AST_PTS, 0) * 0.2 + flt(hs.BOX_OUTS, 0) * 0.4;
  const hustle = {
    score:           r4(hs_score),
    contested_shots: flt(hs.CONTESTED_SHOTS, 0),
    contested_3pt:   flt(hs.CONTESTED_SHOTS_3PT, 0),
    charges_drawn:   flt(hs.CHARGES_DRAWN, 0),
    screen_ast_pts:  flt(hs.SCREEN_AST_PTS, 0),
    box_outs:        flt(hs.BOX_OUTS, 0),
  };

  const defense = {};
  if (dr?.zones) {
    const z = dr.zones;
    defense.overall_fg_pct_allowed = z["Overall"]?.fg_pct           || 0;
    defense.rim_fg_pct_allowed     = z["Less Than 6Ft"]?.fg_pct     || 0;
    defense.mid_fg_pct_allowed     = z["Greater Than 15Ft"]?.fg_pct || 0;
    defense.three_fg_pct_allowed   = z["3 Pointers"]?.fg_pct        || 0;
    defense.three_freq_allowed     = z["3 Pointers"]?.freq          || 0;
    defense.rim_freq_allowed       = z["Less Than 6Ft"]?.freq       || 0;
  }

  // Players — ONLY players on THIS team, filtered by TEAM_NAME from NBA Stats
  const teamPlayers = playerRows.filter(p => {
    const ptn = norm(p.TEAM_NAME || "");
    return ptn === tgt || (nick.length > 3 && ptn.includes(nick));
  }).sort((a, b) => flt(b.MIN) - flt(a.MIN)).slice(0, 8);

  const players = teamPlayers.map(p => ({
    name:       p.PLAYER_NAME || "",
    min:        flt(p.MIN),
    off_rating: flt(p.OFF_RATING, 0),
    def_rating: flt(p.DEF_RATING, 0),
    net_rating: flt(p.NET_RATING, 0),
    ts_pct:     flt(p.TS_PCT, 0),
    efg_pct:    flt(p.EFG_PCT, 0),
    usg_pct:    flt(p.USG_PCT, 0),
    ast_to:     flt(p.AST_TO, 0),
    pie:        flt(p.PIE, 0),
    star_score: flt(p.USG_PCT, 0) * Math.max(flt(p.OFF_RATING, 0) - 100, 0) + flt(p.PIE, 0) * 30,
  }));
  players.sort((a, b) => b.star_score - a.star_score);

  const star_power = players.reduce((s, p, i) => s + p.star_score / (i + 1), 0);

  return {
    team: teamName, gp, w_pct,
    off_rating, def_rating, net_rating, pace, poss, pie,
    ts_pct, efg_pct, tov_pct, oreb_pct, dreb_pct,
    ast_to, fg_pct, fg3_pct, ft_pct, ftr, fg3_rate,
    pts, stl, blk, tov: tov_r,
    stl_rate: poss > 0 ? stl / poss * 100 : 0,
    blk_rate: fga > 0 ? blk / fga : 0,
    clutch, hustle, defense,
    players, star_power,
    top_pie:          players[0]?.pie     || 0,
    top_usg:          players[0]?.usg_pct || 0,
    avg_net_rtg_top3: players.length >= 3 ? players.slice(0, 3).reduce((s, p) => s + p.net_rating, 0) / 3 : net_rating,
    // Form from game log
    win_rate:        f.win_rate    ?? w_pct,
    win_rate5:       f.win_rate5   ?? w_pct,
    win_rate10:      f.win_rate10  ?? w_pct,
    avg_diff:        f.avg_diff    ?? 0,
    avg_diff5:       f.avg_diff5   ?? 0,
    avg_diff10:      f.avg_diff10  ?? 0,
    momentum:        f.momentum    ?? 0,
    streak:          f.streak      ?? 0,
    avg_pts:         f.avg_pts     ?? pts,
    avg_pts_allowed: f.avg_pts_allowed ?? (def_rating * 0.97),
    home_win_rate:   f.home_win_rate   ?? null,
    away_win_rate:   f.away_win_rate   ?? null,
    home_net_rtg:    f.home_net_rtg    ?? null,
    away_net_rtg:    f.away_net_rtg    ?? null,
    rest_days:       f.rest_days ?? 2,
    is_b2b:          f.is_b2b    ?? false,
    altitude_ft: 0,
    timezone:    "",
  };
}

// ─── matchup deltas ─────────────────────────────────────────────────────────────
function buildDeltas(home, away) {
  const hp = home.off_rating * (away.def_rating / 100);
  const ap = away.off_rating * (home.def_rating / 100);
  const re = clamp((home.rest_days - away.rest_days) * 0.015, -0.06, 0.06)
           + (away.is_b2b ? 0.04 : 0) - (home.is_b2b ? 0.04 : 0);
  const ts  = home.star_power + away.star_power;
  const hwR = home.home_win_rate ?? home.win_rate;
  const aaR = away.away_win_rate ?? away.win_rate;

  const hDef = home.defense || {}, aDef = away.defense || {};
  const sq = ((home.ts_pct || 0) - (aDef.overall_fg_pct_allowed || 0) * 1.15)
           - ((away.ts_pct || 0) - (hDef.overall_fg_pct_allowed || 0) * 1.15);
  const tm = ((home.fg3_pct || 0) - (aDef.three_fg_pct_allowed || 0))
           - ((away.fg3_pct || 0) - (hDef.three_fg_pct_allowed || 0));

  return {
    net_diff:             r4(home.net_rating    - away.net_rating),
    predicted_spread:     r4(hp - ap),
    home_predicted_pts:   r4(hp),
    away_predicted_pts:   r4(ap),
    pie_edge:             r4((home.pie    || 0) - (away.pie    || 0)),
    ts_edge:              r4((home.ts_pct || 0) - (away.ts_pct || 0)),
    efg_edge:             r4((home.efg_pct|| 0) - (away.efg_pct|| 0)),
    shot_quality_edge:    r4(sq),
    three_matchup_edge:   r4(tm),
    rim_edge:             r4((home.ftr    || 0) - (away.ftr    || 0)),
    tov_edge:             r4((away.tov_pct|| 0) - (home.tov_pct|| 0)),
    ast_to_edge:          r4((home.ast_to || 0) - (away.ast_to || 0)),
    oreb_edge:            r4((home.oreb_pct||0) - (away.oreb_pct||0)),
    dreb_edge:            r4((home.dreb_pct||0) - (away.dreb_pct||0)),
    clutch_w_pct_edge:    r4(home.clutch.w_pct      - away.clutch.w_pct),
    clutch_pm_edge:       r4(home.clutch.plus_minus  - away.clutch.plus_minus),
    clutch_ft_edge:       r4(home.clutch.ft_pct      - away.clutch.ft_pct),
    hustle_edge:          r4(home.hustle.score       - away.hustle.score),
    contested_edge:       r4(home.hustle.contested_shots - away.hustle.contested_shots),
    charges_edge:         r4(home.hustle.charges_drawn   - away.hustle.charges_drawn),
    pace_edge:            r4((home.pace - away.pace) * 0.003),
    pace_mismatch:        Math.abs(home.pace - away.pace),
    variance_factor:      r4((home.fg3_rate + away.fg3_rate) / 2),
    star_power_edge:      r4(ts > 0 ? (home.star_power - away.star_power) / ts : 0),
    pie_player_edge:      r4((home.top_pie || 0) - (away.top_pie || 0)),
    net_rtg_top3_edge:    r4(home.avg_net_rtg_top3 - away.avg_net_rtg_top3),
    form_edge:            r4((home.win_rate10 || 0) - (away.win_rate10 || 0)),
    diff5_edge:           r4((home.avg_diff5  || 0) - (away.avg_diff5  || 0)),
    momentum_edge:        r4((home.momentum   || 0) - (away.momentum   || 0)),
    streak_edge:          clamp(((home.streak||0) - (away.streak||0)) * 0.015, -0.06, 0.06),
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
    ref_impact:           0,
    travel_fatigue:       0,
    nba_service_used:     true,
  };
}

// ─── BDL H2H ───────────────────────────────────────────────────────────────────
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
    const all = bdlRows(r).filter(g => {
      const ids = [g.home_team?.id, g.home_team_id, g.visitor_team?.id, g.visitor_team_id].filter(Boolean);
      return ids.includes(homeId) && ids.includes(awayId) &&
             String(g.status || "").toLowerCase().includes("final");
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
  const n = diffs.length, avgD = avg(diffs), wr = wins / n;
  return { games: n, winRate: r4(wr), avgDiff: r4(avgD), h2h_prob: clamp(0.5 + avgD * 0.012 + (wr - 0.5) * 0.18, 0.22, 0.78) };
}

// ─── main export ───────────────────────────────────────────────────────────────
async function getAdvancedMatchup(homeTeam, awayTeam) {
  const season  = getCurrentSeason();
  const homeNbaId = getNbaTeamId(homeTeam);
  const awayNbaId = getNbaTeamId(awayTeam);

  // Fetch NBA Stats data + BDL team IDs in parallel
  const [
    advRows, baseRows, clutchRows, hustleRows, defRows, playerRows,
    homeGL, awayGL, homeOO, awayOO,
    homeId, awayId,
  ] = await Promise.allSettled([
    fetchLeagueAdvanced(season),
    fetchLeagueBase(season),
    fetchLeagueClutch(season),
    fetchLeagueHustle(season),
    fetchLeagueDefense(season),
    fetchLeaguePlayers(season),
    homeNbaId ? fetchTeamGameLog(homeNbaId, season) : Promise.resolve([]),
    awayNbaId ? fetchTeamGameLog(awayNbaId, season) : Promise.resolve([]),
    homeNbaId ? fetchOnOff(homeNbaId, season)       : Promise.resolve([]),
    awayNbaId ? fetchOnOff(awayNbaId, season)       : Promise.resolve([]),
    resolveBdlTeamId(homeTeam),
    resolveBdlTeamId(awayTeam),
  ]).then(rs => rs.map(r => r.status === "fulfilled" ? r.value : (Array.isArray(r.reason) ? [] : null)));

  const homeForm = analyzeGameLog(homeGL || []);
  const awayForm = analyzeGameLog(awayGL || []);

  const homeData = buildProfile(homeTeam, advRows || [], baseRows || [], clutchRows || [], hustleRows || [], defRows || [], playerRows || [], homeForm);
  const awayData = buildProfile(awayTeam, advRows || [], baseRows || [], clutchRows || [], hustleRows || [], defRows || [], playerRows || [], awayForm);
  const matchup  = buildDeltas(homeData, awayData);

  // H2H from BDL
  const h2hGames = (homeId && awayId) ? await fetchH2H(homeId, awayId).catch(() => []) : [];
  const h2h = computeH2H(h2hGames, homeId);

  console.log(`[adv_stats] ${homeTeam} ORtg=${homeData.off_rating?.toFixed(1)} DRtg=${homeData.def_rating?.toFixed(1)} Net=${homeData.net_rating?.toFixed(1)} | ${awayTeam} ORtg=${awayData.off_rating?.toFixed(1)} DRtg=${awayData.def_rating?.toFixed(1)} Net=${awayData.net_rating?.toFixed(1)}`);

  return {
    matchup, homeData, awayData,
    homeId, awayId,
    h2h,
    homeOnOff: homeOO || [],
    awayOnOff: awayOO || [],
    refProfile: null,
    dataSource: {
      nbaServiceAvailable: !!(advRows?.length),
      bdlH2HAvailable:     h2hGames.length > 0,
    }
  };
}

module.exports = { getAdvancedMatchup, resolveTeamId: resolveBdlTeamId, getCurrentSeason };
