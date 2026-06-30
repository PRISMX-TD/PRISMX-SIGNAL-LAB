// 主布局：顶部导航 + 内容区 / Main layout: top nav + content.
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

export default function Layout() {
  const { t } = useTranslation()
  const { user, logout } = useAuth()
  const navigate = useNavigate()

  const handleLogout = () => {
    logout()
    navigate('/', { replace: true })
  }

  return (
    <LiveProvider>
      <div className="relative flex min-h-screen flex-col">
        <AuroraBackground />
        <header className="sticky top-0 z-30 border-b border-white/10 bg-ink-950/60 backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
            <div className="flex items-center gap-2.5">
              <Logo size={30} />
              <div className="leading-tight">
                <div className="font-display text-base font-bold tracking-wider text-slate-100">
                  PRISMX
                </div>
                <div className="text-[10px] uppercase tracking-[0.2em] text-prism-400">
                  Signal Lab
                </div>
              </div>
            </div>

            <nav className="hidden items-center gap-1 sm:flex">
              <NavItem to="/app" label={t('nav.signals')} />
              <NavItem to="/bind" label={t('nav.bind')} />
              <NavItem to="/orders" label={t('nav.orders')} />
              <NavItem to="/account" label={t('nav.account')} />
              <NavItem to="/download" label={t('nav.download')} />
            </nav>

            <div className="ml-auto flex items-center gap-3">
              <EAStatusBadge />
              <LanguageToggle />
              <div className="hidden text-right md:block">
                <div className="max-w-[160px] truncate text-xs text-slate-400">{user?.email}</div>
              </div>
              <button onClick={handleLogout} className="btn-ghost px-3 py-1.5 text-sm">
                {t('nav.logout')}
              </button>
            </div>
          </div>

          {/* 移动端导航 / mobile nav */}
          <nav className="flex items-center gap-1 border-t border-white/10 px-4 py-1.5 sm:hidden">
            <NavItem to="/app" label={t('nav.signals')} />
            <NavItem to="/bind" label={t('nav.bind')} />
            <NavItem to="/orders" label={t('nav.orders')} />
            <NavItem to="/download" label={t('nav.download')} />
          </nav>
        </header>

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6">
          <Outlet />
        </main>
      </div>
    </LiveProvider>
  )
}
