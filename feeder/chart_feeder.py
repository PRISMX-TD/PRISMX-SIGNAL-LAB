"""PRISMX 图表喂价器 / PRISMX Chart Feeder.

独立、自包含的 Windows 后台程序：连接本机一个 MT5 终端，为固定的
「品种 x 周期」矩阵批量取 K 线（OHLC），推送给后端的图表行情缓存
（POST /api/feed/candles），供全体用户的图表页共用。

与用户端 PRISMX Bridge（bridge/）没有任何代码依赖——本文件不 import
bridge/ 下的任何模块，所需的 MT5 连接/重连/后缀探测逻辑均在本文件内
自行实现，因此只需把 feeder/ 这一个目录拷到 VPS 即可独立运行。

只读、不下单、不绑定用户 Token；鉴权靠一个固定的 FEED_TOKEN 头。
详见项目根目录 CHART_SELFHOST_PLAN.md。

Standalone, self-contained Windows background program: attaches to one local
MT5 terminal, batch-fetches OHLC candles for a fixed "symbol x interval"
matrix, and pushes them to the backend's chart cache (POST
/api/feed/candles), shared by every user's chart page.

Has zero code dependency on the user-facing PRISMX Bridge (bridge/) — this
file does not import anything from bridge/; the MT5 connect/reconnect/suffix
-detection logic it needs is reimplemented locally, so copying just this
feeder/ folder to a VPS is enough to run it standalone.

Read-only, never places orders, not bound to any user token; authenticated
via a fixed FEED_TOKEN header. See CHART_SELFHOST_PLAN.md at the repo root.
"""
import json
import logging
import os
import sys
import time
from logging.handlers import RotatingFileHandler

import requests

try:
    # MetaTrader5 在其编译后的扩展模块内部动态引用 numpy（copy_rates_from_pos
    # 等返回 numpy 结构化数组），PyInstaller 的静态导入扫描看不到这层引用，
    # 打包 onefile exe 时会漏掉 numpy 导致运行期 ModuleNotFoundError。这里显式
    # import 一次，让 PyInstaller 能正确探测并打包进去。
    # MetaTrader5 references numpy dynamically inside its compiled extension
    # module (copy_rates_from_pos etc. return numpy structured arrays);
    # PyInstaller's static import scanner can't see that reference, so a
    # onefile build silently omits numpy and fails at runtime with
    # ModuleNotFoundError. Importing it explicitly here lets PyInstaller
    # detect and bundle it correctly.
    import numpy  # noqa: F401
    import MetaTrader5 as mt5
except Exception as _e:  # pragma: no cover - Windows-only package
    mt5 = None
    _IMPORT_ERROR = repr(_e)
else:
    _IMPORT_ERROR = None


DEFAULT_CONFIG = {
    "backend_url": "https://api.prismxsignallab.com",
    "feed_token": "",
    "mt5_path": "",
    "server_utc_offset": 0,
    "tick_interval": 2,
    "backfill_interval": 60,
    "max_bars": 500,
}


