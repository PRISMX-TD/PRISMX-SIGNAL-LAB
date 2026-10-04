"""注册邮箱验证：令牌、那封信，以及「验证通过」这件事本身。

软拦截：没验证的用户照样能登录、能看，只有绑定 MT5 与领 PRO 试用要求先验证
（守门在 services/deps.require_verified_email）。验证通过时顺手补发注册那一刻
扣下的邀请试用（routers/invite.grant_deferred_invite_trial）。

和找回密码共用的约定：库里只存令牌哈希；发信走 mailer，失败不抛；收件地址不进
日志。不同的是验证**幂等**——同一个链接点两次都算成功（见 EmailVerificationToken
的说明）。

Sign-up email verification: tokens, the email, and what "verified" triggers.
A soft gate — unverified users can sign in and browse; binding MT5 and claiming
a PRO trial require verification (guarded by services/deps.require_verified_email).
Verifying also grants the invite trial held back at sign-up. Shares the reset
flow's conventions (hash-only storage, mailer never raises, no addresses in
logs) but is idempotent: the same link clicked twice succeeds both times.
"""
import logging
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import EmailVerificationToken, User
from app.services.mailer import send_email
from app.services.password_reset import _aware, hash_token

logger = logging.getLogger("prismx.email_verification")

_TOKEN_BYTES = 32

# 同一个账号每小时最多发几封验证信（注册那封也算一封）。挡的是脚本对着「重新
# 发送」连打把 Resend 额度和发信域名信誉烧掉，真用户点两三次已经是上限。
# Verification mails one account can trigger per hour, the sign-up mail
# included. Stops a script on "resend" from burning quota and sender
# reputation; a real user tops out at two or three clicks.
VERIFY_MAX_PER_HOUR = 4
_VERIFY_COUNT_KEY = "emailverify:{user_id}"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def is_verified(user: User) -> bool:
    return user.email_verified_at is not None


def too_many_recent_sends(user_id: str) -> bool:
    """这个账号这一小时里是不是已经发满 VERIFY_MAX_PER_HOUR 封了。

    计数后端与找回密码同一套（shared_state，配了 Redis 即多 worker 共享）。判定
    失败一律放行：这是防滥用，不是鉴权，Redis 抖一下不该让真用户收不到信。
    Same counter backend as the reset flow; fails open, since this is abuse
    control, not authentication.
    """
    from app.services import shared_state

    try:
        n = shared_state.incr_with_ttl(_VERIFY_COUNT_KEY.format(user_id=user_id), 3600)
    except Exception:  # noqa: BLE001
        logger.warning("验证邮件频次计数失败，放行 / verify-mail counter failed, allowing", exc_info=True)
        return False
    return n > VERIFY_MAX_PER_HOUR


def issue_token(db: Session, user: User) -> str:
    """签发一个新令牌，返回**明文**（只在这一刻存在）。

    旧的未过期令牌**不作废**：用户点了「重新发送」之后，先到的那封旧信照样能
    用——国内邮箱经常是旧信、新信一起到，作废旧的只会让人点到一封「已失效」。
    顺手清掉这个人已过期或已用过的行，这张表没有别的清理时机。
    Older live tokens stay valid: after a resend, mail often arrives in a batch
    and the first one opened should work. Expired/used rows are pruned here,
    the table's only cleanup point.
    """
    now = _now()
    db.query(EmailVerificationToken).filter(
        EmailVerificationToken.user_id == user.id,
        or_(
            EmailVerificationToken.used_at.isnot(None),
            EmailVerificationToken.expires_at < now,
        ),
    ).delete(synchronize_session=False)

    raw = secrets.token_urlsafe(_TOKEN_BYTES)
    db.add(EmailVerificationToken(
        user_id=user.id,
        token_hash=hash_token(raw),
        expires_at=now + timedelta(hours=settings.EMAIL_VERIFY_TTL_HOURS),
    ))
    return raw


def mark_verified(db: Session, user: User) -> None:
    """把这个账号标成已验证，并补发注册时扣下的邀请试用。已验证则什么都不做。

    「证明了这个邮箱归他」的路径都该调这里，不只是点验证链接：用找回密码邮件
    改密码同样证明了邮箱所有权（见 auth.reset_password）。不 commit。
    Every path that proves mailbox ownership calls this, including a completed
    password reset. Does not commit.
    """
    if user.email_verified_at is not None:
        return
    # 延迟导入：routers.invite 在导入期会拉起 routers.admin 一整串，service 层
    # 在模块顶部导入路由会形成循环。
    # Deferred: importing routers.invite at module load pulls in routers.admin
    # and the service layer would import-cycle through it.
    from app.routers.invite import grant_deferred_invite_trial

    user.email_verified_at = _now()
    grant_deferred_invite_trial(db, user)


