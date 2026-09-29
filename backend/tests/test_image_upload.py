"""image_upload：上传带 Cache-Control、URL 带 #w=&h= 尺寸片段（纯 Python 读图片头）。
Uploads carry Cache-Control and the returned URL carries the image size fragment."""
import struct
import zlib

import httpx
import pytest

from app.services import image_upload as iu


def _png(w, h):
    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + b"\x00\x00\x00" * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _jpeg(w, h):
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    dqt = b"\xff\xdb" + struct.pack(">H", 5) + b"\x00\x01\x02"          # 一个无关段先被跳过 / an unrelated segment
    sof = b"\xff\xc0" + struct.pack(">H", 11) + b"\x08" + struct.pack(">HH", h, w) + b"\x01\x01\x11\x00"
    return b"\xff\xd8" + app0 + dqt + sof + b"\xff\xda\x00\x02\xff\xd9"


def _gif(w, h):
    return b"GIF89a" + struct.pack("<HH", w, h) + b"\x00\x00\x00;"


def _webp_vp8x(w, h):
    body = b"VP8X" + struct.pack("<I", 10) + b"\x00\x00\x00\x00" + (w - 1).to_bytes(3, "little") + (h - 1).to_bytes(3, "little")
    return b"RIFF" + struct.pack("<I", 4 + len(body)) + b"WEBP" + body


def _webp_vp8l(w, h):
    bits = (w - 1) | ((h - 1) << 14)
    body = b"VP8L" + struct.pack("<I", 5) + b"\x2f" + struct.pack("<I", bits)
    return b"RIFF" + struct.pack("<I", 4 + len(body)) + b"WEBP" + body


def _webp_vp8(w, h):
    body = b"VP8 " + struct.pack("<I", 10) + b"\x00\x00\x00" + b"\x9d\x01\x2a" + struct.pack("<HH", w, h)
    return b"RIFF" + struct.pack("<I", 4 + len(body)) + b"WEBP" + body


@pytest.mark.parametrize("make,ext", [(_png, "png"), (_jpeg, "jpg"), (_gif, "gif"),
                                      (_webp_vp8x, "webp"), (_webp_vp8l, "webp"), (_webp_vp8, "webp")])
def test_image_size_readers(make, ext):
    assert iu._image_size(make(1200, 800), ext) == (1200, 800)


def test_image_size_unreadable_returns_none():
    assert iu._image_size(b"\x89PNG\r\n\x1a\n", "png") is None
    assert iu._image_size(b"\xff\xd8\xff\xe0\x00", "jpg") is None
    assert iu._image_size(b"RIFF\x00\x00\x00\x00WEBPJUNK" + b"\x00" * 30, "webp") is None


@pytest.fixture()
def configured(monkeypatch):
    monkeypatch.setattr(iu.settings, "SUPABASE_URL", "https://x.supabase.co")
    monkeypatch.setattr(iu.settings, "SUPABASE_SERVICE_KEY", "svc")
    monkeypatch.setattr(iu.settings, "SUPABASE_STORAGE_BUCKET", "pics")
    calls = []

    def _post(url, content=None, headers=None, timeout=None):
        calls.append({"url": url, "headers": headers})
        return httpx.Response(200, request=httpx.Request("POST", url))

    monkeypatch.setattr(iu.httpx, "post", _post)
    return calls


def test_upload_sends_immutable_cache_control_and_returns_size_fragment(configured):
    url = iu.upload_image(_png(1200, 800))
    assert configured[0]["headers"]["Cache-Control"] == "max-age=31536000, immutable"
    assert configured[0]["headers"]["x-upsert"] == "false"
    assert url.startswith("https://x.supabase.co/storage/v1/object/public/pics/") and url.endswith(".png#w=1200&h=800")


def test_upload_without_readable_size_has_no_fragment(configured):
    truncated = b"\x89PNG\r\n\x1a\n" + b"\x00" * 6
    url = iu.upload_image(truncated)
    assert "#" not in url and url.endswith(".png")
