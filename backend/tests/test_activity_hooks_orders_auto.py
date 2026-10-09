"""自动仓管指令号带动作类型（设计 §3.6），以及自动指令的「原值」（§4.2 auto.sl / auto.partial_tp）。

改止损单的指令号从 auto_sl_<票号>_<随机> 拆成：
  be       目标正好是入场价（保本）；
  restore  当前没有止损（被手动清掉）时补回；
  trail    其余（追踪）。
分批止盈仍是 auto_tp_。原值直接取这一轮评估手里的持仓：MODIFY 写 prev_sl / prev_tp（与
pos_volume），分批止盈的 CLOSE 写 pos_volume，不多读任何东西。

另外要钉住：所有只认 AUTO_PREFIX 的消费方对新指令号照常生效——
  · auto_manage 自己的 pending_auto_tickets（LIKE 'auto_%'）：在途的自动指令挡住下一轮；
  · routers/bridge.py 取指令时的 30 秒自动指令作废；
  · routers/bridge.py 回执后的 Web Push 去重（自动指令触发时已推过一次）。

Auto commands carry their kind in the id (be / trail / restore / tp) and record the
previous SL / TP / volume from the position being evaluated. Every AUTO_PREFIX
consumer must still recognise the new ids.
"""
import re
from datetime import datetime, timedelta, timezone

import pytest

from app.models import AutoManagedPosition, AutoManageSettings, MT5Account, Order, User
from app.services import auto_manage
from app.services.auto_manage import (
    AUTO_KIND_BE,
    AUTO_KIND_LEGACY_SL,
    AUTO_KIND_PARTIAL_TP,
    AUTO_KIND_RESTORE,
    AUTO_KIND_TRAIL,
    AUTO_PREFIX,
    auto_command_kind,
    evaluate_positions,
    invalidate_eligibility,
)

LOGIN = "600144"
POSITION = 17431512
# R = |4000 - 3990| = 10；现价 4010 = 浮盈 1R / R = 10, price 4010 = +1R
ENTRY = 4000.0
INITIAL_SL = 3990.0
PRICE_AT_1R = 4010.0
TP = 4200.0


def _report(stop_loss=INITIAL_SL, take_profit=TP, volume=1.0, **extra) -> dict:
    row = {
        "ticket": POSITION, "symbol": "XAUUSD.s", "side": "BUY", "volume": volume,
        "profit": 100.0, "entryPrice": ENTRY, "currentPrice": PRICE_AT_1R,
        "stopLoss": stop_loss, "takeProfit": take_profit, "login": LOGIN,
    }
    row.update(extra)
    return row


def _setup(db, *, risk_known: bool = False, **settings_kw) -> str:
    """开着自动仓管的 PRO 用户 + 一笔本平台开出的桥接仓位（指令留在 PENDING 等桥接取，
    不走网关执行）。risk_known=True 时预先放一行已知 R 的状态，模拟「之前见过、止损后来
    被清掉」。"""
    user = User(id="u-auto-hooks", email="auto-hooks@t.local", api_token="tok-auto-hooks",
                plan="PRO")
    db.add(user)
    db.add(MT5Account(user_id=user.id, login=LOGIN, server="", source="bridge"))
    cfg = dict(enabled=True, be_enabled=False, be_trigger_r=1.0,
               trail_enabled=False, trail_trigger_r=1.0, trail_distance_r=0.5,
               ptp_enabled=False, ptp_trigger_r=1.0, ptp_fraction=0.5)
    cfg.update(settings_kw)
    db.add(AutoManageSettings(user_id=user.id, **cfg))
    db.add(Order(user_id=user.id, client_order_id="open-1", action="ORDER", status="FILLED",
                 symbol="XAUUSD.s", side="BUY", volume=1.0,
                 mt5_login=LOGIN, mt5_ticket=POSITION))
    if risk_known:
        db.add(AutoManagedPosition(user_id=user.id, position_ticket=POSITION, mt5_login=LOGIN,
                                   entry=ENTRY, initial_sl=INITIAL_SL, risk=ENTRY - INITIAL_SL))
    db.commit()
    invalidate_eligibility(user.id)
    return user.id


@pytest.fixture(autouse=True)
def _no_push(monkeypatch):
    monkeypatch.setattr(auto_manage, "dispatch_event_push", lambda *a, **k: None)


def _id_re(kind: str) -> str:
    return rf"^{AUTO_PREFIX}{kind}_{POSITION}_[0-9a-f]{{8}}$"


