// 专业版终端的三件小外壳：
//   ProDock   —— 图表下方的交易面板（持仓 / 挂单 / 历史），上沿可拖高，松手才存；
//   ProIsland —— 图表顶部正中的「灵动岛」：断线常驻，警报触发时展开 5 秒，点一下打开警报管理；
//   ProTabBar —— 手机底部 iOS 式标签栏：自选 · 画线 · 指标 · 持仓 · 下单。
// Three small pieces of pro-terminal chrome:
//   ProDock   — the trading panel under the chart (positions / orders / history); drag its top
//               edge to resize, saved on release;
//   ProIsland — a pill at the chart's top centre: stays while quotes are down, expands for 5 s
//               when an alert fires, and opens the alert manager on tap;
//   ProTabBar — the phone's iOS-style tab bar: watchlist · draw · indicators · positions · trade.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DOCK_MAX, DOCK_MIN } from './proPrefs'
import { IcBell, IcBriefcase, IcFx, IcList, IcPen, IcTrade, IcWifiOff } from './icons'

export function ProDock({ height, onHeight, children }: { height: number; onHeight: (px: number) => void; children: ReactNode }) {
  const { t } = useTranslation()
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<{ y0: number; h0: number; id: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  // 拖动上限再受视口限制：图表至少留 200px / the max also leaves the chart at least 200px
  const maxH = () => Math.min(DOCK_MAX, Math.max(DOCK_MIN, window.innerHeight - 48 - 200))
  const clampH = (v: number) => Math.round(Math.min(maxH(), Math.max(DOCK_MIN, v)))
  const setH = (px: number) => { if (box.current) box.current.style.height = `${px}px` }
  return (
    <div ref={box} className="pt-dock" style={{ height: clampH(height) }}>
      <div
        className={`pt-resize-y ${dragging ? 'on' : ''}`}
        role="separator"
        aria-orientation="horizontal"
        aria-label={String(t('charts.pro.resizeDock'))}
        aria-valuenow={height}
        aria-valuemin={DOCK_MIN}
        aria-valuemax={DOCK_MAX}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
          e.preventDefault()
          onHeight(clampH(height + (e.key === 'ArrowUp' ? 16 : -16)))
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { y0: e.clientY, h0: box.current?.offsetHeight ?? height, id: e.pointerId }
          setDragging(true)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d || d.id !== e.pointerId) return
          setH(clampH(d.h0 + d.y0 - e.clientY))
        }}
        onPointerUp={(e) => {
          const d = drag.current
          drag.current = null
          setDragging(false)
          if (!d || d.id !== e.pointerId) return
          onHeight(clampH(d.h0 + d.y0 - e.clientY))
        }}
        onPointerCancel={() => { drag.current = null; setDragging(false); setH(clampH(height)) }}
        onDoubleClick={() => onHeight(220)}
      />
      {children}
    </div>
  )
}

export interface IslandEvent { id: number; symbol: string; message: string; price: number | null }

export function ProIsland({ down, event, digits, onOpen, onDismiss }: {
  down: boolean
  event: IslandEvent | null
  digits: (symbol: string) => number
  onOpen: () => void
  onDismiss: () => void
}) {
  const { t } = useTranslation()
  // 警报卡片停 5 秒；指针停在上面时不计时（正在读）/ the alert card stays 5 s, paused while hovered
  const [hover, setHover] = useState(false)
  useEffect(() => {
    if (!event || hover) return
    const id = window.setTimeout(onDismiss, 5000)
    return () => window.clearTimeout(id)
  }, [event, hover, onDismiss])

  if (event) {
    return (
      <div className="pt-island-wrap">
        <button
          key={event.id}
          type="button"
          className="pt-island alert"
          onClick={() => { onDismiss(); onOpen() }}
          onPointerEnter={() => setHover(true)}
          onPointerLeave={() => setHover(false)}
          aria-live="assertive"
        >
          <span className="pt-island-ic"><IcBell size={15} /></span>
          <span className="pt-island-tx">
            <b>{event.symbol}{event.price != null && <em>{event.price.toFixed(digits(event.symbol))}</em>}</b>
            <small>{event.message || String(t('charts.pro.alertFired'))}</small>
          </span>
        </button>
      </div>
    )
  }
  if (!down) return null
  return (
    <div className="pt-island-wrap">
      <div className="pt-island down" role="status">
        <IcWifiOff size={14} />
        <span>{t('charts.pro.offline')}</span>
      </div>
    </div>
  )
}

export type ProTab = 'watch' | 'draw' | 'ind' | 'pos' | 'trade'

export function ProTabBar({ active, onTab, posBadge }: { active: ProTab | null; onTab: (t: ProTab) => void; posBadge: ReactNode }) {
  const { t } = useTranslation()
  const tabs: { id: ProTab; icon: ReactNode; label: string }[] = [
    { id: 'watch', icon: <IcList size={21} />, label: String(t('charts.pro.tab.watch')) },
    { id: 'draw', icon: <IcPen size={21} />, label: String(t('charts.pro.tab.draw')) },
    { id: 'ind', icon: <IcFx size={21} />, label: String(t('charts.pro.tab.ind')) },
    { id: 'pos', icon: <IcBriefcase size={21} />, label: String(t('charts.pro.tab.pos')) },
    { id: 'trade', icon: <IcTrade size={21} />, label: String(t('charts.pro.tab.trade')) },
  ]
  return (
    <nav className="pt-tabbar" aria-label={String(t('charts.pro.name'))}>
      {tabs.map((x) => (
        <button key={x.id} type="button" className={`pt-tab ${active === x.id ? 'on' : ''} ${x.id === 'trade' ? 'accent' : ''}`} onClick={() => onTab(x.id)} aria-pressed={active === x.id}>
          <span className="pt-tab-ic">
            {x.icon}
            {x.id === 'pos' && posBadge}
          </span>
          <span className="pt-tab-lb">{x.label}</span>
        </button>
      ))}
    </nav>
  )
}
