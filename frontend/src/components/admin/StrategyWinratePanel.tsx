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

// 全站固定 7 天，不给切换器。
//
// 7 天不是随手定的：滚动 168 小时窗口 = 7×24，**每个星期几正好各分到整 24 小时**，
// 所以「星期 × 方向」矩阵的格子之间可以直接比。换成 14/30 天就不成立了——30 天
// 是 4.28 周，除不尽，有的星期几会多摊到一整天，格子里的数字就把"那天多出 24
// 小时"也编码了进去，读的人会当成真实差异。
//
// 顺带消掉了原来"推荐区固定 7 天、矩阵跟随切换器"的双窗口复杂度：两份数据、
// 两次请求、以及 days state 与 data 可能错位那一类问题，一并没有了。
//
// The whole page is pinned to 7 days; no range picker.
//
// Not an arbitrary 7: a rolling 168-hour window is exactly 7x24, so **every
// weekday draws exactly 24 hours**, which is what makes the weekday x direction
// matrix's cells comparable. At 14 or 30 days it breaks down — 30 days is 4.28
// weeks, so some weekdays get a whole extra day and the numbers would encode
// that alongside any real difference.
//
// It also removes the old two-window complexity (recommendations pinned to 7
// days while the matrix followed a picker): two payloads, two requests, and the
// class of bug where the `days` state and `data` drift apart — all gone.
const WINDOW_DAYS = 7

export default function StrategyWinratePanel() {
  const { t } = useTranslation()
  const [data, setData] = useState<AdminStrategyWinRate | null>(null)
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
    adminApi
      .strategyWinrate(WINDOW_DAYS)
      .then((res) => {
        if (!cancelled) {
          setData(res)
          setError(null)
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Load failed')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 当前活跃时段 key 列表，喂给 StrategyDetail 做高亮。优先用 recoData（固定
  // 7 天，和推荐区判"活跃"用的是同一份 sessions）兜底 data——两者的 sessions
  // 字段本就是同一套后端配置，谁先到手都行；`?? []` 只在两者都还没回来时生效。
  // Active-session keys fed to StrategyDetail for highlighting. Prefers
  // recoData (the fixed 7-day range RecommendationCards itself judges
  // "active" against) with data as a fallback — both carry the same backend
  // session config in `sessions`, so whichever arrives first is fine; the
  // `?? []` only matters before either has landed.
  const activeKeys =
    data?.sessions.filter((s) => sessionStatus(s, now).state === 'active').map((s) => s.key) ?? []

  const handleSelectFromReco = (name: string) => {
    setSelected(name)
    detailRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <div className="space-y-4">
      <div className="glass p-5">
        <h3 className="mb-1 font-display text-lg font-semibold text-neutral-100">{t('admin.winrate.title')}</h3>
        {/* 口径说明收进折叠项：第一次看有用，第一百次看是噪音，而它原本占了整个
            卡片、把决策页的顶部变成一段文档。默认收起，需要时展开。
            The methodology note is collapsed: useful the first time, noise the
            hundredth, and it previously filled the whole card — turning the top
            of a decision page into documentation. Collapsed by default. */}
        <details className="mb-4 group">
          <summary className="cursor-pointer list-none text-[11px] text-neutral-500 transition hover:text-neutral-300">
            {t('admin.winrate.hintToggle')}
            <span className="ml-1 inline-block transition group-open:rotate-90">›</span>
          </summary>
          <p className="mt-2 text-xs leading-5 text-neutral-500">{t('admin.winrate.hint')}</p>
        </details>

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
          {<RecommendationCards data={data} now={now} onSelectStrategy={handleSelectFromReco} />}
          <div ref={detailRef}>
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
