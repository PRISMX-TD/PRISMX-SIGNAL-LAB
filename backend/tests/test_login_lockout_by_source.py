"""登录锁定：只锁陌生来源。

改动前是「同一邮箱连错 8 次锁 5 分钟」，谁都能拿它锁别人——知道你邮箱的人从他
自己的网络连错 8 次，你就进不来，循环着做就是永久的。一道本来防撞库的闸门，
自己成了一个只需要知道邮箱就能发起的 DoS。

这里钉住四条，前两条互为反面，缺一条这次改动就白做了：

1. **攻击者锁不动真用户。** 攻击者在自己的 IP 上把某个账号打到锁定，真用户从
   自己常用的 IP 照样登得进去。
2. **撞库仍然挡得住。** 同一个来源对多个账号连续失败，这个来源要被拦下——否则
   就不是「把锁改细」，是把闸门整个拆了。
3. **常用来源名单有上限、有过期**，不会随着用户漫游无限长大。
4. **来源取值只走 request.client.host**（ProxyHeadersMiddleware 还原后的值），
   绝不自己解析 X-Forwarded-For：自己解析等于采信攻击者随手伪造的一行 header。

Pins the two halves that have to hold at once: an attacker can no longer lock a
real user out, and one source spraying many accounts is still stopped.
"""
import time

import pytest

from app.core import rate_limit
from app.core.config import settings
from app.services import shared_state

# 两个来源标识，当作两台不同网络下的机器 / two sources = two different networks
VICTIM_HOME = "victim-home-source"
ATTACKER = "attacker-source"


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch):
    """每条用例前后各清一次共享状态：失败计数与常用来源名单都住在那里，
    不清的话上一条用例攒下的计数会在一条讲别的事情的用例里炸出来。"""
    monkeypatch.setattr(settings, "REDIS_URL", "")
    monkeypatch.setattr(settings, "RATE_LIMIT_STORAGE_URI", "")
    shared_state.reset_for_tests()
    yield
    shared_state.reset_for_tests()


class _Req:
    """Request 的最小替身：来源只从 client.host 取。"""

    def __init__(self, host):
        self.client = type("C", (), {"host": host})()


def _fail(email, source, times):
    for _ in range(times):
        rate_limit.record_failed_login(email, source)


def _login_ok(email, source):
    """模拟一次成功登录：清计数 + 认下来源（与 routers/auth.login 同序）。"""
    rate_limit.clear_failed_logins(email, source)
    rate_limit.remember_login_source(email, source)


# ---------- ① 攻击者锁不动真用户 / the DoS is gone ----------

def test_an_attacker_cannot_lock_the_real_user_out():
    """这次改动的全部意义：攻击者把这个账号在**他那边**打到锁死，真用户从自己
    常用的来源照样进得来。原来的按邮箱锁定在这里必红。"""
    email = "victim@t.co"
    _login_ok(email, VICTIM_HOME)                       # 真用户此前正常登录过

    max_attempts, _ = rate_limit._POLICIES["login"]
    _fail(email, ATTACKER, max_attempts + 5)

    assert rate_limit.is_login_locked(email, ATTACKER)          # 攻击者自己被锁
    assert not rate_limit.is_login_locked(email, VICTIM_HOME)   # 真用户不受影响


def test_an_unfamiliar_source_still_trips_at_the_old_threshold():
    """对单个账号的定点爆破一次都没放宽：陌生来源仍然是 8 次。"""
    max_attempts, _ = rate_limit._POLICIES["login"]
    _fail("v@t.co", ATTACKER, max_attempts - 1)
    assert not rate_limit.is_login_locked("v@t.co", ATTACKER)
    _fail("v@t.co", ATTACKER, 1)
    assert rate_limit.is_login_locked("v@t.co", ATTACKER)


