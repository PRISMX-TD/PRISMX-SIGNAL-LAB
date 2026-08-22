// 每个策略一张卡，点开在原位展开细节（手风琴，一次只开一张）。
//
// 顺序沿用后端的"已判定笔数降序"，**不是按胜率排名**——策略还在调整期，排名
// 是个会一直变的动态目标，而且胜率高不等于更赚钱（盈亏比差三倍时，胜率最低
// 的策略可能期望最高）。列表标题下面直接把这句话写给读者。
//
// 卡片首行只放三样东西：名字、大数字 + 判定、拔河条；右侧是窗口内每天的信号
// 量柱——"这策略最近活不活跃"是新手除了准不准之外第二想知道的事。
//
// One card per strategy; clicking expands the detail in place (accordion, one
// open at a time). Order is the backend's resolved-count-desc — NOT a win-rate
// ranking: the strategies are still being tuned, a ranking is a moving target,
// and a higher win rate does not mean more money (with reward:risk spanning 3x,
// the lowest win rate can carry the highest expectancy). The list caption says
// so directly. The card's first row carries only the name, the big number with
// its verdict, and the tug bar; on the right, the window's daily signal volume —
// "is this strategy active lately" is the second thing a newcomer asks.
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdminStrategyWinRate, StrategyWinRate } from '../../../api/types'
import StrategyDetail from './StrategyDetail'
import TugBar from './TugBar'
import { VerdictChip } from './Verdict'
import { VERDICT_COLOR, fmtDurationText, fmtInt, fmtPct, isRated, verdictOf } from './shared'

// 全部用 <span>：它住在卡片的 <button> 里，按钮内只允许短语内容。
// Spans only: this lives inside the card's <button>, which allows phrasing content only.
function ActivityBars({ daily }: { daily: number[] }) {
  const { t } = useTranslation()
  const max = Math.max(1, ...daily)
  const total = daily.reduce((a, b) => a + b, 0)
  return (
    <span className="block">
      <span className="flex h-8 items-end gap-[2px]" role="img"
            aria-label={t('admin.winrate.strategies.activityAria', { count: total, days: daily.length })}>
        {daily.map((v, i) => (
          <span
            key={i}
            className={`flex-1 rounded-sm ${i === daily.length - 1 ? 'bg-prism-400/70' : 'bg-neutral-500/35'}`}
            style={{ height: `${Math.max(8, (v / max) * 100)}%` }}
            title={t('admin.winrate.strategies.dayTitle', { day: i + 1, count: v })}
          />
        ))}
      </span>
      <span className="mt-1 block text-2xs tabular-nums text-neutral-500">
        {t('admin.winrate.strategies.activity', { days: daily.length })} · {t('admin.winrate.strategies.activityTotal', { count: total, n: fmtInt(total) })}
      </span>
    </span>
  )
}

