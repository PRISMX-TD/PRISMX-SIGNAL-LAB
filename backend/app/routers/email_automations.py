"""自动邮件规则的管理端接口：增删改、开关、估算人数、预览 / 测试信、发送记录。

规则的判定与发送都在 services/email_automation 里（扫描循环 + 群发那条发送循环），这里只管
规则本身。两条约定：

· **开启 = 从现在开始算。** 开启（或在开启状态下改了触发条件）时 activated_at 记成现在，之前
  就满足条件的人一律不补发；关闭、删除、改条件时，还没发出去的那批记为跳过——它们是按旧条件
  排进来的。
· **只改文字不重算。** 改名称、优先级、正文不碰 activated_at 和排队中的信：排队中的信发送那一刻
  才渲染，用的就是新正文。

Admin endpoints for automated-email rules. Enabling (or changing the trigger of
an enabled rule) stamps activated_at = now, so nobody who already qualified is
backfilled; disabling, deleting or changing the trigger skips what is still
queued. Editing only the wording leaves both alone — queued sends render at
send time with the new text.
"""
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import EmailAutomation, EmailAutomationSend, User
from app.schemas import (
    EmailAutomationConditionIn,
    EmailAutomationEstimateOut,
    EmailAutomationIn,
    EmailAutomationListOut,
    EmailAutomationOut,
    EmailAutomationPauseOut,
    EmailAutomationPreviewIn,
    EmailAutomationSendListOut,
    EmailAutomationSendOut,
    EmailPreviewOut,
)
from app.services import email_automation as ea
from app.services import email_broadcast as eb
from app.services import mailer
from app.services.audit import log_change
from app.services.deps import require_admin

logger = logging.getLogger("prismx.email_automations")

admin_router = APIRouter(
    prefix="/admin/email-automations", tags=["admin"], dependencies=[Depends(require_admin)]
)

# 规则总数上限：这里是一组运营规则，不是给每个用户建一条的地方 / a handful of rules, not one per user
MAX_RULES = 50
_CONDITION_FIELDS = ("trigger", "delay_minutes", "plan_filter", "max_times", "kind")


def _content(c) -> eb.Content:
    zh = bool(c.subjectZh and c.bodyZh)
    en = bool(c.subjectEn and c.bodyEn)
    return eb.Content(
        kind=c.kind,
        subject_zh=c.subjectZh if zh else "",
        body_zh=c.bodyZh if zh else "",
        subject_en=c.subjectEn if en else "",
        body_en=c.bodyEn if en else "",
    )


def _out(r: EmailAutomation, stats: dict[str, int], creator_email: str | None) -> EmailAutomationOut:
    return EmailAutomationOut(
        id=r.id,
        name=r.name,
        trigger=r.trigger,
        delayMinutes=r.delay_minutes or 0,
        planFilter=r.plan_filter or "all",
        maxTimes=r.max_times,
        priority=r.priority or 100,
        kind=r.kind or eb.KIND_MARKETING,
        subjectZh=r.subject_zh or "",
        bodyZh=r.body_zh or "",
        subjectEn=r.subject_en or "",
        bodyEn=r.body_en or "",
        enabled=bool(r.enabled),
        activatedAt=r.activated_at,
        createdAt=r.created_at,
        updatedAt=r.updated_at,
        createdByEmail=creator_email,
        **stats,
    )


def _one_out(db: Session, r: EmailAutomation) -> EmailAutomationOut:
    creator = db.get(User, r.created_by)
    return _out(r, ea.rule_stats(db, [r.id])[r.id], creator.email if creator else None)


def _get(db: Session, rule_id: str) -> EmailAutomation:
    r = db.get(EmailAutomation, rule_id)
    if r is None or r.deleted_at is not None:
        raise HTTPException(status_code=404, detail="自动邮件规则不存在 / Rule not found")
    return r


def _apply(r: EmailAutomation, body: EmailAutomationIn) -> None:
    content = _content(body.content)
    r.name = body.name
    r.trigger = body.condition.trigger
    r.delay_minutes = body.condition.delayMinutes
    r.plan_filter = body.condition.planFilter
    r.max_times = body.condition.maxTimes
    r.kind = content.kind
    r.priority = body.priority
    r.subject_zh = content.subject_zh or None
    r.body_zh = content.body_zh or None
    r.subject_en = content.subject_en or None
    r.body_en = content.body_en or None


