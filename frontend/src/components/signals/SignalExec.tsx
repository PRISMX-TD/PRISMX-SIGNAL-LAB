// 交易信号执行卡：入场价 + SL/TP + RR + 倒计时 + 下单按钮
// Signal exec card: entry + SL/TP + RR + countdown + trade button
import { type FC } from 'react'
import { useTranslation } from 'react-i18next'
import type { Signal } from '../../api/types'
import { calcRiskReward, calcCountdown } from '../../api/utils'
import { SIGNAL_LIFESPAN_MS, rrTone } from './signalView'

interface Props {
  signal: Signal
  now: number
  onTrade: (s: Signal) => void
}

const SignalExec: FC<Props> = ({ signal, now, onTrade }) => {
  const { t } = useTranslation()
  const rr = calcRiskReward(signal.symbol, signal.entry, signal.stopLoss, signal.takeProfit)
  const cd = calcCountdown(signal.expireAt, SIGNAL_LIFESPAN_MS, now)
  const isBuy = signal.side === 'BUY'
  const sideTag = isBuy ? t('common.buy') : t('common.sell')
  const symName = t(`signals.symbolNames.${signal.symbol}`, { defaultValue: '' })
  const indicatorLabel = signal.indicator ?? t('signals.indicatorNone')

  // 倒计时颜色：剩余不足2分钟变红 / countdown turns red when < 2 min
  const cdTone = cd && cd.remainMs < 2 * 60 * 1000 ? 'text-down' : 'text-slate-300'

  return (
    <section className="card glass dash-exec p-4 flex flex-col">
      {/* 标题行：可执行信号 + 倒计时 / title + countdown */}
      <div className="exec-title-row">
        <div className="flex items-center gap-2">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
          </svg>
          <h3 className="text-[15px] font-bold leading-none">{t('signals.focus.signalHeading')}</h3>
        </div>
        <span className={`flex items-center gap-1 text-xs font-semibold ${cdTone}`}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
          </svg>
          <span className="num">{cd?.text ?? '--:--'}</span>
        </span>
      </div>

      {/* 品种行：名称 + 代码 + 方向 / symbol + code + side */}
      <div className="exec-sym-row">
        <span className="text-[15px] font-bold leading-none">
          {symName || signal.symbol}
        </span>
        {symName && (
          <span className="text-[11px] text-slate-400 font-mono">{signal.symbol}</span>
        )}
        <span className={`chip ${isBuy ? 'chip-buy' : 'chip-sell'}`}>{sideTag}</span>
      </div>

      {/* 手机端：入场价 + SL/TP 横向并排；桌面端：正常堆叠 */}
      <div className="exec-mobile-row">
        {/* 入场价 / Entry price */}
        <div className="entry-block">
          <div className="cap">{t('signals.colEntry').toUpperCase()}</div>
          <div className="val num">{signal.entry ?? '-'}</div>
        </div>

        {/* 止损 / 止盈 / SL + TP */}
        <div className="sl-tp-grid">
          <div className="exec-tile tile-sl">
            <div className="cap">{t('signals.colSl')}</div>
            <div className="val num">{signal.stopLoss ?? '-'}</div>
          </div>
          <div className="exec-tile tile-tp">
            <div className="cap">{t('signals.colTp')}</div>
            <div className="val num">{signal.takeProfit ?? '-'}</div>
          </div>
        </div>
      </div>

      {/* 统计行：盈亏比 + 触发指标 / Stats: RR + indicator */}
      <div className="exec-stats-row mt-4">
        <div>
          <div className="k">{t('signals.focus.rrLabel')}</div>
          <div className={`v num ${rrTone(rr?.rr ?? null)}`}>
            {rr?.rr != null ? `1 : ${rr.rr.toFixed(2)}` : '-'}
          </div>
        </div>
        <div>
          <div className="k">{t('signals.colIndicator')}</div>
          <div className="v" style={{ fontSize: '14px', fontWeight: 600, color: '#c4b5fd', marginTop: 4 }}>
            {indicatorLabel}
          </div>
        </div>
      </div>

      {/* 下单按钮 / Trade button */}
      <button onClick={() => onTrade(signal)} className="btn btn-primary exec-full-btn mt-auto">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
        {t('signals.trade')}
      </button>
    </section>
  )
}

export default SignalExec
