# 管理页「数据看板」重做 — 设计文档

日期：2026-09-16
状态：已实施（2026-09-16）
范围：管理页第一个页签「数据看板」的后端接口、前端卡片、页面访问计时修正

---

## 0. 一句话

把现在 4 张卡 + 等级分布 + 页面访问统计的看板，重做成一个**口径统一、按时间范围切换、能看增长 / 漏斗 / 留存 / 功能使用**的后台看板，所有数字从现有数据表现算，不加新埋点、不加新表。

## 1. 为什么要做

现状 `GET /admin/metrics` + `GET /admin/page-stats` 存在 7 个口径问题：

1. 停留时长不暂停：切标签 / App 切后台仍在计时；App 被杀掉时最后一页整条丢失。
2. 三套时间口径：日活滚动 24h、周活滚动 7d、页面统计与注册按 UTC 自然日。后台人员在北京时间看，"今天"从 08:00 开始。
3. 日活 = 任何带 token 的请求（5 分钟节流）。App 后台刷数据的人也算活跃。
4. 管理员：总用户 / 日活 / 周活算进管理员，页面统计从写入侧剔掉管理员。两块对不上。
5. PRO 人数混了试用与付费。
6. 近 7 天注册只显示合计，按天数组已返回但前端未画。
7. metrics 端点无测试。

此外，看板缺少后台人员真正要看的东西：转化漏斗、留存、策略 / 交易的真实使用量。

## 2. 目标 / 非目标

**目标**
- 四类问题都能回答：增长健康度、转化漏斗、功能使用、页面访问。
- 所有按天的数字统一按**一个时区**切天，所有卡片统一**剔除管理员**，"活跃"统一定义为**打开过页面**。
- 一个时间范围选择器管全页，含自定义区间。
- 每个数字有测试钉住口径。

**非目标**
- 不做每日快照表 / 定时预算（规模不需要，见 §9）。
- 不做按周分批的留存表（样本太小，先只做三个留存数字）。
- 不做未登录页面（落地页 / FAQ）的流量统计（需要匿名埋点与独立隐私决策）。
- 不改游戏化「三日之约」的 `user_active_days` 表及其写入点。
- 不引入图表库。

## 3. 三条全局口径（贯穿所有卡片）

### 3.1 时区
- 新增配置 `STATS_TZ`，默认 `Asia/Shanghai`。所有"按天"的分组、"今天"的判断、时间范围的起止，都用它切天。**只在一处定义**（`backend/app/services/stats_time.py`），其它地方引用。
- `PageVisitorDay.day` 的写入改为 `STATS_TZ` 日期（现为 UTC 日期）。历史行仍是 UTC 日，切换后最早几天可能前后差一天，之后准确。不做数据迁移。
- `PageViewStat.time_bucket` 仍存 UTC 整点；查询时按 `STATS_TZ` 归到天。
- `UserActiveDay.day` 保持 UTC，不碰（游戏化数据源）。

### 3.2 活跃 = 打开过页面
- 数据源：`PageVisitorDay`（谁 · 哪天 · 看过哪页）。某人某天有任意一行即"当天活跃"。
- 不用 `last_active_at`，不用 `user_active_days`。

### 3.3 管理员一律剔除
- 所有人数统计 `WHERE role != 'admin'`。总用户、注册、漏斗、等级分布、策略 / 交易使用全部适用。
- 页面统计已在写入侧剔除，查询侧保留 `purge_admin_visitors` 兜底。

## 4. 时间范围

选项：**本周 / 本月 / 上个月 / 本季度 / 今年 / 自定义**。

| 选项 | 起 | 止 |
|---|---|---|
| 本周 | 本周周一 | 今天 |
| 本月 | 本月 1 日 | 今天 |
| 上个月 | 上月 1 日 | 上月最后一天 |
| 本季度 | 本季度首月 1 日 | 今天 |
| 今年 | 1 月 1 日 | 今天 |
| 自定义 | 用户选 | 用户选 |

