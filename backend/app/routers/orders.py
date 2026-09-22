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

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import ClosedTrade, MT5Account, Order, Signal, User
from app.schemas import (
    CancelPendingRequest,
    ModifyPendingRequest,
    CloseAllOut,
    CloseAllRequest,
    ClosePositionRequest,
    ModifyPositionRequest,
    OrderOut,
    OrderRequest,
)
from app.services.connection_manager import manager
from app.services.deps import (get_current_user, is_account_online,
                               validate_order, validate_sl_tp_direction)
from app.services.symbol_aliases import is_volume_on_step, lot_step, min_lot, symbol_match_set
from app.services import bridge_wake, close_all
from app.services.gateway_binding import not_removed
from app.services.gateway_client import run_on_main_loop
# 网关执行与订单载荷都搬到了 services（2026-09-06）：自动仓管与 routers/bridge 现在
# 直接 import 服务模块，不再反向 import 本路由。这里的下划线别名只供本文件内部用。
# Gateway execution and order payload helpers live in services now; auto-manage
# and routers/bridge import them directly instead of this router. The
# underscored aliases below are for this file's own call sites only.
from app.services.gateway_execute import try_gateway_execute as _try_gateway_execute
from app.services.order_payload import (
    is_stale_pending,
    order_update_payload,
    serialize_order as _serialize,
    void_stale_order,
)
from app.services.pending_orders import gateway_logins, push_gateway_pending_orders
from app.services.plans import is_realtime_plan
from app.services.trade_performance import compute_personal_winrate

logger = logging.getLogger("prismx.orders")

