"""MT5 终端操作 / MT5 terminal operations.

同一进程内通过 mt5.initialize(path=...) 逐个连接不同终端，串行轮询。
Within one process, attach to each terminal via mt5.initialize(path=...)
and poll them serially. This avoids the multiprocessing pitfalls of a
PyInstaller onefile build.

连接复用：MetaTrader5 库同一进程同一时刻只能附着一个终端。单终端（最常见）
场景下保持连接不再每次轮询 initialize/shutdown；多终端场景切换时才重连。
Connection reuse: the MetaTrader5 package attaches to one terminal at a time
per process. With a single terminal (the common case) the attachment is kept
across polls instead of initialize/shutdown on every tick; with multiple
terminals we only reconnect when switching.
"""
import logging
import math
import time
from datetime import datetime, timedelta, timezone

# 复用 bridge_app.py 里已经配置好 handler 的同名 logger，直接写进
# ~/.prismx_bridge.log，不需要重新配置。
# Reuse the same-named logger bridge_app.py already attached a handler to —
# writes straight into ~/.prismx_bridge.log, no reconfiguration needed here.
logger = logging.getLogger("prismx_bridge")

try:
    import MetaTrader5 as mt5
    _IMPORT_ERROR = None
except Exception as _e:  # pragma: no cover - 仅 Windows 有该包 / Windows-only package
    mt5 = None
    _IMPORT_ERROR = repr(_e)


# 当前附着的终端路径；None 表示未附着 / currently attached terminal path
_attached_path: str | None = None


def _ensure_attached(path: str) -> bool:
    """确保当前进程附着到指定终端；已附着同一终端则直接复用。
    Ensure this process is attached to the given terminal, reusing the
    existing attachment when the path matches.

    附着失效（终端被关闭等）时自动断开重连；切换终端时先 shutdown 再 initialize。
    A dead attachment (terminal closed etc.) is detected and re-established;
    switching terminals does a clean shutdown + initialize.
    """
    global _attached_path
    if _attached_path == path:
        try:
            # terminal_info() 存活即连接有效（未登录账号时 account_info 为 None，
            # 但连接本身仍可用）/ terminal_info() alive means the link is healthy
            if mt5.terminal_info() is not None:
                return True
        except Exception:
            pass
    if _attached_path is not None:
        try:
            mt5.shutdown()
        except Exception:
            pass
        _attached_path = None
    # 加 timeout 防止误连到异常终端时无限阻塞（单位毫秒）。
    # Add timeout (ms) so a bad terminal cannot block the worker indefinitely.
    if not mt5.initialize(path=path, timeout=10000):
        return False
    _attached_path = path
    return True


# 本平台下单一律打这个魔术号码，用来在 MT5 成交历史里认出"哪些仓位是我们开的"
# （个人胜率统计用，见 _closed_trades_payload）。
# Every order this platform places carries this magic number, used to identify
# "which positions did we open" in MT5's deal history (for personal win-rate
# stats; see _closed_trades_payload).
PRISMX_MAGIC = 778899


def _current_login() -> str | None:
    """当前附着终端的账号 login，取不到则 None / current terminal's account login, or None."""
    try:
        info = mt5.account_info()
        return str(info.login) if info else None
    except Exception:
        return None


# 常见基础品种，用于探测券商后缀 / common base symbols to probe broker suffix
_SUFFIX_PROBE = ["EURUSD", "XAUUSD", "GBPUSD", "USDJPY", "BTCUSD"]

# 网页报价区展示的品种（与前端关注列表对齐）/ symbols shown in the web quote panel
QUOTE_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "XAGUSD", "BTCUSD", "USDJPY", "EURGBP"]

# 后缀最长按这个截；与后端 SUFFIX_PATTERN 的 10 位上限一致，免得把某个碰巧
# 以探测名开头的长品种名当成"后缀"。
# Max suffix length considered, matching the backend's SUFFIX_PATTERN cap, so a
# long unrelated name can't masquerade as a suffix of a probe base.
_MAX_SUFFIX_LEN = 10

# 后缀分隔符：Make Capital 用 "."（BTCUSD.s / BTCUSD.p），别家也见过 "-" 和 "_"。
# Suffix separators seen in the wild.
_SUFFIX_SEPARATORS = "._-"

# 同一品种在两侧的不同写法。与 EA 的 GetAliasCandidates、后端的
# symbol_aliases 覆盖同一批品种，三处各自维护（职责不同，见后端那份的说明）。
# Alternate spellings of one instrument. Same instruments as the EA's
# GetAliasCandidates and the backend's symbol_aliases, maintained separately in
# all three places (different jobs — see the note in the backend's copy).
_ALIAS_GROUPS: tuple[frozenset[str], ...] = (
    frozenset({"BTCUSD", "BTCUSDT"}),
    frozenset({"WTI", "USOIL", "XTIUSD", "WTICOUSD", "CL"}),
)
_ALIAS_BY_NAME: dict[str, frozenset[str]] = {
    name: group for group in _ALIAS_GROUPS for name in group
}

# 券商品种表缓存：(缓存键, 过期时刻, 名字列表)。品种表每轮询（1.5 秒）都要用，
# 但一天也变不了一次，没必要每次都向终端要一遍。
# Broker symbol-table cache: (key, expiry, names). The table is needed on every
# 1.5s poll but changes at most once in a blue moon.
_SYMBOLS_CACHE_TTL = 60.0
_symbols_cache: tuple[str, float, list[str]] | None = None
# 解析结果缓存（同一账号下"请求名+后缀 -> 券商真名"），随品种表一起失效。
# Resolution cache, invalidated together with the symbol table.
_resolved_cache: dict[tuple[str, str, str], str] = {}
# 解析失败的负缓存：键 -> 在这个时刻之前不必再为它强刷品种表。报价那 7 个品种
# 每 1.5 秒解析一次，只要券商少了其中一个（比如没有 XAGUSD），没有这层负缓存
# 就会每轮都白白重取一遍整张品种表。
# Negative cache for failed resolutions: key -> don't force another table fetch
# before this moment. The seven quote-panel symbols resolve every 1.5s, so a
# broker missing just one of them (no XAGUSD, say) would otherwise re-fetch the
# entire symbol table on every single poll.
_unresolved_until: dict[tuple[str, str, str], float] = {}


def _cache_key() -> str:
    """缓存按"终端路径 + 登录号"分桶：换账号可能换组，组不同后缀就不同。
    Cache is per terminal path + login: a different account may sit in a
    different group, and the group decides the suffix."""
    return f"{_attached_path}|{_current_login()}"


def _broker_symbol_names(force: bool = False) -> list[str]:
    """当前账号可见的全部券商品种名（带缓存）。
    Every broker symbol name visible to the current account (cached)."""
    global _symbols_cache
    key = _cache_key()
    now = time.monotonic()
    if not force and _symbols_cache is not None:
        cached_key, expires, cached_names = _symbols_cache
        if cached_key == key and expires > now:
            return cached_names
    try:
        symbols = mt5.symbols_get()
    except Exception:
        symbols = None
    names = [s.name for s in symbols] if symbols else []
    if names:
        # 取到了才落缓存：空结果多半是终端一时不可用，缓存下来会把后续
        # 每一次解析都饿死 60 秒。
        # Only cache a non-empty result: an empty one usually means the terminal
        # was momentarily unavailable, and caching it would starve resolution.
        _symbols_cache = (key, now + _SYMBOLS_CACHE_TTL, names)
        _resolved_cache.clear()
        _unresolved_until.clear()
    return names


def detect_suffix(names, probes=None) -> str:
    """从品种表里推断该账号的品种后缀（如 .s / .p / .sc）。

    **按覆盖率选，不是撞见第一个就返回**——这是修掉的原始 bug。Make Capital 的
    品种表里 `EURUSD` 与 `EURUSD.s` 同时存在（裸名对该组不可交易），而黄金、
    加密只有 `.s` 一种写法。旧实现拿探测列表第一个 `EURUSD` 精确撞上裸名就
    断定"无后缀"，于是 `XAUUSD`、`BTCUSD` 全查不到——报价空着，下单直接失败。

    改成对每个候选后缀统计"探测列表里有多少个基础品种存在这个写法"：
    ""=3（EURUSD/GBPUSD/USDJPY），".s"=5（全中），选 .s。并列时取更短的，
    所以真的没有后缀的券商仍然稳稳返回 ""。

    Infer this account's symbol suffix from the broker's table.

    Chosen by coverage rather than first hit — that first-hit rule was the bug.
    Make Capital lists both `EURUSD` and `EURUSD.s` (the bare name isn't
    tradable for the group) while gold and crypto exist only as `.s`. The old
    code hit the bare `EURUSD` first, concluded "no suffix", and then found
    neither `XAUUSD` nor `BTCUSD` — blank quotes and failing orders.

    Now each candidate suffix scores the number of probe bases that exist with
    it: "" scores 3 (EURUSD/GBPUSD/USDJPY), ".s" scores 5, so .s wins. Ties go
    to the shorter suffix, so a broker that genuinely has none still gets "".
    """
    probe_list = [p.upper() for p in (probes or _SUFFIX_PROBE)]
    # 比较一律按大写，但返回的后缀保留券商原本的大小写：这个值会上报给服务端
    # 存成账号后缀、再拼进下单指令，而 MT5 的品种名是区分大小写的。
    # Compare upper-cased but return the broker's own casing: this value is
    # reported to the server, stored as the account's suffix and concatenated
    # into order commands, and MT5 symbol names are case-sensitive.
    originals: dict[str, str] = {}
    for name in names or []:
        originals.setdefault(name.upper(), name)
    if not originals:
        return ""
    candidates: dict[str, str] = {"": ""}
    for base in probe_list:
        for upper, original in originals.items():
            if upper.startswith(base) and 0 < len(upper) - len(base) <= _MAX_SUFFIX_LEN:
                candidates.setdefault(upper[len(base):], original[len(base):])
    scored = [
        (sum(1 for base in probe_list if base + sfx in originals), sfx, original)
        for sfx, original in candidates.items()
    ]
    # 覆盖多者优先，其次短者优先（""排最前），最后按字典序保证结果确定。
    # Most coverage first, then shortest ("" first), then lexicographic so the
    # result is deterministic.
    count, _sfx, suffix = max(
        scored, key=lambda it: (it[0], -len(it[1]), [-ord(c) for c in it[1]])
    )
    return suffix if count > 0 else ""


def _detect_suffix() -> str:
    """探测当前账号的券商品种后缀 / detect the current account's symbol suffix."""
    return detect_suffix(_broker_symbol_names())


def _alias_candidates(base: str) -> list[str]:
    """一个基础名在券商那边可能叫的全部名字，原名排第一。

    表外的加密品种走通用规则：TradingView 的加密警报一律以 USDT 计价
    （BTCUSDT/ETHUSDT/XRPUSDT），券商的加密 CFD 一律是 …USD——去掉尾巴那个 T
    就行，不必逐个币种登记。

    Every name the broker might use for a base symbol, itself first. Crypto
    outside the table falls back to a general rule: TradingView's crypto alerts
    are USDT-quoted while broker CFDs are …USD, so dropping the trailing T
    covers every coin without enumerating them.
    """
    base = base.upper()
    out = [base]
    for name in sorted(_ALIAS_BY_NAME.get(base, frozenset())):
        if name not in out:
            out.append(name)
    if len(base) > 4 and base.endswith("USDT"):
        alt = base[:-1]
        if alt not in out:
            out.append(alt)
    return out


def _split_suffix(name: str, suffix: str) -> tuple[str, str]:
    """把"名字+后缀"拆成两截：先按已知后缀削，削不掉再按分隔符切。
    Split a name into (base, suffix): strip the known suffix if it matches,
    otherwise cut at the first separator."""
    upper = (name or "").strip().upper()
    known = (suffix or "").strip().upper()
    if known and upper.endswith(known) and len(upper) > len(known):
        return upper[: -len(known)], known
    for i, ch in enumerate(upper):
        if ch in _SUFFIX_SEPARATORS:
            return upper[:i], upper[i:]
    return upper, ""


def broker_symbol_candidates(requested: str, suffix: str, names) -> list[str]:
    """把指令里的品种名解析成该券商品种表里真实存在的名字，按优先级排序。

    只返回品种表里真有的名字（大小写以券商为准），所以调用方拿到的每一项都
    至少"存在"；能不能交易由调用方再看 trade_mode。顺序：别名候选 × 后缀候选
    （本账号的组后缀 → 请求里自带的后缀 → 无后缀 → 品种表里该基础名实际出现
    过的其它后缀，短的优先），最后才是原样请求的名字。

    "原样"排最后而不是最前，是因为它可能是个**裸名**：Make Capital 的外汇主流
    对裸名与 .s 名同时在表里，裸名对 STD 组只读（券商把它归在 *no trade* 组）。
    带组后缀的那个才是该账号真正能交易的。

    Resolve a commanded symbol against the broker's real table, best first.
    Only names that actually exist are returned (in the broker's own casing);
    whether they're tradable is the caller's next check. Order: alias candidates
    crossed with suffix candidates (this account's group suffix, the one carried
    in the request, none, then any other suffix this base is actually listed
    with, shortest first), and the requested name as-is only at the end.

    As-is comes last rather than first because it may be a *bare* name: Make
    Capital lists the major FX pairs both bare and as .s, and the bare one is
    read-only for the STD group (the broker files it under *no trade*). The
    group-suffixed name is the one this account can actually trade.
    """
    by_upper: dict[str, str] = {}
    for name in names or []:
        by_upper.setdefault(name.upper(), name)
    out: list[str] = []

    def push(candidate: str) -> None:
        real = by_upper.get(candidate.upper())
        if real and real not in out:
            out.append(real)

    requested = (requested or "").strip()
    if not requested:
        return out
    base, request_suffix = _split_suffix(requested, suffix)
    for candidate in _alias_candidates(base):
        listed = sorted(
            {
                name[len(candidate):]
                for name in by_upper
                if name.startswith(candidate)
                and 0 < len(name) - len(candidate) <= _MAX_SUFFIX_LEN
            },
            key=lambda s: (len(s), s),
        )
        for sfx in [(suffix or "").strip(), request_suffix, ""] + listed:
            push(candidate + sfx)
    push(requested)
    return out


def _resolve_broker_symbol(requested: str, suffix: str = "") -> str | None:
    """解析成该券商真实可交易的品种名；一个都不存在时返回 None。

    比特币是这里的典型：信号侧是 `BTCUSDT`，Make Capital 的品种表里只有
    `BTCUSD.s`（STD 组）/`BTCUSD.p`（PLUS 组），两侧对不上，此前每一单都被
    "Symbol not available" 挡下。

    可交易优先：品种在表里存在不等于该组能交易它（Make Capital 的裸 `EURUSD`
    对 STD 组就是只读的），所以 trade_mode 被禁的候选只留作兜底，先继续往下找。

    Resolve to a symbol this broker can actually trade, or None if no candidate
    exists at all. Bitcoin is the canonical case: signals carry `BTCUSDT` while
    the broker lists only `BTCUSD.s` (STD group) / `BTCUSD.p` (PLUS group), and
    every order was rejected with "Symbol not available".

    Tradable candidates win: existing in the table doesn't mean the group can
    trade it (Make Capital's bare `EURUSD` is read-only for STD), so a
    trade-disabled candidate is kept only as a last resort.
    """
    key = (_cache_key(), (requested or "").strip().upper(), (suffix or "").strip().upper())
    cached = _resolved_cache.get(key)
    if cached:
        return cached
    fallback = None
    now = time.monotonic()
    # 第二轮强制刷新品种表：券商刚上架的品种、或账号刚换组时，缓存里可能一个
    # 候选都没有，不刷新就会被一份过期缓存永久挡死。刚刚为同一个名字白刷过的
    # 话就跳过这一轮（负缓存），别让"券商没有这个品种"变成每轮一次全表重取。
    # The second pass forces a table refresh: right after the broker lists a new
    # symbol (or the account changes group) the cache may hold no candidate at
    # all, and without the refresh a stale cache would block orders for good.
    # Skipped when the same name came up empty moments ago (negative cache), so
    # "this broker doesn't offer it" doesn't cost a full table fetch per poll.
    passes = (False,) if _unresolved_until.get(key, 0.0) > now else (False, True)
    for refresh in passes:
        names = _broker_symbol_names(force=refresh)
        candidates = broker_symbol_candidates(requested, suffix, names) or [requested]
        for candidate in candidates:
            if not mt5.symbol_select(candidate, True):
                continue
            info = mt5.symbol_info(candidate)
            if info is None:
                continue
            disabled = getattr(mt5, "SYMBOL_TRADE_MODE_DISABLED", 0)
            if getattr(info, "trade_mode", disabled) == disabled:
                if fallback is None:
                    fallback = candidate
                continue
            _resolved_cache[key] = candidate
            if candidate.upper() != (requested or "").strip().upper():
                logger.info("品种名解析 / symbol resolved: %s -> %s", requested, candidate)
            return candidate
        if fallback is not None:
            break
    if fallback is None:
        _unresolved_until[key] = time.monotonic() + _SYMBOLS_CACHE_TTL
    else:
        # 走到这里说明：品种确实存在，但对这个账号所在的组是**不可交易**的
        # （trade_mode = DISABLED，常见于只读组、或该品种只对部分组开放）。
        # 仍然把它返回，让下单请求发出去、由券商给出权威的拒绝理由；但要在日志里
        # 点明真正的原因，否则用户只看到一句笼统的「下单被拒绝 (#xxxx)」，而排查
        # 方向完全不同——不是价格不对、不是手数不对，是这个账号根本不能交易它。
        # The symbol exists but is non-tradable for this account's group (read-only
        # group, or listed only for some groups). It is still returned so the broker
        # gives the authoritative rejection, but the real reason goes in the log:
        # otherwise the user sees a generic "order rejected (#xxxx)" and looks at
        # price and volume, when the account simply cannot trade this symbol.
        logger.warning(
            "品种 %s 对本账号所在组不可交易（trade_mode=disabled），下单大概率会被拒 / "
            "%s is not tradable for this account's group; the order will likely be rejected",
            fallback, fallback,
        )
    return fallback


