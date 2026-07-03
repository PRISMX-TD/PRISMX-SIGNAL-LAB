"""ORM 数据模型 / ORM data models."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint

from app.core.database import Base


def _uuid() -> str:
    return str(uuid.uuid4())


def _now() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    """用户 / Platform user."""
    __tablename__ = "users"

    id = Column(String, primary_key=True, default=_uuid)
    email = Column(String, unique=True, nullable=False, index=True)
    # 密码哈希：Google 登录的用户没有密码，故可空 / nullable: Google users have no password
    password_hash = Column(String, nullable=True)
    # API Token 的 SHA-256 哈希（明文只在生成时展示一次，不落库）
    # SHA-256 hash of the API token (plaintext shown once at generation, never stored)
    api_token = Column(String, unique=True, nullable=False, index=True)
    created_at = Column(DateTime, default=_now)


# 说明：旧的 EABinding（ea_bindings 表，EA 单账号绑定）已随 EA 接入方式移除。
# 生产库中的旧表保留不删，只是不再读写；多账号统一使用 MT5Account。
# Note: the legacy EABinding model (ea_bindings, single-account EA binding) was
# removed together with the EA integrations. The old table is left in place in
# production but no longer read or written; MT5Account is the single source.


class MT5Account(Base):
    """单个 MT5 账号（一个用户可挂多个）。
    A single MT5 account (a user may bind multiple).
    由桥接程序或 EA 上报，用 (user_id, login, server) 唯一标识。
    Reported by the bridge app or EA, identified by (user_id, login, server).
    """
    __tablename__ = "mt5_accounts"
    __table_args__ = (
        UniqueConstraint("user_id", "login", "server", name="uq_user_login_server"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    login = Column(String, nullable=False)
    server = Column(String, nullable=True)
    # 来源：bridge（Python 程序）/ ea（MT5 EA）/ source of the report
    source = Column(String, default="bridge")
    account_name = Column(String, nullable=True)
    account_currency = Column(String, nullable=True)
    balance = Column(Float, nullable=True)
    equity = Column(Float, nullable=True)
    leverage = Column(Integer, nullable=True)
    company = Column(String, nullable=True)
    # 该账号的品种后缀（如 ".sc"）/ symbol suffix for this account
    symbol_suffix = Column(String, nullable=True, default="")
    online = Column(Boolean, default=False)
    last_heartbeat = Column(DateTime, nullable=True)


class Signal(Base):
    """交易信号 / Trading signal."""
    __tablename__ = "signals"
    # 过期扫描按 (status, expire_at) 查询 / expiry sweep filters on (status, expire_at)
    __table_args__ = (Index("idx_signals_status_expire", "status", "expire_at"),)

    id = Column(String, primary_key=True, default=_uuid)
    symbol = Column(String, nullable=False)
    side = Column(String, nullable=False)  # BUY / SELL
    entry = Column(Float)
    stop_loss = Column(Float)
    take_profit = Column(Float)
    indicator = Column(String)
    # 来源：mock 内置引擎 / tradingview Webhook / source of the signal
    source = Column(String, default="mock")
    # 外部唯一编号（如 TradingView 警报自带的 id），用于去重，可空。
    # External unique id (e.g. from a TradingView alert) for dedup; nullable.
    external_id = Column(String, nullable=True, unique=True, index=True)
    status = Column(String, default="ACTIVE")  # ACTIVE / EXPIRED
    created_at = Column(DateTime, default=_now)
    expire_at = Column(DateTime, nullable=True)


class Order(Base):
    """下单指令与回执 / Order command and execution result."""
    __tablename__ = "orders"
    __table_args__ = (
        UniqueConstraint("user_id", "client_order_id", name="uq_user_client_order"),
        # 后台清扫按 status 查询 / the stale-order sweep filters on status
        Index("idx_orders_status", "status"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    signal_id = Column(String, ForeignKey("signals.id"), nullable=True)
    client_order_id = Column(String, nullable=False)
    # 指令类型：ORDER 开仓 / CLOSE 平仓（含部分）/ MODIFY 改 SL·TP
    # command action: ORDER (open) / CLOSE (incl. partial) / MODIFY (SL·TP)
    action = Column(String, default="ORDER")
    symbol = Column(String, nullable=False)
    side = Column(String, nullable=False)
    volume = Column(Float, nullable=False)
    # 目标持仓 ticket（平仓/改单用）/ target position ticket (close/modify)
    ticket = Column(Integer, nullable=True)
    # 自定义/目标止损止盈（绝对价）/ custom or target SL & TP (absolute price)
    sl = Column(Float, nullable=True)
    tp = Column(Float, nullable=True)
    # 目标 MT5 账号 login（多账号路由用）/ target MT5 login for routing
    mt5_login = Column(String, nullable=True)
    status = Column(String, default="PENDING")  # PENDING / FILLED / REJECTED / FAILED
    # 是否已下发给 EA（轮询模式用）/ delivered to EA (used by polling mode)
    delivered = Column(Boolean, default=False)
    # 最近一次下发时间，用于超时重发判定 / last delivery time, for ack-timeout re-delivery
    delivered_at = Column(DateTime, nullable=True)
    mt5_ticket = Column(Integer, nullable=True)
    filled_price = Column(Float, nullable=True)
    message = Column(String, nullable=True)
    created_at = Column(DateTime, default=_now)
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class NotificationPref(Base):
    """通知偏好（白名单模式），每个用户一条 / Notification prefs (whitelist), one per user."""
    __tablename__ = "notification_prefs"

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, unique=True, index=True)
    # 是否启用通知 / whether notifications are enabled at all
    enabled = Column(Boolean, default=False)
    # 用户选择开启的指标类别（JSON array of strings）；空(非 null)表示全关闭 / selected indicator categories
    selected_categories = Column(Text, default="[]")


class PushSubscription(Base):
    """Web Push 订阅：每个用户的每个设备一条 / One push subscription per device per user."""
    __tablename__ = "push_subscriptions"
    __table_args__ = (
        UniqueConstraint("user_id", "endpoint", name="uq_user_endpoint"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    endpoint = Column(String, nullable=False)
    keys_p256dh = Column(String, nullable=False)
    keys_auth = Column(String, nullable=False)
    created_at = Column(DateTime, default=_now)


class UserPref(Base):
    """用户通用偏好（跨设备同步），每个用户一条 JSON 文档。
    Generic per-user preferences (cross-device sync), one JSON document per user.
    用于信号面板等界面设置的云端同步 / used to sync UI settings like the signals panel.
    """
    __tablename__ = "user_prefs"

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, unique=True, index=True)
    # 偏好 JSON 文档（按命名空间存放，如 {"signals": {...}}）/ prefs JSON keyed by namespace
    data = Column(Text, default="{}")
    updated_at = Column(DateTime, default=_now, onupdate=_now)


class Trend(Base):
    """多周期趋势快照：每个品种一条，后来的覆盖前面的。
    Multi-timeframe trend snapshot: one row per symbol, latest overwrites previous.
    由 TradingView 指标经 /api/webhook/trend 推送，仅在任一周期翻转时更新。
    Pushed by a TradingView indicator via /api/webhook/trend, only when a TF flips.
    """
    __tablename__ = "trends"

    id = Column(String, primary_key=True, default=_uuid)
    symbol = Column(String, nullable=False, unique=True, index=True)
    # 各周期趋势的 JSON 对象，如 {"M5":"UP","M15":"DOWN",...} / per-timeframe map as JSON
    timeframes = Column(Text, default="{}")
    updated_at = Column(DateTime, default=_now, onupdate=_now)
