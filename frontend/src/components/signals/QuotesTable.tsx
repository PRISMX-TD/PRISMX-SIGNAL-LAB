// 实时行情报价表（仪表盘左下）：品种列表跟着 EA 实际推送的走，买价 + 卖价
// Live quotes table (dashboard bottom-left): symbol list follows whatever
// the EA actually pushes, bid + ask
//
// 报价不再由父级整份传进来：每一行（和手机端单行）各自订阅自己那个品种
// （useGlobalQuote），一帧报价只重画真正跳价的格子；父级也不必因为报价每 0.5 秒重渲染。
// Quotes are no longer passed in as a whole snapshot: each row (and the mobile single row)
// subscribes to its own symbol (useGlobalQuote), so a quote frame repaints only the cells that
// actually ticked, and the parent no longer re-renders every 0.5s for quotes.
import { memo, type FC } from 'react'
import { useTranslation } from 'react-i18next'
import { useGlobalQuote } from '../../store/live'
import { useMediaQuery } from '../../utils/useMediaQuery'
import { displaySymbol } from '../../api/utils'
import { symbolMeta } from '../../utils/symbolMeta'
import { FavoriteStar, SymbolTabBar, useSymbolTabs } from './SymbolTabs'
import { EMPTY } from '../../utils/format'

interface Props {
  symbols: string[]        // 当前活跃品种（来自 useLive().activeSymbols）/ currently active symbols
  mt5Online: boolean
  focusSymbol?: string   // 手机端只显示这个品种 / mobile: show only this symbol
}

// 手机端单行：只订阅焦点品种 / mobile row: subscribes to the focus symbol only
const MobileQuoteRow: FC<{ focusSym: string | undefined; mt5Online: boolean }> = ({ focusSym, mt5Online }) => {
  const { t } = useTranslation()
  const focusQ = useGlobalQuote(focusSym)
  const focusDigits = focusQ?.digits ?? 5
  const focusBid = focusQ?.bid != null ? focusQ.bid.toFixed(focusDigits) : EMPTY
  const focusAsk = focusQ?.ask != null ? focusQ.ask.toFixed(focusDigits) : EMPTY
  // 点差取整，不带小数点 / spread rounded to an integer, no decimals
  const spread = (focusQ?.bid != null && focusQ?.ask != null)
    ? String(Math.round((focusQ.ask - focusQ.bid) * Math.pow(10, focusDigits)))
    : EMPTY
  return (
    <div className="qt-mobile-row sm:hidden">
      <div className="flex items-center gap-2">
        <b className="text-sm font-bold text-white">{focusSym ? displaySymbol(focusSym) : EMPTY}</b>
        {focusQ?.closed && <span className="tag bg-white/5 text-neutral-400 text-xs">{t('signals.focus.marketClosed')}</span>}
        <span className={`box-border inline-block w-[7px] h-[7px] rounded-full ${mt5Online ? 'bg-up animate-breathe' : 'border-[1.5px] border-neutral-400 bg-transparent'}`} aria-hidden="true" />
        <span className="sr-only">{mt5Online ? t('connStatus.online') : t('connStatus.offline')}</span>
      </div>
      <div className="flex items-center gap-5 ml-auto">
        <div className="text-center">
          <div className="text-xs text-neutral-500 mb-0.5">{t('signals.focus.bid')}</div>
          <span className="num font-bold text-sm" style={{ color: 'var(--down)' }}>{focusBid}</span>
        </div>
        <div className="text-center">
          <div className="text-xs text-neutral-500 mb-0.5">{t('signals.quotes.spread')}</div>
          <span className="num text-xs text-neutral-400">{spread}</span>
        </div>
        <div className="text-center">
          <div className="text-xs text-neutral-500 mb-0.5">{t('signals.focus.ask')}</div>
          <span className="num font-bold text-sm" style={{ color: 'var(--up)' }}>{focusAsk}</span>
        </div>
      </div>
    </div>
  )
}

// 桌面端的一行：自己订阅自己的品种，memo 保证父级重渲染时未变的行不动。
// One desktop row: subscribes to its own symbol; memo keeps unchanged rows still when the parent renders.
// fav 为 null 表示不显示星标（未登录）/ fav null = no star (logged out)
const QuoteRow = memo(function QuoteRow({ sym, focus, fav, onToggleFav }: {
  sym: string
  focus: boolean
  fav: boolean | null
  onToggleFav: (sym: string) => void
}) {
  const { t } = useTranslation()
  const { letter, color, ink } = symbolMeta(sym)
  const q = useGlobalQuote(sym)
  const digits = q?.digits ?? 5
  const bid = q?.bid != null ? q.bid.toFixed(digits) : null
  const ask = q?.ask != null ? q.ask.toFixed(digits) : null
  return (
    // 焦点品种那一行带一层微亮底，和英雄卡里正在看的品种对上。
    // The focus symbol's row is tinted to match the hero's current pick.
    <tr className={focus ? 'focus' : undefined}>
      <td>
        <div className="qt-sym-cell">
          {fav != null && <FavoriteStar on={fav} onToggle={() => onToggleFav(sym)} symbol={displaySymbol(sym)} />}
          <div className="qt-sym-ava" style={{ background: color + '33', color: ink }}>{letter}</div>
          <div className="nm">
            <b className="flex items-center gap-1.5">
              {displaySymbol(sym)}
              {q?.closed && <span className="tag bg-white/5 text-neutral-400 text-xs">{t('signals.focus.marketClosed')}</span>}
            </b>
            <span>{t(`signals.symbolNames.${sym}`, { defaultValue: '' })}</span>
          </div>
        </div>
      </td>
      <td><span className="qt-price num" style={{ color: 'var(--down)' }}>{bid ?? EMPTY}</span></td>
      <td><span className="qt-price num" style={{ color: 'var(--up)' }}>{ask ?? EMPTY}</span></td>
    </tr>
  )
})

