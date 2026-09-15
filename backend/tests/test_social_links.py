"""官方社交主页设置：读写往返 + 两道协议白名单。

这五个值最终会变成页面上的 href，所以协议校验有两道（写入时的 schema、读取时
的 settings_store），两道都要有用例——只测写入的那道，等于默认"库里的值一定
是本系统写进去的"，而那正是运维直接改库/旧行/导入脚本会打破的前提。

Official social links: round-trip plus both scheme allowlists. These values end
up as hrefs, so the scheme check exists twice (schema on write, settings_store
on read) and both need coverage: testing only the write path assumes every row
was written by this system, which is exactly what direct DB edits, legacy rows
and import scripts break.
"""
import json

import pytest
from pydantic import ValidationError

from app.models import PlatformSetting, User
from app.routers.admin import get_social, put_social
from app.routers.site import get_social_links
from app.schemas import AdminSocialSettings
from app.services.settings_store import get_social_settings, invalidate_social_cache


@pytest.fixture(autouse=True)
def _clean_cache():
    """settings_store 的缓存是模块级的，用例之间必须清掉。"""
    invalidate_social_cache()
    yield
    invalidate_social_cache()


def _admin(db):
    u = User(email="a@x.com", api_token="tok_a", role="admin")
    db.add(u); db.commit(); return u


def test_defaults_are_all_empty_and_public_endpoint_returns_nothing(db_session):
    """全新部署：一个社交入口都不该冒出来。"""
    assert get_social_settings(db_session) == {
        "facebook_url": "", "instagram_url": "", "x_url": "",
        "discord_url": "", "telegram_url": "",
    }
    assert get_social_links(db_session) == {}


def test_round_trip_through_admin_endpoints(db_session):
    admin = _admin(db_session)
    put_social(
        AdminSocialSettings(
            facebookUrl="https://www.facebook.com/prismx",
            instagramUrl="https://www.instagram.com/prismx",
            xUrl="https://x.com/prismx",
            discordUrl="https://discord.gg/abc123",
            telegramUrl="https://t.me/prismx",
        ),
        db_session,
        admin,
    )
    invalidate_social_cache()
    out = get_social(db_session, admin)
    assert out.xUrl == "https://x.com/prismx"
    assert out.telegramUrl == "https://t.me/prismx"
    assert get_social_links(db_session) == {
        "facebook": "https://www.facebook.com/prismx",
        "instagram": "https://www.instagram.com/prismx",
        "x": "https://x.com/prismx",
        "discord": "https://discord.gg/abc123",
        "telegram": "https://t.me/prismx",
    }


def test_public_endpoint_omits_unset_platforms(db_session):
    """只填了两个，公开接口就只出现两个键——前端不用再判空字符串。"""
    admin = _admin(db_session)
    put_social(
        AdminSocialSettings(telegramUrl="https://t.me/prismx", discordUrl="https://discord.gg/abc123"),
        db_session,
        admin,
    )
    invalidate_social_cache()
    assert get_social_links(db_session) == {
        "discord": "https://discord.gg/abc123",
        "telegram": "https://t.me/prismx",
    }


@pytest.mark.parametrize("bad", ["javascript:alert(1)", "data:text/html,x", "t.me/prismx"])
def test_schema_rejects_non_http_schemes(bad):
    """写入侧：非 http(s) 一律 422，不进库。"""
    with pytest.raises(ValidationError):
        AdminSocialSettings(telegramUrl=bad)


def test_read_side_drops_values_this_system_never_wrote(db_session):
    """读取侧：绕过 schema 塞进库的值（直接改库/旧行/导入脚本）也不会变成 href。"""
    db_session.add(PlatformSetting(key="social", value=json.dumps({
        "facebook_url": "javascript:alert(1)",
        "instagram_url": 12345,            # 类型就不对 / not even a string
        "x_url": "  https://x.com/prismx  ",  # 两头空白应被 strip
        "discord_url": None,
        "telegram_url": "ftp://example.com/x",
    })))
    db_session.commit()
    invalidate_social_cache()
    assert get_social_settings(db_session) == {
        "facebook_url": "", "instagram_url": "",
        "x_url": "https://x.com/prismx",
        "discord_url": "", "telegram_url": "",
    }
    assert get_social_links(db_session) == {"x": "https://x.com/prismx"}
