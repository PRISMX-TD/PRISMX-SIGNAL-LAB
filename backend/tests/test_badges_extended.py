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
from app.services.gamification.periods import week_key, month_key

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


# ---- 榜上有名（只看收益榜、只算封存周期）----

SEALED = datetime(2024, 3, 13, tzinfo=timezone.utc)      # 早已出窗


def _snap(db, u, board, key, rank, login="1"):
    db.add(LeaderboardSnapshot(board=board, period_key=key, user_id=u.id,
                               mt5_login=login, rank=rank, score=0.1, sample=20))
    db.commit()


def test_board_return_weekly_top10_is_bronze(db_session):
    u = _user(db_session, "bd1@t.co")
    _snap(db_session, u, "return_pct", week_key(SEALED), 10)
    assert "board_return:1" in judge_and_award_badges(db_session, u.id)


def test_board_return_rank_11_not_awarded(db_session):
    u = _user(db_session, "bd2@t.co")
    _snap(db_session, u, "return_pct", week_key(SEALED), 11)
    judge_and_award_badges(db_session, u.id)
    assert not {b for b in _owned(db_session, u.id) if b[0] == "board_return"}


def test_board_return_monthly_top10_silver_and_first_gold(db_session):
    u = _user(db_session, "bd3@t.co")
    _snap(db_session, u, "return_pct", month_key(SEALED), 7)
    assert "board_return:2" in judge_and_award_badges(db_session, u.id)
    _snap(db_session, u, "return_pct", "2024-04", 1)
    assert "board_return:3" in judge_and_award_badges(db_session, u.id)


def test_board_return_ignores_unsealed_current_period(db_session):
    u = _user(db_session, "bd4@t.co")
    _snap(db_session, u, "return_pct", month_key(NOW), 1)              # 进行中：不算
    judge_and_award_badges(db_session, u.id)
    assert not {b for b in _owned(db_session, u.id) if b[0] == "board_return"}


def test_board_return_ignores_winrate_board_and_competition_snapshots(db_session):
    u = _user(db_session, "bd5@t.co")
    _snap(db_session, u, "win_rate", month_key(SEALED), 1)              # 胜率榜第一：不算
    _snap(db_session, u, "return_pct", "comp:abc", 1)                   # 比赛快照：不算
    judge_and_award_badges(db_session, u.id)
    assert not {b for b in _owned(db_session, u.id) if b[0] == "board_return"}


# ---- 老将：完赛场次（只看出勤）----

T0 = datetime(2020, 1, 1, tzinfo=timezone.utc)


def _finished(db, u, n, status="settled", disqualified=False, rank=5):
    """给用户造 n 个"已完赛"参赛条目。"""
    for i in range(n):
        c = Competition(name=f"c{u.email}{i}", status=status,
                        starts_at=T0 + timedelta(days=30 * i), ends_at=T0 + timedelta(days=30 * i + 7))
        db.add(c); db.flush()
        db.add(CompetitionParticipant(competition_id=c.id, user_id=u.id, mt5_login=f"L{i}",
                                      final_rank=rank, final_score=0.1, disqualified=disqualified))
    db.commit()


def test_campaigner_bronze_at_three_finishes(db_session):
    u = _user(db_session, "cp1@t.co")
    _finished(db_session, u, 2)
    judge_and_award_badges(db_session, u.id)
    assert ("campaigner", 1) not in _owned(db_session, u.id)
    _finished(db_session, u, 1)
    assert "campaigner:1" in judge_and_award_badges(db_session, u.id)


def test_campaigner_ignores_unsettled_and_disqualified(db_session):
    u = _user(db_session, "cp2@t.co")
    _finished(db_session, u, 3, status="running")           # 未终审：final_rank 就算被写了也不算
    _finished(db_session, u, 3, disqualified=True)          # 取消资格：不算
    judge_and_award_badges(db_session, u.id)
    assert not {b for b in _owned(db_session, u.id) if b[0] == "campaigner"}


# ---- 常客：历史最长连续登录 ----

