// 首屏：一句话结论。
//
// 新手打开这页只想知道一件事——"平台信号到底准不准"。所以首屏是一个大数字、
// 一枚人话判定芯片、一条"赢 vs 输"的拔河条，再加三个补充数字；统计口径、
// 置信区间这些全部退到文字里或页尾。右侧是"现在是什么盘"——它不是胜率，但
// 盯盘的人每次打开都要看一眼，所以放在首屏而不是单独一张卡。
//
// The hero: one answer. A newcomer opens this page to learn one thing — are the
// platform's signals any good — so the hero is one big number, one plain-words
// verdict chip, one wins-vs-losses tug bar and three supporting facts; the
// methodology and the interval retreat into prose or the footer. The right
// column is "which session is open now": not a win rate, but the thing anyone
// watching the market checks first, so it shares the hero instead of getting
// its own card.
import { useTranslation } from 'react-i18next'
import type { AdminStrategyWinRate } from '../../../api/types'
import SessionTimeline from './SessionTimeline'
import TugBar from './TugBar'
import { VerdictChip } from './Verdict'
import { VERDICT_COLOR, fmtDurationText, fmtInt, fmtPct, isRated, verdictOf } from './shared'

function Fact({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <dt className="text-2xs uppercase tracking-wider text-neutral-500">{label}</dt>
      <dd className="mt-1 text-base font-medium tabular-nums text-neutral-100">{value}</dd>
      {sub && <dd className="text-2xs text-neutral-500">{sub}</dd>}
    </div>
  )
}

export default function HeroSummary({ data, now }: { data: AdminStrategyWinRate; now: Date }) {
  const { t } = useTranslation()
  const total = data.overall.total
  const kind = verdictOf(total)
  const hasRate = isRated(kind) && total.winRate !== null
  const symbols = data.overall.symbols.filter((s) => s.total.samples > 0).length
  const tugLabel = t('admin.winrate.aria.tug', {
    label: t('admin.winrate.hero.all'),
    tp: total.hitTp,
    sl: total.hitSl,
    rate: total.winRate === null ? '—' : fmtPct(total.winRate),
  })

  return (
    <section className="glass animate-fade-in-up p-6 md:p-8">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0">
          <p className="text-sm text-neutral-400">
            {hasRate
              ? t('admin.winrate.hero.lead', { days: data.days, resolved: fmtInt(total.resolved) })
              : total.resolved === 0
                ? t('admin.winrate.hero.leadWaiting', { days: data.days, count: total.samples, n: fmtInt(total.samples) })
                : t('admin.winrate.hero.leadThin', { days: data.days, count: total.resolved })}
          </p>

          {hasRate && (
            <>
              <div className="mt-2 flex flex-wrap items-end gap-x-4 gap-y-3">
                <span
                  className="font-display text-[56px] font-bold leading-none tracking-tight tabular-nums md:text-[64px]"
                  style={{ color: VERDICT_COLOR[kind] }}
                >
                  {fmtPct(total.winRate!)}
                </span>
                <span className="pb-1.5">
                  <VerdictChip kind={kind} bucket={total} />
                </span>
              </div>
              {total.wilsonLow !== null && total.wilsonHigh !== null && (
                <p className="mt-3 text-sm text-neutral-400">
                  {t('admin.winrate.hero.range', { low: fmtPct(total.wilsonLow), high: fmtPct(total.wilsonHigh) })}
                </p>
              )}
            </>
          )}

          {/* 拔河条：赢在左、输在右、中线是一半 / wins left, losses right, the tick is half */}
          <div className="mt-6">
            <div className="relative mb-2 flex items-baseline justify-between text-xs">
              <span className="font-medium" style={{ color: 'var(--up)' }}>
                {t('admin.winrate.hero.wins', { count: total.hitTp, n: fmtInt(total.hitTp) })}
              </span>
              <span className="absolute left-1/2 -translate-x-1/2 text-neutral-500">{t('admin.winrate.hero.half')}</span>
              <span className="font-medium" style={{ color: 'var(--down)' }}>
                {t('admin.winrate.hero.losses', { count: total.hitSl, n: fmtInt(total.hitSl) })}
              </span>
            </div>
            <TugBar hitTp={total.hitTp} hitSl={total.hitSl} size="lg" label={tugLabel} />
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-white/5 pt-5 sm:grid-cols-3">
            <Fact
              label={t('admin.winrate.hero.holding')}
              value={total.avgResolveSeconds === null ? '—' : fmtDurationText(t, total.avgResolveSeconds)}
            />
            <Fact
              label={t('admin.winrate.hero.pending')}
              value={t('admin.winrate.hero.pendingValue', { count: total.pending, n: fmtInt(total.pending) })}
              sub={total.stale > 0 ? t('admin.winrate.hero.stale', { count: total.stale, n: fmtInt(total.stale) }) : undefined}
            />
            <Fact
              label={t('admin.winrate.hero.coverage')}
              value={`${t('admin.winrate.hero.coverageStrategies', { count: data.strategies.length })} · ${t('admin.winrate.hero.coverageSymbols', { count: symbols })}`}
            />
          </dl>
        </div>

        <aside className="min-w-0 lg:border-l lg:border-white/5 lg:pl-8">
          <h3 className="mb-3 text-2xs uppercase tracking-wider text-neutral-500">{t('admin.winrate.hero.nowTitle')}</h3>
          <SessionTimeline sessions={data.sessions} now={now} />
        </aside>
      </div>
    </section>
  )
}
