"""给用户看的品种名不带券商后缀（2026-11-16 体验报告 L5）。

平仓 / 改单 / 自动仓管的指令行存的是持仓上的 MT5 品种名（XAUUSD.s），开仓行存的是图表
上不带后缀的名字。推送标题原来直接用存的名字，同一笔交易前后两个叫法。这里钉住：显示
时去后缀；存进库、发往券商的名字一个字符都不动。

User-facing symbol names carry no broker suffix (QA report L5). Close / modify /
auto-management rows store the position's MT5 name while open rows store the chart's
bare name; push titles used the stored name as is. Display drops the suffix; what is
stored and sent to the broker is untouched.
"""
import pytest

from app.models import Order
from app.routers import bridge
from app.services.symbol_aliases import display_symbol


@pytest.mark.parametrize("raw,shown", [
    ("XAUUSD.s", "XAUUSD"),
    ("XAUUSD.p", "XAUUSD"),
    ("XAUUSD", "XAUUSD"),
    ("EURUSD_r", "EURUSD"),
    ("US30-cash", "US30"),
    ("BTCUSD#", "BTCUSD"),
    (" XAUUSD.s ", "XAUUSD"),
    # 只去后缀、不改名：信号侧的 BTCUSDT 还是 BTCUSDT / suffix only, no renames
    ("BTCUSDT", "BTCUSDT"),
    ("USOIL.s", "USOIL"),
    # 以分隔符开头的名字切完是空的，原样返回 / a leading separator would strip to nothing
    ("#AAPL", "#AAPL"),
    ("", ""),
    (None, ""),
])
def test_display_symbol(raw, shown):
    assert display_symbol(raw) == shown


def _order(status: str, symbol: str = "XAUUSD.s", **kw) -> Order:
    return Order(
        user_id="u1", client_order_id="co_1", action=kw.pop("action", "CLOSE"), symbol=symbol,
        side="BUY", volume=0.01, status=status, **kw,
    )


@pytest.mark.parametrize("status,head", [
    ("FILLED", "订单已成交 XAUUSD"),
    ("PLACED", "挂单已挂出 XAUUSD"),
    ("FAILED", "执行结果未确认 XAUUSD"),
    ("REJECTED", "订单被拒绝 XAUUSD"),
])
def test_push_titles_show_the_symbol_without_the_broker_suffix(status, head):
    order = _order(status, filled_price=3865.1, price=3800.0, message="x")
    args = bridge._result_push_args(order)
    assert args is not None and args[1] == head
    # 订单行自己的品种名没有被改 / the stored name is untouched
    assert order.symbol == "XAUUSD.s"


def test_push_title_for_an_open_is_unchanged():
    args = bridge._result_push_args(_order("FILLED", symbol="XAUUSD", action="ORDER", filled_price=3865.1))
    assert args is not None and args[1] == "订单已成交 XAUUSD"
