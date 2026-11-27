// 图上的财经事件：把 EconEventsPrimitive 挂到主序列上，按可见范围拉数据（useEconEvents），
// 悬停（电脑）/ 点按（手机，再点一次收起）徽章弹出提示卡。
// 本组件自己不往图上盖任何 DOM：悬停和点按都走图表库的 crosshairMove / click 事件 +
// primitive 的命中测试，拖动、缩放图表完全不受影响。提示卡用 portal 挂到 body、fixed 定位，
// 不管页面把本组件放在哪一层都对得上；卡片本身不吃指针事件。
// Econ events on the chart: attaches EconEventsPrimitive to the main series, fetches data for the
// visible range (useEconEvents), and shows a card on hover (desktop) / tap (phone; tap again to
// close). No DOM is laid over the chart: hover and tap come from the chart's crosshairMove / click
// events plus the primitive's hit test, so dragging and zooming are untouched. The card is a
// fixed-position portal on body, so it lines up wherever the page mounts this component, and it
// ignores pointer events itself.
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { IChartApi, ISeriesApi, MouseEventParams, SeriesType, Time } from 'lightweight-charts'
import { CHART_PALETTES, type ChartThemeName } from '../chartTheme'
import { offsetLabel, wallClock } from '../chartTime'
import { registerBarTimes, xToTime } from '../draw/coords'
import { CurrencyFlag } from '../pro/SymbolLogo'
import { Countdown, filled, fmtNum, rowsOf } from '../../admin/econ/econShared'
import { BLOCK_DAYS, type EconEvent } from './econEvents'
import { BADGE_R, EconEventsPrimitive, impColor, type DrawnCluster } from './EconEventsPrimitive'
import { useEconEvents } from './useEconEvents'
import { useBackToClose } from '../../../utils/useBackToClose'
import '../../../styles/chart-events.css'

export interface EconEventsLayerProps {
  chart: IChartApi | null
  /** 主序列（事件挂在它所在的主图窗格）/ the main series (markers live in its pane) */
  series: ISeriesApi<SeriesType, Time> | null
  symbol: string
  enabled: boolean
  /** 2 = 中 + 高；3 = 只看高 / 2 = medium + high; 3 = high only */
  minImportance?: 2 | 3
  /** 图表时区设置（ChartPrefs.timezone）/ the chart's timezone pref */
  timezone: string
  theme?: ChartThemeName
  /** 可选：bar 时间访问器；DrawLayer 没挂时用它登记，未来时间才能外推 / optional bar-times getter for extrapolation when DrawLayer isn't mounted */
  getBarTimes?: () => number[]
  /** 涨跌色（公布值高于 / 低于预期的颜色）；缺省用站内 --up / --down / up/down colours for beats / misses */
  colors?: { up: string; down: string }
}

const DAY = 86400
const CARD_W = 288
const MAX_ROWS = 6
const coarse = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

