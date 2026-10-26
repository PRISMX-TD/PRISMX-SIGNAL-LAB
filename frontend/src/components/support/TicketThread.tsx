// 工单会话（工作人员视角）：会话头（标题、提交人、状态、认领 / 指派）、按天分隔的对话（用户在左、
// 客服在右、内部备注琥珀虚线框，用户永远看不到），底部一整块回复框（回复 / 内部备注两个标签、
// 快捷回复、附图、Ctrl/Cmd+Enter 发送）。
// The staff view of one ticket: a header (title, submitter, status, claim / assign), the
// conversation split by day (user left, staff right, internal notes in amber dashed frames that the
// user never sees), and one docked composer (reply / internal tabs, templates, images,
// Ctrl/Cmd+Enter to send).
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi, adminSupportApi, supportApi } from '../../api/client'
import { fmtDate, fmtDay, parseTime } from '../../api/utils'
import type { Ticket, TicketStatus as TicketStatusValue } from '../../api/types'
import type { SupportMe, SupportMember, SupportTemplate } from '../../api/supportTypes'
import { currentLang } from '../../i18n'
import Select from '../Select'
import { SkeletonLine } from '../Skeleton'
import { TicketImageGrid, TicketImagePicker, useTicketImages } from '../TicketImages'
import { IconSend, IconUser } from './deskIcons'
import { Avatar, TICKET_PRIORITY_TONE, Tag, bjDayKey, errText, fmtClock } from './supportUi'

const STATUSES: TicketStatusValue[] = ['open', 'in_progress', 'closed']
// 选中的状态用和队列里状态点同一套颜色 / the selected status uses the queue's status-dot colours
const STATUS_ON: Record<TicketStatusValue, string> = {
  open: 'text-[var(--mid)]',
  in_progress: 'text-[var(--purple-hi)]',
  closed: 'text-neutral-200',
}
// 同一人 5 分钟内的连续消息并成一组，只在第一条显示头像与署名
// Consecutive messages from one author within 5 minutes form a group; only the first shows avatar and name
const GROUP_MS = 5 * 60_000

