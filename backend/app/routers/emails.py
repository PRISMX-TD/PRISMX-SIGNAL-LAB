"""群发邮件路由：管理端发起 / 查看 / 取消 / 继续；公开的退订页。

管理端只负责「把收件人名单落库」，真正发信的是 services/email_broadcast 里的
后台循环（理由见那个模块的说明）。所以「发送」接口返回得很快，进度靠列表接口轮询。

退订页由后端直接出一张极简 HTML，不走前端路由：点退订的人多半没登录、也可能
在一个没装 App 的设备上，而这一页除了一个按钮什么都不需要。GET 只展示确认按钮、
**不**直接退订——企业邮箱的安全网关会预先抓取信里的每个链接，GET 即退订会让这些
人莫名其妙被退订。真正退订是 POST：页面上的按钮，或邮件客户端的一键退订
（RFC 8058，List-Unsubscribe-Post）。

Admin broadcast endpoints plus the public unsubscribe page. Sending happens in
the background loop; these endpoints only enqueue and report. The unsubscribe
page is plain server-rendered HTML; GET only shows a confirm button, because
corporate mail scanners prefetch every link and a GET-unsubscribe would opt
people out without them ever clicking. POST (the button, or RFC 8058 one-click
from the mail client) performs it.
"""
import html as html_lib
import json
import logging
from datetime import timedelta
from typing import Literal
from urllib.parse import parse_qs

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request
from fastapi.responses import HTMLResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import EmailCampaign, EmailDelivery, MT5Account, User
from app.schemas import (
    EMAIL_LIST_MAX,
    EmailAudienceOut,
    EmailAudienceQueryIn,
    EmailCampaignIn,
    EmailCampaignListOut,
    EmailCampaignOut,
    EmailContentIn,
    EmailPickerIdsOut,
    EmailPickerListOut,
    EmailPickerUserOut,
    EmailPreviewOut,
    EmailStatusOut,
)
from app.services import email_broadcast as eb
from app.services import mailer
from app.services.audit import log_change
from app.services.deps import require_admin

logger = logging.getLogger("prismx.emails")

router = APIRouter(prefix="/email", tags=["email"])
admin_router = APIRouter(prefix="/admin/emails", tags=["admin"], dependencies=[Depends(require_admin)])

# 同一位管理员多少秒内发起同标题的群发，视为连点 / window treated as a double-submit
DUPLICATE_WINDOW_SECONDS = 60
LIST_LIMIT = 50


def _content(body: EmailContentIn) -> eb.Content:
    return eb.Content(
        kind=body.kind,
        subject_zh=body.subjectZh if body.subjectZh and body.bodyZh else "",
        body_zh=body.bodyZh if body.subjectZh and body.bodyZh else "",
        subject_en=body.subjectEn if body.subjectEn and body.bodyEn else "",
        body_en=body.bodyEn if body.subjectEn and body.bodyEn else "",
    )


def _campaign_out(c: EmailCampaign, counts: dict[str, int], creator_email: str | None) -> EmailCampaignOut:
    return EmailCampaignOut(
        id=c.id,
        kind=c.kind,
        subject=eb.Content.from_campaign(c).subject,
        status=c.status,
        lastError=c.last_error,
        createdAt=c.created_at,
        finishedAt=c.finished_at,
        createdByEmail=creator_email,
        audience=eb.audience_from_json(c.audience),
        total=sum(counts.values()),
        # 在发的那一两封算进待发：对管理员来说它们就是「还没发完」
        # in-flight rows count as pending: to the admin they are "not done yet"
        pending=counts.get("pending", 0) + counts.get("sending", 0),
        sent=counts.get("sent", 0),
        failed=counts.get("failed", 0),
        skipped=counts.get("skipped", 0),
    )


def _one_out(db: Session, c: EmailCampaign) -> EmailCampaignOut:
    counts = eb.delivery_counts(db, [c.id])[c.id]
    creator = db.get(User, c.created_by)
    return _campaign_out(c, counts, creator.email if creator else None)


# ---------- 管理端 / admin ----------

@admin_router.get("/status", response_model=EmailStatusOut)
def email_status(db: Session = Depends(get_db)):
    return EmailStatusOut(
        configured=mailer.mail_configured(),
        fromAddress=settings.MAIL_FROM,
        dailyCap=settings.BROADCAST_EMAIL_DAILY_CAP,
        sentToday=eb.sent_today(db),
    )


@admin_router.post("/audience", response_model=EmailAudienceOut)
def email_audience(body: EmailAudienceQueryIn, db: Session = Depends(get_db)):
    """按条件数人数（并给几个样例邮箱抽查），不发任何东西。"""
    return EmailAudienceOut(**eb.audience_summary(db, body.kind, body.audience))


