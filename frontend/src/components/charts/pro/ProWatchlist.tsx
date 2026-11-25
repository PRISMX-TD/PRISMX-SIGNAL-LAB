// 专业版终端的自选表（TradingView 式的行情表，取代经典版的卡片列表）：
//   分类胶囊（全部 / 自选 / 外汇 / 商品…，可切到筛选框）· 列头（商品 · 趋势 · 最新价）·
//   「全部」下按分类分组，组头可折叠并显示数量 · 每行：圆形头像 + 代码、五格多周期趋势
//   （M5 / M15 / M30 / H1 / H4，信号页同一份 trends 数据）、跳价闪色的价格、星标。
// 键盘：焦点在列表里时 ↑ / ↓ 直接切换主图品种（TradingView 要点鼠标）。
// 跳价与经典版一样走跳价簿（watchTicks）：每行只订阅自己的品种，面板本身不随报价重渲染。
// The pro terminal's watchlist (a TradingView-style quote table replacing the classic card
// list): category chips (all / favourites / forex / commodities…, swappable for a filter
// field) · column header (symbol · trend · last) · under "all", rows grouped by category with
// collapsible group headers and counts · each row: round avatar + ticker, five trend cells
// (M5 / M15 / M30 / H1 / H4, the same trends feed as the signals page), a price that flashes
// on ticks, and a star. Keyboard: with focus in the list, ↑ / ↓ switch the chart symbol.
// Ticks go through the same tick book as the classic list (watchTicks): each row subscribes
// to its own symbol only, the panel never re-renders for a quote.
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { Trend } from '../../../api/types'
import { useGlobalQuotesPeek, useGlobalQuotesSubscribe, useLive } from '../../../store/live'
import { displaySymbol } from '../../../api/utils'
import { symbolMeta } from '../../../utils/symbolMeta'
import { SYMBOL_CATEGORIES, symbolCategory, type SymbolCategory } from '../../../utils/symbolCategory'
import { EMPTY } from '../../../utils/format'
import { FavoriteStar, useSymbolTabs } from '../../signals/SymbolTabs'
import { createWatchTicks, type WatchTicks } from '../watchTicks'
import { IcChevron, IcClose, IcSearch, IcWifiOff } from './icons'

interface Props {
  symbols: string[]
  active: string
  onSelect: (symbol: string) => void
  digitsFor: (symbol: string) => number
  quotesDown?: boolean
}

// M1 只是参考箭头、不计入综合判断（见 SignalView），表里不占格
// M1 is a reference arrow only and never weighs in (see SignalView), so it gets no cell
const TFS = ['M5', 'M15', 'M30', 'H1', 'H4'] as const
const GROUP_ORDER: SymbolCategory[] = [...SYMBOL_CATEGORIES, 'other']

