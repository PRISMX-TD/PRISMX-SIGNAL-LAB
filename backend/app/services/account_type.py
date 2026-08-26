"""MT5 账户类型判定：这个账号是实盘、模拟，还是竞赛账户。

**为什么需要它**：平台迟早要区分"真金白银的交易"和"模拟盘练手"——实盘任务、
胜率考核、收益率榜、比赛都建立在这个区分上。模拟盘可以零成本无限下单，把两者
混在一起统计，任何"战绩"都失去意义。

**为什么靠组名**：MT5 的 Manager API **没有**per-account 的 demo/real 布尔字段
（查过 `IMTUser::EnUsersRights`、`IMTAccount`、`IMTConGroup`：都没有；
`IMTConServerTrade::EnDemoMode` 是服务器级的"允不允许分配模拟账户"，不是账户
标记）。券商实际是**按组**划分的——这既是 MT5 的通行做法，也是本平台已经在
依赖的做法：网关的 `allowed_groups` 白名单就是按组名前缀放行的，那是代客下单
前的最后一道闸，比这里的赌注高得多。

**可信度**：gateway 通道的组名来自券商 Manager API、经本平台服务端取得，
**用户碰不到**，因此比桥接通道用户侧自报的 `trade_mode` 更权威。两条通道的
可信度并不对等，涉及"对外代表用户成绩"的场景应当知道这个差别。

MT5 account-type classification (real / demo / contest) from the broker's group
name. The Manager API exposes no per-account demo flag — brokers separate them
by group, which is also how this platform's own `allowed_groups` order-routing
whitelist already works. Group names come from the broker through our own
server, so this is more authoritative than the bridge's self-reported value.
"""

# 与 MT5 的 ACCOUNT_TRADE_MODE 同一套取值，便于两条通道存进同一列。
# Same values as MT5's ACCOUNT_TRADE_MODE so both channels share one column.
DEMO = 0
CONTEST = 1
REAL = 2


def classify_group(group: str | None, settings: dict) -> int | None:
    """按组名判定账户类型；判不出来返回 None（未知）。

    匹配规则：组名小写后按**最长前缀命中**——配置里更具体的前缀优先于更宽泛的，
    这样 `demo` 与 `demo-vip` 同时配置时不会互相打架。

    **判不出来一律返回 None，而不是猜一个**：这个值的下游是"算不算实盘战绩"，
    猜错的方向是把模拟盘记成实盘，代价比"少算一个账号"大得多。未知账号被排除在
    实盘统计之外，等运维把该组前缀补进配置后，下一轮刷新自动纠正。

    Classify by group name, longest matching prefix wins; None when nothing
    matches. Deliberately never guesses: mis-classifying a demo account as real
    is far worse than leaving one unclassified, and unknowns self-correct once
    the prefix is configured.
    """
    if not group:
        return None
    name = group.strip().lower()
    if not name:
        return None

    best_len = 0
    best_mode: int | None = None
    for key, mode in (
        ("real_group_prefixes", REAL),
        ("contest_group_prefixes", CONTEST),
        ("demo_group_prefixes", DEMO),
    ):
        for prefix in settings.get(key) or []:
            p = str(prefix).strip().lower()
            if p and name.startswith(p) and len(p) > best_len:
                best_len = len(p)
                best_mode = mode
    return best_mode


def is_real(trade_mode: int | None) -> bool:
    """是否真实账户。None（未知）判 False——保守起见不计入实盘统计。
    Whether this is a live account; unknown counts as not-real."""
    return trade_mode == REAL
