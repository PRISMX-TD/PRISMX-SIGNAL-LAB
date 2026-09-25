"""桥接 API Token 鉴权也要挡住被管理员停用的账号。

JWT 路径的停用闸门在 deps.get_current_user（见 test_account_disable.py），但桥接走
X-API-Token，从不经过那里；停用时自增的 token_version 也管不到 API Token。所以
这里单独验证：
1. 停用后桥接请求 403，且与 JWT 路径同一状态码与文案（带原因）；
2. 鉴权缓存命中期间被停用，版本号一变（本 worker 立即 / 别的 worker 约 1 秒）就被拒；
3. 恢复后桥接可用。

The bridge authenticates by API token and never passes get_current_user, so
the disable gate has to be enforced there separately — including when the
user is served from the auth cache.
"""
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException, Response

from app.core.security import hash_api_token
from app.models import User
from app.routers import bridge
from app.routers.admin import disable_user, enable_user
from app.schemas import AdminUserDisableIn
from app.services import shared_state
from app.services.deps import disabled_account_error, get_current_user

RAW = "raw-bridge-token-disable-test"


@pytest.fixture(autouse=True)
def _clean_auth_cache():
    with bridge._auth_cache_lock:
        bridge._auth_cache.clear()
    bridge._auth_version.reset_local()
    yield
    with bridge._auth_cache_lock:
        bridge._auth_cache.clear()
    bridge._auth_version.reset_local()


def _mk(db, email, role="user", **kw) -> User:
    kw.setdefault("api_token", hash_api_token("other-" + email))
    u = User(email=email, password_hash="x", role=role, plan="PRO", **kw)
    db.add(u)
    db.commit()
    return u


def _bridge_user(db):
    return bridge.get_bridge_user(x_api_token=RAW, db=db)


def test_disabled_account_is_refused_by_bridge_with_the_jwt_error(db_session):
    user = _mk(db_session, "b1@t.co", api_token=hash_api_token(RAW),
               disabled_at=datetime.now(timezone.utc), disabled_reason="涉嫌刷单")
    with pytest.raises(HTTPException) as err:
        _bridge_user(db_session)
    assert err.value.status_code == 403
    assert "涉嫌刷单" in err.value.detail
    # 与 JWT 路径完全同一个错误 / exactly the JWT path's error
    expected = disabled_account_error(user)
    assert (err.value.status_code, err.value.detail) == (expected.status_code, expected.detail)


def test_admin_disable_rejects_a_cached_bridge_user_and_enable_restores(db_session):
    admin = _mk(db_session, "admin@t.co", role="admin")
    user = _mk(db_session, "b2@t.co", api_token=hash_api_token(RAW))
    uid = user.id

    assert _bridge_user(db_session).id == uid          # 进缓存 / now cached

    disable_user(user_id=uid, body=AdminUserDisableIn(reason="违规"), db=db_session, admin=admin)
    with pytest.raises(HTTPException) as err:           # 缓存条目被版本号作废
        _bridge_user(db_session)
    assert err.value.status_code == 403
    assert "违规" in err.value.detail

    enable_user(user_id=uid, db=db_session, admin=admin)
    assert _bridge_user(db_session).id == uid          # 恢复后立即可用


def test_disable_on_another_worker_rejects_cached_user_after_version_change(db_session):
    user = _mk(db_session, "b3@t.co", api_token=hash_api_token(RAW))
    uid = user.id
    assert _bridge_user(db_session).id == uid          # 本 worker 缓存命中中

    # 另一个 worker 停用了他：写库 commit，但本进程缓存没被清。
    db_session.query(User).filter(User.id == uid).update(
        {User.disabled_at: datetime.now(timezone.utc).replace(tzinfo=None)})
    db_session.commit()
    # 版本号没变之前仍命中旧缓存（这就是需要换版本号的原因）。
    assert _bridge_user(db_session).id == uid

    # 那边 bump 了共享版本号；本 worker 本地 1 秒缓存过期后即看到新版本。
    shared_state.kv_set(bridge._auth_version._key, "bumped-elsewhere")
    bridge._auth_version.reset_local()
    with pytest.raises(HTTPException) as err:
        _bridge_user(db_session)
    assert err.value.status_code == 403

    # 那边又恢复了他 → 再换版本号 → 本 worker 放行。
    db_session.query(User).filter(User.id == uid).update({User.disabled_at: None})
    db_session.commit()
    shared_state.kv_set(bridge._auth_version._key, "bumped-elsewhere-2")
    bridge._auth_version.reset_local()
    assert _bridge_user(db_session).id == uid


def test_admin_disable_and_enable_bump_the_shared_bridge_auth_version(db_session):
    admin = _mk(db_session, "admin2@t.co", role="admin")
    user = _mk(db_session, "b4@t.co", api_token=hash_api_token(RAW))
    stamp = bridge._auth_version.current()
    disable_user(user_id=user.id, body=AdminUserDisableIn(reason=None), db=db_session, admin=admin)
    assert bridge._auth_version.is_stale(stamp)
    stamp = bridge._auth_version.current()
    enable_user(user_id=user.id, db=db_session, admin=admin)
    assert bridge._auth_version.is_stale(stamp)


def test_jwt_path_still_uses_the_same_error(db_session):
    from app.core.security import create_access_token

    user = _mk(db_session, "b5@t.co", disabled_at=datetime.now(timezone.utc))
    with pytest.raises(HTTPException) as err:
        get_current_user(response=Response(),
                         authorization="Bearer " + create_access_token(user.id, 0), db=db_session)
    assert err.value.detail == disabled_account_error(user).detail
