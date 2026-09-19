"""执行结果的三态判定：FILLED / REJECTED / FAILED（2026-09-19 审计）。

原来桥接只回报 `success: bool`，而 `success` 的判据是
`retcode in (TRADE_RETCODE_DONE, TRADE_RETCODE_PLACED)`。问题出在 PLACED：它的含义是
「券商收下了这张单」，**不是**「成交了」。于是：

  · 平仓只受理未成交时也回报成功 → 网页显示「已平」而仓位还在（与 2026-09-17 那次
    锁仓同一类风险）；
  · `order_send` 返回 None / 超时这类「不知道成没成」的情况一律 success=False →
    后端落 REJECTED，而 REJECTED 在界面上的意思是「已被拒绝，可以重下」——重下就
    可能变成双倍仓位。

网关那条通道早就有 PLACED_UNCONFIRMED → FAILED（backend 的 gateway_execute），
桥接补齐到同一口径：PLACED 之后去查这张单的终态，查到成交才算 FILLED，查不到或
确认没成交都落 FAILED（不是 REJECTED）。

运行：cd bridge && python -m pytest tests

Three-state execution results. PLACED means "accepted", not "filled"; the bridge
now confirms before claiming a fill, and reports FAILED — never REJECTED — when
the outcome is unknown. See backend/app/routers/bridge.py BridgeResultRequest.
"""
import os
import sys
import types

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import mt5_worker  # noqa: E402


class FakeMt5:
    """够用的 MT5 替身：只提供本组用例碰到的常量与查询。"""

    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_PLACED = 10008
    TRADE_RETCODE_REJECT = 10006
    ORDER_STATE_FILLED = 4
    ORDER_STATE_REJECTED = 2
    ORDER_STATE_CANCELED = 3
    ORDER_STATE_EXPIRED = 6
    ORDER_STATE_PLACED = 1

    def __init__(self, history=None, positions=None):
        self._history = history
        self._positions = positions

    def history_orders_get(self, ticket=None):
        if callable(self._history):
            return self._history(ticket)
        return self._history

    def positions_get(self, ticket=None):
        if callable(self._positions):
            return self._positions(ticket)
        return self._positions


def _order(state):
    return types.SimpleNamespace(state=state)


def _result(retcode, order=777):
    return types.SimpleNamespace(retcode=retcode, order=order)


@pytest.fixture()
def fast_confirm(monkeypatch):
    """把确认的等待预算压到几乎为零，免得用例真的睡 3 秒。"""
    monkeypatch.setattr(mt5_worker, "_CONFIRM_TOTAL_SECONDS", 0.05)
    monkeypatch.setattr(mt5_worker, "_CONFIRM_INTERVAL_SECONDS", 0.01)


# ---- retcode → 三态 / retcode mapping --------------------------------------

def test_done_is_a_confirmed_fill(monkeypatch):
    monkeypatch.setattr(mt5_worker, "mt5", FakeMt5())
    status, filled = mt5_worker._result_from_retcode(_result(FakeMt5.TRADE_RETCODE_DONE))
    assert (status, filled) == ("FILLED", True)


def test_an_explicit_reject_is_rejected(monkeypatch):
    """券商明确拒绝 → REJECTED（这一类确实可以安全重下）。"""
    monkeypatch.setattr(mt5_worker, "mt5", FakeMt5())
    status, filled = mt5_worker._result_from_retcode(_result(FakeMt5.TRADE_RETCODE_REJECT))
    assert (status, filled) == ("REJECTED", False)


def test_placed_then_confirmed_filled_is_a_fill(monkeypatch, fast_confirm):
    """PLACED 之后查到订单终态是 FILLED → 才算成交。"""
    monkeypatch.setattr(mt5_worker, "mt5",
                        FakeMt5(history=[_order(FakeMt5.ORDER_STATE_FILLED)]))
    status, filled = mt5_worker._result_from_retcode(_result(FakeMt5.TRADE_RETCODE_PLACED))
    assert (status, filled) == ("FILLED", True)


def test_placed_still_working_is_failed_not_rejected(monkeypatch, fast_confirm):
    """PLACED 且一直挂着没成交 → FAILED。

    **不能是 REJECTED**：这张单还在券商队列里，重下就是第二笔。
    """
    monkeypatch.setattr(mt5_worker, "mt5",
                        FakeMt5(history=[_order(FakeMt5.ORDER_STATE_PLACED)]))
    status, filled = mt5_worker._result_from_retcode(_result(FakeMt5.TRADE_RETCODE_PLACED))
    assert status == "FAILED"
    assert filled is False


