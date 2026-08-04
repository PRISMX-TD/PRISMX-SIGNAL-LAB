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


# ---- 纪律分参数独立缓存（与其它设置分开） ----
# 纪律分默认值。DB 无记录时使用，管理员在后台修改后写入 PlatformSetting（key="discipline"）。
# 三个权重之和不要求恰为 100，计算时按非 None 维度归一化（见 discipline.py）。
# Discipline-score defaults. Used when no DB row exists; admin changes persist
# to PlatformSetting (key="discipline"). The three weights need not sum to 100
# — they're normalized over non-None dimensions at scoring time.
DISCIPLINE_DEFAULTS: dict = {
    "window_days": 90,
    "weight_stop": 40,
    "weight_volume": 30,
    "weight_exit": 30,
    "sl_tolerance_pct": 0.10,
    "volume_multiple": 3.0,
    "volume_history_min": 5,
}

_discipline_cache: dict = {}
_discipline_cache_at: float = 0.0


def invalidate_discipline_cache() -> None:
    global _discipline_cache_at
    with _lock:
        _discipline_cache_at = 0.0


def _load_discipline_from_db(db) -> dict:
    """从 DB 读纪律分参数 JSON，缺失的 key 回落到默认值。"""
    data = dict(DISCIPLINE_DEFAULTS)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "discipline").first()
    if row:
        try:
            stored = json.loads(row.value)
            if isinstance(stored, dict):
                for k in DISCIPLINE_DEFAULTS:
                    if k in stored:
                        data[k] = stored[k]
        except (ValueError, TypeError):
            logger.warning("platform_settings: invalid JSON for discipline, using defaults")
    return data


def get_discipline_settings(db) -> dict:
    """读取纪律分参数设置（独立缓存）。
    Read discipline-score parameter settings (separate cache)."""
    global _discipline_cache, _discipline_cache_at
    now = time.time()
    with _lock:
        if _discipline_cache and now - _discipline_cache_at < _CACHE_TTL_SECONDS:
            return dict(_discipline_cache)
    data = _load_discipline_from_db(db)
    with _lock:
        _discipline_cache = data
        _discipline_cache_at = now
    return dict(data)


def save_discipline_settings(db, data: dict) -> None:
    """写入纪律分参数设置（不提交，调用方 commit 后 invalidate）。
    Write discipline-score settings (no commit; caller commits then invalidates cache)."""
    merged = _load_discipline_from_db(db)
    merged.update(data)
    encoded = json.dumps(merged, ensure_ascii=False)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "discipline").first()
    if row is None:
        db.add(PlatformSetting(key="discipline", value=encoded))
    else:
        row.value = encoded


CANDLE_DEFAULTS: dict = {
    "m1_retention_days": 30,
}

_candle_cache: dict = {}
_candle_cache_at: float = 0.0


def invalidate_candle_cache() -> None:
    global _candle_cache_at
    with _lock:
        _candle_cache_at = 0.0


def _load_candle_from_db(db) -> dict:
    data = dict(CANDLE_DEFAULTS)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "candle_history").first()
    if row:
        try:
            stored = json.loads(row.value)
            if isinstance(stored, dict):
                for k in CANDLE_DEFAULTS:
                    if k in stored:
                        data[k] = stored[k]
        except (ValueError, TypeError):
            logger.warning("platform_settings: invalid JSON for candle_history, using defaults")
    return data


def get_candle_settings(db) -> dict:
    """读取 K 线历史保留策略设置（独立缓存）。
    Read candle-history retention settings (separate cache)."""
    global _candle_cache, _candle_cache_at
    now = time.time()
    with _lock:
        if _candle_cache and now - _candle_cache_at < _CACHE_TTL_SECONDS:
            return dict(_candle_cache)
    data = _load_candle_from_db(db)
    with _lock:
        _candle_cache = data
        _candle_cache_at = now
    return dict(data)


def save_candle_settings(db, data: dict) -> None:
    merged = _load_candle_from_db(db)
    merged.update(data)
    encoded = json.dumps(merged, ensure_ascii=False)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "candle_history").first()
    if row is None:
        db.add(PlatformSetting(key="candle_history", value=encoded))
    else:
        row.value = encoded


STRATEGY_DEFAULTS: dict = {
    "max_strategies_per_user": 3,
    "pro_only": True,
}

_strategy_settings_cache: dict = {}
_strategy_settings_cache_at: float = 0.0


def invalidate_strategy_settings_cache() -> None:
    global _strategy_settings_cache_at
    with _lock:
        _strategy_settings_cache_at = 0.0


def _load_strategy_settings_from_db(db) -> dict:
    data = dict(STRATEGY_DEFAULTS)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "strategy").first()
    if row:
        try:
            stored = json.loads(row.value)
            if isinstance(stored, dict):
                for k in STRATEGY_DEFAULTS:
                    if k in stored:
                        data[k] = stored[k]
        except (ValueError, TypeError):
            logger.warning("platform_settings: invalid JSON for strategy, using defaults")
    return data


