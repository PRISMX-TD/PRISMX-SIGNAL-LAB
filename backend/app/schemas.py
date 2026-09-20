"""Pydantic 请求/响应模型 / Pydantic request & response schemas."""
import re
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator

from app.services.strategy.presets import TEMPLATE_KEYS as STRATEGY_TEMPLATES

# 共用校验规则 / shared validation rules
# 品种：大写字母/数字/点，长度 1-20（含券商后缀）/ symbol: upper-alnum + dot
SYMBOL_PATTERN = r"^[A-Za-z0-9._-]{1,20}$"
# 券商后缀：可空，仅限有限字符集 / broker suffix: optional, limited charset
SUFFIX_PATTERN = r"^[A-Za-z0-9._-]{0,10}$"
# MT5 登录号：纯数字 / MT5 login: digits only
LOGIN_PATTERN = r"^[0-9]{1,20}$"

# 密码的真实长度上限，单位是**字节**不是字符：bcrypt 只看前 72 字节（见
# core/security._to_72），后面的被静默丢弃，于是两个只在第 73 字节之后不同的密码
# 在登录时完全等价。原来只有 max_length=128（按字符算），而 UTF-8 下一个汉字占
# 3 字节 —— 24 个汉字就到顶，用户以为"密码越长越安全"，其实后面全白打。
#
# 只在**设置密码**的入口卡（注册、重置，以及账户设置里的改密码——见
# routers/account.ChangePasswordRequest），登录的 AuthRequest 保持 128 字符不动：
# 存量里可能已经有超过 72 字节的密码，在登录侧收紧会把这些人直接挡在门外，而
# bcrypt 本来就能用前 72 字节验通他们。
#
# 不改哈希方式（例如先 SHA-256 预哈希再 bcrypt）：那能真正支持任意长度，但要给
# 存量哈希做迁移，是另一件事，不该混在一次口径对齐里。
#
# The real password limit, in *bytes* rather than characters: bcrypt reads only
# the first 72 (see core/security._to_72) and silently drops the rest, so two
# passwords differing only past byte 73 are the same password at login. The old
# max_length=128 counted characters, and a CJK character is 3 bytes in UTF-8 — 24
# of them reach the cap, and everything the user types after that does nothing.
#
# Enforced only where a password is *set* (register, reset). Login's AuthRequest
# keeps its 128 characters: existing accounts may already have passwords longer
# than 72 bytes, and tightening the login side would lock those people out of an
# account bcrypt still authenticates from its first 72 bytes.
#
# The hashing itself is left alone (e.g. SHA-256 pre-hashing before bcrypt would
# genuinely support any length): that needs a migration plan for existing hashes
# and doesn't belong in a consistency fix.
MAX_PASSWORD_BYTES = 72


def _validate_password_bytes(v: str) -> str:
    used = len(v.encode("utf-8"))
    if used > MAX_PASSWORD_BYTES:
        raise ValueError(
            f"密码过长：按 UTF-8 编码为 {used} 字节，上限 {MAX_PASSWORD_BYTES} 字节"
            f"（英文数字每个 1 字节，中文每个 3 字节）。超出部分不会生效，请改短一些。"
            f" / Password too long: {used} bytes in UTF-8, limit {MAX_PASSWORD_BYTES}"
            " (1 byte per ASCII character, 3 per CJK character). The excess would be"
            " ignored, so please shorten it."
        )
    return v


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

    # 注册是"设置密码"的入口之一，按字节卡上限（见 MAX_PASSWORD_BYTES）。
    # Registration is one of the set-a-password entry points; capped by bytes.
    @field_validator("password")
    @classmethod
    def _password_within_bcrypt_limit(cls, v: str) -> str:
        return _validate_password_bytes(v)


class ForgotPasswordRequest(BaseModel):
    """申请找回密码。只要邮箱——**故意不要任何别的字段**。

    加上手机号/验证码之类的"二次确认"看着更安全，实际是反的：它把这个接口变成
    一个校验器（"这个邮箱配这个手机号对不对"），而响应无论如何都得保持一致才能
    防枚举，于是那个字段既拦不住攻击者，又让忘了当初填什么号码的真用户彻底进不去。
    """

    email: EmailStr


class ResetPasswordRequest(BaseModel):
    """用邮件里的令牌设置新密码。

    密码规则与 `RegisterRequest` 保持一致（8 字符起、≤72 字节）。不在这里加复杂度
    规则——全站设密码的入口只有三个（注册、这里、账户设置里的改密码），三处规则
    必须一样，否则用户会遇到"注册时能用的密码，重置时被拒"。

    登录的 `AuthRequest` 刻意更松（仍是 128 字符）：那边不是在设密码，收紧只会把
    存量里密码超过 72 字节的用户挡在门外。/ Deliberately looser on the login side.
    """

    token: str = Field(min_length=16, max_length=256)
    password: str = Field(min_length=8, max_length=128)

    # 同注册：这里也是在"设置"一个新密码，按字节卡上限（见 MAX_PASSWORD_BYTES）。
    # Same as registration: a new password is being *set* here, so it's capped by bytes.
    @field_validator("password")
    @classmethod
    def _password_within_bcrypt_limit(cls, v: str) -> str:
        return _validate_password_bytes(v)


