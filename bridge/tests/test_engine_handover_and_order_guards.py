"""引擎交接与下单护栏（2026-10-07 审计）。

钉住的几件事：
- 断开重连 / 一键更新时新旧两个引擎并存：MT5 锁、「查缓存→执行→记缓存」互斥、已执行
  缓存都是进程级共享的；新引擎会等旧引擎手上的指令记进缓存，再命中缓存而不是再执行一次。
- stop() 之后指令线程不再开始新指令；poll_terminal 每条指令前问一次 should_stop。
- stop() 不在界面线程里关 HTTP 连接（那会卡在长轮询的锁上）。
- 缓存写盘是合并，不会冲掉盘上别的进程刚写的条目。
- 发单前核对终端当前账号；不一致 REJECTED，平仓不会被误报成「已平」。
- 手数步长 1e-05、digits=0、tick_size 对齐、撤挂单「查不了」不算成功、深度回扫失败可重试。

Engine hand-over and order guards (2026-10-07 audit).
"""
import json
import threading
import time
import types

import pytest

import bridge_app
import mt5_worker

TERMINAL = r"C:\fake\terminal64.exe"
LOGIN = "500123"


class FakeHttp:
    def __init__(self):
        self.posts: list = []
        self.closed = 0

    def post(self, path, payload, timeout=None):
        self.posts.append((path, payload))
        return {}

    def close(self):
        self.closed += 1


def _new_engine():
    eng = bridge_app.BridgeEngine("tok", "http://127.0.0.1:1", lambda *a, **k: None)
    eng._login_to_path = {LOGIN: TERMINAL}
    return eng


@pytest.fixture()
def paths(monkeypatch, tmp_path):
    monkeypatch.setattr(bridge_app, "EXECUTED_CACHE_PATH", str(tmp_path / "executed.json"))
    monkeypatch.setattr(bridge_app, "REPORTS_CACHE_PATH", str(tmp_path / "reports.json"))
    monkeypatch.setattr(bridge_app, "TRADES_CACHE_PATH", str(tmp_path / "trades.json"))
    # 不让即时持仓上报去碰真 MT5 / keep the immediate positions refresh off real MT5
    monkeypatch.setattr(bridge_app, "read_positions", lambda path: None)
    monkeypatch.setattr(bridge_app, "read_pending_orders", lambda path: None)
    return tmp_path


def _cmd(coid="coid-1"):
    return {"clientOrderId": coid, "login": LOGIN, "action": "ORDER",
            "symbol": "XAUUSD", "side": "BUY", "volume": 0.01}


def _filled(coid):
    return {"clientOrderId": coid, "success": True, "status": "FILLED", "mt5Ticket": 9}


# ---- 1. 引擎交接 / engine hand-over -------------------------------------------

def test_engines_share_the_mt5_lock_exec_lock_and_cache(paths):
    a, b = _new_engine(), _new_engine()
    assert a._mt5_lock is b._mt5_lock
    assert a._exec_lock is b._exec_lock
    a._remember_executed("coid-1", _filled("coid-1"))
    assert b._executed.get("coid-1", {}).get("status") == "FILLED"


def test_stopped_engine_starts_no_new_command(monkeypatch, paths):
    calls = []
    monkeypatch.setattr(bridge_app, "poll_terminal", lambda *a, **k: calls.append(1) or {"results": []})
    eng = _new_engine()
    eng.stop()
    eng._execute_commands([_cmd()], FakeHttp())
    assert calls == []


