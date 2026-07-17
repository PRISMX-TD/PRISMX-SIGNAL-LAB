// 纪律分卡：回答"有没有按计划执行"，与赚不赚钱无关。只有自己能看到自己的。
// **当前仅管理员可见**——挂载点由父组件（OrdersPage）用 isAdmin 判断，本组件
// 不做权限判断；后端 GET /orders/discipline 也是 require_admin。功能内部
// 试用中，对外开放时把两处判断去掉即可，本组件不需要改动。
//
// Discipline Score card: whether the plan was followed, independent of P&L.
// Visible only to the user themself. **Admin-only for now** — gated by the
// parent (OrdersPage) via isAdmin; this component itself has no permission
// logic. The backend endpoint is likewise require_admin. Releasing the
// feature means dropping both gates; this component needs no change.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { orderApi } from '../api/client'
import type { DisciplineScore } from '../api/types'

interface Props {
  // 只看这一个账号（订单页的账号标签驱动）；不传则是当前绑定的全部账号。
  // Narrow to one account (driven by the Orders page's account tab); omitted covers all currently-bound accounts.
  login?: string
  // 当前用户是否为 PRO——决定要不要展示逐维度明细区（后端已经按 plan 裁剪
  // 响应体，这里只是决定"没有 dimensions 时显示什么"）。
  // Whether the current user is PRO — decides whether to render the
  // per-dimension area (the backend already gates the response by plan;
  // this only decides what to show when `dimensions` is absent).
  isPro: boolean
}

const SVG_W = 300
const SVG_H = 60

function scoreColorClass(score: number): string {
  if (score >= 80) return 'text-up'
  if (score >= 50) return 'text-slate-300'
  return 'text-down'
}

function buildTrendPoints(trend: Array<{ date: string; total: number | null }>): string {
  const withValues = trend.filter((t) => t.total != null) as Array<{ date: string; total: number }>
  if (withValues.length < 2) return ''
  const stepX = SVG_W / (withValues.length - 1)
  return withValues
    .map((t, i) => {
      const x = Math.round(stepX * i)
      const y = Math.round(SVG_H - (t.total / 100) * SVG_H)
      return `${x},${y}`
    })
    .join(' ')
}

const DIMENSION_KEYS = ['stopLoss', 'volume', 'exit'] as const

export default function DisciplineScoreCard({ login, isPro }: Props) {
  const { t } = useTranslation()
  const [data, setData] = useState<DisciplineScore | null>(null)

  useEffect(() => {
    let mounted = true
    const load = () => {
      orderApi.discipline(login).then((r) => { if (mounted) setData(r) }).catch(() => {})
    }
    // 切换账号标签时先清空旧数字再拉新的，避免短暂显示"上一个账号的纪律分"。
    // Clear the stale number before refetching on an account switch, so the
    // previous account's score doesn't flash before the new one loads.
    setData(null)
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
  }, [login])

  const trendPoints = data ? buildTrendPoints(data.trend) : ''

  return (
    <section className="card glass p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-bold text-white">{t('discipline.title')}</h3>
        <span className="text-[11px] text-slate-500">{t('discipline.windowHint', { n: data?.windowDays ?? 90 })}</span>
      </div>

      {data == null || data.total == null ? (
        <div className="mt-3 py-3 text-center text-sm text-slate-500">{t('discipline.noData')}</div>
      ) : (
        <>
          <div className="mt-3 flex items-end gap-2">
            <b className={`num text-4xl font-bold ${scoreColorClass(data.total)}`}>{Math.round(data.total)}</b>
          </div>

          {trendPoints && (
            <svg viewBox={`0 0 ${SVG_W} ${SVG_H}`} className="mt-3 w-full text-prism-300" preserveAspectRatio="none">
              <polyline
                fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" points={trendPoints}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}

          {data.dimensions ? (
            <div className="mt-3 flex flex-col gap-2">
              {DIMENSION_KEYS.map((key) => {
                const dim = data.dimensions![key]
                return (
                  <div key={key} className="text-xs">
                    <div className="flex items-center justify-between text-slate-400">
                      <span>{t(`discipline.dim${key === 'stopLoss' ? 'Stop' : key === 'volume' ? 'Volume' : 'Exit'}`)}</span>
                      {dim.score == null ? (
                        <span className="text-slate-600">{t('discipline.insufficient')}</span>
                      ) : (
                        <span>{t('discipline.violations', { v: dim.violations, n: dim.samples })}</span>
                      )}
                    </div>
                    <div className="mt-1 h-1.5 rounded-full bg-white/[0.06]">
                      {dim.score != null && (
                        <div
                          className={`h-1.5 rounded-full ${dim.score >= 80 ? 'bg-up' : dim.score >= 50 ? 'bg-slate-400' : 'bg-down'}`}
                          style={{ width: `${dim.score}%` }}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          ) : !isPro ? (
            <div className="mt-3 rounded-lg border border-prism-500/20 bg-prism-600/5 p-3 text-center text-xs text-slate-400">
              {t('discipline.upgradeHint')}{' '}
              <Link to="/upgrade" className="text-prism-300 underline hover:text-prism-200">
                {t('winrate.viewDetail')}
              </Link>
            </div>
          ) : null}
        </>
      )}
      <p className="mt-3 text-[10px] text-slate-600">{t('discipline.disclaimer')}</p>
    </section>
  )
}
