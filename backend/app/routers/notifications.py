"""通知路由：偏好、指标类别列表、推送订阅、VAPID 公钥，以及铃铛面板里的站内通知。

站内通知（feed）与公告是铃铛面板的两段：公告是发给所有人的内容（自己一张表、
自带详情页），feed 是发生在这个用户身上的事（目前只有工单回复）。「一键已读」
要同时清掉两边，所以 read-all 放在这里而不是公告路由里——按下按钮的人看到的是
一个「通知」面板，不是两套东西。

Notification router: prefs, indicator categories, push subscriptions, the VAPID
key, and the bell panel's in-app feed. The panel has two sections: announcements
(platform-wide content with its own table and detail pages) and the feed (things
that happened to this user — currently only ticket replies). Mark-all-read has to
clear both, which is why it lives here rather than in the announcements router:
what the user pressed the button on is one "notifications" panel, not two systems.
"""
import json
import re
from datetime import datetime, timezone
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.config import settings
from app.core.database import get_db
from app.core.rate_limit import limiter
from app.models import (
    Announcement,
    AnnouncementRead,
    NotificationPref,
    PushSubscription,
    Signal,
    User,
    UserNotification,
)
from app.schemas import NotificationFeedItem, NotificationFeedOut, ReadAllOut
from app.services import quotes_store
from app.services.deps import get_current_user
from app.services.plans import can_use_push
from app.utils.indicator import indicator_category
from app.services.push_dispatch import (
    EVENT_TYPES,
    FCM_PLACEHOLDER_KEY,
    FCM_SCHEME,
    _parse_event_types,
    dispatch_test_push,
    is_allowed_push_endpoint,
    is_fcm_endpoint,
)

router = APIRouter(prefix="/notifications", tags=["notifications"])

# 白名单里单个条目的长度上限。指标类别与品种代码都是十几个字符量级；卡住它是为了
# 不让 64 个条目各自带上几 KB，把上面那条"最多 64 个"绕过去。
# Per-item length cap for the whitelists: categories and symbol codes run to a
# dozen characters, and bounding them stops 64 multi-kilobyte items from walking
# around the item-count cap.
_PrefItem = Annotated[str, Field(max_length=64)]

# 每个用户最多保留多少条推送订阅。一条订阅 = 一台设备上的一个浏览器/一个 App
# 安装，正常人手里最多三五台；20 是给"换过几台设备、重装过几次浏览器"留的余量。
# 没有上限时，脚本可以注册上千条，而**每一条信号派发都要逐条 _send_one 一次真实
# 的网络请求**——那不是存储问题，是让一个用户就能把派发线程拖到几分钟一轮。
# 超出时淘汰最旧的：新订阅一定是当前这台设备，留着它比留一条几个月前的死订阅
# 有意义（死订阅本来也会在派发失败时被清理，只是时机不定）。
# Cap on stored push subscriptions per user. One row is one browser or app
# install; a real person has a handful, and 20 leaves room for replaced devices
# and reinstalls. Uncapped, a script can register thousands — and every signal
# dispatch makes one real HTTP request per row, so a single user could stretch a
# dispatch pass into minutes. Over the cap the oldest rows go: the new one is the
# device in the user's hand, which beats keeping a months-dead endpoint.
MAX_PUSH_SUBSCRIPTIONS_PER_USER = 20

# ---- 通知偏好 / Notification prefs ----


class NotificationPrefsOut(BaseModel):
    enabled: bool
    selected_categories: list[str]  # 信号指标类别白名单 / signal indicator-category whitelist
    # 品种白名单，与 selected_categories 按"与"关系联合过滤 / symbol whitelist, ANDed with selected_categories
    selected_symbols: list[str] = Field(default_factory=list)
    # 事件类通知白名单：order_filled / order_rejected / auto_manage /
    # bridge_offline / strategy_signal。库里为 NULL（从未配置）时返回全集——
    # 这些提醒默认开启。/ Event-notification whitelist; a NULL column (never
    # configured) returns the full set — these alerts default to on.
    event_types: list[str] = Field(default_factory=list)
    # 推送时段（用户本地 "HH:MM"），两者都设置才生效；null = 不限制。
    # Push window (user-local "HH:MM"); active only when both set, null = no limit.
    push_window_start: str | None = None
    push_window_end: str | None = None
    push_window_tz: str | None = None