def get_strategy_settings(db) -> dict:
    """读取自定义策略平台参数（每用户策略数上限、是否 PRO 专属，独立缓存）。
    Read the custom-strategy platform settings (max strategies per user,
    PRO-exclusive flag; separate cache)."""
    global _strategy_settings_cache, _strategy_settings_cache_at
    now = time.time()
    with _lock:
        if _strategy_settings_cache and now - _strategy_settings_cache_at < _CACHE_TTL_SECONDS:
            return dict(_strategy_settings_cache)
    data = _load_strategy_settings_from_db(db)
    with _lock:
        _strategy_settings_cache = data
        _strategy_settings_cache_at = now
    return dict(data)


def save_strategy_settings(db, data: dict) -> None:
    merged = _load_strategy_settings_from_db(db)
    merged.update(data)
    encoded = json.dumps(merged, ensure_ascii=False)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "strategy").first()
    if row is None:
        db.add(PlatformSetting(key="strategy", value=encoded))
    else:
        row.value = encoded


# 交易成本默认值。点差/滑点为价格单位；手续费为「一手往返合计、折算到价格
# 单位」——回测在价格空间结算（见 strategy/backtest.py），不引入合约规模与
# 点值假设，故手续费必须与价格同量纲。per_symbol 为 品种 -> 覆盖项 的映射，
# 缺失的字段逐项回落到 default_*。
# Trading-cost defaults. Spread/slippage are in price units; commission is
# "per lot, round trip, expressed in price units" — the backtest settles in
# price space (see strategy/backtest.py) and deliberately assumes no contract
# size or point value, so commission has to share the price unit. per_symbol
# maps symbol -> overrides, each missing field falling back to its default_*.
STRATEGY_COST_DEFAULTS: dict = {
    "default_spread": 0.2,
    "default_commission_per_lot": 0.0,
    "default_slippage": 0.05,
    "per_symbol": {},
}

_strategy_costs_cache: dict = {}
_strategy_costs_cache_at: float = 0.0


def invalidate_strategy_costs_cache() -> None:
    global _strategy_costs_cache_at
    with _lock:
        _strategy_costs_cache_at = 0.0


def _load_strategy_costs_from_db(db) -> dict:
    data = dict(STRATEGY_COST_DEFAULTS)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "strategy_costs").first()
    if row:
        try:
            stored = json.loads(row.value)
            if isinstance(stored, dict):
                for k in STRATEGY_COST_DEFAULTS:
                    if k in stored:
                        data[k] = stored[k]
        except (ValueError, TypeError):
            logger.warning("platform_settings: invalid JSON for strategy_costs, using defaults")
    if not isinstance(data.get("per_symbol"), dict):
        data["per_symbol"] = {}
    return data


def get_strategy_costs(db) -> dict:
    """读取按品种的交易成本配置（独立缓存，与其他设置段互不影响）。
    Read the per-symbol trading-cost config (its own cache, independent of the
    other settings sections)."""
    global _strategy_costs_cache, _strategy_costs_cache_at
    now = time.time()
    with _lock:
        if _strategy_costs_cache and now - _strategy_costs_cache_at < _CACHE_TTL_SECONDS:
            return dict(_strategy_costs_cache)
    data = _load_strategy_costs_from_db(db)
    with _lock:
        _strategy_costs_cache = data
        _strategy_costs_cache_at = now
    return dict(data)


def save_strategy_costs(db, data: dict) -> None:
    merged = _load_strategy_costs_from_db(db)
    merged.update(data)
    encoded = json.dumps(merged, ensure_ascii=False)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "strategy_costs").first()
    if row is None:
        db.add(PlatformSetting(key="strategy_costs", value=encoded))
    else:
        row.value = encoded


# ---------- 行情品种配置 / market-feed symbol configuration ----------
#
# 网关（manager_feed）按这份配置决定推哪些品种。与其他设置节不同，这里存的是一个
# 列表而不是固定键的字典，所以不套用 *_DEFAULTS 的合并逻辑。
#
# display 是前端与数据库用的名字，broker 是向 MT5 Manager 查询用的真名（带券商后缀）。
# 两者分开是因为券商后缀（.s）属于接入细节，不该出现在用户界面和历史数据里。
#
# The gateway (manager_feed) uses this to decide which symbols to push. Unlike the other
# sections this stores a list rather than a fixed-key dict, so the *_DEFAULTS merge logic
# doesn't apply.
#
# `display` is the name used by the frontend and database; `broker` is the real name
# queried from MT5 Manager, including the broker suffix. They're separate because the
# suffix (.s) is a connectivity detail that shouldn't leak into the UI or stored history.
FEED_SYMBOL_DEFAULTS: list[dict] = [
    {"display": "XAUUSD", "broker": "XAUUSD.s", "enabled": True},
    {"display": "XAGUSD", "broker": "XAGUSD.s", "enabled": True},
    {"display": "WTI", "broker": "WTI.s", "enabled": True},
    {"display": "EURUSD", "broker": "EURUSD.s", "enabled": True},
    {"display": "GBPUSD", "broker": "GBPUSD.s", "enabled": True},
    {"display": "USDJPY", "broker": "USDJPY.s", "enabled": True},
    {"display": "BTCUSD", "broker": "BTCUSD.s", "enabled": True},
]

