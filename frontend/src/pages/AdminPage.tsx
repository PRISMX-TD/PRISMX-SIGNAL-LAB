// 管理后台页：运营指标 + 用户列表（可调整角色/订阅等级，支持批量修改）
// Admin page: operating metrics + user list (role/plan adjustable, bulk edit supported)
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../api/client'
import { fmtTime } from '../api/utils'
import Select from '../components/Select'
import type { AdminBrokerSettings, AdminMetrics, AdminUser, UserPlan, UserRole } from '../api/types'

const PLAN_OPTIONS: UserPlan[] = ['FREE', 'PLUS', 'PRO']
const ROLE_OPTIONS: UserRole[] = ['user', 'admin']

interface Draft {
  role: UserRole
  plan: UserPlan
  planExpiresAt: string // yyyy-mm-dd，空字符串表示永不到期 / empty string = never expires
  planNote: string
}

function toDraft(u: AdminUser): Draft {
  return {
    role: u.role,
    plan: u.plan,
    planExpiresAt: u.planExpiresAt ? u.planExpiresAt.slice(0, 10) : '',
    planNote: u.planNote ?? '',
  }
}

function isDirty(u: AdminUser, d: Draft | undefined): boolean {
  if (!d) return false
  const origExpiry = u.planExpiresAt ? u.planExpiresAt.slice(0, 10) : ''
  return d.role !== u.role || d.plan !== u.plan || d.planExpiresAt !== origExpiry || d.planNote !== (u.planNote ?? '')
}

const planChipClass: Record<UserPlan, string> = {
  FREE: 'bg-white/5 text-slate-400',
  PLUS: 'bg-amber-500/15 text-amber-400',
  PRO: 'bg-prism-600/20 text-prism-300',
}

