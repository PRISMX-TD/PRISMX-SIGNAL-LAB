"""通知路由：偏好、指标类别列表、推送订阅、VAPID 公钥。
Notification router: prefs, indicator categories, push subscriptions, VAPID key."""
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.models import NotificationPref, PushSubscription, Signal, User
from app.services import quotes_store
from app.services.deps import get_current_user
from app.services.plans import can_use_push
from app.services.push_dispatch import EVENT_TYPES
from app.utils.indicator import indicator_category

router = APIRouter(prefix="/notifications", tags=["notifications"])

# ---- 通知偏好 / Notification prefs ----


class NotificationPrefsOut(BaseModel):
    enabled: bool
    selected_categories: list[str]  # 信号指标类别白名单 / signal indicator-category whitelist
    # 品种白名单，与 selected_categories 按"与"关系联合过滤 / symbol whitelist, ANDed with selected_categories
    selected_symbols: list[str] = Field(default_factory=list)
    # 事件类通知白名单：order_filled / order_rejected / auto_manage / bridge_offline
    # Event-notification whitelist
    event_types: list[str] = Field(default_factory=list)


class NotificationPrefsIn(BaseModel):
    enabled: bool = False
    selected_categories: list[str] = Field(default_factory=list)
    selected_symbols: list[str] = Field(default_factory=list)
    event_types: list[str] = Field(default_factory=list)


def _get_or_create_pref(db: Session, user_id: str) -> NotificationPref:
    pref = db.query(NotificationPref).filter(NotificationPref.user_id == user_id).first()
    if not pref:
        pref = NotificationPref(user_id=user_id)
        db.add(pref)
        db.flush()
    return pref


