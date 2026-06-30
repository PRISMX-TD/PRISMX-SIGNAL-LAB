import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './store/auth'
import Layout from './components/Layout'
import LandingPage from './pages/LandingPage'
import LoginPage from './pages/LoginPage'
import SignalsPage from './pages/SignalsPage'
import BindPage from './pages/BindPage'
import OrdersPage from './pages/OrdersPage'
import DownloadPage from './pages/DownloadPage'
import AccountPage from './pages/AccountPage'
import type { ReactNode } from 'react'

function Protected({ children }: { children: ReactNode }) {
  const { isAuthed } = useAuth()
  return isAuthed ? <>{children}</> : <Navigate to="/login" replace />
}

// 未登录访问根路径展示主页，已登录则进入信号面板
// Show landing at root when logged out; go to signals dashboard when authed.
function Home() {
  const { isAuthed } = useAuth()
  return isAuthed ? <Navigate to="/app" replace /> : <LandingPage />
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
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
            <Route path="/app" element={<SignalsPage />} />
            <Route path="/bind" element={<BindPage />} />
            <Route path="/orders" element={<OrdersPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/download" element={<DownloadPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
