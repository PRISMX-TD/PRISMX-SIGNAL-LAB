"""分享卡图片中转：给 App 用的「保存 / 分享」通道。

App 外壳是 Capacitor WebView，既不处理网页下载，也没有 Web Share，装好的安装包里也没有
分享 / 存储插件——前端生成的 PNG 在 App 里存不下来。不出新安装包的解法：App 把 PNG 传上来，
拿到一个带签名、24 小时过期的链接，用系统浏览器（Capacitor Browser 插件，Chrome Custom Tab）
打开一张只有这张图和「保存 / 分享」两个按钮的页面。Chrome 会直接下载附件，也支持 Web Share。

图进的是工单那只私有桶（`share/<user id>/...`），不公开；页面与图片走同一个域名，页面里的
navigator.share 才能 fetch 到图。链接本身就是凭证（Custom Tab 里没有 App 的登录态），所以
令牌是 HMAC 签名 + 过期时间，篡改或过期一律 404。

Share-card image relay — the App's save/share path. The App shell (Capacitor WebView) neither
handles downloads nor offers Web Share, and the installed APK has no share/filesystem plugin, so a
PNG generated in the page can't be saved in-app. Without a new APK: the App uploads the PNG, gets a
signed 24-hour link and opens it in the system browser (Capacitor Browser = Chrome Custom Tab) on a
page holding just the image and Save / Share buttons; Chrome downloads attachments and supports Web
Share. Images live in the private ticket bucket under share/<user id>/; page and image share an
origin so navigator.share can fetch the file. The link is the credential (the tab has no App
session), so the token is HMAC-signed with an expiry; tampered or expired tokens are a 404.
"""
import base64
import hashlib
import hmac
import html
import json
import threading
import time
from collections import OrderedDict

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import HTMLResponse, Response

from app.core.config import settings
from app.core.rate_limit import limiter
from app.core.strategy_limits import user_limiter
from app.services.deps import get_current_user_id_light
from app.services.image_upload import (
    UploadError,
    enforce_private_quota,
    is_private_configured,
    read_upload_capped,
    upload_private_image,
)

router = APIRouter(prefix="/share", tags=["share"])

TOKEN_TTL_SECONDS = 24 * 3600


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _sig(payload: str) -> str:
    key = ("share-image:" + settings.JWT_SECRET).encode()
    return _b64(hmac.new(key, payload.encode(), hashlib.sha256).digest()[:18])


def make_token(path: str, now: float | None = None) -> str:
    exp = int((now if now is not None else time.time()) + TOKEN_TTL_SECONDS)
    payload = f"{_b64(path.encode())}.{exp}"
    return f"{payload}.{_sig(payload)}"


def read_token(token: str, now: float | None = None) -> str:
    """校验签名与过期，返回对象路径；任何不对都 404（不区分原因，不给探测）。
    Verify signature and expiry and return the object path; anything wrong is a 404."""
    try:
        p64, exp_s, sig = token.split(".")
        payload = f"{p64}.{exp_s}"
        if not hmac.compare_digest(sig, _sig(payload)):
            raise ValueError
        if int(exp_s) < (now if now is not None else time.time()):
            raise ValueError
        path = _unb64(p64).decode()
        if not path.startswith("share/") or ".." in path:
            raise ValueError
        return path
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(status_code=404, detail="链接已失效 / Link expired")


@router.post("/image")
@user_limiter.limit(settings.RATE_LIMIT_TICKET_UPLOAD)
async def upload_share_image(request: Request, file: UploadFile = File(...),
                             user_id: str = Depends(get_current_user_id_light)):
    """上传一张分享卡 PNG，返回保存页的相对路径（前端拼 API_BASE）。
    Upload one share-card PNG; returns the save page's path (the frontend prefixes API_BASE)."""
    if not is_private_configured():
        raise HTTPException(status_code=503, detail="后台未配置图片存储 / Image storage isn't configured")
    # 先看声明大小、再有界读取：超大请求体永远不会整段读进内存（见 read_upload_capped）
    # Declared-size check then a bounded read: a huge body is never loaded whole
    data = await read_upload_capped(file, request)
    folder = f"share/{user_id}"

    def _store() -> str:
        # 先清掉本人过期的分享图、再看累计配额，然后才传（审计 2026-10-26）
        # Purge this user's expired share images and check the quota before storing
        enforce_private_quota(folder)
        return upload_private_image(data, folder)

    try:
        key = await run_in_threadpool(_store)
    except UploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    path = key.partition("#")[0]
    return {"path": f"/share/i/{make_token(path)}"}


