"""Pydantic 请求/响应模型 / Pydantic request & response schemas."""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field

# 共用校验规则 / shared validation rules
# 品种：大写字母/数字/点，长度 1-20（含券商后缀）/ symbol: upper-alnum + dot
SYMBOL_PATTERN = r"^[A-Za-z0-9._-]{1,20}$"
# 券商后缀：可空，仅限有限字符集 / broker suffix: optional, limited charset
SUFFIX_PATTERN = r"^[A-Za-z0-9._-]{0,10}$"
# MT5 登录号：纯数字 / MT5 login: digits only
LOGIN_PATTERN = r"^[0-9]{1,20}$"


# ---------- 认证 / Auth ----------
class AuthRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class GoogleAuthRequest(BaseModel):
    # 前端 Google Identity Services 返回的 ID Token / ID token from Google Identity Services
    credential: str = Field(min_length=1, max_length=4096)


class UserOut(BaseModel):
    id: str
    email: str
    role: str = "user"
    plan: str = "FREE"


class AuthResponse(BaseModel):
    token: str
    user: UserOut


# ---------- 管理后台 / Admin ----------
class AdminUserOut(BaseModel):
    id: str
    email: str
    role: str
    plan: str
    planExpiresAt: datetime | None = None
    planNote: str | None = None
    createdAt: datetime | None = None
    lastActiveAt: datetime | None = None
    mt5AccountCount: int = 0


class AdminUserUpdate(BaseModel):
    # 仅传入要修改的字段；省略的字段保持不变 / only send fields to change; omitted ones are left alone
    role: Literal["user", "admin"] | None = None
    plan: Literal["FREE", "PRO"] | None = None
    # 显式传 null 表示清除到期时间（永久）；不传表示不修改。用 sentinel 区分二者较繁琐，
    # 这里采用「传字段就是要设置这个值，包括 None」的简单约定，交由前端保证语义。
    # Explicit null clears the expiry (never expires); omitting the field
    # entirely leaves it unchanged. We rely on Pydantic's exclude_unset to
    # tell "omitted" from "explicitly set to null" instead of a sentinel.
    planExpiresAt: datetime | None = Field(default=None)
    planNote: str | None = Field(default=None, max_length=256)


class AdminBulkUserUpdate(AdminUserUpdate):
    # 目标用户 id 列表；其余字段语义与 AdminUserUpdate 完全一致（仅传要改的字段）。
    # Target user ids; remaining fields behave exactly like AdminUserUpdate
    # (only send the fields you want to change).
    userIds: list[str] = Field(min_length=1, max_length=500)


class AdminMetricsOut(BaseModel):
    totalUsers: int
    dau: int  # 近 24 小时活跃 / active within the last 24h
    wau: int  # 近 7 天活跃 / active within the last 7 days
    planCounts: dict[str, int]
    signupsLast7d: list[dict]  # [{date, count}]


class AdminBrokerSettings(BaseModel):
    """合作券商锁设置（管理后台读写用同一形状）。
    Partner-broker lock settings (same shape for admin read & write)."""

    brokerLockEnabled: bool
    # 服务器名匹配关键字，大小写不敏感的包含匹配 / server-name keywords, case-insensitive substring
    brokerPatterns: list[str] = Field(default_factory=list, max_length=20)
    brokerDisplayName: str = Field(default="", max_length=64)
    brokerReferralUrl: str = Field(default="", max_length=512)


class AdminPricingSettings(BaseModel):
    """订阅定价设置 / Subscription pricing settings."""

    proMonthlyPrice: float = Field(ge=0, le=99999)
    proYearlyPrice: float = Field(ge=0, le=999999)
    saleEnabled: bool = False
    salePercent: int = Field(default=0, ge=0, le=100)
    saleBadge: str = Field(default="", max_length=32)
    saleEndAt: str = Field(default="", max_length=25)  # ISO date string or empty


