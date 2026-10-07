"""管理后台群发邮件：渲染、收件人筛选、退订令牌、后台发送循环。

**发起与发送分开。** 管理员点「发送」时只做一件事：把收件人名单展开成
email_deliveries 的行（每人一行、status=pending），立刻返回。真正发信的是
email_broadcast_loop——跑在 BackgroundLoops 里（多 worker 时只有领导进程跑），
一封一封地发、按 BROADCAST_EMAIL_INTERVAL_SECONDS 限速、每天到
BROADCAST_EMAIL_DAILY_CAP 就停到第二天。进程重启、换主，都从 pending 的行接着发。

**一封信绝不发两次。** 每封信先「认领」：`UPDATE ... SET status='sending' WHERE
id=:id AND status='pending'`，受影响行数为 1 才发。进程在「已认领、没记结果」之间
死掉的那几行会停在 sending；下一轮把超时的 sending 行记成 failed（interrupted），
**不**放回 pending——那封信可能已经发出去了，群发里少一封远比重复一封好。

**发送那一刻再判一次资格。** 排队期间被停用、点了退订、账号被删的人，认领时
直接记 skipped，不会因为「发起时还符合条件」就照发。

**退订令牌无状态。** 令牌 = user_id + HMAC(JWT_SECRET)，不入库、不过期——退订
链接在一年后的旧邮件里点开也必须有效。代价是轮换 JWT_SECRET 会让旧信里的退订
链接失效（页面会提示去账号里联系客服），可以接受。

Admin email broadcasts. Creating a campaign only expands its recipients into
pending email_deliveries rows; email_broadcast_loop (leader-only via
BackgroundLoops) sends them one at a time, rate-limited and capped per UTC day,
resuming from pending rows after restarts. Each send is claimed with a
conditional UPDATE so nothing is sent twice; rows stranded in `sending` by a
crash are marked failed rather than retried, since the message may have gone
out. Eligibility is re-checked at send time. Unsubscribe tokens are stateless
HMACs that never expire.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import html as html_lib
import json
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

from sqlalchemy import exists, func, or_
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.database import SessionLocal
from app.models import EmailCampaign, EmailDelivery, EmailOptOut, User
from app.services import mailer

logger = logging.getLogger("prismx.email_broadcast")

KIND_MARKETING = "marketing"
KIND_NOTICE = "notice"

# 后台循环的节奏 / loop pacing
STARTUP_DELAY_SECONDS = 20
IDLE_SECONDS = 15
# 到了每日上限后多久再看一次：跨过 UTC 零点后最多晚这么久恢复。
# How often to re-check once the daily cap is hit.
CAP_RECHECK_SECONDS = 300
# 限流 / 发信商 5xx / 网络错误之后歇多久 / back-off after a retryable failure
RETRY_BACKOFF_SECONDS = 30
# 同一封信最多尝试几次（只有可重试的失败才会再试）/ attempts before giving up
MAX_ATTEMPTS = 3
# 已认领却迟迟没有结果的行，多久之后判为中断 / when a stuck `sending` row counts as interrupted
STALE_CLAIM_MINUTES = 10
# 每轮最多发多少封就让出一次（让关停 / 换主能及时生效）/ sends per pass before yielding
MAX_SENDS_PER_PASS = 50


def _utcnow() -> datetime:
    """naive UTC——库里的 DateTime 列都按 naive UTC 比较（见 stats_time.day_start_utc）。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


# ---------------------------------------------------------------------------
# 渲染 / rendering
# ---------------------------------------------------------------------------

