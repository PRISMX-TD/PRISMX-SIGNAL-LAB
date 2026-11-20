"""Narwhal API 客户端：只用财经日历一个接口 GET /economics/calendar。

实测（2026-11-20，免费账号）：每页最多 100 条；countries 是数组参数，要写成重复的
countries=USA&countries=GBR（逗号拼接返回 400）；每次成功调用花 $0.002，余额在响应头
x-narwhal-balance；短窗口限速约每分钟 8 次（x-ratelimit-short-*），比文档写的 50 次低。
出错和被限速的请求不计费。阻塞网络调用，调用方放线程池。

Narwhal client, calendar endpoint only. Measured 2026-11-20 on a free key: at most 100 rows per
page; `countries` is an array parameter sent as repeated keys (a comma list returns 400); each
successful call costs $0.002 with the balance in x-narwhal-balance; the short-window limit is
about 8 calls a minute. Failed and rate-limited calls are free. Blocking; run it in a thread pool.
"""
import logging
import time
from datetime import date

import httpx

from app.core.config import settings

logger = logging.getLogger("prismx.econ")

PAGE_LIMIT = 100
MAX_PAGES = 12
TIMEOUT = httpx.Timeout(40.0, connect=10.0)


class NarwhalError(Exception):
    pass


class NarwhalResult:
    def __init__(self) -> None:
        self.releases: list[dict] = []
        self.calls = 0
        self.balance: float | None = None


def configured() -> bool:
    return bool(settings.NARWHAL_API_KEY.strip())


def _get(client: httpx.Client, params: list[tuple[str, str]], out: NarwhalResult) -> dict:
    url = settings.NARWHAL_API_BASE.rstrip("/") + "/economics/calendar"
    headers = {"Authorization": f"Bearer {settings.NARWHAL_API_KEY.strip()}", "User-Agent": "prismx-calendar/1.0"}
    for attempt in range(2):
        try:
            resp = client.get(url, params=params, headers=headers, timeout=TIMEOUT)
        except httpx.HTTPError as exc:
            raise NarwhalError(f"无法连接 Narwhal / could not reach Narwhal: {exc}") from exc
        if resp.status_code == 429 and attempt == 0:
            # 被限速不计费：等到窗口重置再试一次 / rate-limited calls are free: wait for the window
            time.sleep(min(65.0, float(resp.headers.get("retry-after") or 30)))
            continue
        break
    bal = resp.headers.get("x-narwhal-balance")
    if bal:
        try:
            out.balance = float(bal)
        except ValueError:
            pass
    if resp.status_code in (401, 403):
        raise NarwhalError("Narwhal 拒绝了密钥，请检查 NARWHAL_API_KEY / Narwhal rejected the key")
    if resp.status_code == 402:
        raise NarwhalError("Narwhal 额度已用完 / Narwhal credit exhausted")
    if resp.status_code >= 400:
        raise NarwhalError(f"Narwhal 返回 {resp.status_code}: {resp.text[:200]}")
    out.calls += 1
    try:
        data = resp.json()
    except ValueError as exc:
        raise NarwhalError("Narwhal 返回的不是 JSON / non-JSON response") from exc
    if not isinstance(data, dict) or not isinstance(data.get("releases"), list):
        raise NarwhalError("Narwhal 返回格式异常 / unexpected response shape")
    return data


def fetch_calendar(countries: list[str], start: date, end: date, *, pause: float = 1.0) -> NarwhalResult:
    """取一段日期内这些国家的全部发布（自动翻页）。/ All releases for the countries and dates, paginated."""
    if not configured():
        raise NarwhalError("未配置 NARWHAL_API_KEY / NARWHAL_API_KEY is not set")
    out = NarwhalResult()
    base: list[tuple[str, str]] = [("countries", c) for c in countries]
    base += [("start_date", start.isoformat()), ("end_date", end.isoformat()), ("limit", str(PAGE_LIMIT))]
    cursor = None
    with httpx.Client() as client:
        for page in range(MAX_PAGES):
            params = base + ([("cursor", cursor)] if cursor else [])
            data = _get(client, params, out)
            out.releases.extend(r for r in data["releases"] if isinstance(r, dict))
            cursor = data.get("next_cursor")
            if not cursor:
                break
            if page == MAX_PAGES - 1:
                logger.warning("narwhal calendar: stopped after %d pages", MAX_PAGES)
            time.sleep(pause)
    return out
