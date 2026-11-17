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
from app.services.gateway_client import get_account as gw_get_account
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


def _pushed_key(user_id: str) -> str:
    return f"gw:pos_pushed:{user_id}"


def record_positions_pushed(user_id: str) -> None:
    """记下「此刻有一帧网关持仓要推出去了」（跨 worker 可见）。见 positions_pushed_after。
    Note that a gateway positions frame is going out now (visible to every worker)."""
    try:
        shared_state.kv_set(_pushed_key(user_id), repr(time.time()), ttl=PRIORITY_STAMP_TTL)
    except Exception:  # noqa: BLE001 — 记不下只是少了防覆盖，不影响推送 / best effort
        logger.debug("持仓推送时间戳写入失败 user=%s", user_id, exc_info=True)


def positions_pushed_after(user_id: str, since: float) -> bool:
    """`since`（墙钟秒）之后，有没有别的一帧网关持仓推出去过。同步函数，异步调用方丢线程池。

    为什么要有这个、而不是只比「读开始的时刻」（priority_read_after）：读开始得早不等于数据
    旧。开平仓事件快拍的读是去券商服务器问的，一来一回 0.15 秒，拿回来的是**它到达服务器
    那一刻**的状态；成交回执里带的持仓却是回执那一刻的本地状态。一键平仓时事件快拍比第一笔
    回执的那一轮还早几毫秒开始读，读回来的却是六笔全平之后的空表——按读开始时刻比，它反而
    显得「更旧」，于是挡不住后面那份过期的「还剩 5 笔」（2026-11-17 线上复测）。所以改问
    一个不会判错的问题：我等资金的这段时间里，有没有别人推过。

    Whether another gateway positions frame went out after `since` (wall clock). Comparing
    read *start* times (priority_read_after) is not enough: a read that starts earlier can
    carry newer data. The position-event snapshot asks the broker's server, a 0.15s round
    trip, and returns the state as of when it reached the server, while the rows attached
    to a trade reply are the local state at reply time. On a close-all the event snapshot
    started a few ms before the first reply's pass yet came back with the empty table that
    followed all six closes; judged by start time it looked older and did not stop the
    stale "five left" behind it. So ask the question that cannot be misjudged: did anyone
    else push while this pass was waiting for funds.
    """
    try:
        raw = shared_state.kv_get(_pushed_key(user_id))
    except Exception:  # noqa: BLE001
        return False
    if not raw:
        return False
    try:
        return float(raw) > since
    except (TypeError, ValueError):
        return False


def record_priority_read(user_id: str, started: float) -> None:
    """即时快照（成交后那一路、开平仓事件快拍）推之前调用：记下这次读的开始时刻（周期读据此
    不推比它早开始的数据），同时记下「此刻有一帧要推出去了」。
    Called by the instant snapshots right before pushing: records the read's start (older
    periodic reads then stay quiet) and that a frame is going out now."""
    try:
        shared_state.kv_set(_stamp_key(user_id), repr(started), ttl=PRIORITY_STAMP_TTL)
    except Exception:  # noqa: BLE001 — 记不下只是少了防覆盖，不影响推送 / best effort
        logger.debug("即时快照时间戳写入失败 user=%s", user_id, exc_info=True)
    record_positions_pushed(user_id)


def claim_periodic_push(user_id: str, read_started: float, changed: bool) -> bool:
    """周期读推之前调用：这份数据能不能推。比最近一次即时快照的读开始得早就不推（手里可能是
    成交前的）。能推、而且这一帧的仓位增减了（changed）时，记一笔「有一帧推出去了」——事件
    订阅不可用时，成交后那一路靠它知道自己手里的持仓已经被盖过。只是浮盈在变的帧不记，
    省一次写，也免得让成交后那一路白白多读一轮。同步函数。
    Called by the periodic read before pushing: False when its read began before the latest
    instant snapshot (the data may predate the fill). When it may push and the set of
    positions changed, it records that a frame went out, which is how the post-fill pass
    learns it has been overtaken while the event subscription is down. Frames that only
    move floating P/L are not recorded."""
    if priority_read_after(user_id, read_started):
        return False
    if changed:
        record_positions_pushed(user_id)
    return True


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


