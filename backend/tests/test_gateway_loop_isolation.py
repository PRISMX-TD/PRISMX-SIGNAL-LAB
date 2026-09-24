"""gateway 慢拍里一个用户卡住，不能拖住其他用户。

现象（用户反馈「MT5 连接不稳定」的来源之一）：gateway 账号的持仓、浮盈、余额会
整体冻住十几秒到一两分钟，然后又恢复。原因是慢拍「一轮等所有人做完再睡」：
  · 任何一个用户的某次读取卡住（网关慢、查询连接半开；读取以前默认等 60 秒），
    全体网关用户这一轮都在等它；
  · 自动仓位管理触发下单时，在慢拍的名额里同步等 dealer 回执（最长两分多钟），
    整轮同样停着。
另外，已确认空仓的账号只靠 ADD 事件唤醒，事件丢一条，新仓位就永远不出现。

这里用假的网关与推送把 gateway_positions_loop 真跑起来，钉住三件事：卡住的用户
不影响别人、自动仓管不占慢拍、空仓账号会被定期复查。

One stuck user must not freeze the slow tick for everyone. The loop used to wait
for every user each round, so a single hung read (or an auto-management trade
waiting on the dealer inside a slot) froze positions, P/L and balances for all
gateway users. Flat accounts were only woken by ADD events, so one lost event hid
a new position forever. These tests run the real loop against fakes.
"""
import asyncio
import threading
import time

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
import app.models  # noqa: F401  —— 注册表结构 / registers the tables
from app.models import MT5Account
import app.routers.gateway as gw
import app.services.auto_manage as auto_manage
import app.services.gateway_client as gc
import app.services.trade_performance as trade_performance
from app.services.connection_manager import manager
from app.services.gateway_client import PositionRsp

SLOW_USER, SLOW_LOGIN = "u-slow", "1001"
FAST_USER, FAST_LOGIN = "u-fast", "1002"


def _position(ticket: int) -> PositionRsp:
    return PositionRsp(
        ticket=ticket, symbol="XAUUSD", side="BUY", volume=0.1,
        price_open=4000.0, price_current=4001.0, stop_loss=0.0, take_profit=0.0,
        profit=1.0, comment="PRISMX",
    )


@pytest.fixture()
def harness(monkeypatch):
    """两个在线的 gateway 用户 + 全套假依赖。返回记录推送与读取次数的字典。

    内存 SQLite 要用 StaticPool：循环在工作线程里开会话，默认的连接池会给每个线程
    一个全新的空库。
    StaticPool because the loop opens sessions on worker threads; the default pool
    would hand each thread a brand-new empty in-memory database.
    """
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    db = Session()
    db.add(MT5Account(user_id=SLOW_USER, login=SLOW_LOGIN, server="", source="gateway"))
    db.add(MT5Account(user_id=FAST_USER, login=FAST_LOGIN, server="", source="gateway"))
    db.commit()
    db.close()

    rec = {
        "pushes": {SLOW_USER: 0, FAST_USER: 0},
        "reads": {SLOW_LOGIN: 0, FAST_LOGIN: 0},
    }

    async def fake_connected():
        return [SLOW_USER, FAST_USER]

    async def fake_push_positions(user_id, data, source="gateway"):
        rec["pushes"][user_id] += 1

    async def fake_push_to_client(user_id, message):
        return None

    async def fake_positions(login, timeout=None):
        rec["reads"][str(login)] += 1
        return [_position(int(login))], ""

    async def fake_account(login, timeout=None):
        return None

    async def fake_deals(login, from_unix, to_unix, timeout=None):
        return [], ""

    async def fake_noop(*args, **kwargs):
        return None

    async def fake_drain():
        return [], False

    monkeypatch.setattr(gw, "SessionLocal", Session)
    monkeypatch.setattr(gw, "gw_get_positions", fake_positions)
    monkeypatch.setattr(gw, "gw_get_account", fake_account)
    monkeypatch.setattr(gw, "gw_get_deals", fake_deals)
    monkeypatch.setattr(gw, "push_gateway_pending_orders", fake_noop)
    monkeypatch.setattr(gw, "push_balances_if_changed", fake_noop)
    monkeypatch.setattr(gw, "_needs_deep_backfill", lambda user_id, login: False)
    monkeypatch.setattr(gc, "drain_position_events", fake_drain)
    monkeypatch.setattr(gc, "drain_deal_events", fake_drain)
    monkeypatch.setattr(manager, "connected_user_ids_async", fake_connected)
    monkeypatch.setattr(manager, "push_positions", fake_push_positions)
    monkeypatch.setattr(manager, "push_to_client", fake_push_to_client)
    monkeypatch.setattr(trade_performance, "mark_positions_seen", lambda db, uid, data: None)
    monkeypatch.setattr(auto_manage, "evaluate_positions", lambda db, uid, data: 0)

    # 节奏整体压快，一秒钟里能跑十几拍。/ Speed everything up: a dozen ticks a second.
    monkeypatch.setattr(gw, "GATEWAY_POSITIONS_INTERVAL", 0.05)
    monkeypatch.setattr(gw, "GATEWAY_EVENT_POLL_INTERVAL", 0.05)
    monkeypatch.setattr(gw, "GATEWAY_TICK_WAIT", 0.2)

    rec["fake_positions"] = fake_positions
    yield rec
    engine.dispose()


