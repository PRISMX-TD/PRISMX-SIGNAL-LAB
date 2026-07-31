# PWA 通知修复与跨平台验证闭环 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复导致 Service Worker 无法安装的语法错误，恢复 PWA 推送在 Android 与 iOS 上的可用性，并建立防回归门禁与应用内诊断验证手段。

**Architecture:** 保留现有手写 Service Worker 与 FastAPI + pywebpush 后端架构，不引入新框架。删除 `public/sw.js` 中的 TypeScript 类型断言使其成为合法 JS；将五处静默 `catch` 改为记录到模块级诊断 Map；把布尔型 `pushSupported()` 扩展为六态 `PushEnv` 以区分 iOS 各种处境；新增测试推送接口与应用内诊断面板作为真机排障手段。

**Tech Stack:** 前端 Vite 5 + React 18 + TypeScript 5 + i18next；后端 FastAPI + SQLAlchemy 2 + pywebpush + slowapi；测试 pytest + httpx。

## Global Constraints

- 设计文档：`docs/superpowers/specs/2026-07-31-pwa-notification-fix-design.md`
- `frontend/public/sw.js` 不经任何编译，必须是合法的浏览器 JavaScript，禁止出现 TypeScript 语法
- `PushEnv` 探测函数必须是纯同步函数，禁止包含 `await` 或返回 Promise。原因：iOS Safari 要求 `Notification.requestPermission()` 在用户手势后同步调用，中间插入任何异步间隙都会导致权限框不弹出
- 通知开关路径（`enableNotifications`）中，`requestPermission()` 之前禁止新增任何 `await`
- 代码注释遵循现有风格：中英双语并列
- 前端不引入测试框架
- 后端测试 mock `pywebpush.webpush`，禁止发出真实网络请求
- 文案改动必须同步 `frontend/src/i18n/zh.json` 与 `frontend/src/i18n/en.json`
- `.gitignore` 忽略 `*.md`，提交文档需用 `git add -f`
- 当前分支为 `main`，禁止直接推送到远端

---

## 文件结构

**新建：**

| 文件 | 职责 |
|---|---|
| `frontend/src/utils/pushDiag.ts` | 推送链路诊断状态的记录与读取（模块级 Map） |
| `frontend/src/utils/pushEnv.ts` | 运行环境探测：standalone 判定、iOS 版本判定、`PushEnv` 六态计算。纯同步 |
| `frontend/src/components/PushDiagnostics.tsx` | 应用内诊断面板组件，含"发送测试通知"按钮 |
| `backend/tests/test_push_dispatch.py` | 推送派发与测试接口的 pytest 覆盖 |

**修改：**

| 文件 | 改动 |
|---|---|
| `frontend/public/sw.js` | 删除两处 TS 断言（含整段 `periodicSync`） |
| `frontend/package.json` | 新增 `check:sw` script，接入 `build` |
| `frontend/src/main.tsx` | SW 注册失败改为记录诊断 |
| `frontend/src/utils/push.ts` | 三处 catch 改为记录诊断；移除旧 `pushSupported` 实现，改为从 `pushEnv.ts` 重导出 |
| `frontend/src/components/Layout.tsx` | 两处 catch 与权限撤销检测改为记录诊断 |
| `frontend/src/components/NotifDeviceBanner.tsx` | 显示条件按 `PushEnv` 细分；catch 改为记录诊断 |
| `frontend/src/components/NotificationBell.tsx` | 文案按 `PushEnv` 取值 |
| `frontend/src/pages/AccountPage.tsx` | 通知区块内挂载诊断面板 |
| `frontend/src/api/client.ts` | `pushApi` 新增 `getStatus`、`sendTest` |
| `frontend/src/i18n/zh.json` / `en.json` | 新增 `PushEnv` 文案与诊断面板文案 |
| `backend/app/routers/notifications.py` | 新增 `POST /push/test`、`GET /push/status` |

**为什么把 `PushEnv` 与诊断记录拆成两个新文件而不是塞进 `push.ts`：** `push.ts` 当前
职责是"订阅生命周期管理"（注册、订阅、退订、自愈）。环境探测与诊断记录是两个独立
关注点，且都会被组件层直接引用。拆开后 `pushEnv.ts` 可以保持"纯同步、无副作用、
无网络"这一硬约束的边界清晰——这是本次最容易踩的回归点，独立文件让它更难被违反。

---

## Task 1: 修复 sw.js 语法错误并建立构建门禁

**Files:**
- Modify: `frontend/public/sw.js`（删除第 70-77 行 `periodicSync` 段；修改第 144 行）
- Modify: `frontend/package.json:6-10`

**Interfaces:**
- Consumes: 无
- Produces: 合法可解析的 `sw.js`；`npm run check:sw` 命令

本任务是唯一的阻断项，必须先完成。它没有单元测试，验证手段是 `node --check` 本身。

- [ ] **Step 1: 先确认当前确实失败（建立基线）**

Run: `cd frontend; node --check public/sw.js`

Expected: FAIL，输出 `SyntaxError: Unexpected identifier 'as'`，指向第 74 行。

- [ ] **Step 2: 删除 periodicSync 注册段**

在 `frontend/public/sw.js` 的 `activate` 事件监听器中，删除第 70-77 行——即
`.then(() => {` 起、含 `periodicSync` 注册与 `try/catch`、到对应 `})` 结束的整段。

改动后 `activate` 监听器应为：

```js
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  )
})
```

删除理由（不必写入代码注释，仅供实施者理解）：Periodic Background Sync 仅对已安装且
site engagement 足够高的 PWA 触发，与保活 Service Worker 无关——`push` 事件本身会
唤醒 SW。iOS 完全不支持该 API。它不产生实际收益，却是本次故障两处根因之一。

- [ ] **Step 3: 修改第 144 行，移除类型断言**

在 `pushsubscriptionchange` 监听器中，把：

```js
      const raw = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
```

改为：

```js
      const raw = sub.toJSON()
```

后续代码仅读取 `raw.endpoint` 与 `raw.keys`，纯 JS 环境不需要类型标注。

- [ ] **Step 4: 验证语法检查通过**

Run: `cd frontend; node --check public/sw.js`

Expected: PASS，无任何输出，退出码 0。

- [ ] **Step 5: 在 package.json 中加入构建门禁**

把 `frontend/package.json` 的 scripts 段改为：

```json
  "scripts": {
    "dev": "vite",
    "check:sw": "node --check public/sw.js",
    "build": "npm run check:sw && tsc -b && vite build",
    "preview": "vite preview"
  },
```

门禁置于构建链最前端，语法错误立即失败、不浪费后续构建时间。

- [ ] **Step 6: 验证门禁真的会拦截（故意引入错误）**

临时在 `frontend/public/sw.js` 末尾追加一行 `const x = 1 as number`，然后：

Run: `cd frontend; npm run build`

Expected: FAIL，在 `check:sw` 阶段即失败，不进入 `tsc -b`。

随后**必须删除**这行临时代码，并重新运行 `node --check public/sw.js` 确认恢复 PASS。

- [ ] **Step 7: 完整构建验证**

Run: `cd frontend; npm run build`

Expected: PASS，构建产物生成成功。

- [ ] **Step 8: Commit**

```bash
git add frontend/public/sw.js frontend/package.json
git commit -m "fix(pwa): 移除 sw.js 中的 TS 类型断言并加入语法检查门禁

public/ 下的 sw.js 不经编译、由浏览器直接解析，残留的 as 断言
导致 Service Worker 解析失败、从未安装成功，推送/离线壳/心跳
全部失效。同时删除无实际收益的 periodicSync 段，并把
node --check 接入 build 防止同类回归。"
```

---

## Task 2: 诊断状态记录器

**Files:**
- Create: `frontend/src/utils/pushDiag.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type PushDiagStep = "sw-register" | "sw-ready" | "subscribe" | "report" | "vapid-key" | "prefs" | "permission"`
  - `type PushDiagEntry = { ok: boolean; error?: string; at: number }`
  - `function recordDiag(step: PushDiagStep, err?: unknown): void` — `err` 为 undefined 时记为成功
  - `function getPushDiag(): Map<PushDiagStep, PushDiagEntry>` — 返回快照副本

- [ ] **Step 1: 创建文件**

创建 `frontend/src/utils/pushDiag.ts`：

```ts
// 推送链路诊断记录。此前 SW 注册、订阅、上报三环的失败全被 `.catch(() => {})`
// 静默吞掉——sw.js 里的一个语法错误导致 Service Worker 从未安装成功，而前端
// 没有任何迹象，UI 上开关照常翻动、后端照常派发，只是没有设备能收到。
// 这里把每一环最后一次的结果留下来，供诊断面板读取；catch 仍然吞掉异常，
// 不改变控制流，但失败原因不再消失。
//
// Push-pipeline diagnostics. Failures across SW registration, subscription and
// reporting were all swallowed by `.catch(() => {})` — a syntax error in sw.js
// meant the service worker never installed, with no sign of it in the
// frontend: the toggle flipped fine, the backend dispatched fine, no device
// ever received anything. This keeps the last outcome of each step for the
// diagnostics panel to read. The catches still swallow, so control flow is
// unchanged, but the reason no longer vanishes.

export type PushDiagStep =
  | "sw-register"  // Service Worker 注册 / SW registration
  | "sw-ready"     // Service Worker 就绪 / SW ready
  | "subscribe"    // 创建推送订阅 / creating the push subscription
  | "report"       // 上报订阅到后端 / reporting the subscription
  | "vapid-key"    // 取 VAPID 公钥 / fetching the VAPID public key
  | "prefs"        // 读取通知偏好 / loading notification prefs
  | "permission"   // 权限状态变化（含被系统撤销）/ permission changes, incl. OS revocation

export type PushDiagEntry = { ok: boolean; error?: string; at: number }

// 模块级而非 React state：生产者散布在 SW 注册、Layout effect 与 utils 函数中，
// 其中 main.tsx 的注册发生在 React 挂载之前，没有任何 React 容器能覆盖全部写入点。
// 诊断面板打开时读一次快照即可，不需要响应式更新。
// Module-level rather than React state: writers are spread across SW
// registration, a Layout effect and utils functions — and main.tsx registers
// before React mounts, so no React container can cover every write site. The
// panel reads one snapshot when opened; no reactivity needed.
const _diag = new Map<PushDiagStep, PushDiagEntry>()

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/** 记录某一环的结果。不传 err 记为成功。/ Record a step's outcome; omitting err means success. */
export function recordDiag(step: PushDiagStep, err?: unknown): void {
  const entry: PushDiagEntry =
    err === undefined
      ? { ok: true, at: Date.now() }
      : { ok: false, error: describe(err), at: Date.now() }
  _diag.set(step, entry)
  // 开发环境立即暴露，避免又一次"静默失败躺很久"。
  // Surface immediately in dev so a silent failure can't sit unnoticed again.
  if (!entry.ok && import.meta.env.DEV) {
    console.error(`[push:${step}]`, entry.error)
  }
}

/** 读取快照副本，避免调用方改动内部状态。/ Snapshot copy so callers can't mutate internals. */
export function getPushDiag(): Map<PushDiagStep, PushDiagEntry> {
  return new Map(_diag)
}
```

