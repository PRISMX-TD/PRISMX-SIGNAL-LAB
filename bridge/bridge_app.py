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
import threading
import tkinter as tk
from ctypes import wintypes
from logging.handlers import RotatingFileHandler
from tkinter import messagebox, ttk
from urllib import error, request

from mt5_worker import poll_terminal

# ---------- 版本 / Version ----------
APP_VERSION = "1.1.0"

# ---------- 配置 / Configuration ----------
# 线上后端地址（所有用户默认连接，无需手动填写）。
# Production backend URL (all users connect here by default; no manual entry needed).
DEFAULT_BACKEND = "https://api.prismxsignallab.com"
CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".prismx_bridge.json")
LOG_PATH = os.path.join(os.path.expanduser("~"), ".prismx_bridge.log")
POLL_INTERVAL = 2.0  # 后端轮询间隔（秒）/ backend poll interval (seconds)


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
        # Cache of executed order results: clientOrderId -> result. If the backend
        # re-delivers the same command after an ack timeout, we DON'T place the
        # order again — we just re-report the cached result (idempotency guard).
        self._executed: dict[str, dict] = {}
        # 尚未成功回报后端的结果，下一轮重试 / results not yet acked by backend, retried next tick
        self._pending_reports: list[dict] = []

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

        if not accounts:
            msg = worker_errors[0] if worker_errors else "已连接终端但未读到已登录账号 / terminal attached but no logged-in account"
            self.on_status([], msg)
            return

        # 2) 上报账号 + 拉取待执行指令 / report accounts + fetch commands
        commands = []
        try:
            resp = _post_json(
                f"{self.backend}/api/bridge/poll",
                {"accounts": accounts},
                self.token,
            )
            commands = resp.get("commands", [])
            self.last_error = None
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

        # 4) 先重试上一轮未成功回报的结果 / retry results not yet acked last tick
        self._flush_reports()

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
                        self._executed[coid] = r  # 缓存以备幂等重报 / cache for idempotent retry
                    logger.info(
                        "下单结果 / order result: coid=%s success=%s ticket=%s price=%s msg=%s",
                        coid, r.get("success"), r.get("mt5Ticket"),
                        r.get("filledPrice"), r.get("message"),
                    )
                    self._report_result(r)

        # 6) 通知 GUI 刷新 / notify GUI to refresh
        self.on_status(accounts, self.last_error)

    def _report_result(self, result: dict):
        """回报单条结果，失败则入队下一轮重试 / report one result, queue on failure."""
        try:
            _post_json(f"{self.backend}/api/bridge/result", result, self.token)
        except Exception:
            if result not in self._pending_reports:
                self._pending_reports.append(result)

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
        self._pending_reports = still_pending


