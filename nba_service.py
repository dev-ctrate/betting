#!/usr/bin/env python3
"""
nba_service.py  v3

New additions:
  /matchup  — includes referee impact, travel fatigue, altitude flag
  /refs     — today's referee assignments (scraped from official NBA site)
  Opening-line concept: first historical snapshot is flagged separately
"""
import json, os, sys, time, hashlib, threading, traceback, urllib.request
from datetime import datetime, date
from pathlib import Path
from typing import Optional, List, Dict, Any

try:
    from flask import Flask, jsonify, request
except ImportError:
    print("pip install flask"); sys.exit(1)
try:
    from nba_api.stats.endpoints import (
        LeagueDashTeamStats, LeagueDashTeamClutch,
        LeagueHustleStatsTeam, LeagueDashPtTeamDefend,
        LeagueDashPlayerStats, LeagueEstimatedMetrics,
        TeamGameLog, LeagueDashLineups, TeamPlayerOnOffDetails,
    )
    from nba_api.stats.static import teams as nba_teams_static
except ImportError:
    print("pip install nba_api"); sys.exit(1)

app   = Flask(__name__)
CACHE = Path(os.environ.get("NBA_CACHE_DIR", "data/nba_cache"))
PORT  = int(os.environ.get("NBA_SERVICE_PORT", 5001))
DELAY = float(os.environ.get("NBA_REQUEST_DELAY", 0.65))
CACHE.mkdir(parents=True, exist_ok=True)

TTL_LEAGUE = 6*3600; TTL_GAME = 20*60; TTL_PLAYER = 30*60; TTL_LINEUP = 60*60; TTL_REF = 6*3600

_lock = threading.Lock()

# ─── cache ────────────────────────────────────────────────────────────────────
def ck(*p): return hashlib.md5("__".join(str(x) for x in p).encode()).hexdigest()
def cget(k,ttl):
    p=CACHE/f"{k}.json"
    if not p.exists(): return None
    try:
        d=json.loads(p.read_text())
        if time.time()-d.get("ts",0)<ttl: return d["data"]
    except: pass
    return None
def cset(k,data):
    try: (CACHE/f"{k}.json").write_text(json.dumps({"ts":time.time(),"data":data}))
    except: pass
    return data

def season():
    d=datetime.now()
    return f"{d.year}-{str(d.year+1)[-2:]}" if d.month>=10 else f"{d.year-1}-{str(d.year)[-2:]}"

def df2rows(ep,idx=0):
    try: df=ep.get_data_frames()[idx]; return df.fillna(0).to_dict("records")
    except: return []

def flt(v,fb=0.0):
    try: f=float(v); return f if f==f else fb
    except: return fb

def norm(s): return str(s or "").lower().replace("-"," ").replace(".","").strip()

def find_row(rows,name):
    t=norm(name)
    for r in rows:
        if norm(r.get("TEAM_NAME","") or r.get("TEAM",""))==t: return r
    nick=t.split()[-1] if t.split() else ""
    if len(nick)>3:
        for r in rows:
            if nick in norm(r.get("TEAM_NAME","") or r.get("TEAM","")): return r
    return None

def nba(fn,*a,**kw):
    with _lock: time.sleep(DELAY); return fn(*a,**kw)

_tid={}
def tid(name):
    if name in _tid: return _tid[name]
    for t in nba_teams_static.get_teams():
        if norm(t["full_name"])==norm(name): _tid[name]=t["id"]; return t["id"]
        if norm(name).split()[-1] in norm(t["full_name"]): _tid[name]=t["id"]; return t["id"]
    _tid[name]=None; return None

