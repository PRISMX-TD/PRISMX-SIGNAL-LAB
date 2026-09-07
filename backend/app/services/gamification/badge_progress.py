"""勋章进度（成就页进度条用，2026-09-07）。

只回答"离下一档还差多少"这一个问题，不参与判定。判定在 badge_judges.py，只升不降；
这里的数值可以往回走（连续登录断了、连续盈利月断了），因为它描述的是**现在**的
状态，而勋章记的是**曾经**达到过的档。

只有"数到某个数"的条件才有进度：常客（当前连续登录天数）、老兵（累计实盘平仓
笔数）、老将（完赛场次）、常青（当前连续盈利月数）、胜手（每档取主指标：盈利单数 /
笔数 / 近一年笔数，手数与盈亏门槛不进度条，靠文案说明）。事件型勋章（起步 / 赛场 /
卫冕王 / 翻盘 / 创始元老）与名次型（榜上有名）没有进度，返回 None。

Badge progress for the achievements page: "how far to the next tier", never
"is it earned". Judging lives in badge_judges.py and only moves up; these
values may move backwards (a broken streak) because they describe *now*.
Only count-to-a-number conditions have progress; event- and rank-based
badges return None.
"""
from datetime import datetime, timedelta, timezone

from .badge_judges import (
    CAMPAIGNER_THRESHOLDS, REGULAR_THRESHOLDS, VETERAN_THRESHOLDS,
    _monthly_real_profit, _next_month, _resolved_real_positions, finished_competition_count,
)


def _prev_month(key: tuple[int, int]) -> tuple[int, int]:
    y, m = key
    return (y - 1, 12) if m == 1 else (y, m - 1)


def evergreen_current_run(monthly: dict[tuple[int, int], float], now: datetime | None = None) -> int:
    """从最近一个**已结束**的月份往回数连续盈利月。最近那个月没交易或亏损 → 0。
    与 _evergreen_months（历史最长段）不同，这是"现在还活着的一段"。
    Count consecutive profitable months backwards from the most recent
    *completed* month; 0 if that month is missing or losing. Unlike
    _evergreen_months (best run ever), this is the run that is alive now."""
    now = now or datetime.now(timezone.utc)
    key = _prev_month((now.year, now.month))
    run = 0
    while monthly.get(key, 0.0) > 0:
        run += 1
        key = _prev_month(key)
    return run


# ---- 各勋章的取值函数：(db, user, ctx) -> int ----

def _v_regular(db, user, ctx) -> int:
    from .conditions import current_active_streak
    return current_active_streak(db, user.id)


def _v_veteran(db, user, ctx) -> int:
    return sum(a["trades"] for a in ctx["lifetime"].values())


def _v_campaigner(db, user, ctx) -> int:
    return finished_competition_count(db, user.id)


def _v_evergreen(db, user, ctx) -> int:
    return evergreen_current_run(_monthly_real_profit(db, user.id, ctx.get("data")))


def _v_max_wins(db, user, ctx) -> int:
    return max((a["wins"] for a in ctx["lifetime"].values()), default=0)


def _v_max_trades(db, user, ctx) -> int:
    return max((a["trades"] for a in ctx["lifetime"].values()), default=0)


def _v_window_trades(db, user, ctx) -> int:
    from .stats import GAMIFICATION_WINDOW_DAYS
    cutoff = datetime.now(timezone.utc) - timedelta(days=GAMIFICATION_WINDOW_DAYS)
    return len(_resolved_real_positions(db, user.id, cutoff, data=ctx.get("data")))


# 勋章 id → 三档各自的 (取值函数, 目标值, 单位)。单位是前端 i18n
# gamification.progressUnit.<unit> 的键。同一枚三档共用取值函数时只算一次。
# Badge id -> per-tier (value fn, target, unit). Unit is an i18n key.
PROGRESS: dict[str, list[tuple]] = {
    "regular": [(_v_regular, n, "days") for n in REGULAR_THRESHOLDS],
    "veteran": [(_v_veteran, n, "trades") for n in VETERAN_THRESHOLDS],
    "campaigner": [(_v_campaigner, n, "comps") for n in CAMPAIGNER_THRESHOLDS],
    "evergreen": [(_v_evergreen, n, "months") for n in (3, 6, 12)],
    "winning_hand": [(_v_max_wins, 100, "wins"), (_v_max_trades, 500, "trades"), (_v_window_trades, 100, "trades")],
}


def badge_progress(db, user, ctx) -> dict[str, list[dict] | None]:
    """{badge_id: [{value, target, unit} × 3] | None}。每个取值函数每人只跑一次。
    Per-badge per-tier progress; each value fn runs once per user."""
    cache: dict = {}
    out: dict[str, list[dict] | None] = {}
    for bid, tiers in PROGRESS.items():
        rows = []
        for fn, target, unit in tiers:
            if fn not in cache:
                cache[fn] = fn(db, user, ctx)
            rows.append({"value": cache[fn], "target": target, "unit": unit})
        out[bid] = rows
    return out
