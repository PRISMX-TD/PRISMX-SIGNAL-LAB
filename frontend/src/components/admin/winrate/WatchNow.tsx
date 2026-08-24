// 「现在该盯什么」：整页的第一层，三句话。
//   现在是哪个盘、还剩多久 → 这个盘近 N 天胜率 → 这个盘里可以留意的品种
//   → 下一个盘几点开、胜率如何。
//
// 以"现在"为锚：时段 × 当前时刻 = 一句结论（"现在值得盯 / 现在不是好时候，3h 后
// 欧洲盘开始"），不让读者自己去表里找。「可以留意」列**在当前时段里**近 N 天表现
// 较好的品种前三个（胜率不低于一半、样本够判定），不要求"统计上明显更高"——产品
// 要的是"最近表现较好的"，芯片前的图形（↑ = ?）会告诉读者每一个有多稳；不列表现
// 差的。没有表现较好的就直说"没有"，不硬凑。欧洲盘与纽约盘重叠的四小时里两个盘都
// 在进行，就各给一块；不在任何盘内时用「其他时段」那一桶。
//
// 选哪几个按 Wilson 下限（把薄样本沉下去），选出来之后按胜率排。这里只排品种，
// 不排策略——策略维度整层不出现，点「看细节」才有。整页不显示笔数，也不显示写着
// 判定的芯片（产品要求）：胜率数字的颜色本身就是判定，绿=明显高于一半、红=明显
// 低于一半、灰=看不出。
//
// "What to watch now": the page's first layer, three sentences — which session
// is open and how long is left → its win rate over the last N days → symbols
// worth a look in that session → when the next session opens and how it does.
// Anchored on "now". "Worth a look" lists the top three symbols that did better
// *within the current session* (rate at least half, enough trades for a
// verdict) — not required to be "clearly better": the product wants "recently
// doing well", and the verdict glyph (↑ = ?) says how firm each one is. No
// "careful" list. During the London/New York overlap both sessions get a block;
// outside all three, the "outside" bucket is used. Selection is by Wilson lower
// bound (thin samples sink), display is by rate. Neither trade counts nor worded
// verdict chips appear anywhere (product decision): the colour of the percentage
// is the verdict — green above half, red below, grey undecided.
import { useTranslation } from 'react-i18next'
import type { AdminStrategyWinRate, WinRateBucket } from '../../../api/types'
import SessionTimeline from './SessionTimeline'
import { VerdictGlyph } from './Verdict'
import {
  SESSION_COLORS, VERDICT_BG, VERDICT_COLOR,
  fmtDurationHm, fmtPct, isRated, sessionStatus, verdictOf, type VerdictKind,
} from './shared'

const TOP_WATCH = 3

type Pick = { symbol: string; bucket: WinRateBucket; kind: VerdictKind }

function pickSymbols(data: AdminStrategyWinRate, sessionKey: string): Pick[] {
  const candidates: Pick[] = []
  for (const s of data.overall.symbols) {
    const bucket = s.sessions[sessionKey]
    if (!bucket) continue
    const kind = verdictOf(bucket)
    if (!isRated(kind) || bucket.winRate === null || bucket.winRate < 0.5) continue
    candidates.push({ symbol: s.symbol, bucket, kind })
  }
  candidates.sort((a, b) => (b.bucket.wilsonLow ?? 0) - (a.bucket.wilsonLow ?? 0))
  return candidates
    .slice(0, TOP_WATCH)
    .sort((a, b) => (b.bucket.winRate ?? 0) - (a.bucket.winRate ?? 0))
}

function SymbolChip({ symbol, bucket, kind }: Pick) {
  const { t } = useTranslation()
  const aria = t('admin.winrate.aria.tug', {
    label: symbol, tp: bucket.hitTp, sl: bucket.hitSl, rate: fmtPct(bucket.winRate!),
  })
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm"
      style={{ background: VERDICT_BG[kind], color: VERDICT_COLOR[kind] }}
      aria-label={aria}
    >
      {/* ↑ = ? 图形：这一个有多稳，不只靠颜色 / the glyph says how firm, not colour alone */}
      <VerdictGlyph kind={kind} />
      <span className="font-semibold text-neutral-100">{symbol}</span>
      <span className="font-semibold tabular-nums">{fmtPct(bucket.winRate!)}</span>
    </span>
  )
}

/** 一个时段的"该不该盯"块：名字 + 剩余时间 → 这个时段的胜率 → 可以留意的品种。
 *  One session's "worth watching?" block: name + time left → rate → symbols worth a look. */
