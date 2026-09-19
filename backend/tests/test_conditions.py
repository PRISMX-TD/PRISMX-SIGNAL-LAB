from datetime import datetime, timedelta, timezone
from app.models import User, UserTask, UserActiveDay, MT5Account, UserStrategy
from app.services.gamification.conditions import (
    judge_and_record_conditions, level_of, has_consecutive_active_days, GROUPS,
    current_active_streak, condition_states)


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


def test_winrate_exactly_at_bar_passes(db_session, monkeypatch):
    """胜率恰好等于门槛判过（`>=`）。

    `condition_states` 下发的 progressTarget 就是这个门槛值本身，等号那一格进度
    条画满格；判定若用严判 `>`，用户会看着满格的条却拿不到那一关。2026-09-19
    起判定、进度条、胜率摘要三处统一成「够到即算过」。
    Exactly at the bar passes: condition_states hands the frontend this same
    number as progressTarget, so a strict `>` left a full bar that never
    completed. Judging, the bar and the summary all read `>=` since 2026-09-19.
    """
    u = _user(db_session, nickname="T")
    # 锋芒组其余三条已达标，胜率恰好 0.35（门槛值本身）
    fake = {"trades": 100, "wins": 35, "losses": 65, "win_rate": 0.35, "lots": 10,
            "trade_days": 30, "profit": 1.0, "trades_any": 100, "per_login": {},
            "window_days": 365}
    import app.services.gamification.conditions as C
    monkeypatch.setattr(C, "compute_comprehensive_stats", lambda db, uid: fake)
    judge_and_record_conditions(db_session, u.id)
    done = {t.task_id for t in db_session.query(UserTask).filter_by(user_id=u.id)}
    assert "winrate_35" in done

    # 差一点点（0.3499）仍然不过——`>=` 放行的只是等号那一格，不是「接近」
    u2 = _user(db_session, email="below@t.co", tok="tok_below", nickname="T2")
    fake["win_rate"] = 0.3499
    judge_and_record_conditions(db_session, u2.id)
    done2 = {t.task_id for t in db_session.query(UserTask).filter_by(user_id=u2.id)}
    assert "winrate_35" not in done2


def test_condition_targets_has_no_unreachable_winrate_entries(db_session):
    """CONDITION_TARGETS 里不该再有胜率项：`_judge_plain` 永远见不到胜率条件
    （第一遍循环就 continue 掉了），那四条是不可达的死代码，且用的是与毕业考
    不同的判定路径，留着只会误导。"""
    from app.services.gamification.conditions import CONDITION_TARGETS, WINRATE_CONDITIONS
    assert not (set(CONDITION_TARGETS) & set(WINRATE_CONDITIONS))
    # 非胜率条件一条不少：condition_states 的 else 分支要按 id 取值，漏一条就 KeyError
    non_winrate = {c for _gid, conds in GROUPS for c in conds} - set(WINRATE_CONDITIONS)
    covered = set(CONDITION_TARGETS) | {
        "set_nickname", "bind_account", "own_strategy", "streak_3",
        "profit_positive_5", "profit_positive_6"}
    assert non_winrate <= covered


def test_current_active_streak_anchors_on_today_or_yesterday(db_session):
    from datetime import date
    today = date(2026, 9, 4)
    u = _user(db_session)
    for d in ("2026-09-02", "2026-09-03", "2026-09-04"):
        db_session.add(UserActiveDay(user_id=u.id, day=d))
    db_session.commit()
    assert current_active_streak(db_session, u.id, today) == 3
    # 今天还没来、昨天来过：连续仍在延续 / not yet today, active yesterday → still alive
    u2 = _user(db_session, email="v@t.co", tok="tok_v")
    for d in ("2026-09-02", "2026-09-03"):
        db_session.add(UserActiveDay(user_id=u2.id, day=d))
    db_session.commit()
    assert current_active_streak(db_session, u2.id, today) == 2
    # 最近一次早于昨天：已断 / last activity before yesterday → broken
    u3 = _user(db_session, email="w@t.co", tok="tok_w")
    for d in ("2026-08-30", "2026-08-31", "2026-09-01"):
        db_session.add(UserActiveDay(user_id=u3.id, day=d))
    db_session.commit()
    assert current_active_streak(db_session, u3.id, today) == 0
    assert current_active_streak(db_session, _user(db_session, email="x@t.co", tok="tok_x").id, today) == 0


def test_condition_states_progress_on_every_task(db_session):
    from datetime import date
    today = date(2026, 9, 4)
    u = _user(db_session, nickname="T")
    db_session.add(MT5Account(user_id=u.id, login="1", server="s"))
    for d in ("2026-09-03", "2026-09-04"):
        db_session.add(UserActiveDay(user_id=u.id, day=d))
    db_session.commit()
    stats = {"trades": 12, "wins": 5, "losses": 7, "win_rate": 5 / 12, "lots": 1.5,
             "trade_days": 4, "profit": -12.345, "trades_any": 12, "per_login": {},
             "window_days": 365}
    groups = condition_states(db_session, u.id, stats, today)
    by_id = {t["id"]: t for g in groups for t in g["tasks"]}
    assert all("kind" in t and "progressNow" in t and "progressTarget" in t for t in by_id.values())
    assert by_id["set_nickname"] == {"id": "set_nickname", "done": False, "kind": "boolean",
                                     "progressNow": 1, "progressTarget": 1}
    assert by_id["own_strategy"]["progressNow"] == 0
    assert by_id["streak_3"]["kind"] == "days"
    assert (by_id["streak_3"]["progressNow"], by_id["streak_3"]["progressTarget"]) == (2, 3)
    assert by_id["first_trades_5"]["kind"] == "trades" and by_id["first_trades_5"]["progressNow"] == 12
    assert by_id["lots_10"]["kind"] == "lots" and by_id["trade_days_30"]["kind"] == "days"
    assert by_id["profit_positive_5"] == {"id": "profit_positive_5", "done": False, "kind": "profit",
                                          "progressNow": -12.35, "progressTarget": 0}
    w = by_id["winrate_35"]
    assert w["kind"] == "winrate" and w["state"] == "locked" and w["progressTarget"] == 0.35
    assert w["progressNow"] == round(5 / 12, 4)
    # 记录后：三日之约进度封顶到目标 / once recorded, the streak shows target/target
    db_session.add(UserTask(user_id=u.id, task_id="streak_3")); db_session.commit()
    groups = condition_states(db_session, u.id, stats, today)
    s3 = next(t for g in groups for t in g["tasks"] if t["id"] == "streak_3")
    assert s3["done"] and s3["progressNow"] == 3