class MessageOut(BaseModel):
    """只带一句话的响应。用于那些**刻意不透露结果**的端点。"""

    message: str


class PhoneRequest(BaseModel):
    """补录手机号（Google 注册的用户首次登录后走这条）。字段含义同 RegisterRequest。"""

    phoneCountry: str = Field(min_length=1, max_length=6)
    phone: str = Field(min_length=3, max_length=24)


class ProfilePatchIn(BaseModel):
    """游戏化资料局部更新：全部字段可选，只改传了的那些。

    `equippedBadge` 显式传 null 表示卸下勋章，与「没传」（保持不变）不同——
    用 model_fields_set 区分两者，照 StrategyUpdate 的先例。

    Partial update for the gamification profile: every field is optional and
    only the ones actually sent are changed. `equippedBadge: null` means
    "unequip", distinct from omitting it (leave untouched) — distinguished via
    model_fields_set, matching StrategyUpdate's precedent.
    """

    nickname: str | None = None
    nicknamePublic: bool | None = None
    leaderboardOptOut: bool | None = None
    equippedBadge: str | None = None
    # 有序佩戴列表，首枚为默认；显式传 [] 或 null 都是全部卸下。与 equippedBadge
    # 同时传时以本字段为准（旧前端只会传单枚，语义等价于一枚的列表）。
    # max_length 只是防超大 payload 的粗闸，真正的「最多 3 枚」在处理函数里报 400。
    # Ordered equipped list, first = default; [] or null both mean unequip all.
    # Wins over equippedBadge when both are sent (an old client only ever sends
    # the single field, which is equivalent to a one-item list). max_length is a
    # coarse payload guard; the real "max 3" check raises 400 in the handler.
    equippedBadges: list[str] | None = Field(default=None, max_length=16)
    # 公开主页：允许他人看到综合胜率与考核笔数（2026-09-07）。
    # Public profile: let others see the win rate / trade count (2026-09-07).
    statsPublic: bool | None = None


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
    # 昵称是全员必填（2026-09-10 起）：没设的人一律拦在补全资料页，存量用户也
    # 不豁免——手机号那次靠 phone_required 放过了老用户，这次没有对应的豁免列，
    # 就是「空即欠」。后端算而不是前端判 `!nickname`，理由同上：口径只有一处。
    # Nickname is required of everyone (from 2026-09-10); unlike the phone
    # rollout there is no grandfathering column — empty simply means owed.
    # Computed here rather than as `!nickname` on the client so the rule lives
    # in exactly one place.
    needsNickname: bool = False


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
    # 停用状态。null = 正常；有值 = 已被停用，该账号的所有接口都在返回 403。
    # 与 plan 无关（停用是闸门、plan 是等级，见 models 里 disabled_at 的说明），
    # 所以列表里必须**单独**看得见——只看 plan 的话，一个被封的 PRO 和一个正常的
    # PRO 在管理端长得一模一样。
    # Disabled state; null = normal. Independent of plan (a gate, not a tier —
    # see disabled_at in models), so it has to be visible on its own: judged by
    # plan alone, a banned PRO and an active PRO look identical in the console.
    disabledAt: datetime | None = None
    disabledReason: str | None = None


class AdminUserDisableIn(BaseModel):
    """停用某账号。原因会**原样展示给被停用的用户**（见 deps.get_current_user），
    所以别写内部黑话；留空则用一句通用文案。
    Disabling an account. The reason is echoed verbatim to the user, so keep it
    presentable; empty falls back to a generic sentence."""

    reason: str | None = Field(default=None, max_length=256)


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


class VisibilityPatchIn(BaseModel):
    """游戏化功能对用户端的可见性开关（管理端）。
    Gamification user-facing visibility toggle (admin)."""

    userVisible: bool


class GamificationSettingsPatchIn(BaseModel):
    """游戏化设置组局部更新（管理端）：全部字段可选，只改传了的那些。

    与 `VisibilityPatchIn`（Phase 1 面板，只管 userVisible）并存——两者都
    落到同一份 settings_store 记录，靠 `save_gamification_settings` 的
    读-合并-写语义组合，互不清空对方的键。用 model_fields_set 而非
    `is not None` 判断是否传了某字段，照 ProfilePatchIn 的先例。

    Partial update for the gamification settings group (admin): every field
    is optional, only the ones actually sent are changed. Coexists with
    `VisibilityPatchIn` (the Phase 1 panel, which only knows userVisible) —
    both write to the same settings_store record, composed via
    `save_gamification_settings`'s read-merge-write semantics, so neither
    clobbers the other's keys. Uses model_fields_set rather than `is not
    None` to tell "field sent" from "field absent", matching ProfilePatchIn's
    precedent.
    """

    userVisible: bool | None = None
    leaderboardVisible: bool | None = None
    competitionsVisible: bool | None = None
    minBaselineUsd: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    minTradesReturn: int | None = None
    minTradesWinrate: int | None = None
    winrateRequireProfit: bool | None = None


