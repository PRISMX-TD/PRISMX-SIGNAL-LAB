# Manager 行情网关设计

日期：2026-08-04
状态：已实现、已部署

## 背景

平台公共行情原本由 `ea/PRISMX_MarketFeed.mq5` 提供：一个 MT5 终端挂 EA，向后端推送报价
（`/api/feed/quotes`）、K 线（`/api/feed/candles`）和多周期趋势（`/api/webhook/trend`）。

现已取得交易商官方 MT5 Manager 账户，可直连券商服务器取数，不再依赖终端 GUI 进程。

本设计只覆盖行情替换。代客下单不在范围内（权限不足，且合规性质不同）。

## 实测结论

以下均为对 `192.109.17.69:443` login `1034` 的实际连接验证结果，非推测。

| 项目 | 结论 |
|---|---|
| 连接 | 成功。官方 Python 包 `MT5Manager`（5.0.6070）可用，无需写 C++ |
| 权限 | `RIGHT_MANAGER` / `RIGHT_CFG_GROUPS` / `RIGHT_RISK_MANAGER` / `RIGHT_FINTEZA_ACCESS` |
| 管辖组 | 6 个，全为 demo：`STD-USD` `ECN-USD` `PLUS-USD` `forex-hedge-usd-01/02` `forex-net-usd-01` |
| 可见品种 | 481 个 |
| K 线粒度 | **只有 M1**。请求 3 小时返回 180 根，相邻间隔统计 `{60: 179}` 无例外；`ChartRequest(symbol, from, to)` 无周期参数；API 中无其他 bar/period 方法 |
| 点差来源 | 由品种后缀决定，**与组无关**。用 STD 组查询 ECN 专属品种 `BTCUSD.p` 返回值与用 ECN 组查询完全相同 |
| Pump 模式 | 取报价需 `PUMP_MODE_SYMBOLS`；带 group 参数的 `TickLast` 还需 `PUMP_MODE_GROUPS`，否则返回 `MT_RET_ERR_NOTFOUND` |

### ChartRequest 性能实测（XAUUSD.s，服务器缓存预热后）

| 跨度 | M1 根数 | 耗时 |
|---|---|---|
| 7 天 | 6,893 | 0.71s |
| 30 天 | 29,642 | 2.35s |
| 90 天 | 87,594 | 3.13s |
| 200 天 | 193,421 | 4.21s |
| 400 天 | 388,324 | 17.71s |

冷启动首次请求显著更慢（200 天冷启动 81s vs 预热后 4.21s），服务器需先从磁盘载入历史。
覆盖天数与请求一致，无服务器端条数上限。**90 天作为单次取数上限**：3.13 秒，且覆盖所有
周期的展示需求（≈ 12.9 万根 M1 = 2.6 万根 M5 = 2160 根 H1 = 540 根 H4）。

### 点差档位实测

```
XAUUSD      bid=4059.91  ask=4059.99   点差 0.08   原始流（未加价）
XAUUSD.s    bid=4059.91  ask=4060.10   点差 0.19   标准档（bid 相同，ask 加 markup）
EURUSD      点差 0.00000                           原始流
EURUSD.s    点差 0.00011                           标准档，1.1 pip
BTCUSD.s    bid=63725.6  ask=63783.2   点差 57.6
BTCUSD.p    bid=63725.6  ask=63783.2   点差 57.6   与 .s 相同
```

裸名品种是未加价的原始流，这解释了初次探测时外汇出现零点差的现象。带 `.s` 后缀的才是
标准组客户实际成交价。

### Crypto 品种

服务器上存在完整的 `.s` 系列，`demo\STD-USD` 组配置未包含 Crypto 路径，但品种本身可查询、
有实时报价：

```
MCSA\Crypto SA\      BTCUSD.s  ETHUSD.s  BNBUSD.s  XRPUSD.s
MCSA\Crypto 2 SA\    ADAUSD.s  BCHUSD.s  DOGUSD.s  EOSUSD.s  LNKUSD.s  LTCUSD.s
```

## 范围

**范围内**

