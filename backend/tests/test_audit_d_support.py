"""安全审计 D 组：客服台的三条线索（外包邮箱脱敏、补偿天数累计上限、查看电话上限并发）。

Security audit group D, support desk leads:
- tickets.py:outsourced-email-mask-bypass-via-staff-ticket-serializer
- support.py:comp-days-approval-cap-per-request-only
- support.py:reveal-phone-daily-cap-check-then-act
"""
import threading
import time
from datetime import timedelta

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import SupportAction, SupportRequest, Ticket, User
from app.routers import support
from app.services import support_desk
from app.services.deps import staff_ctx_for
from app.services.settings_store import invalidate_settings_cache, invalidate_support_cache

# 复用客服台测试的夹具（内存库、TestClient、四个角色、静音推送）。
# Reuse the support-desk fixtures (in-memory db, TestClient, four roles, muted pushes).
from tests.test_support_desk import _assign, _auth, _now, _quiet, _user, client, db, people  # noqa: F401

MASKED = "re***@gmail.com"
FULL = "rexlee@gmail.com"


# ─────────────────────────────────────────────────────────────────────────────
# 外包客服邮箱脱敏 / outsourced email masking
# ─────────────────────────────────────────────────────────────────────────────
def _new_ticket(client, people) -> str:
    r = client.post("/api/tickets", json={"title": "help", "category": "account", "body": "hi"},
                    headers=_auth(people["customer"]))
    assert r.status_code == 201, r.text
    return r.json()["id"]


@pytest.mark.parametrize("tier", ["outsourced", None])
def test_outsourced_ticket_detail_and_list_mask_submitter_email(client, db, people, tier):
    agent = people["outsourced"]
    agent.support_tier = tier
    db.commit()
    tid = _new_ticket(client, people)
    ho = _auth(agent)

    # 对照：/api/admin/tickets/{id} 本来就脱敏 / control: already masked
    assert client.get(f"/api/admin/tickets/{tid}", headers=ho).json()["userEmail"] == MASKED

    # 用户端详情路由，工作人员视角也要脱敏 / the user-side detail route must mask too
    d = client.get(f"/api/tickets/{tid}", headers=ho).json()
    assert d["userEmail"] == MASKED
    assert d["replies"][0]["authorEmail"] == MASKED

    # 列表的 latestReply 也要脱敏 / the list's latestReply must mask too
    row = client.get("/api/admin/tickets", headers=ho).json()[0]
    assert row["userEmail"] == MASKED
    assert row["latestReply"]["authorEmail"] == MASKED


def test_outsourced_support_message_masks_customer_email(client, db, people):
    _assign(db, people["admin"], people["outsourced"], people["customer"])
    r = client.post(f"/api/support/users/{people['customer'].id}/message",
                    json={"title": "hi", "body": "x"}, headers=_auth(people["outsourced"]))
    assert r.status_code == 200, r.text
    assert r.json()["ticket"]["userEmail"] == MASKED


def test_internal_and_admin_still_see_full_email(client, db, people):
    tid = _new_ticket(client, people)
    for who in ("internal", "admin"):
        h = _auth(people[who])
        d = client.get(f"/api/tickets/{tid}", headers=h).json()
        assert d["userEmail"] == FULL and d["replies"][0]["authorEmail"] == FULL
        row = client.get("/api/admin/tickets", headers=h).json()[0]
        assert row["userEmail"] == FULL and row["latestReply"]["authorEmail"] == FULL
    # 客户自己看自己的工单不受影响 / the customer's own view is unchanged
    d = client.get(f"/api/tickets/{tid}", headers=_auth(people["customer"])).json()
    assert d["userEmail"] == FULL


# ─────────────────────────────────────────────────────────────────────────────
# 补偿天数累计上限 / cumulative comp-days cap
# ─────────────────────────────────────────────────────────────────────────────
def test_repeated_small_comp_grants_go_to_approval(client, db, people):
    c = people["customer"]
    db.add(Ticket(user_id=c.id, title="t", category="account", status="open"))
    db.commit()
    h = _auth(people["outsourced"])
    applied = 0
    for _ in range(10):
        r = client.post(f"/api/support/users/{c.id}/comp-days", json={"days": 7, "reason": "x"}, headers=h)
        assert r.status_code == 200, r.text
        applied += bool(r.json()["applied"])
    assert applied == 1
    db.refresh(c)
    assert c.plan == "PRO" and (c.plan_expires_at - _now()).days <= 7
    assert db.query(SupportRequest).filter(SupportRequest.kind == "comp_days").count() == 9


def test_split_grant_under_cap_still_counts_cumulatively(client, db, people):
    c = people["customer"]
    db.add(Ticket(user_id=c.id, title="t", category="account", status="open"))
    db.commit()
    h = _auth(people["outsourced"])
    assert client.post(f"/api/support/users/{c.id}/comp-days", json={"days": 4, "reason": "x"},
                       headers=h).json()["applied"] is True
    assert client.post(f"/api/support/users/{c.id}/comp-days", json={"days": 3, "reason": "x"},
                       headers=h).json()["applied"] is True
    # 4 + 3 = 7 用满，再加 1 天就得审批 / cap used up, one more day needs approval
    assert client.post(f"/api/support/users/{c.id}/comp-days", json={"days": 1, "reason": "x"},
                       headers=h).json()["applied"] is False