# 允许的滑点，按**价格的相对比例**表示，而不是写死的 points 数。
#
# 为什么不能写死：`deviation` 的单位是 point（1/10^digits），所以同一个 20 在不同
# 品种上是完全不同的量——5 位的欧美是 2 个点（约 0.02%），2 位的黄金是 0.20 美元
# （约 0.006%），后者在行情快时太紧、会换来一串 REQUOTE/PRICE_CHANGED 拒单。
#
# 0.02% 这个取值是照着"维持外汇上的现有行为"定的：EURUSD ≈ 1.08 时算出来正好约 20
# points，与改动前一致；同样的比例放到黄金 3350 上是约 0.67 美元，比典型点差
# （0.2~0.5）宽一档，属于合理放行而不是放任。
#
# Slippage allowance expressed as a fraction of price rather than a fixed point
# count. `deviation` is denominated in points (1/10^digits), so one constant means
# wildly different tolerances per instrument: 20 is ~2 pips on 5-digit FX (~0.02%)
# but only $0.20 on 2-digit gold (~0.006%), which is too tight in fast markets and
# buys a stream of requote rejections. The 0.02% figure is chosen to reproduce
# today's behaviour on FX (EURUSD ≈ 1.08 → ~20 points) while giving gold ~$0.67,
# one notch wider than a typical spread.
_DEVIATION_FRACTION = 0.0002
_DEVIATION_MIN_POINTS = 10
_DEVIATION_MAX_POINTS = 300


def _alternate_filling(symbol: str, current):
    """挑一个该品种支持、且与当前不同的成交模式；没有就返回 None。

    `symbol_info.filling_mode` 是位掩码（SYMBOL_FILLING_FOK / SYMBOL_FILLING_IOC），
    与 order_send 要的 ORDER_FILLING_* 常量不是同一套值，所以要按位判断再映射。
    RETURN 不在候选里：它对市价单的语义是"没成交的部分挂着"，与本平台"要么按市价
    成交要么不成交"的模型不符。

    Pick a filling mode this symbol supports and that differs from the current one.
    filling_mode is a bitmask (SYMBOL_FILLING_*) distinct from the ORDER_FILLING_*
    constants order_send wants, so it is tested bitwise and then mapped. RETURN is
    excluded: leaving an unfilled remainder resting contradicts this platform's
    market-or-nothing model.
    """
    if mt5 is None:
        return None
    info = mt5.symbol_info(symbol)
    mask = getattr(info, "filling_mode", 0) if info is not None else 0
    options = []
    # SYMBOL_FILLING_FOK / SYMBOL_FILLING_IOC **在 MetaTrader5 这个 Python 包里并不存在**
    # （实测：`getattr(mt5, "SYMBOL_FILLING_FOK", None)` 是 None），只有 MQL5 那边有。
    # 所以这两个位掩码值只能按 MQL5 的定义硬写：FOK = 1、IOC = 2。
    # 不要改成 `getattr(mt5, "SYMBOL_FILLING_FOK", 1)` 那种写法——那看起来像「包里有就用包里的」，
    # 实际永远走默认值，反而掩盖了「这是硬编码的协议常量」这件事。
    #
    # 而 ORDER_FILLING_FOK / ORDER_FILLING_IOC 确实存在（0 / 1），照常从包里读。
    # 注意这两套值不是一回事：位掩码用来问「这个品种支持哪些模式」，ORDER_FILLING_* 才是
    # 下单请求里填的值。
    #
    # SYMBOL_FILLING_FOK / SYMBOL_FILLING_IOC do NOT exist in the MetaTrader5 Python
    # package (verified) — they are MQL5-side names — so the bitmask values are written
    # out per the MQL5 definition. ORDER_FILLING_* do exist and are read from the module.
    # The two sets are different things: the mask answers "which modes does this symbol
    # support", ORDER_FILLING_* is what goes into the request.
    SYMBOL_FILLING_FOK = 1
    SYMBOL_FILLING_IOC = 2
    if mask & SYMBOL_FILLING_FOK:
        options.append(getattr(mt5, "ORDER_FILLING_FOK", None))
    if mask & SYMBOL_FILLING_IOC:
        options.append(getattr(mt5, "ORDER_FILLING_IOC", None))
    for opt in options:
        if opt is not None and opt != current:
            return opt
    return None


def _deviation_points(symbol: str, price: float) -> int:
    """按品种精度把「相对滑点容忍度」折算成 MT5 要的 point 数。
    Convert the relative slippage tolerance into the point count MT5 expects."""
    info = mt5.symbol_info(symbol) if mt5 is not None else None
    point = getattr(info, "point", 0.0) if info is not None else 0.0
    if not point or not price or price <= 0:
        return 20  # 拿不到精度时退回原来的固定值 / fall back to the previous constant
    pts = int(price * _DEVIATION_FRACTION / point)
    return max(_DEVIATION_MIN_POINTS, min(_DEVIATION_MAX_POINTS, pts))


def _normalize_volume(symbol: str, volume: float) -> float:
    """把手数规整到券商步长与上下限 / clamp volume to broker step & limits.

    注意这个函数会**静默改变**用户要求的手数（步长对齐、夹到上下限）。调用方有义务
    把规整后的值放进回执的 `volume` 字段，让网页显示真正成交的手数，而不是让用户
    以为按自己填的数成交了——0.005 手被抬成 0.01 手是"仓位大了一倍"，不是四舍五入。

    This silently changes the requested size (step alignment, min/max clamping), so
    callers must report the returned value back in the receipt's `volume` field. A
    0.005 request becoming 0.01 is a doubled position, not a rounding detail.
    """
    info = mt5.symbol_info(symbol)
    if info is None:
        return volume
    step = info.volume_step or 0.01
    vmin = info.volume_min or step
    vmax = info.volume_max or volume
    # 用 floor(x/step + 0.5) 而不是内建 round()：Python 的 round() 是银行家舍入
    # （round(2.5) == 2），于是 0.025 手在 0.01 步长下会变成 0.02 而不是直觉上的
    # 0.03。手数是用户直接看得见的数字，按直觉的四舍五入走。
    # floor(x/step + 0.5) rather than round(): Python rounds half to even, so 0.025
    # on a 0.01 step became 0.02 instead of the expected 0.03. Lot size is a number
    # the user reads directly, so use the rounding they expect.
    v = math.floor(volume / step + 0.5) * step
    if v < vmin:
        v = vmin
    if v > vmax:
        v = vmax
    # 按步长小数位规整，避免浮点误差 / round to step precision to avoid float noise
    decimals = max(0, len(str(step).split(".")[-1])) if "." in str(step) else 0
    return round(v, decimals)


def _compute_stops(symbol: str, side: str, entry: float, sig_sl: float, sig_tp: float):
    """把 SL/TP 换算到真实市价并夹紧最小止损距离。
    Rescale SL/TP onto the live price and clamp to the broker stop level.

    entry > 0（信号下单）：信号价是平台合成价，直接用会触发 Invalid stops，
    因此用相对 entry 的比例套到真实市价上。
    entry <= 0（图表页手动下单，无关联信号）：sig_sl/sig_tp 本身就是用户对着
    实时报价/图表价填的真实绝对价格，不需要也不能再按比例换算——此前这里对
    entry<=0 直接返回 (0, 0)，导致手动下单的止损止盈被静默丢弃，用户以为带
    了止损、实际在 MT5 里是一张裸单。
    entry > 0 (signal order): the signal price is synthetic; using it directly
    would trigger Invalid Stops, so rescale it as a ratio onto the live price.
    entry <= 0 (manual order from the charts page, no signal): sig_sl/sig_tp
    are already real absolute prices the user typed against the live quote/
    chart price, so they must be used as-is. This used to return (0, 0) for
    entry<=0, silently dropping the SL/TP on manual orders — the user thought
    they had a stop-loss but the MT5 fill was actually a bare position.
    """
    out_sl = 0.0
    out_tp = 0.0
    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if info is None or tick is None:
        return out_sl, out_tp
    point = info.point or 0.0
    digits = info.digits or 5
    price = tick.ask if side == "BUY" else tick.bid
    if price <= 0:
        return out_sl, out_tp

    if entry > 0:
        if sig_sl > 0:
            out_sl = price * (sig_sl / entry)
        if sig_tp > 0:
            out_tp = price * (sig_tp / entry)
    else:
        if sig_sl > 0:
            out_sl = sig_sl
        if sig_tp > 0:
            out_tp = sig_tp

    stops_level = getattr(info, "trade_stops_level", 0) or 0
    min_dist = (stops_level if stops_level > 0 else 10) * point

    if side == "BUY":
        if out_sl > 0 and price - out_sl < min_dist:
            out_sl = price - min_dist
        if out_tp > 0 and out_tp - price < min_dist:
            out_tp = price + min_dist
    else:
        if out_sl > 0 and out_sl - price < min_dist:
            out_sl = price + min_dist
        if out_tp > 0 and price - out_tp < min_dist:
            out_tp = price - min_dist

    if out_sl > 0:
        out_sl = round(out_sl, digits)
    if out_tp > 0:
        out_tp = round(out_tp, digits)
    return out_sl, out_tp


def _account_payload(suffix: str) -> dict | None:
    """读取当前终端的账号信息 / read the current terminal's account info."""
    info = mt5.account_info()
    if info is None:
        return None
    return {
        "login": str(info.login),
        "server": info.server,
        "accountName": info.name,
        "accountCurrency": info.currency,
        "balance": float(info.balance),
        "equity": float(info.equity),
        # 已用保证金。网页端拿它和净值算保证金比例（MT5 终端里的「预付款比例」）。
        # 不自己算比例：空仓时 margin=0，除法在这里算就得先编一个"无穷大/0"的约定，
        # 交给展示侧按 null 处理更干净。
        # Margin in use; the web app derives the margin level from it and equity.
        # The ratio is deliberately not computed here — margin is 0 when flat and
        # the division would need an invented sentinel.
        "margin": float(info.margin),
        "leverage": int(info.leverage),
        "company": info.company,
        "detectedSuffix": suffix,
        # 账户类型：0=模拟 1=竞赛 2=实盘。MT5 自己给的值，用户在终端里改不了；
        # 但它毕竟经由本机程序上报，服务端把它当作可信度较低的一路来源
        # （另一路是 gateway 直接向券商取组名）。取不到时报 None，服务端不覆盖。
        # Account type from MT5 (ACCOUNT_TRADE_MODE). Reported as None when the
        # attribute is unavailable, in which case the server keeps its existing value.
        "tradeMode": int(getattr(info, "trade_mode", None)) if getattr(info, "trade_mode", None) is not None else None,
    }


def _symbol_spec(info) -> dict:
    """券商对该品种的真实合约规格，随报价一起上报给网页端算风险金额 / 按风险%建议手数。

    以前网页端按一张写死的合约规模表估算（黄金 100 / 白银 5000 / BTC 1 …），
    但各券商规格不同（合作券商 ETHUSD 每手 10 而不是 1、WTI 每手 100 而不是
    1000），用户换一家券商表就错了、且错得悄无声息。终端里 symbol_info 给的
    就是这家券商的真实值：

    - contractSize：每手标的数量（trade_contract_size）。
    - tickSize / tickValue：最小变动价位及其对应的**亏损方向**盈亏（以账户货币计，
      trade_tick_value_loss）。风险金额 = 手数 × (止损距离 ÷ tickSize) × tickValue，
      这是 MT5 自己算盈亏的公式，对外汇直盘 / 交叉盘 / 贵金属 / 加密 / 指数一律
      成立，也顺带解决了 EURGBP 这类交叉盘网页端"无法换算成美元"的问题。取亏损
      方向而不是盈利方向，是因为止损本来就是亏损那一侧，两者相差一个换算点差。

    读不到（None / 0）就不带字段，网页端退回旧的估算表，不会算出 0 手。

    The broker's real contract spec for this symbol, sent alongside the quote so
    the web app can size risk from actual numbers instead of a hard-coded table
    (which was wrong for e.g. ETHUSD=10 and WTI=100 at the partner broker).
    tickValue is the *loss-side* per-tick value in the deposit currency
    (trade_tick_value_loss) — a stop-loss is the losing side by definition.
    Missing / zero values omit the keys so the web app falls back to its table.
    """
    if info is None:
        return {}
    spec: dict = {}
    size = float(getattr(info, "trade_contract_size", 0) or 0)
    if size > 0:
        spec["contractSize"] = size
    tick_size = float(getattr(info, "trade_tick_size", 0) or 0)
    tick_value = float(getattr(info, "trade_tick_value_loss", 0) or 0) \
        or float(getattr(info, "trade_tick_value", 0) or 0)
    if tick_size > 0 and tick_value > 0:
        spec["tickSize"] = tick_size
        spec["tickValue"] = tick_value
    return spec


def _quotes_payload(base_symbols: list[str], suffix: str = "") -> list:
    """采集品种的 bid/ask 报价 / collect bid/ask quotes for symbols.

    用券商真实品种名向 MT5 查询，但上报基础品种名，便于网页匹配。名字解析交给
    _resolve_broker_symbol：直接拼后缀在 Make Capital 这类券商上会漏掉黄金和
    加密（它们只有 .s/.p 写法，而后缀一旦探测成空就全查不到）。
    Query MT5 with the broker's real symbol name but report the base symbol so
    the web app can match regardless of broker naming. Resolution goes through
    _resolve_broker_symbol: plain concatenation loses gold and crypto at brokers
    like Make Capital, where those exist only in .s/.p form and an empty
    detected suffix finds neither.
    """
    out = []
    meta: list[tuple[str, str, int, dict]] = []
    for base in base_symbols or []:
        broker_sym = _resolve_broker_symbol(base, suffix)
        if not broker_sym:
            continue
        if not mt5.symbol_select(broker_sym, True):
            continue
        # 交易商的小数位数，按其严格四舍五入，消除浮点残差（如 1.32386999…）。
        # Broker's decimal digits; round strictly to remove float noise.
        info = mt5.symbol_info(broker_sym)
        digits = int(info.digits) if info is not None else 5
        spec = _symbol_spec(info)
        # 品种已解析、已选入行情窗口：不管这一刻有没有报价都记进元数据，
        # 报价线程下一拍可能就读得到（刚开盘、刚补上报价的那一刻）。
        # Resolved and selected: record it whether or not it has a quote this very
        # moment — the quote thread may well read one on its next pass.
        meta.append((base, broker_sym, digits, spec))
        tick = mt5.symbol_info_tick(broker_sym)
        if tick is None or tick.bid <= 0 or tick.ask <= 0:
            continue
        entry = {
            "symbol": base,
            "bid": round(float(tick.bid), digits),
            "ask": round(float(tick.ask), digits),
            "digits": digits,
        }
        # 券商真实合约规格（见 _symbol_spec）/ broker's real contract spec
        entry.update(spec)
        out.append(entry)
    # 留给报价线程（read_live_quotes）用的元数据：品种名解析、小数位、合约规格都在
    # 这里（状态循环里）算好，报价线程只管读 tick，锁内的活越短越好。
    # Metadata for the quote thread (read_live_quotes): resolution, digits and the
    # contract spec are worked out here, on the status loop, so the quote thread only
    # has to read ticks and its time under the MT5 lock stays short.
    if _attached_path is not None:
        _live_quote_meta[_attached_path] = {"login": _current_login(), "symbols": meta}
    return out


