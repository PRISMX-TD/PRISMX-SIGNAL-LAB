"""开奖：一个事务里锁券、锁这一期的奖项、按这个人的可中权重用 secrets 抽一格、扣券扣份数、执行奖项效果。
调用方负责 commit。前端只拿结果播动画（设计 §4）。

两种模式（rev 46）：qty 按剩余份数抽，全部抽完（或对这个人可中的合计为 0）→ 409 不扣券；
prob 按概率抽、不剔除已抽完的格，抽中已抽完的格 = 「已抽完未中奖」：券照常用掉、不加已发出数、
不发奖，记录照写（sold_out_miss = true）。

并发：锁序 用户行 → 期行（FOR KEY SHARE，挡住并发的删期）→ 券行 FOR UPDATE SKIP LOCKED（两个请求
各拿各的券）→ 这一期的奖项行 FOR UPDATE（按 id 排序，让份数计数串行；只锁这一期，不锁全站奖品）。
SQLite 没有行锁，所以还有一道 lucky_draws.ticket_id 唯一约束兜底：撞了就回滚到 savepoint、换下一张券
再来一次。

Spin: in one transaction lock a ticket and the round's prize rows, pick a slot with secrets over this
user's weights, consume the ticket and stock, apply the prize. The caller commits. qty mode picks by
remaining stock and 409s without spending the ticket when nothing is left; prob mode picks by odds
without dropping sold-out slots, and landing on one spends the ticket with no prize (sold_out_miss).
Lock order: user -> round (FOR KEY SHARE, against a concurrent delete) -> ticket (SKIP LOCKED) ->
this round's prizes (FOR UPDATE, ORDER BY id). The ticket_id unique index is the backstop (retry once
on the next ticket).
"""
import json
import secrets
from datetime import datetime

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import LuckyDraw, LuckyPrize, LuckyRound, LuckyTicket, User
from app.services.lucky import odds, prizes, rounds
from app.services.lucky.common import (
    F_AUTO, F_PENDING, KIND_CUSTOM, KIND_PRO_DAYS, KIND_RETRY, LUCKY_EXPIRY_FIELD, LUCKY_PLAN_FIELD, MODE_PROB,
    SRC_RETRY, T_UNUSED, T_USED, utcnow,
)


class SpinError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def can_play(user: User, r: LuckyRound) -> bool:
    return rounds.can_see(user, r)


def unused_count(db: Session, user_id: str, round_id: str) -> int:
    return (db.query(func.count(LuckyTicket.id))
            .filter(LuckyTicket.user_id == user_id, LuckyTicket.round_id == round_id,
                    LuckyTicket.status == T_UNUSED).scalar() or 0)


def slot_index(db: Session, round_id: str, prize_id: str) -> int | None:
    ids = [p.id for p in prizes.active_prizes(db, round_id)]
    return ids.index(prize_id) if prize_id in ids else None


def draw_out(d: LuckyDraw, slot_idx: int | None, round_name: str | None) -> dict:
    snap = json.loads(d.prize_snapshot or "{}")
    return {
        "id": d.id, "createdAt": d.created_at, "slotIndex": slot_idx,
        "prize": {k: snap.get(k) for k in ("id", "name", "description", "imageUrl", "color", "kind",
                                            "proDays", "claimMode", "claimHint")},
        "fulfillmentStatus": d.fulfillment_status, "claimInfo": d.claim_info,
        "supportTicketId": d.support_ticket_id, "adminNote": d.admin_note,
        "soldOut": bool(d.sold_out_miss), "roundId": d.round_id, "roundName": round_name,
    }


def _is_permanent_pro(user: User) -> bool:
    return user.plan == "PRO" and user.plan_expires_at is None


def _prior(db: Session, user_id: str, request_id: str) -> LuckyDraw | None:
    return db.query(LuckyDraw).filter(LuckyDraw.user_id == user_id, LuckyDraw.request_id == request_id).first()


def spin(db: Session, user: User, round_id: str, request_id: str, now: datetime | None = None,
         rand_below=secrets.randbelow) -> LuckyDraw:
    now = now or utcnow()
    # 同一个 requestId 重放返回同一条，不管这次带的是哪一期 / a replay returns the same draw, whatever round it names
    prior = _prior(db, user.id, request_id)
    if prior is not None:
        return prior
    r = db.get(LuckyRound, round_id) if round_id else None
    if r is None:
        raise SpinError(404, "这一期不存在 / Round not found")
    if not can_play(user, r):
        raise SpinError(403, "轮盘未开放 / The wheel is closed")
    if rounds.phase(r, now) != "active":
        raise SpinError(409, "不在开放时间内 / Not open right now")
    for attempt in range(2):
        try:
            with db.begin_nested():
                return _spin_once(db, user, r.id, request_id, now, rand_below)
        except IntegrityError:
            if attempt == 1:
                raise SpinError(409, "请稍后再试 / Please try again")
            db.expire_all()
            prior = _prior(db, user.id, request_id)
            if prior is not None:
                return prior
    raise SpinError(409, "请稍后再试 / Please try again")


