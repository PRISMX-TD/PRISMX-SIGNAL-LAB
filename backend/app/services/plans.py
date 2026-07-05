"""订阅等级规则：集中一处判断"这个等级能不能做 X"，不要散落在各路由里。
Subscription plan rules: one place to decide "can this plan do X", instead of
scattering `if user.plan == "PRO"` checks across routers.

三级制 / Three tiers:
- FREE：信任层——延迟信号、公开胜率，几乎不能实操。
- PLUS：完整核心体验（实时信号、一键下单、推送、个人胜率），限 1 个 MT5 账户。
  内测用户、合作券商返佣客户、未来的低档订阅都放这一级（管理后台手动升级）。
- PRO：PLUS 全部 + MT5 账户数不限；未来的高级权益（新品种优先等）也挂这里。

- FREE: the trust layer — delayed signals and the public win rate, little else.
- PLUS: the full core experience (real-time signals, one-click trading, push,
  personal win rate) capped at 1 MT5 account. Beta testers, partner-broker
  rebate clients and a future entry-level subscription all live here
  (granted manually from the admin panel).
- PRO: everything in PLUS + unlimited MT5 accounts; future premium perks
  (e.g. early access to new symbols) attach here too.

旧等级（BETA/PARTNER/ELITE）已合并，历史数据由 database._migrate_columns
自动映射：BETA→PLUS，PARTNER→PRO，ELITE→PRO。
Legacy tiers (BETA/PARTNER/ELITE) were merged; existing rows are remapped
automatically in database._migrate_columns: BETA→PLUS, PARTNER→PRO, ELITE→PRO.
"""

PLANS = ("FREE", "PLUS", "PRO")


def is_realtime_plan(plan: str | None) -> bool:
    """该等级是否享有实时信号（FREE 之外全部实时）。
    Whether this plan gets real-time signals (everyone except FREE)."""
    return plan != "FREE"


# 每个等级最多可连接的 MT5 账户数；None 表示不限。
# Max MT5 accounts per plan; None means unlimited.
ACCOUNT_LIMITS: dict[str, int | None] = {
    "FREE": 1,
    "PLUS": 1,
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
