"""开奖（rev 46）：按期的券与可见性、按份量抽奖箱、按概率「已抽完未中奖」、永久 PRO、再来一次、幂等、并发兜底、
多期互不干扰、用户端列表。
Spins (rev 46): per-round tickets and visibility, qty raffle box, prob "sold out, no prize", permanent
PRO, retry, idempotency, the concurrency backstops, rounds side by side, the user-facing state."""
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


def _round(db, admin, name="第一期", mode="prob", visible=True, starts=-1, ends=24):
    r = LuckyRound(name=name, mode=mode, visible=visible, starts_at=_now() + timedelta(hours=starts),
                   ends_at=_now() + timedelta(hours=ends), created_by=admin.id)
    db.add(r)
    db.commit()
    return r


@pytest.fixture
def world(db_session):
    db = db_session
    admin = _user(db, "admin@t.co", role="admin")
    u = _user(db, "u@t.co")
    r = _round(db, admin)
    return db, admin, u, r


def _prizes(db, r, *specs):
    out = []
    for i, s in enumerate(specs):
        p = LuckyPrize(round_id=r.id, sort_order=i, **s)
        db.add(p)
        out.append(p)
    db.commit()
    return out


def _tickets(db, u, r, n):
    for _ in range(n):
        db.add(LuckyTicket(user_id=u.id, round_id=r.id, source="manual"))
    db.commit()


def first(n):   # rand_below 总取 0 → 第一个可中的格 / always the first weighted slot
    return 0


def last(n):
    return n - 1


NONE_RETRY = (dict(name="谢谢", kind="none", prob_bp=10000), dict(name="再来", kind="retry", prob_bp=0))


def test_spin_consumes_ticket_and_records_snapshot(world):
    db, _a, u, r = world
    p, _n = _prizes(db, r, dict(name="7 天", kind="pro_days", pro_days=7, prob_bp=5000),
                    dict(name="谢谢", kind="none", prob_bp=5000))
    _tickets(db, u, r, 2)
    d = spin.spin(db, u, r.id, "req-1", rand_below=first)
    db.commit()
    assert d.prize_id == p.id and d.fulfillment_status == "auto_done" and d.sold_out_miss is False
    assert json.loads(d.prize_snapshot)["name"] == "7 天"
    assert spin.unused_count(db, u.id, r.id) == 1
    assert u.plan == "PRO" and u.plan_expires_at is not None


def test_same_request_id_returns_same_draw_whatever_round(world):
    db, admin, u, r = world
    other = _round(db, admin, name="第二期")
    _prizes(db, r, *NONE_RETRY)
    _tickets(db, u, r, 2)
    d1 = spin.spin(db, u, r.id, "same", rand_below=first)
    db.commit()
    d2 = spin.spin(db, u, r.id, "same", rand_below=first)
    d3 = spin.spin(db, u, other.id, "same", rand_below=first)   # 带了别的期也返回同一条 / any round
    assert d1.id == d2.id == d3.id and spin.unused_count(db, u.id, r.id) == 1


def test_no_ticket_409(world):
    db, _a, u, r = world
    _prizes(db, r, *NONE_RETRY)
    with pytest.raises(spin.SpinError) as e:
        spin.spin(db, u, r.id, "x")
    assert e.value.status == 409


def test_unknown_round_404(world):
    db, _a, u, _r = world
    with pytest.raises(spin.SpinError) as e:
        spin.spin(db, u, "nope", "x")
    assert e.value.status == 404


def test_hidden_round_blocks_users_but_not_admins(world):
    """内部测试：管理员给自己发券，在关着显示的期里按正式流程抽。/ admins test hidden rounds for real."""
    db, admin, u, r = world
    _prizes(db, r, *NONE_RETRY)
    _tickets(db, u, r, 1)
    _tickets(db, admin, r, 1)
    r.visible = False
    db.commit()
    with pytest.raises(spin.SpinError) as e:
        spin.spin(db, u, r.id, "x")
    assert e.value.status == 403
    d = spin.spin(db, admin, r.id, "y")
    assert d.user_id == admin.id and d.round_id == r.id


