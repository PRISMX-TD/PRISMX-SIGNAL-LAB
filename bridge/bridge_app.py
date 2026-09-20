"""PRISMX 桥接程序 / PRISMX Bridge App.

一个本地桌面程序：扫描本机所有正在运行的 MT5 终端，用 API Token 与
后端建立连接，把多个账号上报到网页，并执行网页下发的下单指令。
A local desktop app that scans all running MT5 terminals, links to the
backend with an API token, reports multiple accounts to the web app, and
executes order commands pushed from the web.

打开后第一步即要求用户输入 API Token。
On launch the first thing it asks for is the user's API token.
"""
import base64
import ctypes
import hashlib
import hmac
import http.client
import json
import logging
import os
import subprocess
import sys
import threading
import time
import tkinter as tk
import webbrowser
import winreg
from ctypes import wintypes
from logging.handlers import RotatingFileHandler
from tkinter import messagebox, ttk
from urllib import error, request
from urllib.parse import urlparse

from mt5_worker import poll_terminal, read_positions

# 系统托盘：可选依赖，缺失时静默降级为"点 X 直接退出"的旧行为，不影响主功能。
# System tray: optional dependency; missing it silently falls back to the old
# "X quits immediately" behavior instead of breaking the app.
try:
    import pystray
    from PIL import Image as PILImage
    _TRAY_AVAILABLE = True
except Exception:
    pystray = None
    PILImage = None
    _TRAY_AVAILABLE = False

# ---------- 版本 / Version ----------
# 1.4.2（2026-09-19 审计修复）：回执协议加了第三态。桥接现在除 `success` 外还上报
# `status`（FILLED / REJECTED / FAILED）与实际执行的 `volume`，后端按 `status` 落库、
# 不带该字段的旧桥接回落到老口径（见 backend/app/routers/bridge.py 的
# BridgeResultRequest）。这是**线上协议变更**，所以必须升版本号——后端的兼容分支、
# 以及下载页「有新版本可更新」的提示都以这个号为准。
# 同版还加了：自更新的 Ed25519 签名校验、PLACED 后的二次确认、positions_get 的
# None 与 () 分开处理、MODIFY 缺字段不再按 0 下发、开仓强制正手数。
#
# 1.4.2 (2026-09-19 audit): the result protocol gained a third state. The bridge now
# reports `status` (FILLED / REJECTED / FAILED) and the executed `volume` alongside
# `success`. This is a wire-protocol change, so the version must move: the backend's
# compatibility branch and the "update available" prompt both key on it.
APP_VERSION = "1.4.2"

# ---------- 更新检测 / Update check ----------
# 通过 GitHub Releases 检查是否有更新的安装包版本。
# Check GitHub Releases for a newer installer version.
GITHUB_OWNER_REPO = "PRISMX-TD/PRISMX-SIGNAL-LAB"
LATEST_RELEASE_API = f"https://api.github.com/repos/{GITHUB_OWNER_REPO}/releases/latest"
RELEASES_PAGE = f"https://github.com/{GITHUB_OWNER_REPO}/releases/latest"
# 安装包资产文件名（须与网页下载页 DownloadPage.tsx 的 BRIDGE_FILENAME 一致）。
# 找到匹配的资产就直接下载它，而不是把用户丢到 GitHub 发布页自己找文件。
# Installer asset filename (must match BRIDGE_FILENAME in the web DownloadPage.tsx).
# When found, download it directly instead of sending the user to the GitHub
# releases page to hunt for the file themselves.
BRIDGE_ASSET_FILENAME = "PRISMX-Bridge-Setup.exe"
# 更新检查间隔（秒）：启动检查一次，之后每 10 分钟复查一次。
# Update check interval (seconds): once on launch, then every 10 minutes.
UPDATE_CHECK_INTERVAL = 600

# ---------- 自更新的来源校验 / self-update provenance ----------
# 为什么需要这一段：自更新是整条链路上**唯一**一处「把远端二进制装到用户机器上并
# 执行」的地方，而运行它的那台机器上正登录着用户真实的 MT5 交易账号。旧版只检查
# 下载文件的头两字节是 MZ、体积不小于 5 MB——GitHub 账号被盗、Release 被投毒、
# 或者用户机器上装了中间人根证书（企业代理、部分国产安全软件；urlopen 默认读系统
# 信任库与系统代理），都足以让任意 exe 通过这两条检查并被执行。
# Why this exists: self-update is the only place in the whole system that installs
# and runs a remote binary on a machine that is signed into the user's real trading
# account. The old checks (MZ header + 5 MB floor) are passed trivially by any exe.
#
# 校验方案：发布方在 Release 里额外附两个资产——
#   SHA256SUMS      每行 "<64位十六进制>  <文件名>"（sha256sum 的标准输出格式）
#   SHA256SUMS.sig  对 SHA256SUMS **原始字节**的 Ed25519 签名，base64 单行
# 桥接硬编码发布公钥，顺序是：先取回清单并验签（证明这份哈希清单确实出自发布方），
# 再下载安装包并比对哈希（证明拿到手的字节就是清单里认的那一份）。
# 两步里任何一步失败都**不会**替换自身，一律回退到「请手动下载」。
# Scheme: the release carries a SHA256SUMS manifest plus an Ed25519 signature over
# its raw bytes. Verify the signature first (the manifest really is the publisher's),
# then hash the download and compare (the bytes really are the ones listed). Any
# failure aborts the swap and degrades to a manual download.
UPDATE_SUMS_ASSET = "SHA256SUMS"
UPDATE_SUMS_SIG_ASSET = "SHA256SUMS.sig"

# ⚠⚠⚠ 必须替换成真正的发布公钥，否则自更新**一直是关闭的** ⚠⚠⚠
# ⚠⚠⚠ REPLACE WITH THE REAL RELEASE PUBLIC KEY — SELF-UPDATE STAYS OFF UNTIL YOU DO ⚠⚠⚠
# 生成方式见 bridge/README.md「发版签名」一节：私钥只存在发布者手上（离线/密钥库），
# 这里填的是 Ed25519 公钥的 32 字节原始值的 base64（44 个字符，以 "=" 结尾）。
# 留着占位符时 update_signing_ready() 恒为 False：提示条只会引导手动下载，
# 一键自更新的入口整个不出现——「没配公钥」绝不等于「不校验就放行」。
# Placeholder ⇒ update_signing_ready() is False ⇒ the one-click path is not offered
# at all. An unconfigured key must never degrade into "skip the check".
_UPDATE_PUBLIC_KEY_PLACEHOLDER = "!!!-REPLACE-ME-WITH-RELEASE-ED25519-PUBLIC-KEY-BASE64-!!!"
UPDATE_PUBLIC_KEY_B64 = _UPDATE_PUBLIC_KEY_PLACEHOLDER

# 只接受 GitHub 的下载域名。browser_download_url 会 302 到对象存储，所以请求前的
# URL 和跟随重定向后的最终 URL 都要查一遍——否则一个被改写的 Release JSON 就能把
# 下载指到任意主机上（HTTPS 证书只证明「是那台主机」，不证明「是我们的主机」）。
# Pin downloads to GitHub's hosts, checking both the requested URL and the final
# URL after redirects: TLS proves who the host is, not that it is ours.
UPDATE_ALLOWED_HOSTS = (
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
)
# 哈希清单与签名都是很小的文本文件，给个上限免得把一个巨大的响应读进内存。
# Both are tiny text files; cap the read so a huge response can't be slurped in.
UPDATE_TEXT_ASSET_MAX_BYTES = 256 * 1024

# ---------- 配置 / Configuration ----------
# 线上后端地址（所有用户默认连接，无需手动填写）。
# Production backend URL (all users connect here by default; no manual entry needed).
DEFAULT_BACKEND = "https://api.prismxsignallab.com"
CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".prismx_bridge.json")
LOG_PATH = os.path.join(os.path.expanduser("~"), ".prismx_bridge.log")
POLL_INTERVAL = 1.5  # 状态上报间隔（秒）/ status report interval (seconds)

# 指令长轮询：/api/bridge/poll 在没有指令时最多挂这么久，后端一有指令落库立即返回。
# 上限由后端定（5 秒）——账号在线看 7 秒内的心跳，而心跳就是这个请求刷的，不能挂太久。
# 以前指令要等下一拍 1.5 秒轮询才被取走（平均 0.75 秒），现在是落库即取。
# Command long poll: /api/bridge/poll holds up to this long with nothing to deliver
# and returns the instant a command is committed. The backend caps it at 5s because
# liveness is a 7-second heartbeat window refreshed by this very request.
COMMAND_WAIT_SECONDS = 5.0

# 单次平仓明细上报的最大条数。重连补扫可能一次产出几百条，整包发容易超时，
# 而超时的整包会原样退回重试队列反复重发。见 _post_trades。
# Max closing legs per POST; a reconnect catch-up can produce hundreds at once.
_TRADES_PER_POST = 100

# 后端在 /poll 响应里点名"需要一次性回扫补齐 MT5 明细"的账号（tradeHistoryBackfill）。
# 每个账号在本进程里只回扫一次：回扫回看一年、上报幂等，但没必要每拍都扫；后端那边
# 只要还有补不上的旧记录（比如终端历史里已经查不到的仓位）就会一直点名。
# Accounts the backend flags for a one-off deep rescan; done once per process
# per account — the backend keeps flagging while any row stays unfillable.
_backfill_requested: set[str] = set()
_backfill_done: set[str] = set()
_path_login: dict[str, str] = {}

# 已执行指令结果的本地持久化：程序重启后缓存不丢，后端超时重发同一指令时
# 只重报缓存结果、绝不重复下单（防止"已执行但回执丢失 + 重启"导致重复开仓）。
# Persisted cache of executed command results: survives restarts, so if the
# backend re-delivers a command after an ack timeout we re-report the cached
# result instead of executing again (prevents duplicate fills after a
# "executed but ack lost + restart" sequence).
EXECUTED_CACHE_PATH = os.path.join(os.path.expanduser("~"), ".prismx_bridge_executed.json")
# 缓存保留时长（秒）：远大于后端 5 分钟的指令作废窗口即可 / retention (s),
# just needs to comfortably exceed the backend's 5-minute void window
EXECUTED_CACHE_TTL = 24 * 3600

# 未成功回报后端的执行结果队列，同样持久化：回执没送达就关程序，
# 重启后继续重试，后端不必等超时重发。
# Queue of results not yet acked by the backend, also persisted: if the app
# closes before a report lands, retries resume after restart instead of
# waiting for the backend's re-delivery timeout.
REPORTS_CACHE_PATH = os.path.join(os.path.expanduser("~"), ".prismx_bridge_reports.json")

# 未成功上报的真实平仓明细队列（个人胜率用），同样持久化重试。
# Queue of closed-trade legs not yet acked by the backend (personal win-rate),
# also persisted for retry.
TRADES_CACHE_PATH = os.path.join(os.path.expanduser("~"), ".prismx_bridge_trades.json")


def resource_path(name: str) -> str:
    """返回打包后/源码态下的资源绝对路径 / resolve a bundled resource path.

    PyInstaller 解压到 sys._MEIPASS；源码态用脚本所在目录。
    PyInstaller extracts to sys._MEIPASS; fall back to the script dir.
    """
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, name)


# ---------- 日志 / Logging ----------
def _setup_logger() -> logging.Logger:
    """配置本地运行日志（滚动文件）/ set up a rotating local run log."""
    lg = logging.getLogger("prismx_bridge")
    lg.setLevel(logging.INFO)
    if not lg.handlers:
        try:
            handler = RotatingFileHandler(
                LOG_PATH, maxBytes=512 * 1024, backupCount=3, encoding="utf-8"
            )
            handler.setFormatter(
                logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
            )
            lg.addHandler(handler)
        except Exception:
            pass
    return lg


logger = _setup_logger()