- 起止都是 `STATS_TZ` 日期，闭区间。**预设由后端解析**：前端传 `range=week|month|last_month|quarter|year`，后端按 `STATS_TZ` 的"今天"算出 from/to；自定义才传 `from=YYYY-MM-DD&to=YYYY-MM-DD`。这样"本周从周一起"之类的规则只在后端一处，且能用 pytest 钉住（前端没有单测框架）。响应里带回解析后的 from/to 供前端显示。
- 约束：`from <= to`，`to <= 今天`，跨度 ≤ 400 天。前端不让选出违规值，后端返回 422。`range` 与 `from/to` 同时给时以 `from/to` 为准；都不给默认 `month`。
- **对比期**：紧邻本期之前、长度相同的一段。本月（1 日到 16 日，16 天）对比上月 1 日到 16 日；自定义 10 天对比前面 10 天。
- 当前选中范围写进 URL query（`?range=month` 或 `?from=&to=`），刷新不丢，可分享。默认「本月」。

## 5. 后端接口

### 5.1 `GET /admin/overview?range|from&to`（新增）
一次返回全部卡片数据。替代并删除 `GET /admin/metrics`。

响应里范围对象字段实际命名为 start / end / compareStart / compareEnd（避开 Python 关键字 from）；查询参数仍是 from / to。

```
{
  "range": { "start", "end", "days", "compareStart", "compareEnd" },
  "visitorDataSince": str|null,
  "headline": {
    "totalUsers": int,
    "activeToday": int, "activeWeek": int, "activeMonth": int,
    "signups": { "current": int, "previous": int }
  },
  "activityDaily": [ { "date", "active": int, "signups": int } ],   // 本期每天，补零
  "funnel": {
    "overall": { "registered", "bound", "traded", "trialed", "paid" },
    "byWeek": [ { "weekStart", "registered", "bound", "traded", "trialed", "paid" } ]  // 最近 8 周
  },
  "retention": {
    "d2": { "rate": float|null, "cohortSize": int, "cohortFrom", "cohortTo" },
    "d7":  { ... }, "d30": { ... }
  },
  "plans": { "FREE": int, "PRO_PAID": int, "PRO_TRIAL": int },
  "strategies": [ { "template": str, "users": int, "enabledUsers": int } ],  // users desc
  "trading": {
    "traders": { "current": int, "previous": int },
    "fills":   { "current": int, "previous": int },
    "daily": [ { "date", "fills": int } ]
  }
}
```

**各字段算法**（`backend/app/services/admin_overview.py`，纯函数接 `db, from, to`）：

- `totalUsers`：`COUNT(users) WHERE role != 'admin'`，不受范围影响。
- `activeToday / activeWeek / activeMonth`：`COUNT(DISTINCT user_id) FROM page_visitor_days WHERE day >= 今天 / 今天-6 / 今天-29`。永远截至今天，不跟范围走；用户是否为管理员通过 JOIN users 过滤。
- `signups`：`created_at` 按 `STATS_TZ` 归日后落在 [from, to] 的非管理员人数；`previous` 同法算对比期。
- `activityDaily`：本期每天 `active`（同上按天 DISTINCT）与 `signups`，缺日补零。
- `funnel.overall`：对全部非管理员用户，每一步 = "至少做过一次"的人数：
  - `registered`：全部
  - `bound`：`EXISTS mt5_accounts WHERE user_id`
  - `traded`：`EXISTS orders WHERE user_id AND status = 'FILLED'`
  - `trialed`：`trial_used_at IS NOT NULL`
  - `paid`：`EXISTS payments WHERE user_id AND status = 'FINISHED'`
  - 五步互相独立，允许跳步（未试用直接付费），后一步不保证 ≤ 前一步。
