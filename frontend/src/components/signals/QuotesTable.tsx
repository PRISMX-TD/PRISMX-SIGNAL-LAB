// 实时行情报价表（仪表盘左下）：固定核心品种，买价 + 卖价
// Live quotes table (dashboard bottom-left): hardcoded core symbols, bid + ask
import { memo, type FC } from 'react'
import { useTranslation } from 'react-i18next'
import type { Quote } from '../../api/types'

interface Props {
  quotes: Record<string, Quote>
  mt5Online: boolean
  focusSymbol?: string   // 手机端只显示这个品种 / mobile: show only this symbol
}

// 核心品种列表 / core symbols
const CORE_SYMBOLS: { sym: string; cnName: string; letter: string; color: string }[] = [
  { sym: 'XAUUSD', cnName: '黄金', letter: 'X', color: '#f6c453' },
  { sym: 'XAGUSD', cnName: '白银', letter: 'X', color: '#94a3b8' },
  { sym: 'EURUSD', cnName: '欧元/美元', letter: 'E', color: '#6366f1' },
  { sym: 'GBPUSD', cnName: '英镑/美元', letter: 'G', color: '#a855f7' },
  { sym: 'USDJPY', cnName: '美元/日元', letter: 'U', color: '#7c3aed' },
  { sym: 'EURGBP', cnName: '欧元/英镑', letter: 'E', color: '#8b5cf6' },
  { sym: 'BTCUSD', cnName: '比特币', letter: 'B', color: '#f59e0b' },
]

const QuotesTable: FC<Props> = ({ quotes, mt5Online, focusSymbol }) => {
  const { t } = useTranslation()

  // 手机端单行报价：优先用焦点品种，找不到则用第一个核心品种 / mobile: focus symbol or fallback
  const focusMeta = CORE_SYMBOLS.find(s => s.sym === focusSymbol) ?? CORE_SYMBOLS[0]
  const focusQ = quotes[focusMeta.sym]
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
          <b className="text-sm font-bold text-white">{focusMeta.sym}</b>
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
            {CORE_SYMBOLS.map(({ sym, cnName, letter, color }) => {
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
                        <b>{sym}</b>
                        <span>{cnName}</span>
                      </div>
                    </div>
                  </td>
                  <td><span className="qt-price num" style={{ color: '#ff4d67' }}>{bid ?? '-'}</span></td>
                  <td><span className="qt-price num" style={{ color: '#2ee07e' }}>{ask ?? '-'}</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// memo：仅在报价快照变化时重渲染 / re-render only when the quotes snapshot changes
export default memo(QuotesTable)
