"""后台循环的「谁来跑」：多 worker 时只有一个 worker 跑全部循环，其余待命接管。

**为什么**：main.py 里十来条 asyncio 循环（离线检测、超时订单、信号过期、纪律快照、
游戏化判定、比赛榜、K 线清理、网关持仓轮询……）原来每个进程启动都跑一份。单 worker
没问题；开 N 个 worker 就跑 N 遍——判定重复写、网关被轮询 N 倍、快照互相覆盖。

**做法**：配了 REDIS_URL 时，每个 worker 启动一个 supervisor 协程，每 15 秒去抢
`lock:background-loops`（60 秒过期，持有者续期）。抢到的启动全部循环并持续续期；
没抢到的什么都不做，继续每 15 秒试一次。持有者进程死了，锁最多 60 秒过期，另一个
worker 接管——循环本身都是"扫一遍、幂等"的设计，重跑一趟没有副作用。
没配 REDIS_URL（单 worker）时直接起循环，与从前一模一样。

Leader election for the background loops. With REDIS_URL, each worker runs a
supervisor that tries a 60-second expiring lock every 15 seconds; the holder runs
every loop and keeps renewing, the others stand by and take over within 60
seconds if the holder dies. Every loop is an idempotent sweep, so a takeover
re-running a pass is harmless. Without REDIS_URL the loops start directly, as
before.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable

from app.services import loop_health, shared_state

logger = logging.getLogger("prismx.background")

LOCK_NAME = "background-loops"
LOCK_TTL_SECONDS = 60
POLL_SECONDS = 15
# 关停时等被取消的循环跑完 finally 的上限（见 aclose）。要盖过网关循环等事件泵
# 交还租约的 GATEWAY_PUMP_STOP_WAIT（3 秒），又不能让一条卡死的循环拖住关停。
# Upper bound on waiting for cancelled loops to finish their finally blocks on
# shutdown; must cover gateway's GATEWAY_PUMP_STOP_WAIT (3s).
STOP_WAIT_SECONDS = 5.0

LoopFactory = Callable[[], Awaitable[None]]

# 管理后台「重新启动这个任务」：请求可能落在任何一个 worker 上，而循环只在领导 worker
# 上跑，所以请求只往 shared_state 里登记一个名字，由各 worker 的 control 协程每
# CONTROL_POLL_SECONDS 秒看一眼，**只有领导**去执行。登记 5 分钟过期：换主期间没人
# 处理的请求不会在很久以后突然生效。
# Admin "restart this loop": any worker may get the request but only the leader
# runs loops, so the request is registered in shared_state and the leader's
# control coroutine picks it up. Registrations expire after 5 minutes.
RESTART_REQUEST_KEY = "loopctl:restart"
RESTART_REQUEST_TTL = 300
CONTROL_POLL_SECONDS = 5


def request_restart(name: str) -> None:
    """登记一次重启请求（同步，可能是一次 Redis 往返）。/ Register a restart request (blocking)."""
    shared_state.set_add(RESTART_REQUEST_KEY, name, RESTART_REQUEST_TTL)


def _note_exit(name: str, task: asyncio.Task) -> None:
    """循环任务结束时的回调：被取消（换主、关停）是正常的；其余都是不该发生的退出——
    循环都是 while True，自己返回或抛到顶都意味着它从此不再干活，直到下次重启。
    Done-callback: cancellation is normal; any other exit means the loop is gone
    until the next restart, so record it for the status page."""
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.error("后台循环 %s 崩溃退出 / loop crashed: %r", name, exc)
        loop_health.record_crash(name, "%s: %s" % (type(exc).__name__, exc))
    else:
        logger.error("后台循环 %s 意外返回 / loop returned unexpectedly", name)
        loop_health.record_crash(name, "循环意外结束（没有异常）")


class BackgroundLoops:
    """一组循环的启停 + 领导权监督。/ Start/stop a set of loops under leadership."""

    def __init__(self, factories: dict[str, LoopFactory], owner: str | None = None) -> None:
        self._factories = factories
        self._tasks: dict[str, asyncio.Task] = {}
        self._supervisor: asyncio.Task | None = None
        # 已取消、finally 可能还没跑完的任务；aclose 会等它们。
        # Cancelled tasks whose finally may still be running; aclose waits on them.
        self._stopping: set[asyncio.Task] = set()
        # 锁的持有者标识：默认本进程；测试里用不同的值模拟多个 worker。
        # Lock owner: this process by default; tests pass distinct values to simulate workers.
        self._owner = owner or shared_state.WORKER_ID
        self.is_leader = False
        self._control: asyncio.Task | None = None

    # ---- 直接起 / plain start（单 worker）----
    def _start(self, name: str) -> None:
        # 在事件循环上调用：clear_crash 配 Redis 时发出即忘，不在这里等那次往返
        # （见 loop_health._write）。/ Fire-and-forget on the loop with Redis.
        loop_health.clear_crash(name)
        task = asyncio.create_task(self._factories[name](), name=f"{loop_health.TASK_PREFIX}{name}")
        task.add_done_callback(lambda t, n=name: _note_exit(n, t))
        self._tasks[name] = task

    def start_all(self) -> None:
        for name in self._factories:
            if name not in self._tasks:
                self._start(name)
        self.is_leader = True

    def restart(self, name: str) -> bool:
        """取消并重新创建一条循环（领导 worker 上调用）。不是本 worker 在跑的返回 False。
        Cancel and recreate one loop; False when this worker isn't running loops."""
        if not self.is_leader or name not in self._factories:
            return False
        old = self._tasks.pop(name, None)
        if old is not None and not old.done():
            old.cancel()
            self._stopping.add(old)
        logger.warning("管理后台请求重启后台循环 %s / restarting loop on admin request", name)
        self._start(name)
        return True

    async def _apply_restart_requests(self) -> None:
        from app.services.connection_manager import run_blocking

        names = await run_blocking(shared_state.set_members, RESTART_REQUEST_KEY)
        for name in names:
            if self.restart(name):
                await run_blocking(shared_state.set_remove, RESTART_REQUEST_KEY, name)
            elif name not in self._factories:
                # 不认识的名字（换过版本、手误）直接丢掉，别让它一直挂着。
                await run_blocking(shared_state.set_remove, RESTART_REQUEST_KEY, name)

    async def control(self) -> None:
        """各 worker 一条：领导者处理「重启某条循环」的请求。/ Leader handles restart requests."""
        while True:
            await asyncio.sleep(CONTROL_POLL_SECONDS)
            if not self.is_leader:
                continue
            try:
                await self._apply_restart_requests()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.warning("处理循环重启请求失败 / restart-request pass failed", exc_info=True)

    @property
    def names(self) -> list[str]:
        """登记过的全部循环名（不论本 worker 是否在跑）。/ Every registered loop name."""
        return sorted(self._factories)

    def cancel_all(self) -> None:
        # 换主时也会走到这里；早已退出的任务不必留着等。/ drop tasks that already finished
        self._stopping = {t for t in self._stopping if not t.done()}
        for task in self._tasks.values():
            task.cancel()
            self._stopping.add(task)
        self._tasks.clear()
        self.is_leader = False

    # ---- 监督 / supervise（多 worker）----
    def _acquire(self) -> bool:
        """抢 / 续一次领导锁（**同步 Redis 往返**，协程里经 poll_async 走线程池）。
        One acquire/renew of the leader lock (a blocking Redis round-trip)."""
        try:
            return shared_state.try_lock(LOCK_NAME, LOCK_TTL_SECONDS, owner=self._owner)
        except Exception as e:  # Redis 抖动：已在跑的先别停，等下一轮再定 / keep running until the next round decides
            logger.warning("后台循环领导锁不可用，本轮跳过 / leader lock unavailable: %s", e)
            return self.is_leader

    def _apply(self, held: bool) -> bool:
        """按抢锁结果启停循环。create_task 必须在事件循环线程上调，所以这一半不进线程。
        Start or stop the loops per the verdict; must run on the loop thread (create_task)."""
        if held and not self.is_leader:
            logger.info("本 worker 接管后台循环 / this worker now runs the background loops (%s)", self._owner)
            self.start_all()
        elif not held and self.is_leader:
            logger.warning("后台循环领导权丢失，停止本 worker 的循环 / leadership lost, stopping loops (%s)", self._owner)
            self.cancel_all()
        return held

    def poll(self) -> bool:
        """抢一次锁并据此启停循环；返回本轮是否持有领导权（同步版，测试与脚本用）。
        One election round: acquire/renew the lock and start or stop accordingly."""
        return self._apply(self._acquire())

    async def poll_async(self) -> bool:
        """同 poll，但抢锁那次同步 Redis 往返放进线程池——监督协程每 15 秒跑一次，
        Redis 一慢就会在事件循环上卡满 socket 超时（2 秒）。启停仍在事件循环上做。
        Same as poll with the blocking lock call on a worker thread; the supervisor
        runs every 15s and would otherwise stall the loop for a socket timeout."""
        from app.services.connection_manager import run_blocking

        return self._apply(await run_blocking(self._acquire))

    async def supervise(self) -> None:
        while True:
            await self.poll_async()
            await asyncio.sleep(POLL_SECONDS)

    def launch(self) -> None:
        """入口：单 worker 直接起循环；多 worker 起监督协程（首轮立刻抢一次，不等 15 秒）。
        Entry point: start loops directly without Redis, else start the supervisor
        (first election round runs immediately)."""
        if shared_state.enabled():
            self._supervisor = asyncio.create_task(self.supervise(), name="loop:supervisor")
        else:
            self.start_all()
        self._control = asyncio.create_task(self.control(), name="loop-control")

    def shutdown(self) -> None:
        if self._supervisor is not None:
            self._supervisor.cancel()
            self._supervisor = None
        if self._control is not None:
            self._control.cancel()
            self._control = None
        if self.is_leader:
            try:
                shared_state.release_lock(LOCK_NAME, owner=self._owner)
            except Exception:
                # 释放失败不阻断关停（锁有 TTL 兜底，最坏是别的 worker 晚 15 秒接手），
                # 但必须留痕：以前这里是裸 pass，多 worker 下选主链路出问题时连一条
                # 日志都没有，事后完全无从排查。
                # Never block shutdown on this (the lock's TTL guarantees another
                # worker takes over within 15s at worst), but do leave a trace: this
                # used to be a bare pass, so a faulty leader-lock path on a
                # multi-worker deployment left nothing to investigate afterwards.
                logger.warning("leader lock release failed for %s", LOCK_NAME, exc_info=True)
        self.cancel_all()

    async def aclose(self, timeout: float = STOP_WAIT_SECONDS) -> None:
        """关停并**等**被取消的循环把 finally 跑完（有上限）。lifespan 关闭必须用这个。

        只 cancel 不等是不够的：uvicorn 在 lifespan 关闭一返回就把捕获的 SIGTERM 以
        默认处理器重新 raise，进程立即终止，asyncio.run 那步「取消剩余任务并跑完」
        根本轮不到。循环 finally 里的收尾（例如网关事件泵交还 lock:gateway-events）
        就随进程一起没了——2026-09-25 生产第一次多 worker 重启，接手方因此白等了
        30 秒 TTL。领导锁本身在 shutdown() 里同步释放，不受影响。

        Shut down and wait (bounded) for cancelled loops to run their finally
        blocks. Cancelling alone is not enough: uvicorn re-raises the captured
        SIGTERM as soon as lifespan shutdown returns, so asyncio.run never gets
        to finish pending tasks and their cleanup (e.g. the gateway event-queue
        lease release) dies with the process.
        """
        self.shutdown()
        pending = {t for t in self._stopping if not t.done()}
        self._stopping.clear()
        if not pending:
            return
        _, still = await asyncio.wait(pending, timeout=timeout)
        if still:
            logger.warning(
                "后台循环 %.0f 秒内没有退出完，放弃等待 / loops still stopping after %.0fs: %s",
                timeout, timeout, sorted(t.get_name() for t in still),
            )

    @property
    def running(self) -> list[str]:
        return sorted(self._tasks)
