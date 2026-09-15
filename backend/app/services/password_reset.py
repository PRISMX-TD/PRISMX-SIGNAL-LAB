"""找回密码：令牌的签发、校验与那封邮件。

放在 service 层而不是路由里，因为这套判据有几处一旦写错就会静默失效，值得单独
被测试直接驱动（见 tests/test_password_reset.py）。

三条不变量
----------
1. **库里只有哈希。** 明文令牌只在 `issue_token` 的返回值里存在一次，除了那封
   邮件之外不落任何地方（不进日志、不进响应体）。
2. **单次使用 + 过期。** 校验必须同时看 `used_at` 和 `expires_at`，少看一个就
   等于令牌永久有效。
3. **用掉一个就作废这个人的其余令牌。** 用户连点三次「忘记密码」会有三封信；
   用最新那封改完密码后，前两封必须立刻失效——否则一封躺在收件箱里的旧信还能
   再改一次密码，而用户以为这事已经结束了。

Token issuing/validation and the email itself. Kept in the service layer because
several of these checks fail silently when written wrong and deserve to be driven
directly by tests. Invariants: only hashes are stored; validation must check both
used_at and expires_at (skipping either makes tokens eternal); and consuming one
token invalidates that user's remaining ones, so an older mail sitting in the
inbox can't reset the password a second time.
"""
import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import PasswordResetToken, User
from app.services.mailer import send_email

logger = logging.getLogger("prismx.password_reset")

# 32 字节 urlsafe ≈ 43 个字符、256 位熵。暴力猜测在限流之外本身也不可行。
_TOKEN_BYTES = 32


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    """SQLite 取回的 DateTime 不带时区，Postgres 带。统一成 aware 再比较。

    不做这一步，本地用 SQLite 跑会在 `expires_at > now` 这句上抛
    "can't compare offset-naive and offset-aware datetimes"——而生产是 Postgres，
    这个错在本地必现、在生产看不见，属于最容易被漏掉的那类环境差异。
    """
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def issue_token(db: Session, user: User, requested_ip: str | None = None) -> str:
    """给这个用户签发一个新令牌，返回**明文**（只在这一刻存在）。

    顺手清掉这个人已经过期或用过的旧行：这张表只在申请时写入，没有别的清理时
    机，不清就会随时间无限长大。
    """
    db.query(PasswordResetToken).filter(
        PasswordResetToken.user_id == user.id,
        PasswordResetToken.used_at.isnot(None),
    ).delete(synchronize_session=False)

    raw = secrets.token_urlsafe(_TOKEN_BYTES)
    db.add(PasswordResetToken(
        user_id=user.id,
        token_hash=hash_token(raw),
        expires_at=_now() + timedelta(minutes=settings.PASSWORD_RESET_TTL_MINUTES),
        requested_ip=requested_ip,
    ))
    return raw


def consume_token(db: Session, raw: str) -> User | None:
    """校验并消费一个令牌。有效则返回对应用户，否则返回 None。

    调用方负责改密码与 commit——本函数只把「这个令牌现在有效」这件事判准，并把
    它连同这个人其余未用令牌一起作废。
    """
    row = db.query(PasswordResetToken).filter(
        PasswordResetToken.token_hash == hash_token(raw or "")
    ).first()
    if row is None:
        return None
    # 两个条件缺一不可：只看 used_at 则过期令牌永久有效，只看 expires_at 则
    # 同一个链接能用无数次。
    if row.used_at is not None:
        return None
    expires = _aware(row.expires_at)
    if expires is None or expires <= _now():
        return None

    user = db.query(User).filter(User.id == row.user_id).first()
    if user is None:
        # 账号在申请与点击之间被删了。令牌照样作废，不留一个指向空用户的活令牌。
        row.used_at = _now()
        return None

    now = _now()
    row.used_at = now
    # 这个人其余还没用的令牌一起作废——连点三次「忘记密码」会有三封信，用了最
    # 新那封之后，躺在收件箱里的另外两封不能还能再改一次密码。
    db.query(PasswordResetToken).filter(
        PasswordResetToken.user_id == user.id,
        PasswordResetToken.used_at.is_(None),
    ).update({"used_at": now}, synchronize_session=False)
    return user


def _reset_url(raw_token: str) -> str:
    base = (settings.PUBLIC_WEB_URL or "").rstrip("/")
    return f"{base}/reset-password?token={raw_token}"


def send_reset_email(to_email: str, raw_token: str) -> bool:
    """发那封信。中英双语同信——用户语言后端不知道，也不值得为此加一列。"""
    url = _reset_url(raw_token)
    ttl = settings.PASSWORD_RESET_TTL_MINUTES
    subject = "重置你的 PRISMX Signal Lab 密码 / Reset your PRISMX Signal Lab password"
    text = (
        "你申请了重置 PRISMX Signal Lab 的登录密码。\n"
        f"打开下面的链接设置新密码（{ttl} 分钟内有效，只能用一次）：\n\n"
        f"{url}\n\n"
        "如果这不是你本人操作，忽略这封邮件即可，你的密码不会有任何变化。\n\n"
        "---\n\n"
        "You asked to reset your PRISMX Signal Lab password.\n"
        f"Open the link below to set a new one. It expires in {ttl} minutes and works once:\n\n"
        f"{url}\n\n"
        "If this wasn't you, ignore this email — nothing about your account changes.\n"
    )
    # 邮件客户端对 CSS 的支持极不一致，所以全部用内联样式、不用外部样式表，
    # 也不放图片（图片默认被屏蔽，排版会当场垮掉）。
    html = f"""<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#18181b;line-height:1.6">
  <h2 style="margin:0 0 16px;font-size:18px;font-weight:600">重置密码 / Reset your password</h2>
  <p style="margin:0 0 8px">你申请了重置 PRISMX Signal Lab 的登录密码。点下面的按钮设置新密码。</p>
  <p style="margin:0 0 20px;color:#52525b;font-size:14px">You asked to reset your PRISMX Signal Lab password. Use the button below to set a new one.</p>
  <p style="margin:0 0 20px">
    <a href="{url}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">设置新密码 / Set a new password</a>
  </p>
  <p style="margin:0 0 20px;color:#52525b;font-size:13px">链接 {ttl} 分钟内有效，只能使用一次。<br>This link expires in {ttl} minutes and can only be used once.</p>
  <p style="margin:0 0 4px;color:#52525b;font-size:13px">按钮打不开就复制这个地址到浏览器 / If the button doesn't work, paste this into your browser:</p>
  <p style="margin:0 0 20px;word-break:break-all;font-size:12px;color:#71717a">{url}</p>
  <hr style="border:none;border-top:1px solid #e4e4e7;margin:20px 0">
  <p style="margin:0;color:#71717a;font-size:12px">如果这不是你本人操作，忽略这封邮件即可，你的密码不会有任何变化。<br>If this wasn't you, ignore this email — nothing about your account changes.</p>
</div>"""

    ok = send_email(to_email, subject, html, text)
    if not ok and settings.MAIL_DEBUG_LOG_LINKS:
        # 只在 .env 里显式打开时才走这里，默认关闭。见 config.py 的说明。
        logger.warning("password reset link (MAIL_DEBUG_LOG_LINKS): %s", url)
    return ok
