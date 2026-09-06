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

from app.services import shared_state

logger = logging.getLogger("prismx.background")

LOCK_NAME = "background-loops"
LOCK_TTL_SECONDS = 60
POLL_SECONDS = 15

LoopFactory = Callable[[], Awaitable[None]]


class BackgroundLoops:
    """一组循环的启停 + 领导权监督。/ Start/stop a set of loops under leadership."""

    def __init__(self, factories: dict[str, LoopFactory], owner: str | None = None) -> None:
        self._factories = factories
        self._tasks: dict[str, asyncio.Task] = {}
        self._supervisor: asyncio.Task | None = None
        # 锁的持有者标识：默认本进程；测试里用不同的值模拟多个 worker。
        # Lock owner: this process by default; tests pass distinct values to simulate workers.
        self._owner = owner or shared_state.WORKER_ID
        self.is_leader = False

    # ---- 直接起 / plain start（单 worker）----
    def start_all(self) -> None:
        for name, factory in self._factories.items():
            if name not in self._tasks:
                self._tasks[name] = asyncio.create_task(factory(), name=f"loop:{name}")
        self.is_leader = True

    def cancel_all(self) -> None:
        for task in self._tasks.values():
            task.cancel()
        self._tasks.clear()
        self.is_leader = False

    # ---- 监督 / supervise（多 worker）----
    def poll(self) -> bool:
        """抢一次锁并据此启停循环；返回本轮是否持有领导权。
        One election round: acquire/renew the lock and start or stop accordingly."""
        try:
            held = shared_state.try_lock(LOCK_NAME, LOCK_TTL_SECONDS, owner=self._owner)
        except Exception as e:  # Redis 抖动：已在跑的先别停，等下一轮再定 / keep running until the next round decides
            logger.warning("后台循环领导锁不可用，本轮跳过 / leader lock unavailable: %s", e)
            held = self.is_leader
        if held and not self.is_leader:
            logger.info("本 worker 接管后台循环 / this worker now runs the background loops (%s)", self._owner)
            self.start_all()
        elif not held and self.is_leader:
            logger.warning("后台循环领导权丢失，停止本 worker 的循环 / leadership lost, stopping loops (%s)", self._owner)
            self.cancel_all()
        return held

    async def supervise(self) -> None:
        while True:
            self.poll()
            await asyncio.sleep(POLL_SECONDS)

    def launch(self) -> None:
        """入口：单 worker 直接起循环；多 worker 起监督协程（首轮立刻抢一次，不等 15 秒）。
        Entry point: start loops directly without Redis, else start the supervisor
        (first election round runs immediately)."""
        if shared_state.enabled():
            self._supervisor = asyncio.create_task(self.supervise(), name="loop:supervisor")
        else:
            self.start_all()

    def shutdown(self) -> None:
        if self._supervisor is not None:
            self._supervisor.cancel()
            self._supervisor = None
        if self.is_leader:
            try:
                shared_state.release_lock(LOCK_NAME, owner=self._owner)
            except Exception:
                pass
        self.cancel_all()

    @property
    def running(self) -> list[str]:
        return sorted(self._tasks)
