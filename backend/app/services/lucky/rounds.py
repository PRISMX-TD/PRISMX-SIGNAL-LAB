"""期：名称 + 开放时间 + 奖品模式 + 自己的一套奖品 + 「在用户端显示」开关（rev 46）。
多期可以同时进行；结束 = 作废本期未用的券 + 写 ended_at；删除 = 连同本期的记录、券、批次、奖品一起硬删。

Rounds (rev 46): name + window + prize mode + own prize set + a "shown to users" switch. Several
may run at once. Ending voids the round's unused tickets; deleting hard-deletes the round together
with its draws, tickets, batches and prizes.
"""
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import LuckyDraw, LuckyPrize, LuckyRound, LuckyTicket, LuckyTicketBatch, User
from app.services.lucky.common import F_OPEN, MAX_ROUND_NAME, MODES, T_UNUSED, T_USED, T_VOIDED

LIST_LIMIT = 100


def phase(r: LuckyRound | None, now: datetime) -> str:
    if r is None:
        return "none"
    if r.ended_at is not None or r.ends_at <= now:
        return "ended"
    return "upcoming" if r.starts_at > now else "active"


def is_open(r: LuckyRound | None, now: datetime) -> bool:
    """未结束（未开始或进行中）。/ not ended (upcoming or active)."""
    return phase(r, now) in ("upcoming", "active")


def can_see(user: User, r: LuckyRound) -> bool:
    """管理员看得到所有期（内部测试按正式流程抽）；普通用户只看得到打开了「在用户端显示」的期。
    Admins see every round (internal testing runs the real flow); users only see visible rounds."""
    return user.role == "admin" or bool(r.visible)


def open_rounds_query(db: Session, user: User, now: datetime):
    """这个人现在能看到的未结束期（用户端列表、/auth/me 的券数共用这一条条件）。
    The unended rounds this person can see now (shared by the user list and /auth/me's ticket count)."""
    q = db.query(LuckyRound).filter(LuckyRound.ended_at.is_(None), LuckyRound.ends_at > now)
    if user.role != "admin":
        q = q.filter(LuckyRound.visible.is_(True))
    return q


def get_or_404(db: Session, round_id: str) -> LuckyRound:
    r = db.get(LuckyRound, round_id) if round_id else None
    if r is None:
        raise HTTPException(404, "这一期不存在 / Round not found")
    return r


def stats(db: Session, round_ids: list[str]) -> dict[str, dict]:
    """每期的统计，整批三条 GROUP BY 查完（列表一次最多 100 期，不逐期查）。
    issued = 本期券总数（含已用 / 作废 / 收回 / 「再来一次」补发）。
    Per-round stats in three GROUP BYs for the whole list. issued = every ticket row of the round."""
    out = {rid: {"issued": 0, "used": 0, "unused": 0, "pendingClaims": 0, "draws": 0} for rid in round_ids}
    if not round_ids:
        return out
    for rid, status, n in (db.query(LuckyTicket.round_id, LuckyTicket.status, func.count(LuckyTicket.id))
                           .filter(LuckyTicket.round_id.in_(round_ids))
                           .group_by(LuckyTicket.round_id, LuckyTicket.status)):
        s = out[rid]
        s["issued"] += n
        if status == T_USED:
            s["used"] += n
        elif status == T_UNUSED:
            s["unused"] += n
    for rid, n in (db.query(LuckyDraw.round_id, func.count(LuckyDraw.id))
                   .filter(LuckyDraw.round_id.in_(round_ids)).group_by(LuckyDraw.round_id)):
        out[rid]["draws"] = n
    for rid, n in (db.query(LuckyDraw.round_id, func.count(LuckyDraw.id))
                   .filter(LuckyDraw.round_id.in_(round_ids), LuckyDraw.fulfillment_status.in_(F_OPEN))
                   .group_by(LuckyDraw.round_id)):
        out[rid]["pendingClaims"] = n
    return out


def admin_out(r: LuckyRound, now: datetime, st: dict | None = None) -> dict:
    return {"id": r.id, "name": r.name, "mode": r.mode, "visible": bool(r.visible),
            "startsAt": r.starts_at, "endsAt": r.ends_at, "phase": phase(r, now), "endedAt": r.ended_at,
            "stats": st if st is not None else {"issued": 0, "used": 0, "unused": 0, "pendingClaims": 0, "draws": 0}}


def admin_out_one(db: Session, r: LuckyRound, now: datetime) -> dict:
    return admin_out(r, now, stats(db, [r.id])[r.id])


def public_out(r: LuckyRound, now: datetime) -> dict:
    """用户端：不给模式、概率、份数。/ user-facing: no mode, odds or quantities."""
    return {"id": r.id, "name": r.name, "startsAt": r.starts_at, "endsAt": r.ends_at, "phase": phase(r, now)}


def list_admin(db: Session, now: datetime) -> list[LuckyRound]:
    """未结束在前（开始时间倒序），再已结束（结束时刻倒序），合计最多 100 期。
    Unended first (newest start first), then ended (latest end first); at most 100 in all."""
    unended = (db.query(LuckyRound).filter(LuckyRound.ended_at.is_(None))
               .order_by(LuckyRound.starts_at.desc(), LuckyRound.id).limit(LIST_LIMIT).all())
    left = LIST_LIMIT - len(unended)
    ended = (db.query(LuckyRound).filter(LuckyRound.ended_at.isnot(None))
             .order_by(LuckyRound.ended_at.desc(), LuckyRound.id).limit(left).all()) if left > 0 else []
    return unended + ended


