// 管理控制台「财经日历」（2026-11-20，第一期只给管理员看）：仿 Forex Factory——
// 右侧小月历，点某一周看那一周全部数据；表格一行一个指标（日期 / 时间 / 货币 / 影响 / 事件 /
// 公布 / 预期 / 前值）；已经过去的行变暗，下一条将公布的标箭头；点一行展开 AI 写的三种情景预案。
// Admin "Economic calendar" (admin-only for now), Forex Factory style: a mini month calendar on the
// side (click a week to see that week), one row per figure, past rows dimmed, an arrow on the next
// release, and the three-scenario preview on click.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { EconGroup, EconOutcome, EconStatus, EconValue } from '../../../api/econTypes'
import { localizeApiError } from '../../../api/utils'
import Switch from '../../Switch'
import { segBtn } from '../../../utils/segBtn'
import { useToast } from '../../../utils/useToast'

const OUTCOMES: EconOutcome[] = ['above', 'inline', 'below']

// ---- 日期工具（全部按浏览器本地时区）/ date helpers, all in the browser's local zone ----

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

/** 这一周的周日（和 Forex Factory 一样周日开始）/ the Sunday that starts this week, like FF */
function weekStartOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  return addDays(x, -x.getDay())
}

function dayKey(g: EconGroup): string {
  return g.at ? ymd(new Date(g.at)) : (g.date ?? '')
}

function fmtDay(day: string, lang: string): string {
  const d = new Date(`${day}T00:00:00`)
  if (Number.isNaN(d.getTime())) return day
  return d.toLocaleDateString(lang, { weekday: 'short', month: 'short', day: 'numeric' })
}

// Narwhal 的数值有时是字符串（"3.5"），先转成数字；转不了就原样显示。
// Narwhal sometimes sends figures as strings ("3.5"); coerce, else show as-is.
function fmtNum(raw: number | string | null | undefined, unit?: string | null): string {
  if (raw === null || raw === undefined || raw === '') return ''
  const v = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(v)) return String(raw)
  const s = Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)))
  return unit === 'percent' || unit === '%' ? `${s}%` : s
}

