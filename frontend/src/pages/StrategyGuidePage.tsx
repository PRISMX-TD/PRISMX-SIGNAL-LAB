// 平台策略详情页（/app/strategy/:id）。从信号面板页的「平台策略」标签点进来。
//
// 数据来源是同一个只读端点 GET /signals/platform-strategies（只返回已发布条目），
// 拉全量后按 id 取。没有做单条端点：整个清单是管理员手工维护的十几条内容，一次
// 取回比多加一个端点划算，而且返回里带着上一条/下一条，页脚的翻页不用再发请求。
//
// 刻意不展示胜率、盈亏比等业绩数字：真实战绩的唯一来源是信号自身的 result 判定
//（后端 services/signal_resolution.py）。这里只描述策略的设计特征。
//
// Platform strategy detail page (/app/strategy/:id), reached from the "Platform
// strategies" tab on the signals page.
//
// Data comes from the same read-only GET /signals/platform-strategies (published
// entries only); the list is fetched whole and the entry picked by id. There is
// no single-item endpoint on purpose: the list is a dozen-odd hand-maintained
// entries, so one fetch beats adding another endpoint, and having the full list
// means the prev/next footer links need no extra request.
//
// Deliberately shows no win-rate or profit-factor figures: the only source of
// real performance is each signal's own result adjudication (backend
// services/signal_resolution.py). This describes design characteristics only.
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { signalApi } from '../api/client'
import { localizeApiError } from '../api/utils'
import { pick, StrategyDetail } from '../components/strategyGuide'
import { SkeletonPage } from '../components/Skeleton'
import type { PlatformStrategy } from '../api/types'

function TagRow({ label, values }: { label: string; values: string[] }) {
  if (!values || values.length === 0) return null
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1.5">
      <span className="text-xs text-slate-500">{label}</span>
      {values.map((v) => (
        <span key={v} className="rounded-md bg-white/5 px-2 py-0.5 text-xs text-slate-300">
          {v}
        </span>
      ))}
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-0.5 text-sm text-slate-200">{value}</div>
    </div>
  )
}

export default function StrategyGuidePage() {
  const { t, i18n } = useTranslation()
  const isZh = i18n.language !== 'en'
  const { id } = useParams<{ id: string }>()
  const [items, setItems] = useState<PlatformStrategy[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    signalApi
      .platformStrategies()
      .then((res) => {
        if (alive) setItems(res.items)
      })
      .catch((err: unknown) => {
        if (alive) setError(localizeApiError(err instanceof Error ? err.message : String(err)))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  // 切换策略时回到顶部：路由参数变了但组件实例没换，浏览器会保留原滚动位置，
  // 从长文末尾点「下一条」会落在新页面的中间。
  // Scroll to top when switching strategies: the route param changes without
  // remounting, so the browser keeps the old scroll offset and clicking "next"
  // from the end of a long write-up would land mid-page.
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [id])

  if (loading) {
    return (
      <div className="max-w-[900px] mx-auto">
        <SkeletonPage cards={2} />
      </div>
    )
  }

  const sorted = [...items].sort((a, b) => a.order - b.order)
  const index = sorted.findIndex((s) => s.id === id)
  const strategy = index >= 0 ? sorted[index] : null

  if (error || !strategy) {
    return (
      <div className="mx-auto max-w-2xl py-16 text-center">
        <p className="text-sm text-slate-400">{error || t('signals.guide.notFound')}</p>
        <Link to="/app" className="btn-ghost mt-5 inline-block px-4 py-2 text-sm">
          {t('signals.guide.backToList')}
        </Link>
      </div>
    )
  }

  const name = pick(strategy.nameZh, strategy.nameEn, isZh)
  const summary = pick(strategy.summaryZh, strategy.summaryEn, isZh)
  const prev = index > 0 ? sorted[index - 1] : null
  const next = index < sorted.length - 1 ? sorted[index + 1] : null

  return (
    <div className="mx-auto max-w-3xl">
      <Link to="/app" className="text-xs text-slate-400 transition-colors hover:text-slate-200">
        ← {t('signals.guide.backToList')}
      </Link>

      <h1 className="mt-4 font-display text-2xl font-bold text-slate-100 sm:text-3xl">{name}</h1>
      {summary && <p className="mt-2 text-sm leading-relaxed text-slate-400">{summary}</p>}

      {strategy.imageUrl && (
        <img
          src={strategy.imageUrl}
          alt={name}
          className="mt-6 max-h-72 w-full rounded-2xl border border-white/10 object-contain"
        />
      )}

      {/* 设计参数概览。风险回报比是下单时的止损止盈之比，属于策略参数，不是业绩。
          Design parameters. Risk:reward is the SL/TP ratio at order time — a
          strategy parameter, not performance. */}
      <div className="glass mt-6 grid gap-4 p-5 sm:grid-cols-3">
        <Fact label={t('signals.guide.marketRegime')} value={pick(strategy.marketRegimeZh, strategy.marketRegimeEn, isZh)} />
        <Fact label={t('signals.guide.holdingTime')} value={pick(strategy.holdingTimeZh, strategy.holdingTimeEn, isZh)} />
        <Fact label={t('signals.guide.riskReward')} value={strategy.riskReward} />
      </div>

      <div className="mt-4 space-y-2">
        <TagRow label={t('signals.guide.symbols')} values={strategy.symbols} />
        <TagRow label={t('signals.guide.timeframes')} values={strategy.timeframes} />
        <TagRow label={t('signals.guide.indicators')} values={strategy.indicators} />
      </div>

      <article className="mt-8">
        <StrategyDetail strategy={strategy} isZh={isZh} />
      </article>

      <p className="mt-10 border-t border-white/10 pt-5 text-xs leading-relaxed text-slate-500">
        {t('signals.guide.disclaimer')}
      </p>

      {(prev || next) && (
        <nav className="mt-6 flex justify-between gap-4">
          {prev ? (
            <Link
              to={`/app/strategy/${prev.id}`}
              className="glass flex-1 p-4 text-left transition-colors hover:bg-white/5"
            >
              <div className="text-xs text-slate-500">{t('signals.guide.prev')}</div>
              <div className="mt-1 text-sm text-slate-200">{pick(prev.nameZh, prev.nameEn, isZh)}</div>
            </Link>
          ) : (
            <div className="flex-1" />
          )}
          {next ? (
            <Link
              to={`/app/strategy/${next.id}`}
              className="glass flex-1 p-4 text-right transition-colors hover:bg-white/5"
            >
              <div className="text-xs text-slate-500">{t('signals.guide.next')}</div>
              <div className="mt-1 text-sm text-slate-200">{pick(next.nameZh, next.nameEn, isZh)}</div>
            </Link>
          ) : (
            <div className="flex-1" />
          )}
        </nav>
      )}
    </div>
  )
}