def test_a_familiar_source_gets_a_much_looser_threshold():
    """本人忘了密码连试十几次，不该被自己锁在门外。"""
    email = "v@t.co"
    _login_ok(email, VICTIM_HOME)

    unfamiliar_max, _ = rate_limit._POLICIES["login"]
    familiar_max, _ = rate_limit._POLICIES["login_known"]
    assert familiar_max > unfamiliar_max

    _fail(email, VICTIM_HOME, familiar_max - 1)
    assert not rate_limit.is_login_locked(email, VICTIM_HOME)
    _fail(email, VICTIM_HOME, 1)
    assert rate_limit.is_login_locked(email, VICTIM_HOME)       # 放宽不等于没有上限


def test_a_familiar_source_is_per_account_not_global():
    """「常用」是这个账号认的，不是这台机器对全站通行——否则攻击者拿自己的账号
    登录一次，就给自己的 IP 换来了对所有账号的宽松阈值。"""
    _login_ok("attacker@t.co", ATTACKER)
    assert rate_limit.is_known_login_source("attacker@t.co", ATTACKER)
    assert not rate_limit.is_known_login_source("victim@t.co", ATTACKER)


def test_only_a_successful_login_makes_a_source_familiar():
    """失败再多次也不能把自己变成"常用来源"。"""
    _fail("v@t.co", ATTACKER, 20)
    assert not rate_limit.is_known_login_source("v@t.co", ATTACKER)


# ---------- ② 撞库仍然挡得住 / spraying is still blocked ----------

def test_one_source_spraying_many_accounts_gets_blocked():
    """同一个来源对多个账号连续失败要被拦：这是撞库的特征，把它放过等于拆闸门。"""
    per_account, _ = rate_limit._POLICIES["login"]
    source_max, _ = rate_limit._POLICIES["login_source"]

    tried = 0
    account = 0
    while tried < source_max:
        _fail(f"u{account}@t.co", ATTACKER, per_account)
        tried += per_account
        account += 1

    # 一个此前从没被碰过的账号，从这个来源也进不来了
    assert rate_limit.is_login_locked("never-touched@t.co", ATTACKER)
    assert source_max > per_account                     # 单账号打满一次还不够，必须换账号


def test_a_sprayed_source_does_not_lock_out_its_own_regulars():
    """NAT 后面有人被撞库，不能把整栋楼的人一起挡在外面——那只是把 DoS 从按邮箱
    挪到了按 IP。常用来源的判定刻意不看来源级计数。"""
    shared_source = "office-nat"
    _login_ok("colleague@t.co", shared_source)          # 这位同事平时就从这里登录

    per_account, _ = rate_limit._POLICIES["login"]
    source_max, _ = rate_limit._POLICIES["login_source"]
    tried = 0
    account = 0
    while tried < source_max:
        _fail(f"u{account}@t.co", shared_source, per_account)
        tried += per_account
        account += 1

    assert rate_limit.is_login_locked("stranger@t.co", shared_source)
    assert not rate_limit.is_login_locked("colleague@t.co", shared_source)


def test_a_successful_login_does_not_reset_the_spray_counter():
    """攻击者用自己的账号成功登录一次就把撒网计数清零的话，绕过方法就写在门口了。"""
    per_account, _ = rate_limit._POLICIES["login"]
    source_max, _ = rate_limit._POLICIES["login_source"]
    tried = 0
    account = 0
    while tried < source_max:
        _fail(f"u{account}@t.co", ATTACKER, per_account)
        tried += per_account
        account += 1

    _login_ok("attacker-own@t.co", ATTACKER)
    assert rate_limit.is_login_locked("victim@t.co", ATTACKER)


def test_a_familiar_users_own_typos_never_feed_the_spray_counter():
    """老用户在自己常用的来源上敲错密码，不该把这个来源推向"撒网"判定。"""
    _login_ok("me@t.co", VICTIM_HOME)
    source_max, _ = rate_limit._POLICIES["login_source"]
    _fail("me@t.co", VICTIM_HOME, source_max + 5)
    assert rate_limit._read("login_source", VICTIM_HOME) is None
    assert not rate_limit.is_login_locked("stranger@t.co", VICTIM_HOME)