- `funnel.byWeek`：按注册周（周一起，`STATS_TZ`）分组最近 8 周，每组同上五个数。**不跟范围走**，固定最近 8 周。
- `retention.dN`：
  - cohort = 注册日 `d` 满足 `d + (N-1) <= 今天-1` 的非管理员用户（即"第 N 天已经完整过去"），且注册日不早于 `今天 - 400`（数据保留期）。
  - 留存 = cohort 中 `page_visitor_days` 有 `day == 注册日 + (N-1)` 行的人数 / cohort 人数。d2 即"注册次日"。
  - cohortSize = 0 时 `rate = null`。
  - 不跟范围走。
- `plans`：`GROUP BY plan, plan_is_trial`；PRO 且 `plan_is_trial` → `PRO_TRIAL`，否则 `PRO_PAID`；其它等级原样。剔管理员。
- `strategies`：`user_strategies GROUP BY template`：`users = COUNT(DISTINCT user_id)`（建过），`enabledUsers = COUNT(DISTINCT user_id) WHERE enabled`（当前启用中、在持续评估出信号）。`template` 为空归为 `custom`。剔管理员。按 `users` 降序。不跟范围走（看的是"现在谁在用"）。
- `trading`：`orders WHERE status = 'FILLED'`，按 `created_at` 归 `STATS_TZ` 日落在范围内：`traders = COUNT(DISTINCT user_id)`，`fills = COUNT(*)`，`daily` 补零；`previous` 同法算对比期。剔管理员。

### 5.2 `GET /admin/page-stats?range|from&to`（改参数）
- `days` 参数删除，改为与 5.1 相同的 `range` / `from/to`，解析共用 `stats_time.resolve_range()`。
- 按天分组改为 `STATS_TZ`：`time_bucket`（UTC 整点）加时区偏移后取日期，在 Python 侧完成（现有代码已在 Python 侧合并，沿用）。
- 其它算法（加权平均、去重人数、剔 `/admin`）不变。

### 5.3 保留期
- `services/page_stats.VISITOR_RETENTION_DAYS`：100 → **400**。
- 表体积：每人每页每天一行，按 200 日活 × 5 页 × 400 天 ≈ 40 万行上限，可接受。

### 5.4 无 schema 变更
不加表、不加列，`CURRENT_SCHEMA_REV` 不动。`PageVisitorDay.day` 只是语义改变（UTC 日 → `STATS_TZ` 日），列类型不变。

## 6. 前端

### 6.1 结构
```
frontend/src/components/admin/overview/
  OverviewPanel.tsx        // 挂进 AdminPage 的 tab === 'data'，管数据拉取、范围状态、错误分卡
  RangePicker.tsx          // 本周/本月/上个月/本季度/今年/自定义；自定义为两个 <input type="date">
  HeadlineCards.tsx        // 5 张卡 + 对比小字
  ActivityChart.tsx        // 日活 + 新注册双折线
  FunnelCard.tsx           // 5 根横柱 + 掉落% + 最近 8 周分批表
  RetentionCard.tsx        // d2/d7/d30 三个数字 + cohort 说明
  PlanBreakdown.tsx        // FREE / PRO 付费 / PRO 试用
  StrategyUsageCard.tsx    // 模板表
  TradingUsageCard.tsx     // 人数/笔数 + 按天折线
  rangeUtils.ts            // URL query ↔ 范围状态的序列化、自定义区间的前端校验（预设换算在后端）
  LineChart.tsx            // 从 PageStatsCard 抽出的纯 SVG 折线，供三处复用
```
- `PageStatsCard.tsx` 保留，去掉自己的天数开关，改为接收 `from/to`，内部图表换用 `LineChart`。
- `AdminPage.tsx` 的 `tab === 'data'` 分支只剩 `<OverviewPanel />`；删除 `metrics`、`pageStatsDays` 相关状态与请求。
- `api/client.ts`：`adminApi.metrics` 删除，新增 `adminApi.overview(from, to)`，`adminApi.pageStats(from, to)` 改签名。`api/types.ts` 同步。