# ---------- Token 加密存储（Windows DPAPI）/ Token encryption via Windows DPAPI ----------
class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _dpapi_encrypt(plain: str) -> str | None:
    """用当前 Windows 用户密钥加密，返回 base64；失败返回 None。
    Encrypt with the current Windows user key, return base64; None on failure.
    """
    try:
        raw = plain.encode("utf-8")
        blob_in = _DataBlob(len(raw), ctypes.cast(ctypes.create_string_buffer(raw), ctypes.POINTER(ctypes.c_char)))
        blob_out = _DataBlob()
        if not ctypes.windll.crypt32.CryptProtectData(
            ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
        ):
            return None
        try:
            buf = ctypes.string_at(blob_out.pbData, blob_out.cbData)
            return base64.b64encode(buf).decode("ascii")
        finally:
            ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    except Exception:
        return None


def _dpapi_decrypt(b64: str) -> str | None:
    """解密 base64 密文；失败返回 None / decrypt base64 ciphertext; None on failure."""
    try:
        raw = base64.b64decode(b64)
        buf = ctypes.create_string_buffer(raw, len(raw))
        blob_in = _DataBlob(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
        blob_out = _DataBlob()
        if not ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
        ):
            return None
        try:
            return ctypes.string_at(blob_out.pbData, blob_out.cbData).decode("utf-8")
        finally:
            ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    except Exception:
        return None


def load_config() -> dict:
    """读取本地配置（记住 Token 与后端地址）/ load saved token & backend URL.

    Token 以 DPAPI 加密存储在 token_enc 字段；兼容旧的明文 token 字段。
    Token is stored encrypted in token_enc; legacy plaintext token is still read.
    """
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        return {}
    enc = cfg.get("token_enc")
    if enc:
        dec = _dpapi_decrypt(enc)
        cfg["token"] = dec or ""
    return cfg


class TokenStorageError(Exception):
    """Token 无法加密存盘（DPAPI 不可用）。调用方应提示用户、但可以继续用内存里的 token 连接。
    The token could not be encrypted for storage (DPAPI unavailable); the caller
    should warn but may keep using the in-memory token for this session."""


def save_config(cfg: dict) -> None:
    """保存本地配置；Token 加密后存盘，**绝不落明文**。

    以前 DPAPI 失败会退回明文写盘。这个退路的代价是：一台 DPAPI 坏掉的机器上，
    用户的 API Token 会以明文躺在用户目录里，任何能读文件的程序都能拿走它去冒充
    桥接程序下单。现在 DPAPI 失败就只保存后端地址、不保存 token，并抛
    TokenStorageError 让界面提示"这次能用，下次启动要重新输入"。
    Persist config; the token is encrypted, never written in plaintext. The old
    plaintext fallback left the API token readable on disk whenever DPAPI was
    broken; now the token is simply not persisted and TokenStorageError tells
    the UI to warn that it must be re-entered next launch.
    """
    out = {"backend": cfg.get("backend", DEFAULT_BACKEND)}
    token = cfg.get("token", "")
    enc = _dpapi_encrypt(token) if token else None
    if enc:
        out["token_enc"] = enc
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(out, f)
    except Exception:
        pass
    if token and not enc:
        raise TokenStorageError("DPAPI encryption unavailable; token not persisted")


# ---------- 开机自启 / Start with Windows ----------
# 只对打包后的 exe 生效（注册表指向可执行文件路径）；源码态运行没有单一可
# 执行文件可指向，跳过。用当前用户级 Run 键，不需要管理员权限。
# Only meaningful for the packaged exe (the registry entry points at an
# executable path); running from source has no single file to point at, so
# this is skipped. Uses the per-user Run key, no admin rights required.
_AUTOSTART_KEY_PATH = r"Software\Microsoft\Windows\CurrentVersion\Run"
_AUTOSTART_VALUE_NAME = "PRISMXBridge"


def autostart_supported() -> bool:
    """是否处于可以设置开机自启的环境（打包态）/ whether autostart can be offered (frozen build)."""
    return bool(getattr(sys, "frozen", False))


