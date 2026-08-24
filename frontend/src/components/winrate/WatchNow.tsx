// 「现在该盯什么」：整页的第一层。
//   现在是哪个盘、还剩多久 → 这个盘里胜率最高的几个钟点 → 可以留意的品种
//   → 下一个盘还有多久开（只有这一句，不带任何胜率）。
//
// 以"现在"为锚：时段 × 当前时刻 = 一句结论（"现在值得盯 / 现在不是好时候，3h 后
// 欧洲盘开始"），不让读者自己去表里找。
//
// **不再显示时段的整体胜率**（产品要求）：一个盘九个小时揉成一个平均数，既不告诉
// 你该几点动手，也把盘里真正好的那两三个钟点稀释掉了。换成直接列出这个盘里胜率
// 最高的三个钟点——那才是"什么时候该盯"的答案。
//
// 钟点数据从 `overall.total.hourly` 里筛：后端按 UTC 分桶，而某个 UTC 钟点落不落
// 在某个盘里是确定的（时段本来就是按该金融中心本地钟点定义的），所以这里筛出来的
// 就是这个盘的钟点分布，不是近似。唯一的误差是窗口跨夏令时切换时边界那一个钟点，
// 与钟点标签本身的误差同源。
//
// 「可以留意」列**在当前时段里**近 N 天表现较好的品种前三个（胜率不低于一半、样本
// 够判定），不要求"统计上明显更高"——产品要的是"最近表现较好的"；不列表现差的。
// 欧洲盘与纽约盘重叠的四小时里两个盘都在进行，就各给一块；不在任何盘内时用
// 「其他时段」那一桶。
//
// 选哪几个按 Wilson 下限（把薄样本沉下去），选出来之后按胜率排。这里只排钟点和
// 品种，不排策略——策略维度整层不出现，点「看细节」才有。整页不显示笔数，也不显示
// 写着判定的芯片：胜率数字的颜色本身就是判定，绿=明显高于一半、红=明显低于一半、
// 灰=看不出。
//
// "What to watch now": the page's first layer — which session is open and how
// long is left, the best hours inside it, symbols worth a look, and how long
// until the next session opens (that line carries no win rate at all).
//
// **The session's aggregate win rate is gone** (product decision): averaging
// nine hours into one number neither tells you when to act nor survives the
// dilution of the two or three hours that are actually good. The best hours in
// the session replace it — that is the answer to "when should I watch".
//
// Those hours are filtered out of `overall.total.hourly`: the backend buckets by
// UTC, and whether a given UTC hour falls inside a session is determined (a
// session is defined by the clock in its own financial centre), so this is the
// session's real hourly distribution rather than an approximation. The only
// error is the boundary hour when the window spans a DST changeover — the same
// caveat the hour labels already carry.
//
// "Worth a look" lists the top three symbols doing better *within the current
// session* (rate at least half, enough trades for a verdict) — not required to
// be "clearly better": the product wants "recently doing well". During the
// London/New York overlap both
// sessions get a block; outside all three, the "outside" bucket is used.
// Selection is by Wilson lower bound (thin samples sink), display by rate.
// Neither trade counts nor worded verdict chips appear: the colour of the
// percentage is the verdict — green from 51%, amber 40-50%, red below 40%.
import { useTranslation } from 'react-i18next'
import type { AdminStrategyWinRate, SessionWindow } from '../../api/types'
import RateChip from './RateChip'
import SessionTimeline from './SessionTimeline'
import {
  SESSION_COLORS, fmtClock, fmtDurationHm, fmtPct, rankBuckets,
  rankHours, sessionStatus, zoneOffsetMinutes,
} from './shared'

const TOP_WATCH = 3

/** 某个 UTC 钟点落在哪些时段内。与后端 session_keys_for 同一条判断（时段按该金融
 *  中心的本地钟点定义），只是这里一次判一个钟点而不是一条信号。
 *  Which sessions a given UTC hour falls in — the same rule as the backend's
 *  session_keys_for (a session is a range on its centre's own clock), applied to
 *  an hour rather than a signal. */
function sessionsForUtcHour(hour: number, sessions: SessionWindow[], now: Date): string[] {
  const hit = sessions.filter((s) => {
    const local = ((((hour * 60 + zoneOffsetMinutes(s.tz, now)) % 1440) + 1440) % 1440) / 60
    return s.startHour <= local && local < s.endHour
  })
  return hit.length > 0 ? hit.map((s) => s.key) : ['outside']
}

