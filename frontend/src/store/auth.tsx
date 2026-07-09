// 认证状态 / Auth context
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { User } from '../api/types'
import { authApi, clearToken, getToken, setToken, setUnauthorizedHandler, userApi } from '../api/client'

interface AuthContextValue {
  user: User | null
  isAuthed: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
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

  const register = async (email: string, password: string) => {
    const res = await authApi.register(email, password)
    persist(res.user, res.token)
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

  const refreshUser = async () => {
    if (!getToken()) return
    try {
      const me = await userApi.me()
      setUser((prev) => {
        if (!prev) return null
        return { ...prev, plan: me.plan }
      })
      const stored = localStorage.getItem(USER_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        parsed.plan = me.plan
        localStorage.setItem(USER_KEY, JSON.stringify(parsed))
      }
    } catch {
      // token 可能已过期，忽略
    }
  }

  return (
    <AuthContext.Provider value={{ user, isAuthed: !!user, login, register, loginWithGoogle, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
