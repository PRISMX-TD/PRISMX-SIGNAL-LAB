"""后端入口列表（2026-11-11）：管理员追加的新入口，客户端定期拉取，被封时切过去。

要点：只收 https 基址；写入时一行不合格整份拒绝；读取时再过一遍校验（直接改库写进去的坏值
当没填）；公开接口只返回规范化后的列表；改动进审计。

API entry list (2026-11-11): admin-added bases clients fetch and fail over to. https bases only;
one bad line rejects the whole write; re-validated on read; the public endpoint returns the
normalised list; changes are audited.
"""
import json

import pytest
from pydantic import ValidationError

from app.models import AdminAuditLog, PlatformSetting, User
from app.routers.admin import get_admin_api_entries, put_admin_api_entries
from app.routers.site import get_site_entries
from app.schemas import AdminApiEntries
from app.services.settings_store import (
    API_ENTRIES_MAX,
    invalidate_api_entries_cache,
    normalize_api_entry,
)


@pytest.fixture(autouse=True)
def _clean_cache():
    invalidate_api_entries_cache()
    yield
    invalidate_api_entries_cache()


def _admin(db):
    u = User(email="admin@x.com", api_token="tok_admin", role="admin")
    db.add(u)
    db.commit()
    return u


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("https://1.2.3.4/_b", "https://1.2.3.4/_b"),
        ("  https://1.2.3.4/_b/  ", "https://1.2.3.4/_b"),
        ("https://api.example.com", "https://api.example.com"),
        ("https://api.example.com:8443/x/y", "https://api.example.com:8443/x/y"),
        ("http://1.2.3.4/_b", None),
        ("javascript:alert(1)", None),
        ("https://user@evil.com", None),
        ("https://a.com/?q=1", None),
        ("https://a.com/#x", None),
        ("https://a.com/a b", None),
        ("https://-bad-.com", None),
        ("", None),
        (None, None),
        (123, None),
    ],
)
def test_normalize_api_entry(raw, expected):
    assert normalize_api_entry(raw) == expected


def test_empty_by_default(db_session):
    assert get_site_entries(db_session) == {"entries": []}
    assert get_admin_api_entries(db_session, _admin(db_session)).entries == []


def test_save_normalises_dedupes_and_is_public(db_session):
    admin = _admin(db_session)
    body = AdminApiEntries(entries=["https://5.6.7.8/_b/", "", "https://5.6.7.8/_b", "https://api.new.com"])
    out = put_admin_api_entries(body, db_session, admin)
    assert out.entries == ["https://5.6.7.8/_b", "https://api.new.com"]
    assert get_site_entries(db_session) == {"entries": ["https://5.6.7.8/_b", "https://api.new.com"]}
    assert db_session.query(AdminAuditLog).filter(AdminAuditLog.field == "setting:api_entries:entries").count() == 1


def test_one_bad_line_rejects_the_whole_list():
    with pytest.raises(ValidationError):
        AdminApiEntries(entries=["https://5.6.7.8/_b", "http://plain.com"])


def test_too_many_entries_rejected():
    with pytest.raises(ValidationError):
        AdminApiEntries(entries=[f"https://h{i}.com" for i in range(API_ENTRIES_MAX + 1)])


def test_bad_rows_written_directly_are_dropped_on_read(db_session):
    db_session.add(PlatformSetting(
        key="api_entries",
        value=json.dumps({"entries": ["https://ok.com/_b", "javascript:x", 5, "http://no.com"]}),
    ))
    db_session.commit()
    assert get_site_entries(db_session) == {"entries": ["https://ok.com/_b"]}


def test_garbage_json_falls_back_to_empty(db_session):
    db_session.add(PlatformSetting(key="api_entries", value="{not json"))
    db_session.commit()
    assert get_site_entries(db_session) == {"entries": []}
