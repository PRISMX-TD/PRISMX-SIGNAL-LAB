"""自动邮件：触发条件、定时扫描、发送前复核、收件人变量。

**扫描，不埋点。** 每条规则的触发条件都是一条对现有表的查询（users / payments /
activity_events / admin_audit_logs），后台循环每 SCAN_INTERVAL_SECONDS 扫一遍，把「刚满足
条件、还没发过」的人写成 email_automation_sends 的 pending 行。注册、绑定、支付这些关键路径
一行都不用改；「注册 3 天还没绑 MT5」这种**没有事件可挂**的情景也能做；进程重启、换主之后
下一轮自己补上。代价是最多晚一个扫描周期，对这类邮件无所谓。

**不补发。** 只有事件时间落在规则的 activated_at（最近一次开启 / 改条件）之后的人才算。每个
触发条件都写成「事件时间 = 某一列 ± 延迟」，于是窗口 [activated_at, now] 可以直接换算成那一列
上的范围，查询有界、走索引，不在 SQL 里做日期运算（SQLite 与 Postgres 写法不同）。

**发送走群发那条循环。** email_broadcast.drain_once 每次先认领这里的信、没有了再认领群发：
两者共用 Resend 的限速与 BROADCAST_EMAIL_DAILY_CAP（sent_today 两张表一起数），自动邮件优先。
认领规则与群发一致：条件 UPDATE 抢行、卡在 sending 的判失败不重发、发送那一刻再判一次资格。
这里多两道：
· 每人每天最多一封自动邮件（PER_USER_GAP）——几条规则同时命中时按 priority 先发小的，其余
  顺延到第二天；
· 发送前把触发条件对这一个人**再算一遍**，occurrence 对不上（续费了、绑上了、回来活跃了）
  就跳过，记 condition_gone。

**额度 / 配置错误整体暂停。** 群发靠每场的 status 暂停；自动邮件没有「场」，暂停状态记在
platform_settings 的 PAUSE_KEY 里（到时间自动恢复），管理后台读同一个键显示原因。

Automated email: rules are trigger queries over existing tables, scanned every
SCAN_INTERVAL_SECONDS into pending email_automation_sends rows — no hooks in the
business paths, "nothing happened" triggers work, and a restart self-heals. Only
events after the rule's activated_at count (no backfill); every trigger is
"event time = column ± delay", so the window maps to a range on that column.
Sends go through the broadcast send loop (automation first, shared rate limit
and daily cap), with the same claim discipline plus a one-per-person-per-day cap
and a send-time recheck of the trigger. Quota / provider-config failures pause
automation as a whole via a platform_settings key that expires on its own.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable

from sqlalchemy import and_, exists, func, not_, or_, select
from sqlalchemy.orm import Session, aliased
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.database import SessionLocal
from app.models import (
    ActivityEvent,
    AdminAuditLog,
    EmailAutomation,
    EmailAutomationSend,
    EmailOptOut,
    MT5Account,
    Payment,
    PlatformSetting,
    User,
)
from app.services import activity_log, mailer
from app.services import email_broadcast as eb
from app.services.stats_time import stats_tz

logger = logging.getLogger("prismx.email_automation")

# 扫描节奏 / scan pacing
SCAN_INTERVAL_SECONDS = 300
SCAN_STARTUP_DELAY_SECONDS = 45
# 一条规则一轮最多展开多少人：防止一个写错的条件一次塞进几万行。剩下的下一轮接着展开——
# 所以条件都在库里判断、已排过队的也在库里排除（_queued），不能让它们一直占着名额。
# Per-rule cap per pass, so a mistaken condition can't dump tens of thousands of rows at once.
# The rest are taken next pass, which is why conditions run in SQL and already-queued rows
# are excluded there (_queued) instead of holding the slots forever.
MAX_CANDIDATES_PER_RULE = 2000
# 每人每天最多一封自动邮件 / at most one automated email per person per day
PER_USER_GAP = timedelta(hours=24)
# 排队太久（被顺延了很多次）就不发了：一周前的「欢迎注册」再发出去只会让人困惑
# A send queued this long (deferred over and over) is dropped: a week-old welcome only confuses.
STALE_AFTER = timedelta(days=7)
MAX_ATTEMPTS = 3
STALE_CLAIM_MINUTES = 10
# 「估算人数」看最近几天 / the estimate looks back this many days
ESTIMATE_DAYS = 7

PAUSE_KEY = "email_automation_pause"
PAUSE_PROVIDER = timedelta(minutes=30)
PAUSE_MONTHLY = timedelta(hours=6)


@dataclass(frozen=True)
class Cand:
    """一次触发：谁、哪一次（occurrence），外加变量要用的上下文。"""

    user_id: str
    occurrence: str = "1"
    expires_at: datetime | None = None
    mt5_login: str | None = None


@dataclass(frozen=True)
class RuleParams:
    """触发条件只看这几项；未保存的规则（估算人数）也用它。/ What a trigger reads."""

    trigger: str
    delay_minutes: int
    plan_filter: str = "all"
    kind: str = eb.KIND_MARKETING
    max_times: int | None = None
    id: str | None = None


TriggerFn = Callable[[Session, RuleParams, datetime, "datetime | None", "str | None", bool], list[Cand]]


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _delay(rule) -> timedelta:
    return timedelta(minutes=max(0, int(rule.delay_minutes or 0)))


def _plan_clause(q, plan: str):
    if plan == "FREE":
        return q.filter(User.plan == "FREE")
    if plan == "PRO":
        return q.filter(User.plan == "PRO")
    if plan == "TRIAL":
        return q.filter(User.plan == "PRO", User.plan_is_trial.is_(True))
    if plan == "PAID":
        return q.filter(User.plan == "PRO", or_(User.plan_is_trial.is_(False), User.plan_is_trial.is_(None)))
    return q


def _recipients(q, rule, user_id: str | None):
    """收得到这条规则的人：有邮箱、没停用、符合等级筛选、（推广时）没退订。q 里要带着 User。
    Who can receive this rule: has an email, not disabled, matches the plan filter and (for
    marketing) hasn't opted out. q must already select from or join User."""
    q = q.filter(User.email.contains("@"), User.disabled_at.is_(None))
    q = _plan_clause(q, rule.plan_filter or "all")
    if rule.kind != eb.KIND_NOTICE:
        q = q.filter(~exists().where(EmailOptOut.user_id == User.id))
    if user_id:
        q = q.filter(User.id == user_id)
    return q


