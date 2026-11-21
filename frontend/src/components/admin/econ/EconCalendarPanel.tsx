// 管理控制台「财经日历」（2026-11-20，第一期只给管理员看）：仿 Forex Factory——
// 右侧小月历，点某一周看那一周全部数据；表格一行一个指标（日期 / 时间 / 货币 / 影响 / 事件 /
// 公布 / 预期 / 前值）；已经过去的行变暗，下一条将公布的标箭头；点一行展开 AI 写的三种情景预案。
// Admin "Economic calendar" (admin-only for now), Forex Factory style: a mini month calendar on the
// side (click a week to see that week), one row per figure, past rows dimmed, an arrow on the next
// release, and the three-scenario preview on click.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { adminApi, econApi } from '../../../api/client'
import type { EconGroup, EconStatus } from '../../../api/econTypes'
import { localizeApiError } from '../../../api/utils'
import Switch from '../../Switch'
import { segBtn } from '../../../utils/segBtn'
import { useToast } from '../../../utils/useToast'
import EconWeekView from './EconWeekView'
import { addDays, weekStartOf, ymd } from './econShared'

const LEVELS_KEY = 'econ.impactLevels'

// mode='user'：用户端的只读日历（/calendar）。同一张表和小月历，但不显示数据源状态、设置、
// 同步和生成按钮，数据走用户端接口。设置只在管理台。
// mode='user' is the read-only calendar at /calendar: same table and mini calendar, without the
// source status, settings, sync and generate controls, reading the user endpoint.
export default function EconCalendarPanel({ mode = 'admin' }: { mode?: 'admin' | 'user' }) {
  const isAdmin = mode === 'admin'
  const { t } = useTranslation()
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
      if (!isAdmin) {
        setItems((await econApi.calendar(fetchStart, 9, 1)).items)
        return
      }
      const [st, cal] = await Promise.all([adminApi.econStatus(), adminApi.econCalendar(fetchStart, 9, 1)])
      setStatus(st)
      setCountries(st.settings.countries.join(', '))
      setItems(cal.items)
    } catch (e) {
      fail(e)
    } finally {
      setLoading(false)
      setReady(true)
    }
  }, [fetchStart, fail, isAdmin])

  // 周末打开时，这一周已经没有还没公布的橙 / 红数据了：自动翻到下一周。只在刚进来、地址里没指定
  // 日期时做一次，之后用户自己翻周不再干预。
  // Opened at the weekend with no orange / red release left this week: jump to next week. Once only,
  // on arrival without a ?day=; the user's own week changes are left alone afterwards.
  const [ready, setReady] = useState(false)
  const autoWeek = useRef(!params.get('day'))
  useEffect(() => {
    if (!ready || !autoWeek.current) return
    autoWeek.current = false
    if (ymd(week) !== ymd(weekStartOf(new Date()))) return
    const from = Date.now()
    const to = addDays(week, 7).getTime()
    const ahead = items.some((g) => {
      const at = g.at ? new Date(g.at).getTime() : 0
      return g.status !== 'cancelled' && g.importance >= 2 && at > from && at < to
    })
    if (!ahead) setWeek(addDays(week, 7))
  }, [ready, items, week])

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

      {isAdmin && (
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
                <label className="flex items-center gap-2">
                  <Switch
                    checked={cfg.public}
                    busy={busy === 'public'}
                    onChange={(v) => save({ public: v }, 'public')}
                  />
                  {t('admin.econ.public')}
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
      )}

      <EconWeekView
        week={week}
        onWeek={setWeek}
        items={items}
        loading={loading}
        now={now}
        levels={levels}
        onToggleLevel={toggleLevel}
        focusKey={focusKey}
        initialDay={params.get('day')}
        admin={isAdmin}
        emptyText={t(isAdmin ? 'admin.econ.emptyWeek' : 'econ.emptyWeek')}
        adminActions={
          isAdmin ? (
            <>
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
            </>
          ) : undefined
        }
      />
    </div>
  )
}