def _next_ticket(db: Session, user: User, round_id: str) -> LuckyTicket | None:
    """取本期最早一张 unused，且没被抽奖记录引用过（唯一约束撞过之后同一张不再拿）。
    The oldest unused ticket in the round that no draw references yet."""
    used_ids = db.query(LuckyDraw.ticket_id).filter(LuckyDraw.user_id == user.id, LuckyDraw.round_id == round_id)
    return (db.query(LuckyTicket)
            .filter(LuckyTicket.user_id == user.id, LuckyTicket.round_id == round_id,
                    LuckyTicket.status == T_UNUSED, ~LuckyTicket.id.in_(used_ids))
            .order_by(LuckyTicket.issued_at, LuckyTicket.id)
            .with_for_update(skip_locked=True).first())


def _spin_once(db, user, round_id, request_id, now, rand_below) -> LuckyDraw:
    # 先锁并重读用户行（锁序：用户 → 期 → 券 → 奖项）。user 是鉴权时读的，可能已过期：同一人两个并发
    # 抽中 PRO 天数，若各自拿旧的 plan_expires_at 去加，后写的会覆盖先写的；管理员刚设的永久 PRO
    # 也会被旧值冲掉。锁住之后，并发的第二个请求在这里排队，读到的是第一个提交后的到期日。
    # 同一把锁之后再查一次 request_id：赛跑输掉的重放拿到的是已有记录，而不是 409「没券」。
    # Lock and reload the user row first (lock order: user -> round -> ticket -> prizes). `user` was
    # read at auth time and may be stale: two concurrent pro_days wins would each add to the old expiry
    # and the later write would clobber the earlier; an admin's fresh permanent-PRO grant could be undone
    # too. Under the lock the second request queues here and sees the first one's committed expiry.
    # The request_id is re-checked under the same lock so a replay that lost the race gets the
    # existing draw, not a "no tickets" 409.
    user = (db.query(User).filter(User.id == user.id).with_for_update().populate_existing().one())
    prior = _prior(db, user.id, request_id)
    if prior is not None:
        return prior
    # 期行 FOR KEY SHARE 并重读：与删期（FOR UPDATE）串行；管理员刚结束 / 关掉显示也在这里看到。
    # FOR KEY SHARE + reload on the round: serialises with a delete (FOR UPDATE) and sees a fresh end / hide.
    r = (db.query(LuckyRound).filter(LuckyRound.id == round_id)
         .with_for_update(read=True, key_share=True).populate_existing().first())
    if r is None:
        raise SpinError(404, "这一期不存在 / Round not found")
    if not can_play(user, r):
        raise SpinError(403, "轮盘未开放 / The wheel is closed")
    if rounds.phase(r, now) != "active":
        raise SpinError(409, "不在开放时间内 / Not open right now")
    ticket = _next_ticket(db, user, r.id)
    if ticket is None:
        raise SpinError(409, "没有可用的抽奖券 / No tickets left")
    # 只锁这一期的奖项，按 id 排序加锁（两个开奖按同一顺序拿锁，不会互相死锁）；轮盘顺序在内存里排。
    # Lock only this round's prizes, in id order (every spin takes them in the same order, so no
    # deadlock); the wheel order is sorted in memory.
    locked = (db.query(LuckyPrize).filter(LuckyPrize.round_id == r.id, LuckyPrize.archived.is_(False))
              .order_by(LuckyPrize.id).with_for_update().all())
    active = sorted(locked, key=lambda p: (p.sort_order, p.id))
    perm = _is_permanent_pro(user)
    slots = [odds.Slot(id=p.id, prob_bp=p.prob_bp, stock=p.stock, stock_used=p.stock_used or 0,
                       excluded=perm and p.kind == KIND_PRO_DAYS) for p in active]
    chosen_id = odds.pick(odds.weights(r.mode, slots), rand_below=rand_below)
    if chosen_id is None:
        # 抛出即回滚到 savepoint：券没动 / raising rolls back to the savepoint: the ticket is untouched
        raise SpinError(409, "奖品已抽完 / All prizes are gone")
    p = next(x for x in active if x.id == chosen_id)
    miss = r.mode == MODE_PROB and odds.sold_out(p.stock, p.stock_used)

    ticket.status, ticket.used_at = T_USED, now
    if not miss:
        p.stock_used = (p.stock_used or 0) + 1
    status = F_PENDING if p.kind == KIND_CUSTOM and not miss else F_AUTO
    d = LuckyDraw(user_id=user.id, round_id=r.id, ticket_id=ticket.id, prize_id=p.id,
                  prize_snapshot=prizes.snapshot(p), request_id=request_id, created_at=now,
                  fulfillment_status=status, sold_out_miss=miss)
    db.add(d)
    db.flush()   # 唯一约束在这里撞 / the unique index fires here
    if miss:
        return d
    if p.kind == KIND_PRO_DAYS:
        from app.routers.support import apply_comp_days
        # 中奖是用户本人触发的，不是管理员动作：审计写 plan:lucky_* 专用字段，操作日志整族跳过
        # （产品决定：抽奖不进操作日志）。
        # The win is the user's own doing, not an admin action: audit under the dedicated
        # plan:lucky_* fields, which the activity log skips (product decision: spins stay out of it).
        apply_comp_days(db, user.id, user, p.pro_days, audit_fields=(LUCKY_PLAN_FIELD, LUCKY_EXPIRY_FIELD))
    elif p.kind == KIND_RETRY:
        db.add(LuckyTicket(user_id=user.id, round_id=r.id, source=SRC_RETRY, source_ref=d.id, issued_at=now))
        db.flush()
    return d