class CompetitionCreateIn(BaseModel):
    """创建比赛（管理端，Phase 3 §1.7）。语义级校验（metric/enrollment 白名单、
    starts<ends、signup 赛的报名窗口）在路由层做，这里只管字段形状——原因同
    `GamificationSettingsPatchIn` 一带的先例：错误信息要双语，Pydantic 的
    field_validator 报错走的是英文 422，不是这里想要的 400 双语文案。
    """

    name: str
    description: str | None = None
    metric: str
    enrollment: str
    regOpensAt: datetime | None = None
    regClosesAt: datetime | None = None
    startsAt: datetime
    endsAt: datetime
    prizeNote: str | None = None
    # 参赛账户类型（real / demo）与本场专属门槛（留空 = 跟随全局设置）。
    # 语义级校验在路由层（同 metric/enrollment 的先例），这里只管字段形状。
    # Account track (real / demo) and this competition's own gates (omit to follow
    # the global settings). Semantic validation lives in the router, as with
    # metric/enrollment; this only declares the field shapes.
    track: str | None = None
    minBaselineUsd: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    minTrades: int | None = None


class CompetitionPatchIn(BaseModel):
    """编辑比赛（管理端）：全字段可选，用 model_fields_set 判断「传了哪些」——
    draft 状态可改的字段集合与非 draft 状态可改的字段集合不同，路由层要能区分
    「没传」和「传了但值不变」。`status` 单独处理（相邻前进校验），不与其余
    字段的 draft/非 draft 白名单校验混在一起。
    """

    name: str | None = None
    description: str | None = None
    metric: str | None = None
    enrollment: str | None = None
    regOpensAt: datetime | None = None
    regClosesAt: datetime | None = None
    startsAt: datetime | None = None
    endsAt: datetime | None = None
    prizeNote: str | None = None
    status: str | None = None
    # 与创建同义；三者都只在 draft 状态可改（见 _NON_DRAFT_ALLOWED）。
    # Same meaning as on create; all three are draft-only (see _NON_DRAFT_ALLOWED).
    track: str | None = None
    minBaselineUsd: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    minTrades: int | None = None


class CompetitionParticipantPatchIn(BaseModel):
    """取消/恢复参赛资格（管理端）。disqualifyReason 仅在 disqualified=True 时
    落库，恢复资格时路由层清空，不靠前端主动传 null。"""

    disqualified: bool
    disqualifyReason: str | None = None


class CompetitionRegisterIn(BaseModel):
    """比赛报名（用户端）：仅账户号，语义校验（本人名下/实盘/报名窗口）在
    `register_participant` 服务函数里做。"""

    mt5Login: str = Field(pattern=LOGIN_PATTERN)


class AdminBulkUserUpdate(AdminUserUpdate):
    # 目标用户 id 列表；其余字段语义与 AdminUserUpdate 完全一致（仅传要改的字段）。
    # Target user ids; remaining fields behave exactly like AdminUserUpdate
    # (only send the fields you want to change).
    userIds: list[str] = Field(min_length=1, max_length=500)


# ── 管理后台看板 / admin overview dashboard ──────────────────────────────────
# 全部按 STATS_TZ 切天、剔除管理员；"活跃"= 当天打开过任一页面（page_visitor_days）。
# 口径见 docs/superpowers/specs/2026-09-16-admin-overview-dashboard-design.md §3/§5。

class CompareOut(BaseModel):
    current: int
    previous: int  # 紧邻本期之前、等长的对比期 / equal-length window right before


class OverviewRangeOut(BaseModel):
    start: str  # YYYY-MM-DD（STATS_TZ）
    end: str
    days: int
    compareStart: str
    compareEnd: str


class OverviewHeadlineOut(BaseModel):
    totalUsers: int
    activeToday: int   # 今天打开过页面的人 / opened a page today
    activeWeek: int    # 近 7 天 / last 7 days incl. today
    activeMonth: int   # 近 30 天 / last 30 days incl. today
    signups: CompareOut


class ActivityDayOut(BaseModel):
    date: str
    active: int
    signups: int


class FunnelStepsOut(BaseModel):
    """各步独立统计（"至少做过一次"），允许跳步，后一步不保证 ≤ 前一步。
    Independent steps; skipping is allowed so later steps need not be smaller."""
    registered: int
    # 潜在转化客户：还没绑 MT5、但最近一周常来的人。口径见
    # services/admin_overview 的 _potential_window / POTENTIAL_MIN_ACTIVE_DAYS。
    # Warm leads: no MT5 account yet but frequently active in the last week.
    potential: int
    bound: int     # 有 MT5 账号 / has an mt5_accounts row
    boundReal: int  # 其中有真仓（trade_mode == REAL）/ of which linked a real account
    boundDemo: int  # 其中有模拟仓（含比赛仓与未判定）/ of which linked a demo (incl. contest / unclassified)
    traded: int    # 有 FILLED 订单 / has a FILLED order


class FunnelWeekOut(FunnelStepsOut):
    weekStart: str  # 该周周一（STATS_TZ）/ Monday of that week


class FunnelOut(BaseModel):
    overall: FunnelStepsOut
    byWeek: list[FunnelWeekOut]  # 最近 8 周，升序 / last 8 weeks ascending


