"""看门狗纯逻辑的单元测试。/ Unit tests for the watchdog's pure logic.

运行 / run:  python -m unittest ops/watchdog/sg/test_prismx_watchdog.py
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import prismx_watchdog as wd  # noqa: E402


class RestartBudgetTest(unittest.TestCase):
    def test_caps_per_rolling_hour(self):
        b = wd.RestartBudget(3)
        for t in (0, 10, 20):
            self.assertTrue(b.allow(t))
            b.record(t)
        self.assertFalse(b.allow(30))
        # 第一次重启满一小时后让出一个名额
        self.assertTrue(b.allow(3600))


class DownTrackerTest(unittest.TestCase):
    def test_alerts_once_after_threshold_and_on_recovery(self):
        t = wd.DownTracker(60)
        self.assertIsNone(t.update(False, 0))
        self.assertIsNone(t.update(False, 59))
        self.assertEqual(t.update(False, 60), "down")
        self.assertIsNone(t.update(False, 120))
        self.assertEqual(t.update(True, 130), "recovered")
        self.assertIsNone(t.update(True, 140))

    def test_short_blip_is_silent(self):
        t = wd.DownTracker(60)
        t.update(False, 0)
        self.assertIsNone(t.update(True, 30))


class BackendGuardTest(unittest.TestCase):
    def guard(self, limit=3, per_hour=2):
        return wd.BackendGuard(limit, 180, wd.RestartBudget(per_hour))

    def test_restarts_after_streak(self):
        g = self.guard()
        self.assertEqual(g.decide(False, "active", 1000, False, 0), "failing")
        self.assertEqual(g.decide(False, "active", 1000, False, 30), "failing")
        self.assertEqual(g.decide(False, "active", 1000, False, 60), "restart")
        self.assertEqual(g.streak, 0)

    def test_healthy_resets_streak(self):
        g = self.guard()
        g.decide(False, "active", 1000, False, 0)
        g.decide(False, "active", 1000, False, 30)
        self.assertEqual(g.decide(True, "active", 1000, False, 60), "ok")
        self.assertEqual(g.decide(False, "active", 1000, False, 90), "failing")

    def test_skips_while_deploying_starting_or_not_active(self):
        g = self.guard(limit=1)
        self.assertEqual(g.decide(False, "active", 1000, True, 0), "skip")
        self.assertEqual(g.decide(False, "active", 60, False, 0), "skip")
        self.assertEqual(g.decide(False, "activating", 1000, False, 0), "skip")
        self.assertEqual(g.decide(False, "failed", 1000, False, 0), "skip")
        self.assertEqual(g.decide(False, "active", None, False, 0), "skip")

    def test_budget_exhausted(self):
        g = self.guard(limit=1, per_hour=2)
        self.assertEqual(g.decide(False, "active", 1000, False, 0), "restart")
        self.assertEqual(g.decide(False, "active", 1000, False, 300), "restart")
        self.assertEqual(g.decide(False, "active", 1000, False, 600), "exhausted")
        self.assertEqual(g.decide(False, "active", 1000, False, 3601), "restart")


class NotifierTest(unittest.TestCase):
    def test_dedupes_by_key(self):
        n = wd.Notifier(dict(wd.DEFAULTS), dry_run=True)
        calls = []
        wd_log = wd.log
        wd.log = calls.append
        try:
            n.send("a", "b", key="k", now=0)
            n.send("a", "b", key="k", now=100)
            n.send("a", "b", key="k", now=1801)
            n.send("a", "b", now=1802)
        finally:
            wd.log = wd_log
        self.assertEqual(len(calls), 3)

    def test_channels_off_by_default(self):
        self.assertEqual(wd.Notifier(dict(wd.DEFAULTS)).enabled_channels(), [])


class ConfigTest(unittest.TestCase):
    def test_borrows_keys_from_backend_env(self):
        with tempfile.TemporaryDirectory() as d:
            backend_env = os.path.join(d, "backend.env")
            with open(backend_env, "w", encoding="utf-8") as f:
                f.write('RESEND_API_KEY="re_x"\nGATEWAY_URL=http://10.66.0.2:8800/\n'
                        "REDIS_URL=redis://127.0.0.1:6379/0\nDATABASE_URL=secret\n")
            own = os.path.join(d, "wd.env")
            with open(own, "w", encoding="utf-8") as f:
                f.write("# 注释\nBACKEND_ENV=%s\nEMAIL_TO=a@x.com, b@x.com\n" % backend_env)
            cfg = wd.load_config(own)
        self.assertEqual(cfg["RESEND_API_KEY"], "re_x")
        self.assertEqual(cfg["GATEWAY_HEALTH_URL"], "http://10.66.0.2:8800/health")
        self.assertEqual(cfg["REDIS_URL"], "redis://127.0.0.1:6379/0")
        self.assertEqual(wd.as_list(cfg["EMAIL_TO"]), ["a@x.com", "b@x.com"])
        self.assertNotIn("DATABASE_URL", cfg)

    def test_own_values_win(self):
        with tempfile.TemporaryDirectory() as d:
            own = os.path.join(d, "wd.env")
            with open(own, "w", encoding="utf-8") as f:
                f.write("BACKEND_ENV=%s\nGATEWAY_HEALTH_URL=http://gw/health\n"
                        % os.path.join(d, "missing.env"))
            cfg = wd.load_config(own)
        self.assertEqual(cfg["GATEWAY_HEALTH_URL"], "http://gw/health")
        self.assertEqual(cfg["MAIL_FROM"], "noreply@prismxsignallab.com")


class RedisProbeTest(unittest.TestCase):
    def test_remote_redis_is_not_our_business(self):
        self.assertIsNone(wd.probe_redis("redis://10.0.0.5:6379/0"))
        self.assertIsNone(wd.probe_redis(""))

    def test_resp_encoding(self):
        self.assertEqual(wd._resp_cmd("PING"), b"*1\r\n$4\r\nPING\r\n")


if __name__ == "__main__":
    unittest.main()
