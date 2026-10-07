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


def test_offline_user_close_refreshes_balance(harness, monkeypatch):
    """离线用户的平仓行由成交事件即时入库，余额也要跟着刷新——否则榜单对账拿新平仓
    对旧余额，把这笔盈亏记成入金 / 出金（2026-10-06 限额比赛掉榜）。
    An offline user's close rows land via the deal event; the balance must be
    refreshed with them, or the board reconcile books the P/L as a cash flow."""
    from types import SimpleNamespace

    drained = {"n": 0}

    async def deal_drain():
        drained["n"] += 1
        return ([int(SLOW_LOGIN)] if drained["n"] == 1 else []), True

    async def only_fast_connected():
        return [FAST_USER]                      # SLOW_USER 离线 / offline

    saved = {"n": 0}

    def upsert(*a, **k):
        saved["n"] += 1
        return "inserted"

    async def account(login, timeout=None):
        # 平仓入库之后才给新余额：离线兜底刷新（开机即跑一趟）读到的还是旧值，
        # 所以这里只有「平仓即刷新」那条路径能把 7000 写进去。
        # New balance only after a close is saved, so only the close-path refresh
        # (not the offline sweep that runs at startup) can write 7000.
        if str(login) != SLOW_LOGIN or not saved["n"]:
            return None
        return SimpleNamespace(balance=7000.0, equity=7000.0, margin=0.0, leverage=100,
                               name="", group="", last_pass_change=0)

    _serialize_sessions(monkeypatch)
    monkeypatch.setattr(gc, "drain_deal_events", deal_drain)
    monkeypatch.setattr(manager, "connected_user_ids_async", only_fast_connected)
    monkeypatch.setattr(gw, "gw_get_account", account)
    async def deals(login, from_unix, to_unix, timeout=None):
        return [SimpleNamespace(login=int(login))], ""

    monkeypatch.setattr(gw, "gw_get_deals", deals)
    monkeypatch.setattr(gw, "observe_server_offset", lambda *a, **k: None)
    monkeypatch.setattr(gw, "build_closed_trade_legs", lambda *a, **k: [{"leg": 1}])
    monkeypatch.setattr(gw, "upsert_leg", upsert)

    _run_loop_for(1.5)

    db = gw.SessionLocal()
    try:
        row = db.query(MT5Account).filter(MT5Account.login == SLOW_LOGIN).one()
        assert row.balance == 7000.0
    finally:
        db.close()


def test_offline_user_balance_swept_without_any_close(harness, monkeypatch):
    """离线用户没有新平仓也要定期刷新余额：错拍发生在部署前、或平仓后那次刷新失败的
    账号，靠这条兜底追平；没有任何人在线时也照跑。
    Offline balances are swept periodically even with no new close and nobody online."""
    from types import SimpleNamespace

    async def nobody_connected():
        return []

    async def account(login, timeout=None):
        return SimpleNamespace(balance=6447.41, equity=6447.41, margin=0.0, leverage=100,
                               name="", group="", last_pass_change=0)

    monkeypatch.setattr(manager, "connected_user_ids_async", nobody_connected)
    monkeypatch.setattr(gw, "gw_get_account", account)
    monkeypatch.setattr(gw, "gw_batch_available", lambda: False)

    _run_loop_for(1.0)

    db = gw.SessionLocal()
    try:
        rows = db.query(MT5Account).all()
        assert {r.balance for r in rows} == {6447.41}
    finally:
        db.close()


# ---------------------------------------------------------------------------
# 同一 MT5 账号绑给多个用户 / 离线期间的平仓（2026-10-07）
# Shared logins and closes that happen while offline.
# ---------------------------------------------------------------------------

SHARED_USER = "u-shared"


def _acc(balance: float):
    from types import SimpleNamespace
    return SimpleNamespace(balance=balance, equity=balance, margin=0.0, leverage=100,
                           name="", group="", last_pass_change=0)


def _serialize_sessions(monkeypatch) -> None:
    """内存 SQLite 的 StaticPool 只有一条连接，多个工作线程并发开会话会互相干扰（一边提交
    另一边读不到行）。会写库的用例把会话串行化：开会话时拿锁、关会话时放。
    The StaticPool shares one connection, so concurrent thread sessions trample each
    other. Tests that write serialize sessions: lock on open, release on close."""
    lock = threading.RLock()
    factory = gw.SessionLocal

    def opener():
        lock.acquire()
        db = factory()
        real_close = db.close

        def close():
            try:
                real_close()
            finally:
                lock.release()

        db.close = close
        return db

    monkeypatch.setattr(gw, "SessionLocal", opener)


