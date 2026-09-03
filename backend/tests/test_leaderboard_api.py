import pytest
from fastapi import HTTPException
from app.models import User, LeaderboardSnapshot
from app.routers.gamification import build_leaderboard_payload, _check_leaderboard_visible
from app.services.settings_store import save_gamification_settings, invalidate_gamification_cache


def _user(db, email, role="user", nickname=None, badge=None, nickname_public=False):
    u = User(email=email, api_token="tok_" + email, role=role, nickname=nickname,
             equipped_badge=badge, nickname_public=nickname_public)
    db.add(u); db.commit(); return u


def _row(db, u, login, rank, score):
    db.add(LeaderboardSnapshot(board="return_pct", period_key="2026-W36",
                               user_id=u.id, mt5_login=login, rank=rank,
                               score=score, sample=8))
    db.commit()


def test_gate_and_admin_bypass(db_session):
    invalidate_gamification_cache()
    u = _user(db_session, "g1@t.co")
    with pytest.raises(HTTPException) as e:
        _check_leaderboard_visible(db_session, u)
    assert e.value.status_code == 403
    _check_leaderboard_visible(db_session, _user(db_session, "ga@t.co", role="admin"))
    save_gamification_settings(db_session, {"leaderboard_visible": True})
    db_session.commit(); invalidate_gamification_cache()
    _check_leaderboard_visible(db_session, u)


def test_payload_masking_isself_and_me(db_session):
    a = _user(db_session, "top@t.co", nickname="Trader", badge="midas_touch")
    b = _user(db_session, "second@t.co")           # 无昵称 → 邮箱前缀打码
    c = _user(db_session, "third@t.co", nickname="Trader", nickname_public=True)  # 昵称公开 → 不打码
    _row(db_session, a, "500123", 1, 0.20)
    _row(db_session, a, "500999", 3, 0.05)         # 同一人第二个账户
    _row(db_session, b, "600001", 2, 0.10)
    _row(db_session, c, "700001", 4, 0.01)
    p = build_leaderboard_payload(db_session, b, "return_pct", "2026-W36")
    assert p["periodKey"] == "2026-W36" and len(p["rows"]) == 4
    r1, r2, _r3, r4 = p["rows"]
    assert r1["displayName"] == "T***r" and r1["login"] == "500123"
    assert r1["equippedBadge"] == "midas_touch" and r1["isSelf"] is False
    assert r2["displayName"] == "s***d" and r2["isSelf"] is True
    assert "userId" not in r1
    # 昵称公开的用户：displayName 用行自己的 nickname_public 读到的真实值，不打码
    assert r4["displayName"] == "Trader" and r4["isSelf"] is False
    assert p["me"] == {"rank": 2, "score": 0.10, "sample": 8}
    # a 的 me 取最好名次
    pa = build_leaderboard_payload(db_session, a, "return_pct", "2026-W36")
    assert pa["me"]["rank"] == 1
    # 该榜单/周期下无任何行的用户 → me 为 None
    d = _user(db_session, "fourth@t.co")
    pd = build_leaderboard_payload(db_session, d, "return_pct", "2026-W36")
    assert pd["me"] is None


def test_invalid_board_and_period(db_session):
    u = _user(db_session, "v1@t.co")
    with pytest.raises(HTTPException):
        build_leaderboard_payload(db_session, u, "profit", "2026-W36")
    with pytest.raises(HTTPException):
        build_leaderboard_payload(db_session, u, "return_pct", "bogus")


def test_payload_gates_reflect_admin_settings(db_session):
    """gates 必须读的是当下生效的设置，不是硬编码的 5/20/500——改了设置后
    同一个 payload 构造函数要立刻返回新值（同 test_board_rows.py 的覆盖/复位
    写法）。"""
    invalidate_gamification_cache()
    u = _user(db_session, "gate1@t.co")
    p = build_leaderboard_payload(db_session, u, "return_pct", "2026-W36")
    assert p["gates"] == {"minTradesReturn": 5, "minTradesWinrate": 20, "minBaselineUsd": 500.0}

    save_gamification_settings(db_session, {
        "min_trades_return": 1, "min_trades_winrate": 2, "min_baseline_usd": 50.0,
    })
    db_session.commit(); invalidate_gamification_cache()
    try:
        p2 = build_leaderboard_payload(db_session, u, "win_rate", "2026-W36")
        assert p2["gates"] == {"minTradesReturn": 1, "minTradesWinrate": 2, "minBaselineUsd": 50.0}
    finally:
        save_gamification_settings(db_session, {
            "min_trades_return": 5, "min_trades_winrate": 20, "min_baseline_usd": 500.0,
        })
        db_session.commit(); invalidate_gamification_cache()