# 终端路径 -> {"login": 登录号, "symbols": [(基础名, 券商真名, 小数位, 合约规格), ...]}。
# 由 _quotes_payload 每拍刷新，read_live_quotes 只读它。
# terminal path -> {"login", "symbols": [(base, broker name, digits, spec), ...]},
# refreshed by _quotes_payload every status tick and only read by read_live_quotes.
_live_quote_meta: dict[str, dict] = {}


def read_live_quotes(path: str) -> list | None:
    """报价线程专用：只在**当前已附着**的终端上读一遍关注品种的最新 tick。

    与 `read_positions` 这类函数的关键区别：这里**绝不调用 `_ensure_attached`**。
    多终端时切换附着是 shutdown + initialize（最长 10 秒超时），那是状态循环与指令
    循环的事；报价线程要是也能触发切换，就会和它们抢着把连接切来切去。所以当前附着
    的不是 `path`、或者还没有元数据（状态循环还没跑完第一拍），一律返回 None，调用方
    什么都不发，由状态循环的原路径兜底。

    锁内只做 1 次 account_info（确认账号没换）+ 每品种 1 次 symbol_info_tick。品种名
    解析、小数位、合约规格用的是状态循环算好的元数据（见 `_quotes_payload`）。
    返回的每条已带 login，格式与状态循环上报的那份一致。

    Quote-thread only: read the watched symbols' latest ticks on the terminal that is
    *already* attached. Unlike read_positions this never calls _ensure_attached —
    switching terminals (shutdown + initialize, up to a 10s timeout) belongs to the
    status and command loops, and a quote thread able to trigger it would fight them
    over the connection. Not attached to `path`, or no metadata yet: None, and the
    caller sends nothing. Under the lock: one account_info plus one symbol_info_tick
    per symbol; resolution, digits and spec come from _quotes_payload's metadata.
    """
    if mt5 is None or _attached_path != path:
        return None
    meta = _live_quote_meta.get(path)
    if not meta:
        return None
    login = _current_login()
    # 终端里换了账号（或掉线）：元数据里的品种名与规格可能已不适用，等状态循环刷新。
    # Account switched (or dropped) in the terminal: wait for the status loop to refresh.
    if not login or login != meta.get("login"):
        return None
    out = []
    for base, broker_sym, digits, spec in meta.get("symbols") or []:
        try:
            tick = mt5.symbol_info_tick(broker_sym)
        except Exception:
            continue
        if tick is None or tick.bid <= 0 or tick.ask <= 0:
            continue
        entry = {
            "symbol": base,
            "bid": round(float(tick.bid), digits),
            "ask": round(float(tick.ask), digits),
            "digits": digits,
            "login": login,
        }
        entry.update(spec)
        out.append(entry)
    return out


def _positions_payload() -> list:
    """读取持仓 / read open positions.

    只上报本平台开的仓位（魔术号匹配 PRISMX_MAGIC）：网页只管理它自己开出的
    仓，用户在 MT5 客户端手动开的仓不会出现在这里、也就不会被网页误平——
    与自动仓位管理、平仓成交明细统计（两者均已只认魔术号）口径保持一致。
    此前这里上报账户下的全部持仓，与文档承诺的"只管平台开的仓"及自动仓管
    的管辖范围不一致，也让用户可能通过网页误平自己手动开的仓。

    除基础字段外，补充 ticket（平仓/改单定位用）、入场价、现价、SL/TP，
    便于网页展示与执行平仓/改 SL·TP。

    Only report positions this platform opened (magic number matches
    PRISMX_MAGIC): the web app only manages positions it opened itself, so a
    position the user opened manually in the MT5 client never shows up here
    and can't be accidentally closed from the web — consistent with auto
    position management and the closed-trade stats, both of which already key
    off the magic number alone. This used to report every open position on
    the account, which didn't match the documented "only manages positions
    this platform opened" scope and let a user accidentally close a manually
    opened position from the web app.

    Besides the basics, include ticket (needed to close/modify), entry price,
    current price and SL/TP so the web app can display and act on positions.
    """
    positions = mt5.positions_get()
    if not positions:
        return []
    info = mt5.account_info()
    login = str(info.login) if info else None
    out = []
    for p in positions:
        if getattr(p, "magic", 0) != PRISMX_MAGIC:
            continue
        out.append({
            "ticket": int(p.ticket),
            "symbol": p.symbol,
            "side": "BUY" if p.type == mt5.POSITION_TYPE_BUY else "SELL",
            "volume": float(p.volume),
            "profit": float(p.profit),
            "entryPrice": float(p.price_open),
            "currentPrice": float(p.price_current),
            "stopLoss": float(p.sl),
            "takeProfit": float(p.tp),
            "login": login,
        })
    return out


# 每次轮询都固定回看这么长时间，不再用"游标"记上次查到哪——见下方
# _closed_trades_payload 顶部的详细说明（这是踩了三轮增量游标的坑之后改的
# 设计）。15 分钟对单账户的 MT5 历史查询开销可以忽略不计。
# Every poll always looks back this far, instead of a "cursor" tracking where
# the last check left off — see the detailed note at the top of
# _closed_trades_payload (this design replaces three rounds of a fragile
# incremental cursor). 15 minutes is a trivially cheap MT5 history query for
# one account.
_TRADE_SCAN_WINDOW = timedelta(minutes=15)

# 断线补扫窗口：进程刚启动、或两次成功扫描之间出现了大于常规窗口的缺口时，
# 这一轮改用这个更宽的窗口把缺口补回来。
#
# 为什么必须有：固定回看 15 分钟意味着**只要桥接离线超过 15 分钟，这期间的平仓
# 就永久漏报**——后端那边"没有平仓记录、又不再被报为持仓"的仓位会被整笔剔除
# （见 services/trade_performance.py），于是这笔交易的盈亏凭空消失。它还能被
# 主动利用：关掉桥接、在 MT5 里手动平掉亏损单、过一会儿再打开，这笔亏损就再也
# 不会进统计。补扫把"离线不丢数据"这个前提真正建立起来。
#
# 上报天然幂等（后端按 (用户, 账号, 成交编号) 去重），所以补扫是纯增量、重复
# 上报无副作用。7 天足够覆盖一次长假或一台关机的电脑，又不至于让首轮扫描太重。
#
# Catch-up window used on process start, or whenever the gap since the last
# successful scan exceeds the normal window. Without it, any outage longer than
# 15 minutes permanently loses the closes that happened during it — and that is
# exploitable: close the bridge, manually close a losing position in MT5, reopen
# later, and the loss never reaches the platform. Reporting is idempotent, so the
# catch-up is purely additive.
_BACKFILL_WINDOW = timedelta(days=7)

# login -> 上一次**成功**扫描时的服务器时间。用来发现缺口；扫描失败或本轮有仓位
# 归属未定时不更新，让下一轮重扫同一段。
# login -> server time of the last fully successful scan; left untouched on
# failure so the next round rescans the same stretch.
_last_scan_at: dict[str, datetime] = {}

# 后端点名的一次性回扫（旧记录缺 MT5 完整字段）回看一年——个人胜率 / 明细页的统计
# 范围就是 365 天。/ One-off deep rescan window requested by the backend.
_DEEP_BACKFILL_WINDOW = timedelta(days=365)

# 服务器时区偏移的观测值：(账号, UTC 日期) -> 当日观测到的最大偏移秒数。
#
# 必须按账号分开存：一个进程可以同时连多个终端，不同经纪商的服务器时区可以不同
# （常见就是 EET 与 UTC 并存）。合在一起取最大值会把偏移大的那家的时区套到另一家
# 头上，把本来正确的时间改错。
# Keyed per account: one process can drive several terminals, and different
# brokers can sit in different server timezones — a shared maximum would apply
# one broker's offset to another's deals.
_utc_offset_samples: dict[tuple[str, str], float] = {}

# 每个账号保留的观测天数（够一次夏令时过渡，也不让字典无限增长）。
_OFFSET_KEEP_DAYS = 2

# 偏移的取整粒度与合理上界。经纪商服务器基本都是整点偏移（EET 是 +2/+3），
# 取整到半小时既能滤掉抖动，也容纳少数半小时时区。
# Offsets are rounded to the nearest half hour and must stay within ±14.5h.
_OFFSET_ROUND_SECONDS = 1800
_OFFSET_MAX_SECONDS = 14.5 * 3600


def _server_now(login: str) -> datetime | None:
    """MT5/经纪商服务器当前时间：由某个品种最新报价的时间戳推算。

    `history_deals_get()`的时间参数是按 MT5 服务器时间解读的，不是本地
    电脑时间——经纪商服务器常年跑在自己的时区（比如 EET），跟本地电脑的
    系统时间可以差好几个小时，且这个差值不是"时区"那种整点偏移就能简单
    换算的（还跟经纪商服务器自己的夏令时规则有关）。用本地 `datetime.now()`
    直接当查询参数，会让整个查询窗口偏出去好几个小时，不管窗口开多宽都
    查不到——这是排查一次真实漏报、对照 MT5 客户端"历史"标签页的时间后
    才发现的（本地记录 06:49:44，MT5 历史显示 01:49:44，差了 5 小时）。

    优先用当前持仓品种的最新报价（最活跃，时间戳最新鲜）；没有持仓则退
    化到报价面板的常见品种探测一个。都拿不到就返回 None，调用方据此放弃
    这一轮平仓检测（宁可这一轮跳过，也不要用错误的时间窗口误判"没有成交"）。

    The MT5/broker server's current time, inferred from a recent quote's
    timestamp.

    history_deals_get()'s date parameters are interpreted in MT5 server time,
    not local machine time — broker servers run year-round in their own
    timezone (e.g. EET), which can differ from the local machine's clock by
    several hours, and that difference isn't a simple fixed offset (it also
    depends on the broker server's own DST rules). Using local datetime.now()
    directly as the query bound shifts the entire scan window off by hours,
    so no window width fixes it — discovered by comparing a real missed
    report against the MT5 client's own History tab (local log said 06:49:44,
    MT5 History showed 01:49:44, a 5-hour gap).

    Prefers the latest quote for a currently-open position's symbol (most
    active, freshest timestamp); falls back to probing a common quote-panel
    symbol if there's no open position. Returns None if neither works, and
    the caller skips this round's closed-trade check entirely — better to
    skip a round than silently scan the wrong window and conclude "nothing
    closed".
    """
    symbol = None
    try:
        positions = mt5.positions_get()
    except Exception:
        positions = None
    if positions:
        symbol = positions[0].symbol
    if symbol is None:
        # 兜底品种也要按券商真名解析：裸 "XAUUSD" 在 Make Capital 这类券商上
        # 根本不存在（只有 XAUUSD.s），裸 "EURUSD" 虽然在表里、却是该组不可
        # 交易的只读品种，未必有报价。选错了这一轮的平仓检测就整轮跳过。
        # The fallback symbol needs the same resolution: a bare "XAUUSD" simply
        # doesn't exist at brokers like Make Capital (only XAUUSD.s), and the
        # bare "EURUSD" that does exist is the group's read-only copy, which may
        # carry no quotes. Picking wrong skips the whole closed-trade round.
        suffix = _detect_suffix()
        for base in QUOTE_SYMBOLS:
            try:
                resolved = _resolve_broker_symbol(base, suffix)
                if resolved and mt5.symbol_select(resolved, True):
                    symbol = resolved
                    break
            except Exception:
                continue
    if symbol is None:
        return None
    try:
        tick = mt5.symbol_info_tick(symbol)
    except Exception:
        return None
    if tick is None or tick.time <= 0:
        return None
    _observe_utc_offset(tick.time, login)
    return datetime.fromtimestamp(tick.time)


def _observe_utc_offset(server_epoch: float, login: str) -> None:
    """用一条报价的时间戳观测「服务器时间 − UTC」的偏移，按 UTC 日取最大值。

    MT5 给出的时间戳（报价、成交）都是**按服务器本地墙钟算出来的 epoch**，直接
    当 UTC 解读会整体偏出几小时——同一个参照系问题在查询窗口那边已经踩过一次
    （见 _server_now），这里管的是**落库时间**那一侧。

    为什么取"当日最大值"而不是最近一次：报价过期只会让 tick.time 偏**小**，所以
    每个样本都是真实偏移的下界，最大值最接近真值；市场活跃时一条新鲜报价就能一次
    到位，周末全是陈旧样本时又会因为超出 ±14.5 小时上界而被整体丢弃、不会污染。
    按 UTC 日分桶则让夏令时切换能在一天内自然跟上。

    Observe the server-vs-UTC offset from a quote timestamp, keeping the daily
    maximum. A stale quote can only bias the estimate downward, so every sample
    is a lower bound and the max converges on the truth as soon as one fresh
    quote lands; day buckets let DST shifts settle within a day.
    """
    offset = server_epoch - datetime.now(timezone.utc).timestamp()
    if abs(offset) > _OFFSET_MAX_SECONDS:
        return  # 陈旧到不可能是时区偏移（周末/长时间停盘）/ too stale to be a timezone
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    key = (login, day)
    if offset > _utc_offset_samples.get(key, float("-inf")):
        _utc_offset_samples[key] = offset
    # 该账号只留最近 _OFFSET_KEEP_DAYS 天：按日期排序后砍掉更早的（字典是插入序，
    # 不能拿顺序当日期序）。/ Keep the most recent days per account, chosen by
    # sorting the dates (dict order is insertion order, not chronological).
    days = sorted({d for (lg, d) in _utc_offset_samples if lg == login}, reverse=True)
    for stale in days[_OFFSET_KEEP_DAYS:]:
        _utc_offset_samples.pop((login, stale), None)


def _utc_offset_seconds(login: str) -> float:
    """当前采用的偏移（秒），取整到半小时；没有有效观测时返回 0。

    返回 0 即"沿用旧行为"（把服务器时间当 UTC 落库）——拿不准时不猜，宁可维持
    既有语义，也不要用一个错误的偏移把时间改得更离谱。
    Falls back to 0 (the previous behaviour) when nothing has been observed:
    when in doubt, don't guess.
    """
    mine = [v for (lg, _day), v in _utc_offset_samples.items() if lg == login]
    if not mine:
        return 0.0
    return round(max(mine) / _OFFSET_ROUND_SECONDS) * _OFFSET_ROUND_SECONDS


def _server_epoch_to_utc(server_epoch: float, login: str) -> datetime:
    """把该账号所在服务器的 MT5 时间戳换算成真正的 UTC 时刻。"""
    return datetime.fromtimestamp(server_epoch - _utc_offset_seconds(login), tz=timezone.utc)


def _scan_window(now: datetime, last: datetime | None) -> tuple[datetime, bool]:
    """这一轮平仓检测该从什么时候扫起，以及是不是在补扫。

    - 常规：固定回看 _TRADE_SCAN_WINDOW，不依赖游标精度（见 _closed_trades_payload
      文档 ①）；
    - 缺口：`last` 为空（进程刚起）或距上次成功扫描已超过常规窗口（中间断过），
      就从上次扫到的点再往前留一个常规窗口的安全边距开始扫，最多回看
      _BACKFILL_WINDOW。

    纯函数，便于单独验证边界。返回 (起点, 是否补扫)。
    Returns where this round's scan should start and whether it is a catch-up.
    """
    if last is None or now - last > _TRADE_SCAN_WINDOW:
        gap_start = (last - _TRADE_SCAN_WINDOW) if last is not None else (now - _BACKFILL_WINDOW)
        return max(gap_start, now - _BACKFILL_WINDOW), True
    return now - _TRADE_SCAN_WINDOW, False


