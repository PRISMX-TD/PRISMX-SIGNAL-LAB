# 管理页「数据看板」重做 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把管理页「数据看板」页签重做成口径统一（北京时间切天、剔管理员、活跃=打开过页面）、按时间范围切换、能看增长 / 漏斗 / 留存 / 功能使用的后台看板，并修正页面停留计时。

**Architecture:** 后端新增 `services/stats_time.py`（时区与时间范围唯一定义处）和 `services/admin_overview.py`（全部看板数字的纯函数计算），由新路由 `GET /admin/overview` 一次返回；`GET /admin/page-stats` 改成同一套范围参数；删除 `GET /admin/metrics`。前端把看板拆成 `components/admin/overview/` 下的独立卡片，`AdminPage.tsx` 只挂 `<OverviewPanel />`。所有数字从现有表现算，不加表、不加埋点、不动 schema rev。

**Tech Stack:** FastAPI + SQLAlchemy 2 + pydantic 2（后端，Python 3.12，`zoneinfo` 标准库）；React 18 + TypeScript + react-router + react-i18next + Tailwind（前端，纯 SVG 折线）；pytest（后端测试，内存 SQLite，fixture `db_session`）。前端没有单测框架，靠 `tsc -b` 与本地预览验证。

设计文档：`docs/superpowers/specs/2026-09-16-admin-overview-dashboard-design.md`

## Global Constraints

- 时区配置项名 `STATS_TZ`，默认 `Asia/Shanghai`，只在 `backend/app/services/stats_time.py` 读取；其它文件一律通过该模块的函数取"今天"和"本地日期"。
- 所有人数统计 `User.role != "admin"`。
- "活跃"唯一数据源：`PageVisitorDay`。不读 `last_active_at`，不读 `user_active_days`。
- 时间范围预设键固定为 `week | month | last_month | quarter | year`；自定义传 `from` / `to`（`YYYY-MM-DD`）；跨度上限 `400` 天；违规返回 422。
- 漏斗五步键名固定：`registered / bound / traded / trialed / paid`。
- 留存三档键名固定：`d2 / d7 / d30`。
- 等级键名固定：`FREE / PRO_PAID / PRO_TRIAL`。
- `VISITOR_RETENTION_DAYS` 改为 `400`。
- 不改 `CURRENT_SCHEMA_REV`。不改 `user_active_days` 表及其写入点 `deps._touch_last_active`。
- 前端不引入图表库；不新增 npm 依赖。
- 前端 UI 约定：卡片用 `.glass`，页头 `PageHead` 不动，开关只用 `Switch`，间距走 Tailwind 4px 网格，涨用 `text-up` 跌用 `text-down`。
- 后端测试运行方式（Windows 必须带 UTF-8）：`cd backend; $env:PYTHONUTF8=1; python -m pytest tests/<file> -q`。
- 前端类型检查：`cd frontend; npx tsc -b`。
- 每个任务结束提交一次；提交信息中文、带 `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`。**最后一个任务才 push**（推 main 即部署）。
- 与设计文档的一处命名偏差：接口响应里的范围对象字段用 `start / end / compareStart / compareEnd`，不用 `from / to`（`from` 是 Python 关键字，pydantic 需要 alias 徒增麻烦）。查询参数仍是 `from` / `to`。

---

## 文件结构

**后端新增**
- `backend/app/services/stats_time.py` — `STATS_TZ` 读取、`local_day()`、`today()`、`day_start_utc()`、`resolve_range()`、`RangeSpec`、`RangeError`
- `backend/app/services/admin_overview.py` — `build_overview(db, spec, today)` 及各卡片的子函数
- `backend/tests/test_stats_time.py` — 时区与范围解析测试
- `backend/tests/test_admin_overview.py` — 每个数字的口径测试 + 路由校验测试

**后端修改**
- `backend/app/core/config.py` — 加 `STATS_TZ`
- `backend/app/routers/telemetry.py` — `_mark_visitor` 的日期改 `local_day`
- `backend/app/services/page_stats.py` — 保留期 400
- `backend/app/schemas.py` — 删 `AdminMetricsOut`，加 overview 系列模型，`AdminPageStatsOut` 加 `start/end`
- `backend/app/routers/admin.py` — 删 `metrics`，加 `overview`，`page_stats` 改参数与按天分组
- `backend/tests/test_page_stats_paths.py` — 补一条"人数标记按 STATS_TZ 记日"的测试

**前端新增**（`frontend/src/components/admin/overview/`）
- `OverviewPanel.tsx` — 范围状态（URL）、两个请求各自成败、组装所有卡片
- `RangePicker.tsx` — 五个预设 + 自定义起止
- `rangeUtils.ts` — `RangeState` 类型、URL 读写、自定义校验、转请求参数
- `LineChart.tsx` — 从 `PageStatsCard` 抽出的通用多线 SVG 折线（含悬停面板）
- `HeadlineCards.tsx` — 5 张指标卡 + `DeltaBadge`
- `ActivityChart.tsx` — 日活 + 新注册双线
- `FunnelCard.tsx` — 漏斗横柱 + 8 周分批表
- `RetentionCard.tsx` — d2/d7/d30
- `PlanBreakdown.tsx` — 三个等级标签
- `StrategyUsageCard.tsx` — 模板使用表
- `TradingUsageCard.tsx` — 交易人数 / 笔数 + 折线
- `frontend/src/utils/strategyTemplates.ts` — 从 `StrategiesPage.tsx` 搬出的 `TEMPLATE_LABEL_KEYS`

**前端修改**
- `frontend/src/api/types.ts` — 删 `AdminMetrics`，加 `AdminOverview*`，`AdminPageStats` 加 `start/end`
- `frontend/src/api/client.ts` — 删 `metrics`，加 `overview(range)`，`pageStats(range)` 改签名
- `frontend/src/components/admin/PageStatsCard.tsx` — 去掉天数开关，改用 `LineChart`
- `frontend/src/pages/AdminPage.tsx` — data 页签只剩 `<OverviewPanel />`
- `frontend/src/pages/StrategiesPage.tsx` — 改从 `utils/strategyTemplates` 导入
- `frontend/src/components/Layout.tsx` — 停留计时加 `visibilitychange`
- `frontend/src/i18n/zh.json`、`frontend/src/i18n/en.json` — `admin.overview.*`，改 `admin.pageStats.title`，删 `admin.dau/wau/signupsLast7d`、`admin.pageStats.daysLabel/daysOption`

**文档**
- `.trae/documents/PRISMX_01_产品文档（给人看）.md` §3.5「数据」行
- `.trae/documents/PRISMX_02_技术架构（给技术看）.md` admin 接口段

---

### Task 1: 时区与时间范围的唯一定义处 `stats_time.py`

**Files:**
- Modify: `backend/app/core/config.py`（`DATABASE_URL` 之前加一项）
- Create: `backend/app/services/stats_time.py`
- Test: `backend/tests/test_stats_time.py`

**Interfaces:**
- Produces:
  - `stats_tz() -> ZoneInfo`
  - `local_day(dt: datetime) -> date` — 任意 datetime（naive 视为 UTC）→ `STATS_TZ` 日期
  - `today() -> date` — `STATS_TZ` 的今天
  - `day_start_utc(d: date) -> datetime` — 该本地日 00:00 对应的 **naive UTC** datetime（用于和库里 naive UTC 列比较）
  - `@dataclass(frozen=True) RangeSpec(start: date, end: date, compare_start: date, compare_end: date)`，属性 `days`、方法 `day_keys() -> list[str]`
  - `class RangeError(ValueError)`
  - `resolve_range(preset: str | None, start: date | None, end: date | None, today: date) -> RangeSpec`
  - 常量 `RANGE_PRESETS = ("week", "month", "last_month", "quarter", "year")`、`MAX_RANGE_DAYS = 400`

- [ ] **Step 1: 写失败的测试**

```python
# backend/tests/test_stats_time.py
"""看板的时区与时间范围口径。全部按 STATS_TZ 切天，预设由后端解析。"""
from datetime import date, datetime, timezone

import pytest

from app.core.config import settings
from app.services.stats_time import (
    MAX_RANGE_DAYS, RangeError, RangeSpec, day_start_utc, local_day, resolve_range,
)


@pytest.fixture(autouse=True)
def _beijing(monkeypatch):
    monkeypatch.setattr(settings, "STATS_TZ", "Asia/Shanghai")


def test_local_day_shifts_late_utc_into_next_day():
    # UTC 9/15 23:30 = 北京 9/16 07:30
    assert local_day(datetime(2026, 9, 15, 23, 30, tzinfo=timezone.utc)) == date(2026, 9, 16)
    # naive 视为 UTC
    assert local_day(datetime(2026, 9, 15, 23, 30)) == date(2026, 9, 16)
    assert local_day(datetime(2026, 9, 15, 10, 0)) == date(2026, 9, 15)


def test_day_start_utc_is_naive_utc_of_local_midnight():
    # 北京 9/16 00:00 = UTC 9/15 16:00
    assert day_start_utc(date(2026, 9, 16)) == datetime(2026, 9, 15, 16, 0)
    assert day_start_utc(date(2026, 9, 16)).tzinfo is None


TODAY = date(2026, 9, 16)  # 周三


@pytest.mark.parametrize("preset,start,end", [
    ("week", date(2026, 9, 14), TODAY),            # 周一起
    ("month", date(2026, 9, 1), TODAY),
    ("last_month", date(2026, 8, 1), date(2026, 8, 31)),
    ("quarter", date(2026, 7, 1), TODAY),
    ("year", date(2026, 1, 1), TODAY),
])
def test_presets(preset, start, end):
    spec = resolve_range(preset, None, None, TODAY)
    assert (spec.start, spec.end) == (start, end)


def test_last_month_across_new_year():
    spec = resolve_range("last_month", None, None, date(2026, 1, 5))
    assert (spec.start, spec.end) == (date(2025, 12, 1), date(2025, 12, 31))


def test_week_on_a_monday_is_a_single_day():
    spec = resolve_range("week", None, None, date(2026, 9, 14))
    assert (spec.start, spec.end) == (date(2026, 9, 14), date(2026, 9, 14))
    assert spec.days == 1


def test_compare_period_is_same_length_immediately_before():
    spec = resolve_range("month", None, None, TODAY)  # 9/1..9/16 共 16 天
    assert spec.days == 16
    assert (spec.compare_start, spec.compare_end) == (date(2026, 8, 16), date(2026, 8, 31))


def test_custom_range_wins_over_preset_and_default_is_month():
    spec = resolve_range("year", date(2026, 9, 10), date(2026, 9, 12), TODAY)
    assert (spec.start, spec.end) == (date(2026, 9, 10), date(2026, 9, 12))
    assert resolve_range(None, None, None, TODAY).start == date(2026, 9, 1)


def test_day_keys_are_contiguous_iso_dates():
    spec = RangeSpec(date(2026, 9, 14), date(2026, 9, 16), date(2026, 9, 11), date(2026, 9, 13))
    assert spec.day_keys() == ["2026-09-14", "2026-09-15", "2026-09-16"]


@pytest.mark.parametrize("start,end", [
    (date(2026, 9, 12), date(2026, 9, 10)),       # 起晚于止
    (date(2026, 9, 10), date(2026, 9, 17)),       # 止在未来
    (date(2025, 8, 1), date(2026, 9, 16)),        # 超过 400 天
])
def test_invalid_custom_ranges_raise(start, end):
    with pytest.raises(RangeError):
        resolve_range(None, start, end, TODAY)


def test_exactly_max_days_is_allowed():
    end = TODAY
    start = date.fromordinal(end.toordinal() - (MAX_RANGE_DAYS - 1))
    assert resolve_range(None, start, end, TODAY).days == MAX_RANGE_DAYS


def test_unknown_preset_raises():
    with pytest.raises(RangeError):
        resolve_range("fortnight", None, None, TODAY)
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend; $env:PYTHONUTF8=1; python -m pytest tests/test_stats_time.py -q`
Expected: 全部 ERROR，`ModuleNotFoundError: app.services.stats_time`

- [ ] **Step 3: 加配置项**

在 `backend/app/core/config.py` 的 `DATABASE_URL: str = "sqlite:///./prismx.db"` 那段**之前**插入：

```python
    # 看板统计切"天"的时区。后台人员在北京时间看数据，"今天"不该从早上 8 点开始。
    # 只在 services/stats_time.py 读取；其它地方一律用那里的 local_day()/today()。
    # Timezone for day bucketing on the admin dashboard. Read only by
    # services/stats_time.py; everything else goes through its helpers.
    STATS_TZ: str = "Asia/Shanghai"
```

- [ ] **Step 4: 写实现**

```python
# backend/app/services/stats_time.py
"""看板统计的时间口径，全项目只此一处。

三条规则：
1. 所有"按天"都按 STATS_TZ（默认北京时间）切，不按 UTC。库里的 datetime 列存的是
   naive UTC，比较前先把本地日的 00:00 换成 naive UTC（day_start_utc）。
2. 时间范围预设（本周/本月/上个月/本季度/今年）在这里解析，不在前端算：前端没有
   单测框架，"周一起算""上个月最后一天"这类边界要能被 pytest 钉住。
3. 对比期 = 紧邻本期之前、长度相同的一段。

Dashboard time semantics, defined once. All day bucketing uses STATS_TZ; range
presets are resolved server-side so pytest can pin the edge cases; the compare
period is the equal-length window immediately before.
"""
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from app.core.config import settings
from app.utils.timeutil import aware

RANGE_PRESETS = ("week", "month", "last_month", "quarter", "year")
# 与 page_stats.VISITOR_RETENTION_DAYS 对齐：人数数据只留这么久，再长也查不出东西。
# Matches page_stats.VISITOR_RETENTION_DAYS; visitor data older than this is gone.
MAX_RANGE_DAYS = 400


class RangeError(ValueError):
    """时间范围不合法；路由层转成 422。"""


def stats_tz() -> ZoneInfo:
    return ZoneInfo(settings.STATS_TZ)


def local_day(dt: datetime) -> date:
    """任意 datetime（naive 视为 UTC）→ STATS_TZ 日期。"""
    return aware(dt).astimezone(stats_tz()).date()


def today() -> date:
    return datetime.now(timezone.utc).astimezone(stats_tz()).date()


def day_start_utc(d: date) -> datetime:
    """本地日 d 的 00:00 对应的 naive UTC。库里的 DateTime 列都是 naive UTC，
    过滤 created_at / time_bucket 时用它做边界。"""
    return datetime.combine(d, time.min, tzinfo=stats_tz()).astimezone(timezone.utc).replace(tzinfo=None)


@dataclass(frozen=True)
class RangeSpec:
    start: date
    end: date
    compare_start: date
    compare_end: date

    @property
    def days(self) -> int:
        return (self.end - self.start).days + 1

    def day_keys(self) -> list[str]:
        return [(self.start + timedelta(days=i)).isoformat() for i in range(self.days)]


def _preset_bounds(preset: str, today_: date) -> tuple[date, date]:
    if preset == "week":
        return today_ - timedelta(days=today_.weekday()), today_
    if preset == "month":
        return today_.replace(day=1), today_
    if preset == "last_month":
        last_day_prev = today_.replace(day=1) - timedelta(days=1)
        return last_day_prev.replace(day=1), last_day_prev
    if preset == "quarter":
        first_month = ((today_.month - 1) // 3) * 3 + 1
        return today_.replace(month=first_month, day=1), today_
    if preset == "year":
        return today_.replace(month=1, day=1), today_
    raise RangeError(f"unknown range preset: {preset}")


def resolve_range(preset: str | None, start: date | None, end: date | None, today: date) -> RangeSpec:
    """解析范围。自定义 start/end 优先；否则按预设；都没给默认本月。"""
    if start is not None or end is not None:
        if start is None or end is None:
            raise RangeError("from and to must be given together")
    else:
        start, end = _preset_bounds(preset or "month", today)

    if start > end:
        raise RangeError("from must not be after to")
    if end > today:
        raise RangeError("to must not be in the future")
    days = (end - start).days + 1
    if days > MAX_RANGE_DAYS:
        raise RangeError(f"range must not exceed {MAX_RANGE_DAYS} days")

    compare_end = start - timedelta(days=1)
    compare_start = compare_end - timedelta(days=days - 1)
    return RangeSpec(start=start, end=end, compare_start=compare_start, compare_end=compare_end)
```