def _run_loop_for(seconds: float) -> None:
    async def main():
        task = asyncio.create_task(gw.gateway_positions_loop())
        await asyncio.sleep(seconds)
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(main())


def test_one_stuck_user_does_not_freeze_the_others(harness, monkeypatch):
    """慢用户的持仓读取永远不返回；快用户照样每拍刷新。
    旧实现里整轮都在等慢用户，快用户一秒钟里最多推一次。"""
    real = harness["fake_positions"]

    async def positions(login, timeout=None):
        if str(login) == SLOW_LOGIN:
            harness["reads"][SLOW_LOGIN] += 1
            await asyncio.sleep(3600)
        return await real(login, timeout)

    monkeypatch.setattr(gw, "gw_get_positions", positions)

    _run_loop_for(1.2)

    assert harness["pushes"][SLOW_USER] == 0
    assert harness["pushes"][FAST_USER] >= 4
    # 卡住的用户不会被叠第二个任务 / the stuck user is never doubled up
    assert harness["reads"][SLOW_LOGIN] == 1


def test_auto_management_does_not_hold_the_tick(harness, monkeypatch):
    """自动仓管的一次评估要 0.6 秒（相当于在等 dealer），慢拍不能跟着等；同一用户
    同一时刻只能有一份评估在跑。/ A 0.6s auto-management pass must not hold the tick,
    and one user never has two passes at once."""
    running: dict[str, int] = {}
    peak: dict[str, int] = {}
    lock = threading.Lock()

    def slow_evaluate(db, user_id, data):
        with lock:
            running[user_id] = running.get(user_id, 0) + 1
            peak[user_id] = max(peak.get(user_id, 0), running[user_id])
        time.sleep(0.6)
        with lock:
            running[user_id] -= 1
        return 0

    monkeypatch.setattr(auto_manage, "evaluate_positions", slow_evaluate)

    _run_loop_for(1.2)

    # 旧实现每拍都要等 0.6 秒的评估，一秒多只推得出两次。
    assert harness["pushes"][FAST_USER] >= 5
    assert harness["pushes"][SLOW_USER] >= 5
    assert peak == {SLOW_USER: 1, FAST_USER: 1}


def test_flat_account_is_rechecked_even_while_subscribed(harness, monkeypatch):
    """订阅活着时空仓账号被跳过，但要定期复查：ADD 事件丢了也不能永远看不到新仓位。
    Flat accounts are skipped while subscribed, but rechecked periodically."""

    async def subscribed_drain():
        return [], True

    async def empty_positions(login, timeout=None):
        harness["reads"][str(login)] += 1
        return [], ""

    monkeypatch.setattr(gc, "drain_position_events", subscribed_drain)
    monkeypatch.setattr(gw, "gw_get_positions", empty_positions)
    monkeypatch.setattr(gw, "GATEWAY_FLAT_RECHECK_INTERVAL", 0.3)

    _run_loop_for(1.2)

    # 一秒多十几拍：复查间隔 0.3 秒，应当读到三四次——不是一次（旧实现：确认空仓后
    # 再也不读），也不是每拍都读（那就失去了跳过空仓的意义）。
    reads = harness["reads"][FAST_LOGIN]
    assert 2 <= reads <= 8
