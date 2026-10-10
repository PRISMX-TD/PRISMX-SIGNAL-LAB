"""PRISMX 压测工具：模拟网页在线用户（含 WS）与桥接客户端，分档加量，到阈值自动停。
PRISMX load generator: simulated web users (incl. WS) and Bridge clients, stepped
load, auto-stop on thresholds.

    python loadtest.py --creds creds.json --base https://api.prismxsignallab.com \
        --scenario browse|bridge|mixed --stages 50,200,500 --hold 90 --ramp 30 --procs 6

Scenario behaviour mirrors the real clients (frontend store/live.tsx + components,
bridge/bridge_app.py). Endpoints with per-IP limits (competitions, gamification,
leaderboards, login) are left out: from one IP they would just 429.
"""
import argparse
import asyncio
import hashlib
import json
import multiprocessing as mp
import os
import random
import statistics
import sys
import time
from collections import Counter, defaultdict

# Requests whose duration is by design long (long-poll) — counted for errors, not latency.
LONG = {"bridge_cmd_poll"}
STATS_EVERY = 5.0


def pct(xs, p):
    if not xs:
        return 0.0
    xs = sorted(xs)
    k = min(len(xs) - 1, max(0, int(round(p / 100.0 * (len(xs) - 1)))))
    return xs[k]


class Stats:
    def __init__(self):
        self.lat = defaultdict(list)
        self.status = defaultdict(Counter)
        self.counters = Counter()

    def add(self, name, ms, status):
        self.lat[name].append(ms)
        self.status[name][status] += 1

    def snapshot(self):
        snap = {"lat": dict(self.lat), "status": {k: dict(v) for k, v in self.status.items()},
                "counters": dict(self.counters)}
        self.lat = defaultdict(list)
        self.status = defaultdict(Counter)
        self.counters = Counter()
        return snap


def ok_status(s):
    return isinstance(s, int) and 200 <= s < 300


# ---------------------------------------------------------------- worker side

class Ctx:
    def __init__(self, a, stats, symbols):
        self.a = a
        self.stats = stats
        self.symbols = symbols
        self.base = a.base.rstrip("/")
        self.ws_url = self.base.replace("https://", "wss://").replace("http://", "ws://") + "/ws/client"
        self.stop = False


async def do_req(ctx, sess, name, method, path, *, json_body=None, headers=None, timeout=15):
    import aiohttp
    t = time.perf_counter()
    try:
        async with sess.request(method, ctx.base + path, json=json_body, headers=headers,
                                timeout=aiohttp.ClientTimeout(total=timeout)) as r:
            body = await r.read()
            st = r.status
    except asyncio.TimeoutError:
        body, st = None, "timeout"
    except asyncio.CancelledError:
        raise
    except Exception as e:
        body, st = None, type(e).__name__
    ctx.stats.add(name, (time.perf_counter() - t) * 1000, st)
    return st, body


