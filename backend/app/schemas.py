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


class RegisterRequest(AuthRequest):
    """注册请求：比登录多一个必填手机号。

    单独一个类而不是给 AuthRequest 加可选字段——登录不需要手机号，共用一个类
    就只能把它设成可选，那"必填"就退化成了运行时的 if 判断，接口文档上也看不出来。

    区号与号码分两个字段传，不是让前端自己拼好一个 E.164：拼接要处理国内号码的
    前导 0，而那一步必须知道区号在哪断开（见 services/phone.py 的说明）。让知道
    这件事的一方（这里是"两段分别传"）负责，比让前端拼、后端再猜要可靠。
    """

    phoneCountry: str = Field(min_length=1, max_length=6, description="国际区号，如 60 或 +60")
    phone: str = Field(min_length=3, max_length=24, description="国内号码部分")

    # 邀请链接归因码（落地页 ?ref= 捕获）。可选；乱填或已停用一律静默忽略，
    # 绝不影响注册本身（见 routers/invite.py 的 apply_invite）。
    # Optional invite-link code captured from ?ref=; unknown or disabled codes
    # are silently ignored and never block registration (see apply_invite).
    ref: str | None = Field(default=None, max_length=32)


class PhoneRequest(BaseModel):
    """补录手机号（Google 注册的用户首次登录后走这条）。字段含义同 RegisterRequest。"""

    phoneCountry: str = Field(min_length=1, max_length=6)
    phone: str = Field(min_length=3, max_length=24)


class GoogleAuthRequest(BaseModel):
    # 前端 Google Identity Services 返回的 ID Token / ID token from Google Identity Services
    credential: str = Field(min_length=1, max_length=4096)

    # 同 RegisterRequest.ref；该端点是查找或创建二合一，此字段仅在本次调用
    # 实际创建了新用户时才被应用（见 auth.google_login 的创建分支）。
    # Same as RegisterRequest.ref; this endpoint is find-or-create, and the
    # field is applied only when this call actually creates the user.
    ref: str | None = Field(default=None, max_length=32)


class UserOut(BaseModel):
    id: str
    email: str
    role: str = "user"
    plan: str = "FREE"
    phone: str | None = None
    # 前端据此决定要不要把用户拦在"补录手机号"页。由后端算好而不是让前端
    # 用 `!phone` 判断——存量用户的 phone 也是空，但他们豁免，这个区别只有
    # 后端知道（见 User.phone_required）。
    # The frontend gates on this rather than on `!phone`: grandfathered users
    # also have an empty phone but are exempt, a distinction only the backend
    # can make (see User.phone_required).
    needsPhone: bool = False


class AuthResponse(BaseModel):
    token: str
    user: UserOut


# ---------- 管理后台 / Admin ----------
class AdminUserOut(BaseModel):
    id: str
    email: str
    # 存量用户为空（上线前注册的一律豁免），不是数据缺失
    # Empty for grandfathered accounts registered before this shipped — not missing data
    phone: str | None = None
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


class SessionWindowOut(BaseModel):
    """交易时段定义。前端拿它拼「东京 09:00–18:00 (Asia/Tokyo)」这样的表头，
    时段区间因此只在后端定义一处，改了不用同步改前端。
    A trading session's definition; the UI builds its column header from this, so
    the windows live in exactly one place."""

    key: str  # asia / europe / newyork
    tz: str  # IANA 时区名，夏令时由它承担 / IANA zone; DST comes from it
    startHour: int
    endHour: int  # 左闭右开 / half-open