class PotentialCustomerOut(BaseModel):
    """一名潜在转化客户。带邮箱与手机号是因为这份名单的用途就是主动联系——
    只给人数没法行动；这两个字段管理端「用户管理」页本来就看得到，受众与权限相同。
    One warm lead. Email and phone are included because the whole point of this
    list is outreach; both are already visible on the admin user list."""
    id: str
    email: str
    nickname: str | None = None
    phone: str | None = None
    createdAt: datetime | None = None
    activeDays: int  # 窗口内打开过平台的天数 / days active within the window
    lastActiveDay: str | None = None  # 窗口内最后一次来的日期（STATS_TZ）


class TraderLevelRowOut(BaseModel):
    level: int   # 1~6
    key: str     # novice / junior / elite / senior / chief / legend
    # 当前处于该等级的人数。**不跟时间范围走**——回答"现在盘子长什么样"。
    total: int
    # 在所选时间段内升到该等级的人数。**不是 total 的子集**：本期升到 3 级的人
    # 现在可能已经是 4 级。/ Flow in the period, not a subset of the stock.
    reachedInRange: int


class AdminTraderLevelsOut(BaseModel):
    rangeStart: str
    rangeEnd: str
    totalUsers: int              # 非管理员用户总数，六级人数之和
    levels: list[TraderLevelRowOut]   # 1 级到 6 级，定长 6


class TraderLevelUserOut(BaseModel):
    id: str
    email: str
    nickname: str | None = None
    phone: str | None = None
    # 该用户**现在**的等级。scope=range 的名单里可能已经高于所查的那一级。
    currentLevel: int
    # 升到所查等级的时刻（UTC，精确到微秒；前端按秒显示）。
    reachedAt: datetime | None = None
    createdAt: datetime | None = None


class AdminTraderLevelUsersOut(BaseModel):
    level: int
    key: str
    scope: str        # all = 当前在这一级；range = 本期升到这一级
    rangeStart: str
    rangeEnd: str
    total: int        # 该 scope 下的总人数，可能大于 users 长度（受 limit 截断）
    users: list[TraderLevelUserOut]   # 达成时间倒序


class AdminPotentialCustomersOut(BaseModel):
    # 本周已过的天数（含今天）。**不是固定值**：周一是 1、周日是 7。低于
    # minActiveDays 时（周一 / 周二）名单必然为空，前端要照实说明而不是显示"没有"。
    # Days elapsed this week including today — 1 on Monday, 7 on Sunday. Below
    # minActiveDays the list is necessarily empty and the UI must say why.
    windowDays: int
    minActiveDays: int   # 门槛：本周内至少活跃这么多天 / minimum active days this week
    windowFrom: str      # 本周周一（STATS_TZ）/ Monday of this week
    # 符合条件的总人数。**可能大于 users 的长度**（受 limit 截断），前端要照实说明。
    # Total matching users; may exceed len(users) because of the limit.
    total: int
    users: list[PotentialCustomerOut]  # 活跃天数降序，同数按注册时间倒序


class RetentionPointOut(BaseModel):
    rate: float | None  # cohort 为空时 None / None when the cohort is empty
    cohortSize: int
    cohortFrom: str | None  # cohort 内最早/最晚注册日 / earliest & latest signup day in cohort
    cohortTo: str | None


class RetentionOut(BaseModel):
    d2: RetentionPointOut
    d7: RetentionPointOut
    d30: RetentionPointOut


class StrategyUsageOut(BaseModel):
    template: str      # 预设键；无模板归 "custom" / preset key or "custom"
    users: int         # 建过 / created at least one
    enabledUsers: int  # 当前启用中 / currently enabled


class TradingDayOut(BaseModel):
    date: str
    fills: int


class TradingOut(BaseModel):
    traders: CompareOut  # 有成交的人数 / distinct users with a fill
    fills: CompareOut    # 成交笔数 / fill count
    daily: list[TradingDayOut]


class AdminOverviewOut(BaseModel):
    range: OverviewRangeOut
    headline: OverviewHeadlineOut
    activityDaily: list[ActivityDayOut]
    funnel: FunnelOut
    retention: RetentionOut
    plans: dict[str, int]  # FREE / PRO_PAID / PRO_TRIAL（其它等级原样）
    strategies: list[StrategyUsageOut]
    trading: TradingOut
    visitorDataSince: str | None  # 最早一条访问标记（STATS_TZ 日期）；没有数据则 None
    # / earliest page_visitor_days marker (STATS_TZ date); None if the table is empty


class PageViewIn(BaseModel):
    """页面访问上报体。seconds 是本次在该页的停留秒数。

    上限交给路由层的 MAX_DWELL_SECONDS 截断而不在这里用 le= 卡死：超限是
    "挂着页面没看"这种正常现象，按上限计入即可，不该让整个请求 422 失败而
    丢掉这一次访问计数。负数则直接归零。

    Page-view report body; seconds is the dwell time on that page this visit.
    The cap is applied by the router's MAX_DWELL_SECONDS rather than a le=
    constraint here: exceeding it means "tab left open", a normal occurrence
    that should be clamped and counted, not 422'd into losing the view entirely.
    负数与 NaN/Inf 则在这里就拒掉。两者的区别在于"是不是可能真的发生"：挂着页面
    不看是常态，负的或非数值的停留时间没有任何合法产生路径，只能来自坏客户端或
    刻意构造。而 NaN 尤其必须拦在入口——夹取对它无效（`max(nan, 0.0)` 仍是 nan），
    累加进小时桶后 `total_seconds` 永久变成 NaN，均值与全站均值跟着 NaN，看板吐出
    的 JSON 连合法都不是，且随桶累加无法自愈，只能手工改库。

    Negatives and NaN/Inf are rejected here instead. The difference from the cap is
    whether the value can legitimately occur: a tab left open is normal, a negative
    or non-numeric dwell time has no legitimate origin. NaN in particular has to be
    stopped at the door — clamping doesn't touch it (`max(nan, 0.0)` is still nan),
    and once added to an hourly bucket that bucket's total_seconds is permanently
    NaN, taking the per-page and site-wide averages with it, emitting invalid JSON,
    and never recovering on its own.
    """
    path: str = Field(max_length=200)
    seconds: float = Field(ge=0, allow_inf_nan=False)


