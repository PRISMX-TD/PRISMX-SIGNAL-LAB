// 年度交易报告（2026-11-28，rev 58）。在交易报告页里代替月报显示（月份那一排多一个「2026 年度」）。
// 自上而下：全年成绩（净盈亏、评分、胜率、盈亏比、笔数、盈利日）→ 逐月走势（每月一根盈亏柱 + 评分）
// → 人格变化（每个月是什么人格）→ 各项纪录 → 前半段和后半段对比 → 全年盈亏日历（每天一格）
// → 标签全年合计 → 这一年拿到的徽章和最长的纪律记录。
// 12 月的月报存完之后（1 月 1 日）后端生成并存档；管理员可以提前预览今年到目前为止的（live）。
// 平台 2026 年 7 月才有数据，所以每份报告都写明实际覆盖的月份。
//
// The annual trading report, shown in place of the monthly report. Year totals, month-by-month bars
// with scores, the persona of each month, records, first half against second half, a day-by-day year
// calendar, tag totals, badges collected and the longest discipline runs. Archived on January 1st;
// admins may preview the running year. Each report states the months it actually covers.
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import type { PersonaAnnual, PersonaBadge, PersonaTag, PersonaTradeRef } from '../../api/personaTypes'
import { EMPTY } from '../../utils/format'
import { focusFromRef } from '../charts/trade/focusTrade'
import { fmtMinutes, money, monthLabel, monthOnly, num, pct, shortDate, tone, type T } from './fmt'
import { FAMILY_COLOR, artUrl, familyOf, type ArtStyle } from './personaMeta'

const TAGS: PersonaTag[] = ['unprotected', 'heldLoser', 'earlyExit', 'movedStop', 'revenge', 'stoppedOut']

function TradeGo({ trade, canOpen, children }: { trade: PersonaTradeRef | null; canOpen: boolean; children: React.ReactNode }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  if (!trade || !canOpen) return <>{children}</>
  const open = () => {
    const focusTrade = focusFromRef(trade)
    if (focusTrade) navigate('/charts', { state: { focusTrade } })
  }
  return <button type="button" className="pr-tradelink" onClick={open} title={t('persona.tags.onChart')}>{children}</button>
}

// 逐月：每月一根柱子（净盈亏，以零为中线上下画）+ 下面的评分和人格代号。
// Month by month: one bar per month (net P&L around a zero line) with the score and persona code below.
function Monthly({ rep }: { rep: PersonaAnnual }) {
  const { t, i18n } = useTranslation()
  const maxAbs = Math.max(1, ...rep.monthly.map((m) => Math.abs(m.profit)))
  return (
    <>
      <h3 className="pr-h3">{t('persona.annual.monthly')}</h3>
      <ol className="pr-yr-months">
        {rep.monthly.map((m) => {
          const h = (Math.abs(m.profit) / maxAbs) * 46
          return (
            <li key={m.period} title={`${monthLabel(m.period, i18n.language)} · ${money(m.profit)} · ${t('persona.calendar.trades', { n: m.trades })}`}>
              <div className="pr-yr-bar" aria-hidden="true">
                <i className={m.profit >= 0 ? 'is-up' : 'is-down'} style={{ height: `${Math.max(h, m.trades ? 2 : 0)}%` }} />
              </div>
              <b className={`num ${tone(m.profit)}`}>{m.trades ? money(m.profit) : EMPTY}</b>
              <span className="pr-yr-m">{monthOnly(m.period, i18n.language)}</span>
              <span className="pr-yr-s num">{m.score ?? EMPTY}</span>
            </li>
          )
        })}
      </ol>
      <p className="pr-small">{t('persona.annual.monthlyNote')}</p>
    </>
  )
}

