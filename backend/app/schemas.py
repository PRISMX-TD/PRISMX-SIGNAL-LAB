"""Pydantic 请求/响应模型 / Pydantic request & response schemas."""
import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

from app.services.strategy.presets import TEMPLATE_KEYS as STRATEGY_TEMPLATES

# 共用校验规则 / shared validation rules
# 品种：大写字母/数字/点，长度 1-20（含券商后缀）/ symbol: upper-alnum + dot
SYMBOL_PATTERN = r"^[A-Za-z0-9._-]{1,20}$"
# 券商后缀：可空，仅限有限字符集 / broker suffix: optional, limited charset
SUFFIX_PATTERN = r"^[A-Za-z0-9._-]{0,10}$"
# MT5 登录号：纯数字 / MT5 login: digits only
LOGIN_PATTERN = r"^[0-9]{1,20}$"


def _normalize_symbol(v: str) -> str:
    """统一大写、去空白，并按 SYMBOL_PATTERN 校验。
    Upper-case, strip, and validate against SYMBOL_PATTERN."""
    s = v.strip().upper()
    if not re.fullmatch(SYMBOL_PATTERN, s):
        raise ValueError(f"非法品种代码 {v} / invalid symbol code")
    return s


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


class PageViewIn(BaseModel):
    """页面访问上报体。seconds 是本次在该页的停留秒数。

    上限交给路由层的 MAX_DWELL_SECONDS 截断而不在这里用 le= 卡死：超限是
    "挂着页面没看"这种正常现象，按上限计入即可，不该让整个请求 422 失败而
    丢掉这一次访问计数。负数则直接归零。

    Page-view report body; seconds is the dwell time on that page this visit.
    The cap is applied by the router's MAX_DWELL_SECONDS rather than a le=
    constraint here: exceeding it means "tab left open", a normal occurrence
    that should be clamped and counted, not 422'd into losing the view entirely.
    Negatives are floored at zero.
    """
    path: str = Field(max_length=200)
    seconds: float


class PageDayPointOut(BaseModel):
    """某页面某一天的三个指标。没有数据的日期也会返回（三项全为 0），
    因为折线图需要连续的日期轴，缺日期会被画成直线跨过去。

    One day's three metrics for a page. Days with no data are still returned
    (all zeros): the line chart needs a contiguous date axis, and a missing day
    would be drawn as a straight line across the gap.
    """

    date: str  # ISO 日期 YYYY-MM-DD（UTC）
    visitors: int  # 当天访问过该页的去重用户数
    views: int
    avgSeconds: float


class PageStatOut(BaseModel):
    path: str
    views: int
    # 窗口内访问过该页的去重人数。**不等于 daily 里各天 visitors 之和**：
    # 同一个人多天来访，按天各算一次、去重后只算一个。
    # Distinct visitors for the window; NOT the sum of daily visitors, since one
    # person visiting on several days counts once here.
    visitors: int
    avgSeconds: float  # total_seconds / views，跨小时桶加权后的均值
    daily: list[PageDayPointOut]  # 按日期升序 / ascending by date


class AdminPageStatsOut(BaseModel):
    days: int  # 统计窗口天数 / window size in days
    totalViews: int
    totalVisitors: int  # 全站去重人数，同样不是各页人数之和（一个人可看多页）
    avgSecondsOverall: float
    dates: list[str]  # 公共日期轴，与每个 page.daily 的顺序一致
    pages: list[PageStatOut]  # 按访问次数降序 / sorted by views desc


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


class AdminStrategyCostEntry(BaseModel):
    """单个品种的成本覆盖项 / one symbol's cost override."""

    symbol: str = Field(pattern=SYMBOL_PATTERN)
    spread: float = Field(ge=0, le=10_000)
    commissionPerLot: float = Field(ge=0, le=10_000)
    slippage: float = Field(ge=0, le=10_000)


class AdminStrategyCosts(BaseModel):
    """策略回测/实盘的交易成本配置。点差与滑点为价格单位；手续费为一手往返
    合计、折算到价格单位（见 services/strategy/costs.py）。
    Trading-cost config for strategy backtests and live evaluation. Spread and
    slippage are price units; commission is per lot, round trip, in price units
    (see services/strategy/costs.py)."""

    defaultSpread: float = Field(default=0.2, ge=0, le=10_000)
    defaultCommissionPerLot: float = Field(default=0.0, ge=0, le=10_000)
    defaultSlippage: float = Field(default=0.05, ge=0, le=10_000)
    perSymbol: list[AdminStrategyCostEntry] = Field(default_factory=list)


