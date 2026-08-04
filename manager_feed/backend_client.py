"""向后端上报行情。只用标准库，与 bridge/bridge_app.py 的做法一致。
Push market data to the backend. Standard library only, same as bridge_app.py.

三个端点的鉴权方式不同，是既有设计，这里照现状对接：
  * /feed/quotes、/feed/candles  → X-EA-Token 请求头
  * /webhook/trend              → JSON body 里的 "secret" 字段（后端同时接受
    WEBHOOK_SECRET 与 EA_TOKEN；这个设计源于 TradingView 不支持自定义请求头）

The three endpoints authenticate differently by existing design; this matches it:
  * /feed/quotes, /feed/candles → X-EA-Token header
  * /webhook/trend             → a "secret" field in the JSON body (the backend
    accepts either WEBHOOK_SECRET or EA_TOKEN; the design follows TradingView's
    inability to send custom headers)
"""
from __future__ import annotations

import json
import logging
from urllib import error, request

logger = logging.getLogger(__name__)

HTTP_TIMEOUT = 10.0

# 上报品种清单用更长的超时：481 个条目比行情包大一个数量级。
# A longer timeout for the symbol list: 481 entries dwarf a quote payload.
SYMBOL_LIST_TIMEOUT = 30.0


class BackendClient:
    def __init__(self, base_url: str, ea_token: str, dry_run: bool = False):
        self.base = base_url.rstrip("/")
        self.token = ea_token
        self.dry_run = dry_run

    def _post(self, path: str, payload: dict, use_header_auth: bool = True,
              timeout: float = HTTP_TIMEOUT) -> bool:
        """POST JSON。返回是否成功；失败只记日志，由调用方决定重试。
        POST JSON, returning success. Failures are logged; retry is the caller's call."""
        url = f"{self.base}{path}"
        if self.dry_run:
            logger.info("[dry-run] 跳过上报 %s（%d 字节）/ skipped", path, len(json.dumps(payload)))
            return True

        data = json.dumps(payload).encode("utf-8")
        req = request.Request(url, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        if use_header_auth:
            req.add_header("X-EA-Token", self.token)
        try:
            with request.urlopen(req, timeout=timeout) as resp:
                resp.read()
            return True
        except error.HTTPError as exc:
            # 401 单独提示：这是配置问题而非网络问题，值得说清楚
            # Call out 401 separately: a config problem, not a network one.
            if exc.code == 401:
                logger.error(
                    "%s 鉴权失败(401)，请检查 ea_token 是否与后端 EA_TOKEN 一致"
                    " / auth failed, check ea_token matches the backend's EA_TOKEN",
                    path,
                )
            else:
                logger.warning("%s 上报失败 HTTP %s / push failed", path, exc.code)
            return False
        except (error.URLError, TimeoutError, OSError) as exc:
            logger.warning("%s 上报失败：%s / push failed", path, exc)
            return False

    def push_quotes(self, quotes: list[dict]) -> bool:
        """报价快照。每项 {symbol, bid, ask, digits, closed}。
        Quote snapshot; each item is {symbol, bid, ask, digits, closed}."""
        if not quotes:
            return True
        return self._post("/api/feed/quotes", {"data": quotes})

    def push_candles(self, mode: str, series: list[dict]) -> bool:
        """K 线。mode=backfill 整段替换 / tick 合并最新几根 / history 只落库。

        每个 series 项：{symbol, interval, bars: [{t,o,h,l,c,v}, ...]}。

        Candles. mode=backfill replaces the series / tick merges the latest /
        history only persists.
        """
        if not series:
            return True
        return self._post("/api/feed/candles", {"mode": mode, "series": series})

    def push_trend(self, symbol: str, trends: dict[str, str],
                   high: float | None = None, low: float | None = None) -> bool:
        """多周期趋势。密钥走 body 而非请求头，见模块开头说明。

        high/low 是可选的：后端拿它们顺带判定该品种下未分胜负信号是否命中止盈/止损。
        两者都缺省时后端只更新趋势，不做胜负判定——所以宁可不传，也不要传不可靠的值。

        Multi-timeframe trend; the secret goes in the body, see the module note.

        high/low are optional: the backend uses them to resolve pending signals on
        this symbol against TP/SL. With either missing it updates the trend only,
        so omitting them is better than sending unreliable values.
        """
        payload: dict = {"secret": self.token, "symbol": symbol, "trends": trends}
        if high is not None and low is not None:
            payload["high"] = high
            payload["low"] = low
        return self._post("/api/webhook/trend", payload, use_header_auth=False)

    # ---------- 品种配置 / symbol configuration ----------

    def fetch_symbols(self) -> list[dict] | None:
        """从后端拉取要推送的品种配置。返回 None 表示拉取失败。

        失败必须与"配置为空"区分开：拉不到时调用方应保留当前配置继续跑，而不是把品种
        列表清空——后端重启或网络抖动不该让全站行情停掉。

        Fetch the push-symbol configuration. None means the fetch failed.

        Failure must stay distinct from "the config is empty": on failure the caller
        keeps its current config running rather than clearing the symbol list — a
        backend restart or network blip shouldn't stop site-wide market data.
        """
        url = f"{self.base}/api/feed/symbols-config"
        req = request.Request(url, method="GET")
        req.add_header("X-EA-Token", self.token)
        try:
            with request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                body = resp.read().decode("utf-8")
        except error.HTTPError as exc:
            if exc.code == 404:
                logger.debug("后端未提供品种配置端点 / no symbol-config endpoint")
            else:
                logger.warning("拉取品种配置失败 HTTP %s / fetch failed", exc.code)
            return None
        except (error.URLError, TimeoutError, OSError) as exc:
            logger.warning("拉取品种配置失败：%s / fetch failed", exc)
            return None

        try:
            data = json.loads(body)
        except ValueError:
            logger.warning("品种配置返回非 JSON / non-JSON symbol config")
            return None

        items = data.get("symbols")
        if not isinstance(items, list):
            return None

        out = []
        for it in items:
            if not isinstance(it, dict):
                continue
            display = str(it.get("display", "")).strip().upper()
            broker = str(it.get("broker", "")).strip()
            if not display or not broker:
                continue
            out.append({
                "display": display,
                "broker": broker,
                "enabled": bool(it.get("enabled", True)),
            })
        return out

    def report_broker_symbols(self, symbols: list[dict]) -> bool:
        """把券商可见品种清单上报给后端，供后台下拉框使用。

        后端跑在 Linux 上、无法调用 Manager API，这份清单只能由网关提供。

        Report the broker's visible symbols so the admin UI can offer a dropdown.

        The backend runs on Linux and can't call Manager API, so only the gateway
        can supply this.
        """
        if not symbols:
            return True
        return self._post(
            "/api/feed/broker-symbols",
            {"symbols": symbols},
            timeout=SYMBOL_LIST_TIMEOUT,
        )
