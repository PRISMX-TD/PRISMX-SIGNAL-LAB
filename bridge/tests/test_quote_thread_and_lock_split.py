"""报价独立线程 + 状态循环分段拿 MT5 锁。

钉住的几件事：
- `read_live_quotes` 只在**当前已附着**的终端上读，绝不触发 initialize / 切换终端；
  没有元数据、账号换了都返回 None（调用方什么都不发，状态循环兜底）。
- `_send_quotes` 与状态循环共用一份去重表；发送失败时把去重记录退回，下一轮重发。
- 报价线程在正常出报价（单终端、心跳新鲜）时状态循环不再发报价；线程退出 / 心跳
  过期 / 多终端时自动退回原路径。
- 状态循环读一台终端分两段拿锁：`poll_terminal(scan_closed=False)` 与
  `scan_closed_trades` 各一次，段间释放；第二段会重新确认附着。

Quote thread + the status loop's split MT5 lock: read_live_quotes never attaches or
switches terminals; the dedupe table is shared and rolled back on a failed post; the
status loop stops sending quotes only while the thread is healthy; and each terminal
read takes the lock twice with a release in between.
"""
import threading
import time
import types

import pytest

import bridge_app
import mt5_worker


TERMINAL = r"C:\fake\terminal64.exe"
OTHER = r"C:\other\terminal64.exe"
LOGIN = "500123"


class FakeMt5:
    """报价 / 账号 / 平仓扫描够用的 MT5 替身；initialize 计次，用来断言报价线程不切终端。
    Enough MT5 for quotes, account and the closed-trade scan; initialize is counted."""

    POSITION_TYPE_BUY = 0
    POSITION_TYPE_SELL = 1
    DEAL_ENTRY_OUT = 1
    DEAL_TYPE_SELL = 1

    def __init__(self, bid=1912.30, ask=1912.60, login=LOGIN):
        self.bid = bid
        self.ask = ask
        self.login = login
        self.initialize_calls = 0
        self.tick_calls = 0
        self.history_calls = 0

    # ---- 附着 / attachment ----
    def initialize(self, path=None, timeout=None):
        self.initialize_calls += 1
        return True

    def shutdown(self):
        return True

    def terminal_info(self):
        return types.SimpleNamespace(path=TERMINAL)

    def last_error(self):
        return (0, "ok")

    # ---- 账号 / 品种 / account & symbols ----
    def account_info(self):
        if self.login is None:
            return None
        return types.SimpleNamespace(
            login=int(self.login), server="Demo", name="T", currency="USD",
            balance=1000.0, equity=1000.0, margin=0.0, leverage=100,
            company="Fake", trade_mode=0,
        )

    def symbols_get(self):
        return [types.SimpleNamespace(name="XAUUSD")]

    def symbol_select(self, name, enable=True):
        return name == "XAUUSD"

    def symbol_info(self, name):
        return types.SimpleNamespace(
            digits=2, trade_mode=4, trade_contract_size=100.0,
            trade_tick_size=0.01, trade_tick_value_loss=1.0, trade_tick_value=1.0,
        )

    def symbol_info_tick(self, name):
        self.tick_calls += 1
        return types.SimpleNamespace(bid=self.bid, ask=self.ask, time=int(time.time()))

    # ---- 持仓 / 挂单 / 历史 / positions, orders, history ----
    def positions_get(self, ticket=None):
        return ()

    def orders_get(self, ticket=None):
        return ()

    def history_deals_get(self, *args, **kwargs):
        self.history_calls += 1
        return ()


class FakeHttp:
    def __init__(self, fail=False):
        self.posts: list[tuple[str, dict]] = []
        self.fail = fail

    def post(self, path, payload, timeout=None):
        if self.fail:
            raise OSError("backend down")
        self.posts.append((path, payload))
        return {}

    def close(self):
        pass


class CountingLock:
    """记录拿锁次数、并能断言"此刻是否持有"的锁 / a lock that counts acquisitions."""

    def __init__(self):
        self._lock = threading.Lock()
        self.acquisitions = 0

    def __enter__(self):
        self._lock.acquire()
        self.acquisitions += 1
        return self

    def __exit__(self, *exc):
        self._lock.release()
        return False

    def locked(self):
        return self._lock.locked()


@pytest.fixture()
def worker_state(monkeypatch):
    """模块级附着状态、品种表缓存、报价元数据都是全局的，用例之间必须清干净。"""
    monkeypatch.setattr(mt5_worker, "_attached_path", None)
    monkeypatch.setattr(mt5_worker, "_symbols_cache", None)
    monkeypatch.setattr(mt5_worker, "_resolved_cache", {})
    monkeypatch.setattr(mt5_worker, "_unresolved_until", {})
    monkeypatch.setattr(mt5_worker, "_live_quote_meta", {})
    monkeypatch.setattr(mt5_worker, "_last_scan_at", {})
    monkeypatch.setattr(mt5_worker, "_utc_offset_samples", {})


