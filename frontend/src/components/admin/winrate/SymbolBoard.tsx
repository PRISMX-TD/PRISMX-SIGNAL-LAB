// 每个品种：跨全部策略合并后的表现，一行一个品种。
// 这份数据只能由后端从原始行重新累加——胜率不可加，不能把几个策略的胜率平均。
// 行的读法与策略卡、时段行完全一致：名字、百分比、判定芯片、拔河条。
// Per-symbol performance pooled across all strategies, one row each. The
// pooling must happen server-side from raw rows (win rates don't add). Rows
// read exactly like strategy cards and session rows: name, percentage, verdict
// chip, tug bar.
import { useTranslation } from 'react-i18next'
import type { AdminStrategyWinRate, WinRateBucket } from '../../../api/types'
import TugBar from './TugBar'
import { VERDICT_COLOR, fmtPct, isRated, verdictOf } from './shared'

function SymbolRow({ symbol, bucket }: { symbol: string; bucket: WinRateBucket }) {
  const { t } = useTranslation()
  const kind = verdictOf(bucket)
  const hasRate = isRated(kind) && bucket.winRate !== null
  const aria = t('admin.winrate.aria.tug', {
    label: symbol, tp: bucket.hitTp, sl: bucket.hitSl, rate: hasRate ? fmtPct(bucket.winRate!) : '—',
  })
  return (
    <div className="border-b border-white/5 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-sm font-medium text-neutral-200">{symbol}</span>
        <span className="shrink-0 text-sm font-semibold tabular-nums" style={{ color: VERDICT_COLOR[kind] }}>
          {hasRate ? fmtPct(bucket.winRate!) : '—'}
        </span>
      </div>
      <TugBar className="mt-2" size="sm" hitTp={bucket.hitTp} hitSl={bucket.hitSl} label={aria} />
    </div>
  )
}

export default function SymbolBoard({ data }: { data: AdminStrategyWinRate }) {
  const { t } = useTranslation()
  // 后端已按已判定笔数降序；只展示有信号的 / pre-sorted by resolved desc; signal-bearing only
  const symbols = data.overall.symbols.filter((s) => s.total.samples > 0)
  if (symbols.length === 0) return null
  return (
    <section className="glass animate-fade-in-up p-6" style={{ animationDelay: '120ms' }}>
      <header className="mb-3">
        <h2 className="text-lg font-semibold text-neutral-100">{t('admin.winrate.symbols.title')}</h2>
        <p className="mt-1 text-xs text-neutral-500">{t('admin.winrate.symbols.caption')}</p>
      </header>
      <div className="grid gap-x-10 md:grid-cols-2">
        {symbols.map((s) => (
          <SymbolRow key={s.symbol} symbol={s.symbol} bucket={s.total} />
        ))}
      </div>
    </section>
  )
}
