// REST 客户端封装 / REST client wrapper
import type { Signal, Order, OrderEntryType, CloseAllResult, User, MT5Account, Trend, SignalDailyCount, SignalWinRate, PersonalWinRate, ClosedTrade, AdminUser, AdminPageStats, AdminNetQuality, AdminOverview, AdminPotentialCustomers, AdminTraderLevels, AdminTraderLevelUsers, AdminStrategyWinRate, AdminEmailGateSettings, AdminPricingSettings, AdminSocialSettings, AdminTrialSettings, AdminCandleSettings, AdminStrategySettings, AdminWinrateSettings, PlatformStrategy, TrialStatus, SimulateResult, UserRole, UserPlan, BrokerLock, AdminBrokerSettings, AutoManageSettings, Candle, SentimentRatio, Quote, StrategyPresets, UserStrategy, StrategyBacktestResult, StrategySignal, StrategyTemplateKey, StopLossMethod, TakeProfitMethod, StrategyCoverageResponse, StrategyPerformance, StrategySessionFilter, Ticket, TicketListItem, TicketCategory, TicketPriority, TicketStatus, InviteLink, GamificationMe, GamificationWinRateSummary, ProfilePatch, ProfileOut, LeaderboardBoard, LeaderboardPayload, PublicProfile, GamificationSettings, GamificationSettingsPatch, CompetitionListGrouped, CompetitionDetail, CompetitionRegisterResult, CompetitionAdminRow, CompetitionCreate, CompetitionPatch, ParticipantAdminRow, ParticipantPatch, CompetitionSettleResult, AgentLink, AgentLinkUser, AgentLinkUsers, AgentOverview, AgentPlanChange, SocialLinks, StatsRangeQuery } from './types'
import type { Announcement, AnnouncementInput, AnnouncementList, AnnouncementPopup, NotificationFeed } from './types'
import type { ConditionPayload, UsageCatalog } from '../components/strategies/conditionTypes'
import { readJson, readStorage, removeStorage, writeJson, writeStorage } from '../utils/safeStorage'

const TOKEN_KEY = 'prismx_token'

// API 基础地址：生产用 VITE_API_BASE 指向线上后端，开发留空走 Vite 代理。
// API base: prod uses VITE_API_BASE to point at the deployed backend; dev leaves it empty to use the Vite proxy.
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '')

export function getToken(): string | null {
  return readStorage(TOKEN_KEY)
}
export function setToken(token: string) {
  writeStorage(TOKEN_KEY, token)
  // 换了 token 就是换了一个会话：上一位用户是不是被停用，与这一位无关。
  // A new token is a new session: whether the previous one was disabled says
  // nothing about this one.
  accountDisabled = false
}
export function clearToken() {
  removeStorage(TOKEN_KEY)
  accountDisabled = false
}

// ---- 邀请链接归因 / invite-link attribution ----
// RefCapture 在任意入口页捕获 ?ref= 后写入；注册请求读取携带，成功后清除。
// 30 天有效、后点覆盖先点。老用户带着残留 ref 登录不会被污染——后端只在
// 新建用户时应用（见 backend routers/invite.py 的 apply_invite）。
// Written by RefCapture on any entry URL; read and attached by the register
// calls, cleared on success. 30-day TTL, last click wins. Returning users
// carrying a stale ref are safe: the backend applies it to new users only.
const REF_KEY = 'prismx.ref'
const REF_TTL_MS = 30 * 24 * 60 * 60 * 1000

export function storeRef(code: string) {
  writeJson(REF_KEY, { code, ts: Date.now() })
}

export function readRef(): string | null {
  const parsed = readJson<{ code?: unknown; ts?: unknown } | null>(REF_KEY, null)
  if (!parsed) return null
  if (typeof parsed.code !== 'string' || typeof parsed.ts !== 'number') return null
  if (Date.now() - parsed.ts > REF_TTL_MS) return null
  return parsed.code
}

export function clearRef() {
  removeStorage(REF_KEY)
}

// 未授权（401）回调：登录态过期时由 AuthProvider 注册，用于清状态并跳登录页。
// Unauthorized (401) callback: registered by AuthProvider to clear state and redirect.
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn
}

// ---- 账号被停用（403）/ account disabled (403) ----
//
// 管理员停用一个账号之后，**所有需要登录的接口**都返回 403，响应体是
// `{"detail": "<中英双语说明，含管理员填的原因>"}`。
//
// 为什么不能"见 403 就当停用"：403 在本站是个多义状态码，绝大多数 403 与停用
// 无关——游戏化/排行榜/比赛三个内测开关（见 App.tsx 各路由的注释）、非 PRO 用户
// 启用自定义策略、非管理员打 /admin/*，都返回 403 并由各自页面降级成一句提示。
// 把它们一律当成"你被停用了"，等于每个还没开放的内测入口都弹一个封号弹窗。
//
// 为什么不能靠文案匹配：detail 是后端可随时改写的自然语言（还带管理员填的原因），
// 拿它做控制流，文案一改前端就静默失灵。
//
// 所以用**复验**：收到任何一个 403 时，另外打一次 /auth/me。这个端点对"已登录且
// 未被停用"的人恒为 200——它没有任何其它 403 的理由（不看角色、不看套餐、不看内测
// 开关）。它也 403，就只剩"这个账号被停用了"一种解释，并且那次响应的 detail 正是
// 我们要展示给用户的那句话（含原因），不必从触发它的那个接口的报错里猜。
//
// 代价是每个会话最多一次额外请求：确认过就不再复验（accountDisabled），
// 复验在途时后到的 403 直接返回（probing），换 token / 登出时标志复位。
//
// After an admin disables an account every authenticated endpoint answers 403
// with `{"detail": "<bilingual text including the admin's reason>"}`.
//
// Why "any 403 means disabled" is wrong: 403 is overloaded here and most of them
// have nothing to do with a disabled account — the three beta switches
// (gamification / leaderboard / competitions, see the per-route comments in
// App.tsx), a non-PRO user enabling a custom strategy, a non-admin hitting
// /admin/* — each returns 403 and is degraded into an inline hint by its own
// page. Treating those as "you are banned" would pop a ban dialog on every
// not-yet-released beta entry point.
//
// Why matching on the message is wrong: detail is free-form text the backend may
// reword at any time (and it embeds the admin's reason). Driving control flow off
// it means the frontend silently stops working the day someone edits the copy.
//
// Hence a re-check: on any 403, issue one extra GET /auth/me. That endpoint is
// always 200 for a logged-in, non-disabled user — it has no other reason to
// return 403 (it inspects neither role, nor plan, nor beta switches). If it 403s
// too, "this account is disabled" is the only explanation left, and that
// response's detail is exactly the sentence to show (reason included), so there
// is no need to guess from whichever endpoint tripped first.
//
// Cost: at most one extra request per session — confirmed accounts skip the
// re-check (accountDisabled), 403s landing while one is in flight are dropped
// (probing), and both flags reset when the token changes or is cleared.
const ACCOUNT_PROBE_PATH = '/auth/me'
let accountDisabled = false
let probing = false
let onAccountDisabled: ((notice: string) => void) | null = null

/** 由 AuthProvider 注册：拿到后端那句双语说明（含停用原因）后弹全局遮罩。
 *  Registered by AuthProvider: receives the backend's bilingual notice
 *  (including the reason) and raises the site-wide overlay. */
export function setAccountDisabledHandler(fn: ((notice: string) => void) | null) {
  onAccountDisabled = fn
}

function confirmDisabled(notice: string) {
  accountDisabled = true
  onAccountDisabled?.(notice)
}