def _fetch_object(path: str) -> bytes:
    base = settings.SUPABASE_URL.rstrip("/")
    resp = httpx.get(f"{base}/storage/v1/object/{settings.TICKET_IMAGE_BUCKET}/{path}",
                     headers={"Authorization": f"Bearer {settings.SUPABASE_SERVICE_KEY}"}, timeout=15.0)
    if resp.status_code >= 400:
        raise HTTPException(status_code=404, detail="图片不存在 / Image not found")
    return resp.content


# 中转缓存（审计 2026-10-26）：这个端点不用登录，以前每次请求都用 service key 从 Supabase
# 整张拉一遍（最多 4MB），一个链接被反复刷就是成倍的存储出口流量；保存页自己也会对同一张图
# 请求两三次（<img>、fetch 给 navigator.share、?dl=1 下载）。现在同一张图在 RELAY_CACHE_TTL
# 内只回源一次，按总字节 LRU 淘汰；再加按 IP 限流。令牌每次照样校验，过期的照样 404。
# 进程内、每个 worker 一份，丢了只是多回源一次。
# Relay cache (audit 2026-10-26): this public endpoint used to download the whole object
# (up to 4MB) from Supabase with the service key on every request, and the save page
# itself requests the image two or three times. Now each image is fetched at most once
# per RELAY_CACHE_TTL, LRU-evicted by total bytes, and the route is rate limited per IP.
# Tokens are still verified on every request. Per worker; losing it costs one refetch.
RELAY_CACHE_MAX_BYTES = 32 * 1024 * 1024
RELAY_CACHE_TTL = 600.0
RELAY_RATE = "30/minute"
_relay_lock = threading.Lock()
_relay_cache: "OrderedDict[str, tuple[float, bytes]]" = OrderedDict()
_relay_bytes = 0


def _relay_cache_clear() -> None:
    global _relay_bytes
    with _relay_lock:
        _relay_cache.clear()
        _relay_bytes = 0


def _relay_cache_bytes() -> int:
    return _relay_bytes


def _cached_object(path: str) -> bytes:
    """有缓存且没过期就用缓存，否则回源一次并放进缓存（单张超过总上限的不缓存）。
    Serve from the cache while fresh, else fetch once and cache (unless larger than the cap)."""
    global _relay_bytes
    now = time.monotonic()
    with _relay_lock:
        hit = _relay_cache.get(path)
        if hit is not None and hit[0] > now:
            _relay_cache.move_to_end(path)
            return hit[1]
    data = _fetch_object(path)
    if len(data) <= RELAY_CACHE_MAX_BYTES:
        with _relay_lock:
            old = _relay_cache.pop(path, None)
            if old is not None:
                _relay_bytes -= len(old[1])
            _relay_cache[path] = (now + RELAY_CACHE_TTL, data)
            _relay_bytes += len(data)
            while _relay_bytes > RELAY_CACHE_MAX_BYTES and _relay_cache:
                _k, (_exp, blob) = _relay_cache.popitem(last=False)
                _relay_bytes -= len(blob)
    return data


@router.get("/i/{token}.png")
@limiter.limit(RELAY_RATE)
async def share_image_png(request: Request, token: str, dl: int = 0):
    """图片本体；?dl=1 时作为附件下发，浏览器直接存到手机。
    The image itself; with ?dl=1 it's sent as an attachment so the browser saves it."""
    path = read_token(token)
    data = await run_in_threadpool(_cached_object, path)
    disp = 'attachment; filename="signal-lab.png"' if dl else 'inline; filename="signal-lab.png"'
    # Content-Encoding: identity —— 让 main 的 GZipMiddleware 原样放过：PNG 已经压缩过，
    # 再 deflate 一遍 4MB 只是白花 CPU。/ lets the app's GZip pass the already-compressed PNG through.
    return Response(content=data, media_type="image/png",
                    headers={"Content-Disposition": disp, "Cache-Control": "private, max-age=3600",
                             "X-Content-Type-Options": "nosniff", "Content-Encoding": "identity"})


