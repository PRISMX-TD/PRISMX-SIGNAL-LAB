// 节日状态 / festival state
//
// 整个节日层只从这里取三件事：今天是哪个节日、问候是否已被关掉、要不要动。
// 组件各取所需，互不知道对方存在。
// The whole festival layer reads three things from here: which festival is on,
// whether its greeting was dismissed, and whether to animate. Components take
// what they need and never know about each other.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { detect, newYearNumber, parseYmd, windowId, ymd, type FestivalKey, type FestivalWindow } from './calendar'
import { readJson, readStorage, removeStorage, writeJson, writeStorage } from '../utils/safeStorage'
import { loadFestivalHeavy, type FestivalHeavy } from './load'

// 三个键都是**设备偏好**，与账号无关，已加进 auth.tsx 的登出保留名单。
// All three keys are device preferences, not account data, and are on the
// logout keep-list in auth.tsx.
export const FESTIVAL_OFF_KEY = 'prismx_festival_off'
export const FESTIVAL_DISMISSED_KEY = 'prismx_festival_dismissed'
export const FESTIVAL_DEMO_KEY = 'prismx_festival_demo'

// 演示开关：本地开发与演示分支打开，生产构建里整段预览逻辑不生效。
// Demo switch: on in dev and on the demo branch; inert in production builds.
export const FESTIVAL_DEMO = import.meta.env.DEV || import.meta.env.VITE_FESTIVAL_DEMO === '1'
// 全站总开关：构建时设 VITE_FESTIVAL=off，所有节日一律不出现（不用改代码、不用删文件）。
// Site-wide kill switch: build with VITE_FESTIVAL=off and no festival ever shows
// (no code change, no files removed).
export const FESTIVAL_DISABLED = import.meta.env.VITE_FESTIVAL === 'off'

export type DemoMode = 'auto' | 'none' | FestivalKey

export interface DemoState {
  mode: DemoMode
  date: string | null // 'YYYY-MM-DD'，null = 真实今天 / real today
  reduce: boolean | null // null = 跟随系统 / follow the OS
}

const DEMO_DEFAULT: DemoState = { mode: 'auto', date: null, reduce: null }

interface FestivalContextValue {
  // 当前生效的节日；关闭总开关或不在窗口内时为 null。
  // The festival in effect; null when switched off or outside every window.
  festival: FestivalKey | null
  window: FestivalWindow | null
  today: Date
  newYear: number
  greetingOpen: boolean
  dismissGreeting: () => void
  enabled: boolean
  setEnabled: (on: boolean) => void
  reducedMotion: boolean
  // 每次递增都会让所有入场动画重放一次（演示面板的「重放」按钮用）。
  // Bumping it replays every entrance animation (the demo panel's Replay).
  replay: number
  demo: DemoState
  setDemo: (patch: Partial<DemoState>) => void
  bumpReplay: () => void
}

const Ctx = createContext<FestivalContextValue | null>(null)

// 节日重包加载过之后留个引用：节日结束（或用户关掉装饰）时要用它把按钮小饰的变量清掉。
// Kept once the heavy chunk has loaded: when the festival ends (or decorations
// are switched off) it clears the button-charm variables.
let charmModule: FestivalHeavy | null = null

function readDemo(): DemoState {
  if (!FESTIVAL_DEMO) return DEMO_DEFAULT
  const stored = readJson<DemoState>(FESTIVAL_DEMO_KEY, DEMO_DEFAULT)
  // 地址栏参数优先，便于直接分享某个节日的链接：?festival=halloween&festivalDate=2026-10-31
  // URL params win, so a specific preview can be shared as a link.
  try {
    const qs = new URLSearchParams(window.location.search)
    const f = qs.get('festival')
    const d = qs.get('festivalDate')
    const next = { ...DEMO_DEFAULT, ...stored }
    if (f) next.mode = f as DemoMode
    if (d && parseYmd(d)) next.date = d
    return next
  } catch {
    return { ...DEMO_DEFAULT, ...stored }
  }
}

function useSystemReducedMotion() {
  const [reduced, setReduced] = useState(() => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      return false
    }
  })
  useEffect(() => {
    let mq: MediaQueryList
    try {
      mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    } catch {
      return
    }
    const on = () => setReduced(mq.matches)
    // addListener 是 Safari 13 及更早版本唯一认识的写法。
    // addListener is the only form Safari 13 and earlier understand.
    if (mq.addEventListener) mq.addEventListener('change', on)
    else mq.addListener(on)
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', on)
      else mq.removeListener(on)
    }
  }, [])
  return reduced
}

// 跨过午夜要自己翻篇：App 常驻后台，用户可能连开好几天。
// Roll over at midnight by itself; the app lives in the background for days.
function useToday(override: string | null) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (override) return
    const id = window.setInterval(() => {
      const d = new Date()
      setNow((prev) => (ymd(prev) === ymd(d) ? prev : d))
    }, 60_000)
    return () => window.clearInterval(id)
  }, [override])
  return override ? (parseYmd(override) as Date) : now
}

