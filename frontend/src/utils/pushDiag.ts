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
