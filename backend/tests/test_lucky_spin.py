"""开奖：券、期、开关、库存、每人上限、永久 PRO、再来一次、幂等、并发兜底。"""
import json
from datetime import timedelta

import pytest

from app.models import LuckyDraw, LuckyPrize, LuckyRound, LuckyTicket, User
from app.services.lucky import common, spin


def _now():
    return common.utcnow()


def _user(db, email, **kw):
    u = User(email=email, password_hash="x", api_token=f"tok-{email}", **kw)
    db.add(u)
    db.commit()
    return u


@pytest.fixture
def world(db_session):
    db = db_session
    admin = _user(db, "admin@t.co", role="admin")
    u = _user(db, "u@t.co")
    r = LuckyRound(starts_at=_now() - timedelta(hours=1), ends_at=_now() + timedelta(days=1), created_by=admin.id)
    db.add(r)
    db.flush()
    common.set_visible(db, True)
    db.commit()
    return db, admin, u, r


def _prizes(db, *specs):
    out = []
    for i, s in enumerate(specs):
        p = LuckyPrize(sort_order=i, **s)
        db.add(p)
        out.append(p)
    db.commit()
    return out


def _tickets(db, u, r, n):
    for _ in range(n):
        db.add(LuckyTicket(user_id=u.id, round_id=r.id, source="manual"))
    db.commit()


def first(n):   # rand_below 总取 0 → 第一个可中的格 / always the first available slot
    return 0


def test_spin_consumes_ticket_and_records_snapshot(world):
    db, _a, u, r = world
    p, _n = _prizes(db, dict(name="7 天", kind="pro_days", pro_days=7, prob_bp=5000),
                    dict(name="谢谢", kind="none", prob_bp=5000))
    _tickets(db, u, r, 2)
    d = spin.spin(db, u, "req-1", rand_below=first)
    db.commit()
    assert d.prize_id == p.id and d.fulfillment_status == "auto_done"
    assert json.loads(d.prize_snapshot)["name"] == "7 天"
    assert spin.unused_count(db, u.id, r.id) == 1
    assert u.plan == "PRO" and u.plan_expires_at is not None


def test_same_request_id_returns_same_draw(world):
    db, _a, u, r = world
    _prizes(db, dict(name="谢谢", kind="none", prob_bp=10000), dict(name="再来", kind="retry", prob_bp=0))
    _tickets(db, u, r, 2)
    d1 = spin.spin(db, u, "same", rand_below=first)
    db.commit()
    d2 = spin.spin(db, u, "same", rand_below=first)
    assert d1.id == d2.id and spin.unused_count(db, u.id, r.id) == 1


def test_no_ticket_409(world):
    db, _a, u, _r = world
    _prizes(db, dict(name="谢谢", kind="none", prob_bp=10000), dict(name="再来", kind="retry", prob_bp=0))
    with pytest.raises(spin.SpinError) as e:
        spin.spin(db, u, "x")
    assert e.value.status == 409


def test_hidden_blocks_users_but_not_admins(world):
    db, admin, u, r = world
    _prizes(db, dict(name="谢谢", kind="none", prob_bp=10000), dict(name="再来", kind="retry", prob_bp=0))
    _tickets(db, u, r, 1)
    _tickets(db, admin, r, 1)
    common.set_visible(db, False)
    db.commit()
    with pytest.raises(spin.SpinError) as e:
        spin.spin(db, u, "x")
    assert e.value.status == 403
    assert spin.spin(db, admin, "y").user_id == admin.id


def test_upcoming_or_ended_round_blocks(world):
    db, _a, u, r = world
    _prizes(db, dict(name="谢谢", kind="none", prob_bp=10000), dict(name="再来", kind="retry", prob_bp=0))
    _tickets(db, u, r, 1)
    r.starts_at = _now() + timedelta(hours=1)
    db.commit()
    with pytest.raises(spin.SpinError):
        spin.spin(db, u, "x")
    r.starts_at, r.ends_at = _now() - timedelta(days=2), _now() - timedelta(seconds=1)
    db.commit()
    with pytest.raises(spin.SpinError):
        spin.spin(db, u, "y")


def test_sold_out_goes_to_fallback(world):
    db, _a, u, r = world
    _big, fallback = _prizes(db, dict(name="大奖", kind="custom", claim_mode="form", prob_bp=9000, stock=1,
                                      stock_used=1, on_sold_out="to_fallback"),
                             dict(name="谢谢", kind="none", prob_bp=1000))
    _tickets(db, u, r, 1)
    assert spin.spin(db, u, "x", rand_below=lambda n: n - 1).prize_id == fallback.id