def test_upcoming_or_ended_round_blocks(world):
    db, _a, u, r = world
    _prizes(db, r, *NONE_RETRY)
    _tickets(db, u, r, 1)
    r.starts_at = _now() + timedelta(hours=1)
    db.commit()
    with pytest.raises(spin.SpinError) as e:
        spin.spin(db, u, r.id, "x")
    assert e.value.status == 409
    r.starts_at, r.ends_at = _now() - timedelta(days=2), _now() - timedelta(seconds=1)
    db.commit()
    with pytest.raises(spin.SpinError) as e:
        spin.spin(db, u, r.id, "y")
    assert e.value.status == 409


def test_tickets_and_prizes_stay_in_their_round(world):
    """多期并存：券只在自己那一期能用，开奖只看这一期的奖品。/ rounds don't share tickets or prizes."""
    db, admin, u, r = world
    r2 = _round(db, admin, name="第二期", mode="qty")
    _prizes(db, r, *NONE_RETRY)
    b, _c = _prizes(db, r2, dict(name="B", kind="none", stock=5), dict(name="C", kind="none", stock=0))
    _tickets(db, u, r2, 1)
    with pytest.raises(spin.SpinError) as e:     # 第一期没券 / no tickets in round 1
        spin.spin(db, u, r.id, "a-1")
    assert e.value.status == 409
    db.rollback()
    d = spin.spin(db, u, r2.id, "b-1", rand_below=first)
    db.commit()
    assert d.round_id == r2.id and d.prize_id == b.id
    assert spin.slot_index(db, r2.id, b.id) == 0


# ---- 按份量 / qty ----

def test_qty_weights_are_remaining_and_empty_slot_never_wins(world):
    db, admin, u, _r = world
    q = _round(db, admin, name="份量期", mode="qty")
    a, b, c = _prizes(db, q, dict(name="A", kind="none", stock=2, stock_used=2),
                      dict(name="B", kind="retry", stock=3),
                      dict(name="C", kind="custom", claim_mode="form", stock=1))
    _tickets(db, u, q, 1)
    seen = []

    def spy(n):
        seen.append(n)
        return n - 1                             # 最后一个可中的格 / the last weighted slot
    d = spin.spin(db, u, q.id, "q-1", rand_below=spy)
    db.commit()
    assert seen == [4]                           # 3 + 1：A 的份数为 0 不计 / A has none left
    assert d.prize_id == c.id and d.fulfillment_status == "pending"
    db.refresh(c)
    assert c.stock_used == 1


def test_qty_retry_counts_as_a_share(world):
    db, admin, u, _r = world
    q = _round(db, admin, name="份量期", mode="qty")
    rt, _n = _prizes(db, q, dict(name="再来", kind="retry", stock=1), dict(name="谢谢", kind="none", stock=1))
    _tickets(db, u, q, 1)
    d = spin.spin(db, u, q.id, "q-r", rand_below=first)
    db.commit()
    db.refresh(rt)
    assert d.prize_id == rt.id and rt.stock_used == 1
    assert spin.unused_count(db, u.id, q.id) == 1   # 补发一张 / one refunded


def test_qty_all_gone_409_keeps_ticket(world):
    db, admin, u, _r = world
    q = _round(db, admin, name="份量期", mode="qty")
    _prizes(db, q, dict(name="A", kind="retry", stock=1, stock_used=1), dict(name="B", kind="none", stock=0))
    _tickets(db, u, q, 1)
    with pytest.raises(spin.SpinError) as e:
        spin.spin(db, u, q.id, "x")
    assert e.value.status == 409 and "抽完" in e.value.detail
    db.rollback()
    assert spin.unused_count(db, u.id, q.id) == 1
    assert db.query(LuckyDraw).count() == 0


def test_qty_permanent_pro_with_only_pro_days_left_409_keeps_ticket(world):
    db, admin, u, _r = world
    u.plan, u.plan_expires_at = "PRO", None
    db.commit()
    q = _round(db, admin, name="份量期", mode="qty")
    _prizes(db, q, dict(name="7 天", kind="pro_days", pro_days=7, stock=5), dict(name="B", kind="none", stock=0))
    _tickets(db, u, q, 1)
    with pytest.raises(spin.SpinError) as e:
        spin.spin(db, u, q.id, "x")
    assert e.value.status == 409
    db.rollback()
    assert spin.unused_count(db, u.id, q.id) == 1


