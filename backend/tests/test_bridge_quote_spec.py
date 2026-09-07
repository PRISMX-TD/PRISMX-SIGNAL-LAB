"""桥接随报价上报券商真实合约规格（contractSize / tickSize / tickValue），后端原样
透传给前端，且规格本身的变化也算"报价有变化"。

网页端按风险%建议手数、算风险金额以前靠一张写死的合约规模表，合作券商上 ETHUSD
（每手 10）、WTI（每手 100）各错 10 倍，换一家券商更没法保证。现在桥接把终端
symbol_info 里的真实规格随报价一起带上，网页端优先用 MT5 自己的盈亏公式。

运行：cd backend && python -m pytest tests/test_bridge_quote_spec.py
The bridge now ships the broker's real contract spec with each per-account
quote; the backend accepts it as optional fields and passes it through.
"""
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

_BRIDGE_DIR = Path(__file__).resolve().parents[2] / "bridge"
if str(_BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(_BRIDGE_DIR))

import mt5_worker  # noqa: E402
from app.routers.bridge import BridgeQuote  # noqa: E402
from app.services.connection_manager import ConnectionManager  # noqa: E402


def _info(**over):
    base = dict(
        digits=5,
        trade_contract_size=100000.0,
        trade_tick_size=0.00001,
        trade_tick_value=1.02,        # 盈利方向 / profit side
        trade_tick_value_loss=1.0,    # 亏损方向 / loss side
    )
    base.update(over)
    return SimpleNamespace(**base)


# ---------- 桥接：_symbol_spec ----------

def test_symbol_spec_prefers_loss_side_tick_value():
    spec = mt5_worker._symbol_spec(_info())
    assert spec == {"contractSize": 100000.0, "tickSize": 0.00001, "tickValue": 1.0}


def test_symbol_spec_falls_back_to_plain_tick_value_when_loss_side_missing():
    spec = mt5_worker._symbol_spec(_info(trade_tick_value_loss=0.0))
    assert spec["tickValue"] == 1.02


def test_symbol_spec_omits_unreadable_values():
    # 没有 symbol_info：不带任何规格字段 / no symbol_info: no spec keys at all
    assert mt5_worker._symbol_spec(None) == {}
    # tick 规格读回 0（休市换算不了等）：只带合约规模，网页端退回兜底表算
    # tick spec reads 0 (e.g. closed market): contract size only, web app falls back
    spec = mt5_worker._symbol_spec(_info(trade_tick_size=0.0))
    assert spec == {"contractSize": 100000.0}
    assert mt5_worker._symbol_spec(_info(trade_contract_size=0.0, trade_tick_value_loss=0.0, trade_tick_value=0.0)) == {}


def test_quotes_payload_carries_spec_next_to_the_price(monkeypatch):
    fake_mt5 = SimpleNamespace(
        symbol_select=lambda sym, enable: True,
        symbol_info_tick=lambda sym: SimpleNamespace(bid=65.7, ask=65.72),
        symbol_info=lambda sym: _info(digits=3, trade_contract_size=5000.0, trade_tick_size=0.001, trade_tick_value_loss=5.0),
    )
    monkeypatch.setattr(mt5_worker, "mt5", fake_mt5)
    monkeypatch.setattr(mt5_worker, "_resolve_broker_symbol", lambda base, suffix: base + ".s")
    out = mt5_worker._quotes_payload(["XAGUSD"], ".s")
    assert out == [{
        "symbol": "XAGUSD", "bid": 65.7, "ask": 65.72, "digits": 3,
        "contractSize": 5000.0, "tickSize": 0.001, "tickValue": 5.0,
    }]


# ---------- 后端：BridgeQuote 接受可选规格字段 ----------

def test_bridge_quote_accepts_spec_and_stays_optional():
    q = BridgeQuote(symbol="BTCUSD", login="135347", bid=100.0, ask=101.0,
                    contractSize=1.0, tickSize=0.1, tickValue=0.1)
    assert (q.contractSize, q.tickSize, q.tickValue) == (1.0, 0.1, 0.1)
    # 旧版桥接不带这三项 / older bridges omit them
    old = BridgeQuote(symbol="BTCUSD", login="135347", bid=100.0, ask=101.0)
    assert old.contractSize is None and old.tickSize is None and old.tickValue is None


def test_bridge_quote_rejects_non_positive_spec():
    with pytest.raises(ValidationError):
        BridgeQuote(symbol="BTCUSD", login="135347", bid=100.0, ask=101.0, tickValue=0.0)


# ---------- 后端：规格变化也要推给前端 ----------

def test_update_quotes_pushes_spec_even_when_price_is_unchanged():
    cm = ConnectionManager()
    first = {"symbol": "EURUSD", "login": "1", "bid": 1.1, "ask": 1.1001, "ts": "t1"}
    assert cm.update_quotes("u", [first]) == [first]
    # 桥接升级后第一轮：价格没动、只是多了规格 → 必须算变化，否则前端要等下一跳
    # First cycle after a bridge upgrade: same price, spec appeared → must be pushed
    with_spec = {**first, "ts": "t2", "contractSize": 100000.0, "tickSize": 0.00001, "tickValue": 1.0}
    assert cm.update_quotes("u", [with_spec]) == [with_spec]
    # 只有 ts 变：不推 / only ts differs: not pushed
    assert cm.update_quotes("u", [{**with_spec, "ts": "t3"}]) == []
    # 快照里存的是带规格的那条 / the snapshot keeps the spec-bearing entry
    assert cm.get_quotes("u")[0]["tickValue"] == 1.0
