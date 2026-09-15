"""桥接长轮询（桥接 v1.4）的两个约定。

1. 只上报状态的 poll（fetchCommands=False）不领指令、不把指令标成已下发——指令留给
   带长轮询的那条循环，否则就落回"先读完整轮终端再执行"的慢路径。
2. bridge_wake：arm → 等；notify 立刻叫醒；没人 notify 就超时；arm 之前的旧唤醒会被清掉。

The two contracts behind the bridge's long poll: a status-only poll leaves commands
undelivered, and the wake primitive returns early on notify / times out otherwise.
"""
import asyncio
import time

from app.models import MT5Account, Order, User
from app.routers import bridge as bridge_router
from app.routers.bridge import BridgeAccount, BridgePollRequest, _poll_db_work
from app.services import bridge_wake

LOGIN = "80412337"


def _user(db) -> User:
    user = User(id=f"u-{LOGIN}", email=f"{LOGIN}@t.local", api_token=f"tok-{LOGIN}", plan="PRO")
    db.add(user)
    db.add(MT5Account(user_id=user.id, login=LOGIN, server=None, source="bridge"))
    db.commit()
    return user


def _pending(db, user: User, coid: str) -> None:
    db.add(Order(
        user_id=user.id, client_order_id=coid, action="ORDER", symbol="XAUUSD",
        side="BUY", volume=0.01, mt5_login=LOGIN, status="PENDING",
    ))
    db.commit()


def test_status_only_poll_leaves_commands_for_the_command_loop(db_session, monkeypatch):
    # 合作券商锁与本测试无关：关掉，免得账号因服务器名不匹配被拒、根本进不到指令这一步。
    # The partner-broker lock is irrelevant here; disable it so the account is accepted.
    monkeypatch.setattr(
        bridge_router, "get_broker_settings",
        lambda db: {"broker_lock_enabled": False, "broker_patterns": []},
    )
    user = _user(db_session)
    _pending(db_session, user, "c-1")
    accounts = [BridgeAccount(login=LOGIN)]

    commands, voided, online, _balances, rejected, broker_rejected = _poll_db_work(
        db_session, user, BridgePollRequest(accounts=accounts, fetchCommands=False)
    )
    assert commands == [] and voided == []
    assert LOGIN in online, f"状态上报照常刷心跳，账号必须仍算在线 rejected={rejected} broker={broker_rejected}"
    row = db_session.query(Order).filter_by(client_order_id="c-1").one()
    assert not row.delivered, "只上报状态的那一拍不能把指令标成已下发"

    commands, *_ = _poll_db_work(db_session, user, BridgePollRequest(accounts=accounts))
    assert [c["clientOrderId"] for c in commands] == ["c-1"]
    db_session.refresh(row)
    assert row.delivered


def test_wait_returns_as_soon_as_notified():
    async def go():
        loop = asyncio.get_running_loop()
        bridge_wake.bind_loop(loop)
        bridge_wake.arm("u-wake")
        loop.call_later(0.05, bridge_wake.notify, "u-wake")
        t0 = time.monotonic()
        woke = await bridge_wake.wait("u-wake", 3.0)
        return woke, time.monotonic() - t0

    woke, elapsed = asyncio.run(go())
    assert woke is True
    assert elapsed < 1.0, f"应在 notify 后立刻返回，实际等了 {elapsed:.2f}s"


def test_wait_times_out_without_notify():
    async def go():
        bridge_wake.bind_loop(asyncio.get_running_loop())
        bridge_wake.arm("u-quiet")
        return await bridge_wake.wait("u-quiet", 0.05)

    assert asyncio.run(go()) is False


def test_arm_discards_wakes_from_before_this_poll():
    async def go():
        bridge_wake.bind_loop(asyncio.get_running_loop())
        bridge_wake.arm("u-stale")
        bridge_wake.notify("u-stale")   # 上一轮遗留的唤醒
        await asyncio.sleep(0)          # 让 call_soon_threadsafe 落地
        bridge_wake.arm("u-stale")      # 新一轮开始：清掉
        return await bridge_wake.wait("u-stale", 0.05)

    assert asyncio.run(go()) is False


def test_notify_for_unknown_user_is_a_noop():
    # 旧版桥接从不长轮询：字典里没有它，notify 不该建事件、不该抛。
    bridge_wake.notify("nobody-waits")
    assert "nobody-waits" not in bridge_wake._events
