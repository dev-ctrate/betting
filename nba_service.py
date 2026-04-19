#!/usr/bin/env python3
"""
nba_service.py

FastAPI microservice wrapping swar/nba_api (official NBA Stats API).
Fetches every advanced metric the NBA publishes for free.

All league-wide endpoints (30 teams at once) are cached for 6 hours.
Per-team game logs cached for 20 minutes.
Single /matchup endpoint returns the full data package in one call.

Start:  python nba_service.py
Env:
  NBA_SERVICE_PORT   default 5001
  NBA_CACHE_DIR      default data/nba_cache
  NBA_REQUEST_DELAY  seconds between API calls, default 0.65
"""

import json
import os
import sys
import time
import hashlib
import threading
import traceback
from datetime import datetime
from pathlib import Path
from typing import Optional, List, Dict, Any

try:
    from flask import Flask, jsonify, request
except ImportError:
    print("pip install flask")
    sys.exit(1)

try:
    from nba_api.stats.endpoints import (
        LeagueDashTeamStats,
        LeagueDashTeamClutch,
        LeagueHustleStatsTeam,
        LeagueDashPtTeamDefend,
        LeagueDashPlayerStats,
        LeagueEstimatedMetrics,
        TeamGameLog,
        LeagueDashLineups,
        TeamPlayerOnOffDetails,
        LeagueHustleStatsPlayer,
        LeagueDashPlayerPtShot,
        LeagueDashPtStats,
    )
    from nba_api.stats.static import teams as nba_teams_static
except ImportError:
    print("pip install nba_api")
    sys.exit(1)

app = Flask(__name__)

# ─── config ───────────────────────────────────────────────────────────────────
CACHE_DIR    = Path(os.environ.get("NBA_CACHE_DIR", "data/nba_cache"))
PORT         = int(os.environ.get("NBA_SERVICE_PORT", 5001))
REQ_DELAY    = float(os.environ.get("NBA_REQUEST_DELAY", 0.65))
CACHE_DIR.mkdir(parents=True, exist_ok=True)

TTL_LEAGUE   = 6   * 3600   # 6 h  — league stats change only after games
TTL_GAMELOG  = 20  * 60     # 20 min — game results trickle in
TTL_PLAYERS  = 30  * 60     # 30 min
TTL_LINEUPS  = 60  * 60     # 1 h

_api_lock = threading.Lock()   # serialise NBA API calls to respect rate limits

# ─── caching ──────────────────────────────────────────────────────────────────
def _ck(*parts: str) -> str:
    return hashlib.md5("__".join(str(p) for p in parts).encode()).hexdigest()

def cache_get(key: str, ttl: int) -> Optional[Any]:
    p = CACHE_DIR / f"{key}.json"
    if not p.exists():
        return None
    try:
        d = json.loads(p.read_text())
        if time.time() - d.get("ts", 0) < ttl:
            return d["data"]
    except Exception:
        pass
    return None

def cache_set(key: str, data: Any) -> Any:
    try:
        (CACHE_DIR / f"{key}.json").write_text(
            json.dumps({"ts": time.time(), "data": data}))
    except Exception:
        pass
    return data

# ─── helpers ──────────────────────────────────────────────────────────────────
def current_season() -> str:
    d = datetime.now()
    return f"{d.year}-{str(d.year+1)[-2:]}" if d.month >= 10 else f"{d.year-1}-{str(d.year)[-2:]}"

def safe_df(endpoint, idx: int = 0) -> List[Dict]:
    try:
        df = endpoint.get_data_frames()[idx]
        return df.fillna(0).to_dict("records")
    except Exception:
        return []

def norm(s: str) -> str:
    return str(s or "").lower().replace("-", " ").replace(".", "").strip()

def find_row(rows: List[Dict], name: str) -> Optional[Dict]:
    """Fuzzy team name lookup."""
    target = norm(name)
    for r in rows:
        rn = norm(r.get("TEAM_NAME") or r.get("TEAM") or "")
        if rn == target:
            return r
    nick = target.split()[-1] if target.split() else ""
    if len(nick) > 3:
        for r in rows:
            rn = norm(r.get("TEAM_NAME") or r.get("TEAM") or "")
            if nick in rn:
                return r
    return None

def _nba(fn, *args, **kwargs):
    """Call nba_api function with rate-limit delay."""
    with _api_lock:
        time.sleep(REQ_DELAY)
        return fn(*args, **kwargs)

