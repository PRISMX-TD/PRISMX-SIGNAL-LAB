"""PRO 免费试用的单测：资格判定、领取的原子抢占、到期/付费/管理员操作三处清理。
Unit tests for the PRO free trial: eligibility, the atomic claim, and the
three places the trial flag is cleared (expiry, paid conversion, admin change).
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.core.security import create_access_token, generate_api_token, hash_api_token
from app.models import Payment, User
from app.routers.payments import _sync_payment_status
from app.services.plan_expiry import downgrade_if_expired
from app.services.settings_store import invalidate_trial_cache, save_trial_settings


@pytest.fixture(autouse=True)
def _reset_trial_cache():
    """settings_store 的试用配置缓存是进程级全局变量，不随每个测试的 `db`
    fixture（drop_all + 重建）一起清空；显式失效，保证每个测试从头读取
    当前（刚重建的）数据库，而不是上一个测试写入后留下的缓存值。
    settings_store's trial-settings cache is a process-wide global, not reset
    by each test's `db` fixture (drop_all + recreate); invalidate it
    explicitly so every test reads the freshly-recreated database instead of
    a stale value left over from a previous test's write.
    """
    invalidate_trial_cache()
    yield
    invalidate_trial_cache()


def _now():
    return datetime.now(timezone.utc)


def _admin_headers(db):
    admin = User(
        email="admin@example.com",
        password_hash="x",
        api_token=hash_api_token(generate_api_token()),
        role="admin",
    )
    db.add(admin)
    db.commit()
    db.refresh(admin)
    return {"Authorization": f"Bearer {create_access_token(admin.id)}"}


def _enable_trial(db, days=7):
    save_trial_settings(db, {"trial_enabled": True, "trial_days": days})
    db.commit()
    invalidate_trial_cache()


def test_claim_rejected_when_disabled(client, db, auth_headers):
    # 开关默认关闭：GET 报不可用，claim 返回 400 / disabled by default
    res = client.get("/api/payments/trial", headers=auth_headers)
    assert res.status_code == 200
    body = res.json()
    assert body["enabled"] is False
    assert body["eligible"] is False

    claim = client.post("/api/payments/trial/claim", headers=auth_headers)
    assert claim.status_code == 400


def test_claim_success_upgrades_to_pro(client, db, auth_headers, user):
    _enable_trial(db, days=7)

    status = client.get("/api/payments/trial", headers=auth_headers).json()
    assert status["enabled"] is True
    assert status["eligible"] is True
    assert status["usedAt"] is None

    claim = client.post("/api/payments/trial/claim", headers=auth_headers)
    assert claim.status_code == 200
    body = claim.json()
    assert body["ok"] is True
    assert body["days"] == 7

    me = client.get("/api/auth/me", headers=auth_headers).json()
    assert me["plan"] == "PRO"
    assert me["planIsTrial"] is True
    assert me["planExpiresAt"] is not None


def test_claim_twice_rejected(client, db, auth_headers):
    _enable_trial(db)
    first = client.post("/api/payments/trial/claim", headers=auth_headers)
    assert first.status_code == 200

    status = client.get("/api/payments/trial", headers=auth_headers).json()
    assert status["eligible"] is False
    assert status["usedAt"] is not None

    second = client.post("/api/payments/trial/claim", headers=auth_headers)
    assert second.status_code == 409


def test_claim_rejected_for_existing_pro(client, db, auth_headers, user):
    _enable_trial(db)
    user.plan = "PRO"
    db.add(user)
    db.commit()

    claim = client.post("/api/payments/trial/claim", headers=auth_headers)
    assert claim.status_code == 409


def test_expiry_downgrade_clears_trial_flag(db, user):
    _enable_trial(db)
    user.plan = "PRO"
    user.plan_is_trial = True
    user.plan_expires_at = _now() - timedelta(minutes=1)  # 已过期 / already expired
    user.trial_used_at = _now() - timedelta(days=8)
    db.add(user)
    db.commit()

    changed = downgrade_if_expired(db, user)
    db.commit()

    assert changed is True
    assert user.plan == "FREE"
    assert user.plan_is_trial is False
    assert user.plan_expires_at is None
    # 终身一次的凭据不清除，到期后不能再次试用 / lifetime-once credential stays put
    assert user.trial_used_at is not None


def test_expired_trial_cannot_reclaim(client, db, auth_headers, user):
    _enable_trial(db)
    user.trial_used_at = _now() - timedelta(days=8)
    user.plan = "FREE"
    db.add(user)
    db.commit()

    claim = client.post("/api/payments/trial/claim", headers=auth_headers)
    assert claim.status_code == 409


def test_paid_conversion_during_trial_starts_from_now(db, user):
    """试用期内付费转正：时长从付款时刻起算，不叠加试用剩余天数。
    Paid conversion during a trial starts from now, discarding trial remainder."""
    now = _now()
    user.plan = "PRO"
    user.plan_is_trial = True
    user.plan_expires_at = now + timedelta(days=5)  # 试用还剩 5 天 / 5 trial days left
    db.add(user)
    db.commit()

    payment = Payment(
        user_id=user.id,
        nowpayments_payment_id="np_test_1",
        plan="pro_monthly",  # 30 天 / 30 days
        amount_usd=49.0,
        pay_currency="usdttrc20",
        status="PENDING",
    )
    db.add(payment)
    db.commit()

    _sync_payment_status(db, payment, "finished", {})

    db.refresh(user)
    assert user.plan == "PRO"
    assert user.plan_is_trial is False
    # 基准是"现在"而不是"现有到期时间"：约 30 天后到期，而不是 35 天
    # base is "now", not the existing expiry: ~30 days out, not 35
    delta_days = (user.plan_expires_at.replace(tzinfo=timezone.utc) - now).days
    assert 29 <= delta_days <= 30


def test_permanent_pro_untouched_by_payment(db, user):
    """管理员赠送的永久 PRO（无到期时间、非试用）不应被付款覆盖成有期限。
    An admin-granted permanent PRO (no expiry, not a trial) must not be turned
    into a time-limited one by an incoming payment."""
    user.plan = "PRO"
    user.plan_is_trial = False
    user.plan_expires_at = None
    db.add(user)
    db.commit()

    payment = Payment(
        user_id=user.id,
        nowpayments_payment_id="np_test_2",
        plan="pro_monthly",
        amount_usd=49.0,
        pay_currency="usdttrc20",
        status="PENDING",
    )
    db.add(payment)
    db.commit()

    _sync_payment_status(db, payment, "finished", {})

    db.refresh(user)
    assert user.plan == "PRO"
    assert user.plan_expires_at is None  # 仍是永久 / still permanent


def test_admin_updates_trial_settings(client, db):
    headers = _admin_headers(db)

    res = client.get("/api/admin/trial", headers=headers)
    assert res.status_code == 200
    assert res.json() == {"trialEnabled": False, "trialDays": 7}

    put = client.put(
        "/api/admin/trial",
        headers=headers,
        json={"trialEnabled": True, "trialDays": 14},
    )
    assert put.status_code == 200
    assert put.json() == {"trialEnabled": True, "trialDays": 14}


def test_admin_trial_days_out_of_range_rejected(client, db):
    headers = _admin_headers(db)
    res = client.put(
        "/api/admin/trial",
        headers=headers,
        json={"trialEnabled": True, "trialDays": 0},
    )
    assert res.status_code == 422

    res2 = client.put(
        "/api/admin/trial",
        headers=headers,
        json={"trialEnabled": True, "trialDays": 91},
    )
    assert res2.status_code == 422


def test_admin_manual_plan_change_clears_trial_flag(client, db, user):
    _enable_trial(db)
    user.plan = "PRO"
    user.plan_is_trial = True
    user.plan_expires_at = _now() + timedelta(days=3)
    db.add(user)
    db.commit()

    headers = _admin_headers(db)
    res = client.patch(
        f"/api/admin/users/{user.id}",
        headers=headers,
        json={"plan": "FREE"},
    )
    assert res.status_code == 200

    db.refresh(user)
    assert user.plan == "FREE"
    assert user.plan_is_trial is False