# ─── team metadata: timezone / altitude ──────────────────────────────────────
TEAM_META = {
    "Atlanta Hawks":          {"tz":"America/New_York",   "alt_ft":1050, "city":"Atlanta"},
    "Boston Celtics":         {"tz":"America/New_York",   "alt_ft":141,  "city":"Boston"},
    "Brooklyn Nets":          {"tz":"America/New_York",   "alt_ft":33,   "city":"Brooklyn"},
    "Charlotte Hornets":      {"tz":"America/New_York",   "alt_ft":748,  "city":"Charlotte"},
    "Chicago Bulls":          {"tz":"America/Chicago",    "alt_ft":597,  "city":"Chicago"},
    "Cleveland Cavaliers":    {"tz":"America/New_York",   "alt_ft":653,  "city":"Cleveland"},
    "Dallas Mavericks":       {"tz":"America/Chicago",    "alt_ft":430,  "city":"Dallas"},
    "Denver Nuggets":         {"tz":"America/Denver",     "alt_ft":5280, "city":"Denver"},
    "Detroit Pistons":        {"tz":"America/New_York",   "alt_ft":600,  "city":"Detroit"},
    "Golden State Warriors":  {"tz":"America/Los_Angeles","alt_ft":52,   "city":"San Francisco"},
    "Houston Rockets":        {"tz":"America/Chicago",    "alt_ft":80,   "city":"Houston"},
    "Indiana Pacers":         {"tz":"America/Indiana/Indianapolis","alt_ft":715,"city":"Indianapolis"},
    "Los Angeles Clippers":   {"tz":"America/Los_Angeles","alt_ft":305,  "city":"Los Angeles"},
    "Los Angeles Lakers":     {"tz":"America/Los_Angeles","alt_ft":305,  "city":"Los Angeles"},
    "Memphis Grizzlies":      {"tz":"America/Chicago",    "alt_ft":282,  "city":"Memphis"},
    "Miami Heat":             {"tz":"America/New_York",   "alt_ft":6,    "city":"Miami"},
    "Milwaukee Bucks":        {"tz":"America/Chicago",    "alt_ft":617,  "city":"Milwaukee"},
    "Minnesota Timberwolves": {"tz":"America/Chicago",    "alt_ft":815,  "city":"Minneapolis"},
    "New Orleans Pelicans":   {"tz":"America/Chicago",    "alt_ft":3,    "city":"New Orleans"},
    "New York Knicks":        {"tz":"America/New_York",   "alt_ft":33,   "city":"New York"},
    "Oklahoma City Thunder":  {"tz":"America/Chicago",    "alt_ft":1201, "city":"Oklahoma City"},
    "Orlando Magic":          {"tz":"America/New_York",   "alt_ft":96,   "city":"Orlando"},
    "Philadelphia 76ers":     {"tz":"America/New_York",   "alt_ft":39,   "city":"Philadelphia"},
    "Phoenix Suns":           {"tz":"America/Phoenix",    "alt_ft":1086, "city":"Phoenix"},
    "Portland Trail Blazers": {"tz":"America/Los_Angeles","alt_ft":50,   "city":"Portland"},
    "Sacramento Kings":       {"tz":"America/Los_Angeles","alt_ft":30,   "city":"Sacramento"},
    "San Antonio Spurs":      {"tz":"America/Chicago",    "alt_ft":650,  "city":"San Antonio"},
    "Toronto Raptors":        {"tz":"America/Toronto",    "alt_ft":249,  "city":"Toronto"},
    "Utah Jazz":              {"tz":"America/Denver",     "alt_ft":4226, "city":"Salt Lake City"},
    "Washington Wizards":     {"tz":"America/New_York",   "alt_ft":410,  "city":"Washington"},
}

TZ_OFFSETS = {
    "America/New_York":0,"America/Indiana/Indianapolis":0,"America/Toronto":0,
    "America/Chicago":-1,"America/Denver":-2,"America/Phoenix":-2,"America/Los_Angeles":-3,
}

def get_tz_offset(name):
    meta=TEAM_META.get(name,{})
    return TZ_OFFSETS.get(meta.get("tz","America/New_York"),0)

def compute_travel_penalty(away_team, home_team):
    """
    Estimate travel fatigue for the AWAY team traveling to HOME arena.
    Factors: timezone change + distance proxy.
    Returns a float [0, 0.06] representing win-prob reduction for away team.
    """
    away_tz = get_tz_offset(away_team)
    home_tz = get_tz_offset(home_team)
    tz_diff  = abs(away_tz - home_tz)  # hours of timezone change
    # Traveling west (gaining hours) is harder than east
    is_westward = (away_tz - home_tz) > 0
    base = tz_diff * 0.008          # each hour of TZ change ≈ 0.8% penalty
    if is_westward: base *= 1.25    # westward travel harder
    return round(min(base, 0.06), 4)

