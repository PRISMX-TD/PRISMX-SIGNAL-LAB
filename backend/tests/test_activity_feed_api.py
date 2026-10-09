"""操作日志两个端点（设计 2026-10-09 §5.1 / §5.2）：鉴权、零副作用、详情抽屉、kind 全覆盖。

  · 非管理员 403，router 自己与 main.py 挂载处都带 require_admin；
  · 两个端点全程没有 INSERT / UPDATE / DELETE（before_cursor_execute 计数）；
  · 详情：这笔仓位的完整经过、用户（含完整手机号）、账户（持有人、在线）、raw、各种 key；
  · 一份「什么都有」的数据：KINDS 里每一种 kind 都至少出现两次——契约文档里每个 kind 的
    两个例子就是从这里取的（设 ACTIVITY_FEED_EXAMPLES_OUT=<文件> 时把例子写出去）；
  · 每页 / 每次详情发几条语句（设计 §7 的实测数字；页尾大组的补取有上限）。

The two endpoints: auth, zero side effects (statement counter), the detail
drawer, a rich dataset proving every kind in KINDS is emitted at least twice
(the contract doc's examples are dumped from it when ACTIVITY_FEED_EXAMPLES_OUT
is set), and the statements per page / per detail quoted in design §7.
"""
import json
import os
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import Depends, FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base, get_db
from app.core.security import create_access_token
import app.models  # noqa: F401  —— 注册模型 / registers the tables
from app.models import (
    ActivityEvent, AdminAuditLog, Announcement, ClosedTrade, Competition, CompetitionParticipant,
    EmailCampaign, InviteLink, MT5Account, Order, Ticket, User,
)
from app.routers import admin_activity
from app.services import activity_feed as feed
from app.services import activity_log as al
from app.services import deps
from app.services.deps import require_admin

T0 = datetime(2026, 10, 9, 6, 0, 0)


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


@pytest.fixture(autouse=True)
def _offline_gateway(monkeypatch):
    # 详情里的「在线」不去真探 gateway / never probe a real gateway from the detail view
    monkeypatch.setattr(deps, "is_account_online", lambda row: row.source == "gateway")


def _client(db) -> TestClient:
    app = FastAPI()
    app.include_router(admin_activity.router, prefix="/api", dependencies=[Depends(require_admin)])
    app.dependency_overrides[get_db] = lambda: db
    return TestClient(app)


def _auth(user: User) -> dict:
    return {"Authorization": "Bearer " + create_access_token(user.id, user.token_version or 0)}


_seq = {"n": 0}


def _next() -> int:
    _seq["n"] += 1
    return _seq["n"]


def _user(db, email, *, at=T0 - timedelta(days=1), **kw) -> User:
    # last_active_at = 现在：鉴权链里的「活跃时间」节流写不会触发，计数器只看到读接口本身
    # last_active_at = now so the auth chain's throttled write never fires
    kw.setdefault("last_active_at", datetime.now(timezone.utc).replace(tzinfo=None))
    u = User(email=email, api_token="tok_" + email, created_at=at, **kw)
    db.add(u)
    db.commit()
    return u


def _acc(db, user, login, *, source="gateway", trade_mode=2, **kw) -> MT5Account:
    kw.setdefault("server", "MakeCapital-Live")
    a = MT5Account(user_id=user.id, login=login, source=source, trade_mode=trade_mode, **kw)
    db.add(a)
    db.commit()
    return a


def _order(db, user, *, at, action="ORDER", status="FILLED", login, cid=None, **kw) -> Order:
    kw.setdefault("symbol", "XAUUSD")
    kw.setdefault("side", "BUY")
    kw.setdefault("volume", 0.1)
    o = Order(user_id=user.id, client_order_id=cid or f"co_{_next()}_x", action=action, status=status,
              mt5_login=login, created_at=at, **kw)
    db.add(o)
    db.commit()
    return o


def _deal(db, user, *, at, login, pos, reason, closed_at=None, **kw) -> ClosedTrade:
    kw.setdefault("symbol", "XAUUSD")
    kw.setdefault("side", "BUY")
    kw.setdefault("close_volume", 0.1)
    kw.setdefault("close_price", 2400.0)
    kw.setdefault("profit", -5.0)
    t = ClosedTrade(user_id=user.id, mt5_login=login, position_ticket=pos, deal_ticket=70000000 + _next(),
                    closed_at=closed_at or at - timedelta(seconds=1), created_at=at, reason=reason, **kw)
    db.add(t)
    db.commit()
    return t


def _audit(db, actor, target, field, old, new, *, at, op=None) -> AdminAuditLog:
    a = AdminAuditLog(admin_user_id=actor.id, target_user_id=target.id, field=field,
                      old_value=old, new_value=new, created_at=at, op_id=op)
    db.add(a)
    db.commit()
    return a


def _event(db, kind, user, *, at, login=None, data=None, actor_type="user", ref=None) -> ActivityEvent:
    e = ActivityEvent(kind=kind, user_id=user.id, actor_type=actor_type,
                      actor_id=user.id if actor_type == "user" else None, mt5_login=login, ref_id=ref,
                      data=al.encode_data(data), created_at=at)
    db.add(e)
    db.commit()
    return e


# ── 鉴权 / auth ──────────────────────────────────────────────────────────────

def test_non_admin_gets_403_and_admin_200(db):
    admin = _user(db, "admin@t.co", role="admin")
    user = _user(db, "u@t.co")
    c = _client(db)
    assert c.get("/api/admin/activity", headers=_auth(user)).status_code == 403
    assert c.get("/api/admin/activity/item?key=u:x", headers=_auth(user)).status_code == 403
    assert c.get("/api/admin/activity").status_code == 401
    res = c.get("/api/admin/activity", headers=_auth(admin))
    assert res.status_code == 200
    assert set(res.json()) == {"items", "next"}


def test_router_and_mount_both_carry_require_admin(monkeypatch):
    # 先撤掉本文件 autouse 打在 deps.is_account_online 上的替身再 import app.main：若这是进程里
    # 第一次 import，orders / bridge 会 `from deps import is_account_online` 把替身永久绑走（用例结束
    # 也还原不了），之后 orders 的单账号兜底认不出在线的桥接账号，别的用例跟着按顺序失败。
    # Undo this file's autouse stand-in for deps.is_account_online before importing
    # app.main: on a first import, orders / bridge `from deps import is_account_online`
    # would bind the stand-in for good (monkeypatch can't restore it), breaking the
    # single-online-account fallback for whichever test runs later.
    monkeypatch.undo()
    from app import main as app_main

    def guarded(route: APIRoute) -> bool:
        return require_admin in {d.call for d in route.dependant.dependencies}

    assert all(guarded(r) for r in admin_activity.router.routes)
    mounted = [r for r in app_main.app.routes if isinstance(r, APIRoute) and "/admin/activity" in r.path]
    assert {r.path for r in mounted} == {"/api/admin/activity", "/api/admin/activity/item"}
    assert all(guarded(r) for r in mounted)


