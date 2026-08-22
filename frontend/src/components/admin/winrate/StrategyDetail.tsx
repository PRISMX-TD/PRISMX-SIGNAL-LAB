// 策略详情区：策略选择器 →「全部」/各品种子页签。「全部」看该策略在哪个时段
// 能打；品种页签看到组合的分时段表现 + 逐笔明细（信任链闭环）。
// Strategy drill-down: selector → "all" / per-symbol tabs, ending at receipts.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { adminApi } from '../../../api/client'
import { fmtTime } from '../../../api/utils'
import type {
  AdminStrategyWinRate,
  AdminStrategySignalList,
  StrategyWinRate,
  WinRateBucket,
} from '../../../api/types'
import MatrixTable from './MatrixTable'
import WinRateBar from './WinRateBar'
import { DailyBars } from './RecommendationCards'
import { SESSION_COLORS, fmtDuration } from './shared'

const RESULT_CLASS: Record<string, string> = {
  HIT_TP: 'text-up', HIT_SL: 'text-down', PENDING: 'text-amber-400/80', STALE: 'text-neutral-500',
}

// 秒数 → 拼好单位的人话文本。fmtDuration 只吐 {value, unit}（shared.ts 的约定，
// 单位词特意留给调用方过 i18n），这里和 RecommendationCards.tsx 里的同名私有
// 函数做一样的事——那个函数没有 export，本文件需要同样的拼接就只能自己再写
// 一份，不是遗漏了导入。
// Seconds → a humanized string. fmtDuration only returns {value, unit} (shared.ts
// deliberately leaves the unit word to the caller's i18n pass); this mirrors the
// same-named private helper in RecommendationCards.tsx — that one isn't exported,
// so needing the same formatting here means re-declaring it, not a missed import.
function fmtDurationText(t: TFunction, seconds: number): string {
  const { value, unit } = fmtDuration(seconds)
  return `${value} ${t(`admin.winrate.unit.${unit}`)}`
}

