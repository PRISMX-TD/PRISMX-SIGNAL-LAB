"""账户实盘判定的服务器名兜底：`classify_server` / `classify_account`。

**为什么需要这一层**：生产里 19 个 NULL 账号中有 13 个是 `source='bridge'`、
`server='MakeCapital-Live'`——合作券商的真实实盘服务器，但桥接客户端版本太老，
从不上报 `tradeMode`，而桥接载荷本身根本不带 MT5 组名，`classify_group` 对
这批账号永远判不出来。这里补一条按服务器名的兜底判据。

分三段测：
1. `classify_server` 本身——精确匹配，不是前缀匹配（这是与 `classify_group`
   刻意不同的地方，见 services/account_type.py 的注释）；
2. `classify_account` 的优先级——组名权威、服务器名兜底，重点锁
   **DEMO=0 的 falsy 陷阱**：组名判成 DEMO 时绝不能落到服务器名单再判一次；
3. 两处落地——每小时回填 `backfill_account_trade_modes`，以及桥接轮询的
   `_upsert_account` 兜底分支。

Server-name fallback for account-type classification. Three sections:
classify_server itself (exact match, not prefix), classify_account's
precedence (group authoritative, server fallback — pinning the DEMO==0
falsy-zero trap), and the two call sites that consume it.
"""
from app.models import MT5Account, User
from app.routers.bridge import BridgeAccount, _upsert_account
from app.services.account_type import CONTEST, DEMO, REAL, classify_account, classify_server
from app.services.gamification.loop import backfill_account_trade_modes
from app.services.settings_store import ACCOUNT_TYPE_DEFAULTS


_SETTINGS = {
    "real_group_prefixes": ["real"],
    "contest_group_prefixes": ["contest"],
    "demo_group_prefixes": ["demo"],
    "real_server_names": ["MakeCapital-Live"],
    "contest_server_names": ["MakeCapital-Contest"],
    "demo_server_names": ["MakeCapital-Demo"],
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


def test_classify_server_shipped_defaults_recognise_the_partner_live_server():
    """出厂配置：合作券商的真实实盘服务器名。"""
    assert classify_server("MakeCapital-Live", ACCOUNT_TYPE_DEFAULTS) == REAL
    assert classify_server("makecapital-live", ACCOUNT_TYPE_DEFAULTS) == REAL
    assert classify_server("MakeCapital-Demo", ACCOUNT_TYPE_DEFAULTS) is None


# ---------- classify_account：优先级 + falsy-zero 陷阱 ----------

def test_classify_account_group_wins_when_present():
    assert classify_account("real\\forex", None, _SETTINGS) == REAL


def test_classify_account_falls_back_to_server_when_group_is_none():
    assert classify_account(None, "MakeCapital-Live", _SETTINGS) == REAL
    assert classify_account("unknown\\group", "MakeCapital-Live", _SETTINGS) == REAL


def test_classify_account_demo_group_does_not_fall_through_to_server_real_list():
    """DEMO == 0 是 falsy——`classify_group(...) or classify_server(...)` 这种
    写法会让"组名已经判成 DEMO"的账户，因为 `0 or x` 继续求值右边，被服务器
    白名单再判一次。组名判定的结果必须是终局，不能被服务器名单覆盖。
    """
    assert classify_account("demo\\forex", "MakeCapital-Live", _SETTINGS) == DEMO


def test_classify_account_both_none_is_unknown():
    assert classify_account(None, None, _SETTINGS) is None
    assert classify_account("unknown\\group", "unknown-server", _SETTINGS) is None


# ---------- 落地点一：每小时回填 / backfill_account_trade_modes ----------

def test_backfill_classifies_bridge_account_by_server_when_no_group(db_session):
    u = User(email="srv1@t.co", api_token="tok_srv1")
    db_session.add(u)
    db_session.commit()
    db_session.add(MT5Account(user_id=u.id, login="1", server="MakeCapital-Live",
                              source="bridge", mt5_group=None, trade_mode=None))
    db_session.commit()

    assert backfill_account_trade_modes(db_session) == 1

    acc = db_session.query(MT5Account).first()
    assert acc.trade_mode == REAL


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

def _poll(db, user_id, **kwargs):
    acc = BridgeAccount(login="500123", server="MakeCapital-Live", **kwargs)
    row, created = _upsert_account(db, user_id, acc, existing_count=0, account_limit=None)
    db.commit()
    return row


def test_upsert_without_trademode_falls_back_to_server_whitelist(db_session):
    """老版本桥接不报 tradeMode：账号第一次上报就该按服务器名判成实盘，
    不用等下一轮 gamification 回填。"""
    u = User(email="brg1@t.co", api_token="tok_brg1")
    db_session.add(u)
    db_session.commit()

    row = _poll(db_session, u.id)

    assert row.trade_mode == REAL


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
