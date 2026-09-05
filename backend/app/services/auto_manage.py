"""自动仓位管理（PRO 专属）：保本、追踪止损、分批止盈。

由持仓上报驱动，不另起轮询任务。两条通道都会驱动它，各自的节奏不同：
- Bridge：桥接程序每 ~1.5 秒 POST /bridge/positions（见 bridge.bridge_positions）
- Gateway：后端每 2 秒主动轮询（见 gateway.gateway_positions_loop）

每次上报对该用户的持仓做一轮规则评估，需要动作时以 MODIFY / CLOSE 指令写入
现有订单队列，订单页全程可见，与手动操作走完全相同的链路，透明可审计。
指令的执行者按通道分流，这一步不能想当然（漏掉就等于自动仓管静默失效）：
- Bridge 账号：桥接下一拍轮询 /bridge/poll 拉走执行、回执
- Gateway 账号：没有桥接，/bridge/poll 还会主动跳过它们，所以由本模块的
  _execute_gateway_orders 在落库后立刻调 gateway HTTP 执行

范围与安全边界 / scope & safety:
- 只管理通过 PRISMX 下单开出的仓位（按 Order.mt5_ticket 匹配），
  用户在 MT5 客户端手动开的仓一概不碰。
- 止损只朝有利方向移动（多单只上移、空单只下移），永不放大风险。
- 开仓时没有止损的仓位无法定义 R，直接跳过。
- 改 SL 时回传该仓当前的 TP——MODIFY 指令里 0 表示清除，漏传会把止盈清掉。

Auto position management (PRO only): break-even, trailing stop, partial
take-profit. Driven by the bridge's ~1.5s position reports (see
bridge.bridge_positions) — no extra polling loop. Each report triggers one
rule pass; required actions are enqueued as MODIFY / CLOSE commands on the
existing order queue, fetched and acknowledged by the bridge exactly like
manual actions, fully visible on the orders page.

- Only positions opened through PRISMX (matched by Order.mt5_ticket) are
  managed; positions opened manually in the MT5 terminal are never touched.
- The stop only ever moves in the favorable direction — risk is never widened.
- Positions opened without a stop have no defined R and are skipped.
- MODIFY carries the position's current TP — 0 means "clear" to the bridge,
  so omitting it would wipe the take-profit.
"""
import logging
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.models import AutoManagedPosition, AutoManageSettings, MT5Account, Order, User
from app.services.plans import can_auto_manage
from app.services.push_dispatch import EVENT_AUTO_MANAGE, dispatch_event_push

logger = logging.getLogger("prismx.auto_manage")

# SL 最小改动步长（占 R 的比例）：小于这个幅度的改进不下发，避免每 1.5 秒
# 都发一条只挪一个点的改单指令。
# Minimum SL improvement (as a fraction of R) worth sending; smaller moves are
# skipped so we don't emit a 1-pip MODIFY every 1.5 seconds.
MIN_STEP_R = 0.1

# 状态行保留天数：仓位平掉后其状态行不再被触达，过期清理。
# Days to keep state rows; rows for long-gone positions get pruned.
STATE_RETENTION_DAYS = 7

# 自动指令的 clientOrderId 前缀（订单页可辨识，去重查询也按它过滤）。
# clientOrderId prefix for automation commands (recognizable on the orders
# page; the dedup query filters on it too).
AUTO_PREFIX = "auto_"

# "该用户是否需要评估"的短 TTL 缓存：绝大多数用户没开自动管理，
# 让每 1.5 秒一次的持仓上报在他们身上零数据库开销。
# Short-TTL cache of "does this user need evaluation at all" — most users
# have automation off, and this keeps their 1.5s position reports DB-free.
_ELIGIBLE_TTL_SECONDS = 30
_eligible_cache: dict[str, tuple[bool, float]] = {}
_cache_lock = threading.Lock()

# per-user 评估锁：防止两次并发的 bridge_positions 请求为同一个用户同时
# 评估、同时看到空的 pending_auto_tickets、同时写入重复的 MODIFY/CLOSE 指令。
# 排查过生产日志中同一仓位被双重修改的案例；线程池里的并发是不可预期的。
# Per-user evaluation lock: prevents two concurrent bridge_positions calls for
# the same user from both seeing an empty pending_auto_tickets and both writing
# duplicate MODIFY/CLOSE commands. Confirmed by production logs showing the
# same position being modified twice; thread-pool concurrency is unpredictable.
_eval_locks: dict[str, threading.Lock] = {}

