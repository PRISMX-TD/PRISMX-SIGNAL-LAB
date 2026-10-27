// 首屏预取：首次进入时 /bootstrap?extras=1 顺带算好其它组件各自要发的那些 GET（见 PREFETCH_PATHS），
// 按请求路径存在这里；request() 发这些 GET 之前先来取。
//
// 为什么（2026-10-11 生产压测）：几百人同时打开页面时，最慢的就是这几个首屏请求（p50 1–2 秒），
// 每个都要单独走一遍鉴权和请求开销；合进一个请求，服务器少干一大截活，组件代码一行不用改。
//
// 规矩：
//  · 只认 PREFETCH_PATHS 里的精确路径（含查询串），每份只用一次，用完即删——之后的轮询照常走网络；
//  · 绑定发起时的登录 token：换号 / 登出后旧数据一律作废，绝不把别人的数据给到当前用户；
//  · 15 秒过期；/bootstrap 还在路上时最多等 WAIT_CAP_MS，等不到就照常发请求；
//  · 任何一份缺失（后端那份失败、旧后端不认识 extras）都等于没有预取，组件照常请求。
//
// First-screen prefetch: on first entry /bootstrap?extras=1 also computes the GETs the other
// components would each make, stored here by request path; request() checks here first.
// Why (2026-10-11 production test): with hundreds opening the page at once these first-screen
// requests were the slowest (p50 1-2 s), each paying its own auth and request overhead; one
// request does far less work, and no component changes. Rules: exact paths only, each used
// once; bound to the token it was fetched with (an account switch voids it); 15 s TTL; while
// /bootstrap is in flight wait at most WAIT_CAP_MS; anything missing just means "no prefetch".

export const PREFETCH_PATHS: ReadonlySet<string> = new Set([
  '/orders',
  '/auth/me',
  '/orders/winrate',
  '/announcements/popup',
  '/notifications/feed?limit=4', // NotificationBell PANEL_MESSAGES
  '/sentiment',
  '/notifications/prefs',
  '/announcements',
  '/site/social',
  '/signals/strategy-analysis',
])

const TTL_MS = 15_000
const WAIT_CAP_MS = 6_000

interface Entry {
  data: unknown
  token: string | null
  at: number
}

const entries = new Map<string, Entry>()
let pending: Promise<void> | null = null

// 登记一次预取：extrasP 解析出 {路径: 响应}。登记是同步的——调用方在渲染阶段调用它，
// 子组件 effect 里发出的请求就一定能看到「正在预取」。
// Register a prefetch; extrasP resolves to {path: response}. Registration is synchronous, so
// requests fired from child effects after the caller's render always see it in flight.
export function beginPrefetch(extrasP: Promise<unknown>, token: string | null): void {
  const done: Promise<void> = extrasP
    .then((extras) => {
      if (!extras || typeof extras !== 'object') return
      const now = Date.now()
      for (const [path, data] of Object.entries(extras as Record<string, unknown>)) {
        if (PREFETCH_PATHS.has(path)) entries.set(path, { data, token, at: now })
      }
    })
    .catch(() => {})
    .finally(() => {
      if (pending === done) pending = null
    })
  pending = done
}

// 取一份预取（用后即删）。没有、过期或 token 对不上返回 null，调用方照常发请求。
// Take one prefetched response (consumed). null when absent, expired or for another token.
export async function takePrefetched(path: string, token: string | null): Promise<{ data: unknown } | null> {
  if (!PREFETCH_PATHS.has(path)) return null
  if (pending) {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([pending, new Promise<void>((r) => { timer = setTimeout(r, WAIT_CAP_MS) })])
    if (timer !== undefined) clearTimeout(timer)
  }
  const e = entries.get(path)
  if (!e) return null
  entries.delete(path)
  if (e.token !== token || Date.now() - e.at > TTL_MS) return null
  return { data: e.data }
}

// 测试 / 登出用：清空全部预取。/ Drop everything (tests, logout).
export function clearPrefetch(): void {
  entries.clear()
  pending = null
}
