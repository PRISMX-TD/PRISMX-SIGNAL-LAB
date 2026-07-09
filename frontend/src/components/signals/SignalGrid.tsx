// 信号面板独立视图：筛选器 + 信号网格
// Signal panel view: filters + signal cards grid
import { type FC, useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { usePrefs } from '../../store/prefs'
import type { Signal, UserPlan } from '../../api/types'
import { calcRiskReward, calcCountdown, fmtTime } from '../../api/utils'
import { SIGNAL_LIFESPAN_MS, effectiveStatus, rrTone } from './signalView'

interface Props {
  signals: Signal[]
  now: number
  onTrade: (s: Signal) => void
  userPlan?: UserPlan
}

const SignalGrid: FC<Props> = ({ signals, now, onTrade, userPlan }) => {
  const { t } = useTranslation()
  const { getPref, setPref } = usePrefs()

  const [sideF, setSideF] = useState<'ALL' | 'BUY' | 'SELL'>(
    () => (getPref<string>('signals', 'sideF', 'ALL')) as 'ALL' | 'BUY' | 'SELL'
  )
  const [sortF, setSortF] = useState<'latest' | 'expiry'>(
    () => (getPref<string>('signals', 'sortF', 'latest')) as 'latest' | 'expiry'
  )

  useEffect(() => { setPref('signals', 'sideF', sideF) }, [sideF, setPref])
  useEffect(() => { setPref('signals', 'sortF', sortF) }, [sortF, setPref])

  // 手机端：点击循环切换筛选值，无需列出全部选项 / mobile: tap to cycle filter value
  const cycleSide = () => setSideF(s => (s === 'ALL' ? 'BUY' : s === 'BUY' ? 'SELL' : 'ALL'))
  const cycleSort = () => setSortF(s => (s === 'latest' ? 'expiry' : 'latest'))
  const sideLabel = sideF === 'ALL' ? t('signals.all') : sideF === 'BUY' ? t('common.buy') : t('common.sell')
  const sortLabel = sortF === 'latest' ? t('signals.sort.latest') : t('signals.sort.expiry')

  const isFree = userPlan === 'FREE'

  const filtered = useMemo(() => {
    let list = signals
      .filter(s => {
        const eff = effectiveStatus(s, now)
        // PRO 用户隐藏已过期信号（他们已通过 WS 实时看过 ACTIVE 阶段）
        // FREE 用户保留 EXPIRED 信号（这是他们唯一能看到的信号）
        if (!isFree && eff === 'EXPIRED') return false
        if (sideF !== 'ALL' && s.side !== sideF) return false
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
  }, [signals, now, sideF, sortF])

  return (
    <div>
      {/* Page head */}
      <div className="sig-page-head">
        <h2>{t('signals.title')}</h2>
        <span className="count-badge">{filtered.length}</span>
        <p>{t('signals.subtitle')}</p>
      </div>

      {/* Filters（桌面）：单排药丸按钮 / desktop: single-row pill filters */}
      <div className="sig-filters hidden sm:flex">
        <div className="fgroup">
          <span className="fk">{t('signals.filterSide')}</span>
          <div className="seg-pill">
            <button className={sideF === 'ALL' ? 'on' : ''} onClick={() => setSideF('ALL')}>{t('signals.all')}</button>
            <button className={sideF === 'BUY' ? 'on' : ''} onClick={() => setSideF('BUY')}>{t('common.buy')}</button>
            <button className={sideF === 'SELL' ? 'on' : ''} onClick={() => setSideF('SELL')}>{t('common.sell')}</button>
          </div>
        </div>
        <span className="fsep" />
        <div className="fgroup">
          <span className="fk">{t('signals.sortBy')}</span>
          <div className="seg-pill">
            <button className={sortF === 'latest' ? 'on' : ''} onClick={() => setSortF('latest')}>{t('signals.sort.latest')}</button>
            <button className={sortF === 'expiry' ? 'on' : ''} onClick={() => setSortF('expiry')}>{t('signals.sort.expiry')}</button>
          </div>
        </div>
      </div>

      {/* Filters（手机）：点击循环切换，仅显示当前选项 / mobile: tap to cycle, shows current option only */}
      <div className="sig-filters flex sm:hidden">
        <div className="fgroup">
          <span className="fk">{t('signals.filterSide')}</span>
          <button className={`filter-cycle ${sideF !== 'ALL' ? 'active' : ''}`} onClick={cycleSide}>
            <span>{sideLabel}</span>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        </div>
        <div className="fgroup">
          <span className="fk">{t('signals.sortBy')}</span>
          <button className="filter-cycle" onClick={cycleSort}>
            <span>{sortLabel}</span>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </button>
        </div>
      </div>

      {/* Signal grid */}
      <div className="sig-grid">
        {filtered.length === 0 && (
          <div className="sig-empty">{t('signals.focus.noExecutable')}</div>
        )}
        {filtered.map((sig) => {
          const oRr = calcRiskReward(sig.symbol, sig.entry, sig.stopLoss, sig.takeProfit)
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
