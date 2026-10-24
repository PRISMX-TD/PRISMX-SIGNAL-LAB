// WS 兜底通知的「页面正开着」闸：安卓 App 切后台时不少 WebView 的 document.hidden 一直是
// false，只有 App 壳的 apppack:background 说明它在后台。以前只看 document.hidden，这条兜底在
// 它唯一要服务的场景（大陆 App 挂后台）里被挡掉。jsdom 没装：浏览器全局都是最小桩。
// The "page is open" gate of the WS fallback: on Android many WebViews keep document.hidden
// false in the background and only the shell's apppack:background says otherwise. No jsdom.
import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeDoc extends EventTarget {
  hidden = false
}

async function load(opts: { subscribed?: boolean } = {}) {
  vi.resetModules()
  const win = Object.assign(new EventTarget(), { PushManager: class {} })
  const doc = new FakeDoc()
  const showNotification = vi.fn(async () => {})
  const reg = {
    showNotification,
    pushManager: { getSubscription: vi.fn(async () => (opts.subscribed ? { endpoint: 'e1' } : null)) },
  }
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('navigator', { serviceWorker: { ready: Promise.resolve(reg) } })
  vi.stubGlobal('Notification', { permission: 'granted' })
  const mod = await import('./fallbackNotify')
  return { mod, win, doc, showNotification }
}

describe('showFallbackNotification', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shows when the app shell says background even though document.hidden is false', async () => {
    const { mod, win, showNotification } = await load()
    win.dispatchEvent(new Event('apppack:background'))
    await expect(mod.showFallbackNotification({ title: '信号', body: 'XAUUSD', url: '/app' })).resolves.toBe(true)
    expect(showNotification).toHaveBeenCalledWith('信号', expect.objectContaining({ body: 'XAUUSD' }))
  })

  it('stays quiet while the page is in the foreground', async () => {
    const { mod, win, showNotification } = await load()
    win.dispatchEvent(new Event('apppack:background'))
    win.dispatchEvent(new Event('apppack:foreground'))
    await expect(mod.showFallbackNotification({ title: '信号' })).resolves.toBe(false)
    expect(showNotification).not.toHaveBeenCalled()
  })

  it('shows when the document itself is hidden (web)', async () => {
    const { mod, doc, showNotification } = await load()
    doc.hidden = true
    await expect(mod.showFallbackNotification({ title: '信号' })).resolves.toBe(true)
    expect(showNotification).toHaveBeenCalledTimes(1)
  })

  it('does not double up when this device has a real push subscription', async () => {
    const { mod, doc, showNotification } = await load({ subscribed: true })
    doc.hidden = true
    await expect(mod.showFallbackNotification({ title: '信号' })).resolves.toBe(false)
    expect(showNotification).not.toHaveBeenCalled()
  })
})
