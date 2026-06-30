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

# 网页报价区展示的品种（与前端关注列表对齐）/ symbols shown in the web quote panel
QUOTE_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "XAGUSD", "BTCUSD", "USDJPY"]


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
        out.append({
            "symbol": base,
            "bid": float(tick.bid),
            "ask": float(tick.ask),
        })
    return out


def _positions_payload() -> list:
    """读取持仓 / read open positions.

    除基础字段外，补充 ticket（平仓/改单定位用）、入场价、现价、SL/TP，
    便于网页展示与执行平仓/改 SL·TP。
    Besides the basics, include ticket (needed to close/modify), entry price,
    current price and SL/TP so the web app can display and act on positions.
    """
    positions = mt5.positions_get()
    if not positions:
        return []
    out = []
    for p in positions:
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
            "login": str(mt5.account_info().login) if mt5.account_info() else None,
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
        "magic": 778899,
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
        "magic": 778899,
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
        "error": str | None,
      }
    """
    out = {"account": None, "positions": [], "quotes": [], "results": [], "error": None}
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
        out["quotes"] = _quotes_payload(QUOTE_SYMBOLS, suffix)
        for cmd in orders or []:
            out["results"].append(_dispatch_command(cmd))
    except Exception as e:
        out["error"] = str(e)
    finally:
        mt5.shutdown()
    return out
