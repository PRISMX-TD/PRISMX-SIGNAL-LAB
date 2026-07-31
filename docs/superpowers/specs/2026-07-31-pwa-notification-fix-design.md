# PWA 通知修复与跨平台验证闭环 · 设计文档

日期：2026-07-31
目标：确保 PWA 推送通知在 Android 与 iOS 上都能正常启动并送达。

## 背景

PRISMX Signal Lab 的推送链路目前在所有平台上完全失效。根因是 `frontend/public/sw.js`
中残留了两处 TypeScript 类型断言（第 74 行 `(self.registration as any)`、第 144 行
`sub.toJSON() as {...}`）。该文件位于 `public/` 目录，Vite 原样拷贝、不经任何编译，
浏览器直接作为 JavaScript 解析，`as` 不是合法 JS 语法。

实测确认：

```
$ node --check public/sw.js
SyntaxError: Unexpected identifier 'as'
```

语法错误发生在解析阶段而非运行阶段，因此整个 Service Worker 无法安装，其提供的全部
能力同时失效：Web Push、离线壳、推送心跳、`pushsubscriptionchange` 自动重订阅。

故障之所以长期未被发现，是因为两处注册点都静默吞掉了异常：
`src/main.tsx:38` 与 `src/utils/push.ts:22` 均为 `.catch(() => {})`。UI 上通知开关
仍可正常翻动，后端仍会正常派发推送，只是没有任何设备能收到。

后端链路（FastAPI + pywebpush + VAPID + `push_subscriptions` 表 + 410 清理 + 白名单
扇出 + 事件类通知）实现完整，本次不改动其架构。

## 方案选择

考虑过三种做法：

**A. 就地修复 + 诊断层（采用）** — 保留手写 SW 架构，删除 TS 断言，将静默失败改为
可观测，补齐 iOS 运行态细分，新增诊断面板与测试推送接口，用 `node --check` 建立
构建门禁防回归。

**B. 将 SW 移入构建流程** — 改为 `src/sw.ts` 交由 TypeScript 编译。能根治此类错误，
但为两行断言引入多入口构建配置或 `vite-plugin-pwa`（后者还会接管 manifest 生成），
且需保证产物稳定输出为 `/sw.js`（scope 依赖该路径）。代价与收益不匹配。

**C. 换用托管推送服务（FCM / OneSignal）** — 不解决核心问题：iOS 的 standalone 限制
在 WebKit 层面，换服务商绕不过；且后端已踩平 aud 复用等坑（见 `push_dispatch.py`
第 128-143 行注释），推倒重来会丢失这些经验，并引入第三方 SDK 依赖。

选择 A：问题不在架构，而在一个未被任何检查覆盖的语法错误加上过度的静默容错。

## 改动范围

五块改动，彼此独立。第 1、2 块必须先完成，第 3、4、5 块可并行。

1. 修复 `sw.js` 语法错误（阻断项）
2. 构建门禁
3. 失败可观测
4. iOS 运行态细分与引导
5. 验证闭环

现有链路保持不变：

```
用户翻开关 → enableNotifications() → requestPermission() → subscribePush()
  → POST /notifications/push/subscribe → push_subscriptions 表

信号生成 → dispatch_push_async() → 白名单扇出 → pywebpush(VAPID)
  → 推送服务(FCM/Apple/Mozilla) → sw.js 的 push 事件 → showNotification()
```

## 1. 修复 sw.js 语法错误

`frontend/public/sw.js`：

- 第 144 行改为 `const raw = sub.toJSON()`。后续仅读取 `raw.endpoint` 与 `raw.keys`，
  纯 JS 环境不需要类型标注。
- 第 74 行那处断言随下一条一并消失：该行整体属于 `periodicSync` 注册段，删段即删除
  断言，无需单独改写。
- 删除 `activate` 事件中的 `periodicSync` 注册段（第 70-77 行）。理由：Periodic
  Background Sync 仅对已安装且 site engagement 足够高的 PWA 触发，与保活 Service
  Worker 无关（push 事件本身会唤醒 SW），iOS 完全不支持该 API。它不产生实际收益，
  却是本次阻断性故障两处根因之一。现有注释中"helps Chrome on Android keep the SW
  alive"的说法与规范不符，随代码一并删除。

