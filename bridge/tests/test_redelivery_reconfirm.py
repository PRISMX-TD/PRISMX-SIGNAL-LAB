"""后端重发同一 clientOrderId 时：对缓存里的 FAILED 只重跑确认、不重跑执行。

背景：FAILED 的意思是「不知道成没成」。桥接**刻意**把它也写进 24 小时幂等缓存——
重报一次 FAILED 是安全的，重新执行却可能开出第二笔仓。代价是那笔后来其实成交了的单
会在后端永远停在 FAILED。`BridgeEngine._reconfirm_cached` 把这个代价消掉：重发时拿缓存
里记下的**订单号**去查这张单现在的终态，查到成交就升级成 FILLED 再回报。

这组用例钉死四件事：

  1. 缓存是 FAILED + 有订单号 + 现在查到成交 → 回报 FILLED（并把缓存也升级）；
  2. 查不到 / 查到仍未成交 → 照旧回报 FAILED，绝不改判 REJECTED；
  3. 没有订单号、账号不在本机、以及 **CLOSE / MODIFY**（它们的 mt5Ticket 是仓位号
     而不是订单号）→ 照旧重报，不做任何升级；
  4. **任何情形下 order_send 的调用次数都必须是 0** —— 重新执行正是这套幂等缓存要
     防的那件事，所以这一条每个用例都断言。

运行：cd bridge && python -m pytest tests

On a re-delivery the bridge re-runs only the confirmation, never the execution. Every
case here asserts order_send was called zero times, because re-executing is precisely
what the idempotency cache exists to prevent.
"""
import types

import pytest

import bridge_app
import mt5_worker


TERMINAL = r"C:\fake\terminal64.exe"
LOGIN = "500123"
ORDER_TICKET = 918273


class FakeMt5:
    """够用的 MT5 替身：附着、品种表、订单历史、持仓，外加一个 order_send 探针。

    常量取值与真实 MetaTrader5 包一致（与 tests/test_execution_three_states.py 里
    那份核对过的表同源）。order_send 只记次数——被测路径一次都不该碰它。

    A minimal MT5 stand-in. order_send merely counts calls: the path under test must
    never reach it.
    """

    ORDER_STATE_PLACED = 1
    ORDER_STATE_CANCELED = 2
    ORDER_STATE_PARTIAL = 3
    ORDER_STATE_FILLED = 4
    ORDER_STATE_REJECTED = 5
    ORDER_STATE_EXPIRED = 6
    POSITION_TYPE_BUY = 0
    POSITION_TYPE_SELL = 1

    def __init__(self, history=None, positions=()):
        self._history = history
        self._positions = positions
        self.order_send_calls = 0
        self.history_queries: list[int] = []

    # ---- 附着 / attachment ----
    def initialize(self, path=None, timeout=None):
        return True

    def shutdown(self):
        return True

    def terminal_info(self):
        return types.SimpleNamespace(path=TERMINAL)

    def account_info(self):
        return types.SimpleNamespace(login=int(LOGIN))

    def symbols_get(self):
        return []

    def last_error(self):
        return (0, "ok")

    # ---- 只读查询 / read-only queries ----
    def history_orders_get(self, ticket=None):
        self.history_queries.append(ticket)
        if callable(self._history):
            return self._history(ticket)
        return self._history

    def positions_get(self, ticket=None):
        if ticket is None:
            return self._positions
        return tuple(p for p in self._positions if p.ticket == ticket)

    # ---- 绝不该被调到 / must never be reached ----
    def order_send(self, request):
        self.order_send_calls += 1
        return types.SimpleNamespace(retcode=10009, order=1, price=1.0, deal=0)


class FakeHttp:
    """记录回报了什么 / records what was reported."""

    def __init__(self):
        self.posts: list[tuple[str, dict]] = []

    def post(self, path, payload, timeout=None):
        self.posts.append((path, payload))
        return {}


def _order(state):
    return types.SimpleNamespace(state=state)


def _position(ticket, entry=1912.34):
    return types.SimpleNamespace(
        ticket=ticket, symbol="XAUUSD", type=FakeMt5.POSITION_TYPE_BUY,
        volume=0.01, profit=0.0, price_open=entry, price_current=entry,
        sl=0.0, tp=0.0, magic=mt5_worker.PRISMX_MAGIC,
    )