class AdminTrialSettings(BaseModel):
    """免费试用设置 / Free-trial settings."""

    trialEnabled: bool = False
    trialDays: int = Field(default=7, ge=1, le=90)


class AdminDisciplineSettings(BaseModel):
    """纪律分参数设置 / Discipline-score parameter settings."""

    windowDays: int = Field(default=90, ge=7, le=365)
    weightStop: int = Field(default=40, ge=0, le=100)
    weightVolume: int = Field(default=30, ge=0, le=100)
    weightExit: int = Field(default=30, ge=0, le=100)
    slTolerancePct: float = Field(default=0.10, ge=0, le=1)
    volumeMultiple: float = Field(default=3.0, ge=1, le=20)
    volumeHistoryMin: int = Field(default=5, ge=1, le=50)


class AdminCandleSettings(BaseModel):
    """K 线历史保留策略设置 / Candle-history retention settings."""

    m1RetentionDays: int = Field(default=30, ge=1, le=365)


class AdminStrategySettings(BaseModel):
    """自定义策略平台设置 / Custom-strategy platform settings."""

    maxStrategiesPerUser: int = Field(default=3, ge=1, le=50)
    proOnly: bool = Field(default=True)


# ---------- 自定义策略 / User strategies ----------
class StrategyCreate(BaseModel):
    template: Literal["ma_cross", "rsi_reversal", "bollinger_reversion", "macd_cross", "ma_pullback", "bollinger_breakout", "rsi_momentum", "donchian_breakout", "momentum_breakout", "trend_rsi_filter"]
    # 用户自定义名称，留空由前端按模板名兜底 / user-given name; frontend falls back to the template label when empty
    name: str | None = Field(default=None, max_length=60)
    symbol: str = Field(pattern=SYMBOL_PATTERN)
    interval: str
    params: dict = Field(default_factory=dict)
    stopLossMethod: Literal["percent", "price"] = "percent"
    stopLossValue: float = Field(default=1.0, gt=0, le=1_000_000)
    takeProfitMethod: Literal["rr", "percent", "price"] = "rr"
    takeProfitValue: float = Field(default=2.0, gt=0, le=1_000_000)


class StrategyUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=60)
    params: dict | None = None
    stopLossMethod: Literal["percent", "price"] | None = None
    stopLossValue: float | None = Field(default=None, gt=0, le=1_000_000)
    takeProfitMethod: Literal["rr", "percent", "price"] | None = None
    takeProfitValue: float | None = Field(default=None, gt=0, le=1_000_000)
    enabled: bool | None = None


class StrategyOut(BaseModel):
    id: str
    template: str
    name: str | None = None
    symbol: str
    interval: str
    params: dict
    stopLossMethod: str
    stopLossValue: float
    takeProfitMethod: str
    takeProfitValue: float
    enabled: bool
    createdAt: datetime


class StrategyBacktestRequest(BaseModel):
    template: Literal["ma_cross", "rsi_reversal", "bollinger_reversion", "macd_cross", "ma_pullback", "bollinger_breakout", "rsi_momentum", "donchian_breakout", "momentum_breakout", "trend_rsi_filter"]
    symbol: str = Field(pattern=SYMBOL_PATTERN)
    interval: str
    params: dict = Field(default_factory=dict)
    stopLossMethod: Literal["percent", "price"] = "percent"
    stopLossValue: float = Field(default=1.0, gt=0, le=1_000_000)
    takeProfitMethod: Literal["rr", "percent", "price"] = "rr"
    takeProfitValue: float = Field(default=2.0, gt=0, le=1_000_000)
    days: int = Field(default=90, ge=7, le=730)
    riskPct: float = Field(default=1.0, ge=0.1, le=3.0)
    capital: float = Field(default=10000, ge=1, le=1e9)
    mode: Literal["compound", "flat"] = "compound"


