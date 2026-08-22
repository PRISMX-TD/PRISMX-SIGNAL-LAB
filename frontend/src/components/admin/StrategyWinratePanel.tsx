// 管理后台「策略胜率」子页：24 小时时段轴、「现在该盯什么」推荐区、策略详情
// 三层拼成一页盯盘决策页。
// Admin "Strategy Win Rate" sub-tab: the 24h session timeline, the "what to
// watch now" recommendations, and the strategy detail — one page for live
// monitoring.
//
// 判定链路健康条（窗口内四态计数 + 最近一次判定时间）已按产品要求移除。
// 后端仍返回 lastResolvedAt，判定停摆时的诊断改由这条 SQL 主动查：
//   SELECT count(*) FILTER (WHERE baseline_high IS NOT NULL),
//          max(resolved_at) FILTER (WHERE result IN ('HIT_TP','HIT_SL'))
//   FROM signals WHERE source = 'tradingview';
// 页面本身不再提示链路故障——这是明确的取舍，不是遗漏。
// The resolution-health bar was removed at the product owner's request. The
// backend still returns lastResolvedAt; diagnosing a stalled pipeline is now a
// manual SQL check (above) rather than something the page surfaces. The page no
// longer warns about a broken pipeline — a deliberate trade-off, not an
// oversight.
//
// 时段窗口（小时区间 + IANA 时区）随接口一起下发，前端**不**复制一份：夏令时
// 的正确性只在后端保证一次，这里只负责把它翻译成看的人所在时区的钟点。
// The session windows (hour range + IANA zone) ship with the payload and are
// deliberately NOT duplicated here — DST correctness is settled once in the
// backend; this file only restates the window in the viewer's own clock.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../api/client'
import { SkeletonLine } from '../Skeleton'
import type { AdminStrategyWinRate } from '../../api/types'
import { MIN_SAMPLES, sessionStatus } from './winrate/shared'
import SessionTimeline from './winrate/SessionTimeline'
import RecommendationCards from './winrate/RecommendationCards'
import StrategyDetail from './winrate/StrategyDetail'

const DAY_OPTIONS = [7, 14, 30]

