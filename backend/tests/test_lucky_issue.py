# backend/tests/test_lucky_issue.py
"""发券：名次分档、按人去重、上限、幂等、开关关着时延迟通知、补通知、收回。
Issuing: rank tiers, per-user dedupe, limits, idempotency, deferred notification while the
wheel is hidden, catch-up notification on open, revoke."""
from datetime import timedelta

import pytest
from fastapi import HTTPException

from app.models import (Competition, LeaderboardSnapshot, LuckyRound, LuckyTicket, LuckyTicketBatch,
                        User, UserNotification)
from app.routers import lucky_wheel as router
from app.schemas import LuckyIssueIn, LuckyIssueItemIn, LuckyRankSourceIn, LuckyRevokeIn, LuckyTierIn, LuckyVisibleIn
from app.services.lucky import common, issue


def _user(db, email, **kw):
    u = User(email=email, password_hash="x", api_token=f"tok-{email}", **kw)
    db.add(u)
    db.commit()
    return u


@pytest.fixture
def world(db_session):
    db = db_session
    admin = _user(db, "admin@t.co", role="admin")
    now = common.utcnow()
    r = LuckyRound(starts_at=now - timedelta(hours=1), ends_at=now + timedelta(days=2), created_by=admin.id)
    db.add(r)
    db.commit()
    return db, admin, r


def _snap(db, board, key, user, login, rank):
    db.add(LeaderboardSnapshot(board=board, period_key=key, user_id=user.id, mt5_login=login, rank=rank, score=1.0))
    db.commit()


def test_board_ranks_tiers_and_dedupe(world):
    db, _a, _r = world
    a, b, c = (_user(db, f"{x}@t.co") for x in "abc")
    _snap(db, "return_pct", "2026-10", a, "1", 1)
    _snap(db, "return_pct", "2026-10", a, "2", 2)     # a 第二个账户 / a's second account
    _snap(db, "return_pct", "2026-10", b, "3", 3)
    _snap(db, "return_pct", "2026-10", c, "4", 11)
    rows = issue.resolve_ranks(db, LuckyRankSourceIn(
        type="board", board="return_pct", period="2026-10",
        tiers=[LuckyTierIn(fromRank=1, toRank=1, count=5), LuckyTierIn(fromRank=2, toRank=10, count=2)]))
    assert [(x["email"], x["rank"], x["count"]) for x in rows] == [("a@t.co", 1, 5), ("b@t.co", 3, 2)]
    assert rows[0]["source"] == "board_rank" and rows[0]["sourceRef"] == "return_pct:2026-10"


def test_comp_ranks_use_comp_key(world):
    db, _admin, _r = world
    u = _user(db, "u@t.co")
    now = common.utcnow()
    comp = Competition(name="10月赛", metric="return_pct", starts_at=now - timedelta(days=30), ends_at=now)
    db.add(comp)
    db.commit()
    _snap(db, "return_pct", f"comp:{comp.id}", u, "9", 1)
    rows = issue.resolve_ranks(db, LuckyRankSourceIn(type="comp", compId=comp.id,
                                                    tiers=[LuckyTierIn(fromRank=1, toRank=3, count=1)]))
    assert rows[0]["userId"] == u.id and rows[0]["source"] == "comp_rank" and rows[0]["sourceRef"] == comp.id


def test_overlapping_tiers_rejected(world):
    db, _a, _r = world
    with pytest.raises(HTTPException):
        issue.resolve_ranks(db, LuckyRankSourceIn(type="board", board="return_pct", period="2026-10", tiers=[
            LuckyTierIn(fromRank=1, toRank=3, count=1), LuckyTierIn(fromRank=3, toRank=5, count=1)]))


def _body(users, reason="10月赛前十", rid="req-0001", count=2):
    return LuckyIssueIn(reason=reason, requestId=rid,
                        items=[LuckyIssueItemIn(userId=u.id, count=count, source="manual") for u in users])


def test_issue_visible_notifies_now(world):
    db, admin, r = world
    common.set_visible(db, True)
    db.commit()
    u = _user(db, "u@t.co")
    out = router.admin_issue(_body([u]), db, admin, background_tasks=None)
    assert out["ticketCount"] == 2 and out["notified"] is True
    assert db.query(LuckyTicket).filter(LuckyTicket.user_id == u.id).count() == 2
    n = db.query(UserNotification).filter(UserNotification.user_id == u.id).one()
    assert n.kind == "lucky_ticket" and n.link == "/lucky" and "10月赛前十" in n.text


def test_issue_is_idempotent(world):
    db, admin, _r = world
    u = _user(db, "u@t.co")
    router.admin_issue(_body([u]), db, admin, background_tasks=None)
    router.admin_issue(_body([u]), db, admin, background_tasks=None)
    assert db.query(LuckyTicketBatch).count() == 1 and db.query(LuckyTicket).count() == 2


def test_issue_needs_open_round(world):
    db, admin, r = world
    r.ended_at = common.utcnow()
    db.commit()
    with pytest.raises(HTTPException):
        router.admin_issue(_body([_user(db, "u@t.co")]), db, admin, background_tasks=None)


def test_issue_limits(world):
    db, admin, _r = world
    u = _user(db, "u@t.co")
    with pytest.raises(Exception):
        _body([u], count=101)
    with pytest.raises(HTTPException):     # 同一人出现两次 / duplicate user
        router.admin_issue(LuckyIssueIn(reason="x", requestId="r-dup-0001", items=[
            LuckyIssueItemIn(userId=u.id, count=1, source="manual"),
            LuckyIssueItemIn(userId=u.id, count=1, source="manual")]), db, admin, background_tasks=None)


def test_hidden_defers_then_open_notifies_once(world):
    db, admin, r = world
    u, v = _user(db, "u@t.co"), _user(db, "v@t.co")
    out = router.admin_issue(_body([u, v]), db, admin, background_tasks=None)
    assert out["notified"] is False and db.query(UserNotification).count() == 0
    issue.revoke(db, None, v.id)            # v 的券被收回 / v's tickets revoked
    db.commit()
    router.admin_set_visible(LuckyVisibleIn(visible=True), db, admin, background_tasks=None)
    assert [n.user_id for n in db.query(UserNotification)] == [u.id]
    router.admin_set_visible(LuckyVisibleIn(visible=False), db, admin, background_tasks=None)
    router.admin_set_visible(LuckyVisibleIn(visible=True), db, admin, background_tasks=None)
    assert db.query(UserNotification).count() == 1


def test_revoke_only_unused(world):
    db, admin, r = world
    u = _user(db, "u@t.co")
    out = router.admin_issue(_body([u], count=3), db, admin, background_tasks=None)
    t = db.query(LuckyTicket).first()
    t.status = "used"
    db.commit()
    res = router.admin_revoke(LuckyRevokeIn(batchId=out["id"]), db, admin)
    assert res["revoked"] == 2