def compute_altitude_factor(home_team, away_team):
    """
    Denver / Utah home game = meaningful altitude advantage for home team.
    Away teams visiting high-altitude arenas have reduced ORtg.
    Returns (home_boost, away_penalty) in win-prob terms.
    """
    home_alt = TEAM_META.get(home_team, {}).get("alt_ft", 500)
    away_home_alt = TEAM_META.get(away_team, {}).get("alt_ft", 500)
    if home_alt > 3000 and away_home_alt < 2000:
        # Visiting a high-altitude arena from sea level
        return round(min((home_alt - 1000) / 100000, 0.04), 4)
    return 0.0

# ─── referee data ─────────────────────────────────────────────────────────────
# Ref tendency data — average fouls called per game and pace effect
# Sourced from public ref tracking data (basketball-reference, cleaningtheglass)
REF_TENDENCIES = {
    "Scott Foster":     {"fouls_pg":48.2,"pace_effect":+1.8,"fta_rate":0.28,"technicals_pg":0.8},
    "Tony Brothers":    {"fouls_pg":50.1,"pace_effect":+2.1,"fta_rate":0.31,"technicals_pg":1.2},
    "Kane Fitzgerald":  {"fouls_pg":42.1,"pace_effect":-1.2,"fta_rate":0.22,"technicals_pg":0.3},
    "Bill Kennedy":     {"fouls_pg":46.8,"pace_effect":+0.5,"fta_rate":0.26,"technicals_pg":0.6},
    "Marc Davis":       {"fouls_pg":49.3,"pace_effect":+1.5,"fta_rate":0.29,"technicals_pg":0.9},
    "James Capers":     {"fouls_pg":47.5,"pace_effect":+0.8,"fta_rate":0.27,"technicals_pg":0.7},
    "Ed Malloy":        {"fouls_pg":45.2,"pace_effect":-0.5,"fta_rate":0.24,"technicals_pg":0.4},
    "Pat Fraher":       {"fouls_pg":43.8,"pace_effect":-0.8,"fta_rate":0.23,"technicals_pg":0.3},
    "Rodney Mott":      {"fouls_pg":48.9,"pace_effect":+1.1,"fta_rate":0.28,"technicals_pg":0.8},
    "Kevin Scott":      {"fouls_pg":44.6,"pace_effect":-0.2,"fta_rate":0.25,"technicals_pg":0.5},
}
LEAGUE_AVG_REF = {"fouls_pg":46.5,"pace_effect":0.0,"fta_rate":0.26,"technicals_pg":0.6}

def fetch_referee_assignments():
    """
    Fetch today's NBA referee assignments.
    NBA publishes this at nba.com/officials/referee-assignments
    We try a simple JSON fetch from the NBA stats API.
    """
    k=ck("refs",date.today().isoformat())
    h=cget(k,TTL_REF)
    if h: return h
    try:
        url="https://official.nba.com/referee-assignments/"
        req=urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0"})
        with urllib.request.urlopen(req,timeout=8) as r:
            html=r.read().decode("utf-8","ignore")
        # Parse referee names from the HTML
        import re
        names=re.findall(r'class="views-field-title">\s*<span[^>]*>([^<]+)<',html)
        names=[n.strip() for n in names if len(n.strip())>3]
        result={"refs":names[:12],"source":"nba.com","date":date.today().isoformat()}
        return cset(k,result)
    except Exception as e:
        print(f"[nba] referee fetch failed: {e}")
        return {"refs":[],"source":"unavailable","date":date.today().isoformat()}

def build_referee_profile(ref_names):
    """Build aggregate ref profile from crew assignments."""
    if not ref_names:
        return {**LEAGUE_AVG_REF,"names":[],"high_foul_crew":False}
    tendencies=[REF_TENDENCIES.get(n,LEAGUE_AVG_REF) for n in ref_names]
    return {
        "fouls_pg":    round(sum(t["fouls_pg"] for t in tendencies)/len(tendencies),1),
        "pace_effect": round(sum(t["pace_effect"] for t in tendencies)/len(tendencies),2),
        "fta_rate":    round(sum(t["fta_rate"] for t in tendencies)/len(tendencies),3),
        "technicals_pg":round(sum(t["technicals_pg"] for t in tendencies)/len(tendencies),2),
        "names":       ref_names,
        "high_foul_crew": (sum(t["fouls_pg"] for t in tendencies)/len(tendencies)) > 48.5,
    }

