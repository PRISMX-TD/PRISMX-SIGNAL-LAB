"""数据库 / 缓存 / 多 worker 一致性（2026-09-25 这一轮）的回归测试。

覆盖：
- shared_cache：读缓存与跨 worker 版本号，Redis 出错时退回原行为；
- settings_store / 桥接 Token 鉴权 / 自动仓管资格：别的 worker 失效后，本 worker 在
  版本号变化后立即回源（Token 重置后旧 Token 被拒）；
- 自动仓管评估锁：跨 worker 短锁拿不到就跳过这一拍，Redis 出错退回进程内锁；
- 信号列表 / 统计 / 胜率的读缓存与新信号入库时的主动失效；
- 榜单：只取前 50、「我的名次」单独查、缓存与观众个性化字段分离、快照刷新删键；
- /me 全站计数缓存；
- rev 29 迁移：新增 signals 两条索引、删掉 candles 冗余索引；
- 网关撤销 / 解绑换掉账号映射版本号；
- GZip 与 CORS 预检缓存。

「别的 worker 做了失效」在单进程测试里的模拟方式：直接往 shared_state 写一个新的
版本串（那正是另一个 worker bump() 做的事），再清掉本地那 1 秒的版本缓存。

Regression tests for this round of DB / cache / multi-worker consistency work.
"Another worker invalidated" is simulated by writing a fresh version token into
shared_state (exactly what another worker's bump() does) and dropping the local
one-second version cache.
"""
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy.orm import sessionmaker

from app.services import shared_cache, shared_state


def _other_worker_bumps(version: shared_cache.SharedVersion) -> None:
    """模拟另一个 worker 执行了 version.bump()。/ Simulate another worker's bump()."""
    shared_state.kv_set(version._key, "bumped-elsewhere-" + datetime.now().isoformat())
    version.reset_local()


# ---------------------------------------------------------------------------
# shared_cache
# ---------------------------------------------------------------------------

def test_shared_version_detects_bump_and_survives_redis_errors(monkeypatch):
    v = shared_cache.SharedVersion("test-version")
    stamp = v.current()
    assert not v.is_stale(stamp)
    v.bump()
    assert v.is_stale(stamp)

    # Redis 出错：退回上一次读到的值，不抛；从没读到过就是 None，None 永不判旧。
    stamp2 = v.current()
    v.reset_local()

    def boom(*_a, **_kw):
        raise ConnectionError("redis down")

    monkeypatch.setattr(shared_state, "kv_get", boom)
    assert v.current() is None          # 本地缓存已清空，Redis 又读不到
    assert v.is_stale(stamp2) is False  # → 只按 TTL 过期，保持原行为
    monkeypatch.setattr(shared_state, "kv_set", boom)
    v.bump()                            # 失败只记日志，不抛


def test_cached_json_computes_when_redis_fails(monkeypatch):
    calls = []

    def compute():
        calls.append(1)
        return {"n": len(calls)}

    assert shared_cache.cached_json("t:k", 60, compute) == {"n": 1}
    assert shared_cache.cached_json("t:k", 60, compute) == {"n": 1}   # 命中
    shared_cache.delete("t:k")
    assert shared_cache.cached_json("t:k", 60, compute) == {"n": 2}

    def boom(*_a, **_kw):
        raise ConnectionError("redis down")

    monkeypatch.setattr(shared_state, "kv_get_json", boom)
    monkeypatch.setattr(shared_state, "kv_set_json", boom)
    monkeypatch.setattr(shared_state, "kv_delete", boom)
    assert shared_cache.cached_json("t:k", 60, compute) == {"n": 3}   # 直接回源
    shared_cache.delete("t:k")                                        # 不抛


# ---------------------------------------------------------------------------
# settings_store：别的 worker 保存了设置
# ---------------------------------------------------------------------------

def test_settings_cache_follows_invalidation_from_another_worker(db_session):
    from app.services import settings_store

    before = settings_store.get_pricing_settings(db_session)
    # 另一个 worker 写库并 commit（本进程的缓存没被它清）……
    settings_store.save_pricing_settings(db_session, {"pro_monthly_price": 123.0})
    db_session.commit()
    assert settings_store.get_pricing_settings(db_session) == before   # 仍是 30 秒缓存

    # ……然后在它那边 invalidate → 共享版本号变了，本进程下一次读取即回源。
    _other_worker_bumps(settings_store._settings_version)
    after = settings_store.get_pricing_settings(db_session)
    assert after != before


