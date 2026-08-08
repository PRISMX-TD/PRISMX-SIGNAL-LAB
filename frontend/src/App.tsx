import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from './store/auth'
import { PrefsProvider } from './store/prefs'
import Layout from './components/Layout'
import PwaBackGuard from './components/PwaBackGuard'
import ErrorBoundary from './components/ErrorBoundary'

// 路由级代码分割：首屏只加载当前页面的代码，其余按需加载（如图表页）。
// Route-level code splitting: only the current page's code loads up front;
// heavy pages (e.g. the charts page) load on demand.
const LandingPage = lazy(() => import('./pages/LandingPage'))
const LoginPage = lazy(() => import('./pages/LoginPage'))
const SignalsPage = lazy(() => import('./pages/SignalsPage'))
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const ChartsPage = lazy(() => import('./pages/ChartsPage'))
const BindPage = lazy(() => import('./pages/BindPage'))
const BridgePage = lazy(() => import('./pages/BridgePage'))
const OrdersPage = lazy(() => import('./pages/OrdersPage'))
const UpgradePage = lazy(() => import('./pages/UpgradePage'))
const DownloadPage = lazy(() => import('./pages/DownloadPage'))
const AccountPage = lazy(() => import('./pages/AccountPage'))
const AdminPage = lazy(() => import('./pages/AdminPage'))
const SimulatorPage = lazy(() => import('./pages/SimulatorPage'))
const StrategiesPage = lazy(() => import('./pages/StrategiesPage'))
const LegalPage = lazy(() => import('./pages/LegalPage'))
const SupportPage = lazy(() => import('./pages/SupportPage'))
const StrategyGuidePage = lazy(() => import('./pages/StrategyGuidePage'))

function Protected({ children }: { children: ReactNode }) {
  const { isAuthed } = useAuth()
  return isAuthed ? <>{children}</> : <Navigate to="/login" replace />
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
  return (
    <AuthProvider>
      <PrefsProvider>
        <BrowserRouter>
          <PwaBackGuard>
          <RouteErrorBoundary>
          <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<LoginPage />} />
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
            <Route path="/terms" element={<LegalPage doc="terms" />} />
            <Route path="/privacy" element={<LegalPage doc="privacy" />} />
            <Route path="/risk" element={<LegalPage doc="risk" />} />
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
              <Route path="/upgrade" element={<UpgradePage />} />
              <Route path="/account" element={<AccountPage />} />
              <Route path="/download" element={<DownloadPage />} />
              <Route path="/support" element={<SupportPage />} />
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
        </BrowserRouter>
      </PrefsProvider>
    </AuthProvider>
  )
}
