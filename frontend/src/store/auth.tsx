// 认证状态 / Auth context
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { User } from '../api/types'
import { authApi, clearToken, getToken, setAccountDisabledHandler, setToken, setUnauthorizedHandler, userApi } from '../api/client'
import { readJson, writeJson } from '../utils/safeStorage'

interface AuthContextValue {
  user: User | null
  isAuthed: boolean
  // 账号被管理员停用时后端下发的那句双语说明（含原因）；未被停用为 null。
  // 由 api/client 的 403 复验确认后写入，AccountDisabledGate 据此接管整个界面。
  // 刻意不写进 localStorage：这是服务端的当下判断，恢复之后必须立刻消失，
  // 而缓存下来就会出现"后台已恢复、用户这台设备还在弹封号"的鬼状态。
  // The backend's bilingual notice (reason included) when an admin has disabled
  // this account; null otherwise. Written once api/client's 403 re-check
  // confirms it, and AccountDisabledGate takes over the UI from there.
  // Deliberately never persisted: it is a server-side judgement of right now and
  // must vanish the moment the account is restored, whereas a cached copy leaves
  // one device insisting on a ban that has already been lifted.
  disabledNotice: string | null
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, phoneCountry: string, phone: string) => Promise<void>
  // 补录手机号成功后就地更新登录态，让路由守卫立刻放行（不必重新登录）
  // Updates auth state in place so the route guard releases immediately
  submitPhone: (phoneCountry: string, phone: string) => Promise<void>
  submitNickname: (nickname: string) => Promise<void>
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
  // 节日装饰的开关与「已关闭问候」记录：设备偏好，与账号无关。
  // Festival decoration switch and greeting dismissal: device preferences.
  'prismx_festival_off',
  'prismx_festival_dismissed',
  'prismx_festival_demo',
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

// 缓存用户的读写收口在这两个帮手上，全文件不再出现裸 JSON.parse / setItem。
// 读走 readJson：解析失败会把那份脏缓存删掉并返回 null，于是按"未登录"处理。
// 这一点是关键——AuthProvider 位于 ErrorBoundary **外层**（App.tsx 的
// AuthProvider > BrowserRouter > RouteErrorBoundary），初始化时抛错没有任何
// 边界接得住；而 localStorage 里的坏值不会自己消失，用户每次打开都是同一个
// 白屏，只能手动清站点数据，安卓 App 的 WebView 更是不会重装。
// Cached-user reads and writes funnel through these two helpers; no bare
// JSON.parse / setItem remains in this file. readJson drops a corrupt entry and
// yields null, so a bad cache degrades to "logged out" instead of throwing.
// That matters because AuthProvider sits *outside* the ErrorBoundary (App.tsx:
// AuthProvider > BrowserRouter > RouteErrorBoundary), so nothing catches a
// throw from its initialiser — and the bad value persists across reloads, so
// every future visit is the same blank page until site data is cleared by hand.
function readCachedUser(): User | null {
  return readJson<User | null>(USER_KEY, null)
}