export default function StrategyWinratePanel() {
  const { t } = useTranslation()
  const [days, setDays] = useState(7)
  const [data, setData] = useState<AdminStrategyWinRate | null>(null) // 跟随 days / follows the range picker
  const [recoData, setRecoData] = useState<AdminStrategyWinRate | null>(null) // 恒为 7 天 / always the last 7 days
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date())
  // 推荐卡点击后滚动到这里——详情区不管在渲染"全部策略"矩阵还是具体策略的
  // 品种页签，都是这同一个容器，点击不需要等它重新挂载。
  // Recommendation-card clicks scroll here — the detail area is this same
  // container whether it's showing the all-strategies matrix or a single
  // strategy's symbol tabs, so the click never has to wait on a remount.
  const detailRef = useRef<HTMLDivElement>(null)

  // 每分钟刷新一次时钟；时段轴与推荐区共用这一个 now（两个组件自己都不带计时
  // 器，就是为了在这里对齐——各转各的会在整分钟边界短暂不一致）。
  // Refresh the clock once a minute; the timeline and the recommendations
  // share this single `now` (neither component carries its own timer,
  // precisely so they stay aligned here instead of drifting apart at a
  // minute boundary).
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const applyError = (err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : 'Load failed')
    }
    const applyDone = () => {
      if (!cancelled) setLoading(false)
    }
    if (days === 7) {
      // 两份数据在这个窗口下同源：一次请求同时喂 data 与 recoData，不发第二个
      // 一模一样的请求。
      // The two datasets are the identical payload at this range: one request
      // feeds both data and recoData instead of firing a duplicate.
      adminApi
        .strategyWinrate(7)
        .then((res) => {
          // 慢请求返回时天数可能已经被改过——晚到的旧响应不能盖掉新的。
          // A slow response can land after the range changed; a stale reply
          // must not overwrite the current one.
          if (cancelled) return
          setData(res)
          setRecoData(res)
          setError(null)
        })
        .catch(applyError)
        .finally(applyDone)
    } else {
      // 推荐区固定 7 天窗口（产品决策），跟这里的 `days` 不同源，各拉各的。
      // Recommendations pin to a fixed 7-day window (a product decision) that
      // differs from `days` here, so each range fetches on its own.
      Promise.all([adminApi.strategyWinrate(days), adminApi.strategyWinrate(7)])
        .then(([primary, reco]) => {
          if (cancelled) return
          setData(primary)
          setRecoData(reco)
          setError(null)
        })
        .catch(applyError)
        .finally(applyDone)
    }
    return () => {
      cancelled = true
    }
  }, [days])

  // 当前活跃时段 key 列表，喂给 StrategyDetail 做高亮。优先用 recoData（固定
  // 7 天，和推荐区判"活跃"用的是同一份 sessions）兜底 data——两者的 sessions
  // 字段本就是同一套后端配置，谁先到手都行；`?? []` 只在两者都还没回来时生效。
  // Active-session keys fed to StrategyDetail for highlighting. Prefers
  // recoData (the fixed 7-day range RecommendationCards itself judges
  // "active" against) with data as a fallback — both carry the same backend
  // session config in `sessions`, so whichever arrives first is fine; the
  // `?? []` only matters before either has landed.
  const activeKeys =
    (recoData ?? data)?.sessions.filter((s) => sessionStatus(s, now).state === 'active').map((s) => s.key) ?? []

  const handleSelectFromReco = (name: string) => {
    setSelected(name)
    detailRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <div className="space-y-4">
      <div className="glass p-5">
        <h3 className="mb-1 font-display text-lg font-semibold text-neutral-100">{t('admin.winrate.title')}</h3>
        <p className="mb-4 text-xs leading-5 text-neutral-500">{t('admin.winrate.hint')}</p>

        {error && <p className="py-3 text-sm text-down">{error}</p>}

        {loading && !data ? (
          <div className="space-y-2">
            <SkeletonLine width="100%" />
            <SkeletonLine width="85%" />
            <SkeletonLine width="65%" />
          </div>
        ) : data && data.overall.total.samples === 0 ? (
          <p className="py-3 text-sm text-neutral-500">{t('admin.winrate.empty')}</p>
        ) : null}
      </div>

      {data && data.overall.total.samples > 0 && (
        <>
          <SessionTimeline sessions={data.sessions} now={now} />
          {recoData && <RecommendationCards data={recoData} now={now} onSelectStrategy={handleSelectFromReco} />}
          <div ref={detailRef}>
            {/* 天数切换器移到这里——紧挨着它实际影响的矩阵/详情，作用域即所见；
                推荐区固定 7 天不受它影响，已经在上方 hint 里说明过。
                The day-range switcher lives here — right beside the matrix/detail
                it actually scopes, so the scope is visible at a glance;
                recommendations stay pinned to 7 days regardless, already called
                out in the hint above. */}
            <div
              className="mb-2 flex flex-wrap justify-end gap-1.5"
              role="group"
              aria-label={t('admin.winrate.daysLabel')}
            >
              {DAY_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  aria-pressed={days === opt}
                  onClick={() => setDays(opt)}
                  className={`rounded-full px-3 py-1 text-xs transition ${
                    days === opt
                      ? 'bg-white/10 text-neutral-100 ring-1 ring-white/20'
                      : 'text-neutral-500 hover:text-neutral-300'
                  }`}
                >
                  {t('admin.winrate.daysOption', { days: opt })}
                </button>
              ))}
            </div>
            {/*，不是 days={days}：切换器点下去 `days` state 立刻更新，
                但新窗口请求若失败，`data` 仍停在旧窗口——这时 `days` 与 `data` 已经
                错位。`StrategyDetail` 会把 days 原样转给 `SignalList` 发起独立请求
                （聚合和明细是两个端点，一个失败不代表另一个也失败），用错位的
                `days` 请求会把"旧窗口的汇总"和"新窗口的明细"同时摆上屏幕，除顶部
                一行 error 外没有任何提示。`data.days` 是后端按实际生效的请求参数
                回填的字段，天然与 `data` 本身同源，用它就不会有这个错位窗口。, not days={days}: clicking the switcher updates the
                `days` state immediately, but if the new-window request fails, `data`
                stays on the old window — `days` and `data` are then out of sync.
                StrategyDetail forwards `days` verbatim to SignalList, which fires an
                independent request off it (the aggregate and detail endpoints are
                separate, so one failing doesn't mean the other does) — a mismatched
                `days` would put "old window's aggregate" and "new window's detail"
                on screen together with nothing but one error line at the top to
                explain it. `data.days` is the backend's echo of the parameter that
                actually produced `data`, so it can never drift from it. */}
            <StrategyDetail data={data} activeKeys={activeKeys} selected={selected}
                            onSelect={setSelected} now={now} />
          </div>
          <p className="px-1 text-[11px] leading-5 text-neutral-600">
            {t('admin.winrate.footnote', { min: MIN_SAMPLES })}
          </p>
        </>
      )}
    </div>
  )
}
