from app.models import User, Order, MT5Account
from app.services.gamification.stamp import stamp_order_trade_mode


def _fixture(db, tm):
    u = User(email="s@t.co", api_token="tok_s"); db.add(u); db.commit()
    db.add(MT5Account(user_id=u.id, login="500123", server="MC-Live", trade_mode=tm))
    o = Order(user_id=u.id, client_order_id="c1", symbol="XAUUSD", side="BUY",
              volume=0.1, status="FILLED", mt5_login="500123")
    db.add(o); db.commit(); db.refresh(o)
    return o


def test_stamp_copies_trade_mode(db_session):
    o = _fixture(db_session, 2)
    stamp_order_trade_mode(db_session, o); db_session.commit()
    assert o.trade_mode == 2


def test_stamp_keeps_null_when_account_unknown(db_session):
    o = _fixture(db_session, None)
    stamp_order_trade_mode(db_session, o); db_session.commit()
    assert o.trade_mode is None  # 留给每小时补章，不写哨兵（账号行还在）


def test_stamp_never_overwrites(db_session):
    o = _fixture(db_session, 2)
    o.trade_mode = 0; db_session.commit()
    stamp_order_trade_mode(db_session, o); db_session.commit()
    assert o.trade_mode == 0  # 快照不可变