async def ws_loop(ctx, sess, jwt):
    """Mirror useClientSocket: AUTH within 5s, PING every 5s, reconnect on drop."""
    import aiohttp
    while not ctx.stop:
        t = time.perf_counter()
        try:
            async with sess.ws_connect(ctx.ws_url, heartbeat=None, timeout=aiohttp.ClientWSTimeout(ws_close=5),
                                       max_msg_size=8 * 1024 * 1024) as ws:
                await ws.send_str(json.dumps({"type": "AUTH", "token": jwt}))
                authed = False
                pending_ping = None
                last_ping = 0.0
                while not ctx.stop:
                    now = time.perf_counter()
                    if authed and now - last_ping >= 5.0:
                        if pending_ping is not None and now - pending_ping > 10:
                            ctx.stats.add("ws_pong", 10000, "timeout")
                            pending_ping = None
                        await ws.send_str('{"type":"PING","bg":false}')
                        last_ping = now
                        if pending_ping is None:
                            pending_ping = now
                    try:
                        msg = await ws.receive(timeout=1.0)
                    except asyncio.TimeoutError:
                        if not authed and time.perf_counter() - t > 10:
                            ctx.stats.add("ws_auth", 10000, "timeout")
                            break
                        continue
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        if msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED,
                                        aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSING):
                            break
                        continue
                    ctx.stats.counters["ws_bytes"] += len(msg.data)
                    try:
                        typ = json.loads(msg.data).get("type")
                    except Exception:
                        typ = "?"
                    ctx.stats.counters["ws_msg:" + str(typ)] += 1
                    if typ == "AUTH_OK":
                        authed = True
                        ctx.stats.add("ws_auth", (time.perf_counter() - t) * 1000, 200)
                        last_ping = time.perf_counter() - random.uniform(0, 5)
                    elif typ == "AUTH_FAIL":
                        ctx.stats.add("ws_auth", (time.perf_counter() - t) * 1000, "auth_fail")
                        await asyncio.sleep(30)
                        break
                    elif typ == "PONG" and pending_ping is not None:
                        ctx.stats.add("ws_pong", (time.perf_counter() - pending_ping) * 1000, 200)
                        pending_ping = None
                if not ctx.stop:
                    ctx.stats.counters["ws_drop"] += 1
        except asyncio.CancelledError:
            raise
        except Exception as e:
            ctx.stats.add("ws_auth", (time.perf_counter() - t) * 1000, "conn:" + type(e).__name__)
        if not ctx.stop:
            await asyncio.sleep(random.uniform(1, 3))


async def browse_vu(ctx, sess, user, on_chart):
    """A logged-in web user sitting on the dashboard (optionally the chart page)."""
    h = {"Authorization": "Bearer " + user["jwt"]}
    ws_task = asyncio.create_task(ws_loop(ctx, sess, user["jwt"]))
    try:
        # first screen: what refreshAll + the dashboard cards fetch in parallel
        first = [("auth_me", "/api/auth/me"), ("bootstrap", "/api/bootstrap"), ("orders", "/api/orders"),
                 ("orders_winrate", "/api/orders/winrate"), ("signals_winrate", "/api/signals/winrate"),
                 ("announce_popup", "/api/announcements/popup"),
                 ("notif_feed", "/api/notifications/feed?limit=20"), ("sentiment", "/api/sentiment")]
        await asyncio.gather(*(do_req(ctx, sess, n, "GET", p, headers=h) for n, p in first))
        sym = random.choice(ctx.symbols)
        if on_chart:
            await do_req(ctx, sess, "chart_history", "GET",
                         f"/api/chart/history?symbol={sym}&interval=1&limit=300", headers=h)
        # periodic polls (WS is up, so the slow cadences apply), de-synchronised
        now = time.monotonic()
        jobs = {
            "bridge_accounts": [60, "/api/bridge/accounts"],
            "symbols": [90, "/api/symbols"],
            "orders_winrate": [180, "/api/orders/winrate"],
            "closed_trades": [180, "/api/orders/closed-trades"],
            "sentiment": [300, "/api/sentiment"],
        }
        if on_chart:
            # useChartData: 10 s while WS quotes are fresh (POLL_SLOW_MS), plus one boundary
            # catch-up 3.3 s after each 1-minute bar opens (BOUNDARY_SETTLE_MS)
            jobs["chart_latest"] = [10, f"/api/chart/latest?symbol={sym}&interval=1"]
            jobs["chart_boundary"] = [60, f"/api/chart/latest?symbol={sym}&interval=1"]
        due = {k: now + random.uniform(0, v[0]) for k, v in jobs.items()}
        if on_chart:
            due["chart_boundary"] = now + (60 - time.time() % 60) + 3.3
        while not ctx.stop:
            k = min(due, key=due.get)
            wait = due[k] - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            await do_req(ctx, sess, k, "GET", jobs[k][1], headers=h)
            due[k] = time.monotonic() + jobs[k][0]
    finally:
        ws_task.cancel()