def test_new_engine_waits_for_old_in_flight_and_hits_the_cache(monkeypatch, paths):
    """旧引擎正卡在执行中；新引擎拿到后端重发的同一条，必须等它记进缓存后命中缓存。"""
    entered, release = threading.Event(), threading.Event()
    executed = []

    def fake_poll(path, orders=None, **kw):
        executed.append([o["clientOrderId"] for o in orders or []])
        entered.set()
        release.wait(5)
        return {"results": [_filled(o["clientOrderId"]) for o in orders or []], "error": None}

    monkeypatch.setattr(bridge_app, "poll_terminal", fake_poll)
    old, new = _new_engine(), _new_engine()
    old_http, new_http = FakeHttp(), FakeHttp()

    t_old = threading.Thread(target=old._execute_commands, args=([_cmd()], old_http))
    t_old.start()
    assert entered.wait(5)
    old.stop()                                  # 断开：旧引擎的那条仍在 order_send 里
    t_new = threading.Thread(target=new._execute_commands, args=([_cmd()], new_http))
    t_new.start()
    time.sleep(0.1)
    assert executed == [["coid-1"]]             # 新引擎还在锁外等 / new engine is waiting
    release.set()
    t_old.join(5)
    t_new.join(5)

    assert executed == [["coid-1"]], "同一条指令只能执行一次 / executed exactly once"
    results = [p for p in new_http.posts if p[0] == "/api/bridge/result"]
    assert [r[1]["status"] for r in results] == ["FILLED"]


def test_wait_idle_blocks_until_the_in_flight_command_is_recorded(monkeypatch, paths):
    entered, release = threading.Event(), threading.Event()

    def fake_poll(path, orders=None, **kw):
        entered.set()
        release.wait(5)
        return {"results": [_filled("coid-1")], "error": None}

    monkeypatch.setattr(bridge_app, "poll_terminal", fake_poll)
    eng = _new_engine()
    t = threading.Thread(target=eng._execute_commands, args=([_cmd()], FakeHttp()))
    t.start()
    assert entered.wait(5)
    eng.stop()
    assert eng.wait_idle(0.1) is False          # 还在执行 / still executing
    release.set()
    assert eng.wait_idle(5) is True
    t.join(5)
    # 落盘了，新进程能读到 / persisted for the next process
    with open(bridge_app.EXECUTED_CACHE_PATH, encoding="utf-8") as f:
        assert "coid-1" in json.load(f)


def test_poll_terminal_checks_should_stop_before_each_command(monkeypatch):
    monkeypatch.setattr(mt5_worker, "mt5", types.SimpleNamespace())
    monkeypatch.setattr(mt5_worker, "_ensure_attached", lambda path: True)
    monkeypatch.setattr(mt5_worker, "_detect_suffix", lambda: "")
    sent = []
    stop = threading.Event()

    def dispatch_then_stop(cmd, suffix=""):
        # 第一条执行期间桥接被停掉 / the bridge is stopped while the first one runs
        sent.append(cmd["clientOrderId"])
        stop.set()
        return _filled(cmd["clientOrderId"])

    monkeypatch.setattr(mt5_worker, "_dispatch_command", dispatch_then_stop)
    res = mt5_worker.poll_terminal(TERMINAL, orders=[_cmd("a"), _cmd("b")], read_state=False,
                                   should_stop=stop.is_set)
    assert sent == ["a"]
    assert [r["clientOrderId"] for r in res["results"]] == ["a"]


def test_stop_does_not_close_clients_on_the_calling_thread(paths):
    eng = _new_engine()

    class Blocking(FakeHttp):
        def close(self):
            raise AssertionError("stop() must not close clients itself")

    eng._http = Blocking()
    eng._cmd_http = Blocking()
    eng.stop()   # 不抛 = 没去碰 close / no exception means close was not touched
    assert eng._stop.is_set()


def test_command_loop_closes_its_own_client_on_exit(paths):
    eng = _new_engine()
    eng._cmd_http = FakeHttp()
    eng._stop.set()
    eng._command_loop()
    assert eng._cmd_http.closed == 1


def test_cache_save_merges_entries_written_by_another_process(paths):
    other = {"coid-x": {"ts": time.time(), "result": _filled("coid-x")}}
    with open(bridge_app.EXECUTED_CACHE_PATH, "w", encoding="utf-8") as f:
        json.dump(other, f)
    results, stamps = {"coid-y": _filled("coid-y")}, {"coid-y": time.time()}
    bridge_app._save_executed_cache(results, stamps)
    with open(bridge_app.EXECUTED_CACHE_PATH, encoding="utf-8") as f:
        on_disk = json.load(f)
    assert set(on_disk) == {"coid-x", "coid-y"}
    assert "coid-x" in results               # 内存也认得 / memory honours it too