- [ ] **Step 5: 运行确认通过**

Run: `cd backend; $env:PYTHONUTF8=1; python -m pytest tests/test_stats_time.py -q`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add backend/app/core/config.py backend/app/services/stats_time.py backend/tests/test_stats_time.py
git commit -m "feat(stats): 看板时间口径唯一定义处——STATS_TZ 切天 + 范围预设后端解析

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: 人数标记按 STATS_TZ 记日、保留期 400 天

**Files:**
- Modify: `backend/app/routers/telemetry.py:270-300`（`report_pageview` 内两处 `_mark_visitor(..., bucket.date(), ...)`）
- Modify: `backend/app/services/page_stats.py:33`（`VISITOR_RETENTION_DAYS`）
- Test: `backend/tests/test_page_stats_paths.py`（追加）

**Interfaces:**
- Consumes: `stats_time.local_day`
- Produces: `PageVisitorDay.day` 从此是 `STATS_TZ` 日期

- [ ] **Step 1: 写失败的测试**（追加到 `test_page_stats_paths.py` 末尾）

```python
def test_visitor_day_is_recorded_in_stats_tz(db_session, monkeypatch):
    """UTC 9/15 23:30 上报的访问，人数标记要记在北京时间 9/16。"""
    from datetime import date, datetime, timezone
    import app.routers.telemetry as telemetry
    from app.core.config import settings

    monkeypatch.setattr(settings, "STATS_TZ", "Asia/Shanghai")

    class _FixedDatetime(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 9, 15, 23, 30, tzinfo=timezone.utc).astimezone(tz) if tz else datetime(2026, 9, 15, 23, 30)

    monkeypatch.setattr(telemetry, "datetime", _FixedDatetime)
    u = _user(db_session, "tz@t.co")
    report_pageview(PageViewIn(path="/dashboard", seconds=5), db_session, u)
    marker = db_session.query(PageVisitorDay).one()
    assert marker.day == date(2026, 9, 16)
    # 次数桶仍是 UTC 整点，不受影响 / hourly bucket stays UTC
    assert db_session.query(PageViewStat).one().time_bucket == datetime(2026, 9, 15, 23, 0)


def test_visitor_retention_is_400_days():
    from app.services.page_stats import VISITOR_RETENTION_DAYS
    from app.services.stats_time import MAX_RANGE_DAYS
    assert VISITOR_RETENTION_DAYS == MAX_RANGE_DAYS == 400
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend; $env:PYTHONUTF8=1; python -m pytest tests/test_page_stats_paths.py -q -k "stats_tz or retention"`
Expected: 两条 FAIL（day 是 9/15；保留期是 100）

- [ ] **Step 3: 改 telemetry**

`backend/app/routers/telemetry.py` 顶部 import 区加：

```python
from app.services.stats_time import local_day
```

`report_pageview` 内：

```python
    seconds = min(max(payload.seconds, 0.0), MAX_DWELL_SECONDS)
    now_utc = datetime.now(timezone.utc)
    now = now_utc.replace(tzinfo=None)
    bucket = now.replace(minute=0, second=0, microsecond=0)
    # 人数标记按看板时区记日（北京时间），次数桶仍是 UTC 整点。两者口径不同是
    # 有意的：桶只是累加容器，查询时再按时区归天；标记只有"日"这一个粒度，
    # 写入时就得切对。/ Visitor markers use the dashboard day; hourly buckets
    # stay UTC and are re-bucketed at query time.
    visitor_day = local_day(now_utc)
```

然后把两处 `_mark_visitor(db, payload.path, bucket.date(), user.id)` 都改成 `_mark_visitor(db, payload.path, visitor_day, user.id)`。

- [ ] **Step 4: 改保留期**

`backend/app/services/page_stats.py`：

```python
# 保留天数。看板范围上限 400 天（stats_time.MAX_RANGE_DAYS），要能看"今年"；
# 更早的行对任何查询都已无用。
# Retention window. The dashboard range caps at 400 days so "this year" works.
VISITOR_RETENTION_DAYS = 400
```

- [ ] **Step 5: 运行确认通过**

Run: `cd backend; $env:PYTHONUTF8=1; python -m pytest tests/test_page_stats_paths.py -q`
Expected: 全部 PASS

- [ ] **Step 6: 提交**

```bash
git add backend/app/routers/telemetry.py backend/app/services/page_stats.py backend/tests/test_page_stats_paths.py
git commit -m "fix(telemetry): 页面人数标记按 STATS_TZ 记日；人数保留期 100 → 400 天

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: overview 响应模型 + 头部指标与活跃趋势

**Files:**
- Modify: `backend/app/schemas.py:294-300`（在 `AdminMetricsOut` 之后加 overview 模型；`AdminMetricsOut` 本任务**不删**，Task 6 连同路由一起删，保证每个提交后端都能正常 import）
- Create: `backend/app/services/admin_overview.py`
- Test: `backend/tests/test_admin_overview.py`

**Interfaces:**
- Consumes: `stats_time.RangeSpec / local_day / day_start_utc`
- Produces（schemas）：`CompareOut`, `OverviewRangeOut`, `OverviewHeadlineOut`, `ActivityDayOut`, `FunnelStepsOut`, `FunnelWeekOut`, `FunnelOut`, `RetentionPointOut`, `RetentionOut`, `StrategyUsageOut`, `TradingDayOut`, `TradingOut`, `AdminOverviewOut`
- Produces（service）：
  - `headline(db, spec, today) -> OverviewHeadlineOut`
  - `activity_daily(db, spec) -> list[ActivityDayOut]`
  - 私有工具 `_non_admin_users(db)`（query 基座）、`_local_day_counts(rows, spec)`

- [ ] **Step 1: 写失败的测试**

```python
# backend/tests/test_admin_overview.py
"""看板每个数字的口径。

夹具约定：`_user()` 造非管理员用户；`_admin()` 造管理员——每条测试都同时放一个
管理员进去，任何数字把他算进去都要红。日期全用北京时间（STATS_TZ 固定为
Asia/Shanghai），`TODAY` 固定为 2026-09-16（周三）。
"""
from datetime import date, datetime, timedelta, timezone

import pytest

from app.core.config import settings
from app.models import MT5Account, Order, PageVisitorDay, Payment, User, UserStrategy
from app.services.stats_time import RangeSpec, day_start_utc
from app.services import admin_overview as ov

TODAY = date(2026, 9, 16)
# 本月 9/1..9/16，对比 8/16..8/31
SPEC = RangeSpec(date(2026, 9, 1), TODAY, date(2026, 8, 16), date(2026, 8, 31))


@pytest.fixture(autouse=True)
def _beijing(monkeypatch):
    monkeypatch.setattr(settings, "STATS_TZ", "Asia/Shanghai")


def _at(d: date, hour: int = 4) -> datetime:
    """北京时间 d 日 hour 点，转成库里存的 naive UTC。默认 04:00 避免贴日界。"""
    return day_start_utc(d) + timedelta(hours=hour)


def _user(db, email, *, created: date = date(2026, 9, 1), role="user", plan="FREE",
          trial=False, trial_used=False) -> User:
    u = User(email=email, api_token="tok_" + email, role=role, plan=plan,
             plan_is_trial=trial, created_at=_at(created),
             trial_used_at=_at(created) if trial_used else None)
    db.add(u); db.commit(); return u


def _admin(db) -> User:
    return _user(db, "admin@t.co", role="admin", created=date(2026, 9, 10))


def _visit(db, user: User, d: date, path="/dashboard"):
    db.add(PageVisitorDay(path=path, day=d, user_id=user.id)); db.commit()


def _bind(db, user: User, login="1001"):
    # 唯一约束是 (user_id, login, server)，同一人两个账号要换 login
    db.add(MT5Account(user_id=user.id, login=login)); db.commit()


def _fill(db, user: User, d: date, status="FILLED"):
    db.add(Order(user_id=user.id, client_order_id=f"c-{user.id}-{d}-{status}", symbol="XAUUSD",
                 side="BUY", volume=0.1, status=status, created_at=_at(d)))
    db.commit()


def _pay(db, user: User, status="FINISHED"):
    db.add(Payment(user_id=user.id, nowpayments_payment_id=f"np-{user.id}-{status}", plan="pro_monthly",
                   amount_usd=29.0, pay_currency="usdttrc20", status=status))
    db.commit()


# ── headline ───────────────────────────────────────────────────────────────

def test_total_users_excludes_admin(db_session):
    _user(db_session, "a@t.co"); _user(db_session, "b@t.co"); _admin(db_session)
    assert ov.headline(db_session, SPEC, TODAY).totalUsers == 2


def test_active_counts_come_from_page_visits_only(db_session):
    a = _user(db_session, "a@t.co"); b = _user(db_session, "b@t.co"); c = _user(db_session, "c@t.co")
    adm = _admin(db_session)
    # last_active_at 不算：c 有 last_active_at 但从没打开过页面
    c.last_active_at = datetime.now(timezone.utc); db_session.commit()
    _visit(db_session, a, TODAY); _visit(db_session, a, TODAY, path="/charts")   # 同一天两页算 1 人
    _visit(db_session, b, TODAY - timedelta(days=6))                             # 周内、非今日
    _visit(db_session, adm, TODAY)                                               # 管理员不算
    h = ov.headline(db_session, SPEC, TODAY)
    assert (h.activeToday, h.activeWeek, h.activeMonth) == (1, 2, 2)


def test_active_month_is_30_days_window(db_session):
    a = _user(db_session, "a@t.co"); b = _user(db_session, "b@t.co")
    _visit(db_session, a, TODAY - timedelta(days=29))   # 刚好在窗口内
    _visit(db_session, b, TODAY - timedelta(days=30))   # 刚好在窗口外
    h = ov.headline(db_session, SPEC, TODAY)
    assert (h.activeWeek, h.activeMonth) == (0, 1)


def test_signups_by_stats_tz_day_with_compare(db_session):
    # UTC 8/31 20:00 = 北京 9/1 04:00 → 算本期；UTC 8/31 10:00 = 北京 8/31 → 算对比期
    u1 = User(email="x@t.co", api_token="t1", created_at=datetime(2026, 8, 31, 20, 0))
    u2 = User(email="y@t.co", api_token="t2", created_at=datetime(2026, 8, 31, 10, 0))
    db_session.add_all([u1, u2]); db_session.commit()
    _user(db_session, "z@t.co", created=date(2026, 9, 10))
    _admin(db_session)
    h = ov.headline(db_session, SPEC, TODAY)
    assert (h.signups.current, h.signups.previous) == (2, 1)


# ── activityDaily ──────────────────────────────────────────────────────────

def test_activity_daily_is_contiguous_and_zero_filled(db_session):
    a = _user(db_session, "a@t.co", created=date(2026, 9, 2)); _admin(db_session)
    _visit(db_session, a, date(2026, 9, 2)); _visit(db_session, a, date(2026, 9, 2), path="/orders")
    _visit(db_session, a, date(2026, 9, 5))
    rows = ov.activity_daily(db_session, SPEC)
    assert len(rows) == 16
    by = {r.date: r for r in rows}
    assert (by["2026-09-02"].active, by["2026-09-02"].signups) == (1, 1)
    assert (by["2026-09-03"].active, by["2026-09-03"].signups) == (0, 0)
    assert by["2026-09-05"].active == 1
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend; $env:PYTHONUTF8=1; python -m pytest tests/test_admin_overview.py -q`
Expected: ERROR，`cannot import name 'admin_overview'`

- [ ] **Step 3: 写 schemas**

在 `backend/app/schemas.py` 的 `class AdminMetricsOut` 之后（`class PageViewIn` 之前）插入：

```python
# ── 管理后台看板 / admin overview dashboard ──────────────────────────────────
# 全部按 STATS_TZ 切天、剔除管理员；"活跃"= 当天打开过任一页面（page_visitor_days）。
# 口径见 docs/superpowers/specs/2026-09-16-admin-overview-dashboard-design.md §3/§5。

class CompareOut(BaseModel):
    current: int
    previous: int  # 紧邻本期之前、等长的对比期 / equal-length window right before


class OverviewRangeOut(BaseModel):
    start: str  # YYYY-MM-DD（STATS_TZ）
    end: str
    days: int
    compareStart: str
    compareEnd: str


class OverviewHeadlineOut(BaseModel):
    totalUsers: int
    activeToday: int   # 今天打开过页面的人 / opened a page today
    activeWeek: int    # 近 7 天 / last 7 days incl. today
    activeMonth: int   # 近 30 天 / last 30 days incl. today
    signups: CompareOut


class ActivityDayOut(BaseModel):
    date: str
    active: int
    signups: int


class FunnelStepsOut(BaseModel):
    """五步互相独立（"至少做过一次"），允许跳步，后一步不保证 ≤ 前一步。
    Independent steps; skipping is allowed so later steps need not be smaller."""
    registered: int
    bound: int     # 有 MT5 账号 / has an mt5_accounts row
    traded: int    # 有 FILLED 订单 / has a FILLED order
    trialed: int   # trial_used_at 非空 / used the trial
    paid: int      # 有 FINISHED 付款 / has a FINISHED payment


class FunnelWeekOut(FunnelStepsOut):
    weekStart: str  # 该周周一（STATS_TZ）/ Monday of that week


class FunnelOut(BaseModel):
    overall: FunnelStepsOut
    byWeek: list[FunnelWeekOut]  # 最近 8 周，升序 / last 8 weeks ascending


class RetentionPointOut(BaseModel):
    rate: float | None  # cohort 为空时 None / None when the cohort is empty
    cohortSize: int
    cohortFrom: str | None  # cohort 内最早/最晚注册日 / earliest & latest signup day in cohort
    cohortTo: str | None


class RetentionOut(BaseModel):
    d2: RetentionPointOut
    d7: RetentionPointOut
    d30: RetentionPointOut


class StrategyUsageOut(BaseModel):
    template: str      # 预设键；无模板归 "custom" / preset key or "custom"
    users: int         # 建过 / created at least one
    enabledUsers: int  # 当前启用中 / currently enabled


class TradingDayOut(BaseModel):
    date: str
    fills: int


class TradingOut(BaseModel):
    traders: CompareOut  # 有成交的人数 / distinct users with a fill
    fills: CompareOut    # 成交笔数 / fill count
    daily: list[TradingDayOut]


class AdminOverviewOut(BaseModel):
    range: OverviewRangeOut
    headline: OverviewHeadlineOut
    activityDaily: list[ActivityDayOut]
    funnel: FunnelOut
    retention: RetentionOut
    plans: dict[str, int]  # FREE / PRO_PAID / PRO_TRIAL（其它等级原样）
    strategies: list[StrategyUsageOut]
    trading: TradingOut
```

- [ ] **Step 4: 写 service（本任务只到 headline 与 activity_daily）**

```python
# backend/app/services/admin_overview.py
"""管理页看板的全部数字。纯查询 + Python 归并，不写库。

三条全局口径（改任何一条先改设计文档 §3）：
- 按天一律用 stats_time 的 STATS_TZ；库里 datetime 列是 naive UTC，比较边界用
  day_start_utc()，归日用 local_day()。按天分组在 Python 侧做，跟 admin.page_stats
  一样，是为了 SQLite / Postgres 行为一致。
- 所有人数 role != 'admin'。
- 活跃 = page_visitor_days 里当天有行。不看 last_active_at（任何请求都会打它，
  App 后台刷数据也算），不看 user_active_days（那是游戏化的数据源，口径不同）。

All dashboard numbers. Day bucketing via STATS_TZ (Python-side for cross-DB
parity), admins excluded everywhere, "active" means a page_visitor_days row.
"""
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import func
from sqlalchemy.orm import Query, Session

from app.models import MT5Account, Order, PageVisitorDay, Payment, User, UserStrategy
from app.schemas import (
    ActivityDayOut, AdminOverviewOut, CompareOut, FunnelOut, FunnelStepsOut, FunnelWeekOut,
    OverviewHeadlineOut, OverviewRangeOut, RetentionOut, RetentionPointOut, StrategyUsageOut,
    TradingDayOut, TradingOut,
)
from app.services.stats_time import MAX_RANGE_DAYS, RangeSpec, day_start_utc, local_day