// 指标 id → 可读名：employment_change → Employment Change，cpi_yoy → CPI y/y
// Measure id → readable name.
const UPPER = new Set(['cpi', 'ppi', 'gdp', 'pmi', 'pce', 'hicp', 'ism', 'zew', 'ifo', 'nfp', 'rpi', 'uom', 'anz', 'nab', 'kof', 'cbi', 'adp'])
const SUFFIX: Record<string, string> = { yoy: 'y/y', mom: 'm/m', qoq: 'q/q', ann: '(ann.)', sa: '(s.a.)', '3m': '3m' }
function humanize(measure: string): string {
  return measure
    .split('_')
    .map((w) => SUFFIX[w] ?? (UPPER.has(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ')
}

// 表里列哪几项：有预期值的（Forex Factory 也只列有预测的），主指标排第一；都没有就只列主指标，
// 再没有就一行发布名。/ Rows: measures with a consensus (primary first); else the primary; else the release name.
function shownValues(g: EconGroup): EconValue[] {
  const withCons = g.values.filter((v) => v.consensus !== null && v.consensus !== undefined && v.consensus !== '')
  const primary = g.values.find((v) => v.measure === g.primaryMeasure)
  const list = withCons.length ? withCons : primary ? [primary] : []
  return [...list].sort((a, b) => (a.measure === g.primaryMeasure ? -1 : b.measure === g.primaryMeasure ? 1 : 0))
}

type Row = { label: string; v: EconValue | null; importance: number }

function rowsOf(g: EconGroup, zh: boolean, minImp: number): Row[] {
  const c = g.preview?.status === 'ok' ? g.preview.content : null
  const values = shownValues(g)
  const rows: Row[] = values.length
    ? values.map((v) => ({ label: (zh && c?.names_zh[v.measure]) || humanize(v.measure), v, importance: v.importance ?? g.importance }))
    : [
        {
          label: (c && (zh ? c.title_zh : c.title_en)) || [...new Set(g.releases.map((r) => r.name))].join(' · '),
          v: null,
          importance: g.importance,
        },
      ]
  return rows.filter((r) => r.importance >= minImp)
}

function isPast(g: EconGroup, now: number): boolean {
  if (g.at) return new Date(g.at).getTime() <= now
  return !!g.date && g.date < ymd(new Date(now))
}

function Impact({ n }: { n: number }) {
  // Forex Factory 的三色：黄 / 橙 / 红 / Forex Factory's yellow / orange / red
  const color = n >= 3 ? 'bg-[#e8322b]' : n >= 2 ? 'bg-[#f7941d]' : n >= 1 ? 'bg-[#f5d90a]' : 'bg-neutral-600'
  return <span className={`inline-block h-3.5 w-2.5 rounded-sm align-middle ${color}`} aria-label={`importance ${n}`} />
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
  const dayNames = Array.from({ length: 7 }, (_, i) => addDays(first, i).toLocaleDateString(lang, { weekday: 'narrow' }))

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
  const [week, setWeek] = useState(() => weekStartOf(new Date()))
  const [minImp, setMinImp] = useState(1)
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


  const weekDays = useMemo(() => new Set(Array.from({ length: 7 }, (_, i) => ymd(addDays(week, i)))), [week])

  const byDay = useMemo(() => {
    const m = new Map<string, { g: EconGroup; rows: Row[] }[]>()
    for (const g of items) {
      const k = dayKey(g)
      if (!weekDays.has(k)) continue
      const rows = rowsOf(g, zh, minImp)
      if (!rows.length) continue
      m.set(k, [...(m.get(k) ?? []), { g, rows }])
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [items, weekDays, zh, minImp])

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
              {st?.status.lastSyncAt ? new Date(st.status.lastSyncAt).toLocaleString([], { hour12: false }) : '—'}
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
                <Switch checked={cfg.enabled} busy={busy === 'enabled'} onChange={(v) => save({ enabled: v }, 'enabled')} />
                {t('admin.econ.enabled')}
              </label>
              <label className="flex items-center gap-2">
                <Switch checked={cfg.previews} busy={busy === 'previews'} onChange={(v) => save({ previews: v }, 'previews')} />
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
                  const list = countries.split(/[,\s]+/).map((c) => c.trim().toUpperCase()).filter(Boolean)
                  if (list.join(',') !== cfg.countries.join(',')) void save({ countries: list }, 'countries')
                }}
                className="flex-1 rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono text-xs text-neutral-100"
              />
            </label>
            <p className="text-xs text-neutral-500">{t('admin.econ.hint')}</p>
          </div>
        )}
      </section>

      <div className="flex flex-col gap-3 lg:flex-row-reverse lg:items-start">
        <aside className="space-y-2 lg:sticky lg:top-4 lg:w-60 lg:shrink-0">
          <MiniCalendar week={week} onPick={setWeek} lang={i18n.language} />
          <div className="glass space-y-2 rounded-2xl p-3 text-xs text-neutral-400">
            <div>{t('admin.econ.impactFilter')}</div>
            <div className="flex gap-1.5">
              {[1, 2, 3].map((n) => (
                <button key={n} type="button" className={`${segBtn(minImp === n)} flex items-center gap-1`} onClick={() => setMinImp(n)}>
                  <Impact n={n} />
                  {n < 3 ? '+' : ''}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="w-full rounded-lg border border-prism-500/50 bg-prism-600/20 px-3 py-1.5 text-xs font-medium text-prism-100 disabled:opacity-50"
              disabled={busy === 'sync' || !st?.narwhalConfigured}
              onClick={sync}
            >
              {busy === 'sync' ? t('admin.econ.syncing') : t('admin.econ.syncWeek')}
            </button>
          </div>
        </aside>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex items-center gap-2 px-1 text-sm">
            <button type="button" className={segBtn(false)} onClick={() => setWeek(addDays(week, -7))} aria-label="previous week">
              ‹
            </button>
            <span className="font-medium tabular-nums text-neutral-200">{weekLabel}</span>
            <button type="button" className={segBtn(false)} onClick={() => setWeek(addDays(week, 7))} aria-label="next week">
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
                      />
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}

          <p className="text-right text-[11px] text-neutral-600">
            Data by{' '}
            <a href="https://narwhalapi.com" target="_blank" rel="noreferrer" className="underline hover:text-neutral-400">
              Narwhal API
            </a>
          </p>
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
}: {
  g: EconGroup
  rows: Row[]
  zh: boolean
  dayLabel: string
  showTime: boolean
  past: boolean
  next: boolean
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const c = g.preview?.status === 'ok' ? g.preview.content : null
  const time =
    g.allDay || !g.at
      ? t('admin.econ.allDay')
      : new Date(g.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  // 已经过去的整组变暗（和 FF 一样），下一条将公布的标箭头并加底色
  // Past groups are dimmed (like FF); the next one gets an arrow and a tint.
  const tone = g.status === 'cancelled' ? 'opacity-30' : past ? 'opacity-50' : ''

  return (
    <>
      {rows.map((r, i) => (
        <tr
          key={r.v?.measure ?? 'name'}
          className={`cursor-pointer hover:bg-white/[0.04] ${i === 0 ? 'border-t border-white/5' : ''} ${
            next ? 'bg-amber-400/[0.06]' : ''
          }`}
          onClick={() => setOpen((o) => !o)}
        >
          <td className="px-3 py-1.5 text-xs text-neutral-300">{i === 0 ? dayLabel : ''}</td>
          <td className={`whitespace-nowrap px-2 py-1.5 font-mono text-xs tabular-nums ${next ? 'text-amber-300' : 'text-neutral-400'} ${tone}`}>
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
          <td className={`px-2 py-1.5 text-right tabular-nums text-neutral-400 ${tone}`}>{r.v ? fmtNum(r.v.consensus, r.v.unit) : ''}</td>
          <td className={`px-2 py-1.5 text-right tabular-nums text-neutral-500 ${tone}`}>{r.v ? fmtNum(r.v.previous, r.v.unit) : ''}</td>
          <td className={`px-3 py-1.5 text-right text-xs ${tone}`}>
            {i === 0 &&
              (c ? (
                <span className="text-prism-200">
                  {g.outcome ? t(`admin.econ.outcomeShort.${g.outcome.outcome}`) : '●'}
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
                          <span className="font-medium text-neutral-200">{t(`admin.econ.outcome.${o}`)}</span>
                          {s.impacts.map((im) => (
                            <span
                              key={im.asset}
                              className={`font-mono ${
                                im.direction === 'bullish' ? 'text-emerald-300' : im.direction === 'bearish' ? 'text-rose-300' : 'text-neutral-500'
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
                  : !g.primaryMeasure
                    ? t('admin.econ.whyNoPreview.noConsensus')
                    : g.importance < 2
                      ? t('admin.econ.whyNoPreview.low')
                      : past
                        ? t('admin.econ.whyNoPreview.past')
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