class HourOutcomeOut(BaseModel):
    """一天中某个钟点（UTC，0–23）在整个窗口内累计的止盈/止损笔数。

    **只含已判定的信号**：未判定的不出现在这张图上，等它真走出结果那天再计进来。
    后端不算百分比——一个钟点在薄窗口里只有三五笔时，百分比会在 100/0/50 之间
    跳，是否显示由前端按自己的样本门槛决定。

    钟点存 UTC，前端再旋转成浏览者本地钟点：后端不可能知道看的人在哪个时区，而
    24 个格子是一个完整的循环，旋转是无损的。

    这个模型取代了原来的 WeekdayOutcomeOut：产品要回答的是"一天里什么时候该盯"，
    星期几回答不了；方向也不再交叉拆分（24 × 2 个格子读不过来，而"做多还是做空
    更准"在详情区本来就有自己一块）。

    Take-profit / stop-loss counts for one hour of day (UTC, 0-23), accumulated
    across the whole window. **Resolved signals only**: unresolved ones are
    absent and join on the day they actually reach an outcome. No percentage is
    computed here — with a handful of trades in an hour a rate swings between
    100/0/50, so whether to show one is the UI's call against its own sample
    floor. Hours are stored in UTC and rotated into the viewer's local clock by
    the frontend: the backend cannot know the reader's zone, and 24 slots are a
    full cycle, so the rotation is lossless.

    This replaces WeekdayOutcomeOut: the product question is "when in the day
    should I watch", which a weekday cannot answer. There is no direction split
    either — 24 x 2 cells is more than anyone reads, and "long or short" already
    has its own block in the detail area.
    """

    tp: int
    sl: int


class WinRateBucketOut(BaseModel):
    """一个（策略, 时段）格子的胜负分布。
    Win/loss distribution for one (strategy, session) cell."""

    hitTp: int
    hitSl: int
    pending: int  # 尚未走出结果，不进分母 / no outcome yet; excluded from the denominator
    stale: int  # 行情追踪中断，不进分母 / tracking broke; excluded
    resolved: int  # hitTp + hitSl，即胜率的分母 / the win-rate denominator
    samples: int  # 窗口内该格子的全部信号数 / every signal in the cell
    # 分母为 0 时为 null，与「0% 胜率」区分开 / null on an empty denominator, distinct from a real 0%
    winRate: float | None
    # Wilson 95% 置信下限，推荐榜排序键；分母为 0 时 null / ranking key; null when unresolved
    wilsonLow: float | None
    # Wilson 区间上限。前端把 [low, high] 画成点图上的横杠——区间宽窄就是样本
    # 厚薄的可视化，5 笔的 50% 与 1296 笔的 50% 因此一眼可分。
    # The Wilson interval's upper bound; the UI draws [low, high] as a whisker,
    # making sample thickness visible rather than something to read in fine print.
    wilsonHigh: float | None
    # 窗口内已判定信号的平均判定秒数；无已判定时 null / mean seconds to resolution
    avgResolveSeconds: float | None
    # samples ÷ days × 7，一位小数 / normalized weekly signal count
    weeklySignals: float
    # 自窗口起点每 24h 一格的信号总数（含未判定），旧→新，长度=days。
    # 推荐卡的活跃度柱图用，回答"最近这几天忙不忙"。
    # 品种层与方向桶为 null（样本太薄不下发）。
    # Signal totals per 24h from the window start (unresolved included),
    # oldest→newest, length = days. Feeds the recommendation card's activity
    # sparkline. Null at the symbol layer and on side buckets.
    daily: list[int] | None = None
    # 按钟点（UTC，0–23）累计的止盈/止损，长度恒为 24，**只含已判定**。
    # 详情区的「哪个小时更准」图用，回答"一天里什么时候该盯"。
    # By hour of day (UTC, 0-23), always length 24, **resolved signals only**.
    # Feeds the detail area's "which hour is better" chart.
    hourly: list[HourOutcomeOut] | None = None


