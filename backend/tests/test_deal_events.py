"""#11 成交订阅：drain_deal_events 的解析与去重，以及兜底扫描间隔的降级逻辑。

事件在这条链路里是"门铃"而不是数据通道——只带 login，明细仍由已有的平仓扫描
按时间窗拉取。所以这里覆盖的是：login 提取正确、同批去重、订阅不可用时安全降级。
"""
import asyncio

import app.services.gateway_client as gc
from app.routers.gateway import (
    GATEWAY_DEALS_SCAN_INTERVAL,
    GATEWAY_DEALS_SCAN_INTERVAL_SUBSCRIBED,
)


class _FakeResp:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class _FakeClient:
    def __init__(self, payload=None, raises=None):
        self._payload = payload
        self._raises = raises
        self.calls = []

    async def get(self, url, headers=None, timeout=None):
        self.calls.append(url)
        if self._raises:
            raise self._raises
        return _FakeResp(self._payload)


def _drain(monkeypatch, payload=None, raises=None):
    fake = _FakeClient(payload, raises)
    monkeypatch.setattr(gc, "_client", fake)
    monkeypatch.setattr(gc.settings, "GATEWAY_URL", "http://gw.test:8800")
    result = asyncio.run(gc.drain_deal_events())
    return result, fake


# ---------- 解析 ----------


def test_extracts_logins(monkeypatch):
    (logins, subscribed), fake = _drain(
        monkeypatch,
        {
            "ok": True,
            "subscribed": True,
            "events": [
                {"login": 1001, "deal": 5, "position": 77},
                {"login": 1002, "deal": 6, "position": 78},
            ],
        },
    )
    assert logins == [1001, 1002]
    assert subscribed is True
    assert fake.calls == ["http://gw.test:8800/deal-events"]


def test_dedupes_logins_within_one_batch(monkeypatch):
    """一次平仓会产生多笔成交，同一个 login 只该触发一次扫描。"""
    (logins, _), _ = _drain(
        monkeypatch,
        {
            "ok": True,
            "subscribed": True,
            "events": [
                {"login": 1001, "deal": 5, "position": 77},
                {"login": 1001, "deal": 6, "position": 77},
                {"login": 1001, "deal": 7, "position": 78},
                {"login": 1002, "deal": 8, "position": 79},
            ],
        },
    )
    assert logins == [1001, 1002], "同一 login 只保留一次，且保持首次出现的顺序"


def test_skips_zero_login(monkeypatch):
    """login=0 是无效条目（入金/出金等不挂在客户账号上的成交）。"""
    (logins, _), _ = _drain(
        monkeypatch,
        {"ok": True, "subscribed": True, "events": [{"login": 0, "deal": 5}, {"login": 1001}]},
    )
    assert logins == [1001]


def test_empty_events(monkeypatch):
    (logins, subscribed), _ = _drain(
        monkeypatch, {"ok": True, "subscribed": True, "events": []}
    )
    assert logins == []
    assert subscribed is True


# ---------- 降级 ----------


def test_unsubscribed_reports_false(monkeypatch):
    """订阅不可用时如实上报，调用方据此把兜底扫描回落到 3 秒。"""
    (logins, subscribed), _ = _drain(
        monkeypatch, {"ok": True, "subscribed": False, "events": []}
    )
    assert subscribed is False


def test_gateway_error_degrades_safely(monkeypatch):
    """gateway 不可达时返回 ([], False)，绝不能抛出去打断整个事件泵。"""
    (logins, subscribed), _ = _drain(monkeypatch, raises=RuntimeError("connection refused"))
    assert logins == []
    assert subscribed is False


def test_ok_false_degrades_safely(monkeypatch):
    """gateway 返回 ok=false 同样安全降级。"""
    (logins, subscribed), _ = _drain(monkeypatch, {"ok": False, "error": "not_connected"})
    assert logins == []
    assert subscribed is False


# ---------- 间隔常量 ----------


def test_subscribed_interval_is_relaxed():
    """订阅可用时兜底扫描必须比原来更稀疏，否则这次改造就是只加不减。"""
    assert GATEWAY_DEALS_SCAN_INTERVAL_SUBSCRIBED > GATEWAY_DEALS_SCAN_INTERVAL
    assert GATEWAY_DEALS_SCAN_INTERVAL == 3.0, "未订阅时必须保持改造前的节奏"
    assert GATEWAY_DEALS_SCAN_INTERVAL_SUBSCRIBED == 15.0