def test_placed_but_unconfirmable_is_failed(monkeypatch, fast_confirm):
    """PLACED 但历史里查不到这张单（未同步 / 连接有问题）→ FAILED。

    查不到 ≠ 没成交。分不清就必须按"可能已成交"处理。
    """
    monkeypatch.setattr(mt5_worker, "mt5", FakeMt5(history=[]))
    status, filled = mt5_worker._result_from_retcode(_result(FakeMt5.TRADE_RETCODE_PLACED))
    assert status == "FAILED"
    assert filled is False


@pytest.mark.parametrize("state", [FakeMt5.ORDER_STATE_REJECTED,
                                   FakeMt5.ORDER_STATE_CANCELED,
                                   FakeMt5.ORDER_STATE_EXPIRED])
def test_placed_then_terminal_non_fill_is_still_failed(monkeypatch, fast_confirm, state):
    """PLACED 之后确认为「确实没成交」→ 仍然是 FAILED 而不是 REJECTED。

    这里刻意不降级成 REJECTED：单子已经发出去过，中间发生了什么（部分成交后被撤？）
    不是桥接能断言的，让用户核对一眼比让他直接重下安全。
    """
    monkeypatch.setattr(mt5_worker, "mt5", FakeMt5(history=[_order(state)]))
    status, filled = mt5_worker._result_from_retcode(_result(FakeMt5.TRADE_RETCODE_PLACED))
    assert status == "FAILED"
    assert filled is False


def test_confirmation_can_be_skipped(monkeypatch):
    """confirm=False 时 PLACED 直接落 FAILED，不去查——给不适合查订单历史的路径用。"""
    monkeypatch.setattr(mt5_worker, "mt5", FakeMt5(history=[_order(FakeMt5.ORDER_STATE_FILLED)]))
    status, filled = mt5_worker._result_from_retcode(
        _result(FakeMt5.TRADE_RETCODE_PLACED), confirm=False)
    assert (status, filled) == ("FAILED", False)


def test_no_mt5_module_is_failed(monkeypatch):
    """MT5 模块都没有（源码态 / 终端没装）→ FAILED，不能假装拒单。"""
    monkeypatch.setattr(mt5_worker, "mt5", None)
    status, filled = mt5_worker._result_from_retcode(_result(10009))
    assert (status, filled) == ("FAILED", False)


# ---- 确认函数本身 / the confirmation helper --------------------------------

def test_confirm_returns_none_when_it_cannot_tell(monkeypatch, fast_confirm):
    """查不到这张单 → None（「不知道」），由调用方决定落什么。"""
    monkeypatch.setattr(mt5_worker, "mt5", FakeMt5(history=[]))
    assert mt5_worker._confirm_order_filled(123) is None


def test_confirm_survives_a_throwing_terminal(monkeypatch, fast_confirm):
    """history_orders_get 抛异常也不能把整条执行路径炸掉，只报「不知道」。"""
    def boom(_ticket):
        raise RuntimeError("terminal not responding")

    monkeypatch.setattr(mt5_worker, "mt5", FakeMt5(history=boom))
    assert mt5_worker._confirm_order_filled(123) is None


def test_confirm_needs_a_ticket(monkeypatch):
    """没有订单号就无从确认（改单路径的 result.order 是 0）。"""
    monkeypatch.setattr(mt5_worker, "mt5", FakeMt5(history=[_order(FakeMt5.ORDER_STATE_FILLED)]))
    assert mt5_worker._confirm_order_filled(0) is None


# ---- 改单的确认走另一条路 / modify confirms differently ---------------------

def test_modify_confirmation_compares_the_position_back(monkeypatch, fast_confirm):
    """改单不产生订单，确认方式是回读这个仓位的 sl/tp 对不对得上。"""
    pos = types.SimpleNamespace(sl=3300.0, tp=3400.0)
    monkeypatch.setattr(mt5_worker, "mt5", FakeMt5(positions=[pos]))
    assert mt5_worker._confirm_stops_applied(1, 3300.0, 3400.0, 2) is True


def test_modify_confirmation_fails_when_the_stops_did_not_take(monkeypatch, fast_confirm):
    pos = types.SimpleNamespace(sl=0.0, tp=0.0)
    monkeypatch.setattr(mt5_worker, "mt5", FakeMt5(positions=[pos]))
    assert mt5_worker._confirm_stops_applied(1, 3300.0, 3400.0, 2) is False


def test_modify_confirmation_tolerates_broker_rounding(monkeypatch, fast_confirm):
    """券商按品种精度取整，逐位相等的比较会假阴性，所以容差是一个最小价格单位。"""
    pos = types.SimpleNamespace(sl=3300.001, tp=3400.001)
    monkeypatch.setattr(mt5_worker, "mt5", FakeMt5(positions=[pos]))
    assert mt5_worker._confirm_stops_applied(1, 3300.0, 3400.0, 2) is True


# ---- 措辞 / wording --------------------------------------------------------

