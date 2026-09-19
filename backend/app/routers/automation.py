"""自动仓位管理设置路由（PRO 专属）/ auto position-management settings (PRO only)."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models import AutoManageSettings, User
from app.services.auto_manage import invalidate_eligibility
from app.services.deps import get_current_user
from app.services.plans import can_auto_manage

router = APIRouter(prefix="/automation", tags=["automation"])


class AutoManageSettingsOut(BaseModel):
    enabled: bool
    beEnabled: bool
    beTriggerR: float
    trailEnabled: bool
    trailTriggerR: float
    trailDistanceR: float
    ptpEnabled: bool
    ptpTriggerR: float
    ptpFraction: float


class AutoManageSettingsIn(BaseModel):
    enabled: bool = False
    beEnabled: bool = True
    # 触发阈值以 R 为单位，限制在合理范围防止手滑输入 / thresholds in R, clamped to sane ranges
    beTriggerR: float = Field(default=1.0, ge=0.1, le=10)
    trailEnabled: bool = False
    trailTriggerR: float = Field(default=1.5, ge=0.1, le=10)
    trailDistanceR: float = Field(default=1.0, ge=0.1, le=10)
    ptpEnabled: bool = False
    ptpTriggerR: float = Field(default=1.0, ge=0.1, le=10)
    # 分批平仓比例 10%~90%：两边都必须剩下可成交的手数 / close fraction 10%–90%
    ptpFraction: float = Field(default=0.5, ge=0.1, le=0.9)


def _get_or_create(db: Session, user_id: str) -> AutoManageSettings:
    row = db.query(AutoManageSettings).filter(AutoManageSettings.user_id == user_id).first()
    if row is None:
        row = AutoManageSettings(user_id=user_id)
        db.add(row)
        db.flush()
    return row


def _defaults_out() -> AutoManageSettingsOut:
    """没有设置行时的应答：出厂默认值，一个字都不落库。

    读路径专用。`get_db` 只 close 不 commit，所以 GET 里 `_get_or_create` 插进去的
    那一行必定被回滚——每次 GET 都白写一条注定作废的 INSERT，下次 GET 再来一遍。
    前端每次打开设置页都会调这个接口，纯属浪费库往返（本项目对 Supabase 的 Egress
    敏感）。"没有行"本来就等于"全是默认值"，直接照默认值答，真正需要落库的是 PUT。

    默认值取自 `AutoManageSettingsIn`（它与模型列上的 default= 一致，有测试钉住），
    而不是新建一个游离的 AutoManageSettings：列上的 default= 要到落库那一刻才生效，
    游离对象的这些属性还是 None，拿去序列化会让几个 bool 字段变成 null。

    The answer when no settings row exists: factory defaults, nothing written.
    get_db closes without committing, so the row _get_or_create inserts during a
    GET is always rolled back — every GET writes an INSERT guaranteed to be
    discarded, and the next GET repeats it. The frontend calls this every time the
    settings page opens. "No row" already means "all defaults", so answer from
    them; PUT is what actually needs a row.

    Defaults come from AutoManageSettingsIn (kept equal to the model's column
    defaults, pinned by a test) rather than a detached AutoManageSettings: a
    column's default= only applies at insert time, so a detached instance still
    has None in those attributes and the bool fields would serialise as null.
    """
    return AutoManageSettingsOut(**AutoManageSettingsIn().model_dump())


def _serialize(row: AutoManageSettings) -> AutoManageSettingsOut:
    return AutoManageSettingsOut(
        enabled=row.enabled,
        beEnabled=row.be_enabled,
        beTriggerR=row.be_trigger_r,
        trailEnabled=row.trail_enabled,
        trailTriggerR=row.trail_trigger_r,
        trailDistanceR=row.trail_distance_r,
        ptpEnabled=row.ptp_enabled,
        ptpTriggerR=row.ptp_trigger_r,
        ptpFraction=row.ptp_fraction,
    )


@router.get("/settings", response_model=AutoManageSettingsOut)
def get_settings(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """读取当前用户的自动仓位管理设置（任何等级都可读，方便前端展示锁定态）。
    Read the user's auto-management settings (readable on any plan so the UI
    can render the locked state)."""
    row = db.query(AutoManageSettings).filter(AutoManageSettings.user_id == user.id).first()
    # 查不到不建行，直接答默认值——理由见 _defaults_out。
    # No row: answer with defaults instead of creating one; see _defaults_out.
    return _serialize(row) if row is not None else _defaults_out()


@router.put("/settings", response_model=AutoManageSettingsOut)
def put_settings(
    body: AutoManageSettingsIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """保存设置。开启总开关需要 PRO；关闭任何等级都放行——降级用户必须
    始终能把它关掉。Save settings. Enabling requires PRO; disabling is always
    allowed so a downgraded user is never stuck with automation running."""
    if body.enabled and not can_auto_manage(user.plan):
        raise HTTPException(
            status_code=403,
            detail="自动仓位管理为 PRO 专属功能，请升级解锁 / Auto position management is PRO-only; upgrade to unlock",
        )
    row = _get_or_create(db, user.id)
    row.enabled = body.enabled
    row.be_enabled = body.beEnabled
    row.be_trigger_r = body.beTriggerR
    row.trail_enabled = body.trailEnabled
    row.trail_trigger_r = body.trailTriggerR
    row.trail_distance_r = body.trailDistanceR
    row.ptp_enabled = body.ptpEnabled
    row.ptp_trigger_r = body.ptpTriggerR
    row.ptp_fraction = body.ptpFraction
    db.commit()
    invalidate_eligibility(user.id)
    return _serialize(row)
