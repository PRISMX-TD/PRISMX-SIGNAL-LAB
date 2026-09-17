"""已用保证金（mt5_accounts.margin）的上报与下发。

订单与回执页的账户抬头要显示「保证金比例」＝净值 ÷ 已用保证金。比例在前端算，
后端只负责把券商给的 margin 原样送到位，所以这里钉住三件事：

1. 桥接上报的 margin 落库并由 GET /bridge/accounts 透出——漏一处前端就只能显示「—」，
   而且是静默的（字段缺失不报错）。
2. 旧版桥接不带这个字段时**不覆盖**已有值。这条最要紧：若按 None 写成 0，界面上
   「不知道」会变成「确定空仓」，而 0 又是比例的分母，等于把未知伪装成一个确定结论。
3. 从未刷新过的账号下发 None，不是 0。消费方要能区分"没有值"和"值是零"。

Margin in use: reported by the bridge, surfaced by GET /bridge/accounts. The
ratio is computed in the web app; the backend only has to carry the broker's
number through. Pinned: it round-trips, an older bridge omitting the field never
overwrites a stored value (writing 0 for None would turn "unknown" into
"certainly flat", and 0 is the ratio's denominator), and a never-refreshed
account reports None rather than 0.
"""
from app.models import MT5Account, User
from app.routers.bridge import BridgeAccount, _upsert_account, list_accounts


def _user(db, email="margin@t.co"):
    u = User(email=email, api_token="tok_" + email)
    db.add(u); db.commit(); return u


def _upsert(db, user, **kw):
    acc = BridgeAccount(**kw)
    row, _ = _upsert_account(db, user.id, acc, existing_count=0, account_limit=None)
    db.commit()
    return row


def test_reported_margin_is_stored_and_surfaced(db_session):
    u = _user(db_session)
    _upsert(db_session, u, login="500001", server="s", equity=171.35, margin=2.15)

    accounts = {a["login"]: a for a in list_accounts(user=u, db=db_session)["accounts"]}
    assert accounts["500001"]["margin"] == 2.15
    # 比例交给前端算，这里只确认算它所需的两个数都在。
    # The ratio is the frontend's job; both of its inputs must be present.
    assert accounts["500001"]["equity"] == 171.35


def test_older_bridge_omitting_margin_keeps_the_stored_value(db_session):
    """旧版桥接的上报里没有 margin，不能把已有值清成 None 或 0。"""
    u = _user(db_session, "margin2@t.co")
    _upsert(db_session, u, login="500002", server="s", equity=100.0, margin=8.0)
    # 同一个账号再报一轮，这次不带 margin（1.4.1 之前的桥接就是这样）。
    _upsert(db_session, u, login="500002", server="s", equity=101.0)

    row = db_session.query(MT5Account).filter(MT5Account.login == "500002").one()
    assert row.margin == 8.0
    assert row.equity == 101.0


def test_never_refreshed_account_reports_none_not_zero(db_session):
    u = _user(db_session, "margin3@t.co")
    db_session.add(MT5Account(user_id=u.id, login="500003", server="s", equity=50.0))
    db_session.commit()

    accounts = {a["login"]: a for a in list_accounts(user=u, db=db_session)["accounts"]}
    assert accounts["500003"]["margin"] is None
