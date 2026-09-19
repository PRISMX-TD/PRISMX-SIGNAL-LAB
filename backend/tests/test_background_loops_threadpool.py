"""后台循环不把同步 DB 操作跑在事件循环上。

**为什么要测。** plan_expiry_sweep_loop（每 15 分钟）以前直接在事件循环里开
session、跑查询、逐用户算分；同期的 discipline_snapshot_loop（每 6 小时）生产实测
首轮 1.3 秒，用户越多越久——这段时间里 WS 推送、bridge 轮询、gateway 事件泵全部
停摆。改法是把循环体抽成同步函数，循环只负责 `await run_in_threadpool(...)`。
这里钉住两件事：抽出来的函数本身行为正确（降级/写快照），以及循环确实是通过
线程池调它的（不是又悄悄写回事件循环）。

**覆盖范围**（2026-09-19 校正）：本文件此前的 docstring 说「两条后台循环」，但
discipline_snapshot_loop 已随纪律勋章下线（`badges.LEGACY_DROPPED`），文件里实际
只剩 plan_expiry 一条。现在覆盖的是三条仍在跑的循环：
  · `plan_expiry.plan_expiry_sweep_loop`
  · `gamification.loop.gamification_loop`
  · `gamification.loop.competition_loop`
后两条同样走 `run_in_threadpool`（loop.py 里的两处），此前完全不在本文件的
覆盖范围内。

Pins: the extracted bodies do their job, and each loop really goes through the
thread pool. This file used to claim "both loops" while covering only
plan_expiry; discipline_snapshot_loop is gone (badges.LEGACY_DROPPED) and the two
gamification loops, which use run_in_threadpool the same way, were never covered.
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
import app.models  # noqa: F401
from app.models import AdminAuditLog, User
import app.services.plan_expiry as pe

NOW = datetime.now(timezone.utc)


@pytest.fixture()
def loop_db(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    monkeypatch.setattr(pe, "SessionLocal", Session)
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


def _run_gamification_style_loop(monkeypatch, loop_coro, target):
    """游戏化那两条循环的跑法与上面不同，所以另写一个跑法。

    两处差异：
      1. 它们在**第一个 await 之后**才 `from starlette.concurrency import
         run_in_threadpool`（main.py 对启动期零阻塞的约束），模块顶层没有这个
         名字可打补丁 —— 要打在 `starlette.concurrency` 上，函数按调用现场
         import 时才会捡到；
      2. 循环体前面先有一次 `await asyncio.sleep(startup_delay)`，所以要放过
         第一次 sleep、在第二次（轮询间隔）才停。
    """
    import starlette.concurrency as sc
    from app.services.gamification import loop as gl

    seen: list = []

    async def fake_threadpool(fn, *a, **k):
        seen.append(fn)
        return {}

    class _Stop(Exception):
        pass

    sleeps = {"n": 0}

    async def fake_sleep(_secs):
        sleeps["n"] += 1
        if sleeps["n"] >= 2:            # 1 = startup_delay，2 = 轮询间隔
            raise _Stop()

    monkeypatch.setattr(sc, "run_in_threadpool", fake_threadpool)
    monkeypatch.setattr(gl.asyncio, "sleep", fake_sleep)
    with pytest.raises(_Stop):
        asyncio.run(loop_coro(startup_delay=0))
    assert seen == [target]


def test_gamification_loop_uses_threadpool(monkeypatch):
    from app.services.gamification import loop as gl
    _run_gamification_style_loop(monkeypatch, gl.gamification_loop, gl.run_gamification_pass)


def test_competition_loop_uses_threadpool(monkeypatch):
    from app.services.gamification import loop as gl
    _run_gamification_style_loop(monkeypatch, gl.competition_loop, gl.run_competition_pass)



