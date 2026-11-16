"""账户组做不了的品种：拒单改成人话 + 随账号列表下发 blockedSymbols（2026-11-16 体验报告 H2）。

Symbols an account group can't trade: the gateway's rejection is reworded, and the
group × symbol pair ships with the account list so the ticket can block up front.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.models import MT5Account, Order, User
from app.routers.bridge import list_accounts
from app.services import symbol_availability as sa
from app.services.gateway_client import TradeRsp
from app.services.gateway_execute import apply_trade_result

RAW = "该账号所在组(demo\\STD-USD)没有开通 BTCUSD,无法下单"


@pytest.fixture(autouse=True)
def _fresh_cache():
    sa.reset_cache()
    yield
    sa.reset_cache()


def _user(db, email):
    u = User(email=email, api_token="tok_" + email)
    db.add(u)
    db.commit()
    return u


def _acct(db, u, login, group):
    a = MT5Account(user_id=u.id, login=login, server="MakeCapital-Demo", mt5_group=group)
    db.add(a)
    db.commit()
    return a


def _order(db, u, login, symbol, status, message, age_days=0):
    o = Order(
        user_id=u.id, client_order_id=f"c-{login}-{symbol}-{age_days}-{status}", symbol=symbol,
        side="BUY", volume=0.01, mt5_login=login, status=status, message=message,
        created_at=datetime.now(timezone.utc) - timedelta(days=age_days),
    )
    db.add(o)
    db.commit()
    return o


def test_parse_and_canonical():
    assert sa.parse_gateway_missing("MT_RET_ERR_NOTFOUND: " + RAW) == ("demo\\STD-USD", "BTCUSD")
    assert sa.parse_gateway_missing("MT_RET_REQUEST_REJECT: no money") is None
    assert sa.canonical_symbol("BTCUSDT") == "BTCUSD"
    assert sa.canonical_symbol("btcusd.s") == "BTCUSD"
    # 改写后的文案仍带标记，下次从库里重读还认得出 / the reworded message keeps the marker
    assert sa.MISSING_MARKER in sa.friendly_message("BTCUSD")


def test_rejection_is_reworded_and_remembered():
    order = Order(client_order_id="c1", symbol="BTCUSDT", side="BUY", volume=0.01, status="PENDING")
    apply_trade_result(order, TradeRsp(ok=False, retcode="MT_RET_ERR_NOTFOUND", message=RAW,
                                       deal=0, order=0, price=0.0))
    assert order.status == "REJECTED"
    assert "MT_RET" not in order.message and "demo" not in order.message
    assert "BTCUSD" in order.message
    with sa._lock:
        assert sa._blocked == {"demo\\std-usd": {"BTCUSD"}}


def test_other_rejections_keep_the_gateway_wording():
    order = Order(client_order_id="c2", symbol="XAUUSD", side="BUY", volume=0.01, status="PENDING")
    apply_trade_result(order, TradeRsp(ok=False, retcode="MT_RET_REQUEST_NO_MONEY", message="余额不足",
                                       deal=0, order=0, price=0.0))
    assert order.message == "MT_RET_REQUEST_NO_MONEY: 余额不足"


def test_account_list_ships_blocked_symbols_for_the_whole_group(db_session):
    a = _user(db_session, "h2a@t.co")
    b = _user(db_session, "h2b@t.co")
    _acct(db_session, a, "700001", "demo\\STD-USD")
    _acct(db_session, b, "700002", "demo\\STD-USD")
    _acct(db_session, b, "700003", "demo\\PLUS-USD")
    # a 撞过一次（旧的原文、信号侧名字 BTCUSDT），b 的同组账号也该被提前拦住；
    # 别的组不受影响；过了窗口期的、非这类原因的拒单都不算。
    # a hit it once (raw wording, signal-side name); b's account in the same group is
    # blocked too; other groups aren't; stale or unrelated rejections don't count.
    _order(db_session, a, "700001", "BTCUSDT", "REJECTED", "MT_RET_ERR_NOTFOUND: " + RAW)
    _order(db_session, a, "700001", "ETHUSD", "REJECTED", "MT_RET_ERR_NOTFOUND: " + RAW.replace("BTCUSD", "ETHUSD"),
           age_days=sa.BLOCK_WINDOW_DAYS + 5)
    _order(db_session, a, "700001", "XAUUSD", "REJECTED", "余额不足")

    res = list_accounts(user=b, db=db_session)
    by_login = {x["login"]: x["blockedSymbols"] for x in res["accounts"]}
    assert by_login == {"700002": ["BTCUSD"], "700003": []}
