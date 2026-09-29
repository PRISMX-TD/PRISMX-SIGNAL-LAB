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
import { displaySymbol } from '../../api/utils'
import { symbolMeta } from '../../utils/symbolMeta'

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
  const focusBid = focusQ?.bid != null ? focusQ.bid.toFixed(focusDigits) : '-'
  const focusAsk = focusQ?.ask != null ? focusQ.ask.toFixed(focusDigits) : '-'
  // 点差取整，不带小数点 / spread rounded to an integer, no decimals
  const spread = (focusQ?.bid != null && focusQ?.ask != null)
    ? String(Math.round((focusQ.ask - focusQ.bid) * Math.pow(10, focusDigits)))
    : '-'
  return (
    <div className="qt-mobile-row sm:hidden">
      <div className="flex items-center gap-2">
        <b className="text-sm font-bold text-white">{focusSym ? displaySymbol(focusSym) : '-'}</b>
        {focusQ?.closed && <span className="tag bg-white/5 text-neutral-400 text-[10px]">{t('signals.focus.marketClosed')}</span>}
        <span className={`inline-block w-[7px] h-[7px] rounded-full ${mt5Online ? 'bg-up animate-breathe' : 'bg-neutral-500'}`} />
      </div>
      <div className="flex items-center gap-5 ml-auto">
        <div className="text-center">
          <div className="text-[10px] text-neutral-500 mb-0.5">{t('signals.quotes.bid')}</div>
          <span className="num font-bold text-sm" style={{ color: 'var(--up)' }}>{focusAsk}</span>
        </div>
        <div className="text-center">
          <div className="text-[10px] text-neutral-500 mb-0.5">{t('signals.quotes.spread')}</div>
          <span className="num text-xs text-neutral-400">{spread}</span>
        </div>
        <div className="text-center">
          <div className="text-[10px] text-neutral-500 mb-0.5">{t('signals.quotes.ask')}</div>
          <span className="num font-bold text-sm" style={{ color: 'var(--down)' }}>{focusBid}</span>
        </div>
      </div>
    </div>
  )
}

// 桌面端的一行：自己订阅自己的品种，memo 保证父级重渲染时未变的行不动。
// One desktop row: subscribes to its own symbol; memo keeps unchanged rows still when the parent renders.
const QuoteRow = memo(function QuoteRow({ sym, focus }: { sym: string; focus: boolean }) {
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
          <div className="qt-sym-ava" style={{ background: color + '33', color: ink }}>{letter}</div>
          <div className="nm">
            <b className="flex items-center gap-1.5">
              {displaySymbol(sym)}
              {q?.closed && <span className="tag bg-white/5 text-neutral-400 text-[10px]">{t('signals.focus.marketClosed')}</span>}
            </b>
            <span>{t(`signals.symbolNames.${sym}`, { defaultValue: '' })}</span>
          </div>
        </div>
      </td>
      <td><span className="qt-price num" style={{ color: 'var(--down)' }}>{bid ?? '-'}</span></td>
      <td><span className="qt-price num" style={{ color: 'var(--up)' }}>{ask ?? '-'}</span></td>
    </tr>
  )
})

const QuotesTable: FC<Props> = ({ symbols, mt5Online, focusSymbol }) => {
  const { t } = useTranslation()

  // 手机端单行报价：优先用焦点品种，找不到则用第一个活跃品种 / mobile: focus symbol or fallback
  const focusSym = (focusSymbol && symbols.includes(focusSymbol)) ? focusSymbol : symbols[0]

  return (
    <section className="card glass dash-quotes p-4 sm:p-6">
      {/* 标题栏（仅桌面）：左「实时行情报价」右 MT5 状态 / title bar, desktop only */}
      <div className="hidden sm:flex items-center justify-between mb-4">
        <h3 className="text-[15px] font-bold text-white">{t('signals.focus.quotesHeading')}</h3>
        <div className="flex items-center gap-2 text-xs">
          <span className={`inline-block w-[7px] h-[7px] rounded-full ${mt5Online ? 'bg-up animate-breathe' : 'bg-neutral-500'}`} />
          <span className={`font-semibold ${mt5Online ? 'text-up' : 'text-neutral-500'}`}>
            {mt5Online ? t('signals.focus.live') : t('signals.focus.offline')}
          </span>
        </div>
      </div>

      {/* ── 手机端：极简单行报价，品种代号 + 状态点 + 买价/点差/卖价 / mobile: minimal single-row quote ── */}
      <MobileQuoteRow focusSym={focusSym} mt5Online={mt5Online} />

      {/* ── 桌面端：完整报价表 / desktop: full table ── */}
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
            ) : (
              symbols.map((sym) => <QuoteRow key={sym} sym={sym} focus={sym === focusSym} />)
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// memo：只在品种列表 / 焦点 / 在线状态变化时重渲染；报价由各行自己订阅
// memo: re-render only when the symbol list / focus / online flag changes; rows subscribe to quotes themselves
export default memo(QuotesTable)
