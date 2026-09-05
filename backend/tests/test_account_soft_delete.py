"""账号删除/解绑改为软删（gateway_binding.REASON_USER_REMOVED）。

**为什么要测。** 以前两条通道的删除都是物理删行，而 orders / closed_trades 只按
(user, login) 关联——删掉账号，个人胜率与已平仓明细里的历史就凭空消失，重绑才回来
（与模型注释"不直接删行以免历史失去归属"相悖）。现在行留着、打标记。钉住：

  · 桥接删除 / gateway 解绑后：行还在、带标记、列表不显示、离线、不能下单、不进
    条件判定与榜单；胜率过滤集（_bound_logins）仍包含它——历史不丢；
  · 已删的再删 → 404；
  · 桥接再次上报 → 复活（受账户数上限约束）；gateway 重新验证 → 复活；
  · 账户数上限不把已删的算进去。

Soft delete for both channels: the row stays with a marker, leaves lists / routing /
boards / limit counting, keeps feeding the win-rate filters; revived on re-report or
re-verify.
"""
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.models import MT5Account, Order, User
from app.routers import bridge as bridge_mod
from app.routers import gateway as gateway_mod
from app.routers import orders as orders_mod
from app.services.deps import is_account_online
from app.services.gateway_binding import (
    REASON_USER_REMOVED, is_removed, is_revoked, mark_removed, not_removed, restore_removed,
)
from app.services.gamification.conditions import _judge_plain


def _user(db, email="sd@t.co", plan="FREE"):
    u = User(email=email, api_token="tok_" + email, plan=plan); db.add(u); db.commit(); return u


def _acct(db, u, login, source="bridge", server="s", **kw):
    a = MT5Account(user_id=u.id, login=login, server=server if source == "bridge" else "",
                   source=source, trade_mode=2, balance=1000.0, **kw)
    db.add(a); db.commit(); return a


# ---- bridge ------------------------------------------------------------------------

def test_bridge_delete_is_soft_and_hides_but_keeps_history(db_session):
    u = _user(db_session)
    a = _acct(db_session, u, "100001")
    db_session.add(Order(user_id=u.id, client_order_id="c1", action="ORDER", status="FILLED",
                         symbol="XAUUSD", side="BUY", volume=0.1, mt5_login="100001", mt5_ticket=1))
    db_session.commit()

    assert bridge_mod.delete_account("100001", server="s", user=u, db=db_session) == {"ok": True}

    row = db_session.query(MT5Account).filter_by(login="100001").one()     # 行还在
    assert is_removed(row) and row.revoked_reason == REASON_USER_REMOVED
    assert is_revoked(row) is False                                        # bridge 行不算"需重新验证"
    assert is_account_online(row) is False
    assert bridge_mod.list_accounts(user=u, db=db_session)["accounts"] == []
    assert orders_mod._bound_logins(db_session, u.id) == ["100001"]       # 胜率过滤集仍含它
    assert _judge_plain(db_session, u, "bind_account", {}) is False        # 条件判定不算
    with pytest.raises(HTTPException) as exc:                              # 不能往里下单
        orders_mod._assert_account_owned(db_session, u.id, "100001")
    assert exc.value.status_code == 404
    with pytest.raises(HTTPException) as exc:                              # 再删 → 404
        bridge_mod.delete_account("100001", server="s", user=u, db=db_session)
    assert exc.value.status_code == 404


def test_bridge_report_revives_removed_row_within_limit(db_session):
    u = _user(db_session, plan="FREE")                                     # FREE：1 个账户
    a = _acct(db_session, u, "100001")
    mark_removed(db_session, a)
    acc = bridge_mod.BridgeAccount(login="100001", server="s", balance=5.0)

    row, created = bridge_mod._upsert_account(db_session, u.id, acc, existing_count=0, account_limit=1)
    assert row is a and created is True and not is_removed(row) and row.balance == 5.0

    # 上限已满时不复活（当作被拒的新账号）/ over the limit: stays removed
    mark_removed(db_session, a)
    row, created = bridge_mod._upsert_account(db_session, u.id, acc, existing_count=1, account_limit=1)
    assert row is None and created is False
    assert is_removed(db_session.query(MT5Account).filter_by(login="100001").one())


def test_removed_rows_do_not_count_toward_plan_limit(db_session):
    u = _user(db_session)
    a = _acct(db_session, u, "100001"); _acct(db_session, u, "100002")
    mark_removed(db_session, a)
    live = db_session.query(MT5Account).filter(MT5Account.user_id == u.id, not_removed()).count()
    assert live == 1


# ---- gateway -----------------------------------------------------------------------

def test_gateway_unbind_is_soft_and_reverify_revives(db_session, monkeypatch):
    u = _user(db_session, email="gw@t.co", plan="PRO")
    a = _acct(db_session, u, "601144", source="gateway", pass_change_at=111)

    assert gateway_mod.unbind_gateway_account("601144", user=u, db=db_session) == {"ok": True}
    row = db_session.query(MT5Account).filter_by(login="601144").one()
    assert is_removed(row) and is_revoked(row)                             # gateway 行：撤销+删除同标
    assert gateway_mod.list_gateway_accounts(user=u, db=db_session) == []
    with pytest.raises(HTTPException):
        gateway_mod.unbind_gateway_account("601144", user=u, db=db_session)

    # 重新验证：走真实 gateway_verify，只桩掉 HTTP / re-verify through the real endpoint
    rsp = SimpleNamespace(ok=True, valid=True, retcode="OK", login=601144, name="N", group="MCSA\I-STD-SLAB-USD",
                          leverage=100, balance=9.0, equity=9.0, last_pass_change=111, status=200,
                          error="", message="")
    monkeypatch.setattr(gateway_mod, "gw_verify", lambda login, pw: rsp)
    monkeypatch.setattr(gateway_mod, "run_on_main_loop", lambda coro, timeout: coro)
    req = gateway_mod.GatewayVerifyRequest(login=601144, password="secret-pw")
    scope = {"type": "http", "method": "POST", "path": "/api/gateway/verify", "headers": [],
             "client": ("127.0.0.1", 1), "query_string": b"", "server": ("t", 80), "scheme": "http"}
    out = gateway_mod.gateway_verify(Request(scope), req, user=u, db=db_session)
    assert out.valid is True
    row = db_session.query(MT5Account).filter_by(login="601144").one()
    assert not is_removed(row) and row.revoked_at is None and row.balance == 9.0
    assert [r.login for r in gateway_mod.list_gateway_accounts(user=u, db=db_session)] == ["601144"]


def test_restore_helper_is_a_noop_on_live_rows(db_session):
    u = _user(db_session, email="r@t.co")
    a = _acct(db_session, u, "1")
    assert restore_removed(a) is False
    mark_removed(db_session, a)
    assert restore_removed(a) is True and a.revoked_at is None and a.revoked_reason is None
