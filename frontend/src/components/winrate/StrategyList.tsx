// 每个策略一张卡，点开在原位展开细节（手风琴，一次只开一张）。
//
// 顺序沿用后端的"已判定笔数降序"，**不是按胜率排名**——策略还在调整期，排名
// 是个会一直变的动态目标，而且胜率高不等于更赚钱（盈亏比差三倍时，胜率最低
// 的策略可能期望最高）。列表标题下面直接把这句话写给读者。
//
// 卡片首行不再放整体胜率、拔河条和信号量柱（产品要求）。**2026-08-27 起也不再列
// 「胜率最高的品种」**，改成一个品种选择器 + **这个策略在该品种上**胜率最高的三个
// 钟点——品种从"被排名的一列"变成"你选的那一维"，与页面上另外两处（仪表盘卡、
// 「现在该盯什么」）同一个思路：混合了所有品种的钟点排名不指导任何操作。
//
// 这里**只选品种、不选策略**——每张卡本身就是一个策略，策略维度已经分开了。
//
// The card's first row carries no aggregate rate, tug bar or volume sparkline
// (product decision), and since 2026-08-27 no "best symbols" list either: a symbol
// picker plus **this strategy's** best hours *on that symbol*. The symbol moves
// from a ranked column to a dimension you choose, matching the page's two other
// surfaces — an hour ranking blended across every symbol guides no action.
//
// Only the symbol is picked here, never the strategy: each card *is* a strategy.
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
import type { AdminStrategyWinRate, StrategyWinRate } from '../../api/types'
import RateChip from './RateChip'
import Select from '../Select'
import StrategyDetail from './StrategyDetail'
import { fmtClock, fmtDurationText, rankHours } from './shared'
import { resolveCardSymbol, useCardSymbol } from './useWinratePick'

const TOP_PER_CARD = 3

// 全部用 <span>。开合按钮已改成绝对定位垫在底下（见 StrategyCard），这里其实可以
// 用块级元素了，但 span + block 已经在用且渲染一致，没必要动。
// Spans throughout. The toggle button is now absolutely positioned underneath
// (see StrategyCard) so block elements would be legal here, but span + block
// already renders identically and there is no reason to churn it.
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

