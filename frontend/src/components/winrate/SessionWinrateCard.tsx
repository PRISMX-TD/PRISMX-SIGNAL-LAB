// 仪表盘上的「时段胜率」卡，取代原来的「市场概览」（信号总数 + 看多看空占比）。
//
// 回答的是「我关心的这一路，一天里什么时候最该做、什么时候最该躲」：
//   [响尾蛇 ▾] [XAUUSD ▾]
//   胜率最高的 3 个时段   [21:00–22:00 67.7%] …
//   胜率最低的 3 个时段   [03:00–04:00 25.0%] …
//
// 2026-10-11 按产品要求与「策略分析」页同步改版：原来以「现在：纽约盘 · 还剩 3h」
// 为锚、下面一条三大盘色带、再列这个盘里最好的几个钟点；现在去掉盘的概念，
// 只按小时看，规则与那一页同一个函数（shared.bestWorstHours，不设样本门槛，
// 单数不显示）。
//
// 数据走 `/signals/strategy-analysis`（只含已公开策略，FREE 与 PRO 同样可见）。
// 公开名单为空时——也就是这个功能的默认状态——整张卡显示空态。
//
// ⚠ **整张卡不是一个链接**（2026-08-26）：可点的下拉嵌在 a 里，点开菜单的同时会
// 触发导航。只有右上角「查看详情 ›」是链接。
//
// 下拉用共享的 `components/Select`，不用原生 `<select>`：原生弹出列表由浏览器/
// 系统渲染，深色主题下压不住样式，实测是一片白底黑字。
//
// 「选了哪个策略 × 哪个品种」与「策略分析」页首屏**共用同一份偏好**
// （`useWinratePick`，存在云端、跨设备）——「查看详情 ›」直接链到那一页，
// 两处显示不同的选中值会让人以为点错了地方。
//
// The dashboard's "win rate by hour" card, replacing the old market overview. It
// answers "for the line I care about, when in the day to trade and when to stay
// out": a strategy and symbol picker, then that pair's three best and three worst
// hours. Reworked 2026-10-11 alongside the analysis page: the open-session anchor
// (Asia / Europe / New York) and its band strip are gone; hours are ranked by the
// same shared.bestWorstHours (no sample floor; trade counts are not shown).
// Data: `/signals/strategy-analysis` (published strategies only); an empty
// whitelist — the default — shows the empty state. Only "view detail ›" is a link
// (a dropdown inside an anchor would navigate as it opens). The dropdowns are the
// shared Select (native popups ignore the dark theme). The pick is shared with the
// analysis page via `useWinratePick`.
import { useEffect, useState, type FC } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { signalApi } from '../../api/client'
import Select from '../Select'
import type { AdminStrategyWinRate } from '../../api/types'
import { VERDICT_COLOR, bestWorstHours, fmtHourRange, fmtPct, type HourStat } from './shared'
import { useWinratePick } from './useWinratePick'

/** 一个榜：三行「钟点段 · 胜率」，胜率列右对齐。卡片太窄（内宽约 290px），
 *  策略分析页那种芯片一行只放得下一个，六个芯片会把卡撑高一倍；改成紧凑列表，
 *  颜色规则不变（VERDICT_COLOR，与芯片同一套判定）。
 *  One list: three rows of hour range · rate · count, numbers aligned. The card is
 *  too narrow (~290px inside) for the analysis page's chips — one per line, six of
 *  them doubled the card's height — so it uses a compact list with the same colours. */
function HourRow({ tone, label, hours, empty }: {
  tone: 'best' | 'worst'
  label: string
  hours: HourStat[]
  empty: string
}) {
  return (
    <div className="mt-4">
      <p className="wr-cap">
        <i className={`wr-tone ${tone}`} aria-hidden="true" />
        {label}
      </p>
      {hours.length > 0 ? (
        <ul className="dh-hours">
          {hours.map((h) => (
            <li key={h.localMinutes}>
              <span className="h tabular-nums">{fmtHourRange(h.localMinutes)}</span>
              <span className="r tabular-nums" style={{ color: VERDICT_COLOR[h.kind] }}>{fmtPct(h.rate)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="wr-none">{empty}</p>
      )}
    </div>
  )
}

// preset：游客预览直接给数据（公开预览接口里那份），不再自己请求——这个接口要登录。
// presetLoading：那份数据还在路上（显示「加载中」而不是空态）。
// preset: the guest preview hands the data in (from the public preview endpoint) instead of
// fetching, since the endpoint needs a session; presetLoading shows "loading" meanwhile.
const SessionWinrateCard: FC<{ preset?: AdminStrategyWinRate | null; presetLoading?: boolean }> = ({ preset, presetLoading }) => {
  const { t } = useTranslation()
  const [fetched, setData] = useState<AdminStrategyWinRate | null>(null)
  const [fetching, setLoading] = useState(preset === undefined)
  const data = preset !== undefined ? preset : fetched
  const loading = preset !== undefined ? !!presetLoading : fetching
  const [now, setNow] = useState(() => new Date())
  const { pick, row, symbolRow, chooseStrategy, chooseSymbol } = useWinratePick(data)

  // 钟点换算跟着本地时区走，跨夏令时那天也要换得过来，所以每分钟刷新一次。
  // Hours are converted to the viewer's zone; a per-minute clock keeps DST days right.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    if (preset !== undefined) return
    let mounted = true
    signalApi
      .strategyAnalysis()
      .then((r) => { if (mounted) setData(r) })
      .catch(() => {})
      .finally(() => { if (mounted) setLoading(false) })
    return () => { mounted = false }
  }, [preset !== undefined]) // eslint-disable-line react-hooks/exhaustive-deps

  // 没有可选组合时也算空态：卡面主体就是这两个选择器，选不出东西就没什么可显示的。
  // No selectable pair counts as empty too: the pickers are the body of this card.
  const empty = !data || data.overall.total.samples === 0 || !pick || !row

  const { best, worst } = bestWorstHours(symbolRow?.total.hourly ?? null, now)
  const none = t('signals.analysis.hours.none', { days: data?.days ?? 30 })

  const selectCls = 'select-picker min-w-0 flex-1'

  return (
    <section className="card glass dash-overview dh-session p-[18px] sm:p-6">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[15px] font-bold text-white">{t('dashboard.sessionWinrate.title')}</h3>
        {!loading && !empty && (
          <Link to="/app?tab=analysis" className="dh-link">
            {t('winrate.viewDetail')}
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6" /></svg>
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
          {/* 两个选择器，**没有「全部」这一项**（产品要求）：所有策略所有品种合起来的
              钟点胜率不指向任何一个能下手的动作。要看全局请走「查看详情」。
              Two pickers with **no "all" option** (product decision): an hour rate
              pooled over every strategy and symbol points at no action. */}
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

          <HourRow tone="best" label={t('signals.analysis.hours.best')} hours={best} empty={none} />
          <HourRow tone="worst" label={t('signals.analysis.hours.worst')} hours={worst} empty={none} />
        </>
      )}
    </section>
  )
}

export default SessionWinrateCard
