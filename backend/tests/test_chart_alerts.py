"""图表警报（rev 56）：条件判定、画线几何、指标与前端对拍、接口、逐跳与收盘触发。
Chart alerts (rev 56): condition tests, drawing geometry, indicator parity with the frontend, the
API, and firing on ticks and at bar close."""
import asyncio
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.core.database as db_mod
from app.models import Candle, ChartAlert, ChartAlertLog, User, UserNotification
from app.routers import chart_alerts as router_mod
from app.services.chart_alerts import conds as C
from app.services.chart_alerts import engine as E
from app.services.chart_alerts import ind as IND


# ───────── 纯函数 / pure functions ─────────

def test_line_conditions():
    assert C.check_line("crossUp", 99, 100, 100, 100)
    assert C.check_line("crossUp", 99, 100, 101, 100)
    assert not C.check_line("crossUp", 100, 100, 101, 100)  # 从线上出发不算 / starting on the line
    assert C.check_line("crossDown", 101, 100, 100, 100)
    assert C.check_line("cross", 101, 100, 99, 100)
    assert not C.check_line("cross", None, None, 99, 100)
    assert C.check_line("gt", None, None, 101, 100)
    assert not C.check_line("lt", None, None, 101, 100)
    # 线在动：价格不动，线从下面上来穿过价格 = 价格下穿线 / a rising line passing a still price
    assert C.check_line("crossDown", 100, 99, 100, 101)


def test_channel_and_move():
    band = (95.0, 105.0)
    assert C.check_channel("enter", 90, band, 96, band)
    assert not C.check_channel("enter", 96, band, 97, band)
    assert C.check_channel("exit", 100, band, 106, band)
    assert C.check_channel("inside", None, None, 100, band)
    assert C.check_channel("outside", None, None, 94, band)
    assert C.check_move("moveUp", 100, 103, 3)
    assert not C.check_move("moveUp", 100, 102.9, 3)
    assert C.check_move("moveDownPct", 100, 98, 2)
    assert not C.check_move("moveUpPct", None, 98, 2)


def test_open_time_skips_weekends():
    # 2026-11-20 是周五 / a Friday
    fri20 = datetime(2026, 11, 20, 20, 0, tzinfo=timezone.utc).timestamp()
    sun22 = datetime(2026, 11, 22, 22, 0, tzinfo=timezone.utc).timestamp()
    # 周五 20:00 → 周日 22:00 实际开市 2 小时 / two open hours across the weekend
    assert C.open_time(sun22, "XAUUSD") - C.open_time(fri20, "XAUUSD") == pytest.approx(7200)
    assert C.open_time(sun22, "BTCUSD") - C.open_time(fri20, "BTCUSD") == pytest.approx(sun22 - fri20)
    # 线：周五 20:00 价 100、21:00 价 101，延长到周日 22:00 应是 102（又一小时），不是多走 48 小时
    fri21 = fri20 + 3600
    line = {"t1": fri20, "p1": 100.0, "t2": fri21, "p2": 101.0, "extL": False, "extR": True}
    assert C.line_value(line, sun22, "XAUUSD") == pytest.approx(102.0)
    assert C.line_value(dict(line, extR=False), sun22, "XAUUSD") is None
    assert C.line_value(line, fri20 - 60, "XAUUSD") is None
    flat = {"t1": fri20, "p1": 100.0, "t2": fri20, "p2": 100.0, "extL": True, "extR": True}
    assert C.line_value(flat, sun22, "XAUUSD") == 100.0



def _utc(*a):
    return datetime(*a, tzinfo=timezone.utc).timestamp()