def test_comp_cap_window_rolls_over(client, db, people):
    c = people["customer"]
    db.add(Ticket(user_id=c.id, title="t", category="account", status="open"))
    db.commit()
    h = _auth(people["outsourced"])
    assert client.post(f"/api/support/users/{c.id}/comp-days", json={"days": 7, "reason": "x"},
                       headers=h).json()["applied"] is True
    # 把那次补偿挪到窗口外 / move the earlier grant out of the window
    for a in db.query(SupportAction).filter(SupportAction.kind == support_desk.ACT_COMP_DAYS).all():
        a.created_at = _now() - timedelta(days=support.COMP_DAYS_WINDOW_DAYS + 1)
    db.commit()
    assert client.post(f"/api/support/users/{c.id}/comp-days", json={"days": 7, "reason": "x"},
                       headers=h).json()["applied"] is True


def test_pending_request_counts_against_cap(client, db, people):
    c = people["customer"]
    db.add(Ticket(user_id=c.id, title="t", category="account", status="open"))
    db.commit()
    h = _auth(people["outsourced"])
    assert client.post(f"/api/support/users/{c.id}/comp-days", json={"days": 30, "reason": "x"},
                       headers=h).json()["applied"] is False
    assert client.post(f"/api/support/users/{c.id}/comp-days", json={"days": 1, "reason": "x"},
                       headers=h).json()["applied"] is False


def test_comp_days_to_self_needs_approval(client, db, people):
    o = people["outsourced"]
    r = client.post("/api/tickets", json={"title": "t", "category": "account", "body": "x"}, headers=_auth(o))
    assert r.status_code == 201, r.text
    r = client.post(f"/api/support/users/{o.id}/comp-days", json={"days": 7, "reason": "x"}, headers=_auth(o))
    assert r.status_code == 200 and r.json()["applied"] is False
    db.refresh(o)
    assert o.plan != "PRO"


def test_admin_comp_days_stay_uncapped(client, db, people):
    c = people["customer"]
    h = _auth(people["admin"])
    for _ in range(3):
        assert client.post(f"/api/support/users/{c.id}/comp-days", json={"days": 30, "reason": "x"},
                           headers=h).json()["applied"] is True


# ─────────────────────────────────────────────────────────────────────────────
# 查看电话每日上限的并发 / reveal-phone daily cap under concurrency
# ─────────────────────────────────────────────────────────────────────────────
def test_concurrent_reveals_cannot_exceed_daily_cap(tmp_path, monkeypatch):
    """两个请求同时进来、上限 1：只能有一个拿到完整号码。

    SQLite 下 FOR UPDATE 是空操作，所以这里把 support_desk.lock_actor 换成一把按会话持有、
    提交 / 回滚时释放的进程内锁，模拟 Postgres 的行锁；count_actions 故意放慢，让两个请求
    在没有锁时必然读到同一个计数。
    SQLite ignores FOR UPDATE, so lock_actor is swapped for an in-process lock held per
    session until commit / rollback (emulating the Postgres row lock); count_actions is slowed
    so that without the lock both requests read the same count."""
    engine = create_engine(f"sqlite:///{tmp_path / 'reveal.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False)
    invalidate_support_cache()
    invalidate_settings_cache()
    monkeypatch.setattr(support_desk, "notify_ws", lambda *a, **k: None)

    s = Session()
    agent = User(email="out@x.com", api_token="tok_out", role="support", support_tier="outsourced",
                 support_reveal_limit=1, last_active_at=_now())
    customer = User(email="c@x.com", api_token="tok_c", phone="+8613812345678", last_active_at=_now())
    s.add_all([agent, customer])
    s.flush()
    s.add(Ticket(user_id=customer.id, title="t", category="account", status="open"))
    s.commit()
    agent_id, customer_id = agent.id, customer.id
    s.close()

    row_lock = threading.Lock()

    def fake_lock_actor(sess, actor_id):
        if sess.info.get("_held"):
            return
        row_lock.acquire()
        sess.info["_held"] = True

        def _release(*_a):
            if sess.info.pop("_held", False):
                row_lock.release()

        event.listen(sess, "after_commit", _release)
        event.listen(sess, "after_rollback", _release)

    real_count = support_desk.count_actions

    def slow_count(*a, **k):
        n = real_count(*a, **k)
        time.sleep(0.3)
        return n

    monkeypatch.setattr(support_desk, "lock_actor", fake_lock_actor)
    monkeypatch.setattr(support_desk, "count_actions", slow_count)

    results: list[object] = []

    def worker():
        sess = Session()
        try:
            ctx = staff_ctx_for(sess.get(User, agent_id))
            results.append(support.support_reveal_phone(customer_id, db=sess, staff=ctx))
        except Exception as exc:  # 429 counts as a result
            sess.rollback()
            results.append(exc)
        finally:
            sess.close()

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)

    ok = [r for r in results if isinstance(r, dict)]
    assert len(results) == 2
    assert len(ok) == 1, results
    s = Session()
    try:
        assert s.query(SupportAction).filter(SupportAction.actor_id == agent_id,
                                             SupportAction.kind == support_desk.ACT_REVEAL).count() == 1
    finally:
        s.close()
        engine.dispose()
        invalidate_support_cache()
        invalidate_settings_cache()