- Windows 上新增独立常驻网关进程，用 Manager API 取报价与 M1 K 线
- M1 本地聚合为 M5/M15/H1/H4/D1（含 M30 仅供趋势计算）
- 本地计算多周期趋势（EMA10/EMA30 + 慢线斜率）
- 三条链路按现有格式推送，摄取端点零改动
- 管理后台新增「行情品种」配置页，可随时增删推送品种
- 停用现有 EA
- 启动时自动侦测券商服务器时区偏移，无需手动配置夏令时切换

**范围外**

- 代客下单、账户管理（缺 dealer 权限，且合规责任边界不同，属后续阶段）
- Bridge 的任何逻辑
- 数据库 schema 变更（复用 `PlatformSetting`）

**成功标准**

- 前端行情表、图表、趋势页数据正常，品种名与切换前一致
- EA 停止后行情不中断
- 休市与周末不产生垃圾 K 线
- 后台改品种配置后 60 秒内生效，无需重启网关
- H4/D1 K 线 OHLC 与 MT5 终端一致，趋势方向可验证吻合
- 夏令时/冬令时切换时无需人工介入

## 架构

```
券商 MT5 服务器 192.109.17.69:443
        │  Manager API（Windows 原生 DLL）
        │  PUMP_MODE_SYMBOLS | PUMP_MODE_GROUPS
        ▼
┌──────────────────────────────────────────────────┐
│ Windows VPS（现有，与 EA 同机）                    │
│ manager_feed 网关                                 │
│                                                   │
│ 配置轮询  GET /admin/feed-symbols        60s      │
│ ① 报价    TickLast        → /api/feed/quotes  2s  │
│ ② M1      ChartRequest    → /api/feed/candles 3s  │
│ ③ 聚合    M1→M5/M15/H1/H4/D1 → /api/feed/candles │
│ ④ 趋势    EMA10/30 本地算  → /api/webhook/trend 5s│
│                                                   │
│ 时区侦测  TimeCurrent() vs UTC，启动时一次         │
│ 趋势缓存  180s 重算一次，5s 检查指纹后推送         │
│ K线回补   按周期分级：M1/M5 60s → D1 6h           │
│ 断线退避  5s → 10s → 20s … → 60s 上限            │
│                                                   │
│ 断线：停止上报（不推旧价）+ 自动重连               │
│ 启动：上报 481 个品种清单供后台下拉框使用           │
└──────────────────────────────────────────────────┘
        │  HTTPS + X-EA-Token（复用现有鉴权）
        ▼
Linux 后端 api.prismxsignallab.com
   摄取端点（零改动）：/api/feed/quotes /api/feed/candles /api/webhook/trend
   新增：GET/PUT /api/admin/feed-symbols、GET /api/admin/broker-symbols
        ▼
   前端：新增「行情品种」设置页，行情展示逻辑零改动
```

网关完全模仿 EA 的既有行为：向券商查询时用带后缀的真名，上报时用裸名。这正是 EA 的
`InpSymbolSuffix` 设计，因此前端、数据库、历史 K 线全部无缝衔接。

## 关键设计决策

### 决策 1：独立 Windows 进程，而非集成进后端

Manager API 是 Windows 原生 DLL，后端运行在 Linux 上。这是硬约束，非设计选择。

### 决策 2：复用 EA 的摄取端点，而非新开接口

现有 `/api/feed/candles` 与 `/api/feed/quotes` 已具备一整套经生产验证的防护：时钟纠偏、周末过滤、
重放去重、停滞检测、周期网格校验（commit `48bd5b2`）。复用等于继承这些防护。

### 决策 3：轮询而非事件回调

Manager API 支持 tick 事件 sink，但回调运行在原生 DLL 线程，与 Python HTTP 客户端混用有
线程安全风险。行情推送本身已有节流（后端只广播变化条目），2 秒轮询前端无感差异。

### 决策 4：断线时停止上报，不推缓存价

报价链路没有停滞检测（那是 K 线链路的防护）。断线时若推缓存价，前端会显示僵死价格。
停止上报可让后端既有的离线检测正常生效。

