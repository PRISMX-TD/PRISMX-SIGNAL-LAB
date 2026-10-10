"""通过 gateway 直连执行一条订单指令（开仓 / 平仓 / 改单）。

从 routers/orders.py 搬出来（2026-09-06）：下单路由与自动仓管（services/auto_manage.py）
都要走这一段，而服务层反过来 import 路由模块是最后一处反向依赖——改路由时会静默
弄坏自动仓管，且测试得把整个路由层拖进来。路由模块现在只是这里的调用方。
公开名不带下划线；routers/orders.py 里保留 `_try_gateway_execute` 等旧名别名。

Executes one order command over the gateway HTTP API. Moved out of
routers/orders.py so services (auto-manage) stop importing a router module.
"""
import logging
from datetime import datetime, timezone

from sqlalchemy import inspect as sa_inspect
from sqlalchemy.exc import DBAPIError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value

from app.models import MT5Account, Order
from app.services import activity_log
from app.services.gateway_binding import is_revoked
from app.services.gateway_client import (
    TradeRsp,
    run_on_main_loop,
    trade_cancel as gw_cancel,
    trade_close as gw_close,
    trade_modify as gw_modify,
    trade_modify_pending as gw_modify_pending,
    trade_open as gw_open,
    trade_pending as gw_pending,
)
from app.services.order_payload import (
    GATEWAY_STALE_ORDER_MESSAGE,
    STALE_ORDER_MESSAGE,
    order_source_tag,
    order_update_payload,
)
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


# 网关自己的返回码（不是 MT5 原生码）：dealer 答了 PLACED，但网关确认后发现仓位
# 手数没变，这笔平仓并未成交。与 gateway/Mt5Link.cs 的 Mt5Link.PlacedUnconfirmed 同值。
# Gateway-issued retcode: the dealer answered PLACED but the position never changed,
# so the close did not execute. Mirrors Mt5Link.PlacedUnconfirmed on the gateway side.
PLACED_UNCONFIRMED = "MT_RET_REQUEST_PLACED_UNCONFIRMED"

# 这些 error 值代表「结果未知」，不代表「被拒绝」——两者在界面上的后果完全相反，
# 前者要说「先核对持仓」，后者才可以说「可以重下」。
#   timeout        网关没在时限内回话
#   request_failed 连接层异常（见 gateway_client 的 except 分支）：请求已经在发或已发出，
#                  可能执行了，只是写请求 / 读响应时断了。分不清就必须按"已执行"
#                  的最坏情况处理。
# 「连接都没建起来」不在这里：gateway_client 把它单独归成 connect_failed（见
# _NOT_SENT_ERRORS），那种情况可以确定什么都没执行。
# These error values mean "outcome unknown", not "rejected" — the UI consequences
# are opposite, and only a rejection may invite a retry. "Never connected" is not
# among them: gateway_client reports it separately as connect_failed (see
# _NOT_SENT_ERRORS), where nothing can have executed.
_UNKNOWN_OUTCOME_ERRORS = frozenset({"timeout", "request_failed"})

# 请求根本没发出去（建连失败 / 建连超时 / 本地连接池排不到连接，见 gateway_client._post）。
# 网关一个字节都没收到，所以既不需要"用同一 clientOrderId 再问一次"，也不该提示
# "可能已执行"——那只会让用户去 MT5 里找一笔不存在的单，或者不敢重下。
# The request never left (connect failure / connect timeout / no pooled connection,
# see gateway_client._post): nothing reached the gateway, so there is nothing to
# re-ask about and no reason to warn "may have executed".
_NOT_SENT_ERRORS = frozenset({"connect_failed"})


# 网关对没见过的路径回的 error 值（HttpServer 的 default 分支，body 里没有 retcode）。
# 它唯一的含义是「这台网关的版本不认识这个接口」——网关是手动拷 .cs 重新编译部署的
# （不跟着 main 自动走），所以后端先上线、网关还没编译的空窗期是**必然会出现**的，
# 不是异常情况。
# The gateway's `error` for an unknown path. It means exactly one thing: that gateway
# build predates this endpoint. The gateway is deployed by hand (copy the .cs, rebuild)
# rather than riding main, so a window where the backend is ahead of it is expected.
_GATEWAY_UNKNOWN_ENDPOINT = "not_found"


