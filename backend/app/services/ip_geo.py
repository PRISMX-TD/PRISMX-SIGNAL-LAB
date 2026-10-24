"""IP → 地区（ip2region 离线库）。用户分布地图与「登录 IP」侧栏的数据源。

只暴露 lookup / normalize_ip / parse_region。数据文件缺失或损坏时 lookup 返回
None——只记 IP 不记地区，登录流程不受影响。IPv6 不查（v6 库 37MB 不进仓库，站点
只有 A 记录）。

台湾 / 香港 / 澳门：ip2region 把三地放在「中国」下且 ISO 码也写 CN，这里一律改成
只写名字、各自的 ISO 码、不带省份（产品决定 2026-10-25：不掺和政治）。

IP → region via the offline ip2region database. Missing/corrupt data makes lookup
return None (the IP is still logged, just without a region). IPv6 is not looked up.
TW/HK/MO arrive as 中国|台湾省… with code CN; they are rewritten to plain names with
their own codes and no province.
"""
from __future__ import annotations

import ipaddress
import logging
import threading
from dataclasses import dataclass
from pathlib import Path

from app.services.ip_geo_countries import COUNTRIES

logger = logging.getLogger("prismx.ip_geo")

XDB_V4_PATH = Path(__file__).resolve().parent.parent / "data" / "ip2region_v4.xdb"


@dataclass(frozen=True)
class Geo:
    country: str
    country_code: str | None
    province: str | None
    city: str | None


# 中国大陆 31 个省级行政区：库里的全称 → 地图上的短名。
# Mainland China's 31 provincial divisions: full name → short name used on the map.
PROVINCES: dict[str, str] = {
    "北京市": "北京", "天津市": "天津", "上海市": "上海", "重庆市": "重庆",
    "河北省": "河北", "山西省": "山西", "辽宁省": "辽宁", "吉林省": "吉林",
    "黑龙江省": "黑龙江", "江苏省": "江苏", "浙江省": "浙江", "安徽省": "安徽",
    "福建省": "福建", "江西省": "江西", "山东省": "山东", "河南省": "河南",
    "湖北省": "湖北", "湖南省": "湖南", "广东省": "广东", "海南省": "海南",
    "四川省": "四川", "贵州省": "贵州", "云南省": "云南", "陕西省": "陕西",
    "甘肃省": "甘肃", "青海省": "青海",
    "内蒙古自治区": "内蒙古", "广西壮族自治区": "广西", "西藏自治区": "西藏",
    "宁夏回族自治区": "宁夏", "新疆维吾尔自治区": "新疆",
}
PROVINCE_SHORT = frozenset(PROVINCES.values())

# 省字段前缀 → 单独地区的 ISO 码 / province-field prefix → own region code
_SEPARATE = (("台湾", "TW"), ("香港", "HK"), ("澳门", "MO"))


def country_names(code: str | None) -> tuple[str | None, str | None, str | None]:
    """(中文名, 英文名, 数字码)；查不到全是 None / (zh, en, numeric) or Nones."""
    row = COUNTRIES.get(code or "")
    return row if row else (None, None, None)


def normalize_ip(raw: str | None) -> str | None:
    """合法、全局可路由的 IP 才返回规范文本（IPv4-mapped 还原成 IPv4）；否则 None。
    Canonical text for a valid, globally routable IP (v4-mapped unmapped), else None."""
    if not raw:
        return None
    try:
        addr = ipaddress.ip_address(raw.strip())
    except ValueError:
        return None
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        addr = addr.ipv4_mapped
    if not addr.is_global:
        return None
    return str(addr)


def _field(value: str) -> str | None:
    value = value.strip()
    return None if value in ("", "0") else value


def _city(value: str | None) -> str | None:
    if value and value.endswith("市") and len(value) > 2:
        return value[:-1]
    return value


def parse_region(region: str | None) -> Geo | None:
    """ip2region 原始串 `国家|省|市|ISP|ISO码` → Geo；全空或格式不对返回 None。"""
    if not region:
        return None
    parts = region.split("|")
    if len(parts) < 5:
        return None
    country, province, city, _isp, code = (_field(p) for p in parts[:5])
    if country is None:
        return None
    if country == "中国" or code in ("CN", "TW", "HK", "MO"):
        for prefix, own_code in _SEPARATE:
            if (province or "").startswith(prefix) or code == own_code:
                name = country_names(own_code)[0]
                return Geo(name, own_code, None, _city(city))
        short = PROVINCES.get(province or "")
        if short is None and province in PROVINCE_SHORT:
            short = province
        return Geo("中国", "CN", short, _city(city))
    zh_name = country_names(code)[0]
    if zh_name is None:
        return Geo(country, None, None, city)
    return Geo(zh_name, code, None, city)


_lock = threading.Lock()
_searcher = None
_searcher_failed = False


def _reset_searcher() -> None:
    global _searcher, _searcher_failed
    with _lock:
        _searcher = None
        _searcher_failed = False


def _get_searcher():
    """首次使用时把整个 xdb 读进内存（buffer 模式可跨线程共享）；失败只告警一次。
    Loads the whole xdb into memory on first use (buffer searchers are thread-safe);
    a failure is logged once and lookups return None from then on."""
    global _searcher, _searcher_failed
    if _searcher is not None or _searcher_failed:
        return _searcher
    with _lock:
        if _searcher is not None or _searcher_failed:
            return _searcher
        try:
            import ip2region.searcher as xdb
            import ip2region.util as util

            buf = util.load_content_from_file(str(XDB_V4_PATH))
            _searcher = xdb.new_with_buffer(util.IPv4, buf)
        except Exception:
            _searcher_failed = True
            logger.warning("ip2region 数据加载失败，只记 IP 不记地区: %s", XDB_V4_PATH, exc_info=True)
        return _searcher


def lookup(ip: str) -> Geo | None:
    """`ip` 须是 normalize_ip 的结果。IPv6、数据缺失、查询异常都返回 None。"""
    if ":" in ip:
        return None
    searcher = _get_searcher()
    if searcher is None:
        return None
    try:
        return parse_region(searcher.search(ip))
    except Exception:
        logger.warning("ip2region 查询失败: %s", ip, exc_info=True)
        return None
