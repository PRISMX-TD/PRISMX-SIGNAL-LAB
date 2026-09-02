"""订单级实盘快照（设计 §1.2）：成交时从账号行拷贝，此后不可变。"""
from app.models import MT5Account


def lookup_trade_mode(db, user_id: str, login: str | None):
    if not login:
        return None
    row = (db.query(MT5Account.trade_mode)
             .filter(MT5Account.user_id == user_id, MT5Account.login == login)
             .first())
    return row[0] if row else None


def stamp_order_trade_mode(db, order) -> None:
    if order.status != "FILLED" or order.trade_mode is not None:
        return
    tm = lookup_trade_mode(db, order.user_id, order.mt5_login)
    if tm is not None:
        order.trade_mode = tm
