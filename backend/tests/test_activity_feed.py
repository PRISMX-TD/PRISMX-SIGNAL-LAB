"""操作日志读接口（设计 2026-10-09 §5）：游标翻页、筛选、跨页不切组。

  · 五个源同一时间戳：逐页翻完不重不漏、两次翻页顺序一致；
  · 每种筛选（分类 / 子分类 / 只看异常 / 搜索 / 用户 / 账号 / 时间窗）只放进该放的行，
    北京时间整天边界（前一天 23:59:59.999999 不进、00:00:00 进）；
  · 合并规则 1 / 2 / 3 的组不被翻页切开（reason 为空、备注 `[so …]` 的老爆仓腿一样合并）；
  · 游标坏了 400。

内存 SQLite + StaticPool：同一个连接，不碰开发机上的库。

Read side of the admin activity log: keyset paging across five sources with
identical timestamps, every filter, Beijing-day boundaries, groups that must not
be cut by a page, and cursor validation.
"""
import base64
import json
from datetime import date, datetime, timedelta

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.database import Base
import app.models  # noqa: F401  —— 注册模型 / registers the tables
from app.models import ActivityEvent, AdminAuditLog, ClosedTrade, MT5Account, Order, User
from app.services import activity_feed as feed
from app.services import activity_log as al
from app.services.stats_time import day_start_utc

T0 = datetime(2026, 10, 9, 6, 0, 0)


@pytest.fixture()
def db():
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


# ── 造数据 / builders ─────────────────────────────────────────────────────────

_seq = {"n": 0}


def _next() -> int:
    _seq["n"] += 1
    return _seq["n"]


def _user(db, email, *, at=T0, **kw) -> User:
    u = User(email=email, api_token="tok_" + email, created_at=at, **kw)
    db.add(u)
    db.commit()
    return u


def _acc(db, user, login, *, source="gateway", trade_mode=2, **kw) -> MT5Account:
    a = MT5Account(user_id=user.id, login=login, server="srv", source=source, trade_mode=trade_mode, **kw)
    db.add(a)
    db.commit()
    return a


def _order(db, user, *, at, action="ORDER", status="FILLED", login="51234567", cid=None, **kw) -> Order:
    kw.setdefault("symbol", "XAUUSD")
    kw.setdefault("side", "BUY")
    kw.setdefault("volume", 0.1)
    o = Order(user_id=user.id, client_order_id=cid or f"co_{_next()}", action=action, status=status,
              mt5_login=login, created_at=at, **kw)
    db.add(o)
    db.commit()
    return o


def _deal(db, user, *, at, reason="SL", login="51234567", pos=None, deal=None, closed_at=None, **kw) -> ClosedTrade:
    n = _next()
    kw.setdefault("symbol", "XAUUSD")
    kw.setdefault("side", "BUY")
    kw.setdefault("close_volume", 0.1)
    kw.setdefault("close_price", 2400.0)
    kw.setdefault("profit", -5.0)
    t = ClosedTrade(user_id=user.id, mt5_login=login, position_ticket=pos or 9000 + n,
                    deal_ticket=deal or 7000 + n, closed_at=closed_at or at, created_at=at,
                    reason=reason, **kw)
    db.add(t)
    db.commit()
    return t


def _audit(db, actor, target, field, old, new, *, at, op=None) -> AdminAuditLog:
    a = AdminAuditLog(admin_user_id=actor.id, target_user_id=target.id, field=field,
                      old_value=old, new_value=new, created_at=at, op_id=op)
    db.add(a)
    db.commit()
    return a


def _event(db, kind, user, *, at, login=None, data=None, actor_type="user", ref=None) -> ActivityEvent:
    e = ActivityEvent(kind=kind, user_id=user.id, actor_type=actor_type,
                      actor_id=user.id if actor_type == "user" else None, mt5_login=login, ref_id=ref,
                      data=al.encode_data(data), created_at=at)
    db.add(e)
    db.commit()
    return e


def _pages(db, limit, **kw) -> list[list[dict]]:
    pages, cursor = [], None
    for _ in range(200):
        out = feed.list_activity(db, cursor=cursor, limit=limit, **kw)
        pages.append(out["items"])
        cursor = out["next"]
        if cursor is None:
            return pages
    raise AssertionError("翻页没有结束 / paging never ended")