function writeCachedUser(u: User | null): void {
  if (u) writeJson(USER_KEY, u)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  // 初始判据同时要求 token 存在：只看缓存的 user 会在"另一标签页登出/清了
  // token 但本页 prismx_user 还在"时放行一帧——Protected 通过、受保护页面挂载
  // 并发出不带 Authorization 的请求、拿一串 401 再被踢回登录页，表现为闪一下
  // 内页。判据放在初始化里而不是下面的 effect 里，那一帧就不存在。
  // The initial value also requires a token: judging by the cached user alone
  // lets one frame through when another tab has signed out (token cleared,
  // prismx_user still present) — Protected passes, the page mounts and fires
  // requests with no Authorization header, collects 401s and bounces back to
  // login, which reads as the app flashing an inner page. Deciding here rather
  // than in the effect below removes that frame entirely.
  const [user, setUser] = useState<User | null>(() => (getToken() ? readCachedUser() : null))
  const [disabledNotice, setDisabledNotice] = useState<string | null>(null)

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
    // 账号被停用：与 401 相反，**不清登录态、不跳登录页**。
    //
    // 被停用的人重新登录只会再被拒一次（登录接口之后的每一个请求都是 403），
    // 把他推回登录页只会让他在登录框和"登录已过期"之间反复横跳，而真正的原因
    // 一个字也看不到。这里只记下后端那句说明，由 AccountDisabledGate 铺一层
    // 遮罩把话说清楚，并把"登出"留成他自己按的一个按钮。
    //
    // A disabled account, unlike an expired session, keeps its auth state and is
    // not redirected: signing in again only gets refused again (every request
    // after the login call is a 403), so bouncing them to the login page just
    // loops them between the form and "session expired" while the actual reason
    // is never shown. We record the backend's sentence, let
    // AccountDisabledGate state it plainly, and leave signing out as a button
    // they press themselves.
    setAccountDisabledHandler((notice) => setDisabledNotice(notice))
    return () => {
      setUnauthorizedHandler(null)
      setAccountDisabledHandler(null)
    }
  }, [])

  const persist = useCallback((u: User, token: string) => {
    setToken(token)
    writeCachedUser(u)
    setUser(u)
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login(email, password)
    persist(res.user, res.token)
  }, [persist])

  const register = useCallback(async (email: string, password: string, phoneCountry: string, phone: string) => {
    const res = await authApi.register(email, password, phoneCountry, phone)
    persist(res.user, res.token)
  }, [persist])

  const submitPhone = useCallback(async (phoneCountry: string, phone: string) => {
    const updated = await authApi.setPhone(phoneCountry, phone)
    // 只换 user，token 不动：这个接口不签发新 token，沿用当前的。
    // Swap the user only; this endpoint issues no new token.
    setUser(updated)
    writeCachedUser(updated)
  }, [])

  // 补全资料页提交昵称。走的是账户页那个 PATCH，校验（长度/保留词/重名）只有
  // 一份；这里只负责把返回的 needsNickname 落到本地 user 上，让守卫放行。
  // Submits the nickname from the completion page through the same PATCH the
  // account page uses, so length / reserved-word / uniqueness validation lives
  // in one place; this only lands the returned needsNickname so the guard opens.
  const submitNickname = useCallback(async (nickname: string) => {
    const res = await userApi.updateProfile({ nickname })
    setUser((prev) => (prev ? { ...prev, needsNickname: res.needsNickname } : prev))
    // 缓存里没有（或是坏值）就不写：readCachedUser 已经把坏值删掉了，此刻补一份
    // 半截 user 反而会造出一个缺字段的缓存。下一次 persist/refreshUser 会补全。
    // Skip when the cache is absent or was corrupt (readCachedUser already
    // removed it): writing a partial user here would manufacture a
    // field-missing cache entry. The next persist/refreshUser fills it in.
    const cached = readCachedUser()
    if (cached) writeCachedUser({ ...cached, needsNickname: res.needsNickname })
  }, [])

  const loginWithGoogle = useCallback(async (credential: string) => {
    const res = await authApi.google(credential)
    persist(res.user, res.token)
  }, [persist])

  const logout = useCallback(() => {
    clearToken()
    clearUserScopedStorage()
    setUser(null)
    // 停用提示跟着会话一起结束：否则登出后回到登录页，遮罩还盖在上面，
    // 换一个账号登录也进不去。
    // The disabled notice ends with the session: otherwise the overlay would
    // still cover the login page after signing out, locking out even a
    // different account.
    setDisabledNotice(null)
  }, [])

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
  const refreshUser = useCallback(async () => {
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
          // 比赛可见性是第三个独立内测开关，搭同一趟车——先例同上两行。
          // Competitions visibility is a third, independent beta switch riding
          // the same trip — same precedent as the two lines above.
          competitionsVisible: me.competitionsVisible,
          // 等级/称号同样搭这趟车：后端只在 gamificationVisible 为真时算，
          // 否则是 null——UserMenu 的角标靠这两个字段渲染，不用再单独请求。
          // Level/title ride the same trip: the backend only computes these
          // when gamificationVisible is true for this user, else null —
          // UserMenu's badge renders off these two fields with no extra request.
          gamificationLevel: me.gamificationLevel,
          gamificationTitle: me.gamificationTitle,
          // 昵称欠费标记：这一趟是强制上线前那批会话唯一的补票机会——他们缓存
          // 的 user 里根本没有这个键，不刷新就永远绕过守卫。
          // The nickname flag: this trip is the only chance for sessions that
          // predate the rollout, whose cached user has no such key and would
          // otherwise slip past the guard forever.
          needsNickname: me.needsNickname,
          // 代理入口开关，搭同一趟车（见 User.isAgent）/ agent entry flag, same trip
          isAgent: me.isAgent,
        }
      })
      const cached = readCachedUser()
      if (cached) {
        writeCachedUser({
          ...cached,
          plan: me.plan,
          planIsTrial: me.planIsTrial,
          planExpiresAt: me.planExpiresAt,
          gamificationVisible: me.gamificationVisible,
          leaderboardVisible: me.leaderboardVisible,
          competitionsVisible: me.competitionsVisible,
          gamificationLevel: me.gamificationLevel,
          gamificationTitle: me.gamificationTitle,
          needsNickname: me.needsNickname,
          isAgent: me.isAgent,
        })
      }
    } catch {
      // token 可能已过期，忽略
    }
  }, [])

  // memo 化 context value：user 没变时不再制造新引用。
  //
  // 此前这里每次渲染都新建一个对象字面量，于是 AuthProvider 的任何一次 setState
  // （401 清态、refreshUser 回填）都会让全部 useAuth() 消费者重渲染——Layout、
  // UserMenu、每一层路由守卫。更麻烦的是 login/logout/refreshUser 的函数身份每次
  // 都变，把它们写进 useEffect 依赖就会反复触发；store/live.tsx 里那个
  // refreshUserRef 就是被这一点逼出来的绕法。方法全部 useCallback 之后，那类绕法
  // 可以逐步拆掉。
  // Memoized context value: no fresh identity while `user` is unchanged.
  // This used to be an inline object literal, so any AuthProvider setState (401
  // teardown, refreshUser backfill) re-rendered every useAuth() consumer —
  // Layout, UserMenu and each route guard. Worse, login/logout/refreshUser got a
  // new identity per render, so listing them in a useEffect's deps re-fired it
  // endlessly; the refreshUserRef workaround in store/live.tsx exists because of
  // exactly that. With the methods wrapped in useCallback those workarounds can
  // be unwound over time.
  //
  // isAuthed 只看 user：token 的存在性已经在上面的 state 初始化里核过一次，
  // 401 回调也会同时清掉两者，因此不必在渲染期再读一次 localStorage。
  // isAuthed checks `user` alone: the token's presence is verified in the state
  // initialiser above and the 401 handler clears both together, so there is no
  // need to hit localStorage during render.
  const value = useMemo<AuthContextValue>(
    () => ({ user, isAuthed: !!user, disabledNotice, login, register, submitPhone, submitNickname, loginWithGoogle, logout, refreshUser }),
    [user, disabledNotice, login, register, submitPhone, submitNickname, loginWithGoogle, logout, refreshUser],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
