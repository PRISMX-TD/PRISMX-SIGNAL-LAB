// 选回放起点的遮罩（replay.selecting 时由页面放在图表容器里，与 ChartLegend 同级）：一条竖线跟着鼠标，
// 线右边整片压暗；点一下就从那根开始。手机上没有悬停：点一下放线，再点顶部的「从这里开始」。
// 图表本身照常能拖动 / 缩放（不挡指针，位置取自图表的十字线 / 点击事件）。顶部还有「选日期」「随机」「取消」，
// 以及该品种周期可回放的最早时间。Esc 取消。
// The replay-start overlay (placed by the page in the chart container while replay.selecting,
// alongside ChartLegend): a vertical line follows the mouse with everything to its right dimmed;
// a click starts there. Phones have no hover: a tap places the line and "Start here" at the top
// confirms. The chart still pans / zooms (the overlay doesn't take pointer events; positions come
// from the chart's crosshair / click events). The top strip also offers date, random and cancel,
// and shows the earliest replayable time. Escape cancels.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { IChartApi, MouseEventParams, Time } from 'lightweight-charts'
import type { ReplayApi } from '../useChartData'
import ChartDialog from '../ChartDialog'
import { zonedToUtc } from '../GoToDateDialog'
import { Ico, RI } from './icons'
import './replay.css'

const p2 = (n: number) => String(n).padStart(2, '0')

export default function ReplaySelectOverlay({ chart, getBarTimes, replay, fmtTime, timezone }: {
  chart: IChartApi
  getBarTimes: () => number[]
  replay: ReplayApi
  fmtTime: (t: number) => string
  // 「选日期」按这个时区解释 / the date picker reads in this timezone
  timezone: string
}) {
  const { t } = useTranslation()
  // 竖线所在的逻辑下标 / the line's logical index
  const [pos, setPos] = useState<number | null>(null)
  const [, setTick] = useState(0)
  const [touchPick, setTouchPick] = useState(false)
  const [dateOpen, setDateOpen] = useState(false)
  const dateOpenRef = useRef(false)
  dateOpenRef.current = dateOpen
  const pointerRef = useRef<string>('mouse')
  const r = useRef(replay)
  r.current = replay
  const getTimes = useRef(getBarTimes)
  getTimes.current = getBarTimes

  const timeAt = (logical: number): number | null => {
    const times = getTimes.current()
    if (times.length === 0) return null
    const i = Math.max(0, Math.min(times.length - 1, Math.round(logical)))
    return times[i]
  }

  useEffect(() => {
    const el = chart.chartElement()
    const onDown = (e: PointerEvent) => { pointerRef.current = e.pointerType || 'mouse' }
    el.addEventListener('pointerdown', onDown, true)
    const onMove = (p: MouseEventParams<Time>) => {
      if (pointerRef.current !== 'mouse') return
      if (p.logical != null) setPos(p.logical as number)
    }
    const onClick = (p: MouseEventParams<Time>) => {
      if (p.logical == null) return
      if (pointerRef.current === 'mouse') {
        const tt = timeAt(p.logical as number)
        if (tt != null) void r.current.start(tt)
      } else {
        setPos(p.logical as number)
        setTouchPick(true)
      }
    }
    const onRange = () => setTick((x) => x + 1)
    chart.subscribeCrosshairMove(onMove)
    chart.subscribeClick(onClick)
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)
    // 日期弹窗开着时 Esc 归弹窗 / with the date dialog open, Escape belongs to it
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !dateOpenRef.current) { e.preventDefault(); e.stopPropagation(); r.current.cancelSelect() } }
    window.addEventListener('keydown', onKey, true)
    return () => {
      el.removeEventListener('pointerdown', onDown, true)
      try {
        chart.unsubscribeCrosshairMove(onMove)
        chart.unsubscribeClick(onClick)
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
      } catch { /* 图表已销毁 / disposed */ }
      window.removeEventListener('keydown', onKey, true)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refs only
  }, [chart])

  let x: number | null = null
  let plotW = 0
  let leftW = 0
  try {
    const ts = chart.timeScale()
    plotW = ts.width()
    leftW = chart.priceScale('left').width()
    if (pos != null) {
      const c = ts.logicalToCoordinate(Math.round(pos) as never)
      if (c != null) x = Math.max(0, Math.min(plotW, c))
    }
  } catch { /* 图表已销毁 / disposed */ }
  const picked = pos != null ? timeAt(pos) : null
  const touch = pointerRef.current !== 'mouse'

  return (
    <div className="rp-sel" aria-live="polite">
      {x != null && (
        <>
          <div className="rp-sel-dim" style={{ left: leftW + x, width: Math.max(0, plotW - x) }} />
          <div className="rp-sel-line" style={{ left: leftW + x }}>
            {picked != null && <span className="rp-sel-tag">{fmtTime(picked)}</span>}
          </div>
        </>
      )}
      <div className="rp-sel-top" role="dialog" aria-label={String(t('charts.replay.title'))}>
        <span className="rp-sel-msg">
          <Ico>{RI.cut}</Ico>
          {t(touch ? 'charts.replay.selectHintTouch' : 'charts.replay.selectHint')}
          {replay.earliest != null && <small>{t('charts.replay.available', { date: fmtTime(replay.earliest) })}</small>}
        </span>
        <span className="rp-sel-acts">
          {touchPick && picked != null && (
            <button type="button" className="rp-chip primary" onClick={() => void replay.start(picked)}>{t('charts.replay.startHere')}</button>
          )}
          <button type="button" className="rp-chip" onClick={() => setDateOpen(true)}><Ico size={14}>{RI.calendar}</Ico>{t('charts.replay.pickDate')}</button>
          <button type="button" className="rp-chip" onClick={() => void replay.startRandom()}><Ico size={14}>{RI.dice}</Ico>{t('charts.replay.random')}</button>
          <button type="button" className="rp-chip ghost" onClick={() => replay.cancelSelect()} aria-label={String(t('charts.replay.cancel'))}>
            <Ico size={14}>{RI.x}</Ico><span className="rp-chip-txt">{t('charts.replay.cancel')}</span>
          </button>
        </span>
      </div>
      {dateOpen && (
        <ReplayDateDialog timezone={timezone} earliest={replay.earliest} fmtTime={fmtTime}
          onGo={(ts) => void replay.start(ts)} onClose={() => setDateOpen(false)} />
      )}
    </div>
  )
}