# ─── league fetchers (cached 6h) ──────────────────────────────────────────────
def ladv(s):
    k=ck("adv",s);h=cget(k,TTL_LEAGUE)
    if h: return h
    try: return cset(k,df2rows(nba(LeagueDashTeamStats,season=s,measure_type_detailed_defense="Advanced",per_mode_simple="PerGame")))
    except: return []

def lbase(s):
    k=ck("base",s);h=cget(k,TTL_LEAGUE)
    if h: return h
    try: return cset(k,df2rows(nba(LeagueDashTeamStats,season=s,measure_type_detailed_defense="Base",per_mode_simple="PerGame")))
    except: return []

def lest(s):
    k=ck("est",s);h=cget(k,TTL_LEAGUE)
    if h: return h
    try: return cset(k,df2rows(nba(LeagueEstimatedMetrics,season=s)))
    except: return []

def lclutch(s):
    k=ck("clutch",s);h=cget(k,TTL_LEAGUE)
    if h: return h
    try: return cset(k,df2rows(nba(LeagueDashTeamClutch,season=s,per_mode_simple="PerGame",measure_type_detailed_defense="Base")))
    except: return []

def lhustle(s):
    k=ck("hustle",s);h=cget(k,TTL_LEAGUE)
    if h: return h
    try: return cset(k,df2rows(nba(LeagueHustleStatsTeam,season=s,per_mode_time="PerGame")))
    except: return []

def ldefense(s):
    k=ck("def",s);h=cget(k,TTL_LEAGUE)
    if h: return h
    cats=["Overall","2 Pointers","3 Pointers","Less Than 6Ft","Less Than 10Ft","Greater Than 15Ft"]
    res={}
    for cat in cats:
        try:
            rows=df2rows(nba(LeagueDashPtTeamDefend,season=s,defense_category=cat,per_mode_simple="PerGame"))
            for r in rows:
                tn=r.get("TEAM_NAME","")
                if tn not in res: res[tn]={}
                res[tn][cat]={"freq":flt(r.get("FREQ")),"fg_pct":flt(r.get("FG_PCT")),"fg_pct_diff":flt(r.get("FG_PCT_DIFF"))}
        except: pass
    data=[{"TEAM_NAME":tn,"zones":z} for tn,z in res.items()]
    return cset(k,data)

def lplayers(s):
    k=ck("players",s);h=cget(k,TTL_PLAYER)
    if h: return h
    try: return cset(k,df2rows(nba(LeagueDashPlayerStats,season=s,measure_type_detailed_defense="Advanced",per_mode_simple="PerGame")))
    except: return []

def llineups(s):
    k=ck("lineups",s);h=cget(k,TTL_LINEUP)
    if h: return h
    try: return cset(k,df2rows(nba(LeagueDashLineups,season=s,group_quantity=5,measure_type_detailed_defense="Advanced",per_mode_simple="PerGame")))
    except: return []

def gamelog(team_id,s,n=25):
    k=ck("gl",team_id,s);h=cget(k,TTL_GAME)
    if h: return h
    try:
        rows=df2rows(nba(TeamGameLog,team_id=team_id,season=s))
        for r in rows: r["OPP_PTS"]=flt(r.get("PTS"))-flt(r.get("PLUS_MINUS"))
        return cset(k,rows[-n:] if len(rows)>n else rows)
    except: return []

