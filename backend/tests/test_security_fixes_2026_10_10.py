"""2026-10-10 安全修复批：每一条钉一个「写错了也不会当场报错」的判据。

1. 改密 / 重置密码同时轮换桥接 API Token，并清掉桥接鉴权缓存里的旧哈希。
2. 规范邮箱：别名（Gmail 点、"+标签"）注册不出第二个账号，也领不到第二次试用。
3. 促销截止时间真的参与计价。
4. 管理员通知链接里的邮箱做了 URL 编码。
5. 登录查无此人也跑一次 bcrypt。
6. JWT_SECRET 硬拒：连 Postgres 的部署不看 ENV 也要拒默认 / 过短密钥。
7. 退出所有设备：token_version 自增，旧 JWT 当场失效。
8. Google 账号第一次设密码改为发邮件，不再当场生效。
9. 轻量鉴权缓存的写回竞态：未命中的读者不能把旧 tv 写回去。
10. 限流：IPv6 按 /64 分桶；Redis 出错时登录锁定改记进程内，不再放行。

The 2026-10-10 security batch; one silent-failure criterion pinned per fix.
"""
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException, Response
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

import app.core.database as db_mod
from app.core.security import create_access_token, generate_api_token, hash_api_token, hash_password
from app.models import InviteLink, Payment, User, UserNotification
from app.services import shared_cache, shared_state
from app.services.email_domains import alias_trial_used, canonical_email
from app.services.settings_store import invalidate_trial_cache, save_trial_settings


@pytest.fixture(autouse=True)
def _clean_state():
    from app.core import rate_limit

    shared_state.reset_for_tests()
    shared_cache.clear_for_tests()
    rate_limit._failures.clear()
    invalidate_trial_cache()
    yield
    shared_state.reset_for_tests()
    shared_cache.clear_for_tests()
    rate_limit._failures.clear()
    invalidate_trial_cache()


class _Req:
    class _Client:
        host = "203.0.113.7"

    client = _Client()


class _Background:
    def __init__(self):
        self.tasks = []

    def add_task(self, fn, *args, **kwargs):
        self.tasks.append((fn, args, kwargs))