- [ ] **Step 2: 验证类型检查通过**

Run: `cd frontend; npx tsc -b`

Expected: PASS，无错误输出。

注意：`tsconfig.json` 启用了 `noUnusedLocals`，此时该文件尚无消费者但导出的符号不算
未使用局部变量，因此不会报错。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/utils/pushDiag.ts
git commit -m "feat(push): 新增推送链路诊断记录器

为把五处静默 catch 改成可观测做准备：模块级记录每一环最后
一次的结果，开发环境额外打到 console。"
```

---

## Task 3: 运行环境探测（PushEnv）

**Files:**
- Create: `frontend/src/utils/pushEnv.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type PushEnv = "granted" | "ready" | "denied" | "ios-needs-install" | "ios-too-old" | "unsupported"`
  - `function isStandalone(): boolean`
  - `function isIOS(): boolean`
  - `function iosVersion(): { major: number; minor: number } | null`
  - `function pushSupported(): boolean` — 保持与现有同名函数完全一致的语义与签名
  - `function detectPushEnv(): PushEnv`
  - `const PUSH_ENV_HINT_KEYS: Record<PushEnv, string | null>` — `PushEnv` → i18n key，`granted` 与 `ready` 为 `null`（无需提示）

**关键约束：本文件所有导出函数必须是纯同步的。** 禁止 `async`、`await`、返回 Promise
或发起网络请求。原因见 Global Constraints。

- [ ] **Step 1: 创建文件**

创建 `frontend/src/utils/pushEnv.ts`：

```ts
// 推送运行环境探测。此前只有一个布尔值 pushSupported()，UI 只能二选一显示
// "能用"或"不支持"——而"不支持"底下藏着三种处境完全不同的用户：iOS 16.4+ 在
// Safari 标签页里（装到主屏幕就能用）、iOS 低于 16.4（升级系统才行）、权限已被
// 拒绝（要去系统设置里改）。三者给同一句"请添加到主屏幕"，第二种加完还是不能用，
// 陷入死循环；第三种则完全没被提到。
//
// 硬约束：本文件所有函数必须纯同步。iOS Safari 只在"用户手势后同步调用
// requestPermission()"时才弹权限框，通知开关路径上多一个 await 就会让权限框
// 永远不出现（见 utils/notifications.ts 的注释）。
//
// Push environment detection. There used to be just a boolean pushSupported(),
// so the UI could only say "works" or "unsupported" — while "unsupported"
// covers three very different situations: iOS 16.4+ in a Safari tab (installing
// to the Home Screen fixes it), iOS below 16.4 (needs an OS upgrade), and
// permission already denied (needs a change in system settings). All three got
// the same "add to Home Screen" hint: the second stays broken after following
// it, and the third was never addressed.
//
// Hard constraint: every function here must be purely synchronous. iOS Safari
// only shows the permission sheet when requestPermission() is called
// synchronously off a user gesture; one extra await on the toggle path makes it
// never appear (see the notes in utils/notifications.ts).

export type PushEnv =
  | "granted"            // API 齐备且已授权 / capable and already granted
  | "ready"              // API 齐备，权限可申请 / capable, permission requestable
  | "denied"             // API 齐备但权限被拒 / capable but permission denied
  | "ios-needs-install"  // iOS 16.4+ 处于 Safari 标签页 / iOS 16.4+ in a Safari tab
  | "ios-too-old"        // iOS 低于 16.4 / iOS below 16.4
  | "unsupported"        // 其它平台确实不支持 / genuinely unsupported elsewhere

/** iOS Web Push 的最低系统版本 / minimum iOS version with Web Push */
const IOS_PUSH_MIN_MAJOR = 16
const IOS_PUSH_MIN_MINOR = 4

/**
 * 是否以独立模式（主屏幕图标）启动。navigator.standalone 是 iOS 专有属性，
 * display-mode 媒体查询是标准写法，两者取或覆盖全平台。
 * Whether launched standalone (from a Home Screen icon). navigator.standalone is
 * iOS-only, the display-mode query is the standard one; OR-ing covers both.
 */
export function isStandalone(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true
  let displayMode = false
  try {
    displayMode = window.matchMedia("(display-mode: standalone)").matches
  } catch {
    // 极老浏览器没有 matchMedia，忽略 / very old browsers lack matchMedia
  }
  return iosStandalone || displayMode
}

/**
 * 是否 iOS/iPadOS。iPad 自 iOS 13 起 UA 伪装成 macOS，靠 maxTouchPoints 补判
 * （桌面 Mac 没有多点触摸）。
 * Whether iOS/iPadOS. iPad has masqueraded as macOS in its UA since iOS 13, so
 * maxTouchPoints disambiguates (desktop Macs report no multi-touch).
 */
export function isIOS(): boolean {
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/.test(ua)) return true
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
}

/**
 * 从 UA 解析 iOS 主次版本号，解析不出返回 null。
 * UA 解析本身不可靠，因此它只用于区分提示文案，绝不用于决定功能开关——
 * 功能判定一律以 "PushManager" in window 这个真实能力探测为准。判断错了
 * 最多是文案不够精确，不会误锁功能。
 * Parse the iOS major/minor from the UA, or null. UA parsing is unreliable, so
 * it only ever selects hint copy — never gates functionality, which always
 * relies on the real capability probe ("PushManager" in window). A wrong guess
 * costs copy precision, never a locked-out feature.
 */
export function iosVersion(): { major: number; minor: number } | null {
  const m = /OS (\d+)[._](\d+)/.exec(navigator.userAgent)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]) }
}

/**
 * 当前运行环境是否具备 Web Push 能力。iOS 上只有"从主屏幕以独立模式启动的
 * Web App"（iOS 16.4+）才有 PushManager——在 Safari 标签页里（包括没有
 * manifest 时加到主屏幕的书签式打开）这两个对象根本不存在。
 * Whether this environment supports Web Push at all. On iOS only a web app
 * launched standalone from the Home Screen (iOS 16.4+) gets PushManager — in a
 * Safari tab (including bookmark-style home-screen launches when there's no
 * manifest) these objects simply don't exist.
 */
export function pushSupported(): boolean {
  return (
    typeof Notification !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  )
}

/**
 * 计算当前环境的推送状态。纯同步，可在渲染期与用户手势路径上安全调用。
 * Compute the current push environment. Purely synchronous — safe to call
 * during render and on a user-gesture path.
 */
export function detectPushEnv(): PushEnv {
  if (pushSupported()) {
    if (Notification.permission === "granted") return "granted"
    if (Notification.permission === "denied") return "denied"
    return "ready"
  }

  // 能力探测失败。iOS 需要进一步区分"装到主屏幕就能用"与"系统版本不够"，
  // 否则会把后者也引导去添加主屏幕，加完仍不可用。
  // Capability probe failed. On iOS, distinguish "installing fixes it" from
  // "the OS is too old" — otherwise the latter is sent to add a Home Screen
  // icon that still won't work.
  if (isIOS()) {
    const v = iosVersion()
    // 解析不出版本时按"装上就能用"处理：给出可行动的引导，用户照做后若仍不行，
    // 状态会自然落到 ios-too-old 之外的分支。反之若默认判为版本过低，会劝退
    // 一批其实只要装一下就能用的用户。
    // When the version can't be parsed, assume installing helps: that hint is
    // actionable, and if it doesn't work the state resolves elsewhere anyway.
    // Defaulting to "too old" would instead turn away users who only needed
    // to install.
    if (v && (v.major < IOS_PUSH_MIN_MAJOR || (v.major === IOS_PUSH_MIN_MAJOR && v.minor < IOS_PUSH_MIN_MINOR))) {
      return "ios-too-old"
    }
    if (!isStandalone()) return "ios-needs-install"
  }
  return "unsupported"
}

/**
 * PushEnv → 提示文案 i18n key。granted/ready 无需提示，故为 null。
 * 单一映射表供铃铛弹层、提示条、账户页共用，避免三处各写一份判断而跑偏。
 * PushEnv → hint i18n key; null for granted/ready which need no hint. One
 * shared table for the bell popover, banner and account page so the three
 * can't drift apart.
 */
export const PUSH_ENV_HINT_KEYS: Record<PushEnv, string | null> = {
  granted: null,
  ready: null,
  denied: "account.notifPermissionBlocked",
  "ios-needs-install": "account.notifIosNeedsInstall",
  "ios-too-old": "account.notifIosTooOld",
  unsupported: "account.notifUnsupported",
}
```

- [ ] **Step 2: 验证纯同步约束**

人工核对：文件中不得出现 `async`、`await`、`Promise`、`fetch`。

Run: `cd frontend; npx tsc -b`

Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add frontend/src/utils/pushEnv.ts
git commit -m "feat(push): 新增运行环境六态探测 PushEnv

把布尔型 pushSupported 扩展为六态，区分 iOS 16.4+ 标签页、
iOS 版本过低、权限被拒三种处境——此前三者共用同一句
「请添加到主屏幕」，第二种加完仍不可用、陷入死循环。
全文件保持纯同步，避免破坏 iOS 权限框弹出条件。"
```

---

