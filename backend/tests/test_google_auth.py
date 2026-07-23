"""Google 登录端到端测试：首次登录建号、账号预劫持防护，以及 2026-07 修复的
回归——"账号本来就是 Google 登录创建的，后来自己加了密码，此后 Google 登录
被永久拒绝"。verify_google_id_token 打桩，不真的调用 Google 服务器。

End-to-end tests for Google sign-in: first-login account creation, the
account pre-hijack guard, and the regression fixed 2026-07 — "an account that
originated from Google login, after its owner later added a password, was
permanently refused Google login afterward". verify_google_id_token is
monkeypatched; no real call to Google's servers.
"""
from datetime import datetime, timedelta, timezone

from app.core.security import hash_password
from app.models import User
from app.routers import auth as auth_router


def _stub_google(monkeypatch, email: str) -> None:
    """把 verify_google_id_token 打桩成返回一个已验证邮箱的固定载荷。
    Stub verify_google_id_token to return a fixed verified-email payload."""
    monkeypatch.setattr(
        auth_router,
        "verify_google_id_token",
        lambda credential: {"email": email, "email_verified": True, "iss": "accounts.google.com"},
    )


def _enable_google(monkeypatch) -> None:
    from app.core.config import settings

    monkeypatch.setattr(settings, "GOOGLE_CLIENT_ID", "test-client-id")


def test_first_time_google_login_creates_passwordless_user_and_marks_verified(client, db, monkeypatch):
    """首次 Google 登录：新建无密码用户，并当场记下 Google 身份已验证
    （google_linked_at 非空）——后面加密码的场景全靠这个时间戳兜底。
    First Google login: creates a password-less user and immediately records
    the Google identity as verified (google_linked_at set) — everything about
    the later-adds-a-password scenario rests on this timestamp."""
    _enable_google(monkeypatch)
    _stub_google(monkeypatch, "newbie@example.com")

    res = client.post("/api/auth/google", json={"credential": "fake-token"})
    assert res.status_code == 200
    body = res.json()
    assert body["user"]["email"] == "newbie@example.com"

    row = db.query(User).filter(User.email == "newbie@example.com").first()
    assert row is not None
    assert row.password_hash is None
    assert row.google_linked_at is not None


def test_google_login_blocked_for_password_account_never_google_verified(client, db, monkeypatch):
    """账号预劫持防护（未受影响）：邮箱已被一个密码账号占用、且这个邮箱的
    Google 身份从未验证过 —— 一律拒绝，不管密码是谁设的。
    Pre-hijack guard (unaffected by the fix): email already belongs to a
    password account whose Google identity has never been verified — always
    refused, regardless of who set the password."""
    _enable_google(monkeypatch)
    db.add(User(email="victim@example.com", password_hash=hash_password("whatever123"), api_token="tok-1"))
    db.commit()
    _stub_google(monkeypatch, "victim@example.com")

    res = client.post("/api/auth/google", json={"credential": "fake-token"})
    assert res.status_code == 409


def test_google_login_allowed_after_owner_sets_password_post_google_signup(client, db, monkeypatch):
    """回归测试（2026-07 修复的问题）：账号本来就是靠 Google 登录创建的
    （google_linked_at 已在创建时设好），用户后来自己在账户设置里加了密码
    ——此后仍然应该能用 Google 登录，不该被账号预劫持防护误伤。
    Regression test (the bug fixed 2026-07): an account that originated from
    Google login (google_linked_at set at creation) whose owner later added a
    password from their own account settings — Google login must keep
    working afterward, not get caught by the pre-hijack guard."""
    _enable_google(monkeypatch)
    now = datetime.now(timezone.utc)
    db.add(User(
        email="upgraded@example.com",
        password_hash=hash_password("mynewpassword123"),
        api_token="tok-2",
        google_linked_at=now - timedelta(days=30),
    ))
    db.commit()
    _stub_google(monkeypatch, "upgraded@example.com")

    res = client.post("/api/auth/google", json={"credential": "fake-token"})
    assert res.status_code == 200
    assert res.json()["user"]["email"] == "upgraded@example.com"


def test_google_login_disabled_returns_503_without_client_id(client, db, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "GOOGLE_CLIENT_ID", "")
    res = client.post("/api/auth/google", json={"credential": "fake-token"})
    assert res.status_code == 503


def test_google_login_rejects_invalid_credential(client, db, monkeypatch):
    _enable_google(monkeypatch)
    monkeypatch.setattr(auth_router, "verify_google_id_token", lambda credential: None)
    res = client.post("/api/auth/google", json={"credential": "garbage"})
    assert res.status_code == 401
