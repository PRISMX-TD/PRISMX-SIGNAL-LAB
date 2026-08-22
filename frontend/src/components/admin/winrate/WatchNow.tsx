// 「现在该盯什么」：整页的第一层，三句话。
//   现在是哪个盘、还剩多久 → 这个盘近 N 天准不准 → 这个盘里哪些品种更准 / 要小心
//   → 下一个盘几点开、准不准。
//
// 以"现在"为锚：时段 × 当前时刻 = 一句结论（"现在值得盯 / 现在不是好时候，3h 后
// 欧洲盘开始"），不让读者自己去表里找。品种只列**在当前时段里**明显更准的前三个
// （数据来自 overall.symbols[].sessions，跨全部策略合并），要小心的最多两个；没有
// 明显更准的就直说"没有"，不硬凑。欧洲盘与纽约盘重叠的四小时里两个盘都在进行，
// 就各给一块；不在任何盘内时用「其他时段」那一桶。
//
// 排序键是 Wilson 下限（后端推荐榜同一规则），不是原始胜率：5 笔 80% 会沉到
// 300 笔 61% 后面。这里只排品种，不排策略——策略维度整层不出现，点「看细节」才有。
//
// "What to watch now": the page's first layer, three sentences — which session
// is open and how long is left → how that session did over the last N days →
// which symbols do better / need care in that session → when the next session
// opens and how it does. Anchored on "now": session × current time collapses to
// one conclusion instead of a table to scan. Symbols are the top three clearly
// better *within the current session* (overall.symbols[].sessions, pooled
// across strategies) plus at most two clearly worse; when nothing is clearly
// better it says so rather than padding. During the London/New York overlap
// both sessions get a block; outside all three, the "outside" bucket is used.
// Ordering is by Wilson lower bound (the backend's own ranking key), so 80% of
// 5 sinks below 61% of 300. Only symbols are ordered — strategies never appear
// in this layer at all.
import { useTranslation } from 'react-i18next'
import type { AdminStrategyWinRate, WinRateBucket } from '../../../api/types'
import SessionTimeline from './SessionTimeline'
import { VerdictChip, VerdictGlyph } from './Verdict'
import {
  SESSION_COLORS, VERDICT_BG, VERDICT_COLOR,
  fmtDurationHm, fmtInt, fmtPct, isRated, sessionStatus, verdictOf,
} from './shared'

const TOP_GOOD = 3
const TOP_BAD = 2

type Pick = { symbol: string; bucket: WinRateBucket }

function pickSymbols(data: AdminStrategyWinRate, sessionKey: string): { good: Pick[]; bad: Pick[] } {
  const good: Pick[] = []
  const bad: Pick[] = []
  for (const s of data.overall.symbols) {
    const bucket = s.sessions[sessionKey]
    if (!bucket) continue
    const kind = verdictOf(bucket)
    if (kind === 'strong') good.push({ symbol: s.symbol, bucket })
    else if (kind === 'weak') bad.push({ symbol: s.symbol, bucket })
  }
  // 选哪几个按 Wilson 下限（把薄样本沉下去），选出来之后按原始胜率排——入选的都
  // 已经是"明显更准"，读者看到 62.7% 排在 59.7% 后面只会困惑，不会多学到什么。
  // Select by Wilson lower bound (thin samples sink), then display by raw rate —
  // everything selected is already "clearly better", and 62.7% listed after
  // 59.7% only confuses without teaching anything.
  good.sort((a, b) => (b.bucket.wilsonLow ?? 0) - (a.bucket.wilsonLow ?? 0))
  bad.sort((a, b) => (a.bucket.wilsonHigh ?? 1) - (b.bucket.wilsonHigh ?? 1))
  const byRateDesc = (a: Pick, b: Pick) => (b.bucket.winRate ?? 0) - (a.bucket.winRate ?? 0)
  return {
    good: good.slice(0, TOP_GOOD).sort(byRateDesc),
    bad: bad.slice(0, TOP_BAD).sort((a, b) => -byRateDesc(a, b)),
  }
}

function SymbolChip({ symbol, bucket, kind }: { symbol: string; bucket: WinRateBucket; kind: 'strong' | 'weak' }) {
  const { t } = useTranslation()
  const title = t('admin.winrate.aria.tug', {
    label: symbol, tp: bucket.hitTp, sl: bucket.hitSl, rate: fmtPct(bucket.winRate!),
  })
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm"
      style={{ background: VERDICT_BG[kind], color: VERDICT_COLOR[kind] }}
      title={title}
    >
      {/* ↑/↓ 图形：好坏不能只靠颜色分 / the glyph: strong vs weak must not rest on colour alone */}
      <VerdictGlyph kind={kind} />
      <span className="font-semibold text-neutral-100">{symbol}</span>
      <span className="font-semibold tabular-nums">{fmtPct(bucket.winRate!)}</span>
      <span className="text-2xs tabular-nums text-neutral-500">
        {t('admin.winrate.detail.trades', { count: bucket.resolved, n: fmtInt(bucket.resolved) })}
      </span>
    </span>
  )
}

/** 一个时段的"该不该盯"块：名字 + 剩余时间 → 这个时段的判定 → 品种。
 *  One session's "worth watching?" block: name + time left → verdict → symbols. */
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
  const { good, bad } = pickSymbols(data, sessionKey)
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
        {hasRate && (
          <>
            <span className="font-display text-xl font-bold leading-none tabular-nums" style={{ color: VERDICT_COLOR[kind] }}>
              {fmtPct(bucket!.winRate!)}
            </span>
            <span className="text-2xs tabular-nums text-neutral-500">
              {t('admin.winrate.detail.trades', { count: bucket!.resolved, n: fmtInt(bucket!.resolved) })}
            </span>
          </>
        )}
        <VerdictChip kind={kind} bucket={bucket} size="sm" />
      </p>

      <div className="mt-4">
        <p className="text-2xs uppercase tracking-wider text-neutral-500">{t('admin.winrate.watch.symbolsGood')}</p>
        {good.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {good.map((p) => <SymbolChip key={p.symbol} symbol={p.symbol} bucket={p.bucket} kind="strong" />)}
          </div>
        ) : (
          <p className="mt-1.5 text-sm text-neutral-500">{t('admin.winrate.watch.symbolsNone', { days: data.days })}</p>
        )}
        {bad.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="text-2xs uppercase tracking-wider text-neutral-500">{t('admin.winrate.watch.symbolsBad')}</span>
            {bad.map((p) => <SymbolChip key={p.symbol} symbol={p.symbol} bucket={p.bucket} kind="weak" />)}
          </div>
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
              {nextHasRate && (
                <span className="font-semibold tabular-nums" style={{ color: VERDICT_COLOR[nextKind] }}>
                  {fmtPct(nextBucket!.winRate!)}
                </span>
              )}
              <VerdictChip kind={nextKind} bucket={nextBucket} size="sm" />
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
