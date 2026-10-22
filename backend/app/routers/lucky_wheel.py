"""幸运轮盘接口（rev 45）。用户端 /lucky-wheel，管理端 /admin/lucky-wheel。
设计 docs/superpowers/specs/2026-10-22-lucky-wheel-design.md。

按仓库惯例：admin_router 自带 require_admin（main 里 include 时再挂一次）；业务都在
services/lucky/*，这里只做入参、事务边界和审计。

Lucky-wheel endpoints (rev 45). admin_router guards itself with require_admin (main adds it
again on include); logic lives in services/lucky/*, this file handles input, the transaction
boundary and the audit trail.
"""
import json
import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import User
from app.schemas import LuckyPrizeIn, LuckyRoundIn, LuckyRoundPatch, LuckyVisibleIn
from app.services.audit import log_change
from app.services.deps import get_current_user, require_admin
from app.services.lucky import common, prizes, rounds

logger = logging.getLogger("prismx.lucky")

router = APIRouter(prefix="/lucky-wheel", tags=["lucky"])
admin_router = APIRouter(prefix="/admin/lucky-wheel", tags=["admin"], dependencies=[Depends(require_admin)])


def _audit(db: Session, admin: User, action: str, payload: dict) -> None:
    """全部后台动作进操作日志，族 lucky（services/activity_feed）。目标恒为操作者本人：
    这是平台级动作，涉及的用户写在 payload 里。
    Every admin action goes to the activity log as family `lucky`; the target is the actor,
    affected users ride in the payload."""
    log_change(db, admin.id, admin.id, f"lucky:{action}", None,
               json.dumps(payload, ensure_ascii=False, default=str))


def _config_out(db: Session) -> dict:
    now = common.utcnow()
    return {
        "visible": common.is_visible(db),
        "round": rounds.round_out(rounds.current_round(db), now),
        "prizes": [prizes.admin_out(p) for p in prizes.active_prizes(db)],
    }


@admin_router.get("/config")
def admin_get_config(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    return _config_out(db)


@admin_router.put("/prizes")
def admin_save_prizes(body: list[LuckyPrizeIn], db: Session = Depends(get_db),
                      admin: User = Depends(require_admin)):
    kept = prizes.save_prizes(db, body)
    _audit(db, admin, "prizes", {"prizes": [{"name": p.name, "kind": p.kind, "probBp": p.prob_bp}
                                            for p in kept]})
    db.commit()
    return _config_out(db)


@admin_router.post("/rounds")
def admin_create_round(body: LuckyRoundIn, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    now = common.utcnow()
    r = rounds.create_round(db, admin, body.startsAt, body.endsAt, now)
    _audit(db, admin, "round_create", {"id": r.id, "startsAt": r.starts_at, "endsAt": r.ends_at})
    db.commit()
    return rounds.round_out(r, now)


@admin_router.patch("/rounds/current")
def admin_update_round(body: LuckyRoundPatch, db: Session = Depends(get_db),
                       admin: User = Depends(require_admin)):
    now = common.utcnow()
    r, voided = rounds.update_round(db, admin, body.startsAt, body.endsAt, now)
    _audit(db, admin, "round_update", {"id": r.id, "startsAt": r.starts_at, "endsAt": r.ends_at,
                                       "voided": voided})
    db.commit()
    return {**rounds.round_out(r, now), "voided": voided}


@admin_router.post("/rounds/current/end")
def admin_end_round(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    now = common.utcnow()
    r = rounds.current_round(db)
    if r is None:
        raise HTTPException(404, "没有进行中的一期 / No open round")
    voided = rounds.end_round(db, r, now, admin.id)
    _audit(db, admin, "round_end", {"id": r.id, "voided": voided})
    db.commit()
    return {**rounds.round_out(r, now), "voided": voided}


@admin_router.put("/visible")
def admin_set_visible(body: LuckyVisibleIn, db: Session = Depends(get_db),
                      admin: User = Depends(require_admin), background_tasks: BackgroundTasks = None):
    was = common.is_visible(db)
    common.set_visible(db, body.visible)
    _audit(db, admin, "visible", {"visible": body.visible})
    db.commit()
    # Task 5 在这里接「打开时补通知」/ Task 5 hooks deferred notifications in here
    return _config_out(db)
