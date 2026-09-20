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
_lock = threading.Lock()


class _TtlCache:
    """一段设置的进程内 TTL 缓存。每个设置段（券商锁、定价、试用……）各持有一个实例。

    以前每段都是一份手抄的「模块级 `_xxx_cache` + `_xxx_cache_at` + `global` +
    `with _lock` + 比 TTL + `invalidate_xxx()`」——同一个模板抄了 12 遍，约 400 行。
    加第 13 段要照抄 5 处，而漏抄 `invalidate` **不报错**，只表现为「后台改了设置 30 秒
    不生效」，属于最难查的那种静默失败。收口成一个类之后，每段只剩一行声明。

    锁是模块级共享的：这些段的读写都是几十字节的字典拷贝，锁内不做 I/O，分段加锁
    没有可测量的收益。

    One settings section's in-process TTL cache; each section (broker lock, pricing,
    trial, …) owns one instance. Previously every section hand-copied the same
    "module-level `_xxx_cache` + `_xxx_cache_at` + `global` + lock + TTL compare +
    `invalidate_xxx()`" template — 12 copies, ~400 lines. Adding a 13th meant copying
    five places, and forgetting `invalidate` raised nothing: the only symptom was an
    admin change taking up to 30s to land. One class, one line per section.

    The lock is shared module-wide on purpose: reads and writes here are dict copies
    of a few dozen bytes with no I/O under the lock, so per-section locks would buy
    nothing measurable.
    """

    def __init__(self) -> None:
        self._data: dict = {}
        self._at: float = 0.0

    def get(self, db, loader) -> dict:
        """命中且未过期就回缓存，否则用 `loader(db)` 回源并刷新。返回的是缓存本体，
        调用方按需拷贝（各 get_* 都会 dict()/list() 一层再交出去）。
        Return the cached dict if fresh, else reload via `loader(db)`. Returns the
        cached object itself; callers copy as needed (every get_* does)."""
        now = time.time()
        with _lock:
            if self._data and now - self._at < _CACHE_TTL_SECONDS:
                return self._data
        data = loader(db)
        with _lock:
            self._data = data
            self._at = now
        return data

    def invalidate(self) -> None:
        """管理员保存后调用，强制下次读取回源数据库。
        Called after an admin save so the next read hits the DB."""
        with _lock:
            self._at = 0.0


def set_setting(db, key: str, value) -> None:
    """写入单个设置项（不提交事务，调用方负责 commit 后再 invalidate）。
    Write one setting (no commit; caller commits, then invalidates the cache)."""
    row = db.query(PlatformSetting).filter(PlatformSetting.key == key).first()
    encoded = json.dumps(value, ensure_ascii=False)
    if row is None:
        db.add(PlatformSetting(key=key, value=encoded))
    else:
        row.value = encoded


_cache = _TtlCache()


def invalidate_settings_cache() -> None:
    """管理员保存后调用，强制下次读取回源数据库。
    Called after an admin save so the next read hits the DB."""
    _cache.invalidate()


def _load_broker_from_db(db) -> dict:
    data = dict(BROKER_DEFAULTS)
    # 只取这几个键，不拉整表：platform_settings 同表里还存着 platform_strategies
    # （带图文的 JSON）、一次性邮箱名单、account_type 规则这些大值，而这里要的只有
    # 四个小键。这条路径挂在桥接 1.5 秒轮询后面，每 30 秒回源一次——整表拉回来
    # 再丢掉 99% 是纯白烧 Supabase 的出网流量（本项目对 Egress 敏感，见运维手册）。
    # Fetch only the keys we need instead of the whole table: platform_settings
    # also holds platform_strategies (JSON with rich text), the disposable-email
    # list and the account_type rules, while this function wants four small keys.
    # It sits behind the bridge's 1.5s poll and refetches every 30s, so pulling
    # everything and discarding 99% of it is pure wasted Supabase egress.
    rows = db.query(PlatformSetting).filter(PlatformSetting.key.in_(tuple(BROKER_DEFAULTS))).all()
    for row in rows:
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
    data = _cache.get(db, _load_broker_from_db)
    return dict(data)


