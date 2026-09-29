"""1.4.7：减负与稳定性。

钉住的几件事：
- 空持仓 / 内容没变就不重复上报 /positions，约 15 秒补一次保活；有变化、有仓照旧发。
- 后端 poll 响应 wantQuotes 缺失或为真 → 报价 0.5 秒；显式 False → 约 3 秒；下一次响应说
  有人看了就恢复。放慢期间状态循环不会因为「心跳过期」抢着发报价。
- 心跳 /poll 约每 3 秒一次（按上次成功计时，失败下一拍立即重试），持仓上报不受影响。
- 后端不可用时退避（网络类异常 / 5xx），401/403 不退避；成功一次清零。
- 指令长轮询的 HTTP 超时大于 waitSeconds。
- 结果回报走独立线程：入队即返回，失败转进持久化重试队列。

Load and resilience (1.4.7): positions dedupe + keep-alive, wantQuotes pacing, 3 s
heartbeat gate, backoff on backend failure, long-poll timeout > wait, async result reports.
"""
import threading
import time
from urllib import error

import pytest

import bridge_app

TERMINAL = r"C:\fake\terminal64.exe"
LOGIN = "500123"


class FakeHttp:
    def __init__(self):
        self.posts: list[tuple[str, dict]] = []
        self.poll_reply: dict = {}
        self.fail_paths: dict[str, Exception] = {}

    def post(self, path, payload, timeout=None):
        if path in self.fail_paths:
            raise self.fail_paths[path]
        self.posts.append((path, payload))
        return dict(self.poll_reply) if path == "/api/bridge/poll" else {}

    def close(self):
        pass

    def paths(self, path):
        return [p for p in self.posts if p[0] == path]


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


@pytest.fixture()
def engine(monkeypatch, tmp_path):
    monkeypatch.setattr(bridge_app, "EXECUTED_CACHE_PATH", str(tmp_path / "executed.json"))
    monkeypatch.setattr(bridge_app, "REPORTS_CACHE_PATH", str(tmp_path / "reports.json"))
    monkeypatch.setattr(bridge_app, "TRADES_CACHE_PATH", str(tmp_path / "trades.json"))
    eng = bridge_app.BridgeEngine("tok", "http://127.0.0.1:1", lambda *a, **k: None)
    eng._clock = Clock()
    eng._http = FakeHttp()
    return eng


def _run_tick(monkeypatch, engine, positions=()):
    monkeypatch.setattr(bridge_app, "scan_terminals", lambda: [TERMINAL])
    monkeypatch.setattr(bridge_app, "poll_terminal", lambda path, **kw: {
        "account": {"login": LOGIN}, "positions": list(positions), "pendingOrders": [],
        "quotes": [], "results": [], "closedTrades": [], "error": None})
    monkeypatch.setattr(bridge_app, "scan_closed_trades",
                        lambda *a, **k: {"closedTrades": [], "error": None})
    engine._tick()


def _pos(profit=1.0):
    return {"ticket": 1, "symbol": "XAUUSD", "profit": profit}


# ---- 1. 持仓上报去重 / positions dedupe ----------------------------------------

def test_empty_positions_not_reposted_within_keepalive(monkeypatch, engine):
    _run_tick(monkeypatch, engine)
    engine._clock.t += 1.5
    _run_tick(monkeypatch, engine)
    engine._clock.t += 1.5
    _run_tick(monkeypatch, engine)
    assert len(engine._http.paths("/api/bridge/positions")) == 1


def test_keepalive_repost_after_interval(monkeypatch, engine):
    _run_tick(monkeypatch, engine)
    engine._clock.t += bridge_app.POSITIONS_KEEPALIVE_SECONDS + 0.1
    _run_tick(monkeypatch, engine)
    assert len(engine._http.paths("/api/bridge/positions")) == 2


def test_changed_positions_are_posted_every_time(monkeypatch, engine):
    _run_tick(monkeypatch, engine, [_pos(1.0)])
    engine._clock.t += 1.5
    _run_tick(monkeypatch, engine, [_pos(2.0)])
    assert len(engine._http.paths("/api/bridge/positions")) == 2


def test_failed_positions_post_is_retried_next_tick(monkeypatch, engine):
    engine._http.fail_paths["/api/bridge/positions"] = OSError("down")
    _run_tick(monkeypatch, engine)
    del engine._http.fail_paths["/api/bridge/positions"]
    engine._clock.t += 1.5
    _run_tick(monkeypatch, engine)
    assert len(engine._http.paths("/api/bridge/positions")) == 1


def test_unchanged_but_dedupe_reset_by_immediate_report(monkeypatch, engine):
    _run_tick(monkeypatch, engine)
    engine._pos_digest = None   # _execute_commands 即时上报之后 / after an immediate report
    engine._clock.t += 1.5
    _run_tick(monkeypatch, engine)
    assert len(engine._http.paths("/api/bridge/positions")) == 2