# ─────────────────────────────────────────────────────────────────────────────
# 操作日志「结果更正」trade.corrected（设计 §4.2）。订单状态是就地覆写的：一条先被记成
# FAILED（结果未知，超时作废）或 CANCELLED（平台侧撤回）的指令，真实回执迟到后会被改成
# 成交，orders 里从此只剩成交，「它曾经被告诉用户失败过」这件事就没了。这条日志把它留下来。
# 网关（本模块 try_gateway_execute）和桥接（routers/bridge._result_db_work）两条回执路径
# 共用下面三样；都在业务提交**之后**用 activity_log.record_after_commit 写，带
# corrected_key 去重——一条指令最多被更正成成交一次，几条路径重叠时也只记一条。
#
# Activity log "result correction". Order status is overwritten in place, so an
# order once reported FAILED (unknown, voided on timeout) or CANCELLED and later
# confirmed filled keeps no trace of having been reported failed; this event keeps
# it. Shared by the gateway (try_gateway_execute) and bridge (_result_db_work)
# result paths; written after the business commit via record_after_commit, deduped
# on corrected_key since an order flips to filled at most once.
# ─────────────────────────────────────────────────────────────────────────────

# 可以被「更正」的原状态 / prior statuses a late result can correct
CORRECTABLE_STATUSES = frozenset({"FAILED", "CANCELLED"})
# 只记更正成「成功」的：页面那句话是「原记为失败 / 已撤回，实际已成交」（设计 §8）。
# FAILED → REJECTED 之类只是把「不知道」落实成「没成」，订单行自己就显示得清楚，不算更正。
# Only corrections to success are recorded — the page says "reported failed /
# cancelled, actually filled" (design §8). FAILED → REJECTED merely settles an
# unknown as "not executed", which the order row already shows.
_CORRECTED_TO = frozenset({"FILLED", "PLACED"})


def correction_note(prior_message: str | None) -> str | None:
    """被更正之前那条 FAILED 是哪一种超时作废，按作废时写进 orders.message 的固定文案判：
    'timeout' = 桥接超时，用户当时被告知「已自动取消，请重新下单」（STALE_ORDER_MESSAGE）；
    'timeout_unknown' = 直连超时，告知的是「结果未知，先核对持仓」（GATEWAY_STALE_ORDER_MESSAGE）；
    其余 None。页面靠它说出用户当时看到的是什么——「原记为已自动取消」和「原记为结果未知」
    对查重复仓位的管理员是两回事。传进来的必须是**这次回执覆写之前**的 message。
    Which kind of timeout void the corrected FAILED was, from the fixed text the void
    wrote into orders.message: 'timeout' (bridge; the user was told "cancelled,
    re-place it"), 'timeout_unknown' (gateway; "outcome unknown, check first"), else
    None. Lets the page say what the user was actually told. Pass the message from
    *before* this result overwrote it."""
    if prior_message == STALE_ORDER_MESSAGE:
        return "timeout"
    if prior_message == GATEWAY_STALE_ORDER_MESSAGE:
        return "timeout_unknown"
    return None


def correction_snapshot(order: Order, **overrides) -> dict | None:
    """趁字段还在内存里，拍下 trade.corrected 要用的订单字段；overrides 覆盖这次回执改掉的
    值（mt5_login / vol / px）以及 note（correction_note 的结果——order.message 可能已被这次
    回执覆写，所以由调用方用覆写之前的 message 算好传进来，不传就是 None）。纯内存读，不发
    语句；出任何错返回 None（只告警）。
    Snapshot the order fields trade.corrected needs while they are loaded;
    overrides replace what this result changes (mt5_login / vol / px) and supply
    note (correction_note of the pre-result message — order.message may already be
    overwritten, so callers compute it; None when omitted). Memory only; any error
    returns None with a warning."""
    try:
        snap = {
            "id": order.id,
            "user_id": order.user_id,
            "mt5_login": order.mt5_login,
            "action": order.action,
            "sym": order.symbol,
            "side": order.side,
            "vol": order.volume,
            "px": order.filled_price,
            "created_at": order.created_at,
            "note": None,
        }
        snap.update(overrides)
        return snap
    except Exception:
        logger.warning("结果更正快照失败，已跳过 / correction snapshot skipped", exc_info=True)
        return None


def record_correction(snap: dict | None, *, was: str | None, now: str | None, bind) -> None:
    """原状态 was ∈ CORRECTABLE_STATUSES、新状态 now 是成功时，在业务提交之后记一条
    trade.corrected（系统事件，自己的短事务）。其余情况什么都不做。**绝不抛异常**：调用点
    在网关执行的 try 里，一旦抛出会落进异常分支，把刚提交的成交覆写成 FAILED。
    Record trade.corrected (a system event in its own short transaction) after the
    business commit when was is correctable and now is a success; otherwise do
    nothing. Never raises: the gateway call site sits inside try_gateway_execute's
    try, whose except branch would overwrite the fill it just committed with FAILED."""
    try:
        if snap is None or was not in CORRECTABLE_STATUSES or now not in _CORRECTED_TO:
            return
        activity_log.record_after_commit(
            activity_log.TRADE_CORRECTED,
            user_id=snap["user_id"],
            mt5_login=snap["mt5_login"],
            ref_id=snap["id"],
            data={
                "was": was,
                # 'timeout' / 'timeout_unknown' / None，见 correction_note
                # 'timeout' / 'timeout_unknown' / None, see correction_note
                "note": snap.get("note"),
                "action": snap["action"],
                "sym": snap["sym"],
                "side": snap["side"],
                "vol": snap["vol"],
                "px": snap["px"],
                # 原指令的下单时间；本行 created_at 是更正发生的时间。
                # When the command was placed; the row's own created_at is the correction.
                "at": activity_log.iso_utc(snap["created_at"]),
            },
            dedupe_key=activity_log.corrected_key(snap["id"]),
            bind=bind,
        )
    except Exception:
        logger.warning("结果更正操作日志失败，已跳过 / correction activity skipped", exc_info=True)


