import { Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { lazyRetry } from './utils/lazyRetry'
import { onIdle, shouldSkipPrefetch } from './utils/idle'
import { getToken } from './api/client'
import { pageFromPath, type PageId } from './seo/meta'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './store/auth'
import { PrefsProvider } from './store/prefs'
import { FestivalProvider, FESTIVAL_DEMO } from './festival/FestivalProvider'
import PwaBackGuard from './components/PwaBackGuard'
import ErrorBoundary from './components/ErrorBoundary'
import MetaPixel from './components/MetaPixel'
import RefCapture from './components/RefCapture'
import AccountDisabledGate from './components/AccountDisabledGate'
import PublicShell from './seo/PublicShell'
// 「成长」外壳不走 lazy：几十行的壳，三条路由共用，拆 chunk 只多一次往返。
// The Growth shell is not lazy: a few dozen lines shared by three routes —
// a separate chunk would only add a round trip.
import GrowthHub from './pages/GrowthHub'

// 路由级代码分割：首屏只加载当前页面的代码，其余按需加载（如图表页）。
// 用 lazyRetry 而不是裸 lazy：chunk 拉失败先重试、再整页重载一次，最后才弹卡。
// 大陆拉 Vercel 的 chunk 一次失败就弹「重新加载」卡，而用户点重载多半能成——
// 程序自己先试。见 utils/lazyRetry.ts。
// lazyRetry, not bare lazy: retry, then one reload, then the error card.
// Route-level code splitting: only the current page's code loads up front;
// heavy pages (e.g. the charts page) load on demand.
// 节日预览面板只在演示构建里加载。/ The festival preview panel only loads in demo builds.
const FestivalDemoPanel = lazyRetry(() => import('./festival/demo/DemoPanel'), 'FestivalDemoPanel')
// 可预加载的懒页面：用法与 lazyRetry 相同，多一个 preload()。
// 为什么不直接 lazyRetry：React.lazy 第一次渲染**必然** suspend 一次——哪怕 chunk
// 早已下载完，工厂返回的 Promise 也要等一个 microtask 才 resolve，而这一次 suspend
// 足以让 Suspense 把 createRoot 接管的预渲染 HTML 清成空白占位（公开页闪白的根源）。
// preload() 完成后，新挂载的实例直接渲染真组件，不经过 lazy，不 suspend。
// 每个挂载实例在首次渲染时就选定走哪条路（useState 初值），之后不再切换：否则
// 预取在页面已经经由 lazy 挂上之后才完成，下一次重渲染时元素类型从 Lazy 变成真组件，
// React 会把整页卸载重挂，状态全丢、请求全部重发。
// preload() 自身不重试、失败静默——真正渲染时 lazyRetry 那条路照旧负责重试与重载。
// A lazy page with a preload(). React.lazy always suspends on its first render,
// even for an already-downloaded chunk (the factory promise resolves a microtask
// later), and that one suspension is enough for Suspense to wipe the prerendered
// HTML that createRoot took over. Once preload() has finished, newly mounted
// instances render the real component directly. Each instance picks its path on
// first render and keeps it — switching Lazy → real component later would remount
// the page and lose its state. preload() neither retries nor throws to callers
// that ignore it; the lazyRetry path still owns retries when actually rendering.
type Preloadable<P> = ComponentType<P> & { preload: () => Promise<void> }
function lazyPage<P extends object>(
  factory: () => Promise<{ default: ComponentType<P> }>,
  name: string,
): Preloadable<P> {
  const Lazy = lazyRetry(factory, name) as unknown as ComponentType<P>
  let Loaded: ComponentType<P> | null = null
  let pending: Promise<void> | null = null
  const preload = () => {
    if (!pending) {
      pending = factory().then(
        (m) => {
          Loaded = m.default
        },
        (err) => {
          pending = null
          throw err
        },
      )
    }
    return pending
  }
  function Page(props: P) {
    const [Comp] = useState<ComponentType<P>>(() => Loaded ?? Lazy)
    return <Comp {...props} />
  }
  Page.displayName = `LazyPage(${name})`
  return Object.assign(Page, { preload })
}

// 主布局也懒加载：落地页 / 登录页 / 法务页的访客根本用不到它（以及它拉起的 LiveProvider、
// 通知铃铛、用户菜单……），不该让他们为此多下载、多解析一截入口包。加载中的占位就是外层
// Suspense 的 PageFallback，与原来切页时一致。登录后的直达与切页由下面的预取兜着，
// 避免「先等 Layout、再等页面」两段串行。
// The main layout is lazy too: landing / login / legal visitors never use it (nor the
// LiveProvider, bell and user menu it pulls in). While loading, the outer Suspense's
// PageFallback shows, as it always did on page switches. Direct entry and tab switches
// after login are covered by the warm-up/prefetch below, so Layout and the page load
// in parallel rather than one after the other.
const Layout = lazyPage(() => import('./components/Layout'), 'Layout')
const LandingPage = lazyPage(() => import('./pages/LandingPage'), 'LandingPage')
const LoginPage = lazyPage(() => import('./pages/LoginPage'), 'LoginPage')
const ResetPasswordPage = lazyPage(() => import('./pages/ResetPasswordPage'), 'ResetPasswordPage')
const SignalsPage = lazyPage(() => import('./pages/SignalsPage'), 'SignalsPage')
const DashboardPage = lazyPage(() => import('./pages/DashboardPage'), 'DashboardPage')
const ChartsPage = lazyPage(() => import('./pages/ChartsPage'), 'ChartsPage')
const BindPage = lazyPage(() => import('./pages/BindPage'), 'BindPage')
const BridgePage = lazyPage(() => import('./pages/BridgePage'), 'BridgePage')
const OrdersPage = lazyPage(() => import('./pages/OrdersPage'), 'OrdersPage')
const UpgradePage = lazyPage(() => import('./pages/UpgradePage'), 'UpgradePage')
const DownloadPage = lazyPage(() => import('./pages/DownloadPage'), 'DownloadPage')
const AccountPage = lazyPage(() => import('./pages/AccountPage'), 'AccountPage')
const AdminPage = lazyPage(() => import('./pages/AdminPage'), 'AdminPage')
const SimulatorPage = lazyPage(() => import('./pages/SimulatorPage'), 'SimulatorPage')
const StrategiesPage = lazyPage(() => import('./pages/StrategiesPage'), 'StrategiesPage')
const AchievementsPage = lazyPage(() => import('./pages/AchievementsPage'), 'AchievementsPage')
const LeaderboardPage = lazyPage(() => import('./pages/LeaderboardPage'), 'LeaderboardPage')
const CompetitionsPage = lazyPage(() => import('./pages/CompetitionsPage'), 'CompetitionsPage')
const ProfilePage = lazyPage(() => import('./pages/ProfilePage'), 'ProfilePage')
const LegalPage = lazyPage(() => import('./pages/LegalPage'), 'LegalPage')
const FaqPage = lazyPage(() => import('./pages/FaqPage'), 'FaqPage')
const SupportPage = lazyPage(() => import('./pages/SupportPage'), 'SupportPage')
const StrategyGuidePage = lazyPage(() => import('./pages/StrategyGuidePage'), 'StrategyGuidePage')
const AnnouncementsPage = lazyPage(() => import('./pages/AnnouncementsPage'), 'AnnouncementsPage')
const AnnouncementPage = lazyPage(() => import('./pages/AnnouncementPage'), 'AnnouncementPage')
const CompleteProfilePage = lazyPage(() => import('./pages/CompleteProfilePage'), 'CompleteProfilePage')
const AgentPage = lazyPage(() => import('./pages/AgentPage'), 'AgentPage')

// ── 启动预加载与登录后预取 / boot preload and post-login prefetch ──
type HasPreload = { preload: () => Promise<void> }

// 预渲染过的公开页 → 页面组件。main.tsx 在首次 render 前 await 对应的 preload：
// 见 lazyPage 头注，这是预渲染内容不被 Suspense 清空的前提。
// Prerendered public pages → their components; main.tsx awaits the matching
// preload before the first render (see lazyPage) so Suspense can't blank them.
const PUBLIC_PAGE_COMPONENTS: Record<PageId, HasPreload> = {
  home: LandingPage,
  terms: LegalPage,
  privacy: LegalPage,
  risk: LegalPage,
  faq: FaqPage,
}

// 登录后直达时顺手并行拉的页面（精确路径）。/ Pages warmed on direct entry (exact paths).
const APP_ROUTE_PAGES: Record<string, HasPreload> = {
  '/dashboard': DashboardPage,
  '/app': SignalsPage,
  '/charts': ChartsPage,
  '/orders': OrdersPage,
  '/bind': BindPage,
  '/account': AccountPage,
  '/strategies': StrategiesPage,
  '/upgrade': UpgradePage,
  '/download': DownloadPage,
  '/support': SupportPage,
  '/announcements': AnnouncementsPage,
}

// 登录后空闲时预取：外壳 + 底栏四个常用 Tab。/ Prefetched on idle after login: shell + main tabs.
const PREFETCH_AFTER_LOGIN: HasPreload[] = [Layout, DashboardPage, SignalsPage, ChartsPage, OrdersPage]

/**
 * 首次 render 之前调用（main.tsx）。公开页返回「该页 chunk 已就绪」的 Promise，调用方
 * 应当 await；其余情况立即 resolve，只在后台并行预热 Layout 与目标页 chunk——app.html
 * 的 root 本来就是空的，没有预渲染内容要保护，犯不着为此推迟首帧。
 * 失败一律吞掉：preload 拉不到时照常 render，lazyRetry 那条路负责重试。
 * Called before the first render (main.tsx). For public pages the returned promise
 * means "this page's chunk is ready" and should be awaited; otherwise it resolves at
 * once and only warms Layout + the target page in the background. Failures are
 * swallowed — rendering proceeds and lazyRetry handles retries.
 */
export function bootPreload(pathname: string): Promise<void> {
  const authed = !!getToken()
  const pub = pageFromPath(pathname)
  // 已登录用户打开首页只是个跳板（Home 立刻重定向 /dashboard），不必等落地页。
  // For a signed-in user the home page is only a redirect to /dashboard.
  if (pub && !(pub.page.id === 'home' && authed)) {
    return PUBLIC_PAGE_COMPONENTS[pub.page.id].preload().catch(() => {})
  }
  if (authed) {
    const target = pub ? '/dashboard' : pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname
    void Layout.preload().catch(() => {})
    void APP_ROUTE_PAGES[target]?.preload().catch(() => {})
  } else if (pathname === '/login') {
    void LoginPage.preload().catch(() => {})
  }
  return Promise.resolve()
}

// 登录态成立后，在浏览器空闲时逐个预取常用页面 chunk：一个接一个，每个之间再等一次空闲，
// 不和当前页面的请求、渲染抢带宽与主线程。省流量模式 / 2G 下不预取。
// 复用 lazyPage 的 preload（即 App 里各页面同一个 import 函数），模块图天然去重。
// Once signed in, prefetch the common page chunks one at a time on idle, never
// competing with the current page. Skipped on Save-Data / 2G. Reuses each page's own
// import function via preload(), so the module graph dedupes naturally.
function IdlePrefetch() {
  const { isAuthed } = useAuth()
  useEffect(() => {
    if (!isAuthed || shouldSkipPrefetch()) return
    let cancelIdle: (() => void) | null = null
    let stopped = false
    let i = 0
    const next = () => {
      if (stopped || i >= PREFETCH_AFTER_LOGIN.length) return
      cancelIdle = onIdle(() => {
        const item = PREFETCH_AFTER_LOGIN[i++]
        item.preload().catch(() => {}).then(next)
      }, 3000)
    }
    next()
    return () => {
      stopped = true
      cancelIdle?.()
    }
  }, [isAuthed])
  return null
}

// 给安卓 App 启动页用的「首屏已渲染」信号（APP Pack 里监听这个事件收起启动画面）。
// 事件名与全局标记名是跨项目约定，不要改。两帧 rAF：等这一次提交真正画到屏幕上；
// 1 秒定时器兜底——WebView 不可见时 rAF 不跑，信号不能因此永远不发。
// "First screen rendered" signal for the Android app's launch (APP Pack listens for it
// to dismiss the splash). The event and flag names are a cross-project contract — do
// not rename. Two rAFs so the commit has actually been painted; a 1s timer as backup
// because rAF does not run while the WebView is hidden.
function announceMounted() {
  const w = window as Window & { __PRISMX_MOUNTED__?: boolean }
  let fired = false
  const fire = () => {
    if (fired || w.__PRISMX_MOUNTED__) return
    fired = true
    w.__PRISMX_MOUNTED__ = true
    window.dispatchEvent(new Event('prismx:app-mounted'))
  }
  requestAnimationFrame(() => requestAnimationFrame(fire))
  window.setTimeout(fire, 1000)
}

function Protected({ children }: { children: ReactNode }) {
  const { isAuthed, user } = useAuth()
  if (!isAuthed) return <Navigate to="/login" replace />
  // 还欠手机号或昵称的账号一律先去补全（手机号目前只有 Google 注册的新用户会
  // 命中；昵称是全员必填，存量用户没设过的也会被拦一次）。放在这一层而不是各
  // 页面自己判断：漏一个页面就等于开了个后门，而这里是所有登录后页面的唯一入口。
  // Accounts still owing a phone or a nickname are routed to the completion page
  // first (phone only bites Google-created accounts; the nickname is required of
  // everyone, including existing users who never set one). Gated here rather than
  // per-page: this is the single entry point to every logged-in page, so nothing
  // can slip past it.
  if (user?.needsPhone || user?.needsNickname) return <Navigate to="/complete-profile" replace />
  return <>{children}</>
}

// 管理员专属路由：登录态之外还要求 role === 'admin'，否则送回仪表盘。
// 真正的权限边界在后端每个 /admin/* 接口上；这里只是不让非管理员看到入口。
// Admin-only route: on top of being logged in, requires role === 'admin',
// otherwise redirect to the dashboard. The real boundary is enforced by the
// backend on every /admin/* endpoint; this just hides the entry point.
function AdminOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  return user?.role === 'admin' ? <>{children}</> : <Navigate to="/dashboard" replace />
}

