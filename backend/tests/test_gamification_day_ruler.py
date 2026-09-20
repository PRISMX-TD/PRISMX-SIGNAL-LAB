"""游戏化日历只有一把尺：UTC 自然日，出处是 `gamification/periods.py`。

审计（2026-09-19）记了一条「游戏化按 UTC 切天，与看板的 STATS_TZ 不同源」。
2026-09-20 复核后的结论是**维持 UTC，但把切天动作收到一处**：

  · `UserActiveDay.day` 由 `services/deps._touch_last_active` 按 UTC 写，
    `longest_active_streak` / `current_active_streak`（「三日之约」）直接读它；
    `periods.week_key` / `month_key` 也在 UTC 上。
  · 只把 `stats.trade_days` 改成 STATS_TZ，会在游戏化**内部**劈出第二把尺
    （UTC 的活跃日 + 上海时区的交易日），比现状更糟。
  · 要统一就得连 deps 的写入口径一起改，还要决定存量 `user_active_days` 回不回填、
    已发勋章与已判等级复不复核——跨模块的产品决策，不是这一层能定的。

所以这里钉住两件事：**切天规则只有一份实现**，以及**它是 UTC**。将来产品真要切到
STATS_TZ，这些用例会当场变红，提醒改动者那是一次有存量影响的口径变更，而不是改一行。

One ruler for the gamification calendar: UTC, sourced from periods.py.
"""
from datetime import datetime, timedelta, timezone

import pytest

from app.services.gamification import periods, stats


def _order(created_at):
    """窗口内的一笔实盘 FILLED 开仓单。只构造 trade_days 需要的那几个字段——
    `_resolve` 要 position id，没有平仓腿时该仓位不计入胜率，但 lots/trade_days
    照常统计（见 test_comprehensive_stats 的同款断言）。
    A filled in-window real order, with just the fields trade_days needs."""
    from app.models import Order
    return Order(
        user_id="u1", client_order_id=f"c{created_at.isoformat()}", symbol="XAUUSD",
        side="BUY", volume=1.0, status="FILLED", mt5_login="500123",
        mt5_ticket=1, trade_mode=stats.REAL, created_at=created_at,
    )


def test_day_key_is_utc_not_local():
    """北京时间 2026-09-21 07:30 = UTC 2026-09-20 23:30，游戏化记在 09-20。

    这正是两把尺会差一天的那个窗口：UTC 16:00-24:00（北京次日 00:00-08:00）。
    对合作券商的交易时段来说这段恰好覆盖纽约盘，不是冷门时间——所以改口径的
    影响面不小，值得一条明写的用例。
    """
    assert periods.day_key(datetime(2026, 9, 20, 23, 30, tzinfo=timezone.utc)) == "2026-09-20"
    beijing = timezone(timedelta(hours=8))
    assert periods.day_key(datetime(2026, 9, 21, 7, 30, tzinfo=beijing)) == "2026-09-20"


def test_day_key_reads_naive_values_as_utc():
    """库里的 DateTime 全是 naive UTC；同一时刻无论 naive 还是 aware 传进来都是同一天。
    Naive values (as every DateTime column stores them) read as UTC."""
    naive = datetime(2026, 9, 20, 23, 30)
    aware = naive.replace(tzinfo=timezone.utc)
    assert periods.day_key(naive) == periods.day_key(aware) == "2026-09-20"


def test_today_is_the_utc_calendar_day():
    now = datetime(2026, 9, 20, 23, 30, tzinfo=timezone.utc)
    assert periods.today(now).isoformat() == "2026-09-20"
    beijing = timezone(timedelta(hours=8))
    assert periods.today(now.astimezone(beijing)).isoformat() == "2026-09-20"


def test_trade_days_uses_the_one_ruler(monkeypatch):
    """`stats.trade_days` 必须经 `periods.day_key`，不能再就地 strftime。

    钉「经过那个函数」而不是钉结果：结果相同的第二份实现照样能通过值断言，而
    这条用例的目的正是防止日历规则长出第二处。
    Pins that trade_days goes *through* periods.day_key, not merely that it
    agrees with it — a second copy of the rule would satisfy a value assertion.
    """
    seen = []
    real = periods.day_key

    def spy(dt):
        seen.append(dt)
        return real(dt)

    monkeypatch.setattr(stats.periods, "day_key", spy)

    when = datetime(2026, 9, 20, 23, 30)
    out = stats.compute_comprehensive_stats(
        db=None, user_id="u1", data={"orders": [_order(when)], "legs": {}}
    )
    assert out["trade_days"] == 1
    assert seen == [when]


def test_trade_days_counts_utc_days_across_the_beijing_boundary():
    """同一个北京日的两笔（09-21 07:30 与 09-21 09:30）跨了 UTC 日界 → 算两天。

    反过来说，若哪天口径改成 STATS_TZ，这里会变成 1 天——存量用户的 trade_days_30 /
    100 / 180 判定会随之整体变化，这条用例就是那次变更的告警器。
    """
    beijing = timezone(timedelta(hours=8))
    orders = [
        _order(datetime(2026, 9, 21, 7, 30, tzinfo=beijing)),   # UTC 09-20
        _order(datetime(2026, 9, 21, 9, 30, tzinfo=beijing)),   # UTC 09-21
    ]
    out = stats.compute_comprehensive_stats(
        db=None, user_id="u1", data={"orders": orders, "legs": {}}
    )
    assert out["trade_days"] == 2


def test_current_active_streak_anchors_on_the_same_ruler(db_session, monkeypatch):
    """连续活跃天的「今天」与 trade_days 同尺：都走 periods。
    The streak's "today" comes from the same helper as trade_days."""
    from app.models import UserActiveDay
    from app.services.gamification.conditions import current_active_streak

    for day in ("2026-09-19", "2026-09-20"):
        db_session.add(UserActiveDay(user_id="u1", day=day))
    db_session.commit()

    # UTC 还在 09-20（北京已是 09-21 07:30）：连续两天成立
    monkeypatch.setattr(
        periods, "today",
        lambda now=None: datetime(2026, 9, 20, 23, 30, tzinfo=timezone.utc).date(),
    )
    assert current_active_streak(db_session, "u1") == 2


@pytest.mark.parametrize("name", ["week_key", "month_key", "day_key", "today"])
def test_calendar_helpers_all_live_in_periods(name):
    """日历规则的唯一出处。新增切天逻辑请加在这里，不要在调用点就地写。
    The single home for the calendar rule."""
    assert callable(getattr(periods, name))
