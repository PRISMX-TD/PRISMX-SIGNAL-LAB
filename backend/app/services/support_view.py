"""客服台的客户卡片序列化：**唯一出口**（设计 2026-10-17 §2.3）。

客服接口一律经 serialize_customer(user, ctx) 返回用户信息，禁止直接把 ORM 字段塞进响应。
权限表在这里执行，前端只负责显示：

  字段                               admin   内部          外包
  昵称/注册时间/地区/来源链接          ✓       ✓            ✓
  套餐/到期/试用/邮箱验证/比赛报名      ✓       ✓            ✓
  最后活跃/桥接网关在线                ✓       ✓            ✓
  邮箱                               完整     完整          脱敏 re***@gmail.com
  电话                               完整     完整          脱敏 +86 138****5678（查看走 reveal 接口）
  MT5 账号                           完整     后 4 位       只给「已绑定 · 真实/模拟 · 券商」
  余额/净值                          ✓       区间          ✗
  付费金额                           ✓       ✗            ✗
  密钥/令牌/密码                      ✗       ✗            ✗

Customer-card serialization for the support desk — the single exit point. Every
support endpoint returns user data through serialize_customer(user, ctx); the
permission table above is enforced here and only here.
"""
from __future__ import annotations

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import Competition, CompetitionParticipant, InviteLink, MT5Account, Payment, User
from app.services.deps import StaffCtx

# 常见国家 / 地区区号（最长匹配），只用于把 E.164 拆成「区号 + 号码」好脱敏、好显示地区。
# 不在表里的按 2 位兜底——拆错只影响显示，不影响存储。
# Common dial codes (longest match), only used to split E.164 for masking and the
# region label. Unknown ones fall back to 2 digits; a wrong split only affects display.
_DIAL_CODES = {
    "1", "7", "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45",
    "46", "47", "48", "49", "51", "52", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64",
    "65", "66", "81", "82", "84", "86", "90", "91", "92", "93", "94", "95", "98", "212", "234",
    "254", "351", "353", "358", "380", "852", "853", "855", "856", "880", "886", "960", "961",
    "962", "963", "964", "965", "966", "967", "968", "971", "972", "973", "974", "975", "976", "977",
}

# 余额区间（内部客服看区间，不看具体数）/ balance buckets shown to internal staff
_BALANCE_BUCKETS = (
    (1_000, "<1k"),
    (5_000, "1k-5k"),
    (20_000, "5k-20k"),
    (100_000, "20k-100k"),
)


def split_phone(phone: str | None) -> tuple[str, str] | None:
    """'+8613812345678' → ('+86', '13812345678')；不是 E.164 返回 None。
    Split an E.164 number into (dial code, national number)."""
    if not phone or not phone.startswith("+") or not phone[1:].isdigit():
        return None
    digits = phone[1:]
    for n in (3, 2, 1):
        if digits[:n] in _DIAL_CODES:
            return "+" + digits[:n], digits[n:]
    return "+" + digits[:2], digits[2:]


def mask_phone(phone: str | None) -> str | None:
    """'+8613812345678' → '+86 138****5678'。号码太短时只留后 2 位。
    Mask a phone number, keeping the dial code, first 3 and last 4 digits."""
    if not phone:
        return None
    parts = split_phone(phone)
    if parts is None:
        return "****"
    dial, num = parts
    if len(num) >= 8:
        return f"{dial} {num[:3]}****{num[-4:]}"
    return f"{dial} ****{num[-2:]}"


def format_phone(phone: str | None) -> str | None:
    """完整号码按「区号 空格 号码」显示 / the full number as 'dial national'."""
    parts = split_phone(phone)
    return f"{parts[0]} {parts[1]}" if parts else phone


def mask_email(email: str | None) -> str | None:
    """'rexlee@gmail.com' → 're***@gmail.com'。/ Mask the local part of an email."""
    if not email or "@" not in email:
        return email and "***"
    local, _, domain = email.partition("@")
    return f"{local[:2]}***@{domain}"


def balance_range(value: float | None) -> str | None:
    if value is None:
        return None
    for limit, label in _BALANCE_BUCKETS:
        if value < limit:
            return label
    return ">100k"


def _is_real(acc: MT5Account) -> bool | None:
    if acc.trade_mode is None:
        return None
    try:
        tm = int(acc.trade_mode)
    except (TypeError, ValueError):
        return None
    if tm < 0:
        return None
    return tm == 2


def _broker(acc: MT5Account) -> str | None:
    """券商名：账号上报的 company，其次服务器名（直连行服务器为空，回落合作券商显示名）。
    Broker label: the reported company, else the server name."""
    return acc.company or acc.server or None