def _keys(db, limit=50, **kw) -> list[str]:
    return [it["key"] for page in _pages(db, limit, **kw) for it in page]


def _kinds(db, **kw) -> set[str]:
    return {it["kind"] for page in _pages(db, 50, **kw) for it in page}


# ── 游标翻页 / keyset paging ─────────────────────────────────────────────────

def _five_sources_same_ts(db) -> set[str]:
    """五个源各三行，全部同一个时间戳（同一微秒）。返回应出现的全部 key。
    Three rows per source, all on the very same microsecond."""
    admin = _user(db, "admin@t.co", role="admin")
    users = [_user(db, f"u{i}@t.co") for i in range(3)]
    expected = {f"u:{admin.id}"} | {f"u:{u.id}" for u in users}
    for i, u in enumerate(users):
        expected.add(f"o:{_order(db, u, at=T0).id}")
        expected.add(f"d:{_deal(db, u, at=T0, reason='MOBILE').id}")
        expected.add(f"e:{_event(db, al.USER_PHONE_SET, u, at=T0).id}")
        # 不同 op_id：各自一行 / distinct op ids: one line each
        expected.add(f"a:{_audit(db, admin, u, 'role', 'user', 'admin', at=T0, op=f'op{i}').id}")
    return expected


@pytest.mark.parametrize("limit", [1, 2, 3, 5, 7, 50])
def test_paging_identical_timestamps_no_dup_no_gap(db, limit):
    expected = _five_sources_same_ts(db)
    keys = _keys(db, limit)
    assert len(keys) == len(set(keys)), "有重复 / duplicates"
    assert set(keys) == expected, "有遗漏 / gaps"


def test_paging_is_stable_across_runs_and_page_sizes(db):
    _five_sources_same_ts(db)
    a = _keys(db, 3)
    b = _keys(db, 3)
    assert a == b
    # 同一时间戳按源顺序 u → e → o → c → a / ties broken by source order
    order = [k.split(":")[0] for k in _keys(db, 50)]
    assert order == sorted(order, key=lambda p: "ueoda".index(p))


def test_items_are_newest_first_and_ts_has_z(db):
    u = _user(db, "a@t.co", at=T0 - timedelta(days=1))
    _order(db, u, at=T0)
    _order(db, u, at=T0 + timedelta(seconds=1))
    items = feed.list_activity(db)["items"]
    ts = [it["ts"] for it in items]
    assert ts == sorted(ts, reverse=True)
    assert all(t.endswith("Z") for t in ts)
    assert ts[0] == "2026-10-09T06:00:01.000000Z"


def test_next_is_null_on_the_last_page(db):
    u = _user(db, "a@t.co")
    _order(db, u, at=T0)
    out = feed.list_activity(db, limit=5)
    assert out["next"] is None and len(out["items"]) == 2   # 注册 + 下单


def test_cursor_round_trip_and_bad_cursor(db):
    state = {"u": (T0, "abc"), "e": "end", "o": None}
    assert feed.decode_cursor(feed.encode_cursor(state), ["u", "e", "o"]) == state
    with pytest.raises(feed.FeedError):
        feed.list_activity(db, cursor="not-base64!!")
    bad = base64.urlsafe_b64encode(json.dumps({"o": [1, 2]}).encode()).decode()
    with pytest.raises(feed.FeedError):
        feed.list_activity(db, cursor=bad)


def test_bad_parameters_raise(db):
    for kw in ({"cat": "nope"}, {"sub": "x"}, {"since": "yesterday"}):
        with pytest.raises(feed.FeedError):
            feed.list_activity(db, **kw)


def test_out_of_range_times_are_bad_parameters_not_500(db):
    """偏移把日期推出公元 1–9999 年时 astimezone 抛 OverflowError（不是 ValueError）：一样是 400。
    An offset pushing the date out of years 1-9999 raises OverflowError: still a 400."""
    with pytest.raises(feed.FeedError):
        feed.parse_time("0001-01-01T00:00:00+01:00", "since")
    with pytest.raises(feed.FeedError):
        feed.parse_time("9999-12-31T23:59:59-01:00", "until")
    bad = base64.urlsafe_b64encode(json.dumps({"o": ["0001-01-01T00:00:00+05:00", "x"]}).encode()).decode()
    with pytest.raises(feed.FeedError):
        feed.decode_cursor(bad, ["o"])
    with pytest.raises(feed.FeedError):
        feed.list_activity(db, since="0001-01-01T00:00:00+01:00")
    # 审计值里的怪时间只是解析不出来，不会让整页出错 / odd audit timestamps just don't parse
    assert feed._parse_dt("0001-01-01 00:00:00+01:00") is None