def _users(db: Session, rule, user_id: str | None):
    return _recipients(db.query(User), rule, user_id)


def _queued(rule, user_col, *, occurrence=None, since=None):
    """这条规则已经给这个人排过队（任何状态）。扫描时用 ~_queued(...) 在库里先排除，免得排过的人
    一直占着每轮 MAX_CANDIDATES_PER_RULE 的名额、新来的人永远排不上。只给扫描用：发送前复核
    同一个人时不能把他自己排除掉。
    This rule already queued this person (any status). Scanning filters with ~_queued(...)
    so queued people stop taking the per-pass MAX_CANDIDATES_PER_RULE slots and starving
    newcomers. Scan only: the send-time recheck must not exclude the person itself."""
    S = EmailAutomationSend
    conds = [S.rule_id == rule.id, S.user_id == user_col]
    if occurrence is not None:
        conds.append(S.occurrence == occurrence)
    if since is not None:
        conds.append(S.created_at >= since)
    return exists().where(*conds)


def _after(col, *extra) -> TriggerFn:
    """「事件时间 = col + 延迟」型条件。窗口 [lo, now] 换算成 col ∈ [lo − d, now − d]。每人只有一次。"""

    def fn(db, rule, now, lo, user_id, fresh=False):
        d = _delay(rule)
        q = _users(db, rule, user_id).filter(col <= now - d, *extra)
        if lo is not None:
            q = q.filter(col >= lo - d)
        if fresh and rule.id:
            q = q.filter(~_queued(rule, User.id))
        rows = q.with_entities(User.id).order_by(col).limit(MAX_CANDIDATES_PER_RULE).all()
        return [Cand(uid) for (uid,) in rows]

    return fn