# ---------- 配置 / Configuration ----------
def _app_dir() -> str:
    """返回程序自身所在目录：PyInstaller onefile 打包后 __file__ 指向运行时
    临时解压目录（进程退出即消失），配置/日志必须落在 exe 实际所在目录才能
    让用户找到并编辑；源码态（未打包）直接用脚本所在目录。
    Directory the program itself lives in: after a PyInstaller onefile build,
    __file__ points at a temp extraction dir that vanishes on exit — config
    and logs must live next to the actual .exe so the user can find and edit
    them; unfrozen (plain script) just uses the script's own directory."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _config_path() -> str:
    return os.environ.get("FEEDER_CONFIG", os.path.join(_app_dir(), "feeder_config.json"))


def load_config() -> dict:
    """读取 feeder_config.json，缺省项用内置默认值；环境变量可覆盖关键项。
    Load feeder_config.json with built-in defaults; env vars can override
    the key fields."""
    cfg = dict(DEFAULT_CONFIG)
    path = _config_path()
    try:
        with open(path, "r", encoding="utf-8") as f:
            cfg.update(json.load(f) or {})
    except FileNotFoundError:
        pass
    except Exception:
        logging.getLogger("prismx_feeder").exception("failed to read %s", path)

    # 环境变量覆盖（部署时不想改文件可用这个）/ env overrides (handy when you
    # don't want to edit the file at deploy time)
    cfg["backend_url"] = os.environ.get("FEEDER_BACKEND_URL", cfg["backend_url"]).rstrip("/")
    cfg["feed_token"] = os.environ.get("FEEDER_FEED_TOKEN", cfg["feed_token"])
    return cfg


def _ensure_config_file_exists() -> bool:
    """首次双击运行、旁边还没有配置文件时：写一份带占位符的模板并提示用户编辑，
    而不是直接静默地用空 feed_token 跑起来（后端会一直拒绝）。返回 True 表示
    配置文件已就绪（本来就存在），False 表示刚创建了模板、需要用户编辑后重开。
    On first double-click with no config file next to the exe: write a
    template with a placeholder and ask the user to edit it, instead of
    silently running with an empty feed_token forever (the backend would
    reject every push). Returns True if a config file was already present,
    False if a template was just created and the user needs to edit + rerun.
    """
    path = _config_path()
    if os.path.exists(path):
        return True
    template = dict(DEFAULT_CONFIG)
    template["feed_token"] = "REPLACE-WITH-THE-SAME-STRONG-RANDOM-STRING-AS-BACKEND-FEED_TOKEN"
    template["server_utc_offset"] = 10800
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(template, f, indent=2, ensure_ascii=False)
    except Exception:
        logging.getLogger("prismx_feeder").exception("failed to write template config to %s", path)
        return True  # 写不出模板也别卡死主流程，继续用内置默认值跑 / don't block the main flow either way
    print(f"""
========================================================================
首次运行：已在下面这个位置生成配置文件模板，请填好 feed_token（须与后端
FEED_TOKEN 一致）和 server_utc_offset 后，重新运行本程序。

