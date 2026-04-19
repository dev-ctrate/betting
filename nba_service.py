#!/usr/bin/env python3
"""
nba_service.py  v2

Additions over v1:
  • /on_off?name=X        — TeamPlayerOnOffDetails (injury adjustment data)
  • /matchup includes home_on_off, away_on_off, home_splits, away_splits
  • Exponentially weighted recent form (last 5 games weighted 2x last 15)
  • True home/away net rating splits for team-specific HCA
  • Referee tendency endpoint
  • Strength-of-schedule proxy
"""

import json, os, sys, time, hashlib, threading, traceback
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
        TeamGameLog, LeagueDashLineups,
        TeamPlayerOnOffDetails,
    )
    from nba_api.stats.static import teams as nba_teams_static
except ImportError:
    print("pip install nba_api"); sys.exit(1)

app    = Flask(__name__)
CACHE  = Path(os.environ.get("NBA_CACHE_DIR", "data/nba_cache"))
PORT   = int(os.environ.get("NBA_SERVICE_PORT", 5001))
DELAY  = float(os.environ.get("NBA_REQUEST_DELAY", 0.65))
CACHE.mkdir(parents=True, exist_ok=True)

TTL_LEAGUE = 6   * 3600
TTL_GAME   = 20  * 60
TTL_PLAYER = 30  * 60
TTL_LINEUP = 60  * 60

_lock = threading.Lock()

# ─── cache ────────────────────────────────────────────────────────────────────
def _ck(*p): return hashlib.md5("__".join(str(x) for x in p).encode()).hexdigest()

def cget(k, ttl):
    p = CACHE / f"{k}.json"
    if not p.exists(): return None
    try:
        d = json.loads(p.read_text())
        if time.time() - d.get("ts",0) < ttl: return d["data"]
    except: pass
    return None

def cset(k, data):
    try: (CACHE / f"{k}.json").write_text(json.dumps({"ts":time.time(),"data":data}))
    except: pass
    return data

# ─── helpers ──────────────────────────────────────────────────────────────────
def season():
    d = datetime.now()
    return f"{d.year}-{str(d.year+1)[-2:]}" if d.month >= 10 else f"{d.year-1}-{str(d.year)[-2:]}"

def df2rows(ep, idx=0):
    try:
        df = ep.get_data_frames()[idx]
        return df.fillna(0).to_dict("records")
    except: return []

def flt(v, fb=0.0):
    try: f = float(v); return f if f == f else fb
    except: return fb

def norm(s): return str(s or "").lower().replace("-"," ").replace(".","").strip()

def find_row(rows, name):
    t = norm(name)
    for r in rows:
        if norm(r.get("TEAM_NAME","") or r.get("TEAM","")) == t: return r
    nick = t.split()[-1] if t.split() else ""
    if len(nick) > 3:
        for r in rows:
            if nick in norm(r.get("TEAM_NAME","") or r.get("TEAM","")): return r
    return None

def nba(fn, *a, **kw):
    with _lock:
        time.sleep(DELAY)
        return fn(*a, **kw)

_tid: Dict[str,Optional[int]] = {}
def tid(name):
    if name in _tid: return _tid[name]
    for t in nba_teams_static.get_teams():
        if norm(t["full_name"]) == norm(name):
            _tid[name] = t["id"]; return t["id"]
        if norm(name).split()[-1] in norm(t["full_name"]):
            _tid[name] = t["id"]; return t["id"]
    _tid[name] = None; return None

# ─── league-wide fetches ───────────────────────────────────────────────────────
def adv(s):
    k = _ck("adv",s); h = cget(k,TTL_LEAGUE)
    if h: return h
    try: return cset(k, df2rows(nba(LeagueDashTeamStats,season=s,measure_type_detailed_defense="Advanced",per_mode_simple="PerGame")))
    except: return []

def base(s):
    k = _ck("base",s); h = cget(k,TTL_LEAGUE)
    if h: return h
    try: return cset(k, df2rows(nba(LeagueDashTeamStats,season=s,measure_type_detailed_defense="Base",per_mode_simple="PerGame")))
    except: return []