def is_autostart_enabled() -> bool:
    """查询开机自启是否已启用 / check whether autostart is currently enabled."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _AUTOSTART_KEY_PATH, 0, winreg.KEY_READ) as key:
            value, _ = winreg.QueryValueEx(key, _AUTOSTART_VALUE_NAME)
            return bool(value)
    except OSError:
        return False


def set_autostart_enabled(enabled: bool) -> bool:
    """启用/关闭开机自启；返回是否成功 / enable or disable autostart; returns success."""
    if enabled and not autostart_supported():
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _AUTOSTART_KEY_PATH, 0, winreg.KEY_WRITE) as key:
            if enabled:
                winreg.SetValueEx(key, _AUTOSTART_VALUE_NAME, 0, winreg.REG_SZ, f'"{sys.executable}"')
            else:
                try:
                    winreg.DeleteValue(key, _AUTOSTART_VALUE_NAME)
                except FileNotFoundError:
                    pass
        return True
    except OSError:
        return False


def _load_executed_cache() -> tuple[dict[str, dict], dict[str, float]]:
    """读取已执行结果缓存，过滤超龄条目 / load the executed cache, drop stale entries.

    返回 (coid -> 结果, coid -> 写入时间戳)。文件损坏/缺失时返回空缓存。
    Returns (coid -> result, coid -> timestamp); empty caches on any failure.
    """
    try:
        with open(EXECUTED_CACHE_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        now = time.time()
        results: dict[str, dict] = {}
        stamps: dict[str, float] = {}
        for coid, entry in (raw or {}).items():
            if not isinstance(entry, dict) or not isinstance(entry.get("result"), dict):
                continue
            ts = float(entry.get("ts", 0))
            if now - ts < EXECUTED_CACHE_TTL:
                results[coid] = entry["result"]
                stamps[coid] = ts
        return results, stamps
    except Exception:
        return {}, {}


def _save_executed_cache(results: dict[str, dict], stamps: dict[str, float]) -> None:
    """把已执行结果缓存写盘；失败不影响运行 / persist the cache; never fatal."""
    try:
        payload = {
            coid: {"ts": stamps.get(coid, time.time()), "result": r}
            for coid, r in results.items()
        }
        with open(EXECUTED_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(payload, f)
    except Exception:
        pass


def _load_pending_reports() -> list[dict]:
    """读取未回报队列 / load the pending-report queue; empty on any failure."""
    try:
        with open(REPORTS_CACHE_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        return [r for r in raw if isinstance(r, dict)] if isinstance(raw, list) else []
    except Exception:
        return []


def _save_pending_reports(reports: list[dict]) -> None:
    """把未回报队列写盘；失败不影响运行 / persist the queue; never fatal."""
    try:
        with open(REPORTS_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(reports, f)
    except Exception:
        pass


def _load_pending_trades() -> list[dict]:
    """读取未上报的平仓明细队列 / load the pending closed-trades queue; empty on failure."""
    try:
        with open(TRADES_CACHE_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        return [t for t in raw if isinstance(t, dict)] if isinstance(raw, list) else []
    except Exception:
        return []


def _save_pending_trades(trades: list[dict]) -> None:
    """把未上报的平仓明细队列写盘；失败不影响运行 / persist the queue; never fatal."""
    try:
        with open(TRADES_CACHE_PATH, "w", encoding="utf-8") as f:
            json.dump(trades, f)
    except Exception:
        pass


def scan_terminals() -> list[str]:
    """扫描本机正在运行的 MT5 终端可执行路径。
    Scan running MT5 terminals' executable paths on this machine.

    分开安装的多个 MT5 = 不同的 terminal64.exe 路径，以此区分。
    Separately installed terminals have distinct terminal64.exe paths.

    仅匹配 MT5 的 terminal64.exe；MT4 的 terminal.exe 不兼容 MetaTrader5
    库，若误连会导致进程卡死，因此显式排除。
    Only MT5's terminal64.exe is matched; MT4's terminal.exe is incompatible
    with the MetaTrader5 library and would hang, so it is excluded.
    """
    paths: list[str] = []
    try:
        import psutil
        for proc in psutil.process_iter(["name", "exe"]):
            name = (proc.info.get("name") or "").lower()
            if name == "terminal64.exe":
                exe = proc.info.get("exe")
                if exe and exe not in paths:
                    paths.append(exe)
    except Exception:
        pass
    return paths


# ---------- 后端 HTTP 客户端 / Backend HTTP client ----------
class BackendClient:
    """复用连接的后端 POST 客户端。

    以前每次请求都用 urllib 新开一条连接：一拍三次请求（持仓、poll、报价）就是三次
    TCP + TLS 握手，大陆到新加坡每次握手 2~3 个 RTT，一拍光握手就要一秒上下。这里用
    http.client 保持一条 keep-alive 连接，握手只在启动和连接断掉时发生。

    一个实例一条连接、一把锁：http.client 的连接不能并发使用。状态上报循环和指令
    长轮询循环各持一个实例——否则挂着的 5 秒长轮询会把持仓上报堵在锁外。

    直连失败时退回 urllib（它会读系统代理设置）并从此固定走 urllib：有用户的机器必须
    经代理才出得去，不能因为省握手把他们挡在门外。

    Keep-alive POST client. urllib opened a fresh connection per request: three
    requests per tick meant three TCP+TLS handshakes, 2-3 RTTs each from mainland
    China to Singapore. One connection and one lock per instance (http.client
    connections are not concurrency-safe); the status loop and the command loop each
    own one so a held long poll never blocks a positions report. Falls back to urllib
    (which honours system proxy settings) when a direct connection cannot be made.
    """

    def __init__(self, backend: str, token: str):
        self._base = backend.rstrip("/")
        u = urlparse(self._base)
        self._https = u.scheme == "https"
        self._host = u.hostname or ""
        self._port = u.port
        self._token = token
        self._conn: http.client.HTTPConnection | None = None
        self._lock = threading.Lock()
        self._use_urllib = False

    def _open(self, timeout: float) -> http.client.HTTPConnection:
        if self._https:
            return http.client.HTTPSConnection(self._host, self._port, timeout=timeout)
        return http.client.HTTPConnection(self._host, self._port, timeout=timeout)

    def _drop(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None

    def close(self) -> None:
        with self._lock:
            self._drop()

    def _post_urllib(self, path: str, data: bytes, timeout: float) -> dict:
        req = request.Request(self._base + path, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("X-API-Token", self._token)
        with request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8")
            return json.loads(body) if body else {}

    def post(self, path: str, payload: dict, timeout: float = 10.0) -> dict:
        """POST JSON，返回 JSON dict。HTTP 4xx/5xx 抛 urllib.error.HTTPError（带 code /
        reason），与旧实现一致，调用方的错误分支不用改。
        POST JSON; raises urllib.error.HTTPError on 4xx/5xx like the old implementation."""
        data = json.dumps(payload).encode("utf-8")
        if self._use_urllib:
            return self._post_urllib(path, data, timeout)

        headers = {
            "Content-Type": "application/json",
            "Content-Length": str(len(data)),
            "X-API-Token": self._token,
            "Connection": "keep-alive",
        }
        last: Exception | None = None
        with self._lock:
            # 第一次失败多半是服务端已经关掉了这条空闲连接（keep-alive 到期），重连再发
            # 一次；这里的请求都是幂等的（持仓/报价是快照，回执按 clientOrderId 去重）。
            # A first failure is usually the server having closed the idle connection;
            # reconnect and retry once. Every request here is idempotent.
            for attempt in range(2):
                try:
                    if self._conn is None:
                        self._conn = self._open(timeout)
                    elif self._conn.sock is not None:
                        self._conn.sock.settimeout(timeout)
                    self._conn.request("POST", path, body=data, headers=headers)
                    resp = self._conn.getresponse()
                    body = resp.read()
                    if (resp.getheader("Connection") or "").lower() == "close":
                        self._drop()
                    if resp.status >= 400:
                        raise error.HTTPError(self._base + path, resp.status, resp.reason, resp.headers, None)
                    return json.loads(body.decode("utf-8")) if body else {}
                except error.HTTPError:
                    raise
                except (http.client.HTTPException, OSError) as e:
                    self._drop()
                    last = e
                    if attempt == 0:
                        continue
        # 直连两次都不成：可能这台机器要走系统代理。urllib 会读代理设置，成了就固定走它。
        # Direct connection failed twice: maybe this machine needs the system proxy.
        try:
            out = self._post_urllib(path, data, timeout)
        except Exception:
            raise last if last is not None else RuntimeError("backend unreachable")
        self._use_urllib = True
        logger.warning("直连后端失败(%s)，已改走系统代理(urllib) / direct connection failed, using urllib with system proxy", last)
        return out


class BridgeEngine:
    """协调器：串行轮询本机所有 MT5 终端 + 轮询后端，运行在后台线程。
    Coordinator: serially poll all local MT5 terminals + the backend on a thread.

    单进程实现：用 mt5.initialize(path=...) 逐个连接终端，避免 onefile
    打包下多进程子进程无法启动的问题。
    Single-process design: attach to each terminal via initialize(path=...),
    which avoids broken multiprocessing children in a PyInstaller onefile build.
    """

    def __init__(self, token: str, backend: str, on_status):
        self.token = token
        self.backend = backend.rstrip("/")
        self.on_status = on_status  # 回调：把最新状态推给 GUI / push status to GUI
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.last_error: str | None = None
        # 已执行订单的结果缓存：clientOrderId -> result。
        # 后端超时重发同一指令时，不重复下单，只重新回报缓存结果（幂等保护）。
        # 缓存持久化到本地文件，程序重启后依然生效。
        # Cache of executed order results: clientOrderId -> result. If the backend
        # re-delivers the same command after an ack timeout, we DON'T place the
        # order again — we just re-report the cached result (idempotency guard).
        # Persisted to a local file so it survives restarts.
        self._executed, self._executed_at = _load_executed_cache()
        if self._executed:
            logger.info("已加载幂等缓存 / loaded executed cache: %d entrie(s)", len(self._executed))
        # 尚未成功回报后端的结果，下一轮重试；持久化到本地，重启不丢。
        # Results not yet acked by the backend, retried next tick; persisted
        # locally so they survive restarts.
        self._pending_reports: list[dict] = _load_pending_reports()
        # 未成功上报的真实平仓明细（个人胜率），持久化重试，逻辑同上。
        # Closed-trade legs (personal win-rate) not yet acked; persisted for
        # retry, same idea as the order-result queue above.
        self._pending_trades: list[dict] = _load_pending_trades()
        # 上一轮上报的报价 {(login, symbol): (bid, ask)}，仅上报变化项以省流量。
        # 按 (账号, 品种) 区分，而不是跨账户合并——下单确认页要按所选账户取
        # 对应交易商的报价，不同交易商同一品种的报价本就可能不同。
        # Last reported quotes {(login, symbol): (bid, ask)}; only changed
        # entries are sent. Keyed per (account, symbol) rather than merged
        # across accounts — the order-confirmation page looks up the quote for
        # whichever broker account is selected, and different brokers can
        # legitimately quote the same symbol differently.
        self._last_quotes: dict[tuple, tuple] = {}
        # 两条循环各一条 keep-alive 连接（见 BackendClient 的说明）。
        # One keep-alive connection per loop (see BackendClient).
        self._http = BackendClient(self.backend, token)
        self._cmd_http = BackendClient(self.backend, token)
        # MetaTrader5 包附着的是进程级单连接，两条循环不能同时碰它。
        # The MetaTrader5 module is one process-wide attachment; the two loops
        # must not touch it concurrently.
        self._mt5_lock = threading.Lock()
        # 状态循环每拍留下的快照，指令循环拿来发 poll、路由指令、合并持仓上报。
        # Snapshots the status loop leaves for the command loop.
        self._accounts_snapshot: list = []
        self._login_to_path: dict[str, str] = {}
        self._positions_by_path: dict[str, list] = {}
        self._state_lock = threading.Lock()
        self._cmd_thread: threading.Thread | None = None

    def start(self):
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="bridge-status")
        self._thread.start()
        self._cmd_thread = threading.Thread(target=self._command_loop, daemon=True, name="bridge-commands")
        self._cmd_thread.start()

    def stop(self):
        self._stop.set()
        self._http.close()
        self._cmd_http.close()

    # ---------- 指令循环 / command loop ----------
    def _command_loop(self):
        """长轮询领指令、立刻执行。

        与状态上报循环分开跑：① 挂着等指令的 5 秒不拖慢持仓 / 报价上报；② 指令一到就
        执行，不再排在"读账号 + 持仓 + 报价 + 扫平仓明细"整轮之后；③ 执行完立刻重读
        持仓上报，网页上仓位成交即出现、平仓即消失。
        对旧版后端（不认识 waitSeconds、立即返回）自动退回 1.5 秒定频，不会空转。

        Long-poll for commands and execute them at once, on its own thread so the held
        request never delays status reports and execution never queues behind a full
        terminal read. Falls back to the 1.5s cadence against an old backend.
        """
        while not self._stop.is_set():
            accounts = self._accounts_snapshot
            if not accounts:
                self._stop.wait(0.5)
                continue
            t0 = time.monotonic()
            try:
                resp = self._cmd_http.post(
                    "/api/bridge/poll",
                    {
                        "accounts": accounts,
                        "bridgeVersion": APP_VERSION,
                        "waitSeconds": COMMAND_WAIT_SECONDS,
                        "fetchCommands": True,
                    },
                    timeout=COMMAND_WAIT_SECONDS + 10.0,
                )
                commands = resp.get("commands", [])
                commands = [c for c in commands if isinstance(c, dict)] if isinstance(commands, list) else []
            except Exception as e:
                logger.warning("指令长轮询失败 / command poll failed: %s", e)
                self._stop.wait(POLL_INTERVAL)
                continue
            if commands:
                try:
                    self._execute_commands(commands, self._cmd_http)
                except Exception as e:
                    logger.exception("执行指令异常 / command execution error: %s", e)
            elapsed = time.monotonic() - t0
            if not commands and elapsed < 1.0:
                # 后端没把请求挂住（旧版后端）：退回定频，别把后端打满。
                # The backend returned at once (older backend): fall back to the fixed cadence.
                self._stop.wait(max(0.2, POLL_INTERVAL - elapsed))

    def _execute_commands(self, commands: list, http: "BackendClient") -> None:
        """按 login 分组执行指令并回报；已执行过的只重报缓存结果，不重复下单。
        执行完立刻重读该终端持仓并上报（与其它终端的最近快照合并成整表）。
        Execute by login, report results; re-report cached results for re-deliveries.
        Then re-read that terminal's positions and report them right away."""
        by_path: dict[str, list] = {}
        for cmd in commands:
            coid = str(cmd.get("clientOrderId"))
            if coid in self._executed:
                # 重发的指令：直接重报缓存结果 / re-delivered: re-report cached result
                self._report_result(self._executed[coid], http)
                continue
            path = self._login_to_path.get(str(cmd.get("login")))
            if path:
                by_path.setdefault(path, []).append(cmd)
            else:
                logger.warning("指令目标账号不在本机 / command for a login not attached here: %s", cmd.get("login"))
        for path, cmds in by_path.items():
            with self._mt5_lock:
                res = poll_terminal(path, orders=cmds, read_state=False)
            if res.get("error"):
                logger.warning("poll_terminal(%s) 执行指令报错 / error: %s", path, res["error"])
            for r in res.get("results", []):
                coid = str(r.get("clientOrderId"))
                if coid:
                    # 缓存并落盘，以备幂等重报（重启后仍有效）
                    # cache & persist for idempotent retry (survives restarts)
                    #
                    # status=FAILED（「不知道成没成」，见 mt5_worker._result_from_retcode）
                    # 同样进缓存，这是**刻意**的：后端重发同一 clientOrderId 时，
                    # 重报一次 FAILED 是安全的，而重新执行可能开出第二笔仓位——
                    # 在两者之间只能选前者。
                    #
                    # 已知代价：如果那张单后来其实成交了，缓存会让它在后端一直停在
                    # FAILED（后端把 FAILED 当非终态、允许被更正，但更正永远不会来）。
                    # 用户不会因此受损——FAILED 的文案就是「请先核对持仓」，而且平仓
                    # 明细回扫会把真实仓位补进记录——只是订单行看起来停在未确认。
                    # 更好的做法是重发时**只重跑确认、不重跑执行**，把 FAILED 升级成
                    # FILLED；那要改动指令循环的形状，留作后续。
                    #
                    # FAILED ("outcome unknown") is cached deliberately. When the
                    # backend re-delivers the same clientOrderId, re-reporting FAILED
                    # is safe while re-executing could open a second position, and
                    # that is the whole choice.
                    #
                    # Known cost: if the order did fill, the cache pins it at FAILED
                    # in the backend forever (FAILED is non-terminal there and may be
                    # corrected, but the correction never arrives). No user harm —
                    # FAILED reads as "verify your positions", and the closed-trade
                    # rescan still records the real position — the order row just
                    # stays unconfirmed. The better fix is to re-run only the
                    # confirmation on a re-delivery and upgrade FAILED to FILLED,
                    # which needs the command loop reshaped; left as follow-up.
                    self._remember_executed(coid, r)
                logger.info(
                    "下单结果 / order result: coid=%s success=%s ticket=%s price=%s msg=%s",
                    coid, r.get("success"), r.get("mt5Ticket"),
                    r.get("filledPrice"), r.get("message"),
                )
                self._report_result(r, http)
            # 成交后立刻重读持仓并上报，不等下一拍 1.5 秒的常规上报。
            # Report positions immediately after the fill, not on the next status tick.
            try:
                with self._mt5_lock:
                    fresh = read_positions(path)
                if fresh is not None:
                    with self._state_lock:
                        self._positions_by_path[path] = fresh
                        merged = [pos for lst in self._positions_by_path.values() for pos in lst]
                    http.post("/api/bridge/positions", {"data": merged})
            except Exception as e:
                logger.warning("成交后即时上报持仓失败 / immediate positions report failed: %s", e)

    def _loop(self):
        while not self._stop.is_set():
            try:
                self._tick()
            except Exception as e:
                self.last_error = str(e)
                self.on_status([], self.last_error)
            # 可被 stop 提前唤醒的等待 / interruptible wait
            self._stop.wait(POLL_INTERVAL)

    def _tick(self):
        paths = scan_terminals()
        if not paths:
            # 终端没了：清掉快照，指令循环随即停止发 poll（否则会拿着旧账号列表继续挂着）。
            # No terminal: drop the snapshot so the command loop stops polling with stale accounts.
            self._accounts_snapshot = []
            self.on_status([], "未检测到正在运行的 MT5 终端 / No running MT5 terminal found")
            return

        # 1) 逐个终端读取账号与持仓 / read account & positions per terminal
        accounts: list = []
        positions: list = []
        quotes_by_account: list = []
        closed_trades: list = []
        login_to_path: dict[str, str] = {}
        worker_errors: list[str] = []
        for path in paths:
            login_hint = _path_login.get(path)
            deep = login_hint is not None and login_hint in _backfill_requested and login_hint not in _backfill_done
            if deep:
                _backfill_done.add(login_hint)
            with self._mt5_lock:
                res = poll_terminal(path, deep_backfill=deep)
            if res.get("error"):
                worker_errors.append(res["error"])
                # 只要账号在线（accounts 非空），这个错误此前完全不会展示在状态栏
                # 也不会写日志，会悄悄跳过账号/持仓/报价/平仓检测里失败的那部分——
                # 现在无论账号是否在线都记一行日志，不再无声无息。
                # Whenever accounts is non-empty this error used to never surface
                # in the status bar or the log — whichever of
                # account/positions/quotes/closed-trade-detection failed just
                # silently got skipped. Now it's logged regardless of whether
                # accounts came back, instead of vanishing silently.
                logger.warning("poll_terminal(%s) 报错 / error: %s", path, res["error"])
            acc = res.get("account")
            if acc:
                accounts.append(acc)
                login_to_path[acc["login"]] = path
                _path_login[path] = acc["login"]
                positions.extend(res.get("positions", []))
                with self._state_lock:
                    self._positions_by_path[path] = list(res.get("positions", []))
                # 按账户上报，不跨终端合并——下单确认页要按选中账户取对应
                # 交易商的报价。/ report per account, no cross-terminal merge —
                # the order-confirmation page needs the selected account's own
                # broker quote.
                for q in res.get("quotes", []):
                    quotes_by_account.append({**q, "login": acc["login"]})
                closed_trades.extend(res.get("closedTrades", []))

        if not accounts:
            msg = worker_errors[0] if worker_errors else "已连接终端但未读到已登录账号 / terminal attached but no logged-in account"
            self._accounts_snapshot = []
            self.on_status([], msg)
            return

        # 给指令循环留快照：它用这份账号列表发长轮询、按 login 找终端。
        # Snapshots for the command loop: accounts for its poll, login -> terminal for routing.
        self._login_to_path = dict(login_to_path)
        self._accounts_snapshot = accounts
        with self._state_lock:
            for stale in [k for k in self._positions_by_path if k not in paths]:
                self._positions_by_path.pop(stale, None)

        # 2) 先上报持仓（触发自动仓位管理评估，命令立即入队），
        #    再拉指令（同一拍即可拿到刚入队的命令），比先 poll 再 positions
        #    节省整整一轮 1.5s 轮询间隔。快市里这 1.5 秒可能就是止损是否滑出
        #    目标区间的那一段。
        # Report positions first (triggers auto-manage evaluation → commands
        # are enqueued immediately), then poll (fetches those same commands in
        # the very same tick), saving a full 1.5s polling round. In a fast
        # market that 1.5s may be the gap between the trailing stop catching
        # the price or missing it.
        # 3) 上报持仓 / report positions
        try:
            self._http.post("/api/bridge/positions", {"data": positions})
        except Exception as e:  # noqa: BLE001
            # 这一步以前是完全静默的：用户报「网页上仓位不刷新」时，日志里
            # 连一次失败的痕迹都找不到。与本文件其它上报路径保持一致，记一行。
            # This used to be silent, leaving "positions aren't refreshing"
            # reports with no trace in the log at all.
            logger.warning("上报持仓失败 / failed to report positions: %s", e)

        # 4) 上报账号（刷心跳、收后端对账号的裁决）。指令不在这里领：fetchCommands=False，
        #    由指令循环的长轮询去领并立刻执行。旧版后端不认识这个字段会照旧把指令给过来，
        #    下面第 8 步仍会执行它们，所以新桥接配旧后端也不会丢单。
        # Report accounts (heartbeat + the backend's verdicts). Commands are not taken
        # here (fetchCommands=False) but by the command loop's long poll. An older backend
        # ignores the flag and still hands commands over; step 8 below still runs them.
        commands = []
        warning = None
        try:
            resp = self._http.post(
                "/api/bridge/poll",
                {"accounts": accounts, "bridgeVersion": APP_VERSION, "fetchCommands": False},
            )
            commands = resp.get("commands", [])
            # 仅接受 list[dict]，过滤畸形元素，防止后续执行链异常。
            # Only accept list[dict]; drop malformed elements to protect the chain.
            if not isinstance(commands, list):
                commands = []
            else:
                commands = [c for c in commands if isinstance(c, dict)]
            self.last_error = None
            # 被拒绝入库的账号：此前这两个字段完全没读取，用户唯一能看到的
            # 现象是本机绿灯"已连接"、网页「连接 MT5」页却什么账户都没有,
            # 却没有任何解释。把拒绝原因摊在状态栏上，而不是让用户自己去猜
            # 是不是产品坏了。
            # Accounts the backend rejected: these two fields used to be
            # completely unread. The only symptom a user could see was this
            # app showing a green "connected" light while the web Bind page
            # showed nothing — with zero explanation. Surface the reason in
            # the status line instead of leaving the user to guess the
            # product is broken.
            broker_rejected = [
                str(x) for x in (resp.get("brokerRejected") or []) if x
            ]
            limit_exceeded = [
                str(x) for x in (resp.get("accountLimitExceeded") or []) if x
            ]
            _backfill_requested.update(
                str(x) for x in (resp.get("tradeHistoryBackfill") or []) if x
            )
            parts = []
            if broker_rejected:
                parts.append(
                    f"{len(broker_rejected)} 个账号非合作券商被拒 ({', '.join(broker_rejected)})"
                    f" / not a partner broker"
                )
            if limit_exceeded:
                parts.append(
                    f"{len(limit_exceeded)} 个账号超出套餐额度 ({', '.join(limit_exceeded)})"
                    f" / over your plan's account limit"
                )
            if parts:
                warning = "；".join(parts) + "，详见网页「连接 MT5」页 / see the web Bind page for details"
        except error.HTTPError as e:
            # 只有 401/403 才是 Token 的问题。此前所有 HTTP 错误都提示"检查 Token"，
            # 后端 500 时用户只会反复核对一个本来就正确的 Token，永远查不到方向。
            # Only 401/403 are token problems. This used to say "check your token"
            # for every HTTP error, so a backend 500 sent the user off re-checking
            # a token that was correct all along.
            if e.code in (401, 403):
                self.last_error = f"后端拒绝 HTTP {e.code}: {e.reason}（检查 Token）"
            else:
                self.last_error = (
                    f"后端异常 HTTP {e.code}: {e.reason}"
                    f"（与 Token 无关，服务端故障，正在自动重试）"
                )
            self.on_status(accounts, self.last_error)
            return
        except Exception as e:
            self.last_error = f"无法连接后端: {e}"
            self.on_status(accounts, self.last_error)
            return

        # 5) 上报报价：仅上报相对上一轮变化的 (账号, 品种) 以省流量。
        # Report quotes: only (account, symbol) entries changed since last tick.
        try:
            changed: list = []
            for q in quotes_by_account:
                key = (q["login"], q["symbol"])
                val = (q["bid"], q["ask"])
                if self._last_quotes.get(key) != val:
                    self._last_quotes[key] = val
                    changed.append(q)
            if changed:
                self._http.post("/api/bridge/quotes", {"data": changed})
        except Exception as e:  # noqa: BLE001
            # 同上：报价不刷新时也要在日志里留下线索 / leave a trace here too
            logger.warning("上报报价失败 / failed to report quotes: %s", e)

        # 6) 上报新检测到的真实平仓明细（个人胜率）；失败则入队下一轮重试。
        # 这一步之前完全不写日志，无论成功失败都看不出"到底有没有尝试上报"，
        # 排查漏报问题时只能靠猜——现在两种结果都记一行，成交编号写进去，
        # 方便日后对着后端日志核对是否真的到账。
        # Report newly detected real closed-trade legs (personal win-rate);
        # queue for retry on failure. This step used to log nothing either
        # way, making "did it even try to report" unknowable when debugging a
        # missing trade — now both outcomes are logged with the deal
        # ticket(s), so it can be cross-checked against the backend log.
        if closed_trades:
            failed = self._post_trades(closed_trades)
            if failed:
                self._pending_trades.extend(failed)
                _save_pending_trades(self._pending_trades)

        # 7) 先重试上一轮未成功回报的结果 / retry results & trades not yet acked last tick
        self._flush_reports()
        self._flush_trades()

        # 8) 旧版后端会在这里把指令给过来（新后端对 fetchCommands=False 回空列表）：
        #    照常执行，与指令循环共用同一套执行 / 回报 / 幂等缓存。
        # An older backend still hands commands over here (a new one returns none for
        # fetchCommands=False): run them through the same path as the command loop.
        if commands:
            self._execute_commands(commands, self._http)

        # 6) 通知 GUI 刷新 / notify GUI to refresh
        self.on_status(accounts, self.last_error, warning)

    def _remember_executed(self, coid: str, result: dict) -> None:
        """记录一条已执行结果并落盘，同时清理超龄条目。两条循环都会调，加锁。
        Record one executed result, persist to disk and prune stale entries."""
        now = time.time()
        with self._state_lock:
            self._executed[coid] = result
            self._executed_at[coid] = now
            stale = [k for k, ts in self._executed_at.items() if now - ts > EXECUTED_CACHE_TTL]
            for k in stale:
                self._executed.pop(k, None)
                self._executed_at.pop(k, None)
            _save_executed_cache(self._executed, self._executed_at)

    def _report_result(self, result: dict, http: "BackendClient | None" = None):
        """回报单条结果，失败则入队下一轮重试 / report one result, queue on failure."""
        try:
            (http or self._http).post("/api/bridge/result", result)
        except Exception:
            with self._state_lock:
                if result not in self._pending_reports:
                    self._pending_reports.append(result)
                    _save_pending_reports(self._pending_reports)

    def _flush_reports(self):
        """重试此前未成功回报的结果 / retry previously failed reports."""
        with self._state_lock:
            pending = list(self._pending_reports)
        if not pending:
            return
        still_pending = []
        for r in pending:
            try:
                self._http.post("/api/bridge/result", r)
            except Exception:
                still_pending.append(r)
        with self._state_lock:
            # 重试期间指令循环可能又排进了新的失败回执，别把它们冲掉。
            # The command loop may have queued new failures meanwhile; keep them.
            newer = [r for r in self._pending_reports if r not in pending]
            self._pending_reports = still_pending + newer
            if self._pending_reports != pending:
                _save_pending_reports(self._pending_reports)

    def _post_trades(self, legs: list) -> list:
        """分批上报平仓明细，返回**没能上报成功**的那些。

        分批的理由：桥接重连后会做一次数天的补扫（见 mt5_worker 的
        _BACKFILL_WINDOW），一个活跃账号可能一次产出几百条。整包发出去一旦超时，
        它会原样退回重试队列、下一轮再整包重发——同一个包永远失败，队列再也清不掉。
        切成小批之后，慢的那批失败也只拖住自己，其余照常落库。
        上报天然幂等（后端按 (用户, 账号, 成交编号) 去重），重叠重发无副作用。

        Chunked because a reconnect triggers a multi-day catch-up scan that can
        produce hundreds of legs at once: one oversized POST that times out would
        be requeued and re-sent whole forever. Reporting is idempotent, so
        overlapping re-sends are harmless.
        """
        failed: list = []
        for i in range(0, len(legs), _TRADES_PER_POST):
            chunk = legs[i:i + _TRADES_PER_POST]
            tickets = [t.get("dealTicket") for t in chunk]
            try:
                self._http.post("/api/bridge/trade-history", {"data": chunk})
                logger.info("已上报平仓明细 / reported closed trades: dealTickets=%s", tickets)
            except Exception as e:
                logger.warning(
                    "平仓明细上报失败，已入队重试 / closed-trade report failed, queued for retry: "
                    "dealTickets=%s err=%s", tickets, e,
                )
                failed.extend(chunk)
        return failed

    def _flush_trades(self):
        """重试此前未成功上报的平仓明细 / retry previously failed closed-trade reports."""
        if not self._pending_trades:
            return
        still_pending = self._post_trades(self._pending_trades)
        if still_pending != self._pending_trades:
            # 有批次成功了才落盘，避免每轮都无谓写文件
            # Persist only when something actually got through.
            self._pending_trades = still_pending
            _save_pending_trades(self._pending_trades)


