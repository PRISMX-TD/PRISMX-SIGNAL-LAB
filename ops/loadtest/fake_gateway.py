"""假网关：按真网关（gateway/*.cs）的接口与时序回应，用于本机下单压测，不碰券商。
Fake MT5 gateway for local order load tests — same HTTP contract as gateway/*.cs,
timings modelled on production measurements:

- trade: a short serialized section on the trade connection (_gate, default 1.5 ms —
  what reproduces the README's 2000-orders → 3.3 s local result) followed by the
  dealer round trip (default 155 ms ± 15, measured live 2026-09-24) that runs in
  parallel; at most --max-concurrent requests in flight (http_max_concurrent=256),
  the rest queue like the real dispatcher.
- --dealer-slots N optionally caps how many dealer round trips the *broker* serves at
  once (unknown for the real broker; 0 = unlimited).
- reads go through --read-channels serialized channels (default 2), each read costs
  --read-ms (+ per-login cost for batch calls).

    python fake_gateway.py --port 8899
"""
import argparse
import asyncio
import itertools
import random
import time

from aiohttp import web

ap = argparse.ArgumentParser()
ap.add_argument("--port", type=int, default=8899)
ap.add_argument("--dealer-ms", type=float, default=155)
ap.add_argument("--dealer-jitter", type=float, default=15)
ap.add_argument("--gate-ms", type=float, default=1.5)
ap.add_argument("--dealer-slots", type=int, default=0)
ap.add_argument("--max-concurrent", type=int, default=256)
ap.add_argument("--read-channels", type=int, default=2)
ap.add_argument("--read-ms", type=float, default=40)
ap.add_argument("--read-per-login-ms", type=float, default=2)
A = ap.parse_args()

ticket = itertools.count(500_000_000)
positions: dict[int, dict[int, dict]] = {}   # login -> ticket -> position
idem: dict[tuple, dict] = {}
gate = asyncio.Lock()
dispatch = None
dealer = None
reads = None
stats = {"trades": 0, "reads": 0, "max_inflight": 0, "inflight": 0}


def spin(ms):
    # time.sleep has ~15 ms granularity on Windows; spin for sub-ms accuracy
    end = time.perf_counter() + ms / 1000
    while time.perf_counter() < end:
        pass


async def trade(request, action):
    body = await request.json()
    login = int(body.get("login", 0))
    key = (login, body.get("clientOrderId"), action)
    if key in idem:
        return web.json_response(idem[key] | {"replayed": True})
    t0 = time.perf_counter()
    async with dispatch:
        stats["inflight"] += 1
        stats["max_inflight"] = max(stats["max_inflight"], stats["inflight"])
        try:
            async with gate:
                spin(A.gate_ms)  # account checks + DealerSend under _gate
            d0 = time.perf_counter()
            if dealer is not None:
                async with dealer:
                    await asyncio.sleep(max(0.01, random.gauss(A.dealer_ms, A.dealer_jitter)) / 1000)
            else:
                await asyncio.sleep(max(0.01, random.gauss(A.dealer_ms, A.dealer_jitter)) / 1000)
            dealer_ms = (time.perf_counter() - d0) * 1000
        finally:
            stats["inflight"] -= 1
    stats["trades"] += 1
    t = next(ticket)
    book = positions.setdefault(login, {})
    if action == "open":
        book[t] = {"ticket": t, "symbol": body.get("symbol", ""), "side": body.get("side", "BUY"),
                   "volume": body.get("volume", 0.01), "priceOpen": 1.0, "priceCurrent": 1.0,
                   "stopLoss": 0.0, "takeProfit": 0.0, "profit": 0.0, "comment": "PRISMX"}
    elif action == "close":
        book.pop(int(body.get("ticket", 0) or body.get("position", 0) or 0), None)
    rsp = {"ok": True, "retcode": "DONE", "message": "", "deal": t, "order": t,
           "position": t if action == "open" else int(body.get("ticket", 0) or 0), "price": 1.0,
           "replayed": False, "elapsedMs": int((time.perf_counter() - t0) * 1000), "dealerMs": int(dealer_ms)}
    idem[key] = rsp
    return web.json_response(rsp)


async def read_cost(n_logins=1, batch=False):
    async with reads:
        await asyncio.sleep((A.read_ms + (A.read_per_login_ms * n_logins if batch else 0)) / 1000)
    stats["reads"] += 1


def acct(login):
    return {"ok": True, "login": login, "name": "LOADTEST", "group": "demo\\loadtest", "leverage": 100,
            "balance": 10000.0, "equity": 10000.0, "margin": 0.0, "marginFree": 10000.0, "lastPassChange": 1}


async def health(_):
    return web.json_response({"ok": True, "mt5Connected": True, "dealerActive": True, "batchSupported": True,
                              "readChannelsConnected": A.read_channels, **stats})


async def single_read(request, kind):
    body = await request.json()
    login = int(body.get("login", 0))
    await read_cost()
    if kind == "account":
        return web.json_response(acct(login))
    if kind == "positions":
        return web.json_response({"ok": True, "positions": list(positions.get(login, {}).values())})
    if kind == "orders":
        return web.json_response({"ok": True, "orders": []})
    return web.json_response({"ok": True, "deals": []})


async def batch_read(request, kind):
    body = await request.json()
    logins = [int(x) for x in str(body.get("logins", "")).split(",") if x]
    await read_cost(len(logins), batch=True)
    res = []
    for lg in logins:
        if kind == "accounts":
            res.append(acct(lg))
        elif kind == "positions":
            res.append({"ok": True, "login": lg, "positions": list(positions.get(lg, {}).values())})
        else:
            res.append({"ok": True, "login": lg, "deals": []})
    return web.json_response({"ok": True, "results": res})


async def events(_):
    return web.json_response({"ok": True, "subscribed": True, "events": []})


async def trade_result(request):
    return web.json_response({"ok": True, "status": "not_found"})


async def on_start(app):
    global dispatch, dealer, reads
    dispatch = asyncio.Semaphore(A.max_concurrent)
    dealer = asyncio.Semaphore(A.dealer_slots) if A.dealer_slots > 0 else None
    reads = asyncio.Semaphore(A.read_channels)


app = web.Application(client_max_size=64 * 1024)
app.on_startup.append(on_start)
app.router.add_get("/health", health)
for act in ("open", "pending", "close", "modify", "modify-pending", "cancel"):
    app.router.add_post(f"/trade/{act}", lambda r, a=act: trade(r, a))
app.router.add_get("/trade/result", trade_result)
for k in ("account", "positions", "orders", "deals"):
    app.router.add_post(f"/{k}", lambda r, k=k: single_read(r, k))
for k in ("accounts", "positions", "deals"):
    app.router.add_post(f"/{k}-batch", lambda r, k=k: batch_read(r, k))
app.router.add_get("/position-events", events)
app.router.add_get("/deal-events", events)

if __name__ == "__main__":
    web.run_app(app, host="127.0.0.1", port=A.port, access_log=None, print=None)
