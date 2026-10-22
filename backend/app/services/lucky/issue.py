# backend/app/services/lucky/issue.py
"""发券：按比赛 / 排行榜名次分档解析成名单（每人一行、取最好名次）、整批写券、通知、收回。

榜单快照一行是一个账户，一个人多账户上榜就有多个名次——这里按人去重，取最好的那个。
名次在后端算，前端只拿结果给管理员看、改张数、确认。

Issuing: resolve comp / board ranks into one row per user (best rank wins — snapshots rank
accounts, not people), write a batch, notify, revoke. Ranks are computed here, not trusted
from the client.
"""
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import Competition, LeaderboardSnapshot, LuckyTicket, LuckyTicketBatch, User
from app.services.lucky import rounds
from app.services.lucky.common import (
    MAX_BATCH_TICKETS, SRC_BOARD, SRC_COMP, T_REVOKED, T_UNUSED, is_visible,
)
from app.services.notification_feed import KIND_LUCKY_TICKET, create_notification

LINK = "/lucky"


def _check_tiers(tiers) -> None:
    spans = sorted((t.fromRank, t.toRank) for t in tiers)
    for a, b in spans:
        if a > b:
            raise HTTPException(400, "名次区间写反了 / Rank range reversed")
    for (_a1, b1), (a2, _b2) in zip(spans, spans[1:]):
        if a2 <= b1:
            raise HTTPException(400, "名次区间重叠 / Rank ranges overlap")


def resolve_ranks(db: Session, src) -> list[dict]:
    _check_tiers(src.tiers)
    if src.type == "comp":
        comp = db.get(Competition, src.compId or "")
        if comp is None:
            raise HTTPException(404, "比赛不存在 / Competition not found")
        from app.services.gamification.competitions import comp_period_key
        board, key = comp.metric, comp_period_key(comp.id)
        source, ref, label = SRC_COMP, comp.id, comp.name
    else:
        if not src.board or not src.period:
            raise HTTPException(400, "要选榜单和周期 / Pick a board and period")
        from app.routers.gamification import resolve_period_key
        board, key = src.board, resolve_period_key(src.period)
        source, ref, label = SRC_BOARD, f"{src.board}:{key}", f"{src.board} {key}"
    top = max(t.toRank for t in src.tiers)
    rows = (db.query(LeaderboardSnapshot.user_id, func.min(LeaderboardSnapshot.rank))
            .filter(LeaderboardSnapshot.board == board, LeaderboardSnapshot.period_key == key,
                    LeaderboardSnapshot.rank <= top)
            .group_by(LeaderboardSnapshot.user_id).all())
    users = {u.id: u for u in db.query(User).filter(User.id.in_([uid for uid, _ in rows]))} if rows else {}
    out = []
    for uid, best in sorted(rows, key=lambda x: x[1]):
        tier = next((t for t in src.tiers if t.fromRank <= best <= t.toRank), None)
        u = users.get(uid)
        if tier is None or u is None or u.disabled_at is not None:
            continue
        out.append({"userId": uid, "email": u.email, "nickname": u.nickname, "rank": best,
                    "count": tier.count, "source": source, "sourceRef": ref, "label": label})
    return out


def issue(db: Session, admin: User, body, now: datetime) -> tuple[LuckyTicketBatch, bool]:
    prior = db.query(LuckyTicketBatch).filter(LuckyTicketBatch.request_id == body.requestId).first()
    if prior is not None:
        return prior, prior.notified_at is not None
    r = rounds.current_round(db)
    if rounds.phase(r, now) in ("none", "ended"):
        raise HTTPException(400, "请先设置开放时间 / Set the open window first")
    ids = [i.userId for i in body.items]
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "名单里有重复的人，请先合并 / Duplicate users in the list")
    total = sum(i.count for i in body.items)
    if total > MAX_BATCH_TICKETS:
        raise HTTPException(400, f"一批最多 {MAX_BATCH_TICKETS} 张 / At most {MAX_BATCH_TICKETS} per batch")
    found = {uid for (uid,) in db.query(User.id).filter(User.id.in_(ids))}
    if len(found) != len(ids):
        raise HTTPException(404, "名单里有不存在的用户 / Unknown user in the list")
    batch = LuckyTicketBatch(round_id=r.id, reason=body.reason.strip(), created_by=admin.id, created_at=now,
                             user_count=len(ids), ticket_count=total, request_id=body.requestId)
    db.add(batch)
    db.flush()
    db.bulk_insert_mappings(LuckyTicket, [
        {"user_id": i.userId, "round_id": r.id, "batch_id": batch.id, "source": i.source,
         "source_ref": i.sourceRef, "rank": i.rank, "status": T_UNUSED, "issued_at": now}
        for i in body.items for _ in range(i.count)
    ])
    notified = False
    if is_visible(db):
        notify_batch(db, batch, now)
        notified = True
    return batch, notified


def notify_batch(db: Session, batch: LuckyTicketBatch, now: datetime) -> list[str]:
    """给这一批里本期仍有未用券的人各写一条站内通知（text = 张数 + 原因）。
    One feed row per user in the batch who still holds unused tickets from it."""
    rows = (db.query(LuckyTicket.user_id, func.count(LuckyTicket.id))
            .filter(LuckyTicket.batch_id == batch.id, LuckyTicket.status == T_UNUSED)
            .group_by(LuckyTicket.user_id).all())
    for uid, n in rows:
        create_notification(db, uid, KIND_LUCKY_TICKET, text=f"×{n} · {batch.reason}", link=LINK, ref_id=batch.id)
    batch.notified_at = now
    return [uid for uid, _ in rows]


def notify_pending(db: Session, now: datetime) -> dict[str, list[str]]:
    r = rounds.current_round(db)
    if r is None:
        return {}
    out: dict[str, list[str]] = {}
    for b in db.query(LuckyTicketBatch).filter(LuckyTicketBatch.round_id == r.id,
                                               LuckyTicketBatch.notified_at.is_(None)):
        uids = notify_batch(db, b, now)
        if uids:
            out.setdefault(b.reason, []).extend(uids)
    return out


def revoke(db: Session, batch_id: str | None, user_id: str | None) -> int:
    if not batch_id and not user_id:
        raise HTTPException(400, "要指定批次或用户 / Give a batch or a user")
    r = rounds.current_round(db)
    if r is None:
        return 0
    q = db.query(LuckyTicket).filter(LuckyTicket.round_id == r.id, LuckyTicket.status == T_UNUSED)
    if batch_id:
        q = q.filter(LuckyTicket.batch_id == batch_id)
    if user_id:
        q = q.filter(LuckyTicket.user_id == user_id)
    return q.update({LuckyTicket.status: T_REVOKED}, synchronize_session=False)


def push_tickets(user_ids: list[str], reason: str) -> None:
    from app.services.push_dispatch import EVENT_LUCKY_WHEEL, dispatch_users_push
    dispatch_users_push(user_ids, EVENT_LUCKY_WHEEL, "获得抽奖券", f"{reason}——去「幸运轮盘」转一转吧",
                        url=LINK, tag="prismx-lucky")