# ── 筛选 / filters ────────────────────────────────────────────────────────────

def _mixed(db):
    """每个分类都有东西的一份数据 / something in every category."""
    admin = _user(db, "admin@t.co", role="admin", at=T0 - timedelta(days=3))
    alice = _user(db, "alice@t.co", nickname="Alice", phone="+60123456789", at=T0 - timedelta(days=2))
    bob = _user(db, "bob@t.co", nickname="Bobby", at=T0 - timedelta(days=2))
    _acc(db, alice, "51234567")
    _acc(db, bob, "61234567", source="bridge")
    rows = {
        "alice_open": _order(db, alice, at=T0, login="51234567"),
        "alice_modify": _order(db, alice, at=T0 + timedelta(seconds=1), action="MODIFY", login="51234567",
                               ticket=111, sl=2390.0, tp=0.0, volume=0.0),
        "alice_rejected": _order(db, alice, at=T0 + timedelta(seconds=2), status="REJECTED", login="51234567"),
        "bob_open": _order(db, bob, at=T0 + timedelta(seconds=3), login="61234567"),
        "alice_sl": _deal(db, alice, at=T0 + timedelta(seconds=4), reason="SL", login="51234567"),
        "alice_so": _deal(db, alice, at=T0 + timedelta(seconds=5), reason="SO", login="51234567"),
        "bob_mobile": _deal(db, bob, at=T0 + timedelta(seconds=6), reason="MOBILE", login="61234567"),
        "alice_bind": _event(db, al.MT5_BIND, alice, at=T0 + timedelta(seconds=7), login="51234567",
                             data={"ch": "gateway", "revived": False}),
        "alice_login": _event(db, al.USER_LOGIN, alice, at=T0 + timedelta(seconds=8),
                              data={"method": "password", "new_source": True}),
        "bob_revoked": _event(db, al.MT5_REVOKED, bob, at=T0 + timedelta(seconds=9), login="61234567",
                              actor_type="system", data={"reason": "password_changed"}),
        "alice_settings": _event(db, al.AUTO_SETTINGS, alice, at=T0 + timedelta(seconds=10),
                                 data={"changes": [{"field": "enabled", "old": False, "new": True}]}),
        "alice_plan": _audit(db, admin, alice, "plan", "FREE", "PRO", at=T0 + timedelta(seconds=11), op="op1"),
        "bob_expire": _audit(db, bob, bob, "plan:auto_expire", "PRO", "FREE", at=T0 + timedelta(seconds=12)),
        "setting": _audit(db, admin, admin, "setting:pricing:monthly", "29", "39", at=T0 + timedelta(seconds=13), op="op2"),
        "disable": _audit(db, admin, bob, "account:disable", '{"disabledAt": null, "reason": null}',
                          '{"disabledAt": "2026-10-09T06:00:14", "reason": "spam"}', at=T0 + timedelta(seconds=14), op="op3"),
    }
    return admin, alice, bob, rows


def test_cat_filters_only_query_their_sources(db):
    _mixed(db)
    assert _kinds(db, cat="account") == {
        "user.register", "user.login", "plan.auto_expire",
    }
    assert _kinds(db, cat="mt5") == {"mt5.bind", "mt5.revoked"}
    assert _kinds(db, cat="trade") == {"trade.open", "sltp.modify", "deal.close", "auto.settings"}
    assert _kinds(db, cat="admin") == {"admin.user_plan", "admin.setting", "admin.user_disable"}
    assert _kinds(db, cat="trade", sub="sltp") == {"sltp.modify", "deal.close"}
    sltp_deals = [it for p in _pages(db, 50, cat="trade", sub="sltp") for it in p if it["kind"] == "deal.close"]
    assert {it["params"]["reason"] for it in sltp_deals} == {"SL"}
    oc = [it for p in _pages(db, 50, cat="trade", sub="open_close") for it in p]
    assert {it["kind"] for it in oc} == {"trade.open", "deal.close"}
    assert {it["params"]["reason"] for it in oc if it["kind"] == "deal.close"} == {"SO", "MOBILE"}
    # 每一行都标了自己的分类 / every item carries its category
    for c in ("account", "mt5", "trade", "admin"):
        assert {it["cat"] for p in _pages(db, 50, cat=c) for it in p} == {c}


def test_abnormal_filter(db):
    _, _, _, rows = _mixed(db)
    keys = set(_keys(db, abnormal=1))
    assert keys == {
        f"o:{rows['alice_rejected'].id}", f"d:{rows['alice_so'].id}",
        f"e:{rows['bob_revoked'].id}", f"a:{rows['disable'].id}",
    }
    items = [it for p in _pages(db, 50, abnormal=1) for it in p]
    assert all(it["abnormal"] for it in items)


def test_user_and_q_filters(db):
    admin, alice, bob, rows = _mixed(db)
    by_user = set(_keys(db, user_id=bob.id))
    assert f"o:{rows['bob_open'].id}" in by_user and f"u:{bob.id}" in by_user
    assert f"a:{rows['disable'].id}" in by_user          # 目标是 bob / bob is the target
    assert f"a:{rows['bob_expire'].id}" in by_user
    assert not any(k == f"o:{rows['alice_open'].id}" for k in by_user)
    # 审计按「操作人或目标」：按管理员筛能看到他做的事 / audit matches actor or target
    by_admin = set(_keys(db, user_id=admin.id))
    assert {f"a:{rows['alice_plan'].id}", f"a:{rows['setting'].id}", f"a:{rows['disable'].id}"} <= by_admin
    # q：邮箱前缀 / 昵称包含 / 手机号包含 / e-mail prefix, nickname, phone
    assert set(_keys(db, q="bob@")) == by_user
    assert set(_keys(db, q="obb")) == by_user
    # 手机号：带「+」直接按手机号；纯 5–12 位数字先按 MT5 账号，没人持有这个账号再退回按手机号；
    # 空格 / 横线 / 括号去掉再比 / phones: '+' searches phones; a 5-12 digit q is a login
    # first and falls back to phones when nobody holds it; separators are ignored
    by_alice = set(_keys(db, user_id=alice.id))
    assert f"u:{alice.id}" in set(_keys(db, q="+6012"))
    assert set(_keys(db, q="234567")) == by_alice
    assert set(_keys(db, q="60123456789")) == by_alice
    assert set(_keys(db, q="+60 12-345 6789")) == by_alice
    assert set(_keys(db, q="(012) 345-6789")) == by_alice
    # 有人持有的账号号仍按账号 / a login somebody holds still means the login
    assert set(_keys(db, q="51234567")) == set(_keys(db, login="51234567"))
    # 谁的手机号都不含、也没人持有：空 / neither a phone nor a held login: empty
    assert feed.list_activity(db, q="13800138000") == {"items": [], "next": None}
    # 搜不到人：空 / nobody found: empty
    assert feed.list_activity(db, q="nobody") == {"items": [], "next": None}


def test_login_filter_and_numeric_q(db):
    admin, alice, bob, rows = _mixed(db)
    keys = set(_keys(db, login="61234567"))
    assert keys == {
        f"o:{rows['bob_open'].id}", f"d:{rows['bob_mobile'].id}", f"e:{rows['bob_revoked'].id}",
    }
    # 5–12 位纯数字的 q 按账号 / a 5-12 digit q is a login
    assert set(_keys(db, q="61234567x")) == set()
    assert set(_keys(db, q="51234567")) == set(_keys(db, login="51234567"))
    # 用户 + 账号取交集；不相干的组合是空 / user and login intersect
    assert set(_keys(db, user_id=alice.id, login="61234567")) == set()
    assert f"o:{rows['alice_open'].id}" in set(_keys(db, user_id=alice.id, login="51234567"))


def _statements(db, fn) -> list[str]:
    seen: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        seen.append(" ".join(statement.split()))

    engine = db.get_bind()
    event.listen(engine, "before_cursor_execute", record)
    try:
        fn()
    finally:
        event.remove(engine, "before_cursor_execute", record)
    return seen