function Journey({ rep, style }: { rep: PersonaAnnual; style: ArtStyle }) {
  const { t, i18n } = useTranslation()
  const steps = rep.journey.steps
  if (!steps.length) return null
  // 连着几个月是同一个人格的并成一段 / consecutive months with the same persona collapse into one run
  const runs: { code: string; from: string; to: string }[] = []
  for (const s of steps) {
    const last = runs[runs.length - 1]
    if (last && last.code === s.code) last.to = s.period
    else runs.push({ code: s.code, from: s.period, to: s.period })
  }
  return (
    <>
      <h3 className="pr-h3">{t('persona.annual.journey')}</h3>
      <p className="pr-small">
        {rep.journey.changes > 0 && rep.journey.mostCommon
          ? t('persona.annual.journeyChanged', { n: rep.journey.changes, name: t(`persona.types.${rep.journey.mostCommon}.title`) })
          : t('persona.annual.journeySame', { name: t(`persona.types.${steps[0].code}.title`) })}
      </p>
      <ol className="pr-yr-journey">
        {runs.map((r) => {
          const c = FAMILY_COLOR[familyOf(r.code)]
          return (
            <li key={`${r.code}-${r.from}`} style={{ '--fam': c.main } as React.CSSProperties}>
              <img src={artUrl(r.code, style)} alt="" width={72} height={83} loading="lazy" />
              <b>{t(`persona.types.${r.code}.title`)}</b>
              <span className="num">{r.code}</span>
              <span className="pr-small">{r.from === r.to ? monthOnly(r.from, i18n.language) : `${monthOnly(r.from, i18n.language)} – ${monthOnly(r.to, i18n.language)}`}</span>
            </li>
          )
        })}
      </ol>
    </>
  )
}

function Records({ rep, canOpen }: { rep: PersonaAnnual; canOpen: boolean }) {
  const { t, i18n } = useTranslation()
  const r = rep.records
  const lang = i18n.language
  const rows: { k: string; v: React.ReactNode; sub?: string; cls?: string }[] = []
  if (r.bestTrade) rows.push({ k: 'bestTrade', v: <TradeGo trade={r.bestTrade} canOpen={canOpen}>{money(r.bestTrade.profit)}</TradeGo>, sub: `${r.bestTrade.symbol} · ${shortDate(r.bestTrade.closeAt, lang)}`, cls: 'is-up' })
  if (r.worstTrade) rows.push({ k: 'worstTrade', v: <TradeGo trade={r.worstTrade} canOpen={canOpen}>{money(r.worstTrade.profit)}</TradeGo>, sub: `${r.worstTrade.symbol} · ${shortDate(r.worstTrade.closeAt, lang)}`, cls: 'is-down' })
  if (r.bestDay && r.bestDay.profit > 0) rows.push({ k: 'bestDay', v: money(r.bestDay.profit), sub: shortDate(r.bestDay.day, lang), cls: 'is-up' })
  if (r.worstDay && r.worstDay.profit < 0) rows.push({ k: 'worstDay', v: money(r.worstDay.profit), sub: shortDate(r.worstDay.day, lang), cls: 'is-down' })
  if (r.bestMonth) rows.push({ k: 'bestMonth', v: monthLabel(r.bestMonth, lang), sub: money(rep.monthly.find((m) => m.period === r.bestMonth)?.profit) })
  if (r.busiestDay) rows.push({ k: 'busiestDay', v: t('persona.calendar.trades', { n: r.busiestDay.trades }), sub: shortDate(r.busiestDay.day, lang) })
  rows.push({ k: 'winRun', v: t('persona.streak.unit.trades', { n: r.winRun }) })
  rows.push({ k: 'lossRun', v: t('persona.streak.unit.trades', { n: r.lossRun }) })
  if (r.longestHold) rows.push({ k: 'longestHold', v: <TradeGo trade={r.longestHold} canOpen={canOpen}>{fmtMinutes(t as T, r.longestHold.holdMin)}</TradeGo>, sub: `${r.longestHold.symbol} · ${money(r.longestHold.profit)}` })
  if (r.topSymbol) rows.push({ k: 'topSymbol', v: String(r.topSymbol.key), sub: `${t('persona.calendar.trades', { n: r.topSymbol.trades })} · ${money(r.topSymbol.profit)}` })
  if (r.bestSymbol && r.bestSymbol.profit > 0 && r.bestSymbol.key !== r.topSymbol?.key) rows.push({ k: 'bestSymbol', v: String(r.bestSymbol.key), sub: money(r.bestSymbol.profit), cls: 'is-up' })
  if (r.topSession) rows.push({ k: 'topSession', v: t(`persona.break.session.${r.topSession.key}`), sub: t('persona.calendar.trades', { n: r.topSession.trades }) })
  if (r.topWeekday) rows.push({ k: 'topWeekday', v: t(`persona.weekday.${r.topWeekday.key}`), sub: t('persona.calendar.trades', { n: r.topWeekday.trades }) })
  rows.push({ k: 'holdHours', v: t('persona.unit.hour', { n: r.holdHours.toFixed(1) }) })
  return (
    <>
      <h3 className="pr-h3">{t('persona.annual.records')}</h3>
      <dl className="pr-yr-records">
        {rows.map((x) => (
          <div key={x.k}>
            <dt>{t(`persona.annual.record.${x.k}`)}</dt>
            <dd className={`num ${x.cls ?? ''}`}>{x.v}</dd>
            {x.sub && <span className="pr-small num">{x.sub}</span>}
          </div>
        ))}
      </dl>
    </>
  )
}

