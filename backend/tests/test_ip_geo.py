"""ip_geo：IP 规范化与 ip2region 结果改写。台湾 / 香港 / 澳门只写名字（产品决定）。"""
from pathlib import Path

import pytest

from app.services import ip_geo
from app.services.ip_geo import Geo, normalize_ip, parse_region


@pytest.mark.parametrize("raw", [None, "", "not-an-ip", "127.0.0.1", "10.1.2.3", "192.168.1.1",
                                 "172.16.0.5", "100.64.0.1", "169.254.1.1", "::1", "fe80::1", "0.0.0.0"])
def test_normalize_ip_rejects_non_global(raw):
    assert normalize_ip(raw) is None


def test_normalize_ip_keeps_public_v4_and_unmaps_v4_mapped_v6():
    assert normalize_ip(" 112.96.38.165 ") == "112.96.38.165"
    assert normalize_ip("::ffff:112.96.38.165") == "112.96.38.165"


def test_normalize_ip_compresses_v6():
    assert normalize_ip("2001:0db8:0000:0000:0000:0000:0000:0001") is None   # 文档保留段 / doc range
    assert normalize_ip("2408:8256:0000:0000:0000:0000:0000:0001") == "2408:8256::1"


def test_parse_mainland_strips_suffixes():
    assert parse_region("中国|广东省|深圳市|电信|CN") == Geo("中国", "CN", "广东", "深圳")
    assert parse_region("中国|北京市|北京市|移动|CN") == Geo("中国", "CN", "北京", "北京")
    assert parse_region("中国|广西壮族自治区|南宁市|电信|CN") == Geo("中国", "CN", "广西", "南宁")
    assert parse_region("中国|内蒙古自治区|0|电信|CN") == Geo("中国", "CN", "内蒙古", None)


@pytest.mark.parametrize("region,expected", [
    ("中国|台湾省|0|中华电信|CN", Geo("台湾", "TW", None, None)),
    ("中国|香港特别行政区|0|电讯盈科|CN", Geo("香港", "HK", None, None)),
    ("中国|澳门特别行政区|0|澳门电讯|CN", Geo("澳门", "MO", None, None)),
    ("中国|台湾|台北|0|TW", Geo("台湾", "TW", None, "台北")),
])
def test_parse_tw_hk_mo_plain_names(region, expected):
    assert parse_region(region) == expected


def test_parse_overseas_uses_chinese_country_name_keeps_city():
    assert parse_region("Malaysia|Selangor|Petaling Jaya|Binariang Berhad|MY") == Geo("马来西亚", "MY", None, "Petaling Jaya")
    assert parse_region("United States|California|0|Google LLC|US") == Geo("美国", "US", None, None)


def test_parse_unknown_country_code_keeps_raw_name():
    assert parse_region("Atlantis|0|0|0|ZZ") == Geo("Atlantis", None, None, None)


@pytest.mark.parametrize("region", [None, "", "0|0|0|0|0", "garbage"])
def test_parse_empty_or_malformed(region):
    assert parse_region(region) is None


def test_country_names():
    assert ip_geo.country_names("TW") == ("台湾", "Taiwan", "158")
    assert ip_geo.country_names(None) == (None, None, None)
    assert ip_geo.country_names("ZZ") == (None, None, None)


def test_lookup_missing_file_returns_none(monkeypatch, tmp_path):
    monkeypatch.setattr(ip_geo, "XDB_V4_PATH", tmp_path / "missing.xdb")
    ip_geo._reset_searcher()
    try:
        assert ip_geo.lookup("112.96.38.165") is None
    finally:
        ip_geo._reset_searcher()


def test_lookup_ipv6_returns_none():
    assert ip_geo.lookup("2408:8256::1") is None


@pytest.mark.skipif(not Path(ip_geo.XDB_V4_PATH).exists(), reason="xdb not present")
def test_lookup_real_file():
    ip_geo._reset_searcher()
    assert ip_geo.lookup("112.96.38.165") == Geo("中国", "CN", "广东", "广州")
    assert ip_geo.lookup("1.36.0.1") == Geo("香港", "HK", None, None)


def test_country_names_fixed_catalog_typos():
    # pycountry zh_CN 目录的错字已在生成脚本里覆盖 / catalog typos overridden in the generator
    assert ip_geo.country_names("KH")[0] == "柬埔寨"
    assert ip_geo.country_names("GT")[0] == "危地马拉"
