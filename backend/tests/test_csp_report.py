"""CSP 违规上报端点：前端的 Content-Security-Policy 一直是 Report-Only 且没有上报
地址，等于策略从没被观察。现在 vercel.json 的 report-uri 指到这里，只写日志。
匿名端点，所以钉住：任何脏输入都 204、超长丢弃、两种报告格式都能读出关键字段。
Anonymous CSP report sink: always 204, size cap, both report shapes parsed.
"""
import asyncio
import json
import logging

from starlette.requests import Request

from app.routers import telemetry


def _post(body: bytes):
    scope = {"type": "http", "method": "POST", "path": "/api/telemetry/csp-report",
             "headers": [(b"content-type", b"application/csp-report")],
             "client": ("127.0.0.1", 1), "query_string": b"", "server": ("t", 80), "scheme": "http"}
    sent = {"done": False}

    async def receive():
        if sent["done"]:
            return {"type": "http.disconnect"}
        sent["done"] = True
        return {"type": "http.request", "body": body, "more_body": False}

    return asyncio.run(telemetry.csp_report(Request(scope, receive)))


def test_legacy_report_is_logged_with_key_fields(caplog):
    payload = {"csp-report": {"document-uri": "https://www.prismxsignallab.com/app",
                              "violated-directive": "script-src", "blocked-uri": "https://evil.example/x.js",
                              "ignored": "x" * 1000}}
    with caplog.at_level(logging.WARNING, logger="prismx.csp"):
        rsp = _post(json.dumps(payload).encode())
    assert rsp.status_code == 204
    line = [r.getMessage() for r in caplog.records if "csp violation" in r.getMessage()][0]
    assert "script-src" in line and "evil.example" in line and "ignored" not in line


def test_reporting_api_shape_is_accepted(caplog):
    payload = [{"type": "csp-violation", "body": {"documentURL": "https://x/", "effectiveDirective": "img-src",
                                                   "blockedURL": "https://y/z.png"}}]
    with caplog.at_level(logging.WARNING, logger="prismx.csp"):
        assert _post(json.dumps(payload).encode()).status_code == 204
    assert any("img-src" in r.getMessage() for r in caplog.records)


def test_garbage_and_oversize_bodies_are_swallowed(caplog):
    with caplog.at_level(logging.WARNING, logger="prismx.csp"):
        assert _post(b"").status_code == 204
        assert _post(b"not json").status_code == 204
        assert _post(b'{"csp-report": "nope"}').status_code == 204
        assert _post(b"x" * (telemetry.CSP_REPORT_MAX_BYTES + 1)).status_code == 204
    assert not any("csp violation" in r.getMessage() for r in caplog.records)


def test_vercel_header_points_report_uri_here():
    import pathlib
    cfg = json.loads(pathlib.Path(__file__).resolve().parents[2].joinpath("frontend", "vercel.json").read_text(encoding="utf-8"))
    csp = next(h["value"] for h in cfg["headers"][0]["headers"] if h["key"].startswith("Content-Security-Policy"))
    assert "report-uri https://api.prismxsignallab.com/api/telemetry/csp-report" in csp
