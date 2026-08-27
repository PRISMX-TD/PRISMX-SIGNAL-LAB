"""绑定真仓时 gateway 的拒绝原因必须能传到用户面前。

券商刚开通真仓接入权限那次，用户在网页上填真仓账号得到的提示是「Gateway 不可用」，
于是排查方向全跑偏到那台其实完全健康的 VPS 上。真正的原因是 gateway.ini 的
allowed_groups 还停在 demo，网关返回了 403 group_not_allowed —— 但后端把所有
失败都压成同一句 502。

这里钉住两件事：
  1. _post 把网关 4xx 的响应体（error/message）与状态码原样带回，不吞掉；
  2. _verify_failure 按原因给出不同的状态码，且真断线时仍是 502。

后来加的一层限制（安全审计）：对**用户**可见的区分只保留到"能不能自助解决"这个
粒度，不再把内部细节一起端出去。具体两条：

  · 「账号不存在」不再是独立状态码，由调用方合并进 valid=False，与密码错完全同形。
    这个端点会把账号密码转发到券商验证，可区分的 404 等于给出一个"该账号在券商侧
    是否存在"的查询接口，那是撞库的第一步。
  · 「网关不可用」不再把 error/retcode 拼进 detail。那些是网关与 MT5 的内部状态，
    用户拿它没有任何用，却能用来推断后端拓扑与故障位置；改为只写日志。

上面那次误导排查的教训依然成立、也依然被本文件钉住：真正会让人去查一台健康服务器
的是「组未开放」与「网关故障」这两类，它们之间的区分一个都没有丢。

Pins that a gateway refusal reaches the user intact: the client carries the 4xx
body through instead of flattening it, and the router maps each cause to a
distinct status.

A later security-audit constraint narrows what the *user* sees to "can I fix this
myself?" granularity: "account not found" is folded into valid=False by the
caller (a distinguishable 404 would be an existence oracle against the broker,
step one of credential stuffing), and gateway outages no longer splice
error/retcode into the detail (internal gateway/MT5 state, useful only for
inferring our topology) — those go to the log. The original lesson still holds
and is still pinned here: the group-vs-outage distinction, which is what
misdirected the investigation, is fully intact.
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


def test_outage_detail_carries_no_internal_code():
    """网关故障对用户只是「稍后重试」，不该带上 error/retcode。

    这些码（request_failed、unauthorized、MTRetCode 枚举名）描述的是网关与 MT5
    的内部状态：用户既看不懂也无法据此行动，却足以让人分辨出后端是"连不上"还是
    "token 不对"，从而推断拓扑。排查所需的全部字段由调用方写进 warning 日志。
    """
    for err in ("request_failed", "unauthorized", "MT_RET_ERR_NOT_CONNECTED"):
        detail = _verify_failure(_fail(error=err, status=0)).detail
        assert err not in detail
    assert " / " in detail  # 仍是双语格式


def test_missing_account_is_not_distinguishable_from_a_wrong_password():
    """「账号不存在」不能是一个可区分的答案。

    _verify_failure 不再认识 404——它由 gateway_verify 合并进 valid=False 分支，
    与密码错返回同一个响应体。若哪天有人给 _verify_failure 补回一条 404 专属映射，
    这条用例会失败，提醒他这不是遗漏而是刻意为之。
    """
    exc = _verify_failure(_fail(error="MT_RET_ERR_NOTFOUND", status=404))
    # 落进兜底的 502「稍后重试」，而不是一个宣告"查无此号"的 404
    assert exc.status_code != 404
    assert "MT_RET_ERR_NOTFOUND" not in exc.detail
