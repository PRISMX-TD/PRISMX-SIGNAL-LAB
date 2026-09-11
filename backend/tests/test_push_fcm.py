"""App 端 FCM 推送通道，以及它必须一动不动地保住的 Web Push 现有行为。

真实用户此刻正用 PWA 收 Web Push。安卓 App（Capacitor WebView）里没有 Web Push，
桥接层把自己伪装成一条订阅上报：endpoint 形如 `fcm://<token>`、keys 是占位串
`p256dh="fcm"` / `auth="fcm"`，走的还是同两个订阅接口。所以这个文件分两半：

  · 前半是**回归钉子**：https 订阅的校验、_webpush_one 的调用形状、410/404 清理
    语义，在加 FCM 之前先原样钉住。新分支只要碰到这些，用例立刻红。
  · 后半才是新行为：fcm:// 的受理、未配置时的静默跳过、配置后的 v1 发送。

没有任何用例访问网络：webpush 被替换成记录器，FCM 侧用假凭证 + 假 httpx.Client。

The FCM delivery path for the Android app, plus the existing Web Push behaviour
it must leave byte-for-byte intact. Real users are on the PWA today; the app's
bridge presents itself as a subscription whose endpoint is `fcm://<token>` with
placeholder keys, through the same two endpoints. Hence two halves: regression
pins written first (https validation, _webpush_one's call shape, 410/404 prune
semantics), then the new behaviour. No test touches the network.
"""
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pywebpush import WebPushException

from app.models import PushSubscription, User
from app.routers.notifications import PushSubscribeIn, push_subscribe, push_status
from app.services import push_dispatch

# 浏览器真实签发的密钥形状（p256dh 87 字符、auth 22 字符的 base64url），
# 用来确保「合法 https 订阅」这条路径测的是真实输入而不是占位串。
# The shape a browser actually issues, so the happy path is pinned on real input.
REAL_P256DH = "B" + "A" * 86
REAL_AUTH = "C" * 22
ALLOWED_ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc123"


def _mk_user(db, email="push@example.com", plan="PRO"):
    user = User(email=email, password_hash="x", api_token=f"tok-{email}", plan=plan)
    db.add(user)
    db.commit()
    return user


def _subscribe(db, user, endpoint, p256dh=REAL_P256DH, auth=REAL_AUTH):
    body = PushSubscribeIn(endpoint=endpoint, keys={"p256dh": p256dh, "auth": auth})
    return push_subscribe(body, db=db, current_user=user)


def _mk_sub(endpoint, p256dh=REAL_P256DH, auth=REAL_AUTH, sub_id="sub-1"):
    """派发层只读 endpoint / keys / id，用轻量替身即可。
    Dispatch only reads endpoint/keys/id, so a stand-in suffices."""
    return SimpleNamespace(id=sub_id, endpoint=endpoint, keys_p256dh=p256dh, keys_auth=auth)


class _WebpushRecorder:
    """替换 pywebpush.webpush：记录每次调用，可按 endpoint 抛 WebPushException。
    Stands in for pywebpush.webpush: records calls, can raise per endpoint."""

    def __init__(self, fail_status_by_endpoint=None):
        self.calls = []
        self._fail = fail_status_by_endpoint or {}

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        endpoint = kwargs["subscription_info"]["endpoint"]
        status = self._fail.get(endpoint)
        if status is not None:
            raise WebPushException("boom", response=SimpleNamespace(status_code=status))


# ---------------------------------------------------------------------------
# 回归钉子：Web Push 订阅受理 / regression pins — Web Push subscribe
# ---------------------------------------------------------------------------


def test_https_subscribe_with_real_keys_still_ok(db_session):
    """浏览器订阅照常入库——这是今天线上唯一在跑的路径。
    A browser subscription still stores; today's only live path."""
    user = _mk_user(db_session)
    assert _subscribe(db_session, user, ALLOWED_ENDPOINT) == {"ok": True}

    row = db_session.query(PushSubscription).filter(PushSubscription.user_id == user.id).one()
    assert row.endpoint == ALLOWED_ENDPOINT
    assert (row.keys_p256dh, row.keys_auth) == (REAL_P256DH, REAL_AUTH)


def test_https_subscribe_is_idempotent_per_endpoint(db_session):
    """同一 endpoint 重复上报是更新而不是插新行（唯一约束就在这个组合上）。
    Re-reporting the same endpoint updates in place (the unique constraint)."""
    user = _mk_user(db_session)
    _subscribe(db_session, user, ALLOWED_ENDPOINT)
    _subscribe(db_session, user, ALLOWED_ENDPOINT, p256dh="B" + "D" * 86)

    rows = db_session.query(PushSubscription).filter(PushSubscription.user_id == user.id).all()
    assert len(rows) == 1 and rows[0].keys_p256dh == "B" + "D" * 86


@pytest.mark.parametrize("keys", [
    {"p256dh": "", "auth": REAL_AUTH},
    {"p256dh": REAL_P256DH, "auth": ""},
    {},
])
def test_missing_keys_still_400_with_the_same_message(db_session, keys):
    user = _mk_user(db_session)
    body = PushSubscribeIn(endpoint=ALLOWED_ENDPOINT, keys=keys)
    with pytest.raises(HTTPException) as exc:
        push_subscribe(body, db=db_session, current_user=user)
    assert exc.value.status_code == 400
    assert exc.value.detail == "缺少 p256dh 或 auth 密钥 / missing p256dh or auth key"