# ---- 按概率 / prob ----

def test_prob_landing_on_a_sold_out_slot_is_a_miss(world):
    """抽中已抽完的格：券用掉、份数不变、不发奖，记录 sold_out_miss，fulfillment = auto_done。
    Landing on a sold-out slot: the ticket is spent, stock unchanged, no prize, sold_out_miss recorded."""
    db, _a, u, r = world
    big, _n = _prizes(db, r, dict(name="大奖", kind="pro_days", pro_days=30, prob_bp=9000, stock=1, stock_used=1),
                      dict(name="谢谢", kind="none", prob_bp=1000))
    _tickets(db, u, r, 1)
    d = spin.spin(db, u, r.id, "miss-1", rand_below=first)
    db.commit()
    db.refresh(big)
    assert d.prize_id == big.id and d.sold_out_miss is True and d.fulfillment_status == "auto_done"
    assert big.stock_used == 1                                   # 不加 / unchanged
    assert u.plan != "PRO" and u.plan_expires_at is None         # 没有效果 / no effect
    assert spin.unused_count(db, u.id, r.id) == 0                # 券用掉 / ticket spent
    out = spin.draw_out(d, spin.slot_index(db, r.id, d.prize_id), r.name)
    assert out["soldOut"] is True and out["slotIndex"] == 0 and out["roundName"] == "第一期"


def test_prob_sold_out_custom_or_retry_has_no_effect(world):
    db, _a, u, r = world
    c, rt = _prizes(db, r, dict(name="手表", kind="custom", claim_mode="form", prob_bp=5000, stock=0),
                    dict(name="再来", kind="retry", prob_bp=5000, stock=2, stock_used=2))
    _tickets(db, u, r, 2)
    d1 = spin.spin(db, u, r.id, "m-1", rand_below=first)
    d2 = spin.spin(db, u, r.id, "m-2", rand_below=last)
    db.commit()
    assert (d1.prize_id, d1.sold_out_miss, d1.fulfillment_status) == (c.id, True, "auto_done")
    assert (d2.prize_id, d2.sold_out_miss) == (rt.id, True)
    assert spin.unused_count(db, u.id, r.id) == 0                # 没补发 / no refund


def test_prob_odds_are_not_redistributed(world):
    """已抽完的格权重照算：抽签总数仍是 10000，不是剩下几格的合计。/ the total stays 10000."""
    db, _a, u, r = world
    _prizes(db, r, dict(name="A", kind="none", prob_bp=3000, stock=0), dict(name="B", kind="none", prob_bp=7000))
    _tickets(db, u, r, 1)
    seen = []
    spin.spin(db, u, r.id, "t-1", rand_below=lambda n: seen.append(n) or 0)
    assert seen == [10000]


def test_prob_unlimited_stock_counts_up(world):
    db, _a, u, r = world
    p, _n = _prizes(db, r, dict(name="A", kind="none", prob_bp=10000), dict(name="B", kind="none", prob_bp=0))
    _tickets(db, u, r, 1)
    d = spin.spin(db, u, r.id, "u-1", rand_below=first)
    db.commit()
    db.refresh(p)
    assert d.sold_out_miss is False and p.stock_used == 1


def test_prob_permanent_pro_never_lands_on_pro_days(world):
    db, _a, u, r = world
    u.plan, u.plan_expires_at = "PRO", None
    _pd, n = _prizes(db, r, dict(name="7 天", kind="pro_days", pro_days=7, prob_bp=9000),
                     dict(name="谢谢", kind="none", prob_bp=1000))
    _tickets(db, u, r, 1)
    seen = []
    d = spin.spin(db, u, r.id, "x", rand_below=lambda k: seen.append(k) or 0)
    assert d.prize_id == n.id and seen == [1000]


