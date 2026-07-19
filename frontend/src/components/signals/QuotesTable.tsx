// 实时行情报价表（仪表盘左下）：品种列表跟着 EA 实际推送的走，买价 + 卖价
// Live quotes table (dashboard bottom-left): symbol list follows whatever
// the EA actually pushes, bid + ask
import { memo, type FC } from 'react'
import { useTranslation } from 'react-i18next'
import type { Quote } from '../../api/types'
import { displaySymbol } from '../../api/utils'

interface Props {
  symbols: string[]        // 当前活跃品种（来自 useLive().activeSymbols）/ currently active symbols
  quotes: Record<string, Quote>
  mt5Online: boolean
  focusSymbol?: string   // 手机端只显示这个品种 / mobile: show only this symbol
}

// 已知品种的展示元数据（字母 + 配色）；活跃列表里出现未在此列出的新品种时，
// 用品种名首字母 + 统一灰色兜底，不需要为了新品种改这份表才能显示。
// 品种名走 i18n（signals.symbolNames）。
// Known display metadata (letter + color) for a handful of symbols; a symbol
// appearing in the active list but not listed here falls back to its own
// first letter + a neutral color, so a brand-new symbol shows up without
// needing a code change here. Names come from i18n (signals.symbolNames).
const SYMBOL_META: Record<string, { letter: string; color: string }> = {
  XAUUSD: { letter: 'X', color: '#f6c453' },
  XAGUSD: { letter: 'X', color: '#94a3b8' },
  WTI: { letter: 'W', color: '#d97757' },
  EURUSD: { letter: 'E', color: '#6366f1' },
  GBPUSD: { letter: 'G', color: '#a855f7' },
  USDJPY: { letter: 'U', color: '#7c3aed' },
  BTCUSD: { letter: 'B', color: '#f59e0b' },
}
const DEFAULT_META = { color: '#64748b' }
function symbolMeta(sym: string): { letter: string; color: string } {
  return SYMBOL_META[sym] ?? { letter: sym.charAt(0).toUpperCase() || '?', color: DEFAULT_META.color }
}

const QuotesTable: FC<Props> = ({ symbols, quotes, mt5Online, focusSymbol }) => {
  const { t } = useTranslation()

  // 手机端单行报价：优先用焦点品种，找不到则用第一个活跃品种 / mobile: focus symbol or fallback
  const focusSym = (focusSymbol && symbols.includes(focusSymbol)) ? focusSymbol : symbols[0]
  const focusMeta = focusSym ? { sym: focusSym, ...symbolMeta(focusSym) } : null
  const focusQ = focusMeta ? quotes[focusMeta.sym] : undefined
  const focusDigits = focusQ?.digits ?? 5
  const focusBid = focusQ?.bid != null ? focusQ.bid.toFixed(focusDigits) : '-'
  const focusAsk = focusQ?.ask != null ? focusQ.ask.toFixed(focusDigits) : '-'
  // 点差取整，不带小数点 / spread rounded to an integer, no decimals
  const spread = (focusQ?.bid != null && focusQ?.ask != null)
    ? String(Math.round((focusQ.ask - focusQ.bid) * Math.pow(10, focusDigits)))
    : '-'

  return (
    <section className="card glass dash-quotes p-4 sm:p-5">
      {/* 标题栏（仅桌面）：左「实时行情报价」右 MT5 状态 / title bar, desktop only */}
      <div className="hidden sm:flex items-center justify-between mb-3">
        <h3 className="text-[15px] font-bold text-white">{t('signals.focus.quotesHeading', '实时行情报价')}</h3>
        <div className="flex items-center gap-2 text-xs">
          <span className={`inline-block w-[7px] h-[7px] rounded-full ${mt5Online ? 'bg-up shadow-[0_0_10px_rgba(46,224,126,0.9)] animate-breathe' : 'bg-slate-500'}`} />
          <span className={`font-semibold ${mt5Online ? 'text-up' : 'text-slate-500'}`}>
            {mt5Online ? t('signals.focus.live', 'MT5 在线') : t('signals.focus.offline', 'MT5 离线')}
          </span>
        </div>
      </div>

      {/* ── 手机端：极简单行报价，品种代号 + 状态点 + 买价/点差/卖价 / mobile: minimal single-row quote ── */}
      <div className="qt-mobile-row sm:hidden">
        <div className="flex items-center gap-2">
          <b className="text-sm font-bold text-white">{focusMeta ? displaySymbol(focusMeta.sym) : '-'}</b>
          {focusQ?.closed && <span className="tag bg-white/5 text-slate-400 text-[10px]">{t('signals.marketClosed', '休市')}</span>}
          <span className={`inline-block w-[7px] h-[7px] rounded-full ${mt5Online ? 'bg-up shadow-[0_0_10px_rgba(46,224,126,0.9)] animate-breathe' : 'bg-slate-500'}`} />
        </div>
        <div className="flex items-center gap-5 ml-auto">
          <div className="text-center">
            <div className="text-[10px] text-slate-500 mb-0.5">{t('signals.quotes.bid', '买价')}</div>
            <span className="num font-bold text-sm" style={{ color: '#2ee07e' }}>{focusAsk}</span>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-slate-500 mb-0.5">{t('signals.quotes.spread', '点差')}</div>
            <span className="num text-xs text-slate-400">{spread}</span>
          </div>
          <div className="text-center">
            <div className="text-[10px] text-slate-500 mb-0.5">{t('signals.quotes.ask', '卖价')}</div>
            <span className="num font-bold text-sm" style={{ color: '#ff4d67' }}>{focusBid}</span>
          </div>
        </div>
      </div>

      {/* ── 桌面端：完整报价表 / desktop: full table ── */}
      <div className="qt-table-wrap hidden sm:block">
        <table className="qt-table">
          <thead>
            <tr>
              <th>{t('signals.focus.symbol', '交易品种')}</th>
              <th>{t('signals.focus.bid', '卖价')}</th>
              <th>{t('signals.focus.ask', '买价')}</th>
            </tr>
          </thead>
          <tbody>
            {symbols.length === 0 ? (
              <tr><td colSpan={3} className="text-center text-sm text-slate-500 py-4">{t('common.loading')}</td></tr>
            ) : (
              symbols.map((sym) => {
                const { letter, color } = symbolMeta(sym)
                const q = quotes[sym]
                const digits = q?.digits ?? 5
                const bid = q?.bid != null ? q.bid.toFixed(digits) : null
                const ask = q?.ask != null ? q.ask.toFixed(digits) : null
                return (
                  <tr key={sym}>
                    <td>
                      <div className="qt-sym-cell">
                        <div className="qt-sym-ava" style={{ background: color + '22', color }}>{letter}</div>
                        <div className="nm">
                          <b className="flex items-center gap-1.5">
                            {displaySymbol(sym)}
                            {q?.closed && <span className="tag bg-white/5 text-slate-400 text-[10px]">{t('signals.marketClosed', '休市')}</span>}
                          </b>
                          <span>{t(`signals.symbolNames.${sym}`, { defaultValue: '' })}</span>
                        </div>
                      </div>
                    </td>
                    <td><span className="qt-price num" style={{ color: '#ff4d67' }}>{bid ?? '-'}</span></td>
                    <td><span className="qt-price num" style={{ color: '#2ee07e' }}>{ask ?? '-'}</span></td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// memo：仅在报价快照变化时重渲染 / re-render only when the quotes snapshot changes
export default memo(QuotesTable)
