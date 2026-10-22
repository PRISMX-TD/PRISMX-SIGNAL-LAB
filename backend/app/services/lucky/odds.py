"""概率：配置校验、对某个人的可中权重、按权重抽一格。全是纯函数，开奖事务只负责喂数据。

可中权重的规则（设计 §4 第 5 步）：不可中的格（库存满 / 本人到上限 / 永久 PRO 遇 PRO 天数）——
to_fallback 把它的权重加到兜底格（第一格「谢谢参与」）上，其余格概率不变；redistribute 直接
去掉它，剩下的合计变小，相当于按比例放大。

Odds: config validation, per-user available weights, weighted pick. Pure functions; the spin
transaction only feeds them. An unavailable slot either hands its weight to the fallback slot
(to_fallback) or is dropped so the rest scale up proportionally (redistribute).
"""
import secrets
from dataclasses import dataclass

from app.services.lucky.common import (
    CLAIM_MODES, KIND_CUSTOM, KIND_NONE, KIND_PRO_DAYS, MAX_SLOTS, MIN_SLOTS, PRIZE_KINDS,
    PROB_TOTAL, SOLD_OUT_FALLBACK, SOLD_OUT_MODES,
)


@dataclass(frozen=True)
class Slot:
    id: str
    prob_bp: int
    available: bool
    on_sold_out: str
    is_fallback: bool


def effective_weights(slots: list[Slot]) -> list[tuple[str, int]]:
    fallback = next((s for s in slots if s.is_fallback and s.available), None)
    extra = 0
    for s in slots:
        if not s.available and s.on_sold_out == SOLD_OUT_FALLBACK and fallback is not None:
            extra += s.prob_bp
    out = []
    for s in slots:
        if not s.available:
            continue
        w = s.prob_bp + (extra if fallback is not None and s.id == fallback.id else 0)
        if w > 0:
            out.append((s.id, w))
    return out


def pick(weights: list[tuple[str, int]], rand_below=secrets.randbelow) -> str | None:
    total = sum(w for _, w in weights)
    if total <= 0:
        return None
    r = rand_below(total)
    for pid, w in weights:
        if r < w:
            return pid
        r -= w
    return weights[-1][0]   # 不会走到；rand_below 越界时的保险 / unreachable unless rand_below misbehaves


@dataclass
class PrizeDraft:
    name: str
    kind: str
    prob_bp: int
    pro_days: int | None = None
    stock: int | None = None
    per_user_limit: int | None = None
    on_sold_out: str = SOLD_OUT_FALLBACK
    claim_mode: str | None = None


def fallback_index(drafts: list[PrizeDraft]) -> int | None:
    return next((i for i, d in enumerate(drafts) if d.kind == KIND_NONE), None)


def _limited(d: PrizeDraft) -> bool:
    return d.stock is not None or d.per_user_limit is not None


def validate(drafts: list[PrizeDraft]) -> list[str]:
    errs: list[str] = []
    if not MIN_SLOTS <= len(drafts) <= MAX_SLOTS:
        errs.append(f"轮盘要有 {MIN_SLOTS}–{MAX_SLOTS} 格 / The wheel needs {MIN_SLOTS}–{MAX_SLOTS} slots")
    for i, d in enumerate(drafts, 1):
        if not (d.name or "").strip():
            errs.append(f"第 {i} 格没有名称 / Slot {i} has no name")
        if d.kind not in PRIZE_KINDS:
            errs.append(f"第 {i} 格类型不对 / Slot {i} has an unknown type")
        if not 0 <= d.prob_bp <= PROB_TOTAL:
            errs.append(f"第 {i} 格概率不在 0–100% / Slot {i} probability out of range")
        if d.kind == KIND_PRO_DAYS and not (d.pro_days and 1 <= d.pro_days <= 3650):
            errs.append(f"第 {i} 格要填 1–3650 天 / Slot {i} needs 1–3650 days")
        if d.kind == KIND_CUSTOM and d.claim_mode not in CLAIM_MODES:
            errs.append(f"第 {i} 格要选领取方式 / Slot {i} needs a claim method")
        if d.kind == KIND_NONE and _limited(d):
            errs.append(f"第 {i} 格「谢谢参与」不能设库存或上限 / Slot {i}: a no-prize slot can't be limited")
        if d.on_sold_out not in SOLD_OUT_MODES:
            errs.append(f"第 {i} 格抽完后处理不对 / Slot {i} has an unknown sold-out rule")
        if (d.stock is not None and d.stock < 0) or (d.per_user_limit is not None and d.per_user_limit < 1):
            errs.append(f"第 {i} 格库存或上限不对 / Slot {i} has a bad stock or limit")
    if sum(d.prob_bp for d in drafts) != PROB_TOTAL:
        errs.append("概率合计必须是 100% / Probabilities must add up to 100%")
    needs_fallback = any(_limited(d) and d.on_sold_out == SOLD_OUT_FALLBACK for d in drafts)
    if needs_fallback and fallback_index(drafts) is None:
        errs.append("有格子抽完后要并入「谢谢参与」，但轮盘上没有「谢谢参与」/ "
                    "A slot falls back to 'no prize' but there is no such slot")
    return errs
