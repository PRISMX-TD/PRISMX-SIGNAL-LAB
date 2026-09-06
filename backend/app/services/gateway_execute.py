"""通过 gateway 直连执行一条订单指令（开仓 / 平仓 / 改单）。

从 routers/orders.py 搬出来（2026-09-06）：下单路由与自动仓管（services/auto_manage.py）
都要走这一段，而服务层反过来 import 路由模块是最后一处反向依赖——改路由时会静默
弄坏自动仓管，且测试得把整个路由层拖进来。路由模块现在只是这里的调用方。
公开名不带下划线；routers/orders.py 里保留 `_try_gateway_execute` 等旧名别名。

Executes one order command over the gateway HTTP API. Moved out of
routers/orders.py so services (auto-manage) stop importing a router module.
"""
import logging

from sqlalchemy.orm import Session

from app.models import MT5Account, Order
from app.services.gateway_binding import is_revoked
from app.services.gateway_client import (
    TradeRsp,
    run_on_main_loop,
    trade_close as gw_close,
    trade_modify as gw_modify,
    trade_open as gw_open,
)
from app.services.order_payload import order_update_payload
from app.services.symbol_aliases import broker_symbol

# 日志名沿用 prismx.orders：运维按它 grep 网关执行日志，搬文件不该改日志面貌。
# Keeps the prismx.orders logger name so existing log greps still match.
logger = logging.getLogger("prismx.orders")


def gateway_account(db: Session, mt5_login: str | None, user_id: str | None = None) -> MT5Account | None:
    """取目标 MT5 账号的 gateway 绑定行；不是 gateway 账号返回 None。

    以前这里是个只回 bool 的 _is_gateway_account。改成返回整行，是因为调用方
    现在还要看这条绑定有没有被撤销——只回 bool 就得再查一次同一行。
    This used to be a bool-only _is_gateway_account; callers now also need to
    know whether the binding was revoked, which a bool would cost a second query.

    必须带 user_id：唯一约束是 (user_id, login, server)，两个用户可以绑同一个
    登录号（各自验证过主密码）。只按 login 查会随机拿到别人的那一行，用别人的
    撤销状态和来源来判断自己的单——下单本身仍打本人账号（前面已校验归属），
    但判定依据错行。user_id 传 None 只为兼容旧调用，新代码一律传。
    Must scope by user_id: the unique key is (user_id, login, server), so two
    users may hold the same login. Filtering on login alone picks an arbitrary
    row and judges this order by someone else's revocation state and source.
    """
    if not mt5_login:
        return None
    q = db.query(MT5Account).filter(MT5Account.login == mt5_login)
    if user_id is not None:
        q = q.filter(MT5Account.user_id == user_id)
    acc = q.first()
    if acc is None or acc.source != "gateway":
        return None
    return acc


def apply_trade_result(order: Order, rsp: TradeRsp) -> None:
    """根据 gateway 回执更新订单状态。"""
    if rsp.ok:
        order.status = "FILLED"
        order.mt5_ticket = rsp.order if rsp.order else rsp.deal
        # 仓位号单独存。mt5_ticket 是订单号/成交号，与仓位号不同源，平仓明细的
        # 归属判定只能用这个。旧版 gateway 不返回时为 0，按空处理。
        # Store the position id separately: mt5_ticket is an order/deal ticket
        # from a different numbering space, and closed-trade attribution needs
        # this one. Older gateways send 0, treated as absent.
        if rsp.position:
            order.mt5_position = rsp.position
        order.filled_price = rsp.price or None
        order.message = ""
    elif rsp.error == "timeout":
        # 网关没回话不等于拒绝：这笔可能已经执行（见 call_gateway_idempotent）。
        # 落 FAILED 而不是 REJECTED，界面文案据此提示"先核对持仓"。
        # No answer is not a rejection — the order may have executed. FAILED, not
        # REJECTED, so the UI says "check your positions" rather than "declined".
        order.status = "FAILED"
        order.message = rsp.retcode + (": " + rsp.message if rsp.message else "")
    else:
        order.status = "REJECTED"
        order.message = rsp.retcode + (": " + rsp.message if rsp.message else "")


