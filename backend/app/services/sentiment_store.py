"""社区多空情绪：抓取 FXSSI 的公开聚合数据 + 内存缓存。

原先用 Myfxbook 作数据源，先后试过网页抓取（Cloudflare IP/ASN 信誉拦截）、
官方 API（同一道 Cloudflare 墙连 /api/ 路径也拦，返回需要执行 JS 的 Managed
Challenge）、无头 Playwright（Cloudflare 识别出 CDP 自动化特征，挑战页卡死不
过），三条路线全部被同一套逐层加码的反爬体系挡下，遂放弃 Myfxbook。

改用 FXSSI（fxssi.com）的公开数据接口：该站不在 Cloudflare 后面（Apache 直接
提供服务），其"当前比例"工具页面本身会对 `/api/current-ratios` 发起一次无需
登录、无需 cookie 的 GET 请求，返回多个真实券商的多空比原始数据外加一个已经
按券商权重算好的加权平均值（`pairs[symbol]['average']`）——含义与 Myfxbook 一致
（buy%/long%），比自己接入单一券商更能代表市场整体情绪。经浏览器实际网络请求
抓包确认了这就是页面自己在用的真实接口（不是猜的），本地直接用 requests 调用
即可拿到 200 与完整数据，无需任何伪装。

Community long/short sentiment: fetch FXSSI's public aggregate data + cache.

Previously sourced from Myfxbook; three escalating approaches (HTML scraping,
the official API, headless Playwright) were each blocked by the same
Cloudflare defense at a different layer (IP/ASN reputation, a JS Managed
Challenge even on /api/ paths, and CDP-automation fingerprinting that never
let the challenge clear) — abandoned.

Switched to FXSSI's public data endpoint instead: the site isn't behind
Cloudflare (plain Apache), and its "Current Ratio" tool page itself makes an
unauthenticated, cookie-free GET to `/api/current-ratios`, returning raw
long/short data from several real brokers plus a pre-computed broker-weighted
average per symbol (`pairs[symbol]['average']`) — semantically the same as
Myfxbook's (buy%/long%), and arguably more representative of overall market
sentiment than a single broker. Confirmed via capturing the page's own live
network traffic that this is the real endpoint it uses (not guessed); a plain
`requests` call reliably returns 200 with full data, no spoofing needed.

多 worker：抓取循环和其它后台循环一样只在领导 worker 上跑（services/background.py），
所以抓到的结果除了留在本进程，还要写进 shared_state，其它 worker 的 /sentiment 从那里
读——否则请求落到非领导 worker 上拿到的永远是空表，页面上的"市场情绪"就只剩占位。

Multiple workers: like every background loop, the fetch loop runs on the leader
worker only (services/background.py), so each result is also published to
shared_state and the other workers' /sentiment reads it from there — otherwise a
request landing on a non-leader worker always got an empty table and the
dashboard's sentiment rule showed only placeholders.
"""
import asyncio
import logging
import random
import time

import requests

from app.services import shared_cache, shared_state

logger = logging.getLogger("prismx.sentiment")

CURRENT_RATIOS_URL = "https://fxssi.com/api/current-ratios"
REFRESH_INTERVAL_SECONDS = 5 * 60  # 与前端原轮询周期一致 / matches the old frontend poll cadence
FETCH_TIMEOUT_SECONDS = 15
# 共享快照的寿命，从最后一次成功抓取算起：一直抓不到时旧数据最多再展示这么久（带
# stale=true），过期后前端回到占位，而不是无限期把几天前的比例当成当前情绪。
# Lifetime of the shared snapshot, counted from the last successful fetch: while
# fetches keep failing, the old data is served (stale=true) for at most this long,
# then the frontend falls back to its placeholder instead of showing days-old
# ratios as current sentiment.
SNAPSHOT_TTL_SECONDS = 24 * 3600
SNAPSHOT_KEY = "sentiment:snapshot"

# 关注的品种：与 EA（ea/PRISMX_MarketFeed.mq5）默认推送的品种矩阵对齐。
# FXSSI 不一定对每个品种都有数据（尤其 WTI/BTCUSD 这类非主流外汇对）——
# _fetch_once() 已经按 "average is None 就跳过" 处理，抓不到的品种自然不
# 出现在结果里，前端相应显示占位，不会报错。
# Symbols we care about: aligned with the EA's (ea/PRISMX_MarketFeed.mq5)
# default push matrix. FXSSI won't necessarily have data for every one of
# these (especially WTI/BTCUSD, which aren't mainstream FX pairs) —
# _fetch_once() already skips a symbol when "average is None", so anything
# unavailable simply doesn't appear in the result and the frontend shows its
# placeholder instead of erroring.
WATCH_SYMBOLS = {"XAUUSD", "XAGUSD", "WTI", "EURUSD", "GBPUSD", "USDJPY", "BTCUSD"}

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://fxssi.com/tools/current-ratio",
}