function StrategyCard({ row, index, open, onToggle, data, activeKeys, now, cardSymbol, onSymbol }: {
  row: StrategyWinRate
  index: number
  open: boolean
  onToggle: () => void
  data: AdminStrategyWinRate
  activeKeys: string[]
  // 透传给钟点格做本地时区换算 / forwarded to the hour cells for zone conversion
  now: Date
  // 全部卡片共用的品种选择（见 useCardSymbol）；这张卡没交易过它就自行退回。
  // The symbol shared by every card (see useCardSymbol); this card falls back on
  // its own when it never traded that one.
  cardSymbol: string
  onSymbol: (symbol: string) => void
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

  // 共用的品种落到这张卡上：这个策略没交易过它就退回黄金、再退回它自己的第一个。
  // 钟点序列取**该品种**的（`symbols[].total.hourly`），不再取策略层的合并值。
  // **这里不设 0.5 下限**（顶层的「可以留意」曾有）：标题是"胜率最高的"，在描述这个
  // 策略本身，最好的一个只有 45% 也是实情，红色会如实说出来。
  // The shared symbol resolved against this card, falling back to gold and then to
  // its own first symbol. The hour series comes from **that symbol**
  // (`symbols[].total.hourly`) rather than the strategy-level blend. **No 0.5
  // floor**: the heading describes the strategy, so a best of 45% is the fact and
  // red says so.
  const symbol = resolveCardSymbol(row, cardSymbol)
  const symbolRow = symbol ? row.symbols.find((x) => x.symbol === symbol) : undefined
  const bestHours = rankHours(symbolRow?.total.hourly ?? null, now, { limit: TOP_PER_CARD })

  return (
    <article
      aria-label={name}
      className={`glass animate-fade-in-up overflow-hidden ${open ? 'ring-1 ring-prism-400/40' : ''}`}
      style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}
    >
      {/* ⚠ 开合按钮**铺满整行、垫在内容底下**，而不是把内容包进按钮里。
          卡片上多了一个品种下拉，而下拉本身是个 `<button>`——嵌在开合用的
          `<button>` 里既是非法嵌套，点它还会顺带把卡片折叠掉。
          做法：按钮 `absolute inset-0` 在下，内容层 `pointer-events-none` 让点击
          穿透过去，只有下拉那一格用 `pointer-events-auto` 把指针事件收回来。
          按下时的缩放靠 `peer-active`（按钮在 DOM 里排在内容之前，才能当 peer）。

          The toggle button **fills the row underneath the content** rather than
          wrapping it. The card now holds a symbol dropdown, itself a `<button>`:
          nesting that inside the toggle button is invalid and clicking it would
          also collapse the card. So the button sits `absolute inset-0` below,
          the content layer is `pointer-events-none` so clicks fall through, and
          only the dropdown cell takes pointer events back. The press-scale rides
          on `peer-active` — the button precedes the content, which is what lets
          it act as the peer. */}
      <div className="relative">
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
          className="peer absolute inset-0 z-0 w-full rounded-[22px] focus-visible:outline-offset-[-3px]"
        >
          <span className="sr-only">
            {open ? t('admin.winrate.strategies.collapse') : t('admin.winrate.strategies.expand')}｜{name}
          </span>
        </button>

        <div className="pointer-events-none relative z-10 grid w-full items-center gap-x-6 gap-y-4 p-5 text-left transition peer-active:scale-[0.995] md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.6fr)_auto] md:p-6">
          <span className="block min-w-0">
            <span className="block truncate text-base font-semibold text-neutral-100">{name}</span>
            {facts.length > 0 && (
              <span className="mt-1 block text-xs tabular-nums text-neutral-500">{facts.join(' · ')}</span>
            )}
          </span>

          {/* 品种选择器。这一格必须把指针事件收回来，否则点击会穿透到下面的开合
              按钮、把卡片折叠掉。
              This cell must take pointer events back, or a click falls through to
              the toggle button underneath and collapses the card. */}
          <span className="pointer-events-auto block min-w-0">
            <span className="block text-2xs uppercase tracking-wider text-neutral-500">
              {t('admin.winrate.strategies.symbolLabel')}
            </span>
            {symbol ? (
              <span className="mt-1.5 block">
                <Select
                  className="tabular-nums"
                  ariaLabel={t('dashboard.sessionWinrate.pickSymbol')}
                  value={symbol}
                  options={row.symbols.map((x) => ({ value: x.symbol, label: x.symbol }))}
                  onChange={onSymbol}
                />
              </span>
            ) : (
              <span className="mt-1.5 block text-sm text-neutral-600">{t('admin.winrate.strategies.tooThin')}</span>
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

          <span className="flex items-center gap-1.5 text-xs text-neutral-500 md:justify-self-end">
            <span className="md:hidden">{open ? t('admin.winrate.strategies.collapse') : t('admin.winrate.strategies.expand')}</span>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6"
                 strokeLinecap="round" strokeLinejoin="round" aria-hidden
                 className={`transition-transform duration-300 ${open ? 'rotate-180' : ''}`}>
              <path d="m4 6 4 4 4-4" />
            </svg>
          </span>
        </div>
      </div>

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
          {/* 展开后的品种页签默认落在卡片上选中的那个，否则收起时写着 WTI、
              点开却是黄金，两处自相矛盾。
              The detail's symbol tab defaults to the one picked on the card, or
              the collapsed row would say WTI while the expanded view showed gold. */}
          {mounted && <StrategyDetail row={row} sessions={data.sessions} activeKeys={activeKeys}
                                      days={data.days} now={now} defaultSymbol={symbol ?? undefined} />}
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
  // 一份品种选择管全部卡片（见 useCardSymbol 的说明）。
  // One symbol governs every card; see useCardSymbol.
  const { symbol: cardSymbol, choose: onSymbol } = useCardSymbol()
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
          cardSymbol={cardSymbol}
          onSymbol={onSymbol}
        />
      ))}
    </div>
  )
}
