// 其他活跃信号列表（仪表盘右栏贯通）
// Other active signals list (dashboard right column, spans two rows)
import { memo, type FC } from 'react'
import { useTranslation } from 'react-i18next'
import type { Signal } from '../../api/types'
import { calcRiskReward, calcCountdown, displaySymbol, fmtTime } from '../../api/utils'
import { SIGNAL_LIFESPAN_MS, type FocusState } from './SignalView'

interface OtherEntry {
  symbol: string
  state: FocusState
  signal: Signal
  idx: number
}

interface Props {
  entries: OtherEntry[]
  now: number
  onTrade: (s: Signal) => void
  onFocus: (idx: number) => void
  onViewAll: () => void
}

const SignalOthers: FC<Props> = ({ entries, now, onTrade, onFocus, onViewAll }) => {
  const { t } = useTranslation()

  // Dynamism: show up to 3 items, with animation
  const visible = entries.slice(0, 3)

  return (
    <section className="dash-others flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-center gap-2 px-0.5">
        <h3 className="text-[15px] font-bold">{t('signals.focus.otherActive')}</h3>
        <span className="count-badge">{entries.length}</span>
      </div>

      {/* Signal mini cards */}
      <div className="others-list">
        {visible.length === 0 && (
          <div className="card glass sig-mini-card text-center text-sm text-slate-400">
            {t('signals.focus.noExecutable')}
          </div>
        )}
        {visible.map(({ symbol, signal: sig, idx }) => {
          const oRr = calcRiskReward(sig.symbol, sig.entry, sig.stopLoss, sig.takeProfit)
          const cd = calcCountdown(sig.expireAt, SIGNAL_LIFESPAN_MS, now)
          const isBuy = sig.side === 'BUY'
          const sideTag = isBuy ? t('common.buy') : t('common.sell')

          return (
            <div
              key={sig.id}
              className="card glass sig-mini-card cursor-pointer"
              onClick={() => onFocus(idx)}
            >
              {/* Top row: symbol + RR */}
              <div className="sig-mini-top">
                <div>
                  <b className="text-base text-white">{displaySymbol(symbol)}</b>
                  <div className="text-[11px] text-slate-400 mt-0.5">{sig.indicator || '-'}</div>
                </div>
                <span className={`chip shrink-0 ${isBuy ? 'chip-buy' : 'chip-sell'}`}>{sideTag}</span>
                <div className="rr ml-auto">
                  <div className="v num">{oRr?.rr != null ? `1:${oRr.rr.toFixed(2)}` : '-'}</div>
                  <div className="k">{t('signals.focus.rrLabel')}</div>
                </div>
              </div>

              {/* Entry / SL / TP mini tiles */}
              <div className="sig-mini-tiles">
                <div className="sig-tile">
                  <div className="cap">{t('signals.colEntry')}</div>
                  <div className="val num">{sig.entry ?? '-'}</div>
                </div>
                <div className="sig-tile sl">
                  <div className="cap">{t('signals.colSl')}</div>
                  <div className="val num">{sig.stopLoss ?? '-'}</div>
                </div>
                <div className="sig-tile tp">
                  <div className="cap">{t('signals.colTp')}</div>
                  <div className="val num">{sig.takeProfit ?? '-'}</div>
                </div>
              </div>

              {/* TTL bar */}
              <div className="mt-2.5">
                <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                  <span>{t('signals.focus.remainingTtl')}</span>
                  <span className="num text-prism-300">{cd?.text ?? '-'}</span>
                </div>
                <div className="sig-ttl-bar">
                  <i style={{ width: `${Math.round((cd?.fraction ?? 0) * 100)}%` }} />
                </div>
              </div>

              {/* Footer: indicator + trade btn */}
              <div className="flex items-center gap-2 mt-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-slate-300 truncate">{sig.indicator || '-'}</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">{fmtTime(sig.createdAt)}</div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); onTrade(sig) }}
                  className="btn btn-primary rounded-lg h-[34px] px-4 text-[13px] shrink-0"
                >
                  {t('signals.trade')}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {/* View all button */}
      <button className="view-all-btn" onClick={onViewAll}>
        {t('signals.focus.otherActive')}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>
    </section>
  )
}

export default memo(SignalOthers)
