// 带重试的 React.lazy：chunk 拉不下来时先重试，再整页重载一次，最后才交给
// ErrorBoundary 弹卡。
//
// 为什么需要它：25 条路由全是 lazy(() => import(...))，chunk 从 Vercel edge 拉。
// 大陆访问 Vercel 是"能通但慢且丢包"的状态，一次 import() 失败就直接进
// ErrorBoundary——用户看到的正是那张「页面渲染时遇到错误…重新加载」卡片，而他
// 点重载多半就成了。既然重载能成，程序自己先试就是了。
//
// 三层，各管一种失败：
// ① 重试两次（500ms / 1500ms）：管网络抖动、丢包。
// ② 重试仍失败 → **整页重载一次**（按 chunk 记在 sessionStorage 里，同一会话只
//    重载一次）：管"发版后旧页面引用了已不存在的哈希 chunk"——这种情况重试多少
//    次都是 404，只有拿到新 HTML 才有救。这也是 ErrorBoundary 头注里说的那个场景。
// ③ 已经重载过还失败 → 原样抛出，ErrorBoundary 接住弹卡。到这一步是真的拉不到，
//    不该再无限重载把用户困在白屏里。
//
// 只对 chunk 加载错误重试。模块求值时自己抛的错（代码 bug）第一次就原样抛出——
// 重试一个确定性的错误只是浪费时间、还把 bug 藏起来。
//
// React.lazy with retries: two retries for flaky networks, then one full reload
// (per chunk, per session) for the stale-deploy 404 case, then rethrow so the
// ErrorBoundary shows its card. Only chunk-load errors are retried; a module that
// throws while evaluating is a bug and surfaces immediately.
import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import { isChunkLoadError, reportClientError } from './clientErrorReport'

// 三次重试，总计约 6 秒。原来是两次 / 2 秒：大陆到 Vercel 的链路丢包成串出现，2 秒内
// 连试两次多半撞在同一个坏窗口里；第三次拉开到 4 秒，才真有机会跨过去。
// Three retries, ~6s total. It used to be two within 2s; on the mainland→Vercel
// path packet loss comes in bursts, and two attempts inside 2s tend to land in
// the same bad window. The third, 4s out, is the one with a real chance.
const RETRY_DELAYS_MS = [500, 1500, 4000]
const RELOAD_FLAG_PREFIX = 'prismx.chunkReload:'
// 「同一会话只整页重载一次」改成「五分钟内只重载一次」。原来的标记一旦写下就跟着
// 会话活到标签页关闭：用户点了错误卡上的「重新加载」、或者十分钟后网络已经好了再
// 进来，chunk 再失败都直接弹卡，不再给那次本来能成的重载机会——这就是「一直渲染
// 失败」在同一会话里粘住的原因之一。五分钟一次仍然挡得住真坏了的发版把人困在重载
// 循环里（每五分钟最多一次，中间是错误卡）。
// "One reload per session" becomes "one reload per five minutes". The old flag
// lived as long as the tab: after the user pressed Reload on the card, or came
// back ten minutes later on a recovered network, a failing chunk went straight to
// the card with no second chance at the reload that would have worked — one way
// "always failing" got sticky within a session. Once per five minutes still keeps
// a genuinely broken deploy from trapping anyone in a reload loop.
const RELOAD_WINDOW_MS = 5 * 60_000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// sessionStorage 三处读写全部包 try：隐私模式 / 受限 WebView 下 getItem 都可能抛，
// 而这里正处在错误恢复路径上，再抛一次就是雪上加霜。
// All storage access is wrapped: private mode / restricted WebViews can throw on
// getItem, and this runs on the error-recovery path.
function reloadedOnce(name: string): boolean {
  try {
    const raw = sessionStorage.getItem(RELOAD_FLAG_PREFIX + name)
    if (!raw) return false
    // 旧格式 '1'（没有时间戳）按「刚刚重载过」处理 / legacy '1' counts as just reloaded
    const at = Number(raw)
    if (!Number.isFinite(at)) return true
    return Date.now() - at < RELOAD_WINDOW_MS
  } catch {
    // 读不到就当已经重载过：宁可弹卡，不可无限重载 / can't read → assume reloaded
    return true
  }
}
function markReloaded(name: string): void {
  try {
    sessionStorage.setItem(RELOAD_FLAG_PREFIX + name, String(Date.now()))
  } catch {
    /* ignore */
  }
}
function clearReloaded(name: string): void {
  try {
    sessionStorage.removeItem(RELOAD_FLAG_PREFIX + name)
  } catch {
    /* ignore */
  }
}

// 用户在错误卡上主动点「重新加载」时清掉全部标记：他明确要再试一次，这次重载之后
// 的 chunk 失败应当重新享有「重试 → 自动重载」的完整机会，而不是因为几分钟前自动重载
// 过就直接再弹卡。/ Clear every flag when the user presses Reload on the error card:
// they asked for another try, and the chunk failures after it deserve the full
// retry → auto-reload ladder again instead of the card straight away.
export function clearChunkReloadFlags(): void {
  try {
    const doomed: string[] = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i)
      if (k && k.startsWith(RELOAD_FLAG_PREFIX)) doomed.push(k)
    }
    doomed.forEach((k) => sessionStorage.removeItem(k))
  } catch {
    /* ignore */
  }
}

// 按 props 泛型（与 React.lazy 自己的签名一致），而不是约束成 ComponentType<unknown>：
// 后者会拒绝任何带 props 的页面（LegalPage 的 { doc }），tsc 直接报错。
// Generic over props, like React.lazy itself; ComponentType<unknown> rejects any
// page that takes props.
export function lazyRetry<P extends object>(
  factory: () => Promise<{ default: ComponentType<P> }>,
  name: string,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(async () => {
    let lastErr: unknown
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        const mod = await factory()
        // 成功即清标记：下一次真正的发版陈旧仍有一次重载机会
        // Clear on success so the next genuine stale deploy still gets one reload.
        clearReloaded(name)
        return mod
      } catch (err) {
        lastErr = err
        // 代码 bug，不重试 / a real bug: surface it
        if (!isChunkLoadError(err)) throw err
        if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt])
      }
    }
    if (!reloadedOnce(name)) {
      markReloaded(name)
      reportClientError('chunk-reload', lastErr, { chunk: name })
      location.reload()
      // 重载已发出：返回一个永不 resolve 的 promise，让 Suspense 继续转圈到页面
      // 卸载，而不是先闪一下错误卡再消失。
      // Reload issued: keep Suspense spinning until the page unloads.
      return new Promise<never>(() => {})
    }
    reportClientError('chunk', lastErr, { chunk: name, retries: String(RETRY_DELAYS_MS.length) })
    throw lastErr
  })
}