def _deal_reason_name(code) -> str | None:
    """终端侧成交原因枚举 → 名字。与网关侧 routers/gateway.gateway_deal_reason 用同一套
    名字，但两边枚举**数值不同**（终端 SL=4，Manager API SL=3），所以各自在源头转好。
    Terminal-side deal reason enum → name (same names as the gateway side, whose
    enum differs numerically, hence mapping at the source)."""
    if code is None or mt5 is None:
        return None
    names = {
        getattr(mt5, "DEAL_REASON_CLIENT", 0): "CLIENT",
        getattr(mt5, "DEAL_REASON_MOBILE", 1): "MOBILE",
        getattr(mt5, "DEAL_REASON_WEB", 2): "WEB",
        getattr(mt5, "DEAL_REASON_EXPERT", 3): "EXPERT",
        getattr(mt5, "DEAL_REASON_SL", 4): "SL",
        getattr(mt5, "DEAL_REASON_TP", 5): "TP",
        getattr(mt5, "DEAL_REASON_SO", 6): "SO",
        getattr(mt5, "DEAL_REASON_ROLLOVER", 7): "ROLLOVER",
        getattr(mt5, "DEAL_REASON_VMARGIN", 8): "VMARGIN",
        getattr(mt5, "DEAL_REASON_SPLIT", 9): "SPLIT",
    }
    try:
        return names.get(int(code), "OTHER")
    except (TypeError, ValueError):
        return None


def _position_facts(pos_id: int, pos_deals, login: str) -> dict:
    """一个仓位的开仓事实与费用汇总，供它的每条平仓腿共用（MT5 历史「仓位」视图那一行
    除平仓腿自身之外的信息）。

    - open_price / open_time：开仓腿（entry=IN / INOUT）按手数加权的均价、最早时间
      （换算成真 UTC，同 closedAt）。
    - commission / swap：整个仓位的手续费与隔夜利息合计，平仓腿按手数占比分摊——
      与原先"总费用一起摊"的算法等价，只是拆开存。
    - sl / tp：MT5 Python 接口的成交记录**不带**止损止盈，只能读该仓位的订单历史：
      开仓单上的是下单时的初值；止损 / 止盈触发的平仓由服务器生成一张平仓单，其
      price_open 就是触发价，比初值准，平仓腿那边按 reason 覆盖。用户在客户端手动
      改过、且不是被触发平掉的，这里读不到，后端再用平台改单记录兜底。

    Per-position facts shared by its closing legs: weighted open price / earliest
    open time, total commission / swap (allocated per leg by volume share), and
    SL/TP read from the position's order history (deals don't carry them here).
    """
    in_deals = [
        d for d in pos_deals
        if d.entry in (mt5.DEAL_ENTRY_IN, getattr(mt5, "DEAL_ENTRY_INOUT", 2)) and float(d.volume) > 0
    ]
    in_volume = sum(float(d.volume) for d in in_deals)
    facts = {
        "open_price": (sum(float(d.price) * float(d.volume) for d in in_deals) / in_volume) if in_volume > 0 else None,
        "open_time": _server_epoch_to_utc(min(d.time for d in in_deals), login).isoformat() if in_deals else None,
        "commission": sum(float(d.commission) for d in pos_deals),
        "swap": sum(float(d.swap) for d in pos_deals),
        # 开仓腿自己的手续费 / 隔夜利息与开仓手数：平仓腿按"自己那笔成交的费用 +
        # 开仓费用 × 本腿手数 ÷ 开仓手数"分摊（见平仓腿处的说明）。
        # The opening legs' own fees and volume: each closing leg takes its own
        # deal's fees plus a volume share of these (see the closing-leg note).
        "open_commission": sum(float(d.commission) for d in in_deals),
        "open_swap": sum(float(d.swap) for d in in_deals),
        "in_volume": in_volume,
        "sl": None,
        "tp": None,
        "orders": {},
    }
    try:
        orders = mt5.history_orders_get(position=pos_id) or ()
    except Exception as e:
        logger.warning("平仓检测：history_orders_get(position=%s) 抛异常 / threw: %s", pos_id, e)
        orders = ()
    facts["orders"] = {int(o.ticket): o for o in orders}
    opening = min(orders, key=lambda o: getattr(o, "time_setup", 0)) if orders else None
    if opening is not None:
        facts["sl"] = float(getattr(opening, "sl", 0) or 0) or None
        facts["tp"] = float(getattr(opening, "tp", 0) or 0) or None
    return facts


def _closed_trades_payload(deep_backfill: bool = False) -> list:
    """检测该终端账号最近的平仓成交，且仅限本平台开的仓位（个人胜率用）。

    先按仓位编号在 MT5 历史里查这个仓位的开仓成交是不是打了 PRISMX 的魔术号
    码——不管后续这笔平仓是网页发的指令，还是用户直接在 MT5 客户端手动点的，
    只要仓位编号对得上就会被上报。

    设计说明——两层修复：
    ① 为什么放弃"增量游标"改成"固定回看窗口"：之前用一个"游标"记录"上次
       检查到哪个时间点"，每轮只查游标到现在这一小段（1.5~2 秒），本意是
       避免重复扫描；改成每轮都固定回看最近 15 分钟，不管有多少毫秒/秒级
       误差都能稳稳盖住，代价是同一笔成交会被反复查到、反复上报，但后端
       按 (用户, 成交编号) 去重，无副作用。
    ② 更关键的一层：查询用的"现在"时间，必须是 MT5 服务器时间，不能是本地
       电脑时间。真实排查一次漏报时，对照 MT5 客户端"历史"标签页发现记录
       时间是 01:49:44，而本地日志（用 datetime.now()）记的是 06:49:44——
       差了整整 5 小时。这不是"时钟稍微不准"的量级，是"参照系整个用错了"：
       经纪商服务器常年跑在自己的时区，`history_deals_get()` 的时间参数
       按服务器时间解读，用本地时间传参会让整段查询窗口偏出去好几个小时，
       不管①的窗口开多宽都补不回来（15 分钟 vs 5 小时偏差，差两个数量级）。
       现在改用 _server_now()（从最新报价的时间戳推算服务器时间）而不是
       datetime.now() 来算查询边界，从根上解决参照系错位的问题。

    Detect this terminal's account's recent closing deals, restricted to
    positions this platform opened (for personal win-rate stats). Checks each
    closing deal's position by MT5 ticket to see whether its opening deal
    carries the PRISMX magic number — regardless of whether the close itself
    was a web command or a manual click in the MT5 terminal, as long as the
    position id matches.

    Design note — two layers of fix:
    (1) Why a fixed lookback window replaced an incremental cursor: a cursor
        used to track "checked up to when", each poll only scanning the
        ~1.5-2s since the last check, to avoid rescanning. Every poll now
        always rescans the last 15 minutes instead, comfortably absorbing any
        millisecond/second-level jitter — the same deal may be re-queried and
        re-reported while still in the window, harmless since the backend
        dedupes by (user, deal ticket).
    (2) The more critical layer: the "now" used for the query must be MT5
        server time, not the local machine's clock. Debugging a real missed
        report against the MT5 client's own History tab found the deal
        recorded at 01:49:44 there, while the local log (using
        datetime.now()) recorded 06:49:44 — a 5-hour gap. That's not clock
        jitter, that's an entirely wrong reference frame: broker servers run
        year-round in their own timezone, and history_deals_get()'s date
        parameters are interpreted in that server time — passing local time
        shifts the whole scan window off by hours, which no width from (1)
        can compensate for (15 minutes vs. a 5-hour gap is two orders of
        magnitude short). Now uses _server_now() (inferred from a fresh
        quote's timestamp) instead of datetime.now() for the query bounds,
        fixing the reference-frame mismatch at its root.
    ③ 第三层：**离线缺口补扫**。①的固定窗口只解决"抖动"，不解决"停机"——桥接
       离线超过 15 分钟，这期间的平仓就永久扫不到了，而后端会把"没有平仓记录、
       又不再被报为持仓"的仓位整笔剔除，于是那笔盈亏凭空消失（还能被主动利用：
       关掉桥接、手动平掉亏损单、过一会儿再开）。所以额外按账号记一个"上次成功
       扫描的服务器时间"，只在发现缺口时把窗口临时放宽到 _BACKFILL_WINDOW。

       注意这**不是**①里被否掉的那个增量游标：游标仍然不参与常规路径（每轮照旧
       固定回看 15 分钟，不依赖游标的精度），它只用来回答"中间是不是断过"这一个
       问题；判错的代价也只是多扫一段已经上报过的成交，而上报是幂等的。本轮若有
       仓位归属未定则不推进游标，下一轮重扫同一段。
    ④ 落库时间换算成真 UTC：`d.time` 与查询边界同属服务器时间参照系，②只修了
       查询这一侧，写进平台的 closedAt 一直是"服务器时间冒充 UTC"，整体偏几小时。
       见 _server_epoch_to_utc / _observe_utc_offset。

    (3) Offline-gap catch-up: the fixed window absorbs jitter but not downtime,
        so a per-account "last successful scan" marker widens the window to
        _BACKFILL_WINDOW when a gap is detected. This is not the incremental
        cursor rejected in (1) — the normal path still doesn't depend on it;
        it only answers "were we offline?", and a wrong answer merely rescans
        already-reported deals. (4) closedAt is converted to true UTC, since
        d.time shares the server-time frame that (2) only fixed on the query side.
    """
    # 账号要先拿到：扫描窗口按账号各自记游标（补扫判断见下）。
    # The login comes first: the scan cursor is tracked per account.
    login = _current_login()
    if not login:
        logger.warning("平仓检测：_current_login() 拿不到账号，本轮跳过 / no login, skipping this round")
        return []

    # 必须用服务器时间，不能用本地电脑时间——见 _server_now() 的详细说明。
    # Must use server time, not the local machine's clock — see _server_now()'s comment.
    now = _server_now(login)
    if now is None:
        logger.warning("平仓检测：拿不到服务器时间（没有持仓也探测不到品种报价），本轮跳过 / can't determine server time, skipping this round")
        return []

    last = _last_scan_at.get(login)
    since, catching_up = _scan_window(now, last)
    if deep_backfill:
        # 后端点名的一次性回扫（旧记录缺 MT5 完整字段）：回看一年。上报幂等，后端只补
        # 空列；不推进游标，这一轮不代表常规扫描的连续性。
        # Backend-requested one-off rescan: look back a year. Idempotent; the
        # cursor is left alone since this round isn't part of the regular cadence.
        since, catching_up = now - _DEEP_BACKFILL_WINDOW, True
        logger.info("平仓检测：账号 %s 一次性回扫近一年补齐 MT5 明细 / one-off deep rescan", login)
    if catching_up:
        logger.info(
            "平仓检测：账号 %s 补扫 [%s, %s]（上次成功扫描：%s）/ catch-up scan",
            login, since, now, last,
        )

    try:
        deals = mt5.history_deals_get(since, now)
    except Exception as e:
        logger.warning("平仓检测：history_deals_get(%s, %s) 抛异常 / threw: %s", since, now, e)
        return []
    if deals is None:
        # MT5 查询本身失败（区别于"查到了但确实没有成交"），可用 mt5.last_error() 看原因。
        # The MT5 call itself failed (distinct from "queried fine, just empty"); mt5.last_error() has the reason.
        logger.warning("平仓检测：history_deals_get(%s, %s) 返回 None，mt5.last_error()=%s", since, now, mt5.last_error())
        return []

    if deals:
        logger.info("平仓检测：窗口 [%s, %s] 内查到 %d 条原始成交 / %d raw deal(s) in window", since, now, len(deals), len(deals))

    out = []
    # 本轮是否有仓位因为查不到历史而没能判定归属。有的话就**不推进游标**，让下一轮
    # 重扫同一段——否则在补扫模式下，窗口一旦向前滑走，这笔成交就再也扫不到了。
    # Whether any position's ownership stayed undetermined this round; if so the
    # cursor is not advanced so the next round rescans the same stretch.
    deferred = False
    # 同一次轮询内，同一仓位是否是我们开的只查一次 / cache per-position lookups within one pass
    position_is_ours: dict[int, bool] = {}
    # 仓位总手续费+隔夜利息 与 全部平仓成交的总手数——用于按手数占比把费用分摊
    # 到每一笔平仓上。有些经纪商把手续费整笔记在开仓成交上、平仓成交的
    # commission 字段是 0；只看平仓这一笔会漏掉开仓那笔的手续费，导致上报的
    # 盈亏比 MT5 实际显示的偏高（少算了手续费）。
    # Total commission+swap for the position, and total volume across all its
    # closing deals — used to allocate fees proportionally to each close.
    # Some brokers record the full commission on the opening deal, leaving
    # the closing deal's own commission field at 0; looking only at the
    # closing deal then misses that fee, overstating the reported profit
    # versus what MT5 itself shows.
    position_facts: dict[int, dict | None] = {}  # pos_id -> 开仓事实与费用汇总 / open facts & fee totals
    for d in deals:
        if d.entry != mt5.DEAL_ENTRY_OUT:
            continue  # 只关心平仓成交（含部分平仓）/ only closing deals (incl. partial)
        pos_id = int(d.position_id)
        if pos_id not in position_is_ours:
            try:
                pos_deals = mt5.history_deals_get(position=pos_id)
            except Exception as e:
                logger.warning("平仓检测：history_deals_get(position=%s) 抛异常 / threw: %s", pos_id, e)
                pos_deals = None
            if pos_deals is None:
                # 这次没查到该仓位的完整历史，无法确定是否本平台开的仓——跳过
                # 这笔（不缓存归属结果）。不需要担心"这轮跳过就永久漏了"：
                # 固定回看窗口下，只要这笔平仓还在最近 15 分钟内，下一轮
                # （1.5s 后）会重新扫到同一笔成交，再试一次归属判定。
                # Couldn't fetch this position's full history, so ownership is
                # undetermined — skip this deal (don't cache a result). No
                # need to worry this makes it permanently missed: under the
                # fixed lookback window, as long as this close is still within
                # the last 15 minutes, the next poll (1.5s later) rescans the
                # same deal and retries ownership resolution.
                logger.warning("平仓检测：仓位 %s 的历史查不到（mt5.last_error()=%s），归属未知，本轮跳过，下一轮重试", pos_id, mt5.last_error())
                deferred = True
                continue
            position_is_ours[pos_id] = any(getattr(pd, "magic", 0) == PRISMX_MAGIC for pd in pos_deals)
            facts = _position_facts(pos_id, pos_deals, login) if position_is_ours[pos_id] else None
            position_facts[pos_id] = facts
            total_fees = (facts["commission"] + facts["swap"]) if facts else 0.0
            logger.info(
                "平仓检测：仓位 %s 共 %d 条历史成交，魔术号匹配=%s，总手续费+隔夜利息=%.2f / "
                "position %s has %d deal(s), magic match=%s, total commission+swap=%.2f",
                pos_id, len(pos_deals), position_is_ours[pos_id], total_fees, pos_id, len(pos_deals), position_is_ours[pos_id], total_fees,
            )
        if not position_is_ours[pos_id]:
            continue  # 不是本平台开的仓位 / not a position this platform opened

        # 平仓成交的方向与原仓位相反：SELL 平的是多单，BUY 平的是空单
        # a closing SELL deal flattens a BUY position, and vice versa
        side = "BUY" if d.type == mt5.DEAL_TYPE_SELL else "SELL"
        facts = position_facts[pos_id]
        # 费用分摊（2026-09-07 改，桥接 v1.3.24）：这条腿 = 自己那笔平仓成交的手续费
        # / 隔夜利息 + 开仓那笔的费用 × 本腿手数 ÷ 开仓手数。结果只取决于成交记录，
        # 不随扫描时机变化。以前按"本腿手数 ÷ 已平仓手数"摊"仓位到目前为止的总费用"：
        # 分批平仓时第一腿平掉一半就把开仓手续费全摊给它，第二腿又按一半再摊一次，
        # 开仓手续费被算了 1.5 次——一笔 2.5 手 EURUSD 分两次平，真实手续费 15 记成
        # 18.75，净赚 3.75 显示成 0。一次性全平的单子两种算法结果相同。
        # Fee allocation (bridge 1.3.24): this leg = its own closing deal's
        # commission/swap + the opening deal's fees × leg volume ÷ opened volume.
        # Depends only on the deals, not on when the scan ran. The old "share of
        # closed-so-far volume of the fees-so-far" double-counted the opening
        # commission across partial closes (a 2.5-lot EURUSD closed in halves
        # recorded 18.75 of fees instead of 15). Single full closes are unchanged.
        share_in = float(d.volume) / facts["in_volume"] if facts["in_volume"] > 0 else 1.0
        leg_commission = float(d.commission) + facts["open_commission"] * share_in
        leg_swap = float(d.swap) + facts["open_swap"] * share_in
        fee_share = leg_commission + leg_swap
        reason = _deal_reason_name(getattr(d, "reason", None))
        sl, tp = facts["sl"], facts["tp"]
        # 止损 / 止盈触发的平仓：服务器生成的平仓单 price_open 就是触发价，比开仓单初值准
        # SL/TP-triggered close: the server's closing order carries the trigger price
        closing_order = facts["orders"].get(int(getattr(d, "order", 0) or 0))
        trigger = float(getattr(closing_order, "price_open", 0) or 0) if closing_order is not None else 0.0
        if trigger > 0 and reason == "SL":
            sl = trigger
        elif trigger > 0 and reason == "TP":
            tp = trigger
        out.append({
            "login": login,
            "symbol": d.symbol,
            "side": side,
            "closeVolume": float(d.volume),
            "closePrice": float(d.price),
            # 这笔平仓自身的盈亏，加上按手数占比分摊到的仓位总手续费+隔夜利息，
            # 才是这笔平仓真正到手的净盈亏。/ This close's own P&L plus its
            # volume-weighted share of the position's total fees is the true
            # net P&L for this close.
            "profit": float(d.profit) + fee_share,
            "positionTicket": pos_id,
            "dealTicket": int(d.ticket),
            # d.time 是**服务器时间**算出来的 epoch，直接当 UTC 落库会整体偏出
            # 几小时（周/月边界、比赛起止都会因此错位）。换算见 _server_epoch_to_utc。
            # d.time is an epoch computed from the *server's* wall clock; storing
            # it as UTC shifts every close by the broker's offset.
            "closedAt": _server_epoch_to_utc(d.time, login).isoformat(),
            # ---- MT5 历史「仓位」视图的其余字段 / the rest of MT5's positions view ----
            "openTime": facts["open_time"],
            "openPrice": facts["open_price"],
            "grossProfit": float(d.profit),
            "commission": leg_commission,
            "swap": leg_swap,
            # feeAlloc=2：费用分摊已是"只看成交记录"的稳定算法，后端据此允许用本次的
            # 费用 / 净盈亏覆盖旧值（旧算法随扫描时机变化，不能反过来覆盖新值）。
            # feeAlloc=2 marks the scan-independent allocation; the backend lets
            # such reports overwrite older fee/net values, never the reverse.
            "feeAlloc": 2,
            "sl": sl,
            "tp": tp,
            "reason": reason,
            "comment": (str(getattr(d, "comment", "") or "")[:64] or None),
        })

    # 推进游标。有仓位归属未定时**不能原地不动**：那样下一轮会判定成"还有缺口"
    # 而再次整段补扫，一个永远查不到历史的仓位就会让 7 天窗口每 1.5 秒重扫一次。
    # 退一步把游标放到"一个常规窗口之前"：下一轮走常规路径重试同一批成交，既保住
    # 重试、又不会退化成反复全量补扫。
    # Advance the cursor. When something stayed undetermined, don't leave it
    # untouched — the next round would see a gap and re-run the whole catch-up,
    # so a permanently unreadable position would rescan 7 days every 1.5s.
    # Park it one normal window back instead: the retry still happens, via the
    # normal path.
    if not deep_backfill:
        _last_scan_at[login] = (now - _TRADE_SCAN_WINDOW) if deferred else now

    if deals:
        logger.info("平仓检测：本轮产出 %d 条待上报记录 / this round produced %d entrie(s)", len(out), len(out))
    return out


