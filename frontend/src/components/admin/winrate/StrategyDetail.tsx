// 单个策略的细节：三个问题，每个问题一块。
//   哪个时段更准？ / 做多还是做空更准？ / 一天里哪个小时更准？
// 标题直接是问句——新手不需要知道"分时段胜率"这种术语，只需要找到自己想问
// 的那个问题。每一行都是同一套读法：名字、百分比（颜色即判定）、拔河条。
// 钟点格后端只给止盈/止损笔数，这里用同一条 Wilson 公式补出区间，再走同一个
// verdictOf——整页一条规则，不给钟点格开特例。
//
// 「星期几更准」换成了「哪个小时更准」：产品要回答的是"一天里什么时候该盯"，
// 星期几回答不了。「一般多久出结果」整块删除。
//
// One strategy in depth: three questions, one block each — which session, long
// or short, which hour of the day. Titles are literal questions so a newcomer
// finds the one they are asking instead of decoding a term. Every row reads the
// same way: name, percentage (colour is the verdict), tug bar. Hour cells get
// their interval from the same Wilson formula and the same verdictOf — one rule
// for the page, no exception for them. The weekday grid became an hour grid
// because the product question is "when in the day should I watch", which a
// weekday cannot answer; the time-to-resolution block is gone entirely.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { HourOutcome, SessionWindow, StrategyWinRate, SymbolWinRate, WinRateBucket } from '../../../api/types'
import TugBar from './TugBar'
import { VerdictGlyph } from './Verdict'
import {
  SESSION_COLORS, SIDE_COLORS, VERDICT_BG, VERDICT_COLOR,
  fmtClock, fmtPct, isRated, rateFromCounts, verdictOf,
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
        <span className="shrink-0 text-sm font-semibold tabular-nums" style={{ color: VERDICT_COLOR[kind] }}>
          {hasRate ? fmtPct(bucket.winRate!) : '—'}
        </span>
      </div>
      {bucket.resolved > 0 && (
        <TugBar className="mt-2" size="sm" hitTp={bucket.hitTp} hitSl={bucket.hitSl} label={aria} />
      )}
    </div>
  )
}

/** 24 个钟点格，按**浏览者本地钟点**升序排。
 *
 *  后端按 UTC 分桶（它不可能知道读者在哪个时区），这里旋转过来：24 格是一个
 *  完整的循环，旋转无损。半小时时区（如 +5:30）也照样成立——每格的标签由
 *  UTC 钟点 + 偏移算出，会显示成「05:30」，格子边界本来就落在本地的半点上。
 *
 *  Twenty-four hour cells ordered by the **viewer's local clock**. The backend
 *  buckets in UTC (it cannot know the reader's zone) and the rotation here is
 *  lossless because 24 slots are a full cycle. Half-hour zones (+5:30 and the
 *  like) work too: each label is derived from the UTC hour plus the offset and
 *  renders as "05:30" — the bucket boundary genuinely falls on the local half
 *  hour. */
function HourGrid({ hourly, now }: { hourly: HourOutcome[]; now: Date }) {
  const { t } = useTranslation()
  const offset = -now.getTimezoneOffset()
  const slots = hourly
    .map((h, utcHour) => ({ ...h, localMinutes: (((utcHour * 60 + offset) % 1440) + 1440) % 1440 }))
    .sort((a, b) => a.localMinutes - b.localMinutes)

  return (
    <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
      {slots.map((s) => {
        const rate = rateFromCounts(s.tp, s.sl)
        const kind = verdictOf(rate)
        const label = fmtClock(s.localMinutes)
        if (!isRated(kind)) {
          return (
            <span key={s.localMinutes} className="rounded-md px-2 py-1.5 text-center"
                  style={{ background: 'rgba(255,255,255,0.03)' }}>
              <span className="block text-2xs tabular-nums text-neutral-600">{label}</span>
              <span className="block text-sm text-neutral-700">—</span>
            </span>
          )
        }
        return (
          <span key={s.localMinutes} className="rounded-md px-2 py-1.5 text-center"
                style={{ background: VERDICT_BG[kind], color: VERDICT_COLOR[kind] }}>
            <span className="block text-2xs tabular-nums text-neutral-500">{label}</span>
            <span className="flex items-center justify-center gap-1">
              {/* 判定图形：一个裸百分比只靠颜色分不出「差不多」和「看不出」两种灰，
                  色弱读者连红绿也分不开。
                  The glyph: on a bare percentage the two greys ("even" vs
                  "unsure") are indistinguishable by colour, and a colour-blind
                  reader cannot separate red from green either. */}
              <VerdictGlyph kind={kind} />
              {/* 读屏器念出判定词：图形和底色对它都不存在 / spoken verdict for AT,
                  which sees neither the glyph nor the tint */}
              <span className="sr-only">{t(`admin.winrate.verdict.${kind}`)}</span>
              <span className="text-sm font-semibold tabular-nums">{fmtPct(rate.winRate!, 0)}</span>
            </span>
          </span>
        )
      })}
    </div>
  )
}

export default function StrategyDetail({ row, sessions, activeKeys, days, now }: {
  row: StrategyWinRate
  sessions: SessionWindow[]
  activeKeys: string[]
  days: number
  // 只用来把 UTC 钟点格旋转成浏览者本地钟点。面板持有唯一的每分钟计时器，
  // 组件一律接收 now，不自己 new Date()。
  // Only used to rotate the UTC hour cells into the viewer's local clock. The
  // panel owns the single per-minute timer; components take `now` rather than
  // calling new Date() themselves.
  now: Date
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
  // 钟点图只在策略层有数据：品种层再按小时切一刀样本太薄，后端不下发。
  // Hourly data exists only at the strategy layer — sliced by hour on top of by
  // symbol the sample is too thin, so the backend omits it.
  const hourly = effectiveTab === 'all' ? row.total.hourly : null
  const sessionKeys = [...sessions.map((s) => s.key), 'outside']

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

      {/* 左列两块（时段 + 方向），右列一块（钟点，24 格）；窄屏按 DOM 顺序单列。
          「一般多久出结果」整块已按产品要求删除。
          Two blocks on the left (session + side), one on the right (24 hour
          cells); a single column in DOM order on narrow screens. The
          time-to-resolution block was removed at the product owner's request. */}
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

        {hourly && (
          <Block title={t('admin.winrate.detail.byHour')} hint={t('admin.winrate.detail.byHourHint', { days })}>
            <HourGrid hourly={hourly} now={now} />
          </Block>
        )}
      </div>
    </div>
  )
}
