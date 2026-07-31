import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ticketApi } from '../api/client'
import type { Ticket, TicketCategory, TicketListItem, TicketPriority } from '../api/types'

type View = 'list' | 'form' | { ticket: Ticket }

const CATEGORY_OPTIONS: TicketCategory[] = ['account', 'payment', 'technical', 'feature']
const PRIORITY_OPTIONS: TicketPriority[] = ['low', 'normal', 'urgent']

const statusClass: Record<string, string> = {
  open: 'bg-amber-400/15 text-amber-300',
  in_progress: 'bg-blue-400/15 text-blue-300',
  closed: 'bg-slate-500/15 text-slate-400',
}

const priorityClass: Record<string, string> = {
  low: 'bg-slate-500/15 text-slate-400',
  normal: 'bg-blue-400/15 text-blue-300',
  urgent: 'bg-down/15 text-down',
}

function ReplyBubble({ authorEmail, authorRole, body, createdAt, t }: {
  authorEmail: string
  authorRole: string
  body: string
  createdAt: string
  t: ReturnType<typeof useTranslation>['t']
}) {
  const isAdmin = authorRole === 'admin'
  return (
    <div className={`flex ${isAdmin ? 'justify-start' : 'justify-end'} mb-3`}>
      <div className={`max-w-[80%] rounded-xl px-4 py-3 ${
        isAdmin ? 'bg-white/5' : 'bg-prism-600/15'
      }`}>
        <div className="mb-1 flex items-center gap-2 text-[11px] text-slate-500">
          <span className="font-medium text-slate-300">{authorEmail}</span>
          {isAdmin && <span className="rounded bg-prism-600/20 px-1.5 py-0.5 text-[10px] text-prism-300">{t('admin.staff')}</span>}
          <span>{new Date(createdAt).toLocaleString()}</span>
        </div>
        <p className="whitespace-pre-wrap text-sm text-slate-200">{body}</p>
      </div>
    </div>
  )
}

