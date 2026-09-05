"""每小时游戏化循环的增量判定 + 一次读取多处复用。

**为什么要测。** 原来的 pass 每小时把全体用户逐个判一遍，每人把 365 天订单加载
7 次以上——O(用户数 × 订单数)，用户过百就跑不完。改成：重启后首趟与每天第一趟
全量，其余趟只判上一趟以来"有可能变化"的人；每个人的订单+平仓腿只读一次，综合
统计、终身统计、五枚看整仓的勋章共用。这里钉住：

  · 候选筛选三个来源（新成交单 / 新落库平仓腿 / 活跃过）各自命中，无关的人不进；
  · 首趟全量、同一天第二趟增量、跨天再全量；异常不推进水位；
  · 预读数据与各函数自己查库算出来的结果完全一致（共用数据不能改口径）。

Incremental hourly pass + load-once. Pins the three candidate sources, the
full/incremental schedule (first pass full, same-day passes incremental, new UTC
day full again, watermark not advanced on failure), and that judging from
preloaded data yields exactly what each function computes on its own.
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
import app.models  # noqa: F401
from app.models import ClosedTrade, Order, User, UserBadge, UserTask
import app.services.gamification.boards as boards_module
import app.services.gamification.competitions as competitions_module
from app.services.gamification import loop as loop_module
from app.services.gamification.badges import (
    _consecutive_clean_signal_positions, _evergreen_months, judge_and_award_badges)
from app.services.gamification.conditions import judge_and_record_conditions
from app.services.gamification.stats import (
    compute_account_lifetime_stats, compute_comprehensive_stats, load_trade_data)

NOW = datetime.now(timezone.utc)


def _user(db, email, last_active=None):
    u = User(email=email, api_token="tok_" + email, last_active_at=last_active)
    db.add(u); db.commit()
    return u


def _pos(db, u, ticket, profit, closed_at, created_at=None, leg_created_at=None,
         trade_mode=2, login="1"):
    db.add(Order(user_id=u.id, client_order_id=f"p{ticket}", symbol="X", side="BUY",
                 volume=0.1, status="FILLED", mt5_login=login, mt5_ticket=ticket,
                 trade_mode=trade_mode,
                 created_at=(created_at or closed_at - timedelta(hours=1)).replace(tzinfo=None)))
    db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="X", side="BUY",
                       close_volume=0.1, close_price=1, profit=profit,
                       position_ticket=ticket, deal_ticket=ticket * 10,
                       closed_at=closed_at.replace(tzinfo=None), verified=True,
                       created_at=(leg_created_at or closed_at).replace(tzinfo=None)))
    db.commit()


# ---- 候选筛选 / candidate selection ----------------------------------------------

def test_candidates_each_source_and_nobody_else(db_session):
    since = NOW - timedelta(hours=1)
    old = NOW - timedelta(days=3)
    quiet = _user(db_session, "quiet@t.co", last_active=old)
    active = _user(db_session, "active@t.co", last_active=NOW - timedelta(minutes=5))
    trader = _user(db_session, "trader@t.co", last_active=old)
    _pos(db_session, trader, 1, 5.0, old, created_at=NOW - timedelta(minutes=30),
         leg_created_at=old)                                    # 新成交单，腿是旧的
    backfilled = _user(db_session, "backfill@t.co", last_active=old)
    _pos(db_session, backfilled, 2, 5.0, old, created_at=old,
         leg_created_at=NOW - timedelta(minutes=2))             # 老平仓刚回补入库
    _pos(db_session, quiet, 3, 5.0, old, created_at=old, leg_created_at=old)  # 全是旧的

    got = loop_module.select_candidate_users(db_session, since)
    assert set(got) == {active.id, trader.id, backfilled.id}
    assert quiet.id not in got
    # since=None → 全体 / everyone
    assert set(loop_module.select_candidate_users(db_session, None)) == {
        quiet.id, active.id, trader.id, backfilled.id}


def test_candidates_pending_orders_do_not_count(db_session):
    """只有 FILLED 才是成交；PENDING/REJECTED 不改变任何统计，不该触发判定。"""
    u = _user(db_session, "pend@t.co", last_active=NOW - timedelta(days=2))
    db_session.add(Order(user_id=u.id, client_order_id="x", symbol="X", side="BUY",
                         volume=0.1, status="PENDING", mt5_login="1",
                         created_at=NOW.replace(tzinfo=None)))
    db_session.commit()
    assert loop_module.select_candidate_users(db_session, NOW - timedelta(hours=1)) == []


# ---- 全量/增量调度 / schedule ------------------------------------------------------

@pytest.fixture()
def loop_db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(loop_module, "SessionLocal", Session)
    monkeypatch.setattr(loop_module, "_last_pass_started_at", None)
    monkeypatch.setattr(loop_module, "_last_full_pass_day", None)
    monkeypatch.setattr(boards_module, "snapshot_boards", lambda db, now: {"periods": 0, "rows": 0})
    monkeypatch.setattr(competitions_module, "snapshot_competitions",
                        lambda db, now: {"comps": 0, "rows": 0})
    yield Session
    engine.dispose()


def test_first_pass_full_then_incremental_then_full_next_day(monkeypatch, loop_db):
    db = loop_db()
    old = NOW - timedelta(days=3)
    idle = _user(db, "idle@t.co", last_active=old).id
    fresh = _user(db, "fresh@t.co", last_active=NOW).id
    db.close()

    judged: list[str] = []
    monkeypatch.setattr(loop_module, "judge_and_record_conditions",
                        lambda db, uid, *a: judged.append(uid) or [])
    monkeypatch.setattr(loop_module, "judge_and_award_badges", lambda db, uid, *a: [])

    r1 = loop_module.run_gamification_pass()
    assert r1["full"] is True and r1["users"] == 2
    assert set(judged) == {idle, fresh}

    judged.clear()
    r2 = loop_module.run_gamification_pass()
    assert r2["full"] is False and r2["users"] == 1
    assert judged == [fresh]                       # idle 三天没动，跳过

    # 假装日期翻页：上次全量是"昨天" → 再全量
    monkeypatch.setattr(loop_module, "_last_full_pass_day",
                        (NOW - timedelta(days=1)).date())
    judged.clear()
    r3 = loop_module.run_gamification_pass()
    assert r3["full"] is True and set(judged) == {idle, fresh}

    # 强制参数优先于自动判断 / explicit flag wins
    judged.clear()
    assert loop_module.run_gamification_pass(full=False)["full"] is False
    assert loop_module.run_gamification_pass(full=True)["users"] == 2


def test_failed_pass_does_not_advance_watermark(monkeypatch, loop_db):
    db = loop_db(); _user(db, "a@t.co", last_active=NOW); db.close()
    monkeypatch.setattr(loop_module, "judge_and_record_conditions", lambda db, uid, *a: [])
    monkeypatch.setattr(loop_module, "judge_and_award_badges", lambda db, uid, *a: [])
    loop_module.run_gamification_pass()
    mark = loop_module._last_pass_started_at
    assert mark is not None

    def _boom(db):
        raise RuntimeError("backfill exploded")
    monkeypatch.setattr(loop_module, "backfill_account_trade_modes", _boom)
    with pytest.raises(RuntimeError):
        loop_module.run_gamification_pass()
    assert loop_module._last_pass_started_at == mark   # 没推进，下一趟从同一点重判


# ---- 预读数据与自查一致 / preloaded data matches self-loading ----------------------

def _month(offset):
    y, m = NOW.year, NOW.month
    m -= offset
    while m <= 0:
        m += 12; y -= 1
    return datetime(y, m, 15, tzinfo=timezone.utc)


def test_preloaded_data_gives_identical_results(db_session):
    u = _user(db_session, "same@t.co")
    for i in (1, 2, 3, 4):                                  # 四个完整月盈利
        _pos(db_session, u, 100 + i, 5.0, _month(i))
    _pos(db_session, u, 200, -3.0, NOW - timedelta(days=2))
    _pos(db_session, u, 201, 2.0, NOW - timedelta(days=400))   # 窗口外，终身口径才算
    _pos(db_session, u, 202, 9.0, NOW - timedelta(days=1), trade_mode=0)  # 模拟盘

    data = load_trade_data(db_session, u.id)
    assert compute_comprehensive_stats(db_session, u.id, data) == compute_comprehensive_stats(db_session, u.id)
    assert compute_account_lifetime_stats(db_session, u.id, data) == compute_account_lifetime_stats(db_session, u.id)
    assert _evergreen_months(db_session, u.id, data) == _evergreen_months(db_session, u.id) == 4
    assert _consecutive_clean_signal_positions(db_session, u.id, data) == \
        _consecutive_clean_signal_positions(db_session, u.id)
    # 窗口外的那笔只进终身口径 / the 400-day-old close counts lifetime-only
    assert compute_comprehensive_stats(db_session, u.id, data)["trades"] == 5
    assert compute_account_lifetime_stats(db_session, u.id, data)["1"]["trades"] == 6


def test_loop_path_awards_same_as_direct_calls(db_session):
    """走循环那条"读一次传下去"的路径，与直接调两个判定函数得到同一批记录。"""
    u = _user(db_session, "path@t.co")
    for i in (1, 2, 3):
        _pos(db_session, u, 300 + i, 5.0, _month(i))
    for i in range(5):
        _pos(db_session, u, 400 + i, 1.0, NOW - timedelta(days=1))

    data = load_trade_data(db_session, u.id)
    stats = compute_comprehensive_stats(db_session, u.id, data)
    got_c = judge_and_record_conditions(db_session, u.id, stats)
    got_b = judge_and_award_badges(db_session, u.id, data)
    assert "first_trades_5" in got_c
    assert {"first_close", "first_real_trade", "evergreen_3m"} <= set(got_b)
    # 第二次（自查路径）什么都不新增：结果一致且幂等
    assert judge_and_record_conditions(db_session, u.id) == []
    assert judge_and_award_badges(db_session, u.id) == []
    assert db_session.query(UserTask).filter_by(user_id=u.id).count() == len(got_c)
    assert db_session.query(UserBadge).filter_by(user_id=u.id).count() == len(got_b)