# ---- 定价独立缓存（短 TTL，保证管理员改了后台几乎立即生效） ----
_pricing_cache = _TtlCache()


def invalidate_pricing_cache() -> None:
    _pricing_cache.invalidate()


def get_pricing_settings(db) -> dict:
    """读取订阅定价设置（独立缓存，与券商设置分开）。
    Read subscription pricing settings (separate cache from broker settings)."""
    data = _pricing_cache.get(db, _load_pricing_from_db)
    return dict(data)


def save_pricing_settings(db, data: dict) -> None:
    """写入定价设置（不提交，调用方 commit 后 invalidate）。
    Write pricing settings (no commit; caller commits then invalidates cache)."""
    merged = _load_pricing_from_db(db)
    merged.update(data)
    set_setting(db, "pricing", merged)


# ---- 免费试用独立缓存（与券商/定价设置分开） ----
_trial_cache = _TtlCache()


def invalidate_trial_cache() -> None:
    _trial_cache.invalidate()


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
    data = _trial_cache.get(db, _load_trial_from_db)
    return dict(data)


def save_trial_settings(db, data: dict) -> None:
    """写入免费试用设置（不提交，调用方 commit 后 invalidate）。
    Write free-trial settings (no commit; caller commits then invalidates cache)."""
    merged = _load_trial_from_db(db)
    merged.update(data)
    set_setting(db, "trial", merged)


CANDLE_DEFAULTS: dict = {
    "m1_retention_days": 30,
}

_candle_cache = _TtlCache()


def invalidate_candle_cache() -> None:
    _candle_cache.invalidate()


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
    data = _candle_cache.get(db, _load_candle_from_db)
    return dict(data)


def save_candle_settings(db, data: dict) -> None:
    merged = _load_candle_from_db(db)
    merged.update(data)
    set_setting(db, "candle_history", merged)


# 胜率对外公开设置。`public_strategies` 是**白名单**，存的是 signals.indicator 里的
# 原始策略名。
#
# 默认空列表 = 一个都不公开，用户端「策略分析」显示空态。这是刻意的：默认全公开会
# 让这个设置一上线就把所有策略（包括胜率 46% 的）推到所有用户面前，而公开与否是
# 有对外承诺含义的决定，必须由人主动做一次。
#
# 白名单**不只过滤列表，还改变分母**：用户端的时段胜率、品种胜率都只用白名单内策略
# 的信号计算（见 compute_strategy_session_winrate 的 only_strategies）。
#
# 名单里可能留着已停用、近 30 天没有信号的策略名——无害，设置页会如实显示"近 30 天
# 没有信号"，不静默丢弃：静默丢弃会让管理员以为自己没勾过。
#
# Win-rate publication settings. `public_strategies` is a **whitelist** of raw
# strategy names as they appear in signals.indicator.
#
# The default is an empty list — nothing published, and the user-facing page shows
# its empty state. Deliberate: defaulting to "publish everything" would push every
# strategy (including the 46% ones) at every user the moment this ships, and
# publishing win rates carries a promise to users, so a human has to opt in once.
#
# The whitelist does not merely filter a list — **it changes the denominator**:
# session and symbol win rates on the user-facing page are computed from
# whitelisted strategies only (see only_strategies in
# compute_strategy_session_winrate).
#
# The list may retain names of retired strategies with no recent signals. That is
# harmless and the settings page says so explicitly rather than dropping them
# silently, which would read to an admin as "I never ticked that".
WINRATE_DEFAULTS: dict = {
    "public_strategies": [],
}

_winrate_settings_cache = _TtlCache()


def invalidate_winrate_settings_cache() -> None:
    _winrate_settings_cache.invalidate()