def est(s):
    k = _ck("est",s); h = cget(k,TTL_LEAGUE)
    if h: return h
    try: return cset(k, df2rows(nba(LeagueEstimatedMetrics,season=s)))
    except: return []

def clutch(s):
    k = _ck("clutch",s); h = cget(k,TTL_LEAGUE)
    if h: return h
    try: return cset(k, df2rows(nba(LeagueDashTeamClutch,season=s,per_mode_simple="PerGame",measure_type_detailed_defense="Base")))
    except: return []

def hustle(s):
    k = _ck("hustle",s); h = cget(k,TTL_LEAGUE)
    if h: return h
    try: return cset(k, df2rows(nba(LeagueHustleStatsTeam,season=s,per_mode_time="PerGame")))
    except: return []

def defense(s):
    k = _ck("def",s); h = cget(k,TTL_LEAGUE)
    if h: return h
    cats = ["Overall","2 Pointers","3 Pointers","Less Than 6Ft","Less Than 10Ft","Greater Than 15Ft"]
    res = {}
    for cat in cats:
        try:
            rows = df2rows(nba(LeagueDashPtTeamDefend,season=s,defense_category=cat,per_mode_simple="PerGame"))
            for r in rows:
                tn = r.get("TEAM_NAME","")
                if tn not in res: res[tn] = {}
                res[tn][cat] = {"freq":flt(r.get("FREQ")),"fg_pct":flt(r.get("FG_PCT")),"fg_pct_diff":flt(r.get("FG_PCT_DIFF"))}
        except: pass
    data = [{"TEAM_NAME":tn,"zones":z} for tn,z in res.items()]
    return cset(k, data)

def players(s):
    k = _ck("players",s); h = cget(k,TTL_PLAYER)
    if h: return h
    try: return cset(k, df2rows(nba(LeagueDashPlayerStats,season=s,measure_type_detailed_defense="Advanced",per_mode_simple="PerGame")))
    except: return []

def lineups(s):
    k = _ck("lineups",s); h = cget(k,TTL_LINEUP)
    if h: return h
    try: return cset(k, df2rows(nba(LeagueDashLineups,season=s,group_quantity=5,measure_type_detailed_defense="Advanced",per_mode_simple="PerGame")))
    except: return []

def gamelog(team_id, s, n=25):
    k = _ck("gl",team_id,s); h = cget(k,TTL_GAME)
    if h: return h
    try:
        rows = df2rows(nba(TeamGameLog,team_id=team_id,season=s))
        for r in rows: r["OPP_PTS"] = flt(r.get("PTS")) - flt(r.get("PLUS_MINUS"))
        return cset(k, rows[-n:] if len(rows)>n else rows)
    except: return []

