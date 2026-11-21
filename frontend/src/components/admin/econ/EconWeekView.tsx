// 财经日历的显示部分（2026-11-21 重做，样式在 styles/econ.css）。取数、设置、同步都在
// EconCalendarPanel，这里只负责把一周的数据画出来：
//   工具条（翻周 + 影响筛选）、手机上的七天周条、按天分段的列表、点开的预案、电脑侧栏的小月历。
// 手机上一次只看一天（周条选哪天看哪天），所以不需要横向滚动；电脑上整周一起看。两种排法用同一份
// DOM，靠 CSS 在 1024px 切换，不在 JS 里判断屏幕宽度。
//
// The display half of the economic calendar (styles in styles/econ.css). Fetching, settings and
// sync stay in EconCalendarPanel; this draws one week: toolbar (week nav + impact filter), the
// seven-day strip on phones, the per-day list, the expandable preview and the desktop mini
// calendar. Phones show one day at a time (picked on the strip) so nothing scrolls sideways;
// desktop shows the whole week. Both layouts share one DOM and switch in CSS at 1024px.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { EconGroup, EconOutcome } from '../../../api/econTypes'
import { Countdown, addDays, dayKey, filled, fmtNum, isPast, rowsOf, weekStartOf, ymd, type Row } from './econShared'
import '../../../styles/econ.css'

const OUTCOMES: EconOutcome[] = ['above', 'inline', 'below']
const LEVELS = [3, 2, 1]

function Imp({ n }: { n: number }) {
  return <i className={`ec-imp l${Math.max(0, Math.min(3, n))}`} aria-hidden="true" />
}