class PageDayPointOut(BaseModel):
    """某页面某一天的三个指标。没有数据的日期也会返回（三项全为 0），
    因为折线图需要连续的日期轴，缺日期会被画成直线跨过去。

    One day's three metrics for a page. Days with no data are still returned
    (all zeros): the line chart needs a contiguous date axis, and a missing day
    would be drawn as a straight line across the gap.
    """

    date: str  # ISO 日期 YYYY-MM-DD（STATS_TZ）
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
    start: str  # 范围起止（STATS_TZ 日期）/ range bounds
    end: str
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


class AdminSocialSettings(BaseModel):
    """官方社交主页地址（管理后台读写用同一形状）。

    五个字段各自独立，留空 = 不展示该平台的入口。校验只认 http(s)：这些值
    会直接变成页面上的 href，`javascript:` 之类的协议必须挡在写入之前（读取
    侧还有一道，见 settings_store._load_social_from_db）。

    Official social links (same shape for admin read & write). Each field is
    independent; empty means that platform gets no entry point. Only http(s)
    passes validation — these become hrefs, so schemes like `javascript:` are
    rejected at write time (and again on read, see settings_store).
    """

    facebookUrl: str = Field(default="", max_length=512)
    instagramUrl: str = Field(default="", max_length=512)
    xUrl: str = Field(default="", max_length=512)
    discordUrl: str = Field(default="", max_length=512)
    telegramUrl: str = Field(default="", max_length=512)

    @field_validator("facebookUrl", "instagramUrl", "xUrl", "discordUrl", "telegramUrl")
    @classmethod
    def _http_only(cls, v: str) -> str:
        v = (v or "").strip()
        if v and not re.match(r"^https?://", v, re.IGNORECASE):
            raise ValueError("链接必须以 http(s):// 开头 / link must start with http(s)://")
        return v


class AdminEmailGateSettings(BaseModel):
    """一次性邮箱闸门设置（管理后台读写用同一形状）。

    两个增补名单是「在内置规则之外」的手工干预，不是内置规则的副本：内置放行表
    （services/email_domains.ALLOW_DOMAINS）和打包的黑名单快照都在代码里，后台
    看不到也改不了。这么分是故意的——国内主流邮箱的放行不该依赖某次后台操作
    没被人误删。

    条目在写入前统一规范化（小写、去掉粘贴时常带的 @ 前缀与结尾的点），并去重。
    非法条目直接丢弃而不是报错：管理员在一个多行输入框里贴一串域名，为其中一行
    的空白或笔误让整次保存失败，只会让人改半天不知道错在哪。

    Disposable-email gate settings (same shape for admin read & write). The two
    supplementary lists sit *on top of* the built-in rules rather than replacing
    them: the allowlist and the vendored blocklist live in code, invisible and
    unremovable from the panel — deliberately, so that letting Chinese mailboxes
    through never depends on an admin action not being undone. Entries are
    normalised and de-duplicated on write; malformed ones are dropped rather than
    failing the whole save, since these are pasted in bulk into a textarea.
    """

    disposableBlockEnabled: bool = True
    extraBlockedDomains: list[str] = Field(default_factory=list, max_length=500)
    extraAllowedDomains: list[str] = Field(default_factory=list, max_length=500)

    @field_validator("extraBlockedDomains", "extraAllowedDomains")
    @classmethod
    def _clean_domains(cls, v: list[str]) -> list[str]:
        from app.services.email_domains import normalize_domain

        out: list[str] = []
        for raw in v or []:
            d = normalize_domain(str(raw)[:253])
            if d and d not in out:
                out.append(d)
        return out


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




# ---------- 公告 / Announcements ----------
# 正文块直接复用 PlatformStrategyBlock：四种类型、camelCase 字段、同一套校验，
# 管理端的块编辑器与用户端的渲染器也因此可以原样复用。
# The body reuses PlatformStrategyBlock: same four kinds, same camelCase fields and
# validation, so the admin block editor and the user-side renderer carry over as is.
AnnouncementBlock = PlatformStrategyBlock


