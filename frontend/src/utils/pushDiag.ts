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

import { reportClientError } from "./clientErrorReport"

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
  // 生产环境才上报：开发时满屏的故意失败不该进线上日志。整段兜住——诊断记录绝不能因为
  // 上报出错而改变调用方的控制流。
  // Report only in production; never let reporting alter the caller's control flow.
  if (!entry.ok && import.meta.env.PROD) {
    try {
      maybeReport(step, entry.error ?? "", entry.at, _rand)
    } catch {
      /* 上报不能成为新的错误源 / reporting must never become a new error */
    }
  }
}

// ---- 失败抽样上报 / sampled failure reporting ----
//
// 诊断格子只在内存里：用户不打开诊断面板、不截图，线上就一条数据都没有——而推送收不到
// 恰恰是「用户只会说收不到」的那类故障。这里把失败抽样发给已有的 /api/telemetry/client-error
// （kind=push，extra.step 标明哪一环）。三道闸：
//   1. 同一环每个会话（本页生命周期）只做一次上报决定——抽样没中也算决定过，否则一环反复
//      失败最终必然会被抽中，抽样率形同虚设；
//   2. 全局限频：两次上报至少隔 REPORT_MIN_GAP_MS，每会话最多 REPORT_MAX_PER_SESSION 条；
//   3. 抽样率 REPORT_SAMPLE_RATE。
// **绝不上报 endpoint、p256dh/auth 密钥、token**：消息先过 redactDiagMessage——URL 整段抹掉
// （推送 endpoint 就是一条 URL，本身即凭据）、key=value 形式的敏感字段抹值、JWT 与 ≥20 位
// 含数字的 base64/base64url 串一律抹掉（密钥、订阅 id 都长这样），最后截断。上报失败绝不抛（reportClientError
// 自己兜底）。
//
// Diagnostics live only in memory, so without the panel open there is zero field
// data. Failures are sampled to /api/telemetry/client-error (kind=push, extra.step).
// Gates: one decision per step per session (a miss counts as decided), a global
// minimum gap and per-session cap, and a sample rate. Endpoints, keys and tokens are
// never sent: URLs, sensitive key=value pairs, JWTs and ≥20-char base64(url) runs are
// redacted before sending.
export const REPORT_SAMPLE_RATE = 0.5
export const REPORT_MAX_PER_SESSION = 3
export const REPORT_MIN_GAP_MS = 60_000

const _decided = new Set<PushDiagStep>()
let _reportCount = 0
let _lastReportAt = Number.NEGATIVE_INFINITY

/** 抹掉消息里可能出现的 endpoint / 密钥 / token。/ Redact endpoints, keys and tokens. */
export function redactDiagMessage(msg: string): string {
  return msg
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, "<url>")
    // JWT（三段 base64url，首段总是 eyJ 开头）与 Bearer 头先抹，再做 key=value——否则
    // "Authorization: Bearer xxx" 只会抹掉 "Bearer" 这个词本身。
    // JWTs and Bearer headers first; otherwise key=value would only eat the word "Bearer".
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){0,2}/g, "<redacted>")
    .replace(/\bBearer\s+\S+/gi, "Bearer <redacted>")
    .replace(
      /\b(endpoint|p256dh|auth|keys?|token|access_token|refresh_token|authorization|vapid[a-z_]*)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      "$1$2<redacted>",
    )
    // ≥20 位且含数字的 base64/base64url 串（密钥、订阅 id 都是这个形状）。要求含数字是为了
    // 放过 ServiceWorkerRegistration 这类长 API 名——它们正是诊断要看的内容。
    // ≥20-char base64(url) runs containing a digit (keys, subscription ids). The digit
    // requirement spares long API names like ServiceWorkerRegistration.
    .replace(/(?=[A-Za-z0-9_\-+/]*\d)[A-Za-z0-9_\-+/]{20,}={0,2}/g, "<redacted>")
    .slice(0, 300)
}

function maybeReport(step: PushDiagStep, message: string, now: number, rand: () => number): void {
  if (_decided.has(step)) return
  if (_reportCount >= REPORT_MAX_PER_SESSION) return
  // 限频挡下的不算「决定过」：过一会儿这一环再失败，还有机会被报。
  // A rate-limited attempt isn't a decision: a later failure of this step may still report.
  if (now - _lastReportAt < REPORT_MIN_GAP_MS) return
  _decided.add(step)
  if (rand() >= REPORT_SAMPLE_RATE) return
  _reportCount++
  _lastReportAt = now
  const e = new Error(redactDiagMessage(message))
  e.name = "PushDiag"
  // 调用栈只会指向本文件，没有信息量；清空省得后端存一份噪音。
  // The stack would only point at this file; drop it.
  e.stack = ""
  reportClientError("push", e, { step })
}

/** 仅测试用：重置上报闸门。/ Test-only: reset the reporting gates. */
export function _resetDiagReportingForTest(): void {
  _decided.clear()
  _reportCount = 0
  _lastReportAt = Number.NEGATIVE_INFINITY
  _diag.clear()
}

let _rand: () => number = Math.random
/** 仅测试用：注入随机数。/ Test-only: inject the sampler. */
export function _setRandForTest(fn: () => number): void {
  _rand = fn
}

/** 读取快照副本，避免调用方改动内部状态。/ Snapshot copy so callers can't mutate internals. */
export function getPushDiag(): Map<PushDiagStep, PushDiagEntry> {
  return new Map(_diag)
}
