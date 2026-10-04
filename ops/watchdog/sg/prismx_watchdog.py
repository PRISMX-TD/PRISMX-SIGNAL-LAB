#!/usr/bin/env python3
"""
PRISMX 后端看门狗（跑在 SG 后端服务器上，以 root 身份常驻）。

systemd 只会拉起「已经死掉」的后端；进程活着却不响应（事件循环卡死、某个 worker
挂住）它看不出来，以前只能等人发现后手工 `systemctl restart prismx`。这个脚本补上：

  会自动动手的（只有一件）：
    · 后端连续 FAIL_LIMIT 轮不响应 → `systemctl restart prismx`
      - 正在自动部署（deploy.sh 在跑）、服务刚启动不到 STARTUP_GRACE 秒、或服务处在
        activating / inactive / failed 时都不动手——那些情况要么有人在操作，要么重启救不了
      - 1 小时最多重启 MAX_RESTARTS_PER_HOUR 次，用完就停手并发「需要人工处理」

  只通知、不动手的：
    · 后端崩溃后被 systemd 自动拉起过（NRestarts 变大）
    · 服务处于 failed（起不来，多半是配置/代码问题，重启没用）或被人停掉太久
    · 后端这台机器连不上 gateway（隧道断了或 gateway 挂了）
    · 本机 Redis 不响应
    · 硬盘快满

每次重启或崩溃，都把当时的 journal 尾巴存到 SNAPSHOT_DIR，方便事后找根因；通知里只写
文件路径，不贴日志正文（日志里有用户邮箱、IP 等）。

The backend watchdog. systemd only revives a dead process; this restarts one that
is alive but unresponsive, with a deploy/grace/rate guard, and alerts (email via
Resend and/or Telegram, both off by default) on everything else.

只用标准库，不依赖后端的 venv。/ Standard library only.

用法 / Usage:
    python3 prismx_watchdog.py --config /etc/prismx-watchdog.env            常驻
    python3 prismx_watchdog.py --config /etc/prismx-watchdog.env --once     查一轮，只打印不动手
    python3 prismx_watchdog.py --config /etc/prismx-watchdog.env --test-alert  发一条测试通知
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BEIJING = timezone(timedelta(hours=8))

DEFAULTS = {
    "MACHINE_LABEL": "SG 后端",
    "SERVICE": "prismx",
    "BACKEND_URL": "http://127.0.0.1:8000/",
    "BACKEND_ENV": "/home/ubuntu/PRISMX-SIGNAL-LAB/backend/.env",
    "CHECK_EVERY": "30",
    "HTTP_TIMEOUT": "5",
    # 每轮打几次探针。后端是 2 个 worker，单个 worker 卡死时一次探针只有一半概率打中它；
    # 一轮打 3 次、任意一次失败算这一轮失败，才查得出来。
    # Two workers: one probe hits a wedged worker only half the time.
    "PROBES_PER_TICK": "3",
    "FAIL_LIMIT": "4",
    "STARTUP_GRACE": "180",
    "MAX_RESTARTS_PER_HOUR": "3",
    "INACTIVE_ALERT_SEC": "300",
    "GATEWAY_HEALTH_URL": "",
    "GATEWAY_DOWN_ALERT_SEC": "180",
    "REDIS_DOWN_ALERT_SEC": "90",
    "DISK_ALERT_PCT": "90",
    "DISK_PATH": "/",
    "SNAPSHOT_DIR": "/var/log/prismx-watchdog",
    "SNAPSHOT_KEEP": "30",
    "REPEAT_ALERT_SEC": "1800",
    "EMAIL_ENABLED": "false",
    "RESEND_API_KEY": "",
    "MAIL_FROM": "",
    "EMAIL_TO": "",
    "TELEGRAM_ENABLED": "false",
    "TELEGRAM_BOT_TOKEN": "",
    "TELEGRAM_CHAT_IDS": "",
}


# ---------------------------------------------------------------- 配置 / config

def parse_env_text(text):
    """KEY=VALUE 每行一条；# 开头是注释；值两边的引号去掉。"""
    out = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):]
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        out[key.strip()] = value
    return out


