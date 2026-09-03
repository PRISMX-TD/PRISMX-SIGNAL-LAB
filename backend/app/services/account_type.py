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


def classify_server(server: str | None, settings: dict) -> int | None:
    """按服务器名判定账户类型；判不出来返回 None（未知）。

    **只用于桥接通道没有组名的账号**：桥接上报的载荷只有 `server`/`company`/
    `tradeMode`，没有 MT5 组名，`classify_group` 对这类账号永远判不出来。这个
    函数是它的兜底。

    **为什么是精确匹配而不是前缀匹配**：服务器名是券商分配的短字符串，前缀匹配
    会有意外命中——比如白名单写 "MakeCapital" 会把 "MakeCapital-Demo" 也扫进
    实盘，这正是 `classify_group` 那边"宁可漏算不猜错"的教训在这里的翻版。服务器
    名不像组名那样有天然的层级前缀关系，没有理由承担这个风险，精确匹配是更安全
    的方向。

    判不出来（空值、或不在任何名单里）一律 None，不猜——原因同 `classify_group`。

    Classify by exact server name (case/whitespace-insensitive); None when
    nothing matches. This exists only as a fallback for bridge accounts with no
    group name (the bridge payload carries server/company/tradeMode but no MT5
    group). Exact match, not prefix: server names are short broker-assigned
    strings with no natural prefix hierarchy, and a prefix like "MakeCapital"
    would sweep in "MakeCapital-Demo" — the same wrong-direction risk
    `classify_group` avoids by never guessing. Unmatched stays None.
    """
    if not server:
        return None
    name = server.strip().lower()
    if not name:
        return None

    for key, mode in (
        ("real_server_names", REAL),
        ("contest_server_names", CONTEST),
        ("demo_server_names", DEMO),
    ):
        for candidate in settings.get(key) or []:
            c = str(candidate).strip().lower()
            if c and c == name:
                return mode
    return None


def classify_account(group: str | None, server: str | None, settings: dict) -> int | None:
    """账户类型判定的统一入口：组名优先（权威），服务器名兜底。

    **⚠ falsy-zero 陷阱**：`DEMO == 0`，所以绝不能写
    `classify_group(...) or classify_server(...)`——组名判成 DEMO 时
    `0 or ...` 会继续求值右边，把一个已经判出来的模拟账户送去服务器名单里
    再查一次。必须显式判断 `is not None`，只有组名**完全没判出来**（None）
    才落到服务器名兜底。

    Single entry point: group name first (authoritative), server name only as
    a fallback when the group yields nothing. CRITICAL: DEMO == 0 is falsy, so
    `classify_group(...) or classify_server(...)` is a bug — a group correctly
    classified as DEMO would fall through to the server whitelist. Must check
    `is not None` explicitly.
    """
    by_group = classify_group(group, settings)
    if by_group is not None:
        return by_group
    return classify_server(server, settings)


def is_real(trade_mode: int | None) -> bool:
    """是否真实账户。None（未知）判 False——保守起见不计入实盘统计。
    Whether this is a live account; unknown counts as not-real."""
    return trade_mode == REAL
