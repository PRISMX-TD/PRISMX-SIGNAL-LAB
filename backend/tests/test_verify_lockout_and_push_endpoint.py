"""两处对外边界的加固：MT5 验证的失败锁定，与推送订阅 endpoint 的白名单。

两者的共同点是「用户提交的东西会让服务端去外面做一件事」——一个是拿账号密码去
券商侧验证，一个是拿 URL 去发 HTTP 请求。这类端点光有按 IP 的限流不够：

  · 按 IP 限流挡不住轮换出口 IP 打同一个账号，所以要按账号本身计数并锁定；
  · endpoint 完全由客户端给出，不限定目标就等于开放一个服务端代发请求的入口。

Two hardened outward-facing boundaries: the MT5-verification lockout and the
push-subscription endpoint allowlist. Both are endpoints where something the user
submits makes the server act on the outside world — verifying credentials at the
broker, and issuing an HTTP request to a URL. Per-IP limits alone don't cover
either: rotating IPs defeat them, and an unrestricted endpoint is an open
server-side request relay.
"""
import pytest

from app.core import rate_limit
from app.services.push_dispatch import is_allowed_push_endpoint


@pytest.fixture(autouse=True)
def _clean_failure_state():
    """失败计数是模块级进程内状态，用例之间必须清干净。"""
    rate_limit._failures.clear()
    yield
    rate_limit._failures.clear()


# ---------- MT5 验证的失败锁定 ----------


def test_login_locks_out_after_the_threshold():
    login = 500123
    max_attempts, _ = rate_limit._POLICIES["mt5_verify"]

    for _ in range(max_attempts - 1):
        rate_limit.record_failed_mt5_verify(login)
    assert not rate_limit.is_mt5_verify_locked(login), "阈值之前不该锁定"

    rate_limit.record_failed_mt5_verify(login)
    assert rate_limit.is_mt5_verify_locked(login), "达到阈值必须锁定"


def test_lockout_is_scoped_to_one_login():
    """锁定必须只影响被撞的那个账号。

    否则攻击者故意把若干账号撞到锁定，就能顺手把这些账号的真实持有人挡在门外
    ——一个防撞库措施反过来成了拒绝服务的手段。
    """
    max_attempts, _ = rate_limit._POLICIES["mt5_verify"]
    for _ in range(max_attempts):
        rate_limit.record_failed_mt5_verify(500123)

    assert rate_limit.is_mt5_verify_locked(500123)
    assert not rate_limit.is_mt5_verify_locked(500124)


def test_login_and_email_namespaces_do_not_collide():
    """MT5 账号与登录邮箱共用一份存储，但必须互不干扰。"""
    max_attempts, _ = rate_limit._POLICIES["mt5_verify"]
    for _ in range(max_attempts):
        rate_limit.record_failed_mt5_verify("500123")

    assert rate_limit.is_mt5_verify_locked("500123")
    assert not rate_limit.is_login_locked("500123")


def test_success_clears_the_counter():
    """验证成功要把计数清零，否则一个手滑几次的正常用户会被累积到锁定。"""
    login = 500123
    max_attempts, _ = rate_limit._POLICIES["mt5_verify"]

    for _ in range(max_attempts - 1):
        rate_limit.record_failed_mt5_verify(login)
    rate_limit.clear_failed_mt5_verify(login)

    for _ in range(max_attempts - 1):
        rate_limit.record_failed_mt5_verify(login)
    assert not rate_limit.is_mt5_verify_locked(login)


def test_lockout_expires(monkeypatch):
    """锁定是临时的：过了窗口自动解除，不需要人工介入。"""
    login = 500123
    max_attempts, lockout_seconds = rate_limit._POLICIES["mt5_verify"]
    for _ in range(max_attempts):
        rate_limit.record_failed_mt5_verify(login)
    assert rate_limit.is_mt5_verify_locked(login)

    real_time = rate_limit.time.time
    monkeypatch.setattr(
        rate_limit.time, "time", lambda: real_time() + lockout_seconds + 1
    )
    assert not rate_limit.is_mt5_verify_locked(login)


def test_mt5_verify_is_stricter_than_login():
    """这个端点每次调用都是一次真实的券商侧密码校验，必须比站内登录更严。"""
    verify_max, verify_lockout = rate_limit._POLICIES["mt5_verify"]
    login_max, login_lockout = rate_limit._POLICIES["login"]
    assert verify_max < login_max
    assert verify_lockout > login_lockout


# ---------- 推送订阅 endpoint 白名单 ----------


@pytest.mark.parametrize("endpoint", [
    "https://fcm.googleapis.com/fcm/send/abc123",
    "https://updates.push.services.mozilla.com/wpush/v2/abc123",
    "https://web.push.apple.com/abc123",
    "https://xyz.notify.windows.com/w/?token=abc",
])
def test_real_push_services_are_accepted(endpoint):
    """浏览器真实签发的订阅地址不能被误杀，否则推送直接不可用。"""
    assert is_allowed_push_endpoint(endpoint)


@pytest.mark.parametrize("endpoint", [
    # 云元数据服务：SSRF 最典型的目标，能读出实例凭证
    "http://169.254.169.254/latest/meta-data/",
    "https://169.254.169.254/latest/meta-data/",
    # 内网地址与本机服务
    "http://127.0.0.1:8000/admin",
    "http://localhost:6379/",
    "http://10.0.0.5/internal",
    # 明文 http 的推送服务：降级攻击面，且真实订阅一定是 https
    "http://fcm.googleapis.com/fcm/send/abc",
    # 非 HTTP 协议
    "file:///etc/passwd",
    "gopher://127.0.0.1:6379/_INFO",
    # 空与畸形
    "",
    "not-a-url",
])
def test_non_push_targets_are_rejected(endpoint):
    assert not is_allowed_push_endpoint(endpoint)


@pytest.mark.parametrize("endpoint", [
    # 把白名单域名接在自己域名前面 / 后面，是绕过后缀匹配的标准手法
    "https://fcm.googleapis.com.attacker.example/x",
    "https://evilfcm.googleapis.com/x",
    "https://attacker.example/fcm.googleapis.com",
    # 用户名部分伪装成白名单域名，真实主机是 attacker.example
    "https://fcm.googleapis.com@attacker.example/x",
])
def test_lookalike_hosts_are_rejected(endpoint):
    """后缀匹配必须带点边界，且要按解析出的 host 判断而不是字符串包含。"""
    assert not is_allowed_push_endpoint(endpoint)
