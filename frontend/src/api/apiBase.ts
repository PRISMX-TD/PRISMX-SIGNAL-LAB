// API 基础地址与备用域名自动切换。
//
// 生产用 VITE_API_BASE 指向线上后端，开发留空走 Vite 代理（留空时本文件什么都不做）。
// 后端有两个入口：主域名 api.prismxsignallab.com，与备用域名 api.pmxsl.com（主域名在
// 大陆被封时用）。两者都经香港边缘节点转发到同一个后端（ops/hk-edge），后端 CORS 与
// vercel.json 的 CSP 两边都已放行，所以任何页面（网站两个域名、App 的 https://localhost）
// 连哪一个都行。
//
// 切换规则：
//   · 首选：页面从 pmxsl.com 打开 → 备用域名在前；否则主域名在前。
//   · 上次探测出来能用的那个记在 localStorage，下次启动直接用它（App 里尤其重要：
//     主域名被封后，不必每次冷启动都先撞一次墙）。
//   · 请求遇到网络层失败（连不上 / 超时，不是 HTTP 错误码）时，调用方报一次
//     reportApiFailure()：并发探测所有入口的根路径 `/`，谁先应答就切到谁。
//     同一时刻只探一次，失败后 30 秒内不重复探。
//   · API_BASE 是 `export let`：ES 模块的导出是活绑定，切换后所有 import 它的模块
//     下一次读取就是新值（REST、WebSocket 重连、遥测都不用改调用方式）。
//
// 单独成一个无依赖的小模块：clientErrorReport 在出错路径上也要用，不能拖进整个 client。
//
// API base and automatic failover to the backup domain.
//
// Prod points VITE_API_BASE at the backend; dev leaves it empty for the Vite proxy (this module
// then does nothing). The backend has two entry points: the main api.prismxsignallab.com and
// the backup api.pmxsl.com (for when the main domain is blocked in mainland China), both via the
// HK edge to the same backend (ops/hk-edge). Backend CORS and the vercel.json CSP allow both, so
// any page (either website domain, or the app's https://localhost) may use either.
//
// Rules:
//   · Preference: a page opened from pmxsl.com puts the backup first; otherwise the main first.
//   · The last base a probe found working is kept in localStorage and used on the next start
//     (matters most in the app: once the main domain is blocked, cold starts don't hit the wall
//     again each time).
//   · On a network-level failure (unreachable / timeout — not an HTTP status) callers call
//     reportApiFailure(): all entry points' `/` are probed in parallel and the first to answer
//     wins. One probe at a time, and none within 30 s of the last.
//   · API_BASE is `export let`: ES module exports are live bindings, so every importer reads
//     the new value on its next access (REST, WebSocket reconnects and telemetry need no change).
//
// A dependency-free module so clientErrorReport can use it on the error path without pulling in client.

const BACKUP_DOMAIN = 'pmxsl.com'
const BACKUP_BASE = `https://api.${BACKUP_DOMAIN}`
const STORAGE_KEY = 'prismx.apiBase'
const PROBE_TIMEOUT_MS = 6_000
const PROBE_COOLDOWN_MS = 30_000

function onBackupDomain(): boolean {
  if (typeof location === 'undefined') return false
  const host = location.hostname
  return host === BACKUP_DOMAIN || host.endsWith(`.${BACKUP_DOMAIN}`)
}

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function writeStored(base: string) {
  try {
    localStorage.setItem(STORAGE_KEY, base)
  } catch {
    // 隐私模式 / 配额满：记不住就下次再探一次，不影响本次。
    // Private mode / full quota: we just probe again next time.
  }
}

const configured = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/$/, '')

// 按优先级排好的全部入口；开发期（configured 为空）只有空串，不切换。
// All entry points in preference order; in dev (configured empty) just '' and no failover.
export const API_CANDIDATES: readonly string[] = !configured
  ? ['']
  : [...new Set(onBackupDomain() ? [BACKUP_BASE, configured] : [configured, BACKUP_BASE])]

function initialBase(): string {
  const stored = readStored()
  if (stored && API_CANDIDATES.includes(stored)) return stored
  return API_CANDIDATES[0]
}

export let API_BASE = initialBase()

let probing: Promise<void> | null = null
let lastProbeAt = -Infinity

async function probe(base: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    // 根路径返回 {"app": ..., "status": "ok"}：不查库、不鉴权，最便宜的"后端活着"信号。
    // `/` answers {"app": ..., "status": "ok"} with no DB or auth: the cheapest liveness signal.
    const res = await fetch(`${base}/`, { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return base
  } finally {
    clearTimeout(timer)
  }
}

// 第一个成功的那个；全部失败才 reject。等价于 Promise.any——它是 ES2021，项目目标是 ES2020，
// 老一些的安卓 WebView 也没有。
// The first to fulfil; rejects only if all do. Same as Promise.any, which is ES2021 (the project
// targets ES2020) and missing from older Android WebViews.
function firstFulfilled<T>(promises: Promise<T>[]): Promise<T> {
  return new Promise((resolve, reject) => {
    let pending = promises.length
    for (const p of promises) {
      p.then(resolve, () => {
        pending -= 1
        if (pending === 0) reject(new Error('all failed'))
      })
    }
  })
}

// 报告一次网络层失败，按需切换入口。返回的 Promise 在探测结束后 resolve（从不 reject），
// 调用方可以 await 它再重试，也可以不管。
// Report a network-level failure and switch entry points if needed. The promise resolves once
// probing is done (never rejects); callers may await it before retrying, or ignore it.
export function reportApiFailure(): Promise<void> {
  if (API_CANDIDATES.length < 2) return Promise.resolve()
  if (probing) return probing
  if (performance.now() - lastProbeAt < PROBE_COOLDOWN_MS) return Promise.resolve()
  lastProbeAt = performance.now()
  probing = firstFulfilled(API_CANDIDATES.map(probe))
    .then((winner) => {
      if (winner !== API_BASE && import.meta.env.DEV) console.info('[api] switching to', winner)
      API_BASE = winner
      writeStored(winner)
    })
    .catch(() => {
      // 全都连不上：多半是用户自己断网了，保持现状。
      // Nothing reachable: most likely the user is offline; keep the current base.
    })
    .finally(() => {
      probing = null
    })
  return probing
}
