// 总览层：不分策略，回答"这 7 天平台整体发生了什么"。
//
// 与下面的单策略层是两个不同的问题，所以是两层而不是一页平铺：总览问"平台
// 在跑什么、跑得怎么样"，单策略问"这一个策略该怎么调"。品种维度只出现在这
// 一层——"哪些品种在跑、哪些在赢"天然是跨策略的问题，逐策略看只能看到碎片。
//
// 刻意**不做策略排名**。策略还在调整期，排名是个会一直变的动态目标，把它放
// 在最显眼的位置只会引导人去追当期的名次，而不是看清平台的状态。
//
// The overview layer: strategy-agnostic, answering "what happened on the
// platform in these 7 days". Two layers rather than one flat page because they
// are different questions — the overview asks what the platform is doing, the
// per-strategy layer asks how to adjust one strategy. The symbol dimension lives
// only here: "which symbols are active and winning" is inherently
// cross-strategy, and looking strategy by strategy only shows fragments.
//
// Deliberately no strategy ranking: the strategies are still being tuned, so a
// ranking is a moving target, and putting it in the most prominent position
// would coach the reader to chase this period's placings instead of reading the
// platform's actual state.
import { useTranslation } from 'react-i18next'
import type { AdminStrategyWinRate, WinRateBucket } from '../../../api/types'
import { MIN_SAMPLES, fmtDuration } from './shared'

const TP_COLOR = '#34d399'
const SL_COLOR = '#fb7185'
const NEUTRAL = '#a1a1aa'

/** 与 StrategyCharts 同一条判断：区间完全落在 50% 一侧才算真的好/差。
 *  整页只有这一套"能不能当结论"的规则。
 *  The same verdict rule as StrategyCharts: only an interval clearing 50%
 *  entirely counts as reliably better or worse. One rule per page. */
function verdictColor(low: number | null, high: number | null): string {
  if (low === null || high === null) return NEUTRAL
  if (low > 0.5) return TP_COLOR
  if (high < 0.5) return SL_COLOR
  return NEUTRAL
}

function Stat({ label, value, sub, color }: {
  label: string; value: string; sub?: string; color?: string
}) {
  return (
    <div>
      <div className="text-[11px] text-neutral-500">{label}</div>
      <div className="mt-0.5 font-display text-2xl font-semibold tabular-nums"
           style={{ color: color ?? '#fafafa' }}>
        {value}
      </div>
      {sub && <div className="text-[10px] tabular-nums text-neutral-500">{sub}</div>}
    </div>
  )
}

/** 一行品种：迷你区间条 + 胜率 + 笔数。品种可能有十来个，所以比策略层的点图
 *  更紧凑——但保留区间，否则又会回到"5 笔和 500 笔看起来一样"的老问题。
 *  One symbol row: a compact interval bar, the rate, the count. There can be a
 *  dozen symbols so this is tighter than the per-strategy dot plot, but it keeps
 *  the interval — without it we are back to "5 trades looks like 500". */
function SymbolRow({ symbol, bucket }: { symbol: string; bucket: WinRateBucket }) {
  const { t } = useTranslation()
  const { winRate, wilsonLow, wilsonHigh, resolved, hitTp } = bucket
  const thin = winRate === null || wilsonLow === null || wilsonHigh === null || resolved < MIN_SAMPLES
  const colour = thin ? NEUTRAL : verdictColor(wilsonLow, wilsonHigh)

  return (
    <div className="flex items-center gap-3 py-1 text-[11px]">
      <span className="w-[68px] shrink-0 truncate font-medium text-neutral-300">{symbol}</span>
      {thin ? (
        <span className="flex-1 text-neutral-500">
          {t('admin.winrate.thinSample', { count: resolved })}
        </span>
      ) : (
        <>
          <svg viewBox="0 0 100 8" className="h-2 w-full min-w-[80px]" preserveAspectRatio="none"
               role="img"
               aria-label={t('admin.winrate.chart.intervalAria', {
                 label: symbol,
                 rate: `${(winRate! * 100).toFixed(1)}%`,
                 low: `${(wilsonLow! * 100).toFixed(1)}%`,
                 high: `${(wilsonHigh! * 100).toFixed(1)}%`,
                 tp: hitTp, n: resolved,
               })}>
            <line x1={50} y1={0} x2={50} y2={8} stroke="rgba(255,255,255,0.2)"
                  strokeWidth="1" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
            <rect x={wilsonLow! * 100} y={2.5} width={Math.max(0.6, (wilsonHigh! - wilsonLow!) * 100)}
                  height={3} rx={1.5} fill={colour} opacity={0.3} />
            <rect x={Math.min(99, Math.max(0, winRate! * 100 - 0.6))} y={0.5} width={1.2}
                  height={7} rx={0.6} fill={colour} />
          </svg>
          <span className="w-[74px] shrink-0 whitespace-nowrap text-right">
            <span className="font-medium tabular-nums" style={{ color: colour }}>
              {(winRate! * 100).toFixed(1)}%
            </span>
            <span className="ml-1 text-[10px] tabular-nums text-neutral-500">{resolved}</span>
          </span>
        </>
      )}
    </div>
  )
}

export default function OverviewPanel({ data }: { data: AdminStrategyWinRate }) {
  const { t } = useTranslation()
  const total = data.overall.total
  const dur = (s: number) => {
    const { value, unit } = fmtDuration(s)
    return `${value} ${t(`admin.winrate.unit.${unit}`)}`
  }
  const rateColor = verdictColor(total.wilsonLow, total.wilsonHigh)
  // 品种按已判定笔数降序（后端已排好），只展示有已判定样本的
  // Symbols come pre-sorted by resolved count; show only those with any
  const symbols = data.overall.symbols.filter((s) => s.total.samples > 0)

  return (
    <div className="glass p-5">
      <h3 className="mb-4 font-display text-lg font-semibold text-neutral-100">
        {t('admin.winrate.overview.title')}
      </h3>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label={t('admin.winrate.overview.resolved')} value={String(total.resolved)} />
        <Stat
          label={t('admin.winrate.overview.rate')}
          value={total.winRate === null ? '—' : `${(total.winRate * 100).toFixed(1)}%`}
          sub={total.wilsonLow !== null && total.wilsonHigh !== null
            ? `${(total.wilsonLow * 100).toFixed(1)}–${(total.wilsonHigh * 100).toFixed(1)}%`
            : undefined}
          color={rateColor}
        />
        <Stat
          label={t('admin.winrate.overview.holding')}
          value={total.avgResolveSeconds === null ? '—' : dur(total.avgResolveSeconds)}
        />
        <Stat
          label={t('admin.winrate.overview.coverage')}
          value={String(symbols.length)}
          sub={t('admin.winrate.overview.strategies', { count: data.strategies.length })}
        />
      </div>

      {symbols.length > 0 && (
        <div className="mt-5 border-t border-white/5 pt-4">
          <h4 className="text-[13px] font-semibold text-neutral-200">
            {t('admin.winrate.overview.bySymbol')}
          </h4>
          <p className="mt-0.5 mb-2 text-[11px] leading-4 text-neutral-500">
            {t('admin.winrate.overview.bySymbolHint')}
          </p>
          {/* 品种多时两列排，窄屏一列 / two columns when there are many symbols */}
          <div className="grid gap-x-6 md:grid-cols-2">
            {symbols.map((s) => (
              <SymbolRow key={s.symbol} symbol={s.symbol} bucket={s.total} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