def consume_token(db: Session, raw: str) -> User | None:
    """校验令牌，有效则把对应账号标成已验证并返回该用户，否则返回 None。

    幂等：令牌已用过但账号确实已验证，照样返回用户（成功）。过期只在账号还没
    验证时才算失败——已经验证了的人点到一封过期旧信，告诉他「已失效」毫无意义。
    调用方负责 commit。
    Idempotent: a used token for a verified account still succeeds, and expiry
    only fails an account that is still unverified. Caller commits.
    """
    row = db.query(EmailVerificationToken).filter(
        EmailVerificationToken.token_hash == hash_token(raw or "")
    ).first()
    if row is None:
        return None
    user = db.query(User).filter(User.id == row.user_id).first()
    if user is None:
        return None
    if user.email_verified_at is not None:
        return user
    expires = _aware(row.expires_at)
    if expires is None or expires <= _now():
        return None
    row.used_at = _now()
    mark_verified(db, user)
    return user


def _verify_url(raw_token: str) -> str:
    base = (settings.PUBLIC_WEB_URL or "").rstrip("/")
    return f"{base}/verify-email?token={raw_token}"


def send_verification_email(to_email: str, raw_token: str) -> bool:
    """发那封信。中英双语同信，理由同找回密码那封（后端不知道用户语言）。"""
    url = _verify_url(raw_token)
    hours = settings.EMAIL_VERIFY_TTL_HOURS
    subject = "验证你的 PRISMX Signal Lab 邮箱 / Verify your PRISMX Signal Lab email"
    text = (
        "欢迎注册 PRISMX Signal Lab！\n"
        f"打开下面的链接验证邮箱（{hours} 小时内有效）：\n\n"
        f"{url}\n\n"
        "验证之后即可绑定 MT5 账号、领取 PRO 试用。\n"
        "如果你没有注册过 PRISMX Signal Lab，忽略这封邮件即可。\n\n"
        "---\n\n"
        "Welcome to PRISMX Signal Lab!\n"
        f"Open the link below to verify your email. It expires in {hours} hours:\n\n"
        f"{url}\n\n"
        "Once verified you can bind your MT5 account and claim your PRO trial.\n"
        "If you didn't sign up for PRISMX Signal Lab, just ignore this email.\n"
    )
    # 内联样式、不放图片，理由同找回密码那封（password_reset.send_reset_email）。
    html = f"""<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#18181b;line-height:1.6">
  <h2 style="margin:0 0 16px;font-size:18px;font-weight:600">验证邮箱 / Verify your email</h2>
  <p style="margin:0 0 8px">欢迎注册 PRISMX Signal Lab！点下面的按钮完成邮箱验证，之后即可绑定 MT5 账号、领取 PRO 试用。</p>
  <p style="margin:0 0 20px;color:#52525b;font-size:14px">Welcome to PRISMX Signal Lab! Use the button below to verify your email — then you can bind your MT5 account and claim your PRO trial.</p>
  <p style="margin:0 0 20px">
    <a href="{url}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">验证邮箱 / Verify email</a>
  </p>
  <p style="margin:0 0 20px;color:#52525b;font-size:13px">链接 {hours} 小时内有效。过期了登录后点「重新发送」即可。<br>This link expires in {hours} hours. If it does, sign in and tap "Resend".</p>
  <p style="margin:0 0 4px;color:#52525b;font-size:13px">按钮打不开就复制这个地址到浏览器 / If the button doesn't work, paste this into your browser:</p>
  <p style="margin:0 0 20px;word-break:break-all;font-size:12px;color:#71717a">{url}</p>
  <hr style="border:none;border-top:1px solid #e4e4e7;margin:20px 0">
  <p style="margin:0;color:#71717a;font-size:12px">如果你没有注册过 PRISMX Signal Lab，忽略这封邮件即可。<br>If you didn't sign up for PRISMX Signal Lab, just ignore this email.</p>
</div>"""

    ok = send_email(to_email, subject, html, text)
    if not ok and settings.MAIL_DEBUG_LOG_LINKS:
        # 只在 .env 里显式打开时才走这里，默认关闭。见 config.py 的说明。
        logger.warning("email verify link (MAIL_DEBUG_LOG_LINKS): %s", url)
    return ok
