import { lazy, Suspense, type ReactNode } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './store/auth'
import { PrefsProvider } from './store/prefs'
import Layout from './components/Layout'
import PwaBackGuard from './components/PwaBackGuard'

// 路由级代码分割：首屏只加载当前页面的代码，其余按需加载（如图表页）。
// Route-level code splitting: only the current page's code loads up front;
// heavy pages (e.g. the charts page) load on demand.
const LandingPage = lazy(() => import('./pages/LandingPage'))
const LoginPage = lazy(() => import('./pages/LoginPage'))
const SignalsPage = lazy(() => import('./pages/SignalsPage'))
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const ChartsPage = lazy(() => import('./pages/ChartsPage'))
const BindPage = lazy(() => import('./pages/BindPage'))
const OrdersPage = lazy(() => import('./pages/OrdersPage'))
const UpgradePage = lazy(() => import('./pages/UpgradePage'))
const DownloadPage = lazy(() => import('./pages/DownloadPage'))
const AccountPage = lazy(() => import('./pages/AccountPage'))
const AdminPage = lazy(() => import('./pages/AdminPage'))

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
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <PrefsProvider>
        <BrowserRouter>
          <PwaBackGuard>
          <Suspense fallback={<PageFallback />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/login" element={<LoginPage />} />
            <Route
              element={
                <Protected>
                  <Layout />
                </Protected>
              }
            >
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/app" element={<SignalsPage />} />
              <Route path="/charts" element={<ChartsPage />} />
              <Route path="/bind" element={<BindPage />} />
              <Route path="/orders" element={<OrdersPage />} />
              <Route path="/upgrade" element={<UpgradePage />} />
              <Route path="/account" element={<AccountPage />} />
              <Route path="/download" element={<DownloadPage />} />
              <Route
                path="/admin"
                element={
                  <AdminOnly>
                    <AdminPage />
                  </AdminOnly>
                }
              />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </Suspense>
          </PwaBackGuard>
        </BrowserRouter>
      </PrefsProvider>
    </AuthProvider>
  )
}
