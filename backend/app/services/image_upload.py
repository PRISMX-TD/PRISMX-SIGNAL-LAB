"""图片上传到 Supabase Storage（仅管理员，经后端代理）。

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

    return f"{base}/storage/v1/object/public/{bucket}/{key}"
