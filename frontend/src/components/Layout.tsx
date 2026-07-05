// 主布局：顶部导航 + 内容区 + 移动端底部 Tab 栏
// Main layout: top nav + content + mobile bottom tab bar.
import { Suspense, useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { LiveProvider, useLive } from '../store/live'
import { useAuth } from '../store/auth'
import Logo from './Logo'
import LanguageToggle from './LanguageToggle'
import EAStatusBadge from './EAStatusBadge'
import AuroraBackground from './AuroraBackground'

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/app'}
      className={({ isActive }) =>
        `relative whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition ${
          isActive ? 'text-prism-200' : 'text-slate-400 hover:text-slate-100'
        }`
      }
    >
      {({ isActive }) => (
        <>
          {label}
          {isActive && (
            <span className="absolute -bottom-px left-3 right-3 h-0.5 rounded-full bg-neon-gradient shadow-prism" />
          )}
        </>
      )}
    </NavLink>
  )
}

// 底部 Tab 图标 / bottom tab icons
function TabIcon({ name }: { name: string }) {
  const c = 'h-5 w-5'
  const p = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  }
  switch (name) {
    case 'dashboard':
      return (
        <svg className={c} viewBox="0 0 24 24" {...p}>
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <rect x="14" y="14" width="7" height="7" rx="1" />
        </svg>
      )
    case 'signals':
      return (
        <svg className={c} viewBox="0 0 24 24" {...p}>
          <path d="M3 17l5-6 4 4 5-7 4 5" />
        </svg>
      )
    case 'charts':
      return (
        <svg className={c} viewBox="0 0 24 24" {...p}>
          <path d="M3 3v18h18" />
          <rect x="7" y="10" width="3" height="7" rx="0.5" />
          <rect x="13" y="6" width="3" height="11" rx="0.5" />
          <path d="M8.5 10V7.5M8.5 17v2M14.5 6V4M14.5 17v2" />
        </svg>
      )
    case 'bind':
      return (
        <svg className={c} viewBox="0 0 24 24" {...p}>
          <path d="M9 7H6a3 3 0 0 0 0 6h3M15 7h3a3 3 0 0 1 0 6h-3M8 10h8" />
        </svg>
      )
    case 'orders':
      return (
        <svg className={c} viewBox="0 0 24 24" {...p}>
          <path d="M5 3v18l2-1 2 1 2-1 2 1 2-1 2 1V3l-2 1-2-1-2 1-2-1-2 1-2-1z" />
          <path d="M9 8h6M9 12h6" />
        </svg>
      )
    case 'account':
      return (
        <svg className={c} viewBox="0 0 24 24" {...p}>
          <circle cx="12" cy="8" r="3.5" />
          <path d="M5 20a7 7 0 0 1 14 0" />
        </svg>
      )
    case 'download':
      return (
        <svg className={c} viewBox="0 0 24 24" {...p}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <polyline points="7 10 12 15 17 10" />
          <line x1="12" y1="15" x2="12" y2="3" />
        </svg>
      )
    case 'more':
      return (
        <svg className={c} viewBox="0 0 24 24" fill="currentColor" stroke="none">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      )
    case 'admin':
      return (
        <svg className={c} viewBox="0 0 24 24" {...p}>
          <path d="M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6l7-3z" />
          <path d="M9.5 12l1.8 1.8L14.5 10" />
        </svg>
      )
    default:
      return null
  }
}

// 液态玻璃底部 Tab 项 / liquid-glass bottom tab item
function TabItem({ to, icon, label }: { to: string; icon: string; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/app'}
      className={({ isActive }) => `lg-tab ${isActive ? 'on' : ''}`}
    >
      <span className="lg-ico">
        <TabIcon name={icon} />
      </span>
      <span className="leading-none">{label}</span>
    </NavLink>
  )
}

// 断线提示条：网页自身的 WebSocket 掉线时提醒用户报价/持仓可能已过时
// Disconnect banner: warns that quotes/positions may be stale while the
// page's own WebSocket connection is down
function WsDisconnectBanner() {
  const { t } = useTranslation()
  const { wsDisconnected } = useLive()
  if (!wsDisconnected) return null
  return (
    <div className="sticky top-[57px] z-20 flex items-center justify-center gap-2 border-b border-amber-400/30 bg-amber-400/10 px-3 py-1.5 text-xs font-medium text-amber-300 sm:top-[65px]">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
      {t('connStatus.reconnecting')}
    </div>
  )
}

