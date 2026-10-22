"""幸运轮盘接口（rev 45）。用户端 /lucky-wheel，管理端 /admin/lucky-wheel。
设计 docs/superpowers/specs/2026-10-22-lucky-wheel-design.md。

按仓库惯例：admin_router 自带 require_admin（main 里 include 时再挂一次）；业务都在
services/lucky/*，这里只做入参、事务边界和审计。

Lucky-wheel endpoints (rev 45). admin_router guards itself with require_admin (main adds it
again on include); logic lives in services/lucky/*, this file handles input, the transaction
boundary and the audit trail.
"""
import csv
import io
import json
import logging

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.strategy_limits import user_limiter
from app.models import LuckyDraw, LuckyTicket, LuckyTicketBatch, User
from app.schemas import (
    LuckyClaimInfoIn, LuckyHandleIn, LuckyIssueIn, LuckyPrizeIn, LuckyRankSourceIn, LuckyRevokeIn, LuckyRoundIn,
    LuckyRoundPatch, LuckySpinIn, LuckyVisibleIn,
)
from app.services.audit import log_change
from app.services.deps import get_current_user, require_admin
from app.services.lucky import claims, common, prizes, rounds
from app.services.lucky import issue as issue_svc
from app.services.lucky import spin as spin_svc
from app.services.notification_feed import notify_ws, notify_ws_many

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


def _opens_at(db: Session, now):
    """当前期还没开始就返回开始时间（通知 / 推送文案要写「X月X日 开启」），否则 None。
    The current round's start while it is still upcoming (the copy then names the opening time), else None."""
    r = rounds.current_round(db)
    return r.starts_at if r is not None and rounds.phase(r, now) == "upcoming" else None


def _after_notify(background_tasks: BackgroundTasks | None, groups: dict[str, list[str]], opens_at=None) -> None:
    """提交之后：WS 提醒在线用户刷新通知，推送放后台任务（阻塞网络 IO）。WS 整批只提交一次主循环
    （最多 2000 人逐个等 2 秒会把请求卡住）。
    After commit: nudge online users over WS — one main-loop submission for the whole batch, since
    up to 2000 users at 2s each would stall the request — and queue the push (blocking network IO)
    as a background task."""
    notify_ws_many([uid for uids in groups.values() for uid in uids])
    if background_tasks is not None:
        for reason, uids in groups.items():
            if uids:
                background_tasks.add_task(issue_svc.push_tickets, uids, reason, opens_at)


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
    # 设计 §3.3：保存要逐项留痕。先取保存前上架的每一格，保存后对比：记整套新配置、每个改动格的
    # 前 / 后、被下架的格；没动的格不进 changes，日志才看得出这次到底改了什么（天数 / 库存 / 上限都是
    # 会送出真东西的字段）。
    # Spec 3.3: a save is logged field by field. Snapshot the live slots first, then diff: the full new
    # set, before / after of each changed slot, and the archived ones. Untouched slots stay out of
    # `changes` so the log shows what actually moved (days / stock / limits give real things away).
    before = {p.id: prizes.audit_view(p) for p in prizes.active_prizes(db)}
    kept = prizes.save_prizes(db, body)
    after = [prizes.audit_view(p) for p in kept]
    kept_ids = {a["id"] for a in after}
    _audit(db, admin, "prizes", {
        "prizes": after,
        "changes": [{"id": a["id"], "name": a["name"], "before": before.get(a["id"]), "after": a}
                    for a in after if before.get(a["id"]) != a],
        "archived": [{"id": i, "name": v["name"]} for i, v in before.items() if i not in kept_ids],
    })
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
    # 关→开时给「关着时发的券」补通知；站内通知与开关、审计同一次提交，开关反复拨不会重复通知
    # （notified_at 已置）。推送在提交之后。
    # Off→on: notify batches issued while hidden. The feed rows commit with the flag and the
    # audit row; notified_at makes repeated flips a no-op. Push goes out after the commit.
    now = common.utcnow()
    groups = issue_svc.notify_pending(db, now) if body.visible and not was else {}
    db.commit()
    _after_notify(background_tasks, groups, _opens_at(db, now) if groups else None)
    return _config_out(db)


@admin_router.post("/issue/preview")
def admin_issue_preview(body: LuckyRankSourceIn, db: Session = Depends(get_db),
                        admin: User = Depends(require_admin)):
    return {"rows": issue_svc.resolve_ranks(db, body)}