def test_oversized_keys_still_400_with_the_same_message(db_session):
    user = _mk_user(db_session)
    body = PushSubscribeIn(endpoint=ALLOWED_ENDPOINT, keys={"p256dh": "A" * 257, "auth": REAL_AUTH})
    with pytest.raises(HTTPException) as exc:
        push_subscribe(body, db=db_session, current_user=user)
    assert exc.value.status_code == 400
    assert exc.value.detail == "p256dh 或 auth 密钥格式无效 / invalid p256dh or auth key"


@pytest.mark.parametrize("endpoint", [
    "https://attacker.example/push/abc",
    "https://fcm.googleapis.com.attacker.example/x",
    "http://fcm.googleapis.com/fcm/send/abc",
    "http://169.254.169.254/latest/meta-data/",
])
def test_non_allowlisted_https_host_still_400_with_the_same_message(db_session, endpoint):
    user = _mk_user(db_session)
    with pytest.raises(HTTPException) as exc:
        _subscribe(db_session, user, endpoint)
    assert exc.value.status_code == 400
    assert exc.value.detail == (
        "订阅地址不是已知的推送服务 / subscription endpoint is not a known push service"
    )


def test_free_plan_still_403(db_session):
    user = _mk_user(db_session, email="free@example.com", plan="FREE")
    with pytest.raises(HTTPException) as exc:
        _subscribe(db_session, user, ALLOWED_ENDPOINT)
    assert exc.value.status_code == 403


# ---------------------------------------------------------------------------
# 回归钉子：_webpush_one 的调用形状与清理语义 / pins — _webpush_one call & prune
# ---------------------------------------------------------------------------


def test_webpush_one_call_shape_is_unchanged(monkeypatch):
    """pywebpush 收到的四个参数逐字钉住。vapid_claims 必须是按订阅复制的副本
    ——pywebpush 会原地写 aud，共用字典会让第二家推送服务全部 403（见
    _webpush_one 的注释）。
    Pin all four arguments verbatim. vapid_claims must be a per-subscription
    copy: pywebpush writes aud in place, and a shared dict 403s every
    subscription on a second push service."""
    rec = _WebpushRecorder()
    monkeypatch.setattr(push_dispatch, "webpush", rec)

    sub = _mk_sub(ALLOWED_ENDPOINT)
    payload = json.dumps({"title": "t", "body": "b"})
    claims = {"sub": "mailto:admin@example.com"}
    headers = {"Urgency": "high", "TTL": "600"}

    assert push_dispatch._webpush_one(sub, payload, "the-pem", claims, headers) == (True, False)

    assert len(rec.calls) == 1
    call = rec.calls[0]
    assert call["subscription_info"] == {
        "endpoint": ALLOWED_ENDPOINT,
        "keys": {"p256dh": REAL_P256DH, "auth": REAL_AUTH},
    }
    assert call["data"] == payload
    assert call["vapid_private_key"] == "the-pem"
    assert call["vapid_claims"] == claims
    assert call["vapid_claims"] is not claims, "必须是副本，否则 aud 被写死 / must be a copy"
    assert call["headers"] == headers


@pytest.mark.parametrize("status,expect_prune", [(410, True), (404, True), (403, False), (500, False)])
def test_webpush_prune_semantics_are_unchanged(monkeypatch, status, expect_prune):
    rec = _WebpushRecorder(fail_status_by_endpoint={ALLOWED_ENDPOINT: status})
    monkeypatch.setattr(push_dispatch, "webpush", rec)

    ok, stale = push_dispatch._webpush_one(
        _mk_sub(ALLOWED_ENDPOINT), "{}", "pem", {"sub": "mailto:a@b.c"}, {}
    )
    assert (ok, stale) == (False, expect_prune)


def test_non_allowlisted_row_in_the_table_is_still_pruned_without_a_request(monkeypatch):
    """库里的存量脏行仍然一次请求都不发、并被标记清理。
    A stale row already in the table is still pruned without any request."""
    rec = _WebpushRecorder()
    monkeypatch.setattr(push_dispatch, "webpush", rec)

    ok, stale = push_dispatch._webpush_one(
        _mk_sub("https://attacker.example/x"), "{}", "pem", {"sub": "mailto:a@b.c"}, {}
    )
    assert (ok, stale) == (False, True)
    assert rec.calls == [], "非白名单 endpoint 绝不能真的发出去 / must never be requested"


def test_allowlist_predicate_still_rejects_everything_but_https_push_services():
    """白名单函数本身的语义不变：它回答的是「这个 URL 能不能被服务端请求」。
    fcm:// 不在它的管辖范围内——那不是 URL，也永远不会被请求。
    The allowlist predicate keeps its meaning: may the server request this URL.
    fcm:// is out of its scope — not a URL, and never fetched."""
    assert push_dispatch.is_allowed_push_endpoint(ALLOWED_ENDPOINT)
    assert not push_dispatch.is_allowed_push_endpoint("http://fcm.googleapis.com/fcm/send/x")
    assert not push_dispatch.is_allowed_push_endpoint("https://attacker.example/x")
    assert not push_dispatch.is_allowed_push_endpoint(FCM_ENDPOINT)


# ---------------------------------------------------------------------------
# 新行为：fcm:// 订阅的受理 / new behaviour — accepting fcm:// subscriptions
# ---------------------------------------------------------------------------