# 锁字典最大容量：超限时清理掉长期无争用的条目，防止无限膨胀。
# Cap on the lock dict: prune entries that haven't been contended in a while
# so the dict doesn't grow without bound.
_MAX_LOCKS = 5000


def _get_eval_lock(user_id: str) -> threading.Lock:
    """取 per-user 评估锁；按需创建，超限时清理。"""
    lock = _eval_locks.get(user_id)
    if lock is not None:
        return lock
    with _cache_lock:
        # 双检：刚才在 _cache_lock 外读到 None 时另一线程可能已插入
        lock = _eval_locks.get(user_id)
        if lock is not None:
            return lock
        if len(_eval_locks) > _MAX_LOCKS:
            # 只清理无争用的锁（当前没被 acquire），避免影响正在评估中的请求
            stale = [uid for uid, lk in _eval_locks.items() if not lk.locked()]
            for uid in stale:
                _eval_locks.pop(uid, None)
        lock = threading.Lock()
        _eval_locks[user_id] = lock
        return lock


def invalidate_eligibility(user_id: str) -> None:
    """设置变更后调用，让该用户的评估资格立即重算。
    Called on settings change so the user's eligibility is recomputed at once."""
    with _cache_lock:
        _eligible_cache.pop(user_id, None)


def _is_eligible(db: Session, user_id: str) -> tuple[bool, AutoManageSettings | None]:
    """PRO 且总开关打开才评估；否定结果进缓存，肯定结果每次都重读设置。
    Evaluate only for PRO users with the master switch on; negatives are
    cached, positives re-read settings every pass (they're about to be used)."""
    now = time.time()
    with _cache_lock:
        hit = _eligible_cache.get(user_id)
        if hit is not None and now - hit[1] < _ELIGIBLE_TTL_SECONDS and not hit[0]:
            return False, None

    plan = db.query(User.plan).filter(User.id == user_id).scalar()
    settings_row = (
        db.query(AutoManageSettings).filter(AutoManageSettings.user_id == user_id).first()
    )
    eligible = bool(can_auto_manage(plan) and settings_row and settings_row.enabled)
    with _cache_lock:
        _eligible_cache[user_id] = (eligible, now)
    return eligible, settings_row if eligible else None


def _client_order_id(kind: str, ticket: int) -> str:
    return f"{AUTO_PREFIX}{kind}_{ticket}_{uuid.uuid4().hex[:8]}"


def evaluate_positions(db: Session, user_id: str, positions: list) -> int:
    """对一次持仓上报做规则评估，返回本轮新建的指令条数。
    Run one rule pass over a position report; returns how many commands were
    enqueued. 异常由调用方兜底记录——本函数抛错不能影响持仓上报主流程。
    The caller catches exceptions — a failure here must never break the
    position-report flow itself.

    同一用户串行评估：持有 per-user 锁，杜绝线程池并发的重复指令竞态。
    Serialized per user: holds a per-user lock to prevent duplicate-command
    races caused by concurrent thread-pool evaluations of the same user.
    """
    lock = _get_eval_lock(user_id)
    lock.acquire()
    try:
        return _evaluate_positions_locked(db, user_id, positions)
    finally:
        lock.release()


