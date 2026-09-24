"""挂单触发出来的仓位计入游戏化统计（2026-09-24）。

**为什么要测。** 游戏化统计原来只认 (ORDER, FILLED)，限价 / 止损单触发出来的
仓位整仓平掉了也不算交易：只用挂单的用户「小试牛刀」永远 0/5，笔数、手数、
交易日、胜率、首笔实盘全都漏算。而挂单行挂出后就停在 PLACED，看不出有没有
触发过，所以这里钉住两头：

  · 有平仓腿的挂单算一笔交易（笔数、手数、交易日、胜率、小试牛刀、首笔实盘）；
  · 没有平仓腿的挂单（挂了又撤、还没触发）什么都不算，手数和交易日也不算；
  · 挂单挂出成功时打 trade_mode 章，存量没章的由每小时补章补上。

Positions opened by pending orders count in gamification. Pins both ends: a
pending order with closing legs is a trade everywhere; one without (cancelled or
not yet triggered) counts for nothing, lots and trading days included; placed
pending orders get a trade_mode stamp, and old unstamped ones are backfilled.
"""
from datetime import datetime, timedelta, timezone

from app.models import ClosedTrade, MT5Account, Order, User, UserTask
from app.services.gamification import loop as loop_module
from app.services.gamification.badge_judges import _has_real_fill
from app.services.gamification.conditions import judge_and_record_conditions
from app.services.gamification.stamp import is_stampable, stamp_order_trade_mode
from app.services.gamification.stats import (
    compute_account_lifetime_stats, compute_comprehensive_stats, load_trade_data)

NOW = datetime.now(timezone.utc).replace(tzinfo=None)


def _user(db, email="p@t.co"):
    u = User(email=email, api_token="tok_" + email)
    db.add(u); db.commit()
    return u


def _pending(db, u, ticket, trade_mode=2, login="1", volume=0.1, created_at=None):
    """一张挂出成功的挂单，形状与两条通道挂出后落库的一致：票号同时写进
    mt5_ticket 与 mt5_position。/ A placed pending order as both channels store it."""
    o = Order(user_id=u.id, client_order_id=f"pd{ticket}", action="PENDING",
              symbol="X", side="BUY", volume=volume, price=1.0, pending_type="BUY_LIMIT",
              status="PLACED", mt5_login=login, mt5_ticket=ticket, mt5_position=ticket,
              trade_mode=trade_mode, created_at=created_at or NOW - timedelta(days=1))
    db.add(o); db.commit()
    return o


def _close(db, u, ticket, profit=5.0, login="1", volume=0.1, verified=True):
    db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="X", side="BUY",
                       close_volume=volume, close_price=1, profit=profit,
                       position_ticket=ticket, deal_ticket=ticket * 10,
                       closed_at=NOW - timedelta(hours=1), verified=verified))
    db.commit()


def test_triggered_pending_counts_as_trade(db_session):
    u = _user(db_session)
    _pending(db_session, u, 101)
    _close(db_session, u, 101, profit=5.0)
    s = compute_comprehensive_stats(db_session, u.id)
    assert s["trades_any"] == 1 and s["trades"] == 1 and s["wins"] == 1
    assert abs(s["lots"] - 0.1) < 1e-9 and s["trade_days"] == 1
    assert compute_account_lifetime_stats(db_session, u.id)["1"]["trades"] == 1


def test_untriggered_pending_counts_for_nothing(db_session):
    """挂了又撤 / 还没触发：没有平仓腿，手数和交易日也不能算进去。"""
    u = _user(db_session)
    _pending(db_session, u, 201)
    s = compute_comprehensive_stats(db_session, u.id)
    assert (s["trades_any"], s["trades"], s["lots"], s["trade_days"]) == (0, 0, 0, 0)
    assert compute_account_lifetime_stats(db_session, u.id) == {}
    assert load_trade_data(db_session, u.id)["orders"] == []