First run: a config template was created at the path below. Please fill in
feed_token (must match the backend's FEED_TOKEN) and server_utc_offset,
then run this program again.

  {path}
========================================================================
""")
    return False


CFG = load_config()
BACKEND_URL: str = CFG["backend_url"]
FEED_TOKEN: str = CFG["feed_token"]
MT5_PATH: str = CFG["mt5_path"] or None
SERVER_UTC_OFFSET: int = int(CFG["server_utc_offset"])
TICK_INTERVAL: float = float(CFG["tick_interval"])
BACKFILL_INTERVAL: float = float(CFG["backfill_interval"])
MAX_BARS: int = int(CFG["max_bars"])

LOG_PATH = os.path.join(_app_dir(), "chart_feeder.log")


def _setup_logger() -> logging.Logger:
    lg = logging.getLogger("prismx_feeder")
    lg.setLevel(logging.INFO)
    if not lg.handlers:
        handler = RotatingFileHandler(LOG_PATH, maxBytes=512 * 1024, backupCount=3, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        lg.addHandler(handler)
        # 同时输出到控制台，便于前台调试 / also echo to console for foreground debugging
        console = logging.StreamHandler(sys.stdout)
        console.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
        lg.addHandler(console)
    return lg


logger = _setup_logger()


# ---------- 品种 / 周期矩阵（须与 backend/app/routers/chart.py 的
# ALLOWED_INTERVALS、frontend/src/pages/ChartsPage.tsx 的 PRESET_SYMBOLS /
# INTERVALS 保持一致）/ symbol & interval matrix (must match
# ALLOWED_INTERVALS in the backend router and PRESET_SYMBOLS/INTERVALS in
# ChartsPage.tsx) ----------
INTERVAL_TF = {
    "1": None, "5": None, "15": None,
    "60": None, "240": None, "D": None,
}  # 值在 _init_mt5() 之后用 mt5.TIMEFRAME_* 常量填充，因为导入失败时 mt5 为 None
   # values are filled with mt5.TIMEFRAME_* constants after _init_mt5(), since
   # mt5 is None when the import fails

BASE_SYMBOLS = [
    "XAUUSD", "XAGUSD", "USOIL", "BTCUSD", "EURUSD", "GBPUSD", "USDJPY",
    "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "EURJPY", "GBPJPY",
]

# 每个基础品种的候选真实品种名（不同经纪商命名差异很大，尤其 USOIL）；
# 逐个尝试 symbol_select，命中第一个可用的。
# Candidate broker symbol names per base symbol (naming varies a lot across
# brokers, especially USOIL); try symbol_select on each, take the first hit.
BROKER_SYMBOL_ALIASES = {
    "XAUUSD": ["XAUUSD"],
    "XAGUSD": ["XAGUSD"],
    "USOIL": ["USOIL", "XTIUSD", "WTI", "WTICOUSD", "CL"],
    "BTCUSD": ["BTCUSD", "BTCUSD.", "BTC/USD"],
    "EURUSD": ["EURUSD"],
    "GBPUSD": ["GBPUSD"],
    "USDJPY": ["USDJPY"],
    "AUDUSD": ["AUDUSD"],
    "USDCAD": ["USDCAD"],
    "USDCHF": ["USDCHF"],
    "NZDUSD": ["NZDUSD"],
    "EURJPY": ["EURJPY"],
    "GBPJPY": ["GBPJPY"],
}

# 常见基础品种，用于探测券商后缀（拷自 bridge/mt5_worker.py 的思路，独立实现）
# common base symbols to probe the broker suffix (same idea as
# bridge/mt5_worker.py, reimplemented independently)
_SUFFIX_PROBE = ["EURUSD", "XAUUSD", "GBPUSD", "USDJPY", "BTCUSD"]

# base_symbol -> 该经纪商下的真实品种名，启动时解析一次 / resolved at startup
RESOLVED: dict[str, str] = {}

_attached_path: str | None = None


# ---------- MT5 连接 / MT5 connection ----------
def _ensure_attached() -> bool:
    """确保已附着到 MT5 终端；已附着则复用，断线则重连。
    Ensure attachment to the MT5 terminal; reuse if already attached,
    reconnect if the link died."""
    global _attached_path
    if _attached_path is not None:
        try:
            if mt5.terminal_info() is not None:
                return True
        except Exception:
            pass
        try:
            mt5.shutdown()
        except Exception:
            pass
        _attached_path = None

    ok = mt5.initialize(path=MT5_PATH, timeout=10000) if MT5_PATH else mt5.initialize(timeout=10000)
    if not ok:
        logger.error("MT5 initialize failed: %s", mt5.last_error())
        return False
    _attached_path = MT5_PATH or "default"
    return True


def _detect_suffix() -> str:
    """探测券商品种后缀（如 .sc / .m）/ detect the broker symbol suffix."""
    try:
        symbols = mt5.symbols_get()
    except Exception:
        return ""
    if not symbols:
        return ""
    names = {s.name for s in symbols}
    for base in _SUFFIX_PROBE:
        for name in names:
            if name == base:
                return ""
            if name.startswith(base) and len(name) > len(base):
                return name[len(base):]
    return ""


def _resolve_symbols() -> None:
    """为每个基础品种解析出该经纪商下的真实品种名，写入 RESOLVED。
    Resolve each base symbol to its real broker symbol name into RESOLVED."""
    suffix = _detect_suffix()
    RESOLVED.clear()
    for base, candidates in BROKER_SYMBOL_ALIASES.items():
        tried = []
        for cand in candidates:
            for name in (cand + suffix, cand):
                if name in tried:
                    continue
                tried.append(name)
                if mt5.symbol_select(name, True):
                    RESOLVED[base] = name
                    break
            if base in RESOLVED:
                break
        if base not in RESOLVED:
            logger.warning("no broker symbol resolved for %s (tried %s)", base, tried)
    logger.info("resolved symbols (suffix=%r): %s", suffix, RESOLVED)


def _init_mt5() -> bool:
    """首次建立连接、填充周期常量表、解析品种 / first-time connect, fill the
    timeframe constant table, resolve symbols."""
    if mt5 is None:
        logger.error("MetaTrader5 import failed: %s", _IMPORT_ERROR)
        return False
    if not _ensure_attached():
        return False
    INTERVAL_TF["1"] = mt5.TIMEFRAME_M1
    INTERVAL_TF["5"] = mt5.TIMEFRAME_M5
    INTERVAL_TF["15"] = mt5.TIMEFRAME_M15
    INTERVAL_TF["60"] = mt5.TIMEFRAME_H1
    INTERVAL_TF["240"] = mt5.TIMEFRAME_H4
    INTERVAL_TF["D"] = mt5.TIMEFRAME_D1
    _resolve_symbols()
    return True


# ---------- K 线抓取与上报 / candle fetch & push ----------
def bars_for(broker_symbol: str, tf, count: int) -> list[dict]:
    """取一个品种/周期的最近 count 根 K 线，时间戳归一到真 UTC。
    Fetch the latest `count` bars for one symbol/timeframe, normalized to
    true UTC.

    MT5 的 time 字段是 epoch 秒但按经纪商服务器时区（常见 UTC+2/+3），不是
    真 UTC；减去 SERVER_UTC_OFFSET 才能让前端图表坐标轴时间对得上。
    MT5's time field is epoch seconds in the broker server's timezone
    (commonly UTC+2/+3), not true UTC; subtracting SERVER_UTC_OFFSET aligns
    the frontend chart's time axis.
    """
    try:
        rates = mt5.copy_rates_from_pos(broker_symbol, tf, 0, count)
    except Exception:
        logger.exception("copy_rates_from_pos failed for %s", broker_symbol)
        return []
    if rates is None or len(rates) == 0:
        return []
    out = []
    for r in rates:
        out.append({
            "t": int(r["time"]) - SERVER_UTC_OFFSET,
            "o": float(r["open"]),
            "h": float(r["high"]),
            "l": float(r["low"]),
            "c": float(r["close"]),
        })
    return out


def push(mode: str, count: int) -> None:
    """遍历「品种 x 周期」矩阵取 K 线，一次性 POST 给后端。
    Walk the symbol x interval matrix, POST the batch to the backend once."""
    series = []
    for base in BASE_SYMBOLS:
        broker_symbol = RESOLVED.get(base)
        if not broker_symbol:
            continue
        for code, tf in INTERVAL_TF.items():
            bars = bars_for(broker_symbol, tf, count)
            if bars:
                series.append({"symbol": base, "interval": code, "bars": bars})
    if not series:
        logger.warning("push(%s): nothing to send (no resolved symbols or no data)", mode)
        return
    try:
        resp = requests.post(
            f"{BACKEND_URL}/api/feed/candles",
            headers={"X-Feed-Token": FEED_TOKEN, "Content-Type": "application/json"},
            json={"mode": mode, "series": series},
            timeout=15,
        )
        if resp.status_code != 200:
            logger.error("push(%s) HTTP %s: %s", mode, resp.status_code, resp.text[:300])
    except Exception:
        logger.exception("push(%s) request failed", mode)


# ---------- 主循环 / main loop ----------
def main() -> None:
    if not FEED_TOKEN:
        logger.error("feed_token is empty in feeder_config.json — the backend will reject every push")

    while not _init_mt5():
        logger.error("MT5 attach failed, retrying in 10s...")
        time.sleep(10)

    logger.info("connected; doing initial backfill (%d bars)...", MAX_BARS)
    push("backfill", MAX_BARS)
    last_backfill = time.time()

    while True:
        try:
            if not _ensure_attached():
                logger.error("MT5 link lost, retrying in 10s...")
                time.sleep(10)
                continue
            push("tick", 2)
            if time.time() - last_backfill >= BACKFILL_INTERVAL:
                _resolve_symbols()  # 重新探测，兼容经纪商切换品种/后缀的场景
                push("backfill", MAX_BARS)
                last_backfill = time.time()
        except Exception:
            logger.exception("main loop iteration failed")
        time.sleep(TICK_INTERVAL)


if __name__ == "__main__":
    try:
        if not _ensure_config_file_exists():
            # 首次运行：配置模板刚生成，暂停等待用户确认后再退出，避免双击运行时
            # 控制台窗口一闪而过、来不及看清提示 / first run: the config template
            # was just created; pause so the console window doesn't flash and
            # close before the user can read the message
            try:
                input("按回车键退出... / Press Enter to exit... ")
            except EOFError:
                pass
        else:
            main()
    except KeyboardInterrupt:
        logger.info("stopped by user")
    except Exception:
        # 意外崩溃：双击运行时若不暂停，控制台窗口会一闪而过看不清报错。
        # main() 内部循环已经处理了预期内的失败（如 MT5 未连接）并无限重试，
        # 这里兜底的只是真正的意外崩溃。
        # Unexpected crash: without a pause, double-clicking would flash the
        # console closed before the error is readable. main()'s own loop
        # already retries expected failures (e.g. MT5 not attached)
        # indefinitely — this only catches genuinely unexpected crashes.
        logger.exception("fatal error, exiting")
        try:
            input("发生错误，详情见 chart_feeder.log。按回车键退出... / An error occurred, see chart_feeder.log for details. Press Enter to exit... ")
        except EOFError:
            pass
