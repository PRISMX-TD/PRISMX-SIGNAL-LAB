// 跟进进度里点开一条跟进：客户、分配信息、管理员写给客服的说明，以及一条时间线——客服写的跟进
// 记录（带头像的卡片）与跟进上发生过的事（分配、改标签、转派、延期、收回、到期、站内信，小点一行）
// 按时间倒序排在一起，管理员一眼看出这位客户被怎么跟的。进行中的跟进底下还能直接转派 / 延期 / 收回。
// One follow-up opened from the progress view: the customer, the assignment, the admin's note to the
// agent, and one timeline — the agent's notes (cards with an avatar) interleaved newest-first with
// what happened to the follow-up (assigned, relabelled, reassigned, extended, revoked, expired,
// in-app messages; one dotted line each), so an admin sees at a glance how this customer was
// handled. An active follow-up can be reassigned / extended / revoked right from here.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { adminSupportApi } from '../../../api/client'
import type { AdminFollowUpRecord, FollowUpEvent, FollowUpNote, SupportMember } from '../../../api/supportTypes'
import { fmtDayShort, parseTime } from '../../../api/utils'
import AdminSheet from '../AdminSheet'
import ConfirmModal from '../../ConfirmModal'
import Select from '../../Select'
import { SkeletonLine } from '../../Skeleton'
import { Avatar, FU_PRIORITY_TONE, FU_STATUS_TONE, Tag, errText, fmtClock } from '../../support/supportUi'

type Item = { kind: 'note'; at: number; note: FollowUpNote } | { kind: 'event'; at: number; ev: FollowUpEvent }

const ms = (iso: string | null | undefined) => parseTime(iso)?.getTime() ?? 0
// 北京时间「日/月 时:分」，窄格子里放得下 / Beijing "dd/mm hh:mm" — fits the narrow fact cells
const fmtStamp = (iso: string | null | undefined) => (iso ? `${fmtDayShort(iso)} ${fmtClock(iso)}`.trim() || '—' : '—')

// 事件小点的颜色：分配 / 转派 = 品牌紫，延期 = 琥珀，收回 / 到期 / 勿扰 = 红，其余灰。
// Event dot colour: assign / reassign violet, extend amber, revoke / expired / do-not-contact red, else grey.
function dotTone(action: string): string {
  if (action === 'assign' || action === 'reassign') return 'is-brand'
  if (action === 'extend') return 'is-warn'
  if (action === 'revoke' || action === 'expired' || action === 'do_not_contact') return 'is-down'
  return ''
}

