"""FREE 额外直连模拟名额（设计 2026-10-08 §1.10）：FREE 可绑 1 个任意账户 + 额外 1 个
「直连（gateway）且经券商组判定为 DEMO/CONTEST」的账户；桥接 / 自报的模拟户不享受。"""
from types import SimpleNamespace as NS

import pytest
from fastapi import HTTPException

from app.models import MT5Account, User
from app.services.plans import extra_demo_slots, is_extra_demo_eligible, plan_slot_rows

REAL_GROUP = r"MCSA\I-STD-SLAB-USD"     # 默认 real_group_prefixes 命中
DEMO_GROUP = r"demo\forex-usd"          # 默认 demo_group_prefixes（"demo"）命中


@pytest.fixture(autouse=True)
def _fresh_account_type_cache():
    from app.services.settings_store import invalidate_account_type_cache
    invalidate_account_type_cache()
    yield
    invalidate_account_type_cache()


# ---- 纯函数 / pure helpers ----------------------------------------------------

def test_extra_slot_counts():
    assert extra_demo_slots("FREE") == 1
    assert extra_demo_slots(None) == 1          # 未知等级按 FREE / unknown → FREE
    assert extra_demo_slots("PRO") == 0


def test_only_gateway_demo_or_contest_is_eligible():
    assert is_extra_demo_eligible(NS(source="gateway", trade_mode=0))
    assert is_extra_demo_eligible(NS(source="gateway", trade_mode=1))
    assert not is_extra_demo_eligible(NS(source="gateway", trade_mode=2))
    assert not is_extra_demo_eligible(NS(source="gateway", trade_mode=None))
    assert not is_extra_demo_eligible(NS(source="bridge", trade_mode=0))   # 自报不算


def test_plan_slot_rows_absorbs_exactly_one_gateway_demo():
    rows = [NS(source="bridge", trade_mode=2), NS(source="gateway", trade_mode=0)]
    assert len(plan_slot_rows("FREE", rows)) == 1
    two_demos = [NS(source="gateway", trade_mode=0), NS(source="gateway", trade_mode=1)]
    assert len(plan_slot_rows("FREE", two_demos)) == 1          # 只有一个额外名额
    assert len(plan_slot_rows("PRO", rows)) == 2                # PRO 没有额外名额（本来不限）


# ---- gateway 绑定 / gateway bind ---------------------------------------------

def _user(db, email, plan="FREE"):
    u = User(email=email, api_token="tok_" + email, plan=plan)
    db.add(u); db.commit(); return u


def _row(db, u, login, source, trade_mode):
    a = MT5Account(user_id=u.id, login=login, server="" if source == "gateway" else "s",
                   source=source, trade_mode=trade_mode, balance=1000.0)
    db.add(a); db.commit(); return a


def _verify(monkeypatch, db, user, login, group):
    """同 test_gateway_binding_revoke._verify：直接调实现函数，网关那一跳换成假的。"""
    from app.core import rate_limit
    import app.routers.gateway as gw
    from app.services.gateway_client import VerifyRsp

    monkeypatch.setattr(rate_limit.limiter, "enabled", False)
    rsp = VerifyRsp(ok=True, valid=True, retcode="MT_RET_OK", login=int(login), name="T",
                    group=group, leverage=100, balance=1000.0, equity=1000.0,
                    last_pass_change=1_800_000_000)
    monkeypatch.setattr(gw, "gw_verify", lambda *a, **kw: None)
    monkeypatch.setattr(gw, "run_on_main_loop", lambda _c, timeout=None: rsp)
    return gw.gateway_verify(request=None,
                             req=gw.GatewayVerifyRequest(login=int(login), password="Secret#1"),
                             user=user, db=db)


def test_free_with_real_bridge_account_can_add_gateway_demo(db_session, monkeypatch):
    u = _user(db_session, "x1@t.co")
    _row(db_session, u, "100001", "bridge", 2)
    out = _verify(monkeypatch, db_session, u, "900001", DEMO_GROUP)
    assert out.valid is True
    row = db_session.query(MT5Account).filter_by(user_id=u.id, login="900001").one()
    assert row.source == "gateway" and row.trade_mode == 0


