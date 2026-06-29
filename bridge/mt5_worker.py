"""MT5 终端操作 / MT5 terminal operations.

同一进程内通过 mt5.initialize(path=...) 逐个连接不同终端，串行轮询。
Within one process, attach to each terminal via mt5.initialize(path=...)
and poll them serially. This avoids the multiprocessing pitfalls of a
PyInstaller onefile build.
"""
try:
    import MetaTrader5 as mt5
    _IMPORT_ERROR = None
except Exception as _e:  # pragma: no cover - 仅 Windows 有该包 / Windows-only package
    mt5 = None
    _IMPORT_ERROR = repr(_e)


# 常见基础品种，用于探测券商后缀 / common base symbols to probe broker suffix
_SUFFIX_PROBE = ["EURUSD", "XAUUSD", "GBPUSD", "USDJPY", "BTCUSD"]


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
    """把信号 SL/TP 按比例换算到真实市价并夹紧最小止损距离。
    Rescale signal SL/TP onto the live price and clamp to the broker stop level.

    信号价是平台合成价，直接用会触发 Invalid stops，因此用相对 entry 的比例
    套到真实市价上。The signal price is synthetic; use it as a ratio off entry.
    """
    out_sl = 0.0
    out_tp = 0.0
    if entry <= 0:
        return out_sl, out_tp
    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if info is None or tick is None:
        return out_sl, out_tp
    point = info.point or 0.0
    digits = info.digits or 5
    price = tick.ask if side == "BUY" else tick.bid
    if price <= 0:
        return out_sl, out_tp

    if sig_sl > 0:
        out_sl = price * (sig_sl / entry)
    if sig_tp > 0:
        out_tp = price * (sig_tp / entry)

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


def _positions_payload() -> list:
    """读取持仓 / read open positions."""
    positions = mt5.positions_get()
    if not positions:
        return []
    out = []
    for p in positions:
        out.append({
            "symbol": p.symbol,
            "side": "BUY" if p.type == mt5.POSITION_TYPE_BUY else "SELL",
            "volume": float(p.volume),
            "profit": float(p.profit),
        })
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
        "magic": 778899,
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
    return {
        "clientOrderId": client_order_id,
        "success": success,
        "mt5Ticket": int(result.order) if success else None,
        "filledPrice": float(result.price) if success else None,
        "message": "Order executed" if success else _reject_reason(result.retcode),
    }


def poll_terminal(path: str, orders: list[dict] | None = None) -> dict:
    """连接一个终端，读取账号/持仓，并执行传入的下单指令。
    Attach to one terminal, read account/positions, execute given orders.

    返回 / returns:
      {
        "account": {...} | None,   # 含 detectedSuffix / includes detectedSuffix
        "positions": [...],
        "results": [...],          # 下单回执 / order results
        "error": str | None,
      }
    """
    out = {"account": None, "positions": [], "results": [], "error": None}
    if mt5 is None:
        out["error"] = f"MetaTrader5 import failed: {_IMPORT_ERROR}"
        return out

    # 连接指定路径的终端（终端须已运行并登录）/ attach to the terminal at path
    # 加 timeout 防止误连到异常终端时无限阻塞（单位毫秒）。
    # Add timeout (ms) so a bad terminal cannot block the worker indefinitely.
    if not mt5.initialize(path=path, timeout=10000):
        out["error"] = f"initialize failed: {mt5.last_error()}"
        return out

    try:
        suffix = _detect_suffix()
        out["account"] = _account_payload(suffix)
        out["positions"] = _positions_payload()
        for cmd in orders or []:
            out["results"].append(_execute_order(cmd))
    except Exception as e:
        out["error"] = str(e)
    finally:
        mt5.shutdown()
    return out
