// 主布局：顶部导航 + 内容区 + 移动端底部 Tab 栏
// Main layout: top nav + content + mobile bottom tab bar.
import { Suspense, useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { LiveProvider, useLive } from '../store/live'
import { useAuth } from '../store/auth'
import { notificationApi, pushApi } from '../api/client'
import { SUPPORT_EMAIL } from '../config/site'
import { ensurePushSubscription, pushSupported } from '../utils/push'
import Logo from './Logo'
import PlanExpiryBanner from './PlanExpiryBanner'
import LanguageToggle from './LanguageToggle'
import EAStatusBadge from './EAStatusBadge'
import NotificationBell from './NotificationBell'
import UserMenu from './UserMenu'
import AuroraBackground from './AuroraBackground'
import ConfirmModal from './ConfirmModal'
import BridgeUpdateNotice from './BridgeUpdateNotice'
import { useBackToClose } from '../utils/useBackToClose'
import { reportPageView } from '../utils/pageTracking'

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
    case 'strategies':
      return (
        <svg className={c} viewBox="0 0 24 24" {...p}>
          <line x1="4" y1="6" x2="20" y2="6" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="18" x2="20" y2="18" />
          <circle cx="9" cy="6" r="1.8" fill="currentColor" />
          <circle cx="16" cy="12" r="1.8" fill="currentColor" />
          <circle cx="11" cy="18" r="1.8" fill="currentColor" />
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

// 连接状态提示条，三态：
//   ① 正常                 —— 不渲染
//   ② WebSocket 断线重连中  —— 琥珀色，数据可能过时
//   ③ 后端整体不可达        —— 红色，并给一个「重试」按钮
//
// 加第三态的原因：此前后端挂掉时页面渲染得完全正常、只是空空如也，而重连横幅
// 也不会出现——它要求 wsDisconnected，而那个标志需要「曾经连上过」，后端从一
// 开始就没起来的话永远为假。用户看到的是一个「今天没信号」的仪表盘。
//
// 两态同时成立时优先显示后端不可达：那是根因，说「正在重连」只会让用户以为
// 是自己网络的问题。
//
// Connection banner with three states: silent when healthy; amber while the
// WebSocket is reconnecting (data may be stale); red when the backend is
// unreachable as a whole, with a retry button.
//
// The third state exists because a backend outage used to render a perfectly
// normal but empty page, and the reconnect banner wouldn't fire either — it
// requires wsDisconnected, which requires having connected at least once, and
// that is never true if the backend was down from the start. The user just saw
// a dashboard with "no signals today".
//
// When both apply, the unreachable state wins: it's the root cause, and saying
// "reconnecting" would let the user blame their own network.
function ConnectionBanner() {
  const { t } = useTranslation()
  const { wsDisconnected, backendUnreachable, refreshAll } = useLive()
  const [retrying, setRetrying] = useState(false)

  const retry = async () => {
    setRetrying(true)
    try {
      await refreshAll()
    } finally {
      setRetrying(false)
    }
  }

  // 57px/65px 是 header 在移动端/桌面端的固有高度；header 现在额外吃掉一段
  // env(safe-area-inset-top) 撑开顶部（见下方 header 的 pt-[env(...)]），这里
  // 的吸顶偏移必须加回同一个值，否则在刘海屏/灵动岛设备上这条横幅会叠在
  // header 文字上而不是紧贴其下方。
  // 57px/65px is the header's intrinsic height on mobile/desktop; the header
  // now also reserves env(safe-area-inset-top) at its top (see the header's
  // pt-[env(...)] below), so this sticky offset must add the same amount back,
  // or on notched/Dynamic-Island devices this banner overlaps the header text
  // instead of sitting right below it.
  const base =
    'sticky top-[calc(57px+env(safe-area-inset-top))] z-20 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-b px-3 py-1.5 text-xs font-medium sm:top-[calc(65px+env(safe-area-inset-top))]'

  if (backendUnreachable) {
    return (
      <div className={`${base} border-down/30 bg-down/10 text-down`} role="status">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-down" />
        <span>{t('connStatus.backendDown')}</span>
        <span className="opacity-75">{t('connStatus.backendDownHint')}</span>
        <button
          type="button"
          onClick={retry}
          disabled={retrying}
          className="rounded-md bg-down/20 px-2 py-0.5 font-semibold transition hover:bg-down/30 disabled:opacity-50"
        >
          {retrying ? t('common.loading') : t('connStatus.retry')}
        </button>
      </div>
    )
  }

  if (wsDisconnected) {
    return (
      <div className={`${base} border-amber-400/30 bg-amber-400/10 text-amber-300`} role="status">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
        {t('connStatus.reconnecting')}
      </div>
    )
  }

  return null
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
    // 自定义策略：已对全体登录用户开放，见 App.tsx 路由处的说明；PRO 门槛在
    // 页面内/后端接口层生效，导航入口不再需要管理员身份。
    // Custom strategies: open to all logged-in users now, see the comment at
    // the App.tsx route; the PRO gate lives in-page/backend, so the nav entry
    // no longer needs admin status.
    { to: '/strategies', icon: 'strategies', label: t('nav.strategies') },
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

  // 页面停留上报：Layout 是全部受保护路由的共同父组件，所以这一处就覆盖了所有
  // 需要统计的页面。计时起点存在 ref 里而不是 state——它每次路由切换都要重置，
  // 用 state 会多触发一轮渲染，而这个值从不参与渲染。
  //
  // 两个触发点缺一不可：
  // - cleanup：路由切换时上报上一个页面（站内跳转走这里）；
  // - pagehide：关标签页/切到别的网站时上报（这种情况 React 不会跑 cleanup，
  //   只靠上面那个会永久丢掉每个会话的最后一个页面）。用 pagehide 而不是
  //   unload，因为移动端 Safari 把页面放进后台缓存时根本不触发 unload。
  //
  // Dwell reporting: Layout is the common parent of every protected route, so
  // this single hook covers all tracked pages. The start timestamp lives in a
  // ref, not state — it resets on every navigation and never participates in
  // rendering, so state would only cost an extra render.
  //
  // Both triggers are required:
  // - cleanup: reports the previous page on in-app navigation;
  // - pagehide: reports when the tab closes or the user leaves the site, where
  //   React never runs cleanup — without it every session would permanently
  //   lose its final page. pagehide rather than unload, because mobile Safari
  //   doesn't fire unload when putting a page into the back/forward cache.
  // done 标记防重复上报：pagehide 之后 React 仍可能跑 cleanup（例如从后台缓存
  // 恢复再跳转），两条路径都调 flush 就会把同一次访问算两遍，把访问量和总时长
  // 一起抬高。每个 effect 周期只允许上报一次。
  // The `done` flag prevents double-counting: React may still run cleanup after
  // pagehide (e.g. restored from the back/forward cache, then navigated away),
  // and having both paths flush would count one visit twice, inflating views and
  // total time together. One report per effect cycle, at most.
  const dwellStartRef = useRef<number>(Date.now())
  useEffect(() => {
    const path = location.pathname
    dwellStartRef.current = Date.now()
    let done = false

    const flush = () => {
      if (done) return
      done = true
      const seconds = (Date.now() - dwellStartRef.current) / 1000
      reportPageView(path, seconds)
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [location.pathname])

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
    const report = async () => {
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
    }
    void report()

    // 监听 SW 的 postMessage：当 pushsubscriptionchange 触发重新订阅后，
    // SW 会广播新 endpoint，前端立即上报后端——不用等下次打开站点。
    // Listen for the SW's postMessage: after pushsubscriptionchange re-
    // subscribes, the SW broadcasts the new endpoint and the frontend
    // immediately reports it without waiting for the next app visit.
    const onSwMsg = (ev: MessageEvent) => {
      if (ev.data?.type === "PUSH_SUB_RENEWED" && ev.data?.endpoint && ev.data?.keys) {
        void pushApi.subscribe(ev.data.endpoint, ev.data.keys).catch(() => {})
      }
    }
    navigator.serviceWorker.addEventListener("message", onSwMsg)

    // 页面切回前台时重新检查订阅有效性：iOS/Android 可能在不活跃期间
    // 杀死 SW 或清除 push 权限；后台存放一阵子再切回来时补一次自愈。
    // Re-check subscription health when the page returns to the foreground:
    // iOS/Android may kill the SW or clear push permission during inactivity;
    // self-heal on re-activation rather than waiting for a full page reload.
    let lastPerm: NotificationPermission = Notification.permission
    const onVisible = () => {
      if (!document.hidden) {
        // 权限在后台被系统撤销（iOS 更新后偶发）
        // Permission was revoked while backgrounded (seen after iOS updates)
        if (Notification.permission !== lastPerm) {
          lastPerm = Notification.permission
          if (!cancelled && Notification.permission === "granted") void report()
        }
        // 静默重报订阅：修复端点过期或 SW 被浏览器轮换的漏网情况
        // Silently re-report the subscription: catches endpoint expiry / SW
        // rotation edge cases the message listener may have missed
        if (!cancelled && Notification.permission === "granted") void report()
      }
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      cancelled = true
      navigator.serviceWorker.removeEventListener("message", onSwMsg)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [])

  return (
    <LiveProvider>
      <div className="relative flex min-h-screen flex-col">
        <AuroraBackground />
        {/* pt-[env(safe-area-inset-top)]：iOS 的 apple-mobile-web-app-status-bar-style
            是 black-translucent（见 index.html），意味着状态栏是透明的，页面内容
            天然延伸到刘海/灵动岛下面——不加这段内边距，logo/导航就会被系统状态栏
            盖住甚至挡住点击（灵动岛区域系统会截获触摸）。header 背景本身贴着物理
            顶部（sticky top-0），所以撑开的这段高度用同一层模糊背景盖住状态栏，
            视觉上是连续的一整条，而不是露出一段黑边。
            pt-[env(safe-area-inset-top)]: iOS's apple-mobile-web-app-status-bar-style
            is black-translucent (see index.html), meaning the status bar is
            transparent and page content naturally extends under the notch/Dynamic
            Island — without this padding the logo/nav sit under the system status
            bar and can even have taps swallowed by the Dynamic Island's touch
            capture. The header background itself still hugs the physical top
            (sticky top-0), so the added height is covered by the same blurred
            background, reading as one continuous bar rather than a bare strip. */}
        <header className="sticky top-0 z-30 border-b border-white/[0.08] bg-ink-950/60 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
          <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:gap-4 sm:px-6">
            <div className="flex items-center gap-2.5">
              <Logo size={40} />
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
              <NavItem to="/strategies" label={t('nav.strategies')} />
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
        <ConnectionBanner />
        {/* 到期提醒放在这里而不是某个页面里：到期影响的是整个产品（实时信号、
            推送、多账号连接），不是某一页的功能，所以它得跟着用户走到每一页。
            它自己判断该不该显示，不需要时不占任何布局空间。
            The expiry notice lives here rather than inside a page: expiry affects
            the whole product (real-time signals, push, multi-account connections),
            not one page's feature, so it has to follow the user everywhere. It
            decides for itself whether to render and takes up no layout space when
            it shouldn't. */}
        <PlanExpiryBanner />

        <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-24 pt-6 sm:px-6 sm:pb-6">
          {/* 懒加载页面切换时导航保持可见 / keep the nav visible while a lazy page loads */}
          <Suspense
            fallback={
              <div className="flex min-h-[40vh] items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
              </div>
            }
          >
            {/* key=pathname 让每次导航都重挂载这层容器，触发一次 page-enter 柔和
                淡入——切换页面不再是硬弹出现。减少动态偏好下 CSS 会自动跳过动画。
                key=pathname remounts this wrapper on every navigation, replaying
                the page-enter fade so switching pages no longer hard-pops. CSS
                skips the animation under reduced-motion. */}
            <div key={location.pathname} className="page-enter">
              <Outlet />
            </div>
          </Suspense>
        </main>

        {/* 登录后也要够得着条款/政策/客服。只有落地页有页脚是不够的——真正需要
            它们的时刻（支付出问题、想删账号、想知道数据存在哪）都发生在登录之后，
            而登录态下用户根本不会想到退出去看首页。
            刻意做得极轻：一行小字，不与底部 Tab 抢注意力。
            下方内边距要清掉手机端固定底栏（.lg-tabbar 是 lg:hidden，所以 lg 以下
            都要留出空间），否则最后一行会被压在底栏底下点不到。
            Terms / policy / support have to be reachable once logged in too. A
            landing-page-only footer isn't enough: the moments people actually need
            them (a payment goes wrong, they want their account deleted, they want
            to know where their data lives) all happen after login, and nobody
            thinks to log out and go read the homepage.
            Deliberately featherweight — one line of small text that doesn't
            compete with the bottom tab bar. The bottom padding clears the fixed
            mobile tab bar (.lg-tabbar is lg:hidden, so every width below lg needs
            the room) or the last row ends up trapped under it and untappable. */}
        <footer className="mx-auto w-full max-w-7xl px-4 pb-24 sm:px-6 lg:pb-6">
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-white/[0.06] pt-5 text-[11.5px] text-slate-600">
            <span>© {new Date().getFullYear()} PRISMX</span>
            {(['terms', 'privacy', 'risk'] as const).map((d) => (
              <NavLink key={d} to={`/${d}`} className="transition hover:text-slate-300">
                {t(`legal.${d}.title`)}
              </NavLink>
            ))}
            {/* 同落地页页脚：SUPPORT_EMAIL 留空则不渲染这条，见 config/site.ts */}
            {SUPPORT_EMAIL && (
              <a href={`mailto:${SUPPORT_EMAIL}`} className="transition hover:text-slate-300">
                {t('nav.support')}
              </a>
            )}
          </div>
        </footer>

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
