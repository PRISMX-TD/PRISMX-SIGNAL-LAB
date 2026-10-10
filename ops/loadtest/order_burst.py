"""「信号一发大家一起跟」：N 个在线用户（各开 WS，网关账号被后台持仓循环轮询）同一瞬间下单，
再同一瞬间平仓，量每一笔从点下去到拿到结果的时间。只对本机环境用。
Simultaneous-order bursts: N online users (WS open, gateway accounts polled by the
positions loop) all place a market order at the same instant, then all close it.
Local stack only — the backend talks to fake_gateway.py, never a broker.

    python order_burst.py --creds creds-local.json --base http://127.0.0.1:8000 --bursts 10,30,100,300,1000
"""
import argparse
import asyncio
import json
import time
import uuid

import aiohttp


def pct(xs, p):
    if not xs:
        return 0
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


class Online:
    """Keep one WS per user open (AUTH + PING), record ORDER_UPDATE arrival times."""

    def __init__(self, base, user, sess):
        self.url = base.replace("http", "ws", 1) + "/ws/client"
        self.user, self.sess = user, sess
        self.updates = {}  # clientOrderId -> first time a terminal ORDER_UPDATE arrived
        self.ready = asyncio.Event()

    async def run(self):
        while True:
            try:
                async with self.sess.ws_connect(self.url, heartbeat=None, max_msg_size=8 << 20) as ws:
                    await ws.send_str(json.dumps({"type": "AUTH", "token": self.user["jwt"]}))
                    last = 0.0
                    while True:
                        if time.monotonic() - last > 5:
                            await ws.send_str('{"type":"PING"}')
                            last = time.monotonic()
                        try:
                            msg = await ws.receive(timeout=1)
                        except asyncio.TimeoutError:
                            continue
                        if msg.type != aiohttp.WSMsgType.TEXT:
                            break
                        d = json.loads(msg.data)
                        if d.get("type") == "AUTH_OK":
                            self.ready.set()
                        elif d.get("type") == "ORDER_UPDATE":
                            o = d.get("data") or d.get("order") or d
                            cid = o.get("clientOrderId")
                            if cid and o.get("status") not in ("PENDING", None) and cid not in self.updates:
                                self.updates[cid] = time.perf_counter()
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
            await asyncio.sleep(1)


async def one(sess, base, user, path, body):
    t = time.perf_counter()
    try:
        async with sess.post(base + path, json=body, headers={"Authorization": "Bearer " + user["jwt"]},
                             timeout=aiohttp.ClientTimeout(total=120)) as r:
            data = await r.json(content_type=None)
            st = r.status
    except Exception as e:
        data, st = {}, type(e).__name__
    return t, time.perf_counter(), st, data


async def burst(sess, base, users, onl, kind, tickets):
    jobs = []
    cids = []
    for u in users:
        cid = "lt-" + uuid.uuid4().hex[:20]
        cids.append(cid)
        if kind == "open":
            body = {"symbol": "XAUUSD", "side": "BUY", "volume": 0.01, "clientOrderId": cid, "mt5Login": u["login"]}
            jobs.append(one(sess, base, u, "/api/orders", body))
        else:
            body = {"clientOrderId": cid, "ticket": tickets[u["i"]], "symbol": "XAUUSD", "side": "BUY",
                    "mt5Login": u["login"]}
            jobs.append(one(sess, base, u, "/api/orders/close", body))
    t0 = time.perf_counter()
    res = await asyncio.gather(*jobs)
    wall = time.perf_counter() - t0
    await asyncio.sleep(3)  # let WS updates land
    http_ms, ws_ms, statuses = [], [], {}
    for (ts, te, st, data), cid, u in zip(res, cids, users):
        key = st if st != 200 else (data.get("status") if isinstance(data, dict) else "?")
        statuses[str(key)] = statuses.get(str(key), 0) + 1
        http_ms.append((te - t0) * 1000)
        w = onl[u["i"]].updates.get(cid)
        if w:
            ws_ms.append((w - t0) * 1000)
        if kind == "open" and isinstance(data, dict):
            # fake_gateway uses one number for order / deal / position, so mt5Ticket is the position
            tk = data.get("mt5Ticket")
            if tk:
                tickets[u["i"]] = int(tk)
    return {"n": len(users), "wall_s": round(wall, 2), "statuses": statuses,
            "http_p50": round(pct(http_ms, 50)), "http_p95": round(pct(http_ms, 95)),
            "http_max": round(max(http_ms)), "ws_seen": len(ws_ms),
            "ws_p50": round(pct(ws_ms, 50)), "ws_p95": round(pct(ws_ms, 95)),
            "ws_max": round(max(ws_ms)) if ws_ms else None,
            "orders_per_s": round(len(users) / wall, 1)}


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--creds", required=True)
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--bursts", default="10,30,100,300,1000")
    ap.add_argument("--online", type=int, default=0, help="users kept online on WS (default = largest burst)")
    ap.add_argument("--out", default="orders.json")
    a = ap.parse_args()
    users = json.load(open(a.creds))["users"]
    bursts = [int(x) for x in a.bursts.split(",")]
    n_online = min(len(users), a.online or max(bursts))
    conn = aiohttp.TCPConnector(limit=0)
    async with aiohttp.ClientSession(connector=conn) as sess:
        onl = {u["i"]: Online(a.base, u, sess) for u in users[:n_online]}
        tasks = [asyncio.create_task(o.run()) for o in onl.values()]
        await asyncio.wait_for(asyncio.gather(*(o.ready.wait() for o in onl.values())), 120)
        print(f"{n_online} users online on WS; waiting 15s for the positions loop to settle", flush=True)
        await asyncio.sleep(15)
        results = []
        for n in bursts:
            group = users[:n]
            tickets = {}
            r_open = await burst(sess, a.base, group, onl, "open", tickets)
            print(f"OPEN  x{n:<5} {r_open}", flush=True)
            await asyncio.sleep(5)
            group_c = [u for u in group if u["i"] in tickets]
            r_close = await burst(sess, a.base, group_c, onl, "close", tickets) if group_c else None
            print(f"CLOSE x{len(group_c):<5} {r_close}", flush=True)
            results.append({"burst": n, "open": r_open, "close": r_close})
            json.dump(results, open(a.out, "w"), indent=1)
            await asyncio.sleep(10)
        for t in tasks:
            t.cancel()


if __name__ == "__main__":
    asyncio.run(main())