# ---------------------------------------------------------------------------
# 桥接 Token 鉴权缓存：重置后旧 Token 在所有 worker 上都被拒
# ---------------------------------------------------------------------------

def test_reset_token_on_another_worker_rejects_old_token_here(db_session):
    from app.core.security import hash_api_token
    from app.models import User
    from app.routers import bridge

    raw_old = "old-raw-token-for-cache-test"
    u = User(email="tok@t.co", password_hash="x", api_token=hash_api_token(raw_old))
    db_session.add(u)
    db_session.commit()
    uid = u.id

    assert bridge._authenticate_cached(db_session, raw_old).id == uid   # 进缓存

    # 另一个 worker 重置了 Token：库里换成新哈希、清了它自己的缓存、换了版本号。
    db_session.query(User).filter(User.id == uid).update({User.api_token: hash_api_token("new")})
    db_session.commit()
    # 版本号没变之前，本 worker 的缓存条目还在（这就是修复前那 10 秒的窗口）。
    assert bridge._authenticate_cached(db_session, raw_old) is not None

    _other_worker_bumps(bridge._auth_version)
    assert bridge._authenticate_cached(db_session, raw_old) is None     # 旧 Token 被拒
    assert bridge._authenticate_cached(db_session, "new").id == uid


def test_local_invalidation_bumps_shared_auth_version():
    from app.routers import bridge

    stamp = bridge._auth_version.current()
    bridge.invalidate_auth_cache_for_hash("some-hash")
    assert bridge._auth_version.is_stale(stamp)


# ---------------------------------------------------------------------------
# 自动仓管：资格缓存与评估锁
# ---------------------------------------------------------------------------

def test_eligibility_negative_cache_follows_other_worker(db_session):
    from app.models import AutoManageSettings, User
    from app.services import auto_manage

    u = User(email="am@t.co", password_hash="x", api_token="tok-am", plan="PRO")
    db_session.add(u)
    db_session.commit()
    assert auto_manage._is_eligible(db_session, u.id)[0] is False       # 否定结果进缓存

    db_session.add(AutoManageSettings(user_id=u.id, enabled=True))
    db_session.commit()
    assert auto_manage._is_eligible(db_session, u.id)[0] is False       # 仍命中否定缓存

    _other_worker_bumps(auto_manage._eligible_version)                  # 别处 invalidate_eligibility
    assert auto_manage._is_eligible(db_session, u.id)[0] is True


def test_eval_skips_when_another_worker_holds_the_lock(monkeypatch):
    from app.services import auto_manage

    ran = []
    monkeypatch.setattr(auto_manage, "_evaluate_positions_locked",
                        lambda db, uid, pos: ran.append(uid) or 7)
    assert shared_state.try_lock("auto_manage:u-lock", 10, owner="other-worker")
    try:
        assert auto_manage.evaluate_positions(None, "u-lock", [{"ticket": 1}]) == 0
        assert ran == []                                                # 跳过这一拍，不阻塞
    finally:
        shared_state.release_lock("auto_manage:u-lock", owner="other-worker")

    assert auto_manage.evaluate_positions(None, "u-lock", [{"ticket": 1}]) == 7
    # 用完即释放：紧接着的下一拍能拿到锁
    assert auto_manage.evaluate_positions(None, "u-lock", [{"ticket": 1}]) == 7
    assert ran == ["u-lock", "u-lock"]


def test_eval_same_process_threads_do_not_share_the_lock(monkeypatch):
    """锁 owner 每次调用唯一：try_lock 对同一 owner 可重入，若用 WORKER_ID，同进程
    里并发的第二份评估会「抢到」同一把锁。/ The owner is unique per call."""
    from app.services import auto_manage

    inner = []

    def nested(db, uid, pos):
        # 第一份评估还持锁时，同进程再来一份：必须被挡住（返回 0）
        inner.append(auto_manage.evaluate_positions(None, uid, pos))
        return 1

    monkeypatch.setattr(auto_manage, "_evaluate_positions_locked", nested)
    assert auto_manage.evaluate_positions(None, "u-nest", [{"ticket": 1}]) == 1
    assert inner == [0]