def _stub_close_path(monkeypatch, upserts: list, read_balance: bool = False) -> None:
    """成交读回一条、归属判为一条腿，upsert_leg 记下 (user_id, login, 当时库里的余额)。
    只在单线程顺序执行的场景读余额：内存 SQLite 的 StaticPool 是一条连接，多个工作线程
    并发开会话时互相干扰。/ The balance is read only where writes are sequential: the
    StaticPool shares one connection, and concurrent thread sessions interfere."""
    from types import SimpleNamespace

    async def deals(login, from_unix, to_unix, timeout=None):
        return [SimpleNamespace(login=int(login))], ""

    def upsert(db, user_id, login, leg, verified):
        bal = None
        if read_balance:
            row = db.query(MT5Account).filter(
                MT5Account.user_id == user_id, MT5Account.login == login).one()
            bal = row.balance
        upserts.append((user_id, login, bal))
        return "inserted"

    monkeypatch.setattr(gw, "gw_get_deals", deals)
    monkeypatch.setattr(gw, "observe_server_offset", lambda *a, **k: None)
    monkeypatch.setattr(gw, "build_closed_trade_legs", lambda *a, **k: [{"leg": 1}])
    monkeypatch.setattr(gw, "upsert_leg", upsert)


def test_shared_login_scans_and_refreshes_every_bound_user(harness, monkeypatch):
    """同一个 login 绑在两个用户名下：两人的平仓明细与余额都要更新。以前在飞 / 节流 /
    首扫标记只按 login 记，A 扫过 B 就被挡掉，B 的 ClosedTrade 与余额永远不动。
    One login bound to two users: both get close rows and a fresh balance."""
    db = gw.SessionLocal()
    db.add(MT5Account(user_id=SHARED_USER, login=SLOW_LOGIN, server="", source="gateway"))
    db.commit()
    db.close()

    async def connected():
        return [SLOW_USER, FAST_USER, SHARED_USER]

    async def push_positions(user_id, data, source="gateway"):
        return None

    async def account(login, timeout=None):
        return _acc(5000.0)

    upserts: list = []
    _serialize_sessions(monkeypatch)
    _stub_close_path(monkeypatch, upserts)
    monkeypatch.setattr(manager, "connected_user_ids_async", connected)
    monkeypatch.setattr(manager, "push_positions", push_positions)
    monkeypatch.setattr(gw, "gw_get_account", account)
    monkeypatch.setattr(gw, "gw_batch_available", lambda: False)

    _run_loop_for(1.0)

    users = {u for u, lg, _b in upserts if lg == SLOW_LOGIN}
    assert users == {SLOW_USER, SHARED_USER}
    db = gw.SessionLocal()
    try:
        rows = db.query(MT5Account).filter(MT5Account.login == SLOW_LOGIN).all()
        assert {r.user_id: r.balance for r in rows} == {SLOW_USER: 5000.0, SHARED_USER: 5000.0}
    finally:
        db.close()


def test_deal_events_drained_while_nobody_online(harness, monkeypatch):
    """没有任何人在线时成交队列也要拉：离线用户的平仓即时落库，不等有人连上。
    The deal queue is drained even with nobody online."""
    drained = {"n": 0}

    async def nobody():
        return []

    async def deal_drain():
        drained["n"] += 1
        return ([int(SLOW_LOGIN)] if drained["n"] == 1 else []), True

    upserts: list = []
    _serialize_sessions(monkeypatch)
    _stub_close_path(monkeypatch, upserts)
    monkeypatch.setattr(manager, "connected_user_ids_async", nobody)
    monkeypatch.setattr(gc, "drain_deal_events", deal_drain)
    # 离线资金兜底推迟到测试之外，确保落库来自事件。/ keep the sweep out of the way
    monkeypatch.setattr(gw, "GATEWAY_OFFLINE_FUNDS_INTERVAL", 3600.0)

    _run_loop_for(0.8)

    assert drained["n"] >= 2
    assert (SLOW_USER, SLOW_LOGIN) in {(u, lg) for u, lg, _b in upserts}


