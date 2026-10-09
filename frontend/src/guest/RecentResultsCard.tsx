// 游客预览里「我的交易表现」那一格换成「最近结算的信号」。
//
// 游客没有自己的战绩，硬放一张示例战绩等于编数字；这里放的是**真实的**最近几条已过期
// 信号——价位完整、结果如实（止损的也照样列出来）。这些本来就对 FREE 用户公开，不泄露
// 任何能下单的东西，同时让访客看清「一条解锁后的信号长什么样」。
// In the guest preview the "my performance" slot becomes "recently settled signals". A guest
// has no record of their own and a sample one would be made-up numbers; these are the real
// latest expired signals, full prices and honest outcomes (losses listed too). FREE users
// see them already, so nothing tradeable leaks, and the visitor sees what an unlocked signal
// looks like.
import { memo, type FC } from 'react'
import { useTranslation } from 'react-i18next'
import type { Signal } from '../api/types'
import { displaySymbol, parseTime } from '../api/utils'
import { fmtPx, priceDecimals } from '../components/signals/SignalView'
import { symbolMeta } from '../utils/symbolMeta'

function ago(iso: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  // parseTime：后端的时间不带时区后缀，按 UTC 解析（直接 new Date 会按本地时区差出 8 小时）。
  // parseTime: backend timestamps carry no zone suffix and are UTC (new Date would read them as local).
  const at = parseTime(iso)?.getTime() ?? Date.now()
  const mins = Math.max(1, Math.round((Date.now() - at) / 60_000))
  return mins < 60 ? t('guest.recent.minAgo', { n: mins }) : t('guest.recent.hourAgo', { n: Math.round(mins / 60) })
}

const RecentResultsCard: FC<{ signals: Signal[]; stats: { hours: number; hitTp: number; hitSl: number } }> = ({ signals, stats }) => {
  const { t } = useTranslation()
  return (
    <section className="card glass dash-personal gst-recent">
      <div className="gst-recent-head">
        <h3>{t('guest.recent.title')}</h3>
        <button type="button" className="dh-link" data-gate="history">
          {t('guest.recent.viewAll')}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
        </button>
      </div>
      <p className="gst-recent-stats">
        {t('guest.recent.stats', { h: stats.hours })}
        <b className="num text-up">{t('guest.recent.tp', { n: stats.hitTp })}</b>
        <b className="num text-down">{t('guest.recent.sl', { n: stats.hitSl })}</b>
      </p>
      <ul className="gst-recent-list">
        {signals.slice(0, 4).map((s) => {
          const meta = symbolMeta(s.symbol)
          const d = priceDecimals(s.entry, s.stopLoss, s.takeProfit)
          const isBuy = s.side === 'BUY'
          const tone = s.result === 'HIT_TP' ? 'is-tp' : s.result === 'HIT_SL' ? 'is-sl' : 'is-pending'
          return (
            <li key={s.id}>
              <span className="sym-ava" style={{ background: meta.color + '33', color: meta.ink }}>{meta.letter}</span>
              <div className="min-w-0 flex-1">
                <div className="gst-recent-sym">
                  <b className="font-display">{displaySymbol(s.symbol)}</b>
                  <span className={`chip ${isBuy ? 'chip-buy' : 'chip-sell'}`}>{isBuy ? t('common.buy') : t('common.sell')}</span>
                  <span className="gst-recent-ago">{ago(s.createdAt, t)}</span>
                </div>
                <div className="gst-recent-px num">
                  <span>{t('signals.colEntry')} {fmtPx(s.entry, d)}</span>
                  <span className="text-down">SL {fmtPx(s.stopLoss, d)}</span>
                  <span className="text-up">TP {fmtPx(s.takeProfit, d)}</span>
                </div>
              </div>
              <span className={`gst-result ${tone}`}>
                {s.result === 'HIT_TP' ? t('signals.resultHitTp') : s.result === 'HIT_SL' ? t('signals.resultHitSl') : t('guest.recent.pending')}
              </span>
            </li>
          )
        })}
      </ul>
      <button type="button" className="gst-recent-foot" data-gate="personal">
        {t('guest.recent.foot')}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
      </button>
    </section>
  )
}

export default memo(RecentResultsCard)
