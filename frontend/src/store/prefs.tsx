// 用户偏好云端同步 / User preferences cloud sync
// 登录后从后端加载偏好, 改动时按命名空间防抖落库, localStorage 作为离线兜底缓存。
// After login, load prefs from backend; debounced per-namespace PUT on change;
// localStorage as offline cache.
import { createContext, useContext, useEffect, useState, useCallback, useRef, type ReactNode } from 'react'
import { useAuth } from './auth'
import { userApi } from '../api/client'
import i18n from '../i18n'

const PREFS_CACHE_KEY = 'prismx_prefs'

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
  const [prefs, setPrefsState] = useState<Record<string, unknown>>(() => {
    try {
      const cached = localStorage.getItem(PREFS_CACHE_KEY)
      return cached ? JSON.parse(cached) : {}
    } catch {
      return {}
    }
  })
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

  // 登录后从云端加载偏好 / load prefs from cloud after login
  useEffect(() => {
    if (!isAuthed) {
      setPrefsState({})
      setLoaded(false)
      lastSavedByNs.current = {}
      return
    }
    setLoaded(false)
    userApi.getPrefs()
      .then((res) => {
        const data = (res.data ?? {}) as Record<string, unknown>
        setPrefsState(data)
        const nextLastSaved: Record<string, string> = {}
        for (const [ns, nsData] of Object.entries(data)) {
          nextLastSaved[ns] = JSON.stringify(nsData)
        }
        lastSavedByNs.current = nextLastSaved
        localStorage.setItem(PREFS_CACHE_KEY, JSON.stringify(data))
        // 同步云端语言偏好 / sync cloud language preference
        const cloudLang = (data as Record<string, unknown>)?.lang as Record<string, unknown> | undefined
        const lang = cloudLang?.lang as string | undefined
        if (lang && (lang === 'zh' || lang === 'en') && lang !== i18n.language) {
          i18n.changeLanguage(lang)
          localStorage.setItem('prismx_lang', lang)
        }
      })
      .catch(() => {
        // 云端加载失败, 继续用 localStorage 缓存 / fallback to cached localStorage
      })
      .finally(() => setLoaded(true))
  }, [isAuthed, user?.id])

  // 按命名空间防抖落库：只 PUT 这一个命名空间的数据，服务端与已存的其它
  // 命名空间合并（不再整份覆盖），见 client.ts / 后端 account.py 的说明。
  // Debounced per-namespace PUT: only this namespace's data is sent; the
  // server merges it into the stored document instead of overwriting the
  // whole thing — see client.ts / the backend's account.py.
  const saveToCloud = useCallback((ns: string, nsData: Record<string, unknown>) => {
    const json = JSON.stringify(nsData)
    if (json === lastSavedByNs.current[ns]) return
    const timers = saveTimers.current
    if (timers[ns]) window.clearTimeout(timers[ns])
    timers[ns] = window.setTimeout(() => {
      userApi.putPrefs(ns, nsData)
        .then(() => { lastSavedByNs.current[ns] = json })
        .catch(() => { /* 静默失败, 下次改动时重试 / silent fail, retry next change */ })
    }, 500)
  }, [])

  // 清理所有命名空间的防抖定时器 / clear every namespace's debounce timer on unmount
  useEffect(() => {
    return () => {
      for (const id of Object.values(saveTimers.current)) window.clearTimeout(id)
    }
  }, [])

  const getPref = useCallback(<T,>(ns: string, key: string, fallback: T): T => {
    const nsData = prefs[ns] as Record<string, unknown> | undefined
    return (nsData?.[key] as T) ?? fallback
  }, [prefs])

  const setPref = useCallback((ns: string, key: string, value: unknown) => {
    setPrefsState((prev) => {
      const prevNs = (prev[ns] as Record<string, unknown>) ?? {}
      if (prevNs[key] === value) return prev // 值未变, 跳过 / skip if unchanged
      const nextNs = { ...prevNs, [key]: value }
      const next = { ...prev, [ns]: nextNs }
      localStorage.setItem(PREFS_CACHE_KEY, JSON.stringify(next))
      saveToCloud(ns, nextNs)
      return next
    })
  }, [saveToCloud])

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
    localStorage.setItem(PREFS_CACHE_KEY, JSON.stringify(doc))
    setPrefsState(doc)
    for (const [ns, nsData] of Object.entries(doc)) {
      lastSavedByNs.current[ns] = JSON.stringify(nsData)
    }
    // 同步云端语言偏好(与初始加载一致)/ sync cloud language preference like initial load
    const cloudLang = (doc as Record<string, unknown>)?.lang as Record<string, unknown> | undefined
    const lang = cloudLang?.lang as string | undefined
    if (lang && (lang === 'zh' || lang === 'en') && lang !== i18n.language) {
      i18n.changeLanguage(lang)
      localStorage.setItem('prismx_lang', lang)
    }
  }, [])

  // 如果已登录但偏好未加载完, 子组件用 localStorage 缓存值先行渲染, 加载完成后自动覆盖。
  // If authed but prefs haven't loaded, children render with cached localStorage values;
  // they will be overridden once cloud prefs arrive.

  return (
    <PrefsContext.Provider value={{ prefs, loaded, getPref, setPref, applyRemotePrefs }}>
      {children}
    </PrefsContext.Provider>
  )
}

export function usePrefs() {
  const ctx = useContext(PrefsContext)
  if (!ctx) throw new Error('usePrefs must be used within PrefsProvider')
  return ctx
}