const QuotesTable: FC<Props> = ({ symbols, mt5Online, focusSymbol }) => {
  const { t } = useTranslation()

  // 手机端单行报价：优先用焦点品种，找不到则用第一个活跃品种 / mobile: focus symbol or fallback
  const focusSym = (focusSymbol && symbols.includes(focusSymbol)) ? focusSymbol : symbols[0]
  // 分类标签 + 自选只作用于桌面表格；手机端那一行始终跟焦点品种走
  // Tabs + favorites apply to the desktop table only; the mobile row always follows the focus symbol
  const { tabs, tab, setTab, visible, favEnabled, favSet, toggleFavorite } = useSymbolTabs(symbols, 'quotesTab')
  // 手机单行和桌面整表只挂其中一个（断点同 Tailwind 的 sm = 640px）。两者以前都挂着、
  // 靠 CSS 藏起一半：手机上整张表的每一行照样订阅自己的品种、跳价就重渲染，桌面上
  // 看不见的单行也一样。下面的 sm:hidden / hidden sm:block 类名保留，作第二道保险。
  // Mount only one of the phone row and the desktop table (breakpoint = Tailwind sm, 640px).
  // Both used to be mounted with CSS hiding one: on phones every row of the invisible table
  // still subscribed to its symbol and re-rendered on ticks, and the hidden phone row did the
  // same on desktop. The sm:hidden / hidden sm:block classes stay as a second guard.
  const isSm = useMediaQuery('(min-width: 640px)')

  return (
    <section className="card glass dash-quotes p-5 sm:p-6">
      {/* 标题栏（仅桌面）：左「实时行情报价」右 MT5 状态 / title bar, desktop only */}
      <div className="hidden sm:flex items-center justify-between mb-4">
        <h3 className="text-base font-bold text-white">{t('signals.focus.quotesHeading')}</h3>
        <div className="flex items-center gap-2 text-xs">
          <span className={`inline-block w-[7px] h-[7px] rounded-full ${mt5Online ? 'bg-up animate-breathe' : 'bg-neutral-500'}`} />
          <span className={`font-semibold ${mt5Online ? 'text-up' : 'text-neutral-500'}`}>
            {mt5Online ? t('signals.focus.live') : t('signals.focus.offline')}
          </span>
        </div>
      </div>

      {/* 显隐放在外层：.sym-tabs 自带 display:flex（非 layer 样式），会盖掉 Tailwind 的 hidden，
          手机上本该藏起来的标签条曾照样露出来。
          Visibility lives on a wrapper: .sym-tabs sets display:flex as unlayered CSS, which beats
          Tailwind's `hidden`, so the tab bar used to show on phones anyway. */}
      {symbols.length > 0 && (
        <div className="hidden sm:block mb-3">
          <SymbolTabBar tabs={tabs} tab={tab} onChange={setTab} />
        </div>
      )}

      {/* ── 手机端：极简单行报价，品种代号 + 状态点 + 卖价/点差/买价（与图表交易条同序）/ mobile: minimal single-row quote, sell / spread / buy like the chart trade bar ── */}
      {!isSm && <MobileQuoteRow focusSym={focusSym} mt5Online={mt5Online} />}

      {/* ── 桌面端：完整报价表 / desktop: full table ── */}
      {isSm && (
      <div className="qt-table-wrap hidden sm:block">
        <table className="qt-table">
          <thead>
            <tr>
              <th>{t('signals.focus.symbol')}</th>
              <th>{t('signals.focus.bid')}</th>
              <th>{t('signals.focus.ask')}</th>
            </tr>
          </thead>
          <tbody>
            {symbols.length === 0 ? (
              <tr><td colSpan={3} className="text-center text-sm text-neutral-500 py-4">{t('common.loading')}</td></tr>
            ) : visible.length === 0 ? (
              <tr><td colSpan={3} className="text-center text-sm text-neutral-500 py-6">
                {tab === 'fav' ? t('signals.symbolTabs.favEmpty') : t('signals.symbolTabs.empty')}
              </td></tr>
            ) : (
              visible.map((sym) => (
                <QuoteRow
                  key={sym}
                  sym={sym}
                  focus={sym === focusSym}
                  fav={favEnabled ? favSet.has(sym) : null}
                  onToggleFav={toggleFavorite}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      )}
    </section>
  )
}

// memo：只在品种列表 / 焦点 / 在线状态变化时重渲染；报价由各行自己订阅
// memo: re-render only when the symbol list / focus / online flag changes; rows subscribe to quotes themselves
export default memo(QuotesTable)