def _failure_message(rsp: TradeRsp) -> str:
    """把回执拼成一句给用户看的失败原因。

    不能直接写 `rsp.retcode + ": " + rsp.message`：网关的 WriteError 那条路径
    （401 token 不对、403 组不在白名单、404 未知接口）body 里根本没有 retcode，
    于是拼出来的是一句以冒号开头的 `": 未知接口:/trade/pending"`——界面上就这么显示。
    Not a plain `retcode + ": " + message`: the gateway's WriteError responses (bad
    token, group not whitelisted, unknown endpoint) carry no retcode, which produced a
    message that literally started with a colon.
    """
    parts = [p for p in (rsp.retcode, rsp.message) if p]
    return ": ".join(parts)


def apply_trade_result(order: Order, rsp: TradeRsp) -> None:
    """根据 gateway 回执更新订单状态。"""
    if rsp.ok and order.action == "PENDING":
        # 挂单成功的终态是 PLACED，不是 FILLED——它还没成交，只是挂在券商那边等。
        #
        # 借用 FILLED 会让这一笔立刻被当成"已完成的交易"：个人胜率、勋章、
        # 竞赛成绩、管理端「交易过的用户」都按 FILLED 统计，而这笔可能永远不触发。
        # 反过来留在 PENDING 也不行——那是「平台指令还没执行」的意思，5 分钟后会被
        # stale 清扫判定成超时作废，而券商那边的单还好端端挂着。
        #
        # A placed pending order is PLACED, not FILLED: nothing traded yet. Reusing
        # FILLED would immediately count it as a completed trade everywhere (win-rate,
        # badges, competitions, admin stats) for something that may never trigger;
        # leaving it PENDING means "not executed yet" and the stale sweep would void
        # it five minutes later while the order sits happily at the broker.
        order.status = "PLACED"
        # 挂单票号。MT5 里挂单触发后生成的仓位**沿用这张挂单的票号**，所以这里
        # 同时写进 mt5_position——等它成交、再平仓时，平仓明细的归属（按仓位号
        # 匹配，见 order_payload.OPENED_POSITION）不用等任何回填就能对上。
        # The pending ticket. In MT5 the position a pending order opens keeps that
        # order's ticket, so recording it as mt5_position now means the eventual
        # close attributes correctly with no backfill (see OPENED_POSITION).
        order.mt5_ticket = rsp.order or None
        if rsp.order:
            order.mt5_position = rsp.order
        order.message = ""
    elif rsp.ok:
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
        # 成交了但补设 SL/TP 失败时，网关把原因放在 message 里——必须留下，否则
        # 仓位裸奔却毫无记录（2026-10-01 100405）。其它成功回执的 message 是券商的
        # ResultComment 噪音，照旧清空。
        # Keep the gateway's "filled but SL/TP failed" note; other success comments
        # are broker noise and stay cleared.
        order.message = rsp.message if "SL/TP 设置失败" in (rsp.message or "") else ""
    elif rsp.retcode == PLACED_UNCONFIRMED:
        # 网关判定「服务器收下了但没成交」。这既不是成交也不是拒绝：订单确实建立了，
        # 可能还挂在券商队列里，而且会挡住对同一仓位的后续平仓。落 FAILED 而不是
        # REJECTED，界面据此提示「先核对持仓」，不要诱导用户重复提交。
        # Neither a fill nor a rejection: the order exists, may still be queued, and
        # blocks further closes on that position. FAILED, so the UI says "check your
        # positions" instead of inviting a retry.
        order.status = "FAILED"
        order.message = _failure_message(rsp)
    elif rsp.error == _GATEWAY_UNKNOWN_ENDPOINT:
        # 这台网关的版本还不认识这个接口（典型：挂单已经随 main 上线，而网关的
        # .cs 还没拷过去重新编译）。原样透出 "未知接口:/trade/pending" 对用户毫无
        # 意义——他既不知道那是什么，也做不了任何事。说清楚是平台侧还没更新完，
        # 并且明确「你的单没有发出去」，避免他跑去 MT5 里找一张不存在的挂单。
        #
        # 落 REJECTED 而不是 FAILED：请求连端点都没命中，可以确定什么都没执行，
        # 这正是 REJECTED（可以安全重下）的含义。
        #
        # This gateway build predates the endpoint (typically: the feature shipped with
        # main while the gateway's .cs has not been copied over and rebuilt yet).
        # Echoing "unknown endpoint:/trade/pending" tells the user nothing they can act
        # on, so say it is a platform-side version gap and state plainly that nothing
        # was sent — otherwise they go looking in MT5 for an order that never existed.
        # REJECTED, not FAILED: the request never reached an endpoint, so it certainly
        # did not execute, which is exactly what REJECTED means.
        order.status = "REJECTED"
        order.message = (
            "交易网关暂不支持该操作（网关版本待更新），本次指令未发出 / "
            "the trading gateway does not support this operation yet "
            "(pending a gateway update); nothing was sent"
        )
    elif rsp.error in _NOT_SENT_ERRORS:
        # 连不上网关：请求没有发出，可以确定没执行。落 REJECTED（可以安全重下），
        # 提示说清楚是"没发出去"，而不是含糊的"可能已执行、先核对持仓"。
        # Couldn't reach the gateway: nothing was sent, so nothing executed.
        # REJECTED (safe to re-place), and say "not sent" rather than the
        # ambiguous "may have executed, check positions first".
        order.status = "REJECTED"
        order.message = (
            "交易网关暂时连不上，本次指令未发出，可稍后重试 / "
            "could not reach the trading gateway; nothing was sent, please try again shortly"
        )
    elif rsp.error in _UNKNOWN_OUTCOME_ERRORS:
        # 网关没回话、或连接在半路断了，都不等于拒绝：这笔可能已经执行
        # （见 call_gateway_idempotent）。落 FAILED 而不是 REJECTED，界面据此提示
        # "先核对持仓"。
        #
        # request_failed 是 2026-09-19 审计补进来的：httpx 的 RemoteProtocolError /
        # ReadError / ConnectError 此前全落进 else 分支被记成 REJECTED，而其中
        # "请求已发出、读响应时断线"这一类（WireGuard 隧道抖动、网关重启时的半开
        # 连接）很可能已经在网关侧执行了。用户看到"已被拒绝"会用**新的**
        # clientOrderId 重下，而网关的幂等缓存对新键无效——那就是真的重复建仓。
        #
        # No answer, or a connection that died mid-flight, is not a rejection: the
        # order may have executed. FAILED, not REJECTED, so the UI says "check your
        # positions" rather than "declined".
        #
        # request_failed was added by the 2026-09-19 audit: httpx's
        # RemoteProtocolError / ReadError / ConnectError all used to fall into the
        # else branch as REJECTED, yet "request sent, connection died while reading
        # the response" (tunnel flap, gateway restart) very likely did execute. A
        # user told "declined" re-places under a *new* clientOrderId, which the
        # gateway's idempotency cache cannot match — a genuine duplicate position.
        order.status = "FAILED"
        order.message = _failure_message(rsp)
    else:
        order.status = "REJECTED"
        order.message = _failure_message(rsp)


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
    if rsp.error not in _UNKNOWN_OUTCOME_ERRORS and rsp.retcode != "IN_PROGRESS":
        return rsp
    logger.warning(
        "Gateway %s %s 结果未知（error=%s retcode=%s），用同一 clientOrderId 再问一次",
        order.action, order.client_order_id, rsp.error, rsp.retcode,
    )
    again = _once(GATEWAY_RECONCILE_TIMEOUT)
    # 第二问连不上（connect_failed）也仍是「结果未知」：没发出去的只是这次追问，
    # 第一次请求已经发出、可能已执行——绝不能因为追问没连上就落成"未发出、可重试"。
    # A reconcile that fails to connect is still "outcome unknown": only the
    # follow-up went unsent, while the first request did go out and may have
    # executed — it must never be reported as "not sent, safe to retry".
    if (
        again.error in _UNKNOWN_OUTCOME_ERRORS
        or again.error in _NOT_SENT_ERRORS
        or again.retcode == "IN_PROGRESS"
    ):
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