@router.get("/prefs", response_model=NotificationPrefsOut)
def get_prefs(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    pref = _get_or_create_pref(db, current_user.id)
    cats = []
    try:
        cats = json.loads(pref.selected_categories or "[]")
    except (json.JSONDecodeError, TypeError):
        cats = []
    syms = []
    try:
        syms = json.loads(pref.selected_symbols or "[]")
    except (json.JSONDecodeError, TypeError):
        syms = []
    events = []
    try:
        events = json.loads(pref.event_types or "[]")
    except (json.JSONDecodeError, TypeError):
        events = []
    return NotificationPrefsOut(
        enabled=pref.enabled, selected_categories=cats, selected_symbols=syms, event_types=events
    )


@router.put("/prefs", response_model=NotificationPrefsOut)
def put_prefs(
    body: NotificationPrefsIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    # 开启通知需要非 FREE 等级；关闭则任何等级都放行，避免降级用户被锁在"开"状态。
    # Turning notifications on requires a non-FREE plan; turning off is always
    # allowed so a downgraded user isn't stuck unable to switch it off.
    if body.enabled and not can_use_push(current_user.plan):
        raise HTTPException(status_code=403, detail="免费版不支持通知推送，请升级解锁 / Free tier doesn't include push notifications; upgrade to unlock")
    # 过滤掉未知事件类型，防止前端传了旧值/脏数据 / drop unknown event types (stale/bad client data)
    events = [e for e in body.event_types if e in EVENT_TYPES]
    pref = _get_or_create_pref(db, current_user.id)
    pref.enabled = body.enabled
    pref.selected_categories = json.dumps(body.selected_categories, ensure_ascii=False)
    pref.selected_symbols = json.dumps(body.selected_symbols, ensure_ascii=False)
    pref.event_types = json.dumps(events, ensure_ascii=False)
    db.commit()
    return NotificationPrefsOut(
        enabled=pref.enabled,
        selected_categories=body.selected_categories,
        selected_symbols=body.selected_symbols,
        event_types=events,
    )


# ---- 指标类别列表 / indicator category list ----


@router.get("/indicators")
def list_indicators(
    db: Session = Depends(get_db),
    _current_user: User = Depends(get_current_user),
) -> list[str]:
    """从现有信号中提取去重后的指标类别，供前端通知设置页渲染开关。"""
    rows = db.query(Signal.indicator).filter(Signal.indicator != None, Signal.indicator != "").distinct().all()
    cats: set[str] = set()
    for (ind,) in rows:
        c = indicator_category(ind)
        if c:
            cats.add(c)
    return sorted(cats)


@router.get("/symbols")
def list_symbols(
    _current_user: User = Depends(get_current_user),
) -> list[str]:
    """当前活跃品种，供前端通知设置页渲染品种筛选——与英雄卡/报价表/图表选择器
    同一份数据源（EA 正在推送的品种），不是历史信号里出现过的所有品种。这两者
    有实质差别：signals 表会永久累积每个出现过的品种，其中可能包含 EA 早已
    不再配置、纯属历史/测试数据的品种（比如改过 InpSymbols 之前留下的行），
    选这份列表会让品种筛选里堆满 EA 根本不会再推的品种。

    Currently active symbols, for the notification settings' symbol filter —
    the same data source as the hero card/quotes table/chart symbol picker
    (whatever the EA is actively pushing), not every symbol that has ever
    appeared in signal history. The two meaningfully differ: the signals
    table accumulates every symbol forever, including ones the EA no longer
    configures at all (e.g. left over from before InpSymbols was changed, or
    test data) — using that as the source would clutter the filter with
    symbols the EA will never push again.
    """
    return sorted(quotes_store.get_active_symbols())


# ---- 推送订阅 / Push subscriptions ----


class PushSubscribeIn(BaseModel):
    # 长度上限防止塞入超大字符串占用存储 / length caps guard against oversized blobs
    endpoint: str = Field(min_length=1, max_length=1024)
    keys: dict


@router.post("/push/subscribe")
def push_subscribe(
    body: PushSubscribeIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if not can_use_push(current_user.plan):
        raise HTTPException(status_code=403, detail="免费版不支持通知推送，请升级解锁 / Free tier doesn't include push notifications; upgrade to unlock")
    keys = body.keys or {}
    p256dh = keys.get("p256dh", "")
    auth = keys.get("auth", "")
    if not p256dh or not auth:
        raise HTTPException(status_code=400, detail="缺少 p256dh 或 auth 密钥 / missing p256dh or auth key")
    # Web Push 密钥是短的 base64 值（p256dh 65 字节、auth 16 字节），远小于此。
    # 超长一律拒绝，防止把任意大字符串塞进订阅表。
    # Web Push keys are short base64 values (p256dh 65 bytes, auth 16 bytes),
    # far below this cap; reject anything longer to keep oversized strings out.
    if not isinstance(p256dh, str) or not isinstance(auth, str) or len(p256dh) > 256 or len(auth) > 256:
        raise HTTPException(status_code=400, detail="p256dh 或 auth 密钥格式无效 / invalid p256dh or auth key")

    existing = (
        db.query(PushSubscription)
        .filter(
            PushSubscription.user_id == current_user.id,
            PushSubscription.endpoint == body.endpoint,
        )
        .first()
    )
    if existing:
        existing.keys_p256dh = p256dh
        existing.keys_auth = auth
    else:
        db.add(
            PushSubscription(
                user_id=current_user.id,
                endpoint=body.endpoint,
                keys_p256dh=p256dh,
                keys_auth=auth,
            )
        )
    db.commit()
    return {"ok": True}


@router.post("/push/unsubscribe")
def push_unsubscribe(
    body: PushSubscribeIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    db.query(PushSubscription).filter(
        PushSubscription.user_id == current_user.id,
        PushSubscription.endpoint == body.endpoint,
    ).delete()
    db.commit()
    return {"ok": True}


@router.get("/push/vapid-public-key")
def vapid_public_key():
    """前端注册 Service Worker 订阅时需要 / needed by frontend to subscribe the SW."""
    if not settings.VAPID_PUBLIC_KEY:
        raise HTTPException(status_code=500, detail="VAPID public key not configured")
    return {"publicKey": settings.VAPID_PUBLIC_KEY}
