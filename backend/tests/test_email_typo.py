"""注册邮箱域名拼错（gamil.com）直接拒绝。

两头都要钉住：拼错的一定拦下并给出对的写法；真实存在的邮箱一个都不能误伤——
后者更要紧，误伤的人不会来报 bug，只会不注册。前端 utils/emailTypo.test.ts 用的是
同一张用例表，改规则时两边一起改。

Misspelled sign-up domains are refused. Both directions are pinned: typos are
caught with the right suggestion, and no real mailbox is ever flagged (the more
important half — a wrongly blocked user just leaves). The frontend's
utils/emailTypo.test.ts uses the same case table; change both together.
"""
import pytest
from fastapi import BackgroundTasks, HTTPException

from app.models import User
from app.routers.auth import register as _register_decorated
from app.schemas import RegisterRequest
from app.services import email_domains
from app.services.email_domains import ALLOW_DOMAINS, suggest_domain_fix
from app.services.settings_store import invalidate_email_gate_cache, save_email_gate_settings

TYPOS = [
    ("joeyluv2004@gamil.com", "joeyluv2004@gmail.com"),  # 2026-10-17 后台那个真实案例
    ("u@gmial.com", "u@gmail.com"),
    ("u@gmai.com", "u@gmail.com"),
    ("u@gmaill.com", "u@gmail.com"),
    ("u@gnail.com", "u@gmail.com"),
    ("u@gmail.con", "u@gmail.com"),
    ("u@gmail.cm", "u@gmail.com"),
    ("u@gmail.co", "u@gmail.com"),
    ("u@gmail.comm", "u@gmail.com"),
    ("u@gmail.vom", "u@gmail.com"),
    ("u@gamil.con", "u@gmail.com"),
    ("u@hotmial.com", "u@hotmail.com"),
    ("u@hotmail.co", "u@hotmail.com"),
    ("u@outlok.com", "u@outlook.com"),
    ("u@yaho.com", "u@yahoo.com"),
    ("u@iclod.com", "u@icloud.com"),
    ("u@qq.con", "u@qq.com"),
    ("u@qq.cm", "u@qq.com"),
    ("u@163.con", "u@163.com"),
    ("u@126.cpm", "u@126.com"),
    ("u@yeah.ner", "u@yeah.net"),
    ("  U.Name@GaMil.COM ", "u.name@gmail.com"),
]

# 真实邮箱：和主流邮箱长得像、多段域名、别的后缀 / real mailboxes that must pass
REAL = [
    "mail.com", "cloud.com", "ymail.com", "email.com", "gmx.com", "me.com",
    "hotmail.co.uk", "yahoo.co.jp", "vip.qq.com", "mail.163.com",
    "sina.cn", "163.net", "126.net", "live.cn", "hotmail.fr", "outlook.jp", "yahoo.de",
    "q.com", "company.com", "example.org",
]


@pytest.mark.parametrize("email,expect", TYPOS)
def test_typos_are_caught_with_the_right_suggestion(email, expect):
    assert suggest_domain_fix(email) == expect


@pytest.mark.parametrize("domain", sorted(ALLOW_DOMAINS) + REAL)
def test_real_mailboxes_are_never_flagged(domain):
    assert suggest_domain_fix(f"user@{domain}") is None


def test_every_target_is_itself_allowlisted():
    """改正后的写法本身必须是放行表里的真邮箱，否则会把人引到另一个错的地址。"""
    targets = email_domains._TYPO_NAME_TARGETS + email_domains._TYPO_SUFFIX_TARGETS
    assert [t for t in targets if t not in ALLOW_DOMAINS] == []


@pytest.mark.parametrize("raw", ["", None, "no-at-sign", "@gamil.com", "u@", "u@localhost"])
def test_malformed_input_is_left_to_emailstr(raw):
    assert suggest_domain_fix(raw) is None


# ---------- 注册端点 / the register endpoint ----------

def _register(**kw):
    return _register_decorated.__wrapped__(background=BackgroundTasks(), **kw)


def _req(email: str) -> RegisterRequest:
    return RegisterRequest(email=email, password="a-good-password", phoneCountry="60", phone="123456789")


@pytest.fixture(autouse=True)
def _reset_caches():
    invalidate_email_gate_cache()
    email_domains._blocklist = None
    yield
    invalidate_email_gate_cache()
    email_domains._blocklist = None


def test_register_refuses_a_typo_domain_and_names_the_fix(db_session):
    with pytest.raises(HTTPException) as exc:
        _register(request=None, req=_req("joeyluv2004@gamil.com"), db=db_session)
    assert exc.value.status_code == 400
    zh, _, en = exc.value.detail.partition(" / ")
    assert "joeyluv2004@gmail.com" in zh and "joeyluv2004@gmail.com" in en
    assert db_session.query(User).filter(User.email == "joeyluv2004@gamil.com").first() is None


def test_typo_check_runs_before_the_disposable_check(db_session):
    """拼错的域名恰好也在一次性黑名单里时，用户要看到「您是不是想输入 …」，
    而不是「请换个常用邮箱」——前者直接告诉他该怎么改。"""
    save_email_gate_settings(db_session, {"extra_blocked_domains": ["gamil.com"]})
    db_session.commit()
    invalidate_email_gate_cache()
    with pytest.raises(HTTPException) as exc:
        _register(request=None, req=_req("u@gamil.com"), db=db_session)
    assert "u@gmail.com" in exc.value.detail


def test_register_still_accepts_a_real_lookalike(db_session):
    out = _register(request=None, req=_req("someone@mail.com"), db=db_session)
    assert out.user.email == "someone@mail.com"