def test_bad_parameters_are_400_or_422(db):
    admin = _user(db, "admin@t.co", role="admin")
    c = _client(db)
    h = _auth(admin)
    assert c.get("/api/admin/activity?cat=nope", headers=h).status_code == 400
    assert c.get("/api/admin/activity?cursor=%%%", headers=h).status_code == 400
    assert c.get("/api/admin/activity?since=yesterday", headers=h).status_code == 400
    assert c.get("/api/admin/activity?limit=101", headers=h).status_code == 422
    assert c.get("/api/admin/activity/item?key=zz:1", headers=h).status_code == 400
    assert c.get("/api/admin/activity/item?key=o:missing", headers=h).status_code == 404
    assert c.get("/api/admin/activity/item?key=o:missing&cat=nope", headers=h).status_code == 400
    # 偏移把日期推出公元 1–9999 年：400，不是 500 / out-of-range offsets are 400, not 500
    for p in ({"since": "0001-01-01T00:00:00+01:00"}, {"until": "9999-12-31T23:59:59-01:00"}):
        assert c.get("/api/admin/activity", params=p, headers=h).status_code == 400


def test_postgres_gets_a_statement_timeout():
    seen = []

    class _Dialect:
        name = "postgresql"

    class _Bind:
        dialect = _Dialect()

    class _Db:
        def get_bind(self):
            return _Bind()

        def execute(self, stmt):
            seen.append(str(stmt))

    feed._set_timeout(_Db())
    assert seen == ["SET LOCAL statement_timeout = '5s'"]


def test_nul_and_lone_surrogates_are_400(db):
    # psycopg2 拒绝绑定含 NUL 的字符串（SQLite 照收），孤立代理两种驱动都编码失败：本地 Postgres
    # 实测这些输入在修之前全是 500。这里在 SQLite 上钉住「一律 400，不进数据库」。
    # psycopg2 refuses NUL in a bound string (SQLite accepts it) and no driver can
    # encode a lone surrogate: on a local Postgres every input below was a 500 before
    # the fix. Pin "always 400, never reaches the database" on SQLite.
    admin = _user(db, "admin@t.co", role="admin")
    c = _client(db)
    h = _auth(admin)
    t = datetime(2026, 10, 1)
    lists = [
        {"q": "ab\x00c"}, {"q": "1234\x005678"}, {"user_id": "a\x00b"}, {"login": "5000\x000001"},
        {"since": "2026-10-01T00:00:00\x00"}, {"until": "2026-10-01\x00"},
        {"cursor": feed.encode_cursor({"o": (t, "ab\x00cd")})},
        {"cursor": feed.encode_cursor({"o": (t, "a\ud800")})},
    ]
    for p in lists:
        r = c.get("/api/admin/activity", params=p, headers=h)
        assert r.status_code == 400, (p, r.status_code, r.text)
    items = [
        {"key": "o:ab\x00c"}, {"key": "t:abc:\x00"}, {"key": "e:abc\x00"}, {"key": "u:\x00"},
        {"key": "g:abc", "q": "a\x00"}, {"key": "a:abc", "user_id": "u\x00"},
    ]
    for p in items:
        r = c.get("/api/admin/activity/item", params=p, headers=h)
        assert r.status_code == 400, (p, r.status_code, r.text)
    # 正常输入不受影响 / ordinary input is unaffected
    assert c.get("/api/admin/activity", params={"q": "ab c"}, headers=h).status_code == 200
    assert c.get("/api/admin/activity/item", params={"key": "o:missing"}, headers=h).status_code == 404


def test_statement_timeout_is_503_not_500(db, monkeypatch):
    # Postgres 上 SET LOCAL statement_timeout 到点 = QueryCanceled（SQLSTATE 57014），SQLAlchemy
    # 包成 OperationalError；修之前没人接，管理员看到裸 500。别的数据库错误照旧往外抛。
    # On Postgres the per-request statement_timeout surfaces as QueryCanceled
    # (SQLSTATE 57014) wrapped in OperationalError; it used to be a bare 500.
    # Any other database error still propagates.
    from sqlalchemy.exc import OperationalError

    class _Orig(Exception):
        def __init__(self, msg, pgcode):
            super().__init__(msg)
            self.pgcode = pgcode

    def boom(pgcode):
        def _f(*a, **kw):
            raise OperationalError("SELECT 1", {}, _Orig("canceling statement due to statement timeout", pgcode))
        return _f

    admin = _user(db, "admin@t.co", role="admin")
    c = _client(db)
    h = _auth(admin)
    monkeypatch.setattr(feed, "list_activity", boom("57014"))
    monkeypatch.setattr(feed, "get_item", boom("57014"))
    for path in ("/api/admin/activity", "/api/admin/activity/item?key=o:x"):
        r = c.get(path, headers=h)
        assert r.status_code == 503, (path, r.status_code, r.text)
        assert r.headers.get("retry-after") == "2"
        assert "查询超时" in r.json()["detail"]
    monkeypatch.setattr(feed, "list_activity", boom("08006"))
    monkeypatch.setattr(feed, "get_item", boom(None))
    for path in ("/api/admin/activity", "/api/admin/activity/item?key=o:x"):
        with pytest.raises(OperationalError):
            c.get(path, headers=h)


def test_user_search_cap_puts_null_created_at_last(db):
    # 搜人最多 20 个、最新注册的优先；created_at 为空的老用户必须排最后。Postgres 倒序默认
    # NULLS FIRST（SQLite 是排最后），所以 SQL 里要写明 NULLS LAST——两边才一致。
    # The 20-user cap keeps the newest; NULL created_at goes last. Postgres sorts
    # NULLs first in DESC (SQLite last), so the SQL must say NULLS LAST.
    from sqlalchemy import text

    newest = [_user(db, f"hunter{i}@t.co", nickname=f"黄金猎手{i}", at=T0 - timedelta(hours=i)) for i in range(25)]
    legacy = [_user(db, f"legacy{i}@t.co", nickname=f"黄金猎手老{i}") for i in range(2)]
    for u in legacy:
        db.execute(text("UPDATE users SET created_at = NULL WHERE id = :i"), {"i": u.id})
    db.commit()
    seen: list[str] = []
    bind = db.get_bind()

    def _rec(conn, cursor, statement, *a):
        seen.append(statement)

    event.listen(bind, "before_cursor_execute", _rec)
    try:
        got = feed._search_users(db, User.nickname.ilike("%黄金猎手%"))
    finally:
        event.remove(bind, "before_cursor_execute", _rec)
    assert got == [u.id for u in newest[:20]]
    assert any("NULLS LAST" in s.upper() for s in seen), seen


# ── 一份「什么都有」的数据 / a dataset with everything ─────────────────────────

