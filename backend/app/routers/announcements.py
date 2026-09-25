"""公告路由：用户读已发布公告并记已读；管理员增删改、发布、一键翻译。

用户端 GET /announcements 一次返回全部已发布公告（置顶优先、再按发布时间倒序）
并带每条的已读标记与未读总数：公告是低频内容，几十条以内一次取完比分页 + 单独
的未读计数端点简单，铃铛面板与列表页共用同一份。GET /announcements/{id} 顺手写
已读——「打开详情才算读」是与用户确认过的口径。

发布动作在管理端：把 published 由 false 翻到 true 时记 published_at（只记一次），
向在线用户广播 ANNOUNCEMENT_NEW 让铃铛角标实时更新，勾了 notify 再走 Web Push。

弹窗（popup）是第三种触达：勾了它的公告会在用户端弹一张整图卡片，点图进详情页。
只对填了封面图的公告成立——弹窗主体就是那张图。读过或按了「7 天不再提醒」就不再弹，
两种状态分别记在 announcement_reads 与 announcement_popup_snoozes。

Users read published announcements (pinned first, then newest) with per-row read
flags and an unread total in one response; announcements are rare content, so one
fetch shared by the bell panel and the list page beats pagination plus a separate
unread endpoint. Opening a detail marks it read, the agreed definition of "read".
Publishing (false → true) stamps published_at once, broadcasts ANNOUNCEMENT_NEW so
open sessions update their bell badge, and Web Pushes if `notify` was ticked. The
popup is a third channel: an announcement with it enabled shows its cover image as
a full-card modal linking to the detail page, so it only applies to rows that have
one — the image *is* the popup. Reading it, or pressing "don't remind me for 7
days", stops it; those two states live in announcement_reads and
announcement_popup_snoozes respectively.
"""
import json
import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.database import get_db
from app.models import Announcement, AnnouncementPopupSnooze, AnnouncementRead, User
from app.schemas import (
    AnnouncementBlock,
    AnnouncementIn,
    AnnouncementListOut,
    AnnouncementOut,
    AnnouncementPopupOut,
    TranslateIn,
    TranslateOut,
)
from app.services.audit import log_change
from app.services.connection_manager import manager
from app.services.deps import get_current_user, require_admin
from app.services.push_dispatch import dispatch_announcement_push_async
from app.services.translate import TranslateError, translate_texts

logger = logging.getLogger("prismx.announcements")

router = APIRouter(prefix="/announcements", tags=["announcements"])
admin_router = APIRouter(prefix="/admin/announcements", tags=["admin"])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _blocks_out(raw: str | None) -> list[AnnouncementBlock]:
    """库里的块 JSON → 校验过的块列表；坏数据当空块处理而不是让整页 500。
    Stored block JSON → validated blocks; bad rows render as empty rather than 500."""
    try:
        data = json.loads(raw or "[]")
    except (json.JSONDecodeError, TypeError):
        return []
    out: list[AnnouncementBlock] = []
    for item in data if isinstance(data, list) else []:
        try:
            out.append(AnnouncementBlock(**item))
        except Exception:  # noqa: BLE001 — 单块坏了跳过 / skip one bad block
            continue
    return out


def _to_out(a: Announcement, read: bool = True) -> AnnouncementOut:
    return AnnouncementOut(
        id=a.id,
        titleZh=a.title_zh or "", titleEn=a.title_en or "",
        summaryZh=a.summary_zh or "", summaryEn=a.summary_en or "",
        blocks=_blocks_out(a.blocks),
        coverImageUrl=a.cover_image_url or "",
        pinned=bool(a.pinned), published=bool(a.published), popup=bool(a.popup),
        publishedAt=a.published_at, createdAt=a.created_at, updatedAt=a.updated_at,
        read=read,
    )


def _order_key(a: Announcement):
    # 置顶在前；同组内按发布时间倒序，没发布过的按创建时间。
    # Pinned first; within a group newest publish first, drafts by creation time.
    ts = a.published_at or a.created_at or datetime.min
    return (0 if a.pinned else 1, -ts.timestamp() if isinstance(ts, datetime) else 0)


# ---------- 用户端 / user side ----------