@pytest.fixture()
def fast_confirm(monkeypatch):
    """把确认的等待预算压到几乎为零，免得用例真的睡 3 秒。"""
    monkeypatch.setattr(mt5_worker, "_CONFIRM_TOTAL_SECONDS", 0.05)
    monkeypatch.setattr(mt5_worker, "_CONFIRM_INTERVAL_SECONDS", 0.01)


@pytest.fixture()
def engine(monkeypatch, tmp_path):
    """一个不启动任何线程的 BridgeEngine，三个落盘缓存全部改到 tmp。

    缓存路径必须换掉：`_remember_executed` 会真的写 `~/.prismx_bridge_executed.json`，
    跑一次用例就污染了本机的真实幂等缓存。
    """
    monkeypatch.setattr(bridge_app, "EXECUTED_CACHE_PATH", str(tmp_path / "executed.json"))
    monkeypatch.setattr(bridge_app, "REPORTS_CACHE_PATH", str(tmp_path / "reports.json"))
    monkeypatch.setattr(bridge_app, "TRADES_CACHE_PATH", str(tmp_path / "trades.json"))
    # 模块级附着状态与品种表缓存是全局的，用例之间必须清干净。
    monkeypatch.setattr(mt5_worker, "_attached_path", None)
    monkeypatch.setattr(mt5_worker, "_symbols_cache", None)
    eng = bridge_app.BridgeEngine("tok", "http://127.0.0.1:1", lambda *a, **k: None)
    eng._login_to_path = {LOGIN: TERMINAL}
    return eng


def _cache_failed(engine, coid="coid-1", ticket=ORDER_TICKET):
    """往缓存里放一条 FAILED（不知道成没成）的开仓回执。"""
    result = {
        "clientOrderId": coid,
        "success": False,
        "status": "FAILED",
        "mt5Ticket": ticket,
        "filledPrice": None,
        "volume": 0.01,
        "message": "执行结果未确认 / outcome unconfirmed",
        "login": LOGIN,
    }
    engine._executed[coid] = result
    engine._executed_at[coid] = 1.0
    return result


def _command(coid="coid-1", action="ORDER", **extra):
    cmd = {"clientOrderId": coid, "login": LOGIN, "action": action,
           "symbol": "XAUUSD", "side": "BUY", "volume": 0.01}
    cmd.update(extra)
    return cmd


def _redeliver(engine, fake, cmd):
    """走真实的 _execute_commands 入口，返回 (回报出去的结果, 假 http)。"""
    http = FakeHttp()
    engine._execute_commands([cmd], http)
    assert fake.order_send_calls == 0, "重发路径绝不允许重新执行 / re-delivery must never re-execute"
    assert len(http.posts) == 1
    path, payload = http.posts[0]
    assert path == "/api/bridge/result"
    return payload, http


# ---- 1. 查到成交 → 升级成 FILLED ------------------------------------------

def test_failed_with_ticket_now_filled_is_upgraded(monkeypatch, engine, fast_confirm):
    """缓存是 FAILED、订单号还在、现在查到这张单成交了 → 回报 FILLED。"""
    fake = FakeMt5(history=[_order(FakeMt5.ORDER_STATE_FILLED)],
                   positions=(_position(ORDER_TICKET),))
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    _cache_failed(engine)

    payload, _ = _redeliver(engine, fake, _command())

    assert payload["status"] == "FILLED"
    assert payload["success"] is True
    assert payload["clientOrderId"] == "coid-1"
    assert payload["mt5Ticket"] == ORDER_TICKET
    # 查的必须是缓存里记下的那张单 / the cached ticket is what gets looked up
    assert fake.history_queries == [ORDER_TICKET]


def test_upgrade_backfills_the_fill_price_from_the_position(monkeypatch, engine, fast_confirm):
    """开仓单的订单号就是仓位号，所以持仓里的入场价就是本单的成交价。"""
    fake = FakeMt5(history=[_order(FakeMt5.ORDER_STATE_FILLED)],
                   positions=(_position(ORDER_TICKET, entry=1925.5),))
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    _cache_failed(engine)

    payload, _ = _redeliver(engine, fake, _command())

    assert payload["filledPrice"] == 1925.5


def test_upgrade_is_written_back_to_the_cache(monkeypatch, engine, fast_confirm):
    """升级结果写回缓存：再重发一次直接命中 FILLED，不必再查一遍订单历史。"""
    fake = FakeMt5(history=[_order(FakeMt5.ORDER_STATE_FILLED)],
                   positions=(_position(ORDER_TICKET),))
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    _cache_failed(engine)

    _redeliver(engine, fake, _command())
    assert engine._executed["coid-1"]["status"] == "FILLED"

    queries_before = len(fake.history_queries)
    payload, _ = _redeliver(engine, fake, _command())
    assert payload["status"] == "FILLED"
    assert len(fake.history_queries) == queries_before, "已是 FILLED 就不该再查一遍"