def fake_account(i):
    return {"login": str(8800000000 + i), "server": "MakeCapital-LoadTest", "accountName": "LOADTEST",
            "accountCurrency": "USD", "balance": 10000.0, "equity": 10000.0, "margin": 0.0,
            "leverage": 100, "company": "LoadTest", "detectedSuffix": "", "tradeMode": 0}


async def bridge_vu(ctx, sess, user):
    """Bridge 1.4.x: status loop 1.5s, long-poll command loop, positions keep-alive 15s."""
    token = "lt-%s-%d" % (ctx.a.token_seed, user["i"])
    h = {"X-API-Token": token}
    accounts = [fake_account(user["i"])]

    async def status_loop():
        await asyncio.sleep(random.uniform(0, 1.5))
        while not ctx.stop:
            t0 = time.monotonic()
            await do_req(ctx, sess, "bridge_status_poll", "POST", "/api/bridge/poll", headers=h,
                         json_body={"accounts": accounts, "bridgeVersion": "1.4.9", "fetchCommands": False})
            await asyncio.sleep(max(0.05, 1.5 - (time.monotonic() - t0)))

    async def command_loop():
        await asyncio.sleep(random.uniform(0, 5))
        while not ctx.stop:
            st, body = await do_req(ctx, sess, "bridge_cmd_poll", "POST", "/api/bridge/poll", headers=h,
                                    json_body={"accounts": accounts, "bridgeVersion": "1.4.9",
                                               "waitSeconds": 5, "fetchCommands": True}, timeout=9)
            if ok_status(st) and body:
                try:
                    cmds = json.loads(body).get("commands") or []
                except Exception:
                    cmds = []
                for c in cmds:  # only appears in order tests: ack as filled
                    ctx.stats.counters["bridge_cmds"] += 1
                    await do_req(ctx, sess, "bridge_result", "POST", "/api/bridge/result", headers=h,
                                 json_body={"clientOrderId": c.get("clientOrderId"), "success": True,
                                            "mt5Ticket": random.randint(10**8, 10**9), "filledPrice": 1.0,
                                            "volume": c.get("volume") or 0.01, "message": "loadtest",
                                            "login": c.get("login")})
            else:
                await asyncio.sleep(1.5)

    async def positions_loop():
        await asyncio.sleep(random.uniform(0, 15))
        while not ctx.stop:
            await do_req(ctx, sess, "bridge_positions", "POST", "/api/bridge/positions", headers=h,
                         json_body={"data": [], "pendingOrders": []})
            await asyncio.sleep(15)

    await asyncio.gather(status_loop(), command_loop(), positions_loop())


async def vu_main(ctx, user, kind):
    import aiohttp
    # one connection pool per simulated person, like a browser / one Bridge process
    conn = aiohttp.TCPConnector(limit=6, ttl_dns_cache=600)
    async with aiohttp.ClientSession(connector=conn) as sess:
        tasks = []
        if kind in ("browse", "mixed"):
            tasks.append(browse_vu(ctx, sess, user, on_chart=random.random() < ctx.a.chart_frac))
        if user["i"] > 0 and (kind == "bridge" or (kind == "mixed" and random.random() < ctx.a.bridge_frac)):
            tasks.append(bridge_vu(ctx, sess, user))
        await asyncio.gather(*tasks)


async def canary(ctx):
    """Cheap probes: GET / (no DB, no auth) = event-loop responsiveness."""
    import aiohttp
    async with aiohttp.ClientSession() as sess:
        while not ctx.stop:
            await do_req(ctx, sess, "canary_root", "GET", "/", timeout=10)
            await asyncio.sleep(2)


