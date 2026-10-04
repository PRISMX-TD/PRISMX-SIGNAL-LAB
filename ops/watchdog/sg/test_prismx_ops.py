"""运维接口的单元测试。/ Unit tests for the ops endpoint.

运行 / run:  cd ops/watchdog/sg && python -m unittest test_prismx_ops
"""

import base64
import hashlib
import hmac
import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import prismx_ops as ops  # noqa: E402
import prismx_watchdog as wd  # noqa: E402

SECRET = "jwt-test-secret"


def make_jwt(payload, secret=SECRET, alg="HS256"):
    def b64(d):
        return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()

    h, p = b64({"alg": alg, "typ": "JWT"}), b64(payload)
    sig = hmac.new(secret.encode(), f"{h}.{p}".encode(), hashlib.sha256).digest()
    return f"{h}.{p}." + base64.urlsafe_b64encode(sig).rstrip(b"=").decode()


class FakeWatchdog:
    def __init__(self, per_hour=3):
        self.budget = wd.RestartBudget(per_hour)
        self.restarted = []
        self.lines = []

    def log_line(self, msg):
        self.lines.append(msg)

    def try_manual_restart_slot(self):
        return self.budget.try_take(time.monotonic())

    def manual_restart_backend(self, operator):
        self.restarted.append(operator)


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = ops.OperatorStore(os.path.join(self.tmp.name, "ops.json"))
        self.pw = self.store.add("alice")
        self.cfg = dict(wd.DEFAULTS, JWT_SECRET=SECRET, OPS_SHARED_SECRET="shh", OPS_LOCK_FAILS="3")
        self.watchdog = FakeWatchdog()
        self.history = ops.History(os.path.join(self.tmp.name, "h.jsonl"))
        self.ctx = ops.OpsContext(self.cfg, self.watchdog, self.store, self.history)
        self.vps_calls = []
        self.vps_reply = (202, {"ok": True, "result": "ok", "message": "已开始重启 gateway"})
        self._orig_call_vps = ops.call_vps
        ops.call_vps = self._fake_vps

    def tearDown(self):
        ops.call_vps = self._orig_call_vps
        self.tmp.cleanup()

    def _fake_vps(self, cfg, method, path, payload=None, timeout=8.0):
        self.vps_calls.append((method, path, payload))
        if path == "/ops/status":
            return 200, {"restartsUsed": 0, "restartsMax": 3, "cooldownSec": 0}
        return self.vps_reply

    def call(self, path, body=None, token=None, method="POST", ip="1.2.3.4"):
        token = make_jwt({"sub": "u1", "exp": time.time() + 600}) if token is None else token
        headers = {"Authorization": "Bearer " + token} if token else {}
        raw = json.dumps(body or {}).encode()
        try:
            return ops.handle(self.ctx, method, path, headers, raw, ip)
        except ops.OpsError as e:
            return e.status, {"error": e.code, "message": e.message}


class OperatorStoreTest(Base):
    def test_add_verify_remove(self):
        self.assertEqual(self.store.verify(self.pw), "alice")
        self.assertIsNone(self.store.verify("nope"))
        bob = self.store.add("bob", "bob-secret")
        self.assertEqual(self.store.verify(bob), "bob")
        self.assertEqual(sorted(self.store.names()), ["alice", "bob"])
        # 重置口令：旧的失效
        new = self.store.add("alice")
        self.assertIsNone(self.store.verify(self.pw))
        self.assertEqual(self.store.verify(new), "alice")
        self.assertTrue(self.store.remove("bob"))
        self.assertFalse(self.store.remove("bob"))
        self.assertIsNone(self.store.verify("bob-secret"))

    def test_file_has_no_plaintext_and_is_private(self):
        with open(self.store.path, encoding="utf-8") as f:
            text = f.read()
        self.assertNotIn(self.pw, text)
        if os.name == "posix":
            self.assertEqual(os.stat(self.store.path).st_mode & 0o777, 0o600)


class JwtTest(unittest.TestCase):
    def test_valid_expired_wrong_secret_and_alg(self):
        now = time.time()
        self.assertEqual(ops.verify_jwt(make_jwt({"sub": "u", "exp": now + 60}), SECRET)["sub"], "u")
        self.assertIsNone(ops.verify_jwt(make_jwt({"sub": "u", "exp": now - 1}), SECRET))
        self.assertIsNone(ops.verify_jwt(make_jwt({"sub": "u", "exp": now + 60}, secret="other"), SECRET))
        self.assertIsNone(ops.verify_jwt(make_jwt({"sub": "u", "exp": now + 60}, alg="none"), SECRET))
        self.assertIsNone(ops.verify_jwt("garbage", SECRET))
        self.assertIsNone(ops.verify_jwt(make_jwt({"sub": "u", "exp": now + 60}), ""))