NOT_ADMIN = User.role != "admin"


def _non_admin_users(db: Session) -> Query:
    return db.query(User).filter(NOT_ADMIN)


def _distinct_visitors_since(db: Session, since: date) -> int:
    """since（含）起打开过页面的去重人数，剔管理员。"""
    return int(
        db.query(func.count(func.distinct(PageVisitorDay.user_id)))
        .join(User, User.id == PageVisitorDay.user_id)
        .filter(NOT_ADMIN, PageVisitorDay.day >= since)
        .scalar()
        or 0
    )


def _signup_days(db: Session, first: date, last: date) -> list[date]:
    """[first, last] 内注册的非管理员，每人一个 STATS_TZ 注册日。"""
    rows = (
        _non_admin_users(db)
        .with_entities(User.created_at)
        .filter(User.created_at >= day_start_utc(first), User.created_at < day_start_utc(last + timedelta(days=1)))
        .all()
    )
    return [local_day(created) for (created,) in rows if created is not None]


def _count_in(days: list[date], first: date, last: date) -> int:
    return sum(1 for d in days if first <= d <= last)


def headline(db: Session, spec: RangeSpec, today: date) -> OverviewHeadlineOut:
    total = _non_admin_users(db).count()
    signup_days = _signup_days(db, spec.compare_start, spec.end)
    return OverviewHeadlineOut(
        totalUsers=total,
        activeToday=_distinct_visitors_since(db, today),
        activeWeek=_distinct_visitors_since(db, today - timedelta(days=6)),
        activeMonth=_distinct_visitors_since(db, today - timedelta(days=29)),
        signups=CompareOut(
            current=_count_in(signup_days, spec.start, spec.end),
            previous=_count_in(signup_days, spec.compare_start, spec.compare_end),
        ),
    )


def activity_daily(db: Session, spec: RangeSpec) -> list[ActivityDayOut]:
    active_rows = (
        db.query(PageVisitorDay.day, func.count(func.distinct(PageVisitorDay.user_id)))
        .join(User, User.id == PageVisitorDay.user_id)
        .filter(NOT_ADMIN, PageVisitorDay.day >= spec.start, PageVisitorDay.day <= spec.end)
        .group_by(PageVisitorDay.day)
        .all()
    )
    active = {_iso(day): int(n or 0) for day, n in active_rows}
    signups: dict[str, int] = defaultdict(int)
    for d in _signup_days(db, spec.start, spec.end):
        signups[d.isoformat()] += 1
    return [
        ActivityDayOut(date=key, active=active.get(key, 0), signups=signups.get(key, 0))
        for key in spec.day_keys()
    ]


def _iso(value) -> str:
    """Date 列在 SQLite 下可能回字符串，统一成 YYYY-MM-DD。"""
    return value.isoformat() if hasattr(value, "isoformat") else str(value)[:10]
```

- [ ] **Step 5: 运行确认通过**

Run: `cd backend; $env:PYTHONUTF8=1; python -m pytest tests/test_admin_overview.py -q`
Expected: 全部 PASS

同时确认后端仍能正常 import：

Run: `cd backend; $env:PYTHONUTF8=1; python -c "import app.routers.admin; print('ok')"`
Expected: `ok`

- [ ] **Step 6: 提交**

```bash
git add backend/app/schemas.py backend/app/services/admin_overview.py backend/tests/test_admin_overview.py
git commit -m "feat(overview): 看板响应模型 + 头部指标 / 活跃趋势（活跃=打开过页面，剔管理员）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: 漏斗与留存

**Files:**
- Modify: `backend/app/services/admin_overview.py`（追加）
- Test: `backend/tests/test_admin_overview.py`（追加）

**Interfaces:**
- Produces: `funnel(db, today) -> FunnelOut`，`retention(db, today) -> RetentionOut`
- 私有：`_step_user_ids(db) -> dict[str, set[str]]`（键 `bound/traded/trialed/paid`）

- [ ] **Step 1: 写失败的测试**（追加）

```python
# ── funnel ─────────────────────────────────────────────────────────────────

def test_funnel_overall_steps_are_independent(db_session):
    a = _user(db_session, "a@t.co"); b = _user(db_session, "b@t.co"); c = _user(db_session, "c@t.co")
    adm = _admin(db_session)
    _bind(db_session, a); _bind(db_session, a, login="1002")   # 两个账号算 1 人
    _fill(db_session, a, date(2026, 9, 3))
    _fill(db_session, b, date(2026, 9, 3), status="REJECTED")   # 没成交不算
    _pay(db_session, c)                                  # 跳过试用直接付费
    _pay(db_session, b, status="EXPIRED")                # 没付成不算
    _bind(db_session, adm); _fill(db_session, adm, TODAY); _pay(db_session, adm)
    f = ov.funnel(db_session, TODAY).overall
    assert (f.registered, f.bound, f.traded, f.trialed, f.paid) == (3, 1, 1, 0, 1)


def test_funnel_trialed_uses_trial_used_at(db_session):
    _user(db_session, "a@t.co", trial_used=True); _user(db_session, "b@t.co")
    assert ov.funnel(db_session, TODAY).overall.trialed == 1


def test_funnel_by_week_is_8_monday_weeks_ascending(db_session):
    # TODAY 9/16 周三 → 本周 9/14；8 周 = 7/27..9/14
    a = _user(db_session, "a@t.co", created=date(2026, 9, 14))   # 本周
    b = _user(db_session, "b@t.co", created=date(2026, 9, 13))   # 上周日 → 9/7 那周
    _user(db_session, "old@t.co", created=date(2026, 7, 26))     # 8 周之前，不在表里
    _bind(db_session, a)
    weeks = ov.funnel(db_session, TODAY).byWeek
    assert [w.weekStart for w in weeks][-2:] == ["2026-09-07", "2026-09-14"]
    assert weeks[0].weekStart == "2026-07-27" and len(weeks) == 8
    last, prev = weeks[-1], weeks[-2]
    assert (last.registered, last.bound) == (1, 1)
    assert (prev.registered, prev.bound) == (1, 0)
    assert sum(w.registered for w in weeks) == 2


# ── retention ──────────────────────────────────────────────────────────────

def test_retention_d2_counts_exact_next_day_only(db_session):
    a = _user(db_session, "a@t.co", created=date(2026, 9, 10))
    b = _user(db_session, "b@t.co", created=date(2026, 9, 10))
    c = _user(db_session, "c@t.co", created=date(2026, 9, 10))
    _visit(db_session, a, date(2026, 9, 11))   # 第 2 天 → 留存
    _visit(db_session, b, date(2026, 9, 12))   # 第 3 天 → 不算 d2
    _visit(db_session, c, date(2026, 9, 10))   # 注册当天 → 不算
    r = ov.retention(db_session, TODAY).d2
    assert (r.cohortSize, r.rate) == (3, pytest.approx(1 / 3))
    assert (r.cohortFrom, r.cohortTo) == ("2026-09-10", "2026-09-10")


def test_retention_cohort_only_includes_users_whose_day_n_has_passed(db_session):
    # d7：第 7 天 = 注册日 + 6，必须 <= 昨天(9/15) → 注册日 <= 9/9
    _user(db_session, "in@t.co", created=date(2026, 9, 9))
    _user(db_session, "out@t.co", created=date(2026, 9, 10))
    _admin(db_session)
    r = ov.retention(db_session, TODAY).d7
    assert (r.cohortSize, r.rate) == (1, 0.0)


def test_retention_empty_cohort_is_null(db_session):
    _user(db_session, "new@t.co", created=date(2026, 9, 15))
    r = ov.retention(db_session, TODAY).d30
    assert (r.cohortSize, r.rate, r.cohortFrom, r.cohortTo) == (0, None, None, None)


def test_retention_ignores_users_older_than_retention_window(db_session):
    _user(db_session, "ancient@t.co", created=TODAY - timedelta(days=401))
    _user(db_session, "ok@t.co", created=TODAY - timedelta(days=400))
    assert ov.retention(db_session, TODAY).d2.cohortSize == 1
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend; $env:PYTHONUTF8=1; python -m pytest tests/test_admin_overview.py -q -k "funnel or retention"`
Expected: FAIL，`module 'app.services.admin_overview' has no attribute 'funnel'`

- [ ] **Step 3: 追加实现**（`admin_overview.py` 末尾）

```python
# ── 漏斗 / funnel ──────────────────────────────────────────────────────────
FUNNEL_WEEKS = 8


def _step_user_ids(db: Session) -> dict[str, set[str]]:
    """每一步"至少做过一次"的非管理员 user_id 集合。

    用集合而不是逐步 COUNT：分批表要按注册周切同一批人，集合交一次就出来；
    用户量到万级时集合也只有几万个字符串，远比 8 周 × 4 步 = 32 次 JOIN 查询便宜。
    Sets rather than per-step COUNTs: the by-week table intersects the same sets
    with each cohort, and even at 10k users the sets stay cheap.
    """
    def ids(q) -> set[str]:
        return {row[0] for row in q.all()}

    return {
        "bound": ids(db.query(MT5Account.user_id).join(User, User.id == MT5Account.user_id).filter(NOT_ADMIN).distinct()),
        "traded": ids(db.query(Order.user_id).join(User, User.id == Order.user_id).filter(NOT_ADMIN, Order.status == "FILLED").distinct()),
        "trialed": ids(_non_admin_users(db).with_entities(User.id).filter(User.trial_used_at.isnot(None))),
        "paid": ids(db.query(Payment.user_id).join(User, User.id == Payment.user_id).filter(NOT_ADMIN, Payment.status == "FINISHED").distinct()),
    }


def _steps_for(cohort: set[str], steps: dict[str, set[str]]) -> dict[str, int]:
    return {
        "registered": len(cohort),
        "bound": len(cohort & steps["bound"]),
        "traded": len(cohort & steps["traded"]),
        "trialed": len(cohort & steps["trialed"]),
        "paid": len(cohort & steps["paid"]),
    }


def funnel(db: Session, today: date) -> FunnelOut:
    steps = _step_user_ids(db)
    all_ids = {row[0] for row in _non_admin_users(db).with_entities(User.id).all()}

    this_monday = today - timedelta(days=today.weekday())
    week_starts = [this_monday - timedelta(weeks=i) for i in range(FUNNEL_WEEKS - 1, -1, -1)]
    cohorts: dict[date, set[str]] = {ws: set() for ws in week_starts}
    rows = (
        _non_admin_users(db)
        .with_entities(User.id, User.created_at)
        .filter(User.created_at >= day_start_utc(week_starts[0]))
        .all()
    )
    for uid, created in rows:
        if created is None:
            continue
        d = local_day(created)
        ws = d - timedelta(days=d.weekday())
        if ws in cohorts:
            cohorts[ws].add(uid)

    return FunnelOut(
        overall=FunnelStepsOut(**_steps_for(all_ids, steps)),
        byWeek=[FunnelWeekOut(weekStart=ws.isoformat(), **_steps_for(cohorts[ws], steps)) for ws in week_starts],
    )


# ── 留存 / retention ───────────────────────────────────────────────────────
RETENTION_DAYS = (2, 7, 30)


def retention(db: Session, today: date) -> RetentionOut:
    """dN 留存 = 注册日 + (N-1) 那天打开过页面的比例。

    cohort 只收"第 N 天已经完整过去"的人（注册日 + N - 1 <= 昨天），否则最近
    注册的人还没机会回来就被算成流失，比例假低。再往前只看 MAX_RANGE_DAYS 内注册的，
    更早的人他们的访问标记已经被保留期清掉，算出来必然是 0。
    Only users whose day N has fully elapsed enter the cohort, and only those
    registered within the visitor retention window (older markers are pruned).
    """
    earliest = today - timedelta(days=MAX_RANGE_DAYS)
    rows = (
        _non_admin_users(db)
        .with_entities(User.id, User.created_at)
        .filter(User.created_at >= day_start_utc(earliest))
        .all()
    )
    signup_day = {uid: local_day(created) for uid, created in rows if created is not None}
    if signup_day:
        visits = {
            (uid, _iso(day))
            for uid, day in db.query(PageVisitorDay.user_id, PageVisitorDay.day)
            .filter(PageVisitorDay.user_id.in_(list(signup_day)))
            .distinct()
            .all()
        }
    else:
        visits = set()

    def point(n: int) -> RetentionPointOut:
        offset = n - 1
        cohort = {uid: d for uid, d in signup_day.items() if d + timedelta(days=offset) <= today - timedelta(days=1)}
        if not cohort:
            return RetentionPointOut(rate=None, cohortSize=0, cohortFrom=None, cohortTo=None)
        retained = sum(1 for uid, d in cohort.items() if (uid, (d + timedelta(days=offset)).isoformat()) in visits)
        return RetentionPointOut(
            rate=retained / len(cohort),
            cohortSize=len(cohort),
            cohortFrom=min(cohort.values()).isoformat(),
            cohortTo=max(cohort.values()).isoformat(),
        )

    d2, d7, d30 = (point(n) for n in RETENTION_DAYS)
    return RetentionOut(d2=d2, d7=d7, d30=d30)
```

- [ ] **Step 4: 运行确认通过**

Run: `cd backend; $env:PYTHONUTF8=1; python -m pytest tests/test_admin_overview.py -q`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add backend/app/services/admin_overview.py backend/tests/test_admin_overview.py
git commit -m "feat(overview): 转化漏斗（总 + 8 周分批）与 d2/d7/d30 留存

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: 等级分布、策略使用、交易使用、总装

**Files:**
- Modify: `backend/app/services/admin_overview.py`（追加）
- Test: `backend/tests/test_admin_overview.py`（追加）

**Interfaces:**
- Produces: `plans(db) -> dict[str, int]`，`strategies(db) -> list[StrategyUsageOut]`，`trading(db, spec) -> TradingOut`，`build_overview(db, spec, today) -> AdminOverviewOut`

- [ ] **Step 1: 写失败的测试**（追加）

```python
# ── plans / strategies / trading / build ───────────────────────────────────

def test_plans_split_pro_into_paid_and_trial(db_session):
    _user(db_session, "f@t.co")
    _user(db_session, "p@t.co", plan="PRO")
    _user(db_session, "t@t.co", plan="PRO", trial=True)
    _admin(db_session)
    assert ov.plans(db_session) == {"FREE": 1, "PRO_PAID": 1, "PRO_TRIAL": 1}


def test_strategies_group_by_template_and_enabled(db_session):
    a = _user(db_session, "a@t.co"); b = _user(db_session, "b@t.co"); adm = _admin(db_session)
    db_session.add_all([
        UserStrategy(user_id=a.id, template="ma_trend", symbol="XAUUSD", interval="15m", enabled=True),
        UserStrategy(user_id=a.id, template="ma_trend", symbol="EURUSD", interval="1h", enabled=True),   # 同人两条算 1
        UserStrategy(user_id=b.id, template="ma_trend", symbol="XAUUSD", interval="15m", enabled=False),
        UserStrategy(user_id=b.id, template=None, symbol="XAUUSD", interval="15m", enabled=True),        # 无模板 → custom
        UserStrategy(user_id=adm.id, template="rsi_reversal", symbol="XAUUSD", interval="15m", enabled=True),
    ])
    db_session.commit()
    rows = {r.template: r for r in ov.strategies(db_session)}
    assert set(rows) == {"ma_trend", "custom"}
    assert (rows["ma_trend"].users, rows["ma_trend"].enabledUsers) == (2, 1)
    assert (rows["custom"].users, rows["custom"].enabledUsers) == (1, 1)
    assert [r.template for r in ov.strategies(db_session)] == ["ma_trend", "custom"]  # users 降序


def test_trading_counts_fills_in_range_with_compare_and_daily(db_session):
    a = _user(db_session, "a@t.co"); b = _user(db_session, "b@t.co"); adm = _admin(db_session)
    _fill(db_session, a, date(2026, 9, 2)); _fill(db_session, a, date(2026, 9, 2), status="FAILED")
    db_session.add(Order(user_id=a.id, client_order_id="c2", symbol="XAUUSD", side="SELL", volume=0.1,
                         status="FILLED", created_at=_at(date(2026, 9, 2), hour=9)))
    db_session.commit()
    _fill(db_session, b, date(2026, 9, 16))
    _fill(db_session, b, date(2026, 8, 20))      # 对比期
    _fill(db_session, adm, date(2026, 9, 5))     # 管理员不算
    t = ov.trading(db_session, SPEC)
    assert (t.traders.current, t.traders.previous) == (2, 1)
    assert (t.fills.current, t.fills.previous) == (3, 1)
    by = {d.date: d.fills for d in t.daily}
    assert len(t.daily) == 16 and by["2026-09-02"] == 2 and by["2026-09-03"] == 0 and by["2026-09-16"] == 1


def test_build_overview_assembles_everything(db_session):
    _user(db_session, "a@t.co")
    out = ov.build_overview(db_session, SPEC, TODAY)
    assert out.range.start == "2026-09-01" and out.range.compareEnd == "2026-08-31" and out.range.days == 16
    assert out.headline.totalUsers == 1
    assert len(out.activityDaily) == 16 and len(out.funnel.byWeek) == 8
    assert out.retention.d30.rate is None
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend; $env:PYTHONUTF8=1; python -m pytest tests/test_admin_overview.py -q -k "plans or strategies or trading or build"`
Expected: FAIL，缺属性

