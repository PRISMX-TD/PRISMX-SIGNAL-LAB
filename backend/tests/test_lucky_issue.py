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


def test_issue_notification_is_one_ws_call_for_the_whole_batch(world, monkeypatch):
    """最终评审 M1：发一大批券，WS 提醒只提交一次到主循环，不是每人一次。
    Final review M1: a big batch costs ONE submission to the main loop, not one per user."""
    from fastapi import BackgroundTasks

    db, admin, _r = world
    common.set_visible(db, True)
    db.commit()
    users = [_user(db, f"w{i}@t.co") for i in range(30)]
    calls = []

    def fake_run(coro, timeout):
        calls.append(timeout)
        coro.close()

    monkeypatch.setattr("app.services.gateway_client.run_on_main_loop", fake_run)
    router.admin_issue(_body(users, rid="req-ws-0001"), db, admin, background_tasks=BackgroundTasks())
    assert len(calls) == 1


def _push_calls(bt, monkeypatch):
    got = []
    monkeypatch.setattr("app.services.push_dispatch.dispatch_users_push",
                        lambda uids, ev, title, body, url, tag: got.append((list(uids), title, body, url)))
    for t in bt.tasks:
        t.func(*t.args, **t.kwargs)
    return got


def test_ticket_copy_for_an_upcoming_round_says_when_it_opens(world, monkeypatch):
    """最终评审 M4：期还没开始，通知和推送写「X月X日 HH:MM 开启」（UTC+8），不叫人现在就去转。
    Final review M4: for an upcoming round the copy says when it opens (UTC+8), not "spin now"."""
    from fastapi import BackgroundTasks

    db, admin, r = world
    common.set_visible(db, True)
    r.starts_at = common.utcnow().replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=3, hours=4)
    r.ends_at = r.starts_at + timedelta(days=5)
    db.commit()
    u = _user(db, "u@t.co")
    bt = BackgroundTasks()
    router.admin_issue(_body([u]), db, admin, background_tasks=bt)
    local = r.starts_at + timedelta(hours=8)
    when = f"{local.month}月{local.day}日 {local:%H:%M}"
    n = db.query(UserNotification).filter(UserNotification.user_id == u.id).one()
    assert f"{when}开启" in n.text
    (uids, _title, body, url), = _push_calls(bt, monkeypatch)
    assert uids == [u.id] and url == "/lucky" and f"{when}开启" in body and "转一转" in body


def test_ticket_copy_for_an_active_round_keeps_the_spin_prompt(world, monkeypatch):
    from fastapi import BackgroundTasks

    db, admin, _r = world
    common.set_visible(db, True)
    db.commit()
    u = _user(db, "u@t.co")
    bt = BackgroundTasks()
    router.admin_issue(_body([u]), db, admin, background_tasks=bt)
    assert "开启" not in db.query(UserNotification).one().text
    (_uids, _title, body, _url), = _push_calls(bt, monkeypatch)
    assert "开启" not in body and "转一转" in body


def test_concurrent_same_request_id_returns_the_existing_batch(world, monkeypatch):
    """最终评审 M6：两个请求同一个 requestId 同时进来，输的那个撞唯一约束 → 回滚并返回已有批次，不是 500。
    Final review M6: the loser of a same-requestId race hits the unique index and replays the winner."""
    from app.models import AdminAuditLog

    db, admin, r = world
    u = _user(db, "u@t.co")
    real = issue.rounds.current_round
    state = {"n": 0}

    def racing(db_):
        state["n"] += 1
        if state["n"] == 1:      # 在「已确认没有同名批次」之后、自己落库之前，另一个请求抢先写入
            db_.add(LuckyTicketBatch(round_id=r.id, reason="先到的", created_by=admin.id, user_count=1,
                                     ticket_count=2, request_id="req-race-01", notified_at=common.utcnow()))
            db_.flush()
        return real(db_)

    monkeypatch.setattr(issue.rounds, "current_round", racing)
    out = router.admin_issue(_body([u], rid="req-race-01"), db, admin, background_tasks=None)
    assert out["notified"] is True and out["ticketCount"] == 2
    assert db.query(LuckyTicketBatch).count() == 1 and db.query(LuckyTicket).count() == 0
    assert db.query(AdminAuditLog).filter(AdminAuditLog.field == "lucky:issue").count() == 0   # 重放不重复审计
