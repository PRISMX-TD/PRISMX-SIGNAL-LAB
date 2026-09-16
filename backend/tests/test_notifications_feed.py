"""站内通知（铃铛面板的「消息」段）、一键已读、公告弹窗。

三件事互相独立，但共用同一条前提：**用户看到的是一个「通知」面板**。所以这里重点
验的是跨系统的那几处——一键已读必须同时清掉公告与站内通知，但**不能**顺手把一个还
没看过的活动弹窗关掉（两种已读在 announcement_reads.source 上分开）；弹窗要同时尊重
「打开过详情」与「7 天不再提醒」；工单的站内通知必须与回复同一个事务，不能跟着系统
推送一起失败。

In-app notifications, mark-all-read and the announcement popup. Three separate
features sharing one premise — the user sees a single "notifications" panel — so
the cases that matter are the cross-cutting ones: mark-all-read clears both sides
but must *not* retire a campaign popup nobody looked at (the two kinds of read are
split by announcement_reads.source), the popup honours both "opened the detail"
and "snoozed", and a ticket's in-app row rides the reply's transaction rather than
failing with the tray push.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.models import (
    Announcement,
    AnnouncementPopupSnooze,
    AnnouncementRead,
    Ticket,
    User,
    UserNotification,
)
from app.routers.announcements import get_announcement, get_popup_announcement, snooze_popup
from app.routers.notifications import mark_all_read, mark_notification_read, notification_feed
from app.routers.tickets import admin_reply_to_ticket, create_ticket
from app.schemas import AdminTicketReplyCreate, AnnouncementIn, TicketCreate


@pytest.fixture(autouse=True)
def _no_real_push(monkeypatch):
    """工单回复里那条系统推送会自己开一个 SessionLocal 打到开发机的真库上；WS 下发
    在没有事件循环时会退回 asyncio.run。本文件验的是站内那一行，两者都拦掉。
    The tray push inside the ticket reply opens its own SessionLocal against the
    developer's real database, and the WS signal falls back to asyncio.run with no
    loop around. These cases are about the in-app row; stub both out."""
    import app.services.push_dispatch as pd

    monkeypatch.setattr(pd, "dispatch_ticket_reply", lambda *a, **k: None)
    import app.routers.tickets as tk

    monkeypatch.setattr(tk, "notify_ws", lambda *a, **k: None)


def _boom(*_a, **_k):
    raise RuntimeError("push path is down")


def _user(db, email="u@x.com", role="user"):
    u = User(email=email, api_token=f"tok_{email}", role=role)
    db.add(u)
    db.commit()
    return u


def _ticket(db, owner, title="登录不上"):
    t = Ticket(user_id=owner.id, title=title, category="technical", priority="normal", status="open")
    db.add(t)
    db.commit()
    return t


def _ann(db, *, published=True, popup=False, cover="https://img/x.png", title="活动", when=None):
    a = Announcement(
        title_zh=title,
        title_en=title,
        summary_zh="",
        summary_en="",
        blocks="[]",
        cover_image_url=cover,
        pinned=False,
        published=published,
        popup=popup,
        published_at=when or datetime.now(timezone.utc),
    )
    db.add(a)
    db.commit()
    return a


# ---------- 管理员回复 → 提交者的站内通知 ----------


def test_admin_reply_creates_in_app_notification(db_session):
    owner = _user(db_session, "owner@x.com")
    admin = _user(db_session, "a@x.com", role="admin")
    ticket = _ticket(db_session, owner)

    admin_reply_to_ticket(ticket.id, AdminTicketReplyCreate(body="已处理"), db_session, admin)

    rows = db_session.query(UserNotification).filter(UserNotification.user_id == owner.id).all()
    assert len(rows) == 1
    assert rows[0].kind == "ticket_reply"
    # 文案不入库，只存「哪张工单」——标题由前端按 kind 取 i18n。
    assert rows[0].text == "登录不上"
    assert rows[0].link == f"/support?ticket={ticket.id}"
    assert rows[0].read_at is None


def test_admin_replying_to_own_ticket_notifies_nobody(db_session):
    """管理员自己提的工单自己回，不该收到一条「有人回复了你」。"""
    admin = _user(db_session, "a@x.com", role="admin")
    ticket = _ticket(db_session, admin)

    admin_reply_to_ticket(ticket.id, AdminTicketReplyCreate(body="自查记录"), db_session, admin)

    assert db_session.query(UserNotification).count() == 0


def test_in_app_row_survives_a_broken_push_path(db_session, monkeypatch):
    """系统推送整条炸掉时，站内那一行仍要在——它是用户唯一保证看得到的痕迹。"""
    import app.services.push_dispatch as pd

    monkeypatch.setattr(pd, "dispatch_ticket_reply", _boom)
    owner = _user(db_session, "owner@x.com")
    admin = _user(db_session, "a@x.com", role="admin")
    ticket = _ticket(db_session, owner)

    admin_reply_to_ticket(ticket.id, AdminTicketReplyCreate(body="已处理"), db_session, admin)

    assert db_session.query(UserNotification).filter(UserNotification.user_id == owner.id).count() == 1


# ---------- 新工单 → 每位管理员的站内通知 ----------


def test_new_ticket_notifies_every_admin(db_session):
    submitter = _user(db_session, "u@x.com")
    a1 = _user(db_session, "a1@x.com", role="admin")
    a2 = _user(db_session, "a2@x.com", role="admin")

    out = create_ticket(
        TicketCreate(title="出金没到账", category="payment", body="三天了"),
        db_session,
        submitter,
    )

    rows = db_session.query(UserNotification).all()
    assert {r.user_id for r in rows} == {a1.id, a2.id}
    assert {r.kind for r in rows} == {"ticket_new"}
    assert {r.text for r in rows} == {"出金没到账"}
    assert all(r.link == f"/admin?tab=tickets&ticket={out.id}" for r in rows)


def test_new_ticket_does_not_notify_the_submitter(db_session):
    """普通用户提工单，自己不该在铃铛里收到自己那一条。"""
    submitter = _user(db_session, "u@x.com")
    _user(db_session, "a@x.com", role="admin")

    create_ticket(TicketCreate(title="x", category="technical", body="y"), db_session, submitter)

    assert db_session.query(UserNotification).filter(
        UserNotification.user_id == submitter.id
    ).count() == 0


def test_admin_submitting_a_ticket_is_not_notified_of_it(db_session):
    """提交者本人是管理员时，只有另一位管理员收到。"""
    admin_submitter = _user(db_session, "a1@x.com", role="admin")
    other_admin = _user(db_session, "a2@x.com", role="admin")

    create_ticket(TicketCreate(title="x", category="technical", body="y"), db_session, admin_submitter)

    rows = db_session.query(UserNotification).all()
    assert [r.user_id for r in rows] == [other_admin.id]


def test_new_ticket_works_with_no_admins_at_all(db_session):
    """全新部署还没设管理员时，提工单不该炸。"""
    submitter = _user(db_session, "u@x.com")

    create_ticket(TicketCreate(title="x", category="technical", body="y"), db_session, submitter)

    assert db_session.query(UserNotification).count() == 0
    assert db_session.query(Ticket).count() == 1


# ---------- feed 读取与已读 ----------


def test_feed_is_newest_first_and_counts_all_unread(db_session):
    u = _user(db_session)
    base = datetime.now(timezone.utc)
    for i in range(3):
        db_session.add(
            UserNotification(
                user_id=u.id,
                kind="ticket_reply",
                text=f"t{i}",
                link="/support",
                created_at=base + timedelta(minutes=i),
            )
        )
    db_session.commit()

    out = notification_feed(limit=2, db=db_session, current_user=u)
    assert [i.text for i in out.items] == ["t2", "t1"]
    # 分页只影响 items，角标数的是全部未读
    assert out.unreadCount == 3


def test_feed_only_returns_own_rows(db_session):
    me = _user(db_session, "me@x.com")
    other = _user(db_session, "other@x.com")
    db_session.add(UserNotification(user_id=other.id, kind="ticket_reply", text="别人的"))
    db_session.commit()

    out = notification_feed(limit=20, db=db_session, current_user=me)
    assert out.items == []
    assert out.unreadCount == 0


def test_mark_read_is_idempotent_and_tolerates_unknown_id(db_session):
    u = _user(db_session)
    row = UserNotification(user_id=u.id, kind="ticket_reply", text="x")
    db_session.add(row)
    db_session.commit()

    mark_notification_read(row.id, db_session, u)
    first = db_session.get(UserNotification, row.id).read_at
    assert first is not None
    mark_notification_read(row.id, db_session, u)
    assert db_session.get(UserNotification, row.id).read_at == first
    # 不存在的 id 当已读处理，不抛
    mark_notification_read("no-such-id", db_session, u)


def test_mark_read_cannot_touch_someone_elses_row(db_session):
    me = _user(db_session, "me@x.com")
    other = _user(db_session, "other@x.com")
    row = UserNotification(user_id=other.id, kind="ticket_reply", text="x")
    db_session.add(row)
    db_session.commit()

    mark_notification_read(row.id, db_session, me)

    assert db_session.get(UserNotification, row.id).read_at is None


# ---------- 一键已读 ----------


def test_read_all_never_downgrades_an_opened_row(db_session):
    """已经真读过的公告，再按一次全部已读不该把 source 打回 read_all——
    那会让一条读过的公告重新具备弹窗资格。"""
    u = _user(db_session)
    a = _ann(db_session, popup=True)
    get_announcement(a.id, db_session, u)

    mark_all_read(db_session, u)

    assert db_session.query(AnnouncementRead).one().source == "open"
    assert get_popup_announcement(db_session, u) is None


def test_read_all_clears_both_sides(db_session):
    u = _user(db_session)
    db_session.add(UserNotification(user_id=u.id, kind="ticket_reply", text="x"))
    a1 = _ann(db_session, title="a1")
    a2 = _ann(db_session, title="a2")
    db_session.commit()

    out = mark_all_read(db_session, u)

    assert out.notifications == 1
    assert out.announcements == 2
    assert notification_feed(limit=20, db=db_session, current_user=u).unreadCount == 0
    read_ids = {r.announcement_id for r in db_session.query(AnnouncementRead).all()}
    assert read_ids == {a1.id, a2.id}


def test_read_all_skips_drafts(db_session):
    """草稿对用户不存在。给它写已读行，将来发布时它一出生就是已读——等于没发。"""
    u = _user(db_session)
    draft = _ann(db_session, published=False, title="草稿")
    _ann(db_session, title="已发布")

    out = mark_all_read(db_session, u)

    assert out.announcements == 1
    assert (
        db_session.query(AnnouncementRead)
        .filter(AnnouncementRead.announcement_id == draft.id)
        .count()
        == 0
    )


def test_read_all_does_not_duplicate_existing_read_rows(db_session):
    u = _user(db_session)
    a = _ann(db_session)
    db_session.add(AnnouncementRead(user_id=u.id, announcement_id=a.id))
    db_session.commit()

    out = mark_all_read(db_session, u)

    assert out.announcements == 0
    assert db_session.query(AnnouncementRead).count() == 1


def test_read_all_leaves_other_users_alone(db_session):
    me = _user(db_session, "me@x.com")
    other = _user(db_session, "other@x.com")
    db_session.add(UserNotification(user_id=other.id, kind="ticket_reply", text="x"))
    _ann(db_session)

    mark_all_read(db_session, me)

    assert notification_feed(limit=20, db=db_session, current_user=other).unreadCount == 1
    assert db_session.query(AnnouncementRead).filter(AnnouncementRead.user_id == other.id).count() == 0


# ---------- 公告弹窗 ----------


def test_popup_requires_published_popup_and_cover(db_session):
    u = _user(db_session)
    _ann(db_session, popup=False)  # 没开弹窗
    _ann(db_session, popup=True, published=False)  # 没发布
    _ann(db_session, popup=True, cover="")  # 没图——弹窗主体就是那张图
    assert get_popup_announcement(db_session, u) is None

    ok = _ann(db_session, popup=True, title="大促")
    got = get_popup_announcement(db_session, u)
    assert got is not None and got.id == ok.id
    assert got.coverImageUrl == "https://img/x.png"


def test_popup_picks_the_newest_candidate(db_session):
    u = _user(db_session)
    now = datetime.now(timezone.utc)
    _ann(db_session, popup=True, title="旧", when=now - timedelta(days=3))
    newer = _ann(db_session, popup=True, title="新", when=now - timedelta(hours=1))

    got = get_popup_announcement(db_session, u)
    assert got is not None and got.id == newer.id


def test_popup_stops_once_the_detail_is_opened(db_session):
    """打开过详情就不再弹：弹窗的目的是把人带过去，人已经去过了。"""
    u = _user(db_session)
    a = _ann(db_session, popup=True)

    get_announcement(a.id, db_session, u)

    assert db_session.query(AnnouncementRead).one().source == "open"
    assert get_popup_announcement(db_session, u) is None


def test_read_all_does_not_retire_the_popup(db_session):
    """「全部已读」是为了清角标，不是「我看过了」。按一下不该把一个还没看过的
    活动弹窗永久关掉——这两种已读在 announcement_reads.source 上是分开的。"""
    u = _user(db_session)
    a = _ann(db_session, popup=True)

    out = mark_all_read(db_session, u)

    # 角标确实清了：公告在铃铛/列表里算已读
    assert out.announcements == 1
    assert db_session.query(AnnouncementRead).one().source == "read_all"
    # 但弹窗还在
    got = get_popup_announcement(db_session, u)
    assert got is not None and got.id == a.id


def test_opening_after_read_all_upgrades_the_row_and_retires_the_popup(db_session):
    """先按全部已读、后来真的点进去了：已读行只有一行，不能因为行已经存在就把
    「真读了」丢掉——丢了的话这条公告会一直弹下去。"""
    u = _user(db_session)
    a = _ann(db_session, popup=True)
    mark_all_read(db_session, u)

    get_announcement(a.id, db_session, u)

    rows = db_session.query(AnnouncementRead).all()
    assert len(rows) == 1 and rows[0].source == "open"
    assert get_popup_announcement(db_session, u) is None


def test_snooze_silences_for_seven_days_then_re_arms(db_session):
    u = _user(db_session)
    a = _ann(db_session, popup=True)

    snooze_popup(a.id, db_session, u)
    assert get_popup_announcement(db_session, u) is None

    row = db_session.query(AnnouncementPopupSnooze).one()
    delta = row.snooze_until.replace(tzinfo=timezone.utc) - datetime.now(timezone.utc)
    assert timedelta(days=6, hours=23) < delta <= timedelta(days=7)

    # 到期后自动重新弹，不需要任何清理任务
    row.snooze_until = datetime.now(timezone.utc) - timedelta(minutes=1)
    db_session.commit()
    assert get_popup_announcement(db_session, u) is not None


def test_snooze_is_per_user(db_session):
    """按掉的是自己的弹窗，不是别人的。"""
    me = _user(db_session, "me@x.com")
    other = _user(db_session, "other@x.com")
    a = _ann(db_session, popup=True)

    snooze_popup(a.id, db_session, me)

    assert get_popup_announcement(db_session, me) is None
    assert get_popup_announcement(db_session, other) is not None


def test_snooze_twice_pushes_the_expiry_out_without_a_second_row(db_session):
    u = _user(db_session)
    a = _ann(db_session, popup=True)

    snooze_popup(a.id, db_session, u)
    row = db_session.query(AnnouncementPopupSnooze).one()
    row.snooze_until = datetime.now(timezone.utc) + timedelta(days=1)
    db_session.commit()

    snooze_popup(a.id, db_session, u)

    rows = db_session.query(AnnouncementPopupSnooze).all()
    assert len(rows) == 1
    assert rows[0].snooze_until.replace(tzinfo=timezone.utc) > datetime.now(timezone.utc) + timedelta(days=6)


def test_popup_without_cover_is_normalised_at_the_schema():
    """「勾了弹窗但没传图」在入库前就归一成 False，库里的值本身就是真话——管理页
    重新打开时看到的开关与实际行为一致。"""
    assert AnnouncementIn(titleZh="x", coverImageUrl="", popup=True, published=True).popup is False
    assert (
        AnnouncementIn(titleZh="x", coverImageUrl="https://i/x.png", popup=True, published=True).popup
        is True
    )