def safe_float(v, fallback=0.0) -> float:
    try:
        f = float(v)
        return f if f == f else fallback  # NaN check
    except Exception:
        return fallback

# ─── team ID lookup ───────────────────────────────────────────────────────────
_team_id_cache: Dict[str, Optional[int]] = {}

def get_team_id(name: str) -> Optional[int]:
    if name in _team_id_cache:
        return _team_id_cache[name]
    all_teams = nba_teams_static.get_teams()
    target = norm(name)
    for t in all_teams:
        if norm(t["full_name"]) == target:
            _team_id_cache[name] = t["id"]
            return t["id"]
        nick = target.split()[-1]
        if len(nick) > 3 and nick in norm(t["full_name"]):
            _team_id_cache[name] = t["id"]
            return t["id"]
    _team_id_cache[name] = None
    return None

# ─── league-wide fetches (one call per endpoint = all 30 teams) ───────────────

def fetch_league_advanced(season: str) -> List[Dict]:
    key = _ck("league_adv", season)
    hit = cache_get(key, TTL_LEAGUE)
    if hit is not None:
        return hit
    print(f"[nba] Fetching LeagueDashTeamStats Advanced {season}...")
    try:
        ep = _nba(LeagueDashTeamStats,
                  season=season,
                  measure_type_detailed_defense="Advanced",
                  per_mode_simple="PerGame")
        data = safe_df(ep)
        return cache_set(key, data)
    except Exception as e:
        print(f"[nba] league_advanced failed: {e}")
        return []

def fetch_league_base(season: str) -> List[Dict]:
    key = _ck("league_base", season)
    hit = cache_get(key, TTL_LEAGUE)
    if hit is not None:
        return hit
    print(f"[nba] Fetching LeagueDashTeamStats Base {season}...")
    try:
        ep = _nba(LeagueDashTeamStats,
                  season=season,
                  measure_type_detailed_defense="Base",
                  per_mode_simple="PerGame")
        data = safe_df(ep)
        return cache_set(key, data)
    except Exception as e:
        print(f"[nba] league_base failed: {e}")
        return []

def fetch_league_estimated(season: str) -> List[Dict]:
    key = _ck("league_est", season)
    hit = cache_get(key, TTL_LEAGUE)
    if hit is not None:
        return hit
    print(f"[nba] Fetching LeagueEstimatedMetrics {season}...")
    try:
        ep = _nba(LeagueEstimatedMetrics, season=season)
        data = safe_df(ep)
        return cache_set(key, data)
    except Exception as e:
        print(f"[nba] league_estimated failed: {e}")
        return []

def fetch_league_clutch(season: str) -> List[Dict]:
    key = _ck("league_clutch", season)
    hit = cache_get(key, TTL_LEAGUE)
    if hit is not None:
        return hit
    print(f"[nba] Fetching LeagueDashTeamClutch {season}...")
    try:
        # Clutch = within 5 pts, last 5 min (default)
        ep = _nba(LeagueDashTeamClutch,
                  season=season,
                  per_mode_simple="PerGame",
                  measure_type_detailed_defense="Base")
        data = safe_df(ep)
        return cache_set(key, data)
    except Exception as e:
        print(f"[nba] league_clutch failed: {e}")
        return []

def fetch_league_hustle(season: str) -> List[Dict]:
    key = _ck("league_hustle", season)
    hit = cache_get(key, TTL_LEAGUE)
    if hit is not None:
        return hit
    print(f"[nba] Fetching LeagueHustleStatsTeam {season}...")
    try:
        ep = _nba(LeagueHustleStatsTeam,
                  season=season,
                  per_mode_time="PerGame")
        data = safe_df(ep)
        return cache_set(key, data)
    except Exception as e:
        print(f"[nba] league_hustle failed: {e}")
        return []

def fetch_league_defense(season: str) -> List[Dict]:
    """Opponent shot quality by zone."""
    key = _ck("league_defense", season)
    hit = cache_get(key, TTL_LEAGUE)
    if hit is not None:
        return hit
    print(f"[nba] Fetching LeagueDashPtTeamDefend {season}...")
    results = {}
    categories = ["Overall", "2 Pointers", "3 Pointers",
                  "Less Than 6Ft", "Less Than 10Ft", "Greater Than 15Ft"]
    for cat in categories:
        try:
            ep = _nba(LeagueDashPtTeamDefend,
                      season=season,
                      defense_category=cat,
                      per_mode_simple="PerGame")
            rows = safe_df(ep)
            for r in rows:
                tn = r.get("TEAM_NAME", "")
                if tn not in results:
                    results[tn] = {}
                results[tn][cat] = {
                    "freq":     safe_float(r.get("FREQ")),
                    "fga_def":  safe_float(r.get("FGA_DEFENDED")),
                    "fg_pct":   safe_float(r.get("FG_PCT")),
                    "fg_pct_diff": safe_float(r.get("FG_PCT_DIFF")),
                }
        except Exception as e:
            print(f"[nba] defense {cat} failed: {e}")
    data = [{"TEAM_NAME": tn, "zones": zones} for tn, zones in results.items()]
    return cache_set(key, data)

