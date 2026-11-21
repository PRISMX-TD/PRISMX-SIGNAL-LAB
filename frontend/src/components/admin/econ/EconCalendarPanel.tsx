// 管理控制台「财经日历」（2026-11-20，第一期只给管理员看）：仿 Forex Factory——
// 右侧小月历，点某一周看那一周全部数据；表格一行一个指标（日期 / 时间 / 货币 / 影响 / 事件 /
// 公布 / 预期 / 前值）；已经过去的行变暗，下一条将公布的标箭头；点一行展开 AI 写的三种情景预案。
// Admin "Economic calendar" (admin-only for now), Forex Factory style: a mini month calendar on the
// side (click a week to see that week), one row per figure, past rows dimmed, an arrow on the next
// release, and the three-scenario preview on click.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { EconGroup, EconOutcome, EconStatus } from '../../../api/econTypes'
import { localizeApiError } from '../../../api/utils'
import Switch from '../../Switch'
import { segBtn } from '../../../utils/segBtn'
import { useToast } from '../../../utils/useToast'
import { Impact, addDays, dayKey, fmtNum, isPast, rowsOf, ymd, type Row } from './econShared'

const LEVELS_KEY = 'econ.impactLevels'
const OUTCOMES: EconOutcome[] = ['above', 'inline', 'below']

// ---- 日期工具（全部按浏览器本地时区）/ date helpers, all in the browser's local zone ----

/** 这一周的周日（和 Forex Factory 一样周日开始）/ the Sunday that starts this week, like FF */
function weekStartOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  return addDays(x, -x.getDay())
}

function fmtDay(day: string, lang: string): string {
  const d = new Date(`${day}T00:00:00`)
  if (Number.isNaN(d.getTime())) return day
  return d.toLocaleDateString(lang, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

// ---- 小月历 / mini month calendar ----

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
    <div className="glass rounded-2xl p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <button
          type="button"
          className="rounded px-2 py-0.5 text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          aria-label="previous month"
        >
          ‹
        </button>
        <span className="font-medium text-neutral-200">
          {month.toLocaleDateString(lang, { year: 'numeric', month: 'long' })}
        </span>
        <button
          type="button"
          className="rounded px-2 py-0.5 text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
          onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          aria-label="next month"
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 text-center text-[10px] text-neutral-500">
        {dayNames.map((n, i) => (
          <span key={i} className="py-1">
            {n}
          </span>
        ))}
      </div>
      {weeks.map((w) => {
        const on = ymd(w) === picked
        return (
          <button
            key={ymd(w)}
            type="button"
            onClick={() => onPick(w)}
            className={`grid w-full grid-cols-7 rounded-md text-center tabular-nums transition ${
              on ? 'bg-prism-600/30 text-prism-100' : 'hover:bg-white/5'
            }`}
          >
            {Array.from({ length: 7 }, (_, i) => {
              const d = addDays(w, i)
              const other = d.getMonth() !== month.getMonth()
              const isToday = ymd(d) === today
              return (
                <span
                  key={i}
                  className={`py-1 ${other ? 'text-neutral-600' : on ? '' : 'text-neutral-300'} ${
                    isToday ? 'font-bold text-amber-300' : ''
                  }`}
                >
                  {d.getDate()}
                </span>
              )
            })}
          </button>
        )
      })}
      <button
        type="button"
        className="mt-2 w-full rounded-md py-1 text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
        onClick={() => onPick(weekStartOf(new Date()))}
      >
        ↺
      </button>
    </div>
  )
}

