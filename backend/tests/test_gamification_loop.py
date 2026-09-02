from app.models import User, Order, MT5Account
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
