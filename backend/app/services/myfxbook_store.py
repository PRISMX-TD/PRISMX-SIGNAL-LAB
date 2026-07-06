"""Myfxbook 社区多空情绪：官方 API + 内存缓存。

早先两版实现都是抓 myfxbook.com 的网页再正则解析：先是浏览器/Vercel Edge
Function 直连（被 Cloudflare 拦截），后改成后端用 curl_cffi 模拟 Chrome TLS
指纹 + session 热身 + 多套指纹轮换抓（生产 VPS 上依然稳定 403——本地其他网络
能通但 VPS 不行，说明 Cloudflare 是按腾讯云这类云服务商的 IP/ASN 信誉整体拦截，
不是针对单次请求的指纹/头伪装能绕开的）。

这里改用 Myfxbook 官方 API（需要一个 Myfxbook 账号换 session），是结构性的
解法：走的是官方开放给第三方开发者的接口，不再是网页抓取，自然不会被同一层
反爬拦截。免费额度每 24 小时 100 次，因此把刷新间隔放宽到 20 分钟（约 72
次/天），留出余量给失败重试。

Myfxbook community long/short sentiment: official API + in-process cache.

Two earlier attempts scraped myfxbook.com's HTML and regex-parsed it: first
via a browser/Vercel Edge Function (blocked by Cloudflare), then via the
backend using curl_cffi (Chrome TLS impersonation) with session warm-up and
fingerprint rotation (still a consistent 403 from the production VPS — worked
fine from other networks, pointing to Cloudflare blocking by source IP/ASN
reputation, a layer that per-request fingerprint spoofing can't get past).

Switched to Myfxbook's official API (requires an account, exchanged for a
session) as the structural fix: it's a real third-party developer endpoint,
not scraping, so it isn't subject to the same anti-bot layer. Free tier is
100 calls/24h, so the refresh interval here is widened to 20 minutes (~72
calls/day), leaving headroom for retries.
"""
import asyncio
import logging
import time

import requests

from app.core.config import settings

logger = logging.getLogger("prismx.myfxbook")

LOGIN_URL = "https://www.myfxbook.com/api/login.json"
OUTLOOK_URL = "https://www.myfxbook.com/api/get-community-outlook.json"
REFRESH_INTERVAL_SECONDS = 20 * 60  # 20 分钟，配合免费额度 100 次/天留余量
FETCH_TIMEOUT_SECONDS = 15

# 关注的品种（BTC 不在 Myfxbook 上）/ symbols we care about (BTC isn't on Myfxbook)
WATCH_SYMBOLS = {"EURUSD", "GBPUSD", "USDJPY", "EURGBP", "XAUUSD", "XAGUSD"}

# 当前登录 session；失效（"Invalid session"）时清空并在下次 refresh 重新登录。
# Current login session; cleared on "Invalid session" so the next refresh re-logs-in.
_session: str | None = None

# 最近一次成功解析的结果，随时可读；抓取失败时保留旧值不覆盖。
# Last successfully parsed result; kept as-is (not cleared) when a refresh fails.
_cache: dict[str, dict[str, int]] = {}
_updated_at: float | None = None
_last_error: str | None = None


def _login() -> str:
    """用配置的账号换取 session；账号未配置或登录失败均抛异常。

    登录请求把密码放在 URL query string 里（Myfxbook API 的设计，我们改不了），
    requests 的 HTTPError 默认 str() 会把完整请求 URL（含密码）带进异常消息——
    这里统一捕获后抛出不含 URL 的 sanitized 异常，避免密码经 _last_error/日志
    泄露。

    Exchange the configured account for a session; raises if unconfigured or
    the login itself fails.

    The login request carries the password in the URL query string (Myfxbook's
    API design, not something we control); requests' HTTPError.__str__()
    includes the full request URL (password included) by default. Catch it
    here and raise a sanitized, URL-free error so the password never leaks via
    _last_error/logs.
    """
    if not settings.MYFXBOOK_EMAIL or not settings.MYFXBOOK_PASSWORD:
        raise RuntimeError("MYFXBOOK_EMAIL/MYFXBOOK_PASSWORD not configured")
    try:
        resp = requests.get(
            LOGIN_URL,
            params={"email": settings.MYFXBOOK_EMAIL, "password": settings.MYFXBOOK_PASSWORD},
            timeout=FETCH_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        raise RuntimeError(f"Myfxbook login request failed: HTTP {getattr(e.response, 'status_code', '?')}") from None
    if data.get("error"):
        # 不把密码回显进异常消息 / never echo the password into the exception message
        raise RuntimeError(f"Myfxbook login failed: {data.get('message')}")
    return data["session"]


def _fetch_outlook(session: str) -> dict[str, dict[str, int]]:
    """用给定 session 拉取社区多空情绪，过滤到我们关注的品种。
    Fetch community sentiment with the given session, filtered to WATCH_SYMBOLS."""
    resp = requests.get(
        OUTLOOK_URL, params={"session": session}, timeout=FETCH_TIMEOUT_SECONDS
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("error"):
        raise RuntimeError(f"Myfxbook outlook failed: {data.get('message')}")
    result: dict[str, dict[str, int]] = {}
    for row in data.get("symbols", []):
        name = row.get("name")
        if name in WATCH_SYMBOLS:
            result[name] = {
                "shortPct": int(row.get("shortPercentage", 0)),
                "longPct": int(row.get("longPercentage", 0)),
            }
    if not result:
        raise ValueError("no watched symbols found in Myfxbook outlook response")
    return result


def _fetch_once() -> dict[str, dict[str, int]]:
    """复用现有 session；若无 session 或已失效（Invalid session）则重新登录一次
    再重试。阻塞网络调用，调用方须放线程池执行。
    Reuse the existing session; if there is none, or it's invalid, log in once
    and retry. Blocking network calls; caller must offload to a thread pool."""
    global _session
    if _session is None:
        _session = _login()
    try:
        return _fetch_outlook(_session)
    except RuntimeError as e:
        if "session" not in str(e).lower():
            raise
        # session 过期：重新登录一次再试，仍失败就让异常往上抛
        # session expired: re-login once and retry; a second failure propagates
        _session = _login()
        return _fetch_outlook(_session)


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