def _scenario(db, i: int, admin: User, agent: User, helper: User, comp: Competition, base: datetime) -> dict:
    """一个交易用户在一个下午里能留下的全部痕迹（两个场景各一遍，每种 kind 至少两次）。
    Everything one trader can leave behind in an afternoon (run twice)."""
    m = lambda minutes, s=0: base + timedelta(minutes=minutes, seconds=s)  # noqa: E731
    nick = ("Lucas", "美琳")[i]
    login = ("51234567", "62345678")[i]
    source = ("gateway", "bridge")[i]
    google = i == 1
    u = _user(db, (f"lucas@example.com", f"meilin@example.com")[i], nickname=nick, at=base,
              phone=("+60123456789", "+8613800138000")[i], invite_code="fb2026oc",
              google_linked_at=base if google else None, plan="PRO", plan_expires_at=base + timedelta(days=30))
    _acc(db, u, login, source=source, trade_mode=(2, 0)[i], account_name=nick)
    out = {"user": u, "login": login}
    if google:
        _audit(db, u, u, "plan:invite_trial", "FREE", "PRO(7d)", at=base + timedelta(milliseconds=4))
    # 账户 / account events
    _event(db, al.USER_LOGIN, u, at=m(1), data={"method": "google" if google else "password", "new_source": True})
    _event(db, al.USER_EMAIL_VERIFIED, u, at=m(2), data={"method": ("link", "reset")[i]})
    _audit(db, u, u, "plan:invite_trial", "FREE", "PRO(7d)", at=m(2, 1))
    _event(db, al.USER_PASSWORD_RESET_REQUESTED, u, at=m(3), data={})
    _event(db, al.USER_PASSWORD_RESET, u, at=m(4), data={})
    _event(db, al.USER_PASSWORD_CHANGED, u, at=m(5), data={"first_set": google})
    _event(db, al.USER_NICKNAME, u, at=m(6), data={"old": None if i == 0 else "meilin", "new": nick})
    _event(db, al.USER_PHONE_SET, u, at=m(7), data={})
    # MT5 绑定 / binding
    _event(db, al.MT5_BIND, u, at=m(8), login=login, data={
        "ch": source, "revived": i == 1, "name": nick, "demo": i == 1, "bal": (10250.5, 5000.0)[i],
        "server": None if source == "gateway" else "MakeCapital-Demo"})
    _event(db, al.MT5_REVOKED, u, at=m(9), login=login, actor_type="system",
           data={"reason": "password_changed", **({"bf": 1} if i == 1 else {})})
    _event(db, al.MT5_REVERIFY, u, at=m(10), login=login, data={"ch": "gateway"})
    _event(db, al.MT5_UNBIND, u, at=m(11), login="59999999", data={"ch": source, "name": "旧账户", "bal": 12.3})
    _event(db, al.USER_API_TOKEN_RESET, u, at=m(12), data={})
    _event(db, al.AUTO_SETTINGS, u, at=m(13), data={"changes": [
        {"field": "enabled", "old": False, "new": True}, {"field": "trail_trigger_r", "old": 1.5, "new": 2.0}]})
    # 开仓 / opens
    pos = 880000 + i * 100
    _order(db, u, at=m(20), login=login, symbol="XAUUSD", side="BUY", volume=0.1, filled_price=2401.35,
           sl=2390.0, tp=2425.0, mt5_ticket=pos, mt5_position=pos, signal_id=None)
    _order(db, u, at=m(21), login=login, symbol="EURUSD", side="SELL", volume=0.5, filled_price=1.08452,
           mt5_position=pos + 1, source="STRATEGY",
           message=("" if i else "成交了，但 SL/TP 设置失败: Invalid stops"))
    _order(db, u, at=m(22), login=login, symbol="GBPUSD", status="REJECTED", message="MT_RET_REQUEST_NO_MONEY: 资金不足")
    # 挂单 / pending orders
    _order(db, u, at=m(23), login=login, action="PENDING", status="PLACED", side="SELL", volume=0.2, price=2450.0,
           pending_type="SELL_LIMIT", sl=2460.0, tp=2410.0, mt5_ticket=pos + 5, mt5_position=pos + 5)
    # 第二个场景是图表上真实的形状：只拖了触发价，止损止盈没传（保留现值）
    # The second run is the chart's real shape: only the trigger dragged, SL/TP not sent
    _order(db, u, at=m(24), login=login, action="MODIFY_PENDING", side="BUY", volume=0.0, ticket=pos + 5,
           price=2455.0, sl=None if i else 2465.0, tp=None if i else 2410.0)
    _order(db, u, at=m(25), login=login, action="CANCEL_PENDING", side="BUY", volume=0.0, ticket=pos + 5)
    # 改止损止盈 / SL-TP
    _order(db, u, at=m(26), login=login, action="MODIFY", ticket=pos, volume=0.0, sl=2395.0, tp=2425.0,
           prev_sl=2390.0, prev_tp=2425.0, pos_volume=0.1)
    _order(db, u, at=m(27), login=login, action="MODIFY", ticket=pos + 1, side="SELL", symbol="EURUSD", volume=0.0,
           sl=1.0900, tp=0.0, prev_sl=0.0, prev_tp=1.0700, pos_volume=0.5)
    # 自动仓管 / auto-management
    _order(db, u, at=m(28), login=login, action="MODIFY", cid=f"auto_be_{pos}_a1b2c3d4", ticket=pos, volume=0.0,
           sl=2401.35, tp=2425.0, prev_sl=2395.0, prev_tp=2425.0)
    for k in range(3):
        _order(db, u, at=m(29 + k), login=login, action="MODIFY", cid=f"auto_trail_{pos}_{k:08d}", ticket=pos,
               volume=0.0, sl=2403.0 + k, tp=2425.0, prev_sl=2401.35 if k == 0 else 2402.0 + k, prev_tp=2425.0)
    _order(db, u, at=m(33), login=login, action="CLOSE", cid=f"auto_tp_{pos}_e5f6a7b8", ticket=pos, volume=0.05,
           pos_volume=0.1, filled_price=2412.0)
    _deal(db, u, at=m(33, 2), login=login, pos=pos, reason="DEALER" if source == "gateway" else "EXPERT",
          comment="PRISMX-CHART" if source == "gateway" else "PRISMX close", close_volume=0.05, profit=53.25)
    # 平仓 / closes
    _order(db, u, at=m(34), login=login, action="CLOSE", ticket=pos + 1, side="SELL", symbol="EURUSD", volume=0.0,
           pos_volume=0.5, filled_price=1.0821)
    _deal(db, u, at=m(34, 1), login=login, pos=pos + 1, symbol="EURUSD", side="SELL", reason="DEALER",
          comment="PRISMX-STRAT", close_volume=0.5, close_price=1.0821, profit=121.0)
    _order(db, u, at=m(35), login=login, action="CLOSE", ticket=pos + 2, volume=0.1, status="FILLED",
           message="Position already closed" if i else "", pos_volume=0.3)
    # 一键平仓 / close-all
    batch = f"ca_co_{i}_batch"
    for k in range(3):
        _order(db, u, at=m(36), login=login, action="CLOSE", cid=f"{batch}#{login}#{pos + 10 + k}",
               ticket=pos + 10 + k, volume=0.0, status="REJECTED" if k == 2 else "FILLED",
               message="MT_RET_REQUEST_REJECT" if k == 2 else "", filled_price=None if k == 2 else 2405.0)
    _deal(db, u, at=m(36, 1), login=login, pos=pos + 10, reason="DEALER", comment="PRISMX-CHART", profit=12.0)
    _event(db, al.TRADE_CLOSE_ALL, u, at=m(36), login=login, ref=batch, data={"count": 3, "skipped": 0})
    # 结果更正 / correction
    late = _order(db, u, at=m(37), login=login, symbol="USDJPY", volume=0.2, filled_price=149.32)
    # 网关超时是「结果未知」，桥接超时是「已自动取消」（gateway_execute.correction_note）
    # a gateway timeout was "outcome unknown", a bridge timeout "auto-cancelled"
    _event(db, al.TRADE_CORRECTED, u, at=m(39), login=login, actor_type="system", ref=late.id, data={
        "was": "FAILED", "action": "ORDER", "sym": "USDJPY", "side": "BUY", "vol": 0.2, "px": 149.32,
        "at": al.iso_utc(m(37)), "note": ("timeout_unknown", "timeout")[i]})
    # 未知动作 / an unknown action
    _order(db, u, at=m(38), login=login, action="HEDGE", status="PENDING")
    # MT5 侧平仓 / MT5-side closes
    _deal(db, u, at=m(40), login=login, pos=pos + 20, reason="SL", profit=-48.5, close_price=2385.0,
          closed_at=m(40) - timedelta(minutes=25) if i else None)
    _deal(db, u, at=m(41), login=login, pos=pos + 21, reason="MOBILE", profit=8.2)
    for k in range(3):
        _deal(db, u, at=m(42, k * 5), login=login, pos=pos + 30 + k, reason="SO", profit=-310.0 - k)
    # 管理员与系统 / admin and system
    _audit(db, admin, u, "plan", "FREE", "PRO", at=m(50), op=f"p{i}")
    _audit(db, admin, u, "plan_expires_at", "", "2026-11-09 06:00:00", at=m(50), op=f"p{i}")
    _audit(db, admin, u, "plan_note", "", "KOL 合作", at=m(50), op=f"p{i}")
    _audit(db, admin, u, "role", "user", "admin", at=m(51), op=f"r{i}")
    _audit(db, admin, u, "invite_code", "fb2026oc", "wx2026gp", at=m(52), op=f"i{i}")
    _audit(db, admin, u, "role", "admin", "user", at=m(53), op=f"m{i}")
    _audit(db, admin, u, "plan_note", "KOL 合作", "", at=m(53), op=f"m{i}")
    _audit(db, admin, u, "account:disable", '{"disabledAt": null, "reason": null}',
           '{"disabledAt": "2026-10-09T08:54:00", "reason": "刷单"}', at=m(54), op=f"d{i}")
    _audit(db, admin, u, "account:enable", '{"disabledAt": "2026-10-09T08:54:00", "reason": "刷单"}',
           '{"disabledAt": null, "reason": null}', at=m(55), op=f"e{i}")
    _audit(db, admin, u, "account:verify_email", "unverified", "verified", at=m(56), op=f"v{i}")
    _audit(db, u, u, "plan:trial_claim", "FREE", "PRO(7d)", at=m(57))
    _audit(db, u, u, "plan:payment", "FREE(None)", "PRO(2026-11-09 06:00:00+00:00)", at=m(58))
    _audit(db, u, u, "plan:refund", "PRO(2026-11-09 06:00:00)", "FREE(None)", at=m(59))
    _audit(db, u, u, ("payment:finished_mismatch", "plan:refund_skipped")[i],
           ("waiting", "PRO(None)")[i], ("actually_paid 9 < pay_amount 10", "skip:covered_by_other_payment")[i],
           at=m(60))
    _audit(db, u, u, "plan:auto_expire", "PRO", "FREE", at=m(61))
    _audit(db, u, u, "plan:auto_expire", "PRO", "FREE", at=m(61, 30))   # 重复，会被收掉 / a duplicate
    _audit(db, admin, admin, ("setting:pricing:monthly", "setting:broker_lock_enabled")[i],
           ("29", "false")[i], ("39", "true")[i], at=m(62), op=f"s{i}")
    _audit(db, admin, admin, ("gamification:competitions_public_enabled", "gamification:min_trades_return")[i],
           ("false", "5")[i], ("true", "8")[i], at=m(63), op=f"gm{i}")
    _audit(db, admin, admin, ("ops:restart-loop:candles", "ops:refresh-competitions")[i], "",
           ("scheduled", "2/2")[i], at=m(64), op=f"ops{i}")
    _audit(db, admin, admin, "invite:fb2026oc", "" if i == 0 else '{"label": "FB 十月投放", "isActive": true}',
           '{"label": "FB 十月投放", "isActive": true, "grantsTrial": true, "competitionId": null, "channel": "FB", '
           '"openAccountUrl": null}' if i == 0 else '{"label": "FB 十月投放", "isActive": false}',
           at=m(65), op=f"il{i}")
    _audit(db, admin, agent, "invite:fb2026oc:agent", "" if i == 0 else "assigned", "assigned" if i == 0 else "",
           at=m(66), op=f"aa{i}")
    _audit(db, agent, u, "agent:fb2026oc:plan", "FREE", "PRO", at=m(67), op=f"ap{i}")
    _audit(db, agent, u, "agent:fb2026oc:plan_expires_at", "", "2026-11-08 09:07:00", at=m(67), op=f"ap{i}")
    _audit(db, agent, u, "agent:fb2026oc:extend_days", "0", "30", at=m(67), op=f"ap{i}")
    if i == 0:
        _audit(db, admin, admin, f"competition:{comp.id}:create", "", comp.name, at=m(68), op="c0")
    else:
        _audit(db, admin, admin, f"competition:{comp.id}:status", "upcoming", "running", at=m(68), op="c1")
        _audit(db, admin, admin, f"competition:{comp.id}:endsAt", "2026-11-09 00:00:00",
               "2026-11-10 00:00:00+00:00", at=m(68), op="c1")
    part = CompetitionParticipant(competition_id=comp.id, user_id=u.id, mt5_login=login)
    db.add(part)
    db.commit()
    _audit(db, admin, u, f"competition:participant:{part.id}:" + ("disqualified" if i == 0 else "nameHidden"),
           "False:None" if i == 0 else "False", "True:刷量" if i == 0 else "True", at=m(69), op=f"cp{i}")
    ann = Announcement(title_zh=("国庆维护公告", "十月比赛开赛")[i], title_en="Notice")
    camp = EmailCampaign(created_by=admin.id, subject_zh=("十月活动", "维护通知")[i], kind=("marketing", "notice")[i])
    ticket = Ticket(user_id=u.id, title=("出金还没到账", "绑定失败")[i], category="payment")
    db.add_all([ann, camp, ticket])
    db.commit()
    _audit(db, admin, admin, "announcement:create" if i == 0 else "announcement:update",
           "" if i == 0 else '{"published": false}', f'{{"id": "{ann.id}", "published": true}}', at=m(70), op=f"an{i}")
    _audit(db, admin, admin, "email:send" if i == 0 else "email:cancel", "" if i == 0 else "sending",
           f'{{"id": "{camp.id}", "kind": "marketing", "recipients": 128}}' if i == 0
           else f'{{"id": "{camp.id}", "status": "cancelled"}}', at=m(71), op=f"em{i}")
    _audit(db, admin, u, f"ticket:{ticket.id}:status", "open", "closed", at=m(72), op=f"tk{i}")
    _audit(db, admin, u, f"ticket:{ticket.id}:reply", "", "您好，款项已到账，请查收。", at=m(72), op=f"tk{i}")
    _audit(db, admin, u if i == 0 else admin, ("strategy:ab_test", "feature:dark_mode")[i], "", ("on", "true")[i],
           at=m(73), op=f"x{i}")
    # 批量：一次改两个人 / one op touching two users
    _audit(db, admin, u, "invite_code", "", "wx2026gp", at=m(74), op=f"b{i}")
    _audit(db, admin, helper, "invite_code", "", "wx2026gp", at=m(74), op=f"b{i}")
    return out


