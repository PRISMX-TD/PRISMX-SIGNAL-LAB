// 管理后台「策略胜率」子页——为新手重排的一版，两层。
//
// 第一层（默认只有这一层）：「现在该盯什么」——现在是哪个盘、这个盘近 N 天准不准、
// 这个盘里哪些品种可以留意、下一个盘几点开。这是产品的本意：一眼看出
// "什么时候值得注意、注意哪些品种"，先在管理页内测，之后再决定是否开放给用户。
// 第二层（点「看细节」才展开）按读者会问的顺序排：
//   1. 哪个策略、准在哪？      → 每个策略一张卡，点开看"哪个时段 / 做多做空 /
//                                 星期几 / 多久出结果"四个问题
//   2. 哪些品种在跑、跑得怎样？→ 每个品种一行
// 「平台整体胜率」那张卡已按产品要求整张删除：一个把所有策略、所有品种、所有
// 时段混在一起的平均数不指导任何决定——它既不告诉你该盯什么，也不代表任何一个
// 你实际会跟的策略。要看得分策略、分品种地看，那正是下面两层在做的事。
// 统计口径（Wilson 区间、时段重叠、判定门槛）不再作为图形摆在读者面前：判定
// 规则在 shared.ts 里只有一条，每个数字旁边都用一个词告诉读者"这个能不能信"，
// 计算细节收进页尾的折叠项。
// 那条逐枚解释判定芯片的「怎么读」图例行也已按产品要求删除：芯片上的词本身
// 就是人话（「明显高于一半」「还看不出高低」），再给一行解释是解释解释。星期格
// 内部那份小图例保留——那里只有色块和图形，没有词。
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
// (behind "details") answers two questions in the order a reader asks them:
// which strategy, and where is it good (one card each, expanding into four
// question blocks); which symbols are running and how (one row each). The
// platform-wide "overall win rate" card was deleted outright at the product
// owner's request: an average over every strategy, symbol and session guides no
// decision — it neither says what to watch nor describes any strategy anyone
// actually follows. The two layers below answer it per strategy and per symbol,
// which is the only form of the question worth asking. The statistics —
// Wilson intervals, session overlap, the sample floor — no longer face the reader
// as glyphs: shared.ts holds the single verdict rule, every number carries a
// word saying whether it can be trusted, and the maths folds into the footer.
// The legend row that explained each verdict chip was dropped at the product
// owner's request: the chip's own wording is already plain language, so a row
// explaining it explains the explanation. The small legend inside the weekday
// grid stays — there the cells carry only colour and a glyph, no words.
// No ranking: the strategies are still being tuned, a win-rate order is a moving
// target, and win rate does not track profitability. Session windows ship with
// the payload; only the backend gets DST right.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../api/client'
import { SkeletonBlock, SkeletonLine } from '../Skeleton'
import type { AdminStrategyWinRate } from '../../api/types'
import { MIN_SAMPLES, sessionStatus } from './winrate/shared'
import WatchNow from './winrate/WatchNow'
import StrategyList from './winrate/StrategyList'
import SymbolBoard from './winrate/SymbolBoard'

// 固定 30 天，不给切换器。第一层要在「时段 × 品种」这一格上给出"明显更准"，
// 7 天切到这个粒度后大多数格子都是"还看不出"，第一层会经常空着；30 天才有足够
// 笔数。原来钉在 7 天是为了星期格可比（168 小时 = 每个星期几整 24 小时），但那
// 个顾虑针对的是**笔数**——现在星期格显示的是胜率，某个星期几多摊到一天只是
// 样本多一点，比率本身不受影响，所以放开。
// Pinned to 30 days, no picker. Layer one has to call a session × symbol cell
// "clearly better"; at 7 days most such cells read "can't tell" and the layer
// sits empty, 30 days gives them enough trades. The old 7-day pin existed for
// weekday comparability (168h = exactly 24h per weekday), but that concern was
// about **counts** — the weekday cells now show rates, and a weekday drawing one
// extra day only means a slightly larger sample, not a biased rate.
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
  // 细节层默认收起：产品本意是"一眼看出该盯什么，要看细节再展开"。
  // Details fold by default: the intent is "see what to watch at a glance, expand for more".
  const [showDetails, setShowDetails] = useState(false)

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

          <div className="px-1">
            <button type="button" aria-expanded={showDetails} onClick={() => setShowDetails((v) => !v)}
                    className="btn-ghost inline-flex items-center gap-2 px-5 py-2 text-sm">
              {showDetails ? t('admin.winrate.details.hide') : t('admin.winrate.details.show')}
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden
                   className={`transition-transform duration-300 ${showDetails ? 'rotate-180' : ''}`}>
                <path d="m4 6 4 4 4-4" />
              </svg>
            </button>
          </div>

          {showDetails && (<>
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
              {t('admin.winrate.method.body', { min: MIN_SAMPLES, days: WINDOW_DAYS })}
            </p>
          </details>
          </>)}
        </>
      ) : null}
    </div>
  )
}