export default function AdminPage() {
  const { t } = useTranslation()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [metrics, setMetrics] = useState<AdminMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [planFilter, setPlanFilter] = useState('')
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  // 合作券商锁设置（patterns 在输入框里以逗号分隔编辑）
  // partner-broker lock settings (patterns edited as a comma-separated string)
  const [brokerSettings, setBrokerSettings] = useState<AdminBrokerSettings | null>(null)
  const [brokerPatternsText, setBrokerPatternsText] = useState('')
  const [savingBroker, setSavingBroker] = useState(false)

  // 批量选择与批量修改：勾选后统一改角色/等级，空字符串代表"不修改该字段"
  // bulk selection & bulk edit: '' means "leave this field unchanged"
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkRole, setBulkRole] = useState('')
  const [bulkPlan, setBulkPlan] = useState('')
  // 到期时间需要单独一个"是否要改"开关：日期本身留空是合法值（永不到期），
  // 不能用空字符串同时表示"不改"和"清除到期时间" / expiry needs its own
  // on/off switch — an empty date is a valid value (never expires), so an
  // empty string can't double as both "leave unchanged" and "clear it"
  const [bulkSetExpiry, setBulkSetExpiry] = useState(false)
  const [bulkExpiry, setBulkExpiry] = useState('')
  const [bulkSaving, setBulkSaving] = useState(false)
  const headerCheckboxRef = useRef<HTMLInputElement>(null)

  const showToast = (kind: 'ok' | 'err', text: string) => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    setToast({ kind, text })
    toastTimer.current = window.setTimeout(() => setToast(null), 4000)
  }

  const load = async (opts: { q?: string; plan?: string } = {}) => {
    setLoading(true)
    try {
      const [usersRes, metricsRes, settingsRes] = await Promise.all([
        adminApi.listUsers({ q: (opts.q ?? query) || undefined, plan: (opts.plan ?? planFilter) || undefined, limit: 100 }),
        adminApi.metrics(),
        adminApi.getSettings(),
      ])
      setUsers(usersRes.users)
      setTotal(usersRes.total)
      setMetrics(metricsRes)
      setDrafts(Object.fromEntries(usersRes.users.map((u) => [u.id, toDraft(u)])))
      setBrokerSettings(settingsRes)
      setBrokerPatternsText(settingsRes.brokerPatterns.join(', '))
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : t('admin.loadError'))
    } finally {
      setLoading(false)
    }
  }

  const saveBrokerSettings = async () => {
    if (!brokerSettings) return
    setSavingBroker(true)
    try {
      const updated = await adminApi.updateSettings({
        ...brokerSettings,
        brokerPatterns: brokerPatternsText.split(',').map((p) => p.trim()).filter(Boolean),
      })
      setBrokerSettings(updated)
      setBrokerPatternsText(updated.brokerPatterns.join(', '))
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : t('admin.saveError'))
    } finally {
      setSavingBroker(false)
    }
  }

  useEffect(() => {
    load()
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleSearch = (e: FormEvent) => {
    e.preventDefault()
    setSelectedIds(new Set())
    load()
  }

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = users.length > 0 && users.every((u) => selectedIds.has(u.id))
  const someSelected = users.some((u) => selectedIds.has(u.id))

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someSelected && !allSelected
    }
  }, [someSelected, allSelected])

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (allSelected) return new Set()
      const next = new Set(prev)
      users.forEach((u) => next.add(u.id))
      return next
    })
  }

  const applyBulk = async () => {
    if (!bulkRole && !bulkPlan && !bulkSetExpiry) return
    setBulkSaving(true)
    try {
      const payload: Partial<{ role: UserRole; plan: UserPlan; planExpiresAt: string | null }> = {}
      if (bulkRole) payload.role = bulkRole as UserRole
      if (bulkPlan) payload.plan = bulkPlan as UserPlan
      if (bulkSetExpiry) payload.planExpiresAt = bulkExpiry ? new Date(`${bulkExpiry}T00:00:00Z`).toISOString() : null
      const res = await adminApi.bulkUpdateUsers(Array.from(selectedIds), payload)
      showToast('ok', t('admin.bulkSaved', { n: res.updated }))
      setSelectedIds(new Set())
      setBulkRole('')
      setBulkPlan('')
      setBulkSetExpiry(false)
      setBulkExpiry('')
      load()
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : t('admin.saveError'))
    } finally {
      setBulkSaving(false)
    }
  }

  const updateDraft = (id: string, patch: Partial<Draft>) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }

  const resetDraft = (u: AdminUser) => {
    setDrafts((prev) => ({ ...prev, [u.id]: toDraft(u) }))
  }

  const save = async (u: AdminUser) => {
    const d = drafts[u.id]
    if (!d) return
    setSavingId(u.id)
    try {
      const updated = await adminApi.updateUser(u.id, {
        role: d.role,
        plan: d.plan,
        planExpiresAt: d.planExpiresAt ? new Date(`${d.planExpiresAt}T00:00:00Z`).toISOString() : null,
        planNote: d.planNote.trim() || null,
      })
      setUsers((prev) => prev.map((x) => (x.id === u.id ? updated : x)))
      setDrafts((prev) => ({ ...prev, [u.id]: toDraft(updated) }))
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : t('admin.saveError'))
    } finally {
      setSavingId(null)
    }
  }

  const planCounts = metrics?.planCounts ?? {}

  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-2xl font-bold text-slate-100">
          <span className="neon-text">{t('admin.title')}</span>
        </h2>
        <p className="mt-1 text-sm text-slate-400">{t('admin.subtitle')}</p>
      </div>

      {toast && (
        <div
          className={`mb-4 rounded-lg border px-4 py-2.5 text-sm ${
            toast.kind === 'err' ? 'border-down/40 bg-down/15 text-down' : 'border-up/40 bg-up/15 text-up'
          }`}
        >
          {toast.text}
        </div>
      )}

      {/* 运营指标 / operating metrics */}
      <div className="mb-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="glass px-4 py-4">
          <div className="text-xs text-slate-400">{t('admin.totalUsers')}</div>
          <div className="num mt-1 font-display text-2xl font-bold text-slate-50">{metrics?.totalUsers ?? '-'}</div>
        </div>
        <div className="glass px-4 py-4">
          <div className="text-xs text-slate-400">{t('admin.dau')}</div>
          <div className="num mt-1 font-display text-2xl font-bold text-up">{metrics?.dau ?? '-'}</div>
        </div>
        <div className="glass px-4 py-4">
          <div className="text-xs text-slate-400">{t('admin.wau')}</div>
          <div className="num mt-1 font-display text-2xl font-bold text-prism-300">{metrics?.wau ?? '-'}</div>
        </div>
        <div className="glass px-4 py-4">
          <div className="text-xs text-slate-400">{t('admin.signupsLast7d')}</div>
          <div className="num mt-1 font-display text-2xl font-bold text-slate-50">
            {metrics?.signupsLast7d.reduce((s, d) => s + d.count, 0) ?? '-'}
          </div>
        </div>
      </div>

      {/* 各等级人数 / plan breakdown */}
      <div className="glass mb-5 flex flex-wrap items-center gap-2 p-4">
        <span className="text-xs text-slate-400">{t('admin.planBreakdown')}</span>
        {PLAN_OPTIONS.map((p) => (
          <span key={p} className={`tag ${planChipClass[p]}`}>
            {p} · {planCounts[p] ?? 0}
          </span>
        ))}
      </div>

      {/* 合作券商锁设置 / partner-broker lock settings */}
      {brokerSettings && (
        <div className="glass mb-5 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-lg font-semibold text-slate-100">{t('admin.brokerTitle')}</h3>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={brokerSettings.brokerLockEnabled}
                onChange={(e) => setBrokerSettings({ ...brokerSettings, brokerLockEnabled: e.target.checked })}
                className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
              />
              {t('admin.brokerLockEnabled')}
            </label>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <label className="label">{t('admin.brokerPatterns')}</label>
              <input
                className="input"
                value={brokerPatternsText}
                onChange={(e) => setBrokerPatternsText(e.target.value)}
                placeholder="MakeCapital"
              />
              <p className="mt-1.5 text-xs text-slate-500">{t('admin.brokerPatternsHint')}</p>
            </div>
            <div>
              <label className="label">{t('admin.brokerDisplayName')}</label>
              <input
                className="input"
                value={brokerSettings.brokerDisplayName}
                onChange={(e) => setBrokerSettings({ ...brokerSettings, brokerDisplayName: e.target.value })}
                placeholder="MakeCapital"
              />
            </div>
            <div>
              <label className="label">{t('admin.brokerReferralUrl')}</label>
              <input
                className="input"
                value={brokerSettings.brokerReferralUrl}
                onChange={(e) => setBrokerSettings({ ...brokerSettings, brokerReferralUrl: e.target.value })}
                placeholder="https://…"
              />
            </div>
          </div>
          <button
            className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-40"
            disabled={savingBroker}
            onClick={saveBrokerSettings}
          >
            {savingBroker ? t('common.loading') : t('common.save')}
          </button>
        </div>
      )}

      {/* 搜索与筛选 / search & filter */}
      <form onSubmit={handleSearch} className="glass mb-4 flex flex-wrap items-center gap-3 p-4">
        <input
          className="input flex-1 sm:max-w-xs"
          placeholder={t('admin.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select
          value={planFilter}
          onChange={setPlanFilter}
          options={[{ value: '', label: t('signals.all') }, ...PLAN_OPTIONS.map((p) => ({ value: p, label: p }))]}
        />
        <button type="submit" className="btn-primary px-5 py-2 text-sm">{t('admin.search')}</button>
        <span className="ml-auto text-xs text-slate-500">{t('admin.totalCount', { n: total })}</span>
      </form>

      {/* 批量操作条：勾选至少一位用户后出现 / bulk action bar, shown once ≥1 user is selected */}
      {selectedIds.size > 0 && (
        <div className="glass mb-4 flex flex-wrap items-center gap-3 border-prism-600/40 p-4">
          <span className="text-sm font-medium text-prism-200">{t('admin.bulkSelected', { n: selectedIds.size })}</span>
          <span className="text-xs text-slate-500">{t('admin.colRole')}</span>
          <Select
            value={bulkRole}
            onChange={setBulkRole}
            openUpward
            options={[{ value: '', label: t('admin.bulkNoChange') }, ...ROLE_OPTIONS.map((r) => ({ value: r, label: r }))]}
          />
          <span className="text-xs text-slate-500">{t('admin.colPlan')}</span>
          <Select
            value={bulkPlan}
            onChange={setBulkPlan}
            openUpward
            options={[{ value: '', label: t('admin.bulkNoChange') }, ...PLAN_OPTIONS.map((p) => ({ value: p, label: p }))]}
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-500">
            <input
              type="checkbox"
              checked={bulkSetExpiry}
              onChange={(e) => setBulkSetExpiry(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-white/20 bg-white/5 accent-prism-500"
            />
            {t('admin.colExpiresAt')}
          </label>
          {bulkSetExpiry && (
            <input
              type="date"
              className="input w-auto py-1 text-xs"
              value={bulkExpiry}
              onChange={(e) => setBulkExpiry(e.target.value)}
            />
          )}
          <button
            className="btn-primary px-4 py-1.5 text-xs disabled:opacity-40"
            disabled={(!bulkRole && !bulkPlan && !bulkSetExpiry) || bulkSaving}
            onClick={applyBulk}
          >
            {bulkSaving ? t('common.loading') : t('admin.bulkApply')}
          </button>
          <button className="btn-ghost px-4 py-1.5 text-xs" onClick={() => setSelectedIds(new Set())}>
            {t('admin.bulkClear')}
          </button>
        </div>
      )}

      {/* 用户表 / user table */}
      <div className="glass overflow-x-auto p-0">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
          </div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">{t('admin.noUsers')}</div>
        ) : (
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-slate-500">
                <th className="px-4 py-3">
                  <input
                    ref={headerCheckboxRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                    aria-label={t('admin.bulkSelectAll')}
                  />
                </th>
                <th className="px-4 py-3 font-medium">{t('admin.colEmail')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.colRole')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.colPlan')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.colExpiresAt')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.colNote')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.colMt5Count')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.colLastActive')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const d = drafts[u.id] ?? toDraft(u)
                const dirty = isDirty(u, d)
                return (
                  <tr key={u.id} className={`border-b border-white/5 align-top last:border-0 ${selectedIds.has(u.id) ? 'bg-prism-600/[0.06]' : ''}`}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(u.id)}
                        onChange={() => toggleSelected(u.id)}
                        className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                        aria-label={u.email}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="max-w-[220px] truncate font-mono text-xs text-slate-200">{u.email}</div>
                      <div className="mt-1 text-[11px] text-slate-500">{fmtTime(u.createdAt)}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Select
                        value={d.role}
                        onChange={(v) => updateDraft(u.id, { role: v as UserRole })}
                        options={ROLE_OPTIONS.map((r) => ({ value: r, label: r }))}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Select
                        value={d.plan}
                        onChange={(v) => updateDraft(u.id, { plan: v as UserPlan })}
                        options={PLAN_OPTIONS.map((p) => ({ value: p, label: p }))}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="date"
                        className="input w-auto py-1 text-xs"
                        value={d.planExpiresAt}
                        onChange={(e) => updateDraft(u.id, { planExpiresAt: e.target.value })}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="text"
                        className="input w-40 py-1 text-xs"
                        placeholder={t('admin.notePlaceholder')}
                        value={d.planNote}
                        onChange={(e) => updateDraft(u.id, { planNote: e.target.value })}
                      />
                    </td>
                    <td className="px-4 py-3 text-center font-mono text-xs text-slate-300">{u.mt5AccountCount}</td>
                    <td className="px-4 py-3 text-xs text-slate-400">{fmtTime(u.lastActiveAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-2">
                        <button
                          className="btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
                          disabled={!dirty || savingId === u.id}
                          onClick={() => save(u)}
                        >
                          {savingId === u.id ? t('common.loading') : t('common.save')}
                        </button>
                        {dirty && (
                          <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => resetDraft(u)}>
                            {t('common.reset')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