function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00`)
}

// ---- 小月历（电脑侧栏）/ mini month calendar (desktop aside) ----

function MiniCalendar({ week, onPick, lang }: { week: Date; onPick: (weekStart: Date) => void; lang: string }) {
  const [month, setMonth] = useState(() => new Date(week.getFullYear(), week.getMonth(), 1))
  useEffect(() => {
    // 选中的周跑到别的月份时，月历跟过去 / follow the picked week into another month
    const end = addDays(week, 6)
    const inView = (d: Date) => d.getFullYear() === month.getFullYear() && d.getMonth() === month.getMonth()
    if (!inView(week) && !inView(end)) setMonth(new Date(week.getFullYear(), week.getMonth(), 1))
  }, [week, month])

  const first = weekStartOf(month)
  const weeks = Array.from({ length: 6 }, (_, i) => addDays(first, i * 7)).filter(
    (w, i) => i < 4 || w.getMonth() === month.getMonth(),
  )
  const today = ymd(new Date())
  const picked = ymd(week)
  const dayNames = Array.from({ length: 7 }, (_, i) =>
    addDays(first, i).toLocaleDateString(lang, { weekday: 'narrow' }),
  )

  return (
    <div className="ec-cal">
      <div className="ec-cal-head">
        <button
          type="button"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          aria-label="previous month"
        >
          ‹
        </button>
        <span>{month.toLocaleDateString(lang, { year: 'numeric', month: 'long' })}</span>
        <button
          type="button"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          aria-label="next month"
        >
          ›
        </button>
      </div>
      <div className="ec-cal-names">
        {dayNames.map((n, i) => (
          <span key={i}>{n}</span>
        ))}
      </div>
      {weeks.map((w) => (
        <button
          key={ymd(w)}
          type="button"
          onClick={() => onPick(w)}
          aria-pressed={ymd(w) === picked}
          className={`ec-cal-week ${ymd(w) === picked ? 'is-on' : ''}`}
        >
          {Array.from({ length: 7 }, (_, i) => {
            const d = addDays(w, i)
            const cls = ymd(d) === today ? 'today' : d.getMonth() !== month.getMonth() ? 'other' : ''
            return (
              <span key={i} className={cls}>
                {d.getDate()}
              </span>
            )
          })}
        </button>
      ))}
    </div>
  )
}

// ---- 一组（一份报告）/ one group (a report) ----

function GroupBlock({
  g,
  rows,
  zh,
  admin,
  past,
  showTime,
  isNext,
  showCountdown,
  newMoment,
  focused,
}: {
  g: EconGroup
  rows: Row[]
  zh: boolean
  admin: boolean
  past: boolean
  showTime: boolean
  isNext: boolean
  showCountdown: boolean
  newMoment: boolean
  focused: boolean
}) {
  const { t } = useTranslation()
  const c = g.preview?.status === 'ok' ? g.preview.content : null
  // 用户端只有写好预案的组能点开；管理台都能点开（看没写的原因、模型用量）
  // Users can open only groups with a finished preview; admins can open any (reason, model usage)
  const canOpen = admin || !!c
  const [open, setOpen] = useState(focused && canOpen)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'center' })
  }, [focused])

  const time =
    g.allDay || !g.at
      ? t('econ.allDay')
      : new Date(g.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const cancelled = g.status === 'cancelled'
  const toggle = () => canOpen && setOpen((o) => !o)
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    toggle()
  }
  const tag = c ? (
    <span className={`ec-tag ${g.outcome ? 'is-hit' : ''}`}>
      {g.outcome ? t(`econ.scenario.${g.outcome.basis ?? 'consensus'}.${g.outcome.outcome}`) : t('econ.previewCol')}
    </span>
  ) : admin && g.preview?.status === 'failed' ? (
    <span className="ec-tag is-fail">!</span>
  ) : null

  return (
    <div
      ref={ref}
      className={`ec-group ${newMoment ? 'new-moment' : ''} ${canOpen ? 'can-open' : ''} ${open ? 'is-open' : ''}`}
      {...(canOpen ? { role: 'button', tabIndex: 0, 'aria-expanded': open, onClick: toggle, onKeyDown: onKey } : {})}
    >
      {rows.map((r, i) => {
        const v = r.v
        const hasActual = !!v && filled(v.actual)
        const hasSub = !!v && (filled(v.consensus) || filled(v.previous))
        const countdown = i === 0 && showCountdown && !hasActual && !!g.at
        const bare = !hasSub && !hasActual && !countdown
        return (
          <div
            key={v?.measure ?? 'name'}
            className={`ec-row ${past ? 'is-past' : ''} ${isNext ? 'is-next' : ''} ${cancelled ? 'is-cancelled' : ''} ${bare ? 'is-bare' : ''}`}
          >
            <span className="ec-time">
              {i === 0 && showTime && (
                <>
                  <span className="arrow" aria-hidden="true">
                    {isNext ? '▶' : ''}
                  </span>
                  {time}
                </>
              )}
            </span>
            <span className="ec-main-cell">
              <Imp n={r.importance} />
              <span className="ec-cur">{g.currency ?? g.country}</span>
              <span className="ec-name">{r.label}</span>
            </span>
            {hasActual ? (
              <span className="ec-val">{fmtNum(v.actual, v.unit)}</span>
            ) : countdown ? (
              <Countdown to={new Date(g.at!).getTime()} className="ec-val is-count" />
            ) : null}
            {v && (
              <span className="ec-sub">
                <span className={`ec-kv c ${filled(v.consensus) ? '' : 'is-empty'}`}>
                  <span className="k">{t('econ.consensus')}</span>
                  <span className="v">{fmtNum(v.consensus, v.unit)}</span>
                </span>
                <span className={`ec-kv p ${filled(v.previous) ? '' : 'is-empty'}`}>
                  <span className="k">{t('econ.previous')}</span>
                  <span className="v">{fmtNum(v.previous, v.unit)}</span>
                </span>
              </span>
            )}
            {i === 0 && tag}
          </div>
        )
      })}

      {open && (
        // 面板里的点击不收起：要能选中文字 / clicks inside do not collapse, so text can be selected
        <div className="ec-panel" onClick={(e) => e.stopPropagation()}>
          {c ? (
            <>
              <h4>{zh ? c.title_zh : c.title_en}</h4>
              <p>{zh ? c.why_zh : c.why_en}</p>
              {(zh ? c.background_zh : c.background_en) && (
                <p>
                  <span className="k">{t('econ.background')}</span>
                  {zh ? c.background_zh : c.background_en}
                </p>
              )}
              {(zh ? c.watch_zh : c.watch_en) && (
                <p>
                  <span className="k">{t('econ.watch')}</span>
                  {zh ? c.watch_zh : c.watch_en}
                </p>
              )}
              <div className="ec-scn">
                {OUTCOMES.map((o) => {
                  const s = c.scenarios[o]
                  const hit = g.outcome?.outcome === o
                  return (
                    <div key={o} className={`ec-sc ${hit ? 'is-hit' : g.outcome ? 'is-miss' : ''}`}>
                      <div className="ec-sc-head">
                        <b>{t(`econ.scenario.${c.basis ?? 'consensus'}.${o}`)}</b>
                        {s.impacts.map((im) => (
                          <span
                            key={im.asset}
                            className={`imp ${im.direction === 'bullish' ? 'up' : im.direction === 'bearish' ? 'down' : ''}`}
                          >
                            {im.asset}
                            {im.direction === 'bullish' ? '↑' : im.direction === 'bearish' ? '↓' : ''}
                            <small>{t(`econ.strength.${im.strength}`)}</small>
                          </span>
                        ))}
                      </div>
                      <p>{zh ? s.reason_zh : s.reason_en}</p>
                    </div>
                  )
                })}
              </div>
              <span className="foot">
                {admin
                  ? g.preview?.model
                    ? `${g.preview.model} · ${g.preview.tokensIn ?? 0}/${g.preview.tokensOut ?? 0} tokens`
                    : ''
                  : t('econ.aiNote')}
              </span>
            </>
          ) : (
            <p>
              {g.preview?.status === 'failed'
                ? g.preview.error
                : g.importance < 2
                  ? t('admin.econ.whyNoPreview.low')
                  : past
                    ? t('admin.econ.whyNoPreview.past')
                    : g.values.length > 0 && !g.values.some((x) => filled(x.consensus) || filled(x.previous))
                      ? t('admin.econ.whyNoPreview.noConsensus')
                      : t('admin.econ.previewPending')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ---- 一周 / the week ----

export default function EconWeekView({
  week,
  onWeek,
  items,
  loading,
  now,
  levels,
  onToggleLevel,
  focusKey,
  initialDay,
  admin,
  emptyText,
  adminActions,
}: {
  week: Date
  onWeek: (weekStart: Date) => void
  items: EconGroup[]
  loading: boolean
  now: number
  levels: ReadonlySet<number>
  onToggleLevel: (n: number) => void
  focusKey: string | null
  /** 地址里指定的那一天（从仪表盘卡片点进来）/ the day named in the URL (arriving from the dashboard card) */
  initialDay: string | null
  admin: boolean
  emptyText: string
  adminActions?: ReactNode
}) {
  const { t, i18n } = useTranslation()
  const lang = i18n.language
  const zh = lang.startsWith('zh')
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => ymd(addDays(week, i))), [week])
  const today = ymd(new Date(now))

  const { byDay, counts } = useMemo(() => {
    const inWeek = new Set(days)
    const m = new Map<string, { g: EconGroup; rows: Row[] }[]>()
    // 这一周各影响级别有几项（不受筛选影响）/ items per impact level this week, ignoring the filter
    const c: Record<number, number> = { 1: 0, 2: 0, 3: 0 }
    for (const g of items) {
      const k = dayKey(g)
      if (!inWeek.has(k)) continue
      for (const r of rowsOf(g, zh)) c[Math.max(1, Math.min(3, r.importance))] += 1
      const rows = rowsOf(g, zh, levels)
      if (rows.length) m.set(k, [...(m.get(k) ?? []), { g, rows }])
    }
    return { byDay: m, counts: c }
  }, [items, days, zh, levels])

  // 下一个公布时刻（同一时刻可能有好几份报告）/ the next release moment (several reports may share it)
  const nextAt = useMemo(() => {
    let best: string | null = null
    for (const list of byDay.values())
      for (const { g } of list)
        if (g.at && g.status !== 'cancelled' && new Date(g.at).getTime() > now && (!best || g.at < best)) best = g.at
    return best
  }, [byDay, now])

  // 手机上选中的那一天。没选过（或翻了周）时：今天有数据看今天，否则看今天之后第一个有数据的日子，
  // 再否则这一周第一个有数据的日子。
  // The day shown on phones. Unpicked (or after a week change): today if it has rows, else the next
  // day with rows, else the first day with rows.
  const [picked, setPicked] = useState<string | null>(initialDay)
  const activeDay = useMemo(() => {
    if (picked && days.includes(picked)) return picked
    const withRows = days.filter((d) => byDay.has(d))
    return withRows.find((d) => d >= today) ?? withRows[0] ?? (days.includes(today) ? today : days[0])
  }, [picked, days, byDay, today])

  const fmt = (d: Date, o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(lang, o)
  const weekLabel = `${fmt(week, { month: 'short', day: 'numeric' })} - ${fmt(addDays(week, 6), { month: 'short', day: 'numeric' })}`
  const isThisWeek = ymd(week) === ymd(weekStartOf(new Date(now)))
  const goWeek = (w: Date) => {
    setPicked(null)
    onWeek(w)
  }

  return (
    <div className="ec">
      <div className="ec-main">
        <div className="ec-bar">
          <div className="ec-week">
            <button
              type="button"
              className="ec-icon-btn"
              onClick={() => goWeek(addDays(week, -7))}
              aria-label="previous week"
            >
              ‹
            </button>
            <span className="ec-week-label">{weekLabel}</span>
            <button
              type="button"
              className="ec-icon-btn"
              onClick={() => goWeek(addDays(week, 7))}
              aria-label="next week"
            >
              ›
            </button>
            {!isThisWeek && (
              <button type="button" className="ec-text-btn" onClick={() => goWeek(weekStartOf(new Date()))}>
                {t('econ.thisWeek')}
              </button>
            )}
          </div>
        </div>

        <div className="ec-days">
          {days.map((day) => {
            const d = parseDay(day)
            const present = new Set<number>()
            for (const { rows } of byDay.get(day) ?? []) for (const r of rows) present.add(Math.max(1, r.importance))
            return (
              <button
                key={day}
                type="button"
                className={`ec-day ${day === activeDay ? 'is-on' : ''} ${day < today ? 'is-past' : ''} ${day === today ? 'is-today' : ''} ${present.size ? '' : 'is-empty'}`}
                aria-pressed={day === activeDay}
                onClick={() => setPicked(day)}
              >
                <span className="w">{day === today ? t('econ.todayTag') : fmt(d, { weekday: 'short' })}</span>
                <span className="n">{d.getDate()}</span>
                <span className="marks" aria-hidden="true">
                  {LEVELS.filter((n) => present.has(n)).map((n) => (
                    <i key={n} className={`ec-imp l${n}`} />
                  ))}
                </span>
              </button>
            )
          })}
        </div>

        <div className="ec-levels" role="group" aria-label={t('econ.impactFilter')}>
          {LEVELS.map((n) => (
            <button
              key={n}
              type="button"
              className={`ec-level ${levels.has(n) ? 'is-on' : ''}`}
              aria-pressed={levels.has(n)}
              onClick={() => onToggleLevel(n)}
            >
              <Imp n={n} />
              {t(`econ.level.${n}`)}
              <b>{counts[n]}</b>
            </button>
          ))}
        </div>

        {loading && !items.length ? (
          <div className="ec-card ec-skel" aria-hidden="true">
            {Array.from({ length: 6 }, (_, i) => (
              <i key={i} className="skeleton" />
            ))}
          </div>
        ) : byDay.size === 0 ? (
          <p className="ec-empty">{emptyText}</p>
        ) : (
          <div className="ec-list">
            {days.map((day) => {
              const list = byDay.get(day)
              if (!list) return null
              return (
                <section key={day} className={`ec-daysec ${day === activeDay ? 'is-on' : ''}`}>
                  <div className="ec-dayhead">
                    <div className="t">
                      <h3>{fmt(parseDay(day), { month: 'long', day: 'numeric', weekday: 'long' })}</h3>
                      {day === today && <span className="today">{t('econ.todayTag')}</span>}
                    </div>
                    <span className="col">{t('econ.actual')}</span>
                    <span className="col">{t('econ.consensus')}</span>
                    <span className="col">{t('econ.previous')}</span>
                    <span className="col">{t('econ.previewCol')}</span>
                  </div>
                  <div className="ec-card">
                    {list.map(({ g, rows }, gi) => {
                      const showTime = gi === 0 || list[gi - 1].g.at !== g.at
                      const isNext = !!nextAt && g.at === nextAt
                      return (
                        <GroupBlock
                          key={g.key}
                          g={g}
                          rows={rows}
                          zh={zh}
                          admin={admin}
                          past={isPast(g, now)}
                          showTime={showTime}
                          isNext={isNext}
                          showCountdown={isNext && showTime}
                          newMoment={gi > 0 && showTime}
                          focused={g.key === focusKey}
                        />
                      )
                    })}
                  </div>
                </section>
              )
            })}
            {!byDay.has(activeDay) && <p className="ec-empty mobile-only">{t('econ.emptyDay')}</p>}
          </div>
        )}
      </div>

      <aside className={`ec-aside ${admin ? '' : 'is-user'}`}>
        <MiniCalendar week={week} onPick={goWeek} lang={lang} />
        {adminActions && <div className="ec-admin-actions">{adminActions}</div>}
      </aside>
    </div>
  )
}
