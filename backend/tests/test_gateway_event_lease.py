"""网关事件队列的单一消费者（2026-09-20 技术债清理）。

`GET /position-events` 与 `GET /deal-events` 是**破坏性读取**：gateway 那端一次调用
就清空内存队列，同一个事件不会返回第二次。所以整个后端集群同一时刻只能有一个消费者，
否则两个 worker 会把事件流随机瓜分——A 拿到开仓、B 拿到平仓，双方各自的在线用户都少
收一半推送，而且谁也不会报错。

`services/background.py` 的 `lock:background-loops` 已经让这条循环只在 leader 上跑，
但那是所有后台循环共用的一把粗锁，换主时有一段最长 POLL_SECONDS 的重叠窗口。这里用
一把只管这两个队列的细锁（`EventQueueLease`）把「单一消费者」写成这段代码自己的
不变式。本文件钉住这把锁的全部行为。

Single-consumer guarantee for the gateway's destructive event queues.
"""
import asyncio

import pytest

from app.core.config import settings
from app.routers.gateway import (
    GATEWAY_EVENTS_LOCK,
    GATEWAY_EVENTS_LOCK_RENEW,
    GATEWAY_EVENTS_LOCK_TTL,
    EventQueueLease,
)
from app.services import shared_state
from tests.fake_redis import FakeRedis


@pytest.fixture()
def redis_on(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "redis://fake")
    fake = FakeRedis()
    shared_state.reset_for_tests(fake)
    yield fake
    shared_state.reset_for_tests()


@pytest.fixture()
def redis_off(monkeypatch):
    monkeypatch.setattr(settings, "REDIS_URL", "")
    shared_state.reset_for_tests()
    yield
    shared_state.reset_for_tests()


def test_single_worker_always_holds_the_lease(redis_off):
    """没配 REDIS_URL 的部署本来就必须是单 worker：租约是 no-op，不做任何 Redis 往返。
    Without Redis the deployment is single-worker by definition; the lease is a no-op."""
    lease = EventQueueLease()
    assert asyncio.run(lease.acquire()) is True
    assert lease.held is True
    # release 也不该炸 / releasing is safe too
    asyncio.run(lease.release())
    assert lease.held is False


def test_only_one_of_two_workers_may_drain(redis_on):
    """两个 worker 抢同一把锁：只有一个拿到消费权，另一个必须空手而归。

    这是整条改动的核心断言——它直接对应「两个 worker 同时 drain 会瓜分事件」那个 bug。
    """
    a = EventQueueLease(owner="worker-a")
    b = EventQueueLease(owner="worker-b")

    async def scenario():
        return await a.acquire(), await b.acquire()

    got_a, got_b = asyncio.run(scenario())
    assert (got_a, got_b) == (True, False)
    assert redis_on.get("prismx:lock:" + GATEWAY_EVENTS_LOCK) == "worker-a"


def test_lease_is_cached_between_renewals_not_re_acquired_each_tick(redis_on, monkeypatch):
    """事件泵 0.25 秒一拍，不能每拍都往 Redis 打一次锁。

    续期周期内直接沿用上次结论，一次 Redis 往返都不多打；跨过续期周期才重新确认。
    The pump ticks every 250ms; leadership is only re-checked once per renew period.
    """
    calls = []
    real_try_lock = shared_state.try_lock

    def counting_try_lock(name, ttl, owner=shared_state.WORKER_ID):
        calls.append(name)
        return real_try_lock(name, ttl, owner)

    monkeypatch.setattr(shared_state, "try_lock", counting_try_lock)
    lease = EventQueueLease(owner="w")

    async def scenario():
        t = 1000.0
        assert await lease.acquire(now=t) is True
        # 续期周期内的多拍：全部沿用，不再打 Redis
        for i in range(1, 10):
            assert await lease.acquire(now=t + i * 0.25) is True
        assert len(calls) == 1
        # 跨过续期周期：重新确认一次
        assert await lease.acquire(now=t + GATEWAY_EVENTS_LOCK_RENEW + 0.1) is True
        assert len(calls) == 2

    asyncio.run(scenario())


def test_lease_ttl_outlives_the_renew_period():
    """TTL 必须明显大于续期周期，否则缓存结论期间锁会过期，两个 worker 同时以为自己是主。
    The TTL must outlive the renew period or the cached verdict could outlive the lock."""
    assert GATEWAY_EVENTS_LOCK_TTL > GATEWAY_EVENTS_LOCK_RENEW * 2


