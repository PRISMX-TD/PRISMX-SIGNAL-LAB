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

from datetime import datetime, timezone

PLANS = ("FREE", "PRO")

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


def can_use_push(plan: str | None) -> bool:
    """该等级是否可以开启 Web Push 通知（FREE 之外全部可用）。
    Whether this plan may enable Web Push notifications (everyone except FREE)."""
    return is_realtime_plan(plan)


def can_auto_manage(plan: str | None) -> bool:
    """该等级是否可以使用自动仓位管理（保本/追踪止损/分批止盈）。PRO 专属。
    Whether this plan may use auto position management (break-even, trailing
    stop, partial take-profit). PRO only."""
    return plan == "PRO"
