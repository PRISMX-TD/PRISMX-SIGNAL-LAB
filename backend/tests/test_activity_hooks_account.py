"""操作日志埋点（设计 2026-10-09 §4.2）：账户安全与自动仓管设置这一组。

每个埋点钉三件事：成功时只写一条、数据键对得上 activity_log 的约定；失败 / 空操作 /
不存在的邮箱一条都不写；业务回滚时日志跟着作废。另外几条只在这里能钉住：

  · user.login 在**响应之后**由后台任务写，登录请求本身不多一次提交、不多一条写语句；
    每人每小时最多 3 条；失败的登录不记；Google 新注册不算登录。
  · user.email_verified 的三个调用方：点链接（method=link）、重置密码顺带（method=reset）、
    管理员手动标记（不写活动行，那边已有审计行）。
  · 敏感值不进日志：手机号、API Token 明文与哈希、密码哈希。

文件库而不是 conftest 的内存库：登录日志的后台任务与 record_after_commit 一样自己开连接，
内存库每个连接都是空库。

Activity-log hooks for account security and auto-manage settings: written once
on success with the documented data keys, nothing on failure / no-op / unknown
email, and rolled back with the business. Plus what only these tests pin: the
login row is written by a background task after the response (the login request
gains no commit and no write), capped at 3 per user per hour, never for failed
logins nor for a Google sign-up; the three mark_verified callers; and no secrets
in the log. A file database because the login task opens its own connection.
"""
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker

from app.core.config import settings
from app.core.database import Base, get_db
from app.core.security import generate_api_token, hash_api_token, hash_password
import app.models  # noqa: F401  —— 注册模型 / registers the tables
from app.models import AdminAuditLog, AutoManageSettings, User
from app.routers import auth as auth_mod
from app.schemas import (
    AuthRequest,
    ForgotPasswordRequest,
    GoogleAuthRequest,
    PhoneRequest,
    ProfilePatchIn,
    ResetPasswordRequest,
    VerifyEmailRequest,
)
from app.services import activity_log as al
from app.services import email_verification, shared_state

# 剥掉 slowapi 装饰器，与 test_password_reset.py 同一手法 / strip the slowapi decorator
_login = auth_mod.login.__wrapped__
_google = auth_mod.google_login.__wrapped__
_forgot = auth_mod.forgot_password.__wrapped__
_reset = auth_mod.reset_password.__wrapped__
_verify = auth_mod.verify_email.__wrapped__

PASSWORD = "original-password"


# ── 夹具 / fixtures ─────────────────────────────────────────────────────────────

@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    """计数（登录日志配额、失败锁定、找回密码频次）都住在 shared_state 内存后端，跨用例不会
    自己清。/ Quotas and lockout counters live in shared_state; clear them per test."""
    monkeypatch.setattr(settings, "REDIS_URL", "")
    monkeypatch.setattr(settings, "RATE_LIMIT_STORAGE_URI", "")
    shared_state.reset_for_tests()
    yield
    shared_state.reset_for_tests()


