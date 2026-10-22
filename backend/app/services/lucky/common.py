"""幸运轮盘的常量与小工具。/ Lucky-wheel constants and helpers."""
import json
from datetime import datetime, timezone

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

PROB_TOTAL = 10000
MIN_SLOTS = 2
MAX_SLOTS = 12
MAX_BATCH_USERS = 2000
MAX_PER_USER = 100
MAX_BATCH_TICKETS = 20000


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