# ---- 2. 发单前核对账号 / account check before sending ------------------------------

class AccountMt5:
    def __init__(self, login):
        self.login = login
        self.positions_queries = 0

    def account_info(self):
        return types.SimpleNamespace(login=int(self.login))

    def positions_get(self, ticket=None):
        self.positions_queries += 1
        return ()


def test_close_on_the_wrong_account_is_rejected_not_already_closed(monkeypatch):
    fake = AccountMt5("999")
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    out = mt5_worker._dispatch_command({"clientOrderId": "c", "login": LOGIN,
                                        "action": "CLOSE", "ticket": 5})
    assert out["status"] == "REJECTED"
    assert out["success"] is False
    assert "Position already closed" not in out["message"]
    assert fake.positions_queries == 0


def test_order_on_the_wrong_account_is_rejected(monkeypatch):
    fake = AccountMt5("999")
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    called = []
    monkeypatch.setattr(mt5_worker, "_execute_order", lambda *a, **k: called.append(1))
    out = mt5_worker._dispatch_command(_cmd())
    assert out["status"] == "REJECTED"
    assert called == []


def test_matching_account_proceeds(monkeypatch):
    fake = AccountMt5(LOGIN)
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    out = mt5_worker._dispatch_command({"clientOrderId": "c", "login": LOGIN,
                                        "action": "CLOSE", "ticket": 5})
    assert fake.positions_queries == 1
    assert out["status"] == "FILLED"   # 账号对、仓位确实不在 / right account, really gone


# ---- 4/5. 手数与价格精度 / lot and price precision -----------------------------------

def test_step_decimals_handles_scientific_notation():
    assert mt5_worker._step_decimals(1e-05) == 5
    assert mt5_worker._step_decimals(0.01) == 2
    assert mt5_worker._step_decimals(1.0) == 0
    assert mt5_worker._step_decimals(10.0) == 0


def test_normalize_volume_with_tiny_step_is_not_rounded_to_zero(monkeypatch):
    info = types.SimpleNamespace(volume_step=1e-05, volume_min=1e-05, volume_max=100.0)
    monkeypatch.setattr(mt5_worker, "mt5", types.SimpleNamespace(symbol_info=lambda s: info))
    assert mt5_worker._normalize_volume("BTCUSD", 0.00003) == pytest.approx(0.00003)


def test_zero_digits_are_not_treated_as_five():
    assert mt5_worker._price_digits(types.SimpleNamespace(digits=0)) == 0
    assert mt5_worker._price_digits(None) == 5
    assert mt5_worker._price_digits(types.SimpleNamespace()) == 5


def test_compute_stops_snaps_to_tick_size_and_keeps_min_distance(monkeypatch):
    info = types.SimpleNamespace(point=1.0, digits=0, trade_tick_size=5.0, trade_stops_level=10)
    tick = types.SimpleNamespace(ask=20003.0, bid=20000.0)
    monkeypatch.setattr(mt5_worker, "mt5", types.SimpleNamespace(
        symbol_info=lambda s: info, symbol_info_tick=lambda s: tick))
    sl, tp = mt5_worker._compute_stops("US30", "BUY", 0.0, 19901.0, 20102.0)
    assert sl == 19900.0 and tp == 20100.0
    # 夹到最小距离后对齐不能跨回最小距离以内 / snapping never re-enters the min distance
    sl, tp = mt5_worker._compute_stops("US30", "BUY", 0.0, 19999.0, 20004.0)
    assert sl % 5 == 0 and 20003.0 - sl >= 10
    assert tp % 5 == 0 and tp - 20003.0 >= 10


