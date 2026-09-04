from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from app.models import ClosedTrade, LeaderboardSnapshot, MT5Account, Order, PeriodBaseline, User
from app.routers.gamification import build_leaderboard_payload, _check_leaderboard_visible
from app.services.gamification import periods
from app.services.gamification.boards import ensure_baselines
from app.services.settings_store import save_gamification_settings, invalidate_gamification_cache

UTC = timezone.utc
PK = "2026-W36"
T0 = datetime(2026, 8, 31, 0, 0, tzinfo=UTC)      # 周一（期初），与 test_board_rows.py 同一 key
IN_WEEK = T0 + timedelta(days=2)


def _user(db, email, role="user", nickname=None, badge=None, nickname_public=False):
    u = User(email=email, api_token="tok_" + email, role=role, nickname=nickname,
             equipped_badge=badge, nickname_public=nickname_public)
    db.add(u); db.commit(); return u


def _row(db, u, login, rank, score, board="return_pct", period_key="2026-W36"):
    db.add(LeaderboardSnapshot(board=board, period_key=period_key,
                               user_id=u.id, mt5_login=login, rank=rank,
                               score=score, sample=8))
    db.commit()


def _acct(db, u, login, balance=2000.0):
    db.add(MT5Account(user_id=u.id, login=login, server="s", balance=balance,
                      trade_mode=2)); db.commit()


def _pos(db, u, login, ticket, profit, closed_at, vol=0.1):
    db.add(Order(user_id=u.id, client_order_id=f"c{login}{ticket}", symbol="X",
                 side="BUY", volume=vol, status="FILLED", mt5_login=login,
                 mt5_ticket=ticket, trade_mode=2,
                 created_at=closed_at - timedelta(hours=2)))
    db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="X", side="BUY",
                       close_volume=vol, close_price=1, profit=profit,
                       position_ticket=ticket, deal_ticket=ticket * 10,
                       closed_at=closed_at, verified=True))
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
    assert p["me"] == {"rank": 2, "score": 0.10, "sample": 8, "login": "600001"}
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
    assert p["gates"] == {"minTradesReturn": 5, "minTradesWinrate": 20,
                          "minBaselineUsd": 500.0, "winrateRequireProfit": False}

    save_gamification_settings(db_session, {
        "min_trades_return": 1, "min_trades_winrate": 2, "min_baseline_usd": 50.0,
        "winrate_require_profit": True,
    })
    db_session.commit(); invalidate_gamification_cache()
    try:
        p2 = build_leaderboard_payload(db_session, u, "win_rate", "2026-W36")
        assert p2["gates"] == {"minTradesReturn": 1, "minTradesWinrate": 2,
                               "minBaselineUsd": 50.0, "winrateRequireProfit": True}
    finally:
        save_gamification_settings(db_session, {
            "min_trades_return": 5, "min_trades_winrate": 20, "min_baseline_usd": 500.0,
            "winrate_require_profit": False,
        })
        db_session.commit(); invalidate_gamification_cache()


def test_period_bounds_and_seal_at_for_week_key(db_session):
    u = _user(db_session, "bounds1@t.co")
    p = build_leaderboard_payload(db_session, u, "return_pct", PK)
    start, end = periods.period_bounds(PK)
    assert p["periodStart"] == start.isoformat()
    assert p["periodEnd"] == end.isoformat()
    assert p["sealAt"] == (end + timedelta(hours=periods.RECOMPUTE_GRACE_HOURS)).isoformat()


def test_progress_for_unranked_viewer_with_baseline(db_session):
    """未上榜（本期笔数不够）但已拍基线的用户：progress 用 board 计算同一套
    `_resolved_in_period`，样本数与门槛回显必须与 gates 完全一致。"""
    u = _user(db_session, "prog1@t.co")
    _acct(db_session, u, "A", balance=1864.99)
    ensure_baselines(db_session, PK, T0)
    _pos(db_session, u, "A", 1, 10.0, IN_WEEK)
    _pos(db_session, u, "A", 2, -3.0, IN_WEEK)      # 2 笔，未达默认门槛 5 笔 → 不上榜

    p = build_leaderboard_payload(db_session, u, "return_pct", PK)
    assert p["me"] is None
    assert p["progress"] == {
        "login": "A", "sample": 2, "baselineUsd": 1864.99,
        "minTrades": 5, "minBaselineUsd": 500.0,
    }


def test_progress_null_without_baseline(db_session):
    """本期从未拍过基线（未参与/未开实盘账户）：progress 必须是 None，不是
    一个笔数为 0 的假进度。"""
    u = _user(db_session, "prog2@t.co")
    p = build_leaderboard_payload(db_session, u, "return_pct", PK)
    assert p["me"] is None
    assert p["progress"] is None


def test_previous_winner_from_seeded_prior_period(db_session):
    """previousWinner 只在本榜当前为空时才算（前端只在空榜态渲染它）——这里
    本期（PK）故意不插任何行，同时验证读的是上一期而不是本期。"""
    prev_key = periods.previous_period_key(PK)
    assert prev_key == "2026-W35"
    a = _user(db_session, "champ@t.co", nickname="Champion")
    _row(db_session, a, "900001", 1, 0.087, period_key=prev_key)
    # 本期（PK）无关行，验证 previousWinner 读的是上一期而不是本期，且本期
    # 榜本身确实是空的（previousWinner 计算的前提条件）。
    b = _user(db_session, "viewer1@t.co")

    p = build_leaderboard_payload(db_session, b, "return_pct", PK)
    assert p["rows"] == []
    assert p["previousWinner"] == {"displayName": "C***n", "score": 0.087}


def test_previous_winner_not_computed_when_board_nonempty(db_session):
    """本期榜非空时，previousWinner 这个键依然存在（自然周/月榜恒定带这个
    键，types.ts 才站得住），但值必须是 None——不实际去查上一期，因为前端
    只在空榜态渲染它，非空态算了也是白算。"""
    prev_key = periods.previous_period_key(PK)
    a = _user(db_session, "champ2@t.co", nickname="Champion")
    _row(db_session, a, "900002", 1, 0.087, period_key=prev_key)
    # 本期塞一行，让本期榜非空
    c = _user(db_session, "current1@t.co")
    _row(db_session, c, "900003", 1, 0.05, period_key=PK)
    d = _user(db_session, "viewer2@t.co")

    p = build_leaderboard_payload(db_session, d, "return_pct", PK)
    assert len(p["rows"]) == 1
    assert p["previousWinner"] is None


def test_progress_null_for_opted_out_viewer(db_session):
    """退榜用户（leaderboard_opt_out）即使本期拍了基线、也有已判定整仓的
    交易，progress 也必须是 None——`compute_board_rows` 计算快照时本就把
    退榜用户整段跳过（§4.1「下轮快照即消失」），这个用户这期永远不会真的
    上榜，给他一个"本期已完成 s / N 笔"的进度条是误导。"""
    u = _user(db_session, "optout1@t.co")
    _acct(db_session, u, "A", balance=2000.0)
    ensure_baselines(db_session, PK, T0)          # 拍照时尚未退榜，基线正常拍下
    _pos(db_session, u, "A", 1, 10.0, IN_WEEK)
    _pos(db_session, u, "A", 2, 10.0, IN_WEEK)
    _pos(db_session, u, "A", 3, 10.0, IN_WEEK)
    u.leaderboard_opt_out = True                  # 期中才退榜——基线已经拍好了
    db_session.commit()

    p = build_leaderboard_payload(db_session, u, "return_pct", PK)
    assert p["me"] is None
    assert p["progress"] is None