_TEXT = {
    "zh": ("保存图片", "分享", "图片已开始下载，可在相册或「下载」里找到", "链接 24 小时内有效"),
    "en": ("Save image", "Share", "Downloading. Find it in your gallery or Downloads.", "This link works for 24 hours"),
    "ja": ("画像を保存", "シェア", "ダウンロードを開始しました。ギャラリーまたは「ダウンロード」で確認できます", "リンクは24時間有効です"),
    "th": ("บันทึกรูปภาพ", "แชร์", "กำลังดาวน์โหลด ดูได้ในแกลเลอรีหรือโฟลเดอร์ดาวน์โหลด", "ลิงก์ใช้ได้ 24 ชั่วโมง"),
    "vi": ("Lưu ảnh", "Chia sẻ", "Đang tải xuống. Xem trong thư viện ảnh hoặc mục Tải xuống.", "Liên kết có hiệu lực trong 24 giờ"),
}


@router.get("/i/{token}", response_class=HTMLResponse)
async def share_image_page(token: str, lang: str = "zh"):
    """保存 / 分享页：在系统浏览器里打开。只放图和两个按钮，脚本内联、不引外部资源。
    Save / share page opened in the system browser: the image and two buttons, inline script only."""
    read_token(token)
    save, share, saved, note = _TEXT.get(lang, _TEXT["en"])
    t = html.escape(token)
    page = f"""<!doctype html><html lang="{html.escape(lang)}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex"><title>Signal Lab</title>
<style>
*{{box-sizing:border-box}}html,body{{margin:0;background:#0b0b0f;color:#ededf0;font-family:-apple-system,'PingFang SC','Noto Sans SC','Microsoft YaHei',sans-serif}}
main{{min-height:100vh;display:flex;flex-direction:column;align-items:center;gap:18px;padding:24px 18px 32px}}
img{{width:100%;max-width:420px;border-radius:22px;display:block}}
.row{{display:grid;grid-template-columns:1fr 1fr;gap:12px;width:100%;max-width:420px}}
.row.one{{grid-template-columns:1fr}}
a,button{{height:50px;border-radius:999px;font:600 16px inherit;font-family:inherit;display:flex;align-items:center;justify-content:center;text-decoration:none;cursor:pointer}}
.p{{background:#5a22ee;color:#fff;border:0}}.s{{background:rgba(255,255,255,.05);color:#ededf0;border:1px solid rgba(255,255,255,.18)}}
p{{margin:0;font-size:13px;color:#9c9ca6;text-align:center}}
</style></head><body><main>
<img src="{t}.png" alt="Signal Lab">
<div class="row" id="row">
<a class="p" id="save" href="{t}.png?dl=1" download="signal-lab.png">{html.escape(save)}</a>
<button class="s" id="share" type="button">{html.escape(share)}</button>
</div>
<p id="msg">{html.escape(note)}</p>
</main><script>
(function(){{
  var sh=document.getElementById('share'),row=document.getElementById('row'),msg=document.getElementById('msg');
  var file=null;
  fetch('{t}.png').then(function(r){{return r.blob()}}).then(function(b){{file=new File([b],'signal-lab.png',{{type:'image/png'}})}});
  var ok=navigator.canShare&&navigator.canShare({{files:[new File([''],'x.png',{{type:'image/png'}})]}});
  if(!ok){{sh.remove();row.className='row one'}}
  sh.onclick=function(){{if(file)navigator.share({{files:[file]}}).catch(function(){{}})}};
  document.getElementById('save').addEventListener('click',function(){{msg.textContent={json.dumps(saved, ensure_ascii=False)}}});
}})();
</script></body></html>"""
    return HTMLResponse(page, headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex",
                                       "Referrer-Policy": "no-referrer"})