export default function ProWatchlist({ symbols, active, onSelect, digitsFor, quotesDown = false }: Props) {
  const { t } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const { trends } = useLive()
  const peekQuotes = useGlobalQuotesPeek()
  const subscribeQuotes = useGlobalQuotesSubscribe()
  const [ticks] = useState(() => {
    const book = createWatchTicks()
    book.ingest(peekQuotes())
    return book
  })
  useEffect(() => {
    ticks.ingest(peekQuotes())
    return subscribeQuotes(() => ticks.ingest(peekQuotes()))
  }, [ticks, peekQuotes, subscribeQuotes])

  const { tabs, tab, setTab, visible, favEnabled, favSet, toggleFavorite } = useSymbolTabs(symbols, 'proWatchTab')
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [shut, setShut] = useState<ReadonlySet<SymbolCategory>>(() => new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const q = query.trim().toUpperCase()
  const rows = q ? symbols.filter((s) => s.toUpperCase().includes(q) || displaySymbol(s).toUpperCase().includes(q)) : visible
  // 只有「全部」且不在筛选时分组；分类标签本身就是一组，不用再套组头
  // Group only under "all" without a filter; a category tab already is one group
  const grouped = !q && tab === 'all'
  const groups = useMemo(() => {
    if (!grouped) return null
    const by = new Map<SymbolCategory, string[]>()
    for (const s of rows) {
      const c = symbolCategory(s)
      const arr = by.get(c)
      if (arr) arr.push(s)
      else by.set(c, [s])
    }
    return GROUP_ORDER.filter((c) => by.has(c)).map((c) => ({ cat: c, syms: by.get(c)! }))
  }, [grouped, rows])
  // 键盘上下键按屏幕顺序走，折叠组里的跳过 / arrow keys follow screen order, skipping folded groups
  const order = useMemo(() => (groups ? groups.flatMap((g) => (shut.has(g.cat) ? [] : g.syms)) : rows), [groups, rows, shut])

  const closeSearch = () => { setSearching(false); setQuery('') }
  const toggleGroup = (c: SymbolCategory) => setShut((prev) => {
    const next = new Set(prev)
    if (next.has(c)) next.delete(c)
    else next.add(c)
    return next
  })

  // 切品种后把当前行滚进视野（命令面板、图表快捷键切的也算）
  // Keep the active row in view after a switch (from the palette or chart shortcuts too)
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-sym="${CSS.escape(active)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    if (order.length === 0) return
    e.preventDefault()
    const i = order.indexOf(active)
    const next = order[i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length]
    onSelect(next)
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-sym="${CSS.escape(next)}"] .pt-wr-pick`)?.focus())
  }

  const emptyText = symbols.length === 0
    ? tt('charts.watchlist.loading')
    : q ? tt('charts.watchlist.noMatch') : tab === 'fav' ? tt('signals.symbolTabs.favEmpty') : tt('signals.symbolTabs.empty')

  const row = (sym: string) => (
    <WatchRow
      key={sym}
      sym={sym}
      ticks={ticks}
      trend={trends[sym]}
      digits={digitsFor(sym)}
      active={sym === active}
      favEnabled={favEnabled}
      fav={favSet.has(sym)}
      onSelect={onSelect}
      onToggleFav={toggleFavorite}
    />
  )

  return (
    <div className={`pt-wl ${quotesDown ? 'down' : ''}`}>
      <div className="pt-wl-top">
        {searching ? (
          <label className="pt-wl-search">
            <IcSearch size={14} />
            <input
              ref={inputRef}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch() }
                else if (e.key === 'Enter' && rows[0]) { onSelect(rows[0]); closeSearch() }
              }}
              placeholder={tt('charts.watchlist.searchPlaceholder')}
              aria-label={tt('charts.watchlist.searchLabel')}
              spellCheck={false}
              autoComplete="off"
            />
            <button type="button" className="pt-wl-x" onClick={closeSearch} aria-label={tt('charts.pro.cmd.close')}><IcClose size={13} /></button>
          </label>
        ) : (
          <>
            <div className="pt-chips no-sb" role="tablist">
              {tabs.map((k) => (
                <button key={k} type="button" role="tab" aria-selected={k === tab} className={k === tab ? 'on' : undefined} onClick={() => setTab(k)}>
                  {tt(`signals.symbolTabs.${k}`)}
                </button>
              ))}
            </div>
            <button type="button" className="pt-icon sm" onClick={() => setSearching(true)} title={tt('charts.watchlist.searchLabel')} aria-label={tt('charts.watchlist.searchLabel')}>
              <IcSearch size={14} />
            </button>
          </>
        )}
      </div>
      <div className="pt-wl-cols" aria-hidden>
        <span>{tt('charts.pro.wl.symbol')}</span>
        <span className="c-tr" title={TFS.join(' · ')}>{tt('charts.pro.wl.trend')}</span>
        <span className="c-px">{tt('charts.pro.wl.last')}</span>
        <span />
      </div>
      {quotesDown && <p className="pt-wl-down"><IcWifiOff size={13} />{tt('charts.quotesDown')}</p>}
      <ul ref={listRef} className="pt-wl-list" aria-label={tt('charts.pro.w.watch')} onKeyDown={onListKey}>
        {rows.length === 0 ? (
          <li className="pt-wl-empty">{emptyText}</li>
        ) : groups ? (
          groups.map((g) => {
            const open = !shut.has(g.cat)
            return (
              <li key={g.cat} className="pt-wl-grp">
                <button type="button" className="pt-wl-gh" aria-expanded={open} onClick={() => toggleGroup(g.cat)}>
                  <IcChevron size={11} className={open ? 'open' : ''} />
                  <span>{g.cat === 'other' ? tt('charts.pro.wl.other') : tt(`signals.symbolTabs.${g.cat}`)}</span>
                  <b>{g.syms.length}</b>
                </button>
                {open && <ul>{g.syms.map(row)}</ul>}
              </li>
            )
          })
        ) : (
          rows.map(row)
        )}
      </ul>
    </div>
  )
}

const WatchRow = memo(function WatchRow({ sym, ticks, trend, digits, active, favEnabled, fav, onSelect, onToggleFav }: {
  sym: string
  ticks: WatchTicks
  trend: Trend | undefined
  digits: number
  active: boolean
  favEnabled: boolean
  fav: boolean
  onSelect: (symbol: string) => void
  onToggleFav: (symbol: string) => void
}) {
  const { t } = useTranslation()
  const subscribe = useCallback((cb: () => void) => ticks.subscribe(sym, cb), [ticks, sym])
  const get = useCallback(() => ticks.get(sym), [ticks, sym])
  const { bid, dir } = useSyncExternalStore(subscribe, get, get)
  const meta = symbolMeta(sym)
  const name = String(t(`signals.symbolNames.${sym}`, { defaultValue: displaySymbol(sym) }))
  const tfs = trend?.timeframes
  const trendTip = tfs ? TFS.map((tf) => `${tf} ${tfs[tf] === 'UP' ? '↑' : tfs[tf] === 'DOWN' ? '↓' : '–'}`).join('  ') : undefined
  return (
    <li className={`pt-wr ${active ? 'on' : ''}`} data-sym={sym}>
      <span className="pt-wr-id">
        <span className="pt-wr-ava" style={{ background: meta.color + '38', color: meta.ink }} aria-hidden>{meta.letter.slice(0, 1)}</span>
        <button type="button" className="pt-wr-pick" aria-current={active ? 'true' : undefined} onClick={() => onSelect(sym)} title={name !== sym ? name : undefined}>
          {sym}
        </button>
      </span>
      <span className="pt-wr-tr" title={trendTip} aria-label={trendTip}>
        {TFS.map((tf) => {
          const d = tfs?.[tf]
          return <i key={tf} className={d === 'UP' ? 'up' : d === 'DOWN' ? 'dn' : ''} />
        })}
      </span>
      <span className={`pt-wr-px ${dir ?? ''}`}>{bid == null ? EMPTY : bid.toFixed(digits)}</span>
      <span className="pt-wr-fav">{favEnabled && <FavoriteStar on={fav} onToggle={() => onToggleFav(sym)} symbol={sym} />}</span>
    </li>
  )
})