FCM_TOKEN = "cZx9" + "A" * 60 + ":APA91bH" + "_" * 20 + "-xyz"
FCM_ENDPOINT = push_dispatch.FCM_SCHEME + FCM_TOKEN
PLACEHOLDER = push_dispatch.FCM_PLACEHOLDER_KEY


def test_fcm_endpoint_predicate_shape():
    """令牌形状判定是自己算出来的，不是把输入原样回声。
    The shape decision is computed, not echoed back."""
    assert push_dispatch.is_fcm_endpoint(FCM_ENDPOINT)
    assert push_dispatch.fcm_token(FCM_ENDPOINT) == FCM_TOKEN
    # 太短、含 "/"（路径/URL 形状）、空、别的协议：一律不是
    assert not push_dispatch.is_fcm_endpoint("fcm://short")
    assert not push_dispatch.is_fcm_endpoint("fcm://" + "A" * 30 + "/" + "B" * 30)
    assert not push_dispatch.is_fcm_endpoint("fcm://")
    assert not push_dispatch.is_fcm_endpoint("fcm://" + "A" * 30 + " " + "B" * 30)
    assert not push_dispatch.is_fcm_endpoint(ALLOWED_ENDPOINT)
    assert not push_dispatch.is_fcm_endpoint("FCM://" + FCM_TOKEN)


def test_app_subscription_with_placeholder_keys_is_stored(db_session):
    user = _mk_user(db_session, email="app@example.com")
    assert _subscribe(db_session, user, FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER) == {"ok": True}

    row = db_session.query(PushSubscription).filter(PushSubscription.user_id == user.id).one()
    assert row.endpoint == FCM_ENDPOINT
    assert (row.keys_p256dh, row.keys_auth) == (PLACEHOLDER, PLACEHOLDER)


def test_app_subscription_unsubscribes_like_any_other(db_session):
    """退订走的还是同一个按 endpoint 精确删除的接口，App 不需要任何特殊处理。
    Unsubscribe is the same exact-match delete; the app needs no special case."""
    from app.routers.notifications import push_unsubscribe

    user = _mk_user(db_session, email="app-off@example.com")
    _subscribe(db_session, user, FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER)
    push_unsubscribe(
        PushSubscribeIn(endpoint=FCM_ENDPOINT, keys={"p256dh": PLACEHOLDER, "auth": PLACEHOLDER}),
        db=db_session, current_user=user,
    )
    assert db_session.query(PushSubscription).filter(PushSubscription.user_id == user.id).count() == 0


@pytest.mark.parametrize("p256dh,auth", [
    (REAL_P256DH, REAL_AUTH),       # 真实形状的密钥配 fcm://：不是桥接发的
    (PLACEHOLDER, REAL_AUTH),
    (REAL_P256DH, PLACEHOLDER),
    ("FCM", "FCM"),                 # 大小写也必须严格一致
])
def test_fcm_endpoint_with_non_placeholder_keys_is_400(db_session, p256dh, auth):
    user = _mk_user(db_session, email=f"bad-keys-{p256dh[:4]}-{auth[:4]}@example.com")
    with pytest.raises(HTTPException) as exc:
        _subscribe(db_session, user, FCM_ENDPOINT, p256dh, auth)
    assert exc.value.status_code == 400
    assert exc.value.detail == "p256dh 或 auth 密钥格式无效 / invalid p256dh or auth key"


@pytest.mark.parametrize("endpoint", [
    "fcm://short",
    "fcm://" + "A" * 30 + "/" + "B" * 30,
    "fcm://../../etc/passwd",
    "fcm://",
])
def test_malformed_fcm_token_is_400(db_session, endpoint):
    """令牌形状不对就不是一条 App 订阅，一律拒绝——包括空令牌和带路径的。
    A malformed token is not an app subscription: empty and path-shaped included."""
    user = _mk_user(db_session, email=f"bad-token-{len(endpoint)}@example.com")
    with pytest.raises(HTTPException) as exc:
        _subscribe(db_session, user, endpoint, PLACEHOLDER, PLACEHOLDER)
    assert exc.value.status_code == 400
    assert db_session.query(PushSubscription).count() == 0


def test_https_endpoint_with_placeholder_keys_is_400(db_session):
    """占位密钥只在 fcm:// 上有意义；浏览器永远不会签出 "fcm" 这种 p256dh。
    The placeholders mean something only on fcm://; no browser issues "fcm"."""
    user = _mk_user(db_session, email="fake-placeholder@example.com")
    with pytest.raises(HTTPException) as exc:
        _subscribe(db_session, user, ALLOWED_ENDPOINT, PLACEHOLDER, PLACEHOLDER)
    assert exc.value.status_code == 400
    assert exc.value.detail == "p256dh 或 auth 密钥格式无效 / invalid p256dh or auth key"


def test_free_plan_cannot_register_an_app_subscription(db_session):
    """等级闸门在 App 路径上同样生效 / the plan gate applies to the app path too."""
    user = _mk_user(db_session, email="free-app@example.com", plan="FREE")
    with pytest.raises(HTTPException) as exc:
        _subscribe(db_session, user, FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER)
    assert exc.value.status_code == 403


