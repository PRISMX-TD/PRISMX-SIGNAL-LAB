// 绩效分析页头：净盈亏 + 胜率 + 品种盈亏。
// 胜率走后端 /orders/winrate（与仪表盘 compact 卡同一个数、同一个回看窗口
// windowDays），净盈亏与品种盈亏由前端从已平仓明细（ClosedTrade[]）直接加总——
// 与下方的明细表同一份数据，所以数字与记录永远对得上。三样都按 windowDays 裁到
// 同一个时间窗内，否则胜率是近 N 天、净盈亏却是全历史，并排放着会误导。
// 2026-09-08 起绩效页就只有这三样：资金曲线 / 胜负条带 / 指标账本 / 出场方式 /
// R 分布都做过、都被产品负责人砍掉了，不要加回来。
//
// Performance head: net P&L + win rate + P&L by symbol. The win rate comes from
// the backend (same figure and look-back window as the dashboard's compact
// card); net P&L and the per-symbol split are summed client-side from the same
// ClosedTrade[] the list below renders, so aggregates always match the records.
// All three are cut to the same windowDays. Since 2026-09-08 this tab is
// deliberately just these three — the equity curve, streak ribbon, KPI ledger,
// exit-reason and R-distribution blocks were all removed by the product owner.
import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { orderApi } from '../api/client'
import { baseSymbol, displaySymbol } from '../api/utils'
import type { ClosedTrade, PersonalWinRate } from '../api/types'
import { useLive } from '../store/live'
import { symbolMeta } from '../utils/symbolMeta'
import { verdictOf } from './winrate/shared'
import { SkeletonLine } from './Skeleton'

interface Props {
  trades: ClosedTrade[] | null // null = 加载中 / loading
  login?: string
  currency?: string | null
  /** 统计范围那行里的账号说明，如 "601144 · Make Capital" / account label for the scope line */
  accountLabel: string
}

// 三档配色与策略胜率同一条规则（verdictOf）：51% 起绿、40–50% 橙、40% 以下红；
// 样本不足时不上色。/ Same three-band rule as the strategy win rate.
const TONE: Record<string, string> = { strong: 'var(--up)', mid: 'var(--mid)', weak: 'var(--down)' }

function parseIso(iso: string): Date {
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : iso + 'Z')
}

export function money(n: number): string {
  return (n > 0 ? '+' : '') + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function PerformanceSummary({ trades, login, currency, accountLabel }: Props) {
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

  const windowDays = data?.windowDays ?? null

  const agg = useMemo(() => {
    if (!trades || windowDays == null) return null
    const since = Date.now() - windowDays * 86_400_000
    let net = 0
    let count = 0
    const by = new Map<string, { net: number; n: number }>()
    for (const tr of trades) {
      if (tr.closedAt && parseIso(tr.closedAt).getTime() < since) continue
      net += tr.profit
      count += 1
      const key = baseSymbol(tr.symbol)
      const b = by.get(key) ?? { net: 0, n: 0 }
      b.net += tr.profit
      b.n += 1
      by.set(key, b)
    }
    const list = [...by.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.net - a.net)
    const neg = Math.max(0, -Math.min(0, ...list.map((r) => r.net)))
    const pos = Math.max(0, ...list.map((r) => r.net))
    const span = neg + pos
    return { net, count, list, zero: span > 0 ? (neg / span) * 100 : 0, span }
  }, [trades, windowDays])

  const loading = data === null || agg === null
  const pct = data?.winRate != null ? (data.winRate * 100).toFixed(1) : null
  const verdict = data
    ? verdictOf(
        { samples: data.totalResolved, resolved: data.totalResolved, pending: data.openPositions, winRate: data.winRate, wilsonLow: null, wilsonHigh: null },
        1,
      )
    : 'none'
  const tone = TONE[verdict] ?? '#fff'

  return (
    <section>
      <div className="ord-perf-head">
        <div>
          <div className="ord-eyebrow">{t('orders.perf.netTitle')}</div>
          {loading ? (
            <SkeletonLine width={240} height={48} className="mt-3" />
          ) : (
            <div className={`ord-perf-net ${agg.net >= 0 ? 'up' : 'dn'}`}>
              {money(agg.net)}
              <small>{currency || 'USD'}</small>
            </div>
          )}

          <div className="ord-perf-wr">
            <div className="ord-eyebrow">{t('orders.perf.winRate')}</div>
            {loading ? (
              <SkeletonLine width={120} height={30} className="mt-3" />
            ) : pct == null ? (
              <p className="ord-perf-nodata">{t('winrate.noData')}</p>
            ) : (
              <>
                <div className="ord-perf-wrn" style={{ color: tone }}>
                  {pct}<small>%</small>
                </div>
                <div className="ord-tug" aria-hidden>
                  <i style={{ flex: data!.wins, background: 'var(--up)' }} />
                  <i style={{ flex: data!.losses, background: 'var(--down)' }} />
                </div>
                <div className="ord-perf-rec">
                  {t('orders.perf.record', { w: data!.wins, l: data!.losses, n: data!.totalResolved })}
                </div>
              </>
            )}
          </div>
        </div>

        <div>
          <div className="ord-eyebrow ord-eyebrow-split">
            <span>{t('orders.perf.bySymbol')}</span>
            <span>{t('orders.perf.bySymbolHint')}</span>
          </div>
          {loading ? (
            <div className="ord-sbars">
              {[0, 1, 2].map((i) => <SkeletonLine key={i} height={20} />)}
            </div>
          ) : agg.list.length === 0 ? (
            <p className="ord-perf-nodata">{t('winrate.noData')}</p>
          ) : (
            <div className="ord-sbars">
              {agg.list.map((r, i) => {
                const meta = symbolMeta(r.key)
                const label = displaySymbol(r.key)
                const gain = r.net >= 0
                const w = agg.span > 0 ? (Math.abs(r.net) / agg.span) * 100 : 0
                return (
                  <div
                    key={r.key}
                    className="ord-sbar"
                    style={{ '--i': i } as CSSProperties}
                    title={`${label} ${money(r.net)} · ${t('orders.perf.trades', { n: r.n })}`}
                  >
                    <div className="ord-sbar-id">
                      <span className="sym-ava" style={{ background: meta.color + '33', color: meta.ink }}>{meta.letter}</span>
                      <span>{label}</span>
                    </div>
                    <div className="ord-sbar-trk">
                      <span className="ord-sbar-zero" style={{ left: `${agg.zero}%` }} />
                      <span
                        className={`ord-sbar-b ${gain ? 'gain' : 'loss'}`}
                        style={gain ? { left: `${agg.zero}%`, width: `${w}%` } : { right: `${100 - agg.zero}%`, width: `${w}%` }}
                      />
                    </div>
                    <div className={`ord-sbar-v ${gain ? 'up' : 'dn'}`}>{money(r.net)}</div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {windowDays != null && (
        <p className="ord-perf-scope">{t('orders.perf.scope', { days: windowDays, account: accountLabel })}</p>
      )}
    </section>
  )
}
