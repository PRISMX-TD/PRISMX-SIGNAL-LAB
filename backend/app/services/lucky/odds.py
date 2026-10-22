"""概率：配置校验、对某个人的可中权重、按权重抽一格。全是纯函数，开奖事务只负责喂数据。

两种模式（rev 46，每期一种）：
- qty 按份量：像抽奖箱，每格权重 = 剩余份数（stock − stock_used）。份数为 0 的格照样留在轮盘上，
  只是权重 0 抽不中。
- prob 按概率：每格权重 = prob_bp（万分比），**不剔除已抽完的格**——抽中已抽完的格由开奖事务记成
  「已抽完未中奖」，概率不会分给别的格。
两种模式都只对这个人本人排除一种格：永久 PRO 用户遇到 PRO 天数格，权重视为 0。

Odds: config validation, per-user weights, weighted pick. Pure functions; the spin transaction only
feeds them. qty mode is a raffle box (weight = remaining stock; an empty slot stays on the wheel with
weight 0). prob mode weighs by basis points and never drops sold-out slots — landing on one is a
"sold out, no prize" outcome decided by the spin, and its odds are not handed to other slots. In both
modes the only per-person exclusion is a pro_days slot for a permanent-PRO user (weight 0).
"""
import secrets
from dataclasses import dataclass

from app.services.lucky.common import (
    CLAIM_MODES, KIND_CUSTOM, KIND_PRO_DAYS, MAX_SLOTS, MIN_SLOTS, MODE_PROB, MODE_QTY, MODES, PRIZE_KINDS,
    PROB_TOTAL,
)


@dataclass(frozen=True)
class Slot:
    id: str
    prob_bp: int
    stock: int | None
    stock_used: int
    excluded: bool = False      # 对这个人不可中（永久 PRO 遇 PRO 天数）/ not winnable for this person


def sold_out(stock: int | None, stock_used: int | None) -> bool:
    return stock is not None and (stock_used or 0) >= stock


def weights(mode: str, slots: list[Slot]) -> list[tuple[str, int]]:
    """这个人在这一期的可中权重（只留 > 0 的）。合计为 0 = 对他来说奖品已抽完。
    This person's weights for the round (positive ones only). An empty list = nothing left for them."""
    out = []
    for s in slots:
        if s.excluded:
            continue
        if mode == MODE_QTY:
            w = max((s.stock or 0) - (s.stock_used or 0), 0)
        else:
            w = s.prob_bp
        if w > 0:
            out.append((s.id, w))
    return out


def pick(weights_: list[tuple[str, int]], rand_below=secrets.randbelow) -> str | None:
    total = sum(w for _, w in weights_)
    if total <= 0:
        return None
    r = rand_below(total)
    for pid, w in weights_:
        if r < w:
            return pid
        r -= w
    return weights_[-1][0]   # 不会走到；rand_below 越界时的保险 / unreachable unless rand_below misbehaves


@dataclass
class PrizeDraft:
    name: str
    kind: str
    prob_bp: int = 0
    pro_days: int | None = None
    stock: int | None = None
    claim_mode: str | None = None


def validate(mode: str, drafts: list[PrizeDraft]) -> list[str]:
    errs: list[str] = []
    if mode not in MODES:
        return ["奖品模式不对 / Unknown prize mode"]
    if not MIN_SLOTS <= len(drafts) <= MAX_SLOTS:
        errs.append(f"轮盘要有 {MIN_SLOTS}–{MAX_SLOTS} 格 / The wheel needs {MIN_SLOTS}–{MAX_SLOTS} slots")
    for i, d in enumerate(drafts, 1):
        if not (d.name or "").strip():
            errs.append(f"第 {i} 格没有名称 / Slot {i} has no name")
        if d.kind not in PRIZE_KINDS:
            errs.append(f"第 {i} 格类型不对 / Slot {i} has an unknown type")
        if d.kind == KIND_PRO_DAYS and not (d.pro_days and 1 <= d.pro_days <= 3650):
            errs.append(f"第 {i} 格要填 1–3650 天 / Slot {i} needs 1–3650 days")
        if d.kind == KIND_CUSTOM and d.claim_mode not in CLAIM_MODES:
            errs.append(f"第 {i} 格要选领取方式 / Slot {i} needs a claim method")
        if d.stock is not None and d.stock < 0:
            errs.append(f"第 {i} 格份数不对 / Slot {i} has a bad quantity")
        if mode == MODE_QTY and d.stock is None:
            errs.append(f"第 {i} 格要填份数 / Slot {i} needs a quantity")
        if mode == MODE_PROB and not 0 <= d.prob_bp <= PROB_TOTAL:
            errs.append(f"第 {i} 格概率不在 0–100% / Slot {i} probability out of range")
    if mode == MODE_PROB and sum(d.prob_bp for d in drafts) != PROB_TOTAL:
        errs.append("概率合计必须是 100% / Probabilities must add up to 100%")
    if mode == MODE_QTY and sum(d.stock or 0 for d in drafts) <= 0:
        errs.append("总份数要大于 0 / The total quantity must be above 0")
    return errs
