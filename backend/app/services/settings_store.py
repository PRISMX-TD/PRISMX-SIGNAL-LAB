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




# 平台策略介绍：纯内容数据，由管理员在后台手工维护。
#
# 为什么不从代码枚举：生产环境的全站信号来自 TradingView Webhook
# （routers/webhook.py），判定逻辑在平台外部，后端只拿到一个自由文本的
# indicator 字段，无从知道"平台上共有哪些策略"。所以这份清单只能是人工声明的
# 内容，与信号表没有外键关系。
#
# 刻意不含胜率/盈亏比等业绩数字：真实战绩由 signals 表的 result 字段判定
# （services/signal_resolution.py），那才是唯一可验证的来源；在这里手填一组
# 数字只会和它冲突。本结构只描述策略的设计特征。
#
# Platform strategy write-ups: pure content, maintained by admins by hand.
#
# Why not enumerated from code: in production every shared signal arrives via
# the TradingView webhook (routers/webhook.py), the decision logic lives
# outside the platform, and the backend only receives a free-text indicator
# string — it cannot know "which strategies exist". So this list can only be a
# human-authored document with no foreign key to the signals table.
#
# Deliberately carries no win-rate / profit-factor figures: real performance is
# adjudicated by the signals table's result column
# (services/signal_resolution.py), the only verifiable source; hand-entered
# numbers here would merely contradict it. This structure describes design
# characteristics only.
PLATFORM_STRATEGY_DEFAULTS: dict = {
    "items": [],
}

_platform_strategies_cache: dict = {}
_platform_strategies_cache_at: float = 0.0


def invalidate_platform_strategies_cache() -> None:
    global _platform_strategies_cache_at
    with _lock:
        _platform_strategies_cache_at = 0.0


def _load_platform_strategies_from_db(db) -> dict:
    data = {"items": []}
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "platform_strategies").first()
    if row:
        try:
            stored = json.loads(row.value)
            if isinstance(stored, dict) and isinstance(stored.get("items"), list):
                data["items"] = stored["items"]
        except (ValueError, TypeError):
            logger.warning("platform_settings: invalid JSON for platform_strategies, using defaults")
    return data


def get_platform_strategies(db) -> dict:
    """读取平台策略介绍清单（独立缓存）。
    Read the platform strategy write-ups (its own cache)."""
    global _platform_strategies_cache, _platform_strategies_cache_at
    now = time.time()
    with _lock:
        if _platform_strategies_cache and now - _platform_strategies_cache_at < _CACHE_TTL_SECONDS:
            return {"items": list(_platform_strategies_cache["items"])}
    data = _load_platform_strategies_from_db(db)
    with _lock:
        _platform_strategies_cache = data
        _platform_strategies_cache_at = now
    return {"items": list(data["items"])}


def save_platform_strategies(db, items: list) -> None:
    """整表覆盖保存：管理员编辑的是完整清单（含排序），逐项 merge 无意义。
    Whole-list replace: the admin edits the complete ordered list, so merging
    item by item would be meaningless."""
    encoded = json.dumps({"items": items}, ensure_ascii=False)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "platform_strategies").first()
    if row is None:
        db.add(PlatformSetting(key="platform_strategies", value=encoded))
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
