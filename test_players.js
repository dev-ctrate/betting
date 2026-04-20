/**
 * Run: node test_players.js "Cleveland Cavaliers" "Toronto Raptors"
 */
const BDL_KEY = process.env.BALLDONTLIE_API_KEY || "";
if (!BDL_KEY) { console.error("❌ BALLDONTLIE_API_KEY not set"); process.exit(1); }
const HOME = process.argv[2] || "Cleveland Cavaliers";
const AWAY = process.argv[3] || "Toronto Raptors";
function getBdlSeason() { const d=new Date(),m=d.getUTCMonth()+1,y=d.getUTCFullYear(); return m>=10?y:y-1; }
const bdlRows = p => Array.isArray(p)?p:Array.isArray(p?.data)?p.data:[];
const flt = (v,fb=0)=>{ const n=Number(v); return Number.isFinite(n)?n:fb; };
async function bdl(path) {
  const res=await fetch(`https://api.balldontlie.io/v1${path}`,{headers:{Authorization:BDL_KEY},signal:AbortSignal.timeout(12000)});
  const txt=await res.text(); if(!res.ok) throw new Error(`BDL ${res.status}: ${txt.slice(0,100)}`);
  return JSON.parse(txt);
}
async function testTeam(teamName) {
  console.log(`\n──── ${teamName} ────`);
  const season = getBdlSeason();
  const norm = s=>String(s||"").toLowerCase().replace(/[^a-z0-9 ]/g,"").replace(/\s+/g," ").trim();
  const teams = bdlRows(await bdl("/teams?per_page=35"));
  const nick  = norm(teamName).split(" ").pop();
  const team  = teams.find(t=>norm(t.full_name)===norm(teamName)||norm(t.full_name).includes(nick));
  if (!team) { console.log("❌ Team not found"); return; }
  console.log(`✅ Team: ${team.full_name} (ID=${team.id})`);
  const gData = await bdl(`/games?team_ids[]=${team.id}&seasons[]=${season}&per_page=10`);
  const games = bdlRows(gData).filter(g=>String(g.status||"").toLowerCase().includes("final")).slice(-8);
  if (!games.length) { console.log(`❌ No final games for season ${season}`); return; }
  console.log(`✅ Games: ${games.length} recent finals (last: ${games[games.length-1]?.date})`);
  const idsQ = games.map(g=>`game_ids[]=${g.id}`).join("&");
  const [p1,p2] = await Promise.allSettled([bdl(`/stats?${idsQ}&per_page=100`),bdl(`/stats?${idsQ}&per_page=100&page=2`)]);
  const allRows = [...bdlRows(p1.status==="fulfilled"?p1.value:[]),...bdlRows(p2.status==="fulfilled"?p2.value:[])].filter(r=>flt(r.min)>1);
  const teamRows = allRows.filter(r=>{ const tid=r.team?.id??r.team_id; return tid===team.id||tid===String(team.id); });
  const useRows = teamRows.length>=5?teamRows:allRows;
  console.log(`✅ Stat rows: ${allRows.length} total, ${teamRows.length} filtered to team`);
  const byP={};
  for (const r of useRows) {
    if(flt(r.min)<1)continue; const id=r.player_id??r.player?.id; if(!id)continue;
    if(!byP[id])byP[id]={name:`${r.player?.first_name||""} ${r.player?.last_name||""}`.trim(),pts:[],min:[]};
    byP[id].pts.push(flt(r.pts)); byP[id].min.push(flt(r.min));
  }
  const players=Object.values(byP).map(p=>({name:p.name,pts:p.pts.reduce((a,b)=>a+b)/p.pts.length,min:p.min.reduce((a,b)=>a+b)/p.min.length})).filter(p=>p.min>=3).sort((a,b)=>b.pts-a.pts);
  if(players.length>=3){
    console.log(`✅ Players: ${players.length} found`);
    console.log(`   Top 5: ${players.slice(0,5).map(p=>`${p.name} ${p.pts.toFixed(1)}pts`).join(" | ")}`);
  } else { console.log(`❌ Only ${players.length} players with min>=3`); }
}
(async()=>{ try{ await testTeam(HOME); await testTeam(AWAY); console.log("\nDone."); }catch(e){console.error("Fatal:",e.message);} })();
