"""网关配置：从 config.ini 读取，环境变量可覆盖。
Gateway configuration: read from config.ini, overridable by environment.

凭据只从配置文件或环境变量来，不写进代码。
Credentials come only from the config file or the environment, never from code.
"""
from __future__ import annotations

import configparser
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent
CONFIG_PATH = BASE_DIR / "config.ini"

# 默认品种映射：display 是前端/数据库用的名字，broker 是向 Manager 查询用的真名。
# 与现有 EA 的 InpSymbols 保持一致，BTCUSD 用交易商的 .s 档补齐。
# Default symbol map: `display` is what the frontend/DB use, `broker` is the real
# name queried from Manager. Mirrors the existing EA's InpSymbols, with BTCUSD
# filled in from the broker's .s tier.
DEFAULT_SYMBOLS: list[dict] = [
    {"display": "XAUUSD", "broker": "XAUUSD.s", "enabled": True},
    {"display": "XAGUSD", "broker": "XAGUSD.s", "enabled": True},
    {"display": "WTI", "broker": "WTI.s", "enabled": True},
    {"display": "EURUSD", "broker": "EURUSD.s", "enabled": True},
    {"display": "GBPUSD", "broker": "GBPUSD.s", "enabled": True},
    {"display": "USDJPY", "broker": "USDJPY.s", "enabled": True},
    {"display": "BTCUSD", "broker": "BTCUSD.s", "enabled": True},
]


@dataclass
class Config:
    # --- Manager 连接 / Manager connection ---
    server: str = "192.109.17.69:443"
    login: int = 0
    password: str = ""

    # --- 后端 / backend ---
    backend_url: str = "https://api.prismxsignallab.com"
    ea_token: str = ""

    # --- 推送间隔（秒），与现有 EA 参数对齐 / push intervals, aligned with the EA ---
    quote_interval: int = 2       # InpQuoteIntervalSec
    candle_tick_interval: int = 3  # InpCandleTickSec
    candle_backfill_interval: int = 60  # InpCandleBackfillSec
    trend_interval: int = 5       # InpTrendIntervalSec
    config_poll_interval: int = 60  # 从后端拉品种配置 / pull symbol config from backend

    # 报价停滞多少秒视为休市（EA 的 InpStaleQuoteSec）
    # Seconds without a tick before a quote counts as closed-market.
    stale_quote_seconds: int = 300

    # 单次回补的最大 M1 根数（EA 的 InpMaxBars 是 500 根目标周期）
    # Max M1 bars per backfill; the EA's InpMaxBars=500 is in target-interval bars.
    max_backfill_bars: int = 500

    # --- 趋势参数，与 EA 对齐 / trend params, aligned with the EA ---
    trend_fast_len: int = 10   # InpTrendFastLen
    trend_slow_len: int = 30   # InpTrendSlowLen
    trend_slope_len: int = 3   # InpTrendSlopeLen

    # 券商服务器所在时区相对 UTC 的偏移（小时）。H4/D1 各时区的 K 线边界不同，
    # 必须对齐券商时区，否则聚合出来的 bar 与 MT5 终端的 bar 不是同一段数据。
    #
    # **自动侦测优先**：网关启动后会通过 Manager API 的 TimeCurrent() 自动算出
    # 准确的偏移量，覆盖这个值。夏令时切换时无需手动修改。这里只是兜底——
    # 当自动侦测失败（例如 Manager API 版本不支持）时才生效。
    #
    # 默认 +2（EET 夏令时），冬令时服务商会变成 +3，自动侦测会感知。
    #
    # Broker timezone offset vs UTC in hours. H4/D1 bar boundaries differ across
    # timezones; the aggregation must match the broker's, or the bars differ from
    # MT5 terminal bars.
    #
    # **Auto-detection takes priority**: after connecting, the gateway calls the
    # Manager API's TimeCurrent() to derive the exact offset and overrides this
    # value. No manual adjustment is needed for DST transitions. This is only a
    # fallback for when auto-detection is unavailable (e.g. unsupported API build).
    #
    # Default +2 (EET DST); winter switches to +3 and auto-detection will notice.
    broker_gmt_offset: int = 2

    # --- 运行 / runtime ---
    log_level: str = "INFO"
    dry_run: bool = False  # 只算不推，用于验证聚合 / compute without pushing

    symbols: list[dict] = field(default_factory=lambda: list(DEFAULT_SYMBOLS))

    def validate(self) -> list[str]:
        """返回配置缺失项，空列表表示可以启动。
        Missing-config problems; an empty list means we can start."""
        problems = []
        if not self.login:
            problems.append("login 未设置 / login is not set")
        if not self.password:
            problems.append("password 未设置 / password is not set")
        if not self.server:
            problems.append("server 未设置 / server is not set")
        if not self.dry_run and not self.ea_token:
            problems.append("ea_token 未设置 / ea_token is not set")
        return problems

    def enabled_symbols(self) -> list[dict]:
        return [s for s in self.symbols if s.get("enabled", True)]