def test_open_time_weekend_follows_us_dst():
    """冬令时周五 21:00–22:00 UTC 仍在交易；夏令时 21:00 收盘；切换周末休 47 / 49 小时。
    Winter Friday 21:00-22:00 UTC still trades; summer closes at 21:00; switch weekends."""
    ot = C.open_time
    # 冬令时（2026-11-20 周五）：21:00→22:00 一整小时开市，22:00 之后到周日 22:00 不计
    assert ot(_utc(2026, 11, 20, 22), "EURUSD") - ot(_utc(2026, 11, 20, 21), "EURUSD") == pytest.approx(3600)
    assert ot(_utc(2026, 11, 22, 22), "EURUSD") == pytest.approx(ot(_utc(2026, 11, 20, 22), "EURUSD"))
    assert ot(_utc(2026, 11, 22, 21, 30), "EURUSD") == pytest.approx(ot(_utc(2026, 11, 21, 12), "EURUSD"))
    # 夏令时（2026-07-17 周五）：21:00 收盘、周日 21:00 开盘
    assert ot(_utc(2026, 7, 17, 22), "EURUSD") == pytest.approx(ot(_utc(2026, 7, 17, 21), "EURUSD"))
    assert ot(_utc(2026, 7, 19, 22), "EURUSD") - ot(_utc(2026, 7, 17, 20), "EURUSD") == pytest.approx(7200)
    # 春季切换周末（2026-03-08 周日起夏令时）：周五 22:00 收、周日 21:00 开 → 休 47 小时
    fri, sun = _utc(2026, 3, 6, 22), _utc(2026, 3, 8, 21)
    assert sun - fri == 47 * 3600
    assert ot(sun, "EURUSD") == pytest.approx(ot(fri, "EURUSD"))
    assert ot(sun + 600, "EURUSD") - ot(fri - 600, "EURUSD") == pytest.approx(1200)
    # 秋季切换周末（2026-11-01 周日起冬令时）：周五 21:00 收、周日 22:00 开 → 休 49 小时
    fri, sun = _utc(2026, 10, 30, 21), _utc(2026, 11, 1, 22)
    assert ot(sun, "EURUSD") == pytest.approx(ot(fri, "EURUSD"))
    assert ot(sun + 600, "EURUSD") - ot(fri - 600, "EURUSD") == pytest.approx(1200)
    # 单调不减（按 10 分钟扫两个切换周期）/ monotonic across both switches
    prev = None
    for start in (_utc(2026, 3, 5), _utc(2026, 10, 29)):
        for k in range(0, 5 * 86400, 600):
            v = ot(start + k, "EURUSD")
            assert prev is None or v >= prev - 1e-6
            prev = v
        prev = None


def test_open_time_agrees_with_candle_gate():
    """开市秒数在休市段内不走，与 candle_store 的周末闸门逐 10 分钟一致。
    The open-seconds axis is flat exactly where candle_store's weekend gate says closed."""
    from app.services.candle_store import is_weekend_closed

    for start in (_utc(2026, 3, 5), _utc(2026, 7, 16), _utc(2026, 10, 29), _utc(2026, 11, 19)):
        for k in range(0, 5 * 86400, 600):
            t = start + k
            moved = C.open_time(t + 600, "EURUSD") - C.open_time(t, "EURUSD")
            assert (moved == pytest.approx(0)) == is_weekend_closed(t, "EURUSD"), t


def test_broker_offset_and_bar_start():
    winter = datetime(2026, 1, 15, 12, tzinfo=timezone.utc).timestamp()
    summer = datetime(2026, 7, 15, 12, tzinfo=timezone.utc).timestamp()
    assert E.broker_offset(winter) == 7200
    assert E.broker_offset(summer) == 10800
    # 2026 美国夏令时：3 月 8 日 07:00 UTC 起，11 月 1 日 06:00 UTC 止
    assert E.broker_offset(datetime(2026, 3, 8, 6, 59, tzinfo=timezone.utc).timestamp()) == 7200
    assert E.broker_offset(datetime(2026, 3, 8, 7, 0, tzinfo=timezone.utc).timestamp()) == 10800
    assert E.broker_offset(datetime(2026, 11, 1, 6, 0, tzinfo=timezone.utc).timestamp()) == 7200
    # 日线在券商零点开（冬令时 22:00 UTC）/ daily bars open at broker midnight
    t = datetime(2026, 1, 15, 23, 30, tzinfo=timezone.utc).timestamp()
    assert E.bar_start("D", t) == datetime(2026, 1, 15, 22, 0, tzinfo=timezone.utc).timestamp()
    assert E.bar_start("15", t) == datetime(2026, 1, 15, 23, 30, tzinfo=timezone.utc).timestamp()


