"""奖项：按期整套保存（按模式校验）、某一期的上架列表、三种序列化。
Prizes: whole-set save per round (validated by the round's mode), a round's active list, three serialisations."""
import json

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models import LuckyDraw, LuckyPrize, LuckyRound
from app.services.lucky import odds
from app.services.lucky.common import KIND_CUSTOM, KIND_PRO_DAYS, MODE_PROB, utcnow


def active_prizes(db: Session, round_id: str) -> list[LuckyPrize]:
    return (db.query(LuckyPrize).filter(LuckyPrize.round_id == round_id, LuckyPrize.archived.is_(False))
            .order_by(LuckyPrize.sort_order, LuckyPrize.id).all())


def pct_to_bp(pct: float | None) -> int:
    return int(round((pct or 0) * 100))


def save_prizes(db: Session, r: LuckyRound, mode: str, items: list) -> list[LuckyPrize]:
    """items 是 schemas.LuckyPrizeIn 列表，顺序即轮盘顺序，全部限定在这一期。带 id 的更新那一格；
    不带的新建；原有但这次没出现的下架（archived），不硬删——抽奖记录的 prize_id 要能对上。
    有抽奖记录后不能换模式（409）：按份量和按概率的历史记录口径不同，混在一期里统计就对不上了。
    按份量模式不存概率（prob_bp = 0）。不提交。

    items are LuckyPrizeIn in wheel order, scoped to this round. With id → update; without → create;
    slots left out are archived, never deleted (draw rows reference them). The mode can't change once
    the round has draws (409): qty and prob draws mean different things and would not add up within one
    round. qty mode stores no odds (prob_bp = 0). No commit."""
    if mode != r.mode and db.query(LuckyDraw.id).filter(LuckyDraw.round_id == r.id).first() is not None:
        raise HTTPException(409, "已经有人抽过，不能改模式 / This round already has draws; the mode is fixed")
    drafts = [odds.PrizeDraft(
        name=i.name, kind=i.kind, prob_bp=pct_to_bp(i.probPct) if mode == MODE_PROB else 0,
        pro_days=i.proDays, stock=i.stock,
        claim_mode=i.claimMode if i.kind == KIND_CUSTOM else None,
    ) for i in items]
    errs = odds.validate(mode, drafts)
    if errs:
        raise HTTPException(422, "；".join(errs))
    existing = {p.id: p for p in db.query(LuckyPrize)
                .filter(LuckyPrize.round_id == r.id, LuckyPrize.archived.is_(False))}
    now = utcnow()
    kept: list[LuckyPrize] = []
    for order, (i, d) in enumerate(zip(items, drafts)):
        p = existing.pop(i.id, None) if i.id else None
        if i.id and p is None:
            raise HTTPException(404, f"奖项不存在 / Prize not found: {i.id}")
        if p is None:
            p = LuckyPrize(round_id=r.id, stock_used=0)
            db.add(p)
        if d.stock is not None and d.stock < (p.stock_used or 0):
            raise HTTPException(400, f"「{i.name}」份数不能少于已发出的 {p.stock_used} / "
                                     f"Quantity below the {p.stock_used} already given")
        p.sort_order = order
        p.name = i.name.strip()
        p.description = (i.description or "").strip() or None
        p.image_url = i.imageUrl or None
        p.color = i.color
        p.kind = i.kind
        p.pro_days = i.proDays if i.kind == KIND_PRO_DAYS else None
        p.prob_bp = d.prob_bp
        p.stock = d.stock
        p.claim_mode = d.claim_mode
        p.claim_hint = ((i.claimHint or "").strip() or None) if i.kind == KIND_CUSTOM else None
        p.updated_at = now
        kept.append(p)
    for p in existing.values():
        p.archived = True
        p.updated_at = now
    r.mode = mode
    db.flush()
    return kept


def public_out(p: LuckyPrize) -> dict:
    """用户端：不给概率、份数（设计 §1.6）。/ user-facing: no odds or quantities."""
    return {"id": p.id, "name": p.name, "description": p.description, "imageUrl": p.image_url,
            "color": p.color, "kind": p.kind, "proDays": p.pro_days}


def admin_out(p: LuckyPrize) -> dict:
    return {**public_out(p), "probBp": p.prob_bp, "stock": p.stock, "stockUsed": p.stock_used or 0,
            "claimMode": p.claim_mode, "claimHint": p.claim_hint}


def audit_view(p: LuckyPrize) -> dict:
    """操作日志里记的一格：后台能看到的全部字段（天数、份数、概率、领取方式、图片、上架状态、顺序……），
    去掉随抽奖变化的已发出数，免得把「别人抽了一次」记成一次修改。
    One slot as recorded in the activity log: every field the admin sees (days, quantity, odds, claim
    mode, image, active, order …) minus the running used-count, so a spin by someone else never shows
    up as an edit."""
    out = {**admin_out(p), "sortOrder": p.sort_order, "active": not p.archived}
    out.pop("stockUsed", None)
    return out


def snapshot(p: LuckyPrize) -> str:
    """抽奖记录里存的奖项快照：之后管理员改了奖项，这条记录仍按当时的样子显示。
    Stored on a draw row so later prize edits don't rewrite history."""
    return json.dumps(admin_out(p), ensure_ascii=False, default=str)
