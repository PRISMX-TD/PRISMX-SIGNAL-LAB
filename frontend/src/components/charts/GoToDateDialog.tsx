// 跳转到日期（Alt+G / 底栏日历按钮）：选日期 + 可选时刻，按图表当前时区解释。
// 历史不够时由 ChartsPage 往左补页（ensureHistory，最多 10 页），只在这时才多拉数据。
// Go to date (Alt+G / the bottom-bar calendar): a date plus optional time, read in the
// chart's timezone. ChartsPage pages history left if needed (ensureHistory, ≤ 10 pages) —
// the only time extra data is fetched.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ChartDialog from './ChartDialog'
import { tzOffsetSec } from './chartTime'

const p2 = (n: number) => String(n).padStart(2, '0')

// 时区墙上时间 → UTC 秒（偏移按该时刻再校一次，跨夏令时也对）。
// Zone wall time → UTC seconds (offset re-checked at the result, so DST edges work).
export function zonedToUtc(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const wall = Date.UTC(y, mo, d, h, mi) / 1000
  let t = wall - tzOffsetSec(tz, wall)
  t = wall - tzOffsetSec(tz, t)
  return t
}

export default function GoToDateDialog({ timezone, onGo, onClose }: { timezone: string; onGo: (t: number) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const now = new Date()
  const [date, setDate] = useState(`${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`)
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
      title={String(t('charts.goto.title'))}
      onClose={onClose}
      footer={<>
        <button type="button" className="ind-btn" onClick={onClose}>{t('common.cancel')}</button>
        <button type="button" className="ind-btn primary" onClick={go} disabled={!date}>{t('charts.goto.go')}</button>
      </>}
    >
      <form className="chart-goto" onSubmit={(e) => { e.preventDefault(); go() }}>
        <label>
          <span>{t('charts.goto.date')}</span>
          <input type="date" className="ind-in wide" value={date} max={`${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label>
          <span>{t('charts.goto.time')}</span>
          <input type="time" className="ind-in wide" value={time} onChange={(e) => setTime(e.target.value)} />
        </label>
        <p className="chart-dlg-note">{t('charts.goto.note')}</p>
        <button type="submit" hidden />
      </form>
    </ChartDialog>
  )
}