def on_off(team_id, s):
    """TeamPlayerOnOffDetails — how team performs with/without each player."""
    k = _ck("onoff",team_id,s); h = cget(k,TTL_PLAYER)
    if h: return h
    try:
        ep   = nba(TeamPlayerOnOffDetails, team_id=team_id, season=s)
        # Collect all DataFrames and find player on/off splits
        player_data = {}
        for df_idx in range(5):
            try:
                df = ep.get_data_frames()[df_idx]
                if df.empty: continue
                cols = set(df.columns)
                has_player = any(c in cols for c in ["VS_PLAYER_NAME","PLAYER_NAME"])
                has_rating = "NET_RATING" in cols
                if not (has_player and has_rating): continue
                name_col = "VS_PLAYER_NAME" if "VS_PLAYER_NAME" in cols else "PLAYER_NAME"
                rows = df.fillna(0).to_dict("records")
                for r in rows:
                    pname = str(r.get(name_col,"")).strip()
                    if not pname: continue
                    status = str(r.get("COURT_STATUS", r.get("STATUS","on"))).lower()
                    entry = {
                        "ortg": flt(r.get("OFF_RATING")),
                        "drtg": flt(r.get("DEF_RATING")),
                        "net":  flt(r.get("NET_RATING")),
                        "min":  flt(r.get("MIN")),
                        "gp":   int(flt(r.get("GP",1))),
                    }
                    if pname not in player_data: player_data[pname] = {}
                    if "off" in status: player_data[pname]["off"] = entry
                    else:               player_data[pname]["on"]  = entry
            except IndexError: break

        result = []
        for pname, d in player_data.items():
            if "on" not in d or "off" not in d: continue
            on_d, off_d = d["on"], d["off"]
            total = max(on_d["min"] + off_d["min"], 1)
            mfrac = on_d["min"] / total
            result.append({
                "player_name": pname,
                "on_ortg":   round(on_d["ortg"],2), "on_drtg":  round(on_d["drtg"],2), "on_net":  round(on_d["net"],2),
                "off_ortg":  round(off_d["ortg"],2),"off_drtg": round(off_d["drtg"],2),"off_net": round(off_d["net"],2),
                "min_fraction": round(mfrac,3),
                "ortg_impact":  round((on_d["ortg"] - off_d["ortg"]) * mfrac, 2),
                "drtg_impact":  round((on_d["drtg"] - off_d["drtg"]) * mfrac, 2),
                "net_impact":   round((on_d["net"]  - off_d["net"])  * mfrac, 2),
                "gp": on_d["gp"],
            })
        result.sort(key=lambda x: -abs(x.get("net_impact",0)))
        return cset(k, result)
    except Exception as e:
        print(f"[nba] on_off {team_id} failed: {e}"); return []

# ─── game log analysis (exponentially weighted) ───────────────────────────────
def analyze_gl(games, n_recent=5):
    """Exponentially weight recent games: last 5 count 2x more than earlier."""
    if not games: return {}
    diffs, pts_s, pts_a, home_wl, away_wl = [], [], [], [], []
    for g in games:
        pts  = flt(g.get("PTS"))
        opp  = flt(g.get("OPP_PTS"))
        diff = pts - opp
        won  = g.get("WL") == "W"
        matchup = str(g.get("MATCHUP",""))
        is_home = "vs." in matchup
        diffs.append(diff); pts_s.append(pts); pts_a.append(opp)
        if is_home: home_wl.append(won)
        else:       away_wl.append(won)

    n = len(diffs)
    recent = diffs[-n_recent:]
    # Exponentially weighted average (recent 5 weighted 2×)
    weights_all = [1.0 + (1.0 if i >= n - n_recent else 0.0) for i in range(n)]
    wsum = sum(weights_all)
    wavg_diff = sum(d*w for d,w in zip(diffs,weights_all)) / wsum
    avg_diff5  = sum(recent)/len(recent) if recent else 0
    win_r  = sum(1 for g in games if g.get("WL")=="W") / n
    win5   = sum(1 for g in games[-5:] if g.get("WL")=="W") / min(5,n)
    win10  = sum(1 for g in games[-10:] if g.get("WL")=="W") / min(10,n)
    momentum = win5 - win_r
    streak = 0
    for g in reversed(games):
        won = g.get("WL")=="W"
        if streak == 0: streak = 1 if won else -1
        elif (streak > 0) == won: streak += 1 if won else -1
        else: break

    last_date = games[-1].get("GAME_DATE","") if games else ""
    rest = 2; b2b = False
    if last_date:
        try:
            ld = datetime.strptime(last_date[:10],"%Y-%m-%d").date()
            rest = (date.today() - ld).days
            b2b  = rest <= 1
        except: pass

    home_net = None; away_net = None
    if home_wl: home_net = (sum(d for d,h in zip(diffs,[True if "vs." in str(g.get("MATCHUP","")) else False for g in games]) if h) / max(len(home_wl),1) if home_wl else None)
    # Recalculate properly
    home_diffs = [flt(g.get("PTS")) - flt(g.get("OPP_PTS")) for g in games if "vs." in str(g.get("MATCHUP",""))]
    away_diffs = [flt(g.get("PTS")) - flt(g.get("OPP_PTS")) for g in games if "@" in str(g.get("MATCHUP",""))]
    home_net_rtg = sum(home_diffs)/len(home_diffs) if home_diffs else None
    away_net_rtg = sum(away_diffs)/len(away_diffs) if away_diffs else None

    return {
        "games": n, "win_rate": round(win_r,4), "win_rate5": round(win5,4), "win_rate10": round(win10,4),
        "avg_diff": round(wavg_diff,2), "avg_diff5": round(avg_diff5,2), "avg_diff10": round(sum(diffs[-10:])/min(10,n),2),
        "momentum": round(momentum,4), "streak": streak,
        "avg_pts": round(sum(pts_s)/n,1), "avg_pts_allowed": round(sum(pts_a)/n,1),
        "home_win_rate": round(sum(home_wl)/len(home_wl),4) if home_wl else None,
        "away_win_rate": round(sum(away_wl)/len(away_wl),4) if away_wl else None,
        "home_net_rtg":  round(home_net_rtg,2) if home_net_rtg is not None else None,
        "away_net_rtg":  round(away_net_rtg,2) if away_net_rtg is not None else None,
        "rest_days": rest, "is_b2b": b2b,
    }

