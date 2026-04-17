const BALLDONTLIE_API_KEY = process.env.BALLDONTLIE_API_KEY || "";

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function round(num) {
  if (!Number.isFinite(num)) return null;
  return Math.round(num * 1000) / 1000;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`BALLDONTLIE request failed ${res.status}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from BALLDONTLIE: ${text.slice(0, 300)}`);
  }
}

function requireBallDontLieKey() {
  if (!BALLDONTLIE_API_KEY) {
    throw new Error("Missing BALLDONTLIE_API_KEY");
  }
}

function buildHeaders() {
  return {
    Authorization: BALLDONTLIE_API_KEY
  };
}

function normalizeRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

function parseClockToSeconds(clock) {
  if (typeof clock === "number" && Number.isFinite(clock)) {
    return clamp(clock, 0, 12 * 60);
  }

  if (typeof clock !== "string") return null;

  const trimmed = clock.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(":").map(Number);
  if (parts.length !== 2 || parts.some(x => !Number.isFinite(x))) return null;

  return clamp(parts[0] * 60 + parts[1], 0, 12 * 60);
}

function teamLooseMatch(sourceText, teamName) {
  if (!sourceText || !teamName) return false;

  const hay = String(sourceText).toLowerCase();
  const target = teamName.toLowerCase();

  if (hay.includes(target)) return true;

  const words = target.split(" ").filter(Boolean);
  const lastWord = words[words.length - 1] || "";

  if (lastWord && hay.includes(lastWord)) return true;

  const aliases = {
    "Atlanta Hawks": ["hawks", "atl", "atlanta"],
    "Boston Celtics": ["celtics", "bos", "boston"],
    "Brooklyn Nets": ["nets", "bkn", "brooklyn"],
    "Charlotte Hornets": ["hornets", "cha", "charlotte"],
    "Chicago Bulls": ["bulls", "chi", "chicago"],
    "Cleveland Cavaliers": ["cavaliers", "cavs", "cle", "cleveland"],
    "Dallas Mavericks": ["mavericks", "mavs", "dal", "dallas"],
    "Denver Nuggets": ["nuggets", "den", "denver"],
    "Detroit Pistons": ["pistons", "det", "detroit"],
    "Golden State Warriors": ["warriors", "gsw", "golden state"],
    "Houston Rockets": ["rockets", "hou", "houston"],
    "Indiana Pacers": ["pacers", "ind", "indiana"],
    "Los Angeles Clippers": ["clippers", "lac", "la clippers"],
    "Los Angeles Lakers": ["lakers", "lal", "la lakers"],
    "Memphis Grizzlies": ["grizzlies", "mem", "memphis"],
    "Miami Heat": ["heat", "mia", "miami"],
    "Milwaukee Bucks": ["bucks", "mil", "milwaukee"],
    "Minnesota Timberwolves": ["timberwolves", "wolves", "min", "minnesota"],
    "New Orleans Pelicans": ["pelicans", "nop", "no", "new orleans"],
    "New York Knicks": ["knicks", "nyk", "new york"],
    "Oklahoma City Thunder": ["thunder", "okc", "oklahoma city"],
    "Orlando Magic": ["magic", "orl", "orlando"],
    "Philadelphia 76ers": ["76ers", "sixers", "phi", "philadelphia"],
    "Phoenix Suns": ["suns", "phx", "phoenix"],
    "Portland Trail Blazers": ["trail blazers", "blazers", "por", "portland"],
    "Sacramento Kings": ["kings", "sac", "sacramento"],
    "San Antonio Spurs": ["spurs", "sas", "san antonio"],
    "Toronto Raptors": ["raptors", "tor", "toronto"],
    "Utah Jazz": ["jazz", "uta", "utah"],
    "Washington Wizards": ["wizards", "was", "washington"]
  };

  return (aliases[teamName] || []).some(a => hay.includes(a));
}

function inferPeriod(gameLike) {
  const candidates = [
    gameLike?.period,
    gameLike?.quarter,
    gameLike?.game?.period,
    gameLike?.game?.quarter
  ];

  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return 1;
}

function inferClock(gameLike) {
  const candidates = [
    gameLike?.clock,
    gameLike?.gameClock,
    gameLike?.time_remaining,
    gameLike?.timeRemaining,
    gameLike?.game?.clock
  ];

  for (const c of candidates) {
    const sec = parseClockToSeconds(c);
    if (sec != null) return sec;
  }

  return null;
}

async function getLiveGames() {
  requireBallDontLieKey();

  const url = "https://api.balldontlie.io/v1/games?per_page=100";
  const raw = await fetchJson(url, { headers: buildHeaders() });
  return normalizeRows(raw);
}

function findMatchingGame(games, gameId, homeTeam, awayTeam) {
  if (!Array.isArray(games)) return null;

  let match = null;

  if (gameId) {
    match = games.find(g => String(g.id) === String(gameId));
    if (match) return match;
  }

  match = games.find(g => {
    const hay = JSON.stringify(g);
    return teamLooseMatch(hay, homeTeam) && teamLooseMatch(hay, awayTeam);
  });

  return match || null;
}

async function getLiveBoxScore(gameId) {
  requireBallDontLieKey();

  const url = `https://api.balldontlie.io/v1/box_scores/live?game_ids[]=${encodeURIComponent(gameId)}`;
  const raw = await fetchJson(url, { headers: buildHeaders() });
  return normalizeRows(raw);
}

