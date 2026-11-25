// 图上的警报线：当前品种的价格类警报画成虚线价格线（生效 = 琥珀色，已停止 = 灰），价格轴左边
// 各有一个铃铛小把手——上下拖改价位（松手即保存），点一下打开编辑。触发时在触发价闪一条线。
// 把手位置每帧按价格轴重算（缩放 / 平移 / 自动缩放都没有事件），只改 DOM 的 top，不走 React。
// Alert lines on the chart: the current symbol's price alerts as dashed price lines (active =
// amber, stopped = grey), each with a small bell handle left of the price axis — drag it to
// move the level (saved on release), click to edit. A fire flashes a line at the fire price.
// Handles are re-placed every frame from the price scale (zoom / pan / autoscale fire no
// events); only their DOM top changes, React is not involved.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LineStyle, type IChartApi, type IPriceLine } from 'lightweight-charts'
import type { ChartAlert } from '../../../api/types'
import { onChartAlertFired } from '../../../utils/chartAlertEvents'
import type { MainSeriesApi } from '../useChartEngine'
import { isChartAlive } from '../chartLifecycle'
import { updateAlert, useChartAlerts } from './alertStore'
import { defaultMessage, priceLevels, toIn } from './model'

const ACTIVE = '#f5c451'
const PAUSED = '#7c7f8f'
const FLASH = '#ffd166'

interface Props {
  chart: IChartApi
  series: MainSeriesApi
  symbol: string
  digits: number
  bid: () => number | null
  label: string
  dragTip: string
  onEdit: (a: ChartAlert) => void
  onError: (msg: string) => void
}

interface Item { k: string; a: ChartAlert; key: 'level' | 'lo' | 'hi'; price: number }