// 回放起点日期（与「跳转到日期」同样按图表时区解释）/ replay start date (read in the chart timezone, like go-to-date)
export function ReplayDateDialog({ timezone, earliest, fmtTime, onGo, onClose }: {
  timezone: string
  earliest: number | null
  fmtTime: (t: number) => string
  onGo: (t: number) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const now = new Date()
  const today = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
  const [date, setDate] = useState(today)
  const [time, setTime] = useState('')
  const go = () => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    if (!m) return
    const tm = /^(\d{2}):(\d{2})$/.exec(time)
    const ts = zonedToUtc(timezone, Number(m[1]), Number(m[2]) - 1, Number(m[3]), tm ? Number(tm[1]) : 0, tm ? Number(tm[2]) : 0)
    if (!Number.isFinite(ts)) return
    onGo(Math.min(ts, Math.floor(Date.now() / 1000)))
    onClose()
  }
  return (
    <ChartDialog
      title={String(t('charts.replay.dateTitle'))}
      onClose={onClose}
      footer={<>
        <button type="button" className="ind-btn" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="ind-btn primary" onClick={go} disabled={!date}>{t('charts.replay.go')}</button>
      </>}
    >
      <form className="chart-goto" onSubmit={(e) => { e.preventDefault(); go() }}>
        <label>
          <span>{t('charts.goto.date')}</span>
          <input type="date" className="ind-in wide" value={date} max={today} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label>
          <span>{t('charts.goto.time')}</span>
          <input type="time" className="ind-in wide" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        <p className="chart-dlg-note">
          {t('charts.replay.dateNote')}
          {earliest != null && <> {t('charts.replay.available', { date: fmtTime(earliest) })}</>}
        </p>
        <button type="submit" hidden />
      </form>
    </ChartDialog>
  )
}