def _load_winrate_settings_from_db(db) -> dict:
    data = dict(WINRATE_DEFAULTS)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "winrate").first()
    if row:
        try:
            stored = json.loads(row.value)
            if isinstance(stored, dict):
                for k in WINRATE_DEFAULTS:
                    if k in stored:
                        data[k] = stored[k]
        except (ValueError, TypeError):
            logger.warning("platform_settings: invalid JSON for winrate, using defaults")
    # 存坏了也不能让公开名单变成"全部"：类型不对一律退回空名单（不公开），
    # 宁可少给也不多给。
    # A corrupt value must never widen the whitelist: anything but a list of
    # strings falls back to publishing nothing.
    names = data.get("public_strategies")
    if not isinstance(names, list):
        data["public_strategies"] = []
    else:
        data["public_strategies"] = [n for n in names if isinstance(n, str)]
    return data


def get_winrate_settings(db) -> dict:
    """读取胜率对外公开设置（独立缓存）。
    Read the win-rate publication settings (its own cache)."""
    data = _winrate_settings_cache.get(db, _load_winrate_settings_from_db)
    return {"public_strategies": list(data["public_strategies"])}


def save_winrate_settings(db, data: dict) -> None:
    merged = _load_winrate_settings_from_db(db)
    merged.update(data)
    set_setting(db, "winrate", merged)


STRATEGY_DEFAULTS: dict = {
    "max_strategies_per_user": 3,
    "pro_only": True,
}

_strategy_settings_cache = _TtlCache()


def invalidate_strategy_settings_cache() -> None:
    _strategy_settings_cache.invalidate()


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
    data = _strategy_settings_cache.get(db, _load_strategy_settings_from_db)
    return dict(data)


def save_strategy_settings(db, data: dict) -> None:
    merged = _load_strategy_settings_from_db(db)
    merged.update(data)
    set_setting(db, "strategy", merged)


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

_strategy_costs_cache = _TtlCache()


def invalidate_strategy_costs_cache() -> None:
    _strategy_costs_cache.invalidate()


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
    data = _strategy_costs_cache.get(db, _load_strategy_costs_from_db)
    return dict(data)


def save_strategy_costs(db, data: dict) -> None:
    merged = _load_strategy_costs_from_db(db)
    merged.update(data)
    set_setting(db, "strategy_costs", merged)




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

_platform_strategies_cache = _TtlCache()


def invalidate_platform_strategies_cache() -> None:
    _platform_strategies_cache.invalidate()


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
    data = _platform_strategies_cache.get(db, _load_platform_strategies_from_db)
    return {"items": list(data["items"])}


def save_platform_strategies(db, items: list) -> None:
    """整表覆盖保存：管理员编辑的是完整清单（含排序），逐项 merge 无意义。
    Whole-list replace: the admin edits the complete ordered list, so merging
    item by item would be meaningless."""
    set_setting(db, "platform_strategies", {"items": items})


# ---------- 官方社交主页 / official social links ----------
#
# 五个官方账号地址。空字符串 = 这个平台我们还没有（或不想露出），前端按
# "填了才显示"渲染，不会留一个点不开的图标。默认全空：新部署在管理员填之前
# 一个社交入口都不会出现。
# Five official account URLs. An empty string means "we have no such account
# (or don't want it shown)" — the UI renders on a filled-means-shown basis
# rather than leaving a dead icon. All empty by default, so a fresh deployment
# shows no social entry point until an admin fills one in.
SOCIAL_DEFAULTS: dict = {
    "facebook_url": "",
    "instagram_url": "",
    "x_url": "",
    "discord_url": "",
    "telegram_url": "",
}

_social_cache = _TtlCache()


def invalidate_social_cache() -> None:
    _social_cache.invalidate()


