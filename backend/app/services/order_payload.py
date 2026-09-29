"""订单的对外形状与状态语义：OrderOut 序列化、ORDER_UPDATE 推送载荷、PENDING
超时判定，以及「哪些订单在券商那边真开出了仓位」这条共用判据。

从 routers/orders.py 搬出来（2026-09-06）：这些不依赖任何路由，而 services/
gateway_execute.py 与 routers/bridge.py 都要用——服务层不该反过来 import 路由模块。
Order presentation helpers, moved out of routers/orders.py so the service layer
(gateway_execute) and the bridge router can use them without importing a router.
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, or_

from app.core.config import settings
from app.models import Order
from app.schemas import OrderOut


# 一条订单「在券商那边开出了（或即将开出）一个仓位」的两种形状：
#
#   (ORDER,   FILLED)  市价单已成交——仓位现在就在。
#   (PENDING, PLACED)  挂单已挂在券商服务器上——触发的那一刻仓位就诞生，而
#                      MT5 里这个仓位的编号**就是这张挂单的票号**，所以下单时
#                      记下的 mt5_position 在触发之后依然对得上。
#
# 为什么必须并成一条判据：平仓明细的归属、个人胜率的开仓腿，全都按「本平台开过
# 的仓位号」去匹配。只认 (ORDER, FILLED) 的话，挂单触发出来的那笔仓位在平仓时
# 认不出是自己人——轻则退化成按 comment 前缀猜（verified=False），重则整条平仓
# 记录被丢弃，那笔交易的盈亏凭空消失。
#
# 反过来，一张**从未触发**的挂单混进来是无害的：它既没有平仓明细、也不会被报为
# 持仓，compute_personal_winrate 的最后一个分支会把它整笔剔除（不计胜负、不计
# 进行中）。宁可多带上它，也不能漏掉已经触发的那些。
#
# The two shapes of an order that has (or is about to have) a real position at the
# broker. A pending order counts because in MT5 the position it opens carries the
# pending order's own ticket, so the mt5_position recorded at placement still
# matches after it triggers. Attribution of closed legs and personal win-rate both
# key on "position ids this platform opened"; matching only (ORDER, FILLED) makes a
# triggered pending order's close unrecognisable — at best downgraded to a
# comment-prefix guess, at worst dropped entirely, losing that trade's P&L. A
# never-triggered pending order coming along is harmless: with no close legs and
# never reported open, compute_personal_winrate drops it from every count.
OPENED_POSITION = or_(
    and_(Order.action == "ORDER", Order.status == "FILLED"),
    and_(Order.action == "PENDING", Order.status == "PLACED"),
)


# 超时作废的统一提示文案 / message stamped on voided stale orders
STALE_ORDER_MESSAGE = (
    "指令超时未执行，已自动取消。如已开启桥接请重新下单"
    " / Command timed out before execution and was cancelled automatically."
    " Re-place the order once the bridge is online."
)


def serialize_order(o: Order) -> OrderOut:
    return OrderOut(
        id=o.id,
        clientOrderId=o.client_order_id,
        signalId=o.signal_id,
        action=o.action or "ORDER",
        symbol=o.symbol,
        side=o.side,
        volume=o.volume,
        ticket=o.ticket,
        mt5Login=o.mt5_login,
        status=o.status,
        mt5Ticket=o.mt5_ticket,
        filledPrice=o.filled_price,
        price=o.price,
        pendingType=o.pending_type,
        message=o.message,
        createdAt=o.created_at,
        updatedAt=o.updated_at,
    )


def order_update_payload(o: Order) -> dict:
    """构造前端 ORDER_UPDATE 推送载荷 / build the ORDER_UPDATE push payload."""
    return {
        "type": "ORDER_UPDATE",
        "data": serialize_order(o).model_dump(mode="json"),
    }


def is_stale_pending(o: Order, now: datetime | None = None) -> bool:
    """判断一条 PENDING 订单是否已超时 / whether a PENDING order timed out."""
    if o.status != "PENDING" or o.created_at is None:
        return False
    now = now or datetime.now(timezone.utc)
    created = o.created_at
    if created.tzinfo is None:
        created = created.replace(tzinfo=timezone.utc)
    return created < now - timedelta(seconds=settings.ORDER_PENDING_TIMEOUT_SECONDS)


# 网关通道的超时提示：网关单在后端进程里同步下发，PENDING 卡住多半是后端重启/被截断，
# 请求其实可能已经发到网关甚至已经成交。此时说「已自动取消，请重新下单」是错误引导
# （照做就是重复仓），必须改成「结果未知，先核对持仓」。状态仍是 FAILED——本代码库里
# FAILED 的语义正是「不知道成没成」（与 _UNKNOWN_OUTCOME_ERRORS 分支一致），不是自动取消。
# Gateway-channel timeout wording: a gateway order is sent from inside the backend
# process, so a stuck PENDING usually means a restart cut it short — the request may
# well have reached the gateway and filled. "Cancelled, please re-place" would invite
# a duplicate position; say "outcome unknown, verify first". Status stays FAILED, which
# in this codebase means "we don't know" (same as the _UNKNOWN_OUTCOME_ERRORS branch).
GATEWAY_STALE_ORDER_MESSAGE = (
    "结果未知：这笔指令长时间没有收到执行结果（可能是服务重启期间被中断），券商那边可能已经"
    "执行。请先在 MT5 核对持仓，确认没有成交后再决定是否重下"
    " / Outcome unknown: no execution result was received (the service may have restarted"
    " mid-request) and the order may already have executed. Check your MT5 positions"
    " before deciding to retry."
)


def void_stale_order(o: Order, gateway: bool = False) -> None:
    """把超时订单置为 FAILED（不提交事务）/ mark a stale order FAILED (no commit).

    gateway=True：网关通道的单，文案改成「结果未知，先核对持仓」，不误导用户重下。
    gateway=True: a gateway-channel order; uses the outcome-unknown wording."""
    o.status = "FAILED"
    o.message = GATEWAY_STALE_ORDER_MESSAGE if gateway else STALE_ORDER_MESSAGE


# 下单来源标签，写进券商单子的备注（comment）：跟信号 = SIG，个人策略 = STRAT，图表手动 = CHART。
# 判据：有 signal_id = SIG；订单 source=STRATEGY（个人策略信号）= STRAT；其余 = CHART。
# 备注仍以 PRISMX 开头（如 "PRISMX-SIG"），按前缀判归属的逻辑不受影响。
# Order-source tag written into the broker comment: SIG for signal copy-trades,
# CHART for manual chart orders. Keyed on signal_id; comments still start with
# PRISMX so prefix-based attribution is unaffected.
SOURCE_TAG_SIGNAL = "SIG"
SOURCE_TAG_CHART = "CHART"
# 个人策略信号（订单 source=STRATEGY）/ personal strategy signals
SOURCE_TAG_STRATEGY = "STRAT"


def order_source_tag(o) -> str:
    if getattr(o, "signal_id", None):
        return SOURCE_TAG_SIGNAL
    if getattr(o, "source", None) == "STRATEGY":
        return SOURCE_TAG_STRATEGY
    return SOURCE_TAG_CHART