def _evaluate_positions_locked(db: Session, user_id: str, positions: list) -> int:
    """实际评估逻辑（调用方已持有 per-user 锁）。"""
    eligible, cfg = _is_eligible(db, user_id)
    if not eligible or cfg is None or not positions:
        return 0

    # 只管理本平台开的仓位 / only manage positions opened through PRISMX
    #
    # 仓位号可能落在两个不同的列上，取决于账号是哪条通道接进来的：
    #   - Bridge：mt5_ticket 存的是 order_send 回执的 result.order，而 MT5 里
    #     仓位号就等于开仓订单的 ticket，所以它本身就是仓位号。
    #   - Gateway：mt5_ticket 存的是订单号**或成交号**（见 orders.py 的
    #     _apply_trade_result），成交号与仓位号不是同一套编号，拿来比对配不上；
    #     真正的仓位号由 gateway 开仓后反查填进 mt5_position。
    # 只查 mt5_ticket 会让 gateway 账号的 platform_tickets 恒为空，自动仓位管理
    # 静默失效——规则一次都不会被评估。两列取并集，各自通道走各自的那一列。
    #
    # A position id lands in one of two columns depending on the channel. Bridge
    # stores result.order in mt5_ticket, which in MT5 *is* the position id. The
    # gateway stores an order or deal ticket there — a deal ticket lives in a
    # different numbering space and never matches — and puts the real position id
    # in mt5_position. Matching only mt5_ticket left platform_tickets permanently
    # empty for gateway accounts, silently disabling auto-management.
    tickets = [int(p.get("ticket") or 0) for p in positions if p.get("ticket")]
    if not tickets:
        return 0
    reported = set(tickets)
    platform_tickets = {
        t
        for row in db.query(Order.mt5_ticket, Order.mt5_position)
        .filter(
            Order.user_id == user_id,
            Order.action == "ORDER",
            Order.status == "FILLED",
            or_(Order.mt5_ticket.in_(tickets), Order.mt5_position.in_(tickets)),
        )
        .all()
        for t in row
        # 一行里两列都要过一遍 `reported`：命中的可能是其中任一列，另一列的值
        # （bridge 的 NULL、或 gateway 的成交号）不属于本次上报，不能带进来。
        # Both columns are filtered against `reported`: only one of them matched,
        # and the other holds a value that isn't one of the reported positions.
        if t is not None and t in reported
    }
    if not platform_tickets:
        return 0

    # 已有待执行自动指令的仓位本轮跳过（指令 1.5~3 秒后才回执，持仓里的 SL
    # 还没变，不挡一下会重复下发）。
    # Skip positions that already have a pending auto command — execution takes
    # 1.5~3s to reflect in the report, and without this guard we'd re-send.
    pending_auto_tickets = {
        t for (t,) in db.query(Order.ticket)
        .filter(
            Order.user_id == user_id,
            Order.status == "PENDING",
            Order.client_order_id.like(f"{AUTO_PREFIX}%"),
            Order.ticket.isnot(None),
        )
        .all()
    }

    # 每仓状态：首次见到即快照入场价/初始止损 / per-position state, snapshotted on first sight
    states = {
        s.position_ticket: s
        for s in db.query(AutoManagedPosition)
        .filter(
            AutoManagedPosition.user_id == user_id,
            AutoManagedPosition.position_ticket.in_(list(platform_tickets)),
        )
        .all()
    }

    now = datetime.now(timezone.utc)
    # 本轮新建的指令。除了计数，提交后还要把其中落在 gateway 账号上的立刻执行掉
    # （gateway 没有桥接来取，见 _execute_gateway_orders）。
    # This pass's new commands. Counted, and after the commit the ones targeting
    # gateway accounts are executed right here (see _execute_gateway_orders).
    created_orders: list[Order] = []
    # 通知延迟到函数末尾 db.commit() 成功之后才真正发送，避免"规则决定要
    # 改单但最终提交失败/回滚"时用户却收到了一条其实没发生的通知。
    # Notifications are deferred until after the final db.commit() succeeds,
    # so a rule that decided to act but whose commit later failed/rolled back
    # never results in a push about something that didn't actually happen.
    pending_pushes: list[tuple[str, str]] = []
    for p in positions:
        ticket = int(p.get("ticket") or 0)
        if ticket not in platform_tickets:
            continue

        entry = float(p.get("entryPrice") or 0.0)
        current = float(p.get("currentPrice") or 0.0)
        current_sl = float(p.get("stopLoss") or 0.0)
        current_tp = float(p.get("takeProfit") or 0.0)
        volume = float(p.get("volume") or 0.0)
        side = p.get("side")
        symbol = p.get("symbol") or ""
        login = p.get("login")
        if not entry or not current or side not in ("BUY", "SELL") or not symbol:
            continue

        state = states.get(ticket)
        if state is None:
            risk = abs(entry - current_sl) if current_sl > 0 else None
            state = AutoManagedPosition(
                user_id=user_id,
                position_ticket=ticket,
                mt5_login=login,
                entry=entry,
                initial_sl=current_sl or None,
                risk=risk,
            )
            db.add(state)
            states[ticket] = state
        else:
            state.updated_at = now
            # 首次见到该仓位时若还没挂止损，R 记为未知；等止损随后补上，这里
            # 用它回填一次 R，否则这个仓位会被永久跳过（下面 not state.risk 的
            # 分支），保本/追踪止损再也不会对它生效。只在 R 仍未定义时补，已定
            # 义的 R 是开仓时的初始风险基准，不因后续手动改止损而变。
            # If the position had no stop the first time we saw it, R stays
            # undefined; once a stop appears later, backfill R here — otherwise
            # the position is skipped forever (the `not state.risk` branch
            # below) and break-even/trailing never apply to it. Only backfill
            # while R is still undefined; an already-defined R is the initial
            # risk baseline and must not shift when the stop is later moved.
            if (not state.risk or state.risk <= 0) and current_sl > 0:
                state.risk = abs(entry - current_sl)
                state.initial_sl = current_sl

        if not state.risk or state.risk <= 0:
            continue  # 开仓无止损，R 无定义 / no SL at open, R undefined
        if ticket in pending_auto_tickets:
            continue

        risk = state.risk
        direction = 1.0 if side == "BUY" else -1.0
        profit_r = (current - entry) * direction / risk

        # ---- 保本 + 追踪：计算期望 SL，只朝有利方向移动 ----
        # ---- break-even + trailing: desired SL, favorable direction only ----
        candidates: list[float] = []
        if cfg.be_enabled and profit_r >= cfg.be_trigger_r:
            candidates.append(entry)
        if cfg.trail_enabled and profit_r >= cfg.trail_trigger_r:
            candidates.append(current - direction * cfg.trail_distance_r * risk)

        if candidates:
            desired = max(candidates) if side == "BUY" else min(candidates)
            if current_sl > 0:
                # 只在目标比现有 SL 更有利且改进量 ≥ 最小步长时才动；目标更差
                # （如追踪已推过入场价）时 improvement 为负，自然跳过。
                # Move only when the target beats the current SL by at least the
                # minimum step; a worse target (e.g. trailing already pushed past
                # entry) yields a negative improvement and is skipped naturally.
                improvement = (desired - current_sl) * direction
                should_move = improvement >= MIN_STEP_R * risk
            else:
                should_move = True  # 有 R 但当前无 SL（被手动清掉）：补上 / SL was cleared manually; restore it
            if should_move:
                cmd = Order(
                    user_id=user_id,
                    client_order_id=_client_order_id("sl", ticket),
                    action="MODIFY",
                    symbol=symbol,
                    side=side,
                    volume=0.0,
                    ticket=ticket,
                    sl=desired,
                    tp=current_tp,  # 保留现有止盈，0 会被桥接理解为清除 / keep TP; 0 would clear it
                    mt5_login=login,
                    status="PENDING",
                )
                db.add(cmd)
                created_orders.append(cmd)
                pending_auto_tickets.add(ticket)
                kind = "保本" if desired == entry else "追踪止损"
                pending_pushes.append((
                    f"自动仓位管理：{symbol}",
                    f"止损已自动移至 {desired:.5f}（{kind}）",
                ))

        # ---- 分批止盈：每仓只执行一次 ----
        # ---- partial take-profit: fires once per position ----
        if (
            cfg.ptp_enabled
            and not state.partial_done
            and profit_r >= cfg.ptp_trigger_r
            and ticket not in pending_auto_tickets
        ):
            close_vol = int(volume * cfg.ptp_fraction * 100) / 100.0
            # 拆不开的小仓不动（平掉部分和剩余部分都得 ≥ 0.01 手）
            # skip positions too small to split (both legs must be ≥ 0.01 lots)
            if close_vol >= 0.01 and volume - close_vol >= 0.01:
                cmd = Order(
                    user_id=user_id,
                    client_order_id=_client_order_id("tp", ticket),
                    action="CLOSE",
                    symbol=symbol,
                    side=side,
                    volume=close_vol,
                    ticket=ticket,
                    mt5_login=login,
                    status="PENDING",
                )
                db.add(cmd)
                # 入队即标记：宁可失败后不重试，也不能失败后反复重发导致重复平仓。
                # Marked on enqueue: better to not retry a failed close than to
                # re-fire repeatedly and over-close the position.
                state.partial_done = True
                created_orders.append(cmd)
                pending_auto_tickets.add(ticket)
                pending_pushes.append((
                    f"自动仓位管理：{symbol}",
                    f"已自动分批止盈 {close_vol} 手",
                ))

    # 清理久未出现的状态行（仓位早已平掉）/ prune rows for long-gone positions
    cutoff = now - timedelta(days=STATE_RETENTION_DAYS)
    db.query(AutoManagedPosition).filter(
        AutoManagedPosition.user_id == user_id,
        AutoManagedPosition.updated_at < cutoff,
    ).delete(synchronize_session=False)

    db.commit()
    if created_orders:
        logger.info(
            "auto_manage: user=%s enqueued %d command(s)", user_id, len(created_orders)
        )
        # Gateway 账号没有桥接来取这些指令，提交后由本函数直接执行。
        # Gateway accounts have no bridge to fetch these; execute them here.
        _execute_gateway_orders(db, user_id, created_orders)
        # 提交成功后才真正发送通知（见 pending_pushes 声明处的说明）；单条
        # 推送失败不影响其它推送或本函数的返回值。
        # Only send notifications after the commit actually succeeds (see the
        # note where pending_pushes is declared); one failed push must not
        # affect the others or this function's return value.
        for title, body in pending_pushes:
            try:
                dispatch_event_push(user_id, EVENT_AUTO_MANAGE, title, body)
            except Exception:
                logger.exception("auto_manage: push failed (user=%s)", user_id)
    return len(created_orders)


