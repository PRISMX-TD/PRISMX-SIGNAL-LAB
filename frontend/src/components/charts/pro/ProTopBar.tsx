// 专业版终端顶栏。桌面一行：导航 · 品种（点开命令面板搜品种）· 实时价 · 周期分段 · 更多周期 ·
// 图表类型 · 指标 · 警报 ┊ 搜索 · 截图 · 设置 · 专注 · 全屏 · 经典/专业切换。
// 手机两行（iOS 导航栏）：第一行 导航 · 品种与价格 · 警报 · 更多；第二行周期分段可横滑 + 图表类型 + 指标。
// 跳价只重渲染价格那一小块（ProPrice 自己订阅当前品种报价）。
// Pro terminal top bar. Desktop, one row: nav · symbol (opens the command palette on
// symbols) · live price · interval segments · more intervals · chart type · indicators ·
// alerts ┊ search · screenshot · settings · focus · fullscreen · classic/pro switch.
// Phone, two rows (iOS nav bar): nav · symbol & price · alerts · more; then a sideways-
// scrolling interval control + chart type + indicators. A tick repaints only ProPrice.
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../../store/auth'
import { useGlobalQuote } from '../../../store/live'
import { symbolMeta } from '../../../utils/symbolMeta'
import { displaySymbol } from '../../../api/utils'
import { EMPTY } from '../../../utils/format'
import ChartPopover from '../ChartPopover'
import IntervalMenu from '../IntervalMenu'
import ChartTypeMenu from '../ChartTypeMenu'
import { intervalLabel } from '../intervals'
import type { ChartType } from '../chartPrefs'
import type { DayStats } from '../SymbolHeader'
import ProSegmented from './ProSegmented'
import type { ProLayout } from './proPrefs'
import {
  IcApps, IcBell, IcCalendar, IcCamera, IcChevron, IcClassic, IcCollapse, IcExpand, IcFocus, IcFx, IcGear,
  IcHome, IcKeyboard, IcMore, IcOrders, IcSearch, IcSignal, IcTrophy,
} from './icons'