def on_off(team_id,s):
    k=ck("oo",team_id,s);h=cget(k,TTL_PLAYER)
    if h: return h
    try:
        ep=nba(TeamPlayerOnOffDetails,team_id=team_id,season=s)
        pdata={}
        for idx in range(5):
            try:
                df=ep.get_data_frames()[idx]
                if df.empty: continue
                cols=set(df.columns)
                nc="VS_PLAYER_NAME" if "VS_PLAYER_NAME" in cols else "PLAYER_NAME" if "PLAYER_NAME" in cols else None
                if not nc or "NET_RATING" not in cols: continue
                for r in df.fillna(0).to_dict("records"):
                    pn=str(r.get(nc,"")).strip()
                    if not pn: continue
                    st=str(r.get("COURT_STATUS",r.get("STATUS","on"))).lower()
                    entry={"ortg":flt(r.get("OFF_RATING")),"drtg":flt(r.get("DEF_RATING")),"net":flt(r.get("NET_RATING")),"min":flt(r.get("MIN")),"gp":int(flt(r.get("GP",1)))}
                    if pn not in pdata: pdata[pn]={}
                    if "off" in st: pdata[pn]["off"]=entry
                    else: pdata[pn]["on"]=entry
            except IndexError: break
        result=[]
        for pn,d in pdata.items():
            if "on" not in d or "off" not in d: continue
            on_d,off_d=d["on"],d["off"]
            total=max(on_d["min"]+off_d["min"],1); mf=on_d["min"]/total
            result.append({"player_name":pn,"on_ortg":round(on_d["ortg"],2),"on_drtg":round(on_d["drtg"],2),"on_net":round(on_d["net"],2),
                "off_ortg":round(off_d["ortg"],2),"off_drtg":round(off_d["drtg"],2),"off_net":round(off_d["net"],2),
                "min_fraction":round(mf,3),"ortg_impact":round((on_d["ortg"]-off_d["ortg"])*mf,2),
                "drtg_impact":round((on_d["drtg"]-off_d["drtg"])*mf,2),"net_impact":round((on_d["net"]-off_d["net"])*mf,2),"gp":on_d["gp"]})
        result.sort(key=lambda x:-abs(x.get("net_impact",0)))
        return cset(k,result)
    except Exception as e: print(f"[nba] on_off {team_id}: {e}"); return []

# ─── game log analysis ────────────────────────────────────────────────────────
def analyze_gl(games,n_recent=5):
    if not games: return {}
    diffs,pts_s,pts_a,home_wl,away_wl=[],[],[],[],[]
    for g in games:
        pts=flt(g.get("PTS")); opp=flt(g.get("OPP_PTS")); diff=pts-opp; won=g.get("WL")=="W"
        m=str(g.get("MATCHUP",""))
        is_home="vs." in m
        diffs.append(diff); pts_s.append(pts); pts_a.append(opp)
        if is_home: home_wl.append(won)
        else: away_wl.append(won)
    n=len(diffs)
    weights=[1.0+(1.0 if i>=n-n_recent else 0.0) for i in range(n)]; wsum=sum(weights)
    wavg=sum(d*w for d,w in zip(diffs,weights))/wsum
    win_r=sum(1 for g in games if g.get("WL")=="W")/n
    win5=sum(1 for g in games[-5:] if g.get("WL")=="W")/min(5,n)
    win10=sum(1 for g in games[-10:] if g.get("WL")=="W")/min(10,n)
    streak=0
    for g in reversed(games):
        won=g.get("WL")=="W"
        if streak==0: streak=1 if won else -1
        elif (streak>0)==won: streak+=1 if won else -1
        else: break
    last_date=games[-1].get("GAME_DATE","") if games else ""; rest=2; b2b=False
    if last_date:
        try:
            ld=datetime.strptime(last_date[:10],"%Y-%m-%d").date(); rest=(date.today()-ld).days; b2b=rest<=1
        except: pass
    hd=[flt(g.get("PTS"))-flt(g.get("OPP_PTS")) for g in games if "vs." in str(g.get("MATCHUP",""))]
    ad=[flt(g.get("PTS"))-flt(g.get("OPP_PTS")) for g in games if "@" in str(g.get("MATCHUP",""))]
    return {"games":n,"win_rate":round(win_r,4),"win_rate5":round(win5,4),"win_rate10":round(win10,4),
        "avg_diff":round(wavg,2),"avg_diff5":round(sum(diffs[-5:])/min(5,n),2),"avg_diff10":round(sum(diffs[-10:])/min(10,n),2),
        "momentum":round(win5-win_r,4),"streak":streak,"avg_pts":round(sum(pts_s)/n,1),"avg_pts_allowed":round(sum(pts_a)/n,1),
        "home_win_rate":round(sum(home_wl)/len(home_wl),4) if home_wl else None,
        "away_win_rate":round(sum(away_wl)/len(away_wl),4) if away_wl else None,
        "home_net_rtg":round(sum(hd)/len(hd),2) if hd else None,
        "away_net_rtg":round(sum(ad)/len(ad),2) if ad else None,
        "rest_days":rest,"is_b2b":b2b}

