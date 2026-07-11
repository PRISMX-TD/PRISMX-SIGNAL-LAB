// 交易信号执行卡：入场价 + SL/TP + RR + 倒计时 + 下单按钮
// Signal exec card: entry + SL/TP + RR + countdown + trade button
import { memo, type FC } from 'react'
import { useTranslation } from 'react-i18next'
import type { Signal } from '../../api/types'
import { calcRiskReward, calcCountdown, fmtTime } from '../../api/utils'
import { SIGNAL_LIFESPAN_MS, rrTone } from './SignalView'

interface Props {
  signal: Signal | null
  now: number
  onTrade: (s: Signal) => void
}

// 无信号时的骨架同样撑满高度，避免卡片随有无信号忽大忽小
// keep the same skeleton height when there's no signal, so the card
// never shrinks/grows depending on whether a signal is present
const SignalExec: FC<Props> = ({ signal, now, onTrade }) => {
  const { t } = useTranslation()
  const rr = signal ? calcRiskReward(signal.symbol, signal.entry, signal.stopLoss, signal.takeProfit) : null
  const cd = signal ? calcCountdown(signal.expireAt, SIGNAL_LIFESPAN_MS, now) : null
  const isBuy = signal?.side === 'BUY'
  const sideTag = isBuy ? t('common.buy') : t('common.sell')
  const symName = signal ? t(`signals.symbolNames.${signal.symbol}`, { defaultValue: '' }) : ''
  const indicatorLabel = signal ? signal.indicator ?? t('signals.indicatorNone') : t('signals.focus.noExecutable')

  // 倒计时颜色：剩余不足2分钟变红 / countdown turns red when < 2 min
  const cdTone = cd && cd.remainMs < 2 * 60 * 1000 ? 'text-down' : 'text-slate-300'

  return (
    <>
      {/* ══ 桌面版：完整执行卡 / desktop: full exec card ══ */}
      <section className="card glass dash-exec p-[18px] flex-col hidden sm:flex">
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
            {signal ? symName || signal.symbol : '-'}
          </span>
          {symName && (
            <span className="text-[11px] text-slate-400 font-mono">{signal!.symbol}</span>
          )}
          {signal && <span className={`chip ${isBuy ? 'chip-buy' : 'chip-sell'}`}>{sideTag}</span>}
        </div>

        {/* 入场价 / Entry price */}
        <div className="entry-block">
          <div className="cap">{t('signals.colEntry').toUpperCase()}</div>
          <div className="val num">{signal?.entry ?? '-'}</div>
        </div>

        {/* 止损 / 止盈 / SL + TP */}
        <div className="sl-tp-grid mt-4">
          <div className="exec-tile tile-sl">
            <div className="cap">{t('signals.colSl')}</div>
            <div className="val num">{signal?.stopLoss ?? '-'}</div>
          </div>
          <div className="exec-tile tile-tp">
            <div className="cap">{t('signals.colTp')}</div>
            <div className="val num">{signal?.takeProfit ?? '-'}</div>
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
        <button
          onClick={() => signal && onTrade(signal)}
          disabled={!signal}
          className="btn btn-primary exec-full-btn mt-auto disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
          {t('signals.trade')}
        </button>
      </section>

      {/* ══ 手机版：套用普通信号卡设计 / mobile: reuse signal card design ══ */}
      <div className="card glass p-[18px] sm:hidden">
        {/* 顶部标签："可执行信号" */}
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-prism-300 mb-2">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />
          </svg>
          {t('signals.focus.signalHeading')}
        </div>

        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2">
              <b className="text-lg font-bold text-white">{signal ? symName || signal.symbol : '-'}</b>
              {signal && <span className={`chip ${isBuy ? 'chip-buy' : 'chip-sell'}`}>{sideTag}</span>}
            </div>
            {symName && (
              <div className="text-[11px] text-slate-400 mt-0.5">{indicatorLabel}</div>
            )}
          </div>
          <div className="text-right">
            <div className={`text-xl font-bold ${rrTone(rr?.rr ?? null)}`}>
              {rr?.rr != null ? `1:${rr.rr.toFixed(2)}` : '-'}
            </div>
            <div className="text-[10px] uppercase text-slate-500">{t('signals.focus.rrLabel')}</div>
          </div>
        </div>

        <div className="sl-tp-grid three mt-3">
          <div className="exec-tile" style={{ background: 'rgba(255,255,255,0.03)' }}>
            <div className="cap">{t('signals.colEntry')}</div>
            <div className="val num" style={{ color: '#fff', fontSize: '13px' }}>{signal?.entry ?? '-'}</div>
          </div>
          <div className="exec-tile tile-sl">
            <div className="cap">{t('signals.colSl')}</div>
            <div className="val num" style={{ fontSize: '13px' }}>{signal?.stopLoss ?? '-'}</div>
          </div>
          <div className="exec-tile tile-tp">
            <div className="cap">{t('signals.colTp')}</div>
            <div className="val num" style={{ fontSize: '13px' }}>{signal?.takeProfit ?? '-'}</div>
          </div>
        </div>

        <div className="mt-3">
          <div className="flex justify-between text-[11px] mb-1">
            <span className="text-slate-500">{t('signals.focus.remainingTtl')}</span>
            <span className={`num ${cdTone}`}>{cd?.text ?? '-'}</span>
          </div>
          <div className="sig-ttl-bar">
            <i style={{ width: `${Math.round((cd?.fraction ?? 0) * 100)}%` }} />
          </div>
        </div>

        <div className="flex items-center justify-between mt-3">
          <div className="min-w-0 flex-1">
            <div className="text-sm text-slate-300 truncate">{indicatorLabel}</div>
            <div className="text-[10px] text-slate-600 mt-0.5">{signal ? fmtTime(signal.createdAt) : ''}</div>
          </div>
          <button
            onClick={() => signal && onTrade(signal)}
            disabled={!signal}
            className="btn btn-primary rounded-xl px-6 py-2 text-[13px] font-semibold shrink-0 ml-3 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t('signals.trade')}
          </button>
        </div>
      </div>
    </>
  )
}

export default memo(SignalExec)