from app.services.gamification.conditions import longest_active_streak


def _active(db, u, start, n):
    for i in range(n):
        db.add(UserActiveDay(user_id=u.id, day=(start + timedelta(days=i)).date().isoformat()))
    db.commit()


def test_longest_active_streak_counts_best_run_even_if_broken_now(db_session):
    u = _user(db_session, "rg0@t.co")
    assert longest_active_streak(db_session, u.id) == 0
    _active(db_session, u, datetime(2025, 1, 1, tzinfo=timezone.utc), 30)   # 早已中断的 30 天
    _active(db_session, u, datetime(2025, 3, 1, tzinfo=timezone.utc), 4)
    assert longest_active_streak(db_session, u.id) == 30


def test_regular_bronze_at_seven_days(db_session):
    u = _user(db_session, "rg1@t.co")
    _active(db_session, u, datetime(2025, 1, 1, tzinfo=timezone.utc), 6)
    judge_and_award_badges(db_session, u.id)
    assert ("regular", 1) not in _owned(db_session, u.id)
    db_session.add(UserActiveDay(user_id=u.id, day="2025-01-07")); db_session.commit()
    assert "regular:1" in judge_and_award_badges(db_session, u.id)


def test_regular_gap_resets_the_run(db_session):
    u = _user(db_session, "rg2@t.co")
    _active(db_session, u, datetime(2025, 1, 1, tzinfo=timezone.utc), 4)
    _active(db_session, u, datetime(2025, 1, 6, tzinfo=timezone.utc), 4)     # 1 月 5 日缺席
    judge_and_award_badges(db_session, u.id)
    assert ("regular", 1) not in _owned(db_session, u.id)


def test_regular_silver_from_historical_run(db_session):
    u = _user(db_session, "rg3@t.co")
    _active(db_session, u, datetime(2025, 1, 1, tzinfo=timezone.utc), 30)
    assert "regular:2" in judge_and_award_badges(db_session, u.id)


# ---- 翻盘：亏损月后紧接的下一个月把亏的全赚回来 ----

from app.services.gamification.badge_judges import _has_comeback


def _month(offset):
    """当前月往前 offset 个月的 15 日（offset=0 是当前月）。"""
    y, m = NOW.year, NOW.month
    m -= offset
    while m <= 0:
        m += 12; y -= 1
    return datetime(y, m, 15, tzinfo=timezone.utc)


def test_has_comeback_pure():
    assert _has_comeback({(2025, 1): -200.0, (2025, 2): 200.0}) is True
    assert _has_comeback({(2025, 1): -200.0, (2025, 2): 150.0}) is False      # 没回本
    assert _has_comeback({(2025, 1): -200.0, (2025, 3): 500.0}) is False      # 隔了一个月
    assert _has_comeback({(2024, 12): -50.0, (2025, 1): 50.0}) is True        # 跨年相邻
    assert _has_comeback({(2025, 1): 10.0, (2025, 2): 20.0}) is False


def test_comeback_awarded_only_when_recovered(db_session):
    u = _user(db_session, "cb1@t.co")
    _fill(db_session, u, 1, profit=-200.0, closed_at=_month(2))
    _fill(db_session, u, 2, profit=150.0, closed_at=_month(1))
    db_session.commit()
    judge_and_award_badges(db_session, u.id)
    assert ("comeback", 0) not in _owned(db_session, u.id)
    _fill(db_session, u, 3, profit=50.0, closed_at=_month(1)); db_session.commit()   # 150 + 50 = 200
    assert "comeback" in judge_and_award_badges(db_session, u.id)


def test_comeback_ignores_current_month(db_session):
    u = _user(db_session, "cb2@t.co")
    _fill(db_session, u, 1, profit=-100.0, closed_at=_month(1))
    _fill(db_session, u, 2, profit=300.0, closed_at=_month(0))                # 当前月未结束
    db_session.commit()
    judge_and_award_badges(db_session, u.id)
    assert ("comeback", 0) not in _owned(db_session, u.id)