# 正文里认四种行内标记，按优先级：
#   [![说明](https://图片)](https://链接)   可点的图片（横幅）
#   ![说明](https://图片)                   图片
#   [文字](https://链接)                    链接
#   https://...                             裸链接
# 地址只收 URL 里合法的 ASCII 字符：中文紧跟在链接后面（「看 https://a.com/x。还有」）
# 时不会被吞进去；引号、尖括号、空白也就进不了 href / src 属性。图片只收 https——
# 邮件客户端对 http 图片会提示「不安全内容」或直接不显示。
# Four inline forms, in priority order: linked image, image, link, bare URL.
# Addresses are limited to ASCII URL characters so adjacent CJK text is not
# swallowed and quotes / angle brackets never reach href / src. Images must be
# https: mail clients warn about or drop plain-http images.
_URL_CHARS = r"[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+"
_TOKEN_RE = re.compile(
    r"(?P<limg>\[!\[(?P<la>[^\]\n]{0,200})\]\((?P<lsrc>https://" + _URL_CHARS + r")\)\]\((?P<lhref>https?://" + _URL_CHARS + r")\))"
    r"|(?P<img>!\[(?P<ia>[^\]\n]{0,200})\]\((?P<isrc>https://" + _URL_CHARS + r")\))"
    r"|(?P<link>\[(?P<label>[^\]\n]{1,200})\]\((?P<href>https?://" + _URL_CHARS + r")\))"
    r"|(?P<bare>https?://" + _URL_CHARS + ")"
)
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*")
# 裸链接末尾的标点多半是句子的，不是链接的 / trailing punctuation belongs to the sentence
_TRAILING_PUNCT = ".,;:!?)）。，；：！？、"

_LINK_STYLE = "color:#4f46e5;text-decoration:underline"
# 固定 512 宽（信件内容区 560 减去两侧留白）：Outlook 桌面版不认 max-width，不给
# width 属性的大图会把整封信撑破；其余客户端按 max-width:100% 在手机上自动缩小。
# A fixed 512px width (the 560px body minus padding): desktop Outlook ignores
# max-width and a large image without a width attribute blows the layout apart;
# everything else scales it down on phones via max-width:100%.
_IMG_STYLE = "display:block;width:100%;max-width:512px;height:auto;border:0;border-radius:8px;margin:8px 0"


def _inline_html(segment: str) -> str:
    """转义后再处理加粗：`**` 不受转义影响，所以顺序是安全的。"""
    return _BOLD_RE.sub(r'<strong>\1</strong>', html_lib.escape(segment, quote=False))


def _img_html(src: str, alt: str) -> str:
    return (
        f'<img src="{html_lib.escape(src, quote=True)}" alt="{html_lib.escape(alt, quote=True)}" '
        f'width="512" style="{_IMG_STYLE}">'
    )


# 一整行只有一个 https 图片地址（可带一对括号）时，直接当图片：管理员常常是把图床
# 链接直接粘进来，不会记得写 ![]()。只认图片扩展名，普通网页链接照旧是链接。
# A line holding nothing but an https image address (optionally in parentheses)
# is treated as an image: admins paste bucket links without the ![]() wrapper.
# Only image extensions qualify, so ordinary page links stay links.
_BARE_IMG_LINE_RE = re.compile(r"^\(?\s*(https://" + _URL_CHARS + r")\s*\)?$")
_IMG_EXTS = (".png", ".jpg", ".jpeg", ".gif", ".webp")


def _bare_image_line(line: str) -> str | None:
    m = _BARE_IMG_LINE_RE.match(line.strip())
    if not m:
        return None
    url = m.group(1)
    path = urlsplit(url).path.lower()
    return url if path.endswith(_IMG_EXTS) else None


def _line_html(line: str) -> str:
    src = _bare_image_line(line)
    if src:
        return _img_html(src, "")
    out: list[str] = []
    pos = 0
    for m in _TOKEN_RE.finditer(line):
        end = m.end()
        if m.group("limg"):
            href = html_lib.escape(m.group("lhref"), quote=True)
            piece = f'<a href="{href}">{_img_html(m.group("lsrc"), m.group("la"))}</a>'
        elif m.group("img"):
            piece = _img_html(m.group("isrc"), m.group("ia"))
        else:
            if m.group("bare"):
                url = label = m.group("bare").rstrip(_TRAILING_PUNCT)
                end = m.start() + len(url)
            else:
                url, label = m.group("href"), m.group("label")
            piece = f'<a href="{html_lib.escape(url, quote=True)}" style="{_LINK_STYLE}">{_inline_html(label)}</a>'
        out.append(_inline_html(line[pos:m.start()]))
        out.append(piece)
        pos = end
    out.append(_inline_html(line[pos:]))
    return "".join(out)


def _paragraphs(body: str) -> list[str]:
    return [p.strip("\n") for p in re.split(r"\n\s*\n", body.replace("\r\n", "\n").strip()) if p.strip()]


