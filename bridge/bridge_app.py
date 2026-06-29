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
import tkinter as tk
from ctypes import wintypes
from logging.handlers import RotatingFileHandler
from tkinter import messagebox, ttk
from urllib import error, request

from mt5_worker import poll_terminal

# ---------- 版本 / Version ----------
APP_VERSION = "1.2.0"

# ---------- 配置 / Configuration ----------
# 线上后端地址（所有用户默认连接，无需手动填写）。
# Production backend URL (all users connect here by default; no manual entry needed).
DEFAULT_BACKEND = "https://api.prismxsignallab.com"
CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".prismx_bridge.json")
LOG_PATH = os.path.join(os.path.expanduser("~"), ".prismx_bridge.log")
POLL_INTERVAL = 2.0  # 后端轮询间隔（秒）/ backend poll interval (seconds)


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
            # 仅接受 list[dict]，过滤畸形元素，防止后续执行链异常。
            # Only accept list[dict]; drop malformed elements to protect the chain.
            if not isinstance(commands, list):
                commands = []
            else:
                commands = [c for c in commands if isinstance(c, dict)]
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
        root.geometry("760x720")
        root.resizable(False, False)
        root.configure(bg=self.BG)
        self._set_app_icon(root)
        self._buttons: dict[str, dict] = {}
        self._init_style()
        self._build_widgets()

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

    def _draw_dot(self, color):
        """绘制状态指示灯 / draw the status dot."""
        self.status_dot.delete("all")
        self.status_dot.create_oval(2, 2, 12, 12, fill=color, outline="")

    def _toggle_token(self):
        """切换 Token 明文显示 / toggle token plaintext visibility."""
        self._token_shown = not self._token_shown
        self.token_entry.config(show="" if self._token_shown else "•")
        self.eye_btn["cv"].itemconfig(self.eye_btn["label"], text="隐藏" if self._token_shown else "显示")

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
        self.count_var.set(f"{len(accounts)} 个")
        if last_error:
            self._draw_dot(self.ERR)
            self.status_var.set(f"已连接 · {len(accounts)} 个账号 · 错误: {last_error}")
        elif accounts:
            self._draw_dot(self.OK)
            self.status_var.set(f"已连接 · 在线账号 {len(accounts)} 个 / {len(accounts)} account(s) online")
        else:
            self._draw_dot(self.WARN)
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