# 一次网关交易调用的时限（秒）。dealer 回执最长 60 秒（gateway.ini 的
# dealer_timeout_ms），再留 5 秒给网络。
# One gateway trade call's budget: the dealer wait is up to 60s, plus 5s for the wire.
GATEWAY_TRADE_TIMEOUT = 65.0
# 超时后用同一 clientOrderId 再问一次的时限：网关那边若仍在等 dealer，会等到
# dealer 超时 + 5 秒才回，这里要比它长。
# Budget for the follow-up ask: the gateway may hold the call for dealer timeout + 5s.
GATEWAY_RECONCILE_TIMEOUT = 75.0


def call_gateway_idempotent(order: Order, make_call) -> TradeRsp:
    """带"超时再问一次"的网关交易调用。

    **为什么**：网关等 dealer 回执最长 60 秒，一旦这边超时，那笔单可能已经成交。
    以前直接落 REJECTED/FAILED，用户看到"失败"就重下，真仓里就多一笔（2026-08-11
    的事故是同一类）。现在网关按 clientOrderId 做了幂等缓存，超时后拿**同一个**
    clientOrderId 再问一次：已执行 → 拿到缓存结果；仍在执行 → 网关等它完成再回；
    还是等不到 → 落 FAILED，且提示先核对持仓再重下。第二问不会造成第二笔成交。

    `make_call(timeout)` 返回一个协程；本函数在线程池里，经 run_on_main_loop 提交。
    Gateway trade call with one follow-up on timeout. The dealer wait can take
    60s; after a timeout the order may already be filled, and marking it
    REJECTED made users re-place it. With the gateway's clientOrderId cache the
    follow-up returns the cached result (or waits for the in-flight one) instead
    of executing again. Still unknown after that → FAILED with a "check your
    positions first" message.
    """
    def _once(timeout: float) -> TradeRsp:
        try:
            return run_on_main_loop(make_call(timeout), timeout=timeout + 5.0)
        except TimeoutError:
            return TradeRsp(ok=False, retcode="", message="Gateway 响应超时",
                            deal=0, order=0, price=0.0, error="timeout")

    rsp = _once(GATEWAY_TRADE_TIMEOUT)
    if rsp.error != "timeout" and rsp.retcode != "IN_PROGRESS":
        return rsp
    logger.warning(
        "Gateway %s %s 超时/仍在执行，用同一 clientOrderId 再问一次",
        order.action, order.client_order_id,
    )
    again = _once(GATEWAY_RECONCILE_TIMEOUT)
    if again.error == "timeout" or again.retcode == "IN_PROGRESS":
        return TradeRsp(
            ok=False, retcode="GATEWAY_TIMEOUT",
            message=(
                "网关两次未在时限内回话，这笔指令可能已经执行，请先核对持仓再重下 / "
                "gateway timed out twice; the order may have executed, check positions before retrying"
            ),
            deal=0, order=0, price=0.0, error="timeout",
        )
    if again.replayed:
        logger.info("Gateway %s %s 第二问拿到缓存结果 -> ok=%s %s",
                    order.action, order.client_order_id, again.ok, again.retcode)
    return again