def test_prob_permanent_pro_with_nothing_else_409_keeps_ticket(world):
    db, _a, u, r = world
    u.plan, u.plan_expires_at = "PRO", None
    _prizes(db, r, dict(name="7 天", kind="pro_days", pro_days=7, prob_bp=10000),
            dict(name="谢谢", kind="none", prob_bp=0))
    _tickets(db, u, r, 1)
    with pytest.raises(spin.SpinError) as e:
        spin.spin(db, u, r.id, "x")
    assert e.value.status == 409
    db.rollback()
    assert spin.unused_count(db, u.id, r.id) == 1


def test_custom_prize_is_pending_and_stock_counts(world):
    db, _a, u, r = world
    c, _n = _prizes(db, r, dict(name="手表", kind="custom", claim_mode="form", prob_bp=5000, stock=2),
                    dict(name="谢谢", kind="none", prob_bp=5000))
    _tickets(db, u, r, 1)
    d = spin.spin(db, u, r.id, "x", rand_below=first)
    db.commit()
    assert d.fulfillment_status == "pending"
    db.refresh(c)
    assert c.stock_used == 1


def test_slot_index_follows_current_order(world):
    db, _a, u, r = world
    a, b = _prizes(db, r, dict(name="A", kind="none", prob_bp=0), dict(name="B", kind="none", prob_bp=10000))
    _tickets(db, u, r, 1)
    d = spin.spin(db, u, r.id, "x", rand_below=first)
    assert spin.draw_out(d, spin.slot_index(db, r.id, d.prize_id), r.name)["slotIndex"] == 1


def test_ticket_already_used_by_a_draw_is_skipped(world):
    """券状态还是 unused、但已被别的抽奖记录引用：取券时直接排除，换下一张（排除路径）。
    A ticket still marked unused but already referenced by a draw is excluded when picking
    (the exclusion path; the IntegrityError retry is covered by the forced-collision test)."""
    db, _a, u, r = world
    _prizes(db, r, *NONE_RETRY)
    _tickets(db, u, r, 2)
    t1 = db.query(LuckyTicket).order_by(LuckyTicket.issued_at, LuckyTicket.id).first()
    other = LuckyDraw(user_id=u.id, round_id=r.id, ticket_id=t1.id, prize_id=db.query(LuckyPrize).first().id,
                      prize_snapshot="{}", request_id="racer", fulfillment_status="auto_done")
    db.add(other)
    db.commit()                        # t1 仍标 unused，但已被 racer 用掉 / t1 still says unused
    d = spin.spin(db, u, r.id, "mine", rand_below=first)
    db.commit()
    assert d.ticket_id != t1.id


def test_forced_ticket_collision_hits_integrity_retry(world, monkeypatch):
    """_next_ticket 第一次硬把已被引用的券交出来 → 唯一约束撞 → 回滚到 savepoint → 换下一张。
    Force _next_ticket to hand back an already-referenced ticket once: the unique index fires,
    the savepoint rolls back, and the retry takes the next ticket."""
    db, _a, u, r = world
    _prizes(db, r, *NONE_RETRY)
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
    d = spin.spin(db, u, r.id, "mine-req", rand_below=first)
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
    _prizes(db, r, *NONE_RETRY)
    _tickets(db, u, r, 1)
    t1 = db.query(LuckyTicket).first()
    holder = {}

    def can_play(user, r_):
        if "id" not in holder:
            d = LuckyDraw(user_id=u.id, round_id=r.id, ticket_id=t1.id, prize_id=db.query(LuckyPrize).first().id,
                          prize_snapshot="{}", request_id="same-req", fulfillment_status="auto_done")
            t1.status = "used"
            db.add(d)
            db.flush()
            holder["id"] = d.id
        return True

    monkeypatch.setattr(spin, "can_play", can_play)
    d = spin.spin(db, u, r.id, "same-req", rand_below=first)
    assert d.id == holder["id"]
    assert db.query(LuckyDraw).count() == 1