def test_eval_falls_back_to_local_lock_when_redis_fails(monkeypatch):
    from app.services import auto_manage

    def boom(*_a, **_kw):
        raise ConnectionError("redis down")

    monkeypatch.setattr(shared_state, "try_lock", boom)
    monkeypatch.setattr(auto_manage, "_evaluate_positions_locked", lambda db, uid, pos: 3)
    assert auto_manage.evaluate_positions(None, "u-fallback", [{"ticket": 1}]) == 3


# ---------------------------------------------------------------------------
# 信号接口的读缓存
# ---------------------------------------------------------------------------

def _signal(db, **kw):
    from app.models import Signal

    now = datetime.now(timezone.utc)
    s = Signal(symbol=kw.pop("symbol", "XAUUSD"), side="BUY", entry=1.0, stop_loss=0.9,
               take_profit=1.2, status=kw.pop("status", "ACTIVE"), source=kw.pop("source", "tradingview"),
               result=kw.pop("result", "PENDING"), created_at=kw.pop("created_at", now),
               expire_at=now + timedelta(minutes=5), **kw)
    db.add(s)
    db.commit()
    return s


def _user_with_plan(db, plan):
    from app.models import User

    u = User(email=f"{plan.lower()}@sig.co", password_hash="x", api_token=f"tok-{plan}", plan=plan)
    db.add(u)
    db.commit()
    return u


def test_signal_list_cached_per_tier_and_invalidated_on_new_signal(db_session):
    from app.routers.signals import list_signals

    pro = _user_with_plan(db_session, "PRO")
    free = _user_with_plan(db_session, "FREE")
    _signal(db_session, status="ACTIVE")
    _signal(db_session, status="EXPIRED")

    pro_first = list_signals(user=pro, db=db_session)
    free_first = list_signals(user=free, db=db_session)
    assert len(pro_first["signals"]) == 2
    assert len(free_first["signals"]) == 1          # FREE 只看得到已过期的，键分开
    assert isinstance(pro_first["signals"][0]["createdAt"], str)   # 已是 JSON 形状

    _signal(db_session, status="ACTIVE")
    assert len(list_signals(user=pro, db=db_session)["signals"]) == 2   # 10 秒缓存命中

    shared_cache.invalidate_signal_caches()          # webhook 落库后调用的就是它
    assert len(list_signals(user=pro, db=db_session)["signals"]) == 3


def test_webhook_persist_invalidates_signal_caches(db_session, monkeypatch):
    from app.routers import webhook

    monkeypatch.setattr(webhook, "SessionLocal", sessionmaker(bind=db_session.get_bind()))
    shared_cache.set_json(shared_cache.SIGNAL_LIST_KEY_REALTIME, {"signals": []}, 60)
    shared_cache.set_json(shared_cache.SIGNAL_WINRATE_KEY, {"x": 1}, 60)
    payload = webhook.TradingViewSignal(
        secret="s", symbol="XAUUSD", side="BUY", entry=1.0, stopLoss=0.9, takeProfit=1.2)
    deduped, data, _sig = webhook._persist_signal_sync(payload)
    assert deduped is None and data is not None
    assert shared_cache.get_json(shared_cache.SIGNAL_LIST_KEY_REALTIME) is None
    assert shared_cache.get_json(shared_cache.SIGNAL_WINRATE_KEY) is None


def test_signal_stats_and_winrate_are_cached(db_session):
    from app.routers.signals import signal_stats, signal_winrate

    u = _user_with_plan(db_session, "PRO")
    _signal(db_session, result="HIT_TP")
    first = signal_winrate(user=u, db=db_session)
    assert first["hitTp"] == 1 and first["winRate"] == 1.0
    stats = signal_stats(user=u, db=db_session)
    assert stats["total"] == 1

    _signal(db_session, result="HIT_SL")
    assert signal_winrate(user=u, db=db_session) == first               # 缓存
    shared_cache.invalidate_signal_caches()
    assert signal_winrate(user=u, db=db_session)["hitSl"] == 1
    assert signal_stats(user=u, db=db_session)["total"] == 2