export default function SupportPage() {
  const { t } = useTranslation()
  const [view, setView] = useState<View>('list')
  const [tickets, setTickets] = useState<TicketListItem[]>([])
  const [loading, setLoading] = useState(true)

  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<TicketCategory>('technical')
  const [priority, setPriority] = useState<TicketPriority>('normal')
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const [replyText, setReplyText] = useState('')
  const [replying, setReplying] = useState(false)
  const [reopening, setReopening] = useState(false)

  const [error, setError] = useState('')
  const showError = (msg: string) => { setError(msg); setTimeout(() => setError(''), 4000) }

  const loadTickets = async () => {
    try {
      setTickets(await ticketApi.list())
    } catch {
      showError(t('common.error'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadTickets() }, [])

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !body.trim()) return
    setSubmitting(true)
    try {
      const ticket = await ticketApi.create({
        title: title.trim(),
        category,
        priority,
        body: body.trim(),
      })
      setView({ ticket })
      loadTickets()
    } catch {
      showError(t('common.error'))
    } finally {
      setSubmitting(false)
    }
  }

  const handleReply = async (ticketId: string, reopen = false) => {
    if (!replyText.trim()) return
    setReplying(true)
    try {
      const ticket = await ticketApi.reply(ticketId, replyText.trim(), reopen)
      setView({ ticket })
      setReplyText('')
    } catch {
      showError(t('common.error'))
    } finally {
      setReplying(false)
    }
  }

  const handleReopen = async (ticketId: string) => {
    if (!replyText.trim()) return
    setReopening(true)
    try {
      const ticket = await ticketApi.reply(ticketId, replyText.trim(), true)
      setView({ ticket })
      setReplyText('')
    } catch {
      showError(t('common.error'))
    } finally {
      setReopening(false)
    }
  }

  // Form view
  if (view === 'form') {
    return (
      <div className="mx-auto max-w-lg">
        {error && <div className="mb-4 rounded-lg border border-down/40 bg-down/15 px-4 py-2.5 text-sm text-down">{error}</div>}
        <button onClick={() => setView('list')} className="btn-ghost mb-4 px-3 py-1.5 text-sm">
          &larr; {t('tickets.backToList')}
        </button>
        <h2 className="mb-6 font-display text-xl font-bold text-slate-100">{t('tickets.newTicket')}</h2>
        <form onSubmit={handleSubmit} className="glass p-5 space-y-4">
          <div>
            <label className="label">{t('tickets.form.title')}</label>
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder={t('tickets.form.titlePlaceholder')} maxLength={200} required />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">{t('tickets.form.category')}</label>
              <select className="input" value={category} onChange={(e) => setCategory(e.target.value as TicketCategory)}>
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c} value={c}>{t(`tickets.category.${c}`)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">{t('tickets.form.priority')}</label>
              <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
                {PRIORITY_OPTIONS.map((p) => (
                  <option key={p} value={p}>{t(`tickets.priority.${p}`)}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label">{t('tickets.form.content')}</label>
            <textarea className="input min-h-[160px] resize-y" value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t('tickets.form.contentPlaceholder')} maxLength={5000} required />
          </div>
          <button type="submit" className="btn-primary w-full py-2.5 text-sm disabled:opacity-40" disabled={submitting}>
            {submitting ? t('tickets.form.submitting') : t('tickets.form.submit')}
          </button>
        </form>
      </div>
    )
  }

  // Detail view
  if (typeof view === 'object' && 'ticket' in view) {
    const ticket = view.ticket
    return (
      <div className="mx-auto max-w-2xl">
        {error && <div className="mb-4 rounded-lg border border-down/40 bg-down/15 px-4 py-2.5 text-sm text-down">{error}</div>}
        <button onClick={() => { setView('list'); loadTickets() }} className="btn-ghost mb-4 px-3 py-1.5 text-sm">
          &larr; {t('tickets.backToList')}
        </button>
        <div className="glass p-5 mb-4">
          <h2 className="font-display text-lg font-bold text-slate-100 mb-3">{ticket.title}</h2>
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className={`tag ${statusClass[ticket.status]}`}>{t(`tickets.status.${ticket.status}`)}</span>
            <span className={`tag ${priorityClass[ticket.priority]}`}>{t(`tickets.priority.${ticket.priority}`)}</span>
            <span className="tag bg-white/5 text-slate-400">{t(`tickets.category.${ticket.category}`)}</span>
          </div>
          <p className="text-xs text-slate-500 mt-2">
            {ticket.userEmail} &middot; {new Date(ticket.createdAt).toLocaleString()}
          </p>
        </div>

        <div className="mb-4">
          {ticket.replies.map((r) => (
            <ReplyBubble key={r.id} authorEmail={r.authorEmail} authorRole={r.authorRole} body={r.body} createdAt={r.createdAt} t={t} />
          ))}
        </div>

        {ticket.status === 'closed' ? (
          <div className="glass p-4">
            <p className="mb-3 text-sm text-slate-400">{t('tickets.closedWarning')}</p>
            <textarea className="input mb-3 min-h-[80px] w-full resize-y" value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder={t('tickets.replyPlaceholder')} maxLength={5000} />
            <button onClick={() => handleReopen(ticket.id)}
              className="btn-primary px-5 py-2 text-sm disabled:opacity-40" disabled={reopening || !replyText.trim()}>
              {reopening ? '...' : t('tickets.reopen')}
            </button>
          </div>
        ) : (
          <div className="glass p-4">
            <textarea className="input mb-3 min-h-[80px] w-full resize-y" value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder={t('tickets.replyPlaceholder')} maxLength={5000} />
            <button onClick={() => handleReply(ticket.id)}
              className="btn-primary px-5 py-2 text-sm disabled:opacity-40" disabled={replying || !replyText.trim()}>
              {replying ? '...' : t('tickets.reply')}
            </button>
          </div>
        )}
      </div>
    )
  }

  // List view (default)
  return (
    <div className="mx-auto max-w-2xl">
      {error && <div className="mb-4 rounded-lg border border-down/40 bg-down/15 px-4 py-2.5 text-sm text-down">{error}</div>}
      <div className="mb-6 flex items-center justify-between">
        <h2 className="font-display text-2xl font-bold text-slate-100">
          <span className="neon-text">{t('tickets.title')}</span>
        </h2>
        <button onClick={() => setView('form')} className="btn-primary px-4 py-2 text-sm">
          {t('tickets.newTicket')}
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
        </div>
      ) : tickets.length === 0 ? (
        <div className="glass p-8 text-center text-sm text-slate-500">{t('tickets.empty')}</div>
      ) : (
        <div className="space-y-3">
          {tickets.map((ticket) => (
            <button
              key={ticket.id}
              onClick={async () => {
                try { setView({ ticket: await ticketApi.get(ticket.id) }) } catch { showError(t('common.error')) }
              }}
              className="glass w-full p-4 text-left transition hover:bg-white/[0.03]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`tag text-[10px] ${statusClass[ticket.status]}`}>{t(`tickets.status.${ticket.status}`)}</span>
                    <span className={`tag text-[10px] ${priorityClass[ticket.priority]}`}>{t(`tickets.priority.${ticket.priority}`)}</span>
                    <span className="text-[10px] text-slate-500">{t(`tickets.category.${ticket.category}`)}</span>
                  </div>
                  <h3 className="truncate text-sm font-medium text-slate-200">{ticket.title}</h3>
                  {ticket.latestReply && (
                    <p className="mt-1.5 truncate text-xs text-slate-500">
                      {ticket.latestReply.authorEmail}: {ticket.latestReply.body}
                    </p>
                  )}
                </div>
                <span className="shrink-0 text-[11px] text-slate-600">
                  {new Date(ticket.updatedAt).toLocaleDateString()}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
