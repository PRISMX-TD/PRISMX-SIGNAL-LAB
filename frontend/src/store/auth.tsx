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

// 登出时保留的 localStorage 键。除这些之外，所有 prismx 前缀的键在登出时一律清掉。
//
// 取"白名单保留 + 其余全清"而不是"列出要清的键"，是因为后者一定会漂移：新增一个
// 缓存用户数据的键时，没人会记得回来更新登出逻辑，而漏掉的后果是共享设备上的下一
// 个人看得到上一个人的东西。之前就漏了两个——prismx_prefs（含最后使用的 MT5 账号）
// 与 prismx_pending_payment（含收款地址与金额）。反过来写，新键默认被清，只有确实
// 该跨账号留存的才需要显式加进来，漏加的后果只是某个偏好被多清一次。
//
// 保留的三类：界面语言（设备偏好，清掉等于每次登出都把界面语言重置）；邀请来源
// 归因（在登录之前就采集，登出后注册新账号仍要能归因到原推荐人）；桥接更新提示的
// 忽略记录（说的是这台机器上装的桥接程序版本，与账号无关）。
//
// localStorage keys kept on logout; everything else prefixed `prismx` is cleared.
//
// An allowlist of what to keep, rather than a list of what to clear, because the
// latter inevitably drifts: whoever adds a key that caches user data won't think
// to update the logout path, and the cost of missing one is the next person on a
// shared device seeing the previous user's data. Two were in fact missed —
// prismx_prefs (last-used MT5 account) and prismx_pending_payment (payment
// address and amount). Inverted, a new key is cleared by default and only
// genuinely cross-account state needs adding here; forgetting to add one merely
// resets a preference.
//
// The three kept: UI language (a device preference — clearing it would reset the
// interface language on every logout); referral attribution (captured before
// login, and must survive so a post-logout signup still credits the referrer);
// and the bridge-update dismissal (about the bridge build installed on this
// machine, not about the account).
const LOGOUT_KEEP_KEYS = new Set([
  'prismx_lang',
  'prismx.ref',
  'prismx.ref.clicked',
  'prismx_bridge_update_dismissed_version',
])

function clearUserScopedStorage() {
  try {
    const doomed: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || LOGOUT_KEEP_KEYS.has(key)) continue
      if (key.startsWith('prismx_') || key.startsWith('prismx.')) doomed.push(key)
    }
    // 先收集再删除：边遍历边删会让 localStorage.key(i) 的索引错位，跳过一部分键。
    // Collect first, then delete: removing during the walk shifts the indices of
    // localStorage.key(i) and silently skips entries.
    doomed.forEach((k) => localStorage.removeItem(k))
  } catch {
    // 隐私模式/禁用存储时 localStorage 会抛异常。登出本身（清 token 与内存态）
    // 必须照常完成，不能因为清缓存失败就把用户留在登录态里。
    // localStorage throws in private mode / when storage is blocked. Logout
    // itself (dropping the token and in-memory state) must still complete —
    // failing to clear a cache must never leave the user logged in.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as User) : null
  })

  useEffect(() => {
    // token 缺失则清空用户 / clear user if token missing
    if (!getToken()) setUser(null)
    // 注册 401 回调：凭证失效时清空用户态，路由守卫会自动跳回登录页。
    //
    // 清理走与主动登出完全相同的那一条（clearUserScopedStorage），不是只删
    // USER_KEY。会话过期与点登出在"这台设备上不该再留着上一个人的数据"这件事上
    // 没有区别，而且过期是更常走的那条路——用户多半是关掉标签页走人，而不是先点
    // 一下登出。两条路径各写各的，漏的一定是这条。
    //
    // Clearing goes through exactly the same path as an explicit logout
    // (clearUserScopedStorage), not just USER_KEY. An expired session and a
    // logout click are indistinguishable as far as "this device should stop
    // holding the previous user's data" goes, and expiry is the better-travelled
    // route — people close the tab rather than click logout. Give the two paths
    // separate implementations and this is the one that gets forgotten.
    //
    // Register 401 handler: clear user on expired token; the route guard redirects to login.
    setUnauthorizedHandler(() => {
      clearUserScopedStorage()
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
    clearUserScopedStorage()
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
        return {
          ...prev,
          plan: me.plan,
          planIsTrial: me.planIsTrial,
          planExpiresAt: me.planExpiresAt,
          // 游戏化可见性也搭这一趟车：见 User.gamificationVisible 的说明——
          // 它同样不在登录响应里，Layout/UserMenu 的入口靠这次刷新才补上。
          // 排行榜可见性是独立开关，同一趟车、同一先例。
          // Gamification visibility rides along too — see User.gamificationVisible;
          // it's likewise absent from the login response, and the nav entries
          // only appear once this refresh fills it in. Leaderboard visibility is
          // a separate switch, riding the same trip on the same precedent.
          gamificationVisible: me.gamificationVisible,
          leaderboardVisible: me.leaderboardVisible,
        }
      })
      const stored = localStorage.getItem(USER_KEY)
      if (stored) {
        const parsed = JSON.parse(stored)
        parsed.plan = me.plan
        parsed.planIsTrial = me.planIsTrial
        parsed.planExpiresAt = me.planExpiresAt
        parsed.gamificationVisible = me.gamificationVisible
        parsed.leaderboardVisible = me.leaderboardVisible
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
