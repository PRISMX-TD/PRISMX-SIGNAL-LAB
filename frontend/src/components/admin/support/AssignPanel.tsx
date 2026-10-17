// 跟进分配（设计 §5.2 / §7.2）：上半部分选人（复用群发邮件的选人表：搜索 / 套餐 / 活跃度筛选、
// 跨页保留勾选）+ 分配表单，分配前先预检，把「要求勿扰 / 已有进行中跟进 / 工作人员」（会被跳过）
// 与「退订推广邮件」（默认跳过，可勾选仍分配）说清楚；下半部分是现有跟进的收回 / 改派 / 延期。
// Follow-up assignment (design §5.2 / §7.2). Top: pick users (the email picker, reused: search /
// plan / activity filters, selection survives paging) plus the assign form, with a pre-flight
// that spells out who will be skipped (do-not-contact / active follow-up / staff) and who is
// skipped by default (email opt-outs, includable). Bottom: revoke / reassign / extend.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminSupportApi } from '../../../api/client'
import { fmtDay, fmtTime } from '../../../api/utils'
import {
  FOLLOW_UP_GOALS,
  FOLLOW_UP_PRIORITIES,
  type AssignBlocker,
  type FollowUp,
  type FollowUpGoal,
  type FollowUpPriority,
  type SupportMember,
} from '../../../api/supportTypes'
import ConfirmModal from '../../ConfirmModal'
import Select from '../../Select'
import { SkeletonLine } from '../../Skeleton'
import EmailRecipientPicker, { type Picked } from '../EmailRecipientPicker'
import { FU_PRIORITY_TONE, FU_STATUS_TONE, bjInputToIso, errText } from '../../support/supportUi'

const LIST_PAGE = 50
const STATUS_FILTERS = ['active', 'closed', 'pending', 'contacted', 'interested', 'converted', 'no_interest', 'unreachable', 'revoked', 'expired']

