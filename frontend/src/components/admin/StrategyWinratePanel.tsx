// 管理后台「策略胜率」子页——为新手重排的一版，两层。
//
// 第一层（默认只有这一层）：「现在该盯什么」——现在是哪个盘、这个盘近 N 天准不准、
// 这个盘里哪些品种可以留意、下一个盘几点开。这是产品的本意：一眼看出
// "什么时候值得注意、注意哪些品种"，先在管理页内测，之后再决定是否开放给用户。
// 第二层（默认就展开，没有总开关）按读者会问的顺序排：
//   1. 哪个策略、准在哪？      → 每个策略一张卡，卡上直接给「胜率最高的时间 /
//                                 品种」，点开再看"哪个时段 / 做多还是做空 /
//                                 一天里哪个小时"三块细节
//   2. 哪些品种在跑、跑得怎样？→ 每个品种一行
//
// 以下都是产品逐轮明确要求删掉的，不要再加回来：「平台整体胜率」卡、策略卡上的
// 整体胜率与拔河条与信号量柱、所有写着判定的芯片、↑↓=? 图形、「怎么读」图例行、
// 笔数、「一般多久出结果」块、「星期几更准」（换成钟点）、「看细节」总开关、
// 页尾那段口径说明。
//
// 判定现在**只由颜色承担**：胜率过半绿、没过半红、正好一半灰（规则见 shared.ts
// 的 verdictOf，全页只有那一条，不再用 Wilson 区间把关显示）。绿色不等于"统计上
// 站得住"，只等于"到目前为止过半"——明确的取舍，笔数会随时间自己攒起来。
// 界面上没有任何文字解释这套颜色：读屏器那一路靠钟点格的 sr-only 与 RateChip 的
// aria-label 兜住，视觉上的色弱用户目前没有替代手段，开放给用户前需要重新评估。
//
// 不排名：策略还在调整期，按胜率排名是个会一直变的动态目标，而且胜率与赚不赚钱
// 并不同向。列表顺序是后端的"已判定笔数降序"，标题下直接写明。
//
// 时段窗口（小时区间 + IANA 时区）随接口一起下发，前端不复制一份：夏令时的正确
// 性只在后端保证一次，这里只负责把它翻译成看的人所在时区的钟点。
//
// The admin "strategy win rate" tab, re-laid-out for newcomers, in two layers.
// Layer one (all that shows by default) is "what to watch now": which session
// is open, how it did over the last N days, which symbols in it are worth a
// look, and when the next session opens — the product's actual intent, piloted
// on the admin page before deciding whether to expose it to users. Layer two
// (always expanded; there is no master toggle) answers two questions in the
// order a reader asks them: which strategy, and where is it good (one card each,
// stating its best hours and symbols up front and expanding into three detail
// blocks — which session / long or short / which hour of the day); which symbols
// are running and how (one row each).
//
// Everything below was deleted round by round at the product owner's request and
// should not come back: the platform-wide "overall win rate" card; the strategy
// card's aggregate rate, tug bar and volume sparkline; every worded verdict chip;
// the arrow glyphs; the legend row; trade counts; the time-to-resolution block;
// the weekday grid (now hours); the master "details" toggle; and the methodology
// note that used to sit in the footer.
//
// The verdict is now carried **by colour alone**: above half green, below red, an
// exact tie grey (one rule, verdictOf in shared.ts; the Wilson interval no longer
// gates display). Green does not mean "statistically established", only "above
// half so far" — a deliberate trade-off, on the basis that counts accumulate.
// Nothing on screen explains the scheme: screen readers get it from the hour
// cells' sr-only text and RateChip's aria-label, but a colour-blind sighted
// reader has no alternative — worth revisiting before this reaches users.
// No ranking: the strategies are still being tuned, a win-rate order is a moving
// target, and win rate does not track profitability. Session windows ship with
// the payload; only the backend gets DST right.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../api/client'
import { SkeletonBlock, SkeletonLine } from '../Skeleton'
import type { AdminStrategyWinRate } from '../../api/types'
import { sessionStatus } from './winrate/shared'
import WatchNow from './winrate/WatchNow'
import StrategyList from './winrate/StrategyList'
import SymbolBoard from './winrate/SymbolBoard'