class SymbolWinRateOut(BaseModel):
    """一个（策略, 品种）组合的分时段胜率。桶结构与上层完全同构，
    前端用同一个渲染函数画所有层级。
    Per-(strategy, symbol) session breakdown; same bucket shape as the
    parent so the UI renders every level through one function."""

    symbol: str
    total: WinRateBucketOut
    sessions: dict[str, WinRateBucketOut]
    # 键为 BUY / SELL。方向认不出的历史行不进任何一侧，因此两者之和可能小于
    # total.samples——刻意如此，见 services/strategy_winrate.py 的 SIDE_KEYS。
    # Keyed BUY / SELL. Legacy rows with an unrecognized side join neither, so
    # the two may sum to less than total.samples — deliberate, see SIDE_KEYS.
    sides: dict[str, WinRateBucketOut] = Field(default_factory=dict)


class StrategyWinRateOut(BaseModel):
    # 空串表示 TradingView 警报没带 strategy 字段，前端显示成「未命名策略」
    # An empty string means the alert carried no strategy field; shown as "Unnamed"
    strategy: str
    total: WinRateBucketOut
    # 键为 asia / europe / newyork / outside。三个时段**允许重叠**（伦欧与纽约
    # 每天重叠约四小时），所以各时段 samples 之和 ≥ total.samples，不是笔误。
    # Keyed by asia / europe / newyork / outside. The sessions overlap by design
    # (London and New York share ~4h daily), so the per-session samples sum to
    # at least total.samples — not a bug.
    sessions: dict[str, WinRateBucketOut]
    # 品种子分层，按已判定笔数降序；overall 行恒为空列表
    # per-symbol sub-layer, resolved desc; always [] on the overall row
    # 键为 BUY / SELL。方向认不出的历史行不进任何一侧，因此两者之和可能小于
    # total.samples——刻意如此，见 services/strategy_winrate.py 的 SIDE_KEYS。
    # Keyed BUY / SELL. Legacy rows with an unrecognized side join neither, so
    # the two may sum to less than total.samples — deliberate, see SIDE_KEYS.
    sides: dict[str, WinRateBucketOut] = Field(default_factory=dict)
    symbols: list[SymbolWinRateOut] = Field(default_factory=list)


class AdminStrategyWinRateOut(BaseModel):
    days: int
    windowStart: datetime
    windowEnd: datetime
    # 最近一次成功判定胜负的时间，不受统计窗口限制。null = 从来没判定成功过。
    # 判定只在 POST /webhook/trend 带 high/low 时发生，这个时间戳是那条链路是否
    # 还活着的唯一直接读数。
    # When a signal was last resolved, independent of the stats window; null means
    # it never has. Resolution only runs when POST /webhook/trend carries
    # high/low, and this is the only direct readout of whether that path is alive.
    lastResolvedAt: datetime | None
    sessions: list[SessionWindowOut]
    overall: StrategyWinRateOut  # strategy 为空串，代表全部策略汇总 / all strategies combined
    strategies: list[StrategyWinRateOut]  # 已判定样本数降序 / by resolved samples desc


class AdminWinrateStrategyOut(BaseModel):
    """胜率公开设置页里的一行：一个策略、它的胜率、以及是否已公开。

    `resolved == 0` 表示这个策略近 N 天没有已判定的信号——可能是刚上线，也可能
    早已停用。这种行**照样返回**（`winRate` 为 null），设置页如实显示"近 N 天没有
    信号"：静默丢弃会让管理员以为自己没勾过它。

    One row on the win-rate publication settings page: a strategy, its win rate,
    and whether it is published. `resolved == 0` means no resolved signals in the
    window — newly added, or long retired. Such rows are still returned (with a
    null winRate) and the page says so explicitly; dropping them silently would
    read to an admin as "I never ticked that".
    """

    strategy: str
    resolved: int
    winRate: float | None
    public: bool


class AdminWinrateSettings(BaseModel):
    """胜率对外公开设置。读接口带上每个策略的胜率供管理员判断，写接口只收名单。
    Win-rate publication settings. The read side carries each strategy's win rate
    so the admin can decide; the write side takes only the list."""

    days: int
    strategies: list[AdminWinrateStrategyOut]


