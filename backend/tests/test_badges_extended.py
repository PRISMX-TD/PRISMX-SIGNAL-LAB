"""勋章扩充（2026-09-07）：五枚新勋章的判定 + 注册表 shelf 结构。

每枚新勋章的失败方式都是静默的（该发不发、不该发却发），所以每条口径边界
单独钉一条：门槛差一、口径外的数据（模拟盘 / 胜率榜 / 比赛快照 / 未封存周期 /
取消资格 / 当前月）一律不算。
"""
from datetime import datetime, timedelta, timezone

from app.models import (
    User, Order, ClosedTrade, UserBadge, UserActiveDay,
    LeaderboardSnapshot, Competition, CompetitionParticipant,
)
from app.services.gamification.badges import BADGES, SHELVES, badge_display_name, judge_and_award_badges

NOW = datetime.now(timezone.utc)


def _user(db, email="x@t.co", **kw):
    u = User(email=email, api_token="tok_" + email, **kw)
    db.add(u); db.commit(); return u


def _owned(db, user_id):
    return {(b.badge_id, b.tier) for b in db.query(UserBadge).filter_by(user_id=user_id)}


def test_registry_shelves_are_explicit():
    for bid, meta in BADGES.items():
        assert meta["shelf"] in SHELVES, bid
        if meta["shelf"] == "tiered":
            assert meta["max_tier"] == 3 and (meta["judges"] is None or len(meta["judges"]) == 3), bid
        else:
            assert meta["max_tier"] == 0, bid
        if meta["shelf"] == "limited":
            assert isinstance(meta["closes_at"], datetime) and meta["closes_at"].tzinfo is not None, bid
        else:
            assert meta.get("closes_at") is None, bid
    assert BADGES["comp_back_to_back"]["shelf"] == "special"
    assert BADGES["founder_2026"]["shelf"] == "limited"


def _fill(db, u, ticket, login="1", profit=1.0, trade_mode=2, closed_at=None):
    """一笔已核验整仓平仓。trade_mode 2 = 实盘，0 = 模拟。"""
    ts = closed_at or NOW
    db.add(Order(user_id=u.id, client_order_id=f"c{login}-{ticket}", symbol="X", side="BUY",
                 volume=0.1, status="FILLED", mt5_login=login, mt5_ticket=ticket,
                 trade_mode=trade_mode, created_at=ts - timedelta(hours=1)))
    db.add(ClosedTrade(user_id=u.id, mt5_login=login, symbol="X", side="BUY",
                       close_volume=0.1, close_price=1, profit=profit,
                       position_ticket=ticket, deal_ticket=ticket * 10 + int(login),
                       closed_at=ts, verified=True))


# ---- 老兵 ----

def test_veteran_bronze_at_exactly_100_real_closes(db_session):
    u = _user(db_session, "vet1@t.co")
    for i in range(1, 100):
        _fill(db_session, u, i)
    db_session.commit()
    assert "veteran:1" not in judge_and_award_badges(db_session, u.id)      # 99 笔不发
    _fill(db_session, u, 100); db_session.commit()
    assert "veteran:1" in judge_and_award_badges(db_session, u.id)          # 第 100 笔发铜


def test_veteran_ignores_demo_closes(db_session):
    u = _user(db_session, "vet2@t.co")
    for i in range(1, 101):
        _fill(db_session, u, i, trade_mode=0)
    db_session.commit()
    assert not {b for b in _owned(db_session, u.id) if b[0] == "veteran"}
    judge_and_award_badges(db_session, u.id)
    assert ("veteran", 1) not in _owned(db_session, u.id)


def test_veteran_sums_across_accounts(db_session):
    u = _user(db_session, "vet3@t.co")
    for i in range(1, 61):
        _fill(db_session, u, i, login="1")
        _fill(db_session, u, i, login="2")
    db_session.commit()
    assert "veteran:1" in judge_and_award_badges(db_session, u.id)          # 60 + 60 = 120 ≥ 100
