"""订单生命周期测试：下单幂等、过期拒单、桥接下发/重发、回执幂等、超时作废。
Order lifecycle tests: idempotent placement, expired-signal rejection, bridge
delivery & re-delivery, idempotent results, stale-pending voiding.
"""
from datetime import datetime, timedelta, timezone

from app.core.config import settings
from app.models import Order
from tests.conftest import BROKER_SERVER, get_order, make_account, make_signal


def place(client, auth_headers, coid="c-1", **kw):
    payload = {
        "symbol": "XAUUSD",
        "side": "BUY",
        "volume": 0.1,
        "clientOrderId": coid,
        "signalId": None,
        **kw,
    }
    return client.post("/api/orders", json=payload, headers=auth_headers)


def poll(client, bridge_headers, login="10001"):
    # 上报的服务器名须命中券商锁关键字（默认 "MakeCapital"），否则账号被券商锁
    # 拒绝、不上线，指令永不下发。与 conftest.make_account 用同一服务器名。
    # The reported server name must match the broker-lock keyword (default
    # "MakeCapital") or the account is rejected, never comes online, and no
    # command is ever dispatched. Same server name as conftest.make_account.
    return client.post(
        "/api/bridge/poll",
        json={"accounts": [{"login": login, "server": BROKER_SERVER}]},
        headers=bridge_headers,
    )


# ---------- 下单 / placement ----------


def test_place_order_pending_and_idempotent(client, auth_headers):
    r1 = place(client, auth_headers, coid="dup-1")
    assert r1.status_code == 200
    assert r1.json()["status"] == "PENDING"

    # 同一 clientOrderId 再提交：返回同一单，不重复创建
    r2 = place(client, auth_headers, coid="dup-1", volume=5.0)
    assert r2.status_code == 200
    assert r2.json()["id"] == r1.json()["id"]
    assert r2.json()["volume"] == 0.1


def test_place_order_on_expired_signal_rejected(client, auth_headers, db):
    sig = make_signal(db, minutes_left=-1)
    r = place(client, auth_headers, coid="exp-1", signalId=sig.id)
    assert r.status_code == 409


def test_volume_limits(client, auth_headers):
    assert place(client, auth_headers, coid="v-min", volume=0.001).status_code == 400
    assert place(client, auth_headers, coid="v-max", volume=settings.MAX_VOLUME_PER_ORDER + 1).status_code == 400


def test_equity_based_volume_cap(client, auth_headers, db, user):
    # 净值 200，EQUITY_PER_LOT=200 → 上限约 1 手
    make_account(db, user, login="10001", equity=200.0)
    assert place(client, auth_headers, coid="eq-1", volume=2.0, mt5Login="10001").status_code == 400
    assert place(client, auth_headers, coid="eq-2", volume=0.5, mt5Login="10001").status_code == 200


# ---------- 免费版信号门槛 / free-tier signal gating ----------


def test_free_user_cannot_place_signal_order(client, auth_headers, db, user):
    """FREE 只能用行情图表手动下单，不能跟信号下单：带 signalId 且信号仍有效时，
    FREE 直接调 /api/orders 会被 403 拒绝。/ FREE may trade manually from the
    chart but not follow signals: a FREE user placing an order with a signalId on
    a still-live signal is rejected with 403."""
    user.plan = "FREE"
    db.commit()
    sig = make_signal(db, minutes_left=10)  # 仍有效 / still live
    assert place(client, auth_headers, coid="fs-1", signalId=sig.id).status_code == 403


def test_free_user_can_place_manual_chart_order(client, auth_headers, db, user):
    """不带 signalId 的手动图表下单：FREE 也放行（免费用户的下单入口就是行情图表）。
    Manual chart order (no signalId): allowed for FREE too — the chart is the
    free tier's trading entry point."""
    user.plan = "FREE"
    db.commit()
    assert place(client, auth_headers, coid="fm-1").status_code == 200


