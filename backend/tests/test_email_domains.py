"""一次性邮箱闸门：钉住"放行永远赢"这条唯一重要的性质。

这个套件里真正值钱的是 `test_allowlist_beats_a_poisoned_blocklist`：它把国内
主流邮箱**故意塞进黑名单**，然后断言它们照样放行。原因是黑名单是上游开源列表
的快照，内容不由我们控制，而这类列表把正规邮箱误列进去是真实发生过的事
（yeah.net、188.com、21cn.com、tom.com、sina.cn、wo.cn 这批名字不像邮箱的
国内域名最容易中招）。

这条性质失效的方式非常隐蔽：判定顺序被人从"先放行后拦截"改成"先拦截、命中后
再看例外"，功能上等价、所有常规用例都还绿，直到上游某次更新收录了 163.com——
然后中国用户集体注册不了，而且不会有人来报 bug，只会不注册。所以顺序必须有
一条专门的用例钉住，而不是依赖"黑名单里现在没有国内域名"这个会变的事实。

Pins the one property that matters: allow always beats block. The valuable case
is the poisoned-blocklist one — it puts mainstream Chinese mailboxes *into* the
blocklist and asserts they still pass, because the blocklist is a snapshot of an
upstream list we don't control and such lists have historically mislabelled real
mailboxes. The failure mode is silent: reordering the check to "block first,
then look for exceptions" is functionally equivalent and keeps every ordinary
test green, right up until an upstream refresh adds 163.com and Chinese users
quietly stop being able to register.
"""
import pytest

from app.models import PlatformSetting, User
from app.services import email_domains
from app.services.email_domains import ALLOW_DOMAINS, domain_of, is_disposable_email, normalize_domain
from app.services.settings_store import invalidate_email_gate_cache, save_email_gate_settings

# 国内主流邮箱，一个都不能被拦 / mainstream Chinese mailboxes, none may be blocked
CHINESE_MAILBOXES = [
    "qq.com", "vip.qq.com", "foxmail.com",
    "163.com", "126.com", "yeah.net", "vip.163.com", "188.com",
    "sina.com", "sina.cn", "sohu.com", "aliyun.com",
    "139.com", "189.cn", "wo.cn",
    "21cn.com", "tom.com", "263.net",
]


@pytest.fixture(autouse=True)
def _reset_caches():
    """设置缓存和黑名单快照都是进程内全局，用例之间必须互相隔离。"""
    invalidate_email_gate_cache()
    email_domains._blocklist = None
    yield
    invalidate_email_gate_cache()
    email_domains._blocklist = None


def _set_gate(db, **kw):
    save_email_gate_settings(db, kw)
    db.commit()
    invalidate_email_gate_cache()


# ---------- 放行 / allow ----------

@pytest.mark.parametrize("domain", CHINESE_MAILBOXES)
def test_chinese_mailboxes_are_never_blocked(db_session, domain):
    assert is_disposable_email(db_session, f"user@{domain}") is False


@pytest.mark.parametrize("domain", ["gmail.com", "outlook.com", "icloud.com", "proton.me", "yahoo.com"])
def test_international_mailboxes_are_never_blocked(db_session, domain):
    assert is_disposable_email(db_session, f"user@{domain}") is False


def test_allowlist_beats_a_poisoned_blocklist(db_session):
    """上游列表把国内主流邮箱误列成一次性邮箱时，一个真人都不能被伤到。

    这是本文件存在的理由，见模块 docstring。
    """
    email_domains._blocklist = frozenset(CHINESE_MAILBOXES)
    for domain in CHINESE_MAILBOXES:
        assert is_disposable_email(db_session, f"user@{domain}") is False, domain


def test_allowed_subdomain_stays_allowed(db_session):
    """放行是按父域链匹配的：163.com 放行，则 mail.163.com 也放行。"""
    email_domains._blocklist = frozenset({"mail.163.com"})
    assert is_disposable_email(db_session, "u@mail.163.com") is False


# ---------- 拦截 / block ----------

