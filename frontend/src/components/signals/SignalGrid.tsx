// 信号面板独立视图：筛选器 + 信号网格
// Signal panel view: filters + signal cards grid
import { type FC, useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { usePrefs } from '../../store/prefs'
import type { Signal } from '../../api/types'
import { calcRiskReward, calcCountdown, fmtTime } from '../../api/utils'
import { SIGNAL_LIFESPAN_MS, effectiveStatus, rrTone } from './signalView'

interface Props {
  signals: Signal[]
  newIds: Set<string>
  now: number
  onTrade: (s: Signal) => void
}

const SignalGrid: FC<Props> = ({ signals, newIds, now, onTrade }) => {
  const { t } = useTranslation()
  const { getPref, setPref } = usePrefs()

  const [sideF, setSideF] = useState<'ALL' | 'BUY' | 'SELL'>(
    () => (getPref<string>('signals', 'sideF', 'ALL')) as 'ALL' | 'BUY' | 'SELL'
  )
  const [statusF, setStatusF] = useState<'ALL' | 'ACTIVE' | 'EXPIRING'>(
    () => (getPref<string>('signals', 'statusF', 'ALL')) as 'ALL' | 'ACTIVE' | 'EXPIRING'
  )
  const [sortF, setSortF] = useState<'latest' | 'expiry'>(
    () => (getPref<string>('signals', 'sortF', 'latest')) as 'latest' | 'expiry'
  )

  useEffect(() => { setPref('signals', 'sideF', sideF) }, [sideF, setPref])
  useEffect(() => { setPref('signals', 'statusF', statusF) }, [statusF, setPref])
  useEffect(() => { setPref('signals', 'sortF', sortF) }, [sortF, setPref])

  const filtered = useMemo(() => {
    let list = signals
      .filter(s => {
        const eff = effectiveStatus(s, now)
        if (eff === 'EXPIRED') return false
        if (sideF !== 'ALL' && s.side !== sideF) return false
        if (statusF !== 'ALL' && eff !== statusF) return false
        return true
      })
    if (sortF === 'expiry') {
      list.sort((a, b) => {
        const ca = calcCountdown(a.expireAt, SIGNAL_LIFESPAN_MS, now)
        const cb = calcCountdown(b.expireAt, SIGNAL_LIFESPAN_MS, now)
        return (ca?.remainMs ?? 0) - (cb?.remainMs ?? 0)
      })
    } else {
      list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    }
    return list
  }, [signals, now, sideF, statusF, sortF])

  return (
    <div>
      {/* Page head */}
      <div className="sig-page-head">
        <h2>{t('signals.title')}</h2>
        <span className="count-badge">{filtered.length}</span>
        <p>{t('signals.subtitle')}</p>
      </div>

      {/* Filters */}
      <div className="sig-filters">
        <div className="fgroup">
          <span className="fk">{t('signals.filterSide')}</span>
          <div className="seg">
            <button className={sideF === 'ALL' ? 'on' : ''} onClick={() => setSideF('ALL')}>{t('signals.all')}</button>
            <button className={sideF === 'BUY' ? 'on' : ''} onClick={() => setSideF('BUY')}>{t('common.buy')}</button>
            <button className={sideF === 'SELL' ? 'on' : ''} onClick={() => setSideF('SELL')}>{t('common.sell')}</button>
          </div>
        </div>
        <div className="fgroup">
          <span className="fk">{t('signals.filterStatus')}</span>
          <div className="seg">
            <button className={statusF === 'ALL' ? 'on' : ''} onClick={() => setStatusF('ALL')}>{t('signals.all')}</button>
            <button className={statusF === 'ACTIVE' ? 'on' : ''} onClick={() => setStatusF('ACTIVE')}>{t('signals.active')}</button>
            <button className={statusF === 'EXPIRING' ? 'on' : ''} onClick={() => setStatusF('EXPIRING')}>{t('signals.expiringSoon')}</button>
          </div>
        </div>
        <div className="fgroup">
          <span className="fk">{t('signals.sortBy')}</span>
          <div className="seg">
            <button className={sortF === 'latest' ? 'on' : ''} onClick={() => setSortF('latest')}>{t('signals.sort.latest')}</button>
            <button className={sortF === 'expiry' ? 'on' : ''} onClick={() => setSortF('expiry')}>{t('signals.sort.expiry')}</button>
          </div>
        </div>
      </div>

      {/* Signal grid */}
      <div className="sig-grid">
        {filtered.length === 0 && (
          <div className="sig-empty">{t('signals.focus.noExecutable')}</div>
        )}
        {filtered.map((sig) => {
          const oRr = calcRiskReward(sig.symbol, sig.entry, sig.stopLoss, sig.takeProfit)
          const isNew = newIds.has(sig.id)
          const cd = calcCountdown(sig.expireAt, SIGNAL_LIFESPAN_MS, now)
          const isBuy = sig.side === 'BUY'

          return (
            <div
              key={sig.id}
              className="card glass p-4"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  <b className="text-lg font-bold text-white">{sig.symbol}</b>
                  <span className={`chip ${isBuy ? 'chip-buy' : 'chip-sell'}`}>
                    {isBuy ? t('common.buy') : t('common.sell')}
                  </span>
                </div>
                <div className="text-right">
                  <div className={`text-xl font-bold ${rrTone(oRr?.rr ?? null)}`}>
                    {oRr?.rr != null ? `1:${oRr.rr.toFixed(2)}` : '-'}
                  </div>
                  <div className="text-[10px] uppercase text-slate-500">{t('signals.focus.rrLabel')}</div>
                </div>
              </div>

              <div className="sl-tp-grid three mt-3">
                <div className="exec-tile" style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <div className="cap">{t('signals.colEntry')}</div>
                  <div className="val num" style={{ color: '#fff', fontSize: '13px' }}>{sig.entry ?? '-'}</div>
                </div>
                <div className="exec-tile tile-sl">
                  <div className="cap">{t('signals.colSl')}</div>
                  <div className="val num" style={{ fontSize: '13px' }}>{sig.stopLoss ?? '-'}</div>
                </div>
                <div className="exec-tile tile-tp">
                  <div className="cap">{t('signals.colTp')}</div>
                  <div className="val num" style={{ fontSize: '13px' }}>{sig.takeProfit ?? '-'}</div>
                </div>
              </div>

              <div className="mt-3">
                <div className="flex justify-between text-[11px] mb-1">
                  <span className="text-slate-500">{t('signals.focus.remainingTtl')}</span>
                  <span className="num text-prism-300">{cd?.text ?? '-'}</span>
                </div>
                <div className="sig-ttl-bar">
                  <i style={{ width: `${Math.round((cd?.fraction ?? 0) * 100)}%` }} />
                </div>
              </div>

              <div className="flex items-center justify-between mt-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-300 truncate">{sig.indicator || '-'}</div>
                  <div className="text-[10px] text-slate-600 mt-0.5">{fmtTime(sig.createdAt)}</div>
                </div>
                <button onClick={() => onTrade(sig)} className="btn btn-primary rounded-xl px-6 py-2 text-[13px] font-semibold shrink-0 ml-3">
                  {t('signals.trade')}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default SignalGrid