export default function FollowUpRecordSheet({
  id,
  members,
  onClose,
  onChanged,
  onToast,
}: {
  id: string
  members: SupportMember[]
  onClose: () => void
  // 转派 / 延期 / 收回之后，让列表与客服卡跟着刷新 / refresh the list and agent cards after a change
  onChanged: () => void
  onToast: (kind: 'ok' | 'err', text: string) => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [rec, setRec] = useState<AdminFollowUpRecord | null>(null)
  const [failed, setFailed] = useState(false)
  const [reassignTo, setReassignTo] = useState('')
  const [extendDays, setExtendDays] = useState('7')
  const [busy, setBusy] = useState(false)
  const [revokeConfirm, setRevokeConfirm] = useState(false)

  const load = useCallback(async () => {
    try {
      setRec(await adminSupportApi.followUpRecord(id))
      setFailed(false)
    } catch (err) {
      setFailed(true)
      onToast('err', errText(err, t('admin.loadError')))
    }
  }, [id, onToast, t])
  useEffect(() => { void load() }, [load])

  const act = async (fn: () => Promise<{ updated: number }>) => {
    setBusy(true)
    try {
      const r = await fn()
      onToast('ok', t('admin.support.followUps.updated', { n: r.updated }))
      setReassignTo('')
      onChanged()
      await load()
    } catch (err) {
      onToast('err', errText(err, t('admin.saveError')))
    } finally {
      setBusy(false)
      setRevokeConfirm(false)
    }
  }

  const fu = rec?.followUp
  const user = rec?.user
  const title = user?.nickname || user?.email || fu?.nickname || fu?.email || t('admin.support.progress.recordTitle')

  const nameOf = (uid: unknown) => (typeof uid === 'string' && (rec?.names[uid] || members.find((m) => m.id === uid)?.nickname)) || t('admin.support.progress.someone')
  const actorOf = (ev: FollowUpEvent) =>
    ev.actorType === 'system' ? t('admin.support.progress.system') : ev.actorName || nameOf(ev.actorId)

  const evText = (ev: FollowUpEvent): string => {
    const actor = actorOf(ev)
    const d = ev.data
    switch (ev.action) {
      case 'assign':
        return t('admin.support.progress.ev.assign', { actor, to: nameOf(d.to) })
      case 'update':
        if (typeof d.status === 'string') {
          const from = typeof d.from === 'string' ? t('admin.support.progress.ev.updateFrom', { from: t(`supportDesk.status.${d.from}`) }) : ''
          return t('admin.support.progress.ev.update', { actor, status: t(`supportDesk.status.${d.status}`) }) + from
        }
        return t('admin.support.progress.ev.next', { actor })
      case 'reassign':
        return t('admin.support.progress.ev.reassign', { actor, from: nameOf(d.from), to: nameOf(d.to) })
      case 'extend':
        return t('admin.support.progress.ev.extend', { actor, to: typeof d.to === 'string' ? fmtStamp(d.to) : '—' })
      case 'revoke':
        return d.reason === 'staff_removed'
          ? t('admin.support.progress.ev.revokeStaffRemoved', { from: nameOf(d.from) })
          : t('admin.support.progress.ev.revoke', { actor })
      case 'expired':
        return t('admin.support.progress.ev.expired')
      case 'message':
        return t('admin.support.progress.ev.message', { actor })
      case 'do_not_contact':
        return t('admin.support.progress.ev.do_not_contact', { actor })
      default:
        return t('admin.support.progress.ev.other', { actor, action: ev.action })
    }
  }

  const items: Item[] = rec
    ? [
        ...rec.notes.map((note): Item => ({ kind: 'note', at: ms(note.createdAt), note })),
        ...rec.events.map((ev): Item => ({ kind: 'event', at: ms(ev.at), ev })),
      ].sort((a, b) => b.at - a.at)
    : []

  const others = members.filter((m) => m.id !== fu?.assigneeId)
  const extendN = Number(extendDays)

  return (
    <AdminSheet
      title={title}
      badge={fu ? <Tag tone={FU_STATUS_TONE[fu.status]}>{t(`supportDesk.status.${fu.status}`)}</Tag> : undefined}
      onClose={onClose}
      widthClass="sm:w-[620px]"
    >
      {!rec ? (
        failed ? (
          <div className="py-10 text-center">
            <p className="text-sm text-neutral-400">{t('admin.loadError')}</p>
            <button type="button" className="adm-btn mt-4" onClick={() => void load()}>{t('supportDesk.retry')}</button>
          </div>
        ) : (
          <div className="mt-5 space-y-3" aria-busy="true">
            <SkeletonLine width="45%" height={12} />
            <SkeletonLine height={120} />
            <SkeletonLine height={64} />
            <SkeletonLine height={64} />
          </div>
        )
      ) : (
        <div className="mt-2 space-y-6">
          {/* 客户 / the customer */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="min-w-0 truncate font-mono text-xs text-neutral-400">{user?.email || fu?.email || '—'}</span>
            {user?.plan && <span className={`adm-pill ${user.plan === 'PRO' ? 'is-brand' : ''}`}>{user.plan}</span>}
            {user?.doNotContact && <span className="adm-pill is-down">{t('admin.support.progress.dnc')}</span>}
            {(user?.email || fu?.email) && (
              <button
                type="button"
                className="adm-link-btn ml-auto"
                onClick={() => {
                  onClose()
                  navigate(`/admin/users?q=${encodeURIComponent(user?.email || fu?.email || '')}`)
                }}
              >
                {t('admin.support.progress.openUser')}
              </button>
            )}
          </div>

          {/* 分配信息 / the assignment */}
          {fu && (
            <dl className="adm-facts">
              <div>
                <dt>{t('admin.support.progress.fact.agent')}</dt>
                <dd>{fu.assigneeName || nameOf(fu.assigneeId)}</dd>
              </div>
              <div>
                <dt>{t('admin.support.progress.fact.goal')}</dt>
                <dd>{t(`supportDesk.goal.${fu.goal}`)}</dd>
              </div>
              <div>
                <dt>{t('admin.support.progress.fact.priority')}</dt>
                <dd>
                  <span className={`tag ${FU_PRIORITY_TONE[fu.priority]}`}>{t(`supportDesk.priority.${fu.priority}`)}</span>
                </dd>
              </div>
              <div>
                <dt>{t('admin.support.progress.fact.assignedAt')}</dt>
                <dd className="num">{fmtStamp(fu.createdAt)}</dd>
              </div>
              <div>
                <dt>{t('admin.support.progress.fact.firstContact')}</dt>
                <dd className="num">{fu.firstContactAt ? fmtStamp(fu.firstContactAt) : t('admin.support.progress.fact.notContacted')}</dd>
              </div>
              <div>
                <dt>{fu.active ? t('admin.support.progress.fact.expires') : t('admin.support.progress.fact.closedAt')}</dt>
                <dd className="num">
                  {fu.active
                    ? fu.expiresAt ? fmtStamp(fu.expiresAt) : t('admin.support.progress.fact.noDeadline')
                    : fmtStamp(fu.closedAt)}
                </dd>
              </div>
            </dl>
          )}

          {fu?.note && (
            <figure className="border-l-2 border-[var(--purple-hi)] pl-4">
              <figcaption className="text-[11px] text-neutral-500">
                {t('admin.support.progress.assignNote')}
                {fu.assignedByName ? ` · ${fu.assignedByName}` : ''}
              </figcaption>
              <blockquote className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-neutral-200">{fu.note}</blockquote>
            </figure>
          )}

          {/* 跟进动态 / activity */}
          <section>
            <h4 className="mb-3 text-[13px] font-semibold text-neutral-100">
              {t('admin.support.progress.timeline')}
              {rec.notes.length > 0 && <span className="num ml-2 text-xs font-normal text-neutral-500">{rec.notes.length}</span>}
            </h4>
            {items.length === 0 ? (
              <p className="rounded-2xl bg-[var(--surface-2)] px-4 py-6 text-center text-xs text-neutral-500">{t('admin.support.progress.timelineEmpty')}</p>
            ) : (
              <ol className="adm-tl">
                {items.map((it) =>
                  it.kind === 'note' ? (
                    <li key={`n-${it.note.id}`}>
                      <Avatar name={it.note.authorName} size={28} tone="staff" />
                      <div className="adm-tl-note">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-neutral-500">
                          <span className="font-medium text-neutral-200">{it.note.authorName || t('admin.support.progress.someone')}</span>
                          <span>{t(`supportDesk.channel.${it.note.channel}`)}</span>
                          {it.note.outcome && <span className="adm-pill">{it.note.outcome}</span>}
                          <span className="num ml-auto">{fmtStamp(it.note.createdAt)}</span>
                        </div>
                        <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-neutral-200">{it.note.content}</p>
                      </div>
                    </li>
                  ) : (
                    <li key={`e-${it.ev.id}`}>
                      <span className={`adm-tl-dot ${dotTone(it.ev.action)}`} aria-hidden="true"><i /></span>
                      <p className="min-w-0 flex-1 pt-0.5 text-xs leading-relaxed text-neutral-400">{evText(it.ev)}</p>
                      <span className="num shrink-0 pt-0.5 text-[11px] text-neutral-600">{fmtStamp(it.ev.at)}</span>
                    </li>
                  ),
                )}
              </ol>
            )}
          </section>

          {rec.conversions.length > 0 && (
            <section>
              <h4 className="mb-3 text-[13px] font-semibold text-neutral-100">{t('admin.support.progress.conversions')}</h4>
              <ul className="space-y-1.5">
                {rec.conversions.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 rounded-xl bg-[var(--surface-2)] px-3.5 py-2.5 text-xs">
                    <span className="font-medium text-neutral-200">{t(`supportDesk.conversions.kind.${c.kind}`)}</span>
                    <span className={`adm-pill ${c.status === 'confirmed' ? 'is-up' : c.status === 'rejected' ? 'is-down' : 'is-warn'}`}>
                      {t(`supportDesk.conversions.status.${c.status}`)}
                    </span>
                    {c.source === 'manual' && <span className="adm-pill">{t('supportDesk.conversions.manual')}</span>}
                    <span className="num ml-auto text-[11px] text-neutral-500">{fmtStamp(c.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* 调整：只给进行中的 / adjust: active follow-ups only */}
          {fu &&
            (fu.active ? (
              <section className="border-t border-[var(--line)] pt-5">
                <h4 className="mb-3 text-[13px] font-semibold text-neutral-100">{t('admin.support.progress.actionsTitle')}</h4>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={reassignTo}
                    onChange={setReassignTo}
                    openUpward
                    className="select-tight min-w-[150px]"
                    ariaLabel={t('admin.support.followUps.reassignTo')}
                    options={[
                      { value: '', label: t('admin.support.followUps.reassignTo') },
                      ...others.map((m) => ({ value: m.id, label: m.nickname || m.email })),
                    ]}
                  />
                  <button type="button" className="adm-btn" disabled={!reassignTo || busy} onClick={() => void act(() => adminSupportApi.reassign([fu.id], reassignTo))}>
                    {t('admin.support.followUps.reassign')}
                  </button>
                  {/* 不限期的跟进没有可延的截止时间 / no deadline, nothing to extend */}
                  {fu.expiresAt && (
                    <>
                      <span className="mx-1 hidden h-5 w-px bg-[var(--line-hi)] sm:block" aria-hidden="true" />
                      <input
                        className="adm-input w-16 text-center"
                        inputMode="numeric"
                        value={extendDays}
                        onChange={(e) => setExtendDays(e.target.value)}
                        aria-label={t('admin.support.followUps.extendDays')}
                      />
                      <button
                        type="button"
                        className="adm-btn"
                        disabled={!Number.isInteger(extendN) || extendN < 1 || extendN > 365 || busy}
                        onClick={() => void act(() => adminSupportApi.extend([fu.id], extendN))}
                      >
                        {t('admin.support.followUps.extend')}
                      </button>
                    </>
                  )}
                  <button type="button" className="adm-btn is-danger sm:ml-auto" disabled={busy} onClick={() => setRevokeConfirm(true)}>
                    {t('admin.support.followUps.revoke')}
                  </button>
                </div>
              </section>
            ) : (
              <p className="border-t border-[var(--line)] pt-4 text-xs text-neutral-500">{t('admin.support.progress.closedHint')}</p>
            ))}
        </div>
      )}

      {/* 抽屉里再弹确认必须用非 center 的 ConfirmModal（见 AdminSheet 说明）/ non-center confirm inside a sheet (see AdminSheet) */}
      {revokeConfirm && fu && (
        <ConfirmModal
          danger
          busy={busy}
          title={t('admin.support.followUps.revoke')}
          message={t('admin.support.progress.revokeOneBody')}
          onConfirm={() => void act(() => adminSupportApi.revoke([fu.id]))}
          onCancel={() => setRevokeConfirm(false)}
        />
      )}
    </AdminSheet>
  )
}