def _load_social_from_db(db) -> dict:
    """读社交主页 JSON；非字符串或非 http(s) 的值一律丢弃回落到空。

    这些值最终会变成页面上的 href，所以读的时候再过一遍协议白名单，而不是
    只信写入时的校验——写入路径不止管理端一条（运维直接改库、旧数据、将来
    的导入脚本），而 `javascript:` 开头的一行就够在页脚上挂一个脚本执行点。
    往严格的方向兜底：不认识的值当作没填。

    Read the social-links JSON; any non-string or non-http(s) value is dropped
    back to empty. These end up as hrefs on the page, so the scheme allowlist is
    re-applied on read rather than trusting write-time validation alone — the
    write path is not only the admin panel (direct DB edits, old rows, future
    import scripts), and one `javascript:` value would hang a script-execution
    point off the footer. Fail closed: anything unrecognised counts as unset.
    """
    data = dict(SOCIAL_DEFAULTS)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "social").first()
    if row:
        try:
            stored = json.loads(row.value)
            if isinstance(stored, dict):
                for k in SOCIAL_DEFAULTS:
                    if k in stored:
                        data[k] = stored[k]
        except (ValueError, TypeError):
            logger.warning("platform_settings: invalid JSON for social, using defaults")
    for k in SOCIAL_DEFAULTS:
        v = data.get(k)
        if not isinstance(v, str):
            data[k] = ""
            continue
        v = v.strip()
        low = v.lower()
        data[k] = v if (low.startswith("http://") or low.startswith("https://")) else ""
    return data


def get_social_settings(db) -> dict:
    """读取官方社交主页地址（独立缓存）。
    Read the official social links (its own cache)."""
    data = _social_cache.get(db, _load_social_from_db)
    return dict(data)


def save_social_settings(db, data: dict) -> None:
    """写入官方社交主页地址（不提交，调用方 commit 后 invalidate）。
    Write the social links (no commit; caller commits then invalidates)."""
    merged = _load_social_from_db(db)
    merged.update(data)
    set_setting(db, "social", merged)


def server_matches_broker(server: str | None, patterns: list) -> bool:
    """MT5 服务器名是否命中任一关键字（大小写不敏感的包含匹配）。
    服务器名缺失一律视为不匹配——无法验证来源就不放行。
    Whether the MT5 server name contains any keyword (case-insensitive).
    A missing server name never matches — unverifiable means rejected."""
    s = (server or "").strip().lower()
    if not s:
        return False
    return any(p.strip() and p.strip().lower() in s for p in (patterns or []))


