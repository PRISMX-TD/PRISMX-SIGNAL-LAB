"""私有图片桶：分享图过期即删 + 每个用户的累计配额（services/image_upload.py）。

审计 backend/services/image_upload.py:private-bucket-uploads-never-expire-rate-only-quota：
分享图（share/<uid>/…）令牌 24 小时就失效，对象却永远留着；工单图传了不用也永远留着；唯一的
约束是按天限速，不是配额。修复后：
  · 每次上传前列出该用户的文件夹：分享文件夹里超过保留期的先删掉；
  · 剩下的累计字节数到了 PRIVATE_IMAGE_QUOTA_BYTES 就拒绝新上传（不碰存储）；
  · 至多每小时一次，在后台线程里把所有用户 share/ 下过期的对象扫掉（不回来的用户也清得到）；
  · 列目录失败时放行（存储抖一下不该把上传整个挡住）。
检查放在 enforce_private_quota(folder) 里，由上传路由在 upload_private_image 之前调用
（share 已接上；tickets 路由由其维护者接一行）。

The checks live in enforce_private_quota(folder), called by upload routes right before
upload_private_image (wired for share; the tickets route needs the same one line).

Private bucket: expired share/ objects are purged (per user on upload, and a throttled
background sweep across all users), and a cumulative per-user byte quota rejects uploads
once a folder is full. A failed listing fails open.
"""
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.core.config import settings
from app.services import image_upload as iu

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def _iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


class _Storage:
    """假 Supabase Storage：list / 上传 / 删除 / Fake storage: list, upload, delete."""

    def __init__(self, folders: dict[str, list[tuple[str, int, datetime]]]):
        self.folders = folders
        self.uploads: list[str] = []
        self.deleted: list[str] = []
        self.list_fail = False

    def post(self, url, json=None, content=None, headers=None, timeout=None):
        req = httpx.Request("POST", url)
        if "/object/list/" in url:
            if self.list_fail:
                return httpx.Response(500, text="boom", request=req)
            prefix = json["prefix"].strip("/")
            offset, limit = json.get("offset", 0), json.get("limit", 100)
            if prefix == "share":
                rows = [{"name": k.split("/", 1)[1], "id": None, "metadata": None}
                        for k in self.folders if k.startswith("share/")]
            else:
                rows = [{"name": n, "id": n, "created_at": _iso(t), "metadata": {"size": s}}
                        for n, s, t in self.folders.get(prefix, [])]
            return httpx.Response(200, json=rows[offset:offset + limit], request=req)
        if "/storage/v1/object/" in url:
            self.uploads.append(url.split(f"/{settings.TICKET_IMAGE_BUCKET}/", 1)[1])
            return httpx.Response(200, json={"Key": "x"}, request=req)
        raise AssertionError(url)

    def request(self, method, url, json=None, headers=None, timeout=None):
        assert method == "DELETE"
        self.deleted.extend(json["prefixes"])
        for p in json["prefixes"]:
            folder, name = p.rsplit("/", 1)
            self.folders[folder] = [e for e in self.folders.get(folder, []) if e[0] != name]
        return httpx.Response(200, json=[], request=httpx.Request(method, url))


@pytest.fixture()
def storage(monkeypatch):
    monkeypatch.setattr(settings, "SUPABASE_URL", "https://sb.example")
    monkeypatch.setattr(settings, "SUPABASE_SERVICE_KEY", "service-key")
    monkeypatch.setattr(settings, "TICKET_IMAGE_BUCKET", "ticket-images")
    st = _Storage({})
    monkeypatch.setattr(iu.httpx, "post", st.post)
    monkeypatch.setattr(iu.httpx, "request", st.request)
    # 全局清扫默认同步跑，便于断言 / run the global sweep inline for the assertions
    monkeypatch.setattr(iu, "_spawn", lambda fn: fn())
    monkeypatch.setattr(iu, "_last_global_sweep", 0.0)
    return st


def test_share_upload_purges_expired_objects_first(storage):
    now = datetime.now(timezone.utc)
    storage.folders["share/u1"] = [
        ("old1.png", 1000, now - timedelta(days=3)),
        ("old2.png", 1000, now - timedelta(hours=26)),
        ("fresh.png", 1000, now - timedelta(hours=1)),
    ]
    iu.enforce_private_quota("share/u1")
    assert sorted(storage.deleted) == ["share/u1/old1.png", "share/u1/old2.png"]



def test_global_sweep_cleans_users_who_never_come_back(storage):
    now = datetime.now(timezone.utc)
    storage.folders["share/gone"] = [("a.png", 10, now - timedelta(days=10))]
    storage.folders["share/u1"] = []
    iu.enforce_private_quota("share/u1")
    assert "share/gone/a.png" in storage.deleted


def test_global_sweep_is_throttled(storage, monkeypatch):
    runs = []
    monkeypatch.setattr(iu, "sweep_expired_share_images", lambda: runs.append(1))
    storage.folders["share/u1"] = []
    iu.enforce_private_quota("share/u1")
    iu.enforce_private_quota("share/u1")
    assert runs == [1]


def test_ticket_folder_is_never_purged_by_age(storage):
    now = datetime.now(timezone.utc)
    storage.folders["u1"] = [("old.png", 1000, now - timedelta(days=300))]
    iu.enforce_private_quota("u1")
    assert "u1/old.png" not in storage.deleted


def test_quota_rejects_upload_without_touching_storage(storage, monkeypatch):
    monkeypatch.setattr(settings, "PRIVATE_IMAGE_QUOTA_BYTES", 5000)
    now = datetime.now(timezone.utc)
    storage.folders["u1"] = [(f"{i}.png", 1000, now - timedelta(days=1)) for i in range(5)]
    with pytest.raises(iu.UploadError):
        iu.enforce_private_quota("u1")


def test_quota_counts_only_live_share_objects(storage, monkeypatch):
    monkeypatch.setattr(settings, "PRIVATE_IMAGE_QUOTA_BYTES", 5000)
    now = datetime.now(timezone.utc)
    storage.folders["share/u1"] = [(f"{i}.png", 1000, now - timedelta(days=2)) for i in range(10)]
    iu.enforce_private_quota("share/u1")         # 过期的先删，配额按剩下的算 / expired purged first
    assert len(storage.deleted) == 10


def test_listing_failure_fails_open(storage):
    storage.list_fail = True
    iu.enforce_private_quota("u1")                  # 不抛 / does not raise


def test_share_route_enforces_quota_before_storing(monkeypatch):
    """share 上传路由：配额满了 413/400 之前不碰存储。/ The share route checks before storing."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.core.strategy_limits import user_limiter
    from app.routers import share
    from app.services import deps

    monkeypatch.setattr(share, "is_private_configured", lambda: True)
    order = []

    def full(folder):
        order.append(("quota", folder))
        raise iu.UploadError("full")

    monkeypatch.setattr(share, "enforce_private_quota", full)
    monkeypatch.setattr(share, "upload_private_image", lambda d, f: order.append(("upload", f)))
    monkeypatch.setattr(user_limiter, "enabled", False)
    app = FastAPI()
    app.include_router(share.router, prefix="/api")
    app.dependency_overrides[deps.get_current_user_id_light] = lambda: "u1"
    r = TestClient(app).post("/api/share/image", files={"file": ("c.png", PNG, "image/png")})
    assert r.status_code == 400
    assert order == [("quota", "share/u1")]