def test_spec_validation():
    with pytest.raises(C.SpecError):
        C.clean_spec("price", "cross", {"level": float("nan")})
    with pytest.raises(C.SpecError):
        C.clean_spec("price", "enter", {"level": 1})
    assert C.clean_spec("price", "enter", {"lo": 5, "hi": 3, "junk": 1}) == {"lo": 3.0, "hi": 5.0}
    with pytest.raises(C.SpecError):
        C.clean_spec("drawing", "enter", {"lines": [{"t1": 1, "p1": 1, "t2": 2, "p2": 2}]})
    with pytest.raises(C.SpecError):
        C.clean_spec("indicator", "cross", {"ind": {"type": "ichimoku", "plot": "conv"}, "target": {"kind": "value", "v": 1}})
    s = C.clean_spec("indicator", "crossUp", {"ind": {"type": "rsi", "inputs": {"len": 9}, "plot": "rsi"}, "target": {"kind": "value", "v": 70}})
    assert s["ind"]["inputs"] == {"len": 9, "src": "close"}
    with pytest.raises(C.SpecError):
        C.clean_spec("indicator", "cross", {"ind": {"type": "macd", "plot": "macd"}, "target": {"kind": "plot", "plot": "macd"}})
    with pytest.raises(C.SpecError):
        C.clean_spec("indicator", "cross", {"ind": {"type": "rsi", "inputs": {"src": "ind:x:y"}, "plot": "rsi"}, "target": {"kind": "price"}})


def test_indicator_parity_with_frontend():
    """前端 computeAll 算出来的数（tests/fixtures/chart_alert_ind_parity.json）逐点对上。
    Every point matches the frontend's computeAll output."""
    data = json.loads((Path(__file__).parent / "fixtures" / "chart_alert_ind_parity.json").read_text(encoding="utf-8"))
    bars = data["bars"]
    assert len(data["cases"]) >= 25
    for case in data["cases"]:
        typ = case["type"]
        _t, inputs, _p = IND.clean(typ, case["inputs"], next(iter(case["plots"])))
        for plot, expected in case["plots"].items():
            got = IND.DEFS[typ]["f"](bars, inputs)[plot]
            assert len(got) == len(expected), (typ, plot)
            for i, (g, e) in enumerate(zip(got, expected)):
                if e is None:
                    assert g is None, (typ, plot, i, g)
                else:
                    assert g is not None and math.isclose(g, e, rel_tol=1e-12, abs_tol=1e-9), (typ, plot, i, g, e)
            # 平移：前端第 i 根显示 out[i - offset] / offset shift
            off = case["offset"]
            shifted = IND.series(typ, inputs, plot, bars)
            for i in range(len(bars)):
                j = i - off
                want = expected[j] if 0 <= j < len(bars) else None
                assert (shifted[i] is None) == (want is None), (typ, plot, i)


# ───────── 库与接口 / DB and API ─────────

@pytest.fixture()
def env(monkeypatch):
    from app.core.database import Base
    import app.models  # noqa: F401

    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False)
    monkeypatch.setattr(db_mod, "SessionLocal", Session)
    E.reset_for_tests()
    sent: list[tuple[str, dict]] = []

    async def _push(user_id, message):
        sent.append((user_id, message))

    from app.services.connection_manager import manager

    monkeypatch.setattr(manager, "push_to_client", _push)
    pushes: list[tuple] = []
    from app.services import push_dispatch

    monkeypatch.setattr(push_dispatch, "dispatch_users_push", lambda *a, **k: pushes.append(a))
    mails: list[tuple] = []
    from app.services import mailer

    monkeypatch.setattr(mailer, "send_email", lambda *a, **k: mails.append(a) or True)
    db = Session()
    a = User(email="a@t.co", api_token="tok_a", email_verified_at=datetime.now(timezone.utc))
    b = User(email="b@t.co", api_token="tok_b")
    db.add_all([a, b])
    db.commit()
    yield {"db": db, "Session": Session, "a": a, "b": b, "ws": sent, "push": pushes, "mail": mails}
    db.close()
    engine.dispose()
    E.reset_for_tests()