def _mk_user(db, email="u@example.com", password="original-password", **kw):
    u = User(
        email=email,
        phone="+60123456789",
        password_hash=hash_password(password) if password else None,
        api_token=hash_api_token(generate_api_token()),
        email_verified_at=datetime.now(timezone.utc),
        **kw,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


# ── 2. 规范邮箱 / canonical email ───────────────────────────────────────────────

@pytest.mark.parametrize("raw, canon", [
    ("John.Doe+promo@Gmail.com", "johndoe@gmail.com"),
    ("j.o.h.n.doe@googlemail.com", "johndoe@gmail.com"),
    ("johndoe@gmail.com", "johndoe@gmail.com"),
    ("first.last+x+y@qq.com", "first.last@qq.com"),     # 非 Gmail 只去标签、不去点
    ("UPPER@Example.COM", "upper@example.com"),
    ("plain", "plain"),
])
def test_canonical_email(raw, canon):
    assert canonical_email(raw) == canon


def test_email_canonical_is_set_on_every_user_automatically(db_session):
    """不靠调用点手写：构造函数与后来改 email 都会同步算好。"""
    u = _mk_user(db_session, email="a.b+c@gmail.com")
    assert u.email_canonical == "ab@gmail.com"
    u.email = "x+1@example.com"
    db_session.commit()
    assert u.email_canonical == "x@example.com"
    assert "ix_users_email_canonical" in {i["name"] for i in inspect(db_session.get_bind()).get_indexes("users")}


def test_register_rejects_an_alias_with_the_duplicate_message(db_session):
    from app.routers.auth import register
    from app.schemas import RegisterRequest

    _mk_user(db_session, email="johndoe@gmail.com")

    def _reg(email):
        return register.__wrapped__(
            request=None,
            req=RegisterRequest(email=email, password="a-good-password", phoneCountry="60", phone="123456789"),
            background=_Background(),
            db=db_session,
        )

    with pytest.raises(HTTPException) as exact:
        _reg("johndoe@gmail.com")
    with pytest.raises(HTTPException) as alias:
        _reg("John.Doe+free@googlemail.com")
    assert alias.value.status_code == exact.value.status_code == 400
    assert alias.value.detail == exact.value.detail
    assert db_session.query(User).count() == 1
    # 不同的人照常注册 / a different person still signs up
    assert _reg("someone.else@gmail.com").user.email == "someone.else@gmail.com"


def test_alias_trial_used_covers_trial_paid_and_pro(db_session):
    base = _mk_user(db_session, email="ab@gmail.com")
    alias = _mk_user(db_session, email="a.b+2@gmail.com")
    assert alias_trial_used(db_session, alias.email, exclude_user_id=alias.id) is False

    base.trial_used_at = datetime.now(timezone.utc)
    db_session.commit()
    assert alias_trial_used(db_session, alias.email, exclude_user_id=alias.id) is True
    # 自己用过不算「别名用过」（自己那条由 claim_trial 的条件 UPDATE 管）
    assert alias_trial_used(db_session, base.email, exclude_user_id=base.id) is False

    base.trial_used_at = None
    base.plan = "PRO"
    db_session.commit()
    assert alias_trial_used(db_session, alias.email, exclude_user_id=alias.id) is True

    base.plan = "FREE"
    db_session.add(Payment(user_id=base.id, nowpayments_payment_id="np1", plan="pro_monthly",
                           amount_usd=39, pay_currency="usdttrc20", status="FINISHED"))
    db_session.commit()
    assert alias_trial_used(db_session, alias.email, exclude_user_id=alias.id) is True


def test_claim_trial_refuses_an_alias_of_a_used_mailbox(db_session, monkeypatch):
    from app.routers import payments

    monkeypatch.setattr(payments, "trial_grant_days", lambda db: 7)
    _mk_user(db_session, email="ab@gmail.com", trial_used_at=datetime.now(timezone.utc))
    alias = _mk_user(db_session, email="a.b+2@gmail.com")
    fresh = _mk_user(db_session, email="other@gmail.com")

    save_trial_settings(db_session, {"trial_enabled": True, "trial_days": 7})
    db_session.commit()
    invalidate_trial_cache()
    assert payments.get_trial_status(user=alias, db=db_session)["eligible"] is False
    with pytest.raises(HTTPException) as exc:
        payments.claim_trial(user=alias, db=db_session)
    assert exc.value.status_code == 409
    db_session.refresh(alias)
    assert alias.plan == "FREE" and alias.trial_used_at is None

    assert payments.claim_trial(user=fresh, db=db_session)["ok"] is True


def test_invite_trials_skip_aliases(db_session, monkeypatch):
    from app.routers import invite

    save_trial_settings(db_session, {"trial_enabled": True, "trial_days": 7})
    db_session.add(InviteLink(code="trial234", label="渠道", is_active=True, grants_trial=True))
    db_session.commit()
    invalidate_trial_cache()
    _mk_user(db_session, email="ab@gmail.com", trial_used_at=datetime.now(timezone.utc))

    # 邮箱验证之后补发那条 / the deferred grant at verification
    alias = _mk_user(db_session, email="a.b+2@gmail.com", invite_code="trial234")
    assert invite.grant_deferred_invite_trial(db_session, alias) is None
    db_session.commit()
    db_session.refresh(alias)
    assert alias.trial_used_at is None

    # Google 新建账号当场发放那条 / the at-creation grant (Google sign-up)
    pending = User(email="A.B@googlemail.com", api_token=hash_api_token(generate_api_token()))
    assert invite.apply_invite(db_session, pending, "trial234") is None
    assert pending.trial_used_at is None and pending.invite_code == "trial234"

    # 不同的人照常发 / a different person still gets it
    other = User(email="new@gmail.com", api_token=hash_api_token(generate_api_token()))
    assert invite.apply_invite(db_session, other, "trial234") == 7


def test_rev40_migration_adds_and_backfills_email_canonical(monkeypatch, tmp_path):
    from app.core.database import Base
    import app.models  # noqa: F401

    eng = create_engine("sqlite:///" + str(tmp_path / "legacy.db").replace("\\", "/"),
                        connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.execute(text("DROP INDEX IF EXISTS ix_users_email_canonical"))
        conn.execute(text("ALTER TABLE users DROP COLUMN email_canonical"))
        for uid, email in (("u1", "John.Doe+x@Gmail.com"), ("u2", "a+b@qq.com")):
            conn.execute(text(
                "INSERT INTO users (id, email, api_token, role, plan, plan_is_trial, token_version, "
                "nickname_public, leaderboard_opt_out, stats_public, phone_required) "
                f"VALUES ('{uid}', '{email}', 'tok_{uid}', 'user', 'FREE', 0, 0, 0, 0, 0, 0)"))
    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False))
    db_mod._write_schema_rev(39)

    assert db_mod.CURRENT_SCHEMA_REV >= 40
    db_mod.init_db()
    db_mod._write_schema_rev(39)
    db_mod.init_db()                       # 重跑幂等 / re-run is idempotent
    with eng.connect() as conn:
        rows = dict(conn.execute(text("SELECT id, email_canonical FROM users")).fetchall())
    assert rows == {"u1": "johndoe@gmail.com", "u2": "a@qq.com"}
    idx = {i["name"]: i for i in inspect(eng).get_indexes("users")}
    assert idx["ix_users_email_canonical"]["column_names"] == ["email_canonical"]
    assert not idx["ix_users_email_canonical"]["unique"]
    eng.dispose()