class AnnouncementIn(BaseModel):
    """管理员新建 / 修改公告的请求体 / admin create-or-update payload."""

    titleZh: str = Field(default="", max_length=120)
    titleEn: str = Field(default="", max_length=120)
    summaryZh: str = Field(default="", max_length=300)
    summaryEn: str = Field(default="", max_length=300)
    blocks: list[AnnouncementBlock] = Field(default_factory=list, max_length=60)
    coverImageUrl: str = Field(default="", max_length=500)
    pinned: bool = False
    published: bool = False
    # 弹窗展示：发布后给用户弹一张整图卡片。没有封面图就没有弹窗——弹窗主体就是
    # 那张图，所以这里直接把"勾了但没图"归一成 False，而不是留给取弹窗的查询去
    # 兜底：让库里的值自己就是真话，管理页重新打开时看到的开关才与实际行为一致。
    # Show as a popup after publishing. No cover image, no popup — the image *is*
    # the popup — so "ticked without an image" is normalised to False right here
    # instead of being filtered out later by the query: the stored value stays
    # truthful, and the toggle the admin sees on reopening matches reality.
    popup: bool = False
    # 发布时是否给开启了推送的用户发一条 Web Push；只在本次请求把 published 由
    # false 翻到 true 时生效，编辑已发布的公告不会再推。
    # Whether to Web Push subscribed users on publish; only acts when this request
    # flips published from false to true, never on edits of an already-published one.
    notify: bool = False

    @field_validator("coverImageUrl")
    @classmethod
    def _cover_http_only(cls, v: str) -> str:
        v = (v or "").strip()
        if v and not re.match(r"^https?://", v, re.IGNORECASE):
            raise ValueError("图片地址必须以 http(s):// 开头 / image URL must start with http(s)://")
        return v

    @model_validator(mode="after")
    def _popup_needs_cover(self) -> "AnnouncementIn":
        if self.popup and not self.coverImageUrl:
            self.popup = False
        return self


class AnnouncementOut(BaseModel):
    """公告（用户端与管理端共用；read 只对用户端有意义）。
    One announcement (shared by both sides; `read` is meaningful to users only)."""

    id: str
    titleZh: str
    titleEn: str
    summaryZh: str
    summaryEn: str
    blocks: list[AnnouncementBlock]
    coverImageUrl: str
    pinned: bool
    published: bool
    popup: bool = False
    publishedAt: datetime | None
    createdAt: datetime
    updatedAt: datetime
    read: bool = True


class AnnouncementListOut(BaseModel):
    """公告清单 + 未读数 / list plus unread count."""

    items: list[AnnouncementOut]
    unreadCount: int = 0
    total: int = 0


class AnnouncementPopupOut(BaseModel):
    """当前该弹的那条公告；没有就整个响应为 null。
    只带渲染弹窗要用的字段——弹窗里除了图就是标题，正文块留给详情页。
    The one announcement to pop right now, or a null response. Carries only what
    the modal renders (image plus title); the body blocks belong to the detail page."""

    id: str
    titleZh: str
    titleEn: str
    coverImageUrl: str


# ---------- 站内通知 / in-app notifications ----------


class NotificationFeedItem(BaseModel):
    """一条站内通知。title 不在这里——前端按 kind 取 i18n 文案，见
    models.UserNotification 的说明。
    One in-app notification. No title field: the frontend renders it from `kind`
    via i18n (see models.UserNotification)."""

    id: str
    kind: str
    text: str
    link: str
    read: bool
    createdAt: datetime


class NotificationFeedOut(BaseModel):
    items: list[NotificationFeedItem]
    unreadCount: int = 0


class ReadAllOut(BaseModel):
    """一键已读的结果：分别报公告与站内通知各清掉了多少条。
    Mark-all-read result, counted separately for announcements and notifications."""

    announcements: int = 0
    notifications: int = 0


class TranslateIn(BaseModel):
    """管理员一键翻译：一批文本按顺序译为目标语言。
    Admin one-click translation: a batch of strings translated in order."""

    texts: list[str] = Field(min_length=1, max_length=80)
    target: Literal["en", "zh"] = "en"

    @field_validator("texts")
    @classmethod
    def _cap_each(cls, v: list[str]) -> list[str]:
        if any(len(t) > 4000 for t in v):
            raise ValueError("单段文本不能超过 4000 字 / each text must be 4000 chars or fewer")
        return v


class TranslateOut(BaseModel):
    texts: list[str]


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
    # 已用保证金（账户货币）。网页端拿它和 equity 算保证金比例；None = 还没刷新过
    # 或桥接版本太旧没上报，前端显示「—」，不要当成 0。
    # Margin in use; the web app derives the margin level from it and equity.
    # None = never refreshed / bridge too old to report it — render as "—", not 0.
    margin: float | None = None
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
    # 账户类型：0=模拟，1=竞赛，2=实盘，None=尚未判定（见 services/account_type.py）。
    # 消费方（如比赛报名选择器）必须把 None 当"非实盘"处理，不能默认放行。
    # Account trade mode: 0=demo, 1=contest, 2=real, None=not yet determined
    # (see services/account_type.py). Consumers (e.g. the competition
    # registration picker) must treat None as "not real", never default-allow.
    tradeMode: int | None = None


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
    stopLoss: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    takeProfit: float | None = Field(default=None, ge=0, allow_inf_nan=False)


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
    stopLoss: float = Field(default=0.0, ge=0, allow_inf_nan=False)
    takeProfit: float = Field(default=0.0, ge=0, allow_inf_nan=False)


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
    # 被指派为这条链接「代理」的用户（见 InviteLinkAgent 模型注释）。
    # Users assigned as this link's agents (see the InviteLinkAgent model).
    agents: list["InviteLinkAgentOut"] = []


