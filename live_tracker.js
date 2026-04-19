"use strict";

/**
 * live_tracker.js
 *
 * Fetches live game state from the NBA Stats scoreboard API (cdn.nba.com).
 * This is the same data source that powers the NBA app — real-time scores,
 * period, clock, and play-by-play.
 *
 * No API key required. Free. Updates every ~30 seconds during games.
 */

const CACHE_TTL = 20 * 1000; // 20 seconds
const _cache = new Map();

function cacheGet(k) {
  const h = _cache.get(k);
  if (!h) return null;
  if (Date.now() > h.e) { _cache.delete(k); return null; }
  return h.v;
}
function cacheSet(k, v, ttl) { _cache.set(k, { v, e: Date.now() + ttl }); return v; }

const NBA_HEADERS = {
  "User-Agent":        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Referer":           "https://www.nba.com/",
  "Origin":            "https://www.nba.com",
  "Accept":            "application/json, text/plain, */*",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token":  "true",
};

// Normalize team name for matching
const norm = s => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

// NBA team tricode → full name map
const TRICODE_MAP = {
  ATL: "Atlanta Hawks",      BOS: "Boston Celtics",     BKN: "Brooklyn Nets",
  CHA: "Charlotte Hornets",  CHI: "Chicago Bulls",      CLE: "Cleveland Cavaliers",
  DAL: "Dallas Mavericks",   DEN: "Denver Nuggets",     DET: "Detroit Pistons",
  GSW: "Golden State Warriors", HOU: "Houston Rockets", IND: "Indiana Pacers",
  LAC: "Los Angeles Clippers", LAL: "Los Angeles Lakers", MEM: "Memphis Grizzlies",
  MIA: "Miami Heat",         MIL: "Milwaukee Bucks",    MIN: "Minnesota Timberwolves",
  NOP: "New Orleans Pelicans", NYK: "New York Knicks",  OKC: "Oklahoma City Thunder",
  ORL: "Orlando Magic",      PHI: "Philadelphia 76ers", PHX: "Phoenix Suns",
  POR: "Portland Trail Blazers", SAC: "Sacramento Kings", SAS: "San Antonio Spurs",
  TOR: "Toronto Raptors",    UTA: "Utah Jazz",          WAS: "Washington Wizards",
};

// Fetch NBA live scoreboard
async function fetchNbaScoreboard() {
  const k = "nba:scoreboard";
  const h = cacheGet(k);
  if (h) return h;

  try {
    const url = "https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json";
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(url, { headers: NBA_HEADERS, signal: ctrl.signal });
      if (!res.ok) throw new Error(`Scoreboard HTTP ${res.status}`);
      const json = await res.json();
      return cacheSet(k, json, CACHE_TTL);
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    console.error("[live_tracker] fetchNbaScoreboard failed:", e.message);
    return null;
  }
}

// Fetch play-by-play for a specific game
async function fetchPlayByPlay(gameId) {
  if (!gameId) return null;
  const k = `nba:pbp:${gameId}`;
  const h = cacheGet(k);
  if (h) return h;

  try {
    const url = `https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${gameId}.json`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(url, { headers: NBA_HEADERS, signal: ctrl.signal });
      if (!res.ok) throw new Error(`PBP HTTP ${res.status}`);
      const json = await res.json();
      return cacheSet(k, json, CACHE_TTL);
    } finally {
      clearTimeout(t);
    }
  } catch (e) {
    console.error("[live_tracker] fetchPlayByPlay failed:", e.message);
    return null;
  }
}

// Parse clock string "PT08M23.00S" → seconds
function parseClock(clockStr) {
  if (!clockStr) return 720;
  const m = clockStr.match(/PT(\d+)M([\d.]+)S/);
  if (!m) return 720;
  return parseInt(m[1]) * 60 + parseFloat(m[2]);
}

// Match scoreboard game to our home/away teams
function matchGame(game, homeTeam, awayTeam) {
  const homeNorm = norm(homeTeam);
  const awayNorm = norm(awayTeam);

  const hTricode = game.homeTeam?.teamTricode || "";
  const aTricode = game.awayTeam?.teamTricode || "";
  const hFull = norm(TRICODE_MAP[hTricode] || game.homeTeam?.teamName || "");
  const aFull = norm(TRICODE_MAP[aTricode] || game.awayTeam?.teamName || "");

  // Match by last word (nickname) as fallback
  const lastWord = s => s.split(" ").pop() || "";

  const homeMatch = hFull === homeNorm || lastWord(hFull) === lastWord(homeNorm);
  const awayMatch = aFull === awayNorm || lastWord(aFull) === lastWord(awayNorm);

  return homeMatch && awayMatch;
}