# ── 1. API Token 轮换 / bridge token rotation ─────────────────────────────────

@pytest.fixture
def invalidated(monkeypatch):
    import app.routers.bridge as bridge

    seen: list = []
    monkeypatch.setattr(bridge, "invalidate_auth_cache_for_hash", lambda h: seen.append(h))
    return seen


def test_reset_password_rotates_the_api_token(db_session, invalidated):
    from app.routers.auth import reset_password
    from app.schemas import ResetPasswordRequest
    from app.services.password_reset import issue_token

    user = _mk_user(db_session)
    old = user.api_token
    raw = issue_token(db_session, user)
    db_session.commit()
    reset_password.__wrapped__(request=None, req=ResetPasswordRequest(token=raw, password="a-brand-new-password"),
                               db=db_session)
    db_session.refresh(user)
    assert user.api_token and user.api_token != old
    assert invalidated == [old]


def test_change_password_rotates_the_api_token(db_session, invalidated):
    from app.routers.account import ChangePasswordRequest, change_password

    user = _mk_user(db_session)
    old = user.api_token
    out = change_password.__wrapped__(
        request=None, body=ChangePasswordRequest(old_password="original-password", new_password="second-password-2"),
        background=_Background(), db=db_session, current_user=user,
    )
    db_session.refresh(user)
    assert out["token"] and user.api_token != old
    assert invalidated == [old]


def test_rotation_tolerates_a_missing_old_token(invalidated):
    from app.core.security import invalidate_bridge_token_cache, rotate_api_token

    class _U:
        api_token = None

    u = _U()
    assert rotate_api_token(u) is None and u.api_token
    invalidate_bridge_token_cache(None)
    assert invalidated == []


# ── 3. 促销截止 / sale end ─────────────────────────────────────────────────────

def test_sale_end_is_enforced():
    from app.routers.payments import _sale_active

    now = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)
    on = {"sale_enabled": True, "sale_percent": 20}
    assert _sale_active({**on, "sale_end_at": None}, now) is True
    assert _sale_active({**on, "sale_end_at": "2026-10-11T00:00:00Z"}, now) is True
    assert _sale_active({**on, "sale_end_at": "2026-10-10T11:59:59+00:00"}, now) is False
    assert _sale_active({**on, "sale_end_at": "2026-10-10T11:00:00"}, now) is False     # naive = UTC
    assert _sale_active({**on, "sale_end_at": "2026-10-10"}, now) is True              # 当天有效
    assert _sale_active({**on, "sale_end_at": "2026-10-09"}, now) is False
    assert _sale_active({**on, "sale_end_at": "garbage"}, now) is False
    assert _sale_active({"sale_enabled": False, "sale_percent": 20}, now) is False