@pytest.mark.parametrize("domain", [
    "mailinator.com", "10minutemail.com", "guerrillamail.com", "yopmail.com",
    "temp-mail.org", "linshiyouxiang.net", "chacuo.net", "sharklasers.com",
])
def test_known_disposable_domains_are_blocked(db_session, domain):
    assert is_disposable_email(db_session, f"u@{domain}") is True


def test_blocked_subdomain_is_caught(db_session):
    """mailinator 这类服务送无限子域名，只匹配精确域名等于白做。"""
    assert is_disposable_email(db_session, "u@anything.mailinator.com") is True


def test_case_and_whitespace_do_not_bypass(db_session):
    assert is_disposable_email(db_session, "U@MailInator.COM ") is True


def test_quoted_local_part_does_not_confuse_the_split(db_session):
    """本地部分带 @ 时（RFC 5321 的 quoted-string），域名仍要取对。"""
    assert domain_of('"a@b"@mailinator.com') == "mailinator.com"


# ---------- 后台增补名单 / admin-editable lists ----------

def test_extra_blocked_domain_takes_effect(db_session):
    """上游还没收录的新域名，运营当场补一条就能拦。"""
    assert is_disposable_email(db_session, "u@brand-new-temp.io") is False
    _set_gate(db_session, extra_blocked_domains=["brand-new-temp.io"])
    assert is_disposable_email(db_session, "u@brand-new-temp.io") is True


def test_extra_allowed_beats_the_snapshot(db_session):
    """误伤时的救火通道：后台放行一条，快照里拦着也放行。"""
    assert is_disposable_email(db_session, "u@mailinator.com") is True
    _set_gate(db_session, extra_allowed_domains=["mailinator.com"])
    assert is_disposable_email(db_session, "u@mailinator.com") is False


def test_extra_allowed_beats_extra_blocked(db_session):
    """同一个域名同时出现在两份名单里时，放行赢——和内置规则同一套顺序。"""
    _set_gate(
        db_session,
        extra_blocked_domains=["contested.io"],
        extra_allowed_domains=["contested.io"],
    )
    assert is_disposable_email(db_session, "u@contested.io") is False


def test_master_switch_off_lets_everything_through(db_session):
    """误伤面失控时，后台关掉总开关就能立刻恢复，不用发版。"""
    _set_gate(db_session, disposable_block_enabled=False)
    assert is_disposable_email(db_session, "u@mailinator.com") is False


def test_corrupt_settings_do_not_crash_registration(db_session):
    """手改数据库把名单写成字符串时，不能让每个字符都被当成一个域名。"""
    db_session.add(PlatformSetting(
        key="email_gate",
        value='{"disposable_block_enabled": true, "extra_allowed_domains": "oops"}',
    ))
    db_session.commit()
    invalidate_email_gate_cache()
    assert is_disposable_email(db_session, "u@gmail.com") is False
    assert is_disposable_email(db_session, "u@mailinator.com") is True


# ---------- 降级 / degradation ----------

def test_unreadable_snapshot_fails_open(db_session, monkeypatch):
    """数据文件读不出来时放行而不是全拦：拦错了是所有新用户都注册不了。"""
    monkeypatch.setattr(email_domains, "_DATA_PATH", "/nonexistent/blocklist.txt")
    email_domains._blocklist = None
    assert is_disposable_email(db_session, "u@mailinator.com") is False


# ---------- 输入规范化 / normalisation ----------

@pytest.mark.parametrize("raw,expect", [
    ("@QQ.com", "qq.com"),      # 管理员粘贴时常带 @
    ("gmail.com.", "gmail.com"),  # FQDN 写法的尾点
    ("  163.COM ", "163.com"),
    ("com", ""),                 # 裸 TLD：放进任一名单都会造成大面积误伤
    ("not a domain", ""),
    ("", ""),
])
def test_normalize_domain(raw, expect):
    assert normalize_domain(raw) == expect


# ---------- 数据文件自身的防漂移 / snapshot drift guards ----------