### 决策 5：品种配置存 DB，网关轮询

后台改配置无需重启网关。复用 `settings_store.py` 现有的
`get_/save_/invalidate_` 三件套模式（照 `candle_history` 那一组），key 为 `feed_symbols`。

品种下拉框数据由网关启动时上报（后端在 Linux 上无法自行查询 Manager）。

### 决策 6：连接失败退避，而非每轮重试

失败后从 5 秒起翻倍（10s → 20s → … → 60s 上限），避免被服务器当成暴力破解来源。
连接恢复后重置到 5 秒。

### 决策 7：趋势重算与推送分离

取 30 天 M1 实测单品种 2.35 秒，7 品种约 16 秒。趋势是慢变量（H4 EMA30 不会在一分钟内翻转），
所以按 **180 秒重算一次**、结果缓存复用。推送仍按 5 秒进行，但只推指纹（方向 + high/low）
变化的数据——重算间隔内无变化就不推，前端更新频率不变但无效写入和广播量归零。

## 聚合设计

### 完整性优先

Manager API 的 `ChartRequest` 只返回 M1。高周期 K 线由网关自行聚合，**宁缺勿假**：

1. **只用真实 M1** — 不做任何填充
2. **完整性判据** — 一根高周期 bar 必须集齐它覆盖的全部 M1 才生成。例如 M5 需要 5 根 M1，
   H4 需要 240 根。缺一根就不生成
3. **只输出已收盘 bar** — `drop_forming_bar()` 丢弃当前仍在形成中的桶

第 3 条同样关键：后端 `feed_candles` 会对新收盘 bar 触发策略求值（写信号、推送通知、
推进 `last_signal_bar_t` 去重游标），推未完成的 bar 会产生错误信号。

### 时区对齐（关键）

不同时区下，H4 的 4 小时窗口和 D1 的日窗口覆盖的是**完全不同的数据段**，OHLC 不同，
EMA 不同，趋势方向自然对不上。例如 GMT+2 券商，H4 bar 在 UTC 22:00/02:00/06:00/...，
而 UTC 对齐在 00:00/04:00/08:00/...，差了 2 小时窗口。

`bucket_start(t, interval, tz_offset_seconds)` 修复公式：

```
((t - tz_offset_seconds) // size) * size + tz_offset_seconds
```

- M1/M5/M15/M30/H1：整除 3600 秒，时区偏移无影响
- H4/D1：时区偏移决定窗口边界，必须对齐券商时区

### 自动侦测时区

网关启动后通过 Manager API 的 `TimeCurrent()` 取服务器时间，与本地 UTC 对比自动算出偏移，
四舍五入到整小时。配置文件里的 `broker_gmt_offset` 仅作侦测失败时的兜底。

夏令时/冬令时切换：网关重启或重连后自动重新侦测，无需人工介入。

### K 线回补分级

已收盘的 K 线不会再变，频繁重拉全部历史没有意义。按周期分级回补：

| 周期 | 取数跨度 | 刷新间隔 | 典型根数 |
|---|---|---|---|
| M1 | 2 小时 | 60s | ≈ 120 |
| M5 | 12 小时 | 60s | ≈ 144 |
| M15 | 2 天 | 300s | ≈ 192 |
| H1 | 7 天 | 900s | ≈ 168 |
| H4 | 30 天 | 3600s | ≈ 180 |
| D1 | 90 天 | 6h | ≈ 64 |

所有跨度在 90 天单次取数上限内，最长档 D1 约 3 秒。

增量推送（`_push_candles_tick`）每次只取 6 小时 M1（≈ 0.1s），聚合出所有周期最新几根。

### 趋势计算

沿用 EA 算法：EMA(10) vs EMA(30) + 慢线 3 根斜率判方向。两条件同时成立才输出 UP/DOWN，
滤掉横盘里的假交叉。数据不足的周期不放进结果（而非填 FLAT），让前端区分"震荡"和"无数据"。

## 推送间隔