@pytest.fixture()
def client(env, monkeypatch):
    from fastapi.testclient import TestClient

    from app.core.database import get_db
    from app.main import app
    from app.services.deps import get_current_user_id_light

    who = {"id": env["a"].id}

    def _db():
        s = env["Session"]()
        try:
            yield s
        finally:
            s.close()

    app.dependency_overrides[get_db] = _db
    app.dependency_overrides[get_current_user_id_light] = lambda: who["id"]
    # 不用 with：那样会跑 lifespan（捕获主事件循环等全局状态），测完循环关了会连累后面的测试
    # No `with`: that runs the lifespan (captures the main loop and other globals), and the closed
    # loop would break later tests
    c = TestClient(app)
    c.who = who
    yield c
    app.dependency_overrides.clear()


def _body(**over):
    b = {"symbol": "xauusd", "kind": "price", "cond": "crossUp", "spec": {"level": 2700, "ref": 2690},
         "trigger": "once", "interval": "15", "message": "XAUUSD 上穿 2700", "push": True, "email": False}
    b.update(over)
    return b


def test_api_crud_and_isolation(client, env):
    r = client.post("/api/chart/alerts", json=_body())
    assert r.status_code == 200, r.text
    a = r.json()
    assert a["symbol"] == "XAUUSD" and a["status"] == "active" and a["spec"] == {"level": 2700.0, "ref": 2690.0}
    assert any(m["type"] == "CHART_ALERTS_UPDATE" for _u, m in env["ws"])
    assert len(client.get("/api/chart/alerts").json()["alerts"]) == 1

    r = client.put(f"/api/chart/alerts/{a['id']}", json=_body(spec={"level": 2710}, active=False))
    assert r.status_code == 200 and r.json()["status"] == "paused" and r.json()["spec"]["level"] == 2710
    row = env["db"].get(ChartAlert, a["id"])
    env["db"].refresh(row)
    assert row.seq == 1

    client.who["id"] = env["b"].id
    assert client.get("/api/chart/alerts").json()["alerts"] == []
    assert client.put(f"/api/chart/alerts/{a['id']}", json=_body()).status_code == 404
    assert client.delete(f"/api/chart/alerts/{a['id']}").status_code == 404
    client.who["id"] = env["a"].id
    assert client.delete(f"/api/chart/alerts/{a['id']}").status_code == 200
    assert client.get("/api/chart/alerts").json()["alerts"] == []


def test_api_validation(client):
    assert client.post("/api/chart/alerts", json=_body(symbol="bad sym")).status_code == 422
    assert client.post("/api/chart/alerts", json=_body(interval="30")).status_code == 422
    assert client.post("/api/chart/alerts", json=_body(cond="nope")).status_code == 422
    assert client.post("/api/chart/alerts", json=_body(kind="drawing", spec={"lines": [{"t1": 1, "p1": 1, "t2": 2, "p2": 2}]})).status_code == 422
    past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
    assert client.post("/api/chart/alerts", json=_body(expiresAt=past)).status_code == 422
    # 指标警报的「每根 K 线一次」归为「每次收盘」/ indicator 'bar' becomes 'close'
    r = client.post("/api/chart/alerts", json=_body(kind="indicator", cond="crossUp", trigger="bar",
                                                    spec={"ind": {"type": "rsi", "plot": "rsi"}, "target": {"kind": "value", "v": 70}}))
    assert r.status_code == 200 and r.json()["trigger"] == "close"


def test_api_bulk_delete_and_cap(client, env, monkeypatch):
    monkeypatch.setattr(router_mod, "ALERTS_MAX", 2)
    ids = [client.post("/api/chart/alerts", json=_body()).json()["id"] for _ in range(2)]
    assert client.post("/api/chart/alerts", json=_body()).status_code == 422
    assert client.post("/api/chart/alerts/delete", json={"ids": ids + ["nope"]}).json() == {"deleted": 2}


# ───────── 触发 / firing ─────────

