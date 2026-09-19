"""找回密码：钉住几条写错了也不会报错、但会静默失效的判据。

这套东西的危险之处在于**失败是安静的**：令牌永久有效、用过还能再用、旧会话没
被踢掉——功能表面上全都能用，用户改完密码、能登录、很满意，没有任何人会来报
bug。只有测试能拦。

具体钉四条：

1. **过期与已用必须同时检查。** 只看 `used_at` → 过期令牌永久有效；只看
   `expires_at` → 同一个链接能改无数次密码。两种写法都能通过正常流程的测试。
2. **用掉一个要作废这个人其余的。** 用户连点三次「忘记密码」会收到三封信，用
   最新那封改完之后，收件箱里另外两封必须立刻失效。漏了这条的话，一封躺着的
   旧信还能再改一次密码，而用户以为这事早就结束了。
3. **`forgot-password` 不能泄露邮箱存不存在。** 它是匿名端点，一旦两种情况的
   响应有任何差别，它就成了一个免费的用户枚举器。
4. **重置后 token_version 必须变。** 找回密码的场景里「别人可能正拿着我的旧
   token」是主要担心之一；只改密码不动版本号，那些会话会继续有效。

Pins the checks whose failure mode is silent: eternal tokens, reusable links,
sessions that survive a reset, and an anonymous endpoint that answers whether an
address belongs to one of your users. Every one of those still passes a
happy-path test.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.core.security import generate_api_token, hash_api_token, hash_password, verify_password
from app.models import PasswordResetToken, User
from app.routers.auth import forgot_password as _forgot_decorated
from app.routers.auth import reset_password as _reset_decorated
from app.schemas import ForgotPasswordRequest, ResetPasswordRequest
from app.services.password_reset import (
    RESET_MAX_PER_HOUR,
    consume_token,
    hash_token,
    issue_token,
    too_many_recent_requests,
)


@pytest.fixture(autouse=True)
def _reset_request_counter():
    """每个用例开始前清掉「按邮箱的申请频次」计数。

    那个计数住在 shared_state（没配 Redis 时是进程内内存），跨用例不会自己消失：
    本文件里好几个用例都对同一个邮箱调 forgot_password，不清的话第四次就撞上
    每小时 3 次的上限，失败的还是一个跟频次毫无关系的用例。
    Clears the per-email request counter, which lives in shared_state and would
    otherwise carry across tests — several cases here hit the same address, and
    the fourth would trip the hourly cap inside a test about something else.
    """
    from app.services import shared_state

    shared_state.reset_for_tests()
    yield
    shared_state.reset_for_tests()

# 剥掉 slowapi 装饰器，与 test_email_domains.py 同一手法（限流与这些判据无关，
# 带着装饰器调用需要一个挂了 limiter 的 app.state，那是给测试造场景）。
_forgot = _forgot_decorated.__wrapped__
_reset = _reset_decorated.__wrapped__


class _Req:
    """Request 的最小替身：端点只从它身上取申请来源 IP。

    刻意给测试造这个，而不是把产品代码改成容忍 `request is None`——生产里
    request 永远不是 None，为测试放宽那个判断等于把一处真出问题时能立刻炸出来
    的地方变成静默跳过。
    """

    class _Client:
        host = "203.0.113.7"

    client = _Client()


class _Background:
    """BackgroundTasks 的替身：记下要发的信，不真发。"""

    def __init__(self):
        self.tasks = []

    def add_task(self, fn, *args, **kwargs):
        self.tasks.append((fn, args, kwargs))


def _mk_user(db, email="u@example.com", password="original-password"):
    u = User(
        email=email,
        phone="+60123456789",
        password_hash=hash_password(password) if password else None,
        api_token=hash_api_token(generate_api_token()),
    )
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _issue(db, user):
    raw = issue_token(db, user)
    db.commit()
    return raw


# ---------- 令牌本身 / the token ----------

def test_plaintext_token_is_never_stored(db_session):
    """库里只能有哈希——这张表会进备份、进只读副本、进任何一次误导出。"""
    user = _mk_user(db_session)
    raw = _issue(db_session, user)
    row = db_session.query(PasswordResetToken).one()
    assert row.token_hash != raw
    assert row.token_hash == hash_token(raw)
    # 明文不该出现在这行的任何一列里
    assert raw not in str(row.__dict__)


def test_valid_token_resolves_to_its_user(db_session):
    user = _mk_user(db_session)
    raw = _issue(db_session, user)
    assert consume_token(db_session, raw).id == user.id


def test_token_is_single_use(db_session):
    """只看 expires_at 不看 used_at 的写法会在这里挂——那种写法下同一个链接
    能无限次改密码。"""
    user = _mk_user(db_session)
    raw = _issue(db_session, user)
    assert consume_token(db_session, raw) is not None
    db_session.commit()
    assert consume_token(db_session, raw) is None


def test_expired_token_is_rejected(db_session):
    """只看 used_at 不看 expires_at 的写法会在这里挂——那种写法下令牌永久有效。"""
    user = _mk_user(db_session)
    raw = _issue(db_session, user)
    row = db_session.query(PasswordResetToken).one()
    row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    db_session.commit()
    assert consume_token(db_session, raw) is None


def test_naive_expiry_from_sqlite_does_not_crash(db_session):
    """SQLite 取回的 DateTime 不带时区，Postgres 带。不统一就会在比较那句抛
    TypeError——本地必现、生产看不见的那类环境差异。"""
    user = _mk_user(db_session)
    raw = _issue(db_session, user)
    row = db_session.query(PasswordResetToken).one()
    row.expires_at = (datetime.now(timezone.utc) + timedelta(minutes=10)).replace(tzinfo=None)
    db_session.commit()
    assert consume_token(db_session, raw) is not None


def test_unknown_token_is_rejected(db_session):
    _mk_user(db_session)
    assert consume_token(db_session, "definitely-not-a-real-token") is None


def test_consuming_one_token_kills_the_others(db_session):
    """连点三次「忘记密码」= 三封信。用了第三封，前两封必须当场失效。"""
    user = _mk_user(db_session)
    first = _issue(db_session, user)
    second = _issue(db_session, user)
    third = _issue(db_session, user)
    assert consume_token(db_session, third) is not None
    db_session.commit()
    assert consume_token(db_session, first) is None
    assert consume_token(db_session, second) is None


def test_one_users_token_cannot_touch_another(db_session):
    a = _mk_user(db_session, email="a@example.com")
    _mk_user(db_session, email="b@example.com")
    raw = _issue(db_session, a)
    assert consume_token(db_session, raw).email == "a@example.com"


def test_token_for_a_deleted_user_is_burned_not_left_live(db_session):
    """账号在申请与点击之间被删掉：令牌要作废，不能留一个指向空用户的活令牌。"""
    user = _mk_user(db_session)
    raw = _issue(db_session, user)
    db_session.delete(user)
    db_session.commit()
    assert consume_token(db_session, raw) is None
    assert db_session.query(PasswordResetToken).one().used_at is not None


# ---------- forgot-password 端点 / the request endpoint ----------

def test_forgot_password_does_not_reveal_whether_the_email_exists(db_session):
    """两种情况的响应必须一字不差，否则这就是个用户枚举器。"""
    _mk_user(db_session, email="real@example.com")
    hit = _forgot(request=_Req(), req=ForgotPasswordRequest(email="real@example.com"),
                  background=_Background(), db=db_session)
    miss = _forgot(request=_Req(), req=ForgotPasswordRequest(email="nobody@example.com"),
                   background=_Background(), db=db_session)
    assert hit.message == miss.message


def test_forgot_password_only_queues_mail_for_a_real_user(db_session):
    _mk_user(db_session, email="real@example.com")
    bg_hit, bg_miss = _Background(), _Background()
    _forgot(request=_Req(), req=ForgotPasswordRequest(email="real@example.com"), background=bg_hit, db=db_session)
    _forgot(request=_Req(), req=ForgotPasswordRequest(email="nobody@example.com"), background=bg_miss, db=db_session)
    assert len(bg_hit.tasks) == 1
    assert bg_miss.tasks == []


def test_forgot_password_is_case_insensitive_on_the_email(db_session):
    """库里存的是小写；用户打字大小写混着来是常态。"""
    _mk_user(db_session, email="real@example.com")
    bg = _Background()
    _forgot(request=_Req(), req=ForgotPasswordRequest(email="ReAl@Example.COM"), background=bg, db=db_session)
    assert len(bg.tasks) == 1


def test_forgot_password_never_puts_the_plaintext_token_in_the_response(db_session):
    user = _mk_user(db_session, email="real@example.com")
    bg = _Background()
    out = _forgot(request=_Req(), req=ForgotPasswordRequest(email="real@example.com"), background=bg, db=db_session)
    raw = bg.tasks[0][1][1]
    assert raw not in out.message
    assert consume_token(db_session, raw).id == user.id


# ---------- reset-password 端点 / the reset endpoint ----------

def test_reset_password_changes_the_password(db_session):
    user = _mk_user(db_session, password="original-password")
    raw = _issue(db_session, user)
    _reset(request=None, req=ResetPasswordRequest(token=raw, password="a-brand-new-password"), db=db_session)
    db_session.refresh(user)
    assert verify_password("a-brand-new-password", user.password_hash)
    assert not verify_password("original-password", user.password_hash)


def test_reset_password_bumps_token_version(db_session):
    """不加这一下，重置之前签发的所有会话在改完密码后仍然有效。"""
    user = _mk_user(db_session)
    before = user.token_version or 0
    raw = _issue(db_session, user)
    _reset(request=None, req=ResetPasswordRequest(token=raw, password="a-brand-new-password"), db=db_session)
    db_session.refresh(user)
    assert user.token_version == before + 1


def test_reset_password_does_not_sign_the_user_in(db_session):
    """响应里不能有 token：邮件链接会被转发、留在历史里、被邮件网关预抓取。"""
    user = _mk_user(db_session)
    raw = _issue(db_session, user)
    out = _reset(request=None, req=ResetPasswordRequest(token=raw, password="a-brand-new-password"), db=db_session)
    assert not hasattr(out, "token")


def test_reset_password_rejects_a_bad_token_without_saying_why(db_session):
    """没见过 / 用过了 / 过期了——这三种情况对合法用户的下一步完全一样（重新
    申请一封），区分开只会告诉攻击者他猜的令牌存不存在。"""
    user = _mk_user(db_session)
    used = _issue(db_session, user)
    consume_token(db_session, used)
    db_session.commit()

    messages = set()
    for bad in ("never-seen-this-token-at-all", used):
        with pytest.raises(HTTPException) as exc:
            _reset(request=None, req=ResetPasswordRequest(token=bad, password="a-brand-new-password"), db=db_session)
        assert exc.value.status_code == 400
        messages.add(exc.value.detail)
    assert len(messages) == 1


def test_google_only_user_can_set_a_password_through_reset(db_session):
    """没有密码的 Google 用户走完这条路 = 给账号设置了一个密码。挡住他们只会
    让「Google 登不上了」的真用户彻底没有退路。"""
    user = _mk_user(db_session, email="g@example.com", password=None)
    assert user.password_hash is None
    raw = _issue(db_session, user)
    _reset(request=None, req=ResetPasswordRequest(token=raw, password="a-brand-new-password"), db=db_session)
    db_session.refresh(user)
    assert verify_password("a-brand-new-password", user.password_hash)


def test_reset_clears_the_login_lockout(db_session):
    """被撞库锁了的人来重置密码，改完还登不进去会以为没改成功。"""
    from app.core.rate_limit import is_login_locked, record_failed_login

    user = _mk_user(db_session, email="locked@example.com")
    for _ in range(10):
        record_failed_login("locked@example.com")
    assert is_login_locked("locked@example.com")

    raw = _issue(db_session, user)
    _reset(request=None, req=ResetPasswordRequest(token=raw, password="a-brand-new-password"), db=db_session)
    assert not is_login_locked("locked@example.com")
