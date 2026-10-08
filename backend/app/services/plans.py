"""订阅等级规则：集中一处判断"这个等级能不能做 X"，不要散落在各路由里。
Subscription plan rules: one place to decide "can this plan do X", instead of
scattering `if user.plan == "PRO"` checks across routers.

两级制 / Two tiers:
- FREE：信任层——延迟信号、公开胜率，几乎不能实操。
- PRO：完整核心体验（实时信号、一键下单、推送、个人胜率）+ MT5 账户数不限；
  未来的高级权益（新品种优先等）也挂这里。管理后台手动升级。

- FREE: the trust layer — delayed signals and the public win rate, little else.
- PRO: the full core experience (real-time signals, one-click trading, push,
  personal win rate) + unlimited MT5 accounts; future premium perks
  (e.g. early access to new symbols) attach here too. Granted manually from
  the admin panel.

旧等级（BETA/PARTNER/ELITE/PLUS）已合并，历史数据由 database._migrate_columns
自动映射：BETA→PRO，PLUS→PRO，PARTNER→PRO，ELITE→PRO。
Legacy tiers (BETA/PARTNER/ELITE/PLUS) were merged; existing rows are remapped
automatically in database._migrate_columns: BETA→PRO, PLUS→PRO, PARTNER→PRO, ELITE→PRO.
"""

from datetime import datetime, timedelta, timezone

# 每个付费套餐买到的天数。放在这里而不是 routers/payments.py：除了下单与入账，
# 「这笔付费到今天还在不在有效期内」也要用它（代理降级前的付费保护，见
# routers/invite.py），而那是另一个 router——router 之间互相 import 正是
# services/pagination.py 顶部那段说明要消灭的东西。
# Days bought by each paid plan. Kept here rather than in routers/payments.py
# because "is this payment still inside its window" is also asked from another
# router (the paid-customer guard in routers/invite.py), and router-to-router
# imports are exactly what services/pagination.py's note is about.
PLAN_DAYS: dict[str, int] = {"pro_monthly": 30, "pro_yearly": 365}


def is_plan_expired(plan: str | None, expires_at: datetime | None, now: datetime | None = None) -> bool:
    """付费等级是否已过期。FREE 无所谓到期；expires_at 为空表示永久（内测/赠送）。
    纯判定，不碰数据库；实际的落库降级见 services/plan_expiry.py。

    Whether a paid plan has expired. FREE has no expiry; a null expires_at
    means "never" (beta/comp grants). Pure predicate, no DB — the persisted
    downgrade lives in services/plan_expiry.py.
    """
    if plan is None or plan == "FREE" or expires_at is None:
        return False
    if now is None:
        now = datetime.now(timezone.utc)
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    return expires_at < now


# 退款收回权益时「跳过不动」的几种理由。写成常量而不是裸字符串：它们会原样进
# AdminAuditLog.new_value，是人工复核退款时唯一能看到的判定依据，拼错一个字母
# 就等于把审计行变成噪音。
# Reasons a refund revokes nothing. Constants rather than bare strings because
# they go verbatim into AdminAuditLog.new_value and are the only trace a human
# reviewing a refund can read; a typo turns the audit row into noise.
REFUND_SKIP_NOT_PAID = "skip:not_paid"        # 当前已不是 PRO，没有可收回的东西
REFUND_SKIP_PERMANENT = "skip:permanent_pro"  # 不限期 PRO，见下面的理由
REFUND_SKIP_TRIAL = "skip:trial_plan"         # 当前 PRO 是试用，不是这笔钱买的
REFUND_SKIP_NO_DAYS = "skip:no_days"          # 套餐天数非正（理论上不该发生）


