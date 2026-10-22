"""期：开放时间窗口。同一时间最多一期未结束；结束 = 作废本期未用的券 + 写 ended_at。
Rounds: the open window. At most one unended round; ending one voids its unused tickets."""
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import LuckyRound, LuckyTicket, User
from app.services.lucky.common import T_UNUSED, T_VOIDED


def current_round(db: Session) -> LuckyRound | None:
    return (db.query(LuckyRound).filter(LuckyRound.ended_at.is_(None))
            .order_by(LuckyRound.starts_at.desc()).first())


def phase(r: LuckyRound | None, now: datetime) -> str:
    if r is None:
        return "none"
    if r.ended_at is not None or r.ends_at <= now:
        return "ended"
    return "upcoming" if r.starts_at > now else "active"


def round_out(r: LuckyRound | None, now: datetime) -> dict | None:
    if r is None:
        return None
    return {"id": r.id, "startsAt": r.starts_at, "endsAt": r.ends_at, "phase": phase(r, now)}


def create_round(db: Session, admin: User, starts_at: datetime, ends_at: datetime, now: datetime) -> LuckyRound:
    starts_at, ends_at = to_utc_naive(starts_at), to_utc_naive(ends_at)
    if current_round(db) is not None:
        raise HTTPException(409, "还有一期没结束 / A round is still open")
    if ends_at <= starts_at or ends_at <= now:
        raise HTTPException(400, "结束时间要晚于开始时间和现在 / End must be after start and now")
    r = LuckyRound(starts_at=starts_at, ends_at=ends_at, created_by=admin.id, created_at=now)
    db.add(r)
    db.flush()
    return r


def update_round(db: Session, admin: User, starts_at: datetime | None, ends_at: datetime | None,
                 now: datetime) -> tuple[LuckyRound, int]:
    """返回 (期, 作废张数)。结束时间改到现在或过去 = 立即结束。
    Returns (round, voided). Moving the end to now or earlier ends the round at once."""
    r = current_round(db)
    if r is None:
        raise HTTPException(404, "没有进行中的一期 / No open round")
    if starts_at is not None:
        starts_at = to_utc_naive(starts_at)
        if phase(r, now) != "upcoming":
            raise HTTPException(400, "已经开始，不能改开始时间 / Already started")
        r.starts_at = starts_at
    if ends_at is not None:
        r.ends_at = to_utc_naive(ends_at)
    if r.ends_at <= r.starts_at:
        raise HTTPException(400, "结束时间要晚于开始时间 / End must be after start")
    voided = end_round(db, r, now, admin.id) if r.ends_at <= now else 0
    return r, voided


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


def to_utc_naive(dt: datetime) -> datetime:
    """前端传的是带时区的 ISO；库里一律 naive UTC。/ incoming ISO carries a tz; storage is naive UTC."""
    if dt.tzinfo is None:
        return dt
    return dt.astimezone(timezone.utc).replace(tzinfo=None)
