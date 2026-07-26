"""按用户限流、并发闸门、成本上限与结果缓存的单测。
Per-user rate limiting, the concurrency gate, cost caps and result caching."""
import threading
import time

import pytest

from app.core import strategy_limits as sl
from app.core.config import settings
from app.core.security import create_access_token


class _FakeRequest:
    """只提供 key_func 需要的两样东西：headers 与 client.host。
    Supplies only what key_func needs: headers and client.host."""

    class _Client:
        host = "203.0.113.7"

    def __init__(self, authorization=None):
        self.headers = {"Authorization": authorization} if authorization else {}
        self.client = self._Client()


def test_user_rate_key_uses_jwt_subject():
    token = create_access_token("user-abc")
    assert sl.user_rate_key(_FakeRequest(f"Bearer {token}")) == "user:user-abc"


def test_user_rate_key_falls_back_to_ip_without_token():
    assert sl.user_rate_key(_FakeRequest()) == "ip:203.0.113.7"


def test_user_rate_key_falls_back_to_ip_on_invalid_token():
    assert sl.user_rate_key(_FakeRequest("Bearer not-a-real-token")) == "ip:203.0.113.7"


def test_user_rate_key_is_case_insensitive_on_scheme():
    token = create_access_token("user-xyz")
    assert sl.user_rate_key(_FakeRequest(f"bearer {token}")) == "user:user-xyz"


# ---------- 并发闸门 / concurrency gate ----------

def test_gate_rejects_a_second_concurrent_entry_for_same_user():
    with sl.backtest_gate("u1"):
        with pytest.raises(sl.BacktestBusy):
            with sl.backtest_gate("u1"):
                pass


def test_gate_allows_different_users_concurrently():
    with sl.backtest_gate("u1"):
        with sl.backtest_gate("u2"):
            pass


def test_gate_releases_on_exit():
    with sl.backtest_gate("u1"):
        pass
    with sl.backtest_gate("u1"):
        pass


def test_gate_releases_even_when_body_raises():
    with pytest.raises(RuntimeError):
        with sl.backtest_gate("u1"):
            raise RuntimeError("boom")
    with sl.backtest_gate("u1"):
        pass


def test_gate_is_thread_safe():
    """两个线程同时抢同一用户的闸门，只能有一个进入。
    Two threads racing for the same user's gate: exactly one gets in."""
    entered = []
    rejected = []
    start = threading.Event()

    def worker():
        start.wait()
        try:
            with sl.backtest_gate("race-user"):
                entered.append(1)
                time.sleep(0.05)
        except sl.BacktestBusy:
            rejected.append(1)

    threads = [threading.Thread(target=worker) for _ in range(2)]
    for t in threads:
        t.start()
    start.set()
    for t in threads:
        t.join()
    assert len(entered) == 1
    assert len(rejected) == 1


# ---------- 成本上限 / cost cap ----------

def test_cost_units_multiplies_bars_by_conditions():
    assert sl.cost_units(1000, 4) == 4000


def test_within_cap_passes():
    sl.assert_within_cost_cap(1000, 4)


def test_over_cap_raises_with_the_limit_in_the_message():
    with pytest.raises(ValueError) as e:
        sl.assert_within_cost_cap(5001, 12)
    assert str(settings.MAX_BACKTEST_COST_UNITS) in str(e.value)


def test_cap_default_allows_a_realistic_worst_case():
    """5000 根 × 12 条 = 60000 恰在上限内：默认值不该把合法的极端用法挡掉。
    5000 bars x 12 conditions = 60000 sits exactly at the cap: the default
    mustn't reject a legitimate worst case."""
    sl.assert_within_cost_cap(5000, 12)
    with pytest.raises(ValueError):
        sl.assert_within_cost_cap(5001, 12)


# ---------- 结果缓存 / result cache ----------

def _rules():
    return {
        "long": {
            "logic": "AND",
            "children": [
                {
                    "left": {"kind": "price", "field": "close"},
                    "op": "gt",
                    "right": {"kind": "const", "value": 1.0},
                }
            ],
        },
        "short": None,
    }


def test_cache_round_trip():
    sl.cache_clear()
    key = sl.cache_key(_rules(), "XAUUSD", "15", 90, "v1")
    assert sl.cache_get(key) is None
    sl.cache_put(key, {"summary": {"wins": 3}})
    assert sl.cache_get(key)["summary"]["wins"] == 3
    sl.cache_clear()


def test_cache_key_depends_on_every_input():
    base = sl.cache_key(_rules(), "XAUUSD", "15", 90, "v1")
    assert sl.cache_key(_rules(), "EURUSD", "15", 90, "v1") != base
    assert sl.cache_key(_rules(), "XAUUSD", "60", 90, "v1") != base
    assert sl.cache_key(_rules(), "XAUUSD", "15", 30, "v1") != base
    assert sl.cache_key(_rules(), "XAUUSD", "15", 90, "v2") != base
    other = _rules()
    other["long"]["children"][0]["right"]["value"] = 2.0
    assert sl.cache_key(other, "XAUUSD", "15", 90, "v1") != base