# ---------- GUI ----------
class BridgeGUI:
    """tkinter 界面：先要 Token，连接后显示多账号状态。
    tkinter UI: ask for token first, then show multi-account status.
    """

    def __init__(self, root: tk.Tk):
        self.root = root
        self.engine: BridgeEngine | None = None
        cfg = load_config()
        self.saved_token = cfg.get("token", "")

        root.title(f"PRISMX Bridge v{APP_VERSION}")
        root.geometry("560x480")
        root.configure(bg="#0b1020")
        self._build_widgets()

    def _build_widgets(self):
        pad = {"padx": 14, "pady": 6}

        # 标题 / title
        title_row = tk.Frame(self.root, bg="#0b1020")
        title_row.pack(fill="x", **pad)
        tk.Label(
            title_row, text="PRISMX Bridge",
            font=("Segoe UI", 16, "bold"), fg="#a78bfa", bg="#0b1020",
        ).pack(side="left")
        tk.Label(
            title_row, text=f"v{APP_VERSION}",
            font=("Segoe UI", 9), fg="#64748b", bg="#0b1020",
        ).pack(side="left", padx=8, pady=(8, 0))

        # Token 输入区（第一步）/ token entry (the first step)
        form = tk.Frame(self.root, bg="#0b1020")
        form.pack(fill="x", **pad)

        tk.Label(form, text="API Token", fg="#cbd5e1", bg="#0b1020").grid(row=0, column=0, sticky="w")
        self.token_var = tk.StringVar(value=self.saved_token)
        self.token_entry = tk.Entry(form, textvariable=self.token_var, width=48, show="•")
        self.token_entry.grid(row=0, column=1, padx=8, pady=4)

        # 后端地址固定为线上地址，对用户隐藏，无需填写。
        # Backend URL is fixed to production and hidden from the user.
        self.backend_var = tk.StringVar(value=DEFAULT_BACKEND)

        # 连接 / 断开按钮 / connect & disconnect buttons
        btns = tk.Frame(self.root, bg="#0b1020")
        btns.pack(fill="x", **pad)
        self.connect_btn = tk.Button(btns, text="连接 / Connect", command=self._on_connect,
                                     bg="#7c3aed", fg="white", relief="flat", width=16)
        self.connect_btn.pack(side="left")
        self.disconnect_btn = tk.Button(btns, text="断开 / Disconnect", command=self._on_disconnect,
                                        bg="#334155", fg="white", relief="flat", width=16, state="disabled")
        self.disconnect_btn.pack(side="left", padx=8)

        # 状态栏 / status line
        self.status_var = tk.StringVar(value="未连接 / Not connected")
        tk.Label(self.root, textvariable=self.status_var, fg="#94a3b8", bg="#0b1020").pack(anchor="w", **pad)

        # 账号列表 / account table
        cols = ("login", "name", "company", "balance", "equity")
        self.tree = ttk.Treeview(self.root, columns=cols, show="headings", height=10)
        for c, w in zip(cols, (90, 130, 130, 90, 90)):
            self.tree.heading(c, text=c)
            self.tree.column(c, width=w, anchor="center")
        self.tree.pack(fill="both", expand=True, padx=14, pady=8)

        # 底部：日志路径提示 / footer: log file hint
        tk.Label(
            self.root, text=f"运行日志 / Log: {LOG_PATH}",
            font=("Segoe UI", 8), fg="#475569", bg="#0b1020",
        ).pack(anchor="w", padx=14, pady=(0, 6))

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
        self.connect_btn.config(state="disabled")
        self.disconnect_btn.config(state="normal")
        self.token_entry.config(state="disabled")
        self.status_var.set("已连接，正在扫描 MT5… / Connected, scanning MT5…")

    def _on_disconnect(self):
        if self.engine:
            self.engine.stop()
            self.engine = None
        self.connect_btn.config(state="normal")
        self.disconnect_btn.config(state="disabled")
        self.token_entry.config(state="normal")
        self.status_var.set("未连接 / Not connected")
        for row in self.tree.get_children():
            self.tree.delete(row)

    def _on_status(self, accounts: list, last_error: str | None):
        """后台线程回调，切回主线程更新界面 / marshal back to the UI thread."""
        self.root.after(0, lambda: self._render(accounts, last_error))

    def _render(self, accounts: list, last_error: str | None):
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
        if last_error:
            self.status_var.set(f"在线账号 {len(accounts)} 个 · 错误: {last_error}")
        elif accounts:
            self.status_var.set(f"已连接 · 在线账号 {len(accounts)} 个 / {len(accounts)} account(s) online")
        else:
            self.status_var.set("已连接 · 未检测到已登录的 MT5 终端 / No logged-in MT5 terminal found")

    def on_close(self):
        # 连接中关闭时二次确认：退出后无法接收/执行交易。
        # Confirm on close while connected: quitting stops receiving/executing trades.
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
        self.root.destroy()


def main():
    root = tk.Tk()
    gui = BridgeGUI(root)
    root.protocol("WM_DELETE_WINDOW", gui.on_close)
    root.mainloop()


if __name__ == "__main__":
    main()
