// useClientSocket 的连接层行为：握手超时（open 10 秒 / AUTH_OK 再 5 秒）、关闭码 1012 的重启节奏、
// 后台心跳降频。jsdom 未安装，react 换成最小桩（useEffect 立即收集、useRef/useState 极简），
// window / document / WebSocket 用桩。
// Connection-layer behaviour of useClientSocket: handshake deadlines, the close-code-1012 restart
// pace, and the slowed background heartbeat. jsdom isn't installed, so react is replaced by a
// minimal stub and window / document / WebSocket are faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const effects: Array<() => void | (() => void)> = []
vi.mock('react', () => ({
  useEffect: (fn: () => void | (() => void)) => {
    effects.push(fn)
  },
  useRef: (v: unknown) => ({ current: v }),
  useState: (v: unknown) => [v, () => {}],
}))
const reportApiFailure = vi.fn(() => Promise.resolve())
vi.mock('../api/apiBase', () => ({ reportApiFailure: () => reportApiFailure() }))
vi.mock('../api/client', () => ({ getToken: () => 'tok', API_BASE: 'https://api.example.com' }))

class FakeDoc extends EventTarget {
  hidden = false
}

class FakeWS {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  static instances: FakeWS[] = []
  readyState = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  url: string
  constructor(url: string) {
    this.url = url
    FakeWS.instances.push(this)
  }
  send(s: string) {
    this.sent.push(s)
  }
  close() {
    this.readyState = 3
  }
  // 测试辅助 / test helpers
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  msg(o: unknown) {
    this.onmessage?.({ data: JSON.stringify(o) })
  }
  drop(code: number) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

let doc: FakeDoc

async function start() {
  vi.resetModules()
  effects.length = 0
  FakeWS.instances = []
  const win = new EventTarget() as EventTarget & {
    setTimeout: typeof setTimeout
    clearTimeout: typeof clearTimeout
    setInterval: typeof setInterval
    clearInterval: typeof clearInterval
  }
  win.setTimeout = ((...a: Parameters<typeof setTimeout>) => setTimeout(...a)) as typeof setTimeout
  win.clearTimeout = ((id: Parameters<typeof clearTimeout>[0]) => clearTimeout(id)) as typeof clearTimeout
  win.setInterval = ((...a: Parameters<typeof setInterval>) => setInterval(...a)) as typeof setInterval
  win.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => clearInterval(id)) as typeof clearInterval
  doc = new FakeDoc()
  vi.stubGlobal('window', win)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('WebSocket', FakeWS)
  const mod = await import('./useClientSocket')
  mod.useClientSocket(() => {})
  const cleanups = effects.map((e) => e())
  return { mod, stop: () => cleanups.forEach((c) => typeof c === 'function' && c()) }
}

describe('useClientSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] })
    reportApiFailure.mockClear()
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('onopen 永不触发：10 秒后摘掉连接、reportApiFailure，再按退避重连', async () => {
    const { stop } = await start()
    expect(FakeWS.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(9_900)
    expect(reportApiFailure).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(reportApiFailure).toHaveBeenCalledTimes(1)
    expect(FakeWS.instances[0].onclose).toBeNull() // 回调已摘掉 / callbacks detached
    // 首次退避约 300ms（Math.random=0.5）/ first backoff ~300ms
    await vi.advanceTimersByTimeAsync(400)
    expect(FakeWS.instances).toHaveLength(2)
    stop()
  })

  it('onopen 之后 5 秒仍没 AUTH_OK 也判超时', async () => {
    const { stop } = await start()
    await vi.advanceTimersByTimeAsync(1_000)
    FakeWS.instances[0].open()
    await vi.advanceTimersByTimeAsync(4_900)
    expect(reportApiFailure).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(200)
    expect(reportApiFailure).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(400)
    expect(FakeWS.instances).toHaveLength(2)
    stop()
  })

  it('AUTH_OK 到达后握手计时器被清掉，不会误判', async () => {
    const { stop } = await start()
    const ws = FakeWS.instances[0]
    ws.open()
    ws.msg({ type: 'AUTH_OK' })
    ws.msg({ type: 'PONG' }) // 回复连上时的那帧 PING / answer the on-connect PING
    // 心跳会发 PING，回一帧 PONG 让连接保持「活着」/ answer PINGs so the socket stays alive
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(5_000)
      ws.msg({ type: 'PONG' })
    }
    expect(reportApiFailure).not.toHaveBeenCalled()
    expect(FakeWS.instances).toHaveLength(1)
    stop()
  })

  it('关闭码 1012：不当成入口被封（不探测），首次约 1.5 秒后重连', async () => {
    const { stop } = await start()
    const ws = FakeWS.instances[0]
    ws.open()
    ws.drop(1012) // 未鉴权就被关，但是服务端重启 / closed before auth, but a server restart
    expect(reportApiFailure).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_400)
    expect(FakeWS.instances).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(FakeWS.instances).toHaveLength(2)
    // 重启窗口内接着失败：固定约 2 秒、不翻倍、仍不探测 / next failure: flat ~2s, still no probe
    FakeWS.instances[1].drop(1006)
    await vi.advanceTimersByTimeAsync(1_900)
    expect(FakeWS.instances).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(200)
    expect(FakeWS.instances).toHaveLength(3)
    expect(reportApiFailure).not.toHaveBeenCalled()
    stop()
  })

  it('关闭码 1006 不是重启：照旧探测，首次约 300ms 重连', async () => {
    const { stop } = await start()
    const ws = FakeWS.instances[0]
    ws.open()
    ws.drop(1006)
    expect(reportApiFailure).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(400)
    expect(FakeWS.instances).toHaveLength(2)
    stop()
  })

  it('App 在后台：心跳降到 60 秒一帧，且 PING 不带 rtt/jit', async () => {
    const { stop } = await start()
    const ws = FakeWS.instances[0]
    ws.open()
    ws.msg({ type: 'AUTH_OK' })
    const pings = () => ws.sent.filter((s) => JSON.parse(s).type === 'PING')
    expect(pings()).toHaveLength(1) // 连上立刻测一次 / probed on connect
    ws.msg({ type: 'PONG' })
    doc.hidden = true
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(5_000)
      ws.msg({ type: 'PONG' })
    }
    expect(pings()).toHaveLength(1) // 50 秒内没有新 PING / no new PING within 50s
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(5_000)
      ws.msg({ type: 'PONG' })
    }
    const all = pings().map((s) => JSON.parse(s))
    expect(all).toHaveLength(2)
    expect(all[1].bg).toBe(true)
    expect(all[1].rtt).toBeUndefined()
    stop()
  })
})