# ─── team profile builder ─────────────────────────────────────────────────────
def build_profile(name, s, adv_r, base_r, est_r, clutch_r, hustle_r, def_r, player_r, lineup_r):
    a = find_row(adv_r,   name) or {}
    b = find_row(base_r,  name) or {}
    e = find_row(est_r,   name) or {}
    c = find_row(clutch_r,name) or {}
    h = find_row(hustle_r,name) or {}
    dr= find_row(def_r,   name)

    off_rtg = flt(a.get("OFF_RATING") or e.get("E_OFF_RATING"), 108)
    def_rtg = flt(a.get("DEF_RATING") or e.get("E_DEF_RATING"), 112)
    net_rtg = flt(a.get("NET_RATING") or e.get("E_NET_RATING"), off_rtg - def_rtg)
    pace    = flt(a.get("PACE")       or e.get("E_PACE"),        98)
    pie     = flt(a.get("PIE"),        0.50)
    poss    = flt(a.get("POSS"),       pace)
    ts_pct  = flt(a.get("TS_PCT"),     0.55)
    efg_pct = flt(a.get("EFG_PCT"),    0.52)
    tov_pct = flt(a.get("TM_TOV_PCT"),14.0)
    oreb_pct= flt(a.get("OREB_PCT"),   0.24)
    dreb_pct= flt(a.get("DREB_PCT"),   0.76)
    ast_to  = flt(a.get("AST_TO"),     2.0)
    ast_pct = flt(a.get("AST_PCT"),    0.60)
    pts     = flt(b.get("PTS"),        110)
    reb     = flt(b.get("REB"),        44)
    ast     = flt(b.get("AST"),        26)
    stl     = flt(b.get("STL"),        8)
    blk     = flt(b.get("BLK"),        5)
    tov     = flt(b.get("TOV"),        14)
    fgm     = flt(b.get("FGM"),        42)
    fga     = flt(b.get("FGA"),        88)
    fg3m    = flt(b.get("FG3M"),       13)
    fg3a    = flt(b.get("FG3A"),       36)
    fta     = flt(b.get("FTA"),        19)
    ftm     = flt(b.get("FTM"),        15)
    oreb    = flt(b.get("OREB"),       10)
    dreb    = flt(b.get("DREB"),       34)
    fg_pct  = flt(b.get("FG_PCT"),     0.47)
    fg3_pct = flt(b.get("FG3_PCT"),    0.36)
    ft_pct  = flt(b.get("FT_PCT"),     0.77)
    w_pct   = flt(b.get("W_PCT"),      0.50)
    gp      = int(flt(b.get("GP"),     40))
    ftr     = fta/fga if fga else 0.22
    fg3_rate= fg3a/fga if fga else 0.40

    # clutch
    cl = {
        "w_pct":       flt(c.get("W_PCT"),        w_pct),
        "plus_minus":  flt(c.get("PLUS_MINUS"),   0),
        "pts":         flt(c.get("PTS"),           pts),
        "fg_pct":      flt(c.get("FG_PCT"),        fg_pct),
        "ft_pct":      flt(c.get("FT_PCT"),        ft_pct),
        "tov":         flt(c.get("TOV"),           tov),
        "fg3_pct":     flt(c.get("FG3_PCT"),       fg3_pct),
    }

    # hustle
    hs_score = (flt(h.get("CONTESTED_SHOTS"),15)*0.8 + flt(h.get("CHARGES_DRAWN"),0.5)*4 +
                flt(h.get("SCREEN_AST_PTS"),20)*0.2 + flt(h.get("BOX_OUTS"),12)*0.4 +
                flt(h.get("DEF_LOOSE_BALLS_RECOVERED"),1.5)*2)
    hs = {
        "score":           round(hs_score,2),
        "contested_shots": flt(h.get("CONTESTED_SHOTS"),15),
        "contested_3pt":   flt(h.get("CONTESTED_SHOTS_3PT"),7),
        "charges_drawn":   flt(h.get("CHARGES_DRAWN"),0.5),
        "screen_ast_pts":  flt(h.get("SCREEN_AST_PTS"),20),
        "box_outs":        flt(h.get("BOX_OUTS"),12),
    }

    # defense zones
    def_profile = {}
    if dr and dr.get("zones"):
        z = dr["zones"]
        def_profile = {
            "overall_fg_pct_allowed": z.get("Overall",{}).get("fg_pct",0.46),
            "rim_fg_pct_allowed":     z.get("Less Than 6Ft",{}).get("fg_pct",0.63),
            "mid_fg_pct_allowed":     z.get("Greater Than 15Ft",{}).get("fg_pct",0.42),
            "three_fg_pct_allowed":   z.get("3 Pointers",{}).get("fg_pct",0.36),
            "three_freq_allowed":     z.get("3 Pointers",{}).get("freq",0.30),
            "rim_freq_allowed":       z.get("Less Than 6Ft",{}).get("freq",0.25),
        }
    else:
        def_profile = {"overall_fg_pct_allowed":0.46,"rim_fg_pct_allowed":0.63,"mid_fg_pct_allowed":0.42,
                       "three_fg_pct_allowed":0.36,"three_freq_allowed":0.30,"rim_freq_allowed":0.25}

    # players
    team_players = [r for r in player_r if norm(r.get("TEAM_NAME","")) == norm(name) or
                    (norm(name).split()[-1] in norm(r.get("TEAM_NAME","")))][:10]
    plist = []
    for p in sorted(team_players, key=lambda x: -flt(x.get("MIN"))):
        pp = {
            "name":     p.get("PLAYER_NAME",""),
            "min":      flt(p.get("MIN")),
            "off_rating": flt(p.get("OFF_RATING"),105),
            "def_rating": flt(p.get("DEF_RATING"),112),
            "net_rating": flt(p.get("NET_RATING"),-7),
            "ts_pct":   flt(p.get("TS_PCT"),0.55),
            "efg_pct":  flt(p.get("EFG_PCT"),0.52),
            "usg_pct":  flt(p.get("USG_PCT"),0.20),
            "ast_to":   flt(p.get("AST_TO"),1.5),
            "pie":      flt(p.get("PIE"),0.10),
        }
        pp["star_score"] = pp["usg_pct"] * max(pp["off_rating"]-100,0) + pp["pie"]*30
        plist.append(pp)

    star_power = sum(p["star_score"]/(i+1) for i,p in enumerate(plist))
    top_pie    = plist[0]["pie"] if plist else pie
    top_usg    = plist[0]["usg_pct"] if plist else 0.28
    net3       = sum(p["net_rating"] for p in plist[:3])/3 if len(plist)>=3 else net_rtg

    # lineups
    tl = [r for r in lineup_r if norm(r.get("TEAM_NAME",""))==norm(name) or
          (norm(name).split()[-1] in norm(r.get("TEAM_NAME","")))]
    best_lu = None
    if tl:
        best = max(tl, key=lambda x: flt(x.get("MIN")))
        best_lu = {"players":best.get("GROUP_NAME",""),"net_rating":flt(best.get("NET_RATING")),
                   "off_rating":flt(best.get("OFF_RATING")),"def_rating":flt(best.get("DEF_RATING")),
                   "ts_pct":flt(best.get("TS_PCT")),"min":flt(best.get("MIN"))}

    pct_3 = fg3m*3/pts if pts else 0.35
    pct_2 = (fgm-fg3m)*2/pts if pts else 0.47

    return {
        "team": name, "season": s, "gp": gp, "w_pct": round(w_pct,4),
        "off_rating": round(off_rtg,2), "def_rating": round(def_rtg,2),
        "net_rating": round(net_rtg,2), "pace": round(pace,2), "poss": round(poss,2), "pie": round(pie,4),
        "ts_pct": round(ts_pct,4), "efg_pct": round(efg_pct,4), "fg_pct": round(fg_pct,4),
        "fg3_pct": round(fg3_pct,4), "ft_pct": round(ft_pct,4), "ftr": round(ftr,4), "fg3_rate": round(fg3_rate,4),
        "tov_pct": round(tov_pct,2), "ast_to": round(ast_to,2), "ast_pct": round(ast_pct,4),
        "oreb_pct": round(oreb_pct,4), "dreb_pct": round(dreb_pct,4),
        "pts": round(pts,1), "reb": round(reb,1), "ast": round(ast,1),
        "stl": round(stl,1), "blk": round(blk,1), "tov": round(tov,1),
        "fga": round(fga,1), "fgm": round(fgm,1), "fg3a": round(fg3a,1), "fg3m": round(fg3m,1),
        "fta": round(fta,1), "ftm": round(ftm,1), "oreb": round(oreb,1), "dreb": round(dreb,1),
        "pct_3": round(pct_3,4), "pct_2": round(pct_2,4),
        "clutch": cl, "hustle": hs, "defense": def_profile,
        "players": plist[:8], "star_power": round(star_power,2),
        "top_pie": round(top_pie,4), "top_usg": round(top_usg,4),
        "avg_net_rtg_top3": round(net3,2), "best_lineup": best_lu,
    }