# 每种动作一个场景：(设置, 是否预置 R, 上报的止损, 期望动作, 期望新止损)
# One scenario per kind: (settings, preset R, reported SL, kind, expected new SL)
SCENARIOS = {
    AUTO_KIND_BE: (dict(be_enabled=True), False, INITIAL_SL, ENTRY),
    # 追踪：4010 - 0.5R = 4005，比 3990 好 1.5R / trail: 4005 beats 3990 by 1.5R
    AUTO_KIND_TRAIL: (dict(trail_enabled=True), False, INITIAL_SL, 4005.0),
    # 止损被清掉、只开追踪：补回到追踪位 / stop cleared, trailing only: restored at 4005
    AUTO_KIND_RESTORE: (dict(trail_enabled=True), True, 0.0, 4005.0),
}


# ── 指令号 + 原值 / ids and previous values ──────────────────────────────────

@pytest.mark.parametrize("kind", list(SCENARIOS))
def test_sl_move_id_kind_and_previous_values(db_session, kind):
    cfg, risk_known, reported_sl, new_sl = SCENARIOS[kind]
    uid = _setup(db_session, risk_known=risk_known, **cfg)

    assert evaluate_positions(db_session, uid, [_report(stop_loss=reported_sl)]) == 1

    cmd = db_session.query(Order).filter(Order.action == "MODIFY").one()
    assert re.match(_id_re(kind), cmd.client_order_id), cmd.client_order_id
    assert auto_command_kind(cmd.client_order_id) == kind
    assert cmd.sl == pytest.approx(new_sl)
    assert cmd.tp == pytest.approx(TP)                     # 止盈原样带上 / TP carried as before
    assert cmd.prev_sl == pytest.approx(reported_sl)       # restore 时是 0 = 原来没有
    assert cmd.prev_tp == pytest.approx(TP)
    assert cmd.pos_volume == pytest.approx(1.0)
    assert cmd.status == "PENDING"


def test_restore_at_entry_counts_as_break_even(db_session):
    """止损被清掉、而目标正好是入场价：记 be（「原来没有止损」由 prev_sl=0 记着）。
    A cleared stop restored at entry is recorded as be; prev_sl=0 keeps the restore fact."""
    uid = _setup(db_session, risk_known=True, be_enabled=True)

    evaluate_positions(db_session, uid, [_report(stop_loss=0.0)])

    cmd = db_session.query(Order).filter(Order.action == "MODIFY").one()
    assert auto_command_kind(cmd.client_order_id) == AUTO_KIND_BE
    assert cmd.sl == pytest.approx(ENTRY)
    assert cmd.prev_sl == 0.0


def test_no_take_profit_is_recorded_as_zero(db_session):
    uid = _setup(db_session, be_enabled=True)

    evaluate_positions(db_session, uid, [_report(take_profit=0.0)])

    cmd = db_session.query(Order).filter(Order.action == "MODIFY").one()
    assert cmd.prev_tp == 0.0 and cmd.tp == 0.0


def test_missing_volume_in_report_leaves_pos_volume_null(db_session):
    """上报里没有手数：记 NULL（不知道），不记 0。/ No volume in the report: NULL, not 0."""
    uid = _setup(db_session, be_enabled=True)
    row = _report()
    del row["volume"]

    evaluate_positions(db_session, uid, [row])

    cmd = db_session.query(Order).filter(Order.action == "MODIFY").one()
    assert cmd.pos_volume is None


def test_partial_take_profit_id_and_position_volume(db_session):
    uid = _setup(db_session, ptp_enabled=True)

    assert evaluate_positions(db_session, uid, [_report(volume=1.0)]) == 1

    cmd = db_session.query(Order).filter(Order.action == "CLOSE").one()
    assert re.match(_id_re(AUTO_KIND_PARTIAL_TP), cmd.client_order_id), cmd.client_order_id
    assert cmd.volume == pytest.approx(0.5)
    assert cmd.pos_volume == pytest.approx(1.0)             # 平之前的仓位手数 / volume before
    assert (cmd.prev_sl, cmd.prev_tp) == (None, None)        # CLOSE 不写原止损 / not for CLOSE


def test_auto_command_kind_parsing():
    assert auto_command_kind(f"auto_be_{POSITION}_0123abcd") == AUTO_KIND_BE
    assert auto_command_kind(f"auto_trail_{POSITION}_0123abcd") == AUTO_KIND_TRAIL
    assert auto_command_kind(f"auto_restore_{POSITION}_0123abcd") == AUTO_KIND_RESTORE
    assert auto_command_kind(f"auto_tp_{POSITION}_0123abcd") == AUTO_KIND_PARTIAL_TP
    # 旧数据里的改止损单照样认得出来 / legacy SL moves still parse
    assert auto_command_kind(f"auto_sl_{POSITION}_0123abcd") == AUTO_KIND_LEGACY_SL
    for other in (None, "", "auto_", "auto_be", "co_auto_be_1_x", "ca_abc#1", "AUTO_be_1_x"):
        assert auto_command_kind(other) is None, other