class NotificationPrefsIn(BaseModel):
    enabled: bool = False
    # 两个白名单都卡长度与元素长度。它们整份序列化成 JSON 存在
    # notification_prefs 的一列里，而**每一条信号派发都要把它读出来解析一遍**
    # （push_dispatch 按类别/品种过滤），所以这一列撑大不只是占存储，是给每次
    # 派发都加一次大字段读 + JSON 解析。上限取现实值的数倍：指标类别与活跃品种
    # 都只有几十个量级，64 足够，同时把"塞进上千个 UUID"挡在外面。
    # event_types 不限长——它在写入前就被 EVENT_TYPES 过滤成已知值了（见
    # put_prefs），上限由那个集合本身给出。
    # Both whitelists are bounded in length and element size. They are serialized
    # into one column that every signal dispatch reads and parses to filter by
    # category/symbol, so an inflated list costs a wide read plus a JSON parse on
    # every push, not just disk. The caps are multiples of reality (categories
    # and active symbols number in the dozens) while ruling out a thousand UUIDs.
    # event_types needs no cap: put_prefs filters it against EVENT_TYPES first,
    # so that set is its bound.
    selected_categories: list[_PrefItem] = Field(default_factory=list, max_length=64)
    selected_symbols: list[_PrefItem] = Field(default_factory=list, max_length=64)
    event_types: list[str] = Field(default_factory=list)
    # 时段三项是可选字段：请求里不带 = 不改动（老版本前端/快捷开关不会把已存
    # 的时段清掉），显式传 null = 清除限制。
    # The window fields are optional: absent from the request = leave stored
    # values untouched (an older frontend or the quick toggle won't wipe a
    # saved window), explicit null = clear the restriction.
    push_window_start: str | None = None
    push_window_end: str | None = None
    push_window_tz: str | None = None


