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
拼成 `ca_<cid>#<login>#<ticket>`（仓位没带账号时是 `ca_<cid>#<ticket>`）作为每条
子指令的 clientOrderId。账号必须进 id：票号只在一个 MT5 账号内唯一，用户两个账号
（尤其不同券商）撞上同一个票号时，不带账号的两条子指令会撞唯一约束、整批 500。这样
  · 同一批里每条子指令各有唯一 id，(user_id, client_order_id) 唯一约束照旧生效；
  · 整批的 id 有共同前缀 `ca_<cid>#`，回执阶段能反查"这一批还有没有没回来的"；
  · 客户端重试（网络抖动补发同一个请求）不会重复下指令——唯一约束挡住。

One-click "close everything". Done server-side as one batch rather than a
frontend loop over /orders/close, because that loop shares one per-IP bucket
with opens and modifies (and with everyone behind the same egress IP), so a
large batch can end up half-closed on a 429 — worse than no button at all. It
would also fire one Web Push per position, and abandon the rest if the page
went away mid-loop. Child commands are keyed `ca_<cid>#<login>#<ticket>`
(`ca_<cid>#<ticket>` for a login-less position) so each is unique — the login is
needed because a ticket is only unique within one MT5 account, and two of a
user's accounts sharing a ticket number used to collide on the unique constraint
and 500 the whole batch — the batch is greppable at ack time, and a client retry
is idempotent.
"""
import logging
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

from sqlalchemy import or_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import set_committed_value

from app.models import MT5Account, Order
from app.services import activity_log
from app.services.gateway_binding import not_removed

logger = logging.getLogger("prismx.close_all")

# 一次"全部平仓"里同时发往网关的平仓笔数上限。网关全局同时在途 64 笔（gateway.ini 的
# max_inflight_trades），这里取一半：一个人的一键平仓最多占一半名额，剩下的留给其他
# 用户的单。2026-11-16 从 16 调到 32——48 笔的批次原来要排 3 轮，现在 2 轮。
# Closes sent to the gateway at once per batch. The gateway allows 64 trades in flight
# overall (max_inflight_trades); half of that keeps the other half free for everyone
# else. Raised from 16 on 2026-11-16: a 48-leg batch took three waves, now two.
CLOSE_ALL_PARALLEL = 32
# 准备完过了这么久才轮到的那一笔，发之前再看一眼它还是不是 PENDING（2026-11-17 审查）。
# 正常一批几百毫秒发完，用不着；超过 32 笔、券商又卡住时，后几批要等前面的跑完（单笔最坏
# 140 秒），期间它可能已被过期清理作废、用户也被告知「超时」——再发出去就是一笔多余的平仓。
# A leg whose turn comes this long after preparation re-reads its status before sending.
# A normal batch is out in a few hundred ms and never needs it; past 32 legs with a stuck
# broker, later waves wait for earlier calls (140s worst case each), by which time the
# stale sweep may have voided the leg and told the user it timed out — sending it then is
# a stray close.
CLOSE_ALL_RECHECK_AFTER_S = 15.0

# 一次"全部平仓"最多排多少笔（审计 A2）。正常用户远到不了；超出的这次不排，再按一次即可。
# 防的是一份被塞满的持仓快照把一个请求放大成成千上万条指令与网关调用。
# Cap on closes queued by one close-all (audit A2). Real users never get near it; the
# rest can be closed with another press. Stops one stuffed snapshot from fanning a
# single request out into thousands of commands and gateway calls.
CLOSE_ALL_MAX_POSITIONS = 200

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


def child_order_id(batch: str, ticket: int, login: str | None = None) -> str:
    """子指令 id。带上账号：票号只在单个账号内唯一（见模块说明）。批次 id 仍是
    第一个 `#` 之前的部分，batch_of 不受影响。
    Child id. Carries the login since a ticket is only unique per account (see the
    module docstring); the batch is still everything before the first `#`."""
    if login:
        return f"{batch}{_SEP}{login}{_SEP}{ticket}"
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


def _log_batch(db: Session, user_id: str, batch: str, created: list[Order], skipped: int) -> None:
    """一键平仓记操作日志 trade.close_all（设计 §4.2）：这一批涉及几个账号就记几行，每行
    data {count: 这个账号排下去的子单数, skipped: 整批跳过的仓位数}，ref_id = 批次号。

    每账号一行是因为页面按 MT5 账号筛选、按账号显示；子单的成交与否不在这里记——读接口
    按批次号去 orders 里实时数（close_all.batch_orders）。

    带去重键 'ca:<user>:<批次>:<login>'（与 rev 38 补录同格式）：同一个 clientOrderId 的
    并发重放，输家在 flush 时就撞上子单的唯一约束（业务自己的异常，照常上抛，与原来在
    commit 时抛出一样），万一赢了的那批又补排了几笔，也不会再多出一行。按 login 排序写（多行
    INSERT 里 Postgres 也按这个顺序逐行取键），两个事务不会以相反顺序去抢同一组键。组装出错
    只告警跳过。

    One trade.close_all row per account in the batch, data {count, skipped},
    ref_id = the batch id. Per account because the page filters and displays by
    MT5 login; fills are not recorded here — the reader counts the batch's children
    live. Keyed 'ca:<user>:<batch>:<login>' (the rev 38 backfill's format): a
    concurrent replay of the same clientOrderId loses on the children's unique
    constraint at flush (the business's own error, raised as it used to be at
    commit), and a later top-up of the same batch adds no second row. Written in
    login order so two transactions never take the keys in opposite orders.
    Composition errors only warn.

    几个账号一次写完（activity_log.log_events）：一次 flush + 一个 SAVEPOINT 里一条多行
    INSERT，共 3 条语句，不随账号数增加——它们都排在放出平仓指令的那次 commit 前面。
    All accounts in one go (activity_log.log_events): one flush and one multi-row
    INSERT in one SAVEPOINT, 3 statements whatever the account count — they all sit
    ahead of the commit that releases the closes.
    """
    try:
        counts: dict[str | None, int] = {}
        for o in created:
            counts[o.mt5_login] = counts.get(o.mt5_login, 0) + 1
        events = [
            {
                "kind": activity_log.TRADE_CLOSE_ALL,
                "user_id": user_id, "mt5_login": login, "actor_id": user_id, "ref_id": batch,
                "data": {"count": n, "skipped": skipped},
                "dedupe_key": activity_log.close_all_key(user_id, batch, login),
            }
            for login, n in sorted(counts.items(), key=lambda kv: kv[0] or "")
        ]
    except Exception:
        logger.warning("一键平仓操作日志组装失败，已跳过 / close-all activity skipped: batch=%s",
                       batch, exc_info=True)
        return
    activity_log.log_events(db, events)


def _row_ticket(p) -> int:
    try:
        return int(p.get("ticket") or 0)
    except (TypeError, ValueError, AttributeError):
        return 0


def drop_unverified_gateway_rows(
    positions: list,
    by_source: dict,
    gateway_logins: set[str],
    mt5_login: str | None,
) -> list:
    """去掉「落在 gateway 账号上、却不在网关自己那份持仓里」的行（审计 A2）。

    合并快照里的桥接那一路是桥接令牌原样上报的，任何人都能在里面写一行自称是自己网关
    账号的仓位；一键平仓按行里的 login 分流，每一行都会变成一次网关 /trade/close。网关
    账号的仓位只认网关那一路（键 (login, ticket)）。没带 login 的行按请求里的账号算目标，
    同样要过这一关。

    by_source 为空（这个用户压根没有任何来源的快照）时原样返回：此时合并快照也是空的，
    没东西可放大；by_source 有内容而缺 "gateway" 键，视为网关那一路为空。

    Drop rows that target a gateway account but are not in the gateway's own slice
    (audit A2). The bridge slice is stored as the bridge token reported it, so anyone
    holding it can add rows naming their gateway login, and close-all routes each such
    row to a gateway /trade/close. Gateway-account rows are accepted only from the
    gateway slice, keyed (login, ticket); a login-less row targets the requested account
    and is checked the same way. An empty by_source (no snapshot at all) returns the
    input unchanged — the merged snapshot is empty too; a missing "gateway" key with
    other sources present means the gateway slice is empty.
    """
    if not gateway_logins or not by_source:
        return list(positions)
    gw_rows = by_source.get("gateway")
    known: set[tuple[str, int]] = set()
    if isinstance(gw_rows, list):
        for r in gw_rows:
            if isinstance(r, dict) and r.get("login"):
                known.add((str(r.get("login")), _row_ticket(r)))
    out = []
    dropped = 0
    for p in positions:
        login = (p.get("login") if isinstance(p, dict) else None) or mt5_login
        if login and str(login) in gateway_logins and (str(login), _row_ticket(p)) not in known:
            dropped += 1
            continue
        out.append(p)
    if dropped:
        logger.warning(
            "close_all: 丢弃 %d 条不在网关持仓里的网关账号行 / dropped %d unverified gateway rows",
            dropped, dropped,
        )
    return out


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

    if len(wanted) > CLOSE_ALL_MAX_POSITIONS:
        logger.warning(
            "close_all: 本批 %d 笔超过上限 %d，只排前 %d 笔 (user=%s batch=%s)",
            len(wanted), CLOSE_ALL_MAX_POSITIONS, CLOSE_ALL_MAX_POSITIONS, user_id, batch,
        )
        wanted = wanted[:CLOSE_ALL_MAX_POSITIONS]

    tickets = [t for t, _, _ in wanted]
    # 「忙」按 (账号, 票号) 认，而且只认**全平**指令（volume 为 0，一键平仓的子指令
    # 也是全平）。
    #   · 账号：票号只在单个账号内唯一，另一个账号上同号仓位的平仓不该挡住这一个。
    #   · 只认全平：在途的是部分平仓（volume > 0）时，以前同样被当成「已有人在平」
    #     跳过，部分平仓执行完剩下的仓位就没人管了，而用户按的是「全部平仓」。现在照
    #     样排一条全平——两条先后执行，最坏是后到的那条因仓位已不在而被拒，无害。
    #   · 在途指令没记账号（旧记录）时按「可能是这个仓位」处理，宁可少发一条。
    # "Busy" is keyed on (login, ticket) and only counts **full** closes (volume 0,
    # which close-all children are too).
    #   · Login: a ticket is only unique per account; a close on another account's
    #     same-numbered position must not block this one.
    #   · Full closes only: an in-flight partial close (volume > 0) used to count as
    #     "already being closed", so the remainder stayed open after the partial
    #     filled although the user pressed "close all". A full close is now queued
    #     anyway; at worst the later of the two is rejected because the position is
    #     gone, which is harmless.
    #   · An in-flight command without a login (legacy rows) is treated as possibly
    #     this position — better one close too few than a double.
    busy_rows = {
        (row[0], row[1])
        for row in db.query(Order.mt5_login, Order.ticket)
        .filter(
            Order.user_id == user_id,
            Order.status == "PENDING",
            Order.action == "CLOSE",
            Order.ticket.in_(tickets),
            or_(Order.volume.is_(None), Order.volume <= 0),
        )
        .all()
    }
    # 同一个 clientOrderId 重来一次（网络抖动的自动重发）不该再下一遍指令。上面
    # 的 PENDING 闸门挡得住"还没执行完"的情况，这里再按批次本身对一次，连"上一批
    # 已经执行完了"的重放也挡掉——否则唯一约束会让整批 commit 一起失败。
    # Replay of the same clientOrderId must not re-queue. The PENDING gate covers
    # an in-flight batch; matching the batch itself also covers a finished one,
    # which would otherwise fail the whole commit on the unique constraint.
    busy_rows |= {
        (o.mt5_login, o.ticket) for o in batch_orders(db, user_id, batch) if o.ticket is not None
    }

    def _busy(ticket: int, login: str | None) -> bool:
        if (None, ticket) in busy_rows:
            return True
        if login is None:
            return any(t == ticket for _, t in busy_rows)
        return (login, ticket) in busy_rows

    created: list[Order] = []
    skipped = 0
    seen: set[tuple[str | None, int]] = set()
    for ticket, p, login in wanted:
        # 同一请求里重复上报的同一仓位也只排一条（否则同一 id 撞唯一约束）。
        # A position listed twice in one request is queued once (same id otherwise).
        if _busy(ticket, login) or (login, ticket) in seen:
            skipped += 1
            continue
        seen.add((login, ticket))
        created.append(
            Order(
                user_id=user_id,
                client_order_id=child_order_id(batch, ticket, login),
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
    # 操作日志：搭这次提交，必须是提交前最后一步（带去重键，见 _log_batch）。一笔都没排下去
    # （包括同一个 clientOrderId 的重放）在上面就返回了，不写。
    # Activity log, riding this commit as its last step (dedupe-keyed, see
    # _log_batch). Nothing queued — a replay included — returned above and logs nothing.
    _log_batch(db, user_id, batch, created, skipped)
    # 提交后不逐条 refresh（2026-11-16）：订单的列都是 Python 侧默认值，内存里已是最终值。
    # 原来每笔一条 SELECT，48 笔就是 0.28 秒——这段时间里接口还没返回，网关那边一笔都
    # 还没发出去。
    # No per-row refresh after the commit: every Order column has a Python-side default,
    # so memory already holds the final values. It used to cost one SELECT per leg, 0.28s
    # for 48 legs, during which the endpoint had not answered and nothing had been sent.
    from app.services.gateway_execute import commit_keep_loaded

    commit_keep_loaded(db, *created)
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


def _prepare_gateway_legs(
    user_id: str, order_ids: list[str],
) -> tuple[list[Order], dict[str, MT5Account], list[str]]:
    """后台执行的准备：一个会话里把整批要用的东西一次取齐，并把这批指令标成「已下发」。

    返回 (待执行的指令, login → gateway 账号行, 该用户未撤销的 gateway 登录号)。三样都
    已经脱离会话、字段全在内存里，之后各线程只读不查。

    为什么集中做（2026-11-16）：原来每笔平仓各自开会话，发网关之前要查订单、查账号、
    UPDATE delivered、COMMIT，成交后还要再查一次账号列表——一笔 12 次数据库往返。16 条
    线程同时这么干，连接池（8 + 4 条）一下就被抢空，后面的线程排队、溢出连接现连现拆，
    线程收到上一笔结果后平均要 0.19 秒才把下一笔发出去。集中之后：整批 5 次往返，每笔
    只剩写回结果那 4 次。

    「已下发」在这里一次标完，而不是每笔发出前各标一次：排在后面几轮的指令会早标几百
    毫秒。撤单接口本来就撤不到它们（落库后马上就在执行），进程中途被杀时两种标法都是
    5 分钟后按「结果未知」作废，没有区别。

    Preparation for the off-request execution: one session loads everything the batch
    needs and marks its commands delivered. Returns (commands to run, login → gateway
    account row, the user's live gateway logins), all detached with their fields in
    memory, so the worker threads only read.

    Why in one place: each close used to open its own session and, before reaching the
    gateway, load the order, load the account, UPDATE delivered and COMMIT, then query
    the account list again after the fill — twelve round trips per leg. Sixteen threads
    doing that at once drained the pool (8 + 4), queued behind it and kept opening
    overflow connections; a thread took 0.19s on average from one result to its next
    send. Now the batch costs five round trips up front and each leg only the four of
    its result write-back. Marking delivered in bulk stamps later waves a few hundred
    ms early, which changes nothing: they were never cancellable, and a killed process
    leaves them to the same "outcome unknown" void either way.
    """
    from app.core.database import SessionLocal
    from app.services.gateway_execute import commit_keep_loaded

    if not order_ids:
        return [], {}, []
    db = SessionLocal()
    try:
        orders = (
            db.query(Order)
            .filter(Order.id.in_(order_ids), Order.user_id == user_id, Order.status == "PENDING")
            .all()
        )
        rows = (
            db.query(MT5Account)
            .filter(MT5Account.user_id == user_id, MT5Account.source == "gateway", not_removed())
            .all()
        )
        accounts = {r.login: r for r in rows}
        # 与 pending_orders.gateway_logins 同一口径：未撤销的才读持仓。
        # Same rule as pending_orders.gateway_logins: only unrevoked logins are read.
        logins = [r.login for r in rows if r.revoked_at is None]

        todo = [o.id for o in orders if not o.delivered]
        if todo:
            # 一条 UPDATE，不走 ORM 的逐行 flush（psycopg2 的 executemany 是一行一次往返）。
            # One UPDATE rather than a per-row ORM flush (psycopg2 executemany is one
            # round trip per row).
            now = datetime.now(timezone.utc)
            db.query(Order).filter(Order.id.in_(todo), Order.status == "PENDING").update(
                {Order.delivered: True, Order.delivered_at: now}, synchronize_session=False
            )
            for o in orders:
                if not o.delivered:
                    set_committed_value(o, "delivered", True)
                    set_committed_value(o, "delivered_at", now)
        commit_keep_loaded(db)
        # 按落库顺序发（先排的先平），与原来按 order_ids 顺序一致。
        # Send in queueing order, as the id list was.
        rank = {oid: i for i, oid in enumerate(order_ids)}
        orders.sort(key=lambda o: rank.get(o.id, len(rank)))
        db.expunge_all()
        return orders, accounts, logins
    finally:
        db.close()


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
    from app.services.pending_orders import submit_to_main_loop

    try:
        orders, accounts, logins = _prepare_gateway_legs(user_id, order_ids)
    except Exception:
        # 准备失败（数据库一时连不上）：这批指令留在 PENDING，5 分钟后按「结果未知」
        # 作废并发汇总——与进程中途被杀同一个兜底。
        # Preparation failed (database briefly unreachable): the commands stay PENDING
        # and the stale sweep voids them as "outcome unknown", as for a killed process.
        logger.exception("close_all: 批次准备失败 (user=%s batch=%s)", user_id, batch)
        orders, accounts, logins = [], {}, []
    prepared_at = time.monotonic()

    def _one(order: Order) -> None:
        # 每笔一个自己的会话：Session 不能跨线程共用。指令对象是准备阶段取好的（已脱离
        # 那个会话），挂到本会话上不发任何语句；一笔指令只会被一条线程碰。
        # One session per close — a Session must not be shared across threads. The
        # command object was loaded during preparation (detached); attaching it here
        # emits nothing, and each command is touched by exactly one thread.
        payload = None
        db = SessionLocal()
        try:
            if time.monotonic() - prepared_at > CLOSE_ALL_RECHECK_AFTER_S:
                try:
                    status = db.query(Order.status).filter(Order.id == order.id).scalar()
                    db.commit()
                except Exception:  # noqa: BLE001 — 查不到就照原样发 / unreadable: send as before
                    db.rollback()
                    logger.warning("close_all: 复查状态失败，照常发出 (cmd=%s)", order.client_order_id,
                                   exc_info=True)
                    status = "PENDING"
                if status != "PENDING":
                    logger.warning(
                        "close_all: 轮到发送时指令已是 %s，不再发出 (user=%s cmd=%s)",
                        status, user_id, order.client_order_id,
                    )
                    return
            db.add(order)
            try:
                payload = gateway_execute.try_gateway_execute(
                    db, order, account=accounts.get(order.mt5_login), logins=logins
                )
            except Exception:
                logger.exception(
                    "close_all: gateway 执行失败 (user=%s cmd=%s)", user_id, order.client_order_id
                )
                return
        finally:
            db.close()
        if payload is None:
            return
        # 提交即返回，不等主循环推完（原来每笔最多等 5 秒，线程和它的数据库连接都被
        # 占着）：ORDER_UPDATE 之间没有先后依赖，前端按订单 id 整条替换。
        # Fire and forget instead of waiting for the main loop (it used to block up to
        # 5s per leg, holding the thread and its database connection): ORDER_UPDATE
        # frames do not depend on each other, the frontend replaces by order id.
        try:
            submit_to_main_loop(manager.push_to_client(user_id, payload), "ORDER_UPDATE")
        except Exception:
            logger.warning("close_all: ORDER_UPDATE 推送失败 (cmd=%s)", order.client_order_id)

    # 并行平仓：以前逐笔串行，十笔仓位的最后一笔要等前面九笔的 dealer 回执都回来
    # 才发出去——行情快的时候这几秒就是滑点。各笔互不相干（不同仓位、各自的
    # clientOrderId），网关那边本来就能同时处理几百笔。
    # Closes run in parallel: serially, the tenth close waited for nine dealer
    # round-trips first, and in a fast market those seconds are slippage. The
    # closes are independent (own position, own clientOrderId) and the gateway
    # handles hundreds at once.
    try:
        if orders:
            workers = min(CLOSE_ALL_PARALLEL, len(orders))
            with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="close-all") as pool:
                list(pool.map(_one, orders))
    except Exception:
        logger.exception("close_all: 批次执行异常 (user=%s batch=%s)", user_id, batch)

    db = SessionLocal()
    try:
        push_summary_if_done(db, user_id, batch)
    except Exception:
        logger.exception("close_all: 汇总推送异常 (user=%s batch=%s)", user_id, batch)
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