def test_unconfirmed_wording_never_says_rejected():
    """FAILED 的文案绝不能出现「拒绝 / rejected」——那是在请用户重下。"""
    msg = mt5_worker._unconfirmed_reason()
    assert "拒绝" not in msg
    assert "reject" not in msg.lower()
    assert "未确认" in msg or "unconfirmed" in msg.lower()


# ---- 查询失败 ≠ 仓位不存在 / a failed query is not an absent position --------

def test_close_treats_a_failed_query_as_unknown_not_as_already_closed(monkeypatch):
    """`positions_get` 返回 None（查询失败）不能当成「已经平掉了」。

    这是最恶劣的一种误判：终端瞬时不可用（重连中 / IPC 抖动）会让一笔**从未执行**
    的平仓被回报成 success=True「已平仓」，还被写进 24 小时幂等缓存——后端重投也
    救不回来，仓位继续开着而平台记录显示已平。

    MetaTrader5 包的约定是：查询失败给 None，查询成功但确实没有给空元组。
    """
    fake = FakeMt5(positions=None)
    fake.last_error = lambda: (-10004, "no IPC connection")
    monkeypatch.setattr(mt5_worker, "mt5", fake)

    out = mt5_worker._close_position({"clientOrderId": "c-1", "ticket": 5})

    assert out["success"] is False
    assert out["status"] == "FAILED"
    assert "positions_get failed" in out["message"]


def test_close_reports_already_closed_only_when_confirmed_absent(monkeypatch):
    """对照组：确实查到了、确实没有这个仓位 → 才是真的「已平」。"""
    monkeypatch.setattr(mt5_worker, "mt5", FakeMt5(positions=()))

    out = mt5_worker._close_position({"clientOrderId": "c-1", "ticket": 5})

    assert out["success"] is True
    assert out["message"] == "Position already closed"


# ---- 改单不许抹掉没提到的那一侧 / a modify must not wipe the other side -----

def test_modify_keeps_the_side_the_command_did_not_mention(monkeypatch, fast_confirm):
    """只发 stopLoss 的改单必须保留仓位原有的止盈。

    TRADE_ACTION_SLTP 会把两侧一起写，而 0 的语义是清除。自动仓管移动止损时正是
    只带 stopLoss，缺字段按 0 处理就会把用户的止盈静默抹掉。
    """
    sent = {}
    pos = types.SimpleNamespace(magic=mt5_worker.PRISMX_MAGIC, symbol="XAUUSD",
                                sl=3300.0, tp=3500.0)

    fake = FakeMt5(positions=[pos])
    fake.symbol_info = lambda s: types.SimpleNamespace(digits=2)
    fake.TRADE_ACTION_SLTP = 6

    def order_send(req):
        sent.update(req)
        return _result(FakeMt5.TRADE_RETCODE_DONE)

    fake.order_send = order_send
    monkeypatch.setattr(mt5_worker, "mt5", fake)

    mt5_worker._modify_position({"clientOrderId": "c-1", "ticket": 5, "stopLoss": 3350.0})

    assert sent["sl"] == 3350.0, "止损应按指令更新"
    assert sent["tp"] == 3500.0, "指令没提止盈，必须保留原值而不是清成 0"


def test_modify_still_clears_a_side_when_zero_is_explicit(monkeypatch, fast_confirm):
    """显式传 0 仍然表示清除——区别只在于「没说」和「说了 0」不再是一回事。"""
    sent = {}
    pos = types.SimpleNamespace(magic=mt5_worker.PRISMX_MAGIC, symbol="XAUUSD",
                                sl=3300.0, tp=3500.0)
    fake = FakeMt5(positions=[pos])
    fake.symbol_info = lambda s: types.SimpleNamespace(digits=2)
    fake.TRADE_ACTION_SLTP = 6
    fake.order_send = lambda req: (sent.update(req), _result(FakeMt5.TRADE_RETCODE_DONE))[1]
    monkeypatch.setattr(mt5_worker, "mt5", fake)

    mt5_worker._modify_position(
        {"clientOrderId": "c-1", "ticket": 5, "stopLoss": 3350.0, "takeProfit": 0})

    assert sent["tp"] == 0.0


# ---- 开仓必须有正手数 / an open needs a positive volume ---------------------

def test_open_without_a_volume_is_rejected():
    """缺 volume 或 volume=0 的开仓指令必须被拒。

    不拦的话 `_normalize_volume` 会把 0 抬成该品种的最小手数——后端一个字段名写错
    就会在用户账户上开出一笔真实仓位。开仓不能有"默认手数"。
    """
    for cmd in (
        {"clientOrderId": "c-1", "action": "ORDER", "side": "BUY", "symbol": "XAUUSD"},
        {"clientOrderId": "c-1", "action": "ORDER", "side": "BUY", "symbol": "XAUUSD", "volume": 0},
    ):
        ok, err = mt5_worker._validate_command(cmd)
        assert ok is False, f"{cmd} 应当被拒"
        assert "volume" in err


