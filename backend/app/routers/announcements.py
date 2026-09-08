"""公告路由：用户读已发布公告并记已读；管理员增删改、发布、一键翻译。

用户端 GET /announcements 一次返回全部已发布公告（置顶优先、再按发布时间倒序）
并带每条的已读标记与未读总数：公告是低频内容，几十条以内一次取完比分页 + 单独
的未读计数端点简单，铃铛面板与列表页共用同一份。GET /announcements/{id} 顺手写
已读——「打开详情才算读」是与用户确认过的口径。

发布动作在管理端：把 published 由 false 翻到 true 时记 published_at（只记一次），
向在线用户广播 ANNOUNCEMENT_NEW 让铃铛角标实时更新，勾了 notify 再走 Web Push。

Users read published announcements (pinned first, then newest) with per-row read
flags and an unread total in one response; announcements are rare content, so one
fetch shared by the bell panel and the list page beats pagination plus a separate
unread endpoint. Opening a detail marks it read, the agreed definition of "read".
Publishing (false → true) stamps published_at once, broadcasts ANNOUNCEMENT_NEW so
open sessions update their bell badge, and Web Pushes if `notify` was ticked.
"""
import json
import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.core.database import get_db
from app.models import Announcement, AnnouncementRead, User
from app.schemas import (
    AnnouncementBlock,
    AnnouncementIn,
    AnnouncementListOut,
    AnnouncementOut,
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
        pinned=bool(a.pinned), published=bool(a.published),
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
    if a.published and not already:
        db.add(AnnouncementRead(user_id=user.id, announcement_id=a.id))
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
    _require_title(body)
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