// 前半段 vs 后半段：几项成绩 + 各标签每 100 笔出现几次；标出进步最大的那一项。
// First half against second: the main figures plus each tag per 100 trades; the biggest improvement is called out.
function Halves({ rep }: { rep: PersonaAnnual }) {
  const { t, i18n } = useTranslation()
  const h = rep.halves
  if (!h) return null
  const lang = i18n.language
  const first = rep.monthly.filter((m) => m.trades && m.period <= h.split)
  const second = rep.monthly.filter((m) => m.trades && m.period > h.split)
  const span = (ms: typeof first) => (ms.length ? (ms.length === 1 ? monthOnly(ms[0].period, lang) : `${monthOnly(ms[0].period, lang)} – ${monthOnly(ms[ms.length - 1].period, lang)}`) : EMPTY)
  const drops = TAGS.map((k) => ({ k, a: h.first.tagRates[k], b: h.second.tagRates[k] }))
    .filter((x) => x.a != null && x.b != null && (x.a as number) > 0)
    .map((x) => ({ ...x, d: (x.a as number) - (x.b as number) }))
    .sort((x, y) => y.d - x.d)
  const improved = drops[0] && drops[0].d > 0.02 ? drops[0] : null
  const per100 = (v: number | null) => (v == null ? EMPTY : (v * 100).toFixed(0))
  const rows: [string, string, string, number | null][] = [
    [t('persona.report.stat.winRate'), pct(h.first.winRate), pct(h.second.winRate), h.first.winRate != null && h.second.winRate != null ? h.second.winRate - h.first.winRate : null],
    [t('persona.report.stat.payoff'), num(h.first.payoff, 2), num(h.second.payoff, 2), h.first.payoff != null && h.second.payoff != null ? h.second.payoff - h.first.payoff : null],
    [t('persona.report.stat.score'), String(h.first.score ?? EMPTY), String(h.second.score ?? EMPTY), h.first.score != null && h.second.score != null ? h.second.score - h.first.score : null],
  ]
  return (
    <>
      <h3 className="pr-h3">{t('persona.annual.halves')}</h3>
      <div className="pr-peers" role="table">
        <div className="pr-peer is-head" role="row">
          <span role="columnheader" />
          <span role="columnheader">{span(first)}</span>
          <span role="columnheader">{span(second)}</span>
        </div>
        {rows.map(([k, a, b, d]) => (
          <div key={k} className="pr-peer" role="row">
            <span role="cell">{k}</span>
            <span role="cell" className="num">{a}</span>
            <b role="cell" className={`num ${d == null || Math.abs(d) < 1e-9 ? '' : d > 0 ? 'is-up' : 'is-down'}`}>{b}</b>
          </div>
        ))}
        {TAGS.filter((k) => (h.first.tagRates[k] ?? 0) > 0 || (h.second.tagRates[k] ?? 0) > 0).map((k) => {
          const a = h.first.tagRates[k]
          const b = h.second.tagRates[k]
          const d = a != null && b != null ? b - a : null
          return (
            <div key={k} className="pr-peer" role="row">
              <span role="cell">{t(`persona.tags.${k}.name`)}</span>
              <span role="cell" className="num">{per100(a)}</span>
              <b role="cell" className={`num ${d == null || Math.abs(d) < 0.005 ? '' : d < 0 ? 'is-up' : 'is-down'}`}>{per100(b)}</b>
            </div>
          )
        })}
      </div>
      <p className="pr-small">{t('persona.annual.halvesNote')}</p>
      {improved && (
        <p className="pr-yr-call">{t('persona.annual.improved', { name: t(`persona.tags.${improved.k}.name`), a: per100(improved.a), b: per100(improved.b) })}</p>
      )}
    </>
  )
}

