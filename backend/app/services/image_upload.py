"""图片上传到 Supabase Storage（仅管理员，经后端代理）。
工单截图是例外：普通用户也能传，但进的是私有桶、凭签名链接看，见文件末尾。
Ticket screenshots are the exception: any user may upload them, into a private bucket
viewed through signed URLs — see the end of this file.

为什么走后端代理而不是前端直传：直传要把能写存储桶的密钥交给浏览器。Supabase
的 anon key 配合 RLS 理论上可以做直传，但那要额外维护一套存储策略，而这里唯一
的上传者是管理员、每次只传一张插图——代理一次请求比维护一套 RLS 策略简单，且
service_role key 始终只存在于后端。

为什么用 httpx 裸调 REST 而不装 supabase-py：项目已经依赖 httpx（见
requirements.txt），而这里只需要一个 POST。为一个上传动作引入一个 SDK 及其传递
依赖不划算。

类型校验刻意读文件头的 magic bytes，而不信任 Content-Type 或扩展名——两者都由
客户端提供，可以随意伪造。这里只放行四种图片格式，其他一律拒绝，避免存储桶变成
任意文件的落点（桶是 public 的，能放任何文件就等于开了一个公开图床/分发点）。

Upload images to Supabase Storage (admin only, proxied through the backend).

Why proxy instead of uploading straight from the browser: a direct upload means
handing a bucket-writable key to the client. The anon key plus RLS could do it,
but that means maintaining a storage policy set, while the only uploader here is
an admin sending one illustration at a time — proxying a single request is
simpler, and the service_role key never leaves the backend.

Why raw httpx instead of supabase-py: httpx is already a dependency (see
requirements.txt) and this needs exactly one POST. Pulling in an SDK and its
transitive dependencies for that isn't worth it.

Type validation deliberately sniffs magic bytes rather than trusting
Content-Type or the file extension — both are client-supplied and trivially
forged. Only four image formats pass; everything else is rejected, so the bucket
can't become a drop point for arbitrary files (it is public, so accepting any
file would amount to running an open file host).
"""
import logging
import struct
import threading
import time
import uuid

import httpx

from app.core.config import settings

logger = logging.getLogger("prismx.upload")

# 文件头 → (扩展名, Content-Type)。WebP 需要额外校验第 8-12 字节，见 _sniff。
# Magic bytes -> (extension, Content-Type). WebP needs bytes 8-12 too, see _sniff.
_PNG = b"\x89PNG\r\n\x1a\n"
_JPEG = b"\xff\xd8\xff"
_GIF87 = b"GIF87a"
_GIF89 = b"GIF89a"


class UploadError(Exception):
    """上传失败，message 为面向管理员的双语说明。
    Upload failure; message is a bilingual explanation for the admin."""


def _too_large():
    from fastapi import HTTPException  # 只在路由调用时用到 / only used from routes

    mb = settings.UPLOAD_MAX_BYTES / (1024 * 1024)
    return HTTPException(status_code=413, detail=f"图片超过 {mb:.0f}MB 上限 / the image exceeds the {mb:.0f}MB limit")


async def read_upload_capped(file, request) -> bytes:
    """读上传文件，最多读 UPLOAD_MAX_BYTES+1 字节；超限直接 413。所有上传路由共用。

    两道判断，道理同 admin.upload_admin_image：先看声明的大小（`file.size`，回落到
    Content-Length）做快速拒绝；再**有界**地读——只读上限加一个字节，多出来就拒。
    声明值由客户端提供、可以谎报（或干脆不给，比如分块传输），所以绝不能在它之后
    `await file.read()` 整段读进内存：那样一个谎报大小的请求就能让服务端把几百 MB
    装进内存。上传服务里那道 len(data) 检查仍在，这里只是保证永远读不到那么多。

    Read an upload, at most UPLOAD_MAX_BYTES+1 bytes; anything larger is a 413. Shared
    by every upload route. The declared size (`file.size`, else Content-Length) gives a
    fast rejection; the read itself is bounded — one byte past the cap is enough to know
    it's too big. The declared size is client-supplied (or absent, e.g. chunked), so an
    unbounded `await file.read()` after it would let a lying request pull hundreds of MB
    into memory. The len(data) check in the upload functions stays; this only ensures
    the bytes read can never get that large.
    """
    limit = settings.UPLOAD_MAX_BYTES
    declared = getattr(file, "size", None)
    if declared is None:
        try:
            declared = int(request.headers.get("content-length") or 0) or None
        except ValueError:
            declared = None
    if declared is not None and declared > limit:
        raise _too_large()
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise _too_large()
    return data


