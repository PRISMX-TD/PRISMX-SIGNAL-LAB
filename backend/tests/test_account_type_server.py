"""账户实盘判定的服务器名兜底 / 登录号段判定：`classify_server` /
`classify_login` / `classify_account`。

**为什么需要这一层**：生产里 19 个 NULL 账号中有 13 个是 `source='bridge'`、
`server='MakeCapital-Live'`——合作券商的真实实盘服务器，但桥接客户端版本太老，
从不上报 `tradeMode`，而桥接载荷本身根本不带 MT5 组名，`classify_group` 对
这批账号永远判不出来。这里补一条按服务器名的兜底判据。

但服务器名兜底本身在 2026-09-03 被证明不安全：`MakeCapital-Live` 并不是
"整台服务器都是实盘"，而是混跑模拟与实盘，靠登录号段区分。`classify_login`
是这条更细的判据，`classify_account` 里必须排在服务器名兜底前面——这正是
账号 100016（模拟、余额刚好 10000.00）被服务器名单误判成实盘的那个 bug，
本文件用 `test_classify_account_login_prefix_beats_whole_server_claim`
钉死。

分四段测：
1. `classify_server` 本身——精确匹配，不是前缀匹配（这是与 `classify_group`
   刻意不同的地方，见 services/account_type.py 的注释）；
2. `classify_login`——服务器精确匹配 + 登录号最长前缀命中，未配置的服务器/
   号段一律 None，规则条目损坏时跳过而不抛异常；
3. `classify_account` 的优先级——组名权威、登录号段次之、服务器名兜底，
   重点锁 **DEMO=0 的 falsy 陷阱**，以及登录号段优先于整服务器断言这条新规则；
4. 三处落地——每小时回填 `backfill_account_trade_modes`、桥接轮询的
   `_upsert_account` 兜底分支，以及登录号段在 backfill 里的直接体现。

Server-name fallback and login-prefix classification for account-type
classification. Four sections: classify_server itself (exact match, not
prefix), classify_login (exact server match + longest-login-prefix, skips
malformed rule entries), classify_account's precedence (group authoritative,
login-prefix next, server whole-claim last — pinning the DEMO==0 falsy-zero
trap and the login-beats-server rule), and the call sites that consume it.
"""
from app.models import MT5Account, User
from app.routers.bridge import BridgeAccount, _upsert_account
from app.services.account_type import (
    CONTEST,
    DEMO,
    REAL,
    classify_account,
    classify_login,
    classify_server,
)
from app.services.gamification.loop import backfill_account_trade_modes
from app.services.settings_store import ACCOUNT_TYPE_DEFAULTS


_SETTINGS = {
    "real_group_prefixes": ["real"],
    "contest_group_prefixes": ["contest"],
    "demo_group_prefixes": ["demo"],
    "real_server_names": ["MakeCapital-Live"],
    "contest_server_names": ["MakeCapital-Contest"],
    "demo_server_names": ["MakeCapital-Demo"],
    "server_login_rules": [
        {
            "server": "MakeCapital-Live",
            "real_login_prefixes": ["6"],
            "demo_login_prefixes": ["1"],
            "contest_login_prefixes": [],
        },
    ],
}


# ---------- classify_server：精确匹配 / exact match ----------

def test_classify_server_exact_match_case_and_whitespace_insensitive():
    assert classify_server("MakeCapital-Live", _SETTINGS) == REAL
    assert classify_server("makecapital-live", _SETTINGS) == REAL
    assert classify_server("  MakeCapital-Live  ", _SETTINGS) == REAL


def test_classify_server_contest_and_demo_lists():
    assert classify_server("MakeCapital-Contest", _SETTINGS) == CONTEST
    assert classify_server("MakeCapital-Demo", _SETTINGS) == DEMO


def test_classify_server_prefix_near_miss_does_not_match():
    """精确匹配的关键性质：前缀相似不算命中。

    "MakeCapital-Live-2" 和 "MakeCapital" 都不是白名单里那个精确字符串——
    如果这里退化成前缀匹配，"MakeCapital-Live" 会把 "MakeCapital-Demo" 也
    扫成实盘，这正是本函数要避免的方向。
    """
    assert classify_server("MakeCapital-Live-2", _SETTINGS) is None
    assert classify_server("MakeCapital", _SETTINGS) is None