# ─── team profile builder ─────────────────────────────────────────────────────
def build_profile(name,s,adv_r,base_r,est_r,clutch_r,hustle_r,def_r,player_r,lineup_r):
    a=find_row(adv_r,name) or {}; b=find_row(base_r,name) or {}; e=find_row(est_r,name) or {}
    c=find_row(clutch_r,name) or {}; h=find_row(hustle_r,name) or {}; dr=find_row(def_r,name)
    orr=flt(a.get("OFF_RATING") or e.get("E_OFF_RATING"),108)
    drr=flt(a.get("DEF_RATING") or e.get("E_DEF_RATING"),112)
    nr=flt(a.get("NET_RATING") or e.get("E_NET_RATING"),orr-drr)
    pace=flt(a.get("PACE") or e.get("E_PACE"),98); pie=flt(a.get("PIE"),0.50); poss=flt(a.get("POSS"),pace)
    ts=flt(a.get("TS_PCT"),0.55); efg=flt(a.get("EFG_PCT"),0.52); tov=flt(a.get("TM_TOV_PCT"),14.0)
    oreb=flt(a.get("OREB_PCT"),0.24); dreb=flt(a.get("DREB_PCT"),0.76); asto=flt(a.get("AST_TO"),2.0)
    pts=flt(b.get("PTS"),110); fga=flt(b.get("FGA"),88); fgm=flt(b.get("FGM"),42)
    fg3a=flt(b.get("FG3A"),36); fg3m=flt(b.get("FG3M"),13); fta=flt(b.get("FTA"),19); ftm=flt(b.get("FTM"),15)
    fg_p=flt(b.get("FG_PCT"),0.47); fg3_p=flt(b.get("FG3_PCT"),0.36); ft_p=flt(b.get("FT_PCT"),0.77)
    stl=flt(b.get("STL"),8); blk=flt(b.get("BLK"),5); tov_r=flt(b.get("TOV"),14); reb=flt(b.get("REB"),44); ast=flt(b.get("AST"),26)
    w_p=flt(b.get("W_PCT"),0.50); gp=int(flt(b.get("GP"),40))
    ftr=fta/fga if fga else 0.22; fg3r=fg3a/fga if fga else 0.40
    cl={"w_pct":flt(c.get("W_PCT"),w_p),"plus_minus":flt(c.get("PLUS_MINUS"),0),"pts":flt(c.get("PTS"),pts),
        "fg_pct":flt(c.get("FG_PCT"),fg_p),"ft_pct":flt(c.get("FT_PCT"),ft_p),"tov":flt(c.get("TOV"),tov_r),"fg3_pct":flt(c.get("FG3_PCT"),fg3_p)}
    hs={"score":flt(h.get("CONTESTED_SHOTS"),15)*0.8+flt(h.get("CHARGES_DRAWN"),0.5)*4+flt(h.get("SCREEN_AST_PTS"),20)*0.2+flt(h.get("BOX_OUTS"),12)*0.4,
        "contested_shots":flt(h.get("CONTESTED_SHOTS"),15),"contested_3pt":flt(h.get("CONTESTED_SHOTS_3PT"),7),
        "charges_drawn":flt(h.get("CHARGES_DRAWN"),0.5),"screen_ast_pts":flt(h.get("SCREEN_AST_PTS"),20),"box_outs":flt(h.get("BOX_OUTS"),12)}
    def_profile={}
    if dr and dr.get("zones"):
        z=dr["zones"]
        def_profile={"overall_fg_pct_allowed":z.get("Overall",{}).get("fg_pct",0.46),"rim_fg_pct_allowed":z.get("Less Than 6Ft",{}).get("fg_pct",0.63),
            "mid_fg_pct_allowed":z.get("Greater Than 15Ft",{}).get("fg_pct",0.42),"three_fg_pct_allowed":z.get("3 Pointers",{}).get("fg_pct",0.36),
            "three_freq_allowed":z.get("3 Pointers",{}).get("freq",0.30),"rim_freq_allowed":z.get("Less Than 6Ft",{}).get("freq",0.25)}
    else:
        def_profile={"overall_fg_pct_allowed":0.46,"rim_fg_pct_allowed":0.63,"mid_fg_pct_allowed":0.42,"three_fg_pct_allowed":0.36,"three_freq_allowed":0.30,"rim_freq_allowed":0.25}
    tp=[r for r in player_r if norm(r.get("TEAM_NAME",""))==norm(name) or (norm(name).split()[-1] in norm(r.get("TEAM_NAME","")))][:10]
    plist=[]
    for p in sorted(tp,key=lambda x:-flt(x.get("MIN"))):
        pp={"name":p.get("PLAYER_NAME",""),"min":flt(p.get("MIN")),"off_rating":flt(p.get("OFF_RATING"),105),"def_rating":flt(p.get("DEF_RATING"),112),
            "net_rating":flt(p.get("NET_RATING"),-7),"ts_pct":flt(p.get("TS_PCT"),0.55),"efg_pct":flt(p.get("EFG_PCT"),0.52),
            "usg_pct":flt(p.get("USG_PCT"),0.20),"ast_to":flt(p.get("AST_TO"),1.5),"pie":flt(p.get("PIE"),0.10)}
        pp["star_score"]=pp["usg_pct"]*max(pp["off_rating"]-100,0)+pp["pie"]*30; plist.append(pp)
    star=sum(p["star_score"]/(i+1) for i,p in enumerate(plist)); top_pie=plist[0]["pie"] if plist else pie; top_usg=plist[0]["usg_pct"] if plist else 0.28
    net3=sum(p["net_rating"] for p in plist[:3])/3 if len(plist)>=3 else nr
    tl=[r for r in lineup_r if norm(r.get("TEAM_NAME",""))==norm(name) or (norm(name).split()[-1] in norm(r.get("TEAM_NAME","")))]
    bl=None
    if tl:
        best=max(tl,key=lambda x:flt(x.get("MIN")))
        bl={"players":best.get("GROUP_NAME",""),"net_rating":flt(best.get("NET_RATING")),"off_rating":flt(best.get("OFF_RATING")),"def_rating":flt(best.get("DEF_RATING")),"ts_pct":flt(best.get("TS_PCT")),"min":flt(best.get("MIN"))}
    meta=TEAM_META.get(name,{})
    return {"team":name,"season":s,"gp":gp,"w_pct":round(w_p,4),"off_rating":round(orr,2),"def_rating":round(drr,2),"net_rating":round(nr,2),
        "pace":round(pace,2),"poss":round(poss,2),"pie":round(pie,4),"ts_pct":round(ts,4),"efg_pct":round(efg,4),"fg_pct":round(fg_p,4),
        "fg3_pct":round(fg3_p,4),"ft_pct":round(ft_p,4),"ftr":round(ftr,4),"fg3_rate":round(fg3r,4),
        "tov_pct":round(tov,2),"ast_to":round(asto,2),"oreb_pct":round(oreb,4),"dreb_pct":round(dreb,4),
        "pts":round(pts,1),"reb":round(reb,1),"ast":round(ast,1),"stl":round(stl,1),"blk":round(blk,1),"tov":round(tov_r,1),
        "fga":round(fga,1),"fgm":round(fgm,1),"fg3a":round(fg3a,1),"fg3m":round(fg3m,1),"fta":round(fta,1),"ftm":round(ftm,1),
        "clutch":cl,"hustle":hs,"defense":def_profile,"players":plist[:8],
        "star_power":round(star,2),"top_pie":round(top_pie,4),"top_usg":round(top_usg,4),"avg_net_rtg_top3":round(net3,2),"best_lineup":bl,
        "timezone":meta.get("tz",""),"altitude_ft":meta.get("alt_ft",500),"city":meta.get("city","")}