def _first_payment(db, rule, now, lo, user_id, fresh=False):
    d = _delay(rule)
    first = db.query(Payment.user_id.label("uid"), func.min(Payment.finished_at).label("at")).filter(
        Payment.status == "FINISHED", Payment.finished_at.isnot(None)
    )
    if user_id:
        first = first.filter(Payment.user_id == user_id)
    first = first.group_by(Payment.user_id).subquery()
    q = _users(db, rule, user_id).join(first, first.c.uid == User.id).filter(first.c.at <= now - d)
    if lo is not None:
        q = q.filter(first.c.at >= lo - d)
    if fresh and rule.id:
        q = q.filter(~_queued(rule, User.id))
    rows = q.with_entities(User.id).order_by(first.c.at).limit(MAX_CANDIDATES_PER_RULE).all()
    return [Cand(uid) for (uid,) in rows]


# mt5.bind 的 data 是紧凑 JSON（activity_log._dumps），复活那条里一定有这一段
# mt5.bind data is compact JSON (activity_log._dumps); a revived bind always contains this
_REVIVED_JSON = '"revived":true'


def _mt5_first_bind(db, rule, now, lo, user_id, fresh=False):
    """第一次绑定 MT5。来源是操作日志的 mt5.bind（rev 38 起才有），所以三道判断：
    这是这个人最早的一条 mt5.bind；不是「复活」一个以前删掉的账号；名下没有别的 MT5 账号行
    （含已解绑的软删行）——rev 38 之前就绑过的老用户靠后两条排除。三道判断都在库里做，
    不符合的事件不占每轮的名额。

    First MT5 bind, from the activity log's mt5.bind (only since rev 38): the user's
    earliest such event, not a revived account, and no other account row (soft-deleted
    included) — the last two keep pre-rev-38 users from counting as first-timers. All three
    run in SQL so non-matching events don't take the per-pass slots."""
    d = _delay(rule)
    E = ActivityEvent
    earlier = aliased(ActivityEvent)
    q = _recipients(db.query(E).join(User, User.id == E.user_id), rule, user_id).filter(
        E.kind == activity_log.MT5_BIND,
        E.created_at <= now - d,
        or_(E.data.is_(None), ~E.data.contains(_REVIVED_JSON)),
        ~exists().where(earlier.user_id == E.user_id, earlier.kind == activity_log.MT5_BIND, earlier.created_at < E.created_at),
        ~exists().where(MT5Account.user_id == E.user_id, MT5Account.id != E.ref_id),
    )
    if lo is not None:
        q = q.filter(E.created_at >= lo - d)
    if fresh and rule.id:
        q = q.filter(~_queued(rule, E.user_id))
    out: list[Cand] = []
    seen: set[str] = set()
    for ev in q.order_by(E.created_at).limit(MAX_CANDIDATES_PER_RULE).all():
        # 同一时刻两条 mt5.bind 只算一次；data 写法万一变了，这里再按解析结果兜一次底
        # Two binds at the same instant count once; revived is re-checked on the parsed data
        if ev.user_id in seen or activity_log.decode_data(ev.data).get("revived"):
            continue
        seen.add(ev.user_id)
        out.append(Cand(ev.user_id, mt5_login=ev.mt5_login))
    return out


def _expiring(trial: bool) -> TriggerFn:
    """到期前 d 提醒：事件时间 = 到期时间 − d，窗口换算成 到期时间 ∈ [lo + d, now + d]，且还没到期。
    occurrence 是这一次的到期时间：续了期就是新的一次，会再提醒。窗口本身有界（只含接下来 d
    之内到期的人），所以不用 _queued：除非 d 之内到期的人超过每轮上限，否则挤不掉谁。

    The window is bounded on its own (only people expiring within the next d), so no
    _queued is needed: it can only crowd anyone out if more than the per-pass cap expire
    within d."""

    def fn(db, rule, now, lo, user_id, fresh=False):
        d = _delay(rule)
        q = _users(db, rule, user_id).filter(
            User.plan != "FREE",
            User.plan_expires_at.isnot(None),
            User.plan_expires_at > now,
            User.plan_expires_at <= now + d,
        )
        if trial:
            q = q.filter(User.plan_is_trial.is_(True))
        else:
            q = q.filter(or_(User.plan_is_trial.is_(False), User.plan_is_trial.is_(None)))
        if lo is not None:
            q = q.filter(User.plan_expires_at >= lo + d)
        rows = q.with_entities(User.id, User.plan_expires_at).order_by(User.plan_expires_at).limit(MAX_CANDIDATES_PER_RULE).all()
        return [Cand(uid, _iso(exp), expires_at=exp) for uid, exp in rows]

    return fn


