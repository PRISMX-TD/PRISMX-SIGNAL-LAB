"""GET /bridge/accounts 下发 tradeMode。

比赛报名的账户选择器要在前端只列实盘账户，前提是这个接口把 trade_mode
真的透出去（此前 MT5AccountOut 没有这个字段，前端拿不到判据）。这里钉住两点：
已判定的值原样传出，未判定（NULL）传出 None 而不是被悄悄丢掉或错填成某个
默认值——消费方要能区分"不是实盘"和"还不知道"，但两者都不能被当成实盘放行。

GET /bridge/accounts exposes tradeMode.

The competition registration picker filters to real accounts client-side, which
only works if this endpoint actually surfaces trade_mode (MT5AccountOut had no
such field before). Pinned here: a determined value passes through unchanged,
and an undetermined (NULL) value comes back as None rather than being silently
dropped or defaulted — consumers must be able to tell "not real" apart from
"not yet known", though neither should be treated as real.
"""
from app.models import MT5Account, User
from app.routers.bridge import list_accounts


def _user(db, email="acct1@t.co"):
    u = User(email=email, api_token="tok_" + email)
    db.add(u); db.commit(); return u


def _acct(db, u, login, trade_mode):
    a = MT5Account(user_id=u.id, login=login, server="s", trade_mode=trade_mode)
    db.add(a); db.commit(); return a


def test_trade_mode_passed_through_for_known_and_unknown(db_session):
    u = _user(db_session)
    _acct(db_session, u, "500001", trade_mode=2)   # 实盘 / real
    _acct(db_session, u, "500002", trade_mode=None)  # 尚未判定 / not yet determined

    result = list_accounts(user=u, db=db_session)
    by_login = {a["login"]: a["tradeMode"] for a in result["accounts"]}

    assert by_login == {"500001": 2, "500002": None}