# ---------- 账户数上限 / account cap ----------


def test_free_plan_caps_bound_accounts_on_poll(client, bridge_headers, db, user):
    """降级到 FREE（账户上限 1）后，之前绑定的多余账号在桥接轮询时被拒、转离线——
    不再只拦"新账号超额"。保留的是按 login 升序的第一个（10001），10002 被拒。
    After a downgrade to FREE (account cap 1), the extra already-bound account is
    rejected on the bridge poll and goes offline — not just new over-cap accounts.
    The kept one is the first by ascending login (10001); 10002 is rejected."""
    user.plan = "FREE"
    make_account(db, user, login="10001")
    make_account(db, user, login="10002")
    db.commit()
    r = client.post(
        "/api/bridge/poll",
        json={"accounts": [
            {"login": "10001", "server": BROKER_SERVER},
            {"login": "10002", "server": BROKER_SERVER},
        ]},
        headers=bridge_headers,
    )
    assert r.json()["accountLimitExceeded"] == ["10002"]


# ---------- 桥接下发与重发 / bridge delivery & re-delivery ----------


def test_bridge_poll_delivers_once_within_ack_window(client, auth_headers, bridge_headers, db, user):
    # 指定目标账号必须是已绑定的自己的账号（下单归属校验）——先建账号再下单，
    # 与真实流程一致：用户只能选到自己已连接过的账号。
    make_account(db, user, login="10001")
    r = place(client, auth_headers, coid="d-1", mt5Login="10001")
    assert r.status_code == 200

    p1 = poll(client, bridge_headers)
    cmds = p1.json()["commands"]
    assert [c["clientOrderId"] for c in cmds] == ["d-1"]

    # 回执窗口内再次轮询：不重发 / within the ack window: no re-delivery
    p2 = poll(client, bridge_headers)
    assert p2.json()["commands"] == []


def test_bridge_poll_redelivers_after_ack_timeout(client, auth_headers, bridge_headers, db, user):
    make_account(db, user, login="10001")
    r = place(client, auth_headers, coid="rd-1", mt5Login="10001")
    order_id = r.json()["id"]
    poll(client, bridge_headers)

    # 把下发时间拨回超时前 / rewind delivered_at past the ack timeout
    o = get_order(db, order_id)
    o.delivered_at = datetime.now(timezone.utc) - timedelta(
        seconds=settings.ORDER_ACK_TIMEOUT_SECONDS + 5
    )
    db.commit()

    p = poll(client, bridge_headers)
    assert [c["clientOrderId"] for c in p.json()["commands"]] == ["rd-1"]


def test_unrouted_order_without_online_target_not_delivered(client, auth_headers, bridge_headers, db, user):
    # 目标账号 99999 已绑定但不在线（桥接只上报 10001）→ 不下发。
    # 归属校验要求账号存在，故先建账号；不在线由投递逻辑拦下。
    make_account(db, user, login="99999")
    place(client, auth_headers, coid="t-1", mt5Login="99999")
    p = poll(client, bridge_headers)
    assert p.json()["commands"] == []


# ---------- 回执 / results ----------


def test_result_fills_and_duplicate_is_ignored(client, auth_headers, bridge_headers, db, user):
    make_account(db, user, login="10001")
    r = place(client, auth_headers, coid="f-1", mt5Login="10001")
    order_id = r.json()["id"]
    poll(client, bridge_headers)

    r1 = client.post(
        "/api/bridge/result",
        json={"clientOrderId": "f-1", "success": True, "mt5Ticket": 111, "filledPrice": 2351.2},
        headers=bridge_headers,
    )
    assert r1.status_code == 200
    assert get_order(db, order_id).status == "FILLED"

    # 迟到的重复回执：不覆盖终态 / late duplicate: terminal state preserved
    r2 = client.post(
        "/api/bridge/result",
        json={"clientOrderId": "f-1", "success": False, "message": "late dup"},
        headers=bridge_headers,
    )
    assert r2.json().get("duplicate") is True
    o = get_order(db, order_id)
    assert o.status == "FILLED"
    assert o.filled_price == 2351.2


