// 交易终端：自选品种列表（左栏 / 手机抽屉）/ Trading terminal: watchlist.
//
// 品种来自 EA 正在推送的活跃列表（useLive().activeSymbols），实时价来自全站
// 统一报价。前端没有各品种的"当日开盘价"，所以这里不算
// 当日涨跌幅：价格按最近一次报价跳动方向上色（涨绿跌红），旁边一条迷你走势
// 画的是**页面打开后收到的报价序列**——真实数据，只是窗口短；没收到两笔以上
// 之前空着，不编。点击整行切换主图品种。
// Symbols come from the EA's active list; live prices from the site-wide quote
// feed. There is no per-symbol day-open on the frontend, so no day change%:
// the price is colored by its last tick direction and the sparkline plots the
// ticks received since the page opened (real data, short window; blank until
// there are at least two). Clicking a row switches the chart symbol.
//
// 渲染范围（2026-11-15）：面板本身不随报价重渲染。跳价簿（watchTicks.ts）跟着全站
// 报价 store 走，每一行（WatchRow）只订阅自己那个品种在簿里的那一格：一帧报价只
// 重渲染真正跳了价（或颜色该褪回）的那几行，迷你走势也只在自己的点变了才重算。
// 以前面板读整张报价表（Context），每一帧都把整张表连同每条走势的 min/max 重算一遍。
// Render scope (2026-11-15): the panel itself never re-renders for quotes. A tick book
// (watchTicks.ts) follows the site-wide quote store and each row (WatchRow) subscribes to
// its own symbol's cell, so a quote frame re-renders only the rows that ticked (or whose
// colour fades back) and a sparkline recomputes only when its own points change. The panel
// used to read the whole quote map (a context) and redo every row and sparkline per frame.
import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { useGlobalQuotesPeek, useGlobalQuotesSubscribe } from '../../store/live'
import { displaySymbol } from '../../api/utils'
import { symbolMeta } from '../../utils/symbolMeta'
import { FavoriteStar, SymbolTabBar, useSymbolTabs } from '../signals/SymbolTabs'
import { createWatchTicks, type Dir, type WatchTicks } from './watchTicks'
import { EMPTY } from '../../utils/format'

interface Props {
  symbols: string[]
  active: string
  onSelect: (symbol: string) => void
  digitsFor: (symbol: string) => number
  className?: string
  // WebSocket 断线：价格停在最后一跳，变灰并在列表上方说明。/ WebSocket lost: prices freeze; grey them and say so.
  quotesDown?: boolean
}

const SPARK_W = 52
const SPARK_H = 20

export default function WatchlistPanel({ symbols, active, onSelect, digitsFor, quotesDown = false, className = '' }: Props) {
  const { t } = useTranslation()
  // 跳价簿：挂载时先吃一次当前报价，之后全站报价 store 每更新一次就喂一次。簿只通知
  // 真正变了的那几个品种的行，面板本身不会因为跳价重渲染。
  // The tick book: seeded with the current quotes on mount, then fed on every quote-store
  // update. It notifies only the rows whose symbol changed; the panel never re-renders for a tick.
  const peekQuotes = useGlobalQuotesPeek()
  const subscribeQuotes = useGlobalQuotesSubscribe()
  const [ticks] = useState(() => {
    const book = createWatchTicks()
    book.ingest(peekQuotes())
    return book
  })
  useEffect(() => {
    // 渲染与订阅之间可能已经来过一帧，先补喂一次（同一张表重复喂入不会有任何变化）。
    // A frame may have arrived between render and subscribe; feed once more (re-feeding the same map is a no-op).
    ticks.ingest(peekQuotes())
    return subscribeQuotes(() => ticks.ingest(peekQuotes()))
  }, [ticks, peekQuotes, subscribeQuotes])
  const [query, setQuery] = useState('')
  // 分类标签 + 自选（见 SymbolTabs）；搜索时不看标签，在全部品种里找。
  // Category tabs + favorites (see SymbolTabs); a search ignores the tab and looks through all symbols.
  const { tabs, tab, setTab, visible, favEnabled, favSet, toggleFavorite } = useSymbolTabs(symbols, 'watchlistTab')

  const filtered = query.trim()
    ? symbols.filter((s) => s.toUpperCase().includes(query.trim().toUpperCase()))
    : visible
  const emptyText = symbols.length === 0
    ? t('charts.watchlist.loading')
    : query.trim()
      ? t('charts.watchlist.noMatch')
      : tab === 'fav' ? t('signals.symbolTabs.favEmpty') : t('signals.symbolTabs.empty')

  return (
    <div className={`term-col-inner ${quotesDown ? 'quotes-down' : ''} ${className}`}>
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
      {symbols.length > 0 && !query.trim() && <SymbolTabBar tabs={tabs} tab={tab} onChange={setTab} className="term-wl-tabs" />}
      {quotesDown && <p className="term-wl-down">{t('charts.quotesDown')}</p>}
      <ul className="term-wl no-sb" aria-label={String(t('charts.watchlist.title'))}>
        {filtered.length === 0 ? (
          <li className="term-wl-empty">{emptyText}</li>
        ) : (
          filtered.map((sym) => (
            <WatchRow
              key={sym}
              sym={sym}
              ticks={ticks}
              digits={digitsFor(sym)}
              active={sym === active}
              favEnabled={favEnabled}
              fav={favSet.has(sym)}
              onSelect={onSelect}
              onToggleFav={toggleFavorite}
            />
          ))
        )}
      </ul>
    </div>
  )
}