def render_body_html(body: str) -> str:
    """纯文本 + 轻量标记 → 内联样式的 HTML 段落。"""
    parts = []
    for para in _paragraphs(body):
        lines = "<br>".join(_line_html(line) for line in para.split("\n"))
        parts.append(f'<p style="margin:0 0 14px">{lines}</p>')
    return "\n".join(parts)


def render_body_text(body: str) -> str:
    """纯文本版：链接写成「文字 (地址)」，图片写成「[图片：说明] 地址」，去掉加粗记号。"""
    def _token(m: re.Match) -> str:
        if m.group("limg"):
            return f"[图片 / Image{': ' + m.group('la') if m.group('la') else ''}] {m.group('lhref')}"
        if m.group("img"):
            return f"[图片 / Image{': ' + m.group('ia') if m.group('ia') else ''}] {m.group('isrc')}"
        if m.group("bare"):
            return m.group("bare")
        return f"{m.group('label')} ({m.group('href')})"

    lines = []
    for line in body.replace("\r\n", "\n").strip().split("\n"):
        src = _bare_image_line(line)
        lines.append(f"[图片 / Image] {src}" if src else _TOKEN_RE.sub(_token, line))
    text = _BOLD_RE.sub(r"\1", "\n".join(lines))
    return "\n\n".join(_paragraphs(text))


@dataclass(frozen=True)
class Content:
    kind: str
    subject_zh: str
    body_zh: str
    subject_en: str
    body_en: str

    @classmethod
    def from_campaign(cls, c: EmailCampaign) -> "Content":
        return cls(
            kind=c.kind or KIND_MARKETING,
            subject_zh=c.subject_zh or "",
            body_zh=c.body_zh or "",
            subject_en=c.subject_en or "",
            body_en=c.body_en or "",
        )

    @property
    def has_zh(self) -> bool:
        return bool(self.subject_zh and self.body_zh)

    @property
    def has_en(self) -> bool:
        return bool(self.subject_en and self.body_en)

    @property
    def subject(self) -> str:
        if self.has_zh and self.has_en:
            return f"{self.subject_zh} / {self.subject_en}"
        return self.subject_zh if self.has_zh else self.subject_en


@dataclass(frozen=True)
class Message:
    subject: str
    html: str
    text: str
    headers: dict[str, str]


_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif"


def build_message(content: Content, unsubscribe_url: str | None) -> Message:
    """拼出一封完整的信。

    版式与找回密码那封一致：全部内联样式、不放图片（图片默认被屏蔽）。中英都填了
    就中文在上、英文在下，中间一条分隔线。推广邮件底部带退订链接，并加上
    List-Unsubscribe / List-Unsubscribe-Post 邮件头——Gmail、Yahoo 对批量发信要求
    一键退订，缺了这两个头更容易进垃圾箱。服务通知不带退订（它本来就不看退订）。

    Same layout rules as the password-reset mail (inline styles, no images).
    Marketing mail carries a footer unsubscribe link plus the RFC 8058 one-click
    headers that Gmail and Yahoo require of bulk senders; notices carry neither.
    """
    marketing = content.kind != KIND_NOTICE
    langs = [lang for lang, ok in (("zh", content.has_zh), ("en", content.has_en)) if ok]

    html_sections: list[str] = []
    text_sections: list[str] = []
    for lang in langs:
        subject = content.subject_zh if lang == "zh" else content.subject_en
        body = content.body_zh if lang == "zh" else content.body_en
        html_sections.append(
            f'<h2 style="margin:0 0 16px;font-size:18px;font-weight:600">{html_lib.escape(subject, quote=False)}</h2>\n'
            + render_body_html(body)
        )
        text_sections.append(f"{subject}\n\n{render_body_text(body)}")

    footer_html: list[str] = []
    footer_text: list[str] = []
    if marketing and unsubscribe_url:
        href = html_lib.escape(unsubscribe_url, quote=True)
        link = f'<a href="{href}" style="color:#71717a;text-decoration:underline">'
        if "zh" in langs:
            footer_html.append(f"你收到这封邮件，是因为你注册了 PRISMX Signal Lab。不想再收到此类邮件？{link}退订</a>")
            footer_text.append(f"你收到这封邮件，是因为你注册了 PRISMX Signal Lab。退订：{unsubscribe_url}")
        if "en" in langs:
            footer_html.append(f"You're receiving this because you signed up for PRISMX Signal Lab. {link}Unsubscribe</a>")
            footer_text.append(f"You're receiving this because you signed up for PRISMX Signal Lab. Unsubscribe: {unsubscribe_url}")
    else:
        if "zh" in langs:
            footer_html.append("这是一封与你的 PRISMX Signal Lab 账号相关的服务通知。")
            footer_text.append("这是一封与你的 PRISMX Signal Lab 账号相关的服务通知。")
        if "en" in langs:
            footer_html.append("This is a service notice about your PRISMX Signal Lab account.")
            footer_text.append("This is a service notice about your PRISMX Signal Lab account.")

    divider = '<hr style="border:none;border-top:1px solid #e4e4e7;margin:24px 0">'
    html = (
        f'<div style="font-family:{_FONT};max-width:560px;margin:0 auto;padding:24px;color:#18181b;line-height:1.7;font-size:15px">\n'
        '<p style="margin:0 0 20px;font-size:13px;font-weight:600;letter-spacing:.04em;color:#52525b">PRISMX Signal Lab</p>\n'
        + f"\n{divider}\n".join(html_sections)
        + f"\n{divider}\n"
        + f'<p style="margin:0;color:#71717a;font-size:12px">{"<br>".join(footer_html)}</p>\n'
        "</div>"
    )
    text = "\n\n---\n\n".join(text_sections) + "\n\n---\n\n" + "\n".join(footer_text) + "\n"

    headers: dict[str, str] = {}
    if marketing and unsubscribe_url:
        headers["List-Unsubscribe"] = f"<{unsubscribe_url}>"
        headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click"
    return Message(subject=content.subject, html=html, text=text, headers=headers)


