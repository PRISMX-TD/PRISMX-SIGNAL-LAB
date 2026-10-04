"""注册邮箱验证（软拦截）：钉住几条写错了也不会当场报错的判据。

1. 邮箱密码注册出来的账号是**未验证**的，并且排进了一封验证信。
2. 邀请链接送的试用**扣到验证之后**才发——否则随手填个邮箱就能白领试用；验证
   时只发一次，链接在这期间被停用就不发。
3. 验证幂等：同一个链接点两次都成功，过期链接只对还没验证的人失败。
4. 守门：绑定 MT5（网关验证、桥接 Token）与领试用这三个端点挂的是
   require_verified_email，不是 get_current_user。
5. 迁移：老库加列时存量用户全部回填为已验证。

Pins the soft email-verification gate: unverified password sign-ups, invite
trials deferred to verification (granted once), idempotent verification, the
three gated endpoints, and the backfill that grandfathers existing users.
"""
import inspect as pyinspect
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from sqlalchemy import create_engine, text

import app.core.database as db_mod
from app.core.security import generate_api_token, hash_api_token, hash_password
from app.models import AdminAuditLog, EmailVerificationToken, InviteLink, User
from app.routers.auth import register as _register_decorated
from app.routers.auth import resend_verification as _resend_decorated
from app.routers.auth import reset_password as _reset_decorated
from app.routers.auth import verify_email as _verify_decorated
from app.schemas import RegisterRequest, ResetPasswordRequest, VerifyEmailRequest
from app.services import email_verification
from app.services.deps import EMAIL_NOT_VERIFIED_DETAIL, require_verified_email
from app.services.settings_store import invalidate_trial_cache, save_trial_settings

# 剥掉 slowapi 装饰器，与 test_password_reset.py 同一手法。
_register = _register_decorated.__wrapped__
_verify = _verify_decorated.__wrapped__
_resend = _resend_decorated.__wrapped__
_reset = _reset_decorated.__wrapped__


@pytest.fixture(autouse=True)
def _clean_counters():
    """发信频次计数住在 shared_state，跨用例不会自己清。"""
    from app.services import shared_state

    shared_state.reset_for_tests()
    invalidate_trial_cache()
    yield
    shared_state.reset_for_tests()
    invalidate_trial_cache()


class _Background:
    """BackgroundTasks 的替身：记下要发的信，不真发。"""

    def __init__(self):
        self.tasks = []

    def add_task(self, fn, *args, **kwargs):
        self.tasks.append((fn, args, kwargs))


def _sign_up(db, email="new@example.com", ref=None):
    bg = _Background()
    out = _register(
        request=None,
        req=RegisterRequest(
            email=email, password="a-good-password", phoneCountry="60", phone="123456789", ref=ref
        ),
        background=bg,
        db=db,
    )
    return out, bg


def _token_from(bg) -> str:
    fn, args, _ = bg.tasks[-1]
    assert fn is email_verification.send_verification_email
    return args[1]


def _trial_link(db, code="trial234"):
    save_trial_settings(db, {"trial_enabled": True, "trial_days": 7})
    db.commit()
    invalidate_trial_cache()
    link = InviteLink(code=code, label="渠道", is_active=True, grants_trial=True)
    db.add(link)
    db.commit()
    return link


def _mk_user(db, email="u@example.com", verified=False):
    u = User(
        email=email,
        phone="+60123456789",
        password_hash=hash_password("original-password"),
        api_token=hash_api_token(generate_api_token()),
        email_verified_at=datetime.now(timezone.utc) if verified else None,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


# ---------- 注册 / sign-up ----------

def test_password_sign_up_starts_unverified_and_queues_a_mail(db_session):
    out, bg = _sign_up(db_session)
    assert out.user.emailVerified is False
    user = db_session.query(User).filter(User.email == "new@example.com").one()
    assert user.email_verified_at is None
    assert len(bg.tasks) == 1
    fn, args, _ = bg.tasks[0]
    assert fn is email_verification.send_verification_email
    assert args[0] == "new@example.com"
    # 库里只有哈希 / only the hash is stored
    row = db_session.query(EmailVerificationToken).one()
    assert row.token_hash != args[1]
    assert row.token_hash == email_verification.hash_token(args[1])


def test_invite_trial_is_held_back_until_verification(db_session):
    """注册当场不发试用，只归因；验证之后补发、写审计。"""
    link = _trial_link(db_session)
    out, bg = _sign_up(db_session, ref=link.code)
    user = db_session.query(User).filter(User.email == "new@example.com").one()
    assert user.plan == "FREE"
    assert user.trial_used_at is None
    assert user.invite_code == link.code

    _verify(request=None, req=VerifyEmailRequest(token=_token_from(bg)), db=db_session)
    db_session.refresh(user)
    assert user.email_verified_at is not None
    assert user.plan == "PRO"
    assert user.plan_is_trial is True
    assert user.trial_used_at is not None
    audits = db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "plan:invite_trial").all()
    assert len(audits) == 1