def test_per_user_limit(world):
    db, _a, u, r = world
    a, b = _prizes(db, dict(name="A", kind="retry", prob_bp=9999, per_user_limit=1, on_sold_out="redistribute"),
                   dict(name="谢谢", kind="none", prob_bp=1))
    _tickets(db, u, r, 1)
    assert spin.spin(db, u, "1", rand_below=first).prize_id == a.id   # retry 补发一张 / refunds one
    db.commit()
    assert spin.spin(db, u, "2", rand_below=first).prize_id == b.id   # A 已到上限 / A is capped


def test_permanent_pro_never_lands_on_pro_days(world):
    db, _a, u, r = world
    u.plan, u.plan_expires_at = "PRO", None
    _pd, n = _prizes(db, dict(name="7 天", kind="pro_days", pro_days=7, prob_bp=9000),
                     dict(name="谢谢", kind="none", prob_bp=1000))
    _tickets(db, u, r, 1)
    assert spin.spin(db, u, "x", rand_below=first).prize_id == n.id


def test_all_unavailable_409_keeps_ticket(world):
    db, _a, u, r = world
    _prizes(db, dict(name="A", kind="retry", prob_bp=5000, stock=0, on_sold_out="redistribute"),
            dict(name="B", kind="custom", claim_mode="ticket", prob_bp=5000, stock=0, on_sold_out="redistribute"))
    _tickets(db, u, r, 1)
    with pytest.raises(spin.SpinError) as e:
        spin.spin(db, u, "x")
    assert e.value.status == 409
    db.rollback()
    assert spin.unused_count(db, u.id, r.id) == 1


def test_custom_prize_is_pending_and_stock_counts(world):
    db, _a, u, r = world
    c, _n = _prizes(db, dict(name="手表", kind="custom", claim_mode="form", prob_bp=5000, stock=2),
                    dict(name="谢谢", kind="none", prob_bp=5000))
    _tickets(db, u, r, 1)
    d = spin.spin(db, u, "x", rand_below=first)
    db.commit()
    assert d.fulfillment_status == "pending"
    db.refresh(c)
    assert c.stock_used == 1


def test_slot_index_follows_current_order(world):
    db, _a, u, r = world
    a, b = _prizes(db, dict(name="A", kind="none", prob_bp=0), dict(name="B", kind="none", prob_bp=10000))
    _tickets(db, u, r, 1)
    d = spin.spin(db, u, "x", rand_below=first)
    assert spin.draw_out(d, spin.slot_index(db, d.prize_id))["slotIndex"] == 1


def test_ticket_already_used_by_a_draw_is_skipped(world):
    """券状态还是 unused、但已被别的抽奖记录引用：取券时直接排除，换下一张（排除路径）。
    A ticket still marked unused but already referenced by a draw is excluded when picking
    (the exclusion path; the IntegrityError retry is covered by the forced-collision test)."""
    db, _a, u, r = world
    _prizes(db, dict(name="谢谢", kind="none", prob_bp=10000), dict(name="再来", kind="retry", prob_bp=0))
    _tickets(db, u, r, 2)
    t1 = db.query(LuckyTicket).order_by(LuckyTicket.issued_at, LuckyTicket.id).first()
    other = LuckyDraw(user_id=u.id, round_id=r.id, ticket_id=t1.id, prize_id=db.query(LuckyPrize).first().id,
                      prize_snapshot="{}", request_id="racer", fulfillment_status="auto_done")
    db.add(other)
    db.commit()                        # t1 仍标 unused，但已被 racer 用掉 / t1 still says unused
    d = spin.spin(db, u, "mine", rand_below=first)
    db.commit()
    assert d.ticket_id != t1.id