def _rich(db):
    admin = _user(db, "ops@prismx.example", role="admin", nickname="运营小王", at=T0 - timedelta(days=30))
    agent = _user(db, "agent@example.com", nickname="代理阿杰", at=T0 - timedelta(days=20))
    helper = _user(db, "zhang@example.com", nickname="张三", at=T0 - timedelta(days=10))
    db.add_all([
        InviteLink(code="fb2026oc", label="FB 十月投放"),
        InviteLink(code="wx2026gp", label="微信群", deleted_at=T0),
    ])
    comp = Competition(name="十月实盘赛", starts_at=T0, ends_at=T0 + timedelta(days=30))
    db.add(comp)
    db.commit()
    s0 = _scenario(db, 0, admin, agent, helper, comp, T0)
    s1 = _scenario(db, 1, admin, agent, helper, comp, T0 + timedelta(hours=3))
    return admin, s0, s1


def _walk(items):
    for it in items:
        yield it
        yield from it.get("children") or ()


def _all_items(client, headers, **params) -> list[dict]:
    out, cursor = [], None
    while True:
        q = {**params, **({"cursor": cursor} if cursor else {}), "limit": 100}
        res = client.get("/api/admin/activity", params=q, headers=headers)
        assert res.status_code == 200, res.text
        body = res.json()
        out.extend(body["items"])
        cursor = body["next"]
        if cursor is None:
            return out


