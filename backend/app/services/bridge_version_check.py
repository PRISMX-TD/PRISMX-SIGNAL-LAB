"""Bridge 最新版本查询：抓取 GitHub Releases 的最新 tag + 内存缓存。

给网页端"有新版本 Bridge 可更新"提示用——用户当前版本随
POST /api/bridge/poll 上报（见 routers/bridge.py，存在 User.bridge_version），
本模块只负责"最新版本是什么"这一半，逻辑照搬 bridge_app.py 自己的
check_latest_release()，避免每次请求都打一次 GitHub API。

Latest Bridge version lookup: fetch the latest GitHub Releases tag + cache
in memory. Powers the web app's "a newer Bridge is available" notice — the
user's current version is reported via POST /api/bridge/poll (see
routers/bridge.py, stored on User.bridge_version); this module only handles
"what's the latest version", mirroring bridge_app.py's own
check_latest_release() so we don't hit the GitHub API on every request.
"""
import logging
import time

import requests

logger = logging.getLogger("prismx.bridge_version")

GITHUB_OWNER_REPO = "PRISMX-TD/PRISMX-SIGNAL-LAB"
LATEST_RELEASE_API = f"https://api.github.com/repos/{GITHUB_OWNER_REPO}/releases/latest"
RELEASES_PAGE = f"https://github.com/{GITHUB_OWNER_REPO}/releases/latest"
BRIDGE_ASSET_FILENAME = "PRISMX-Bridge-Setup.exe"

# 缓存刷新间隔（秒）：不需要多及时，Bridge 发版本身就不是分钟级的事。
# Cache refresh interval (seconds): doesn't need to be prompt — Bridge
# releases aren't a minute-to-minute event.
_CACHE_TTL_SECONDS = 600
_FETCH_TIMEOUT_SECONDS = 6

_cache: dict | None = None
_cached_at: float = 0.0


def _fetch_latest() -> dict | None:
    """向 GitHub 查一次最新 release（阻塞网络调用，调用方须放线程池执行）。
    Query GitHub for the latest release once (blocking; caller must offload
    to a thread pool)."""
    resp = requests.get(
        LATEST_RELEASE_API,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "PRISMX-Backend"},
        timeout=_FETCH_TIMEOUT_SECONDS,
    )
    resp.raise_for_status()
    data = resp.json()
    tag = (data.get("tag_name") or data.get("name") or "").strip()
    if not tag:
        return None
    download_url = None
    for asset in data.get("assets", []) or []:
        if asset.get("name") == BRIDGE_ASSET_FILENAME:
            download_url = asset.get("browser_download_url")
            break
    return {"latest": tag.lstrip("vV"), "downloadUrl": download_url or RELEASES_PAGE}


def get_latest(force: bool = False) -> dict | None:
    """返回缓存的最新版本信息，缓存过期（或 force）则同步刷新一次。
    抓取失败时返回上一次成功的缓存值（可能是 None），从不抛异常。

    Return the cached latest-version info, refreshing synchronously if the
    cache is stale (or force=True). On fetch failure, returns whatever was
    last cached successfully (possibly None) — never raises.
    """
    global _cache, _cached_at
    if not force and _cache is not None and time.time() - _cached_at < _CACHE_TTL_SECONDS:
        return _cache
    try:
        fresh = _fetch_latest()
        if fresh is not None:
            _cache = fresh
            _cached_at = time.time()
    except Exception as e:  # noqa: BLE001 — GitHub 抓取失败是预期路径，保留旧缓存即可
        logger.warning("bridge latest-version fetch failed: %s", e)
    return _cache
