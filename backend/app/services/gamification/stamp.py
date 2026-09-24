"""订单级实盘快照（设计 §1.2）：成交时从账号行拷贝，此后不可变。

挂单在**挂出成功**（PLACED）时打章：挂单行此后不会再变状态，触发成交那一刻
平台并不知道，等不到"成交时"。账户类型不随触发与否变化，挂出时拷贝就是它
成交时的类型。没触发的挂单带着章也无害——统计只认有平仓腿的挂单
（stats._drop_untriggered）。
A pending order is stamped when placed (PLACED): its row never changes status
again and the platform isn't told when it triggers. The account type is the same
either way, and an untriggered stamped row is harmless — stats only count
pending orders that have closing legs (stats._drop_untriggered).
"""
from app.models import MT5Account


def is_stampable(status: str | None, action: str | None) -> bool:
    """哪些终态要打 trade_mode 章：成交的单，和挂出成功的挂单。
    FAILED 不打——那是"不知道成没成"，打章等于当成交。
    Which final states get a trade_mode stamp: fills, and placed pending orders.
    Never FAILED — that means "unknown", and stamping it would assert a fill."""
    return status == "FILLED" or (action == "PENDING" and status == "PLACED")


def lookup_trade_mode(db, user_id: str, login: str | None):
    if not login:
        return None
    row = (db.query(MT5Account.trade_mode)
             .filter(MT5Account.user_id == user_id, MT5Account.login == login)
             .first())
    return row[0] if row else None


def stamp_order_trade_mode(db, order) -> None:
    if not is_stampable(order.status, order.action) or order.trade_mode is not None:
        return
    tm = lookup_trade_mode(db, order.user_id, order.mt5_login)
    if tm is not None:
        order.trade_mode = tm