class InviteLinkAgentOut(BaseModel):
    userId: str
    email: str
    nickname: str | None = None
    assignedAt: datetime | None = None


class InviteLinkAssignAgent(BaseModel):
    userId: str = Field(min_length=1, max_length=64)


# ---------- 代理页 / Agent view ----------
class AgentLinkOut(BaseModel):
    """代理看到的一条链接。刻意**不含** grantsTrial：送不送试用是管理员与全局总闸
    之间的事，代理只需要知道链接是否还在用。
    One link as seen by its agent. grantsTrial is deliberately absent: whether a
    link grants trials is between the admin and the global gate; the agent only
    needs to know whether the link is still live."""
    id: str
    code: str
    label: str
    clicks: int
    registrations: int = 0
    # 经此链接注册的人里，近 7 天（含今天，按 STATS_TZ 切天）打开过任一页面的人数。
    # 口径与管理看板完全一致（page_visitor_days 有行 = 活跃），刻意不用
    # users.last_active_at：那一列任何带凭证的请求都会打（App 在后台静默刷数据也
    # 算），拿它报给代理会把"手机装着没卸载"说成"还在用"。
    # Distinct people among this link's signups who opened any page in the last 7
    # days (today included, STATS_TZ). Same definition as the admin dashboard (a
    # page_visitor_days row = active); deliberately not users.last_active_at,
    # which any authenticated request bumps — including the app's background
    # refreshes — and would report "app still installed" as "still using it".
    activeUsers7d: int = 0
    # 经此链接注册的人里，至少还有一个有效 MT5 绑定的人数（已撤销的绑定不算，
    # 见 MT5Account.revoked_at）。数的是**人**不是账号：一个人绑两个账号仍是 1。
    # People with at least one live MT5 binding (revoked ones excluded). Counts
    # people, not accounts: two accounts on one person is still 1.
    mt5Users: int = 0
    isActive: bool
    createdAt: datetime | None = None


class AgentMT5AccountOut(BaseModel):
    """代理名单里的一个 MT5 绑定：打码账号号、服务器、实盘/模拟、还连不连得上。

    账号号打码（`identity.mask_account`，123**678）与排行榜同一口径：代理需要能对
    上"这个人到底绑没绑、绑的是不是实盘"，不需要能原样抄走别人的交易账户号。

    **资金一概不下发**——余额、净值、杠杆、保证金都不在这里。用户绑定 MT5 是为了
    跟单，从没被告知过自己的资金规模会给推荐人看；这条线一旦开了就收不回来。

    **只说"连没连上"，不说通道、不说瞬时在线、不说最近连接时刻**（2026-09-19 定）。
    前一版按通道分了「直连 · 已接入 / 桥接 · 在线 / 最近连接 X」等五六种说法，负责
    人的判断是代理用不上这些：他要的只是"这个人接进来了没有"。那些区分本身也是
    麻烦的来源——桥接的在线随客户关电脑闪烁，直连的"在线"其实是平台自己那台网关的
    健康状态、全站共享（写在客户那一行上等于把平台抖动说成客户掉线）。都删掉了，
    别再加回来；要加先想清楚代理拿它去做什么。

    One MT5 binding on an agent's list: masked login, server, real/demo, and
    whether it is usable. No balance, equity, leverage or margin is ever
    included: users bound MT5 to copy trades and were never told their account
    size would be shown to whoever referred them.

    It reports connected-or-not and nothing else — no channel, no live/offline,
    no last-seen timestamp (product decision, 2026-09-19). The previous cut split
    those five ways by channel; an agent only needs "did this person get set up".
    The distinctions were also the problem: a bridge account's online state
    flickers as the client closes their laptop, and a gateway account's "online"
    is really the platform's own gateway health, shared site-wide, which printed
    on a client's row turns a platform blip into a client walking away.
    """
    # 打码后的账户号 / masked account number
    login: str
    # 券商服务器名（如 "Broker-Real 3"）；未上报为 null / broker server name
    server: str | None = None
    # 'real' / 'demo' / 'contest' / null（未判定）。由 MT5Account.trade_mode 映射，
    # 不下发 trade_mode_source：「自报还是券商判的」是风控口径，代理看了只会误读。
    # Mapped from trade_mode; trade_mode_source is withheld — self-reported vs
    # broker-derived is a risk-control distinction an agent would misread.
    accountType: Literal["real", "demo", "contest"] | None = None
    # 这条绑定此刻还能不能跟单。直连 = 授权未作废（作废的原因是券商侧改过密码，
    # 要客户重新验证一次主密码，见 services/gateway_binding）；桥接 = 绑定还在
    # （软删的行根本不下发，见 invite._mt5_accounts）。
    #
    # False 的行仍然列出、由前端压灰标「未连接」，不是隐藏：跟能用的账号长得一样
    # 会让代理以为客户在跟单，其实没有。
    #
    # Whether this binding can currently copy trades: gateway = authorisation not
    # revoked; bridge = the binding still exists (soft-removed rows are never
    # sent at all). False rows are still listed and greyed out rather than
    # hidden — looking identical to a working account would have the agent
    # believe their client is trading when they are not.
    connected: bool = True


