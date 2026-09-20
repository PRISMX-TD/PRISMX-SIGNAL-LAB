"""六级闯关条件（设计 §2.2/§2.3）。条件定义不进数据库；等级由 user_tasks 派生。"""
from datetime import date, datetime, timedelta, timezone

from sqlalchemy.exc import IntegrityError

from app.models import MT5Account, UserActiveDay, UserStrategy, UserTask
from . import periods
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
# 条件 id -> (stats 键, 目标值)。
# 胜率条件**不在**这张表里：它们走 `judge_and_record_conditions` 的第二遍
# （毕业考，要同组其余条件全完成才开考），`_judge_plain` 永远见不到它们——
# 第一遍循环开头就 `continue` 掉了。这里原本躺着 winrate_35/50/55/60 四条，
# 从来没有被读到过，纯死代码；留着的坏处是它给人一种「胜率也走 _judge_plain」
# 的错觉，而那条路径用的是 `>=`，与毕业考的判定并不是同一套代码。判定口径统一
# 由 WINRATE_CONDITIONS 一处提供。
# Win-rate conditions are deliberately absent: they take the second pass in
# judge_and_record_conditions (the graduation exam, gated on the rest of the
# group) and never reach _judge_plain, which `continue`s past them. The four
# winrate entries that used to sit here were unreachable dead code whose only
# effect was to suggest a second, `>=`-based code path for win rate that isn't
# actually used. WINRATE_CONDITIONS is the single source for those thresholds.
CONDITION_TARGETS = {
    "first_trades_5": ("trades_any", 5),
    "trade_days_30": ("trade_days", 30), "trades_100": ("trades", 100), "lots_10": ("lots", 10),
    "trade_days_100": ("trade_days", 100), "trades_500": ("trades", 500), "lots_100": ("lots", 100),
    "trade_days_180": ("trade_days", 180), "trades_1000": ("trades", 1000), "lots_1000": ("lots", 1000),
    "trades_10000": ("trades", 10000), "lots_10000": ("lots", 10000),
}


def longest_active_streak(db, user_id) -> int:
    """历史最长连续活跃天数（UTC 日历日）。无记录为 0。等级条件 streak_3 与
    常客勋章共用。
    Longest run of consecutive active days ever (UTC calendar days); 0 if none.
    Shared by the streak_3 level condition and the regular badge."""
    rows = db.query(UserActiveDay.day).filter(UserActiveDay.user_id == user_id).all()
    days = sorted({date.fromisoformat(r[0]) for r in rows})
    if not days:
        return 0
    best = run = 1
    for a, b in zip(days, days[1:]):
        run = run + 1 if b - a == timedelta(days=1) else 1
        best = max(best, run)
    return best


def has_consecutive_active_days(db, user_id, n: int) -> bool:
    return longest_active_streak(db, user_id) >= n


def current_active_streak(db, user_id, today: date | None = None) -> int:
    """成就页进度用：以今天（UTC）或昨天为锚，往回数连续活跃天数。
    最近一次活跃早于昨天 → 连续已断，返回 0；今天还没来但昨天来过 → 仍算延续
    （今天还有机会接上）。判定本身仍走 has_consecutive_active_days（任意历史窗口）。
    Progress for the achievements page: anchored on today (UTC) or yesterday,
    count back the run of consecutive active days. Last activity before
    yesterday → the run is broken → 0; not yet today but active yesterday →
    still alive (today can extend it). Judging itself still uses
    has_consecutive_active_days over any historical window."""
    # 「今天」同样走游戏化日历的唯一出处，与 UserActiveDay.day 的写入口径
    # （UTC 自然日）严格同尺；就地写 datetime.now(timezone.utc).date() 也对，
    # 但那是第二处日历规则，改口径时必然漏掉一处。
    # "Today" comes from the one gamification calendar helper, on the same ruler
    # as UserActiveDay.day; spelling it out here would be a second copy of the
    # rule and the one a future change forgets.
    today = today or periods.today()
    rows = db.query(UserActiveDay.day).filter(UserActiveDay.user_id == user_id).all()
    days = {date.fromisoformat(r[0]) for r in rows}
    anchor = today if today in days else today - timedelta(days=1)
    if anchor not in days:
        return 0
    run = 0
    while anchor in days:
        run += 1
        anchor -= timedelta(days=1)
    return run


