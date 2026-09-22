"""图表页挂单（限价 / 止损）：请求校验、状态机、以及归属判据。

为什么这三块值得钉住：

1. **请求校验**——`orderType` 与 `price` 必须成对出现。缺价的挂单落库后是一条永远
   执行不了的指令（网关直接拒、桥接按 0 发出去），而给市价单带价说明调用方以为
   自己在挂单，放过去会**立刻成交**，与意图正好相反。两个方向都不会报错，只会
   得到另一件事。

2. **状态机**——挂单成功的终态是 `PLACED`，不是 `FILLED`。借用 FILLED 会让一张可能
   永远不触发的挂单立刻被算成一笔完成的交易（胜率、勋章、竞赛、管理端统计全部按
   FILLED 数）；留在 PENDING 则会被 5 分钟的 stale 清扫判成超时作废，而券商那边的
   单还好端端挂着。两种错法都不抛异常。

3. **归属判据**——`OPENED_POSITION` 必须同时认 (ORDER, FILLED) 与 (PENDING, PLACED)。
   MT5 里挂单触发后生成的仓位沿用挂单的票号，所以只认前者的话，挂单触发出来的那笔
   仓位在平仓时认不出是自己人，平仓明细轻则退化成按 comment 猜、重则整条丢掉。

Pending orders from the charts page: request validation, the state machine, and the
attribution predicate. All three failure modes are silent — see each block.
"""
from datetime import datetime, timezone

import pytest
from pydantic import ValidationError

from app.models import Order, User
from app.schemas import OrderRequest
from app.services.gateway_client import TradeRsp
from app.services.gateway_execute import _failure_message, apply_trade_result
from app.services.order_payload import OPENED_POSITION, serialize_order
from app.services.pending_orders import PENDING_TYPE_NAMES, pending_row


# ---- 1. 请求校验 / request validation ---------------------------------------

def test_market_order_needs_no_price_and_stays_the_default():
    """不带 orderType 的请求必须仍然是市价单——这个字段加上之前的所有调用方都这样发。"""
    req = OrderRequest(symbol="XAUUSD", side="BUY", volume=0.01, clientOrderId="c1")

    assert req.orderType == "MARKET"
    assert req.price is None


def test_pending_order_without_price_is_refused():
    # 放过去的结果是一条永远执行不了的指令：网关拒、桥接按 0 发，用户只看到
    # 「指令超时未执行」，完全看不出是自己漏填了价。
    with pytest.raises(ValidationError):
        OrderRequest(symbol="XAUUSD", side="BUY", volume=0.01, clientOrderId="c1",
                     orderType="LIMIT")


def test_market_order_carrying_a_price_is_refused():
    # 这条比上一条更要紧：带价说明调用方以为自己在挂单，而市价单会**立刻成交**。
    # 静默接受等于用一笔即时开仓替换掉用户要的「到价再买」。
    with pytest.raises(ValidationError):
        OrderRequest(symbol="XAUUSD", side="BUY", volume=0.01, clientOrderId="c1",
                     price=3300.0)


def test_pending_order_with_price_is_accepted():
    req = OrderRequest(symbol="XAUUSD", side="SELL", volume=0.02, clientOrderId="c1",
                       orderType="STOP", price=3290.5)

    assert (req.orderType, req.price) == ("STOP", 3290.5)


# ---- 2. 状态机 / the state machine -------------------------------------------

def _pending_order() -> Order:
    return Order(user_id="u1", client_order_id="c1", action="PENDING",
                 pending_type="BUY_LIMIT", symbol="XAUUSD", side="BUY",
                 volume=0.01, price=3290.0, status="PENDING")


def test_placed_pending_order_is_PLACED_not_FILLED():
    order = _pending_order()

    apply_trade_result(order, TradeRsp(ok=True, retcode="MT_RET_REQUEST_DONE", message="",
                                       deal=0, order=555, price=0.0))

    assert order.status == "PLACED", (
        "挂单还没成交。记成 FILLED 会让它立刻被算进胜率 / 勋章 / 竞赛，"
        "而它可能永远不触发"
    )
    assert order.status != "PENDING", (
        "留在 PENDING 会被 5 分钟的 stale 清扫作废，而券商那边的单还挂着"
    )


def test_placed_pending_order_records_its_ticket_as_the_position_id():
    """MT5 里挂单触发后生成的仓位沿用挂单票号，所以现在就能把 mt5_position 记下来。

    不记的话，等它成交再平仓时，平仓明细只能退回按 comment 前缀猜归属
    （verified=False），而那条依据在 TP/SL 触发的平仓上根本不带前缀。
    """
    order = _pending_order()

    apply_trade_result(order, TradeRsp(ok=True, retcode="MT_RET_REQUEST_DONE", message="",
                                       deal=0, order=777, price=0.0))

    assert order.mt5_ticket == 777
    assert order.mt5_position == 777


def test_market_order_still_lands_as_FILLED():
    """市价单这条路不能被挂单分支带偏——同一个函数服务两种指令。"""
    order = Order(user_id="u1", client_order_id="c2", action="ORDER", symbol="XAUUSD",
                  side="BUY", volume=0.01, status="PENDING")

    apply_trade_result(order, TradeRsp(ok=True, retcode="MT_RET_REQUEST_DONE", message="",
                                       deal=9, order=10, price=3300.0, position=10))

    assert order.status == "FILLED"
    assert order.filled_price == 3300.0