class AgentLinkUserOut(BaseModel):
    """代理名单里的一个用户：昵称、邮箱、等级、注册时间、最近活跃日、MT5 绑定。

    邮箱给完整值（2026-09-15 产品决定，此前是打码的 `ab***@域名`）：代理要能联系
    到自己带来的人，打码等于这一列没用。**手机号与用户 id 仍然不给**——手机号是
    另一个量级的个人信息，id 则是能拿去撞其他接口的标识，代理页一个都用不上。

    2026-09-19 加了活跃与 MT5 两块（产品决定）。加的时候守住两条线，后来者别越过：
    活跃只到天、不到时刻（源表本来就只存到天），MT5 只说"绑没绑、是不是实盘、还
    连不连得上"、不说钱。判断新字段该不该加的标准是"代理拿它去做什么"：提醒人
    重连、跟进不活跃的人，都用不到精确到分钟的行踪或对方的账户余额。

    One user on an agent's list: nickname, email, tier, signup time, last active
    day and MT5 bindings. The email is real (product decision, 2026-09-15) so the
    agent can reach the people they brought in; phone and user id stay withheld.
    Activity and MT5 were added on 2026-09-19 with two lines held that later
    changes should not cross: activity is day-granular only, and MT5 says whether
    an account is bound, real, and reachable — never how much money is in it. The
    test for a new field is what the agent would *do* with it; nudging someone to
    reconnect needs neither minute-level whereabouts nor their balance."""
    nickname: str | None = None
    email: str
    plan: str
    createdAt: datetime | None = None
    # 会员到期时间；FREE 或不限期都是 null。代理能改到期日（见 AgentPlanUpdate），
    # 不下发这一列他就看不到自己改成了什么。
    # Membership expiry; null for FREE and for never-expiring grants alike.
    # Shipped because agents can change it and need to see the result.
    planExpiresAt: datetime | None = None
    # 最近活跃日（STATS_TZ 日期，口径同 activeUsers7d）。**只到天**，不给时刻：
    # page_visitor_days 本来就只存到天，正是为了让"某人几点在看哪个页面"这种问题
    # 在结构上问不出来（见该模型注释）。超过 400 天的记录会被清理，故老用户可能为 null。
    # Last active day (STATS_TZ). Day granularity only, by construction: the
    # source table stores no hour and no dwell time so that "what was this person
    # looking at at 3pm" cannot be asked. Rows older than 400 days are pruned.
    lastActiveDay: date | None = None
    # 该用户名下的 MT5 绑定，能用的在前。空数组 = 从未绑过（前端显示「未连接」）。
    # This user's MT5 bindings, usable ones first. Empty = never bound.
    mt5Accounts: list[AgentMT5AccountOut] = []


class AgentLinkUsersOut(BaseModel):
    users: list[AgentLinkUserOut]
    total: int
    limit: int
    offset: int


class AgentOverviewOut(BaseModel):
    """代理看板：与管理看板同一套口径，只是把范围收在「这条链接带来的人」上。

    字段类型直接复用管理看板的（OverviewRangeOut / OverviewHeadlineOut /
    ActivityDayOut），数字也由同一批函数算出（services/admin_overview 的
    headline / activity_daily，多传一个 scope 条件）。两边共用的理由见那个模块
    顶部：代理页另写一份查询，"活跃"迟早会漂成两个意思，而页面上看不出来。

    刻意**不含**漏斗、留存、等级分布、策略与交易使用——那些是运营看全站用的，
    代理拿不到也用不上。

    The agent dashboard: the admin dashboard's semantics, scoped to the people
    one link brought in. Same types and the same functions produce the numbers
    (with one extra scope filter), because a second copy would drift. Funnel,
    retention, plan mix, strategy and trading usage are deliberately absent.
    """
    range: OverviewRangeOut
    headline: OverviewHeadlineOut
    activity: list[ActivityDayOut]


class AgentPlanUpdate(BaseModel):
    """代理调整自己名下某个客户的会员：延长 PRO，或降回 FREE。

    用邮箱定位而不是 user id：名单里本来就有完整邮箱（2026-09-15 定），而 user id
    至今没下发过，为了一个写操作把它放出去不值当——服务端按 (链接, 邮箱) 查人，
    查不到就是 404，和"不是你的人"同一个回答。

    Identifies the target by email rather than user id: the list already shows
    the real email, and shipping ids just to enable one write is not worth it.
    The server resolves (link, email) and answers 404 either way.
    """
    email: EmailStr
    # extend = 在现有到期日（已过期或 FREE 则从此刻）基础上往后加 days 天，并置为 PRO；
    # downgrade = 直接降回 FREE 并清空到期日。
    # extend adds days on top of the current expiry (or now, if lapsed/FREE) and
    # sets PRO; downgrade drops to FREE and clears the expiry.
    action: Literal["extend", "downgrade"]
    # 单次延长上限 60 天（产品决定，2026-09-19）。要开一年就点六次——**这正是
    # 想要的摩擦**：防的是一次点出 2099 年，而不是防长期客户。
    # Hard cap of 60 days per call (product decision). A year takes six clicks;
    # the friction is the point — it stops a single click reaching year 2099.
    days: int | None = Field(default=None, ge=1, le=60)
