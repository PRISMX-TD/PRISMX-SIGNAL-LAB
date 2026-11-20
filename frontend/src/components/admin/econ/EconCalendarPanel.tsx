// 管理控制台「财经日历」（2026-11-20，第一期只给管理员看）：仿 Forex Factory 的紧凑表格——
// 日期 / 时间 / 货币 / 影响 / 事件 / 公布 / 预期 / 前值，一行一个指标；点一行展开 AI 写的三种情景预案，
// 公布后高亮命中的那一种。数据源状态和设置收在顶部一行，设置默认折叠。
// Admin "Economic calendar" (admin-only for now): a compact Forex Factory-style table, one row per
// figure; click a row for the three-scenario preview (the matched one highlighted once the actual
// lands). Source status sits in one line on top; settings are collapsed by default.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { EconGroup, EconOutcome, EconStatus, EconValue } from '../../../api/econTypes'
import { localizeApiError } from '../../../api/utils'
import Switch from '../../Switch'
import { segBtn } from '../../../utils/segBtn'
import { useToast } from '../../../utils/useToast'

const OUTCOMES: EconOutcome[] = ['above', 'inline', 'below']
const DAY_OPTIONS = [3, 7, 14]

// Narwhal 的数值有时是字符串（"3.5"），先转成数字；转不了就原样显示。
// Narwhal sometimes sends figures as strings ("3.5"); coerce, else show as-is.
function fmtNum(raw: number | string | null | undefined, unit?: string | null): string {
  if (raw === null || raw === undefined || raw === '') return ''
  const v = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(v)) return String(raw)
  const s = Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)))
  return unit === 'percent' || unit === '%' ? `${s}%` : s
}

