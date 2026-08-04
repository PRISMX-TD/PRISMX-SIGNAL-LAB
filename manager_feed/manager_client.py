"""Manager API 客户端：连接管理、报价与 M1 获取。
Manager API client: connection handling, quotes and M1 retrieval.

实测要点（对 192.109.17.69:443 验证）：
  * 取报价需要 PUMP_MODE_SYMBOLS；带 group 参数的 TickLast 还需 PUMP_MODE_GROUPS，
    否则返回 MT_RET_ERR_NOTFOUND。
  * ChartRequest(symbol, from, to) 只返回 M1，没有周期参数。
  * 点差由品种后缀决定，与组无关：XAUUSD 点差 0.08（原始流），XAUUSD.s 点差 0.19
    （标准档）。所以查询用带后缀的真名，不必传 group。
  * digits 不在 tick 里，要从 SymbolGet(name).Digits 取。

Measured against 192.109.17.69:443:
  * quotes need PUMP_MODE_SYMBOLS; a TickLast with a group argument also needs
    PUMP_MODE_GROUPS or it returns MT_RET_ERR_NOTFOUND.
  * ChartRequest(symbol, from, to) returns M1 only; it takes no timeframe.
  * spread comes from the symbol suffix, not the group: XAUUSD spreads 0.08 (raw)
    while XAUUSD.s spreads 0.19 (standard tier). So query the suffixed real name
    and don't bother passing a group.
  * digits aren't on the tick; read SymbolGet(name).Digits.
"""
from __future__ import annotations

import logging
import time

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT_MS = 30000

# 重连退避：从 5 秒起翻倍，上限 60 秒。断线期间不上报任何数据。
# Reconnect backoff: from 5s, doubling, capped at 60s. Nothing is pushed while down.
RECONNECT_BACKOFF_START = 5
RECONNECT_BACKOFF_MAX = 60