class AdminWinrateSettingsIn(BaseModel):
    # 公开名单，元素是 signals.indicator 里的原始策略名。空列表 = 一个都不公开。
    # The whitelist, holding raw signals.indicator names. Empty = publish nothing.
    publicStrategies: list[str] = Field(default_factory=list, max_length=200)


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
    exitSlDistancePct: float = Field(default=0.20, ge=0, le=1)


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


# ---------- 平台策略介绍 / Platform strategy write-ups ----------
# 管理员手工维护的内容型数据，用户端只读。刻意不含胜率、盈亏比等业绩数字：
# 真实战绩的唯一来源是 signals 表的 result 判定（services/signal_resolution.py），
# 这里只描述策略的设计特征（适用行情、持仓时长、风险回报比设计、所用指标）。
# Admin-authored content, read-only for users. Deliberately carries no win-rate
# or profit-factor figures: the only source of real performance is the signals
# table's result adjudication (services/signal_resolution.py). This describes
# design characteristics only (market regime, holding time, R:R design, indicators).


class PlatformStrategyBlock(BaseModel):
    """详细说明的一个内容块。管理员逐块添加、排序，前端按顺序渲染。

    为什么用结构化块而不是一段长文本：一整块纯文本在页面上会挤成一团，而支持
    Markdown/HTML 又要引入解析器和随之而来的注入面。分块把排版表达力限制在四
    种已知类型内，渲染时不需要解析任何标记语言。

    text 字段的含义随 kind 而变：
      heading   小标题，单行
      paragraph 正文段落
      list      要点列表，每行一条（前端按换行切分）
      image     图注，可留空；图片本体在 imageUrl

    One block of the long description. Admins add and order blocks; the client
    renders them in sequence.

    Why structured blocks instead of one long string: a single text blob reads as
    an undifferentiated wall, while supporting Markdown/HTML would mean shipping
    a parser and its injection surface. Blocks keep layout expressiveness inside
    four known types, so rendering parses no markup at all.

    The meaning of `text` depends on `kind`:
      heading   a single-line subheading
      paragraph a body paragraph
      list      bullet points, one per line (the client splits on newlines)
      image     an optional caption; the image itself is in imageUrl
    """

    kind: Literal["heading", "paragraph", "list", "image"] = "paragraph"
    textZh: str = Field(default="", max_length=4_000)
    textEn: str = Field(default="", max_length=4_000)
    # 仅 kind == "image" 使用 / used only when kind == "image"
    imageUrl: str = Field(default="", max_length=500)


