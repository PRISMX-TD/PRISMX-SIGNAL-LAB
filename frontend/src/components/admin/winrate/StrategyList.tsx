// 每个策略一张卡，点开在原位展开细节（手风琴，一次只开一张）。
//
// 顺序沿用后端的"已判定笔数降序"，**不是按胜率排名**——策略还在调整期，排名
// 是个会一直变的动态目标，而且胜率高不等于更赚钱（盈亏比差三倍时，胜率最低
// 的策略可能期望最高）。列表标题下面直接把这句话写给读者。
//
// 卡片首行不再放整体胜率、拔河条和信号量柱（产品要求），改为直接回答两个问题：
// **这个策略在一天里的哪几个钟点胜率最高、在哪几个品种上胜率最高**。一个混合了
// 所有钟点和所有品种的平均数不指导任何操作，而这两组芯片就是操作本身。
//
// One card per strategy; clicking expands the detail in place (accordion, one
// open at a time). Order is the backend's resolved-count-desc — NOT a win-rate
// ranking: the strategies are still being tuned, a ranking is a moving target,
// and a higher win rate does not mean more money (with reward:risk spanning 3x,
// the lowest win rate can carry the highest expectancy). The list caption says
// so directly. The card's first row no longer carries the aggregate rate, the tug
// bar or the volume sparkline (product decision); it answers two questions
// instead: **which hours of the day this strategy is most accurate in, and which
// symbols it is most accurate on**. An average blended across every hour and every
// symbol guides no action; those two chip groups are the action.
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdminStrategyWinRate, StrategyWinRate } from '../../../api/types'
import RateChip from './RateChip'
import StrategyDetail from './StrategyDetail'
import { fmtClock, fmtDurationText, fmtPct, rankBuckets, rankHours } from './shared'

const TOP_PER_CARD = 3

// 全部用 <span>：它住在卡片的 <button> 里，按钮内只允许短语内容。
// Spans only: this lives inside the card's <button>, which allows phrasing content only.
function ChipGroup({ label, chips, empty }: {
  label: string; chips: React.ReactNode; empty: boolean
}) {
  const { t } = useTranslation()
  return (
    <span className="block min-w-0">
      <span className="block text-2xs uppercase tracking-wider text-neutral-500">{label}</span>
      {empty ? (
        <span className="mt-1.5 block text-sm text-neutral-600">{t('admin.winrate.strategies.tooThin')}</span>
      ) : (
        <span className="mt-1.5 flex flex-wrap gap-1.5">{chips}</span>
      )}
    </span>
  )
}

function StrategyCard({ row, index, open, onToggle, data, activeKeys, now }: {
  row: StrategyWinRate
  index: number
  open: boolean
  onToggle: () => void
  data: AdminStrategyWinRate
  activeKeys: string[]
  // 透传给钟点格做本地时区换算 / forwarded to the hour cells for zone conversion
  now: Date
}) {
  const { t } = useTranslation()
  const id = useId()
  // 打开过一次就保持挂载，收起时才有高度可以动画 / stay mounted after the
  // first open so collapsing has a height to animate from
  const [mounted, setMounted] = useState(open)
  useEffect(() => { if (open) setMounted(true) }, [open])

  const total = row.total
  const name = row.strategy || t('admin.winrate.strategies.unnamed')
  const facts: string[] = []
  if (total.avgResolveSeconds !== null) facts.push(t('admin.winrate.strategies.holding', { time: fmtDurationText(t, total.avgResolveSeconds) }))

  // 卡片上不给整体胜率、拔河条和信号量柱（产品要求），换成这个策略近 N 天最好的
  // 几个钟点和品种——"这个策略什么时候、在什么品种上准"比一个混合平均数有用。
  // **这里不设 0.5 下限**（顶层的「可以留意」有）：标题是"胜率最高的"，在描述这个
  // 策略本身，最好的一个只有 45% 也是实情，红色会如实说出来。
  // The card drops the aggregate rate, tug bar and volume sparkline (product
  // decision) for this strategy's best hours and symbols — "when and on what is
  // this strategy accurate" beats one blended average. **No 0.5 floor here** (the
  // top layer's "worth a look" has one): these headings describe the strategy, so
  // if its best is 45% that is the fact, and red says so.
  const bestHours = rankHours(row.total.hourly, now, { limit: TOP_PER_CARD })
  const bestSymbols = rankBuckets(
    row.symbols.map((s) => ({ name: s.symbol, bucket: s.total })),
    { limit: TOP_PER_CARD },
  )

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
        className="grid w-full items-center gap-x-6 gap-y-4 p-5 text-left transition active:scale-[0.995] focus-visible:rounded-[22px] focus-visible:outline-offset-[-3px] md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_auto] md:p-6"
      >
        <span className="block min-w-0">
          <span className="block truncate text-base font-semibold text-neutral-100">{name}</span>
          {facts.length > 0 && (
            <span className="mt-1 block text-xs tabular-nums text-neutral-500">{facts.join(' · ')}</span>
          )}
        </span>

        <ChipGroup
          label={t('admin.winrate.strategies.bestHours')}
          empty={bestHours.length === 0}
          chips={bestHours.map((h) => (
            <RateChip key={h.localMinutes} size="sm" kind={h.kind}
                      name={fmtClock(h.localMinutes)} rate={h.rate} />
          ))}
        />

        <ChipGroup
          label={t('admin.winrate.strategies.bestSymbols')}
          empty={bestSymbols.length === 0}
          chips={bestSymbols.map((s) => (
            <RateChip key={s.name} size="sm" kind={s.kind} name={s.name} rate={s.bucket.winRate!}
                      aria={t('admin.winrate.aria.tug', {
                        label: s.name, tp: s.bucket.hitTp, sl: s.bucket.hitSl,
                        rate: fmtPct(s.bucket.winRate!),
                      })} />
          ))}
        />

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
          {mounted && <StrategyDetail row={row} sessions={data.sessions} activeKeys={activeKeys}
                                      days={data.days} now={now} />}
        </div>
      </div>
    </article>
  )
}

export default function StrategyList({ data, selected, onSelect, activeKeys, now }: {
  data: AdminStrategyWinRate
  selected: string | null
  onSelect: (name: string | null) => void
  activeKeys: string[]
  now: Date
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
          now={now}
        />
      ))}
    </div>
  )
}
