"""平台设置存取：键值对落库 + 进程内缓存，未写入的键回落到代码默认值。

桥接程序每 1.5 秒轮询一次，每次都查设置表不划算——这里做一个 30 秒 TTL 的
进程内缓存；管理员保存设置时主动失效，改动最迟 30 秒内对桥接生效（单进程
部署下是立即生效，因为保存和失效发生在同一进程）。

Platform settings: key-value rows in the DB + an in-process cache; keys never
written fall back to the code defaults below.

The bridge polls every 1.5s, so hitting the settings table on every poll is
wasteful — reads go through a 30s-TTL in-process cache, invalidated on admin
save. Changes propagate to the bridge within 30s at worst (immediately on a
single-process deployment, since save and invalidation share the process).
"""
import json
import logging
import threading
import time

from app.models import PlatformSetting

logger = logging.getLogger("prismx.settings")

# 默认值：合作券商锁。数据库没有对应行时使用（也是全新部署的初始状态）。
# Defaults for the partner-broker lock, used when no DB row exists
# (i.e. the initial state of a fresh deployment).
BROKER_DEFAULTS: dict = {
    # 是否启用"仅限合作券商"限制 / whether the partner-broker-only lock is on
    "broker_lock_enabled": True,
    # MT5 服务器名匹配关键字（大小写不敏感的包含匹配，实盘/模拟一视同仁：
    # "MakeCapital" 同时命中 MakeCapital-Live 与 MakeCapital-Demo）。
    # Server-name match keywords (case-insensitive substring; live and demo
    # alike: "MakeCapital" hits both MakeCapital-Live and MakeCapital-Demo).
    "broker_patterns": ["MakeCapital"],
    # 对外显示名（绑定页提示等）/ display name shown in the UI
    "broker_display_name": "MakeCapital",
    # 开户推荐链接，空 = 不展示按钮 / referral URL; empty hides the button
    "broker_referral_url": "",
}

# 定价默认值。DB 无记录时使用，管理员在后台修改后写入 PlatformSetting。
# Pricing defaults. Used when no DB row exists; admin changes persist to PlatformSetting.
PRICING_DEFAULTS: dict = {
    "pro_monthly_price": 49.0,
    "pro_yearly_price": 470.0,
    "sale_enabled": False,
    "sale_percent": 0,
    "sale_badge": "",
    "sale_end_at": None,  # ISO 8601 string or null
}

# 免费试用默认值。DB 无记录时使用，管理员在后台修改后写入 PlatformSetting（key="trial"）。
# Free-trial defaults. Used when no DB row exists; admin changes persist to
# PlatformSetting (key="trial").
TRIAL_DEFAULTS: dict = {
    "trial_enabled": False,
    "trial_days": 7,
}

_CACHE_TTL_SECONDS = 30
_cache: dict = {}
_cache_at: float = 0.0
_lock = threading.Lock()


def invalidate_settings_cache() -> None:
    """管理员保存后调用，强制下次读取回源数据库。
    Called after an admin save so the next read hits the DB."""
    global _cache_at
    with _lock:
        _cache_at = 0.0


def _load_broker_from_db(db) -> dict:
    data = dict(BROKER_DEFAULTS)
    for row in db.query(PlatformSetting).all():
        if row.key not in BROKER_DEFAULTS:
            continue  # 未知键忽略，防脏数据 / ignore unknown keys
        try:
            data[row.key] = json.loads(row.value)
        except (ValueError, TypeError):
            logger.warning("platform_settings: invalid JSON for key %r, using default", row.key)
    return data


def _load_pricing_from_db(db) -> dict:
    """从 DB 读定价 JSON，缺失的 key 回落到默认值。"""
    data = dict(PRICING_DEFAULTS)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "pricing").first()
    if row:
        try:
            stored = json.loads(row.value)
            if isinstance(stored, dict):
                for k in PRICING_DEFAULTS:
                    if k in stored:
                        data[k] = stored[k]
        except (ValueError, TypeError):
            logger.warning("platform_settings: invalid JSON for pricing, using defaults")
    return data