def _add(env, **over) -> ChartAlert:
    values = dict(user_id=env["a"].id, symbol="XAUUSD", kind="price", cond="crossUp",
                  spec=json.dumps({"level": 2700}), trigger="once", interval="15", message="m",
                  notify_push=True, notify_email=False, status="active", seq=0, fire_count=0,
                  created_at=datetime.now(timezone.utc), updated_at=datetime.now(timezone.utc))
    values.update(over)
    row = ChartAlert(**values)
    env["db"].add(row)
    env["db"].commit()
    return row


def _ticks(*prices, symbol="XAUUSD"):
    async def run():
        for p in prices:
            await E.on_quotes([{"symbol": symbol, "bid": p, "ask": p + 0.2}])
            await asyncio.gather(*list(E._tasks))
    asyncio.run(run())


def test_once_alert_fires_once_and_notifies(env):
    row = _add(env)
    _ticks(2695, 2699, 2701, 2699, 2702)
    db = env["Session"]()
    row = db.get(ChartAlert, row.id)
    assert row.status == "fired" and row.fire_count == 1 and row.seq == 1
    log = db.query(ChartAlertLog).all()
    assert len(log) == 1 and log[0].price == 2701
    notes = db.query(UserNotification).all()
    assert len(notes) == 1 and notes[0].kind == "chart_alert" and notes[0].link == "/charts?symbol=XAUUSD"
    fired = [m for _u, m in env["ws"] if m["type"] == "CHART_ALERT_FIRED"]
    assert len(fired) == 1 and fired[0]["data"]["status"] == "fired"
    assert len(env["push"]) == 1 and env["push"][0][1] == "chart_alert"
    assert env["mail"] == []


def test_ref_catches_a_cross_on_the_first_tick(env):
    _add(env, spec=json.dumps({"level": 2700, "ref": 2690}))
    _ticks(2705)
    assert env["Session"]().query(ChartAlertLog).count() == 1


def test_without_ref_the_first_tick_only_records(env):
    _add(env)
    _ticks(2705)
    assert env["Session"]().query(ChartAlertLog).count() == 0


def test_bar_trigger_once_per_bar(env, monkeypatch):
    _add(env, cond="gt", trigger="bar", interval="15")
    t0 = datetime(2026, 11, 24, 10, 0, 5, tzinfo=timezone.utc).timestamp()
    clock = {"t": t0}
    monkeypatch.setattr(E.time, "time", lambda: clock["t"])
    _ticks(2701)
    clock["t"] = t0 + 60
    _ticks(2702)
    clock["t"] = t0 + 15 * 60
    _ticks(2703)
    db = env["Session"]()
    assert db.query(ChartAlertLog).count() == 2
    assert db.query(ChartAlert).one().status == "active"


def test_paused_expired_and_closed_quotes_do_not_fire(env):
    _add(env, status="paused", spec=json.dumps({"level": 2700, "ref": 2690}))
    _add(env, spec=json.dumps({"level": 2700, "ref": 2690}), expires_at=datetime.now(timezone.utc) - timedelta(minutes=1))
    async def closed():
        await E.on_quotes([{"symbol": "XAUUSD", "bid": 2705, "ask": 2705.2, "closed": True}])
    asyncio.run(closed())
    _ticks(2705)
    db = env["Session"]()
    assert db.query(ChartAlertLog).count() == 0
    assert sorted(r.status for r in db.query(ChartAlert).all()) == ["expired", "paused"]


def test_edit_reloads_the_cache(env):
    row = _add(env, spec=json.dumps({"level": 2800}))
    _ticks(2690, 2710)
    assert env["Session"]().query(ChartAlertLog).count() == 0
    db = env["Session"]()
    r = db.get(ChartAlert, row.id)
    r.spec, r.seq = json.dumps({"level": 2700, "ref": 2690}), 1
    db.commit()
    E.bump()
    _ticks(2705)
    assert env["Session"]().query(ChartAlertLog).count() == 1


def test_race_between_workers_notifies_once(env):
    row = _add(env, cond="gt", trigger="bar")
    rec = E._rec_of(env["Session"]().get(ChartAlert, row.id))
    now = datetime.now(timezone.utc).timestamp()
    assert E._fire_sync(rec, 2701, now) is not None
    assert E._fire_sync(rec, 2701, now) is None  # 同一个 seq 第二次抢不到 / same seq loses