- [ ] **Step 3: 追加实现**（`admin_overview.py` 末尾）

```python
# ── 等级 / plans ───────────────────────────────────────────────────────────

def plans(db: Session) -> dict[str, int]:
    out: dict[str, int] = {}
    rows = (
        _non_admin_users(db)
        .with_entities(User.plan, User.plan_is_trial, func.count(User.id))
        .group_by(User.plan, User.plan_is_trial)
        .all()
    )
    for plan, is_trial, n in rows:
        plan = plan or "FREE"
        key = ("PRO_TRIAL" if is_trial else "PRO_PAID") if plan == "PRO" else plan
        out[key] = out.get(key, 0) + int(n or 0)
    return out


# ── 策略 / strategies ──────────────────────────────────────────────────────

def strategies(db: Session) -> list[StrategyUsageOut]:
    rows = (
        db.query(UserStrategy.template, UserStrategy.enabled, UserStrategy.user_id)
        .join(User, User.id == UserStrategy.user_id)
        .filter(NOT_ADMIN)
        .all()
    )
    users: dict[str, set[str]] = defaultdict(set)
    enabled: dict[str, set[str]] = defaultdict(set)
    for template, is_enabled, uid in rows:
        key = template or "custom"
        users[key].add(uid)
        if is_enabled:
            enabled[key].add(uid)
    out = [StrategyUsageOut(template=k, users=len(v), enabledUsers=len(enabled[k])) for k, v in users.items()]
    out.sort(key=lambda r: (-r.users, r.template))
    return out


# ── 交易 / trading ─────────────────────────────────────────────────────────

def trading(db: Session, spec: RangeSpec) -> TradingOut:
    rows = (
        db.query(Order.user_id, Order.created_at)
        .join(User, User.id == Order.user_id)
        .filter(
            NOT_ADMIN,
            Order.status == "FILLED",
            Order.created_at >= day_start_utc(spec.compare_start),
            Order.created_at < day_start_utc(spec.end + timedelta(days=1)),
        )
        .all()
    )
    fills_by_day: dict[str, int] = defaultdict(int)
    traders_cur: set[str] = set()
    traders_prev: set[str] = set()
    fills_cur = fills_prev = 0
    for uid, created in rows:
        if created is None:
            continue
        d = local_day(created)
        if spec.start <= d <= spec.end:
            fills_cur += 1
            traders_cur.add(uid)
            fills_by_day[d.isoformat()] += 1
        elif spec.compare_start <= d <= spec.compare_end:
            fills_prev += 1
            traders_prev.add(uid)
    return TradingOut(
        traders=CompareOut(current=len(traders_cur), previous=len(traders_prev)),
        fills=CompareOut(current=fills_cur, previous=fills_prev),
        daily=[TradingDayOut(date=key, fills=fills_by_day.get(key, 0)) for key in spec.day_keys()],
    )


# ── 总装 / assembly ────────────────────────────────────────────────────────

def build_overview(db: Session, spec: RangeSpec, today: date) -> AdminOverviewOut:
    return AdminOverviewOut(
        range=OverviewRangeOut(
            start=spec.start.isoformat(),
            end=spec.end.isoformat(),
            days=spec.days,
            compareStart=spec.compare_start.isoformat(),
            compareEnd=spec.compare_end.isoformat(),
        ),
        headline=headline(db, spec, today),
        activityDaily=activity_daily(db, spec),
        funnel=funnel(db, today),
        retention=retention(db, today),
        plans=plans(db),
        strategies=strategies(db),
        trading=trading(db, spec),
    )
```

- [ ] **Step 4: 运行确认通过**

Run: `cd backend; $env:PYTHONUTF8=1; python -m pytest tests/test_admin_overview.py tests/test_stats_time.py -q`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add backend/app/services/admin_overview.py backend/tests/test_admin_overview.py
git commit -m "feat(overview): 等级拆试用/付费、策略模板使用、交易使用 + build_overview 总装

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: 路由：新增 `/admin/overview`，删 `/admin/metrics`，`/admin/page-stats` 改范围参数

**Files:**
- Modify: `backend/app/routers/admin.py:15,24,26,313-360,362-525`
- Modify: `backend/app/schemas.py`（`AdminPageStatsOut` 加 `start`/`end`）
- Test: `backend/tests/test_admin_overview.py`（追加路由测试）

**Interfaces:**
- Consumes: `stats_time.resolve_range / today / day_start_utc / local_day / RangeError`，`admin_overview.build_overview`
- Produces:
  - `GET /admin/overview?range=|from=&to=` → `AdminOverviewOut`
  - `GET /admin/page-stats?range=|from=&to=` → `AdminPageStatsOut`（新增 `start`、`end`；`days` 保留）
  - 私有 `_resolve_range_or_422(range_, from_, to) -> RangeSpec`

- [ ] **Step 1: 写失败的测试**（追加到 `test_admin_overview.py`）

```python
# ── 路由 / routes ──────────────────────────────────────────────────────────

def _client(db_session, admin: User):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.core.database import get_db
    from app.routers import admin as admin_router
    from app.services.deps import require_admin

    app = FastAPI()
    app.include_router(admin_router.router)
    app.dependency_overrides[get_db] = lambda: db_session
    app.dependency_overrides[require_admin] = lambda: admin
    return TestClient(app)


def test_overview_route_resolves_preset_and_returns_shape(db_session):
    adm = _admin(db_session); _user(db_session, "a@t.co")
    res = _client(db_session, adm).get("/admin/overview?range=month")
    assert res.status_code == 200, res.text
    body = res.json()
    assert set(body) == {"range", "headline", "activityDaily", "funnel", "retention", "plans", "strategies", "trading"}
    assert body["range"]["start"].endswith("-01")
    assert body["headline"]["totalUsers"] == 1


@pytest.mark.parametrize("qs", [
    "from=2026-09-12&to=2026-09-10",
    "from=2025-01-01&to=2026-09-16",
    "range=fortnight",
    "from=2026-09-10",
    "from=2099-01-01&to=2099-01-02",
])
def test_overview_route_rejects_bad_ranges_with_422(db_session, qs):
    adm = _admin(db_session)
    assert _client(db_session, adm).get(f"/admin/overview?{qs}").status_code == 422


def test_metrics_route_is_gone(db_session):
    adm = _admin(db_session)
    assert _client(db_session, adm).get("/admin/metrics").status_code == 404


def test_page_stats_route_uses_same_range_params_and_stats_tz_days(db_session):
    from app.models import PageViewStat
    adm = _admin(db_session); u = _user(db_session, "a@t.co")
    # UTC 9/15 20:00 桶 = 北京 9/16 04:00 → 归到 9/16
    db_session.add(PageViewStat(path="/dashboard", time_bucket=datetime(2026, 9, 15, 20, 0), views=3, total_seconds=90.0))
    _visit(db_session, u, date(2026, 9, 16))
    db_session.commit()
    res = _client(db_session, adm).get("/admin/page-stats?from=2026-09-16&to=2026-09-16")
    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["start"], body["end"], body["days"]) == ("2026-09-16", "2026-09-16", 1)
    page = body["pages"][0]
    assert (page["path"], page["views"], page["visitors"], page["avgSeconds"]) == ("/dashboard", 3, 1, 30.0)
    assert body["dates"] == ["2026-09-16"]
    # 老参数不再接受 / legacy param no longer accepted
    assert _client(db_session, adm).get("/admin/page-stats?days=7").status_code == 200  # 未知参数被忽略，走默认本月
```

- [ ] **Step 2: 运行确认失败**

Run: `cd backend; $env:PYTHONUTF8=1; python -m pytest tests/test_admin_overview.py -q -k route`
Expected: ERROR/FAIL（`admin.py` 目前还 import 不到 `AdminMetricsOut`）

- [ ] **Step 3: 改 `schemas.py`：删 `AdminMetricsOut`，改 `AdminPageStatsOut`**

删掉 `class AdminMetricsOut(BaseModel): ...` 整段（5 个字段）。`AdminPageStatsOut` 改为：

```python
class AdminPageStatsOut(BaseModel):
    start: str  # 范围起止（STATS_TZ 日期）/ range bounds
    end: str
    days: int  # 统计窗口天数 / window size in days
    totalViews: int
    totalVisitors: int  # 全站去重人数，同样不是各页人数之和（一个人可看多页）
    avgSecondsOverall: float
    dates: list[str]  # 公共日期轴，与每个 page.daily 的顺序一致
    pages: list[PageStatOut]  # 按访问次数降序 / sorted by views desc
```

- [ ] **Step 4: 改 `admin.py` 的 import**

第 15 行改为：
```python
from datetime import date, datetime, timedelta, timezone
```
第 24 行 `from app.models import ...` 不动。第 26 行的 `from app.schemas import ...` 里**删掉 `AdminMetricsOut`**，加上 `AdminOverviewOut`。在第 29 行后加：

```python
from app.services.admin_overview import build_overview
from app.services.stats_time import RangeError, RangeSpec, day_start_utc, local_day, resolve_range, today as stats_today
```

- [ ] **Step 5: 删 `metrics`，加 `overview`**

把 `@router.get("/metrics", response_model=AdminMetricsOut)` 到 `return AdminMetricsOut(...)` 结束的整个函数删掉，原位置写：

```python
def _resolve_range_or_422(range_: str | None, from_: date | None, to: date | None) -> RangeSpec:
    """看板的时间范围参数。预设由后端解析（见 stats_time），非法一律 422。"""
    try:
        return resolve_range(range_, from_, to, stats_today())
    except RangeError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.get("/overview", response_model=AdminOverviewOut)
def overview(
    range_: str | None = Query(None, alias="range"),
    from_: date | None = Query(None, alias="from"),
    to: date | None = Query(None),
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """管理页看板：头部指标、活跃趋势、漏斗、留存、等级、策略与交易使用，一次返回。

    口径全部在 services/admin_overview.py；这里只解析范围。预设 `range=` 与自定义
    `from=&to=` 同时给时自定义优先；都不给默认本月。
    Admin dashboard in one call; all semantics live in services/admin_overview.
    """
    spec = _resolve_range_or_422(range_, from_, to)
    return build_overview(db, spec, stats_today())
```

- [ ] **Step 6: 改 `page_stats`**

函数签名与开头（原 `days: int = Query(7, ge=1, le=90)` 到 `cutoff = ...`）改为：

```python
@router.get("/page-stats", response_model=AdminPageStatsOut)
def page_stats(
    range_: str | None = Query(None, alias="range"),
    from_: date | None = Query(None, alias="from"),
    to: date | None = Query(None),
    db: Session = Depends(get_db),
    _admin: User = Depends(require_admin),
):
    """（docstring 原文保留，只把"含今天在内的 days 天"那段注释删掉）"""
    spec = _resolve_range_or_422(range_, from_, to)
    start_day, end_day = spec.start, spec.end
    # 桶是 UTC 整点，范围是 STATS_TZ 日；边界换成 naive UTC 再过滤，归日在 Python 侧做
    # Buckets are UTC hours, the range is STATS_TZ days: convert the bounds and
    # re-bucket per day in Python.
    cutoff = day_start_utc(start_day)
    cutoff_end = day_start_utc(end_day + timedelta(days=1))
```

`view_rows` 查询改为**不在 SQL 里按天分组**，改拉整点桶再在 Python 归日：

```python
    view_rows = (
        db.query(PageViewStat.path, PageViewStat.time_bucket, PageViewStat.views, PageViewStat.total_seconds)
        .filter(PageViewStat.time_bucket >= cutoff, PageViewStat.time_bucket < cutoff_end, PageViewStat.path != "/admin")
        .all()
    )
```

`visitor_window` 改为闭区间：

```python
    visitor_window = (PageVisitorDay.day >= start_day, PageVisitorDay.day <= end_day, PageVisitorDay.path != "/admin")
```

归并循环里 `for path, day, views, seconds in view_rows:` 改为：

```python
    for path, bucket, views, seconds in view_rows:
        cell = per_page.setdefault(path, {}).setdefault(
            local_day(bucket).isoformat(), {"views": 0, "seconds": 0.0, "visitors": 0}
        )
        cell["views"] += int(views or 0)
        cell["seconds"] += float(seconds or 0.0)
```

`day_keys = [...]` 改为 `day_keys = spec.day_keys()`。

返回改为：

```python
    return AdminPageStatsOut(
        start=start_day.isoformat(),
        end=end_day.isoformat(),
        days=spec.days,
        totalViews=total_views,
        totalVisitors=total_visitors,
        avgSecondsOverall=round(total_seconds / total_views, 1) if total_views else 0.0,
        dates=day_keys,
        pages=pages,
    )
```

删掉现在不再用的 `from datetime import ... time ...`（`time` 只有 page_stats 的旧 `cutoff` 用）——确认 `grep -n "time\." backend/app/routers/admin.py` 无其它引用后从 import 里去掉 `time`。

- [ ] **Step 7: 运行全部后端测试**

Run: `cd backend; $env:PYTHONUTF8=1; python -m pytest tests/test_admin_overview.py tests/test_stats_time.py tests/test_page_stats_paths.py tests/test_admin_router_guards.py -q`
Expected: 全部 PASS

Run: `cd backend; $env:PYTHONUTF8=1; python -m pytest -q -x`
Expected: 全套 PASS（确认没有别的测试引用 `/admin/metrics` 或 `AdminMetricsOut`）

- [ ] **Step 8: 提交**

```bash
git add backend/app/routers/admin.py backend/app/schemas.py backend/tests/test_admin_overview.py
git commit -m "feat(admin): GET /admin/overview 一次返回看板；删 /admin/metrics；page-stats 改 range/from/to 且按 STATS_TZ 归天

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: 前端类型与 API 封装

**Files:**
- Modify: `frontend/src/api/types.ts:196-232`
- Modify: `frontend/src/api/client.ts:772,828`

**Interfaces:**
- Produces（types）：`OverviewRangePreset`, `StatsRangeQuery`, `Compare`, `AdminOverviewRange`, `AdminOverviewHeadline`, `AdminActivityDay`, `AdminFunnelSteps`, `AdminFunnelWeek`, `AdminRetentionPoint`, `AdminStrategyUsage`, `AdminTradingDay`, `AdminOverview`；`AdminPageStats` 增 `start`/`end`
- Produces（client）：`adminApi.overview(range: StatsRangeQuery)`, `adminApi.pageStatsByRange(range: StatsRangeQuery)`
- **本任务只做加法**：`AdminMetrics`、`adminApi.metrics`、旧签名 `adminApi.pageStats(days)` 暂时保留，Task 13 接入新面板时一起删 / 改名，这样每个提交 `tsc -b` 都是绿的。

- [ ] **Step 1: 改 types**

在 `types.ts` 里 `export interface AdminMetrics {...}` 之后（保留它）插入：

```ts
// 管理后台：数据看板。全部按 STATS_TZ（北京时间）切天、剔除管理员；
// "活跃"= 当天打开过任一页面。口径见 docs/superpowers/specs/2026-09-16-admin-overview-dashboard-design.md
// admin: overview dashboard, day-bucketed in STATS_TZ, admins excluded.
export type OverviewRangePreset = 'week' | 'month' | 'last_month' | 'quarter' | 'year'
export type StatsRangeQuery = { preset: OverviewRangePreset } | { from: string; to: string }