# ---------- 自定义策略 / User strategies ----------
# 模板清单的唯一来源在引擎侧（services/strategy/presets.py）。此前这里有两份
# 硬写的 Literal，加一个模板要改三处、漏一处就是"能建不能回测"的静默不一致。
# 品种数/周期数的上限同理不在这里硬写：它们的唯一来源是 rules.MAX_SYMBOLS /
# MAX_INTERVALS，由端点校验并返回点名上限值的 400。
# The template list has a single source of truth on the engine side
# (services/strategy/presets.py). There used to be two hardcoded Literals here;
# adding a template meant editing three places, and missing one produced a
# silent "creatable but not backtestable" inconsistency. Symbol/interval count
# caps likewise aren't hardcoded here — rules.MAX_SYMBOLS / MAX_INTERVALS own
# them, and the endpoint returns a 400 naming the actual limit.


def validate_template_key(v: str | None) -> str | None:
    """两个请求模型共用的模板名校验器，取代原先各写一遍的 Literal。
    Shared template-name validator for both request models, replacing the
    per-model Literals."""
    if v is None:
        return None
    if v not in STRATEGY_TEMPLATES:
        raise ValueError(f"未知模板 {v}，可选 {list(STRATEGY_TEMPLATES)} / unknown template")
    return v


class SessionFilterIn(BaseModel):
    """交易时段过滤：UTC+8 小时区间，左闭右开。startHour > endHour 表示跨零点。
    Session filter: UTC+8 hour range, half-open. startHour > endHour spans
    midnight."""

    startHour: int = Field(ge=0, le=23)
    endHour: int = Field(ge=0, le=23)


class StrategyCreate(BaseModel):
    # template 现在只是"从哪个预设起步"的记录，可以完全不传（纯自定义 AST）。
    # 不传 rules 时用该 template 的预设 AST；两者都不传则 400。
    # `template` is now just a record of which preset this started from and may
    # be omitted entirely (pure custom AST). With no `rules`, the template's
    # preset AST is used; omitting both is a 400.
    template: str | None = None
    # 用户自定义名称，留空由前端按模板名兜底 / user-given name; frontend falls back to the template label when empty
    name: str | None = Field(default=None, max_length=60)
    rules: dict | None = None
    symbol: str = Field(min_length=1, max_length=20)
    interval: str = Field(min_length=1, max_length=4)
    stopLossMethod: Literal["percent", "steps", "atr"] = "percent"
    stopLossValue: float = Field(default=1.0, gt=0, le=1_000_000)
    takeProfitMethod: Literal["rr", "percent", "steps", "atr"] = "rr"
    takeProfitValue: float = Field(default=2.0, gt=0, le=1_000_000)
    # 一次一单：开着仓时不再触发新信号，关闭则只要条件满足就触发
    # One trade at a time: no new signal while a position is open; off means
    # any bar meeting the condition fires regardless
    oneTradeAtATime: bool = True
    exitTimeoutBars: int | None = Field(default=None, ge=1, le=1000)
    sessionFilter: SessionFilterIn | None = None
    dailySignalCap: int | None = Field(default=None, ge=1, le=100)
    cooldownMinutes: int | None = Field(default=None, ge=1, le=10_080)

    @field_validator("template")
    @classmethod
    def _check_template(cls, v: str | None) -> str | None:
        return validate_template_key(v)

    @field_validator("symbol")
    @classmethod
    def _check_symbol(cls, v: str) -> str:
        return _normalize_symbol(v)


class StrategyUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=60)
    rules: dict | None = None
    symbol: str | None = Field(default=None, min_length=1, max_length=20)
    interval: str | None = Field(default=None, min_length=1, max_length=4)
    stopLossMethod: Literal["percent", "steps", "atr"] | None = None
    stopLossValue: float | None = Field(default=None, gt=0, le=1_000_000)
    takeProfitMethod: Literal["rr", "percent", "steps", "atr"] | None = None
    takeProfitValue: float | None = Field(default=None, gt=0, le=1_000_000)
    oneTradeAtATime: bool | None = None
    exitTimeoutBars: int | None = Field(default=None, ge=1, le=1000)
    sessionFilter: SessionFilterIn | None = None
    dailySignalCap: int | None = Field(default=None, ge=1, le=100)
    cooldownMinutes: int | None = Field(default=None, ge=1, le=10_080)
    enabled: bool | None = None

    @field_validator("symbol")
    @classmethod
    def _check_symbol(cls, v: str | None) -> str | None:
        return None if v is None else _normalize_symbol(v)


class StrategyOut(BaseModel):
    id: str
    template: str | None = None
    name: str | None = None
    rules: dict
    symbol: str
    interval: str
    stopLossMethod: str
    stopLossValue: float
    takeProfitMethod: str
    takeProfitValue: float
    oneTradeAtATime: bool
    exitTimeoutBars: int | None = None
    sessionFilter: dict | None = None
    dailySignalCap: int | None = None
    cooldownMinutes: int | None = None
    enabled: bool
    createdAt: datetime