def test_drawing_trendline_alert(env):
    now = datetime.now(timezone.utc).timestamp()
    line = {"t1": now - 7200, "p1": 2690.0, "t2": now - 3600, "p2": 2695.0, "extL": False, "extR": True}
    _add(env, kind="drawing", cond="cross", drawing_id="d1", spec=json.dumps({"lines": [line]}))
    # 线此刻约在 2700 / the line is near 2700 now
    _ticks(2695, 2706)
    assert env["Session"]().query(ChartAlertLog).count() == 1


def test_line_value_reversed_points_keep_extension_side():
    # 第一点在右：extL 延长的是第一点那头（时间上的右边）/ first point on the right: extL extends past it (later in time)
    line = {"t1": 2000.0, "p1": 20.0, "t2": 1000.0, "p2": 10.0, "extL": True, "extR": False}
    assert C.line_value(line, 3000.0, "BTCUSD") == pytest.approx(30.0)
    assert C.line_value(line, 500.0, "BTCUSD") is None


def test_drawing_spec_part():
    line = {"t1": 1, "p1": 2, "t2": 3, "p2": 4}
    assert C.clean_spec("drawing", "cross", {"lines": [line], "part": "lv:0.618"})["part"] == "lv:0.618"
    with pytest.raises(C.SpecError):
        C.clean_spec("drawing", "cross", {"lines": [line], "part": "bad part!"})


def test_email_needs_verified_address_and_cap(env, monkeypatch):
    monkeypatch.setattr(E, "EMAIL_DAILY_CAP", 1)
    _add(env, cond="gt", trigger="bar", notify_email=True)
    _add(env, user_id=env["b"].id, cond="gt", trigger="bar", notify_email=True)
    t0 = datetime(2026, 11, 24, 10, 0, 5, tzinfo=timezone.utc).timestamp()
    clock = {"t": t0}
    monkeypatch.setattr(E.time, "time", lambda: clock["t"])
    _ticks(2701)
    clock["t"] = t0 + 900
    _ticks(2702)
    assert len(env["mail"]) == 1 and env["mail"][0][0] == "a@t.co"


def _candles(env, closes, interval="15", t_end=None):
    sec = C.INTERVAL_SECONDS[interval]
    t_end = t_end or int(datetime.now(timezone.utc).timestamp()) // sec * sec - sec
    rows = []
    for k, c in enumerate(closes):
        t = t_end - (len(closes) - 1 - k) * sec
        rows.append(Candle(symbol="XAUUSD", interval=interval, t=t, o=c, h=c + 1, l=c - 1, c=c, v=10))
    env["db"].add_all(rows)
    env["db"].commit()
    return t_end


def _close(t, interval="15"):
    asyncio.run(_close_async(t, interval))


async def _close_async(t, interval):
    await E.on_bars_closed("XAUUSD", interval, [t])
    await asyncio.gather(*list(E._tasks))


def test_close_trigger_and_indicator_alert(env):
    closes = [2600 + (k % 7) for k in range(60)] + [2650]
    _add(env, cond="crossUp", trigger="close", spec=json.dumps({"level": 2620}))
    _add(env, kind="indicator", cond="crossUp", trigger="close",
         spec=json.dumps({"ind": {"type": "sma", "inputs": {"len": 3, "src": "close", "offset": 0}, "plot": "ma"},
                          "target": {"kind": "value", "v": 2610}}))
    _add(env, cond="moveUpPct", trigger="once", spec=json.dumps({"value": 1, "bars": 2}))
    t = _candles(env, closes)
    _close(t)
    db = env["Session"]()
    assert db.query(ChartAlertLog).count() == 3
    assert {r.status for r in db.query(ChartAlert).all()} == {"active", "fired"}


def test_stale_backfill_does_not_fire(env):
    _add(env, cond="gt", trigger="close", spec=json.dumps({"level": 1}))
    t = _candles(env, [2600, 2601, 2602], t_end=int(datetime.now(timezone.utc).timestamp()) - 3600 * 5 // 900 * 900)
    _close(t)
    assert env["Session"]().query(ChartAlertLog).count() == 0
