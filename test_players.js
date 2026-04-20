/**
 * Run: node test_players.js
 * Tests the exact player data chain for both teams
 */

const BDL_KEY = process.env.BALLDONTLIE_API_KEY || "";
if (!BDL_KEY) { console.error("❌ BALLDONTLIE_API_KEY not set"); process.exit(1); }

const HOME = process.argv[2] || "Cleveland Cavaliers";
const AWAY = process.argv[3] || "Toronto Raptors";

function getBdlSeason() {
  const d = new Date(), m = d.getUTCMonth() + 1, y = d.getUTCFullYear();
  return m >= 10 ? y : y - 1;
}
const bdlRows = p => Array.isArray(p) ? p : Array.isArray(p?.data) ? p.data : [];
async function bdl(path) {
  const res = await fetch(`https://api.balldontlie.io/v1${path}`, {
    headers: { Authorization: BDL_KEY }, signal: AbortSignal.timeout(12000)
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`BDL ${res.status}: ${txt.slice(0,100)}`);
  return JSON.parse(txt);
}

async function testTeam(teamName) {
  console.log(`\n──── ${teamName} ────`);
  const season = getBdlSeason();
  console.log(`Season: ${season}`);

  // Step 1: Find team ID
  const teams = bdlRows(await bdl("/teams?per_page=35"));
  const norm  = s => String(s||"").toLowerCase().replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ").trim();
  const nick  = norm(teamName).split(" ").pop();
  const team  = teams.find(t => norm(t.full_name) === norm(teamName) || norm(t.full_name).includes(nick));
  if (!team) { console.log(`❌ Team not found in BDL`); return; }
  console.log(`✅ Team: ${team.full_name} (ID=${team.id})`);

  // Step 2: Get roster players
  const players = bdlRows(await bdl(`/players?team_ids[]=${team.id}&per_page=20`));
  if (!players.length) { console.log(`❌ No players found`); return; }
  console.log(`✅ Roster: ${players.length} players (${players.slice(0,3).map(p=>`${p.first_name} ${p.last_name}`).join(", ")}...)`);

  // Step 3: Season averages
  const ids = players.slice(0,10).map(p=>`player_ids[]=${p.id}`).join("&");
  try {
    const avgs = bdlRows(await bdl(`/season_averages?season=${season}&${ids}`));
    if (avgs.length) {
      const top = avgs[0];
      console.log(`✅ Season avgs (s=${season}): ${avgs.length} players — top: ${top.pts?.toFixed(1)}pts ${top.reb?.toFixed(1)}reb ${top.ast?.toFixed(1)}ast`);
    } else {
      console.log(`⚠️  Season avgs (s=${season}): empty — trying s=${season-1}...`);
      const avgs2 = bdlRows(await bdl(`/season_averages?season=${season-1}&${ids}`));
      if (avgs2.length) {
        const top = avgs2[0];
        console.log(`✅ Season avgs (s=${season-1}): ${avgs2.length} players — top: ${top.pts?.toFixed(1)}pts`);
      } else {
        console.log(`❌ Season avgs: empty for both s=${season} and s=${season-1}`);
      }
    }
  } catch(e) { console.log(`❌ Season avgs error: ${e.message}`); }

  // Step 4: Recent game stats via player_ids
  try {
    const stats = bdlRows(await bdl(`/stats?${ids}&seasons[]=${season}&per_page=50`));
    const withMin = stats.filter(r => Number(r.min) > 3);
    if (withMin.length) {
      const playerNames = [...new Set(withMin.map(r=>`${r.player?.first_name} ${r.player?.last_name}`))];
      console.log(`✅ Recent stats: ${withMin.length} rows, ${playerNames.length} players (${playerNames.slice(0,3).join(", ")})`);
    } else {
      console.log(`❌ Recent stats: 0 rows with minutes > 3 (total rows: ${stats.length})`);
      if (stats.length > 0) console.log(`   Sample row: min=${stats[0].min} pts=${stats[0].pts}`);
    }
  } catch(e) { console.log(`❌ Recent stats error: ${e.message}`); }
}

(async () => {
  try {
    await testTeam(HOME);
    await testTeam(AWAY);
    console.log("\nDone.");
  } catch(e) { console.error("Fatal:", e.message); }
})();
