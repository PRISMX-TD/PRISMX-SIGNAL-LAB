"""Gateway 在线判定不能被单次探活失败带偏。

现象：顶部连接徽标会无缘无故闪成「未连接」，刷新一下又好了。原因是这条探活
一次失败就置离线，还被 10 秒 TTL 钉住——而它要跨公网到 Windows VPS、并排进
正忙着跑持仓轮询的主事件循环，偶发失败本就是常态。Bridge 那侧早就留了约 3 个
心跳周期的容错（deps.py 的 ONLINE_WINDOW），这里补齐同样的取舍。

Pins that a single failed health probe doesn't flip gateway accounts offline,
mirroring the tolerance bridge liveness already had.
"""
import app.services.gateway_client as gc


def _reset(monkeypatch, clock):
    monkeypatch.setattr(gc.time, "monotonic", clock)
    # 默认按"没有后台探活"跑（单测与脚本的情形），走请求里现探的旧路径。
    # Default to "no background monitor", i.e. the inline-probe fallback path.
    monkeypatch.setattr(gc, "_health_monitor_running", False)
    gc._health_cache.update({"at": 0.0, "online": False, "ok_at": 0.0})


class _Clock:
    """可手动推进的时钟。真实时间没法在单测里等 30 秒。"""

    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t

    def advance(self, seconds):
        self.t += seconds


def _probe(monkeypatch, results):
    """把探活替换成按序返回预设结果；results 用完后重复最后一个。"""
    seq = list(results)

    def fake(coro, timeout):
        # 被替换掉的 health_check() 协程不会被 await，显式关掉避免告警
        coro.close()
        return seq.pop(0) if len(seq) > 1 else seq[0]

    monkeypatch.setattr(gc, "run_on_main_loop", fake)


_UP = {"ok": True, "mt5Connected": True}
_DOWN = {"ok": False, "error": "timeout"}


def test_reports_online_after_successful_probe(monkeypatch):
    clock = _Clock()
    _reset(monkeypatch, clock)
    _probe(monkeypatch, [_UP])
    assert gc.is_gateway_online() is True


def test_single_failure_does_not_flip_offline(monkeypatch):
    """这就是那个 bug：一次失败就闪「未连接」。"""
    clock = _Clock()
    _reset(monkeypatch, clock)
    _probe(monkeypatch, [_UP, _DOWN])

    assert gc.is_gateway_online() is True
    clock.advance(gc._HEALTH_TTL_SECONDS + 1)  # 让 TTL 过期，强制重新探活
    assert gc.is_gateway_online() is True      # 探活失败了，但仍在宽限期内


def test_sustained_failure_eventually_reports_offline(monkeypatch):
    """宽限不是永久豁免：网关真挂了还是要变灰。"""
    clock = _Clock()
    _reset(monkeypatch, clock)
    _probe(monkeypatch, [_UP, _DOWN])

    assert gc.is_gateway_online() is True
    clock.advance(gc._HEALTH_GRACE_SECONDS + 1)
    assert gc.is_gateway_online() is False


def test_recovers_after_gateway_comes_back(monkeypatch):
    clock = _Clock()
    _reset(monkeypatch, clock)
    _probe(monkeypatch, [_UP, _DOWN, _DOWN, _UP])

    assert gc.is_gateway_online() is True
    clock.advance(gc._HEALTH_GRACE_SECONDS + 1)
    assert gc.is_gateway_online() is False
    clock.advance(gc._HEALTH_TTL_SECONDS + 1)
    assert gc.is_gateway_online() is False
    clock.advance(gc._HEALTH_TTL_SECONDS + 1)
    assert gc.is_gateway_online() is True


def test_never_probed_process_is_offline(monkeypatch):
    """进程刚起来、从没成功探活过时不能因为宽限期算法而误报在线。"""
    clock = _Clock(t=5.0)  # monotonic 起点很小，ok_at=0 与它的差值落在宽限期内
    _reset(monkeypatch, clock)
    _probe(monkeypatch, [_DOWN])
    assert gc.is_gateway_online() is False


def test_probe_exception_is_treated_as_failure_not_crash(monkeypatch):
    clock = _Clock()
    _reset(monkeypatch, clock)

    def boom(coro, timeout):
        coro.close()
        raise TimeoutError("main loop congested")

    monkeypatch.setattr(gc, "run_on_main_loop", boom)
    assert gc.is_gateway_online() is False


def test_connected_without_dealer_channel_is_not_online(monkeypatch):
    """连着但 dealer 通道没起来：查得到持仓、下不了单，不能显示在线。
    Connected but no dealer channel can't trade, so it must not read as online."""
    clock = _Clock()
    _reset(monkeypatch, clock)
    _probe(monkeypatch, [{"ok": True, "mt5Connected": True, "dealerActive": False}])
    assert gc.is_gateway_online() is False


def test_older_gateway_without_dealer_field_still_online(monkeypatch):
    """旧网关不报 dealerActive，缺省按可用，别把它们全判离线。
    Older gateways omit dealerActive; default to usable."""
    clock = _Clock()
    _reset(monkeypatch, clock)
    _probe(monkeypatch, [{"ok": True, "mt5Connected": True}])
    assert gc.is_gateway_online() is True