def read_env_file(path):
    try:
        with open(path, encoding="utf-8") as f:
            return parse_env_text(f.read())
    except OSError:
        return {}


def load_config(path):
    cfg = dict(DEFAULTS)
    if path:
        cfg.update(read_env_file(path))
    # 发信密钥、gateway 地址、Redis 地址没单独配时，借后端 .env 里那份。只读这几个键。
    # Borrow these few keys from the backend .env when not set here.
    backend_env = read_env_file(cfg["BACKEND_ENV"])
    if not cfg["RESEND_API_KEY"]:
        cfg["RESEND_API_KEY"] = backend_env.get("RESEND_API_KEY", "")
    if not cfg["MAIL_FROM"]:
        cfg["MAIL_FROM"] = backend_env.get("MAIL_FROM", "") or "noreply@prismxsignallab.com"
    if not cfg["GATEWAY_HEALTH_URL"]:
        gw = backend_env.get("GATEWAY_URL", "")
        if gw:
            cfg["GATEWAY_HEALTH_URL"] = gw.rstrip("/") + "/health"
    cfg["REDIS_URL"] = backend_env.get("REDIS_URL", "")
    return cfg


def as_bool(v):
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def as_list(v):
    return [x.strip() for x in str(v).replace(";", ",").split(",") if x.strip()]


def now_text():
    return datetime.now(BEIJING).strftime("%Y-%m-%d %H:%M:%S") + "（北京时间）"


def log(msg):
    # 打到 stdout，由 journald 收：journalctl -u prismx-watchdog
    print(msg, flush=True)


# ---------------------------------------------------------------- 纯逻辑 / pure logic

class RestartBudget:
    """滑动 1 小时内最多 N 次。/ At most N restarts in any rolling hour."""

    def __init__(self, per_hour):
        self.per_hour = per_hour
        self.stamps = []

    def _trim(self, now):
        self.stamps = [t for t in self.stamps if now - t < 3600]

    def allow(self, now):
        self._trim(now)
        return len(self.stamps) < self.per_hour

    def record(self, now):
        self._trim(now)
        self.stamps.append(now)

    def used(self, now):
        self._trim(now)
        return len(self.stamps)


class DownTracker:
    """某件事持续坏够 threshold 秒报一次「坏了」，恢复时报一次「好了」。
    Fires once when bad for `threshold` seconds, once again on recovery."""

    def __init__(self, threshold):
        self.threshold = threshold
        self.bad_since = None
        self.alerted = False

    def update(self, ok, now):
        if ok:
            was_alerted = self.alerted
            self.bad_since = None
            self.alerted = False
            return "recovered" if was_alerted else None
        if self.bad_since is None:
            self.bad_since = now
        if not self.alerted and now - self.bad_since >= self.threshold:
            self.alerted = True
            return "down"
        return None

    def down_for(self, now):
        return 0 if self.bad_since is None else int(now - self.bad_since)


class BackendGuard:
    """决定这一轮要不要重启后端。/ Decides whether to restart the backend this tick.

    返回 / returns:
      "restart"    该重启了
      "exhausted"  该重启但这小时的次数用完了
      "skip"       本轮不评估（部署中 / 刚启动 / 不在 active）
      "ok" / "failing"
    """

    def __init__(self, fail_limit, grace, budget):
        self.fail_limit = fail_limit
        self.grace = grace
        self.budget = budget
        self.streak = 0

    def decide(self, healthy, active_state, uptime, deploying, now):
        if deploying or active_state != "active" or uptime is None or uptime < self.grace:
            self.streak = 0
            return "skip"
        if healthy:
            self.streak = 0
            return "ok"
        self.streak += 1
        if self.streak < self.fail_limit:
            return "failing"
        if not self.budget.allow(now):
            return "exhausted"
        self.budget.record(now)
        self.streak = 0
        return "restart"


# ---------------------------------------------------------------- 探针 / probes