// Determine momentum from recent plays
function buildMomentum(plays, homeTricode) {
  if (!plays || plays.length === 0) return { homeRun: 0, awayRun: 0 };
  const recent = plays.slice(-12);
  let homeRun = 0, awayRun = 0;
  for (const p of recent) {
    const desc = String(p.description || "").toLowerCase();
    const team = p.teamTricode || "";
    if (desc.includes("makes") || desc.includes("dunk") || desc.includes("layup") || desc.includes("free throw made")) {
      // Extract points from description or use shot type
      const pts = desc.includes("3pt") || desc.includes("three") ? 3 : desc.includes("free throw") ? 1 : 2;
      if (team === homeTricode) homeRun += pts;
      else awayRun += pts;
    }
  }
  return { homeRun, awayRun };
}

// Build recent plays for display
function buildRecentPlays(plays, homeTricode, awayTricode) {
  if (!plays) return [];
  return plays.slice(-20).reverse().map(p => ({
    clock:       p.clock || "",
    period:      p.period || 1,
    team:        p.teamTricode || "",
    description: p.description || "",
    isHomeTeam:  p.teamTricode === homeTricode,
    isScore:     String(p.description || "").toLowerCase().includes("makes") ||
                 String(p.description || "").toLowerCase().includes("dunk"),
    homeScore:   p.scoreHome !== undefined ? parseInt(p.scoreHome) : null,
    awayScore:   p.scoreAway !== undefined ? parseInt(p.scoreAway) : null,
  })).filter(p => p.description);
}

/**
 * Main export: get live game state.
 * Returns { liveFound, homeScore, awayScore, period, clockSec, clock, ... }
 */
async function getLiveTrackerData({ gameId, homeTeam, awayTeam }) {
  const fallback = {
    liveFound: false,
    homeScore: 0,
    awayScore: 0,
    period: 1,
    clockSec: 720,
    clock: "12:00",
    recentPlays: [],
    momentum: { homeRun: 0, awayRun: 0 },
    gameStatus: 1,
  };

  try {
    const scoreboard = await fetchNbaScoreboard();
    if (!scoreboard) return fallback;

    const games = scoreboard.scoreboard?.games || [];
    if (!games.length) {
      console.log("[live_tracker] No games on scoreboard today");
      return fallback;
    }

    // Find matching game
    let game = games.find(g => matchGame(g, homeTeam, awayTeam));

    // Fallback: try matching by gameId if provided
    if (!game && gameId) {
      game = games.find(g => g.gameId === gameId);
    }

    if (!game) {
      console.log(`[live_tracker] No scoreboard match for ${homeTeam} vs ${awayTeam}`);
      console.log("[live_tracker] Available games:", games.map(g => `${g.awayTeam?.teamTricode}@${g.homeTeam?.teamTricode} status=${g.gameStatus}`).join(", "));
      return fallback;
    }

    const gameStatus = game.gameStatus || 1; // 1=pre, 2=live, 3=final
    const homeScore  = parseInt(game.homeTeam?.score || 0);
    const awayScore  = parseInt(game.awayTeam?.score || 0);
    const period     = game.period || 1;
    const clockStr   = game.gameClock || "PT12M00.00S";
    const clockSec   = parseClock(clockStr);
    const nbaGameId  = game.gameId;

    const homeTricode = game.homeTeam?.teamTricode || "";
    const awayTricode = game.awayTeam?.teamTricode || "";

    // For pregame (status=1), still return liveFound:false
    if (gameStatus === 1) {
      console.log(`[live_tracker] Game not started yet (status=1)`);
      return { ...fallback, gameStatus: 1 };
    }

    // Fetch play-by-play for live games
    let recentPlays = [];
    let momentum = { homeRun: 0, awayRun: 0 };

    if (gameStatus === 2) {
      const pbpData = await fetchPlayByPlay(nbaGameId);
      const allPlays = pbpData?.game?.actions || [];
      recentPlays = buildRecentPlays(allPlays, homeTricode, awayTricode);
      momentum = buildMomentum(allPlays, homeTricode);
    }

    // Format clock for display
    const clockMin = Math.floor(clockSec / 60);
    const clockSecRem = Math.floor(clockSec % 60);
    const clockFormatted = `${clockMin}:${String(clockSecRem).padStart(2, "0")}`;

    const isLive = gameStatus === 2;
    const isFinal = gameStatus === 3;

    console.log(`[live_tracker] ${awayTeam} ${awayScore} @ ${homeTeam} ${homeScore} | Q${period} ${clockFormatted} | status=${gameStatus}`);

    return {
      liveFound:   isLive || isFinal,
      gameStatus,
      isLive,
      isFinal,
      homeScore,
      awayScore,
      period,
      clockSec,
      clock:       clockFormatted,
      homeTricode,
      awayTricode,
      nbaGameId,
      recentPlays,
      momentum,
      // Score diff for live model
      scoreDiff:   homeScore - awayScore,
      // Time remaining in seconds
      timeRemainingSec: Math.max(0, (4 - period) * 720 + clockSec),
    };

  } catch (e) {
    console.error("[live_tracker] Error:", e.message);
    return fallback;
  }
}

module.exports = { getLiveTrackerData };
