// 主布局：顶部导航 + 内容区 + 移动端底部 Tab 栏
// Main layout: top nav + content + mobile bottom tab bar.
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { LiveProvider } from '../store/live'
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
        `relative rounded-lg px-3 py-2 text-sm font-medium transition ${
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
    default:
      return null
  }
}

function TabItem({ to, icon, label }: { to: string; icon: string; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/app'}
      className={({ isActive }) =>
        `flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 text-[10px] font-medium transition ${
          isActive ? 'text-prism-200' : 'text-slate-500'
        }`
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={`flex h-8 w-full items-center justify-center rounded-lg transition ${
              isActive ? 'bg-prism-600/20 text-prism-200' : 'text-slate-400'
            }`}
          >
            <TabIcon name={icon} />
          </span>
          <span className="leading-none">{label}</span>
        </>
      )}
    </NavLink>
  )
}

export default function Layout() {
  const { t } = useTranslation()
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/', { replace: true })
  }

  const tabs = [
    { to: '/dashboard', icon: 'dashboard', label: t('nav.dashboard') },
    { to: '/app', icon: 'signals', label: t('nav.signals') },
    { to: '/charts', icon: 'charts', label: t('nav.charts') },
    { to: '/bind', icon: 'bind', label: t('nav.bind') },
    { to: '/orders', icon: 'orders', label: t('nav.orders') },
    { to: '/account', icon: 'account', label: t('nav.account') },
    { to: '/download', icon: 'download', label: t('nav.download') },
  ]

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

            <nav className="hidden items-center gap-1 sm:flex">
              <NavItem to="/dashboard" label={t('nav.dashboard')} />
              <NavItem to="/app" label={t('nav.signals')} />
              <NavItem to="/charts" label={t('nav.charts')} />
              <NavItem to="/bind" label={t('nav.bind')} />
              <NavItem to="/orders" label={t('nav.orders')} />
              <NavItem to="/account" label={t('nav.account')} />
              <NavItem to="/download" label={t('nav.download')} />
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

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-24 pt-6 sm:px-6 sm:pb-6">
          <Outlet />
        </main>

        {/* 移动端底部 Tab 栏 / mobile bottom tab bar */}
        <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-white/[0.08] bg-ink-950/85 backdrop-blur-xl pb-[env(safe-area-inset-bottom)] sm:hidden">
          <div className="flex items-stretch gap-1 px-2 py-1.5">
            {tabs.map((tab) => (
              <TabItem key={tab.to} to={tab.to} icon={tab.icon} label={tab.label} />
            ))}
          </div>
        </nav>
      </div>
    </LiveProvider>
  )
}