def _judge_plain(db, user, cond_id, stats) -> bool:
    if cond_id == "set_nickname":
        return bool(user.nickname)
    if cond_id == "bind_account":
        from app.services.gateway_binding import not_removed
        return (db.query(MT5Account.id)
                  .filter(MT5Account.user_id == user.id, not_removed()).first() is not None)
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


def judge_and_record_conditions(db, user_id, stats: dict | None = None) -> list[str]:
    """`stats` 可由调用方预先算好传入（每小时循环与勋章判定共用一份，见
    stats.load_trade_data）；不传就自己算，结果一样。
    `stats` may be precomputed by the caller (the hourly pass shares one with the
    badge judge, see stats.load_trade_data); omitted, it is computed here."""
    from app.models import User
    user = db.get(User, user_id)
    if user is None:
        return []
    done = {t.task_id for t in db.query(UserTask).filter(UserTask.user_id == user_id)}
    if stats is None:
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
                # `>=` 而不是 `>`：`condition_states` 下发的 progressTarget 就是
                # 这个门槛值本身，胜率**恰好**等于门槛时前端进度条画到 100%，
                # 严判 `>` 会让用户看着满格的条却拿不到那一关。两处口径必须同一个
                # 方向，取「够到即算过」这一边（门槛是「达到 35%」不是「超过 35%」）。
                # `>=`, not `>`: condition_states hands the frontend this very
                # number as progressTarget, so a win rate exactly on the threshold
                # draws a full bar. A strict `>` left the user staring at a full
                # bar that never completed. The two must agree, and "reaching the
                # bar passes" is the reading the thresholds are named for.
                if wr is not None and wr >= WINRATE_CONDITIONS[c] and _record(db, user_id, c):
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


# 成就页每条任务的「进度种类」：前端据此选单位与画法。
# boolean = 一次性动作（0/1）；days/trades/lots = 计数；profit = 盈亏正负；winrate = 毕业考。
# Progress "kind" per task for the achievements page — the frontend picks
# units and bar style from it. boolean = one-shot action (0/1); days / trades /
# lots = counters; profit = sign of realised P&L; winrate = graduation exam.
_BOOLEAN_CONDITIONS = ("set_nickname", "bind_account", "own_strategy")
_KIND_BY_STATS_KEY = {"trades_any": "trades", "trades": "trades", "lots": "lots", "trade_days": "days"}
STREAK_TARGET = 3


def condition_states(db, user_id, stats, today: date | None = None) -> list[dict]:
    """成就页数据：每组每条件的 done / 进度 / 胜率三态。每条任务都带 kind +
    progressNow/progressTarget，成就页给全部任务画进度条。
    Achievements page data: done / progress / win-rate state per condition in
    every group. Every task carries kind + progressNow/progressTarget so the
    page can draw a bar for all of them."""
    from app.models import User
    user = db.get(User, user_id)
    done = {t.task_id: t.completed_at
            for t in db.query(UserTask).filter(UserTask.user_id == user_id)}
    streak = None
    out = []
    for gid, conds in GROUPS:
        items = []
        for c in conds:
            entry = {"id": c, "done": c in done}
            if c in WINRATE_CONDITIONS:
                others_done = all(x in done for x in conds if x != c)
                entry["kind"] = "winrate"
                entry["progressNow"] = round(stats.get("win_rate") or 0, 4)
                entry["progressTarget"] = WINRATE_CONDITIONS[c]
                entry["state"] = ("done" if c in done
                                  else "pending" if others_done else "locked")
                entry["currentWinRate"] = stats.get("win_rate")
            elif c in _BOOLEAN_CONDITIONS:
                met = c in done or (user is not None and _judge_plain(db, user, c, stats))
                entry["kind"] = "boolean"
                entry["progressNow"] = 1 if met else 0
                entry["progressTarget"] = 1
            elif c == "streak_3":
                if streak is None:
                    streak = current_active_streak(db, user_id, today)
                entry["kind"] = "days"
                entry["progressNow"] = STREAK_TARGET if c in done else streak
                entry["progressTarget"] = STREAK_TARGET
            elif c in ("profit_positive_5", "profit_positive_6"):
                entry["kind"] = "profit"
                entry["progressNow"] = round(stats.get("profit") or 0, 2)
                entry["progressTarget"] = 0
            else:
                key, target = CONDITION_TARGETS[c]
                entry["kind"] = _KIND_BY_STATS_KEY[key]
                entry["progressNow"] = round(stats.get(key) or 0, 4)
                entry["progressTarget"] = target
            items.append(entry)
        out.append({"group": gid, "tasks": items})
    return out