function StrategyCard({ row, index, open, onToggle, data, activeKeys }: {
  row: StrategyWinRate
  index: number
  open: boolean
  onToggle: () => void
  data: AdminStrategyWinRate
  activeKeys: string[]
}) {
  const { t } = useTranslation()
  const id = useId()
  // 打开过一次就保持挂载，收起时才有高度可以动画 / stay mounted after the
  // first open so collapsing has a height to animate from
  const [mounted, setMounted] = useState(open)
  useEffect(() => { if (open) setMounted(true) }, [open])

  const total = row.total
  const kind = verdictOf(total)
  const hasRate = isRated(kind) && total.winRate !== null
  const name = row.strategy || t('admin.winrate.strategies.unnamed')
  const facts: string[] = []
  if (total.avgResolveSeconds !== null) facts.push(t('admin.winrate.strategies.holding', { time: fmtDurationText(t, total.avgResolveSeconds) }))
  if (total.pending > 0) facts.push(t('admin.winrate.strategies.pending', { count: total.pending }))
  if (total.stale > 0) facts.push(t('admin.winrate.strategies.stale', { count: total.stale }))
  const tugLabel = t('admin.winrate.aria.tug', {
    label: name, tp: total.hitTp, sl: total.hitSl, rate: hasRate ? fmtPct(total.winRate!) : '—',
  })

  return (
    <article
      aria-label={name}
      className={`glass animate-fade-in-up overflow-hidden ${open ? 'ring-1 ring-prism-400/40' : ''}`}
      style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}
    >
      {/* 按钮内只放 <span>（短语内容），不嵌 h3/div/p——那是非法嵌套。
          Only <span>s inside the button; h3/div/p there would be invalid nesting. */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={onToggle}
        // 键盘焦点环画在按钮内侧：全站默认是 outline-offset 2px，而这个按钮填满
        // 卡片，外侧的环会被 article 的 overflow-hidden 裁掉、完全看不见。内缩 3px
        // 并跟随卡片圆角，四角才不会被裁。
        // Focus ring drawn inside the button: the site default is a 2px outside
        // offset, but this button fills the card and an outside ring is clipped
        // by the article's overflow-hidden. Inset 3px and follow the card radius
        // so the corners survive too.
        className="grid w-full items-center gap-x-6 gap-y-4 p-5 text-left transition active:scale-[0.995] focus-visible:rounded-[22px] focus-visible:outline-offset-[-3px] md:grid-cols-[minmax(0,1.1fr)_minmax(0,1.7fr)_minmax(0,0.8fr)_auto] md:p-6"
      >
        <span className="block min-w-0">
          <span className="block truncate text-base font-semibold text-neutral-100">{name}</span>
          {facts.length > 0 && (
            <span className="mt-1 block text-xs tabular-nums text-neutral-500">{facts.join(' · ')}</span>
          )}
        </span>

        <span className="block min-w-0">
          <span className="flex items-baseline justify-between gap-3">
            <span className="font-display text-2xl font-bold leading-none tabular-nums"
                  style={{ color: VERDICT_COLOR[kind] }}>
              {hasRate ? fmtPct(total.winRate!) : '—'}
            </span>
            <VerdictChip kind={kind} bucket={total} size="sm" />
          </span>
          <TugBar className="mt-2.5" size="md" hitTp={total.hitTp} hitSl={total.hitSl} label={tugLabel} />
          <span className="mt-1.5 block text-2xs tabular-nums text-neutral-500">
            {t('admin.winrate.strategies.winsLosses', { tp: fmtInt(total.hitTp), sl: fmtInt(total.hitSl) })}
          </span>
        </span>

        <span className="hidden md:block">{total.daily && <ActivityBars daily={total.daily} />}</span>

        <span className="flex items-center gap-1.5 text-xs text-neutral-500 md:justify-self-end">
          <span className="md:hidden">{open ? t('admin.winrate.strategies.collapse') : t('admin.winrate.strategies.expand')}</span>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
               strokeLinecap="round" strokeLinejoin="round" aria-hidden
               className={`transition-transform duration-300 ${open ? 'rotate-180' : ''}`}>
            <path d="m4 6 4 4 4-4" />
          </svg>
        </span>
      </button>

      {/* 0fr → 1fr 的栅格行高过渡：不动 height，也不用测量内容。
          The 0fr → 1fr grid-row transition: no height animation, no measuring. */}
      <div
        id={id}
        className="grid transition-[grid-template-rows] duration-[450ms] ease-[var(--ease-out)]"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        {/* 收起后 visibility:hidden（延迟到折叠动画结束）：0fr 只是看不见，里面的
            品种页签仍会被 Tab 键聚焦、仍暴露给读屏器。展开时延迟为 0，内容立刻可达。
            Collapsed → visibility:hidden, delayed until the collapse animation
            ends: 0fr only hides visually, leaving the symbol tabs focusable and
            exposed to AT. On expand the delay is 0 so content is reachable at once. */}
        <div
          className="min-h-0 overflow-hidden"
          style={{ visibility: open ? 'visible' : 'hidden', transition: `visibility 0s linear ${open ? 0 : 450}ms` }}
        >
          {mounted && <StrategyDetail row={row} sessions={data.sessions} activeKeys={activeKeys} days={data.days} />}
        </div>
      </div>
    </article>
  )
}

export default function StrategyList({ data, selected, onSelect, activeKeys }: {
  data: AdminStrategyWinRate
  selected: string | null
  onSelect: (name: string | null) => void
  activeKeys: string[]
}) {
  return (
    <div className="space-y-3">
      {data.strategies.map((row, i) => (
        <StrategyCard
          key={row.strategy}
          row={row}
          index={i}
          open={selected === row.strategy}
          onToggle={() => onSelect(selected === row.strategy ? null : row.strategy)}
          data={data}
          activeKeys={activeKeys}
        />
      ))}
    </div>
  )
}
