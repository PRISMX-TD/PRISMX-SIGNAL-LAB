"""ORM 数据模型 / ORM data models."""
import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint

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
    api_token = Column(String, unique=True, nullable=False, index=True)
    created_at = Column(DateTime, default=_now)


class EABinding(Base):
    """EA 绑定关系 / EA binding for a user."""
    __tablename__ = "ea_bindings"

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    mt5_login = Column(String, nullable=True)
    mt5_server = Column(String, nullable=True)
    # 用户设置的品种后缀，如 ".sc" / ".s" / user-set symbol suffix, e.g. ".sc"
    symbol_suffix = Column(String, nullable=True, default="")
    # EA 上报的账户信息 / account info reported by EA
    account_name = Column(String, nullable=True)
    account_currency = Column(String, nullable=True)
    balance = Column(Float, nullable=True)
    equity = Column(Float, nullable=True)
    leverage = Column(Integer, nullable=True)
    company = Column(String, nullable=True)
    online = Column(Boolean, default=False)
    last_heartbeat = Column(DateTime, nullable=True)


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
    __table_args__ = (UniqueConstraint("user_id", "client_order_id", name="uq_user_client_order"),)

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
