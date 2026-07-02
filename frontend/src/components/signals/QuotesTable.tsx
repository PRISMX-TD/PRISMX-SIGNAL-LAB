// 实时行情报价表（仪表盘左下）：固定核心品种，买价 + 卖价
// Live quotes table (dashboard bottom-left): hardcoded core symbols, bid + ask
import { type FC } from 'react'
import { useTranslation } from 'react-i18next'
import type { Quote } from '../../api/types'

interface Props {
  quotes: Record<string, Quote>
  mt5Online: boolean
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

const QuotesTable: FC<Props> = ({ quotes, mt5Online }) => {
  const { t } = useTranslation()

  return (
    <section className="card glass dash-quotes p-5">
      {/* 标题栏：左「实时行情报价」右 MT5 状态 / header: title left, MT5 status right */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[15px] font-bold text-white">{t('signals.focus.quotesHeading', '实时行情报价')}</h3>
        <div className="flex items-center gap-2 text-xs">
          <span className={`inline-block w-[7px] h-[7px] rounded-full ${mt5Online ? 'bg-up shadow-[0_0_10px_rgba(46,224,126,0.9)] animate-breathe' : 'bg-slate-500'}`} />
          <span className={`font-semibold ${mt5Online ? 'text-up' : 'text-slate-500'}`}>
            {mt5Online ? t('signals.focus.live', 'MT5 在线') : t('signals.focus.offline', 'MT5 离线')}
          </span>
        </div>
      </div>
      <div className="qt-table-wrap">
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

export default QuotesTable