def test_forced_ticket_collision_hits_integrity_retry(world, monkeypatch):
    """_next_ticket 第一次硬把已被引用的券交出来 → 唯一约束撞 → 回滚到 savepoint → 换下一张。
    Force _next_ticket to hand back an already-referenced ticket once: the unique index fires,
    the savepoint rolls back, and the retry takes the next ticket."""
    db, _a, u, r = world
    _prizes(db, dict(name="谢谢", kind="none", prob_bp=10000), dict(name="再来", kind="retry", prob_bp=0))
    _tickets(db, u, r, 2)
    t1, t2 = db.query(LuckyTicket).order_by(LuckyTicket.issued_at, LuckyTicket.id).all()
    db.add(LuckyDraw(user_id=u.id, round_id=r.id, ticket_id=t1.id, prize_id=db.query(LuckyPrize).first().id,
                     prize_snapshot="{}", request_id="racer", fulfillment_status="auto_done"))
    db.commit()
    real, calls = spin._next_ticket, []

    def fake(db_, user, round_id):
        calls.append(1)
        if len(calls) == 1:
            return db_.query(LuckyTicket).filter(LuckyTicket.id == t1.id).first()   # 绕过排除 / bypass exclusion
        return real(db_, user, round_id)

    monkeypatch.setattr(spin, "_next_ticket", fake)
    d = spin.spin(db, u, "mine-req", rand_below=first)
    db.commit()
    assert len(calls) == 2 and d.ticket_id == t2.id
    db.expire_all()
    assert db.get(LuckyTicket, t1.id).status == "unused"      # 撞车那次的改动已回滚 / rolled back
    assert db.get(LuckyTicket, t2.id).status == "used"
    assert db.query(LuckyDraw).count() == 2


def test_replay_that_races_the_first_request_returns_it(world, monkeypatch):
    """重放在 can_play 之后、锁用户行之前被第一个请求抢先落库 → 返回已有记录，不是 409。
    A replay whose twin commits between the early check and the user lock gets that draw."""
    db, _a, u, r = world
    _prizes(db, dict(name="谢谢", kind="none", prob_bp=10000), dict(name="再来", kind="retry", prob_bp=0))
    _tickets(db, u, r, 1)
    t1 = db.query(LuckyTicket).first()
    holder = {}

    def can_play(db_, user):
        d = LuckyDraw(user_id=u.id, round_id=r.id, ticket_id=t1.id, prize_id=db.query(LuckyPrize).first().id,
                      prize_snapshot="{}", request_id="same-req", fulfillment_status="auto_done")
        t1.status = "used"
        db_.add(d)
        db_.flush()
        holder["id"] = d.id
        return True

    monkeypatch.setattr(spin, "can_play", can_play)
    d = spin.spin(db, u, "same-req", rand_below=first)
    assert d.id == holder["id"]
    assert db.query(LuckyDraw).count() == 1


def test_stale_user_is_reloaded_before_the_grant(world):
    """user 是鉴权时读的旧值：另一个会话已把到期日推后 → 抽中后必须在新到期日上累加。
    The in-memory user is stale; another session already extended the expiry — add on top of it."""
    from sqlalchemy.orm import Session

    db, _a, u, r = world
    _prizes(db, dict(name="7 天", kind="pro_days", pro_days=7, prob_bp=10000), dict(name="谢谢", kind="none", prob_bp=0))
    _tickets(db, u, r, 1)
    uid = u.id
    _ = (u.plan, u.plan_expires_at)                         # 已加载 / loaded at auth time
    other = Session(bind=db.get_bind())
    ou = other.get(User, uid)
    ou.plan, ou.plan_expires_at = "PRO", _now() + timedelta(days=30)
    other.commit()
    other.close()
    spin.spin(db, u, "stale-1", rand_below=first)
    db.commit()
    assert u.plan_expires_at - _now() > timedelta(days=36)  # 30 + 7，而不是 7 / not just 7


def test_concurrent_pro_days_wins_both_land(world):
    """两个会话各自带着旧 user 抽中 PRO 天数：第二个必须在第一个的基础上加（审查探针）。
    Two sessions with stale users both win pro_days: the second adds on top of the first."""
    from sqlalchemy.orm import Session

    db, _a, u, r = world
    _prizes(db, dict(name="7 天", kind="pro_days", pro_days=7, prob_bp=10000), dict(name="谢谢", kind="none", prob_bp=0))
    _tickets(db, u, r, 2)
    uid = u.id
    start = _now()
    sa, sb = Session(bind=db.get_bind()), Session(bind=db.get_bind())
    ua, ub = sa.get(User, uid), sb.get(User, uid)
    _ = (ua.plan, ub.plan, ub.plan_expires_at)
    spin.spin(sa, ua, "req-aaaaaaa", rand_below=first)
    sa.commit()
    spin.spin(sb, ub, "req-bbbbbbb", rand_below=first)
    sb.commit()
    sa.close()
    sb.close()
    db.expire_all()
    assert db.get(User, uid).plan_expires_at - start > timedelta(days=13)