def fetch_league_players_advanced(season: str) -> List[Dict]:
    key = _ck("league_players_adv", season)
    hit = cache_get(key, TTL_PLAYERS)
    if hit is not None:
        return hit
    print(f"[nba] Fetching LeagueDashPlayerStats Advanced {season}...")
    try:
        ep = _nba(LeagueDashPlayerStats,
                  season=season,
                  measure_type_detailed_defense="Advanced",
                  per_mode_simple="PerGame")
        data = safe_df(ep)
        return cache_set(key, data)
    except Exception as e:
        print(f"[nba] players_advanced failed: {e}")
        return []

def fetch_league_lineups(season: str, group_quantity: int = 5) -> List[Dict]:
    key = _ck("league_lineups", season, group_quantity)
    hit = cache_get(key, TTL_LINEUPS)
    if hit is not None:
        return hit
    print(f"[nba] Fetching LeagueDashLineups {season} ({group_quantity}-man)...")
    try:
        ep = _nba(LeagueDashLineups,
                  season=season,
                  group_quantity=group_quantity,
                  measure_type_detailed_defense="Advanced",
                  per_mode_simple="PerGame")
        data = safe_df(ep)
        return cache_set(key, data)
    except Exception as e:
        print(f"[nba] lineups failed: {e}")
        return []

def fetch_team_gamelog(team_id: int, season: str, n: int = 20) -> List[Dict]:
    key = _ck("team_gamelog", team_id, season)
    hit = cache_get(key, TTL_GAMELOG)
    if hit is not None:
        return hit
    print(f"[nba] Fetching TeamGameLog {team_id} {season}...")
    try:
        ep = _nba(TeamGameLog, team_id=team_id, season=season)
        rows = safe_df(ep)
        # Enrich with opponent score = PTS - PLUS_MINUS
        for r in rows:
            r["OPP_PTS"] = safe_float(r.get("PTS")) - safe_float(r.get("PLUS_MINUS"))
        return cache_set(key, rows[-n:] if len(rows) > n else rows)
    except Exception as e:
        print(f"[nba] team_gamelog {team_id} failed: {e}")
        return []

# ─── data assembly ────────────────────────────────────────────────────────────

