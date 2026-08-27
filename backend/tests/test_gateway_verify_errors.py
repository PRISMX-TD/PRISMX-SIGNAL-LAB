"""绑定真仓时 gateway 的拒绝原因必须能传到用户面前。

券商刚开通真仓接入权限那次，用户在网页上填真仓账号得到的提示是「Gateway 不可用」，
于是排查方向全跑偏到那台其实完全健康的 VPS 上。真正的原因是 gateway.ini 的
allowed_groups 还停在 demo，网关返回了 403 group_not_allowed —— 但后端把所有
失败都压成同一句 502。

这里钉住两件事：
  1. _post 把网关 4xx 的响应体（error/message）与状态码原样带回，不吞掉；
  2. _verify_failure 按原因给出不同的状态码与文案，且真断线时仍是 502。

Pins the behaviour that a gateway refusal reaches the user intact: the HTTP
client carries the gateway's 4xx body through instead of flattening it, and the
router maps each cause to a distinct status and message.
"""
import asyncio

import httpx
import pytest
from fastapi import HTTPException

import app.services.gateway_client as gc
from app.routers.gateway import _verify_failure


_REQ = httpx.Request("POST", "http://gw.test:8800/verify")


def _resp(status, payload=None, text=None):
    """真的 httpx.Response，而不是手搓的替身。

    替身在这里会骗过测试：raise_for_status 抛出的 HTTPStatusError 必须携带**同一个**
    response，被测代码才能从 e.response 里读回响应体。自己造一个空 Response 塞进异常，
    测的就不是真实行为了。
    """
    if text is not None:
        return httpx.Response(status, text=text, request=_REQ)
    return httpx.Response(status, json=payload, request=_REQ)


class _FakeClient:
    def __init__(self, resp=None, raises=None):
        self._resp = resp
        self._raises = raises

    async def post(self, url, json=None, headers=None, timeout=None):
        if self._raises:
            raise self._raises
        return self._resp


def _verify(monkeypatch, resp=None, raises=None):
    monkeypatch.setattr(gc, "_client", _FakeClient(resp, raises))
    monkeypatch.setattr(gc.settings, "GATEWAY_URL", "http://gw.test:8800")
    return asyncio.run(gc.verify_account(500123, "pw"))


# ---------- 客户端：4xx 响应体不能被吞掉 ----------


def test_group_not_allowed_survives_the_client(monkeypatch):
    rsp = _verify(monkeypatch, _resp(403, {
        "ok": False, "error": "group_not_allowed", "message": "该账号所属组不允许接入",
    }))
    assert rsp.ok is False
    assert rsp.error == "group_not_allowed"
    assert rsp.status == 403


def test_account_not_found_keeps_retcode_and_status(monkeypatch):
    rsp = _verify(monkeypatch, _resp(404, {
        "ok": False, "error": "MT_RET_ERR_NOTFOUND", "message": "账号不存在或无法读取",
    }))
    assert rsp.error == "MT_RET_ERR_NOTFOUND"
    assert rsp.status == 404


def test_non_json_error_body_still_reports_status(monkeypatch):
    """网关被前置代理挡掉时响应体可能不是 JSON，也不能因此丢掉状态码。"""
    rsp = _verify(monkeypatch, _resp(502, text="<html>bad gateway</html>"))
    assert rsp.ok is False
    assert rsp.status == 502


def test_timeout_is_flagged_as_such(monkeypatch):
    rsp = _verify(monkeypatch, raises=httpx.ReadTimeout("timed out"))
    assert rsp.error == "timeout"
    assert rsp.status == 0


def test_unreachable_gateway_has_no_status(monkeypatch):
    rsp = _verify(monkeypatch, raises=httpx.ConnectError("connection refused"))
    assert rsp.error == "request_failed"
    assert rsp.status == 0


# ---------- 路由：原因 -> 状态码 ----------


def _fail(**kw):
    return gc.VerifyRsp(ok=False, valid=False, retcode="", **kw)


@pytest.mark.parametrize("rsp,expected", [
    (_fail(error="group_not_allowed", status=403), 403),
    (_fail(error="MT_RET_ERR_NOTFOUND", status=404), 404),
    (_fail(error="timeout", status=0), 504),
    (_fail(error="request_failed", status=0), 502),
    (_fail(error="unauthorized", status=401), 502),
])
def test_status_mapping(rsp, expected):
    assert _verify_failure(rsp).status_code == expected


def test_group_refusal_never_says_gateway_unavailable():
    """这就是当初误导排查的那句话：组不在白名单时不能再出现「Gateway 不可用」。"""
    exc = _verify_failure(_fail(error="group_not_allowed", status=403))
    assert isinstance(exc, HTTPException)
    assert "Gateway" not in exc.detail
    assert " / " in exc.detail  # 前端按界面语言取一半，必须是双语格式


def test_real_outage_still_reports_the_code():
    exc = _verify_failure(_fail(error="request_failed", status=0))
    assert "request_failed" in exc.detail