def _parse_version(v: str) -> tuple[int, ...]:
    """把版本字符串解析为可比较的整数元组（忽略前缀 v 与非数字段）。
    Parse a version string into a comparable int tuple (drop 'v' prefix / non-numeric)."""
    nums: list[int] = []
    for part in v.strip().lstrip("vV").split("."):
        digits = "".join(ch for ch in part if ch.isdigit())
        if digits == "":
            break
        nums.append(int(digits))
    return tuple(nums)


def check_latest_release(timeout: float = 6.0) -> dict | None:
    """查询 GitHub 最新 Release：版本号 + 安装包资产的直链，失败返回 None。

    直链（browser_download_url）指向 GitHub 对象存储，打开即触发浏览器直接
    下载该文件，不会展示任何 GitHub 页面——这是比跳转发布页更省心的更新体验。
    找不到匹配文件名的资产时 download_url 为 None，调用方回退到发布页。

    Query the latest GitHub Release: version tag + the installer asset's direct
    URL; return None on any failure. The asset's browser_download_url points at
    GitHub's object storage and triggers an immediate browser download with no
    GitHub page in between — a smoother update flow than opening the releases
    page. download_url is None if no asset matches the expected filename; the
    caller then falls back to the releases page.
    """
    try:
        req = request.Request(LATEST_RELEASE_API, method="GET")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("User-Agent", f"PRISMX-Bridge/{APP_VERSION}")
        with request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        tag = (data.get("tag_name") or data.get("name") or "").strip()
        if not tag:
            return None
        # 除了安装包本身，还要取回哈希清单与它的签名这两个资产的直链；缺任何一个
        # 都会让 fetch_expected_sha256() 明确报错，从而退回手动下载（而不是放行）。
        # Also pick up the manifest and its signature; a missing one makes
        # fetch_expected_sha256() fail loudly and fall back to a manual download.
        urls = {BRIDGE_ASSET_FILENAME: None, UPDATE_SUMS_ASSET: None, UPDATE_SUMS_SIG_ASSET: None}
        for asset in data.get("assets", []) or []:
            name = asset.get("name")
            if name in urls and urls[name] is None:
                urls[name] = asset.get("browser_download_url")
        return {
            "tag": tag,
            "download_url": urls[BRIDGE_ASSET_FILENAME],
            "sums_url": urls[UPDATE_SUMS_ASSET],
            "sums_sig_url": urls[UPDATE_SUMS_SIG_ASSET],
        }
    except Exception:
        return None