def _execute_gateway_orders(db: Session, user_id: str, orders: list[Order]) -> None:
    """把落在 gateway 账号上的自动指令立刻执行掉。

    Bridge 账号的指令由桥接轮询 /bridge/poll 取走执行；gateway 账号没有桥接，
    而且 /bridge/poll 还会主动跳过它们（见 routers/bridge.py 的 gateway_logins）。
    所以这里不执行的话，自动仓管的 MODIFY / CLOSE 会一直挂在 PENDING，直到 5
    分钟后被 stale_order_monitor_loop 作废，并附上一句"如已开启桥接请重新下单"
    ——对一个从来不需要桥接的 gateway 用户来说毫无意义。表现就是：设置页开关
    开着，指令一条都不生效。

    复用 orders 路由那份执行实现，而不是在这里另写一遍：retcode 到
    FILLED/REJECTED 的映射、成交价回退、仓位号回填都在那边，两份实现迟早会
    不一致。函数内导入是为了避免 services 与 routers 在模块加载期循环依赖。

    单条指令失败只影响它自己：_try_gateway_execute 内部已把异常落成 FAILED，
    这里再兜一层，确保一条炸掉不会拖累同批的其它指令，更不会把异常抛回持仓
    上报的主流程。

    Execute auto-management commands that target gateway accounts. Bridge
    accounts get theirs via /bridge/poll, which deliberately skips gateway
    logins — so without this they would sit PENDING until the 5-minute stale
    sweep voided them, i.e. auto-management would silently do nothing while the
    settings page showed it enabled. Reuses the orders router's implementation
    rather than duplicating the retcode-to-status mapping; imported inside the
    function to avoid a services/routers import cycle.
    """
    from app.services.gateway_binding import not_removed
    gateway_logins = {
        row[0] for row in db.query(MT5Account.login).filter(
            MT5Account.user_id == user_id,
            MT5Account.source == "gateway",
            not_removed(),
        ).all()
    }
    targets = [o for o in orders if o.mt5_login and o.mt5_login in gateway_logins]
    if not targets:
        return

    from app.routers.orders import _try_gateway_execute
    from app.services.connection_manager import manager
    from app.services.gateway_client import run_on_main_loop

    for order in targets:
        try:
            payload = _try_gateway_execute(db, order)
            logger.info(
                "auto_manage: gateway executed %s %s -> %s",
                order.action, order.client_order_id, order.status,
            )
        except Exception:
            logger.exception(
                "auto_manage: gateway execution failed (user=%s, cmd=%s)",
                user_id, order.client_order_id,
            )
            continue

        # 与 bridge 回执一致地推一帧 ORDER_UPDATE，让订单页立刻看到 FILLED/
        # REJECTED，而不是等下一次轮询。不再另发 Web Push：自动仓管在规则触发
        # 那一刻已经推过一次，bridge 侧同样按 AUTO_PREFIX 跳过（见
        # routers/bridge.py 的 bridge_result），两条通道保持同一套通知口径。
        # 推送失败不算指令失败——指令已经在 MT5 上执行完了。
        # Push one ORDER_UPDATE frame just like the bridge ack does, so the
        # orders page reflects the result immediately. No second web push: the
        # rule already sent one when it fired, and the bridge side skips
        # AUTO_PREFIX commands for the same reason. A failed push is not a
        # failed command — it already executed on MT5.
        if payload is None:
            continue
        try:
            run_on_main_loop(manager.push_to_client(user_id, payload), timeout=5.0)
        except Exception:
            logger.warning(
                "auto_manage: gateway ORDER_UPDATE push failed (cmd=%s)",
                order.client_order_id,
            )