def test_pending_stops_snap_to_tick_size(monkeypatch):
    info = types.SimpleNamespace(point=0.01, digits=2, trade_tick_size=0.25, trade_stops_level=0)
    monkeypatch.setattr(mt5_worker, "mt5", types.SimpleNamespace(symbol_info=lambda s: info))
    sl, tp = mt5_worker._clamp_pending_stops("ES", "BUY", 5000.0, 4990.13, 5010.38)
    assert sl == 4990.25 and tp == 5010.5


# ---- 6. 撤挂单确认 / cancel confirmation -------------------------------------------

class CancelMt5:
    TRADE_ACTION_REMOVE = 8
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_PLACED = 10008

    def __init__(self, after):
        self._after = after
        self.calls = 0

    def orders_get(self, ticket=None):
        self.calls += 1
        if self.calls == 1:
            return (types.SimpleNamespace(magic=mt5_worker.PRISMX_MAGIC),)
        return self._after

    def order_send(self, req):
        return types.SimpleNamespace(retcode=self.TRADE_RETCODE_PLACED, order=0)

    def last_error(self):
        return (-1, "x")


@pytest.fixture()
def fast_confirm(monkeypatch):
    monkeypatch.setattr(mt5_worker, "_CONFIRM_TOTAL_SECONDS", 0.05)
    monkeypatch.setattr(mt5_worker, "_CONFIRM_INTERVAL_SECONDS", 0.01)


def test_cancel_unverifiable_is_failed_not_success(monkeypatch, fast_confirm):
    monkeypatch.setattr(mt5_worker, "mt5", CancelMt5(after=None))
    out = mt5_worker._cancel_pending({"clientOrderId": "c", "ticket": 7})
    assert out["status"] == "FAILED" and out["success"] is False


def test_cancel_confirmed_gone_is_success(monkeypatch, fast_confirm):
    monkeypatch.setattr(mt5_worker, "mt5", CancelMt5(after=()))
    out = mt5_worker._cancel_pending({"clientOrderId": "c", "ticket": 7})
    assert out["status"] == "FILLED" and out["success"] is True


# ---- 7. 深度回扫失败可重试 / a failed deep rescan is retried --------------------------

def _tick_with_scan(monkeypatch, engine, scan_result):
    monkeypatch.setattr(bridge_app, "scan_terminals", lambda: [TERMINAL])
    monkeypatch.setattr(bridge_app, "poll_terminal", lambda path, **kw: {
        "account": {"login": LOGIN}, "positions": [], "pendingOrders": [],
        "quotes": [], "results": [], "closedTrades": [], "error": None})
    seen = []

    def fake_scan(path, deep_backfill=False):
        seen.append(deep_backfill)
        return scan_result

    monkeypatch.setattr(bridge_app, "scan_closed_trades", fake_scan)
    engine._tick()
    return seen


def test_deep_backfill_marked_done_only_after_success(monkeypatch, paths):
    monkeypatch.setattr(bridge_app, "_backfill_requested", {LOGIN})
    monkeypatch.setattr(bridge_app, "_backfill_done", set())
    monkeypatch.setattr(bridge_app, "_path_login", {TERMINAL: LOGIN})
    eng = _new_engine()
    eng._http = FakeHttp()

    seen = _tick_with_scan(monkeypatch, eng, {"closedTrades": [], "error": "deep backfill scan failed"})
    assert seen == [True]
    assert LOGIN not in bridge_app._backfill_done

    seen = _tick_with_scan(monkeypatch, eng, {"closedTrades": [], "error": None})
    assert seen == [True]                       # 失败后重试 / retried after the failure
    assert LOGIN in bridge_app._backfill_done


def test_deep_scan_raises_when_it_cannot_run(monkeypatch):
    monkeypatch.setattr(mt5_worker, "mt5", types.SimpleNamespace(account_info=lambda: None))
    assert mt5_worker._closed_trades_payload(deep_backfill=False) == []
    with pytest.raises(RuntimeError):
        mt5_worker._closed_trades_payload(deep_backfill=True)
