"""通知路由：偏好、指标类别列表、推送订阅、VAPID 公钥。
Notification router: prefs, indicator categories, push subscriptions, VAPID key."""
import json

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import NotificationPref, PushSubscription, Signal, User
from app.services import quotes_store
from app.services.deps import get_current_user
from app.services.plans import can_use_push
from app.services.push_dispatch import EVENT_TYPES, dispatch_test_push
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


# ---- 推送诊断 / push diagnostics ----


@router.get("/push/status")
def push_status(
    endpoint: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """本账号的订阅数，以及传入的 endpoint 是否已在库中。

    供前端诊断面板判断"本设备的订阅是否已上报后端"——这与"本设备浏览器里存在
    订阅"是两件事：浏览器有订阅但后端没有，说明上报环节断了；两者都有才说明链路
    通畅。endpoint 省略时该字段返回 False。

    Subscription count for this account plus whether the given endpoint is
    already registered. Lets the diagnostics panel distinguish "this device's
    subscription reached the backend" from "this device's browser has a
    subscription": a browser-side subscription with nothing in the backend means
    the reporting step broke. Absent endpoint → False.
    """
    count = db.query(PushSubscription).filter(PushSubscription.user_id == current_user.id).count()
    registered = False
    if endpoint:
        registered = (
            db.query(PushSubscription)
            .filter(
                PushSubscription.user_id == current_user.id,
                PushSubscription.endpoint == endpoint,
            )
            .first()
            is not None
        )
    return {"count": count, "current_endpoint_registered": registered}


# 能触发真实推送，不限流会变成骚扰工具 / can trigger real pushes; unthrottled it becomes a nuisance tool
@router.post("/push/test")
@limiter.limit("5/minute")
async def push_test(
    request: Request,
    current_user: User = Depends(get_current_user),
):
    """给本账号的所有设备各发一条测试通知，返回 sent/failed/pruned 计数。

    绕过通知偏好与白名单（链路探针，不是业务通知），但保留订阅等级检查。
    不因单个订阅失败返回 5xx：一个用户可能同时有桌面 Chrome 与 iPhone 两个订阅，
    其中一个失效不该让整个诊断动作看起来像"接口挂了"。前端按 failed > 0 提示。

    Send one test notification to every device on this account and return the
    sent/failed/pruned counts. Bypasses prefs and whitelists (pipeline probe,
    not a business notification) but keeps the plan check. A single failing
    subscription does not produce a 5xx: a user may have desktop Chrome and an
    iPhone, and one dead subscription shouldn't make the whole diagnostic look
    like a broken endpoint. The frontend surfaces failed > 0.
    """
    if not can_use_push(current_user.plan):
        raise HTTPException(status_code=403, detail="免费版不支持通知推送，请升级解锁 / Free tier doesn't include push notifications; upgrade to unlock")
    try:
        return await run_in_threadpool(dispatch_test_push, current_user.id)
    except RuntimeError as e:
        if str(e) == "vapid-not-configured":
            raise HTTPException(status_code=503, detail="服务端未配置推送密钥 / server has no push keys configured")
        raise