function SessionBlock({ data, sessionKey, title, sessionName, minutesLeft }: {
  data: AdminStrategyWinRate
  sessionKey: string
  // 标题句（"现在：欧洲盘" / "现在不在三大时段内"）与时段名分开传：胜率那句要
  // 点名"欧洲盘近 30 天胜率"，不能说"这个时段"——"下一个"那行也用同一句式，
  // "这个时段"在那里会指错对象。
  // The heading sentence and the bare session name are separate props: the
  // rate sentence names the session ("European, last 30 days") instead of
  // saying "this session", which on the "Next" line would point at the wrong one.
  title: string
  sessionName: string
  minutesLeft?: number
}) {
  const { t } = useTranslation()
  const bucket = data.overall.sessions[sessionKey]
  const kind = bucket ? verdictOf(bucket) : 'none'
  const hasRate = !!bucket && isRated(kind) && bucket.winRate !== null
  const picks = pickSymbols(data, sessionKey)
  const color = SESSION_COLORS[sessionKey] ?? SESSION_COLORS.outside

  return (
    <div>
      {/* 真正的标题用 h3：读屏器按标题跳转时能落到"现在：欧洲盘"上。
          A real h3 so heading navigation lands on "Now: European". */}
      <h3 className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="flex items-center gap-2 font-display text-xl font-semibold text-neutral-50">
          <i className={`h-2.5 w-2.5 shrink-0 rounded-full ${minutesLeft !== undefined ? 'animate-breathe' : ''}`}
             style={{ backgroundColor: color }} />
          {title}
        </span>
        {minutesLeft !== undefined && (
          <span className="text-sm font-medium tabular-nums" style={{ color: 'var(--up)' }}>
            {t('admin.winrate.watch.nowLeft', { time: fmtDurationHm(minutesLeft) })}
          </span>
        )}
      </h3>

      <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-neutral-400">
        <span>{t('admin.winrate.watch.sessionRate', { days: data.days, name: sessionName })}</span>
        {/* 判定只剩颜色：绿=明显高于一半、红=明显低于一半、灰=看不出。
            那枚写着判定的芯片已按产品要求删除，全页一处不留。
            The verdict is carried by colour alone now — the worded chip was
            dropped at the product owner's request, everywhere on the page. */}
        <span className="font-display text-xl font-bold leading-none tabular-nums" style={{ color: VERDICT_COLOR[kind] }}>
          {hasRate ? fmtPct(bucket!.winRate!) : '—'}
        </span>
      </p>

      <div className="mt-4">
        <p className="text-2xs uppercase tracking-wider text-neutral-500">
          {t('admin.winrate.watch.symbolsGood')}
          <span className="ml-2 normal-case tracking-normal text-neutral-600">
            {t('admin.winrate.watch.symbolsHint', { days: data.days })}
          </span>
        </p>
        {picks.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {picks.map((p) => <SymbolChip key={p.symbol} {...p} />)}
          </div>
        ) : (
          <p className="mt-1.5 text-sm text-neutral-500">{t('admin.winrate.watch.symbolsNone', { days: data.days })}</p>
        )}
      </div>
    </div>
  )
}

export default function WatchNow({ data, now }: { data: AdminStrategyWinRate; now: Date }) {
  const { t } = useTranslation()
  const statuses = data.sessions.map((s) => ({ s, st: sessionStatus(s, now) }))
  const active = statuses.filter((x) => x.st.state === 'active')
  const next = statuses
    .filter((x): x is { s: typeof x.s; st: { state: 'upcoming'; minutesToStart: number } } => x.st.state === 'upcoming')
    .sort((a, b) => a.st.minutesToStart - b.st.minutesToStart)[0]
  const nextBucket = next ? data.overall.sessions[next.s.key] : undefined
  const nextKind = nextBucket ? verdictOf(nextBucket) : 'none'
  const nextHasRate = !!nextBucket && isRated(nextKind) && nextBucket.winRate !== null

  return (
    <section className="glass animate-fade-in-up p-6 md:p-8">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0">
          <h2 className="text-2xs uppercase tracking-wider text-neutral-500">{t('admin.winrate.watch.title')}</h2>

          <div className="mt-3 space-y-6">
            {active.length > 0 ? (
              active.map(({ s, st }) => (
                <SessionBlock key={s.key} data={data} sessionKey={s.key}
                              title={t('admin.winrate.watch.nowActive', { name: t(`admin.winrate.session.${s.key}`) })}
                              sessionName={t(`admin.winrate.session.${s.key}`)}
                              minutesLeft={st.state === 'active' ? st.minutesToEnd : undefined} />
              ))
            ) : (
              <SessionBlock data={data} sessionKey="outside" title={t('admin.winrate.watch.nowOutside')}
                            sessionName={t('admin.winrate.session.outside')} />
            )}
          </div>

          {next && (
            <p className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-white/5 pt-4 text-sm text-neutral-400">
              <i className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: SESSION_COLORS[next.s.key] }} />
              <span className="text-neutral-200">
                {t('admin.winrate.watch.next', {
                  name: t(`admin.winrate.session.${next.s.key}`), time: fmtDurationHm(next.st.minutesToStart),
                })}
              </span>
              <span>·</span>
              <span>{t('admin.winrate.watch.sessionRate', { days: data.days, name: t(`admin.winrate.session.${next.s.key}`) })}</span>
              <span className="font-semibold tabular-nums" style={{ color: VERDICT_COLOR[nextKind] }}>
                {nextHasRate ? fmtPct(nextBucket!.winRate!) : '—'}
              </span>
            </p>
          )}
        </div>

        <aside className="min-w-0 lg:border-l lg:border-white/5 lg:pl-8">
          <h3 className="mb-3 text-2xs uppercase tracking-wider text-neutral-500">{t('admin.winrate.watch.timelineTitle')}</h3>
          <SessionTimeline sessions={data.sessions} now={now} />
        </aside>
      </div>
    </section>
  )
}