# ---- 3. 心跳节奏 / heartbeat gate ------------------------------------------------

def test_heartbeat_every_second_tick(monkeypatch, engine):
    for _ in range(4):
        _run_tick(monkeypatch, engine)
        engine._clock.t += 1.5
    assert len(engine._http.paths("/api/bridge/poll")) == 2   # t=0, t=3.0


def test_heartbeat_tolerates_a_slightly_early_tick(monkeypatch, engine):
    _run_tick(monkeypatch, engine)
    engine._clock.t += 2.9          # 拍距略小于 3 秒也要放行 / a hair under 3 s still goes
    _run_tick(monkeypatch, engine)
    assert len(engine._http.paths("/api/bridge/poll")) == 2


def test_heartbeat_gap_stays_inside_the_backend_window(monkeypatch, engine):
    # 后端 ONLINE_WINDOW = 7 秒；正常拍距 1.5 秒下相邻心跳不超过 3.0 秒
    assert bridge_app.HEARTBEAT_INTERVAL + bridge_app.POLL_INTERVAL <= 7 - 1


def test_failed_heartbeat_retries_on_the_very_next_tick(monkeypatch, engine):
    engine._http.fail_paths["/api/bridge/poll"] = OSError("down")
    _run_tick(monkeypatch, engine)
    del engine._http.fail_paths["/api/bridge/poll"]
    engine._clock.t += 1.5
    _run_tick(monkeypatch, engine)
    assert len(engine._http.paths("/api/bridge/poll")) == 1
    engine._clock.t += 1.5          # 成功后 1.5 秒内不重复 / no repeat right after a success
    _run_tick(monkeypatch, engine)
    assert len(engine._http.paths("/api/bridge/poll")) == 1


def test_skipped_tick_keeps_last_warning(monkeypatch, engine):
    engine._http.poll_reply = {"brokerRejected": ["123"]}
    seen = []
    engine.on_status = lambda accounts, err, warning=None: seen.append(warning)
    _run_tick(monkeypatch, engine)
    engine._clock.t += 1.5
    _run_tick(monkeypatch, engine)   # 心跳被跳过 / heartbeat skipped
    assert seen[0] and seen[1] == seen[0]


# ---- 2. wantQuotes ---------------------------------------------------------------

def test_quote_interval_follows_want_quotes(engine):
    assert engine._quote_interval() == bridge_app.QUOTE_INTERVAL      # 缺省 / default
    engine._note_want_quotes({})
    assert engine._quote_interval() == bridge_app.QUOTE_INTERVAL      # 字段缺失 / missing
    engine._note_want_quotes({"wantQuotes": True})
    assert engine._quote_interval() == bridge_app.QUOTE_INTERVAL
    engine._note_want_quotes({"wantQuotes": False})
    assert engine._quote_interval() == bridge_app.QUOTE_INTERVAL_IDLE
    engine._note_want_quotes({"commands": []})                        # 旧后端：恢复 / back to fast
    assert engine._quote_interval() == bridge_app.QUOTE_INTERVAL


def test_status_poll_reply_sets_want_quotes(monkeypatch, engine):
    engine._http.poll_reply = {"wantQuotes": False}
    _run_tick(monkeypatch, engine)
    assert engine._want_quotes is False


def test_slowed_quote_thread_is_still_considered_serving(engine):
    class Alive:
        def is_alive(self):
            return True

    engine._quote_thread = Alive()
    engine._quote_path = TERMINAL
    engine._note_want_quotes({"wantQuotes": False})
    engine._quote_ok_at = time.monotonic() - bridge_app.QUOTE_INTERVAL_IDLE
    assert engine._quote_thread_serving()
    engine._note_want_quotes({"wantQuotes": True})
    assert not engine._quote_thread_serving()   # 同样的间隔在快档下算过期 / stale at the fast pace


def _fallback_quote_posts(engine):
    return engine._http.paths("/api/bridge/quotes")


def _run_quote_tick(monkeypatch, engine, price):
    monkeypatch.setattr(bridge_app, "scan_terminals", lambda: [TERMINAL])
    monkeypatch.setattr(bridge_app, "poll_terminal", lambda path, **kw: {
        "account": {"login": LOGIN}, "positions": [], "pendingOrders": [],
        "quotes": [{"symbol": "XAUUSD", "bid": price, "ask": price + 0.1}],
        "results": [], "closedTrades": [], "error": None})
    monkeypatch.setattr(bridge_app, "scan_closed_trades",
                        lambda *a, **k: {"closedTrades": [], "error": None})
    engine._tick()


