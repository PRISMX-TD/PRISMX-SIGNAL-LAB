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
import type { DailyOutcome, WinRateBucket } from '../../../api/types'
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

/** ② 每日胜负堆叠柱 */
export function DailyOutcomeChart({ daily }: { daily: DailyOutcome[] }) {
  const { t } = useTranslation()
  const max = Math.max(...daily.map((d) => Math.max(d.samples, d.tp + d.sl)), 1)
  const totalTp = daily.reduce((s, d) => s + d.tp, 0)
  const totalSl = daily.reduce((s, d) => s + d.sl, 0)
  const H = 64
  const slot = 100 / daily.length

  return (
    <ChartCard title={t('admin.winrate.chart.daily')} caption={t('admin.winrate.chart.dailyHint')}>
      {/* 整图一个 Tab 停位 + 完整数值序列的 aria-label：逐柱 tabIndex 会让 7 天
          图占掉 7 个停位，而柱子本身不可激活。键盘读到的信息与 hover 等同。
          One tab stop for the whole chart with the full series in aria-label:
          per-bar tabIndex would eat seven stops for non-activatable marks. What
          the keyboard reads equals what hover shows. */}
      <svg viewBox={`0 0 100 ${H}`} className="w-full" preserveAspectRatio="none"
           tabIndex={0} role="img"
           aria-label={t('admin.winrate.chart.dailyAria', {
             days: daily.length,
             detail: daily.map((d, i) =>
               t('admin.winrate.chart.dailyAriaDay', { n: i + 1, tp: d.tp, sl: d.sl })).join('; '),
           })}>
        {daily.map((d, i) => {
          const resolved = d.tp + d.sl
          const tpH = (d.tp / max) * (H - 2)
          const slH = (d.sl / max) * (H - 2)
          const unresolvedH = ((d.samples - resolved) / max) * (H - 2)
          const x = i * slot + slot * 0.2
          const w = slot * 0.6
          let y = H - 1
          const parts: React.ReactNode[] = []
          // 自下而上堆：止损 → 止盈 → 未判定（灰、最上），每段之间留 1 单位间隙
          // Stacked bottom-up: losses, wins, then unresolved in grey on top,
          // with a 1-unit gap between segments
          if (slH > 0) { y -= slH; parts.push(<rect key="sl" x={x} y={y} width={w} height={slH} fill={SL_COLOR} opacity={0.75} />) }
          if (tpH > 0) { y -= tpH + (slH > 0 ? 1 : 0); parts.push(<rect key="tp" x={x} y={y} width={w} height={tpH} fill={TP_COLOR} opacity={0.85} />) }
          if (unresolvedH > 0.5) { y -= unresolvedH + 1; parts.push(<rect key="u" x={x} y={y} width={w} height={unresolvedH} fill="rgba(255,255,255,0.12)" />) }
          return (
            <g key={i}>
              <title>{t('admin.winrate.chart.dailyAriaDay', { n: i + 1, tp: d.tp, sl: d.sl })}</title>
              {parts}
            </g>
          )
        })}
        <line x1={0} y1={H - 0.5} x2={100} y2={H - 0.5} stroke="rgba(255,255,255,0.08)"
              strokeWidth="1" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-neutral-500">
        <span>{t('admin.winrate.chart.oldest')}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <i className="h-2 w-2 rounded-sm" style={{ backgroundColor: TP_COLOR }} />
            <span className="tabular-nums">{totalTp}</span>
          </span>
          <span className="flex items-center gap-1">
            <i className="h-2 w-2 rounded-sm" style={{ backgroundColor: SL_COLOR }} />
            <span className="tabular-nums">{totalSl}</span>
          </span>
        </span>
        <span>{t('admin.winrate.chart.latest')}</span>
      </div>
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