# ---------------------------------------------------------------------------
# 退订令牌 / unsubscribe tokens
# ---------------------------------------------------------------------------

def _unsub_sig(user_id: str) -> str:
    key = settings.JWT_SECRET.encode()
    return hmac.new(key, b"email-unsub:v1:" + user_id.encode(), hashlib.sha256).hexdigest()[:32]


def make_unsubscribe_token(user_id: str) -> str:
    uid = base64.urlsafe_b64encode(user_id.encode()).decode().rstrip("=")
    return f"{uid}.{_unsub_sig(user_id)}"


def read_unsubscribe_token(token: str | None) -> str | None:
    """验签成功返回 user_id，否则 None。/ The user id for a valid token, else None."""
    if not token or "." not in token or len(token) > 200:
        return None
    uid_b64, _, sig = token.partition(".")
    try:
        user_id = base64.urlsafe_b64decode(uid_b64 + "=" * (-len(uid_b64) % 4)).decode()
    except Exception:  # noqa: BLE001 —— 任何解码失败都只是「无效令牌」
        return None
    if not user_id:
        return None
    # 按字节比较：签名段里带非 ASCII 字符时 str 版 compare_digest 会抛 TypeError
    # （变成 500），这里一律当作无效令牌。
    # Compare as bytes: a non-ASCII signature segment makes the str form of
    # compare_digest raise TypeError (a 500); treat it as an invalid token.
    try:
        ok = hmac.compare_digest(sig.encode("utf-8"), _unsub_sig(user_id).encode("utf-8"))
    except (TypeError, UnicodeError):
        return None
    if not ok:
        return None
    return user_id


def unsubscribe_url(user_id: str) -> str:
    base = (settings.PUBLIC_API_URL or "").rstrip("/")
    return f"{base}{settings.API_PREFIX}/email/unsubscribe?t={make_unsubscribe_token(user_id)}"


def set_opted_out(db: Session, user_id: str, opted_out: bool) -> None:
    """记 / 撤销退订，幂等。调用方 commit。/ Idempotent; the caller commits."""
    row = db.get(EmailOptOut, user_id)
    if opted_out and row is None:
        db.add(EmailOptOut(user_id=user_id))
    elif not opted_out and row is not None:
        db.delete(row)


# ---------------------------------------------------------------------------
# 收件人 / audience
# ---------------------------------------------------------------------------

def _opted_out_clause():
    return exists().where(EmailOptOut.user_id == User.id)