_HHMM_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _validate_push_window(body: "NotificationPrefsIn") -> None:
    """校验时段字段：时间必须是 "HH:MM"，时区必须是合法 IANA 名称。只校验
    请求里实际出现的字段。/ Validate window fields — times must be "HH:MM",
    the timezone a valid IANA name. Only fields present in the request are
    checked."""
    for field in ("push_window_start", "push_window_end"):
        if field in body.model_fields_set:
            v = getattr(body, field)
            if v is not None and not _HHMM_RE.match(v):
                raise HTTPException(status_code=400, detail="推送时段格式应为 HH:MM / push window must be HH:MM")
    if "push_window_tz" in body.model_fields_set and body.push_window_tz is not None:
        if len(body.push_window_tz) > 64:
            raise HTTPException(status_code=400, detail="时区名称无效 / invalid timezone")
        try:
            ZoneInfo(body.push_window_tz)
        except Exception:
            raise HTTPException(status_code=400, detail="时区名称无效 / invalid timezone")


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
    # NULL（从未配置）→ 全部事件默认开启；派发侧 _parse_event_types 同一套语义。
    # 账户 / 交易 / 成就事件派发时不看这份白名单（push_dispatch.ALWAYS_ON_EVENTS），
    # 这里返回的列表只对 strategy_signal 有实际意义。
    # NULL (never configured) → all events on; the dispatch side shares this via
    # _parse_event_types. Account/trading/badge events bypass the whitelist at
    # dispatch (push_dispatch.ALWAYS_ON_EVENTS); only strategy_signal is
    # effectively governed by the list returned here.
    events = sorted(_parse_event_types(pref.event_types))
    return NotificationPrefsOut(
        enabled=pref.enabled,
        selected_categories=cats,
        selected_symbols=syms,
        event_types=events,
        push_window_start=pref.push_window_start,
        push_window_end=pref.push_window_end,
        push_window_tz=pref.push_window_tz,
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
    _validate_push_window(body)
    # 过滤掉未知事件类型，防止前端传了旧值/脏数据 / drop unknown event types (stale/bad client data)
    events = [e for e in body.event_types if e in EVENT_TYPES]
    pref = _get_or_create_pref(db, current_user.id)
    pref.enabled = body.enabled
    pref.selected_categories = json.dumps(body.selected_categories, ensure_ascii=False)
    pref.selected_symbols = json.dumps(body.selected_symbols, ensure_ascii=False)
    pref.event_types = json.dumps(events, ensure_ascii=False)
    # 时段字段：只在请求里出现时才写入（含显式 null = 清除），否则保留原值——
    # PUT 对其余字段是整体覆盖，但时段还有铃铛快捷开关这类不带它的调用方。
    # Window fields: written only when present in the request (explicit null =
    # clear), otherwise kept — the PUT overwrites everything else wholesale,
    # but callers like the bell quick-toggle don't carry the window.
    for field in ("push_window_start", "push_window_end", "push_window_tz"):
        if field in body.model_fields_set:
            setattr(pref, field, getattr(body, field))
    db.commit()
    return NotificationPrefsOut(
        enabled=pref.enabled,
        selected_categories=body.selected_categories,
        selected_symbols=body.selected_symbols,
        event_types=events,
        push_window_start=pref.push_window_start,
        push_window_end=pref.push_window_end,
        push_window_tz=pref.push_window_tz,
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
    # endpoint 决定了服务端稍后会向哪个地址发起 HTTP 请求，必须限定在已知推送服务
    # 上，否则这张订阅表就成了「让服务端替我访问任意 URL」的登记处（SSRF）。
    # 详见 push_dispatch.is_allowed_push_endpoint 的说明。
    # The endpoint decides where the server will later send an HTTP request, so it
    # has to be confined to known push services — otherwise this table becomes a
    # registry of "URLs I'd like the server to fetch for me" (SSRF). See
    # push_dispatch.is_allowed_push_endpoint.
    if body.endpoint.startswith(FCM_SCHEME):
        # App 端订阅（安卓 Capacitor WebView 里没有 Web Push）：endpoint 是
        # fcm://<注册令牌>，服务端派发时走 FCM HTTP v1，**不会**对它发起任何
        # HTTP 请求，因此不经过上面那条防 SSRF 的域名白名单（见
        # push_dispatch 里 is_fcm_endpoint 上方的说明）。
        #
        # 占位密钥必须严格等于字面量：这两个字段在 FCM 路径上没有用处，只用来
        # 确认这条订阅确实出自 App 桥接。放松成"随便填"会让 fcm:// 变成一条绕过
        # 密钥校验的旁路。
        #
        # App-side subscription (the Android Capacitor WebView has no Web Push):
        # the endpoint is fcm://<registration token>, dispatched over FCM HTTP
        # v1, and never fetched — so it doesn't go through the anti-SSRF host
        # allowlist above (see the note above is_fcm_endpoint). The placeholder
        # keys must match exactly: they're useless on the FCM path and serve
        # only to confirm the row came from the app bridge; accepting anything
        # would turn fcm:// into a way around key validation.
        if not is_fcm_endpoint(body.endpoint):
            raise HTTPException(
                status_code=400,
                detail="订阅地址不是已知的推送服务 / subscription endpoint is not a known push service",
            )
        if p256dh != FCM_PLACEHOLDER_KEY or auth != FCM_PLACEHOLDER_KEY:
            raise HTTPException(
                status_code=400,
                detail="p256dh 或 auth 密钥格式无效 / invalid p256dh or auth key",
            )
    else:
        # 占位密钥只在 fcm:// 上有意义：浏览器签发的 p256dh 是 87 字符的 base64，
        # 永远不会是 "fcm"，所以带占位密钥的 https 订阅只可能是伪造出来的。
        # The placeholders only mean anything on fcm://: a browser's p256dh is
        # 87 base64 characters and never "fcm", so an https subscription
        # carrying them can only be forged.
        if p256dh == FCM_PLACEHOLDER_KEY or auth == FCM_PLACEHOLDER_KEY:
            raise HTTPException(
                status_code=400,
                detail="p256dh 或 auth 密钥格式无效 / invalid p256dh or auth key",
            )
        if not is_allowed_push_endpoint(body.endpoint):
            raise HTTPException(
                status_code=400,
                detail="订阅地址不是已知的推送服务 / subscription endpoint is not a known push service",
            )

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
        # 超出上限就淘汰最旧的几条（见 MAX_PUSH_SUBSCRIPTIONS_PER_USER）。
        # 只在**新增**这一支做：更新一条已有订阅不会让总数变多。
        # 用 flush 而不是先 commit 再删：整件事（新增 + 淘汰）要么一起成，要么
        # 一起不成，不能出现"新的加进去了、旧的没删掉"的中间态。
        # Trim the oldest rows once over the cap, and only on the insert branch —
        # refreshing an existing row doesn't change the count. flush rather than a
        # separate commit so the insert and the eviction land together.
        db.flush()
        _prune_push_subscriptions(db, current_user.id)
    db.commit()
    return {"ok": True}


def _prune_push_subscriptions(db: Session, user_id: str) -> None:
    """把这个用户超出上限的订阅删掉，最旧的先走。

    按 created_at 升序取出"多出来的那几条"再按 id 删，而不是写一条带
    OFFSET 的 DELETE：不同数据库对 DELETE ... LIMIT/OFFSET 的支持不一致
    （SQLite 默认编译就不带），两条查询在这里不值得为之冒方言风险。

    Drop this user's over-quota subscriptions, oldest first. Two queries rather
    than a DELETE with OFFSET, whose support differs across databases (SQLite
    doesn't compile it in by default) for no gain at this size.
    """
    rows = (
        db.query(PushSubscription.id)
        .filter(PushSubscription.user_id == user_id)
        .order_by(PushSubscription.created_at.asc())
        .all()
    )
    excess = len(rows) - MAX_PUSH_SUBSCRIPTIONS_PER_USER
    if excess <= 0:
        return
    doomed = [r[0] for r in rows[:excess]]
    db.query(PushSubscription).filter(PushSubscription.id.in_(doomed)).delete(
        synchronize_session=False
    )


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
    # kind 只说明这台设备走的是哪条通道（App 的 fcm:// 还是网页 Web Push），是
    # 追加字段，老前端不读它也没有任何变化。注意这里回的是通道名而不是 endpoint
    # 本身——FCM 注册令牌等同于一把可以向该设备发推送的钥匙，任何响应与日志里都
    # 不该出现完整令牌。
    # kind names the channel this device uses (the app's fcm:// or browser Web
    # Push). Additive: an older frontend that ignores it sees no change. It
    # deliberately returns the channel, not the endpoint — an FCM registration
    # token is a key to push to that device and belongs in no response or log.
    kind = None
    if endpoint:
        kind = "app" if endpoint.startswith(FCM_SCHEME) else "web"
    return {"count": count, "current_endpoint_registered": registered, "kind": kind}


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

# ---- 站内通知 / in-app notification feed ----


@router.get("/feed", response_model=NotificationFeedOut)
def notification_feed(
    limit: int = 20,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """本人的站内通知，最新在前。unreadCount 数的是全部未读而不是本页未读——
    角标必须在只取 20 条的情况下也报对数。
    This user's notifications, newest first. unreadCount counts every unread row,
    not just the returned page: the badge has to be right while the list is capped.
    """
    limit = max(1, min(limit, 100))
    rows = (
        db.query(UserNotification)
        .filter(UserNotification.user_id == current_user.id)
        .order_by(UserNotification.created_at.desc())
        .limit(limit)
        .all()
    )
    unread = (
        db.query(UserNotification)
        .filter(
            UserNotification.user_id == current_user.id,
            UserNotification.read_at.is_(None),
        )
        .count()
    )
    return NotificationFeedOut(
        items=[
            NotificationFeedItem(
                id=r.id,
                kind=r.kind,
                text=r.text or "",
                link=r.link or "",
                read=r.read_at is not None,
                createdAt=r.created_at,
            )
            for r in rows
        ],
        unreadCount=unread,
    )


@router.post("/feed/{notification_id}/read", response_model=dict)
def mark_notification_read(
    notification_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """点开一条通知即已读。找不到就当已经读过——这个动作在用户眼里是"点了一下
    某条消息"，为一条已被删/不属于自己的 id 回 404 只会让前端多一个没人处理的
    错误分支，而按 user_id 过滤已经保证了读不到别人的行。
    Following a notification marks it read. A miss is treated as already-read: to
    the user this is just "tapped a row", and 404 here would only add an error
    branch nobody handles — the user_id filter already prevents touching someone
    else's row."""
    row = (
        db.query(UserNotification)
        .filter(
            UserNotification.id == notification_id,
            UserNotification.user_id == current_user.id,
        )
        .first()
    )
    if row and row.read_at is None:
        row.read_at = datetime.now(timezone.utc)
        db.commit()
    return {"ok": True}


@router.delete("/feed", response_model=dict)
def clear_notification_feed(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """清空本人的站内通知（铃铛「消息」段）。只删自己的行；公告不受影响。
    Delete all of this user's feed rows (the bell's "messages" section). Only the
    caller's own rows; announcements are untouched."""
    n = (
        db.query(UserNotification)
        .filter(UserNotification.user_id == current_user.id)
        .delete(synchronize_session=False)
    )
    db.commit()
    return {"cleared": n}


@router.post("/read-all", response_model=ReadAllOut)
def mark_all_read(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """一键已读：站内通知全部标已读，已发布公告全部补上已读行。

    公告用"补行"而不是"标记"：已读状态本来就是一张 (user, announcement) 关系表，
    没读过就是没有行。只对 published 的公告补——草稿对用户不存在，给它写已读行
    会让它在将来发布时直接是已读状态，那条公告等于没发过。

    补的行记 source="read_all"，与"真打开过详情页"（source="open"）分开。这一按
    是为了清角标，不是"我看过了"：公告弹窗只认 open，所以按一下全部已读不会顺手
    把一个还没看过的活动弹窗永久关掉（见 models.AnnouncementRead）。

    Mark everything read: every feed row gets a timestamp, every published
    announcement gets a read row. Announcements use insertion rather than a flag
    because read state *is* a (user, announcement) relation — unread means no row.
    Only published ones: a draft doesn't exist for users, and marking it read now
    would publish it pre-read, i.e. invisibly.

    Rows are stamped source="read_all", distinct from "actually opened the detail"
    (source="open"). This press clears a badge; it does not mean "I've seen it".
    The announcement popup only honours `open`, so mark-all-read never silently
    retires a campaign popup nobody looked at (see models.AnnouncementRead).
    """
    now = datetime.now(timezone.utc)
    feed_n = (
        db.query(UserNotification)
        .filter(
            UserNotification.user_id == current_user.id,
            UserNotification.read_at.is_(None),
        )
        .update({UserNotification.read_at: now}, synchronize_session=False)
    )
    published_ids = {
        r[0] for r in db.query(Announcement.id).filter(Announcement.published.is_(True)).all()
    }
    already = {
        r[0] for r in db.query(AnnouncementRead.announcement_id)
        .filter(AnnouncementRead.user_id == current_user.id).all()
    }
    missing = published_ids - already
    for aid in missing:
        db.add(AnnouncementRead(user_id=current_user.id, announcement_id=aid, source="read_all"))
    try:
        db.commit()
    except IntegrityError:
        # 同一个人在两处同时按（铃铛 + 公告页），或按的同时另一个标签页打开了详情：
        # (user, announcement) 上的唯一约束会撞。这里要达成的结论——"这些都算读过
        # 了"——已经被另一次写入部分达成，逐行重试把剩下的补上，比让一个「全部已读」
        # 回 500 好。
        # The same person pressing in two places (bell + list page), or opening a
        # detail in another tab at that moment, collides on the (user, announcement)
        # unique constraint. The end state this wants — all of these count as read —
        # is already partly reached by the other write, so retry row by row rather
        # than answering a "mark all read" with a 500.
        db.rollback()
        done = {
            r[0] for r in db.query(AnnouncementRead.announcement_id)
            .filter(AnnouncementRead.user_id == current_user.id).all()
        }
        missing = published_ids - done
        for aid in missing:
            db.add(AnnouncementRead(user_id=current_user.id, announcement_id=aid, source="read_all"))
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
    return ReadAllOut(announcements=len(missing), notifications=feed_n)
