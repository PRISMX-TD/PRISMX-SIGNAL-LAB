"""请求体大小上限（core/admission.BodyLimitMiddleware）：鉴权之前就把超大请求体挡在门外。

审计 backend/main.py:request-body-parsed-before-auth-without-app-body-cap：EA 行情、支付回调、
图片上传这些端点都是先把整段请求体解析 / spool 完才鉴权，应用里又没有任何请求体上限，匿名请求
能按请求体大小花掉 CPU、内存与临时盘。修复后：按路径给预算，Content-Length 超了直接 413（下游
一个字节都不读），没有 Content-Length 的分块请求读到超限的那一块也 413。

Request-body budget: oversize bodies are refused with 413 before any parsing or auth —
declared Content-Length up front, streamed (chunked) bodies as soon as they overflow.
"""
import pytest
from fastapi.testclient import TestClient

from app.core import admission
from app.core.config import settings
from app.main import app

P = settings.API_PREFIX


@pytest.fixture()
def client():
    return TestClient(app, raise_server_exceptions=False)


def test_feed_body_over_budget_is_413_before_model_validation(client, monkeypatch):
    # 修复前：整段 JSON 先被解析成 FeedRequest，再在函数体里因为没带 X-EA-Token 回 401。
    # Before the fix the whole body was decoded into FeedRequest, then the handler said 401.
    from app.routers import chart

    monkeypatch.setattr(settings, "REQUEST_BODY_BULK_MAX_BYTES", 4096)
    checked = []
    monkeypatch.setattr(chart, "_valid_ea_token", lambda tok: checked.append(tok) or False)
    body = '{"mode":"tick","series":[' + ",".join(['{"symbol":"XAUUSD","interval":"M1","bars":[]}'] * 200) + "]}"
    assert len(body) > 4096
    r = client.post(f"{P}/feed/candles", content=body, headers={"content-type": "application/json"})
    assert r.status_code == 413
    assert checked == []


def test_ipn_webhook_over_64k_is_413_before_signature_parse(client, monkeypatch):
    from app.services import nowpayments

    calls = []
    real = nowpayments.json.loads
    monkeypatch.setattr(nowpayments.json, "loads", lambda *a, **k: calls.append(1) or real(*a, **k))
    body = '{"payment_status":"finished","pad":"' + "a" * (70 * 1024) + '"}'
    r = client.post(f"{P}/payments/webhook", content=body,
                    headers={"content-type": "application/json", "x-nowpayments-sig": "bad"})
    assert r.status_code == 413
    assert calls == []


def test_upload_over_budget_is_413_before_multipart_spool(client, monkeypatch):
    from starlette.datastructures import UploadFile

    monkeypatch.setattr(settings, "UPLOAD_MAX_BYTES", 1024)
    written = []
    orig = UploadFile.write

    async def spy(self, data):
        written.append(len(data))
        return await orig(self, data)

    monkeypatch.setattr(UploadFile, "write", spy)
    big = b"\x89PNG" + b"x" * (200 * 1024)
    r = client.post(f"{P}/admin/upload-image", files={"file": ("a.png", big, "image/png")})
    assert r.status_code == 413
    assert written == []


def test_streamed_body_without_content_length_is_cut_off(client, monkeypatch):
    """分块传输（没有 Content-Length）：读到超限那一块就 413，后面的扫描/解析不会跑。
    Chunked body with no Content-Length: 413 at the chunk that overflows; no scan runs."""
    from app.routers import webhook

    scans = []
    monkeypatch.setattr(webhook, "_extract_json_block", lambda text: scans.append(len(text)))

    def gen():
        yield b"{"
        for _ in range(40):
            yield b"a" * 4096

    r = client.post(f"{P}/webhook/trend", content=gen())
    assert r.status_code == 413
    assert scans == []


def test_small_bodies_still_pass(client):
    r = client.post(f"{P}/telemetry/csp-report", content=b'{"csp-report":{"document-uri":"x"}}',
                    headers={"content-type": "application/csp-report"})
    assert r.status_code == 204


def test_telemetry_and_unsubscribe_have_small_budgets(client):
    r = client.post(f"{P}/telemetry/client-error", content=b"x" * (80 * 1024))
    assert r.status_code == 413
    r = client.post(f"{P}/email/unsubscribe", content=b"t=" + b"x" * (32 * 1024),
                    headers={"content-type": "application/x-www-form-urlencoded"})
    assert r.status_code == 413


def test_budget_table():
    up = settings.UPLOAD_MAX_BYTES
    assert admission.body_budget(f"{P}/payments/webhook") == 64 * 1024
    assert admission.body_budget(f"{P}/webhook/tradingview") == 64 * 1024
    assert admission.body_budget(f"{P}/share/image") == up + 64 * 1024
    assert admission.body_budget(f"{P}/tickets/upload-image") == up + 64 * 1024
    assert admission.body_budget(f"{P}/admin/upload-image") == up + 64 * 1024
    assert admission.body_budget(f"{P}/feed/candles") == settings.REQUEST_BODY_BULK_MAX_BYTES
    assert admission.body_budget(f"{P}/bridge/trade-history") == settings.REQUEST_BODY_BULK_MAX_BYTES
    assert admission.body_budget(f"{P}/signals") == settings.REQUEST_BODY_MAX_BYTES
    # 线上真实最大载荷：日常 K 线回补约 1.9MB（EA 注释），要留足余量
    # Largest real payload: the routine candle backfill is ~1.9MB (EA comment); keep headroom.
    assert settings.REQUEST_BODY_BULK_MAX_BYTES >= 8 * 1024 * 1024
