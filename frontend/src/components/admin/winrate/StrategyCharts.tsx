// 单个策略的四张独立图表：分时段胜率 / 每日胜负 / 做多做空 / 平均持仓时间。
// 四张各自回答一个问题，刻意不合并成一张多维图——把时段、方向、日期挤进同一
// 张图会让每个维度都读不清，而管理员看这一页时脑子里是四个分开的问题。
//
// Four independent charts for one strategy: win rate by session, daily
// win/loss, long vs short, and time to resolution. Deliberately four charts
// rather than one multi-dimensional plot: cramming session, direction and date
// into a single figure makes every dimension harder to read, and the admin
// arrives with four separate questions anyway.
import { useTranslation } from 'react-i18next'
import type { WeekdayOutcome, WinRateBucket } from '../../../api/types'
import { MIN_SAMPLES, SESSION_COLORS, fmtDuration } from './shared'

// 胜/负两色。与 WinRateBar 同源，整页只有这一套胜负语义色。
// Win/loss colours, same source as WinRateBar — one win/loss palette per page.
const TP_COLOR = '#34d399'
const SL_COLOR = '#fb7185'

// 方向色刻意**不用**胜负色：做多/做空是身份分类，不是好坏。用绿红会让人以为
// "做多=好"。这两个色取自项目既有的中性强调色。
// Direction colours deliberately avoid the win/loss palette: long and short are
// identities, not outcomes, and green/red would read as "long = good". These
// come from the project's existing neutral accents.
const SIDE_COLORS: Record<string, string> = { BUY: '#60a5fa', SELL: '#f0abfc' }

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

function useDurationText() {
  const { t } = useTranslation()
  return (seconds: number) => {
    const { value, unit } = fmtDuration(seconds)
    return `${value} ${t(`admin.winrate.unit.${unit}`)}`
  }
}

/** 图表外壳：标题 + 说明 + 内容。四张图共用，保证间距与标题层级一致。
 *  Chart shell: title, caption, body — shared so spacing and heading level
 *  stay consistent across all four. */