def test_lease_is_handed_over_after_release(redis_on):
    """持有者交还后，等待中的 worker 下一次确认就能接手——不必等满 TTL。
    After a release the standby takes over on its next check, without waiting out the TTL."""
    a = EventQueueLease(owner="worker-a")
    b = EventQueueLease(owner="worker-b")

    async def scenario():
        assert await a.acquire(now=0.0) is True
        assert await b.acquire(now=0.0) is False
        await a.release()
        assert a.held is False
        # b 的上次确认在 now=0，要跨过续期周期才会重新问 / b re-checks after a renew period
        assert await b.acquire(now=GATEWAY_EVENTS_LOCK_RENEW + 1) is True

    asyncio.run(scenario())


def test_redis_failure_keeps_the_last_verdict_and_never_raises(redis_on, monkeypatch):
    """Redis 抖动时沿用上一轮的结论，等下一轮再定——与 background.py 的领导锁同一策略。

    关键是**不抛异常**：一次网络抖动不该把事件泵整条打掉。正在跑的先别停（持有者
    继续消费，它本来就是唯一消费者），没在跑的也别贸然开始（避免抖动期间冒出第二个
    消费者）。
    A Redis wobble keeps the previous verdict and must never raise.
    """
    def boom(*_a, **_k):
        raise RuntimeError("redis down")

    holder = EventQueueLease(owner="holder")
    standby = EventQueueLease(owner="standby")

    async def scenario():
        assert await holder.acquire(now=0.0) is True
        assert await standby.acquire(now=0.0) is False
        monkeypatch.setattr(shared_state, "try_lock", boom)
        t = GATEWAY_EVENTS_LOCK_RENEW + 1
        assert await holder.acquire(now=t) is True      # 持有者继续 / holder keeps going
        assert await standby.acquire(now=t) is False    # 待命者不趁乱上位 / standby stays put

    asyncio.run(scenario())


def test_losing_the_lease_stops_this_worker(redis_on):
    """锁被别人拿走（本进程卡顿超过 TTL 后换主）时，本 worker 必须停止拉取。

    这正是 background.py 那把粗锁留下的重叠窗口：旧 leader 要到自己下一轮 poll 才
    知道自己已经不是 leader。细锁让事件队列这一路在下一次确认时就收手。
    """
    a = EventQueueLease(owner="worker-a")

    async def scenario():
        assert await a.acquire(now=0.0) is True
        # 模拟换主：锁被 worker-b 顶掉
        shared_state.release_lock(GATEWAY_EVENTS_LOCK, owner="worker-a")
        assert shared_state.try_lock(GATEWAY_EVENTS_LOCK, GATEWAY_EVENTS_LOCK_TTL, owner="worker-b")
        assert await a.acquire(now=GATEWAY_EVENTS_LOCK_RENEW + 1) is False
        assert a.held is False

    asyncio.run(scenario())


def test_release_without_the_lease_is_a_noop(redis_on):
    """没持有过就 release：不能去删别人的锁。/ Releasing without holding must not touch another's lock."""
    a = EventQueueLease(owner="worker-a")
    b = EventQueueLease(owner="worker-b")

    async def scenario():
        assert await a.acquire(now=0.0) is True
        assert await b.acquire(now=0.0) is False
        await b.release()

    asyncio.run(scenario())
    assert redis_on.get("prismx:lock:" + GATEWAY_EVENTS_LOCK) == "worker-a"


def test_lease_is_released_even_when_the_pump_is_cancelled(redis_on):
    """取消（关服 / BackgroundLoops 换主）时也要真的把锁还掉。

    这条路径几乎总是在取消里走到：任务一旦进入取消状态，`asyncio.to_thread` 那一跳
    就走不完，await 会立刻再抛 CancelledError。不就地补一次同步释放的话，锁会挂满
    TTL——那段时间没有任何 worker 在消费事件队列，开平仓退回慢拍的 2 秒延迟。
    The release must survive cancellation, or the lock idles for a full TTL with
    nobody draining the queues.
    """
    lease = EventQueueLease(owner="worker-a")

    async def scenario():
        await lease.acquire(now=0.0)

        async def body():
            try:
                await asyncio.sleep(3600)
            finally:
                await lease.release()

        task = asyncio.create_task(body())
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(scenario())
    assert lease.held is False
    assert redis_on.get("prismx:lock:" + GATEWAY_EVENTS_LOCK) is None
