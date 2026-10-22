"""领奖：form 填写 / 修改、ticket 只建一张工单、发放 / 取消通知、本人可见、筛选与导出。
Claims: form submit / edit, one claim ticket per draw, deliver / cancel notifications, owner-only, filter + export."""
import json
from datetime import timedelta

import pytest
from fastapi import HTTPException

from app.models import LuckyDraw, LuckyPrize, LuckyRound, LuckyTicket, Ticket, TicketReply, User, UserNotification
from app.routers import lucky_wheel as router
from app.schemas import LuckyClaimInfoIn, LuckyHandleIn
from app.services.lucky import common


def _user(db, email, **kw):
    u = User(email=email, password_hash="x", api_token=f"tok-{email}", **kw)
    db.add(u)
    db.commit()
    return u


def _draw(db, user, mode, status="pending"):
    admin = db.query(User).filter(User.role == "admin").first()
    r = db.query(LuckyRound).first() or LuckyRound(starts_at=common.utcnow(), ends_at=common.utcnow() + timedelta(days=1),
                                                   created_by=admin.id)
    db.add(r)
    p = LuckyPrize(sort_order=0, name="手表", kind="custom", claim_mode=mode, prob_bp=10000, claim_hint="写地址")
    db.add(p)
    db.flush()
    t = LuckyTicket(user_id=user.id, round_id=r.id, source="manual", status="used")
    db.add(t)
    db.flush()
    d = LuckyDraw(user_id=user.id, round_id=r.id, ticket_id=t.id, prize_id=p.id, request_id=f"r-{t.id}",
                  prize_snapshot=json.dumps({"name": "手表", "kind": "custom", "claimMode": mode}),
                  fulfillment_status=status)
    db.add(d)
    db.commit()
    return d


@pytest.fixture
def people(db_session):
    return db_session, _user(db_session, "admin@t.co", role="admin"), _user(db_session, "u@t.co")


def test_form_claim_submit_and_edit(people):
    db, _a, u = people
    d = _draw(db, u, "form")
    router.user_claim_info(d.id, LuckyClaimInfoIn(text="北京市 xx"), db, u)
    router.user_claim_info(d.id, LuckyClaimInfoIn(text="上海市 yy"), db, u)
    db.refresh(d)
    assert d.claim_info == "上海市 yy" and d.fulfillment_status == "submitted"


def test_form_claim_rejected_for_other_user_or_ticket_mode(people):
    db, _a, u = people
    other = _user(db, "o@t.co")
    d = _draw(db, u, "form")
    with pytest.raises(HTTPException):
        router.user_claim_info(d.id, LuckyClaimInfoIn(text="x"), db, other)
    d2 = _draw(db, u, "ticket")
    with pytest.raises(HTTPException):
        router.user_claim_info(d2.id, LuckyClaimInfoIn(text="x"), db, u)


def test_ticket_claim_creates_one_claim_ticket(people):
    db, admin, u = people
    d = _draw(db, u, "ticket")
    a = router.user_claim_ticket(d.id, db, u)
    b = router.user_claim_ticket(d.id, db, u)
    assert a["ticketId"] == b["ticketId"]
    t = db.get(Ticket, a["ticketId"])
    assert t.category == "claim" and "手表" in t.title and t.user_id == u.id
    assert "手表" in db.query(TicketReply).filter(TicketReply.ticket_id == t.id).one().body
    db.refresh(d)
    assert d.fulfillment_status == "submitted"
    assert db.query(UserNotification).filter(UserNotification.user_id == admin.id).count() == 1


def test_deliver_and_cancel_notify_user(people):
    db, admin, u = people
    d = _draw(db, u, "form", status="submitted")
    router.admin_deliver(d.id, LuckyHandleIn(note="顺丰 SF123"), db, admin)
    db.refresh(d)
    assert d.fulfillment_status == "delivered" and d.admin_note == "顺丰 SF123"
    d2 = _draw(db, u, "form")
    with pytest.raises(HTTPException):
        router.admin_cancel(d2.id, LuckyHandleIn(note=""), db, admin)   # 取消必须写原因
    router.admin_cancel(d2.id, LuckyHandleIn(note="联系不上"), db, admin)
    kinds = sorted(n.kind for n in db.query(UserNotification).filter(UserNotification.user_id == u.id))
    assert kinds == ["lucky_prize_cancelled", "lucky_prize_delivered"]


def test_cannot_handle_twice(people):
    db, admin, u = people
    d = _draw(db, u, "form", status="submitted")
    router.admin_deliver(d.id, LuckyHandleIn(note=""), db, admin)
    with pytest.raises(HTTPException):
        router.admin_cancel(d.id, LuckyHandleIn(note="x"), db, admin)


def test_admin_list_filters_open(people):
    db, admin, u = people
    _draw(db, u, "form", status="pending")
    _draw(db, u, "form", status="delivered")
    # 直接调用时 Query(...) 默认值不会被解析，分页参数要显式传 / Query defaults aren't resolved on a direct call
    out = router.admin_draws(status="open", roundId=None, userId=None, prizeId=None, limit=50, offset=0,
                             db=db, admin=admin)
    assert out["total"] == 1 and out["draws"][0]["user"]["email"] == "u@t.co"


def test_csv_export(people):
    db, admin, u = people
    _draw(db, u, "form", status="pending")
    resp = router.admin_draws_csv(status=None, roundId=None, db=db, admin=admin)
    body = resp.body.decode("utf-8-sig")
    assert "u@t.co" in body and "手表" in body


def test_csv_neutralises_spreadsheet_formulas(people):
    db, admin, u = people
    d = _draw(db, u, "form", status="submitted")
    d.claim_info = "=HYPERLINK(\"http://x\")"
    db.commit()
    body = router.admin_draws_csv(status=None, roundId=None, db=db, admin=admin).body.decode("utf-8-sig")
    assert "'=HYPERLINK" in body