## Task 4: 把五处静默 catch 改为记录诊断

**Files:**
- Modify: `frontend/src/utils/push.ts:1-26`（引入 recordDiag、改 getSWReg、重导出 pushSupported）
- Modify: `frontend/src/utils/push.ts:46-59`（删除旧 pushSupported 实现）
- Modify: `frontend/src/utils/push.ts:74-92`（ensurePushSubscription 记录 subscribe/report）
- Modify: `frontend/src/main.tsx:36-40`
- Modify: `frontend/src/components/Layout.tsx:372-399`
- Modify: `frontend/src/components/NotifDeviceBanner.tsx:20-31`

**Interfaces:**
- Consumes: `recordDiag` from `./pushDiag`（Task 2）；`pushSupported` from `./pushEnv`（Task 3）
- Produces: 无新导出。`push.ts` 继续导出 `pushSupported`（改为从 `pushEnv.ts` 重导出），
  所有现有 import 点无需改动。`getSWReg`、`ensurePushSubscription`、`subscribePush`、
  `unsubscribePush` 签名全部不变，仅内部新增诊断记录

**注意：** `push.ts` 目前自己实现了 `pushSupported()`（第 53-59 行），Task 3 在
`pushEnv.ts` 里做了语义完全一致的实现。为避免两份实现并存漂移，删除 `push.ts` 中的
实现，改为重导出。这样 `Layout.tsx`、`NotificationBell.tsx`、`NotifDeviceBanner.tsx`、
`notifications.ts`、`AccountPage.tsx` 五个现有 import 点都不用动。

- [ ] **Step 1: 修改 push.ts 顶部导入与 getSWReg**

把 `frontend/src/utils/push.ts` 第 1-2 行：

```ts
// Web Push 订阅工具 / Web Push subscription helpers
const SW_URL = "/sw.js"
```

改为：

```ts
// Web Push 订阅工具 / Web Push subscription helpers
import { recordDiag } from "./pushDiag"
import { pushSupported } from "./pushEnv"

// pushSupported 的实现已移到 pushEnv.ts（连同新增的 PushEnv 细分状态），这里重导出，
// 让现有那五个 import 点不必改动，同时避免两份实现并存漂移。
// 其余环境探测函数（detectPushEnv / isStandalone / …）由组件直接从 pushEnv.ts 导入，
// 不在这里转发——多一层转发只会让"某个符号到底住在哪"变得更难回答。
//
// pushSupported's implementation moved to pushEnv.ts (along with the new PushEnv
// states); re-exported here so the five existing import sites stay untouched and
// no second copy can drift. The other detectors (detectPushEnv / isStandalone /
// …) are imported straight from pushEnv.ts by their consumers — an extra
// forwarding layer would only make "where does this symbol live" harder to answer.
export { pushSupported } from "./pushEnv"

const SW_URL = "/sw.js"
```

- [ ] **Step 2: 改 getSWReg 记录注册与就绪结果**

把第 15-26 行的 `getSWReg` 改为：

```ts
export async function getSWReg(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return null
  if (_reg) return _reg
  try {
    _reg = await navigator.serviceWorker.register(SW_URL, { scope: "/" })
    recordDiag("sw-register")
    // 等 SW 就绪 / wait until ready
    await navigator.serviceWorker.ready
    recordDiag("sw-ready")
  } catch (err) {
    // 仍然吞掉异常（注册不上不该影响应用启动），但原因记进诊断——此前这里的
    // 静默 catch 让 sw.js 的语法错误藏了很久。
    // Still swallowed (a failed registration must not break app boot), but the
    // reason is recorded — the silent catch here hid a syntax error in sw.js
    // for a long time.
    recordDiag("sw-register", err)
    _reg = null
  }
  return _reg
}
```

- [ ] **Step 3: 删除 push.ts 中旧的 pushSupported 实现**

删除第 46-59 行整段——即从注释 `// 当前运行环境是否具备 Web Push 能力...` 起，到
`pushSupported()` 函数结束的闭合大括号。该能力已由 Step 1 的重导出提供。

- [ ] **Step 4: 在 ensurePushSubscription 中记录 subscribe 与 report**

把第 74-92 行的 `ensurePushSubscription` 函数体改为：

```ts
export async function ensurePushSubscription(
  getVapidKey: () => Promise<string>,
  report: (endpoint: string, keys: { p256dh: string; auth: string }) => Promise<unknown>,
): Promise<boolean> {
  if (!pushSupported() || Notification.permission !== "granted") return false
  const reg = await getSWReg()
  if (!reg) return false
  let sub = await reg.pushManager.getSubscription()
  if (!sub) {
    let key: string
    try {
      key = await getVapidKey()
      recordDiag("vapid-key")
    } catch (err) {
      recordDiag("vapid-key", err)
      throw err
    }
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      })
      recordDiag("subscribe")
    } catch (err) {
      recordDiag("subscribe", err)
      throw err
    }
  } else {
    recordDiag("subscribe")
  }
  const raw = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } }
  try {
    await report(raw.endpoint!, raw.keys!)
    recordDiag("report")
  } catch (err) {
    recordDiag("report", err)
    throw err
  }
  return true
}
```

注意：这里保留 `as {...}` 断言是正确的——`push.ts` 是 TypeScript 源文件，经 Vite 编译，
与 `public/sw.js` 完全不同。抛出的异常由 `Layout.tsx` 的调用点 catch（Step 6），行为
不变。

- [ ] **Step 5: 改 main.tsx 的 SW 注册**

把 `frontend/src/main.tsx` 第 36-40 行：

```ts
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})
  })
}
```

改为：

```ts
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then(() => recordDiag('sw-register'))
      // 失败仍然不影响启动，但原因记进诊断供面板读取。
      // Still non-fatal to boot, but the reason is recorded for the panel.
      .catch((err) => recordDiag('sw-register', err))
  })
}
```

并在 `frontend/src/main.tsx` 的 import 区（第 5 行 `import App from './App'` 之后）加入：

```ts
import { recordDiag } from './utils/pushDiag'
```

- [ ] **Step 6: 改 Layout.tsx 的两处 catch**

把第 375-386 行的 `report` 函数改为：

```ts
    const report = async () => {
      try {
        const prefs = await notificationApi.getPrefs()
        recordDiag('prefs')
        if (cancelled || !prefs.enabled) return
        await ensurePushSubscription(
          async () => (await pushApi.getVapidKey()).publicKey,
          (endpoint, keys) => pushApi.subscribe(endpoint, keys),
        )
      } catch (err) {
        // 仍然静默：这里只是自愈，不该打扰正常使用。原因记进诊断。
        // Still silent — self-healing only, must not interrupt normal use.
        // The reason goes into diagnostics.
        recordDiag('prefs', err)
      }
    }
```

把第 394-398 行的 `onSwMsg` 改为：

```ts
    const onSwMsg = (ev: MessageEvent) => {
      if (ev.data?.type === "PUSH_SUB_RENEWED" && ev.data?.endpoint && ev.data?.keys) {
        void pushApi
          .subscribe(ev.data.endpoint, ev.data.keys)
          .then(() => recordDiag('report'))
          .catch((err) => recordDiag('report', err))
      }
    }
```

并在 `Layout.tsx` 第 9 行的 import 之后加入：

```ts
import { recordDiag } from '../utils/pushDiag'
```

- [ ] **Step 7: 在 Layout.tsx 的权限撤销检测处记录诊断**

把第 406-420 行的权限比对逻辑：

```ts
    let lastPerm: NotificationPermission = Notification.permission
    const onVisible = () => {
      if (!document.hidden) {
        // 权限在后台被系统撤销（iOS 更新后偶发）
        // Permission was revoked while backgrounded (seen after iOS updates)
        if (Notification.permission !== lastPerm) {
          lastPerm = Notification.permission
          if (!cancelled && Notification.permission === "granted") void report()
        }
```

改为：

```ts
    let lastPerm: NotificationPermission = Notification.permission
    const onVisible = () => {
      if (!document.hidden) {
        // 权限在后台被系统撤销（iOS 更新后偶发）
        // Permission was revoked while backgrounded (seen after iOS updates)
        if (Notification.permission !== lastPerm) {
          // 记进诊断：iOS 系统更新后权限被悄悄撤销是最难复现的一类故障，
          // 用户只会说"以前能收到现在收不到了"。留下这条记录，诊断面板上
          // 就能直接看到权限变过。
          // Recorded because a permission silently revoked by an iOS update is
          // the hardest failure to reproduce — the user only reports "it used
          // to work". This leaves a trace the panel can show.
          if (Notification.permission === "granted") {
            recordDiag("permission")
          } else {
            recordDiag(
              "permission",
              `权限由 ${lastPerm} 变为 ${Notification.permission} / permission changed from ${lastPerm} to ${Notification.permission}`,
            )
          }
          lastPerm = Notification.permission
          if (!cancelled && Notification.permission === "granted") void report()
        }
```

其余部分（第 415 行起的静默重报与 `removeEventListener` 清理）保持不变。

注意 `recordDiag` 的调用必须放在 `lastPerm` 被覆盖**之前**，否则记录里的旧值会等于
新值，消息变成"由 granted 变为 granted"这种无意义内容。

- [ ] **Step 8: 改 NotifDeviceBanner.tsx 的 catch**

把第 20-31 行的 `useEffect` 改为：

```ts
  useEffect(() => {
    let alive = true
    notificationApi
      .getPrefs()
      .then((p) => {
        recordDiag("prefs")
        if (alive) setEnabled(p.enabled)
      })
      .catch((err) => recordDiag("prefs", err))
    return () => {
      alive = false
    }
  }, [])
```

并在该文件第 11 行 import 之后加入：

```ts
import { recordDiag } from "../utils/pushDiag"
```

- [ ] **Step 9: 验证类型检查与构建**

Run: `cd frontend; npm run build`

Expected: PASS。若报 `pushSupported` 重复声明，说明 Step 3 的删除未完成。

- [ ] **Step 10: 人工核对未破坏 iOS 权限路径**

检查 `frontend/src/utils/notifications.ts` 的 `enableNotifications`：确认
`Notification.requestPermission()` 调用之前**没有**新增任何 `await`。本任务不应修改
该文件；若它被改动了，回退。