# 券商回了结果、写库却失败：重试，而不是落进下面的异常分支把订单记成 FAILED。那一刻券商
# 已经执行，结果是确定的——丢掉它，订单页就显示「失败」、成交号也没了，用户很可能重下一笔
# （2026-10-10 压测：250 笔以上同时下单时，46 笔已成交的单被这样记成失败）。值得重试的两类：
# 连接池排不上（每次最多 DB_POOL_TIMEOUT 8 秒），以及连接在半路被数据库端掐断（SQLAlchemy
# 已作废连接池，下一次就是新连接）。重写同一组值是幂等的。次数不多：入口排队
# （core/admission.py）已经把同时在途的下单数压住，而且前端整笔交易的等待上限是 160 秒
# （client.ts 的 TRADE_TIMEOUT_MS，按网关最坏 140 秒定的），这里不能把总时长拖过它。
# The broker answered but the write-back failed: retry rather than fall into the except
# branch below, which records FAILED. The outcome is known at that point; dropping it shows
# "failed" with no ticket and invites a duplicate re-order (2026-10-10 load test: 46 filled
# orders recorded as failed at 250+ concurrent). Two failures are worth retrying: no pooled
# connection (up to DB_POOL_TIMEOUT, 8s, each) and a connection killed server-side mid-way
# (SQLAlchemy has dropped the pool; the next try gets a fresh one). Rewriting the same values
# is idempotent. Few attempts: admission (core/admission.py) bounds in-flight orders, and the
# frontend gives a whole trade 160s (TRADE_TIMEOUT_MS, sized for the gateway's 140s worst).
RESULT_WRITE_ATTEMPTS = 2