def test_offline_sweep_scans_closes_before_writing_new_balance(harness, monkeypatch):
    """离线兜底读到余额变了（事件被丢 / 成交订阅不可用）：先把平仓扫进库，再写余额。
    对账永远不会看到「新余额 + 缺平仓」。/ A moved balance in the offline sweep scans
    closes first, so the reconcile never sees the new balance without the close."""

    async def nobody():
        return []

    async def account(login, timeout=None):
        return _acc(7000.0)

    upserts: list = []
    _serialize_sessions(monkeypatch)
    _stub_close_path(monkeypatch, upserts, read_balance=True)
    monkeypatch.setattr(manager, "connected_user_ids_async", nobody)
    monkeypatch.setattr(gw, "gw_get_account", account)
    monkeypatch.setattr(gw, "gw_batch_available", lambda: False)

    _run_loop_for(0.8)

    seen = {(u, lg): b for u, lg, b in upserts}
    # 两个离线账号都扫到了平仓，且扫描时库里的余额还是旧值
    assert set(seen) == {(SLOW_USER, SLOW_LOGIN), (FAST_USER, FAST_LOGIN)}
    assert all(b != 7000.0 for b in seen.values())
    db = gw.SessionLocal()
    try:
        assert {r.balance for r in db.query(MT5Account).all()} == {7000.0}
    finally:
        db.close()


def test_regular_window_covers_gap_since_last_success(harness, monkeypatch):
    """常规扫描窗口从上次成功扫描处接着回看：首扫失败后下一次仍是 7 天补扫（以前首扫
    标记先加，失败就只剩 15 分钟）；成功之后按 max(常规窗口, 距上次成功 + 余量)。
    The window resumes from the last success: a failed first scan is retried with
    the catch-up window, later ones cover max(regular, gap + margin)."""
    windows: list[tuple[int, int]] = []
    calls = {"n": 0}

    async def deals(login, from_unix, to_unix, timeout=None):
        if str(login) != FAST_LOGIN:
            return [], ""
        calls["n"] += 1
        windows.append((int(time.time()), from_unix))
        return ([], "boom") if calls["n"] == 1 else ([], "")

    monkeypatch.setattr(gw, "gw_get_deals", deals)
    monkeypatch.setattr(gw, "GATEWAY_DEALS_SCAN_INTERVAL", 0.05)
    monkeypatch.setattr(gw, "GATEWAY_DEALS_LOOKBACK_SECONDS", 10)
    monkeypatch.setattr(gw, "GATEWAY_DEALS_GAP_MARGIN", 500)
    monkeypatch.setattr(gw, "GATEWAY_WIDE_SCAN_MIN_INTERVAL", 0.0)
    monkeypatch.setattr(gw, "gw_batch_available", lambda: False)

    _run_loop_for(0.8)

    assert len(windows) >= 3
    spans = [now - frm for now, frm in windows]
    week = gw.GATEWAY_DEALS_CATCHUP_SECONDS
    assert spans[0] >= week and spans[1] >= week          # 失败后重试仍是补扫
    assert all(500 <= s < week for s in spans[2:])         # 之后按间隔 + 余量


def test_failing_reads_do_not_hammer_wide_rescans(harness, monkeypatch):
    """读取一直失败（含网关 read_busy 卸载负载）时，宽窗口重扫按
    GATEWAY_WIDE_SCAN_MIN_INTERVAL 限频，不会每拍都打一次 7 天读取。
    With reads failing (read_busy included), wide rescans are throttled instead of
    firing a 7-day read every tick."""
    calls = {"n": 0}

    async def deals(login, from_unix, to_unix, timeout=None):
        if str(login) != FAST_LOGIN:
            return [], ""
        calls["n"] += 1
        return [], "read_busy"

    monkeypatch.setattr(gw, "gw_get_deals", deals)
    monkeypatch.setattr(gw, "GATEWAY_DEALS_SCAN_INTERVAL", 0.05)
    monkeypatch.setattr(gw, "GATEWAY_WIDE_SCAN_MIN_INTERVAL", 60.0)
    monkeypatch.setattr(gw, "gw_batch_available", lambda: False)

    _run_loop_for(0.8)

    # 首扫一次 + 限频窗口内最多一次宽重扫 / the first scan plus at most one wide retry
    assert 1 <= calls["n"] <= 2