- [ ] **Step 11: Commit**

```bash
git add frontend/src/utils/push.ts frontend/src/main.tsx frontend/src/components/Layout.tsx frontend/src/components/NotifDeviceBanner.tsx
git commit -m "fix(push): 静默失败改为记录诊断

SW 注册、订阅、上报、偏好读取、权限变化五处此前被
.catch(() => {}) 完全吞掉，sw.js 的语法错误因此长期无人发现。
现在 catch 仍不改变控制流，但失败原因留在诊断记录中。
同时把 pushSupported 的实现统一到 pushEnv.ts，消除两份实现。"
```

---

## Task 5: 后端测试推送与订阅状态接口

**Files:**
- Modify: `backend/tests/conftest.py:13`（追加测试用 VAPID 环境变量）
- Modify: `backend/app/routers/notifications.py`（在文件末尾、`vapid_public_key` 之后追加）
- Modify: `backend/app/services/push_dispatch.py`（新增 `dispatch_test_push` 函数）
- Create: `backend/tests/test_push_dispatch.py`（本任务建立，Task 6 继续追加）

**Interfaces:**
- Consumes: 现有 `_webpush_one(sub, payload, pem, vapid_claims, headers) -> tuple[bool, bool]`、
  `can_use_push(plan) -> bool`、`settings.vapid_private_key`、`settings.VAPID_PUBLIC_KEY`、
  `settings.VAPID_SUBJECT`
- Produces:
  - `dispatch_test_push(user_id: str) -> dict` in `push_dispatch.py`，返回
    `{"sent": int, "failed": int, "pruned": int}`。同步阻塞函数，调用方须放线程池
  - `POST /notifications/push/test` → `{"sent": int, "failed": int, "pruned": int}`
  - `GET /notifications/push/status?endpoint=<str>` → `{"count": int, "current_endpoint_registered": bool}`

- [ ] **Step 0: 先给测试环境配上 VAPID 密钥（否则所有推送测试都走不到推送逻辑）**

`settings.VAPID_PUBLIC_KEY` 与 `VAPID_PRIVATE_KEY_DER` 默认为空字符串，而
`dispatch_push` 在密钥缺失时直接静默 return、`dispatch_test_push` 会抛
`vapid-not-configured`。测试里 `webpush` 虽然被 mock，但代码在调用它**之前**就返回了，
断言 `call_count == 1` 必然失败。

在 `backend/tests/conftest.py` 第 13 行 `os.environ["ENV"] = "development"` 之后追加：

```python
# 推送测试需要非空的 VAPID 配置：密钥缺失时 dispatch_push 会在调用 webpush 之前
# 就静默 return，mock 永远不会被触达。值本身不需要是真钥匙——webpush 全程被 mock。
# Push tests need non-empty VAPID config: with keys missing, dispatch_push
# returns before ever calling webpush, so the mock is never reached. The values
# needn't be real keys — webpush is mocked throughout.
os.environ["VAPID_PRIVATE_KEY_DER"] = "test-private-key-not-real"
os.environ["VAPID_PUBLIC_KEY"] = "test-public-key-not-real"
```

这两行必须放在任何 `app` 模块导入之前——`settings` 在导入时读取环境变量。文件顶部
已有的注释说明了这个约束。

Run: `cd backend; python -m pytest -q`

Expected: PASS，既有测试不受影响（它们不涉及推送）。

- [ ] **Step 1: 先写失败测试（测试接口的核心行为）**

创建 `backend/tests/test_push_dispatch.py`：

```python
"""推送派发与诊断接口测试 / push dispatch and diagnostics endpoint tests.

全部 mock pywebpush.webpush，不发真实网络请求。
VAPID 配置由 conftest.py 用假值注入（密钥为空时派发逻辑会提前 return，mock 触达不到）。
All tests mock pywebpush.webpush; no real network calls. VAPID config is
injected with fake values by conftest.py — with empty keys the dispatch logic
returns early and the mock is never reached.
"""
from unittest.mock import patch

from app.models import PushSubscription


def _sub(db, user, endpoint, p256dh="k" * 20, auth="a" * 10):
    s = PushSubscription(user_id=user.id, endpoint=endpoint, keys_p256dh=p256dh, keys_auth=auth)
    db.add(s)
    db.commit()
    db.refresh(s)
    return s


def test_push_test_endpoint_no_subscription_returns_zero(client, db, user, auth_headers):
    """没有任何订阅时返回 sent=0，而不是报错。
    No subscriptions → sent=0, not an error."""
    user.plan = "PRO"
    db.commit()
    with patch("app.services.push_dispatch.webpush") as mock_push:
        r = client.post("/notifications/push/test", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == {"sent": 0, "failed": 0, "pruned": 0}
    mock_push.assert_not_called()


def test_push_test_endpoint_sends_to_all_subscriptions(client, db, user, auth_headers):
    """向本账号的每个订阅各发一条。/ One push per subscription on the account."""
    user.plan = "PRO"
    db.commit()
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    _sub(db, user, "https://web.push.apple.com/bbb")
    with patch("app.services.push_dispatch.webpush") as mock_push:
        r = client.post("/notifications/push/test", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == {"sent": 2, "failed": 0, "pruned": 0}
    assert mock_push.call_count == 2


def test_push_test_endpoint_ignores_prefs(client, db, user, auth_headers):
    """绕过通知偏好：偏好关闭时测试推送依然发送（这是链路探针，不是业务通知）。
    Bypasses prefs: still sends with notifications disabled — it's a pipeline
    probe, not a business notification."""
    user.plan = "PRO"
    db.commit()
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    # 不创建 NotificationPref，等价于 enabled=False
    with patch("app.services.push_dispatch.webpush") as mock_push:
        r = client.post("/notifications/push/test", headers=auth_headers)
    assert r.json()["sent"] == 1
    assert mock_push.call_count == 1


def test_push_test_endpoint_rejects_free_plan(client, db, user, auth_headers):
    """保留订阅等级检查，FREE 不得借此绕过付费边界。
    Plan check retained: FREE must not bypass the paywall through this."""
    user.plan = "FREE"
    db.commit()
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    with patch("app.services.push_dispatch.webpush") as mock_push:
        r = client.post("/notifications/push/test", headers=auth_headers)
    assert r.status_code == 403
    mock_push.assert_not_called()


def test_push_status_reports_count_and_current_endpoint(client, db, user, auth_headers):
    """订阅数与"当前 endpoint 是否在库"分别可查。
    Subscription count and whether the given endpoint is registered."""
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    _sub(db, user, "https://web.push.apple.com/bbb")

    r = client.get(
        "/notifications/push/status",
        params={"endpoint": "https://web.push.apple.com/bbb"},
        headers=auth_headers,
    )
    assert r.status_code == 200
    assert r.json() == {"count": 2, "current_endpoint_registered": True}

    r = client.get(
        "/notifications/push/status",
        params={"endpoint": "https://fcm.googleapis.com/fcm/send/zzz"},
        headers=auth_headers,
    )
    assert r.json() == {"count": 2, "current_endpoint_registered": False}


def test_push_status_without_endpoint_param(client, db, user, auth_headers):
    """endpoint 参数可选，未传时 current_endpoint_registered 为 False。
    The endpoint param is optional; absent → False."""
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    r = client.get("/notifications/push/status", headers=auth_headers)
    assert r.status_code == 200
    assert r.json() == {"count": 1, "current_endpoint_registered": False}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd backend; python -m pytest tests/test_push_dispatch.py -v`

Expected: FAIL，全部为 404（路由不存在）。`test_push_status_*` 两项也应为 404。

- [ ] **Step 3: 在 push_dispatch.py 中实现 dispatch_test_push**

在 `backend/app/services/push_dispatch.py` 末尾追加：

```python
# ---------- 诊断用测试推送 / diagnostic test push ----------


def dispatch_test_push(user_id: str) -> dict:
    """给指定用户的所有订阅各发一条固定内容的测试通知，返回计数。

    与业务推送的区别：完全绕过通知偏好与白名单（enabled、类别、品种一概不看）。
    这是链路探针——用户点"发送测试通知"就是要验证推送能不能到，不该被他自己的
    筛选条件挡住。订阅等级检查由路由层负责，不在这里重复。

    同步阻塞网络 IO，调用方必须放在线程池中执行。

    Send one fixed test notification to each of the user's subscriptions and
    return the counts. Unlike business pushes this bypasses prefs and
    whitelists entirely (enabled, category, symbol are all ignored): it's a
    pipeline probe — someone tapping "send test notification" wants to know
    whether push works at all, not to be filtered out by their own settings.
    The plan check lives in the route layer, not duplicated here.

    Synchronous blocking network IO — the caller must run it in a thread pool.
    """
    pem = settings.vapid_private_key
    if not pem or not settings.VAPID_PUBLIC_KEY:
        # 与业务推送的静默 return 不同：这里必须让调用方能区分"服务端没配密钥"
        # 与"本设备有问题"，两者的用户侧行动完全不同。
        # Unlike the silent return in business dispatch, the caller must be able
        # to tell "server has no keys" from "this device is broken" — the user
        # action differs completely.
        raise RuntimeError("vapid-not-configured")

    db = SessionLocal()
    try:
        subs = db.query(PushSubscription).filter(PushSubscription.user_id == user_id).all()
        if not subs:
            return {"sent": 0, "failed": 0, "pruned": 0}

        vapid_claims = {"sub": settings.VAPID_SUBJECT}
        payload = json.dumps({
            "title": "测试通知 / Test notification",
            "body": "推送链路正常。/ Push delivery is working.",
            "icon": "/icons/icon-192.png",
            "data": {"url": "/account#notifications"},
        })
        push_headers = {"Urgency": "high", "TTL": "60"}

        sent = 0
        failed = 0
        stale_ids: list[str] = []
        for sub in subs:
            ok, stale = _webpush_one(sub, payload, pem, vapid_claims, push_headers)
            if ok:
                sent += 1
            else:
                failed += 1
            if stale:
                stale_ids.append(sub.id)

        if stale_ids:
            db.query(PushSubscription).filter(
                PushSubscription.id.in_(stale_ids)
            ).delete(synchronize_session=False)
            db.commit()

        logger.info("[push] test push user=%s sent=%d failed=%d pruned=%d", user_id, sent, failed, len(stale_ids))
        return {"sent": sent, "failed": failed, "pruned": len(stale_ids)}
    finally:
        db.close()
```

