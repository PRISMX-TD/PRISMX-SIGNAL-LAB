// 个人跟单表现卡：compact 放仪表盘（一眼看战绩 + 跳转详情），
// detailed 放订单页（同样的数据，展示更完整）。只有自己能看到自己的。
// Personal trading performance card: compact on the dashboard (at-a-glance +
// link to details), detailed on the Orders page (same data, fuller layout).
// Visible only to the user themself.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { gamificationApi, orderApi } from '../api/client'
import { displaySymbol } from '../api/utils'
import type { GamificationWinRateSummary, PersonalWinRate } from '../api/types'
import { useAuth } from '../store/auth'
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
  const { user } = useAuth()
  const { closedTradeTick } = useLive()
  const [data, setData] = useState<PersonalWinRate | null>(null)
  const detailed = variant === 'detailed'
  const [gwr, setGwr] = useState<GamificationWinRateSummary | null>(null)

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

  // 综合胜率（考核口径）：只在仪表盘 compact 卡 + 开关打开时拉取，独立端点 +
  // 服务端 60 秒缓存，跟随上面同一个 45 秒轮询/焦点刷新节奏（设计 §2.4/§7）。
  // 失败静默——403（开关未开放）与网络错误都直接不显示这一块，不打扰账户
  // 胜率主体的展示。
  // Combined win rate (qualifying basis): fetched only for the dashboard's
  // compact card while the switch is on, via its own endpoint with a 60s
  // server-side cache, riding the same 45s poll/focus cadence as above
  // (§2.4/§7). Failures are silent — a 403 (switch off) or a network error
  // just leaves this block hidden without disturbing the main account
  // win-rate display.
  useEffect(() => {
    if (detailed || !user?.gamificationVisible) {
      setGwr(null)
      return
    }
    let mounted = true
    const load = () => {
      gamificationApi.winrateSummary().then((r) => { if (mounted) setGwr(r) }).catch(() => {})
    }
    load()
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
  }, [detailed, user?.gamificationVisible])

  const pct = data?.winRate != null ? Math.round(data.winRate * 100) : null
  const gwrPct = gwr?.winRate != null ? Math.round(gwr.winRate * 100) : null

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

      {/* 综合胜率（考核口径）：与上方账户胜率并排出现在同一张卡里，视觉上明显
          次于账户胜率主体（更小字号、独立分隔块）——账户胜率是给用户自己复
          盘的镜子，这一块是等级考核的第二个数字，两者第一次出现就摆在一起，
          不分先后地各带标签（设计 §2.4/§7）。只在 compact 卡、开关打开、且
          请求已经拿到数据时渲染；不依赖账户胜率是否已有数据（data 为 null
          时也能显示）。
          Combined win rate (qualifying basis): appears in the same card as the
          account win rate above it, visually subordinate to that main figure
          (smaller type, its own bordered block) — the account rate is the
          user's own mirror, this is the second, qualifying number, and the
          two show up together from the start, each carrying its own label
          (§2.4/§7). Rendered only on the compact card once the switch is on
          and the request has resolved; independent of whether the account
          win rate itself has data yet. */}
      {!detailed && gwr && (
        <div className="mt-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2.5">
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-neutral-500">{t('gamification.winRateCard.combined')}</span>
            <span className="num font-semibold text-neutral-200">
              {gwrPct != null ? `${gwrPct}%` : '—'}
            </span>
          </div>
          {/* 优先级：满级 > 下一关有胜率门槛（已达标/还差多少）> 下一关无胜率
              门槛但还有别的条件没做完（如一级 qicheng）> 什么都不知道就不渲染。
              isMaxLevel/metNext 由后端算好传来，不再用 level >= 6 或
              gapPct === 0 这类前端自己猜的口径（见 types.ts 注释）。
              Priority: max level > next group has a win-rate bar (met/still
              short) > next group has no win-rate bar but other undone
              conditions (e.g. level 1's qicheng) > render nothing if none of
              the above apply. isMaxLevel/metNext come pre-computed from the
              backend, not inferred client-side via level >= 6 or
              gapPct === 0 (see the types.ts comment). */}
          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-neutral-500">
            <span>{t('winrate.resolvedCount', { n: gwr.trades })}</span>
            {gwr.isMaxLevel ? (
              <span>{t('gamification.maxLevel')}</span>
            ) : gwr.nextWinRateTarget != null ? (
              gwr.metNext ? (
                <span className="text-up">{t('gamification.winRateCard.metNext')}</span>
              ) : gwr.gapPct != null ? (
                <span>{t('gamification.winRateCard.toNext', { pct: gwr.gapPct })}</span>
              ) : null
            ) : gwr.remainingToNext != null ? (
              <span>{t('gamification.remainingToNext', { count: gwr.remainingToNext })}</span>
            ) : null}
          </div>
          <Link to="/achievements" className="mt-1.5 block text-right text-[10px] text-prism-300 hover:text-prism-200">
            {t('gamification.title')} ›
          </Link>
        </div>
      )}
      {detailed && <p className="mt-3 text-[10px] text-neutral-500">{t('winrate.disclaimer')}</p>}
    </section>
  )
}