@pytest.fixture()
def engine(monkeypatch, tmp_path, worker_state):
    monkeypatch.setattr(bridge_app, "EXECUTED_CACHE_PATH", str(tmp_path / "executed.json"))
    monkeypatch.setattr(bridge_app, "REPORTS_CACHE_PATH", str(tmp_path / "reports.json"))
    monkeypatch.setattr(bridge_app, "TRADES_CACHE_PATH", str(tmp_path / "trades.json"))
    eng = bridge_app.BridgeEngine("tok", "http://127.0.0.1:1", lambda *a, **k: None)
    return eng


def _prime(fake):
    """跑一次完整的状态读取：附着 TERMINAL 并留下报价元数据。"""
    res = mt5_worker.poll_terminal(TERMINAL, scan_closed=False)
    assert res["error"] is None
    return res


# ---- 1. read_live_quotes -------------------------------------------------------

def test_live_quotes_read_ticks_from_the_metadata(monkeypatch, worker_state):
    fake = FakeMt5()
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    _prime(fake)
    before = fake.initialize_calls

    fake.bid, fake.ask = 1913.004, 1913.306
    quotes = mt5_worker.read_live_quotes(TERMINAL)

    assert quotes == [{
        "symbol": "XAUUSD", "bid": 1913.0, "ask": 1913.31, "digits": 2, "login": LOGIN,
        "contractSize": 100.0, "tickSize": 0.01, "tickValue": 1.0,
    }]
    assert fake.initialize_calls == before, "报价线程绝不附着 / never attaches"


def test_live_quotes_never_switch_terminals(monkeypatch, worker_state):
    fake = FakeMt5()
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    _prime(fake)
    before = fake.initialize_calls

    assert mt5_worker.read_live_quotes(OTHER) is None
    assert fake.initialize_calls == before


def test_live_quotes_none_without_metadata(monkeypatch, worker_state):
    fake = FakeMt5()
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    monkeypatch.setattr(mt5_worker, "_attached_path", TERMINAL)
    assert mt5_worker.read_live_quotes(TERMINAL) is None
    assert fake.tick_calls == 0


def test_live_quotes_none_after_account_switch(monkeypatch, worker_state):
    fake = FakeMt5()
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    _prime(fake)
    fake.login = "999999"
    assert mt5_worker.read_live_quotes(TERMINAL) is None


# ---- 2. 分段拿锁 / split lock --------------------------------------------------

def test_poll_terminal_can_leave_the_scan_out(monkeypatch, worker_state):
    fake = FakeMt5()
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    res = mt5_worker.poll_terminal(TERMINAL, scan_closed=False)
    assert res["account"]["login"] == LOGIN
    assert fake.history_calls == 0

    scan = mt5_worker.scan_closed_trades(TERMINAL)
    assert scan == {"closedTrades": [], "error": None}
    assert fake.history_calls == 1


def test_scan_closed_trades_reattaches_if_switched_in_between(monkeypatch, worker_state):
    """段间指令线程切到了别的终端：第二段必须切回来，而不是扫错终端。"""
    fake = FakeMt5()
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    mt5_worker.poll_terminal(TERMINAL, scan_closed=False)
    mt5_worker.poll_terminal(OTHER, read_state=False)       # 指令线程切走 / command loop switched
    assert mt5_worker._attached_path == OTHER

    mt5_worker.scan_closed_trades(TERMINAL)
    assert mt5_worker._attached_path == TERMINAL


def test_tick_takes_the_lock_in_two_segments(monkeypatch, engine):
    lock = CountingLock()
    engine._mt5_lock = lock
    calls = []

    def fake_poll(path, orders=None, deep_backfill=False, read_state=True, scan_closed=True):
        assert lock.locked()
        calls.append(("poll", scan_closed, lock.acquisitions))
        return {"account": {"login": LOGIN}, "positions": [], "pendingOrders": [],
                "quotes": [], "results": [], "closedTrades": [], "error": None}

    def fake_scan(path, deep_backfill=False):
        assert lock.locked()
        calls.append(("scan", None, lock.acquisitions))
        return {"closedTrades": [], "error": None}

    monkeypatch.setattr(bridge_app, "scan_terminals", lambda: [TERMINAL])
    monkeypatch.setattr(bridge_app, "poll_terminal", fake_poll)
    monkeypatch.setattr(bridge_app, "scan_closed_trades", fake_scan)
    engine._http = FakeHttp()

    engine._tick()

    # 两段、两次独立的拿锁；第一段明确不带扫描 / two separate acquisitions
    assert calls == [("poll", False, 1), ("scan", None, 2)]


def test_tick_skips_the_scan_without_an_account(monkeypatch, engine):
    scanned = []
    monkeypatch.setattr(bridge_app, "scan_terminals", lambda: [TERMINAL])
    monkeypatch.setattr(bridge_app, "poll_terminal", lambda *a, **k: {
        "account": None, "positions": [], "pendingOrders": [], "quotes": [],
        "results": [], "closedTrades": [], "error": "initialize failed"})
    monkeypatch.setattr(bridge_app, "scan_closed_trades", lambda *a, **k: scanned.append(1))
    engine._http = FakeHttp()
    engine._tick()
    assert scanned == []


