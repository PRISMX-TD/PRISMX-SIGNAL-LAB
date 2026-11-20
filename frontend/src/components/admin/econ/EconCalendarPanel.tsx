// 管理控制台「财经日历」（2026-11-20，第一期只给管理员看）：数据源状态、开关和设置、立即同步、
// 按日分组的日历，每组带公布值 / 预期 / 前值和 AI 写的三种情景预案，公布后高亮命中的那一种。
// Admin "Economic calendar" (admin-only for now): source status, switch and settings, sync now,
// and a day-grouped calendar whose groups carry figures and the three-scenario preview, with the
// matched scenario highlighted once the actual lands.
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
  if (raw === null || raw === undefined || raw === '') return '—'
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

function Stars({ n }: { n: number }) {
  return (
    <span className="font-mono text-xs tracking-tight" aria-label={`importance ${n}`}>
      <span className={n >= 3 ? 'text-rose-400' : n >= 2 ? 'text-amber-300' : 'text-neutral-400'}>{'●'.repeat(n)}</span>
      <span className="text-neutral-700">{'●'.repeat(Math.max(0, 3 - n))}</span>
    </span>
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
  const [days, setDays] = useState(7)
  const [minImp, setMinImp] = useState(2)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [countries, setCountries] = useState('')

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
    <div className="space-y-4">
      {toast && (
        <div
          className={`rounded-lg border px-3 py-2 text-sm ${
            toast.kind === 'err' ? 'border-down/40 bg-down/15 text-down' : 'border-up/40 bg-up/15 text-up'
          }`}
        >
          {toast.text}
        </div>
      )}
      <section className="glass space-y-3 rounded-2xl p-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-neutral-400">
          <span>
            Narwhal:{' '}
            <b className={st?.narwhalConfigured ? 'text-emerald-300' : 'text-rose-300'}>
              {st?.narwhalConfigured ? t('admin.econ.keySet') : t('admin.econ.keyMissing')}
            </b>
          </span>
          <span>
            DeepSeek:{' '}
            <b className={st?.deepseekConfigured ? 'text-emerald-300' : 'text-rose-300'}>
              {st?.deepseekConfigured ? t('admin.econ.keySet') : t('admin.econ.keyMissing')}
            </b>
          </span>
          <span>
            {t('admin.econ.balance')}: <b className="tabular-nums text-neutral-200">{st?.status.balance ?? '—'}</b>
          </span>
          <span>
            {t('admin.econ.lastSync')}:{' '}
            <b className="tabular-nums text-neutral-200">
              {st?.status.lastSyncAt ? new Date(st.status.lastSyncAt).toLocaleString() : '—'}
            </b>
          </span>
          <span>
            {t('admin.econ.llmToday')}:{' '}
            <b className="tabular-nums text-neutral-200">
              {st?.llmCallsToday ?? 0} / {cfg?.dailyLlmCap ?? '—'}
            </b>
          </span>
          <span>
            {t('admin.econ.counts', { releases: st?.releases ?? 0, previews: st?.previews ?? 0 })}
          </span>
        </div>
        {st?.status.lastError && (
          <p className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {t('admin.econ.lastError')}: {st.status.lastError}
          </p>
        )}
        {cfg && (
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
            <label className="flex min-w-[16rem] flex-1 items-center gap-2 text-xs text-neutral-400">
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
            <button
              type="button"
              className="rounded-lg border border-prism-500/50 bg-prism-600/20 px-3 py-1.5 text-xs font-medium text-prism-100 disabled:opacity-50"
              disabled={busy === 'sync' || !st?.narwhalConfigured}
              onClick={sync}
            >
              {busy === 'sync' ? t('admin.econ.syncing') : t('admin.econ.syncNow')}
            </button>
          </div>
        )}
        <p className="text-xs text-neutral-500">{t('admin.econ.hint')}</p>
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

      {!loading && items.length === 0 && (
        <p className="glass rounded-2xl p-6 text-center text-sm text-neutral-500">{t('admin.econ.empty')}</p>
      )}

      {byDay.map(([day, groups]) => (
        <section key={day} className="space-y-2">
          <h3 className="px-1 text-xs font-semibold text-neutral-400">{day}</h3>
          {groups.map((g) => (
            <GroupCard key={g.key} g={g} zh={zh} busy={busy === `re:${g.key}`} canRegen={!!st?.deepseekConfigured} onRegen={() => regenerate(g.key)} />
          ))}
        </section>
      ))}

      <p className="text-right text-[11px] text-neutral-600">
        Data by{' '}
        <a href="https://narwhalapi.com" target="_blank" rel="noreferrer" className="underline hover:text-neutral-400">
          Narwhal API
        </a>
      </p>
    </div>
  )
}