def _base_query(db: Session, audience) -> tuple:
    """按筛选条件（**不含**停用与退订两道闸）取 User 查询，外加未匹配的邮箱数。"""
    q = db.query(User).filter(User.email.contains("@"))
    unmatched = 0
    if audience.mode == "list":
        conds = []
        if audience.userIds:
            conds.append(User.id.in_(audience.userIds))
        if audience.emails:
            conds.append(func.lower(User.email).in_(audience.emails))
            found = {
                e for (e,) in db.query(func.lower(User.email)).filter(func.lower(User.email).in_(audience.emails))
            }
            unmatched = len(set(audience.emails) - found)
        q = q.filter(or_(*conds))
        return q, unmatched

    now = _utcnow()
    if audience.plan == "FREE":
        q = q.filter(User.plan == "FREE")
    elif audience.plan == "PRO":
        q = q.filter(User.plan == "PRO")
    elif audience.plan == "TRIAL":
        q = q.filter(User.plan == "PRO", User.plan_is_trial.is_(True))
    elif audience.plan == "PAID":
        q = q.filter(User.plan == "PRO", or_(User.plan_is_trial.is_(False), User.plan_is_trial.is_(None)))
    if audience.activeWithinDays:
        q = q.filter(User.last_active_at >= now - timedelta(days=audience.activeWithinDays))
    if audience.inactiveForDays:
        cutoff = now - timedelta(days=audience.inactiveForDays)
        q = q.filter(or_(User.last_active_at < cutoff, User.last_active_at.is_(None)))
    return q, unmatched


def eligible_query(db: Session, kind: str, audience):
    """最终收件人：筛选条件 + 未停用 + （推广时）未退订。"""
    q, _ = _base_query(db, audience)
    q = q.filter(User.disabled_at.is_(None))
    if kind != KIND_NOTICE:
        q = q.filter(~_opted_out_clause())
    return q


def audience_summary(db: Session, kind: str, audience, sample_size: int = 5) -> dict:
    base, unmatched = _base_query(db, audience)
    excluded_disabled = base.filter(User.disabled_at.isnot(None)).count()
    excluded_opted_out = 0
    if kind != KIND_NOTICE:
        excluded_opted_out = base.filter(User.disabled_at.is_(None), _opted_out_clause()).count()
    q = eligible_query(db, kind, audience)
    count = q.count()
    sample = [e for (e,) in q.with_entities(User.email).order_by(User.created_at.desc()).limit(sample_size)]
    return {
        "count": count,
        "excludedDisabled": excluded_disabled,
        "excludedOptedOut": excluded_opted_out,
        "unmatchedEmails": unmatched,
        "sample": sample,
    }


def _like_escape(value: str) -> str:
    # 与 routers/admin._like_escape 同理：% 和 _ 不转义会悄悄放大命中范围。
    # Same reason as routers/admin._like_escape: unescaped % and _ widen the match.
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


PICKER_SORTS = ("created", "active")


def picker_query(db: Session, q: str | None, plan: str, active_within_days: int | None,
                 inactive_for_days: int | None, sort: str = "created"):
    """「指定用户」选人列表的查询：搜索（邮箱 / 昵称 / 手机号）+ 等级 + 活跃度。

    **不**在这里排除停用和退订的人——选人列表要让管理员看得见他们（标出状态、
    不给勾），否则「我明明搜得到这个人，为什么列表里没有」没法解释。真正发送时
    eligible_query 照样会把他们排除。

    Query behind the "specific users" picker. Disabled / unsubscribed users are
    deliberately kept (shown with a status, not selectable) so the admin can see
    why someone is missing; eligible_query still excludes them at send time.
    """
    query = db.query(User).filter(User.email.contains("@"))
    if q and q.strip():
        like = f"%{_like_escape(q.strip())}%"
        query = query.filter(or_(
            User.email.ilike(like, escape="\\"),
            User.nickname.ilike(like, escape="\\"),
            User.phone.ilike(like, escape="\\"),
        ))
    now = _utcnow()
    if plan == "FREE":
        query = query.filter(User.plan == "FREE")
    elif plan == "PRO":
        query = query.filter(User.plan == "PRO")
    elif plan == "TRIAL":
        query = query.filter(User.plan == "PRO", User.plan_is_trial.is_(True))
    elif plan == "PAID":
        query = query.filter(User.plan == "PRO", or_(User.plan_is_trial.is_(False), User.plan_is_trial.is_(None)))
    if active_within_days:
        query = query.filter(User.last_active_at >= now - timedelta(days=active_within_days))
    if inactive_for_days:
        cutoff = now - timedelta(days=inactive_for_days)
        query = query.filter(or_(User.last_active_at < cutoff, User.last_active_at.is_(None)))
    if sort == "active":
        # 从没活跃过的排最后 / never-active users go last
        query = query.order_by(User.last_active_at.is_(None), User.last_active_at.desc(), User.created_at.desc())
    else:
        query = query.order_by(User.created_at.desc())
    return query