def test_every_kind_is_emitted_at_least_twice(db):
    admin, _, _ = _rich(db)
    c = _client(db)
    items = _all_items(c, _auth(admin))
    by_kind: dict[str, list[dict]] = {}
    for it in _walk(items):
        by_kind.setdefault(it["kind"], []).append(it)
        # 形状 / shape
        assert set(it) == {"key", "ts", "at", "cat", "kind", "params", "status", "tags", "abnormal", "actor",
                           "user", "users_count", "login", "account", "children"}
        assert it["cat"] == feed.KIND_CATEGORY[it["kind"]]
        assert it["status"] in feed.STATUSES
        assert set(it["tags"]) <= set(feed.TAGS)
        assert it["actor"]["type"] in feed.ACTOR_TYPES
        if it["user"] is not None:
            assert set(it["user"]) == {"id", "nickname", "email"} and it["user"]["email"]
        json.dumps(it)
    missing = {k: len(by_kind.get(k, [])) for k in feed.KINDS if len(by_kind.get(k, [])) < 2}
    assert missing == {}, f"这些 kind 例子不足两个：{missing}"

    out_path = os.environ.get("ACTIVITY_FEED_EXAMPLES_OUT")
    if out_path:
        # 契约文档的例子：每个 kind 优先取顶层行 / contract-doc examples, top-level first
        top = {}
        for it in items:
            top.setdefault(it["kind"], []).append(it)
        examples = {}
        for k in sorted(feed.KINDS):
            pool = top.get(k, []) + [x for x in by_kind[k] if x not in top.get(k, [])]
            examples[k] = pool[:2]
        detail = c.get("/api/admin/activity/item", params={"key": next(
            it["key"] for it in items if it["kind"] == "trade.open" and it["params"]["sym"] == "XAUUSD"
        )}, headers=_auth(admin)).json()
        first = c.get("/api/admin/activity", params={"limit": 3}, headers=_auth(admin)).json()
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({"examples": examples, "detail": detail, "page": first}, f, ensure_ascii=False, indent=2)


# ── 零副作用 / zero side effects ─────────────────────────────────────────────

def test_both_endpoints_never_write(db):
    admin, s0, _ = _rich(db)
    c = _client(db)
    h = _auth(admin)
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement.strip().split()[0].upper())

    engine = db.get_bind()
    event.listen(engine, "before_cursor_execute", record)
    try:
        items = _all_items(c, h)
        for params in ({"cat": "trade", "abnormal": 1}, {"q": "lucas"}, {"login": s0["login"]},
                       {"cat": "admin", "sub": "all"}, {"cat": "trade", "sub": "sltp"}):
            _all_items(c, h, **params)
        for it in items:
            res = c.get("/api/admin/activity/item", params={"key": it["key"]}, headers=h)
            assert res.status_code == 200, (it["key"], res.text)
    finally:
        event.remove(engine, "before_cursor_execute", record)
    assert statements, "计数器没挂上 / the counter saw nothing"
    writes = [s for s in statements if s in ("INSERT", "UPDATE", "DELETE", "REPLACE")]
    assert writes == []
    assert set(statements) <= {"SELECT"}


# ── 详情 / detail drawer ─────────────────────────────────────────────────────

def test_item_detail_with_position_timeline(db):
    admin = _user(db, "admin@t.co", role="admin")
    u = _user(db, "lucas@example.com", nickname="Lucas", phone="+60123456789", plan="PRO")
    other = _user(db, "wife@example.com", nickname="Wife")
    _acc(db, u, "51234567", account_name="Lucas Real")
    _acc(db, other, "51234567")
    pos = 4242
    opened = _order(db, u, at=T0, login="51234567", filled_price=2400.0, mt5_ticket=pos, mt5_position=pos)
    modify = _order(db, u, at=T0 + timedelta(minutes=1), login="51234567", action="MODIFY", ticket=pos,
                    volume=0.0, sl=2390.0, tp=0.0, prev_sl=0.0, prev_tp=0.0)
    partial = _order(db, u, at=T0 + timedelta(minutes=2), login="51234567", action="CLOSE", ticket=pos,
                     volume=0.05, pos_volume=0.1, filled_price=2410.0)
    _deal(db, u, at=T0 + timedelta(minutes=2, seconds=1), login="51234567", pos=pos, reason="DEALER",
          comment="PRISMX-CHART", close_volume=0.05, profit=50.0)
    sl_hit = _deal(db, u, at=T0 + timedelta(minutes=9), login="51234567", pos=pos, reason="SL",
                   close_volume=0.05, profit=-50.0 * 0.2)
    c = _client(db)
    h = _auth(admin)
    for key in (f"o:{opened.id}", f"o:{modify.id}", f"o:{partial.id}", f"d:{sl_hit.id}"):
        body = c.get("/api/admin/activity/item", params={"key": key}, headers=h).json()
        assert set(body) == {"item", "user", "account", "raw", "position"}
        assert body["item"]["key"] == key
        position = body["position"]
        assert position["ticket"] == pos
        assert [s["kind"] for s in position["steps"]] == ["trade.open", "sltp.modify", "trade.close", "deal.close"]
        assert position["total_pnl"] == 40.0
        close_step = position["steps"][2]
        assert close_step["params"]["pnl"] == 50.0 and close_step["params"]["partial"] is True
        assert position["steps"][3]["params"]["leg_k"] == 2 and position["steps"][3]["params"]["leg_n"] == 2
    body = c.get("/api/admin/activity/item", params={"key": f"o:{opened.id}"}, headers=h).json()
    assert body["user"] == {"id": u.id, "nickname": "Lucas", "email": "lucas@example.com", "phone": "+60123456789",
                            "plan": "PRO", "plan_expires_at": None, "role": "user",
                            "created_at": "2026-10-08T06:00:00.000000Z"}
    acc = body["account"]
    assert acc["login"] == "51234567" and acc["channel"] == "gateway" and acc["online"] is True
    assert acc["name"] == "Lucas Real" and acc["server"] == "MakeCapital-Live" and acc["demo"] is False
    assert {h_["email"] for h_ in acc["holders"]} == {"lucas@example.com", "wife@example.com"}
    assert body["raw"]["client_order_id"] == opened.client_order_id and body["raw"]["mt5_position"] == pos


