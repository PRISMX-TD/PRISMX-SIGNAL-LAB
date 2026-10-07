"""
看门狗的「运维接口」：让管理后台系统状态页上的「重启后端」「重启 gateway」两个按钮
在**后端挂了的时候也能按**——请求不经过后端，nginx 把 /ops/ 直接转给看门狗。

  浏览器 ──https──> nginx /ops/ ──> 本文件（SG 看门狗，只听 127.0.0.1）
                                        ├─ 重启后端：systemctl restart prismx
                                        └─ 重启 gateway：签名后经 WireGuard 隧道转给 VPS 看门狗

两道门：
  1. 管理员登录 token：浏览器带着平时登录拿到的 JWT，这里用后端同一把 JWT_SECRET 验签名和
     过期时间，再确认它属于**管理员**且会话版本（tv）没作废——JWT 里没有角色，所以拿这个
     token 去问后端一个只有管理员能看的接口（OPS_ADMIN_CHECK_URL）。问过的结果按
     「用户 id + tv」记在本地（OPS_ADMIN_CACHE_FILE）：后端挂了的时候，最近
     OPS_ADMIN_CACHE_SEC 秒内在这里确认过的管理员、拿同一 tv 的 token 仍能按按钮。
     普通用户的 token 一律挡在这里，连 /ops/status 也看不到。
  2. 运维口令：每个人一个，只能在服务器上用命令生成（--add-operator），这里只存加盐的
     PBKDF2 哈希。口令认出是谁按的；有人离职删掉他那条即可。输错 OPS_LOCK_FAILS 次锁
     OPS_LOCK_SEC 秒，按「登录账号」和「来源 IP」各记一份；只有过了第 1 道门的人输错才计数，
     普通用户没法靠乱输口令把管理员锁在外面（旧实现有一道全局总闸：任何登录用户乱输
     20 次就能把所有人锁 15 分钟）。

再加两道闸：同一个按钮 OPS_COOLDOWN 秒内只能按一次；重启后端与看门狗自动重启共用
「每小时 N 次」的额度，用完就拒绝。每次操作都记进历史（ops-history.jsonl）并发通知。

SG ↔ VPS 两个看门狗之间：请求体 + 时间戳 + 随机数用共享密钥 OPS_SHARED_SECRET 做
HMAC-SHA256 签名，VPS 只认 60 秒内、没见过的随机数，防冒充、防重放。

The watchdog's ops endpoint: the two restart buttons work even when the backend
is down. Two gates (an admin's login JWT -- signature checked locally with the
backend's secret, admin role + session version confirmed with the backend and
cached per user for when the backend is down -- plus a per-person ops password
stored as a salted PBKDF2 hash), per-account / per-IP lockout counted only for
admins, a per-button cooldown and the shared hourly restart budget.
SG -> VPS calls are HMAC-signed with a shared secret, timestamp and nonce.

只用标准库。/ Standard library only.
"""

import base64
import collections
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PBKDF2_ITERATIONS = 200_000
MAX_BODY = 4096
HISTORY_KEEP = 200
HISTORY_SHOW = 20
SIG_MAX_SKEW = 60

DEFAULT_CORS = ",".join([
    "https://prismxsignallab.com",
    "https://www.prismxsignallab.com",
    "https://pmxsl.com",
    "https://www.pmxsl.com",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
])


# ---------------------------------------------------------------- 运维口令 / operators


def _hash_password(password, salt, iterations=PBKDF2_ITERATIONS):
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations).hex()


