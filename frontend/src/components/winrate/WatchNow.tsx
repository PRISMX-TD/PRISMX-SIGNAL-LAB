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
// **2026-08-27：这一层从「平台口径的推荐」改成「你选的那一路」。** 原来它列的是
// 全部已公开策略合并出来的最佳钟点 + 「可以留意」的品种；合并出来的数字指向不了
// 任何一个能下手的动作——它不是某一路的表现，是一堆路平均出来的。现在顶部给两个
// 选择器（策略 / 品种），下面每个进行中的盘各列**这一路在那个盘里**胜率最高的三
// 个钟点。原来的「可以留意」品种块随之删掉：品种已经是选择器里的一维了。
//
// 选择与仪表盘「当前时段胜率」卡**共用同一份偏好**（`useWinratePick`，云端按用户
// 落库、跨设备）——那张卡的「查看详情 ›」就链到这一页，两处选中值不一致会让人以为
// 点错了地方。
//
// 欧洲盘与纽约盘重叠的四小时里两个盘都在进行，就各给一块；不在任何盘内时用
// 「其他时段」那一桶。**选择器只渲染一次，摆在「现在：X 盘」那一行之后**——那一行
// 是结论，选择器是调节它的控件，控件不该挡在结论前面；重叠时只交给第一块，两套
// 控件读者不知道该动哪个。
//
// 选哪几个按 Wilson 下限（把薄样本沉下去），选出来之后按胜率排。整页不显示笔数，
// 也不显示写着判定的芯片：胜率数字的颜色本身就是判定，绿=明显高于一半、
// 红=明显低于一半、灰=看不出。
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
// **2026-08-27: this layer changed from a platform-wide recommendation to "the
// line you picked".** It used to list the best hours pooled across every
// published strategy plus symbols "worth a look"; a pooled number points at no
// action anyone can take — it is not one line's performance but an average over
// many. Two pickers (strategy, symbol) now sit at the top, and each open session
// lists that pair's best hours inside it. The old symbol block is gone: symbol is
// one of the pickers now.
//
// The pick is **the same preference** the dashboard's session card uses
// (`useWinratePick`, cloud-stored and cross-device) — that card's "view detail"
// links here, and differing selections would read as a wrong landing.
//
// During the London/New York overlap both sessions get a block; outside all
// three, the "outside" bucket is used. **The pickers render once, below the
// "Now: X session" line** — that line is the conclusion and a control adjusting
// it does not belong in front of it; during an overlap only the first block gets
// them, since two sets would leave the reader unsure which to touch.
//
// Selection is by Wilson lower bound (thin samples sink), display by rate.
// Neither trade counts nor worded verdict chips appear: the colour of the
// percentage is the verdict — green from 51%, amber 40-50%, red below 40%.
import { useTranslation } from 'react-i18next'
import type { AdminStrategyWinRate, SymbolWinRate } from '../../api/types'
import RateChip from './RateChip'
import Select from '../Select'
import SessionTimeline from './SessionTimeline'
import {
  SESSION_COLORS, fmtClock, fmtDurationHm, rankHours, sessionStatus,
  sessionsForUtcHour,
} from './shared'
import { useWinratePick } from './useWinratePick'

const TOP_WATCH = 3

/** 选中的那一路在这个盘里胜率最高的几个钟点。
 *
 *  **不加 greenOnly 门槛**（2026-08-27 去掉）。原来加是因为那时这块是平台在推荐，
 *  标题「可以留意」的语气下，把一个 45% 的钟点写进去等于推荐亏损。现在它描述的是
 *  用户自己选定的组合——选了一个组合却回答"什么都没有"，比如实显示三个橙色钟点更
 *  没用；档位由配色如实说出来。与仪表盘那张卡、策略卡的同名榜单同口径。
 *
 *  The picked pair's best hours inside a session. **No greenOnly floor** (dropped
 *  2026-08-27): it was there while this block was the platform recommending, where
 *  a 45% hour under a "worth a look" heading would be recommending a loss. It now
 *  describes the pair the user chose — answering a deliberate choice with "nothing
 *  here" helps less than three honestly amber hours, and the colour states the
 *  verdict either way. Same rule as the dashboard card and the strategy cards. */
