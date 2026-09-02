from datetime import datetime, timedelta, timezone
from app.models import User, Order, ClosedTrade, Signal
from app.services.gamification.badges import (
    judge_and_award_badges, _evergreen_months, _consecutive_clean_signal_positions)

NOW = datetime.now(timezone.utc)


def _user(db, email="ab@t.co"):
    u = User(email=email, api_token="tok_" + email); db.add(u); db.commit(); return u


def _pos(db, u, ticket, profit, closed_at, signal_id=None, sl=None, price=None):
    db.add(Order(user_id=u.id, client_order_id=f"p{ticket}", symbol="X", side="BUY",
                 volume=0.1, status="FILLED", mt5_login="1", mt5_ticket=ticket,
                 trade_mode=2, created_at=closed_at - timedelta(hours=1),
                 signal_id=signal_id, sl=sl, filled_price=price))
    db.add(ClosedTrade(user_id=u.id, mt5_login="1", symbol="X", side="BUY",
                       close_volume=0.1, close_price=1, profit=profit,
                       position_ticket=ticket, deal_ticket=ticket * 10,
                       closed_at=closed_at, verified=True))
    db.commit()


def _month(offset):
    y, m = NOW.year, NOW.month
    m -= offset
    while m <= 0:
        m += 12; y -= 1
    return datetime(y, m, 15, tzinfo=timezone.utc)


def test_evergreen_counts_completed_months_only(db_session):
    u = _user(db_session)
    for i in (1, 2, 3):                     # 最近 3 个完整月各一笔盈利
        _pos(db_session, u, 100 + i, 5.0, _month(i))
    _pos(db_session, u, 200, 5.0, _month(0))  # 当前月不算
    assert _evergreen_months(db_session, u.id) == 3
    assert "evergreen_3m" in judge_and_award_badges(db_session, u.id)


def test_evergreen_loss_month_breaks(db_session):
    u = _user(db_session, email="ev2@t.co")
    _pos(db_session, u, 1, 5.0, _month(1))
    _pos(db_session, u, 2, -9.0, _month(2))   # 亏损月断串
    _pos(db_session, u, 3, 5.0, _month(3))
    assert _evergreen_months(db_session, u.id) == 1


def test_profit_factor(db_session):
    u = _user(db_session, email="pf@t.co")
    for i in range(60):                        # 60 胜每笔 +4
        _pos(db_session, u, 300 + i, 4.0, NOW - timedelta(days=5))
    for i in range(40):                        # 40 负每笔 -2 → 平均盈亏比 2.0，总盈亏 +160
        _pos(db_session, u, 400 + i, -2.0, NOW - timedelta(days=5))
    assert "profit_factor_2" in judge_and_award_badges(db_session, u.id)


def test_clean_signal_streak_stops_at_violation(db_session):
    u = _user(db_session, email="sl@t.co")
    sig = Signal(symbol="X", side="BUY")       # 若 Signal 必填字段更多，按模型补齐
    db_session.add(sig); db_session.commit()
    for i in range(3):
        _pos(db_session, u, 500 + i, 1.0, NOW - timedelta(days=3 - i),
             signal_id=sig.id, sl=0.9, price=1.0)
    # 给最早的仓加一条恶意移损 MODIFY（清掉止损）
    db_session.add(Order(user_id=u.id, client_order_id="m1", symbol="X", side="BUY",
                         volume=0.1, status="FILLED", mt5_login="1", action="MODIFY",
                         ticket=500, sl=0, created_at=NOW - timedelta(days=3)))
    db_session.commit()
    assert _consecutive_clean_signal_positions(db_session, u.id) == 2  # 到违规仓即停


def test_missing_sl_violates_when_signal_had_stop(db_session):
    """信号给了止损、订单上却没有——下单时被主动抹掉，判违规，断串（对照 discipline.py D1）。"""
    u = _user(db_session, email="sl4@t.co")
    sig = Signal(symbol="X", side="BUY", stop_loss=0.9)
    db_session.add(sig); db_session.commit()
    # 最近两笔正常（有止损），最早一笔订单上没有止损 → 遇到即停
    for i in (1, 2):
        _pos(db_session, u, 510 + i, 1.0, NOW - timedelta(days=3 - i),
             signal_id=sig.id, sl=0.9, price=1.0)
    _pos(db_session, u, 510, 1.0, NOW - timedelta(days=3),
         signal_id=sig.id, sl=None, price=1.0)
    assert _consecutive_clean_signal_positions(db_session, u.id) == 2


def test_missing_sl_abstains_when_signal_had_no_stop(db_session):
    """信号本身没给止损——订单没止损不是用户的锅，弃权（跳过，不计入也不断串）。"""
    u = _user(db_session, email="sl5@t.co")
    sig = Signal(symbol="X", side="BUY")           # 无 stop_loss
    db_session.add(sig); db_session.commit()
    # 最早一笔（信号无止损、订单也无止损）弃权，其余三笔正常有止损
    _pos(db_session, u, 520, 1.0, NOW - timedelta(days=4),
         signal_id=sig.id, sl=None, price=1.0)
    for i in (1, 2, 3):
        _pos(db_session, u, 520 + i, 1.0, NOW - timedelta(days=4 - i),
             signal_id=sig.id, sl=0.9, price=1.0)
    # 弃权仓被跳过（不计入也不断串），倒序遍历仍能数满其余 3 笔干净仓
    assert _consecutive_clean_signal_positions(db_session, u.id) == 3


