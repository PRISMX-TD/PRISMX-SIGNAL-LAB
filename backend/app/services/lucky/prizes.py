"""奖项：整套保存（校验合计 100%）、上架列表、三种序列化。
Prizes: whole-set save (must total 100%), the active list, and three serialisations."""
import json

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import LuckyPrize
from app.services.lucky import odds
from app.services.lucky.common import KIND_CUSTOM, PROB_TOTAL, utcnow


def active_prizes(db: Session) -> list[LuckyPrize]:
    return (db.query(LuckyPrize).filter(LuckyPrize.archived.is_(False))
            .order_by(LuckyPrize.sort_order, LuckyPrize.id).all())


def pct_to_bp(pct: float) -> int:
    return int(round(pct * 100))


def save_prizes(db: Session, items: list) -> list[LuckyPrize]:
    """items 是 schemas.LuckyPrizeIn 列表，顺序即轮盘顺序。带 id 的更新那一格；不带的新建；
    原有但这次没出现的下架（archived），不硬删——抽奖记录的 prize_id 要能对上。不提交。
    items are LuckyPrizeIn in wheel order. With id → update; without → create; existing slots
    left out are archived, never deleted (draw rows reference them). No commit."""
    drafts = [odds.PrizeDraft(
        name=i.name, kind=i.kind, prob_bp=pct_to_bp(i.probPct), pro_days=i.proDays, stock=i.stock,
        per_user_limit=i.perUserLimit, on_sold_out=i.onSoldOut,
        claim_mode=i.claimMode if i.kind == KIND_CUSTOM else None,
    ) for i in items]
    errs = odds.validate(drafts)
    if errs:
        raise HTTPException(422, "；".join(errs))
    existing = {p.id: p for p in db.query(LuckyPrize).filter(LuckyPrize.archived.is_(False))}
    now = utcnow()
    kept: list[LuckyPrize] = []
    for order, (i, d) in enumerate(zip(items, drafts)):
        p = existing.pop(i.id, None) if i.id else None
        if i.id and p is None:
            raise HTTPException(404, f"奖项不存在 / Prize not found: {i.id}")
        if p is None:
            p = LuckyPrize(stock_used=0)
            db.add(p)
        if d.stock is not None and d.stock < (p.stock_used or 0):
            raise HTTPException(400, f"「{i.name}」库存不能少于已发出的 {p.stock_used} / "
                                     f"Stock below the {p.stock_used} already given")
        p.sort_order = order
        p.name = i.name.strip()
        p.description = (i.description or "").strip() or None
        p.image_url = i.imageUrl or None
        p.color = i.color
        p.kind = i.kind
        p.pro_days = i.proDays if i.kind == "pro_days" else None
        p.prob_bp = d.prob_bp
        p.stock = i.stock
        p.per_user_limit = i.perUserLimit
        p.on_sold_out = i.onSoldOut
        p.claim_mode = d.claim_mode
        p.claim_hint = ((i.claimHint or "").strip() or None) if i.kind == KIND_CUSTOM else None
        p.updated_at = now
        kept.append(p)
    for p in existing.values():
        p.archived = True
        p.updated_at = now
    db.flush()
    assert sum(p.prob_bp for p in kept) == PROB_TOTAL
    return kept


def public_out(p: LuckyPrize) -> dict:
    """用户端：不给概率、库存、上限（设计 §1.6）。/ user-facing: no odds, stock or limits."""
    return {"id": p.id, "name": p.name, "description": p.description, "imageUrl": p.image_url,
            "color": p.color, "kind": p.kind, "proDays": p.pro_days}


def admin_out(p: LuckyPrize) -> dict:
    return {**public_out(p), "probBp": p.prob_bp, "stock": p.stock, "stockUsed": p.stock_used or 0,
            "perUserLimit": p.per_user_limit, "onSoldOut": p.on_sold_out,
            "claimMode": p.claim_mode, "claimHint": p.claim_hint}


def audit_view(p: LuckyPrize) -> dict:
    """操作日志里记的一格：后台能看到的全部字段（天数、库存、每人上限、抽完规则、领取方式、图片、
    上架状态、顺序……），去掉随抽奖变化的已发出数，免得把「别人抽了一次」记成一次修改。
    One slot as recorded in the activity log: every field the admin sees (days, stock, per-user
    limit, sold-out rule, claim mode, image, active, order …) minus the running used-count, so a
    spin by someone else never shows up as an edit."""
    out = {**admin_out(p), "sortOrder": p.sort_order, "active": not p.archived}
    out.pop("stockUsed", None)
    return out


def snapshot(p: LuckyPrize) -> str:
    """抽奖记录里存的奖项快照：之后管理员改了奖项，这条记录仍按当时的样子显示。
    Stored on a draw row so later prize edits don't rewrite history."""
    return json.dumps(admin_out(p), ensure_ascii=False, default=str)