interface Props {
  desktop: boolean
  symbol: string
  interval: string
  digits: number
  dayStats: DayStats | null
  fallbackPrice: number
  quotesDown: boolean
  favIntervals: string[]
  onInterval: (code: string) => void
  onFavIntervals: (codes: string[]) => void
  chartType: ChartType
  onChartType: (t: ChartType) => void
  onIndicators: () => void
  onAlerts: () => void
  alertCount: number
  onCommand: () => void
  onSymbol: () => void
  onShot: () => void
  onSettings: () => void
  onKeys: () => void
  focus: boolean
  onFocus: () => void
  fullscreen: boolean
  onFullscreen: () => void
  onLayout: (l: ProLayout) => void
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

export default function ProTopBar(p: Props) {
  const { t } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const ivOptions = useMemo(() => {
    const codes = p.favIntervals.includes(p.interval) ? p.favIntervals : [...p.favIntervals, p.interval]
    return codes.map((c) => ({ value: c, label: intervalLabel(c) }))
  }, [p.favIntervals, p.interval])
  const layoutOptions = useMemo(() => [
    { value: 'classic' as const, label: tt('charts.pro.classic') },
    { value: 'pro' as const, label: tt('charts.pro.pro') },
  // eslint-disable-next-line react-hooks/exhaustive-deps -- tt changes with the language only
  ], [t])

  if (!p.desktop) return <MobileBar {...p} ivOptions={ivOptions} />

  return (
    <header className="pt-top">
      <AppMenu onLayout={p.onLayout} onKeys={p.onKeys} />
      <button type="button" className="pt-sym" onClick={p.onSymbol} title={tt('charts.pro.cmd.symbolTip')}>
        <SymAvatar symbol={p.symbol} />
        <span className="pt-sym-name">{p.symbol || EMPTY}</span>
        <IcChevron size={13} />
      </button>
      <ProPrice symbol={p.symbol} digits={p.digits} dayStats={p.dayStats} fallback={p.fallbackPrice} down={p.quotesDown} />
      <span className="pt-sep" aria-hidden />
      <ProSegmented value={p.interval} options={ivOptions} onChange={p.onInterval} ariaLabel={tt('charts.pro.interval')} size="sm" className="pt-iv" />
      <IntervalMenu value={p.interval} onChange={p.onInterval} favorites={p.favIntervals} onFavorites={p.onFavIntervals} />
      <ChartTypeMenu value={p.chartType} onChange={p.onChartType} />
      <span className="pt-sep" aria-hidden />
      <button type="button" className="pt-btn" onClick={p.onIndicators}>
        <IcFx size={15} /><span>{tt('charts.indicators.short')}</span>
      </button>
      <button type="button" className="pt-btn" onClick={p.onAlerts} title={`${tt('charts.alert.manager')} (Alt+A)`}>
        <IcBell size={15} /><span>{tt('charts.pro.alerts')}</span>
        {p.alertCount > 0 && <b className="pt-count">{p.alertCount}</b>}
      </button>

      <div className="pt-top-r">
        <button type="button" className="pt-search" onClick={p.onCommand}>
          <IcSearch size={14} />
          <span>{tt('charts.pro.cmd.open')}</span>
          <kbd>{isMac ? '⌘' : 'Ctrl'} K</kbd>
        </button>
        <button type="button" className="pt-icon" onClick={p.onShot} title={`${tt('charts.shot.save')} (Ctrl+Alt+S)`} aria-label={tt('charts.shot.save')}><IcCamera /></button>
        <button type="button" className="pt-icon" onClick={p.onSettings} title={tt('charts.settings.title')} aria-label={tt('charts.settings.title')}><IcGear /></button>
        <button type="button" className={`pt-icon ${p.focus ? 'on' : ''}`} onClick={p.onFocus} aria-pressed={p.focus} title={tt(p.focus ? 'charts.pro.focusOff' : 'charts.pro.focusOn')} aria-label={tt('charts.pro.focus')}><IcFocus /></button>
        <button type="button" className="pt-icon" onClick={p.onFullscreen} title={tt(p.fullscreen ? 'charts.fullscreen.exit' : 'charts.fullscreen.enter')} aria-label={tt(p.fullscreen ? 'charts.fullscreen.exit' : 'charts.fullscreen.enter')}>
          {p.fullscreen ? <IcCollapse /> : <IcExpand />}
        </button>
        <ProSegmented value="pro" options={layoutOptions} onChange={p.onLayout} ariaLabel={tt('charts.pro.layout')} size="sm" className="pt-layout" />
      </div>
    </header>
  )
}

function MobileBar(p: Props & { ivOptions: { value: string; label: string }[] }) {
  const { t } = useTranslation()
  const tt = (k: string) => String(t(k))
  const moreRef = useRef<HTMLButtonElement>(null)
  const [more, setMore] = useState(false)
  const pick = (fn: () => void) => () => { setMore(false); fn() }
  return (
    <header className="pt-top pt-top--m">
      <div className="pt-top-row">
        <AppMenu onLayout={p.onLayout} onKeys={null} />
        <button type="button" className="pt-sym" onClick={p.onSymbol}>
          <SymAvatar symbol={p.symbol} />
          <span className="pt-sym-col">
            <span className="pt-sym-name">{p.symbol || EMPTY}<IcChevron size={12} /></span>
            <ProPrice symbol={p.symbol} digits={p.digits} dayStats={p.dayStats} fallback={p.fallbackPrice} down={p.quotesDown} compact />
          </span>
        </button>
        <div className="pt-top-r">
          <button type="button" className="pt-icon" onClick={p.onAlerts} aria-label={tt('charts.alert.manager')}>
            <IcBell size={18} />
            {p.alertCount > 0 && <b className="pt-dot-count">{p.alertCount}</b>}
          </button>
          <button ref={moreRef} type="button" className={`pt-icon ${more ? 'on' : ''}`} onClick={() => setMore((v) => !v)} aria-label={tt('charts.pro.more')} aria-haspopup="menu" aria-expanded={more}>
            <IcMore size={18} />
          </button>
          <ChartPopover open={more} onClose={() => setMore(false)} anchorRef={moreRef} width={232} align="end" label={tt('charts.pro.more')} className="pt-menu">
            <div className="pt-menu-list" role="menu">
              <MenuItem icon={<IcSearch />} label={tt('charts.pro.cmd.open')} onClick={pick(p.onCommand)} />
              <MenuItem icon={<IcCamera />} label={tt('charts.shot.save')} onClick={pick(p.onShot)} />
              <MenuItem icon={<IcGear />} label={tt('charts.settings.title')} onClick={pick(p.onSettings)} />
              <MenuItem icon={<IcExpand />} label={tt('charts.fullscreen.enter')} onClick={pick(p.onFullscreen)} />
              <hr />
              <MenuItem icon={<IcClassic />} label={tt('charts.pro.toClassic')} onClick={pick(() => p.onLayout('classic'))} />
            </div>
          </ChartPopover>
        </div>
      </div>
      <div className="pt-top-row pt-top-row--tools">
        <div className="pt-iv-scroll no-sb">
          <ProSegmented value={p.interval} options={p.ivOptions} onChange={p.onInterval} ariaLabel={tt('charts.pro.interval')} size="sm" className="pt-iv" />
        </div>
        <IntervalMenu value={p.interval} onChange={p.onInterval} favorites={p.favIntervals} onFavorites={p.onFavIntervals} />
        <ChartTypeMenu value={p.chartType} onChange={p.onChartType} />
        <button type="button" className="pt-icon" onClick={p.onIndicators} aria-label={tt('charts.indicators.button')}><IcFx size={17} /></button>
      </div>
    </header>
  )
}

// 左上角导航：回到站内其它页面，或切回经典版。专业版盖住了全站顶栏，这里是出口。
// Top-left navigation: the way back to the app's other pages or the classic layout. The pro
// terminal covers the site header, so this is the exit.
function AppMenu({ onLayout, onKeys }: { onLayout: (l: ProLayout) => void; onKeys: (() => void) | null }) {
  const { t } = useTranslation()
  const tt = (k: string) => String(t(k))
  const nav = useNavigate()
  const { user } = useAuth()
  const ref = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const arena = user?.gamificationVisible ? '/achievements' : user?.leaderboardVisible ? '/leaderboard' : user?.competitionsVisible ? '/competitions' : '/lucky'
  const go = (to: string) => () => { setOpen(false); nav(to) }
  return (
    <>
      <button ref={ref} type="button" className={`pt-icon pt-apps ${open ? 'on' : ''}`} onClick={() => setOpen((v) => !v)} aria-label={tt('charts.pro.menu')} aria-haspopup="menu" aria-expanded={open}>
        <IcApps size={17} />
      </button>
      <ChartPopover open={open} onClose={() => setOpen(false)} anchorRef={ref} width={236} label={tt('charts.pro.menu')} className="pt-menu">
        <div className="pt-menu-list" role="menu">
          <p className="pt-menu-cap">{tt('charts.pro.name')}</p>
          <MenuItem icon={<IcSignal />} label={tt('nav.signals')} onClick={go('/app')} />
          <MenuItem icon={<IcHome />} label={tt('nav.dashboard')} onClick={go('/dashboard')} />
          <MenuItem icon={<IcOrders />} label={tt('nav.orders')} onClick={go('/orders')} />
          <MenuItem icon={<IcTrophy />} label={tt('nav.growth')} onClick={go(arena)} />
          <MenuItem icon={<IcCalendar />} label={tt('nav.calendar')} onClick={go('/calendar')} />
          <hr />
          {onKeys && <MenuItem icon={<IcKeyboard />} label={tt('charts.keys.title')} onClick={() => { setOpen(false); onKeys() }} />}
          <MenuItem icon={<IcClassic />} label={tt('charts.pro.toClassic')} onClick={() => { setOpen(false); onLayout('classic') }} />
        </div>
      </ChartPopover>
    </>
  )
}

export function MenuItem({ icon, label, onClick, hint }: { icon: React.ReactNode; label: string; onClick: () => void; hint?: string }) {
  return (
    <button type="button" role="menuitem" className="pt-menu-item" onClick={onClick}>
      <span>{label}</span>
      {hint && <kbd>{hint}</kbd>}
      {icon}
    </button>
  )
}

export function SymAvatar({ symbol }: { symbol: string }) {
  const meta = symbolMeta(symbol)
  return <span className="pt-ava" style={{ background: meta.color + '2e', color: meta.ink }} aria-hidden>{meta.letter}</span>
}

// 实时价：大字用 bid（与图上最新价、经典版报价条一致）+ 涨跌幅胶囊。只订阅当前品种一条报价。
// Live price: the bid (matching the chart's last price and the classic strip) + a change
// capsule. Subscribes to the active symbol's quote only.
function ProPrice({ symbol, digits, dayStats, fallback, down, compact = false }: { symbol: string; digits: number; dayStats: DayStats | null; fallback: number; down: boolean; compact?: boolean }) {
  const q = useGlobalQuote(symbol)
  const px = q?.bid ?? (fallback || null)
  const chg = dayStats?.changePct ?? null
  const up = chg != null && chg >= 0
  return (
    <span className={`pt-px ${compact ? 'compact' : ''} ${down ? 'down-feed' : ''}`} title={symbol ? displaySymbol(symbol) : undefined}>
      <span className="pt-px-v">{px == null ? EMPTY : px.toFixed(digits)}</span>
      <span className={`pt-chg ${chg == null ? '' : up ? 'up' : 'dn'}`}>{chg == null ? EMPTY : `${up ? '+' : ''}${(chg * 100).toFixed(2)}%`}</span>
    </span>
  )
}