def test_snapshot_contains_no_allowlisted_domain():
    """快照里不该出现任何正规邮箱域名。

    运行时放行短路会保护用户，所以这条失败不代表线上出事；它代表上游那一版
    的判断有问题，或者更新脚本的过滤被绕过了，值得人去看一眼。
    """
    snapshot = email_domains._load_blocklist()
    assert not (snapshot & ALLOW_DOMAINS)


def test_snapshot_contains_no_bare_tld():
    """快照里混进一个 "com" 会按父域匹配挡掉全世界。"""
    snapshot = email_domains._load_blocklist()
    assert [d for d in snapshot if "." not in d] == []


# ---------- 注册端点 / the register endpoint ----------
#
# 照仓库惯例走 service 级（本套件无 TestClient 先例），直接调端点函数。register
# 上有 slowapi 的限流装饰器，测试要的是被它包住的那层业务逻辑，所以取
# __wrapped__ —— 限流本身与这次改动无关，而带着装饰器调用需要一个挂了
# limiter 的 app.state，那属于给测试造场景，不是在测产品行为。

from app.routers.auth import register as _register_decorated  # noqa: E402
from app.schemas import RegisterRequest  # noqa: E402
from fastapi import HTTPException  # noqa: E402

_register = _register_decorated.__wrapped__


def _req(email: str) -> RegisterRequest:
    return RegisterRequest(
        email=email, password="a-good-password", phoneCountry="60", phone="123456789"
    )


def test_register_rejects_disposable_with_an_actionable_message(db_session):
    """硬拒，而且要说人话——不能复用那句防枚举用的「无法完成注册」。"""
    with pytest.raises(HTTPException) as exc:
        _register(request=None, req=_req("u@mailinator.com"), db=db_session)
    assert exc.value.status_code == 400
    assert "一次性邮箱" in exc.value.detail
    assert "disposable" in exc.value.detail.lower()
    assert db_session.query(User).filter(User.email == "u@mailinator.com").first() is None


def test_register_accepts_a_chinese_mailbox(db_session):
    """这次改动最主要的风险是误伤国内用户，所以正向路径也要钉一条。"""
    out = _register(request=None, req=_req("zhangsan@163.com"), db=db_session)
    assert out.user.email == "zhangsan@163.com"
    assert db_session.query(User).filter(User.email == "zhangsan@163.com").first() is not None


def test_existing_disposable_users_are_untouched(db_session):
    """存量豁免：闸门只在注册路径上，老账号不再经过这里。

    产品决定是存量全部豁免。这里不需要豁免标记列或迁移——用 SQL 直接造一个
    上线前就存在的一次性邮箱账号，断言它照常存在且可查，正是线上的真实形态。
    """
    from app.core.security import generate_api_token, hash_api_token, hash_password

    old = User(
        email="legacy@mailinator.com",
        phone="+60123456789",
        password_hash=hash_password("a-good-password"),
        api_token=hash_api_token(generate_api_token()),
    )
    db_session.add(old)
    db_session.commit()

    # 账号还在，闸门没有追溯清理任何人
    assert db_session.query(User).filter(User.email == "legacy@mailinator.com").first() is not None
    # 但同一个域名再也注册不进新号
    with pytest.raises(HTTPException):
        _register(request=None, req=_req("newcomer@mailinator.com"), db=db_session)


def test_disposable_check_runs_before_the_duplicate_email_lookup(db_session):
    """顺序钉死：用一次性邮箱注册一个**已存在**的邮箱时，要收到"换个邮箱"，
    而不是那句含糊的「无法完成注册」——后者会让用户完全不知道该改什么。"""
    from app.core.security import generate_api_token, hash_api_token, hash_password

    db_session.add(User(
        email="dup@mailinator.com",
        phone="+60123456789",
        password_hash=hash_password("a-good-password"),
        api_token=hash_api_token(generate_api_token()),
    ))
    db_session.commit()

    with pytest.raises(HTTPException) as exc:
        _register(request=None, req=_req("dup@mailinator.com"), db=db_session)
    assert "一次性邮箱" in exc.value.detail
