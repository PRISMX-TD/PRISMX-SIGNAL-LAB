// 群发邮件「指定用户」的选人列表：搜索 / 筛选 / 排序 + 带详情的用户表，勾选即加入收件人。
// 停用的、（推广邮件时）已退订的人也列出来，但标明状态、不给勾——列表里「搜得到却
// 选不了」比「搜不到」好解释。已选的人按 id → 邮箱存在上层，翻页、换条件都不丢。
// Recipient picker for "specific users": search / filter / sort plus a detailed
// user table; ticking adds a recipient. Disabled users (and unsubscribed ones for
// marketing) are listed with their status but cannot be ticked — "found but not
// selectable" explains itself, "not found" does not. The selection (id → email)
// lives in the parent, so paging or changing filters never drops it.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi, isAbortError } from '../../api/client'
import { fmtDay, localizeApiError } from '../../api/utils'
import Pager from '../Pager'
import Select from '../Select'
import { SkeletonLine } from '../Skeleton'
import type { EmailAudiencePlan, EmailKind, EmailPickerQuery, EmailPickerUser } from '../../api/types'

// 与后端 EMAIL_LIST_MAX 一致 / matches the backend EMAIL_LIST_MAX
export const PICK_MAX = 2000
const PAGE_SIZE = 20
const PLAN_FILTERS: EmailAudiencePlan[] = ['all', 'FREE', 'PRO', 'TRIAL', 'PAID']
const ACTIVITY_OPTIONS = ['', 'active7', 'active30', 'active90', 'inactive30', 'inactive90'] as const
type Activity = (typeof ACTIVITY_OPTIONS)[number]
// 选中的人：id → 邮箱（从用户管理带过来的只有 id，邮箱为空串）
// Selection: id → email (users carried over from the Users tab have an empty email)
export type Picked = Record<string, string>

function activityFields(a: Activity): Pick<EmailPickerQuery, 'activeWithinDays' | 'inactiveForDays'> {
  if (a.startsWith('active')) return { activeWithinDays: Number(a.slice(6)), inactiveForDays: null }
  if (a.startsWith('inactive')) return { activeWithinDays: null, inactiveForDays: Number(a.slice(8)) }
  return { activeWithinDays: null, inactiveForDays: null }
}

