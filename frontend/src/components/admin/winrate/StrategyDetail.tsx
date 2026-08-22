// 单个策略的细节：四个问题，每个问题一块。
//   哪个时段更准？ / 做多还是做空更准？ / 星期几更准？ / 一般多久出结果？
// 标题直接是问句——新手不需要知道"分时段胜率"这种术语，只需要找到自己想问
// 的那个问题。每一行都是同一套读法：名字、百分比、判定芯片、拔河条。
// 星期格后端只给止盈/止损笔数，这里用同一条 Wilson 公式补出区间，再走同一个
// verdictOf——整页一条规则，不给星期格开特例。
//
// One strategy in depth: four questions, one block each — which session, long
// or short, which weekday, how long to an outcome. Titles are literal questions
// so a newcomer finds the one they are asking instead of decoding a term. Every
// row reads the same way: name, percentage, verdict chip, tug bar. Weekday cells
// get their interval from the same Wilson formula and the same verdictOf — one
// rule for the page, no weekday exception.
import { Fragment, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionWindow, StrategyWinRate, SymbolWinRate, WeekdayOutcome, WinRateBucket } from '../../../api/types'
import TugBar from './TugBar'
import { VerdictChip, VerdictGlyph } from './Verdict'
import {
  SESSION_COLORS, SIDE_COLORS, VERDICT_BG, VERDICT_COLOR,
  fmtDurationText, fmtPct, isRated, rateFromCounts, verdictOf, type VerdictKind,
} from './shared'