| 链路 | 间隔 | 说明 |
|---|---|---|
| 报价 | 2s | `TickLast` 快照 |
| K 线增量 | 3s | 6h M1 聚合最新几根 |
| K 线回补 | 分级（上表） | 闭市 bar 无需频繁重拉 |
| 趋势重算 | 180s | 30d M1 聚合 + EMA 计算 |
| 趋势推送 | 5s | 只推指纹变化的，重算间隔内通常无推送 |
| 配置轮询 | 60s | 后台改品种后自动生效 |
| 休市判定 | 300s 无 tick | 报价停滞视为休市 |

## 垃圾 K 线防护

### 问题根源

后端注释记录了实测案例：休市期间喂价端不只在几个模板间交替，还会**整段平移行情**——把
04:00–06:00 的 24 根 5 分钟线搬到 06:00–08:00，每根的原件都在 24 根之前。

根源在 EA 的工作方式：`CopyRates` 向终端要数据，休市时终端返回的仍是旧 bar，EA 无法区分
"这是新数据"与"没有新数据"。

### 网关为何天然更干净

`ChartRequest(symbol, from, to)` 返回服务器数据库中**真实存在**的 M1。休市期间该时间区间内
没有 bar，返回空。网关拿不到数据就不推。

### 三层防护

**网关侧：**
1. 只推真实存在的 M1 — `ChartRequest` 返回空即不推
2. 只推已收盘的 bar — `drop_forming_bar()` 丢弃形成中的桶
3. 聚合要求完整性 — 缺 M1 则不生成高周期 bar

**后端侧：** 时钟纠偏、周末过滤、重放去重、周期网格校验作为第二层防线。

网关不造假 + 后端会拦，双保险。

## 品种配置

`PlatformSetting` 表，key = `feed_symbols`：

```json
{
  "symbols": [
    { "display": "XAUUSD", "broker": "XAUUSD.s", "enabled": true },
    { "display": "XAGUSD", "broker": "XAGUSD.s", "enabled": true },
    { "display": "WTI",    "broker": "WTI.s",    "enabled": true },
    { "display": "EURUSD", "broker": "EURUSD.s", "enabled": true },
    { "display": "GBPUSD", "broker": "GBPUSD.s", "enabled": true },
    { "display": "USDJPY", "broker": "USDJPY.s", "enabled": true },
    { "display": "BTCUSD", "broker": "BTCUSD.s", "enabled": true }
  ]
}
```

默认值即现有 EA 的 `InpSymbols` 七个品种，BTCUSD 以 `.s` 补齐。

- `display` — 前端展示与数据库存储用，保持与切换前一致
- `broker` — 向 Manager API 查询用的真名
- `enabled` — 停用后网关立即停推，不删历史数据

## 周期配置

沿用 EA 现有设置，两组周期不同：

- K 线（`g_candleTf`）：M1 M5 M15 H1 H4 D1
- 趋势（`g_trendTf`）：M1 M5 M15 M30 H1 H4

趋势参数对齐 EA：`InpTrendFastLen=10`、`InpTrendSlowLen=30`、`InpTrendSlopeLen=3`。

## 改动清单

**新增：网关（独立目录 `manager_feed/`）**

| 模块 | 文件 | 职责 |
|---|---|---|
| 配置 | `config.py` | config.ini + 环境变量，默认品种，时区偏移兜底 |
| Manager 连接 | `manager_client.py` | 连接/断线/退避重连、订阅、TickLast、ChartRequest、SymbolGet、品种清单、TimeCurrent 时区侦测 |
| 聚合 | `aggregate.py` | M1→高周期聚合、时区对齐 `bucket_start`、完整性判据、形成中 bar 丢弃 |
| 趋势 | `trend.py` | EMA 计算、双条件方向判定（EMA10/30 + 慢线斜率） |
| 后端上报 | `backend_client.py` | 报价、K 线、趋势、品种清单、配置拉取，统一 X-EA-Token 鉴权 |
| 网关主循环 | `gateway.py` | 单线程时间片轮转，报价/K线增量/K线回补/趋势重算与推送/配置轮询 |
| 入口 | `main.py` | CLI 入口，`--check` 自检模式 |
| 配置模板 | `config.ini.example` | 带中英文注释的完整配置模板 |
| 启动脚本 | `启动网关.bat` | 一键启动：自动检测 Python、安装依赖、生成配置 |