def _expired(trial: bool) -> TriggerFn:
    """到期后 d：降级时 plan_expires_at 会被清空，到期的那一刻只留在 plan:auto_expire 审计行里，
    所以从审计行出发；occurrence 是那一行的 id。现在还是 FREE 才发（又付了费就不提醒）。
    试用到期 = 用过试用、且从没有成功付过款；其余的到期都算付费会员到期。判断都在库里做，
    另一类的到期不占这条规则的名额。

    After-expiry: the downgrade clears plan_expires_at, so the moment only survives in
    the plan:auto_expire audit row (its id is the occurrence). Only users still FREE.
    A trial expiry is a user who used a trial and never completed a payment. Filtered in
    SQL so the other kind's expiries don't take this rule's slots."""

    def fn(db, rule, now, lo, user_id, fresh=False):
        d = _delay(rule)
        A = AdminAuditLog
        paid = exists().where(Payment.user_id == User.id, Payment.status == "FINISHED")
        was_trial = and_(User.trial_used_at.isnot(None), ~paid)
        q = _recipients(
            db.query(A.id, A.target_user_id, A.created_at).join(User, User.id == A.target_user_id), rule, user_id
        ).filter(
            A.field == "plan:auto_expire",
            A.created_at <= now - d,
            User.plan == "FREE",
            was_trial if trial else not_(was_trial),
        )
        if lo is not None:
            q = q.filter(A.created_at >= lo - d)
        if fresh and rule.id:
            q = q.filter(~_queued(rule, A.target_user_id, occurrence=A.id))
        rows = q.order_by(A.created_at).limit(MAX_CANDIDATES_PER_RULE).all()
        return [Cand(r.target_user_id, r.id, expires_at=r.created_at) for r in rows]

    return fn


def _inactive(db, rule, now, lo, user_id, fresh=False):
    """连续 d 没活跃。occurrence 是那一次的最后活跃时间：回来用过再沉下去就是新的一次，
    max_times 限制同一个人一共最多召回几次。从没活跃过的人按注册时间算。
    扫描时「这一次已经排过」= 有一行建于最后活跃时间之后：排队时这个人一定还没回来，回来之后
    最后活跃时间一定晚于那一行。max_times 也在库里判断，召回满次数的人不占名额。

    Scanning treats "this time already queued" as a row created after the last-active time:
    the person was still away when it was queued, and coming back moves last-active past it.
    max_times is checked in SQL too, so people at the cap don't take slots."""
    d = _delay(rule)
    seen = func.coalesce(User.last_active_at, User.created_at)
    q = _users(db, rule, user_id).filter(seen <= now - d)
    if lo is not None:
        q = q.filter(seen >= lo - d)
    if rule.max_times and rule.id:
        S = EmailAutomationSend
        sent = (
            select(func.count(S.id))
            .where(S.rule_id == rule.id, S.user_id == User.id, S.status == "sent")
            .correlate(User)
            .scalar_subquery()
        )
        q = q.filter(sent < rule.max_times)
    if fresh and rule.id:
        q = q.filter(~_queued(rule, User.id, since=seen))
    rows = q.with_entities(User.id, seen).order_by(seen).limit(MAX_CANDIDATES_PER_RULE).all()
    return [Cand(uid, _iso(at)) for uid, at in rows if at is not None]


@dataclass(frozen=True)
class TriggerSpec:
    fn: TriggerFn
    # 延迟的下限（分钟）：「注册 0 分钟后仍未验证」没有意义 / smallest sensible delay
    min_delay: int = 0


TRIGGERS: dict[str, TriggerSpec] = {
    "signup": TriggerSpec(_after(User.created_at)),
    "unverified": TriggerSpec(_after(User.created_at, User.email_verified_at.is_(None)), 60),
    "no_mt5": TriggerSpec(_after(User.created_at, ~exists().where(MT5Account.user_id == User.id)), 60),
    "mt5_first_bind": TriggerSpec(_mt5_first_bind),
    "trial_started": TriggerSpec(_after(User.trial_used_at)),
    "trial_expiring": TriggerSpec(_expiring(trial=True), 60),
    "trial_expired": TriggerSpec(_expired(trial=True)),
    "plan_expiring": TriggerSpec(_expiring(trial=False), 60),
    "plan_expired": TriggerSpec(_expired(trial=False)),
    "first_payment": TriggerSpec(_first_payment),
    "inactive": TriggerSpec(_inactive, 24 * 60),
}