def get_broker_settings(db) -> dict:
    """读取合作券商设置（带缓存）。调用方传入现成的 db session。
    Read partner-broker settings (cached). Caller supplies its db session."""
    global _cache, _cache_at
    now = time.time()
    with _lock:
        if _cache and now - _cache_at < _CACHE_TTL_SECONDS:
            return dict(_cache)
    data = _load_broker_from_db(db)
    with _lock:
        _cache = data
        _cache_at = now
    return dict(data)


# ---- 定价独立缓存（短 TTL，保证管理员改了后台几乎立即生效） ----
_pricing_cache: dict = {}
_pricing_cache_at: float = 0.0


def invalidate_pricing_cache() -> None:
    global _pricing_cache_at
    with _lock:
        _pricing_cache_at = 0.0


def get_pricing_settings(db) -> dict:
    """读取订阅定价设置（独立缓存，与券商设置分开）。
    Read subscription pricing settings (separate cache from broker settings)."""
    global _pricing_cache, _pricing_cache_at
    now = time.time()
    with _lock:
        if _pricing_cache and now - _pricing_cache_at < _CACHE_TTL_SECONDS:
            return dict(_pricing_cache)
    data = _load_pricing_from_db(db)
    with _lock:
        _pricing_cache = data
        _pricing_cache_at = now
    return dict(data)


def save_pricing_settings(db, data: dict) -> None:
    """写入定价设置（不提交，调用方 commit 后 invalidate）。
    Write pricing settings (no commit; caller commits then invalidates cache)."""
    merged = _load_pricing_from_db(db)
    merged.update(data)
    encoded = json.dumps(merged, ensure_ascii=False)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "pricing").first()
    if row is None:
        db.add(PlatformSetting(key="pricing", value=encoded))
    else:
        row.value = encoded


# ---- 免费试用独立缓存（与券商/定价设置分开） ----
_trial_cache: dict = {}
_trial_cache_at: float = 0.0


def invalidate_trial_cache() -> None:
    global _trial_cache_at
    with _lock:
        _trial_cache_at = 0.0


def _load_trial_from_db(db) -> dict:
    """从 DB 读试用设置 JSON，缺失的 key 回落到默认值。"""
    data = dict(TRIAL_DEFAULTS)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "trial").first()
    if row:
        try:
            stored = json.loads(row.value)
            if isinstance(stored, dict):
                for k in TRIAL_DEFAULTS:
                    if k in stored:
                        data[k] = stored[k]
        except (ValueError, TypeError):
            logger.warning("platform_settings: invalid JSON for trial, using defaults")
    return data


def get_trial_settings(db) -> dict:
    """读取免费试用设置（独立缓存）。
    Read free-trial settings (separate cache)."""
    global _trial_cache, _trial_cache_at
    now = time.time()
    with _lock:
        if _trial_cache and now - _trial_cache_at < _CACHE_TTL_SECONDS:
            return dict(_trial_cache)
    data = _load_trial_from_db(db)
    with _lock:
        _trial_cache = data
        _trial_cache_at = now
    return dict(data)


def save_trial_settings(db, data: dict) -> None:
    """写入免费试用设置（不提交，调用方 commit 后 invalidate）。
    Write free-trial settings (no commit; caller commits then invalidates cache)."""
    merged = _load_trial_from_db(db)
    merged.update(data)
    encoded = json.dumps(merged, ensure_ascii=False)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "trial").first()
    if row is None:
        db.add(PlatformSetting(key="trial", value=encoded))
    else:
        row.value = encoded


def set_setting(db, key: str, value) -> None:
    """写入单个设置项（不提交事务，调用方负责 commit 后再 invalidate）。
    Write one setting (no commit; caller commits, then invalidates the cache)."""
    row = db.query(PlatformSetting).filter(PlatformSetting.key == key).first()
    encoded = json.dumps(value, ensure_ascii=False)
    if row is None:
        db.add(PlatformSetting(key=key, value=encoded))
    else:
        row.value = encoded


def server_matches_broker(server: str | None, patterns: list) -> bool:
    """MT5 服务器名是否命中任一关键字（大小写不敏感的包含匹配）。
    服务器名缺失一律视为不匹配——无法验证来源就不放行。
    Whether the MT5 server name contains any keyword (case-insensitive).
    A missing server name never matches — unverifiable means rejected."""
    s = (server or "").strip().lower()
    if not s:
        return False
    return any(p.strip() and p.strip().lower() in s for p in (patterns or []))