def test_expired_sale_is_not_charged(db_session, monkeypatch):
    from app.routers import payments

    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    monkeypatch.setattr(payments, "get_pricing_settings", lambda db: {
        "pro_monthly_price": 39, "pro_yearly_price": 299, "sale_enabled": True,
        "sale_percent": 50, "sale_badge": "", "sale_end_at": past})
    assert payments._resolve_pricing(db_session)["sale"] is None


# ── 4. 管理员通知链接编码 / admin notification link encoding ────────────────────

def test_agent_write_notification_encodes_the_email(db_session):
    from app.routers.invite import _notify_admins_agent_write

    admin = _mk_user(db_session, email="admin@example.com", role="admin")
    agent = _mk_user(db_session, email="agent@example.com")
    target = _mk_user(db_session, email="a+b&tab=x#y@example.com")
    _notify_admins_agent_write(db_session, agent, target, "summary")
    db_session.commit()
    note = db_session.query(UserNotification).filter(UserNotification.user_id == admin.id).one()
    assert note.link == "/admin?tab=users&q=a%2Bb%26tab%3Dx%23y%40example.com"


# ── 5. 登录时序 / login timing ─────────────────────────────────────────────────

def test_login_runs_bcrypt_for_unknown_and_passwordless_accounts(db_session, monkeypatch):
    from app.routers import auth
    from app.schemas import AuthRequest

    calls: list = []
    real = auth.verify_password
    monkeypatch.setattr(auth, "verify_password", lambda p, h: calls.append(h) or real(p, h))
    _mk_user(db_session, email="google@example.com", password=None)
    for email in ("nobody@example.com", "google@example.com"):
        with pytest.raises(HTTPException) as exc:
            auth.login.__wrapped__(request=_Req(), req=AuthRequest(email=email, password="whatever-pw"),
                                   background=None, db=db_session)
        assert exc.value.status_code == 401
    assert calls == [auth._DUMMY_PASSWORD_HASH, auth._DUMMY_PASSWORD_HASH]


# ── 6. JWT_SECRET 硬拒 / JWT secret guard ──────────────────────────────────────

def test_jwt_secret_enforced_on_postgres_regardless_of_env():
    from app.core.config import jwt_secret_enforced

    assert jwt_secret_enforced("production", "sqlite:///./x.db") is True
    assert jwt_secret_enforced("development", "postgresql://u:p@h/db") is True
    assert jwt_secret_enforced("development", "postgres://u:p@h/db") is True
    assert jwt_secret_enforced("development", "sqlite:///./prismx.db") is False


def _import_config(**env) -> subprocess.CompletedProcess:
    full = {**os.environ, **env, "PYTHONUTF8": "1"}
    return subprocess.run(
        [sys.executable, "-c", "import app.core.config"],
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        env=full, capture_output=True, text=True, encoding="utf-8", errors="replace",
    )


def test_postgres_deployment_refuses_the_default_secret_even_without_env_production():
    pg = "postgresql://u:p@127.0.0.1:5432/prismx"
    done = _import_config(ENV="development", DATABASE_URL=pg,
                          JWT_SECRET="prismx-dev-secret-change-in-production")
    assert done.returncode != 0 and "JWT_SECRET" in done.stderr
    assert _import_config(ENV="development", DATABASE_URL=pg, JWT_SECRET="short").returncode != 0
    assert _import_config(ENV="development", DATABASE_URL=pg, JWT_SECRET="J" * 48).returncode == 0


# ── 7. 退出所有设备 / log out everywhere ───────────────────────────────────────

def test_logout_all_kills_existing_tokens(db_session):
    from app.routers.account import logout_all
    from app.services.deps import get_current_user

    user = _mk_user(db_session)
    old_token = create_access_token(user.id, user.token_version or 0)
    assert get_current_user(Response(), f"Bearer {old_token}", db_session).id == user.id

    assert logout_all.__wrapped__(request=None, db=db_session, current_user=user) == {"ok": True}
    db_session.refresh(user)
    assert user.token_version == 1
    with pytest.raises(HTTPException) as exc:
        get_current_user(Response(), f"Bearer {old_token}", db_session)
    assert exc.value.status_code == 401