async def worker_async(wid, a, users, target, stopflag, q, symbols):
    stats = Stats()
    ctx = Ctx(a, stats, symbols)
    running = []  # list of tasks, index = user slot
    last_report = time.monotonic()
    canary_task = asyncio.create_task(canary(ctx)) if wid == 0 else None
    spawn_gap = 0.0
    next_spawn = 0.0
    while True:
        if stopflag.value:
            break
        want = min(target[wid], len(users))
        # ramp: spread new VUs evenly over --ramp seconds
        if len(running) < want:
            now = time.monotonic()
            if now >= next_spawn:
                gap = a.ramp / max(1, want - len(running))
                running.append(asyncio.create_task(vu_main(ctx, users[len(running)], a.scenario)))
                next_spawn = now + min(gap, 0.5)
        elif len(running) > want:
            t = running.pop()
            t.cancel()
        if time.monotonic() - last_report >= STATS_EVERY:
            snap = stats.snapshot()
            snap["vus"] = len(running)
            snap["dead"] = sum(1 for t in running if t.done())
            q.put((wid, snap))
            last_report = time.monotonic()
        await asyncio.sleep(0.02)
    ctx.stop = True
    for t in running:
        t.cancel()
    if canary_task:
        canary_task.cancel()
    await asyncio.gather(*running, return_exceptions=True)
    q.put((wid, stats.snapshot() | {"vus": 0, "dead": 0, "final": True}))


def worker(wid, a, users, target, stopflag, q, symbols):
    # Windows: keep the default Proactor loop — the selector loop caps at 512 sockets.
    try:
        asyncio.run(worker_async(wid, a, users, target, stopflag, q, symbols))
    except KeyboardInterrupt:
        pass


# ---------------------------------------------------------------- master side

def summarize(agg, secs):
    """agg: {'lat': {name: [...]}, 'status': {name: Counter}} → per-endpoint rows + totals."""
    rows = {}
    tot_n = tot_err = 0
    lat_all = []
    for name in sorted(set(agg["lat"]) | set(agg["status"])):
        st = agg["status"].get(name, {})
        n = sum(st.values())
        err = sum(v for k, v in st.items() if not ok_status(k))
        xs = agg["lat"].get(name, [])
        ok_xs = xs
        rows[name] = {"n": n, "rps": round(n / secs, 1), "err": err,
                      "errs": {str(k): v for k, v in st.items() if not ok_status(k)},
                      "p50": round(pct(ok_xs, 50)), "p95": round(pct(ok_xs, 95)),
                      "p99": round(pct(ok_xs, 99)), "max": round(max(ok_xs) if ok_xs else 0)}
        if name.startswith("ws_") or name == "canary_root":
            continue
        tot_n += n
        tot_err += err
        if name not in LONG:
            lat_all.extend(xs)
    return rows, {"n": tot_n, "rps": round(tot_n / secs, 1), "err": tot_err,
                  "err_rate": round(tot_err / tot_n, 4) if tot_n else 0,
                  "p50": round(pct(lat_all, 50)), "p95": round(pct(lat_all, 95)),
                  "p99": round(pct(lat_all, 99))}


def merge(into, snap):
    for k, v in snap["lat"].items():
        into["lat"].setdefault(k, []).extend(v)
    for k, v in snap["status"].items():
        c = into["status"].setdefault(k, Counter())
        for s, n in v.items():
            c[s] += n
    for k, v in snap.get("counters", {}).items():
        into["counters"][k] = into["counters"].get(k, 0) + v


def new_agg():
    return {"lat": {}, "status": {}, "counters": {}}


