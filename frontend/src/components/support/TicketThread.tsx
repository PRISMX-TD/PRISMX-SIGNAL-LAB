// 工单会话（工作人员视角）：全部回复含内部备注（琥珀色底，用户永远看不到）、认领 / 指派、
// 改状态、插入快捷回复模板、回复或写内部备注。
// The staff view of one ticket: every reply including internal notes (amber, never shown to the
// user), claim / assign, status, canned-reply templates, and reply-or-internal-note compose.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi, adminSupportApi, supportApi } from '../../api/client'
import { fmtDate } from '../../api/utils'
import type { Ticket, TicketStatus } from '../../api/types'
import type { SupportMe, SupportMember, SupportTemplate } from '../../api/supportTypes'
import { currentLang } from '../../i18n'
import Select from '../Select'
import { SkeletonLine } from '../Skeleton'
import { TicketImageGrid, TicketImagePicker, useTicketImages } from '../TicketImages'
import { TICKET_PRIORITY_TONE, TICKET_STATUS_TONE, Tag, errText } from './supportUi'

const STATUSES: TicketStatus[] = ['open', 'in_progress', 'closed']

export default function TicketThread({
  ticketId,
  me,
  onChanged,
  onOpenCustomer,
  onLoaded,
  onToast,
}: {
  ticketId: string
  me: SupportMe
  onChanged: () => void
  onOpenCustomer?: (userId: string) => void
  onLoaded?: (userId: string) => void
  onToast: (kind: 'ok' | 'err', text: string) => void
}) {
  const { t } = useTranslation()
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [internal, setInternal] = useState(false)
  const [sending, setSending] = useState(false)
  const [templates, setTemplates] = useState<SupportTemplate[]>([])
  const [staff, setStaff] = useState<SupportMember[]>([])
  const images = useTicketImages((msg) => onToast('err', msg))

  const load = useCallback(async () => {
    setLoadErr(null)
    try {
      const tk = await adminApi.getTicket(ticketId)
      setTicket(tk)
      onLoaded?.(tk.userId)
    } catch (err) {
      setLoadErr(errText(err, t('common.error')))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId, t])

  useEffect(() => {
    setTicket(null)
    setText('')
    setInternal(false)
    images.clear()
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId])

  useEffect(() => {
    supportApi.templates(currentLang()).then((r) => setTemplates(r.items)).catch(() => {})
    // 只有管理员能把工单指派给别人，成员表也只有管理员拿得到 / only admins assign to others
    if (me.isAdmin) adminSupportApi.members().then((r) => setStaff(r.items.filter((m) => !m.disabled))).catch(() => {})
  }, [me.isAdmin])

  const apply = (next: Ticket, msg: string) => {
    setTicket(next)
    onChanged()
    onToast('ok', msg)
  }

  const assign = async (assigneeId: string | null) => {
    if (!ticket) return
    try {
      apply(await adminApi.assignTicket(ticket.id, assigneeId), t('supportDesk.thread.assigned'))
    } catch (err) {
      onToast('err', errText(err, t('common.error')))
    }
  }

  const setStatus = async (status: TicketStatus) => {
    if (!ticket || ticket.status === status) return
    try {
      apply(await adminApi.updateTicket(ticket.id, { status }), t('tickets.admin.statusUpdated'))
    } catch (err) {
      onToast('err', errText(err, t('common.error')))
    }
  }

  const canSend = (!!text.trim() || images.keys.length > 0) && !images.uploading && !sending

  const send = async () => {
    if (!ticket || !canSend) return
    setSending(true)
    try {
      const next = await adminApi.replyTicket(ticket.id, text.trim(), {
        images: images.keys,
        internal,
        // 回复用户时把「待处理」顺手转成「处理中」；内部备注不动状态
        // Replying to the user moves open → in progress; an internal note leaves status alone
        ...(!internal && ticket.status === 'open' ? { status: 'in_progress' as TicketStatus } : {}),
      })
      setText('')
      images.clear()
      apply(next, internal ? t('supportDesk.thread.noteSaved') : t('tickets.admin.replySent'))
    } catch (err) {
      onToast('err', errText(err, t('common.error')))
    } finally {
      setSending(false)
    }
  }

  if (loadErr) {
    return (
      <div className="glass p-6 text-center text-sm">
        <p className="text-down">{loadErr}</p>
        <button type="button" className="btn-ghost mt-3 px-4 py-1.5 text-xs" onClick={() => void load()}>
          {t('supportDesk.retry')}
        </button>
      </div>
    )
  }
  if (!ticket) {
    return (
      <div className="glass space-y-3 p-5">
        <SkeletonLine width="55%" height={14} />
        <SkeletonLine />
        <SkeletonLine width="80%" />
      </div>
    )
  }

  const mine = ticket.assigneeId === me.id
  const staffName = (r: Ticket['replies'][number]) => r.authorName || r.authorEmail || t('admin.staff')

  return (
    <div className="flex flex-col gap-3">
      <div className="glass p-4">
        <h2 className="font-display text-base font-bold text-neutral-100 sm:text-lg">{ticket.title}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Tag tone={TICKET_STATUS_TONE[ticket.status] ?? ''}>{t(`tickets.status.${ticket.status}`)}</Tag>
          <Tag tone={TICKET_PRIORITY_TONE[ticket.priority] ?? ''}>{t(`tickets.priority.${ticket.priority}`)}</Tag>
          <Tag tone="bg-white/5 text-neutral-400">{t(`tickets.category.${ticket.category}`)}</Tag>
          {onOpenCustomer && (
            <button
              type="button"
              onClick={() => onOpenCustomer(ticket.userId)}
              className="ml-auto truncate text-xs text-prism-300 underline-offset-2 hover:underline"
            >
              {ticket.userEmail || t('supportDesk.thread.customer')}
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-neutral-500">
            {ticket.assigneeName ? t('supportDesk.queue.assignedTo', { name: ticket.assigneeName }) : t('supportDesk.queue.unassignedTag')}
          </span>
          {me.isAdmin ? (
            <Select
              value={ticket.assigneeId ?? ''}
              onChange={(v) => void assign(v || null)}
              className="select-tight"
              ariaLabel={t('supportDesk.thread.assignTo')}
              options={[
                { value: '', label: t('supportDesk.thread.unassign') },
                { value: me.id, label: t('supportDesk.thread.me') },
                ...staff.filter((m) => m.id !== me.id).map((m) => ({ value: m.id, label: m.nickname || m.email })),
              ]}
            />
          ) : mine ? (
            <button type="button" className="btn-ghost px-3 py-1" onClick={() => void assign(null)}>
              {t('supportDesk.thread.release')}
            </button>
          ) : (
            <button type="button" className="btn-primary px-3 py-1" onClick={() => void assign(me.id)}>
              {t('supportDesk.thread.claim')}
            </button>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void setStatus(s)}
              className={`rounded-lg px-3 py-1 text-xs transition ${
                ticket.status === s ? 'bg-prism-600/20 text-prism-200' : 'bg-white/5 text-neutral-500 hover:bg-white/10'
              }`}
            >
              {t(`tickets.status.${s}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        {ticket.replies.map((r) => {
          const fromStaff = r.authorRole !== 'user'
          return (
            <div key={r.id} className={`flex ${fromStaff ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[88%] rounded-xl px-3.5 py-2.5 sm:max-w-[80%] ${
                  r.internal
                    ? 'border border-dashed border-amber-400/40 bg-amber-400/10'
                    : fromStaff
                      ? 'bg-prism-600/10'
                      : 'bg-white/5'
                }`}
              >
                <div className="mb-1 flex flex-wrap items-center gap-1.5 text-[11px] text-neutral-500">
                  <span className="font-medium text-neutral-300">{fromStaff ? staffName(r) : r.authorEmail}</span>
                  {fromStaff && (
                    <span className="rounded bg-prism-600/20 px-1.5 py-0.5 text-[10px] text-prism-300">
                      {t(`supportDesk.role.${r.authorRole}`)}
                    </span>
                  )}
                  {r.internal && (
                    <span className="rounded bg-amber-400/20 px-1.5 py-0.5 text-[10px] text-amber-200">{t('supportDesk.thread.internalTag')}</span>
                  )}
                  <span className="num">{fmtDate(r.createdAt)}</span>
                </div>
                {r.body && <p className="whitespace-pre-wrap break-words text-sm text-neutral-200">{r.body}</p>}
                <TicketImageGrid urls={r.images} count={r.imageCount} />
              </div>
            </div>
          )
        })}
      </div>

      <div className={`glass space-y-3 p-4 ${internal ? 'ring-1 ring-amber-400/40' : ''}`} {...images.dropProps}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-white/5 p-0.5 text-xs" role="group">
            <button
              type="button"
              aria-pressed={!internal}
              onClick={() => setInternal(false)}
              className={`rounded-md px-3 py-1 transition ${!internal ? 'bg-prism-600/30 text-prism-100' : 'text-neutral-400'}`}
            >
              {t('supportDesk.thread.modeReply')}
            </button>
            <button
              type="button"
              aria-pressed={internal}
              onClick={() => setInternal(true)}
              className={`rounded-md px-3 py-1 transition ${internal ? 'bg-amber-400/25 text-amber-100' : 'text-neutral-400'}`}
            >
              {t('supportDesk.thread.modeInternal')}
            </button>
          </div>
          {templates.length > 0 && (
            <Select
              value=""
              onChange={(id) => {
                const tpl = templates.find((x) => x.id === id)
                if (tpl) setText((prev) => (prev.trim() ? `${prev}\n${tpl.body}` : tpl.body))
              }}
              className="select-tight"
              ariaLabel={t('supportDesk.thread.insertTemplate')}
              options={[{ value: '', label: t('supportDesk.thread.insertTemplate') }, ...templates.map((x) => ({ value: x.id, label: x.title }))]}
            />
          )}
        </div>
        {internal && <p className="text-[11px] text-amber-300">{t('supportDesk.thread.internalHint')}</p>}
        <textarea
          className="input min-h-[96px] w-full rounded-xl py-2 text-sm leading-relaxed resize-y"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={images.onPaste}
          placeholder={internal ? t('supportDesk.thread.internalPlaceholder') : t('tickets.replyPlaceholder')}
          maxLength={5000}
          aria-label={internal ? t('supportDesk.thread.modeInternal') : t('tickets.reply')}
        />
        <TicketImagePicker state={images} disabled={sending} />
        <button type="button" onClick={() => void send()} className="btn-primary w-full px-5 py-2 text-sm disabled:opacity-40 sm:w-auto" disabled={!canSend}>
          {sending ? t('common.loading') : images.uploading ? t('tickets.images.uploading') : internal ? t('supportDesk.thread.saveNote') : t('tickets.reply')}
        </button>
      </div>
    </div>
  )
}