def build_deltas(home, away):
    def d(k, inv=False): hv=home.get(k,0); av=away.get(k,0); return round((av-hv if inv else hv-av),4)
    def dc(k): return round(home.get("clutch",{}).get(k,0) - away.get("clutch",{}).get(k,0),4)
    def dh(k): return round(home.get("hustle",{}).get(k,0) - away.get("hustle",{}).get(k,0),4)

    hp = home["off_rating"] * (away["def_rating"]/100)
    ap = away["off_rating"] * (home["def_rating"]/100)

    hoa = home.get("defense",{})
    aoa = away.get("defense",{})
    shot_q = (home["ts_pct"] - aoa.get("overall_fg_pct_allowed",0.46)*1.15) - (away["ts_pct"] - hoa.get("overall_fg_pct_allowed",0.46)*1.15)
    three_m = (home["fg3_pct"] - aoa.get("three_fg_pct_allowed",0.36)) - (away["fg3_pct"] - hoa.get("three_fg_pct_allowed",0.36))
    rim_m   = (home.get("ftr",0.22) - aoa.get("rim_freq_allowed",0.25)) - (away.get("ftr",0.22) - hoa.get("rim_freq_allowed",0.25))

    ts = home.get("star_power",0) + away.get("star_power",0)
    return {
        "net_diff": round(home["net_rating"]-away["net_rating"],3),
        "predicted_spread": round(hp-ap,2), "home_predicted_pts": round(hp,1), "away_predicted_pts": round(ap,1),
        "off_rating_edge": d("off_rating"), "def_rating_edge": round(away["def_rating"]-home["def_rating"],2),
        "pie_edge": d("pie"), "ts_edge": d("ts_pct"), "efg_edge": d("efg_pct"),
        "shot_quality_edge": round(shot_q,4), "three_matchup_edge": round(three_m,4), "rim_edge": round(rim_m,4),
        "tov_edge": d("tov_pct",True), "ast_to_edge": d("ast_to"),
        "oreb_edge": d("oreb_pct"), "dreb_edge": d("dreb_pct"),
        "pace_edge": round((home["pace"]-away["pace"])*0.003,4), "pace_mismatch": abs(home["pace"]-away["pace"]),
        "clutch_w_pct_edge": dc("w_pct"), "clutch_plus_minus_edge": dc("plus_minus"), "clutch_ft_edge": dc("ft_pct"),
        "hustle_edge": dh("score"), "contested_shots_edge": dh("contested_shots"), "charges_edge": dh("charges_drawn"),
        "star_power_edge": round((home.get("star_power",0)-away.get("star_power",0))/(ts if ts else 1),4),
        "pie_player_edge": round(home.get("top_pie",0)-away.get("top_pie",0),4),
        "net_rtg_top3_edge": round(home.get("avg_net_rtg_top3",0)-away.get("avg_net_rtg_top3",0),2),
        "variance_factor": round((home.get("fg3_rate",0.4)+away.get("fg3_rate",0.4))/2,3),
    }

