"""一键平仓：把一个账号（或全部账号）当下的持仓一次排成 CLOSE 指令。

为什么要在服务端做成"一批"，而不是让前端循环调 /orders/close：

1. **限流**：下单类端点按 IP 限流（RATE_LIMIT_ORDER，120/分钟），而开仓 / 平仓 / 改单
   共用这一个桶，同一出口 IP 下的多个用户也共用。仓位多的人一次循环就能把这
   一分钟的额度吃掉大半，额度用完的那几笔被 429 挡下——用户按的是"全部平仓"，
   结果平了一半，这比不给这个按钮还糟。
2. **推送**：每条回执都会发一条 Web Push（见 routers/bridge.bridge_result），
   十笔仓位就是十条通知。一次操作应该只响一次。
3. **半途而废**：循环跑到第三笔时页面被切走、网络断了、手机息屏了，剩下的仓位
   没人管，而用户以为"全部平仓"已经做完。落库是一次事务，桥接或网关照单执行。

批次的编号规则：客户端送一个普通的 clientOrderId（与别处同一个生成器），服务端
拼成 `ca_<cid>#<ticket>` 作为每条子指令的 clientOrderId。这样
  · 同一批里每条子指令各有唯一 id，(user_id, client_order_id) 唯一约束照旧生效；
  · 整批的 id 有共同前缀 `ca_<cid>#`，回执阶段能反查"这一批还有没有没回来的"；
  · 客户端重试（网络抖动补发同一个请求）不会重复下指令——唯一约束挡住。

One-click "close everything". Done server-side as one batch rather than a
frontend loop over /orders/close, because that loop shares one per-IP bucket
with opens and modifies (and with everyone behind the same egress IP), so a
large batch can end up half-closed on a 429 — worse than no button at all. It
would also fire one Web Push per position, and abandon the rest if the page
went away mid-loop. Child commands are keyed `ca_<cid>#<ticket>` so each is
unique, the batch is greppable at ack time, and a client retry is idempotent.
"""
import logging
import uuid

from sqlalchemy.orm import Session

from app.models import MT5Account, Order
from app.services.gateway_binding import not_removed

logger = logging.getLogger("prismx.close_all")

# 子指令 clientOrderId 的前缀与分隔符。前缀让回执侧一眼认出"这是一键平仓的
# 子指令"（与自动仓管的 AUTO_PREFIX 同一个套路）；分隔符选 `#` 而不是 `_`，
# 因为客户端生成的 id 本身就含 `_`（co_xxx_yyy），用 `_` 切不出批次。
# Prefix + separator for child ids. The prefix marks the command the way
# AUTO_PREFIX does for auto-management; `#` separates because the client id
# itself contains `_` (co_xxx_yyy) and would be unsplittable.
CLOSE_ALL_PREFIX = "ca_"
_SEP = "#"

# 汇总推送的去重键存活时间：一批指令从落库到全部回执，最坏是 stale 兜底的
# 5 分钟，再留一点余量。/ TTL of the "summary already pushed" marker: a batch
# resolves within the 5-minute stale sweep at worst, plus slack.
_SUMMARY_MARK_TTL = 900


def batch_id(client_order_id: str) -> str:
    """客户端 id → 批次 id / client id -> batch id."""
    return f"{CLOSE_ALL_PREFIX}{client_order_id}"


def child_order_id(batch: str, ticket: int) -> str:
    return f"{batch}{_SEP}{ticket}"


def is_close_all(client_order_id: str | None) -> bool:
    return bool(client_order_id) and client_order_id.startswith(CLOSE_ALL_PREFIX)


def batch_of(client_order_id: str | None) -> str | None:
    """子指令 id → 它所属的批次 id；不是一键平仓的指令返回 None。
    Child id -> its batch id; None for anything that isn't a close-all child."""
    if not is_close_all(client_order_id):
        return None
    head = client_order_id.split(_SEP, 1)[0]
    return head or None


def _like_pattern(batch: str) -> str:
    """把批次 id 转义成 LIKE 模式。

    批次 id 里必然含 `_`（客户端生成器是 `co_<时间>_<随机>`），而 `_` 在 LIKE 里
    是"任意一个字符"的通配符——不转义的话 `ca_co_a1_b2#%` 会匹配到别的批次。
    `%` 同理：clientOrderId 是用户可控的字符串，不转义等于让人构造出能匹配自己
    全部订单的模式，汇总数字就会失真。
    Escape the batch id for LIKE: it always contains `_` (the client generator is
    `co_<time>_<rand>`), which is LIKE's single-character wildcard, and
    clientOrderId is user-supplied so `%` must be escaped too.
    """
    esc = batch.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"{esc}{_SEP}%"


def batch_orders(db: Session, user_id: str, batch: str) -> list[Order]:
    """这一批的全部子指令 / every child command in the batch."""
    return (
        db.query(Order)
        .filter(
            Order.user_id == user_id,
            Order.client_order_id.like(_like_pattern(batch), escape="\\"),
        )
        .order_by(Order.created_at.asc())
        .all()
    )