const pickHours = (
  data: AdminStrategyWinRate, symbolRow: SymbolWinRate | undefined,
  sessionKey: string, now: Date,
) =>
  rankHours(symbolRow?.total.hourly ?? null, now, {
    limit: TOP_WATCH,
    keep: (utcHour) => sessionsForUtcHour(utcHour, data.sessions, now).includes(sessionKey),
  })

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
function SessionBlock({ data, symbolRow, sessionKey, title, minutesLeft, now, pickers }: {
  data: AdminStrategyWinRate
  symbolRow: SymbolWinRate | undefined
  sessionKey: string
  title: string
  minutesLeft?: number
  now: Date
  // 两个选择器。**只有第一块拿得到**（见下方渲染处与调用处的说明）。
  // The two pickers; **only the first block receives them** — see the note at the
  // render site below and at the call site.
  pickers?: React.ReactNode
}) {
  const { t } = useTranslation()
  const hours = pickHours(data, symbolRow, sessionKey, now)
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

      {/* 选择器摆在「现在：亚洲盘」**之后**：那一行是结论（现在该不该盯），
          选择器是调节它的控件，控件不该挡在结论前面。
          The pickers sit *after* the "Now: Asian session" line: that line is the
          conclusion (is now worth watching), and a control that adjusts it does
          not belong in front of it. */}
      {pickers}

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

      </div>
    </div>
  )
}

export default function WatchNow({ data, now }: { data: AdminStrategyWinRate; now: Date }) {
  const { t } = useTranslation()
  const { pick, row, symbolRow, chooseStrategy, chooseSymbol } = useWinratePick(data)
  const statuses = data.sessions.map((s) => ({ s, st: sessionStatus(s, now) }))

  // 两个选择器构造一次，**只交给第一个时段块**。欧洲盘与纽约盘重叠的四小时里
  // 下面会渲染两块，每块都给一套的话读者不知道该动哪个——而它们本来就是管整段的，
  // 不是管某一个盘的。代价是重叠时它们视觉上贴着第一个盘，看起来像只管那个盘；
  // 换来的是不会出现两套互相矛盾的控件。
  // **没有「全部」这一项**：这一层回答的是「我这一路现在该几点盯」，而"全部策略的
  // 全部品种"合起来的钟点胜率不指向任何一个能下手的动作。
  //
  // Built once and handed to the **first** session block only. During the four-hour
  // London/New York overlap two blocks render below; a set per block would leave
  // the reader unsure which to touch, when they govern the whole section rather
  // than any one session. The cost is that during an overlap they sit visually
  // against the first session and can read as belonging to it; the gain is never
  // showing two sets of controls that appear to disagree.
  // **No "all" option**: this layer answers "when should I watch my line", and an
  // hour rate pooled over every strategy and symbol points at no action anyone can
  // take.
  const pickers = pick && row ? (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Select
        className="min-w-0"
        ariaLabel={t('dashboard.sessionWinrate.pickStrategy')}
        value={pick.strategy}
        options={data.strategies.map((s) => ({
          value: s.strategy,
          label: s.strategy || t('admin.winrate.strategies.unnamed'),
        }))}
        onChange={chooseStrategy}
      />
      <Select
        className="min-w-0 tabular-nums"
        ariaLabel={t('dashboard.sessionWinrate.pickSymbol')}
        value={pick.symbol}
        options={row.symbols.map((s) => ({ value: s.symbol, label: s.symbol }))}
        onChange={chooseSymbol}
      />
    </div>
  ) : null
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
              active.map(({ s, st }, i) => (
                <SessionBlock key={s.key} data={data} symbolRow={symbolRow} sessionKey={s.key} now={now}
                              title={t('admin.winrate.watch.nowActive', { name: t(`admin.winrate.session.${s.key}`) })}
                              minutesLeft={st.state === 'active' ? st.minutesToEnd : undefined}
                              pickers={i === 0 ? pickers : undefined} />
              ))
            ) : (
              <SessionBlock data={data} symbolRow={symbolRow} sessionKey="outside" now={now}
                            title={t('admin.winrate.watch.nowOutside')} pickers={pickers} />
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