function checkAccountDisabled(path: string, detail: string) {
  // 没 token 的 403 与账号状态无关（公开端点的门控），已确认过的不再复验。
  // A 403 without a token says nothing about an account; a confirmed one needs
  // no further checking.
  if (!getToken() || accountDisabled) return
  // 触发 403 的就是复验端点本身：不必再打一次，这次的 detail 就是那句话。
  // The probe endpoint is the one that 403'd: no second call needed, this
  // response's detail is already the message.
  if (path === ACCOUNT_PROBE_PATH) {
    confirmDisabled(detail)
    return
  }
  if (probing) return
  probing = true
  // 刻意用裸 fetch 而不是 request()：走 request() 会让这次复验的 403 再次进到
  // 这里，形成自我递归。同理它也不该带超时/续期那套——它只是一次判据查询。
  // Deliberately a bare fetch rather than request(): going through request()
  // would feed this probe's own 403 back into this function and recurse. It
  // likewise wants none of the timeout/renewal machinery — it is one lookup.
  void (async () => {
    try {
      const token = getToken()
      if (!token) return
      const res = await fetch(`${API_BASE}/api${ACCOUNT_PROBE_PATH}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (res.status !== 403) return
      let notice = detail
      try {
        const body = await res.json()
        if (typeof body?.detail === 'string' && body.detail.trim()) notice = body.detail
      } catch {
        // 响应体不是 JSON：退回触发这次复验的那条 detail，总比无话可说强。
        // Body wasn't JSON: fall back to the detail that triggered the probe —
        // still better than saying nothing.
      }
      confirmDisabled(notice)
    } catch {
      // 网络失败：这次判不出来，不做任何结论。下一个 403 会再试一次。
      // Network failure: no conclusion drawn. The next 403 tries again.
    } finally {
      probing = false
    }
  })()
}
// 限流（429）的兜底文案。写成后端惯用的「中文 / English」双语格式，
// localizeApiError 会按界面语言取对应那半，不必单独走 i18n。
// Fallback message for rate limiting (429). Written in the backend's usual
// "中文 / English" bilingual shape so localizeApiError picks the right half by UI
// language, with no separate i18n plumbing needed.
const RATE_LIMITED =
  '操作过于频繁，已被限流，请稍等一分钟再试 / Too many requests, you have been rate limited — wait a minute and try again'

// 请求超时上限。移动网络挂起时 fetch 既不 resolve 也不 reject——连接卡在半开
// 状态，页面的加载骨架就永久转圈，用户只能自己刷新。30 秒取的是"比任何一条
// 正常接口都宽裕、又短到用户还愿意等"的位置：本站最慢的是回测与管理页的统计
// 聚合，实测都在个位数秒。
// 单次调用可以用 requestTimeoutMs 覆盖（0 表示不设超时，留给将来确实可能长跑
// 的端点），不传就走这个值。
// Per-request timeout ceiling. On a suspended mobile connection fetch neither
// resolves nor rejects — the socket sits half-open and the loading skeleton
// spins forever until the user reloads. 30s is "comfortably longer than any
// healthy endpoint, short enough that the user is still waiting": the slowest
// calls here are backtests and the admin stats aggregation, both single-digit
// seconds in practice. Override per call with requestTimeoutMs (0 disables,
// reserved for endpoints that may genuinely run long).
const DEFAULT_TIMEOUT_MS = 30_000

// 超时/取消的统一错误名。调用方用 isAbortError() 区分"用户离开了这个页面"与
// "请求真的失败了"——前者不该弹任何提示。
// The error name used for both timeouts and caller cancellation. Call sites use
// isAbortError() to tell "the user left this page" from "the request actually
// failed"; the former must not surface any message.
export const ABORT_ERROR_NAME = 'AbortError'

/** 判断一个 catch 到的异常是否只是"请求被取消/超时"，据此决定要不要提示用户。
 *  Whether a caught error is merely a cancelled/timed-out request. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === ABORT_ERROR_NAME || err.name === 'TimeoutError')
}

// 调用方可在 RequestInit 上多传一个超时覆盖值。单独开个类型而不是加第三个参数，
// 是为了让全文件几百个 request(...) 调用点一个都不用改——要超时/取消的那几个
// 自己在 options 里加 signal / requestTimeoutMs 即可。
// Callers may pass a timeout override alongside the normal RequestInit. Modelled
// as an extra field rather than a third parameter so that none of the several
// hundred existing request(...) call sites need touching — the handful that want
// cancellation just add signal / requestTimeoutMs to their options.
export interface ApiRequestInit extends RequestInit {
  /** 毫秒；0 或负数表示不设超时 / milliseconds; 0 or negative disables the timeout */
  requestTimeoutMs?: number
}

// 把"调用方传来的 signal"与"本次超时"合成一个 signal。
//
// 不用 AbortSignal.any / AbortSignal.timeout：产物语法下限是 Chrome 70（见
// vite.config.ts 的 target），这两个 API 分别要 Chrome 116 / 103，polyfills.ts
// 也没有补（见其文件头"新增 API 必须同步补 polyfill"那条）。手写转发是这里唯一
// 能同时满足下限与功能的做法。
// Combine the caller's signal with this request's timeout into one signal.
// Not AbortSignal.any / AbortSignal.timeout: the output syntax floor is Chrome
// 70 (see vite.config.ts's target) while those need Chrome 116 / 103, and
// polyfills.ts doesn't shim them (see its "new API ⇒ new polyfill" rule).
// Forwarding by hand is the only option that meets the floor.
function withTimeout(external: AbortSignal | null | undefined, timeoutMs: number) {
  const controller = new AbortController()
  let timer: number | undefined
  const onExternalAbort = () => controller.abort()

  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onExternalAbort)
  }
  if (timeoutMs > 0) {
    timer = window.setTimeout(() => controller.abort(), timeoutMs)
  }
  const cleanup = () => {
    if (timer !== undefined) window.clearTimeout(timer)
    if (external) external.removeEventListener('abort', onExternalAbort)
  }
  return { signal: controller.signal, cleanup }
}

async function request<T>(path: string, options: ApiRequestInit = {}): Promise<T> {
  const { requestTimeoutMs, signal: callerSignal, ...init } = options
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }
  // 文件上传（FormData）必须让浏览器自己写 Content-Type：multipart 的 boundary
  // 由浏览器生成，手写 'multipart/form-data' 会缺 boundary，后端解析直接失败。
  // For FormData uploads the browser must set Content-Type itself: it generates
  // the multipart boundary, and a hand-written 'multipart/form-data' lacks it,
  // which makes server-side parsing fail outright.
  if (options.body instanceof FormData) delete headers['Content-Type']
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`

  const { signal, cleanup } = withTimeout(
    callerSignal,
    requestTimeoutMs === undefined ? DEFAULT_TIMEOUT_MS : requestTimeoutMs,
  )
  let res: Response
  try {
    res = await fetch(`${API_BASE}/api${path}`, { ...init, headers, signal })
  } finally {
    // 响应头一到就可以撤掉计时器：超时管的是"服务器迟迟不应答"，不是"响应体
    // 读得慢"。放在 finally 里保证抛错路径也清得掉，不留悬挂的定时器与监听器。
    // The timer is dropped as soon as headers arrive: the timeout guards against
    // a server that never answers, not a slow body. In `finally` so the throwing
    // path clears it too, leaving no dangling timer or listener.
    cleanup()
  }
  // 滑动续期：后端在 token 剩余有效期不足一半时经此头下发新 token，
  // 静默替换本地 token，活跃用户不再每天被踢回登录页。
  // 写入走 safeStorage：这一行发生在 res.ok 判定**之前**，隐私模式/配额满时
  // 一个裸 setItem 抛出来，会把一次本来成功的请求变成 reject，用户看到的是
  // 「明明成功却报错」。续期写不进去顶多是下次重新登录，不该影响本次调用。
  // Sliding renewal: the backend issues a fresh token via this header when the
  // current one is past half-life; swap it in silently so active users never
  // get kicked back to the login page. The write goes through safeStorage
  // because it happens *before* the res.ok check: a bare setItem throwing in
  // private mode or on a full quota would turn a successful request into a
  // rejection — "it worked but reported an error". A failed renewal costs at
  // worst one extra login later and must not affect this call.
  const refreshed = res.headers.get('X-Refreshed-Token')
  if (refreshed) setToken(refreshed)
  if (!res.ok) {
    // 凭证失效：清除登录态并通知上层跳转登录页。
    // Token expired/invalid: clear auth state and notify the app to redirect.
    if (res.status === 401) {
      clearToken()
      onUnauthorized?.()
    }
    let detail = `HTTP ${res.status}`
    try {
      const body = await res.json()
      // slowapi 的限流响应把说明放在 error 字段、没有 detail，落到下面的分支就只剩
      // "HTTP 429" 这种对用户毫无意义的字符串。这里给 429 一个兜底标记，交给
      // localizeApiError 换成能看懂的说明；后端自己抛的 429（比如「已有回测在跑」）
      // 带 detail，仍走下面的分支、保留原文案。
      // slowapi's rate-limit response puts its message in `error` with no
      // `detail`, so the branches below would leave the useless string "HTTP 429".
      // Tag such responses so localizeApiError can turn them into something
      // readable; backend-raised 429s (e.g. "a backtest is already running") do
      // carry `detail` and keep their own wording via the branches below.
      if (res.status === 429 && !body.detail) detail = RATE_LIMITED
      // FastAPI 的字段校验错误（422）里 detail 是一个对象数组（{loc,msg,type}...），
      // 直接当字符串抛会显示成 "[object Object]"。这里把它拍平成可读的 msg 文本；
      // 普通业务错误的 detail 本就是字符串，原样使用。
      // FastAPI's field-validation errors (422) put an array of objects in
      // detail ({loc,msg,type}...); throwing that as-is renders "[object
      // Object]". Flatten it to readable msg text; ordinary business errors
      // already carry a string detail and are used as-is.
      if (Array.isArray(body.detail)) {
        const msgs = body.detail
          .map((e: unknown) =>
            e && typeof e === 'object' && 'msg' in e ? String((e as { msg: unknown }).msg) : String(e)
          )
          .filter(Boolean)
        detail = msgs.join('; ') || detail
      } else if (body.detail) {
        detail = body.detail
      }
    } catch {
      // 响应体不是 JSON（网关直接挡掉的限流常是纯文本或空体）。429 在这里也要给出
      // 说明，否则又退回 "HTTP 429"。
      // Body wasn't JSON (rate limiting blocked at the gateway often returns plain
      // text or nothing). 429 still needs its message here, or we fall back to the
      // bare "HTTP 429" again.
      if (res.status === 429) detail = RATE_LIMITED
    }
    // 403 的两种含义要分开：**没登录**是 401（上面已清 token 并跳登录页），
    // 403 是"身份有效但这件事不让你做"——**绝不能**跳登录页，那会把被停用的人
    // 塞进"登录 → 立刻又被拒 → 再跳登录"的死循环，而他每次看到的都是"登录已
    // 过期"这种与事实无关的说法。这里只在复验确认账号被停用时抬一次全局遮罩；
    // 其余 403（内测门控、非 PRO、非管理员）仍然只是一次普通的报错，由调用点
    // 各自降级。
    // The two meanings of 403 must stay apart: "not logged in" is 401 (handled
    // above — token cleared, redirect to login), while 403 means "your identity
    // is fine, this particular thing is refused". It must *never* redirect to
    // login: that traps a disabled user in log-in → refused → log-in again,
    // each round telling them their "session expired", which is not what
    // happened. This only raises the site-wide overlay once the re-check
    // confirms a disabled account; every other 403 (beta gates, non-PRO,
    // non-admin) stays an ordinary error for its call site to degrade.
    if (res.status === 403) checkAccountDisabled(path, detail)
    throw new Error(detail)
  }
  // 204 / 空体：成功但没有内容（邀请点击打点、将来任何"只需知道成功"的端点）。
  // 以前这里无条件 res.json()，空体会抛 SyntaxError，逼得调用方绕开本封装用裸
  // fetch——两套错误处理、两套鉴权头。这里统一吞掉，返回 undefined。
  // 204 / empty body: success with nothing to parse (invite-click tracking, any
  // future fire-and-forget endpoint). Unconditional res.json() threw on it and
  // forced callers to bypass this wrapper with raw fetch.
  if (res.status === 204 || res.headers.get('content-length') === '0') {
    return undefined as T
  }
  return res.json() as Promise<T>
}

// 认证 / Auth
export const authApi = {
  register: (email: string, password: string, phoneCountry: string, phone: string) =>
    request<{ token: string; user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, phoneCountry, phone, ref: readRef() ?? undefined }),
    }).then((res) => {
      clearRef()
      return res
    }),
  // 补录手机号（Google 注册的用户首次登录后走这条）/ fill in a missing phone
  setPhone: (phoneCountry: string, phone: string) =>
    request<User>('/auth/phone', {
      method: 'POST',
      body: JSON.stringify({ phoneCountry, phone }),
    }),
  // 找回密码：申请链接。后端无论邮箱存不存在都返回同一句话（防邮箱枚举），
  // 所以这里拿到的 message 不代表"这个邮箱是我们的用户"。
  // Request a reset link. The backend replies identically whether or not the
  // address exists, so this message never means "that email is one of ours".
  forgotPassword: (email: string) =>
    request<{ message: string }>('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  // 用邮件里的令牌设新密码。**刻意不返回 token**：后端不拿邮件链接换会话，
  // 改完要用户自己去登录页登一次。
  // Set a new password with the emailed token. Deliberately returns no session
  // token: the backend never trades an emailed link for a live session.
  resetPassword: (token: string, password: string) =>
    request<{ message: string }>('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),
  login: (email: string, password: string) =>
    request<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  google: (credential: string) =>
    request<{ token: string; user: User }>('/auth/google', {
      method: 'POST',
      body: JSON.stringify({ credential, ref: readRef() ?? undefined }),
    }).then((res) => {
      // 登录也清：ref 已被消费或不再相关（是否真的归因由后端创建分支决定）。
      // Cleared on login too: consumed or no longer relevant; whether it was
      // actually applied is decided by the backend's create branch.
      clearRef()
      return res
    }),
}

// 信号 / Signals
export const signalApi = {
  list: () => request<{ signals: Signal[] }>('/signals'),
  stats: () => request<{ daily: SignalDailyCount[]; total: number }>('/signals/stats'),
  winrate: () => request<SignalWinRate>('/signals/winrate'),
  // 平台策略介绍（只读，只返回已发布条目）；编辑走 adminApi.updatePlatformStrategies
  // Platform strategy write-ups (read-only, published entries only); editing
  // goes through adminApi.updatePlatformStrategies
  platformStrategies: () => request<{ items: PlatformStrategy[] }>('/signals/platform-strategies'),
  // 已公开策略的分时段/分品种/分钟点胜率。窗口固定 30 天（后端 ANALYSIS_DAYS），
  // 只统计管理员公开名单里的策略；名单为空时返回零结果。响应形状与
  // adminApi.strategyWinrate 完全一致——两端共用同一个计算函数。
  // Session / symbol / hour win rates for published strategies. Window pinned
  // to 30 days server-side; whitelisted strategies only, zero result when the
  // whitelist is empty. Same shape as adminApi.strategyWinrate — one shared
  // computation behind both.
  strategyAnalysis: () => request<AdminStrategyWinRate>('/signals/strategy-analysis'),
}

// 历史信号回放（模拟器）：**当前仅管理员可调**（后端 require_admin），
// 非管理员会拿到 403——功能先内部试用，入口也只对管理员显示。
// Historical signal replay: **admin-only for now** (backend require_admin);
// non-admins get a 403. The feature is in internal trial and its entry points
// are likewise admin-gated.
export const simulateApi = {
  run: (params: { days: number; risk: number; capital: number; mode: 'compound' | 'flat' }) =>
    request<SimulateResult>(
      `/signals/simulate?days=${params.days}&risk=${params.risk}&capital=${params.capital}&mode=${params.mode}`
    ),
}

// 多周期趋势 / Multi-timeframe trends
export const trendApi = {
  list: () => request<{ trends: Trend[] }>('/trends'),
}

// 全站统一报价快照（EA 推送，不区分用户/账户；首屏用，之后靠 WS GLOBAL_QUOTES 增量）
// Site-wide quote snapshot (EA-pushed, not user/account-scoped); first load,
// WS GLOBAL_QUOTES delivers deltas afterwards
export const quoteApi = {
  list: () => request<{ quotes: Quote[] }>('/quotes'),
}

// 当前活跃品种：EA 的 InpSymbols 实际在推什么，就返回什么，不是写死的列表。
// 报价表/图表选择器/仪表盘英雄板都应以此为准渲染。
// Currently active symbols: whatever the EA's InpSymbols is actually
// pushing, not a hardcoded list. The quotes table / chart symbol picker /
// dashboard hero should all render from this.
export const symbolApi = {
  list: () => request<{ symbols: string[] }>('/symbols'),
}

// 行情 K 线（自建中央 MT5 喂价源，取代 TradingView Widget）
// Chart candles from the self-hosted central MT5 feed (replaces the TradingView widget)
export const chartApi = {
  // before 是往更早翻页的游标：传当前最早那根的 t，拿到它之前的一页。
  // hasMore 为 false 表示数据库里没有更早的了，前端可以停止继续请求。
  // `before` is the cursor for paging backwards: pass the earliest bar's `t` to
  // get the page before it. hasMore=false means the database holds nothing
  // earlier, so the client can stop asking.
  history: (symbol: string, interval: string, limit = 1000, before?: number) =>
    request<{ symbol: string; interval: string; bars: Candle[]; hasMore: boolean }>(
      `/chart/history?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}` +
        (before !== undefined ? `&before=${before}` : '')
    ),
  latest: (symbol: string, interval: string) =>
    request<{ bars: Candle[]; updatedAt: number | null }>(
      `/chart/latest?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`
    ),
}

// 下单 / Orders
export const orderApi = {
  // 不传参数时行为不变(最新 100 条),供 useLive() 的实时订单跟踪继续用；
  // 传 limit/offset/since/until/login 时用于订单页的分页、日期与账号筛选。
  // login 交给后端在 SQL 里过滤，这样 total 和页码与筛选结果一致。
  // Unparameterized behavior is unchanged (latest 100), used by useLive()'s
  // real-time order tracking; pass limit/offset/since/until/login for the
  // Orders page's paginated, date- and account-filtered history browsing.
  // login is filtered server-side in SQL so total and page numbers match the
  // filtered set.
  list: (params: { limit?: number; offset?: number; since?: string; until?: string; login?: string } = {}) => {
    const qs = new URLSearchParams()
    if (params.limit) qs.set('limit', String(params.limit))
    if (params.offset) qs.set('offset', String(params.offset))
    if (params.since) qs.set('since', params.since)
    if (params.until) qs.set('until', params.until)
    if (params.login) qs.set('login', params.login)
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<{ orders: Order[]; total: number }>(`/orders${suffix}`)
  },
  // orderType 省略 = MARKET，行为与这个字段存在之前完全一致。
  // LIMIT / STOP 要带 price（触发价），后端会真的在 MT5 里挂一张单；两者都带或
  // 都不带由后端校验（市价单带 price 会被拒——那说明调用方以为自己在挂单）。
  // Omitting orderType means MARKET, identical to the behaviour before this field
  // existed. LIMIT / STOP require `price` and place a real MT5 pending order; the
  // backend rejects a market order carrying a price, since that means the caller
  // believed they were placing a pending one.
  place: (payload: {
    signalId: string | null
    symbol: string
    side: 'BUY' | 'SELL'
    volume: number
    clientOrderId: string
    mt5Login?: string | null
    stopLoss?: number | null
    takeProfit?: number | null
    orderType?: OrderEntryType
    price?: number | null
    // 下单来源：个人策略信号传 'STRATEGY'，后端写进券商备注（PRISMX-STRAT）。
    // Order source: 'STRATEGY' for personal strategy signals (broker comment PRISMX-STRAT).
    source?: 'STRATEGY' | null
  }) =>
    request<Order>('/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // 改一张真实的 MT5 挂单：触发价 / 止损 / 止盈。**省略哪一项就保留哪一项**——
  // 图表上拖一条线只改一项，另外两项不传，券商上的现值原样留着。止损止盈传 0
  // 是清除；触发价没有「清除」，后端会拒掉 0。
  // Modify a real MT5 pending order. Omitting a field keeps it: dragging one line on
  // the chart sends that one field and the broker's other values survive untouched.
  // 0 clears SL/TP; a trigger price has no "clear" and the backend refuses 0.
  modifyPending: (payload: {
    clientOrderId: string
    ticket: number
    symbol: string
    mt5Login?: string | null
    price?: number
    stopLoss?: number
    takeProfit?: number
  }) =>
    request<Order>('/orders/modify-pending', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // 撤一张真实的 MT5 挂单（按券商票号）。与 orderApi.cancel 不是一回事：那个撤的
  // 是平台侧还没下发的指令行，碰不到券商。
  // Remove a real MT5 pending order by its broker ticket. Distinct from
  // orderApi.cancel, which voids a not-yet-dispatched platform command row.
  cancelPending: (payload: {
    clientOrderId: string
    ticket: number
    symbol: string
    mt5Login?: string | null
  }) =>
    request<Order>('/orders/cancel-pending', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  close: (payload: {
    clientOrderId: string
    ticket: number
    symbol: string
    side: 'BUY' | 'SELL'
    mt5Login?: string | null
    volume?: number | null
  }) =>
    request<Order>('/orders/close', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  // 一键平仓：后端按自己那份持仓快照排指令，前端不回传持仓列表。
  // clientOrderId 是整批的编号（后端拼成 ca_<id>#<ticket>），重发同一个不会平两遍。
  // Close-all: the backend works from its own positions snapshot; clientOrderId
  // identifies the whole batch, so re-sending it never closes twice.
  closeAll: (payload: { clientOrderId: string; mt5Login?: string | null }) =>
    request<CloseAllResult>('/orders/close-all', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  modify: (payload: {
    clientOrderId: string
    ticket: number
    symbol: string
    side: 'BUY' | 'SELL'
    mt5Login?: string | null
    stopLoss: number
    takeProfit: number
  }) =>
    request<Order>('/orders/modify', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  cancel: (id: string) => request<Order>(`/orders/${id}/cancel`, { method: 'POST' }),
  // login：只看这一个账号（订单页的账号标签）；不传则统计当前仍绑定的全部账号。
  // login: narrow to one account (the Orders page's account tab); omitted scopes to all currently-bound accounts.
  winrate: (login?: string) =>
    request<PersonalWinRate>(`/orders/winrate${login ? `?login=${encodeURIComponent(login)}` : ''}`),
  closedTrades: () => request<{ trades: ClosedTrade[] }>('/orders/closed-trades'),
}

// 自定义策略：挑条件 → 查数据覆盖 → 回测 → 启用 → 触发个人信号 → 一键下单
// Custom strategies: pick conditions, check data coverage, backtest, enable, get
// personal signals on trigger, one-click order
export const strategyApi = {
  // 六条新手预设的逻辑与条件列表，不含品种周期（用户自己选）。
  // The six beginner presets' logic and condition lists, without symbol/interval
  // (the user picks those).
  templates: () => request<{ presets: StrategyPresets }>('/strategies/templates'),
  // 指标与用法目录：参数规格、取值范围、镜像关系。指标选择器与参数表单完全由它
  // 驱动，前端不带副本——两边各存一份的话，加一个用法就得改两处。
  // The indicator/usage catalogue: param specs, ranges and mirrors. It drives the
  // indicator picker and param forms entirely; the frontend keeps no copy, since
  // two copies mean adding a usage takes two edits.
  usages: () => request<UsageCatalog>('/strategies/usages'),
  list: () => request<{ strategies: UserStrategy[] }>('/strategies'),
  // 不传参即查"当前有报价的全部品种 × 六档周期"。回测之前调用，用来显示实际
  // 可用范围并把未接入品种置灰。
  // With no arguments this covers every currently quoted symbol across all six
  // intervals. Called before a backtest to show the actual available range and
  // grey out unfed symbols.
  coverage: (symbols?: string[], intervals?: string[]) => {
    const qs = new URLSearchParams()
    if (symbols?.length) qs.set('symbols', symbols.join(','))
    if (intervals?.length) qs.set('intervals', intervals.join(','))
    const suffix = qs.toString()
    return request<StrategyCoverageResponse>(`/strategies/coverage${suffix ? `?${suffix}` : ''}`)
  },
  // 策略编辑器的候选品种。与 coverage() 分开是因为首屏只要名单：coverage 不传参
  // 会对每个 (品种, 周期) 组合各算一行，代价随历史累积增长，而它返回的统计字段
  // 首屏一个都不读。
  // Candidate symbols for the strategy editor. Separate from coverage() because
  // the first paint only needs names: an argument-less coverage computes a row
  // per (symbol, interval) pair, growing as history accrues, and the first paint
  // reads none of the statistics it returns.
  symbolsWithHistory: () =>
    request<{ symbols: string[]; activeSymbols: string[] }>('/strategies/symbols'),
  // rules 与 template 二选一：给了 rules 就按它建，只给 template 则后端填该预设的
  // 条件。rules 里的 symbol / interval 必须与顶层的一致，否则 400。
  // Either rules or template: with rules it's built from them, with only a
  // template the backend fills in that preset's conditions. The symbol/interval
  // inside rules must equal the top-level ones or it's a 400.
  create: (payload: {
    template?: StrategyTemplateKey | null
    name?: string | null
    rules?: ConditionPayload
    symbol: string
    interval: string
    stopLossMethod: StopLossMethod
    stopLossValue: number
    takeProfitMethod: TakeProfitMethod
    takeProfitValue: number
    oneTradeAtATime: boolean
    exitTimeoutBars?: number | null
    sessionFilter?: StrategySessionFilter | null
    dailySignalCap?: number | null
    cooldownMinutes?: number | null
  }) => request<UserStrategy>('/strategies', { method: 'POST', body: JSON.stringify(payload) }),
  update: (
    id: string,
    payload: Partial<{
      name: string | null
      rules: ConditionPayload
      symbol: string
      interval: string
      stopLossMethod: StopLossMethod
      stopLossValue: number
      takeProfitMethod: TakeProfitMethod
      takeProfitValue: number
      oneTradeAtATime: boolean
      exitTimeoutBars: number | null
      sessionFilter: StrategySessionFilter | null
      dailySignalCap: number | null
      cooldownMinutes: number | null
      enabled: boolean
    }>
  ) => request<UserStrategy>(`/strategies/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  remove: (id: string) => request<{ ok: boolean }>(`/strategies/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 回测的 symbol / interval 与策略本身一致，单独传是因为回测不必先存策略——
  // 草稿状态就能试。
  // The backtest's symbol/interval match the strategy's own; they're passed
  // separately because a backtest doesn't require saving first — a draft can be
  // tried as-is.
  backtest: (payload: {
    template?: StrategyTemplateKey | null
    rules?: ConditionPayload
    symbol: string
    interval: string
    stopLossMethod: StopLossMethod
    stopLossValue: number
    takeProfitMethod: TakeProfitMethod
    takeProfitValue: number
    oneTradeAtATime: boolean
    exitTimeoutBars?: number | null
    days: number
    riskPct: number
    capital: number
    mode: 'compound' | 'flat'
  }) =>
    // 回测是同步返回的重活（后端对并发回测直接回 429），几年 K 线 + 多条件的组合
    // 明显有可能超过全局 30 秒的默认超时，所以单独放宽到 3 分钟。不是取消超时：
    // 真卡死时仍然要有一个终点，否则页面上那个"回测中"永远转下去。
    // A backtest is heavy work returned synchronously (the backend 429s concurrent
    // ones); several years of candles against a multi-condition strategy can
    // plainly outrun the global 30s default, so it gets three minutes of its own.
    // Not unlimited: a genuine hang still needs an end, or the "backtesting"
    // spinner runs forever.
    request<StrategyBacktestResult>('/strategies/backtest', {
      method: 'POST',
      body: JSON.stringify(payload),
      requestTimeoutMs: 180_000,
    }),
  // 回测图的 K 线。必须用这条而不是 chartApi.history：后者读的是内存缓存（最近
  // 500 根），与回测按 days 窗口从 Candle 表取的那一段范围不同，交易标记会大量
  // 落在蜡烛范围之外——这条与回测在后端共用同一个取数函数。
  // Candles for the backtest chart. Must be this and not chartApi.history: that
  // one reads the in-memory cache (newest 500 bars), a different range than the
  // `days` window the backtest pulls from the Candle table, leaving most trade
  // markers outside the charted candles. This shares the backend's single
  // bar-loading function with the backtest itself.
  backtestBars: (symbol: string, interval: string, days: number) =>
    request<{ symbol: string; interval: string; days: number; bars: Candle[] }>(
      `/strategies/backtest/bars?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&days=${days}`
    ),
  // 单个策略的绩效。回测面板用它与刚跑完的回测并排对比，那里只关心当前这一条。
  // One strategy's performance. The backtest panel uses this to sit beside the
  // run it just made, where only the current strategy matters.
  performance: (id: string) =>
    request<StrategyPerformance>(`/strategies/${encodeURIComponent(id)}/performance`),
  // 全部策略的绩效，一次取回。策略列表要的是"每张卡片都有绩效"，逐个调
  // performance(id) 会让请求数随策略数线性增长。
  // Every strategy's performance in one call. The list needs a figure on each
  // card, and calling performance(id) per strategy grows the request count
  // linearly with the number of strategies.
  allPerformance: () =>
    request<{ performance: StrategyPerformance[] }>('/strategies/performance'),
  signals: (limit = 50) => request<{ signals: StrategySignal[] }>(`/strategies/signals?limit=${limit}`),
  clearSignals: () => request<{ ok: boolean }>('/strategies/signals', { method: 'DELETE' }),
}

// 多账号 / Multi-account
export const accountApi = {
  // accountLimit：当前订阅等级最多可连接的账户数，null 表示不限；brokerLock：合作券商限制展示信息
  // accountLimit: max accounts for the current plan (null = unlimited); brokerLock: partner-broker lock info
  list: () => request<{ accounts: MT5Account[]; accountLimit: number | null; brokerLock: BrokerLock }>('/bridge/accounts'),
  setSuffix: (login: string, symbolSuffix: string) =>
    request<{ ok: boolean; login: string; symbolSuffix: string }>('/bridge/accounts/suffix', {
      method: 'POST',
      body: JSON.stringify({ login, symbolSuffix }),
    }),
  remove: (login: string, server?: string | null) =>
    request<{ ok: boolean }>(
      `/bridge/accounts/${encodeURIComponent(login)}${server ? `?server=${encodeURIComponent(server)}` : ''}`,
      { method: 'DELETE' }
    ),
}

// Bridge 版本状态：该用户最近上报的版本 + 当前最新发布版本，用在下载页和
// 绑定页展示最新版号。current 为 null 表示该用户从未连过带版本号上报的 Bridge。
// Bridge version status: this user's most recently reported version + the
// current latest release, shown on the download and bind pages.
// current is null if this user has never connected a version-reporting Bridge.
export const bridgeVersionApi = {
  status: () => request<{ current: string | null; latest: string | null; downloadUrl: string | null }>('/bridge/version-status'),
}

// API Token（连接 MT5 用）：库中只存哈希，明文仅在重置（生成）响应中出现一次。
// API token for connecting MT5: only the hash is stored; the plaintext
// appears once in the reset (generation) response.
export const eaApi = {
  getToken: () => request<{ apiToken: string | null; boundAccount: string | null }>('/ea/token'),
  resetToken: () => request<{ apiToken: string }>('/ea/token/reset', { method: 'POST' }),
}

// Gateway API（Make Capital 用户通过 Gateway 连接 MT5，无需本地 Bridge）
// Gateway API for Make Capital users — no local Bridge required
export const gatewayApi = {
  // 只能用 MT5 **主密码**。这里曾经有个 investorOnly 参数（前端从不传 true，
  // 但它在请求体里）：投资者密码是券商侧的只读凭证，而直连绑定成功后所有操作
  // 都由平台的 manager 代劳、不再校验任何密码，用它绑定等于把"只能看"换成
  // "能下单"。后端已经把这个字段整个删掉了。
  // Main password only. This used to take an `investorOnly` flag that the UI
  // never set to true but that sat in the request body: the investor password is
  // read-only at the broker, yet nothing re-checks a password after a successful
  // bind, so it silently upgraded read-only access to order placement. The
  // backend no longer accepts the field.
  verify: (login: number, password: string) =>
    request<{
      ok: boolean; valid: boolean; retcode: string
      login: number; name: string; group: string
      leverage: number; balance: number; equity: number
    }>('/gateway/verify', {
      method: 'POST',
      body: JSON.stringify({ login, password }),
    }),
  list: () =>
    request<{ accounts: Array<{ login: string; source: string; accountName: string; balance: number; equity: number; leverage: number; needsReverify: boolean; revokedReason: string }> }>('/gateway/accounts'),
  refresh: (login: string) =>
    request<{ login: string; balance: number; equity: number }>(`/gateway/account/${login}/refresh`, { method: 'POST' }),
  remove: (login: string) =>
    request<{ ok: boolean }>(`/gateway/account/${login}`, { method: 'DELETE' }),
}

// 账户信息 / User account (profile, password)
export const userApi = {
  me: () =>
    request<{
      id: string
      email: string
      plan: UserPlan
      planExpiresAt: string | null
      // 当前 PRO 是否为免费试用（区别于正式付费/管理员赠送）
      // whether the current PRO is a free trial (vs. paid or admin-granted)
      planIsTrial: boolean
      hasPassword: boolean
      createdAt: string | null
      mt5Accounts: Array<{
        login: string
        server: string | null
        accountName: string | null
        accountCurrency: string | null
        balance: number | null
        equity: number | null
        leverage: number | null
        company: string | null
        online: boolean
      }>
      // 游戏化（设计 §6/§11）：功能是否对该用户可见 + 4 个资料字段，供前端
      // 一次性拿到而不必再单独请求 /gamification/me。
      // Gamification: whether the feature is visible to this user, plus 4
      // profile fields, in one round trip instead of a separate /gamification/me call.
      gamificationVisible: boolean
      leaderboardVisible: boolean
      // 比赛（Phase 3）对该用户是否可见（内测开关，独立于上面两个——见后端
      // GamificationSettings.competitionsVisible）。同样只在 refreshUser()
      // 之后才会补上，先例同 gamificationVisible/leaderboardVisible。
      // Whether competitions (Phase 3) are visible to this user (a beta gate
      // independent of the two above — see the backend's
      // GamificationSettings.competitionsVisible). Likewise only filled in by
      // refreshUser(); same precedent as gamificationVisible/leaderboardVisible.
      competitionsVisible: boolean
      nickname: string | null
      // 是否还欠一个昵称（全员必填）。搭这趟车是为了强制上线时已经登录的会话——
      // 他们缓存的 user 里没有这个键，只有 refreshUser() 能补上（见后端注释）。
      // Whether a nickname is still owed (required of everyone). Rides along to
      // catch sessions that predate the rollout, whose cached user lacks the key.
      needsNickname: boolean
      nicknamePublic: boolean
      leaderboardOptOut: boolean
      equippedBadge: string | null
      // 等级/称号（§7）：只在 gamificationVisible 为真时后端才会算，否则是
      // null——用户菜单角标靠这两个字段渲染，不用再单独请求 gamificationApi.me()。
      // Level/title (§7): the backend only computes these when
      // gamificationVisible is true for this user, else null — the user-menu
      // badge renders off these two fields with no extra gamificationApi.me() call.
      gamificationLevel: number | null
      gamificationTitle: string | null
      // 公开主页（2026-09-07）：publicId 拼「查看我的公开主页」链接；statsPublic 是交易画像开关。
      // Public profile: publicId builds the "view my public profile" link; statsPublic is the stats switch.
      publicId: string | null
      statsPublic: boolean
      // 邀请链接「代理」入口开关（见 User.isAgent）/ invite-link agent entry flag
      isAgent: boolean
    }>('/auth/me'),
  // 游戏化资料局部更新：昵称/榜单展示/退出排行榜/佩戴勋章，只改传了的字段。
  // Partial update of the gamification profile: nickname / leaderboard display /
  // leaderboard opt-out / equipped badge — only the fields actually sent change.
  updateProfile: (payload: ProfilePatch) =>
    request<ProfileOut>('/auth/profile', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  // 后端会在改密时让所有旧 token 失效（见 account.py 的说明），并随响应
  // 带回一个已盖新会话版本号的 token——调用方必须用它替换本地 token，
  // 否则这次请求自己带的旧 token 也已失效，下一个请求会被 401 踢出登录。
  // The backend invalidates every old token on a password change (see
  // account.py's docstring) and returns a freshly stamped one in the
  // response — callers must swap it into local storage, or even this
  // request's own (now-invalidated) token will 401 on the very next call.
  changePassword: (oldPassword: string | null, newPassword: string) =>
    request<{ ok: boolean; token: string }>('/auth/password', {
      method: 'POST',
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    }),
  // 跨设备同步的界面偏好 / cross-device UI prefs
  getPrefs: () => request<{ data: Record<string, unknown> }>('/auth/prefs'),
  // 只传发生变化的那一个命名空间，服务端合并进已存文档（不再整份覆盖），
  // 返回/推送的都是合并后的完整文档。见后端 account.py 的 UserPrefsIn 说明。
  // Only the namespace that changed; the server merges it into the stored
  // document (no longer a full overwrite); the response/push both carry the
  // merged, complete document. See the backend's UserPrefsIn docstring.
  putPrefs: (namespace: string, data: Record<string, unknown>) =>
    request<{ data: Record<string, unknown> }>('/auth/prefs', {
      method: 'PUT',
      body: JSON.stringify({ namespace, data }),
    }),
}

// 通知 / Notifications
export interface NotifPrefsPayload {
  enabled: boolean
  selected_categories: string[]
  selected_symbols: string[]
  event_types: string[]
  // 推送时段（用户本地 "HH:MM"），两者都设置才生效；null = 不限制。
  // Push window (user-local "HH:MM"); active only when both set, null = no limit.
  push_window_start: string | null
  push_window_end: string | null
  push_window_tz: string | null
}

export const notificationApi = {
  getPrefs: () => request<NotifPrefsPayload>('/notifications/prefs'),
  // eventTypes：账户/交易事件白名单（订单成交/拒绝、自动仓管触发、Bridge 掉线、
  // 我的策略信号），与 selectedCategories/selectedSymbols（信号策略类别·品种
  // 白名单）是独立设置——后两者按"与"关系联合过滤同一条信号推送。
  // window：推送时段。不传 = 后端保留已存的时段（铃铛快捷开关等调用方不用管它）；
  // 传 { start: null, end: null } = 显式清除限制。
  // eventTypes: account/trading event whitelist (order fill/reject, auto-manage
  // trigger, bridge offline, my strategy signals) — independent from
  // selectedCategories/selectedSymbols (the signal strategy-category & symbol
  // whitelists, ANDed together to gate the same signal push).
  // window: push time-range. Omitted = the backend keeps whatever is stored
  // (quick-toggle callers never think about it); { start: null, end: null } =
  // explicitly clear the restriction.
  putPrefs: (
    enabled: boolean,
    selectedCategories: string[],
    eventTypes: string[] = [],
    selectedSymbols: string[] = [],
    window?: { start: string | null; end: string | null; tz: string | null },
  ) =>
    request<NotifPrefsPayload>('/notifications/prefs', {
      method: 'PUT',
      body: JSON.stringify({
        enabled,
        selected_categories: selectedCategories,
        selected_symbols: selectedSymbols,
        event_types: eventTypes,
        ...(window !== undefined
          ? {
              push_window_start: window.start,
              push_window_end: window.end,
              push_window_tz: window.tz,
            }
          : {}),
      }),
    }),
  getIndicators: () => request<string[]>('/notifications/indicators'),
  getSymbols: () => request<string[]>('/notifications/symbols'),
  // 站内通知（铃铛面板的「消息」段）。unreadCount 数的是全部未读，不是本页——
  // 角标在只取 20 条时也得是对的。
  // In-app feed for the bell panel. unreadCount covers every unread row, not just
  // the returned page: the badge must be right while the list is capped.
  feed: (limit = 20) => request<NotificationFeed>(`/notifications/feed?limit=${limit}`),
  markFeedRead: (id: string) =>
    request<{ ok: boolean }>(`/notifications/feed/${encodeURIComponent(id)}/read`, { method: 'POST' }),
  // 清空本人的站内通知（不动公告）。 / Delete this user's feed rows (announcements untouched).
  clearFeed: () => request<{ cleared: number }>('/notifications/feed', { method: 'DELETE' }),
  // 一键已读：站内通知与已发布公告一起清。两者在用户眼里是同一个「通知」面板，
  // 所以是一个接口而不是两个。
  // Mark all read across both the feed and published announcements — one endpoint,
  // because the user pressed the button on one "notifications" panel.
  readAll: () =>
    request<{ announcements: number; notifications: number }>('/notifications/read-all', { method: 'POST' }),
}

// 游戏化（设计 §6/§11）：等级/任务/勋章/胜率一次性拿全 / gamification: level,
// tasks, badges, win rate in one call
export const gamificationApi = {
  me: () => request<GamificationMe>('/gamification/me'),
  // 仪表盘胜率卡的轻量并行端点（设计 §2.4/§7）：独立于 me()，服务端 60 秒
  // 缓存——可以放心跟随现有 45 秒胜率轮询一起拉，不会每次都触发整仓重算。
  // Lightweight, parallel endpoint for the dashboard win-rate card (§2.4/§7):
  // separate from me(), 60s server-side cached — safe to poll alongside the
  // existing 45s win-rate cadence without re-triggering a full recompute.
  winrateSummary: () => request<GamificationWinRateSummary>('/gamification/winrate-summary'),
  // 排行榜（设计 §4.3）：period 既接受 "week"/"month"（当前进行中周期），也
  // 接受显式周期 key（如 "2026-W36"）访问已封存的历史周期。403 = 内测未开放
  // （见 gamification.admin.leaderboardSwitch）。
  // Leaderboard: period accepts either "week"/"month" (the current
  // in-progress period) or an explicit period key (e.g. "2026-W36") to reach
  // a sealed historical period. 403 = beta not yet open (see
  // gamification.admin.leaderboardSwitch).
  leaderboard: (board: LeaderboardBoard, period: string) =>
    request<LeaderboardPayload>(
      `/gamification/leaderboard?board=${encodeURIComponent(board)}&period=${encodeURIComponent(period)}`
    ),
  // 公开主页（2026-09-07）：404 = 不存在或已退榜（后端不区分）；403 同排行榜的内测门控。
  // Public profile: 404 = unknown or opted out (indistinguishable by design); 403 = same beta gate as the leaderboard.
  profile: (publicId: string) => request<PublicProfile>(`/gamification/profile/${encodeURIComponent(publicId)}`),
}

// 交易比赛（设计 §1.7/§1.8/§1.9，Phase 3）：用户端公开列表/详情/报名。
// 403 = 内测未开放（见 gamification.admin.competitionsSwitch）。
// Trading competitions (Phase 3): user-facing public list/detail/register.
// 403 = beta not yet open (see gamification.admin.competitionsSwitch).
export const competitionApi = {
  list: () => request<CompetitionListGrouped>('/competitions'),
  detail: (id: string) => request<CompetitionDetail>(`/competitions/${encodeURIComponent(id)}`),
  register: (id: string, mt5Login: string) =>
    request<CompetitionRegisterResult>(`/competitions/${encodeURIComponent(id)}/register`, {
      method: 'POST',
      body: JSON.stringify({ mt5Login }),
    }),
}

// 工单 / Tickets
export const ticketApi = {
  list: () => request<TicketListItem[]>('/tickets'),
  get: (id: string) => request<Ticket>(`/tickets/${encodeURIComponent(id)}`),
  // 用户不设优先级：后端默认 normal，之后由管理员在后台判定。
  // Users don't set priority: the backend defaults to normal and admins triage it later.
  create: (payload: { title: string; category: TicketCategory; body: string }) =>
    request<Ticket>('/tickets', { method: 'POST', body: JSON.stringify(payload) }),
  reply: (id: string, body: string, reopen = false) =>
    request<Ticket>(`/tickets/${encodeURIComponent(id)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ body, reopen }),
    }),
}

// 公告（用户端）/ announcements, user side
export const announcementApi = {
  list: () => request<AnnouncementList>('/announcements'),
  // 打开详情即记已读，由后端完成 / opening marks it read on the backend
  get: (id: string) => request<Announcement>(`/announcements/${encodeURIComponent(id)}`),
  // 当前该弹的那条；没有可弹的时候后端回 null，不是 404。
  // The one to pop right now; the backend answers null, not 404, when there is none.
  popup: () => request<AnnouncementPopup | null>('/announcements/popup'),
  // 「7 天不再提醒」。天数由后端定死，前端不传——传了就等于把静音时长交给客户端。
  // "Don't remind me for 7 days". The server owns the number; sending one from
  // here would hand the client control of how long it stays quiet.
  snoozePopup: (id: string) =>
    request<{ ok: boolean; days: number }>(`/announcements/${encodeURIComponent(id)}/popup-snooze`, { method: 'POST' }),
}

// 看板与页面统计共用的时间范围参数：预设传 range=，自定义传 from=&to=。
// 预设换算在后端（本周从周一起之类的规则要能被 pytest 钉住）。
// Shared range query for the dashboard endpoints; presets resolve server-side.
function statsRangeQs(range: StatsRangeQuery): string {
  const qs = new URLSearchParams()
  if ('preset' in range) qs.set('range', range.preset)
  else {
    qs.set('from', range.from)
    qs.set('to', range.to)
  }
  return `?${qs.toString()}`
}

// 管理后台 / Admin
export const adminApi = {
  listAnnouncements: () => request<AnnouncementList>('/admin/announcements'),
  createAnnouncement: (payload: AnnouncementInput) =>
    request<Announcement>('/admin/announcements', { method: 'POST', body: JSON.stringify(payload) }),
  updateAnnouncement: (id: string, payload: AnnouncementInput) =>
    request<Announcement>(`/admin/announcements/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteAnnouncement: (id: string) =>
    request<{ ok: boolean }>(`/admin/announcements/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  // 一键翻译：按顺序返回同长度数组 / one-click translation, same length and order back
  translate: (texts: string[], target: 'en' | 'zh') =>
    request<{ texts: string[] }>('/admin/announcements/translate', { method: 'POST', body: JSON.stringify({ texts, target }) }),
  translateStatus: () => request<{ configured: boolean }>('/admin/announcements/translate/status'),
  pageStats: (range: StatsRangeQuery) => request<AdminPageStats>(`/admin/page-stats${statsRangeQs(range)}`),
  overview: (range: StatsRangeQuery) => request<AdminOverview>(`/admin/overview${statsRangeQs(range)}`),
  netQuality: () => request<AdminNetQuality>('/admin/net-quality'),
  // 潜在转化客户名单。**不带范围参数**：口径固定是"本周（周一起）到今天"，
  // 与看板顶部的时间范围无关（历史区间里的冷线索没有联系价值）。
  // Warm-lead list; deliberately range-free — always this week up to today.
  potentialCustomers: (limit = 200) =>
    request<AdminPotentialCustomers>(`/admin/potential-customers?limit=${limit}`),
  // 交易员等级分布与逐级名单。statsRangeQs 一定带出 `?`，所以后面用 `&` 拼。
  // Trader levels; statsRangeQs always yields a leading `?`, hence the `&`.
  traderLevels: (range: StatsRangeQuery) =>
    request<AdminTraderLevels>(`/admin/trader-levels${statsRangeQs(range)}`),
  traderLevelUsers: (level: number, range: StatsRangeQuery, scope: 'all' | 'range' = 'all', limit = 200) =>
    request<AdminTraderLevelUsers>(
      `/admin/trader-levels/${level}/users${statsRangeQs(range)}&scope=${scope}&limit=${limit}`,
    ),
  // 策略 × 交易时段胜率（默认近 7 天）。时段窗口由后端随数据一起返回，前端不
  // 复制一份小时区间——夏令时的正确性只能在后端保证。
  // Per-strategy, per-session win rate (last 7 days by default). The session
  // windows ship with the payload rather than being duplicated here: only the
  // backend can get DST right.
  strategyWinrate: (days = 7) => request<AdminStrategyWinRate>(`/admin/strategy-winrate?days=${days}`),
  // signal 透传：用户表支持搜索 + 翻页，连点时先发的响应后到就会覆盖后发的结果。
  // 调用方（AdminPage.load）每次发起新查询时中止上一次，从源头消掉这个竞态。
  // The signal is forwarded because this table is searched and paged: with rapid
  // clicks an earlier response can land after a later one and overwrite it.
  // AdminPage.load aborts the previous query on every new one, killing the race
  // at the source rather than filtering stale results afterwards.
  listUsers: (
    // inviteCode: 传某条链接的 code 只看它带来的人；传 'none' 只看完全没有归因的人
    // （真码是 8 位、字母表里没有 o，'none' 永远撞不上）。
    // inviteCode: a link's code shows only its signups; 'none' shows only
    // unattributed users (real codes are 8 chars from an alphabet without "o").
    params: { q?: string; plan?: string; role?: string; inviteCode?: string; limit?: number; offset?: number } = {},
    signal?: AbortSignal,
  ) => {
    const qs = new URLSearchParams()
    if (params.q) qs.set('q', params.q)
    if (params.plan) qs.set('plan', params.plan)
    if (params.role) qs.set('role', params.role)
    if (params.inviteCode) qs.set('inviteCode', params.inviteCode)
    if (params.limit) qs.set('limit', String(params.limit))
    if (params.offset) qs.set('offset', String(params.offset))
    const suffix = qs.toString() ? `?${qs.toString()}` : ''
    return request<{ users: AdminUser[]; total: number; limit: number; offset: number }>(`/admin/users${suffix}`, { signal })
  },
  updateUser: (
    userId: string,
    payload: Partial<{ role: UserRole; plan: UserPlan; planExpiresAt: string | null; planNote: string | null; inviteCode: string | null }>
  ) =>
    request<AdminUser>(`/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  bulkUpdateUsers: (
    userIds: string[],
    // inviteCode: 传 code = 改挂到那条链接下；显式传 null = 清除归因；不传 = 不动。
    // inviteCode: a code reassigns, explicit null clears, omitted leaves it alone.
    payload: Partial<{ role: UserRole; plan: UserPlan; planExpiresAt: string | null; planNote: string | null; inviteCode: string | null }>
  ) =>
    request<{ updated: number }>('/admin/users/bulk', {
      method: 'PATCH',
      body: JSON.stringify({ userIds, ...payload }),
    }),
  // ---- 停用 / 恢复账号 / disable & restore an account ----
  //
  // ⚠️ 路径与请求体是与后端**口头约定**的形状，后端实现时如有出入，改这两处即可
  // （调用点只认这两个函数）。约定：
  //   POST /admin/users/{id}/disable   body { reason: string }
  //   POST /admin/users/{id}/enable    无 body / no body
  // 返回值按本文件里 updateUser 的先例声明为整行 AdminUser；但调用点**不假定**
  // 一定拿得到（见 AdminPage 的 applyDisabled），响应不是一行用户就退回重新拉表，
  // 所以后端即使返回 `{ok:true}` 或 204 也不会把界面弄坏。
  //
  // ⚠️ These paths and bodies are the shape *agreed verbally* with the backend;
  // if the implementation differs, only these two functions need changing (call
  // sites know nothing else). Return values are declared as a whole AdminUser
  // row following updateUser's precedent above, but the call site does not
  // assume one arrives (see applyDisabled in AdminPage): anything that isn't a
  // user row falls back to refetching the table, so a backend returning
  // `{ok:true}` or 204 still leaves the UI correct.
  disableUser: (userId: string, reason: string) =>
    request<AdminUser | null>(`/admin/users/${encodeURIComponent(userId)}/disable`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  enableUser: (userId: string) =>
    request<AdminUser | null>(`/admin/users/${encodeURIComponent(userId)}/enable`, {
      method: 'POST',
    }),
  // 邀请链接 / invite links
  listInviteLinks: () => request<{ links: InviteLink[] }>('/admin/invite-links'),
  createInviteLink: (label: string) =>
    request<InviteLink>('/admin/invite-links', {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),
  updateInviteLink: (id: string, payload: Partial<{ label: string; isActive: boolean; grantsTrial: boolean }>) =>
    request<InviteLink>(`/admin/invite-links/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  // 代理指派：两边都回整条链接（含最新 agents），面板直接替换那一行。
  // Agent assignment: both return the full link (fresh agents) so the panel swaps the row.
  assignInviteAgent: (id: string, userId: string) =>
    request<InviteLink>(`/admin/invite-links/${encodeURIComponent(id)}/agents`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  unassignInviteAgent: (id: string, userId: string) =>
    request<InviteLink>(`/admin/invite-links/${encodeURIComponent(id)}/agents/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
    }),
  getSettings: () => request<AdminBrokerSettings>('/admin/settings'),
  updateSettings: (payload: AdminBrokerSettings) =>
      request<AdminBrokerSettings>('/admin/settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    getPricing: () => request<AdminPricingSettings>('/admin/pricing'),
    updatePricing: (payload: AdminPricingSettings) =>
      request<AdminPricingSettings>('/admin/pricing', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    getTrial: () => request<AdminTrialSettings>('/admin/trial'),
    updateTrial: (payload: AdminTrialSettings) =>
      request<AdminTrialSettings>('/admin/trial', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    getEmailGate: () => request<AdminEmailGateSettings>('/admin/email-gate'),
    updateEmailGate: (payload: AdminEmailGateSettings) =>
      request<AdminEmailGateSettings>('/admin/email-gate', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    getSocial: () => request<AdminSocialSettings>('/admin/social'),
    updateSocial: (payload: AdminSocialSettings) =>
      request<AdminSocialSettings>('/admin/social', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    getCandleHistory: () => request<AdminCandleSettings>('/admin/candle-history'),
    updateCandleHistory: (payload: AdminCandleSettings) =>
      request<AdminCandleSettings>('/admin/candle-history', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    // 胜率公开名单：读接口带上每个策略的胜率供管理员判断，写接口只收名单。
    // Win-rate whitelist: the read carries each strategy's rate so the admin can
    // decide; the write takes only the list.
    getWinrateSettings: () => request<AdminWinrateSettings>('/admin/winrate-settings'),
    updateWinrateSettings: (publicStrategies: string[]) =>
      request<AdminWinrateSettings>('/admin/winrate-settings', {
        method: 'PUT',
        body: JSON.stringify({ publicStrategies }),
      }),
    getStrategySettings: () => request<AdminStrategySettings>('/admin/strategy-settings'),
    updateStrategySettings: (payload: AdminStrategySettings) =>
      request<AdminStrategySettings>('/admin/strategy-settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      }),
    // 平台策略介绍：含未发布草稿，整表覆盖保存（后端按 id 唯一性校验）
    // Platform strategy write-ups: includes unpublished drafts; saved as a whole
    // list (the backend rejects duplicate ids)
    getPlatformStrategies: () => request<{ items: PlatformStrategy[] }>('/admin/platform-strategies'),
    updatePlatformStrategies: (items: PlatformStrategy[]) =>
      request<{ items: PlatformStrategy[] }>('/admin/platform-strategies', {
        method: 'PUT',
        body: JSON.stringify({ items }),
      }),
    // 上传策略配图，返回可直接用于 <img src> 的公开 URL。后端按文件头校验类型，
    // 未配置存储时返回 503（管理员改用外链地址即可）。
    // Upload a strategy illustration and get a public URL for <img src>. The
    // backend validates the type by magic bytes and returns 503 when storage
    // isn't configured (admins can paste an external URL instead).
    uploadImage: (file: File) => {
      const form = new FormData()
      form.append('file', file)
      // 超时放宽到 2 分钟：全局的 30 秒计的是"到响应头为止"，而上传要把整个文件
      // 推上去才会有响应头——手机热点上一张几 MB 的插图很容易超过 30 秒，那会
      // 表现成"传了一半说超时"，而文件其实一点问题没有。
      // Two minutes: the global 30s measures time-to-response-headers, and an
      // upload only gets headers after the whole body is on the wire — a
      // multi-megabyte illustration over a phone hotspot passes 30s easily, which
      // would read as "it timed out halfway" for a perfectly fine file.
      return request<{ url: string }>('/admin/upload-image', {
        method: 'POST',
        body: form,
        requestTimeoutMs: 120_000,
      })
    },
    // ---- 工单管理 / Ticket management ----
    // signal 透传：两个筛选下拉快速切换时，先发的响应后到会覆盖当前筛选的结果
    // （表格与筛选条对不上）。同 listUsers。
    // Signal forwarded for the same reason as listUsers: flipping the two filter
    // selects quickly lets an earlier response land last and leaves the table
    // disagreeing with the filter bar.
    listTickets: (
      params: { status?: string; category?: string; limit?: number; offset?: number } = {},
      signal?: AbortSignal,
    ) => {
      const qs = new URLSearchParams()
      if (params.status) qs.set('status', params.status)
      if (params.category) qs.set('category', params.category)
      if (params.limit) qs.set('limit', String(params.limit))
      if (params.offset) qs.set('offset', String(params.offset))
      const suffix = qs.toString() ? `?${qs.toString()}` : ''
      return request<TicketListItem[]>(`/admin/tickets${suffix}`, { signal })
    },
    getTicket: (id: string) => request<Ticket>(`/admin/tickets/${encodeURIComponent(id)}`),
    replyTicket: (id: string, body: string, opts?: { status?: TicketStatus; priority?: TicketPriority }) =>
      request<Ticket>(`/admin/tickets/${encodeURIComponent(id)}/reply`, {
        method: 'POST',
        body: JSON.stringify({ body, ...opts }),
      }),
    updateTicket: (id: string, patch: { status?: TicketStatus; priority?: TicketPriority }) =>
      request<Ticket>(`/admin/tickets/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    // ---- 游戏化管理 / Gamification admin ----
    // 用户检查器：目标用户的完整游戏化面板（含 email），触发一次真实判定
    // （同 60 秒节流）。User inspector: the target user's full gamification
    // panel (with email), triggering a real judging pass (same 60s throttle).
    gamificationUser: (id: string) =>
      request<GamificationMe & { email: string }>(`/admin/gamification/user/${encodeURIComponent(id)}`),
    gamificationVisibility: () => request<{ userVisible: boolean }>('/admin/gamification/visibility'),
    // 只升不降、发出不收回：一旦对用户开放就不再提供关闭接口，前端确认文案见
    // gamification.admin.confirmOpen。Up only, never revoked: once opened there
    // is no path back to closed; the confirmation copy is gamification.admin.confirmOpen.
    setGamificationVisibility: (userVisible: boolean) =>
      request<{ userVisible: boolean }>('/admin/gamification/visibility', {
        method: 'PATCH',
        body: JSON.stringify({ userVisible }),
      }),
    // 设置组（Phase 2）：与上面的 /visibility 共用同一份存储记录，读-合并-写
    // 语义组合，互不清空对方的键。Settings group (Phase 2): shares the same
    // stored record as /visibility above, composed via read-merge-write
    // semantics so neither clobbers the other's keys.
    gamificationSettings: () => request<GamificationSettings>('/admin/gamification/settings'),
    updateGamificationSettings: (patch: GamificationSettingsPatch) =>
      request<GamificationSettings>('/admin/gamification/settings', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    // 榜单预览：以请求管理员为 viewer，不受 leaderboardVisible 开关限制。
    // Leaderboard preview: the requesting admin is the viewer; not gated by
    // the leaderboardVisible switch.
    gamificationLeaderboard: (board: LeaderboardBoard, period: string) =>
      request<LeaderboardPayload>(
        `/admin/gamification/leaderboard?board=${encodeURIComponent(board)}&period=${encodeURIComponent(period)}`
      ),
    // ---- 比赛管理（Phase 3）/ Competition admin (Phase 3) ----
    // 全部比赛（含 draft），按创建时间倒序，每条带参赛数。
    // Every competition (draft included), newest-created first, with a participant count each.
    competitions: () => request<CompetitionAdminRow[]>('/admin/competitions'),
    createCompetition: (payload: CompetitionCreate) =>
      request<CompetitionAdminRow>('/admin/competitions', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    // draft 状态下全字段可改；非 draft 状态仅文案 + 报名窗口可改，其余字段一律
    // 400（后端强制）；status 只能按 draft→upcoming→running→ended 相邻推进。
    // In draft, every field is editable; once non-draft only copy + the
    // registration window remain editable (anything else 400s server-side);
    // status only advances one adjacent step at a time.
    updateCompetition: (id: string, patch: CompetitionPatch) =>
      request<CompetitionAdminRow>(`/admin/competitions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    // 删除一场比赛，连同参赛行/基线/快照。只有 draft / upcoming 可删，开赛之后
    // 后端一律 400（内测期曾放开到任何状态，上线前收回）。
    // Deletes a competition with its participants/baselines/snapshots. Only draft /
    // upcoming may be deleted; anything started is refused server-side (400).
    deleteCompetition: (id: string) =>
      request<{ deleted: string; participants: number }>(
        `/admin/competitions/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ),
    competitionParticipants: (id: string) =>
      request<ParticipantAdminRow[]>(`/admin/competitions/${encodeURIComponent(id)}/participants`),
    // 取消/恢复参赛资格。compId/pid 顺序与路径 /admin/competitions/{compId}/participants/{pid} 一致。
    // Disqualify/restore a participant. compId/pid order matches the path
    // /admin/competitions/{compId}/participants/{pid}.
    updateParticipant: (compId: string, pid: string, patch: ParticipantPatch) =>
      request<ParticipantAdminRow>(
        `/admin/competitions/${encodeURIComponent(compId)}/participants/${encodeURIComponent(pid)}`,
        { method: 'PATCH', body: JSON.stringify(patch) }
      ),
    // 终审：仅 status=="ended" 的比赛可调用，不可重跑（后端以 status 为闸）。
    // 名次永久定格并自动发奖——见 competition.admin.settleConfirm 的确认文案。
    // Settle: only callable on status=="ended" competitions, not re-runnable
    // (gated by status server-side). Ranks lock in permanently and prizes are
    // awarded automatically — see the competition.admin.settleConfirm copy.
    // 立即重算这场比赛的榜单快照（跳过 20 秒节流）。只对进行中的比赛有效，
    // 其余状态返回 refreshed:false。
    // Recompute this competition's board snapshot now (bypassing the 20s throttle).
    // Only effective while running; other statuses return refreshed:false.
    refreshCompetitionBoard: (id: string) =>
      request<{ refreshed: boolean; status: string }>(
        `/admin/competitions/${encodeURIComponent(id)}/refresh`,
        { method: 'POST' },
      ),
    // 三道闸都在后端：必须 ended、必须过 24 小时宽限期、不可重跑。内测期的
    // force=true 已移除。
    // All three gates are server-side: must be ended, the 24h grace period must have
    // passed, not re-runnable. The beta-era force=true is gone.
    settleCompetition: (id: string) =>
      request<CompetitionSettleResult>(
        `/admin/competitions/${encodeURIComponent(id)}/settle`,
        { method: 'POST' },
      ),
    // 实时榜预览：以请求管理员为 viewer，形状与用户端 LeaderboardPayload 一致。
    // Live board preview: the requesting admin is the viewer; same shape as the user-facing LeaderboardPayload.
    competitionBoard: (id: string) =>
      request<LeaderboardPayload>(`/admin/competitions/${encodeURIComponent(id)}/board`),
  }

// 自动仓位管理（PRO）/ auto position management (PRO)
export const automationApi = {
  getSettings: () => request<AutoManageSettings>('/automation/settings'),
  putSettings: (payload: AutoManageSettings) =>
    request<AutoManageSettings>('/automation/settings', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
}

// 社区多空情绪：读后端缓存（数据源见后端 sentiment_store.py 说明）
// Community sentiment: reads the backend's cache (data source documented in
// the backend's sentiment_store.py)
export const sentimentApi = {
  get: () =>
    request<{ sentiment: Record<string, SentimentRatio>; updatedAt: number | null; stale: boolean }>(
      '/sentiment'
    ),
}

// 支付（NOWPayments 加密货币）/ Payments (NOWPayments crypto)
export const paymentApi = {
  getPlans: () =>
    request<{
      plans: Array<{ id: string; name: string; price_usd: number; original_price_usd?: number | null; days: number; tag?: string }>
      sale?: { percent: number; badge: string; end_at: string; monthly: number; yearly: number } | null
      // 公开试用事实（见后端 get_plans 的注释）/ public trial facts
      trial?: { enabled: boolean; days: number }
    }>('/payments/plans'),
  getCurrencies: () => request<{ currencies: string[] }>('/payments/currencies'),
  create: (plan: string, payCurrency: string) =>
    request<{
      id: string
      payment_id: string
      pay_address: string
      pay_amount: number
      pay_currency: string
      amount_usd: number
      plan: string
      status: string
      created_at: string
      valid_until: string | null
    }>('/payments/create', {
      method: 'POST',
      body: JSON.stringify({ plan, pay_currency: payCurrency }),
    }),
  status: (paymentId: string) =>
    request<{
      id: string
      payment_id: string
      pay_address: string
      pay_amount: number
      pay_currency: string
      amount_usd: number
      plan: string
      status: string
      // NOWPayments 报告的实际到账金额（同 pay_currency 计价）；null 表示
      // 尚无数据或从未同步过。低于 pay_amount 说明用户少转了。
      // Actual amount received (same currency as pay_currency), as reported
      // by NOWPayments; null means no data yet / never synced. Less than
      // pay_amount means the user under-sent.
      actually_paid: number | null
      finished_at: string | null
      created_at: string
    }>(`/payments/status/${paymentId}`),
  getTrial: () => request<TrialStatus>('/payments/trial'),
  claimTrial: () =>
    request<{ ok: boolean; planExpiresAt: string; days: number }>('/payments/trial/claim', {
      method: 'POST',
    }),
}

// 站点公开配置：不需要登录就能读的那部分平台设置（目前只有官方社交主页）。
// Public site config: platform settings readable without a login (today: social links).
export const siteApi = {
  // 后端只返回填了的平台，所以拿到的对象可能是空的——调用方用"有没有键"判断
  // 要不要渲染入口，不用再逐个比对空字符串。
  // The backend omits unset platforms, so this may come back empty — callers
  // decide whether to render by key presence, not by comparing empty strings.
  getSocial: () => request<SocialLinks>('/site/social'),
}

// 邀请链接的公开查询。只有 offer 一个方法——点击打点在 RefCapture 里用裸
// fetch 直发（那个端点一律 204 空体，request() 会去 JSON 解析而抛错）；本端点
// 有 JSON 响应体，所以照常走 request()。
// Public invite lookups. Only `offer` lives here: the click ping stays a raw
// fetch inside RefCapture because that endpoint answers 204 with an empty body,
// which request() would try to JSON-parse. This one returns JSON.
export const inviteApi = {
  getOffer: (code: string) =>
    request<{ trialDays: number | null }>(`/invite/offer?code=${encodeURIComponent(code)}`),
  // 点击打点：后端一律 204（防枚举），request 现在能处理空体。
  // Click tracking: always 204 server-side (anti-enumeration); request handles the empty body.
  click: (code: string) =>
    request<void>('/invite/click', { method: 'POST', body: JSON.stringify({ code }) }),
}

// 推送订阅 / Push subscriptions
export const pushApi = {
  getVapidKey: () => request<{ publicKey: string }>('/notifications/push/vapid-public-key'),
  subscribe: (endpoint: string, keys: { p256dh: string; auth: string }) =>
    request<{ ok: boolean }>('/notifications/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint, keys }),
    }),
  unsubscribe: (endpoint: string, keys: { p256dh: string; auth: string }) =>
    request<{ ok: boolean }>('/notifications/push/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ endpoint, keys }),
    }),
  // 诊断用：后端记录了几个订阅、其中是否包含本设备当前的 endpoint。
  // "浏览器里有订阅"与"后端收到了订阅"是两件事，分开查才能定位上报环节的问题。
  // Diagnostics: how many subscriptions the backend holds and whether this
  // device's current endpoint is among them. "The browser has a subscription"
  // and "the backend received it" are different things; querying them
  // separately is what pinpoints a broken reporting step.
  getStatus: (endpoint?: string) =>
    request<{ count: number; current_endpoint_registered: boolean }>(
      `/notifications/push/status${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`,
    ),
  // 给本账号所有设备发一条测试通知，端到端验证链路。
  // Send one test notification to every device on the account — end-to-end check.
  sendTest: () =>
    request<{ sent: number; failed: number; pruned: number }>('/notifications/push/test', {
      method: 'POST',
    }),
}

// 代理页（/agent）：只读。链接列表 + 某条链接的注册用户名单（分页）。
// 不是代理的人拿到空列表；不属于自己的链接一律 404。
// Agent view (/agent), read-only: my links + one link's paginated signup list.
// Non-agents get an empty list; links that aren't mine answer 404.
export const agentApi = {
  links: () => request<{ links: AgentLink[] }>('/agent/links'),
  linkUsers: (id: string, params: { limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams()
    if (params.limit) qs.set('limit', String(params.limit))
    if (params.offset) qs.set('offset', String(params.offset))
    const q = qs.toString()
    return request<AgentLinkUsers>(`/agent/links/${encodeURIComponent(id)}/users${q ? `?${q}` : ''}`)
  },
  // 看板与名单分开取：换时间范围只重拉看板，翻页只重拉名单。
  // Separate calls so a range change refetches only the chart and paging only the list.
  overview: (id: string, range: StatsRangeQuery) =>
    request<AgentOverview>(`/agent/links/${encodeURIComponent(id)}/overview${statsRangeQs(range)}`),
  setUserPlan: (id: string, body: AgentPlanChange) =>
    request<AgentLinkUser>(`/agent/links/${encodeURIComponent(id)}/users/plan`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
}
