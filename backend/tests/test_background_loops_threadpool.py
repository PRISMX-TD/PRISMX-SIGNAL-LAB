"""两条后台循环不再把同步 DB 操作跑在事件循环上。

**为什么要测。** plan_expiry_sweep_loop（每 15 分钟）与 discipline_snapshot_loop
（每 6 小时）以前直接在事件循环里开 session、跑查询、逐用户算分——纪律分那条生产
实测首轮 1.3 秒，用户越多越久；这段时间里 WS 推送、bridge 轮询、gateway 事件泵
全部停摆。改法是把循环体抽成同步函数，循环只负责 `await run_in_threadpool(...)`。
这里钉住两件事：抽出来的函数本身行为正确（降级/写快照），以及循环确实是通过
线程池调它的（不是又悄悄写回事件循环）。

Both loops used to run synchronous DB work directly on the event loop; the
discipline one measured 1.3s per pass and grows with users, stalling every other
coroutine meanwhile. The bodies are now plain functions and the loops only
`await run_in_threadpool(fn)`. Pins: the extracted functions do their job, and
the loops really go through the thread pool.
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
import app.models  # noqa: F401
from app.models import AdminAuditLog, DisciplineSnapshot, MT5Account, Order, Signal, User
import app.services.discipline as disc
import app.services.plan_expiry as pe

NOW = datetime.now(timezone.utc)


@pytest.fixture()
def loop_db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(pe, "SessionLocal", Session)
    monkeypatch.setattr(disc, "SessionLocal", Session)
    yield Session
    engine.dispose()


def _user(db, email, plan="FREE", expires=None):
    u = User(email=email, api_token="tok_" + email, plan=plan,
             plan_expires_at=expires.replace(tzinfo=None) if expires else None)
    db.add(u); db.commit()
    return u.id


# ---- plan_expiry ----------------------------------------------------------------

def test_sweep_expired_plans_downgrades_only_expired(loop_db):
    db = loop_db()
    expired = _user(db, "exp@t.co", "PRO", NOW - timedelta(days=1))
    alive = _user(db, "ok@t.co", "PRO", NOW + timedelta(days=10))
    forever = _user(db, "inf@t.co", "PRO", None)
    db.close()

    assert pe.sweep_expired_plans(NOW) == 1
    assert pe.sweep_expired_plans(NOW) == 0          # 幂等 / idempotent

    db = loop_db()
    plans = {u.id: (u.plan, u.plan_expires_at) for u in db.query(User)}
    assert plans[expired] == ("FREE", None)
    assert plans[alive][0] == "PRO" and plans[forever] == ("PRO", None)
    audit = db.query(AdminAuditLog).filter_by(field="plan:auto_expire").all()
    assert [(a.target_user_id, a.old_value, a.new_value) for a in audit] == [(expired, "PRO", "FREE")]
    db.close()


# ---- discipline snapshot -----------------------------------------------------------

def test_snapshot_all_discipline_writes_aggregate_and_per_login_rows(loop_db):
    db = loop_db()
    uid = _user(db, "d@t.co")
    db.add(MT5Account(user_id=uid, login="1", server="s"))
    db.add(MT5Account(user_id=uid, login="2", server="s"))
    sig = Signal(symbol="XAUUSD", side="BUY", entry=100.0, stop_loss=99.0, take_profit=102.0,
                 indicator="x", source="test", external_id="e1",
                 expire_at=(NOW + timedelta(minutes=10)).replace(tzinfo=None))
    db.add(sig); db.commit()
    db.add(Order(user_id=uid, signal_id=sig.id, client_order_id="c1", symbol="XAUUSD",
                 side="BUY", volume=0.1, status="FILLED", mt5_login="1", mt5_ticket=11,
                 sl=99.0, created_at=(NOW - timedelta(days=1)).replace(tzinfo=None)))
    _user(db, "idle@t.co")                                   # 没信号单，不写快照
    db.commit(); db.close()

    n = disc.snapshot_all_discipline(today="2026-09-05")
    assert n == 3                                            # 聚合行 + 两个账号

    db = loop_db()
    rows = db.query(DisciplineSnapshot).filter_by(user_id=uid).all()
    assert {r.login for r in rows} == {"", "1", "2"}
    assert all(r.date == "2026-09-05" for r in rows)
    assert db.query(DisciplineSnapshot).count() == 3        # idle 用户没有行
    db.close()

    # 同一天再跑一次是更新不是新增 / rerun updates in place
    assert disc.snapshot_all_discipline(today="2026-09-05") == 3
    db = loop_db()
    assert db.query(DisciplineSnapshot).count() == 3
    db.close()


# ---- 循环走线程池 / loops go through the thread pool ------------------------------

def _run_one_iteration(monkeypatch, module, loop_coro, target_name, **kwargs):
    """跑到循环第一次 sleep 为止，记录 run_in_threadpool 收到的函数。"""
    seen: list = []

    async def fake_threadpool(fn, *a, **k):
        seen.append(fn)
        return 0

    class _Stop(Exception):
        pass

    async def fake_sleep(_secs):
        raise _Stop()

    monkeypatch.setattr(module, "run_in_threadpool", fake_threadpool)
    monkeypatch.setattr(module.asyncio, "sleep", fake_sleep)
    with pytest.raises(_Stop):
        asyncio.run(loop_coro(**kwargs))
    assert seen == [getattr(module, target_name)]


def test_plan_expiry_loop_uses_threadpool(monkeypatch):
    _run_one_iteration(monkeypatch, pe, pe.plan_expiry_sweep_loop, "sweep_expired_plans")


def test_discipline_loop_uses_threadpool(monkeypatch):
    _run_one_iteration(monkeypatch, disc, disc.discipline_snapshot_loop,
                       "snapshot_all_discipline", startup_delay=0)
