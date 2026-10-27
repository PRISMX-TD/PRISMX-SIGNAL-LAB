"""幸运轮盘的常量与小工具。/ Lucky-wheel constants and helpers."""
from datetime import datetime, timedelta, timezone

KIND_PRO_DAYS = "pro_days"
KIND_NONE = "none"
KIND_RETRY = "retry"
KIND_CUSTOM = "custom"
PRIZE_KINDS = (KIND_PRO_DAYS, KIND_NONE, KIND_RETRY, KIND_CUSTOM)

# 每期一种奖品模式（rev 46）：qty = 按份量（抽奖箱），prob = 按概率。
# One prize mode per round (rev 46): qty = by quantity (a raffle box), prob = by probability.
MODE_QTY = "qty"
MODE_PROB = "prob"
MODES = (MODE_QTY, MODE_PROB)

CLAIM_FORM = "form"
CLAIM_TICKET = "ticket"
CLAIM_MODES = (CLAIM_FORM, CLAIM_TICKET)

T_UNUSED = "unused"
T_USED = "used"
T_VOIDED = "voided"
T_REVOKED = "revoked"

F_AUTO = "auto_done"
F_PENDING = "pending"
F_SUBMITTED = "submitted"
F_DELIVERED = "delivered"
F_CANCELLED = "cancelled"
F_OPEN = (F_PENDING, F_SUBMITTED)

SRC_COMP = "comp_rank"
SRC_BOARD = "board_rank"
SRC_RETRY = "retry"

# 中奖送 PRO 天数的审计字段（apply_comp_days 的 audit_fields）；activity_feed 按 LUCKY_AUDIT_PREFIX 整族跳过。
# Audit fields for PRO days won on the wheel; activity_feed skips the whole LUCKY_AUDIT_PREFIX family.
LUCKY_AUDIT_PREFIX = "plan:lucky"
LUCKY_PLAN_FIELD = "plan:lucky_plan"
LUCKY_EXPIRY_FIELD = "plan:lucky_days"

PROB_TOTAL = 10000
MIN_SLOTS = 2
MAX_SLOTS = 12
MAX_BATCH_TICKETS = 20000
MAX_ROUND_NAME = 40


def opens_text(starts_at: datetime) -> str:
    """「X月X日 HH:MM 开启」，按 UTC+8 显示（库里是 naive UTC）。
    "X月X日 HH:MM 开启" in UTC+8 (storage is naive UTC)."""
    local = starts_at + timedelta(hours=8)
    return f"{local.month}月{local.day}日 {local:%H:%M}开启"


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)