export interface Compare {
  current: number
  previous: number // 紧邻本期之前、等长的一段 / equal-length window right before
}

export interface AdminOverviewRange {
  start: string // YYYY-MM-DD
  end: string
  days: number
  compareStart: string
  compareEnd: string
}

export interface AdminOverviewHeadline {
  totalUsers: number
  activeToday: number
  activeWeek: number
  activeMonth: number
  signups: Compare
}

export interface AdminActivityDay {
  date: string
  active: number
  signups: number
}

export interface AdminFunnelSteps {
  registered: number
  bound: number
  traded: number
  trialed: number
  paid: number
}
export interface AdminFunnelWeek extends AdminFunnelSteps {
  weekStart: string
}

export interface AdminRetentionPoint {
  rate: number | null // cohort 为空为 null / null when the cohort is empty
  cohortSize: number
  cohortFrom: string | null
  cohortTo: string | null
}

export interface AdminStrategyUsage {
  template: string // 预设键或 'custom' / preset key or 'custom'
  users: number
  enabledUsers: number
}

export interface AdminTradingDay {
  date: string
  fills: number
}

export interface AdminOverview {
  range: AdminOverviewRange
  headline: AdminOverviewHeadline
  activityDaily: AdminActivityDay[]
  funnel: { overall: AdminFunnelSteps; byWeek: AdminFunnelWeek[] }
  retention: { d2: AdminRetentionPoint; d7: AdminRetentionPoint; d30: AdminRetentionPoint }
  plans: Record<string, number> // FREE / PRO_PAID / PRO_TRIAL
  strategies: AdminStrategyUsage[]
  trading: { traders: Compare; fills: Compare; daily: AdminTradingDay[] }
}
```

`AdminPageDayPoint.date` 的注释 `// YYYY-MM-DD (UTC)` 改为 `// YYYY-MM-DD（STATS_TZ）`。`AdminPageStats` 改为：

```ts
export interface AdminPageStats {
  start: string
  end: string
  days: number
  totalViews: number
  totalVisitors: number
  avgSecondsOverall: number
  dates: string[] // 公共日期轴，连续无缺口 / contiguous shared date axis
  pages: AdminPageStat[]
}
```

- [ ] **Step 2: 改 client**

`client.ts` 顶部 type import 里加 `AdminOverview, StatsRangeQuery`（`AdminMetrics` 暂留）。在 `export const adminApi = {` 之前加：

```ts
// 看板与页面统计共用的时间范围参数：预设传 range=，自定义传 from=&to=。
// 预设换算在后端（本周从周一起之类的规则要能被 pytest 钉住）。
// Shared range query for the dashboard endpoints; presets resolve server-side.
function statsRangeQs(range: StatsRangeQuery): string {
  const qs = new URLSearchParams()
  if ('preset' in range) qs.set('range', range.preset)
  else {
    qs.set('from', range.from)
    qs.set('to', range.to)
  }
  return `?${qs.toString()}`
}
```

在 `pageStats: (days = 7) => ...` 这一行**之后**加两行（旧的 `pageStats` 与 `metrics` 先留着）：

```ts
  pageStatsByRange: (range: StatsRangeQuery) => request<AdminPageStats>(`/admin/page-stats${statsRangeQs(range)}`),
  overview: (range: StatsRangeQuery) => request<AdminOverview>(`/admin/overview${statsRangeQs(range)}`),
```

- [ ] **Step 3: 类型检查**

Run: `cd frontend; npx tsc -b`
Expected: 0 错误（本任务只做加法）

- [ ] **Step 4: 提交**

```bash
git add frontend/src/api/types.ts frontend/src/api/client.ts
git commit -m "feat(api): 看板类型、adminApi.overview 与 pageStatsByRange（旧接口暂留）

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: 通用折线 `LineChart.tsx`

**Files:**
- Create: `frontend/src/components/admin/overview/LineChart.tsx`

（`PageStatsCard` 改用它、去掉天数开关的改动放在 Task 13，与新面板一起接入，保证中间每个提交 `tsc -b` 都绿。）

**Interfaces:**
- Produces:
  ```ts
  export interface LineSeries { key: string; label: string; color: string; values: number[] }
  export default function LineChart(props: {
    dates: string[]
    series: LineSeries[]
    format: (v: number) => string
    ariaLabel: string
    peakLabel?: (formatted: string) => string  // 不传则不显示峰值 / omit to hide the peak caption
  }): JSX.Element
  export const SERIES_COLORS: string[]  // 与旧 LINE_COLORS 相同的 6 色
  ```

- [ ] **Step 1: 写 `LineChart.tsx`**（逻辑从 `PageStatsCard` 原样搬，只把"页面 × 指标"换成通用"多条序列"）

```tsx
// 管理看板的通用多线折线：纯 SVG polyline + 悬停竖线 + 数值面板。
// 从 PageStatsCard 抽出来，供页面统计 / 活跃趋势 / 成交趋势三处复用。
// 为什么不用 lightweight-charts：那是金融时间序列库，几十个点的日线用它要处理
// 它的 resize 怪癖；这里没有交互需求，纯 SVG 更小更稳。
// Generic multi-series line chart for the admin dashboard, extracted from
// PageStatsCard. Plain SVG rather than lightweight-charts: no interaction
// needed, and the library's resize quirks aren't worth it for a few daily points.
import { useMemo, useState } from 'react'

export interface LineSeries {
  key: string
  label: string
  color: string
  values: number[] // 与 dates 同长同序 / same length and order as dates
}

export const SERIES_COLORS = ['var(--purple-hi)', '#38bdf8', '#34d399', '#fbbf24', '#fb7185', '#c084fc']

const SVG_W = 720
const SVG_H = 200
const PAD_L = 8
const PAD_R = 8
const PAD_T = 10
const PAD_B = 10

export default function LineChart({
  dates,
  series,
  format,
  ariaLabel,
  peakLabel,
}: {
  dates: string[]
  series: LineSeries[]
  format: (v: number) => string
  ariaLabel: string
  peakLabel?: (formatted: string) => string
}) {
  const [hover, setHover] = useState<number | null>(null)

  // Y 轴上界取所有序列的最大值，下界固定 0：贴着最小值会把 3 和 4 的差距放大成
  // 半张图高。/ Y max across all series, baseline pinned at 0.
  const yMax = useMemo(() => Math.max(0, ...series.flatMap((s) => s.values)), [series])

  const lines = useMemo(() => {
    const n = dates.length
    const innerW = SVG_W - PAD_L - PAD_R
    const innerH = SVG_H - PAD_T - PAD_B
    const stepX = n > 1 ? innerW / (n - 1) : 0
    return series.map((s) => {
      const coords = s.values.map((v, idx) => {
        const ratio = yMax > 0 ? v / yMax : 0
        return { x: PAD_L + idx * stepX, y: PAD_T + innerH - ratio * innerH }
      })
      return { ...s, coords, points: coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ') }
    })
  }, [dates.length, series, yMax])

  if (dates.length === 0 || series.length === 0) return null

  const hoverRatio = hover === null ? 0 : hover / Math.max(dates.length - 1, 1)

  return (
    <div className="relative" onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="w-full" preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
        <line x1={PAD_L} y1={SVG_H - PAD_B} x2={SVG_W - PAD_R} y2={SVG_H - PAD_B}
              stroke="rgba(255,255,255,0.08)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {lines.map((line) => (
          <polyline key={line.key} fill="none" stroke={line.color} strokeWidth="2" strokeLinecap="round"
                    strokeLinejoin="round" points={line.points} vectorEffect="non-scaling-stroke" />
        ))}
        {hover !== null && (
          <>
            <line x1={lines[0].coords[hover].x} y1={PAD_T} x2={lines[0].coords[hover].x} y2={SVG_H - PAD_B}
                  stroke="rgba(255,255,255,0.25)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            {lines.map((line) => (
              // preserveAspectRatio="none" 会把圆压成椭圆，所以画小方块 / rects, not circles
              <rect key={line.key} x={line.coords[hover].x - 3} y={line.coords[hover].y - 3} width="6" height="6" rx="1" fill={line.color} />
            ))}
          </>
        )}
        {dates.map((d, idx) => {
          const w = (SVG_W - PAD_L - PAD_R) / dates.length
          return <rect key={d} x={PAD_L + idx * w} y={0} width={w} height={SVG_H} fill="transparent" onMouseEnter={() => setHover(idx)} />
        })}
      </svg>

      {hover !== null && (
        <div
          className="pointer-events-none absolute top-0 z-10 min-w-[9rem] rounded-lg border border-white/10 bg-ink-900/95 p-2.5 shadow-xl"
          style={hoverRatio > 0.5 ? { right: `${100 - hoverRatio * 100}%`, marginRight: 8 } : { left: `${hoverRatio * 100}%`, marginLeft: 8 }}
        >
          <p className="mb-1.5 text-[10px] text-neutral-400">{dates[hover]}</p>
          {lines.map((line) => (
            <p key={line.key} className="flex items-center gap-2 text-[11px] leading-5">
              <i className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: line.color }} />
              <span className="flex-1 truncate text-neutral-300">{line.label}</span>
              <span className="tabular-nums text-neutral-100">{format(line.values[hover])}</span>
            </p>
          ))}
        </div>
      )}

      <div className="mt-1 flex justify-between text-[10px] text-neutral-500">
        <span>{dates[0]}</span>
        {peakLabel && <span className="tabular-nums">{peakLabel(format(yMax))}</span>}
        <span>{dates[dates.length - 1]}</span>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {lines.map((line) => (
          <span key={line.key} className="flex items-center gap-1.5 text-[11px] text-neutral-400">
            <i className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: line.color }} />
            {line.label}
          </span>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `cd frontend; npx tsc -b`
Expected: 0 错误

- [ ] **Step 3: 提交**

```bash
git add frontend/src/components/admin/overview/LineChart.tsx
git commit -m "feat(admin): 看板通用多线 SVG 折线组件 LineChart

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: 时间范围：`rangeUtils.ts` + `RangePicker.tsx`

**Files:**
- Create: `frontend/src/components/admin/overview/rangeUtils.ts`
- Create: `frontend/src/components/admin/overview/RangePicker.tsx`
- Modify: `frontend/src/i18n/zh.json`、`frontend/src/i18n/en.json`（加 `admin.overview.range.*`）

**Interfaces:**
- Produces（rangeUtils）：
  ```ts
  export type RangeState = { kind: 'preset'; preset: OverviewRangePreset } | { kind: 'custom'; from: string; to: string }
  export const PRESETS: OverviewRangePreset[]  // ['week','month','last_month','quarter','year']
  export const MAX_RANGE_DAYS = 400
  export const DEFAULT_RANGE: RangeState        // { kind:'preset', preset:'month' }
  export function readRange(params: URLSearchParams): RangeState
  export function writeRange(params: URLSearchParams, state: RangeState): URLSearchParams  // 返回新对象，保留其它参数
  export function toQuery(state: RangeState): StatsRangeQuery
  export function todayIso(): string            // 浏览器本地日期 YYYY-MM-DD
  export function customRangeError(from: string, to: string): 'order' | 'future' | 'tooLong' | 'incomplete' | null
  export function rangeKey(state: RangeState): string  // 用作请求去重/依赖键
  ```
- Produces（RangePicker）：`<RangePicker value={RangeState} onChange={(s: RangeState) => void} />`

- [ ] **Step 1: 写 `rangeUtils.ts`**

```ts
// 看板时间范围的前端状态：URL 读写、自定义区间校验、转请求参数。
// 预设 → 具体起止日期的换算在后端（stats_time.resolve_range），这里不算日期：
// 前端没有单测框架，"本周从周一起"这类规则放后端才能被 pytest 钉住。
// Dashboard range state: URL (de)serialisation, custom-range validation, and
// conversion to the API query. Preset → dates is resolved server-side.
import type { OverviewRangePreset, StatsRangeQuery } from '../../../api/types'

export type RangeState =
  | { kind: 'preset'; preset: OverviewRangePreset }
  | { kind: 'custom'; from: string; to: string }

export const PRESETS: OverviewRangePreset[] = ['week', 'month', 'last_month', 'quarter', 'year']
// 与后端 stats_time.MAX_RANGE_DAYS 一致 / mirrors the backend cap
export const MAX_RANGE_DAYS = 400
export const DEFAULT_RANGE: RangeState = { kind: 'preset', preset: 'month' }

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

export function readRange(params: URLSearchParams): RangeState {
  const from = params.get('from')
  const to = params.get('to')
  if (from && to && ISO_DAY.test(from) && ISO_DAY.test(to)) return { kind: 'custom', from, to }
  const preset = params.get('range')
  if (preset && (PRESETS as string[]).includes(preset)) return { kind: 'preset', preset: preset as OverviewRangePreset }
  return DEFAULT_RANGE
}

export function writeRange(params: URLSearchParams, state: RangeState): URLSearchParams {
  const next = new URLSearchParams(params)
  next.delete('range'); next.delete('from'); next.delete('to')
  if (state.kind === 'preset') next.set('range', state.preset)
  else { next.set('from', state.from); next.set('to', state.to) }
  return next
}

export function toQuery(state: RangeState): StatsRangeQuery {
  return state.kind === 'preset' ? { preset: state.preset } : { from: state.from, to: state.to }
}

export function rangeKey(state: RangeState): string {
  return state.kind === 'preset' ? state.preset : `${state.from}..${state.to}`
}

export function todayIso(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1
}

// 返回错误码（对应 i18n admin.overview.range.error.*），合法返回 null。
// 浏览器本地"今天"与后端 STATS_TZ 的"今天"可能差一天，后端还会再校验一次。
// Error code for i18n, or null. The browser's "today" may differ from STATS_TZ
// by a day; the backend validates again.
export function customRangeError(from: string, to: string): 'order' | 'future' | 'tooLong' | 'incomplete' | null {
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) return 'incomplete'
  if (from > to) return 'order'
  if (to > todayIso()) return 'future'
  if (daysBetween(from, to) > MAX_RANGE_DAYS) return 'tooLong'
  return null
}
```

- [ ] **Step 2: 写 `RangePicker.tsx`**

```tsx
// 看板顶部的时间范围：五个预设胶囊 + 自定义（两个日期框 + 应用）。
// 自定义的校验只挡明显错误（起晚于止、未来、超 400 天），日期语义由后端定。
// Range picker: five preset pills plus a custom from/to with apply.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PRESETS, customRangeError, todayIso, type RangeState } from './rangeUtils'

