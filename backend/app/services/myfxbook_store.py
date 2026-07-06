"""Myfxbook 社区多空情绪：后端抓取 + 内存缓存，替代此前的 Vercel Edge Function 代理。

之前的实现让浏览器/Vercel Edge Function 直接请求 myfxbook.com，被其 Cloudflare
风控拦截；排查证实**不是** User-Agent/请求头的问题——本地用 `curl` 或 `curl_cffi`
（模拟 Chrome TLS 指纹）都能稳定拿到 200，但从生产 VPS（腾讯云）用完全一样的
`curl_cffi` 请求却持续 403。两地结果不同，说明 Cloudflare 这次拦截的不(仅)是
TLS/HTTP 指纹，很可能是**按来源 IP/ASN 信誉**拦截——腾讯云这类云服务商的出口
IP 段常被云端风控归为"数据中心流量"直接降权/拦截，这一层无法靠伪装单次请求的
指纹绕开。

这里退而求其次，做两件成本低、无需账号的补救：① 用同一个会话先访问首页拿
cookie，再访问情绪页（模拟真实用户先进站再点子页面，而非冷启动直接打子页面）；
② 轮流尝试多套 Chrome/Edge TLS 指纹，记住上次成功的指纹下次优先用。如果 VPS
的 IP/ASN 本身被基于信誉整体拦截，这两招大概率也无效——真正稳定的路子是
Myfxbook 官方 API（需要账号换 session），见本文件历史 diff 的讨论。

从后端 VPS 定时抓取一次，解析结果落进程内缓存；接口只读缓存，从不在请求路径上
现抓，抓取失败时也照常返回上一次成功的数据（陈旧但可用）。

Myfxbook community long/short sentiment: fetched and cached in-process on the
backend, replacing the old Vercel Edge Function proxy. Confirmed this is
**not** (only) a header/User-Agent problem — `curl`/`curl_cffi` (Chrome TLS
impersonation) both reliably return 200 locally, but the exact same
`curl_cffi` call from the production VPS (Tencent Cloud) consistently gets
403. Different results from different networks point to Cloudflare blocking
by **source IP/ASN reputation** — cloud-provider egress ranges are commonly
downranked/blocked as "data center traffic" by bot management, a layer that
spoofing a single request's fingerprint can't get around.

Two low-cost, account-free mitigations here: ① warm up a session by visiting
the homepage first and reusing its cookies for the outlook page (mimicking a
real user landing then clicking through, rather than a cold hit on the
sub-page); ② rotate through several Chrome/Edge TLS fingerprints, remembering
the last one that worked. If the VPS's IP/ASN is reputation-blocked outright,
neither trick is likely to help — the durable fix is Myfxbook's official API
(requires an account to exchange for a session).

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

MYFXBOOK_HOME_URL = "https://www.myfxbook.com/"
MYFXBOOK_URL = "https://www.myfxbook.com/community/outlook"
REFRESH_INTERVAL_SECONDS = 5 * 60  # 与前端原轮询周期一致 / matches the old frontend poll cadence
FETCH_TIMEOUT_SECONDS = 15

# 依次尝试的 TLS 指纹；成功过的会被记到 _last_good_impersonate 并优先重试。
# TLS fingerprints to try in order; the last one that worked is remembered in
# _last_good_impersonate and tried first next time.
IMPERSONATE_CANDIDATES = ["chrome124", "chrome131", "chrome120", "chrome110", "edge101"]
_last_good_impersonate: str | None = None

# 关注的品种（BTC 不在 Myfxbook 上）/ symbols we care about (BTC isn't on Myfxbook)
WATCH_SYMBOLS = ["EURUSD", "GBPUSD", "USDJPY", "EURGBP", "XAUUSD", "XAGUSD"]

_SYMBOL_PATTERNS = {
    sym: re.compile(
        rf"/community/outlook/{sym}[\s\S]*?Short[\s\S]*?(\d+)%[\s\S]*?Long[\s\S]*?(\d+)%",
        re.IGNORECASE,
    )
    for sym in WATCH_SYMBOLS
}

# curl_cffi 的 impersonate 目标已经带上匹配对应浏览器版本的请求头/TLS 指纹组合，
# 这里只再加一个 Referer——真正起作用的是 impersonate，不是这些头。
# curl_cffi's impersonate target already sends a header set matching the
# corresponding browser version alongside the TLS fingerprint; Referer is the
# only header added on top — impersonate is what actually matters, not headers.
_HEADERS = {"Referer": "https://www.myfxbook.com/"}

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


def _try_fetch(impersonate: str) -> dict[str, dict[str, int]]:
    """用指定 TLS 指纹尝试一次：先热身访问首页拿 cookie，复用同一 session
    访问情绪页，减少"冷启动直接打子页面"的机器人特征。
    Attempt one fetch with the given TLS fingerprint: warm up by visiting the
    homepage first, then reuse the same session's cookies for the outlook
    page — reduces the "cold hit on a sub-page" bot signal."""
    with requests.Session(impersonate=impersonate) as s:
        s.get(MYFXBOOK_HOME_URL, headers=_HEADERS, timeout=FETCH_TIMEOUT_SECONDS)
        resp = s.get(MYFXBOOK_URL, headers=_HEADERS, timeout=FETCH_TIMEOUT_SECONDS)
    resp.raise_for_status()
    html = resp.text
    if not html or len(html) < 1000 or "community/outlook" not in html:
        raise ValueError("unexpected response body from Myfxbook")
    parsed = _parse(html)
    if not parsed:
        raise ValueError("no sentiment data parsed from Myfxbook response")
    return parsed


def _fetch_once() -> dict[str, dict[str, int]]:
    """依次尝试各 TLS 指纹（上次成功的排最前），第一个成功的即返回；
    全部失败则抛出最后一个异常。阻塞网络调用，调用方须放线程池执行。
    Try each TLS fingerprint in turn (last-successful one first); return on
    the first success, or raise the last exception if all fail. Blocking
    network call; caller must offload to a thread pool."""
    global _last_good_impersonate
    order = IMPERSONATE_CANDIDATES
    if _last_good_impersonate and _last_good_impersonate in order:
        order = [_last_good_impersonate] + [x for x in order if x != _last_good_impersonate]

    last_exc: Exception | None = None
    for impersonate in order:
        try:
            parsed = _try_fetch(impersonate)
            _last_good_impersonate = impersonate
            return parsed
        except Exception as e:  # noqa: BLE001 — try the next fingerprint
            last_exc = e
            continue
    assert last_exc is not None
    raise last_exc


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
