"""一键平仓：批次落库、幂等、账号范围，以及"一次操作只响一次"的汇总推送。

**为什么这些点值得测。** 这个按钮按下去是不可逆的，且一次动很多张仓位，出错的
代价与"平错一张"不是一个量级：

· 范围错了 = 平掉了用户没在看的那个账号的仓位；
· 幂等破了 = 连点两下发两批平仓指令，在部分成交的窗口里真的会多平；
· 推送散着发 = 十笔仓位十条通知，用户只做了一次操作；
· 汇总发早了 = 还有指令在途就说"已全部平掉"，比不发更糟。

One-click close-all: batching, idempotency, account scope, and the single
summary push. The action is irreversible and touches many positions at once, so
each of these failure modes is worse than mis-closing one position.
"""
import pytest

from app.models import MT5Account, Order, User
from app.services import close_all

BRIDGE_LOGIN = "80412337"
GW_LOGIN = "601144"


def _user(db, *, gateway=False):
    u = User(id="u1", email="a@t.co", api_token="tok_a")
    db.add(u)
    db.add(MT5Account(user_id="u1", login=BRIDGE_LOGIN, server="MC-Live", source="bridge"))
    if gateway:
        db.add(MT5Account(user_id="u1", login=GW_LOGIN, server="MC-Live", source="gateway"))
    db.commit()
    return u


def _pos(ticket, *, login=BRIDGE_LOGIN, symbol="XAUUSD", side="BUY", volume=0.1):
    return {
        "ticket": ticket, "symbol": symbol, "side": side, "volume": volume,
        "profit": -12.3, "entryPrice": 3300.0, "currentPrice": 3290.0,
        "stopLoss": 0.0, "takeProfit": 0.0, "login": login,
    }


# ---------- 落库 / queueing ----------

def test_queues_one_close_per_position(db_session):
    _user(db_session)
    batch, created, skipped = close_all.queue(
        db_session, "u1", "co_a1", None,
        [_pos(1001), _pos(1002, side="SELL", symbol="EURUSD")],
    )

    assert skipped == 0
    assert len(created) == 2
    assert batch == "ca_co_a1"
    assert {o.ticket for o in created} == {1001, 1002}
    for o in created:
        assert o.action == "CLOSE"
        assert o.status == "PENDING"
        # 一键平仓只做全平：0 手，不碰部分平仓的步长那一摊
        assert o.volume == 0.0
        assert o.mt5_login == BRIDGE_LOGIN
        assert o.client_order_id.startswith("ca_co_a1#")
    # 方向与品种照抄持仓，回执单才对得上
    by_ticket = {o.ticket: o for o in created}
    assert (by_ticket[1002].symbol, by_ticket[1002].side) == ("EURUSD", "SELL")


def test_scoped_to_one_account(db_session):
    """页头选中哪个账号就只平那个账号——别的账号的仓位不在用户视野里。"""
    _user(db_session, gateway=True)
    _, created, _ = close_all.queue(
        db_session, "u1", "co_a2", BRIDGE_LOGIN,
        [_pos(1001), _pos(2001, login=GW_LOGIN)],
    )
    assert [o.ticket for o in created] == [1001]


def test_no_scope_covers_every_account(db_session):
    _user(db_session, gateway=True)
    _, created, _ = close_all.queue(
        db_session, "u1", "co_a3", None,
        [_pos(1001), _pos(2001, login=GW_LOGIN)],
    )
    assert {o.ticket for o in created} == {1001, 2001}
    assert {o.mt5_login for o in created} == {BRIDGE_LOGIN, GW_LOGIN}


def test_position_without_ticket_is_ignored(db_session):
    """没有 ticket 的仓位定位不到，发出去也只会被拒——直接不发。"""
    _user(db_session)
    _, created, skipped = close_all.queue(
        db_session, "u1", "co_a4", None, [_pos(None), _pos(0), _pos(1001)]
    )
    assert [o.ticket for o in created] == [1001]
    assert skipped == 0


def test_position_already_being_closed_is_skipped(db_session):
    """连点第二下不该给同一张仓位再发一条平仓指令。"""
    _user(db_session)
    db_session.add(Order(
        user_id="u1", client_order_id="co_manual", action="CLOSE", symbol="XAUUSD",
        side="BUY", volume=0.0, ticket=1001, mt5_login=BRIDGE_LOGIN, status="PENDING",
    ))
    db_session.commit()

    _, created, skipped = close_all.queue(
        db_session, "u1", "co_a5", None, [_pos(1001), _pos(1002)]
    )
    assert [o.ticket for o in created] == [1002]
    assert skipped == 1


