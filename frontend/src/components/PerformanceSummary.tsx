// 绩效分析页头：只剩胜率一项 + 统计范围一行。
// 胜率走后端 /orders/winrate（与仪表盘 compact 卡同一个数、同一个回看窗口 windowDays）。
// 2026-09-08 晚：净盈亏大数与品种盈亏细条按产品负责人要求撤掉，页头压成一行，
// 下面直接是已平仓明细。不要加回来。
// Performance head: the win rate plus a scope line, nothing else. The rate comes
// from the backend (same figure and look-back window as the dashboard's compact
// card). Net P&L and the per-symbol bars were removed at the product owner's
// request on 2026-09-08 and the head collapsed to one row; do not bring them back.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { orderApi } from '../api/client'
import type { PersonalWinRate } from '../api/types'
import { useLive } from '../store/live'
import { verdictOf } from './winrate/shared'
import { SkeletonLine } from './Skeleton'

interface Props {
  login?: string
  /** 统计范围那行里的账号说明，如 "601144 · Make Capital" / account label for the scope line */
  accountLabel: string
}

// 三档配色与策略胜率同一条规则（verdictOf）：51% 起绿、40–50% 橙、40% 以下红；
// 样本不足时不上色。/ Same three-band rule as the strategy win rate.
const TONE: Record<string, string> = { strong: 'var(--up)', mid: 'var(--mid)', weak: 'var(--down)' }

export default function PerformanceSummary({ login, accountLabel }: Props) {
  const { t } = useTranslation()
  const { closedTradeTick } = useLive()
  const [data, setData] = useState<PersonalWinRate | null>(null)

  // 切账号先清空再拉（不闪上一个账号的数），因新平仓重拉时不清。
  // Clear on account switch (no stale flash); keep on refetch-after-close.
  useEffect(() => { setData(null) }, [login])
  useEffect(() => {
    let mounted = true
    const load = () => {
      orderApi.winrate(login).then((r) => { if (mounted) setData(r) }).catch(() => {})
    }
    load()
    const timer = window.setInterval(() => { if (!document.hidden) load() }, 45_000)
    const onVisible = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      mounted = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [login, closedTradeTick])

  const pct = data?.winRate != null ? (data.winRate * 100).toFixed(1) : null
  const verdict = data
    ? verdictOf(
        { samples: data.totalResolved, resolved: data.totalResolved, pending: data.openPositions, winRate: data.winRate, wilsonLow: null, wilsonHigh: null },
        1,
      )
    : 'none'
  const tone = TONE[verdict] ?? '#fff'

  return (
    <section className="ord-perf-head">
      <div>
        <div className="ord-eyebrow">{t('orders.perf.winRate')}</div>
        {data === null ? (
          <SkeletonLine width={140} height={34} className="mt-3" />
        ) : pct == null ? (
          <p className="ord-perf-nodata">{t('winrate.noData')}</p>
        ) : (
          <>
            <div className="ord-perf-wrn" style={{ color: tone }}>
              {pct}<small>%</small>
            </div>
            <div className="ord-tug" aria-hidden>
              <i style={{ flex: data.wins, background: 'var(--up)' }} />
              <i style={{ flex: data.losses, background: 'var(--down)' }} />
            </div>
            <div className="ord-perf-rec">
              {t('orders.perf.record', { w: data.wins, l: data.losses, n: data.totalResolved })}
            </div>
          </>
        )}
      </div>
      {data?.windowDays != null && (
        <p className="ord-perf-scope">{t('orders.perf.scope', { days: data.windowDays, account: accountLabel })}</p>
      )}
    </section>
  )
}