# ─── routes ───────────────────────────────────────────────────────────────────
@app.route("/health")
def health(): return jsonify({"status":"ok","season":season(),"ts":time.time()})

@app.route("/matchup")
def matchup():
    home_name = request.args.get("home",""); away_name = request.args.get("away","")
    s = request.args.get("season", season())
    if not home_name or not away_name: return jsonify({"error":"home and away required"}),400

    ck = _ck("matchup",norm(home_name),norm(away_name),s)
    cached = cget(ck, TTL_GAME)
    if cached: return jsonify(cached)

    try:
        adv_r=adv(s); base_r=base(s); est_r=est(s); clutch_r=clutch(s)
        hustle_r=hustle(s); def_r=defense(s); player_r=players(s); lineup_r=lineups(s)

        home_id = tid(home_name); away_id = tid(away_name)
        home_gl  = gamelog(home_id,s) if home_id else []
        away_gl  = gamelog(away_id,s) if away_id else []
        home_oo  = on_off(home_id,s)  if home_id else []
        away_oo  = on_off(away_id,s)  if away_id else []

        home_p = build_profile(home_name,s,adv_r,base_r,est_r,clutch_r,hustle_r,def_r,player_r,lineup_r)
        away_p = build_profile(away_name,s,adv_r,base_r,est_r,clutch_r,hustle_r,def_r,player_r,lineup_r)
        home_f = analyze_gl(home_gl)
        away_f = analyze_gl(away_gl)
        deltas = build_deltas(home_p, away_p)

        result = {"home":home_p,"away":away_p,"home_form":home_f,"away_form":away_f,
                  "home_on_off":home_oo,"away_on_off":away_oo,"deltas":deltas,"season":s,"ts":time.time()}
        cset(ck,result)
        return jsonify(result)
    except Exception as e:
        traceback.print_exc(); return jsonify({"error":str(e)}),500

@app.route("/on_off")
def get_on_off():
    name = request.args.get("name",""); s = request.args.get("season",season())
    if not name: return jsonify({"error":"name required"}),400
    team_id = tid(name)
    if not team_id: return jsonify({"error":f"team not found: {name}"}),404
    return jsonify(on_off(team_id,s))

if __name__ == "__main__":
    print(f"[nba_service] v2  port={PORT}  season={season()}")
    app.run(host="0.0.0.0",port=PORT,debug=False,threaded=False)