def _retryable_write_error(e: Exception) -> bool:
    if isinstance(e, PoolTimeoutError):
        return True
    return isinstance(e, DBAPIError) and bool(getattr(e, "connection_invalidated", False))


def _write_with_retry(db: Session, ident: tuple, write) -> None:
    """跑 write()，遇到可重试的写库错误（见 _retryable_write_error）就回滚重来，次数用完原样抛出。
    ident 是事先取好的 (action, clientOrderId, mt5_login)——回滚会让 order 的属性过期，日志里
    再读它们又要查库。
    Run write(), rolling back and retrying on a retryable write error; re-raise when out of
    attempts. ident is captured up front: the rollback expires the order's attributes."""
    for attempt in range(1, RESULT_WRITE_ATTEMPTS + 1):
        try:
            write()
            return
        except Exception as e:
            if not _retryable_write_error(e):
                raise
            db.rollback()
            if attempt == RESULT_WRITE_ATTEMPTS:
                raise
            logger.warning(
                "Gateway 结果写回失败（%s），第 %d 次重试（券商已执行，结果不能丢）: %s %s mt5=%s",
                type(e).__name__, attempt, *ident,
            )


def _column_snapshot(order: Order) -> dict:
    """订单当前已加载的列值，纯内存读、不碰数据库。回滚会让属性过期，兜底时用它原样放回去。
    The order's currently loaded column values, read from memory only; restored after a
    rollback expires them."""
    state = sa_inspect(order)
    return {a.key: state.dict[a.key] for a in state.mapper.column_attrs if a.key in state.dict}


def _restore_columns(order: Order, values: dict) -> None:
    """把列值当作「库里已有的值」放回实例：之后读属性不会再查库，也不算未提交的改动。
    Put column values back as committed state: later reads don't query, nothing is dirty."""
    for key, value in values.items():
        set_committed_value(order, key, value)


def _commit_keep_loaded(db: Session, order: Order) -> None:
    """提交并保持订单字段已加载，省掉紧跟着的 db.refresh 那次 SELECT。

    Order 的列全是 Python 侧默认值（id / created_at / updated_at 的 default、onupdate），
    flush 之后内存里就是最终值；expire_on_commit 默认会把它们全作废，于是原先要 refresh
    再读一遍。这里临时关掉作废（与调网关前那次 commit 同一写法）。updated_at 的
    onupdate 写进内存的是带时区的时间，库里读回来是不带时区的——统一成不带时区，保持
    推送/响应载荷与原先 refresh 后的形状一致。
    Commit while keeping the order's fields loaded, saving the refresh SELECT. All Order
    columns use Python-side defaults so the in-memory values are final after flush; only
    expire_on_commit would discard them. updated_at is written aware in memory but reads
    back naive — normalised to naive so payloads keep their previous shape.
    """
    prev = db.expire_on_commit
    db.expire_on_commit = False
    try:
        db.commit()
    finally:
        db.expire_on_commit = prev
    ua = order.updated_at
    if ua is not None and ua.tzinfo is not None:
        set_committed_value(order, "updated_at", ua.replace(tzinfo=None))