class PlatformStrategyOut(BaseModel):
    """单条平台策略介绍 / one platform strategy write-up."""

    id: str = Field(min_length=1, max_length=64)
    # 展示顺序，用户端按升序排列 / display order, ascending on the client
    order: int = Field(default=0, ge=0, le=9_999)
    # 是否对用户可见：草稿状态下 admin 可先存后发
    # Visible to users; lets admins save a draft before publishing
    published: bool = Field(default=True)
    nameZh: str = Field(default="", max_length=80)
    nameEn: str = Field(default="", max_length=80)
    # 一句话简介 / one-line summary
    summaryZh: str = Field(default="", max_length=300)
    summaryEn: str = Field(default="", max_length=300)
    # 详细说明：结构化内容块，按顺序渲染。
    # detailZh/detailEn 是本功能第一版的单段纯文本字段，已被 blocks 取代。保留
    # 它们是为了不丢已录入的内容——库里存的是 JSON，旧记录没有 blocks 键，读出来
    # blocks 为空；详情页在 blocks 为空时回落渲染 detail 文本。新内容一律写 blocks。
    # Long description: structured blocks, rendered in order.
    # detailZh/detailEn were the first version's single-blob fields, now
    # superseded by blocks. They stay so already-entered copy isn't lost: rows are
    # stored as JSON, older ones have no blocks key and read back empty, and the
    # detail page falls back to rendering the detail text when blocks is empty.
    # New content always goes into blocks.
    blocks: list[PlatformStrategyBlock] = Field(default_factory=list, max_length=60)
    detailZh: str = Field(default="", max_length=8_000)
    detailEn: str = Field(default="", max_length=8_000)
    # 适用品种，自由文本标签（如 XAUUSD、主要货币对）
    # Applicable symbols as free-text tags (e.g. XAUUSD, majors)
    symbols: list[str] = Field(default_factory=list, max_length=20)
    # 所用技术指标标签（如 EMA(50)、RSI(14)）/ indicator tags
    indicators: list[str] = Field(default_factory=list, max_length=20)
    # 适用周期（如 M15、H1）/ timeframes
    timeframes: list[str] = Field(default_factory=list, max_length=10)
    # ---- 策略特征（方案 B：描述设计，不承诺业绩）----
    # ---- Design characteristics (describe the design, promise no performance) ----
    # 适用行情，自由文本（如"趋势行情"/"区间震荡"）/ market regime
    marketRegimeZh: str = Field(default="", max_length=120)
    marketRegimeEn: str = Field(default="", max_length=120)
    # 典型持仓时长（如"4–12 小时"）/ typical holding time
    holdingTimeZh: str = Field(default="", max_length=120)
    holdingTimeEn: str = Field(default="", max_length=120)
    # 风险回报比设计值，是策略参数而非业绩承诺（如"1:2"）
    # Designed risk:reward — a strategy parameter, not a performance claim
    riskReward: str = Field(default="", max_length=40)
    # 示意图 URL，空则不展示 / illustration URL; empty hides the image
    imageUrl: str = Field(default="", max_length=500)


class PlatformStrategyListOut(BaseModel):
    """平台策略介绍清单 / the platform strategy list."""

    items: list[PlatformStrategyOut] = Field(default_factory=list, max_length=50)




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
    # gateway 绑定已失效、需要用户重新输一次主密码（见 services/gateway_binding.py）。
    # 与 online 分开，是因为两者的用户动作完全不同：离线是"等一会儿或检查网关"，
    # 失效是"你必须去重新验证，否则永远不会自己好"。前端把它们显示成同一个灰色
    # 徽标，用户只会一直等下去。bridge 账号恒为 False。
    # A revoked gateway binding needing the main password re-entered. Kept
    # separate from `online` because the required user action differs: offline
    # means wait, revoked means act — rendering both as one grey badge would
    # leave the user waiting forever. Always False for bridge accounts.
    needsReverify: bool = False
    revokedReason: str | None = None


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


# ---------- 邀请链接 / Invite links ----------
class InviteClickRequest(BaseModel):
    code: str = Field(min_length=1, max_length=32)


class InviteLinkCreate(BaseModel):
    label: str = Field(min_length=1, max_length=64)


class InviteLinkUpdate(BaseModel):
    # 仅传要改的字段（exclude_unset 语义，同 AdminUserUpdate）。
    # Only send fields to change (exclude_unset semantics, like AdminUserUpdate).
    label: str | None = Field(default=None, min_length=1, max_length=64)
    isActive: bool | None = None
    grantsTrial: bool | None = None


class InviteLinkOut(BaseModel):
    id: str
    code: str
    label: str
    clicks: int
    # 经此链接注册的用户数：按 users.invite_code 分组统计，与备注文本解耦，
    # 管理员手改备注不影响这个数字。
    # Signups attributed to this link, grouped by users.invite_code — decoupled
    # from the note text, so hand-edited notes never skew it.
    registrations: int = 0
    isActive: bool
    # 经此链接注册是否自动开通 PRO 试用。是否**真的**会发还要看全局试用总闸
    # （见 invite.py 的 _trial_grant_days），管理页据此在总闸关闭时把这一列置灰。
    # Whether signups through this link auto-receive the PRO trial. Whether it
    # actually fires also depends on the global trial gate; the admin panel
    # greys the column out when that gate is closed.
    grantsTrial: bool = False
    createdAt: datetime | None = None