# 账户类型判定：把 MT5 组名映射成实盘/竞赛/模拟。默认值按 MT5 的通行命名惯例
# 给出，覆盖常规情况；券商命名不守惯例时，运维改这一行设置即可，不用改代码、
# 也不用动 Windows 上的 C# 网关（组名本来就已经传到后端了）。
#
# 判定逻辑与"为什么只能靠组名"见 services/account_type.py。**匹配不上的一律
# 判未知（NULL），不猜**——猜错的方向是把模拟盘记成实盘，代价远大于漏算一个
# 账号；补进前缀后下一轮刷新会自动纠正。
#
# Group-name -> account type mapping, defaulted to MT5's usual naming
# convention. Ops can adjust it without touching code or redeploying the
# Windows gateway (the group name already reaches the backend). Anything that
# matches nothing stays unknown rather than being guessed — see account_type.py.
ACCOUNT_TYPE_DEFAULTS: dict = {
    # 真仓组白名单。**是两个具体组，不是 MCSA 这个宽前缀**——合作券商
    # (Make Capital) 专门为本平台开了这两个组，只有被加进这两个组的账号才
    # 连得上 gateway；MCSA 下的其他子组不属于本平台的真仓接入。
    #
    # 写宽前缀 "MCSA" 会把将来券商在同一实体下新开的任何子组（包括他们自己的
    # 测试组）一并判成实盘，方向正好是最危险的那个——把非真仓算成真仓会污染
    # 整个战绩体系。宁可新开真仓组时改一次配置。
    #
    # Live-account whitelist: two specific groups the partner broker opened for
    # this platform, not the broad "MCSA" prefix. Only accounts placed in these
    # can link to the gateway. A broad prefix would sweep in any future sibling
    # group (including the broker's own test groups) as live — the dangerous
    # direction. Adding a group here on the day a new one opens is the cheaper
    # trade.
    "real_group_prefixes": [
        r"MCSA\I-STD-SLAB-USD",
        r"MCSA\I-PLUS-SLAB-USD",
    ],
    "contest_group_prefixes": [],
    # 已知的模拟组命名。**没列到的组不会被当成实盘**（判为未知、排除在实盘统计
    # 外，并打一条 warning），所以这份表不求穷尽——它的作用是把常见模拟组明确
    # 标出来，让"未知"这个信号留给真正没见过的组名，运维一看日志就知道券商那边
    # 新开了组。
    # Known demo namings. Anything unlisted is classified unknown (excluded from
    # live stats, with a warning) rather than live, so this list needn't be
    # exhaustive — it exists so the "unknown" signal stays meaningful.
    "demo_group_prefixes": ["demo", "preliminary"],
    # 服务器名白名单：桥接通道的兜底判据，只用于账号没有组名（老版本桥接客户端
    # 不上报 tradeMode，且桥接载荷本身不含 MT5 组名）的情况——见
    # services/account_type.py 的 classify_server/classify_account。
    #
    # 这张表只做精确匹配，且**只能列"确认整台服务器都是实盘"的服务器名**。
    # `MakeCapital-Live` 原来在这张表里，2026-09-03 被移除——券商确认那台
    # MT5 服务器同时跑模拟和实盘，靠登录号段区分（见下面 server_login_rules），
    # 整台服务器判实盘的前提不成立。生产上账号 100016（模拟、余额刚好
    # 10000.00）就是这条错规则的受害者：单纯因为服务器名命中白名单被判成
    # REAL，这正是本模块 docstring 开头点名要避免的方向。已知的另一个反例：
    # `HolaPrime-Server1` 同样实盘与模拟混跑（2026-09-03 与券商确认）。
    # 这张表现在留给真正把 demo/live 分到不同服务器的券商用。
    #
    # Server-name whitelist: the bridge channel's fallback, used only when an
    # account has no group name (an older bridge client that never reports
    # tradeMode, and the bridge payload itself carries no MT5 group) — see
    # classify_server/classify_account in services/account_type.py.
    #
    # Exact match only, and only ever list a server confirmed to be **entirely**
    # live. `MakeCapital-Live` used to be here and was removed 2026-09-03: the
    # broker confirmed that MT5 server hosts both demo and live accounts, told
    # apart by login prefix (see server_login_rules below), so the whole-server
    # premise was false. In production, account 100016 (demo, balance exactly
    # 10000.00) was misclassified REAL purely by this whitelist match — exactly
    # the failure direction this module's docstring warns against. Known
    # counter-example: HolaPrime-Server1 also mixes live and demo accounts
    # (confirmed with the broker 2026-09-03). This list now exists only for
    # brokers that genuinely segregate demo/live onto separate servers.
    "real_server_names": [],
    "contest_server_names": [],
    "demo_server_names": [],
    # 服务器名子串（小写比较）命中即判模拟，压过桥接自报的实盘——见
    # services/account_type.py 的 classify_server。只往安全方向猜，所以允许子串。
    # Server-name substrings that force demo, outranking the bridge's self-reported
    # real flag (see classify_server). Substring match is allowed here because it
    # only ever guesses in the safe direction.
    "demo_server_keywords": ["demo"],
    # 服务器 + 登录号段规则：一台 MT5 服务器混跑模拟与实盘时，靠券商自己的
    # 登录号编号习惯区分（不是猜的，是跟券商确认过的）——见
    # services/account_type.py 的 classify_login/classify_account。
    #
    # Make Capital 已确认（2026-09-03）：`MakeCapital-Live` 一台服务器同时开
    # 模拟和实盘账户，登录号 `1` 开头是模拟、`6` 开头是实盘。没列在这里的号段
    # （比如 `9` 开头）一律判未知，**排除在实盘统计外**——这是有意的：往
    # "模拟记成实盘"这个方向猜，代价远大于漏算一个账号；等券商确认了具体
    # 号段再补进配置，下一轮回填自动纠正。
    #
    # Server + login-prefix rules: when one MT5 server mixes demo and live
    # accounts, the broker's own login-numbering convention tells them apart
    # (confirmed with the broker, not guessed) — see classify_login/
    # classify_account in services/account_type.py.
    #
    # Make Capital confirmed (2026-09-03): MakeCapital-Live hosts both account
    # types on one server, logins starting with 1 are demo, 6 are live. Prefixes
    # not listed here (e.g. 9) classify as unknown and are deliberately excluded
    # from live statistics — guessing in the "demo counted as live" direction
    # poisons every statistic; the next backfill self-corrects once the broker
    # confirms the missing prefix and it's added here.
    "server_login_rules": [
        {
            # Make Capital 一台 MT5 服务器同时跑模拟与实盘（2026-09-03 与券商
            # 确认），只能靠登录号段区分：**6 开头是实盘，其余一律模拟**。
            # 用 `default` 而不是把 1/9/... 逐个列出来，是因为这才是券商给的
            # 原话——列举号段的写法会在券商新开一个号段时把它判成"未知"，而
            # 事实上那也该是模拟。`default` 只接受 demo/contest（见
            # account_type._DEFAULT_MODES），兜底判实盘是被禁止的。
            # One MT5 server hosting both demo and live accounts (confirmed with
            # the broker 2026-09-03), told apart only by login prefix: 6… is
            # live, everything else is demo. Expressed as a `default` rather
            # than enumerating ranges because that is literally what the broker
            # said — enumerating would leave any newly-opened range as
            # "unknown" when it should be demo. A `default` may never be "real".
            "server": "MakeCapital-Live",
            "real_login_prefixes": ["6"],
            "demo_login_prefixes": [],
            "contest_login_prefixes": [],
            "default": "demo",
        },
    ],
}

