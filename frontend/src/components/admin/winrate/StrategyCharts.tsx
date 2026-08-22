// 单个策略的四张图，三种不同的图形语言——刻意不统一成同一种条形图。
//
// 之前四张全是同样的横向堆叠条，眼睛没有落点、扫不出层次，而且四个问题的性质
// 本来就不同：胜率是"带不确定性的估计值"，星期×方向是"矩阵找规律"，持仓时间
// 是"四个数字"。同一种图形服务不了三种问题。
//
// ① 分时段 / ② 做多做空 → 置信区间点图。**区间宽窄就是样本厚薄的可视化**：
//    5 笔的 50% 区间宽 0.527，1296 笔的 50% 宽 0.064，差 8 倍。这是改版前最要命
//    的缺陷——`88.0% 22/25` 和 `47.6% 440/925` 用同样长度的条画出来，925 笔的
//    结论和 25 笔的结论看起来一样确定，笔数只是右边一行小灰字。
// ③ 星期 × 方向 → 热力矩阵。与量化回测报告里的"月度收益热力图"同一形状，
//    颜色编码好坏、位置编码维度，14 个格子一眼扫完；用长度编码则要来回比。
// ④ 平均持仓时间 → 就是几个数字。值落在 2.2–3.0 天，从 0 起画的条几乎一样长，
//    读者仍要去看右边数字才知道差别——那说明条形没传递信息，纯装饰。
//
// Four charts in three visual languages, deliberately not one shared bar style.
// Win rates are estimates carrying uncertainty (dot plot with intervals), the
// weekday matrix is a pattern-finding surface (heatmap, the same shape as the
// monthly-returns heatmap in any backtest report), and time-to-resolution is
// just a few numbers (bars from zero for 2.2 vs 3.0 days convey nothing).
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import type { WeekdayOutcome, WinRateBucket } from '../../../api/types'
import { MIN_SAMPLES, SESSION_COLORS, fmtDuration } from './shared'

const TP_COLOR = '#34d399'
const SL_COLOR = '#fb7185'

// 方向色刻意不用胜负色：做多/做空是身份分类不是好坏，用绿红会读成"做多=好"。
// Direction colours avoid the win/loss palette: long and short are identities,
// not outcomes, and green/red would read as "long = good".
const SIDE_COLORS: Record<string, string> = { BUY: '#60a5fa', SELL: '#f0abfc' }

function useDurationText() {
  const { t } = useTranslation()
  return (seconds: number) => {
    const { value, unit } = fmtDuration(seconds)
    return `${value} ${t(`admin.winrate.unit.${unit}`)}`
  }
}

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

// ---------- ①② 置信区间点图 / dot plot with confidence intervals ----------

/** 区间完全落在 50% 一侧才算"统计上确实好/差"；跨过 50% 就是"还说不准"。
 *  这条判断是点图存在的理由——它把"这个数字能不能当结论"变成颜色，而不是
 *  留给读者自己去比笔数。
 *  A rate only reads as reliably better (or worse) than a coin flip when the
 *  whole interval sits on one side of 50%. Straddling 50% means "not yet
 *  distinguishable" — which is what the colour encodes, so the reader doesn't
 *  have to weigh sample counts themselves. */
function verdictColor(low: number, high: number): string {
  if (low > 0.5) return TP_COLOR
  if (high < 0.5) return SL_COLOR
  return '#a1a1aa'
}