def try_gateway_execute(db: Session, order: Order) -> dict | None:
    """如果是 gateway 来源账号，立即通过 gateway HTTP 执行订单。
    返回 ORDER_UPDATE 推送载荷，或 None（非 gateway 账号）。

    If the target account is gateway-sourced (Make Capital), execute the order
    immediately via the gateway HTTP API. Returns an ORDER_UPDATE push payload,
    or None for non-gateway accounts.
    """
    account = gateway_account(db, order.mt5_login, order.user_id)
    if account is None:
        return None

    # 绑定已撤销：券商侧的密码变了，用户当初授权的那次验证已经作废。这里是
    # 资金安全的最后一道闸，与 is_account_online 的"判离线"是两回事——离线只
    # 影响界面与路由，而自动仓管、策略自动下单都可能带着明确的 mt5Login 直接
    # 走到这里，必须在真正调 gateway 之前显式拒掉。
    #
    # 落成 REJECTED 而不是抛异常：调用方（含 auto_manage）本来就按订单状态
    # 处理结果，抛异常会让自动仓管那一批里的其它指令一起受影响。
    #
    # The revoked binding is the money-safety backstop. Reading as offline only
    # affects the UI and routing, while auto-management and strategy automation
    # can reach here with an explicit mt5Login, so this must refuse before any
    # gateway call. Recorded as REJECTED rather than raised: callers already
    # branch on order status, and raising would disrupt sibling commands in the
    # same auto-manage batch.
    if is_revoked(account):
        order.status = "REJECTED"
        order.message = (
            "账号连接已失效（密码已变更），请重新验证 / "
            "account link revoked (password changed), please verify again"
        )
        db.commit()
        db.refresh(order)
        logger.warning(
            "Gateway 下单被拒（绑定已撤销）: %s %s mt5=%s",
            order.action, order.client_order_id, order.mt5_login,
        )
        return order_update_payload(order)

    login = int(order.mt5_login)

    try:
        if order.action == "ORDER":
            # 发给 gateway 的是券商基础名：order.symbol 存的是信号侧写法
            # （比特币是 BTCUSDT），而 gateway 的 ResolveSymbol 只会按前缀去补
            # 账号组后缀，BTCUSDT 在券商品种表里没有任何前缀匹配，于是原样发
            # 出去、必然被拒。后缀仍由 gateway 按账号组解析，这里只收敛名字。
            # Send the broker base name: order.symbol holds the signal-side
            # spelling (Bitcoin is BTCUSDT), and the gateway's ResolveSymbol
            # only appends a group suffix to a prefix match — BTCUSDT matches
            # nothing in the broker's table, so it went out as-is and was
            # always rejected. The suffix still comes from the gateway's own
            # per-group resolution; only the name is collapsed here.
            rsp = call_gateway_idempotent(order, lambda timeout: gw_open(
                login, broker_symbol(order.symbol),
                order.side or "BUY", order.volume or 0.01,
                order.sl or 0, order.tp or 0,
                order.client_order_id or "",
                client_order_id=order.client_order_id or "",
                timeout=timeout,
            ))
        elif order.action == "CLOSE":
            rsp = call_gateway_idempotent(order, lambda timeout: gw_close(
                login, order.ticket or 0, order.volume or 0,
                order.client_order_id or "",
                client_order_id=order.client_order_id or "",
                timeout=timeout,
            ))
        elif order.action == "MODIFY":
            rsp = run_on_main_loop(gw_modify(
                login, order.ticket or 0, order.sl or 0, order.tp or 0,
            ), timeout=65.0)
        else:
            order.status = "FAILED"
            order.message = f"未知指令类型: {order.action}"
            db.commit()
            db.refresh(order)
            return order_update_payload(order)

        apply_trade_result(order, rsp)
        from app.services.gamification.stamp import stamp_order_trade_mode
        stamp_order_trade_mode(db, order)
        db.commit()
        db.refresh(order)

        logger.info(
            "Gateway 执行完成: %s %s mt5=%s -> %s deal=%s order=%s",
            order.action, order.client_order_id, order.mt5_login,
            order.status, rsp.deal, rsp.order,
        )
        return order_update_payload(order)

    except Exception as e:
        logger.error("Gateway 执行异常: %s %s", order.client_order_id, e)
        order.status = "FAILED"
        order.message = f"Gateway 执行异常: {e}"
        db.commit()
        db.refresh(order)
        return order_update_payload(order)
