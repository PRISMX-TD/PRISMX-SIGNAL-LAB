"""/account 下发 luckyWheelVisible / luckyTickets（rev 46）：普通用户要有一期打开了显示且未结束；
管理员总能看到。券数只算他看得到的未结束期。
/account's luckyWheelVisible / luckyTickets (rev 46): users need a visible unended round; admins always see
the entry. Tickets only count in unended rounds the person can see."""
import json
from datetime import timedelta

from app.models import LuckyDraw, LuckyPrize, LuckyRound, LuckyTicket, User
from app.routers import account
from app.services.lucky import common


def _u(db, email, **kw):
    u = User(email=email, password_hash="x", api_token=f"t-{email}", **kw)
    db.add(u)
    db.commit()
    return u


def _round(db, admin, name, visible, starts=-1, ends=24, ended=False):
    now = common.utcnow()
    r = LuckyRound(name=name, visible=visible, starts_at=now + timedelta(hours=starts),
                   ends_at=now + timedelta(hours=ends), ended_at=now if ended else None, created_by=admin.id)
    db.add(r)
    db.commit()
    return r


def _tickets(db, u, r, n, status="unused"):
    for _ in range(n):
        db.add(LuckyTicket(user_id=u.id, round_id=r.id, source="manual", status=status))
    db.commit()


def test_flags_follow_visible_rounds(db_session):
    db = db_session
    admin, u = _u(db, "a@t.co", role="admin"), _u(db, "u@t.co")
    assert account.lucky_flags(db, u) == (False, 0)
    assert account.lucky_flags(db, admin) == (True, 0)        # 没有期也可见 / visible even with no round
    hidden = _round(db, admin, "内测期", visible=False)
    _tickets(db, u, hidden, 2)
    assert account.lucky_flags(db, u) == (False, 0)           # 只有关着的期 / only a hidden round
    shown = _round(db, admin, "正式期", visible=True)
    _tickets(db, u, shown, 1)
    _tickets(db, u, shown, 1, status="used")
    assert account.lucky_flags(db, u) == (True, 1)            # 关着那期的 2 张不算 / hidden ones don't count
    _tickets(db, admin, hidden, 3)
    _tickets(db, admin, shown, 1)
    assert account.lucky_flags(db, admin) == (True, 4)        # 管理员两期都算 / admins count both


def test_upcoming_visible_round_shows_entry_and_counts_tickets(db_session):
    db = db_session
    admin, u = _u(db, "a1@t.co", role="admin"), _u(db, "u1@t.co")
    r = _round(db, admin, "下一期", visible=True, starts=5, ends=48)
    _tickets(db, u, r, 2)
    assert account.lucky_flags(db, u) == (True, 2)


def test_ended_rounds_hide_entry_for_users_but_not_admins(db_session):
    db = db_session
    admin, u = _u(db, "a2@t.co", role="admin"), _u(db, "u2@t.co")
    due = _round(db, admin, "到点未扫", visible=True, starts=-48, ends=-1)          # ends_at 已过 / past end
    gone = _round(db, admin, "已结束", visible=True, starts=-48, ends=-2, ended=True)
    _tickets(db, u, due, 1)
    _tickets(db, u, gone, 1)
    assert account.lucky_flags(db, u) == (False, 0)
    assert account.lucky_flags(db, admin) == (True, 0)


def test_open_custom_draw_keeps_entry_after_round_end_or_hide(db_session):
    """最终评审 I2：期结束 / 显示关掉后，只要还有待领取（pending / submitted）的自定义奖，入口仍可见。
    Final review I2: after the round ends or is hidden, an open custom claim keeps the entry."""
    db = db_session
    admin, u, v = _u(db, "a3@t.co", role="admin"), _u(db, "u3@t.co"), _u(db, "v3@t.co")
    r = _round(db, admin, "一期", visible=True, starts=-48, ends=-24, ended=True)
    p = LuckyPrize(round_id=r.id, sort_order=0, name="手表", kind="custom", claim_mode="form", prob_bp=10000)
    db.add(p)
    db.flush()

    def draw(user, status):
        t = LuckyTicket(user_id=user.id, round_id=r.id, source="manual", status="used")
        db.add(t)
        db.flush()
        db.add(LuckyDraw(user_id=user.id, round_id=r.id, ticket_id=t.id, prize_id=p.id, request_id=f"rq-{t.id}",
                         prize_snapshot=json.dumps({"name": "手表", "kind": "custom"}), fulfillment_status=status))

    draw(u, "pending")
    draw(v, "delivered")
    db.commit()
    assert account.lucky_flags(db, u) == (True, 0)       # 期已结束但有待领 / ended, claim still open
    assert account.lucky_flags(db, v) == (False, 0)      # 已发放，没有待领 / nothing open
    r.visible = False
    db.commit()
    assert account.lucky_flags(db, u) == (True, 0)       # 显示关掉也一样 / hidden too
    assert account.lucky_flags(db, v) == (False, 0)
