"""开户 / 转化识别（设计 2026-10-17 §6）：conversions 表的唯一写入口。

**record() 幂等**：按 (user_id, kind, dedupe_key) 唯一——mt5_real 的键是 "<login>@<server>"，
其余 kind 每人一次（键为空串）。写入放在一个 SAVEPOINT 里，撞唯一约束只回滚这一行；任何
异常都只告警，绝不让绑定 / 验证 / 支付这些业务因为记转化失败而失败。随调用方的 commit 提交。

**业绩归属**：转化发生时该用户若有进行中的跟进 → credited_to = 跟进客服、follow_up_id 关联；
跟进目标与 kind 匹配且转化已确认时，跟进自动转 converted。之后改派不影响已记录的归属
（归属在写入那一刻定死，不再重算）。

**mt5_real 自动识别**：trade_mode=2（实盘）且券商匹配（直连 gateway 行一律是合作券商；
桥接行看 server 是否命中 broker_patterns）。gateway 行按券商组名判定 → confirmed；桥接行的
server / login 都是自报的 → 一律 pending_review 等 admin 审核。

Conversion tracking (design §6); the only writer of the conversions table.
record() is idempotent on (user_id, kind, dedupe_key) — "<login>@<server>" for
mt5_real, "" for the once-per-user kinds — inserted inside a SAVEPOINT so a
duplicate only rolls back that row. It never raises: a business path must not
fail because a conversion could not be recorded. Rides the caller's commit.
Attribution is fixed at write time: an active follow-up credits its assignee
and, when the goal matches a confirmed conversion, flips to converted.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import FOLLOW_UP_ACTIVE_STATUSES, Conversion, FollowUp

logger = logging.getLogger("prismx.conversions")

KIND_MT5_REAL = "mt5_real"
KIND_REGISTER = "signallab_register"
KIND_VERIFIED = "signallab_verified"
KIND_PAID = "signallab_paid"
KINDS = (KIND_MT5_REAL, KIND_REGISTER, KIND_VERIFIED, KIND_PAID)

STATUS_CONFIRMED = "confirmed"
STATUS_PENDING = "pending_review"
STATUS_REJECTED = "rejected"

SOURCE_AUTO = "auto"
SOURCE_MANUAL = "manual"

# 跟进目标 → 哪些 kind 算「达成」。activate_trial / revisit / other 没有对应的转化 kind，由客服手动改状态。
# Follow-up goal -> the conversion kinds that fulfil it. activate_trial / revisit / other have
# no conversion kind; staff close those by hand.
GOAL_KINDS: dict[str, frozenset[str]] = {
    "open_mt5": frozenset({KIND_MT5_REAL}),
    "open_signallab": frozenset({KIND_PAID}),
    "renew": frozenset({KIND_PAID}),
    "activate_trial": frozenset(),
    "revisit": frozenset(),
    "other": frozenset(),
}

# MT5 的 ACCOUNT_TRADE_MODE：2 = 实盘 / MT5 trade mode 2 = real
_REAL = 2


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def mt5_key(login, server) -> str:
    return f"{login}@{server or ''}"


def active_follow_up(db: Session, user_id: str) -> FollowUp | None:
    return (
        db.query(FollowUp)
        .filter(FollowUp.user_id == user_id, FollowUp.status.in_(FOLLOW_UP_ACTIVE_STATUSES))
        .first()
    )


def apply_follow_up_conversion(fu: FollowUp | None, kind: str, status: str) -> bool:
    """转化已确认且跟进目标匹配 → 跟进转 converted。返回是否改了。
    Flip a matching active follow-up to converted on a confirmed conversion."""
    if fu is None or status != STATUS_CONFIRMED or fu.status not in FOLLOW_UP_ACTIVE_STATUSES:
        return False
    if kind not in GOAL_KINDS.get(fu.goal, frozenset()):
        return False
    # 只改标签不结束：已转化的客户客服还可以继续维护 / label only, the agent keeps the customer
    fu.status = "converted"
    return True


def record(
    db: Session,
    user_id: str,
    kind: str,
    *,
    dedupe_key: str = "",
    detail: dict | None = None,
    source: str = SOURCE_AUTO,
    status: str = STATUS_CONFIRMED,
    credited_to: str | None = None,
    follow_up_id: str | None = None,
) -> Conversion | None:
    """记一次转化（幂等）。已有同键记录返回 None。见模块说明。

    先 flush 一次：业务这次事务里待写的行（比如刚建的 MT5 账号）先落下，撞唯一约束的
    IntegrityError 是业务自己的，原样上抛（与 activity_log.log_event 同一约定）——否则它会在
    下面的 SAVEPOINT 里被当成「转化重复」吞掉，连业务行一起回滚。

    Record one conversion idempotently; returns None when it already exists. The
    leading flush lets the business's pending rows land first; their errors are
    the business's own and propagate (the activity_log.log_event convention) —
    otherwise the SAVEPOINT below would swallow them as a duplicate conversion and
    roll the business row back with it."""
    db.flush()
    try:
        if kind not in KINDS or not user_id:
            return None
        key = dedupe_key or ""
        exists = (
            db.query(Conversion.id)
            .filter(Conversion.user_id == user_id, Conversion.kind == kind, Conversion.dedupe_key == key)
            .first()
        )
        if exists is not None:
            return None
        fu = None
        if credited_to is None and follow_up_id is None:
            fu = active_follow_up(db, user_id)
            if fu is not None:
                credited_to, follow_up_id = fu.assignee_id, fu.id
        row = Conversion(
            user_id=user_id, kind=kind, source=source, dedupe_key=key,
            detail=json.dumps(detail, ensure_ascii=False, default=str) if detail else None,
            follow_up_id=follow_up_id, credited_to=credited_to, status=status,
        )
        try:
            with db.begin_nested():
                db.add(row)
                db.flush()
        except IntegrityError:
            # 并发的另一条请求先写进去了：那一行就是正确结果。
            # A concurrent request got there first; its row is the right outcome.
            return None
        apply_follow_up_conversion(fu, kind, status)
        return row
    except Exception:
        logger.warning("转化记录失败，已跳过 / conversion skipped: user=%s kind=%s", user_id, kind, exc_info=True)
        return None


def classify_mt5(row, patterns) -> str | None:
    """MT5 账号行 → 转化状态：不是合作券商实盘返回 None；自报 → pending_review；其余 confirmed。
    An MT5 row -> conversion status: None unless a partner-broker real account;
    self-reported -> pending_review, otherwise confirmed."""
    from app.services.settings_store import server_matches_broker

    try:
        tm = int(row.trade_mode) if row.trade_mode is not None else None
    except (TypeError, ValueError):
        tm = None
    if tm != _REAL:
        return None
    if getattr(row, "source", None) == "gateway":
        return STATUS_PENDING if row.trade_mode_source == "self" else STATUS_CONFIRMED
    if not server_matches_broker(row.server, patterns):
        return None
    # 桥接行一律待审（2026-10-26 安全审计）：它的 server / login 是用户侧程序自报的，号段 /
    # 服务器名规则拿这两样判出来的「实盘」也就没人核实过（见 account_type.classify_account_
    # with_source）。只认来源字段的话，老库里残留的 login_rule / server_rule 桥接行照样会被
    # 自动确认、记到跟进客服名下。只有券商组名（gateway 才拿得到）能直接确认。
    # Bridge rows always go to review: their server / login are self-reported, so a
    # rule verdict built on them proves nothing — including legacy rows still labelled
    # login_rule / server_rule. Only a broker group (gateway-only) confirms directly.
    return STATUS_CONFIRMED if row.trade_mode_source == "group" else STATUS_PENDING


def record_mt5_bind(db: Session, user_id: str, row) -> Conversion | None:
    """绑定成功（桥接新建 / 复活、直连验证）后调。不是合作券商实盘就什么都不写。
    Call after a successful bind; writes nothing unless it is a partner-broker real account."""
    try:
        from app.services.settings_store import get_broker_settings

        patterns = get_broker_settings(db).get("broker_patterns") or []
        status = classify_mt5(row, patterns)
    except Exception:
        logger.warning("MT5 转化识别失败，已跳过 / mt5 conversion skipped: user=%s", user_id, exc_info=True)
        return None
    if status is None:
        return None
    return record(
        db, user_id, KIND_MT5_REAL,
        dedupe_key=mt5_key(row.login, row.server), status=status,
        detail={"login": str(row.login), "server": row.server or None,
                "channel": row.source or "bridge", "tradeModeSource": row.trade_mode_source},
    )


# ─────────────────────────────────────────────────────────────────────────────
# rev 41 回填 / rev 41 backfill
# ─────────────────────────────────────────────────────────────────────────────
def backfill_conversions(engine) -> dict[str, int]:
    """给存量用户补 register / verified / paid / mt5_real（credited_to 为空）。已有的键跳过，
    重跑幂等。用户量是千级，一次读进内存比逐行查快得多。
    Backfill register / verified / paid / mt5_real for existing users (no credit).
    Existing keys are skipped, so re-running is idempotent."""
    from app.models import MT5Account, Payment, User
    from app.services.gateway_binding import not_removed
    from app.services.settings_store import get_broker_settings

    counts = {k: 0 for k in KINDS}
    with Session(bind=engine) as db:
        existing = {(c.user_id, c.kind, c.dedupe_key) for c in db.query(
            Conversion.user_id, Conversion.kind, Conversion.dedupe_key)}
        new_rows: list[Conversion] = []

        def add(uid, kind, key, at, status=STATUS_CONFIRMED, detail=None):
            if (uid, kind, key) in existing:
                return
            existing.add((uid, kind, key))
            new_rows.append(Conversion(
                user_id=uid, kind=kind, source=SOURCE_AUTO, dedupe_key=key, status=status,
                detail=json.dumps(detail, ensure_ascii=False) if detail else None,
                created_at=at or _now(),
            ))
            counts[kind] += 1

        for uid, created_at, verified_at in db.query(User.id, User.created_at, User.email_verified_at):
            add(uid, KIND_REGISTER, "", created_at)
            if verified_at is not None:
                add(uid, KIND_VERIFIED, "", verified_at)
        first_paid: dict[str, datetime] = {}
        for uid, finished_at in db.query(Payment.user_id, Payment.finished_at).filter(Payment.status == "FINISHED"):
            at = finished_at or _now()
            if uid not in first_paid or at < first_paid[uid]:
                first_paid[uid] = at
        for uid, at in first_paid.items():
            add(uid, KIND_PAID, "", at)
        patterns = get_broker_settings(db).get("broker_patterns") or []
        for acc in db.query(MT5Account).filter(MT5Account.trade_mode == _REAL, not_removed()):
            status = classify_mt5(acc, patterns)
            if status is not None:
                add(acc.user_id, KIND_MT5_REAL, mt5_key(acc.login, acc.server), acc.last_heartbeat, status,
                    {"login": str(acc.login), "server": acc.server or None, "bf": 1})
        db.add_all(new_rows)
        db.commit()
    return counts