def _account_view(acc: MT5Account, ctx: StaffCtx, gateway_broker: str | None) -> dict:
    broker = _broker(acc) or (gateway_broker if acc.source == "gateway" else None)
    base = {
        "id": acc.id,
        "bound": True,
        "real": _is_real(acc),
        "broker": broker,
        "channel": acc.source if acc.source in ("gateway", "bridge") else None,
        "online": bool(acc.online),
    }
    if ctx.is_outsourced:
        # 外包：只给「已绑定 · 真实/模拟 · 券商名」/ outsourced: bound + real/demo + broker only
        return base
    if ctx.is_admin:
        base.update({
            "login": str(acc.login),
            "server": acc.server or None,
            "balance": acc.balance,
            "equity": acc.equity,
            "currency": acc.account_currency,
        })
    else:
        login = str(acc.login or "")
        base.update({
            "login": "****" + login[-4:] if login else None,
            "balanceRange": balance_range(acc.balance),
            "equityRange": balance_range(acc.equity),
        })
    return base


def open_account_url(db: Session, user: User) -> str | None:
    """「复制开户链接」：用户来源推广链接的 open_account_url，否则后台配置的 broker_referral_url。
    The open-account link: the user's invite link's own URL, else the broker referral URL."""
    from app.services.settings_store import get_broker_settings

    if user.invite_code:
        url = (
            db.query(InviteLink.open_account_url)
            .filter(InviteLink.code == user.invite_code)
            .scalar()
        )
        if url:
            return url
    return get_broker_settings(db).get("broker_referral_url") or None


def serialize_customer(db: Session, user: User, ctx: StaffCtx) -> dict:
    """按调用者权限序列化一个用户（见模块说明的权限表）。电话对外包恒为脱敏值；完整号码只有
    reveal 接口给。
    Serialize one user for the caller per the permission table. Outsourced staff
    always get the masked phone; the full number only comes from the reveal endpoint."""
    from app.services.settings_store import get_broker_settings

    accounts = (
        db.query(MT5Account)
        .filter(MT5Account.user_id == user.id)
        .order_by(MT5Account.login)
        .all()
    )
    from app.services.gateway_binding import is_removed

    accounts = [a for a in accounts if not is_removed(a)]
    gateway_broker = get_broker_settings(db).get("broker_display_name") or None
    invite_label = None
    if user.invite_code:
        invite_label = db.query(InviteLink.label).filter(InviteLink.code == user.invite_code).scalar()
    comps = (
        db.query(Competition.id, Competition.name, Competition.status)
        .join(CompetitionParticipant, CompetitionParticipant.competition_id == Competition.id)
        .filter(CompetitionParticipant.user_id == user.id)
        .all()
    )
    phone_parts = split_phone(user.phone)
    full = not ctx.is_outsourced
    out = {
        "id": user.id,
        "nickname": user.nickname,
        "createdAt": user.created_at,
        # 后端没有存用户语言；地区按手机号区号给 / no stored language; region from the dial code
        "lang": None,
        "region": phone_parts[0] if phone_parts else None,
        "inviteCode": user.invite_code,
        "inviteLabel": invite_label,
        "plan": user.plan,
        "planExpiresAt": user.plan_expires_at,
        "planIsTrial": bool(user.plan_is_trial),
        "trialUsed": user.trial_used_at is not None,
        "emailVerified": user.email_verified_at is not None,
        "competitions": [{"id": c.id, "name": c.name, "status": c.status} for c in comps],
        "lastActiveAt": user.last_active_at,
        "bridgeOnline": any(a.online and a.source != "gateway" for a in accounts),
        "gatewayOnline": any(a.online and a.source == "gateway" for a in accounts),
        "disabled": user.disabled_at is not None,
        "doNotContact": user.do_not_contact_at is not None,
        "email": user.email if full else mask_email(user.email),
        "emailMasked": not full,
        "phone": format_phone(user.phone) if full else mask_phone(user.phone),
        "phoneMasked": bool(user.phone) and not full,
        "hasPhone": bool(user.phone),
        "mt5Accounts": [_account_view(a, ctx, gateway_broker) for a in accounts],
        "openAccountUrl": open_account_url(db, user),
    }
    if ctx.is_admin:
        paid = (
            db.query(func.coalesce(func.sum(Payment.amount_usd), 0.0))
            .filter(Payment.user_id == user.id, Payment.status == "FINISHED")
            .scalar()
        )
        out["paidTotalUsd"] = float(paid or 0.0)
    return out