// 固定 30 天，不给切换器。窗口要同时喂两处最细的切分：第一层的「时段 × 品种」，
// 以及详情里的 24 个钟点格。7 天切到这个粒度后大多数格子都是"还看不出"——一天
// 只贡献一条样本，24 格里每格才 7 条；30 天把每格抬到 30 条上下，才谈得上比较。
// 原来钉在 7 天是为了星期格可比（168 小时 = 每个星期几整 24 小时），星期格已经
// 换成钟点格，而钟点在任何长度的窗口里都均匀分布，那个约束自然消失。
// Pinned to 30 days, no picker. The window feeds the two finest slices on the
// page: layer one's session × symbol cells and the detail's 24 hour cells. At 7
// days most of those read "can't tell" — a day contributes one sample per hour
// slot, so 24 slots hold 7 trades each; 30 days lifts them to roughly 30, which
// is where comparison starts to mean something. The old 7-day pin existed for
// weekday comparability (168h = exactly 24h per weekday); the weekday grid is
// now an hour grid, and clock hours spread evenly over a window of any length,
// so that constraint is simply gone.
const WINDOW_DAYS = 30

function LoadingSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      {/* 形状照着 WatchNow 排：骨架屏骗人比没有骨架屏更糟——加载完内容跳一下，
          读者会以为页面出错了。/ Shaped after WatchNow: a skeleton that lies about
          the layout is worse than none, since the content visibly jumps on arrival. */}
      <div className="glass p-6 md:p-8">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="space-y-4">
            <SkeletonLine width="30%" height={10} />
            <SkeletonLine width="45%" height={22} />
            <SkeletonLine width="60%" />
            <div className="flex gap-2 pt-1">
              <SkeletonBlock width={150} height={32} radius={999} />
              <SkeletonBlock width={150} height={32} radius={999} />
              <SkeletonBlock width={150} height={32} radius={999} />
            </div>
            <SkeletonLine width="70%" />
          </div>
          <div className="space-y-3">
            <SkeletonLine width="40%" height={10} />
            <SkeletonLine /><SkeletonLine /><SkeletonLine />
            <SkeletonBlock height={30} radius={6} />
          </div>
        </div>
      </div>
      {/* 策略卡的骨架：名字 + 两组芯片 + 展开箭头，与 StrategyList 的栅格同形。
          骨架屏骗人比没有骨架屏更糟——加载完内容跳一下，读者会以为页面出错了。
          Strategy-card skeleton: name, two chip groups, chevron — the same grid as
          StrategyList. A skeleton that lies about the layout is worse than none,
          since the content visibly jumps on arrival. */}
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="glass p-5 md:p-6">
            <div className="grid items-center gap-x-6 gap-y-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_auto]">
              <SkeletonLine width="70%" height={16} />
              <div className="flex gap-1.5">
                <SkeletonBlock width={92} height={26} radius={999} />
                <SkeletonBlock width={92} height={26} radius={999} />
              </div>
              <div className="flex gap-1.5">
                <SkeletonBlock width={104} height={26} radius={999} />
                <SkeletonBlock width={104} height={26} radius={999} />
              </div>
              <SkeletonBlock width={16} height={16} radius={4} />
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
          <WatchNow data={data} now={now} />

          <section>
            <header className="mb-3 px-1">
              <h2 className="text-lg font-semibold text-neutral-100">{t('admin.winrate.strategies.title')}</h2>
              <p className="mt-1 text-xs text-neutral-500">{t('admin.winrate.strategies.caption')}</p>
            </header>
            <StrategyList data={data} selected={selected} onSelect={setSelected} activeKeys={activeKeys} now={now} />
          </section>

          <SymbolBoard data={data} />
        </>
      ) : null}
    </div>
  )
}
