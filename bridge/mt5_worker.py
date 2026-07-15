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


def _detect_suffix() -> str:
    """探测券商品种后缀（如 .sc / .m）。
    Detect the broker symbol suffix (e.g. .sc / .m).
    """
    try:
        symbols = mt5.symbols_get()
    except Exception:
        return ""
    if not symbols:
        return ""
    names = [s.name for s in symbols]
    for base in _SUFFIX_PROBE:
        for name in names:
            if name == base:
                return ""  # 无后缀 / no suffix
            if name.startswith(base) and len(name) > len(base):
                return name[len(base):]  # 截取后缀部分 / take the suffix part
    return ""


def _normalize_volume(symbol: str, volume: float) -> float:
    """把手数规整到券商步长与上下限 / clamp volume to broker step & limits."""
    info = mt5.symbol_info(symbol)
    if info is None:
        return volume
    step = info.volume_step or 0.01
    vmin = info.volume_min or step
    vmax = info.volume_max or volume
    v = round(volume / step) * step
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
        "leverage": int(info.leverage),
        "company": info.company,
        "detectedSuffix": suffix,
    }


def _quotes_payload(base_symbols: list[str], suffix: str = "") -> list:
    """采集品种的 bid/ask 报价 / collect bid/ask quotes for symbols.

    用「基础品种+券商后缀」向 MT5 查询，但上报基础品种名，便于网页匹配。
    Query MT5 with "base symbol + broker suffix" but report the base symbol so
    the web app can match regardless of broker naming.
    """
    out = []
    for base in base_symbols or []:
        broker_sym = base + suffix
        if not mt5.symbol_select(broker_sym, True):
            continue
        tick = mt5.symbol_info_tick(broker_sym)
        if tick is None or tick.bid <= 0 or tick.ask <= 0:
            continue
        # 交易商的小数位数，按其严格四舍五入，消除浮点残差（如 1.32386999…）。
        # Broker's decimal digits; round strictly to remove float noise.
        info = mt5.symbol_info(broker_sym)
        digits = int(info.digits) if info is not None else 5
        out.append({
            "symbol": base,
            "bid": round(float(tick.bid), digits),
            "ask": round(float(tick.ask), digits),
            "digits": digits,
        })
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
    login = str(mt5.account_info().login) if mt5.account_info() else None
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


def _server_now() -> datetime | None:
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
        for base in QUOTE_SYMBOLS:
            try:
                if mt5.symbol_select(base, True):
                    symbol = base
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
    return datetime.fromtimestamp(tick.time)


