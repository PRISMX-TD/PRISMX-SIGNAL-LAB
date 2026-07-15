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
import json
import logging
import os
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

from mt5_worker import poll_terminal

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
APP_VERSION = "1.3.10"

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

# ---------- 配置 / Configuration ----------
# 线上后端地址（所有用户默认连接，无需手动填写）。
# Production backend URL (all users connect here by default; no manual entry needed).
DEFAULT_BACKEND = "https://api.prismxsignallab.com"
CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".prismx_bridge.json")
LOG_PATH = os.path.join(os.path.expanduser("~"), ".prismx_bridge.log")
POLL_INTERVAL = 1.5  # 后端轮询间隔（秒）/ backend poll interval (seconds)

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


def save_config(cfg: dict) -> None:
    """保存本地配置；Token 加密后存盘，不落明文。
    Persist config; the token is encrypted, never written in plaintext.
    """
    out = {"backend": cfg.get("backend", DEFAULT_BACKEND)}
    token = cfg.get("token", "")
    if token:
        enc = _dpapi_encrypt(token)
        if enc:
            out["token_enc"] = enc
        else:
            # DPAPI 不可用时退回明文（仅极端情况）/ fall back to plaintext only if DPAPI fails
            out["token"] = token
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(out, f)
    except Exception:
        pass


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
def _post_json(url: str, payload: dict, token: str, timeout: float = 10.0) -> dict:
    """带 API Token 的 POST 请求 / POST with the API token header."""
    data = json.dumps(payload).encode("utf-8")
    req = request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-API-Token", token)
    with request.urlopen(req, timeout=timeout) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body) if body else {}


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

    def start(self):
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

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
            res = poll_terminal(path)
            if res.get("error"):
                worker_errors.append(res["error"])
            acc = res.get("account")
            if acc:
                accounts.append(acc)
                login_to_path[acc["login"]] = path
                positions.extend(res.get("positions", []))
                # 按账户上报，不跨终端合并——下单确认页要按选中账户取对应
                # 交易商的报价。/ report per account, no cross-terminal merge —
                # the order-confirmation page needs the selected account's own
                # broker quote.
                for q in res.get("quotes", []):
                    quotes_by_account.append({**q, "login": acc["login"]})
                closed_trades.extend(res.get("closedTrades", []))

        if not accounts:
            msg = worker_errors[0] if worker_errors else "已连接终端但未读到已登录账号 / terminal attached but no logged-in account"
            self.on_status([], msg)
            return

        # 2) 上报账号 + 拉取待执行指令 / report accounts + fetch commands
        commands = []
        warning = None
        try:
            resp = _post_json(
                f"{self.backend}/api/bridge/poll",
                {"accounts": accounts},
                self.token,
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
            self.last_error = f"后端拒绝 HTTP {e.code}: {e.reason}（检查 Token）"
            self.on_status(accounts, self.last_error)
            return
        except Exception as e:
            self.last_error = f"无法连接后端: {e}"
            self.on_status(accounts, self.last_error)
            return

        # 3) 上报持仓 / report positions
        try:
            _post_json(f"{self.backend}/api/bridge/positions", {"data": positions}, self.token)
        except Exception:
            pass

        # 3b) 上报报价：仅上报相对上一轮变化的 (账号, 品种) 以省流量。
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
                _post_json(f"{self.backend}/api/bridge/quotes", {"data": changed}, self.token)
        except Exception:
            pass

        # 3c) 上报新检测到的真实平仓明细（个人胜率）；失败则入队下一轮重试。
        # 这一步之前完全不写日志，无论成功失败都看不出"到底有没有尝试上报"，
        # 排查漏报问题时只能靠猜——现在两种结果都记一行，成交编号写进去，
        # 方便日后对着后端日志核对是否真的到账。
        # Report newly detected real closed-trade legs (personal win-rate);
        # queue for retry on failure. This step used to log nothing either
        # way, making "did it even try to report" unknowable when debugging a
        # missing trade — now both outcomes are logged with the deal
        # ticket(s), so it can be cross-checked against the backend log.
        if closed_trades:
            tickets = [t.get("dealTicket") for t in closed_trades]
            try:
                _post_json(f"{self.backend}/api/bridge/trade-history", {"data": closed_trades}, self.token)
                logger.info("已上报平仓明细 / reported closed trades: dealTickets=%s", tickets)
            except Exception as e:
                logger.warning("平仓明细上报失败，已入队重试 / closed-trade report failed, queued for retry: dealTickets=%s err=%s", tickets, e)
                self._pending_trades.extend(closed_trades)
                _save_pending_trades(self._pending_trades)

        # 4) 先重试上一轮未成功回报的结果 / retry results & trades not yet acked last tick
        self._flush_reports()
        self._flush_trades()

        # 5) 按 login 分组指令执行；已执行过的只重报缓存结果，不重复下单。
        #    Group commands by login & execute; for already-executed ones just
        #    re-report the cached result instead of placing the order again.
        if commands:
            by_path: dict[str, list] = {}
            for cmd in commands:
                coid = str(cmd.get("clientOrderId"))
                if coid in self._executed:
                    # 重发的指令：直接重报缓存结果 / re-delivered: re-report cached result
                    self._report_result(self._executed[coid])
                    continue
                path = login_to_path.get(str(cmd.get("login")))
                if path:
                    by_path.setdefault(path, []).append(cmd)
            for path, cmds in by_path.items():
                res = poll_terminal(path, orders=cmds)
                for r in res.get("results", []):
                    coid = str(r.get("clientOrderId"))
                    if coid:
                        # 缓存并落盘，以备幂等重报（重启后仍有效）
                        # cache & persist for idempotent retry (survives restarts)
                        self._remember_executed(coid, r)
                    logger.info(
                        "下单结果 / order result: coid=%s success=%s ticket=%s price=%s msg=%s",
                        coid, r.get("success"), r.get("mt5Ticket"),
                        r.get("filledPrice"), r.get("message"),
                    )
                    self._report_result(r)

        # 6) 通知 GUI 刷新 / notify GUI to refresh
        self.on_status(accounts, self.last_error, warning)

    def _remember_executed(self, coid: str, result: dict) -> None:
        """记录一条已执行结果并落盘，同时清理超龄条目。
        Record one executed result, persist to disk and prune stale entries."""
        now = time.time()
        self._executed[coid] = result
        self._executed_at[coid] = now
        stale = [k for k, ts in self._executed_at.items() if now - ts > EXECUTED_CACHE_TTL]
        for k in stale:
            self._executed.pop(k, None)
            self._executed_at.pop(k, None)
        _save_executed_cache(self._executed, self._executed_at)

    def _report_result(self, result: dict):
        """回报单条结果，失败则入队下一轮重试 / report one result, queue on failure."""
        try:
            _post_json(f"{self.backend}/api/bridge/result", result, self.token)
        except Exception:
            if result not in self._pending_reports:
                self._pending_reports.append(result)
                _save_pending_reports(self._pending_reports)

    def _flush_reports(self):
        """重试此前未成功回报的结果 / retry previously failed reports."""
        if not self._pending_reports:
            return
        still_pending = []
        for r in self._pending_reports:
            try:
                _post_json(f"{self.backend}/api/bridge/result", r, self.token)
            except Exception:
                still_pending.append(r)
        if still_pending != self._pending_reports:
            _save_pending_reports(still_pending)
        self._pending_reports = still_pending

    def _flush_trades(self):
        """重试此前未成功上报的平仓明细 / retry previously failed closed-trade reports."""
        if not self._pending_trades:
            return
        try:
            _post_json(f"{self.backend}/api/bridge/trade-history", {"data": self._pending_trades}, self.token)
            self._pending_trades = []
            _save_pending_trades(self._pending_trades)
        except Exception:
            # 留在队列里，下一轮再试；不清空、不落盘 / stays queued for the next tick
            pass


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
        download_url = None
        for asset in data.get("assets", []) or []:
            if asset.get("name") == BRIDGE_ASSET_FILENAME:
                download_url = asset.get("browser_download_url")
                break
        return {"tag": tag, "download_url": download_url}
    except Exception:
        return None


def is_newer_version(latest: str, current: str) -> bool:
    """判断 latest 是否比 current 更新 / whether latest is newer than current."""
    lv, cv = _parse_version(latest), _parse_version(current)
    return bool(lv) and lv > cv


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
            w.bind("<Button-1>", lambda _e: self._open_update_page())
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
            while True:
                release = check_latest_release()
                if release and is_newer_version(release["tag"], APP_VERSION):
                    # 切回 UI 线程更新提示条 / marshal back to the UI thread
                    self.root.after(0, lambda r=release: self._show_update(r))
                    return  # 已提示则停止轮询 / stop polling once notified
                time.sleep(UPDATE_CHECK_INTERVAL)
        threading.Thread(target=worker, daemon=True).start()

    def _show_update(self, release: dict):
        """显示更新提示条 / reveal the update banner."""
        latest = release["tag"]
        # 优先直接下载安装包；找不到匹配资产才退回发布页。
        # Prefer downloading the installer directly; fall back to the releases
        # page only if no matching asset was found.
        self._update_url = release.get("download_url") or RELEASES_PAGE
        self.update_var.set(
            f"发现新版本 {latest}（当前 v{APP_VERSION}），点击直接下载安装包  /  "
            f"Update {latest} available — click to download the installer"
        )
        # 插在标题行之后、连接卡片之前 / place it right below the header
        self.update_bar.pack(fill="x", padx=22, pady=(0, 6), after=self._title_row)
        logger.info("发现新版本 / update available: %s (current %s)", latest, APP_VERSION)

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
        save_config({"token": token, "backend": backend})
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