def test_cache_key_is_stable_across_dict_ordering():
    """AST 的 key 顺序不同但语义相同时必须命中同一缓存。
    Semantically identical ASTs with differently ordered keys must share a key."""
    a = {"long": {"logic": "AND", "children": [
        {"left": {"kind": "const", "value": 1.0}, "op": "gt", "right": {"kind": "const", "value": 0.0}}
    ]}, "short": None}
    b = {"short": None, "long": {"children": [
        {"op": "gt", "right": {"value": 0.0, "kind": "const"}, "left": {"value": 1.0, "kind": "const"}}
    ], "logic": "AND"}}
    assert sl.cache_key(a, "XAUUSD", "15", 90, "v1") == sl.cache_key(b, "XAUUSD", "15", 90, "v1")


def test_cache_key_includes_extra_parameters():
    base = sl.cache_key(_rules(), "XAUUSD", "15", 90, "v1")
    withextra = sl.cache_key(_rules(), "XAUUSD", "15", 90, "v1", extra={"riskPct": 2.0})
    assert withextra != base


def test_cache_entry_expires(monkeypatch):
    sl.cache_clear()
    monkeypatch.setattr(settings, "BACKTEST_CACHE_TTL_SECONDS", 0)
    key = sl.cache_key(_rules(), "XAUUSD", "15", 90, "v1")
    sl.cache_put(key, {"x": 1})
    assert sl.cache_get(key) is None
    sl.cache_clear()


def test_cache_evicts_oldest_when_full(monkeypatch):
    sl.cache_clear()
    monkeypatch.setattr(settings, "BACKTEST_CACHE_MAX_ENTRIES", 2)
    for i in range(3):
        sl.cache_put(f"k{i}", {"i": i})
    assert sl.cache_get("k0") is None
    assert sl.cache_get("k2")["i"] == 2
    sl.cache_clear()


# ---------- 端点上的限流真的生效 / the limits actually bite on the endpoints ----------

@pytest.fixture()
def _fresh_limiter():
    """限流计数是进程级的，测试前后各清一次，避免与其他测试互相污染。
    Limiter counters are process-global: reset before and after so these tests
    neither inherit nor leak state."""
    sl.user_limiter.reset()
    yield
    sl.user_limiter.reset()


def _backtest_body():
    return {"template": "ma_cross", "symbol": "XAUUSD", "interval": "15", "days": 30}


def test_backtest_endpoint_returns_429_past_the_short_window(client, db, user, auth_headers, _fresh_limiter):
    """短窗口配额 6/minute：第 7 次请求必须拿到 429，而不是照常执行。
    Short window is 6/minute: the 7th request must get a 429, not run anyway."""
    user.plan = "PRO"
    db.commit()
    allowed = int(settings.RATE_LIMIT_BACKTEST_SHORT.split("/")[0])
    for _ in range(allowed):
        res = client.post("/api/strategies/backtest", headers=auth_headers, json=_backtest_body())
        assert res.status_code != 429
    blocked = client.post("/api/strategies/backtest", headers=auth_headers, json=_backtest_body())
    assert blocked.status_code == 429


def test_backtest_limit_is_per_user_not_global(client, db, user, auth_headers, _fresh_limiter):
    """一个用户打满配额，不该影响另一个用户——key 是用户 ID 而不是 IP，两个
    请求来自同一个 TestClient 地址也必须各自计数。
    One user exhausting the quota mustn't affect another: the key is the user id,
    not the IP, even though both requests come from the same TestClient host."""
    from app.core.security import generate_api_token, hash_api_token
    from app.models import User

    user.plan = "PRO"
    other = User(
        email="other@example.com", password_hash="x", plan="PRO",
        api_token=hash_api_token(generate_api_token()),
    )
    db.add(other)
    db.commit()
    other_headers = {"Authorization": f"Bearer {create_access_token(other.id)}"}

    allowed = int(settings.RATE_LIMIT_BACKTEST_SHORT.split("/")[0])
    for _ in range(allowed + 1):
        client.post("/api/strategies/backtest", headers=auth_headers, json=_backtest_body())
    assert client.post("/api/strategies/backtest", headers=auth_headers, json=_backtest_body()).status_code == 429
    assert client.post("/api/strategies/backtest", headers=other_headers, json=_backtest_body()).status_code != 429


def test_strategy_write_endpoints_are_rate_limited(client, db, user, auth_headers, _fresh_limiter):
    """写操作端点（这里用 DELETE /signals）超出 30/minute 后必须 429。
    A write endpoint (DELETE /signals here) must 429 past 30/minute."""
    user.plan = "PRO"
    db.commit()
    allowed = int(settings.RATE_LIMIT_STRATEGY_WRITE.split("/")[0])
    for _ in range(allowed):
        assert client.delete("/api/strategies/signals", headers=auth_headers).status_code != 429
    assert client.delete("/api/strategies/signals", headers=auth_headers).status_code == 429