@pytest.fixture()
def engine(tmp_path):
    url = "sqlite:///" + str(tmp_path / "hooks.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    yield eng
    eng.dispose()


@pytest.fixture()
def db(engine):
    s = sessionmaker(bind=engine, autocommit=False, autoflush=False)()
    yield s
    s.close()


class _Req:
    """Request 的最小替身：只有 client.host（登录来源、找回密码的申请 IP 从这里取）。"""

    def __init__(self, host="203.0.113.7"):
        self.client = type("C", (), {"host": host})()


class _Background:
    """BackgroundTasks 的替身：先记下，测试里再手动跑，正好模拟「响应之后」。
    Records tasks; the test runs them afterwards — i.e. "after the response"."""

    def __init__(self):
        self.tasks = []

    def add_task(self, fn, *args, **kwargs):
        self.tasks.append((fn, args, kwargs))

    def run(self):
        for fn, args, kwargs in self.tasks:
            fn(*args, **kwargs)
        self.tasks.clear()


def _user(db, email="u@example.com", password=PASSWORD, verified=True, **kw) -> User:
    u = User(
        email=email,
        phone=kw.pop("phone", "+60123456789"),
        password_hash=hash_password(password) if password else None,
        api_token=hash_api_token(generate_api_token()),
        email_verified_at=datetime.now(timezone.utc) if verified else None,
        **kw,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _events(engine, kind=None) -> list[dict]:
    """另开一条连接读，看到的就是已提交的 / read on a separate connection: committed rows only."""
    sql = "SELECT kind, actor_type, actor_id, user_id, mt5_login, ref_id, data, dedupe_key FROM activity_events"
    params = {}
    if kind:
        sql += " WHERE kind = :k"
        params["k"] = kind
    with engine.connect() as conn:
        rows = conn.execute(text(sql + " ORDER BY created_at, id"), params).mappings().all()
    out = []
    for r in rows:
        d = dict(r)
        d["data"] = json.loads(d["data"]) if d["data"] else None
        out.append(d)
    return out


def _assert_self(ev, user):
    assert ev["actor_type"] == "user" and ev["actor_id"] == user.id and ev["user_id"] == user.id
    assert ev["mt5_login"] is None and ev["ref_id"] is None and ev["dedupe_key"] is None


class _WriteCounter:
    """数 INSERT / UPDATE / DELETE 语句 / counts write statements on an engine."""

    def __init__(self, engine):
        self.writes = []
        self._engine = engine
        event.listen(engine, "before_cursor_execute", self._on)

    def _on(self, conn, cursor, statement, params, context, executemany):
        head = statement.lstrip().split(None, 1)[0].upper()
        if head in ("INSERT", "UPDATE", "DELETE"):
            self.writes.append(statement)

    def close(self):
        event.remove(self._engine, "before_cursor_execute", self._on)


def _login_call(db, email="u@example.com", password=PASSWORD, host="203.0.113.7"):
    bg = _Background()
    out = _login(request=_Req(host), req=AuthRequest(email=email, password=password), background=bg, db=db)
    return out, bg


# ── user.login：密码登录 / password login ─────────────────────────────────────────

def test_password_login_writes_one_row_after_the_response(db, engine, monkeypatch):
    """登录请求本身：零次提交、零条写语句；行由后台任务写，跑之前库里什么都没有。
    The login request commits nothing and writes nothing; the background task does."""
    u = _user(db)
    commits = []
    real_commit = db.commit
    monkeypatch.setattr(db, "commit", lambda: (commits.append(1), real_commit())[1])
    counter = _WriteCounter(engine)
    try:
        out, bg = _login_call(db)
        assert out.token
        assert commits == [] and counter.writes == []
        assert len(bg.tasks) == 1 and _events(engine) == []    # 响应之前什么都没写

        bg.run()                                                # 「响应之后」
        assert len(counter.writes) == 1 and counter.writes[0].lstrip().upper().startswith("INSERT")
    finally:
        counter.close()
    assert commits == []                                        # 请求会话始终没提交

    [ev] = _events(engine)
    assert ev["kind"] == al.USER_LOGIN
    _assert_self(ev, u)
    assert ev["data"] == {"method": "password", "new_source": True}


def test_new_source_flag_follows_the_familiar_source_list(db, engine):
    _user(db)
    for host in ("203.0.113.7", "203.0.113.7", "198.51.100.2"):
        _, bg = _login_call(db, host=host)
        bg.run()
    assert [e["data"]["new_source"] for e in _events(engine)] == [True, False, True]


def test_failed_logins_are_never_logged(db, engine):
    _user(db)
    for email, pw in (("u@example.com", "wrong-password"), ("nobody@example.com", PASSWORD)):
        bg = _Background()
        with pytest.raises(HTTPException) as exc:
            _login(request=_Req(), req=AuthRequest(email=email, password=pw), background=bg, db=db)
        assert exc.value.status_code == 401
        assert bg.tasks == []
    assert _events(engine) == []


def test_login_rows_are_capped_at_three_per_user_per_hour(db, engine):
    a = _user(db, "a@example.com")
    b = _user(db, "b@example.com")
    for _ in range(5):
        _, bg = _login_call(db, "a@example.com")
        bg.run()
    _, bg = _login_call(db, "b@example.com")
    bg.run()
    rows = _events(engine, al.USER_LOGIN)
    assert sum(1 for e in rows if e["user_id"] == a.id) == al.LOGIN_EVENTS_PER_HOUR == 3
    assert sum(1 for e in rows if e["user_id"] == b.id) == 1     # 配额按人算 / per user


def test_quota_or_write_failure_never_breaks_the_login(db, engine, monkeypatch):
    _user(db)

    def boom(*a, **k):
        raise RuntimeError("redis down")

    real_incr = shared_state.incr_with_ttl
    monkeypatch.setattr(shared_state, "incr_with_ttl", boom)
    out, bg = _login_call(db)
    bg.run()                     # 不抛 / does not raise
    assert out.token and _events(engine) == []

    monkeypatch.setattr(shared_state, "incr_with_ttl", real_incr)
    monkeypatch.setattr(al, "record_after_commit", boom)
    out, bg = _login_call(db)
    bg.run()                     # 外层兜底也接住 / the backstop catches it too
    assert out.token and _events(engine) == []


def test_direct_call_without_background_still_logs_in(db, engine):
    """脚本 / 老测试直接调路由函数不传 background：照常登录，只是不记。"""
    _user(db)
    out = _login(request=_Req(), req=AuthRequest(email="u@example.com", password=PASSWORD), db=db)
    assert out.token and _events(engine) == []


def test_login_over_http_writes_the_row_from_a_background_task(engine, monkeypatch):
    """真走一遍 FastAPI：BackgroundTasks 照样注入（默认 None 不影响），响应 200，请求会话
    零提交，那一行是后台任务写的。/ End to end through FastAPI."""
    from app.core.rate_limit import limiter

    seed = sessionmaker(bind=engine)()
    u = _user(seed)
    seed.close()

    commits = []

    def _get_db():
        s = sessionmaker(bind=engine, autocommit=False, autoflush=False)()
        real = s.commit
        s.commit = lambda: (commits.append(1), real())[1]
        try:
            yield s
        finally:
            s.close()

    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(auth_mod.router)
    app.dependency_overrides[get_db] = _get_db
    try:
        limiter.reset()
    except Exception:  # noqa: BLE001  —— 存储不支持 reset 也无所谓
        pass
    with TestClient(app) as client:
        res = client.post("/auth/login", json={"email": "u@example.com", "password": PASSWORD})
        assert res.status_code == 200, res.text
        bad = client.post("/auth/login", json={"email": "u@example.com", "password": "wrong-password"})
        assert bad.status_code == 401
    assert commits == []
    [ev] = _events(engine)
    assert ev["kind"] == al.USER_LOGIN and ev["user_id"] == u.id
    assert ev["data"] == {"method": "password", "new_source": True}


# ── user.login：Google ─────────────────────────────────────────────────────────

@pytest.fixture()
def google(monkeypatch):
    monkeypatch.setattr(settings, "GOOGLE_CLIENT_ID", "test-client")
    state = {"email": "g@gmail.com"}
    monkeypatch.setattr(auth_mod, "verify_google_id_token", lambda _c: {"email": state["email"]})
    return state


def _google_call(db):
    bg = _Background()
    out = _google(request=None, req=GoogleAuthRequest(credential="c" * 40), background=bg, db=db)
    return out, bg


def test_google_sign_up_is_not_logged_as_a_login(db, engine, google):
    out, bg = _google_call(db)
    assert out.token and bg.tasks == []            # 新建 = 注册，不排登录日志
    assert _events(engine) == []


def test_google_login_of_an_existing_user_is_logged(db, engine, google):
    _google_call(db)                                # 先注册 / sign up first
    out, bg = _google_call(db)                      # 再登录 / then sign in
    assert len(bg.tasks) == 1
    bg.run()
    [ev] = _events(engine)
    user = db.query(User).filter(User.email == "g@gmail.com").one()
    assert ev["kind"] == al.USER_LOGIN
    _assert_self(ev, user)
    assert ev["data"] == {"method": "google", "new_source": None}


def test_google_refused_for_a_password_account_is_not_logged(db, engine, google):
    _user(db, "victim@example.com")
    google["email"] = "victim@example.com"
    bg = _Background()
    with pytest.raises(HTTPException) as exc:
        _google(request=None, req=GoogleAuthRequest(credential="c" * 40), background=bg, db=db)
    assert exc.value.status_code == 409
    assert bg.tasks == [] and _events(engine) == []


# ── 找回密码 / password reset ────────────────────────────────────────────────────

def _forgot_call(db, email, *, run=True):
    """调找回密码；run=True 时把除发信以外的后台任务跑掉（「响应之后」）。
    Call forgot-password; with run=True the non-mail background tasks run after."""
    bg = _Background()
    _forgot(request=_Req(), req=ForgotPasswordRequest(email=email), background=bg, db=db)
    if run:
        bg.tasks = [t for t in bg.tasks if t[0] is not auth_mod.send_reset_email]
        bg.run()
    return bg


def test_reset_request_is_logged_only_for_a_known_address(db, engine):
    u = _user(db)
    _forgot_call(db, "u@example.com")
    _forgot_call(db, "nobody@example.com")
    [ev] = _events(engine)
    assert ev["kind"] == al.USER_PASSWORD_RESET_REQUESTED
    _assert_self(ev, u)
    assert ev["data"] is None                       # 不记 IP / no IP stored


def test_reset_request_row_is_written_after_the_response(db, engine):
    """请求本身两支（邮箱存在 / 不存在）都不碰 activity_events——存在的那一支不比不存在的
    多一条 INSERT 往返，耗时差不因日志变大；行由后台任务在响应之后写。
    Neither branch of the request touches activity_events, so the known address
    gains no INSERT round trip over the unknown one; a background task writes the
    row after the response."""
    _user(db)
    stmts: list[str] = []

    def _before(conn, cursor, statement, *a):
        stmts.append(statement)

    event.listen(engine, "before_cursor_execute", _before)
    try:
        known = _forgot_call(db, "u@example.com", run=False)
        unknown = _forgot_call(db, "nobody@example.com", run=False)
        assert [s for s in stmts if "activity_events" in s] == []   # 请求本身 / the requests
        del stmts[:]
        # 不存在的邮箱：一个后台任务都没有 / unknown address: no task at all
        assert unknown.tasks == []
        names = [fn.__name__ for fn, _a, _k in known.tasks]
        assert names == ["send_reset_email", "_record_reset_requested"]

        known.tasks = [t for t in known.tasks if t[0] is not auth_mod.send_reset_email]
        known.run()                                             # 「响应之后」/ after the response
        assert [s.lstrip().split(None, 1)[0].upper() for s in stmts if "activity_events" in s] == ["INSERT"]
    finally:
        event.remove(engine, "before_cursor_execute", _before)
    assert [e["kind"] for e in _events(engine)] == [al.USER_PASSWORD_RESET_REQUESTED]


def test_reset_request_log_failure_never_breaks_the_request(db, engine, monkeypatch, caplog):
    import logging

    _user(db)

    def _boom(*a, **k):
        raise RuntimeError("log boom")

    monkeypatch.setattr(al, "record_after_commit", _boom)
    with caplog.at_level(logging.WARNING, logger="prismx.auth"):
        _forgot_call(db, "u@example.com")                       # 不抛 / no raise
    assert _events(engine) == []
    assert "reset-request event failed" in caplog.text


def test_reset_request_over_the_cap_is_not_logged(db, engine):
    from app.services.password_reset import RESET_MAX_PER_HOUR

    _user(db)
    for _ in range(RESET_MAX_PER_HOUR + 2):
        _forgot_call(db, "u@example.com")
    assert len(_events(engine, al.USER_PASSWORD_RESET_REQUESTED)) == RESET_MAX_PER_HOUR


def _reset_token(db, user) -> str:
    from app.services.password_reset import issue_token

    raw = issue_token(db, user, requested_ip=None)
    db.commit()
    return raw


def test_password_reset_logs_reset_and_verifies_an_unverified_address(db, engine):
    u = _user(db, verified=False)
    _reset(request=_Req(), req=ResetPasswordRequest(token=_reset_token(db, u), password="brand-new-pass"), db=db)
    # 同一次提交里的两行，时间可能落在同一微秒，按 kind 取而不按顺序比。
    # Two rows of one commit may share a microsecond; look them up by kind.
    rows = {e["kind"]: e for e in _events(engine)}
    assert sorted(rows) == sorted([al.USER_PASSWORD_RESET, al.USER_EMAIL_VERIFIED])
    assert rows[al.USER_PASSWORD_RESET]["data"] is None
    assert rows[al.USER_EMAIL_VERIFIED]["data"] == {"method": "reset"}
    for ev in rows.values():
        _assert_self(ev, u)


def test_password_reset_on_a_verified_address_logs_only_the_reset(db, engine):
    u = _user(db, verified=True)
    _reset(request=_Req(), req=ResetPasswordRequest(token=_reset_token(db, u), password="brand-new-pass"), db=db)
    assert [e["kind"] for e in _events(engine)] == [al.USER_PASSWORD_RESET]


def test_password_reset_with_a_bad_token_logs_nothing(db, engine):
    _user(db)
    with pytest.raises(HTTPException):
        _reset(request=_Req(), req=ResetPasswordRequest(token="not-a-token" * 3, password="brand-new-pass"), db=db)
    assert _events(engine) == []


# ── user.email_verified：三个调用方 / the three mark_verified callers ─────────────

def test_link_click_logs_once_with_method_link(db, engine):
    u = _user(db, verified=False)
    raw = email_verification.issue_token(db, u)
    db.commit()
    _verify(request=None, req=VerifyEmailRequest(token=raw), db=db)
    _verify(request=None, req=VerifyEmailRequest(token=raw), db=db)     # 再点一次 / again
    [ev] = _events(engine)
    assert ev["kind"] == al.USER_EMAIL_VERIFIED and ev["data"] == {"method": "link"}
    _assert_self(ev, u)


def test_concurrent_link_opens_are_serialised_and_log_once(engine):
    """同一封信被两个请求同时点开：consume_token 读用户时 FOR UPDATE + populate_existing，
    后到的那个（这里用「会话里还留着旧的未验证状态」来模拟它在锁后重读）看到已验证，
    走早返回，不记第二条。SQLite 不渲染 FOR UPDATE，所以另外按 Postgres 编译核对锁还在。
    Two concurrent opens of one link: the user is read FOR UPDATE with
    populate_existing, so the second request (simulated by a session still holding
    the stale unverified state) re-reads the verified row after the lock and logs
    nothing. SQLite drops FOR UPDATE, so the lock is also checked compiled for Postgres."""
    from sqlalchemy.dialects import postgresql

    S = sessionmaker(bind=engine, autocommit=False, autoflush=False)
    a, b = S(), S()
    u = _user(a, verified=False)
    raw = email_verification.issue_token(a, u)
    a.commit()
    stale = b.get(User, u.id)                       # B 先读到「未验证」/ B saw it unverified
    assert stale.email_verified_at is None

    _verify(request=None, req=VerifyEmailRequest(token=raw), db=a)      # A 先完成 / A wins

    seen = []

    def _on_exec(state):
        seen.append(state.statement)

    event.listen(b, "do_orm_execute", _on_exec)
    try:
        assert email_verification.consume_token(b, raw) is stale        # 同一个对象，已刷新
    finally:
        event.remove(b, "do_orm_execute", _on_exec)
    b.commit()
    assert stale.email_verified_at is not None
    assert [e["kind"] for e in _events(engine)] == [al.USER_EMAIL_VERIFIED]
    user_selects = [s for s in seen if "FROM users" in str(s.compile(dialect=postgresql.dialect()))]
    assert user_selects and "FOR UPDATE" in str(user_selects[-1].compile(dialect=postgresql.dialect()))
    a.close()
    b.close()


def test_expired_link_logs_nothing(db, engine):
    from app.models import EmailVerificationToken

    u = _user(db, verified=False)
    raw = email_verification.issue_token(db, u)
    db.commit()
    db.query(EmailVerificationToken).update(
        {EmailVerificationToken.expires_at: datetime.now(timezone.utc) - timedelta(hours=1)})
    db.commit()
    with pytest.raises(HTTPException):
        _verify(request=None, req=VerifyEmailRequest(token=raw), db=db)
    assert _events(engine) == []


def test_admin_manual_verify_writes_the_audit_row_but_no_activity_row(db, engine):
    from app.routers.admin import mark_email_verified

    admin = _user(db, "admin@example.com", role="admin")
    u = _user(db, verified=False)
    mark_email_verified(user_id=u.id, db=db, admin=admin)
    db.refresh(u)
    assert u.email_verified_at is not None
    assert db.query(AdminAuditLog).filter(AdminAuditLog.field == "account:verify_email").count() == 1
    assert _events(engine) == []


def test_mark_verified_without_method_writes_nothing(db, engine):
    u = _user(db, verified=False)
    email_verification.mark_verified(db, u)
    db.commit()
    assert u.email_verified_at is not None and _events(engine) == []


def test_mark_verified_row_rolls_back_with_the_caller(db, engine):
    u = _user(db, verified=False)
    email_verification.mark_verified(db, u, method=email_verification.METHOD_LINK)
    db.rollback()
    assert _events(engine) == []


# ── user.password_changed ──────────────────────────────────────────────────────

def _change(db, user, old, new):
    from app.routers.account import ChangePasswordRequest, change_password

    return change_password.__wrapped__(
        request=None, body=ChangePasswordRequest(old_password=old, new_password=new),
        db=db, current_user=user,
    )


def test_password_change_records_first_set_then_change(db, engine):
    u = _user(db, password=None)                     # Google 注册，没有密码
    _change(db, u, None, "first-password-1")
    _change(db, u, "first-password-1", "second-password-2")
    rows = _events(engine, al.USER_PASSWORD_CHANGED)
    assert [e["data"] for e in rows] == [{"first_set": True}, {"first_set": False}]
    for ev in rows:
        _assert_self(ev, u)
    # 密码哈希不进日志 / the hash never reaches the log
    with engine.connect() as conn:
        blob = " ".join(str(v) for v in conn.execute(text("SELECT * FROM activity_events")).fetchall())
    assert u.password_hash not in blob


def test_wrong_old_password_logs_nothing(db, engine):
    u = _user(db)
    with pytest.raises(HTTPException) as exc:
        _change(db, u, "wrong-password", "second-password-2")
    assert exc.value.status_code == 403
    assert _events(engine) == []


# ── user.nickname ──────────────────────────────────────────────────────────────

def test_nickname_set_and_change_log_old_and_new(db, engine):
    from app.routers.account import _apply_profile_patch

    u = _user(db)
    _apply_profile_patch(db, u, ProfilePatchIn(nickname="  Trader  "))
    _apply_profile_patch(db, u, ProfilePatchIn(nickname="Trader"))       # 原样重交 / unchanged
    _apply_profile_patch(db, u, ProfilePatchIn(leaderboardOptOut=True))  # 不涉及昵称
    _apply_profile_patch(db, u, ProfilePatchIn(nickname="NewName"))
    rows = _events(engine)
    assert [e["kind"] for e in rows] == [al.USER_NICKNAME, al.USER_NICKNAME]
    assert [e["data"] for e in rows] == [{"old": None, "new": "Trader"}, {"old": "Trader", "new": "NewName"}]
    for ev in rows:
        _assert_self(ev, u)


def test_invalid_nickname_logs_nothing(db, engine):
    from app.routers.account import _apply_profile_patch

    u = _user(db)
    with pytest.raises(HTTPException):
        _apply_profile_patch(db, u, ProfilePatchIn(nickname="x"))
    assert _events(engine) == []


def test_nickname_row_is_discarded_with_the_unique_collision_rollback(db, engine, monkeypatch):
    """预检查之后、提交之前被别人抢走同一个名字：唯一索引撞车 → rollback → 400，日志行一起作废。
    Someone takes the name between the pre-check and the commit: the unique-index
    rollback discards the activity row with the rename."""
    from app.routers.account import _apply_profile_patch
    from app.services.gamification import nickname_key

    db.execute(text("CREATE UNIQUE INDEX uq_users_nickname_key ON users (nickname_key)"))
    db.commit()
    rival = _user(db, "rival@example.com")
    u = _user(db)

    real_query = db.query

    class _NotTaken:
        """预检查那条查询：放行，同时让对手在同一事务里抢先占住这个名字。"""

        def filter(self, *a, **k):
            return self

        def first(self):
            db.execute(text("UPDATE users SET nickname = 'Taken', nickname_key = :k WHERE id = :r"),
                       {"k": nickname_key("Taken"), "r": rival.id})
            return None

    def _query(*entities, **kw):
        if entities == (User.id,):
            return _NotTaken()
        return real_query(*entities, **kw)

    monkeypatch.setattr(db, "query", _query)
    with pytest.raises(HTTPException) as exc:
        _apply_profile_patch(db, u, ProfilePatchIn(nickname="Taken"))
    assert exc.value.status_code == 400 and "already taken" in exc.value.detail
    assert _events(engine) == []


# ── user.phone_set ─────────────────────────────────────────────────────────────

def test_phone_set_is_logged_without_the_number(db, engine):
    from app.routers.account import set_phone

    u = _user(db, phone=None)
    set_phone.__wrapped__(request=None, req=PhoneRequest(phoneCountry="60", phone="123456789"),
                          db=db, current_user=u)
    [ev] = _events(engine)
    assert ev["kind"] == al.USER_PHONE_SET and ev["data"] is None
    _assert_self(ev, u)
    with engine.connect() as conn:
        blob = " ".join(str(v) for v in conn.execute(text("SELECT * FROM activity_events")).fetchall())
    assert "123456789" not in blob

    with pytest.raises(HTTPException) as exc:            # 已有号码再调：409，不记
        set_phone.__wrapped__(request=None, req=PhoneRequest(phoneCountry="60", phone="111222333"),
                              db=db, current_user=u)
    assert exc.value.status_code == 409
    assert len(_events(engine)) == 1


def test_bad_phone_logs_nothing(db, engine):
    from app.routers.account import set_phone

    u = _user(db, phone=None)
    with pytest.raises(HTTPException):
        set_phone.__wrapped__(request=None, req=PhoneRequest(phoneCountry="60", phone="abc"),
                              db=db, current_user=u)
    assert _events(engine) == []


# ── user.api_token_reset ───────────────────────────────────────────────────────

def test_api_token_reset_is_logged_without_token_or_hash(db, engine):
    from app.routers.ea import reset_token

    u = _user(db)
    old_hash = u.api_token
    out = reset_token.__wrapped__(request=None, user=u, db=db)
    [ev] = _events(engine)
    assert ev["kind"] == al.USER_API_TOKEN_RESET and ev["data"] is None
    _assert_self(ev, u)
    with engine.connect() as conn:
        blob = " ".join(str(v) for v in conn.execute(text("SELECT * FROM activity_events")).fetchall())
    for secret in (out.apiToken, hash_api_token(out.apiToken), old_hash):
        assert secret not in blob


# ── auto.settings ──────────────────────────────────────────────────────────────

def test_auto_settings_logs_only_the_fields_that_changed(db, engine):
    from app.routers import automation

    u = _user(db, plan="PRO")
    # 第一次保存：旧值是出厂默认 / first save diffs against the factory defaults
    automation.put_settings(body=automation.AutoManageSettingsIn(enabled=True, beTriggerR=2.0), db=db, user=u)
    # 原样再存：不记 / identical save: nothing
    automation.put_settings(body=automation.AutoManageSettingsIn(enabled=True, beTriggerR=2.0), db=db, user=u)
    automation.put_settings(
        body=automation.AutoManageSettingsIn(enabled=False, beTriggerR=2.0, ptpEnabled=True, ptpFraction=0.3),
        db=db, user=u)
    rows = _events(engine, al.AUTO_SETTINGS)
    assert len(rows) == 2
    for ev in rows:
        _assert_self(ev, u)
    assert rows[0]["data"] == {"changes": [
        {"field": "enabled", "old": False, "new": True},
        {"field": "beTriggerR", "old": 1.0, "new": 2.0},
    ]}
    assert rows[1]["data"] == {"changes": [
        {"field": "enabled", "old": True, "new": False},
        {"field": "ptpEnabled", "old": False, "new": True},
        {"field": "ptpFraction", "old": 0.5, "new": 0.3},
    ]}
    assert db.query(AutoManageSettings).count() == 1


def test_auto_settings_refused_for_free_logs_nothing(db, engine):
    from app.routers import automation

    u = _user(db, plan="FREE")
    with pytest.raises(HTTPException) as exc:
        automation.put_settings(body=automation.AutoManageSettingsIn(enabled=True), db=db, user=u)
    assert exc.value.status_code == 403
    assert _events(engine) == []
