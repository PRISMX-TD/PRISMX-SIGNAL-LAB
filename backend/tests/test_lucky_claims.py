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


def _draw(db, user, mode, status="pending", r=None):
    admin = db.query(User).filter(User.role == "admin").first()
    r = r or db.query(LuckyRound).first() or LuckyRound(
        name="第一期", starts_at=common.utcnow(), ends_at=common.utcnow() + timedelta(days=1), created_by=admin.id)
    db.add(r)
    db.flush()
    p = LuckyPrize(round_id=r.id, sort_order=0, name="手表", kind="custom", claim_mode=mode, prob_bp=10000,
                   claim_hint="写地址")
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
    with pytest.raises(HTTPException) as e:
        router.user_claim_info(d.id, LuckyClaimInfoIn(text="x"), db, other)
    assert e.value.status_code == 404
    d2 = _draw(db, u, "ticket")
    with pytest.raises(HTTPException) as e:
        router.user_claim_info(d2.id, LuckyClaimInfoIn(text="x"), db, u)
    assert e.value.status_code == 400


def test_ticket_claim_creates_one_claim_ticket(people):
    db, admin, u = people
    d = _draw(db, u, "ticket")
    a = router.user_claim_ticket(d.id, db, u)
    b = router.user_claim_ticket(d.id, db, u)
    assert a["ticketId"] == b["ticketId"]
    assert a["draw"]["roundName"] == "第一期" and a["draw"]["soldOut"] is False
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
    with pytest.raises(HTTPException) as e:
        router.admin_cancel(d2.id, LuckyHandleIn(note=""), db, admin)   # 取消必须写原因
    assert e.value.status_code == 400
    router.admin_cancel(d2.id, LuckyHandleIn(note="联系不上"), db, admin)
    kinds = sorted(n.kind for n in db.query(UserNotification).filter(UserNotification.user_id == u.id))
    assert kinds == ["lucky_prize_cancelled", "lucky_prize_delivered"]


def test_cannot_handle_twice(people):
    db, admin, u = people
    d = _draw(db, u, "form", status="submitted")
    router.admin_deliver(d.id, LuckyHandleIn(note=""), db, admin)
    with pytest.raises(HTTPException) as e:
        router.admin_cancel(d.id, LuckyHandleIn(note="x"), db, admin)
    assert e.value.status_code == 400


def test_admin_list_filters_open(people):
    db, admin, u = people
    _draw(db, u, "form", status="pending")
    _draw(db, u, "form", status="delivered")
    # 直接调用时 Query(...) 默认值不会被解析，分页参数要显式传 / Query defaults aren't resolved on a direct call
    out = router.admin_draws(status="open", roundId=None, userId=None, prizeId=None, limit=50, offset=0,
                             db=db, admin=admin)
    assert out["total"] == 1 and out["draws"][0]["user"]["email"] == "u@t.co"
    row = out["draws"][0]
    assert row["roundName"] == "第一期" and row["soldOut"] is False and row["roundId"]


def test_pending_list_spans_rounds_and_round_filter_narrows(people):
    """待发奖跨期列出、每行带期名；抽奖记录按 roundId 限定在一期。
    Pending spans rounds with each row naming its round; roundId narrows the draw list to one round."""
    db, admin, u = people
    now = common.utcnow()
    a = LuckyRound(name="甲期", starts_at=now, ends_at=now + timedelta(days=1), created_by=admin.id)
    b = LuckyRound(name="乙期", starts_at=now, ends_at=now + timedelta(days=1), created_by=admin.id)
    db.add_all([a, b])
    db.commit()
    _draw(db, u, "form", r=a)
    _draw(db, u, "ticket", r=b)
    out = router.admin_draws(status="open", roundId=None, userId=None, prizeId=None, limit=50, offset=0,
                             db=db, admin=admin)
    assert sorted(x["roundName"] for x in out["draws"]) == ["乙期", "甲期"]
    only_b = router.admin_draws(status=None, roundId=b.id, userId=None, prizeId=None, limit=50, offset=0,
                                db=db, admin=admin)
    assert only_b["total"] == 1 and only_b["draws"][0]["roundName"] == "乙期"


def test_sold_out_miss_rows_are_flagged(people):
    db, admin, u = people
    d = _draw(db, u, "form", status="auto_done")
    d.sold_out_miss = True
    db.commit()
    out = router.admin_draws(status=None, roundId=None, userId=None, prizeId=None, limit=50, offset=0,
                             db=db, admin=admin)
    assert out["draws"][0]["soldOut"] is True
    body = router.admin_draws_csv(status=None, roundId=None, db=db, admin=admin).body.decode("utf-8-sig")
    assert "已抽完未中奖" in body
    (mine,) = router.user_draws(db, u)["draws"]
    assert mine["soldOut"] is True and mine["roundName"] == "第一期"