- [ ] **Step 4: 在 notifications.py 中新增两个路由**

在 `backend/app/routers/notifications.py` 末尾（`vapid_public_key` 函数之后）追加：

```python
# ---- 推送诊断 / push diagnostics ----


@router.get("/push/status")
def push_status(
    endpoint: str | None = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """本账号的订阅数，以及传入的 endpoint 是否已在库中。

    供前端诊断面板判断"本设备的订阅是否已上报后端"——这与"本设备浏览器里存在
    订阅"是两件事：浏览器有订阅但后端没有，说明上报环节断了；两者都有才说明链路
    通畅。endpoint 省略时该字段返回 False。

    Subscription count for this account plus whether the given endpoint is
    already registered. Lets the diagnostics panel distinguish "this device's
    subscription reached the backend" from "this device's browser has a
    subscription": a browser-side subscription with nothing in the backend means
    the reporting step broke. Absent endpoint → False.
    """
    count = db.query(PushSubscription).filter(PushSubscription.user_id == current_user.id).count()
    registered = False
    if endpoint:
        registered = (
            db.query(PushSubscription)
            .filter(
                PushSubscription.user_id == current_user.id,
                PushSubscription.endpoint == endpoint,
            )
            .first()
            is not None
        )
    return {"count": count, "current_endpoint_registered": registered}


# 能触发真实推送，不限流会变成骚扰工具 / can trigger real pushes; unthrottled it becomes a nuisance tool
@router.post("/push/test")
@limiter.limit("5/minute")
async def push_test(
    request: Request,
    current_user: User = Depends(get_current_user),
):
    """给本账号的所有设备各发一条测试通知，返回 sent/failed/pruned 计数。

    绕过通知偏好与白名单（链路探针，不是业务通知），但保留订阅等级检查。
    不因单个订阅失败返回 5xx：一个用户可能同时有桌面 Chrome 与 iPhone 两个订阅，
    其中一个失效不该让整个诊断动作看起来像"接口挂了"。前端按 failed > 0 提示。

    Send one test notification to every device on this account and return the
    sent/failed/pruned counts. Bypasses prefs and whitelists (pipeline probe,
    not a business notification) but keeps the plan check. A single failing
    subscription does not produce a 5xx: a user may have desktop Chrome and an
    iPhone, and one dead subscription shouldn't make the whole diagnostic look
    like a broken endpoint. The frontend surfaces failed > 0.
    """
    if not can_use_push(current_user.plan):
        raise HTTPException(status_code=403, detail="免费版不支持通知推送，请升级解锁 / Free tier doesn't include push notifications; upgrade to unlock")
    try:
        return await run_in_threadpool(dispatch_test_push, current_user.id)
    except RuntimeError as e:
        if str(e) == "vapid-not-configured":
            raise HTTPException(status_code=503, detail="服务端未配置推送密钥 / server has no push keys configured")
        raise
```

同时在该文件的 import 区加入所需符号。把第 5 行：

```python
from fastapi import APIRouter, Depends, HTTPException
```

改为：

```python
from fastapi import APIRouter, Depends, HTTPException, Request
from starlette.concurrency import run_in_threadpool
```

把第 15 行：

```python
from app.services.push_dispatch import EVENT_TYPES
```

改为：

```python
from app.core.rate_limit import limiter
from app.services.push_dispatch import EVENT_TYPES, dispatch_test_push
```

注意：slowapi 的 `@limiter.limit` 装饰器要求被装饰函数带有名为 `request` 的
`Request` 参数，否则运行时报错。这是 `push_test` 声明 `request: Request` 的唯一原因，
函数体不使用它。

- [ ] **Step 5: 运行测试确认通过**

Run: `cd backend; python -m pytest tests/test_push_dispatch.py -v`

Expected: PASS，6 项全过。

- [ ] **Step 6: 确认未破坏既有测试**

Run: `cd backend; python -m pytest -q`

Expected: PASS，全部既有测试仍然通过。

- [ ] **Step 7: Commit**

```bash
git add backend/tests/conftest.py backend/app/routers/notifications.py backend/app/services/push_dispatch.py backend/tests/test_push_dispatch.py
git commit -m "feat(push): 新增测试推送与订阅状态诊断接口

POST /notifications/push/test 向本账号所有设备发一条测试通知，
绕过偏好与白名单但保留等级检查，复用 _webpush_one 以继承
per-subscription vapid_claims 的 aud 修复。
GET /notifications/push/status 供前端区分「浏览器有订阅」与
「后端已收到订阅」两种状态。"
```

---

## Task 6: 后端推送派发单元测试

**Files:**
- Modify: `backend/tests/test_push_dispatch.py`（追加派发逻辑测试）

**Interfaces:**
- Consumes: `dispatch_push(signal)`、`_matched_user_ids(db, cat, symbol)`、`ALL_SENTINEL`、
  `EVENT_ORDER_FILLED` from `app.services.push_dispatch`；`make_signal` from `tests.conftest`
- Produces: 无

本任务给此前零覆盖的推送派发补上测试。最重要的是第一项——它钉住一个已在生产发生过的
bug。

本任务的测试直接调用派发函数、不经 HTTP，因此不涉及路由前缀。（更正：Task 5 原文里的
接口路径漏了 `/api` 前缀——路由在 `main.py` 以 `prefix=settings.API_PREFIX` 挂载，
`API_PREFIX = "/api"`，实际路径是 `/api/notifications/push/test` 与
`/api/notifications/push/status`。Task 5 实施时已修正，前端 Task 7 的 `request()`
封装自带前缀，无需改动。）

- [ ] **Step 1: 追加 aud 复用回归测试**

在 `backend/tests/test_push_dispatch.py` 末尾追加：

```python
# ---------- 派发逻辑 / dispatch logic ----------


def _pref(db, user, enabled=True, cats=None, syms=None, events=None):
    """造一行通知偏好。白名单以 JSON 文本存储。
    Create a notification-prefs row; whitelists are stored as JSON text."""
    import json

    from app.models import NotificationPref

    p = NotificationPref(
        user_id=user.id,
        enabled=enabled,
        selected_categories=json.dumps(cats if cats is not None else [ALL_SENTINEL]),
        selected_symbols=json.dumps(syms if syms is not None else [ALL_SENTINEL]),
        event_types=json.dumps(events if events is not None else []),
    )
    db.add(p)
    db.commit()
    return p


def test_vapid_claims_not_shared_across_subscriptions(db, user):
    """每个订阅必须拿到独立的 vapid_claims 字典。

    pywebpush 会把 aud（按 endpoint 的推送服务域名推导）原地写进传入的 claims
    字典且此后不再覆盖。复用同一个字典时，第一个订阅落在哪家推送服务，aud 就
    永远是哪家，后续其它服务的订阅全部 403 BadJwtToken——而 403 不在清理名单里，
    会一直静默失败。典型触发场景：用户同时有桌面 Chrome 与 iPhone。
    该 bug 已在生产日志中实锤，此测试钉死修复。

    Each subscription must get its own vapid_claims dict. pywebpush writes aud
    (derived from the endpoint's push-service origin) into the caller's dict in
    place and never overwrites it, so reusing one dict across a loop pins aud to
    whichever service came first — every later subscription on another service
    gets 403 BadJwtToken, and 403 isn't pruned, so it fails silently forever.
    Confirmed in production logs; this test nails the fix down.
    """
    user.plan = "PRO"
    db.commit()
    _pref(db, user)
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    _sub(db, user, "https://web.push.apple.com/bbb")
    sig = make_signal(db, indicator="test")

    seen = []

    def fake_webpush(**kwargs):
        # 记录对象身份，而不是内容——内容此刻还都是 {"sub": ...}，
        # 真正的问题是"同一个对象被复用"。
        # Record object identity rather than contents: contents are still just
        # {"sub": ...} at this point; the bug is the object being reused.
        seen.append(id(kwargs["vapid_claims"]))

    with patch("app.services.push_dispatch.webpush", side_effect=fake_webpush):
        dispatch_push(sig)

    assert len(seen) == 2
    assert seen[0] != seen[1], "vapid_claims 字典在订阅之间被复用了 / dict reused across subscriptions"
```

并在文件顶部的 import 区补充：

```python
from app.services.push_dispatch import (
    ALL_SENTINEL,
    EVENT_ORDER_FILLED,
    dispatch_push,
    dispatch_event_push,
)
from tests.conftest import make_signal
```

注意：`dispatch_event_push` 的确切函数名需先确认。读取
`backend/app/services/push_dispatch.py` 中"事件类通知（单用户）"一节，找到接收
`user_id` 与 `event_type` 的公开派发函数，用其真实名称替换。若签名不同，按实际签名
调整 Step 4 的测试。

- [ ] **Step 2: 运行确认失败或通过**

Run: `cd backend; python -m pytest tests/test_push_dispatch.py::test_vapid_claims_not_shared_across_subscriptions -v`

Expected: PASS。该修复已在代码中（`push_dispatch.py:143` 的 `dict(vapid_claims)`），
所以这是一个**回归锁定测试**，本就应该通过。

若意外 FAIL，说明修复不在或已被改动 —— 那是真实缺陷，停下来排查而不是改测试。

- [ ] **Step 3: 追加白名单与等级过滤测试**

继续在同一文件末尾追加：

