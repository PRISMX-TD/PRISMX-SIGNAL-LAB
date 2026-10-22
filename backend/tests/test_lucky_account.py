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