def _parse_symbols(raw: str) -> list[dict]:
    """解析 "XAUUSD=XAUUSD.s, EURUSD=EURUSD.s" 形式的品种映射。

    只写一个名字（没有 =）时表示 display 与 broker 同名。名字里带 `-` 前缀表示停用。

    Parse a "XAUUSD=XAUUSD.s, EURUSD=EURUSD.s" symbol map. A bare name means
    display and broker are identical; a leading `-` marks the entry disabled.
    """
    out: list[dict] = []
    for chunk in raw.replace("\n", ",").split(","):
        item = chunk.strip()
        if not item:
            continue
        enabled = True
        if item.startswith("-"):
            enabled = False
            item = item[1:].strip()
        if "=" in item:
            display, broker = (p.strip() for p in item.split("=", 1))
        else:
            display = broker = item
        if not display or not broker:
            continue
        out.append({"display": display.upper(), "broker": broker, "enabled": enabled})
    return out


def load_config(path: Path | None = None) -> Config:
    """加载配置：config.ini 打底，环境变量覆盖。

    环境变量优先，便于把凭据放在 Windows 服务的环境里而不落盘。

    Load config: config.ini as the base, environment variables override it.
    Env wins so credentials can live in the service environment instead of on disk.
    """
    cfg = Config()
    ini_path = path or CONFIG_PATH

    if ini_path.exists():
        # 密码可能含 % 等字符，关掉插值避免解析报错
        # Passwords may contain % etc.; disable interpolation so parsing won't fail.
        parser = configparser.ConfigParser(interpolation=None)
        parser.read(ini_path, encoding="utf-8")

        if parser.has_section("manager"):
            m = parser["manager"]
            cfg.server = m.get("server", cfg.server).strip()
            cfg.login = m.getint("login", cfg.login)
            cfg.password = m.get("password", cfg.password)
        if parser.has_section("backend"):
            b = parser["backend"]
            cfg.backend_url = b.get("url", cfg.backend_url).strip().rstrip("/")
            cfg.ea_token = b.get("ea_token", cfg.ea_token).strip()
        if parser.has_section("feed"):
            f = parser["feed"]
            cfg.quote_interval = f.getint("quote_interval", cfg.quote_interval)
            cfg.candle_tick_interval = f.getint("candle_tick_interval", cfg.candle_tick_interval)
            cfg.candle_backfill_interval = f.getint(
                "candle_backfill_interval", cfg.candle_backfill_interval
            )
            cfg.trend_interval = f.getint("trend_interval", cfg.trend_interval)
            cfg.config_poll_interval = f.getint("config_poll_interval", cfg.config_poll_interval)
            cfg.stale_quote_seconds = f.getint("stale_quote_seconds", cfg.stale_quote_seconds)
            cfg.max_backfill_bars = f.getint("max_backfill_bars", cfg.max_backfill_bars)
            cfg.broker_gmt_offset = f.getint("broker_gmt_offset", cfg.broker_gmt_offset)
            raw_symbols = f.get("symbols", "").strip()
            if raw_symbols:
                parsed = _parse_symbols(raw_symbols)
                if parsed:
                    cfg.symbols = parsed
        if parser.has_section("runtime"):
            r = parser["runtime"]
            cfg.log_level = r.get("log_level", cfg.log_level).strip().upper()
            cfg.dry_run = r.getboolean("dry_run", cfg.dry_run)
    else:
        logger.warning(
            "未找到 %s，使用默认值 + 环境变量 / %s not found, using defaults + env",
            ini_path.name, ini_path.name,
        )

    # 环境变量覆盖 / environment overrides
    env_map = {
        "MT5_MANAGER_SERVER": ("server", str),
        "MT5_MANAGER_LOGIN": ("login", int),
        "MT5_MANAGER_PASSWORD": ("password", str),
        "BACKEND_URL": ("backend_url", str),
        "EA_TOKEN": ("ea_token", str),
        "FEED_LOG_LEVEL": ("log_level", str),
        "BROKER_GMT_OFFSET": ("broker_gmt_offset", int),
    }
    for env_key, (attr, caster) in env_map.items():
        raw = os.environ.get(env_key)
        if raw is None or raw.strip() == "":
            continue
        try:
            value = caster(raw.strip())
        except ValueError:
            logger.warning("环境变量 %s 值无效，已忽略 / invalid %s, ignored", env_key, env_key)
            continue
        if attr == "backend_url":
            value = value.rstrip("/")
        if attr == "log_level":
            value = value.upper()
        setattr(cfg, attr, value)

    if os.environ.get("FEED_DRY_RUN", "").strip().lower() in ("1", "true", "yes"):
        cfg.dry_run = True

    env_symbols = os.environ.get("FEED_SYMBOLS", "").strip()
    if env_symbols:
        parsed = _parse_symbols(env_symbols)
        if parsed:
            cfg.symbols = parsed

    return cfg