def test_permanent_pro_granted_mid_spin_is_not_undone(world):
    """管理员刚把此人设为永久 PRO（内存里的 user 还是旧的）→ 抽奖前重读，PRO 天数格不可中，不抛 400。
    An admin made the user permanent PRO after auth; the reload makes pro_days unavailable, no 400."""
    from sqlalchemy.orm import Session

    db, _a, u, r = world
    pd, n = _prizes(db, dict(name="7 天", kind="pro_days", pro_days=7, prob_bp=9000),
                    dict(name="谢谢", kind="none", prob_bp=1000))
    _tickets(db, u, r, 1)
    uid = u.id
    _ = (u.plan, u.plan_expires_at)
    other = Session(bind=db.get_bind())
    ou = other.get(User, uid)
    ou.plan, ou.plan_expires_at = "PRO", None
    other.commit()
    other.close()
    assert spin.spin(db, u, "perm-1", rand_below=first).prize_id == n.id
    assert u.plan_expires_at is None


def test_state_batches_include_ticket_without_batch(world):
    from app.models import LuckyTicketBatch
    from app.routers import lucky_wheel as lw

    db, admin, u, r = world
    _prizes(db, dict(name="谢谢", kind="none", prob_bp=10000), dict(name="再来", kind="retry", prob_bp=0))
    b = LuckyTicketBatch(round_id=r.id, reason="活动奖励", created_by=admin.id, request_id="batch-req-1")
    db.add(b)
    db.flush()
    db.add(LuckyTicket(user_id=u.id, round_id=r.id, source="manual", batch_id=b.id))
    db.add(LuckyTicket(user_id=u.id, round_id=r.id, source="retry"))
    db.add(LuckyTicket(user_id=u.id, round_id=r.id, source="retry"))
    db.commit()
    t = lw.user_state(db, u)["tickets"]
    assert t["unused"] == 3
    assert sum(x["count"] for x in t["batches"]) == 3
    assert [x for x in t["batches"] if x["reason"] is None][0]["count"] == 2


# ---- 路由层（照仓库惯例直接调路由函数）/ route layer, calling the handlers directly ----

def _request():
    from starlette.requests import Request

    from app.core.strategy_limits import user_limiter
    from fastapi import FastAPI

    app = FastAPI()
    app.state.limiter = user_limiter
    return Request({"type": "http", "method": "POST", "path": "/lucky-wheel/spin", "headers": [],
                    "client": ("127.0.0.1", 1234), "app": app, "query_string": b"", "scheme": "http",
                    "server": ("t", 80)})


def test_route_state_hides_odds_and_closed_wheel_is_empty(world):
    from app.routers import lucky_wheel as lw

    db, _a, u, r = world
    _prizes(db, dict(name="谢谢", kind="none", prob_bp=10000, stock=5), dict(name="再来", kind="retry", prob_bp=0))
    _tickets(db, u, r, 2)
    body = lw.user_state(db, u)
    assert body["visible"] is True and body["tickets"]["unused"] == 2 and len(body["prizes"]) == 2
    for p in body["prizes"]:
        assert not ({"probBp", "probPct", "stock", "stockUsed", "perUserLimit"} & set(p))
    common.set_visible(db, False)
    db.commit()
    assert lw.user_state(db, u) == {"visible": False, "round": None, "prizes": [],
                                    "tickets": {"unused": 0, "batches": []}}


def test_route_spin_and_draws(world):
    from fastapi import HTTPException

    from app.routers import lucky_wheel as lw
    from app.schemas import LuckySpinIn

    db, _a, u, r = world
    _prizes(db, dict(name="谢谢", kind="none", prob_bp=10000), dict(name="再来", kind="retry", prob_bp=0))
    _tickets(db, u, r, 1)
    with pytest.raises(ValueError):
        LuckySpinIn(requestId="short")
    body = lw.user_spin(_request(), LuckySpinIn(requestId="req-12345678"), db, u)
    assert body["prize"]["name"] == "谢谢" and body["ticketsLeft"] == 0 and body["slotIndex"] == 0
    again = lw.user_spin(_request(), LuckySpinIn(requestId="req-12345678"), db, u)   # 幂等 / idempotent
    assert again["id"] == body["id"]
    with pytest.raises(HTTPException) as e:                                           # 没券 / no ticket
        lw.user_spin(_request(), LuckySpinIn(requestId="req-87654321"), db, u)
    assert e.value.status_code == 409
    assert [d["id"] for d in lw.user_draws(db, u)["draws"]] == [body["id"]]