export default function EmailRecipientPicker({
  kind,
  picked,
  onChange,
  onError,
}: {
  kind: EmailKind
  picked: Picked
  // 函数式更新：连点几行时每一下都基于最新的已选，而不是渲染时那份旧的
  // functional updates, so rapid clicks each build on the latest selection
  onChange: (update: (prev: Picked) => Picked) => void
  onError: (text: string) => void
}) {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [plan, setPlan] = useState<EmailAudiencePlan>('all')
  const [activity, setActivity] = useState<Activity>('')
  const [sort, setSort] = useState<'created' | 'active'>('created')
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<EmailPickerUser[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selectingAll, setSelectingAll] = useState(false)

  // 搜索框防抖，换条件回到第一页 / debounce the search box; any filter change resets to page 1
  useEffect(() => {
    const id = window.setTimeout(() => setQ(search), 300)
    return () => window.clearTimeout(id)
  }, [search])
  useEffect(() => setPage(0), [q, plan, activity, sort])

  const query: EmailPickerQuery = { q, plan, sort, ...activityFields(activity) }

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    adminApi
      .emailPickerUsers(query, PAGE_SIZE, page * PAGE_SIZE, ctrl.signal)
      .then((res) => {
        setRows(res.users)
        setTotal(res.total)
      })
      .catch((err) => {
        if (!isAbortError(err)) onError(err instanceof Error ? localizeApiError(err.message) : t('admin.loadError'))
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false)
      })
    return () => ctrl.abort()
  }, [q, plan, activity, sort, page])

  const selectable = (u: EmailPickerUser) => !u.disabled && !(kind === 'marketing' && u.optedOut)
  const pickedCount = Object.keys(picked).length

  const toggle = (u: EmailPickerUser) => {
    if (picked[u.id] === undefined && pickedCount >= PICK_MAX) return onError(t('admin.email.pickMax', { n: PICK_MAX }))
    onChange((prev) => {
      const next = { ...prev }
      if (next[u.id] !== undefined) delete next[u.id]
      else if (Object.keys(next).length < PICK_MAX) next[u.id] = u.email
      return next
    })
  }

  const pageSelectable = rows.filter(selectable)
  const pageAllPicked = pageSelectable.length > 0 && pageSelectable.every((u) => picked[u.id] !== undefined)
  const togglePage = () => {
    const unpickAll = pageAllPicked
    onChange((prev) => {
      const next = { ...prev }
      if (unpickAll) pageSelectable.forEach((u) => delete next[u.id])
      else {
        for (const u of pageSelectable) {
          if (Object.keys(next).length >= PICK_MAX) break
          next[u.id] = u.email
        }
      }
      return next
    })
  }

  const selectAllResults = async () => {
    if (selectingAll) return
    setSelectingAll(true)
    try {
      const res = await adminApi.emailPickerSelectAll(kind, query)
      onChange((prev) => {
        const next = { ...prev }
        for (const u of res.users) {
          if (Object.keys(next).length >= PICK_MAX) break
          next[u.id] = u.email
        }
        return next
      })
      if (res.truncated || pickedCount + res.users.length > PICK_MAX) onError(t('admin.email.pickMax', { n: PICK_MAX }))
    } catch (err) {
      onError(err instanceof Error ? localizeApiError(err.message) : t('admin.loadError'))
    } finally {
      setSelectingAll(false)
    }
  }

  const unpick = (id: string) =>
    onChange((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })

  const planText = (u: EmailPickerUser) => {
    if (u.plan !== 'PRO') return 'FREE'
    return u.planIsTrial ? t('admin.email.planTrialShort') : 'PRO'
  }

  const statusBadge = (u: EmailPickerUser) => {
    if (u.disabled) return <span className="rounded bg-down/15 px-1.5 py-0.5 text-down">{t('admin.statusDisabled')}</span>
    if (u.optedOut)
      return (
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300" title={t('admin.email.optedOutHint')}>
          {t('admin.email.optedOut')}
        </span>
      )
    return <span className="text-neutral-500">{t('admin.statusActive')}</span>
  }

  const pickedEntries = Object.entries(picked)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-3">
      {/* 搜索与筛选 / search & filters */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="input w-full py-1.5 text-sm sm:w-64"
          placeholder={t('admin.email.pickerSearch')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          maxLength={128}
        />
        <Select
          value={plan}
          onChange={(v) => setPlan(v as EmailAudiencePlan)}
          ariaLabel={t('admin.colPlan')}
          options={PLAN_FILTERS.map((p) => ({ value: p, label: t(`admin.email.plan.${p}`) }))}
        />
        <Select
          value={activity}
          onChange={(v) => setActivity(v as Activity)}
          ariaLabel={t('admin.email.activity')}
          options={ACTIVITY_OPTIONS.map((a) => ({ value: a, label: t(`admin.email.activityOpt.${a || 'any'}`) }))}
        />
        <Select
          value={sort}
          onChange={(v) => setSort(v as 'created' | 'active')}
          ariaLabel={t('admin.email.sort')}
          options={[
            { value: 'created', label: t('admin.email.sortCreated') },
            { value: 'active', label: t('admin.email.sortActive') },
          ]}
        />
      </div>

      {/* 已选 / selection summary */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white/5 px-3 py-2 text-sm">
        <span className="font-medium text-neutral-100">{t('admin.email.pickedCount', { n: pickedCount })}</span>
        {pickedEntries.slice(0, 8).map(([id, email]) => (
          <span key={id} className="inline-flex items-center gap-1 rounded-full bg-prism-600/20 px-2 py-0.5 text-xs text-prism-200">
            {email || t('admin.email.pickedFromUsers')}
            <button type="button" className="text-prism-300 hover:text-white" aria-label={t('admin.bulkClear')} onClick={() => unpick(id)}>
              ×
            </button>
          </span>
        ))}
        {pickedEntries.length > 8 && (
          <span className="text-xs text-neutral-500">{t('admin.email.pickedMore', { n: pickedEntries.length - 8 })}</span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          className="btn-ghost px-3 py-1 text-xs disabled:opacity-40"
          disabled={selectingAll || total === 0}
          onClick={selectAllResults}
        >
          {selectingAll ? t('common.loading') : t('admin.email.pickAllResults', { n: total })}
        </button>
        {pickedCount > 0 && (
          <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={() => onChange(() => ({}))}>
            {t('admin.email.pickClear')}
          </button>
        )}
      </div>

      {/* 用户表 / user table */}
      <div className="overflow-x-auto rounded-lg border border-white/5">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-white/5 text-xs text-neutral-500">
            <tr>
              <th className="w-10 px-3 py-2">
                <input
                  type="checkbox"
                  aria-label={t('admin.email.pickPage')}
                  title={t('admin.email.pickPage')}
                  checked={pageAllPicked}
                  disabled={pageSelectable.length === 0}
                  onChange={togglePage}
                  className="h-3.5 w-3.5 accent-prism-500"
                />
              </th>
              <th className="px-3 py-2 font-normal">{t('admin.email.colUser')}</th>
              <th className="px-3 py-2 font-normal">{t('admin.colPlan')}</th>
              <th className="px-3 py-2 font-normal">{t('admin.colLastActive')}</th>
              <th className="px-3 py-2 font-normal">{t('admin.email.colRegistered')}</th>
              <th className="px-3 py-2 font-normal">{t('admin.colMt5Count')}</th>
              <th className="px-3 py-2 font-normal">{t('admin.colStatus')}</th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-4">
                  <SkeletonLine width="50%" height={14} />
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-neutral-500">
                  {t('admin.noUsers')}
                </td>
              </tr>
            ) : (
              rows.map((u) => {
                const can = selectable(u)
                const on = picked[u.id] !== undefined
                return (
                  <tr
                    key={u.id}
                    className={`border-b border-white/5 last:border-0 ${can ? 'cursor-pointer hover:bg-white/[0.03]' : 'opacity-50'} ${
                      on ? 'bg-prism-600/10' : ''
                    }`}
                    onClick={() => can && toggle(u)}
                  >
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={u.email}
                        checked={on}
                        disabled={!can}
                        onChange={() => toggle(u)}
                        className="h-3.5 w-3.5 accent-prism-500"
                      />
                    </td>
                    <td className="max-w-[280px] px-3 py-2">
                      <div className="truncate text-neutral-200" title={u.email}>{u.email}</div>
                      {(u.nickname || u.phone) && (
                        <div className="truncate text-xs text-neutral-500">
                          {[u.nickname, u.phone].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-300">
                      {planText(u)}
                      {u.plan === 'PRO' && u.planExpiresAt && (
                        <div className="text-neutral-500">{t('admin.email.expires', { date: fmtDay(u.planExpiresAt, '') })}</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-400">{fmtDay(u.lastActiveAt, '—')}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs text-neutral-400">{fmtDay(u.createdAt, '—')}</td>
                    <td className="px-3 py-2 text-xs text-neutral-400">{u.mt5AccountCount}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">{statusBadge(u)}</td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      {total > PAGE_SIZE && (
        <Pager
          page={page}
          totalPages={totalPages}
          total={total}
          loading={loading}
          onPrev={() => setPage((p) => Math.max(0, p - 1))}
          onNext={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          className="mt-0"
        />
      )}
    </div>
  )
}
