"""Myfxbook 社区多空情绪：后端抓取 + 内存缓存，替代此前的 Vercel Edge Function 代理。

之前的实现让浏览器/Vercel Edge Function 直接请求 myfxbook.com，被其 Cloudflare
风控拦截；排查证实**不是** User-Agent/请求头的问题——用 `curl` 带同样的请求头
能拿到 200，但 Python `requests` 库带一模一样的请求头却被 403：Cloudflare 是按
**TLS/HTTP 指纹（JA3）**识别出 `requests`（urllib3）的 SSL 握手特征，与请求头
内容无关。因此改用 `curl_cffi`（基于 curl-impersonate，模拟真实 Chrome 的 TLS
指纹）发起请求，本地验证可稳定拿到 200 与完整页面。

这里从后端 VPS 定时抓取一次，解析结果落进程内缓存；接口只读缓存，从不在请求
路径上现抓，抓取失败时也照常返回上一次成功的数据（陈旧但可用）。

Myfxbook community long/short sentiment: fetched and cached in-process on the
backend, replacing the old Vercel Edge Function proxy. Confirmed by testing
that this was **not** a header/User-Agent problem — `curl` with the exact same
headers gets 200, while Python's `requests` library with identical headers
gets 403: Cloudflare fingerprints the TLS/HTTP handshake (JA3) and flags
`requests`/urllib3's SSL signature specifically, independent of header
content. Switched to `curl_cffi` (built on curl-impersonate, mimics a real
Chrome TLS fingerprint), verified locally to reliably return 200 with the full
page.

Fetches periodically from the backend VPS and caches the parsed result; the
read path never fetches on-demand, and a failed refresh still serves the last
known-good data (stale but usable).
"""
import asyncio
import logging
import re
import time

from curl_cffi import requests

logger = logging.getLogger("prismx.myfxbook")

MYFXBOOK_URL = "https://www.myfxbook.com/community/outlook"
REFRESH_INTERVAL_SECONDS = 5 * 60  # 与前端原轮询周期一致 / matches the old frontend poll cadence
FETCH_TIMEOUT_SECONDS = 15

# 关注的品种（BTC 不在 Myfxbook 上）/ symbols we care about (BTC isn't on Myfxbook)
WATCH_SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "EURGBP", "XAUUSD", "XAGUSD"]

_SYMBOL_PATTERNS = {
    sym: re.compile(
        rf"/community/outlook/{sym}[\s\S]*?Short[\s\S]*?(\d+)%[\s\S]*?Long[\s\S]*?(\d+)%",
        re.IGNORECASE,
    )
    for sym in WATCH_SYMBOLS
}

# curl_cffi 的 impersonate 目标已经带上匹配 Chrome124 的完整浏览器请求头/TLS
# 指纹组合，这里只再加一个 Referer——真正起作用的是 impersonate，不是这些头。
# curl_cffi's impersonate target already sends a full Chrome124-matching header
# set alongside the TLS fingerprint; Referer is the only header added on top —
# impersonate is what actually matters here, not header content.
_HEADERS = {"Referer": "https://www.myfxbook.com/"}
_IMPERSONATE = "chrome124"

# 最近一次成功解析的结果，随时可读；抓取失败时保留旧值不覆盖。
# Last successfully parsed result; kept as-is (not cleared) when a refresh fails.
_cache: dict[str, dict[str, int]] = {}
_updated_at: float | None = None
_last_error: str | None = None


def _parse(html: str) -> dict[str, dict[str, int]]:
    result: dict[str, dict[str, int]] = {}
    for sym, pattern in _SYMBOL_PATTERNS.items():
        m = pattern.search(html)
        if m:
            result[sym] = {"shortPct": int(m.group(1)), "longPct": int(m.group(2))}
    return result


def _fetch_once() -> dict[str, dict[str, int]]:
    """同步抓取一次并解析（阻塞网络调用，调用方须放线程池执行）。
    Fetch and parse once (blocking network call; caller must offload to a thread pool)."""
    resp = requests.get(
        MYFXBOOK_URL, headers=_HEADERS, timeout=FETCH_TIMEOUT_SECONDS, impersonate=_IMPERSONATE
    )
    resp.raise_for_status()
    html = resp.text
    if not html or len(html) < 1000 or "community/outlook" not in html:
        raise ValueError("unexpected response body from Myfxbook")
    parsed = _parse(html)
    if not parsed:
        raise ValueError("no sentiment data parsed from Myfxbook response")
    return parsed


def refresh() -> bool:
    """抓取一次并在成功时更新缓存；失败只记录错误，缓存保持上次的值。
    Fetch once and update the cache on success; on failure, just log — the
    cache keeps its last value. 返回是否成功 / returns whether it succeeded."""
    global _cache, _updated_at, _last_error
    try:
        parsed = _fetch_once()
        _cache = parsed
        _updated_at = time.time()
        _last_error = None
        return True
    except Exception as e:  # noqa: BLE001 — 抓取失败是预期路径，不应中断后台循环
        _last_error = str(e)
        logger.warning("myfxbook refresh failed: %s", e)
        return False


def get_sentiment() -> dict:
    """返回当前缓存的情绪数据（可能是陈旧值），供路由直接读取，不触发抓取。
    Return the currently cached sentiment (possibly stale) for the router to
    read directly; never triggers a fetch itself."""
    return {
        "sentiment": _cache,
        "updatedAt": _updated_at,
        "stale": _last_error is not None,
    }


async def myfxbook_sentiment_loop() -> None:
    """启动时立即抓取一次，之后每 REFRESH_INTERVAL_SECONDS 刷新一次。
    Fetch once immediately at startup, then refresh every REFRESH_INTERVAL_SECONDS."""
    from starlette.concurrency import run_in_threadpool

    while True:
        try:
            ok = await run_in_threadpool(refresh)
            if ok:
                logger.info("myfxbook sentiment refreshed: %d symbols", len(_cache))
        except Exception:
            logger.exception("myfxbook_sentiment_loop error")
        await asyncio.sleep(REFRESH_INTERVAL_SECONDS)