def _audit(db: Session, admin: User, action: str, r: EmailAutomation, old=None, **extra) -> None:
    log_change(
        db, admin.id, admin.id, f"email_auto:{action}", old,
        json.dumps({"id": r.id, "name": r.name, "trigger": r.trigger, **extra}, ensure_ascii=False),
    )


@admin_router.get("", response_model=EmailAutomationListOut)
def list_rules(db: Session = Depends(get_db)):
    rows = (
        db.query(EmailAutomation)
        .filter(EmailAutomation.deleted_at.is_(None))
        .order_by(EmailAutomation.priority, EmailAutomation.created_at)
        .all()
    )
    stats = ea.rule_stats(db, [r.id for r in rows])
    creator_ids = {r.created_by for r in rows}
    emails = dict(db.query(User.id, User.email).filter(User.id.in_(creator_ids)).all()) if creator_ids else {}
    pause = ea.pause_state(db)
    return EmailAutomationListOut(
        rules=[_out(r, stats[r.id], emails.get(r.created_by)) for r in rows],
        pause=EmailAutomationPauseOut(**pause) if pause else None,
    )


@admin_router.post("", response_model=EmailAutomationOut)
def create_rule(body: EmailAutomationIn, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """新建规则。建出来是关着的：先预览、发测试信，确认了再打开。"""
    count = db.query(EmailAutomation.id).filter(EmailAutomation.deleted_at.is_(None)).count()
    if count >= MAX_RULES:
        raise HTTPException(status_code=400, detail=f"最多 {MAX_RULES} 条规则 / At most {MAX_RULES} rules")
    now = eb._utcnow()
    r = EmailAutomation(created_by=admin.id, created_at=now, updated_at=now, enabled=False)
    _apply(r, body)
    db.add(r)
    db.flush()
    _audit(db, admin, "create", r)
    db.commit()
    db.refresh(r)
    return _one_out(db, r)


@admin_router.put("/{rule_id}", response_model=EmailAutomationOut)
def update_rule(
    body: EmailAutomationIn,
    rule_id: str = Path(..., max_length=64),
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    r = _get(db, rule_id)
    before = {f: getattr(r, f) for f in _CONDITION_FIELDS}
    _apply(r, body)
    now = eb._utcnow()
    r.updated_at = now
    condition_changed = any(getattr(r, f) != v for f, v in before.items())
    skipped = 0
    if condition_changed and r.enabled:
        # 条件变了：之后按新条件从现在算，按旧条件排进来的不再发 / restart from now under the new condition
        r.activated_at = now
        skipped = ea.skip_pending(db, r.id, "rule_changed")
    _audit(db, admin, "update", r, conditionChanged=condition_changed, skipped=skipped)
    db.commit()
    db.refresh(r)
    return _one_out(db, r)


@admin_router.post("/{rule_id}/enable", response_model=EmailAutomationOut)
def enable_rule(
    rule_id: str = Path(..., max_length=64),
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """打开。从这一刻起满足条件的人才会收到，之前的不补发。"""
    r = _get(db, rule_id)
    if not mailer.mail_configured():
        raise HTTPException(status_code=400, detail="发信未配置（RESEND_API_KEY）/ Email is not configured")
    if not r.enabled:
        now = eb._utcnow()
        r.enabled = True
        r.activated_at = now
        r.updated_at = now
        _audit(db, admin, "enable", r)
        db.commit()
        db.refresh(r)
    return _one_out(db, r)


@admin_router.post("/{rule_id}/disable", response_model=EmailAutomationOut)
def disable_rule(
    rule_id: str = Path(..., max_length=64),
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """关闭。还没发出去的记为跳过——重新打开时它们已经过时了。"""
    r = _get(db, rule_id)
    if r.enabled:
        r.enabled = False
        r.updated_at = eb._utcnow()
        skipped = ea.skip_pending(db, r.id, "rule_disabled")
        _audit(db, admin, "disable", r, skipped=skipped)
        db.commit()
        db.refresh(r)
    return _one_out(db, r)


@admin_router.delete("/{rule_id}", response_model=dict)
def delete_rule(
    rule_id: str = Path(..., max_length=64),
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    r = _get(db, rule_id)
    now = eb._utcnow()
    r.enabled = False
    r.deleted_at = now
    r.updated_at = now
    skipped = ea.skip_pending(db, r.id, "rule_deleted")
    _audit(db, admin, "delete", r, skipped=skipped)
    db.commit()
    return {"ok": True}


@admin_router.post("/estimate", response_model=EmailAutomationEstimateOut)
def estimate_rule(body: EmailAutomationConditionIn, db: Session = Depends(get_db)):
    """按这个条件，最近 7 天会触发多少人。只数人，不发信、不入队。"""
    params = ea.RuleParams(
        trigger=body.trigger,
        delay_minutes=body.delayMinutes,
        plan_filter=body.planFilter,
        kind=body.kind,
        max_times=body.maxTimes,
    )
    return EmailAutomationEstimateOut(**ea.estimate(db, params))


@admin_router.post("/preview", response_model=EmailPreviewOut)
def preview_rule(body: EmailAutomationPreviewIn, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """渲染成最终的样子，变量用管理员自己的资料代入（到期类给一个示例到期时间）。"""
    now = eb._utcnow()
    msg = ea.build_for(db, _content(body.content), admin, ea.sample_cand(body.trigger, now), now)
    return EmailPreviewOut(subject=msg.subject, html=msg.html, text=msg.text)


@admin_router.post("/test", response_model=dict)
@limiter.limit("10/minute")
def test_rule(
    request: Request,
    body: EmailAutomationPreviewIn,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """发一封测试信给管理员自己（变量同预览）。不入库、不计入每日上限。"""
    if not mailer.mail_configured():
        raise HTTPException(status_code=400, detail="发信未配置（RESEND_API_KEY）/ Email is not configured")
    now = eb._utcnow()
    msg = ea.build_for(db, _content(body.content), admin, ea.sample_cand(body.trigger, now), now)
    result = mailer.deliver(admin.email, f"[测试 / Test] {msg.subject}", msg.html, msg.text, msg.headers)
    if not result.ok:
        if result.quota:
            raise HTTPException(status_code=502, detail="发信额度已用完 / The sending quota is used up")
        if result.status is None:
            raise HTTPException(status_code=502, detail="连不上发信商，请稍后再试 / Could not reach the email provider, try again shortly")
        raise HTTPException(
            status_code=502,
            detail=f"发信商拒绝了这封信（{result.status}）/ The email provider rejected it ({result.status})",
        )
    return {"ok": True, "to": admin.email}


@admin_router.post("/resume", response_model=dict)
def resume_all(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """提前解除整体暂停（续了额度 / 修好了发信配置之后点）。"""
    if ea.pause_state(db) is not None:
        ea.clear_pause(db)
        log_change(db, admin.id, admin.id, "email_auto:resume", None, "{}")
        db.commit()
    return {"ok": True}


@admin_router.get("/{rule_id}/sends", response_model=EmailAutomationSendListOut)
def list_sends(
    rule_id: str = Path(..., max_length=64),
    status: str | None = Query(default=None, pattern="^(pending|sending|sent|failed|skipped)$"),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    """这条规则的发送记录，新的在前。删掉的规则也能查（历史还在）。"""
    if db.get(EmailAutomation, rule_id) is None:
        raise HTTPException(status_code=404, detail="自动邮件规则不存在 / Rule not found")
    S = EmailAutomationSend
    q = db.query(S).filter(S.rule_id == rule_id)
    if status:
        q = q.filter(S.status == status)
    total = q.count()
    rows = q.order_by(S.created_at.desc(), S.id.desc()).offset(offset).limit(limit).all()
    ids = list({r.user_id for r in rows})
    users = {u.id: u for u in db.query(User).filter(User.id.in_(ids))} if ids else {}
    return EmailAutomationSendListOut(
        sends=[
            EmailAutomationSendOut(
                id=r.id,
                userId=r.user_id,
                email=users[r.user_id].email if r.user_id in users else None,
                nickname=users[r.user_id].nickname if r.user_id in users else None,
                status=r.status,
                error=r.error,
                createdAt=r.created_at,
                dueAt=r.due_at,
                sentAt=r.sent_at,
            )
            for r in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )
