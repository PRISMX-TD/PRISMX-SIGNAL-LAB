"""操作日志读接口的翻译（设计 2026-10-09 §5.3 / §5.6 / §5.7）：每一种源行 → {kind, params, …}。

  · orders：action × status × 指令号前缀 → kind / status / note / tags；止盈止损的
    set / move / remove / same / changed；全平 / 部分平（网关 volume=0、桥接覆盖 volume、
    pos_volume 为空）；撤挂单从原挂单补信息；
  · closed_trades：各 reason、GATEWAY_COMMENT_PREFIX 可配置、平台腿盈亏配给 CLOSE 指令、
    共享账号只留一行；reason 为空的老行按备注推断（SQL 与 Python 逐行同口径）；
  · 自动追踪止损页内合并、一键平仓子单与统计、activity_events 每种 kind、注册（Google 注册
    那一刻的邀请试用并入）；
  · 审计：backend/app 里写到的每一个 field 族都有对应的 kind（扫源码），认不出的落 admin.other。

Translation of every source row into {kind, params, …}, including the audit field
map — checked against every field literal backend/app actually writes.
"""
import pathlib
import re
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.core.config import settings
from app.core.database import Base
import app.models  # noqa: F401  —— 注册模型 / registers the tables
from app.models import (
    ActivityEvent, AdminAuditLog, Announcement, ClosedTrade, Competition, CompetitionParticipant,
    EmailCampaign, InviteLink, MT5Account, Order, Ticket, User,
)
from app.services import activity_feed as feed
from app.services import activity_log as al
from app.services.order_payload import GATEWAY_STALE_ORDER_MESSAGE, STALE_ORDER_MESSAGE

T0 = datetime(2026, 10, 9, 6, 0, 0)
LOGIN = "51234567"
BACKEND = pathlib.Path(__file__).resolve().parents[1]


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


_seq = {"n": 0}


def _next() -> int:
    _seq["n"] += 1
    return _seq["n"]


def _user(db, email="a@t.co", *, at=T0 - timedelta(days=1), **kw) -> User:
    u = User(email=email, api_token="tok_" + email, created_at=at, **kw)
    db.add(u)
    db.commit()
    return u


def _acc(db, user, login=LOGIN, *, source="gateway", trade_mode=2, **kw) -> MT5Account:
    a = MT5Account(user_id=user.id, login=login, server=kw.pop("server", "srv"), source=source,
                   trade_mode=trade_mode, **kw)
    db.add(a)
    db.commit()
    return a


def _order(db, user, *, at=T0, action="ORDER", status="FILLED", login=LOGIN, cid=None, **kw) -> Order:
    kw.setdefault("symbol", "XAUUSD")
    kw.setdefault("side", "BUY")
    kw.setdefault("volume", 0.1)
    o = Order(user_id=user.id, client_order_id=cid or f"co_{_next()}", action=action, status=status,
              mt5_login=login, created_at=at, **kw)
    db.add(o)
    db.commit()
    return o


def _deal(db, user, *, at=T0, reason="SL", login=LOGIN, pos=None, deal=None, closed_at=None, **kw) -> ClosedTrade:
    n = _next()
    kw.setdefault("symbol", "XAUUSD")
    kw.setdefault("side", "BUY")
    kw.setdefault("close_volume", 0.1)
    kw.setdefault("close_price", 2400.0)
    kw.setdefault("profit", -5.0)
    t = ClosedTrade(user_id=user.id, mt5_login=login, position_ticket=pos or 9000 + n,
                    deal_ticket=deal or 7000 + n, closed_at=closed_at or at, created_at=at, reason=reason, **kw)
    db.add(t)
    db.commit()
    return t


def _audit(db, actor, target, field, old, new, *, at=T0, op=None) -> AdminAuditLog:
    a = AdminAuditLog(admin_user_id=actor.id, target_user_id=target.id, field=field,
                      old_value=old, new_value=new, created_at=at, op_id=op)
    db.add(a)
    db.commit()
    return a


def _event(db, kind, user, *, at=T0, login=None, data=None, actor_type="user", ref=None) -> ActivityEvent:
    e = ActivityEvent(kind=kind, user_id=user.id, actor_type=actor_type,
                      actor_id=user.id if actor_type == "user" else None, mt5_login=login, ref_id=ref,
                      data=al.encode_data(data), created_at=at)
    db.add(e)
    db.commit()
    return e


def _items(db, **kw) -> list[dict]:
    out, cursor = [], None
    while True:
        page = feed.list_activity(db, cursor=cursor, limit=100, **kw)
        out.extend(page["items"])
        cursor = page["next"]
        if cursor is None:
            return out


def _one(db, key, **kw) -> dict:
    found = [it for it in _items(db, **kw) if it["key"] == key]
    assert len(found) == 1, f"{key} 出现 {len(found)} 次"
    return found[0]


# ── orders：kind / status / note / tags ──────────────────────────────────────

@pytest.mark.parametrize("action,cid,kind", [
    ("ORDER", None, "trade.open"),
    ("PENDING", None, "pending.place"),
    ("MODIFY_PENDING", None, "pending.modify"),
    ("CANCEL_PENDING", None, "pending.cancel"),
    ("CLOSE", None, "trade.close"),
    ("CLOSE", "auto_tp_123_ab12cd34", "auto.partial_tp"),
    ("MODIFY", None, "sltp.modify"),
    ("MODIFY", "auto_be_123_ab12cd34", "auto.sl"),
    ("MODIFY", "auto_trail_123_ab12cd34", "auto.sl"),
    ("MODIFY", "auto_restore_123_ab12cd34", "auto.sl"),
    ("MODIFY", "auto_sl_123_ab12cd34", "auto.sl"),
    ("TELEPORT", None, "trade.other"),
])
def test_order_action_and_prefix_to_kind(db, action, cid, kind):
    u = _user(db)
    o = _order(db, u, action=action, cid=cid, ticket=123)
    it = _one(db, f"o:{o.id}", cat="trade")
    assert it["kind"] == kind and it["cat"] == "trade"
    auto = bool(cid and cid.startswith("auto_"))
    assert it["actor"]["type"] == ("auto" if auto else "self")
    assert ("auto" in it["tags"]) is auto
    if kind == "auto.sl":
        mode = cid.split("_")[1]
        assert it["params"]["mode"] == (mode if mode in ("be", "trail", "restore") else None)
    if kind == "trade.other":
        assert it["params"]["action"] == "TELEPORT"


@pytest.mark.parametrize("status,message,expected,note,abnormal", [
    ("PENDING", None, "pending", None, False),
    ("FILLED", "", "ok", None, False),
    ("REJECTED", "MT_RET_REQUEST_NO_MONEY: no money", "fail", None, True),
    ("FAILED", "request_failed: timeout", "unknown", None, True),
    ("FAILED", STALE_ORDER_MESSAGE, "cancelled", "timeout", True),
    ("FAILED", GATEWAY_STALE_ORDER_MESSAGE, "unknown", "timeout_unknown", True),
    ("CANCELLED", "用户已撤销 / Cancelled by user", "cancelled", "user_cancelled", False),
])
def test_order_status_mapping(db, status, message, expected, note, abnormal):
    u = _user(db)
    o = _order(db, u, status=status, message=message)
    it = _one(db, f"o:{o.id}")
    assert it["status"] == expected
    assert it["params"]["note"] == note
    assert it["params"]["msg"] == (message or None)
    assert it["abnormal"] is abnormal


_ACTIONS = {
    "ORDER": "trade.open", "PENDING": "pending.place", "MODIFY_PENDING": "pending.modify",
    "CANCEL_PENDING": "pending.cancel", "CLOSE": "trade.close", "MODIFY": "sltp.modify",
}
_STATUSES = {"PENDING": "pending", "FILLED": "ok", "PLACED": "ok", "REJECTED": "fail",
             "FAILED": "unknown", "CANCELLED": "cancelled"}
_PREFIXES = ("co_", "auto_be_", "auto_tp_", "ca_")


def test_order_action_status_prefix_cross_product(db):
    """action × status × 指令号前缀 全组合：kind、状态、操作人、异常、是否单独出行。
    一键平仓子单（ca_）平时不单独出行，只看异常时失败 / 未知的才出来。
    Every action × status × id prefix: kind, status, actor, abnormal, visibility.
    Close-all children only show on their own under the abnormal filter, and only
    when failed or unknown."""
    u = _user(db)
    made = {}
    n = 0
    for action in _ACTIONS:
        for status in _STATUSES:
            for prefix in _PREFIXES:
                n += 1
                cid = f"{prefix}{n}_x" if prefix != "ca_" else f"ca_co_{n}#{LOGIN}#{n}"
                o = _order(db, u, action=action, status=status, cid=cid, ticket=n, at=T0 + timedelta(seconds=n))
                made[o.id] = (action, status, prefix)
    shown = {it["key"]: it for it in _items(db, cat="trade")}
    abnormal = {it["key"]: it for it in _items(db, cat="trade", abnormal=1)}
    for oid, (action, status, prefix) in made.items():
        key = f"o:{oid}"
        auto = prefix.startswith("auto_")
        kind = _ACTIONS[action]
        if auto and action == "CLOSE":
            kind = "auto.partial_tp"
        if auto and action == "MODIFY":
            kind = "auto.sl"
        is_abnormal = status in ("REJECTED", "FAILED")
        if prefix == "ca_":
            assert key not in shown, (action, status)
        else:
            it = shown[key]
            assert (it["kind"], it["status"]) == (kind, _STATUSES[status]), (action, status, prefix)
            assert it["actor"]["type"] == ("auto" if auto else "self")
            assert it["abnormal"] is is_abnormal
        assert (key in abnormal) is is_abnormal, (action, status, prefix)
        if key in abnormal:
            assert abnormal[key]["kind"] == kind


def test_open_params_source_and_unprotected(db):
    u = _user(db)
    chart = _order(db, u, filled_price=2401.5, sl=2390.0, tp=0.0)
    strat = _order(db, u, source="STRATEGY")
    naked = _order(db, u, message="成交了，但 SL/TP 设置失败: invalid stops")
    p = _one(db, f"o:{chart.id}")["params"]
    assert p == {"sym": "XAUUSD", "side": "BUY", "vol": 0.1, "px": 2401.5, "sl": 2390.0, "tp": None,
                 "src": "CHART", "msg": None, "note": None}
    assert _one(db, f"o:{strat.id}")["params"]["src"] == "STRAT"
    it = _one(db, f"o:{naked.id}")
    assert it["status"] == "ok" and "unprotected" in it["tags"] and it["abnormal"] is True
    assert it["params"]["note"] == "sltp_failed"
    assert {i["key"] for i in _items(db, abnormal=1)} == {f"o:{naked.id}"}


def test_pending_place_modify_and_cancel_fill_from_the_original(db):
    u = _user(db)
    placed = _order(db, u, action="PENDING", status="PLACED", side="SELL", volume=0.3, price=2450.0,
                    pending_type="SELL_LIMIT", sl=2460.0, tp=2400.0, mt5_ticket=555, mt5_position=555)
    mod = _order(db, u, action="MODIFY_PENDING", side="BUY", volume=0.0, ticket=555, price=2455.0,
                 sl=2465.0, tp=0.0, at=T0 + timedelta(minutes=1))
    cancel = _order(db, u, action="CANCEL_PENDING", side="BUY", volume=0.0, ticket=555,
                    at=T0 + timedelta(minutes=2))
    assert _one(db, f"o:{placed.id}")["params"] == {
        "sym": "XAUUSD", "side": "SELL", "vol": 0.3, "price": 2450.0, "ptype": "SELL_LIMIT",
        "sl": 2460.0, "tp": 2400.0, "src": "CHART", "msg": None, "note": None,
    }
    assert _one(db, f"o:{placed.id}")["status"] == "ok"
    assert _one(db, f"o:{mod.id}")["params"] == {
        "ticket": 555, "sym": "XAUUSD", "price": 2455.0, "sl": 2465.0, "tp": None,
        "sl_op": "set", "tp_op": "remove", "msg": None, "note": None,
    }
    # 撤单指令本身的 side=BUY / volume=0 是占位，不能显示 / placeholders are not shown
    assert _one(db, f"o:{cancel.id}")["params"] == {
        "ticket": 555, "sym": "XAUUSD", "side": "SELL", "vol": 0.3, "price": 2450.0,
        "ptype": "SELL_LIMIT", "msg": None, "note": None,
    }


@pytest.mark.parametrize("price,sl,tp,sl_op,tp_op", [
    # 图表上只拖触发价：止损止盈都没传（= 保留券商上的现值）/ trigger-only drag: SL/TP untouched
    (2455.0, None, None, "keep", "keep"),
    # 只拖止损线：止盈没动，不能说成「不设止盈」/ SL-only drag must not read as "TP removed"
    (None, 2465.0, None, "set", "keep"),
    (None, None, 2410.0, "keep", "set"),
    # 传 0 = 清除 / 0 clears
    (None, 0.0, None, "remove", "keep"),
    (2455.0, 2465.0, 0.0, "set", "remove"),
])
def test_pending_modify_keeps_untouched_sltp_apart_from_cleared(db, price, sl, tp, sl_op, tp_op):
    """PositionOverlay 每次只发一项（另外两项 undefined = 保留现值，落库 NULL）：「没动」与
    「清掉了」（0）必须分开。
    The chart sends one field per edit (the others undefined = keep, stored NULL):
    untouched and cleared (0) must stay apart."""
    u = _user(db)
    mod = _order(db, u, action="MODIFY_PENDING", side="BUY", volume=0.0, ticket=555, price=price, sl=sl, tp=tp)
    p = _one(db, f"o:{mod.id}")["params"]
    assert (p["sl_op"], p["tp_op"]) == (sl_op, tp_op)
    assert p["price"] == price
    assert p["sl"] == (sl if sl_op == "set" else None) and p["tp"] == (tp if tp_op == "set" else None)


# ── 止盈止损 / SL-TP ops ─────────────────────────────────────────────────────

@pytest.mark.parametrize("prev,new,op", [
    (0.0, 2390.0, "set"),
    (2380.0, 2390.0, "move"),
    (2380.0, 0.0, "remove"),
    (2390.0, 2390.0, "same"),
    (0.0, 0.0, "same"),
    (None, 2390.0, "changed"),
    (None, 0.0, "changed"),
])
def test_sltp_ops(db, prev, new, op):
    u = _user(db)
    o = _order(db, u, action="MODIFY", ticket=77, volume=0.0, sl=new, tp=2500.0, prev_sl=prev, prev_tp=2500.0,
               pos_volume=0.2)
    p = _one(db, f"o:{o.id}")["params"]
    assert p["sl_op"] == op and p["tp_op"] == "same"
    assert p["sl"] == (new or None) and p["prev_sl"] == (prev or None)
    assert p["pos_vol"] == 0.2


# ── 全平 / 部分平 / full vs partial close ────────────────────────────────────

@pytest.mark.parametrize("source,volume,pos_volume,partial,vol,remain", [
    ("gateway", 0.0, 0.3, False, 0.3, None),     # 网关 volume=0 = 全平
    ("gateway", 0.1, 0.3, True, 0.1, 0.2),
    ("gateway", 0.3, 0.3, False, 0.3, None),     # 请求手数 = 持仓手数，也是全平
    ("gateway", 0.1, None, True, 0.1, None),     # 网关保留请求手数：volume>0 一定是部分平
    ("bridge", 0.3, 0.3, False, 0.3, None),      # 桥接把 volume 覆盖成实际成交手数
    ("bridge", 0.1, 0.3, True, 0.1, 0.2),
    ("bridge", 0.3, None, None, 0.3, None),      # 桥接 + pos_volume 不知道：说不准
])
def test_full_vs_partial_close(db, source, volume, pos_volume, partial, vol, remain):
    u = _user(db)
    _acc(db, u, source=source)
    o = _order(db, u, action="CLOSE", ticket=88, volume=volume, pos_volume=pos_volume, status="PENDING")
    it = _one(db, f"o:{o.id}")
    p = it["params"]
    assert (p["partial"], p["vol"], p["remain"], p["pos_vol"]) == (partial, vol, remain, pos_volume)
    assert ("partial" in it["tags"]) is bool(partial)
    assert p["pnl"] is None and p["pnl_pending"] is False   # 还在处理中 / still pending
    assert it["account"] == {"channel": source, "demo": False, "removed": False, "revoked": False}


def test_unknown_pos_volume_on_a_login_that_was_once_bridged_is_not_called_partial(db):
    """pos_volume 为空的旧行：账号先走桥接（已解绑）、后改直连。桥接回执把全平的 volume 改写成
    成交手数，所以不能按「现在是直连」就判部分平——有桥接指纹或有过桥接行就说不准（None）；
    有网关成交指纹（message 清空、mt5_ticket 是平仓单号而非仓位号）才是部分平。
    Pre-rev-38 rows (no pos_volume) on a login moved from bridge to gateway: a bridge
    receipt rewrites a full close's volume, so the current channel can't decide.
    A bridge fingerprint or any bridge row -> unknown; a gateway fill fingerprint
    -> partial."""
    from app.services.gateway_binding import REASON_USER_REMOVED

    u = _user(db)
    _acc(db, u, source="bridge", revoked_reason=REASON_USER_REMOVED, revoked_at=T0 - timedelta(days=3))
    _acc(db, u, source="gateway", server="")
    bridge_full = _order(db, u, action="CLOSE", ticket=88, volume=0.5, pos_volume=None,
                         message="Position closed", mt5_ticket=88, filled_price=2400.0)
    no_receipt = _order(db, u, action="CLOSE", ticket=89, volume=0.5, pos_volume=None, status="REJECTED",
                        message="MT_RET_REQUEST_REJECT", at=T0 + timedelta(seconds=1))
    gateway_partial = _order(db, u, action="CLOSE", ticket=90, volume=0.1, pos_volume=None, message="",
                             mt5_ticket=123456789, filled_price=2401.0, at=T0 + timedelta(seconds=2))
    for o, partial in ((bridge_full, None), (no_receipt, None), (gateway_partial, True)):
        it = _one(db, f"o:{o.id}")
        assert it["params"]["partial"] is partial, o.ticket
        assert ("partial" in it["tags"]) is bool(partial)
    # 只有直连行、看不出通道：网关保留请求手数，volume>0 就是部分平（原有规则不变）
    # Gateway rows only, no fingerprint: the old rule stands
    v = _user(db, "v@t.co")
    _acc(db, v, "62345678", source="gateway")
    o = _order(db, v, action="CLOSE", ticket=91, volume=0.1, pos_volume=None, status="PENDING", login="62345678")
    assert _one(db, f"o:{o.id}")["params"]["partial"] is True


def test_close_on_a_gone_position(db):
    u = _user(db)
    _acc(db, u, source="bridge")
    o = _order(db, u, action="CLOSE", ticket=88, volume=0.1, pos_volume=0.3, message="Position already closed")
    it = _one(db, f"o:{o.id}")
    assert it["status"] == "ok" and "gone" in it["tags"]
    # 什么都没平：请求是部分平也不标「部分平仓」/ nothing closed, so no partial tag
    assert it["params"]["partial"] is True and "partial" not in it["tags"]
    assert it["params"]["gone"] is True and it["params"]["pnl_pending"] is False
    assert it["params"]["note"] == "gone"


# ── closed_trades ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("reason,shown,actor", [
    ("SL", "SL", "broker"), ("TP", "TP", "broker"), ("SO", "SO", "broker"),
    ("MOBILE", "MOBILE", "self"), ("CLIENT", "CLIENT", "self"), ("WEB", "WEB", "self"),
    ("DEALER", "OTHER", "broker"), (None, "OTHER", "broker"), ("WEIRD", "OTHER", "broker"),
])
def test_deal_reasons(db, reason, shown, actor):
    u = _user(db)
    t = _deal(db, u, reason=reason, comment="manual" if reason == "DEALER" else None)
    it = _one(db, f"d:{t.id}")
    assert it["kind"] == "deal.close" and it["params"]["reason"] == shown
    assert it["actor"]["type"] == actor
    assert ("stopout" in it["tags"]) is (reason == "SO") and it["abnormal"] is (reason == "SO")
    assert it["at"] == "2026-10-09T06:00:00.000000Z"


def test_deal_late_tag_and_at(db):
    u = _user(db)
    t = _deal(db, u, at=T0, closed_at=T0 - timedelta(hours=3))
    it = _one(db, f"d:{t.id}")
    assert "late" in it["tags"]
    assert it["ts"] == "2026-10-09T06:00:00.000000Z" and it["at"] == "2026-10-09T03:00:00.000000Z"


def test_platform_legs_follow_the_configurable_prefix(db, monkeypatch):
    u = _user(db)
    ours_default = _deal(db, u, reason="DEALER", comment="PRISMX-SIG")
    ours_bridge = _deal(db, u, reason="EXPERT", comment="prismx close")       # 不分大小写
    acme = _deal(db, u, reason="DEALER", comment="ACME-CHART")
    keys = {it["key"] for it in _items(db, cat="trade")}
    assert f"d:{ours_default.id}" not in keys and f"d:{ours_bridge.id}" not in keys
    assert f"d:{acme.id}" in keys
    monkeypatch.setattr(settings, "GATEWAY_COMMENT_PREFIX", "ACME")
    keys = {it["key"] for it in _items(db, cat="trade")}
    assert f"d:{acme.id}" not in keys and f"d:{ours_default.id}" in keys
    # 前缀配成空 = 只看 reason / empty prefix: reason alone decides
    monkeypatch.setattr(settings, "GATEWAY_COMMENT_PREFIX", "")
    assert not {f"d:{t.id}" for t in (ours_default, ours_bridge, acme)} & {it["key"] for it in _items(db)}


def test_platform_leg_pnl_is_matched_to_close_commands(db):
    u = _user(db)
    _acc(db, u)
    pos = 4242
    partial = _order(db, u, action="CLOSE", ticket=pos, volume=0.2, pos_volume=0.5, at=T0)
    full = _order(db, u, action="CLOSE", ticket=pos, volume=0.0, pos_volume=0.3, at=T0 + timedelta(minutes=5))
    # 部分平那一秒里来了两条腿：手数相等的那条配给它 / the equal-volume leg wins
    _deal(db, u, pos=pos, reason="DEALER", comment="PRISMX-CHART", close_volume=0.1, profit=1.0,
          at=T0 + timedelta(seconds=1))
    _deal(db, u, pos=pos, reason="DEALER", comment="PRISMX-CHART", close_volume=0.2, profit=7.5,
          at=T0 + timedelta(seconds=2))
    _deal(db, u, pos=pos, reason="DEALER", comment="PRISMX-CHART", close_volume=0.3, profit=-2.25,
          at=T0 + timedelta(minutes=5, seconds=1))
    p1 = _one(db, f"o:{partial.id}")["params"]
    p2 = _one(db, f"o:{full.id}")["params"]
    assert (p1["pnl"], p1["pnl_pending"], p1["partial"]) == (7.5, False, True)
    # 全平那条只配得到它之后入库的腿；早先多出来的 0.1 那条不会被挪过来
    # The full close only takes legs recorded after it; the stray 0.1 leg stays unused
    assert (p2["pnl"], p2["pnl_pending"], p2["partial"]) == (-2.25, False, False)
    # 平台腿本身不单独出行 / platform legs are not lines of their own
    assert not [it for it in _items(db) if it["kind"] == "deal.close"]


def test_unmatched_close_is_pnl_pending_and_old_legs_are_not_reused(db):
    u = _user(db)
    _acc(db, u)
    _deal(db, u, pos=99, reason="DEALER", comment="PRISMX-SIG", profit=3.0, at=T0 - timedelta(seconds=30))
    o = _order(db, u, action="CLOSE", ticket=99, volume=0.0, at=T0)
    p = _one(db, f"o:{o.id}")["params"]
    assert p["pnl"] is None and p["pnl_pending"] is True


def _pages_items(db, limit, **kw) -> list[dict]:
    out, cursor = [], None
    while True:
        page = feed.list_activity(db, cursor=cursor, limit=limit, **kw)
        out.extend(page["items"])
        cursor = page["next"]
        if cursor is None:
            return out


@pytest.mark.parametrize("limit", [1, 50])
def test_leg_pnl_is_not_taken_across_a_page_boundary(db, limit):
    """部分平 A（0.2 手）的腿 LA 晚 0.5 秒入库；3 秒后全平 B（剩 0.3 手）的腿 LB 晚 0.5 秒入库。
    页边界落在 A、B 之间时，B 不能把（上一页那条）A 的腿抢走——每笔盈亏只出现一次。
    Partial A (0.2) with leg LA 0.5s later, full B (remaining 0.3) 3s later with leg
    LB 0.5s after it. With a page boundary between them B must not take A's leg:
    every P&L shows exactly once."""
    u = _user(db)
    _acc(db, u)
    pos = 888
    a = _order(db, u, action="CLOSE", ticket=pos, volume=0.2, pos_volume=0.5, at=T0)
    b = _order(db, u, action="CLOSE", ticket=pos, volume=0.0, pos_volume=0.3, at=T0 + timedelta(seconds=3))
    _deal(db, u, pos=pos, reason="DEALER", comment="PRISMX-CHART", close_volume=0.2, profit=10.0,
          at=T0 + timedelta(milliseconds=500))
    _deal(db, u, pos=pos, reason="DEALER", comment="PRISMX-CHART", close_volume=0.3, profit=-4.0,
          at=T0 + timedelta(seconds=3, milliseconds=500))
    items = {it["key"]: it for it in _pages_items(db, limit, cat="trade")}
    assert items[f"o:{a.id}"]["params"]["pnl"] == 10.0
    assert items[f"o:{b.id}"]["params"]["pnl"] == -4.0


def test_full_close_whose_leg_has_not_synced_does_not_take_the_previous_leg(db):
    """LB 还没同步回来：B 是「盈亏同步中」，不能拿 5 秒窗口里 A 那条手数对不上的腿。
    LB not synced yet: B is pending, never A's leg of the wrong size."""
    u = _user(db)
    _acc(db, u)
    pos = 889
    a = _order(db, u, action="CLOSE", ticket=pos, volume=0.2, pos_volume=0.5, at=T0)
    b = _order(db, u, action="CLOSE", ticket=pos, volume=0.0, pos_volume=0.3, at=T0 + timedelta(seconds=3))
    _deal(db, u, pos=pos, reason="DEALER", comment="PRISMX-CHART", close_volume=0.2, profit=10.0,
          at=T0 + timedelta(milliseconds=500))
    for limit in (1, 50):
        items = {it["key"]: it for it in _pages_items(db, limit, cat="trade")}
        pa, pb = items[f"o:{a.id}"]["params"], items[f"o:{b.id}"]["params"]
        assert pa["pnl"] == 10.0, limit
        assert (pb["pnl"], pb["pnl_pending"]) == (None, True), limit


def test_close_on_a_gone_position_never_shows_the_real_closes_pnl(db):
    """桥接重复平仓：真正平掉的 R，2 秒后又一条「Position already closed」的 G。G 什么都没平，
    无论页怎么切都不能带上 R 的盈亏。
    A bridge double close: R really closed, G 2s later answered "already closed".
    G closed nothing and must never show R's P&L, however the pages fall."""
    u = _user(db)
    _acc(db, u, source="bridge")
    pos = 890
    r = _order(db, u, action="CLOSE", ticket=pos, volume=0.1, pos_volume=0.1, message="Position closed",
                mt5_ticket=pos, at=T0)
    g = _order(db, u, action="CLOSE", ticket=pos, volume=0.1, pos_volume=0.1, message="Position already closed",
                at=T0 + timedelta(seconds=2))
    _deal(db, u, pos=pos, reason="EXPERT", comment="PRISMX close", close_volume=0.1, profit=12.5,
          at=T0 + timedelta(milliseconds=500))
    for limit in (1, 50):
        items = {it["key"]: it for it in _pages_items(db, limit, cat="trade")}
        assert items[f"o:{r.id}"]["params"]["pnl"] == 12.5, limit
        pg = items[f"o:{g.id}"]["params"]
        assert (pg["gone"], pg["pnl"], pg["pnl_pending"]) == (True, None, False), limit


def test_null_reason_legs_are_shown_not_silently_dropped(db, monkeypatch):
    """reason 为空的腿（老版网关不报 reason）：SQL 与 _is_platform_leg 同口径——不是平台腿，就要
    单独出行（以前 NOT(NULL IN …) 是 NULL，整行被滤掉，盈亏哪儿都看不到）。备注带平台前缀的
    老腿是平台腿（见下面的 legacy 测试）；前缀配成空时它没有任何平台证据，也单独出行。
    NULL-reason legs (older gateways sent none) that aren't platform legs must show
    up — NOT (NULL IN …) used to be NULL and dropped them, P&L and all. A prefixed
    one is a platform leg (see the legacy tests); with an empty prefix it is shown."""
    u = _user(db)
    prismx = _deal(db, u, reason=None, comment="PRISMX abc")
    bare = _deal(db, u, reason=None, comment=None)
    empty = _deal(db, u, reason=None, comment="")
    sl = _deal(db, u, reason="SL", comment="sl 1.0")
    ours = _deal(db, u, reason="DEALER", comment="PRISMX-SIG")
    items = {it["key"]: it for it in _items(db, cat="trade")}
    assert {f"d:{t.id}" for t in (bare, empty, sl)} <= set(items)
    assert f"d:{ours.id}" not in items and f"d:{prismx.id}" not in items
    # reason 为空、备注也空：「其它」/ blank reason and blank comment: OTHER
    assert items[f"d:{bare.id}"]["params"]["reason"] == items[f"d:{empty.id}"]["params"]["reason"] == "OTHER"
    monkeypatch.setattr(settings, "GATEWAY_COMMENT_PREFIX", "")
    items = {it["key"]: it for it in _items(db, cat="trade")}
    assert {f"d:{t.id}" for t in (prismx, bare, empty, sl)} <= set(items) and f"d:{ours.id}" not in items
    assert items[f"d:{prismx.id}"]["params"]["reason"] == "OTHER"


# ── 老平仓腿：reason 为空，原因写在备注里 / legacy legs: blank reason, reason in the comment ──

# (reason, comment, 有效 reason, 显示的 reason, 是否平台腿) —— 默认前缀 PRISMX
# (reason, comment, effective reason, shown reason, platform leg) — default prefix PRISMX
_LEGACY_SHAPES = [
    (None, "[sl 4123.45]", "SL", "SL", False),
    (None, "[tp 1.0850]", "TP", "TP", False),
    (None, "[so 49.12%/1234.56/2400.00]", "SO", "SO", False),
    (None, "[SL 4123.45]", "SL", "SL", False),          # 不分大小写 / case-insensitive
    ("", "[tp 2400]", "TP", "TP", False),               # 空串 reason 与 NULL 同样处理 / '' like NULL
    (None, "PRISMX close", "DEALER", "OTHER", True),
    (None, "prismx-sig", "DEALER", "OTHER", True),
    (None, "", "OTHER", "OTHER", False),
    (None, None, "OTHER", "OTHER", False),
    (None, "sl 4123.45", "OTHER", "OTHER", False),      # 没有方括号不算 / no bracket, no inference
    (None, "manual note", "OTHER", "OTHER", False),
    ("MOBILE", "[sl 4123.45]", "MOBILE", "MOBILE", False),   # reason 有值就用它 / a set reason wins
    ("SL", "[tp 1.0]", "SL", "SL", False),
    ("DEALER", "PRISMX-SIG", "DEALER", "OTHER", True),
    ("EXPERT", "PRISMX close", "EXPERT", "OTHER", True),
    ("DEALER", "manual", "DEALER", "OTHER", False),     # 券商交易员平仓 / a dealer close
    ("dealer", "PRISMX-SIG", "DEALER", "OTHER", True),
    ("ROLLOVER", None, "ROLLOVER", "OTHER", False),
]


@pytest.mark.parametrize("reason,comment,effective,shown,platform", _LEGACY_SHAPES)
def test_legacy_reason_is_inferred_from_the_comment(db, reason, comment, effective, shown, platform):
    u = _user(db)
    t = _deal(db, u, reason=reason, comment=comment)
    assert feed._effective_reason(t) == effective
    assert feed._is_platform_leg(t) is platform
    keys = {it["key"] for it in _items(db)}
    if platform:
        assert f"d:{t.id}" not in keys
        return
    it = _one(db, f"d:{t.id}")
    assert it["params"]["reason"] == shown
    assert ("stopout" in it["tags"]) is (effective == "SO") and it["abnormal"] is (effective == "SO")
    assert it["actor"]["type"] == ("self" if effective == "MOBILE" else "broker")


@pytest.mark.parametrize("prefix", ["PRISMX", "ACME", ""])
def test_effective_reason_sql_matches_python(db, monkeypatch, prefix):
    """SQL（CASE / 平台腿条件）与 Python 逐行同口径，而且条件永远不是 NULL：平台腿与非平台腿
    正好把全部行分成两半，一行不丢。
    SQL and Python agree row by row and the conditions are never NULL: platform and
    non-platform legs partition every row."""
    monkeypatch.setattr(settings, "GATEWAY_COMMENT_PREFIX", prefix)
    u = _user(db)
    rows = [_deal(db, u, reason=r, comment=c) for r, c, *_ in _LEGACY_SHAPES]
    rows.append(_deal(db, u, reason=None, comment="ACME-CHART"))
    eff = dict(db.query(ClosedTrade.id, feed._effective_reason_sql()).all())
    plat = {i for (i,) in db.query(ClosedTrade.id).filter(feed._platform_leg_cond())}
    rest = {i for (i,) in db.query(ClosedTrade.id).filter(~feed._platform_leg_cond())}
    for t in rows:
        assert eff[t.id] == feed._effective_reason(t), (t.reason, t.comment)
        assert (t.id in plat) is feed._is_platform_leg(t), (t.reason, t.comment)
    assert plat | rest == {t.id for t in rows} and not plat & rest
    for values in (("SL", "TP"), ("SO",)):
        hit = {i for (i,) in db.query(ClosedTrade.id).filter(feed._effective_reason_sql().in_(values))}
        miss = {i for (i,) in db.query(ClosedTrade.id).filter(feed._effective_reason_sql().notin_(values))}
        assert hit == {t.id for t in rows if feed._effective_reason(t) in values}
        assert hit | miss == {t.id for t in rows} and not hit & miss


def test_legacy_platform_leg_pnl_lands_on_the_close_command(db, monkeypatch):
    """2026-09 中旬之前的平台平仓腿 reason 为空、备注 PRISMX…：照样是平台腿——盈亏补到 CLOSE 指令上
    （不再一直「盈亏同步中」），也不单独冒出一行「其它」，详情的完整经过里同样不单列。前缀配成空时
    没有平台证据：腿单独出行，指令那边是「盈亏同步中」。
    A pre-mid-September platform leg (blank reason, PRISMX comment) is still a
    platform leg: its P&L lands on the CLOSE command (no longer stuck syncing), with
    no extra "other" line, in the list and the detail timeline alike. With an empty
    prefix there's no platform evidence: the leg shows and the command is pending."""
    from app.services import deps

    monkeypatch.setattr(deps, "is_account_online", lambda row: False)
    u = _user(db)
    _acc(db, u)
    pos = 6060
    o = _order(db, u, action="CLOSE", ticket=pos, volume=0.0, pos_volume=0.2, at=T0)
    leg = _deal(db, u, pos=pos, reason=None, comment="PRISMX close", close_volume=0.2, profit=-12.5,
                at=T0 + timedelta(seconds=1))
    p = _one(db, f"o:{o.id}")["params"]
    assert (p["pnl"], p["pnl_pending"]) == (-12.5, False)
    assert f"d:{leg.id}" not in {it["key"] for it in _items(db)}
    position = feed.get_item(db, f"o:{o.id}")["position"]
    assert [s["kind"] for s in position["steps"]] == ["trade.close"]
    assert position["steps"][0]["params"]["pnl"] == -12.5 and position["total_pnl"] == -12.5
    monkeypatch.setattr(settings, "GATEWAY_COMMENT_PREFIX", "")
    p = _one(db, f"o:{o.id}")["params"]
    assert (p["pnl"], p["pnl_pending"]) == (None, True)
    assert _one(db, f"d:{leg.id}")["params"]["reason"] == "OTHER"


def test_legacy_reasons_drive_sub_tabs_and_the_abnormal_filter(db):
    """子分类与「只看异常」按有效 reason：老的 `[sl …]` / `[tp …]` 在「止盈止损」，`[so …]` 是异常，
    reason 与备注都空的在「开平仓」；两个子分类不重不漏地分完全部成交行。
    Sub-tabs and the abnormal filter use the effective reason; the two sub-tabs
    partition the deal lines exactly."""
    u = _user(db)
    rows = {
        "sl": _deal(db, u, reason=None, comment="[sl 4123.45]", at=T0),
        "tp": _deal(db, u, reason=None, comment="[tp 4180.00]", at=T0 + timedelta(seconds=1)),
        "so": _deal(db, u, reason=None, comment="[so 49.12%/1234.56/2400.00]", at=T0 + timedelta(seconds=2)),
        "bare": _deal(db, u, reason=None, comment="", at=T0 + timedelta(seconds=3)),
        "modern_sl": _deal(db, u, reason="SL", comment="[sl 4100.00]", at=T0 + timedelta(seconds=4)),
        "mobile": _deal(db, u, reason="MOBILE", comment="", at=T0 + timedelta(seconds=5)),
    }
    _deal(db, u, reason=None, comment="PRISMX close", at=T0 + timedelta(seconds=6))   # 平台腿 / platform leg
    key = {k: f"d:{t.id}" for k, t in rows.items()}

    def deals(**kw) -> set[str]:
        return {it["key"] for it in _items(db, **kw) if it["kind"] == "deal.close"}

    assert deals(cat="trade") == set(key.values())
    assert deals(cat="trade", sub="sltp") == {key["sl"], key["tp"], key["modern_sl"]}
    assert deals(cat="trade", sub="open_close") == {key["so"], key["bare"], key["mobile"]}
    assert deals(abnormal=1) == {key["so"]}
    assert deals(cat="trade", abnormal=1, sub="open_close") == {key["so"]}


def test_leg_numbers_on_a_split_position(db):
    u = _user(db)
    _deal(db, u, pos=500, reason="DEALER", comment="PRISMX-SIG", at=T0, closed_at=T0)
    sl = _deal(db, u, pos=500, reason="SL", at=T0 + timedelta(minutes=1))
    p = _one(db, f"d:{sl.id}")["params"]
    assert (p["leg_k"], p["leg_n"]) == (2, 2)


def test_shared_login_collapses_without_user_filter(db):
    a = _user(db, "a@t.co", nickname="A")
    b = _user(db, "b@t.co", nickname="B")
    _acc(db, a)
    _acc(db, b)
    ta = _deal(db, a, deal=123456, pos=777, reason="MOBILE")
    tb = _deal(db, b, deal=123456, pos=777, reason="MOBILE")
    rows = [it for it in _items(db) if it["kind"] == "deal.close"]
    assert len(rows) == 1
    it = rows[0]
    assert "shared_login" in it["tags"]
    assert {h["email"] for h in it["params"]["holders"]} == {"a@t.co", "b@t.co"}
    # 按用户筛：各看各的那一份 / with a user filter each sees their own copy
    assert [i["key"] for i in _items(db, user_id=b.id) if i["kind"] == "deal.close"] == [f"d:{tb.id}"]
    assert [i["key"] for i in _items(db, user_id=a.id) if i["kind"] == "deal.close"] == [f"d:{ta.id}"]


# ── 自动追踪止损合并 / trailing-stop merge ────────────────────────────────────

def test_consecutive_trailing_moves_merge_in_page(db):
    u = _user(db)
    moves = [
        _order(db, u, action="MODIFY", cid=f"auto_trail_321_{i:08d}", ticket=321, volume=0.0,
               sl=2400.0 + i, prev_sl=2399.0 + i, at=T0 + timedelta(minutes=i))
        for i in range(3)
    ]
    # 中间插一条手动改单：打断连续 / a manual modify breaks the run
    _order(db, u, action="MODIFY", ticket=321, volume=0.0, sl=2405.0, prev_sl=2402.0, at=T0 + timedelta(minutes=4))
    later = _order(db, u, action="MODIFY", cid="auto_trail_321_99999999", ticket=321, volume=0.0,
                   sl=2410.0, prev_sl=2405.0, at=T0 + timedelta(minutes=5))
    # 别的仓位不受影响 / another position is separate
    other = _order(db, u, action="MODIFY", cid="auto_trail_654_00000000", ticket=654, volume=0.0,
                   sl=10.0, prev_sl=9.0, at=T0 + timedelta(minutes=1, seconds=30))
    items = [it for it in _items(db, cat="trade") if it["kind"] == "auto.sl"]
    merged = [it for it in items if it["children"]]
    assert len(merged) == 1
    m = merged[0]
    # key 带两头：最新那次 + 最早那次 / the key names both ends: newest and oldest
    assert m["key"] == f"t:{moves[-1].id}:{moves[0].id}"
    assert m["params"]["moves"] == 3 and m["params"]["sl"] == 2402.0 and m["params"]["prev_sl"] == 2399.0
    assert [c["key"] for c in m["children"]] == [f"o:{o.id}" for o in reversed(moves)]
    singles = {it["key"] for it in items if not it["children"]}
    assert singles == {f"o:{later.id}", f"o:{other.id}"}


def test_trailing_moves_on_different_beijing_days_do_not_merge(db):
    u = _user(db)
    # UTC 15:59 = 北京 23:59；UTC 16:01 = 北京次日 00:01
    a = _order(db, u, action="MODIFY", cid="auto_trail_1_aaaaaaaa", ticket=1, volume=0.0, sl=1.0,
               at=datetime(2026, 10, 9, 15, 59))
    b = _order(db, u, action="MODIFY", cid="auto_trail_1_bbbbbbbb", ticket=1, volume=0.0, sl=2.0,
               at=datetime(2026, 10, 9, 16, 1))
    keys = [it["key"] for it in _items(db) if it["kind"] == "auto.sl"]
    assert keys == [f"o:{b.id}", f"o:{a.id}"]


# ── 一键平仓 / close-all ─────────────────────────────────────────────────────

def test_close_all_row_with_children_and_stats(db):
    u = _user(db)
    _acc(db, u)
    _acc(db, u, "62345678")
    batch = "ca_co_17_ab"
    k1 = _order(db, u, action="CLOSE", cid=f"{batch}#{LOGIN}#1", ticket=1, volume=0.0, at=T0)
    k2 = _order(db, u, action="CLOSE", cid=f"{batch}#{LOGIN}#2", ticket=2, volume=0.0, at=T0)
    k3 = _order(db, u, action="CLOSE", cid=f"{batch}#{LOGIN}#3", ticket=3, volume=0.0, status="REJECTED",
                message="MT_RET_REQUEST_REJECT", at=T0)
    k4 = _order(db, u, action="CLOSE", cid=f"{batch}#62345678#4", ticket=4, volume=0.0, login="62345678", at=T0)
    _deal(db, u, pos=1, reason="DEALER", comment="PRISMX-CHART", profit=10.0, at=T0 + timedelta(seconds=1))
    ev = _event(db, al.TRADE_CLOSE_ALL, u, at=T0, login=LOGIN, ref=batch, data={"count": 3, "skipped": 1})
    ev2 = _event(db, al.TRADE_CLOSE_ALL, u, at=T0, login="62345678", ref=batch, data={"count": 1, "skipped": 1})
    items = _items(db)
    # 子单不单独出行 / children are not lines of their own
    assert not {f"o:{o.id}" for o in (k1, k2, k3, k4)} & {it["key"] for it in items}
    row = _one(db, f"e:{ev.id}")
    assert row["kind"] == "trade.close_all" and row["cat"] == "trade"
    assert row["params"] == {"count": 3, "skipped": 1, "filled": 2, "failed": 1, "unknown": 0, "pending": 0,
                             "cancelled": 0, "pnl": 10.0, "pnl_pending": True}
    assert row["status"] == "fail" and row["abnormal"] is True
    assert [c["key"] for c in row["children"]] == [f"o:{o.id}" for o in sorted((k1, k2, k3), key=lambda o: o.id)]
    assert all(c["kind"] == "trade.close" and c["children"] is None for c in row["children"])
    row2 = _one(db, f"e:{ev2.id}")
    assert [c["key"] for c in row2["children"]] == [f"o:{k4.id}"] and row2["status"] == "ok"
    # 只看异常：有失败子单的那一行 + 失败的子单本身 / abnormal: the row and the failed child
    assert {it["key"] for it in _items(db, abnormal=1)} == {f"e:{ev.id}", f"o:{k3.id}"}


def test_close_all_with_a_stale_voided_child_is_abnormal(db):
    """桥接上一张子单被超时作废（FAILED + STALE_ORDER_MESSAGE，页面状态 cancelled）：这一行与
    子单同一条异常规则——不筛也标异常；「只看异常」时每一行都是 abnormal=true。
    A bridge child voided as stale (FAILED + STALE_ORDER_MESSAGE, shown cancelled):
    the row follows the children's rule — abnormal unfiltered, and every row of the
    abnormal view is abnormal."""
    u = _user(db)
    _acc(db, u, source="bridge")
    batch = "ca_co_99_ab"
    _order(db, u, action="CLOSE", cid=f"{batch}#{LOGIN}#1", ticket=1, volume=0.0, at=T0)
    stale = _order(db, u, action="CLOSE", cid=f"{batch}#{LOGIN}#2", ticket=2, volume=0.0, status="FAILED",
                   message=STALE_ORDER_MESSAGE, at=T0)
    ev = _event(db, al.TRADE_CLOSE_ALL, u, at=T0, login=LOGIN, ref=batch, data={"count": 2, "skipped": 0})
    row = _one(db, f"e:{ev.id}")
    assert row["status"] == "cancelled" and row["abnormal"] is True
    items = _items(db, abnormal=1)
    assert {it["key"] for it in items} == {f"e:{ev.id}", f"o:{stale.id}"}
    assert all(it["abnormal"] for it in items)


def test_abnormal_close_all_only_counts_children_near_the_row(db):
    """「只看异常」里一键平仓行的子查询只看这一行前后 10 分钟内的子单（子单只在同一个请求里建）。
    The abnormal filter's close-all subquery only looks at children within 10
    minutes of the row (children are created in the same request)."""
    u = _user(db)
    _acc(db, u)
    near, far = "ca_co_1_near", "ca_co_2_far"
    _order(db, u, action="CLOSE", cid=f"{near}#{LOGIN}#1", ticket=1, volume=0.0, status="REJECTED",
           at=T0 + timedelta(seconds=1))
    _order(db, u, action="CLOSE", cid=f"{far}#{LOGIN}#2", ticket=2, volume=0.0, status="REJECTED",
           at=T0 + timedelta(hours=1))
    _order(db, u, action="CLOSE", cid=f"{far}#{LOGIN}#3", ticket=3, volume=0.0, status="FAILED",
           at=T0 - timedelta(hours=1))
    ev_near = _event(db, al.TRADE_CLOSE_ALL, u, at=T0, login=LOGIN, ref=near, data={"count": 1})
    ev_far = _event(db, al.TRADE_CLOSE_ALL, u, at=T0, login=LOGIN, ref=far, data={"count": 2})
    keys = {it["key"] for it in _items(db, cat="trade", abnormal=1)}
    assert f"e:{ev_near.id}" in keys and f"e:{ev_far.id}" not in keys


# ── activity_events ──────────────────────────────────────────────────────────

def test_event_kinds_params_tags_and_account(db):
    u = _user(db, nickname="Neo")
    _acc(db, u, trade_mode=0, revoked_reason="password_changed", revoked_at=T0)
    bind = _event(db, al.MT5_BIND, u, login=LOGIN,
                  data={"ch": "gateway", "revived": True, "name": "Neo", "demo": True, "bal": 1000.0, "server": None})
    unbind_bf = _event(db, al.MT5_UNBIND, u, login=LOGIN, data={"ch": "bridge", "name": "", "bf": 1},
                       at=T0 - timedelta(days=30))
    revoked = _event(db, al.MT5_REVOKED, u, login=LOGIN, actor_type="system", data={"reason": "password_changed"})
    login = _event(db, al.USER_LOGIN, u, data={"method": "google", "new_source": False})
    it = _one(db, f"e:{bind.id}")
    assert it["cat"] == "mt5" and it["actor"]["type"] == "self"
    assert it["params"] == {"ch": "gateway", "revived": True, "name": "Neo", "demo": True, "bal": 1000.0, "server": None}
    assert it["account"] == {"channel": "gateway", "demo": True, "removed": False, "revoked": True}
    assert it["user"] == {"id": u.id, "nickname": "Neo", "email": "a@t.co"}
    bf = _one(db, f"e:{unbind_bf.id}")
    assert bf["tags"] == ["backfill"] and bf["params"] == {"ch": "bridge", "name": None, "bal": None}
    rv = _one(db, f"e:{revoked.id}")
    assert rv["actor"]["type"] == "system" and "revoked" in rv["tags"] and rv["abnormal"] is True
    lg = _one(db, f"e:{login.id}")
    assert lg["cat"] == "account" and lg["params"] == {"method": "google", "new_source": False}
    assert lg["login"] is None and lg["account"] is None


def test_every_event_kind_has_a_category_and_kind():
    assert al.KINDS <= feed.KINDS
    for k in feed.KINDS:
        assert feed.KIND_CATEGORY[k] in ("account", "mt5", "trade", "admin")


# ── 注册 / sign-up ───────────────────────────────────────────────────────────

def test_register_email_and_google_with_folded_trial(db):
    db.add(InviteLink(code="abcd2345", label="FB 投放"))
    db.commit()
    email_user = _user(db, "e@t.co", at=T0, invite_code="abcd2345")
    google_user = _user(db, "g@t.co", at=T0 + timedelta(minutes=1), invite_code="abcd2345",
                        google_linked_at=T0 + timedelta(minutes=1))
    folded = _audit(db, google_user, google_user, "plan:invite_trial", "FREE", "PRO(7d)",
                    at=T0 + timedelta(minutes=1, milliseconds=5))
    # 邮箱注册的试用是验证邮箱时（几分钟后）发的：单独一行 / granted on verification: its own line
    later = _audit(db, email_user, email_user, "plan:invite_trial", "FREE", "PRO(7d)", at=T0 + timedelta(minutes=10))
    items = {it["key"]: it for it in _items(db, cat="account")}
    assert items[f"u:{email_user.id}"]["params"] == {
        "method": "email", "invite_code": "abcd2345", "invite_label": "FB 投放", "trial_plan": None, "trial_days": None,
    }
    assert items[f"u:{google_user.id}"]["params"] == {
        "method": "google", "invite_code": "abcd2345", "invite_label": "FB 投放", "trial_plan": "PRO", "trial_days": 7,
    }
    assert f"a:{folded.id}" not in items
    assert items[f"a:{later.id}"]["kind"] == "plan.invite_trial"
    assert items[f"a:{later.id}"]["params"] == {"plan": "PRO", "days": 7, "invite_code": "abcd2345", "invite_label": "FB 投放"}
    assert items[f"a:{later.id}"]["actor"]["type"] == "system"
    # 注册行不在时间窗里：试用那一行就不能收掉 / sign-up outside the window: keep the trial line
    keys = {it["key"] for it in _items(db, since=(T0 + timedelta(minutes=1, milliseconds=1)).isoformat() + "Z")}
    assert f"a:{folded.id}" in keys and f"u:{google_user.id}" not in keys


# ── 审计 / admin audit ───────────────────────────────────────────────────────

def _audit_field_literals() -> set[str]:
    """backend/app 里写进 admin_audit_logs 的全部 field 字面量（f-string 的占位换成样例值）。
    Every audit field literal backend/app writes, placeholders filled with samples."""
    pats = [
        re.compile(r'\b_?log_change\(\s*db\w*\s*,\s*[^,]+,\s*[^,]+,\s*(f?"[^"]*")', re.S),
        re.compile(r'\bfield\s*=\s*(f?"[^"]*")\s*,\s*old_value', re.S),
        re.compile(r'_payment_audit\(\s*db\s*,\s*record\s*,\s*(f?"[^"]*")', re.S),
    ]
    settings_pat = re.compile(r'_log_settings_diff\(\s*db\s*,\s*[^,]+,\s*"([^"]*)"', re.S)
    out: set[str] = set()
    for path in (BACKEND / "app").rglob("*.py"):
        src = path.read_text(encoding="utf-8")
        for pat in pats:
            for m in pat.finditer(src):
                lit = m.group(1)
                lit = lit[2:-1] if lit.startswith("f") else lit[1:-1]
                lit = lit.replace("{_AGENT_EXTEND_AUDIT_SUFFIX}", ":extend_days")
                out.add(re.sub(r"\{[^}]*\}", "x1", lit))
        for m in settings_pat.finditer(src):
            out.add(f"setting:{m.group(1)}:some_key")
    return out


def test_every_audit_field_written_in_the_app_has_a_kind():
    fields = _audit_field_literals()
    # 扫描本身没坏：已知的几十个字段都在 / the scan itself still works
    assert {"role", "plan", "account:disable", "email:send", "plan:auto_expire", "payment:finished_mismatch",
            "ops:x1", "invite:x1", "agent:x1:extend_days", "competition:settle:x1"} <= fields
    assert len(fields) >= 40
    unmapped = [f for f in fields if (feed._audit_family(f) or "").startswith("other:")]
    assert unmapped == [], f"这些 field 没有对应的 kind，会落进 admin.other：{unmapped}"


def _g(items: dict, rows) -> dict:
    """组的 key 是组里最新那一行（同一时间戳按 id 倒序）的 id。
    A group's key uses its newest row (ties broken by id, descending)."""
    found = [items[f"g:{r.id}"] for r in rows if f"g:{r.id}" in items]
    assert len(found) == 1, found
    return found[0]


def _audit_kinds(db, **kw) -> dict[str, dict]:
    return {it["key"]: it for it in _items(db, **kw) if it["cat"] in ("admin", "account")}


def test_admin_user_field_families(db):
    admin = _user(db, "admin@t.co", role="admin", nickname="Boss")
    t = _user(db, "t@t.co", nickname="T")
    db.add_all([InviteLink(code="oldc0de1", label="旧链接", deleted_at=T0), InviteLink(code="newc0de2", label="新链接")])
    db.commit()
    role = _audit(db, admin, t, "role", "user", "admin", op="r1", at=T0)
    plan = [
        _audit(db, admin, t, "plan", "FREE", "PRO", op="p1", at=T0 + timedelta(minutes=1)),
        _audit(db, admin, t, "plan_expires_at", "2026-10-01 00:00:00", "2026-11-01 00:00:00+00:00", op="p1",
               at=T0 + timedelta(minutes=1)),
        _audit(db, admin, t, "plan_note", "", "KOL", op="p1", at=T0 + timedelta(minutes=1)),
    ]
    attr = _audit(db, admin, t, "invite_code", "oldc0de1", "newc0de2", op="i1", at=T0 + timedelta(minutes=2))
    mixed = [
        _audit(db, admin, t, "role", "admin", "user", op="m1", at=T0 + timedelta(minutes=3)),
        _audit(db, admin, t, "invite_code", "newc0de2", "", op="m1", at=T0 + timedelta(minutes=3)),
    ]
    items = _audit_kinds(db, cat="admin")
    r = items[f"a:{role.id}"]
    assert r["kind"] == "admin.user_role" and r["params"] == {"old": "user", "new": "admin"}
    assert r["actor"] == {"type": "admin", "id": admin.id, "name": "Boss", "email": "admin@t.co"}
    assert r["user"] == {"id": t.id, "nickname": "T", "email": "t@t.co"}
    p = _g(items, plan)
    assert p["kind"] == "admin.user_plan"
    assert p["params"] == {"plan": ["FREE", "PRO"],
                           "expires": ["2026-10-01T00:00:00.000000Z", "2026-11-01T00:00:00.000000Z"],
                           "note": [None, "KOL"]}
    a = items[f"a:{attr.id}"]
    assert a["kind"] == "admin.user_attribution"
    assert a["params"] == {"old": "oldc0de1", "new": "newc0de2", "old_label": "旧链接", "new_label": "新链接"}
    m = _g(items, mixed)
    assert m["kind"] == "admin.user_edit"
    assert m["params"]["role"] == ["admin", "user"] and m["params"]["invite"] == ["newc0de2", None]
    assert m["params"]["invite_label"] == ["新链接", None] and m["params"]["plan"] is None


def test_plan_expiry_timezone_noise_is_dropped(db):
    admin = _user(db, "admin@t.co", role="admin")
    t = _user(db, "t@t.co")
    noise = _audit(db, admin, t, "plan_expires_at", "2026-10-08 16:05:58.582909",
                   "2026-10-08 16:05:58.582909+00:00", at=T0)
    keep = _audit(db, admin, t, "plan_expires_at", "2026-10-08 16:05:58", "2026-11-08T16:05:58", at=T0 + timedelta(minutes=1))
    keys = set(_audit_kinds(db))
    assert f"a:{noise.id}" not in keys and f"a:{keep.id}" in keys


def test_admin_account_settings_ops_and_links(db):
    admin = _user(db, "admin@t.co", role="admin")
    agent = _user(db, "agent@t.co", nickname="Agent")
    t = _user(db, "t@t.co")
    db.add(InviteLink(code="link0001", label="渠道 A"))
    db.commit()
    rows = {
        "disable": _audit(db, admin, t, "account:disable", '{"disabledAt": null, "reason": null}',
                          '{"disabledAt": "2026-10-09T06:00:00", "reason": "刷单"}', op="o1", at=T0),
        "enable": _audit(db, admin, t, "account:enable", '{"disabledAt": "2026-10-09T06:00:00", "reason": "刷单"}',
                         '{"disabledAt": null, "reason": null}', op="o2", at=T0 + timedelta(minutes=1)),
        "verify": _audit(db, admin, t, "account:verify_email", "unverified", "verified", op="o3", at=T0 + timedelta(minutes=2)),
        "broker": _audit(db, admin, admin, "setting:broker_lock_enabled", "false", "true", op="o4", at=T0 + timedelta(minutes=3)),
        "pricing": [
            _audit(db, admin, admin, "setting:pricing:monthly", "29", "39", op="o5", at=T0 + timedelta(minutes=4)),
            _audit(db, admin, admin, "setting:pricing:yearly", "199", "299", op="o5", at=T0 + timedelta(minutes=4)),
        ],
        "gami": _audit(db, admin, admin, "gamification:competitions_public_enabled", "false", "true", op="o6",
                       at=T0 + timedelta(minutes=5)),
        "ops": _audit(db, admin, admin, "ops:restart-loop:candles", "", "scheduled", op="o7", at=T0 + timedelta(minutes=6)),
        "create": _audit(db, admin, admin, "invite:link0001", "",
                         '{"label": "渠道 A", "isActive": true, "grantsTrial": true, "competitionId": null, '
                         '"channel": "FB", "openAccountUrl": null}', op="o8", at=T0 + timedelta(minutes=7)),
        "update": _audit(db, agent, agent, "invite:link0001",
                         '{"label": "渠道 A", "isActive": true, "openAccountUrl": null}',
                         '{"label": "渠道 A", "isActive": true, "openAccountUrl": "https://x.example/a"}',
                         op="o9", at=T0 + timedelta(minutes=8)),
        "delete": _audit(db, admin, admin, "invite:link0001", '{"label": "渠道 A", "isActive": true}',
                         '{"deleted": "soft"}', op="o10", at=T0 + timedelta(minutes=9)),
        "assign": _audit(db, admin, agent, "invite:link0001:agent", "", "assigned", op="o11", at=T0 + timedelta(minutes=10)),
        "unassign": _audit(db, admin, agent, "invite:link0001:agent", "assigned", "", op="o12", at=T0 + timedelta(minutes=11)),
        "agent_plan": [
            _audit(db, agent, t, "agent:link0001:plan", "FREE", "PRO", op="o13", at=T0 + timedelta(minutes=12)),
            _audit(db, agent, t, "agent:link0001:plan_expires_at", "", "2026-11-09 06:00:00", op="o13",
                   at=T0 + timedelta(minutes=12)),
            _audit(db, agent, t, "agent:link0001:extend_days", "0", "30", op="o13", at=T0 + timedelta(minutes=12)),
        ],
    }
    items = _audit_kinds(db)
    it = items[f"a:{rows['disable'].id}"]
    assert (it["kind"], it["params"], it["abnormal"]) == ("admin.user_disable", {"reason": "刷单", "was_disabled": False}, True)
    assert items[f"a:{rows['enable'].id}"]["params"] == {"prev_reason": "刷单"}
    assert items[f"a:{rows['verify'].id}"]["kind"] == "admin.verify_email"
    b = items[f"a:{rows['broker'].id}"]
    assert b["kind"] == "admin.setting" and b["user"] is None
    assert b["params"] == {"group": None, "key": "broker_lock_enabled", "old": False, "new": True,
                           "changes": [{"group": None, "key": "broker_lock_enabled", "old": False, "new": True}]}
    pr = _g(items, rows['pricing'])["params"]
    assert pr["group"] == "pricing" and pr["key"] is None and len(pr["changes"]) == 2
    assert {"group": "pricing", "key": "yearly", "old": 199, "new": 299} in pr["changes"]
    g = items[f"a:{rows['gami'].id}"]
    assert g["kind"] == "admin.gamification" and g["params"]["key"] == "competitions_public_enabled"
    assert (g["params"]["old"], g["params"]["new"]) == (False, True)
    assert items[f"a:{rows['ops'].id}"]["params"] == {"action": "restart-loop", "target": "candles", "result": "scheduled"}
    c = items[f"a:{rows['create'].id}"]
    assert c["kind"] == "admin.invite_link" and c["params"]["action"] == "create" and c["params"]["label"] == "渠道 A"
    assert {"field": "grantsTrial", "old": None, "new": True} in c["params"]["changes"]
    u = items[f"a:{rows['update'].id}"]
    assert u["actor"]["type"] == "agent"           # 操作人当前不是管理员 / actor's current role
    assert u["params"]["changes"] == [{"field": "openAccountUrl", "old": None, "new": "https://x.example/a"}]
    d = items[f"a:{rows['delete'].id}"]
    assert d["params"]["action"] == "delete" and d["params"]["mode"] == "soft" and d["actor"]["type"] == "admin"
    asg = items[f"a:{rows['assign'].id}"]
    assert asg["kind"] == "admin.agent_assign"
    assert asg["params"]["agent"] == {"id": agent.id, "nickname": "Agent", "email": "agent@t.co"}
    assert asg["params"]["old_agent"] is None and asg["params"]["label"] == "渠道 A"
    un = items[f"a:{rows['unassign'].id}"]
    assert un["params"]["agent"] is None and un["params"]["old_agent"]["id"] == agent.id
    ap = _g(items, rows['agent_plan'])
    assert ap["kind"] == "agent.plan" and ap["actor"]["type"] == "agent" and ap["user"]["id"] == t.id
    assert ap["params"] == {"code": "link0001", "label": "渠道 A", "plan": "PRO", "old_plan": "FREE", "days": 30,
                            "old_expires": None, "new_expires": "2026-11-09T06:00:00.000000Z"}