# 成交后顺带读资金的超时：读不到就交给慢拍（开平仓事件已让它下一拍就刷资金）。
# Timeout for the post-fill funds read; on failure the slow tick (already told by the
# position event to refresh funds next tick) covers it.
FUNDS_READ_TIMEOUT = 5.0


async def _read_funds(login: str):
    try:
        return await gw_get_account(int(login), timeout=FUNDS_READ_TIMEOUT)
    except Exception:  # noqa: BLE001 — 资金读不到不影响持仓推送 / best effort
        logger.debug("成交后资金读取失败 login=%s", login, exc_info=True)
        return None


def _funds_entry(rsp, rows: list[dict]) -> dict:
    """与慢拍 _note_funds 同一口径：adj = 净值 − 余额 − 这批持仓浮盈之和。
    Same basis as the slow tick's _note_funds."""
    floating = 0.0
    for r in rows:
        v = r.get("profit")
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            floating += float(v)
    balance = float(rsp.balance or 0.0)
    equity = float(rsp.equity or 0.0)
    return {
        "balance": round(balance, 2),
        "equity": round(equity, 2),
        "margin": round(float(rsp.margin or 0.0), 2),
        "adj": round(equity - balance - floating, 2),
    }


async def _latest_rows_by_login(user_id: str, logins: list[str]) -> dict[str, list[dict]] | None:
    """已经推出去的最新那份持仓（跨 worker 的共享快照），按账号分好。读不到返回 None。
    The latest snapshot already pushed (shared across workers), grouped by login; None
    when it cannot be read."""
    try:
        rows = await manager.get_positions_shared_async(user_id)
    except Exception:  # noqa: BLE001 — 读不到只是这次不推资金 / only this funds push is lost
        logger.debug("读共享持仓快照失败 user=%s", user_id, exc_info=True)
        return None
    out: dict[str, list[dict]] = {lg: [] for lg in logins}
    for r in rows or []:
        if isinstance(r, dict):
            lg = str(r.get("login") or "")
            if lg in out:
                out[lg].append(r)
    return out


async def _known_rows(login: str, positions) -> tuple[list[dict], bool]:
    """网关回执里已带的持仓，转成与即时读同样的行。/ Reply positions as rows."""
    from app.routers.gateway import _position_rows

    return _position_rows(login, positions, "")