def refund_revocation(
    plan: str | None,
    plan_expires_at: datetime | None,
    plan_is_trial: bool,
    days: int,
    entitlement_floor: datetime | None = None,
    now: datetime | None = None,
) -> tuple[str | None, str | None, datetime | None]:
    """一笔已入账的付款被退款后，用户的等级/到期时间应该变成什么。

    返回 `(跳过原因, 新等级, 新到期时间)`：跳过原因非 None 时**一个字段都不要动**，
    后两项无意义；为 None 时按后两项落库。纯判定，不碰数据库（同 is_plan_expired），
    落库与审计在 routers/payments.py。

    ── 为什么是「减天数」而不是「设成 FREE」 ──
    入账那一段（payments._sync_payment_status）做的是 `到期 = max(现有到期, 此刻)
    + 套餐天数`，也就是**在已有窗口上追加**。所以这笔钱给出的权益就是那段
    `days`，把它减掉才是精确的逆操作。直接设 FREE 会连同「退款之前就买好的续费」
    「管理员赠送的到期日」「后面又付的那一笔」一起抹掉——**误扣一个正常付费用户
    的权益，比晚几天收回一个退款用户的权益严重得多**，所以这里宁可少扣。

    ── entitlement_floor 是干什么的 ──
    减天数在「叠加续费」下是准确的，但有一种情况不是：用户的会员**断档过**，后
    来又付了一笔，那笔是从「此刻」重新起算的，现在的到期时间里根本不含这笔被退
    款的天数，再减一次就是从后面那笔身上割肉。调用方按「每笔已完成付款的
    finished_at + 套餐天数」算出**别的付款单独就能保证的最晚到期时间**传进来
    （与 routers/invite._has_live_paid_plan 判定「这笔钱买到的窗口」用的是同一个
    公式），这里取它与减完之后的较晚者做下限。断档重付时下限正好等于当前到期
    时间，于是这笔退款一天都扣不到——这正是我们要的。

    ── 不限期 PRO（plan_expires_at IS NULL）为什么原样不动 ──
    那是内测/合作赠送，不是这笔钱买的：入账那一段对这类用户走的就是 `pass`
    分支（付款不能把「永久」改成有期限），下单那一步更是直接 409 挡掉。既然
    这笔钱当初什么都没给出，退款自然也没有东西可以收回。而如果是**付款之后**
    管理员才赠的永久 PRO，减天数就更不能做了——NULL 没法减，硬降级等于替管理员
    撤销一个他刚做的决定。两种情况都留给人工看（调用方照旧写 error 日志 + 审计）。

    What the user's plan/expiry must become after an already-credited payment is
    refunded. Returns (skip_reason, plan, expires_at); a non-None reason means
    change nothing. Pure predicate, no DB (like is_plan_expired).

    Crediting appends `days` to the later of the current expiry and now, so
    subtracting `days` is the exact inverse; setting FREE outright would also
    wipe renewals bought before this one, admin-granted expiries and any later
    payment. Wrongly stripping a paying customer is far worse than reclaiming a
    refunder's days a few days late, so this errs towards under-revoking.

    entitlement_floor covers the one case subtraction gets wrong: if the
    membership lapsed and was re-bought, the later payment restarted from "now"
    and the current expiry no longer contains these days — subtracting would eat
    into that payment. The caller passes the latest expiry that *other* finished
    payments guarantee on their own (finished_at + plan days, the same formula
    invite._has_live_paid_plan uses), and it acts as a floor.

    Permanent PRO (null expiry) is left completely alone: it is a comp grant this
    money never bought (crediting takes the `pass` branch, ordering is refused
    with a 409), and if an admin granted it *after* the payment, downgrading
    would silently undo their decision. Either way it is a case for a human.
    """
    if plan != "PRO":
        # 已经是 FREE（管理员先降过、或到期扫描已经收走了）：没有可收回的权益。
        # Already FREE (admin got there first, or the expiry sweep did): nothing
        # left to take back.
        return REFUND_SKIP_NOT_PAID, None, None
    if plan_is_trial:
        # 当前这个 PRO 是试用身份。付费入账会把 plan_is_trial 清成 False，所以这里
        # 为 True 说明现在的权益不是这笔钱给的（只可能是事后有人另外赋予的）。
        # 不知道它从哪来就不动它。
        # The current PRO is flagged as a trial. Crediting clears that flag, so a
        # True here means today's entitlement did not come from this money; don't
        # touch what we can't account for.
        return REFUND_SKIP_TRIAL, None, None
    if plan_expires_at is None:
        return REFUND_SKIP_PERMANENT, None, None
    if days <= 0:
        return REFUND_SKIP_NO_DAYS, None, None

    if now is None:
        now = datetime.now(timezone.utc)
    expires = plan_expires_at if plan_expires_at.tzinfo else plan_expires_at.replace(tzinfo=timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)

    target = expires - timedelta(days=days)
    if entitlement_floor is not None:
        floor = entitlement_floor if entitlement_floor.tzinfo else entitlement_floor.replace(tzinfo=timezone.utc)
        if floor > target:
            target = floor
    if target > expires:
        # 下限比现有到期还晚时不顺势延长：退款是收回，任何情况下都不该变成赠送。
        # Never extend past today's expiry: a refund takes away; under no
        # circumstance may it hand out time.
        target = expires

    if target <= now:
        # 这笔钱买的窗口已经被收干净，人也没有别的权益兜底 → 落回 FREE。
        # 到期时间一并清空，理由同 plan_expiry.downgrade_if_expired：留着一个过去的
        # 时间戳，会让管理员将来重新升级却忘了改到期时间的人当场再次过期。
        # The window this money bought is fully reclaimed and nothing else covers
        # the user → back to FREE, clearing the expiry for the same reason
        # plan_expiry.downgrade_if_expired does: a stale past timestamp would
        # instantly re-expire anyone an admin later re-upgrades without setting one.
        return None, "FREE", None
    return None, "PRO", target