def test_unverified_leg_does_not_trigger_pending(db_session):
    """只有未核验的腿不算触发的证据——与整仓判定只认 verified 同口径。"""
    u = _user(db_session)
    _pending(db_session, u, 301)
    _close(db_session, u, 301, verified=False)
    s = compute_comprehensive_stats(db_session, u.id)
    assert (s["trades_any"], s["lots"], s["trade_days"]) == (0, 0, 0)


def test_demo_pending_counts_for_first_steps(db_session):
    """五张模拟盘挂单触发并平掉 → 小试牛刀完成（模拟盘也算）。"""
    u = _user(db_session)
    for t in range(401, 406):
        _pending(db_session, u, t, trade_mode=0)
        _close(db_session, u, t)
    s = compute_comprehensive_stats(db_session, u.id)
    assert s["trades_any"] == 5 and s["trades"] == 0      # 模拟盘不进实盘口径
    assert "first_trades_5" in judge_and_record_conditions(db_session, u.id)
    assert db_session.query(UserTask).filter_by(user_id=u.id, task_id="first_trades_5").count() == 1


def test_preloaded_data_matches_self_loading_with_pending(db_session):
    u = _user(db_session)
    _pending(db_session, u, 501)
    _close(db_session, u, 501)
    _pending(db_session, u, 502)                            # 未触发
    db_session.add(Order(user_id=u.id, client_order_id="m1", symbol="X", side="BUY",
                         volume=0.2, status="FILLED", mt5_login="1", mt5_ticket=503,
                         trade_mode=2, created_at=NOW - timedelta(days=2)))
    db_session.commit()
    data = load_trade_data(db_session, u.id)
    assert compute_comprehensive_stats(db_session, u.id, data) == compute_comprehensive_stats(db_session, u.id)
    s = compute_comprehensive_stats(db_session, u.id, data)
    assert abs(s["lots"] - 0.3) < 1e-9                      # 市价 0.2 + 触发的挂单 0.1
    assert s["trade_days"] == 2


def test_first_real_trade_from_triggered_pending(db_session):
    u = _user(db_session)
    _pending(db_session, u, 601)
    assert _has_real_fill(db_session, u.id) is False        # 还没触发
    _close(db_session, u, 601)
    assert _has_real_fill(db_session, u.id) is True
    demo = _user(db_session, "d@t.co")
    _pending(db_session, demo, 602, trade_mode=0)
    _close(db_session, demo, 602)
    assert _has_real_fill(db_session, demo.id) is False     # 模拟盘不是实盘


def test_placed_pending_is_stamped(db_session):
    u = _user(db_session)
    db_session.add(MT5Account(user_id=u.id, login="1", server="s", trade_mode=2))
    db_session.commit()
    placed = Order(user_id=u.id, client_order_id="s1", action="PENDING", symbol="X",
                   side="BUY", volume=0.1, status="PLACED", mt5_login="1")
    failed = Order(user_id=u.id, client_order_id="s2", action="PENDING", symbol="X",
                   side="BUY", volume=0.1, status="FAILED", mt5_login="1")
    stamp_order_trade_mode(db_session, placed)
    stamp_order_trade_mode(db_session, failed)
    assert placed.trade_mode == 2
    assert failed.trade_mode is None                        # 不知道成没成，不打章
    assert is_stampable("FILLED", "ORDER") and is_stampable("PLACED", "PENDING")
    assert not is_stampable("FAILED", "ORDER") and not is_stampable("PENDING", "PENDING")


def test_backfill_stamps_old_placed_pending(db_session):
    u = _user(db_session)
    db_session.add(MT5Account(user_id=u.id, login="1", server="s", trade_mode=2))
    o = _pending(db_session, u, 701, trade_mode=None)
    stamped, _sentinel = loop_module.backfill_order_trade_modes(db_session)
    db_session.refresh(o)
    assert stamped == 1 and o.trade_mode == 2
