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
from datetime import datetime, timedelta, timezone

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


# 每个终端路径记一个"上次检查到哪个时间点"的游标，避免每次轮询都重新扫一遍
# 全部历史。首次轮询只回看 1 小时，不把很久以前的平仓一次性倒灌进来。
# Per-terminal-path cursor of "checked up to when", so each poll doesn't
# rescan the whole history. The first poll only looks back 1 hour, so old
# closes don't flood in all at once.
_last_deal_check: dict[str, datetime] = {}
_DEAL_LOOKBACK_ON_FIRST_POLL = timedelta(hours=1)


def _closed_trades_payload(path: str) -> list:
    """检测该终端账号新出现的平仓成交，且仅限本平台开的仓位（个人胜率用）。

    先按仓位编号在 MT5 历史里查这个仓位的开仓成交是不是打了 PRISMX 的魔术号
    码——不管后续这笔平仓是网页发的指令，还是用户直接在 MT5 客户端手动点的，
    只要仓位编号对得上就会被上报。

    Detect newly closed deals for this terminal's account, restricted to
    positions this platform opened (for personal win-rate stats). Checks each
    closing deal's position by MT5 ticket to see whether its opening deal
    carries the PRISMX magic number — regardless of whether the close itself
    was a web command or a manual click in the MT5 terminal, as long as the
    position id matches.
    """
    now = datetime.now()
    since = _last_deal_check.get(path)
    if since is None:
        since = now - _DEAL_LOOKBACK_ON_FIRST_POLL
    # 注意：游标（_last_deal_check）只在下方确认"这轮真的完整处理成功"之后
    # 才会推进——不在这里提前写入。以前在这里无条件推进，只要 MT5 查询、
    # 账号信息、或某笔仓位归属判断当中任何一步瞬时失败，那段时间窗口的平仓
    # 记录就会被永久跳过、再也补不回来（表现为"胜率统计漏单/不及时"）。
    # 现在任何一步失败都保持游标原地不动，下一轮（1.5s 后）用同一个时间
    # 窗口重试；已经成功上报过的成交由后端按 (用户, 成交编号) 去重，重复
    # 查询/上报是安全的。
    # Note: the cursor (_last_deal_check) only advances after this poll is
    # confirmed fully successful below — not written eagerly up front. It
    # used to advance unconditionally here; any single transient failure in
    # the MT5 query, account lookup, or a position's ownership check would
    # silently and permanently skip that time window's closes (surfacing as
    # "missing / delayed win-rate stats"). Now any failure leaves the cursor
    # untouched so the next poll (1.5s later) retries the same window;
    # already-reported deals are deduped server-side by (user, deal ticket),
    # so re-querying/re-reporting is safe.

    try:
        deals = mt5.history_deals_get(since, now)
    except Exception:
        return []
    if deals is None:
        return []  # MT5 查询本身失败（区别于"查到了但确实没有成交"）/ the MT5 call itself failed (distinct from "queried fine, just empty")

    login = _current_login()
    if not login:
        return []

    out = []
    # 同一次轮询内，同一仓位是否是我们开的只查一次 / cache per-position lookups within one pass
    position_is_ours: dict[int, bool] = {}
    fully_resolved = True  # 本轮是否每笔平仓的归属都确认成功；只有全部成功才推进游标
                            # whether every close's ownership was confirmed this round; cursor only advances if so
    for d in deals:
        if d.entry != mt5.DEAL_ENTRY_OUT:
            continue  # 只关心平仓成交（含部分平仓）/ only closing deals (incl. partial)
        pos_id = int(d.position_id)
        if pos_id not in position_is_ours:
            try:
                pos_deals = mt5.history_deals_get(position=pos_id)
            except Exception:
                pos_deals = None
            if pos_deals is None:
                # 这次没查到该仓位的完整历史，无法确定是否本平台开的仓——
                # 跳过这笔（不缓存归属结果），并且不推进游标，留给下一轮重试。
                # Couldn't fetch this position's full history, so ownership is
                # undetermined — skip this deal (don't cache a result) and
                # don't advance the cursor; retry next round.
                fully_resolved = False
                continue
            position_is_ours[pos_id] = any(getattr(pd, "magic", 0) == PRISMX_MAGIC for pd in pos_deals)
        if not position_is_ours[pos_id]:
            continue  # 不是本平台开的仓位 / not a position this platform opened

        # 平仓成交的方向与原仓位相反：SELL 平的是多单，BUY 平的是空单
        # a closing SELL deal flattens a BUY position, and vice versa
        side = "BUY" if d.type == mt5.DEAL_TYPE_SELL else "SELL"
        out.append({
            "login": login,
            "symbol": d.symbol,
            "side": side,
            "closeVolume": float(d.volume),
            "closePrice": float(d.price),
            # 含隔夜利息与手续费才是这笔平仓真正到手的盈亏 / swap & commission included for the true net P&L
            "profit": float(d.profit) + float(d.swap) + float(d.commission),
            "positionTicket": pos_id,
            "dealTicket": int(d.ticket),
            "closedAt": datetime.fromtimestamp(d.time, tz=timezone.utc).isoformat(),
        })

    if fully_resolved:
        _last_deal_check[path] = now
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
        out["closedTrades"] = _closed_trades_payload(path)
    except Exception as e:
        out["error"] = str(e)
    return out