class StrategySignalOut(BaseModel):
    id: str
    strategyId: str
    symbol: str
    side: str
    entry: float
    stopLoss: float
    takeProfit: float
    createdAt: datetime


# ---------- API Token / MT5 连接凭证 ----------
class EATokenOut(BaseModel):
    # 明文 token 仅在重置（生成）响应中出现一次；查询时为 None（库中只存哈希）。
    # The plaintext token appears only once in the reset response; None on
    # reads (the DB stores just the hash).
    apiToken: str | None = None
    boundAccount: str | None = None


# ---------- 多账号 / Multi-account ----------
class MT5AccountOut(BaseModel):
    login: str
    server: str | None = None
    source: str | None = None
    accountName: str | None = None
    accountCurrency: str | None = None
    balance: float | None = None
    equity: float | None = None
    leverage: int | None = None
    company: str | None = None
    symbolSuffix: str | None = None
    online: bool = False
    lastHeartbeat: datetime | None = None


class AccountSuffixRequest(BaseModel):
    login: str = Field(pattern=LOGIN_PATTERN)
    symbolSuffix: str = Field(default="", pattern=SUFFIX_PATTERN)


# ---------- 信号 / Signal ----------
class SignalOut(BaseModel):
    id: str
    symbol: str
    side: str
    entry: float | None = None
    stopLoss: float | None = None
    takeProfit: float | None = None
    indicator: str | None = None
    status: str
    createdAt: datetime
    expireAt: datetime | None = None
    # 胜负判定：PENDING / HIT_TP / HIT_SL / STALE，与 status 独立 / independent of status
    result: str = "PENDING"
    resolvedAt: datetime | None = None


# ---------- 下单 / Order ----------
class OrderRequest(BaseModel):
    signalId: str | None = Field(default=None, max_length=64)
    symbol: str = Field(pattern=SYMBOL_PATTERN)
    side: Literal["BUY", "SELL"]
    volume: float = Field(gt=0, le=10000)
    clientOrderId: str = Field(min_length=1, max_length=64)
    # 目标 MT5 账号 login（多账号时指定）/ target MT5 login (multi-account)
    mt5Login: str | None = Field(default=None, pattern=LOGIN_PATTERN)
    # 自定义止损止盈（绝对价，省略则用信号默认值）/ custom SL·TP (absolute; falls back to signal)
    stopLoss: float | None = Field(default=None, ge=0)
    takeProfit: float | None = Field(default=None, ge=0)


class ClosePositionRequest(BaseModel):
    clientOrderId: str = Field(min_length=1, max_length=64)
    ticket: int = Field(gt=0)
    symbol: str = Field(pattern=SYMBOL_PATTERN)
    side: Literal["BUY", "SELL"]
    mt5Login: str | None = Field(default=None, pattern=LOGIN_PATTERN)
    # 平仓手数；省略或为 0 表示全平 / volume to close; omit or 0 means full close
    volume: float | None = Field(default=None, ge=0, le=10000)


class ModifyPositionRequest(BaseModel):
    clientOrderId: str = Field(min_length=1, max_length=64)
    ticket: int = Field(gt=0)
    symbol: str = Field(pattern=SYMBOL_PATTERN)
    side: Literal["BUY", "SELL"]
    mt5Login: str | None = Field(default=None, pattern=LOGIN_PATTERN)
    # 新的止损止盈（绝对价，0 表示清除）/ new SL·TP (absolute; 0 clears)
    stopLoss: float = Field(default=0.0, ge=0)
    takeProfit: float = Field(default=0.0, ge=0)


class OrderOut(BaseModel):
    id: str
    clientOrderId: str
    signalId: str | None = None
    action: str = "ORDER"
    symbol: str
    side: str
    volume: float
    ticket: int | None = None
    mt5Login: str | None = None
    status: str
    mt5Ticket: int | None = None
    filledPrice: float | None = None
    message: str | None = None
    createdAt: datetime
    updatedAt: datetime