class StrategyBacktestRequest(BaseModel):
    # 回测一次只跑一个 (品种, 周期) 组合：多组合的净值无法叠加成一条有意义的
    # 曲线（同时持多品种仓位是另一回事，不在本次范围）。前端要比多个组合就
    # 分别发请求。
    # A backtest covers exactly one (symbol, interval) pair: equity across pairs
    # can't be summed into one meaningful curve (holding positions in several
    # symbols at once is a different feature, out of scope). The frontend issues
    # one request per pair.
    template: str | None = None
    rules: dict | None = None
    symbol: str = Field(pattern=SYMBOL_PATTERN)
    interval: str
    stopLossMethod: Literal["percent", "steps", "atr"] = "percent"
    stopLossValue: float = Field(default=1.0, gt=0, le=1_000_000)
    takeProfitMethod: Literal["rr", "percent", "steps", "atr"] = "rr"
    takeProfitValue: float = Field(default=2.0, gt=0, le=1_000_000)
    oneTradeAtATime: bool = True
    exitTimeoutBars: int | None = Field(default=None, ge=1, le=1000)
    days: int = Field(default=90, ge=7, le=730)
    riskPct: float = Field(default=1.0, ge=0.1, le=3.0)
    capital: float = Field(default=10000, ge=1, le=1e9)
    mode: Literal["compound", "flat"] = "compound"

    @field_validator("template")
    @classmethod
    def _check_template(cls, v: str | None) -> str | None:
        return validate_template_key(v)


class StrategySignalOut(BaseModel):
    id: str
    strategyId: str
    symbol: str
    interval: str | None = None
    side: str
    entry: float
    stopLoss: float
    takeProfit: float
    result: str
    barsHeld: int
    resolvedAt: datetime | None = None
    createdAt: datetime


class StrategyPerformanceOut(BaseModel):
    """实盘绩效 + 最近一次回测的对照。已判定不足 sampleThreshold 笔时
    winRate / avgRr 为 None，前端显示"样本不足"而不是把 1 胜 0 负写成 100%。
    Live performance plus the latest backtest for comparison. Below
    sampleThreshold resolved trades, winRate/avgRr are None so the frontend
    shows "insufficient sample" instead of rendering 1-0 as 100%."""

    strategyId: str
    resolved: int
    wins: int
    losses: int
    timeouts: int
    pending: int
    winRate: float | None = None
    avgRr: float | None = None
    maxLossStreak: int
    # maxLossStreak 只统计最近 streakWindow 笔已判定信号。顺序相关指标无法聚合，
    # 全量回看会随信号历史无界增长，所以窗口是硬上限；把窗口一起返回，前端才不会
    # 把一个有范围的数字当成全历史最长连亏来读。
    # maxLossStreak covers only the most recent streakWindow resolved signals: an
    # order-dependent metric can't be aggregated, and scanning all of history
    # grows without bound, so the window is a hard cap. It's returned alongside so
    # the frontend doesn't read a bounded number as an all-time streak.
    streakWindow: int
    insufficientSample: bool
    sampleThreshold: int
    backtest: dict | None = None


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


# ---------- 工单系统 / Ticket System ----------

class TicketCreate(BaseModel):
    """用户提交新工单 / submit a new ticket."""
    title: str = Field(min_length=1, max_length=200)
    category: Literal["account", "payment", "technical", "feature"]
    priority: Literal["low", "normal", "urgent"] = "normal"
    body: str = Field(min_length=1, max_length=5000)


class TicketReplyCreate(BaseModel):
    """追加回复 / add a reply."""
    body: str = Field(min_length=1, max_length=5000)
    reopen: bool = False  # closed 工单重开 / reopen a closed ticket


class TicketReplyOut(BaseModel):
    """单条回复 / one reply."""
    id: str
    authorId: str
    authorEmail: str
    authorRole: str  # "user" | "admin"
    body: str
    createdAt: datetime


class TicketOut(BaseModel):
    """工单详情（含全部回复）/ ticket detail with all replies."""
    id: str
    userId: str
    userEmail: str
    title: str
    category: str
    priority: str
    status: str
    createdAt: datetime
    updatedAt: datetime
    replies: list[TicketReplyOut]


class TicketListItem(BaseModel):
    """工单列表项（含最新一条回复预览）/ ticket list row with latest-reply preview."""
    id: str
    userEmail: str = ""
    title: str
    category: str
    priority: str
    status: str
    updatedAt: datetime
    latestReply: TicketReplyOut | None = None


class AdminTicketUpdate(BaseModel):
    """管理员修改工单属性 / admin updates ticket properties."""
    status: Literal["open", "in_progress", "closed"] | None = None
    priority: Literal["low", "normal", "urgent"] | None = None


class AdminTicketReplyCreate(TicketReplyCreate):
    """管理员回复（可附带改 status/priority）/ admin reply, optionally
    with status/priority changes."""
    status: Literal["open", "in_progress", "closed"] | None = None
    priority: Literal["low", "normal", "urgent"] | None = None