def build_team_profile(team_name: str, season: str,
                       adv_rows, base_rows, est_rows,
                       clutch_rows, hustle_rows, defense_rows,
                       player_rows, lineup_rows) -> Dict:
    """Assemble the full advanced profile for one team."""

    adv     = find_row(adv_rows,     team_name) or {}
    base    = find_row(base_rows,    team_name) or {}
    est     = find_row(est_rows,     team_name) or {}
    clutch  = find_row(clutch_rows,  team_name) or {}
    hustle  = find_row(hustle_rows,  team_name) or {}
    def_row = find_row(defense_rows, team_name)

    # ── Core efficiency (official NBA) ────────────────────────────────────────
    off_rating  = safe_float(adv.get("OFF_RATING")  or est.get("E_OFF_RATING"),  108)
    def_rating  = safe_float(adv.get("DEF_RATING")  or est.get("E_DEF_RATING"),  112)
    net_rating  = safe_float(adv.get("NET_RATING")  or est.get("E_NET_RATING"),  off_rating - def_rating)
    pace        = safe_float(adv.get("PACE")        or est.get("E_PACE"),         98)
    pie         = safe_float(adv.get("PIE"),         0.50)
    poss        = safe_float(adv.get("POSS"),        pace)

    ts_pct      = safe_float(adv.get("TS_PCT"),      0.55)
    efg_pct     = safe_float(adv.get("EFG_PCT"),     0.52)
    tov_pct     = safe_float(adv.get("TM_TOV_PCT"),  14.0)
    oreb_pct    = safe_float(adv.get("OREB_PCT"),    0.24)
    dreb_pct    = safe_float(adv.get("DREB_PCT"),    0.76)
    ast_pct     = safe_float(adv.get("AST_PCT"),     0.60)
    ast_to      = safe_float(adv.get("AST_TO"),      2.0)
    ast_ratio   = safe_float(adv.get("AST_RATIO"),   16.0)

    # ── Base stats ─────────────────────────────────────────────────────────────
    pts         = safe_float(base.get("PTS"),       110)
    reb         = safe_float(base.get("REB"),        44)
    ast         = safe_float(base.get("AST"),        26)
    stl         = safe_float(base.get("STL"),         8)
    blk         = safe_float(base.get("BLK"),         5)
    tov         = safe_float(base.get("TOV"),        14)
    fgm         = safe_float(base.get("FGM"),        42)
    fga         = safe_float(base.get("FGA"),        88)
    fg3m        = safe_float(base.get("FG3M"),       13)
    fg3a        = safe_float(base.get("FG3A"),       36)
    fta         = safe_float(base.get("FTA"),        19)
    ftm         = safe_float(base.get("FTM"),        15)
    oreb        = safe_float(base.get("OREB"),       10)
    dreb        = safe_float(base.get("DREB"),       34)
    fg_pct      = safe_float(base.get("FG_PCT"),     0.47)
    fg3_pct     = safe_float(base.get("FG3_PCT"),    0.36)
    ft_pct      = safe_float(base.get("FT_PCT"),     0.77)
    w_pct       = safe_float(base.get("W_PCT"),      0.50)
    gp          = int(safe_float(base.get("GP"),     40))

    # ── Derived metrics ───────────────────────────────────────────────────────
    ftr    = fga > 0 and fta / fga or 0.22
    fg3_rate = fga > 0 and fg3a / fga or 0.40
    # Scoring distribution
    pts_from_3  = fg3m * 3
    pts_from_2  = (fgm - fg3m) * 2
    pts_from_ft = ftm
    pct_3 = pts > 0 and pts_from_3 / pts or 0.35
    pct_2 = pts > 0 and pts_from_2 / pts or 0.47
    pct_ft = pts > 0 and pts_from_ft / pts or 0.16

    # ── Clutch stats ──────────────────────────────────────────────────────────
    clutch_w_pct    = safe_float(clutch.get("W_PCT"),      w_pct)
    clutch_plus_minus = safe_float(clutch.get("PLUS_MINUS"), net_rating * 0.5)
    clutch_pts      = safe_float(clutch.get("PTS"),        pts)
    clutch_tov      = safe_float(clutch.get("TOV"),        tov)
    clutch_fg_pct   = safe_float(clutch.get("FG_PCT"),     fg_pct)
    clutch_ft_pct   = safe_float(clutch.get("FT_PCT"),     ft_pct)
    clutch_gp       = int(safe_float(clutch.get("GP"),     1))

    # ── Hustle stats ──────────────────────────────────────────────────────────
    contested_shots     = safe_float(hustle.get("CONTESTED_SHOTS"),      15)
    contested_2pt       = safe_float(hustle.get("CONTESTED_SHOTS_2PT"),  8)
    contested_3pt       = safe_float(hustle.get("CONTESTED_SHOTS_3PT"),  7)
    charges_drawn       = safe_float(hustle.get("CHARGES_DRAWN"),        0.5)
    screen_assists      = safe_float(hustle.get("SCREEN_ASSISTS"),       10)
    screen_ast_pts      = safe_float(hustle.get("SCREEN_AST_PTS"),       22)
    box_outs            = safe_float(hustle.get("BOX_OUTS"),             12)
    def_loose_balls     = safe_float(hustle.get("DEF_LOOSE_BALLS_RECOVERED"), 1.5)
    off_box_outs        = safe_float(hustle.get("OFF_BOXOUTS"),          4)
    def_box_outs        = safe_float(hustle.get("DEF_BOXOUTS"),          8)

    # Composite hustle score (0–100 range)
    hustle_score = (
        contested_shots * 0.8 +
        charges_drawn * 4.0 +
        screen_ast_pts * 0.2 +
        box_outs * 0.4 +
        def_loose_balls * 2.0 +
        (contested_3pt / max(contested_shots, 1)) * 10
    )

    # ── Defensive shot quality ─────────────────────────────────────────────────
    defense_profile = {}
    if def_row and def_row.get("zones"):
        zones = def_row["zones"]
        defense_profile = {
            "overall_fg_pct_allowed":  zones.get("Overall",  {}).get("fg_pct",  0.46),
            "rim_fg_pct_allowed":      zones.get("Less Than 6Ft", {}).get("fg_pct", 0.63),
            "mid_range_fg_pct_allowed": zones.get("Greater Than 15Ft", {}).get("fg_pct", 0.42),
            "three_fg_pct_allowed":    zones.get("3 Pointers", {}).get("fg_pct", 0.36),
            "three_freq_allowed":      zones.get("3 Pointers", {}).get("freq",   0.30),
            "rim_freq_allowed":        zones.get("Less Than 6Ft", {}).get("freq", 0.25),
        }
    else:
        defense_profile = {
            "overall_fg_pct_allowed":  0.46,
            "rim_fg_pct_allowed":      0.63,
            "mid_range_fg_pct_allowed": 0.42,
            "three_fg_pct_allowed":    0.36,
            "three_freq_allowed":      0.30,
            "rim_freq_allowed":        0.25,
        }

    # ── Players ───────────────────────────────────────────────────────────────
    team_abbr_map = {
        r.get("PLAYER_NAME"): r.get("TEAM_ABBREVIATION", "")
        for r in player_rows
    }
    team_players = [
        r for r in player_rows
        if norm(r.get("TEAM_NAME","") or "") == norm(team_name)
        or (norm(team_name).split()[-1] in norm(r.get("TEAM_NAME","") or ""))
    ][:10]

    player_profiles = []
    for p in sorted(team_players, key=lambda x: -safe_float(x.get("MIN"))):
        pp = {
            "name":        p.get("PLAYER_NAME", ""),
            "min":         safe_float(p.get("MIN"),          0),
            "off_rtg":     safe_float(p.get("OFF_RATING"),   105),
            "def_rtg":     safe_float(p.get("DEF_RATING"),   112),
            "net_rtg":     safe_float(p.get("NET_RATING"),  -7),
            "ts_pct":      safe_float(p.get("TS_PCT"),       0.55),
            "efg_pct":     safe_float(p.get("EFG_PCT"),      0.52),
            "usg_pct":     safe_float(p.get("USG_PCT"),      0.20),
            "ast_pct":     safe_float(p.get("AST_PCT"),      0.15),
            "ast_to":      safe_float(p.get("AST_TO"),       1.5),
            "oreb_pct":    safe_float(p.get("OREB_PCT"),     0.04),
            "dreb_pct":    safe_float(p.get("DREB_PCT"),     0.15),
            "tov_pct":     safe_float(p.get("TM_TOV_PCT"),   14),
            "pie":         safe_float(p.get("PIE"),          0.10),
            "pace":        safe_float(p.get("PACE"),         98),
            "e_pace":      safe_float(p.get("E_PACE"),       98),
        }
        # Star score: usage × (off_rtg – 100) + pie × 30
        pp["star_score"] = pp["usg_pct"] * max(pp["off_rtg"] - 100, 0) + pp["pie"] * 30
        player_profiles.append(pp)

    star_power = sum(p["star_score"] / (i + 1) for i, p in enumerate(player_profiles))
    top_pie    = player_profiles[0]["pie"] if player_profiles else pie
    top_usg    = player_profiles[0]["usg_pct"] if player_profiles else 0.28
    avg_net_rtg_top3 = (sum(p["net_rtg"] for p in player_profiles[:3]) / 3
                        if len(player_profiles) >= 3 else net_rating)

    # ── Best 5-man lineup ─────────────────────────────────────────────────────
    team_lineups = [
        r for r in lineup_rows
        if norm(r.get("TEAM_NAME","")) == norm(team_name)
        or (norm(team_name).split()[-1] in norm(r.get("TEAM_NAME","")))
    ]
    best_lineup = None
    if team_lineups:
        ranked = sorted(team_lineups, key=lambda x: -safe_float(x.get("MIN")))
        best = ranked[0]
        best_lineup = {
            "players":    best.get("GROUP_NAME", ""),
            "net_rating": safe_float(best.get("NET_RATING")),
            "off_rating": safe_float(best.get("OFF_RATING")),
            "def_rating": safe_float(best.get("DEF_RATING")),
            "ts_pct":     safe_float(best.get("TS_PCT")),
            "min":        safe_float(best.get("MIN")),
        }

    return {
        # identification
        "team":   team_name,
        "season": season,
        "gp":     gp,
        "w_pct":  round(w_pct, 4),

        # official efficiency ratings (the gold standard)
        "off_rating":  round(off_rating, 2),
        "def_rating":  round(def_rating, 2),
        "net_rating":  round(net_rating, 2),
        "pace":        round(pace, 2),
        "poss":        round(poss, 2),
        "pie":         round(pie, 4),

        # shooting (official)
        "ts_pct":    round(ts_pct,  4),
        "efg_pct":   round(efg_pct, 4),
        "fg_pct":    round(fg_pct,  4),
        "fg3_pct":   round(fg3_pct, 4),
        "ft_pct":    round(ft_pct,  4),
        "ftr":       round(ftr, 4),
        "fg3_rate":  round(fg3_rate, 4),
        "pct_3":     round(pct_3, 4),
        "pct_2":     round(pct_2, 4),
        "pct_ft":    round(pct_ft, 4),

        # ball movement
        "tov_pct":   round(tov_pct,   2),
        "ast_pct":   round(ast_pct,   4),
        "ast_to":    round(ast_to,    2),
        "ast_ratio": round(ast_ratio, 2),

        # rebounding
        "oreb_pct":  round(oreb_pct, 4),
        "dreb_pct":  round(dreb_pct, 4),

        # raw per-game
        "pts": round(pts, 1), "reb": round(reb, 1), "ast": round(ast, 1),
        "stl": round(stl, 1), "blk": round(blk, 1), "tov": round(tov, 1),
        "fga": round(fga, 1), "fgm": round(fgm, 1),
        "fg3a": round(fg3a, 1), "fg3m": round(fg3m, 1),
        "fta": round(fta, 1), "ftm": round(ftm, 1),
        "oreb": round(oreb, 1), "dreb": round(dreb, 1),

        # clutch (last 5 min, within 5 pts)
        "clutch": {
            "w_pct":       round(clutch_w_pct, 4),
            "plus_minus":  round(clutch_plus_minus, 2),
            "pts":         round(clutch_pts, 1),
            "fg_pct":      round(clutch_fg_pct, 4),
            "ft_pct":      round(clutch_ft_pct, 4),
            "tov":         round(clutch_tov, 2),
            "gp":          clutch_gp
        },

        # hustle
        "hustle": {
            "score":              round(hustle_score, 2),
            "contested_shots":    round(contested_shots, 1),
            "contested_3pt":      round(contested_3pt, 1),
            "charges_drawn":      round(charges_drawn, 2),
            "screen_ast_pts":     round(screen_ast_pts, 1),
            "box_outs":           round(box_outs, 1),
            "def_loose_balls":    round(def_loose_balls, 2),
        },

        # defensive shot quality
        "defense": defense_profile,

        # players
        "players":     player_profiles[:8],
        "star_power":  round(star_power, 2),
        "top_pie":     round(top_pie, 4),
        "top_usg":     round(top_usg, 4),
        "avg_net_rtg_top3": round(avg_net_rtg_top3, 2),

        # best lineup
        "best_lineup": best_lineup,
    }