def test_round_hidden_or_ended_after_the_early_check_is_rechecked_under_lock(world, monkeypatch):
    """期行在锁里重读：入口检查之后管理员关了显示 / 结束了这一期，以锁里读到的为准。
    The round is re-read under the lock: a hide / end after the early check wins."""
    from sqlalchemy.orm import Session

    db, _a, u, r = world
    _prizes(db, r, *NONE_RETRY)
    _tickets(db, u, r, 1)
    real = spin._spin_once

    def hide_then_spin(db_, user, round_id, *a):
        other = Session(bind=db_.get_bind())
        other.get(LuckyRound, round_id).visible = False
        other.commit()
        other.close()
        return real(db_, user, round_id, *a)

    monkeypatch.setattr(spin, "_spin_once", hide_then_spin)
    with pytest.raises(spin.SpinError) as e:
        spin.spin(db, u, r.id, "late-hide")
    assert e.value.status == 403
    db.rollback()
    assert spin.unused_count(db, u.id, r.id) == 1


def test_stale_user_is_reloaded_before_the_grant(world):
    """user 是鉴权时读的旧值：另一个会话已把到期日推后 → 抽中后必须在新到期日上累加。
    The in-memory user is stale; another session already extended the expiry — add on top of it."""
    from sqlalchemy.orm import Session

    db, _a, u, r = world
    _prizes(db, r, dict(name="7 天", kind="pro_days", pro_days=7, prob_bp=10000),
            dict(name="谢谢", kind="none", prob_bp=0))
    _tickets(db, u, r, 1)
    uid = u.id
    _ = (u.plan, u.plan_expires_at)                         # 已加载 / loaded at auth time
    other = Session(bind=db.get_bind())
    ou = other.get(User, uid)
    ou.plan, ou.plan_expires_at = "PRO", _now() + timedelta(days=30)
    other.commit()
    other.close()
    spin.spin(db, u, r.id, "stale-1", rand_below=first)
    db.commit()
    assert u.plan_expires_at - _now() > timedelta(days=36)  # 30 + 7，而不是 7 / not just 7


def test_concurrent_pro_days_wins_both_land(world):
    """两个会话各自带着旧 user 抽中 PRO 天数：第二个必须在第一个的基础上加（审查探针）。
    Two sessions with stale users both win pro_days: the second adds on top of the first."""
    from sqlalchemy.orm import Session

    db, _a, u, r = world
    _prizes(db, r, dict(name="7 天", kind="pro_days", pro_days=7, prob_bp=10000),
            dict(name="谢谢", kind="none", prob_bp=0))
    _tickets(db, u, r, 2)
    uid, rid = u.id, r.id
    start = _now()
    sa, sb = Session(bind=db.get_bind()), Session(bind=db.get_bind())
    ua, ub = sa.get(User, uid), sb.get(User, uid)
    _ = (ua.plan, ub.plan, ub.plan_expires_at)
    spin.spin(sa, ua, rid, "req-aaaaaaa", rand_below=first)
    sa.commit()
    spin.spin(sb, ub, rid, "req-bbbbbbb", rand_below=first)
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
    pd, n = _prizes(db, r, dict(name="7 天", kind="pro_days", pro_days=7, prob_bp=9000),
                    dict(name="谢谢", kind="none", prob_bp=1000))
    _tickets(db, u, r, 1)
    uid = u.id
    _ = (u.plan, u.plan_expires_at)
    other = Session(bind=db.get_bind())
    ou = other.get(User, uid)
    ou.plan, ou.plan_expires_at = "PRO", None
    other.commit()
    other.close()
    assert spin.spin(db, u, r.id, "perm-1", rand_below=first).prize_id == n.id
    assert u.plan_expires_at is None


