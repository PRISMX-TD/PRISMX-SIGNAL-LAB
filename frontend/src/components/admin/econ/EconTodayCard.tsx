// 仪表盘「今日财经」卡片（2026-11-21）：放在第三栏「其他活跃信号」下面，所有登录用户可见
// （管理员在日历设置里关掉「对用户开放」时不显示）。列出今天的橙 / 红数据：已公布的变暗并显示结果，下一项带箭头
// 和倒计时，有预案的带标记；点任意一行进完整日历并定位到那一条。今天没有数据时显示下一个有
// 数据的日子。手机上只列还没公布的。
// Dashboard "today's calendar" card, under "other active signals" in the third column; for every signed-in
// user (hidden while an admin has "open to users" switched off). Today's orange / red figures: published ones dimmed with their
// result, an arrow and a countdown on the next, a tag where a preview exists; any row opens the full
// calendar at that entry. With nothing today it shows the next day that has data. Phones list only
// what is still ahead.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { econApi } from '../../../api/client'
import type { EconGroup } from '../../../api/econTypes'
import { Impact, addDays, dayKey, fmtNum, isPast, rowsOf, ymd, type Row } from './econShared'

const MAX_ROWS = 7
const REFRESH_MS = 5 * 60_000
const SHOWN_LEVELS: ReadonlySet<number> = new Set([2, 3])

type Entry = { g: EconGroup; row: Row; past: boolean }

function filled(v: number | string | null | undefined): boolean {
  return v !== null && v !== undefined && v !== ''
}

function Countdown({ to }: { to: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])
  const s = Math.max(0, Math.floor((to - now) / 1000))
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = Math.floor(s / 86400)
  const hms = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
  return <span className="num ml-auto text-[13px] font-semibold text-strong">{d > 0 ? `${d}d ${hms}` : hms}</span>
}