function EconEventsLayer({ chart, series, symbol, enabled, minImportance = 2, timezone, theme = 'dark', getBarTimes, colors }: EconEventsLayerProps) {
  const [prim] = useState(() => new EconEventsPrimitive())
  const [range, setRange] = useState<{ from: number; to: number } | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [pinned, setPinned] = useState<string | null>(null)
  const { events, nowMs } = useEconEvents(symbol, range?.from ?? null, range?.to ?? null, { enabled, minImportance })

  useEffect(() => { if (chart && getBarTimes) registerBarTimes(chart, getBarTimes) }, [chart, getBarTimes])

  // 挂 / 卸 primitive / attach & detach the primitive
  useEffect(() => {
    if (!series || !enabled) return
    series.attachPrimitive(prim)
    return () => { try { series.detachPrimitive(prim) } catch { /* 序列已随图表销毁 / series already gone */ } }
  }, [series, enabled, prim])

  useEffect(() => { prim.setEvents(enabled ? events : [], nowMs) }, [prim, events, nowMs, enabled])
  useEffect(() => { prim.setBg(CHART_PALETTES[theme].bg) }, [prim, theme])
  const active = pinned ?? hover
  useEffect(() => { prim.setHovered(active) }, [prim, active])
  // 换品种 / 关掉时收起卡片 / close the card on symbol switch or when disabled
  useEffect(() => { setPinned(null); setHover(null) }, [symbol, enabled])
  // 点开（钉住）的卡片接返回手势：返回先收卡片，不越过它离开图表 / a pinned card claims the back gesture
  useBackToClose(pinned != null, () => setPinned(null))

  // 可见时间范围：只在跨块时更新 state（平移不会每帧重渲染）
  // Visible time range: state changes only when a block boundary is crossed (no per-frame renders)
  const rangeKey = useRef('')
  useEffect(() => {
    if (!chart || !enabled) return
    const ts = chart.timeScale()
    let raf = 0
    const read = () => {
      raf = 0
      const w = ts.width()
      const a = xToTime(chart, 0)
      const b = xToTime(chart, w)
      if (a == null || b == null) return
      const span = BLOCK_DAYS * DAY
      const key = `${Math.floor(a / span)}:${Math.floor(b / span)}`
      if (key === rangeKey.current) return
      rangeKey.current = key
      setRange({ from: a, to: b })
    }
    const onRange = () => {
      if (!raf) raf = requestAnimationFrame(read)
      setPinned(null)
    }
    read()
    ts.subscribeVisibleLogicalRangeChange(onRange)
    return () => { ts.unsubscribeVisibleLogicalRangeChange(onRange); if (raf) cancelAnimationFrame(raf); rangeKey.current = '' }
  }, [chart, enabled])

  // 悬停 / 点按 / hover & tap
  useEffect(() => {
    if (!chart || !enabled) return
    const inMain = (p: MouseEventParams<Time>) => p.point && (p.paneIndex == null || p.paneIndex === 0)
    const onMove = (p: MouseEventParams<Time>) => {
      const d = inMain(p) ? prim.hitAt(p.point!.x, p.point!.y) : null
      setHover(d ? d.id : null)
    }
    const onClick = (p: MouseEventParams<Time>) => {
      const d = inMain(p) ? prim.hitAt(p.point!.x, p.point!.y, coarse() ? BADGE_R + 9 : BADGE_R + 3) : null
      setPinned((cur) => (d ? (cur === d.id ? null : d.id) : null))
    }
    chart.subscribeCrosshairMove(onMove)
    chart.subscribeClick(onClick)
    return () => { chart.unsubscribeCrosshairMove(onMove); chart.unsubscribeClick(onClick) }
  }, [chart, enabled, prim])

  if (!enabled || !chart || !active) return null
  const d = prim.drawn.find((c) => c.id === active)
  if (!d) return null
  return createPortal(<EconCard chart={chart} prim={prim} d={d} timezone={timezone} nowMs={nowMs} colors={colors} />, document.body)
}

export default memo(EconEventsLayer)

// ── 提示卡 / the card ──
function EconCard({ chart, prim, d, timezone, nowMs, colors }: { chart: IChartApi; prim: EconEventsPrimitive; d: DrawnCluster; timezone: string; nowMs: number; colors?: { up: string; down: string } }) {
  const { t, i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number; tail: number } | null>(null)

  // 卡片放在徽章正上方，左右夹在图表范围内；放不下就贴视口 / above the badge, clamped to the chart, then to the viewport
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const box = chart.chartElement().getBoundingClientRect()
    const leftW = chart.priceScale('left').width()
    const w = el.offsetWidth
    const h = el.offsetHeight
    const ax = box.left + leftW + d.x
    const ay = box.top + prim.centerY() - BADGE_R - 8
    const vw = window.innerWidth
    let left = Math.min(Math.max(ax - w / 2, box.left + 4), box.right - w - 4)
    left = Math.min(Math.max(left, 8), vw - w - 8)
    const top = Math.max(8, ay - h)
    const tail = Math.min(Math.max(ax - left, 12), w - 12)
    setPos((p) => (p && p.left === left && p.top === top && p.tail === tail ? p : { left, top, tail }))
  }, [chart, prim, d.x, d.id])

  const items = d.cluster.items
  const shown = items.slice(0, MAX_ROWS)
  return (
    <div ref={ref} className="cev-card" role="tooltip" style={pos ? { left: pos.left, top: pos.top, width: CARD_W } : { left: -9999, top: 0, width: CARD_W }}>
      {shown.map((e) => <EventBlock key={e.key} e={e} zh={zh} timezone={timezone} nowMs={nowMs} colors={colors} />)}
      {items.length > shown.length && <p className="cev-more">{t('charts.events.more', { n: items.length - shown.length })}</p>}
      {pos && <i className="cev-tail" aria-hidden style={{ left: pos.tail }} />}
    </div>
  )
}

