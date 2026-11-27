"""交易报告 + 交易人格（2026-11-22）。

**为什么要测。** 人格和报告全是「算出来给人看」的数字，算错了页面照样好看：主轴取反、缓冲带不生效、
连点没合并、解锁条件漏了隐藏底线、浮亏单没算进月底、推荐官看到了不是直属的客户——都不会报错。
这里把方案里的每条规则钉一遍，再走一遍数据库里的完整流程（解锁 → 当月报告 → 月底存档 → 权限）。
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.models import AgentNode, ClosedTrade, Order, PersonaReport, PersonaState, User
from app.services.persona import engine, service
from app.services.persona.positions import Edit, Position, load_positions

T0 = datetime(2026, 11, 2, 8, 0, tzinfo=timezone.utc)


def _p(i=0, *, profit=10.0, hold=600, symbol="XAUUSD", side="BUY", source="chart", volume=0.1,
       open_at=None, edits=None, sl=None, tp=None, reason="CLIENT", stopped=False, auto=False,
       open_price=100.0, close_price=None, unrealized=False):
    o = open_at or T0 + timedelta(hours=i)
    return Position(login="1", ticket=1000 + i, symbol=symbol, side=side, volume=volume, weighted_volume=volume,
                    open_at=o, close_at=o + timedelta(seconds=hold), profit=profit, source=source,
                    open_price=open_price, close_price=close_price if close_price is not None else open_price,
                    sl_at_open=sl, tp_at_open=tp, sl_at_close=sl, tp_at_close=tp, close_reason=reason,
                    stopped_out=stopped, auto_managed=auto, edits=edits or [], unrealized=unrealized)


# ---------------------------------------------------------------- 规则 / rules
def test_burst_merge_same_symbol_side_within_60s():
    a = _p(0, open_at=T0)
    b = _p(1, open_at=T0 + timedelta(seconds=40))          # 同向 40 秒内 → 同一次出手
    c = _p(2, open_at=T0 + timedelta(seconds=90))          # 距上一单 50 秒 → 链式合并
    d = _p(3, open_at=T0 + timedelta(seconds=95), side="SELL")   # 反方向 → 新出手
    e = _p(4, open_at=T0 + timedelta(seconds=300))         # 超过 60 秒 → 新出手
    assert [len(g) for g in engine.actions([a, b, c, d, e])] == [3, 1, 1]


def test_unlock_needs_actions_days_and_hidden_floor():
    many = [_p(i, open_at=T0 + timedelta(days=i % 3, minutes=5 * i), profit=10 if i % 2 else -5) for i in range(20)]
    assert engine.unlock_status(many)["unlocked"]
    # 只在 2 天里交易 → 不解锁
    two_days = [_p(i, open_at=T0 + timedelta(days=i % 2, minutes=5 * i)) for i in range(20)]
    st = engine.unlock_status(two_days)
    assert not st["unlocked"] and st["days"] == 2 and not st["needMore"]
    # 出手和天数都够，但全是盈利单 → 不解锁，只给 needMore（不提盈亏）
    all_wins = [_p(i, open_at=T0 + timedelta(days=i % 3, minutes=5 * i), profit=10) for i in range(20)]
    st = engine.unlock_status(all_wins)
    assert not st["unlocked"] and st["needMore"]
    assert "wins" not in st and "losses" not in st


def test_judge_axis_reverse_counts_as_own():
    sig = [_p(i, source="signal") for i in range(6)]
    rev = [_p(10 + i, source="reverse") for i in range(4)]
    own = [_p(20 + i) for i in range(2)]
    assert engine.compute_persona(sig + rev + own)["code"][0] == "R"          # 6/12 = 50% → R
    assert engine.compute_persona(sig[:5] + rev + own)["code"][0] == "A"      # 5/11 < 50% → A


def test_risk_axis_hold_ratio_and_payoff():
    # 亏损单拿得短、盈利单拿得长、平均盈利大 → G
    good = [_p(i, profit=30, hold=3600) for i in range(5)] + [_p(10 + i, profit=-10, hold=600) for i in range(5)]
    assert engine.compute_persona(good)["code"][1] == "G"
    # 亏损单扛得久、盈利单跑得快 → X
    bad = [_p(i, profit=10, hold=300) for i in range(5)] + [_p(10 + i, profit=-30, hold=7200) for i in range(5)]
    assert engine.compute_persona(bad)["code"][1] == "X"


def test_risk_stopout_penalty():
    base = [_p(i, profit=20, hold=1200) for i in range(5)] + [_p(10 + i, profit=-20, hold=1200) for i in range(5)]
    assert engine.risk_parts(base)["score"] == pytest.approx(50.0)
    base[-1].stopped_out = True                         # 1/10 = 10% → −30 分
    assert engine.risk_parts(base)["score"] == pytest.approx(20.0)


def test_tempo_axis():
    fast = [_p(i, hold=60, open_at=T0 + timedelta(minutes=2 * i)) for i in range(40)]     # 1 天 40 次、持仓 1 分钟
    assert engine.compute_persona(fast)["code"][2] == "Q"
    slow = [_p(i, hold=4 * 3600, open_at=T0 + timedelta(days=i)) for i in range(10)]     # 每天 1 次、持仓 4 小时
    assert engine.compute_persona(slow)["code"][2] == "L"


def test_manage_axis_ignores_early_and_auto_edits():
    def late(p, auto=False):
        p.edits = [Edit(at=p.open_at + timedelta(seconds=300), sl=99.0, tp=None, prev_sl=None, prev_tp=None, auto=auto)]
        return p

    def early(p):
        p.edits = [Edit(at=p.open_at + timedelta(seconds=30), sl=99.0, tp=None, prev_sl=None, prev_tp=None, auto=False)]
        return p
    ps = [_p(i) for i in range(10)]
    assert engine.manage_value([early(p) for p in ps]) == 0                 # 2 分钟内改的不算
    ps = [_p(i) for i in range(10)]
    assert engine.manage_value([late(p, auto=True) for p in ps]) == 0       # 智能风控改的不算
    ps = [_p(i) for i in range(10)]
    ps[0] = late(ps[0]); ps[1] = late(ps[1])
    assert engine.compute_persona(ps)["code"][3] == "M"                    # 20% ≥ 15%


def test_buffer_keeps_previous_letter():
    sig = [_p(i, source="signal") for i in range(9)]
    own = [_p(20 + i) for i in range(11)]                                   # 45% 跟信号，在 40–60% 缓冲带里
    assert engine.compute_persona(sig + own)["code"][0] == "A"
    assert engine.compute_persona(sig + own, previous_code="RGQZ")["code"][0] == "R"
    assert engine.compute_persona(sig[:7] + own, previous_code="RGQZ")["code"][0] == "A"   # 7/18 < 40% 出了缓冲带


def test_all_sixteen_codes_reachable_and_named():
    assert len(set(engine.CODES)) == 16
    for code in engine.CODES:
        assert code[:2] in engine.FAMILIES


def test_trade_tags():
    win_ref = [_p(i, profit=10, hold=600) for i in range(5)]                         # 盈利单平均拿 10 分钟
    held = _p(10, profit=-50, hold=3600, sl=95.0)                                    # 亏损拿 60 分钟 > 3 倍
    unprot = _p(11, profit=5)                                                        # 从没设过止损
    early = _p(12, profit=2, tp=110.0, sl=95.0, close_price=102.0)                   # 目标 10，只拿了 2
    moved = _p(13, profit=-5, sl=95.0, edits=[Edit(at=T0 + timedelta(hours=13, minutes=5), sl=90.0, tp=None,
                                                   prev_sl=95.0, prev_tp=None, auto=False)])
    so = _p(14, profit=-80, sl=95.0, stopped=True, reason="SO")
    loss = _p(20, profit=-10, sl=95.0, volume=0.1, open_at=T0 + timedelta(days=1))
    revenge = _p(21, profit=-10, sl=95.0, volume=0.2, open_at=loss.close_at + timedelta(minutes=10))
    allp = win_ref + [held, unprot, early, moved, so, loss, revenge]
    tags = engine.trade_tags(allp)
    get = lambda p: tags[(p.login, p.ticket)]
    assert "heldLoser" in get(held)
    assert "unprotected" in get(unprot) and "unprotected" not in get(held)
    assert "earlyExit" in get(early)
    assert "movedStop" in get(moved)
    assert "stoppedOut" in get(so)
    assert "revenge" in get(revenge) and "revenge" not in get(loss)
    summary = engine.tag_summary(allp, tags)
    assert summary["stoppedOut"] == {"count": 1, "profit": -80.0}


def test_badges_need_ten_and_fire():
    ps = [_p(i, hold=60, side="BUY", symbol=s) for i, s in
          enumerate(["XAUUSD", "EURUSD", "GBPUSD", "USDJPY"] * 3)]
    got = engine.badges(ps)
    assert {"lightning", "multiSymbol", "bull", "lotSteady"} <= set(got)
    assert engine.badges(ps[:9]) == []


def test_summary_and_calendar():
    ps = [_p(0, profit=30), _p(1, profit=-10), _p(26, profit=20)]
    s = engine.summary(ps)
    assert s["trades"] == 3 and s["wins"] == 2 and s["profit"] == 40.0
    assert s["payoff"] == pytest.approx(2.5) and 0 <= s["score"] <= 100
    assert s["maxDrawdown"] == 10.0
    assert [d["day"] for d in engine.calendar(ps)] == ["2026-11-02", "2026-11-03"]


# ---------------------------------------------------------------- 数据库流程 / DB flow
def _user(db, email, tok, **kw):
    u = User(email=email, api_token=tok, **kw)
    db.add(u); db.commit(); return u


def _trade(db, u, ticket, opened, *, hold_min=10, profit=10.0, source=None, signal_id=None,
           trade_mode=2, symbol="XAUUSD", sl=None):
    db.add(Order(user_id=u.id, client_order_id=f"p{ticket}", symbol=symbol, side="BUY", volume=0.1,
                 status="FILLED", mt5_login="77", mt5_ticket=ticket, trade_mode=trade_mode,
                 source=source, signal_id=signal_id, sl=sl, filled_price=100.0,
                 created_at=opened.replace(tzinfo=None)))
    db.add(ClosedTrade(user_id=u.id, mt5_login="77", symbol=symbol, side="BUY", close_volume=0.1,
                       close_price=101.0, profit=profit, position_ticket=ticket, deal_ticket=ticket * 10,
                       closed_at=(opened + timedelta(minutes=hold_min)).replace(tzinfo=None), verified=True,
                       reason="CLIENT"))


def _seed(db, u, start, n=24, real=True):
    for i in range(n):
        opened = start + timedelta(days=i % 4, hours=1 + i % 8, minutes=3 * i)
        _trade(db, u, 5000 + i + (0 if real else 900), opened, profit=15.0 if i % 3 else -8.0,
               trade_mode=2 if real else 0)
    db.commit()


def test_load_positions_real_only_and_window(db_session):
    u = _user(db_session, "p1@t.co", "tok_p1")
    _seed(db_session, u, T0, n=5)
    _seed(db_session, u, T0, n=5, real=False)
    got = load_positions(db_session, u.id, T0 - timedelta(days=1), T0 + timedelta(days=10))
    assert len(got) == 5 and all(p.login == "77" for p in got)
    assert load_positions(db_session, u.id, T0 + timedelta(days=10), T0 + timedelta(days=20)) == []


def test_status_demo_locked_unlocked(db_session):
    now = T0 + timedelta(days=6)
    demo = _user(db_session, "d@t.co", "tok_d")
    _seed(db_session, demo, T0, n=24, real=False)
    assert service.status(db_session, demo.id, now)["status"] == "demo"
    few = _user(db_session, "f@t.co", "tok_f")
    _seed(db_session, few, T0, n=5)
    st = service.status(db_session, few.id, now)
    assert st["status"] == "locked" and st["progress"]["actions"] == 5
    ok = _user(db_session, "ok@t.co", "tok_ok")
    _seed(db_session, ok, T0, n=24)
    st = service.status(db_session, ok.id, now)
    assert st["status"] == "unlocked" and st["persona"]["code"] in engine.CODES
    assert st["persona"]["provisional"] is True                      # 不到 50 笔 = 初测
    assert db_session.query(PersonaState).filter_by(user_id=ok.id).count() == 1


def test_live_report_then_archive(db_session):
    u = _user(db_session, "a@t.co", "tok_a")
    _seed(db_session, u, T0, n=24)
    now = T0 + timedelta(days=6)
    service.status(db_session, u.id, now)
    rep = service.report_for(db_session, u.id, "2026-11", now)
    assert rep["live"] and rep["summary"]["trades"] == 24 and rep["comment"] is None
    assert service.report_for(db_session, u.id, "2026-10", now) is None
    # 12 月 1 号存档 11 月；一笔浮亏持仓按亏损算进去
    db_session.add(Order(user_id=u.id, client_order_id="open1", symbol="XAUUSD", side="BUY", volume=0.1,
                         status="FILLED", mt5_login="77", mt5_ticket=9999, trade_mode=2,
                         created_at=(T0 + timedelta(days=20)).replace(tzinfo=None)))
    db_session.commit()
    arch_now = datetime(2026, 12, 1, 0, 10, tzinfo=timezone.utc)
    row = service.archive_user(db_session, u.id, "2026-11", arch_now,
                               open_rows=[{"ticket": 9999, "login": "77", "profit": -42.0}])
    assert row is not None and row.ai_status == "off"
    out = service.report_for(db_session, u.id, "2026-11", arch_now)
    assert out["live"] is False and out["openLosers"] == 1 and out["summary"]["trades"] == 25
    assert "2026-11" in service.months(db_session, u.id, arch_now)
    # 幂等：再存一次还是那一行
    assert service.archive_user(db_session, u.id, "2026-11", arch_now).id == row.id
    assert db_session.query(PersonaReport).filter_by(user_id=u.id).count() == 1


def test_archive_skips_locked_users(db_session):
    u = _user(db_session, "l@t.co", "tok_l")
    _seed(db_session, u, T0, n=5)
    assert service.archive_user(db_session, u.id, "2026-11", datetime(2026, 12, 1, 1, tzinfo=timezone.utc)) is None


def test_archive_pass_watermark(db_session, monkeypatch):
    from app.services.persona import loop
    monkeypatch.setattr(loop, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(db_session, "close", lambda: None)
    u = _user(db_session, "w@t.co", "tok_w")
    _seed(db_session, u, T0, n=24)
    early = loop.run_archive_pass(datetime(2026, 12, 1, 0, 1, tzinfo=timezone.utc))
    assert early.get("waiting")
    res = loop.run_archive_pass(datetime(2026, 12, 1, 0, 30, tzinfo=timezone.utc))
    assert res["archived"] == 1 and res["done"]
    again = loop.run_archive_pass(datetime(2026, 12, 1, 0, 40, tzinfo=timezone.utc))
    assert again["done"] and again["archived"] == 0


def test_live_report_outlook_floating_and_trade_refs(db_session):
    """当月报告的三样新东西：人格走向（和月底存档同口径）、还没计入的浮亏、最好 / 最差那一笔的定位信息。"""
    u = _user(db_session, "o@t.co", "tok_o")
    _seed(db_session, u, T0, n=24)
    now = T0 + timedelta(days=6)
    service.status(db_session, u.id, now)
    rep = service.report_for(db_session, u.id, "2026-11", now)
    # 没给持仓快照：没有浮亏；走向和现在的人格一致
    assert rep["floating"] is None
    code = db_session.query(PersonaState).filter_by(user_id=u.id).one().code
    assert rep["outlook"]["code"] == code and rep["outlook"]["changed"] is False and rep["outlook"]["from"] == code
    assert set(rep["outlook"]["axes"]) == set(engine.AXES)
    # 最好 / 最差的一笔带品种、时间、价格，金额和 summary 对得上
    assert rep["bestTrade"]["profit"] == rep["summary"]["best"] == 15.0
    assert rep["worstTrade"]["profit"] == rep["summary"]["worst"] == -8.0
    assert rep["bestTrade"]["symbol"] == "XAUUSD" and rep["bestTrade"]["openPrice"] == 100.0
    assert rep["bestTrade"]["closePrice"] == pytest.approx(101.0) and rep["bestTrade"]["openAt"] < rep["bestTrade"]["closeAt"]
    # 浮亏的实盘持仓：只报数，不进当月统计；浮盈的、对不上本平台实盘单的都不算
    db_session.add(Order(user_id=u.id, client_order_id="open1", symbol="XAUUSD", side="BUY", volume=0.1,
                         status="FILLED", mt5_login="77", mt5_ticket=9999, trade_mode=2,
                         created_at=(T0 + timedelta(days=5)).replace(tzinfo=None)))
    db_session.commit()
    rows = [{"ticket": 9999, "login": "77", "profit": -42.5},
            {"ticket": 9998, "login": "77", "profit": 30.0},
            {"ticket": 1234, "login": "77", "profit": -5.0}]
    rep2 = service.report_for(db_session, u.id, "2026-11", now, open_rows=rows)
    assert rep2["floating"] == {"count": 1, "loss": -42.5}
    assert rep2["summary"]["trades"] == 24 and rep2["openLosers"] == 0


def test_outlook_follows_the_window_not_the_stored_persona(db_session):
    """走向按「此刻的最近 90 天」重算：存着的人格是旧的，窗口里的单变了，走向就该不一样。"""
    u = _user(db_session, "o2@t.co", "tok_o2")
    _seed(db_session, u, T0, n=24)
    now = T0 + timedelta(days=6)
    service.status(db_session, u.id, now)
    st = db_session.query(PersonaState).filter_by(user_id=u.id).one()
    real = st.code
    # 把存着的代号的第一位（判断）翻过来；这批单全是自己下的（跟信号 0%），远在缓冲带外，走向应翻回去
    st.code = ("R" if real[0] == "A" else "A") + real[1:]
    db_session.commit()
    rep = service.report_for(db_session, u.id, "2026-11", now)
    assert rep["outlook"]["from"] == st.code and rep["outlook"]["code"][0] == real[0]
    assert rep["outlook"]["changed"] is True


def test_month_over_month_and_trend(db_session):
    """跨月对比是读的时候拼的：上个月有存档才有 previous；trend 按月份从早到晚、最后一项是本月。"""
    u = _user(db_session, "m@t.co", "tok_m")
    oct0 = datetime(2026, 10, 5, 8, 0, tzinfo=timezone.utc)
    _seed(db_session, u, oct0, n=24)
    assert service.archive_user(db_session, u.id, "2026-10", datetime(2026, 11, 1, 0, 10, tzinfo=timezone.utc))
    for i in range(6):
        _trade(db_session, u, 7000 + i, T0 + timedelta(hours=i), profit=20.0 if i % 2 else -5.0)
    db_session.commit()
    now = T0 + timedelta(days=6)
    octo = service.report_for(db_session, u.id, "2026-10", now)
    assert octo["previous"] is None and [t["period"] for t in octo["trend"]] == ["2026-10"]
    nov = service.report_for(db_session, u.id, "2026-11", now)
    assert nov["previous"]["period"] == "2026-10" and nov["previous"]["trades"] == 24
    assert nov["previous"]["score"] == octo["summary"]["score"]
    assert nov["previous"]["winRate"] == octo["summary"]["winRate"]
    assert [t["period"] for t in nov["trend"]] == ["2026-10", "2026-11"]
    assert nov["trend"][-1]["score"] == nov["summary"]["score"]


def _archive_env(db_session, monkeypatch):
    from app.services import notification_feed, push_dispatch
    from app.services.persona import loop
    monkeypatch.setattr(loop, "SessionLocal", lambda: db_session)
    monkeypatch.setattr(db_session, "close", lambda: None)
    sent: dict = {"ws": [], "push": []}
    monkeypatch.setattr(notification_feed, "notify_ws_many", lambda ids: sent["ws"].append(list(ids)))
    monkeypatch.setattr(push_dispatch, "dispatch_users_push",
                        lambda ids, event, title, body, url, tag: (sent["push"].append((list(ids), event, title, url)),
                                                                   sent.setdefault("body", []).append(body)))
    return loop, sent


def test_archive_notifies_only_when_open_to_users_and_on_time(db_session, monkeypatch):
    """月报出炉通知：开关关着不发；开着且按时存档才发，人格变了换一种；晚于月底 6 小时补存的不发。"""
    from app.models import UserNotification
    loop, sent = _archive_env(db_session, monkeypatch)
    same = _user(db_session, "n1@t.co", "tok_n1")
    moved = _user(db_session, "n2@t.co", "tok_n2")
    for u in (same, moved):
        _seed(db_session, u, T0, n=24)
        service.status(db_session, u.id, T0 + timedelta(days=6))
    st = db_session.query(PersonaState).filter_by(user_id=moved.id).one()
    real = st.code
    flipped = ("R" if real[0] == "A" else "A") + real[1:]
    st.code = flipped                                            # 存档时会被算回 real → 人格变了
    db_session.commit()

    # 开关关着：照常存档，一条通知都没有
    res = loop.run_archive_pass(datetime(2026, 12, 1, 0, 30, tzinfo=timezone.utc))
    assert res["archived"] == 2
    assert db_session.query(UserNotification).count() == 0 and sent == {"ws": [], "push": []}

    # 第二个人的界面语言是英文（云端偏好里），推送应该用英文、月份写月份名
    from app.models import UserPref
    db_session.add(UserPref(user_id=moved.id, data='{"lang": {"lang": "en", "at": 1}}'))
    db_session.commit()

    # 开关开着、按时存档：一人一条，变了的是 persona_changed
    db_session.query(PersonaReport).delete()
    from app.models import PlatformSetting
    db_session.query(PlatformSetting).filter_by(key=loop.WATERMARK_KEY).delete()
    st.code = flipped
    db_session.commit()
    _admin_settings(db_session, persona_visible=True)
    res = loop.run_archive_pass(datetime(2026, 12, 1, 0, 40, tzinfo=timezone.utc))
    assert res["archived"] == 2
    rows = {n.user_id: n for n in db_session.query(UserNotification).all()}
    assert rows[same.id].kind == "persona_report" and rows[same.id].text == "2026-11"
    assert rows[moved.id].kind == "persona_changed" and rows[moved.id].text == f"{flipped} → {real} · 2026-11"
    assert all(n.link == "/persona" for n in rows.values())
    assert sorted(sent["ws"][0]) == sorted([same.id, moved.id])
    assert {(tuple(ids), ev) for ids, ev, _t, _u in sent["push"]} == {((same.id,), "persona_report"), ((moved.id,), "persona_report")}
    titles = {tuple(ids): t for ids, _e, t, _u in sent["push"]}
    assert titles[(same.id,)] == "交易报告出炉"                    # 没同步过语言 → 中文
    assert titles[(moved.id,)] == "Your trading persona changed"   # 英文用户、人格变了
    assert any("November" in b for b in sent["body"]) and any("11 月" in b for b in sent["body"])

    # 服务停过、月底 6 小时之后才补存：不发
    db_session.query(PersonaReport).delete()
    db_session.query(UserNotification).delete()
    db_session.query(PlatformSetting).filter_by(key=loop.WATERMARK_KEY).delete()
    db_session.commit()
    sent["ws"].clear(); sent["push"].clear(); sent.pop("body", None)
    res = loop.run_archive_pass(datetime(2026, 12, 1, 9, 0, tzinfo=timezone.utc))
    assert res["archived"] == 2
    assert db_session.query(UserNotification).count() == 0 and sent == {"ws": [], "push": []}
    _admin_settings(db_session, persona_visible=False)


def test_push_copy_covers_every_language_and_falls_back(db_session):
    """五种语言、两种文案都要有，月份要填进去；认不出的语言、读不出的偏好一律按中文。"""
    from app.models import UserPref
    from app.services.persona import loop
    for lang in loop.PUSH_LANGS:
        for kind in ("same", "changed"):
            title, body = loop.push_text(lang, kind, 3)
            assert title and body and "{m}" not in body
            assert ("March" if lang == "en" else "3") in body
    assert loop.push_text("xx", "same", 11) == loop.push_text("zh", "same", 11)
    a, b, c, d = (_user(db_session, f"l{i}@t.co", f"tok_l{i}") for i in range(4))
    db_session.add(UserPref(user_id=a.id, data='{"lang": {"lang": "ja"}}'))
    db_session.add(UserPref(user_id=b.id, data='{"lang": {"lang": "fr"}}'))      # 不支持的语言
    db_session.add(UserPref(user_id=c.id, data='not json'))                       # 坏数据
    db_session.commit()
    assert loop.user_langs(db_session, [a.id, b.id, c.id, d.id]) == {a.id: "ja", b.id: "zh", c.id: "zh", d.id: "zh"}


def test_periods():
    assert service.month_bounds("2026-12")[1] == datetime(2027, 1, 1, tzinfo=timezone.utc)
    assert service.previous_period("2026-01") == "2025-12"
    assert service.valid_period("2026-11") and not service.valid_period("2026-13") and not service.valid_period("x")


# ---------------------------------------------------------------- 接口与权限 / API and access
def _admin_settings(db, **patch):
    from app.services.settings_store import invalidate_gamification_cache, save_gamification_settings
    save_gamification_settings(db, patch); db.commit(); invalidate_gamification_cache()


def _client(db, who):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.core.database import get_db
    from app.core.rate_limit import limiter
    from app.routers import persona
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(persona.router, prefix="/api")
    from app.services import deps
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[deps.get_db] = lambda: db
    # 鉴权本身另有测试；这里直接指定当前用户。/ Auth is tested elsewhere; pin the caller here.
    app.dependency_overrides[deps.get_current_user] = lambda: who["user"]
    return TestClient(app)


@pytest.fixture()
def api_db():
    """接口用例要跨线程共用一个内存库（TestClient 在另一个线程里跑）。/ Shared in-memory DB across threads."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from app.core.database import Base
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    session = sessionmaker(bind=engine, autoflush=False)()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def test_api_gate_and_agent_access(api_db):
    db_session = api_db
    who: dict = {}
    client = _client(db_session, who)
    owner = _user(db_session, "agent@t.co", "tok_ag")
    other = _user(db_session, "other@t.co", "tok_ot")
    cust = _user(db_session, "cust@t.co", "tok_cu", agent_user_id=owner.id)
    stranger = _user(db_session, "str@t.co", "tok_st", agent_user_id=other.id)
    db_session.add(AgentNode(user_id=owner.id, depth=1)); db_session.commit()
    who["user"] = owner
    h: dict = {}
    # 总开关关着：普通用户 403
    assert client.get("/api/persona/me", headers=h).status_code == 403
    _admin_settings(db_session, persona_visible=True)
    assert client.get("/api/persona/me", headers=h).json()["status"] == "demo"
    assert client.get("/api/persona/me/report?period=bad", headers=h).status_code == 400
    # 没授权的推荐官看不了
    assert client.post("/api/persona/client", json={"email": "cust@t.co"}, headers=h).status_code == 403
    node = db_session.query(AgentNode).filter_by(user_id=owner.id).one()
    node.can_view_reports = True; db_session.commit()
    r = client.post("/api/persona/client", json={"email": "CUST@t.co"}, headers=h)
    assert r.status_code == 200 and r.json()["client"]["email"] == "cust@t.co"
    # 不是直属客户 → 404
    assert client.post("/api/persona/client", json={"email": "str@t.co"}, headers=h).status_code == 404
    assert stranger.id and cust.id