async function getLivePlays(gameId) {
  requireBallDontLieKey();

  const url = `https://api.balldontlie.io/v1/plays?game_ids[]=${encodeURIComponent(gameId)}&per_page=100`;
  const raw = await fetchJson(url, { headers: buildHeaders() });
  return normalizeRows(raw);
}

function inferScoresFromGame(game, homeTeam, awayTeam) {
  const homeScore = Number(game?.home_team_score ?? game?.homeScore ?? 0);
  const awayScore = Number(game?.visitor_team_score ?? game?.awayScore ?? 0);

  if (Number.isFinite(homeScore) && Number.isFinite(awayScore)) {
    return { homeScore, awayScore };
  }

  const teams = game?.teams || [];
  if (Array.isArray(teams)) {
    let h = null;
    let a = null;

    for (const t of teams) {
      const name = String(t?.name || t?.full_name || "").trim();
      const score = Number(t?.score ?? t?.points ?? t?.pts);

      if (!Number.isFinite(score)) continue;
      if (name === homeTeam) h = score;
      if (name === awayTeam) a = score;
    }

    if (Number.isFinite(h) && Number.isFinite(a)) {
      return { homeScore: h, awayScore: a };
    }
  }

  return { homeScore: 0, awayScore: 0 };
}

function inferScoresFromBoxScore(boxRows, homeTeam, awayTeam, fallback) {
  if (!Array.isArray(boxRows) || !boxRows.length) return fallback;

  const grouped = {};

  for (const row of boxRows) {
    const teamName = String(
      row?.team?.full_name ||
      row?.team?.name ||
      row?.team_name ||
      ""
    ).trim();

    const pts = Number(row?.team?.score ?? row?.score ?? row?.points ?? row?.pts);

    if (!teamName || !Number.isFinite(pts)) continue;
    grouped[teamName] = pts;
  }

  const homeScore = grouped[homeTeam];
  const awayScore = grouped[awayTeam];

  if (Number.isFinite(homeScore) && Number.isFinite(awayScore)) {
    return { homeScore, awayScore };
  }

  return fallback;
}

function buildRunFromPlays(plays, homeTeam, awayTeam) {
  if (!Array.isArray(plays) || !plays.length) {
    return {
      homeRun: 0,
      awayRun: 0,
      netRun: 0,
      momentumAdj: 0,
      pacePressureAdj: 0
    };
  }

  const last = plays.slice(-12);

  let homeRun = 0;
  let awayRun = 0;
  let scoringEvents = 0;

  for (const play of last) {
    const description = String(
      play?.description ||
      play?.text ||
      play?.event ||
      play?.msg ||
      ""
    ).toLowerCase();

    const pts = Number(play?.points ?? play?.pts ?? play?.score_value ?? 0) || 0;
    const teamName = String(
      play?.team?.full_name ||
      play?.team?.name ||
      play?.team_name ||
      play?.team ||
      ""
    ).trim();

    if (pts > 0) scoringEvents += 1;

    const looksHome = teamName === homeTeam || description.includes(homeTeam.toLowerCase());
    const looksAway = teamName === awayTeam || description.includes(awayTeam.toLowerCase());

    if (looksHome) homeRun += pts;
    if (looksAway) awayRun += pts;
  }

  const netRun = homeRun - awayRun;

  return {
    homeRun,
    awayRun,
    netRun,
    momentumAdj: clamp(netRun * 0.0035, -0.05, 0.05),
    pacePressureAdj: clamp((scoringEvents - 5) * 0.003, -0.02, 0.02)
  };
}

async function getLiveTrackerData({ gameId, homeTeam, awayTeam }) {
  requireBallDontLieKey();

  const games = await getLiveGames();
  const matchedGame = findMatchingGame(games, gameId, homeTeam, awayTeam);

  if (!matchedGame) {
    return {
      gameId,
      homeTeam,
      awayTeam,
      period: 1,
      clock: "12:00",
      homeScore: 0,
      awayScore: 0,
      plays: [],
      recentPlays: [],
      liveFound: false
    };
  }

  const resolvedGameId = matchedGame.id;
  const baseScores = inferScoresFromGame(matchedGame, homeTeam, awayTeam);

  const [boxRows, plays] = await Promise.all([
    getLiveBoxScore(resolvedGameId).catch(() => []),
    getLivePlays(resolvedGameId).catch(() => [])
  ]);

  const scores = inferScoresFromBoxScore(boxRows, homeTeam, awayTeam, baseScores);
  const runState = buildRunFromPlays(plays, homeTeam, awayTeam);

  return {
    gameId: resolvedGameId,
    liveFound: true,
    homeTeam,
    awayTeam,
    period: inferPeriod(matchedGame),
    clock: matchedGame?.clock || "12:00",
    clockSec: inferClock(matchedGame),
    homeScore: scores.homeScore,
    awayScore: scores.awayScore,
    scoreDiff: round(scores.homeScore - scores.awayScore),
    plays,
    recentPlays: plays.slice(-20),
    boxScoreRows: boxRows,
    homeRun: runState.homeRun,
    awayRun: runState.awayRun,
    netRun: runState.netRun,
    momentumAdj: runState.momentumAdj,
    pacePressureAdj: runState.pacePressureAdj,
    rawGame: matchedGame
  };
}

module.exports = {
  getLiveTrackerData
};