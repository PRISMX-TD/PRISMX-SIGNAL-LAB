"""系统状态页「容量」灯（services/capacity.py）。

约定：
1. 峰值按天、按指标各自取最大并记时刻；近 7 天取各天最大，更早的不算；
2. 判定按「当前」与「近 7 天峰值」里大的那个；黄灯 / 红灯阈值来自压测；
3. 每条理由带上要升级什么（advice 代号，去重、有序）；
4. 最近一次「繁忙请重试」：24 小时内红灯、7 天内黄灯；
5. 过载计数先记内存、再刷进共享存储；
6. 「容量」不进整页总灯（红灯是「该排期升级」，不是故障）。

The capacity light: per-metric daily peaks, 7-day window, verdict on max(now, 7-day peak),
advice codes per reason, overload recency, counting via memory then shared state, and
the overall light ignores capacity.
"""
import time

import pytest

from app.services import capacity, shared_state

DAY = 86400


@pytest.fixture(autouse=True)
def _clean_capacity_keys():
    def clear():
        mem = shared_state._memory
        keys = mem.keys(shared_state.PREFIX + "cap:")
        if keys:
            mem.delete(*keys)
        capacity._pending.clear()
        capacity._pending_last = None
        capacity._flushed_at = 0.0

    clear()
    yield
    clear()


def test_daily_peak_keeps_each_metric_max_and_time():
    t0 = 1_791_000_000.0
    capacity.record_sample(100, 5, 40, now=t0)
    capacity.record_sample(80, 9, 50, now=t0 + 60)
    peak = capacity.record_sample(120, 7, 30, now=t0 + 120)
    assert (peak["users"], peak["bridges"], peak["gatewayUsers"]) == (120, 9, 50)
    assert peak["usersAt"] == t0 + 120 and peak["bridgesAt"] == t0 + 60


def test_history_takes_the_7_day_max_and_ignores_older_days():
    now = 1_791_000_000.0
    capacity.record_sample(300, 1, 1, now=now)
    capacity.record_sample(900, 2, 2, now=now - 3 * DAY)
    capacity.record_sample(5000, 3, 3, now=now - 8 * DAY)      # 8 天前：不算 / too old
    h = capacity.read_history(now)
    assert h["peakToday"]["users"] == 300
    assert h["peak7d"]["users"] == 900


@pytest.mark.parametrize("users,level", [(799, "ok"), (800, "warn"), (1199, "warn"), (1200, "down")])
def test_web_user_thresholds(users, level):
    v = capacity.evaluate({"users": users}, {"peak7d": {}})
    assert v["level"] == level
    if level != "ok":
        assert v["advice"][:2] == [capacity.ADVICE_SERVER, capacity.ADVICE_DATABASE]
        assert v["reasons"][0]["code"] == "webUsers" and v["reasons"][0]["value"] == users


def test_judged_on_the_week_peak_not_just_now():
    v = capacity.evaluate({"users": 50}, {"peak7d": {"users": 1300}})
    assert v["level"] == "down" and v["reasons"][0]["value"] == 1300


def test_gateway_and_bridge_reasons_name_what_to_upgrade():
    v = capacity.evaluate({"users": 10, "gatewayUsers": 520, "bridges": 410}, {"peak7d": {}})
    assert v["level"] == "down"
    codes = [r["code"] for r in v["reasons"]]
    assert codes == ["gatewayUsers", "bridges"]
    assert v["advice"] == [capacity.ADVICE_GATEWAY, capacity.ADVICE_SERVER, capacity.ADVICE_BRIDGE], \
        "去重且按出现顺序 / deduplicated, in order"


@pytest.mark.parametrize("ago,level", [(3600, "down"), (3 * DAY, "warn"), (8 * DAY, "ok"), (None, "ok")])
def test_recent_overload(ago, level):
    v = capacity.evaluate({"users": 10}, {"peak7d": {}, "overloadLastAgoSec": ago, "overload7d": 4})
    assert v["level"] == level
    if level != "ok":
        assert capacity.ADVICE_SURGE in v["advice"]


def test_overload_is_counted_then_flushed():
    capacity.note_overload("admission:http")     # 第一次就刷 / the first one flushes
    capacity.note_overload("db_pool")            # 30 秒内：只进内存 / within 30 s: memory only
    capacity.flush_overload()
    h = capacity.read_history(time.time())
    assert h["overload7d"] == 2
    assert h["overloadLastAgoSec"] is not None and h["overloadLastAgoSec"] < 5
    assert h["overloadLastKind"] == "db_pool"


def test_overall_light_ignores_capacity(monkeypatch):
    import asyncio

    from app.services import system_status

    async def fake_db():
        return {"level": "ok"}

    monkeypatch.setattr(system_status, "_database", fake_db)
    monkeypatch.setattr(system_status, "_redis", fake_db)

    async def fake_feed(now):
        return {"level": "ok"}

    monkeypatch.setattr(system_status, "_feed", fake_feed)
    monkeypatch.setattr(system_status, "_db_counts", lambda: {"bridges": 0, "gatewayAccounts": 0})
    monkeypatch.setattr(system_status, "_gateway", lambda now: {"level": "ok"})
    monkeypatch.setattr(system_status, "_capacity", lambda ids, now: {"level": "down"})

    class _App:
        class state:
            background_loops = None

    out = asyncio.run(system_status.collect(_App()))
    assert out["components"]["capacity"]["level"] == "down"
    assert out["overall"] != "down", "容量红灯不该让总灯变红 / capacity must not turn the overall light red"