def opted_out_ids(db: Session, user_ids: list[str]) -> set[str]:
    if not user_ids:
        return set()
    return {uid for (uid,) in db.query(EmailOptOut.user_id).filter(EmailOptOut.user_id.in_(user_ids))}


def audience_snapshot(audience) -> dict:
    """存进 email_campaigns.audience 的快照。list 模式只留人数——几千个 id 没人会去看。"""
    if audience.mode == "list":
        return {"mode": "list", "listSize": len(audience.userIds) + len(audience.emails)}
    return {
        "mode": "filter",
        "plan": audience.plan,
        "activeWithinDays": audience.activeWithinDays,
        "inactiveForDays": audience.inactiveForDays,
    }


def enqueue(db: Session, campaign: EmailCampaign, kind: str, audience) -> int:
    """把收件人展开成 pending 行。调用方 commit。返回人数。"""
    ids = [uid for (uid,) in eligible_query(db, kind, audience).with_entities(User.id)]
    if ids:
        db.bulk_insert_mappings(
            EmailDelivery,
            [{"id": str(uuid.uuid4()), "campaign_id": campaign.id, "user_id": uid, "status": "pending", "attempts": 0} for uid in ids],
        )
    return len(ids)


def delivery_counts(db: Session, campaign_ids: list[str]) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {cid: {} for cid in campaign_ids}
    if not campaign_ids:
        return out
    rows = (
        db.query(EmailDelivery.campaign_id, EmailDelivery.status, func.count())
        .filter(EmailDelivery.campaign_id.in_(campaign_ids))
        .group_by(EmailDelivery.campaign_id, EmailDelivery.status)
        .all()
    )
    for cid, status, n in rows:
        out[cid][status] = n
    return out


def sent_today(db: Session) -> int:
    start = _utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    return db.query(func.count(EmailDelivery.id)).filter(EmailDelivery.sent_at >= start).scalar() or 0


# ---------------------------------------------------------------------------
# 发送循环 / the send loop
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Job:
    delivery_id: str
    campaign_id: str
    email: str
    message: Message


# claim_next 的另外两种结果 / claim_next's two non-job outcomes
IDLE = "idle"
CAP_REACHED = "cap"


def _fail_stale_claims(db: Session) -> None:
    cutoff = _utcnow() - timedelta(minutes=STALE_CLAIM_MINUTES)
    n = (
        db.query(EmailDelivery)
        .filter(EmailDelivery.status == "sending", EmailDelivery.claimed_at < cutoff)
        .update({"status": "failed", "error": "interrupted"}, synchronize_session=False)
    )
    if n:
        logger.warning("email_broadcast: %d 封信在发送中途被中断，记为失败 / interrupted sends marked failed", n)


# 额度用完时写进 email_campaigns.last_error 的两种原因 / last_error codes for a quota pause
QUOTA_DAILY_PREFIX = "quota_daily:"      # 后接暂停那天的 UTC 日期 / followed by the UTC date
QUOTA_MONTHLY = "quota_monthly"


def resume_after_daily_quota(db: Session) -> int:
    """过了 UTC 零点，把因每日额度暂停的群发恢复成发送中。调用方 commit。

    Resend 的每日额度按 UTC 日重置；暂停时记的是 UTC 日期，今天比它新就恢复。
    恢复后若额度其实还没回来，下一封会再被拒、再暂停一次——只多一个请求，无害。
    Resume campaigns paused by the daily quota once the UTC day has rolled over.
    """
    today = _utcnow().date().isoformat()
    n = 0
    for c in (
        db.query(EmailCampaign)
        .filter(EmailCampaign.status == "paused", EmailCampaign.last_error.like(f"{QUOTA_DAILY_PREFIX}%"))
        .all()
    ):
        if (c.last_error or "")[len(QUOTA_DAILY_PREFIX):] < today:
            c.status = "sending"
            c.last_error = None
            n += 1
    if n:
        logger.info("email_broadcast: 新的一天，%d 场因每日额度暂停的群发已恢复 / resumed", n)
    return n