def test_spin_locks_only_this_rounds_prizes_in_id_order(world, monkeypatch):
    """奖项行只锁这一期的、按 id 排序加锁（v1 会把全站奖品都锁上）。用 SQL 记录来核对。
    Only this round's prize rows are locked, in id order (v1 locked every prize). Checked on the SQL."""
    from sqlalchemy import event

    db, admin, u, r = world
    other = _round(db, admin, name="别的期")
    _prizes(db, r, *NONE_RETRY)
    _prizes(db, other, *NONE_RETRY)
    _tickets(db, u, r, 1)
    sqls = []
    eng = db.get_bind()

    def grab(conn, cursor, statement, params, context, executemany):
        if "FROM lucky_wheel_prizes" in statement and "lucky_wheel_prizes.round_id" in statement:
            sqls.append((statement, params))
    event.listen(eng, "before_cursor_execute", grab)
    try:
        spin.spin(db, u, r.id, "lock-1", rand_below=first)
    finally:
        event.remove(eng, "before_cursor_execute", grab)
    locking = [s for s, _p in sqls if "ORDER BY lucky_wheel_prizes.id" in s]
    assert locking, sqls
    assert any(r.id in (p if isinstance(p, (list, tuple)) else p.values()) for _s, p in sqls)


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


def test_state_batches_include_ticket_without_batch(world):
    from app.models import LuckyTicketBatch
    from app.routers import lucky_wheel as lw

    db, admin, u, r = world
    _prizes(db, r, *NONE_RETRY)
    b = LuckyTicketBatch(round_id=r.id, reason="活动奖励", created_by=admin.id, request_id="batch-req-1")
    db.add(b)
    db.flush()
    db.add(LuckyTicket(user_id=u.id, round_id=r.id, source="manual", batch_id=b.id))
    db.add(LuckyTicket(user_id=u.id, round_id=r.id, source="retry"))
    db.add(LuckyTicket(user_id=u.id, round_id=r.id, source="retry"))
    db.commit()
    (entry,) = lw.user_state(db, u)["rounds"]
    t = entry["tickets"]
    assert t["unused"] == 3
    assert sum(x["count"] for x in t["batches"]) == 3
    assert [x for x in t["batches"] if x["reason"] is None][0]["count"] == 2


def test_route_state_lists_visible_rounds_for_users_and_all_open_for_admins(world):
    from app.routers import lucky_wheel as lw

    db, admin, u, r = world
    hidden = _round(db, admin, name="内测期", visible=False, starts=-2)
    later = _round(db, admin, name="下一期", starts=5, ends=48)           # 未开始也列出 / upcoming listed
    _round(db, admin, name="已结束", starts=-48, ends=-1)                 # 已结束不列 / ended not listed
    _prizes(db, r, dict(name="谢谢", kind="none", prob_bp=10000, stock=5), dict(name="再来", kind="retry", prob_bp=0))
    _tickets(db, u, r, 2)
    body = lw.user_state(db, u)
    assert [x["round"]["name"] for x in body["rounds"]] == ["第一期", "下一期"]   # 按开始时间升序 / by start
    first_, nxt = body["rounds"]
    assert first_["tickets"]["unused"] == 2 and len(first_["prizes"]) == 2
    assert set(first_["round"]) == {"id", "name", "startsAt", "endsAt", "phase"}  # 不给 mode / no mode
    assert nxt["round"]["phase"] == "upcoming" and nxt["prizes"] == []
    for p in first_["prizes"]:
        assert set(p) == {"id", "name", "description", "imageUrl", "color", "kind", "proDays"}
    admin_names = [x["round"]["name"] for x in lw.user_state(db, admin)["rounds"]]
    assert admin_names == ["内测期", "第一期", "下一期"] and hidden.id
    r.visible = False
    later.visible = False
    db.commit()
    assert lw.user_state(db, u) == {"rounds": []}