def is_newer_version(latest: str, current: str) -> bool:
    """判断 latest 是否比 current 更新 / whether latest is newer than current."""
    lv, cv = _parse_version(latest), _parse_version(current)
    return bool(lv) and lv > cv


# ---------- 一键自更新 / one-click self-update ----------
# 以前点提示条只是把浏览器打开到安装包直链：用户要自己下载、关掉旧的、把新 exe 放回原处
# 再打开、再等它重连。一个版本一套动作，落后几版就得来几遍。现在点一下：程序自己把最新
# 安装包下载到旁边、把自己换掉、重新拉起新版本并自动重连——一次到最新版，不管中间隔了
# 几个版本（安装包直链取的本来就是 releases/latest）。
# Clicking the banner used to open a browser download; the user then had to quit,
# replace the exe and relaunch — once per version. Now one click downloads the latest
# installer next to the running exe, swaps it in, relaunches and auto-reconnects.
#
# 换文件的手法：Windows 不允许覆盖或删除正在运行的 exe，但允许给它改名。于是把自己改成
# `<exe>.old`，再把下载好的新版挪到原路径，启动新版后退出；新版启动时删掉 `.old`。
# Windows lets a running exe be renamed (not overwritten or deleted): rename self to
# `.old`, move the download into place, launch it, exit; the new build deletes `.old`.

UPDATE_MIN_BYTES = 5 * 1024 * 1024  # 安装包正常 30 MB 上下，小于这个数一定是残缺的 / a real build is ~30 MB


def frozen_exe_path() -> str | None:
    """打包态下自己的 exe 路径；源码态返回 None（源码态不做自更新）。
    The running exe's path when frozen by PyInstaller; None when run from source."""
    if getattr(sys, "frozen", False):
        return os.path.abspath(sys.executable)
    return None


def cleanup_old_binary() -> None:
    """启动时删掉上一版自更新留下的 `.old`。上一进程还没退干净时删不掉，下次启动再删。
    Remove the previous build left behind by a self-update; retried on the next launch."""
    exe = frozen_exe_path()
    if not exe:
        return
    old = exe + ".old"
    if os.path.exists(old):
        try:
            os.remove(old)
            logger.info("已清理上一版本 / removed previous build: %s", old)
        except OSError:
            pass


class UpdateVerificationError(Exception):
    """来源校验失败。抛出它就意味着**不换文件**，调用方必须退回手动下载。
    Provenance check failed: never swap the exe; fall back to a manual download."""


def _ensure_allowed_host(url: str) -> None:
    """URL 的主机必须在 UPDATE_ALLOWED_HOSTS 里 / the URL's host must be pinned."""
    host = (urlparse(url).hostname or "").lower()
    if host not in UPDATE_ALLOWED_HOSTS:
        raise UpdateVerificationError(
            f"更新下载地址不在允许的域名内 / update URL host is not allowed: {host or url!r}"
        )


def _load_update_public_key():
    """取回硬编码的发布公钥；没配置好就抛异常（调用方据此关闭自更新）。
    Return the pinned release public key; raise when it isn't usable."""
    key_b64 = (UPDATE_PUBLIC_KEY_B64 or "").strip()
    if not key_b64 or key_b64 == _UPDATE_PUBLIC_KEY_PLACEHOLDER:
        raise UpdateVerificationError(
            "尚未填入发布公钥，自更新已禁用 / release public key not configured, self-update disabled"
        )
    # cryptography 只在这条路径上用到，放在函数里导入：万一打包时漏进包，
    # 受影响的也只是自更新（会被关掉并提示手动下载），而不是整个程序起不来。
    # Imported lazily so a packaging miss only disables self-update, not the app.
    try:
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except Exception as e:  # noqa: BLE001
        raise UpdateVerificationError(
            f"缺少 cryptography 依赖，无法验签 / cryptography unavailable, cannot verify: {e}"
        ) from e
    try:
        raw = base64.b64decode(key_b64, validate=True)
    except Exception as e:  # noqa: BLE001
        raise UpdateVerificationError("发布公钥不是合法的 base64 / public key is not valid base64") from e
    if len(raw) != 32:
        raise UpdateVerificationError(
            f"发布公钥长度不对（Ed25519 应为 32 字节，实为 {len(raw)}）/ bad public key length"
        )
    return Ed25519PublicKey.from_public_bytes(raw)


def update_signing_ready() -> bool:
    """公钥是否已正确配置。False 时界面不提供一键更新，只提供手动下载。
    Whether the pinned key is usable; when False the UI only offers a manual download."""
    try:
        _load_update_public_key()
        return True
    except UpdateVerificationError as e:
        logger.warning("自更新不可用 / self-update unavailable: %s", e)
        return False


def verify_sums_signature(sums_bytes: bytes, signature_b64: str) -> None:
    """用硬编码公钥验证 SHA256SUMS 的 Ed25519 签名，不通过就抛。
    Verify the Ed25519 signature over the raw SHA256SUMS bytes."""
    key = _load_update_public_key()
    try:
        signature = base64.b64decode((signature_b64 or "").strip(), validate=True)
    except Exception as e:  # noqa: BLE001
        raise UpdateVerificationError("签名不是合法的 base64 / signature is not valid base64") from e
    try:
        key.verify(signature, sums_bytes)
    except Exception as e:  # noqa: BLE001
        # 签名不符、签名长度不对、清单被改过——全都走这里。
        # Wrong signature, wrong length, tampered manifest: all land here.
        raise UpdateVerificationError(
            "哈希清单的签名校验未通过 / SHA256SUMS signature verification failed"
        ) from e


def expected_sha256_from_sums(sums_text: str, filename: str) -> str:
    """从 SHA256SUMS 文本里取出 filename 那一行的哈希（小写十六进制）。
    Pull the digest for `filename` out of a sha256sum-format manifest."""
    found = None
    for line in sums_text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        digest = parts[0].strip().lower()
        # sha256sum 的二进制模式会在文件名前加一个 "*" / binary mode prefixes "*"
        name = os.path.basename(parts[1].strip().lstrip("*"))
        if name != filename:
            continue
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise UpdateVerificationError(f"哈希清单里 {filename} 的哈希格式不对 / malformed digest")
        # 同一个文件名出现两条不同哈希，说明清单本身就有歧义，宁可不更新。
        # Two different digests for one name means an ambiguous manifest: refuse.
        if found is not None and found != digest:
            raise UpdateVerificationError(f"哈希清单里 {filename} 有互相冲突的两条记录 / conflicting entries")
        found = digest
    if found is None:
        raise UpdateVerificationError(f"哈希清单里没有 {filename} / {filename} is not listed in the manifest")
    return found