async def push_positions_now(
    user_id: str, logins: list[str], known: dict | None = None
) -> bool:
    """读齐该用户全部 gateway 账号的持仓并立即推一帧 POSITIONS。返回是否推了。

    必须读齐再推（整表替换语义），任一账号读不到就不推，交给周期读——与事件快拍同一条规矩。
    Read every gateway login of the user and push one POSITIONS frame at once; any
    failed read cancels the push (whole-table replace), leaving it to the poll.

    推之前再看一眼有没有被别人超过（2026-11-16，11-17 改判据）。持仓是这一轮**开始**时
    的样子（回执里带的，或刚读的），却要等资金读完（0.2~0.3 秒）才推出去。这段时间里另一
    路——领导 worker 的开平仓事件快拍，或周期读——可能已经推了一帧更新的：一键平仓时第一
    笔回执带回「还剩 5 笔」，等它推出去时事件快拍早已推过「0 笔」，页面上持仓数就从 0 闪
    回 5 再回到 0。

    判据是「本轮开始之后有没有别的帧推出去过」（positions_pushed_after），不是比读开始的
    时刻——后者会判错，原因见那个函数的说明。被超过时：这一轮的持仓不推、也不盖时间戳；
    资金照推，浮盈按已经推出去的那份持仓算；然后重新读一轮（只多读这一次），保证最后留在
    页面上的是新读的。重读的那一轮又被超过，就只推资金——说明别的路一直在推，持仓交给它。

    Before pushing, check whether this pass has been overtaken. The rows are as of the
    pass's start (attached to the reply, or just read) yet go out only after the funds
    read (0.2-0.3s). Meanwhile another path — the leader worker's position-event snapshot
    or the periodic read — may have pushed a newer frame: on a close-all the first reply
    carried "five left", and by the time it went out the event snapshot had already
    pushed "none", so the count flickered 0 → 5 → 0.

    The test is "did any other frame go out since this pass started"
    (positions_pushed_after), not a comparison of read start times, which misjudges (see
    that function). When overtaken: the rows are neither pushed nor stamped; funds still
    go out, with floating P/L taken from the snapshot that was pushed; then one fresh pass
    re-reads, so what stays on screen is newly read. If that pass is overtaken too, only
    funds go out: another path is evidently keeping the positions current."""
    if not logins:
        return False
    if user_id in _inflight:
        _inflight[user_id] = True
        return False
    _inflight[user_id] = False
    pushed = False
    # 被超过后只补读一轮：别的路一直在推时，不跟它无休止地抢。
    # One catch-up re-read after being overtaken; never chase a path that keeps pushing.
    reread_left = 1
    try:
        while True:
            reread = False
            started = time.time()
            # 持仓与资金一起读：平仓后浮盈一消失，余额要同一时刻跟上，否则净值会先掉
            # 一截、等慢拍刷完资金再弹回来。
            # Positions and funds are read together: once a closed trade's floating P/L
            # disappears the balance must catch up at the same moment, or equity dips
            # until the slow tick refreshes funds.
            # known：网关回执已经带了的账号持仓（只用在第一轮；合并进来的下一轮重新读）。
            # known: positions the gateway reply already carried (first pass only).
            pos_task = asyncio.gather(
                *(
                    _known_rows(lg, known[lg]) if known and lg in known
                    else read_positions_priority(lg)
                    for lg in logins
                ),
                return_exceptions=True,
            )
            known = None
            funds_task = asyncio.gather(*(_read_funds(lg) for lg in logins))
            results, funds_rsps = await asyncio.gather(pos_task, funds_task)
            data: list[dict] = []
            rows_by_login: dict[str, list[dict]] = {}
            complete = True
            for lg, res in zip(logins, results):
                if isinstance(res, BaseException) or not res[1]:
                    complete = False
                    break
                rows_by_login[lg] = res[0]
                data.extend(res[0])
            if complete:
                funds_rows: dict[str, list[dict]] | None = rows_by_login
                if await asyncio.to_thread(positions_pushed_after, user_id, started):
                    # 等资金的这段时间里别的路已经推过一帧：手里这份不推（见上面的说明）。
                    # Another path pushed while this pass waited: drop these rows.
                    funds_rows = await _latest_rows_by_login(user_id, logins)
                    if reread_left > 0:
                        reread_left -= 1
                        reread = True
                else:
                    # 先记时间戳再推：推出去之后才记，中间那一下比它旧的周期读还能挤进来。
                    # Stamp before pushing so an older poll can't slip in between.
                    await asyncio.to_thread(record_priority_read, user_id, started)
                    await manager.push_positions(user_id, data, source="gateway")
                    pushed = True
                if funds_rows is not None:
                    funds = {
                        lg: _funds_entry(rsp, funds_rows.get(lg, []))
                        for lg, rsp in zip(logins, funds_rsps)
                        if rsp is not None
                    }
                    if funds:
                        await manager.push_to_client(
                            user_id, {"type": "ACCOUNT_FUNDS", "data": funds}
                        )
            if not reread and not _inflight.get(user_id):
                break
            _inflight[user_id] = False
    finally:
        _inflight.pop(user_id, None)
    return pushed