def test_push_status_names_the_channel_without_leaking_the_token(db_session):
    user = _mk_user(db_session, email="status@example.com")
    _subscribe(db_session, user, FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER)

    app_status = push_status(endpoint=FCM_ENDPOINT, db=db_session, current_user=user)
    assert app_status["count"] == 1
    assert app_status["current_endpoint_registered"] is True
    assert app_status["kind"] == "app"
    assert FCM_TOKEN not in json.dumps(app_status), "响应里不能出现完整令牌 / no full token in responses"

    web_status = push_status(endpoint=ALLOWED_ENDPOINT, db=db_session, current_user=user)
    assert web_status["kind"] == "web" and web_status["current_endpoint_registered"] is False


# ---------------------------------------------------------------------------
# 新行为：派发分流 / new behaviour — dispatch routing
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _reset_fcm_process_state(monkeypatch):
    """FCM 的凭证缓存与"每类只警告一次"都是进程级状态，用例之间必须清干净。
    The credentials cache and the warn-once keys are process state."""
    monkeypatch.setattr(push_dispatch, "_fcm_ctx", None, raising=False)
    monkeypatch.setattr(push_dispatch, "_fcm_warned", set(), raising=False)
    yield
    push_dispatch._fcm_ctx = None
    push_dispatch._fcm_warned = set()


class _FakeResponse:
    def __init__(self, status_code, body=None):
        self.status_code = status_code
        self._body = body if body is not None else {}

    def json(self):
        return self._body


class _FakeHttpClient:
    """假的 httpx.Client：记录 POST，绝不出网。
    A stand-in httpx.Client that records POSTs and never reaches the network."""

    def __init__(self, responses=None):
        self.posts = []
        self._responses = list(responses or [])

    def post(self, url, json=None, headers=None):
        self.posts.append({"url": url, "json": json, "headers": headers})
        if self._responses:
            return self._responses.pop(0)
        return _FakeResponse(200, {"name": "projects/p/messages/1"})


def _configure_fcm(monkeypatch, client, project_id="prismx-app", token="ya29.fake-access-token"):
    """把 (凭证, httpx client, project_id) 直接塞进缓存，绕开真实的服务账号读取。
    Seed the cached context directly, bypassing real service-account loading."""
    creds = SimpleNamespace(valid=True, token=token, project_id=project_id)
    monkeypatch.setattr(push_dispatch, "_fcm_ctx", (creds, client, project_id), raising=False)
    return creds


def test_unconfigured_fcm_skips_the_app_row_and_prunes_nothing(monkeypatch, caplog):
    """没配 FCM 时：网页订阅照发，App 行跳过、不清理，警告只打一次。
    Unconfigured: web rows still go out, app rows are skipped, nothing is
    pruned, and the warning is logged once."""
    monkeypatch.setattr(push_dispatch.settings, "FCM_SERVICE_ACCOUNT_FILE", None, raising=False)
    rec = _WebpushRecorder()
    monkeypatch.setattr(push_dispatch, "webpush", rec)

    web = _mk_sub(ALLOWED_ENDPOINT, sub_id="web-1")
    app = _mk_sub(FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER, sub_id="app-1")
    payload = json.dumps({"title": "新信号 XAUUSD", "body": "BUY · AIFT"})
    claims = {"sub": "mailto:admin@example.com"}
    headers = {"Urgency": "high", "TTL": "600"}

    with caplog.at_level("WARNING", logger="push"):
        web_result = push_dispatch._send_one(web, payload, "pem", claims, headers)
        app_result_1 = push_dispatch._send_one(app, payload, "pem", claims, headers)
        app_result_2 = push_dispatch._send_one(app, payload, "pem", claims, headers)

    assert web_result == (True, False)
    assert app_result_1 == (False, False) and app_result_2 == (False, False), "不配置也绝不清理 / never prune"
    assert len(rec.calls) == 1, "App 行不能落到 webpush 上 / the app row must not reach webpush"
    assert rec.calls[0]["subscription_info"]["endpoint"] == ALLOWED_ENDPOINT
    unconfigured = [r for r in caplog.records if "FCM 未配置" in r.getMessage()]
    assert len(unconfigured) == 1, "每进程只警告一次 / warn once per process"


def test_configured_fcm_posts_a_v1_message(monkeypatch):
    client = _FakeHttpClient()
    _configure_fcm(monkeypatch, client)

    payload = json.dumps(
        {"title": "新信号 XAUUSD", "body": "BUY · AIFT", "icon": "/icons/icon-192.png",
         "data": {"url": "/signals"}},
        ensure_ascii=False,
    )
    sub = _mk_sub(FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER, sub_id="app-1")

    assert push_dispatch._fcm_one(sub, payload) == (True, False)

    assert len(client.posts) == 1
    post = client.posts[0]
    assert post["url"] == "https://fcm.googleapis.com/v1/projects/prismx-app/messages:send"
    assert post["headers"]["Authorization"] == "Bearer ya29.fake-access-token"
    msg = post["json"]["message"]
    assert msg["token"] == FCM_TOKEN, "令牌是 fcm:// 之后的部分 / token is what follows fcm://"
    assert msg["notification"] == {"title": "新信号 XAUUSD", "body": "BUY · AIFT"}
    assert msg["data"] == {"payload": payload}, "原始 payload 整串带过去 / raw payload rides along"
    assert json.loads(msg["data"]["payload"])["icon"] == "/icons/icon-192.png"
    assert msg["android"]["priority"] == "high"