export default function AssignPanel({
  presetUserIds,
  onPresetCleared,
  onToast,
}: {
  presetUserIds: string[]
  onPresetCleared: () => void
  onToast: (kind: 'ok' | 'err', text: string) => void
}) {
  const { t } = useTranslation()
  const [members, setMembers] = useState<SupportMember[]>([])
  const [picked, setPicked] = useState<Picked>(() => Object.fromEntries(presetUserIds.map((id) => [id, ''])))
  const [assigneeId, setAssigneeId] = useState('')
  const [goal, setGoal] = useState<FollowUpGoal>('open_mt5')
  const [priority, setPriority] = useState<FollowUpPriority>('normal')
  const [expires, setExpires] = useState('')
  const [nextContact, setNextContact] = useState('')
  const [note, setNote] = useState('')
  const [includeOptedOut, setIncludeOptedOut] = useState(false)
  const [blockers, setBlockers] = useState<AssignBlocker[] | null>(null)
  const [assigning, setAssigning] = useState(false)
  const [confirm, setConfirm] = useState(false)

  // 现有跟进 / existing follow-ups
  const [fuAssignee, setFuAssignee] = useState('')
  const [fuStatus, setFuStatus] = useState('active')
  const [fuPage, setFuPage] = useState(0)
  const [fuRows, setFuRows] = useState<FollowUp[] | null>(null)
  const [fuTotal, setFuTotal] = useState(0)
  const [dist, setDist] = useState<Record<string, number>>({})
  const [fuSel, setFuSel] = useState<Set<string>>(new Set())
  const [reassignTo, setReassignTo] = useState('')
  const [extendDays, setExtendDays] = useState('7')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [revokeConfirm, setRevokeConfirm] = useState(false)

  useEffect(() => {
    if (presetUserIds.length) onPresetCleared()
    adminSupportApi
      .members()
      .then((r) => setMembers(r.items.filter((m) => !m.disabled)))
      .catch((err) => onToast('err', errText(err, t('admin.loadError'))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const ids = Object.keys(picked)
  const idsKey = ids.join(',')

  // 勾选变了就重新预检（防抖）/ re-run the pre-flight when the selection changes (debounced)
  useEffect(() => {
    if (!ids.length) {
      setBlockers(null)
      return
    }
    const timer = window.setTimeout(() => {
      adminSupportApi
        .checkAssign(ids)
        .then((r) => setBlockers(r.items))
        .catch(() => setBlockers(null))
    }, 400)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey])

  const hard = (b: AssignBlocker) => b.missing || b.staff || b.doNotContact || b.activeFollowUp
  const counts = blockers
    ? {
        dnc: blockers.filter((b) => b.doNotContact).length,
        active: blockers.filter((b) => !b.doNotContact && b.activeFollowUp).length,
        staff: blockers.filter((b) => b.staff || b.missing).length,
        opted: blockers.filter((b) => !hard(b) && b.optedOut).length,
        ok: blockers.filter((b) => !hard(b) && (!b.optedOut || includeOptedOut)).length,
      }
    : null

  const loadFollowUps = useCallback(async () => {
    try {
      const r = await adminSupportApi.followUps({
        assigneeId: fuAssignee || undefined,
        status: fuStatus || undefined,
        limit: LIST_PAGE,
        offset: fuPage * LIST_PAGE,
      })
      setFuRows(r.items)
      setFuTotal(r.total)
      setDist(r.distribution)
      setFuSel(new Set())
    } catch (err) {
      onToast('err', errText(err, t('admin.loadError')))
      setFuRows([])
    }
  }, [fuAssignee, fuStatus, fuPage, onToast, t])
  useEffect(() => { void loadFollowUps() }, [loadFollowUps])
  useEffect(() => setFuPage(0), [fuAssignee, fuStatus])

  const assign = async () => {
    setConfirm(false)
    setAssigning(true)
    try {
      const r = await adminSupportApi.assign({
        userIds: ids,
        assigneeId,
        goal,
        priority,
        expiresAt: expires ? bjInputToIso(`${expires}T23:59`) : null,
        nextContactAt: bjInputToIso(nextContact),
        note: note.trim() || null,
        includeOptedOut,
      })
      onToast('ok', t('admin.support.assign.done', { created: r.created.length, skipped: r.skipped.length }))
      setPicked({})
      setNote('')
      void loadFollowUps()
    } catch (err) {
      onToast('err', errText(err, t('admin.saveError')))
    } finally {
      setAssigning(false)
    }
  }

  const bulk = async (fn: () => Promise<{ updated: number }>) => {
    setBulkBusy(true)
    try {
      const r = await fn()
      onToast('ok', t('admin.support.followUps.updated', { n: r.updated }))
      await loadFollowUps()
    } catch (err) {
      onToast('err', errText(err, t('admin.saveError')))
    } finally {
      setBulkBusy(false)
      setRevokeConfirm(false)
    }
  }

  const memberOptions = members.map((m) => ({ value: m.id, label: `${m.nickname || m.email} · ${t(`admin.support.tier.${m.effectiveTier}`)}` }))
  const selIds = Array.from(fuSel)
  const extendN = Number(extendDays)
  const allOnPage = !!fuRows?.length && fuRows.filter((f) => f.active).every((f) => fuSel.has(f.id))

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-neutral-200">{t('admin.support.assign.pickTitle')}</h3>
        <EmailRecipientPicker kind="notice" picked={picked} onChange={setPicked} onError={(text) => onToast('err', text)} />
      </section>

      <section className="glass space-y-3 p-4">
        <h3 className="text-sm font-semibold text-neutral-200">{t('admin.support.assign.formTitle', { n: ids.length })}</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="block text-xs text-neutral-400">
            <span className="mb-1 block">{t('admin.support.assign.assignee')}</span>
            <Select value={assigneeId} onChange={setAssigneeId} ariaLabel={t('admin.support.assign.assignee')}
              options={[{ value: '', label: t('admin.support.assign.chooseAssignee') }, ...memberOptions]} />
          </label>
          <label className="block text-xs text-neutral-400">
            <span className="mb-1 block">{t('supportDesk.card.goal')}</span>
            <Select value={goal} onChange={(v) => setGoal(v as FollowUpGoal)} ariaLabel={t('supportDesk.card.goal')}
              options={FOLLOW_UP_GOALS.map((g) => ({ value: g, label: t(`supportDesk.goal.${g}`) }))} />
          </label>
          <label className="block text-xs text-neutral-400">
            <span className="mb-1 block">{t('admin.support.assign.priority')}</span>
            <Select value={priority} onChange={(v) => setPriority(v as FollowUpPriority)} ariaLabel={t('admin.support.assign.priority')}
              options={FOLLOW_UP_PRIORITIES.map((p) => ({ value: p, label: t(`supportDesk.priority.${p}`) }))} />
          </label>
          <label className="block text-xs text-neutral-400">
            <span className="mb-1 block">{t('admin.support.assign.expires')}</span>
            <input type="date" className="input w-full" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </label>
          <label className="block text-xs text-neutral-400">
            <span className="mb-1 block">{t('supportDesk.card.nextContact')}</span>
            <input type="datetime-local" className="input w-full" value={nextContact} onChange={(e) => setNextContact(e.target.value)} />
          </label>
        </div>
        <textarea className="input min-h-[64px] w-full" maxLength={2000} placeholder={t('admin.support.assign.notePlaceholder')}
          value={note} onChange={(e) => setNote(e.target.value)} />
        {counts && (
          <div className="flex flex-wrap gap-2 text-xs">
            <span className="tag bg-up/15 text-up">{t('admin.support.assign.willAssign', { n: counts.ok })}</span>
            {counts.dnc > 0 && <span className="tag bg-down/15 text-down">{t('admin.support.assign.skipDnc', { n: counts.dnc })}</span>}
            {counts.active > 0 && <span className="tag bg-amber-400/15 text-amber-300">{t('admin.support.assign.skipActive', { n: counts.active })}</span>}
            {counts.staff > 0 && <span className="tag bg-white/5 text-neutral-400">{t('admin.support.assign.skipStaff', { n: counts.staff })}</span>}
            {counts.opted > 0 && <span className="tag bg-amber-400/15 text-amber-300">{t('admin.support.assign.optedOut', { n: counts.opted })}</span>}
          </div>
        )}
        {counts && counts.opted > 0 && (
          <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-400">
            <input type="checkbox" checked={includeOptedOut} onChange={(e) => setIncludeOptedOut(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-white/20 bg-white/5 accent-prism-500" />
            {t('admin.support.assign.includeOptedOut')}
          </label>
        )}
        <button type="button" className="btn-primary px-5 py-2 text-sm disabled:opacity-40"
          disabled={!ids.length || !assigneeId || assigning || (counts != null && counts.ok === 0)} onClick={() => setConfirm(true)}>
          {assigning ? t('common.loading') : t('admin.support.assign.submit')}
        </button>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto text-sm font-semibold text-neutral-200">{t('admin.support.followUps.title', { n: fuTotal })}</h3>
          <Select value={fuAssignee} onChange={setFuAssignee} className="select-tight" ariaLabel={t('admin.support.assign.assignee')}
            options={[{ value: '', label: t('admin.support.followUps.allStaff') }, ...memberOptions]} />
          <Select value={fuStatus} onChange={setFuStatus} className="select-tight" ariaLabel={t('supportDesk.card.status')}
            options={[{ value: '', label: t('admin.support.followUps.allStatus') }, ...STATUS_FILTERS.map((s) => ({
              value: s,
              label: s === 'active' || s === 'closed' ? t(`admin.support.followUps.${s}`) : t(`supportDesk.status.${s}`),
            }))]} />
        </div>
        {Object.keys(dist).length > 0 && (
          <div className="flex flex-wrap gap-1.5 text-[11px]">
            {Object.entries(dist).map(([k, n]) => (
              <span key={k} className={`tag ${FU_STATUS_TONE[k as keyof typeof FU_STATUS_TONE] ?? 'bg-white/5 text-neutral-400'}`}>
                {t(`supportDesk.status.${k}`)} {n}
              </span>
            ))}
          </div>
        )}
        {selIds.length > 0 && (
          <div className="glass flex flex-wrap items-center gap-2 border-prism-600/40 p-3 text-xs">
            <span className="font-medium text-prism-200">{t('admin.bulkSelected', { n: selIds.length })}</span>
            <Select value={reassignTo} onChange={setReassignTo} className="select-tight" ariaLabel={t('admin.support.followUps.reassign')}
              options={[{ value: '', label: t('admin.support.followUps.reassignTo') }, ...memberOptions]} />
            <button type="button" className="btn-ghost px-3 py-1 disabled:opacity-40" disabled={!reassignTo || bulkBusy}
              onClick={() => void bulk(() => adminSupportApi.reassign(selIds, reassignTo))}>
              {t('admin.support.followUps.reassign')}
            </button>
            <input className="input w-16 py-1 text-xs" inputMode="numeric" value={extendDays} onChange={(e) => setExtendDays(e.target.value)}
              aria-label={t('admin.support.followUps.extendDays')} />
            <button type="button" className="btn-ghost px-3 py-1 disabled:opacity-40"
              disabled={!Number.isInteger(extendN) || extendN < 1 || extendN > 365 || bulkBusy}
              onClick={() => void bulk(() => adminSupportApi.extend(selIds, extendN))}>
              {t('admin.support.followUps.extend')}
            </button>
            <button type="button" className="rounded-lg border border-down/40 bg-down/15 px-3 py-1 text-down disabled:opacity-40" disabled={bulkBusy}
              onClick={() => setRevokeConfirm(true)}>
              {t('admin.support.followUps.revoke')}
            </button>
          </div>
        )}
        {!fuRows ? (
          <div className="glass space-y-3 p-5"><SkeletonLine /><SkeletonLine width="70%" /></div>
        ) : fuRows.length === 0 ? (
          <div className="glass p-8 text-center text-sm text-neutral-500">{t('admin.support.followUps.empty')}</div>
        ) : (
          <div className="glass overflow-x-auto p-0">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-neutral-500">
                  <th className="px-3 py-3">
                    <input type="checkbox" checked={allOnPage} aria-label={t('admin.bulkSelectAll')}
                      className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                      onChange={() => setFuSel(allOnPage ? new Set() : new Set(fuRows.filter((f) => f.active).map((f) => f.id)))} />
                  </th>
                  <th className="px-3 py-3 font-medium">{t('admin.support.followUps.colUser')}</th>
                  <th className="px-3 py-3 font-medium">{t('admin.support.assign.assignee')}</th>
                  <th className="px-3 py-3 font-medium">{t('supportDesk.card.goal')}</th>
                  <th className="px-3 py-3 font-medium">{t('supportDesk.card.status')}</th>
                  <th className="px-3 py-3 font-medium">{t('supportDesk.card.nextContact')}</th>
                  <th className="px-3 py-3 font-medium">{t('admin.support.assign.expires')}</th>
                </tr>
              </thead>
              <tbody>
                {fuRows.map((f) => (
                  <tr key={f.id} className={`border-b border-white/5 last:border-0 ${f.overdue ? 'bg-down/[0.06]' : ''}`}>
                    <td className="px-3 py-2.5">
                      <input type="checkbox" disabled={!f.active} checked={fuSel.has(f.id)} aria-label={f.email ?? f.userId}
                        className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500 disabled:opacity-30"
                        onChange={() => setFuSel((prev) => {
                          const next = new Set(prev)
                          if (next.has(f.id)) next.delete(f.id)
                          else next.add(f.id)
                          return next
                        })} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="text-xs text-neutral-200">{f.nickname || '—'}</div>
                      <div className="font-mono text-[11px] text-neutral-500">{f.email}</div>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-neutral-300">{f.assigneeName || '—'}</td>
                    <td className="px-3 py-2.5 text-xs">
                      {t(`supportDesk.goal.${f.goal}`)}{' '}
                      <span className={`tag ${FU_PRIORITY_TONE[f.priority]}`}>{t(`supportDesk.priority.${f.priority}`)}</span>
                    </td>
                    <td className="px-3 py-2.5"><span className={`tag ${FU_STATUS_TONE[f.status]}`}>{t(`supportDesk.status.${f.status}`)}</span></td>
                    <td className={`px-3 py-2.5 text-xs ${f.overdue ? 'text-down' : 'text-neutral-400'}`}>{f.nextContactAt ? fmtTime(f.nextContactAt) : '—'}</td>
                    <td className="px-3 py-2.5 text-xs text-neutral-400">{fmtDay(f.expiresAt, '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {fuTotal > LIST_PAGE && (
          <div className="flex items-center justify-center gap-3 text-xs">
            <button type="button" className="btn-ghost px-3 py-1.5 disabled:opacity-40" disabled={fuPage === 0} onClick={() => setFuPage(fuPage - 1)}>{t('common.prevPage')}</button>
            <span className="num text-neutral-500">{fuPage + 1} / {Math.ceil(fuTotal / LIST_PAGE)}</span>
            <button type="button" className="btn-ghost px-3 py-1.5 disabled:opacity-40" disabled={(fuPage + 1) * LIST_PAGE >= fuTotal} onClick={() => setFuPage(fuPage + 1)}>{t('common.nextPage')}</button>
          </div>
        )}
      </section>

      {confirm && (
        <ConfirmModal
          center
          busy={assigning}
          title={t('admin.support.assign.confirmTitle')}
          message={t('admin.support.assign.confirmBody', {
            n: counts?.ok ?? ids.length,
            name: members.find((m) => m.id === assigneeId)?.nickname || members.find((m) => m.id === assigneeId)?.email || '',
            goal: t(`supportDesk.goal.${goal}`),
          })}
          onConfirm={() => void assign()}
          onCancel={() => setConfirm(false)}
        />
      )}
      {revokeConfirm && (
        <ConfirmModal
          center
          danger
          busy={bulkBusy}
          title={t('admin.support.followUps.revoke')}
          message={t('admin.support.followUps.revokeBody', { n: selIds.length })}
          onConfirm={() => void bulk(() => adminSupportApi.revoke(selIds))}
          onCancel={() => setRevokeConfirm(false)}
        />
      )}
    </div>
  )
}