_feed_symbols_cache: list | None = None
_feed_symbols_cache_at: float = 0.0


def invalidate_feed_symbols_cache() -> None:
    global _feed_symbols_cache_at
    with _lock:
        _feed_symbols_cache_at = 0.0


def _load_feed_symbols_from_db(db) -> list[dict]:
    """从库里读品种配置，损坏或缺失时回落到默认值。
    Load the symbol config, falling back to defaults when missing or corrupt."""
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "feed_symbols").first()
    if row is None:
        return [dict(x) for x in FEED_SYMBOL_DEFAULTS]
    try:
        stored = json.loads(row.value)
    except (ValueError, TypeError):
        logger.warning("platform_settings: invalid JSON for feed_symbols, using defaults")
        return [dict(x) for x in FEED_SYMBOL_DEFAULTS]
    if not isinstance(stored, list):
        return [dict(x) for x in FEED_SYMBOL_DEFAULTS]

    out: list[dict] = []
    for item in stored:
        if not isinstance(item, dict):
            continue
        display = str(item.get("display", "")).strip().upper()
        broker = str(item.get("broker", "")).strip()
        if not display or not broker:
            continue
        out.append({
            "display": display,
            "broker": broker,
            "enabled": bool(item.get("enabled", True)),
        })
    # 存了一个空列表（或全是无效条目）时不回落默认值：管理员可能就是想全部停掉，
    # 静默塞回 7 个默认品种会让"清空"这个操作看起来失效。
    # An empty (or all-invalid) stored list is honoured rather than replaced: an admin
    # may genuinely want everything off, and silently restoring the 7 defaults would
    # make "clear all" look broken.
    return out


def get_feed_symbols(db) -> list[dict]:
    """读取行情品种配置（独立缓存）。
    Read the market-feed symbol config (its own cache)."""
    global _feed_symbols_cache, _feed_symbols_cache_at
    now = time.time()
    with _lock:
        if _feed_symbols_cache is not None and now - _feed_symbols_cache_at < _CACHE_TTL_SECONDS:
            return [dict(x) for x in _feed_symbols_cache]
    data = _load_feed_symbols_from_db(db)
    with _lock:
        _feed_symbols_cache = data
        _feed_symbols_cache_at = now
    return [dict(x) for x in data]


def save_feed_symbols(db, items: list[dict]) -> None:
    """整份替换品种配置。列表语义下没有"合并"可言，逐条覆盖才符合管理员的预期。
    Replace the whole symbol config; with list semantics a merge has no meaning and
    wholesale replacement is what an admin expects."""
    cleaned: list[dict] = []
    seen: set[str] = set()
    for item in items:
        display = str(item.get("display", "")).strip().upper()
        broker = str(item.get("broker", "")).strip()
        if not display or not broker or display in seen:
            continue
        seen.add(display)
        cleaned.append({
            "display": display,
            "broker": broker,
            "enabled": bool(item.get("enabled", True)),
        })

    encoded = json.dumps(cleaned, ensure_ascii=False)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "feed_symbols").first()
    if row is None:
        db.add(PlatformSetting(key="feed_symbols", value=encoded))
    else:
        row.value = encoded


# ---------- 券商可见品种清单 / broker symbol catalogue ----------
#
# 由网关上报。后端跑在 Linux 上、装不了 MT5Manager，拿不到券商的品种列表，只能由
# 运行在 Windows 上的网关提供，供后台配置页做下拉选择。
#
# Reported by the gateway. The backend runs on Linux where MT5Manager can't be installed,
# so it can't enumerate the broker's symbols itself; the Windows-side gateway supplies
# them for the admin page's dropdown.

def save_broker_symbol_catalogue(db, symbols: list[dict]) -> None:
    """保存券商品种清单（整份替换）。
    Save the broker symbol catalogue, replacing it wholesale."""
    encoded = json.dumps(symbols, ensure_ascii=False)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "broker_symbol_catalogue").first()
    if row is None:
        db.add(PlatformSetting(key="broker_symbol_catalogue", value=encoded))
    else:
        row.value = encoded


def get_broker_symbol_catalogue(db) -> list[dict]:
    """读取券商品种清单。网关还没上报过时返回空列表。

    不缓存：只有后台配置页会读它，频率极低，加一层缓存反而会让刚上报的清单显示不出来。

    Read the broker symbol catalogue; empty when the gateway hasn't reported yet.

    Uncached: only the admin page reads it, very rarely, and a cache would just delay
    a freshly reported catalogue from showing up.
    """
    row = db.query(PlatformSetting).filter(
        PlatformSetting.key == "broker_symbol_catalogue"
    ).first()
    if row is None:
        return []
    try:
        data = json.loads(row.value)
    except (ValueError, TypeError):
        logger.warning("platform_settings: invalid JSON for broker_symbol_catalogue")
        return []
    return data if isinstance(data, list) else []


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
