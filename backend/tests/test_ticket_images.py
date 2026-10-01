"""工单附图：私有桶上传、签名链接、消息里的图片键校验。
Ticket images: private-bucket upload, signed URLs, and image-key validation on messages.
"""
import json
import struct
import zlib

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from pydantic import ValidationError

import app.routers.tickets as tk
from app.models import Ticket, TicketReply, User
from app.routers.tickets import (
    admin_get_ticket,
    admin_reply_to_ticket,
    create_ticket,
    get_ticket,
    list_all_tickets,
    list_my_tickets,
    reply_to_ticket,
)
from app.schemas import AdminTicketReplyCreate, TicketCreate, TicketReplyCreate
from app.services import image_upload as iu
from app.services.deps import get_current_user_id_light

HEX = "0123456789abcdef" * 2


def _png(w, h):
    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\x00\x00\x00" * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


# ---------- services/image_upload：私有桶 / private bucket ----------

@pytest.fixture()
def storage(monkeypatch):
    """配好 Supabase，记录所有 httpx.post；responder(url, kwargs) 决定回什么。
    Configure Supabase and record every httpx.post; `responder` decides each response."""
    monkeypatch.setattr(iu.settings, "SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setattr(iu.settings, "SUPABASE_SERVICE_KEY", "svc")
    monkeypatch.setattr(iu.settings, "TICKET_IMAGE_BUCKET", "tix")
    monkeypatch.setattr(iu, "_sign_cache", {})
    state = {"calls": [], "responder": lambda url, kw: httpx.Response(200, json={})}

    def _post(url, **kwargs):
        state["calls"].append({"url": url, **kwargs})
        resp = state["responder"](url, kwargs)
        resp.request = httpx.Request("POST", url)
        return resp

    monkeypatch.setattr(iu.httpx, "post", _post)
    return state


def test_private_upload_returns_owner_scoped_key_with_size(storage):
    key = iu.upload_private_image(_png(640, 480), "user-1")
    folder, rest = key.split("/", 1)
    assert folder == "user-1"
    assert rest.endswith(".png#w=640&h=480") and len(rest.split(".")[0]) == 32
    call = storage["calls"][0]
    assert call["url"] == f"https://x.supabase.co/storage/v1/object/tix/{key.split('#')[0]}"
    assert call["headers"]["x-upsert"] == "false"
    # 生成的键正好能通过路由里的校验 / the produced key passes the router's check
    assert tk._checked_images([key], "user-1") == json.dumps([key])


def test_private_upload_creates_missing_bucket_as_private_then_retries(storage):
    seen = {"puts": 0}

    def responder(url, kw):
        if url.endswith("/storage/v1/bucket"):
            return httpx.Response(200, json={"name": "tix"})
        seen["puts"] += 1
        if seen["puts"] == 1:
            return httpx.Response(400, json={"statusCode": "404", "error": "Bucket not found", "message": "Bucket not found"})
        return httpx.Response(200, json={})

    storage["responder"] = responder
    key = iu.upload_private_image(_png(10, 10), "u")
    assert key.startswith("u/")
    create = [c for c in storage["calls"] if c["url"].endswith("/storage/v1/bucket")]
    assert len(create) == 1 and create[0]["json"]["public"] is False and create[0]["json"]["id"] == "tix"
    assert seen["puts"] == 2


def test_private_upload_rejects_non_images(storage):
    with pytest.raises(iu.UploadError):
        iu.upload_private_image(b"%PDF-1.7 not an image", "u")
    assert storage["calls"] == []


def test_signing_is_one_batch_call_reattaches_size_and_caches(storage):
    a = f"u/{HEX}.png#w=10&h=20"
    b = f"u/{HEX[::-1]}.jpg"

    def responder(url, kw):
        assert url == "https://x.supabase.co/storage/v1/object/sign/tix"
        return httpx.Response(200, json=[
            {"error": None, "path": p, "signedURL": f"/object/sign/tix/{p}?token=t"} for p in kw["json"]["paths"]
        ])

    storage["responder"] = responder
    out = iu.signed_image_urls([a, b, a])
    assert out[a] == f"https://x.supabase.co/storage/v1/object/sign/tix/u/{HEX}.png?token=t#w=10&h=20"
    assert out[b] == f"https://x.supabase.co/storage/v1/object/sign/tix/{b}?token=t"
    assert len(storage["calls"]) == 1
    assert storage["calls"][0]["json"]["paths"] == [f"u/{HEX}.png", b]
    # 第二次命中缓存，不再请求 / the second call is served from cache
    assert iu.signed_image_urls([a]) == {a: out[a]}
    assert len(storage["calls"]) == 1


def test_signing_failure_returns_nothing_instead_of_raising(storage):
    def responder(url, kw):
        raise httpx.ConnectTimeout("slow")

    storage["responder"] = responder
    assert iu.signed_image_urls([f"u/{HEX}.png"]) == {}


def test_signing_skips_items_storage_could_not_sign(storage):
    ok, gone = f"u/{HEX}.png", f"u/{HEX[::-1]}.png"
    storage["responder"] = lambda url, kw: httpx.Response(200, json=[
        {"error": None, "path": ok, "signedURL": f"/object/sign/tix/{ok}?token=t"},
        {"error": "Either the object does not exist or you do not have access to it", "path": gone, "signedURL": None},
    ])
    assert set(iu.signed_image_urls([ok, gone])) == {ok}


# ---------- 路由 / router ----------

@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    import app.services.push_dispatch as pd

    monkeypatch.setattr(pd, "dispatch_ticket_reply", lambda *a, **k: None)
    monkeypatch.setattr(tk, "notify_ws", lambda *a, **k: None)


@pytest.fixture()
def signer(monkeypatch):
    """路由里的签名换成可控的假实现 / a controllable fake signer for the router."""
    state = {"fail": False, "calls": []}

    def _sign(keys):
        state["calls"].append(list(keys))
        return {} if state["fail"] else {k: f"https://signed/{k}" for k in keys}

    monkeypatch.setattr(tk, "signed_image_urls", _sign)
    return state


def _user(db, email, role="user"):
    u = User(email=email, api_token=f"tok_{email}", role=role)
    db.add(u)
    db.commit()
    return u


def _key(user, n=0, frag="#w=800&h=600"):
    return f"{user.id}/{format(n, '032x')}.png{frag}"


def test_image_only_ticket_is_accepted_and_signed(db_session, signer):
    owner = _user(db_session, "o@x.com")
    k = _key(owner)
    out = create_ticket(TicketCreate(title="截图", category="technical", images=[k]), db_session, owner)
    assert out.replies[0].body == ""
    assert out.replies[0].images == [f"https://signed/{k}"]
    assert out.replies[0].imageCount == 1
    row = db_session.query(TicketReply).one()
    assert json.loads(row.images) == [k]


def test_message_needs_text_or_images():
    with pytest.raises(ValidationError):
        TicketReplyCreate(body="   ")
    with pytest.raises(ValidationError):
        TicketCreate(title="t", category="technical", body="")
    assert TicketReplyCreate(images=["a/b"]).images == ["a/b"]


def test_at_most_six_images_per_message():
    with pytest.raises(ValidationError):
        TicketReplyCreate(body="x", images=[f"u/{i}" for i in range(7)])


@pytest.mark.parametrize("bad", [
    "https://evil.example/pixel.png",
    "OTHER/" + HEX + ".png",
    "{uid}/" + HEX + ".exe",
    "{uid}/../" + HEX + ".png",
    "{uid}/" + HEX + ".png#w=1&h=1&x=2",
])
def test_foreign_or_malformed_keys_are_rejected(db_session, signer, bad):
    owner = _user(db_session, "o@x.com")
    with pytest.raises(HTTPException) as exc:
        create_ticket(
            TicketCreate(title="t", category="technical", body="hi", images=[bad.format(uid=owner.id)]),
            db_session, owner,
        )
    assert exc.value.status_code == 400
    assert db_session.query(Ticket).count() == 0


def test_user_cannot_attach_someone_elses_upload(db_session, signer):
    owner = _user(db_session, "o@x.com")
    other = _user(db_session, "p@x.com")
    t = create_ticket(TicketCreate(title="t", category="technical", body="hi"), db_session, owner)
    with pytest.raises(HTTPException) as exc:
        reply_to_ticket(t.id, TicketReplyCreate(images=[_key(other)]), db_session, owner)
    assert exc.value.status_code == 400


def test_admin_reply_with_own_images_and_thread_signed_in_one_batch(db_session, signer):
    owner = _user(db_session, "o@x.com")
    admin = _user(db_session, "boss@x.com", role="admin")
    t = create_ticket(TicketCreate(title="t", category="technical", body="hi", images=[_key(owner, 1)]), db_session, owner)
    out = admin_reply_to_ticket(t.id, AdminTicketReplyCreate(body="看这里", images=[_key(admin, 2)]), db_session, admin)
    assert [r.imageCount for r in out.replies] == [1, 1]
    signer["calls"].clear()
    detail = get_ticket(t.id, db_session, owner)
    assert len(signer["calls"]) == 1 and len(signer["calls"][0]) == 2
    assert detail.replies[1].images == [f"https://signed/{_key(admin, 2)}"]
    assert admin_get_ticket(t.id, db_session, admin).replies[0].images == [f"https://signed/{_key(owner, 1)}"]


def test_list_previews_carry_count_but_no_urls(db_session, signer):
    owner = _user(db_session, "o@x.com")
    admin = _user(db_session, "boss@x.com", role="admin")
    create_ticket(TicketCreate(title="t", category="technical", images=[_key(owner), _key(owner, 1)]), db_session, owner)
    signer["calls"].clear()
    mine = list_my_tickets(db_session, owner)
    assert mine[0].latestReply.imageCount == 2 and mine[0].latestReply.images == []
    every = list_all_tickets(None, None, 50, 0, db_session, admin)
    assert every[0].latestReply.imageCount == 2
    assert signer["calls"] == []


def test_unsignable_images_keep_their_count_and_text_still_returns(db_session, signer):
    owner = _user(db_session, "o@x.com")
    t = create_ticket(TicketCreate(title="t", category="technical", body="文字还在", images=[_key(owner)]), db_session, owner)
    signer["fail"] = True
    detail = get_ticket(t.id, db_session, owner)
    assert detail.replies[0].body == "文字还在"
    assert detail.replies[0].images == [] and detail.replies[0].imageCount == 1


# ---------- 上传端点 / upload endpoint ----------

def _upload_client(monkeypatch, configured=True, result="uid-1/" + HEX + ".png#w=1&h=1", error=None):
    from app.core.rate_limit import limiter
    from app.core.strategy_limits import user_limiter

    monkeypatch.setattr(tk, "is_private_configured", lambda: configured)
    seen = {}

    def _up(data, folder):
        seen["data"], seen["folder"] = data, folder
        if error:
            raise iu.UploadError(error)
        return result

    monkeypatch.setattr(tk, "upload_private_image", _up)
    app = FastAPI()
    app.state.limiter = limiter
    app.state.user_limiter = user_limiter
    app.include_router(tk.router)
    app.dependency_overrides[get_current_user_id_light] = lambda: "uid-1"
    return TestClient(app, raise_server_exceptions=False), seen


def test_upload_endpoint_stores_under_the_callers_folder(monkeypatch):
    client, seen = _upload_client(monkeypatch)
    res = client.post("/tickets/upload-image", files={"file": ("a.png", _png(1, 1), "image/png")})
    assert res.status_code == 200, res.text
    assert res.json() == {"key": "uid-1/" + HEX + ".png#w=1&h=1"}
    assert seen["folder"] == "uid-1" and seen["data"].startswith(b"\x89PNG")


def test_upload_endpoint_503_when_storage_missing(monkeypatch):
    client, seen = _upload_client(monkeypatch, configured=False)
    res = client.post("/tickets/upload-image", files={"file": ("a.png", _png(1, 1), "image/png")})
    assert res.status_code == 503 and seen == {}


def test_upload_endpoint_400_on_upload_error(monkeypatch):
    client, _ = _upload_client(monkeypatch, error="只支持 PNG / Only PNG")
    res = client.post("/tickets/upload-image", files={"file": ("a.txt", b"hello", "text/plain")})
    assert res.status_code == 400 and "PNG" in res.json()["detail"]
