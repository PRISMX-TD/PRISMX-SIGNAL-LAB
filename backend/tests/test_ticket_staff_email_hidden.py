"""工单里管理员的邮箱不给普通用户看：用户端详情、列表预览都回空串；管理端照常给全。
Staff emails on tickets are withheld from regular users (empty string in the
user-facing detail and list preview) while the admin endpoints keep them.
"""
import pytest

from app.models import Ticket, User
from app.routers.tickets import (
    admin_get_ticket,
    admin_reply_to_ticket,
    get_ticket,
    list_all_tickets,
    list_my_tickets,
)
from app.schemas import AdminTicketReplyCreate


@pytest.fixture(autouse=True)
def _no_real_push(monkeypatch):
    import app.services.push_dispatch as pd
    import app.routers.tickets as tk

    monkeypatch.setattr(pd, "dispatch_ticket_reply", lambda *a, **k: None)
    monkeypatch.setattr(tk, "notify_ws", lambda *a, **k: None)


def _user(db, email, role="user"):
    u = User(email=email, api_token=f"tok_{email}", role=role)
    db.add(u)
    db.commit()
    return u


def _setup(db):
    owner = _user(db, "owner@x.com")
    admin = _user(db, "boss@x.com", role="admin")
    t = Ticket(user_id=owner.id, title="怎么推广", category="technical", priority="normal", status="open")
    db.add(t)
    db.commit()
    admin_reply_to_ticket(t.id, AdminTicketReplyCreate(body="请留联系方式"), db, admin)
    return owner, admin, t


def test_user_detail_hides_staff_email(db_session):
    owner, _admin, t = _setup(db_session)
    out = get_ticket(t.id, db_session, owner)
    staff = [r for r in out.replies if r.authorRole == "admin"]
    assert staff and all(r.authorEmail == "" for r in staff)


def test_user_list_preview_hides_staff_email(db_session):
    owner, _admin, _t = _setup(db_session)
    items = list_my_tickets(db_session, owner)
    assert items[0].latestReply.authorRole == "admin"
    assert items[0].latestReply.authorEmail == ""


def test_admin_still_sees_staff_email(db_session):
    _owner, admin, t = _setup(db_session)
    out = admin_get_ticket(t.id, db_session, admin)
    assert any(r.authorEmail == "boss@x.com" for r in out.replies)
    items = list_all_tickets(None, None, 50, 0, db_session, admin)
    assert items[0].latestReply.authorEmail == "boss@x.com"