def candidates(
    db: Session, rule, now: datetime, lo: datetime | None, user_id: str | None = None, *, fresh: bool = False
) -> list[Cand]:
    """满足条件的触发。fresh=True（只有扫描用）时在库里先排除这条规则已经排过队的。
    Matching firings; fresh=True (scan only) leaves out what this rule already queued."""
    spec = TRIGGERS.get(rule.trigger)
    return spec.fn(db, rule, now, lo, user_id, fresh) if spec else []


# ---------------------------------------------------------------------------
# 变量 / variables
# ---------------------------------------------------------------------------

# 中文名与英文名都认，英文那半封信里写英文名更顺手 / both names work in either half
_VAR_NAMES = {
    "昵称": "nickname", "nickname": "nickname",
    "邮箱": "email", "email": "email",
    "到期日期": "expiry_date", "expiry_date": "expiry_date",
    "剩余天数": "days_left", "days_left": "days_left",
    "MT5账号": "mt5_login", "mt5_login": "mt5_login",
    "网站链接": "site_url", "site_url": "site_url",
}
_VAR_RE = re.compile(r"\{(" + "|".join(re.escape(k) for k in _VAR_NAMES) + r")\}")
# 昵称是用户自己填的：去掉正文标记会用到的字符和 http(s):// 前缀（裸链接会被渲染成可点的
# 链接），免得有人把昵称写成一个链接混进信里。
# Nicknames are user input: strip the body-markup characters and any http(s):// prefix
# (bare URLs get linkified) so one can't smuggle a link into the message.
_MARKUP_CHARS = re.compile(r"[*\[\]()<>{}\r\n]|https?:/*", re.IGNORECASE)


def variables_for(db: Session, user: User, cand: Cand | None, now: datetime) -> dict[str, str]:
    nickname = _MARKUP_CHARS.sub("", user.nickname or "").strip() or (user.email or "").partition("@")[0]
    expires = (cand.expires_at if cand else None) or user.plan_expires_at
    expiry_date = days_left = ""
    if expires is not None:
        local = expires.replace(tzinfo=timezone.utc).astimezone(stats_tz())
        expiry_date = local.strftime("%Y-%m-%d")
        days_left = str(max(0, math.ceil((expires - now).total_seconds() / 86400)))
    login = cand.mt5_login if cand else None
    if not login:
        row = (
            db.query(MT5Account.login)
            .filter(MT5Account.user_id == user.id, MT5Account.revoked_at.is_(None))
            .order_by(MT5Account.last_heartbeat.desc())
            .first()
        )
        login = row[0] if row else ""
    return {
        "nickname": nickname,
        "email": user.email or "",
        "expiry_date": expiry_date,
        "days_left": days_left,
        "mt5_login": str(login or ""),
        "site_url": (settings.PUBLIC_WEB_URL or "").rstrip("/"),
    }


def fill(text: str, values: dict[str, str]) -> str:
    return _VAR_RE.sub(lambda m: values.get(_VAR_NAMES[m.group(1)], ""), text or "")


def content_of(rule: EmailAutomation) -> eb.Content:
    return eb.Content(
        kind=rule.kind or eb.KIND_MARKETING,
        subject_zh=rule.subject_zh or "",
        body_zh=rule.body_zh or "",
        subject_en=rule.subject_en or "",
        body_en=rule.body_en or "",
    )


def build_for(db: Session, content: eb.Content, user: User, cand: Cand | None, now: datetime) -> eb.Message:
    """按收件人替换变量后拼成整封信。/ Fill the per-recipient variables and build the message."""
    v = variables_for(db, user, cand, now)
    filled = eb.Content(
        kind=content.kind,
        subject_zh=" ".join(fill(content.subject_zh, v).split()),
        body_zh=fill(content.body_zh, v),
        subject_en=" ".join(fill(content.subject_en, v).split()),
        body_en=fill(content.body_en, v),
    )
    unsub = eb.unsubscribe_url(user.id) if content.kind != eb.KIND_NOTICE else None
    return eb.build_message(filled, unsub)


def sample_cand(trigger: str, now: datetime) -> Cand:
    """预览 / 测试信用的假触发：到期类给一个看起来合理的到期时间。"""
    if trigger.endswith("_expiring"):
        return Cand("", expires_at=now + timedelta(days=3))
    if trigger.endswith("_expired"):
        return Cand("", expires_at=now - timedelta(days=1))
    return Cand("")