def build_matchup_deltas(home: Dict, away: Dict) -> Dict:
    """
    Pre-compute all edge/delta values used by the JS model.
    Positive = home team advantage.
    """
    def d(key, invert=False):
        hv = home.get(key, 0)
        av = away.get(key, 0)
        return round((av - hv if invert else hv - av), 4)

    def dclutch(key, invert=False):
        hv = home.get("clutch", {}).get(key, 0)
        av = away.get("clutch", {}).get(key, 0)
        return round((av - hv if invert else hv - av), 4)

    def dhustle(key):
        hv = home.get("hustle", {}).get(key, 0)
        av = away.get("hustle", {}).get(key, 0)
        return round(hv - av, 4)

    # Predicted score from cross-matchup ORtg/DRtg
    home_predicted = home["off_rating"] * (away["def_rating"] / 100)
    away_predicted = away["off_rating"] * (home["def_rating"] / 100)
    predicted_spread = home_predicted - away_predicted

    # Official net rating differential
    net_diff = home["net_rating"] - away["net_rating"]

    # PIE differential
    pie_diff = home["pie"] - away["pie"]

    # Shot quality delta: how well each team's offense matches the other's defense
    # home offense vs away defense quality
    home_off_vs_away_def = (home["ts_pct"] - away["defense"].get("overall_fg_pct_allowed", 0.46) * 1.15)
    away_off_vs_home_def = (away["ts_pct"] - home["defense"].get("overall_fg_pct_allowed", 0.46) * 1.15)
    shot_quality_edge = home_off_vs_away_def - away_off_vs_home_def

    # 3PT matchup: home's 3pt% vs away's 3pt defense
    three_matchup_edge = (
        home["fg3_pct"] - away["defense"].get("three_fg_pct_allowed", 0.36) -
        (away["fg3_pct"] - home["defense"].get("three_fg_pct_allowed", 0.36))
    )

    # Rim attack: how much each team attacks the rim vs rim defense allowed
    home_rim_edge = (home.get("ftr", 0.22) - away["defense"].get("rim_freq_allowed", 0.25))
    away_rim_edge = (away.get("ftr", 0.22) - home["defense"].get("rim_freq_allowed", 0.25))
    rim_edge = home_rim_edge - away_rim_edge

    # Hustle composite edge
    hustle_edge = dhustle("score")

    return {
        "net_diff":         round(net_diff, 3),
        "predicted_spread": round(predicted_spread, 2),
        "home_predicted_pts": round(home_predicted, 1),
        "away_predicted_pts": round(away_predicted, 1),

        # Official ratings
        "off_rating_edge":  round(home["off_rating"] - away["off_rating"], 2),
        "def_rating_edge":  round(away["def_rating"] - home["def_rating"], 2),  # invert: lower DRtg = better

        # PIE
        "pie_edge":         round(pie_diff, 4),

        # Shooting
        "ts_edge":          d("ts_pct"),
        "efg_edge":         d("efg_pct"),
        "fg3_pct_edge":     d("fg3_pct"),
        "shot_quality_edge": round(shot_quality_edge, 4),
        "three_matchup_edge": round(three_matchup_edge, 4),
        "rim_edge":         round(rim_edge, 4),

        # Turnovers (lower tov_pct = better → invert)
        "tov_edge":         d("tov_pct", invert=True),
        "ast_to_edge":      d("ast_to"),

        # Rebounding
        "oreb_edge":        d("oreb_pct"),
        "dreb_edge":        d("dreb_pct"),

        # Pace
        "pace_edge":        round((home["pace"] - away["pace"]) * 0.003, 4),
        "pace_mismatch":    abs(home["pace"] - away["pace"]),

        # Clutch
        "clutch_w_pct_edge":      dclutch("w_pct"),
        "clutch_plus_minus_edge": dclutch("plus_minus"),
        "clutch_ft_edge":         dclutch("ft_pct"),
        "clutch_tov_edge":        dclutch("tov", invert=True),

        # Hustle
        "hustle_edge":           hustle_edge,
        "contested_shots_edge":  dhustle("contested_shots"),
        "charges_edge":          dhustle("charges_drawn"),

        # Players
        "star_power_edge":   round(home.get("star_power", 0) - away.get("star_power", 0), 3),
        "pie_player_edge":   round(home.get("top_pie", 0)    - away.get("top_pie", 0), 4),
        "net_rtg_top3_edge": round(home.get("avg_net_rtg_top3", 0) - away.get("avg_net_rtg_top3", 0), 2),

        # Variance
        "variance_factor":   round((home.get("fg3_rate", 0.4) + away.get("fg3_rate", 0.4)) / 2, 3),
    }

