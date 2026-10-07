"""后台循环的健康记录，给管理后台「系统状态」页用。

以前十几条后台循环（services/background.py）跑没跑、报没报错，只能翻 journal：
循环里的异常都被自己 catch 住、logger.exception 一行就继续，任务整个死掉也没人知道。
这里记三件事，都写进 shared_state（多 worker 时是 Redis）——跑循环的是领导 worker，
回答状态页请求的可能是另一个 worker，记在进程内存里另一个 worker 看不到：

  · 心跳 beat(name)：关键循环每一轮开头调一次，记「最近一次开始干活」的时间。
    同一个循环 HEARTBEAT_MIN_GAP 秒内只真正写一次，2 秒一拍的循环也不会刷 Redis。
  · 报错：LoopErrorHandler 挂在根 logger 上，凡是在名为 "loop:<name>" 的 asyncio 任务
    里打出的 ERROR 日志，都记成该循环的「最近一次报错」。各循环一行代码都不用改。
    （在 run_in_threadpool 的线程里打的日志没有当前任务，收不到——但循环的 except 都在
    协程里，线程里抛的异常会传回协程再被记下。）
  · 崩溃：任务整个退出了（不是被取消），BackgroundLoops 的 done 回调记一笔。

Health records for the background loops, read by the admin system-status page.
Stored in shared_state because the leader worker runs the loops while any worker
may answer the request.
"""
from __future__ import annotations

import asyncio
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from app.services import shared_state

logger = logging.getLogger("prismx.loop_health")

TASK_PREFIX = "loop:"
KEY_BEAT = "loophealth:beat:"
KEY_ERROR = "loophealth:error:"
KEY_CRASH = "loophealth:crash:"
# 记录保留 3 天：周末停一停、周一回来还能看到上周五最后的样子。
RECORD_TTL = 3 * 24 * 3600
HEARTBEAT_MIN_GAP = 10.0
ERROR_MIN_GAP = 10.0
MESSAGE_MAX = 300

_lock = threading.Lock()
_last_write: dict[str, float] = {}


def _throttled(key: str, gap: float) -> bool:
    """同一个 key gap 秒内第二次起返回 True（跳过）。/ True = skip this write."""
    now = time.monotonic()
    with _lock:
        last = _last_write.get(key)
        if last is not None and now - last < gap:
            return True
        _last_write[key] = now
        return False


# 写记录不能卡事件循环。beat / record_error / record_crash / clear_crash 都是在事件
# 循环线程上被调的（循环开头、日志 Handler、任务 done 回调、_start），而配了 Redis 时
# 每次写都是一次同步往返——Redis 一慢就在事件循环上卡满 socket 超时（2 秒），所有
# WS 推送、请求跟着停。所以在事件循环上、且后端是 Redis 时，写交给一条专用线程**发出
# 即忘**：单线程保证先后顺序（clear_crash 之后的 record_crash 不会被反过来）；积压超过
# _MAX_PENDING 条就丢——健康记录本来就是尽力而为，宁丢一条也不能越堆越多。
# 不在事件循环上（线程池、脚本），或用的是进程内后端（纯内存、不阻塞）时照旧同步写。
# Writes must not block the event loop. These are called on the loop thread (loop
# heads, the log handler, done callbacks, _start), and with Redis each is a blocking
# round trip that can stall for the 2s socket timeout. On the loop with Redis they are
# handed to one dedicated thread, fire-and-forget: a single thread keeps their order,
# and anything beyond _MAX_PENDING is dropped (health records are best-effort).
# Off the loop, or with the in-memory backend, writes stay synchronous.
_MAX_PENDING = 256
_executor: ThreadPoolExecutor | None = None
_pending = 0


def _call(fn, *args, **kwargs) -> None:
    try:
        fn(*args, **kwargs)
    except Exception:
        pass


def _offloaded(fn, *args, **kwargs) -> None:
    global _pending
    try:
        _call(fn, *args, **kwargs)
    finally:
        with _lock:
            _pending -= 1


def shutdown() -> None:
    """关停时丢掉尚未执行的健康记录写入，别让 Redis 卡住时拖慢进程退出。
    Drop queued health writes at shutdown so a stalled Redis can't delay exit."""
    global _executor, _pending
    with _lock:
        executor, _executor = _executor, None
        _pending = 0
    if executor is not None:
        executor.shutdown(wait=False, cancel_futures=True)