**后端（约 4 处小改）**

- `services/settings_store.py`：新增 `feed_symbols` 一组，照 `candle_history` 模式
- `routers/admin.py`：`GET/PUT /api/admin/feed-symbols`、`GET /api/admin/broker-symbols`
- 接收网关上报品种清单的端点
- 对应 Pydantic 模型

**前端（1 个页面）**

- 「行情品种」设置页，与现有 K 线保留策略、券商锁等设置页并列
- 功能：品种列表（display / broker / 启用开关 / 实时点差）、从券商品种树添加、
  手工改映射、启用停用、网关状态（最后上报时间、当前推送品种数）

**不改动**

- `/api/feed/quotes`、`/api/feed/candles`、`/api/webhook/trend` 三个摄取端点
- 前端所有行情展示逻辑
- Bridge 全部逻辑
- 数据库 schema

## 部署

两处，缺一不可。

**① 后端 VPS（Linux）— `git pull`**

拿到配置组、admin 端点、前端设置页。注意：拉取代码本身不产生行情，后端只是配置中心与
接收端。

**② Windows VPS — 单独部署网关**

```
pip install MT5Manager
```

`config.ini` 配置：

```ini
[manager]
server = 192.109.17.69:443
login = 1034
password = <密码>

[backend]
url = https://api.prismxsignallab.com
ea_token = <与后端 EA_TOKEN 一致>

[feed]
symbols = XAUUSD=XAUUSD.s, XAGUSD=XAGUSD.s, WTI=WTI.s, EURUSD=EURUSD.s, GBPUSD=GBPUSD.s, USDJPY=USDJPY.s, BTCUSD=BTCUSD.s
broker_gmt_offset = 2
```

`broker_gmt_offset` 仅作兜底——网关启动后自动通过 `TimeCurrent()` 侦测实际偏移并覆盖此值。

启动方式：

```powershell
cd Desktop\manager_feed
python -m manager_feed.main
```

或直接双击 `启动网关.bat`。切换时停止 EA，网关接管三条链路。

## 风险

**风险 1：聚合是全新代码，直接切换无对照**

EA 的高周期由 MT5 终端保证正确性，网关需自行聚合。这是唯一新增的实质风险。

缓解：时区对齐修复后 H4/D1 与 MT5 终端 OHLC 一致；网关自检模式可输出聚合结果用于比对。
后端三道闸门 + 网格校验作为运行时防护。

**风险 2：单点故障**

网关故障将导致全平台行情中断。缓解：内置自动重连 + 退避（5s→60s）；后端既有离线检测会将
品种标记为不活跃，前端不显示僵死价格。

**风险 3：Manager 凭据已泄露**

密码曾在对话与截图中以明文出现。即使仅有只读权限，Manager 账户仍可见全组客户数据。

处置：向券商申请重置密码，新密码仅存于 Windows VPS 配置文件，不进代码库。

**风险 4：夏令时切换**

如果自动侦测逻辑异常（`TimeCurrent()` 返回格式变化），网关需要手动重启或回退到配置文件值。
这是低概率事件——`TimeCurrent()` 是 Manager API 的基础方法，鲜有变更。

## 切换步骤

1. Windows VPS 部署网关，确认三条链路正常上报
2. 网关启动日志确认时区自动侦测成功（`自动侦测券商时区偏移: +2 小时`）
3. 比对网关聚合的 H4/D1 OHLC 与 MT5 终端原生 K 线，确认一致
4. 停止 EA

## 后续阶段（不在本设计范围）

网页直接登录券商 MT5 账户并下单，需要：

- 向券商申请 dealer 权限（当前 Manager 账户不具备）
- 明确合规边界：Manager API 的下单以经销商身份记录，而非客户自主操作，平台责任性质
  从「信号提供方」变为「代客操作方」
- 或改为申请 MT5 Web API 授权（MetaQuotes 单独许可，才是客户自主登录下单的正统方案）
