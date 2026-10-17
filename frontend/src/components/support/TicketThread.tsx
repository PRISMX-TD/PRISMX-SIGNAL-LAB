// 工单会话（工作人员视角）：全部回复含内部备注（琥珀色底，用户永远看不到）、认领 / 指派、
// 改状态、插入快捷回复模板、回复或写内部备注。
// The staff view of one ticket: every reply including internal notes (amber, never shown to the
// user), claim / assign, status, canned-reply templates, and reply-or-internal-note compose.
import { useCallback, useEffect, useRef, useState } from 'react'
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const replyCount = ticket?.replies.length ?? 0
  // 新消息进来时把会话滚到底 / keep the conversation pinned to the newest message
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [replyCount, ticketId])

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
      <div className="glass rounded-2xl p-6 text-center text-sm">
        <p className="text-down">{loadErr}</p>
        <button type="button" className="btn-ghost mt-3 px-4 py-1.5 text-xs" onClick={() => void load()}>
          {t('supportDesk.retry')}
        </button>
      </div>
    )
  }
  if (!ticket) {
    return (
      <div className="glass space-y-3 rounded-2xl p-5">
        <SkeletonLine width="55%" height={14} />
        <SkeletonLine />
        <SkeletonLine width="80%" />
      </div>
    )
  }

  const mine = ticket.assigneeId === me.id
  const staffName = (r: Ticket['replies'][number]) => r.authorName || r.authorEmail || t('admin.staff')

  return (
    <div className="glass flex h-full min-h-0 flex-col overflow-hidden rounded-2xl">
      {/* 会话头 / thread header */}
      <header className="shrink-0 border-b border-white/[0.06] px-4 py-3 sm:px-5">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <div className="min-w-0 flex-1 basis-56">
            <h2 className="truncate font-display text-base font-semibold text-neutral-50">{ticket.title}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
              {onOpenCustomer ? (
                <button
                  type="button"
                  onClick={() => onOpenCustomer(ticket.userId)}
                  className="max-w-full truncate text-prism-300 underline-offset-2 hover:underline"
                >
                  {ticket.userEmail || t('supportDesk.thread.customer')}
                </button>
              ) : (
                <span className="max-w-full truncate text-neutral-400">{ticket.userEmail}</span>
              )}
              <Tag tone="bg-white/5 text-neutral-400">{t(`tickets.category.${ticket.category}`)}</Tag>
              <Tag tone={TICKET_PRIORITY_TONE[ticket.priority] ?? ''}>{t(`tickets.priority.${ticket.priority}`)}</Tag>
            </div>
          </div>
          <div className="flex shrink-0 rounded-lg bg-white/5 p-0.5" role="group" aria-label={t('supportDesk.card.status')}>
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={ticket.status === s}
                onClick={() => void setStatus(s)}
                className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
                  ticket.status === s ? TICKET_STATUS_TONE[s] ?? '' : 'text-neutral-500 hover:text-neutral-200'
                }`}
              >
                {t(`tickets.status.${s}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className={ticket.assigneeName ? 'text-neutral-400' : 'text-amber-300/80'}>
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
            <button type="button" className="btn-ghost px-2.5 py-0.5 text-xs" onClick={() => void assign(null)}>
              {t('supportDesk.thread.release')}
            </button>
          ) : (
            <button type="button" className="btn-primary px-2.5 py-0.5 text-xs" onClick={() => void assign(me.id)}>
              {t('supportDesk.thread.claim')}
            </button>
          )}
        </div>
      </header>

      {/* 消息 / messages */}
      <div ref={scrollRef} className="min-h-[200px] flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-5">
        {ticket.replies.map((r) => {
          const fromStaff = r.authorRole !== 'user'
          return (
            <div key={r.id} className={`flex flex-col ${fromStaff ? 'items-end' : 'items-start'}`}>
              <div className={`mb-1 flex max-w-full flex-wrap items-center gap-1.5 px-1 text-[11px] text-neutral-500 ${fromStaff ? 'justify-end' : ''}`}>
                <span className="max-w-full truncate font-medium text-neutral-300">{fromStaff ? staffName(r) : r.authorEmail}</span>
                {fromStaff && <span>{t(`supportDesk.role.${r.authorRole}`)}</span>}
                {r.internal && (
                  <span className="rounded bg-amber-400/15 px-1.5 py-px text-[10px] font-medium text-amber-200">{t('supportDesk.thread.internalTag')}</span>
                )}
                <span className="num">{fmtDate(r.createdAt)}</span>
              </div>
              <div
                className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 sm:max-w-[78%] ${
                  r.internal
                    ? 'rounded-tr-md border border-dashed border-amber-400/40 bg-amber-400/[0.07]'
                    : fromStaff
                      ? 'rounded-tr-md bg-prism-600/[0.18]'
                      : 'rounded-tl-md bg-white/[0.06]'
                }`}
              >
                {r.body && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-100">{r.body}</p>}
                <TicketImageGrid urls={r.images} count={r.imageCount} />
              </div>
            </div>
          )
        })}
      </div>

      {/* 输入区：固定在会话底部 / composer docked at the bottom */}
      <div
        className={`shrink-0 border-t px-3 py-3 sm:px-4 ${internal ? 'border-amber-400/30 bg-amber-400/[0.04]' : 'border-white/[0.06]'}`}
        {...images.dropProps}
      >
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg bg-white/5 p-0.5 text-xs" role="group">
            <button
              type="button"
              aria-pressed={!internal}
              onClick={() => setInternal(false)}
              className={`rounded-md px-3 py-1 transition ${!internal ? 'bg-prism-600/30 text-prism-100' : 'text-neutral-400 hover:text-neutral-200'}`}
            >
              {t('supportDesk.thread.modeReply')}
            </button>
            <button
              type="button"
              aria-pressed={internal}
              onClick={() => setInternal(true)}
              className={`rounded-md px-3 py-1 transition ${internal ? 'bg-amber-400/25 text-amber-100' : 'text-neutral-400 hover:text-neutral-200'}`}
            >
              {t('supportDesk.thread.modeInternal')}
            </button>
          </div>
          {templates.length > 0 && (
            <div className="ml-auto min-w-0">
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
            </div>
          )}
        </div>
        {internal && <p className="mb-2 text-[11px] text-amber-300">{t('supportDesk.thread.internalHint')}</p>}
        <textarea
          className="input min-h-[76px] w-full resize-y rounded-xl py-2 text-sm leading-relaxed"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onPaste={images.onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={internal ? t('supportDesk.thread.internalPlaceholder') : t('tickets.replyPlaceholder')}
          maxLength={5000}
          aria-label={internal ? t('supportDesk.thread.modeInternal') : t('tickets.reply')}
        />
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <TicketImagePicker state={images} disabled={sending} />
          </div>
          <span className="hidden text-[11px] text-neutral-500 lg:inline">{t('supportDesk.thread.sendHint')}</span>
          <button type="button" onClick={() => void send()} className="btn-primary shrink-0 px-5 py-2 text-sm disabled:opacity-40" disabled={!canSend}>
            {sending ? t('common.loading') : images.uploading ? t('tickets.images.uploading') : internal ? t('supportDesk.thread.saveNote') : t('tickets.reply')}
          </button>
        </div>
      </div>
    </div>
  )
}
