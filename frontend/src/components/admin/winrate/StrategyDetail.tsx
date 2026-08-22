// 策略详情区：策略选择器 →「全部」/各品种子页签 → 四张独立图表。
//
// 逐笔信号明细已移除：那是"给我看原始数据"的需求，而这一页要回答的是
// "该盯什么"——四个聚合图各自答一个问题，比一张 50 行的流水表更快得出结论。
// 「追踪中 N 笔」也一并撤掉：未判定数是判定链路的运维读数，不是策略表现，
// 混在业绩图里只会让人把"还没走出结果"误读成一种成绩。
//
// Strategy drill-down: selector -> "all" / per-symbol tabs -> four charts.
//
// The per-signal list is gone: that answers "show me the raw rows", while this
// page answers "what should I watch" — four aggregate charts each answer one
// question faster than a 50-row ledger. The "N tracking" counts went with it:
// unresolved counts are an ops readout for the resolution pipeline, not strategy
// performance, and mixing them into performance charts invites reading "no
// outcome yet" as a kind of result.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AdminStrategyWinRate, StrategyWinRate, SymbolWinRate } from '../../../api/types'
import MatrixTable from './MatrixTable'
import {
  WeekdayOutcomeChart,
  HoldingTimeChart,
  SessionWinRateChart,
  SideWinRateChart,
} from './StrategyCharts'

/** 四张图的栅格。窄屏一列、宽屏两列——每张图内部都是横向条，两列时仍读得清。
 *  The four-chart grid: one column on narrow screens, two when there's room. */
function ChartGrid({ row, sessions, weekday }: {
  row: StrategyWinRate | SymbolWinRate
  sessions: { key: string }[]
  weekday: import('../../../api/types').WeekdayOutcome[] | null
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <SessionWinRateChart sessions={sessions} buckets={row.sessions} />
      <SideWinRateChart sides={row.sides} />
      {/* 星期图只在策略层有数据：品种层再按星期几切一刀样本太薄，后端不下发。
          The weekday chart only has data at the strategy layer — the symbol
          layer would be too thin once sliced by weekday, so the backend omits it. */}
      {weekday && <WeekdayOutcomeChart weekday={weekday} />}
      <HoldingTimeChart sessions={sessions} buckets={row.sessions} total={row.total} />
    </div>
  )
}