def _reject_reason(retcode: int) -> str:
    """把 MT5 下单返回码翻译成简短的中英文原因。
    Translate an MT5 retcode into a short bilingual reason.
    """
    if mt5 is None:
        return "下单被拒绝 / Order rejected"
    reasons = {
        mt5.TRADE_RETCODE_REQUOTE: "价格已变动，请重试 / Price changed, retry",
        mt5.TRADE_RETCODE_REJECT: "请求被拒绝 / Request rejected",
        mt5.TRADE_RETCODE_CANCEL: "交易已被取消 / Order cancelled",
        mt5.TRADE_RETCODE_INVALID: "请求参数无效 / Invalid request",
        mt5.TRADE_RETCODE_INVALID_VOLUME: "手数无效 / Invalid volume",
        mt5.TRADE_RETCODE_INVALID_PRICE: "价格无效 / Invalid price",
        mt5.TRADE_RETCODE_INVALID_STOPS: "止损止盈无效 / Invalid stops",
        mt5.TRADE_RETCODE_TRADE_DISABLED: "该账户禁止交易 / Trading disabled",
        mt5.TRADE_RETCODE_MARKET_CLOSED: "市场已休市 / Market closed",
        mt5.TRADE_RETCODE_NO_MONEY: "保证金不足 / Insufficient funds",
        mt5.TRADE_RETCODE_PRICE_CHANGED: "价格已变动 / Price changed",
        mt5.TRADE_RETCODE_PRICE_OFF: "无可用报价 / No quotes",
        mt5.TRADE_RETCODE_TOO_MANY_REQUESTS: "请求过于频繁 / Too many requests",
        mt5.TRADE_RETCODE_INVALID_FILL: "成交模式不支持 / Unsupported fill mode",
        mt5.TRADE_RETCODE_CONNECTION: "与交易服务器断连 / No connection",
        mt5.TRADE_RETCODE_LIMIT_VOLUME: "超出持仓/挂单量限制 / Volume limit reached",
    }
    return reasons.get(retcode, f"下单被拒绝 / Order rejected (#{retcode})")


# 二次确认的重试节奏：PLACED 之后券商把单子从「已受理」推进到「已成交」通常在
# 一秒内，但撮合忙时会更久。总预算 3 秒是权衡——后端的桥接回执没有硬超时，但
# /bridge/poll 的长轮询上限是 5 秒，确认阶段不该把它顶满。
# Retry cadence for the second-level confirmation: brokers normally move an
# order from "accepted" to "filled" within a second, busier ones take longer. The
# 3-second budget is a trade-off — the backend does not hard-timeout a bridge
# result, but /bridge/poll's long-poll ceiling is 5s and confirmation should not
# eat all of it.
_CONFIRM_TOTAL_SECONDS = 3.0
_CONFIRM_INTERVAL_SECONDS = 0.25


def _confirm_order_filled(order_ticket: int) -> bool | None:
    """PLACED 之后查这张单到底成交了没有。True=确认成交，False=确认没成交，None=查不出来。

    为什么需要这一步：`order_send` 返回 TRADE_RETCODE_PLACED 的意思是「券商收下了这
    张单」，**不是**「成交了」。此前这里把 PLACED 和 DONE 一视同仁当成交，于是平仓
    指令在只受理未成交时也会回报成功，网页显示「已平」而仓位还在——和 09-17 那次
    锁仓是同一类风险。网关那条通道早就有这道确认（gateway_execute 的
    PLACED_UNCONFIRMED → FAILED），这里是把桥接补齐到同一口径。

    查 history_orders_get 而不是 positions_get：开仓要看这张**订单**的终态，而平仓
    产生的是反向单，看仓位反而要另写一套判定；订单状态对两种动作都成立。

    After a PLACED result, find out whether the order actually filled. True =
    confirmed filled, False = confirmed not filled, None = could not tell.

    `order_send` returning TRADE_RETCODE_PLACED means "the broker accepted the
    order", not "it filled". Treating PLACED as a fill is what made a close report
    success while the position stayed open — the same class of risk as the 2026-09-17
    stuck position. The gateway channel has had this confirmation all along
    (PLACED_UNCONFIRMED → FAILED in gateway_execute); this brings the bridge to the
    same standard.

    We query history_orders_get rather than positions_get because the order's own
    terminal state answers the question for opens and closes alike, whereas a close
    creates an opposite order and would need separate position bookkeeping.
    """
    if mt5 is None or not order_ticket:
        return None
    deadline = time.time() + _CONFIRM_TOTAL_SECONDS
    saw_any = False
    while time.time() < deadline:
        try:
            orders = mt5.history_orders_get(ticket=order_ticket)
        except Exception:
            orders = None
        if orders:
            saw_any = True
            state = getattr(orders[0], "state", None)
            if state == mt5.ORDER_STATE_FILLED:
                return True
            # 明确的终态且不是成交：券商拒了 / 撤了 / 过期，这才是真的「没成交」。
            #
            # 刻意不含 ORDER_STATE_PARTIAL（=3，部分成交）：那是「成交了一部分」，既不是
            # 确认成交也不是确认没成交。它会走到下面的超时分支落 FAILED，措辞是「请先核对
            # 持仓」——对部分成交恰好是对的：仓位确实建立了，只是手数比请求的小，用户必须
            # 自己看一眼。报 FILLED 会谎称全额成交，报 REJECTED 会诱导重下。
            #
            # Deliberately excludes ORDER_STATE_PARTIAL (3): a partial fill is neither a
            # confirmed fill nor a confirmed non-fill. It falls through to the timeout
            # branch and lands as FAILED ("verify your positions"), which is right — a
            # position does exist, just smaller than requested.
            if state in (mt5.ORDER_STATE_REJECTED, mt5.ORDER_STATE_CANCELED,
                         mt5.ORDER_STATE_EXPIRED):
                return False
        time.sleep(_CONFIRM_INTERVAL_SECONDS)
    # 超时。查到过这张单但一直没到终态 = 还挂着，属于「没成交」；从头到尾查不到
    # 这张单则是真不知道（历史还没同步 / 连接有问题），必须回 None 让上层落 FAILED。
    # Timed out. If the order was visible but never reached a terminal state it is
    # still working, i.e. not filled. If it was never visible at all we genuinely
    # do not know (history not synced, connection trouble) and must return None so
    # the caller records FAILED.
    return False if saw_any else None


def _result_from_retcode(result, confirm: bool = True) -> tuple[str, bool]:
    """把 order_send 的结果映射成三态 (status, filled)。

    status 是要回报给后端的 FILLED / REJECTED / FAILED（见 routers/bridge.py 里
    BridgeResultRequest.status 的说明），filled 表示能否把它当成交来取成交价与票号。

    Map an order_send result onto the three-state (status, filled) pair. `status`
    is what the backend is told (see BridgeResultRequest.status in
    routers/bridge.py); `filled` says whether we may read a fill price and ticket
    off the result.
    """
    if mt5 is None:
        return "FAILED", False
    if result.retcode == mt5.TRADE_RETCODE_DONE:
        return "FILLED", True
    if result.retcode == mt5.TRADE_RETCODE_PLACED:
        if not confirm:
            return "FAILED", False
        confirmed = _confirm_order_filled(int(getattr(result, "order", 0) or 0))
        if confirmed is True:
            return "FILLED", True
        # 确认没成交、或压根确认不了，都落 FAILED 而不是 REJECTED：REJECTED 在界面上
        # 的意思是「可以安全重下」，而这里恰恰不能保证。
        # A confirmed non-fill and an inconclusive check both map to FAILED, never
        # REJECTED — REJECTED reads as "safe to retry", which is exactly what we
        # cannot promise here.
        return "FAILED", False
    return "REJECTED", False


def _open_comment(cmd: dict) -> str:
    """开仓 / 挂单的备注：PRISMX-SIG（跟单）或 PRISMX-CHART（图表）；没带 tag 的老后端仍是 PRISMX。
    Comment for opens / pending orders: PRISMX-<tag>, or plain PRISMX without a tag."""
    tag = "".join(ch for ch in str(cmd.get("tag") or "") if ch.isalnum())[:12]
    return f"PRISMX-{tag}" if tag else "PRISMX"


def _execute_order(cmd: dict, suffix: str = "") -> dict:
    """执行单条下单指令 / execute one order command."""
    requested = cmd["symbol"]
    side = cmd["side"]
    client_order_id = cmd["clientOrderId"]

    # 指令里的名字未必就是券商的名字：比特币信号侧叫 BTCUSDT，券商只有
    # BTCUSD.s / BTCUSD.p；后端拼的后缀也可能与本账号所在组对不上。这里按本
    # 账号真实的品种表解析一次，解析不出来才报"没有这个品种"。
    # The commanded name isn't necessarily the broker's: Bitcoin is BTCUSDT on
    # the signal side while the broker lists only BTCUSD.s / BTCUSD.p, and the
    # suffix the backend appended may not match this account's group. Resolve
    # against this account's real symbol table, and only report the symbol as
    # missing when nothing resolves.
    symbol = _resolve_broker_symbol(requested, suffix)
    if not symbol or not mt5.symbol_select(symbol, True):
        return {
            "clientOrderId": client_order_id,
            "success": False,
            "message": f"Symbol not available: {requested}",
        }

    volume = _normalize_volume(symbol, float(cmd.get("volume", 0.0) or 0.0))
    sl, tp = _compute_stops(
        symbol, side,
        float(cmd.get("entry", 0.0) or 0.0),
        float(cmd.get("stopLoss", 0.0) or 0.0),
        float(cmd.get("takeProfit", 0.0) or 0.0),
    )

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return {
            "clientOrderId": client_order_id,
            "success": False,
            "message": f"No tick for {symbol}",
        }
    price = tick.ask if side == "BUY" else tick.bid
    order_type = mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": order_type,
        "price": price,
        "deviation": _deviation_points(symbol, price),
        "magic": PRISMX_MAGIC,
        "comment": _open_comment(cmd),
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    if sl > 0:
        request["sl"] = sl
    if tp > 0:
        request["tp"] = tp

    result = mt5.order_send(request)
    if result is None:
        # order_send 返回 None = 请求没能送出去**或者**送出去了但读不到回应，两种
        # 情况分不开，所以是 FAILED（不知道）而不是 REJECTED（确定被拒）。
        # A None result means the request either never left or left and we could not
        # read the reply. The two are indistinguishable, so this is FAILED ("don't
        # know"), not REJECTED ("definitely refused").
        return {
            "clientOrderId": client_order_id,
            "success": False,
            "status": "FAILED",
            "message": f"order_send failed: {mt5.last_error()}",
        }
    # 成交模式不被支持时换一种再发一次。
    #
    # `type_filling` 上面写死的是 IOC，而是否支持 IOC / FOK / RETURN 完全由券商按品种
    # 定（`symbol_info.filling_mode` 是位掩码）。只支持 FOK 的券商会把每一笔都回
    # INVALID_FILL——`_reject_reason` 里早就为这个码备好了文案，说明确实踩到过，只是
    # 一直没有降级重试，用户那边就是"下单永远失败"。
    #
    # 只在 INVALID_FILL 这一个码上重试，且只重试一次：这个码的含义是"这张单没被受理"，
    # 所以重发不存在重复成交的风险；换成别的失败码就不能这么做了。
    #
    # Retry once with a different filling mode when the broker rejects this one.
    # type_filling is hardcoded to IOC above, but support for IOC / FOK / RETURN is
    # per-symbol and per-broker (symbol_info.filling_mode is a bitmask). A FOK-only
    # broker rejects every order with INVALID_FILL — _reject_reason already carries
    # wording for that code, so it has been hit — and without a fallback the user
    # simply cannot trade. Retried only on INVALID_FILL, and only once: that code
    # means the order was not accepted, so re-sending cannot double-fill. No other
    # failure code is safe to retry this way.
    invalid_fill = getattr(mt5, "TRADE_RETCODE_INVALID_FILL", None)
    if invalid_fill is not None and result.retcode == invalid_fill:
        alt = _alternate_filling(symbol, request["type_filling"])
        if alt is not None:
            logger.info(
                "成交模式 %s 不被支持，改用 %s 重试一次 / filling mode rejected, retrying with %s",
                request["type_filling"], alt, alt,
            )
            request["type_filling"] = alt
            retried = mt5.order_send(request)
            if retried is not None:
                result = retried
    status, success = _result_from_retcode(result)
    # 成交价回退：部分经纪商在 IOC 成交时 result.price 为 0，
    # 依次回退到成交单(deal)价、请求价，避免回执价显示为 0。
    # Fill-price fallback: some brokers return result.price == 0 on IOC fills;
    # fall back to the deal price, then the requested price, to avoid showing 0.
    filled_price = float(result.price) if success else None
    if success and (not filled_price or filled_price <= 0):
        deal_price = 0.0
        try:
            if getattr(result, "deal", 0):
                deals = mt5.history_deals_get(ticket=result.deal)
                if deals:
                    deal_price = float(deals[0].price)
        except Exception:
            deal_price = 0.0
        filled_price = deal_price if deal_price > 0 else price
    return {
        "clientOrderId": client_order_id,
        "success": success,
        "status": status,
        # 票号在 FAILED 时也要带上：那正是用户/客服事后去 MT5 核对这张单到底成没成交
        # 的唯一线索，丢了就只能靠时间去猜。
        # Send the ticket even on FAILED: it is the only handle for checking after
        # the fact whether the order filled. Dropping it leaves nothing but guesswork.
        "mt5Ticket": int(result.order) if getattr(result, "order", 0) else None,
        "filledPrice": filled_price,
        # 实际下出去的手数。`_normalize_volume` 会按券商步长与上下限静默改写用户
        # 填的数（0.005 手在最小 0.01 的品种上会被抬成 0.01，也就是仓位大了一倍），
        # 不回报的话网页只能显示用户当初填的值，"显示的"和"成交的"对不上。
        # The volume actually sent. _normalize_volume silently rewrites the request
        # to the broker's step and limits (0.005 becomes 0.01 — a doubled position),
        # so without this the UI would keep showing what the user typed.
        "volume": volume,
        "message": (
            "Order executed" if success
            else _unconfirmed_reason() if status == "FAILED"
            else _reject_reason(result.retcode)
        ),
        "login": _current_login(),
    }


