// 个人跟单表现卡：compact 放仪表盘（一眼看战绩 + 跳转详情），
// detailed 放订单页（同样的数据，展示更完整）。只有自己能看到自己的。
// Personal trading performance card: compact on the dashboard (at-a-glance +
// link to details), detailed on the Orders page (same data, fuller layout).
// Visible only to the user themself.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { orderApi } from '../api/client'
import { displaySymbol } from '../api/utils'
import type { PersonalWinRate } from '../api/types'
import { useLive } from '../store/live'
import RadialGauge from './RadialGauge'
import { symbolMeta } from '../utils/symbolMeta'

interface Props {
  /** 外层挂的类名，目前只用于仪表盘的手机端排序（见 .dash-personal）。
   *  A class from the caller; currently only the dashboard's mobile ordering hook. */
  className?: string
  variant?: 'compact' | 'detailed'
  // 只看这一个账号（订单页的账号标签驱动）；不传则是当前绑定的全部账号。
  // Narrow to one account (driven by the Orders page's account tab); omitted covers all currently-bound accounts.
  login?: string
}

export default function PersonalWinRateCard({ variant = 'compact', login, className = '' }: Props) {
  const { t } = useTranslation()
  const { closedTradeTick } = useLive()
  const [data, setData] = useState<PersonalWinRate | null>(null)

  // 切账号要先清空再拉（避免闪上一个账号的胜率），但因新平仓而重拉时不能清空
  // ——否则每次平仓卡片都会闪一下空白。所以只在 login 变化时清。
  // An account switch clears first (so the previous account's rate doesn't
  // flash), but a refetch triggered by a new close must not — that would blank
  // the card on every close. So only clear when login itself changes.
  useEffect(() => {
    setData(null)
  }, [login])

  useEffect(() => {
    let mounted = true
    const load = () => {
      orderApi.winrate(login).then((r) => { if (mounted) setData(r) }).catch(() => {})
    }
    load()
    // 定时刷新 + 回到页面时立即刷新，让战绩随平仓近实时更新，无需手动刷新整页。
    // 页面在后台时跳过轮询（rAF/定时器也会被浏览器节流），切回前台再补一次。
    // Poll + refetch on focus so the record tracks new closes in near-real-time
    // without a full page reload. Skip polling while hidden and refetch on
    // return so a backgrounded tab doesn't hammer the API.
    const timer = window.setInterval(() => {
      if (!document.hidden) load()
    }, 45_000)
    const onVisible = () => { if (!document.hidden) load() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      mounted = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
    // closedTradeTick：后端刚记下新平仓，立刻重拉，胜率不落后于下方的明细列表。
    // closedTradeTick: a new close just landed — refetch now so the rate never
    // lags the trade list beneath it.
  }, [login, closedTradeTick])

  const pct = data?.winRate != null ? Math.round(data.winRate * 100) : null
  const detailed = variant === 'detailed'

  return (
    <section className={`card glass ${detailed ? 'p-5' : 'p-[18px]'}${className ? ` ${className}` : ''}`}>
      <div className="flex items-center justify-between">
        <h3 className={`font-bold text-white ${detailed ? 'text-lg' : 'text-[15px]'}`}>
          {t('winrate.personalTitle')}
        </h3>
        {!detailed && (
          <Link to="/orders" className="text-xs text-prism-300 hover:text-prism-200">
            {t('winrate.viewDetail')} ›
          </Link>
        )}
      </div>
      {/* 统计范围必须写在标题下面：后端给这份统计加了回看窗口（见后端
          trade_performance.WINDOW_DAYS），数字只覆盖最近这么多天。不写出来，
          用户会把它读成全历史战绩——这跟策略卡把「历史最长连亏」改成「近 200
          笔最长连亏」是同一条规矩：口径变了就得让用户看见。
          The scope belongs right under the title: the backend bounds this stat by
          a look-back window (see trade_performance.WINDOW_DAYS), so the figures
          cover only the last N days. Unstated, a user reads them as an all-time
          record — the same rule that turned the strategy card's "longest losing
          streak" into "longest in the last 200": if what a number measures
          changes, say so. */}
      <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">
        {t('winrate.personalHint')}
        {data && ` ${t('winrate.windowHint', { days: data.windowDays })}`}
      </p>

      {pct == null ? (
        <div className="mt-3 py-3 text-center text-sm text-neutral-500">{t('winrate.noData')}</div>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-4">
            <RadialGauge value={pct} color="var(--up)" size={detailed ? 116 : 88} strokeWidth={detailed ? 13 : 10}>
              <b className={`num font-bold text-up ${detailed ? 'text-3xl' : 'text-2xl'}`}>{pct}%</b>
              <span className="mt-0.5 text-center text-[10px] leading-tight text-neutral-500">
                {t('winrate.resolvedCount', { n: data!.totalResolved })}
              </span>
            </RadialGauge>
            <div className="grid flex-1 grid-cols-1 gap-1.5 text-xs">
              <div className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2">
                <span className="text-neutral-500">{t('winrate.wins')}</span>
                <span className="num font-bold text-up">{data!.wins}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2">
                <span className="text-neutral-500">{t('winrate.losses')}</span>
                <span className="num font-bold text-down">{data!.losses}</span>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2">
                <span className="text-neutral-500">{t('winrate.openPositions')}</span>
                <span className="num font-bold text-neutral-300">{data!.openPositions}</span>
              </div>
            </div>
          </div>

          {detailed && data!.bySymbol.length > 0 && (
            <div className="mt-4 border-t border-white/10 pt-3">
              <span className="text-[11px] uppercase tracking-wide text-neutral-500">{t('winrate.bySymbol')}</span>
              <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-white/[0.06]">
                {data!.bySymbol.map((row) => (
                  <div
                    key={row.symbol}
                    style={{ width: `${(row.count / data!.totalResolved) * 100}%`, backgroundColor: symbolMeta(row.symbol).color }}
                  />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5">
                {data!.bySymbol.map((row) => (
                  <div key={row.symbol} className="flex items-center gap-1.5 text-[11px]">
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: symbolMeta(row.symbol).color }} />
                    <span className="text-neutral-300">{displaySymbol(row.symbol)}</span>
                    <span className="text-neutral-500">{Math.round((row.count / data!.totalResolved) * 100)}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      {detailed && <p className="mt-3 text-[10px] text-neutral-500">{t('winrate.disclaimer')}</p>}
    </section>
  )
}
