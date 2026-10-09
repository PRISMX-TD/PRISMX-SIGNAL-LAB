"""游客预览接口（2026-10-09）：未登录可读，挂在 /api 下、不带任何用户依赖。

- GET  /public/preview           实时快照（3 秒共享缓存，活跃信号价位已抹除，见 services/guest_preview）
- GET  /public/preview/analysis  时段胜率卡要的策略分析（只含已公开策略），页面只取一次
- POST /public/preview/event     漏斗打点，永远 204

开关关着时两个 GET 一律 404：功能没开就不对外吐任何快照，免得被人拿去当免费行情源。
开关在缓存外判（设置本身有进程缓存），关开关立即生效。打点不看开关——开关关着时首页是
落地页，落地页的访问同样要计数，才有得比。

Guest-preview endpoints (2026-10-09), readable without login. With the switch off both
GETs are a 404, so the snapshot is never served while the feature is off; the switch is
checked outside the cache, so turning it off takes effect at once. The event endpoint
ignores the switch: with it off the home page is the landing page, whose views must be
counted too or there is nothing to compare against.
"""
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.rate_limit import limiter
from app.schemas import GuestPreviewEventIn
from app.services.deps import get_db
from app.services.guest_preview import build_analysis_payload, build_preview_payload, record_event
from app.services.settings_store import get_guest_preview_settings

router = APIRouter(prefix="/public/preview", tags=["public-preview"])


def _require_enabled(db: Session) -> None:
    if not get_guest_preview_settings(db)["enabled"]:
        raise HTTPException(404, "Not found")


@router.get("")
@limiter.shared_limit(settings.RATE_LIMIT_GUEST_PREVIEW, scope="guest-preview")
def get_preview(request: Request, db: Session = Depends(get_db)):
    _require_enabled(db)
    return build_preview_payload(db)


@router.get("/analysis")
@limiter.shared_limit(settings.RATE_LIMIT_GUEST_PREVIEW, scope="guest-preview")
def get_preview_analysis(request: Request, db: Session = Depends(get_db)):
    _require_enabled(db)
    return build_analysis_payload(db)


@router.post("/event", status_code=204)
@limiter.limit(settings.RATE_LIMIT_INVITE_CLICK)
def post_event(request: Request, body: GuestPreviewEventIn, db: Session = Depends(get_db)):
    record_event(db, body.mode, body.step)
    return Response(status_code=204)
