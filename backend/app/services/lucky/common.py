"""幸运轮盘的常量与小工具。/ Lucky-wheel constants and helpers."""
import json
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.models import PlatformSetting

VISIBLE_KEY = "lucky_wheel_visible"

KIND_PRO_DAYS = "pro_days"
KIND_NONE = "none"
KIND_RETRY = "retry"
KIND_CUSTOM = "custom"
PRIZE_KINDS = (KIND_PRO_DAYS, KIND_NONE, KIND_RETRY, KIND_CUSTOM)

SOLD_OUT_FALLBACK = "to_fallback"
SOLD_OUT_REDISTRIBUTE = "redistribute"
SOLD_OUT_MODES = (SOLD_OUT_FALLBACK, SOLD_OUT_REDISTRIBUTE)

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

SRC_MANUAL = "manual"
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
MAX_BATCH_USERS = 2000
MAX_PER_USER = 100
MAX_BATCH_TICKETS = 20000


def opens_text(starts_at: datetime) -> str:
    """「X月X日 HH:MM 开启」，按 UTC+8 显示（库里是 naive UTC）。
    "X月X日 HH:MM 开启" in UTC+8 (storage is naive UTC)."""
    local = starts_at + timedelta(hours=8)
    return f"{local.month}月{local.day}日 {local:%H:%M}开启"


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def is_visible(db: Session) -> bool:
    """直接读库不走 settings_store 缓存：开关一拨用户端立刻生效，这一行是主键查询，很便宜。
    Read straight from the table (no settings_store cache) so a flip takes effect at once."""
    row = db.query(PlatformSetting).filter(PlatformSetting.key == VISIBLE_KEY).first()
    if row is None:
        return False
    try:
        return bool(json.loads(row.value))
    except (TypeError, ValueError):
        return False


def set_visible(db: Session, visible: bool) -> None:
    from app.services.settings_store import set_setting
    set_setting(db, VISIBLE_KEY, bool(visible))