## 2. 构建门禁

`frontend/package.json` 新增并修改 scripts：

```json
"check:sw": "node --check public/sw.js",
"build": "npm run check:sw && tsc -b && vite build"
```

门禁置于构建链最前端，语法错误立即失败。

选用 `node --check` 而非引入 ESLint：零依赖、零配置，精确对应"该文件必须是合法浏览器
JS"这一个约束。引入 ESLint 是独立的工程决策，不纳入本次修复。

已知局限：`node --check` 只做语法检查，不校验 API 用法。`self.clients` 等 SW 全局在
Node 下不存在，但语法检查不执行代码，不会产生误报。

Vercel 构建执行 `npm run build`，门禁自动生效。

## 3. 失败可观测

当前有五处 `.catch(() => {})` 吞掉关键失败：

- `src/main.tsx:38` — SW 注册
- `src/utils/push.ts:22` — SW 注册与 ready
- `src/components/Layout.tsx:383` — 订阅自愈
- `src/components/Layout.tsx:396` — 订阅续期上报
- `src/components/NotifDeviceBanner.tsx:27` — 偏好读取

在 `src/utils/push.ts` 中新增模块级诊断记录器，不新增文件、不引入 React state：

```ts
export type PushDiagStep = "sw-register" | "sw-ready" | "subscribe" | "report" | "vapid-key"

const _diag = new Map<PushDiagStep, { ok: boolean; error?: string; at: number }>()

export function recordDiag(step: PushDiagStep, err?: unknown): void
export function getPushDiag(): ReadonlyMap<PushDiagStep, { ok: boolean; error?: string; at: number }>
```

`recordDiag` 在 `import.meta.env.DEV` 下额外输出 `console.error`，生产环境仅落记录。

上述五处 catch 改为调用 `recordDiag`。catch 仍然吞掉异常，不改变控制流、不影响应用
启动，但失败原因不再消失。

选择模块级 Map 而非 React state 或 Context：诊断状态的生产者分散在 SW 注册、Layout
effect 与 utils 函数中，其中 `main.tsx` 的注册发生在 React 挂载之前。模块级 Map 是
唯一能被这些位置共同写入的载体。诊断面板打开时读取一次快照即可，无需响应式更新。

`Layout.tsx` 第 406-409 行已有的前台回归权限比对，其结果一并记入诊断，使
"iOS 系统更新后权限被撤销"这类难以复现的情况在面板上直接可见。

## 4. iOS 运行态细分与引导

`pushSupported()` 目前返回布尔值，UI 只能二选一显示"能用"或"不支持"，而"不支持"
底下有三种处境完全不同的用户，需要三种话术。

### 状态划分

在 `src/utils/push.ts` 新增：

```ts
export type PushEnv =
  | "ready"              // API 齐备，权限可申请
  | "granted"            // API 齐备且已授权
  | "denied"             // API 齐备但权限被拒
  | "ios-needs-install"  // iOS 16.4+ 处于 Safari 标签页
  | "ios-too-old"        // iOS < 16.4
  | "unsupported"        // 其它平台确实不支持
```

判定依赖两个探测：

- **standalone 检测**：`navigator.standalone === true ||
  matchMedia('(display-mode: standalone)').matches`。前者为 iOS 专有属性，后者为标准
  写法，取或覆盖全平台。当前代码库完全没有此项检测。
- **iOS 版本**：从 UA 解析 `OS (\d+)_(\d+)`。iPad 自 iOS 13 起 UA 伪装为 macOS，需以
  `navigator.maxTouchPoints > 1 && /Macintosh/` 补判。

UA 解析不可靠，因此它**仅用于区分话术，不用于决定功能开关**。功能开关始终以
`"PushManager" in window` 这一真实能力探测为准。UA 判断出错最多导致文案不精确，
不会误锁功能。

### 硬约束：探测函数必须同步

`PushEnv` 探测函数必须是纯同步函数，不得引入任何异步调用。