_account_type_cache = _TtlCache()


def invalidate_account_type_cache() -> None:
    _account_type_cache.invalidate()


def _load_account_type_from_db(db) -> dict:
    data = dict(ACCOUNT_TYPE_DEFAULTS)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "account_type").first()
    if row:
        try:
            stored = json.loads(row.value)
            if isinstance(stored, dict):
                for k in ACCOUNT_TYPE_DEFAULTS:
                    if isinstance(stored.get(k), list):
                        data[k] = stored[k]
        except (ValueError, TypeError):
            logger.warning("platform_settings: invalid JSON for account_type, using defaults")
    return data


def get_account_type_settings(db) -> dict:
    """读取组名 -> 账户类型的前缀映射（独立缓存）。
    Read the group-prefix -> account-type mapping (its own cache)."""
    data = _account_type_cache.get(db, _load_account_type_from_db)
    return dict(data)


def save_account_type_settings(db, data: dict) -> None:
    merged = _load_account_type_from_db(db)
    merged.update(data)
    set_setting(db, "account_type", merged)
    invalidate_account_type_cache()


# ---- 游戏化设置独立缓存（与其它设置分开） ----
# min_trades_return / min_trades_winrate：两块榜的入榜笔数门槛，内测期改松、
# 生产期改严，用同一套设置机制。默认值就是原来硬编码的数字，含义不变：
#   ≥5（收益榜）——挡掉"一笔运气单就冲上榜"，一笔交易不足以定义一个收益率；
#   ≥20（胜率榜）——挡掉"4 笔打 3 中=75%"这种小样本胜率冲上榜首。
# 内测期这两个数字定得太严，平台刚跑起来根本没人凑得够笔数，导致榜单永远
# 空、功能形同没上线；开放给管理员调整后，内测可以先调到 1 观察效果，正式
# 面向用户前记得调回默认值。
#
# min_trades_return / min_trades_winrate: the trade-count gate for each board.
# Loose during the admin beta, strict in production, both via this same
# settings mechanism. Defaults equal the numbers that used to be hardcoded,
# same meaning:
#   >=5 (return board) — stops a single lucky trade from defining a return
#   figure;
#   >=20 (win-rate board) — stops a small sample like "3 wins out of 4 = 75%"
#   from topping the win-rate board.
# During the beta these were too strict for the low trading volume to ever
# populate a board, making the feature unobservable. Now admin-adjustable —
# loosen to 1 to observe during beta, remember to restore the defaults before
# opening the boards to real users.
GAMIFICATION_DEFAULTS: dict = {
    "user_visible": False,
    "leaderboard_visible": False,
    "competitions_visible": False,
    "min_baseline_usd": 500.0,
    "min_trades_return": 5,
    "min_trades_winrate": 20,
    # 胜率榜是否要求本期盈亏为正才能上榜。设计上这是条原则（高胜率 ≠ 赚钱），
    # 一度写死在 boards.py 里；2026-09-04 应产品要求改成可配开关，默认关闭。
    # 想把它作为公开时的准入条件，在管理端「游戏化」页签打开即可，不用改代码。
    # Whether the win-rate board requires the period P&L to be positive. This is a
    # principle by design (a high win rate is not the same as making money) and was
    # hardcoded in boards.py until 2026-09-04, when the product owner asked for it to
    # be configurable; default off. Turn it back on from the admin Gamification tab
    # before going public — no code change needed.
    "winrate_require_profit": False,
}