function ChartCard({ title, caption, children }: {
  title: string; caption?: string; children: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-white/5 bg-white/[0.02] p-4">
      <h4 className="text-[13px] font-semibold text-neutral-200">{title}</h4>
      {caption && <p className="mt-0.5 text-[11px] leading-4 text-neutral-500">{caption}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

/** 一行横向胜率条：左标签 + 条 + 右侧读数。分时段图与方向图共用。
 *  样本不足时不画条、只给笔数——与全站 MIN_SAMPLES 纪律一致。
 *  One horizontal win-rate row, shared by the session and direction charts.
 *  Below MIN_SAMPLES it shows the count instead of a bar. */
function RateRow({ label, color, bucket }: { label: string; color: string; bucket: WinRateBucket }) {
  const { t } = useTranslation()
  const thin = bucket.winRate === null || bucket.resolved < MIN_SAMPLES
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="flex w-20 shrink-0 items-center gap-1.5 text-[11px] text-neutral-400">
        <i className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        <span className="truncate">{label}</span>
      </span>
      {bucket.samples === 0 ? (
        <span className="text-[11px] text-neutral-600">—</span>
      ) : thin ? (
        <span className="text-[11px] text-neutral-500">
          {t('admin.winrate.thinSample', { count: bucket.resolved })}
        </span>
      ) : (
        <>
          {/* 只约束宽度不给固定高度：preserveAspectRatio="none" 下强设高度会把
              圆角拉变形。见 WinRateBar 同样的处理。
              Width-only sizing: with preserveAspectRatio="none" a forced height
              distorts the rounded corners. Same handling as WinRateBar. */}
          <svg viewBox="0 0 100 10" className="h-2.5 w-full min-w-[80px]" preserveAspectRatio="none"
               role="img" aria-label={`${label} ${fmtPct(bucket.winRate!)} (${bucket.hitTp}/${bucket.resolved})`}>
            <rect x={0} y={0} width={Math.max(0, (bucket.hitTp / bucket.resolved) * 100 - 1)}
                  height={10} rx={1.5} fill={TP_COLOR} opacity={0.85} />
            <rect x={Math.min(100, (bucket.hitTp / bucket.resolved) * 100 + 1)} y={0}
                  width={Math.max(0, 100 - ((bucket.hitTp / bucket.resolved) * 100 + 1))}
                  height={10} rx={1.5} fill={SL_COLOR} opacity={0.6} />
            <line x1={50} y1={-1} x2={50} y2={11} stroke="rgba(255,255,255,0.35)"
                  strokeWidth="1" vectorEffect="non-scaling-stroke" />
          </svg>
          <span className="w-24 shrink-0 whitespace-nowrap text-right">
            <span className="text-[12px] font-medium tabular-nums text-neutral-100">
              {fmtPct(bucket.winRate!)}
            </span>
            <span className="ml-1 text-[10px] tabular-nums text-neutral-500">
              {bucket.hitTp}/{bucket.resolved}
            </span>
          </span>
        </>
      )}
    </div>
  )
}

/** ① 分时段胜率 */
export function SessionWinRateChart({ sessions, buckets }: {
  sessions: { key: string }[]; buckets: Record<string, WinRateBucket>
}) {
  const { t } = useTranslation()
  const keys = [...sessions.map((s) => s.key), 'outside']
  return (
    <ChartCard title={t('admin.winrate.chart.sessions')} caption={t('admin.winrate.chart.sessionsHint')}>
      {keys.map((k) => buckets[k] && (
        <RateRow key={k} label={t(`admin.winrate.session.${k}`)}
                 color={SESSION_COLORS[k] ?? '#71717a'} bucket={buckets[k]} />
      ))}
    </ChartCard>
  )
}

/** ② 星期 × 方向矩阵：7 行（周一…周日）× 2 列（做多/做空），每格一个胜率。
 *
 *  做成矩阵而不是堆叠柱，是因为要回答的问题本身是交叉的——"周一该做多还是
 *  做空"不能由"周一整体胜率"和"整体做多胜率"推出来。横着读比周几，竖着读
 *  比方向。
 *
 *  固定 7 天窗口下每个星期几正好各占整 24 小时（168h = 7×24），所以格子之间
 *  可以直接比；14/30 天就不行了（30 天 = 4.28 周除不尽，有的星期几会多摊到
 *  一天，柱子高低会把这个也编码进去）。
 *
 *  只含已判定的信号；每格独立守 5 笔门槛，不够就只显示笔数。
 *
 *  A weekday x direction matrix: seven rows (Mon..Sun) by two columns (long,
 *  short), one win rate per cell. A matrix rather than stacked bars because the
 *  question is itself crossed — "should I go long or short on Monday" cannot be
 *  derived from "Monday overall" plus "long overall". Read across to compare
 *  weekdays, down to compare directions.
 *
 *  At the pinned 7-day window every weekday gets exactly 24 hours (168h = 7x24),
 *  so cells are directly comparable; at 14 or 30 days they would not be (30 days
 *  is 4.28 weeks, so some weekdays draw an extra day and that would be encoded
 *  in the numbers). Resolved signals only; each cell gates on its own sample. */
export function WeekdayOutcomeChart({ weekday }: { weekday: WeekdayOutcome[] }) {
  const { t } = useTranslation()
  // 周一=0，与后端 Python 的 weekday() 一致 / Monday=0, matching Python's weekday()
  const labels = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

  /** 一个格子：够样本画迷你胜率条 + 百分比，不够只给笔数，没有则留白。
   *  One cell: a mini bar plus the percentage when the sample allows, the raw
   *  count when it doesn't, blank when there's nothing. */
  const Cell = ({ tp, sl, label }: { tp: number; sl: number; label: string }) => {
    const resolved = tp + sl
    if (resolved === 0) return <span className="text-neutral-700">—</span>
    if (resolved < MIN_SAMPLES) {
      return (
        <span className="text-[11px] tabular-nums text-neutral-500"
              title={t('admin.winrate.chart.cellHint', { tp, sl })}>
          {t('admin.winrate.thinSample', { count: resolved })}
        </span>
      )
    }
    const rate = tp / resolved
    return (
      <span className="inline-flex w-full items-center gap-1.5"
            title={t('admin.winrate.chart.cellHint', { tp, sl })}>
        <svg viewBox="0 0 100 6" className="h-1.5 min-w-[28px] flex-1" preserveAspectRatio="none"
             role="img" aria-label={`${label} ${(rate * 100).toFixed(1)}% (${tp}/${resolved})`}>
          <rect x={0} y={0} width={Math.max(0, rate * 100 - 1)} height={6} rx={1} fill={TP_COLOR} opacity={0.85} />
          <rect x={Math.min(100, rate * 100 + 1)} y={0} width={Math.max(0, 100 - (rate * 100 + 1))}
                height={6} rx={1} fill={SL_COLOR} opacity={0.6} />
        </svg>
        <span className="whitespace-nowrap text-[11px] font-medium tabular-nums text-neutral-100">
          {(rate * 100).toFixed(0)}%
        </span>
        <span className="whitespace-nowrap text-[10px] tabular-nums text-neutral-500">{tp}/{resolved}</span>
      </span>
    )
  }

  return (
    <ChartCard title={t('admin.winrate.chart.weekday')} caption={t('admin.winrate.chart.weekdayHint')}>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-neutral-500">
            <th className="w-12 pb-1.5 text-left font-medium" />
            <th className="pb-1.5 text-left font-medium">
              <span className="flex items-center gap-1.5">
                <i className="h-2 w-2 rounded-full" style={{ backgroundColor: SIDE_COLORS.BUY }} />
                {t('admin.winrate.side.BUY')}
              </span>
            </th>
            <th className="pb-1.5 text-left font-medium">
              <span className="flex items-center gap-1.5">
                <i className="h-2 w-2 rounded-full" style={{ backgroundColor: SIDE_COLORS.SELL }} />
                {t('admin.winrate.side.SELL')}
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {weekday.map((d, i) => (
            <tr key={i} className="border-t border-white/5">
              <td className="py-1.5 pr-2 text-neutral-400">{t(`admin.winrate.weekday.${labels[i]}`)}</td>
              <td className="py-1.5 pr-3">
                <Cell tp={d.buyTp} sl={d.buySl}
                      label={`${t(`admin.winrate.weekday.${labels[i]}`)} ${t('admin.winrate.side.BUY')}`} />
              </td>
              <td className="py-1.5">
                <Cell tp={d.sellTp} sl={d.sellSl}
                      label={`${t(`admin.winrate.weekday.${labels[i]}`)} ${t('admin.winrate.side.SELL')}`} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ChartCard>
  )
}

/** ③ 做多 / 做空胜率 */
export function SideWinRateChart({ sides }: { sides: Record<string, WinRateBucket> }) {
  const { t } = useTranslation()
  return (
    <ChartCard title={t('admin.winrate.chart.sides')} caption={t('admin.winrate.chart.sidesHint')}>
      {['BUY', 'SELL'].map((k) => sides[k] && (
        <RateRow key={k} label={t(`admin.winrate.side.${k}`)}
                 color={SIDE_COLORS[k]} bucket={sides[k]} />
      ))}
    </ChartCard>
  )
}

/** ④ 平均持仓时间（从信号发出到分出胜负）——按时段拆开，看哪个盘走得快。
 *  Time to resolution, split by session: which session settles fastest. */
export function HoldingTimeChart({ sessions, buckets, total }: {
  sessions: { key: string }[]; buckets: Record<string, WinRateBucket>; total: WinRateBucket
}) {
  const { t } = useTranslation()
  const durText = useDurationText()
  const keys = [...sessions.map((s) => s.key), 'outside']
  const rows = keys
    .filter((k) => buckets[k]?.avgResolveSeconds !== null && buckets[k] !== undefined)
    .map((k) => ({ key: k, seconds: buckets[k].avgResolveSeconds! }))
  const max = Math.max(...rows.map((r) => r.seconds), 1)

  return (
    <ChartCard title={t('admin.winrate.chart.holding')} caption={t('admin.winrate.chart.holdingHint')}>
      {total.avgResolveSeconds !== null && (
        <p className="mb-2 text-[11px] text-neutral-400">
          {t('admin.winrate.chart.holdingOverall')}
          <span className="ml-1.5 font-display text-lg font-semibold tabular-nums text-neutral-100">
            {durText(total.avgResolveSeconds)}
          </span>
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-[11px] text-neutral-600">{t('admin.winrate.chart.holdingEmpty')}</p>
      ) : rows.map((r) => (
        <div key={r.key} className="flex items-center gap-3 py-1">
          <span className="flex w-20 shrink-0 items-center gap-1.5 text-[11px] text-neutral-400">
            <i className="h-2 w-2 shrink-0 rounded-full"
               style={{ backgroundColor: SESSION_COLORS[r.key] ?? '#71717a' }} />
            <span className="truncate">{t(`admin.winrate.session.${r.key}`)}</span>
          </span>
          <span className="h-2 rounded-sm bg-prism-500/50"
                style={{ width: `${Math.max(2, (r.seconds / max) * 100)}%` }}
                role="img" aria-label={durText(r.seconds)} />
          <span className="w-20 shrink-0 whitespace-nowrap text-right text-[11px] tabular-nums text-neutral-300">
            {durText(r.seconds)}
          </span>
        </div>
      ))}
    </ChartCard>
  )
}