# 最近一次成功解析的结果，随时可读；抓取失败时保留旧值不覆盖。
# Last successfully parsed result; kept as-is (not cleared) when a refresh fails.
_cache: dict[str, dict[str, int]] = {}
_updated_at: float | None = None
_last_error: str | None = None


def _fetch_once() -> dict[str, dict[str, int]]:
    """抓取一次并解析（阻塞网络调用，调用方须放线程池执行）。
    Fetch and parse once (blocking network call; caller must offload to a thread pool)."""
    resp = requests.get(
        CURRENT_RATIOS_URL,
        params={"rand": random.random(), "user_id": 0},
        headers=_HEADERS,
        timeout=FETCH_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()
    data = resp.json()
    pairs = data.get("pairs", {})
    result: dict[str, dict[str, int]] = {}
    for sym in WATCH_SYMBOLS:
        avg = pairs.get(sym, {}).get("average")
        if avg is None:
            continue
        long_pct = round(float(avg))
        result[sym] = {"longPct": long_pct, "shortPct": 100 - long_pct}
    if not result:
        raise ValueError("no watched symbols found in FXSSI current-ratios response")
    return result


def refresh() -> bool:
    """抓取一次并在成功时更新缓存；失败只记录错误，缓存保持上次的值。两种结果都会
    发布到 shared_state（见 _publish）。
    Fetch once and update the cache on success; on failure, just log — the
    cache keeps its last value. Either outcome is published to shared_state
    (see _publish). 返回是否成功 / returns whether it succeeded."""
    global _cache, _updated_at, _last_error
    try:
        parsed = _fetch_once()
        _cache = parsed
        _updated_at = time.time()
        _last_error = None
        ok = True
    except Exception as e:  # noqa: BLE001 — 抓取失败是预期路径，不应中断后台循环
        _last_error = str(e)
        logger.warning("sentiment refresh failed: %s", e)
        ok = False
    _publish()
    return ok


def _local_snapshot() -> dict:
    return {
        "sentiment": _cache,
        "updatedAt": _updated_at,
        "stale": _last_error is not None,
    }


def _publish() -> None:
    """把本进程的结果写进 shared_state 给其它 worker 读（shared_cache 不抛 Redis 异常）。

    本进程还没成功过（刚接任的领导首轮就失败）时什么都不写：共享里上一任留下的好
    数据按自己剩下的寿命留着，不能拿一张空表把它盖掉。TTL 按最后一次成功的时刻算，
    所以连续失败只会刷新 stale 标记，不会给旧数据续命。

    Publish this process's result for the other workers (shared_cache never
    raises Redis errors). Nothing is written until this process has succeeded
    once — a freshly elected leader whose first fetch fails must not overwrite
    the previous leader's good data with an empty table. The TTL counts from the
    last success, so repeated failures refresh the stale flag without extending
    the old data's life."""
    if _updated_at is None:
        return
    remaining = int(SNAPSHOT_TTL_SECONDS - (time.time() - _updated_at))
    if remaining < 1:
        return
    shared_cache.set_json(SNAPSHOT_KEY, _local_snapshot(), remaining)


def get_sentiment() -> dict:
    """返回当前缓存的情绪数据（可能是陈旧值），供路由直接读取，不触发抓取。
    配了 Redis 时读领导 worker 发布的共享快照；读不到（未命中 / Redis 出错）退回本进程
    的那份——领导自己手里就有，非领导则和从前一样是空表。
    Return the currently cached sentiment (possibly stale) for the router to
    read directly; never triggers a fetch itself. With Redis, read the snapshot
    the leader published; on a miss or Redis error fall back to this process's
    copy (the leader has it; a follower gets the empty table, as before)."""
    if shared_state.enabled():
        snap = shared_cache.get_json(SNAPSHOT_KEY)
        if isinstance(snap, dict) and snap.get("sentiment"):
            return snap
    return _local_snapshot()


async def sentiment_loop() -> None:
    """启动时立即抓取一次，之后每 REFRESH_INTERVAL_SECONDS 刷新一次。
    Fetch once immediately at startup, then refresh every REFRESH_INTERVAL_SECONDS."""
    from starlette.concurrency import run_in_threadpool

    while True:
        try:
            ok = await run_in_threadpool(refresh)
            if ok:
                logger.info("sentiment refreshed: %d symbols", len(_cache))
        except Exception:
            logger.exception("sentiment_loop error")
        await asyncio.sleep(REFRESH_INTERVAL_SECONDS)
