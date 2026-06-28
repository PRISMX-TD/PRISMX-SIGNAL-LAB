import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './store/auth'
import Layout from './components/Layout'
import LoginPage from './pages/LoginPage'
import SignalsPage from './pages/SignalsPage'
import BindPage from './pages/BindPage'
import OrdersPage from './pages/OrdersPage'
import type { ReactNode } from 'react'

function Protected({ children }: { children: ReactNode }) {
  const { isAuthed } = useAuth()
  return isAuthed ? <>{children}</> : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <Protected>
                <Layout />
              </Protected>
            }
          >
            <Route path="/" element={<SignalsPage />} />
            <Route path="/bind" element={<BindPage />} />
            <Route path="/orders" element={<OrdersPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  )
}
