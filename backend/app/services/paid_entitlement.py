"""已完成付款买到的权益最晚到哪天——代理降级保护与退款收回下限共用的一处算法。

两个调用方：
- routers/invite._has_live_paid_plan：代理想把客户降级时，「他现在的权益是不是花钱买的」；
- routers/payments._other_payments_entitlement_floor：退掉一笔时，「别的付款买到的时间不许被扣穿」。
两处以前各写一份公式（finished_at + 套餐天数），叠加续费、叠在代理 / 管理员 / 客服时长之后
的付款都会被少算（审计 agent-downgrade-paid-guard-ignores-stacked-renewals 及其后续）。放在
services 里是为了不让 router 互相 import（见 services/pagination.py 顶部的说明）。

算法（取最大值）：
  ① 叠加链：只用 FINISHED 付款本身推一遍 end = max(end, finished_at) + 天数——这些钱单独就
     买得到的下限；
  ② 实际入账到期：rev 49 起每笔入账都记下 credited_until（入账那一刻用户新的到期时间），
     有就用它；老行（NULL）退回 plan:payment 审计行里的到期时间，按 finished_at 前后
     PAYMENT_AUDIT_MATCH_SECONDS 秒配对。
  ② 里的值可能叠着一笔**已退款**的付款的天数（先付年付、再付月付叠上去、然后退掉年付）：
     只要那笔退款单在这笔入账时还在有效期内，就把它的天数从这个值里扣掉，再与 ① 取大。
  REFUNDED / 其余非 FINISHED 的付款本身永远不给窗口。

The latest moment FINISHED payments still pay for — one algorithm shared by the
agent downgrade guard (routers/invite) and the refund revoke floor
(routers/payments), kept in services so routers don't import each other.
Max of (1) the payments' own stacking chain and (2) the observed post-credit
expiry: credited_until when present (rev 49+), else the plan:payment audit row
paired by time. An observed value may include the days of a payment that was
later refunded (stacked on top of it while it was live); those days are taken
off before comparing. REFUNDED / non-FINISHED payments never count themselves.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.models import AdminAuditLog, Payment
from app.services.plans import PLAN_DAYS
from app.utils.timeutil import aware

# 付款入账写的审计行（payments._sync_payment_status 的 plan:payment）与这笔付款的
# finished_at 在同一个事务里落下，按这个时间差把两者配上对。
# The plan:payment audit row is written in the same transaction that stamps the
# payment's finished_at; rows within this many seconds are paired with it.
PAYMENT_AUDIT_MATCH_SECONDS = 300

# 曾经入过账、之后被退掉的状态（payments.STATUS_REFUNDED；这里不 import router）。
# REFUNDED_UNCREDITED 从没入过账，不会叠进别人的到期时间，所以不在其中。
# The refunded-after-credit status (payments.STATUS_REFUNDED, not imported from
# the router). REFUNDED_UNCREDITED never credited anything, so it is not here.
_REFUNDED = "REFUNDED"


def _plan_days(plan: str | None) -> timedelta:
    return timedelta(days=PLAN_DAYS.get(plan, 30))


def audit_expiry(raw: str | None) -> datetime | None:
    """解析 plan:payment 审计行的新值 `PRO(<到期时间>)`，取出入账后的到期时间。
    Parse the `PRO(<expiry>)` new_value of a plan:payment audit row."""
    if not raw or "(" not in raw or not raw.endswith(")"):
        return None
    inner = raw[raw.index("(") + 1:-1].strip()
    if not inner or inner == "None":
        return None
    try:
        return aware(datetime.fromisoformat(inner))
    except ValueError:
        return None


def paid_entitlement_end(
    db: Session, user_id: str, exclude_payment_id: str | None = None
) -> datetime | None:
    """这个用户的已完成付款买到的权益最晚到哪天（aware UTC）；没有就返回 None。

    exclude_payment_id：把这一笔当成已退款看待（不给窗口，且它叠进别人的天数要扣掉）——
    退款收回下限用它算「除这一笔之外」的付款。

    Latest moment this user's FINISHED payments pay for (aware UTC), or None.
    exclude_payment_id treats that payment as refunded: it grants nothing, and
    its days are taken off any later observed expiry stacked on it.
    """
    rows = (
        db.query(Payment.id, Payment.plan, Payment.status, Payment.finished_at, Payment.credited_until)
        .filter(
            Payment.user_id == user_id,
            Payment.status.in_(("FINISHED", _REFUNDED)),
        )
        .all()
    )
    if exclude_payment_id is not None and not any(r[0] == exclude_payment_id for r in rows):
        # 调用方可能还没把它改成 REFUNDED（或它停在别的状态）：照样按「已退」处理。
        # The caller may not have flipped it to REFUNDED yet; treat it as refunded anyway.
        rows += (
            db.query(Payment.id, Payment.plan, Payment.status, Payment.finished_at, Payment.credited_until)
            .filter(Payment.id == exclude_payment_id, Payment.user_id == user_id)
            .all()
        )

    kept: list[tuple[str, str | None, datetime, datetime | None]] = []
    voided: list[tuple[datetime, datetime, timedelta]] = []
    for pid, plan, status, finished_at, credited_until in rows:
        if finished_at is None:
            continue
        f = aware(finished_at)
        cu = aware(credited_until)
        if status == "FINISHED" and pid != exclude_payment_id:
            kept.append((pid, plan, f, cu))
        else:
            # 这笔入账给出的窗口：有 credited_until 用它，否则按 finished_at + 天数（偏短，
            # 漏扣的方向是多保护一点，不会误扣）。
            # Its credited window: credited_until, else finished_at + days (shorter,
            # so a miss errs towards protecting, never towards over-revoking).
            voided.append((f, cu if cu is not None else f + _plan_days(plan), _plan_days(plan)))
    if not kept:
        return None
    kept.sort(key=lambda r: r[2])

    def _net(observed: datetime, credited_at: datetime) -> datetime:
        # 入账时还在有效期内的已退款付款，其天数叠在 observed 里，扣掉。
        # Refunded payments live when this one was credited sit inside observed.
        for v_at, v_end, v_days in voided:
            if v_at <= credited_at < v_end:
                observed -= v_days
        return observed

    # ① 叠加链 / the payments' own stacking chain
    end: datetime | None = None
    for _pid, plan, f, _cu in kept:
        base = f if end is None or end < f else end
        end = base + _plan_days(plan)

    # ② 实际入账到期：优先 credited_until / observed expiry, credited_until first
    legacy: list[datetime] = []
    for _pid, _plan, f, cu in kept:
        if cu is None:
            legacy.append(f)
            continue
        net = _net(cu, f)
        if net > end:
            end = net

    if legacy:
        window = timedelta(seconds=PAYMENT_AUDIT_MATCH_SECONDS)
        audits = (
            db.query(AdminAuditLog.new_value, AdminAuditLog.created_at)
            .filter(
                AdminAuditLog.target_user_id == user_id,
                AdminAuditLog.field == "plan:payment",
                AdminAuditLog.created_at >= (legacy[0] - window).replace(tzinfo=None),
            )
            .all()
        )
        # 每条审计行配给时间最近的那笔付款；最近的是有 credited_until 的、或已退款的那笔，
        # 这条就是它们自己的，不拿来当老行的到期。
        # Pair each audit row with the nearest payment; when that is a credited_until
        # row or a refunded one, the audit row is theirs, not a legacy row's.
        others = [f for _pid, _plan, f, cu in kept if cu is not None] + [v[0] for v in voided]
        for new_value, created_at in audits:
            if created_at is None:
                continue
            at = aware(created_at)
            nearest = min(legacy, key=lambda f: abs(at - f))
            if abs(at - nearest) > window:
                continue
            if any(abs(at - o) < abs(at - nearest) for o in others):
                continue
            credited = audit_expiry(new_value)
            if credited is None:
                continue
            net = _net(credited, nearest)
            if net > end:
                end = net
    return end
