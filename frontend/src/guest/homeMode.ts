// 首页给未登录访客看哪一种：preview = 带锁的仪表盘（游客预览），landing = 原落地页。
// 由后台开关决定（GET /api/site/config）。
//
// 首屏不能等这条请求太久：上一次的答案存在本地，有就立刻用（后台再刷新，留给下一次）；
// 没有（第一次来的访客，广告流量基本都是）才等，最多 CONFIG_TIMEOUT_MS，超时按落地页。
// index.html 里有一小段脚本在判定之前先把预渲染的落地页藏住（data-home-hold），免得
// 预览模式下先闪一屏落地页再变成仪表盘；判定一出就放开（releaseHomeHold）。
//
// 另外这里管首页漏斗打点：访问（每个会话每种模式记一次）、弹窗、点注册、注册成功。
// 注册成功按「最近一次从首页进来时的模式」记，7 天内有效。
//
// Which home a logged-out visitor gets: preview (the locked dashboard) or landing, decided
// by the admin switch (GET /api/site/config). The last answer is cached locally and used at
// once (refreshed in the background for next time); only first-time visitors — nearly all ad
// traffic — wait, for at most CONFIG_TIMEOUT_MS, falling back to landing. A small script in
// index.html hides the prerendered landing page until the decision (data-home-hold) so preview
// mode doesn't flash the landing page first; releaseHomeHold lifts it.
// Also the home funnel: view (once per session per mode), gate, cta, signup — the signup
// counts toward the mode of the latest home visit within 7 days.
import { API_BASE } from '../api/apiBase'
import { publicGetJson } from '../api/publicCompetition'
import { readJson, readStorage, removeStorage, writeJson, writeStorage } from '../utils/safeStorage'

export type HomeMode = 'preview' | 'landing'
export type FunnelStep = 'view' | 'gate' | 'cta' | 'signup'

const MODE_KEY = 'prismx_home_mode'
const ENTRY_KEY = 'prismx_home_entry'
const ENTRY_TTL_MS = 7 * 24 * 3600_000
const CONFIG_TIMEOUT_MS = 2500

let decided: HomeMode | null = null
let pending: Promise<HomeMode> | null = null

const isMode = (v: unknown): v is HomeMode => v === 'preview' || v === 'landing'

function fetchMode(): Promise<HomeMode> {
  return publicGetJson<{ guestPreview?: boolean }>('/site/config').then((r) => {
    const m: HomeMode = r.guestPreview ? 'preview' : 'landing'
    writeStorage(MODE_KEY, m)
    return m
  })
}

export function resolveHomeMode(): Promise<HomeMode> {
  if (decided) return Promise.resolve(decided)
  if (pending) return pending
  const cached = readStorage(MODE_KEY)
  const fresh = fetchMode()
  if (isMode(cached)) {
    fresh.catch(() => {})
    decided = cached
    return Promise.resolve(cached)
  }
  const timeout = new Promise<HomeMode>((resolve) => window.setTimeout(() => resolve('landing'), CONFIG_TIMEOUT_MS))
  pending = Promise.race([fresh, timeout])
    .catch((): HomeMode => 'landing')
    .then((m) => {
      decided = m
      return m
    })
  return pending
}

export function decidedHomeMode(): HomeMode | null {
  return decided
}

// 本地记着「预览」但开关其实已经关了（预览接口 404）：本次就地换回落地页，并改掉缓存。
// Cached "preview" but the switch is off (the preview endpoint 404s): fall back now and fix the cache.
export function demoteToLanding(): void {
  decided = 'landing'
  writeStorage(MODE_KEY, 'landing')
}

export function releaseHomeHold(): void {
  if (typeof document !== 'undefined') document.documentElement.removeAttribute('data-home-hold')
}

// ── 漏斗 / funnel ──

export function trackHome(mode: HomeMode, step: FunnelStep): void {
  try {
    void fetch(`${API_BASE}/api/public/preview/event`, {
      method: 'POST',
      keepalive: true,
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, step }),
    }).catch(() => {})
  } catch {
    /* 打点绝不能挡住访客 / a ping must never block the visitor */
  }
}

export function markHomeView(mode: HomeMode): void {
  writeJson(ENTRY_KEY, { mode, at: Date.now() })
  const flag = `prismx_home_viewed_${mode}`
  if (readStorage(flag, 'session')) return
  writeStorage(flag, '1', 'session')
  trackHome(mode, 'view')
}

// 注册成功后调用：按最近一次首页访问的模式记一次 signup，然后清掉，免得重复计。
// Call after a successful sign-up: counts once toward the latest home visit's mode, then clears.
export function trackSignupFromHome(): void {
  const entry = readJson<{ mode?: unknown; at?: unknown } | null>(ENTRY_KEY, null)
  removeStorage(ENTRY_KEY)
  if (!entry || !isMode(entry.mode) || typeof entry.at !== 'number') return
  if (Date.now() - entry.at > ENTRY_TTL_MS) return
  trackHome(entry.mode, 'signup')
}
