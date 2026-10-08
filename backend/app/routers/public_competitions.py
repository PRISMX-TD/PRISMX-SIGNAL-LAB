"""公开比赛页接口（设计 §3.1）：未登录访客可读，挂在 /api 下、不带任何用户依赖。

三条规矩：
1. **一个 404 打天下**：不存在 / 草稿 / 未公开 / 总开关关 / 站内比赛开关关，全部返回同一个
   404，一字不差——不能让人从响应差异里探出「有一场比赛正在筹备」。comp_id 不像 UUID
   直接 404，不碰库。
2. **共享缓存 20 秒**（shared_cache，`comp-public:<id>`）：广告落地的流量全员同值；
   不存在也缓存成 {"nf": 1}，免得乱填的 id 每次都打穿到库。全局开关在缓存外判
   （设置本身有进程缓存），关开关立即生效。公开 GET 不调 refresh_comp_board。
3. **打点永远 204**：不区分比赛存不存在、码对不对。

Public competition endpoints (design §3.1): readable without login, mounted
under /api with no user dependency. One identical 404 for every hidden case
(non-UUID ids never reach the DB); a 20s shared cache with a {"nf": 1}
sentinel for misses, global switches checked outside it; the event endpoint
is always 204.
"""
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.rate_limit import limiter
from app.models import Competition
from app.schemas import PublicCompEventIn
from app.services import shared_cache
from app.services.deps import get_db
from app.services.gamification.public_board import (
    UUID_RE, build_public_payload, comp_public_eligible, featured_competition_id,
    normalize_comp_id, public_cache_key, public_switches_on, record_funnel_event)
from app.services.open_account import resolve_open_account
from app.services.settings_store import get_gamification_settings

router = APIRouter(prefix="/public/competitions", tags=["public-competitions"])

MSG_PUBLIC_NOT_FOUND = "比赛不存在或未公开 / Competition not found"
CACHE_TTL_SECONDS = 20
_NOT_FOUND = {"nf": 1}


def _not_found() -> HTTPException:
    return HTTPException(404, MSG_PUBLIC_NOT_FOUND)


@router.get("/featured")
@limiter.shared_limit(settings.RATE_LIMIT_COMPETITION_PUBLIC, scope="comp-public")
def get_featured(request: Request, db: Session = Depends(get_db)):
    """`/c` 无 id 时落到哪一场；没有可公开的比赛 → id 为 null。"""
    return {"id": featured_competition_id(db)}


@router.get("/{comp_id}")
@limiter.shared_limit(settings.RATE_LIMIT_COMPETITION_PUBLIC, scope="comp-public")
def get_public_competition(request: Request, comp_id: str, db: Session = Depends(get_db)):
    comp_id = normalize_comp_id(comp_id)
    if not UUID_RE.match(comp_id):
        raise _not_found()
    if not public_switches_on(get_gamification_settings(db)):
        raise _not_found()

    def compute() -> dict:
        comp = db.get(Competition, comp_id)
        if comp is None or not comp_public_eligible(comp):
            return dict(_NOT_FOUND)
        return build_public_payload(db, comp)

    out = shared_cache.cached_json(public_cache_key(comp_id), CACHE_TTL_SECONDS, compute)
    if out.get("nf"):
        raise _not_found()
    return out


_MAX_REFS = 5
_MAX_REF_LEN = 32


def _parse_refs(raw: str | None) -> list[str]:
    """逗号分隔的最近几个 ref（最新在前）：去空白、丢空项与超长项，最多取 5 个。宽松
    处理而不是 422——这是访客点按钮后的跳转，坏一个码不该让人开不了户。
    Comma-separated recent refs, newest first: trimmed, blanks and over-long items
    dropped, at most five. Lenient rather than 422: a bad code must not stop a
    visitor from reaching the open-account page."""
    out: list[str] = []
    for item in (raw or "").split(","):
        item = item.strip()
        if item and len(item) <= _MAX_REF_LEN:
            out.append(item)
    return out[:_MAX_REFS]


def _is_http_url(url: str | None) -> bool:
    try:
        parts = urlsplit(url or "")
    except ValueError:
        return False
    return parts.scheme in ("http", "https") and bool(parts.netloc)


@router.get("/{comp_id}/open-account")
@limiter.shared_limit(settings.RATE_LIMIT_COMPETITION_PUBLIC, scope="comp-public")
def open_account_redirect(
    request: Request,
    comp_id: str,
    refs: str | None = Query(default=None, max_length=(_MAX_REF_LEN + 1) * _MAX_REFS),
    db: Session = Depends(get_db),
):
    """公开页「开模拟账户」：按访客最近的 ref 选开户链接（代理优先，见
    services/open_account.resolve_open_account），302 过去，并在服务端记漏斗 open_account。
    可见性与公开详情同一个 404；选中哪个码只会体现在 Location 本身，不另外回显。不走
    共享缓存：每个访客的 refs 不同，按主键读一行比赛很便宜。

    Public "open demo account": picks the URL from the visitor's recent refs (agent
    first), 302s there and records the open_account funnel step server-side. Same
    404 as the public detail; the chosen code is never echoed except via Location.
    Uncached: refs differ per visitor and one primary-key read is cheap."""
    comp_id = normalize_comp_id(comp_id)
    if not UUID_RE.match(comp_id):
        raise _not_found()
    if not public_switches_on(get_gamification_settings(db)):
        raise _not_found()
    comp = db.get(Competition, comp_id)
    if comp is None or not comp_public_eligible(comp):
        raise _not_found()
    chosen, url = resolve_open_account(db, comp, _parse_refs(refs))
    # 存进库之前已校验过，这里出网前再兜一次：只往 http(s) 跳。
    # Validated on write already; checked again on the way out — http(s) only.
    if not _is_http_url(url):
        raise _not_found()
    record_funnel_event(db, comp.id, "open_account", chosen or "")
    return RedirectResponse(url, status_code=302)


@router.post("/event", status_code=204)
@limiter.limit(settings.RATE_LIMIT_INVITE_CLICK)
def post_event(request: Request, body: PublicCompEventIn, db: Session = Depends(get_db)):
    record_funnel_event(db, body.compId, body.step, body.ref)
    return Response(status_code=204)