def test_item_detail_for_every_key_type(db):
    admin, s0, _ = _rich(db)
    c = _client(db)
    h = _auth(admin)
    items = _all_items(c, h)
    prefixes = {it["key"].split(":")[0] for it in items}
    assert prefixes == {"u", "e", "o", "t", "d", "s", "a", "g"}
    for it in items:
        body = c.get("/api/admin/activity/item", params={"key": it["key"]}, headers=h).json()
        got = body["item"]
        assert got["kind"] == it["kind"], it["key"]
        assert got["key"] == it["key"]
        if it["children"]:
            assert len(got["children"]) == len(it["children"]), it["key"]
        if it["user"] is not None:
            assert body["user"]["id"] == it["user"]["id"] and body["user"]["email"]
    # 审计组：raw 里每一行都有 field / old / new / 操作人 / audit groups list every row
    g = next(it for it in items if it["kind"] == "admin.user_plan" and it["key"].startswith("g:"))
    raw = c.get("/api/admin/activity/item", params={"key": g["key"]}, headers=h).json()["raw"]
    assert {r["field"] for r in raw["rows"]} == {"plan", "plan_expires_at", "plan_note"}
    assert all(r["actor"]["email"] == "ops@prismx.example" for r in raw["rows"])
    # 结果更正：详情带上原指令那笔仓位 / a correction shows the original order's position
    corr = next(it for it in items if it["kind"] == "trade.corrected")
    body = c.get("/api/admin/activity/item", params={"key": corr["key"]}, headers=h).json()
    assert body["raw"]["data"]["was"] == "FAILED"
    # 更正前是哪种超时，列表与详情都带出来 / the timeout kind reaches both the list and the detail
    notes = {it["login"]: it["params"]["note"] for it in items if it["kind"] == "trade.corrected"}
    assert notes == {"51234567": "timeout_unknown", "62345678": "timeout"}
    assert body["item"]["params"]["note"] == notes[corr["login"]]
    assert body["position"] is None or body["position"]["steps"]


# ── 抽屉与被点的那一行一致 / the drawer matches the clicked row ───────────────

def _detail(c, h, key, **filters) -> dict:
    res = c.get("/api/admin/activity/item", params={"key": key, **filters}, headers=h)
    assert res.status_code == 200, res.text
    return res.json()


def test_bulk_edit_detail_matches_a_user_filtered_list(db):
    """一次批量给 A、B 改会员 + 到期（同一个 op_id）。按 A 筛时列表上是 A 的「修改会员」一行；
    抽屉带上列表的筛选打开，看到的也是这一行（不变成「批量修改 2 位用户」），key 不变。
    A bulk plan + expiry edit of A and B under one op_id. Filtered to A the list
    shows A's plan change; the drawer, given the list's filters, shows the same line
    (not "bulk edit, 2 users") under the same key."""
    admin = _user(db, "admin@t.co", role="admin")
    a = _user(db, "a@example.com", nickname="A")
    b = _user(db, "b@example.com", nickname="B")
    for t in (a, b):
        _audit(db, admin, t, "plan", "FREE", "PRO", at=T0, op="bulk1")
        _audit(db, admin, t, "plan_expires_at", "", "2026-11-09 06:00:00", at=T0, op="bulk1")
    c = _client(db)
    h = _auth(admin)
    for filters in ({"user_id": a.id}, {"q": "a@example"}):
        listed = [it for it in _all_items(c, h, cat="admin", **filters)]
        assert [it["kind"] for it in listed] == ["admin.user_plan"]
        row = listed[0]
        got = _detail(c, h, row["key"], cat="admin", **filters)
        assert got["item"]["key"] == row["key"]
        assert (got["item"]["kind"], got["item"]["users_count"]) == ("admin.user_plan", None)
        assert got["item"]["params"] == row["params"] and got["item"]["user"]["id"] == a.id
        assert {r["target"]["id"] for r in got["raw"]["rows"]} == {a.id}
    # 不带筛选（列表也没筛）：整次操作 / unfiltered: the whole operation
    whole = [it for it in _all_items(c, h, cat="admin")]
    assert [it["kind"] for it in whole] == ["admin.bulk_edit"]
    got = _detail(c, h, whole[0]["key"])
    assert got["item"]["key"] == whole[0]["key"] and got["item"]["users_count"] == 2


def test_bulk_child_detail_shows_all_of_that_users_rows(db):
    """批量操作的 child（a:）打开详情：这个人在这次操作里的全部行（会员 + 到期），与列表上那一行
    一样，而不是只剩其中一行。
    A bulk child's detail holds all of that user's rows in the op (plan + expiry),
    exactly like the list's child line."""
    admin = _user(db, "admin@t.co", role="admin")
    ts = [_user(db, f"t{i}@example.com") for i in range(3)]
    for t in ts:
        _audit(db, admin, t, "plan", "FREE", "PRO", at=T0, op="bulk2")
        _audit(db, admin, t, "plan_expires_at", "", "2026-11-09 06:00:00", at=T0, op="bulk2")
    c = _client(db)
    h = _auth(admin)
    bulk = _all_items(c, h, cat="admin")[0]
    assert bulk["kind"] == "admin.bulk_edit" and len(bulk["children"]) == 3
    for child in bulk["children"]:
        assert child["key"].startswith("a:")
        got = _detail(c, h, child["key"])
        assert got["item"]["key"] == child["key"]
        assert got["item"]["kind"] == child["kind"] == "admin.user_plan"
        assert got["item"]["params"] == child["params"]
        assert child["params"]["plan"] == ["FREE", "PRO"] and child["params"]["expires"][1]
        assert len(got["raw"]["rows"]) == 2