def queue(
    db: Session,
    user_id: str,
    client_order_id: str,
    mt5_login: str | None,
    positions: list,
) -> tuple[str, list[Order], int]:
    """把 `positions` 里属于本次范围的仓位排成 CLOSE 指令并落库（一次提交）。

    返回 (批次 id, 新建的指令, 跳过的仓位数)。**不执行、不推送**——执行分两条路
    （桥接轮询 / 网关直连），推送要等这一批全部有结果，都由调用方安排。

    跳过两类仓位：没有 ticket 的（旧记录，无法定位）、已经有一条 PENDING CLOSE
    指令挂着的。后者是防连点：用户看仓位没立刻消失又按了一次，不挡的话同一张
    仓位会收到两条平仓指令——第二条多半被券商拒掉，但那是白白多一条失败回执，
    而且在"部分成交"的窗口里真有可能多平。

    Persist one CLOSE command per in-scope position, in a single commit. Returns
    (batch id, new commands, skipped count); execution and notification are the
    caller's job. Positions without a ticket, or already covered by a PENDING
    CLOSE, are skipped — the latter guards against a double tap sending two
    closes for one position.
    """
    batch = batch_id(client_order_id)

    wanted = []
    for p in positions:
        try:
            ticket = int(p.get("ticket") or 0)
        except (TypeError, ValueError):
            ticket = 0
        if ticket <= 0:
            continue
        login = p.get("login") or None
        # 指定了账号就只平那个账号的仓；仓位没带 login（旧记录）时按"属于当前
        # 范围"处理，下发目标回落到请求里的账号。
        # Scoped to one account when asked; a login-less position (legacy rows)
        # falls back to the requested account as its target.
        if mt5_login and login and str(login) != str(mt5_login):
            continue
        wanted.append((ticket, p, str(login) if login else mt5_login))

    if not wanted:
        return batch, [], 0

    tickets = [t for t, _, _ in wanted]
    busy = {
        row[0]
        for row in db.query(Order.ticket)
        .filter(
            Order.user_id == user_id,
            Order.status == "PENDING",
            Order.action == "CLOSE",
            Order.ticket.in_(tickets),
        )
        .all()
    }
    # 同一个 clientOrderId 重来一次（网络抖动的自动重发）不该再下一遍指令。上面
    # 的 PENDING 闸门挡得住"还没执行完"的情况，这里再按批次本身对一次，连"上一批
    # 已经执行完了"的重放也挡掉——否则唯一约束会让整批 commit 一起失败。
    # Replay of the same clientOrderId must not re-queue. The PENDING gate covers
    # an in-flight batch; matching the batch itself also covers a finished one,
    # which would otherwise fail the whole commit on the unique constraint.
    busy |= {o.ticket for o in batch_orders(db, user_id, batch) if o.ticket is not None}

    created: list[Order] = []
    skipped = 0
    for ticket, p, login in wanted:
        if ticket in busy:
            skipped += 1
            continue
        created.append(
            Order(
                user_id=user_id,
                client_order_id=child_order_id(batch, ticket),
                action="CLOSE",
                symbol=p.get("symbol") or "",
                side=p.get("side") or "BUY",
                # 0 = 全平。一键平仓只做全平，不碰部分平仓的手数/步长那一摊。
                # 0 means full close; this feature never does partials, so the
                # per-symbol lot-step rules don't apply here.
                volume=0.0,
                ticket=ticket,
                mt5_login=login,
                status="PENDING",
            )
        )

    if not created:
        return batch, [], skipped

    db.add_all(created)
    db.commit()
    for o in created:
        db.refresh(o)
    return batch, created, skipped


def gateway_logins(db: Session, user_id: str) -> set[str]:
    return {
        row[0]
        for row in db.query(MT5Account.login)
        .filter(
            MT5Account.user_id == user_id,
            MT5Account.source == "gateway",
            not_removed(),
        )
        .all()
    }


def execute_gateway_batch(user_id: str, batch: str, order_ids: list[str]) -> None:
    """后台执行这一批里落在 gateway 账号上的平仓，逐条推 ORDER_UPDATE。

    **为什么必须放后台**：单条网关平仓最坏要等 65 秒（等不到还会用同一个
    clientOrderId 再问一次，共 140 秒，见 gateway_execute.call_gateway_idempotent）。
    十笔仓位串在一个 HTTP 请求里，请求早就被中间层掐断了，而用户既看不到进度也
    不知道到底平掉了几笔。所以接口在落库后立刻返回"已受理"，真正的执行在这里
    进行，结果沿既有的 ORDER_UPDATE / POSITIONS 推送回前端——和桥接账号的体感
    完全一致。

    单条失败只影响它自己（try_gateway_execute 内部已把异常落成 FAILED），这里
    再兜一层，保证一条炸掉不会让同批其余的不执行、也不会让汇总推送发不出去。

    Runs the gateway-side closes off the request. A single gateway close can
    block for 65s (140s counting the idempotent re-ask), so N of them serially
    would blow past any sane request timeout; the endpoint acks after the commit
    and the results arrive over the existing ORDER_UPDATE / POSITIONS pushes,
    exactly like a bridge account behaves. One failure never stops the rest.
    """
    from app.core.database import SessionLocal
    from app.services import gateway_execute
    from app.services.connection_manager import manager
    from app.services.gateway_client import run_on_main_loop

    db = SessionLocal()
    try:
        orders = db.query(Order).filter(Order.id.in_(order_ids)).all() if order_ids else []
        for order in orders:
            if order.status != "PENDING":
                continue
            try:
                payload = gateway_execute.try_gateway_execute(db, order)
            except Exception:
                logger.exception(
                    "close_all: gateway 执行失败 (user=%s cmd=%s)", user_id, order.client_order_id
                )
                continue
            if payload is None:
                continue
            try:
                run_on_main_loop(manager.push_to_client(user_id, payload), timeout=5.0)
            except Exception:
                logger.warning("close_all: ORDER_UPDATE 推送失败 (cmd=%s)", order.client_order_id)
        push_summary_if_done(db, user_id, batch)
    except Exception:
        logger.exception("close_all: 批次执行异常 (user=%s batch=%s)", user_id, batch)
    finally:
        db.close()


