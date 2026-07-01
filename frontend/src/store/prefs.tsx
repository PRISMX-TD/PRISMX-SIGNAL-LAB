// 用户偏好云端同步 / User preferences cloud sync
// 登录后从后端加载偏好, 改动时防抖落库, localStorage 作为离线兜底缓存。
// After login, load prefs from backend; debounced PUT on change; localStorage as offline cache.
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
  /** 写入偏好值（乐观更新 + 防抖落库）/ write a pref value (optimistic + debounced save) */
  setPref: (ns: string, key: string, value: unknown) => void
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
  const saveTimer = useRef<number | undefined>(undefined)
  // 记录上次成功落库的数据，避免重复保存未变化的数据
  const lastSaved = useRef<string>('{}')

  // 登录后从云端加载偏好 / load prefs from cloud after login
  useEffect(() => {
    if (!isAuthed) {
      setPrefsState({})
      setLoaded(false)
      lastSaved.current = '{}'
      return
    }
    setLoaded(false)
    userApi.getPrefs()
      .then((res) => {
        const data = (res.data ?? {}) as Record<string, unknown>
        setPrefsState(data)
        lastSaved.current = JSON.stringify(data)
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

  // 防抖落库 / debounced PUT to backend
  const saveToCloud = useCallback((data: Record<string, unknown>) => {
    const json = JSON.stringify(data)
    if (json === lastSaved.current) return
    if (saveTimer.current) window.clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      userApi.putPrefs(data)
        .then(() => { lastSaved.current = JSON.stringify(data) })
        .catch(() => { /* 静默失败, 下次改动时重试 / silent fail, retry next change */ })
    }, 500)
  }, [])

  // 清理防抖定时器 / clear debounce timer on unmount
  useEffect(() => {
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
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
      const next = { ...prev, [ns]: { ...prevNs, [key]: value } }
      localStorage.setItem(PREFS_CACHE_KEY, JSON.stringify(next))
      saveToCloud(next)
      return next
    })
  }, [saveToCloud])

  // 如果已登录但偏好未加载完, 子组件用 localStorage 缓存值先行渲染, 加载完成后自动覆盖。
  // If authed but prefs haven't loaded, children render with cached localStorage values;
  // they will be overridden once cloud prefs arrive.

  return (
    <PrefsContext.Provider value={{ prefs, loaded, getPref, setPref }}>
      {children}
    </PrefsContext.Provider>
  )
}

export function usePrefs() {
  const ctx = useContext(PrefsContext)
  if (!ctx) throw new Error('usePrefs must be used within PrefsProvider')
  return ctx
}