// 代理专属路由：要求 /auth/me 下发的 isAgent（至少持有一条被指派的邀请链接）。
// 与 AdminOnly 同款：真正的边界在后端（/agent/* 按链接归属校验），这里只藏入口。
// 不看 role——代理不是角色，普通用户权益不变。
// Agent-only route: requires the isAgent flag from /auth/me (holds at least one
// assigned invite link). Same shape as AdminOnly: the real boundary is the
// backend's per-link ownership check; this only hides the entry. Not role-based.
function AgentOnly({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  return user?.isAgent ? <>{children}</> : <Navigate to="/dashboard" replace />
}

// 未登录访问根路径展示主页，已登录则进入仪表盘
// Show landing at root when logged out; go to dashboard when authed.
function Home() {
  const { isAuthed } = useAuth()
  return isAuthed ? <Navigate to="/dashboard" replace /> : <LandingPage />
}

// 懒加载页面切换时的占位（样式与页面 loading 一致）/ suspense fallback
function PageFallback() {
  const [show, setShow] = useState(false)
  useEffect(() => {
    // 延迟 200ms 出现：快速加载时不闪烁，慢速时给反馈
    // Delay 200ms: no flicker on fast loads, feedback on slow ones
    const t = setTimeout(() => setShow(true), 200)
    return () => clearTimeout(t)
  }, [])
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      {show && (
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
      )}
    </div>
  )
}

