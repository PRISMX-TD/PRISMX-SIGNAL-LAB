// 策略客观胜率卡（仪表盘）：基于行情是否先碰到止盈/止损判定，全平台统一，
// 与市场概览并列展示，互相补充（市场概览看"现在"，这张卡看"过去准不准"）。
// Strategy win-rate card (dashboard): based on whether price hit TP or SL
// first, the same for everyone. Sits alongside Market Overview as a
// complement (Market Overview shows "now", this card shows "historically how
// accurate").
import { memo, useEffect, useState, type FC } from 'react'
import { useTranslation } from 'react-i18next'
import { signalApi } from '../../api/client'
import type { SignalWinRate } from '../../api/types'

const StrategyWinRateCard: FC = () => {
  const { t } = useTranslation()
  const [data, setData] = useState<SignalWinRate | null>(null)

  useEffect(() => {
    let mounted = true
    signalApi.winrate().then((r) => { if (mounted) setData(r) }).catch(() => {})
    return () => { mounted = false }
  }, [])

  const pct = data?.winRate != null ? Math.round(data.winRate * 100) : null

  return (
    <section className="card glass p-4">
      <h3 className="text-[15px] font-bold text-white">{t('winrate.strategyTitle')}</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{t('winrate.strategyHint')}</p>

      {pct == null ? (
        <div className="mt-3 py-3 text-center text-sm text-slate-500">{t('winrate.noData')}</div>
      ) : (
        <>
          <div className="mt-3 flex items-end gap-2">
            <b className="num text-3xl font-bold text-up">{pct}%</b>
            <span className="mb-1 text-xs text-slate-500">
              {t('winrate.resolvedCount', { n: data!.totalResolved })}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg bg-white/[0.03] px-3 py-2">
              <div className="text-slate-500">{t('winrate.hitTp')}</div>
              <div className="num mt-0.5 font-bold text-up">{data!.hitTp}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] px-3 py-2">
              <div className="text-slate-500">{t('winrate.hitSl')}</div>
              <div className="num mt-0.5 font-bold text-down">{data!.hitSl}</div>
            </div>
          </div>
        </>
      )}
      <p className="mt-3 text-[10px] text-slate-600">{t('winrate.disclaimer')}</p>
    </section>
  )
}

export default memo(StrategyWinRateCard)
