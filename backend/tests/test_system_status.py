"""管理后台「系统状态」页：后台循环健康记录 + 各部件定级。

System-status page: loop health records and per-component levels.
"""
import asyncio
import logging
import time
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from app.services import background, gateway_client, loop_health, quotes_store, shared_state, system_status
from app.services.deps import require_admin


@pytest.fixture(autouse=True)
def _memory_state(monkeypatch):
    shared_state.reset_for_tests()
    monkeypatch.setattr(shared_state, "enabled", lambda: False)
    loop_health._last_write.clear()
    yield
    loop_health._last_write.clear()
    shared_state.reset_for_tests()


# ---------------------------------------------------------------- loop_health


def test_beat_is_throttled_and_readable():
    loop_health.beat("competitions")
    first = loop_health.snapshot(["competitions"])["competitions"]["beatAt"]
    assert first is not None
    time.sleep(0.01)
    loop_health.beat("competitions")   # 10 秒内第二次：不写
    assert loop_health.snapshot(["competitions"])["competitions"]["beatAt"] == first


def test_error_handler_records_only_inside_loop_tasks():
    handler = loop_health.LoopErrorHandler()
    log = logging.getLogger("test.loop_health")
    log.addHandler(handler)
    try:
        async def _in_loop():
            try:
                raise ValueError("boom")
            except ValueError:
                log.exception("competition loop failed")

        async def main():
            await asyncio.create_task(_in_loop(), name="loop:competitions")
            await asyncio.create_task(_in_loop(), name="some-request")

        asyncio.run(main())
    finally:
        log.removeHandler(handler)

    snap = loop_health.snapshot(["competitions"])["competitions"]
    assert snap["errorAt"] is not None
    assert "competition loop failed" in snap["errorMessage"]
    assert "ValueError: boom" in snap["errorMessage"]


def test_crashed_loop_is_recorded_and_cleared_on_restart():
    async def dies():
        raise RuntimeError("kaput")

    async def main():
        loops = background.BackgroundLoops({"boards": dies}, owner="t")
        loops.start_all()
        await asyncio.sleep(0.01)
        crashed = loop_health.snapshot(["boards"])["boards"]["crashMessage"]
        loops.cancel_all()
        loops.start_all()           # 重新启动（换主/重启）清掉旧记录
        cleared = loop_health.snapshot(["boards"])["boards"]["crashAt"]
        loops.cancel_all()
        await asyncio.sleep(0.01)
        return crashed, cleared

    crashed, cleared = asyncio.run(main())
    assert "RuntimeError: kaput" in crashed
    assert cleared is None


def test_cancelled_loop_is_not_a_crash():
    async def forever():
        while True:
            await asyncio.sleep(1)

    async def main():
        loops = background.BackgroundLoops({"stale_orders": forever}, owner="t")
        loops.start_all()
        await asyncio.sleep(0.01)
        await loops.aclose()

    asyncio.run(main())
    assert loop_health.snapshot(["stale_orders"])["stale_orders"]["crashAt"] is None


# ---------------------------------------------------------------- 循环定级


def _app_with_loops(*names):
    loops = SimpleNamespace(names=list(names), is_leader=True)
    return SimpleNamespace(state=SimpleNamespace(background_loops=loops))


def _put(prefix, name, **rec):
    shared_state.kv_set_json(prefix + name, rec)


def test_loop_levels():
    now = time.time()
    app = _app_with_loops("competitions", "boards", "gamification", "stale_orders", "candle_retention")
    _put(loop_health.KEY_BEAT, "competitions", at=now - 30)                 # 正常
    _put(loop_health.KEY_BEAT, "boards", at=now - 2 * 300 - 121)            # 停了
    _put(loop_health.KEY_BEAT, "gamification", at=now - 60)
    _put(loop_health.KEY_ERROR, "gamification", at=now - 600, message="x")  # 一小时内报过错
    _put(loop_health.KEY_BEAT, "stale_orders", at=now - 5)
    _put(loop_health.KEY_CRASH, "stale_orders", at=now - 5, message="y")    # 崩了
    rows = {r["name"]: r for r in system_status._loops(app, now, uptime=10_000)}
    assert rows["competitions"]["level"] == "ok"
    assert rows["boards"]["level"] == "down"
    assert rows["gamification"]["level"] == "warn"
    assert rows["stale_orders"]["level"] == "down"
    # 一天一轮、还没跑过：刚启动时不算异常
    assert rows["candle_retention"]["level"] == "idle"


def test_loop_without_beat_long_after_start_is_warn():
    rows = system_status._loops(_app_with_loops("competitions"), time.time(), uptime=100_000)
    assert rows[0]["level"] == "warn"


# ---------------------------------------------------------------- gateway / 行情