def try_gateway_execute(
    db: Session, order: Order, account: MT5Account | None = None
) -> dict | None:
    """如果是 gateway 来源账号，立即通过 gateway HTTP 执行订单。
    返回 ORDER_UPDATE 推送载荷，或 None（非 gateway 账号）。

    If the target account is gateway-sourced (Make Capital), execute the order
    immediately via the gateway HTTP API. Returns an ORDER_UPDATE push payload,
    or None for non-gateway accounts.
    """
    if account is not None:
        # 调用方已经查过这一行（place_order 的账号列表）：不再查第三遍，但归属与来源
        # 必须自己复核——传进来的行不是本单的 gateway 账号就当非 gateway 处理。
        # The caller already loaded this row: skip the lookup, but re-verify owner,
        # login and source; a row that is not this order's gateway account means
        # "not a gateway order".
        if (
            account.user_id != order.user_id
            or account.login != order.mt5_login
            or account.source != "gateway"
        ):
            return None
    else:
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

    # 调网关之前先把事务结束掉，把数据库连接还回池里。否则这个会话会一直攥着一条
    # 连接等 dealer 回执（最长 65 秒，超时再问一次共 140 秒），而池子总共只有
    # DB_POOL_SIZE + DB_MAX_OVERFLOW（默认 8+4=12，每个 worker 各一池）条：一波行情里第
    # 13 笔在途交易起，整个 worker——不止下单——都在排队等连接，等满 pool_timeout（8 秒）就直接报错。
    # expire_on_commit 暂时关掉，下面组请求要读的字段就不会被作废、不会为此再
    # 去查一次库。此时 order 早已落库（调用方先 commit 了 PENDING），这里提交的
    # 只是上面几次查询开的只读事务；调用方若还有未提交的改动，原本也会在本函数
    # 末尾那次 commit 一起提交，并不改变语义。
    #
    # End the transaction before the gateway call so the connection goes back to
    # the pool. Otherwise the session holds one for the whole dealer wait (65s, 140s
    # with the re-ask) out of a pool of DB_POOL_SIZE + DB_MAX_OVERFLOW (12 by
    # default, 8+4, one pool per worker): from the 13th in-flight trade the whole worker queues for a
    # connection and errors at pool_timeout (8s). expire_on_commit is switched off for
    # this one commit so the fields read below stay loaded. The order row is
    # already committed by the caller; any other pending change would have been
    # committed by this function's final commit anyway.
    #
    # 同一次提交顺手把订单标成「已下发」。撤单接口只认 delivered 拦截在途指令，而这个
    # 标记原先只有桥接轮询会打：网关单在等 dealer 回执的整整几十秒里一直是「PENDING、
    # 未下发」，用户此刻点撤销会成功显示「已撤销」，几秒后下面的结果写入又按 id 把它
    # 覆写成 FILLED——与 2026-09-19 修掉的桥接那个窗口一模一样。打上标记后撤单返回 409；
    # 超时作废仍由 is_stale_pending（按 created_at）兜底，网关最长等待 140 秒远小于它。
    # The same commit marks the order delivered. Cancel only blocks in-flight commands
    # via `delivered`, which used to be set by the bridge poll alone: for the tens of
    # seconds a gateway order waits on the dealer it sat "PENDING, undelivered", so a
    # cancel succeeded with "cancelled" and the result write below then overwrote it
    # by id to FILLED — the very window fixed for the bridge on 2026-09-19. Now cancel
    # returns 409; the stale void still applies via is_stale_pending (created_at), far
    # beyond the gateway's 140s worst case.
    order.delivered = True
    order.delivered_at = datetime.now(timezone.utc)
    prev_expire = db.expire_on_commit
    db.expire_on_commit = False
    try:
        db.commit()
    finally:
        db.expire_on_commit = prev_expire

    # 调网关前（字段都在内存里）先记下写回兜底要用的东西：日志标识、订单列值、账号的 trade_mode。
    # 写回失败回滚之后它们都会过期，账号行甚至可能在等券商的这段时间被删掉。
    # Before the gateway call (fields still in memory), keep what the write-back fallback
    # needs: the log identity, the order's columns, the account's trade_mode. A rollback
    # expires them all, and the account row may even be deleted while we wait.
    ident = (order.action, order.client_order_id, order.mt5_login)
    snapshot = _column_snapshot(order)
    account_trade_mode = account.trade_mode
    rsp: TradeRsp | None = None

    def _stamp_trade_mode() -> None:
        # 打 trade_mode 章：用上面记下的账号值，不再单独查一次 mt5_accounts
        # （规则同 gamification.stamp.stamp_order_trade_mode）。
        # Stamp trade_mode from the value kept above instead of another mt5_accounts query
        # (same rule as gamification.stamp.stamp_order_trade_mode).
        from app.services.gamification.stamp import is_stampable
        if (
            is_stampable(order.status, order.action)
            and order.trade_mode is None
            and account_trade_mode is not None
        ):
            order.trade_mode = account_trade_mode

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
                order_source_tag(order),
                client_order_id=order.client_order_id or "",
                timeout=timeout,
            ))
        elif order.action == "PENDING":
            # 品种名同开仓：发券商基础名，后缀由网关按账号组解析。
            # Same symbol handling as an open: broker base name, gateway adds the suffix.
            rsp = call_gateway_idempotent(order, lambda timeout: gw_pending(
                login, broker_symbol(order.symbol),
                order.pending_type or "", order.volume or 0.01, order.price or 0,
                order.sl or 0, order.tp or 0,
                order_source_tag(order),
                client_order_id=order.client_order_id or "",
                timeout=timeout,
            ))
        elif order.action == "MODIFY_PENDING":
            # price / sl / tp 原样透传：None = 这一项没说，网关保留现值。
            # 与 MODIFY 分支同理，绝不能写 `or 0`——那会把「没说」变成「清除」。
            # Passed through as-is: None means unspecified and the gateway keeps the
            # current value. As in the MODIFY branch, never `or 0`.
            rsp = call_gateway_idempotent(order, lambda timeout: gw_modify_pending(
                login, order.ticket or 0, order.price, order.sl, order.tp,
                client_order_id=order.client_order_id or "",
                timeout=timeout,
            ))
        elif order.action == "CANCEL_PENDING":
            rsp = call_gateway_idempotent(order, lambda timeout: gw_cancel(
                login, order.ticket or 0,
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
            # sl / tp 原样透传：None 表示「这一侧没说」，gateway_client 会发成 null、
            # 网关保留现值；0 才是清除。写成 `or 0` 会把两者混为一谈（见 trade_modify 注释）。
            # Pass sl/tp through as-is: None means "unspecified" (sent as null, gateway
            # keeps the current value); 0 is an explicit clear. `or 0` conflates the two.
            #
            # 同样走「超时再问一次」：改单没有 clientOrderId 缓存，第二问就是再改一次，
            # 而设成同一组 SL/TP 天然幂等，重发无害。这样超时落 FAILED（请核对）
            # 而不是 REJECTED——止损可能已经改上了。
            # Also via the timeout re-ask: with no clientOrderId cache the second ask
            # re-sends the modify, harmless since setting the same SL/TP is idempotent.
            # A timeout now lands as FAILED ("check"), not REJECTED.
            rsp = call_gateway_idempotent(order, lambda timeout: gw_modify(
                login, order.ticket or 0, order.sl, order.tp,
                timeout=timeout,
            ))
        else:
            order.status = "FAILED"
            order.message = f"未知指令类型: {order.action}"
            db.commit()
            db.refresh(order)
            return order_update_payload(order)

        # 撤单已被上面的 delivered 标记拦住；万一库里的状态还是在等待期间被别处改掉了
        # （超时作废、人工改库），仍然写入真实结果——券商那边确实执行了，账面必须跟着
        # 成交走——但留一条告警，不让「已撤销→已成交」悄无声息地发生。
        # Cancels are blocked by the delivered flag above. Should the row still have
        # been changed while we waited (stale void, manual edit), the real result is
        # written anyway — the broker did execute, so the books must follow — but with
        # a warning, so a "cancelled → filled" flip is never silent.
        # 同一条 SELECT 顺带取 message：作废时写的是哪句文案，操作日志「结果更正」要用（见
        # correction_note）；下面 apply_trade_result 会覆写内存里的 message。不加语句。
        # The same SELECT also fetches message — which void wording was written, for
        # the activity log's correction (see correction_note); apply_trade_result
        # overwrites the in-memory one below. No extra statement.
        def _write_back() -> None:
            db_row = db.query(Order.status, Order.message).filter(Order.id == order.id).first()
            db_status, db_message = (db_row[0], db_row[1]) if db_row is not None else (None, None)
            if db_status is not None and db_status != "PENDING":
                logger.warning(
                    "Gateway 结果到达时订单已是 %s，按真实执行结果覆写: %s %s mt5=%s",
                    db_status, order.action, order.client_order_id, order.mt5_login,
                )
            apply_trade_result(order, rsp)
            _stamp_trade_mode()
            _commit_keep_loaded(db, order)
            # 等待期间被作废 / 撤回、结果却是成交：记一条「结果更正」。db_status 是上面那次读到的
            # 原状态；字段都还在内存里（_commit_keep_loaded 不作废），会话的连接已在提交时归还，
            # 日志的短事务不会与它同时占两条连接。record_correction 从不抛异常——这里抛出就会
            # 落进下面的异常分支，把刚提交的成交覆写成 FAILED。
            # Voided / cancelled while we waited but actually filled: record a correction.
            # db_status is the prior status read above; fields are still loaded and the
            # session already returned its connection, so the log's short transaction
            # never holds a second one. record_correction never raises — raising here
            # would land in the except branch and overwrite the committed fill with FAILED.
            if db_status in CORRECTABLE_STATUSES:
                record_correction(
                    correction_snapshot(order, note=correction_note(db_message)),
                    was=db_status, now=order.status, bind=db,
                )

        _write_with_retry(db, ident, _write_back)

        # 网关耗时并排打出来（gateway_ms 是网关侧总耗时，dealer_ms 是其中等券商回执
        # 的部分）：用户说"下单慢"时，这一行就能分出是网关内部慢还是券商 dealer 慢。
        # 后端自己这一段（落库、HTTP 往返）的耗时看 uvicorn 访问日志里同一请求的时长。
        # Gateway timings side by side (gateway_ms = gateway total, dealer_ms = broker
        # wait within it) so a slow-order report can be split gateway vs broker.
        logger.info(
            "Gateway 执行完成: %s %s mt5=%s -> %s deal=%s order=%s gateway_ms=%s dealer_ms=%s",
            order.action, order.client_order_id, order.mt5_login,
            order.status, rsp.deal, rsp.order, rsp.elapsed_ms, rsp.dealer_ms,
        )
        return order_update_payload(order)

    except Exception as e:
        logger.error("Gateway 执行异常: %s %s", ident[1], e)
        if rsp is not None and _retryable_write_error(e):
            # 重试用尽仍写不进去，但券商的回话就在手里：最后再试一次写真实结果，绝不写 FAILED。
            # 回滚让订单字段过期了，先把调网关前记下的列值原样放回（不查库），再套上券商结果。
            # 还写不进去：成交号打进 CRITICAL 日志供人工对账，内存里按快照回一帧 FAILED
            # （界面语义「先核对持仓」）并带成交号——调用方随后 _serialize(order) 读的都是内存，
            # 不会再去碰数据库、变成一个让人重下单的「服务繁忙」。
            # Out of retries, but the broker's answer is in hand: one last attempt to record the
            # real outcome, never FAILED. The rollback expired the order, so the columns kept
            # before the gateway call are put back (no query) and the broker result applied. If
            # that fails too, log the tickets at CRITICAL for manual reconciliation and answer
            # FAILED ("check your positions") with the deal number, all from memory — callers
            # then _serialize(order) without touching the database, instead of a "busy" error
            # that invites a re-order.
            try:
                db.rollback()
                _restore_columns(order, snapshot)
                apply_trade_result(order, rsp)
                _stamp_trade_mode()
                _commit_keep_loaded(db, order)
                return order_update_payload(order)
            except Exception as inner:
                db.rollback()
                logger.critical(
                    "Gateway 已执行但结果写不进数据库，请人工对账: %s %s mt5=%s ok=%s deal=%s order=%s "
                    "position=%s: %s",
                    *ident, rsp.ok, rsp.deal, rsp.order, rsp.position, inner,
                )
                deal = rsp.deal or rsp.order or "-"
                _restore_columns(order, {
                    **snapshot,
                    "status": "FAILED",
                    "message": (
                        f"券商已回执（成交号 {deal}），但平台记录暂时写入失败，请先核对持仓，不要重复下单 / "
                        f"the broker answered (deal {deal}) but the platform could not record it yet; "
                        "check your positions before placing again"
                    ),
                })
                return order_update_payload(order)
        # 先回滚再写。异常很可能就是上面那次 commit 抛的（约束冲突、连接断、
        # 数值越界……），此时事务已经作废，不回滚就直接 commit 会抛
        # PendingRollbackError，把一个"落 FAILED"的补救动作变成 500——订单留在
        # PENDING，5 分钟后被 stale 判定作废，而券商那边可能真成交了。
        #
        # 这段本身也可能失败（数据库彻底连不上），所以再包一层：宁可日志里留下
        # "连状态都写不回去"，也不要让异常盖掉上面那条更有信息量的 logger.error。
        #
        # Roll back before writing. The exception is quite likely the commit above
        # (constraint, dropped connection, numeric overflow); the transaction is
        # then already void and committing again raises PendingRollbackError,
        # turning this FAILED-recording fallback into a 500. The order would stay
        # PENDING, get voided by the stale sweep five minutes later — while the
        # broker may actually have filled it.
        #
        # This recovery can itself fail (database unreachable), so it is wrapped:
        # better a log line saying we could not even record the status than an
        # exception masking the more informative error above.
        try:
            db.rollback()
            order.status = "FAILED"
            order.message = f"Gateway 执行异常: {e}"
            db.commit()
            db.refresh(order)
        except Exception as inner:
            logger.error(
                "Gateway 执行异常后连状态都没能写回: %s %s",
                order.client_order_id, inner,
            )
            db.rollback()
            # 内存里的对象仍按 FAILED 返回，让调用方推一帧给前端；库里那条会由
            # stale 判定兜底。/ Return FAILED from the in-memory object so the caller
            # still pushes a frame; the row is left to the stale sweep.
            order.status = "FAILED"
            order.message = f"Gateway 执行异常: {e}"
        return order_update_payload(order)