def test_fcm_message_carries_no_web_push_key_material(monkeypatch):
    """占位密钥不该出现在发往 FCM 的消息体里——它们在这条路径上毫无意义。
    The placeholder keys must not appear in the FCM message; they mean nothing here."""
    client = _FakeHttpClient()
    _configure_fcm(monkeypatch, client)
    push_dispatch._fcm_one(_mk_sub(FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER), json.dumps({"title": "t", "body": "b"}))
    body = json.dumps(client.posts[0]["json"])
    assert "p256dh" not in body and "keys" not in body


@pytest.mark.parametrize("status,err,expect_prune", [
    # 只有错误体明确指认令牌才清理 / only a token-specific error prunes
    (404, {"error": {"details": [{"errorCode": "UNREGISTERED"}]}}, True),
    (400, {"error": {"status": "INVALID_ARGUMENT",
                     "message": "The registration token is not a valid FCM registration token"}}, True),
    # 光秃秃的 404 不清理：这个 URL 里除了令牌还有项目路径，FCM_PROJECT_ID 配错
    # 或服务账号没权限时每条订阅都会 404。/ a bare 404 can come from the project
    # path (wrong FCM_PROJECT_ID, service account without access), not the token.
    (404, {}, False),
    (404, {"error": {"status": "NOT_FOUND", "message": "Requested entity was not found."}}, False),
    (404, {"error": {"status": "PERMISSION_DENIED"}}, False),
    # 我们自己把消息体发错了也会 400 INVALID_ARGUMENT——那是服务端 bug，
    # 不能因此把用户的设备踢掉。/ our own malformed body 400s too; don't prune.
    (400, {"error": {"status": "INVALID_ARGUMENT", "message": "Invalid JSON payload received."}}, False),
    (401, {"error": {"status": "UNAUTHENTICATED"}}, False),
    (500, {"error": {"status": "INTERNAL"}}, False),
    (503, {}, False),
    # 外部服务给回的 JSON 形状不受我们控制：details 不是列表也不能把判定函数搞崩，
    # 否则异常会一路逃到派发循环外面。/ the external JSON's shape isn't ours to
    # trust; a non-list details must not crash the predicate.
    (404, {"error": {"details": "UNREGISTERED"}}, False),
    (400, {"error": {"details": {"errorCode": "UNREGISTERED"}, "status": "INVALID_ARGUMENT"}}, False),
    (404, {"error": "not-an-object"}, False),
])
def test_fcm_failure_prune_semantics(monkeypatch, status, err, expect_prune):
    client = _FakeHttpClient(responses=[_FakeResponse(status, err)])
    _configure_fcm(monkeypatch, client)

    ok, stale = push_dispatch._fcm_one(
        _mk_sub(FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER), json.dumps({"title": "t", "body": "b"})
    )
    assert (ok, stale) == (False, expect_prune)


def test_fcm_transport_error_never_prunes(monkeypatch):
    """超时/DNS 之类的传输层故障与令牌是否有效无关，绝不能据此清理。
    A transport failure says nothing about the token — never prune on it."""
    class _Boom(_FakeHttpClient):
        def post(self, url, json=None, headers=None):
            raise OSError("connection reset")

    _configure_fcm(monkeypatch, _Boom())
    assert push_dispatch._fcm_one(_mk_sub(FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER), "{}") == (False, False)


def test_project_level_404_warns_about_the_project_and_prunes_nothing(monkeypatch, caplog):
    """FCM_PROJECT_ID 打错一个字符会让**每条**订阅都收 404。按 404 就删的话，配错
    之后第一次派发就把全部 App 订阅清空，而那些设备完全正常。
    A one-character typo in FCM_PROJECT_ID 404s every row; pruning on that would
    wipe every app subscription on the first dispatch, all of them healthy."""
    client = _FakeHttpClient(responses=[
        _FakeResponse(404, {"error": {"status": "NOT_FOUND", "message": "Requested entity was not found."}}),
        _FakeResponse(404, {"error": {"status": "NOT_FOUND", "message": "Requested entity was not found."}}),
    ])
    _configure_fcm(monkeypatch, client, project_id="typo-project")

    with caplog.at_level("WARNING", logger="push"):
        first = push_dispatch._fcm_one(_mk_sub(FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER, sub_id="a"), "{}")
        second = push_dispatch._fcm_one(_mk_sub(FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER, sub_id="b"), "{}")

    assert first == (False, False) and second == (False, False)
    hints = [r.getMessage() for r in caplog.records if "FCM_PROJECT_ID" in r.getMessage()]
    assert len(hints) == 1, "项目级提示按类去重，不刷屏 / the project hint is deduped"
    assert "typo-project" in hints[0]


def test_fcm_one_never_raises(monkeypatch):
    """硬契约：无论底下出什么事，_fcm_one 都只返回 (False, False)。
    异常逃出去的代价不是"这条失败"，而是整批中断 + 清理记账作废。
    Hard contract: whatever happens underneath, _fcm_one returns (False, False).
    An escaping exception aborts the whole batch and voids its pruning."""
    class _Exploding:
        def post(self, *a, **kw):
            raise RuntimeError("boom")

        def __getattr__(self, name):
            raise RuntimeError("boom")

    _configure_fcm(monkeypatch, _Exploding())
    assert push_dispatch._fcm_one(_mk_sub(FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER), "{}") == (False, False)

    # 连响应对象都坏掉（status_code 取不到）也一样
    class _BadResponseClient(_FakeHttpClient):
        def post(self, url, json=None, headers=None):
            return object()

    push_dispatch._fcm_ctx = None
    _configure_fcm(monkeypatch, _BadResponseClient())
    assert push_dispatch._fcm_one(_mk_sub(FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER), "{}") == (False, False)