_PlanFilter = Literal["all", "FREE", "PRO", "TRIAL", "PAID"]
_SortKey = Literal["created", "active"]


@admin_router.get("/users", response_model=EmailPickerListOut)
def picker_users(
    q: str | None = Query(default=None, max_length=128),
    plan: _PlanFilter = Query(default="all"),
    active_within_days: int | None = Query(default=None, alias="activeWithinDays", ge=1, le=3650),
    inactive_for_days: int | None = Query(default=None, alias="inactiveForDays", ge=1, le=3650),
    sort: _SortKey = Query(default="created"),
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: Session = Depends(get_db),
):
    """「指定用户」的选人列表：带详情分页返回，停用 / 退订的人也列出来但标明状态。"""
    query = eb.picker_query(db, q, plan, active_within_days, inactive_for_days, sort)
    total = query.count()
    rows = query.offset(offset).limit(limit).all()
    ids = [u.id for u in rows]
    counts = dict(
        db.query(MT5Account.user_id, func.count(MT5Account.id))
        .filter(MT5Account.user_id.in_(ids))
        .group_by(MT5Account.user_id)
        .all()
    ) if ids else {}
    opted = eb.opted_out_ids(db, ids)
    return EmailPickerListOut(
        users=[
            EmailPickerUserOut(
                id=u.id,
                email=u.email,
                nickname=u.nickname,
                phone=u.phone,
                plan=u.plan,
                planIsTrial=bool(u.plan_is_trial),
                planExpiresAt=u.plan_expires_at,
                createdAt=u.created_at,
                lastActiveAt=u.last_active_at,
                mt5AccountCount=counts.get(u.id, 0),
                inviteCode=u.invite_code,
                disabled=u.disabled_at is not None,
                optedOut=u.id in opted,
            )
            for u in rows
        ],
        total=total,
        limit=limit,
        offset=offset,
    )


@admin_router.get("/users/all", response_model=EmailPickerIdsOut)
def picker_select_all(
    kind: Literal["marketing", "notice"] = Query(default="marketing"),
    q: str | None = Query(default=None, max_length=128),
    plan: _PlanFilter = Query(default="all"),
    active_within_days: int | None = Query(default=None, alias="activeWithinDays", ge=1, le=3650),
    inactive_for_days: int | None = Query(default=None, alias="inactiveForDays", ge=1, le=3650),
    db: Session = Depends(get_db),
):
    """「选中全部搜索结果」：只返回按这次邮件类型真正收得到的人，最多 EMAIL_LIST_MAX 个。"""
    query = eb.picker_query(db, q, plan, active_within_days, inactive_for_days).filter(User.disabled_at.is_(None))
    if kind != eb.KIND_NOTICE:
        query = query.filter(~eb._opted_out_clause())
    rows = query.with_entities(User.id, User.email).limit(EMAIL_LIST_MAX + 1).all()
    return EmailPickerIdsOut(
        users=[{"id": uid, "email": email} for uid, email in rows[:EMAIL_LIST_MAX]],
        truncated=len(rows) > EMAIL_LIST_MAX,
    )


@admin_router.post("/preview", response_model=EmailPreviewOut)
def email_preview(body: EmailContentIn, admin: User = Depends(require_admin)):
    """渲染成最终的样子。退订链接用管理员自己的——预览里点它退订的就是自己。"""
    unsub = eb.unsubscribe_url(admin.id) if body.kind != eb.KIND_NOTICE else None
    msg = eb.build_message(_content(body), unsub)
    return EmailPreviewOut(subject=msg.subject, html=msg.html, text=msg.text)


@admin_router.post("/test", response_model=dict)
@limiter.limit("10/minute")
def email_test(request: Request, body: EmailContentIn, admin: User = Depends(require_admin)):
    """发一封测试信给管理员自己。不入库、不计入每日上限。"""
    if not mailer.mail_configured():
        raise HTTPException(status_code=400, detail="发信未配置（RESEND_API_KEY）/ Email is not configured")
    unsub = eb.unsubscribe_url(admin.id) if body.kind != eb.KIND_NOTICE else None
    msg = eb.build_message(_content(body), unsub)
    result = mailer.deliver(admin.email, f"[测试 / Test] {msg.subject}", msg.html, msg.text, msg.headers)
    if not result.ok:
        if result.status is None:
            raise HTTPException(status_code=502, detail="连不上发信商，请稍后再试 / Could not reach the email provider, try again shortly")
        code = result.status
        raise HTTPException(status_code=502, detail=f"发信商拒绝了这封信（{code}）/ The email provider rejected it ({code})")
    return {"ok": True, "to": admin.email}