def test_modify_matched_by_login_and_ticket_not_ticket_alone(db_session):
    """ticket 只在单账号内唯一——两个账号撞同一个编号时，A 账号的 MODIFY
    不能牵连 B 账号同编号的仓位（对照 discipline.py 的 _user_modify_close_map）。"""
    u = _user(db_session, email="sl6@t.co")
    sig = Signal(symbol="X", side="BUY", stop_loss=0.9)
    db_session.add(sig); db_session.commit()
    # B 账号仓位（最近平仓）——ticket 与 A 账号撞号，但从未被改过止损
    db_session.add(Order(user_id=u.id, client_order_id="pB", symbol="X", side="BUY",
                         volume=0.1, status="FILLED", mt5_login="B", mt5_ticket=700,
                         trade_mode=2, created_at=NOW - timedelta(days=2, hours=1),
                         signal_id=sig.id, sl=0.9, filled_price=1.0))
    db_session.add(ClosedTrade(user_id=u.id, mt5_login="B", symbol="X", side="BUY",
                               close_volume=0.1, close_price=1, profit=1.0,
                               position_ticket=700, deal_ticket=7001,
                               closed_at=NOW - timedelta(days=1), verified=True))
    # A 账号仓位（更早平仓）——同样 ticket=700，会被下面的恶意 MODIFY 命中
    db_session.add(Order(user_id=u.id, client_order_id="pA", symbol="X", side="BUY",
                         volume=0.1, status="FILLED", mt5_login="A", mt5_ticket=700,
                         trade_mode=2, created_at=NOW - timedelta(days=3, hours=1),
                         signal_id=sig.id, sl=0.9, filled_price=1.0))
    db_session.add(ClosedTrade(user_id=u.id, mt5_login="A", symbol="X", side="BUY",
                               close_volume=0.1, close_price=1, profit=1.0,
                               position_ticket=700, deal_ticket=7002,
                               closed_at=NOW - timedelta(days=2), verified=True))
    # 恶意 MODIFY 只打在 A 账号的 700 号仓位上
    db_session.add(Order(user_id=u.id, client_order_id="mA", symbol="X", side="BUY",
                         volume=0.1, status="FILLED", mt5_login="A", action="MODIFY",
                         ticket=700, sl=0, created_at=NOW - timedelta(days=2, hours=12)))
    db_session.commit()
    # 倒序：B（干净，计入）→ A（违规，断串）——B 不该被 A 的改单牵连
    assert _consecutive_clean_signal_positions(db_session, u.id) == 1


def test_missing_entry_price_abstains_without_signal_fallback(db_session):
    """订单没有成交价、信号也没给入场价——无法算距离/容差，弃权（跳过，不计入也不断串）。"""
    u = _user(db_session, email="sl7@t.co")
    sig = Signal(symbol="X", side="BUY", stop_loss=0.9)  # 未设 entry
    db_session.add(sig); db_session.commit()
    _pos(db_session, u, 530, 1.0, NOW - timedelta(days=3),
         signal_id=sig.id, sl=0.9, price=1.0)              # 最早，干净
    _pos(db_session, u, 531, 1.0, NOW - timedelta(days=2),
         signal_id=sig.id, sl=0.9, price=None)              # 中间，缺成交价+信号无入场价 → 弃权
    _pos(db_session, u, 532, 1.0, NOW - timedelta(days=1),
         signal_id=sig.id, sl=0.9, price=1.0)              # 最近，干净
    # 弃权仓被跳过（不计入也不断串），倒序遍历数满其余 2 笔干净仓
    assert _consecutive_clean_signal_positions(db_session, u.id) == 2


def test_profit_factor_excludes_exact_zero_positions(db_session):
    """恰好 0 盈亏的仓位不进胜负任何一边，只占样本量和总盈亏两道闸门——
    否则会拉低亏损仓的平均亏损，把本该够不着 2.0 的盈亏比错误撑过线。"""
    u = _user(db_session, email="pf2@t.co")
    for i in range(60):                        # 60 胜每笔 +3 → 均盈利 3
        _pos(db_session, u, 800 + i, 3.0, NOW - timedelta(days=5))
    for i in range(40):                        # 40 负每笔 -2 → 均亏损 2，盈亏比 1.5，本不该达标
        _pos(db_session, u, 900 + i, -2.0, NOW - timedelta(days=5))
    for i in range(40):                        # 40 笔恰好 0——若被算进「亏损」会把均亏损拉到 1.0，误判达标
        _pos(db_session, u, 1000 + i, 0.0, NOW - timedelta(days=5))
    assert "profit_factor_2" not in judge_and_award_badges(db_session, u.id)


def test_evergreen_dec_to_jan_adjacency(db_session):
    """跨年 12 月→1 月要接得上（_next 用 (y+1, 1)），不是巧合刚好过了年就断串。"""
    u = _user(db_session, email="ev3@t.co")
    _pos(db_session, u, 601, 5.0, datetime(2025, 11, 15, tzinfo=timezone.utc))
    _pos(db_session, u, 602, 5.0, datetime(2025, 12, 15, tzinfo=timezone.utc))
    _pos(db_session, u, 603, 5.0, datetime(2026, 1, 15, tzinfo=timezone.utc))
    assert _evergreen_months(db_session, u.id) == 3
