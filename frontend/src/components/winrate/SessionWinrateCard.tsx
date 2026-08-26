// 仪表盘上的「当前时段胜率」卡，取代原来的「市场概览」（信号总数 + 看多看空占比）。
//
// 回答的是「现在这个盘、我关心的这一路，什么时候最该盯」：
//   现在：纽约盘 · 还剩 3h07m
//   [响尾蛇 ▾] [XAUUSD ▾]
//   这个盘里胜率最高的时间   [22:00 67.7%] [23:00 65.5%] [20:00 61.2%]
//
// **时段重叠时只显示最后开盘的那个**（产品要求）。欧洲盘与纽约盘每天重叠约四小时，
// 两个都"进行中"；仪表盘这块地方只有一张卡的高度，硬塞两段会把卡片撑变形，而且
// 读者要的是"现在最该看哪个"，不是一份并列清单。用"最后开盘"而不是"胜率更高"来
// 挑：前者是客观事实，后者会让卡片在两个盘之间反复横跳，且等于替读者做了判断。
//
// 数据走 `/signals/strategy-analysis`（只含已公开策略，FREE 与 PRO 同样可见）。
// 公开名单为空时——也就是这个功能的默认状态——整张卡显示空态。
//
// ⚠ **整张卡不再是一个链接**（2026-08-26）。原来 Link 包住了全部卡面，连四周留白
// 都可点；加了两个 select 之后那样做不成立——表单控件嵌在 a 里，点开下拉的同时会
// 触发导航。现在只有右上角「查看详情 ›」是链接。代价是可点区域从整张卡缩到一行字，
// 换来的是两个选择器能真的用。
//
// The dashboard's "current session win rate" card, replacing the old market
// overview. It answers "for the line I care about, when in this session should I
// be watching": the open session, a strategy and symbol picker, and that pair's
// best hours inside this session.
//
// **During an overlap only the most recently opened session is shown** (product
// decision). Europe and New York overlap ~4 hours daily; this slot is one card
// tall, two blocks would distort it, and the reader wants "what should I look at
// now", not a parallel list. "Most recently opened" is an objective fact, unlike
// "whichever has the better rate", which would make the card flip between
// sessions and would be deciding for the reader.
//
// Data comes from `/signals/strategy-analysis` (published strategies only, FREE
// and PRO alike). With an empty whitelist — this feature's default state — the
// whole card shows its empty state.
//
// ⚠ **The whole card is no longer one link** (2026-08-26). A Link used to wrap
// the entire face so even the padding was clickable; that cannot survive two
// select elements, since a form control nested in an anchor navigates as it
// opens. Only "view detail ›" is a link now. The hit area shrinks from the whole
// card to one line of text, and in exchange the pickers actually work.
import { useEffect, useState, type FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { signalApi } from '../../api/client'
import { useAuth } from '../../store/auth'
import type { AdminStrategyWinRate, SessionWindow } from '../../api/types'
import RateChip from './RateChip'
import SessionTimeline from './SessionTimeline'
import {
  SESSION_COLORS, fmtClock, fmtDurationHm, rankHours, sessionStatus, zoneOffsetMinutes,
} from './shared'

const TOP_ON_CARD = 3
const DEFAULT_SYMBOL = 'XAUUSD'

type CardPick = { strategy: string; symbol: string }

/** 每个用户各记各的选择，所以键里必须带用户 id。
 *
 *  localStorage 是按**浏览器**存的，不按用户：不带 id 的话，同一台电脑上换个账号
 *  登录，上一个人选的策略会原样出现在新用户的卡片上——那既是别人的偏好，也可能
 *  是一个该用户根本看不到的策略。
 *
 *  Each user remembers their own pick, so the key carries the user id.
 *  localStorage is per-browser, not per-user: without the id, signing in as
 *  someone else on the same machine would surface the previous person's chosen
 *  strategy — their preference, and possibly one this user cannot even see. */
const pickKey = (userId: string) => `prismx.dash.winratePick.${userId}`

function readPick(userId: string | undefined): CardPick | null {
  if (!userId) return null
  try {
    const raw = localStorage.getItem(pickKey(userId))
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<CardPick> | null
    if (v && typeof v.strategy === 'string' && typeof v.symbol === 'string') {
      return { strategy: v.strategy, symbol: v.symbol }
    }
  } catch {
    // 存坏了当没存过。这里绝不能抛：localStorage 在隐私模式下会直接 throw，
    // 而一个记不住的偏好不该让整张卡崩掉。
    // A corrupt value counts as none. This must never throw: localStorage
    // raises outright in private mode, and an unremembered preference is no
    // reason to take the card down with it.
  }
  return null
}

/** 把（可能过时的）选择落到当前数据上，返回的组合一定存在。
 *
 *  存下来的选择随时会失效：策略被管理员取消公开、某个品种最近 30 天一条信号都没
 *  发。回退顺序是"存的 → 黄金 → 第一个"，每一级都在**当前策略的**品种里找——
 *  换策略时沿用上次选的品种是对的（同一个品种在另一个策略下照样有意义），但那个
 *  品种在新策略里不存在时必须让位。
 *
 *  Resolve a (possibly stale) pick against the current data; the result always
 *  exists. A stored pick goes stale easily: the admin un-publishes a strategy, or
 *  a symbol sees no signals for 30 days. The fallback runs saved -> gold ->
 *  first, each looked up **within the chosen strategy's** symbols — carrying the
 *  previous symbol across a strategy switch is right (the same symbol still means
 *  something under another strategy), but it has to yield when absent there. */
function resolvePick(data: AdminStrategyWinRate, saved: CardPick | null): CardPick | null {
  if (data.strategies.length === 0) return null
  const row = data.strategies.find((s) => s.strategy === saved?.strategy) ?? data.strategies[0]
  const symbol =
    row.symbols.find((s) => s.symbol === saved?.symbol)?.symbol
    ?? row.symbols.find((s) => s.symbol === DEFAULT_SYMBOL)?.symbol
    ?? row.symbols[0]?.symbol
  return symbol ? { strategy: row.strategy, symbol } : null
}

/** 挑出要显示的时段：进行中的里面**最后开盘**的那个；一个都没进行中就用
 *  「其他时段」那一桶。
 *
 *  "最后开盘"按各时段在浏览者钟点上的起点比较——三个盘的起点在同一条时间轴上，
 *  取最大者即最近开的那个。跨零点的窗口（纽约盘对 UTC+8 用户是 20:00–05:00）
 *  起点仍是 20:00，不受影响。
 *
 *  Pick the session to show: of those open, the one that **opened most recently**;
 *  if none is open, the "outside" bucket. "Most recently" compares each session's
 *  start in the viewer's clock — the three starts sit on one axis and the largest
 *  is the latest. A window crossing midnight (New York is 20:00–05:00 for a UTC+8
 *  reader) still starts at 20:00, so it is unaffected. */
function pickSession(sessions: SessionWindow[], now: Date): { key: string; minutesLeft?: number } {
  const viewerOffset = -now.getTimezoneOffset()
  const open = sessions
    .map((s) => ({ s, st: sessionStatus(s, now) }))
    .filter((x) => x.st.state === 'active')
  if (open.length === 0) return { key: 'outside' }
  const withStart = open.map((x) => ({
    ...x,
    localStart: (((x.s.startHour * 60 + (viewerOffset - zoneOffsetMinutes(x.s.tz, now))) % 1440) + 1440) % 1440,
  }))
  withStart.sort((a, b) => b.localStart - a.localStart)
  const top = withStart[0]
  return { key: top.s.key, minutesLeft: top.st.state === 'active' ? top.st.minutesToEnd : undefined }
}

function sessionsForUtcHour(hour: number, sessions: SessionWindow[], now: Date): string[] {
  const hit = sessions.filter((s) => {
    const local = ((((hour * 60 + zoneOffsetMinutes(s.tz, now)) % 1440) + 1440) % 1440) / 60
    return s.startHour <= local && local < s.endHour
  })
  return hit.length > 0 ? hit.map((s) => s.key) : ['outside']
}

const SessionWinrateCard: FC = () => {
  const { t } = useTranslation()
  const { user } = useAuth()
  const userId = user?.id
  const [data, setData] = useState<AdminStrategyWinRate | null>(null)
  const [loading, setLoading] = useState(true)
  const [saved, setSaved] = useState<CardPick | null>(null)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  // 用户就位（或换人）时再读偏好：登录态是异步恢复的，挂载那一刻 user 可能还是
  // null，那时读到的永远是"没存过"。
  // Read the preference once the user is known (or changes): auth restores
  // asynchronously, so at mount `user` may still be null and the read would
  // always come back empty.
  useEffect(() => { setSaved(readPick(userId)) }, [userId])

  useEffect(() => {
    let mounted = true
    signalApi
      .strategyAnalysis()
      .then((r) => { if (mounted) setData(r) })
      .catch(() => {})
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [])

  const choose = (next: CardPick) => {
    setSaved(next)
    if (!userId) return
    try {
      localStorage.setItem(pickKey(userId), JSON.stringify(next))
    } catch {
      // 同 readPick：存不下就只在本次会话内生效，不该报错。
      // As in readPick: if it cannot be stored the pick just lives for this
      // session, which is no reason to raise.
    }
  }

  const pick = data ? resolvePick(data, saved) : null
  const row = data && pick ? data.strategies.find((s) => s.strategy === pick.strategy) : undefined
  const symbolRow = row && pick ? row.symbols.find((s) => s.symbol === pick.symbol) : undefined
  const picked = data ? pickSession(data.sessions, now) : null

  // 没有可选组合时也算空态：卡面主体就是这两个选择器，选不出东西就没什么可显示的。
  // No selectable pair counts as empty too: the pickers are the body of this
  // card, and with nothing to pick there is nothing to show.
  const empty = !data || data.overall.total.samples === 0 || !pick || !row

  // 这里**不加** greenOnly。列表现在描述的是用户自己选定的那一路，不再是平台在
  // 推荐——同一条规则下，「策略分析」页里策略卡的「胜率最高的时间」也不加门槛
  // （见设计文档 §5）。选了一个组合却告诉人家"什么都没有"，比如实显示三个橙色
  // 钟点更没用；档位由配色如实说出来。
  // **No greenOnly here.** The list now describes the pair the user chose rather
  // than a platform recommendation — the same rule under which the analysis
  // page's strategy cards leave "best hours" ungated (design doc section 5).
  // Answering a deliberate choice with "nothing here" helps less than three
  // honestly amber hours; the colour states the verdict either way.
  const hours = data && picked && symbolRow
    ? rankHours(symbolRow.total.hourly, now, {
        limit: TOP_ON_CARD,
        keep: (utcHour) => sessionsForUtcHour(utcHour, data.sessions, now).includes(picked.key),
      })
    : []

  const sessionName = picked
    ? picked.key === 'outside'
      ? t('admin.winrate.watch.nowOutside')
      : t('admin.winrate.watch.nowActive', { name: t(`admin.winrate.session.${picked.key}`) })
    : ''

  const selectCls = 'input w-auto min-w-0 flex-1 py-1 text-xs'

  return (
    <section className="card glass dash-overview p-[18px]">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-white">{t('dashboard.sessionWinrate.title')}</h3>
        {!loading && !empty && (
          <Link to="/app?tab=analysis"
                className="shrink-0 text-xs text-prism-300 transition-colors hover:text-prism-200">
            {t('winrate.viewDetail')} ›
          </Link>
        )}
      </div>

      {loading ? (
        <p className="mt-4 text-sm text-neutral-500">{t('common.loading')}</p>
      ) : empty ? (
        <p className="mt-4 text-sm leading-relaxed text-neutral-500">
          {t('dashboard.sessionWinrate.empty')}
        </p>
      ) : (
        <>
          <p className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="flex items-center gap-2 font-display text-lg font-semibold text-neutral-50">
              <i className="h-2 w-2 shrink-0 rounded-full animate-breathe"
                 style={{ backgroundColor: SESSION_COLORS[picked!.key] ?? SESSION_COLORS.outside }} />
              {sessionName}
            </span>
            {picked!.minutesLeft !== undefined && (
              <span className="text-xs font-medium tabular-nums" style={{ color: 'var(--up)' }}>
                {t('admin.winrate.watch.nowLeft', { time: fmtDurationHm(picked!.minutesLeft) })}
              </span>
            )}
          </p>

          {/* 简化版时段色带：紧跟在「现在：亚洲盘」那句下面，因为它就是那句话的
              图形版——三条带子按浏览者本地钟点摆开，白游标是此刻。上面那句给结论，
              这里给上下文：下一段什么时候开、现在离收盘还有多远，一眼看得到。
              The compact band strip sits directly under the "now: Asia" line
              because it is that sentence drawn: three bands laid out in the
              viewer's local clock with a white cursor at this moment. The line
              states the conclusion; the strip supplies the context around it. */}
          <div className="mt-3">
            <SessionTimeline sessions={data!.sessions} now={now} variant="compact" />
          </div>

          {/* 两个选择器。**没有「全部」这一项**（产品要求）：这张卡回答的是"我这一路
              现在该几点盯"，而"全部策略的全部品种"合起来的钟点胜率不指向任何一个能
              下手的动作。要看全局请走「查看详情」。
              Two pickers, with **no "all" option** (product decision): this card
              answers "when should I watch my line", and an hour rate pooled over
              every strategy and symbol points at no action anyone can take. The
              detail link is where the whole picture lives. */}
          <div className="mt-4 flex items-center gap-2">
            <select className={selectCls} value={pick!.strategy}
                    aria-label={t('dashboard.sessionWinrate.pickStrategy')}
                    onChange={(e) => {
                      // 换策略时走一遍 resolvePick：上次选的品种在新策略里可能不存在，
                      // 直接沿用会指向一个空的品种行。
                      // Re-resolve on a strategy switch: the previous symbol may not
                      // exist under the new strategy, and carrying it over blindly
                      // would point at an absent row.
                      const next = resolvePick(data!, { strategy: e.target.value, symbol: pick!.symbol })
                      if (next) choose(next)
                    }}>
              {data!.strategies.map((s) => (
                <option key={s.strategy} value={s.strategy}>
                  {s.strategy || t('admin.winrate.strategies.unnamed')}
                </option>
              ))}
            </select>
            <select className={`${selectCls} tabular-nums`} value={pick!.symbol}
                    aria-label={t('dashboard.sessionWinrate.pickSymbol')}
                    onChange={(e) => choose({ strategy: pick!.strategy, symbol: e.target.value })}>
              {row!.symbols.map((s) => (
                <option key={s.symbol} value={s.symbol}>{s.symbol}</option>
              ))}
            </select>
          </div>

          <div className="mt-3">
            <p className="text-2xs uppercase tracking-wider text-neutral-500">
              {t('admin.winrate.watch.hoursGood')}
            </p>
            {hours.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {hours.map((h) => (
                  <RateChip key={h.localMinutes} size="sm" kind={h.kind}
                            name={fmtClock(h.localMinutes)} rate={h.rate} />
                ))}
              </div>
            ) : (
              <p className="mt-1 text-xs text-neutral-600">
                {t('dashboard.sessionWinrate.noneForPair')}
              </p>
            )}
          </div>
        </>
      )}
    </section>
  )
}

export default SessionWinrateCard
