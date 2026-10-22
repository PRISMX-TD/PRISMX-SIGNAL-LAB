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


def test_ticket_unique_collision_retries_once(world, monkeypatch):
    """模拟另一请求刚用掉同一张券：唯一约束撞了，回滚后换下一张再来一次。
    Simulate a racing request taking the same ticket: on the unique violation, retry once."""
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
