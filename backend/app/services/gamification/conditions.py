"""六级闯关条件（设计 §2.2/§2.3）。条件定义不进数据库；等级由 user_tasks 派生。"""
from datetime import date, timedelta

from sqlalchemy.exc import IntegrityError

from app.models import MT5Account, UserActiveDay, UserStrategy, UserTask
from .stats import compute_comprehensive_stats

GROUPS = [
    ("qicheng",  ["set_nickname", "bind_account", "first_trades_5", "streak_3"]),
    ("fengmang", ["trade_days_30", "trades_100", "lots_10", "winrate_35"]),
    ("moli",     ["trade_days_100", "trades_500", "lots_100", "own_strategy", "winrate_50"]),
    ("zhizhang", ["trade_days_180", "trades_1000", "lots_1000", "profit_positive_5", "winrate_55"]),
    ("fengshen", ["trades_10000", "lots_10000", "profit_positive_6", "winrate_60"]),
]
LEVEL_TITLES = ["novice", "junior", "elite", "senior", "chief", "legend"]  # i18n key 尾段

WINRATE_CONDITIONS = {"winrate_35": 0.35, "winrate_50": 0.50,
                      "winrate_55": 0.55, "winrate_60": 0.60}
# 条件 id -> (stats 键, 目标值)。胜率条件目标值即门槛小数。
CONDITION_TARGETS = {
    "first_trades_5": ("trades_any", 5),
    "trade_days_30": ("trade_days", 30), "trades_100": ("trades", 100), "lots_10": ("lots", 10),
    "trade_days_100": ("trade_days", 100), "trades_500": ("trades", 500), "lots_100": ("lots", 100),
    "trade_days_180": ("trade_days", 180), "trades_1000": ("trades", 1000), "lots_1000": ("lots", 1000),
    "trades_10000": ("trades", 10000), "lots_10000": ("lots", 10000),
    "winrate_35": ("win_rate", 0.35), "winrate_50": ("win_rate", 0.50),
    "winrate_55": ("win_rate", 0.55), "winrate_60": ("win_rate", 0.60),
}


def has_consecutive_active_days(db, user_id, n: int) -> bool:
    rows = db.query(UserActiveDay.day).filter(UserActiveDay.user_id == user_id).all()
    days = sorted({date.fromisoformat(r[0]) for r in rows})
    run = 1
    for a, b in zip(days, days[1:]):
        run = run + 1 if b - a == timedelta(days=1) else 1
        if run >= n:
            return True
    return n <= 1 and bool(days)


def _judge_plain(db, user, cond_id, stats) -> bool:
    if cond_id == "set_nickname":
        return bool(user.nickname)
    if cond_id == "bind_account":
        return db.query(MT5Account.id).filter(MT5Account.user_id == user.id).first() is not None
    if cond_id == "streak_3":
        return has_consecutive_active_days(db, user.id, 3)
    if cond_id == "own_strategy":
        return (db.query(UserStrategy.id)
                  .filter(UserStrategy.user_id == user.id, UserStrategy.enabled.is_(True))
                  .first() is not None)
    if cond_id in ("profit_positive_5", "profit_positive_6"):
        return stats["profit"] > 0
    key, target = CONDITION_TARGETS[cond_id]
    return (stats[key] or 0) >= target


def _record(db, user_id, cond_id) -> bool:
    db.add(UserTask(user_id=user_id, task_id=cond_id))
    try:
        db.commit()
        return True
    except IntegrityError:
        db.rollback()
        return False


def judge_and_record_conditions(db, user_id) -> list[str]:
    from app.models import User
    user = db.get(User, user_id)
    if user is None:
        return []
    done = {t.task_id for t in db.query(UserTask).filter(UserTask.user_id == user_id)}
    stats = compute_comprehensive_stats(db, user_id)
    newly: list[str] = []
    for _gid, conds in GROUPS:
        # 第一遍：普通条件
        for c in conds:
            if c in done or c in WINRATE_CONDITIONS:
                continue
            if _judge_plain(db, user, c, stats) and _record(db, user_id, c):
                done.add(c); newly.append(c)
        # 第二遍：胜率毕业考——同组其余条件全完成才判定（§2.3；不加额外样本下限）
        for c in conds:
            if c not in WINRATE_CONDITIONS or c in done:
                continue
            others = [x for x in conds if x != c]
            if all(x in done for x in others):
                wr = stats["win_rate"]
                if wr is not None and wr > WINRATE_CONDITIONS[c] and _record(db, user_id, c):
                    done.add(c); newly.append(c)
    return newly


def level_of(done_ids: set[str]) -> int:
    level = 1
    for _gid, conds in GROUPS:
        if all(c in done_ids for c in conds):
            level += 1
        else:
            break
    return level


def condition_states(db, user_id, stats) -> list[dict]:
    """成就页数据：每组每条件的 done / 进度 / 胜率三态。"""
    done = {t.task_id: t.completed_at
            for t in db.query(UserTask).filter(UserTask.user_id == user_id)}
    out = []
    for gid, conds in GROUPS:
        items = []
        for c in conds:
            entry = {"id": c, "done": c in done}
            if c in CONDITION_TARGETS:
                key, target = CONDITION_TARGETS[c]
                entry["progressNow"] = round(stats.get(key) or 0, 4)
                entry["progressTarget"] = target
            if c in WINRATE_CONDITIONS:
                others_done = all(x in done for x in conds if x != c)
                entry["state"] = ("done" if c in done
                                 else "pending" if others_done else "locked")
                entry["currentWinRate"] = stats.get("win_rate")
            items.append(entry)
        out.append({"group": gid, "tasks": items})
    return out