def http_get(url, timeout):
    """返回 (ok, body 或错误说明)。2xx 才算 ok。"""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "prismx-watchdog"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read(64 * 1024).decode("utf-8", "replace")
            return 200 <= resp.status < 300, body
    except urllib.error.HTTPError as e:
        return False, "HTTP %s" % e.code
    except Exception as e:  # 超时、拒绝连接、DNS……
        return False, type(e).__name__ + ": " + str(e)[:200]


def probe_backend(cfg):
    url = cfg["BACKEND_URL"]
    timeout = float(cfg["HTTP_TIMEOUT"])
    last_err = ""
    ok_all = True
    for _ in range(max(1, int(cfg["PROBES_PER_TICK"]))):
        ok, detail = http_get(url, timeout)
        if not ok:
            ok_all = False
            last_err = detail
    return ok_all, last_err


def probe_redis(redis_url, timeout=3.0):
    """只查本机 Redis：发 PING 等 +PONG。远程 Redis 不归这台机器的看门狗管，返回 None。"""
    if not redis_url:
        return None
    parsed = urllib.parse.urlparse(redis_url)
    host = parsed.hostname or "127.0.0.1"
    if host not in ("127.0.0.1", "localhost", "::1"):
        return None
    port = parsed.port or 6379
    try:
        with socket.create_connection((host, port), timeout=timeout) as s:
            s.settimeout(timeout)
            if parsed.password:
                user = parsed.username or "default"
                s.sendall(_resp_cmd("AUTH", user, parsed.password))
                s.recv(256)
            s.sendall(_resp_cmd("PING"))
            reply = s.recv(64)
            return reply.startswith(b"+PONG")
    except OSError:
        return False


def _resp_cmd(*parts):
    out = [("*%d\r\n" % len(parts)).encode()]
    for p in parts:
        b = p.encode("utf-8")
        out.append(("$%d\r\n" % len(b)).encode() + b + b"\r\n")
    return b"".join(out)


def disk_used_pct(path):
    u = shutil.disk_usage(path)
    return 100.0 * u.used / u.total if u.total else 0.0


# ---------------------------------------------------------------- systemd

def unit_state(service):
    """ActiveState / NRestarts / 已运行秒数。读不到返回空 dict。"""
    try:
        out = subprocess.run(
            ["systemctl", "show", service,
             "-p", "ActiveState", "-p", "NRestarts", "-p", "ActiveEnterTimestampMonotonic"],
            capture_output=True, text=True, timeout=15).stdout
    except Exception:
        return {}
    props = parse_env_text(out)
    uptime = None
    try:
        entered_us = int(props.get("ActiveEnterTimestampMonotonic", "0"))
        if entered_us > 0:
            # systemd 的 monotonic 与 Python 的 time.monotonic 在 Linux 上是同一个时钟
            uptime = time.monotonic() - entered_us / 1e6
    except ValueError:
        pass
    try:
        n_restarts = int(props.get("NRestarts", "0"))
    except ValueError:
        n_restarts = 0
    return {"active_state": props.get("ActiveState", ""), "n_restarts": n_restarts, "uptime": uptime}


def deploy_running():
    """自动部署（backend/scripts/deploy.sh）在跑时它自己会重启服务，看门狗让路。"""
    try:
        return subprocess.run(["pgrep", "-f", "scripts/deploy.sh"],
                              capture_output=True, timeout=10).returncode == 0
    except Exception:
        return False


def restart_service(service):
    try:
        r = subprocess.run(["systemctl", "restart", service],
                           capture_output=True, text=True, timeout=120)
        return r.returncode == 0, (r.stderr or "").strip()[:300]
    except Exception as e:
        return False, str(e)[:300]