@pytest.mark.parametrize("kw", [
    {"q": "13800138000"},      # 不带「+」的手机号，谁的都不是 / a phone nobody has, without '+'
    {"q": "51234"},            # 敲账号号时的前缀 / a prefix while typing a login
    {"login": "99999999"},
    {"q": "99999999", "cat": "trade", "abnormal": 1},
])
def test_unknown_login_never_scans_orders_or_events(db, kw):
    """没人持有过的账号号：直接空页，不发 orders / activity_events / closed_trades 的列表查询
    （orders 没有 mt5_login 索引，没有 user_id IN 持有人时只能整表扫）。
    A login nobody ever held is an empty page outright: no list query on orders,
    activity_events or closed_trades (orders has no mt5_login index)."""
    _mixed(db)
    out: dict = {}
    stmts = _statements(db, lambda: out.update(feed.list_activity(db, **kw)))
    assert out == {"items": [], "next": None}
    assert stmts, "计数器没挂上 / the counter saw nothing"
    assert not [s for s in stmts if "FROM orders" in s or "FROM activity_events" in s], stmts
    # closed_trades 只允许那条按账号找持有人的索引查询 / only the indexed holder lookup on closed_trades
    assert all("ORDER BY" not in s for s in stmts if "FROM closed_trades" in s), stmts


def test_login_held_only_by_a_hard_deleted_account_still_resolves(db):
    """2026-09-06 改软删之前删账号是物理删行：mt5_accounts 里没有了，平仓记录上的 user_id
    还在——按账号筛时从 closed_trades 找回持有人。
    Before soft deletes an account removal deleted the row; its closing deals keep
    the user id, so the login still resolves through closed_trades."""
    u = _user(db, "old@t.co", at=T0 - timedelta(days=60))
    o = _order(db, u, at=T0, login="71234567")
    t = _deal(db, u, at=T0 + timedelta(seconds=1), reason="SL", login="71234567")
    assert set(_keys(db, login="71234567")) == {f"o:{o.id}", f"d:{t.id}"}
    assert set(_keys(db, q="71234567")) == {f"o:{o.id}", f"d:{t.id}"}


def test_since_until_on_beijing_day_boundaries(db):
    """前端把北京时间整天换算成 UTC 传进来：10-09 这一天 = [10-08T16:00Z, 10-09T16:00Z)。
    23:59:59.999999（前一天）不进，00:00:00 进；第二天 00:00:00 不进。
    The frontend sends Beijing days converted to UTC; boundaries are half-open."""
    start = day_start_utc(date(2026, 10, 9))
    end = day_start_utc(date(2026, 10, 10))
    assert start == datetime(2026, 10, 8, 16, 0)
    u = _user(db, "a@t.co", at=start - timedelta(days=5))
    before = _order(db, u, at=start - timedelta(microseconds=1))
    first = _order(db, u, at=start)
    last = _order(db, u, at=end - timedelta(microseconds=1))
    after = _order(db, u, at=end)
    keys = set(_keys(db, since=start.isoformat() + "Z", until=end.isoformat() + "Z"))
    assert keys == {f"o:{first.id}", f"o:{last.id}"}
    assert f"o:{before.id}" not in keys and f"o:{after.id}" not in keys
    # 带偏移的写法同样认 / an explicit offset works too
    keys2 = set(_keys(db, since="2026-10-09T00:00:00+08:00", until="2026-10-10T00:00:00+08:00"))
    assert keys2 == keys


_SLTP_KINDS = {"sltp.modify", "auto.sl"}


def _satisfies(it: dict, *, cat, sub, abnormal, uid, login) -> bool:
    if cat != "all" and it["cat"] != cat:
        return False
    if abnormal and not it["abnormal"]:
        return False
    if login is not None and it["login"] != login:
        return False
    if uid is not None:
        mine = (it["user"] or {}).get("id") == uid or it["actor"]["id"] == uid \
            or any((c["user"] or {}).get("id") == uid for c in it["children"] or ())
        if not mine:
            return False
    if cat == "trade" and sub != "all":
        # 自动仓管设置不是开平仓也不是改止损：只在「交易 · 全部」里 / settings belong to neither sub-tab
        if it["kind"] == "auto.settings":
            return False
        is_sltp = it["kind"] in _SLTP_KINDS or (
            it["kind"] == "deal.close" and it["params"]["reason"] in ("SL", "TP"))
        if (sub == "sltp") != is_sltp:
            return False
    return True


