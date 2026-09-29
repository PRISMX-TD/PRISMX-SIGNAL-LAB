"""用户连接质量统计（管理后台「连接质量」卡片）。

数据来源：前端每 10 秒一帧的应用层心跳 PING 里顺带捎上它自己量到的上一次往返
延迟（`rtt`）与波动（`jit`）。不另开请求、不另起上报通道——心跳本来就要发，
多两个数字而已；老版本前端的 PING 不带这两个字段，这里就只记连接不记延迟。

存法全走 shared_state，多 worker 下管理员看到的是全站汇总而不是自己那个进程：
  - `netq:live`（带成员过期的集合）+ `netq:conn:<id>`：每条在线连接最近一次读数，
    60 秒不续期就过期——连接死了不必等谁来清。
  - `netq:h:<YYYYMMDDHH>:<field>`：按小时的计数器（连接次数、断开次数、好/中/差
    样本数、延迟累加），保留 26 小时，够画「最近 24 小时」。

User connection-quality stats for the admin "Connection quality" card. The
frontend's 10s app-level PING already carries the last round trip it measured
(`rtt`) and its jitter (`jit`) — no extra request, no reporting channel. Older
frontends send a bare PING; those connections are counted without latency. All
state goes through shared_state so admins see a site-wide picture across workers.

这里的函数都是**同步**的（同步 Redis；record_* 每次只发一个 pipeline），协程里要走 anyio 线程池
（connection_manager.run_blocking，不要用 asyncio.to_thread）。
Every function here is synchronous (sync Redis; each record_* sends exactly one pipeline); from
coroutines call via anyio's pool (connection_manager.run_blocking, not asyncio.to_thread).
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from app.services import shared_state

# 与前端 store/netQuality.ts 的分界一致 / same thresholds as the frontend
GOOD_MS = 150
FAIR_MS = 400

_LIVE_SET = "netq:live"
_LIVE_TTL = 60  # 3 次心跳没续上即视为不在线 / three missed heartbeats → gone
_HOUR_TTL = 26 * 3600
_RTT_CAP = 60_000  # 超过一分钟的读数是时钟跳了，不是网络 / >60s is a clock jump, not a network


def _hour_key(ts: float | None = None) -> str:
    return datetime.fromtimestamp(ts or time.time(), tz=timezone.utc).strftime("%Y%m%d%H")


def _bump(field: str) -> None:
    shared_state.incr_with_ttl(f"netq:h:{_hour_key()}:{field}", _HOUR_TTL)


def _pipeline() -> Any:
    """配了 Redis 时返回同步 pipeline（一条心跳的全部写入合成一次往返），否则 None（走
    shared_state 的原语，内存后端）。pipeline 不带 MULTI/EXEC：这些只是互不相干的计数与读数。
    A sync pipeline when Redis is on (all of one heartbeat's writes in one round-trip), else None
    (the shared_state primitives, i.e. the memory backend). No MULTI/EXEC: these are independent
    counters and readings."""
    if not shared_state.enabled():
        return None
    return shared_state._redis().pipeline(transaction=False)


def _pipe_bump(pipe: Any, field: str, by: int = 1) -> None:
    """pipeline 版的 incr_with_ttl：INCR 之后总是 EXPIRE（pipeline 里拿不到 INCR 的结果来判断
    「是不是第一次」，多一条 EXPIRE 不多一次往返，计数键 26 小时才过期，续期无害）。
    The pipeline twin of incr_with_ttl: INCR followed by an unconditional EXPIRE (a pipeline can't
    see INCR's result to tell "first write"; the extra EXPIRE costs no round-trip, and refreshing a
    26-hour counter is harmless)."""
    key = shared_state._k(f"netq:h:{_hour_key()}:{field}")
    pipe.incr(key, by)
    pipe.expire(key, _HOUR_TTL)


def _pipe_live(pipe: Any, conn_id: str, row: dict[str, Any]) -> None:
    """pipeline 版的「进在线集合 + 写这条连接的读数」（与 set_add / kv_set_json 同一写法）。
    Pipeline twin of "join the live set + write this connection's reading" (same encoding as
    set_add / kv_set_json)."""
    pipe.zadd(shared_state._k(_LIVE_SET), {conn_id: time.time() + _LIVE_TTL})
    pipe.set(shared_state._k(f"netq:conn:{conn_id}"), json.dumps(row, ensure_ascii=False, default=str), ex=_LIVE_TTL)


def bucket(rtt: int) -> str:
    return "good" if rtt < GOOD_MS else "fair" if rtt < FAIR_MS else "poor"


def parse_ping(frame: dict[str, Any]) -> tuple[int | None, int | None, str]:
    """从 PING 帧里取出 (rtt, jit, 端)。字段缺失或不像话一律当没有。
    Pull (rtt, jit, client kind) out of a PING frame; anything implausible → None."""
    def num(v: Any) -> int | None:
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return None
        n = int(v)
        return n if 0 <= n <= _RTT_CAP else None

    kind = frame.get("app")
    return num(frame.get("rtt")), num(frame.get("jit")), "app" if kind is True else "web"


def record_connect(conn_id: str, user_id: int) -> None:
    pipe = _pipeline()
    if pipe is None:
        _bump("connects")
        shared_state.set_add(_LIVE_SET, conn_id, _LIVE_TTL)
        shared_state.kv_set_json(f"netq:conn:{conn_id}", {"u": user_id, "t": time.time()}, _LIVE_TTL)
        return
    _pipe_bump(pipe, "connects")
    _pipe_live(pipe, conn_id, {"u": user_id, "t": time.time()})
    pipe.execute()


def record_sample(conn_id: str, user_id: int, rtt: int | None, jit: int | None, kind: str) -> None:
    row = {"u": user_id, "rtt": rtt, "jit": jit, "k": kind, "t": time.time()}
    pipe = _pipeline()
    if pipe is None:
        shared_state.set_add(_LIVE_SET, conn_id, _LIVE_TTL)
        shared_state.kv_set_json(f"netq:conn:{conn_id}", row, _LIVE_TTL)
        if rtt is None:
            return
        _bump(bucket(rtt))
        # 样本数 = 好+中+差，这里只累加延迟，平均值在读的时候算。
        # Sample count is good+fair+poor; only the sum is kept here, averaged on read.
        shared_state.incr_with_ttl(f"netq:h:{_hour_key()}:sum", _HOUR_TTL, by=rtt)
        return
    # 每个心跳 PING 一次往返：以前是 zadd、set、incr+expire、incr+expire 四五次串行同步调用。
    # One round-trip per heartbeat PING; it used to be four or five serial sync calls.
    _pipe_live(pipe, conn_id, row)
    if rtt is not None:
        _pipe_bump(pipe, bucket(rtt))
        _pipe_bump(pipe, "sum", rtt)
    pipe.execute()


def record_disconnect(conn_id: str) -> None:
    pipe = _pipeline()
    if pipe is None:
        _bump("disconnects")
        shared_state.set_remove(_LIVE_SET, conn_id)
        shared_state.kv_delete(f"netq:conn:{conn_id}")
        return
    _pipe_bump(pipe, "disconnects")
    pipe.zrem(shared_state._k(_LIVE_SET), conn_id)
    pipe.delete(shared_state._k(f"netq:conn:{conn_id}"))
    pipe.execute()


def snapshot() -> dict[str, Any]:
    """管理后台读数：当前在线连接的分布 + 最近 24 小时按小时的趋势。
    Admin read-out: live distribution now + hourly trend over the last 24h."""
    live: list[dict[str, Any]] = []
    for cid in shared_state.set_members(_LIVE_SET):
        row = shared_state.kv_get_json(f"netq:conn:{cid}")
        if isinstance(row, dict):
            live.append(row)

    dist = {"good": 0, "fair": 0, "poor": 0, "unknown": 0}
    by_kind = {"app": 0, "web": 0}
    rtts: list[int] = []
    for row in live:
        rtt = row.get("rtt")
        if isinstance(rtt, int):
            dist[bucket(rtt)] += 1
            rtts.append(rtt)
        else:
            dist["unknown"] += 1
        by_kind["app" if row.get("k") == "app" else "web"] += 1
    rtts.sort()

    def pct(p: float) -> int | None:
        return rtts[min(len(rtts) - 1, int(len(rtts) * p))] if rtts else None

    worst = sorted((r for r in live if isinstance(r.get("rtt"), int)), key=lambda r: -r["rtt"])[:10]

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    hours = []
    for i in range(23, -1, -1):
        h = now - timedelta(hours=i)
        hk = h.strftime("%Y%m%d%H")

        def g(f: str) -> int:
            return int(shared_state.kv_get(f"netq:h:{hk}:{f}") or 0)

        good, fair, poor = g("good"), g("fair"), g("poor")
        n = good + fair + poor
        hours.append({
            "hour": h.isoformat(),
            "connects": g("connects"),
            "disconnects": g("disconnects"),
            "good": good,
            "fair": fair,
            "poor": poor,
            "avgRtt": round(g("sum") / n) if n else None,
        })

    return {
        "thresholds": {"good": GOOD_MS, "fair": FAIR_MS},
        "live": {
            "connections": len(live),
            "users": len({r.get("u") for r in live}),
            "dist": dist,
            "byKind": by_kind,
            "p50": pct(0.5),
            "p90": pct(0.9),
        },
        "worst": [{"userId": r.get("u"), "rtt": r["rtt"], "jit": r.get("jit"), "kind": r.get("k", "web")} for r in worst],
        "hourly": hours,
    }