# ---- 3. 去重与回退 / dedupe & rollback ------------------------------------------

def _q(bid, ask=None, symbol="XAUUSD"):
    return {"symbol": symbol, "login": LOGIN, "bid": bid, "ask": ask if ask is not None else bid + 0.3}


def test_send_quotes_posts_only_changes(engine):
    http = FakeHttp()
    engine._send_quotes([_q(1.0)], http)
    engine._send_quotes([_q(1.0)], http)
    engine._send_quotes([_q(1.1)], http)
    assert [p[1]["data"][0]["bid"] for p in http.posts] == [1.0, 1.1]


def test_failed_post_is_resent_next_round(engine):
    engine._send_quotes([_q(1.0)], FakeHttp())
    with pytest.raises(OSError):
        engine._send_quotes([_q(1.1)], FakeHttp(fail=True))
    http = FakeHttp()
    engine._send_quotes([_q(1.1)], http)   # 价格没再变，也得补发 / resent although unchanged
    assert len(http.posts) == 1


# ---- 4. 谁发报价 / who sends quotes ---------------------------------------------

def _tick_with_quote(monkeypatch, engine, paths):
    monkeypatch.setattr(bridge_app, "scan_terminals", lambda: list(paths))

    def fake_poll(path, **kw):
        return {"account": {"login": LOGIN if path == TERMINAL else "7"}, "positions": [],
                "pendingOrders": [], "quotes": [{"symbol": "XAUUSD", "bid": 1.0, "ask": 1.3}],
                "results": [], "closedTrades": [], "error": None}

    monkeypatch.setattr(bridge_app, "poll_terminal", fake_poll)
    monkeypatch.setattr(bridge_app, "scan_closed_trades",
                        lambda *a, **k: {"closedTrades": [], "error": None})
    http = FakeHttp()
    engine._http = http
    engine._tick()
    return [p for p in http.posts if p[0] == "/api/bridge/quotes"]


class _AliveThread:
    def is_alive(self):
        return True


def test_status_loop_skips_quotes_while_thread_serves(monkeypatch, engine):
    engine._quote_thread = _AliveThread()
    engine._quote_path = TERMINAL
    engine._quote_ok_at = time.monotonic()
    assert _tick_with_quote(monkeypatch, engine, [TERMINAL]) == []


def test_status_loop_resumes_when_heartbeat_is_stale(monkeypatch, engine):
    engine._quote_thread = _AliveThread()
    engine._quote_ok_at = time.monotonic() - bridge_app.QUOTE_THREAD_STALE_SECONDS - 1
    assert len(_tick_with_quote(monkeypatch, engine, [TERMINAL])) == 1


def test_status_loop_resumes_when_thread_died(monkeypatch, engine):
    dead = threading.Thread(target=lambda: None)
    dead.start()
    dead.join()
    engine._quote_thread = dead
    engine._quote_ok_at = time.monotonic()
    assert len(_tick_with_quote(monkeypatch, engine, [TERMINAL])) == 1


def test_multi_terminal_keeps_the_original_path(monkeypatch, engine):
    engine._quote_thread = _AliveThread()
    engine._quote_ok_at = time.monotonic()
    posts = _tick_with_quote(monkeypatch, engine, [TERMINAL, OTHER])
    assert engine._quote_path is None
    assert len(posts) == 1
    assert {q["login"] for q in posts[0][1]["data"]} == {LOGIN, "7"}


def test_single_terminal_hands_the_path_to_the_thread(monkeypatch, engine):
    _tick_with_quote(monkeypatch, engine, [TERMINAL])
    assert engine._quote_path == TERMINAL


# ---- 5. 线程端到端 / thread end to end ------------------------------------------

def test_quote_thread_posts_changes_and_stops(monkeypatch, engine):
    fake = FakeMt5()
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    monkeypatch.setattr(bridge_app, "QUOTE_INTERVAL", 0.02)
    _prime(fake)
    before = fake.initialize_calls
    http = FakeHttp()
    engine._quote_http = http
    engine._quote_path = TERMINAL

    t = threading.Thread(target=engine._quote_loop, daemon=True)
    engine._quote_thread = t
    t.start()
    deadline = time.monotonic() + 2
    while not http.posts and time.monotonic() < deadline:
        time.sleep(0.01)
    fake.bid, fake.ask = 1920.0, 1920.3
    while len(http.posts) < 2 and time.monotonic() < deadline:
        time.sleep(0.01)

    assert engine._quote_thread_serving()
    engine._stop.set()
    t.join(timeout=2)

    assert not t.is_alive(), "stop 之后线程要退出 / thread exits on stop"
    assert [p[1]["data"][0]["bid"] for p in http.posts] == [1912.3, 1920.0]
    assert fake.initialize_calls == before
    assert not engine._quote_thread_serving()
