"""审计 B 组：昵称归一与自动邮件里的昵称过滤。

· 不可见的「默认可忽略」码位（U+034F 组合字形连接符、U+FE00–FE0F 变体选择符、韩文填充符
  U+115F/U+1160/U+3164/U+FFA0 等）不属于 Cc/Cf，以前留在 nickname_key 里，能拆开保留词、
  躲过引流检查、给别人的昵称加一个看不见的尾巴冒名；
· 自动邮件的昵称标记过滤只跑一遍：删掉 `*` 之后拼出来的 `https://` 不会再被查，变成一个
  平台样式的可点链接。

Audit group B: nickname normalisation and the automated-email nickname filter.
"""
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.core import rate_limit
from app.core.config import settings
from app.models import User
from app.routers.account import _apply_profile_patch
from app.schemas import ProfilePatchIn
from app.services import email_automation as ea
from app.services.gamification.identity import (
    nickname_forbidden, nickname_key, nickname_reserved, strip_invisible,
)

CGJ = "͏"


# ---------- identity ----------

@pytest.mark.parametrize("ch", ["͏", "️", "︀", "ᅟ", "ᅠ", "ㅤ",
                                "ﾠ", "឴", "᠋", "\U000e0100", "⁥", "­"])
def test_default_ignorable_code_points_are_stripped(ch):
    assert strip_invisible(f"ad{ch}min") == "admin"
    assert nickname_key(f"ad{ch}min") == "admin"


@pytest.mark.parametrize("bad", ["ad" + CGJ + "min", "客" + CGJ + "服", "pri" + CGJ + "smx",
                                 "Adㅤmin", "admin️"])
def test_split_reserved_words_still_reserved(bad):
    assert nickname_reserved(bad)


@pytest.mark.parametrize("bad", ["t" + CGJ + ".me/abc", "Joe123" + CGJ + "456", "aﾠ@b"])
def test_split_promo_content_still_forbidden(bad):
    assert nickname_forbidden(bad)


def test_visible_names_unchanged():
    assert nickname_key("Trader 小明") == "trader小明"
    assert strip_invisible("张三ABC") == "张三ABC"


def _u(db, email):
    u = User(email=email, api_token="tok_" + email)
    db.add(u); db.commit(); return u


@pytest.mark.parametrize("bad", ["ad" + CGJ + "min", "客" + CGJ + "服", "pri" + CGJ + "smx",
                                 "t" + CGJ + ".me/abc", "Joe123" + CGJ + "456"])
def test_profile_patch_rejects_invisible_split_nicknames(db_session, bad):
    u = _u(db_session, "inv@t.co")
    with pytest.raises(HTTPException) as e:
        _apply_profile_patch(db_session, u, ProfilePatchIn(nickname=bad))
    assert e.value.status_code == 400


def test_profile_patch_rejects_invisible_duplicate_nickname(db_session):
    u1, u2 = _u(db_session, "inv1@t.co"), _u(db_session, "inv2@t.co")
    _apply_profile_patch(db_session, u1, ProfilePatchIn(nickname="Trader"))
    with pytest.raises(HTTPException) as e:
        _apply_profile_patch(db_session, u2, ProfilePatchIn(nickname="Trader" + CGJ))
    assert e.value.status_code in (400, 409)


# ---------- email automation ----------

def _now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


@pytest.fixture
def admin(db_session):
    u = User(email="admin@t.co", password_hash="x", api_token="tok-admin", role="admin",
             nickname="管理员", created_at=_now() - timedelta(days=400))
    db_session.add(u); db_session.commit(); return u


@pytest.fixture
def configured(monkeypatch):
    monkeypatch.setattr(settings, "RESEND_API_KEY", "re_test")
    monkeypatch.setattr(settings, "BROADCAST_EMAIL_DAILY_CAP", 0)
    monkeypatch.setattr(rate_limit.limiter, "enabled", False)


@pytest.mark.parametrize("nick", ["ht*tp://x.ru/a", "h(t)tps://x.ru/b", "ht**tps:/*/x.ru/c",
                                  "hthttp://tp://x.ru/d"])
def test_nickname_cannot_be_reassembled_into_a_link(db_session, admin, configured, nick):
    from app.models import EmailAutomation
    now = _now()
    db_session.add(EmailAutomation(
        name="signup", trigger="signup", delay_minutes=0, kind="marketing",
        subject_zh="你好 {昵称}", body_zh="欢迎 {昵称}。{网站链接}", enabled=True,
        activated_at=now - timedelta(hours=1), created_by=admin.id))
    db_session.add(User(email="victim@t.co", password_hash="x", api_token="tok-victim",
                        nickname=nick, created_at=now - timedelta(minutes=5)))
    db_session.commit()
    ea.scan_once(db_session, now)
    job = ea.claim_next(db_session, now)
    assert isinstance(job, ea.AutoJob)
    assert 'href="http://x.ru' not in job.message.html
    assert 'href="https://x.ru' not in job.message.html
    assert "://x.ru" not in job.message.html and "://x.ru" not in job.message.text


def test_markup_strip_reaches_fixed_point():
    from types import SimpleNamespace
    u = SimpleNamespace(nickname="ht*tps:/(/)x.ru", email="a@t.co", plan_expires_at=None, id="x")
    nick = ea._clean_nickname(u.nickname)
    assert "http" not in nick.lower() and "://" not in nick