class ManagerClient:
    """封装 MT5Manager.ManagerAPI，提供重连与取数。

    MT5Manager 是 Windows 原生 DLL 的绑定，导入放在方法里而不是模块顶层，好让配置
    检查、聚合测试这些不需要连接的路径在任何平台上都能跑。

    Wraps MT5Manager.ManagerAPI with reconnection and data access.

    MT5Manager binds a Windows-only native DLL, so the import lives inside the
    method rather than at module scope — config checks and aggregation tests then
    run on any platform.
    """

    def __init__(self, server: str, login: int, password: str):
        self.server = server
        self.login = login
        self.password = password
        self._api = None
        self._connected = False
        self._digits_cache: dict[str, int] = {}
        self._backoff = RECONNECT_BACKOFF_START
        self._last_attempt_at = 0.0

    @property
    def connected(self) -> bool:
        return self._connected

    def connect(self) -> bool:
        """连接。已连接则直接返回 True。
        Connect; returns True immediately when already connected."""
        if self._connected:
            return True

        # 退避：连接失败后不要每轮都重试，避免把服务器当成暴力破解来源。
        # Backoff: don't retry every tick after a failure, which could look like
        # a brute-force source to the server.
        elapsed = time.time() - self._last_attempt_at
        if self._last_attempt_at and elapsed < self._backoff:
            return False
        self._last_attempt_at = time.time()

        try:
            import MT5Manager
        except ImportError:
            logger.error(
                "缺少 MT5Manager 包，请运行 pip install MT5Manager"
                " / MT5Manager is missing, run: pip install MT5Manager"
            )
            return False

        api = MT5Manager.ManagerAPI()
        pump = (
            MT5Manager.ManagerAPI.EnPumpModes.PUMP_MODE_SYMBOLS
            | MT5Manager.ManagerAPI.EnPumpModes.PUMP_MODE_GROUPS
        )
        logger.info("连接 %s login=%s / connecting", self.server, self.login)
        ok = api.Connect(self.server, self.login, self.password, pump, CONNECT_TIMEOUT_MS)
        if not ok:
            self._backoff = min(self._backoff * 2, RECONNECT_BACKOFF_MAX)
            logger.error(
                "连接失败：%s，%d 秒后重试 / connect failed, retrying in %ds",
                MT5Manager.LastError(), self._backoff, self._backoff,
            )
            return False

        self._api = api
        self._connected = True
        self._backoff = RECONNECT_BACKOFF_START
        self._digits_cache.clear()
        logger.info("已连接 / connected")
        return True

    def disconnect(self) -> None:
        if self._api is not None and self._connected:
            try:
                self._api.Disconnect()
            except Exception:  # noqa: BLE001 - 关闭失败无需处理 / nothing to do on close failure
                logger.debug("Disconnect 抛错，忽略 / Disconnect raised, ignoring", exc_info=True)
        self._api = None
        self._connected = False

    def _mark_disconnected(self, reason: str) -> None:
        """标记掉线。调用方随后停止上报，等下一轮 connect() 重连。
        Mark the link down; callers stop pushing and the next connect() retries."""
        if self._connected:
            logger.warning("连接已断开：%s / connection lost", reason)
        self.disconnect()

    # ---------- 品种 / symbols ----------

    def subscribe(self, broker_symbols: list[str]) -> None:
        """把品种加入订阅列表，服务器才会泵它们的 tick。
        Add symbols to the selected list so the server pumps their ticks."""
        if not self._connected:
            return
        for sym in broker_symbols:
            if self._api.SelectedAdd(sym) is False:
                logger.warning("订阅失败 %s / SelectedAdd failed", sym)

    def digits(self, broker_symbol: str) -> int:
        """品种小数位。启动时读一次后缓存——品种规格几乎不变，不必每 tick 查。
        Symbol digits, cached after the first read: specs barely change, so there's
        no need to query per tick."""
        if broker_symbol in self._digits_cache:
            return self._digits_cache[broker_symbol]
        if not self._connected:
            return 5
        cfg = self._api.SymbolGet(broker_symbol)
        if cfg is False or cfg is None:
            logger.warning("读不到品种配置 %s / SymbolGet failed", broker_symbol)
            return 5
        self._digits_cache[broker_symbol] = cfg.Digits
        return cfg.Digits

    def list_all_symbols(self) -> list[dict]:
        """全部可见品种，供后台下拉框使用。

        后端运行在 Linux 上、无法调用 Manager API，所以这份清单由网关上报。

        Every visible symbol, for the admin dropdown.

        The backend runs on Linux and can't call Manager API, so the gateway
        reports this list.
        """
        if not self._connected:
            return []
        total = self._api.SymbolTotal()
        if total is False or total is None:
            return []
        out = []
        for i in range(total):
            cfg = self._api.SymbolNext(i)
            if cfg is False or cfg is None:
                continue
            out.append({"name": cfg.Symbol, "path": cfg.Path, "digits": cfg.Digits, "description": ""})
        return out

    # ---------- 报价 / quotes ----------

    def tick(self, broker_symbol: str) -> dict | None:
        """最新报价。取不到返回 None（调用方据此跳过，不推旧价）。

        不传 group 参数：实测点差由后缀决定，用 STD 组查询 ECN 专属品种 BTCUSD.p 得到
        的值与用 ECN 组查询完全相同，传 group 只会多一处出错可能。

        Latest quote, or None when unavailable (callers skip rather than push a
        stale price).

        No group argument: spread is measured to come from the suffix — querying
        the ECN-only BTCUSD.p through the STD group returns exactly what the ECN
        group returns — so passing a group only adds a failure mode.
        """
        if not self._connected:
            return None
        t = self._api.TickLast(broker_symbol)
        if t is False or t is None:
            return None
        return {
            "bid": t.bid,
            "ask": t.ask,
            "datetime": t.datetime,
            "datetime_msc": t.datetime_msc,
        }

    # ---------- K 线 / candles ----------

    def m1_bars(self, broker_symbol: str, from_ts: int, to_ts: int) -> list[dict] | None:
        """区间内的 M1。返回 None 表示请求失败，返回 [] 表示这段确实没有数据。

        区分这两种情况很重要：失败要记日志排查，空是休市/无成交的正常结果，不该当成
        异常，更不该用上一根填充。

        M1 bars in the range. None means the request failed; [] means the range
        genuinely holds no data.

        The distinction matters: a failure deserves a log line, while empty is the
        normal outcome of a closed or untraded stretch — not an error, and never a
        reason to fill from the previous bar.
        """
        if not self._connected:
            return None
        bars = self._api.ChartRequest(broker_symbol, from_ts, to_ts)
        if bars is False or bars is None:
            try:
                import MT5Manager
                err = MT5Manager.LastError()
            except ImportError:
                err = "unknown"
            logger.warning("ChartRequest 失败 %s: %s / failed", broker_symbol, err)
            return None
        return [
            {
                "t": b.datetime,
                "o": b.open,
                "h": b.high,
                "l": b.low,
                "c": b.close,
                "v": b.tick_volume,
            }
            for b in bars
        ]