def test_route_spin_and_draws(world):
    from fastapi import HTTPException

    from app.routers import lucky_wheel as lw
    from app.schemas import LuckySpinIn

    db, _a, u, r = world
    _prizes(db, r, *NONE_RETRY)
    _tickets(db, u, r, 1)
    with pytest.raises(ValueError):
        LuckySpinIn(requestId="short", roundId=r.id)
    with pytest.raises(ValueError):
        LuckySpinIn(requestId="req-12345678")                                         # 要带期 / roundId required
    body = lw.user_spin(_request(), LuckySpinIn(requestId="req-12345678", roundId=r.id), db, u)
    assert body["prize"]["name"] == "谢谢" and body["ticketsLeft"] == 0 and body["slotIndex"] == 0
    assert body["soldOut"] is False and body["roundId"] == r.id and body["roundName"] == "第一期"
    assert body["round"] == {"id": r.id, "name": "第一期", "startsAt": r.starts_at, "endsAt": r.ends_at,
                             "phase": "active"}
    again = lw.user_spin(_request(), LuckySpinIn(requestId="req-12345678", roundId=r.id), db, u)   # 幂等
    assert again["id"] == body["id"]
    with pytest.raises(HTTPException) as e:                                           # 没券 / no ticket
        lw.user_spin(_request(), LuckySpinIn(requestId="req-87654321", roundId=r.id), db, u)
    assert e.value.status_code == 409
    with pytest.raises(HTTPException) as e:
        lw.user_spin(_request(), LuckySpinIn(requestId="req-00000404", roundId="missing"), db, u)
    assert e.value.status_code == 404
    draws = lw.user_draws(db, u)["draws"]
    assert [d["id"] for d in draws] == [body["id"]] and draws[0]["roundName"] == "第一期"
    assert draws[0]["soldOut"] is False


def test_route_spin_hidden_round_403_for_users(world):
    from fastapi import HTTPException

    from app.routers import lucky_wheel as lw
    from app.schemas import LuckySpinIn

    db, _a, u, r = world
    _prizes(db, r, *NONE_RETRY)
    _tickets(db, u, r, 1)
    r.visible = False
    db.commit()
    with pytest.raises(HTTPException) as e:
        lw.user_spin(_request(), LuckySpinIn(requestId="req-hidden-1", roundId=r.id), db, u)
    assert e.value.status_code == 403


def test_route_spin_sold_out_miss_reports_sold_out(world):
    from app.routers import lucky_wheel as lw
    from app.schemas import LuckySpinIn

    db, _a, u, r = world
    _prizes(db, r, dict(name="大奖", kind="custom", claim_mode="form", prob_bp=10000, stock=0),
            dict(name="谢谢", kind="none", prob_bp=0))
    _tickets(db, u, r, 1)
    body = lw.user_spin(_request(), LuckySpinIn(requestId="req-soldout1", roundId=r.id), db, u)
    assert body["soldOut"] is True and body["slotIndex"] == 0 and body["fulfillmentStatus"] == "auto_done"
    assert body["prize"]["name"] == "大奖" and body["ticketsLeft"] == 0


def test_pro_days_win_is_not_an_admin_activity_row(world):
    """最终评审 I1：抽中 PRO 天数不能在后台操作日志里变成「管理员 <普通用户> 改了会员到期」。
    到期日照常入账，审计写在专用字段 plan:lucky_*，活动日志整族不列。
    Final review I1: a PRO-days win must not surface as an admin action by the winning user. The
    expiry is still credited; the audit rows use the dedicated plan:lucky_* fields and the feed skips them."""
    from app.models import AdminAuditLog
    from app.services import activity_feed as feed

    db, _a, u, r = world
    free = _user(db, "free@t.co")                      # FREE 用户：升 PRO + 到期两行 / FREE: upgrade + expiry
    _prizes(db, r, dict(name="7 天", kind="pro_days", pro_days=7, prob_bp=10000),
            dict(name="谢谢", kind="none", prob_bp=0))
    _tickets(db, u, r, 1)
    _tickets(db, free, r, 1)
    spin.spin(db, u, r.id, "req-i1-a", rand_below=first)
    spin.spin(db, free, r.id, "req-i1-b", rand_below=first)
    db.commit()
    assert u.plan_expires_at is not None and free.plan == "PRO" and free.plan_expires_at is not None
    fields = {a.field for a in db.query(AdminAuditLog)}
    assert fields and all(f.startswith("plan:lucky") for f in fields)
    assert "plan_expires_at" not in fields and "plan" not in fields

    def shown(**kw):    # 注册行是测试造用户带出来的，与中奖无关 / registrations come from creating the users
        return [i for i in feed.list_activity(db, **kw)["items"] if i["kind"] != "user.register"]

    for cat in ("all", "admin", "account"):
        assert shown(cat=cat) == []
    assert shown(user_id=free.id) == []