def push_summary_if_done(db: Session, user_id: str, batch: str) -> None:
    """整批都有结果了才发一条汇总推送；还有 PENDING 就什么都不做。

    一次"全部平仓"只该响一次。逐条回执的推送在 routers/bridge.bridge_result 里
    按前缀跳过（与自动仓管同一处理），改由这里收口。

    调用点有三处（网关后台执行结束、桥接回执、超时兜底作废），并发下可能有两条
    同时看到"没有 PENDING 了"，所以用一把一次性的分布式标记去重——owner 传随机
    值，try_lock 才是真正的"只有第一个能拿到"（同 owner 重入会续期并返回 True）。

    One summary push per batch, sent only once every child has a terminal status.
    Three call sites can race into "nothing pending left", so a one-shot marker
    dedupes; the owner must be random because try_lock renews (and returns True)
    for the same owner.
    """
    from app.services import shared_state
    from app.services.push_dispatch import (
        EVENT_ORDER_FILLED,
        EVENT_ORDER_REJECTED,
        dispatch_event_push,
    )

    rows = batch_orders(db, user_id, batch)
    if not rows or any(o.status == "PENDING" for o in rows):
        return

    filled = sum(1 for o in rows if o.status == "FILLED")
    unresolved = len(rows) - filled

    if not shared_state.try_lock(
        f"closeall-summary:{user_id}:{batch}", _SUMMARY_MARK_TTL, owner=uuid.uuid4().hex
    ):
        return

    if unresolved == 0:
        title = "一键平仓完成"
        body = f"{filled} 笔持仓已全部平掉"
        event = EVENT_ORDER_FILLED
    else:
        # 措辞不能说"被拒绝"：这一批里既可能有真被拒的，也可能有"结果未知"的
        # （网关两次超时、桥接一直没上线被作废）。后者最危险的动作就是重下，
        # 所以统一引导去核对持仓。见 close-must-confirm-fill 的教训。
        # Never say "rejected": the batch can mix real rejections with unknown
        # outcomes, where a retry is the dangerous move. Send them to verify.
        title = "一键平仓未全部完成"
        body = (
            f"已平 {filled} 笔，{unresolved} 笔未确认成交，"
            "请在 MT5 核对持仓后再决定是否重试"
        )
        event = EVENT_ORDER_REJECTED

    # 一条批次级的结果日志：用户说“我点了全部平仓，可是……”时，运维能一行看完
    # 这批一共几笔、成了几笔，不用去拼每条子指令的回执。
    # One batch-level line so a "I pressed close-all and..." report can be read
    # off the log without reassembling each child command's ack.
    logger.info(
        "close_all: 批次结束 user=%s batch=%s 共 %d 笔，成交 %d，未确认 %d",
        user_id, batch, len(rows), filled, unresolved,
    )
    try:
        dispatch_event_push(user_id, event, title, body)
    except Exception:
        logger.exception("close_all: 汇总推送失败 (user=%s batch=%s)", user_id, batch)


def push_summary_for_child(db: Session, user_id: str, client_order_id: str | None) -> None:
    """回执侧的入口：这条指令属于某一批就检查该批是否已经全部有结果。
    Ack-side entry point: if this command belongs to a batch, check the batch."""
    push_summaries_for_children(db, user_id, [client_order_id])


def push_summaries_for_children(db: Session, user_id: str, client_order_ids) -> None:
    """一次处理多条子指令（超时兜底会一口气作废一整批），每个批次只检查一次。

    没有这一步的话，桥接从头到尾没上线的那一批会在 5 分钟后被静默作废：订单页
    看得到，推送里一个字都没有——而"我点了全部平仓"的人最需要知道的就是"其实
    一笔都没平"。
    Handle several children at once (the stale sweep voids a whole batch in one
    go), checking each batch once. Without this, a batch the bridge never came
    back for would be voided silently — and "nothing actually closed" is exactly
    what the person who pressed the button needs to hear.
    """
    seen: set[str] = set()
    for cid in client_order_ids:
        batch = batch_of(cid)
        if batch and batch not in seen:
            seen.add(batch)
            push_summary_if_done(db, user_id, batch)
