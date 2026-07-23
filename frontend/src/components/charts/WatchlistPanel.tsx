// 交易终端：自选品种列表（左栏）/ Trading terminal: watchlist panel (left column).
//
// 品种来自 EA 正在推送的活跃列表（useLive().activeSymbols），实时价来自全站
// 统一报价（useGlobalQuotes）。前端没有各品种的"当日开盘价"，所以这里不算
// 当日涨跌幅，而是按最近一次报价跳动方向给价格上色（涨绿跌红），既有实时感
// 又不需要新后端。点击整行切换主图品种。
// Symbols come from the EA's active list (useLive().activeSymbols); live prices
// from the site-wide quote feed (useGlobalQuotes). The frontend has no per-symbol
// day-open, so instead of a day change% this colors the price by the direction of
// its last tick (green up / red down) — a live feel with no new backend. Clicking
// a row switches the main chart symbol.
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

export default function WatchlistPanel({ symbols, quotes, active, onSelect, digitsFor, className = '' }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  // 记录每个品种上一次的中间价，用来判断本次报价是涨还是跌（决定上色）。
  // Track each symbol's previous mid price to color the current tick up/down.
  const prevRef = useRef<Record<string, number>>({})
  const [dirs, setDirs] = useState<Record<string, Dir>>({})

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
      prevRef.current[sym] = mid
    }
    if (changed) setDirs((d) => ({ ...d, ...nextDirs }))
  }, [quotes, symbols])

  const filtered = query.trim()
    ? symbols.filter((s) => s.toUpperCase().includes(query.trim().toUpperCase()))
    : symbols

  return (
    <div className={`term-panel term-watchlist ${className}`}>
      <div className="term-pane-head">
        {t('charts.watchlist.title')} <span className="term-pane-head-r">{symbols.length}</span>
      </div>
      <div className="term-wl-search">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
      <div className="term-wl no-sb">
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
                onClick={() => onSelect(sym)}
                className={`term-wl-row ${sym === active ? 'on' : ''}`}
              >
                <span className="term-wl-badge" style={{ color: meta.color, borderColor: meta.color + '55' }}>
                  {meta.letter}
                </span>
                <span className="term-wl-id">
                  <span className="term-wl-sym">{sym}</span>
                  <span className="term-wl-nm">{displaySymbol(sym)}</span>
                </span>
                <span className={`term-wl-px num ${dir === 'up' ? 'up' : dir === 'down' ? 'down' : ''}`}>
                  {mid == null ? '—' : mid.toFixed(digits)}
                </span>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