# ---- 后台探活 / background monitor ------------------------------------------------
#
# 在线状态原来是请求线程里现探的：TTL 一过，下一个请求就在自己的线程里干等 /health
# （最长 5 秒）且攥着数据库连接，并发请求各探一次，网关一慢整站跟着堵。现在由每个
# worker 一条后台协程探活，请求只读缓存。
# Liveness used to be probed on request threads (blocking up to 5s while holding a
# DB connection, no single-flight). A per-worker background task now probes and
# requests only read the cache.


def _no_inline_probe(monkeypatch):
    def forbidden(coro, timeout):
        coro.close()
        raise AssertionError("后台探活在跑时，请求线程不该自己探活 / request thread must not probe")

    monkeypatch.setattr(gc, "run_on_main_loop", forbidden)


def test_monitor_running_reads_cache_without_probing(monkeypatch):
    clock = _Clock()
    _reset(monkeypatch, clock)
    monkeypatch.setattr(gc, "_health_monitor_running", True)
    gc._record_probe(True, clock())
    _no_inline_probe(monkeypatch)

    clock.advance(gc._HEALTH_TTL_SECONDS + 1)   # 旧路径这里会现探 / old path would probe here
    assert gc.is_gateway_online() is True


def test_monitor_failures_respect_the_same_grace(monkeypatch):
    """后台探活失败也是 30 秒宽限，不会一次失败就闪离线。"""
    clock = _Clock()
    _reset(monkeypatch, clock)
    monkeypatch.setattr(gc, "_health_monitor_running", True)
    _no_inline_probe(monkeypatch)

    gc._record_probe(True, clock())
    clock.advance(5)
    gc._record_probe(False, clock(), "mt5Connected=False dealerActive=True")
    assert gc.is_gateway_online() is True

    clock.advance(gc._HEALTH_GRACE_SECONDS)
    gc._record_probe(False, clock(), "mt5Connected=False dealerActive=True")
    assert gc.is_gateway_online() is False


def test_stale_monitor_falls_back_to_inline_probe(monkeypatch):
    """探活协程停了（或主循环卡住）时，缓存不能永远被当成新鲜的。
    A stalled monitor must not have its last verdict trusted forever."""
    clock = _Clock()
    _reset(monkeypatch, clock)
    monkeypatch.setattr(gc, "_health_monitor_running", True)
    gc._record_probe(True, clock())
    probes = {"n": 0}

    def fake(coro, timeout):
        coro.close()
        probes["n"] += 1
        return _DOWN

    monkeypatch.setattr(gc, "run_on_main_loop", fake)

    clock.advance(gc._HEALTH_MONITOR_STALE_SECONDS + 1)
    assert gc.is_gateway_online() is True          # 现探失败，但仍在宽限期内 / still in grace
    assert probes["n"] == 1                        # 缓存太旧，确实现探了 / it did probe inline

    clock.advance(gc._HEALTH_GRACE_SECONDS)
    assert gc.is_gateway_online() is False
    assert probes["n"] == 2


def test_verdict_flips_are_logged(monkeypatch, caplog):
    """在线状态每次翻转都要留一行日志：排查「连接不稳定」时这是第一手证据。"""
    clock = _Clock()
    _reset(monkeypatch, clock)

    with caplog.at_level("INFO", logger="prismx.gateway"):
        gc._record_probe(True, clock())
        clock.advance(gc._HEALTH_GRACE_SECONDS + 1)
        gc._record_probe(False, clock(), "mt5Connected=False dealerActive=True")
        clock.advance(1)
        gc._record_probe(False, clock(), "mt5Connected=False dealerActive=True")  # 不再翻转 / no flip

    flips = [r.getMessage() for r in caplog.records if "在线状态" in r.getMessage()]
    assert len(flips) == 2
    assert "在线" in flips[0]
    assert "离线" in flips[1] and "mt5Connected=False" in flips[1]


def test_monitor_loop_probes_and_feeds_the_cache(monkeypatch):
    """跑一小段真实的探活协程：结果写进缓存，is_gateway_online 读到的是它。"""
    import asyncio

    # 不能用 _reset 的假时钟：它替换的是整个 time.monotonic，asyncio 的调度也靠它，
    # 时钟不走 sleep 就永远醒不来。这里用真实时间。
    # Not _reset's fake clock: it replaces time.monotonic globally, which asyncio's
    # scheduler relies on, so sleeps would never wake. Real time here.
    monkeypatch.setattr(gc, "_health_monitor_running", False)
    monkeypatch.setitem(gc._health_cache, "at", 0.0)
    monkeypatch.setitem(gc._health_cache, "online", False)
    monkeypatch.setitem(gc._health_cache, "ok_at", 0.0)
    _no_inline_probe(monkeypatch)
    monkeypatch.setattr(gc, "_HEALTH_PROBE_INTERVAL_SECONDS", 0.01)
    calls = {"n": 0}

    async def fake_health():
        calls["n"] += 1
        return {"ok": True, "mt5Connected": True, "dealerActive": True}

    monkeypatch.setattr(gc, "health_check", fake_health)

    async def main():
        task = asyncio.create_task(gc.gateway_health_monitor_loop())
        await asyncio.sleep(0.05)
        assert gc._health_monitor_running is True
        assert gc.is_gateway_online() is True
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    asyncio.run(main())
    assert calls["n"] >= 2
    assert gc._health_monitor_running is False   # 协程退出后回到现探 / back to inline probing
