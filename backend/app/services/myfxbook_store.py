"""Myfxbook 社区多空情绪：官方 API + 内存缓存。

早先两版实现都是抓 myfxbook.com 的网页再正则解析：先是浏览器/Vercel Edge
Function 直连（被 Cloudflare 拦截），后改成后端用 curl_cffi 模拟 Chrome TLS
指纹 + session 热身 + 多套指纹轮换抓（生产 VPS 上依然稳定 403——本地其他网络
能通但 VPS 不行，说明 Cloudflare 是按腾讯云这类云服务商的 IP/ASN 信誉整体拦截，
不是针对单次请求的指纹/头伪装能绕开的）。

改用 Myfxbook 官方 API（需要账号换 session）本以为是结构性解法，结果生产 VPS
上连 `/api/login.json` 都被 Cloudflare 拦下——而且不是简单 403，是一个
"Just a moment..." 的 **JS 挑战页**（Managed Challenge，需要真正执行 JS 才能
过）。这说明 Cloudflare 是对这台 VPS 的**整个域名**按 IP/ASN 信誉下发挑战，
跟走 HTML 页面还是官方 API 无关，任何纯 HTTP 客户端（requests/curl_cffi）
都无法通过——必须有能跑 JS 的浏览器引擎。

因此这里改用 Playwright 起一个无头 Chromium，真正加载页面、跑完挑战的 JS、
拿到过关后的 cookie，再读页面里渲染出的 JSON 文本解析（登录和查询复用同一个
浏览器 context，过一次挑战即可，不用两次都触发）。免费 API 额度每 24 小时
100 次，因此把刷新间隔放宽到 20 分钟（约 72 次/天），留出余量给失败重试。
**这依然是尽力而为**：如果这台 VPS 的 IP 触发的是需要人工交互的挑战（而非
纯 JS 自动过关的 managed 挑战），无头浏览器也无能为力。

Myfxbook community long/short sentiment: official API + in-process cache.

Switching to Myfxbook's official API (an account exchanged for a session) was
meant to be the structural fix, but the production VPS gets blocked even on
`/api/login.json` — not a plain 403, but a "Just a moment..." **JS challenge**
page (Cloudflare Managed Challenge, which requires actually executing JS to
pass). This means Cloudflare issues the challenge for the VPS's IP/ASN across
the **entire domain**, regardless of whether the request targets an HTML page
or the official API — no pure HTTP client (requests/curl_cffi) can get past
that; it takes a real JS-executing browser engine.

So this now uses Playwright to drive a headless Chromium: actually load the
page, let the challenge JS run to completion, capture the resulting cookies,
then read and parse the JSON rendered in the page body (login and the outlook
query share one browser context, so the challenge only needs to be solved
once per refresh, not twice). The free API tier is 100 calls/24h, so the
refresh interval is widened to 20 minutes (~72 calls/day), leaving headroom
for retries. **Still best-effort**: if this VPS's IP triggers a challenge that
needs human interaction (rather than a pure-JS "managed" challenge), a
headless browser can't solve it either.
"""
import asyncio
import json
import logging
import time
from urllib.parse import urlencode

from playwright.sync_api import sync_playwright

from app.core.config import settings

logger = logging.getLogger("prismx.myfxbook")

LOGIN_URL = "https://www.myfxbook.com/api/login.json"
OUTLOOK_URL = "https://www.myfxbook.com/api/get-community-outlook.json"
REFRESH_INTERVAL_SECONDS = 20 * 60  # 20 分钟，配合免费额度 100 次/天留余量
FETCH_TIMEOUT_SECONDS = 20

# 一个能跑挑战 JS 的真实浏览器 UA；无头模式默认的 UA 会带 "Headless" 字样，
# 单这一点就足以被基础检测识别，所以显式换成普通 Chrome 的 UA。
# A real-browser UA that can run challenge JS; headless mode's default UA
# includes the word "Headless", which alone is enough for basic detection to
# flag it, so it's explicitly swapped for a plain desktop Chrome UA.
_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
# Cloudflare JS 挑战跑完到内容真正渲染出来的最长等待时间（秒）。
# Max time (s) to wait for the Cloudflare JS challenge to finish and the real
# content to render.
_CHALLENGE_MAX_WAIT_SECONDS = 20

# 关注的品种（BTC 不在 Myfxbook 上）/ symbols we care about (BTC isn't on Myfxbook)
WATCH_SYMBOLS = {"EURUSD", "GBPUSD", "USDJPY", "EURGBP", "XAUUSD", "XAGUSD"}

