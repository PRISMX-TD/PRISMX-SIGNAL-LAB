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
    __table_args__ = (
        # 过期扫描按 (status, expire_at) 查询 / expiry sweep filters on (status, expire_at)
        Index("idx_signals_status_expire", "status", "expire_at"),
        # 行情驱动的胜负判定按 (symbol, result) 查询"该品种下所有未判定信号"，
        # 与 status/expire_at 完全独立——一个信号过期后仍可能继续追踪到胜负。
        # Price-driven resolution looks up "all unresolved signals for a symbol"
        # by (symbol, result); independent of status/expire_at — a signal can
        # keep being tracked toward a result after it's already EXPIRED for
        # trading purposes.
        Index("idx_signals_symbol_result", "symbol", "result"),
    )

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

    # 胜负判定：与 status 完全独立的第二条状态线。信号一出现即视为已进场，
    # 不受 10 分钟 status 过期影响，一直追踪到真正碰到止盈/止损，或超过
    # SIGNAL_STALE_DAYS 仍无行情更新（判定为 STALE，数据源可能中断，不计入胜率）。
    # Result: a second status axis, fully independent of `status`. A signal is
    # treated as entered the moment it's created; tracking isn't cut off by the
    # 10-minute `status` expiry — it continues until price actually reaches TP
    # or SL, or until SIGNAL_STALE_DAYS pass with no price update at all (marked
    # STALE — likely a feed gap — and excluded from win-rate stats).
    result = Column(String, default="PENDING")  # PENDING / HIT_TP / HIT_SL / STALE
    resolved_at = Column(DateTime, nullable=True)


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
    status = Column(String, default="PENDING")  # PENDING / FILLED / REJECTED / FAILED / CANCELLED
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


class ClosedTrade(Base):
    """一笔真实的 MT5 平仓明细（按 MT5 的成交记录，一次平仓/部分平仓一条）。

    由桥接程序上报：先用魔术号码（778899）在 MT5 成交历史里找出"哪些仓位是本
    平台开的"，再按仓位编号收集它们后续所有的平仓成交——不管那次平仓是通过
    网页发出的指令，还是用户直接在 MT5 客户端手动操作的，只要仓位编号对得上
    就会被记录。profit 是 MT5 自己算好的真实盈亏（账户货币），不是本平台估算的。

    A real MT5 close-leg record (one row per fill of a full/partial close,
    straight from MT5's own deal history).

    Reported by the bridge app: it first uses the magic number (778899) to find
    which positions this platform opened, then collects every subsequent
    closing deal for those position ids — regardless of whether the close was
    triggered by a web command or done manually in the MT5 terminal, as long as
    the position id matches. `profit` is MT5's own computed P&L (account
    currency), not an estimate made by this platform.
    """
    __tablename__ = "closed_trades"
    __table_args__ = (
        # 去重：桥接程序可能因重试重复上报同一笔成交 / dedup: the bridge may retry-report the same deal
        UniqueConstraint("user_id", "deal_ticket", name="uq_user_deal_ticket"),
        # 胜率聚合按 (user_id, mt5_login, position_ticket) 分组求和 / win-rate
        # aggregation groups by (user_id, mt5_login, position_ticket)
        Index("idx_closed_trades_position", "user_id", "mt5_login", "position_ticket"),
    )

    id = Column(String, primary_key=True, default=_uuid)
    user_id = Column(String, ForeignKey("users.id"), nullable=False, index=True)
    mt5_login = Column(String, nullable=False)
    symbol = Column(String, nullable=False)
    side = Column(String, nullable=False)  # 原仓位方向 BUY/SELL / the position's original direction
    close_volume = Column(Float, nullable=False)  # 这一笔平仓的手数（可能是部分平仓）/ this leg's volume
    close_price = Column(Float, nullable=False)
    profit = Column(Float, nullable=False)  # MT5 计算的真实盈亏（账户货币）/ MT5's real P&L, account currency
    position_ticket = Column(Integer, nullable=False)  # 仓位编号，同一仓位的多次部分平仓共享 / shared across partial closes
    deal_ticket = Column(Integer, nullable=False)  # MT5 成交编号，用于去重 / MT5 deal ticket, for dedup
    closed_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, default=_now)