def test_replaying_the_same_client_id_queues_nothing(db_session):
    """同一个 clientOrderId 补发一次（网络抖动的自动重试）不能平两遍。"""
    _user(db_session)
    positions = [_pos(1001), _pos(1002)]
    close_all.queue(db_session, "u1", "co_a6", None, positions)
    # 第一批标记成已成交，好证明挡住重放的不只是"还在 PENDING"那道闸
    for o in db_session.query(Order).all():
        o.status = "FILLED"
    db_session.commit()

    _, created, skipped = close_all.queue(db_session, "u1", "co_a6", None, positions)
    assert created == []
    assert skipped == 2
    assert db_session.query(Order).count() == 2


# ---------- 批次编号 / batch ids ----------

def test_batch_id_round_trip():
    batch = close_all.batch_id("co_m9x_ab12")
    child = close_all.child_order_id(batch, 36109204)
    assert close_all.is_close_all(child)
    assert close_all.batch_of(child) == batch
    # 子指令 id 必须落得进 64 字符的列 / must fit the client_order_id column
    assert len(close_all.child_order_id(close_all.batch_id("x" * 40), 2**63 - 1)) <= 64


def test_non_batch_ids_are_not_mistaken_for_children():
    for cid in ("co_plain", "auto_be_123_ab", "", None):
        assert not close_all.is_close_all(cid)
        assert close_all.batch_of(cid) is None


def test_batch_lookup_does_not_leak_across_batches(db_session):
    """批次 id 里含 `_`，而 `_` 是 LIKE 的通配符——不转义就会把别的批次算进来。"""
    _user(db_session)
    close_all.queue(db_session, "u1", "co_aXb", None, [_pos(1001)])
    close_all.queue(db_session, "u1", "co_aYb", None, [_pos(1002)])

    rows = close_all.batch_orders(db_session, "u1", close_all.batch_id("co_aXb"))
    assert [o.ticket for o in rows] == [1001]


# ---------- 汇总推送 / the summary push ----------

def _capture_pushes(monkeypatch):
    sent = []
    monkeypatch.setattr(
        "app.services.push_dispatch.dispatch_event_push",
        lambda user_id, event, title, body: sent.append((user_id, event, title, body)),
    )
    return sent


@pytest.fixture(autouse=True)
def _fresh_shared_state():
    """汇总推送的一次性标记存在 shared_state 里，用例之间必须清干净。"""
    from app.services import shared_state
    shared_state.reset_for_tests()
    yield
    shared_state.reset_for_tests()


def test_no_summary_while_the_batch_is_still_running(db_session, monkeypatch):
    """还有指令在途就说"已全部平掉"，比不发更糟。"""
    sent = _capture_pushes(monkeypatch)
    _user(db_session)
    batch, created, _ = close_all.queue(db_session, "u1", "co_b1", None, [_pos(1001), _pos(1002)])
    created[0].status = "FILLED"
    db_session.commit()

    close_all.push_summary_if_done(db_session, "u1", batch)
    assert sent == []


def test_summary_fires_once_when_every_command_resolved(db_session, monkeypatch):
    sent = _capture_pushes(monkeypatch)
    _user(db_session)
    batch, created, _ = close_all.queue(db_session, "u1", "co_b2", None, [_pos(1001), _pos(1002)])
    for o in created:
        o.status = "FILLED"
    db_session.commit()

    # 两条回执几乎同时到达：各调一次，只能响一次
    close_all.push_summary_if_done(db_session, "u1", batch)
    close_all.push_summary_if_done(db_session, "u1", batch)

    assert len(sent) == 1
    _, event, title, body = sent[0]
    assert event == "order_filled"
    assert "2" in body and "完成" in title


def test_partial_failure_summary_never_says_rejected(db_session, monkeypatch):
    """批次里混着"真被拒"和"结果未知"，统一引导去核对持仓，不能催用户重下。"""
    sent = _capture_pushes(monkeypatch)
    _user(db_session)
    batch, created, _ = close_all.queue(
        db_session, "u1", "co_b3", None, [_pos(1001), _pos(1002), _pos(1003)]
    )
    created[0].status = "FILLED"
    created[1].status = "FAILED"
    created[2].status = "REJECTED"
    db_session.commit()

    close_all.push_summary_if_done(db_session, "u1", batch)

    assert len(sent) == 1
    _, event, title, body = sent[0]
    assert event == "order_rejected"
    assert "拒绝" not in title and "拒绝" not in body
    assert "核对持仓" in body
    assert "已平 1 笔" in body and "2 笔" in body


