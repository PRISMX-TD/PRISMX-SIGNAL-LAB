import pytest
from fastapi import HTTPException

from app.models import User
from app.routers.gamification import admin_get_settings, admin_patch_settings, admin_leaderboard
from app.schemas import GamificationSettingsPatchIn
from app.services.settings_store import get_gamification_settings, invalidate_gamification_cache


def test_settings_roundtrip_partial(db_session):
    # 进程级设置缓存 30 秒 TTL，跨测试文件共享——先失效一次，避免读到别的用例
    # 留下的残值（同其它设置测试文件的一贯写法）。
    # The settings cache is process-global with a 30s TTL, shared across test
    # files — invalidate first so we don't read a value left behind by
    # another test (same convention every other settings test file follows).
    invalidate_gamification_cache()
    s = admin_get_settings(db=db_session)
    assert s == {"userVisible": False, "leaderboardVisible": False,
                 "competitionsVisible": False, "minBaselineUsd": 500.0,
                 "minTradesReturn": 5, "minTradesWinrate": 20,
                 "winrateRequireProfit": False,
                 "competitionsPublicEnabled": False, "featuredCompetitionId": None}
    admin_patch_settings(GamificationSettingsPatchIn(leaderboardVisible=True), db=db_session)
    invalidate_gamification_cache()
    got = get_gamification_settings(db_session)
    assert got["leaderboard_visible"] is True and got["user_visible"] is False
    assert got["min_baseline_usd"] == 500.0        # 未传字段不动
    assert got["min_trades_return"] == 5 and got["min_trades_winrate"] == 20
    assert got["winrate_require_profit"] is False


def test_winrate_require_profit_roundtrip(db_session):
    """胜率榜盈亏正闸：管理端可翻，来回一趟都要落库、其余键不受影响。"""
    invalidate_gamification_cache()
    out = admin_patch_settings(GamificationSettingsPatchIn(winrateRequireProfit=True), db=db_session)
    assert out["winrateRequireProfit"] is True
    invalidate_gamification_cache()
    got = get_gamification_settings(db_session)
    assert got["winrate_require_profit"] is True
    assert got["min_trades_winrate"] == 20        # 未传字段不动
    # 复位，免得污染同库跑的其他测试（同本文件其余设置测试的写法）
    admin_patch_settings(GamificationSettingsPatchIn(winrateRequireProfit=False), db=db_session)
    invalidate_gamification_cache()


def test_min_baseline_validation(db_session):
    with pytest.raises(HTTPException):
        admin_patch_settings(GamificationSettingsPatchIn(minBaselineUsd=0), db=db_session)


def test_min_trades_validation(db_session):
    with pytest.raises(HTTPException):
        admin_patch_settings(GamificationSettingsPatchIn(minTradesReturn=0), db=db_session)
    with pytest.raises(HTTPException):
        admin_patch_settings(GamificationSettingsPatchIn(minTradesWinrate=0), db=db_session)


def test_min_trades_roundtrip(db_session):
    invalidate_gamification_cache()
    admin_patch_settings(GamificationSettingsPatchIn(minTradesReturn=1, minTradesWinrate=2),
                          db=db_session)
    invalidate_gamification_cache()
    got = get_gamification_settings(db_session)
    assert got["min_trades_return"] == 1 and got["min_trades_winrate"] == 2


def test_admin_preview_ignores_user_gate(db_session):
    a = User(email="ap@t.co", api_token="tok_ap", role="admin")
    db_session.add(a); db_session.commit()
    p = admin_leaderboard(board="return_pct", period="week", db=db_session, admin=a)
    assert p["rows"] == [] and "periodKey" in p     # 开关关着也能预览


def _snap(db, user, key, board="return_pct", rank=1, login="1001", score=0.1):
    from app.models import LeaderboardSnapshot
    db.add(LeaderboardSnapshot(board=board, period_key=key, user_id=user.id,
                               mt5_login=login, rank=rank, score=score, sample=6))


def test_admin_history_periods_lists_closed_and_current(db_session):
    from app.routers.gamification import admin_leaderboard_periods
    from app.services.gamification import periods
    from datetime import datetime, timezone
    u = User(email="hp@t.co", api_token="tok_hp")
    db_session.add(u); db_session.commit()
    _snap(db_session, u, "2025-W10"); _snap(db_session, u, "2025-W11", board="win_rate")
    _snap(db_session, u, "2025-03"); _snap(db_session, u, "comp:x")
    db_session.commit()
    weeks = admin_leaderboard_periods(kind="week", db=db_session)["periods"]
    keys = [p["periodKey"] for p in weeks]
    now_week = periods.week_key(datetime.now(timezone.utc))
    assert keys[0] == now_week and weeks[0]["current"] is True    # 本期即使没快照也在第一行
    assert keys.index("2025-W11") < keys.index("2025-W10")        # 新的在前
    assert "2025-03" not in keys and "comp:x" not in keys
    w11 = next(p for p in weeks if p["periodKey"] == "2025-W11")
    assert w11["counts"] == {"return_pct": 0, "win_rate": 1}
    months = [p["periodKey"] for p in admin_leaderboard_periods(kind="month", db=db_session)["periods"]]
    assert "2025-03" in months and "2025-W10" not in months
    with pytest.raises(HTTPException):
        admin_leaderboard_periods(kind="year", db=db_session)


def test_admin_history_closed_period_board(db_session):
    a = User(email="hb@t.co", api_token="tok_hb", role="admin")
    u = User(email="hb2@t.co", api_token="tok_hb2", nickname="老王")
    db_session.add_all([a, u]); db_session.commit()
    _snap(db_session, u, "2025-W20", rank=1, login="777")
    db_session.commit()
    p = admin_leaderboard(board="return_pct", period="2025-W20", db=db_session, admin=a)
    assert p["periodKey"] == "2025-W20"
    assert [(r["rank"], r["login"], r["email"]) for r in p["rows"]] == [(1, "777", "hb2@t.co")]


def test_admin_user_board_history(db_session):
    from app.routers.gamification import admin_leaderboard_user_history
    u = User(email="hu@t.co", api_token="tok_hu")
    o = User(email="hu2@t.co", api_token="tok_hu2")
    db_session.add_all([u, o]); db_session.commit()
    _snap(db_session, u, "2025-W30", rank=2)
    _snap(db_session, o, "2025-W30", rank=1, login="2002")
    _snap(db_session, u, "2025-07", board="win_rate", rank=1, score=0.8)
    _snap(db_session, u, "comp:y", rank=1)
    db_session.commit()
    h = admin_leaderboard_user_history(user_id=u.id, db=db_session)
    got = [(e["periodKey"], e["kind"], e["board"], e["rank"], e["total"]) for e in h["entries"]]
    assert ("2025-W30", "week", "return_pct", 2, 2) in got
    assert ("2025-07", "month", "win_rate", 1, 1) in got
    assert all(not e[0].startswith("comp:") for e in got) and len(got) == 2
    with pytest.raises(HTTPException):
        admin_leaderboard_user_history(user_id="nope", db=db_session)