def save_snapshot(cfg, tag):
    """存一份 journal 尾巴，返回文件路径（失败返回空串）。只留最近 SNAPSHOT_KEEP 份。"""
    d = cfg["SNAPSHOT_DIR"]
    try:
        os.makedirs(d, mode=0o700, exist_ok=True)
        name = "%s-%s.log" % (datetime.now(BEIJING).strftime("%Y%m%d-%H%M%S"), tag)
        path = os.path.join(d, name)
        out = subprocess.run(
            ["journalctl", "-u", cfg["SERVICE"], "-n", "300", "--no-pager"],
            capture_output=True, text=True, timeout=30).stdout
        with open(path, "w", encoding="utf-8") as f:
            f.write(out)
        os.chmod(path, 0o600)
        files = sorted(x for x in os.listdir(d) if x.endswith(".log"))
        for old in files[:-int(cfg["SNAPSHOT_KEEP"])]:
            os.remove(os.path.join(d, old))
        return path
    except Exception as e:
        log("存日志快照失败：%s" % e)
        return ""


# ---------------------------------------------------------------- 通知 / alerts

class Notifier:
    def __init__(self, cfg, dry_run=False):
        self.cfg = cfg
        self.dry_run = dry_run
        self.repeat = int(cfg["REPEAT_ALERT_SEC"])
        self.last_sent = {}

    def enabled_channels(self):
        ch = []
        if as_bool(self.cfg["EMAIL_ENABLED"]):
            ch.append("email")
        if as_bool(self.cfg["TELEGRAM_ENABLED"]):
            ch.append("telegram")
        return ch

    def send(self, title, body, key=None, now=None):
        """key 相同的通知在 REPEAT_ALERT_SEC 内只发一次。返回实际发出去的渠道列表。"""
        now = time.monotonic() if now is None else now
        if key is not None:
            last = self.last_sent.get(key)
            if last is not None and now - last < self.repeat:
                return []
            self.last_sent[key] = now
        subject = "[PRISMX 看门狗] %s · %s" % (self.cfg["MACHINE_LABEL"], title)
        text = "%s\n\n%s\n\n时间：%s\n机器：%s" % (subject, body, now_text(), self.cfg["MACHINE_LABEL"])
        log("通知：%s | %s" % (title, body.replace("\n", " / ")))
        if self.dry_run:
            return []
        sent = []
        for ch in self.enabled_channels():
            try:
                if ch == "email":
                    self._email(subject, text)
                else:
                    self._telegram(text)
                sent.append(ch)
            except Exception as e:
                log("通知发送失败（%s）：%s" % (ch, str(e)[:200]))
        return sent

    def _email(self, subject, text):
        to = as_list(self.cfg["EMAIL_TO"])
        key = self.cfg["RESEND_API_KEY"]
        if not to or not key:
            raise RuntimeError("EMAIL_TO 或 RESEND_API_KEY 没配")
        payload = json.dumps({"from": "PRISMX 看门狗 <%s>" % self.cfg["MAIL_FROM"],
                              "to": to, "subject": subject, "text": text}).encode("utf-8")
        req = urllib.request.Request(
            "https://api.resend.com/emails", data=payload, method="POST",
            headers={"Authorization": "Bearer " + key, "Content-Type": "application/json",
                     "User-Agent": "prismx-watchdog"})
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()

    def _telegram(self, text):
        token = self.cfg["TELEGRAM_BOT_TOKEN"]
        chats = as_list(self.cfg["TELEGRAM_CHAT_IDS"])
        if not token or not chats:
            raise RuntimeError("TELEGRAM_BOT_TOKEN 或 TELEGRAM_CHAT_IDS 没配")
        errors = []
        for chat in chats:
            payload = json.dumps({"chat_id": chat, "text": text}).encode("utf-8")
            req = urllib.request.Request(
                "https://api.telegram.org/bot%s/sendMessage" % token, data=payload, method="POST",
                headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    resp.read()
            except Exception as e:
                # 别把带 token 的 URL 打进日志
                errors.append("%s: %s" % (chat, type(e).__name__))
        if errors:
            raise RuntimeError("部分 chat 发送失败 " + ", ".join(errors))


# ---------------------------------------------------------------- 主循环 / main loop

class Watchdog:
    def __init__(self, cfg, dry_run=False):
        self.cfg = cfg
        self.dry_run = dry_run
        self.notifier = Notifier(cfg, dry_run=dry_run)
        self.budget = RestartBudget(int(cfg["MAX_RESTARTS_PER_HOUR"]))
        self.guard = BackendGuard(int(cfg["FAIL_LIMIT"]), int(cfg["STARTUP_GRACE"]), self.budget)
        self.inactive = DownTracker(int(cfg["INACTIVE_ALERT_SEC"]))
        self.gateway = DownTracker(int(cfg["GATEWAY_DOWN_ALERT_SEC"]))
        self.redis = DownTracker(int(cfg["REDIS_DOWN_ALERT_SEC"]))
        self.last_n_restarts = None
        self.last_state = None

    def tick(self):
        now = time.monotonic()
        cfg = self.cfg
        service = cfg["SERVICE"]
        unit = unit_state(service)
        state = unit.get("active_state", "")
        deploying = deploy_running()

        # 1) 后端是否响应 → 必要时重启
        healthy, err = probe_backend(cfg)
        verdict = self.guard.decide(healthy, state, unit.get("uptime"), deploying, now)
        if verdict == "failing":
            log("后端第 %d 轮不响应（%s）" % (self.guard.streak, err))
        elif verdict == "restart":
            self._restart_backend(err)
        elif verdict == "exhausted":
            self.notifier.send(
                "后端仍然卡死，看门狗已停手",
                "后端持续不响应，但 1 小时内已经自动重启了 %d 次，再重启也没用，需要人工处理。\n"
                "最后一次错误：%s\n"
                "排查：journalctl -u %s -n 200 --no-pager；日志快照在 %s"
                % (self.budget.used(now), err, service, cfg["SNAPSHOT_DIR"]),
                key="exhausted", now=now)

        # 2) systemd 自己拉起过崩溃的后端
        n = unit.get("n_restarts")
        if n is not None and self.last_n_restarts is not None and n > self.last_n_restarts:
            path = self._snapshot("crash")
            self.notifier.send(
                "后端崩溃过，已被自动拉起",
                "后端进程异常退出，systemd 已自动重新启动（累计 %d 次）。目前状态：%s。\n"
                "当时的日志存在：%s" % (n, state or "未知", path or "（保存失败）"),
                now=now)
        if n is not None:
            self.last_n_restarts = n

        # 3) 服务没在跑：failed 起不来 / inactive 被停掉
        if state == "failed" and self.last_state != "failed":
            path = self._snapshot("failed")
            self.notifier.send(
                "后端起不来（failed）",
                "后端服务处于 failed 状态，多半是配置或代码问题，重启解决不了，看门狗不会动它。\n"
                "日志快照：%s\n排查：journalctl -u %s -n 200 --no-pager" % (path or "（保存失败）", service),
                now=now)
        ev = self.inactive.update(state not in ("inactive",) or deploying, now)
        if ev == "down":
            self.notifier.send(
                "后端被停掉了",
                "后端服务已停止 %d 秒以上，而且不是自动部署造成的。如果不是有人故意停的，"
                "执行 systemctl start %s。看门狗不会替人启动被手动停掉的服务。"
                % (self.inactive.down_for(now), service), now=now)
        elif ev == "recovered":
            self.notifier.send("后端已重新运行", "后端服务恢复运行。", now=now)
        self.last_state = state

        # 4) 后端连不连得上 gateway
        gw_url = cfg["GATEWAY_HEALTH_URL"]
        if gw_url:
            gw_ok, gw_detail = http_get(gw_url, float(cfg["HTTP_TIMEOUT"]))
            ev = self.gateway.update(gw_ok, now)
            if ev == "down":
                self.notifier.send(
                    "后端连不上 gateway",
                    "已经 %d 秒连不上 gateway（%s）。用户下单、查持仓会失败。\n"
                    "可能是 WireGuard 隧道断了，也可能是 gateway 挂了——看 VPS 那边的看门狗有没有报警。"
                    % (self.gateway.down_for(now), gw_detail), now=now)
            elif ev == "recovered":
                self.notifier.send("后端已重新连上 gateway", "gateway 恢复可达。", now=now)

        # 5) Redis
        r = probe_redis(cfg.get("REDIS_URL", ""))
        if r is not None:
            ev = self.redis.update(r, now)
            if ev == "down":
                self.notifier.send(
                    "Redis 不响应",
                    "本机 Redis 已 %d 秒不响应，两个 worker 之间的共享状态（限流、在线状态等）会出问题。\n"
                    "排查：systemctl status redis-server" % self.redis.down_for(now), now=now)
            elif ev == "recovered":
                self.notifier.send("Redis 已恢复", "本机 Redis 恢复响应。", now=now)

        # 6) 硬盘
        try:
            pct = disk_used_pct(cfg["DISK_PATH"])
            if pct >= float(cfg["DISK_ALERT_PCT"]):
                self.notifier.send(
                    "硬盘快满了",
                    "%s 已用 %.0f%%。满了以后日志、数据库快照都写不进去，后端可能出各种怪问题。"
                    % (cfg["DISK_PATH"], pct), key="disk", now=now)
        except OSError:
            pass

        return {"healthy": healthy, "error": err, "state": state, "uptime": unit.get("uptime"),
                "deploying": deploying, "verdict": verdict, "streak": self.guard.streak}

    def _snapshot(self, tag):
        return "" if self.dry_run else save_snapshot(self.cfg, tag)

    def _restart_backend(self, err):
        cfg = self.cfg
        if self.dry_run:
            log("[dry-run] 本该重启后端，跳过")
            return
        path = self._snapshot("hung")
        log("后端连续不响应，执行重启（最后错误：%s）" % err)
        ok, detail = restart_service(cfg["SERVICE"])
        self.notifier.send(
            "后端卡死，已自动重启" if ok else "后端卡死，自动重启失败",
            "后端连续 %s 轮不响应（%s），看门狗%s。\n重启前的日志存在：%s\n"
            "1 小时内已自动重启 %d 次（上限 %s 次）。"
            % (cfg["FAIL_LIMIT"], err, "已执行重启" if ok else "执行重启失败：" + detail,
               path or "（保存失败）", self.budget.used(time.monotonic()), cfg["MAX_RESTARTS_PER_HOUR"]))


def main(argv=None):
    ap = argparse.ArgumentParser(description="PRISMX 后端看门狗")
    ap.add_argument("--config", default="/etc/prismx-watchdog.env")
    ap.add_argument("--once", action="store_true", help="只查一轮、打印结果，不重启不发通知")
    ap.add_argument("--test-alert", action="store_true", help="通过已启用的渠道发一条测试通知")
    args = ap.parse_args(argv)

    cfg = load_config(args.config)

    if args.test_alert:
        n = Notifier(cfg)
        if not n.enabled_channels():
            log("邮件和 Telegram 都没启用（EMAIL_ENABLED / TELEGRAM_ENABLED），没有发送。")
            return 1
        sent = n.send("测试通知", "这是一条测试通知，收到说明看门狗的通知渠道配置正确。")
        log("已发送渠道：%s" % (", ".join(sent) or "无"))
        return 0 if sent else 1

    if args.once:
        wd = Watchdog(cfg, dry_run=True)
        result = wd.tick()
        log(json.dumps(result, ensure_ascii=False, default=str))
        return 0

    wd = Watchdog(cfg)
    log("看门狗启动：服务 %s，每 %s 秒查一次，通知渠道：%s"
        % (cfg["SERVICE"], cfg["CHECK_EVERY"], ", ".join(wd.notifier.enabled_channels()) or "未启用"))
    every = int(cfg["CHECK_EVERY"])
    while True:
        started = time.monotonic()
        try:
            wd.tick()
        except Exception as e:
            log("本轮检查出错（继续）：%s: %s" % (type(e).__name__, e))
        time.sleep(max(1.0, every - (time.monotonic() - started)))


if __name__ == "__main__":
    sys.exit(main())
