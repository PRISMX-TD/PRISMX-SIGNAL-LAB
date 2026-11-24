"""已平仓明细按账号分页（2026-11-24）。

以前 /orders/closed-trades 固定取「所有账号合计最新 200 条」，前端再按账号筛：一个账号
平仓多，另一个账号的记录就被挤出这 200 条（真实账号 166 条只显示得出 5 条）。现在按
账号取、可以一直往前翻。
"""
from datetime import datetime, timedelta

import pytest
from fastapi import HTTPException

from app.models import ClosedTrade, MT5Account, User
from app.routers import orders as orders_router
from app.services.trade_performance import invalidate_trade_caches

REAL = "600306"
DEMO = "100033"
BASE = datetime(2026, 11, 1, 12, 0, 0)


def _user(db, uid="u-page") -> User:
    user = User(id=uid, email=f"{uid}@t.local", api_token=f"tok-{uid}", plan="PRO")
    db.add(user)
    for login in (REAL, DEMO):
        db.add(MT5Account(user_id=uid, login=login, server="", source="gateway"))
    db.commit()
    return user


def _leg(uid, login, deal, *, position=None, minutes=0, profit=1.0, volume=0.01) -> ClosedTrade:
    return ClosedTrade(
        user_id=uid, mt5_login=login, symbol="XAUUSD", side="BUY", close_volume=volume,
        close_price=4000.0, profit=profit, position_ticket=position if position is not None else deal,
        deal_ticket=deal, closed_at=BASE + timedelta(minutes=minutes),
    )


def _walk(user, db, login):
    """从最新一页一直翻到底，返回 (每页结果, 去重后的全部腿)。"""
    pages, cursor = [], None
    while True:
        page = orders_router.list_closed_trades(login=login, cursor=cursor, user=user, db=db)
        pages.append(page)
        cursor = page["nextCursor"]
        if cursor is None:
            break
        assert len(pages) < 50, "翻页没有收敛"
    legs = {t["id"]: t for p in pages for t in p["trades"]}
    return pages, list(legs.values())


def test_busy_account_no_longer_crowds_out_the_other(db_session, monkeypatch):
    """复现线上：模拟账号最近平仓很多，真实账号较早的记录照样全部取得到。"""
    monkeypatch.setattr(orders_router, "CLOSED_TRADES_PAGE", 20)
    user = _user(db_session)
    # 真实账号 12 条在前（更早），模拟账号 60 条在后（更新）
    db_session.add_all([_leg(user.id, REAL, 1000 + i, minutes=i) for i in range(12)])
    db_session.add_all([_leg(user.id, DEMO, 2000 + i, minutes=100 + i) for i in range(60)])
    db_session.commit()

    # 旧口径（不传 login）：最新一页全是模拟账号的——这就是当初只看得到几条的原因
    legacy = orders_router.list_closed_trades(user=user, db=db_session)
    assert len(legacy["trades"]) == 20
    assert {t["mt5Login"] for t in legacy["trades"]} == {DEMO}

    real = orders_router.list_closed_trades(login=REAL, user=user, db=db_session)
    assert len(real["trades"]) == 12
    assert {t["mt5Login"] for t in real["trades"]} == {REAL}
    assert real["nextCursor"] is None
    assert real["totalPositions"] == 12


