// 认证状态 / Auth context
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { User } from '../api/types'
import { authApi, clearToken, getToken, setToken, setUnauthorizedHandler, userApi } from '../api/client'

interface AuthContextValue {
  user: User | null
  isAuthed: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, phoneCountry: string, phone: string) => Promise<void>
  // 补录手机号成功后就地更新登录态，让路由守卫立刻放行（不必重新登录）
  // Updates auth state in place so the route guard releases immediately
  submitPhone: (phoneCountry: string, phone: string) => Promise<void>
  loginWithGoogle: (credential: string) => Promise<void>
  logout: () => void
  refreshUser: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

const USER_KEY = 'prismx_user'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  })

  useEffect(() => {
    // token 缺失则清空用户 / clear user if token missing
    if (!getToken()) setUser(null)
    // 注册 401 回调：凭证失效时清空用户态，路由守卫会自动跳回登录页。
    // Register 401 handler: clear user on expired token; the route guard redirects to login.
    setUnauthorizedHandler(() => {
      localStorage.removeItem(USER_KEY)
      setUser(null)
    })
    return () => setUnauthorizedHandler(null)
  }, [])

  const persist = (u: User, token: string) => {
    setToken(token)
    localStorage.setItem(USER_KEY, JSON.stringify(u))
    setUser(u)
  }

  const login = async (email: string, password: string) => {
    const res = await authApi.login(email, password)
    persist(res.user, res.token)
  }

  const register = async (email: string, password: string, phoneCountry: string, phone: string) => {
    const res = await authApi.register(email, password, phoneCountry, phone)
    persist(res.user, res.token)
  }

  const submitPhone = async (phoneCountry: string, phone: string) => {
    const updated = await authApi.setPhone(phoneCountry, phone)
    // 只换 user，token 不动：这个接口不签发新 token，沿用当前的。
    // Swap the user only; this endpoint issues no new token.
    setUser(updated)
    localStorage.setItem(USER_KEY, JSON.stringify(updated))
  }

  const loginWithGoogle = async (credential: string) => {
    const res = await authApi.google(credential)
    persist(res.user, res.token)
  }

  const logout = () => {
    clearToken()
    localStorage.removeItem(USER_KEY)
    setUser(null)
  }

  // planExpiresAt 一并带回来：到期横幅（components/PlanExpiryBanner）要靠它算
  // 还剩几天。此前它只存在于 AccountPage / UpgradePage 各自的一次性 userApi.me()
  // 调用里，任何全局组件想用都得自己再发一次请求——放进登录态是唯一一处、
  // 且随 refreshUser 自然保持新鲜。
  // Also carry planExpiresAt back: the expiry banner
  // (components/PlanExpiryBanner) needs it to compute days remaining. It used to
  // live only inside AccountPage's and UpgradePage's own one-off userApi.me()
  // calls, so any global component wanting it had to issue yet another request.
  // Keeping it on the auth state gives it a single home that stays fresh with
  // refreshUser.
  const refreshUser = async () => {
    if (!getToken()) return
    try {
      const me = await userApi.me()
      setUser((prev) => {
        if (!prev) return null
        return { ...prev, plan: me.plan, planIsTrial: me.planIsTrial, planExpiresAt: me.planExpiresAt }
      })
      const stored = localStorage.getItem(USER_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        parsed.plan = me.plan
        parsed.planIsTrial = me.planIsTrial
        parsed.planExpiresAt = me.planExpiresAt
        localStorage.setItem(USER_KEY, JSON.stringify(parsed))
      }
    } catch {
      // token 可能已过期，忽略
    }
  }

  return (
    <AuthContext.Provider value={{ user, isAuthed: !!user, login, register, submitPhone, loginWithGoogle, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