def test_gateway_levels(monkeypatch):
    now = time.time()

    def probe(**kw):
        base = {"at": now - 3, "ok": True, "online": True, "detail": "", "monitorRunning": True,
                "body": {"ok": True, "mt5Connected": True, "dealerActive": True,
                         "readChannels": 2, "readChannelsConnected": 2}}
        base.update(kw)
        monkeypatch.setattr(gateway_client, "last_probe", lambda: base)

    probe()
    assert system_status._gateway(now)["level"] == "ok"
    probe(online=False, ok=False, body={"ok": False, "error": "timeout"}, detail="不可达")
    g = system_status._gateway(now)
    assert g["level"] == "down" and g["reachable"] is False and g["mt5Connected"] is None
    probe(body={"ok": True, "mt5Connected": True, "dealerActive": True,
                "readChannels": 4, "readChannelsConnected": 2})
    assert system_status._gateway(now)["level"] == "warn"
    probe(at=0)
    assert system_status._gateway(now)["level"] == "idle"


def test_feed_levels(monkeypatch):
    now = time.time()

    def feed(*rows):
        monkeypatch.setattr(quotes_store, "get_feed_state", lambda: list(rows))
        return asyncio.run(system_status._feed(now))

    f = feed(("XAUUSD", now - 2, False), ("BTCUSD", now - 1, False), ("USOIL", now - 3, True))
    assert f["level"] == "ok" and f["activeSymbols"] == 3 and f["closedSymbols"] == 1
    assert feed(("XAUUSD", now - 120, False))["level"] == "warn"
    assert feed(("XAUUSD", now - 3600, False))["level"] == "down"
    assert feed()["level"] == "idle"


def test_feed_state_in_memory_backend(monkeypatch):
    monkeypatch.setattr(quotes_store, "_quotes", {"XAUUSD": {"symbol": "XAUUSD", "closed": True}})
    monkeypatch.setattr(quotes_store, "_updated_at", {"XAUUSD": 123.0})
    assert quotes_store.get_feed_state() == [("XAUUSD", 123.0, True)]


# ---------------------------------------------------------------- 整页


