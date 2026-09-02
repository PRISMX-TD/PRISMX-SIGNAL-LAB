from datetime import datetime, timedelta, timezone
from app.models import User, UserTask, UserActiveDay, MT5Account, UserStrategy
from app.services.gamification.conditions import (
    judge_and_record_conditions, level_of, has_consecutive_active_days, GROUPS)


def _user(db, **kw):
    u = User(email=kw.pop("email", "u@t.co"), api_token=kw.pop("tok", "tok_u"), **kw)
    db.add(u); db.commit(); return u


def test_level_prefix_rule():
    q = {"set_nickname", "bind_account", "first_trades_5", "streak_3"}
    f = {"trade_days_30", "trades_100", "lots_10", "winrate_35"}
    assert level_of(set()) == 1
    assert level_of(q) == 2
    assert level_of(q | f) == 3
    assert level_of(f) == 1          # 跳组不算：启程没完成就不是精英


def test_consecutive_days(db_session):
    u = _user(db_session)
    for d in ("2026-08-30", "2026-08-31", "2026-09-01"):
        db_session.add(UserActiveDay(user_id=u.id, day=d))
    db_session.commit()
    assert has_consecutive_active_days(db_session, u.id, 3)
    u2 = _user(db_session, email="v@t.co", tok="tok_v")
    for d in ("2026-08-28", "2026-08-30", "2026-09-01"):
        db_session.add(UserActiveDay(user_id=u2.id, day=d))
    db_session.commit()
    assert not has_consecutive_active_days(db_session, u2.id, 3)


def test_simple_conditions_and_idempotency(db_session):
    u = _user(db_session, nickname="Trader")
    db_session.add(MT5Account(user_id=u.id, login="1", server="s")); db_session.commit()
    new = judge_and_record_conditions(db_session, u.id)
    assert "set_nickname" in new and "bind_account" in new
    assert judge_and_record_conditions(db_session, u.id) == []  # 幂等


def test_winrate_locked_until_group_done(db_session, monkeypatch):
    u = _user(db_session, nickname="T")
    # 伪造综合数据：胜率 40%（>35%），但锋芒组其余条件未全达标
    fake = {"trades": 40, "wins": 16, "losses": 24, "win_rate": 0.4, "lots": 5,
            "trade_days": 10, "profit": 1.0, "trades_any": 40, "per_login": {},
            "window_days": 365}
    import app.services.gamification.conditions as C
    monkeypatch.setattr(C, "compute_comprehensive_stats", lambda db, uid: fake)
    judge_and_record_conditions(db_session, u.id)
    done = {t.task_id for t in db_session.query(UserTask).filter_by(user_id=u.id)}
    assert "winrate_35" not in done          # 锁定：trades_100/lots_10/trade_days_30 未齐
    fake.update({"trades": 100, "wins": 40, "lots": 10, "trade_days": 30})
    judge_and_record_conditions(db_session, u.id)
    done = {t.task_id for t in db_session.query(UserTask).filter_by(user_id=u.id)}
    assert "winrate_35" in done              # 同组其余齐了 → 当轮判定并锁定