def test_clicking_the_link_twice_succeeds_and_grants_the_trial_once(db_session):
    link = _trial_link(db_session)
    _, bg = _sign_up(db_session, ref=link.code)
    raw = _token_from(bg)
    _verify(request=None, req=VerifyEmailRequest(token=raw), db=db_session)
    # 第二次：网关预抓取 / 双击 / 另一台设备——都得是成功，不是「已失效」
    out = _verify(request=None, req=VerifyEmailRequest(token=raw), db=db_session)
    assert "verified" in out.message.lower()
    assert db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "plan:invite_trial").count() == 1


def test_no_deferred_trial_when_the_link_was_disabled_meanwhile(db_session):
    link = _trial_link(db_session)
    _, bg = _sign_up(db_session, ref=link.code)
    link.is_active = False
    db_session.commit()
    _verify(request=None, req=VerifyEmailRequest(token=_token_from(bg)), db=db_session)
    user = db_session.query(User).filter(User.email == "new@example.com").one()
    assert user.email_verified_at is not None
    assert user.plan == "FREE"


def test_no_second_trial_if_one_was_already_used(db_session):
    link = _trial_link(db_session)
    _, bg = _sign_up(db_session, ref=link.code)
    user = db_session.query(User).filter(User.email == "new@example.com").one()
    # 管理员手动发过一次又到期了 / an earlier trial already consumed
    user.trial_used_at = datetime.now(timezone.utc) - timedelta(days=30)
    db_session.commit()
    _verify(request=None, req=VerifyEmailRequest(token=_token_from(bg)), db=db_session)
    db_session.refresh(user)
    assert user.plan == "FREE"


# ---------- 令牌 / tokens ----------

def test_unknown_token_is_rejected(db_session):
    with pytest.raises(HTTPException) as exc:
        _verify(request=None, req=VerifyEmailRequest(token="x" * 43), db=db_session)
    assert exc.value.status_code == 400


def test_expired_token_fails_only_while_unverified(db_session):
    user = _mk_user(db_session)
    raw = email_verification.issue_token(db_session, user)
    db_session.commit()
    row = db_session.query(EmailVerificationToken).one()
    row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    db_session.commit()

    with pytest.raises(HTTPException):
        _verify(request=None, req=VerifyEmailRequest(token=raw), db=db_session)
    db_session.refresh(user)
    assert user.email_verified_at is None

    # 已经用别的方式验证了的人点到这封过期旧信：照样告诉他成功
    user.email_verified_at = datetime.now(timezone.utc)
    db_session.commit()
    _verify(request=None, req=VerifyEmailRequest(token=raw), db=db_session)


def test_resend_keeps_older_links_working(db_session):
    """国内邮箱常把新旧两封一起送到，先点开的是旧的也得能用。"""
    user = _mk_user(db_session)
    first = email_verification.issue_token(db_session, user)
    db_session.commit()
    email_verification.issue_token(db_session, user)
    db_session.commit()
    _verify(request=None, req=VerifyEmailRequest(token=first), db=db_session)
    db_session.refresh(user)
    assert user.email_verified_at is not None


# ---------- 重新发送 / resend ----------

def test_resend_queues_a_mail_for_an_unverified_user(db_session):
    user = _mk_user(db_session)
    bg = _Background()
    _resend(request=None, background=bg, user=user, db=db_session)
    assert len(bg.tasks) == 1
    assert bg.tasks[0][1][0] == user.email


def test_resend_is_a_no_op_once_verified(db_session):
    user = _mk_user(db_session, verified=True)
    bg = _Background()
    _resend(request=None, background=bg, user=user, db=db_session)
    assert bg.tasks == []


def test_resend_is_capped_per_hour(db_session):
    user = _mk_user(db_session)
    for _ in range(email_verification.VERIFY_MAX_PER_HOUR):
        _resend(request=None, background=_Background(), user=user, db=db_session)
    with pytest.raises(HTTPException) as exc:
        _resend(request=None, background=_Background(), user=user, db=db_session)
    assert exc.value.status_code == 429


# ---------- 其它证明邮箱所有权的路径 / other proofs of ownership ----------

def test_password_reset_counts_as_verification(db_session):
    from app.services.password_reset import issue_token as issue_reset

    user = _mk_user(db_session)
    raw = issue_reset(db_session, user)
    db_session.commit()
    _reset(request=None, req=ResetPasswordRequest(token=raw, password="a-brand-new-password"), db=db_session)
    db_session.refresh(user)
    assert user.email_verified_at is not None