def test_an_exploding_http_client_constructor_does_not_take_the_batch_down(monkeypatch, tmp_path):
    """httpx.Client() 的构造会读环境里的代理与 CA 设置，畸形的 HTTPS_PROXY 或坏的
    SSL_CERT_FILE 会让它当场抛。这个异常必须止步于 _fcm_one——否则同一批里还没轮到
    的**浏览器订阅**一条都发不出去，清理记账也跟着作废，而且每次派发都重演。
    httpx.Client() reads proxy and CA settings from the environment and a
    malformed HTTPS_PROXY or bad SSL_CERT_FILE makes it raise. That must stop at
    _fcm_one, or the browser rows behind it in the same batch go unsent."""
    import httpx
    from google.oauth2 import service_account

    sa_file = tmp_path / "sa.json"
    sa_file.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(
        service_account.Credentials, "from_service_account_file",
        staticmethod(lambda path, scopes=None: SimpleNamespace(valid=True, token="t", project_id="p")),
    )

    def _exploding_client(*args, **kwargs):
        raise ValueError("Unknown scheme for proxy URL")

    monkeypatch.setattr(httpx, "Client", _exploding_client)
    monkeypatch.setattr(push_dispatch.settings, "FCM_SERVICE_ACCOUNT_FILE", str(sa_file), raising=False)
    monkeypatch.setattr(push_dispatch.settings, "FCM_PROJECT_ID", "p", raising=False)

    assert push_dispatch._fcm_one(_mk_sub(FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER), "{}") == (False, False)


def test_a_broken_fcm_config_leaves_the_browser_rows_untouched(monkeypatch, db_session, tmp_path):
    """同一批里 FCM 侧彻底坏掉时，https 行照常经 webpush 发出、清理记账照常。
    With the FCM side broken, the https row in the same batch still goes through
    webpush and the pruning bookkeeping still lands."""
    import httpx
    from google.oauth2 import service_account

    user = _mk_user(db_session, email="broken-fcm@example.com")
    # App 行故意排在前面：异常若逃出去，后面的浏览器行就永远轮不到——这正是要钉住
    # 的那个爆炸半径。/ The app row goes first on purpose: an escaping exception
    # would mean the browser row behind it is never reached, which is the blast
    # radius being pinned.
    _subscribe(db_session, user, FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER)
    _subscribe(db_session, user, ALLOWED_ENDPOINT)

    sa_file = tmp_path / "sa.json"
    sa_file.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(
        service_account.Credentials, "from_service_account_file",
        staticmethod(lambda path, scopes=None: SimpleNamespace(valid=True, token="t", project_id="p")),
    )
    monkeypatch.setattr(httpx, "Client", lambda *a, **k: (_ for _ in ()).throw(ValueError("bad proxy")))
    monkeypatch.setattr(push_dispatch.settings, "FCM_SERVICE_ACCOUNT_FILE", str(sa_file), raising=False)

    rec = _WebpushRecorder()
    monkeypatch.setattr(push_dispatch, "webpush", rec)

    result = _drive_test_push(monkeypatch, db_session, user.id)

    assert result == {"sent": 1, "failed": 1, "pruned": 0}
    assert [c["subscription_info"]["endpoint"] for c in rec.calls] == [ALLOWED_ENDPOINT]
    assert db_session.query(PushSubscription).count() == 2, "一条都不该被删 / nothing pruned"


def test_a_config_warning_does_not_silence_a_later_credential_failure(monkeypatch, caplog):
    """警告按类去重，不是一个全局开关：密钥被吊销（取令牌失败）是后来才出现的
    新问题，不能被早先那条配置警告顺手静音，否则 App 推送全停却毫无日志。
    Warnings dedupe per kind, not globally: a revoked key surfacing later must
    not be muted by an earlier config warning, or app push dies silently."""
    creds = _configure_fcm(monkeypatch, _FakeHttpClient())
    creds.valid = False

    def _boom(request):
        raise RuntimeError("invalid_grant: account not found")

    creds.refresh = _boom
    monkeypatch.setattr(
        "google.auth.transport.requests.Request", lambda *a, **k: SimpleNamespace()
    )
    # 先让一条别的类别的警告响过 / let a different kind fire first
    push_dispatch._warn_fcm_once("unconfigured", "[push] FCM 未配置 …")

    with caplog.at_level("WARNING", logger="push"):
        assert push_dispatch._fcm_one(_mk_sub(FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER), "{}") == (False, False)

    assert any("取令牌失败" in r.getMessage() for r in caplog.records), "新问题必须有自己的一行 / must still be logged"