@pytest.mark.parametrize("cat,sub", [
    ("all", "all"), ("account", "all"), ("mt5", "all"), ("admin", "all"),
    ("trade", "all"), ("trade", "sltp"), ("trade", "open_close"),
])
def test_filter_combination_matrix(db, cat, sub):
    """分类 × 只看异常 × 用户 × 账号 × 时间窗 全组合：每一行都满足全部筛选；翻页（每页 2 条）
    与一次取完结果一致；凡是满足筛选的行一条不少（与不带筛选的全集逐条比）。
    Every combination: each item satisfies every filter, paging by 2 equals one big
    page, and nothing that satisfies the filters is missing versus the unfiltered set."""
    admin, alice, bob, rows = _mixed(db)
    everything = [it for p in _pages(db, 100) for it in p]
    window = (T0 + timedelta(seconds=3), T0 + timedelta(seconds=12))
    for abnormal in (0, 1):
        for uid in (None, alice.id, admin.id):
            for login in (None, "51234567"):
                for since, until in ((None, None), window):
                    kw = dict(cat=cat, sub=sub, abnormal=abnormal, user_id=uid, login=login,
                              since=since.isoformat() + "Z" if since else None,
                              until=until.isoformat() + "Z" if until else None)
                    big = [it for p in _pages(db, 100, **kw) for it in p]
                    small = [it for p in _pages(db, 2, **kw) for it in p]
                    assert [i["key"] for i in big] == [i["key"] for i in small], kw
                    f = dict(cat=cat, sub=sub, abnormal=abnormal, uid=uid, login=login)
                    assert all(_satisfies(it, **f) for it in big), kw
                    in_window = [
                        it for it in everything
                        if since is None or since.isoformat() <= it["ts"][:26] < until.isoformat()
                    ]
                    expected = {it["key"] for it in in_window if _satisfies(it, **f)}
                    # 只按账号筛时注册行 / 审计行按设计不查（U、A 源跳过）
                    # With a login filter sign-ups and audit rows are skipped by design
                    if login is not None:
                        expected = {k for k in expected if k[0] not in "uag"}
                    assert {it["key"] for it in big} == expected, kw


def test_filters_combine_with_paging(db):
    admin, alice, bob, rows = _mixed(db)
    for i in range(7):
        _order(db, alice, at=T0 + timedelta(minutes=1, seconds=i), login="51234567")
    full = _keys(db, 50, cat="trade", user_id=alice.id)
    for limit in (1, 2, 4):
        paged = _keys(db, limit, cat="trade", user_id=alice.id)
        assert paged == full


# ── 合并规则不被翻页切开 / groups are not cut by a page ───────────────────────

def test_admin_op_group_is_not_cut_by_the_page(db):
    """一次批量修改 6 个人：limit=2 落在组中间，也要整组出在同一页、合成一行。
    A 6-user bulk edit with limit=2 still lands whole on one page as one line."""
    admin = _user(db, "admin@t.co", role="admin", at=T0 - timedelta(days=1))
    targets = [_user(db, f"t{i}@t.co", at=T0 - timedelta(days=1)) for i in range(6)]
    for i, t in enumerate(targets):
        _audit(db, admin, t, "plan", "FREE", "PRO", at=T0 + timedelta(microseconds=i), op="bulk1")
    pages = _pages(db, 2, cat="admin")
    items = [it for p in pages for it in p]
    assert [it["kind"] for it in items] == ["admin.bulk_edit"]
    assert items[0]["users_count"] == 6 and len(items[0]["children"]) == 6
    assert items[0]["user"] is None
    assert items[0]["params"]["changes"] == [{"field": "plan", "new": "PRO"}]


def test_legacy_audit_rows_chain_within_two_seconds(db):
    admin = _user(db, "admin@t.co", role="admin", at=T0 - timedelta(days=1))
    t = _user(db, "t@t.co", at=T0 - timedelta(days=1))
    # 旧行没有 op_id：同操作人 + 同字段族 + 相隔 ≤2 秒 → 一行；隔 3 秒 → 另一行
    _audit(db, admin, t, "plan", "FREE", "PRO", at=T0)
    _audit(db, admin, t, "plan_expires_at", "", "2026-11-09 06:00:00", at=T0 + timedelta(seconds=1))
    _audit(db, admin, t, "plan_note", "", "KOL", at=T0 + timedelta(seconds=4))
    items = [it for p in _pages(db, 1, cat="admin") for it in p]
    assert [it["kind"] for it in items] == ["admin.user_plan", "admin.user_plan"]
    assert items[0]["params"]["note"] == [None, "KOL"] and items[0]["key"].startswith("a:")
    assert items[1]["params"]["plan"] == ["FREE", "PRO"]
    assert items[1]["params"]["expires"] == [None, "2026-11-09T06:00:00.000000Z"]
    assert items[1]["key"].startswith("g:")


