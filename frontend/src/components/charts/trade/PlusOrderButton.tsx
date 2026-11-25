// 价格轴边上跟着十字线走的「+」：点开给出这个价位上能挂的两种单（高于现价是买入止损 /
// 卖出限价，低于现价是买入限价 / 卖出止损），选一个就在图上开一张投影单。只在有鼠标的设备上出现。
// The "+" riding the crosshair at the price-axis edge: it offers the two orders that can rest
// at that price (above the market: buy stop / sell limit; below: buy limit / sell stop), and
// picking one opens a projected order on the chart. Mouse devices only.
// 阶段 5 起菜单第一项是「在这个价位添加警报」；没有在线账户时只剩这一项。
// Since phase 5 the first item adds an alert at that price; without an online account it's the only one.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IChartApi, MouseEventParams } from 'lightweight-charts'
import type { MainSeriesApi } from '../useChartEngine'
import { isChartAlive } from '../chartLifecycle'
import { autoEntryType, type Side } from './tradeMath'

interface Props {
  chart: IChartApi
  series: MainSeriesApi
  digits: number
  quote: () => { bid: number | null; ask: number | null }
  // 没有可下单账户时为 null（菜单只剩「添加警报」）/ null without a tradable account (the menu keeps only the alert item)
  onPick: ((side: Side, price: number) => void) | null
  onAlert?: (price: number) => void
}

export default function PlusOrderButton({ chart, series, digits, quote, onPick, onAlert }: Props) {
  const { t } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const [at, setAt] = useState<{ y: number; x: number; price: number } | null>(null)
  const [menu, setMenu] = useState<{ y: number; x: number; price: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // 鼠标移到「+」上就离开了图表画布，图表会报「十字线没了」；这时要是把「+」藏掉，鼠标又落回
  // 画布、「+」又出现……来回闪。所以指在「+」上时不理会这类事件，移出「+」再交还给十字线。
  // Moving onto the "+" leaves the chart canvas, so the chart reports "no crosshair"; hiding
  // the "+" then drops the mouse back on the canvas, which shows it again — a flicker loop.
  // While the pointer is on the "+" those events are ignored; leaving it hands back to the crosshair.
  const overRef = useRef(false)

  useEffect(() => {
    const onMove = (p: MouseEventParams) => {
      if (menu) return
      if (!p.point || p.paneIndex !== 0) { if (!overRef.current) setAt(null); return }
      const price = series.coordinateToPrice(p.point.y) as number | null
      if (price == null || !(price > 0)) { setAt(null); return }
      const w = chart.paneSize(0).width
      setAt({ y: p.point.y, x: w - 22, price })
    }
    chart.subscribeCrosshairMove(onMove)
    return () => { if (isChartAlive(chart)) chart.unsubscribeCrosshairMove(onMove) }
  }, [chart, series, menu])

  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(null) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey) }
  }, [menu])

  if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) return null
  const q = quote()
  const option = (side: Side, price: number) => {
    const type = autoEntryType(side, price, q.bid, q.ask)
    return (
      <button key={side} type="button" role="menuitem" className={`chart-ctx-item ${side === 'BUY' ? 'up' : 'dn'}`} onClick={() => { setMenu(null); onPick?.(side, price) }}>
        <span>{tt(`order.pending.type.${side}_${type}`)}</span><kbd>{price.toFixed(digits)}</kbd>
      </button>
    )
  }

  return (
    <>
      {at && !menu && (
        <button
          type="button"
          className="chart-plus"
          style={{ top: at.y - 9, left: at.x }}
          title={tt('charts.trade.plusTip')}
          aria-label={tt('charts.trade.plusTip')}
          onPointerEnter={() => { overRef.current = true }}
          // 移回画布时下一次十字线事件会马上把它放回去；移到价格轴或图外就该消失
          // Back on the canvas the next crosshair event re-places it at once; over the axis or off the chart it should go
          onPointerLeave={() => { overRef.current = false; setAt(null) }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => { overRef.current = false; setMenu(at) }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden><path d="M12 5v14M5 12h14" /></svg>
        </button>
      )}
      {menu && (
        <div ref={menuRef} className="chart-ctx chart-plus-menu" role="menu" style={{ top: menu.y + 12, left: Math.max(6, menu.x - 200) }}>
          {onAlert && (
            <button type="button" role="menuitem" className="chart-ctx-item" onClick={() => { setMenu(null); onAlert(menu.price) }}>
              <span>{tt('charts.alert.addAt')}</span><kbd>{menu.price.toFixed(digits)}</kbd>
            </button>
          )}
          {onPick && option('BUY', menu.price)}
          {onPick && option('SELL', menu.price)}
        </div>
      )}
    </>
  )
}