export default function EconCalendarPanel() {
  const { t, i18n } = useTranslation()
  const zh = i18n.language.startsWith('zh')
  const { toast, showToast } = useToast()
  const fail = useCallback(
    (e: unknown) => showToast('err', e instanceof Error ? localizeApiError(e.message) : String(e)),
    [showToast],
  )
  const [status, setStatus] = useState<EconStatus | null>(null)
  const [items, setItems] = useState<EconGroup[]>([])
  // 从仪表盘「今日财经」卡片点进来：?day= 决定打开哪一周，?focus= 是要展开并滚到的那一组
  // Arriving from the dashboard card: ?day= picks the week, ?focus= is the group to open and scroll to
  const [params] = useSearchParams()
  const focusKey = params.get('focus')
  const [week, setWeek] = useState(() => {
    const d = new Date(`${params.get('day') ?? ''}T00:00:00`)
    return weekStartOf(Number.isNaN(d.getTime()) ? new Date() : d)
  })
  // 影响筛选：黄 / 橙 / 红各自开关（像 Forex Factory 的勾选），记在本机
  // Impact filter: yellow / orange / red toggled independently (like FF's checkboxes), remembered locally
  const [levels, setLevels] = useState<ReadonlySet<number>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(LEVELS_KEY) ?? 'null')
      if (Array.isArray(saved) && saved.length) return new Set(saved.filter((n) => [1, 2, 3].includes(n)))
    } catch {
      /* 读不到就用默认 / fall back to the default */
    }
    return new Set([1, 2, 3])
  })
  const toggleLevel = (n: number) => {
    const next = new Set(levels)
    if (next.has(n)) next.delete(n)
    else next.add(n)
    if (!next.size) return // 至少留一个 / keep at least one
    setLevels(next)
    try {
      localStorage.setItem(LEVELS_KEY, JSON.stringify([...next]))
    } catch {
      /* 存不了也没关系 / not critical */
    }
  }
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [countries, setCountries] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // 每分钟刷新「现在」，让变暗和箭头跟着时间走 / tick every minute so dimming and the arrow move
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  // 后端按 UTC 日期取数，本地一周可能跨进前后一天的 UTC 日期，所以前后各多取一天再在前端按本地日期筛。
  // The backend slices by UTC date; fetch a day either side and filter by local date here.
  const fetchStart = ymd(addDays(week, -1))
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [st, cal] = await Promise.all([adminApi.econStatus(), adminApi.econCalendar(fetchStart, 9, 1)])
      setStatus(st)
      setCountries(st.settings.countries.join(', '))
      setItems(cal.items)
    } catch (e) {
      fail(e)
    } finally {
      setLoading(false)
    }
  }, [fetchStart, fail])

  useEffect(() => {
    void load()
  }, [load])

  const save = async (patch: Parameters<typeof adminApi.econSaveSettings>[0], tag: string) => {
    setBusy(tag)
    try {
      const s = await adminApi.econSaveSettings(patch)
      setStatus((st) => (st ? { ...st, settings: s } : st))
      setCountries(s.countries.join(', '))
      showToast('ok', t('admin.econ.saved'))
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const sync = async () => {
    setBusy('sync')
    try {
      await adminApi.econSync(fetchStart, 9)
      showToast('ok', t('admin.econ.synced'))
      await load()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  // 测试阶段：管理员一键生成这一周的全部预案（后台跑，下面轮询进度）
  // Testing phase: generate every preview for this week (runs in the background; progress polled below)
  const generateWeek = async () => {
    setBusy('gen')
    try {
      await adminApi.econGenerateWeek(fetchStart, 9)
      const st = await adminApi.econStatus()
      setStatus(st)
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const job = status?.status.weekJob
  const jobRunning = !!job?.running
  useEffect(() => {
    if (!jobRunning) return
    const id = window.setInterval(async () => {
      try {
        const st = await adminApi.econStatus()
        setStatus(st)
        if (!st.status.weekJob?.running) {
          void load()
          const j = st.status.weekJob
          showToast(
            j?.capHit || j?.failed ? 'err' : 'ok',
            t(j?.capHit ? 'admin.econ.genCapHit' : 'admin.econ.genDone', {
              done: j?.done ?? 0,
              failed: j?.failed ?? 0,
            }),
          )
        } else {
          // 边写边刷新表格，写好的组马上能点开 / refresh the table so finished groups open right away
          const cal = await adminApi.econCalendar(fetchStart, 9, 1)
          setItems(cal.items)
        }
      } catch {
        /* 下一轮再试 / retry next tick */
      }
    }, 4000)
    return () => window.clearInterval(id)
  }, [jobRunning, fetchStart, load, showToast, t])

  const weekDays = useMemo(() => new Set(Array.from({ length: 7 }, (_, i) => ymd(addDays(week, i)))), [week])

  const byDay = useMemo(() => {
    const m = new Map<string, { g: EconGroup; rows: Row[] }[]>()
    for (const g of items) {
      const k = dayKey(g)
      if (!weekDays.has(k)) continue
      const rows = rowsOf(g, zh, levels)
      if (!rows.length) continue
      m.set(k, [...(m.get(k) ?? []), { g, rows }])
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [items, weekDays, zh, levels])

  // 这一周各影响级别有几项（不受筛选影响）/ items per impact level this week, ignoring the filter
  const levelCounts = useMemo(() => {
    const c: Record<number, number> = { 1: 0, 2: 0, 3: 0 }
    for (const g of items) {
      if (!weekDays.has(dayKey(g))) continue
      for (const r of rowsOf(g, zh)) c[Math.max(1, Math.min(3, r.importance))] += 1
    }
    return c
  }, [items, weekDays, zh])

  // 下一条将公布的（带具体时刻、还没到点的第一组）/ the next timed group still ahead
  const nextKey = useMemo(() => {
    let best: EconGroup | null = null
    for (const [, list] of byDay)
      for (const { g } of list)
        if (g.at && g.status !== 'cancelled' && new Date(g.at).getTime() > now && (!best || g.at < best.at!)) best = g
    return best?.key ?? null
  }, [byDay, now])

  const st = status
  const cfg = st?.settings
  const weekLabel = `${addDays(week, 0).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })} – ${addDays(week, 6).toLocaleDateString(i18n.language, { month: 'short', day: 'numeric' })}`

  return (
    <div className="space-y-3">
      {toast && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            toast.kind === 'err' ? 'border-down/40 bg-down/15 text-down' : 'border-up/40 bg-up/15 text-up'
          }`}
        >
          {toast.text}
        </div>
      )}

      <section className="glass space-y-3 rounded-2xl px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-neutral-400">
          <span className={st?.narwhalConfigured && st?.deepseekConfigured ? 'text-emerald-300' : 'text-rose-300'}>
            Narwhal {st?.narwhalConfigured ? '✓' : '✗'} · DeepSeek {st?.deepseekConfigured ? '✓' : '✗'}
          </span>
          <span>
            {t('admin.econ.balance')} <b className="tabular-nums text-neutral-200">{st?.status.balance ?? '—'}</b>
          </span>
          <span>
            {t('admin.econ.lastSync')}{' '}
            <b className="tabular-nums text-neutral-200">
              {st?.status.lastSyncAt
                ? new Date(st.status.lastSyncAt).toLocaleString([], {
                    hour12: false,
                  })
                : '—'}
            </b>
          </span>
          <span>
            {t('admin.econ.llmToday')}{' '}
            <b className="tabular-nums text-neutral-200">
              {st?.llmCallsToday ?? 0}/{cfg?.dailyLlmCap ?? '—'}
            </b>
          </span>
          <span className={cfg?.enabled ? 'text-emerald-300' : 'text-neutral-500'}>
            {cfg?.enabled ? t('admin.econ.autoOn') : t('admin.econ.autoOff')}
          </span>
          <span className="ml-auto">
            <button type="button" className={segBtn(showSettings)} onClick={() => setShowSettings((v) => !v)}>
              {t('admin.econ.settings')}
            </button>
          </span>
        </div>
        {st?.status.lastError && (
          <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {t('admin.econ.lastError')}: {st.status.lastError}
          </p>
        )}
        {cfg && showSettings && (
          <div className="space-y-3 border-t border-white/5 pt-3">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-sm">
              <label className="flex items-center gap-2">
                <Switch
                  checked={cfg.enabled}
                  busy={busy === 'enabled'}
                  onChange={(v) => save({ enabled: v }, 'enabled')}
                />
                {t('admin.econ.enabled')}
              </label>
              <label className="flex items-center gap-2">
                <Switch
                  checked={cfg.previews}
                  busy={busy === 'previews'}
                  onChange={(v) => save({ previews: v }, 'previews')}
                />
                {t('admin.econ.previews')}
              </label>
              <label className="flex items-center gap-2 text-xs text-neutral-400">
                {t('admin.econ.minImportance')}
                {[1, 2, 3].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={segBtn(cfg.previewMinImportance === n)}
                    onClick={() => save({ previewMinImportance: n }, 'imp')}
                  >
                    {n}
                  </button>
                ))}
              </label>
              <label className="flex items-center gap-2 text-xs text-neutral-400">
                {t('admin.econ.dailyCap')}
                <input
                  type="number"
                  min={0}
                  max={2000}
                  defaultValue={cfg.dailyLlmCap}
                  key={cfg.dailyLlmCap}
                  className="w-20 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-sm text-neutral-100"
                  onBlur={(e) => {
                    const v = Number(e.target.value)
                    if (Number.isFinite(v) && v !== cfg.dailyLlmCap) void save({ dailyLlmCap: v }, 'cap')
                  }}
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-xs text-neutral-400">
              {t('admin.econ.countries')}
              <input
                value={countries}
                onChange={(e) => setCountries(e.target.value)}
                onBlur={() => {
                  const list = countries
                    .split(/[,\s]+/)
                    .map((c) => c.trim().toUpperCase())
                    .filter(Boolean)
                  if (list.join(',') !== cfg.countries.join(',')) void save({ countries: list }, 'countries')
                }}
                className="flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono text-xs text-neutral-100"
              />
            </label>
          </div>
        )}
      </section>

      <div className="flex flex-col gap-3 lg:flex-row-reverse lg:items-start">
        <aside className="space-y-2 lg:sticky lg:top-4 lg:w-60 lg:shrink-0">
          <MiniCalendar week={week} onPick={setWeek} lang={i18n.language} />
          <div className="glass space-y-2 rounded-2xl p-3 text-xs text-neutral-400">
            <div className="flex items-center justify-between">
              <span>{t('admin.econ.impactFilter')}</span>
              {levels.size < 3 && (
                <button
                  type="button"
                  className="text-[11px] text-prism-300 hover:text-prism-200"
                  onClick={() => {
                    setLevels(new Set([1, 2, 3]))
                    try {
                      localStorage.removeItem(LEVELS_KEY)
                    } catch {
                      /* ignore */
                    }
                  }}
                >
                  {t('admin.econ.showAll')}
                </button>
              )}
            </div>
            <div className="space-y-1">
              {[3, 2, 1].map((n) => {
                const on = levels.has(n)
                return (
                  <button
                    key={n}
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => toggleLevel(n)}
                    className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition ${
                      on
                        ? 'border-white/15 bg-white/[0.06] text-neutral-100'
                        : 'border-transparent text-neutral-500 hover:bg-white/[0.03]'
                    }`}
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                        on ? 'border-prism-400 bg-prism-500 text-white' : 'border-white/20'
                      }`}
                    >
                      {on ? '✓' : ''}
                    </span>
                    <Impact n={n} />
                    <span className="flex-1">{t(`admin.econ.level.${n}`)}</span>
                    <span className="tabular-nums text-neutral-500">{levelCounts[n]}</span>
                  </button>
                )
              })}
            </div>
            <button
              type="button"
              className="w-full rounded-lg border border-prism-500/50 bg-prism-600/20 px-3 py-1.5 text-xs font-medium text-prism-100 disabled:opacity-50"
              disabled={busy === 'sync' || !st?.narwhalConfigured}
              onClick={sync}
            >
              {busy === 'sync' ? t('admin.econ.syncing') : t('admin.econ.syncWeek')}
            </button>
            <button
              type="button"
              className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-white/10 disabled:opacity-50"
              disabled={jobRunning || busy === 'gen' || !st?.deepseekConfigured}
              onClick={generateWeek}
            >
              {jobRunning
                ? t('admin.econ.generating', { done: (job?.done ?? 0) + (job?.failed ?? 0), total: job?.total ?? 0 })
                : t('admin.econ.generateWeek')}
            </button>
          </div>
        </aside>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 px-1 text-sm">
            <button
              type="button"
              className={segBtn(false)}
              onClick={() => setWeek(addDays(week, -7))}
              aria-label="previous week"
            >
              ‹
            </button>
            <span className="font-medium tabular-nums text-neutral-200">{weekLabel}</span>
            <button
              type="button"
              className={segBtn(false)}
              onClick={() => setWeek(addDays(week, 7))}
              aria-label="next week"
            >
              ›
            </button>
            {loading && <span className="text-xs text-neutral-500">…</span>}
          </div>

          {!loading && byDay.length === 0 ? (
            <p className="glass rounded-2xl p-6 text-center text-sm text-neutral-500">{t('admin.econ.emptyWeek')}</p>
          ) : (
            <div className="glass overflow-x-auto rounded-2xl">
              <table className="w-full min-w-[680px] text-[13px]">
                <thead>
                  <tr className="border-b border-white/10 text-left text-[11px] text-neutral-500">
                    <th className="w-28 px-3 py-2 font-normal">{t('admin.econ.date')}</th>
                    <th className="w-16 px-2 font-normal">{t('admin.econ.time')}</th>
                    <th className="w-12 px-2 font-normal">{t('admin.econ.currency')}</th>
                    <th className="w-12 px-2 font-normal">{t('admin.econ.impact')}</th>
                    <th className="px-2 font-normal">{t('admin.econ.event')}</th>
                    <th className="w-20 px-2 text-right font-normal">{t('admin.econ.actual')}</th>
                    <th className="w-20 px-2 text-right font-normal">{t('admin.econ.consensus')}</th>
                    <th className="w-20 px-2 text-right font-normal">{t('admin.econ.previous')}</th>
                    <th className="w-16 px-3 text-right font-normal">{t('admin.econ.previewCol')}</th>
                  </tr>
                </thead>
                {byDay.map(([day, list]) => (
                  <tbody key={day} className="border-b border-white/10 last:border-b-0">
                    {list.map(({ g, rows }, gi) => (
                      <GroupRows
                        key={g.key}
                        g={g}
                        rows={rows}
                        zh={zh}
                        dayLabel={gi === 0 ? fmtDay(day, i18n.language) : ''}
                        showTime={gi === 0 || list[gi - 1].g.at !== g.at}
                        past={isPast(g, now)}
                        next={g.key === nextKey}
                        focused={g.key === focusKey}
                      />
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function GroupRows({
  g,
  rows,
  zh,
  dayLabel,
  showTime,
  past,
  next,
  focused,
}: {
  g: EconGroup
  rows: Row[]
  zh: boolean
  dayLabel: string
  showTime: boolean
  past: boolean
  next: boolean
  focused: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(focused)
  const firstRow = useRef<HTMLTableRowElement>(null)
  useEffect(() => {
    if (focused) firstRow.current?.scrollIntoView({ block: 'center' })
  }, [focused])
  const c = g.preview?.status === 'ok' ? g.preview.content : null
  const time =
    g.allDay || !g.at
      ? t('admin.econ.allDay')
      : new Date(g.at).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
  // 已经过去的整组变暗（和 FF 一样），下一条将公布的标箭头并加底色
  // Past groups are dimmed (like FF); the next one gets an arrow and a tint.
  const tone = g.status === 'cancelled' ? 'opacity-30' : past ? 'opacity-50' : ''

  return (
    <>
      {rows.map((r, i) => (
        <tr
          key={r.v?.measure ?? 'name'}
          ref={i === 0 ? firstRow : undefined}
          className={`cursor-pointer hover:bg-white/[0.04] ${i === 0 ? 'border-t border-white/5' : ''} ${
            next ? 'bg-amber-400/[0.06]' : ''
          }`}
          onClick={() => setOpen((o) => !o)}
        >
          <td className="px-3 py-1.5 text-xs text-neutral-300">{i === 0 ? dayLabel : ''}</td>
          <td
            className={`whitespace-nowrap px-2 py-1.5 font-mono text-xs tabular-nums ${next ? 'text-amber-300' : 'text-neutral-400'} ${tone}`}
          >
            {i === 0 && showTime ? (
              <>
                {next && <span className="mr-1">▶</span>}
                {time}
              </>
            ) : i === 0 && next ? (
              <span>▶</span>
            ) : (
              ''
            )}
          </td>
          <td className={`px-2 py-1.5 text-xs font-semibold text-neutral-300 ${tone}`}>{g.currency ?? g.country}</td>
          <td className="px-2 py-1.5">
            <Impact n={r.importance} />
          </td>
          <td className={`px-2 py-1.5 text-neutral-100 ${tone}`}>{r.label}</td>
          <td
            className={`px-2 py-1.5 text-right tabular-nums ${
              r.v?.measure === g.primaryMeasure ? 'font-semibold text-neutral-50' : 'text-neutral-200'
            } ${tone}`}
          >
            {r.v ? fmtNum(r.v.actual, r.v.unit) : ''}
          </td>
          <td className={`px-2 py-1.5 text-right tabular-nums text-neutral-400 ${tone}`}>
            {r.v ? fmtNum(r.v.consensus, r.v.unit) : ''}
          </td>
          <td className={`px-2 py-1.5 text-right tabular-nums text-neutral-500 ${tone}`}>
            {r.v ? fmtNum(r.v.previous, r.v.unit) : ''}
          </td>
          <td className={`px-3 py-1.5 text-right text-xs ${tone}`}>
            {i === 0 &&
              (c ? (
                <span className="text-prism-200">
                  {g.outcome
                    ? t(`admin.econ.scenarioShort.${g.outcome.basis ?? 'consensus'}.${g.outcome.outcome}`)
                    : '●'}
                </span>
              ) : g.preview?.status === 'failed' ? (
                <span className="text-rose-300">!</span>
              ) : (
                <span className="text-neutral-700">—</span>
              ))}
          </td>
        </tr>
      ))}
      {open && (
        <tr>
          <td colSpan={9} className="bg-white/[0.02] px-4 py-3">
            {c ? (
              <div className="space-y-2">
                <p className="text-sm text-neutral-200">{zh ? c.title_zh : c.title_en}</p>
                <p className="text-xs leading-relaxed text-neutral-400">{zh ? c.why_zh : c.why_en}</p>
                {(zh ? c.background_zh : c.background_en) && (
                  <p className="text-xs leading-relaxed text-neutral-400">
                    <span className="mr-1 text-neutral-500">{t('admin.econ.background')}</span>
                    {zh ? c.background_zh : c.background_en}
                  </p>
                )}
                {(zh ? c.watch_zh : c.watch_en) && (
                  <p className="text-xs leading-relaxed text-neutral-400">
                    <span className="mr-1 text-neutral-500">{t('admin.econ.watch')}</span>
                    {zh ? c.watch_zh : c.watch_en}
                  </p>
                )}
                <div className="grid gap-2 sm:grid-cols-3">
                  {OUTCOMES.map((o) => {
                    const s = c.scenarios[o]
                    const hit = g.outcome?.outcome === o
                    return (
                      <div
                        key={o}
                        className={`rounded-lg border p-2 text-xs ${hit ? 'border-prism-500/60 bg-prism-600/15' : 'border-white/10'} ${
                          g.outcome && !hit ? 'opacity-40' : ''
                        }`}
                      >
                        <div className="mb-1 flex flex-wrap items-center gap-1.5">
                          <span className="font-medium text-neutral-200">
                            {t(`admin.econ.scenario.${c.basis ?? 'consensus'}.${o}`)}
                          </span>
                          {s.impacts.map((im) => (
                            <span
                              key={im.asset}
                              className={`font-mono ${
                                im.direction === 'bullish'
                                  ? 'text-emerald-300'
                                  : im.direction === 'bearish'
                                    ? 'text-rose-300'
                                    : 'text-neutral-500'
                              }`}
                            >
                              {im.asset}
                              {im.direction === 'bullish' ? '↑' : im.direction === 'bearish' ? '↓' : '–'}
                              <span className="ml-0.5 text-neutral-500">{t(`admin.econ.strength.${im.strength}`)}</span>
                            </span>
                          ))}
                        </div>
                        <p className="text-neutral-400">{zh ? s.reason_zh : s.reason_en}</p>
                      </div>
                    )
                  })}
                </div>
              </div>
            ) : (
              <p className="text-xs text-neutral-500">
                {g.preview?.status === 'failed'
                  ? g.preview.error
                  : g.importance < 2
                    ? t('admin.econ.whyNoPreview.low')
                    : past
                      ? t('admin.econ.whyNoPreview.past')
                      : g.values.length > 0 &&
                          !g.values.some((v) => (v.consensus ?? '') !== '' || (v.previous ?? '') !== '')
                        ? t('admin.econ.whyNoPreview.noConsensus')
                        : t('admin.econ.previewPending')}
              </p>
            )}
            <div className="mt-2 flex items-center gap-3 text-[11px] text-neutral-600">
              {g.preview?.model && (
                <span>
                  {g.preview.model} · {g.preview.tokensIn ?? 0}/{g.preview.tokensOut ?? 0} tokens
                </span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
