// 演示用的「假后端」/ a stand-in backend for the demo
//
// **只在演示构建里、且只在用户从演示面板点了「进入 App 演示」之后生效。**
// 目的只有一个：没有后端、不登录真实账号，也能看到真实的 App 外壳与信号面板，
// 从而检查节日装饰在真实界面里的样子。生产构建里 FESTIVAL_DEMO 为 false，
// main.tsx 根本不会调用这里。
// Active only in demo builds, and only after "Enter app demo" is chosen in the
// demo panel. Its single purpose is to render the real app shell and signals
// panel without a backend or a real account, so the festival layer can be
// judged in the real interface. In production FESTIVAL_DEMO is false and
// main.tsx never calls into this file.
//
// 覆盖的接口来自对 Layout / SignalsPage / AccountPage 的实际调用梳理；没列到的
// GET 一律回 404，让页面走它本来就有的错误分支（后端宕机时也是这样）。
// Coverage follows the calls Layout / SignalsPage / AccountPage actually make;
// any other GET answers 404, sending the page down the error path it already
// has for a backend outage.

export const MOCK_KEY = 'prismx_festival_mock'
export const DEMO_SIGNAL_EVENT = 'prismx-demo-signal'
export const MOCK_SIGNALS_KEY = 'prismx_festival_mock_signals'
const TOKEN_KEY = 'prismx_token'
const USER_KEY = 'prismx_user'

const DEMO_USER = {
  id: 'demo',
  email: 'demo@signal-lab.app',
  role: 'user',
  plan: 'PRO',
  planIsTrial: false,
  planExpiresAt: null,
  hasPassword: true,
  createdAt: '2026-03-14T08:21:00Z',
  mt5Accounts: [],
  gamificationVisible: false,
  leaderboardVisible: false,
  competitionsVisible: false,
  nickname: '林澈',
  needsNickname: false,
  needsPhone: false,
  nicknamePublic: false,
  leaderboardOptOut: false,
  equippedBadge: null,
  gamificationLevel: null,
  gamificationTitle: null,
  publicId: null,
  statsPublic: false,
  isAgent: false,
}

export function mockActive(): boolean {
  try {
    return localStorage.getItem(MOCK_KEY) === '1'
  } catch {
    return false
  }
}

export function enterMock() {
  localStorage.setItem(MOCK_KEY, '1')
  localStorage.setItem(TOKEN_KEY, 'festival-demo-token')
  localStorage.setItem(USER_KEY, JSON.stringify(DEMO_USER))
}