def test_serialized_order_keeps_trigger_price_and_type_apart_from_fill_price():
    """price（挂在哪）与 filledPrice（成交在哪）是两列，触发之后两者同时有值且不等。"""
    order = _pending_order()
    order.id = "o1"
    order.created_at = order.updated_at = datetime.now(timezone.utc)
    order.filled_price = 3289.6
    order.status = "PLACED"

    out = serialize_order(order)

    assert (out.price, out.filledPrice) == (3290.0, 3289.6)
    assert out.pendingType == "BUY_LIMIT"


# ---- 3. 归属判据 / the attribution predicate ---------------------------------

@pytest.mark.parametrize(
    "action,status,expected",
    [
        ("ORDER", "FILLED", True),
        ("PENDING", "PLACED", True),
        # 挂单指令还没执行：券商那边什么都没有，不该被当成开过仓。
        ("PENDING", "PENDING", False),
        # 被拒的挂单同理。
        ("PENDING", "REJECTED", False),
        # 平仓 / 改单指令成功也不是开仓腿。
        ("CLOSE", "FILLED", False),
        ("MODIFY", "FILLED", False),
    ],
)
def test_opened_position_predicate(db_session, action, status, expected):
    """OPENED_POSITION 是平仓归属与个人胜率共用的那一条判据，逐种形状钉住。"""
    db_session.add(User(id="u1", email="u1@example.com", api_token="tok_u1"))
    db_session.add(Order(user_id="u1", client_order_id=f"c-{action}-{status}",
                         action=action, status=status, symbol="XAUUSD", side="BUY",
                         volume=0.01, mt5_position=1234))
    db_session.commit()

    found = db_session.query(Order).filter(OPENED_POSITION).all()

    assert bool(found) is expected


# ---- 4. 两条通道的挂单形状必须一致 / one shape from both channels -------------

def test_gateway_pending_row_matches_the_bridge_payload_shape():
    """网关侧翻译出来的行，键名必须与 mt5_worker._pending_orders_payload 一字不差。

    PENDING_ORDERS 是整表替换：两条通道形状一旦分叉，同一张表里就会出现读不出
    触发价的行，而前端不会报错——只会显示成空。
    """
    row = pending_row(ticket=1, symbol="XAUUSD", type_name="SELL_STOP", volume=0.1,
                      price=3280.0, stop_loss=3300.0, take_profit=3200.0, login="500123")

    assert set(row) == {
        "ticket", "symbol", "type", "side", "volume", "price",
        "stopLoss", "takeProfit", "login",
    }
    assert row["side"] == "SELL", "side 由类型名推出，不该另外传一份可能对不上的方向"


def test_pending_type_names_cover_exactly_the_four_pending_types():
    """市价买卖（0/1）不能在表里：它们不会出现在未成交挂单中，混进来就是猜方向。"""
    assert set(PENDING_TYPE_NAMES.values()) == {
        "BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP",
    }
    assert 0 not in PENDING_TYPE_NAMES and 1 not in PENDING_TYPE_NAMES


# ---- 5. 网关版本落后时的措辞 / wording when the gateway build lags ------------
#
# 网关是手动拷 .cs 重新编译部署的，不跟着 main 自动走，所以「后端已上线、网关还没
# 编译」是**必然出现**的一段窗口，不是异常。用户在这段时间里点挂单，看到的那句话
# 是这个产品对他唯一的交代。

def test_unknown_endpoint_reads_as_a_version_gap_not_as_raw_gateway_text():
    """旧网关回的 404 不能原样透出来。

    网关对没见过的路径回 `{"ok": false, "error": "not_found", "message": "未知接口:/trade/pending"}`，
    body 里没有 retcode。照旧拼法会得到一句以冒号开头的 `": 未知接口:/trade/pending"`——
    用户既看不懂那是什么，也做不了任何事。
    """
    order = _pending_order()

    apply_trade_result(order, TradeRsp(ok=False, retcode="", message="未知接口:/trade/pending",
                                       deal=0, order=0, price=0.0, error="not_found"))

    assert order.status == "REJECTED", (
        "请求连端点都没命中，可以确定什么都没执行——这正是 REJECTED（可以安全重下）的含义；"
        "记成 FAILED 会让界面叫用户去 MT5 核对一张根本不存在的挂单"
    )
    assert "未知接口" not in order.message
    assert not order.message.startswith(":")
    assert "网关" in order.message and "未发出" in order.message


def test_failure_message_never_starts_with_a_stray_colon():
    """网关的 WriteError 那几条路径（401 / 403 / 404）body 里都没有 retcode。"""
    assert _failure_message(
        TradeRsp(ok=False, retcode="", message="组不在白名单", deal=0, order=0, price=0.0)
    ) == "组不在白名单"
    # 两者都有时仍按老格式拼，运维 grep 日志的习惯不变。
    assert _failure_message(
        TradeRsp(ok=False, retcode="MT_RET_REQUEST_INVALID_PRICE", message="买入限价必须低于当前卖价",
                 deal=0, order=0, price=0.0)
    ) == "MT_RET_REQUEST_INVALID_PRICE: 买入限价必须低于当前卖价"
    # 只有返回码、没有文案时也不能拖一个尾巴冒号。
    assert _failure_message(
        TradeRsp(ok=False, retcode="MT_RET_ERR_NOTFOUND", message="", deal=0, order=0, price=0.0)
    ) == "MT_RET_ERR_NOTFOUND"
