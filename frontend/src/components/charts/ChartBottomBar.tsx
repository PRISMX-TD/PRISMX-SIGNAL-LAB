// 图表底栏（TradingView 的底部工具条，仅桌面）：左边时间范围快捷键 + 跳转到日期，
// 右边时区、百分比 / 对数坐标与「自动缩放」。范围按钮会顺带切到合适的周期（同 TradingView：
// 1D → 1m，5D → 5m，1M → 30m…），具体动作在 ChartsPage.applyRange。
// Chart bottom bar (TradingView's, desktop only): range presets + go-to-date on the left;
// timezone, percent / log scale and auto-scale on the right. A range also switches to a
// fitting interval (as TradingView does: 1D → 1m, 5D → 5m, 1M → 30m…); the work happens in
// ChartsPage.applyRange.
import { memo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ChartPopover from './ChartPopover'
import { TIMEZONES, offsetLabel, tzCity } from './chartTime'
import type { ScaleMode } from './chartPrefs'

export type RangeKey = '1D' | '5D' | '1M' | '3M' | '6M' | 'YTD' | '1Y' | '5Y' | 'ALL'
export const RANGES: RangeKey[] = ['1D', '5D', '1M', '3M', '6M', 'YTD', '1Y', '5Y', 'ALL']

// 范围 → 周期 / range → interval
export const RANGE_INTERVAL: Record<RangeKey, string> = {
  '1D': '1', '5D': '5', '1M': '30', '3M': '60', '6M': '120', YTD: 'D', '1Y': 'D', '5Y': 'W', ALL: 'M',
}

// 范围的起点（UTC 秒）；ALL 返回 null（整段 fitContent）。
// Start of a range (UTC seconds); null for ALL (fit everything).
export function rangeFrom(key: RangeKey, now = Date.now()): number | null {
  const d = new Date(now)
  const day = 86400
  const s = Math.floor(now / 1000)
  switch (key) {
    case '1D': return s - day
    case '5D': return s - 5 * day
    case '1M': return Math.floor(new Date(d.getFullYear(), d.getMonth() - 1, d.getDate()).getTime() / 1000)
    case '3M': return Math.floor(new Date(d.getFullYear(), d.getMonth() - 3, d.getDate()).getTime() / 1000)
    case '6M': return Math.floor(new Date(d.getFullYear(), d.getMonth() - 6, d.getDate()).getTime() / 1000)
    case 'YTD': return Math.floor(new Date(d.getFullYear(), 0, 1).getTime() / 1000)
    case '1Y': return Math.floor(new Date(d.getFullYear() - 1, d.getMonth(), d.getDate()).getTime() / 1000)
    case '5Y': return Math.floor(new Date(d.getFullYear() - 5, d.getMonth(), d.getDate()).getTime() / 1000)
    default: return null
  }
}

export function tzName(tz: string, t: (k: string) => string): string {
  if (tz === 'broker') return t('charts.tz.broker')
  if (tz === 'local') return t('charts.tz.local')
  if (tz === 'UTC') return 'UTC'
  return tzCity(tz)
}

interface Props {
  timezone: string
  onTimezone: (tz: string) => void
  scaleMode: ScaleMode
  onScaleMode: (m: ScaleMode) => void
  onAutoScale: () => void
  onRange: (k: RangeKey) => void
  onGoToDate: () => void
  busy: boolean
}

function ChartBottomBar({ timezone, onTimezone, scaleMode, onScaleMode, onAutoScale, onRange, onGoToDate, busy }: Props) {
  const { t } = useTranslation()
  const tt = (k: string) => String(t(k))
  const [tzOpen, setTzOpen] = useState(false)
  const tzRef = useRef<HTMLButtonElement>(null)
  // 时钟里显示的偏移：每次渲染算一次即可（换时区 / 跨夏令时才会变）。
  // The offset shown next to the zone; computing it per render is enough.
  const off = offsetLabel(timezone)
  return (
    <div className="term-bb">
      <div className="term-bb-l">
        {RANGES.map((k) => (
          <button key={k} type="button" className="term-bb-btn" disabled={busy} onClick={() => onRange(k)} title={tt(`charts.range.${k}`)}>
            {k === 'ALL' ? tt('charts.range.all') : k}
          </button>
        ))}
        <span className="term-bb-sep" aria-hidden />
        <button type="button" className="term-bb-btn icon" onClick={onGoToDate} title={tt('charts.goto.title')} aria-label={tt('charts.goto.title')}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4M10 15h4M12.5 13l2 2-2 2" />
          </svg>
        </button>
      </div>
      <div className="term-bb-r">
        <button ref={tzRef} type="button" className={`term-bb-btn ${tzOpen ? 'on' : ''}`} onClick={() => setTzOpen((v) => !v)} aria-haspopup="dialog" aria-expanded={tzOpen} title={tt('charts.tz.title')}>
          {tzName(timezone, tt)} <small>{off}</small>
        </button>
        <ChartPopover open={tzOpen} onClose={() => setTzOpen(false)} anchorRef={tzRef} width={240} align="end" label={tt('charts.tz.title')}>
          <div className="chart-pop-body no-sb" role="listbox" aria-label={tt('charts.tz.title')}>
            {TIMEZONES.map((tz) => (
              <button
                key={tz}
                type="button"
                role="option"
                aria-selected={tz === timezone}
                className={`chart-pop-item wide ${tz === timezone ? 'on' : ''}`}
                onClick={() => { onTimezone(tz); setTzOpen(false) }}
              >
                <span>{tzName(tz, tt)}</span>
                <small>{offsetLabel(tz)}</small>
              </button>
            ))}
          </div>
        </ChartPopover>
        <span className="term-bb-sep" aria-hidden />
        <button type="button" className={`term-bb-btn ${scaleMode === 2 ? 'on' : ''}`} aria-pressed={scaleMode === 2} onClick={() => onScaleMode(scaleMode === 2 ? 0 : 2)} title={tt('charts.scale.percentHint')}>%</button>
        <button type="button" className={`term-bb-btn ${scaleMode === 1 ? 'on' : ''}`} aria-pressed={scaleMode === 1} onClick={() => onScaleMode(scaleMode === 1 ? 0 : 1)} title={tt('charts.scale.logHint')}>{tt('charts.scale.log')}</button>
        <button type="button" className="term-bb-btn" onClick={onAutoScale} title={tt('charts.scale.autoHint')}>{tt('charts.scale.auto')}</button>
      </div>
    </div>
  )
}

export default memo(ChartBottomBar)