# ---------- 超时作废 / stale-pending voiding ----------


def _make_stale(db, order_id):
    o = get_order(db, order_id)
    o.created_at = datetime.now(timezone.utc) - timedelta(
        seconds=settings.ORDER_PENDING_TIMEOUT_SECONDS + 10
    )
    db.commit()


def test_stale_pending_voided_on_bridge_poll(client, auth_headers, bridge_headers, db, user):
    make_account(db, user, login="10001")
    r = place(client, auth_headers, coid="s-1", mt5Login="10001")
    _make_stale(db, r.json()["id"])

    p = poll(client, bridge_headers)
    # 陈旧指令不下发，且被置为 FAILED / stale command not dispatched, voided to FAILED
    assert p.json()["commands"] == []
    assert get_order(db, r.json()["id"]).status == "FAILED"


def _make_auto_order(db, user, age_seconds: float, coid="auto_tsl_1"):
    """造一条自动仓管指令（auto_ 前缀），created_at 拨回指定秒数。
    Insert an auto-manage command (auto_ prefix) aged by the given seconds."""
    o = Order(
        user_id=user.id,
        client_order_id=coid,
        symbol="XAUUSD",
        side="BUY",
        volume=0.1,
        status="PENDING",
        action="MODIFY",
        mt5_login="10001",
        ticket=555,
        created_at=datetime.now(timezone.utc) - timedelta(seconds=age_seconds),
    )
    db.add(o)
    db.commit()
    return o.id


def test_stale_auto_command_voided_without_error(client, bridge_headers, db, user):
    """超过 30 秒的自动仓管指令被作废，且轮询本身不能报错。

    回归：created_at 从库里读回来是 naive，而 30 秒判定用的 deadline 是 aware，
    直接比较会抛 TypeError → /bridge/poll 变 500。因为作废没能提交，这条指令
    永远留在 PENDING，桥接此后每 1.5 秒轮询一次、次次 500，用户侧表现为
    "已连接 · N 个账号 · 后端拒绝 HTTP 500"，与 Token 无关。

    Regression: created_at reads back naive from the DB while the 30s deadline
    is aware, so comparing them raised TypeError and turned /bridge/poll into a
    500. The void never committed, so the command stayed PENDING and every
    subsequent 1.5s poll 500'd too.
    """
    make_account(db, user, login="10001")
    order_id = _make_auto_order(db, user, age_seconds=45)

    p = poll(client, bridge_headers)
    assert p.status_code == 200, p.text
    assert p.json()["commands"] == []
    assert get_order(db, order_id).status == "FAILED"


def test_fresh_auto_command_still_delivered(client, bridge_headers, db, user):
    """30 秒窗口内的自动仓管指令照常下发 / a fresh auto command still dispatches."""
    make_account(db, user, login="10001")
    _make_auto_order(db, user, age_seconds=5, coid="auto_tsl_2")

    p = poll(client, bridge_headers)
    assert [c["clientOrderId"] for c in p.json()["commands"]] == ["auto_tsl_2"]


def test_stale_pending_voided_on_list(client, auth_headers, db):
    r = place(client, auth_headers, coid="s-2")
    _make_stale(db, r.json()["id"])

    listed = client.get("/api/orders", headers=auth_headers).json()["orders"]
    target = next(o for o in listed if o["clientOrderId"] == "s-2")
    assert target["status"] == "FAILED"


