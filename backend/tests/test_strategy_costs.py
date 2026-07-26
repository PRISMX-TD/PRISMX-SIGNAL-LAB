"""交易成本模型 + 后台成本配置端点单测。
Trading-cost model and admin cost-settings endpoint tests."""
from app.core.security import create_access_token, generate_api_token, hash_api_token
from app.models import AdminAuditLog, User
from app.services import quotes_store
from app.services.settings_store import (
    get_strategy_costs,
    invalidate_strategy_costs_cache,
    save_strategy_costs,
)
from app.services.strategy import costs as ct


def _admin_headers(db):
    admin = User(
        email="costadmin@example.com", password_hash="x",
        api_token=hash_api_token(generate_api_token()), role="admin",
    )
    db.add(admin)
    db.commit()
    db.refresh(admin)
    return {"Authorization": f"Bearer {create_access_token(admin.id)}"}


def test_unconfigured_symbol_falls_back_to_defaults(db):
    invalidate_strategy_costs_cache()
    c = ct.symbol_costs(db, "NOSUCHSYM")
    assert c.spread == ct.DEFAULT_COSTS.spread
    assert c.commission_per_lot == ct.DEFAULT_COSTS.commission_per_lot
    assert c.slippage == ct.DEFAULT_COSTS.slippage


def test_per_symbol_config_overrides_defaults(db):
    save_strategy_costs(db, {"per_symbol": {"XAUUSD": {"spread": 0.5, "commissionPerLot": 0.1, "slippage": 0.2}}})
    db.commit()
    invalidate_strategy_costs_cache()
    c = ct.symbol_costs(db, "xauusd")
    assert c.spread == 0.5
    assert c.commission_per_lot == 0.1
    assert c.slippage == 0.2
    invalidate_strategy_costs_cache()


def test_partial_per_symbol_config_falls_back_per_field(db):
    save_strategy_costs(db, {"default_slippage": 0.07, "per_symbol": {"EURUSD": {"spread": 0.0001}}})
    db.commit()
    invalidate_strategy_costs_cache()
    c = ct.symbol_costs(db, "EURUSD")
    assert c.spread == 0.0001
    assert c.slippage == 0.07
    invalidate_strategy_costs_cache()


def test_entry_fill_pays_half_spread_plus_slippage():
    c = ct.SymbolCosts(spread=0.4, commission_per_lot=0.0, slippage=0.1)
    assert ct.entry_fill("BUY", 100.0, c) == 100.3
    assert ct.entry_fill("SELL", 100.0, c) == 99.7


def test_exit_fill_penalises_stop_only():
    c = ct.SymbolCosts(spread=0.4, commission_per_lot=0.0, slippage=0.1)
    # 止损滑价：BUY 的止损成交在更低价，SELL 在更高价
    assert ct.exit_fill("BUY", 90.0, c, is_stop=True) == 89.9
    assert ct.exit_fill("SELL", 110.0, c, is_stop=True) == 110.1
    # 止盈不施加滑点惩罚
    assert ct.exit_fill("BUY", 110.0, c, is_stop=False) == 110.0
    assert ct.exit_fill("SELL", 90.0, c, is_stop=False) == 90.0


def test_commission_is_round_trip_and_scales_with_lots():
    c = ct.SymbolCosts(spread=0.0, commission_per_lot=0.5, slippage=0.0)
    assert ct.commission_cost(c) == 0.5
    assert ct.commission_cost(c, lots=2.0) == 1.0


def test_costs_version_changes_when_config_changes(db):
    invalidate_strategy_costs_cache()
    before = ct.costs_version(db)
    save_strategy_costs(db, {"default_spread": 9.99})
    db.commit()
    invalidate_strategy_costs_cache()
    assert ct.costs_version(db) != before
    invalidate_strategy_costs_cache()


def test_point_size_prefers_ea_reported_digits():
    quotes_store._quotes.clear()
    quotes_store._quotes["XAUUSD"] = {"symbol": "XAUUSD", "bid": 2400.0, "ask": 2400.5, "digits": 2}
    assert ct.point_size("XAUUSD", 2400.0) == 0.01
    quotes_store._quotes.clear()
    assert ct.point_size("UNKNOWNSYM", 2400.0) == 0.01
    assert ct.point_size("UNKNOWNSYM", 50.0) == 0.0001
    assert ct.point_size("UNKNOWNSYM", 0.5) == 0.000001


def test_round_price_clears_float_residue():
    assert ct.round_price(63619.50399999999) == 63619.5
    assert ct.round_price(1.234567891) == 1.2346
    assert ct.round_price(0.1234567891) == 0.123457


def test_admin_strategy_costs_get_put(client, db):
    headers = _admin_headers(db)
    res = client.get("/api/admin/strategy-costs", headers=headers)
    assert res.status_code == 200
    assert res.json()["defaultSpread"] == ct.DEFAULT_COSTS.spread
    assert res.json()["perSymbol"] == []

    put = client.put(
        "/api/admin/strategy-costs",
        headers=headers,
        json={
            "defaultSpread": 0.3,
            "defaultCommissionPerLot": 0.02,
            "defaultSlippage": 0.04,
            "perSymbol": [{"symbol": "xauusd", "spread": 0.5, "commissionPerLot": 0.1, "slippage": 0.2}],
        },
    )
    assert put.status_code == 200
    body = put.json()
    assert body["defaultSpread"] == 0.3
    assert body["perSymbol"] == [
        {"symbol": "XAUUSD", "spread": 0.5, "commissionPerLot": 0.1, "slippage": 0.2}
    ]
    # 审计日志已写 / audit log written
    assert db.query(AdminAuditLog).filter(AdminAuditLog.field == "setting:strategy_costs").count() == 1
    # 缓存已失效：不手工 invalidate 也能读到新值
    assert get_strategy_costs(db)["default_spread"] == 0.3
    invalidate_strategy_costs_cache()


def test_admin_strategy_costs_requires_admin(client, db, auth_headers):
    assert client.get("/api/admin/strategy-costs", headers=auth_headers).status_code == 403
    assert client.put(
        "/api/admin/strategy-costs", headers=auth_headers, json={"defaultSpread": 1.0}
    ).status_code == 403
