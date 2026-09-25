// 浏览器空闲时执行：requestIdleCallback 优先，没有它（Safari、老 WebView）或迟迟
// 等不到空闲时由 setTimeout 兜底。返回取消函数。
// 用在「不该和首屏抢主线程 / 网络，但也不能无限期推迟」的事情上：Service Worker
// 注册（main.tsx）、登录后预取常用页面 chunk（App.tsx）。
// Run when the browser is idle: requestIdleCallback when available, otherwise
// (Safari, old WebViews) or when idle never comes, a setTimeout fallback. Returns
// a cancel function. For work that must not compete with first paint but also
// must not be postponed forever: SW registration (main.tsx) and prefetching the
// main tab chunks after login (App.tsx).
export function onIdle(fn: () => void, timeoutMs = 2000): () => void {
  let done = false
  const run = () => {
    if (done) return
    done = true
    fn()
  }
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  let idleId: number | null = null
  if (typeof w.requestIdleCallback === 'function') {
    idleId = w.requestIdleCallback(run, { timeout: timeoutMs })
  }
  // 兜底：rIC 的 timeout 在个别内核上不可靠，自己再挂一个稍晚的定时器。
  // Fallback: rIC's timeout is unreliable on some engines, so a slightly later timer backs it up.
  const timer = window.setTimeout(run, idleId === null ? Math.min(timeoutMs, 1500) : timeoutMs + 500)
  return () => {
    done = true
    window.clearTimeout(timer)
    if (idleId !== null && typeof w.cancelIdleCallback === 'function') w.cancelIdleCallback(idleId)
  }
}

// 省流量模式或 2G：别替用户预取任何东西。/ Save-Data or 2G: prefetch nothing.
export function shouldSkipPrefetch(): boolean {
  try {
    const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
    if (!c) return false
    return !!c.saveData || c.effectiveType === '2g' || c.effectiveType === 'slow-2g'
  } catch {
    return false
  }
}
