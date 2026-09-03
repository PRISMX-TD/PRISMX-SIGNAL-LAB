# 仪表盘胜率卡摘要端点（设计 §2.4/§7）：GET /gamification/winrate-summary。
# Dashboard win-rate-card summary endpoint (§2.4/§7): GET /gamification/winrate-summary.
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from app.models import ClosedTrade, Order, User, UserTask
from app.routers.gamification import (
    build_winrate_summary_payload, require_gamification_visible)
from app.services.gamification.conditions import GROUPS
from app.services.settings_store import save_gamification_settings, invalidate_gamification_cache

NOW = datetime.now(timezone.utc)

QICHENG = GROUPS[0][1]   # ["set_nickname", "bind_account", "first_trades_5", "streak_3"]
ALL_TASK_IDS = [c for _gid, conds in GROUPS for c in conds]


def _user(db, **kw):
    u = User(email=kw.pop("email", "w@t.co"), api_token=kw.pop("tok", "tok_w"), **kw)
    db.add(u); db.commit(); return u


def _mark_done(db, user_id, task_ids):
    for tid in task_ids:
        db.add(UserTask(user_id=user_id, task_id=tid))
    db.commit()


def _fill_and_close(db, u, login, ticket, profit, vol=0.1, days_ago=1):
    o = Order(user_id=u.id, client_order_id=f"c{ticket}", symbol="XAUUSD", side="BUY",
              volume=vol, status="FILLED", mt5_login=login, mt5_ticket=ticket, trade_mode=2,
              created_at=NOW - timedelta(days=days_ago))
    db.add(o)
    db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="XAUUSD", side="BUY",
                       close_volume=vol, close_price=1.0, profit=profit,
                       position_ticket=ticket, deal_ticket=ticket * 10,
                       closed_at=NOW - timedelta(days=days_ago), verified=True))
    db.commit()


def test_payload_shape_fresh_user(db_session):
    u = _user(db_session)
    p = build_winrate_summary_payload(db_session, u)
    assert set(p.keys()) == {
        "winRate", "windowDays", "trades", "level", "title",
        "nextWinRateTarget", "gapPct"}
    assert p["level"] == 1 and p["title"] == "novice"
    assert p["windowDays"] == 365
    assert p["trades"] == 0 and p["winRate"] is None
    # qicheng（第一组）没有胜率条件——刚起步的用户下一关不涉及胜率，
    # target/gap 都应是 None，不是 0。
    # qicheng (the first group) carries no win-rate condition — a
    # brand-new user's next milestone doesn't involve win rate at all,
    # so target/gap must be None, not 0.
    assert p["nextWinRateTarget"] is None and p["gapPct"] is None


def test_gap_computed_when_below_target(db_session):
    u = _user(db_session, email="gap@t.co", tok="tok_gap")
    _mark_done(db_session, u.id, QICHENG)   # 进阶到锋芒组（winrate_35）
    # 1 胜 4 负 => win_rate 0.20，低于锋芒组门槛 0.35
    _fill_and_close(db_session, u, "500123", 1, 5.0)
    for i in range(2, 6):
        _fill_and_close(db_session, u, "500123", i, -1.0)
    p = build_winrate_summary_payload(db_session, u)
    assert p["level"] == 2 and p["trades"] == 5
    assert p["winRate"] == pytest.approx(0.2)
    assert p["nextWinRateTarget"] == 0.35
    assert p["gapPct"] == pytest.approx(15.0)


def test_gap_zero_when_target_met(db_session):
    u = _user(db_session, email="met@t.co", tok="tok_met")
    _mark_done(db_session, u.id, QICHENG)
    for i in range(1, 6):   # 4 胜 1 负 => 0.8，早已超过 0.35 门槛
        _fill_and_close(db_session, u, "500123", i, 5.0 if i <= 4 else -1.0)
    p = build_winrate_summary_payload(db_session, u)
    assert p["nextWinRateTarget"] == 0.35
    assert p["gapPct"] == 0.0


def test_max_level_has_no_next_target(db_session):
    u = _user(db_session, email="max@t.co", tok="tok_max")
    _mark_done(db_session, u.id, ALL_TASK_IDS)
    p = build_winrate_summary_payload(db_session, u)
    assert p["level"] == 6 and p["title"] == "legend"
    assert p["nextWinRateTarget"] is None and p["gapPct"] is None


def test_visibility_gate(db_session):
    invalidate_gamification_cache()
    u = _user(db_session, email="plain@t.co", tok="tok_plain")
    with pytest.raises(HTTPException) as e:
        require_gamification_visible(db=db_session, user=u)
    assert e.value.status_code == 403
    admin = _user(db_session, email="admin@t.co", tok="tok_admin", role="admin")
    require_gamification_visible(db=db_session, user=admin)   # admin 直通不抛
    save_gamification_settings(db_session, {"user_visible": True})
    db_session.commit(); invalidate_gamification_cache()
    require_gamification_visible(db=db_session, user=u)       # 开关开了不抛
    invalidate_gamification_cache()


def test_cache_hit_then_recompute_after_ttl(db_session, monkeypatch):
    import app.routers.gamification as G
    u = _user(db_session, email="cache@t.co", tok="tok_cache")
    calls = []
    real_compute = G.compute_comprehensive_stats

    def _spy(db, user_id):
        calls.append(user_id)
        return real_compute(db, user_id)
    monkeypatch.setattr(G, "compute_comprehensive_stats", _spy)

    p1 = build_winrate_summary_payload(db_session, u)
    p2 = build_winrate_summary_payload(db_session, u)   # 60 秒内命中缓存
    assert p1 is p2
    assert len(calls) == 1

    # 把缓存时间戳拨回 61 秒前，模拟 TTL 过期后应重新计算。
    # Push the cached timestamp back 61s to simulate TTL expiry -> recompute.
    ts, payload = G._summary_cache[u.id]
    G._summary_cache[u.id] = (ts - 61, payload)
    p3 = build_winrate_summary_payload(db_session, u)
    assert len(calls) == 2
    assert p3 is not p1
