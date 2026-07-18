"""K 线保留策略 / 自定义策略平台的管理后台设置端点单测。

Admin-settings endpoint tests for candle-history retention and the
custom-strategy platform.
"""
from app.core.security import create_access_token, generate_api_token, hash_api_token
from app.models import User
from app.services.settings_store import invalidate_candle_cache, invalidate_strategy_settings_cache


def _admin_headers(db):
    admin = User(email="admin@example.com", password_hash="x", api_token=hash_api_token(generate_api_token()), role="admin")
    db.add(admin)
    db.commit()
    db.refresh(admin)
    return {"Authorization": f"Bearer {create_access_token(admin.id)}"}


def test_candle_history_settings_get_put(client, db):
    headers = _admin_headers(db)
    res = client.get("/api/admin/candle-history", headers=headers)
    assert res.status_code == 200
    assert res.json()["m1RetentionDays"] == 30

    put = client.put("/api/admin/candle-history", headers=headers, json={"m1RetentionDays": 60})
    assert put.status_code == 200
    assert put.json()["m1RetentionDays"] == 60
    invalidate_candle_cache()


def test_candle_history_settings_requires_admin(client, db, auth_headers):
    assert client.get("/api/admin/candle-history", headers=auth_headers).status_code == 403


def test_strategy_platform_settings_get_put(client, db):
    headers = _admin_headers(db)
    res = client.get("/api/admin/strategy-settings", headers=headers)
    assert res.status_code == 200
    assert res.json() == {"maxStrategiesPerUser": 3, "proOnly": True}

    put = client.put("/api/admin/strategy-settings", headers=headers, json={"maxStrategiesPerUser": 5, "proOnly": False})
    assert put.status_code == 200
    assert put.json() == {"maxStrategiesPerUser": 5, "proOnly": False}
    invalidate_strategy_settings_cache()


def test_strategy_platform_settings_requires_admin(client, db, auth_headers):
    assert client.get("/api/admin/strategy-settings", headers=auth_headers).status_code == 403