// 把当前路径喂给 ErrorBoundary 当重置信号：从崩掉的页面导航走即自动恢复。
// 必须在 BrowserRouter 内部才能用 useLocation，所以单独包一层。
// Feeds the current path to ErrorBoundary as its reset signal, so navigating
// away from a broken page recovers automatically. Needs to sit inside
// BrowserRouter to use useLocation, hence the extra component.
function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation()
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>
}

export default function App() {
  // 根组件的首次提交 = React 首屏已渲染（子树可能还挂在 Suspense 占位上，但壳已经在屏幕上了）。
  // The root's first commit = React's first screen (the subtree may still be on a
  // Suspense fallback, but the shell is on screen).
  useEffect(() => {
    announceMounted()
  }, [])
  return (
    <AuthProvider>
      <PrefsProvider>
        <FestivalProvider>
        {/* v7_startTransition：路由切换包在 startTransition 里——切到还没下载的懒页面时
            保留旧页面直到新页面就绪，而不是先闪一下 Suspense 占位。
            v7_relativeSplatPath：只影响 splat 路由里的相对路径解析；本应用唯一的 splat
            是 path="*" 的 <Navigate to="/">（绝对路径），行为不变，开它只是提前对齐 v7、
            顺带消掉控制台的 future-flag 警告。
            v7_startTransition wraps navigations in startTransition, so switching to a
            not-yet-loaded lazy page keeps the old page until the new one is ready instead
            of flashing the Suspense fallback. v7_relativeSplatPath only changes relative
            resolution inside splat routes; the only splat here is path="*" navigating to
            the absolute "/", so behaviour is unchanged. */}
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          {/* SPA 路由切换时补发 Meta Pixel 的 PageView。必须在 BrowserRouter 内
              （要用 useLocation）、Routes 外（要覆盖全部路由，含 Layout 之外的
              落地页/登录页/法务页）。见 components/MetaPixel.tsx 的说明。
              Re-sends Meta Pixel PageView on client-side navigation; inside
              BrowserRouter (needs useLocation), outside Routes (must cover every
              route, including the ones outside Layout). */}
          <MetaPixel />
          {/* 邀请链接归因：捕获任意入口 URL 的 ?ref= 并打点。挂载位置与 MetaPixel
              同理——必须覆盖全部路由。见 components/RefCapture.tsx 的说明。
              Invite-link attribution: captures ?ref= on any entry URL. Same
              placement rationale as MetaPixel — must cover every route. */}
          {/* 必须排在 <Routes> 之前：首次访问时 localStorage 还是空的，
              LandingPage/LoginPage 里读 readRef() 的那个 effect 全靠这里的
              storeRef effect 在同一次渲染里先跑完才拿得到值。挪到 Routes
              内部、或包一层更晚才 resolve 的边界，首访落地页的邀请文案会
              悄悄消失，而这恰好是最难在手工测试里发现的情形——测试者的第
              二次浏览都还能正常工作。
              Must precede <Routes>: on a first-ever visit localStorage is
              empty, and the readRef() effects in LandingPage/LoginPage only
              see a value because this component's storeRef effect flushes
              first in the same render pass. Moving it inside Routes, or
              behind a boundary that resolves later, silently breaks the
              invite copy on first-visit landings only — exactly the case a
              manual second-visit test would miss. */}
          <RefCapture />
          {/* 账号被停用时接管整屏。挂在 <Routes> 之外、与 MetaPixel/RefCapture 同层：
              停用是账号级状态，和当前停在哪个路由无关——挂进某条路由就会变成"只有
              那一页会提示"，而他正好可能停在别的页面上。它自己在未停用时返回 null，
              不占任何 DOM。
              Takes the whole screen when the account is disabled. Mounted outside
              <Routes>, alongside MetaPixel/RefCapture: being disabled is an
              account-level state independent of the current route, and hanging it
              off one route would mean only that page ever says so — while the user
              may well be sitting on another. It renders null otherwise, costing no
              DOM. */}
          <AccountDisabledGate />
          <IdlePrefetch />
          <PwaBackGuard>
          <RouteErrorBoundary>
          <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/" element={<PublicShell lang="zh" page="home"><Home /></PublicShell>} />
            <Route path="/en" element={<PublicShell lang="en" page="home"><Home /></PublicShell>} />
            <Route path="/login" element={<LoginPage />} />
            {/* 找回密码：两条路径同一个组件，按 ?token= 切换阶段（见该页顶部说明）。
                必须在 Protected 之外——来这里的人正是登不进去的那批。
                Password reset: one component on both paths, switching on ?token=.
                Outside Protected by necessity — the people who need it are the ones
                who cannot sign in. */}
            <Route path="/forgot-password" element={<ResetPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/complete-profile" element={<CompleteProfilePage />} />
            {/* 法务文本：必须放在 Protected 之外，公开可访问。
                ① 访客要能在注册前读到条款，否则「注册即视为同意」不成立；
                ② Google OAuth 正式验证要求提供公开可访问的隐私政策 URL，藏在
                   登录墙后面会直接卡住验证；
                ③ 搜索引擎与合规审查方都没有 token。
                也刻意不套 Layout：Layout 会拉起 LiveProvider（WebSocket + 一堆
                轮询），而这三页不需要任何实时数据，未登录时也根本连不上。
                Legal text: deliberately outside Protected and publicly reachable.
                1. visitors must be able to read the terms before registering, or
                   "registering constitutes acceptance" means nothing;
                2. Google OAuth verification requires a publicly accessible
                   privacy-policy URL, and hiding it behind the login wall blocks it;
                3. neither search engines nor compliance reviewers hold a token.
                Also deliberately not wrapped in Layout: that mounts LiveProvider
                (a WebSocket plus several pollers) which these pages never need and
                which cannot connect when logged out anyway. */}
            <Route path="/terms" element={<PublicShell lang="zh" page="terms"><LegalPage doc="terms" /></PublicShell>} />
            <Route path="/privacy" element={<PublicShell lang="zh" page="privacy"><LegalPage doc="privacy" /></PublicShell>} />
            <Route path="/risk" element={<PublicShell lang="zh" page="risk"><LegalPage doc="risk" /></PublicShell>} />
            <Route path="/en/terms" element={<PublicShell lang="en" page="terms"><LegalPage doc="terms" /></PublicShell>} />
            <Route path="/en/privacy" element={<PublicShell lang="en" page="privacy"><LegalPage doc="privacy" /></PublicShell>} />
            <Route path="/en/risk" element={<PublicShell lang="en" page="risk"><LegalPage doc="risk" /></PublicShell>} />
            <Route path="/faq" element={<PublicShell lang="zh" page="faq"><FaqPage /></PublicShell>} />
            <Route path="/en/faq" element={<PublicShell lang="en" page="faq"><FaqPage /></PublicShell>} />
            <Route
              element={
                <Protected>
                  <Layout />
                </Protected>
              }
            >
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/app" element={<SignalsPage />} />
              {/* 平台策略详情：/app 的「平台策略」标签点进来的独立页面。做成带
                  参路由而不是标签内展开，是为了让每条策略有自己的地址——可以直接
                  发链接给用户、浏览器后退能回到列表。id 不存在时页面自己给提示，
                  不在路由层挡。
                  Platform strategy detail: the standalone page reached from the
                  "Platform strategies" tab on /app. A parameterized route rather
                  than in-tab expansion gives each write-up its own address, so it
                  can be linked directly and Back returns to the list. An unknown
                  id is handled by the page itself, not gated here. */}
              <Route path="/app/strategy/:id" element={<StrategyGuidePage />} />
              <Route path="/charts" element={<ChartsPage />} />
              <Route path="/bind" element={<BindPage />} />
              <Route path="/bind/bridge" element={<BridgePage />} />
              <Route path="/orders" element={<OrdersPage />} />
              {/* 自定义策略：已对全体登录用户开放（2026-07 起）。登录即可进入
                  页面，PRO 专属开关与每用户策略数上限在后端按端点校验（见
                  services/settings_store.get_strategy_settings 与
                  routers/strategies.py 的 _check_access），非 PRO 用户点启用
                  会拿到清楚的 403 提示，不需要在路由层再挡一层。
                  Custom strategies: open to all logged-in users (since
                  2026-07). The PRO-exclusive gate and per-user strategy limit
                  are enforced backend-side per endpoint (see
                  services/settings_store.get_strategy_settings and
                  routers/strategies.py's _check_access) — a non-PRO user gets
                  a clear 403 on enabling, so no extra route-level gate is
                  needed. */}
              <Route path="/strategies" element={<StrategiesPage />} />
              {/* 成就页：路由本身不做可见性门控，仅隐藏导航入口（见
                  Layout.tsx/UserMenu.tsx 的 gamificationVisible 判断）——直接
                  打这个 URL 的内测期普通用户会撞上后端 403，页面自己降级成
                  一条内测提示（见 AchievementsPage 的 forbidden 分支）。
                  Achievements: the route itself carries no visibility gate,
                  only the nav entries are hidden (see Layout.tsx/UserMenu.tsx's
                  gamificationVisible checks) — a regular user hitting this URL
                  directly during the beta window gets a backend 403, which the
                  page degrades into a beta hint on its own (see
                  AchievementsPage's forbidden branch). */}
              {/* 2026-09-07：三页共用 GrowthHub 外壳（一个页头 + 页签），路由不变。
                  Since 2026-09-07 the three pages share the GrowthHub shell
                  (one header + tab strip); the routes themselves are unchanged. */}
              <Route path="/achievements" element={<GrowthHub tab="achievements"><AchievementsPage /></GrowthHub>} />
              {/* 排行榜：路由本身不做可见性门控，理由与上面 /achievements 完全
                  一致——只隐藏导航入口（见 Layout.tsx/UserMenu.tsx 的
                  leaderboardVisible 判断），直接打 URL 撞上后端 403 由页面
                  自己降级成一条内测提示（见 LeaderboardPage 的 forbidden 分支）。
                  Leaderboard: same rationale as /achievements above — the route
                  carries no visibility gate, only the nav entries are hidden
                  (see Layout.tsx/UserMenu.tsx's leaderboardVisible checks); a
                  direct URL hit gets a backend 403, degraded by the page itself
                  (see LeaderboardPage's forbidden branch). */}
              <Route path="/leaderboard" element={<GrowthHub tab="leaderboard"><LeaderboardPage /></GrowthHub>} />
              {/* 比赛：路由本身不做可见性门控，理由与上面 /achievements、
                  /leaderboard 完全一致——只隐藏导航入口（见
                  Layout.tsx/UserMenu.tsx 的 competitionsVisible 判断），直接打
                  URL 撞上后端 403 由页面自己降级成一条内测提示（见
                  CompetitionsPage 的 forbidden 分支）。
                  Competitions: same rationale as /achievements and
                  /leaderboard above — the route carries no visibility gate,
                  only the nav entries are hidden (see Layout.tsx/UserMenu.tsx's
                  competitionsVisible checks); a direct URL hit gets a backend
                  403, degraded by the page itself (see CompetitionsPage's
                  forbidden branch). */}
              <Route path="/competitions" element={<GrowthHub tab="competitions"><CompetitionsPage /></GrowthHub>} />
              {/* 公开主页（2026-09-07）：从榜面名字点进来；不套外壳，自带返回。
                  Public profile: reached from board names; no shell, carries its own back link. */}
              <Route path="/u/:publicId" element={<ProfilePage />} />
              <Route path="/upgrade" element={<UpgradePage />} />
              <Route path="/account" element={<AccountPage />} />
              <Route path="/download" element={<DownloadPage />} />
              <Route path="/support" element={<SupportPage />} />
              <Route path="/announcements" element={<AnnouncementsPage />} />
              <Route path="/announcements/:id" element={<AnnouncementPage />} />
              <Route
                path="/agent"
                element={
                  <AgentOnly>
                    <AgentPage />
                  </AgentOnly>
                }
              />
              <Route
                path="/admin"
                element={
                  <AdminOnly>
                    <AdminPage />
                  </AdminOnly>
                }
              />
              {/* 历史信号回放：暂时挂在 AdminOnly 下——功能先内部试用，未对
                  普通用户开放。对外开放时把这层包装去掉、并放开后端端点的
                  require_admin 即可（页面本身不依赖任何管理员数据）。
                  Signal replay: behind AdminOnly for now — the feature is in
                  internal trial, not released to regular users. To release it,
                  drop this wrapper and loosen the backend's require_admin (the
                  page itself depends on no admin-only data). */}
              <Route
                path="/simulator"
                element={
                  <AdminOnly>
                    <SimulatorPage />
                  </AdminOnly>
                }
              />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
          </RouteErrorBoundary>
          </PwaBackGuard>
          {FESTIVAL_DEMO && (
            <Suspense fallback={null}>
              <FestivalDemoPanel />
            </Suspense>
          )}
        </BrowserRouter>
        </FestivalProvider>
      </PrefsProvider>
    </AuthProvider>
  )
}