// 一行自选：只订阅自己那个品种在跳价簿里的那一格（价、方向、走势点）；memo 让父级
// 重渲染（切品种、改自选、精度变化）时没变的行不动。onSelect / onToggleFav 在调用方
// 都是稳定引用（useState 的 setter、useCallback），memo 才成立。
// 每行是普通列表项：选品种是品种代码上的真按钮，它的 ::after 铺满整行
// （terminal.css 的 .term-wr-pick），星标是旁边独立的按钮。以前整行是
// option 角色，option 的子元素对读屏是展示性的，星标按钮等于不存在。
// One watchlist row: subscribes only to its own symbol's cell in the tick book (price,
// direction, sparkline points); memo keeps unchanged rows still when the parent renders
// (symbol switch, favourites, precision). onSelect / onToggleFav are stable at the call
// sites (a useState setter, a useCallback), which is what makes memo hold.
// Each row is a plain list item: picking the symbol is a real button on the symbol
// code whose ::after covers the row (.term-wr-pick in terminal.css), and the star is a
// separate button beside it. The row used to have the option role, whose children are
// presentational to screen readers, so the star button effectively did not exist.
const WatchRow = memo(function WatchRow({ sym, ticks, digits, active, favEnabled, fav, onSelect, onToggleFav }: {
  sym: string
  ticks: WatchTicks
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
  const { bid, dir, hist } = useSyncExternalStore(subscribe, get, get)
  const meta = symbolMeta(sym)
  return (
    <li className={`term-wr ${favEnabled ? 'has-fav' : ''} ${active ? 'on' : ''}`}>
      <span className="sym-ava" style={{ background: meta.color + '33', color: meta.ink }} aria-hidden="true">{meta.letter}</span>
      <span>
        <button
          type="button"
          className="term-wr-pick term-wr-sym block"
          aria-current={active ? 'true' : undefined}
          onClick={() => onSelect(sym)}
        >
          {sym}
        </button>
        <span className="term-wr-nm block">{t(`signals.symbolNames.${sym}`, { defaultValue: displaySymbol(sym) })}</span>
      </span>
      <Spark points={hist} dir={dir} />
      <span className={`term-wr-px ${dir ?? ''}`}>{bid == null ? EMPTY : bid.toFixed(digits)}</span>
      {favEnabled && <FavoriteStar on={fav} onToggle={() => onToggleFav(sym)} symbol={sym} />}
    </li>
  )
})

// 迷你走势：几何只跟 points 走（跳价簿只在这个品种跳价时换新数组），颜色褪回
// （dir → null）时不重算 min/max 与折线。
// Sparkline: geometry depends on points only (the tick book swaps the array only when this
// symbol ticks), so fading the colour (dir → null) doesn't recompute min/max or the polyline.
const Spark = memo(function Spark({ points, dir }: { points: number[]; dir: Dir }) {
  const geo = useMemo(() => {
    if (points.length < 2) return null
    const min = Math.min(...points)
    const max = Math.max(...points)
    const span = max - min || 1
    const pts = points.map((p, i) => {
      const x = (i / (points.length - 1)) * SPARK_W
      const y = SPARK_H - 2 - ((p - min) / span) * (SPARK_H - 4)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    const last = pts[pts.length - 1].split(',')
    return { line: pts.join(' '), cx: last[0], cy: last[1] }
  }, [points])
  if (!geo) return <span className="term-wr-spark" aria-hidden />
  const color = dir === 'down' ? 'var(--down)' : dir === 'up' ? 'var(--up)' : 'var(--text-3)'
  return (
    <svg className="term-wr-spark" viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} aria-hidden>
      <polyline points={geo.line} fill="none" stroke={color} strokeWidth="1.25" strokeLinejoin="round" />
      <circle cx={geo.cx} cy={geo.cy} r="1.6" fill={color} />
    </svg>
  )
})