原因见 `src/utils/notifications.ts` 第 65-81 行注释：iOS Safari 要求
`requestPermission()` 在用户手势后同步调用，中间插入任何 `await` 都会使权限框不弹出，
权限永远停留在 default，用户点击开关后毫无反应。Android/Chrome 对此宽容得多，桌面
测试难以发现。

这是本次改动最容易踩的回归点。

### 文案调整

`src/i18n/zh.json` 与 `src/i18n/en.json` 同步修改：

- `ios-needs-install` — 沿用现有 `notifUnsupported` 的引导内容（Safari 分享菜单 →
  添加到主屏幕 → 从主屏幕图标打开），但删去"需 iOS 16.4 及以上"一句。既已判定为
  16.4+，保留只添噪音。
- `ios-too-old` — 新增。告知当前系统版本不支持 Web 推送，需升级至 iOS 16.4 及以上。
  避免用户按引导添加主屏幕后仍然不可用，陷入死循环。
- `denied` — 新增。给出 iOS「设置 → 通知 → Signal Lab」与 Android「站点设置 → 通知」
  的具体路径。现有 `notifDeviceHint`（zh.json:434）建议"关掉再打开一次"，对 permission
  已为 denied 的情况无效：`requestPermission()` 在 denied 状态下不会再次弹框。
- `unsupported` — 保留为兜底。

### 提示条显示条件修正

`src/components/NotifDeviceBanner.tsx:35` 现为 `enabled && !deviceOk`，而 iOS Safari
标签页用户根本无法开启 `enabled`，导致最需要引导的人永远看不到提示。

改为：`ios-needs-install` 状态下不检查 `enabled` 也显示（这类用户的问题正是"想开却
开不了"）；其余状态维持 `enabled && !deviceOk`，避免对从未打算使用通知的用户造成
无谓打扰。

`src/components/NotificationBell.tsx:155` 存在同样的 `pushSupported() ? A : B` 二选一
逻辑，一并改为按 `PushEnv` 取文案。两处共用同一个映射表，避免再次跑偏。

## 5. 验证闭环

不依赖真机测试，正确性保障落在代码层与应用内诊断。

### 5a. 后端测试推送接口

```
POST /notifications/push/test  →  {"sent": 1, "failed": 0, "pruned": 0}
```

向当前登录用户的所有订阅发送一条固定内容的通知。

- 复用现有 `_webpush_one`，不重复实现推送逻辑，因此自动继承 `vapid_claims=dict(...)`
  的 aud 修复
- 绕过通知偏好与白名单过滤（`enabled`、类别、品种一概不检查）。这是链路探针，不是
  业务通知
- 保留订阅等级检查 `can_use_push`，避免 FREE 用户借此绕过付费边界
- 通过 `run_in_threadpool` 执行，与现有派发一致，不阻塞事件循环
- 添加 `@limiter.limit("5/minute")`（项目已使用 slowapi，跟随 `auth.py`、`orders.py`
  的现有模式）。该接口能触发真实推送，不限流会成为骚扰工具
- 返回 `sent` / `failed` / `pruned` 三个计数，使前端能区分"没有任何订阅"与"有订阅
  但推送失败"，二者排查方向完全不同

配套新增：

```
GET /notifications/push/status?endpoint=<当前设备的 endpoint>
  →  {"count": 2, "current_endpoint_registered": true}
```

`count` 为本账号在库中的订阅总数；`current_endpoint_registered` 表示查询参数传入的
endpoint 是否存在于库中。`endpoint` 参数可选，未传时该字段返回 `false`。

供诊断面板判断本设备的订阅是否已上报后端——这与"本设备浏览器里存在订阅"是两件事，
后者由前端 `getSubscription()` 独立检查，两项都为真才说明上报链路通畅。

### 5b. 前端诊断面板

置于账户页通知区（`/account#notifications`）内，折叠式，默认收起，不干扰正常设置界面。

逐项显示：

| 检查项 | 数据来源 |
| --- | --- |
| 运行环境 | `PushEnv` 状态值 |
| 是否 standalone 启动 | standalone 探测 |
| Service Worker 已注册并激活 | `navigator.serviceWorker.getRegistration()` + `reg.active` |
| 通知权限 | `Notification.permission` |
| 本设备存在推送订阅 | `reg.pushManager.getSubscription()` |
| 订阅是否已上报后端 | `GET /notifications/push/status` |
| 各环节最近失败原因 | `getPushDiag()` |
| 最后一次收到推送 | 向 SW 发送 `PING_PUSH_HEARTBEAT`（已有机制） |