def test_free_extra_slot_is_only_one(db_session, monkeypatch):
    u = _user(db_session, "x2@t.co")
    _row(db_session, u, "100001", "bridge", 2)
    _row(db_session, u, "900001", "gateway", 0)
    with pytest.raises(HTTPException) as exc:
        _verify(monkeypatch, db_session, u, "900002", DEMO_GROUP)
    assert exc.value.status_code == 403


def test_free_second_real_gateway_still_blocked(db_session, monkeypatch):
    u = _user(db_session, "x3@t.co")
    _row(db_session, u, "900001", "gateway", 2)
    with pytest.raises(HTTPException) as exc:
        _verify(monkeypatch, db_session, u, "900002", REAL_GROUP)
    assert exc.value.status_code == 403


def test_bridge_demo_does_not_get_the_extra_slot(db_session, monkeypatch):
    """桥接自报的模拟户占的是常规名额：之后再直连一个实盘 → 403。"""
    u = _user(db_session, "x4@t.co")
    _row(db_session, u, "100001", "bridge", 0)
    with pytest.raises(HTTPException) as exc:
        _verify(monkeypatch, db_session, u, "900002", REAL_GROUP)
    assert exc.value.status_code == 403


def test_free_demo_first_then_real_both_fit(db_session, monkeypatch):
    u = _user(db_session, "x5@t.co")
    assert _verify(monkeypatch, db_session, u, "900001", DEMO_GROUP).valid is True
    assert _verify(monkeypatch, db_session, u, "900002", REAL_GROUP).valid is True


# ---- 桥接上报 / bridge report -------------------------------------------------

def _bridge_report(monkeypatch, db, user, login):
    import app.routers.bridge as bridge_mod
    monkeypatch.setattr(bridge_mod, "get_broker_settings", lambda db: {"broker_lock_enabled": False})
    req = bridge_mod.BridgePollRequest(
        accounts=[bridge_mod.BridgeAccount(login=login, server="s", balance=5.0)])
    return bridge_mod._report_accounts_db_work(db, user, req)


def test_bridge_new_account_fits_beside_gateway_demo(db_session, monkeypatch):
    u = _user(db_session, "b1@t.co")
    _row(db_session, u, "900001", "gateway", 0)
    online, _bal, _sfx, rejected, _broker, _gw = _bridge_report(monkeypatch, db_session, u, "100001")
    assert "100001" in online and rejected == []


def test_bridge_new_account_blocked_beside_gateway_real(db_session, monkeypatch):
    u = _user(db_session, "b2@t.co")
    _row(db_session, u, "900001", "gateway", 2)
    online, _bal, _sfx, rejected, _broker, _gw = _bridge_report(monkeypatch, db_session, u, "100001")
    assert "100001" not in online and rejected == ["100001"]


# ---- /bridge/accounts 名额展示 / quota shown by /bridge/accounts --------------

def _list(monkeypatch, db, user):
    import app.routers.bridge as bridge_mod
    monkeypatch.setattr(bridge_mod, "get_broker_settings", lambda db: {})
    out = bridge_mod.list_accounts(user=user, db=db)
    return len(out["accounts"]), out["accountLimit"]


def test_account_limit_counts_the_extra_demo_slot_in_use(db_session, monkeypatch):
    """FREE 绑了实盘 + 直连模拟：显示 2/2，而不是「2/1 已超额」。"""
    u = _user(db_session, "q1@t.co")
    _row(db_session, u, "100001", "bridge", 2)
    _row(db_session, u, "900001", "gateway", 0)
    assert _list(monkeypatch, db_session, u) == (2, 2)


def test_account_limit_with_only_the_gateway_demo_leaves_a_regular_slot(db_session, monkeypatch):
    u = _user(db_session, "q2@t.co")
    _row(db_session, u, "900001", "gateway", 0)
    assert _list(monkeypatch, db_session, u) == (1, 2)


def test_account_limit_plain_cases_unchanged(db_session, monkeypatch):
    u = _user(db_session, "q3@t.co")
    assert _list(monkeypatch, db_session, u) == (0, 1)
    _row(db_session, u, "100001", "bridge", 0)                 # 桥接自报模拟不吃额外名额
    assert _list(monkeypatch, db_session, u) == (1, 1)
    pro = _user(db_session, "q4@t.co", plan="PRO")
    _row(db_session, pro, "900009", "gateway", 0)
    assert _list(monkeypatch, db_session, pro) == (1, None)