function SessionRows({ row, sessionKeys, activeKeys, withDaily }: {
  row: { sessions: Record<string, WinRateBucket> }
  sessionKeys: string[]; activeKeys: string[]; withDaily: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-2">
      {sessionKeys.map((key) => {
        const b = row.sessions[key]
        if (!b || b.samples === 0) return null
        const active = activeKeys.includes(key)
        return (
          <div key={key}
               className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg px-3 py-2 ${active ? 'bg-white/[0.05] ring-1 ring-white/15' : 'bg-white/[0.02]'}`}>
            <span className="flex w-24 items-center gap-1.5 text-[12px] text-neutral-300">
              <i className="h-2 w-2 rounded-full" style={{ backgroundColor: SESSION_COLORS[key] ?? '#666' }} />
              {t(`admin.winrate.session.${key}`)}
            </span>
            <WinRateBar bucket={b} />
            {withDaily && b.dailySamples && <DailyBars daily={b.dailySamples} />}
            <span className="text-[11px] tabular-nums text-neutral-500">{t('admin.winrate.weekly', { count: b.weeklySignals })}</span>
            {b.avgResolveSeconds !== null && (
              <span className="text-[11px] tabular-nums text-neutral-500">
                {t('admin.winrate.avgResolve', { time: fmtDurationText(t, b.avgResolveSeconds) })}
              </span>
            )}
            {b.pending > 0 && (
              <span className="text-[11px] tabular-nums text-amber-400/80">{t('admin.winrate.tracking', { count: b.pending })}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function SignalList({ strategy, symbol, days }: { strategy: string; symbol: string; days: number }) {
  const { t } = useTranslation()
  const [list, setList] = useState<AdminStrategySignalList | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    // 组合一变就先清空旧列表/旧错误，再发新请求；cancelled 挡住晚到的旧响应
    // ——不然快速切两个品种页签时，先发后至的响应会把新数据盖回旧的。
    // Clear the previous list/error before firing the new request; `cancelled`
    // blocks a late-arriving stale response — otherwise flicking between two
    // symbol tabs quickly lets an out-of-order response overwrite fresh data.
    let cancelled = false
    setList(null)
    setError(null)
    adminApi.strategyWinrateSignals(strategy, symbol, days)
      .then((r) => { if (!cancelled) setList(r) })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Load failed') })
    return () => { cancelled = true }
  }, [strategy, symbol, days])

  if (error) return <p className="py-2 text-sm text-down">{error}</p>
  if (!list) return <p className="py-2 text-sm text-neutral-500">…</p>
  return (
    <div className="mt-3 overflow-x-auto">
      <p className="mb-1 text-[11px] text-neutral-500">
        {t('admin.winrate.signalCount', { shown: list.signals.length, total: list.total })}
      </p>
      <table className="w-full min-w-[520px] text-xs">
        <thead>
          <tr className="text-left text-neutral-500">
            <th className="pb-1.5 pr-3 font-medium">{t('admin.winrate.colTime')}</th>
            <th className="pb-1.5 pr-3 font-medium">{t('admin.winrate.colSide')}</th>
            <th className="pb-1.5 pr-3 text-right font-medium">{t('admin.winrate.colEntry')}</th>
            <th className="pb-1.5 pr-3 text-right font-medium">SL / TP</th>
            <th className="pb-1.5 pr-3 font-medium">{t('admin.winrate.colSessions')}</th>
            <th className="pb-1.5 pr-3 text-right font-medium">{t('admin.winrate.colResult')}</th>
          </tr>
        </thead>
        <tbody>
          {list.signals.length === 0 ? (
            <tr>
              <td colSpan={6} className="py-3 text-center text-neutral-500">{t('admin.winrate.empty')}</td>
            </tr>
          ) : list.signals.map((s, i) => (
            <tr key={i} className="border-t border-white/5">
              <td className="py-1.5 pr-3 tabular-nums text-neutral-400">{fmtTime(s.createdAt)}</td>
              <td className={`py-1.5 pr-3 font-medium ${s.side === 'BUY' ? 'text-up' : 'text-down'}`}>{s.side}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-neutral-300">{s.entry ?? '—'}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-neutral-500">{s.stopLoss ?? '—'} / {s.takeProfit ?? '—'}</td>
              <td className="py-1.5 pr-3">
                {s.sessionKeys.map((k) => {
                  const label = t(`admin.winrate.session.${k}`)
                  // 键盘等价路径：这个点唯一表达"这条信号命中了哪个时段"，只靠
                  // title 的话鼠标 hover 才读得到。同 SessionTimeline / DailyBars
                  // 的既有修法——tabIndex + role="img" + aria-label（与 title 同文案）
                  // ——补上键盘 Tab 也能读到同等信息（dataviz interaction.md：
                  // "keyboard focus 与 hover 等价"）。
                  // Keyboard-equivalent path: this dot is the only place that says
                  // which session a signal fired in, and a bare title only surfaces
                  // on mouse hover. Same fix already used by SessionTimeline /
                  // DailyBars — tabIndex + role="img" + aria-label (same text as
                  // the title) — so keyboard Tab reaches the same info a hover
                  // would (dataviz interaction.md: keyboard focus must match hover).
                  return (
                    <i key={k} tabIndex={0} role="img" aria-label={label}
                       className="mr-1 inline-block h-2 w-2 rounded-full outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white/80"
                       style={{ backgroundColor: SESSION_COLORS[k] ?? '#555' }}
                       title={label} />
                  )
                })}
              </td>
              <td className={`py-1.5 pr-3 text-right tabular-nums ${RESULT_CLASS[s.result] ?? 'text-neutral-400'}`}>
                {s.result}{s.resolveSeconds !== null && <span className="ml-1 text-[10px] text-neutral-500">{fmtDurationText(t, s.resolveSeconds)}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function StrategyDetail({ data, days, activeKeys, selected, onSelect }: {
  data: AdminStrategyWinRate; days: number; activeKeys: string[]
  selected: string | null; onSelect: (name: string | null) => void
}) {
  const { t } = useTranslation()
  const [symbolTab, setSymbolTab] = useState<string>('all')
  const sessionKeys = [...data.sessions.map((s) => s.key), 'outside']
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

  return (
    <div className="glass p-5">
      {/* 策略选择器 / strategy selector */}
      <div className="mb-4 flex flex-wrap gap-1.5" role="tablist">
        <button type="button" role="tab" aria-selected={selected === null} onClick={() => onSelect(null)}
                className={`rounded-full px-3 py-1 text-xs transition ${selected === null ? 'bg-prism-500/25 text-prism-100 ring-1 ring-prism-400/40' : 'text-neutral-400 hover:text-neutral-200'}`}>
          {t('admin.winrate.allStrategiesTab')}
        </button>
        {data.strategies.map((r) => (
          <button key={r.strategy} type="button" role="tab" aria-selected={selected === r.strategy}
                  onClick={() => onSelect(r.strategy)}
                  className={`rounded-full px-3 py-1 text-xs transition ${selected === r.strategy ? 'bg-prism-500/25 text-prism-100 ring-1 ring-prism-400/40' : 'text-neutral-400 hover:text-neutral-200'}`}>
            {r.strategy || t('admin.winrate.unnamed')}
          </button>
        ))}
      </div>

      {selected === null || !row ? (
        <MatrixTable data={data} activeKeys={activeKeys} onSelectStrategy={(name) => onSelect(name)} />
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
            <SessionRows row={row} sessionKeys={sessionKeys} activeKeys={activeKeys} withDaily />
          ) : (
            <>
              <SessionRows row={row.symbols.find((s) => s.symbol === effectiveSymbolTab)!}
                           sessionKeys={sessionKeys} activeKeys={activeKeys} withDaily={false} />
              <SignalList strategy={row.strategy} symbol={effectiveSymbolTab} days={days} />
            </>
          )}
        </>
      )}
    </div>
  )
}