# ── 8. Google 账号设密码 / first password on a Google account ──────────────────

def test_google_account_first_password_goes_through_email(db_session):
    from app.models import PasswordResetToken
    from app.routers.account import ChangePasswordRequest, change_password
    from app.services.password_reset import RESET_MAX_PER_HOUR, send_reset_email

    user = _mk_user(db_session, email="g@example.com", password=None)
    tv = user.token_version or 0
    for _ in range(RESET_MAX_PER_HOUR):
        bg = _Background()
        out = change_password.__wrapped__(
            request=_Req(), body=ChangePasswordRequest(new_password="attacker-password"),
            background=bg, db=db_session, current_user=user,
        )
        assert out == {"ok": True, "emailSent": True}
        assert [(fn, args[0]) for fn, args, _ in bg.tasks] == [(send_reset_email, "g@example.com")]
    db_session.refresh(user)
    assert user.password_hash is None and (user.token_version or 0) == tv
    assert db_session.query(PasswordResetToken).count() == RESET_MAX_PER_HOUR
    with pytest.raises(HTTPException) as exc:     # 共用找回密码的每小时上限
        change_password.__wrapped__(request=_Req(), body=ChangePasswordRequest(),
                                    background=_Background(), db=db_session, current_user=user)
    assert exc.value.status_code == 429


def test_existing_password_change_still_requires_both_fields(db_session):
    from app.routers.account import ChangePasswordRequest, change_password

    user = _mk_user(db_session)
    with pytest.raises(HTTPException) as exc:
        change_password.__wrapped__(request=None, body=ChangePasswordRequest(old_password="original-password"),
                                    background=_Background(), db=db_session, current_user=user)
    assert exc.value.status_code == 400


# ── 9. 鉴权缓存写回竞态 / auth-state write-back race ───────────────────────────

class _StaleSession:
    """查库返回旧值；返回之前（可选地）模拟另一个请求「提交改密并失效缓存」。
    Returns the stale row; optionally simulates a concurrent commit + invalidation
    landing between this reader's query and its write-back."""

    def __init__(self, user_id, on_read):
        self._uid, self._on_read = user_id, on_read

    def query(self, *a):
        return self

    def filter(self, *a):
        return self

    def first(self):
        row = (0, None)
        self._on_read(self._uid)
        return row

    def close(self):
        pass


def test_cache_miss_cannot_write_back_a_stale_token_version(monkeypatch):
    from app.services import deps

    key = shared_cache.auth_state_key("u-race")
    monkeypatch.setattr(deps, "SessionLocal", lambda: _StaleSession("u-race", deps.invalidate_auth_state))
    deps.get_auth_state("u-race")
    # 读者查到的是旧 tv，而失效发生在它写回之前：缓存里不能留下这份旧值。
    assert shared_cache.get_json(key) is None


def test_cache_miss_without_a_concurrent_change_is_cached(monkeypatch):
    from app.services import deps

    key = shared_cache.auth_state_key("u-calm")
    monkeypatch.setattr(deps, "SessionLocal", lambda: _StaleSession("u-calm", lambda _uid: None))
    assert deps.get_auth_state("u-calm") == {"tv": 0, "d": False}
    assert shared_cache.get_json(key) == {"tv": 0, "d": False}


def test_direct_shared_cache_invalidation_also_closes_the_race(monkeypatch):
    """绕过 deps、直接调 shared_cache.invalidate_auth_state 的地方也要换代号，竞态同样被堵住。"""
    from app.services import deps

    key = shared_cache.auth_state_key("u-direct")
    before = shared_cache.get_json(shared_cache.auth_gen_key("u-direct"))
    monkeypatch.setattr(deps, "SessionLocal",
                        lambda: _StaleSession("u-direct", shared_cache.invalidate_auth_state))
    deps.get_auth_state("u-direct")
    assert shared_cache.get_json(key) is None
    assert shared_cache.get_json(shared_cache.auth_gen_key("u-direct")) not in (None, before)
    assert deps._auth_gen_key("u-direct") == shared_cache.auth_gen_key("u-direct")