# ---------------------------------------------------------------------------
# 榜单
# ---------------------------------------------------------------------------

def _lb_user(db, email):
    from app.models import User

    u = User(email=email, password_hash="x", api_token="tok_" + email)
    db.add(u)
    db.commit()
    return u


def _lb_row(db, u, login, rank, score, board="return_pct", period_key="2026-W36"):
    from app.models import LeaderboardSnapshot

    db.add(LeaderboardSnapshot(board=board, period_key=period_key, user_id=u.id,
                               mt5_login=login, rank=rank, score=score, sample=8))


def test_board_top50_limit_me_beyond_50_and_per_viewer_fields(db_session, monkeypatch):
    from app.routers import gamification

    users = [_lb_user(db_session, f"lb{i}@t.co") for i in range(60)]
    for i, u in enumerate(users, start=1):
        _lb_row(db_session, u, f"5000{i:02d}", i, 1.0 - i / 100)
    db_session.commit()

    builds = []
    real_base = gamification._board_base
    monkeypatch.setattr(gamification, "_board_base",
                        lambda *a, **kw: builds.append(1) or real_base(*a, **kw))

    viewer = users[54]                                           # 第 55 名：不在前 50
    p = gamification.build_leaderboard_payload(db_session, viewer, "return_pct", "2026-W36")
    assert len(p["rows"]) == 50
    assert p["me"] == {"rank": 55, "score": pytest.approx(0.45), "sample": 8, "login": "500055"}
    assert not any(r["isSelf"] for r in p["rows"])
    assert all("userId" not in r for r in p["rows"])             # §4.3：不下发 user_id
    assert "snapshotAt" in p

    # 第二位观众：前 50 走缓存（不再构造），isSelf 与账户号打码按这位观众现算。
    top = users[0]
    p2 = gamification.build_leaderboard_payload(db_session, top, "return_pct", "2026-W36")
    assert builds == [1]
    assert p2["rows"][0]["isSelf"] is True and p2["rows"][0]["login"] == "500001"
    assert p2["rows"][1]["isSelf"] is False and "**" in p2["rows"][1]["login"]
    assert p2["me"]["rank"] == 1

    # 管理端 reveal 不走缓存，且带真实身份字段
    admin_payload = gamification.build_leaderboard_payload(
        db_session, top, "return_pct", "2026-W36", reveal=True)
    assert builds == [1, 1]
    assert admin_payload["rows"][1]["userId"] == users[1].id


def test_snapshot_refresh_drops_board_cache(db_session):
    from app.services.gamification import boards, periods

    now = datetime.now(timezone.utc)
    keys = periods.active_period_keys(now)
    for key in keys:
        for board in ("return_pct", "win_rate"):
            shared_cache.set_json(boards.leaderboard_cache_key(board, key), {"rows": [], "snapshotAt": None}, 60)
    boards.snapshot_boards(db_session, now)
    for key in keys:
        for board in ("return_pct", "win_rate"):
            assert shared_cache.get_json(boards.leaderboard_cache_key(board, key)) is None


def test_me_sitewide_counts_cached(db_session):
    from app.models import User, UserBadge
    from app.routers import gamification

    u = _lb_user(db_session, "me@t.co")
    first = shared_cache.cached_json(gamification._SITEWIDE_COUNTS_KEY, 300,
                                     lambda: gamification._sitewide_badge_counts(db_session))
    assert first["population"] == 1 and first["tiers"] == []

    db_session.add(User(email="me2@t.co", password_hash="x", api_token="t2"))
    db_session.add(UserBadge(user_id=u.id, badge_id="first_trade", tier=1))
    db_session.commit()
    payload = gamification.build_me_payload(db_session, u, judge=False)
    assert payload["population"] == 1                            # 5 分钟缓存命中
    shared_cache.delete(gamification._SITEWIDE_COUNTS_KEY)
    payload = gamification.build_me_payload(db_session, u, judge=False)
    assert payload["population"] == 2


