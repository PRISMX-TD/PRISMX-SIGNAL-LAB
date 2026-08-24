// 仪表盘上的「当前时段胜率」卡，取代原来的「市场概览」（信号总数 + 看多看空占比）。
//
// 回答的是「现在这个盘值不值得盯、盯什么」——「策略分析」页首屏那一段的浓缩版：
//   现在：纽约盘 · 还剩 3h07m
//   纽约盘近 30 天胜率 56.2%
//   这个盘里胜率最高的时间   [22:00 67.7%] [23:00 65.5%]
//   可以留意                 [ETHUSDT 68.6%] [BTCUSDT 64.3%]
//
// **时段重叠时只显示最后开盘的那个**（产品要求）。欧洲盘与纽约盘每天重叠约四小时，
// 两个都"进行中"；仪表盘这块地方只有一张卡的高度，硬塞两段会把卡片撑变形，而且
// 读者要的是"现在最该看哪个"，不是一份并列清单。用"最后开盘"而不是"胜率更高"来
// 挑：前者是客观事实，后者会让卡片在两个盘之间反复横跳，且等于替读者做了判断。
//
// 数据走 `/signals/strategy-analysis`（只含已公开策略，FREE 与 PRO 同样可见）。
// 公开名单为空时——也就是这个功能的默认状态——整张卡显示空态。
//
// The dashboard's "current session win rate" card, replacing the old market
// overview (signal count + long/short split). It is the condensed form of the
// analysis page's first section: which session is open, its 30-day win rate, its
// best hours, and symbols worth a look.
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
import { useEffect, useState, type FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { signalApi } from '../../api/client'
import type { AdminStrategyWinRate, SessionWindow } from '../../api/types'
import RateChip from './RateChip'
import {
  SESSION_COLORS, VERDICT_COLOR, fmtClock, fmtDurationHm, fmtPct, isRated,
  rankBuckets, rankHours, sessionStatus, verdictOf, zoneOffsetMinutes,
} from './shared'

const TOP_ON_CARD = 2

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
  const [data, setData] = useState<AdminStrategyWinRate | null>(null)
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    let mounted = true
    signalApi
      .strategyAnalysis()
      .then((r) => { if (mounted) setData(r) })
      .catch(() => {})
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [])

  const empty = !data || data.overall.total.samples === 0
  const picked = data ? pickSession(data.sessions, now) : null
  const bucket = data && picked ? data.overall.sessions[picked.key] : undefined
  const kind = bucket ? verdictOf(bucket) : 'none'
  const hasRate = !!bucket && isRated(kind) && bucket.winRate !== null

  const hours = data && picked
    ? rankHours(data.overall.total.hourly, now, {
        limit: TOP_ON_CARD,
        minRate: 0.5,
        keep: (utcHour) => sessionsForUtcHour(utcHour, data.sessions, now).includes(picked.key),
      })
    : []
  const symbols = data && picked
    ? rankBuckets(
        data.overall.symbols.map((s) => ({ name: s.symbol, bucket: s.sessions[picked.key] })),
        { limit: TOP_ON_CARD, minRate: 0.5 },
      )
    : []

  const sessionName = picked
    ? picked.key === 'outside'
      ? t('admin.winrate.watch.nowOutside')
      : t('admin.winrate.watch.nowActive', { name: t(`admin.winrate.session.${picked.key}`) })
    : ''

  // 有数据时整张卡可点，跳到「策略分析」页签看全部时段、策略与品种。
  // 空态不给链接：名单没公开时那一页也是空的，点过去是条死路。
  // The whole card links to the analysis tab when there is data. The empty state
  // gets no link — that tab is empty too, so the click would be a dead end.
  const linked = !loading && !empty

  // 整张卡就是那个链接——内边距挂在 Link 上、不挂在 section 上，连四周那圈
  // 留白都可点，不会出现"看着像能点、点边上没反应"。卡里没有别的可点元素，
  // 包起来不会遮住谁。用真链接而不是给 section 挂 onClick：键盘可聚焦、右键
  // 能新标签页打开、读屏软件会念成链接。
  // The whole card is the link: the padding lives on the Link, not the section,
  // so even the margin is clickable and there is no "looks clickable, isn't at
  // the edge". Nothing else in the card is interactive, so wrapping covers
  // nothing. A real link, not an onClick on the section: keyboard-focusable,
  // openable in a new tab, announced as a link.
  const Body = (
    <>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-white">{t('dashboard.sessionWinrate.title')}</h3>
        {linked && (
          <span className="shrink-0 text-xs text-prism-300 transition-colors group-hover/card:text-prism-200">
            {t('winrate.viewDetail')} ›
          </span>
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

          <p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-neutral-400">
            <span>
              {t('admin.winrate.watch.sessionRate', {
                days: data!.days,
                name: picked!.key === 'outside'
                  ? t('admin.winrate.session.outside')
                  : t(`admin.winrate.session.${picked!.key}`),
              })}
            </span>
            <span className="font-display text-lg font-bold leading-none tabular-nums"
                  style={{ color: VERDICT_COLOR[kind] }}>
              {hasRate ? fmtPct(bucket!.winRate!) : '—'}
            </span>
          </p>

          <div className="mt-4 space-y-3">
            <div>
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
                <p className="mt-1 text-xs text-neutral-600">{t('dashboard.sessionWinrate.noneYet')}</p>
              )}
            </div>

            <div>
              <p className="text-2xs uppercase tracking-wider text-neutral-500">
                {t('admin.winrate.watch.symbolsGood')}
              </p>
              {symbols.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {symbols.map((s) => (
                    <RateChip key={s.name} size="sm" kind={s.kind} name={s.name}
                              rate={s.bucket.winRate!} />
                  ))}
                </div>
              ) : (
                <p className="mt-1 text-xs text-neutral-600">{t('dashboard.sessionWinrate.noneYet')}</p>
              )}
            </div>
          </div>
        </>
      )}
    </>
  )

  return (
    <section className="card glass dash-overview group/card">
      {linked ? (
        <Link to="/app?tab=analysis" className="block p-[18px]" aria-label={t('dashboard.sessionWinrate.title')}>
          {Body}
        </Link>
      ) : (
        <div className="p-[18px]">{Body}</div>
      )}
    </section>
  )
}

export default SessionWinrateCard
