"""代理专属开户链接：校验与解析。

比赛有自己的开户链接（competitions.open_account_url，公司的 Make Capital IB 链接）。
代理靠邀请码（?ref=）带人进来，但「开户」按钮以前一律跳公司链接，代理拿不到经纪商返佣。
现在非比赛邀请链接可以带一个自己的开户链接（invite_links.open_account_url），归因到这
条代理链接的访客点「开户」时跳那里。

- normalize_agent_open_url：管理端与代理自助共用的唯一校验口。只收 Make Capital 的 https
  地址——这是一个会被公开页 302 出去的地址，放开任意域名等于给代理一个开放跳转。
- resolve_open_account_url：选码复用注册归因同一个 pick_ref（30 天内代理优先），选中的
  链接仍活跃、有代理、填了开户链接才用它，否则回落到比赛的。

Agent-specific open-account links: the single validation gate (https Make Capital
hosts only — the public page 302s to this, so any other host would be an open
redirect) and the resolution, which reuses signup attribution's pick_ref.
"""
from urllib.parse import urlsplit

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import Competition, InviteLink, InviteLinkAgent

ALLOWED_OPEN_ACCOUNT_HOSTS = ("makecapital.com",)
OPEN_ACCOUNT_URL_MAX = 500
MSG_BAD_AGENT_OPEN_URL = (
    "开户链接需为 Make Capital 的 https 地址 / Open-account URL must be an https Make Capital link"
)
MSG_COMP_LINK_OPEN_URL = (
    "比赛推广链接使用比赛自己的开户链接 / Competition promo links use the competition's open-account URL"
)


def _host_allowed(host: str) -> bool:
    return any(host == h or host.endswith("." + h) for h in ALLOWED_OPEN_ACCOUNT_HOSTS)


def normalize_agent_open_url(raw: str | None) -> str | None:
    """去首尾空白；空 → None；否则必须是 Make Capital 的 https 地址且 ≤500 字符，不合格 400。
    带 userinfo（user@host）的一律不收——那是把真实主机藏起来的老把戏。
    Trimmed; blank → None; otherwise an https Make Capital URL of ≤500 chars, else 400.
    Any userinfo is rejected outright (the classic way to disguise the real host)."""
    url = (raw or "").strip()
    if not url:
        return None
    bad = HTTPException(status_code=400, detail=MSG_BAD_AGENT_OPEN_URL)
    if len(url) > OPEN_ACCOUNT_URL_MAX or any(ch.isspace() for ch in url):
        raise bad
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
    except ValueError:
        raise bad
    if parts.scheme.lower() != "https" or "@" in parts.netloc or not _host_allowed(host):
        raise bad
    return url


def resolve_open_account(db: Session, comp: Competition, codes: list[str]) -> tuple[str | None, str | None]:
    """(选中的邀请码, 开户链接)。公开跳转要拿选中的码去记漏斗，所以一次算出两样。
    (chosen invite code, open-account URL); the public redirect needs the code for
    its funnel row, so both come out of one pass."""
    # pick_ref 住在 routers/invite.py（注册归因的唯一口径）；延迟导入，免得 services 在
    # 模块加载时就反向依赖 router（同 email_verification 的做法）。
    # pick_ref lives in routers/invite.py; imported lazily so this service doesn't
    # depend on a router at import time (same as email_verification).
    from app.routers.invite import pick_ref

    chosen = pick_ref(db, codes)
    if chosen:
        link = (
            db.query(InviteLink)
            .filter(InviteLink.code == chosen, InviteLink.is_active.is_(True))
            .first()
        )
        if (
            link is not None
            and link.open_account_url
            and db.query(InviteLinkAgent.id).filter(InviteLinkAgent.link_id == link.id).first()
        ):
            return chosen, link.open_account_url
    return chosen, comp.open_account_url


def resolve_open_account_url(db: Session, comp: Competition, codes: list[str]) -> str | None:
    """这位访客 / 用户在这场比赛点「开户」该去哪：选中的链接活跃、有代理、填了开户链接就用
    它，否则比赛的。
    Where this visitor's open-account click goes: the chosen link's URL when it is
    active, has an agent and carries one; otherwise the competition's."""
    return resolve_open_account(db, comp, codes)[1]