def test_status_loop_fallback_quotes_slow_when_nobody_watches(monkeypatch, engine):
    engine._http.poll_reply = {"wantQuotes": False}
    _run_quote_tick(monkeypatch, engine, 2000.0)
    assert len(_fallback_quote_posts(engine)) == 1        # 首拍照发 / first tick sends
    for i in range(1, 4):
        engine._clock.t += 0.5
        _run_quote_tick(monkeypatch, engine, 2000.0 + i)
    assert len(_fallback_quote_posts(engine)) == 1        # 放慢期间不发 / slowed
    engine._clock.t += bridge_app.QUOTE_INTERVAL_IDLE
    _run_quote_tick(monkeypatch, engine, 2010.0)
    assert len(_fallback_quote_posts(engine)) == 2


def test_status_loop_fallback_quotes_stay_fast_when_missing_or_true(monkeypatch, engine):
    for reply in ({}, {"wantQuotes": True}):
        engine._http.posts.clear()
        engine._http.poll_reply = reply
        engine._fallback_quotes_at = float("-inf")
        for i in range(3):
            engine._clock.t += 1.5
            _run_quote_tick(monkeypatch, engine, 2000.0 + i)
        assert len(_fallback_quote_posts(engine)) == 3


def test_status_loop_fallback_quotes_resume_when_someone_watches(monkeypatch, engine):
    engine._http.poll_reply = {"wantQuotes": False}
    _run_quote_tick(monkeypatch, engine, 2000.0)
    engine._clock.t += 1.5
    _run_quote_tick(monkeypatch, engine, 2001.0)
    assert len(_fallback_quote_posts(engine)) == 1
    engine._http.poll_reply = {"wantQuotes": True}
    engine._clock.t += 1.5
    _run_quote_tick(monkeypatch, engine, 2002.0)
    assert len(_fallback_quote_posts(engine)) == 2        # 立即恢复 / back at once


def test_quote_sleep_wakes_early_when_someone_watches(engine):
    engine._note_want_quotes({"wantQuotes": False})
    threading.Timer(0.2, lambda: engine._note_want_quotes({"wantQuotes": True})).start()
    t0 = time.monotonic()
    engine._quote_sleep(t0)
    assert time.monotonic() - t0 < 1.5


def test_quote_sleep_honours_stop(engine):
    engine._note_want_quotes({"wantQuotes": False})
    engine._stop.set()
    t0 = time.monotonic()
    engine._quote_sleep(t0)
    assert time.monotonic() - t0 < 0.5


# ---- 4. 退避 / backoff ------------------------------------------------------------

def test_backoff_delay_grows_and_is_capped():
    for n, base in [(1, 1.5), (2, 3.0), (3, 6.0), (4, 10.0), (9, 10.0)]:
        d = bridge_app._backoff_delay(n, bridge_app.COMMAND_BACKOFF_CAP)
        assert base * 0.8 - 1e-9 <= d <= base * 1.2 + 1e-9
    d = bridge_app._backoff_delay(9, bridge_app.STATUS_BACKOFF_CAP)
    assert 15 * 0.8 - 1e-9 <= d <= 15 * 1.2 + 1e-9


def test_backoff_error_classification():
    def http_err(code):
        return error.HTTPError("http://x", code, "r", {}, None)

    assert bridge_app._is_backoff_error(OSError("net"))
    assert bridge_app._is_backoff_error(http_err(502))
    assert not bridge_app._is_backoff_error(http_err(401))
    assert not bridge_app._is_backoff_error(http_err(403))


def _fail_count_after_tick(monkeypatch, engine, exc):
    engine._http.fail_paths["/api/bridge/poll"] = exc
    _run_tick(monkeypatch, engine)
    return engine._status_fail_n


def test_status_loop_counts_network_and_5xx_failures(monkeypatch, engine):
    assert _fail_count_after_tick(monkeypatch, engine, OSError("down")) == 1
    assert _fail_count_after_tick(monkeypatch, engine,
                                  error.HTTPError("http://x", 503, "r", {}, None)) == 2


def test_status_loop_401_keeps_status_message_without_backoff(monkeypatch, engine):
    msgs = []
    engine.on_status = lambda accounts, err, warning=None: msgs.append(err)
    assert _fail_count_after_tick(monkeypatch, engine,
                                  error.HTTPError("http://x", 401, "Unauthorized", {}, None)) == 0
    assert "检查 Token" in msgs[-1]


def test_status_loop_success_resets_the_counter(monkeypatch, engine):
    _fail_count_after_tick(monkeypatch, engine, OSError("down"))
    del engine._http.fail_paths["/api/bridge/poll"]
    engine._clock.t += 1.5
    _run_tick(monkeypatch, engine)
    assert engine._status_fail_n == 0