def _unconfirmed_reason() -> str:
    """FAILED（不知道成没成）时给用户看的话。措辞刻意不说「被拒绝」。
    Wording for FAILED (outcome unknown). Deliberately never says "rejected"."""
    return "执行结果未确认，请先在 MT5 核对持仓 / Outcome unconfirmed — verify the position in MT5 first"


def _close_position(cmd: dict) -> dict:
    """平仓（支持部分平仓）/ close a position (supports partial close).

    通过 ticket 定位持仓，以反向市价单平掉指定手数；volume 省略或大于
    持仓量则全平。Locate the position by ticket and close the given volume
    with an opposite market order; full close if volume is omitted/too large.
    """
    client_order_id = cmd["clientOrderId"]
    ticket = int(cmd.get("ticket", 0))
    poss = mt5.positions_get(ticket=ticket)
    # `None` 与 `()` 必须分开处理——这是一条曾经会把「没平成」报成「已平」的路径。
    #
    # MetaTrader5 包的约定：查询**失败**返回 None，查询成功但**确实没有**返回空元组。
    # 原来写的是 `if not poss:`，两者都命中，于是终端一次瞬时不可用（重连中、
    # 未初始化、IPC 抖动）就会让一笔从未执行的平仓被回报成 success=True，还被写进
    # 24 小时幂等缓存——后端重投也救不回来，仓位继续开着而平台记录显示已平。
    #
    # 同文件里判 `mt5.last_error()` 的写法早就有，这里只是没用上。
    #
    # Distinguish None from (): the MetaTrader5 package returns None when the query
    # itself failed and an empty tuple when there is genuinely no such position.
    # `if not poss:` matched both, so a momentary terminal outage reported a close
    # that never happened as success — and cached it for 24 hours, so redelivery
    # could not rescue it. The position stays open while the platform shows it closed.
    if poss is None:
        return {
            "clientOrderId": client_order_id,
            "success": False,
            "status": "FAILED",
            "message": f"positions_get failed: {mt5.last_error()}",
        }
    if len(poss) == 0:
        # 确实查到了、确实没有这个仓位：它已经被平掉（可能是止损触发或用户手动平）。
        # 这是真正的"已平"，可以回 success。
        # Confirmed absent: the position really is gone (stop-out, or closed by hand).
        return {
            "clientOrderId": client_order_id,
            "success": True,
            "status": "FILLED",
            "message": "Position already closed",
        }
    pos = poss[0]
    # 只允许平掉本平台开的仓（魔术号匹配）：网页只展示本平台仓位，正常永远
    # 不会发来别的 ticket；这里再兜一道，即便有人手工构造请求也动不了用户在
    # MT5 客户端手动开的单，与持仓上报/自动仓管的"只碰本平台仓位"边界一致。
    # Only close positions this platform opened (magic match): the web app only
    # ever shows platform positions, so a foreign ticket never arrives normally.
    # This backstop means even a hand-crafted request can't touch a position the
    # user opened manually in the MT5 terminal — matching the "platform
    # positions only" boundary used by position reporting and auto-management.
    if getattr(pos, "magic", 0) != PRISMX_MAGIC:
        return {"clientOrderId": client_order_id, "success": False,
                "message": "Not a PRISMX-managed position"}
    symbol = pos.symbol
    if not mt5.symbol_select(symbol, True):
        return {"clientOrderId": client_order_id, "success": False,
                "message": f"Symbol not available: {symbol}"}

    req_vol = float(cmd.get("volume", 0.0) or 0.0)
    volume = pos.volume if req_vol <= 0 or req_vol > pos.volume else _normalize_volume(symbol, req_vol)

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return {"clientOrderId": client_order_id, "success": False,
                "message": f"No tick for {symbol}"}
    # 平多用 bid 卖出，平空用 ask 买入 / opposite side to flatten
    if pos.type == mt5.POSITION_TYPE_BUY:
        order_type = mt5.ORDER_TYPE_SELL
        price = tick.bid
    else:
        order_type = mt5.ORDER_TYPE_BUY
        price = tick.ask

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": volume,
        "type": order_type,
        "position": ticket,
        "price": price,
        # 与开仓同一套折算（见 _DEVIATION_FRACTION 上的说明）。以前这里写死 20：那段
        # 说明论证的「20 在黄金上只值 0.20 美元、行情快时换来一串 REQUOTE」对平仓一样
        # 成立，但修复只落在了开仓路径上——而平仓被拒比开仓被拒严重得多，那是仓位
        # 平不掉。
        # Same per-symbol conversion as the open path (see _DEVIATION_FRACTION). This
        # used to be a hard-coded 20: the argument above — 20 points is $0.20 on gold
        # and buys requotes in a fast market — applies equally to closes, but the fix
        # only landed on opens. A rejected close is worse than a rejected open: the
        # position stays exposed.
        "deviation": _deviation_points(symbol, price),
        "magic": PRISMX_MAGIC,
        "comment": "PRISMX close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(request)
    if result is None:
        # 平仓路径上这一条尤其要紧：分不清「没送出去」和「送出去了没读到回应」，
        # 而后者意味着仓位可能已经平掉了。落 FAILED，让用户先去核对再决定。
        # This matters most on the close path: "never sent" and "sent but no reply"
        # are indistinguishable, and the latter may mean the position is already
        # flat. Record FAILED so the user verifies before acting.
        return {"clientOrderId": client_order_id, "success": False, "status": "FAILED",
                "message": f"order_send failed: {mt5.last_error()}"}
    status, success = _result_from_retcode(result)
    filled_price = float(result.price) if success else None
    if success and (not filled_price or filled_price <= 0):
        filled_price = price  # 回退到平仓时的请求价 / fall back to the close request price
    return {
        "clientOrderId": client_order_id,
        "success": success,
        "status": status,
        "mt5Ticket": ticket,
        # **平仓单自己的订单号**，与上面的 mt5Ticket（仓位号）是两回事。
        #
        # 为什么要单独带一个：重发时的二次确认要查「这张单成没成」，而查的对象必须是
        # 订单号。平仓回执里的 mt5Ticket 放的是仓位号，而 MT5 的仓位号就是当初**开仓**
        # 那张单的订单号——拿它去查订单历史，查到的是那张早已成交的开仓单，于是一笔
        # 没平成的平仓会被升级成「已平」，而仓位还在裸奔。那正是这套确认要防的事故。
        #
        # 有了这个字段，bridge_app._reconfirm_cached 才能对平仓也做「只重跑确认、不重跑
        # 执行」。后端不认识它，pydantic 默认忽略多余字段（已实测），所以纯属桥接自用。
        #
        # The closing order's own ticket, distinct from mt5Ticket (the position id).
        # Re-delivery confirmation must look up an *order*, and a position id in MT5 is
        # the opening order's ticket — querying that would find the long-since-filled
        # open and upgrade a failed close to "closed" while the position is still open.
        # This field lets _reconfirm_cached cover closes too. The backend ignores
        # unknown fields (verified), so it is purely bridge-internal.
        "mt5OrderTicket": int(getattr(result, "order", 0) or 0) or None,
        "filledPrice": filled_price,
        # 实际平掉的手数（部分平仓会被步长规整，也可能因为请求量大于持仓量而变成全平）。
        # The volume actually closed: a partial close is step-aligned, and a request
        # larger than the position becomes a full close.
        "volume": volume,
        "message": (
            "Position closed" if success
            else _unconfirmed_reason() if status == "FAILED"
            else _reject_reason(result.retcode)
        ),
        "login": _current_login(),
    }


def _modify_position(cmd: dict) -> dict:
    """修改持仓的止损/止盈 / modify a position's SL/TP.

    sl/tp 为绝对价格，传 0 表示清除该项 / sl & tp are absolute prices; 0 clears it.
    """
    client_order_id = cmd["clientOrderId"]
    ticket = int(cmd.get("ticket", 0))
    poss = mt5.positions_get(ticket=ticket)
    # 同 _close_position：None（查询失败）与 ()（确实没有）不是一回事。
    # As in _close_position: None (query failed) is not the same as () (absent).
    if poss is None:
        return {"clientOrderId": client_order_id, "success": False, "status": "FAILED",
                "message": f"positions_get failed: {mt5.last_error()}"}
    if len(poss) == 0:
        return {"clientOrderId": client_order_id, "success": False,
                "message": "Position not found"}
    pos = poss[0]
    # 只允许改本平台开的仓（魔术号匹配），理由同 _close_position。
    # Only modify positions this platform opened (magic match); see _close_position.
    if getattr(pos, "magic", 0) != PRISMX_MAGIC:
        return {"clientOrderId": client_order_id, "success": False,
                "message": "Not a PRISMX-managed position"}
    symbol = pos.symbol
    info = mt5.symbol_info(symbol)
    digits = info.digits if info else 5
    # 指令里没带的那一侧，保留仓位上的现值，**不要**当成 0 发出去。
    #
    # TRADE_ACTION_SLTP 是"把这个仓位的 sl/tp 设成这两个值"，而 0 的语义是清除。
    # 原来缺字段一律取 0，于是一条只想移动止损的 MODIFY（自动仓管的保本、追踪止损
    # 都是这么发的，只带 stopLoss 是最自然的写法）会把用户原有的止盈一并抹掉，
    # 而且没有任何提示。网关侧 Mt5Link.ModifyPosition 自 2026-09-21 起同样区分
    # 「没传（null）= 保留」与「传 0 = 清除」——此前它对两侧无条件置 CHANGED，
    # 缺的一侧会被清成 0；这段注释曾误以为网关早已如此（那只对开仓成立）。
    #
    # 真要清除某一侧，仍然可以显式传 0——区别在于"没说"和"说了 0"不再是一回事。
    #
    # Keep the position's current value for whichever side the command omits; do not
    # send 0. TRADE_ACTION_SLTP sets both sides, and 0 means "clear". Defaulting a
    # missing field to 0 meant a MODIFY that only moved the stop — exactly how
    # auto-management sends break-even and trailing updates — silently wiped the
    # user's take-profit. The gateway's Mt5Link.ModifyPosition makes the same
    # distinction since 2026-09-21 (null keeps, 0 clears); before that it set both
    # CHANGED flags unconditionally and a missing side was cleared to 0 — this
    # comment used to claim otherwise, which was only true of the open path.
    # Passing an explicit 0 still clears a side: the difference is that
    # "unspecified" and "explicitly zero" are no longer the same.
    def _side(key: str, current) -> float:
        raw = cmd.get(key)
        if raw is None:
            return round(float(current or 0.0), digits)
        return round(float(raw or 0.0), digits)

    sl = _side("stopLoss", getattr(pos, "sl", 0.0))
    tp = _side("takeProfit", getattr(pos, "tp", 0.0))

    request = {
        "action": mt5.TRADE_ACTION_SLTP,
        "symbol": symbol,
        "position": ticket,
        "sl": sl,
        "tp": tp,
        "magic": PRISMX_MAGIC,
    }
    result = mt5.order_send(request)
    if result is None:
        return {"clientOrderId": client_order_id, "success": False, "status": "FAILED",
                "message": f"order_send failed: {mt5.last_error()}"}
    # 改单不能走 _result_from_retcode：TRADE_ACTION_SLTP 不产生订单，result.order 是 0，
    # 拿订单历史确认无从谈起。改单的天然确认方式是回读这个仓位的 sl/tp 对不对得上。
    # Modify cannot use _result_from_retcode: TRADE_ACTION_SLTP creates no order, so
    # result.order is 0 and order-history confirmation is meaningless. The natural
    # check for a modify is to read the position back and compare its SL/TP.
    if result.retcode == mt5.TRADE_RETCODE_DONE:
        status, success = "FILLED", True
    elif result.retcode == mt5.TRADE_RETCODE_PLACED:
        applied = _confirm_stops_applied(ticket, sl, tp, digits)
        status, success = ("FILLED", True) if applied else ("FAILED", False)
    else:
        status, success = "REJECTED", False
    return {
        "clientOrderId": client_order_id,
        "success": success,
        "status": status,
        "mt5Ticket": ticket,
        "message": (
            "SL/TP updated" if success
            else _unconfirmed_reason() if status == "FAILED"
            else _reject_reason(result.retcode)
        ),
    }


def _confirm_stops_applied(ticket: int, sl: float, tp: float, digits: int) -> bool:
    """回读持仓，确认止损止盈真的改成了请求的值。

    容差取一个最小价格单位：券商会按品种精度取整，逐位相等的比较会假阴性。
    Read the position back and confirm SL/TP really took. The tolerance is one
    price step, because brokers round to the symbol's precision and an exact
    comparison would produce false negatives.
    """
    if mt5 is None or not ticket:
        return False
    tol = 10 ** (-digits) / 2
    deadline = time.time() + _CONFIRM_TOTAL_SECONDS
    while time.time() < deadline:
        try:
            poss = mt5.positions_get(ticket=ticket)
        except Exception:
            poss = None
        if poss:
            pos = poss[0]
            if (abs(float(getattr(pos, "sl", 0.0) or 0.0) - sl) <= tol
                    and abs(float(getattr(pos, "tp", 0.0) or 0.0) - tp) <= tol):
                return True
        time.sleep(_CONFIRM_INTERVAL_SECONDS)
    return False


# MT5 挂单类型名 -> MetaTrader5 包里的常量名。指令里传的是名字（BUY_LIMIT…），
# 不是数字：数字在协议层看不出对错，而挂单类型填反的后果是"在价格另一侧成交"。
# Pending type name -> MetaTrader5 constant name. The wire carries names, not the
# raw ints: a wrong int is invisible in a payload, and a wrong pending type fills
# on the opposite side of the market.
_PENDING_TYPES = {
    "BUY_LIMIT": "ORDER_TYPE_BUY_LIMIT",
    "SELL_LIMIT": "ORDER_TYPE_SELL_LIMIT",
    "BUY_STOP": "ORDER_TYPE_BUY_STOP",
    "SELL_STOP": "ORDER_TYPE_SELL_STOP",
}