export function FestivalProvider({ children }: { children: ReactNode }) {
  const [demo, setDemoState] = useState<DemoState>(readDemo)
  const [enabled, setEnabledState] = useState(() => readStorage(FESTIVAL_OFF_KEY) !== '1')
  const [dismissed, setDismissed] = useState(() => readStorage(FESTIVAL_DISMISSED_KEY))
  const [replay, setReplay] = useState(0)
  const systemReduced = useSystemReducedMotion()
  const today = useToday(demo.date)

  const win = useMemo<FestivalWindow | null>(() => {
    if (FESTIVAL_DISABLED || !enabled) return null
    const mode = FESTIVAL_DEMO ? demo.mode : 'auto'
    if (mode === 'auto') return detect(today)
    if (mode === 'none') return null
    // 手动预览没有真实窗口，给一个以今天为界的占位，关闭记录照常按它记。
    // A manual preview has no real window; a placeholder keyed on today keeps
    // dismissal working the same way.
    return { key: mode, start: 'preview-' + ymd(today), end: ymd(today) }
  }, [enabled, demo.mode, today])

  const setEnabled = useCallback((on: boolean) => {
    setEnabledState(on)
    if (on) removeStorage(FESTIVAL_OFF_KEY)
    else writeStorage(FESTIVAL_OFF_KEY, '1')
  }, [])

  const dismissGreeting = useCallback(() => {
    if (!win) return
    const id = windowId(win)
    setDismissed(id)
    writeStorage(FESTIVAL_DISMISSED_KEY, id)
  }, [win])

  const setDemo = useCallback((patch: Partial<DemoState>) => {
    setDemoState((prev) => {
      const next = { ...prev, ...patch }
      writeJson(FESTIVAL_DEMO_KEY, next)
      return next
    })
    // 换节日时把「已关闭」清掉，否则切来切去问候都看不到了。
    // Clear the dismissal on every switch, or the greeting stays hidden while
    // flipping between festivals.
    if (patch.mode !== undefined || patch.date !== undefined) {
      setDismissed(null)
      removeStorage(FESTIVAL_DISMISSED_KEY)
    }
    setReplay((n) => n + 1)
  }, [])

  const bumpReplay = useCallback(() => {
    setDismissed(null)
    removeStorage(FESTIVAL_DISMISSED_KEY)
    setReplay((n) => n + 1)
  }, [])

  const reducedMotion = demo.reduce === null ? systemReduced : demo.reduce

  // 节日键也写到 <html> 上，CSS 可以按 [data-festival] 取色；按钮小饰的图也一并写成变量。
  // Mirror the key onto <html> so CSS can pick colours by [data-festival]; the
  // button charm's artwork goes on as variables alongside it.
  // 按钮小饰（charm.ts / charm.css）和 festival.css 都在节日重包里（见 heavy.ts）：
  // 在节日窗口里才加载，这里顺带预热，让各处轻壳的 lazy() 拿到的是同一个已在路上的请求。
  // festival.css 里还有 [data-festival] 下的全站规则，所以只要节日生效就要加载，
  // 不能指望某个装饰组件恰好出现在当前页面上。
  // The button charm (charm.ts / charm.css) and festival.css live in the heavy
  // chunk (see heavy.ts), loaded only inside a festival window; this also warms
  // it so every shell's lazy() joins the request already in flight. festival.css
  // carries site-wide [data-festival] rules, so it must load whenever a festival
  // is on, not only when some decoration happens to be on the current page.
  useEffect(() => {
    const root = document.documentElement
    if (win) root.setAttribute('data-festival', win.key)
    else root.removeAttribute('data-festival')
    if (!win) {
      if (charmModule) charmModule.applyCharm(null)
      return
    }
    let alive = true
    let stopGuard: (() => void) | null = null
    loadFestivalHeavy()
      .then((m) => {
        charmModule = m
        if (!alive) return
        m.applyCharm(win.key)
        stopGuard = m.startCharmGuard()
      })
      // 重包拉不下来：没有按钮小饰，其余照常。/ chunk unavailable: no button charm, nothing else affected
      .catch(() => {})
    return () => {
      alive = false
      if (stopGuard) stopGuard()
    }
  }, [win])

  const value = useMemo<FestivalContextValue>(
    () => ({
      festival: win ? win.key : null,
      window: win,
      today,
      newYear: newYearNumber(today),
      greetingOpen: !!win && dismissed !== windowId(win),
      dismissGreeting,
      enabled,
      setEnabled,
      reducedMotion,
      replay,
      demo,
      setDemo,
      bumpReplay,
    }),
    [win, today, dismissed, dismissGreeting, enabled, setEnabled, reducedMotion, replay, demo, setDemo, bumpReplay]
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useFestival(): FestivalContextValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useFestival must be used inside <FestivalProvider>')
  return v
}

// 给 Logo 这类到处都在用、可能出现在 Provider 之外（如预渲染的错误页）的组件：
// 取不到就当没有节日，不抛错。
// For widely used pieces like Logo that may render outside the provider (e.g.
// a prerendered error page): no provider simply means no festival.
export function useFestivalOptional(): FestivalContextValue | null {
  return useContext(Ctx)
}
