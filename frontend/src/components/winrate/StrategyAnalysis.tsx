// 「策略分析」：信号面板的第三个页签，FREE 与 PRO 同样可见、不延迟。
//
// 三段，自上而下，全部默认展开：
//   ①「现在该盯什么」——现在是哪个盘、还剩多久、这个盘里胜率最高的几个钟点、
//      可以留意的品种、下一个盘还有多久开
//   ②「每个策略」——一张卡给出该策略胜率最高的钟点与品种；点开看
//      时段 / 做多做空 / 一天里哪个小时
//   ③「每个品种」——跨全部策略合并
//
// **只显示管理员公开名单里的策略**，且过滤发生在后端取数层：时段胜率、品种胜率
// 的分母都跟着变（见 signals.py 的 strategy_analysis）。名单默认为空，所以这个
// 页签上线后的**默认状态就是空态**——空态因此不是边角情况，是最常见的一屏。
//
// 判定只由颜色承担：51% 起绿、40–50% 橙、40% 以下红（shared.ts 的 verdictOf，
// 全页只有那一条规则）。绿色不等于"统计上站得住"，只等于"到目前为止 51% 以上"。
//
// The "strategy analysis" tab on the signals page, visible to FREE and PRO alike
// with no delay. Three sections, all expanded: what to watch now, each strategy,
// each symbol. **Only whitelisted strategies appear**, filtered server-side at
// the fetch so denominators move with the whitelist. That list defaults to empty,
// which makes the empty state this tab's **default** rather than an edge case.
// The verdict is carried by colour alone (verdictOf in shared.ts).
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { signalApi } from '../../api/client'
import { SkeletonBlock, SkeletonLine } from '../Skeleton'
import type { AdminStrategyWinRate } from '../../api/types'
import { sessionStatus } from './shared'
import WatchNow from './WatchNow'
import StrategyList from './StrategyList'
import SymbolBoard from './SymbolBoard'

function LoadingSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
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

/** 空态。**这是这个页签上线后的默认状态**（公开名单默认为空），所以措辞不能是
 *  "出错了"或"暂无数据"——要让读者明白这是还没开放，不是坏了。
 *  The empty state. **This is the tab's default after ship** (the whitelist starts
 *  empty), so the wording must read as "not published yet", never as an error or
 *  a glitch. */
function EmptyState() {
  const { t } = useTranslation()
  return (
    <div className="glass animate-fade-in-up p-8 text-center md:p-12">
      <svg width="120" height="28" viewBox="0 0 120 28" className="mx-auto block" aria-hidden>
        <rect x="0" y="10" width="120" height="8" rx="4" fill="rgba(255,255,255,0.06)" />
        <line x1="60" y1="6" x2="60" y2="22" stroke="rgba(255,255,255,0.35)" strokeWidth="1" strokeDasharray="2 2" />
      </svg>
      <h3 className="mt-4 text-base font-semibold text-neutral-100">{t('signals.analysis.empty.title')}</h3>
      <p className="mx-auto mt-2 max-w-[46ch] text-sm leading-relaxed text-neutral-500">
        {t('signals.analysis.empty.body')}
      </p>
    </div>
  )
}

export default function StrategyAnalysis() {
  const { t } = useTranslation()
  const [data, setData] = useState<AdminStrategyWinRate | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => new Date())
  const [attempt, setAttempt] = useState(0)
  // 手风琴：一次只开一张卡，与管理页原本的行为一致。
  // Accordion state: one card open at a time, as on the admin page before.
  const [selected, setSelected] = useState<string | null>(null)

  // 每分钟刷新一次时钟；时段状态、倒计时、钟点换算共用这一个 now，子组件都不
  // 自带计时器——两个时钟会在整分钟边界短暂不一致。
  // One clock per minute shared by every child; none keeps its own, or the two
  // would disagree briefly at each minute boundary.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    signalApi
      .strategyAnalysis()
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

  // 当前进行中的时段，喂给展开层给时段行打「进行中」标记。
  // Sessions currently open, feeding the detail rows' "open now" tag.
  const activeKeys =
    data?.sessions.filter((s) => sessionStatus(s, now).state === 'active').map((s) => s.key) ?? []
  const empty = data !== null && data.overall.total.samples === 0

  return (
    <div className="space-y-6">
      <header className="px-1">
        <h2 className="font-display text-xl font-semibold text-neutral-100">{t('signals.analysis.title')}</h2>
        <p className="mt-1 text-sm text-neutral-500">
          {t('signals.analysis.subtitle', { days: data?.days ?? 30 })}
        </p>
      </header>

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg px-4 py-3 text-sm"
             style={{ background: 'var(--down-bg)', color: 'var(--down)' }} role="alert">
          <span>{t('signals.analysis.error', { message: error })}</span>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}
                  className="rounded-full border border-current px-3 py-1 text-xs transition active:scale-[0.97]">
            {t('signals.analysis.retry')}
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
              <h3 className="text-lg font-semibold text-neutral-100">{t('admin.winrate.strategies.title')}</h3>
              <p className="mt-1 text-xs text-neutral-500">{t('admin.winrate.strategies.caption')}</p>
            </header>
            <StrategyList data={data} selected={selected} onSelect={setSelected}
                          activeKeys={activeKeys} now={now} />
          </section>

          <SymbolBoard data={data} />
        </>
      ) : null}
    </div>
  )
}