class SignatureTest(unittest.TestCase):
    def test_known_vector(self):
        # 固定向量：VPS 的 PowerShell 实现必须算出同一个值（见 vps/watchdog.ps1 的 Test-OpsSignature）。
        h = ops.sign_request("shh", "post", "/ops/restart-gateway", '{"operator":"alice"}', ts=1700000000, nonce="abc")
        expected = hmac.new(b"shh", b'POST\n/ops/restart-gateway\n1700000000\nabc\n{"operator":"alice"}',
                            hashlib.sha256).hexdigest()
        self.assertEqual(h, {"X-Ops-Ts": "1700000000", "X-Ops-Nonce": "abc", "X-Ops-Sig": expected})


class HandleTest(Base):
    def test_requires_login_token(self):
        self.assertEqual(self.call("/ops/status", method="GET", token="")[0], 401)
        bad = make_jwt({"sub": "u", "exp": time.time() + 60}, secret="x")
        self.assertEqual(self.call("/ops/restart-backend", {"password": self.pw}, token=bad)[0], 401)
        self.assertEqual(self.watchdog.restarted, [])

    def test_status(self):
        status, body = self.call("/ops/status", method="GET")
        self.assertEqual(status, 200)
        self.assertEqual(body["backend"], {"restartsUsed": 0, "restartsMax": 3, "cooldownSec": 0})
        self.assertEqual(body["gateway"]["restartsMax"], 3)
        self.assertEqual(body["operators"], 1)

    def test_wrong_password_locks_out_that_ip(self):
        for _ in range(3):
            self.assertEqual(self.call("/ops/restart-backend", {"password": "x"})[0], 403)
        # 锁住之后连对的口令也不行
        self.assertEqual(self.call("/ops/restart-backend", {"password": self.pw})[0], 423)
        # 别的 IP 不受影响
        self.assertEqual(self.call("/ops/restart-backend", {"password": self.pw}, ip="5.6.7.8")[0], 202)

    def test_restart_backend_cooldown_and_history(self):
        status, body = self.call("/ops/restart-backend", {"password": self.pw})
        self.assertEqual(status, 202)
        for _ in range(50):
            if self.watchdog.restarted:
                break
            time.sleep(0.01)
        self.assertEqual(self.watchdog.restarted, ["alice"])
        status, body = self.call("/ops/restart-backend", {"password": self.pw})
        self.assertEqual((status, body["error"]), (429, "cooldown"))
        self.assertEqual(self.history.recent()[0]["action"], "restart-backend")
        self.assertEqual(self.history.recent()[0]["operator"], "alice")

    def test_restart_backend_respects_shared_budget(self):
        for _ in range(3):
            self.watchdog.budget.record(time.monotonic())   # 看门狗这小时已自动重启 3 次
        status, body = self.call("/ops/restart-backend", {"password": self.pw})
        self.assertEqual((status, body["error"]), (429, "budget"))
        self.assertEqual(self.watchdog.restarted, [])

    def test_restart_gateway_forwards_operator(self):
        status, body = self.call("/ops/restart-gateway", {"password": self.pw})
        self.assertEqual(status, 202)
        self.assertEqual(self.vps_calls[-1], ("POST", "/ops/restart-gateway", {"operator": "alice"}))

    def test_restart_gateway_relays_refusal_and_unreachable(self):
        self.vps_reply = (429, {"ok": False, "error": "cooldown", "message": "冷却中"})
        self.assertEqual(self.call("/ops/restart-gateway", {"password": self.pw})[0], 429)
        self.vps_reply = (0, {"error": "unreachable"})
        status, body = self.call("/ops/restart-gateway", {"password": self.pw})
        self.assertEqual((status, body["error"]), (502, "vps_unreachable"))

    def test_unknown_path_and_method(self):
        self.assertEqual(self.call("/ops/nope")[0], 404)
        self.assertEqual(self.call("/ops/restart-backend", method="GET")[0], 405)


class HistoryTest(unittest.TestCase):
    def test_survives_reload(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "h.jsonl")
            ops.History(path).add("restart-backend", "alice", "ok")
            self.assertEqual(ops.History(path).recent()[0]["operator"], "alice")


class HttpServerTest(Base):
    def test_cors_preflight_and_json_errors(self):
        srv = ops.make_server(self.ctx, "127.0.0.1", 0)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{port}/ops/status", method="OPTIONS",
                                         headers={"Origin": "https://www.prismxsignallab.com"})
            with urllib.request.urlopen(req, timeout=5) as r:
                self.assertEqual(r.status, 204)
                self.assertEqual(r.headers["Access-Control-Allow-Origin"], "https://www.prismxsignallab.com")
            req = urllib.request.Request(f"http://127.0.0.1:{port}/ops/status",
                                         headers={"Origin": "https://evil.example"})
            with self.assertRaises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(req, timeout=5)
            self.assertEqual(e.exception.code, 401)
            self.assertIsNone(e.exception.headers["Access-Control-Allow-Origin"])
            self.assertEqual(json.loads(e.exception.read())["error"], "login_required")
            e.exception.close()
        finally:
            srv.shutdown()
            srv.server_close()


if __name__ == "__main__":
    unittest.main()