```python
def test_symbol_whitelist_anded_with_category(db, user):
    """类别与品种是两条独立白名单，按"与"关系联合：只命中一边不推送。
    Category and symbol are independent whitelists ANDed together: matching
    only one side sends nothing."""
    user.plan = "PRO"
    db.commit()
    # 品种白名单只放 EURUSD，信号是 XAUUSD
    _pref(db, user, cats=[ALL_SENTINEL], syms=["EURUSD"])
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    sig = make_signal(db, symbol="XAUUSD", indicator="test")

    with patch("app.services.push_dispatch.webpush") as mock_push:
        dispatch_push(sig)

    mock_push.assert_not_called()


def test_all_sentinel_matches_any_symbol(db, user):
    """哨兵值放行任意品种，包括此刻还不存在、以后才出现的。
    The sentinel admits any symbol, including ones that don't exist yet."""
    user.plan = "PRO"
    db.commit()
    _pref(db, user, cats=[ALL_SENTINEL], syms=[ALL_SENTINEL])
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    sig = make_signal(db, symbol="SOMETHINGNEW", indicator="test")

    with patch("app.services.push_dispatch.webpush") as mock_push:
        dispatch_push(sig)

    assert mock_push.call_count == 1


def test_free_plan_filtered_even_with_enabled_pref(db, user):
    """降级为 FREE 的账号即使残留 enabled=True 也不推送。

    偏好行的 enabled 不会因降级自动清空。新信号此刻仍是 ACTIVE，FREE 要等它过期
    后才能在 REST/WS 里看到——若这里不同步过滤，一个曾开过推送、后被降级的账号
    会靠推送绕过延迟机制提前拿到信号。

    A downgraded FREE account must not receive pushes even with a leftover
    enabled=True: the pref row isn't cleared on downgrade, and since the signal
    is still ACTIVE, FREE would otherwise bypass the delay it's supposed to have.
    """
    user.plan = "FREE"
    db.commit()
    _pref(db, user, enabled=True)
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")
    sig = make_signal(db, indicator="test")

    with patch("app.services.push_dispatch.webpush") as mock_push:
        dispatch_push(sig)

    mock_push.assert_not_called()
```

- [ ] **Step 4: 追加订阅清理与事件通知测试**

继续追加：

```python
def test_410_prunes_subscription_but_403_does_not(db, user):
    """410/404 表示订阅已失效，应清理；403 可能是配置或 JWT 问题，不能清理
    ——把 403 也当失效会在密钥配错时把全部订阅删光。
    410/404 mean the subscription is gone and should be pruned; 403 may be a
    config or JWT issue and must not be — pruning on 403 would wipe every
    subscription the moment a key is misconfigured."""
    from pywebpush import WebPushException

    user.plan = "PRO"
    db.commit()
    _pref(db, user)
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/gone")
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/forbidden")
    sig = make_signal(db, indicator="test")

    class Resp:
        def __init__(self, code):
            self.status_code = code

    def fake_webpush(**kwargs):
        endpoint = kwargs["subscription_info"]["endpoint"]
        code = 410 if endpoint.endswith("gone") else 403
        raise WebPushException("boom", response=Resp(code))

    with patch("app.services.push_dispatch.webpush", side_effect=fake_webpush):
        dispatch_push(sig)

    remaining = {s.endpoint for s in db.query(PushSubscription).all()}
    assert remaining == {"https://fcm.googleapis.com/fcm/send/forbidden"}


def test_event_push_respects_event_type_whitelist(db, user):
    """事件类通知按用户自己的 event_types 白名单过滤。
    Event notifications are gated by the user's own event_types whitelist."""
    user.plan = "PRO"
    db.commit()
    # 白名单里没有 order_filled
    _pref(db, user, events=["bridge_offline"])
    _sub(db, user, "https://fcm.googleapis.com/fcm/send/aaa")

    with patch("app.services.push_dispatch.webpush") as mock_push:
        dispatch_event_push(user.id, EVENT_ORDER_FILLED, "标题 / Title", "正文 / Body")

    mock_push.assert_not_called()
```

该签名已核实：`push_dispatch.py:246` 为
`def dispatch_event_push(user_id: str, event_type: str, title: str, body: str) -> None`。

- [ ] **Step 5: 运行全部推送测试**

Run: `cd backend; python -m pytest tests/test_push_dispatch.py -v`

Expected: PASS，11 项全过（Task 5 的 6 项 + 本任务的 5 项）。

若某项因 `make_signal` 不接受 `indicator` 参数而失败：`conftest.py` 的 `make_signal`
把 `indicator` 硬编码为 `"test"`，不从 `kw` 读取。此时去掉调用里的 `indicator=` 参数
即可，`"test"` 本身就是有效的指标类别。

- [ ] **Step 6: 确认未破坏既有测试**

Run: `cd backend; python -m pytest -q`

Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add backend/tests/test_push_dispatch.py
git commit -m "test(push): 补齐推送派发单元测试

此前推送派发零覆盖。重点钉住 vapid_claims 跨订阅复用导致的
aud 错误——该 bug 已在生产发生过（桌面 Chrome + iPhone 混用
时后者全部 403 静默失败）。另覆盖白名单与关系、哨兵值、
FREE 降级过滤、410 清理与 403 不清理、事件类白名单。"
```

---

## Task 7: 前端 API 客户端与 i18n 文案

**Files:**
- Modify: `frontend/src/api/client.ts:676-688`（`pushApi` 追加两个方法）
- Modify: `frontend/src/i18n/zh.json`（`account` 段内，参照第 416-434 行位置）
- Modify: `frontend/src/i18n/en.json`（同结构）

**Interfaces:**
- Consumes: `POST /notifications/push/test`、`GET /notifications/push/status`（Task 5）
- Produces:
  - `pushApi.getStatus(endpoint?: string): Promise<{ count: number; current_endpoint_registered: boolean }>`
  - `pushApi.sendTest(): Promise<{ sent: number; failed: number; pruned: number }>`
  - i18n keys: `account.notifIosNeedsInstall`、`account.notifIosTooOld`、
    `account.notifPermissionBlocked`、`account.notifDiagTitle`、`account.notifDiagEnv`、
    `account.notifDiagStandalone`、`account.notifDiagSw`、`account.notifDiagPermission`、
    `account.notifDiagSubscription`、`account.notifDiagBackend`、`account.notifDiagLastPush`、
    `account.notifDiagSendTest`、`account.notifDiagSendTestOk`、`account.notifDiagSendTestNone`、
    `account.notifDiagSendTestFail`、`account.notifDiagUnknown`、`account.notifDiagYes`、
    `account.notifDiagNo`、`account.notifDiagNever`、`account.notifDiagNotConfigured`

- [ ] **Step 1: 扩展 pushApi**

把 `frontend/src/api/client.ts` 的 `pushApi` 对象（第 676-688 行）改为：

```ts
export const pushApi = {
  getVapidKey: () => request<{ publicKey: string }>('/notifications/push/vapid-public-key'),
  subscribe: (endpoint: string, keys: { p256dh: string; auth: string }) =>
    request<{ ok: boolean }>('/notifications/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint, keys }),
    }),
  unsubscribe: (endpoint: string, keys: { p256dh: string; auth: string }) =>
    request<{ ok: boolean }>('/notifications/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint, keys }),
    }),
  // 诊断用：后端记录了几个订阅、其中是否包含本设备当前的 endpoint。
  // "浏览器里有订阅"与"后端收到了订阅"是两件事，分开查才能定位上报环节的问题。
  // Diagnostics: how many subscriptions the backend holds and whether this
  // device's current endpoint is among them. "The browser has a subscription"
  // and "the backend received it" are different things; querying them
  // separately is what pinpoints a broken reporting step.
  getStatus: (endpoint?: string) =>
    request<{ count: number; current_endpoint_registered: boolean }>(
      `/notifications/push/status${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`,
    ),
  // 给本账号所有设备发一条测试通知，端到端验证链路。
  // Send one test notification to every device on the account — end-to-end check.
  sendTest: () =>
    request<{ sent: number; failed: number; pruned: number }>('/notifications/push/test', {
      method: 'POST',
    }),
}
```

- [ ] **Step 2: 修改 zh.json 的现有文案并新增**

在 `frontend/src/i18n/zh.json` 的 `account` 段中：

把第 433 行的 `notifUnsupported` 改为不再包含 iOS 引导（那部分移到专门的 key）：

```json
    "notifUnsupported": "当前浏览器不支持推送通知。",
```

删除第 434 行的 `notifDeviceHint`——它建议"关掉再打开一次"，对权限已被拒绝的情况无效，
其职责由 `notifPermissionBlocked` 接管。

然后新增以下条目：

```json
    "notifIosNeedsInstall": "iPhone/iPad 需要先把本站添加到主屏幕才能接收推送。请在 Safari 底部分享菜单中选择「添加到主屏幕」，然后从主屏幕图标打开本站，再开启通知。",
    "notifIosTooOld": "当前 iOS 版本不支持网页推送通知。请将系统升级到 iOS 16.4 或更高版本后再试。",
    "notifPermissionBlocked": "通知权限已被拒绝，需要在系统设置中手动开启。iPhone/iPad：设置 → 通知 → Signal Lab；Android Chrome：浏览器菜单 → 设置 → 网站设置 → 通知。",
    "notifDiagTitle": "推送诊断",
    "notifDiagEnv": "运行环境",
    "notifDiagStandalone": "以独立应用模式启动",
    "notifDiagSw": "Service Worker 已激活",
    "notifDiagPermission": "通知权限",
    "notifDiagSubscription": "本设备存在推送订阅",
    "notifDiagBackend": "订阅已上报后端",
    "notifDiagLastPush": "最后一次收到推送",
    "notifDiagSendTest": "发送测试通知",
    "notifDiagSendTestOk": "已向 {{count}} 台设备发送，请查看系统通知。",
    "notifDiagSendTestNone": "本账号没有任何推送订阅，请先开启通知。",
    "notifDiagSendTestFail": "{{failed}} 台设备发送失败。",
    "notifDiagUnknown": "无法检测",
    "notifDiagYes": "是",
    "notifDiagNo": "否",
    "notifDiagNever": "从未",
    "notifDiagNotConfigured": "服务端未配置推送密钥",
