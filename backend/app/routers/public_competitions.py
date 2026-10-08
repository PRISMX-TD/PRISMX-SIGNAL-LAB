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
from fastapi import APIRouter, Depends, HTTPException, Request, Response
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


@router.post("/event", status_code=204)
@limiter.limit(settings.RATE_LIMIT_INVITE_CLICK)
def post_event(request: Request, body: PublicCompEventIn, db: Session = Depends(get_db)):
    record_funnel_event(db, body.compId, body.step, body.ref)
    return Response(status_code=204)
