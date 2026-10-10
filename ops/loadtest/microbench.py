"""单接口顺序基准：一次只发一个请求，量每个接口自身的服务端耗时（无排队），用于优化前后对比。
Sequential per-endpoint benchmark: one request at a time, so latency ≈ the endpoint's own
server cost (no queueing). Used for before/after comparisons on the local stack.

    python microbench.py --creds creds-local.json --base http://127.0.0.1:8000 --n 200
"""
import argparse
import json
import statistics
import time
import urllib.request


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--creds", required=True)
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--user", type=int, default=5)
    a = ap.parse_args()
    d = json.load(open(a.creds))
    u = d["users"][a.user - 1]
    jwt = {"Authorization": "Bearer " + u["jwt"]}
    bridge = {"X-API-Token": "lt-%s-%d" % (d["token_seed"], u["i"])}
    acct = {"login": str(8800000000 + u["i"]), "server": "MakeCapital-LoadTest", "accountName": "LOADTEST",
            "accountCurrency": "USD", "balance": 10000.0, "equity": 10000.0, "margin": 0.0, "leverage": 100,
            "company": "LoadTest", "detectedSuffix": "", "tradeMode": 0}
    cases = [
        ("GET", "/", None, {}),
        ("GET", "/api/auth/me", None, jwt),
        ("GET", "/api/bootstrap", None, jwt),
        ("GET", "/api/orders", None, jwt),
        ("GET", "/api/orders/winrate", None, jwt),
        ("GET", "/api/signals/winrate", None, jwt),
        ("GET", "/api/announcements/popup", None, jwt),
        ("GET", "/api/notifications/feed?limit=20", None, jwt),
        ("GET", "/api/sentiment", None, jwt),
        ("GET", "/api/symbols", None, jwt),
        ("GET", "/api/bridge/accounts", None, jwt),
        ("GET", "/api/orders/closed-trades", None, jwt),
        ("GET", "/api/chart/latest?symbol=XAUUSD&interval=1", None, jwt),
        ("POST", "/api/bridge/poll(status)", {"accounts": [acct], "bridgeVersion": "1.4.9", "fetchCommands": False}, bridge),
        ("POST", "/api/bridge/poll(cmd,0s)", {"accounts": [acct], "bridgeVersion": "1.4.9", "fetchCommands": True, "waitSeconds": 0}, bridge),
        ("POST", "/api/bridge/positions", {"data": [], "pendingOrders": []}, bridge),
    ]
    print(f"{'endpoint':<46} {'mean':>7} {'p50':>7} {'p95':>7}  (ms, n={a.n})")
    for method, path, body, h in cases:
        url = a.base + path.split("(")[0]
        xs = []
        status = path.startswith("/api/bridge/poll(status)")
        for i in range(min(a.n, 40) if status else a.n):
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(url, data=data, method=method,
                                         headers={**h, **({"Content-Type": "application/json"} if data else {})})
            t = time.perf_counter()
            with urllib.request.urlopen(req, timeout=30) as r:
                r.read()
            xs.append((time.perf_counter() - t) * 1000)
            if status:
                time.sleep(1.5)  # the real status-loop cadence matters for the heartbeat throttle
        xs.sort()
        print(f"{method + ' ' + path:<46} {statistics.mean(xs):7.2f} {xs[len(xs)//2]:7.2f} {xs[int(len(xs)*0.95)]:7.2f}")


if __name__ == "__main__":
    main()