def test_a_failed_context_is_cached_not_retried_per_row(monkeypatch, tmp_path):
    """配置坏了就是坏了，重试不会变好。派发是逐订阅调用的，不缓存失败的话一条
    坏路径会被每条 App 订阅各读一次盘。
    A broken configuration doesn't heal on retry, and this runs per subscription:
    without caching the failure, one bad path costs a disk read per app row."""
    from google.oauth2 import service_account

    attempts = []

    def _counting(path, scopes=None):
        attempts.append(path)
        raise FileNotFoundError(path)

    monkeypatch.setattr(service_account.Credentials, "from_service_account_file", staticmethod(_counting))
    monkeypatch.setattr(
        push_dispatch.settings, "FCM_SERVICE_ACCOUNT_FILE", str(tmp_path / "missing.json"), raising=False
    )

    for _ in range(5):
        assert push_dispatch._fcm_one(_mk_sub(FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER), "{}") == (False, False)

    assert len(attempts) == 1, "每进程只尝试一次 / one attempt per process"


def test_fcm_logs_only_a_token_prefix(monkeypatch, caplog):
    client = _FakeHttpClient(responses=[_FakeResponse(500, {"error": {"status": "INTERNAL"}})])
    _configure_fcm(monkeypatch, client)

    with caplog.at_level("WARNING", logger="push"):
        push_dispatch._fcm_one(_mk_sub(FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER), "{}")

    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert FCM_TOKEN not in logged, "日志里绝不能出现完整令牌 / no full token in logs"
    assert FCM_TOKEN[:8] in logged, "但要留下可对账的前缀 / a prefix stays, for correlation"


def test_expired_credentials_are_refreshed_not_reloaded(monkeypatch):
    """令牌过期时就地 refresh（google-auth 自己管），不重新读服务账号文件。
    An expired token is refreshed in place, not reloaded from disk."""
    client = _FakeHttpClient()
    creds = _configure_fcm(monkeypatch, client)
    creds.valid = False
    refreshed = []

    def _refresh(request):
        refreshed.append(request)
        creds.valid = True
        creds.token = "ya29.refreshed"

    creds.refresh = _refresh
    monkeypatch.setattr(
        "google.auth.transport.requests.Request", lambda *a, **k: SimpleNamespace(name="fake-request")
    )

    assert push_dispatch._fcm_one(_mk_sub(FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER), "{}") == (True, False)
    assert len(refreshed) == 1
    assert client.posts[0]["headers"]["Authorization"] == "Bearer ya29.refreshed"


def test_service_account_is_loaded_with_the_messaging_scope_and_project_fallback(monkeypatch, tmp_path):
    """凭证按 firebase.messaging 作用域加载；FCM_PROJECT_ID 留空时用服务账号
    JSON 里的 project_id（运维只需要配一个路径）。
    Credentials load with the firebase.messaging scope, and an unset
    FCM_PROJECT_ID falls back to the service account's own project_id — the
    operator only has to configure a path."""
    from google.oauth2 import service_account

    sa_file = tmp_path / "sa.json"
    sa_file.write_text(json.dumps({"type": "service_account", "project_id": "from-json"}), encoding="utf-8")
    seen = {}

    def _fake_from_file(path, scopes=None):
        seen["path"], seen["scopes"] = path, scopes
        return SimpleNamespace(valid=True, token="ya29.x", project_id="from-json")

    monkeypatch.setattr(service_account.Credentials, "from_service_account_file", staticmethod(_fake_from_file))
    monkeypatch.setattr(push_dispatch.settings, "FCM_SERVICE_ACCOUNT_FILE", str(sa_file), raising=False)
    monkeypatch.setattr(push_dispatch.settings, "FCM_PROJECT_ID", None, raising=False)

    ctx = push_dispatch._fcm_context()
    assert ctx is not None
    assert seen["path"] == str(sa_file)
    assert seen["scopes"] == ["https://www.googleapis.com/auth/firebase.messaging"]
    assert ctx[2] == "from-json"

    # 显式配置优先 / an explicit setting wins
    push_dispatch._fcm_ctx = None
    monkeypatch.setattr(push_dispatch.settings, "FCM_PROJECT_ID", "explicit-project", raising=False)
    assert push_dispatch._fcm_context()[2] == "explicit-project"


def test_unreadable_service_account_degrades_to_skipping(monkeypatch, tmp_path):
    """服务账号路径配错了也只是跳过 App 行：不抛异常、不清理、不影响网页推送。
    A bad service-account path only skips app rows: no exception, no pruning,
    and the browser path is untouched."""
    monkeypatch.setattr(
        push_dispatch.settings, "FCM_SERVICE_ACCOUNT_FILE", str(tmp_path / "missing.json"), raising=False
    )
    assert push_dispatch._fcm_context() is None
    assert push_dispatch._fcm_one(_mk_sub(FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER), "{}") == (False, False)


# ---------------------------------------------------------------------------
# 新行为：整批派发里两条通道并存 / new behaviour — both channels in one batch
# ---------------------------------------------------------------------------