// 全年日历：每个月一小块，每天一格，颜色深浅按当天盈亏。
// The year calendar: a small block per month, a cell per day, tinted by that day's P&L.
function YearCalendar({ rep }: { rep: PersonaAnnual }) {
  const { t, i18n } = useTranslation()
  const byDay = useMemo(() => new Map(rep.calendar.map((d) => [d.day, d])), [rep.calendar])
  const maxAbs = Math.max(1, ...rep.calendar.map((d) => Math.abs(d.profit)))
  return (
    <>
      <h3 className="pr-h3">{t('persona.annual.heat')}</h3>
      <div className="pr-yr-cal">
        {rep.months.map((period) => {
          const [y, m] = period.split('-').map(Number)
          const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
          const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7
          return (
            <div key={period} className="pr-yr-mo">
              <span>{monthOnly(period, i18n.language)}</span>
              <div className="pr-yr-grid" role="img" aria-label={monthLabel(period, i18n.language)}>
                {Array.from({ length: lead }, (_, i) => <i key={`b${i}`} className="is-blank" />)}
                {Array.from({ length: days }, (_, i) => {
                  const key = `${period}-${String(i + 1).padStart(2, '0')}`
                  const row = byDay.get(key)
                  if (!row) return <i key={key} />
                  const a = 0.25 + Math.min(1, Math.abs(row.profit) / maxAbs) * 0.75
                  return <i key={key} title={`${key} · ${money(row.profit)} · ${t('persona.calendar.trades', { n: row.trades })}`}
                    style={{ background: `rgb(var(${row.profit >= 0 ? '--up-rgb' : '--down-rgb'}) / ${a.toFixed(2)})` }} />
                })}
              </div>
            </div>
          )
        })}
      </div>
      <p className="pr-small">{t('persona.calendar.utc')}</p>
    </>
  )
}