export default function EconTodayCard() {
  const { t, i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const [items, setItems] = useState<EconGroup[] | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        // 后端按 UTC 日期切片：从昨天取 10 天。本地「今天」在里面；周末这一周没数据了，也够得到
        // 下一周的头几天，卡片就显示下一个有数据的日子
        // The backend slices by UTC date; ten days from yesterday cover local today and, at the weekend
        // when this week is done, the first days of next week, so the card shows the next day with data
        const cal = await econApi.calendar(ymd(addDays(new Date(), -1)), 10, 2)
        // 管理员关掉「对用户开放」时整张卡不显示 / hidden entirely while "open to users" is off
        if (alive) setItems(cal.public ? cal.items : null)
      } catch {
        /* 仪表盘上不为这张卡报错，下一轮再试 / stay quiet on the dashboard, retry next round */
      }
    }
    void load()
    const id = window.setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      window.clearInterval(id)
    }
  }, [])

  // 半分钟走一次「现在」：到点后行变暗、箭头换到下一项 / dimming and the arrow follow the clock
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const view = useMemo(() => {
    if (!items) return null
    const today = ymd(new Date(now))
    const byDay = new Map<string, Entry[]>()
    for (const g of items) {
      const day = dayKey(g)
      if (g.status === 'cancelled' || day < today) continue
      const past = isPast(g, now)
      for (const row of rowsOf(g, zh, SHOWN_LEVELS)) byDay.set(day, [...(byDay.get(day) ?? []), { g, row, past }])
    }
    const day = byDay.has(today) ? today : [...byDay.keys()].sort()[0]
    if (!day) return { day: null, isToday: false, list: [] as Entry[], hidden: 0, nextAt: null, nextCount: 0 }
    const all = byDay.get(day) ?? []
    // 行数有上限：先保住还没公布的，剩下的位置给最近公布的 / upcoming rows first, then the latest published
    const upcoming = all.filter((e) => !e.past)
    const keptPast = all.filter((e) => e.past).slice(-Math.max(0, MAX_ROWS - upcoming.length))
    const list = [...keptPast, ...upcoming.slice(0, MAX_ROWS)]
    const timed = upcoming.filter((e) => e.g.at)
    const nextAt = timed.length ? timed.reduce((m, e) => (e.g.at! < m ? e.g.at! : m), timed[0].g.at!) : null
    return {
      day,
      isToday: day === today,
      list,
      hidden: all.length - list.length,
      nextAt,
      nextCount: nextAt ? timed.filter((e) => e.g.at === nextAt).length : 0,
    }
  }, [items, now, zh])

  if (!view) return null

  const dayLabel = view.day
    ? new Date(`${view.day}T00:00:00`).toLocaleDateString(i18n.language, {
        month: 'short',
        day: 'numeric',
        weekday: 'short',
      })
    : ''
  const linkTo = (g?: EconGroup) =>
    view.day ? `/calendar?${new URLSearchParams({ day: view.day, ...(g ? { focus: g.key } : {}) })}` : '/calendar'

  return (
    <section className="card glass p-[18px] sm:p-6">
      <div className="flex items-baseline gap-2">
        <h3 className="text-base font-bold text-white">
          {t(view.isToday || !view.day ? 'econ.today.title' : 'econ.today.titleNext')}
        </h3>
        <span className="text-xs text-neutral-400">{dayLabel}</span>
        <Link to={linkTo()} className="dh-link ml-auto">
          {t('econ.today.full')} ›
        </Link>
      </div>

      {view.list.length === 0 ? (
        <p className="mt-4 text-sm text-neutral-500">{t('econ.today.empty')}</p>
      ) : (
        <ul className="mt-2">
          {view.list.map(({ g, row, past }) => {
            const isNext = !past && !!view.nextAt && g.at === view.nextAt
            const time =
              g.allDay || !g.at
                ? t('econ.allDay')
                : new Date(g.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
            const v = row.v
            return (
              <li key={`${g.key}:${v?.measure ?? 'name'}`} className={past ? 'max-md:hidden' : ''}>
                <Link
                  to={linkTo(g)}
                  className="-mx-2 grid grid-cols-[10px_40px_10px_minmax(0,1fr)] items-center gap-x-2 gap-y-px rounded-md border-t border-white/[0.07] px-2 py-2 transition-colors hover:bg-white/[0.04]"
                >
                  <span className="text-[9px] text-prism-400" aria-hidden="true">
                    {isNext ? '▶' : ''}
                  </span>
                  <span
                    className={`num text-xs ${past ? 'text-neutral-500' : isNext ? 'font-semibold text-strong' : 'text-neutral-300'}`}
                  >
                    {time}
                  </span>
                  <span className={past ? 'opacity-50' : ''}>
                    <Impact n={row.importance} />
                  </span>
                  <span
                    className={`truncate text-[13px] ${past ? 'text-neutral-500' : isNext ? 'font-semibold text-strong' : 'text-neutral-100'}`}
                  >
                    <span className="num mr-1.5 text-[11px] font-medium text-neutral-400">
                      {g.currency ?? g.country}
                    </span>
                    {row.label}
                    {!past && g.preview?.status === 'ok' && (
                      <span className="ml-1.5 rounded border border-prism-400/40 px-1 text-[10px] font-normal text-prism-400">
                        {t('econ.previewCol')}
                      </span>
                    )}
                  </span>
                  {v && (filled(v.actual) || filled(v.consensus) || filled(v.previous)) && (
                    <span className={`col-start-4 text-[11px] ${past ? 'text-neutral-500' : 'text-neutral-400'}`}>
                      {filled(v.actual) && (
                        <span className="mr-3">
                          {t('econ.actual')}{' '}
                          <b className="num font-medium text-neutral-200">{fmtNum(v.actual, v.unit)}</b>
                        </span>
                      )}
                      {filled(v.consensus) && (
                        <span className="mr-3">
                          {t('econ.consensus')}{' '}
                          <b className={`num font-medium ${past ? '' : 'text-neutral-200'}`}>
                            {fmtNum(v.consensus, v.unit)}
                          </b>
                        </span>
                      )}
                      {!filled(v.actual) && filled(v.previous) && (
                        <span>
                          {t('econ.previous')} <span className="num">{fmtNum(v.previous, v.unit)}</span>
                        </span>
                      )}
                    </span>
                  )}
                </Link>
              </li>
            )
          })}
        </ul>
      )}

      {view.hidden > 0 && (
        <Link to={linkTo()} className="mt-1 block text-xs text-neutral-400 hover:text-strong">
          {t('econ.today.more', { n: view.hidden })}
        </Link>
      )}

      {view.nextAt && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-[var(--nest)] px-2.5 py-2 text-xs text-neutral-300">
          <span>{view.nextCount > 1 ? t('econ.today.nextInMany', { n: view.nextCount }) : t('econ.today.nextIn')}</span>
          {/* key：换了下一项就重建倒计时 / remount when the next item changes */}
          <Countdown key={view.nextAt} to={new Date(view.nextAt).getTime()} />
        </div>
      )}
    </section>
  )
}