def test_summary_for_child_resolves_the_batch(db_session, monkeypatch):
    sent = _capture_pushes(monkeypatch)
    _user(db_session)
    _, created, _ = close_all.queue(db_session, "u1", "co_b4", None, [_pos(1001)])
    created[0].status = "FILLED"
    db_session.commit()

    close_all.push_summary_for_child(db_session, "u1", created[0].client_order_id)
    assert len(sent) == 1


def test_summaries_for_children_checks_each_batch_once(db_session, monkeypatch):
    """超时兜底会一口气作废一整批：每批只该出一条通知。"""
    sent = _capture_pushes(monkeypatch)
    _user(db_session)
    _, first, _ = close_all.queue(db_session, "u1", "co_b5", None, [_pos(1001), _pos(1002)])
    _, second, _ = close_all.queue(db_session, "u1", "co_b6", None, [_pos(2001)])
    for o in first + second:
        o.status = "FAILED"
    db_session.commit()

    close_all.push_summaries_for_children(
        db_session, "u1", [o.client_order_id for o in first + second]
    )
    assert len(sent) == 2


# ---------- 接口层 / the endpoint ----------

def _call(db, monkeypatch, positions, login=None, cid="co_e1"):
    from app.core import rate_limit
    import app.routers.orders as orders
    from app.services.connection_manager import manager

    monkeypatch.setattr(rate_limit.limiter, "enabled", False)
    monkeypatch.setattr(manager, "get_positions", lambda _uid: positions)

    class _Bg:
        def __init__(self):
            self.tasks = []

        def add_task(self, fn, *a, **kw):
            self.tasks.append((fn, a, kw))

    bg = _Bg()
    out = orders.close_all_positions(
        request=None,
        req=orders.CloseAllRequest(clientOrderId=cid, mt5Login=login),
        background=bg,
        user=db.get(User, "u1"),
        db=db,
    )
    return out, bg


def test_endpoint_queues_and_acknowledges(db_session, monkeypatch):
    _user(db_session)
    out, bg = _call(db_session, monkeypatch, [_pos(1001), _pos(1002)])

    assert (out.requested, out.queued, out.skipped) == (2, 2, 0)
    assert out.batchId == "ca_co_e1"
    assert len(out.orders) == 2
    # 桥接账号没有网关活要干 / nothing for the gateway path to do
    assert bg.tasks == []


def test_endpoint_schedules_gateway_execution_off_request(db_session, monkeypatch):
    """网关平仓单笔最坏 65 秒，绝不能串在请求里跑。"""
    _user(db_session, gateway=True)
    out, bg = _call(db_session, monkeypatch, [_pos(2001, login=GW_LOGIN)])

    assert out.queued == 1
    assert len(bg.tasks) == 1
    fn, args, _ = bg.tasks[0]
    assert fn is close_all.execute_gateway_batch
    assert args[0] == "u1" and args[1] == "ca_co_e1"
    assert args[2] == [out.orders[0].id]


def test_endpoint_rejects_an_account_that_is_not_mine(db_session, monkeypatch):
    from fastapi import HTTPException

    _user(db_session)
    with pytest.raises(HTTPException) as e:
        _call(db_session, monkeypatch, [_pos(1001)], login="999999")
    assert e.value.status_code == 404
    assert db_session.query(Order).count() == 0


def test_endpoint_400s_when_there_is_nothing_to_close(db_session, monkeypatch):
    from fastapi import HTTPException

    _user(db_session)
    with pytest.raises(HTTPException) as e:
        _call(db_session, monkeypatch, [])
    assert e.value.status_code == 400


def test_endpoint_double_tap_is_accepted_not_an_error(db_session, monkeypatch):
    """第二下什么都没排下去，但那不是错误——前端要说得出"已经在平了"。"""
    _user(db_session)
    _call(db_session, monkeypatch, [_pos(1001)], cid="co_e2")
    out, _ = _call(db_session, monkeypatch, [_pos(1001)], cid="co_e3")

    assert (out.queued, out.skipped) == (0, 1)
    assert db_session.query(Order).count() == 1