export default function TicketThread({
  ticketId,
  me,
  onChanged,
  onOpenCustomer,
  onLoaded,
  onToast,
  leading,
}: {
  ticketId: string
  me: SupportMe
  onChanged: () => void
  // 没有右侧客户栏时（<1280 / 手机）会话头给一个「客户资料」按钮 / a customer button when there is no customer pane
  onOpenCustomer?: (userId: string) => void
  onLoaded?: (userId: string) => void
  onToast: (kind: 'ok' | 'err', text: string) => void
  // 手机上的返回按钮 / the back button on phones
  leading?: ReactNode
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
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const replyCount = ticket?.replies.length ?? 0

  // 新消息进来时把会话滚到底 / keep the conversation pinned to the newest message
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [replyCount, ticketId])

  // 回复框随内容长高，最高 220px，之后内部滚动 / the composer grows with its text up to 220px
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text, ticket])

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

  const setStatus = async (status: TicketStatusValue) => {
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
        ...(!internal && ticket.status === 'open' ? { status: 'in_progress' as TicketStatusValue } : {}),
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
      <div className="flex h-full flex-col">
        {leading && <div className="px-3 pt-3">{leading}</div>}
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-sm">
          <p className="text-down">{loadErr}</p>
          <button type="button" className="btn btn-ghost mt-4 h-9 px-5 text-xs" onClick={() => void load()}>
            {t('supportDesk.retry')}
          </button>
        </div>
      </div>
    )
  }
  if (!ticket) {
    return (
      <div className="flex h-full flex-col">
        <div className="space-y-2.5 border-b border-[var(--line)] px-5 py-4">
          {leading}
          <SkeletonLine width="50%" height={16} />
          <SkeletonLine width="35%" height={11} />
        </div>
        <div className="flex-1 space-y-5 p-5">
          <SkeletonLine width="55%" height={56} />
          <div className="flex justify-end"><SkeletonLine width="45%" height={44} /></div>
          <SkeletonLine width="38%" height={40} />
        </div>
      </div>
    )
  }

  const mine = ticket.assigneeId === me.id
  const staffName = (r: Ticket['replies'][number]) => r.authorName || r.authorEmail || t('admin.staff')

  // ---- 会话头 / header ----
  const header = (
    <header className="shrink-0 border-b border-[var(--line)] px-4 pb-3 pt-3.5 sm:px-6 sm:pt-4">
      <div className="flex items-start gap-2.5">
        {leading}
        <div className="min-w-0 flex-1">
          <h2 className="line-clamp-2 font-display text-[17px] font-semibold leading-snug text-neutral-50">{ticket.title}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-neutral-500">
            <span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
              <Avatar name={ticket.userEmail} size={18} />
              <span className="truncate text-neutral-300">{ticket.userEmail}</span>
            </span>
            <span>{t(`tickets.category.${ticket.category}`)}</span>
            {ticket.priority !== 'normal' && <Tag tone={TICKET_PRIORITY_TONE[ticket.priority] ?? ''}>{t(`tickets.priority.${ticket.priority}`)}</Tag>}
            <span className="num">{fmtDate(ticket.createdAt)}</span>
          </div>
        </div>
        {onOpenCustomer && (
          <button
            type="button"
            className="btn btn-ghost h-8 shrink-0 gap-1.5 px-3 text-xs"
            onClick={() => onOpenCustomer(ticket.userId)}
          >
            <IconUser size={14} />
            <span className="hidden sm:inline">{t('supportDesk.drawer.title')}</span>
          </button>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="sd-seg w-auto" role="group" aria-label={t('supportDesk.card.status')}>
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={ticket.status === s}
              onClick={() => void setStatus(s)}
              className={`!flex-none !px-3 ${ticket.status === s ? 'is-on' : ''}`}
            >
              <span className={ticket.status === s ? STATUS_ON[s] : ''}>{t(`tickets.status.${s}`)}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex min-w-0 items-center gap-2 text-xs">
          {ticket.assigneeName ? (
            <span className="inline-flex min-w-0 items-center gap-1.5 text-neutral-400">
              <Avatar name={ticket.assigneeName} size={18} tone="staff" />
              <span className="truncate">{mine ? t('supportDesk.queue.me') : t('supportDesk.queue.assignedTo', { name: ticket.assigneeName })}</span>
            </span>
          ) : (
            <span className="text-[var(--mid)]">{t('supportDesk.queue.unassignedTag')}</span>
          )}
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
            <button type="button" className="btn btn-ghost h-8 px-3 text-xs" onClick={() => void assign(null)}>
              {t('supportDesk.thread.release')}
            </button>
          ) : (
            <button type="button" className="btn btn-primary h-8 px-4 text-xs" onClick={() => void assign(me.id)}>
              {t('supportDesk.thread.claim')}
            </button>
          )}
        </div>
      </div>
    </header>
  )

  // ---- 对话 / conversation ----
  const messages = (
    <div ref={scrollRef} className="sd-scroll min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
      {ticket.replies.map((r, i) => {
        const prev = ticket.replies[i - 1]
        const day = bjDayKey(r.createdAt)
        const newDay = !prev || bjDayKey(prev.createdAt) !== day
        const fromStaff = r.authorRole !== 'user'
        const grouped =
          !newDay &&
          !!prev &&
          prev.authorId === r.authorId &&
          !!prev.internal === !!r.internal &&
          (parseTime(r.createdAt)?.getTime() ?? 0) - (parseTime(prev.createdAt)?.getTime() ?? 0) < GROUP_MS
        const tone = r.internal ? 'note' : fromStaff ? 'staff' : 'neutral'
        const name = fromStaff ? staffName(r) : r.authorEmail
        return (
          <Fragment key={r.id}>
            {newDay && <div className={`sd-day ${i === 0 ? 'mb-5' : 'my-5'}`}>{fmtDay(r.createdAt, '')}</div>}
            <div className={`flex gap-2.5 ${fromStaff ? 'flex-row-reverse' : ''} ${grouped ? 'mt-1' : i === 0 || newDay ? '' : 'mt-4'}`}>
              <span className="w-7 shrink-0">{!grouped && <Avatar name={name} size={28} tone={tone} />}</span>
              <div className={`flex min-w-0 max-w-[85%] flex-col sm:max-w-[72%] ${fromStaff ? 'items-end' : 'items-start'}`}>
                {!grouped && (
                  <div className={`mb-1 flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1 text-[11px] text-neutral-500 ${fromStaff ? 'justify-end' : ''}`}>
                    <span className="max-w-full truncate font-medium text-neutral-300">{name}</span>
                    {fromStaff && <span>{t(`supportDesk.role.${r.authorRole}`)}</span>}
                    {r.internal && (
                      <span className="rounded-full bg-amber-400/15 px-1.5 py-px text-[10px] font-semibold text-amber-200">{t('supportDesk.thread.internalTag')}</span>
                    )}
                    <span className="num">{fmtClock(r.createdAt)}</span>
                  </div>
                )}
                <div
                  className={`rounded-[18px] px-3.5 py-2.5 ${
                    r.internal
                      ? 'rounded-tr-md border border-dashed border-amber-400/45 bg-amber-400/[0.07]'
                      : fromStaff
                        ? 'rounded-tr-md border border-[rgb(var(--purple-rgb)/0.38)] bg-[rgb(var(--purple-rgb)/0.2)]'
                        : 'rounded-tl-md bg-[var(--surface-2)]'
                  }`}
                  title={grouped ? fmtClock(r.createdAt) : undefined}
                >
                  {r.body && <p className="selectable whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-100">{r.body}</p>}
                  <TicketImageGrid urls={r.images} count={r.imageCount} />
                </div>
              </div>
            </div>
          </Fragment>
        )
      })}
    </div>
  )

  // ---- 回复框 / composer ----
  const composer = (
    <div className="shrink-0 px-3 pb-3 pt-1 sm:px-5 sm:pb-5" {...images.dropProps}>
      <div className={`sd-composer ${internal ? 'is-note' : ''}`}>
        <div className="flex items-center gap-4 border-b border-[var(--line)] px-4">
          <button type="button" aria-pressed={!internal} onClick={() => setInternal(false)} className={`sd-mode ${!internal ? 'is-on' : ''}`}>
            {t('supportDesk.thread.modeReply')}
          </button>
          <button type="button" aria-pressed={internal} onClick={() => setInternal(true)} className={`sd-mode note ${internal ? 'is-on' : ''}`}>
            {t('supportDesk.thread.modeInternal')}
          </button>
          {templates.length > 0 && (
            <div className="ml-auto min-w-0 py-1.5">
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
        <textarea
          ref={inputRef}
          rows={2}
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
          style={{ minHeight: 64 }}
        />
        <div className="flex flex-wrap items-end gap-2 px-3 pb-3">
          <div className="min-w-0 flex-1">
            <TicketImagePicker state={images} disabled={sending} />
          </div>
          <span className="hidden pb-2 text-[11px] text-neutral-500 lg:inline">{t('supportDesk.thread.sendHint')}</span>
          <button
            type="button"
            onClick={() => void send()}
            className={`btn h-9 shrink-0 gap-1.5 px-4 text-xs ${internal ? 'border-amber-400/40 bg-amber-400/20 text-amber-100 hover:bg-amber-400/30' : 'btn-primary'}`}
            disabled={!canSend}
          >
            <IconSend size={14} />
            {sending ? t('common.loading') : images.uploading ? t('tickets.images.uploading') : internal ? t('supportDesk.thread.saveNote') : t('tickets.reply')}
          </button>
        </div>
      </div>
      {internal && <p className="mt-2 px-1 text-[11px] text-amber-300/90">{t('supportDesk.thread.internalHint')}</p>}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      {messages}
      {composer}
    </div>
  )
}