def _trail(db, u, pos, k, at, **kw):
    return _order(db, u, at=at, login="51234567", action="MODIFY", cid=f"auto_trail_{pos}_{k:08d}", ticket=pos,
                  volume=0.0, sl=2400.0 + k, prev_sl=2399.0 + k, **kw)


def test_trailing_run_detail_matches_a_filtered_list(db):
    """「改止损」子分类藏掉了中间那条分批止盈：列表把它前后两次追踪合成 moves=2；抽屉按 key 里
    的两头原样取回这两次，不在整段历史上重新合并（那里分批止盈会打断它）。
    The SL/TP tab hides the partial take-profit in between, so the list merges the
    two trailing moves (moves=2); the drawer takes back exactly those two instead
    of re-merging the full history, where the take-profit breaks the run."""
    admin = _user(db, "admin@t.co", role="admin")
    u = _user(db, "u@example.com")
    _acc(db, u, "51234567")
    pos = 5150
    t1 = _trail(db, u, pos, 1, T0)
    _order(db, u, at=T0 + timedelta(minutes=1), login="51234567", action="CLOSE", cid=f"auto_tp_{pos}_aaaaaaaa",
           ticket=pos, volume=0.05, pos_volume=0.1)
    t2 = _trail(db, u, pos, 2, T0 + timedelta(minutes=2))
    c = _client(db)
    h = _auth(admin)
    listed = [it for it in _all_items(c, h, cat="trade", sub="sltp") if it["kind"] == "auto.sl"]
    assert len(listed) == 1
    row = listed[0]
    assert row["key"] == f"t:{t2.id}:{t1.id}" and row["params"]["moves"] == 2
    got = _detail(c, h, row["key"], cat="trade")
    assert got["item"]["key"] == row["key"]
    assert got["item"]["params"]["moves"] == 2
    assert [k["key"] for k in got["item"]["children"]] == [k["key"] for k in row["children"]]
    assert got["position"]["ticket"] == pos


def test_trailing_run_cut_by_a_page_boundary(db):
    """一串追踪被翻页切成两段：每一段的抽屉都只是那一段。
    A run cut by a page boundary: each part's drawer holds just that part."""
    admin = _user(db, "admin@t.co", role="admin")
    u = _user(db, "u@example.com")
    _acc(db, u, "51234567")
    pos = 5151
    moves = [_trail(db, u, pos, k, T0 + timedelta(minutes=k)) for k in range(5)]
    c = _client(db)
    h = _auth(admin)
    items, cursor = [], None
    while True:
        res = c.get("/api/admin/activity", params={"cat": "trade", "limit": 2, **({"cursor": cursor} if cursor else {})},
                    headers=h).json()
        items.extend(res["items"])
        cursor = res["next"]
        if cursor is None:
            break
    runs = [it for it in items if it["kind"] == "auto.sl"]
    assert sum(it["params"]["moves"] for it in runs) == 5 and len(runs) > 1
    for it in runs:
        got = _detail(c, h, it["key"])
        assert got["item"]["key"] == it["key"]
        assert got["item"]["params"]["moves"] == it["params"]["moves"]
        assert [k["key"] for k in got["item"]["children"] or ()] == [k["key"] for k in it["children"] or ()]
    assert {k["key"] for it in runs for k in (it["children"] or [it])} == {f"o:{m.id}" for m in moves}


def test_trailing_run_detail_under_the_abnormal_filter(db):
    """「只看异常」：两次失败的追踪之间夹着一次成功的。列表把两次失败合成一行（moves=2）；
    抽屉带上 abnormal=1 也只取这两次。
    Abnormal view: two failed trailing moves around a successful one merge in the
    list (moves=2); with abnormal=1 the drawer takes the same two."""
    admin = _user(db, "admin@t.co", role="admin")
    u = _user(db, "u@example.com")
    _acc(db, u, "51234567")
    pos = 5152
    f1 = _trail(db, u, pos, 1, T0, status="FAILED", message="request_failed: timeout")
    _trail(db, u, pos, 2, T0 + timedelta(minutes=1))
    f3 = _trail(db, u, pos, 3, T0 + timedelta(minutes=2), status="FAILED", message="request_failed: timeout")
    c = _client(db)
    h = _auth(admin)
    row = next(it for it in _all_items(c, h, cat="trade", abnormal=1) if it["kind"] == "auto.sl")
    assert row["key"] == f"t:{f3.id}:{f1.id}" and row["params"]["moves"] == 2
    got = _detail(c, h, row["key"], cat="trade", abnormal=1)
    assert got["item"]["params"]["moves"] == 2 and got["item"]["abnormal"] is True
    # 不带筛选打开：这一段里三次都在 / without the filter the span holds all three
    assert _detail(c, h, row["key"])["item"]["params"]["moves"] == 3


# ── 语句数（设计 §7 的实测）/ statement counts (design §7, measured) ───────────
#
# 设计 §7 的语句数就是这几条测试量出来的（`pytest -s -k statement` 打印明细）。SQLite 计数；
# Postgres 每个请求另加一条 SET LOCAL statement_timeout。
# Design §7 quotes these numbers (`pytest -s -k statement` prints them). Counted on
# SQLite; Postgres adds one SET LOCAL statement_timeout per request.

# 一页最多：5 条源游标查询 + 12 条批量补充（一键平仓子单、原挂单、5 类名称、账户、平仓腿、
# 注册试用、用户、邀请链接名，每类一条 IN）+ 搜索 / 账号解析最多 3 条——与行数无关
# A page at most: 5 source queries + 12 batched lookups (one IN each) + up to 3 for
# resolving q / login — independent of the number of rows
_PAGE_SOURCES = 5
_PAGE_LOOKUPS = 12
_SCOPE_MAX = 3
# 页尾的组没结束时每个源最多补取几次（300 行，每次 ≤101 行）/ group top-up fetches per source
_EXTEND_FETCHES = 3


def _record_statements(db, fn) -> list[str]:
    seen: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        seen.append(" ".join(statement.split()))

    engine = db.get_bind()
    event.listen(engine, "before_cursor_execute", record)
    try:
        fn()
    finally:
        event.remove(engine, "before_cursor_execute", record)
    return seen