@router.get("", response_model=AnnouncementListOut)
def list_announcements(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    limit: int = Query(default=100, ge=1, le=200),
):
    rows = db.query(Announcement).filter(Announcement.published.is_(True)).all()
    rows.sort(key=_order_key)
    read_ids = {
        r[0] for r in db.query(AnnouncementRead.announcement_id)
        .filter(AnnouncementRead.user_id == user.id).all()
    }
    unread = sum(1 for a in rows if a.id not in read_ids)
    return AnnouncementListOut(
        items=[_to_out(a, read=a.id in read_ids) for a in rows[:limit]],
        unreadCount=unread,
        total=len(rows),
    )


# 这两条必须排在 /{announcement_id} 之前：路由按声明顺序匹配，放在后面的话
# "popup" 会被当成一个公告 id 吃掉，永远 404。
# Both must precede /{announcement_id}: routes match in declaration order, and
# "popup" would otherwise be swallowed as an announcement id and 404 forever.
@router.get("/popup", response_model=AnnouncementPopupOut | None)
def get_popup_announcement(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """当前该给这个用户弹的那条公告，没有则返回 null。

    四道条件：已发布、开了弹窗、有封面图（弹窗主体就是图）、这个用户既没**打开过
    详情页**也没按「7 天不再提醒」。打开过就不再弹是刻意的——弹窗的目的是把人带到
    详情页，人已经去过了就没有理由再拦一次；但「全部已读」不算打开过（见
    AnnouncementRead.source）。多条候选取最新发布的一条：同时弹两张图没有意义，
    晚发的那条也更可能是当下在推的活动。

    The announcement to pop for this user, or null. Four conditions: published,
    popup enabled, has a cover image (the image *is* the popup), and this user has
    neither *opened the detail page* nor snoozed it. "Opened ⇒ never pop" is
    deliberate: the popup exists to send people there and they have been. Pressing
    mark-all-read does not count as opening it (see AnnouncementRead.source). With
    several candidates the newest wins — two modals at once is pointless, and the
    later one is likelier to be the campaign actually running.
    """
    now = datetime.now(timezone.utc)
    # 只认 source == "open" 的已读行。按过「全部已读」（read_all）的人并没有看过
    # 这条公告的内容，那一按是为了清角标，不该顺手把一个还没看过的活动弹窗永久关掉。
    # Only `open` rows count. Someone who pressed mark-all-read has not seen this
    # announcement's content — that press was about clearing a badge, and it should
    # not silently retire a campaign popup they never looked at.
    opened_ids = {
        r[0] for r in db.query(AnnouncementRead.announcement_id)
        .filter(
            AnnouncementRead.user_id == user.id,
            AnnouncementRead.source == "open",
        ).all()
    }
    snoozed_ids = {
        r[0] for r in db.query(AnnouncementPopupSnooze.announcement_id)
        .filter(
            AnnouncementPopupSnooze.user_id == user.id,
            AnnouncementPopupSnooze.snooze_until > now,
        ).all()
    }
    rows = (
        db.query(Announcement)
        .filter(
            Announcement.published.is_(True),
            Announcement.popup.is_(True),
            Announcement.cover_image_url != "",
        )
        .all()
    )
    skip = opened_ids | snoozed_ids
    candidates = [a for a in rows if a.id not in skip]
    if not candidates:
        return None
    candidates.sort(key=lambda a: a.published_at or a.created_at or datetime.min, reverse=True)
    a = candidates[0]
    return AnnouncementPopupOut(
        id=a.id,
        titleZh=a.title_zh or "",
        titleEn=a.title_en or "",
        coverImageUrl=a.cover_image_url or "",
    )


# 免打扰天数写死在服务端：前端传天数就等于把"多久不再提醒"交给客户端决定，
# 一个改过的请求可以把自己静音十年。
# The snooze length lives on the server: letting the client send a number hands
# it control of "how long", and one edited request mutes the popup for a decade.
POPUP_SNOOZE_DAYS = 7


@router.post("/{announcement_id}/popup-snooze", response_model=dict)
def snooze_popup(
    announcement_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """「7 天不再提醒」。记在服务端而不是浏览器：同一个人的手机 App 与网页各
    按一次才安静，本身就是这个弹窗最招人烦的形态。重复按只把到期时间往后推。
    "Don't remind me for 7 days", stored server-side rather than in the browser:
    making someone dismiss the same popup once in the app and again on the web is
    exactly what makes a popup obnoxious. Pressing it again just pushes the
    expiry out."""
    a = db.query(Announcement).filter(Announcement.id == announcement_id).first()
    if not a:
        raise HTTPException(status_code=404, detail="公告不存在 / announcement not found")
    until = datetime.now(timezone.utc) + timedelta(days=POPUP_SNOOZE_DAYS)
    row = (
        db.query(AnnouncementPopupSnooze)
        .filter(
            AnnouncementPopupSnooze.user_id == user.id,
            AnnouncementPopupSnooze.announcement_id == a.id,
        )
        .first()
    )
    if row:
        row.snooze_until = until
    else:
        db.add(AnnouncementPopupSnooze(user_id=user.id, announcement_id=a.id, snooze_until=until))
    db.commit()
    return {"ok": True, "days": POPUP_SNOOZE_DAYS}


@router.get("/{announcement_id}", response_model=AnnouncementOut)
def get_announcement(
    announcement_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    a = db.query(Announcement).filter(Announcement.id == announcement_id).first()
    # 未发布的草稿对普通用户等同不存在；管理员可预览。
    # Drafts don't exist for regular users; admins may preview them.
    if not a or (not a.published and user.role != "admin"):
        raise HTTPException(status_code=404, detail="公告不存在 / announcement not found")
    already = (
        db.query(AnnouncementRead)
        .filter(AnnouncementRead.user_id == user.id, AnnouncementRead.announcement_id == a.id)
        .first()
    )
    if a.published:
        if not already:
            db.add(AnnouncementRead(user_id=user.id, announcement_id=a.id, source="open"))
            db.commit()
        elif already.source != "open":
            # 先按过「全部已读」、现在真的点进来了。已读状态是一行，不能因为行已经
            # 存在就把「真读了」这件事丢掉——丢了的话这条公告的弹窗会一直弹下去。
            # They pressed mark-all-read earlier and have now actually opened it.
            # Read state is one row, and "actually read" must not be lost just
            # because a row exists — losing it keeps this announcement's popup
            # coming back forever.
            already.source = "open"
            db.commit()
    return _to_out(a, read=True)


# ---------- 管理端 / admin side ----------

@admin_router.get("", response_model=AnnouncementListOut)
def admin_list_announcements(db: Session = Depends(get_db), _admin: User = Depends(require_admin)):
    rows = db.query(Announcement).all()
    rows.sort(key=_order_key)
    return AnnouncementListOut(items=[_to_out(a) for a in rows], unreadCount=0, total=len(rows))


def _apply(a: Announcement, body: AnnouncementIn) -> None:
    a.title_zh = body.titleZh.strip()
    a.title_en = body.titleEn.strip()
    a.summary_zh = body.summaryZh.strip()
    a.summary_en = body.summaryEn.strip()
    a.blocks = json.dumps([b.model_dump() for b in body.blocks], ensure_ascii=False)
    a.cover_image_url = body.coverImageUrl
    a.pinned = body.pinned
    # schema 已经把"勾了弹窗但没图"归一成 False，这里照抄即可。
    # The schema already normalises "popup ticked, no image" to False.
    a.popup = body.popup


def _require_title(body: AnnouncementIn) -> None:
    if body.published and not (body.titleZh.strip() or body.titleEn.strip()):
        raise HTTPException(status_code=400, detail="发布前至少填写一种语言的标题 / a title in at least one language is required to publish")


async def _on_published(a: Announcement, notify: bool) -> None:
    """发布副作用：广播给在线用户；勾了推送再发 Web Push。两者都不影响主事务。
    Publish side effects: broadcast to online users; Web Push if ticked. Neither
    touches the main transaction."""
    title = a.title_zh or a.title_en
    try:
        await manager.broadcast_to_clients({
            "type": "ANNOUNCEMENT_NEW",
            "data": {"id": a.id, "titleZh": a.title_zh, "titleEn": a.title_en, "pinned": bool(a.pinned)},
        })
    except Exception:  # noqa: BLE001
        logger.exception("announcement broadcast failed")
    if notify:
        body_text = a.summary_zh or a.summary_en or ""
        await dispatch_announcement_push_async(a.id, f"PRISMX 公告 / Announcement · {title}", body_text)


@admin_router.post("", response_model=AnnouncementOut)
async def admin_create_announcement(
    body: AnnouncementIn,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    # 落库整段是同步 SQLAlchemy，放进线程池：这个端点必须是 async（发布后要 await
    # 广播与推送），而 async 函数里直接查库会卡住整个事件循环。线程池里 refresh 之后
    # 不再 commit，实例的列都已加载，回到事件循环读属性不会再触发查库。
    # The persistence is blocking SQLAlchemy, so it runs in the thread pool: the
    # endpoint has to be async (it awaits the broadcast and push after
    # publishing), and querying inline would stall the event loop. Nothing
    # commits after the refresh, so reading the loaded columns back on the loop
    # never triggers a query.
    _require_title(body)

    def _create_sync() -> Announcement:
        a = Announcement(created_by=admin.id)
        _apply(a, body)
        if body.published:
            a.published = True
            a.published_at = _now()
        db.add(a)
        db.flush()
        log_change(db, admin.id, admin.id, "announcement:create", None, json.dumps({"id": a.id, "published": a.published}, ensure_ascii=False))
        db.commit()
        db.refresh(a)
        return a

    a = await run_in_threadpool(_create_sync)
    if a.published:
        await _on_published(a, body.notify)
    return _to_out(a)


@admin_router.put("/{announcement_id}", response_model=AnnouncementOut)
async def admin_update_announcement(
    announcement_id: str,
    body: AnnouncementIn,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    # 同 admin_create_announcement：查库与落库在线程池里做。
    # Same as admin_create_announcement: the DB work runs in the thread pool.
    def _update_sync() -> tuple[Announcement, bool]:
        a = db.query(Announcement).filter(Announcement.id == announcement_id).first()
        if not a:
            raise HTTPException(status_code=404, detail="公告不存在 / announcement not found")
        _require_title(body)
        was_published = bool(a.published)
        _apply(a, body)
        a.published = body.published
        if body.published and not was_published and a.published_at is None:
            a.published_at = _now()
        log_change(db, admin.id, admin.id, "announcement:update", json.dumps({"published": was_published}), json.dumps({"id": a.id, "published": a.published}, ensure_ascii=False))
        db.commit()
        db.refresh(a)
        return a, was_published

    a, was_published = await run_in_threadpool(_update_sync)
    if a.published and not was_published:
        await _on_published(a, body.notify)
    return _to_out(a)


@admin_router.delete("/{announcement_id}", response_model=dict)
def admin_delete_announcement(
    announcement_id: str,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    a = db.query(Announcement).filter(Announcement.id == announcement_id).first()
    if not a:
        raise HTTPException(status_code=404, detail="公告不存在 / announcement not found")
    db.query(AnnouncementRead).filter(AnnouncementRead.announcement_id == a.id).delete(synchronize_session=False)
    db.query(AnnouncementPopupSnooze).filter(
        AnnouncementPopupSnooze.announcement_id == a.id
    ).delete(synchronize_session=False)
    db.delete(a)
    log_change(db, admin.id, admin.id, "announcement:delete", a.title_zh or a.title_en, None)
    db.commit()
    return {"ok": True}


@admin_router.post("/translate", response_model=TranslateOut)
async def admin_translate(body: TranslateIn, _admin: User = Depends(require_admin)):
    """一键翻译：同步 httpx 调用放线程池，别卡事件循环（与图片上传同一理由）。
    One-click translate: the synchronous httpx call runs in the thread pool so it
    never stalls the event loop (same reasoning as the image upload)."""
    try:
        out = await run_in_threadpool(translate_texts, body.texts, body.target)
    except TranslateError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return TranslateOut(texts=out)


@admin_router.get("/translate/status", response_model=dict)
def admin_translate_status(_admin: User = Depends(require_admin)):
    """前端据此决定翻译按钮是否可用 / lets the panel enable or dim the translate button."""
    from app.services.translate import is_configured
    return {"configured": is_configured()}
