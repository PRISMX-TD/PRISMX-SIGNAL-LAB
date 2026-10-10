"""模拟 EA 行情源（本机压测用）：每 0.5 秒推一次全部品种的变化报价（工作日 EA 的最快节奏），
每 3 秒推一次形成中的 1 分钟 K 线，让本机后端的 WS 行情扇出与生产一致。
Simulated EA market feed for local load tests: a changed quote for every symbol each
0.5 s (the EA's weekday ceiling, InpQuoteIntervalMs=500) and the forming 1-minute bar
every 3 s, so the local backend's WS fan-out matches production.

    python fake_feed.py --base http://127.0.0.1:8000 --token <EA_TOKEN>
"""
import argparse
import json
import random
import time
import urllib.request

SYMS = {"XAUUSD": (2650.0, 2), "XAGUSD": (31.0, 3), "WTI": (71.0, 2), "EURUSD": (1.08, 5),
        "GBPUSD": (1.29, 5), "USDJPY": (149.0, 3), "BTCUSD": (62000.0, 2)}


def post(base, path, token, body):
    req = urllib.request.Request(base + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "X-EA-Token": token})
    urllib.request.urlopen(req, timeout=5).read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--token", required=True)
    ap.add_argument("--quote-ms", type=int, default=500)
    a = ap.parse_args()
    px = {s: p for s, (p, _) in SYMS.items()}
    bars = {}
    last_candle = 0.0
    while True:
        t0 = time.time()
        data = []
        for s, (_, d) in SYMS.items():
            px[s] *= 1 + random.gauss(0, 0.0002)
            bid = round(px[s], d)
            data.append({"symbol": s, "bid": bid, "ask": round(bid * 1.0001, d), "digits": d})
            bt = int(t0 // 60 * 60)
            b = bars.get(s)
            if b is None or b["t"] != bt:
                b = bars[s] = {"t": bt, "o": bid, "h": bid, "l": bid, "c": bid, "v": 0}
            b["h"], b["l"], b["c"] = max(b["h"], bid), min(b["l"], bid), bid
            b["v"] += 1
        try:
            post(a.base, "/api/feed/quotes", a.token, {"data": data})
            if t0 - last_candle >= 3:
                post(a.base, "/api/feed/candles", a.token, {
                    "mode": "tick",
                    "series": [{"symbol": s, "interval": "1", "bars": [bars[s]]} for s in SYMS]})
                last_candle = t0
        except Exception as e:
            print("feed error:", e, flush=True)
        time.sleep(max(0.0, a.quote_ms / 1000 - (time.time() - t0)))


if __name__ == "__main__":
    main()
