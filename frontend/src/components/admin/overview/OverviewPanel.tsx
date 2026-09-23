// 管理页「数据看板」页签。职责：时间范围状态（写在 URL 里，刷新不丢、可分享）、
// 两个接口各自加载各自失败、把所有卡片按设计顺序排出来。
// URL 写入用 replace：切范围不该在浏览历史里留一条，否则"返回"变成在范围之间来回跳
// （AdminPage 的页签因同样理由干脆不写 URL）。
// The dashboard tab: range state in the URL (replace, not push), two requests
// that fail independently, cards in the spec's order.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { adminApi } from '../../../api/client'
import type { AdminOverview, AdminPageStats } from '../../../api/types'
import { localizeApiError } from '../../../api/utils'
import { SkeletonLine } from '../../Skeleton'
import PageStatsCard from '../PageStatsCard'
import ActivityChart from './ActivityChart'
import FunnelCard from './FunnelCard'
import HeadlineCards from './HeadlineCards'
import NetQualityCard from './NetQualityCard'
import PlanBreakdown from './PlanBreakdown'
import TraderLevelsCard from './TraderLevelsCard'
import RangePicker from './RangePicker'
import RetentionCard from './RetentionCard'
import StrategyUsageCard from './StrategyUsageCard'
import TradingUsageCard from './TradingUsageCard'
import { rangeKey, readRange, toQuery, writeRange, type RangeState } from './rangeUtils'

type Loadable<T> = { data: T | null; error: string | null; loading: boolean }

function useLoadable<T>(fetcher: () => Promise<T>, key: string): Loadable<T> & { reload: () => void } {
  const [state, setState] = useState<Loadable<T>>({ data: null, error: null, loading: true })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    setState((s) => ({ ...s, loading: true, error: null }))
    fetcher().then(
      (data) => { if (!cancelled) setState({ data, error: null, loading: false }) },
      (err: unknown) => { if (!cancelled) setState((s) => ({ ...s, error: err instanceof Error ? localizeApiError(err.message) : 'error', loading: false })) },
    )
    return () => { cancelled = true }
    // fetcher 每次渲染都是新函数，用 key + tick 当依赖才不会无限重拉
    // fetcher is a fresh closure each render; key + tick are the real deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick])
  return { ...state, reload: () => setTick((n) => n + 1) }
}

function FailedCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="glass mb-5 flex items-center justify-between gap-3 p-4 text-xs">
      <span className="text-down">{t('admin.overview.loadFailed')}{message ? `：${message}` : ''}</span>
      <button type="button" onClick={onRetry} className="rounded-full bg-white/10 px-3 py-1 text-neutral-100 ring-1 ring-white/20">
        {t('admin.overview.retry')}
      </button>
    </div>
  )
}

export default function OverviewPanel() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  // readRange 每次都返回新对象；RangePicker 的 useEffect 以 value 为依赖，
  // 不 memo 的话父级任何重渲染（比如数据到达）都会重新触发它，把正在输入的
  // 自定义日期面板关掉。
  // readRange returns a fresh object each call; RangePicker's effect is keyed
  // on value, so without memoizing, any parent re-render (e.g. data arriving)
  // would re-fire it and close the custom-date panel mid-edit.
  const range: RangeState = useMemo(() => readRange(searchParams), [searchParams])
  const setRange = useCallback(
    (next: RangeState) => setSearchParams(writeRange(searchParams, next), { replace: true }),
    [searchParams, setSearchParams],
  )
  const key = rangeKey(range)
  const overview = useLoadable<AdminOverview>(() => adminApi.overview(toQuery(range)), key)
  const pageStats = useLoadable<AdminPageStats>(() => adminApi.pageStats(toQuery(range)), key)

  return (
    <>
      <RangePicker value={range} onChange={setRange} />
      {overview.data && (
        <p className="-mt-3 mb-4 text-xs text-neutral-500">
          {t('admin.overview.range.shown', { ...overview.data.range })}
        </p>
      )}

      {overview.error ? (
        <FailedCard message={overview.error} onRetry={overview.reload} />
      ) : !overview.data ? (
        <div className="glass mb-5 p-5"><SkeletonLine height={96} /></div>
      ) : (
        <>
          <HeadlineCards headline={overview.data.headline} />
          {/* 实时数据，自己拉、自己刷新 / live, self-fetching */}
          <NetQualityCard />
          <ActivityChart daily={overview.data.activityDaily} dataSince={overview.data.visitorDataSince} />
          <FunnelCard funnel={overview.data.funnel} />
          <RetentionCard retention={overview.data.retention} dataSince={overview.data.visitorDataSince} />
          <PlanBreakdown plans={overview.data.plans} />
          {/* 交易员等级自己拉数据、自己管展开的名单，与上面的 overview 请求各自成败。
              Fetches and fails on its own, independently of the overview request. */}
          <TraderLevelsCard range={range} />
          <div className="mb-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <StrategyUsageCard rows={overview.data.strategies} />
            <TradingUsageCard trading={overview.data.trading} />
          </div>
        </>
      )}

      {pageStats.error ? (
        <FailedCard message={pageStats.error} onRetry={pageStats.reload} />
      ) : (
        <PageStatsCard stats={pageStats.data} loading={pageStats.loading} />
      )}
    </>
  )
}