def _closed_trades_payload(path: str) -> list:
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
    """
    # 必须用服务器时间，不能用本地电脑时间——见 _server_now() 的详细说明。
    # Must use server time, not the local machine's clock — see _server_now()'s comment.
    now = _server_now()
    if now is None:
        logger.warning("平仓检测：拿不到服务器时间（没有持仓也探测不到品种报价），本轮跳过 / can't determine server time, skipping this round")
        return []
    since = now - _TRADE_SCAN_WINDOW

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

    login = _current_login()
    if not login:
        logger.warning("平仓检测：_current_login() 拿不到账号，本轮跳过 / no login, skipping this round")
        return []

    if deals:
        logger.info("平仓检测：窗口 [%s, %s] 内查到 %d 条原始成交 / %d raw deal(s) in window", since, now, len(deals), len(deals))

    out = []
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
    position_fees: dict[int, tuple[float, float]] = {}  # pos_id -> (total_fees, total_out_volume)
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
                continue
            position_is_ours[pos_id] = any(getattr(pd, "magic", 0) == PRISMX_MAGIC for pd in pos_deals)
            total_fees = sum(float(pd.commission) + float(pd.swap) for pd in pos_deals)
            total_out_volume = sum(float(pd.volume) for pd in pos_deals if pd.entry == mt5.DEAL_ENTRY_OUT) or 1.0
            position_fees[pos_id] = (total_fees, total_out_volume)
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
        total_fees, total_out_volume = position_fees[pos_id]
        # 按这笔平仓手数占全部平仓手数的比例，分摊仓位总手续费+隔夜利息
        # （只有一次性全部平仓时，占比就是 100%，等价于把开仓那笔的手续费
        # 也算全）。/ Allocate the position's total fees to this close by its
        # share of the total closed volume (a single full close gets 100% of
        # it, equivalent to also counting the opening deal's commission in full).
        fee_share = total_fees * (float(d.volume) / total_out_volume)
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
            "closedAt": datetime.fromtimestamp(d.time, tz=timezone.utc).isoformat(),
        })

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


def _execute_order(cmd: dict) -> dict:
    """执行单条下单指令 / execute one order command."""
    symbol = cmd["symbol"]
    side = cmd["side"]
    client_order_id = cmd["clientOrderId"]

    # 确保品种可交易 / make sure the symbol is selected
    if not mt5.symbol_select(symbol, True):
        return {
            "clientOrderId": client_order_id,
            "success": False,
            "message": f"Symbol not available: {symbol}",
        }

    volume = _normalize_volume(symbol, float(cmd.get("volume", 0.0)))
    sl, tp = _compute_stops(
        symbol, side,
        float(cmd.get("entry", 0.0)),
        float(cmd.get("stopLoss", 0.0)),
        float(cmd.get("takeProfit", 0.0)),
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
        "deviation": 20,
        "magic": PRISMX_MAGIC,
        "comment": "PRISMX",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    if sl > 0:
        request["sl"] = sl
    if tp > 0:
        request["tp"] = tp

    result = mt5.order_send(request)
    if result is None:
        return {
            "clientOrderId": client_order_id,
            "success": False,
            "message": f"order_send failed: {mt5.last_error()}",
        }
    success = result.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED)
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
        "mt5Ticket": int(result.order) if success else None,
        "filledPrice": filled_price,
        "message": "Order executed" if success else _reject_reason(result.retcode),
        "login": _current_login(),
    }


def _close_position(cmd: dict) -> dict:
    """平仓（支持部分平仓）/ close a position (supports partial close).

    通过 ticket 定位持仓，以反向市价单平掉指定手数；volume 省略或大于
    持仓量则全平。Locate the position by ticket and close the given volume
    with an opposite market order; full close if volume is omitted/too large.
    """
    client_order_id = cmd["clientOrderId"]
    ticket = int(cmd.get("ticket", 0))
    poss = mt5.positions_get(ticket=ticket)
    if not poss:
        # 持仓已不存在，视为已平 / position gone, treat as already closed
        return {
            "clientOrderId": client_order_id,
            "success": True,
            "message": "Position already closed",
        }
    pos = poss[0]
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
        "deviation": 20,
        "magic": PRISMX_MAGIC,
        "comment": "PRISMX close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }
    result = mt5.order_send(request)
    if result is None:
        return {"clientOrderId": client_order_id, "success": False,
                "message": f"order_send failed: {mt5.last_error()}"}
    success = result.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED)
    filled_price = float(result.price) if success else None
    if success and (not filled_price or filled_price <= 0):
        filled_price = price  # 回退到平仓时的请求价 / fall back to the close request price
    return {
        "clientOrderId": client_order_id,
        "success": success,
        "mt5Ticket": ticket,
        "filledPrice": filled_price,
        "message": "Position closed" if success else _reject_reason(result.retcode),
        "login": _current_login(),
    }


def _modify_position(cmd: dict) -> dict:
    """修改持仓的止损/止盈 / modify a position's SL/TP.

    sl/tp 为绝对价格，传 0 表示清除该项 / sl & tp are absolute prices; 0 clears it.
    """
    client_order_id = cmd["clientOrderId"]
    ticket = int(cmd.get("ticket", 0))
    poss = mt5.positions_get(ticket=ticket)
    if not poss:
        return {"clientOrderId": client_order_id, "success": False,
                "message": "Position not found"}
    pos = poss[0]
    symbol = pos.symbol
    info = mt5.symbol_info(symbol)
    digits = info.digits if info else 5
    sl = round(float(cmd.get("stopLoss", 0.0) or 0.0), digits)
    tp = round(float(cmd.get("takeProfit", 0.0) or 0.0), digits)

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
        return {"clientOrderId": client_order_id, "success": False,
                "message": f"order_send failed: {mt5.last_error()}"}
    success = result.retcode in (mt5.TRADE_RETCODE_DONE, mt5.TRADE_RETCODE_PLACED)
    return {
        "clientOrderId": client_order_id,
        "success": success,
        "mt5Ticket": ticket,
        "message": "SL/TP updated" if success else _reject_reason(result.retcode),
    }


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
    if action not in ("ORDER", "CLOSE", "MODIFY"):
        return False, f"unknown action: {action}"

    # 数值字段必须可转为有限浮点 / numeric fields must be finite floats
    import math

    for key in ("volume", "entry", "stopLoss", "takeProfit"):
        if key in cmd and cmd[key] is not None:
            try:
                v = float(cmd[key])
            except (TypeError, ValueError):
                return False, f"invalid number for {key}"
            if not math.isfinite(v) or v < 0:
                return False, f"out-of-range value for {key}"

    if action in ("CLOSE", "MODIFY"):
        try:
            ticket = int(cmd.get("ticket", 0))
        except (TypeError, ValueError):
            return False, "invalid ticket"
        if ticket <= 0:
            return False, "invalid ticket"

    if action == "ORDER":
        side = cmd.get("side")
        if side not in ("BUY", "SELL"):
            return False, f"invalid side: {side}"
        symbol = cmd.get("symbol")
        if not symbol or not isinstance(symbol, str) or len(symbol) > 30:
            return False, "invalid symbol"

    return True, ""


def _dispatch_command(cmd: dict) -> dict:
    """按指令类型分发执行 / dispatch by command action.

    action: ORDER（默认下单）/ CLOSE（平仓）/ MODIFY（改 SL·TP）。
    校验失败或执行异常都返回失败回执，保证一条畸形指令不影响同批其它指令。
    Validation failures and execution exceptions both yield a failure receipt so
    a single malformed command never breaks the rest of the batch.
    """
    ok, err = _validate_command(cmd)
    if not ok:
        return {
            "clientOrderId": (cmd or {}).get("clientOrderId", ""),
            "success": False,
            "message": f"Invalid command: {err}",
        }
    action = (cmd.get("action") or "ORDER").upper()
    try:
        if action == "CLOSE":
            return _close_position(cmd)
        if action == "MODIFY":
            return _modify_position(cmd)
        return _execute_order(cmd)
    except Exception as e:
        return {
            "clientOrderId": cmd.get("clientOrderId", ""),
            "success": False,
            "message": f"Execution error: {e}",
        }


def poll_terminal(path: str, orders: list[dict] | None = None) -> dict:
    """连接一个终端，读取账号/持仓，并执行传入的下单指令。
    Attach to one terminal, read account/positions, execute given orders.

    返回 / returns:
      {
        "account": {...} | None,   # 含 detectedSuffix / includes detectedSuffix
        "positions": [...],
        "quotes": [...],           # bid/ask 报价 / bid/ask quotes
        "results": [...],          # 下单回执 / order results
        "closedTrades": [...],     # 新检测到的真实平仓明细（个人胜率用）/ newly detected real closes (personal win-rate)
        "error": str | None,
      }
    """
    out = {"account": None, "positions": [], "quotes": [], "results": [], "closedTrades": [], "error": None}
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
        out["account"] = _account_payload(suffix)
        out["positions"] = _positions_payload()
        out["quotes"] = _quotes_payload(QUOTE_SYMBOLS, suffix)
        for cmd in orders or []:
            out["results"].append(_dispatch_command(cmd))
    except Exception as e:
        out["error"] = str(e)

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
        out["closedTrades"] = _closed_trades_payload(path)
    except Exception as e:
        if not out["error"]:
            out["error"] = str(e)
    return out