def is_configured() -> bool:
    """三项配置齐全才算启用上传 / uploads are on only when all three are set."""
    return bool(settings.SUPABASE_URL and settings.SUPABASE_SERVICE_KEY and settings.SUPABASE_STORAGE_BUCKET)


def _sniff(data: bytes) -> tuple[str, str]:
    """按文件头判定图片类型，返回 (扩展名, Content-Type)；无法识别则抛错。
    Identify the image type by magic bytes; raise if unrecognized."""
    if data.startswith(_PNG):
        return "png", "image/png"
    if data.startswith(_JPEG):
        return "jpg", "image/jpeg"
    if data.startswith(_GIF87) or data.startswith(_GIF89):
        return "gif", "image/gif"
    # WebP: "RIFF" + 4 字节长度 + "WEBP" / "RIFF" + 4-byte size + "WEBP"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp", "image/webp"
    raise UploadError("只支持 PNG / JPEG / GIF / WebP 图片 / Only PNG, JPEG, GIF and WebP images are supported")


def _image_size(data: bytes, ext: str) -> tuple[int, int] | None:
    """纯 Python 读图片头里的宽高（Pillow 没装）；读不出来返回 None。只读头部几十字节，
    不解码像素。PNG：IHDR；GIF：逻辑屏幕；JPEG：扫 SOFn 标记；WebP：VP8 / VP8L / VP8X。
    Read width/height from the header in pure Python (Pillow isn't installed); None when
    it can't be read. Header bytes only, no pixel decoding."""
    try:
        if ext == "png" and len(data) >= 24 and data[12:16] == b"IHDR":
            w, h = struct.unpack(">II", data[16:24])
        elif ext == "gif" and len(data) >= 10:
            w, h = struct.unpack("<HH", data[6:10])
        elif ext == "jpg":
            i, n = 2, len(data)
            w = h = 0
            while i + 9 < n:
                if data[i] != 0xFF:
                    i += 1
                    continue
                marker = data[i + 1]
                if marker == 0xFF:                       # 填充字节 / fill byte
                    i += 1
                    continue
                if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:   # 无长度的标记 / no-length markers
                    i += 2
                    continue
                seg = struct.unpack(">H", data[i + 2:i + 4])[0]
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):   # SOF0..15（除 DHT/JPG/DAC）
                    h, w = struct.unpack(">HH", data[i + 5:i + 9])
                    break
                i += 2 + seg
        elif ext == "webp" and len(data) >= 25:
            chunk = data[12:16]
            if chunk == b"VP8 ":
                w, h = struct.unpack("<HH", data[26:30])
                w, h = w & 0x3FFF, h & 0x3FFF
            elif chunk == b"VP8L":
                b = data[21:25]
                bits = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)
                w, h = (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
            elif chunk == b"VP8X" and len(data) >= 30:
                w = int.from_bytes(data[24:27], "little") + 1
                h = int.from_bytes(data[27:30], "little") + 1
            else:
                return None
        else:
            return None
    except (struct.error, IndexError):
        return None
    return (w, h) if 0 < w <= 65535 and 0 < h <= 65535 else None


def upload_image(data: bytes) -> str:
    """上传一张图片，返回可直接放进 <img src> 的公开 URL。

    文件名用随机 UUID，不沿用上传时的原名：原名由客户端提供，可能含路径分隔符
    或非 ASCII 字符，而且两次上传同名文件会互相覆盖。UUID 同时避免了靠猜名字
    枚举桶内文件。

    Upload one image and return a public URL usable directly in <img src>.

    The object name is a random UUID rather than the client-supplied filename:
    that name can contain path separators or non-ASCII bytes, and two uploads of
    the same name would overwrite each other. A UUID also stops anyone from
    enumerating the bucket by guessing names.
    """
    if not is_configured():
        raise UploadError("后台未配置图片存储，请改用外链图片地址 / Image storage isn't configured; use an external image URL instead")
    if not data:
        raise UploadError("文件为空 / the file is empty")
    if len(data) > settings.UPLOAD_MAX_BYTES:
        mb = settings.UPLOAD_MAX_BYTES / (1024 * 1024)
        raise UploadError(f"图片超过 {mb:.0f}MB 上限 / the image exceeds the {mb:.0f}MB limit")

    ext, content_type = _sniff(data)
    key = f"{uuid.uuid4().hex}.{ext}"
    base = settings.SUPABASE_URL.rstrip("/")
    bucket = settings.SUPABASE_STORAGE_BUCKET

    try:
        resp = httpx.post(
            f"{base}/storage/v1/object/{bucket}/{key}",
            content=data,
            headers={
                "Authorization": f"Bearer {settings.SUPABASE_SERVICE_KEY}",
                "Content-Type": content_type,
                # 不允许覆盖：key 是新生成的 UUID，命中已存在的对象说明出了别的问题
                # No overwrite: the key is a fresh UUID, so a collision means
                # something else is wrong
                "x-upsert": "false",
                # 对象名是随机 UUID 且禁止覆盖，内容一辈子不变：让浏览器与 Supabase CDN 长期缓存。
                # storage-api 从这个请求头读 cacheControl 存进对象元数据（裸 httpx 不发就按 no-cache 记）。
                # The key is a random UUID and never overwritten, so the content is immutable:
                # let browsers and the Supabase CDN cache it for a year. storage-api stores this
                # header as the object's cacheControl (raw httpx sends none, so it'd be no-cache).
                "Cache-Control": "max-age=31536000, immutable",
            },
            timeout=30.0,
        )
    except httpx.HTTPError as exc:
        # 不把底层异常文本回给前端——可能包含内部地址 / don't leak internals to the client
        logger.warning("supabase storage upload failed: %s", exc)
        raise UploadError("上传失败，请稍后重试 / upload failed, please retry") from exc

    if resp.status_code >= 400:
        logger.warning("supabase storage rejected upload: %s %s", resp.status_code, resp.text[:300])
        raise UploadError("存储服务拒绝了上传，请检查存储桶配置 / storage rejected the upload, check the bucket configuration")

    url = f"{base}/storage/v1/object/public/{bucket}/{key}"
    # 宽高记进 URL 的 # 片段（不发给服务器、不影响缓存键；只存 URL 字符串，无需改库）：
    # 前端据此给 <img> 设 width/height，页面不再跳版、正文图才敢懒加载。读不出就不加。
    # Record the size in the URL fragment (never sent to the server, no effect on cache
    # keys, no schema change): the frontend sets width/height from it. Omitted when unreadable.
    size = _image_size(data, ext)
    if size:
        url += f"#w={size[0]}&h={size[1]}"
    return url


# ---------- 私有图片（工单截图）/ private images (ticket screenshots) ----------
# 与上面的公开插图分开存：工单截图常带账号、余额、付款凭证，放进公开桶就只剩「URL 猜不到」
# 一道防线，链接一外流（转发、截图里带出地址栏）谁都能打开。私有桶里的对象没有公开地址，
# 只能凭后端签发、会过期的签名链接看，而签名只在工单接口里发给本人和管理员。
# 库里存的是对象键（不是 URL）：签名会过期，存 URL 等于存一个注定失效的东西。
# Kept apart from the public illustrations above: ticket screenshots often show account
# numbers, balances and payment receipts, and in a public bucket "the URL can't be guessed"
# would be the only defence once a link leaks. Private objects have no public address and
# are viewable only through expiring signed URLs, which the ticket endpoints issue to the
# owner and admins. The database stores object keys, not URLs — a stored signed URL would
# be a thing guaranteed to expire.

_ALLOWED_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp"]

# 签名缓存：对象路径 → (签名 URL, 过期的 monotonic 时刻)。每个 worker 各一份，丢了只是多签一次。
# Signature cache: object path -> (signed URL, monotonic expiry). Per worker; losing it costs a re-sign.
_sign_lock = threading.Lock()
_sign_cache: dict[str, tuple[str, float]] = {}
_SIGN_CACHE_MAX = 5000


def is_private_configured() -> bool:
    """私有图片只要 Supabase 地址、密钥和工单桶名 / private images need the URL, key and ticket bucket."""
    return bool(settings.SUPABASE_URL and settings.SUPABASE_SERVICE_KEY and settings.TICKET_IMAGE_BUCKET)


def _auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {settings.SUPABASE_SERVICE_KEY}"}


def _bucket_missing(resp: httpx.Response) -> bool:
    # storage-api 对不存在的桶有的版本回 404、有的回 400 + body 里 statusCode "404"，按文案认。
    # storage-api answers a missing bucket with 404 on some versions and 400 + statusCode
    # "404" in the body on others, so match on the message.
    text = resp.text.lower()
    return "bucket not found" in text or "nosuchbucket" in text


def _create_private_bucket(base: str, bucket: str) -> None:
    """建私有桶；已经存在也算成功。第一次有人传工单图时由后端自己建，不用去控制台。
    Create the private bucket; "already exists" counts as success. Done by the backend on
    the first ticket upload, so nobody has to visit the dashboard."""
    resp = httpx.post(
        f"{base}/storage/v1/bucket",
        json={
            "id": bucket,
            "name": bucket,
            "public": False,
            "file_size_limit": settings.UPLOAD_MAX_BYTES,
            "allowed_mime_types": _ALLOWED_MIME,
        },
        headers=_auth_headers(),
        timeout=10.0,
    )
    if resp.status_code < 400 or resp.status_code == 409 or "already exists" in resp.text.lower():
        logger.info("ticket image bucket ready: %s", bucket)
        return
    logger.warning("creating ticket image bucket failed: %s %s", resp.status_code, resp.text[:300])
    raise UploadError("存储服务拒绝了上传，请检查存储桶配置 / storage rejected the upload, check the bucket configuration")


def upload_private_image(data: bytes, folder: str) -> str:
    """把一张图传进私有工单桶，返回对象键（`<folder>/<uuid>.<ext>`，读得出尺寸时带 `#w=&h=`）。

    folder 由调用方给（工单用上传者的用户 id），引用时据此校验「只能用自己传的图」。
    尺寸片段跟着键一起存：签名 URL 每次都是新算的，片段由 signed_image_urls 接回去。

    Upload one image into the private ticket bucket and return its object key
    (`<folder>/<uuid>.<ext>`, plus `#w=&h=` when the size is readable). The caller picks
    the folder (tickets use the uploader's user id) and later checks it so a message can
    only reference its author's own uploads. The size fragment is stored with the key and
    re-attached to each freshly signed URL by signed_image_urls.
    """
    if not is_private_configured():
        raise UploadError("后台未配置图片存储 / Image storage isn't configured")
    if not data:
        raise UploadError("文件为空 / the file is empty")
    if len(data) > settings.UPLOAD_MAX_BYTES:
        mb = settings.UPLOAD_MAX_BYTES / (1024 * 1024)
        raise UploadError(f"图片超过 {mb:.0f}MB 上限 / the image exceeds the {mb:.0f}MB limit")

    ext, content_type = _sniff(data)
    key = f"{folder}/{uuid.uuid4().hex}.{ext}"
    base = settings.SUPABASE_URL.rstrip("/")
    bucket = settings.TICKET_IMAGE_BUCKET

    def _put() -> httpx.Response:
        return httpx.post(
            f"{base}/storage/v1/object/{bucket}/{key}",
            content=data,
            headers={
                **_auth_headers(),
                "Content-Type": content_type,
                "x-upsert": "false",
                # 同公开插图：键是随机 UUID、禁止覆盖，内容不会变 / immutable, same as above
                "Cache-Control": "max-age=31536000, immutable",
            },
            timeout=30.0,
        )

    try:
        resp = _put()
        if resp.status_code >= 400 and _bucket_missing(resp):
            _create_private_bucket(base, bucket)
            resp = _put()
    except httpx.HTTPError as exc:
        logger.warning("supabase storage private upload failed: %s", exc)
        raise UploadError("上传失败，请稍后重试 / upload failed, please retry") from exc

    if resp.status_code >= 400:
        logger.warning("supabase storage rejected private upload: %s %s", resp.status_code, resp.text[:300])
        raise UploadError("存储服务拒绝了上传，请检查存储桶配置 / storage rejected the upload, check the bucket configuration")

    size = _image_size(data, ext)
    if size:
        key += f"#w={size[0]}&h={size[1]}"
    return key


def _split_key(key: str) -> tuple[str, str]:
    """对象键拆成 (路径, '#片段' 或 '') / split a stored key into (path, '#fragment' or '')."""
    path, sep, frag = key.partition("#")
    return path, (sep + frag if sep else "")


def signed_image_urls(keys: list[str]) -> dict[str, str]:
    """把一批对象键换成可直接放进 <img src> 的签名 URL（尺寸片段原样接回），一次请求签完。

    签不出来的键（存储没配、Supabase 超时、对象被删）不出现在结果里：调用方照常返回工单，
    前端把缺的那张显示成「图片暂时无法显示」——看不到图不该连文字回复都看不到。
    超时只给 5 秒，理由同上：这是打开工单详情的同步路径。

    Exchange a batch of stored keys for signed URLs usable in <img src> (size fragment
    re-attached), in one request. Keys that can't be signed (storage unconfigured, Supabase
    timing out, object deleted) are simply absent: the caller still returns the ticket and
    the UI shows that picture as unavailable — a missing image must not hide the text
    replies. The 5 s timeout follows from that: this sits on the ticket-detail path.
    """
    if not keys or not is_private_configured():
        return {}
    ttl = settings.TICKET_IMAGE_URL_TTL_SECONDS
    now = time.monotonic()
    out: dict[str, str] = {}
    pending: list[str] = []
    with _sign_lock:
        for key in dict.fromkeys(keys):
            path, frag = _split_key(key)
            hit = _sign_cache.get(path)
            # 剩余寿命不到一半就重签，保证发出去的链接至少还能用 ttl/2
            # Re-sign below half life, so any URL handed out lasts at least ttl/2
            if hit and hit[1] - now > ttl / 2:
                out[key] = hit[0] + frag
            else:
                pending.append(key)
    if not pending:
        return out

    base = settings.SUPABASE_URL.rstrip("/")
    bucket = settings.TICKET_IMAGE_BUCKET
    paths = list(dict.fromkeys(_split_key(k)[0] for k in pending))
    try:
        resp = httpx.post(
            f"{base}/storage/v1/object/sign/{bucket}",
            json={"expiresIn": ttl, "paths": paths},
            headers=_auth_headers(),
            timeout=5.0,
        )
        items = resp.json() if resp.status_code < 400 else None
    except (httpx.HTTPError, ValueError) as exc:
        logger.warning("signing ticket images failed: %s", exc)
        return out
    if not isinstance(items, list):
        logger.warning("signing ticket images rejected: %s %s", resp.status_code, resp.text[:300])
        return out

    signed: dict[str, str] = {}
    for item in items:
        if not isinstance(item, dict) or item.get("error"):
            continue
        rel = item.get("signedURL") or item.get("signedUrl")
        path = item.get("path")
        if not rel or not path:
            continue
        # storage-api 回的是相对 /storage/v1 的路径（supabase-js 也是这样拼）；万一是绝对地址就原样用
        # storage-api returns a path relative to /storage/v1 (supabase-js joins it the same way);
        # an absolute URL is used as is
        signed[path] = rel if rel.startswith("http") else f"{base}/storage/v1{rel}"

    expires = time.monotonic() + ttl
    with _sign_lock:
        if len(_sign_cache) >= _SIGN_CACHE_MAX:
            for p in [p for p, (_, exp) in _sign_cache.items() if exp - now <= ttl / 2]:
                del _sign_cache[p]
            if len(_sign_cache) >= _SIGN_CACHE_MAX:
                _sign_cache.clear()
        for path, url in signed.items():
            _sign_cache[path] = (url, expires)
    for key in pending:
        path, frag = _split_key(key)
        if path in signed:
            out[key] = signed[path] + frag
    return out