```

- [ ] **Step 3: 同步 en.json**

在 `frontend/src/i18n/en.json` 的 `account` 段做对应改动：

```json
    "notifUnsupported": "This browser doesn't support push notifications.",
    "notifIosNeedsInstall": "iPhone/iPad must add this site to the Home Screen to receive pushes. Tap Share in Safari, choose \"Add to Home Screen\", then open the site from that icon and enable notifications.",
    "notifIosTooOld": "This iOS version doesn't support web push notifications. Update to iOS 16.4 or later and try again.",
    "notifPermissionBlocked": "Notification permission was denied and must be re-enabled in system settings. iPhone/iPad: Settings → Notifications → Signal Lab. Android Chrome: browser menu → Settings → Site settings → Notifications.",
    "notifDiagTitle": "Push diagnostics",
    "notifDiagEnv": "Environment",
    "notifDiagStandalone": "Launched as a standalone app",
    "notifDiagSw": "Service Worker active",
    "notifDiagPermission": "Notification permission",
    "notifDiagSubscription": "Push subscription on this device",
    "notifDiagBackend": "Subscription reported to backend",
    "notifDiagLastPush": "Last push received",
    "notifDiagSendTest": "Send test notification",
    "notifDiagSendTestOk": "Sent to {{count}} device(s) — check your system notifications.",
    "notifDiagSendTestNone": "No push subscriptions on this account. Enable notifications first.",
    "notifDiagSendTestFail": "Failed to send to {{failed}} device(s).",
    "notifDiagUnknown": "Cannot detect",
    "notifDiagYes": "Yes",
    "notifDiagNo": "No",
    "notifDiagNever": "Never",
    "notifDiagNotConfigured": "Server has no push keys configured",
```

同样删除 en.json 中的 `notifDeviceHint`。

- [ ] **Step 4: 确认没有遗留对已删除 key 的引用**

Run: `cd frontend; npx tsc -b`

然后用编辑器搜索 `notifDeviceHint`，确认仅剩 Task 8 待改的两处引用
（`NotifDeviceBanner.tsx:49`、`NotificationBell.tsx:155`）。这两处在 Task 8 一并替换。

Expected: `tsc -b` PASS（i18n key 是字符串，TS 不校验其存在性，因此此步是人工核对）。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/client.ts frontend/src/i18n/zh.json frontend/src/i18n/en.json
git commit -m "feat(push): 新增诊断接口客户端与分状态引导文案

按 PushEnv 六态拆分文案：iOS 需安装到主屏幕、iOS 版本过低、
权限被拒各自给出可行动的指引。移除 notifDeviceHint——它建议
「关掉再打开一次」，而 requestPermission 在 denied 状态下不会
再弹框，那句话对最需要帮助的用户完全无效。"
```

---

## Task 8: 提示条与铃铛按 PushEnv 取文案

**Files:**
- Modify: `frontend/src/components/NotifDeviceBanner.tsx:33-50`
- Modify: `frontend/src/components/NotificationBell.tsx:57-59, 153-157`

**Interfaces:**
- Consumes: `detectPushEnv`、`PUSH_ENV_HINT_KEYS` from `../utils/pushEnv`（Task 3）；
  Task 7 新增的 i18n keys
- Produces: 无

- [ ] **Step 1: 改 NotifDeviceBanner 的显示条件与文案**

在 `frontend/src/components/NotifDeviceBanner.tsx` 中，把第 11 行的 import：

```ts
import { pushSupported } from "../utils/push"
```

改为：

```ts
import { detectPushEnv, PUSH_ENV_HINT_KEYS } from "../utils/pushEnv"
```

把第 33-37 行：

```ts
  const deviceOk =
    pushSupported() && typeof Notification !== "undefined" && Notification.permission === "granted"
  const shouldShow = enabled && !deviceOk

  if (!shouldShow || dismissed) return null
```

改为：

```ts
  const env = detectPushEnv()
  const hintKey = PUSH_ENV_HINT_KEYS[env]

  // iOS 16.4+ 在 Safari 标签页里的用户根本开不了账号级开关（没有 PushManager，
  // enableNotifications 会直接抛 unsupported），所以此前"enabled && !deviceOk"
  // 的条件让最需要引导的这批人永远看不到提示。这一种状态下不看 enabled。
  // 其余状态维持原条件，避免对从未打算用通知的人无谓打扰。
  //
  // Users on iOS 16.4+ in a Safari tab can't turn the account-level toggle on at
  // all (no PushManager, so enableNotifications throws unsupported), which meant
  // the previous "enabled && !deviceOk" condition hid the banner from exactly the
  // people who needed it. That one state ignores `enabled`; the rest keep the
  // original condition so anyone uninterested in notifications isn't nagged.
  const shouldShow = env === "ios-needs-install" ? true : enabled && hintKey !== null

  if (!shouldShow || dismissed) return null
```

把第 48-50 行的文案渲染：

```tsx
        <span className="leading-relaxed">
          {pushSupported() ? t("account.notifDeviceHint") : t("account.notifUnsupported")}
        </span>
```

改为：

```tsx
        <span className="leading-relaxed">{t(hintKey ?? "account.notifUnsupported")}</span>
```

- [ ] **Step 2: 把 NotifDeviceBanner 的偏好读取失败记入诊断**

把第 20-31 行的 `useEffect` 改为：

```ts
  useEffect(() => {
    let alive = true
    notificationApi
      .getPrefs()
      .then((p) => {
        recordDiag("prefs")
        if (alive) setEnabled(p.enabled)
      })
      .catch((err) => recordDiag("prefs", err))
    return () => {
      alive = false
    }
  }, [])
```

并在 import 区加入：

```ts
import { recordDiag } from "../utils/pushDiag"
```

（若 Task 4 Step 8 已完成此改动，跳过本步。）

- [ ] **Step 3: 改 NotificationBell 的状态判定与文案**

在 `frontend/src/components/NotificationBell.tsx` 中，把第 11 行：

```ts
import { pushSupported } from "../utils/push"
```

改为：

```ts
import { detectPushEnv, PUSH_ENV_HINT_KEYS } from "../utils/pushEnv"
```

把第 57-59 行：

```ts
  const deviceOk =
    pushSupported() && typeof Notification !== "undefined" && Notification.permission === "granted"
  const status: Status = !enabled ? "off" : deviceOk ? "on" : "attention"
```

改为：

```ts
  const env = detectPushEnv()
  const hintKey = PUSH_ENV_HINT_KEYS[env]
  // hintKey 为 null 即环境完全就绪（granted/ready），无需提示。
  // A null hintKey means the environment is fully ready (granted/ready).
  const status: Status = !enabled ? "off" : env === "granted" ? "on" : "attention"
```

把第 153-157 行：

```tsx
          {status === "attention" && (
            <p className="mt-2 text-xs leading-relaxed text-amber-400">
              {pushSupported() ? t("account.notifDeviceHint") : t("account.notifUnsupported")}
            </p>
          )}
```

改为：

```tsx
          {status === "attention" && (
            <p className="mt-2 text-xs leading-relaxed text-amber-400">
              {t(hintKey ?? "account.notifUnsupported")}
            </p>
          )}
```

- [ ] **Step 4: 检查 AccountPage 的同类判断**

`frontend/src/pages/AccountPage.tsx` 第 472-477 行有两处类似判断：

```tsx
              {notifEnabled && !pushSupported() && (
              ...
              {notifEnabled && pushSupported() && Notification.permission !== "granted" && (
```

先读取这两处的完整渲染内容，然后合并为单一的按 `PushEnv` 取文案的分支：

```tsx
              {notifEnabled && hintKey && (
                <p className="mt-2 text-xs leading-relaxed text-amber-400">{t(hintKey)}</p>
              )}
```

已核实两处原本的 className 完全相同（均为 `text-xs text-amber-400`），因此合并后用：

```tsx
              {notifEnabled && hintKey && (
                <p className="text-xs text-amber-400">{t(hintKey)}</p>
              )}
```

`hintKey` 由组件内新增的一行提供，放在 `notifEnabled` 等 state 声明之后：

```ts
  const hintKey = PUSH_ENV_HINT_KEYS[detectPushEnv()]
```

同时删除第 462-471 行那段解释"两种情况"的注释——它描述的是被合并掉的二分逻辑，
合并后已不适用。import 区把 `pushSupported` 换成
`import { detectPushEnv, PUSH_ENV_HINT_KEYS } from "../utils/pushEnv"`；若
`pushSupported` 在该文件其它位置仍被使用则保留它。

- [ ] **Step 5: 验证构建**

Run: `cd frontend; npm run build`

Expected: PASS。若报 `pushSupported` 已导入但未使用（`noUnusedLocals`），删除该 import。

- [ ] **Step 6: 全局确认 notifDeviceHint 已无引用**

用编辑器全局搜索 `notifDeviceHint`，应为零结果。

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/NotifDeviceBanner.tsx frontend/src/components/NotificationBell.tsx frontend/src/pages/AccountPage.tsx
git commit -m "fix(push): 三处提示统一按 PushEnv 取文案

提示条此前要求账号级开关已开启才显示，而 iOS Safari 标签页
用户恰恰开不了这个开关，最需要安装引导的人永远看不到提示。
现在 ios-needs-install 状态不再检查 enabled。铃铛弹层与账户页
的同类二选一判断一并收敛到同一张映射表。"
```

---

## Task 9: 诊断面板组件

**Files:**
- Create: `frontend/src/components/PushDiagnostics.tsx`
- Modify: `frontend/src/pages/AccountPage.tsx:428`（通知区块内挂载）

**Interfaces:**
- Consumes: `getPushDiag`、`PushDiagStep` from `../utils/pushDiag`（Task 2）；
  `detectPushEnv`、`isStandalone` from `../utils/pushEnv`（Task 3）；
  `pushApi.getStatus`、`pushApi.sendTest` from `../api/client`（Task 7）；
  Task 7 的 i18n keys
- Produces: `default export function PushDiagnostics(): JSX.Element`

**设计要点：** 面板是排障工具，必须比被排障的对象更健壮。每项检查独立 try/catch，
任一项探测抛错只让那一行显示"无法检测"，不影响其余行，也不让整个面板白屏。

- [ ] **Step 1: 创建组件**

创建 `frontend/src/components/PushDiagnostics.tsx`：

```tsx
// 推送链路诊断面板。折叠式，默认收起，放在账户页通知区块内。
//
// 存在理由：推送链路横跨浏览器能力、Service Worker、权限、订阅、后端上报、
// 实际派发六个环节，任一环断掉的表现都是同一个"收不到通知"。而其中若干环节
// 只在真机上、特别是只在 iOS 以独立模式启动时才成立，桌面调试器覆盖不到。
// 这个面板让任何一台手机打开就能看出断在哪一环。
//
// Push pipeline diagnostics panel — collapsible, collapsed by default, inside
// the account page's notification section.
//
// Why it exists: the pipeline spans six links (browser capability, service
// worker, permission, subscription, backend reporting, actual dispatch) and a
// break in any of them looks identical — "no notifications". Several links only
// hold on a real device, and on iOS only when launched standalone, which a
// desktop debugger can't reach. This panel makes the broken link visible from
// any phone.
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { pushApi } from "../api/client"
import { getPushDiag, type PushDiagStep } from "../utils/pushDiag"
import { detectPushEnv, isStandalone } from "../utils/pushEnv"