/** 这个盘里胜率最高的几个钟点 / 品种。
 *
 *  **这两处加了 0.5 的下限**，策略卡上的同名榜单没有——差别在语气：这里的标题是
 *  「可以留意」，是在给建议，把一个 45% 的钟点写进去等于推荐亏损；策略卡那两个
 *  标题是「这个策略胜率最高的时间 / 品种」，是在描述这个策略本身，哪怕最好的一个
 *  也只有 45%，那也是这个策略的实情，藏起来反而是隐瞒。
 *
 *  The best hours / symbols inside a session. **Both apply a 0.5 floor**, which
 *  the identically-named lists on the strategy card do not — the difference is
 *  register: this heading is "worth a look", a recommendation, and a 45% hour in
 *  it would be recommending a loss; the card's headings are "this strategy's best
 *  hours / symbols", a description, and if even its best is 45% that is the truth
 *  about the strategy and hiding it would be the dishonest choice. */
const pickHours = (data: AdminStrategyWinRate, sessionKey: string, now: Date) =>
  rankHours(data.overall.total.hourly, now, {
    limit: TOP_WATCH,
    greenOnly: true,
    keep: (utcHour) => sessionsForUtcHour(utcHour, data.sessions, now).includes(sessionKey),
  })

const pickSymbols = (data: AdminStrategyWinRate, sessionKey: string) =>
  rankBuckets(
    data.overall.symbols.map((s) => ({ name: s.symbol, bucket: s.sessions[sessionKey] })),
    { limit: TOP_WATCH, greenOnly: true },
  )

function Group({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-2xs uppercase tracking-wider text-neutral-500">
        {label}
        <span className="ml-2 normal-case tracking-normal text-neutral-600">{hint}</span>
      </p>
      <div className="mt-2">{children}</div>
    </div>
  )
}

/** 一个时段的"该不该盯"块：名字 + 剩余时间 → 盘里最好的几个钟点 → 可以留意的品种。
 *  One session's "worth watching?" block: name + time left → its best hours →
 *  symbols worth a look. */
function SessionBlock({ data, sessionKey, title, minutesLeft, now }: {
  data: AdminStrategyWinRate
  sessionKey: string
  title: string
  minutesLeft?: number
  now: Date
}) {
  const { t } = useTranslation()
  const hours = pickHours(data, sessionKey, now)
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

      <div className="mt-3 space-y-4">
        <Group label={t('admin.winrate.watch.hoursGood')} hint={t('admin.winrate.watch.hoursHint', { days: data.days })}>
          {hours.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {hours.map((h) => (
                <RateChip key={h.localMinutes} kind={h.kind} name={fmtClock(h.localMinutes)} rate={h.rate} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-neutral-500">{t('admin.winrate.watch.hoursNone', { days: data.days })}</p>
          )}
        </Group>

        <Group label={t('admin.winrate.watch.symbolsGood')} hint={t('admin.winrate.watch.symbolsHint', { days: data.days })}>
          {picks.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {picks.map((p) => (
                <RateChip key={p.name} kind={p.kind} name={p.name} rate={p.bucket.winRate!}
                          aria={t('admin.winrate.aria.tug', {
                            label: p.name, tp: p.bucket.hitTp, sl: p.bucket.hitSl,
                            rate: fmtPct(p.bucket.winRate!),
                          })} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-neutral-500">{t('admin.winrate.watch.symbolsNone', { days: data.days })}</p>
          )}
        </Group>
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
  return (
    <section className="glass animate-fade-in-up p-6 md:p-8">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0">
          <h2 className="text-2xs uppercase tracking-wider text-neutral-500">{t('admin.winrate.watch.title')}</h2>

          <div className="mt-3 space-y-6">
            {active.length > 0 ? (
              active.map(({ s, st }) => (
                <SessionBlock key={s.key} data={data} sessionKey={s.key} now={now}
                              title={t('admin.winrate.watch.nowActive', { name: t(`admin.winrate.session.${s.key}`) })}
                              minutesLeft={st.state === 'active' ? st.minutesToEnd : undefined} />
              ))
            ) : (
              <SessionBlock data={data} sessionKey="outside" now={now}
                            title={t('admin.winrate.watch.nowOutside')} />
            )}
          </div>

          {/* 「下一个」只说还有多久开——不带任何胜率数字（产品要求）。这一行回答的
              是"现在要不要等"，一个数字回答不了那个问题，而盘真正好在什么时候，
              等它开了、成为上面那一块时自然会说。
              The "next" line says only how long until it opens — no win rate of
              any kind (product decision). It answers "should I wait", which no
              single number answers; when that session is actually good is said by
              the block above, once it opens. */}
          {next && (
            <p className="mt-6 flex flex-wrap items-center gap-x-2 border-t border-white/5 pt-4 text-sm text-neutral-200">
              <i className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: SESSION_COLORS[next.s.key] }} />
              {t('admin.winrate.watch.next', {
                name: t(`admin.winrate.session.${next.s.key}`), time: fmtDurationHm(next.st.minutesToStart),
              })}
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