def finish_drained_campaigns(db: Session) -> None:
    """把已经没有待发 / 在发行的「发送中」群发标成 done。调用方 commit。

    发送中的群发同一时刻最多几场，每场一条 count，放在每次认领之前跑也不贵；
    这样一场发完立刻显示「完成」，不必等排在后面的那场也发完。
    """
    for campaign in db.query(EmailCampaign).filter(EmailCampaign.status == "sending").all():
        open_rows = (
            db.query(func.count(EmailDelivery.id))
            .filter(EmailDelivery.campaign_id == campaign.id, EmailDelivery.status.in_(("pending", "sending")))
            .scalar()
        )
        if not open_rows:
            campaign.status = "done"
            campaign.finished_at = _utcnow()


def claim_next(db: Session) -> Job | str:
    """认领下一封要发的信。

    返回 Job，或 IDLE（没有要发的 / 没配发信），或 CAP_REACHED（今天的额度用完了）。
    资格不符的收件人在这里直接记 skipped，一次调用里可能跳过好几个再返回。
    按群发的发起时间先后发：先发起的先发完。
    Claim the next message to send (oldest campaign first), skipping ineligible
    recipients along the way.
    """
    if not mailer.mail_configured():
        return IDLE
    _fail_stale_claims(db)
    resume_after_daily_quota(db)
    finish_drained_campaigns(db)
    db.commit()

    cap = settings.BROADCAST_EMAIL_DAILY_CAP
    if cap > 0 and sent_today(db) >= cap:
        return CAP_REACHED

    for _ in range(200):
        row = (
            db.query(EmailDelivery)
            .join(EmailCampaign, EmailCampaign.id == EmailDelivery.campaign_id)
            .filter(EmailCampaign.status == "sending", EmailDelivery.status == "pending")
            .order_by(EmailCampaign.created_at, EmailDelivery.attempts, EmailDelivery.id)
            .first()
        )
        if row is None:
            finish_drained_campaigns(db)
            db.commit()
            return IDLE
        campaign = db.get(EmailCampaign, row.campaign_id)

        claimed = (
            db.query(EmailDelivery)
            .filter(EmailDelivery.id == row.id, EmailDelivery.status == "pending")
            .update(
                {"status": "sending", "claimed_at": _utcnow(), "attempts": EmailDelivery.attempts + 1},
                synchronize_session=False,
            )
        )
        db.commit()
        if claimed != 1:
            continue

        user = db.get(User, row.user_id)
        reason = None
        if user is None or not user.email or "@" not in user.email:
            reason = "no_user"
        elif user.disabled_at is not None:
            reason = "disabled"
        elif campaign.kind != KIND_NOTICE and db.get(EmailOptOut, user.id) is not None:
            reason = "opted_out"
        if reason:
            db.query(EmailDelivery).filter(EmailDelivery.id == row.id).update(
                {"status": "skipped", "error": reason}, synchronize_session=False
            )
            db.commit()
            continue

        content = Content.from_campaign(campaign)
        unsub = unsubscribe_url(user.id) if campaign.kind != KIND_NOTICE else None
        return Job(row.id, campaign.id, user.email, build_message(content, unsub))
    return IDLE


