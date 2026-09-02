from datetime import datetime, timezone
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