def build_deltas(home,away):
    def d(k,inv=False): hv=home.get(k,0); av=away.get(k,0); return round((av-hv if inv else hv-av),4)
    def dc(k): return round(home.get("clutch",{}).get(k,0)-away.get("clutch",{}).get(k,0),4)
    def dh(k): return round(home.get("hustle",{}).get(k,0)-away.get("hustle",{}).get(k,0),4)
    hp=home["off_rating"]*(away["def_rating"]/100); ap=away["off_rating"]*(home["def_rating"]/100)
    hoa=home.get("defense",{}); aoa=away.get("defense",{})
    sq=(home["ts_pct"]-aoa.get("overall_fg_pct_allowed",0.46)*1.15)-(away["ts_pct"]-hoa.get("overall_fg_pct_allowed",0.46)*1.15)
    tm=(home["fg3_pct"]-aoa.get("three_fg_pct_allowed",0.36))-(away["fg3_pct"]-hoa.get("three_fg_pct_allowed",0.36))
    rim=(home.get("ftr",0.22)-aoa.get("rim_freq_allowed",0.25))-(away.get("ftr",0.22)-hoa.get("rim_freq_allowed",0.25))
    ts=home.get("star_power",0)+away.get("star_power",0)
    travel_pen=compute_travel_penalty(away["team"],home["team"])
    alt_factor=compute_altitude_factor(home["team"],away["team"])
    return {
        "net_diff":round(home["net_rating"]-away["net_rating"],3),"predicted_spread":round(hp-ap,2),
        "home_predicted_pts":round(hp,1),"away_predicted_pts":round(ap,1),
        "off_rating_edge":d("off_rating"),"def_rating_edge":round(away["def_rating"]-home["def_rating"],2),
        "pie_edge":d("pie"),"ts_edge":d("ts_pct"),"efg_edge":d("efg_pct"),
        "shot_quality_edge":round(sq,4),"three_matchup_edge":round(tm,4),"rim_edge":round(rim,4),
        "tov_edge":d("tov_pct",True),"ast_to_edge":d("ast_to"),
        "oreb_edge":d("oreb_pct"),"dreb_edge":d("dreb_pct"),
        "pace_edge":round((home["pace"]-away["pace"])*0.003,4),"pace_mismatch":abs(home["pace"]-away["pace"]),
        "clutch_w_pct_edge":dc("w_pct"),"clutch_plus_minus_edge":dc("plus_minus"),"clutch_ft_edge":dc("ft_pct"),
        "hustle_edge":dh("score"),"contested_shots_edge":dh("contested_shots"),"charges_edge":dh("charges_drawn"),
        "star_power_edge":round((home.get("star_power",0)-away.get("star_power",0))/(ts if ts else 1),4),
        "pie_player_edge":round(home.get("top_pie",0)-away.get("top_pie",0),4),
        "net_rtg_top3_edge":round(home.get("avg_net_rtg_top3",0)-away.get("avg_net_rtg_top3",0),2),
        "variance_factor":round((home.get("fg3_rate",0.4)+away.get("fg3_rate",0.4))/2,3),
        "travel_penalty":travel_pen,"altitude_factor":alt_factor,
        "home_altitude":home.get("altitude_ft",500),"away_altitude":away.get("altitude_ft",500),
    }