def test_classify_server_empty_or_none_is_unknown():
    assert classify_server(None, _SETTINGS) is None
    assert classify_server("", _SETTINGS) is None
    assert classify_server("   ", _SETTINGS) is None


def test_classify_server_shipped_defaults_no_longer_whitelist_make_capital_live():
    """出厂配置：`MakeCapital-Live` 2026-09-03 从整服务器白名单里移除——那台
    服务器混跑模拟与实盘，整服务器断言的前提不成立，`classify_server` 现在
    对它判不出来（None），改由 `classify_login` 按登录号段接管，见下面
    `test_classify_login_shipped_defaults_...`。

    Shipped config: MakeCapital-Live was removed from the whole-server
    whitelist 2026-09-03 (the server mixes demo and live; the whole-server
    premise doesn't hold). classify_server now returns None for it; per-login
    classification takes over via classify_login instead.
    """
    assert classify_server("MakeCapital-Live", ACCOUNT_TYPE_DEFAULTS) is None
    assert classify_server("MakeCapital-Demo", ACCOUNT_TYPE_DEFAULTS) is None


def test_classify_login_shipped_defaults_classify_make_capital_live_by_prefix():
    """出厂配置：合作券商确认的登录号段规则（2026-09-03）。"""
    assert classify_login("MakeCapital-Live", "600345", ACCOUNT_TYPE_DEFAULTS) == REAL
    assert classify_login("makecapital-live", "600345", ACCOUNT_TYPE_DEFAULTS) == REAL
    assert classify_login("MakeCapital-Live", "100016", ACCOUNT_TYPE_DEFAULTS) == DEMO
    assert classify_login("MakeCapital-Live", "991073", ACCOUNT_TYPE_DEFAULTS) is None


# ---------- classify_login：服务器精确匹配 + 登录号最长前缀 ----------

def test_classify_login_prefix_matches_within_configured_server():
    assert classify_login("MakeCapital-Live", "600345", _SETTINGS) == REAL
    assert classify_login("MakeCapital-Live", "100016", _SETTINGS) == DEMO


def test_classify_login_unconfigured_prefix_is_unknown_not_guessed():
    """`9` 开头的号段没有跟券商确认过，宁可判未知也不猜——等确认后再补进配置。
    9-prefix logins aren't confirmed with the broker yet; stays unknown rather
    than guessed, pending broker confirmation."""
    assert classify_login("MakeCapital-Live", "991073", _SETTINGS) is None


def test_classify_login_unconfigured_server_is_unknown():
    assert classify_login("SomeOtherBroker-Live", "600345", _SETTINGS) is None


def test_classify_login_empty_or_none_is_unknown():
    assert classify_login(None, "600345", _SETTINGS) is None
    assert classify_login("MakeCapital-Live", None, _SETTINGS) is None
    assert classify_login("", "600345", _SETTINGS) is None
    assert classify_login("MakeCapital-Live", "", _SETTINGS) is None


def test_classify_login_skips_malformed_rule_entries_without_raising():
    """规则表是运维配置，允许脏——损坏的条目跳过，不影响后面能匹配上的条目，
    也不该让整个判定抛异常。
    The rule list is ops-editable config; malformed entries are skipped, later
    valid entries still match, and nothing raises."""
    settings = {
        "server_login_rules": [
            "not-a-dict",
            {"real_login_prefixes": ["6"]},  # 缺 "server" 键 / missing "server"
            {
                "server": "MakeCapital-Live",
                "real_login_prefixes": ["6"],
                "demo_login_prefixes": ["1"],
                "contest_login_prefixes": [],
            },
        ],
    }
    assert classify_login("MakeCapital-Live", "600345", settings) == REAL

    only_malformed = {"server_login_rules": ["not-a-dict", {"real_login_prefixes": ["6"]}]}
    assert classify_login("MakeCapital-Live", "600345", only_malformed) is None