def _clean_name(name: str) -> str:
    n = (name or "").strip()
    if not n or len(n) > MAX_ROUND_NAME:
        raise HTTPException(400, f"期名要 1–{MAX_ROUND_NAME} 个字 / Round name must be 1–{MAX_ROUND_NAME} chars")
    return n


def create_round(db: Session, admin: User, name: str, starts_at: datetime, ends_at: datetime, mode: str,
                 now: datetime) -> LuckyRound:
    starts_at, ends_at = to_utc_naive(starts_at), to_utc_naive(ends_at)
    if mode not in MODES:
        raise HTTPException(400, "奖品模式不对 / Unknown prize mode")
    if ends_at <= starts_at or ends_at <= now:
        raise HTTPException(400, "结束时间要晚于开始时间和现在 / End must be after start and now")
    r = LuckyRound(name=_clean_name(name), mode=mode, visible=False, starts_at=starts_at, ends_at=ends_at,
                   created_by=admin.id, created_at=now)
    db.add(r)
    db.flush()
    return r


def update_round(db: Session, r: LuckyRound, admin: User, name: str | None, starts_at: datetime | None,
                 ends_at: datetime | None, now: datetime) -> int:
    """返回作废张数。结束时间改到现在或过去 = 立即结束。已结束的期 409。
    Returns the voided count. Moving the end to now or earlier ends the round at once; an ended round is 409."""
    if phase(r, now) == "ended":
        raise HTTPException(409, "这一期已经结束，不能再改 / This round has ended")
    if name is not None:
        r.name = _clean_name(name)
    if starts_at is not None:
        starts_at = to_utc_naive(starts_at)
        if phase(r, now) != "upcoming":
            raise HTTPException(400, "已经开始，不能改开始时间 / Already started")
        r.starts_at = starts_at
    if ends_at is not None:
        r.ends_at = to_utc_naive(ends_at)
    if r.ends_at <= r.starts_at:
        raise HTTPException(400, "结束时间要晚于开始时间 / End must be after start")
    return end_round(db, r, now, admin.id) if r.ends_at <= now else 0


def end_round(db: Session, r: LuckyRound, now: datetime, actor_id: str | None) -> int:
    """作废本期未用的券并写 ended_at；结束时间还在将来（立即结束）就拉到现在。不提交。
    actor_id 本函数不用，留着是因为调用方（含审计路径）都会传。
    Void unused tickets and stamp ended_at; an early end pulls ends_at to now. No commit.
    actor_id is unused here; kept because callers (the audit path) pass it."""
    if r.ends_at > now:
        r.ends_at = now
    n = (db.query(LuckyTicket)
         .filter(LuckyTicket.round_id == r.id, LuckyTicket.status == T_UNUSED)
         .update({LuckyTicket.status: T_VOIDED, LuckyTicket.voided_at: now}, synchronize_session=False))
    r.ended_at = now
    return n


def delete_round(db: Session, round_id: str) -> tuple[LuckyRound, dict]:
    """硬删一期及其抽奖记录、券、发券批次、奖品（按外键依赖顺序）。不撤回已加的 PRO 天数，
    不动客服工单（工单表不引用轮盘）、操作日志、站内通知。不提交。

    先对期这一行加 FOR UPDATE：开奖事务对期行持 FOR KEY SHARE，两边因此串行——正在开奖的那次先
    落库、再被这里一起删掉；删完之后才到的开奖拿不到期行，按 404 处理。不这样的话，开奖插入的
    记录会在我们删券时撞外键。

    Hard-delete a round with its draws, tickets, batches and prizes, in FK order. PRO days already
    granted, support tickets (they don't reference the wheel), audit rows and feed rows stay. No commit.
    The round row is locked FOR UPDATE first: a spin holds FOR KEY SHARE on it, so the two serialise —
    an in-flight spin lands and is then deleted with the rest; a spin arriving after finds no round
    (404). Without it a spin's fresh draw could break the FK while we delete its ticket."""
    r = (db.query(LuckyRound).filter(LuckyRound.id == round_id).with_for_update()
         .populate_existing().first())
    if r is None:
        raise HTTPException(404, "这一期不存在 / Round not found")
    counts = {
        "draws": db.query(LuckyDraw).filter(LuckyDraw.round_id == r.id).delete(synchronize_session=False),
        "tickets": db.query(LuckyTicket).filter(LuckyTicket.round_id == r.id).delete(synchronize_session=False),
        "batches": (db.query(LuckyTicketBatch).filter(LuckyTicketBatch.round_id == r.id)
                    .delete(synchronize_session=False)),
        "prizes": db.query(LuckyPrize).filter(LuckyPrize.round_id == r.id).delete(synchronize_session=False),
    }
    db.delete(r)
    db.flush()
    return r, counts


def to_utc_naive(dt: datetime) -> datetime:
    """前端传的是带时区的 ISO；库里一律 naive UTC。/ incoming ISO carries a tz; storage is naive UTC."""
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(timezone.utc).replace(tzinfo=None)