def test_collect_whole_page(monkeypatch, tmp_path):
    # 文件库而不是内存库：collect 在线程池里查库，内存 SQLite 每个线程各是一个空库。
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    from app.models import MT5Account, Signal, User

    engine = create_engine(f"sqlite:///{tmp_path / 'status.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine)
    db_session = Session()
    monkeypatch.setattr(system_status, "engine", engine)
    monkeypatch.setattr(system_status, "SessionLocal", Session)
    monkeypatch.setattr(quotes_store, "get_feed_state", lambda: [("XAUUSD", time.time(), False)])

    u = User(id="u1", email="a@x.com", password_hash="x", api_token="tok-u1")
    db_session.add(u)
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    db_session.add(MT5Account(user_id="u1", login="1", server="s", source="bridge", last_heartbeat=now))
    db_session.add(MT5Account(user_id="u1", login="2", server="s", source="gateway"))
    db_session.add(Signal(symbol="XAUUSD", side="BUY", source="mt5", created_at=now - timedelta(minutes=5)))
    db_session.commit()

    app = _app_with_loops("competitions")
    loop_health.beat("competitions")
    out = asyncio.run(system_status.collect(app))

    c = out["components"]
    assert set(c) == {"backend", "database", "redis", "gateway", "feed", "signals", "loops", "online"}
    assert c["database"]["level"] == "ok"
    assert c["redis"]["level"] == "idle"          # 没配 Redis
    assert c["feed"]["level"] == "ok"
    assert c["signals"]["level"] == "ok" and 250 <= c["signals"]["lastAgoSec"] <= 400
    assert c["online"]["bridges"] == 1 and c["online"]["gatewayAccounts"] == 1
    assert out["loops"][0]["name"] == "competitions" and out["loops"][0]["level"] == "ok"
    assert out["overall"] in ("ok", "warn", "down", "idle")
    db_session.close()
    engine.dispose()


def test_collect_survives_broken_database(monkeypatch):
    class Boom:
        pool = None

        def connect(self):
            raise RuntimeError("db gone")

    def broken_session():
        raise RuntimeError("db gone")

    monkeypatch.setattr(system_status, "engine", Boom())
    monkeypatch.setattr(system_status, "SessionLocal", broken_session)
    monkeypatch.setattr(quotes_store, "get_feed_state", lambda: [])
    out = asyncio.run(system_status.collect(_app_with_loops()))
    assert out["components"]["database"]["level"] == "down"
    assert "db gone" in out["components"]["database"]["error"]
    assert out["components"]["signals"]["level"] == "warn"
    assert out["overall"] == "down"


def test_endpoint_requires_admin():
    from app.routers import admin

    route = next(r for r in admin.router.routes if r.path.endswith("/system-status"))
    assert require_admin in {d.call for d in route.dependant.dependencies}


# ---------------------------------------------------------------- 修复按钮 / fix buttons


def test_loop_restart_request_is_applied_by_the_leader_only():
    started = []

    async def forever(tag):
        started.append(tag)
        while True:
            await asyncio.sleep(1)

    async def main():
        loops = background.BackgroundLoops({"boards": lambda: forever("boards")}, owner="t")
        loops.start_all()
        await asyncio.sleep(0)
        first = loops._tasks["boards"]
        background.request_restart("boards")
        background.request_restart("no_such_loop")
        await loops._apply_restart_requests()
        await asyncio.sleep(0)
        second = loops._tasks["boards"]
        left = shared_state.set_members(background.RESTART_REQUEST_KEY)

        # 不是领导：不动，也不清掉请求（留给真正的领导）
        loops.is_leader = False
        background.request_restart("boards")
        await loops._apply_restart_requests()
        kept = shared_state.set_members(background.RESTART_REQUEST_KEY)
        loops.is_leader = True
        await loops.aclose()
        return first, second, left, kept

    first, second, left, kept = asyncio.run(main())
    assert first is not second and first.cancelled()
    assert started == ["boards", "boards"]
    assert left == []
    assert kept == ["boards"]


def _admin_user(db):
    from app.models import User

    u = User(id="adm", email="adm@x.com", password_hash="x", api_token="tok-adm", role="admin")
    db.add(u)
    db.commit()
    return u


def test_restart_loop_endpoint_validates_cools_down_and_audits(db_session):
    from fastapi import HTTPException

    from app.models import AdminAuditLog
    from app.routers import admin as admin_router

    admin = _admin_user(db_session)
    req = SimpleNamespace(app=_app_with_loops("boards"))

    with pytest.raises(HTTPException) as e:
        admin_router.ops_restart_loop(req, {"name": "nope"}, db_session, admin)
    assert e.value.status_code == 404

    assert admin_router.ops_restart_loop(req, {"name": "boards"}, db_session, admin) == {"scheduled": True}
    assert shared_state.set_members(background.RESTART_REQUEST_KEY) == ["boards"]
    with pytest.raises(HTTPException) as e:
        admin_router.ops_restart_loop(req, {"name": "boards"}, db_session, admin)
    assert e.value.status_code == 429

    rows = db_session.query(AdminAuditLog).all()
    assert [(r.field, r.new_value) for r in rows] == [("ops:restart-loop:boards", "scheduled")]


def test_refresh_competitions_endpoint(db_session, monkeypatch):
    from app.models import Competition
    from app.routers import admin as admin_router

    admin = _admin_user(db_session)
    now = datetime.now(timezone.utc)
    for i, st in enumerate(("running", "running", "upcoming")):
        db_session.add(Competition(id=f"c{i}", name=f"c{i}", status=st,
                                   starts_at=now - timedelta(days=1), ends_at=now + timedelta(days=1)))
    db_session.commit()
    seen = []
    monkeypatch.setattr(admin_router, "refresh_comp_board",
                        lambda db, comp, force=False: seen.append((comp.id, force)) or True)
    out = admin_router.ops_refresh_competitions(db_session, admin)
    assert out == {"running": 2, "refreshed": 2}
    assert sorted(seen) == [("c0", True), ("c1", True)]


def test_reconnect_gateway_endpoint(db_session, monkeypatch):
    from fastapi import HTTPException

    from app.models import AdminAuditLog
    from app.routers import admin as admin_router

    admin = _admin_user(db_session)
    engine = db_session.get_bind()
    monkeypatch.setattr(admin_router, "SessionLocal", lambda: type(db_session)(bind=engine))
    monkeypatch.setattr(admin_router, "run_in_threadpool", _run_inline)

    async def ok():
        return {"ok": True, "accepted": True}

    monkeypatch.setattr(gateway_client, "request_reconnect", ok)
    assert asyncio.run(admin_router.ops_reconnect_gateway(admin)) == {"accepted": True}

    shared_state.reset_for_tests()          # 清冷却，测失败路径

    async def down():
        return {"ok": False, "error": "connect refused"}

    monkeypatch.setattr(gateway_client, "request_reconnect", down)
    with pytest.raises(HTTPException) as e:
        asyncio.run(admin_router.ops_reconnect_gateway(admin))
    assert e.value.status_code == 502
    # 审计行的 id 是随机串，不能按 id 排先后；排序后比内容。
    results = sorted(r.new_value for r in db_session.query(AdminAuditLog).all())
    assert results[0] == "accepted" and results[1].startswith("failed")


async def _run_inline(fn, *args):
    return fn(*args)