def test_commit_invalidation_bumps_the_generation(db_session):
    from app.services import deps

    user = _mk_user(db_session)
    shared_cache.set_json(shared_cache.auth_state_key(user.id), {"tv": 0, "d": False}, ttl=300)
    before = shared_cache.get_json(deps._auth_gen_key(user.id))
    user.token_version = 5
    db_session.commit()
    assert shared_cache.get_json(shared_cache.auth_state_key(user.id)) is None
    assert shared_cache.get_json(deps._auth_gen_key(user.id)) not in (None, before)


# ── 10. 限流 / rate limiting ──────────────────────────────────────────────────

def test_ipv6_is_bucketed_by_slash_64():
    from app.core.rate_limit import bucket_ip, client_ip_key, login_source

    assert bucket_ip("2001:db8:1:2:aaaa::1") == bucket_ip("2001:db8:1:2:bbbb::9") == "2001:db8:1:2::/64"
    assert bucket_ip("2001:db8:1:3::1") != bucket_ip("2001:db8:1:2::1")
    assert bucket_ip("203.0.113.7") == "203.0.113.7"
    assert bucket_ip("::ffff:203.0.113.7") == "203.0.113.7"
    assert bucket_ip("not-an-ip") == "not-an-ip"

    class _R:
        def __init__(self, host):
            self.client = type("C", (), {"host": host})()

    assert client_ip_key(_R("2001:db8:1:2::5")) == "2001:db8:1:2::/64"
    assert login_source(_R("2001:db8:1:2::5")) == login_source(_R("2001:db8:1:2:ffff::7"))


def test_strategy_user_limiter_ip_fallback_buckets_ipv6():
    """回测等按用户限流的端点：没带 token 时回落到 IP，也必须按 /64 分桶。"""
    from app.core.strategy_limits import user_rate_key

    class _R:
        def __init__(self, host):
            self.client = type("C", (), {"host": host})()
            self.headers = {}

    assert user_rate_key(_R("2001:db8:1:2::5")) == user_rate_key(_R("2001:db8:1:2:ffff::7")) == "ip:2001:db8:1:2::/64"
    assert user_rate_key(_R("203.0.113.7")) == "ip:203.0.113.7"


def test_login_lockout_survives_a_redis_outage(monkeypatch):
    from app.core import rate_limit

    def _boom(*a, **k):
        raise ConnectionError("redis down")

    monkeypatch.setattr(shared_state, "kv_get", _boom)
    monkeypatch.setattr(shared_state, "incr_with_ttl", _boom)
    monkeypatch.setattr(shared_state, "kv_delete", _boom)
    max_attempts, _ = rate_limit._POLICIES["login"]
    for _ in range(max_attempts):
        assert rate_limit.is_login_locked("v@example.com", "src") is False
        rate_limit.record_failed_login("v@example.com", "src")
    assert rate_limit.is_login_locked("v@example.com", "src") is True
    rate_limit.clear_failed_logins("v@example.com", "src")
    # 来源级撒网计数不随单对清除 / the spray counter is not cleared with the pair
    assert rate_limit.is_login_locked("v@example.com", "src") is False


# ── 管理员上传：有界读取 / admin upload: bounded read ─────────────────────────

def test_admin_upload_reads_at_most_cap_plus_one(monkeypatch):
    """不报大小（分块传输）的超大上传：只读上限 + 1 字节就 413，不会整段读进内存。"""
    import asyncio
    from app.core.config import settings
    from app.routers import admin as admin_mod

    monkeypatch.setattr(admin_mod, "is_upload_configured", lambda: True)
    reads = []

    class _File:
        size = None

        async def read(self, n=-1):
            reads.append(n)
            return b"\x89PNG" + b"\0" * (settings.UPLOAD_MAX_BYTES * 3 if n in (-1, None) else n - 4)

    class _Req:
        headers = {}

    with pytest.raises(HTTPException) as exc:
        asyncio.run(admin_mod.upload_admin_image(_Req(), _File(), _admin=None))
    assert exc.value.status_code == 413
    assert reads == [settings.UPLOAD_MAX_BYTES + 1]
