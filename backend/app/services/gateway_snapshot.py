"""Gateway 账号的「即时持仓快照」：成交 / 开平仓事件之后马上读一次持仓并推给前端。

为什么单独成一个模块（2026-11-11 "成交了，但仓位要等几秒才出现"）：
- 前端持仓表只认 POSITIONS 快照（整表替换），下单回执本身不会让新仓位出现。
- 原来只有两条路把新仓位送到前端：开平仓事件快拍（领导 worker 每 0.25 秒）和 2 秒慢拍。
  网关 2 条查询通道被周期读占满时，事件那次读拿到 read_busy 就整次放弃，只能等慢拍，
  慢拍也可能 read_busy——于是成交后要好几秒才看到仓位，平仓也一样。
- 这里的读带 priority（网关可改走交易连接）且短暂重试；任何 worker 都能跑（处理下单
  请求的那个 worker 直接推，经 Redis 转发到用户的 WS 所在 worker）。
- 推完在共享存储里记下「这次读开始的时刻」。周期慢拍 / 事件快拍在推之前比一下：自己的
  读比它早开始，说明手里的数据可能是成交前的，就不推，免得把刚出现的仓位又盖掉（闪一下）。

Immediate position snapshot for gateway accounts, right after a fill or position event.
The frontend only shows positions from POSITIONS frames; when the gateway's query
channels were saturated the event-driven read got read_busy and was dropped, leaving
the user to wait for a later poll. Reads here are priority reads with a short retry, can
run on any worker, and record their start time so an older periodic read doesn't
overwrite them.
"""

from __future__ import annotations

import asyncio
import logging
import time

from app.services import shared_state
from app.services.connection_manager import manager
from app.services.gateway_client import get_positions as gw_get_positions

logger = logging.getLogger("prismx.gateway.router")

# 即时读的重试：网关通道一时忙（或旧网关不认 priority）时最多再等这么几次。
# Retries for the immediate read when the gateway is momentarily busy.
PRIORITY_READ_ATTEMPTS = 5
PRIORITY_READ_RETRY_DELAY = 0.2
# 即时读的超时：比周期读（15 秒）短得多——等太久就失去了"即时"的意义，交给周期读。
# Short timeout: a slow immediate read is no longer immediate; the periodic read takes over.
PRIORITY_READ_TIMEOUT = 5.0

# 「最近一次即时快照的读开始时刻」在共享存储里的保留时长。只需盖过一两拍慢拍。
# How long the last priority read's start time is kept; a couple of slow ticks is enough.
PRIORITY_STAMP_TTL = 15

# 同一用户的即时快照合并：正在跑时再来的请求只记一笔"跑完再来一次"。平仓全部会对
# 每笔单各触发一次，合并后最多两次读。
# Coalesce per user: a request arriving mid-run only asks for one more pass, so a
# close-all of ten positions costs at most two reads.
_inflight: dict[str, bool] = {}


def _stamp_key(user_id: str) -> str:
    return f"gw:prio_pos:{user_id}"


def record_priority_read(user_id: str, started: float) -> None:
    try:
        shared_state.kv_set(_stamp_key(user_id), repr(started), ttl=PRIORITY_STAMP_TTL)
    except Exception:  # noqa: BLE001 — 记不下只是少了防覆盖，不影响推送 / best effort
        logger.debug("即时快照时间戳写入失败 user=%s", user_id, exc_info=True)


def priority_read_after(user_id: str, started: float) -> bool:
    """有没有一次即时快照的读开始得比 `started` 晚（墙钟秒）。True 表示调用方手里的
    数据可能比已经推出去的旧，别推。同步函数，异步调用方请丢进线程池。
    Whether a priority snapshot's read began after `started` (wall clock). True means
    the caller's data may predate what was already pushed, so it should not push."""
    try:
        raw = shared_state.kv_get(_stamp_key(user_id))
    except Exception:  # noqa: BLE001
        return False
    if not raw:
        return False
    try:
        return float(raw) > started
    except (TypeError, ValueError):
        return False


async def read_positions_priority(login: str) -> tuple[list[dict], bool]:
    """带 priority、短重试地读一个账号的持仓，转成推送用的行。
    Read one login's positions as a priority read with a short retry."""
    # 映射在 routers.gateway 里（与周期读共用一份），延迟导入避免循环依赖。
    # The row mapping lives in routers.gateway (shared with the poll); lazy import.
    from app.routers.gateway import _position_rows

    for attempt in range(PRIORITY_READ_ATTEMPTS):
        positions, err = await gw_get_positions(
            int(login), timeout=PRIORITY_READ_TIMEOUT, priority=True
        )
        if not err:
            return _position_rows(login, positions, "")
        # 连不上 / 超时：重试也没用，交给周期读。只对"忙"类错误重试。
        # Connection errors won't fix themselves in 200ms; retry only "busy"-type errors.
        if err in ("connect_failed", "timeout"):
            break
        if attempt + 1 < PRIORITY_READ_ATTEMPTS:
            await asyncio.sleep(PRIORITY_READ_RETRY_DELAY)
    logger.info("即时持仓读取未成功，交给周期读 login=%s", login)
    return [], False


async def push_positions_now(user_id: str, logins: list[str]) -> bool:
    """读齐该用户全部 gateway 账号的持仓并立即推一帧 POSITIONS。返回是否推了。

    必须读齐再推（整表替换语义），任一账号读不到就不推，交给周期读——与事件快拍同一条规矩。
    Read every gateway login of the user and push one POSITIONS frame at once; any
    failed read cancels the push (whole-table replace), leaving it to the poll."""
    if not logins:
        return False
    if user_id in _inflight:
        _inflight[user_id] = True
        return False
    _inflight[user_id] = False
    pushed = False
    try:
        while True:
            started = time.time()
            results = await asyncio.gather(
                *(read_positions_priority(lg) for lg in logins), return_exceptions=True
            )
            data: list[dict] = []
            complete = True
            for res in results:
                if isinstance(res, BaseException) or not res[1]:
                    complete = False
                    break
                data.extend(res[0])
            if complete:
                # 先记时间戳再推：推出去之后才记，中间那一下比它旧的周期读还能挤进来。
                # Stamp before pushing so an older poll can't slip in between.
                await asyncio.to_thread(record_priority_read, user_id, started)
                await manager.push_positions(user_id, data, source="gateway")
                pushed = True
            if not _inflight.get(user_id):
                break
            _inflight[user_id] = False
    finally:
        _inflight.pop(user_id, None)
    return pushed