# ---- 2. 查不到 / 仍未成交 → 照旧 FAILED ------------------------------------

def test_order_never_seen_stays_failed(monkeypatch, engine, fast_confirm):
    """订单历史里压根查不到这张单（历史没同步 / 连接有问题）→ 仍然 FAILED。"""
    fake = FakeMt5(history=None, positions=())
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    _cache_failed(engine)

    payload, _ = _redeliver(engine, fake, _command())

    assert payload["status"] == "FAILED"
    assert payload["success"] is False
    assert engine._executed["coid-1"]["status"] == "FAILED"


def test_order_still_working_stays_failed_not_rejected(monkeypatch, engine, fast_confirm):
    """单子还挂着（未到终态）→ 仍然 FAILED；刻意不改判 REJECTED（那等于请用户重下）。"""
    fake = FakeMt5(history=[_order(FakeMt5.ORDER_STATE_PLACED)], positions=())
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    _cache_failed(engine)

    payload, _ = _redeliver(engine, fake, _command())

    assert payload["status"] == "FAILED"


def test_order_explicitly_canceled_stays_failed(monkeypatch, engine, fast_confirm):
    """券商撤了这张单 = 确认没成交，但回报的仍是 FAILED 而不是 REJECTED。"""
    fake = FakeMt5(history=[_order(FakeMt5.ORDER_STATE_CANCELED)], positions=())
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    _cache_failed(engine)

    payload, _ = _redeliver(engine, fake, _command())

    assert payload["status"] == "FAILED"


# ---- 3. 无从确认的几类：照旧重报 ------------------------------------------

def test_failed_without_ticket_is_reported_as_is(monkeypatch, engine, fast_confirm):
    """order_send 直接返回 None，连订单号都没有 → 无从确认，照旧重报。"""
    fake = FakeMt5(history=[_order(FakeMt5.ORDER_STATE_FILLED)], positions=())
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    cached = _cache_failed(engine, ticket=None)

    payload, _ = _redeliver(engine, fake, _command())

    assert payload == cached
    assert fake.history_queries == [], "没有订单号时不该去查订单历史"


def test_close_is_never_upgraded_via_the_position_ticket(monkeypatch, engine, fast_confirm):
    """平仓**绝不能**拿 mt5Ticket 去确认——那是仓位号，不是订单号。

    MT5 的仓位号就是当初开仓那张单的订单号，拿它去查订单历史会查到那张早已 FILLED 的
    开仓单。若照此升级，一笔没平成的平仓会被报成「已平」而仓位还在裸奔，正是这套确认
    要防的事故。

    这条用的缓存条目**没有** `mt5OrderTicket`（老桥接写的就是这个形状），所以正确行为
    是原样重报、连订单历史都不查。平仓走正确字段时能否升级，见下面两条。
    """
    fake = FakeMt5(history=[_order(FakeMt5.ORDER_STATE_FILLED)],
                   positions=(_position(ORDER_TICKET),))
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    _cache_failed(engine)

    payload, _ = _redeliver(engine, fake, _command(action="CLOSE", ticket=ORDER_TICKET))

    assert payload["status"] == "FAILED"
    assert fake.history_queries == [], "平仓回执压根不该走订单历史确认"


def test_modify_receipt_is_never_upgraded(monkeypatch, engine, fast_confirm):
    """MODIFY 同理：TRADE_ACTION_SLTP 不产生订单，mt5Ticket 也是仓位号。"""
    fake = FakeMt5(history=[_order(FakeMt5.ORDER_STATE_FILLED)], positions=())
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    _cache_failed(engine)

    payload, _ = _redeliver(engine, fake, _command(action="MODIFY", ticket=ORDER_TICKET))

    assert payload["status"] == "FAILED"
    assert fake.history_queries == []


def test_login_not_attached_here_stays_failed(monkeypatch, engine, fast_confirm):
    """账号已经不在本机（用户换了终端）→ 没法确认，照旧重报，不报错。"""
    fake = FakeMt5(history=[_order(FakeMt5.ORDER_STATE_FILLED)], positions=())
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    _cache_failed(engine)
    engine._login_to_path = {}

    payload, _ = _redeliver(engine, fake, _command())

    assert payload["status"] == "FAILED"