# 反向表：读挂单时把 MT5 的类型数值翻回名字。用 getattr 现算而不是写死 2/3/4/5，
# 数值以本机装的 MetaTrader5 包为准。
# Reverse map, built from the installed package rather than hard-coded 2/3/4/5.
def _pending_type_name(raw_type: int) -> str | None:
    if mt5 is None:
        return None
    for name, const in _PENDING_TYPES.items():
        value = getattr(mt5, const, None)
        if value is not None and int(raw_type) == int(value):
            return name
    return None


def _pending_orders_payload() -> list:
    """读取本平台挂在券商那边的挂单 / read this platform's pending orders.

    与 `_positions_payload` 同一条边界：只上报魔术号匹配的单。用户自己在 MT5
    客户端里挂的单不会出现在网页上，也就不会被网页误撤——撤单是不可逆的，
    而"帮用户撤掉一张他自己挂的单"是这里最容易犯、后果最难解释的错。

    形状与后端 services/pending_orders.pending_row 完全一致（两条通道的挂单
    最终进同一张表，前端整表替换）。`price` 是触发价，不是成交价——挂单还没成交。

    Same boundary as _positions_payload: only orders whose magic matches. An order
    the user placed by hand in the MT5 client never surfaces on the web and so can
    never be cancelled from there — cancellation is irreversible, and silently
    removing someone's own order is the worst mistake available here.

    The shape matches the backend's services/pending_orders.pending_row exactly, so
    both channels feed one table. `price` is the trigger price, not a fill price.
    """
    orders = mt5.orders_get()
    if not orders:
        return []
    info = mt5.account_info()
    login = str(info.login) if info else None
    out = []
    for o in orders:
        if getattr(o, "magic", 0) != PRISMX_MAGIC:
            continue
        name = _pending_type_name(getattr(o, "type", -1))
        # 认不出类型就整行丢掉，绝不猜方向：界面上少一行，好过多一行写错买卖方向的。
        # An unrecognised type drops the row rather than guessing its direction.
        if name is None:
            continue
        out.append({
            "ticket": int(o.ticket),
            "symbol": o.symbol,
            "type": name,
            "side": "BUY" if name.startswith("BUY") else "SELL",
            # volume_current 而不是 volume_initial：部分成交过的挂单上，剩下的
            # 才是还挂着的量。/ what is still resting, not what was originally asked.
            "volume": float(getattr(o, "volume_current", 0.0) or 0.0),
            "price": float(getattr(o, "price_open", 0.0) or 0.0),
            "stopLoss": float(getattr(o, "sl", 0.0) or 0.0),
            "takeProfit": float(getattr(o, "tp", 0.0) or 0.0),
            "login": login,
        })
    return out


def _clamp_pending_stops(symbol: str, side: str, price: float, sl: float, tp: float):
    """把挂单的止损止盈夹到离**触发价**足够远的地方。

    不能复用 `_compute_stops`：那个函数按**当前市价**夹最小止损距离，对市价单是
    对的，对挂单则完全错位——挂单的参照点是它自己的触发价，而触发价按定义就离
    市价有一段距离。用市价去夹，一张「现价 3900、买入止损挂 3950、止损 3930」的
    单会被"修正"成止损贴着 3900，触发的瞬间就被打掉。

    方向由后端在落库前校验过（_validate_pending_levels），这里只管距离。

    Clamp a pending order's SL/TP against its own trigger price, not the market.
    _compute_stops clamps against the live price, which is right for a market order
    and wrong here: a pending order's trigger sits away from the market by
    definition, so market-based clamping would drag the stop next to the current
    price and have it taken out the instant the order triggers. Direction is already
    validated backend-side; this only enforces distance.
    """
    info = mt5.symbol_info(symbol)
    if info is None or price <= 0:
        return sl, tp
    point = info.point or 0.0
    digits = info.digits or 5
    stops_level = getattr(info, "trade_stops_level", 0) or 0
    min_dist = (stops_level if stops_level > 0 else 10) * point

    if side == "BUY":
        if sl > 0 and price - sl < min_dist:
            sl = price - min_dist
        if tp > 0 and tp - price < min_dist:
            tp = price + min_dist
    else:
        if sl > 0 and sl - price < min_dist:
            sl = price + min_dist
        if tp > 0 and price - tp < min_dist:
            tp = price - min_dist

    return (round(sl, digits) if sl > 0 else 0.0,
            round(tp, digits) if tp > 0 else 0.0)


def _confirm_pending_placed(ticket: int) -> bool:
    """回读挂单表，确认这张挂单真的挂上了。

    为什么需要：`order_send` 回 TRADE_RETCODE_PLACED 的意思是「券商收下了这个
    请求」，不是「挂单已经在那儿了」。开仓路径上这个差别酿过事故（见
    `_confirm_order_filled`），挂单这边的确认方式更简单——挂单成功的唯一证据就是
    它出现在 `orders_get` 里。

    查不到返回 False，调用方据此落 FAILED（不知道成没成），而不是 REJECTED
    （可以安全重下）——重下一张可能已经挂上的单，等于挂了两张。

    A PLACED retcode means "the request was accepted", not "the order is there".
    The only proof a pending order exists is finding it in orders_get. Not found →
    False → FAILED ("don't know"), never REJECTED ("safe to retry"), because
    retrying an order that did get placed leaves two of them resting.
    """
    if mt5 is None or not ticket:
        return False
    deadline = time.time() + _CONFIRM_TOTAL_SECONDS
    while time.time() < deadline:
        try:
            found = mt5.orders_get(ticket=ticket)
        except Exception:
            found = None
        if found:
            return True
        time.sleep(_CONFIRM_INTERVAL_SECONDS)
    return False


def _place_pending(cmd: dict, suffix: str = "") -> dict:
    """执行一条挂单指令 / place one pending order."""
    client_order_id = cmd["clientOrderId"]
    requested = cmd["symbol"]
    type_name = (cmd.get("pendingType") or "").upper()
    const = _PENDING_TYPES.get(type_name)
    order_type = getattr(mt5, const, None) if const else None
    if order_type is None:
        return {"clientOrderId": client_order_id, "success": False,
                "message": f"Unsupported pending type: {type_name}"}

    symbol = _resolve_broker_symbol(requested, suffix)
    if not symbol or not mt5.symbol_select(symbol, True):
        return {"clientOrderId": client_order_id, "success": False,
                "message": f"Symbol not available: {requested}"}

    volume = _normalize_volume(symbol, float(cmd.get("volume", 0.0) or 0.0))
    info = mt5.symbol_info(symbol)
    digits = info.digits if info else 5
    price = round(float(cmd.get("price", 0.0) or 0.0), digits)
    if price <= 0:
        return {"clientOrderId": client_order_id, "success": False,
                "message": "Pending order needs a trigger price"}

    side = "BUY" if type_name.startswith("BUY") else "SELL"
    sl, tp = _clamp_pending_stops(
        symbol, side, price,
        float(cmd.get("stopLoss", 0.0) or 0.0),
        float(cmd.get("takeProfit", 0.0) or 0.0),
    )

    request = {
        "action": mt5.TRADE_ACTION_PENDING,
        "symbol": symbol,
        "volume": volume,
        "type": order_type,
        "price": price,
        "magic": PRISMX_MAGIC,
        "comment": _open_comment(cmd),
        "type_time": mt5.ORDER_TIME_GTC,
        # 挂单用 RETURN，不是市价单那套 IOC：挂单的成交模式说的是「触发之后剩余
        # 部分怎么办」，而 IOC/FOK 在多数券商上对挂单直接非法（INVALID_FILL）。
        # `_alternate_filling` 刻意不返回 RETURN（对市价单语义不符），所以下面
        # 降级重试的候选是 FOK/IOC —— 只在券商确实拒了 RETURN 时才轮到它们。
        # Pending orders use RETURN, not the market path's IOC: the filling mode here
        # describes what happens to the remainder after a trigger, and IOC/FOK are
        # outright invalid for pending orders at most brokers. _alternate_filling
        # never returns RETURN (wrong semantics for market orders), so the fallback
        # candidates are FOK/IOC, reached only if the broker rejects RETURN.
        "type_filling": getattr(mt5, "ORDER_FILLING_RETURN", 2),
    }
    if sl > 0:
        request["sl"] = sl
    if tp > 0:
        request["tp"] = tp

    result = mt5.order_send(request)
    if result is None:
        return {"clientOrderId": client_order_id, "success": False, "status": "FAILED",
                "message": f"order_send failed: {mt5.last_error()}"}

    invalid_fill = getattr(mt5, "TRADE_RETCODE_INVALID_FILL", None)
    if invalid_fill is not None and result.retcode == invalid_fill:
        alt = _alternate_filling(symbol, request["type_filling"])
        if alt is not None:
            logger.info("挂单成交模式被拒，改用 %s 重试一次 / pending filling rejected, retrying with %s", alt, alt)
            request["type_filling"] = alt
            retried = mt5.order_send(request)
            if retried is not None:
                result = retried

    ticket = int(getattr(result, "order", 0) or 0)
    if result.retcode == mt5.TRADE_RETCODE_DONE:
        status, success = "PLACED", True
    elif result.retcode == mt5.TRADE_RETCODE_PLACED:
        ok = _confirm_pending_placed(ticket)
        status, success = ("PLACED", True) if ok else ("FAILED", False)
    else:
        status, success = "REJECTED", False

    return {
        "clientOrderId": client_order_id,
        "success": success,
        "status": status,
        # 挂单票号。后端把它同时记进 mt5_position——MT5 里挂单触发后生成的仓位
        # 沿用这张挂单的票号，所以平仓明细的归属不用等任何回填。
        # The pending ticket; the backend also stores it as mt5_position because the
        # position this order eventually opens keeps the very same ticket.
        "mt5Ticket": ticket or None,
        # 规整后的真实手数，理由同 _execute_order。
        "volume": volume,
        "message": (
            "Pending order placed" if success
            else _unconfirmed_reason() if status == "FAILED"
            else _reject_reason(result.retcode)
        ),
    }


def _cancel_pending(cmd: dict) -> dict:
    """撤销一张挂单 / remove one pending order."""
    client_order_id = cmd["clientOrderId"]
    ticket = int(cmd.get("ticket", 0))
    found = mt5.orders_get(ticket=ticket)
    # None（查询失败）与 ()（确实没有）不是一回事，理由同 _close_position。
    # None (query failed) is not () (absent) — same reasoning as _close_position.
    if found is None:
        return {"clientOrderId": client_order_id, "success": False, "status": "FAILED",
                "message": f"orders_get failed: {mt5.last_error()}"}
    if len(found) == 0:
        return {"clientOrderId": client_order_id, "success": False,
                "message": "Pending order not found"}
    order = found[0]
    # 只撤本平台挂的单（魔术号匹配），理由同 _close_position：网页从来只显示
    # 本平台的挂单，一个外来票号正常情况下根本到不了这里。
    # Only cancel orders this platform placed; a foreign ticket cannot arrive here
    # through normal use, exactly as in _close_position.
    if getattr(order, "magic", 0) != PRISMX_MAGIC:
        return {"clientOrderId": client_order_id, "success": False,
                "message": "Not a PRISMX-managed order"}

    result = mt5.order_send({"action": mt5.TRADE_ACTION_REMOVE, "order": ticket})
    if result is None:
        return {"clientOrderId": client_order_id, "success": False, "status": "FAILED",
                "message": f"order_send failed: {mt5.last_error()}"}

    if result.retcode == mt5.TRADE_RETCODE_DONE:
        status, success = "FILLED", True
    elif result.retcode == mt5.TRADE_RETCODE_PLACED:
        # 撤单的确认与挂单相反：单**不在**挂单表里才算撤掉了。
        # The confirmation is the mirror image: it worked when the order is gone.
        status, success = ("FILLED", True) if not _confirm_pending_placed(ticket) else ("FAILED", False)
    else:
        status, success = "REJECTED", False

    return {
        "clientOrderId": client_order_id,
        "success": success,
        "status": status,
        "mt5Ticket": ticket,
        "message": (
            "Pending order cancelled" if success
            else _unconfirmed_reason() if status == "FAILED"
            else _reject_reason(result.retcode)
        ),
    }


def _modify_pending(cmd: dict) -> dict:
    """改一张挂单的触发价 / 止损 / 止盈 / modify a pending order.

    三项都是「指令里没带 = 保留挂单上的现值」，止损止盈额外支持显式传 0 = 清除。
    与 `_modify_position` 同一套语义，理由见那边的长注释——这里更要紧：图表上拖
    一条线只改一项，另外两项必须原样留着，`cmd.get(k) or 0` 那种写法会把用户没碰
    过的止损一起抹掉。

    TRADE_ACTION_MODIFY 要求把这张单的其余字段原样带上（品种、类型、手数），所以
    先读回它再发——顺便也就校验了归属与存在性。

    All three default to "keep what the order already has"; an explicit 0 additionally
    clears SL/TP. Same contract as _modify_position, and it matters more here: dragging
    one line on the chart touches one field, and `cmd.get(k) or 0` would wipe the stop
    the user never touched. TRADE_ACTION_MODIFY needs the order's other fields echoed
    back, so it is read first — which also checks ownership and existence.
    """
    client_order_id = cmd["clientOrderId"]
    ticket = int(cmd.get("ticket", 0))
    found = mt5.orders_get(ticket=ticket)
    # None（查询失败）与 ()（确实没有）不是一回事，理由同 _close_position。
    # None (query failed) is not () (absent) — same reasoning as _close_position.
    if found is None:
        return {"clientOrderId": client_order_id, "success": False, "status": "FAILED",
                "message": f"orders_get failed: {mt5.last_error()}"}
    if len(found) == 0:
        return {"clientOrderId": client_order_id, "success": False,
                "message": "Pending order not found"}
    order = found[0]
    # 只改本平台挂的单（魔术号匹配），理由同 _close_position。
    # Only modify orders this platform placed; see _close_position.
    if getattr(order, "magic", 0) != PRISMX_MAGIC:
        return {"clientOrderId": client_order_id, "success": False,
                "message": "Not a PRISMX-managed order"}

    symbol = order.symbol
    info = mt5.symbol_info(symbol)
    digits = info.digits if info else 5

    def _keep(key: str, current) -> float:
        raw = cmd.get(key)
        if raw is None:
            return round(float(current or 0.0), digits)
        return round(float(raw or 0.0), digits)

    price = _keep("price", getattr(order, "price_open", 0.0))
    if price <= 0:
        return {"clientOrderId": client_order_id, "success": False,
                "message": "Pending order needs a trigger price"}

    side = "BUY" if _pending_type_name(getattr(order, "type", -1)) in ("BUY_LIMIT", "BUY_STOP") else "SELL"
    sl = _keep("stopLoss", getattr(order, "sl", 0.0))
    tp = _keep("takeProfit", getattr(order, "tp", 0.0))
    # 最小距离照样按**新的**触发价夹，理由与下挂单时完全一样：按市价夹会把止损拖到
    # 贴着现价，触发那一刻就被打掉。
    # Clamp against the *new* trigger, for exactly the reason placement does.
    sl, tp = _clamp_pending_stops(symbol, side, price, sl, tp)

    request = {
        "action": mt5.TRADE_ACTION_MODIFY,
        "order": ticket,
        "symbol": symbol,
        "price": price,
        "sl": sl,
        "tp": tp,
        "type_time": mt5.ORDER_TIME_GTC,
        # 与下挂单同一个模式，理由见 _place_pending 里的注释。
        "type_filling": getattr(mt5, "ORDER_FILLING_RETURN", 2),
    }

    result = mt5.order_send(request)
    if result is None:
        return {"clientOrderId": client_order_id, "success": False, "status": "FAILED",
                "message": f"order_send failed: {mt5.last_error()}"}

    invalid_fill = getattr(mt5, "TRADE_RETCODE_INVALID_FILL", None)
    if invalid_fill is not None and result.retcode == invalid_fill:
        alt = _alternate_filling(symbol, request["type_filling"])
        if alt is not None:
            logger.info("改挂单成交模式被拒，改用 %s 重试一次 / pending modify filling rejected, retrying with %s", alt, alt)
            request["type_filling"] = alt
            retried = mt5.order_send(request)
            if retried is not None:
                result = retried

    if result.retcode == mt5.TRADE_RETCODE_DONE:
        status, success = "FILLED", True
    elif result.retcode == mt5.TRADE_RETCODE_PLACED:
        # 改单的确认方式是回读这张单，看新值是不是真的落上了。挂单仍在（不像撤单
        # 那样消失），所以 _confirm_pending_placed 在这里帮不上忙。
        # The confirmation is to read the order back and compare: it is still there
        # (unlike a cancel), so _confirm_pending_placed cannot answer this one.
        applied = _confirm_pending_modified(ticket, price, sl, tp, digits)
        status, success = ("FILLED", True) if applied else ("FAILED", False)
    else:
        status, success = "REJECTED", False

    return {
        "clientOrderId": client_order_id,
        "success": success,
        "status": status,
        "mt5Ticket": ticket,
        "message": (
            "Pending order updated" if success
            else _unconfirmed_reason() if status == "FAILED"
            else _reject_reason(result.retcode)
        ),
    }


