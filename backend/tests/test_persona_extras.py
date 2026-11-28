"""交易报告新功能（2026-11-28，rev 58）：周小结、纪律连续记录、本月目标 + 目标人格、同人格对比、
模拟盘预览人格、年度报告、每日亏损提醒、推荐官客户看板。

**为什么要测。** 这些全是「算出来给人看」或「到点发一条」的东西，错了页面照样好看：周的边界差一天、
连续记录断了没归零、目标的方向反了（越多越好算成越少越好）、模拟盘的单混进实盘人格、不足 20 人也给了
「同人格平均」、年度报告在 12 月的月报还没存完时就生成、亏损提醒一天发好几次或把模拟盘的亏损算进去、
推荐官在开关关着时看到了看板——都不会报错。
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.models import (
    AgentNode, Order, PersonaAnnualReport, PersonaPref, PersonaReport, PersonaState, PlatformSetting,
    UserNotification,
)
from app.services.persona import alerts, annual, engine, extras, service
from test_persona import T0, _admin_settings, _client, _p, _seed, _trade, _user, api_db  # noqa: F401

UTC = timezone.utc


# ---------------------------------------------------------------- 周小结 / weekly digest
def test_week_starts_on_monday_utc():
    assert engine.week_start(datetime(2026, 11, 8, 23, 59, tzinfo=UTC)) == datetime(2026, 11, 2, tzinfo=UTC)   # 周日
    assert engine.week_start(datetime(2026, 11, 9, 0, 0, tzinfo=UTC)) == datetime(2026, 11, 9, tzinfo=UTC)     # 周一


def test_weeks_split_by_close_time_and_count_tags():
    now = datetime(2026, 11, 12, 12, tzinfo=UTC)                     # 周四；本周从 11-09 起
    this = [_p(i, open_at=datetime(2026, 11, 10, 8 + i, tzinfo=UTC), profit=10, sl=99.0) for i in range(3)]
    last = [_p(10 + i, open_at=datetime(2026, 11, 4, 8 + i, tzinfo=UTC), profit=-5) for i in range(2)]
    # 周日 23:58 开、周一 00:08 平 → 按平仓算进本周
    edge = _p(20, open_at=datetime(2026, 11, 8, 23, 58, tzinfo=UTC), profit=7, sl=99.0)
    w = extras.weeks(this + last + [edge], now)
    assert [x["current"] for x in w] == [True, False]
    assert w[0]["start"] == "2026-11-09" and w[0]["end"] == "2026-11-15"
    assert w[0]["summary"]["trades"] == 4 and w[0]["summary"]["profit"] == 37.0
    assert w[1]["start"] == "2026-11-02" and w[1]["summary"]["trades"] == 2
    assert w[1]["tags"]["unprotected"] == 2 and w[0]["tags"]["unprotected"] == 0
    assert w[0]["topSymbol"]["key"] == "XAUUSD" and w[0]["bestDay"]["day"] == "2026-11-10"


# ---------------------------------------------------------------- 纪律连续记录 / streaks
def test_stop_streak_resets_and_reports_a_recent_break():
    now = T0 + timedelta(days=3)
    ps = [_p(i, sl=99.0) for i in range(6)] + [_p(6)] + [_p(7 + i, sl=99.0) for i in range(2)]
    st = {s["key"]: s for s in engine.streaks(ps, engine.trade_tags(ps), now)}
    assert st["stops"]["current"] == 2 and st["stops"]["best"] == 6 and st["stops"]["unit"] == "trades"
    assert st["stops"]["broken"]["length"] == 6
    # 断之前只连续了 2 笔：不值得一提
    ps = [_p(i, sl=99.0) for i in range(2)] + [_p(2)] + [_p(3, sl=99.0)]
    st = {s["key"]: s for s in engine.streaks(ps, engine.trade_tags(ps), now)}
    assert st["stops"]["current"] == 1 and st["stops"]["broken"] is None
    assert engine.streaks([], {}, now) == []


def test_day_streaks_count_days_since_the_last_offence():
    ps = [_p(i, open_at=T0 + timedelta(days=i), sl=99.0) for i in range(10)]
    tags = engine.trade_tags(ps)
    tags[(ps[6].login, ps[6].ticket)] = ["revenge"]                  # 第 7 天有一笔报复加仓
    now = T0 + timedelta(days=9, hours=12)
    st = {s["key"]: s for s in engine.streaks(ps, tags, now)}
    assert st["noRevenge"]["current"] == 3 and st["noRevenge"]["best"] == 6
    assert st["noRevenge"]["broken"]["length"] == 6
    # 从没犯过：从第一笔单算到现在
    assert st["noHeldLoser"]["current"] == 9 and st["noHeldLoser"]["best"] == 9 and st["noHeldLoser"]["broken"] is None


# ---------------------------------------------------------------- 目标 / goals
def test_goal_validation_and_direction():
    assert extras.clean_goals([{"key": "winRate", "target": 0.55}, {"key": "unprotected", "target": 0}]) == [
        {"key": "winRate", "target": 0.55}, {"key": "unprotected", "target": 0}]
    for bad in ([{"key": "nope", "target": 1}], [{"key": "winRate", "target": 5}],
                [{"key": "score", "target": 60}, {"key": "score", "target": 70}],
                [{"key": "score", "target": "x"}],
                [{"key": k, "target": 50} for k in ("score", "trades", "unprotected", "revenge")]):
        with pytest.raises(ValueError):
            extras.clean_goals(bad)
    rep = {"summary": {"winRate": 0.5, "trades": 12, "payoff": None}, "tags": {"unprotected": {"count": 3}}}
    got = {g["key"]: g for g in engine.evaluate_goals(
        [{"key": "winRate", "target": 0.55}, {"key": "trades", "target": 20}, {"key": "unprotected", "target": 2},
         {"key": "payoff", "target": 1.5}], rep)}
    assert not got["winRate"]["met"] and got["winRate"]["dir"] == "ge"       # 越高越好，没到
    assert got["trades"]["met"] and got["trades"]["dir"] == "le"             # 不超过，达标
    assert not got["unprotected"]["met"] and got["unprotected"]["value"] == 3
    assert not got["payoff"]["met"] and got["payoff"]["value"] is None       # 没数值算未达标


def test_target_persona_progress():
    axes = engine.compute_persona([_p(i) for i in range(10)])["axes"]
    have = "".join(axes[a]["letter"] for a in engine.AXES)
    same = engine.target_progress(have, axes)
    assert same["reached"] and all(r["met"] for r in same["axes"])
    flipped = ("R" if have[0] == "A" else "A") + have[1:]
    prog = engine.target_progress(flipped, axes)
    assert not prog["reached"] and [r["met"] for r in prog["axes"]] == [False, True, True, True]
    assert engine.target_progress("ZZZZ", axes) is None and engine.target_progress(have, None) is None


def test_goal_in_live_report_and_frozen_at_archive(db_session):
    u = _user(db_session, "g@t.co", "tok_g")
    _seed(db_session, u, T0, n=24)
    now = T0 + timedelta(days=6)
    service.status(db_session, u.id, now)
    assert "goal" not in service.report_for(db_session, u.id, "2026-11", now)               # 开关没开：不带
    assert service.report_for(db_session, u.id, "2026-11", now, goals=True)["goal"] is None  # 开了但没设
    extras.save_goals(db_session, u.id, [{"key": "trades", "target": 30}, {"key": "winRate", "target": 0.9}],
                      "AGLZ", now)
    db_session.commit()
    goal = service.report_for(db_session, u.id, "2026-11", now, goals=True)["goal"]
    assert [g["met"] for g in goal["goals"]] == [True, False] and goal["goals"][0]["value"] == 24
    assert goal["target"]["code"] == "AGLZ" and len(goal["target"]["axes"]) == 4 and goal["setAt"]
    arch_now = datetime(2026, 12, 1, 0, 10, tzinfo=UTC)
    service.archive_user(db_session, u.id, "2026-11", arch_now, goals=True)
    # 存档之后用户把目标改了：存档里的结果不跟着变
    extras.save_goals(db_session, u.id, [], None, arch_now)
    db_session.commit()
    out = service.report_for(db_session, u.id, "2026-11", arch_now, goals=True)
    assert out["goal"]["goals"][0]["key"] == "trades" and out["goal"]["target"]["code"] == "AGLZ"


# ---------------------------------------------------------------- 模拟盘预览 / demo preview
def test_demo_preview_only_when_asked_and_never_stored(db_session):
    now = T0 + timedelta(days=6)
    demo = _user(db_session, "dp@t.co", "tok_dp")
    _seed(db_session, demo, T0, n=24, real=False)
    assert "preview" not in service.status(db_session, demo.id, now)
    st = service.status(db_session, demo.id, now, preview=True)
    assert st["status"] == "demo" and st["preview"]["unlocked"] and st["preview"]["persona"]["code"] in engine.CODES
    assert db_session.query(PersonaState).count() == 0                # 预览不落库
    few = _user(db_session, "df@t.co", "tok_df")
    _seed(db_session, few, T0, n=4, real=False)
    st = service.status(db_session, few.id, now, preview=True)
    assert not st["preview"]["unlocked"] and st["preview"]["progress"]["actions"] == 4
    # 有实盘单但不够数：状态是 locked（进度按实盘算），预览按模拟盘算
    mixed = _user(db_session, "dm@t.co", "tok_dm")
    _seed(db_session, mixed, T0, n=3)
    _seed(db_session, mixed, T0, n=24, real=False)
    st = service.status(db_session, mixed.id, now, preview=True)
    assert st["status"] == "locked" and st["progress"]["actions"] == 3 and st["preview"]["unlocked"]
    # 已经有实盘人格的人不给预览
    real = _user(db_session, "dr@t.co", "tok_dr")
    _seed(db_session, real, T0, n=24)
    assert "preview" not in service.status(db_session, real.id, now, preview=True)


# ---------------------------------------------------------------- 同人格对比 / peers
def test_peers_need_twenty_and_fall_back_to_family(db_session):
    import json
    from app.services import shared_cache

    def add(n, code, hold, start):
        for i in range(n):
            u = _user(db_session, f"pe{start + i}@t.co", f"tok_pe{start + i}")
            db_session.add(PersonaState(user_id=u.id, code=code, positions=30, axes_json=json.dumps(
                {"tempo": {"medianHoldMin": hold + i, "perDay": 4}, "risk": {"payoff": 1.2, "holdRatio": None},
                 "judge": {"share": 0.2}, "manage": {"share": 0.1}})))
        db_session.commit()
    add(12, "AGLZ", 10, 0)
    shared_cache.clear_for_tests()
    assert extras.peers(db_session, "AGLZ") is None                   # 12 人：不给
    add(9, "AGQM", 100, 100)
    shared_cache.clear_for_tests()
    fam = extras.peers(db_session, "AGLZ")
    assert fam["scope"] == "family" and fam["key"] == "AG" and fam["count"] == 21
    add(8, "AGLZ", 22, 200)
    shared_cache.clear_for_tests()
    own = extras.peers(db_session, "AGLZ")
    assert own["scope"] == "code" and own["count"] == 20
    assert own["medians"]["perDay"] == 4 and own["medians"]["holdRatio"] is None
    assert extras.peers(db_session, "RXQM") is None and extras.peers(db_session, None) is None


# ---------------------------------------------------------------- 年度报告 / annual
def _year_of_trades(db, u):
    for m, n in ((9, 22), (10, 14), (11, 16)):
        _seed_month(db, u, datetime(2026, m, 3, 8, tzinfo=UTC), n, base=m * 1000)


def _seed_month(db, u, start, n, base):
    for i in range(n):
        opened = start + timedelta(days=i % 5, hours=i % 6, minutes=7 * i)
        _trade(db, u, base + i, opened, profit=20.0 if i % 3 else -9.0, sl=99.0 if i % 2 else None)
    db.commit()


def test_annual_report_content(db_session):
    u = _user(db_session, "y@t.co", "tok_y")
    _year_of_trades(db_session, u)
    for period, at in (("2026-09", datetime(2026, 10, 1, 0, 10, tzinfo=UTC)),
                       ("2026-10", datetime(2026, 11, 1, 0, 10, tzinfo=UTC))):
        service.archive_user(db_session, u.id, period, at)
    rep = annual.build_annual(db_session, u.id, 2026, datetime(2026, 11, 28, tzinfo=UTC))
    assert rep["live"] and rep["months"] == ["2026-09", "2026-10", "2026-11"]
    assert rep["summary"]["trades"] == 52 and [m["trades"] for m in rep["monthly"]] == [22, 14, 16]
    assert rep["monthly"][0]["code"] and rep["monthly"][2]["code"] is None          # 11 月还没存档
    assert rep["journey"]["steps"][0]["period"] == "2026-09" and rep["journey"]["mostCommon"]
    assert rep["records"]["bestTrade"]["profit"] == 20.0 and rep["records"]["worstTrade"]["profit"] == -9.0
    assert rep["records"]["winRun"] >= 2 and rep["records"]["lossRun"] >= 1
    assert rep["records"]["topSymbol"]["key"] == "XAUUSD" and rep["records"]["bestMonth"] == "2026-09"
    assert rep["halves"]["split"] == "2026-10" and rep["halves"]["first"]["trades"] == 36
    assert rep["halves"]["second"]["tagRates"]["unprotected"] == 0.5
    assert len(rep["calendar"]) >= 10 and rep["tags"]["unprotected"]["count"] == 26
    assert annual.build_annual(db_session, u.id, 2025, datetime(2026, 1, 2, tzinfo=UTC)) is None


def _loop_env(db_session, monkeypatch):
    from app.services import notification_feed, push_dispatch
    from app.services.persona import loop
    monkeypatch.setattr(loop, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(alerts, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(db_session, "close", lambda: None)
    sent: dict = {"ws": [], "push": []}
    monkeypatch.setattr(notification_feed, "notify_ws_many", lambda ids: sent["ws"].append(list(ids)))
    monkeypatch.setattr(push_dispatch, "dispatch_users_push",
                        lambda ids, event, title, body, url, tag: sent["push"].append((list(ids), event, title, body, url)))
    return loop, sent


def test_annual_pass_waits_for_december_and_notifies_on_time(db_session, monkeypatch):
    import json
    from app.services.settings_store import set_setting
    loop, sent = _loop_env(db_session, monkeypatch)
    u = _user(db_session, "ya@t.co", "tok_ya")
    _year_of_trades(db_session, u)
    service.archive_user(db_session, u.id, "2026-11", datetime(2026, 12, 1, 0, 10, tzinfo=UTC))
    _admin_settings(db_session, persona_visible=True)
    jan1 = datetime(2027, 1, 1, 0, 30, tzinfo=UTC)
    # 12 月的月报还没存完：等
    set_setting(db_session, loop.WATERMARK_KEY, {"period": "2026-11"}); db_session.commit()
    assert loop.run_annual_pass(jan1).get("waiting")
    assert db_session.query(PersonaAnnualReport).count() == 0
    set_setting(db_session, loop.WATERMARK_KEY, {"period": "2026-12"}); db_session.commit()
    res = loop.run_annual_pass(jan1)
    assert res == {"year": 2026, "archived": 1, "done": True}
    row = db_session.query(PersonaAnnualReport).one()
    assert json.loads(row.report_json)["live"] is False and annual.years(db_session, u.id) == [2026]
    n = db_session.query(UserNotification).filter_by(user_id=u.id, kind="persona_annual").one()
    assert n.text == "2026" and n.link == "/persona?annual=2026"
    assert sent["push"][0][1] == "persona_report" and "2026" in sent["push"][0][3]
    # 幂等：再跑不重复存、不重复发
    assert loop.run_annual_pass(jan1 + timedelta(minutes=10)) == {"year": 2026, "done": True, "archived": 0}
    assert len(sent["push"]) == 1
    # 普通用户看存好的；今年（2027）的没有；管理员能预览今年的
    assert annual.annual_for(db_session, u.id, 2026, jan1)["year"] == 2026
    assert annual.annual_for(db_session, u.id, 2027, jan1) is None


def test_annual_late_catch_up_does_not_notify(db_session, monkeypatch):
    from app.services.settings_store import set_setting
    loop, sent = _loop_env(db_session, monkeypatch)
    u = _user(db_session, "yl@t.co", "tok_yl")
    _year_of_trades(db_session, u)
    service.archive_user(db_session, u.id, "2026-11", datetime(2026, 12, 1, 0, 10, tzinfo=UTC))
    _admin_settings(db_session, persona_visible=True)
    set_setting(db_session, loop.WATERMARK_KEY, {"period": "2027-01"}); db_session.commit()
    res = loop.run_annual_pass(datetime(2027, 2, 3, tzinfo=UTC))       # 2 月才补存
    assert res["archived"] == 1 and sent["push"] == []
    assert db_session.query(UserNotification).filter_by(kind="persona_annual").count() == 0


def test_annual_push_copy_languages():
    from app.services.persona import loop
    for lang in loop.PUSH_LANGS:
        title, body = loop.annual_push_text(lang, 2026)
        assert title and "2026" in body
    assert loop.annual_push_text("xx", 2026) == loop.annual_push_text("zh", 2026)
    for lang in loop.PUSH_LANGS:
        title, body = alerts.push_text(lang, 120.5, 100)
        assert title and "120.50" in body and "100.00" in body


# ---------------------------------------------------------------- 每日亏损提醒 / daily loss alert
def test_alert_setting_rules(db_session):
    u = _user(db_session, "al@t.co", "tok_al")
    with pytest.raises(ValueError):
        alerts.save_alert(db_session, u.id, None, True)               # 开着但没金额
    with pytest.raises(ValueError):
        alerts.save_alert(db_session, u.id, 0.5, True)
    row = alerts.save_alert(db_session, u.id, 100, True); db_session.commit()
    now = datetime(2026, 11, 10, 9, tzinfo=UTC)
    row.loss_fired_day = "2026-11-10"; db_session.commit()
    assert alerts.alert_out(row, now) == {"limit": 100.0, "enabled": True, "firedToday": True}
    alerts.save_alert(db_session, u.id, 100, True)                    # 没变：今天已提醒保留
    assert row.loss_fired_day == "2026-11-10"
    alerts.save_alert(db_session, u.id, 200, True)                    # 改了金额：重新计
    assert row.loss_fired_day is None
    assert alerts.alert_out(None, now) == {"limit": None, "enabled": False, "firedToday": False}


def test_alert_fires_once_on_real_losses_only(db_session, monkeypatch):
    _loop, sent = _loop_env(db_session, monkeypatch)
    from app.services import connection_manager
    now = datetime(2026, 11, 10, 15, tzinfo=UTC)
    u = _user(db_session, "lo@t.co", "tok_lo")
    alerts.save_alert(db_session, u.id, 100, True)
    _trade(db_session, u, 7001, now - timedelta(hours=3), profit=-60.0)                 # 今天实盘亏 60
    _trade(db_session, u, 7002, now - timedelta(hours=30), profit=-500.0)               # 昨天的不算
    _trade(db_session, u, 7003, now - timedelta(hours=2), profit=-900.0, trade_mode=0)  # 模拟盘的不算
    # 一笔实盘持仓和一笔模拟盘持仓
    for ticket, mode in ((8001, 2), (8002, 0)):
        db_session.add(Order(user_id=u.id, client_order_id=f"o{ticket}", symbol="XAUUSD", side="BUY", volume=0.1,
                             status="FILLED", mt5_login="77", mt5_ticket=ticket, trade_mode=mode,
                             created_at=(now - timedelta(hours=1)).replace(tzinfo=None)))
    db_session.commit()
    rows = [{"ticket": 8001, "login": "77", "profit": -30.0}, {"ticket": 8002, "login": "77", "profit": -400.0},
            {"ticket": 9999, "login": "77", "profit": -400.0}]         # 9999 不是本平台开的
    monkeypatch.setattr(connection_manager.manager, "get_positions_shared", lambda uid: rows)
    assert alerts.today_pnl(db_session, u.id, rows, now) == pytest.approx(-90.0)
    # 总开关关着：不发
    assert alerts.run_alert_pass(now).get("off")
    _admin_settings(db_session, persona_visible=True)
    assert alerts.run_alert_pass(now) == {"checked": 1, "fired": 0}                     # −90 还没到 100
    rows[0]["profit"] = -45.0                                                            # 浮亏扩大 → −105
    assert alerts.run_alert_pass(now) == {"checked": 1, "fired": 1}
    n = db_session.query(UserNotification).filter_by(user_id=u.id, kind="persona_loss_alert").one()
    assert n.text == "-105.00 / 100.00" and n.link == "/persona"
    assert sent["push"][0][1] == "loss_alert" and "105.00" in sent["push"][0][3]
    # 当天不再发；第二天重新算
    assert alerts.run_alert_pass(now + timedelta(minutes=5)) == {"checked": 0, "fired": 0}
    assert db_session.query(PersonaPref).one().loss_fired_day == "2026-11-10"
    nxt = alerts.run_alert_pass(now + timedelta(days=1))
    assert nxt["checked"] == 1 and nxt["fired"] == 0                                    # 第二天只剩 −45 的浮亏
    # 关掉之后不再检查
    alerts.save_alert(db_session, u.id, 100, False); db_session.commit()
    assert alerts.run_alert_pass(now + timedelta(days=2))["checked"] == 0


# ---------------------------------------------------------------- 接口与开关 / API and switches
def test_api_feature_switches(api_db):
    db = api_db
    who: dict = {}
    client = _client(db, who)
    u = _user(db, "sw@t.co", "tok_sw")
    _seed(db, u, datetime.now(UTC) - timedelta(days=5), n=24, real=False)
    who["user"] = u
    _admin_settings(db, persona_visible=True)
    from app.services import shared_cache
    me = client.get("/api/persona/me").json()
    assert me["status"] == "demo" and "preview" not in me
    assert me["features"] == {"demoPreview": False, "goals": False, "agentBoard": False, "goalMenu": None,
                              "goalsMax": 3}
    assert me["alert"] == {"limit": None, "enabled": False, "firedToday": False}
    _admin_settings(db, persona_demo_preview=True)
    me = client.get("/api/persona/me").json()
    assert me["preview"]["unlocked"] and me["features"]["demoPreview"]
    # 目标：开关关着 403；没解锁 404
    assert client.put("/api/persona/me/goal", json={"goals": []}).status_code == 403
    _admin_settings(db, persona_goals=True)
    assert client.put("/api/persona/me/goal", json={"goals": []}).status_code == 404
    # 亏损提醒
    assert client.put("/api/persona/me/alert", json={"limit": 0.1, "enabled": True}).status_code == 400
    r = client.put("/api/persona/me/alert", json={"limit": 150, "enabled": True})
    assert r.status_code == 200 and r.json()["limit"] == 150 and r.json()["enabled"]
    assert client.get("/api/persona/me").json()["alert"]["limit"] == 150
    # 年度报告：没有就是 404，年份不对 400
    assert client.get("/api/persona/me/annual?year=2026").status_code == 404
    assert client.get("/api/persona/me/annual?year=1999").status_code == 400
    shared_cache.clear_for_tests()


def test_api_goal_roundtrip_and_admin_annual_preview(api_db):
    db = api_db
    who: dict = {}
    client = _client(db, who)
    from app.services import shared_cache
    shared_cache.clear_for_tests()
    u = _user(db, "gr@t.co", "tok_gr")
    _seed(db, u, datetime.now(UTC) - timedelta(days=4), n=24)
    who["user"] = u
    _admin_settings(db, persona_visible=True, persona_goals=True)
    me = client.get("/api/persona/me").json()
    assert me["status"] == "unlocked" and me["report"]["goal"] is None and me["peers"] is None
    assert me["features"]["goalMenu"]["winRate"] == {"dir": "ge", "min": 0.2, "max": 0.95}
    assert len(me["report"]["weeks"]) == 2 and {s["key"] for s in me["report"]["streaks"]} >= {"stops", "noRevenge"}
    assert client.put("/api/persona/me/goal", json={"goals": [{"key": "bad", "target": 1}]}).status_code == 400
    assert client.put("/api/persona/me/goal", json={"goals": [], "targetCode": "XXXX"}).status_code == 400
    r = client.put("/api/persona/me/goal", json={"goals": [{"key": "trades", "target": 100}], "targetCode": "RGQM"})
    assert r.status_code == 200
    goal = client.get("/api/persona/me").json()["report"]["goal"]      # 缓存已清，马上看得到
    assert goal["goals"][0]["met"] and goal["target"]["code"] == "RGQM"
    # 普通用户看不到今年还没出的年度报告；管理员可以预览
    year = datetime.now(UTC).year
    assert client.get(f"/api/persona/me/annual?year={year}").status_code == 404
    u.role = "admin"; db.commit()
    rep = client.get(f"/api/persona/me/annual?year={year}").json()
    assert rep["live"] and rep["summary"]["trades"] >= 1
    shared_cache.clear_for_tests()


def test_api_agent_board(api_db):
    import json
    db = api_db
    who: dict = {}
    client = _client(db, who)
    from app.services import shared_cache
    shared_cache.clear_for_tests()
    agent = _user(db, "bd@t.co", "tok_bd")
    c1 = _user(db, "c1@t.co", "tok_c1", agent_user_id=agent.id)
    c2 = _user(db, "c2@t.co", "tok_c2", agent_user_id=agent.id)
    _user(db, "c3@t.co", "tok_c3", agent_user_id=agent.id)
    _user(db, "zz@t.co", "tok_zz")                                    # 不是他的客户
    db.add(AgentNode(user_id=agent.id, depth=1, can_view_reports=True))
    db.add(PersonaState(user_id=c1.id, code="AGLZ", positions=40))
    db.add(PersonaState(user_id=c2.id, code="RXQM", positions=40))
    for period, score in (("2026-09", 70), ("2026-10", 52)):
        db.add(PersonaReport(user_id=c1.id, period=period, code="AGLZ",
                             report_json=json.dumps({"summary": {"score": score, "trades": 9}})))
    now = datetime.now(UTC)
    _trade(db, c1, 6001, now - timedelta(days=2))
    _trade(db, c2, 6002, now - timedelta(days=45))
    db.commit()
    who["user"] = agent
    _admin_settings(db, persona_visible=True)
    assert client.get("/api/persona/clients").status_code == 403       # 看板开关关着
    _admin_settings(db, persona_agent_board=True)
    b = client.get("/api/persona/clients").json()
    assert b["total"] == 3 and b["withPersona"] == 2 and b["families"] == {"strategist": 1, "chaser": 1}
    assert b["inactive"] == 1 and b["dropped"] == 1
    rows = {r["email"]: r for r in b["clients"]}
    assert rows["c1@t.co"]["scoreDelta"] == -18 and rows["c1@t.co"]["dropped"] and not rows["c1@t.co"]["inactive"]
    assert rows["c2@t.co"]["inactive"] and rows["c2@t.co"]["idleDays"] >= 45
    assert rows["c3@t.co"]["code"] is None and rows["c3@t.co"]["lastTradeAt"] is None
    assert b["clients"][0]["email"] == "c1@t.co" and "zz@t.co" not in rows   # 评分掉得厉害的排最前
    # 没有「看客户报告」权限的推荐官看不了
    db.query(AgentNode).filter_by(user_id=agent.id).one().can_view_reports = False; db.commit()
    assert client.get("/api/persona/clients").status_code == 403
    shared_cache.clear_for_tests()


def test_admin_settings_expose_the_three_switches(db_session):
    from app.routers.gamification import _settings_to_camel
    from app.services.settings_store import get_gamification_settings, invalidate_gamification_cache
    invalidate_gamification_cache()
    out = _settings_to_camel(get_gamification_settings(db_session))
    assert out["personaDemoPreview"] is False and out["personaGoals"] is False and out["personaAgentBoard"] is False
    assert db_session.query(PlatformSetting).count() >= 0