@admin_router.post("/issue")
def admin_issue(body: LuckyIssueIn, db: Session = Depends(get_db), admin: User = Depends(require_admin),
                background_tasks: BackgroundTasks = None):
    now = common.utcnow()
    batch, notified = issue_svc.issue(db, admin, body, now)
    fresh = batch.created_at == now
    if fresh:
        _audit(db, admin, "issue", {"id": batch.id, "reason": batch.reason, "users": batch.user_count,
                                    "tickets": batch.ticket_count, "notified": notified})
    db.commit()
    if fresh and notified:
        uids = [i.userId for i in body.items]
        _after_notify(background_tasks, {batch.reason: uids}, _opens_at(db, now))
    return {"id": batch.id, "userCount": batch.user_count, "ticketCount": batch.ticket_count,
            "notified": notified}


@admin_router.post("/revoke")
def admin_revoke(body: LuckyRevokeIn, db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    n = issue_svc.revoke(db, body.batchId, body.userId)
    _audit(db, admin, "revoke", {"batchId": body.batchId, "userId": body.userId, "revoked": n})
    db.commit()
    return {"revoked": n}


@admin_router.get("/batches")
def admin_batches(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    r = rounds.current_round(db)
    if r is None:
        return {"batches": []}
    rows = (db.query(LuckyTicketBatch).filter(LuckyTicketBatch.round_id == r.id)
            .order_by(LuckyTicketBatch.created_at.desc()).limit(200).all())
    used = dict(db.query(LuckyTicket.batch_id, func.count(LuckyTicket.id))
                .filter(LuckyTicket.round_id == r.id, LuckyTicket.status == "used")
                .group_by(LuckyTicket.batch_id).all())
    return {"batches": [{"id": b.id, "reason": b.reason, "createdAt": b.created_at, "userCount": b.user_count,
                         "ticketCount": b.ticket_count, "used": used.get(b.id, 0),
                         "notified": b.notified_at is not None} for b in rows]}


def _csv_cell(v) -> str:
    """导出给 Excel 打开：以 = + - @ 开头的文本会被当公式，前面补一个单引号（用户填的地址 / 邮箱不可信）。
    Opened in Excel: text starting with = + - @ runs as a formula, so prefix a quote (user-typed fields are untrusted)."""
    t = "" if v is None else str(v)
    return "'" + t if t[:1] in ("=", "+", "-", "@", "\t", "\r") else t


# 注意：/draws.csv 必须声明在任何 /draws/{draw_id} 路由之前，否则会被当成 id。
# /draws.csv must stay declared before any /draws/{draw_id} route or it is read as an id.
@admin_router.get("/draws")
def admin_draws(status: str | None = Query(default=None, max_length=16),
                roundId: str | None = None, userId: str | None = None, prizeId: str | None = None,
                limit: int = Query(default=50, ge=1, le=200), offset: int = Query(default=0, ge=0),
                db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    q = claims.admin_query(db, status=status, round_id=roundId, user_id=userId, prize_id=prizeId)
    total = q.count()
    return {"total": total, "draws": [claims.admin_row(d, u) for d, u in q.offset(offset).limit(limit)]}


@admin_router.get("/draws.csv")
def admin_draws_csv(status: str | None = Query(default=None, max_length=16), roundId: str | None = None,
                    db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["时间(UTC)", "邮箱", "昵称", "奖品", "类型", "状态", "领奖信息", "工单", "备注"])
    for d, u in claims.admin_query(db, status=status, round_id=roundId).limit(20000):
        r = claims.admin_row(d, u)
        w.writerow([f"{d.created_at:%Y-%m-%d %H:%M}", _csv_cell(u.email), _csv_cell(u.nickname),
                    _csv_cell(r["prize"]["name"]), r["prize"]["kind"], d.fulfillment_status,
                    _csv_cell(d.claim_info), d.support_ticket_id or "", _csv_cell(d.admin_note)])
    return Response(content=("\ufeff" + buf.getvalue()).encode("utf-8"), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="lucky-draws.csv"'})


@admin_router.post("/draws/{draw_id}/deliver")
def admin_deliver(draw_id: str, body: LuckyHandleIn, db: Session = Depends(get_db),
                  admin: User = Depends(require_admin), background_tasks: BackgroundTasks = None):
    d = claims.deliver(db, admin, draw_id, body.note)
    _audit(db, admin, "deliver", {"drawId": d.id, "userId": d.user_id, "note": d.admin_note})
    uid, name = d.user_id, claims.prize_name(d)
    db.commit()
    notify_ws(uid)
    if background_tasks is not None:
        background_tasks.add_task(claims.push_handled, uid, True, name, None)
    return {"ok": True}


@admin_router.post("/draws/{draw_id}/cancel")
def admin_cancel(draw_id: str, body: LuckyHandleIn, db: Session = Depends(get_db),
                 admin: User = Depends(require_admin), background_tasks: BackgroundTasks = None):
    d = claims.cancel(db, admin, draw_id, body.note)
    _audit(db, admin, "cancel", {"drawId": d.id, "userId": d.user_id, "note": d.admin_note})
    uid, name, reason = d.user_id, claims.prize_name(d), d.admin_note
    db.commit()
    notify_ws(uid)
    if background_tasks is not None:
        background_tasks.add_task(claims.push_handled, uid, False, name, reason)
    return {"ok": True}


# ---- 用户端 / user side ----


@router.get("")
def user_state(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    """轮盘页一次拿齐：能不能玩、本期时间、奖品（不含概率）、本期我的券。
    Everything the page needs: playable, the window, prizes (no odds), my tickets this round."""
    now = common.utcnow()
    if not spin_svc.can_play(db, user):
        return {"visible": False, "round": None, "prizes": [], "tickets": {"unused": 0, "batches": []}}
    r = rounds.current_round(db)
    batches = []
    unused = 0
    if r is not None:
        unused = spin_svc.unused_count(db, user.id, r.id)
        rows = (db.query(LuckyTicketBatch.reason, LuckyTicketBatch.created_at, func.count(LuckyTicket.id))
                .join(LuckyTicket, LuckyTicket.batch_id == LuckyTicketBatch.id)
                .filter(LuckyTicket.user_id == user.id, LuckyTicket.round_id == r.id)
                .group_by(LuckyTicketBatch.id, LuckyTicketBatch.reason, LuckyTicketBatch.created_at)
                .order_by(LuckyTicketBatch.created_at.desc()).all())
        batches = [{"reason": reason, "issuedAt": at, "count": n} for reason, at, n in rows]
        # 没有批次的券（「再来一次」补发）单独补一行，否则各批数量加起来会小于 unused
        # Tickets with no batch (retry refunds) get their own row, else the counts sum below `unused`
        extra_n, extra_at = (db.query(func.count(LuckyTicket.id), func.max(LuckyTicket.issued_at))
                             .filter(LuckyTicket.user_id == user.id, LuckyTicket.round_id == r.id,
                                     LuckyTicket.batch_id.is_(None)).one())
        if extra_n:
            batches.append({"reason": None, "issuedAt": extra_at, "count": extra_n})
    return {
        "visible": True,
        "round": rounds.round_out(r, now),
        "prizes": [prizes.public_out(p) for p in prizes.active_prizes(db)],
        "tickets": {"unused": unused, "batches": batches},
    }


@router.post("/spin")
@user_limiter.limit(settings.RATE_LIMIT_LUCKY_SPIN)
def user_spin(request: Request, body: LuckySpinIn, db: Session = Depends(get_db),
              user: User = Depends(get_current_user)):
    """开一次奖。结果由服务端决定，同一个 requestId 重试返回同一条记录。
    One spin. The server decides; retrying the same requestId returns the same draw."""
    try:
        d = spin_svc.spin(db, user, body.requestId)
        db.commit()
    except spin_svc.SpinError as e:
        db.rollback()
        raise HTTPException(e.status, e.detail) from None
    r = rounds.current_round(db)
    left = spin_svc.unused_count(db, user.id, d.round_id)
    return {**spin_svc.draw_out(d, spin_svc.slot_index(db, d.prize_id)), "ticketsLeft": left,
            "round": rounds.round_out(r, common.utcnow())}


@router.get("/draws")
def user_draws(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    # 待领取（pending / submitted）的一条不能因为抽得多而掉出列表：先全取，再补最近 100 条其余的。
    # An open claim must never fall off the list behind a heavy user's history: take every open one,
    # then fill with the latest 100 of the rest.
    base = db.query(LuckyDraw).filter(LuckyDraw.user_id == user.id)
    open_rows = base.filter(LuckyDraw.fulfillment_status.in_(common.F_OPEN)).all()
    rest = (base.filter(LuckyDraw.fulfillment_status.notin_(common.F_OPEN))
            .order_by(LuckyDraw.created_at.desc(), LuckyDraw.id.desc()).limit(100).all())
    rows = sorted(open_rows + rest, key=lambda d: (d.created_at, d.id), reverse=True)
    return {"draws": [spin_svc.draw_out(d, None) for d in rows]}


@router.post("/draws/{draw_id}/claim-info")
def user_claim_info(draw_id: str, body: LuckyClaimInfoIn, db: Session = Depends(get_db),
                    user: User = Depends(get_current_user)):
    d = claims.submit_info(db, user, draw_id, body.text)
    db.commit()
    return spin_svc.draw_out(d, None)


@router.post("/draws/{draw_id}/claim-ticket")
def user_claim_ticket(draw_id: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    d, admin_ids = claims.open_ticket(db, user, draw_id)
    db.commit()
    for aid in admin_ids:
        notify_ws(aid)
    return {"ticketId": d.support_ticket_id, "draw": spin_svc.draw_out(d, None)}