# ─── game log analysis ────────────────────────────────────────────────────────
def analyze_gamelog(games: List[Dict], season: str) -> Dict:
    if not games:
        return {}
    diffs, pts_scored, pts_allowed, home_wl, away_wl = [], [], [], [], []
    for g in games:
        pts  = safe_float(g.get("PTS"))
        opp  = safe_float(g.get("OPP_PTS"))
        diff = pts - opp
        won  = g.get("WL") == "W"
        matchup = str(g.get("MATCHUP", ""))
        is_home = "vs." in matchup

        diffs.append(diff)
        pts_scored.append(pts)
        pts_allowed.append(opp)
        if is_home: home_wl.append(won)
        else:       away_wl.append(won)

    n       = len(diffs)
    avg_d   = sum(diffs) / n
    avg5    = sum(diffs[-5:]) / min(5, n)
    avg10   = sum(diffs[-10:]) / min(10, n)
    win_r   = sum(1 for g in games if g.get("WL") == "W") / n
    win5    = sum(1 for g in games[-5:] if g.get("WL") == "W") / min(5, n)
    win10   = sum(1 for g in games[-10:] if g.get("WL") == "W") / min(10, n)
    momentum = win5 - win_r

    streak = 0
    for g in reversed(games):
        won = g.get("WL") == "W"
        if streak == 0:
            streak = 1 if won else -1
        elif (streak > 0) == won:
            streak += (1 if won else -1)
        else:
            break

    # Rest calculation
    last_game_date = games[-1].get("GAME_DATE", "") if games else ""
    rest_days = 2
    b2b = False
    if last_game_date:
        try:
            from datetime import date
            ld = datetime.strptime(last_game_date[:10], "%Y-%m-%d").date()
            today = date.today()
            rest_days = (today - ld).days
            b2b = rest_days <= 1
        except Exception:
            pass

    return {
        "games":         n,
        "win_rate":      round(win_r,  4),
        "win_rate5":     round(win5,   4),
        "win_rate10":    round(win10,  4),
        "avg_diff":      round(avg_d,  2),
        "avg_diff5":     round(avg5,   2),
        "avg_diff10":    round(avg10,  2),
        "momentum":      round(momentum, 4),
        "streak":        streak,
        "avg_pts":       round(sum(pts_scored)/n, 1),
        "avg_pts_allowed": round(sum(pts_allowed)/n, 1),
        "home_win_rate": round(sum(home_wl)/len(home_wl), 4) if home_wl else None,
        "away_win_rate": round(sum(away_wl)/len(away_wl), 4) if away_wl else None,
        "rest_days":     rest_days,
        "is_b2b":        b2b,
    }

