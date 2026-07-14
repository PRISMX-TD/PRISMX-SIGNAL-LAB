"""自动仓位管理（PRO 专属）：保本、追踪止损、分批止盈。

由桥接程序每 ~1.5 秒一次的持仓上报驱动（见 bridge.bridge_positions），
不另起轮询任务。每次上报对该用户的持仓做一轮规则评估，需要动作时以
MODIFY / CLOSE 指令写入现有订单队列——由桥接正常拉取执行、正常回执，
订单页全程可见，与手动操作走完全相同的链路，透明可审计。

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

from sqlalchemy.orm import Session

from app.models import AutoManagedPosition, AutoManageSettings, Order, User
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
    position-report flow itself."""
    eligible, cfg = _is_eligible(db, user_id)
    if not eligible or cfg is None or not positions:
        return 0

    # 只管理本平台开的仓位 / only manage positions opened through PRISMX
    tickets = [int(p.get("ticket") or 0) for p in positions if p.get("ticket")]
    if not tickets:
        return 0
    platform_tickets = {
        t for (t,) in db.query(Order.mt5_ticket)
        .filter(
            Order.user_id == user_id,
            Order.action == "ORDER",
            Order.status == "FILLED",
            Order.mt5_ticket.in_(tickets),
        )
        .all()
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
    created = 0
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
                db.add(Order(
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
                ))
                created += 1
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
                db.add(Order(
                    user_id=user_id,
                    client_order_id=_client_order_id("tp", ticket),
                    action="CLOSE",
                    symbol=symbol,
                    side=side,
                    volume=close_vol,
                    ticket=ticket,
                    mt5_login=login,
                    status="PENDING",
                ))
                # 入队即标记：宁可失败后不重试，也不能失败后反复重发导致重复平仓。
                # Marked on enqueue: better to not retry a failed close than to
                # re-fire repeatedly and over-close the position.
                state.partial_done = True
                created += 1
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
    if created:
        logger.info("auto_manage: user=%s enqueued %d command(s)", user_id, created)
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
    return created