def _write(fn, *args, **kwargs) -> None:
    """执行一次记录写入；永不抛异常。在事件循环上且后端是 Redis 时发出即忘（见上）。
    Run one record write, never raising; fire-and-forget on the loop with Redis."""
    global _executor, _pending
    try:
        asyncio.get_running_loop()
        on_loop = True
    except RuntimeError:
        on_loop = False
    if not (on_loop and shared_state.enabled()):
        _call(fn, *args, **kwargs)
        return
    with _lock:
        if _pending >= _MAX_PENDING:
            return
        if _executor is None:
            _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="loop-health")
        _pending += 1
        executor = _executor
    try:
        executor.submit(_offloaded, fn, *args, **kwargs)
    except Exception:  # 解释器关停中 / interpreter shutting down
        with _lock:
            _pending -= 1


def beat(name: str) -> None:
    """记一次心跳。永不抛异常、不阻塞事件循环：记录失败不能影响循环本身。/ Never raises or blocks."""
    if _throttled(KEY_BEAT + name, HEARTBEAT_MIN_GAP):
        return
    _write(shared_state.kv_set_json, KEY_BEAT + name, {"at": time.time()}, ttl=RECORD_TTL)


def record_error(name: str, message: str) -> None:
    if _throttled(KEY_ERROR + name, ERROR_MIN_GAP):
        return
    _write(
        shared_state.kv_set_json,
        KEY_ERROR + name, {"at": time.time(), "message": message[:MESSAGE_MAX]}, ttl=RECORD_TTL)


def record_crash(name: str, message: str) -> None:
    _write(
        shared_state.kv_set_json,
        KEY_CRASH + name, {"at": time.time(), "message": message[:MESSAGE_MAX]}, ttl=RECORD_TTL)


def clear_crash(name: str) -> None:
    """循环重新启动（换主、重启）时清掉旧的崩溃记录。"""
    _write(shared_state.kv_delete, KEY_CRASH + name)


def snapshot(names: list[str]) -> dict[str, dict]:
    """每个循环的 {beatAt, errorAt, errorMessage, crashAt, crashMessage}（epoch 秒，没有为 None）。"""
    out: dict[str, dict] = {}
    for name in names:
        beat_rec = _get(KEY_BEAT + name)
        err = _get(KEY_ERROR + name)
        crash = _get(KEY_CRASH + name)
        out[name] = {
            "beatAt": beat_rec.get("at") if beat_rec else None,
            "errorAt": err.get("at") if err else None,
            "errorMessage": err.get("message") if err else None,
            "crashAt": crash.get("at") if crash else None,
            "crashMessage": crash.get("message") if crash else None,
        }
    return out


def _get(key: str) -> dict | None:
    try:
        v = shared_state.kv_get_json(key)
        return v if isinstance(v, dict) else None
    except Exception:
        return None


def current_loop_name() -> str | None:
    """当前代码是不是跑在某条后台循环的任务里；是的话返回循环名。"""
    try:
        task = asyncio.current_task()
    except RuntimeError:  # 不在事件循环线程上（线程池里）
        return None
    if task is None:
        return None
    task_name = task.get_name()
    if task_name.startswith(TASK_PREFIX):
        return task_name[len(TASK_PREFIX):]
    return None


class LoopErrorHandler(logging.Handler):
    """把后台循环任务里打出的 ERROR 日志记成该循环的最近报错。"""

    def __init__(self) -> None:
        super().__init__(level=logging.ERROR)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            name = current_loop_name()
            if name is None or name == "supervisor":
                return
            message = record.getMessage()
            if record.exc_info and record.exc_info[1] is not None:
                exc = record.exc_info[1]
                message = "%s: %s: %s" % (message, type(exc).__name__, exc)
            record_error(name, message)
        except Exception:
            pass


_handler: LoopErrorHandler | None = None


def install_error_handler() -> None:
    """挂到根 logger 上（幂等）。在 lifespan 启动时调一次。"""
    global _handler
    if _handler is not None:
        return
    _handler = LoopErrorHandler()
    logging.getLogger().addHandler(_handler)