# ── 所有 AUTO_PREFIX 消费方 / every AUTO_PREFIX consumer ──────────────────────

ALL_KINDS = [AUTO_KIND_BE, AUTO_KIND_TRAIL, AUTO_KIND_RESTORE, AUTO_KIND_PARTIAL_TP]


def test_every_generated_id_keeps_the_prefix():
    for kind in ALL_KINDS:
        cid = auto_manage._client_order_id(kind, POSITION)
        assert cid.startswith(AUTO_PREFIX)
        assert auto_command_kind(cid) == kind


@pytest.mark.parametrize("kind", list(SCENARIOS) + [AUTO_KIND_PARTIAL_TP])
def test_pending_guard_recognises_new_ids(db_session, kind):
    """auto_manage 的 pending_auto_tickets（LIKE 'auto_%'）：在途的新指令挡住下一轮，不重复下发。
    The in-flight guard still sees the new ids, so the next report doesn't re-send."""
    if kind == AUTO_KIND_PARTIAL_TP:
        cfg, risk_known, reported_sl = dict(ptp_enabled=True), False, INITIAL_SL
    else:
        cfg, risk_known, reported_sl, _ = SCENARIOS[kind]
    uid = _setup(db_session, risk_known=risk_known, **cfg)

    assert evaluate_positions(db_session, uid, [_report(stop_loss=reported_sl)]) == 1
    cid = db_session.query(Order.client_order_id).filter(Order.client_order_id != "open-1").scalar()
    assert auto_command_kind(cid) == kind
    if kind == AUTO_KIND_PARTIAL_TP:
        # 分批止盈另有 partial_done 挡着；清掉它，只留在途守卫这一道
        # Partial TP is also blocked by partial_done; clear it so only the guard remains.
        db_session.query(AutoManagedPosition).update({"partial_done": False})
        db_session.commit()

    assert evaluate_positions(db_session, uid, [_report(stop_loss=reported_sl)]) == 0
    assert db_session.query(Order).filter(Order.client_order_id.like(f"{AUTO_PREFIX}%")).count() == 1


@pytest.mark.parametrize("kind", ALL_KINDS)
def test_bridge_poll_voids_stale_auto_commands_with_new_ids(db_session, kind):
    """routers/bridge.py 取指令：超过 30 秒的自动指令作废、不下发；同龄的普通指令照常下发。
    The bridge poll still voids a >30s-old auto command and dispatches a manual one."""
    from app.routers import bridge

    user = User(id="u-poll", email="poll@t.local", api_token="tok-poll")
    db_session.add(user)
    db_session.add(MT5Account(user_id=user.id, login=LOGIN, server="", source="bridge"))
    created = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=60)
    auto_cid = auto_manage._client_order_id(kind, POSITION)
    common = dict(user_id=user.id, symbol="XAUUSD", side="BUY", ticket=POSITION,
                  mt5_login=LOGIN, status="PENDING", created_at=created)
    db_session.add(Order(client_order_id=auto_cid, action="MODIFY", volume=0.0, sl=ENTRY, **common))
    db_session.add(Order(client_order_id="manual-1", action="MODIFY", volume=0.0, sl=ENTRY, **common))
    db_session.commit()

    commands, voided = bridge._fetch_commands_db_work(db_session, user, {LOGIN}, {}, set())

    assert [c["clientOrderId"] for c in commands] == ["manual-1"]
    assert [p["data"]["clientOrderId"] for p in voided] == [auto_cid]
    db_session.expire_all()
    assert db_session.query(Order).filter(Order.client_order_id == auto_cid).one().status == "FAILED"


@pytest.mark.parametrize("kind", ALL_KINDS)
def test_bridge_receipt_push_skips_new_ids(kind):
    """routers/bridge.py 回执后的 Web Push：自动指令触发时已推过，回执不再推。"""
    from app.routers import bridge

    def _filled(cid):
        return Order(client_order_id=cid, status="FILLED", action="MODIFY", symbol="XAUUSD",
                     side="BUY", volume=0.0, filled_price=4000.0)

    assert bridge._result_push_args(_filled(auto_manage._client_order_id(kind, POSITION))) is None
    assert bridge._result_push_args(_filled("manual-1")) is not None
