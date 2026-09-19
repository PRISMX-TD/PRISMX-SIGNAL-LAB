from app.models import User, Order, MT5Account
from app.services.gamification import loop as loop_module
from app.services.gamification.loop import (
    backfill_account_trade_modes, backfill_order_trade_modes)


def test_account_backfill_from_group(db_session):
    u = User(email="lp@t.co", api_token="tok_lp"); db_session.add(u); db_session.commit()
    db_session.add(MT5Account(user_id=u.id, login="1", server="s",
                              mt5_group="MCSA\\I-STD-SLAB-USD", trade_mode=None))
    db_session.commit()
    assert backfill_account_trade_modes(db_session) == 1
    acc = db_session.query(MT5Account).first()
    assert acc.trade_mode == 2


def test_order_backfill_and_sentinel(db_session):
    u = User(email="lq@t.co", api_token="tok_lq"); db_session.add(u); db_session.commit()
    db_session.add(MT5Account(user_id=u.id, login="1", server="s", trade_mode=2))
    for i, login in enumerate(("1", "gone")):
        db_session.add(Order(user_id=u.id, client_order_id=f"c{i}", symbol="X",
                             side="BUY", volume=0.1, status="FILLED",
                             mt5_login=login, mt5_ticket=i + 1))
    db_session.commit()
    stamped, sentinel = backfill_order_trade_modes(db_session)
    assert stamped == 1 and sentinel == 1
    modes = {o.mt5_login: o.trade_mode for o in db_session.query(Order)}
    assert modes["1"] == 2 and modes["gone"] == -1


def test_order_backfill_leaves_unknown_account_null(db_session):
    """账号行在，但 trade_mode 还没被判定（NULL）——订单既不能盖章（没有值可抄），
    也不能写哨兵（账号行确实存在，只是还没轮到它），只能留 NULL 等下一轮。"""
    u = User(email="lr@t.co", api_token="tok_lr"); db_session.add(u); db_session.commit()
    db_session.add(MT5Account(user_id=u.id, login="1", server="s", trade_mode=None))
    db_session.add(Order(user_id=u.id, client_order_id="c0", symbol="X",
                         side="BUY", volume=0.1, status="FILLED",
                         mt5_login="1", mt5_ticket=1))
    db_session.commit()
    stamped, sentinel = backfill_order_trade_modes(db_session)
    assert stamped == 0 and sentinel == 0
    order = db_session.query(Order).first()
    assert order.trade_mode is None


def test_pass_rolls_back_after_a_user_fails_and_keeps_going(db_session, monkeypatch):
    """某个用户判定抛异常时：必须真的调 `db.rollback()`，且后面的用户照常判。

    与 test_comp_settle 里那条同理——内存 SQLite 在语句失败后不 abort 事务，
    所以「后面的用户还能判」这个断言把 rollback 删掉也照样绿；生产 Postgres 下
    不 rollback 的话，第一个失败的用户会让本趟剩下的**所有**用户全部连带失败。
    所以这里直接盯 rollback 的调用次数。
    A failing user must actually trigger db.rollback(): on SQLite the transaction
    survives a failed statement, so "later users still get judged" stays green
    without it, while on Postgres one failure would take the rest of the pass with
    it. Assert on the call.
    """
    monkeypatch.setattr(loop_module, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(db_session, "close", lambda: None)
    for email in ("ru1@t.co", "ru2@t.co", "ru3@t.co"):
        db_session.add(User(email=email, api_token="tok_" + email))
    db_session.commit()
    bad = db_session.query(User).filter_by(email="ru2@t.co").first().id

    judged = []

    def _stats(db, uid, data=None):
        if uid == bad:
            raise RuntimeError("bad row")
        judged.append(uid)
        return {}
    monkeypatch.setattr(loop_module, "load_trade_data", lambda db, uid: None)
    monkeypatch.setattr(loop_module, "compute_comprehensive_stats", _stats)
    monkeypatch.setattr(loop_module, "judge_and_record_conditions", lambda db, uid, *a: [])
    monkeypatch.setattr(loop_module, "judge_and_award_badges", lambda db, uid, *a: [])

    rollbacks = []
    real_rollback = db_session.rollback
    monkeypatch.setattr(db_session, "rollback",
                        lambda: (rollbacks.append(1), real_rollback())[1])

    out = loop_module.run_gamification_pass(full=True)

    assert out["failedUsers"] == 1
    assert len(rollbacks) >= 1, "失败的用户必须 rollback，否则 Postgres 下整趟全废"
    assert len(judged) == 2                      # 坏行前后的用户都判到了


def test_incremental_pass_on_a_fresh_process_falls_back_to_full(monkeypatch):
    """显式 full=False 而进程还没跑过任何一趟 pass：没有增量下界可算，
    以前是 `None - timedelta` 直接 TypeError，现在退回全量。"""
    monkeypatch.setattr(loop_module, "_last_pass_started_at", None)
    monkeypatch.setattr(loop_module, "_last_full_pass_day", None)
    captured = {}

    class _FakeSession:
        def close(self):
            pass

    monkeypatch.setattr(loop_module, "SessionLocal", _FakeSession)
    monkeypatch.setattr(loop_module, "backfill_account_trade_modes", lambda db: 0)
    monkeypatch.setattr(loop_module, "backfill_order_trade_modes", lambda db: (0, 0))

    def _select(db, since):
        captured["since"] = since
        return []
    monkeypatch.setattr(loop_module, "select_candidate_users", _select)
    import app.services.gamification.boards as boards_module
    import app.services.gamification.competitions as comps_module
    monkeypatch.setattr(boards_module, "snapshot_boards", lambda db, now: {"periods": 0, "rows": 0})
    monkeypatch.setattr(comps_module, "snapshot_competitions", lambda db, now: {"comps": 0, "rows": 0})

    out = loop_module.run_gamification_pass(full=False)

    assert out["full"] is True and captured["since"] is None


def test_account_backfill_no_matching_prefix_leaves_null(db_session):
    """组名不匹配任何已配置前缀——classify_group 判不出来返回 None，账号
    trade_mode 保持 NULL，返回计数 0（宁可留白也不能瞎猜，见 account_type.py）。"""
    u = User(email="ls@t.co", api_token="tok_ls"); db_session.add(u); db_session.commit()
    db_session.add(MT5Account(user_id=u.id, login="1", server="s",
                              mt5_group="SOMEBROKER\\X", trade_mode=None))
    db_session.commit()
    assert backfill_account_trade_modes(db_session) == 0
    acc = db_session.query(MT5Account).first()
    assert acc.trade_mode is None
