"""2026-10-26 审计 C 组：会话吊销。

· 鉴权缓存只在最外层事务真正 COMMIT 之后失效（SAVEPOINT 释放 / 回滚不算）。
· 会话版本自增（退出所有设备、改密、重置密码、管理员停用）删掉这个账号的全部推送订阅。
· /ws/client 已打开的连接定期复核会话，吊销 / 停用 / 到期后注销并关闭。
· /ws/client 鉴权首帧先卡长度再解析，超长帧不进 json.loads。

2026-10-26 audit, group C: session revocation — auth-cache invalidation only on the
outermost COMMIT; tv bumps drop push subscriptions; open client sockets re-check
their session; the first WS frame is length-capped before parsing.
"""
import asyncio
import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException, WebSocketDisconnect
from sqlalchemy.orm import sessionmaker

from app.core.security import create_access_token, generate_api_token, hash_api_token, hash_password
from app.models import PushSubscription, User
from app.routers import ws as ws_mod
from app.services import deps, shared_cache


# ---------------------------------------------------------------------------
# 夹具 / fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def auth_db(db_session, monkeypatch):
    """deps.SessionLocal 指向测试库（get_auth_state 未命中时查它）。"""
    monkeypatch.setattr(deps, "SessionLocal", sessionmaker(bind=db_session.get_bind()))
    return db_session