export default function StrategyDetail({ data, activeKeys, selected, onSelect, now }: {
  data: AdminStrategyWinRate; activeKeys: string[]
  selected: string | null; onSelect: (name: string | null) => void
  // 只为透传给 MatrixTable 的表头时区换算——详情区自己不读时钟。面板持有唯一
  // 的每分钟计时器，组件一律接收 now，不自己 new Date()。
  // Only forwarded to MatrixTable for its header zone conversion — this area
  // doesn't read the clock itself. The panel owns the single per-minute timer;
  // components take `now` rather than calling new Date() themselves.
  now: Date
}) {
  const { t } = useTranslation()
  const [symbolTab, setSymbolTab] = useState<string>('all')
  const row: StrategyWinRate | undefined = data.strategies.find((r) => r.strategy === selected)
  // 切换策略时回到「全部」页签 / reset the symbol tab when the strategy changes
  useEffect(() => { setSymbolTab('all') }, [selected])
  // 上面这个 effect 在 commit 之后才跑；selected 变化引发的那一次 render 是同步的，
  // 此时 symbolTab 还是切换前的旧值。旧值指向的品种若不在新 row.symbols 里（换策略，
  // 或换 days 导致同一策略当前窗口的品种集合缩水），下面 .find()! 会返回 undefined
  // 交给 SessionRows，其函数体第一行 row.sessions[key] 立刻抛 TypeError，把整页炸给
  // RouteErrorBoundary（Task 10 code review Critical，两条复现路径：切策略/切天数）。
  // 用派生值兜底：每次 render 都重新核实 symbolTab 是否仍在当前 row.symbols 里，不是
  // 就退回 'all'——不依赖 effect 时序，同一 tick 内就自愈。effect 本身保留：它负责
  // "换策略就该回到全部页签"这条产品要求本身（哪怕新策略恰好也有同名品种，也不该
  // 停留在旧页签上），派生值只管兜底 effect 还没来得及跑的那一次 render。
  // The effect above only runs after commit; the render triggered by a 'selected'
  // change is synchronous, so symbolTab is still the pre-switch value at that
  // point. If that value no longer names a symbol in the new row.symbols (a
  // strategy switch, or a 'days' change that shrinks the current strategy's
  // symbol set), the .find()! below returns undefined into SessionRows, whose
  // first line (row.sessions[key]) throws a TypeError and the whole page gets
  // swapped for RouteErrorBoundary (Task 10 code review Critical; two repro
  // paths: strategy switch, days switch). Derive a safe value instead: every
  // render re-checks whether symbolTab still names a symbol in the current
  // row.symbols, falling back to 'all' when it doesn't — no dependency on effect
  // timing, self-heals within the same tick. The effect stays: it owns the
  // product requirement that switching strategies always returns to the "all"
  // tab (even when the new strategy happens to share a symbol name), while the
  // derived value only backstops the one render before the effect has run.
  const effectiveSymbolTab = row && row.symbols.some((s) => s.symbol === symbolTab) ? symbolTab : 'all'
  // 与 effectiveSymbolTab 同一类问题、上一层：`selected` 指向的策略可能在当前
  // data.strategies 里根本不存在（复现：days=30 时选中一只只在 30 天窗口里有信号
  // 的策略，再切回 7 天）。此时 row 是 undefined，下面已经会静默回落到矩阵——但
  // 选择器仍然逐个拿 `selected` 去比，「全部策略」比不中、每个策略也比不中，整行
  // aria-selected="true" 的数量变成 0：role="tablist" 里一个选中项都没有是非法的
  // ARIA 状态，用户看到的则是"点了没反应，也没人告诉我为什么"。
  // 派生值让"选中态"与"实际渲染的内容"由同一个事实（row 在不在）决定：策略没了
  // 就等价于回到「全部策略」，高亮跟着回到那一枚。父级 state 不动——它是受控
  // 的，纠正 state 是父组件的事；这里只保证同一次 render 内界面自洽。
  // Same class of bug as effectiveSymbolTab, one level up: `selected` can name a
  // strategy that no longer exists in data.strategies (repro: at days=30 select a
  // strategy whose signals only fall in the 30-day window, then switch back to
  // 7). `row` is then undefined and the body below already falls back to the
  // matrix — but the selector still compares raw `selected` against every option,
  // matching neither "all strategies" nor any strategy, so the count of
  // aria-selected="true" in the row drops to 0. A role="tablist" with nothing
  // selected is an invalid ARIA state, and what the user sees is "I clicked, it
  // did nothing, and nobody said why".
  // The derived value makes the selected state and the rendered content follow
  // one fact (does `row` exist): a vanished strategy is equivalent to being back
  // on "all strategies", and the highlight goes back there too. The parent's
  // state is left alone — it's controlled, so correcting it is the parent's call;
  // this only keeps the UI self-consistent within the render.
  const effectiveSelected = row ? selected : null

  return (
    <div className="glass p-5">
      {/* 策略选择器 / strategy selector */}
      <div className="mb-4 flex flex-wrap gap-1.5" role="tablist">
        <button type="button" role="tab" aria-selected={effectiveSelected === null} onClick={() => onSelect(null)}
                className={`rounded-full px-3 py-1 text-xs transition ${effectiveSelected === null ? 'bg-prism-500/25 text-prism-100 ring-1 ring-prism-400/40' : 'text-neutral-400 hover:text-neutral-200'}`}>
          {t('admin.winrate.allStrategiesTab')}
        </button>
        {data.strategies.map((r) => (
          <button key={r.strategy} type="button" role="tab" aria-selected={effectiveSelected === r.strategy}
                  onClick={() => onSelect(r.strategy)}
                  className={`rounded-full px-3 py-1 text-xs transition ${effectiveSelected === r.strategy ? 'bg-prism-500/25 text-prism-100 ring-1 ring-prism-400/40' : 'text-neutral-400 hover:text-neutral-200'}`}>
            {r.strategy || t('admin.winrate.unnamed')}
          </button>
        ))}
      </div>

      {effectiveSelected === null || !row ? (
        <MatrixTable data={data} activeKeys={activeKeys} now={now} onSelectStrategy={(name) => onSelect(name)} />
      ) : (
        <>
          {/* 品种子页签：只列有信号的品种 / symbol tabs, resolved-desc, signal-bearing only */}
          <div className="mb-3 flex flex-wrap gap-1.5 border-b border-white/5 pb-3" role="tablist">
            <button type="button" role="tab" aria-selected={effectiveSymbolTab === 'all'} onClick={() => setSymbolTab('all')}
                    className={`rounded-lg px-2.5 py-1 text-xs ${effectiveSymbolTab === 'all' ? 'bg-white/10 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'}`}>
              {t('admin.winrate.allSymbols')}
            </button>
            {row.symbols.map((s) => (
              <button key={s.symbol} type="button" role="tab" aria-selected={effectiveSymbolTab === s.symbol}
                      onClick={() => setSymbolTab(s.symbol)}
                      className={`rounded-lg px-2.5 py-1 text-xs tabular-nums ${effectiveSymbolTab === s.symbol ? 'bg-white/10 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'}`}>
                {s.symbol}
              </button>
            ))}
          </div>
          {effectiveSymbolTab === 'all' ? (
            <ChartGrid row={row} sessions={data.sessions} weekday={row.total.weekday} />
          ) : (
            // 品种层的 total.weekday 恒为 null（后端不下发），ChartGrid 据此跳过星期图
            // The symbol layer's total.weekday is always null; ChartGrid skips
            // the weekday chart accordingly
            <ChartGrid row={row.symbols.find((x) => x.symbol === effectiveSymbolTab)!}
                       sessions={data.sessions} weekday={null} />
          )}
        </>
      )}
    </div>
  )
}
