// 图表类型菜单：17 种主图样式，按 TradingView 的分组排列；按钮本身画当前类型的小图标。
// 价格类图表（砖形、新价线、卡吉、点数图）在名字后标一个小记号，提示横轴不是时间。
// Chart-type menu: 17 main-series styles grouped as in TradingView; the button shows the
// current type's icon. Price-based types (Renko, Line Break, Kagi, P&F) get a small badge:
// their x axis isn't time.
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ChartPopover from './ChartPopover'
import { CHART_TYPE_GROUPS, PRICE_BASED_TYPES, type ChartType } from './chartPrefs'

const ICONS: Record<ChartType, JSX.Element> = {
  bars: <path d="M6 5v13M3.5 8H6M6 15h2.5M14 4v15M11.5 7H14M14 16h2.5M20 8v9M18 10h2M20 14h2" />,
  candles: <><path d="M7 3v4M7 17v4M17 6v3M17 16v3" /><rect x="5" y="7" width="4" height="10" rx="0.5" fill="currentColor" /><rect x="15" y="9" width="4" height="7" rx="0.5" /></>,
  hollow: <><path d="M7 3v4M7 17v4M17 6v3M17 16v3" /><rect x="5" y="7" width="4" height="10" rx="0.5" /><rect x="15" y="9" width="4" height="7" rx="0.5" /></>,
  volumeCandles: <><path d="M6 4v3M6 15v4M15 6v3M15 14v4" /><rect x="3.5" y="7" width="5" height="8" rx="0.5" fill="currentColor" /><rect x="13" y="9" width="4" height="5" rx="0.5" /></>,
  line: <path d="M3 17l5-6 4 3 4-7 5 5" />,
  lineMarkers: <><path d="M3 17l5-6 4 3 4-7 5 5" /><circle cx="8" cy="11" r="1.6" fill="currentColor" /><circle cx="12" cy="14" r="1.6" fill="currentColor" /><circle cx="16" cy="7" r="1.6" fill="currentColor" /></>,
  step: <path d="M3 17h4v-6h5v3h4V7h5" />,
  area: <><path d="M3 17l5-6 4 3 4-7 5 5" /><path d="M3 17l5-6 4 3 4-7 5 5V21H3z" fill="currentColor" opacity="0.25" stroke="none" /></>,
  hlcArea: <><path d="M3 9l5-3 4 2 4-4 5 3M3 18l5-3 4 2 4-4 5 3" /><path d="M3 13l5-3 4 2 4-4 5 3" strokeDasharray="2 2" /></>,
  baseline: <><path d="M3 12h18" strokeDasharray="2 2" /><path d="M3 15l4-6 4 2 3 5 4-9 3 4" /></>,
  columns: <path d="M5 20v-7M9.5 20v-11M14 20v-5M18.5 20V6" strokeWidth="3" />,
  highLow: <><path d="M6 5v13M12 8v9M18 4v12" strokeWidth="3" /></>,
  heikinAshi: <><path d="M7 3v4M7 17v4M17 6v3M17 16v3" /><rect x="5" y="7" width="4" height="10" rx="2" fill="currentColor" /><rect x="15" y="9" width="4" height="7" rx="2" /></>,
  renko: <><rect x="3" y="14" width="5" height="5" fill="currentColor" /><rect x="9.5" y="9" width="5" height="5" fill="currentColor" /><rect x="16" y="9" width="5" height="5" /></>,
  lineBreak: <><rect x="3" y="12" width="5" height="7" fill="currentColor" /><rect x="9.5" y="6" width="5" height="6" fill="currentColor" /><rect x="16" y="8" width="5" height="9" /></>,
  kagi: <path d="M5 19V8h6v8h6V4" />,
  pnf: <><path d="M4 5l4 4M8 5L4 9M4 11l4 4M8 11l-4 4" /><circle cx="16" cy="7" r="2" /><circle cx="16" cy="13" r="2" /></>,
}

export function ChartTypeIcon({ type, size = 16 }: { type: ChartType; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[type]}
    </svg>
  )
}

export default function ChartTypeMenu({ value, onChange }: { value: ChartType; onChange: (t: ChartType) => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const label = String(t('charts.type.title'))
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`term-tool-btn ${open ? 'on' : ''}`}
        title={`${label}: ${t(`charts.type.${value}`)}`}
        aria-label={`${label}: ${t(`charts.type.${value}`)}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        <ChartTypeIcon type={value} />
      </button>
      <ChartPopover open={open} onClose={() => setOpen(false)} anchorRef={btnRef} width={232} label={label}>
        <div className="chart-pop-body no-sb" role="listbox" aria-label={label}>
          {CHART_TYPE_GROUPS.map((g, i) => (
            <div key={i} className="chart-type-grp">
              {g.map((type) => (
                <button
                  key={type}
                  type="button"
                  role="option"
                  aria-selected={value === type}
                  className={`chart-pop-item wide ${value === type ? 'on' : ''}`}
                  onClick={() => { onChange(type); setOpen(false) }}
                >
                  <ChartTypeIcon type={type} />
                  <span>{t(`charts.type.${type}`)}</span>
                  {PRICE_BASED_TYPES.has(type) && <em title={String(t('charts.type.priceBasedHint'))}>{t('charts.type.priceBased')}</em>}
                </button>
              ))}
            </div>
          ))}
        </div>
      </ChartPopover>
    </>
  )
}