# ---------------------------------------------------------------------------
# 扫描 / scanning
# ---------------------------------------------------------------------------

def _insert_ignore(dialect_name: str, rows: list[dict]):
    if dialect_name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as dialect_insert
    elif dialect_name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert as dialect_insert
    else:
        raise NotImplementedError(f"insert-or-ignore not supported on {dialect_name}")
    return (
        dialect_insert(EmailAutomationSend.__table__)
        .values(rows)
        .on_conflict_do_nothing(index_elements=["rule_id", "user_id", "occurrence"])
    )


def scan_rule(db: Session, rule: EmailAutomation, now: datetime) -> int:
    """展开一条规则：新满足条件的人写成 pending 行。调用方 commit。返回新增行数。"""
    if rule.activated_at is None or rule.trigger not in TRIGGERS:
        return 0
    cands = candidates(db, rule, now, rule.activated_at, fresh=True)
    if not cands:
        return 0
    uids = list({c.user_id for c in cands})
    existing: set[tuple[str, str]] = set()
    for i in range(0, len(uids), 500):
        existing.update(
            db.query(EmailAutomationSend.user_id, EmailAutomationSend.occurrence).filter(
                EmailAutomationSend.rule_id == rule.id, EmailAutomationSend.user_id.in_(uids[i:i + 500])
            )
        )
    rows = []
    for c in cands:
        key = (c.user_id, c.occurrence)
        if key in existing:
            continue
        existing.add(key)
        rows.append({
            "id": str(uuid.uuid4()), "rule_id": rule.id, "user_id": c.user_id,
            "occurrence": c.occurrence, "status": "pending", "attempts": 0,
            "created_at": now, "due_at": now,
        })
    for i in range(0, len(rows), 500):
        db.execute(_insert_ignore(db.get_bind().dialect.name, rows[i:i + 500]))
    return len(rows)


def scan_once(db: Session, now: datetime | None = None) -> int:
    """扫一遍全部开启的规则。一条规则出错只跳过它自己。/ One pass over every enabled rule."""
    now = now or eb._utcnow()
    total = 0
    rules = (
        db.query(EmailAutomation)
        .filter(EmailAutomation.enabled.is_(True), EmailAutomation.deleted_at.is_(None))
        .order_by(EmailAutomation.priority, EmailAutomation.created_at)
        .all()
    )
    for rule in rules:
        try:
            n = scan_rule(db, rule, now)
            db.commit()
            total += n
        except Exception:
            db.rollback()
            logger.exception("email_automation: 规则扫描失败 rule=%s trigger=%s", rule.id, rule.trigger)
    if total:
        logger.info("email_automation: 本轮新增 %d 封待发 / queued", total)
    return total


# ---------------------------------------------------------------------------
# 暂停状态 / pause state
# ---------------------------------------------------------------------------

def pause_state(db: Session, now: datetime | None = None) -> dict | None:
    """当前的整体暂停（{reason, until}），已过期或没有时 None。"""
    row = db.query(PlatformSetting).filter(PlatformSetting.key == PAUSE_KEY).first()
    if row is None:
        return None
    try:
        v = json.loads(row.value)
        until = datetime.fromisoformat(v["until"])
    except (TypeError, ValueError, KeyError):
        return None
    if until <= (now or eb._utcnow()):
        return None
    return {"reason": str(v.get("reason") or ""), "until": until}


def _set_pause(db: Session, reason: str, until: datetime) -> None:
    from app.services.settings_store import set_setting

    set_setting(db, PAUSE_KEY, {"reason": reason, "until": until.isoformat()})


def clear_pause(db: Session) -> None:
    """调用方 commit。/ The caller commits."""
    db.query(PlatformSetting).filter(PlatformSetting.key == PAUSE_KEY).delete(synchronize_session=False)


# ---------------------------------------------------------------------------
# 发送 / sending（由 email_broadcast.drain_once 调用）
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AutoJob:
    send_id: str
    rule_id: str
    email: str
    message: eb.Message