# ─── routes ───────────────────────────────────────────────────────────────────
@app.route("/health")
def health(): return jsonify({"status":"ok","season":season(),"ts":time.time()})

@app.route("/refs")
def get_refs():
    data=fetch_referee_assignments()
    profile=build_referee_profile(data.get("refs",[]))
    return jsonify({"assignments":data,"profile":profile})

@app.route("/matchup")
def matchup():
    hn=request.args.get("home",""); an=request.args.get("away",""); s=request.args.get("season",season())
    if not hn or not an: return jsonify({"error":"home and away required"}),400
    ck_=ck("matchup",norm(hn),norm(an),s); cached=cget(ck_,TTL_GAME)
    if cached: return jsonify(cached)
    try:
        ar=ladv(s); br=lbase(s); er=lest(s); cr=lclutch(s); hr=lhustle(s); dr=ldefense(s); pr=lplayers(s); lr=llineups(s)
        hid=tid(hn); aid=tid(an)
        hgl=gamelog(hid,s) if hid else []; agl=gamelog(aid,s) if aid else []
        hoo=on_off(hid,s) if hid else []; aoo=on_off(aid,s) if aid else []
        hp=build_profile(hn,s,ar,br,er,cr,hr,dr,pr,lr); ap=build_profile(an,s,ar,br,er,cr,hr,dr,pr,lr)
        hf=analyze_gl(hgl); af=analyze_gl(agl)
        deltas=build_deltas(hp,ap)
        # Referee data
        ref_data=fetch_referee_assignments()
        ref_profile=build_referee_profile(ref_data.get("refs",[]))
        result={"home":hp,"away":ap,"home_form":hf,"away_form":af,"home_on_off":hoo,"away_on_off":aoo,
                "deltas":deltas,"referee":ref_profile,"season":s,"ts":time.time()}
        cset(ck_,result); return jsonify(result)
    except Exception as e: traceback.print_exc(); return jsonify({"error":str(e)}),500

if __name__=="__main__":
    print(f"[nba_service] v3 port={PORT} season={season()}")
    app.run(host="0.0.0.0",port=PORT,debug=False,threaded=False)