def test_status_loop_wait_uses_backoff(monkeypatch, engine):
    waits = []

    class Stop:
        def __init__(self):
            self.n = 0

        def is_set(self):
            self.n += 1
            return self.n > 1

        def wait(self, t):
            waits.append(t)

    engine._stop = Stop()
    engine._status_fail_n = 3
    monkeypatch.setattr(engine, "_tick", lambda: None)
    engine._loop()
    assert 6.0 * 0.8 <= waits[0] <= 6.0 * 1.2


def test_command_loop_backs_off_on_network_error_and_resets(monkeypatch, engine):
    waits = []
    calls = {"n": 0}

    class Stop:
        def __init__(self):
            self.n = 0

        def is_set(self):
            self.n += 1
            return self.n > 4

        def wait(self, t):
            waits.append(t)
            return False

    class Http:
        def post(self, path, payload, timeout=None):
            calls["n"] += 1
            calls["timeout"] = timeout
            if calls["n"] <= 2:
                raise OSError("down")
            if calls["n"] == 3:
                raise error.HTTPError("http://x", 403, "Forbidden", {}, None)
            return {"commands": [], "wantQuotes": False}

    engine._stop = Stop()
    engine._cmd_http = Http()
    engine._accounts_snapshot = [{"login": LOGIN}]
    engine._command_loop()
    assert 1.5 * 0.8 <= waits[0] <= 1.5 * 1.2
    assert 3.0 * 0.8 <= waits[1] <= 3.0 * 1.2
    assert waits[2] == bridge_app.POLL_INTERVAL          # 403：不退避 / no backoff
    assert engine._cmd_fail_n == 0                       # 第 4 次成功后清零 / cleared by the success
    assert engine._want_quotes is False                  # 长轮询响应也带 wantQuotes


# ---- 5. 长轮询超时 / long-poll timeout ---------------------------------------------

def test_long_poll_http_timeout_exceeds_the_wait():
    assert bridge_app.COMMAND_HTTP_TIMEOUT == 9.0
    assert bridge_app.COMMAND_HTTP_TIMEOUT > bridge_app.COMMAND_WAIT_SECONDS + 2


def test_long_poll_sends_the_short_timeout(engine):
    seen = {}

    class Stop:
        n = 0

        def is_set(self):
            Stop.n += 1
            return Stop.n > 1

        def wait(self, t):
            return False

    class Http:
        def post(self, path, payload, timeout=None):
            seen["timeout"] = timeout
            seen["wait"] = payload["waitSeconds"]
            return {"commands": []}

    engine._stop = Stop()
    engine._cmd_http = Http()
    engine._accounts_snapshot = [{"login": LOGIN}]
    engine._command_loop()
    assert seen["timeout"] == bridge_app.COMMAND_HTTP_TIMEOUT
    assert seen["timeout"] > seen["wait"]


# ---- 6. 异步结果回报 / async result reports ----------------------------------------

def test_report_result_is_synchronous_without_the_thread(engine):
    http = FakeHttp()
    engine._report_result({"clientOrderId": "a"}, http)
    assert http.posts == [("/api/bridge/result", {"clientOrderId": "a"})]


def test_report_result_only_enqueues_when_async(engine):
    http = FakeHttp()
    engine._async_reports = True
    engine._report_result({"clientOrderId": "a"}, http)
    assert http.posts == []
    assert list(engine._report_q) == [{"clientOrderId": "a"}]


def test_reporter_thread_sends_in_order_and_stops(engine):
    sender = FakeHttp()
    engine._report_http = sender
    engine._async_reports = True
    t = threading.Thread(target=engine._report_loop, daemon=True)
    t.start()
    for i in range(3):
        engine._report_result({"clientOrderId": f"c{i}"})
    deadline = time.monotonic() + 3
    while len(sender.posts) < 3 and time.monotonic() < deadline:
        time.sleep(0.01)
    engine._stop.set()
    engine._report_wake.set()
    t.join(timeout=3)
    assert not t.is_alive()
    assert [p[1]["clientOrderId"] for p in sender.posts] == ["c0", "c1", "c2"]
    assert engine._pending_reports == []


def test_failed_async_send_moves_the_rest_to_the_retry_list(engine):
    sender = FakeHttp()
    sender.fail_paths["/api/bridge/result"] = OSError("down")
    engine._report_http = sender
    for i in range(3):
        engine._report_q.append({"clientOrderId": f"c{i}"})
    engine._drain_reports()
    assert [r["clientOrderId"] for r in engine._pending_reports] == ["c0", "c1", "c2"]
    assert not engine._report_q


def test_leftovers_are_persisted_on_final_drain(engine):
    engine._report_q.append({"clientOrderId": "x"})
    engine._drain_reports(final=True)
    assert engine._pending_reports == [{"clientOrderId": "x"}]