function GroupCard({ g, zh, busy, canRegen, onRegen }: { g: EconGroup; zh: boolean; busy: boolean; canRegen: boolean; onRegen: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(g.importance >= 3)
  const c = g.preview?.status === 'ok' ? g.preview.content : null
  const time = g.allDay || !g.at ? t('admin.econ.allDay') : new Date(g.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const title = c ? (zh ? c.title_zh : c.title_en) : [...new Set(g.releases.map((r) => r.name))].join(' · ')
  const name = (v: EconValue) => (zh && c?.names_zh[v.measure]) || v.measure

  return (
    <article className="glass rounded-2xl p-3">
      <button type="button" className="flex w-full items-center gap-3 text-left" onClick={() => setOpen((o) => !o)}>
        <span className="w-12 shrink-0 font-mono text-xs tabular-nums text-neutral-300">{time}</span>
        <span className="w-10 shrink-0 font-mono text-xs text-neutral-400">{g.currency ?? g.country}</span>
        <Stars n={g.importance} />
        <span className="min-w-0 flex-1 truncate text-sm text-neutral-100">{title}</span>
        {g.status === 'cancelled' && <span className="text-xs text-neutral-500">{t('admin.econ.cancelled')}</span>}
        {g.outcome && (
          <span className={`rounded-md px-2 py-0.5 text-xs ${g.outcome.outcome === 'inline' ? 'bg-white/10 text-neutral-300' : 'bg-prism-600/30 text-prism-100'}`}>
            {t(`admin.econ.outcome.${g.outcome.outcome}`)}
          </span>
        )}
        {!g.preview && g.importance >= 2 && <span className="text-xs text-neutral-600">{t('admin.econ.noPreview')}</span>}
        {g.preview?.status === 'failed' && <span className="text-xs text-rose-300">{t('admin.econ.previewFailed')}</span>}
      </button>

      {open && (
        <div className="mt-3 space-y-3 border-t border-white/5 pt-3">
          {g.values.length > 0 && (
            <table className="w-full text-xs">
              <thead className="text-neutral-500">
                <tr>
                  <th className="py-1 text-left font-normal">{t('admin.econ.measure')}</th>
                  <th className="text-right font-normal">{t('admin.econ.actual')}</th>
                  <th className="text-right font-normal">{t('admin.econ.consensus')}</th>
                  <th className="text-right font-normal">{t('admin.econ.previous')}</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {g.values.map((v) => (
                  <tr key={v.measure} className={v.measure === g.primaryMeasure ? 'text-neutral-100' : 'text-neutral-400'}>
                    <td className="py-0.5">
                      {name(v)}
                      {v.measure === g.primaryMeasure && <span className="ml-1 text-prism-300">★</span>}
                    </td>
                    <td className="text-right">{fmtNum(v.actual, v.unit)}</td>
                    <td className="text-right">{fmtNum(v.consensus, v.unit)}</td>
                    <td className="text-right">{fmtNum(v.previous, v.unit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {c && (
            <div className="space-y-2">
              <p className="text-sm text-neutral-300">{zh ? c.why_zh : c.why_en}</p>
              {(zh ? c.focus_zh : c.focus_en) && <p className="text-xs text-neutral-500">{zh ? c.focus_zh : c.focus_en}</p>}
              <div className="grid gap-2 sm:grid-cols-3">
                {OUTCOMES.map((o) => {
                  const s = c.scenarios[o]
                  const hit = g.outcome?.outcome === o
                  return (
                    <div
                      key={o}
                      className={`rounded-xl border p-2.5 text-xs ${hit ? 'border-prism-500/60 bg-prism-600/15' : 'border-white/10 bg-white/[0.02]'} ${g.outcome && !hit ? 'opacity-50' : ''}`}
                    >
                      <div className="mb-1.5 font-medium text-neutral-200">{t(`admin.econ.outcome.${o}`)}</div>
                      <div className="mb-1.5 flex flex-wrap gap-1">
                        {s.impacts.map((i) => (
                          <span
                            key={i.asset}
                            className={`rounded px-1.5 py-0.5 font-mono ${
                              i.direction === 'bullish' ? 'bg-emerald-500/15 text-emerald-300' : i.direction === 'bearish' ? 'bg-rose-500/15 text-rose-300' : 'bg-white/10 text-neutral-400'
                            }`}
                          >
                            {i.asset} {i.direction === 'bullish' ? '↑' : i.direction === 'bearish' ? '↓' : '–'}
                            <span className="ml-1 opacity-70">{t(`admin.econ.strength.${i.strength}`)}</span>
                          </span>
                        ))}
                      </div>
                      <p className="text-neutral-400">{zh ? s.reason_zh : s.reason_en}</p>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {g.preview?.status === 'failed' && g.preview.error && <p className="text-xs text-rose-300/80">{g.preview.error}</p>}

          <div className="flex items-center gap-3 text-[11px] text-neutral-600">
            {g.preview?.model && (
              <span>
                {g.preview.model} · {g.preview.tokensIn ?? 0}/{g.preview.tokensOut ?? 0} tokens
                {g.preview.generatedAt && ` · ${new Date(g.preview.generatedAt).toLocaleString()}`}
              </span>
            )}
            {g.indicative && <span>{t('admin.econ.indicative')}</span>}
            {g.at && g.status !== 'cancelled' && (
              <button type="button" className={`ml-auto ${segBtn(false, !canRegen || busy)}`} disabled={!canRegen || busy} onClick={onRegen}>
                {busy ? t('admin.econ.writing') : g.preview ? t('admin.econ.regenerate') : t('admin.econ.generate')}
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  )
}