# 最近一次成功解析的结果，随时可读；抓取失败时保留旧值不覆盖。
# Last successfully parsed result; kept as-is (not cleared) when a refresh fails.
_cache: dict[str, dict[str, int]] = {}
_updated_at: float | None = None
_last_error: str | None = None


def _goto_json(page, url: str) -> dict:
    """导航到一个返回 JSON 的 URL，等 Cloudflare 挑战（若触发）跑完，读取
    页面渲染出的文本按 JSON 解析。

    浏览器打开一个 JSON 接口时，内容会被渲染进 <body>（通常包在 <pre> 里），
    用 innerText 取比拿完整 HTML 再挖字符串更直接。

    Navigate to a URL that returns JSON, wait out the Cloudflare challenge (if
    triggered), and parse the rendered body text as JSON.

    When a browser opens a JSON endpoint, the content is rendered into <body>
    (typically wrapped in a <pre>); reading innerText is more direct than
    pulling the raw HTML and digging the text out.
    """
    page.goto(url, wait_until="domcontentloaded", timeout=FETCH_TIMEOUT_SECONDS * 1000)
    deadline = time.time() + _CHALLENGE_MAX_WAIT_SECONDS
    text = page.evaluate("() => document.body.innerText")
    while "Just a moment" in text and time.time() < deadline:
        page.wait_for_timeout(1000)
        text = page.evaluate("() => document.body.innerText")
    return json.loads(text)


def _fetch_via_browser() -> dict[str, dict[str, int]]:
    """用无头 Chromium 依次访问登录接口、情绪接口；同一个 browser context
    复用 cookie，挑战只需过一次。账号未配置直接抛异常。阻塞调用，调用方须
    放线程池执行。

    Visit the login endpoint then the outlook endpoint with a headless
    Chromium; both share one browser context's cookies, so the challenge only
    needs solving once. Raises immediately if the account isn't configured.
    Blocking call; caller must offload to a thread pool.
    """
    if not settings.MYFXBOOK_EMAIL or not settings.MYFXBOOK_PASSWORD:
        raise RuntimeError("MYFXBOOK_EMAIL/MYFXBOOK_PASSWORD not configured")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        try:
            context = browser.new_context(user_agent=_BROWSER_UA, locale="en-US")
            # navigator.webdriver=true 是最基础的无头检测信号之一，抹掉它。
            # navigator.webdriver=true is one of the most basic headless-detection
            # signals; strip it.
            context.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            )
            page = context.new_page()

            # Playwright 的导航异常常把完整目标 URL 回显进异常文本，登录 URL 里
            # 带着密码——这里统一捕获后抛出不含 URL 的 sanitized 异常，避免密码
            # 经 _last_error/日志泄露。
            # Playwright's navigation exceptions often echo the full target URL
            # into their text, and the login URL carries the password — catch
            # broadly here and raise a sanitized, URL-free error so the
            # password never leaks via _last_error/logs.
            login_qs = urlencode({"email": settings.MYFXBOOK_EMAIL, "password": settings.MYFXBOOK_PASSWORD})
            try:
                login_data = _goto_json(page, f"{LOGIN_URL}?{login_qs}")
            except Exception:
                raise RuntimeError("Myfxbook login navigation failed") from None
            if login_data.get("error"):
                raise RuntimeError(f"Myfxbook login failed: {login_data.get('message')}")
            session = login_data["session"]

            outlook_qs = urlencode({"session": session})
            outlook_data = _goto_json(page, f"{OUTLOOK_URL}?{outlook_qs}")
        finally:
            browser.close()

    if outlook_data.get("error"):
        raise RuntimeError(f"Myfxbook outlook failed: {outlook_data.get('message')}")
    result: dict[str, dict[str, int]] = {}
    for row in outlook_data.get("symbols", []):
        name = row.get("name")
        if name in WATCH_SYMBOLS:
            result[name] = {
                "shortPct": int(row.get("shortPercentage", 0)),
                "longPct": int(row.get("longPercentage", 0)),
            }
    if not result:
        raise ValueError("no watched symbols found in Myfxbook outlook response")
    return result


def refresh() -> bool:
    """抓取一次并在成功时更新缓存；失败只记录错误，缓存保持上次的值。
    Fetch once and update the cache on success; on failure, just log — the
    cache keeps its last value. 返回是否成功 / returns whether it succeeded."""
    global _cache, _updated_at, _last_error
    try:
        parsed = _fetch_via_browser()
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