def test_attach_failure_stays_failed(monkeypatch, engine, fast_confirm):
    """终端附不上（MT5 关了）→ 照旧重报 FAILED，不把「查不到」当成没成交以外的东西。"""
    fake = FakeMt5(history=[_order(FakeMt5.ORDER_STATE_FILLED)], positions=())
    fake.initialize = lambda path=None, timeout=None: False
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    _cache_failed(engine)

    payload, _ = _redeliver(engine, fake, _command())

    assert payload["status"] == "FAILED"
    assert fake.history_queries == []


# ---- 4. 非 FAILED 的缓存条目不受影响 ---------------------------------------

def test_cached_filled_is_reported_unchanged(monkeypatch, engine, fast_confirm):
    """缓存是 FILLED（或 REJECTED）时行为完全不变：原样重报，不做任何查询。"""
    fake = FakeMt5(history=[_order(FakeMt5.ORDER_STATE_FILLED)], positions=())
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    filled = {"clientOrderId": "coid-9", "success": True, "status": "FILLED",
              "mt5Ticket": ORDER_TICKET, "filledPrice": 1900.0, "login": LOGIN}
    engine._executed["coid-9"] = filled
    engine._executed_at["coid-9"] = 1.0

    payload, _ = _redeliver(engine, fake, _command(coid="coid-9"))

    assert payload == filled
    assert fake.history_queries == []


# ---- 5. 平仓走正确字段时可以升级 / closes upgrade via the right field -------

def _cache_failed_close(engine, coid="coid-1", position_ticket=555001, order_ticket=ORDER_TICKET):
    """一条 FAILED 的**平仓**回执。

    注意两个号是分开的：`mt5Ticket` 是仓位号（后端拿它匹配平仓腿），`mt5OrderTicket`
    是这张平仓单自己的订单号（1.4.2 起带上，专门给二次确认用）。
    """
    result = {
        "clientOrderId": coid,
        "success": False,
        "status": "FAILED",
        "mt5Ticket": position_ticket,
        "mt5OrderTicket": order_ticket,
        "filledPrice": None,
        "volume": 0.01,
        "message": "执行结果未确认 / outcome unconfirmed",
        "login": LOGIN,
    }
    engine._executed[coid] = result
    engine._executed_at[coid] = 1.0
    return result


def test_close_upgrades_when_its_own_order_ticket_confirms_a_fill(monkeypatch, engine, fast_confirm):
    """平仓单自己的订单号查到成交 → 升级成 FILLED。

    这条补的是最要紧的一半：平仓才是「不知道成没成」代价最大的动作（09-17 那次锁仓
    就是平仓没确认）。只要查的是平仓单**自己**的订单号，就没有把开仓单错认成平仓的风险。
    """
    fake = FakeMt5(history=[_order(FakeMt5.ORDER_STATE_FILLED)], positions=())
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    _cache_failed_close(engine)

    payload, _ = _redeliver(engine, fake, _command(action="CLOSE", ticket=555001))

    assert payload["status"] == "FILLED"
    assert fake.history_queries == [ORDER_TICKET], "查的必须是平仓单自己的订单号"
    # 缓存也要跟着升级，下一次重发不用再查一遍
    assert engine._executed["coid-1"]["status"] == "FILLED"


def test_close_stays_failed_when_its_order_did_not_fill(monkeypatch, engine, fast_confirm):
    """平仓单查到「确实没成交」→ 仍然 FAILED，绝不改判 REJECTED。"""
    fake = FakeMt5(history=[_order(FakeMt5.ORDER_STATE_REJECTED)], positions=())
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    _cache_failed_close(engine)

    payload, _ = _redeliver(engine, fake, _command(action="CLOSE", ticket=555001))

    assert payload["status"] == "FAILED"
    assert engine._executed["coid-1"]["status"] == "FAILED"


def test_close_without_an_order_ticket_is_re_reported_unchanged(monkeypatch, engine, fast_confirm):
    """`order_send` 直接返回 None 的平仓（连订单号都没有）→ 无从确认，原样重报。"""
    fake = FakeMt5(history=[_order(FakeMt5.ORDER_STATE_FILLED)], positions=())
    monkeypatch.setattr(mt5_worker, "mt5", fake)
    _cache_failed_close(engine, order_ticket=None)

    payload, _ = _redeliver(engine, fake, _command(action="CLOSE", ticket=555001))

    assert payload["status"] == "FAILED"
    assert fake.history_queries == [], "没有订单号就不该去查"