function IntervalRow({ label, dotColor, bucket }: {
  label: string; dotColor: string; bucket: WinRateBucket
}) {
  const { t } = useTranslation()
  const { winRate, wilsonLow, wilsonHigh, resolved, hitTp } = bucket

  const head = (
    <span className="flex w-20 shrink-0 items-center gap-1.5 text-neutral-400">
      <i className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} />
      <span className="truncate">{label}</span>
    </span>
  )

  if (bucket.samples === 0) {
    return (
      <div className="flex items-center gap-3 py-1.5 text-[11px]">
        {head}<span className="text-neutral-600">—</span>
      </div>
    )
  }
  if (winRate === null || wilsonLow === null || wilsonHigh === null || resolved < MIN_SAMPLES) {
    return (
      <div className="flex items-center gap-3 py-1.5 text-[11px]">
        {head}
        <span className="text-neutral-500">{t('admin.winrate.thinSample', { count: resolved })}</span>
      </div>
    )
  }

  const colour = verdictColor(wilsonLow, wilsonHigh)
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`
  const desc = t('admin.winrate.chart.intervalAria', {
    label, rate: pct(winRate), low: pct(wilsonLow), high: pct(wilsonHigh), tp: hitTp, n: resolved,
  })

  return (
    <div className="flex items-center gap-3 py-1.5 text-[11px]">
      {head}
      {/* 只约束宽度不给固定高度：preserveAspectRatio="none" 下强设高度会把图形
          压变形。轴恒为 0–100%，几行共用同一根轴才能横着比。
          Width-only sizing; the axis is always 0-100% so the rows share a scale. */}
      <svg viewBox="0 0 100 14" className="h-3.5 w-full min-w-[110px]" preserveAspectRatio="none"
           role="img" aria-label={desc}>
        <title>{desc}</title>
        <line x1={0} y1={7} x2={100} y2={7} stroke="rgba(255,255,255,0.07)"
              strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {/* 50% 参考线：胜率的意义永远相对于抛硬币 / the coin-flip reference */}
        <line x1={50} y1={1} x2={50} y2={13} stroke="rgba(255,255,255,0.22)"
              strokeWidth="1" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
        {/* 置信区间横杠：宽度 = 不确定性 / the whisker: its width is the uncertainty */}
        <rect x={wilsonLow * 100} y={5.5} width={Math.max(0.6, (wilsonHigh - wilsonLow) * 100)}
              height={3} rx={1.5} fill={colour} opacity={0.28} />
        <line x1={wilsonLow * 100} y1={3} x2={wilsonLow * 100} y2={11}
              stroke={colour} strokeWidth="1" opacity={0.55} vectorEffect="non-scaling-stroke" />
        <line x1={wilsonHigh * 100} y1={3} x2={wilsonHigh * 100} y2={11}
              stroke={colour} strokeWidth="1" opacity={0.55} vectorEffect="non-scaling-stroke" />
        {/* 点估计。preserveAspectRatio="none" 会把 circle 压成椭圆，所以用纵向
            铺满的窄矩形，视觉上是一根标记线、不随容器宽度变形。
            A circle would be squashed by preserveAspectRatio="none", so the point
            estimate is a narrow full-height rect instead. */}
        <rect x={Math.min(99, Math.max(0, winRate * 100 - 0.6))} y={1.5} width={1.2} height={11}
              rx={0.6} fill={colour} />
      </svg>
      <span className="w-[86px] shrink-0 whitespace-nowrap text-right">
        <span className="text-[12px] font-medium tabular-nums" style={{ color: colour }}>
          {(winRate * 100).toFixed(1)}%
        </span>
        <span className="ml-1 text-[10px] tabular-nums text-neutral-500">{hitTp}/{resolved}</span>
      </span>
    </div>
  )
}

function IntervalLegend() {
  const { t } = useTranslation()
  return (
    <p className="mt-2 border-t border-white/5 pt-2 text-[10px] leading-4 text-neutral-600">
      {t('admin.winrate.chart.intervalLegend')}
    </p>
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
        <IntervalRow key={k} label={t(`admin.winrate.session.${k}`)}
                     dotColor={SESSION_COLORS[k] ?? '#71717a'} bucket={buckets[k]} />
      ))}
      <IntervalLegend />
    </ChartCard>
  )
}

/** ② 做多 / 做空胜率 */
export function SideWinRateChart({ sides }: { sides: Record<string, WinRateBucket> }) {
  const { t } = useTranslation()
  return (
    <ChartCard title={t('admin.winrate.chart.sides')} caption={t('admin.winrate.chart.sidesHint')}>
      {['BUY', 'SELL'].map((k) => sides[k] && (
        <IntervalRow key={k} label={t(`admin.winrate.side.${k}`)}
                     dotColor={SIDE_COLORS[k]} bucket={sides[k]} />
      ))}
      <IntervalLegend />
    </ChartCard>
  )
}

// ---------- ③ 星期 × 方向热力矩阵 / weekday x direction heatmap ----------

/** 发散色标，以 50% 为中点：越高越绿、越低越红，50% 附近保持中性灰。
 *  用底色而不是长度编码胜率，是热力图相对条形图的核心优势——14 个格子用长度
 *  比要来回扫，用颜色一眼看出块状分布。
 *  A diverging scale centred on 50%. Colour, not length, carries the rate: with
 *  14 cells, length demands scanning back and forth while colour surfaces the
 *  pattern at a glance. */
function heatColor(rate: number): { bg: string; fg: string } {
  // 距 50% 的远近，0.85 / 0.15 处封顶 / distance from 50%, clamped at 0.85 / 0.15
  const d = Math.min(1, Math.abs(rate - 0.5) / 0.35)
  if (d < 0.12) return { bg: 'rgba(161,161,170,0.10)', fg: '#d4d4d8' }
  const base = rate > 0.5 ? '52,211,153' : '251,113,133'
  return {
    bg: `rgba(${base},${(0.12 + d * 0.38).toFixed(2)})`,
    fg: rate > 0.5 ? '#a7f3d0' : '#fecdd3',
  }
}

export function WeekdayOutcomeChart({ weekday }: { weekday: WeekdayOutcome[] }) {
  const { t } = useTranslation()
  const labels = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

  const cell = (tp: number, sl: number) => {
    const n = tp + sl
    if (n === 0) {
      return <span className="block rounded-md py-1.5 text-center text-neutral-700">—</span>
    }
    if (n < MIN_SAMPLES) {
      return (
        <span className="block rounded-md bg-white/[0.03] py-1.5 text-center text-[10px] tabular-nums text-neutral-500"
              title={t('admin.winrate.chart.cellHint', { tp, sl })}>
          {t('admin.winrate.thinSample', { count: n })}
        </span>
      )
    }
    const rate = tp / n
    const { bg, fg } = heatColor(rate)
    return (
      <span className="block rounded-md py-1.5 text-center" style={{ backgroundColor: bg }}
            title={t('admin.winrate.chart.cellHint', { tp, sl })}>
        <span className="text-[12px] font-semibold tabular-nums" style={{ color: fg }}>
          {(rate * 100).toFixed(0)}%
        </span>
        {/* 笔数直接印在格子里，不藏进 tooltip——dataviz 的反模式明确禁止
            "数值只能靠 hover 读到"。/ Count printed in the cell, never hover-only. */}
        <span className="ml-1 text-[9px] tabular-nums text-neutral-400">{n}</span>
      </span>
    )
  }

  return (
    <ChartCard title={t('admin.winrate.chart.weekday')} caption={t('admin.winrate.chart.weekdayHint')}>
      <div className="grid grid-cols-[2.5rem_1fr_1fr] gap-x-2 gap-y-1">
        <span />
        <span className="flex items-center justify-center gap-1.5 pb-1 text-[11px] text-neutral-400">
          <i className="h-2 w-2 rounded-full" style={{ backgroundColor: SIDE_COLORS.BUY }} />
          {t('admin.winrate.side.BUY')}
        </span>
        <span className="flex items-center justify-center gap-1.5 pb-1 text-[11px] text-neutral-400">
          <i className="h-2 w-2 rounded-full" style={{ backgroundColor: SIDE_COLORS.SELL }} />
          {t('admin.winrate.side.SELL')}
        </span>
        {weekday.map((d, i) => (
          <Fragment key={i}>
            <span className="flex items-center text-[11px] text-neutral-500">
              {t(`admin.winrate.weekday.${labels[i]}`)}
            </span>
            {cell(d.buyTp, d.buySl)}
            {cell(d.sellTp, d.sellSl)}
          </Fragment>
        ))}
      </div>
      <p className="mt-2 border-t border-white/5 pt-2 text-[10px] leading-4 text-neutral-600">
        {t('admin.winrate.chart.heatLegend')}
      </p>
    </ChartCard>
  )
}

// ---------- ④ 平均持仓时间：数字，不画图 ----------

/** 时长用数字而不是条形：值落在 2.2–3.0 天，从 0 起画的条几乎一样长，读者仍要
 *  去看右边数字才知道差别——那说明条形没传递任何信息。
 *  Numbers, not bars: values between 2.2 and 3.0 days render as near-identical
 *  bars from zero, so the bar conveys nothing the number doesn't already. */
export function HoldingTimeChart({ sessions, buckets, total }: {
  sessions: { key: string }[]; buckets: Record<string, WinRateBucket>; total: WinRateBucket
}) {
  const { t } = useTranslation()
  const durText = useDurationText()
  const keys = [...sessions.map((s) => s.key), 'outside']
  const rows = keys.filter((k) => buckets[k]?.avgResolveSeconds != null)

  return (
    <ChartCard title={t('admin.winrate.chart.holding')} caption={t('admin.winrate.chart.holdingHint')}>
      {total.avgResolveSeconds !== null && (
        <div className="mb-3 flex items-baseline gap-2">
          <span className="font-display text-3xl font-semibold tabular-nums text-neutral-50">
            {durText(total.avgResolveSeconds)}
          </span>
          <span className="text-[11px] text-neutral-500">{t('admin.winrate.chart.holdingOverall')}</span>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-[11px] text-neutral-600">{t('admin.winrate.chart.holdingEmpty')}</p>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
          {rows.map((k) => (
            <div key={k}>
              <span className="flex items-center gap-1.5 text-[10px] text-neutral-500">
                <i className="h-1.5 w-1.5 rounded-full"
                   style={{ backgroundColor: SESSION_COLORS[k] ?? '#71717a' }} />
                {t(`admin.winrate.session.${k}`)}
              </span>
              <span className="mt-0.5 block text-[15px] font-medium tabular-nums text-neutral-200">
                {durText(buckets[k].avgResolveSeconds!)}
              </span>
            </div>
          ))}
        </div>
      )}
    </ChartCard>
  )
}