def test_paging_reaches_every_leg_exactly_once_in_order(db_session, monkeypatch):
    monkeypatch.setattr(orders_router, "CLOSED_TRADES_PAGE", 20)
    user = _user(db_session)
    # 65 条，其中每 5 条挤在同一秒，考验同时间戳的翻页边界
    db_session.add_all([_leg(user.id, DEMO, 3000 + i, minutes=i // 5) for i in range(65)])
    db_session.add_all([_leg(user.id, REAL, 4000 + i, minutes=i) for i in range(7)])
    db_session.commit()

    pages, legs = _walk(user, db_session, DEMO)
    assert len(pages) == 4
    assert [len(p["trades"]) for p in pages] == [20, 20, 20, 5]
    assert sorted(t["dealTicket"] for t in legs) == [3000 + i for i in range(65)]
    # 各页之间不重不漏、整体按时间倒序
    seen = [t for p in pages for t in p["trades"]]
    assert len(seen) == len({t["id"] for t in seen})
    assert [t["closedAt"] for t in seen] == sorted((t["closedAt"] for t in seen), reverse=True)
    # 只有第一页带仓位总数
    assert pages[0]["totalPositions"] == 65
    assert all("totalPositions" not in p for p in pages[1:])


def test_position_split_across_pages_comes_complete(db_session, monkeypatch):
    """分批平仓的仓位：最后一腿在第一页、较早的一腿本该在第三页——第一页就要带齐。"""
    monkeypatch.setattr(orders_router, "CLOSED_TRADES_PAGE", 10)
    user = _user(db_session)
    db_session.add_all([_leg(user.id, DEMO, 5000 + i, minutes=10 + i) for i in range(25)])
    # 仓位 777：一腿最新，一腿最早
    db_session.add(_leg(user.id, DEMO, 6001, position=777, minutes=100, profit=3.0))
    db_session.add(_leg(user.id, DEMO, 6000, position=777, minutes=0, profit=2.0))
    # 另一个账号恰好也有 777 号仓位：不能被带进来
    db_session.add(_leg(user.id, REAL, 6002, position=777, minutes=1, profit=9.0))
    db_session.commit()

    first = orders_router.list_closed_trades(login=DEMO, user=user, db=db_session)
    assert first["nextCursor"] is not None
    of_777 = [t for t in first["trades"] if t["positionTicket"] == 777]
    assert sorted(t["dealTicket"] for t in of_777) == [6000, 6001]
    assert sum(t["profit"] for t in of_777) == pytest.approx(5.0)
    assert len(first["trades"]) == 11  # 一页 10 条 + 带上的那一腿
    assert first["totalPositions"] == 26

    # 往后翻，那一腿会再出现一次；按 id 去重后总数正好
    _pages, legs = _walk(user, db_session, DEMO)
    assert len(legs) == 27
    assert all(t["mt5Login"] == DEMO for t in legs)


def test_unknown_login_404_and_bad_cursor_400(db_session):
    user = _user(db_session)
    with pytest.raises(HTTPException) as e:
        orders_router.list_closed_trades(login="999", user=user, db=db_session)
    assert e.value.status_code == 404
    for bad in ("not-a-cursor", "2026-11-01T00:00:00", "|abc", "nope|abc"):
        with pytest.raises(HTTPException) as e:
            orders_router.list_closed_trades(login=DEMO, cursor=bad, user=user, db=db_session)
        assert e.value.status_code == 400


def test_other_users_legs_never_leak(db_session):
    user = _user(db_session)
    other = User(id="u-other", email="o@t.local", api_token="tok-o", plan="PRO")
    db_session.add(other)
    db_session.add(MT5Account(user_id="u-other", login=DEMO, server="", source="gateway"))
    db_session.add(_leg("u-other", DEMO, 7000))
    db_session.add(_leg(user.id, DEMO, 7001))
    db_session.commit()
    mine = orders_router.list_closed_trades(login=DEMO, user=user, db=db_session)
    assert [t["dealTicket"] for t in mine["trades"]] == [7001]


def test_per_login_first_page_cached_and_invalidated(db_session):
    user = _user(db_session)
    db_session.add(_leg(user.id, REAL, 8000))
    db_session.commit()
    first = orders_router.list_closed_trades(login=REAL, user=user, db=db_session)
    assert len(first["trades"]) == 1

    db_session.add(_leg(user.id, REAL, 8001, minutes=5))
    db_session.commit()
    assert orders_router.list_closed_trades(login=REAL, user=user, db=db_session) == first, "60 秒内走缓存"

    invalidate_trade_caches(user.id, [REAL])  # 新平仓落库时会调用
    fresh = orders_router.list_closed_trades(login=REAL, user=user, db=db_session)
    assert [t["dealTicket"] for t in fresh["trades"]] == [8001, 8000]
    assert fresh["totalPositions"] == 2