function dayKey(g: EconGroup): string {
  if (g.at) {
    const d = new Date(g.at)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  return g.date ?? ''
}

function fmtDay(day: string, lang: string): string {
  const d = new Date(`${day}T00:00:00`)
  if (Number.isNaN(d.getTime())) return day
  return d.toLocaleDateString(lang, { weekday: 'short', month: 'short', day: 'numeric' })
}

// 指标 id → 可读名：employment_change → Employment Change，cpi_yoy → CPI y/y
// Measure id → readable name.
const UPPER = new Set(['cpi', 'ppi', 'gdp', 'pmi', 'pce', 'hicp', 'ism', 'zew', 'ifo', 'nfp', 'rpi', 'uom', 'ecb', 'boe', 'boj'])
const SUFFIX: Record<string, string> = { yoy: 'y/y', mom: 'm/m', qoq: 'q/q', ann: '(ann.)', sa: '(s.a.)' }
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

function Impact({ n }: { n: number }) {
  const color = n >= 3 ? 'bg-rose-500' : n >= 2 ? 'bg-amber-400' : n >= 1 ? 'bg-yellow-200/60' : 'bg-neutral-600'
  return <span className={`inline-block h-3.5 w-2.5 rounded-sm align-middle ${color}`} aria-label={`importance ${n}`} />
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
  const [days, setDays] = useState(7)
  const [minImp, setMinImp] = useState(2)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [countries, setCountries] = useState('')
  const [showSettings, setShowSettings] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [st, cal] = await Promise.all([adminApi.econStatus(), adminApi.econCalendar(null, days, minImp)])
      setStatus(st)
      setCountries(st.settings.countries.join(', '))
      setItems(cal.items)
    } catch (e) {
      fail(e)
    } finally {
      setLoading(false)
    }
  }, [days, minImp, fail])

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
      await adminApi.econSync()
      showToast('ok', t('admin.econ.synced'))
      await load()
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const regenerate = async (key: string) => {
    setBusy(`re:${key}`)
    try {
      const g = await adminApi.econRegenerate(key)
      setItems((list) => list.map((x) => (x.key === key ? g : x)))
    } catch (e) {
      fail(e)
    } finally {
      setBusy(null)
    }
  }

  const byDay = useMemo(() => {
    const m = new Map<string, EconGroup[]>()
    for (const g of items) {
      const k = dayKey(g)
      m.set(k, [...(m.get(k) ?? []), g])
    }
    return [...m.entries()]
  }, [items])

  const st = status
  const cfg = st?.settings

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
          <span className="ml-auto flex gap-2">
            <button type="button" className={segBtn(showSettings)} onClick={() => setShowSettings((v) => !v)}>
              {t('admin.econ.settings')}
            </button>
            <button
              type="button"
              className="rounded-lg border border-prism-500/50 bg-prism-600/20 px-3 py-1.5 text-xs font-medium text-prism-100 disabled:opacity-50"
              disabled={busy === 'sync' || !st?.narwhalConfigured}
              onClick={sync}
            >
              {busy === 'sync' ? t('admin.econ.syncing') : t('admin.econ.syncNow')}
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

      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400">
        {DAY_OPTIONS.map((d) => (
          <button key={d} type="button" className={segBtn(days === d)} onClick={() => setDays(d)}>
            {t('admin.econ.days', { n: d })}
          </button>
        ))}
        <span className="mx-2 h-4 w-px bg-white/10" />
        {[1, 2, 3].map((n) => (
          <button key={n} type="button" className={segBtn(minImp === n)} onClick={() => setMinImp(n)}>
            {t('admin.econ.atLeast', { n })}
          </button>
        ))}
        <button type="button" className={segBtn(false)} onClick={() => void load()} disabled={loading}>
          {t('admin.econ.refresh')}
        </button>
      </div>

      {!loading && items.length === 0 ? (
        <p className="glass rounded-2xl p-6 text-center text-sm text-neutral-500">{t('admin.econ.empty')}</p>
      ) : (
        <div className="glass overflow-x-auto rounded-2xl">
          <table className="w-full min-w-[680px] text-[13px]">
            <thead>
              <tr className="border-b border-white/10 text-left text-[11px] text-neutral-500">
                <th className="w-28 px-3 py-2 font-normal">{t('admin.econ.date')}</th>
                <th className="w-14 px-2 font-normal">{t('admin.econ.time')}</th>
                <th className="w-12 px-2 font-normal">{t('admin.econ.currency')}</th>
                <th className="w-12 px-2 font-normal">{t('admin.econ.impact')}</th>
                <th className="px-2 font-normal">{t('admin.econ.event')}</th>
                <th className="w-20 px-2 text-right font-normal">{t('admin.econ.actual')}</th>
                <th className="w-20 px-2 text-right font-normal">{t('admin.econ.consensus')}</th>
                <th className="w-20 px-2 text-right font-normal">{t('admin.econ.previous')}</th>
                <th className="w-16 px-3 text-right font-normal">{t('admin.econ.previewCol')}</th>
              </tr>
            </thead>
            {byDay.map(([day, groups]) => (
              <tbody key={day} className="border-b border-white/10 last:border-b-0">
                {groups.map((g, gi) => (
                  <GroupRows
                    key={g.key}
                    g={g}
                    zh={zh}
                    dayLabel={gi === 0 ? fmtDay(day, i18n.language) : ''}
                    busy={busy === `re:${g.key}`}
                    canRegen={!!st?.deepseekConfigured}
                    onRegen={() => regenerate(g.key)}
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
  )
}

function GroupRows({
  g,
  zh,
  dayLabel,
  busy,
  canRegen,
  onRegen,
}: {
  g: EconGroup
  zh: boolean
  dayLabel: string
  busy: boolean
  canRegen: boolean
  onRegen: () => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const c = g.preview?.status === 'ok' ? g.preview.content : null
  const time =
    g.allDay || !g.at
      ? t('admin.econ.allDay')
      : new Date(g.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  const values = shownValues(g)
  const rows: { label: string; v: EconValue | null }[] = values.length
    ? values.map((v) => ({ label: (zh && c?.names_zh[v.measure]) || humanize(v.measure), v }))
    : [{ label: (c && (zh ? c.title_zh : c.title_en)) || [...new Set(g.releases.map((r) => r.name))].join(' · '), v: null }]

  return (
    <>
      {rows.map((r, i) => (
        <tr
          key={r.v?.measure ?? 'name'}
          className={`cursor-pointer hover:bg-white/[0.03] ${i === 0 ? 'border-t border-white/5' : ''} ${
            g.status === 'cancelled' ? 'opacity-40' : ''
          }`}
          onClick={() => setOpen((o) => !o)}
        >
          <td className="px-3 py-1.5 text-xs text-neutral-300">{i === 0 ? dayLabel : ''}</td>
          <td className="px-2 py-1.5 font-mono text-xs tabular-nums text-neutral-400">{i === 0 ? time : ''}</td>
          <td className="px-2 py-1.5 text-xs font-semibold text-neutral-300">{g.currency ?? g.country}</td>
          <td className="px-2 py-1.5">
            <Impact n={g.importance} />
          </td>
          <td className="px-2 py-1.5 text-neutral-100">{r.label}</td>
          <td
            className={`px-2 py-1.5 text-right tabular-nums ${
              r.v?.measure === g.primaryMeasure ? 'font-semibold text-neutral-50' : 'text-neutral-200'
            }`}
          >
            {r.v ? fmtNum(r.v.actual, r.v.unit) : ''}
          </td>
          <td className="px-2 py-1.5 text-right tabular-nums text-neutral-400">{r.v ? fmtNum(r.v.consensus, r.v.unit) : ''}</td>
          <td className="px-2 py-1.5 text-right tabular-nums text-neutral-500">{r.v ? fmtNum(r.v.previous, r.v.unit) : ''}</td>
          <td className="px-3 py-1.5 text-right text-xs">
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
                <p className="text-xs text-neutral-400">{zh ? c.why_zh : c.why_en}</p>
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
                {g.preview?.status === 'failed' ? g.preview.error : t('admin.econ.noPreview')}
              </p>
            )}
            <div className="mt-2 flex items-center gap-3 text-[11px] text-neutral-600">
              {g.preview?.model && (
                <span>
                  {g.preview.model} · {g.preview.tokensIn ?? 0}/{g.preview.tokensOut ?? 0} tokens
                </span>
              )}
              {g.at && g.status !== 'cancelled' && (
                <button
                  type="button"
                  className={`ml-auto ${segBtn(false, !canRegen || busy)}`}
                  disabled={!canRegen || busy}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRegen()
                  }}
                >
                  {busy ? t('admin.econ.writing') : g.preview ? t('admin.econ.regenerate') : t('admin.econ.generate')}
                </button>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  )
}