/** 事件时间：按图表时区，「11-28 周五 21:30 UTC+8」/ the release time in the chart's zone */
export function fmtEventTime(tz: string, t: number, allDay: boolean, lang: string, allDayLabel: string): string {
  const d = wallClock(tz, t)
  const p2 = (n: number) => String(n).padStart(2, '0')
  let wd = ''
  try { wd = new Intl.DateTimeFormat(lang, { weekday: 'short', timeZone: 'UTC' }).format(d) } catch { /* 语言不认识 / unknown locale */ }
  const date = `${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}${wd ? ` ${wd}` : ''}`
  if (allDay) return `${date} · ${allDayLabel}`
  return `${date} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} ${offsetLabel(tz, t)}`
}

function Dots({ n }: { n: number }) {
  const col = impColor(n)
  return (
    <span className="cev-dots" aria-hidden>
      {[1, 2, 3].map((i) => <i key={i} style={i <= n ? { background: col } : undefined} />)}
    </span>
  )
}

function EventBlock({ e, zh, timezone, nowMs, colors }: { e: EconEvent; zh: boolean; timezone: string; nowMs: number; colors?: { up: string; down: string } }) {
  const { t, i18n } = useTranslation()
  const g = e.group
  const rows = rowsOf(g, zh)
  const upcoming = e.t * 1000 > nowMs && !rows.some((r) => r.v && filled(r.v.actual))
  const out = g.outcome
  const tint = (measure: string | undefined) => {
    if (!out || out.measure !== measure || out.outcome === 'inline') return undefined
    const c = colors ?? { up: 'var(--up)', down: 'var(--down)' }
    return out.outcome === 'above' ? c.up : c.down
  }
  return (
    <section className="cev-ev">
      <header className="cev-hd">
        <CurrencyFlag currency={e.currency} size={16} />
        <b>{e.currency}</b>
        <span className="cev-time">{fmtEventTime(timezone, e.t, e.allDay, i18n.language, String(t('econ.allDay')))}</span>
        <Dots n={e.importance} />
      </header>
      {rows.map((r, i) => {
        const v = r.v
        return (
          <div key={v?.measure ?? `n${i}`} className="cev-row">
            <p className="cev-name">{r.label}</p>
            {v && (
              <dl className="cev-vals">
                <div><dt>{t('econ.actual')}</dt><dd style={{ color: tint(v.measure) }}>{filled(v.actual) ? fmtNum(v.actual, v.unit) : '—'}</dd></div>
                <div><dt>{t('econ.consensus')}</dt><dd>{filled(v.consensus) ? fmtNum(v.consensus, v.unit) : '—'}</dd></div>
                <div><dt>{t('econ.previous')}</dt><dd>{filled(v.previous) ? fmtNum(v.previous, v.unit) : '—'}</dd></div>
              </dl>
            )}
          </div>
        )
      })}
      {out && <p className="cev-tag" style={{ color: tint(out.measure) }}>{t(`econ.scenario.${out.basis ?? 'consensus'}.${out.outcome}`)}</p>}
      {upcoming && !e.allDay && (
        <p className="cev-due">{t('econ.ticker.in')} <Countdown to={e.t * 1000} className="num" /></p>
      )}
      {!upcoming && !rows.some((r) => r.v && filled(r.v.actual)) && rows.some((r) => r.v) && (
        <p className="cev-due">{t('econ.ticker.awaiting')}</p>
      )}
    </section>
  )
}