def test_google_sign_up_is_verified_at_creation(db_session, monkeypatch):
    from app.core.config import settings
    from app.routers import auth as auth_mod
    from app.schemas import GoogleAuthRequest

    monkeypatch.setattr(settings, "GOOGLE_CLIENT_ID", "test-client")
    monkeypatch.setattr(auth_mod, "verify_google_id_token", lambda _c: {"email": "g@gmail.com"})
    out = auth_mod.google_login.__wrapped__(
        request=None, req=GoogleAuthRequest(credential="c" * 40), db=db_session
    )
    assert out.user.emailVerified is True


# ---------- 守门 / the gate ----------

def test_require_verified_email_blocks_unverified(db_session):
    with pytest.raises(HTTPException) as exc:
        require_verified_email(_mk_user(db_session))
    assert exc.value.status_code == 403
    assert exc.value.detail == EMAIL_NOT_VERIFIED_DETAIL


def test_require_verified_email_passes_verified(db_session):
    user = _mk_user(db_session, verified=True)
    assert require_verified_email(user) is user


@pytest.mark.parametrize(
    "module, fn",
    [
        ("app.routers.gateway", "gateway_verify"),
        ("app.routers.ea", "reset_token"),
        ("app.routers.payments", "claim_trial"),
    ],
)
def test_binding_and_trial_endpoints_are_gated(module, fn):
    """这三个端点换回 get_current_user 不会让任何别的测试失败——只有这里拦。"""
    import importlib

    endpoint = getattr(importlib.import_module(module), fn)
    endpoint = getattr(endpoint, "__wrapped__", endpoint)
    user_param = pyinspect.signature(endpoint).parameters["user"]
    assert user_param.default.dependency is require_verified_email


# ---------- 迁移 / migration ----------

@pytest.fixture()
def legacy_engine(monkeypatch, tmp_path):
    """上线之前的旧库：全表结构，但 users 没有 email_verified_at。手法同
    test_invite_links.legacy_engine（文件库，因为读写版本号各开一条连接）。"""
    from sqlalchemy.orm import sessionmaker

    from app.core.database import Base
    import app.models  # noqa: F401

    url = "sqlite:///" + str(tmp_path / "legacy.db").replace("\\", "/")
    eng = create_engine(url, connect_args={"check_same_thread": False})
    Base.metadata.create_all(eng)
    # 先用 ORM 插一个老用户（各 NOT NULL 列走模型默认值），再删列造出旧库。
    # Insert an existing user through the ORM (model defaults fill the NOT NULL
    # columns), then drop the column to get the pre-launch shape.
    with sessionmaker(bind=eng)() as s:
        s.add(User(id="u1", email="old@example.com", api_token="h1"))
        s.commit()
    with eng.begin() as conn:
        conn.execute(text("ALTER TABLE users DROP COLUMN email_verified_at"))
    monkeypatch.setattr(db_mod, "engine", eng)
    monkeypatch.setattr(
        db_mod, "SessionLocal", sessionmaker(bind=eng, autocommit=False, autoflush=False)
    )
    yield eng
    eng.dispose()


def test_migration_grandfathers_existing_users(legacy_engine):
    db_mod._migrate_columns()
    with legacy_engine.connect() as conn:
        v = conn.execute(text("SELECT email_verified_at FROM users WHERE id = 'u1'")).scalar()
    assert v is not None, "存量用户没被回填为已验证——上线当天所有老用户都会被拦"
    assert db_mod._read_schema_rev() == db_mod.CURRENT_SCHEMA_REV


# ---------- 管理员手动标记 / admin manual mark ----------

def test_admin_can_mark_verified_and_it_grants_the_held_back_trial(db_session):
    """收不到信的用户由管理员放行：结果与点链接一致，邀请试用照样补发，并留审计。"""
    from app.routers.admin import mark_email_verified

    link = _trial_link(db_session)
    _sign_up(db_session, ref=link.code)
    user = db_session.query(User).filter(User.email == "new@example.com").one()
    admin = _mk_user(db_session, email="admin@example.com", verified=True)

    out = mark_email_verified(user_id=user.id, db=db_session, admin=admin)
    assert out.emailVerifiedAt is not None
    db_session.refresh(user)
    assert user.plan == "PRO" and user.plan_is_trial is True
    assert db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "account:verify_email").count() == 1

    # 再点一次：原样返回，不重复写审计 / idempotent, no second audit row
    mark_email_verified(user_id=user.id, db=db_session, admin=admin)
    assert db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "account:verify_email").count() == 1


def test_admin_mark_verified_unknown_user_is_404(db_session):
    from app.routers.admin import mark_email_verified

    admin = _mk_user(db_session, email="admin@example.com", verified=True)
    with pytest.raises(HTTPException) as exc:
        mark_email_verified(user_id="nope", db=db_session, admin=admin)
    assert exc.value.status_code == 404