router = APIRouter(prefix="/orders", tags=["orders"])

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
            # 信号必须和这张单说的是同一个品种、同一个方向，否则拒单。
            #
            # 不校验的话，可以拿 A 品种的 signalId 去给 B 品种下单：下面两行会把 A 的
            # 止损止盈原样套到 B 上（黄金的 3900 当成欧元的止损），MT5 多半会以
            # invalid stops 拒掉，但这笔的 signal_id 已经记在订单上了——信号胜率的
            # 归因被污染，而那正是平台对外展示的数字。方向对不上同理。
            #
            # 用 symbol_match_set 而不是字面相等：同一个品种在信号侧与下单侧可能写法
            # 不同（BTCUSDT / BTCUSD、带不带券商后缀），直接比字符串会误伤正常下单。
            #
            # The signal must be for the same symbol and side as the order. Without
            # this, symbol A's signalId can be attached to an order on symbol B: the
            # two lines below then copy A's SL/TP onto B (gold's 3900 as a stop on
            # EURUSD). MT5 would usually reject it as invalid stops, but the
            # signal_id is already recorded on the order, polluting signal win-rate
            # attribution — the number the platform publishes. Same for a mismatched
            # side. Matching goes through symbol_match_set rather than string
            # equality because the two sides may legitimately spell a symbol
            # differently (BTCUSDT vs BTCUSD, broker suffixes).
            if sig.symbol and req.symbol.upper() not in symbol_match_set(sig.symbol):
                raise HTTPException(
                    status_code=400,
                    detail="信号与下单品种不一致 / signal and order symbol do not match",
                )
            if sig.side and req.side.upper() != sig.side.upper():
                raise HTTPException(
                    status_code=400,
                    detail="信号与下单方向不一致 / signal and order side do not match",
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

    # 挂单还能多校一层：触发价是已知的，所以止损止盈必须落在它正确的那一侧。
    # 市价单做不到这一步（后端没有报价），但挂单的入场价就写在请求里，放过去
    # 只会换来券商的 invalid stops——那时用户看到的只是一个裸返回码。
    # A pending order allows one more check the market path cannot do: its entry
    # price is in the request, so SL/TP must sit on the right side of it. Letting it
    # through only earns an "invalid stops" rejection from the broker, which reaches
    # the user as a bare retcode.
    pending_type = None
    if req.orderType != "MARKET":
        pending_type = f"{req.side}_{req.orderType}"
        _validate_pending_levels(req.side, req.price or 0.0, stop_loss, take_profit)

    # 4) 落库为 PENDING，等待桥接轮询拉取 / persist as PENDING for the bridge to poll
    #    注意 status 与 action 是两件事：status=PENDING 说的是「这条平台指令还没被
    #    执行」，action=PENDING 说的是「这条指令要在 MT5 里挂一张单」。挂单指令也
    #    从 status=PENDING 开始，执行成功后落 PLACED（见 gateway_execute）。
    #    status and action are unrelated: status=PENDING means "this platform command
    #    has not executed yet", action=PENDING means "what it asks for is an MT5
    #    pending order". A pending-order command also starts at status=PENDING and
    #    settles at PLACED once executed.
    order = Order(
        user_id=user.id,
        signal_id=req.signalId,
        client_order_id=req.clientOrderId,
        action="ORDER" if req.orderType == "MARKET" else "PENDING",
        pending_type=pending_type,
        price=req.price,
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
    result, created = _commit_order_or_existing(db, order, user.id, req.clientOrderId)
    # 并发撞上同一 clientOrderId：那笔已经存在（且已经或正在被执行），直接把它返回。
    # 绝不能拿被回滚掉的 order 再去调网关——见 _commit_order_or_existing 的说明。
    # Lost the race on this clientOrderId: the order already exists and is already
    # being executed. Never hand the rolled-back object to the gateway.
    if not created:
        return result

    # Gateway 账号实时执行，不走 bridge 轮询
    gw_payload = _try_gateway_execute(db, order)
    if gw_payload is not None:
        run_on_main_loop(manager.push_to_client(user.id, gw_payload), timeout=5.0)
        db.refresh(order)
        if order.action == "PENDING":
            _refresh_pending_after(db, order)
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

    只能撤销仍处于 PENDING **且尚未下发**的指令。

    「尚未下发」这个条件是 2026-09-19 审计补的。此前只看 status：指令已经交给桥接、
    桥接正在 MT5 里执行、回执还没回来的那个窗口里，status 仍是 PENDING，于是撤销
    会成功并显示「已撤销」——而几秒后真回执回来，又被 _result_db_work 的 WHERE
    覆写成 FILLED。用户看到的是先「已撤销」后「已成交」，中间大概率已经按「撤销
    成功」重下了一笔。这不是本地队列模型的固有限制，是可以拦住的。

    真正的固有限制只剩一条：指令刚下发、这里还没看到 delivered 落库的那一瞬。窗口
    从「整个 ack 超时」缩到「一次数据库写入」。

    Cancel a PENDING order that has **not yet been delivered**.

    The delivery check was added by the 2026-09-19 audit. Checking status alone
    left a window: once the command is handed to the bridge and is executing in
    MT5, its status is still PENDING, so the cancel succeeded and the UI said
    "cancelled" — until the real result arrived seconds later and _result_db_work's
    WHERE clause overwrote it to FILLED. The user saw "cancelled" then "filled",
    having most likely re-placed the order in between. That was preventable.

    The genuinely inherent limit is now only the instant between dispatch and the
    `delivered` flag being committed — the window shrinks from a full ack timeout
    to a single database write.
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
    if order.delivered and not is_stale_pending(order):
        # 已下发且还在 ack 窗口内：桥接很可能正在执行它。撤销会给用户一个假的
        # 「没发生」，而真结果随后就到。/ Delivered and still within the ack window:
        # the bridge is probably executing it right now. Cancelling would assert a
        # "nothing happened" that the incoming result is about to contradict.
        raise HTTPException(
            status_code=409,
            detail=(
                "指令已下发执行，无法撤销，请等待回执 / "
                "already dispatched for execution; wait for the result"
            ),
        )
    order.status = "CANCELLED"
    order.message = "用户已撤销 / Cancelled by user"
    db.commit()
    db.refresh(order)
    return _serialize(order)


def _commit_order_or_existing(
    db: Session, order: Order, user_id: str, client_order_id: str
) -> tuple[dict, bool]:
    """提交新订单；若与并发请求撞上同一 clientOrderId 的唯一约束，回滚后
    返回那个已存在的订单而非把 500 抛给客户端。

    返回 (载荷, created)。**created 必须被调用方检查**：撞约束那条路径 `db.rollback()`
    之后，传进来的 `order` 变回 transient（没有主键、不在 session 里），此时
    ① 拿它去调网关等于用同一个 clientOrderId 再执行一次——目前只靠网关的幂等缓存
       兜住，缓存一过期就是真的重复下单；
    ② 对它 `db.refresh()` 会抛 InvalidRequestError，把并发重试变成 500，客户端再
       重试一次，雪上加霜。
    所以 created=False 时调用方应当直接返回已存在的那笔，不要再走执行分支。

    Commit a new order; on a concurrent race against the clientOrderId unique
    constraint, roll back and return the winning order instead of a raw 500.

    Returns (payload, created). **Callers must check `created`**: after the
    rollback the passed-in `order` is transient again, so (1) handing it to the
    gateway re-executes the same clientOrderId, today caught only by the gateway's
    idempotency cache and a genuine duplicate once that expires, and (2)
    `db.refresh()` on it raises InvalidRequestError, turning a concurrent retry
    into a 500 that invites yet another retry.
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
            return _serialize(existing), False
        raise
    db.refresh(order)
    # 落库成功就叫醒长轮询中的桥接（gateway 账号的单也会叫一声，桥接那边查一次
    # 发现没有自己的指令就继续等，代价可忽略）。
    # Wake a long-polling bridge as soon as the row is committed.
    bridge_wake.notify(user_id)
    return _serialize(order), True


def _require_close_login(db: Session, user_id: str, requested: str | None) -> str | None:
    """给 CLOSE / MODIFY 解析目标账号；**只有在「多个账号在线」这一种解析不出来的
    情况下**当场 400，其余沿用原行为。

    要解决的问题：多个账号同时在线而请求没带 mt5Login 时，指令以 mt5_login=None
    落库，而 bridge_poll 在下发时同样解析不出目标（`target = o.mt5_login or
    (唯一在线账号 if 只有一个 else None)`，None 就 continue），于是这条指令**永远**
    不会被下发，只能在 5 分钟后被 stale 判定作废。开仓单慢 5 分钟只是烦，平仓单
    慢 5 分钟是要赔钱的——用户以为平仓已经提交，实际从头到尾没人执行，行情还在走。
    这种情况下前端本来就该带上 ticket 对应的账号，带不上是前端的 bug，当场 400
    比静默拖 5 分钟诚实。

    为什么「一个账号都不在线」反而不能报错：那种情况下 mt5_login 留 None 是**有用**
    的。目标账号是在 bridge_poll 里按当时的在线情况重新解析的，所以桥接稍后恢复
    （比如笔记本从睡眠醒来）、且只有一个账号在线时，这条指令会被正常下发执行。
    在这里 409 掉等于把「排队等桥接回来」这个正常用法砍掉。

    Resolve the target account for CLOSE / MODIFY. Fails with 400 **only** for the
    ambiguous case, and otherwise preserves the existing behaviour.

    The bug: with several accounts online and no mt5Login in the request, the row is
    stored with mt5_login=None, and bridge_poll re-resolves to None as well (it
    takes the single online account or nothing), so the command is *never*
    delivered and is simply voided by the stale sweep five minutes later. Five
    minutes is annoying for an open and expensive for a close. The frontend knows
    which account the ticket belongs to; failing to send it is a frontend bug, and a
    400 now beats a silent stall.

    Why "no account online" must NOT fail: there, a null login is useful. The target
    is re-resolved at poll time, so once the bridge comes back (a laptop waking up)
    with a single account online, the queued command is delivered and executed.
    Rejecting here would remove that legitimate "queue until the bridge returns"
    behaviour.
    """
    if requested:
        return requested
    accounts = db.query(MT5Account).filter(MT5Account.user_id == user_id, not_removed()).all()
    online = [a for a in accounts if is_account_online(a)]
    if len(online) == 1:
        return online[0].login
    if len(online) > 1:
        raise HTTPException(
            status_code=400,
            detail=(
                "有多个账号在线，请指定要操作的 MT5 账号 / "
                "several accounts are online; specify which MT5 login to act on"
            ),
        )
    # 一个都不在线：留空排队，等桥接回来由 bridge_poll 解析目标。
    # None online: queue with a null target for bridge_poll to resolve on return.
    return None


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
                # MT5 历史「仓位」视图的其余字段；旧记录为 null，回扫后补上
                # The rest of MT5's positions view; null on legacy rows until rescanned
                "openTime": r.open_time.isoformat() if r.open_time else None,
                "openPrice": r.open_price,
                "grossProfit": r.gross_profit,
                "commission": r.commission,
                "swap": r.swap,
                "sl": r.sl,
                "tp": r.tp,
                "reason": r.reason,
                "comment": r.comment,
            }
            for r in rows
        ]
    }


def _refresh_pending_after(db: Session, order: Order) -> None:
    """挂单 / 撤挂单执行完之后，立刻重推一帧挂单快照。

    不等 gateway 慢拍那 5 秒：用户刚按下的动作要马上在「挂单」页签里看得见，
    否则会以为没生效而再按一次。只对 gateway 账号做——桥接账号的挂单快照跟着
    桥接自己下一拍（约 1.5 秒）的 /bridge/positions 一起上来，已经够快了。

    失败只记日志：这是一次锦上添花的刷新，慢拍稍后会补上，绝不能让它把一次
    已经成功的挂单变成给用户的报错。
    Re-push the pending-orders snapshot right after a place/cancel instead of waiting
    out the gateway's 5s tick, so the user sees their action land and doesn't press
    again. Gateway accounts only — a bridge reports its own within ~1.5s. Failures are
    logged and swallowed: this is a courtesy refresh, and it must never turn a
    successful placement into an error.
    """
    try:
        logins = gateway_logins(db, order.user_id)
        if logins:
            run_on_main_loop(push_gateway_pending_orders(order.user_id, logins), timeout=10.0)
    except Exception:
        logger.exception("挂单快照即时刷新失败 user=%s", order.user_id)


def _validate_pending_levels(
    side: str, price: float, stop_loss: float, take_profit: float
) -> None:
    """挂单的止损止盈必须落在触发价正确的那一侧。

    买单：SL < 触发价 < TP；卖单反之。0 表示该侧没设，跳过。

    与 validate_sl_tp_direction 的分工：那条只看 SL 与 TP 的相对关系（不需要入场
    价，所以市价单也能用），这条比的是它们与**入场价**的关系。挂单是少数几种后端
    确实知道入场价的情形，不用白不用——否则这笔单会一路走到券商才被判 invalid
    stops，用户拿到的是一个裸返回码，而不是「止损要低于买入价」。

    A pending order's SL/TP must sit on the correct side of its trigger price (BUY:
    SL < price < TP). Complements validate_sl_tp_direction, which only compares SL
    against TP because a market order has no entry price on the server. A pending
    order does carry one, and using it turns a bare broker "invalid stops" retcode
    into a sentence the user can act on.
    """
    if price <= 0:
        return
    if side == "BUY":
        if stop_loss and stop_loss > 0 and stop_loss >= price:
            raise HTTPException(
                status_code=400,
                detail="买入挂单的止损必须低于触发价 / a buy order's stop-loss must be below the trigger price",
            )
        if take_profit and take_profit > 0 and take_profit <= price:
            raise HTTPException(
                status_code=400,
                detail="买入挂单的止盈必须高于触发价 / a buy order's take-profit must be above the trigger price",
            )
    else:
        if stop_loss and stop_loss > 0 and stop_loss <= price:
            raise HTTPException(
                status_code=400,
                detail="卖出挂单的止损必须高于触发价 / a sell order's stop-loss must be above the trigger price",
            )
        if take_profit and take_profit > 0 and take_profit >= price:
            raise HTTPException(
                status_code=400,
                detail="卖出挂单的止盈必须低于触发价 / a sell order's take-profit must be below the trigger price",
            )


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
    if req.volume is not None and 0 < req.volume < min_lot(req.symbol):
        raise HTTPException(
            status_code=400,
            detail=f"低于 {req.symbol} 的最小手数 {min_lot(req.symbol)} / Below min volume",
        )

    # 部分平仓手数必须落在手数步长上。不是整数倍的手数（黄金 0.015）不会被 MT5
    # 当场拒绝，而是被接受成一张永远不会成交的订单，挂在仓位上把这张仓位后续的
    # 平仓全部挡掉——2026-09-17 有用户因此三个半小时平不掉仓，最后爆仓。
    # 全平（省略或 0）不受此限：仓位自身的手数必然合法。
    # An off-step partial close is not rejected by MT5; it becomes an order that can
    # never fill and blocks every later close on that position. A full close is exempt.
    if req.volume is not None and req.volume > 0 and not is_volume_on_step(req.volume, req.symbol):
        raise HTTPException(
            status_code=400,
            detail=f"手数必须是 {lot_step(req.symbol)} 的整数倍 / Volume must be a multiple of {lot_step(req.symbol)}",
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
        mt5_login=_require_close_login(db, user.id, req.mt5Login),
        status="PENDING",
    )
    result, created = _commit_order_or_existing(db, order, user.id, req.clientOrderId)
    if not created:
        return result

    gw_payload = _try_gateway_execute(db, order)
    if gw_payload is not None:
        run_on_main_loop(manager.push_to_client(user.id, gw_payload), timeout=5.0)
        db.refresh(order)
        return _serialize(order)

    return result


@router.post("/modify-pending", response_model=OrderOut)
@limiter.limit(settings.RATE_LIMIT_ORDER)
def modify_pending_order(
    request: Request,
    req: ModifyPendingRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """改一张真实的 MT5 挂单：触发价 / 止损 / 止盈，以 MODIFY_PENDING 指令落库。

    没传的那一项保留券商上的现值（落库为 NULL，一路 null 传到网关 / 桥接）。
    止损止盈传 0 = 清除；触发价没有「清除」，schema 已经把 0 挡在门外。
    Unspecified fields keep the broker's current value (stored NULL and sent as null
    all the way down). 0 clears SL/TP; a trigger price has no "clear" and the schema
    already refuses 0.
    """
    _assert_account_owned(db, user.id, req.mt5Login)

    # 方向校验需要知道这是买单还是卖单，而这条指令里没有 side——它只认票号。
    # 从当初下这张挂单的那条记录上把方向找回来：平台只显示自己挂的单，所以正常
    # 情况下这条记录一定在。找不到就跳过（老记录、或票号对不上），把判断交给网关
    # ——它读得到那张单自己的类型，本来就是更权威的那一层。
    #
    # 这里能校到的是「SL/TP 相对新触发价是否合理」。只拖触发价、不动 SL/TP 时，
    # 后端不知道券商上现有的 SL/TP 是多少（那份实时快照不落库），所以「把触发价
    # 拖过了现有止损」这种情况只能由券商拒绝——这是已知的缺口，不是遗漏。
    #
    # The direction rules need a side, and this command carries only a ticket. Recover
    # it from the row that placed the order (the platform only ever shows its own, so
    # it is normally there); a miss just defers to the gateway, which can read the
    # order's own type and is the authority anyway.
    #
    # What this catches is SL/TP against the *new* trigger. Dragging only the trigger
    # cannot be checked here — the broker's live SL/TP is not persisted — so "trigger
    # dragged past the existing stop" is left to the broker. A known gap, not an oversight.
    placed = (
        db.query(Order)
        .filter(
            Order.user_id == user.id,
            Order.action == "PENDING",
            Order.mt5_ticket == req.ticket,
            Order.pending_type.isnot(None),
        )
        .order_by(Order.created_at.desc())
        .first()
    )
    side = None
    if placed and placed.pending_type:
        side = "BUY" if placed.pending_type.startswith("BUY") else "SELL"
    if side:
        validate_sl_tp_direction(side, req.stopLoss or 0.0, req.takeProfit or 0.0)
        if req.price is not None:
            _validate_pending_levels(side, req.price, req.stopLoss or 0.0, req.takeProfit or 0.0)

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
        action="MODIFY_PENDING",
        symbol=req.symbol,
        # 与 CANCEL_PENDING 同理：改单没有方向，side 只为满足非空列。
        # As with CANCEL_PENDING: a modify has no side; this only satisfies the column.
        side="BUY",
        volume=0.0,
        ticket=req.ticket,
        price=req.price,
        sl=req.stopLoss,
        tp=req.takeProfit,
        mt5_login=_require_close_login(db, user.id, req.mt5Login),
        status="PENDING",
    )
    result, created = _commit_order_or_existing(db, order, user.id, req.clientOrderId)
    if not created:
        return result

    gw_payload = _try_gateway_execute(db, order)
    if gw_payload is not None:
        run_on_main_loop(manager.push_to_client(user.id, gw_payload), timeout=5.0)
        db.refresh(order)
        _refresh_pending_after(db, order)
        return _serialize(order)

    return result


@router.post("/cancel-pending", response_model=OrderOut)
@limiter.limit(settings.RATE_LIMIT_ORDER)
def cancel_pending_order(
    request: Request,
    req: CancelPendingRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """撤销一张真实的 MT5 挂单：以 CANCEL_PENDING 指令落库，等待桥接拉取。

    与 POST /orders/{order_id}/cancel 不是一回事，两个都要留着：
      - 这里撤的是**券商服务器上**的挂单，按券商票号定位，要真的发一条指令出去；
      - 那里撤的是平台侧还没被桥接取走的指令行，纯数据库操作，碰不到券商。
    Distinct from POST /orders/{order_id}/cancel, which voids a not-yet-dispatched
    platform command row without ever reaching the broker. This removes an order
    that already lives at the broker, addressed by its broker ticket.
    """
    _assert_account_owned(db, user.id, req.mt5Login)

    # 幂等：同一 clientOrderId 只撤一次 / idempotency by clientOrderId
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
        action="CANCEL_PENDING",
        symbol=req.symbol,
        # 撤单没有方向可言，但 side 是非空列。填 BUY 只为满足约束，任何消费方
        # 都不该读 CANCEL_PENDING 指令的 side——与 CLOSE 指令带的是真实持仓方向
        # 不同，这里没有对应的真实方向可填。
        # A cancel has no direction, but `side` is NOT NULL. This placeholder exists
        # only to satisfy the column; no consumer should read a CANCEL_PENDING's side.
        # (A CLOSE does carry the position's real side — there is no analogue here.)
        side="BUY",
        volume=0.0,
        ticket=req.ticket,
        mt5_login=_require_close_login(db, user.id, req.mt5Login),
        status="PENDING",
    )
    result, created = _commit_order_or_existing(db, order, user.id, req.clientOrderId)
    if not created:
        return result

    gw_payload = _try_gateway_execute(db, order)
    if gw_payload is not None:
        run_on_main_loop(manager.push_to_client(user.id, gw_payload), timeout=5.0)
        db.refresh(order)
        _refresh_pending_after(db, order)
        return _serialize(order)

    return result


@router.post("/close-all", response_model=CloseAllOut)
@limiter.limit(settings.RATE_LIMIT_ORDER)
def close_all_positions(
    request: Request,
    req: CloseAllRequest,
    background: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """一键平仓：把当前持仓（可限定单个账号）一次全部排成 CLOSE 指令。

    平仓对象取自后端自己的持仓快照（connection_manager，桥接 ~1.5 秒 / 网关 2 秒
    上报一次），不取客户端传来的列表——客户端那份也是这里推过去的，让它回传只是
    多一次可被篡改的往返。

    返回的是**受理**回执而不是成交结果：网关账号的执行放进后台（单笔最坏 65 秒，
    十笔串起来必然超时），桥接账号的由桥接轮询取走，两边的结果都沿既有的
    ORDER_UPDATE / POSITIONS 推送回前端。整批完成后再发一条汇总 Web Push，逐条
    的那份在 routers/bridge 里按前缀跳过——一次"全部平仓"只该响一次。

    Close every open position (optionally scoped to one account) in one batch.
    The position set comes from the backend's own snapshot rather than the
    client's copy. The response acknowledges acceptance, not fills: gateway
    execution runs off-request and results arrive over the existing pushes, with
    a single summary push once the whole batch resolves.
    """
    # 校验目标账号归属，防止越权操控他人/不存在账号 / verify account ownership
    _assert_account_owned(db, user.id, req.mt5Login)

    positions = manager.get_positions(user.id)
    batch, created, skipped = close_all.queue(
        db, user.id, req.clientOrderId, req.mt5Login, positions
    )

    if not created:
        # 一笔都没排下去：要么范围内本来就没持仓，要么全都已经有平仓指令在途。
        # 后者不是错误（连点第二下），照常返回受理回执，由前端说清楚。
        # Nothing queued: either nothing is open in scope, or every position
        # already has a close in flight (a double tap). Neither is an error.
        if skipped == 0:
            raise HTTPException(
                status_code=400,
                detail="当前没有可平仓的持仓 / No open positions to close",
            )
        return CloseAllOut(
            batchId=batch, requested=skipped, queued=0, skipped=skipped, orders=[]
        )

    # 落库成功就叫醒长轮询中的桥接，别等它下一拍才发现有活 / wake the long poll
    bridge_wake.notify(user.id)

    gw_logins = close_all.gateway_logins(db, user.id)
    gw_ids = [o.id for o in created if o.mt5_login and o.mt5_login in gw_logins]
    if gw_ids:
        # 响应发出之后才跑（Starlette 的 BackgroundTasks）。同步函数会被放到线程池，
        # 而那时请求的 DB 会话已经关闭，所以后台任务自己开一个新会话。
        # Runs after the response is sent; the request's session is already closed
        # by then, so the task opens its own.
        background.add_task(close_all.execute_gateway_batch, user.id, batch, gw_ids)

    return CloseAllOut(
        batchId=batch,
        requested=len(created) + skipped,
        queued=len(created),
        skipped=skipped,
        orders=[_serialize(o) for o in created],
    )


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
        mt5_login=_require_close_login(db, user.id, req.mt5Login),
        status="PENDING",
    )
    result, created = _commit_order_or_existing(db, order, user.id, req.clientOrderId)
    if not created:
        return result

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
            # 作废的若是一键平仓的子指令，这一批就此收尾——补发那条汇总通知，
            # 否则"桥接从头到尾没上线"的一批只会在订单页留下一片"已取消"，
            # 而按下按钮的人始终不知道其实一笔都没平。
            # A voided close-all child ends its batch here; send the summary the
            # ack path would otherwise have sent, so "nothing actually closed"
            # doesn't stay silent.
            by_user: dict[str, list[str]] = {}
            for o in voided:
                if close_all.is_close_all(o.client_order_id):
                    by_user.setdefault(o.user_id, []).append(o.client_order_id)
            for user_id, cids in by_user.items():
                close_all.push_summaries_for_children(db, user_id, cids)
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