def test_stopout_group_is_not_cut_by_the_page(db):
    u = _user(db, "a@t.co", at=T0 - timedelta(days=1))
    legs = [_deal(db, u, at=T0 + timedelta(seconds=i * 10), reason="SO", profit=-10.0 * (i + 1)) for i in range(4)]
    # 同账号 70 秒后又一次：另一组 / another stop-out 70s later is another group
    other = _deal(db, u, at=T0 + timedelta(seconds=110), reason="SO")
    pages = _pages(db, 1, cat="trade")
    items = [it for p in pages for it in p]
    assert [it["kind"] for it in items] == ["deal.close", "deal.stopout_group"]
    assert items[0]["key"] == f"d:{other.id}"
    group = items[1]
    assert group["key"] == f"s:{legs[-1].id}"
    assert group["params"] == {"count": 4, "pnl": -100.0}
    assert [c["key"] for c in group["children"]] == [f"d:{t.id}" for t in reversed(legs)]
    assert "stopout" in group["tags"] and group["abnormal"] is True


def test_legacy_stopouts_group_with_modern_ones_across_pages(db):
    """2026-09 中旬之前的爆仓腿 reason 为空、备注 `[so …]`：与 reason=SO 的腿一样合并，翻页
    （limit=1）也不切开；详情 s: 还原出同一组。
    Legacy stop-out legs (blank reason, `[so …]` comment) group like reason=SO ones,
    across pages too, and the s: detail rebuilds the same group."""
    u = _user(db, "a@t.co", at=T0 - timedelta(days=1))
    legs = [
        _deal(db, u, at=T0 + timedelta(seconds=i * 10), reason=None if i % 2 else "SO",
              comment=f"[so 4{i}.12%/1234.56/2400.00]", profit=-10.0 * (i + 1))
        for i in range(4)
    ]
    for limit in (1, 50):
        items = [it for p in _pages(db, limit, cat="trade") for it in p]
        assert [it["kind"] for it in items] == ["deal.stopout_group"], limit
        assert items[0]["key"] == f"s:{legs[-1].id}"
        assert items[0]["params"] == {"count": 4, "pnl": -100.0}
    assert [it["key"] for p in _pages(db, 1, abnormal=1) for it in p] == [f"s:{legs[-1].id}"]
    detail = feed.get_item(db, f"s:{legs[-1].id}")
    assert [c["key"] for c in detail["item"]["children"]] == [f"d:{t.id}" for t in reversed(legs)]
    assert all(c["params"]["reason"] == "SO" for c in detail["item"]["children"])


def test_auto_expire_duplicates_collapse_even_across_pages(db):
    u = _user(db, "a@t.co", at=T0 - timedelta(days=1))
    keep = _audit(db, u, u, "plan:auto_expire", "PRO", "FREE", at=T0 + timedelta(seconds=90))
    _audit(db, u, u, "plan:auto_expire", "PRO", "FREE", at=T0)
    for limit in (1, 50):
        items = [it for p in _pages(db, limit, cat="account") for it in p if it["kind"] == "plan.auto_expire"]
        assert [it["key"] for it in items] == [f"a:{keep.id}"]
        assert items[0]["actor"]["type"] == "system"
        assert items[0]["params"] == {"old_plan": "PRO", "new_plan": "FREE"}


def test_empty_page_after_folding_still_moves_on(db):
    """整页都被合并规则收掉时不给前端一页空列表，而是接着往下取。
    A page folded away entirely is skipped rather than returned empty."""
    u = _user(db, "a@t.co", at=T0 - timedelta(days=1))
    older = _order(db, u, at=T0 - timedelta(hours=1))
    for i in range(3):
        _audit(db, u, u, "plan:auto_expire", "PRO", "FREE", at=T0 + timedelta(seconds=i))
    out = feed.list_activity(db, cat="all", limit=1)
    assert out["items"] and out["items"][0]["kind"] == "plan.auto_expire"
    keys = _keys(db, 1)
    assert f"o:{older.id}" in keys and len(keys) == len(set(keys))