function Block({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg p-4" style={{ background: 'var(--nest)' }}>
      <h4 className="text-sm font-semibold text-neutral-100">{title}</h4>
      {/* 提示用 12px 而不是 10px：这几行带着该块最重要的口径说明，手机上 10px
          中文会是整页最难读的字。/ 12px, not 10px: these lines carry the block's
          key caveats and 10px Chinese is the least legible text on a phone. */}
      {hint && <p className="mt-0.5 text-xs leading-5 text-neutral-500">{hint}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

function RateRow({ label, dotColor, bucket, tag }: {
  label: string; dotColor: string; bucket: WinRateBucket; tag?: string
}) {
  const { t } = useTranslation()
  const kind = verdictOf(bucket)
  const hasRate = isRated(kind) && bucket.winRate !== null
  const aria = t('admin.winrate.aria.tug', {
    label, tp: bucket.hitTp, sl: bucket.hitSl, rate: hasRate ? fmtPct(bucket.winRate!) : '—',
  })
  return (
    <div className="border-t border-white/5 py-2.5 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2 text-sm text-neutral-200">
          <i className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: dotColor }} />
          <span className="truncate">{label}</span>
          {tag && (
            <span className="shrink-0 rounded-full px-1.5 py-px text-2xs font-medium"
                  style={{ color: dotColor, background: 'rgba(255,255,255,0.06)' }}>{tag}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {hasRate && (
            <span className="text-sm font-semibold tabular-nums" style={{ color: VERDICT_COLOR[kind] }}>
              {fmtPct(bucket.winRate!)}
            </span>
          )}
          <VerdictChip kind={kind} size="sm" />
        </span>
      </div>
      {bucket.resolved > 0 && (
        <TugBar className="mt-2" size="sm" hitTp={bucket.hitTp} hitSl={bucket.hitSl} label={aria} />
      )}
    </div>
  )
}

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']

function WeekdayGrid({ weekday }: { weekday: WeekdayOutcome[] }) {
  const { t } = useTranslation()
  const cell = (tp: number, sl: number) => {
    const rate = rateFromCounts(tp, sl)
    const kind = verdictOf(rate)
    if (kind === 'none') {
      return <span className="block rounded-md py-2 text-center text-neutral-700">—</span>
    }
    if (kind === 'thin') {
      return (
        <span className="block rounded-md py-2 text-center text-xs text-neutral-500"
              style={{ background: VERDICT_BG[kind] }}>
          {t('admin.winrate.verdict.thin')}
        </span>
      )
    }
    // 格子里放不下整枚芯片，但判定图形（↑ ↓ = ?）必须在：灰色的「差不多」和
    // 「看不出」只靠颜色分不开，色弱读者连红绿都分不开。
    // No room for a whole chip, but the glyph must be there: the two greys
    // ("even" vs "unsure") are indistinguishable by colour alone, and a
    // colour-blind reader can't separate red from green either.
    return (
      <span className="flex items-center justify-center gap-1.5 rounded-md py-1.5"
            style={{ background: VERDICT_BG[kind], color: VERDICT_COLOR[kind] }}>
        <VerdictGlyph kind={kind} />
        {/* 读屏器念出判定词：图形和底色对它都不存在 / spoken verdict for AT,
            which sees neither the glyph nor the tint */}
        <span className="sr-only">{t(`admin.winrate.verdict.${kind}`)}</span>
        <span className="text-sm font-semibold tabular-nums">{fmtPct(rate.winRate!, 0)}</span>
      </span>
    )
  }
  const legend: VerdictKind[] = ['strong', 'weak', 'even', 'unsure']
  return (
    <div>
      {/* 图例贴着格子放：首屏的「怎么读」离这里有一屏远。
          Legend right above the grid: the page-level guide is a screen away. */}
      <div className="mb-3 flex flex-wrap gap-1.5" aria-hidden>
        {legend.map((k) => <VerdictChip key={k} kind={k} size="sm" />)}
      </div>
    <div className="grid grid-cols-[2.5rem_1fr_1fr] gap-x-2 gap-y-1">
      <span />
      {(['BUY', 'SELL'] as const).map((side) => (
        <span key={side} className="flex items-center justify-center gap-1.5 pb-1 text-xs text-neutral-400">
          <i className="h-2 w-2 rounded-full" style={{ backgroundColor: SIDE_COLORS[side] }} />
          {t(`admin.winrate.side.${side}`)}
        </span>
      ))}
      {weekday.map((d, i) => (
        <Fragment key={i}>
          <span className="flex items-center text-xs text-neutral-400">{t(`admin.winrate.weekday.${WEEKDAYS[i]}`)}</span>
          {cell(d.buyTp, d.buySl)}
          {cell(d.sellTp, d.sellSl)}
        </Fragment>
      ))}
    </div>
    </div>
  )
}

export default function StrategyDetail({ row, sessions, activeKeys, days }: {
  row: StrategyWinRate
  sessions: SessionWindow[]
  activeKeys: string[]
  days: number
}) {
  const { t } = useTranslation()
  const [symbolTab, setSymbolTab] = useState<string>('all')
  useEffect(() => { setSymbolTab('all') }, [row.strategy])
  // 派生值兜底：页签指向的品种若不在当前 row 里，同一次 render 内退回「全部」。
  // Derived fallback: a tab naming a symbol absent from this row snaps to "all"
  // within the same render.
  const effectiveTab = row.symbols.some((s) => s.symbol === symbolTab) ? symbolTab : 'all'
  const target: StrategyWinRate | SymbolWinRate =
    effectiveTab === 'all' ? row : row.symbols.find((s) => s.symbol === effectiveTab)!
  // 星期图只在策略层有数据：品种层再切一刀样本太薄，后端不下发。
  // Weekday data exists only at the strategy layer.
  const weekday = effectiveTab === 'all' ? row.total.weekday : null
  const sessionKeys = [...sessions.map((s) => s.key), 'outside']
  const holdingRows = sessionKeys.filter((k) => target.sessions[k]?.avgResolveSeconds != null)

  const pill = (active: boolean) =>
    `rounded-full px-3 py-1 text-xs transition active:scale-[0.97] ${
      active ? 'bg-prism-500/25 text-prism-100 ring-1 ring-prism-400/40' : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
    }`

  return (
    <div className="border-t border-white/5 px-5 pb-6 pt-5 md:px-6">
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-xs text-neutral-500">{t('admin.winrate.detail.intro')}</span>
        {row.symbols.length > 0 && (
          <div className="flex flex-wrap gap-1.5" role="tablist">
            <button type="button" role="tab" aria-selected={effectiveTab === 'all'}
                    onClick={() => setSymbolTab('all')} className={pill(effectiveTab === 'all')}>
              {t('admin.winrate.detail.allSymbols')}
            </button>
            {row.symbols.map((s) => (
              <button key={s.symbol} type="button" role="tab" aria-selected={effectiveTab === s.symbol}
                      onClick={() => setSymbolTab(s.symbol)} className={`${pill(effectiveTab === s.symbol)} tabular-nums`}>
                {s.symbol}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 两列各自堆叠（时段+方向 / 星期+时长），左右高度大致相当；窄屏按
          DOM 顺序单列。Two stacked columns (session+side / weekday+holding)
          so the heights roughly match; a single column in DOM order on narrow screens. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Block title={t('admin.winrate.detail.bySession')} hint={t('admin.winrate.detail.bySessionHint')}>
            {sessionKeys.map((k) => target.sessions[k] && (
              <RateRow key={k} label={t(`admin.winrate.session.${k}`)} dotColor={SESSION_COLORS[k] ?? SESSION_COLORS.outside}
                       bucket={target.sessions[k]}
                       tag={activeKeys.includes(k) ? t('admin.winrate.timeline.openNow') : undefined} />
            ))}
          </Block>

          <Block title={t('admin.winrate.detail.bySide')} hint={t('admin.winrate.detail.bySideHint')}>
            {(['BUY', 'SELL'] as const).map((k) => target.sides[k] && (
              <RateRow key={k} label={t(`admin.winrate.side.${k}`)} dotColor={SIDE_COLORS[k]} bucket={target.sides[k]} />
            ))}
          </Block>
        </div>

        <div className="space-y-4">
        {weekday && (
          <Block title={t('admin.winrate.detail.byWeekday')} hint={t('admin.winrate.detail.byWeekdayHint', { days })}>
            <WeekdayGrid weekday={weekday} />
          </Block>
        )}

        <Block title={t('admin.winrate.detail.holding')} hint={t('admin.winrate.detail.holdingHint')}>
          {target.total.avgResolveSeconds === null ? (
            <p className="text-xs text-neutral-500">{t('admin.winrate.detail.holdingEmpty')}</p>
          ) : (
            <>
              <div className="flex items-baseline gap-2">
                <span className="font-display text-2xl font-bold leading-none tabular-nums text-neutral-50">
                  {fmtDurationText(t, target.total.avgResolveSeconds)}
                </span>
                <span className="text-xs text-neutral-500">{t('admin.winrate.detail.holdingOverall')}</span>
              </div>
              {holdingRows.length > 0 && (
                <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
                  {holdingRows.map((k) => (
                    <div key={k}>
                      <span className="flex items-center gap-1.5 text-2xs text-neutral-500">
                        <i className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: SESSION_COLORS[k] ?? SESSION_COLORS.outside }} />
                        {t(`admin.winrate.session.${k}`)}
                      </span>
                      <span className="mt-0.5 block text-sm font-medium tabular-nums text-neutral-200">
                        {fmtDurationText(t, target.sessions[k].avgResolveSeconds!)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </Block>
        </div>
      </div>
    </div>
  )
}
