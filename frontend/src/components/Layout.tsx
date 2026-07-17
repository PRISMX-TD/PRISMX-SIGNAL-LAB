// 主布局：顶部导航 + 内容区 + 移动端底部 Tab 栏
// Main layout: top nav + content + mobile bottom tab bar.
import { Suspense, useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { LiveProvider, useLive } from '../store/live'
import { useAuth } from '../store/auth'
import { notificationApi, pushApi } from '../api/client'
import { ensurePushSubscription, pushSupported } from '../utils/push'
import Logo from './Logo'
import LanguageToggle from './LanguageToggle'
import EAStatusBadge from './EAStatusBadge'
import NotificationBell from './NotificationBell'
import UserMenu from './UserMenu'
import AuroraBackground from './AuroraBackground'
import ConfirmModal from './ConfirmModal'
import BridgeUpdateNotice from './BridgeUpdateNotice'
import { useBackToClose } from '../utils/useBackToClose'

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
            <span className="absolute -bottom-px left-3 right-3 h-0.5 rounded-full bg-gradient-to-r from-prism-500 to-[#22d3ee]" />
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
    case 'upgrade':
      return (
        <svg className={c} viewBox="0 0 24 24" {...p}>
          <polygon points="12 2 22 22 2 22" />
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
  // 移动端登出容易误触（图标按钮/滑动面板里的整宽按钮），加一步确认；
  // 桌面端文字按钮误触概率低，不加这道确认以免多余打扰。
  // Mobile logout is easy to fat-finger (an icon-only button / a full-width
  // button inside a swipe-up sheet), so gate it behind a confirmation;
  // skipped on the desktop text button where accidental clicks are rare.
  const [confirmLogout, setConfirmLogout] = useState(false)
  // 全屏确认弹窗，手机上划返回应该先关掉它、而不是直接退出当前页面
  // （见 useBackToClose 的说明）。/ A full-screen confirm modal; on mobile,
  // swiping back should close it first rather than exiting the current page
  // outright (see useBackToClose's comment).
  useBackToClose(confirmLogout, () => setConfirmLogout(false))

  const handleLogout = () => {
    setConfirmLogout(false)
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
    ...(user?.plan !== 'PRO' ? [{ to: '/upgrade', icon: 'upgrade', label: t('nav.upgrade') }] : []),
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

  // 每次进入 App 补齐"本设备"的推送订阅。通知开关是账号级的（跨设备同步），
  // 推送订阅却是设备级的——此前只在用户翻动开关的那台设备上创建。桌面开启后
  // 手机端开关显示"已开启"但手机从未订阅，一条通知也收不到。仅在本设备已授
  // 权（说明用户在这台设备上主动开过通知）且账号开关为开时静默补订阅/重新上
  // 报，权限未授予时绝不弹窗打扰。
  // Ensure THIS device's push subscription on every app entry. The toggle is
  // account-level (synced across devices) but a subscription is per-device —
  // it was only ever created on the device where the user flipped the toggle.
  // Enable on desktop and the phone showed "on" with no subscription, so it
  // never received anything. Runs silently only when this device already has
  // permission (the user opted in here at some point) and the account toggle
  // is on; never prompts.
  useEffect(() => {
    if (!pushSupported() || Notification.permission !== 'granted') return
    let cancelled = false
    void (async () => {
      try {
        const prefs = await notificationApi.getPrefs()
        if (cancelled || !prefs.enabled) return
        await ensurePushSubscription(
          async () => (await pushApi.getVapidKey()).publicKey,
          (endpoint, keys) => pushApi.subscribe(endpoint, keys),
        )
      } catch {
        // 静默失败：这里只是自愈，不该打扰正常使用 / silent — self-healing only
      }
    })()
    return () => { cancelled = true }
  }, [])

  return (
    <LiveProvider>
      <div className="relative flex min-h-screen flex-col">
        <AuroraBackground />
        <header className="sticky top-0 z-30 border-b border-white/[0.08] bg-ink-950/60 backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:gap-4 sm:px-6">
            <div className="flex items-center gap-2.5">
              <Logo size={30} />
              <div className="leading-tight">
                <div className="font-display text-[17px] font-bold tracking-[0.06em] text-white">
                  Signal Lab
                </div>
                <div className="text-[9px] font-medium uppercase tracking-[0.18em] text-neutral-500">
                  by PRISMX
                </div>
              </div>
            </div>

            {/* 主导航只留高频项；账户/下载桥接/升级/管理页这些低频项收进右侧用户
                菜单——英文标签普遍比中文长，9 项塞不下会在英文下直接溢出屏幕。
                桌面导航在 sm~lg 之间（约 640–1000px）实测仍然挤不下 5 项 + 右侧
                一排图标，所以把"桌面/移动布局"的切换点从 sm 整体挪到 lg：这段
                过渡宽度改用手机的底部 Tab 栏（本来就是为窄屏设计的固定网格，
                天然不会溢出），比硬挤横向导航更稳妥。
                Primary nav keeps only the high-frequency items; account/download
                bridge/upgrade/admin (low-frequency) collapse into the user menu
                on the right — English labels run longer than Chinese, and 9
                items don't fit without overflowing in English. Measured that
                even 5 items plus the right-hand icon row still doesn't fit
                between sm and lg (~640–1000px), so the desktop/mobile layout
                switch moved from sm to lg entirely: that in-between band now
                gets the mobile bottom tab bar (a fixed grid built for narrow
                screens, which just doesn't overflow) instead of a cramped
                horizontal nav. */}
            <nav className="hidden flex-1 items-center justify-center gap-1 lg:flex lg:gap-2">
              <NavItem to="/dashboard" label={t('nav.dashboard')} />
              <NavItem to="/app" label={t('nav.signals')} />
              <NavItem to="/charts" label={t('nav.charts')} />
              <NavItem to="/bind" label={t('nav.bind')} />
              <NavItem to="/orders" label={t('nav.orders')} />
            </nav>

            <div className="ml-auto flex items-center gap-2 sm:gap-3">
              <EAStatusBadge />
              <NotificationBell />
              <LanguageToggle />
              {/* 桌面：头像菜单收纳账户/下载/升级/管理/退出 / desktop: avatar menu */}
              <div className="hidden lg:block">
                <UserMenu
                  email={user?.email}
                  showUpgrade={user?.plan !== 'PRO'}
                  isAdmin={isAdmin}
                  onLogout={handleLogout}
                />
              </div>
              {/* 移动端登出图标按钮：其余低频项在底部"其他"面板里 / mobile
                  icon-only logout — the rest of the low-frequency items live
                  in the bottom "more" sheet */}
              <button
                onClick={() => setConfirmLogout(true)}
                aria-label={t('nav.logout')}
                className="btn-ghost px-2 py-1.5 lg:hidden"
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
        <nav className="lg-tabbar lg:hidden">
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
          <div className="lg-sheet-overlay lg:hidden" onClick={() => setMoreOpen(false)}>
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
              <button type="button" className="lg-sheet-logout" onClick={() => setConfirmLogout(true)}>
                {t('nav.logout')}
              </button>
            </div>
          </div>
        )}

        {confirmLogout && (
          <ConfirmModal
            title={t('nav.logout')}
            message={t('nav.logoutConfirm')}
            confirmLabel={t('nav.logout')}
            danger
            onConfirm={handleLogout}
            onCancel={() => setConfirmLogout(false)}
          />
        )}

        <BridgeUpdateNotice />
      </div>
    </LiveProvider>
  )
}