export default function AnnualReport({ rep, style, canOpen, onShare, sharing }: {
  rep: PersonaAnnual; style: ArtStyle; canOpen: boolean; onShare?: () => void; sharing?: boolean
}) {
  const { t, i18n } = useTranslation()
  const s = rep.summary
  const lang = i18n.language
  const covers = rep.months.length
    ? t('persona.annual.covers', { from: monthLabel(rep.months[0], lang), to: monthLabel(rep.months[rep.months.length - 1], lang), n: rep.months.length })
    : ''
  if (!s.trades) return <div className="pr-slab pr-empty">{t('persona.annual.empty')}</div>
  const badges = Object.entries(rep.badges) as [PersonaBadge, number][]
  const rail: { k: string; v: string; cls?: string }[] = [
    { k: 'winRate', v: pct(s.winRate) },
    { k: 'payoff', v: num(s.payoff, 2) },
    { k: 'trades', v: String(s.trades) },
    { k: 'days', v: t('persona.report.daysValue', { g: s.greenDays, n: s.tradingDays }) },
    { k: 'drawdown', v: money(-s.maxDrawdown, false), cls: s.maxDrawdown > 0 ? 'is-down' : '' },
    { k: 'hold', v: s.medianHoldMin == null ? EMPTY : fmtMinutes(t as T, s.medianHoldMin) },
  ]
  return (
    <div className="pr-month pr-year">
      {rep.live && <p className="pr-live"><span className="pr-live-dot" aria-hidden="true" />{t('persona.annual.preview')}</p>}
      <div className={`pr-slab pr-yr-head ${s.profit > 0 ? 'tone-up' : s.profit < 0 ? 'tone-down' : ''}`}>
        <div className="pr-yr-top">
          <div>
            <span className="pr-k">{t('persona.annual.net', { y: rep.year })}</span>
            <b className={`pr-pnl-num num ${tone(s.profit)}`}>{money(s.profit)}</b>
            <p className="pr-small">{covers}</p>
          </div>
          <div className="pr-yr-score">
            <b className="num">{s.score ?? EMPTY}</b>
            <span>/ 100 · {t('persona.report.stat.score')}</span>
            {onShare && (
              <button type="button" className="btn-primary pr-btn" onClick={onShare} disabled={sharing}>
                {sharing ? t('share.generating') : t('persona.card.shareAnnual')}
              </button>
            )}
          </div>
        </div>
        <dl className="pr-rail">
          {rail.map((x) => <div key={x.k}><dt>{t(`persona.report.stat.${x.k}`)}</dt><dd className={`num ${x.cls ?? ''}`}>{x.v}</dd></div>)}
        </dl>
      </div>

      <div className="pr-panel"><Monthly rep={rep} /></div>
      {rep.journey.steps.length > 0 && <div className="pr-panel"><Journey rep={rep} style={style} /></div>}
      <div className="pr-panel"><Records rep={rep} canOpen={canOpen} /></div>
      <div className={rep.halves ? 'pr-grid2' : 'pr-grid1'}>
        {rep.halves && <div className="pr-panel"><Halves rep={rep} /></div>}
        <div className="pr-panel"><YearCalendar rep={rep} /></div>
      </div>

      <div className="pr-panel">
        <h3 className="pr-h3">{t('persona.annual.tags')}</h3>
        <div className="pr-tags">
          {TAGS.map((k) => {
            const x = rep.tags[k] ?? { count: 0, profit: 0 }
            return (
              <div key={k} className={`pr-tag ${x.count ? '' : 'is-zero'}`}>
                <span className="pr-tag-n">{x.count}</span>
                <div className="pr-tag-body">
                  <b>{t(`persona.tags.${k}.name`)}</b>
                  <p>{t(`persona.tags.${k}.desc`)}</p>
                  {x.count > 0 && <span className={`num pr-tag-p ${tone(x.profit)}`}>{money(x.profit)}</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {(badges.length > 0 || rep.streaks.length > 0) && (
        <div className={badges.length > 0 && rep.streaks.length > 0 ? 'pr-grid2' : 'pr-grid1'}>
          {badges.length > 0 && (
            <div className="pr-panel">
              <h3 className="pr-h3">{t('persona.annual.badges')}</h3>
              <ul className="pr-badges">
                {badges.sort((a, b) => b[1] - a[1]).map(([b, n]) => (
                  <li key={b}><b>{t(`persona.badges.${b}.name`)}</b><span>{t('persona.annual.badgeTimes', { n })}</span></li>
                ))}
              </ul>
            </div>
          )}
          {rep.streaks.length > 0 && (
            <div className="pr-panel">
              <h3 className="pr-h3">{t('persona.annual.streaks')}</h3>
              <ul className="pr-streaks">
                {rep.streaks.map((x) => (
                  <li key={x.key}>
                    <div className="pr-streak-top"><span>{t(`persona.streak.${x.key}`)}</span><b className="num">{t(`persona.streak.unit.${x.unit}`, { n: x.best })}</b></div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