# ---------------------------------------------------------------------------
# 网关账号映射版本号
# ---------------------------------------------------------------------------

def test_gateway_revoke_and_remove_bump_accounts_version(db_session):
    from app.models import MT5Account, User
    from app.services import gateway_binding

    u = _lb_user(db_session, "gw@t.co")
    row = MT5Account(user_id=u.id, login="700001", server="", source="gateway")
    db_session.add(row)
    db_session.commit()

    stamp = gateway_binding.gateway_accounts_version.current()
    assert gateway_binding.revoke(db_session, row, "password_changed")
    assert gateway_binding.gateway_accounts_version.is_stale(stamp)

    stamp = gateway_binding.gateway_accounts_version.current()
    gateway_binding.mark_removed(db_session, row)
    assert gateway_binding.gateway_accounts_version.is_stale(stamp)


# ---------------------------------------------------------------------------
# rev 29 迁移
# ---------------------------------------------------------------------------

@pytest.fixture()
def rev28_engine(monkeypatch, tmp_path):
    """rev 28 时代的库：没有两条新的 signals 索引，candles 上还挂着冗余索引。"""
    from sqlalchemy import create_engine, text

    import app.core.database as db_mod
    import app.models  # noqa: F401
    from app.core.database import Base

    url = "sqlite:///" + str(tmp_path / "rev28.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("DROP INDEX IF EXISTS idx_signals_created_at"))
        conn.execute(text("DROP INDEX IF EXISTS idx_signals_source_created"))
        conn.execute(text(
            "CREATE INDEX idx_candle_symbol_interval_t ON candles(symbol, interval, t)"))
    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(db_mod, "SessionLocal",
                        sessionmaker(bind=eng, autocommit=False, autoflush=False))
    db_mod._write_schema_rev(28)
    yield eng
    eng.dispose()


def test_rev29_adds_signal_indexes_and_drops_duplicate_candle_index(rev28_engine):
    from sqlalchemy import inspect

    import app.core.database as db_mod

    assert db_mod.CURRENT_SCHEMA_REV == 29
    db_mod._migrate_columns()

    sig = {i["name"]: i["column_names"] for i in inspect(rev28_engine).get_indexes("signals")}
    assert sig["idx_signals_created_at"] == ["created_at"]
    assert sig["idx_signals_source_created"] == ["source", "created_at"]
    candle = {i["name"] for i in inspect(rev28_engine).get_indexes("candles")}
    assert "idx_candle_symbol_interval_t" not in candle
    assert db_mod._read_schema_rev() == 29

    # 强制重跑：幂等 / forced re-run stays idempotent
    db_mod._write_schema_rev(28)
    db_mod._migrate_columns()
    assert db_mod._read_schema_rev() == 29


def test_rev29_candle_drop_failure_does_not_abort_startup(rev28_engine, monkeypatch):
    import app.core.database as db_mod

    class _Broken:
        def __getattr__(self, name):
            raise RuntimeError("no locks for you")

    real = db_mod.engine
    monkeypatch.setattr(db_mod, "engine", _Broken())
    db_mod._drop_redundant_candle_index(is_postgres=False)   # 只记警告，不抛
    monkeypatch.setattr(db_mod, "engine", real)


def test_candidate_symbols_loose_index_scan_matches_distinct(db_session):
    from app.models import Candle
    from app.services.strategy import coverage

    for sym in ("XAUUSD", "BTCUSD", "EURUSD"):
        for t in (1, 2, 3):
            db_session.add(Candle(symbol=sym, interval="1m", t=t, o=1, h=1, l=1, c=1))
    db_session.add(Candle(symbol="BTCUSD", interval="5m", t=1, o=1, h=1, l=1, c=1))
    db_session.commit()
    coverage._symbols_cache = None
    try:
        assert coverage.symbols_with_history(db_session) == ["BTCUSD", "EURUSD", "XAUUSD"]
    finally:
        coverage._symbols_cache = None


# ---------------------------------------------------------------------------
# HTTP 层：GZip 与 CORS 预检缓存
# ---------------------------------------------------------------------------

def test_gzip_and_cors_preflight_max_age():
    from fastapi.testclient import TestClient

    from app.core.config import settings
    from app.main import app

    client = TestClient(app)   # 不进 lifespan（不用 with），不启动后台循环
    origin = settings.CORS_ORIGINS[0] if settings.CORS_ORIGINS else "https://localhost"
    pre = client.options(
        "/api/signals", headers={"Origin": origin, "Access-Control-Request-Method": "GET",
                                 "Access-Control-Request-Headers": "authorization"})
    assert pre.headers.get("access-control-max-age") == "86400"

    # 小响应不压缩（且保留 Content-Length）：GZip 若包在 SlowAPI 这个
    # BaseHTTPMiddleware 外面，每个响应都会被当成流式、连 41 字节也压；
    # OpenAPI 文档足够大，带 Accept-Encoding: gzip 时应被压缩。
    small = client.get("/", headers={"Accept-Encoding": "gzip"})
    assert "content-encoding" not in small.headers
    assert small.headers.get("content-length") == str(len(small.content))
    big = client.get("/openapi.json", headers={"Accept-Encoding": "gzip"})
    assert big.status_code == 200
    assert big.headers.get("content-encoding") == "gzip"
    assert "Accept-Encoding" in big.headers.get("vary", "")


# ---------------------------------------------------------------------------
# async 端点的同步查库挪进线程池
# ---------------------------------------------------------------------------

@pytest.fixture()
def threaded_session():
    """跨线程可用的内存库会话（StaticPool）：这几个端点真的会在线程池里查库，
    conftest 的 db_session 换个线程就是一个全新的空库。"""
    from sqlalchemy import create_engine
    from sqlalchemy.pool import StaticPool

    import app.models  # noqa: F401
    from app.core.database import Base

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autocommit=False, autoflush=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def test_create_payment_happy_path_runs_db_work_off_loop(threaded_session, monkeypatch):
    import asyncio

    from app.models import Payment, User
    from app.routers import payments

    async def fake_np_create(**_kw):
        return {"payment_id": 424242, "pay_amount": "49.0", "pay_address": "TAddr",
                "valid_until": "2026-09-25T12:00:00Z"}

    monkeypatch.setattr(payments, "np_create", fake_np_create)
    u = User(email="pay@t.co", password_hash="x", api_token="tok-pay")
    threaded_session.add(u)
    threaded_session.commit()

    out = asyncio.run(payments.create_payment_order.__wrapped__(
        body=payments.CreatePaymentRequest(plan="pro_monthly", pay_currency="usdttrc20"),
        request=None, _user=u, db=threaded_session))
    assert out["payment_id"] == "424242" and out["status"] == "PENDING"
    assert out["pay_address"] == "TAddr" and out["valid_until"] == "2026-09-25T12:00:00Z"
    assert list(out)[-1] == "valid_until"                 # 键序与改造前一致
    assert threaded_session.query(Payment).count() == 1


def test_admin_create_and_update_announcement(threaded_session, monkeypatch):
    import asyncio

    from app.models import User
    from app.routers import announcements
    from app.schemas import AnnouncementIn

    published = []

    async def fake_on_published(a, notify):
        published.append((a.id, a.title_zh))

    monkeypatch.setattr(announcements, "_on_published", fake_on_published)
    admin = User(email="adm@t.co", password_hash="x", api_token="tok-adm", role="admin")
    threaded_session.add(admin)
    threaded_session.commit()

    draft = AnnouncementIn(titleZh="草稿", titleEn="", published=False)
    out = asyncio.run(announcements.admin_create_announcement(
        body=draft, db=threaded_session, admin=admin))
    assert out.published is False and published == []

    live = AnnouncementIn(titleZh="上线", titleEn="", published=True)
    out2 = asyncio.run(announcements.admin_update_announcement(
        announcement_id=out.id, body=live, db=threaded_session, admin=admin))
    assert out2.published is True and out2.publishedAt is not None
    assert published == [(out.id, "上线")]

    from fastapi import HTTPException
    with pytest.raises(HTTPException) as exc:
        asyncio.run(announcements.admin_update_announcement(
            announcement_id="missing", body=live, db=threaded_session, admin=admin))
    assert exc.value.status_code == 404