def test_admin_competitions_announcements_emails_tickets(db):
    admin = _user(db, "admin@t.co", role="admin")
    player = _user(db, "p@t.co", nickname="Player")
    comp = Competition(name="十月赛", starts_at=T0, ends_at=T0 + timedelta(days=30))
    db.add(comp)
    db.commit()
    part = CompetitionParticipant(competition_id=comp.id, user_id=player.id, mt5_login=LOGIN)
    ann = Announcement(title_zh="国庆公告", title_en="Holiday")
    camp = EmailCampaign(created_by=admin.id, subject_zh="十月活动", kind="marketing")
    ticket = Ticket(user_id=player.id, title="出金问题", category="payment")
    db.add_all([part, ann, camp, ticket])
    db.commit()
    rows = {
        "c_create": _audit(db, admin, admin, f"competition:{comp.id}:create", "", "十月赛", op="c1", at=T0),
        "c_patch": [
            _audit(db, admin, admin, f"competition:{comp.id}:status", "draft", "upcoming", op="c2", at=T0 + timedelta(minutes=1)),
            _audit(db, admin, admin, f"competition:{comp.id}:minTrades", "", "5", op="c2", at=T0 + timedelta(minutes=1)),
            _audit(db, admin, admin, f"competition:{comp.id}:publicView", "False", "True", op="c2", at=T0 + timedelta(minutes=1)),
            _audit(db, admin, admin, f"competition:{comp.id}:startsAt", "2026-10-09 06:00:00",
                   "2026-10-10 06:00:00+00:00", op="c2", at=T0 + timedelta(minutes=1)),
        ],
        "c_settle": [
            _audit(db, admin, admin, f"competition:settle:{comp.id}", "ended", "settled", op="c3", at=T0 + timedelta(minutes=2)),
            _audit(db, admin, admin, f"competition:{comp.id}:acknowledgeFlags", "", "51234567", op="c3",
                   at=T0 + timedelta(minutes=2)),
        ],
        "c_delete": _audit(db, admin, admin, "competition:gone-id:delete", "旧比赛", "deleted", op="c4", at=T0 + timedelta(minutes=3)),
        "dq": _audit(db, admin, player, f"competition:participant:{part.id}:disqualified", "False:None", "True:刷单",
                     op="c5", at=T0 + timedelta(minutes=4)),
        "hide": _audit(db, admin, player, f"competition:participant:{part.id}:nameHidden", "False", "True",
                       op="c6", at=T0 + timedelta(minutes=5)),
        "a_create": _audit(db, admin, admin, "announcement:create", "", f'{{"id": "{ann.id}", "published": true}}',
                           op="a1", at=T0 + timedelta(minutes=6)),
        "a_delete": _audit(db, admin, admin, "announcement:delete", "旧公告", "", op="a2", at=T0 + timedelta(minutes=7)),
        "e_send": _audit(db, admin, admin, "email:send", "",
                         f'{{"id": "{camp.id}", "kind": "marketing", "recipients": 120}}', op="m1", at=T0 + timedelta(minutes=8)),
        "e_cancel": _audit(db, admin, admin, "email:cancel", "sending", f'{{"id": "{camp.id}", "status": "cancelled"}}',
                           op="m2", at=T0 + timedelta(minutes=9)),
        "ticket": [
            _audit(db, admin, player, f"ticket:{ticket.id}:status", "open", "closed", op="t1", at=T0 + timedelta(minutes=10)),
            _audit(db, admin, player, f"ticket:{ticket.id}:reply", "", "您好，已处理", op="t1", at=T0 + timedelta(minutes=10)),
        ],
    }
    items = _audit_kinds(db, cat="admin")
    cc = items[f"a:{rows['c_create'].id}"]
    assert cc["kind"] == "admin.competition" and cc["user"] is None
    assert cc["params"] == {"comp_id": comp.id, "name": "十月赛", "action": "create", "changes": []}
    cp = _g(items, rows['c_patch'])["params"]
    assert cp["action"] == "update" and cp["name"] == "十月赛"
    ch = {c["field"]: (c["old"], c["new"]) for c in cp["changes"]}
    assert ch == {"status": ("draft", "upcoming"), "minTrades": (None, 5), "publicView": (False, True),
                  "startsAt": ("2026-10-09T06:00:00.000000Z", "2026-10-10T06:00:00.000000Z")}
    cs = _g(items, rows['c_settle'])["params"]
    assert cs["action"] == "settle" and cs["changes"] == [{"field": "acknowledgeFlags", "old": None, "new": "51234567"}]
    cd = items[f"a:{rows['c_delete'].id}"]["params"]
    assert (cd["action"], cd["name"], cd["comp_id"]) == ("delete", "旧比赛", "gone-id")
    dq = items[f"a:{rows['dq'].id}"]
    assert dq["kind"] == "admin.competition_participant" and dq["login"] == LOGIN
    assert dq["user"]["id"] == player.id
    assert dq["params"] == {"comp_id": comp.id, "name": "十月赛", "participant_id": part.id, "action": "disqualify",
                            "reason": "刷单", "name_hidden": None}
    assert items[f"a:{rows['hide'].id}"]["params"]["action"] == "hide_name"
    assert items[f"a:{rows['a_create'].id}"]["params"] == {"action": "create", "title": "国庆公告", "published": True,
                                                            "was_published": None}
    assert items[f"a:{rows['a_delete'].id}"]["params"]["title"] == "旧公告"
    assert items[f"a:{rows['e_send'].id}"]["params"] == {"action": "send", "campaign_id": camp.id, "count": 120,
                                                          "subject": "十月活动", "mail_kind": "marketing"}
    assert items[f"a:{rows['e_cancel'].id}"]["params"]["action"] == "cancel"
    tk = _g(items, rows['ticket'])
    assert tk["kind"] == "admin.ticket" and tk["user"]["id"] == player.id
    assert tk["params"]["subject"] == "出金问题" and tk["params"]["field"] is None
    assert {"field": "status", "old": "open", "new": "closed"} in tk["params"]["changes"]
    assert {"field": "reply", "old": None, "new": "您好，已处理"} in tk["params"]["changes"]


def test_account_category_system_rows(db):
    u = _user(db, "u@t.co")
    rows = {
        "claim": _audit(db, u, u, "plan:trial_claim", "FREE", "PRO(7d)", at=T0),
        "pay": _audit(db, u, u, "plan:payment", "FREE(None)", "PRO(2026-11-09 06:00:00+00:00)", at=T0 + timedelta(minutes=1)),
        "refund": _audit(db, u, u, "plan:refund", "PRO(2026-11-09 06:00:00)", "FREE(None)", at=T0 + timedelta(minutes=2)),
        "skip": _audit(db, u, u, "plan:refund_skipped", "PRO(None)", "skip:covered_by_other_payment",
                       at=T0 + timedelta(minutes=3)),
        "mismatch": _audit(db, u, u, "payment:finished_mismatch", "waiting", "actually_paid 9 < pay_amount 10",
                           at=T0 + timedelta(minutes=4)),
        "after": _audit(db, u, u, "payment:refund_after_finished", "FINISHED", "REFUNDED", at=T0 + timedelta(minutes=5)),
    }
    items = _audit_kinds(db, cat="account")
    claim = items[f"a:{rows['claim'].id}"]
    assert claim["kind"] == "plan.trial_claim" and claim["actor"]["type"] == "self"
    assert claim["params"] == {"plan": "PRO", "days": 7, "expires_at": "2026-10-16T06:00:00.000000Z"}
    assert items[f"a:{rows['pay'].id}"]["params"] == {"old_plan": "FREE", "new_plan": "PRO", "old_expires": None,
                                                      "expires_at": "2026-11-09T06:00:00.000000Z"}
    rf = items[f"a:{rows['refund'].id}"]
    assert rf["kind"] == "plan.refund" and rf["abnormal"] is True and rf["actor"]["type"] == "system"
    sk = items[f"a:{rows['skip'].id}"]
    assert sk["kind"] == "plan.payment_issue" and sk["params"]["field"] == "refund_skipped"
    mm = items[f"a:{rows['mismatch'].id}"]
    assert mm["params"] == {"field": "finished_mismatch", "old": "waiting", "new": "actually_paid 9 < pay_amount 10"}
    assert mm["abnormal"] is True
    assert items[f"a:{rows['after'].id}"]["abnormal"] is False
    for it in items.values():
        assert it["cat"] == "account" and it["user"]["id"] == u.id


def test_unknown_fields_fall_back_to_admin_other(db):
    admin = _user(db, "admin@t.co", role="admin")
    t = _user(db, "t@t.co")
    rows = [
        _audit(db, admin, t, "weird:thing", "a", '{"x": 1}', at=T0),
        _audit(db, admin, admin, "account:freeze", "", "yes", at=T0 + timedelta(minutes=1)),
        _audit(db, admin, t, "plan:mystery", "", "1", at=T0 + timedelta(minutes=2)),
        _audit(db, admin, admin, "announcement:pin", "", "1", at=T0 + timedelta(minutes=3)),
    ]
    items = _audit_kinds(db)
    for r in rows:
        it = items[f"a:{r.id}"]
        assert it["kind"] == "admin.other" and it["cat"] == "admin"
        assert it["params"]["field"] == r.field and it["params"]["changes"][0]["field"] == r.field
    assert items[f"a:{rows[0].id}"]["params"]["new"] == {"x": 1}
    assert items[f"a:{rows[0].id}"]["user"]["id"] == t.id
    assert items[f"a:{rows[1].id}"]["user"] is None          # 自己占位 / actor standing in


def test_a_row_that_fails_to_translate_does_not_break_the_page(db, monkeypatch, caplog):
    """某一行数据出乎意料、翻译抛错：整页照常返回，审计行退回 admin.other 原样显示，其它行
    保留 kind；都记一条 warning。
    One untranslatable row never 500s the page: audit rows fall back to admin.other,
    other rows keep their kind; a warning is logged."""
    admin = _user(db, "admin@t.co", role="admin")
    a = _audit(db, admin, admin, "setting:pricing:monthly", "29", "39", at=T0)
    o = _order(db, admin, at=T0 + timedelta(minutes=1))

    def boom(*args, **kwargs):
        raise RuntimeError("bad row")

    monkeypatch.setattr(feed, "_audit_params", boom)
    monkeypatch.setattr(feed, "_order_params", boom)
    with caplog.at_level("WARNING", logger="prismx.activity_feed"):
        items = {it["key"]: it for it in _items(db)}
    fa = items[f"a:{a.id}"]
    assert fa["kind"] == "admin.other"
    assert fa["params"]["changes"] == [{"field": "setting:pricing:monthly", "old": "29", "new": "39"}]
    assert items[f"o:{o.id}"]["kind"] == "trade.open"
    assert "fell back" in caplog.text


def test_legacy_bulk_edit_without_op_id(db):
    admin = _user(db, "admin@t.co", role="admin")
    ts = [_user(db, f"t{i}@t.co") for i in range(3)]
    rows = [_audit(db, admin, t, "invite_code", "", "abcd2345", at=T0 + timedelta(milliseconds=10 * i))
            for i, t in enumerate(ts)]
    items = [it for it in _items(db, cat="admin")]
    assert len(items) == 1
    b = items[0]
    assert b["kind"] == "admin.bulk_edit" and b["key"] == f"g:{rows[-1].id}"
    assert b["users_count"] == 3 and b["user"] is None
    assert b["params"] == {"users_count": 3, "changes": [{"field": "invite_code", "new": "abcd2345"}]}
    assert {c["user"]["id"] for c in b["children"]} == {t.id for t in ts}
    assert all(c["kind"] == "admin.user_attribution" for c in b["children"])