def _fail_stale_claims(db: Session, now: datetime) -> None:
    cutoff = now - timedelta(minutes=STALE_CLAIM_MINUTES)
    n = (
        db.query(EmailAutomationSend)
        .filter(EmailAutomationSend.status == "sending", EmailAutomationSend.claimed_at < cutoff)
        .update({"status": "failed", "error": "interrupted"}, synchronize_session=False)
    )
    if n:
        logger.warning("email_automation: %d 封信在发送中途被中断，记为失败 / interrupted sends marked failed", n)


def _finish(db: Session, send_id: str, **values) -> None:
    db.query(EmailAutomationSend).filter(EmailAutomationSend.id == send_id).update(values, synchronize_session=False)
    db.commit()


def claim_next(db: Session, now: datetime | None = None) -> AutoJob | str:
    """认领下一封自动邮件。返回 AutoJob，或 eb.IDLE / eb.CAP_REACHED。"""
    if not mailer.mail_configured():
        return eb.IDLE
    now = now or eb._utcnow()
    if pause_state(db, now) is not None:
        return eb.IDLE
    _fail_stale_claims(db, now)
    db.commit()

    cap = settings.BROADCAST_EMAIL_DAILY_CAP
    if cap > 0 and eb.sent_today(db) >= cap:
        return eb.CAP_REACHED

    for _ in range(200):
        row = (
            db.query(EmailAutomationSend)
            .join(EmailAutomation, EmailAutomation.id == EmailAutomationSend.rule_id)
            .filter(
                EmailAutomationSend.status == "pending",
                EmailAutomationSend.due_at <= now,
                EmailAutomation.enabled.is_(True),
                EmailAutomation.deleted_at.is_(None),
            )
            .order_by(EmailAutomation.priority, EmailAutomationSend.due_at, EmailAutomationSend.id)
            .first()
        )
        if row is None:
            return eb.IDLE
        claimed = (
            db.query(EmailAutomationSend)
            .filter(EmailAutomationSend.id == row.id, EmailAutomationSend.status == "pending")
            .update(
                {"status": "sending", "claimed_at": now, "attempts": EmailAutomationSend.attempts + 1},
                synchronize_session=False,
            )
        )
        db.commit()
        if claimed != 1:
            continue

        rule = db.get(EmailAutomation, row.rule_id)
        user = db.get(User, row.user_id)
        reason = None
        if user is None or not user.email or "@" not in user.email:
            reason = "no_user"
        elif user.disabled_at is not None:
            reason = "disabled"
        elif rule.kind != eb.KIND_NOTICE and db.get(EmailOptOut, user.id) is not None:
            reason = "opted_out"
        elif row.created_at is not None and now - row.created_at > STALE_AFTER:
            reason = "stale"
        if reason:
            _finish(db, row.id, status="skipped", error=reason)
            continue

        last = (
            db.query(func.max(EmailAutomationSend.sent_at))
            .filter(
                EmailAutomationSend.user_id == user.id,
                EmailAutomationSend.status == "sent",
                EmailAutomationSend.sent_at > now - PER_USER_GAP,
            )
            .scalar()
        )
        if last is not None:
            # 今天已经收过一封：顺延到满 24 小时，次数退回 / already had one today: defer
            _finish(
                db, row.id, status="pending", due_at=last + PER_USER_GAP,
                attempts=EmailAutomationSend.attempts - 1, claimed_at=None, error="deferred",
            )
            continue

        cand = next((c for c in candidates(db, rule, now, None, user.id) if c.occurrence == row.occurrence), None)
        if cand is None:
            _finish(db, row.id, status="skipped", error="condition_gone")
            continue

        message = build_for(db, content_of(rule), user, cand, now)
        return AutoJob(row.id, rule.id, user.email, message)
    return eb.IDLE


