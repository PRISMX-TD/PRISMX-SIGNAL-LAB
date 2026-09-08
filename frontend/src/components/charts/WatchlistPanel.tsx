// 交易终端：自选品种列表（左栏 / 手机抽屉）/ Trading terminal: watchlist.
//
// 品种来自 EA 正在推送的活跃列表（useLive().activeSymbols），实时价来自全站
// 统一报价（useGlobalQuotes）。前端没有各品种的"当日开盘价"，所以这里不算
// 当日涨跌幅：价格按最近一次报价跳动方向上色（涨绿跌红），旁边一条迷你走势
// 画的是**页面打开后收到的报价序列**——真实数据，只是窗口短；没收到两笔以上
// 之前空着，不编。点击整行切换主图品种。
// Symbols come from the EA's active list; live prices from the site-wide quote
// feed. There is no per-symbol day-open on the frontend, so no day change%:
// the price is colored by its last tick direction and the sparkline plots the
// ticks received since the page opened (real data, short window; blank until
// there are at least two). Clicking a row switches the chart symbol.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Quote } from '../../api/types'
import { displaySymbol } from '../../api/utils'
import { symbolMeta } from '../../utils/symbolMeta'

interface Props {
  symbols: string[]
  quotes: Record<string, Quote>
  active: string
  onSelect: (symbol: string) => void
  digitsFor: (symbol: string) => number
  className?: string
}

type Dir = 'up' | 'down' | null
const SPARK_LEN = 40

export default function WatchlistPanel({ symbols, quotes, active, onSelect, digitsFor, className = '' }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  // 每个品种上一次的中间价（判断涨跌）与最近 40 笔中间价（画迷你走势）。
  // Per-symbol previous mid (tick direction) and the last 40 mids (sparkline).
  const prevRef = useRef<Record<string, number>>({})
  const histRef = useRef<Record<string, number[]>>({})
  const [dirs, setDirs] = useState<Record<string, Dir>>({})
  const [, setTick] = useState(0)

  useEffect(() => {
    const nextDirs: Record<string, Dir> = {}
    let changed = false
    for (const sym of symbols) {
      const q = quotes[sym]
      if (!q) continue
      const mid = (q.bid + q.ask) / 2
      const prev = prevRef.current[sym]
      if (prev != null && mid !== prev) {
        nextDirs[sym] = mid > prev ? 'up' : 'down'
        changed = true
      }
      if (prev !== mid) {
        const h = histRef.current[sym] ?? []
        h.push(mid)
        if (h.length > SPARK_LEN) h.shift()
        histRef.current[sym] = h
      }
      prevRef.current[sym] = mid
    }
    if (changed) setDirs((d) => ({ ...d, ...nextDirs }))
    setTick((n) => n + 1)
  }, [quotes, symbols])

  const filtered = query.trim()
    ? symbols.filter((s) => s.toUpperCase().includes(query.trim().toUpperCase()))
    : symbols

  return (
    <div className={`term-col-inner ${className}`}>
      <div className="term-wls">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4-4" />
        </svg>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={String(t('charts.watchlist.searchPlaceholder'))}
          aria-label={String(t('charts.watchlist.searchLabel'))}
        />
      </div>
      <div className="term-wl no-sb" role="listbox">
        {filtered.length === 0 ? (
          <div className="term-wl-empty">{symbols.length === 0 ? t('charts.watchlist.loading') : t('charts.watchlist.noMatch')}</div>
        ) : (
          filtered.map((sym) => {
            const q = quotes[sym]
            const digits = digitsFor(sym)
            const mid = q ? (q.bid + q.ask) / 2 : null
            const dir = dirs[sym]
            const meta = symbolMeta(sym)
            return (
              <button
                key={sym}
                type="button"
                role="option"
                aria-selected={sym === active}
                onClick={() => onSelect(sym)}
                className={`term-wr ${sym === active ? 'on' : ''}`}
              >
                <span className="sym-ava" style={{ background: meta.color + '33', color: meta.ink }}>{meta.letter}</span>
                <span>
                  <span className="term-wr-sym block">{sym}</span>
                  <span className="term-wr-nm block">{displaySymbol(sym)}</span>
                </span>
                <Spark points={histRef.current[sym] ?? []} dir={dir} />
                <span className={`term-wr-px ${dir ?? ''}`}>{mid == null ? '—' : mid.toFixed(digits)}</span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

function Spark({ points, dir }: { points: number[]; dir: Dir }) {
  if (points.length < 2) return <span className="term-wr-spark" aria-hidden />
  const w = 52
  const h = 20
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const pts = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w
    const y = h - 2 - ((p - min) / span) * (h - 4)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const last = pts[pts.length - 1].split(',')
  const color = dir === 'down' ? 'var(--down)' : dir === 'up' ? 'var(--up)' : 'var(--text-3)'
  return (
    <svg className="term-wr-spark" viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth="1.25" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r="1.6" fill={color} />
    </svg>
  )
}
