"""/account 下发 luckyWheelVisible / luckyTickets：普通用户要开关开 + 有未结束的期；管理员总能看到。"""
from datetime import timedelta

from app.models import LuckyRound, LuckyTicket, User
from app.routers import account
from app.services.lucky import common


def _u(db, email, **kw):
    u = User(email=email, password_hash="x", api_token=f"t-{email}", **kw)
    db.add(u)
    db.commit()
    return u


def test_flags(db_session):
    db = db_session
    admin, u = _u(db, "a@t.co", role="admin"), _u(db, "u@t.co")
    assert account.lucky_flags(db, u) == (False, 0)
    assert account.lucky_flags(db, admin)[0] is True
    now = common.utcnow()
    r = LuckyRound(starts_at=now, ends_at=now + timedelta(days=1), created_by=admin.id)
    db.add(r)
    db.flush()
    db.add(LuckyTicket(user_id=u.id, round_id=r.id, source="manual"))
    db.commit()
    assert account.lucky_flags(db, u) == (False, 0)   # 开关关着 / hidden
    common.set_visible(db, True)
    db.commit()
    assert account.lucky_flags(db, u) == (True, 1)


def test_ended_round_hides_entry_for_users_but_not_admins(db_session):
    db = db_session
    admin, u = _u(db, "a2@t.co", role="admin"), _u(db, "u2@t.co")
    now = common.utcnow()
    r = LuckyRound(starts_at=now - timedelta(days=2), ends_at=now - timedelta(days=1), created_by=admin.id)
    db.add(r)
    db.flush()
    db.add(LuckyTicket(user_id=u.id, round_id=r.id, source="manual"))
    common.set_visible(db, True)
    db.commit()
    assert account.lucky_flags(db, u) == (False, 0)      # 期已过 / round over
    assert account.lucky_flags(db, admin) == (True, 0)   # 管理员仍可见，但没有券数 / admin sees entry, no count


def test_open_custom_draw_keeps_entry_after_round_end_or_switch_off(db_session):
    """最终评审 I2：本期结束 / 开关关掉后，只要还有待领取（pending / submitted）的自定义奖，入口仍可见。
    Final review I2: after the round ends or the switch goes off, an open custom claim keeps the entry."""
    import json

    from app.models import LuckyDraw, LuckyPrize

    db = db_session
    admin, u, v = _u(db, "a3@t.co", role="admin"), _u(db, "u3@t.co"), _u(db, "v3@t.co")
    now = common.utcnow()
    r = LuckyRound(starts_at=now - timedelta(days=2), ends_at=now - timedelta(days=1), ended_at=now - timedelta(days=1),
                   created_by=admin.id)
    p = LuckyPrize(sort_order=0, name="手表", kind="custom", claim_mode="form", prob_bp=10000)
    db.add_all([r, p])
    db.flush()

    def draw(user, status):
        t = LuckyTicket(user_id=user.id, round_id=r.id, source="manual", status="used")
        db.add(t)
        db.flush()
        db.add(LuckyDraw(user_id=user.id, round_id=r.id, ticket_id=t.id, prize_id=p.id, request_id=f"rq-{t.id}",
                         prize_snapshot=json.dumps({"name": "手表", "kind": "custom"}), fulfillment_status=status))

    draw(u, "pending")
    draw(v, "delivered")
    common.set_visible(db, True)
    db.commit()
    assert account.lucky_flags(db, u) == (True, 0)       # 期已结束但有待领 / ended, claim still open
    assert account.lucky_flags(db, v) == (False, 0)      # 已发放，没有待领 / nothing open
    common.set_visible(db, False)
    db.commit()
    assert account.lucky_flags(db, u) == (True, 0)       # 开关关着也一样 / switch off too
    assert account.lucky_flags(db, v) == (False, 0)