def _drive_test_push(monkeypatch, db_session, user_id):
    """用 dispatch_test_push 驱动一整轮真实的派发循环（含清理记账）。
    Drive a full real dispatch loop (pruning bookkeeping included)."""
    monkeypatch.setattr(db_session, "close", lambda: None)
    monkeypatch.setattr(push_dispatch, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(
        type(push_dispatch.settings), "vapid_private_key", property(lambda self: "the-pem")
    )
    monkeypatch.setattr(push_dispatch.settings, "VAPID_PUBLIC_KEY", "the-public-key", raising=False)
    return push_dispatch.dispatch_test_push(user_id)


def test_send_one_forwards_the_webpush_arguments_verbatim(monkeypatch):
    """分流器在 https 那一支上必须是纯转发：pem / vapid_claims / headers 一字不改
    地交给 _webpush_one。它是所有派发循环的必经之路，这里漏掉一个参数等于全站
    Web Push 出错。
    On the https branch the chooser must be a pure forward: pem, vapid_claims
    and headers reach _webpush_one untouched. Every dispatch loop goes through
    it, so dropping one argument here breaks Web Push everywhere."""
    rec = _WebpushRecorder()
    monkeypatch.setattr(push_dispatch, "webpush", rec)

    payload = json.dumps({"title": "t", "body": "b"})
    claims = {"sub": "mailto:admin@example.com"}
    headers = {"Urgency": "normal", "TTL": "86400"}

    assert push_dispatch._send_one(_mk_sub(ALLOWED_ENDPOINT), payload, "the-pem", claims, headers) == (True, False)

    call = rec.calls[0]
    assert call["subscription_info"] == {
        "endpoint": ALLOWED_ENDPOINT,
        "keys": {"p256dh": REAL_P256DH, "auth": REAL_AUTH},
    }
    assert call["data"] == payload
    assert call["vapid_private_key"] == "the-pem"
    assert call["vapid_claims"] == claims and call["vapid_claims"] is not claims
    assert call["headers"] == headers


def test_mixed_batch_routes_each_row_to_its_own_channel(monkeypatch, db_session):
    """同一批里 https 行仍旧走 webpush、fcm 行走 FCM，互不影响。
    In one batch the https row still goes through webpush and the fcm row
    through FCM, neither disturbing the other."""
    user = _mk_user(db_session, email="mixed@example.com")
    _subscribe(db_session, user, ALLOWED_ENDPOINT)
    _subscribe(db_session, user, FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER)

    rec = _WebpushRecorder()
    monkeypatch.setattr(push_dispatch, "webpush", rec)
    client = _FakeHttpClient()
    _configure_fcm(monkeypatch, client)

    result = _drive_test_push(monkeypatch, db_session, user.id)

    assert result == {"sent": 2, "failed": 0, "pruned": 0}
    assert [c["subscription_info"]["endpoint"] for c in rec.calls] == [ALLOWED_ENDPOINT]
    assert len(client.posts) == 1 and client.posts[0]["json"]["message"]["token"] == FCM_TOKEN
    # 两条通道拿到的是同一份 payload / both channels carry the same payload
    assert client.posts[0]["json"]["message"]["data"]["payload"] == rec.calls[0]["data"]
    assert db_session.query(PushSubscription).count() == 2


def test_dead_app_token_is_pruned_while_the_browser_row_survives(monkeypatch, db_session):
    user = _mk_user(db_session, email="prune@example.com")
    _subscribe(db_session, user, ALLOWED_ENDPOINT)
    _subscribe(db_session, user, FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER)

    monkeypatch.setattr(push_dispatch, "webpush", _WebpushRecorder())
    client = _FakeHttpClient(responses=[_FakeResponse(404, {"error": {"details": [{"errorCode": "UNREGISTERED"}]}})])
    _configure_fcm(monkeypatch, client)

    result = _drive_test_push(monkeypatch, db_session, user.id)

    assert result == {"sent": 1, "failed": 1, "pruned": 1}
    remaining = [r.endpoint for r in db_session.query(PushSubscription).all()]
    assert remaining == [ALLOWED_ENDPOINT]


def test_dead_browser_row_is_pruned_while_the_app_row_survives(monkeypatch, db_session):
    """对称的反向用例：webpush 的 410 清理语义没有被新分支改写。
    The mirror case: webpush's 410 prune semantics survive the new branch."""
    user = _mk_user(db_session, email="prune-web@example.com")
    _subscribe(db_session, user, ALLOWED_ENDPOINT)
    _subscribe(db_session, user, FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER)

    monkeypatch.setattr(
        push_dispatch, "webpush", _WebpushRecorder(fail_status_by_endpoint={ALLOWED_ENDPOINT: 410})
    )
    _configure_fcm(monkeypatch, _FakeHttpClient())

    result = _drive_test_push(monkeypatch, db_session, user.id)

    assert result == {"sent": 1, "failed": 1, "pruned": 1}
    remaining = [r.endpoint for r in db_session.query(PushSubscription).all()]
    assert remaining == [FCM_ENDPOINT]


def test_unconfigured_fcm_keeps_the_app_row_in_a_real_dispatch(monkeypatch, db_session):
    """未配置 FCM 跑完整批：网页那条照发，App 那条不发也不删。
    A full batch with FCM unconfigured: the web row is sent, the app row is
    neither sent nor deleted."""
    monkeypatch.setattr(push_dispatch.settings, "FCM_SERVICE_ACCOUNT_FILE", None, raising=False)
    user = _mk_user(db_session, email="unconfigured@example.com")
    _subscribe(db_session, user, ALLOWED_ENDPOINT)
    _subscribe(db_session, user, FCM_ENDPOINT, PLACEHOLDER, PLACEHOLDER)

    rec = _WebpushRecorder()
    monkeypatch.setattr(push_dispatch, "webpush", rec)

    result = _drive_test_push(monkeypatch, db_session, user.id)

    assert result == {"sent": 1, "failed": 1, "pruned": 0}
    assert len(rec.calls) == 1
    assert db_session.query(PushSubscription).count() == 2