_gamification_cache = _TtlCache()


def invalidate_gamification_cache() -> None:
    _gamification_cache.invalidate()


def _load_gamification_from_db(db) -> dict:
    """从 DB 读游戏化设置 JSON，缺失的 key 回落到默认值。
    按默认值的类型收敛每个键：布尔键只认真正的 JSON 布尔，整数键用 int()，浮点键
    用 float()——任何键的坏值（类型不对或无法转换）一律回退默认，宁缺勿错，不让
    一个脏值把整组设置读挂，也不让它把开关读反。
    ⚠ isinstance(True, int) 为 True，所以 bool 分支必须排在 int 分支前面；
    int 分支同样要像 float 分支那样显式拦一次 bool，否则 JSON 里的 true 会
    被 int() 悄悄变成 1。"""
    data = dict(GAMIFICATION_DEFAULTS)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "gamification").first()
    if row:
        try:
            stored = json.loads(row.value)
            if isinstance(stored, dict):
                for k, default in GAMIFICATION_DEFAULTS.items():
                    if k not in stored:
                        continue
                    if isinstance(default, bool):
                        # 只接受真正的 JSON 布尔，其余一律回退默认——与数值键同款
                        # "坏值宁缺勿错"。原来用 bool() 收敛，而 bool("false") 是
                        # True：手改库或旧数据把开关写成字符串 "false" 时，读出来
                        # 反而是"开"。这些开关控制的是游戏化内容对用户可见不可见，
                        # 错的方向恰好是往"更公开"走，属于最不该猜的一类。
                        # Only a real JSON boolean is accepted; anything else falls
                        # back to the default, matching the numeric keys' "a bad
                        # value is worse than no value". The old bool() coercion
                        # made bool("false") True, so a hand-edited or legacy row
                        # storing the string "false" read back as *on* — and these
                        # switches govern whether gamification is visible to users,
                        # so the wrong guess leans towards more exposure.
                        data[k] = stored[k] if isinstance(stored[k], bool) else default
                    elif isinstance(default, int):
                        if isinstance(stored[k], bool):
                            data[k] = default   # bool 冒充数值：int(True)==1 会悄悄改值，必须先拦
                        else:
                            try:
                                parsed = int(stored[k])
                                # 目前所有整数键都是入榜笔数门槛，语义上不允许 <1；
                                # 负数/零一律当坏值处理，回退默认。
                                # Every int key today is a trade-count gate, which
                                # is meaningless below 1; treat negative/zero as a
                                # bad value and fall back to the default too.
                                data[k] = parsed if parsed >= 1 else default
                            except (TypeError, ValueError):
                                data[k] = default   # 坏值回退默认，宁缺勿错
                    elif isinstance(default, float):
                        if isinstance(stored[k], bool):
                            data[k] = default   # bool 冒充数值：float(True)==1.0 会悄悄改值，必须先拦
                        else:
                            try:
                                data[k] = float(stored[k])
                            except (TypeError, ValueError):
                                data[k] = default   # 坏值回退默认，宁缺勿错
        except (ValueError, TypeError):
            logger.warning("platform_settings: invalid JSON for gamification, using defaults")
    return data