底部为「发送测试通知」按钮，调用 5a。

该面板是本方案的核心交付。在任何一台 Android 或 iPhone 上打开即可定位断点，无需接入
调试器。"SW 已注册但订阅缺失"、"订阅存在但后端无记录"、"后端有订阅但测试推送失败"
三种故障指向的原因各不相同，面板将它们区分开。

### 5c. 后端单元测试

新增 `backend/tests/test_push_dispatch.py`，mock `pywebpush.webpush`（不发真实请求）。
沿用 `backend/tests/conftest.py` 的现有 fixture 模式。

覆盖：

1. **aud 复用回归测试** — 两个不同推送服务域名的订阅，断言传入 `webpush` 的
   `vapid_claims` 是两个不同字典对象。该 bug 已在生产发生过，必须有测试钉住
2. 白名单"与"关系 — 类别命中但品种不命中时不推送
3. `ALL_SENTINEL` 哨兵放行任意取值
4. FREE 降级用户被过滤（`enabled=True` 残留时不应绕过延迟机制）
5. 410/404 触发订阅清理，403/500 不清理
6. 事件类通知按 `event_types` 白名单过滤
7. 测试推送接口在无订阅时返回 `sent=0` 而非报错

### 前端不引入测试框架

项目当前无测试框架、无 test 脚本。为本次修复引入 vitest + jsdom 属独立工程决策，且
jsdom 中 `ServiceWorkerRegistration`、`PushManager` 均不存在，测试价值有限。

前端侧的保障为 `node --check` 门禁加诊断面板。

## 错误处理与边界

**测试推送接口的失败语义** — 不因单个订阅失败返回 5xx。逐个订阅尝试，汇总计数返回
200。一个用户可能同时有桌面 Chrome 与 iPhone 两个订阅，其中一个失效不应使整个诊断
动作看起来像"接口挂了"。前端根据 `failed > 0` 展示具体提示。

**诊断面板的自身失败** — 每项检查独立 try/catch，某项探测抛错则显示"无法检测"，
不使整个面板白屏。面板作为排障工具，必须比被排障的对象更健壮。

**VAPID 未配置** — 现有 `vapid_public_key`（`notifications.py:209-214`）在未配置时抛
500，而 `dispatch_push` 只是静默 return。测试接口统一返回明确的"服务端未配置推送
密钥"，使面板能区分"本设备有问题"与"服务器未开启推送"。二者的用户侧行动完全不同。

**`node --check` 的环境依赖** — 构建环境需有 Node，Vite 项目必然满足，无额外要求。

## 明确不做的事

以下问题真实存在，但与"确保 Android 和 iOS 通知能正常启动"无直接关系，不纳入本次：

- 通知不入库，不做通知中心 / 历史列表 / 未读计数
- 不清理僵尸订阅（不新增 `last_seen` 字段与定期清扫）
- 不优化白名单的全表扫描
- 不补 manifest 的 `id` / `orientation` / `screenshots` / `shortcuts` 与中间尺寸图标
- 不加 Service Worker 版本更新提示 UI
- 不引入 ESLint 与 CI

## 成功标准

1. `node --check public/sw.js` 通过，且该检查已接入 `npm run build`
2. `npm run build` 成功
3. Service Worker 能正常安装激活，push、pushsubscriptionchange、离线壳、心跳四项
   能力恢复
4. 五处静默 catch 全部改为记录诊断，失败原因可从 `getPushDiag()` 读出
5. iOS 三种处境（16.4+ 标签页 / 低于 16.4 / 权限被拒）各自获得可行动的引导文案，
   不存在引导死循环
6. `PushEnv` 探测函数为纯同步，iOS 权限框弹出路径无回归
7. 诊断面板可在真机上逐项显示链路状态，「发送测试通知」按钮可端到端验证送达
8. `backend/tests/test_push_dispatch.py` 全部通过，含 aud 复用回归测试