def fetch_symbols(a, users):
    import urllib.request
    for u in users[:3]:
        if not u.get("jwt"):
            continue
        try:
            req = urllib.request.Request(a.base.rstrip("/") + "/api/symbols",
                                         headers={"Authorization": "Bearer " + u["jwt"]})
            data = json.loads(urllib.request.urlopen(req, timeout=10).read())
            syms = data.get("symbols") if isinstance(data, dict) else data
            out = [s if isinstance(s, str) else s.get("symbol") for s in syms or []]
            out = [s for s in out if s]
            if out:
                return out[:8]
        except Exception as e:
            print("symbols fetch failed:", e)
    return ["XAUUSD"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--creds", required=True)
    ap.add_argument("--base", required=True)
    ap.add_argument("--scenario", choices=["browse", "bridge", "mixed"], required=True)
    ap.add_argument("--stages", required=True, help="comma list of total VUs, e.g. 50,200,500")
    ap.add_argument("--hold", type=float, default=90, help="seconds measured per stage (after ramp)")
    ap.add_argument("--ramp", type=float, default=30)
    ap.add_argument("--procs", type=int, default=6)
    ap.add_argument("--chart-frac", type=float, default=0.5)
    ap.add_argument("--bridge-frac", type=float, default=0.3)
    ap.add_argument("--max-err", type=float, default=0.01)
    ap.add_argument("--max-p95", type=float, default=2000)
    ap.add_argument("--out", default="results.json")
    ap.add_argument("--first-user", type=int, default=1)
    ap.add_argument("--sessions-per-user", type=int, default=1)
    # live abort on a 10 s window — protects production from sitting in overload
    ap.add_argument("--emergency-err", type=float, default=0.05)
    ap.add_argument("--emergency-p95", type=float, default=5000)
    ap.add_argument("--emergency-windows", type=int, default=2)
    a = ap.parse_args()

    data = json.load(open(a.creds))
    a.token_seed = data["token_seed"]
    users = [u for u in data["users"] if u["i"] >= a.first_user]
    if a.scenario != "bridge":
        users = [u for u in users if u.get("jwt")]
    if a.sessions_per_user > 1:
        # same person on phone + desktop: extra web sessions, but only the first copy runs a Bridge
        users = users + [dict(u, i=-u["i"]) for _ in range(a.sessions_per_user - 1) for u in users]
    stages = [int(x) for x in a.stages.split(",")]
    if stages[-1] > len(users):
        print(f"only {len(users)} usable users; stages capped")
        stages = [min(s, len(users)) for s in stages]
        stages = sorted(set(stages))
    symbols = fetch_symbols(a, data["users"]) if a.scenario != "bridge" else ["XAUUSD"]
    print("symbols:", symbols)

    K = a.procs
    shards = [users[w::K] for w in range(K)]
    target = mp.Array("i", K)
    stopflag = mp.Value("i", 0)
    q = mp.Queue()
    procs = [mp.Process(target=worker, args=(w, a, shards[w], target, stopflag, q, symbols), daemon=True)
             for w in range(K)]
    for p in procs:
        p.start()

    results = {"scenario": a.scenario, "base": a.base, "started": time.strftime("%Y-%m-%d %H:%M:%S"),
               "args": {k: v for k, v in vars(a).items() if k != "token_seed"}, "stages": []}
    vus = [0] * K
    dead = [0] * K
    stop_reason = None

    def drain(agg, timeout):
        end = time.monotonic() + timeout
        while True:
            left = end - time.monotonic()
            if left <= 0:
                return
            try:
                wid, snap = q.get(timeout=left)
            except Exception:
                return
            vus[wid] = snap.get("vus", 0)
            dead[wid] = snap.get("dead", 0)
            if agg is not None:
                merge(agg, snap)

    try:
        for n in stages:
            for w in range(K):
                target[w] = n // K + (1 if w < n % K else 0)
            print(f"\n=== stage {n} VUs: ramping {a.ramp:.0f}s ===", flush=True)
            ramp_agg = new_agg()
            # let first-screen bursts settle, but keep watching: overload usually starts mid-ramp
            ramp_end = time.monotonic() + a.ramp + 10
            while time.monotonic() < ramp_end and not stop_reason:
                w = new_agg()
                drain(w, min(10, max(0.1, ramp_end - time.monotonic())))
                merge(ramp_agg, w)
                _, rt = summarize(w, 10)
                if rt["n"] and (rt["err_rate"] > a.emergency_err or rt["p95"] > a.emergency_p95):
                    print(f"  [ramp {sum(vus)} VUs] err {rt['err_rate']*100:.2f}% p95 {rt['p95']}ms", flush=True)
                    stop_reason = "emergency stop during ramp"
            if stop_reason:
                results["stages"].append({"vus": n, "aborted_in_ramp": True,
                                          "ramp_endpoints": summarize(ramp_agg, a.ramp + 10)[0]})
                break
            agg = new_agg()
            t0 = time.monotonic()
            win = new_agg()
            win_t = time.monotonic()
            bad_windows = 0
            while time.monotonic() - t0 < a.hold:
                before = new_agg()
                drain(before, 1.0)
                merge(agg, before)
                merge(win, before)
                if time.monotonic() - win_t >= 10:
                    secs = time.monotonic() - win_t
                    _, tot = summarize(win, secs)
                    rows, _ = summarize(win, secs)
                    pong = rows.get("ws_pong", {})
                    can = rows.get("canary_root", {})
                    print(f"  [{sum(vus):>5} VUs] {tot['rps']:>7} req/s  p50 {tot['p50']:>5}ms  p95 {tot['p95']:>5}ms  "
                          f"err {tot['err_rate']*100:5.2f}%  pong p95 {pong.get('p95', '-')}ms  "
                          f"canary p95 {can.get('p95', '-')}ms", flush=True)
                    if tot["err_rate"] > a.emergency_err or tot["p95"] > a.emergency_p95:
                        bad_windows += 1
                    else:
                        bad_windows = 0
                    win = new_agg()
                    win_t = time.monotonic()
                    if bad_windows >= a.emergency_windows:
                        stop_reason = (f"emergency stop: {bad_windows} window(s) with err>{a.emergency_err:.0%} "
                                       f"or p95>{a.emergency_p95:.0f}ms")
                        break
            secs = time.monotonic() - t0
            rows, tot = summarize(agg, secs)
            ramp_rows, _ = summarize(ramp_agg, a.ramp + 10)
            st = {"vus": n, "secs": round(secs), "total": tot, "endpoints": rows,
                  "ramp_endpoints": ramp_rows, "counters": agg["counters"], "dead_vus": sum(dead)}
            results["stages"].append(st)
            print(f"--- stage {n}: {tot['rps']} req/s, p50 {tot['p50']}ms p95 {tot['p95']}ms p99 {tot['p99']}ms, "
                  f"errors {tot['err']} ({tot['err_rate']*100:.2f}%)")
            for name, r in rows.items():
                print(f"    {name:<20} n={r['n']:<7} {r['rps']:>7}/s p50 {r['p50']:>5} p95 {r['p95']:>5} "
                      f"p99 {r['p99']:>5} max {r['max']:>6} err {r['err']} {r['errs'] if r['err'] else ''}")
            wsm = {k: v for k, v in agg["counters"].items() if k.startswith("ws_msg:")}
            print("    ws msgs/s:", {k[7:]: round(v / secs, 1) for k, v in wsm.items()},
                  "ws drops:", agg["counters"].get("ws_drop", 0),
                  "ws KB/s:", round(agg["counters"].get("ws_bytes", 0) / secs / 1024, 1), flush=True)
            with open(a.out, "w") as f:
                json.dump(results, f, indent=1, default=str)
            if stop_reason:
                break
            if tot["err_rate"] > a.max_err or tot["p95"] > a.max_p95:
                stop_reason = f"threshold hit at {n} VUs (err {tot['err_rate']*100:.2f}%, p95 {tot['p95']}ms)"
                break
    except KeyboardInterrupt:
        stop_reason = "interrupted"
    finally:
        stopflag.value = 1
        print("\nstopping:", stop_reason or "all stages done", flush=True)
        results["stop_reason"] = stop_reason
        results["ended"] = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(a.out, "w") as f:
            json.dump(results, f, indent=1, default=str)
        drain(None, 5)
        for p in procs:
            p.join(timeout=10)
            if p.is_alive():
                p.terminate()


if __name__ == "__main__":
    main()