def sha256_file(path: str) -> str:
    """分块算文件的 SHA-256（安装包 30 MB 上下，不要整包读进内存）。
    Chunked SHA-256 of a file; the installer is ~30 MB."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _http_get_bytes(url: str, timeout: float = 15.0, max_bytes: int = UPDATE_TEXT_ASSET_MAX_BYTES) -> bytes:
    """取回一个小文本资产（哈希清单 / 签名），带域名钉死与体积上限。
    Fetch a small text asset with host pinning and a size cap."""
    _ensure_allowed_host(url)
    req = request.Request(url, method="GET")
    req.add_header("User-Agent", f"PRISMX-Bridge/{APP_VERSION}")
    with request.urlopen(req, timeout=timeout) as resp:
        _ensure_allowed_host(resp.geturl())          # 重定向后的最终地址也要查 / check after redirects
        data = resp.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise UpdateVerificationError(f"{url} 返回的内容过大 / response too large")
    return data


def fetch_expected_sha256(release: dict, filename: str = BRIDGE_ASSET_FILENAME) -> str:
    """取回并验签哈希清单，返回 filename 应有的 SHA-256。任何问题都抛异常。
    Fetch + verify the signed manifest, returning the expected digest."""
    sums_url = release.get("sums_url")
    sig_url = release.get("sums_sig_url")
    if not sums_url or not sig_url:
        raise UpdateVerificationError(
            f"这个 Release 没有附 {UPDATE_SUMS_ASSET} 与 {UPDATE_SUMS_SIG_ASSET}，"
            f"无法校验来源 / release is missing the signed checksum manifest"
        )
    sums_bytes = _http_get_bytes(sums_url)
    sig_bytes = _http_get_bytes(sig_url)
    try:
        sig_text = sig_bytes.decode("ascii").strip()
    except UnicodeDecodeError as e:
        raise UpdateVerificationError("签名文件不是 ASCII 文本 / signature file is not ASCII") from e
    verify_sums_signature(sums_bytes, sig_text)
    try:
        sums_text = sums_bytes.decode("utf-8")
    except UnicodeDecodeError as e:
        # 走到这里说明签名验过了但内容不是文本，属于发布流程出错。
        # Signature verified but the content isn't text: a broken release.
        raise UpdateVerificationError("哈希清单不是 UTF-8 文本 / manifest is not UTF-8") from e
    digest = expected_sha256_from_sums(sums_text, filename)
    logger.info("哈希清单验签通过 / manifest signature ok: %s = %s", filename, digest)
    return digest


def verify_downloaded_installer(dest: str, expected_sha256: str) -> None:
    """对已下载的文件做两道检查：像不像安装包（给出好读的报错）+ 哈希是否与清单一致。
    不一致就删掉它并抛异常——绝不能把一个来源不明的 exe 留在原地等着被换进去。
    Sanity-check the download, then compare its digest with the signed manifest;
    a mismatch deletes the file and raises."""
    size = os.path.getsize(dest)
    with open(dest, "rb") as f:
        head = f.read(2)
    if head != b"MZ" or size < UPDATE_MIN_BYTES:
        raise UpdateVerificationError(
            f"下载的文件不是完整的安装包 / downloaded file is not a complete installer ({size} bytes)"
        )
    actual = sha256_file(dest)
    # 常量时间比较：这里比的是公开的哈希值，泄漏风险本就很低，但统一用
    # compare_digest 免得以后有人照抄这段去比对秘密值。
    # Constant-time compare — the digest isn't secret, but keep the habit.
    if not hmac.compare_digest(actual, (expected_sha256 or "").lower()):
        try:
            os.remove(dest)
        except OSError:
            pass
        raise UpdateVerificationError(
            f"安装包哈希与已签名的清单不符，已丢弃 / digest mismatch, download discarded "
            f"(expected {expected_sha256}, got {actual})"
        )


def download_release(url: str, dest: str, progress, expected_sha256: str, timeout: float = 30.0) -> None:
    """流式下载安装包到 dest，每收到一块调一次 progress(done, total)，下载完比对哈希。

    `expected_sha256` 是**必填**位置参数，来自 fetch_expected_sha256() 验过签的清单：
    做成必填就没法「忘了传」——少传一个参数是 TypeError，而不是静默地不校验。
    `expected_sha256` is a required positional arg so it can't be silently omitted.
    """
    _ensure_allowed_host(url)
    req = request.Request(url, method="GET")
    req.add_header("User-Agent", f"PRISMX-Bridge/{APP_VERSION}")
    with request.urlopen(req, timeout=timeout) as resp, open(dest, "wb") as f:
        _ensure_allowed_host(resp.geturl())          # 重定向后的最终地址也要查 / check after redirects
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while True:
            chunk = resp.read(256 * 1024)
            if not chunk:
                break
            f.write(chunk)
            done += len(chunk)
            progress(done, total)
    verify_downloaded_installer(dest, expected_sha256)


def swap_in_update(new_path: str) -> str:
    """把下载好的新版换到自己的位置，返回新 exe 路径。挪不进去就把自己改回来。
    Rename self to .old and move the download into place; roll back on failure."""
    exe = frozen_exe_path()
    if not exe:
        raise RuntimeError("源码态不做自更新 / self-update only applies to the packaged exe")
    old = exe + ".old"
    if os.path.exists(old):
        try:
            os.remove(old)
        except OSError:
            # 上上次的 .old 还被占着：换个名字让路 / still locked: park it under another name
            os.rename(old, f"{exe}.old.{int(time.time())}")
    os.rename(exe, old)
    try:
        os.replace(new_path, exe)
    except Exception:
        os.rename(old, exe)
        raise
    return exe


# ---------- GUI ----------
class BridgeGUI:
    """tkinter 界面：先要 Token，连接后显示多账号状态。
    tkinter UI: ask for token first, then show multi-account status.
    """

    def __init__(self, root: tk.Tk):
        self.root = root
        self.engine: BridgeEngine | None = None
        self.tray_icon = None  # pystray.Icon | None，惰性创建 / created lazily
        cfg = load_config()
        self.saved_token = cfg.get("token", "")

        root.title(f"PRISMX Bridge v{APP_VERSION}")
        root.geometry("760x720")
        root.resizable(False, False)
        root.configure(bg=self.BG)
        self._set_app_icon(root)
        self._buttons: dict[str, dict] = {}
        self._init_style()
        self._build_widgets()
        # 启动后在后台检查更新（不阻塞 UI）/ check for updates in background after launch
        self._start_update_check()
        # 记住 token 却要求每次开机手动点「连接」，对一个理应 7×24 挂机的
        # 程序来说很烦——本地存过 token 就自动连接，用户仍可随时手动断开。
        # Remembering the token but still requiring a manual "Connect" click
        # every launch is annoying for an app meant to run around the clock —
        # auto-connect whenever a token is already saved; the user can still
        # disconnect manually at any time.
        if self.saved_token:
            self.root.after(300, self._on_connect)

    def _set_app_icon(self, root: tk.Tk):
        """设置窗口/任务栏图标 / set the window & taskbar icon."""
        ico = resource_path("app.ico")
        if os.path.exists(ico):
            try:
                root.iconbitmap(default=ico)
            except tk.TclError:
                pass
            # 让任务栏使用应用自身图标而非 python 宿主图标
            # make the taskbar use this app's icon instead of the python host
            try:
                ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("PRISMX.Bridge")
            except Exception:
                pass

    # ---------- 主题配色 / theme palette ----------
    BG = "#07070c"        # 近黑背景 / near-black background
    CARD = "#11111c"      # 卡片底 / card surface
    CARD_HI = "#181826"   # 卡片高亮底 / elevated card surface
    FIELD = "#0b0b13"     # 输入框底 / input field
    BORDER = "#262640"    # 描边 / border
    ACCENT = "#8b46ff"    # 荧光紫 / neon violet
    ACCENT_HI = "#a779ff" # 亮紫 / bright violet
    ACCENT_DK = "#5b22c9" # 深紫 / deep violet
    OK = "#37e0a6"        # 在线绿 / online green
    WARN = "#f5c451"      # 警告黄 / warning amber
    ERR = "#ff5c7a"       # 错误红 / error red
    TEXT = "#e9e9f2"      # 主文字 / primary text
    MUTED = "#8a8aa3"     # 次要文字 / muted text
    FAINT = "#50506e"     # 极弱文字 / faint text

    def _init_style(self):
        """配置 ttk 暗色主题（表格）/ configure dark ttk theme for the table."""
        style = ttk.Style()
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure(
            "PX.Treeview",
            background=self.CARD_HI, fieldbackground=self.CARD_HI, foreground=self.TEXT,
            borderwidth=0, rowheight=32, font=("Segoe UI", 9),
        )
        style.map("PX.Treeview", background=[("selected", "#2a1d4d")], foreground=[("selected", self.ACCENT_HI)])
        style.configure(
            "PX.Treeview.Heading",
            background=self.CARD_HI, foreground=self.MUTED, relief="flat",
            borderwidth=0, padding=(6, 8), font=("Segoe UI", 8, "bold"),
        )
        style.map("PX.Treeview.Heading", background=[("active", "#22223a")])
        # 滚动条暗色 / dark scrollbar
        style.configure(
            "PX.Vertical.TScrollbar", background=self.BORDER, troughcolor=self.CARD_HI,
            borderwidth=0, arrowcolor=self.MUTED,
        )

    def _draw_logo(self, parent, px=40):
        """用 Canvas 绘制新 logo：黑底圆角 + 荧光紫三角描边（中间镂空）。
        Draw the new logo on a Canvas: black rounded base + neon-violet
        triangle outline with a hollow center.
        """
        c = tk.Canvas(parent, width=px, height=px, bg=self.BG, highlightthickness=0)
        # 黑色圆角底 / black rounded base
        r, pad = px * 0.26, 1
        x0, y0, x1, y1 = pad, pad, px - pad, px - pad
        c.create_oval(x0, y0, x0 + 2 * r, y0 + 2 * r, fill="#000000", outline="")
        c.create_oval(x1 - 2 * r, y0, x1, y0 + 2 * r, fill="#000000", outline="")
        c.create_oval(x0, y1 - 2 * r, x0 + 2 * r, y1, fill="#000000", outline="")
        c.create_oval(x1 - 2 * r, y1 - 2 * r, x1, y1, fill="#000000", outline="")
        c.create_rectangle(x0 + r, y0, x1 - r, y1, fill="#000000", outline="")
        c.create_rectangle(x0, y0 + r, x1, y1 - r, fill="#000000", outline="")
        # 荧光紫三角形描边（中间镂空）/ neon-violet hollow triangle
        apex = (px * 0.5, px * 0.20)
        bl = (px * 0.18, px * 0.78)
        br = (px * 0.82, px * 0.78)
        tri = [*apex, *br, *bl]
        # 外层微光 / outer glow
        c.create_polygon(tri, outline="#5b22c9", fill="", width=6, joinstyle="round")
        c.create_polygon(tri, outline=self.ACCENT, fill="", width=3, joinstyle="round")
        c.create_polygon(tri, outline=self.ACCENT_HI, fill="", width=1.4, joinstyle="round")
        return c

    # ---------- 圆角绘制工具 / rounded-rect drawing helpers ----------
    CARD_W = 716  # 卡片统一宽度 / unified card width

    def _round_rect(self, cv, x1, y1, x2, y2, r, **kw):
        """在 Canvas 上画一个平滑圆角矩形 / draw a smooth rounded rectangle."""
        pts = [
            x1 + r, y1, x2 - r, y1, x2, y1, x2, y1 + r,
            x2, y2 - r, x2, y2, x2 - r, y2, x1 + r, y2,
            x1, y2, x1, y2 - r, x1, y1 + r, x1, y1,
        ]
        return cv.create_polygon(pts, smooth=True, **kw)

    def _card(self, parent, height, pad=18):
        """创建一张圆角卡片，返回内部内容 Frame。
        Create a rounded card; return its inner content frame.
        """
        w = self.CARD_W
        cv = tk.Canvas(parent, width=w, height=height, bg=self.BG, highlightthickness=0)
        cv.pack(padx=22, pady=7)
        self._round_rect(cv, 1, 1, w - 1, height - 1, 20, fill=self.CARD, outline=self.BORDER, width=1)
        inner = tk.Frame(cv, bg=self.CARD)
        cv.create_window(pad, pad, anchor="nw", window=inner, width=w - 2 * pad, height=height - 2 * pad)
        return inner

    def _make_button(self, parent, text, command, kind="primary", width=212, height=46):
        """创建圆角按钮（Canvas 自绘），返回状态字典。
        Create a rounded (Canvas-drawn) button; return its state dict.
        """
        if kind == "primary":
            fill, fill_hi, fg = self.ACCENT, self.ACCENT_HI, "white"
        else:
            fill, fill_hi, fg = "#262640", "#33335a", self.TEXT
        cv = tk.Canvas(parent, width=width, height=height, bg=self.CARD, highlightthickness=0, cursor="hand2")
        rect = self._round_rect(cv, 2, 2, width - 2, height - 2, (height - 4) // 2, fill=fill, outline="")
        label = cv.create_text(width // 2, height // 2, text=text, fill=fg, font=("Segoe UI", 10, "bold"))
        state = {"cv": cv, "rect": rect, "label": label, "fill": fill, "fill_hi": fill_hi,
                 "fg": fg, "enabled": True, "command": command}

        def on_click(_e):
            if state["enabled"]:
                command()

        def on_enter(_e):
            if state["enabled"]:
                cv.itemconfig(rect, fill=fill_hi)

        def on_leave(_e):
            if state["enabled"]:
                cv.itemconfig(rect, fill=fill)

        cv.bind("<Button-1>", on_click)
        cv.bind("<Enter>", on_enter)
        cv.bind("<Leave>", on_leave)
        return state

    def _set_button(self, state, enabled: bool):
        """启用/禁用圆角按钮并切换配色 / toggle a rounded button's enabled state."""
        state["enabled"] = enabled
        state["cv"].itemconfig(state["rect"], fill=state["fill"] if enabled else "#1a1a28")
        state["cv"].itemconfig(state["label"], fill=state["fg"] if enabled else self.FAINT)
        state["cv"].config(cursor="hand2" if enabled else "arrow")

    def _build_widgets(self):
        # 标题区：logo + 名称 / header: logo + title
        title_row = tk.Frame(self.root, bg=self.BG)
        self._title_row = title_row
        title_row.pack(fill="x", padx=30, pady=(22, 10))
        self._draw_logo(title_row, px=50).pack(side="left")
        name_box = tk.Frame(title_row, bg=self.BG)
        name_box.pack(side="left", padx=16)
        tk.Label(
            name_box, text="PRISMX Bridge",
            font=("Segoe UI Semibold", 19, "bold"), fg=self.TEXT, bg=self.BG,
        ).pack(anchor="w")
        tk.Label(
            name_box, text=f"棱镜桥接 · MT5 Connector · v{APP_VERSION}",
            font=("Segoe UI", 9), fg=self.ACCENT_HI, bg=self.BG,
        ).pack(anchor="w", pady=(2, 0))

        # 更新提示条（默认隐藏，检测到新版本时显示）/ update banner (hidden until a newer version is found)
        self.update_bar = tk.Frame(self.root, bg="#2a1d4d", cursor="hand2")
        self.update_var = tk.StringVar(value="")
        self._update_url = RELEASES_PAGE
        bar_lbl = tk.Label(
            self.update_bar, textvariable=self.update_var, fg=self.ACCENT_HI, bg="#2a1d4d",
            font=("Segoe UI", 9, "bold"), anchor="w", padx=14, pady=8, cursor="hand2",
        )
        bar_lbl.pack(side="left", fill="x", expand=True)
        close_lbl = tk.Label(
            self.update_bar, text="✕", fg=self.MUTED, bg="#2a1d4d",
            font=("Segoe UI", 9, "bold"), padx=12, cursor="hand2",
        )
        close_lbl.pack(side="right")
        for w in (self.update_bar, bar_lbl):
            w.bind("<Button-1>", lambda _e: self._on_update_click())
        self._update_release: dict | None = None
        self._updating = False
        self._update_failed = False
        close_lbl.bind("<Button-1>", lambda _e: self.update_bar.pack_forget())

        # 连接卡片：Token 输入 + 操作按钮 / connection card
        conn = self._card(self.root, height=212, pad=22)
        tk.Label(
            conn, text="API TOKEN", fg=self.MUTED, bg=self.CARD,
            font=("Segoe UI", 8, "bold"),
        ).pack(anchor="w")
        tk.Label(
            conn, text="粘贴网页「绑定」页的 Token / Paste the token from the web Bind page",
            fg=self.FAINT, bg=self.CARD, font=("Segoe UI", 8),
        ).pack(anchor="w", pady=(3, 10))

        # 圆角输入框 + 显示按钮 / rounded entry + show toggle
        entry_row = tk.Frame(conn, bg=self.CARD)
        entry_row.pack(fill="x")
        field_w, field_h = 520, 46
        field_cv = tk.Canvas(entry_row, width=field_w, height=field_h, bg=self.CARD, highlightthickness=0)
        field_cv.pack(side="left")
        self._round_rect(field_cv, 1, 1, field_w - 1, field_h - 1, 14, fill=self.FIELD, outline=self.BORDER, width=1)
        self.token_var = tk.StringVar(value=self.saved_token)
        self.token_entry = tk.Entry(
            field_cv, textvariable=self.token_var, show="•",
            bg=self.FIELD, fg=self.TEXT, insertbackground=self.ACCENT_HI,
            relief="flat", font=("Consolas", 11), bd=0,
        )
        field_cv.create_window(16, field_h // 2, anchor="w", window=self.token_entry, width=field_w - 32)

        self._token_shown = False
        self.eye_btn = self._make_button(entry_row, "显示", self._toggle_token, kind="ghost", width=78, height=46)
        self.eye_btn["cv"].pack(side="left", padx=(12, 0))

        self.backend_var = tk.StringVar(value=DEFAULT_BACKEND)

        # 连接 / 断开按钮 / connect & disconnect buttons
        btns = tk.Frame(conn, bg=self.CARD)
        btns.pack(fill="x", pady=(16, 0))
        self.connect_btn = self._make_button(btns, "连接 / Connect", self._on_connect, kind="primary", width=318, height=48)
        self.connect_btn["cv"].pack(side="left")
        self.disconnect_btn = self._make_button(btns, "断开 / Disconnect", self._on_disconnect, kind="ghost", width=318, height=48)
        self.disconnect_btn["cv"].pack(side="left", padx=(16, 0))
        self._set_button(self.disconnect_btn, False)

        # 开机自启开关：只在打包态展示（源码运行没有单一可执行文件可指向）。
        # Autostart toggle: only shown in the packaged build (source-run has no
        # single executable path to register).
        if autostart_supported():
            self.autostart_var = tk.BooleanVar(value=is_autostart_enabled())
            autostart_cb = tk.Checkbutton(
                conn, text="开机自启动 / Start with Windows",
                variable=self.autostart_var, command=self._on_toggle_autostart,
                bg=self.CARD, fg=self.MUTED, activebackground=self.CARD, activeforeground=self.TEXT,
                selectcolor=self.FIELD, font=("Segoe UI", 9), bd=0, highlightthickness=0,
                anchor="w", cursor="hand2",
            )
            autostart_cb.pack(fill="x", pady=(10, 0))

        # 状态指示灯 + 文案 / status dot + text
        status_row = tk.Frame(self.root, bg=self.BG)
        status_row.pack(fill="x", padx=32, pady=(12, 8))
        self.status_dot = tk.Canvas(status_row, width=14, height=14, bg=self.BG, highlightthickness=0)
        self.status_dot.pack(side="left")
        self._draw_dot(self.FAINT)
        self.status_var = tk.StringVar(value="未连接 / Not connected")
        tk.Label(
            status_row, textvariable=self.status_var, fg=self.MUTED, bg=self.BG,
            font=("Segoe UI", 9),
        ).pack(side="left", padx=10)

        # 账号卡片：标题 + 表格 / accounts card
        acct = self._card(self.root, height=326, pad=20)
        acct_head = tk.Frame(acct, bg=self.CARD)
        acct_head.pack(fill="x", pady=(0, 10))
        tk.Label(
            acct_head, text="已连接账号 / Connected Accounts", fg=self.TEXT, bg=self.CARD,
            font=("Segoe UI", 11, "bold"),
        ).pack(side="left")
        self.count_var = tk.StringVar(value="0 个")
        tk.Label(
            acct_head, textvariable=self.count_var, fg=self.ACCENT_HI, bg=self.CARD,
            font=("Segoe UI", 10, "bold"),
        ).pack(side="right")

        table_wrap = tk.Frame(acct, bg=self.CARD_HI)
        table_wrap.pack(fill="both", expand=True)
        cols = ("login", "name", "company", "balance", "equity")
        heads = ("账号", "名称", "券商", "余额", "净值")
        self.tree = ttk.Treeview(
            table_wrap, columns=cols, show="headings", height=7, style="PX.Treeview",
        )
        for c, h, w in zip(cols, heads, (95, 150, 150, 100, 100)):
            self.tree.heading(c, text=h)
            self.tree.column(c, width=w, anchor="center")
        self.tree.pack(fill="both", expand=True, padx=6, pady=6)

        # 底部：日志路径提示 / footer
        tk.Label(
            self.root, text=f"运行日志 / Log: {LOG_PATH}",
            font=("Segoe UI", 8), fg=self.FAINT, bg=self.BG,
        ).pack(anchor="w", padx=32, pady=(8, 12))

    def _start_update_check(self):
        """后台线程检查 GitHub 是否有更新版本 / check GitHub for a newer version on a thread.

        启动时立即检查一次，之后每 UPDATE_CHECK_INTERVAL 秒复查一次。
        Check once on launch, then re-check every UPDATE_CHECK_INTERVAL seconds.
        """
        def worker():
            # 以前提示过一次就 return，轮询线程直接结束：用户随手把提示条点掉（或
            # 一次自更新失败）之后，这个本该 7×24 挂机的程序就永远停在旧版本上，
            # 连之后发布的更新版也不会再提示。现在改成一直轮询，只是不为**同一个
            # 版本号**重复提示；出了更新的版本仍然会再弹一次。
            # This used to return after the first notification, so dismissing the
            # banner once pinned a 24/7 app to an old build forever. Keep polling;
            # only suppress repeats of the same tag.
            notified_tag = None
            while True:
                release = check_latest_release()
                if (
                    release
                    and is_newer_version(release["tag"], APP_VERSION)
                    and release["tag"] != notified_tag
                ):
                    notified_tag = release["tag"]
                    # 切回 UI 线程更新提示条 / marshal back to the UI thread
                    self.root.after(0, lambda r=release: self._show_update(r))
                time.sleep(UPDATE_CHECK_INTERVAL)
        threading.Thread(target=worker, daemon=True).start()

    def _show_update(self, release: dict):
        """显示更新提示条 / reveal the update banner."""
        latest = release["tag"]
        # 优先直接下载安装包；找不到匹配资产才退回发布页。
        # Prefer downloading the installer directly; fall back to the releases
        # page only if no matching asset was found.
        # 换了一个新版本号就把「上次更新失败」的记忆清掉：上一版下载失败不代表
        # 这一版也会失败，否则一次失败会把之后所有版本都锁在手动下载上。
        # A new tag clears the previous failure: one bad download must not pin
        # every future version to the manual path.
        if (self._update_release or {}).get("tag") != latest:
            self._update_failed = False
        self._update_url = release.get("download_url") or RELEASES_PAGE
        self._update_release = release
        # 一键自更新的三个前提缺一不可：打包态、有安装包直链、**公钥已配置**。
        # 公钥还是占位符时这里就是 False，界面只会引导手动下载——不校验就换 exe
        # 这条路根本不存在。同理，Release 里没有签名清单时下一步会抛错回退。
        # All three must hold: frozen build, a direct asset link, and a configured
        # key. A placeholder key leaves only the manual path; there is no
        # "update without verifying" branch at all.
        can_self_update = (
            frozen_exe_path() is not None
            and bool(release.get("download_url"))
            and update_signing_ready()
        )
        self.update_var.set(
            f"发现新版本 {latest}（当前 v{APP_VERSION}），点击一键更新并重启  /  "
            f"Update {latest} available — click to update and restart"
            if can_self_update else
            f"发现新版本 {latest}（当前 v{APP_VERSION}），点击直接下载安装包  /  "
            f"Update {latest} available — click to download the installer"
        )
        # 插在标题行之后、连接卡片之前 / place it right below the header
        self.update_bar.pack(fill="x", padx=22, pady=(0, 6), after=self._title_row)
        logger.info("发现新版本 / update available: %s (current %s)", latest, APP_VERSION)

    def _on_update_click(self):
        """点提示条：打包态且有安装包直链就一键自更新；否则（源码态 / 没找到资产 / 上次自更新
        失败）退回打开浏览器下载。
        Banner click: self-update when packaged and a direct link exists; otherwise
        (source checkout / no asset / previous self-update failed) open the browser."""
        if self._updating:
            return
        release = self._update_release or {}
        if (
            self._update_failed
            or frozen_exe_path() is None
            or not release.get("download_url")
            or not update_signing_ready()      # 公钥没配好就只能手动下载 / no key ⇒ manual only
        ):
            self._open_update_page()
            return
        self._updating = True
        threading.Thread(target=self._self_update_worker, args=(release,), daemon=True).start()

    def _self_update_worker(self, release: dict):
        """后台下载 → 换文件 → 回 UI 线程重启。任何一步失败都把提示条改成"点击手动下载"。
        Download → swap → restart on the UI thread; any failure degrades to manual download."""
        latest = release.get("tag", "")
        url = release["download_url"]
        exe = frozen_exe_path()
        tmp = exe + ".new"

        def progress(done: int, total: int):
            if total > 0:
                text = f"正在下载新版本 {latest}… {done * 100 // total}%  /  Downloading {latest}… {done * 100 // total}%"
            else:
                text = f"正在下载新版本 {latest}… {done // (1024 * 1024)} MB  /  Downloading {latest}…"
            self.root.after(0, lambda t=text: self.update_var.set(t))

        try:
            logger.info("自更新开始 / self-update start: %s -> %s", url, tmp)
            # 顺序很要紧：先把已签名的哈希清单拿回来验签，拿到本次应有的哈希，
            # 再开始下 30 MB 的安装包。清单不对就根本不用下载了。
            # Order matters: verify the signed manifest first, then download.
            self.root.after(0, lambda: self.update_var.set(
                f"正在校验发布签名…  /  Verifying release signature…"
            ))
            expected = fetch_expected_sha256(release)
            download_release(url, tmp, progress, expected)
            new_exe = swap_in_update(tmp)
        except Exception as e:  # noqa: BLE001
            logger.exception("自更新失败 / self-update failed: %s", e)
            # 校验失败与「网络断了」是两回事，必须让用户看得出区别：前者意味着
            # 拿到的包**来源不可信**，这时候引导他去官方发布页手动下载才安全。
            # Distinguish a failed provenance check from a plain network error:
            # the former means the bytes were not trustworthy.
            verification_failed = isinstance(e, UpdateVerificationError)
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except OSError:
                pass

            def failed():
                self._updating = False
                self._update_failed = True
                self.update_var.set(
                    "更新包来源校验未通过，已阻止自动更新；点击前往官方发布页手动下载  /  "
                    "Update blocked: signature/checksum check failed — click to download "
                    "from the official releases page"
                    if verification_failed else
                    "自动更新失败，点击改为手动下载安装包  /  "
                    "Auto-update failed — click to download the installer instead"
                )
            self.root.after(0, failed)
            return
        self.root.after(0, lambda: self._restart_into(new_exe))

    def _restart_into(self, new_exe: str):
        """停掉桥接与托盘，拉起新版本，然后退出。

        原来这里传了个 `--autoconnect`，但 main() 从来没解析过它——重连其实是由
        「本地存过 token 就自动连接」那段实现的（见 __init__ 末尾）。留着一个不存在的
        参数会让人以为自动重连靠它，将来删掉那段自动连接的代码就会踩空，所以去掉。
        The old `--autoconnect` flag was never parsed; auto-reconnect actually comes
        from the saved-token branch in __init__. Dropping the flag so nobody relies
        on a switch that does nothing.
        """
        self.update_var.set("下载完成，正在重启到新版本…  /  Restarting into the new version…")
        self.root.update_idletasks()
        if self.engine:
            self.engine.stop()
            self.engine = None
        if self.tray_icon is not None:
            try:
                self.tray_icon.stop()
            except Exception:
                pass
        logger.info("自更新：启动新版本并退出 / self-update: launching %s", new_exe)
        try:
            subprocess.Popen(
                [new_exe],
                cwd=os.path.dirname(new_exe),
                close_fds=True,
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
            )
        except Exception as e:  # noqa: BLE001
            logger.exception("启动新版本失败 / failed to launch new build: %s", e)
            self._updating = False
            self._update_failed = True
            self.update_var.set("新版本已就位但启动失败，请手动重新打开程序  /  Updated, please relaunch the app manually")
            return
        self.root.after(400, self._exit_now)

    def _exit_now(self):
        try:
            self.root.destroy()
        except Exception:
            pass
        os._exit(0)

    def _open_update_page(self):
        """打开安装包直链（触发浏览器直接下载）；无直链则退回发布页。
        Open the installer's direct link (triggers an immediate browser
        download); falls back to the releases page if no direct link exists.
        """
        try:
            webbrowser.open(self._update_url)
        except Exception:
            pass

    def _draw_dot(self, color):
        """绘制状态指示灯 / draw the status dot."""
        self.status_dot.delete("all")
        self.status_dot.create_oval(2, 2, 12, 12, fill=color, outline="")

    def _toggle_token(self):
        """切换 Token 明文显示 / toggle token plaintext visibility."""
        self._token_shown = not self._token_shown
        self.token_entry.config(show="" if self._token_shown else "•")
        self.eye_btn["cv"].itemconfig(self.eye_btn["label"], text="隐藏" if self._token_shown else "显示")

    def _on_toggle_autostart(self):
        """勾选/取消开机自启；失败则回滚勾选框并提示。
        Toggle autostart; roll back the checkbox and warn on failure."""
        wanted = self.autostart_var.get()
        ok = set_autostart_enabled(wanted)
        if not ok:
            self.autostart_var.set(not wanted)
            messagebox.showwarning(
                "PRISMX Bridge",
                "设置开机自启失败，请检查权限后重试。\n"
                "Failed to update the Windows startup setting; check permissions and try again.",
            )

    def _on_connect(self):
        token = self.token_var.get().strip()
        # 后端地址固定为线上地址，不再从用户输入或旧配置读取。
        # Backend is fixed to production; never read from user input or stale config.
        backend = DEFAULT_BACKEND
        if not token:
            messagebox.showwarning("PRISMX Bridge", "请先填写 API Token / Please enter your API token")
            return
        try:
            save_config({"token": token, "backend": backend})
        except TokenStorageError:
            # 加密不可用：token 只留在内存里，照常连接，但要告诉用户下次得重输。
            # Encryption unavailable: keep the token in memory only, connect as
            # usual, and tell the user it must be re-entered next time.
            logger.warning("DPAPI 不可用，token 未保存 / DPAPI unavailable, token not persisted")
            messagebox.showwarning(
                "PRISMX Bridge",
                "无法安全保存 API Token（系统加密不可用）。本次仍可连接，但下次启动需要重新输入。\n"
                "The API token could not be stored securely (system encryption unavailable). "
                "This session will connect, but you will need to enter it again next launch.",
            )
        self.engine = BridgeEngine(token, backend, self._on_status)
        self.engine.start()
        logger.info("已连接后端 / connected to backend: %s", backend)
        self._set_button(self.connect_btn, False)
        self._set_button(self.disconnect_btn, True)
        self.token_entry.config(state="disabled")
        self._draw_dot(self.WARN)
        self.status_var.set("已连接，正在扫描 MT5… / Connected, scanning MT5…")

    def _on_disconnect(self):
        if self.engine:
            self.engine.stop()
            self.engine = None
        self._set_button(self.connect_btn, True)
        self._set_button(self.disconnect_btn, False)
        self.token_entry.config(state="normal")
        self._draw_dot(self.FAINT)
        self.status_var.set("未连接 / Not connected")
        self.count_var.set("0 个")
        for row in self.tree.get_children():
            self.tree.delete(row)

    def _on_status(self, accounts: list, last_error: str | None, warning: str | None = None):
        """后台线程回调，切回主线程更新界面 / marshal back to the UI thread."""
        self.root.after(0, lambda: self._render(accounts, last_error, warning))

    def _render(self, accounts: list, last_error: str | None, warning: str | None = None):
        for row in self.tree.get_children():
            self.tree.delete(row)
        for a in accounts:
            self.tree.insert("", "end", values=(
                a.get("login", ""),
                a.get("accountName", ""),
                a.get("company", ""),
                a.get("balance", ""),
                a.get("equity", ""),
            ))
        self.count_var.set(f"{len(accounts)} 个")
        if last_error:
            self._draw_dot(self.ERR)
            self.status_var.set(f"已连接 · {len(accounts)} 个账号 · 错误: {last_error}")
        elif accounts:
            # 有账号被后端拒绝（非合作券商/超出套餐额度）：显示为警告而非绿色
            # 正常态，避免用户误以为一切正常。
            # Some accounts were rejected by the backend (wrong broker / over
            # the plan's limit): show as a warning rather than plain green, so
            # the user doesn't assume everything is fine.
            self._draw_dot(self.WARN if warning else self.OK)
            base = f"已连接 · 在线账号 {len(accounts)} 个 / {len(accounts)} account(s) online"
            self.status_var.set(f"{base} · ⚠ {warning}" if warning else base)
        else:
            self._draw_dot(self.WARN)
            self.status_var.set("已连接 · 未检测到已登录的 MT5 终端 / No logged-in MT5 terminal found")

    def on_close(self):
        """窗口 X 按钮：有托盘就最小化到托盘,继续在后台接收/执行交易；
        没有托盘依赖时退回旧行为(直接走真正退出的确认流程)。

        Window's X button: minimize to the system tray when available so
        trading keeps running in the background; without the tray dependency,
        fall back to the old behavior (go straight to the real-exit confirm).
        """
        if _TRAY_AVAILABLE:
            self._minimize_to_tray()
        else:
            self._do_exit()

    def _minimize_to_tray(self):
        """隐藏主窗口，惰性创建并显示托盘图标 / hide the window; lazily create & show the tray icon."""
        self.root.withdraw()
        first_time = self.tray_icon is None
        if self.tray_icon is None:
            self.tray_icon = self._build_tray_icon()
            threading.Thread(target=self.tray_icon.run, daemon=True).start()
        if first_time:
            # 只在第一次最小化时提示一次，避免用户以为点 X 真的退出了程序。
            # Only notify on the first minimize, so the user doesn't think X
            # actually quit the app.
            try:
                self.tray_icon.notify(
                    "仍在后台运行，交易照常执行 / Still running in the background",
                    "PRISMX Bridge",
                )
            except Exception:
                pass

    def _build_tray_icon(self):
        """构造托盘图标 + 右键菜单（显示窗口 / 退出）。
        Build the tray icon + right-click menu (Show window / Exit)."""
        try:
            ico_path = resource_path("app.ico")
            image = PILImage.open(ico_path) if os.path.exists(ico_path) else PILImage.new("RGB", (32, 32), "#8b46ff")
        except Exception:
            image = PILImage.new("RGB", (32, 32), "#8b46ff")
        menu = pystray.Menu(
            pystray.MenuItem("显示窗口 / Show window", self._tray_show, default=True),
            pystray.MenuItem("退出 / Exit", self._tray_exit),
        )
        return pystray.Icon("prismx_bridge", image, "PRISMX Bridge", menu)

    def _tray_show(self, icon=None, item=None):
        # pystray 的回调跑在它自己的线程上，切回 tkinter 主线程再动窗口。
        # pystray callbacks run on its own thread; marshal back to the tkinter
        # main thread before touching the window.
        self.root.after(0, self._restore_window)

    def _restore_window(self):
        if self.tray_icon is not None:
            self.tray_icon.stop()
            self.tray_icon = None
        self.root.deiconify()
        self.root.lift()
        self.root.focus_force()

    def _tray_exit(self, icon=None, item=None):
        self.root.after(0, self._do_exit)

    def _do_exit(self):
        """真正退出：连接中二次确认，停引擎、收托盘、关窗口。
        The real exit: confirm while connected, stop the engine, tear down
        the tray icon, close the window."""
        # 从托盘发起退出时窗口是隐藏的，askyesno 弹窗在这种状态下仍能正常
        # 显示在最前，但先取消隐藏更保险，避免弹窗被父窗口挡住/找不到。
        # Exiting from the tray leaves the window hidden; askyesno still shows
        # up fine, but un-hiding first is safer so the dialog isn't hidden
        # behind/lost relative to its (invisible) parent.
        if self.root.state() == "withdrawn":
            self.root.deiconify()
        if self.engine is not None:
            ok = messagebox.askyesno(
                "PRISMX Bridge",
                "桥接正在运行，退出后将无法接收和执行交易指令。\n"
                "确认要退出吗？\n\n"
                "The bridge is running. Quitting stops receiving and executing "
                "trades. Are you sure you want to exit?",
            )
            if not ok:
                return
            self.engine.stop()
        logger.info("应用退出 / app closed")
        if self.tray_icon is not None:
            self.tray_icon.stop()
        self.root.destroy()


def main():
    # 自更新留下的上一版 exe：新版本起来后顺手删掉（见 swap_in_update）。
    # Remove the previous build left behind by a self-update.
    cleanup_old_binary()
    root = tk.Tk()
    gui = BridgeGUI(root)
    root.protocol("WM_DELETE_WINDOW", gui.on_close)
    root.mainloop()


if __name__ == "__main__":
    # 隐藏自检：打包态验证 numpy / MetaTrader5 是否能正常导入
    # hidden self-test: verify numpy / MetaTrader5 import in the bundled exe
    if "--selftest" in sys.argv:
        out = os.path.join(os.path.expanduser("~"), ".prismx_selftest.txt")
        try:
            import numpy as _np
            import MetaTrader5 as _mt5
            msg = f"OK numpy={_np.__version__} mt5={_mt5.__version__}"
        except Exception as _e:  # noqa: BLE001
            msg = f"FAIL {_e!r}"
        with open(out, "w", encoding="utf-8") as _f:
            _f.write(msg)
        sys.exit(0)
    main()