def get_gamification_settings(db) -> dict:
    """读取游戏化设置（独立缓存）。
    Read gamification settings (separate cache)."""
    data = _gamification_cache.get(db, _load_gamification_from_db)
    return dict(data)


def save_gamification_settings(db, data: dict) -> None:
    """写入游戏化设置（不提交，调用方 commit 后 invalidate）。
    Write gamification settings (no commit; caller commits then invalidates cache)."""
    merged = _load_gamification_from_db(db)
    merged.update(data)
    set_setting(db, "gamification", merged)


# 一次性邮箱闸门默认值。DB 无记录时使用，管理员在后台修改后写入
# PlatformSetting（key="email_gate"）。
#
# 默认开启（disposable_block_enabled=True）：这是产品决定的"硬拒"，新部署
# 就该是拦着的。真出了误伤，后台把开关关掉比发一次版快得多——这也是它做成
# 设置项而不是常量的全部理由。
#
# 两个增补名单都默认为空：内置放行表（email_domains.ALLOW_DOMAINS）和打包
# 快照已经覆盖了绝大多数情况，空列表意味着"没人手工干预过"，排查时一眼能看出
# 当前行为完全来自代码，而不是某次后台误操作。
#
# Disposable-email gate defaults (PlatformSetting key="email_gate"). Blocking is
# on by default — the product decision is a hard reject. Both supplementary lists
# start empty so that an empty value provably means "nobody has hand-tuned this",
# which makes incidents far easier to reason about.
EMAIL_GATE_DEFAULTS: dict = {
    "disposable_block_enabled": True,
    "extra_blocked_domains": [],
    "extra_allowed_domains": [],
}

_email_gate_cache = _TtlCache()


def invalidate_email_gate_cache() -> None:
    _email_gate_cache.invalidate()


def _load_email_gate_from_db(db) -> dict:
    """从 DB 读一次性邮箱闸门设置，缺失的 key 回落到默认值。"""
    data = dict(EMAIL_GATE_DEFAULTS)
    row = db.query(PlatformSetting).filter(PlatformSetting.key == "email_gate").first()
    if row:
        try:
            stored = json.loads(row.value)
            if isinstance(stored, dict):
                for k in EMAIL_GATE_DEFAULTS:
                    if k in stored:
                        data[k] = stored[k]
        except (ValueError, TypeError):
            logger.warning("platform_settings: invalid JSON for email_gate, using defaults")
    # 两个名单在别处会被当序列遍历；存坏了（比如手改数据库写成字符串）不能
    # 让调用方拿到一个会把每个字符当域名的 str。
    # Both lists are iterated by callers; a hand-edited string in the DB must not
    # reach them as a str whose characters would each read as a domain.
    for k in ("extra_blocked_domains", "extra_allowed_domains"):
        if not isinstance(data[k], list):
            logger.warning("platform_settings: email_gate.%s is not a list, using []", k)
            data[k] = []
    return data


def get_email_gate_settings(db) -> dict:
    """读取一次性邮箱闸门设置（独立缓存）。
    Read the disposable-email gate settings (separate cache)."""
    data = _email_gate_cache.get(db, _load_email_gate_from_db)
    return dict(data)


def save_email_gate_settings(db, data: dict) -> None:
    """写入一次性邮箱闸门设置（不提交，调用方 commit 后 invalidate）。
    Write the disposable-email gate settings (no commit; caller commits then
    invalidates cache)."""
    merged = _load_email_gate_from_db(db)
    merged.update(data)
    set_setting(db, "email_gate", merged)