def test_csv_export(people):
    db, admin, u = people
    _draw(db, u, "form", status="pending")
    resp = router.admin_draws_csv(status=None, roundId=None, db=db, admin=admin)
    body = resp.body.decode("utf-8-sig")
    assert "u@t.co" in body and "手表" in body
    assert body.splitlines()[0].split(",")[:2] == ["时间(UTC)", "期"] and ",第一期," in body


def test_csv_neutralises_spreadsheet_formulas(people):
    db, admin, u = people
    d = _draw(db, u, "form", status="submitted")
    d.claim_info = "=HYPERLINK(\"http://x\")"
    db.commit()
    body = router.admin_draws_csv(status=None, roundId=None, db=db, admin=admin).body.decode("utf-8-sig")
    assert "'=HYPERLINK" in body


def test_whitespace_only_claim_text_is_rejected(people):
    db, _a, u = people
    d = _draw(db, u, "form")
    with pytest.raises(HTTPException) as e:
        router.user_claim_info(d.id, LuckyClaimInfoIn(text="   "), db, u)
    assert e.value.status_code == 400
    db.refresh(d)
    assert d.claim_info is None and d.fulfillment_status == "pending"


def test_admin_list_paging_is_stable_on_created_at_ties(people):
    db, admin, u = people
    for _ in range(4):
        _draw(db, u, "form")
    same = common.utcnow()
    for d in db.query(LuckyDraw).all():
        d.created_at = same
    db.commit()
    seen = []
    for off in range(0, 4, 2):
        out = router.admin_draws(status=None, roundId=None, userId=None, prizeId=None, limit=2, offset=off,
                                 db=db, admin=admin)
        seen += [r["id"] for r in out["draws"]]
    assert seen == sorted(seen, reverse=True) and len(set(seen)) == 4


def test_deleting_a_claim_ticket_clears_the_draw_link_and_allows_a_new_one(people):
    from fastapi import BackgroundTasks
    from app.routers import tickets as tk
    db, admin, u = people
    d = _draw(db, u, "ticket")
    first = router.user_claim_ticket(d.id, db, u)["ticketId"]
    assert tk.admin_delete_ticket(first, BackgroundTasks(), db, admin) == {"deleted": True}
    db.expire_all()
    assert db.get(Ticket, first) is None
    assert db.get(LuckyDraw, d.id).support_ticket_id is None
    again = router.user_claim_ticket(d.id, db, u)["ticketId"]
    assert again and again != first


def test_deliver_and_cancel_also_push(people, monkeypatch):
    """最终评审 M3：发放 / 取消除了站内通知 + WS，还要走推送（后台任务）。
    Final review M3: deliver / cancel also queue a push, next to the in-app row and WS signal."""
    from fastapi import BackgroundTasks

    db, admin, u = people
    got = []
    monkeypatch.setattr("app.services.push_dispatch.dispatch_users_push",
                        lambda uids, ev, title, body, url, tag: got.append((list(uids), ev, title, body, url)))
    d = _draw(db, u, "form", status="submitted")
    bt = BackgroundTasks()
    router.admin_deliver(d.id, LuckyHandleIn(note="顺丰 SF123"), db, admin, background_tasks=bt)
    d2 = _draw(db, u, "form")
    bt2 = BackgroundTasks()
    router.admin_cancel(d2.id, LuckyHandleIn(note="联系不上"), db, admin, background_tasks=bt2)
    for t in bt.tasks + bt2.tasks:
        t.func(*t.args, **t.kwargs)
    assert [g[0] for g in got] == [[u.id], [u.id]] and {g[4] for g in got} == {"/lucky"}
    assert "手表" in got[0][3] and "联系不上" in got[1][3] and got[0][2] != got[1][2]


def test_user_draws_always_lists_open_claims_beyond_the_recent_100(people):
    """最终评审 M5：抽得多的人，早先那条待领取的奖不能被最近 100 条挤掉。
    Final review M5: a heavy user's old open claim must not fall off behind the latest 100 draws."""
    db, admin, u = people
    old = _draw(db, u, "form")                         # pending
    old.created_at = common.utcnow() - timedelta(days=30)
    for i in range(105):
        t = LuckyTicket(user_id=u.id, round_id=old.round_id, source="manual", status="used")
        db.add(t)
        db.flush()
        db.add(LuckyDraw(user_id=u.id, round_id=old.round_id, ticket_id=t.id, prize_id=old.prize_id,
                         request_id=f"bulk-{i:04d}", prize_snapshot=json.dumps({"name": "谢谢", "kind": "none"}),
                         fulfillment_status="auto_done", created_at=common.utcnow() - timedelta(minutes=i)))
    db.commit()
    ids = [x["id"] for x in router.user_draws(db, u)["draws"]]
    assert old.id in ids and len(ids) == 101
    assert ids[0] != old.id and ids[-1] == old.id      # 仍按时间倒序 / still newest first
