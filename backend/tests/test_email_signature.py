"""每封邮件底部的品牌签名栏。

钉住的是：
- 社群链接跟着管理后台「官方社交主页」走，没填的平台不出现；
- 签名栏真的接到了每一种信上（群发 / 自动邮件、验证邮箱、重置密码）；
- 读设置出错时信照样能拼出来——签名栏是装饰，不能挡住验证码。
"""
import pytest

from app.services import email_broadcast as eb
from app.services import email_signature, email_verification, password_reset
from app.services.settings_store import invalidate_social_cache, save_social_settings


@pytest.fixture(autouse=True)
def _fresh_cache():
    invalidate_social_cache()
    yield
    invalidate_social_cache()


def test_only_configured_platforms_are_linked(db_session):
    save_social_settings(db_session, {
        "facebook_url": "https://facebook.com/prismx",
        "discord_url": "https://discord.gg/abc",
    })
    db_session.commit()
    invalidate_social_cache()
    html, text = email_signature.render(db_session)
    assert 'href="https://facebook.com/prismx"' in html
    assert 'href="https://discord.gg/abc"' in html
    assert "/email/facebook.png" in html and "/email/discord.png" in html
    # 没填的平台不出图标 / unset platforms get no icon
    assert "/email/x.png" not in html and "/email/telegram.png" not in html
    assert "Facebook: https://facebook.com/prismx" in text
    assert "/email/logo.png" in html
    assert "mailto:signallab.prismx@gmail.com" in html


def test_no_socials_still_renders_site_and_contact(db_session):
    html, text = email_signature.render(db_session)
    assert "/email/facebook.png" not in html
    assert "prismxsignallab.com" in html
    assert "PRISMX Signal Lab" in text


def test_settings_failure_does_not_break_the_mail(monkeypatch):
    def boom(_db):
        raise RuntimeError("db down")

    monkeypatch.setattr(email_signature, "get_social_settings", boom)
    html, _ = email_signature.render(object())
    assert "/email/logo.png" in html and "/email/discord.png" not in html


def test_signature_on_broadcast_mail(db_session):
    content = eb.Content(kind=eb.KIND_NOTICE, subject_zh="标题", body_zh="正文", subject_en="", body_en="")
    msg = eb.build_message(content, None, db_session)
    assert "/email/logo.png" in msg.html
    assert msg.html.rstrip().endswith("</div>")
    assert "PRISMX Signal Lab · 信号实验室" in msg.text


@pytest.mark.parametrize("send, module", [
    (email_verification.send_verification_email, email_verification),
    (password_reset.send_reset_email, password_reset),
])
def test_signature_on_account_mail(monkeypatch, send, module):
    sent = {}

    def fake_send(to, subject, html, text):
        sent.update(html=html, text=text)
        return True

    monkeypatch.setattr(module, "send_email", fake_send)
    monkeypatch.setattr(email_signature, "get_social_settings", lambda _db: {"x_url": "https://x.com/prismx"})
    assert send("a@example.com", "tok")
    assert 'href="https://x.com/prismx"' in sent["html"]
    assert "X: https://x.com/prismx" in sent["text"]