### 6.2 交互与样式
- 遵循项目 UI 约定：页头 `PageHead`、开关只用 `Switch`、4px 网格间距、加载态不占壳。
- 对比小字：涨 `text-up`、跌 `text-down`、上一期为 0 显示 `—`。
- 漏斗柱子旁注一句"各步独立统计，允许跳步"。
- 留存每个数字下写"{cohortFrom} 至 {cohortTo} 注册的 {cohortSize} 人"。
- 手机：卡片单列，5 张指标卡两列。
- i18n：`admin.overview.*` 中英各一份；`admin.pageStats.title` 去掉 `近 {{days}} 天`，改为显示范围。

### 6.3 错误处理
- overview 与 page-stats 是两个请求，分别失败分别显示"加载失败 · 重试"，互不影响。
- 范围违规（`from > to`、`to > 今天`、跨度 > 400）前端禁用确认按钮并提示，不发请求。

## 7. 页面访问计时修正（`Layout.tsx` + `pageTracking.ts`）

现状：`Date.now()` 起点存 ref，路由切换 cleanup 与 `pagehide` 时上报一次。

改为：
- `visibilitychange → hidden`：立即上报本次访问（秒数 = 前台累计），标记 `done`。
- `visibilitychange → visible`：重置起点、`done = false`，视为一次新访问。
- 路由切换 cleanup 与 `pagehide` 逻辑不变。
- 副作用：频繁切前后台的人访问次数增加；换来 App 被杀不丢数据、停留只算前台时间。接受。
- `MIN_DWELL_SECONDS = 1` 仍生效：切后台前不满 1 秒不报。

## 8. 测试

后端（`backend/tests/test_admin_overview.py`，用现有 `db_session` fixture）：
- 管理员在每一项人数里都被剔除。
- `STATS_TZ` 跨日：UTC 23:30 的注册在北京时间算次日。
- 漏斗跳步：无试用直接付费的用户 `paid` 计入、`trialed` 不计入。
- 留存：注册不满 N 天的用户不进 cohort；cohort 为空 `rate = null`；恰好第 N 天有访问算留存、第 N+1 天有访问不算。
- 对比期计算：本月 16 天对比上月前 16 天；跨年、跨月边界。
- `plans`：PRO 试用与付费拆分正确。
- 范围校验：`from > to`、跨度 401 天 → 422。
- page-stats 改用 `from/to` 后，`test_page_stats_paths.py` 不受影响，仍通过。

范围解析（并入 `test_admin_overview.py`，`resolve_range` 纯函数）：
- 五种预设 → from/to；周一起算；上个月在 1 日、月末、跨年的边界；对比期长度与本期一致。
- 前端没有单测框架，`rangeUtils.ts` 只做 URL 序列化与校验，逻辑保持简单到能靠肉眼与本地预览确认。

计时修正：手动在本地预览验证——切标签后返回，网络面板出现一次上报；再次切走再出现一次。

## 9. 取舍记录

- **现算 vs 快照表**：选现算。138 人、每天打开看板几次，全部查询毫秒级；快照表要加 schema rev、定时任务、补历史，等到万级用户再考虑。
- **活跃用 `page_visitor_days` 而非改 `user_active_days`**：后者是游戏化数据源，改写入点会影响连续打卡判定。
- **时区改写入侧而非查询侧**：`PageVisitorDay` 只有日粒度，无法在查询时换时区，只能改写入时切天的口径；接受历史几天的偏差。
- **切后台即上报**：与"暂停计时、回来继续"相比，多几次访问计数但不会因 App 被杀丢数据，且实现更简单、不需要跨事件持久化状态。

## 10. 影响到的文档

实施完成后同步 `.trae/documents/PRISMX_01_产品文档（给人看）.md` 第 187 行「数据」页签描述，以及技术架构文档中的 admin 接口清单（metrics 删除、overview 新增、page-stats 参数变化）。