def record_result(db: Session, job: AutoJob, result: mailer.SendResult, now: datetime | None = None) -> None:
    """落结果。规则与群发的 record_result 一致；额度 / 配置错误改成整体暂停自动邮件。"""
    now = now or eb._utcnow()
    q = db.query(EmailAutomationSend).filter(EmailAutomationSend.id == job.send_id)
    row = q.first()
    if row is None:
        return
    refund = {"status": "pending", "attempts": max(0, (row.attempts or 1) - 1), "error": None, "claimed_at": None}
    if result.ok:
        q.update({"status": "sent", "sent_at": now, "error": None}, synchronize_session=False)
    elif result.quota:
        q.update(refund, synchronize_session=False)
        if result.quota == "daily":
            tomorrow = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
            _set_pause(db, "quota_daily", tomorrow)
        else:
            _set_pause(db, "quota_monthly", now + PAUSE_MONTHLY)
        logger.warning("email_automation: 发信额度用完（%s），自动邮件暂停 / quota exceeded, paused", result.quota)
    elif result.config_error:
        q.update(refund, synchronize_session=False)
        _set_pause(db, f"provider_rejected_{result.status}", now + PAUSE_PROVIDER)
    elif result.retryable and (row.attempts or 0) < MAX_ATTEMPTS:
        code = f"http_{result.status}" if result.status else "network"
        q.update({"status": "pending", "error": code, "claimed_at": None}, synchronize_session=False)
    else:
        code = f"http_{result.status}" if result.status else "network"
        q.update({"status": "failed", "error": code}, synchronize_session=False)
    db.commit()


def sent_today(db: Session) -> int:
    start = eb._utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    return db.query(func.count(EmailAutomationSend.id)).filter(EmailAutomationSend.sent_at >= start).scalar() or 0


# ---------------------------------------------------------------------------
# 管理端用的统计 / admin stats
# ---------------------------------------------------------------------------

def rule_stats(db: Session, rule_ids: list[str], now: datetime | None = None) -> dict[str, dict[str, int]]:
    """每条规则：近 7 天的 sent / failed / skipped，排队中的，累计已发。"""
    now = now or eb._utcnow()
    out: dict[str, dict[str, int]] = {
        rid: {"sent7d": 0, "failed7d": 0, "skipped7d": 0, "pending": 0, "sentTotal": 0} for rid in rule_ids
    }
    if not rule_ids:
        return out
    since = now - timedelta(days=7)
    S = EmailAutomationSend
    for rid, status, n in (
        db.query(S.rule_id, S.status, func.count(S.id)).filter(S.rule_id.in_(rule_ids)).group_by(S.rule_id, S.status)
    ):
        if status in ("pending", "sending"):
            out[rid]["pending"] += n
        elif status == "sent":
            out[rid]["sentTotal"] += n
    for rid, status, n in (
        db.query(S.rule_id, S.status, func.count(S.id))
        .filter(S.rule_id.in_(rule_ids), or_(S.sent_at >= since, S.created_at >= since))
        .group_by(S.rule_id, S.status)
    ):
        if status in ("sent", "failed", "skipped"):
            out[rid][f"{status}7d"] += n
    return out


def estimate(db: Session, params: RuleParams, now: datetime | None = None, sample_size: int = 5) -> dict:
    """按这个条件，最近 ESTIMATE_DAYS 天会触发多少人（不发任何东西）。"""
    now = now or eb._utcnow()
    cands = candidates(db, params, now, now - timedelta(days=ESTIMATE_DAYS))
    uids = list(dict.fromkeys(c.user_id for c in cands))
    sample = [e for (e,) in db.query(User.email).filter(User.id.in_(uids[:sample_size]))] if uids else []
    return {"count": len(uids), "days": ESTIMATE_DAYS, "sample": sample, "capped": len(cands) >= MAX_CANDIDATES_PER_RULE}


def skip_pending(db: Session, rule_id: str, reason: str) -> int:
    """把这条规则还没发的全部记为跳过（关闭 / 删除 / 改条件时）。调用方 commit。"""
    return (
        db.query(EmailAutomationSend)
        .filter(EmailAutomationSend.rule_id == rule_id, EmailAutomationSend.status == "pending")
        .update({"status": "skipped", "error": reason}, synchronize_session=False)
    )


# ---------------------------------------------------------------------------
# 后台循环 / the scan loop
# ---------------------------------------------------------------------------

def _scan_sync() -> int:
    db = SessionLocal()
    try:
        return scan_once(db)
    finally:
        db.close()


async def email_automation_loop() -> None:
    """条件扫描循环（BackgroundLoops 里只有领导进程跑）。发信不在这里，在 email_broadcast 的循环里。"""
    await asyncio.sleep(SCAN_STARTUP_DELAY_SECONDS)
    from app.services import loop_health

    while True:
        loop_health.beat("email_automation")
        try:
            await run_in_threadpool(_scan_sync)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("email_automation_loop error")
        await asyncio.sleep(SCAN_INTERVAL_SECONDS)
