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