def trial_grant_days(db) -> int | None:
    """全局试用总闸此刻能发几天；不发（关着或天数非正）返回 None。

    发放试用有两条路——注册时带 ref（routers/invite.apply_invite）和登录后自己领
    （routers/payments.claim_trial）——它们此前各读各的 platform_settings，只有前者
    判了 `trial_days <= 0`。天数被手改成 0 时（管理端 schema 卡了 ge=1，但
    platform_settings 是能直接改库的），后者会照发不误：plan_expires_at 设成"此刻"，
    用户唯一一次试用当场烧掉却立刻到期，而 trial_used_at 已经写上了——不可逆。

    两条路合流到这一处判定，就不会再出现"一条改了、另一条忘了"的分叉。天数为 0
    时下游三个消费方（apply_invite、claim_trial、前端的 `if (r.trialDays)`）本来
    就全都当成"没有活动"，只有旧的 claim_trial 例外。

    How many trial days the global switch grants right now, or None. The two
    granting paths (invite-time and self-claim) each read the settings
    themselves, and only the first checked for a non-positive day count — so a
    hand-edited 0 let the self-claim burn a user's one-time trial on a
    membership that expired the instant it was granted, with trial_used_at
    already stamped. One decision point, so the two can't diverge again.
    """
    from app.services.settings_store import get_trial_settings

    trial = get_trial_settings(db)
    if not trial["trial_enabled"]:
        return None
    days = int(trial["trial_days"])
    if days <= 0:
        return None
    return days


def is_realtime_plan(plan: str | None) -> bool:
    """该等级是否享有实时信号（FREE 之外全部实时）。
    Whether this plan gets real-time signals (everyone except FREE)."""
    return plan != "FREE"


# 每个等级最多可连接的 MT5 账户数；None 表示不限。
# Max MT5 accounts per plan; None means unlimited.
ACCOUNT_LIMITS: dict[str, int | None] = {
    "FREE": 1,
    "PRO": None,
}


def max_mt5_accounts(plan: str | None) -> int | None:
    """该等级最多可连接的 MT5 账户数；None 表示不限。未知等级按 FREE 处理。
    Max MT5 accounts for this plan; None means unlimited. Unknown plans fall
    back to the FREE limit."""
    return ACCOUNT_LIMITS.get(plan or "FREE", ACCOUNT_LIMITS["FREE"])

# FREE 额外的「直连模拟」名额（设计 2026-10-08 §1.10）：FREE 可绑 1 个任意账户 + 额外 1 个
# 直连（gateway）且经券商组判定为 DEMO/CONTEST 的账户——让免费用户能拿模拟户参加模拟赛，
# 又不必先删掉自己的实盘。只认 gateway：组名来自券商、用户碰不到；桥接的 trade_mode 是
# 自报的，给它额外名额等于让任何人自称模拟就多绑一个。报名发生在绑定之后，绑定时
# 不知道会不会报名，所以不加「已报名比赛」条件。
# FREE's extra direct-connect demo slot (§1.10): one gateway account whose
# broker group classifies as DEMO/CONTEST doesn't count against the limit.
# Gateway only — the bridge's trade_mode is self-reported.
EXTRA_DEMO_SLOTS: dict[str, int] = {
    "FREE": 1,
    "PRO": 0,
}


def extra_demo_slots(plan: str | None) -> int:
    """该等级额外的直连模拟名额数；未知等级按 FREE。"""
    return EXTRA_DEMO_SLOTS.get(plan or "FREE", EXTRA_DEMO_SLOTS["FREE"])


def is_extra_demo_eligible(row) -> bool:
    """这一行能不能占额外名额：gateway 来源 + 组名判为模拟 / 竞赛。"""
    from app.services.account_type import CONTEST, DEMO
    return (getattr(row, "source", None) == "gateway"
            and getattr(row, "trade_mode", None) in (DEMO, CONTEST))


def plan_slot_rows(plan: str | None, rows: list) -> list:
    """rows（当前有效账户行，可含一个待新增的候选）里占用常规名额的那些：额外名额先
    吸收符合条件的行。调用方拿 len(结果) 与 max_mt5_accounts 比。
    The rows that occupy regular slots once the extra demo slot(s) absorb eligible
    ones; compare len(result) with max_mt5_accounts."""
    extra = extra_demo_slots(plan)
    out = []
    for r in rows:
        if extra > 0 and is_extra_demo_eligible(r):
            extra -= 1
            continue
        out.append(r)
    return out


def can_use_push(plan: str | None) -> bool:
    """该等级是否可以开启 Web Push 通知（FREE 之外全部可用）。
    Whether this plan may enable Web Push notifications (everyone except FREE)."""
    return is_realtime_plan(plan)


def can_auto_manage(plan: str | None) -> bool:
    """该等级是否可以使用自动仓位管理（保本/追踪止损/分批止盈）。PRO 专属。
    Whether this plan may use auto position management (break-even, trailing
    stop, partial take-profit). PRO only."""
    return plan == "PRO"