export default function AlertLines({ chart, series, symbol, digits, bid, label, dragTip, onEdit, onError }: Props) {
  const { t } = useTranslation()
  const { alerts } = useChartAlerts()
  const items = useMemo<Item[]>(() => {
    const sym = symbol.toUpperCase()
    return alerts
      .filter((a) => a.symbol.toUpperCase() === sym && (a.status === 'active' || a.status === 'paused'))
      .flatMap((a) => priceLevels(a).map((l) => ({ k: `${a.id}:${l.key}`, a, key: l.key, price: l.price })))
  }, [alerts, symbol])
  const [drag, setDrag] = useState<{ k: string; price: number } | null>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const dragRef = useRef(drag)
  dragRef.current = drag

  // ── 价格线 / price lines ──
  const linesRef = useRef(new Map<string, IPriceLine>())
  useEffect(() => {
    const m = linesRef.current
    const want = new Set<string>()
    for (const it of items) {
      want.add(it.k)
      const opts = {
        price: drag?.k === it.k ? drag.price : it.price,
        color: it.a.status === 'active' ? ACTIVE : PAUSED,
        lineWidth: (drag?.k === it.k ? 2 : 1) as 1 | 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: label,
      }
      const ex = m.get(it.k)
      if (ex) ex.applyOptions(opts)
      else m.set(it.k, series.createPriceLine(opts))
    }
    for (const [k, l] of m) {
      if (want.has(k)) continue
      try { series.removePriceLine(l) } catch { /* 图表已销毁 / chart gone */ }
      m.delete(k)
    }
  }, [items, drag, series, label])
  useEffect(() => {
    const m = linesRef.current
    return () => {
      for (const l of m.values()) { try { series.removePriceLine(l) } catch { /* 图表已销毁 / chart gone */ } }
      m.clear()
    }
  }, [series])

  // ── 触发闪烁 / flash on fire ──
  useEffect(() => onChartAlertFired((ev) => {
    if (ev.symbol.toUpperCase() !== symbol.toUpperCase() || !(ev.price > 0)) return
    let line: IPriceLine | null = null
    try { line = series.createPriceLine({ price: ev.price, color: FLASH, lineWidth: 3, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: label }) } catch { return }
    let n = 0
    const id = window.setInterval(() => {
      n += 1
      if (!isChartAlive(chart) || n >= 8) {
        window.clearInterval(id)
        try { if (line) series.removePriceLine(line) } catch { /* 图表已销毁 / chart gone */ }
        return
      }
      try { line?.applyOptions({ lineWidth: n % 2 ? 1 : 3, color: n % 2 ? ACTIVE : FLASH }) } catch { window.clearInterval(id) }
    }, 300)
  }), [chart, series, symbol, label])

  // ── 把手位置（每帧）/ handle positions (per frame) ──
  const handlesRef = useRef(new Map<string, HTMLButtonElement>())
  useEffect(() => {
    if (items.length === 0) return
    let raf = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      if (!isChartAlive(chart)) return
      let size: { width: number; height: number }
      try { size = chart.paneSize(0) } catch { return }
      const d = dragRef.current
      for (const it of itemsRef.current) {
        const el = handlesRef.current.get(it.k)
        if (!el) continue
        const y = series.priceToCoordinate(d?.k === it.k ? d.price : it.price)
        const show = y != null && y >= 0 && y <= size.height
        const top = show ? `${Math.round(y - 9)}px` : '-100px'
        const left = `${size.width - 52}px`
        if (el.style.top !== top) el.style.top = top
        if (el.style.left !== left) el.style.left = left
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [items.length, chart, series])

  // ── 拖动 / drag ──
  const g = useRef<{ k: string; id: number; y0: number; moved: boolean } | null>(null)
  const round = (p: number) => { const f = Math.pow(10, digits); return Math.round(p * f) / f }
  const priceAt = (el: HTMLElement, clientY: number) => {
    const host = el.offsetParent as HTMLElement | null
    if (!host) return null
    const p = series.coordinateToPrice(clientY - host.getBoundingClientRect().top)
    return p == null || !(Number(p) > 0) ? null : round(Number(p))
  }
  const commit = async (it: Item, price: number) => {
    const spec = { ...it.a.spec, [it.key]: price } as Record<string, unknown>
    if (it.key !== 'level' && typeof spec.lo === 'number' && typeof spec.hi === 'number' && spec.lo > spec.hi) [spec.lo, spec.hi] = [spec.hi, spec.lo]
    const b = bid()
    if (b != null && b > 0) spec.ref = b
    // 消息还是自动生成的那句就跟着新价位重写；用户自己写的不动
    // A message that is still the generated default follows the new level; a custom one is kept
    const msg = it.a.message === defaultMessage(it.a, digits, t) ? defaultMessage({ ...it.a, spec }, digits, t) : it.a.message
    try { await updateAlert(it.a.id, toIn(it.a, { spec, message: msg })) } catch (e) { onError(e instanceof Error ? e.message : '') }
    setDrag((d) => (d?.k === it.k ? null : d))
  }

  if (items.length === 0) return null
  return (
    <>
      {items.map((it) => (
        <button
          key={it.k}
          ref={(el) => { if (el) handlesRef.current.set(it.k, el); else handlesRef.current.delete(it.k) }}
          type="button"
          className={`alert-handle ${it.a.status === 'active' ? '' : 'off'} ${drag?.k === it.k ? 'drag' : ''}`}
          style={{ top: -100 }}
          title={`${it.a.message}\n${dragTip}`}
          aria-label={it.a.message}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            e.preventDefault()
            e.currentTarget.setPointerCapture(e.pointerId)
            g.current = { k: it.k, id: e.pointerId, y0: e.clientY, moved: false }
          }}
          onPointerMove={(e) => {
            const s = g.current
            if (!s || s.id !== e.pointerId) return
            if (!s.moved && Math.abs(e.clientY - s.y0) < 4) return
            s.moved = true
            const p = priceAt(e.currentTarget, e.clientY)
            if (p != null) setDrag({ k: it.k, price: p })
          }}
          onPointerUp={(e) => {
            const s = g.current
            g.current = null
            if (!s || s.id !== e.pointerId) return
            if (!s.moved) { onEdit(it.a); return }
            const d = dragRef.current
            if (d?.k === it.k && d.price !== it.price) void commit(it, d.price)
            else setDrag(null)
          }}
          onPointerCancel={() => { g.current = null; setDrag(null) }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 16V11a6 6 0 0112 0v5l2 2H4z" /><path d="M10 21h4" /></svg>
        </button>
      ))}
    </>
  )
}