def _mk_user(db, email="u@example.com", password="original-password", **kw):
    u = User(
        email=email,
        phone="+60123456789",
        password_hash=hash_password(password) if password else None,
        api_token=hash_api_token(generate_api_token()),
        plan="PRO",
        **kw,
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _tok(user):
    return create_access_token(user.id, user.token_version or 0)


def _add_sub(db, user, tail="dev"):
    db.add(PushSubscription(user_id=user.id, endpoint=f"https://fcm.googleapis.com/fcm/send/{tail}",
                            keys_p256dh="p" * 87, keys_auth="a" * 22))
    db.commit()


def _sub_count(db, user):
    return db.query(PushSubscription).filter(PushSubscription.user_id == user.id).count()


# ---------------------------------------------------------------------------
# 1. 鉴权缓存失效只认最外层 COMMIT / auth cache invalidation on the real commit only
# ---------------------------------------------------------------------------

def test_savepoint_release_does_not_invalidate_before_the_outer_commit(auth_db):
    """SAVEPOINT 释放时外层还没提交：此刻失效，并发读者会把旧 tv 写回缓存（这里直接模拟那次
    写回），外层 COMMIT 之后旧 token 仍被放行 300 秒。修复后失效发生在真正 COMMIT 之后。"""
    user = _mk_user(auth_db)
    old = _tok(user)
    assert deps.check_token_light(old) == user.id

    user.token_version = 1
    auth_db.flush()
    with auth_db.begin_nested():
        pass
    # 并发未命中读者在 SAVEPOINT 释放与 COMMIT 之间读到库里仍是 0 的 tv，写回缓存。
    shared_cache.set_json(shared_cache.auth_state_key(user.id), {"tv": 0, "d": False}, ttl=300)
    auth_db.commit()

    with pytest.raises(HTTPException) as exc:
        deps.check_token_light(old)
    assert exc.value.status_code == 401


def test_savepoint_rollback_keeps_an_earlier_tv_bump_noted(auth_db):
    """SAVEPOINT 回滚只撤销它里面的改动；之前 flush 的 tv 自增仍会提交，失效记录不能丢。"""
    user = _mk_user(auth_db)
    old = _tok(user)
    assert deps.check_token_light(old) == user.id   # 缓存已热

    user.token_version = 1
    auth_db.flush()
    try:
        with auth_db.begin_nested():
            raise RuntimeError("inner failure")
    except RuntimeError:
        pass
    auth_db.commit()

    with pytest.raises(HTTPException) as exc:
        deps.check_token_light(old)
    assert exc.value.status_code == 401


def test_reset_password_invalidates_only_after_the_commit(auth_db, monkeypatch):
    """端到端：未验证账号重置密码（mark_verified → conversions.record 里有 begin_nested）。
    至少有一次失效发生在 COMMIT 之后，且 COMMIT 之前一次都没有。"""
    from app.routers import auth as auth_router
    from app.services.password_reset import issue_token

    user = _mk_user(auth_db, email="unverified@example.com", email_verified_at=None)
    raw = issue_token(auth_db, user)
    auth_db.commit()

    # 引擎级 commit 事件只在真正的 DBAPI COMMIT 时触发（SAVEPOINT 释放走 release_savepoint）。
    from sqlalchemy import event

    flags = {"committed": False}
    engine = auth_db.get_bind()

    def _on_commit(conn):
        flags["committed"] = True

    event.listen(engine, "commit", _on_commit)

    calls: list[bool] = []
    real_invalidate = shared_cache.invalidate_auth_state

    def _spy(*ids):
        calls.append(flags["committed"])
        return real_invalidate(*ids)

    monkeypatch.setattr(shared_cache, "invalidate_auth_state", _spy)
    monkeypatch.setattr(auth_router, "clear_failed_logins", lambda *a, **k: None)
    monkeypatch.setattr(auth_router, "login_source", lambda request: "src")

    req = auth_router.ResetPasswordRequest(token=raw, password="brand-new-password")
    auth_router.reset_password.__wrapped__(request=None, req=req, db=auth_db)

    event.remove(engine, "commit", _on_commit)
    assert calls, "重置密码没有触发鉴权缓存失效"
    assert all(calls), f"失效发生在 COMMIT 之前: {calls}"


# ---------------------------------------------------------------------------
# 2. 会话吊销删掉推送订阅 / session revocation drops push subscriptions
# ---------------------------------------------------------------------------

def test_logout_all_drops_push_subscriptions(db_session):
    from app.routers.account import logout_all

    user = _mk_user(db_session)
    _add_sub(db_session, user, "attacker")
    other = _mk_user(db_session, email="other@example.com")
    _add_sub(db_session, other, "other")

    logout_all.__wrapped__(request=None, db=db_session, current_user=user)

    assert _sub_count(db_session, user) == 0
    assert _sub_count(db_session, other) == 1, "别人的订阅不该受影响"


def test_change_password_drops_push_subscriptions(db_session):
    from app.routers.account import ChangePasswordRequest, change_password

    user = _mk_user(db_session)
    _add_sub(db_session, user, "attacker")
    out = change_password.__wrapped__(
        request=None,
        body=ChangePasswordRequest(old_password="original-password", new_password="another-password"),
        background=None, db=db_session, current_user=user,
    )
    assert out["ok"] is True and out["token"]
    assert _sub_count(db_session, user) == 0


def test_reset_password_drops_push_subscriptions(db_session, monkeypatch):
    from app.routers import auth as auth_router
    from app.services.password_reset import issue_token

    user = _mk_user(db_session, email_verified_at=datetime.now(timezone.utc))
    _add_sub(db_session, user, "attacker")
    raw = issue_token(db_session, user)
    db_session.commit()
    monkeypatch.setattr(auth_router, "clear_failed_logins", lambda *a, **k: None)
    monkeypatch.setattr(auth_router, "login_source", lambda request: "src")

    auth_router.reset_password.__wrapped__(
        request=None, req=auth_router.ResetPasswordRequest(token=raw, password="brand-new-password"),
        db=db_session,
    )
    assert _sub_count(db_session, user) == 0


def test_admin_style_disable_with_tv_bump_drops_push_subscriptions(db_session):
    """管理员停用（admin.py：disabled_at + tv 自增）走同一个 ORM 钩子。"""
    user = _mk_user(db_session)
    _add_sub(db_session, user)
    user.disabled_at = datetime.now(timezone.utc)
    user.token_version = (user.token_version or 0) + 1
    db_session.commit()
    assert _sub_count(db_session, user) == 0


def test_unrelated_user_update_keeps_push_subscriptions(db_session):
    user = _mk_user(db_session)
    _add_sub(db_session, user)
    user.plan = "FREE"
    db_session.commit()
    assert _sub_count(db_session, user) == 1


def test_rolled_back_tv_bump_keeps_push_subscriptions(db_session):
    user = _mk_user(db_session)
    _add_sub(db_session, user)
    user.token_version = (user.token_version or 0) + 1
    db_session.flush()
    db_session.rollback()
    assert _sub_count(db_session, user) == 1


def test_revoked_subscription_gets_no_event_push(db_session, monkeypatch):
    """端到端：吊销之后的事件推送不再发到吊销之前注册的那台设备。"""
    from types import SimpleNamespace

    from app.models import NotificationPref
    from app.routers.account import logout_all
    from app.services import push_dispatch as pd

    user = _mk_user(db_session)
    db_session.add(NotificationPref(user_id=user.id, enabled=True))
    db_session.commit()
    _add_sub(db_session, user, "attacker")

    monkeypatch.setattr(pd, "SessionLocal", sessionmaker(bind=db_session.get_bind(), autoflush=False))
    monkeypatch.setattr(pd, "settings", SimpleNamespace(
        VAPID_SUBJECT="mailto:t@t.local", vapid_private_key="pem", VAPID_PUBLIC_KEY="pub"))
    monkeypatch.setattr(pd, "_ws_fallback", lambda *a, **k: None)
    monkeypatch.setattr(pd, "_prune_subscriptions", lambda ids: None)
    sent: list[str] = []

    def _send_all(subs, *a, **k):
        sent.extend(s.endpoint for s in subs)
        return [(True, False)] * len(subs)

    monkeypatch.setattr(pd, "_send_all", _send_all)

    logout_all.__wrapped__(request=None, db=db_session, current_user=user)
    pd.dispatch_event_push(user.id, pd.EVENT_ORDER_REJECTED, "t", "b")
    assert "https://fcm.googleapis.com/fcm/send/attacker" not in sent


# ---------------------------------------------------------------------------
# 3. 已打开的 /ws/client 连接复核会话 / open client sockets re-check their session
# ---------------------------------------------------------------------------

class _OpenWS:
    """鉴权通过后一直开着（receive_text 一直挂着，直到被关闭），记录发出的帧与关闭。"""

    def __init__(self, token):
        self._token = token
        self.sent: list[dict] = []
        self.closed = asyncio.Event()
        self.close_code = None

    async def accept(self):
        pass

    async def receive(self):
        return {"type": "websocket.receive", "text": json.dumps({"type": "AUTH", "token": self._token})}

    async def receive_text(self):
        await self.closed.wait()
        raise WebSocketDisconnect(code=self.close_code or 1000)

    async def send_json(self, data):
        if self.closed.is_set():
            raise RuntimeError("closed")
        self.sent.append(data)

    async def close(self, code=1000):
        self.close_code = code
        self.closed.set()


class _Mgr:
    def __init__(self):
        self.live: dict[str, set] = {}

    async def register_client(self, user_id, ws):
        self.live.setdefault(user_id, set()).add(ws)

    async def unregister_client(self, user_id, ws):
        self.live.get(user_id, set()).discard(ws)

    def set_background(self, ws, bg):
        pass

    async def connect_snapshot_async(self, user_id):
        return {}

    @staticmethod
    def account_funds_from_positions(p):
        return []


@pytest.fixture()
def ws_env(auth_db, monkeypatch):
    mgr = _Mgr()
    monkeypatch.setattr(ws_mod, "manager", mgr)
    monkeypatch.setattr(ws_mod, "SESSION_RECHECK_SECONDS", 0.02)

    async def _noop(*a, **k):
        return None

    monkeypatch.setattr(ws_mod, "_netq", _noop)

    # 内存 SQLite 每个线程一个库：鉴权就地执行，不进线程池。
    async def _inline(fn, *a, **k):
        return fn(*a, **k)

    monkeypatch.setattr(ws_mod, "run_in_threadpool", _inline)
    return mgr


async def _drive(ws, mutate, wait=1.0):
    task = asyncio.create_task(ws_mod.ws_client(ws))
    for _ in range(100):
        await asyncio.sleep(0.01)
        if ws.sent:
            break
    assert ws.sent and ws.sent[0]["type"] == "AUTH_OK"
    mutate()
    try:
        await asyncio.wait_for(ws.closed.wait(), timeout=wait)
    except asyncio.TimeoutError:
        pass
    closed = ws.closed.is_set()
    if not closed:
        await ws.close()
    await asyncio.wait_for(task, timeout=2)
    return closed


def _revocation_cases():
    def logout_all(db, user):
        user.token_version = (user.token_version or 0) + 1
        db.commit()

    def admin_disable(db, user):
        user.disabled_at = datetime.now(timezone.utc)
        user.token_version = (user.token_version or 0) + 1
        db.commit()

    return {"logout_all": logout_all, "admin_disable": admin_disable}


@pytest.mark.parametrize("case", ["logout_all", "admin_disable"])
def test_open_socket_is_closed_after_revocation(ws_env, auth_db, case):
    user = _mk_user(auth_db)
    ws = _OpenWS(_tok(user))
    mutate = _revocation_cases()[case]

    closed = asyncio.run(_drive(ws, lambda: mutate(auth_db, user)))

    assert closed, "吊销之后旧连接没有被关闭"
    assert ws not in ws_env.live.get(user.id, set()), "吊销之后旧连接仍在投递名单里"
    assert ws.sent[-1] == {"type": "AUTH_FAIL", "reason": "invalid token"}


def test_open_socket_is_closed_once_the_jwt_expires(ws_env, auth_db):
    user = _mk_user(auth_db)
    # 1 秒后到期（JWT exp 精度是秒）
    import jwt

    from app.core.config import settings

    token = jwt.encode(
        {"sub": user.id, "tv": 0, "exp": datetime.now(timezone.utc) + timedelta(seconds=1)},
        settings.JWT_SECRET, algorithm=settings.JWT_ALGORITHM,
    )
    ws = _OpenWS(token)
    closed = asyncio.run(_drive(ws, lambda: None, wait=3.0))
    assert closed, "JWT 到期后连接没有被关闭"


def test_open_socket_survives_while_the_session_is_valid(ws_env, auth_db):
    user = _mk_user(auth_db)
    ws = _OpenWS(_tok(user))
    closed = asyncio.run(_drive(ws, lambda: None, wait=0.3))
    assert not closed, "会话有效时连接被误关"
    assert [f["type"] for f in ws.sent] == ["AUTH_OK"]


# ---------------------------------------------------------------------------
# 4. 鉴权首帧先卡长度 / the first frame is length-capped before parsing
# ---------------------------------------------------------------------------

class _BigFrameWS:
    def __init__(self, text):
        self._text = text
        self.sent: list[dict] = []
        self.closed = False

    async def accept(self):
        pass

    async def receive(self):
        return {"type": "websocket.receive", "text": self._text}

    async def receive_json(self):
        # starlette 的 receive_json 就是整段 json.loads（旧实现走这条）
        return json.loads(self._text)

    async def send_json(self, data):
        self.sent.append(data)

    async def close(self, code=1000):
        self.closed = True


def test_oversized_first_frame_is_rejected_without_json_parsing(monkeypatch):
    big = json.dumps({"type": "X", "pad": "a" * (1 << 20)})
    seen: list[int] = []
    real_loads = json.loads

    def _spy(s, *a, **k):
        seen.append(len(s))
        return real_loads(s, *a, **k)

    monkeypatch.setattr(ws_mod.json, "loads", _spy)
    ws = _BigFrameWS(big)
    asyncio.run(ws_mod.ws_client(ws))

    assert ws.sent == [{"type": "AUTH_FAIL", "reason": "invalid token"}]
    assert ws.closed
    assert all(n <= ws_mod.MAX_AUTH_FRAME_CHARS for n in seen), f"超长首帧被解析了: {seen}"


def test_oversized_binary_first_frame_is_rejected():
    class _Bin(_BigFrameWS):
        async def receive(self):
            return {"type": "websocket.receive", "bytes": b"{" + b" " * (1 << 20) + b"}"}

    ws = _Bin("")
    asyncio.run(ws_mod.ws_client(ws))
    assert ws.sent == [{"type": "AUTH_FAIL", "reason": "invalid token"}]


def test_normal_auth_frame_is_well_under_the_cap(auth_db):
    user = _mk_user(auth_db)
    frame = json.dumps({"type": "AUTH", "token": _tok(user)})
    assert len(frame) < ws_mod.MAX_AUTH_FRAME_CHARS // 4
    assert ws_mod._parse_auth_frame({"type": "websocket.receive", "text": frame}) == _tok(user)
