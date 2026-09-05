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
// 都可点；加了两个下拉之后那样做不成立——可点控件嵌在 a 里，点开菜单的同时会触发
// 导航。现在只有右上角「查看详情 ›」是链接。代价是可点区域从整张卡缩到一行字，
// 换来的是两个选择器能真的用。
//
// 下拉用共享的 `components/Select`，不用原生 `<select>`：原生弹出列表由浏览器/
// 系统渲染，深色主题下压不住样式，实测是一片白底黑字。
//
// 「选了哪个策略 × 哪个品种」与「策略分析」页首屏**共用同一份偏好**
// （`useWinratePick`，存在云端、跨设备）——右上角「查看详情 ›」直接链到那一页，
// 两处显示不同的选中值会让人以为点错了地方。
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
// dropdowns, since a clickable control nested in an anchor navigates as it
// opens. Only "view detail ›" is a link now. The hit area shrinks from the whole
// card to one line of text, and in exchange the pickers actually work.
//
// The dropdowns are the shared `components/Select`, not native `<select>`: a
// native popup list is rendered by the browser/OS and will not take dark-theme
// styling — in practice a slab of white.
//
// The chosen strategy-and-symbol is **the same preference** the analysis page's
// first screen uses (`useWinratePick`, cloud-stored and cross-device): "view
// detail" links straight there, and two different selections would read as
// having landed somewhere unintended.
import { useEffect, useState, type FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { signalApi } from '../../api/client'
import Select from '../Select'
import type { AdminStrategyWinRate, SessionWindow } from '../../api/types'
import RateChip from './RateChip'
import SessionTimeline from './SessionTimeline'
import {
  SESSION_COLORS, fmtClock, fmtDurationHm, rankHours, sessionStatus, zoneOffsetMinutes,
  sessionsForUtcHour,
} from './shared'
import { useWinratePick } from './useWinratePick'

const TOP_ON_CARD = 3

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

const SessionWinrateCard: FC = () => {
  const { t } = useTranslation()
  const [data, setData] = useState<AdminStrategyWinRate | null>(null)
  const [loading, setLoading] = useState(true)
  const [now, setNow] = useState(() => new Date())
  const { pick, row, symbolRow, chooseStrategy, chooseSymbol } = useWinratePick(data)

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

  // 用共享的自定义 Select，不用原生 <select>：原生的弹出列表由浏览器/系统渲染，
  // 深色主题下几乎压不住样式（Windows Chrome 认 option 的 background，macOS
  // Safari 直接无视），实测就是一片白底黑字。共享组件把菜单 portal 到 body 再
  // 按触发器坐标 fixed 定位，样式全在自己手里，也不会被卡片的圆角裁掉。
  // The shared custom Select rather than a native one: a native popup list is
  // rendered by the browser/OS and barely takes styling in a dark theme (Windows
  // Chrome honours option backgrounds, macOS Safari ignores them outright) — in
  // practice a slab of white. The shared component portals its menu to <body> and
  // positions it from the trigger's rect, so the styling is ours and the card's
  // rounded corners cannot clip it.
  const selectCls = 'select-picker min-w-0 flex-1'

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
            <Select
              className={selectCls}
              ariaLabel={t('dashboard.sessionWinrate.pickStrategy')}
              value={pick!.strategy}
              options={data!.strategies.map((s) => ({
                value: s.strategy,
                label: s.strategy || t('admin.winrate.strategies.unnamed'),
              }))}
              onChange={chooseStrategy}
            />
            <Select
              className={`${selectCls} tabular-nums`}
              ariaLabel={t('dashboard.sessionWinrate.pickSymbol')}
              value={pick!.symbol}
              options={row!.symbols.map((s) => ({ value: s.symbol, label: s.symbol }))}
              onChange={chooseSymbol}
            />
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