def test_list_login_filter_scopes_orders_and_total(client, auth_headers, db, user):
    """login 过滤在 SQL 里做，所以返回行和 total 都只算那个账号——
    前端翻页依赖 total，若过滤只作用于行会算出多余的空白页。
    The login filter runs in SQL, so both rows and total count only that
    account; the frontend paginates on total, and filtering rows alone would
    produce phantom empty pages."""
    make_account(db, user, login="10001")
    make_account(db, user, login="20002")
    place(client, auth_headers, coid="f-1", mt5Login="10001")
    place(client, auth_headers, coid="f-2", mt5Login="20002")
    place(client, auth_headers, coid="f-3", mt5Login="20002")

    body = client.get("/api/orders", params={"login": "20002"}, headers=auth_headers).json()
    assert body["total"] == 2
    assert {o["clientOrderId"] for o in body["orders"]} == {"f-2", "f-3"}
    assert all(o["mt5Login"] == "20002" for o in body["orders"])

    # 不传 login 时行为不变，仍返回该用户全部订单 / omitting login is unchanged
    assert client.get("/api/orders", headers=auth_headers).json()["total"] == 3


def test_late_genuine_result_overrides_voided_failed(client, auth_headers, bridge_headers, db, user):
    """已作废 FAILED 的订单收到真实回执：以实际执行结果为准。"""
    make_account(db, user, login="10001")
    r = place(client, auth_headers, coid="s-3", mt5Login="10001")
    order_id = r.json()["id"]
    poll(client, bridge_headers)
    _make_stale(db, order_id)
    client.get("/api/orders", headers=auth_headers)  # 触发作废 / trigger voiding
    assert get_order(db, order_id).status == "FAILED"

    client.post(
        "/api/bridge/result",
        json={"clientOrderId": "s-3", "success": True, "mt5Ticket": 222, "filledPrice": 2352.0},
        headers=bridge_headers,
    )
    assert get_order(db, order_id).status == "FILLED"


# ---------- 平仓/改单归属校验 / close & modify ownership ----------


def test_close_modify_reject_foreign_account(client, auth_headers):
    r = client.post(
        "/api/orders/close",
        json={"clientOrderId": "c-x", "ticket": 1, "symbol": "XAUUSD", "side": "BUY", "mt5Login": "88888"},
        headers=auth_headers,
    )
    assert r.status_code == 404
    r = client.post(
        "/api/orders/modify",
        json={"clientOrderId": "m-x", "ticket": 1, "symbol": "XAUUSD", "side": "BUY", "mt5Login": "88888", "stopLoss": 1.0, "takeProfit": 2.0},
        headers=auth_headers,
    )
    assert r.status_code == 404


def test_close_happy_path_pending(client, auth_headers, bridge_headers, db, user):
    make_account(db, user, login="10001")
    r = client.post(
        "/api/orders/close",
        json={"clientOrderId": "c-ok", "ticket": 42, "symbol": "XAUUSD", "side": "BUY", "mt5Login": "10001"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json()["status"] == "PENDING"
    assert r.json()["action"] == "CLOSE"

    # 桥接拉取应带 ticket 与 action / bridge poll carries ticket & action
    p = poll(client, bridge_headers)
    cmd = next(c for c in p.json()["commands"] if c["clientOrderId"] == "c-ok")
    assert cmd["action"] == "CLOSE"
    assert cmd["ticket"] == 42


# ---------- 多账号路由校验 / multi-account routing validation ----------


def _set_online(db, acc):
    acc.last_heartbeat = datetime.now(timezone.utc)
    db.commit()


def test_unrouted_order_rejected_when_multiple_accounts_online(client, auth_headers, db, user):
    a1 = make_account(db, user, login="10001")
    a2 = make_account(db, user, login="10002")
    _set_online(db, a1)
    _set_online(db, a2)
    r = place(client, auth_headers, coid="mr-1")  # 不带 mt5Login / no target account
    assert r.status_code == 400


def test_unrouted_order_allowed_with_single_online_account(client, auth_headers, db, user):
    a1 = make_account(db, user, login="10001")
    _set_online(db, a1)
    r = place(client, auth_headers, coid="mr-2")
    assert r.status_code == 200