# ---------- classify_account：优先级 + falsy-zero 陷阱 ----------

def test_classify_account_group_wins_when_present():
    assert classify_account("real\\forex", None, None, _SETTINGS) == REAL


def test_classify_account_group_wins_even_when_login_prefix_disagrees():
    """组名来自 gateway 通道、经本平台服务端取得，比任何自报/推断的判据都权威；
    登录号段规则再具体也不能覆盖它。"""
    assert classify_account("demo\\forex", "MakeCapital-Live", "600345", _SETTINGS) == DEMO
    assert classify_account("real\\forex", "MakeCapital-Live", "100016", _SETTINGS) == REAL


def test_classify_account_login_prefix_beats_whole_server_claim():
    """本次修复要钉死的那个 bug：组名判不出来时，登录号段规则必须赢过"整台
    服务器都是实盘"这条更粗的断言。`_SETTINGS` 里 MakeCapital-Live 同时在
    `real_server_names`（整服务器实盘）和 `server_login_rules`（登录号 1 开头
    是模拟）——号段规则更具体，必须赢，账号 100016 才不会被误判成实盘。

    The exact bug this fix targets: when the group can't classify, a per-login
    rule must outrank a whole-server claim. MakeCapital-Live sits in both
    `real_server_names` and `server_login_rules` here — the finer-grained rule
    must win, or account 100016 gets misclassified REAL again.
    """
    assert classify_account(None, "MakeCapital-Live", "100016", _SETTINGS) == DEMO
    assert classify_account(None, "MakeCapital-Live", "600345", _SETTINGS) == REAL


def test_classify_account_falls_back_to_server_when_no_login_rule_applies():
    """没有登录号信息、或号段判不出来时，才轮到整服务器断言兜底。"""
    assert classify_account(None, "MakeCapital-Live", None, _SETTINGS) == REAL
    assert classify_account("unknown\\group", "MakeCapital-Live", None, _SETTINGS) == REAL
    # "9" 开头的号段没配置，classify_login 判不出来，落到 classify_server。
    assert classify_account(None, "MakeCapital-Live", "991073", _SETTINGS) == REAL


def test_classify_account_demo_group_does_not_fall_through_to_server_real_list():
    """DEMO == 0 是 falsy——`classify_group(...) or classify_login(...) or
    classify_server(...)` 这种写法会让"组名已经判成 DEMO"的账户，因为
    `0 or x` 继续求值右边，被后面的规则再判一次。组名判定的结果必须是终局。
    """
    assert classify_account("demo\\forex", "MakeCapital-Live", None, _SETTINGS) == DEMO


def test_classify_account_all_none_is_unknown():
    assert classify_account(None, None, None, _SETTINGS) is None
    assert classify_account("unknown\\group", "unknown-server", "123", _SETTINGS) is None


# ---------- 落地点一：每小时回填 / backfill_account_trade_modes ----------
#
# 这里不传自定义 settings——backfill 内部用 get_account_type_settings(db)，
# 测试库里没有 platform_settings 覆盖行时读到的就是出厂配置
# ACCOUNT_TYPE_DEFAULTS，即修复后的 server_login_rules（1 开头模拟、6 开头
# 实盘），real_server_names 已不再包含 MakeCapital-Live。
#
# Uses ACCOUNT_TYPE_DEFAULTS (no platform_settings override row in the test
# db), i.e. the post-fix config: server_login_rules classifies MakeCapital-Live
# by prefix, real_server_names no longer whitelists it wholesale.

def test_backfill_classifies_make_capital_live_by_login_prefix(db_session):
    u = User(email="srv1@t.co", api_token="tok_srv1")
    db_session.add(u)
    db_session.commit()
    db_session.add_all([
        MT5Account(user_id=u.id, login="600345", server="MakeCapital-Live",
                   source="bridge", mt5_group=None, trade_mode=None),
        MT5Account(user_id=u.id, login="100016", server="MakeCapital-Live",
                   source="bridge", mt5_group=None, trade_mode=None),
        MT5Account(user_id=u.id, login="991073", server="MakeCapital-Live",
                   source="bridge", mt5_group=None, trade_mode=None),
    ])
    db_session.commit()

    # 只有前两行判得出来（6.../1...），"9..." 号段未确认，仍是 None。
    # Only the first two resolve (6.../1...); the unconfirmed "9..." prefix
    # is still None, so it isn't counted as newly-classified.
    assert backfill_account_trade_modes(db_session) == 2

    by_login = {a.login: a.trade_mode for a in db_session.query(MT5Account).all()}
    assert by_login["600345"] == REAL
    assert by_login["100016"] == DEMO
    assert by_login["991073"] is None