# ---------- ③ 名单有上限与过期 / the roster is bounded ----------

def test_the_familiar_source_list_is_capped():
    """漫游用户一年能攒出成千上万个来源，而这份名单每次登录都要整份读出来。"""
    email = "roamer@t.co"
    cap = rate_limit.KNOWN_SOURCES_PER_ACCOUNT
    for i in range(cap + 5):
        rate_limit.remember_login_source(email, f"src-{i}")

    members = shared_state.set_members(rate_limit._known_sources_key(email))
    assert len(members) <= cap
    assert f"src-{cap + 4}" in members                   # 最新的一定还在
    assert "src-0" not in members                        # 最旧的被淘汰


def test_re_recording_the_same_source_does_not_grow_the_list():
    email = "u@t.co"
    for _ in range(20):
        rate_limit.remember_login_source(email, VICTIM_HOME)
    assert shared_state.set_members(rate_limit._known_sources_key(email)) == [VICTIM_HOME]


def test_a_familiar_source_expires(monkeypatch):
    """来源会变（换网络、CGNAT），名单必须自己过期，不能永久记住一台一年没用过的机器。"""
    email = "u@t.co"
    rate_limit.remember_login_source(email, VICTIM_HOME)
    real = time.time
    monkeypatch.setattr(time, "time", lambda: real() + rate_limit.KNOWN_SOURCE_TTL_SECONDS + 60)
    assert not rate_limit.is_known_login_source(email, VICTIM_HOME)


# ---------- ④ 来源取值 / how the source is derived ----------

def test_the_source_comes_from_client_host_only():
    """真实 IP 只从 request.client.host 取——ProxyHeadersMiddleware 已经按
    TRUSTED_PROXY_IPS 还原过了。自己去读 X-Forwarded-For 就等于采信伪造的头。"""
    a = rate_limit.login_source(_Req("203.0.113.7"))
    b = rate_limit.login_source(_Req("198.51.100.2"))
    assert a != b
    assert a == rate_limit.login_source(_Req("203.0.113.7"))     # 同一 IP 稳定命中同一个桶


def test_the_source_is_not_the_raw_ip():
    """共享状态里不留一份"谁从哪登录"的明文轨迹，键长也固定下来（IPv6 很长）。"""
    src = rate_limit.login_source(_Req("203.0.113.7"))
    assert "203.0.113.7" not in src


def test_no_client_degrades_to_one_shared_bucket():
    """取不到来源时宁可退化成「更严」——所有这类请求落进同一个桶，等同于改动前
    的按邮箱锁定；绝不能因为拿不到 IP 就放行。

    两种取不到的形态各自稳定：没有 client 的请求走 slowapi 的兜底值，
    request 本身为 None（测试替身）走 "unknown"。
    """
    class _NoClient:
        client = None

    assert rate_limit.login_source(None) == "unknown"
    assert rate_limit.login_source(_NoClient()) == rate_limit.login_source(_NoClient())

    max_attempts, _ = rate_limit._POLICIES["login"]
    for src in (rate_limit.login_source(_NoClient()), rate_limit.login_source(None)):
        _fail("u@t.co", src, max_attempts)
        assert rate_limit.is_login_locked("u@t.co", src)


# ---------- 登录成功之后 / after a successful login ----------

def test_a_successful_login_clears_that_pairs_counters():
    """手滑几次后登录成功，计数要归零，否则会累积到把本人锁掉。"""
    email = "u@t.co"
    _fail(email, VICTIM_HOME, 5)
    _login_ok(email, VICTIM_HOME)
    assert rate_limit._read("login", f"{email}|{VICTIM_HOME}") is None

    familiar_max, _ = rate_limit._POLICIES["login_known"]
    _fail(email, VICTIM_HOME, familiar_max - 1)
    _login_ok(email, VICTIM_HOME)
    assert rate_limit._read("login_known", f"{email}|{VICTIM_HOME}") is None
