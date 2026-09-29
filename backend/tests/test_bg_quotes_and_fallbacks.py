"""后台降频 + Redis 抖动兜底的回归用例。"""
import asyncio
from types import SimpleNamespace

from app.services import net_quality, quotes_store, shared_state
from app.services.connection_manager import ConnectionManager
from app.services.deps import ONLINE_WINDOW


class FakeWS:
    def __init__(self):
        self.sent = []

    async def send_text(self, text):
        self.sent.append(text)


def test_online_window_is_10_and_covers_heartbeat_cadence():
    assert ONLINE_WINDOW == 10
    assert 3.0 * 3 < ONLINE_WINDOW + 0.5  # ~3s heartbeat, three beats of slack


def test_parse_ping_without_rtt_jit_for_bg_ping():
    assert net_quality.parse_ping({"type": "PING", "bg": True}) == (None, None, "web")


def test_background_connection_skips_quote_frames_only():
    async def scenario():
        mgr = ConnectionManager()
        fg, bg = FakeWS(), FakeWS()
        await mgr.register_client("u1", fg)
        await mgr.register_client("u1", bg)
        mgr.set_background(bg, True)
        await mgr.broadcast_to_clients({"type": "GLOBAL_QUOTES", "data": [1]})
        await mgr._deliver_local("u1", {"type": "QUOTES", "data": [2]})
        await mgr.broadcast_to_clients({"type": "POSITIONS", "data": [3]})
        assert len(fg.sent) == 3 and len(bg.sent) == 1 and '"POSITIONS"' in bg.sent[0]
        # back to foreground: quotes flow again
        mgr.set_background(bg, False)
        await mgr.broadcast_to_clients({"type": "GLOBAL_QUOTES", "data": [4]})
        assert len(bg.sent) == 2
        # disconnect clears the flag
        mgr.set_background(bg, True)
        await mgr.unregister_client("u1", bg)
        assert bg not in mgr._background
        await mgr.unregister_client("u1", fg)

    asyncio.run(scenario())


def test_incr_throttle_error_skips_refresh(monkeypatch):
    from app.services.gamification import competitions as c

    def boom(*a, **k):
        raise RuntimeError("redis down")

    def not_called(*a, **k):
        raise AssertionError("snapshot must not run")

    monkeypatch.setattr(shared_state, "incr_with_ttl", boom)
    monkeypatch.setattr(c, "_snapshot_one_comp", not_called)
    assert c.refresh_comp_board(None, SimpleNamespace(status="running", id=1)) is False


def test_quotes_and_symbols_fall_back_to_last_good(monkeypatch):
    quotes_store._last_good.update({"all": [], "active": []})
    monkeypatch.setattr(quotes_store, "get_all", lambda: [{"symbol": "A"}])
    monkeypatch.setattr(quotes_store, "get_active_symbols", lambda: ["A"])
    assert asyncio.run(quotes_store.get_all_async()) == [{"symbol": "A"}]
    assert asyncio.run(quotes_store.get_active_symbols_async()) == ["A"]

    def boom():
        raise RuntimeError("redis down")

    monkeypatch.setattr(quotes_store, "get_all", boom)
    monkeypatch.setattr(quotes_store, "get_active_symbols", boom)
    assert asyncio.run(quotes_store.get_all_async()) == [{"symbol": "A"}]
    assert asyncio.run(quotes_store.get_active_symbols_async()) == ["A"]
    quotes_store._last_good.update({"all": [], "active": []})
    assert asyncio.run(quotes_store.get_all_async()) == []
    assert asyncio.run(quotes_store.get_active_symbols_async()) == []