export default function RangePicker({ value, onChange }: { value: RangeState; onChange: (next: RangeState) => void }) {
  const { t } = useTranslation()
  const [customOpen, setCustomOpen] = useState(value.kind === 'custom')
  const [from, setFrom] = useState(value.kind === 'custom' ? value.from : '')
  const [to, setTo] = useState(value.kind === 'custom' ? value.to : todayIso())
  const error = customOpen && (from || to) ? customRangeError(from, to) : null
  const canApply = customOpen && !!from && !!to && error === null

  const pill = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs transition ${active ? 'bg-white/10 text-neutral-100 ring-1 ring-white/20' : 'text-neutral-500 hover:text-neutral-300'}`

  return (
    <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label={t('admin.overview.range.label')}>
      {PRESETS.map((p) => (
        <button key={p} type="button" aria-pressed={value.kind === 'preset' && value.preset === p} className={pill(value.kind === 'preset' && value.preset === p)}
          onClick={() => { setCustomOpen(false); onChange({ kind: 'preset', preset: p }) }}>
          {t(`admin.overview.range.preset.${p}`)}
        </button>
      ))}
      <button type="button" aria-pressed={customOpen} className={pill(value.kind === 'custom' || customOpen)} onClick={() => setCustomOpen(true)}>
        {t('admin.overview.range.custom')}
      </button>

      {customOpen && (
        <div className="flex flex-wrap items-center gap-2">
          <input type="date" value={from} max={todayIso()} onChange={(e) => setFrom(e.target.value)} aria-label={t('admin.overview.range.from')}
                 className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-neutral-100" />
          <span className="text-xs text-neutral-500">–</span>
          <input type="date" value={to} max={todayIso()} onChange={(e) => setTo(e.target.value)} aria-label={t('admin.overview.range.to')}
                 className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-neutral-100" />
          <button type="button" disabled={!canApply} onClick={() => onChange({ kind: 'custom', from, to })}
                  className="rounded-full bg-prism-500/25 px-3 py-1 text-xs text-prism-100 ring-1 ring-prism-400/40 disabled:cursor-not-allowed disabled:opacity-40">
            {t('admin.overview.range.apply')}
          </button>
          {error && error !== 'incomplete' && <span className="text-xs text-down">{t(`admin.overview.range.error.${error}`)}</span>}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: 加 i18n**

`zh.json` 的 `"admin": {` 块内、`"pageStats": {` 之前加：

```json
    "overview": {
      "range": {
        "label": "时间范围",
        "preset": { "week": "本周", "month": "本月", "last_month": "上个月", "quarter": "本季度", "year": "今年" },
        "custom": "自定义",
        "from": "开始日期",
        "to": "结束日期",
        "apply": "应用",
        "shown": "{{start}} 至 {{end}} · 共 {{days}} 天 · 对比 {{compareStart}} 至 {{compareEnd}}",
        "error": { "order": "开始日期不能晚于结束日期", "future": "结束日期不能是未来", "tooLong": "最多 400 天" }
      }
    },
```

`en.json` 对应：

```json
    "overview": {
      "range": {
        "label": "Range",
        "preset": { "week": "This week", "month": "This month", "last_month": "Last month", "quarter": "This quarter", "year": "This year" },
        "custom": "Custom",
        "from": "From",
        "to": "To",
        "apply": "Apply",
        "shown": "{{start}} – {{end}} · {{days}} days · vs {{compareStart}} – {{compareEnd}}",
        "error": { "order": "Start must not be after end", "future": "End must not be in the future", "tooLong": "At most 400 days" }
      }
    },
```

（后续任务会往 `admin.overview` 里继续加键；保持这个块是唯一的 `overview` 对象，别重复建。）

- [ ] **Step 4: 类型检查**

Run: `cd frontend; npx tsc -b`
Expected: 0 错误

- [ ] **Step 5: 提交**

```bash
git add frontend/src/components/admin/overview/rangeUtils.ts frontend/src/components/admin/overview/RangePicker.tsx frontend/src/i18n/zh.json frontend/src/i18n/en.json
git commit -m "feat(admin): 看板时间范围选择器（预设 + 自定义），状态可写进 URL

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: 头部指标卡、活跃趋势、等级分布

**Files:**
- Create: `frontend/src/components/admin/overview/HeadlineCards.tsx`
- Create: `frontend/src/components/admin/overview/ActivityChart.tsx`
- Create: `frontend/src/components/admin/overview/PlanBreakdown.tsx`
- Modify: `frontend/src/i18n/zh.json`、`en.json`（`admin.overview.headline.*`、`.activity.*`、`.plans.*`；删 `admin.dau/wau/signupsLast7d`）

**Interfaces:**
- Produces:
  - `export function DeltaBadge({ current, previous }: Compare): JSX.Element`（HeadlineCards 内导出，TradingUsageCard 复用）
  - `<HeadlineCards headline={AdminOverviewHeadline} />`
  - `<ActivityChart daily={AdminActivityDay[]} />`
  - `<PlanBreakdown plans={Record<string, number>} />`

- [ ] **Step 1: 写 `HeadlineCards.tsx`**

```tsx
// 看板顶部五张指标卡。今日/周/月活跃永远"截至今天"，不跟范围走；新注册跟范围走并带对比。
// Five headline tiles. Active counts are always "as of today"; signups follow the range.
import { useTranslation } from 'react-i18next'
import type { AdminOverviewHeadline, Compare } from '../../../api/types'

// 对比小字："比上一期 +12%"。上一期为 0 时显示 —，因为百分比没有意义。
// Delta caption vs the previous period; "—" when the previous value is 0.
export function DeltaBadge({ current, previous }: Compare) {
  const { t } = useTranslation()
  if (previous === 0) return <span className="text-[11px] text-neutral-500">{t('admin.overview.delta.none')}</span>
  const pct = Math.round(((current - previous) / previous) * 100)
  const cls = pct > 0 ? 'text-up' : pct < 0 ? 'text-down' : 'text-neutral-400'
  const sign = pct > 0 ? '+' : ''
  return <span className={`text-[11px] tabular-nums ${cls}`}>{t('admin.overview.delta.vsPrev', { pct: `${sign}${pct}%` })}</span>
}

function Tile({ label, value, accent, footer }: { label: string; value: number; accent?: string; footer?: React.ReactNode }) {
  return (
    <div className="glass px-4 py-4">
      <div className="text-xs text-neutral-400">{label}</div>
      <div className={`num mt-1 font-display text-2xl font-bold ${accent ?? 'text-neutral-50'}`}>{value}</div>
      {footer && <div className="mt-1">{footer}</div>}
    </div>
  )
}

export default function HeadlineCards({ headline }: { headline: AdminOverviewHeadline }) {
  const { t } = useTranslation()
  return (
    <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      <Tile label={t('admin.totalUsers')} value={headline.totalUsers} />
      <Tile label={t('admin.overview.headline.activeToday')} value={headline.activeToday} accent="text-up" />
      <Tile label={t('admin.overview.headline.activeWeek')} value={headline.activeWeek} accent="text-prism-300" />
      <Tile label={t('admin.overview.headline.activeMonth')} value={headline.activeMonth} accent="text-prism-300" />
      <Tile label={t('admin.overview.headline.signups')} value={headline.signups.current} footer={<DeltaBadge {...headline.signups} />} />
    </div>
  )
}
```

- [ ] **Step 2: 写 `ActivityChart.tsx`**

```tsx
// 活跃趋势：日活 + 新注册两条线，按天。
// Activity trend: daily active + daily signups.
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdminActivityDay } from '../../../api/types'
import LineChart, { SERIES_COLORS } from './LineChart'

export default function ActivityChart({ daily }: { daily: AdminActivityDay[] }) {
  const { t } = useTranslation()
  const dates = useMemo(() => daily.map((d) => d.date), [daily])
  const series = useMemo(() => [
    { key: 'active', label: t('admin.overview.activity.active'), color: SERIES_COLORS[0], values: daily.map((d) => d.active) },
    { key: 'signups', label: t('admin.overview.activity.signups'), color: SERIES_COLORS[2], values: daily.map((d) => d.signups) },
  ], [daily, t])
  return (
    <div className="glass mb-5 p-5">
      <h2 className="mb-1 text-sm font-semibold text-white">{t('admin.overview.activity.title')}</h2>
      <p className="mb-3 text-xs text-neutral-500">{t('admin.overview.activity.hint')}</p>
      <LineChart dates={dates} series={series} format={String} ariaLabel={t('admin.overview.activity.title')}
                 peakLabel={(v) => t('admin.pageStats.peak', { value: v })} />
    </div>
  )
}
```

- [ ] **Step 3: 写 `PlanBreakdown.tsx`**

```tsx
// 等级分布：FREE / PRO 付费 / PRO 试用。后端已拆好，这里只按固定顺序显示。
// Plan breakdown; the split is done server-side.
import { useTranslation } from 'react-i18next'

const ORDER = ['FREE', 'PRO_PAID', 'PRO_TRIAL'] as const
const CHIP: Record<string, string> = {
  FREE: 'bg-white/5 text-neutral-400',
  PRO_PAID: 'bg-prism-600/20 text-prism-300',
  PRO_TRIAL: 'bg-prism-600/10 text-prism-200',
}

export default function PlanBreakdown({ plans }: { plans: Record<string, number> }) {
  const { t } = useTranslation()
  // 后端可能出现表外的等级键（历史数据），排在固定三项之后原样显示
  // Any unexpected plan key from legacy data is shown after the fixed three
  const extra = Object.keys(plans).filter((k) => !(ORDER as readonly string[]).includes(k))
  return (
    <div className="glass mb-5 flex flex-wrap items-center gap-2 p-4">
      <span className="text-xs text-neutral-400">{t('admin.planBreakdown')}</span>
      {[...ORDER, ...extra].map((k) => (
        <span key={k} className={`tag ${CHIP[k] ?? 'bg-white/5 text-neutral-400'}`}>
          {t(`admin.overview.plans.${k}`, { defaultValue: k })} · {plans[k] ?? 0}
        </span>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: i18n**

`zh.json` 的 `admin.overview` 块内追加：

```json
      "delta": { "none": "上一期无数据", "vsPrev": "比上一期 {{pct}}" },
      "headline": { "activeToday": "今日活跃", "activeWeek": "周活跃 (7 天)", "activeMonth": "月活跃 (30 天)", "signups": "本期新注册" },
      "activity": { "title": "活跃趋势", "hint": "活跃 = 当天打开过任一页面的人数（不含管理员）。按北京时间切天。", "active": "日活跃", "signups": "新注册" },
      "plans": { "FREE": "FREE", "PRO_PAID": "PRO · 付费", "PRO_TRIAL": "PRO · 试用" },
```

`en.json`：

```json
      "delta": { "none": "no data in previous period", "vsPrev": "{{pct}} vs previous" },
      "headline": { "activeToday": "Active today", "activeWeek": "Active (7d)", "activeMonth": "Active (30d)", "signups": "Signups in range" },
      "activity": { "title": "Activity trend", "hint": "Active = opened at least one page that day (admins excluded). Days follow Beijing time.", "active": "Daily active", "signups": "Signups" },
      "plans": { "FREE": "FREE", "PRO_PAID": "PRO · paid", "PRO_TRIAL": "PRO · trial" },
```

两个文件都删掉 `admin.dau`、`admin.wau`、`admin.signupsLast7d` 三行（`admin.totalUsers`、`admin.planBreakdown` 保留继续用）。

- [ ] **Step 5: 类型检查**

Run: `cd frontend; npx tsc -b`
Expected: 0 错误

- [ ] **Step 6: 提交**

```bash
git add frontend/src/components/admin/overview/HeadlineCards.tsx frontend/src/components/admin/overview/ActivityChart.tsx frontend/src/components/admin/overview/PlanBreakdown.tsx frontend/src/i18n/zh.json frontend/src/i18n/en.json
git commit -m "feat(admin): 看板头部指标卡（含对比）、活跃趋势双线、等级分布拆试用/付费

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: 漏斗卡与留存卡

**Files:**
- Create: `frontend/src/components/admin/overview/FunnelCard.tsx`
- Create: `frontend/src/components/admin/overview/RetentionCard.tsx`
- Modify: `zh.json`、`en.json`（`admin.overview.funnel.*`、`.retention.*`）

**Interfaces:**
- Produces: `<FunnelCard funnel={AdminOverview['funnel']} />`，`<RetentionCard retention={AdminOverview['retention']} />`

- [ ] **Step 1: 写 `FunnelCard.tsx`**

```tsx
// 转化漏斗：五根横柱（注册 → 绑 MT5 → 下过单 → 开过试用 → 付费）+ 最近 8 周分批表。
// 五步互相独立、允许跳步，所以后一根不一定比前一根短；柱宽按"占注册人数比例"画。
// Conversion funnel: five independent steps (skipping allowed), bar width is the
// share of registered users; plus the last 8 signup weeks.
import { useTranslation } from 'react-i18next'
import type { AdminFunnelSteps, AdminFunnelWeek } from '../../../api/types'

const STEPS: (keyof AdminFunnelSteps)[] = ['registered', 'bound', 'traded', 'trialed', 'paid']

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—'
}

export default function FunnelCard({ funnel }: { funnel: { overall: AdminFunnelSteps; byWeek: AdminFunnelWeek[] } }) {
  const { t } = useTranslation()
  const { overall, byWeek } = funnel
  const base = overall.registered

  return (
    <div className="glass mb-5 p-5">
      <h2 className="mb-1 text-sm font-semibold text-white">{t('admin.overview.funnel.title')}</h2>
      <p className="mb-4 text-xs text-neutral-500">{t('admin.overview.funnel.hint')}</p>

      <ol className="space-y-2">
        {STEPS.map((step, i) => {
          const n = overall[step]
          const prev = i > 0 ? overall[STEPS[i - 1]] : null
          const width = base > 0 ? Math.max(2, (n / base) * 100) : 0
          return (
            <li key={step} className="grid grid-cols-[7rem_1fr_5rem] items-center gap-3 text-xs">
              <span className="text-neutral-300">{t(`admin.overview.funnel.step.${step}`)}</span>
              <div className="h-5 rounded bg-white/5">
                <div className="h-5 rounded bg-prism-500/50" style={{ width: `${width}%` }} />
              </div>
              <span className="text-right tabular-nums text-neutral-100">
                {n}
                {prev !== null && <span className="ml-1 text-[10px] text-neutral-500">{pct(n, prev)}</span>}
              </span>
            </li>
          )
        })}
      </ol>

      <h3 className="mb-2 mt-5 text-xs font-medium text-neutral-400">{t('admin.overview.funnel.byWeek')}</h3>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-xs">
          <thead>
            <tr className="text-left text-neutral-500">
              <th className="pb-2 font-medium">{t('admin.overview.funnel.weekOf')}</th>
              {STEPS.map((s) => <th key={s} className="pb-2 text-right font-medium">{t(`admin.overview.funnel.step.${s}`)}</th>)}
            </tr>
          </thead>
          <tbody>
            {byWeek.map((w) => (
              <tr key={w.weekStart} className="border-t border-white/5">
                <td className="py-1.5 tabular-nums text-neutral-300">{w.weekStart}</td>
                {STEPS.map((s) => (
                  <td key={s} className="py-1.5 text-right tabular-nums text-neutral-200">
                    {w[s]}
                    {s !== 'registered' && <span className="ml-1 text-[10px] text-neutral-500">{pct(w[s], w.registered)}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 写 `RetentionCard.tsx`**

```tsx
// 留存：次日 / 7 日 / 30 日三个数字，每个写清楚"算的是哪批人"。
// cohort 只含"第 N 天已经过去"的注册者，所以三个数字的分母不同，这是正确的。
// Retention: d2 / d7 / d30, each with its cohort spelled out. Cohorts differ
// per N by design (only users whose day N has elapsed).
import { useTranslation } from 'react-i18next'
import type { AdminRetentionPoint } from '../../../api/types'

const KEYS = ['d2', 'd7', 'd30'] as const

export default function RetentionCard({ retention }: { retention: Record<(typeof KEYS)[number], AdminRetentionPoint> }) {
  const { t } = useTranslation()
  return (
    <div className="glass mb-5 p-5">
      <h2 className="mb-1 text-sm font-semibold text-white">{t('admin.overview.retention.title')}</h2>
      <p className="mb-4 text-xs text-neutral-500">{t('admin.overview.retention.hint')}</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {KEYS.map((k) => {
          const p = retention[k]
          return (
            <div key={k} className="rounded-lg bg-white/5 px-4 py-3">
              <div className="text-xs text-neutral-400">{t(`admin.overview.retention.${k}`)}</div>
              <div className="num mt-1 font-display text-2xl font-bold text-neutral-50">
                {p.rate === null ? '—' : `${Math.round(p.rate * 100)}%`}
              </div>
              <div className="mt-1 text-[11px] text-neutral-500">
                {p.cohortSize === 0
                  ? t('admin.overview.retention.emptyCohort')
                  : t('admin.overview.retention.cohort', { from: p.cohortFrom, to: p.cohortTo, n: p.cohortSize })}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: i18n**

`zh.json` `admin.overview` 追加：

```json
      "funnel": {
        "title": "转化漏斗",
        "hint": "全部用户（不含管理员）。五步各自独立统计，允许跳步（例如没试用直接付费），所以后一步不一定比前一步少。百分比是相对上一步。",
        "step": { "registered": "注册", "bound": "绑定 MT5", "traded": "下过单", "trialed": "开过试用", "paid": "付费 PRO" },
        "byWeek": "最近 8 周注册的人各走到哪一步（百分比相对该周注册数）",
        "weekOf": "注册周（周一）"
      },
      "retention": {
        "title": "留存",
        "hint": "注册后第 N 天（按北京时间）打开过页面的比例。只算已经过了第 N 天的人。",
        "d2": "次日留存", "d7": "7 日留存", "d30": "30 日留存",
        "cohort": "{{from}} 至 {{to}} 注册的 {{n}} 人",
        "emptyCohort": "还没有满足天数的用户"
      },
```

`en.json`：

```json
      "funnel": {
        "title": "Conversion funnel",
        "hint": "All users (admins excluded). Steps are independent and may be skipped (e.g. paid without a trial), so a later step can exceed an earlier one. Percentages are relative to the previous step.",
        "step": { "registered": "Registered", "bound": "Linked MT5", "traded": "Placed a trade", "trialed": "Started trial", "paid": "Paid PRO" },
        "byWeek": "Where each of the last 8 signup weeks got to (percent of that week's signups)",
        "weekOf": "Signup week (Mon)"
      },
      "retention": {
        "title": "Retention",
        "hint": "Share of users who opened a page on day N after signup (Beijing time). Only users whose day N has passed are counted.",
        "d2": "Day-2", "d7": "Day-7", "d30": "Day-30",
        "cohort": "{{n}} users signed up {{from}} – {{to}}",
        "emptyCohort": "No users old enough yet"
      },
```

- [ ] **Step 4: 类型检查**

Run: `cd frontend; npx tsc -b`
Expected: 0 错误

- [ ] **Step 5: 提交**

```bash
git add frontend/src/components/admin/overview/FunnelCard.tsx frontend/src/components/admin/overview/RetentionCard.tsx frontend/src/i18n/zh.json frontend/src/i18n/en.json
git commit -m "feat(admin): 转化漏斗卡（总 + 8 周分批）与留存卡

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: 策略使用卡与交易使用卡

**Files:**
- Create: `frontend/src/utils/strategyTemplates.ts`
- Modify: `frontend/src/pages/StrategiesPage.tsx:67-74`
- Create: `frontend/src/components/admin/overview/StrategyUsageCard.tsx`
- Create: `frontend/src/components/admin/overview/TradingUsageCard.tsx`
- Modify: `zh.json`、`en.json`（`admin.overview.strategies.*`、`.trading.*`）

**Interfaces:**
- Produces: `export const TEMPLATE_LABEL_KEYS: Record<StrategyTemplateKey, string>`（搬家，值不变）
- Produces: `<StrategyUsageCard rows={AdminStrategyUsage[]} />`，`<TradingUsageCard trading={AdminOverview['trading']} />`

- [ ] **Step 1: 搬 `TEMPLATE_LABEL_KEYS`**

新建 `frontend/src/utils/strategyTemplates.ts`：

```ts
// 策略预设键 → i18n 标签键。原本是 StrategiesPage 的私有常量，管理看板也要显示
// 模板名，搬到这里两处共用。
// Preset key → i18n label key, shared by StrategiesPage and the admin dashboard.
import type { StrategyTemplateKey } from '../api/types'

export const TEMPLATE_LABEL_KEYS: Record<StrategyTemplateKey, string> = {
  ma_trend: 'strategy.templateMaTrend',
  macd_cross: 'strategy.templateMacdCross',
  rsi_reversal: 'strategy.templateRsiReversal',
  bollinger_breakout: 'strategy.templateBollingerBreakout',
  donchian_breakout: 'strategy.templateDonchianBreakout',
  macd_rsi_combo: 'strategy.templateMacdRsiCombo',
}
```

`StrategiesPage.tsx`：删掉第 60–74 行的注释与 `const TEMPLATE_LABEL_KEYS = {...}` 定义，在 import 区加 `import { TEMPLATE_LABEL_KEYS } from '../utils/strategyTemplates'`。

- [ ] **Step 2: 写 `StrategyUsageCard.tsx`**

```tsx
// 策略使用：每个预设模板有多少人建过、多少人当前启用中。看的是"现在谁在用"，不跟范围走。
// Strategy usage per preset template: users who created one, users with one enabled. Not range-bound.
import { useTranslation } from 'react-i18next'
import type { AdminStrategyUsage, StrategyTemplateKey } from '../../../api/types'
import { TEMPLATE_LABEL_KEYS } from '../../../utils/strategyTemplates'

export default function StrategyUsageCard({ rows }: { rows: AdminStrategyUsage[] }) {
  const { t } = useTranslation()
  const name = (template: string) =>
    template in TEMPLATE_LABEL_KEYS ? t(TEMPLATE_LABEL_KEYS[template as StrategyTemplateKey]) : t('strategy.nameplaceholderCustom')
  return (
    <div className="glass p-5">
      <h2 className="mb-1 text-sm font-semibold text-white">{t('admin.overview.strategies.title')}</h2>
      <p className="mb-3 text-xs text-neutral-500">{t('admin.overview.strategies.hint')}</p>
      {rows.length === 0 ? (
        <p className="py-3 text-sm text-neutral-500">{t('admin.overview.strategies.empty')}</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-neutral-500">
              <th className="pb-2 font-medium">{t('admin.overview.strategies.colTemplate')}</th>
              <th className="pb-2 text-right font-medium">{t('admin.overview.strategies.colUsers')}</th>
              <th className="pb-2 text-right font-medium">{t('admin.overview.strategies.colEnabled')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.template} className="border-t border-white/5">
                <td className="py-1.5 text-neutral-200">{name(r.template)}<code className="ml-2 text-[10px] text-neutral-500">{r.template}</code></td>
                <td className="py-1.5 text-right tabular-nums text-neutral-200">{r.users}</td>
                <td className="py-1.5 text-right tabular-nums text-neutral-200">{r.enabledUsers}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
```

- [ ] **Step 3: 写 `TradingUsageCard.tsx`**

```tsx
// 交易使用：本期有成交的人数、成交笔数（都带对比），加一条按天成交笔数折线。
// Trading usage: distinct traders and fill count (with deltas) plus a daily fills line.
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdminOverview } from '../../../api/types'
import { DeltaBadge } from './HeadlineCards'
import LineChart, { SERIES_COLORS } from './LineChart'

export default function TradingUsageCard({ trading }: { trading: AdminOverview['trading'] }) {
  const { t } = useTranslation()
  const dates = useMemo(() => trading.daily.map((d) => d.date), [trading])
  const series = useMemo(
    () => [{ key: 'fills', label: t('admin.overview.trading.fills'), color: SERIES_COLORS[3], values: trading.daily.map((d) => d.fills) }],
    [trading, t],
  )
  return (
    <div className="glass p-5">
      <h2 className="mb-1 text-sm font-semibold text-white">{t('admin.overview.trading.title')}</h2>
      <p className="mb-3 text-xs text-neutral-500">{t('admin.overview.trading.hint')}</p>
      <div className="mb-4 grid grid-cols-2 gap-4">
        <div>
          <div className="text-xs text-neutral-400">{t('admin.overview.trading.traders')}</div>
          <div className="num mt-1 font-display text-2xl font-bold text-neutral-50">{trading.traders.current}</div>
          <DeltaBadge {...trading.traders} />
        </div>
        <div>
          <div className="text-xs text-neutral-400">{t('admin.overview.trading.fills')}</div>
          <div className="num mt-1 font-display text-2xl font-bold text-neutral-50">{trading.fills.current}</div>
          <DeltaBadge {...trading.fills} />
        </div>
      </div>
      <LineChart dates={dates} series={series} format={String} ariaLabel={t('admin.overview.trading.fills')}
                 peakLabel={(v) => t('admin.pageStats.peak', { value: v })} />
    </div>
  )
}
```

- [ ] **Step 4: i18n**

`zh.json` `admin.overview` 追加：

```json
      "strategies": {
        "title": "策略使用",
        "hint": "按预设模板统计：建过 = 至少建过一条；启用中 = 当前有一条开着、在持续评估出信号。不含管理员。",
        "empty": "还没有人创建策略。",
        "colTemplate": "模板", "colUsers": "建过的人", "colEnabled": "启用中的人"
      },
      "trading": {
        "title": "交易使用",
        "hint": "只算状态为已成交的订单，按成交时间（北京时间）落在所选范围内。不含管理员。",
        "traders": "有成交的人数", "fills": "成交笔数"
      },
```

`en.json`：

```json
      "strategies": {
        "title": "Strategy usage",
        "hint": "Per preset template: created = at least one strategy; enabled = currently has one running and evaluating. Admins excluded.",
        "empty": "No strategies created yet.",
        "colTemplate": "Template", "colUsers": "Created by", "colEnabled": "Enabled by"
      },
      "trading": {
        "title": "Trading usage",
        "hint": "FILLED orders only, by fill time (Beijing) within the selected range. Admins excluded.",
        "traders": "Users with fills", "fills": "Fills"
      },
```

- [ ] **Step 5: 类型检查**

Run: `cd frontend; npx tsc -b`
Expected: 0 错误

- [ ] **Step 6: 提交**

```bash
git add frontend/src/utils/strategyTemplates.ts frontend/src/pages/StrategiesPage.tsx frontend/src/components/admin/overview/StrategyUsageCard.tsx frontend/src/components/admin/overview/TradingUsageCard.tsx frontend/src/i18n/zh.json frontend/src/i18n/en.json
git commit -m "feat(admin): 策略模板使用卡与交易使用卡；模板标签键搬到 utils 共用

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: `OverviewPanel` 总装 + 接入 `AdminPage`

**Files:**
- Create: `frontend/src/components/admin/overview/OverviewPanel.tsx`
- Modify: `frontend/src/components/admin/PageStatsCard.tsx`（改用 `LineChart`，去掉天数开关）
- Modify: `frontend/src/api/client.ts`、`frontend/src/api/types.ts`（删 `metrics`/`AdminMetrics`/旧 `pageStats(days)`，`pageStatsByRange` 改名 `pageStats`）
- Modify: `frontend/src/pages/AdminPage.tsx:13,20,352-358,460-486,527-534,790-832`
- Modify: `zh.json`、`en.json`（`admin.overview.loadFailed`、`.retry`；`admin.pageStats.title` 改、删 `daysLabel`/`daysOption`）

**Interfaces:**
- Consumes: 前面所有卡片组件、`rangeUtils`、`adminApi.overview / pageStats`
- Produces: `<OverviewPanel />`（无 props；自己读写 URL 的 `range/from/to`）

- [ ] **Step 1: 写 `OverviewPanel.tsx`**

```tsx
// 管理页「数据看板」页签。职责：时间范围状态（写在 URL 里，刷新不丢、可分享）、
// 两个接口各自加载各自失败、把所有卡片按设计顺序排出来。
// URL 写入用 replace：切范围不该在浏览历史里留一条，否则"返回"变成在范围之间来回跳
// （AdminPage 的页签因同样理由干脆不写 URL）。
// The dashboard tab: range state in the URL (replace, not push), two requests
// that fail independently, cards in the spec's order.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { adminApi } from '../../../api/client'
import type { AdminOverview, AdminPageStats } from '../../../api/types'
import { localizeApiError } from '../../../api/utils'
import { SkeletonLine } from '../../Skeleton'
import PageStatsCard from '../PageStatsCard'
import ActivityChart from './ActivityChart'
import FunnelCard from './FunnelCard'
import HeadlineCards from './HeadlineCards'
import PlanBreakdown from './PlanBreakdown'
import RangePicker from './RangePicker'
import RetentionCard from './RetentionCard'
import StrategyUsageCard from './StrategyUsageCard'
import TradingUsageCard from './TradingUsageCard'
import { rangeKey, readRange, toQuery, writeRange, type RangeState } from './rangeUtils'

type Loadable<T> = { data: T | null; error: string | null; loading: boolean }

function useLoadable<T>(fetcher: () => Promise<T>, key: string): Loadable<T> & { reload: () => void } {
  const [state, setState] = useState<Loadable<T>>({ data: null, error: null, loading: true })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))
    fetcher().then(
      (data) => { if (!cancelled) setState({ data, error: null, loading: false }) },
      (err: unknown) => { if (!cancelled) setState((s) => ({ ...s, error: err instanceof Error ? localizeApiError(err.message) : 'error', loading: false })) },
    )
    return () => { cancelled = true }
    // fetcher 每次渲染都是新函数，用 key + tick 当依赖才不会无限重拉
    // fetcher is a fresh closure each render; key + tick are the real deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick])
  return { ...state, reload: () => setTick((n) => n + 1) }
}

function FailedCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="glass mb-5 flex items-center justify-between gap-3 p-4 text-xs">
      <span className="text-down">{t('admin.overview.loadFailed')}{message ? `：${message}` : ''}</span>
      <button type="button" onClick={onRetry} className="rounded-full bg-white/10 px-3 py-1 text-neutral-100 ring-1 ring-white/20">
        {t('admin.overview.retry')}
      </button>
    </div>
  )
}

export default function OverviewPanel() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const range: RangeState = readRange(searchParams)
  const setRange = useCallback(
    (next: RangeState) => setSearchParams(writeRange(searchParams, next), { replace: true }),
    [searchParams, setSearchParams],
  )
  const key = rangeKey(range)
  const overview = useLoadable<AdminOverview>(() => adminApi.overview(toQuery(range)), key)
  const pageStats = useLoadable<AdminPageStats>(() => adminApi.pageStats(toQuery(range)), key)

  return (
    <>
      <RangePicker value={range} onChange={setRange} />
      {overview.data && (
        <p className="-mt-3 mb-4 text-xs text-neutral-500">
          {t('admin.overview.range.shown', overview.data.range)}
        </p>
      )}

      {overview.error ? (
        <FailedCard message={overview.error} onRetry={overview.reload} />
      ) : !overview.data ? (
        <div className="glass mb-5 p-5"><SkeletonLine height={96} /></div>
      ) : (
        <>
          <HeadlineCards headline={overview.data.headline} />
          <ActivityChart daily={overview.data.activityDaily} />
          <FunnelCard funnel={overview.data.funnel} />
          <RetentionCard retention={overview.data.retention} />
          <PlanBreakdown plans={overview.data.plans} />
          <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <StrategyUsageCard rows={overview.data.strategies} />
            <TradingUsageCard trading={overview.data.trading} />
          </div>
        </>
      )}

      {pageStats.error ? (
        <FailedCard message={pageStats.error} onRetry={pageStats.reload} />
      ) : (
        <PageStatsCard stats={pageStats.data} />
      )}
    </>
  )
}
```

`SkeletonLine` 签名为 `{ width?, height?, className?, style? }`（`frontend/src/components/Skeleton.tsx:14`），上面用 `height={96}`。

- [ ] **Step 2: 改写 `PageStatsCard.tsx`**（新 props `{ stats: AdminPageStats | null }`，不再接收 `days`/`onDaysChange`）

整文件替换为（保留原文件头部的"为什么手写 SVG"注释可删，因已搬到 LineChart）：

```tsx
// 管理后台的页面访问统计卡：按天折线图 + 各页面明细表。
// 时间范围由父级 OverviewPanel 统一管理，这里不再有自己的天数开关。
// Admin page-stats card: per-day line chart plus a per-page table. The range
// is owned by OverviewPanel; this card no longer has its own window picker.
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdminPageStats } from '../../api/types'
import LineChart, { SERIES_COLORS } from './overview/LineChart'

// 三个指标量纲差太多，一次只画一个 / three metrics, wildly different scales: one at a time
type Metric = 'visitors' | 'views' | 'avgSeconds'
const METRICS: Metric[] = ['visitors', 'views', 'avgSeconds']

// 折线只画访问量前 6 的页面，明细表列全部 / chart the top 6, table lists all
const MAX_LINES = 6

export function fmtDwell(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return s > 0 ? `${m}m ${s}s` : `${m}m`
}

// 页面名走 i18n；nsSeparator: false 是必须的——带参路由的 key 里有冒号。
// Page names via i18n; nsSeparator:false is required (parameterised keys contain ':').
function usePageName() {
  const { t } = useTranslation()
  return (path: string) => t(`admin.pageStats.page.${path}`, { defaultValue: path, nsSeparator: false })
}

export default function PageStatsCard({ stats }: { stats: AdminPageStats | null }) {
  const { t } = useTranslation()
  const pageName = usePageName()
  const [metric, setMetric] = useState<Metric>('visitors')

  const series = useMemo(() => {
    if (!stats) return []
    return stats.pages.slice(0, MAX_LINES).map((page, i) => ({
      key: page.path,
      label: pageName(page.path),
      color: SERIES_COLORS[i % SERIES_COLORS.length],
      values: page.daily.map((d) => d[metric]),
    }))
  }, [stats, metric, pageName])

  const hasData = stats != null && stats.pages.length > 0
  const format = (v: number) => (metric === 'avgSeconds' ? fmtDwell(v) : String(v))

  return (
    <div className="glass mb-5 p-5">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-white">{t('admin.pageStats.title')}</h2>
        {hasData && (
          <span className="text-xs text-neutral-400">
            {t('admin.pageStats.summary', { visitors: stats.totalVisitors, views: stats.totalViews, avg: fmtDwell(stats.avgSecondsOverall) })}
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-neutral-500">{t('admin.pageStats.privacyHint')}</p>

      {!hasData ? (
        <p className="py-3 text-sm text-neutral-500">{t('admin.pageStats.empty')}</p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label={t('admin.pageStats.metricLabel')}>
            {METRICS.map((key) => (
              <button key={key} type="button" role="tab" aria-selected={metric === key} onClick={() => setMetric(key)}
                className={`rounded-full px-3 py-1 text-xs transition ${metric === key ? 'bg-prism-500/25 text-prism-100 ring-1 ring-prism-400/40' : 'text-neutral-400 hover:text-neutral-200'}`}>
                {t(`admin.pageStats.metric.${key}`)}
              </button>
            ))}
          </div>

          <LineChart
            dates={stats.dates}
            series={series}
            format={format}
            ariaLabel={t(`admin.pageStats.metric.${metric}`)}
            peakLabel={(v) => t('admin.pageStats.peak', { value: v })}
          />

          <div className="mt-5 overflow-x-auto">
            <table className="w-full min-w-[420px] text-xs">
              <thead>
                <tr className="text-left text-neutral-500">
                  <th className="pb-2 font-medium">{t('admin.pageStats.colPage')}</th>
                  <th className="pb-2 text-right font-medium">{t('admin.pageStats.metric.visitors')}</th>
                  <th className="pb-2 text-right font-medium">{t('admin.pageStats.metric.views')}</th>
                  <th className="pb-2 text-right font-medium">{t('admin.pageStats.metric.avgSeconds')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.pages.map((p) => (
                  <tr key={p.path} className="border-t border-white/5">
                    <td className="py-1.5">
                      <span className="text-neutral-200">{pageName(p.path)}</span>
                      <code className="ml-2 text-[10px] text-neutral-500">{p.path}</code>
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-neutral-200">{p.visitors}</td>
                    <td className="py-1.5 text-right tabular-nums text-neutral-200">{p.views}</td>
                    <td className="py-1.5 text-right tabular-nums text-neutral-400">{fmtDwell(p.avgSeconds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 3: 改 i18n 的 pageStats 文案 + 收尾 API**

`zh.json` 的 `admin.pageStats`：`"title": "页面访问统计（近 {{days}} 天）"` → `"title": "页面访问统计"`；删掉 `"daysLabel"` 与 `"daysOption"` 两行。
`en.json` 同样：`"title": "Page views"`；删 `daysLabel`、`daysOption`。

`frontend/src/api/client.ts`：删 `metrics: () => request<AdminMetrics>('/admin/metrics'),` 与旧的 `pageStats: (days = 7) => ...`，把 `pageStatsByRange` **改名为 `pageStats`**；type import 里去掉 `AdminMetrics`。`frontend/src/api/types.ts`：删 `export interface AdminMetrics {...}` 及其上方注释。

- [ ] **Step 4: 改 `AdminPage.tsx`**

1. import 区：删 `import PageStatsCard from '../components/admin/PageStatsCard'`；加 `import OverviewPanel from '../components/admin/overview/OverviewPanel'`；type import 里删 `AdminMetrics, AdminPageStats`。
2. 状态区：删掉
   ```ts
   const [metrics, setMetrics] = useState<AdminMetrics | null>(null)
   const [pageStats, setPageStats] = useState<AdminPageStats | null>(null)
   // ...注释...
   const [pageStatsDays, setPageStatsDays] = useState(7)
   ```
3. `load()`：`Promise.allSettled([...])` 里删 `adminApi.metrics(),` 与 `adminApi.pageStats(pageStatsDays),` 两行；解构改为 `const [usersRes, settingsRes, pricingRes, trialRes, socialRes, emailGateRes, candleRes, strategyRes] = results`；删掉
   ```ts
   const metrics = ok(metricsRes)
   if (metrics) setMetrics(metrics)
   const pageStatsVal = ok(pageStatsRes)
   if (pageStatsVal) setPageStats(pageStatsVal)
   ```
   注释里的"十个接口"改为"八个接口"。
4. 删掉整个 `changePageStatsDays` 函数及其上方注释。
5. `const planCounts = metrics?.planCounts ?? {}`（约 755 行）删掉。
6. `{tab === 'data' && ( <> ... </> )}` 整段（从 `{/* 运营指标 */}` 到 `<PageStatsCard ... />` 结束）替换为：
   ```tsx
   {tab === 'data' && <OverviewPanel />}
   ```
7. 若 `planChipClass` 与 `PLAN_OPTIONS` 在文件其它地方（用户表单的等级下拉、标签）仍被引用则保留；只在不再被引用时删除（`grep -n "planChipClass\|PLAN_OPTIONS" frontend/src/pages/AdminPage.tsx` 确认）。

- [ ] **Step 5: i18n**

`zh.json` `admin.overview` 追加：`"loadFailed": "加载失败", "retry": "重试"`
`en.json`：`"loadFailed": "Failed to load", "retry": "Retry"`

- [ ] **Step 6: 类型检查与构建**

Run: `cd frontend; npx tsc -b`
Expected: 0 错误

Run: `cd frontend; npm run build`
Expected: 构建成功

- [ ] **Step 7: 本地预览验证**

按记忆 `local-preview-fixture` 起本地后端（`PYTHONUTF8=1`）与前端预览，用 preview 管理员账号打开管理页「数据看板」：
- 五个预设逐个点，头部数字与"{{start}} 至 {{end}}"说明随之变化；URL 出现 `?tab=data&range=...`。
- 自定义选 起 > 止，应用按钮禁用并显示错误文案；选合法区间后应用，URL 出现 `from=&to=`。
- 刷新页面，范围保持。
- 用浏览器 DevTools 把 `/admin/overview` 请求拦成 500（或临时停后端），只有看板上半部分显示"加载失败 · 重试"，页面统计卡照常。
- 手机宽度（resize 375px）：卡片单列，指标卡两列。
- 截图留证。

- [ ] **Step 8: 提交**

```bash
git add frontend/src/components/admin/overview/OverviewPanel.tsx frontend/src/components/admin/PageStatsCard.tsx frontend/src/api/client.ts frontend/src/api/types.ts frontend/src/pages/AdminPage.tsx frontend/src/i18n/zh.json frontend/src/i18n/en.json
git commit -m "feat(admin): 数据看板总装 OverviewPanel 接入管理页；页面统计卡接新范围；删 metrics 接口封装

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 14: 页面停留计时：切后台即上报，回前台重新计

**Files:**
- Modify: `frontend/src/components/Layout.tsx:492-531`

**Interfaces:**
- Consumes: `reportPageView(path, seconds)`（不变）

- [ ] **Step 1: 改 dwell effect**

把 `const dwellStartRef = useRef<number>(Date.now())` 之后的 `useEffect` 整个替换为：

```tsx
  const dwellStartRef = useRef<number>(Date.now())
  useEffect(() => {
    const path = location.pathname
    dwellStartRef.current = Date.now()
    let done = false

    const flush = () => {
      if (done) return
      done = true
      const seconds = (Date.now() - dwellStartRef.current) / 1000
      reportPageView(path, seconds)
    }
    // 切到后台（换标签页 / App 切走）立刻上报这一次访问；回到前台重新开始计一次新访问。
    // 这样"停留"只算屏幕亮着的时间，App 被系统杀掉也不会丢最后一页——以前是一直
    // 计时到下次路由切换，切后台几小时都算停留（靠 30 分钟封顶兜底），App 被杀则整条丢。
    // 代价是频繁切前后台的人访问次数会多几次；比丢数据和虚高时长合理。
    // On hidden: report this visit now; on visible: start a fresh visit. Dwell then
    // counts only foreground time, and a killed App loses nothing. Cost: frequent
    // switchers register more views — preferable to lost data and inflated dwell.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        flush()
      } else {
        dwellStartRef.current = Date.now()
        done = false
      }
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      flush()
    }
  }, [location.pathname])
```

原来那段"两个触发点缺一不可 / done 标记防重复"的长注释保留在 effect 上方，并在末尾补一句：`- visibilitychange：切后台即上报、回前台重计（见 effect 内注释）。`

- [ ] **Step 2: 类型检查**

Run: `cd frontend; npx tsc -b`
Expected: 0 错误

- [ ] **Step 3: 本地预览验证**

登录普通（非管理员）preview 用户，打开 `/dashboard`，DevTools Network 过滤 `telemetry/pageview`：
- 切到别的标签页 → 立刻出现一条 POST，body 的 `seconds` ≈ 刚才前台停留秒数。
- 切回来等 5 秒再切走 → 又一条，`seconds` ≈ 5，而不是累计。
- 切回来后站内跳到 `/charts` → 一条 `/dashboard` 的上报（从回前台起算），没有重复。
- 停留不到 1 秒就切走 → 没有请求（`MIN_DWELL_SECONDS` 仍生效）。

- [ ] **Step 4: 提交**

```bash
git add frontend/src/components/Layout.tsx
git commit -m "fix(telemetry): 页面停留切后台即上报、回前台重新计——停留只算前台时间，App 被杀不丢数据

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 15: 文档同步、全量验证、推送与 App 热更新

**Files:**
- Modify: `.trae/documents/PRISMX_01_产品文档（给人看）.md:187`
- Modify: `.trae/documents/PRISMX_02_技术架构（给技术看）.md`（admin 接口段，约第 460 行附近；先 `grep -n "27 个\|page-stats\|metrics" ` 定位）
- Modify: `docs/superpowers/specs/2026-09-16-admin-overview-dashboard-design.md`（状态改"已实施"，§5.1 补一句字段命名偏差）

- [ ] **Step 1: 产品文档**

第 187 行「数据」行替换为：

```
| 数据 | 顶部时间范围（本周 / 本月 / 上个月 / 本季度 / 今年 / 自定义，写在 URL 里）管全页。**三条口径**：按北京时间切天（`STATS_TZ`）、一律不计管理员、"活跃"= 当天打开过任一页面。内容：总用户 / 今日·周·月活跃 / 本期新注册（带对比）；活跃趋势双线；转化漏斗（注册→绑 MT5→下过单→开过试用→付费，五步独立允许跳步，总漏斗 + 最近 8 周分批）；次日 / 7 日 / 30 日留存（只算已过第 N 天的人）；等级分布（PRO 拆付费 / 试用）；策略模板使用（建过 / 启用中）；交易使用（有成交人数 / 成交笔数 / 按天）；页面访问统计（次数、人数、平均停留）。**不统计 `/admin` 自身**。页面停留计时：切后台即上报、回前台重新计，停留只算前台时间 |
```

- [ ] **Step 2: 技术文档**

在 admin 接口段加一条：

```
- `/admin/overview`（2026-09-16）：看板一次返回。范围参数 `range=week|month|last_month|quarter|year` 或 `from=&to=`（自定义优先，都不给默认本月，跨度 ≤ 400 天，非法 422），**预设在后端解析**（`services/stats_time.resolve_range`，pytest 钉边界）。口径全在 `services/admin_overview.py`：`STATS_TZ`（默认 Asia/Shanghai）切天、`role != 'admin'`、活跃 = `page_visitor_days` 当天有行（**不读** `last_active_at` / `user_active_days`）。`/admin/metrics` 已删。`/admin/page-stats` 改同一套范围参数，`time_bucket` 仍存 UTC 整点、Python 侧按 `STATS_TZ` 归天；`page_visitor_days.day` 自此写 `STATS_TZ` 日期（历史行是 UTC 日，切换当天前后可能差一天），保留期 100 → 400 天。无 schema 变更。
```

若该段有「`/admin` 全部 27 个」这类计数，metrics 删、overview 加，总数不变，不用改。

- [ ] **Step 3: 设计文档状态**

`docs/superpowers/specs/2026-09-16-admin-overview-dashboard-design.md` 第 4 行 `状态：待负责人审阅` → `状态：已实施（2026-09-16）`；§5.1 代码块上方加一句：`响应里范围对象字段实际命名为 start / end / compareStart / compareEnd（避开 Python 关键字 from）；查询参数仍是 from / to。`

- [ ] **Step 4: 全量验证**

Run: `cd backend; $env:PYTHONUTF8=1; python -m pytest -q`
Expected: 全部 PASS

Run: `cd frontend; npx tsc -b; npm run build`
Expected: 0 错误，构建成功

- [ ] **Step 5: 提交并推送**

```bash
git add ".trae/documents/PRISMX_01_产品文档（给人看）.md" ".trae/documents/PRISMX_02_技术架构（给技术看）.md" docs/superpowers/specs/2026-09-16-admin-overview-dashboard-design.md
git commit -m "docs: 管理页数据看板重做——产品/技术文档同步，设计文档标记已实施

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push origin main
```

推 main 即触发后端自动部署（见记忆 `push-is-deploy`）。**碰了 `frontend/`，还要补一次 App 热更新**：按 `.trae/documents/PRISMX_05_安卓App（给技术看）.md` 里的热更新流程发布（`APP Pack` 目录，publish 已放行），不需要重新上架。

- [ ] **Step 6: 部署后检查**

生产管理页打开「数据看板」：五个预设都能出数、自定义能用、页面统计卡有数据、切范围 URL 跟着变。看后端日志无 500。若 `/admin/overview` 报 `ZoneInfoNotFoundError`，说明服务器缺系统 tzdata：`apt-get install tzdata` 或在 `requirements.txt` 加 `tzdata==2024.1` 后重装（Python 的 zoneinfo 在 Linux 上优先用系统库，Debian/Ubuntu 默认有）。

---

## 自查记录

**Spec 覆盖**
- §3.1 时区：Task 1（定义）、Task 2（写入侧）、Task 6（page-stats 归天）、Task 3–5（所有分组）✔
- §3.2 活跃=打开过页面：Task 3 `_distinct_visitors_since` / `activity_daily`、Task 4 留存 ✔
- §3.3 剔管理员：`NOT_ADMIN` 贯穿 Task 3–5，每条测试都放了管理员 ✔
- §4 时间范围六选项 + 约束 + 对比期 + URL：Task 1、6、9、13 ✔
- §5.1 全部字段：Task 3（headline/activityDaily）、4（funnel/retention）、5（plans/strategies/trading/build）、6（路由）✔
- §5.2 page-stats 改参数：Task 6 ✔；§5.3 保留期 400：Task 2 ✔；§5.4 无 schema 变更 ✔
- §6.1 文件结构：Task 8–13 ✔（`rangeUtils.ts` 职责已按 spec 修订版缩小为 URL/校验）
- §6.2 交互样式 / §6.3 错误处理：Task 9、10、13 ✔
- §7 计时修正：Task 14 ✔
- §8 测试清单：Task 1（范围）、2（时区写入、保留期）、3–6（每个数字、422）✔；计时靠预览手验 ✔
- §10 文档：Task 15 ✔

**占位扫描**：无 TBD/TODO；每个代码步骤都有完整代码。

**类型一致性**：
- `RangeSpec` 字段 `start/end/compare_start/compare_end` 在 Task 1 定义、Task 3–6 使用一致。
- `StatsRangeQuery`（Task 7）被 `rangeUtils.toQuery`（Task 9）与 `OverviewPanel`（Task 13）使用一致。
- `LineChart` props `dates/series/format/ariaLabel/peakLabel`（Task 8）在 Task 8、10、12 调用一致。
- `DeltaBadge` 接 `Compare`（Task 10），Task 12 以 `{...trading.traders}` 展开传入一致。
- `fmtDwell` 从 `PageStatsCard` 导出（Task 8），本计划内无其它文件引用，导出仅为将来复用；不影响一致性。