type Probe = { label: string; value: string; ok: boolean | null }

// 探测结果的三态：ok / 不 ok / 无法检测。无法检测与"否"必须分开——前者说明探测
// 本身出了问题，后者是确定的结论，排查方向不同。
// Three states: ok / not ok / undetectable. "Undetectable" must stay distinct
// from "no": the former means the probe itself failed, the latter is a definite
// finding, and they lead somewhere different.
export default function PushDiagnostics() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [probes, setProbes] = useState<Probe[]>([])
  // null 表示"还没测出结果"，与"测出来是从未收到过"区分开——超时兜底逻辑依赖这个区分。
  // null means "no result yet", distinct from "measured, never received" — the
  // timeout fallback relies on telling those apart.
  const [lastPush, setLastPush] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true

    const run = async () => {
      const out: Probe[] = []
      const yes = t("account.notifDiagYes")
      const no = t("account.notifDiagNo")
      const unknown = t("account.notifDiagUnknown")

      // 每项独立 try/catch：一项探测失败不影响其余项。
      // Each probe is independently guarded so one failure doesn't hide the rest.
      try {
        out.push({ label: t("account.notifDiagEnv"), value: detectPushEnv(), ok: null })
      } catch {
        out.push({ label: t("account.notifDiagEnv"), value: unknown, ok: null })
      }

      try {
        const sa = isStandalone()
        out.push({ label: t("account.notifDiagStandalone"), value: sa ? yes : no, ok: sa })
      } catch {
        out.push({ label: t("account.notifDiagStandalone"), value: unknown, ok: null })
      }

      let endpoint: string | undefined
      try {
        const reg = await navigator.serviceWorker?.getRegistration()
        const active = !!reg?.active
        out.push({ label: t("account.notifDiagSw"), value: active ? yes : no, ok: active })
        try {
          const sub = await reg?.pushManager?.getSubscription()
          endpoint = sub?.endpoint
          out.push({
            label: t("account.notifDiagSubscription"),
            value: sub ? yes : no,
            ok: !!sub,
          })
        } catch {
          out.push({ label: t("account.notifDiagSubscription"), value: unknown, ok: null })
        }
      } catch {
        out.push({ label: t("account.notifDiagSw"), value: unknown, ok: null })
        out.push({ label: t("account.notifDiagSubscription"), value: unknown, ok: null })
      }

      try {
        const perm = typeof Notification !== "undefined" ? Notification.permission : "unavailable"
        out.push({
          label: t("account.notifDiagPermission"),
          value: perm,
          ok: perm === "granted",
        })
      } catch {
        out.push({ label: t("account.notifDiagPermission"), value: unknown, ok: null })
      }

      try {
        const st = await pushApi.getStatus(endpoint)
        out.push({
          label: t("account.notifDiagBackend"),
          value: `${st.current_endpoint_registered ? yes : no} (${st.count})`,
          ok: st.current_endpoint_registered,
        })
      } catch {
        out.push({ label: t("account.notifDiagBackend"), value: unknown, ok: null })
      }

      // 诊断记录里的失败项逐条列出。
      // List each recorded failure.
      try {
        for (const [step, entry] of getPushDiag()) {
          if (!entry.ok) {
            out.push({ label: step as PushDiagStep, value: entry.error ?? unknown, ok: false })
          }
        }
      } catch {
        // 忽略：诊断记录读取失败不该让面板失效。
        // Ignored: a failed diagnostics read must not break the panel.
      }

      if (alive) setProbes(out)
    }

    void run()

    // 向 SW 查询最后一次收到推送的时间（已有的 PING_PUSH_HEARTBEAT 机制）。
    // Ask the SW for the last push timestamp via the existing heartbeat channel.
    // controller 为 null 说明当前页面没有被任何 SW 接管——这正是本次故障的形态，
    // 也是面板最需要说清楚的情况。此时不能只是不回消息（那会让这一行永远空白），
    // 必须显式落到"无法检测"。
    // A null controller means no SW controls this page — exactly the failure this
    // panel exists to expose. Leaving the message unsent would leave the row
    // blank forever, so fall through to "cannot detect" explicitly.
    const ctrl = navigator.serviceWorker?.controller
    if (!ctrl) {
      setLastPush(t("account.notifDiagUnknown"))
    } else {
      try {
        const ch = new MessageChannel()
        ch.port1.onmessage = (ev) => {
          if (!alive) return
          const ts = ev.data?.lastPushAt
          setLastPush(ts ? new Date(ts).toLocaleString() : t("account.notifDiagNever"))
        }
        ctrl.postMessage({ type: "PING_PUSH_HEARTBEAT" }, [ch.port2])
        // SW 存在但不回消息也有可能（版本不匹配、消息处理器异常）。给一个超时，
        // 避免这一行无限停在初始状态。
        // An SW can exist yet never reply (version mismatch, handler error).
        // Time out so the row doesn't hang on its initial value.
        window.setTimeout(() => {
          if (alive) setLastPush((prev) => prev ?? t("account.notifDiagUnknown"))
        }, 1500)
      } catch {
        setLastPush(t("account.notifDiagUnknown"))
      }
    }

    return () => {
      alive = false
    }
  }, [open, t])

  const sendTest = async () => {
    setTesting(true)
    setTestMsg(null)
    try {
      const r = await pushApi.sendTest()
      if (r.sent === 0 && r.failed === 0) {
        setTestMsg(t("account.notifDiagSendTestNone"))
      } else if (r.failed > 0) {
        setTestMsg(t("account.notifDiagSendTestFail", { failed: r.failed }))
      } else {
        setTestMsg(t("account.notifDiagSendTestOk", { count: r.sent }))
      }
    } catch (err) {
      setTestMsg(err instanceof Error ? err.message : t("account.notifDiagUnknown"))
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between text-xs font-semibold text-slate-300 hover:text-white"
      >
        <span>{t("account.notifDiagTitle")}</span>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-1.5">
          {probes.map((p, i) => (
            <div key={`${p.label}-${i}`} className="flex items-start justify-between gap-3 text-xs">
              <span className="text-slate-400">{p.label}</span>
              <span
                className={
                  p.ok === null
                    ? "text-slate-300"
                    : p.ok
                      ? "text-emerald-400"
                      : "text-amber-400"
                }
              >
                {p.value}
              </span>
            </div>
          ))}

          <div className="flex items-start justify-between gap-3 text-xs">
            <span className="text-slate-400">{t("account.notifDiagLastPush")}</span>
            <span className="text-slate-300">{lastPush || "…"}</span>
          </div>

          <button
            type="button"
            onClick={sendTest}
            disabled={testing}
            className="mt-3 w-full rounded-lg bg-prism-500/20 px-3 py-2 text-xs font-semibold text-prism-200 transition hover:bg-prism-500/30 disabled:opacity-50"
          >
            {t("account.notifDiagSendTest")}
          </button>
          {testMsg && <p className="mt-2 text-xs leading-relaxed text-slate-300">{testMsg}</p>}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 在 AccountPage 中挂载**

在 `frontend/src/pages/AccountPage.tsx` 的通知 `<section id="notifications">`（第 428 行
起）内部末尾——最后一个子元素之后、`</section>` 之前——插入：

```tsx
              <PushDiagnostics />
```

并在文件 import 区加入：

```tsx
import PushDiagnostics from "../components/PushDiagnostics"
```

注意缩进需与该 section 内既有子元素一致。

- [ ] **Step 3: 验证构建**

Run: `cd frontend; npm run build`

Expected: PASS。

- [ ] **Step 4: 本地冒烟验证**

Run: `cd frontend; npm run dev`

在浏览器打开账户页，展开"推送诊断"，确认：
- 面板能展开、逐项显示，没有白屏
- 未登录或后端未启动时，"订阅已上报后端"一行显示"无法检测"而非整个面板报错

后端需同时运行才能验证"发送测试通知"。若后端未跑，按钮应显示错误消息而不是崩溃。

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PushDiagnostics.tsx frontend/src/pages/AccountPage.tsx
git commit -m "feat(push): 新增应用内推送诊断面板

推送链路横跨六个环节，任一环断掉都表现为同一个「收不到通知」，
而部分环节只在真机、iOS 上更是只在独立模式启动时才成立，
桌面调试器覆盖不到。面板逐项显示各环状态并提供测试推送按钮，
任何一台手机打开即可定位断点。每项检查独立容错，
排障工具本身不能比被排障的对象更脆弱。"
```

---

## 最终验证

全部任务完成后执行：

- [ ] `cd frontend; npm run build` → PASS
- [ ] `cd backend; python -m pytest -q` → PASS，无既有测试被破坏
- [ ] `cd frontend; node --check public/sw.js` → PASS
- [ ] 全局搜索 `notifDeviceHint` → 零结果
- [ ] 人工核对 `frontend/src/utils/pushEnv.ts` 无 `async` / `await` / `Promise` / `fetch`
- [ ] 人工核对 `frontend/src/utils/notifications.ts` 的 `requestPermission()` 之前无新增 `await`
- [ ] 人工核对 `frontend/public/sw.js` 无任何 TypeScript 语法

留给用户的真机验证（不在本计划范围内，但这是最终确认手段）：在 Android Chrome 与
iPhone（iOS 16.4+，从主屏幕图标启动）上分别打开账户页诊断面板，各项应为绿色，
点"发送测试通知"应收到系统通知。