export default function Layout() {
  const { t } = useTranslation()
  const { user, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)

  const handleLogout = () => {
    logout()
    navigate('/', { replace: true })
  }

  const isAdmin = user?.role === 'admin'

  // 手机底部 4 个主入口，其余收进「其他」/ 4 primary mobile tabs, the rest go under "More"
  const mobileTabs = [
    { to: '/app', icon: 'signals', label: t('nav.signals') },
    { to: '/charts', icon: 'charts', label: t('nav.charts') },
    { to: '/dashboard', icon: 'dashboard', label: t('nav.dashboard') },
    { to: '/orders', icon: 'orders', label: t('nav.orders') },
  ]
  const moreItems = [
    { to: '/bind', icon: 'bind', label: t('nav.bind') },
    { to: '/account', icon: 'account', label: t('nav.account') },
    { to: '/download', icon: 'download', label: t('nav.download') },
    ...(isAdmin ? [{ to: '/admin', icon: 'admin', label: t('nav.admin') }] : []),
  ]
  const moreActive = moreItems.some((m) => location.pathname === m.to)

  // 「其他」面板打开时：返回手势关闭面板而非切换页面 / back gesture closes the sheet
  useEffect(() => {
    if (!moreOpen) return
    window.history.pushState({ __moreSheet: true }, '')
    const onPop = () => setMoreOpen(false)
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      if (window.history.state?.__moreSheet) window.history.back()
    }
  }, [moreOpen])

  // 路由切换时自动关闭面板 / close the sheet on navigation
  useEffect(() => { setMoreOpen(false) }, [location.pathname])

  return (
    <LiveProvider>
      <div className="relative flex min-h-screen flex-col">
        <AuroraBackground />
        <header className="sticky top-0 z-30 border-b border-white/[0.08] bg-ink-950/60 backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:gap-4 sm:px-6">
            <div className="flex items-center gap-2.5">
              <Logo size={30} />
              <div className="leading-tight">
                <div className="font-display text-[17px] font-bold tracking-[0.14em] text-white">
                  PRISMX
                </div>
                <div className="text-[9.5px] font-semibold uppercase tracking-[0.34em] text-prism-300">
                  Signal Lab
                </div>
              </div>
            </div>

            <nav className="hidden flex-1 items-center justify-center gap-1 sm:flex lg:gap-2">
              <NavItem to="/dashboard" label={t('nav.dashboard')} />
              <NavItem to="/app" label={t('nav.signals')} />
              <NavItem to="/charts" label={t('nav.charts')} />
              <NavItem to="/bind" label={t('nav.bind')} />
              <NavItem to="/orders" label={t('nav.orders')} />
              <NavItem to="/account" label={t('nav.account')} />
              <NavItem to="/download" label={t('nav.download')} />
              {isAdmin && <NavItem to="/admin" label={t('nav.admin')} />}
            </nav>

            <div className="ml-auto flex items-center gap-2 sm:gap-3">
              <EAStatusBadge />
              <LanguageToggle />
              <div className="hidden text-right md:block">
                <div className="max-w-[160px] truncate text-xs text-slate-400">{user?.email}</div>
              </div>
              <button
                onClick={handleLogout}
                className="btn-ghost hidden px-3 py-1.5 text-sm sm:inline-flex"
              >
                {t('nav.logout')}
              </button>
              {/* 移动端登出图标按钮 / mobile icon-only logout */}
              <button
                onClick={handleLogout}
                aria-label={t('nav.logout')}
                className="btn-ghost px-2 py-1.5 sm:hidden"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </button>
            </div>
          </div>
        </header>
        <WsDisconnectBanner />

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-24 pt-6 sm:px-6 sm:pb-6">
          {/* 懒加载页面切换时导航保持可见 / keep the nav visible while a lazy page loads */}
          <Suspense
            fallback={
              <div className="flex min-h-[40vh] items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
              </div>
            }
          >
            <Outlet />
          </Suspense>
        </main>

        {/* 移动端底部液态玻璃导航栏 / mobile liquid-glass bottom nav */}
        <nav className="lg-tabbar sm:hidden">
          <div className="lg-tabbar-inner">
            {mobileTabs.map((tab) => (
              <TabItem key={tab.to} to={tab.to} icon={tab.icon} label={tab.label} />
            ))}
            <button
              type="button"
              className={`lg-tab ${moreActive ? 'on' : ''}`}
              onClick={() => setMoreOpen(true)}
              aria-label={t('nav.more')}
            >
              <span className="lg-ico">
                <TabIcon name="more" />
              </span>
              <span className="leading-none">{t('nav.more')}</span>
            </button>
          </div>
        </nav>

        {/* 「其他」液态玻璃弹出面板 / "More" liquid-glass sheet */}
        {moreOpen && (
          <div className="lg-sheet-overlay sm:hidden" onClick={() => setMoreOpen(false)}>
            <div className="lg-sheet" onClick={(e) => e.stopPropagation()}>
              <div className="lg-sheet-handle" />
              <div className="lg-sheet-grid">
                {moreItems.map((it) => (
                  <NavLink
                    key={it.to}
                    to={it.to}
                    className={({ isActive }) => `lg-sheet-item ${isActive ? 'on' : ''}`}
                  >
                    <TabIcon name={it.icon} />
                    <span>{it.label}</span>
                  </NavLink>
                ))}
              </div>
              <button type="button" className="lg-sheet-logout" onClick={handleLogout}>
                {t('nav.logout')}
              </button>
            </div>
          </div>
        )}
      </div>
    </LiveProvider>
  )
}