def _confirm_pending_modified(ticket: int, price: float, sl: float, tp: float, digits: int) -> bool:
    """回读挂单，确认触发价 / 止损 / 止盈真的改成了请求的值。

    容差取一个最小价格单位：券商会按品种精度取整，逐位相等的比较会假阴性
    （与 `_confirm_stops_applied` 同一处理）。
    Read the order back and confirm the new values took, with a one-tick tolerance
    because brokers round to the symbol's precision (same as _confirm_stops_applied).
    """
    if mt5 is None or not ticket:
        return False
    tol = 10 ** (-digits) / 2
    deadline = time.time() + _CONFIRM_TOTAL_SECONDS
    while time.time() < deadline:
        try:
            found = mt5.orders_get(ticket=ticket)
        except Exception:
            found = None
        if found:
            o = found[0]
            if (abs(float(getattr(o, "price_open", 0.0) or 0.0) - price) <= tol
                    and abs(float(getattr(o, "sl", 0.0) or 0.0) - sl) <= tol
                    and abs(float(getattr(o, "tp", 0.0) or 0.0) - tp) <= tol):
                return True
        time.sleep(_CONFIRM_INTERVAL_SECONDS)
    return False


def _validate_command(cmd: dict) -> tuple[bool, str]:
    """校验单条指令的结构与字段范围 / validate one command's shape and field ranges.

    返回 (是否合法, 错误信息)。校验失败时调用方应回执失败而非抛异常中断整批。
    Returns (ok, error). On failure the caller should report a failed receipt
    instead of raising and aborting the whole batch.
    """
    if not isinstance(cmd, dict):
        return False, "command is not an object"
    if not cmd.get("clientOrderId"):
        return False, "missing clientOrderId"
    action = (cmd.get("action") or "ORDER").upper()
    if action not in ("ORDER", "CLOSE", "MODIFY", "PENDING", "MODIFY_PENDING", "CANCEL_PENDING"):
        return False, f"unknown action: {action}"

    # 数值字段必须可转为有限浮点 / numeric fields must be finite floats
    for key in ("volume", "entry", "stopLoss", "takeProfit", "price"):
        if key in cmd and cmd[key] is not None:
            try:
                v = float(cmd[key])
            except (TypeError, ValueError):
                return False, f"invalid number for {key}"
            if not math.isfinite(v) or v < 0:
                return False, f"out-of-range value for {key}"

    if action in ("CLOSE", "MODIFY", "MODIFY_PENDING", "CANCEL_PENDING"):
        try:
            ticket = int(cmd.get("ticket", 0))
        except (TypeError, ValueError):
            return False, "invalid ticket"
        if ticket <= 0:
            return False, "invalid ticket"

    if action == "PENDING":
        # 挂单类型必须是认得的四种之一。认不出就拒，绝不猜：猜错的后果是
        # 「在价格的另一侧成交」，而不是一条报错。
        # The pending type must be one of the four known names; an unknown one is
        # refused rather than guessed, since a wrong guess fills on the other side
        # of the market instead of producing an error.
        if (cmd.get("pendingType") or "").upper() not in _PENDING_TYPES:
            return False, f"invalid pendingType: {cmd.get('pendingType')}"
        symbol = cmd.get("symbol")
        if not symbol or not isinstance(symbol, str) or len(symbol) > 30:
            return False, "invalid symbol"
        # 手数与触发价都必须是真实的正数，理由同下面 ORDER 那段：`_normalize_volume`
        # 会把 0 抬成最小手数，而 0 触发价会被券商拒成一个看不懂的返回码。
        # Both must be genuinely positive, for the reason spelled out under ORDER:
        # _normalize_volume raises 0 to the minimum lot, and a 0 trigger price earns
        # an opaque broker rejection.
        try:
            volume = float(cmd.get("volume", 0.0) or 0.0)
            price = float(cmd.get("price", 0.0) or 0.0)
        except (TypeError, ValueError):
            return False, "invalid volume/price"
        if volume <= 0:
            return False, "missing or non-positive volume for PENDING"
        if price <= 0:
            return False, "missing or non-positive price for PENDING"

    if action == "ORDER":
        side = cmd.get("side")
        if side not in ("BUY", "SELL"):
            return False, f"invalid side: {side}"
        symbol = cmd.get("symbol")
        if not symbol or not isinstance(symbol, str) or len(symbol) > 30:
            return False, "invalid symbol"
        # 开仓必须有一个真实的正手数。
        #
        # 上面那段只拦负数和非有限值，0 与缺字段都能过。而 `_execute_order` 随后会把
        # 手数交给 `_normalize_volume`，那里 `if v < vmin: v = vmin` 会把 0 抬成该品种
        # 的最小手数——于是后端一个字段名写错、或序列化时漏了 volume，不会报任何错，
        # 而是**在用户账户上开出一笔真实仓位**。开仓这件事绝不能有"默认值"。
        #
        # An open needs a real, positive volume. The range check above lets 0 and a
        # missing field through, and _normalize_volume then raises 0 to the symbol's
        # minimum — so a misspelled field name or a dropped key on the backend opens
        # a real position instead of failing. An open must never have a default size.
        try:
            volume = float(cmd.get("volume", 0.0) or 0.0)
        except (TypeError, ValueError):
            return False, "invalid volume"
        if volume <= 0:
            return False, "missing or non-positive volume for ORDER"

    return True, ""


def _dispatch_command(cmd: dict, suffix: str = "") -> dict:
    """按指令类型分发执行 / dispatch by command action.

    action: ORDER（默认下单）/ CLOSE（平仓）/ MODIFY（改 SL·TP）/
            PENDING（挂单）/ MODIFY_PENDING（改挂单）/ CANCEL_PENDING（撤挂单）。
    校验失败或执行异常都返回失败回执，保证一条畸形指令不影响同批其它指令。
    Validation failures and execution exceptions both yield a failure receipt so
    a single malformed command never breaks the rest of the batch.
    """
    ok, err = _validate_command(cmd)
    if not ok:
        return {
            "clientOrderId": (cmd or {}).get("clientOrderId", ""),
            "success": False,
            "status": "REJECTED",
            "message": f"Invalid command: {err}",
        }
    action = (cmd.get("action") or "ORDER").upper()
    try:
        if action == "CLOSE":
            result = _close_position(cmd)
        elif action == "MODIFY":
            result = _modify_position(cmd)
        elif action == "PENDING":
            result = _place_pending(cmd, suffix)
        elif action == "MODIFY_PENDING":
            result = _modify_pending(cmd)
        elif action == "CANCEL_PENDING":
            result = _cancel_pending(cmd)
        else:
            result = _execute_order(cmd, suffix)
        # 不变式：**任何走到 order_send 的路径都必须自己写明 status**。到这里还没有
        # status 的，只可能是 order_send 之前就返回的早退（品种不可用、没有报价、仓位
        # 不归本平台、手数非法……）——那些确实一个字节都没发给券商，REJECTED（可以
        # 安全重下）是准确的。
        #
        # 兜底放在这一处而不是散在每个早退上，是为了让这条不变式可检查：新增一条
        # order_send 之后的返回路径而忘了写 status，读这里就知道它会被误判成
        # REJECTED，而 REJECTED 在界面上等于"请重下"。
        #
        # Invariant: every path that reaches order_send sets its own status. Anything
        # still missing one here can only be a pre-send early return (symbol
        # unavailable, no tick, position not ours, bad volume) where literally
        # nothing was sent to the broker, so REJECTED — "safe to retry" — is exact.
        #
        # The default lives in this one place rather than on each early return so the
        # invariant stays checkable: add a post-send return that forgets its status
        # and this comment tells you it will be mislabelled REJECTED, which the UI
        # renders as "place it again".
        result.setdefault("status", "REJECTED")
        return result
    except Exception as e:
        # 这个兜底 except 包着整个执行过程，所以异常**可能是在 order_send 成功之后**
        # 抛的（回读成交价、取 login、拼回执都在后面）。既然分不清，就只能是 FAILED：
        # 报 REJECTED 会让用户以为什么都没发生而重下，可能变成双倍仓位。
        # This catch-all wraps the whole execution, so the exception may have been
        # raised *after* a successful order_send (reading the fill price, the login
        # and building the reply all come later). Since we cannot tell, it must be
        # FAILED — reporting REJECTED would tell the user nothing happened and
        # invite a retry that could double the position.
        return {
            "clientOrderId": cmd.get("clientOrderId", ""),
            "success": False,
            "status": "FAILED",
            "message": f"Execution error: {e}",
        }


def poll_terminal(
    path: str,
    orders: list[dict] | None = None,
    deep_backfill: bool = False,
    read_state: bool = True,
    scan_closed: bool = True,
) -> dict:
    """连接一个终端，读取账号/持仓，并执行传入的下单指令。
    Attach to one terminal, read account/positions, execute given orders.

    scan_closed=False 跳过平仓明细扫描：状态循环把扫描拆出去单独调
    `scan_closed_trades`，两段各拿一次 MT5 锁、段间释放，让下单指令能插进来。
    scan_closed=False skips the closed-trade scan: the status loop runs it separately
    through scan_closed_trades, taking the MT5 lock once per segment so a command can
    get in between.

    read_state=False 只执行指令：不读账号、持仓、报价，也不扫平仓明细。指令循环拿到
    指令后用它立刻下单——以前每条指令都要先等一整轮终端读取（账号 + 持仓 + 7 个报价 +
    15 分钟平仓扫描）才轮到 order_send，这一整轮在下单路径上是纯等待。
    read_state=False executes commands only: no account / positions / quotes / closed
    trade scan. The command loop uses it so an order goes out immediately instead of
    after a full terminal read that contributed nothing to the order itself.

    返回 / returns:
      {
        "account": {...} | None,   # 含 detectedSuffix / includes detectedSuffix
        "positions": [...],
        "pendingOrders": [...],    # 券商那边真实挂着的挂单 / pending orders resting at the broker
        "quotes": [...],           # bid/ask 报价 / bid/ask quotes
        "results": [...],          # 下单回执 / order results
        "closedTrades": [...],     # 新检测到的真实平仓明细（个人胜率用）/ newly detected real closes (personal win-rate)
        "error": str | None,
      }
    """
    out = {"account": None, "positions": [], "pendingOrders": [], "quotes": [],
           "results": [], "closedTrades": [], "error": None}
    if mt5 is None:
        out["error"] = f"MetaTrader5 import failed: {_IMPORT_ERROR}"
        return out

    # 附着指定路径的终端（终端须已运行并登录）；单终端场景连接跨轮询复用，
    # 不再每 1.5 秒 initialize/shutdown 一次。
    # Attach to the terminal at path (must be running & logged in); with a
    # single terminal the attachment is reused across polls instead of
    # initialize/shutdown every 1.5s.
    if not _ensure_attached(path):
        out["error"] = f"initialize failed: {mt5.last_error()}"
        return out

    try:
        suffix = _detect_suffix()
        if read_state:
            out["account"] = _account_payload(suffix)
            out["positions"] = _positions_payload()
            out["pendingOrders"] = _pending_orders_payload()
            out["quotes"] = _quotes_payload(QUOTE_SYMBOLS, suffix)
        for cmd in orders or []:
            out["results"].append(_dispatch_command(cmd, suffix))
    except Exception as e:
        out["error"] = str(e)

    if not read_state or not scan_closed:
        return out

    # 已平仓明细检测独立成一个 try，不与上面账号/持仓/报价/下单共用同一个
    # 失败开关——以前四者中任何一个抛异常都会让整个 try 提前中断，"已平仓
    # 明细检测"这一步就完全不会被执行到（哪怕前面几步早已成功过、上报过），
    # 这正是个人胜率统计"平仓记录莫名其妙不上报"的一个根因，且比
    # _closed_trades_payload 内部的重试逻辑更上一层，之前两轮修复都没覆盖到。
    # Closed-trade detection gets its own try, independent from the
    # account/positions/quotes/orders block above — previously, an exception
    # in any of those four would abort the shared try early, so closed-trade
    # detection never even ran that poll (even though the earlier steps had
    # already succeeded and reported fine). This was a root cause of closed
    # trades silently never being reported, one level above
    # _closed_trades_payload's own internal retry logic, and wasn't covered
    # by either of the previous two fixes.
    try:
        out["closedTrades"] = _closed_trades_payload(deep_backfill)
    except Exception as e:
        if not out["error"]:
            out["error"] = str(e)
    return out


def scan_closed_trades(path: str, deep_backfill: bool = False) -> dict:
    """只做平仓明细扫描（`poll_terminal(scan_closed=False)` 拆出去的那一段）。
    Closed-trade scan only — the segment poll_terminal(scan_closed=False) leaves out.

    为什么要单独成段：15 分钟回看（补扫时 7 天、后端点名时一年）要逐仓位查成交历史，
    是一拍里最慢的一段。以前它和账号/持仓/报价一起攥在同一把 MT5 锁里，指令线程
    领到的单只能干等整拍读完。拆开后，调用方每段各拿一次锁，段间释放。
    Why a separate segment: the lookback (7 days on catch-up, a year when the backend
    asks) walks deal history per position and is the slowest part of a tick. Held in
    one lock with the account/positions read, a freshly received order had to wait
    for all of it; split, the caller takes the lock per segment and releases between.

    段间锁已释放过，指令线程可能已经把连接切到了别的终端（多终端时），所以这里照
    `read_positions` 的做法重新 `_ensure_attached`，确认读的仍是 `path` 那台。
    The lock was released in between and the command loop may have attached another
    terminal meanwhile, so re-attach to `path` first, as read_positions does.

    返回 / returns: {"closedTrades": [...], "error": str | None}
    """
    out = {"closedTrades": [], "error": None}
    if mt5 is None:
        out["error"] = f"MetaTrader5 import failed: {_IMPORT_ERROR}"
        return out
    if not _ensure_attached(path):
        out["error"] = f"initialize failed: {mt5.last_error()}"
        return out
    # 与 poll_terminal 里那段同一口径：异常只记进 error，不往外抛。
    # Same convention as the block in poll_terminal: errors are reported, not raised.
    try:
        out["closedTrades"] = _closed_trades_payload(deep_backfill)
    except Exception as e:
        out["error"] = str(e)
    return out


def read_pending_orders(path: str) -> list | None:
    """只读当前挂单（不读账号、持仓、报价、平仓明细）。读不到返回 None。

    与 `read_positions` 成对：挂单 / 撤挂单执行完立刻调用它并上报，让网页上的
    挂单"挂上即出现、撤掉即消失"，不等下一拍 1.5 秒的常规上报。
    The pending-order twin of read_positions, for the immediate report right after a
    place/cancel so the web reflects it without waiting for the next status tick.
    """
    if mt5 is None or not _ensure_attached(path):
        return None
    try:
        return _pending_orders_payload()
    except Exception:
        return None


def read_positions(path: str) -> list | None:
    """只读当前持仓（不读账号、报价、平仓明细）。读不到返回 None。

    指令执行完立刻调用它并上报，让网页上的仓位"成交即出现 / 平仓即消失"，不等下一拍
    1.5 秒的常规上报。
    Positions only, for the immediate report right after a command executes so the
    web shows the fill / close without waiting for the next 1.5s status tick.
    """
    if mt5 is None or not _ensure_attached(path):
        return None
    try:
        return _positions_payload()
    except Exception:
        return None
