# 分享图中转（App 保存 / 分享通道）：令牌签名与过期、上传、附件下载、保存页。
# Share-image relay (the App's save/share path): token signing and expiry, upload, attachment, page.
import time

import pytest
from fastapi import HTTPException

from app.routers import share


def _client(monkeypatch, user_id="u1"):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.core.strategy_limits import user_limiter
    from app.services import deps

    app = FastAPI()
    app.state.limiter = user_limiter
    app.include_router(share.router, prefix="/api")
    app.dependency_overrides[deps.get_current_user_id_light] = lambda: user_id
    return TestClient(app)


def test_token_roundtrip_and_rejections():
    tok = share.make_token("share/u1/abc.png")
    assert share.read_token(tok) == "share/u1/abc.png"
    p, exp, sig = tok.split(".")
    for bad in (f"{p}.{exp}.AAAA{sig[4:]}", f"{p}.{int(exp) + 1}.{sig}", "garbage", ""):
        with pytest.raises(HTTPException) as e:
            share.read_token(bad)
        assert e.value.status_code == 404
    with pytest.raises(HTTPException):
        share.read_token(tok, now=time.time() + share.TOKEN_TTL_SECONDS + 5)       # expired
    with pytest.raises(HTTPException):
        share.read_token(share.make_token("u1/not-share.png"))                      # outside share/


def test_upload_returns_signed_page_path(monkeypatch):
    seen = {}
    monkeypatch.setattr(share, "is_private_configured", lambda: True)
    def fake_upload(data, folder):
        seen["folder"] = folder
        return f"{folder}/0123abcd.png#w=1080&h=1350"
    monkeypatch.setattr(share, "upload_private_image", fake_upload)
    r = _client(monkeypatch).post("/api/share/image", files={"file": ("c.png", b"\x89PNG....", "image/png")})
    assert r.status_code == 200, r.text
    assert seen["folder"] == "share/u1"
    token = r.json()["path"].removeprefix("/share/i/")
    assert share.read_token(token) == "share/u1/0123abcd.png"          # size fragment stripped


def test_png_attachment_and_page(monkeypatch):
    monkeypatch.setattr(share, "_fetch_object", lambda path: b"PNGDATA:" + path.encode())
    c = _client(monkeypatch)
    tok = share.make_token("share/u1/x.png")
    r = c.get(f"/api/share/i/{tok}.png?dl=1")
    assert r.status_code == 200 and r.content == b"PNGDATA:share/u1/x.png"
    assert r.headers["content-type"] == "image/png"
    assert r.headers["content-disposition"].startswith("attachment")
    assert c.get(f"/api/share/i/{tok}.png").headers["content-disposition"].startswith("inline")
    page = c.get(f"/api/share/i/{tok}?lang=zh")
    assert page.status_code == 200 and "保存图片" in page.text
    assert f'src="{tok}.png"' in page.text and f'href="{tok}.png?dl=1"' in page.text
    assert page.headers["cache-control"] == "no-store"
    assert c.get("/api/share/i/bad-token").status_code == 404
    assert c.get("/api/share/i/bad-token.png").status_code == 404