def record_result(db: Session, job: Job, result: mailer.SendResult) -> None:
    """落结果。可重试的失败没到次数上限就放回 pending；配置类错误整场暂停；
    额度用完暂停全部发送中的群发。"""
    q = db.query(EmailDelivery).filter(EmailDelivery.id == job.delivery_id)
    row = q.first()
    if row is None:
        return
    campaign = db.get(EmailCampaign, job.campaign_id)
    still_sending = campaign is not None and campaign.status == "sending"
    if result.ok:
        q.update({"status": "sent", "sent_at": _utcnow(), "error": None}, synchronize_session=False)
    elif campaign is not None and campaign.status == "cancelled":
        # 发的途中被取消了：失败的这封不再排队 / cancelled mid-send: don't requeue
        q.update({"status": "skipped", "error": "cancelled"}, synchronize_session=False)
    elif result.quota:
        # 发信额度用完：同样不是这位收件人的错，放回 pending、次数退回。暂停的是**所有**
        # 发送中的群发——额度是整个账号的，别的群发下一封也会被拒。每日额度用完记下日期，
        # 过了 UTC 零点由 claim_next 自动恢复；月额度要等管理员续费或下个月点「继续」。
        # Quota used up: also not the recipient's fault — requeue with the attempt
        # refunded, and pause every sending campaign, since the quota is account-wide.
        # A daily pause records its UTC date and resumes itself the next day; a
        # monthly one waits for the admin.
        q.update(
            {"status": "pending", "attempts": max(0, (row.attempts or 1) - 1), "error": None},
            synchronize_session=False,
        )
        reason = (
            f"{QUOTA_DAILY_PREFIX}{_utcnow().date().isoformat()}" if result.quota == "daily" else QUOTA_MONTHLY
        )
        for c in db.query(EmailCampaign).filter(EmailCampaign.status == "sending").all():
            c.status = "paused"
            c.last_error = reason
        logger.warning("email_broadcast: 发信额度用完（%s），群发已暂停 / quota exceeded, paused", result.quota)
    elif result.config_error:
        # 不是这位收件人的错：放回 pending、次数退回，整场暂停等管理员修配置。
        # Not this recipient's fault: back to pending, attempt refunded, campaign paused.
        q.update(
            {"status": "pending", "attempts": max(0, (row.attempts or 1) - 1), "error": None},
            synchronize_session=False,
        )
        if still_sending:
            campaign.status = "paused"
            campaign.last_error = f"provider_rejected_{result.status}"
    elif result.retryable and (row.attempts or 0) < MAX_ATTEMPTS:
        code = f"http_{result.status}" if result.status else "network"
        q.update({"status": "pending", "error": code}, synchronize_session=False)
    else:
        code = f"http_{result.status}" if result.status else "network"
        q.update({"status": "failed", "error": code}, synchronize_session=False)
    db.commit()


def _claim_sync() -> Job | str:
    db = SessionLocal()
    try:
        return claim_next(db)
    finally:
        db.close()


def _record_sync(job: Job, result: mailer.SendResult) -> None:
    db = SessionLocal()
    try:
        record_result(db, job, result)
    finally:
        db.close()


async def drain_once() -> float:
    """发一轮，返回距离下一轮的秒数。/ One pass; returns the delay before the next."""
    for _ in range(MAX_SENDS_PER_PASS):
        job = await run_in_threadpool(_claim_sync)
        if job == IDLE:
            return IDLE_SECONDS
        if job == CAP_REACHED:
            return CAP_RECHECK_SECONDS
        result = await run_in_threadpool(
            mailer.deliver, job.email, job.message.subject, job.message.html, job.message.text, job.message.headers
        )
        await run_in_threadpool(_record_sync, job, result)
        if not result.ok and (result.retryable or result.config_error or result.quota):
            return RETRY_BACKOFF_SECONDS
        await asyncio.sleep(max(0.0, settings.BROADCAST_EMAIL_INTERVAL_SECONDS))
    return 0.1


async def email_broadcast_loop() -> None:
    """后台发送循环（BackgroundLoops 里只有领导进程跑）。

    发信本身（httpx 同步请求）和查库都走线程池，每次只占一个线程零点几秒；
    两封之间的间隔在事件循环上 await，不占线程。
    Sends and DB work go through the thread pool one short call at a time; the
    gap between sends is awaited on the event loop.
    """
    await asyncio.sleep(STARTUP_DELAY_SECONDS)
    # 系统状态页的心跳：每轮开头记一次（内部限频）/ status-page heartbeat
    from app.services import loop_health

    while True:
        loop_health.beat("email_broadcast")
        try:
            delay = await drain_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("email_broadcast_loop error")
            delay = RETRY_BACKOFF_SECONDS
        await asyncio.sleep(delay)


def audience_from_json(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        v = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return v if isinstance(v, dict) else None
