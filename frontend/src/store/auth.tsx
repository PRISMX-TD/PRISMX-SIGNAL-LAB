// 认证状态 / Auth context
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { User } from '../api/types'
import { authApi, clearToken, getToken, setToken } from '../api/client'

interface AuthContextValue {
  user: User | null
  isAuthed: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string) => Promise<void>
  logout: () => void
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

  const logout = () => {
    clearToken()
    localStorage.removeItem(USER_KEY)
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ user, isAuthed: !!user, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
