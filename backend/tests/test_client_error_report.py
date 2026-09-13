"""前端错误上报端点：ErrorBoundary / lazyRetry 把「渲染崩了 / chunk 拉不到 / 因此
整页重载」发到这里，只写日志。它是"大陆用户渲染失败到底是网络还是代码"这个问题
唯一的数据来源，所以钉住：kind 白名单、字段白名单与截断、脏输入一律 204。
匿名端点，绝不能因为一条坏上报抛 500。
Anonymous client-error sink: kind/field whitelist, truncation, always 204.
"""
import asyncio
import json
import logging

from starlette.requests import Request

from app.routers import telemetry


def _post(body: bytes):
    scope = {"type": "http", "method": "POST", "path": "/api/telemetry/client-error",
             "headers": [(b"content-type", b"application/json")],
             "client": ("127.0.0.1", 1), "query_string": b"", "server": ("t", 80), "scheme": "http"}
    sent = {"done": False}

    async def receive():
        if sent["done"]:
            return {"type": "http.disconnect"}
        sent["done"] = True
        return {"type": "http.request", "body": body, "more_body": False}

    return asyncio.run(telemetry.client_error(Request(scope, receive)))


def _lines(caplog):
    return [r.getMessage() for r in caplog.records if "client error" in r.getMessage()]


def test_chunk_error_is_logged_with_kind_and_context(caplog):
    payload = {"kind": "chunk", "name": "TypeError",
               "message": "Failed to fetch dynamically imported module: https://x/assets/ChartsPage-abc.js",
               "path": "/charts", "app": True, "online": True, "ua": "Mozilla/5.0 (Linux; Android 14) wv",
               "chunk": "ChartsPage", "retries": "2", "secret_token": "must-not-appear"}
    with caplog.at_level(logging.WARNING, logger="prismx.client_error"):
        assert _post(json.dumps(payload).encode()).status_code == 204
    line = _lines(caplog)[0]
    assert '"kind": "chunk"' in line and "ChartsPage" in line and '"app": "True"' in line
    assert "secret_token" not in line          # 不在白名单的键不落日志


def test_fields_are_truncated_per_whitelist(caplog):
    # 整体要留在 16KB 上限之内（否则被整条丢弃，那是另一条用例），单字段各自超出自己的上限
    # Stay under the 16KB body cap (oversize is a separate case); exceed each field's own cap.
    payload = {"kind": "render", "message": "m" * 2000, "stack": "s" * 8000, "ua": "u" * 1000}
    with caplog.at_level(logging.WARNING, logger="prismx.client_error"):
        assert _post(json.dumps(payload).encode()).status_code == 204
    logged = json.loads(_lines(caplog)[0].split(" ", 2)[2])
    assert len(logged["message"]) == 500 and len(logged["stack"]) == 4000 and len(logged["ua"]) == 300


def test_unknown_kind_and_garbage_are_swallowed(caplog):
    with caplog.at_level(logging.WARNING, logger="prismx.client_error"):
        assert _post(json.dumps({"kind": "evil", "message": "x"}).encode()).status_code == 204
        assert _post(json.dumps({"message": "no kind"}).encode()).status_code == 204
        assert _post(json.dumps(["not", "a", "dict"]).encode()).status_code == 204
        assert _post(b"").status_code == 204
        assert _post(b"not json").status_code == 204
        assert _post(b"x" * (telemetry.CLIENT_ERROR_MAX_BYTES + 1)).status_code == 204
    assert not _lines(caplog)


def test_all_three_kinds_are_accepted(caplog):
    with caplog.at_level(logging.WARNING, logger="prismx.client_error"):
        for kind in ("render", "chunk", "chunk-reload"):
            assert _post(json.dumps({"kind": kind, "message": kind}).encode()).status_code == 204
    assert sorted(json.loads(l.split(" ", 2)[2])["kind"] for l in _lines(caplog)) == ["chunk", "chunk-reload", "render"]