def test_open_with_a_positive_volume_passes_validation():
    ok, _ = mt5_worker._validate_command(
        {"clientOrderId": "c-1", "action": "ORDER", "side": "BUY",
         "symbol": "XAUUSD", "volume": 0.01})
    assert ok is True


def test_close_and_modify_do_not_require_a_volume():
    """平仓省略 volume 表示全平，改单本来就没有手数——不能被开仓那条规则误伤。"""
    for action in ("CLOSE", "MODIFY"):
        ok, err = mt5_worker._validate_command(
            {"clientOrderId": "c-1", "action": action, "ticket": 5})
        assert ok is True, f"{action}: {err}"


# ---- 手数规整用直觉上的四舍五入 / lot rounding matches user expectation -----

def test_volume_rounding_is_not_bankers_rounding(monkeypatch):
    """0.025 在 0.01 步长下应得 0.03，而不是 Python round() 的 0.02。"""
    fake = FakeMt5()
    fake.symbol_info = lambda s: types.SimpleNamespace(
        volume_step=0.01, volume_min=0.01, volume_max=100.0)
    monkeypatch.setattr(mt5_worker, "mt5", fake)

    assert mt5_worker._normalize_volume("XAUUSD", 0.025) == 0.03


# ---- 滑点容忍度按品种折算 / slippage scaled per instrument ------------------

def test_deviation_matches_the_old_constant_on_fx(monkeypatch):
    """欧美上算出来应当≈原来写死的 20，确保这次改动不动既有行为。"""
    fake = FakeMt5()
    fake.symbol_info = lambda s: types.SimpleNamespace(point=0.00001)
    monkeypatch.setattr(mt5_worker, "mt5", fake)

    assert 18 <= mt5_worker._deviation_points("EURUSD", 1.08) <= 24


def test_deviation_is_wider_on_gold_than_the_old_constant(monkeypatch):
    """黄金按写死的 20 point 只有 0.20 美元，比点差还紧，行情快时会一路被拒。

    改成按价格比例折算后应当明显宽于 20 point。
    """
    fake = FakeMt5()
    fake.symbol_info = lambda s: types.SimpleNamespace(point=0.01)
    monkeypatch.setattr(mt5_worker, "mt5", fake)

    assert mt5_worker._deviation_points("XAUUSD", 3350.0) > 20


def test_deviation_falls_back_when_precision_is_unknown(monkeypatch):
    """拿不到品种精度时退回原来的固定值，不能返回 0（0 = 不允许任何滑点）。"""
    fake = FakeMt5()
    fake.symbol_info = lambda s: None
    monkeypatch.setattr(mt5_worker, "mt5", fake)

    assert mt5_worker._deviation_points("XAUUSD", 3350.0) == 20


def test_deviation_is_bounded(monkeypatch):
    """极端价格也要落在上下界内，避免算出一个荒唐的容忍度。"""
    fake = FakeMt5()
    fake.symbol_info = lambda s: types.SimpleNamespace(point=0.01)
    monkeypatch.setattr(mt5_worker, "mt5", fake)

    assert mt5_worker._deviation_points("BTCUSD", 2_000_000.0) <= 300
    assert mt5_worker._deviation_points("TINY", 0.0001) >= 10


# ---- 成交模式降级重试 / filling-mode fallback ------------------------------

def test_alternate_filling_picks_a_supported_other_mode(monkeypatch):
    """券商只支持 FOK 时，IOC 被拒后应当能换到 FOK。"""
    fake = FakeMt5()
    fake.SYMBOL_FILLING_FOK = 1
    fake.SYMBOL_FILLING_IOC = 2
    fake.ORDER_FILLING_FOK = 100
    fake.ORDER_FILLING_IOC = 101
    fake.symbol_info = lambda s: types.SimpleNamespace(filling_mode=1)  # 只有 FOK
    monkeypatch.setattr(mt5_worker, "mt5", fake)

    assert mt5_worker._alternate_filling("XAUUSD", 101) == 100


def test_alternate_filling_returns_none_when_there_is_no_other_option(monkeypatch):
    """只支持当前这一种时不要瞎换——换了也是白发一次。"""
    fake = FakeMt5()
    fake.SYMBOL_FILLING_FOK = 1
    fake.SYMBOL_FILLING_IOC = 2
    fake.ORDER_FILLING_FOK = 100
    fake.ORDER_FILLING_IOC = 101
    fake.symbol_info = lambda s: types.SimpleNamespace(filling_mode=2)  # 只有 IOC
    monkeypatch.setattr(mt5_worker, "mt5", fake)

    assert mt5_worker._alternate_filling("XAUUSD", 101) is None