class OperatorStore:
    """运维口令表（JSON 文件，权限 600）。只存哈希，不存明文。"""

    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
            return data.get("operators", []) if isinstance(data, dict) else []
        except (OSError, ValueError):
            return []

    def _save(self, ops):
        tmp = self.path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump({"operators": ops}, f, ensure_ascii=False, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    def names(self):
        return [o.get("name") for o in self._load()]

    def add(self, name, password=None):
        """新增或重置一个人的口令；不给口令就随机生成。返回明文口令（只此一次）。"""
        name = name.strip()
        if not name:
            raise ValueError("名字不能为空")
        password = password or secrets.token_urlsafe(12)
        salt = secrets.token_bytes(16)
        with self._lock:
            ops = [o for o in self._load() if o.get("name") != name]
            ops.append({"name": name, "salt": salt.hex(), "iter": PBKDF2_ITERATIONS,
                        "hash": _hash_password(password, salt), "created": int(time.time())})
            self._save(ops)
        return password

    def remove(self, name):
        with self._lock:
            ops = self._load()
            kept = [o for o in ops if o.get("name") != name]
            self._save(kept)
            return len(kept) != len(ops)

    def verify(self, password):
        """口令对上了返回那个人的名字，否则 None。每条都算一遍，耗时与谁匹配无关。"""
        found = None
        for o in self._load():
            try:
                digest = _hash_password(password, bytes.fromhex(o["salt"]), int(o.get("iter", PBKDF2_ITERATIONS)))
            except (KeyError, ValueError):
                continue
            if hmac.compare_digest(digest, o.get("hash", "")) and found is None:
                found = o.get("name")
        return found


# ---------------------------------------------------------------- JWT（只验签名与过期）


def _b64url_decode(s):
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def verify_jwt(token, secret, now=None):
    """HS256 JWT：签名对、没过期就返回 payload，否则 None。与后端 core/security.py 同一套参数。"""
    if not token or not secret:
        return None
    try:
        h64, p64, s64 = token.split(".")
        header = json.loads(_b64url_decode(h64))
        if header.get("alg") != "HS256":
            return None
        expected = hmac.new(secret.encode("utf-8"), f"{h64}.{p64}".encode("ascii"), hashlib.sha256).digest()
        if not hmac.compare_digest(expected, _b64url_decode(s64)):
            return None
        payload = json.loads(_b64url_decode(p64))
        exp = payload.get("exp")
        if exp is None or float(exp) < (now or time.time()):
            return None
        return payload
    except (ValueError, TypeError, json.JSONDecodeError):
        return None


# ---------------------------------------------------------------- SG ↔ VPS 签名


def sign_request(secret, method, path, body, ts=None, nonce=None):
    """返回要带上的三个头。签名内容：方法、路径、时间戳、随机数、请求体。"""
    ts = str(int(ts if ts is not None else time.time()))
    nonce = nonce or secrets.token_hex(12)
    msg = "\n".join([method.upper(), path, ts, nonce, body]).encode("utf-8")
    sig = hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()
    return {"X-Ops-Ts": ts, "X-Ops-Nonce": nonce, "X-Ops-Sig": sig}


def call_vps(cfg, method, path, payload=None, timeout=8.0):
    """签名后请求 VPS 看门狗。返回 (HTTP 状态码, JSON)；连不上返回 (0, {"error": ...})。"""
    base = cfg.get("VPS_OPS_URL", "").rstrip("/")
    secret = cfg.get("OPS_SHARED_SECRET", "")
    if not base or not secret:
        return 0, {"error": "not_configured", "message": "没有配置 VPS_OPS_URL / OPS_SHARED_SECRET"}
    body = json.dumps(payload or {}, ensure_ascii=False) if method == "POST" else ""
    headers = sign_request(secret, method, path, body)
    headers["Content-Type"] = "application/json"
    req = urllib.request.Request(base + path, data=body.encode("utf-8") if method == "POST" else None,
                                 method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read(64 * 1024) or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read(64 * 1024) or b"{}")
        except ValueError:
            return e.code, {"error": "http_%d" % e.code}
    except Exception as e:  # 连不上、超时
        return 0, {"error": "unreachable", "message": "%s: %s" % (type(e).__name__, str(e)[:200])}


# ---------------------------------------------------------------- 锁定 / 冷却 / 历史


class Lockout:
    """按 key 记失败次数（调用方传「账号」「来源 IP」两个 key），窗口内任一 key 到上限就锁。

    没有全局总闸：只有过了管理员校验的请求才会走到这里，换 IP 猜口令会被按账号的计数挡住；
    全局总闸则让任何一个人（旧实现里甚至是任何注册用户）能把所有管理员一起锁在外面。
    Failure counts per key (the caller passes the account and the source IP); locked
    when any key hits the limit. No global breaker: only admin-verified requests get
    here, and a global one let a single caller lock every admin out.
    """

    def __init__(self, fails, window):
        self.fails, self.window = fails, window
        self._lock = threading.Lock()
        self._hits = collections.defaultdict(list)

    def _trim(self, now):
        cutoff = now - self.window
        for k in list(self._hits):
            self._hits[k] = [t for t in self._hits[k] if t > cutoff]
            if not self._hits[k]:
                del self._hits[k]

    def locked(self, *keys, now=None):
        now = now or time.time()
        with self._lock:
            self._trim(now)
            return any(len(self._hits.get(k, [])) >= self.fails for k in keys)

    def fail(self, *keys, now=None):
        now = now or time.time()
        with self._lock:
            for k in keys:
                self._hits[k].append(now)

    def clear(self, *keys):
        with self._lock:
            for k in keys:
                self._hits.pop(k, None)


class Cooldown:
    def __init__(self, seconds):
        self.seconds = seconds
        self._lock = threading.Lock()
        self._last = {}

    def remaining(self, action, now=None):
        now = now or time.time()
        with self._lock:
            last = self._last.get(action)
            return 0 if last is None else max(0, int(self.seconds - (now - last)))

    def take(self, action, now=None):
        """冷却中返回剩余秒数（>0，不占用）；否则记下这次并返回 0。"""
        now = now or time.time()
        with self._lock:
            last = self._last.get(action)
            if last is not None and now - last < self.seconds:
                return int(self.seconds - (now - last))
            self._last[action] = now
            return 0


class History:
    """操作记录：内存里留最近的，同时追加到 jsonl 文件，看门狗重启后还能看到。"""

    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self._items = collections.deque(maxlen=HISTORY_KEEP)
        try:
            with open(path, encoding="utf-8") as f:
                for line in f.readlines()[-HISTORY_KEEP:]:
                    try:
                        self._items.append(json.loads(line))
                    except ValueError:
                        pass
        except OSError:
            pass

    def add(self, action, operator, result, source="manual"):
        item = {"at": time.time(), "action": action, "operator": operator, "result": result, "source": source}
        with self._lock:
            self._items.append(item)
            try:
                os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(item, ensure_ascii=False) + "\n")
                self._compact()
            except OSError:
                pass
        return item

    def _compact(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                lines = f.readlines()
            if len(lines) > HISTORY_KEEP * 2:
                with open(self.path, "w", encoding="utf-8") as f:
                    f.writelines(lines[-HISTORY_KEEP:])
        except OSError:
            pass

    def recent(self, n=HISTORY_SHOW):
        with self._lock:
            return list(self._items)[-n:][::-1]


# ---------------------------------------------------------------- HTTP 接口


class OpsContext:
    """接口要用到的一切：配置、看门狗本体（重启后端、额度）、口令表、锁定、冷却、历史。"""

    def __init__(self, cfg, watchdog, operators, history):
        self.cfg = cfg
        self.watchdog = watchdog
        self.operators = operators
        self.history = history
        self.lockout = Lockout(int(cfg.get("OPS_LOCK_FAILS", 5)), int(cfg.get("OPS_LOCK_SEC", 900)))
        self.admins = AdminVerifier(cfg)
        self.cooldown = Cooldown(int(cfg.get("OPS_COOLDOWN", 300)))
        self.cors = {o.strip() for o in str(cfg.get("OPS_CORS_ORIGINS") or DEFAULT_CORS).split(",") if o.strip()}


class OpsError(Exception):
    def __init__(self, status, code, message, **extra):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


# ---------------------------------------------------------------- 管理员校验 / admin check


def check_admin_remote(url, token, timeout=4.0):
    """拿浏览器的 token 去问后端一个 require_admin 的接口，返回 HTTP 状态码；连不上返回 0。
    后端那边会把签名、会话版本（tv）、是否停用、是否管理员全部验一遍。
    Ask an admin-only backend endpoint with the browser's token; returns the HTTP
    status, or 0 when the backend can't be reached."""
    req = urllib.request.Request(url, method="GET", headers={
        "Authorization": "Bearer " + token, "User-Agent": "prismx-watchdog"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp.read(1024)
            return resp.status
    except urllib.error.HTTPError as e:
        e.close()
        return e.code
    except Exception:  # 连不上、超时
        return 0


class AdminVerifier:
    """第 1 道门的后半段：token 必须属于管理员、且会话版本没作废。

    后端在线：以后端的回答为准（200 = 是管理员；401 = 会话已作废；403 = 不是管理员 / 已停用），
    确认过的「用户 id → tv、确认时间」写进本地文件。
    后端不在线（连不上 / 5xx / 其它）：这个账号最近 cache_sec 秒内在这里确认过、且 token 的 tv
    与当时一致，才放行——这正是「后端挂了也能按重启」要的；从没确认过的账号一律拒绝。
    同一 (用户, tv) 的结论在内存里记 recheck_sec 秒，状态页轮询不必每次都去问后端。

    Backend up: its answer wins and confirmed admins are cached (user id -> tv,
    time) on disk. Backend down: only an account confirmed here within cache_sec
    whose token carries the same tv gets through. Results are memoised per
    (user, tv) for recheck_sec so status polling doesn't hit the backend each time.
    """

    def __init__(self, cfg):
        base = str(cfg.get("BACKEND_URL") or "http://127.0.0.1:8000/").rstrip("/")
        self.url = cfg.get("OPS_ADMIN_CHECK_URL") or base + "/api/admin/trial"
        self.path = cfg.get("OPS_ADMIN_CACHE_FILE") or ""
        self.cache_sec = int(cfg.get("OPS_ADMIN_CACHE_SEC") or 7 * 86400)
        self.recheck_sec = int(cfg.get("OPS_ADMIN_RECHECK_SEC") or 60)
        self.timeout = float(cfg.get("HTTP_TIMEOUT") or 5)
        self._lock = threading.Lock()
        self._recent = {}          # (sub, tv) -> (是否管理员, 时间) / memo
        self._admins = self._load()

    def _load(self):
        if not self.path:
            return {}
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else {}
        except (OSError, ValueError):
            return {}

    def _save(self):
        if not self.path:
            return
        try:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._admins, f)
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def check(self, token, payload, now=None):
        """放行返回 None，否则返回一个 OpsError（由调用方 raise）。"""
        now = now or time.time()
        sub = str(payload.get("sub") or "")
        tv = payload.get("tv") if isinstance(payload.get("tv"), int) else 0
        if not sub:
            return OpsError(401, "login_required", "登录已失效，请重新登录管理后台")
        with self._lock:
            hit = self._recent.get((sub, tv))
        if hit and now - hit[1] < self.recheck_sec:
            return None if hit[0] else OpsError(403, "admin_required", "只有管理员能用运维接口")

        status = check_admin_remote(self.url, token, self.timeout)
        with self._lock:
            known = self._admins.get(sub)
            if status == 200:
                self._admins[sub] = {"tv": tv, "at": now}
                self._recent[(sub, tv)] = (True, now)
                self._save()
                return None
            if status in (401, 403):
                # 403 = 不是管理员 / 已停用：这个账号的离线资格一并作废。
                # 401 只在 tv 与记录一致时才作废（会话被撤销）；拿一张旧 token 来的人
                # 不该能把管理员的离线资格顶掉。
                if known and (status == 403 or known.get("tv") == tv):
                    self._admins.pop(sub, None)
                    self._save()
                if status == 401:
                    return OpsError(401, "login_required", "登录已失效，请重新登录管理后台")
                self._recent[(sub, tv)] = (False, now)
                return OpsError(403, "admin_required", "只有管理员能用运维接口")
            # 后端不在线 / 回了别的：用本地确认记录兜底 / offline fallback
            if known and known.get("tv") == tv and now - float(known.get("at", 0)) <= self.cache_sec:
                return None
        return OpsError(503, "admin_unverified",
                        "后端暂时无法确认管理员身份（%s），且这个账号最近没有在这里确认过，联系 Rex"
                        % ("HTTP %d" % status if status else "连不上后端"))


def handle(ctx, method, path, headers, body_bytes, client_ip):
    """纯函数式的路由：返回 (状态码, dict)。HTTP 外壳只负责收发。便于单测。"""
    if path not in ("/ops/status", "/ops/restart-backend", "/ops/restart-gateway"):
        raise OpsError(404, "not_found", "未知接口")

    auth = headers.get("Authorization", "")
    token = auth[7:] if auth.startswith("Bearer ") else ""
    payload = verify_jwt(token, ctx.cfg.get("JWT_SECRET", ""))
    if payload is None:
        raise OpsError(401, "login_required", "登录已失效，请重新登录管理后台")
    # 只验签名 = 任何注册用户都过得了第 1 道门；还得是管理员、会话没作废（含 /ops/status）。
    # A valid signature alone admits any registered user: require admin + live session.
    denied = ctx.admins.check(token, payload)
    if denied is not None:
        raise denied

    if path == "/ops/status":
        if method != "GET":
            raise OpsError(405, "method_not_allowed", "只接受 GET")
        return 200, status_payload(ctx)

    if method != "POST":
        raise OpsError(405, "method_not_allowed", "只接受 POST")
    try:
        body = json.loads(body_bytes or b"{}")
    except ValueError:
        raise OpsError(400, "bad_json", "请求格式不对")
    password = str(body.get("password") or "")

    # 按账号 + 来源 IP 各记一份；能走到这里的都已确认是管理员。/ per account + per IP
    keys = ("user:" + str(payload.get("sub")), "ip:" + str(client_ip))
    if ctx.lockout.locked(*keys):
        raise OpsError(423, "locked", "口令输错太多次，已锁定 %d 分钟" % (ctx.lockout.window // 60))
    operator = ctx.operators.verify(password) if password else None
    if operator is None:
        ctx.lockout.fail(*keys)
        raise OpsError(403, "bad_password", "运维口令不对")
    ctx.lockout.clear(*keys)

    if path == "/ops/restart-backend":
        return restart_backend(ctx, operator)
    return restart_gateway(ctx, operator)


def _ago(mono, now):
    return None if mono is None else max(0, int(now - mono))


def status_payload(ctx):
    wd = ctx.watchdog
    now = time.monotonic()
    vps_status, vps = call_vps(ctx.cfg, "GET", "/ops/status", timeout=4.0)
    gateway = vps if vps_status == 200 else {"error": vps.get("error") or "http_%d" % vps_status,
                                              "message": vps.get("message")}
    return {
        "backend": {
            "restartsUsed": wd.budget.used(now),
            "restartsMax": wd.budget.per_hour,
            "cooldownSec": ctx.cooldown.remaining("restart-backend"),
            # 主循环上一轮距今几秒；超过两三轮没动就是卡住了（接口线程还活着也一样）。
            "lastTickAgoSec": _ago(getattr(wd, "last_tick_at", None), now),
        },
        "gateway": gateway,
        "operators": len(ctx.operators.names()),
        "history": ctx.history.recent(),
    }


def restart_backend(ctx, operator):
    left = ctx.cooldown.take("restart-backend")
    if left:
        raise OpsError(429, "cooldown", "5 分钟内已经有人重启过后端，%d 秒后才能再按" % left, retryAfter=left)
    if not ctx.watchdog.try_manual_restart_slot():
        ctx.history.add("restart-backend", operator, "refused: budget")
        raise OpsError(429, "budget", "1 小时内已经重启过 %d 次，不要再重启了，联系 Rex" % ctx.watchdog.budget.per_hour)
    ctx.history.add("restart-backend", operator, "started")
    # 先回话再重启：重启要十几秒，nginx 与浏览器不该干等。
    threading.Thread(target=ctx.watchdog.manual_restart_backend, args=(operator,), daemon=True).start()
    return 202, {"ok": True, "message": "已开始重启后端，大约 10~20 秒后恢复"}


def restart_gateway(ctx, operator):
    status, rsp = call_vps(ctx.cfg, "POST", "/ops/restart-gateway", {"operator": operator}, timeout=15.0)
    if status == 0:
        ctx.history.add("restart-gateway", operator, "failed: vps unreachable")
        raise OpsError(502, "vps_unreachable", "连不上 VPS 上的看门狗（隧道断了或看门狗没在跑），联系 Rex")
    result = rsp.get("result") or ("ok" if status < 300 else rsp.get("error") or "http_%d" % status)
    ctx.history.add("restart-gateway", operator, result)
    if status >= 300:
        raise OpsError(status, rsp.get("error") or "refused", rsp.get("message") or "VPS 看门狗拒绝了这次重启")
    return 202, {"ok": True, "message": rsp.get("message") or "已开始重启 gateway"}


def make_server(ctx, host, port):
    class Handler(BaseHTTPRequestHandler):
        server_version = "prismx-ops"

        def log_message(self, fmt, *args):  # 走看门狗自己的日志，不打 stderr 访问日志
            pass

        def _client_ip(self):
            # 只有从本机 nginx 进来时才信 X-Real-IP。
            if self.client_address[0] in ("127.0.0.1", "::1"):
                return self.headers.get("X-Real-IP") or self.client_address[0]
            return self.client_address[0]

        def _cors(self):
            origin = self.headers.get("Origin", "")
            if origin in ctx.cors:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
                self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
                self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                self.send_header("Access-Control-Max-Age", "600")

        def _send(self, status, payload):
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _dispatch(self, method):
            path = self.path.split("?", 1)[0].rstrip("/")
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self._send(413, {"ok": False, "error": "too_large", "message": "请求太大"})
            body = self.rfile.read(length) if length else b""
            ip = self._client_ip()
            try:
                status, payload = handle(ctx, method, path, self.headers, body, ip)
            except OpsError as e:
                if e.status not in (401, 404):
                    ctx.watchdog.log_line("运维接口拒绝 %s %s（%s，来自 %s）：%s" % (method, path, e.code, ip, e.message))
                return self._send(e.status, {"ok": False, "error": e.code, "message": e.message, **e.extra})
            except Exception as e:  # 接口本身出错也要回 JSON，不能让 nginx 回 502 糊弄过去
                ctx.watchdog.log_line("运维接口出错 %s %s：%s: %s" % (method, path, type(e).__name__, e))
                return self._send(500, {"ok": False, "error": "internal", "message": "看门狗内部错误"})
            if method == "POST":
                ctx.watchdog.log_line("运维接口 %s %s（来自 %s）：%s" % (method, path, ip, payload.get("message")))
            return self._send(status, payload)

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    return srv


def start(ctx, listen):
    host, _, port = listen.rpartition(":")
    srv = make_server(ctx, host or "127.0.0.1", int(port))
    threading.Thread(target=srv.serve_forever, name="ops-http", daemon=True).start()
    return srv