# ─── routes ───────────────────────────────────────────────────────────────────

@app.route("/health")
def health():
    return jsonify({"status": "ok", "season": current_season(), "ts": time.time()})

@app.route("/matchup")
def matchup():
    home = request.args.get("home", "")
    away = request.args.get("away", "")
    season = request.args.get("season", current_season())

    if not home or not away:
        return jsonify({"error": "home and away required"}), 400

    cache_key_str = _ck("matchup", norm(home), norm(away), season)
    cached = cache_get(cache_key_str, TTL_GAMELOG)  # short TTL for matchup (20 min)
    if cached:
        return jsonify(cached)

    try:
        # ── Fetch all league-wide data (each cached for 6h) ──────────────────
        adv_rows     = fetch_league_advanced(season)
        base_rows    = fetch_league_base(season)
        est_rows     = fetch_league_estimated(season)
        clutch_rows  = fetch_league_clutch(season)
        hustle_rows  = fetch_league_hustle(season)
        defense_rows = fetch_league_defense(season)
        player_rows  = fetch_league_players_advanced(season)
        lineup_rows  = fetch_league_lineups(season)

        # ── Per-team game logs ────────────────────────────────────────────────
        home_id = get_team_id(home)
        away_id = get_team_id(away)

        home_games = fetch_team_gamelog(home_id, season) if home_id else []
        away_games = fetch_team_gamelog(away_id, season) if away_id else []

        # ── Build profiles ───────────────────────────────────────────────────
        home_profile = build_team_profile(
            home, season,
            adv_rows, base_rows, est_rows,
            clutch_rows, hustle_rows, defense_rows,
            player_rows, lineup_rows
        )
        away_profile = build_team_profile(
            away, season,
            adv_rows, base_rows, est_rows,
            clutch_rows, hustle_rows, defense_rows,
            player_rows, lineup_rows
        )

        home_form = analyze_gamelog(home_games, season)
        away_form = analyze_gamelog(away_games, season)

        deltas = build_matchup_deltas(home_profile, away_profile)

        result = {
            "home":      home_profile,
            "away":      away_profile,
            "home_form": home_form,
            "away_form": away_form,
            "deltas":    deltas,
            "season":    season,
            "ts":        time.time()
        }

        cache_set(cache_key_str, result)
        return jsonify(result)

    except Exception as e:
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

@app.route("/team")
def team():
    name   = request.args.get("name", "")
    season = request.args.get("season", current_season())
    if not name:
        return jsonify({"error": "name required"}), 400
    try:
        adv_rows     = fetch_league_advanced(season)
        base_rows    = fetch_league_base(season)
        est_rows     = fetch_league_estimated(season)
        clutch_rows  = fetch_league_clutch(season)
        hustle_rows  = fetch_league_hustle(season)
        defense_rows = fetch_league_defense(season)
        player_rows  = fetch_league_players_advanced(season)
        lineup_rows  = fetch_league_lineups(season)
        profile      = build_team_profile(name, season, adv_rows, base_rows, est_rows,
                                          clutch_rows, hustle_rows, defense_rows,
                                          player_rows, lineup_rows)
        return jsonify(profile)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    print(f"[nba_service] Starting on port {PORT}, season {current_season()}")
    app.run(host="0.0.0.0", port=PORT, debug=False, threaded=False)
