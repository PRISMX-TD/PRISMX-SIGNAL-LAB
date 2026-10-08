// 用户偏好云端同步 / User preferences cloud sync
// 登录后从后端加载偏好, 改动时按命名空间防抖落库, localStorage 作为离线兜底缓存。
// After login, load prefs from backend; debounced per-namespace PUT on change;
// localStorage as offline cache.
import { createContext, useContext, useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from 'react'
import { useAuth } from './auth'
import { userApi } from '../api/client'
import { setLanguage, storedLang, storedLangAt } from '../i18n'
import { cloudLangWins, localLangNewer, readCloudLang } from './cloudLang'
import { langFromPath } from '../seo/meta'
import { readJson, writeJson } from '../utils/safeStorage'

const PREFS_CACHE_KEY = 'prismx_prefs'

// 云端偏好里的界面语言落到本机：首屏加载与其它设备经 WS 推来时共用这一条。
// 走 setLanguage（写 prismx_lang + 更新 <html lang>，且「最后一次要的语言」生效），
// 不再直接 i18n.changeLanguage——那样 <html lang> 会停在旧语言。
// 公开页（含 /en 前缀）语言由 URL 决定，云端偏好不得反向覆盖，否则已登录用户打开
// /en/faq 会在偏好到达的瞬间被切回中文。
// Apply the cloud prefs' UI language locally; shared by the initial load and WS pushes from
// other devices. Goes through setLanguage (writes prismx_lang, updates <html lang>, last request
// wins) instead of a bare i18n.changeLanguage, which left <html lang> on the old language.
// Public pages (incl. the /en prefix) are URL-driven and cloud prefs must not override them,
// or a signed-in user opening /en/faq flips back to Chinese the moment prefs arrive.
function applyCloudLanguage(doc: Record<string, unknown>, pathname: string): void {
  if (langFromPath(pathname) !== null) return
  // 只有云端那份比本机新才覆盖（规则见 store/cloudLang.ts）
  // Only a newer cloud value overrides the device (rule in store/cloudLang.ts)
  const cloud = readCloudLang(doc)
  if (cloud && cloudLangWins(cloud, storedLang(), storedLangAt())) setLanguage(cloud.lang, cloud.at)
}

interface PrefsContextValue {
  /** 原始偏好文档 / raw prefs document */
  prefs: Record<string, unknown>
  /** 是否已从云端加载完成 / whether cloud prefs have been loaded */
  loaded: boolean
  /** 按命名空间 + key 读取偏好值 / read a pref value by namespace + key */
  getPref: <T>(ns: string, key: string, fallback: T) => T
  /** 写入偏好值（乐观更新 + 按命名空间防抖落库）/ write a pref value (optimistic + debounced per-namespace save) */
  setPref: (ns: string, key: string, value: unknown) => void
  /** 应用来自其它设备的远端偏好（WS 推送），不触发回存 / apply remote prefs pushed via WS, without saving back */
  applyRemotePrefs: (data: Record<string, unknown>) => void
}

const PrefsContext = createContext<PrefsContextValue | null>(null)

export function PrefsProvider({ children }: { children: ReactNode }) {
  const { user, isAuthed } = useAuth()
  const [prefs, setPrefsState] = useState<Record<string, unknown>>(() =>
    readJson<Record<string, unknown>>(PREFS_CACHE_KEY, {}),
  )
  const [loaded, setLoaded] = useState(false)
  // 按命名空间各自防抖 + 记录各自上次成功落库的数据，避免重复保存未变化的
  // 数据。此前是单一全局字段整份比对/整份落库——两台设备同时改不同命名
  // 空间时，后保存的那次会用它本地那份（可能还没收到对方 WS 推来的最新值）
  // 整个覆盖掉，先保存的改动就丢了。按命名空间拆开后，改 A 空间不会碰到
  // B 空间的保存状态。
  // Per-namespace debounce timers + per-namespace last-saved snapshots, to
  // skip re-saving unchanged data. This used to be a single global field
  // compared/saved as one whole document — two devices changing different
  // namespaces at nearly the same time would have the later PUT overwrite
  // everything with its own (possibly stale) local copy, silently dropping
  // the earlier change. Splitting bookkeeping per namespace means editing
  // namespace A never touches namespace B's save state.
  const saveTimers = useRef<Record<string, number>>({})
  const lastSavedByNs = useRef<Record<string, string>>({})
  // 还在防抖里没发出去的数据，退到后台时立即发（见下方 flushPending）
  // Data still waiting out its debounce; sent at once when the app is backgrounded
  const pendingByNs = useRef<Record<string, Record<string, unknown>>>({})
  // 未登录不上云：登录页 / 公开页上的 LanguageToggle 也会 setPref，而这时没有 token，
  // PUT /prefs 必然 401——白发一次请求，且旧版 client.ts 会因此跑一遍登出清理，把注册前
  // 采集的比赛意图一起清掉。本地状态与缓存照写；登录后云端那份到达时整份替换。
  // 用 ref：saveToCloud / sendNow 是稳定的 useCallback，不随登录态换身份。
  // No cloud saves while logged out: the LanguageToggle on login / public pages calls setPref
  // with no token, so PUT /prefs can only 401 — a wasted request that, in the old client.ts,
  // also ran the logout teardown and wiped the pre-signup competition intent. Local state and
  // cache are still written; the cloud copy replaces them after sign-in. A ref keeps
  // saveToCloud / sendNow stable.
  const isAuthedRef = useRef(isAuthed)
  isAuthedRef.current = isAuthed

  // 登录后从云端加载偏好 / load prefs from cloud after login
  useEffect(() => {
    if (!isAuthed) {
      setPrefsState({})
      setLoaded(false)
      lastSavedByNs.current = {}
      // 登出时丢掉还在防抖里的保存：它们属于上一个会话，此刻已无 token 可用。
      // Drop debounced saves on logout: they belong to the previous session and have no token.
      for (const id of Object.values(saveTimers.current)) window.clearTimeout(id)
      saveTimers.current = {}
      pendingByNs.current = {}
      return
    }
    setLoaded(false)
    // alive 守卫：切换账号（登出再登录另一个人）时，上一个账号的 getPrefs 响应
    // 可能后到，把新账号的偏好整份覆盖掉**并写进 localStorage 缓存**——共享设备
    // 上这正是 auth.tsx 那段"登出清干净"要防的事，从另一个门溜了进来。
    // The alive guard: when switching accounts (sign out, sign in as someone
    // else), the previous account's getPrefs response can land afterwards and
    // overwrite the new account's prefs *and its localStorage cache* — on a
    // shared device that is precisely what auth.tsx's logout teardown exists to
    // prevent, slipping in through another door.
    let alive = true
    userApi.getPrefs()
      .then((res) => {
        if (!alive) return
        const data = (res.data ?? {}) as Record<string, unknown>
        setPrefsState(data)
        const nextLastSaved: Record<string, string> = {}
        for (const [ns, nsData] of Object.entries(data)) {
          nextLastSaved[ns] = JSON.stringify(nsData)
        }
        lastSavedByNs.current = nextLastSaved
        writeJson(PREFS_CACHE_KEY, data)
        // 同步云端语言偏好（公开页除外，见 applyCloudLanguage）
        // Sync the cloud language preference (not on public pages, see applyCloudLanguage)
        applyCloudLanguage(data, window.location.pathname)
      })
      .catch(() => {
        // 云端加载失败, 继续用 localStorage 缓存 / fallback to cached localStorage
      })
      .finally(() => {
        if (alive) setLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [isAuthed, user?.id])

  // 按命名空间防抖落库：只 PUT 这一个命名空间的数据，服务端与已存的其它
  // 命名空间合并（不再整份覆盖），见 client.ts / 后端 account.py 的说明。
  // Debounced per-namespace PUT: only this namespace's data is sent; the
  // server merges it into the stored document instead of overwriting the
  // whole thing — see client.ts / the backend's account.py.
  const sendNow = useCallback((ns: string) => {
    const timers = saveTimers.current
    if (timers[ns]) window.clearTimeout(timers[ns])
    delete timers[ns]
    const nsData = pendingByNs.current[ns]
    delete pendingByNs.current[ns]
    if (!nsData || !isAuthedRef.current) return
    const json = JSON.stringify(nsData)
    userApi.putPrefs(ns, nsData)
      .then(() => { lastSavedByNs.current[ns] = json })
      .catch(() => { /* 静默失败, 下次改动时重试 / silent fail, retry next change */ })
  }, [])

  const saveToCloud = useCallback((ns: string, nsData: Record<string, unknown>) => {
    if (!isAuthedRef.current) return
    const json = JSON.stringify(nsData)
    if (json === lastSavedByNs.current[ns]) return
    const timers = saveTimers.current
    if (timers[ns]) window.clearTimeout(timers[ns])
    pendingByNs.current[ns] = nsData
    timers[ns] = window.setTimeout(() => sendNow(ns), 500)
  }, [sendNow])

  // 退到后台 / 页面要被收走时，把还在防抖里的保存立刻发出去。iOS PWA 切到后台后
  // 很快就被冻结或杀掉，500ms 的定时器根本等不到——切完语言马上上划退出，云端就
  // 留着旧值。
  // Send any debounced saves right away when the app is backgrounded or the page is
  // going away. An iOS PWA is frozen or killed soon after backgrounding and a 500ms
  // timer never gets to fire — switch language, swipe out, and the cloud keeps the
  // old value.
  useEffect(() => {
    const flushPending = () => {
      for (const ns of Object.keys(pendingByNs.current)) sendNow(ns)
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushPending() }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flushPending)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flushPending)
      // 清理所有命名空间的防抖定时器 / clear every namespace's debounce timer on unmount
      for (const id of Object.values(saveTimers.current)) window.clearTimeout(id)
    }
  }, [sendNow])

  const getPref = useCallback(<T,>(ns: string, key: string, fallback: T): T => {
    const nsData = prefs[ns] as Record<string, unknown> | undefined
    return (nsData?.[key] as T) ?? fallback
  }, [prefs])

  // 最新一份 prefs 的镜像，专供 setPref 在**渲染之外**读当前值。
  // setPref 以前把"算下一状态"和"写缓存 + 发请求"一起塞进 setState 的 updater 里，
  // 有两个问题：① updater 必须是纯函数，StrictMode 下会被调用两次，于是 saveToCloud
  // 被触发两遍（防抖恰好吃掉了，所以一直没暴露），React 19 / 并发渲染下 updater 还
  // 可能被丢弃重放；② localStorage.setItem 在配额满或隐私模式下会抛，而这一抛发生
  // 在渲染阶段——切页签、改画线这类高频操作会直接把整棵树打挂。
  // 改法：用 ref 读当前值算出 next，副作用留在调用处（事件处理器里），setState 只
  // 接一个已经算好的值。
  // A mirror of the latest prefs, so setPref can read the current value *outside*
  // rendering. It used to compute the next state and do the cache write plus the
  // network call inside the setState updater, which is wrong twice over: an
  // updater must be pure, and StrictMode calls it twice (firing saveToCloud twice
  // — the debounce happened to absorb it, which is why it never showed), while
  // React 19 / concurrent rendering may discard and replay it; and
  // localStorage.setItem throws on a full quota or in private mode, during the
  // render phase, so a high-frequency action like switching tabs or editing a
  // drawing would take down the whole tree. Now the next value is computed from
  // the ref, the side effects stay at the call site (an event handler), and
  // setState receives a finished value.
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs

  const setPref = useCallback((ns: string, key: string, value: unknown) => {
    const prev = prefsRef.current
    const prevNs = (prev[ns] as Record<string, unknown>) ?? {}
    if (prevNs[key] === value) return // 值未变, 跳过 / skip if unchanged
    const nextNs = { ...prevNs, [key]: value }
    const next = { ...prev, [ns]: nextNs }
    prefsRef.current = next
    setPrefsState(next)
    writeJson(PREFS_CACHE_KEY, next)
    saveToCloud(ns, nextNs)
  }, [saveToCloud])

  // 云端加载完后，本机语言选择若比云端那份新（上次切完语言没来得及/没能存上云端，
  // 或在公开页上切的），把它补存上去——否则别的设备、以及本机清缓存后，还会拿到旧值。
  // Once cloud prefs are in, if the device's language choice is newer than the cloud's
  // (the last save never made it, or it was made on a public page), push it up —
  // otherwise other devices, and this one after a cache clear, still get the old value.
  useEffect(() => {
    if (!isAuthed || !loaded) return
    const local = storedLang()
    const localAt = storedLangAt()
    if (local === null || !localLangNewer(readCloudLang(prefsRef.current), local, localAt)) return
    setPref('lang', 'lang', local)
    setPref('lang', 'at', localAt)
  }, [isAuthed, loaded, setPref])

  // 应用其它设备经 WebSocket 推来的最新偏好（PREFS_UPDATE）：后端现在推送的
  // 是合并后的完整文档，直接整份替换本地状态即可，其它设备的改动不会丢。
  // 顺带把每个命名空间标记为"已与云端一致"，避免本地紧接着一次内容相同的
  // setPref 又触发一次多余的保存。
  // Apply the latest prefs pushed from another device via WebSocket: the
  // backend now pushes the merged, complete document, so replacing local
  // state wholesale is safe and never drops another device's changes. Also
  // marks every namespace as "in sync with the cloud" so a subsequent
  // identical-content setPref doesn't trigger a redundant save.
  const applyRemotePrefs = useCallback((data: Record<string, unknown>) => {
    const doc = data ?? {}
    writeJson(PREFS_CACHE_KEY, doc)
    setPrefsState(doc)
    for (const [ns, nsData] of Object.entries(doc)) {
      lastSavedByNs.current[ns] = JSON.stringify(nsData)
    }
    // 同步云端语言偏好，规则与初始加载一致（公开页不覆盖）
    // Sync the cloud language preference, same rules as the initial load (public pages excluded)
    applyCloudLanguage(doc, window.location.pathname)
  }, [])

  // 如果已登录但偏好未加载完, 子组件用 localStorage 缓存值先行渲染, 加载完成后自动覆盖。
  // If authed but prefs haven't loaded, children render with cached localStorage values;
  // they will be overridden once cloud prefs arrive.

  // memo 化 context value，理由同 store/auth.tsx：不 memo 的话每次渲染都换新引用，
  // 全部 usePrefs() 消费者（几乎每个页面）跟着重渲染，getPref 的身份也每次都变，
  // 把它写进 useEffect 依赖的组件会反复重跑。
  // Memoized for the same reason as store/auth.tsx: without it every render hands
  // out a new identity, re-rendering every usePrefs() consumer (nearly every
  // page), and getPref's changing identity re-fires any effect that depends on it.
  const value = useMemo<PrefsContextValue>(
    () => ({ prefs, loaded, getPref, setPref, applyRemotePrefs }),
    [prefs, loaded, getPref, setPref, applyRemotePrefs],
  )

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>
}

export function usePrefs() {
  const ctx = useContext(PrefsContext)
  if (!ctx) throw new Error('usePrefs must be used within PrefsProvider')
  return ctx
}