def _busy_day(db, admin: User, n_users: int = 12) -> list[User]:
    """生产上常见的一天：每个交易用户 登录、开仓、几次追踪止损、手动改止损、平台平仓（一半是
    2026-09 中旬之前那种 reason 为空的老腿）、止损触发（同样一半是老行）、手机端平仓；外加
    管理员改会员、自动降级。
    A typical production day per trader: login, open, trailing moves, a manual SL
    move, a platform close (half of them legacy blank-reason legs), an SL hit (half
    legacy too), a mobile close; plus admin plan edits and auto-expiries."""
    users = []
    for i in range(n_users):
        base = T0 + timedelta(hours=8, minutes=7 * i)
        m = lambda minutes, s=0, base=base: base + timedelta(minutes=minutes, seconds=s)  # noqa: E731
        u = _user(db, f"trader{i}@example.com", nickname=f"T{i}", at=T0 - timedelta(days=5))
        login = str(71000000 + i)
        _acc(db, u, login, source=("gateway", "bridge")[i % 2])
        legacy = i % 2 == 0
        pos = 990000 + i * 10
        _event(db, al.USER_LOGIN, u, at=m(0), data={"method": "password", "new_source": False})
        _order(db, u, at=m(1), login=login, filled_price=2400.0, sl=2390.0, tp=2420.0, mt5_ticket=pos, mt5_position=pos)
        for k in range(3):
            _order(db, u, at=m(2, k * 10), login=login, action="MODIFY", cid=f"auto_trail_{pos}_{k:08d}", ticket=pos,
                   volume=0.0, sl=2391.0 + k, prev_sl=2390.0 + k)
        _order(db, u, at=m(3), login=login, action="MODIFY", ticket=pos, volume=0.0, sl=2396.0, tp=2420.0,
               prev_sl=2393.0, prev_tp=2420.0)
        _order(db, u, at=m(4), login=login, action="CLOSE", ticket=pos, volume=0.0, pos_volume=0.1, filled_price=2405.0)
        _deal(db, u, at=m(4, 1), login=login, pos=pos, reason=None if legacy else "DEALER",
              comment="PRISMX close" if legacy else "PRISMX-CHART", profit=5.0)
        _deal(db, u, at=m(5), login=login, pos=pos + 1, reason=None if legacy else "SL",
              comment="[sl 2390.00]", profit=-10.0)
        _deal(db, u, at=m(6), login=login, pos=pos + 2, reason="MOBILE", comment="", profit=3.0)
        if i % 3 == 0:
            _audit(db, admin, u, "plan", "FREE", "PRO", at=m(6, 30), op=f"busy{i}")
        if i % 4 == 1:
            _audit(db, u, u, "plan:auto_expire", "PRO", "FREE", at=m(6, 40))
        users.append(u)
    return users


def _page_counts(db, **kw) -> list[int]:
    """逐页翻完（每页 50），每页的语句数 / statements per page (50 rows), every page."""
    counts, cursor = [], None
    for _ in range(100):
        out: dict = {}
        stmts = _record_statements(
            db, lambda c=cursor: out.update(feed.list_activity(db, cursor=c, limit=50, **kw)))
        counts.append(len(stmts))
        cursor = out["next"]
        if cursor is None:
            return counts
    raise AssertionError("翻页没有结束 / paging never ended")


def test_statement_counts_per_page_and_detail(db):
    """每页 / 每次详情的语句数是固定的几条（批量 IN，不是一行一查）：一天的常见交易数据 +
    「什么都有」的数据，按 全部 / 交易 / 按用户 / 只看异常 / 搜索 / 按账号 逐页翻完，再给每一行
    打开详情。
    Statements per page and per detail are a fixed handful (batched IN lookups, never
    one per row): a busy trading day plus the everything dataset, every page of each
    filter, then the detail of every line."""
    admin, s0, _ = _rich(db)
    traders = _busy_day(db, admin)
    cases = {
        "all": {}, "trade": {"cat": "trade"}, "user": {"user_id": traders[0].id},
        "abnormal": {"abnormal": 1}, "q": {"q": "trader1"}, "login": {"login": s0["login"]},
    }
    report: dict = {name: _page_counts(db, **kw) for name, kw in cases.items()}
    items, cursor = [], None
    while True:
        out = feed.list_activity(db, cursor=cursor, limit=100)
        items.extend(out["items"])
        cursor = out["next"]
        if cursor is None:
            break
    detail: dict[str, list[int]] = {}
    for it in items:
        n = len(_record_statements(db, lambda k=it["key"]: feed.get_item(db, k)))
        detail.setdefault(it["key"].split(":")[0], []).append(n)
    report["item"] = {k: [min(v), sorted(v)[len(v) // 2], max(v)] for k, v in sorted(detail.items())}
    print("\nSTATEMENTS", json.dumps(report, ensure_ascii=False))

    # 一天的常见交易页（前两页全是 _busy_day 的行）：源查询 + 账户 / 平仓腿 / 用户 3 条补充
    # A busy-day page: the source queries + accounts / legs / users
    assert report["all"][:2] == [_PAGE_SOURCES + 3] * 2
    assert report["trade"][:2] == [3 + 3] * 2
    for name, counts in report.items():
        if name != "item":
            assert max(counts) <= _PAGE_SOURCES + _PAGE_LOOKUPS + _SCOPE_MAX, (name, counts)
    # 详情：取行 + 仓位两条 + 同一套批量补充 + 用户资料；实测最多 8 条
    # Detail: the row, two position queries, the same lookups, the profile; 8 at most measured
    assert max(n for v in detail.values() for n in v) <= 10, report["item"]


def test_statement_counts_when_page_tail_groups_are_huge(db):
    """最坏情况：页尾压着一次 400 条腿的爆仓（一半是 reason 为空的老行）和一次 400 行的批量操作。
    每个源最多再补取 3 次（300 行），与组多大无关。
    Worst case: a 400-leg stop-out (half legacy blank-reason legs) and a 400-row bulk
    operation at the page tail. Each source tops up at most 3 times (300 rows),
    however big the group."""
    admin = _user(db, "admin@t.co", role="admin", at=T0 - timedelta(days=30))
    u = _user(db, "so@t.co", at=T0 - timedelta(days=30))
    _acc(db, u, "51234567")
    db.add_all([
        ClosedTrade(user_id=u.id, mt5_login="51234567", symbol="XAUUSD", side="BUY", close_volume=0.1,
                    close_price=2400.0, profit=-1.0, position_ticket=100000 + k, deal_ticket=200000 + k,
                    closed_at=T0 + timedelta(milliseconds=100 * k), created_at=T0 + timedelta(milliseconds=100 * k),
                    reason=None if k % 2 else "SO", comment="[so 40.00%/1.00/2.00]")
        for k in range(400)
    ])
    db.add_all([
        AdminAuditLog(admin_user_id=admin.id, target_user_id=u.id, field="plan", old_value="FREE", new_value="PRO",
                      created_at=T0 + timedelta(milliseconds=100 * k), op_id="huge")
        for k in range(400)
    ])
    db.commit()
    report = {}
    cases = (("all", {}, ("closed_trades", "admin_audit_logs")), ("trade", {"cat": "trade"}, ("closed_trades",)),
             ("admin", {"cat": "admin"}, ("admin_audit_logs",)))
    for name, kw, tables in cases:
        stmts = _record_statements(db, lambda kw=kw: feed.list_activity(db, limit=50, **kw))
        report[name] = len(stmts)
        for table in tables:
            # 1 条本页查询 + 正好补满 3 次 / the page query plus exactly the 3 top-ups
            scans = [s for s in stmts if f"FROM {table}" in s and "ORDER BY" in s and "LIMIT" in s]
            assert len(scans) == 1 + _EXTEND_FETCHES, (name, table, len(scans))
    print("\nSTATEMENTS_WORST", json.dumps(report))
    assert report["all"] <= _PAGE_SOURCES + 2 * _EXTEND_FETCHES + _PAGE_LOOKUPS