export function leaveMock() {
  localStorage.removeItem(MOCK_KEY)
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

export function signalsMode(): 'live' | 'empty' {
  try {
    return localStorage.getItem(MOCK_SIGNALS_KEY) === 'empty' ? 'empty' : 'live'
  } catch {
    return 'live'
  }
}

// ── 示例信号 / sample signals ────────────────────────────────────────────────
// 价格是示例数据，不是行情。信号有效期 10 分钟，与真实规则一致；过期后整组以
// 新的时间基准重生，演示时永远有「有效期内」的信号可看。
// Prices are sample data, not quotes. Signals live 10 minutes as in production;
// once they lapse the set regenerates on a new time base.
const TEMPLATES = [
  { symbol: 'XAUUSD', side: 'BUY', entry: 2641.2, stopLoss: 2628.5, takeProfit: 2667.8, indicator: 'EMA Pullback' },
  { symbol: 'EURUSD', side: 'SELL', entry: 1.08472, stopLoss: 1.0879, takeProfit: 1.0786, indicator: 'Range Break' },
  { symbol: 'GBPUSD', side: 'BUY', entry: 1.27034, stopLoss: 1.2671, takeProfit: 1.2769, indicator: 'SuperTrend' },
  { symbol: 'BTCUSD', side: 'SELL', entry: 63820, stopLoss: 64650, takeProfit: 62180, indicator: 'RSI Divergence' },
  { symbol: 'USDJPY', side: 'BUY', entry: 149.62, stopLoss: 149.18, takeProfit: 150.51, indicator: 'EMA Pullback' },
] as const

let base = 0
let pushed = 0

function iso(ms: number) {
  return new Date(ms).toISOString()
}

function currentSignals() {
  const now = Date.now()
  if (!base || now - base > 8 * 60_000) {
    base = now
    pushed = 0
  }
  return TEMPLATES.slice(0, 3).map((tpl, i) => {
    const created = base - (i + 1) * 70_000
    return {
      id: 'demo-' + base + '-' + i,
      ...tpl,
      status: 'ACTIVE',
      createdAt: iso(created),
      expireAt: iso(created + 10 * 60_000),
      result: 'PENDING',
      resolvedAt: null,
    }
  })
}

function nextPushedSignal() {
  const tpl = TEMPLATES[(3 + pushed++) % TEMPLATES.length]
  const now = Date.now()
  return {
    id: 'demo-push-' + now,
    ...tpl,
    status: 'ACTIVE',
    createdAt: iso(now),
    expireAt: iso(now + 10 * 60_000),
    result: 'PENDING',
    resolvedAt: null,
  }
}

const EMPTY_ANALYSIS = {
  days: 30,
  windowStart: '',
  windowEnd: '',
  lastResolvedAt: null,
  sessions: [],
  strategies: [],
  overall: {
    strategy: '',
    total: { hitTp: 0, hitSl: 0, pending: 0, stale: 0, resolved: 0, samples: 0, winRate: null, wilsonLow: null, wilsonHigh: null, avgResolveSeconds: null, weeklySignals: 0, daily: null, hourly: null },
    sessions: {},
    sides: {},
    symbols: [],
  },
}

const NOTIF_PREFS = {
  enabled: false,
  selected_categories: [],
  selected_symbols: [],
  event_types: [],
  push_window_start: null,
  push_window_end: null,
  push_window_tz: null,
}

function route(method: string, path: string): { status: number; body?: unknown } {
  if (method !== 'GET') {
    if (path.indexOf('/telemetry/') === 0) return { status: 204 }
    if (path === '/auth/prefs') return { status: 200, body: { data: {} } }
    return { status: 200, body: { ok: true } }
  }
  switch (path) {
    case '/auth/me':
      return { status: 200, body: DEMO_USER }
    case '/auth/prefs':
      return { status: 200, body: { data: {} } }
    case '/signals':
      return { status: 200, body: { signals: signalsMode() === 'empty' ? [] : currentSignals() } }
    case '/strategies/signals':
      return { status: 200, body: { signals: [] } }
    case '/orders':
      return { status: 200, body: { orders: [], total: 0 } }
    case '/bridge/accounts':
      return { status: 200, body: { accounts: [], accountLimit: null, brokerLock: null } }
    case '/trends':
      return { status: 200, body: { trends: [] } }
    case '/quotes':
      return { status: 200, body: { quotes: [] } }
    case '/symbols':
      return { status: 200, body: { symbols: ['XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY', 'BTCUSD'] } }
    case '/notifications/prefs':
      return { status: 200, body: NOTIF_PREFS }
    case '/notifications/feed':
      return { status: 200, body: { items: [], unreadCount: 0 } }
    case '/notifications/indicators':
    case '/notifications/symbols':
      return { status: 200, body: [] }
    case '/announcements':
      return { status: 200, body: { items: [], unreadCount: 0, total: 0 } }
    case '/announcements/popup':
      return { status: 200, body: null }
    case '/site/social':
      return { status: 200, body: {} }
    case '/signals/platform-strategies':
      return { status: 200, body: { items: [] } }
    case '/signals/strategy-analysis':
      return { status: 200, body: EMPTY_ANALYSIS }
  }
  return { status: 404, body: { detail: 'Not available in the festival demo' } }
}

// ── 假 WebSocket / fake socket ──────────────────────────────────────────────
// 只接管 /ws/client；其余（包括 Vite 的热更新连接）照旧走真的 WebSocket。
// 必须回 PONG，否则客户端 10 秒没收到帧就会断开重连。
// Only /ws/client is intercepted; everything else (Vite's HMR socket included)
// uses the real WebSocket. PONG replies are mandatory — the client drops and
// reconnects after 10 s without a frame.
class FakeClientSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3
  readyState = 0
  url: string
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  private timer = 0
  private onDemo: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    window.setTimeout(() => {
      this.readyState = 1
      if (this.onopen) this.onopen(new Event('open'))
    }, 60)
  }

  private emit(data: unknown) {
    if (this.readyState !== 1 || !this.onmessage) return
    this.onmessage(new MessageEvent('message', { data: JSON.stringify(data) }))
  }

  send(raw: string) {
    let msg: { type?: string } = {}
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.type === 'AUTH') {
      window.setTimeout(() => this.emit({ type: 'AUTH_OK' }), 40)
      // 演示面板的「模拟新信号到达」按钮走这里，不用等 40 秒。
      // The demo panel's "simulate a new signal" button lands here, no 40 s wait.
      this.onDemo = () => this.emit({ type: 'SIGNAL_NEW', data: nextPushedSignal() })
      window.addEventListener(DEMO_SIGNAL_EVENT, this.onDemo)
      // 「有信号」模式下每 40 秒推一条新信号，看得到新信号进场的真实效果。
      // In live mode a new signal arrives every 40 s, as it would in production.
      this.timer = window.setInterval(() => {
        if (signalsMode() === 'live') this.emit({ type: 'SIGNAL_NEW', data: nextPushedSignal() })
      }, 40_000)
    } else if (msg.type === 'PING') {
      window.setTimeout(() => this.emit({ type: 'PONG' }), 30 + Math.random() * 40)
    }
  }

  close() {
    if (this.readyState === 3) return
    this.readyState = 3
    window.clearInterval(this.timer)
    if (this.onDemo) window.removeEventListener(DEMO_SIGNAL_EVENT, this.onDemo)
    if (this.onclose) this.onclose(new CloseEvent('close'))
  }

  addEventListener() {}
  removeEventListener() {}
}

export function installMockBackend() {
  const realFetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let u: URL
    try {
      u = new URL(url, window.location.href)
    } catch {
      return realFetch(input, init)
    }
    const i = u.pathname.indexOf('/api/')
    if (i === -1) return realFetch(input, init)
    const method = ((init && init.method) || (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase()
    const { status, body } = route(method, u.pathname.slice(i + 4))
    const res =
      status === 204
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(body === undefined ? null : body), { status, headers: { 'Content-Type': 'application/json' } })
    // 轻微延迟，让骨架屏像真实网络下一样闪一下。/ a little latency so skeletons show as on a real network
    return new Promise((r) => window.setTimeout(() => r(res), 120 + Math.random() * 180))
  }

  const RealWS = window.WebSocket
  const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const s = String(url)
    if (s.indexOf('/ws/client') !== -1) return new FakeClientSocket(s)
    return new RealWS(url, protocols)
  } as unknown as typeof WebSocket
  ;(Patched as unknown as Record<string, number>).CONNECTING = 0
  ;(Patched as unknown as Record<string, number>).OPEN = 1
  ;(Patched as unknown as Record<string, number>).CLOSING = 2
  ;(Patched as unknown as Record<string, number>).CLOSED = 3
  window.WebSocket = Patched
}