def test_backfill_leaves_unknown_server_null(db_session):
    u = User(email="srv2@t.co", api_token="tok_srv2")
    db_session.add(u)
    db_session.commit()
    db_session.add(MT5Account(user_id=u.id, login="1", server="SomeOtherBroker-Live",
                              source="bridge", mt5_group=None, trade_mode=None))
    db_session.commit()

    assert backfill_account_trade_modes(db_session) == 0

    acc = db_session.query(MT5Account).first()
    assert acc.trade_mode is None


def test_backfill_group_classified_account_still_works(db_session):
    """组名判定的老路径不受影响。"""
    u = User(email="srv3@t.co", api_token="tok_srv3")
    db_session.add(u)
    db_session.commit()
    db_session.add(MT5Account(user_id=u.id, login="1", server="whatever",
                              source="gateway", mt5_group="MCSA\\I-STD-SLAB-USD",
                              trade_mode=None))
    db_session.commit()

    assert backfill_account_trade_modes(db_session) == 1

    acc = db_session.query(MT5Account).first()
    assert acc.trade_mode == REAL


# ---------- 落地点二：桥接轮询兜底 / _upsert_account ----------
#
# 同上，走 get_account_type_settings(db) 读到的出厂配置：MakeCapital-Live
# 靠登录号段判定，不再有整服务器白名单。
# Also reads ACCOUNT_TYPE_DEFAULTS via get_account_type_settings(db):
# MakeCapital-Live is classified by login prefix now, no whole-server whitelist.

def _poll(db, user_id, login="600123", **kwargs):
    acc = BridgeAccount(login=login, server="MakeCapital-Live", **kwargs)
    row, created = _upsert_account(db, user_id, acc, existing_count=0, account_limit=None)
    db.commit()
    return row


def test_upsert_without_trademode_falls_back_to_login_prefix_rule(db_session):
    """老版本桥接不报 tradeMode：账号第一次上报就该按登录号段判成实盘，
    不用等下一轮 gamification 回填。"""
    u = User(email="brg1@t.co", api_token="tok_brg1")
    db_session.add(u)
    db_session.commit()

    row = _poll(db_session, u.id, login="600123")

    assert row.trade_mode == REAL


def test_upsert_without_trademode_classifies_demo_login_prefix(db_session):
    """同一台服务器上，模拟号段不能被判成实盘——这正是 100016 那个 bug。"""
    u = User(email="brg1b@t.co", api_token="tok_brg1b")
    db_session.add(u)
    db_session.commit()

    row = _poll(db_session, u.id, login="100016")

    assert row.trade_mode == DEMO


def test_upsert_with_explicit_trademode_wins_over_server_fallback(db_session):
    """新版本桥接明确上报 tradeMode=0（模拟）：即使 server 命中实盘白名单，
    显式自报值优先——它是 MT5 账户自身的 account_info().trade_mode，比服务器
    名单更具体。"""
    u = User(email="brg2@t.co", api_token="tok_brg2")
    db_session.add(u)
    db_session.commit()

    row = _poll(db_session, u.id, tradeMode=0)

    assert row.trade_mode == 0


def test_upsert_unknown_server_without_trademode_stays_null(db_session):
    u = User(email="brg3@t.co", api_token="tok_brg3")
    db_session.add(u)
    db_session.commit()
    acc = BridgeAccount(login="500999", server="SomeOtherBroker-Live")
    row, _ = _upsert_account(db_session, u.id, acc, existing_count=0, account_limit=None)
    db_session.commit()

    assert row.trade_mode is None
