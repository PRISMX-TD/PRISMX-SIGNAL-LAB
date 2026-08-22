// 管理后台「策略胜率」子页——为新手重排的一版。
//
// 页面只回答三个问题，按读者会问的顺序排：
//   1. 平台信号准不准？        → 首屏一个大数字 + 人话判定 + 赢/输拔河条
//   2. 哪个策略、准在哪？      → 每个策略一张卡，点开看"哪个时段 / 做多做空 /
//                                 星期几 / 多久出结果"四个问题
//   3. 哪些品种在跑、跑得怎样？→ 每个品种一行
// 统计口径（Wilson 区间、时段重叠、判定门槛）不再作为图形摆在读者面前：判定
// 规则在 shared.ts 里只有一条，每个数字旁边都用一个词告诉读者"这个能不能信"，
// 计算细节收进页尾的折叠项。
//
// 不排名：策略还在调整期，按胜率排名是个会一直变的动态目标，而且胜率与赚不赚钱
// 并不同向。列表顺序是后端的"已判定笔数降序"，标题下直接写明。
//
// 时段窗口（小时区间 + IANA 时区）随接口一起下发，前端不复制一份：夏令时的正确
// 性只在后端保证一次，这里只负责把它翻译成看的人所在时区的钟点。
//
// The admin "strategy win rate" tab, re-laid-out for newcomers. It answers three
// questions in the order a reader asks them: are the signals any good (hero:
// one big number, a plain-words verdict, a wins-vs-losses tug bar); which
// strategy, and where is it good (one card each, expanding into four question
// blocks); which symbols are running and how (one row each). The statistics —
// Wilson intervals, session overlap, the sample floor — no longer face the reader
// as glyphs: shared.ts holds the single verdict rule, every number carries a
// word saying whether it can be trusted, and the maths folds into the footer.
// No ranking: the strategies are still being tuned, a win-rate order is a moving
// target, and win rate does not track profitability. Session windows ship with
// the payload; only the backend gets DST right.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../api/client'
import { SkeletonBlock, SkeletonLine } from '../Skeleton'
import type { AdminStrategyWinRate } from '../../api/types'
import { MIN_SAMPLES, sessionStatus } from './winrate/shared'
import HeroSummary from './winrate/HeroSummary'
import ReadingGuide from './winrate/ReadingGuide'
import StrategyList from './winrate/StrategyList'
import SymbolBoard from './winrate/SymbolBoard'

// 全站固定 7 天，不给切换器。滚动 168 小时 = 7×24，每个星期几正好各分到整
// 24 小时，「星期几更准」那一格才能直接比；14/30 天除不尽，格子会把"那天多出
// 24 小时"也编码进去。
// Pinned to 7 days, no picker: a rolling 168h window gives every weekday exactly
// 24 hours, which is what makes the weekday cells comparable. 14 or 30 days
// don't divide evenly and would encode the extra day as a real difference.
const WINDOW_DAYS = 7

function LoadingSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="glass p-6 md:p-8">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="space-y-4">
            <SkeletonLine width="60%" />
            <SkeletonBlock width={220} height={56} radius={8} />
            <SkeletonLine width="45%" />
            <SkeletonBlock height={12} radius={999} />
            <div className="grid grid-cols-3 gap-6 pt-2">
              <SkeletonLine height={28} /><SkeletonLine height={28} /><SkeletonLine height={28} />
            </div>
          </div>
          <div className="space-y-3">
            <SkeletonLine width="40%" /><SkeletonLine /><SkeletonLine /><SkeletonLine />
            <SkeletonBlock height={30} radius={6} />
          </div>
        </div>
      </div>
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="glass p-5 md:p-6">
            <div className="grid items-center gap-6 md:grid-cols-[1.1fr_1.7fr_0.8fr]">
              <SkeletonLine width="70%" height={16} />
              <SkeletonBlock height={8} radius={999} />
              <SkeletonBlock height={32} radius={4} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function EmptyState() {
  const { t } = useTranslation()
  return (
    <div className="glass animate-fade-in-up p-8 text-center md:p-12">
      <svg width="120" height="28" viewBox="0 0 120 28" className="mx-auto block" aria-hidden>
        <rect x="0" y="10" width="120" height="8" rx="4" fill="rgba(255,255,255,0.06)" />
        <line x1="60" y1="6" x2="60" y2="22" stroke="rgba(255,255,255,0.35)" strokeWidth="1" strokeDasharray="2 2" />
      </svg>
      <h3 className="mt-4 text-base font-semibold text-neutral-100">{t('admin.winrate.empty.title', { days: WINDOW_DAYS })}</h3>
      <p className="mx-auto mt-2 max-w-[46ch] text-sm leading-relaxed text-neutral-500">{t('admin.winrate.empty.body')}</p>
    </div>
  )
}

export default function StrategyWinratePanel() {
  const { t } = useTranslation()
  const [data, setData] = useState<AdminStrategyWinRate | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [attempt, setAttempt] = useState(0)

  // 每分钟刷新一次时钟；时段状态与"进行中"标记共用这一个 now，各子组件都不
  // 自带计时器。/ One clock per minute, shared by every child; none keeps its own.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
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
  }, [attempt])

  const activeKeys =
    data?.sessions.filter((s) => sessionStatus(s, now).state === 'active').map((s) => s.key) ?? []
  const empty = data !== null && data.overall.total.samples === 0

  return (
    <div className="space-y-6">
      <header className="px-1">
        <h2 className="font-display text-xl font-semibold text-neutral-100">{t('admin.winrate.title')}</h2>
        <p className="mt-1 text-sm text-neutral-500">{t('admin.winrate.subtitle', { days: WINDOW_DAYS })}</p>
      </header>

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm"
             style={{ background: 'var(--down-bg)', color: 'var(--down)' }} role="alert">
          <span>{t('admin.winrate.error', { message: error })}</span>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}
                  className="rounded-full border border-current px-3 py-1 text-xs transition active:scale-[0.97]">
            {t('admin.winrate.retry')}
          </button>
        </div>
      )}

      {loading && !data ? (
        <LoadingSkeleton />
      ) : empty ? (
        <EmptyState />
      ) : data ? (
        <>
          <HeroSummary data={data} now={now} />
          <ReadingGuide />

          <section>
            <header className="mb-3 px-1">
              <h2 className="text-lg font-semibold text-neutral-100">{t('admin.winrate.strategies.title')}</h2>
              <p className="mt-1 text-xs text-neutral-500">{t('admin.winrate.strategies.caption')}</p>
            </header>
            <StrategyList data={data} selected={selected} onSelect={setSelected} activeKeys={activeKeys} />
          </section>

          <SymbolBoard data={data} />

          {/* 口径说明收进折叠项：第一次看有用，第一百次看是噪音。
              The methodology folds away: useful once, noise the hundredth time. */}
          <details className="group px-1">
            <summary className="cursor-pointer list-none text-xs text-neutral-500 transition hover:text-neutral-300">
              {t('admin.winrate.method.toggle')}
              <span className="ml-1 inline-block transition group-open:rotate-90">›</span>
            </summary>
            <p className="mt-2 max-w-[72ch] text-xs leading-5 text-neutral-500">
              {t('admin.winrate.method.body', { min: MIN_SAMPLES })}
            </p>
          </details>
        </>
      ) : null}
    </div>
  )
}
