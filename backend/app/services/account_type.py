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

# `server_login_rules` 里 `default` 兜底只允许保守方向：一台服务器上「其余号段」
# 可以声明为模拟或竞赛，**不能声明为实盘**——那等于凭空猜一批账号是真金白银，
# 正是本模块开篇反复强调不能做的事。配成 "real" 会被忽略（仍判未知）。
# The per-rule `default` may only fall back to demo/contest, never real:
# blanket-guessing a range as live money is the one direction this module exists
# to prevent. A "real" default is ignored (stays unknown).
_DEFAULT_MODES = {"demo": DEMO, "contest": CONTEST}


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


def classify_login(server: str | None, login: str | None, settings: dict) -> int | None:
    """按「服务器 + 登录号段」判定账户类型；判不出来返回 None（未知）。

    **为什么需要它**：`classify_server` 假设"整台服务器只跑一种账户"，但
    2026-09-03 与 Make Capital 确认这个假设不成立——`MakeCapital-Live` 一台
    MT5 服务器同时跑模拟和实盘，靠登录号段区分（`1` 开头模拟、`6` 开头实盘）。
    这正是把账号 100016（模拟、余额刚好 10000.00）误判成实盘的那条规则的替代。

    匹配两层：先按服务器名**精确**匹配（大小写/首尾空白不敏感）找到规则条目，
    再在该条目内按登录号**前缀**匹配——三个前缀列表放在一起比较，最长前缀命中
    的胜出（与 `classify_group` 同一套 tie-break，写法直接复用）。

    没有该服务器的规则、或号段前缀不在配置里，一律 None，不猜——原因同
    `classify_group`：猜错方向是把模拟记成实盘，代价远大于漏判一个账号。
    规则条目可带 `default`（只能是 "demo"/"contest"）声明该服务器上其余号段的
    归类——Make Capital 就是「6 开头实盘、其余一律模拟」。
    规则条目本身若损坏（不是 dict、缺 "server" 键）直接跳过，不抛异常——
    这是运维配置，不该因为一条脏数据打断整批判定。

    Classify by (server, login-prefix); None when nothing matches. This exists
    because a whole-server claim (`classify_server`) can be wrong when a broker
    actually mixes demo and live logins on one server — Make Capital's
    MakeCapital-Live does exactly that (confirmed with the broker 2026-09-03),
    told apart only by login prefix (1xxxxx = demo, 6xxxxx = live). Server match
    is exact; login match within that rule is longest-prefix-wins across all
    three lists, mirroring classify_group. Unmatched (no rule for the server, or
    no prefix hit) stays None — never guess. Malformed rule entries are skipped
    defensively rather than raising.
    """
    if not server or not login:
        return None
    server_name = server.strip().lower()
    if not server_name:
        return None
    login_str = str(login).strip()
    if not login_str:
        return None

    for rule in settings.get("server_login_rules") or []:
        if not isinstance(rule, dict):
            continue
        rule_server = rule.get("server")
        if not isinstance(rule_server, str):
            continue
        if rule_server.strip().lower() != server_name:
            continue

        best_len = 0
        best_mode: int | None = None
        for key, mode in (
            ("real_login_prefixes", REAL),
            ("contest_login_prefixes", CONTEST),
            ("demo_login_prefixes", DEMO),
        ):
            for prefix in rule.get(key) or []:
                p = str(prefix).strip()
                if p and login_str.startswith(p) and len(p) > best_len:
                    best_len = len(p)
                    best_mode = mode
        if best_mode is not None:
            return best_mode
        # 号段没命中时，规则可以用 `default` 声明「这台服务器上其余号段一律算
        # 什么」。这是券商给的事实（Make Capital：6 开头实盘，其余全是模拟），
        # 比把号段一个个列出来更贴近真相，也不会在券商新开一个号段时把它默默
        # 判成未知。只接受 demo/contest，见 _DEFAULT_MODES。
        # A rule may declare what every OTHER login range on that server is.
        # This encodes the broker's own statement ("6… is live, everything else
        # is demo") rather than enumerating ranges, and keeps a newly-opened
        # range from silently landing in "unknown". Demo/contest only.
        return _DEFAULT_MODES.get(str(rule.get("default") or "").strip().lower())
    return None


def classify_account(
    group: str | None, server: str | None, login: str | None, settings: dict
) -> int | None:
    """账户类型判定的统一入口：组名 > 登录号段 > 整台服务器，依次兜底。

    **为什么登录号段排在服务器名前面**：服务器名规则只能表达"这整台服务器
    都是实盘"这一种断言；登录号段规则能表达"这台服务器是混跑的，靠号段区分"
    ——后者是前者的精细化版本，配置了它就说明运维已经知道这台服务器不能
    一刀切。两者都配置时，更具体的必须赢，否则整台服务器的断言会静默压制
    号段规则本该纠正的那批账号——这正是 100016 被误判为实盘的那个 bug。

    **⚠ falsy-zero 陷阱**：`DEMO == 0`，所以绝不能写
    `classify_group(...) or classify_login(...) or classify_server(...)`——
    组名判成 DEMO 时 `0 or ...` 会继续求值右边，把一个已经判出来的模拟账户
    送去后面的规则里再查一次。必须显式判断 `is not None`，只有前一层
    **完全没判出来**（None）才落到下一层兜底。

    Single entry point, first non-None wins, in this order:
    1. classify_group — broker group via Manager API, authoritative (gateway channel).
    2. classify_login — server + login-prefix; more specific than a whole-server
       claim because it can express "this server is mixed", which a server-name
       rule cannot. Where both are configured for the same server, the
       finer-grained per-login rule must win, or a whole-server assertion would
       silently override the very correction it was configured to make.
    3. classify_server — whole-server-is-live claim; still valid for brokers
       that genuinely segregate demo/live onto separate servers.
    CRITICAL: DEMO == 0 is falsy, so chaining with `or` is a bug — must check
    `is not None` explicitly at every step.
    """
    by_group = classify_group(group, settings)
    if by_group is not None:
        return by_group
    by_login = classify_login(server, login, settings)
    if by_login is not None:
        return by_login
    return classify_server(server, settings)


def is_real(trade_mode: int | None) -> bool:
    """是否真实账户。None（未知）判 False——保守起见不计入实盘统计。
    Whether this is a live account; unknown counts as not-real."""
    return trade_mode == REAL
