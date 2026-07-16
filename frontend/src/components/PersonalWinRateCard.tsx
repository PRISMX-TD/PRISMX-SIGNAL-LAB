// 个人跟单表现卡：compact 放仪表盘（一眼看战绩 + 跳转详情），
// detailed 放订单页（同样的数据，展示更完整）。只有自己能看到自己的。
// Personal trading performance card: compact on the dashboard (at-a-glance +
// link to details), detailed on the Orders page (same data, fuller layout).
// Visible only to the user themself.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { orderApi } from '../api/client'
import type { PersonalWinRate } from '../api/types'

interface Props {
  variant?: 'compact' | 'detailed'
  // 只看这一个账号（订单页的账号标签驱动）；不传则是当前绑定的全部账号。
  // Narrow to one account (driven by the Orders page's account tab); omitted covers all currently-bound accounts.
  login?: string
}

export default function PersonalWinRateCard({ variant = 'compact', login }: Props) {
  const { t } = useTranslation()
  const [data, setData] = useState<PersonalWinRate | null>(null)

  useEffect(() => {
    let mounted = true
    const load = () => {
      orderApi.winrate(login).then((r) => { if (mounted) setData(r) }).catch(() => {})
    }
    // 切换账号标签时先清空旧数字再拉新的，避免短暂显示"上一个账号的胜率"。
    // Clear the stale number before refetching on an account switch, so the
    // previous account's win rate doesn't flash before the new one loads.
    setData(null)
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
  }, [login])

  const pct = data?.winRate != null ? Math.round(data.winRate * 100) : null
  const detailed = variant === 'detailed'

  return (
    <section className={`card glass ${detailed ? 'p-5' : 'p-[18px]'}`}>
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
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">{t('winrate.personalHint')}</p>

      {pct == null ? (
        <div className="mt-3 py-3 text-center text-sm text-slate-500">{t('winrate.noData')}</div>
      ) : (
        <>
          <div className="mt-3 flex items-end gap-2">
            <b className={`num font-bold text-up ${detailed ? 'text-4xl' : 'text-3xl'}`}>{pct}%</b>
            <span className="mb-1 text-xs text-slate-500">
              {t('winrate.resolvedCount', { n: data!.totalResolved })}
            </span>
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-lg bg-white/[0.03] px-3 py-2">
              <div className="text-slate-500">{t('winrate.wins')}</div>
              <div className="num mt-0.5 font-bold text-up">{data!.wins}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] px-3 py-2">
              <div className="text-slate-500">{t('winrate.losses')}</div>
              <div className="num mt-0.5 font-bold text-down">{data!.losses}</div>
            </div>
            <div className="rounded-lg bg-white/[0.03] px-3 py-2">
              <div className="text-slate-500">{t('winrate.openPositions')}</div>
              <div className="num mt-0.5 font-bold text-slate-300">{data!.openPositions}</div>
            </div>
          </div>
        </>
      )}
      {detailed && <p className="mt-3 text-[10px] text-slate-600">{t('winrate.disclaimer')}</p>}
    </section>
  )
}
