"""下单路由：提交下单、查询订单 / Orders router: place & query orders.

所有指令落库为 PENDING，由 PRISMX Bridge 轮询 /api/bridge/poll 拉取执行；
Gateway 来源的账号（Make Capital）不走桥接轮询，落库后由后端直接调 gateway HTTP
实时执行。
All commands are persisted as PENDING and fetched by the PRISMX Bridge via
/api/bridge/poll. Gateway-sourced accounts (Make Capital) skip the bridge
polling path — the backend calls the gateway HTTP directly after persisting.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import ClosedTrade, DisciplineSnapshot, MT5Account, Order, Signal, User
from app.schemas import (
    ClosePositionRequest,
    ModifyPositionRequest,
    OrderOut,
    OrderRequest,
)
from app.services.connection_manager import manager
from app.services.deps import get_current_user, is_account_online, validate_order, validate_sl_tp_direction
from app.services.discipline import compute_discipline
from app.services.gateway_binding import is_revoked, not_removed
from app.services.gateway_client import (
    TradeRsp,
    run_on_main_loop,
    trade_close as gw_close,
    trade_modify as gw_modify,
    trade_open as gw_open,
)
from app.services.plans import is_realtime_plan
from app.services.symbol_aliases import broker_symbol
from app.services.trade_performance import compute_personal_winrate

logger = logging.getLogger("prismx.orders")

router = APIRouter(prefix="/orders", tags=["orders"])

# 超时作废的统一提示文案 / message stamped on voided stale orders
STALE_ORDER_MESSAGE = (
    "指令超时未执行，已自动取消。如已开启桥接请重新下单"
    " / Command timed out before execution and was cancelled automatically."
    " Re-place the order once the bridge is online."
)


def _serialize(o: Order) -> OrderOut:
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
        message=o.message,
        createdAt=o.created_at,
        updatedAt=o.updated_at,
    )


def order_update_payload(o: Order) -> dict:
    """构造前端 ORDER_UPDATE 推送载荷 / build the ORDER_UPDATE push payload."""
    return {
        "type": "ORDER_UPDATE",
        "data": _serialize(o).model_dump(mode="json"),
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


def void_stale_order(o: Order) -> None:
    """把超时订单置为 FAILED（不提交事务）/ mark a stale order FAILED (no commit)."""
    o.status = "FAILED"
    o.message = STALE_ORDER_MESSAGE


# 说明：下单/平仓/改单端点声明为普通 def——FastAPI 会放到线程池执行，
# 同步 SQLAlchemy 查询不再阻塞事件循环（WS 推送与桥接轮询共用该循环）。
# Note: these endpoints are plain `def` so FastAPI runs them in a thread pool;
# the blocking SQLAlchemy calls no longer stall the event loop shared by the
# WebSocket pushes and bridge polling.
@router.post("", response_model=OrderOut)
@limiter.limit(settings.RATE_LIMIT_ORDER)
def place_order(
    request: Request,
    req: OrderRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """提交下单：风控 + 幂等，落库为 PENDING 等待桥接拉取。
    Place an order: risk check + idempotency; persist as PENDING for the bridge.
    """
    # 0) 指定了目标账号就校验归属，防止传入不属于自己/不存在的 mt5Login——
    #    否则该单会绕过下面的"按净值限手数"风控（找不到账号 → equity 为
    #    None → 跳过净值上限），入库后再滞留 5 分钟被作废，白白坑一次用户。
    #    与 /orders/close、/orders/modify 的 _assert_account_owned 校验对齐。
    #    Verify ownership when a target account is named, so a mt5Login that
    #    isn't the user's (or doesn't exist) can't be submitted — otherwise the
    #    order bypasses the equity-based lot cap below (no account → equity None
    #    → cap skipped) only to sit 5 minutes and get voided, wasting the user's
    #    attempt. Mirrors the _assert_account_owned check in close/modify.
    _assert_account_owned(db, user.id, req.mt5Login)

    # 1) 风控校验：按净值粗估手数上限。指定了目标账号就用它；没指定但只有
    #    一个账号在线时，也用那唯一的在线账号——它正是桥接稍后单账号兜底
    #    路由会实际打过去的目标（见 bridge.py 的 target 逻辑），不取它的净值
    #    会让"不传 mt5Login"变成绕开净值上限的漏洞。只有多个账号在线、
    #    确实无法确定目标账号时才不做净值校验（后面的 online_count 检查会
    #    直接拒单，不会走到下单这一步）。
    #    Risk validation: cap volume by equity. Use the named target account if
    #    given; if none was given but exactly one account is online, use that
    #    one too — it's exactly the account the bridge's single-account
    #    fallback would route the order to (see bridge.py's `target` logic),
    #    so skipping its equity would let omitting mt5Login bypass the cap
    #    entirely. Only when multiple accounts are online (target genuinely
    #    unknown) is the equity check skipped — but that case is rejected
    #    outright by the online_count check below before an order is ever placed.
    accounts = db.query(MT5Account).filter(MT5Account.user_id == user.id, not_removed()).all()
    online_accounts = [acc for acc in accounts if is_account_online(acc)]
    target_acc = None
    if req.mt5Login:
        target_acc = next((acc for acc in accounts if acc.login == req.mt5Login), None)
    elif len(online_accounts) == 1:
        target_acc = online_accounts[0]
    equity = target_acc.equity if target_acc and target_acc.equity else None
    validate_order(req.symbol, req.side, req.volume, equity)

    # 未指定目标账号且有多个账号在线：直接拒单并提示，而不是让指令
    # 静默滞留 5 分钟后作废（桥接只在恰好一个在线账号时才能兜底路由）。
    # No target account while multiple accounts are online: reject with a
    # clear message instead of letting the command silently sit until the
    # 5-minute void (the bridge can only fall back when exactly one is online).
    if not req.mt5Login and len(online_accounts) > 1:
        raise HTTPException(
            status_code=400,
            detail="多个 MT5 账号在线，请指定目标账户 / Multiple accounts online; choose a target account",
        )

    # 2) 幂等：同一 clientOrderId 不重复下单 / idempotency by clientOrderId
    existing = (
        db.query(Order)
        .filter(Order.user_id == user.id, Order.client_order_id == req.clientOrderId)
        .first()
    )
    if existing:
        return _serialize(existing)

    # 3) 取信号的入场价与止损止盈（若提供 signalId）/ fetch entry, SL & TP from signal
    stop_loss = 0.0
    take_profit = 0.0
    if req.signalId:
        sig = db.query(Signal).filter(Signal.id == req.signalId).first()
        if sig:
            # 拒绝按已过期信号下单，防止按过时价格成交。
            # Reject orders on an expired signal to avoid trading on stale prices.
            is_expired = sig.status == "EXPIRED"
            if not is_expired and sig.expire_at is not None:
                exp = sig.expire_at
                if exp.tzinfo is None:
                    exp = exp.replace(tzinfo=timezone.utc)
                is_expired = exp < datetime.now(timezone.utc)
            # FREE 只能用行情图表手动下单，不能跟信号下单：带 signalId 且信号仍
            # 有效时，FREE 一律拒绝（免费只看得到已过期信号，这里再兜底一层，
            # 防止有人拿到一条仍在有效期内的 signalId——如降级前保存的——绕过）。
            # 不带 signalId 的手动图表下单不走这里，任何等级都放行。
            # FREE users may trade manually from the chart but not by following
            # signals: with a signalId on a still-live signal, FREE is rejected
            # (FREE only ever sees expired signals; this is the server-side
            # backstop in case someone obtains a still-live signalId, e.g. one
            # saved before downgrading). Manual chart orders carry no signalId,
            # never reach here, and are allowed on any plan.
            if not is_realtime_plan(user.plan) and not is_expired:
                raise HTTPException(
                    status_code=403,
                    detail="免费版信号延迟显示，请升级查看实时信号后再下单 / Free tier sees delayed signals only; upgrade for real-time trading",
                )
            if is_expired:
                raise HTTPException(
                    status_code=409,
                    detail="信号已过期，无法下单 / Signal expired, cannot place order",
                )
            stop_loss = sig.stop_loss or 0.0
            take_profit = sig.take_profit or 0.0

    # 用户自定义 SL/TP 覆盖信号默认值 / user's custom SL·TP overrides signal defaults
    if req.stopLoss is not None:
        stop_loss = req.stopLoss
    if req.takeProfit is not None:
        take_profit = req.takeProfit

    # 止损止盈方向校验：两者都填时买单必须 SL<TP、卖单 SL>TP，挡住绕过前端
    # 直接发的"填反了"订单（前端已拦一层，这里是服务端兜底）。
    # SL/TP direction check (server-side backstop for the UI's own check).
    validate_sl_tp_direction(req.side, stop_loss, take_profit)

    # 4) 落库为 PENDING，等待桥接轮询拉取 / persist as PENDING for the bridge to poll
    order = Order(
        user_id=user.id,
        signal_id=req.signalId,
        client_order_id=req.clientOrderId,
        action="ORDER",
        symbol=req.symbol,
        side=req.side,
        volume=req.volume,
        sl=stop_loss or None,
        tp=take_profit or None,
        # 没指定账号时回填上面解析出的唯一在线账号。桥接账号靠 bridge 的兜底
        # 路由也能成，但 gateway 账号必须有明确 login 才能直接执行，否则指令会
        # 一直悬在 PENDING（gateway 没有 bridge 来取）。
        # Fall back to the single online account resolved above. The bridge can
        # route without it, but gateway accounts need an explicit login to
        # execute — otherwise the command sits PENDING with no bridge to poll it.
        mt5_login=req.mt5Login or (target_acc.login if target_acc else None),
        status="PENDING",
    )
    result = _commit_order_or_existing(db, order, user.id, req.clientOrderId)

    # Gateway 账号实时执行，不走 bridge 轮询
    gw_payload = _try_gateway_execute(db, order)
    if gw_payload is not None:
        run_on_main_loop(manager.push_to_client(user.id, gw_payload), timeout=5.0)
        db.refresh(order)
        return _serialize(order)

    return result


@router.get("", response_model=dict)
def list_orders(
    limit: int = 100,
    offset: int = 0,
    since: datetime | None = None,
    until: datetime | None = None,
    login: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """查询当前用户订单（先作废超时的 PENDING）。

    limit/offset 支持分页；since/until 可选，按 created_at 筛选时间范围
    （until 用 < 而非 <=，前端传"选中截止日+1天"实现"含当天"的直觉）。
    login 可选，只看某一个 MT5 账号的指令——过滤在 SQL 里做，所以 total 与
    分页数字始终和筛选结果一致（前端按页本地过滤会让页码算错）。与
    /orders/winrate 不同，这里不校验账号是否仍绑定：订单是历史操作日志，
    换绑后仍应查得到。
    不传这些参数时行为与此前完全一致（最新 100 条），不影响 useLive() 里
    依赖这个接口做实时订单跟踪的既有调用方。

    List current user's orders (voiding stale PENDING ones first).

    limit/offset support pagination; since/until optionally filter by
    created_at (until uses < rather than <=; the frontend sends "selected end
    date + 1 day" to make the picked end date feel inclusive). login optionally
    narrows to one MT5 account — filtered in SQL so total and page numbers stay
    consistent with the filtered set (client-side per-page filtering would
    corrupt the page count). Unlike /orders/winrate this does not require the
    account to still be bound: orders are a historical action log and should
    remain queryable after a rebind.
    Behavior is unchanged (latest 100) when none of these are passed, so the
    live-order tracking that already calls this endpoint via useLive() isn't
    affected.
    """
    stale = [
        o
        for o in db.query(Order)
        .filter(Order.user_id == user.id, Order.status == "PENDING")
        .all()
        if is_stale_pending(o)
    ]
    if stale:
        for o in stale:
            void_stale_order(o)
        db.commit()
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    query = db.query(Order).filter(Order.user_id == user.id)
    if since is not None:
        query = query.filter(Order.created_at >= since)
    if until is not None:
        query = query.filter(Order.created_at < until)
    if login is not None:
        query = query.filter(Order.mt5_login == login)
    total = query.count()
    rows = query.order_by(Order.created_at.desc()).offset(offset).limit(limit).all()
    return {"orders": [_serialize(o) for o in rows], "total": total}


@router.post("/{order_id}/cancel", response_model=OrderOut)
@limiter.limit(settings.RATE_LIMIT_ORDER)
def cancel_order(
    request: Request,
    order_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """撤销一条尚未执行的挂单（PENDING）。

    只能撤销仍处于 PENDING 的指令；一旦桥接已回执（FILLED/REJECTED/FAILED）
    或已作废，撤销请求直接拒绝。桥接若恰好已把该指令发给 MT5，撤销无法追回
    那次执行——这是本地队列式下单模型的固有限制。

    Cancel a not-yet-executed (PENDING) order. Orders already in a terminal
    state are rejected. If the bridge already dispatched the command to MT5
    moments earlier, cancelling here can't undo that fill — an inherent limit
    of the queued-command model.
    """
    order = (
        db.query(Order)
        .filter(Order.id == order_id, Order.user_id == user.id)
        .first()
    )
    if not order:
        raise HTTPException(status_code=404, detail="订单不存在 / Order not found")
    if order.status != "PENDING":
        raise HTTPException(
            status_code=409,
            detail="订单已不是待执行状态，无法撤销 / Order is no longer pending and cannot be cancelled",
        )
    order.status = "CANCELLED"
    order.message = "用户已撤销 / Cancelled by user"
    db.commit()
    db.refresh(order)
    return _serialize(order)


def _commit_order_or_existing(db: Session, order: Order, user_id: str, client_order_id: str):
    """提交新订单；若与并发请求撞上同一 clientOrderId 的唯一约束，回滚后
    返回那个已存在的订单而非把 500 抛给客户端。
    Commit a new order; if a concurrent request races us on the same
    clientOrderId's unique constraint, roll back and return the order that
    won instead of surfacing a raw 500.
    """
    db.add(order)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = (
            db.query(Order)
            .filter(Order.user_id == user_id, Order.client_order_id == client_order_id)
            .first()
        )
        if existing:
            return _serialize(existing)
        raise
    db.refresh(order)
    return _serialize(order)


def _resolve_single_online_login(db: Session, user_id: str) -> str | None:
    """恰好一个账号在线时返回它的 login，否则返回 None。

    用于 CLOSE/MODIFY 未指定 mt5Login 的情况：bridge 账号本来就有兜底路由，
    但 gateway 账号必须有明确 login 才能直接执行。
    Returns the login when exactly one account is online, else None. Used when
    CLOSE/MODIFY omit mt5Login: the bridge has its own fallback routing, but
    gateway accounts need an explicit login to execute.
    """
    accounts = db.query(MT5Account).filter(MT5Account.user_id == user_id, not_removed()).all()
    online = [a for a in accounts if is_account_online(a)]
    return online[0].login if len(online) == 1 else None


def _gateway_account(db: Session, mt5_login: str | None, user_id: str | None = None) -> MT5Account | None:
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


def _apply_trade_result(order: Order, rsp: TradeRsp) -> None:
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
        # 网关没回话不等于拒绝：这笔可能已经执行（见 _call_gateway_idempotent）。
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


def _call_gateway_idempotent(order: Order, make_call) -> TradeRsp:
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


def _try_gateway_execute(db: Session, order: Order) -> dict | None:
    """如果是 gateway 来源账号，立即通过 gateway HTTP 执行订单。
    返回 ORDER_UPDATE 推送载荷，或 None（非 gateway 账号）。

    If the target account is gateway-sourced (Make Capital), execute the order
    immediately via the gateway HTTP API. Returns an ORDER_UPDATE push payload,
    or None for non-gateway accounts.
    """
    account = _gateway_account(db, order.mt5_login, order.user_id)
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
            rsp = _call_gateway_idempotent(order, lambda timeout: gw_open(
                login, broker_symbol(order.symbol),
                order.side or "BUY", order.volume or 0.01,
                order.sl or 0, order.tp or 0,
                order.client_order_id or "",
                client_order_id=order.client_order_id or "",
                timeout=timeout,
            ))
        elif order.action == "CLOSE":
            rsp = _call_gateway_idempotent(order, lambda timeout: gw_close(
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

        _apply_trade_result(order, rsp)
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


def _bound_logins(db: Session, user_id: str) -> list[str]:
    """该用户名下所有 MT5 账号登录名，**含用户已删除（软删）的**。

    这是胜率 / 已平仓明细的过滤集：删除账号是"不想再看到它、不想再往里下单"，
    不是"抹掉我在它上面的战绩"。软删之前这里的行真的没了，历史随之消失，重绑
    才回来——正是软删要修的问题。
    All of this user's logins **including soft-removed ones**: this feeds the
    win-rate / closed-trade filters, and removing an account means "stop showing
    and trading it", not "erase my record on it"."""
    return [row[0] for row in db.query(MT5Account.login).filter(MT5Account.user_id == user_id).all()]


@router.get("/winrate", response_model=dict)
def order_winrate(
    login: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """当前用户的个人跟单胜率：基于真实平仓明细，一个仓位全部平完才算数
    （方案 B，见 app/services/trade_performance.py）。只有自己能看到自己的。

    不传 login：统计范围限定在当前仍绑定的账号（已删除的旧账号不计入）。
    传 login：进一步只看这一个账号——账号必须是当前绑定的，否则视为不存在。

    The current user's personal win rate, based on real close records; a
    position only counts once fully closed (design B). Visible only to the
    user themself.

    Without login: scoped to currently-bound accounts (deleted ones excluded).
    With login: narrowed to that one account — it must be currently bound, or
    it's treated as not found.
    """
    bound = _bound_logins(db, user.id)
    if login is not None and login not in bound:
        raise HTTPException(status_code=404, detail="账号不存在 / Account not found")
    return compute_personal_winrate(db, user.id, bound_logins=bound, login=login)


@router.get("/discipline", response_model=dict)
def order_discipline(
    login: str | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """当前用户的纪律分：回答"有没有按计划执行"，与赚不赚钱无关，纯只读统计。

    账号过滤语义与 /orders/winrate 完全一致（见 services/discipline.py）。
    等级裁剪：FREE 只返回 total/windowDays/positions/trend，PRO 额外返回
    dimensions 逐维度明细——门槛直接判 user.plan == "PRO"，不经
    services.plans.can_auto_manage 之类的旁支，明细展示与自动仓管没有关系。

    The current user's discipline score: whether the plan was followed,
    independent of P&L. Purely read-only.

    Account-filter semantics exactly match /orders/winrate (see
    services/discipline.py). Plan gating: FREE gets total/windowDays/
    positions/trend only; PRO also gets the per-dimension breakdown — gated
    directly on user.plan == "PRO", not via services.plans.can_auto_manage or
    similar (the detail view has nothing to do with auto-management).
    """
    bound = _bound_logins(db, user.id)
    if login is not None and login not in bound:
        raise HTTPException(status_code=404, detail="账号不存在 / Account not found")
    result = compute_discipline(db, user.id, bound_logins=bound, login=login)

    snapshot_login = login or ""
    trend_cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    trend_rows = (
        db.query(DisciplineSnapshot)
        .filter(
            DisciplineSnapshot.user_id == user.id,
            DisciplineSnapshot.login == snapshot_login,
            DisciplineSnapshot.date >= trend_cutoff.date().isoformat(),
        )
        .order_by(DisciplineSnapshot.date.asc())
        .all()
    )
    trend = [{"date": r.date, "total": r.total} for r in trend_rows]

    response = {
        "total": result["total"],
        "windowDays": result["windowDays"],
        "positions": result["positions"],
        "trend": trend,
    }
    if user.plan == "PRO":
        response["dimensions"] = result["dimensions"]
    return response


@router.get("/closed-trades", response_model=dict)
def list_closed_trades(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """当前用户的真实平仓成交明细，最新在前，限定当前仍绑定的账号（已删除的
    旧账号不再出现；重新绑回后自动恢复，记录从不删除）。只有自己能看到自己的。

    与个人跟单胜率同一份数据源（ClosedTrade），但这里给出逐笔记录而非聚合
    数字——"透明度"承诺不能只停在一个百分比上，用户应该能看到构成这个百分比
    的每一笔真实成交。

    The current user's real closed-trade legs, newest first, scoped to
    currently-bound accounts (a deleted account's history disappears; it comes
    back automatically once re-bound — nothing is ever deleted). Visible only
    to the user themself.

    Same underlying data as the personal win rate (ClosedTrade), but exposed
    as individual records instead of an aggregate — the "transparency"
    promise shouldn't stop at a single percentage; the user should be able to
    see every real fill that number is built from.
    """
    bound = _bound_logins(db, user.id)
    rows = (
        db.query(ClosedTrade)
        .filter(ClosedTrade.user_id == user.id, ClosedTrade.mt5_login.in_(bound))
        .order_by(ClosedTrade.closed_at.desc())
        .limit(200)
        .all()
    )
    return {
        "trades": [
            {
                "id": r.id,
                "mt5Login": r.mt5_login,
                "symbol": r.symbol,
                "side": r.side,
                "closeVolume": r.close_volume,
                "closePrice": r.close_price,
                "profit": r.profit,
                "positionTicket": r.position_ticket,
                "dealTicket": r.deal_ticket,
                "closedAt": r.closed_at.isoformat() if r.closed_at else None,
            }
            for r in rows
        ]
    }


def _assert_account_owned(db: Session, user_id: str, mt5_login: str | None) -> None:
    """校验目标账号归属当前用户（指定 mt5Login 时）。
    Verify the target account belongs to the current user (when mt5Login given).
    """
    if not mt5_login:
        return
    acc = (
        db.query(MT5Account)
        .filter(MT5Account.user_id == user_id, MT5Account.login == mt5_login, not_removed())
        .first()
    )
    if acc is None:
        raise HTTPException(status_code=404, detail="账号不存在或不属于当前用户 / Account not found")


@router.post("/close", response_model=OrderOut)
@limiter.limit(settings.RATE_LIMIT_ORDER)
def close_position(
    request: Request,
    req: ClosePositionRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """平仓（含部分平仓）：以 CLOSE 指令落库，等待桥接拉取。
    Close a position (incl. partial): persist a CLOSE command for the bridge.
    """
    # 校验目标账号归属，防止越权操控他人/不存在账号 / verify account ownership
    _assert_account_owned(db, user.id, req.mt5Login)

    # 部分平仓手数不得低于单笔最小手数（省略或 0 表示全平，不受此限）。
    # 否则一笔拆不开的小额平仓会被下发、再由 MT5 拒绝，白白回执一条报错。
    # A partial-close volume must not fall below the per-order minimum (omit or
    # 0 means full close, which is exempt). Otherwise an un-fillable tiny close
    # gets dispatched only to be rejected by MT5, wasting an error receipt.
    if req.volume is not None and 0 < req.volume < settings.MIN_VOLUME_PER_ORDER:
        raise HTTPException(
            status_code=400,
            detail=f"低于单笔最小手数 {settings.MIN_VOLUME_PER_ORDER} / Below min volume",
        )

    # 幂等 / idempotency by clientOrderId
    existing = (
        db.query(Order)
        .filter(Order.user_id == user.id, Order.client_order_id == req.clientOrderId)
        .first()
    )
    if existing:
        return _serialize(existing)

    order = Order(
        user_id=user.id,
        client_order_id=req.clientOrderId,
        action="CLOSE",
        symbol=req.symbol,
        side=req.side,
        volume=req.volume or 0.0,
        ticket=req.ticket,
        mt5_login=req.mt5Login or _resolve_single_online_login(db, user.id),
        status="PENDING",
    )
    result = _commit_order_or_existing(db, order, user.id, req.clientOrderId)

    gw_payload = _try_gateway_execute(db, order)
    if gw_payload is not None:
        run_on_main_loop(manager.push_to_client(user.id, gw_payload), timeout=5.0)
        db.refresh(order)
        return _serialize(order)

    return result


@router.post("/modify", response_model=OrderOut)
@limiter.limit(settings.RATE_LIMIT_ORDER)
def modify_position(
    request: Request,
    req: ModifyPositionRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """修改持仓止损止盈：以 MODIFY 指令落库，等待桥接拉取。
    Modify a position's SL/TP: persist a MODIFY command for the bridge.
    """
    # 校验目标账号归属，防止越权操控他人/不存在账号 / verify account ownership
    _assert_account_owned(db, user.id, req.mt5Login)

    # 止损止盈方向校验：两者都非 0 时买单必须 SL<TP、卖单 SL>TP（0 表示清除该侧）。
    # SL/TP direction check (0 means "clear that side" and is skipped).
    validate_sl_tp_direction(req.side, req.stopLoss, req.takeProfit)

    existing = (
        db.query(Order)
        .filter(Order.user_id == user.id, Order.client_order_id == req.clientOrderId)
        .first()
    )
    if existing:
        return _serialize(existing)

    order = Order(
        user_id=user.id,
        client_order_id=req.clientOrderId,
        action="MODIFY",
        symbol=req.symbol,
        side=req.side,
        volume=0.0,
        ticket=req.ticket,
        sl=req.stopLoss,
        tp=req.takeProfit,
        mt5_login=req.mt5Login or _resolve_single_online_login(db, user.id),
        status="PENDING",
    )
    result = _commit_order_or_existing(db, order, user.id, req.clientOrderId)

    gw_payload = _try_gateway_execute(db, order)
    if gw_payload is not None:
        run_on_main_loop(manager.push_to_client(user.id, gw_payload), timeout=5.0)
        db.refresh(order)
        return _serialize(order)

    return result


# ---------- 超时订单后台清理 / stale-order background sweep ----------
async def stale_order_monitor_loop() -> None:
    """周期性把超时未执行的 PENDING 订单置为 FAILED 并推送前端。

    覆盖用户下单后既不刷新订单页、桥接也一直不上线的场景：
    没有任何请求触发作废时，由本任务兜底，让前端及时看到"已取消"。

    Periodically void stale PENDING orders and push ORDER_UPDATE, covering the
    case where neither the orders page nor the bridge ever touches them.
    """
    from starlette.concurrency import run_in_threadpool

    from app.core.database import SessionLocal

    def _sweep() -> list[tuple[str, dict]]:
        """作废超时订单（同步 DB 操作），返回 (user_id, payload) 列表。
        Void stale orders (blocking DB work); return (user_id, payload) pairs."""
        db = SessionLocal()
        try:
            voided: list[Order] = []
            pending = db.query(Order).filter(Order.status == "PENDING").all()
            for o in pending:
                if is_stale_pending(o):
                    void_stale_order(o)
                    voided.append(o)
            if voided:
                db.commit()
            out = []
            for o in voided:
                db.refresh(o)
                out.append((o.user_id, order_update_payload(o)))
            return out
        finally:
            db.close()

    while True:
        await asyncio.sleep(10)
        try:
            # DB 扫描放线程池，避免阻塞事件循环 / DB sweep off the event loop
            for user_id, payload in await run_in_threadpool(_sweep):
                await manager.push_to_client(user_id, payload)
        except Exception:
            logger.exception("stale_order_monitor_loop error")
