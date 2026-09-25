// 前端错误上报：把「渲染崩了 / chunk 拉不下来 / 因此整页重载了」这三类事件发给
// 后端 /api/telemetry/client-error，后端只写日志。
//
// 为什么要有它：ErrorBoundary 以前只 console.error——线上一条数据都没有。用户
// 反馈"渲染失败要重新加载"时，我们分不清是网络（大陆拉 Vercel 的 chunk 失败）、
// 是代码（某个 undefined）、还是 App 特有的问题。这个端点是拿数据来做"要不要加
// 香港节点"那个决定的唯一途径。
//
// 三条纪律：
// 1. **绝不走 api/client.ts 的 request()**：它对 401 会清 token 并触发登出——
//    错误上报不能有让用户被登出的副作用。这里用裸 fetch + keepalive，匿名。
// 2. **绝不抛**：整个函数包在 try 里，fetch 的 rejection 也吞掉。上报路径若能
//    抛出去，就会在 ErrorBoundary 里再崩一次。
// 3. **不带任何身份**：没有 token、没有 user_id；只带错误本身、路径、UA、是否
//    App、是否在线。后端按 IP 限流、按字段截断。
//
// Client error reporting to /api/telemetry/client-error (log-only on the
// backend). Uses bare fetch — never request(), whose 401 handling logs the user
// out — never throws, and carries no identity.
// push：推送链路某一环失败（utils/pushDiag.ts 抽样上报，extra.step 标明哪一环）。
// 后端 CLIENT_ERROR_KINDS 同步认这个值，否则会被静默丢弃。
// push: a push-pipeline step failed (sampled by utils/pushDiag.ts; extra.step
// names it). The backend's CLIENT_ERROR_KINDS must list it too or it's dropped.
export type ClientErrorKind = 'render' | 'chunk' | 'chunk-reload' | 'push'

const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/$/, '')

// 与 lazyRetry 共用同一份判据：这几句是 Chromium / Safari / Firefox 对「动态
// import 的模块脚本拉不下来」的原话，以及旧 webpack 时代留下的 ChunkLoadError。
// Shared with lazyRetry: the browsers' own wording for a failed dynamic import.
// `Unable to preload` 是 Vite 预取助手对「依赖的 CSS 拉不下来」的原话——它同样是网络
// 而不是代码，漏掉它会让 lazyRetry 把一次丢包当成 bug 直接弹卡、不重试。
// `Unable to preload` is Vite's preload helper wording for a dependency CSS that
// failed to load — network, not code; without it lazyRetry treats a dropped
// packet as a bug and shows the card with no retry.
const CHUNK_ERROR_RE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading (?:CSS )?chunk|ChunkLoadError|Unable to preload/i

// 引擎太老、连 chunk 的语法都解析不了：动态 import 会以 SyntaxError 拒绝。这不是网络
// 也不是我们的 bug（重试、重载都没用），要给用户的提示是「更新浏览器 / 系统 WebView」。
// build.target 已降到 Chrome 70，正常不该再出现；留着是为了真出现时说对话。
// The engine is too old to parse the chunk: a dynamic import rejects with a
// SyntaxError. Neither network nor our bug (retry and reload can't help); the
// user needs "update your browser / system WebView". build.target is Chrome 70 so
// this should be rare now; kept so the message is right when it does happen.
const OLD_ENGINE_RE = /Unexpected token|Invalid or unexpected token|Unexpected identifier|Unexpected end of input|Unexpected string|Unexpected number|Unexpected reserved word/i

export function isOldEngineError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'SyntaxError') return true
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err)
  return OLD_ENGINE_RE.test(msg)
}

export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err)
  return CHUNK_ERROR_RE.test(msg)
}

function isNativeApp(): boolean {
  try {
    const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
    return !!cap?.isNativePlatform?.()
  } catch {
    return false
  }
}

export function reportClientError(kind: ClientErrorKind, err: unknown, extra?: Record<string, string>): void {
  try {
    const e = err instanceof Error ? err : new Error(String(err))
    const body = JSON.stringify({
      kind,
      name: e.name,
      message: e.message,
      stack: e.stack ?? '',
      path: location.pathname,
      ua: navigator.userAgent,
      app: isNativeApp(),
      online: navigator.onLine,
      lang: document.documentElement.lang,
      ...extra,
    })
    fetch(`${API_BASE}/api/telemetry/client-error`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // keepalive：ErrorBoundary 里点「重新加载」、或 lazyRetry 马上要整页重载时，
      // 普通 fetch 会随页面卸载被取消，这条数据正是最需要活着送出去的那条。
      // keepalive: the page may be about to reload; this request must survive it.
      keepalive: true,
    }).catch(() => {})
  } catch {
    // 上报本身绝不能成为新的错误源 / reporting must never become a new error
  }
}