@admin_router.post("", response_model=EmailCampaignOut)
def create_campaign(body: EmailCampaignIn, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """发起一次群发：展开收件人名单并入队，立即返回；发送由后台循环完成。"""
    if not mailer.mail_configured():
        raise HTTPException(status_code=400, detail="发信未配置（RESEND_API_KEY）/ Email is not configured")
    content = _content(body.content)

    since = eb._utcnow() - timedelta(seconds=DUPLICATE_WINDOW_SECONDS)
    dup = (
        db.query(EmailCampaign.id)
        .filter(
            EmailCampaign.created_by == admin.id,
            EmailCampaign.created_at >= since,
            EmailCampaign.subject_zh == (content.subject_zh or None),
            EmailCampaign.subject_en == (content.subject_en or None),
        )
        .first()
    )
    if dup:
        raise HTTPException(status_code=409, detail="刚刚已经发起过同标题的群发 / An identical broadcast was just started")

    campaign = EmailCampaign(
        created_by=admin.id,
        created_at=eb._utcnow(),
        kind=content.kind,
        subject_zh=content.subject_zh or None,
        body_zh=content.body_zh or None,
        subject_en=content.subject_en or None,
        body_en=content.body_en or None,
        audience=json.dumps(eb.audience_snapshot(body.audience), ensure_ascii=False),
        status="sending",
    )
    db.add(campaign)
    db.flush()
    n = eb.enqueue(db, campaign, content.kind, body.audience)
    if n == 0:
        db.rollback()
        raise HTTPException(status_code=400, detail="没有符合条件的收件人 / No recipients match")
    log_change(
        db, admin.id, admin.id, "email:send", None,
        json.dumps({"id": campaign.id, "kind": content.kind, "recipients": n}, ensure_ascii=False),
    )
    db.commit()
    db.refresh(campaign)
    return _one_out(db, campaign)


@admin_router.get("", response_model=EmailCampaignListOut)
def list_campaigns(db: Session = Depends(get_db)):
    rows = db.query(EmailCampaign).order_by(EmailCampaign.created_at.desc()).limit(LIST_LIMIT).all()
    counts = eb.delivery_counts(db, [c.id for c in rows])
    creator_ids = {c.created_by for c in rows}
    emails = dict(db.query(User.id, User.email).filter(User.id.in_(creator_ids)).all()) if creator_ids else {}
    return EmailCampaignListOut(campaigns=[_campaign_out(c, counts[c.id], emails.get(c.created_by)) for c in rows])


def _get_campaign(db: Session, campaign_id: str) -> EmailCampaign:
    c = db.get(EmailCampaign, campaign_id)
    if c is None:
        raise HTTPException(status_code=404, detail="群发不存在 / Broadcast not found")
    return c


@admin_router.post("/{campaign_id}/cancel", response_model=EmailCampaignOut)
def cancel_campaign(
    campaign_id: str = Path(..., max_length=64),
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """取消：还没发的全部记为跳过。已经发出去的收不回来。"""
    c = _get_campaign(db, campaign_id)
    if c.status not in ("sending", "paused"):
        raise HTTPException(status_code=400, detail="这次群发已经结束 / This broadcast has already finished")
    old = c.status
    c.status = "cancelled"
    c.finished_at = eb._utcnow()
    db.query(EmailDelivery).filter(
        EmailDelivery.campaign_id == c.id, EmailDelivery.status == "pending"
    ).update({"status": "skipped", "error": "cancelled"}, synchronize_session=False)
    log_change(db, admin.id, admin.id, "email:cancel", old, json.dumps({"id": c.id, "status": "cancelled"}))
    db.commit()
    return _one_out(db, c)


@admin_router.post("/{campaign_id}/resume", response_model=EmailCampaignOut)
def resume_campaign(
    campaign_id: str = Path(..., max_length=64),
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """继续一场因发信商拒绝配置而暂停的群发（修好配置之后点）。"""
    c = _get_campaign(db, campaign_id)
    if c.status != "paused":
        raise HTTPException(status_code=400, detail="只有已暂停的群发可以继续 / Only a paused broadcast can resume")
    if not mailer.mail_configured():
        raise HTTPException(status_code=400, detail="发信未配置（RESEND_API_KEY）/ Email is not configured")
    c.status = "sending"
    c.last_error = None
    log_change(db, admin.id, admin.id, "email:resume", "paused", json.dumps({"id": c.id, "status": "sending"}))
    db.commit()
    return _one_out(db, c)


# ---------- 公开：退订 / public: unsubscribe ----------

_PAGE_HEADERS = {
    "Cache-Control": "no-store",
    # 令牌在 URL 里，不能经 Referer 带到别处 / the token is in the URL; keep it out of Referer
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
}


def _page(title: str, body_html: str, status_code: int = 200) -> HTMLResponse:
    doc = f"""<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{html_lib.escape(title)}</title></head>
<body style="margin:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#18181b">
<div style="max-width:440px;margin:64px auto;padding:28px 24px;background:#fff;border-radius:14px;line-height:1.7">
<p style="margin:0 0 16px;font-size:13px;font-weight:600;letter-spacing:.04em;color:#52525b">PRISMX Signal Lab</p>
{body_html}
</div></body></html>"""
    return HTMLResponse(doc, status_code=status_code, headers=_PAGE_HEADERS)


def _button_form(action: str, token: str, label: str, primary: bool = True) -> str:
    style = (
        "background:#18181b;color:#fff;border:none" if primary
        else "background:#fff;color:#18181b;border:1px solid #d4d4d8"
    )
    return (
        f'<form method="post" action="{html_lib.escape(action)}" style="margin:0">'
        f'<input type="hidden" name="t" value="{html_lib.escape(token)}">'
        f'<button type="submit" style="{style};padding:10px 20px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer">{label}</button>'
        "</form>"
    )


def _invalid_page() -> HTMLResponse:
    return _page(
        "链接无效 / Invalid link",
        '<h1 style="margin:0 0 12px;font-size:20px">链接无效 / Invalid link</h1>'
        '<p style="margin:0;color:#52525b">这个退订链接无法识别。请直接回复任意一封我们的邮件，或在网站提交工单，我们会为你处理。</p>'
        '<p style="margin:8px 0 0;color:#52525b;font-size:14px">This unsubscribe link could not be verified. Reply to any of our emails or open a ticket on the website and we will take care of it.</p>',
        status_code=400,
    )


async def _form_token(request: Request) -> tuple[str | None, bool]:
    """从 POST 里取令牌：查询串（一键退订的 URL 自带）或表单字段。第二项 = 是否一键退订。"""
    token = request.query_params.get("t")
    one_click = False
    raw = (await request.body())[:4096]
    if raw:
        form = parse_qs(raw.decode("utf-8", "replace"))
        token = token or (form.get("t") or [None])[0]
        one_click = (form.get("List-Unsubscribe") or [""])[0] == "One-Click"
    return token, one_click


@router.get("/unsubscribe", response_class=HTMLResponse)
@limiter.limit("60/minute")
def unsubscribe_page(request: Request, t: str = Query("", max_length=200)):
    if not eb.read_unsubscribe_token(t):
        return _invalid_page()
    return _page(
        "退订 / Unsubscribe",
        '<h1 style="margin:0 0 12px;font-size:20px">退订推广邮件 / Unsubscribe</h1>'
        '<p style="margin:0 0 4px">确认后，你将不再收到 PRISMX Signal Lab 的推广邮件。账号安全相关的邮件（如找回密码）不受影响。</p>'
        '<p style="margin:0 0 20px;color:#52525b;font-size:14px">You will stop receiving marketing email from PRISMX Signal Lab. Account emails such as password resets are not affected.</p>'
        + _button_form("unsubscribe", t, "确认退订 / Unsubscribe"),
    )


@router.post("/unsubscribe")
@limiter.limit("60/minute")
async def unsubscribe(request: Request, db: Session = Depends(get_db)):
    token, one_click = await _form_token(request)
    user_id = eb.read_unsubscribe_token(token)
    if not user_id:
        return _invalid_page()
    if db.get(User, user_id) is not None:
        eb.set_opted_out(db, user_id, True)
        db.commit()
    if one_click:
        # 邮件客户端的一键退订不看页面，回个 200 就行 / mail clients only need a 200
        return HTMLResponse("ok", headers=_PAGE_HEADERS)
    return _page(
        "已退订 / Unsubscribed",
        '<h1 style="margin:0 0 12px;font-size:20px">已退订 / You are unsubscribed</h1>'
        '<p style="margin:0 0 4px">你不会再收到我们的推广邮件。</p>'
        '<p style="margin:0 0 20px;color:#52525b;font-size:14px">You will no longer receive marketing email from us.</p>'
        + _button_form("resubscribe", token, "点错了，重新订阅 / Undo", primary=False),
    )


@router.post("/resubscribe")
@limiter.limit("60/minute")
async def resubscribe(request: Request, db: Session = Depends(get_db)):
    token, _ = await _form_token(request)
    user_id = eb.read_unsubscribe_token(token)
    if not user_id:
        return _invalid_page()
    eb.set_opted_out(db, user_id, False)
    db.commit()
    return _page(
        "已重新订阅 / Resubscribed",
        '<h1 style="margin:0 0 12px;font-size:20px">已重新订阅 / You are subscribed again</h1>'
        '<p style="margin:0 0 4px">你会继续收到我们的邮件。</p>'
        '<p style="margin:0;color:#52525b;font-size:14px">You will keep receiving our emails.</p>',
    )
