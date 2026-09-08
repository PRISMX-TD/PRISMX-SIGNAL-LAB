// 客服工单：列表 → 表单 → 详情对话，三个视图由 view 状态切换（不走路由）。
// 2026-09-08 视觉重做，数据流与接口调用不变；样式在 styles/support.css（.sup-*）。
// Support tickets: list → form → thread, switched by the `view` state (not routes).
// Relaid 2026-09-08 with the data flow and API calls unchanged; styled by
// styles/support.css (.sup-*).
import { useEffect, useState, type FormEvent } from 'react'
import PageHead from '../components/PageHead'
import { useTranslation } from 'react-i18next'
import { ticketApi } from '../api/client'
import Select from '../components/Select'
import { parseTime } from '../api/utils'
import type { Ticket, TicketCategory, TicketListItem, TicketPriority, TicketStatus } from '../api/types'

type View = 'list' | 'form' | { ticket: Ticket }

const CATEGORY_OPTIONS: TicketCategory[] = ['account', 'payment', 'technical', 'feature']

// 更新日期：列表里只要「几号」，同一年内省掉年份。/ Updated date: day-level in the list.
function fmtDay(iso: string): string {
  const d = parseTime(iso) ?? new Date(iso)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleDateString(undefined, sameYear ? { month: '2-digit', day: '2-digit' } : { year: 'numeric', month: '2-digit', day: '2-digit' })
}
function fmtStamp(iso: string): string {
  return (parseTime(iso) ?? new Date(iso)).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}
function initial(email: string): string {
  return (email.trim()[0] || '?').toUpperCase()
}

// 状态点 + 状态词：一处渲染，列表行与页头小标签共用。
// Status dot + word, shared by list rows and the head badge.
function StatusWord({ status, badge, t }: { status: TicketStatus; badge?: boolean; t: ReturnType<typeof useTranslation>['t'] }) {
  return (
    <span className={`sup-status ${status}${badge ? ' badge' : ''}`}>
      <i aria-hidden="true" />
      {t(`tickets.status.${status}`)}
    </span>
  )
}

// 分类与优先级小标签：普通优先级不占位——它是默认值，写出来只是噪音。
// Category and priority chips; "normal" priority is not rendered — it is the default.
function MetaChips({ category, priority, t }: { category: TicketCategory; priority: TicketPriority; t: ReturnType<typeof useTranslation>['t'] }) {
  return (
    <>
      <span className="tag sup-cat">{t(`tickets.category.${category}`)}</span>
      {priority !== 'normal' && <span className={`tag sup-pri ${priority}`}>{t(`tickets.priority.${priority}`)}</span>}
    </>
  )
}

function Message({ authorEmail, authorRole, body, createdAt, index, t }: {
  authorEmail: string
  authorRole: string
  body: string
  createdAt: string
  index: number
  t: ReturnType<typeof useTranslation>['t']
}) {
  const isAdmin = authorRole === 'admin'
  return (
    <div className={`sup-msg-row${isAdmin ? ' staff' : ''}`} style={{ '--i': index } as React.CSSProperties}>
      <span className="sup-ava" aria-hidden="true">{initial(authorEmail)}</span>
      <div className="min-w-0">
        <div className="sup-msg-meta">
          <span className="name">{authorEmail}</span>
          {isAdmin && <span className="staff">{t('admin.staff')}</span>}
          <span className="time num">{fmtStamp(createdAt)}</span>
        </div>
        <p className="sup-msg-body">{body}</p>
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

  const errorBanner = error ? <div className="sup-msg err" role="alert">{error}</div> : null
  const backToList = { label: t('tickets.backToList'), onClick: () => { setView('list'); loadTickets() } }

  // Form view
  if (view === 'form') {
    return (
      <div className="sup-wrap">
        {errorBanner}
        <PageHead as="h1" title={t('tickets.newTicket')} subtitle={t('tickets.form.intro')} back={{ label: t('tickets.backToList'), onClick: () => setView('list') }} />
        <div className="card glass sup-form-card">
          <ul className="sup-tips">
            <li>{t('tickets.form.tip1')}</li>
            <li>{t('tickets.form.tip2')}</li>
            <li>{t('tickets.form.tip3')}</li>
          </ul>
          <form onSubmit={handleSubmit} className="sup-form">
            <div className="sup-field">
              <label htmlFor="ticket-title">{t('tickets.form.title')}</label>
              <input id="ticket-title" className="input" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder={t('tickets.form.titlePlaceholder')} maxLength={200} required />
            </div>
            {/* 分类用自定义下拉：原生 select 的选项列表在深色主题下是白底黑字，见 Select.tsx 的说明。
                优先级不在此处提供——由管理员在后台按工单内容判定。
                Category uses the custom dropdown — a native select's option list renders
                white-on-black in the dark theme, see Select.tsx. Priority isn't offered
                here; admins set it in the back office based on the ticket's content. */}
            <div className="sup-field">
              <label>{t('tickets.form.category')}</label>
              <Select
                className="w-full select-lg"
                value={category}
                onChange={(v) => setCategory(v as TicketCategory)}
                options={CATEGORY_OPTIONS.map((c) => ({ value: c, label: t(`tickets.category.${c}`) }))}
              />
            </div>
            <div className="sup-field">
              <label htmlFor="ticket-body">{t('tickets.form.content')}</label>
              <textarea id="ticket-body" className="input sup-textarea" value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={t('tickets.form.contentPlaceholder')} maxLength={5000} required />
            </div>
            <button type="submit" className="btn btn-primary sup-submit" disabled={submitting}>
              {submitting ? t('tickets.form.submitting') : t('tickets.form.submit')}
            </button>
          </form>
        </div>
      </div>
    )
  }

  // Detail view
  if (typeof view === 'object' && 'ticket' in view) {
    const ticket = view.ticket
    const closed = ticket.status === 'closed'
    const busy = closed ? reopening : replying
    return (
      <div className="sup-wrap">
        {errorBanner}
        <PageHead
          as="h1"
          title={ticket.title}
          badge={<StatusWord status={ticket.status} badge t={t} />}
          subtitle={<>{ticket.userEmail} &middot; {t('tickets.openedAt')} <span className="num">{fmtStamp(ticket.createdAt)}</span></>}
          actions={<div className="sup-head-chips"><MetaChips category={ticket.category} priority={ticket.priority} t={t} /></div>}
          back={backToList}
        />
        <div className="sup-stack">
          <section className="card glass sup-thread">
            <div className="sup-thread-head">
              <h3>{t('tickets.thread')}</h3>
              <b className="num">{ticket.replies.length}</b>
              <span>{t('tickets.replyUnit')}</span>
            </div>
            {ticket.replies.length === 0 ? (
              <p className="sup-thread-empty">{t('tickets.empty')}</p>
            ) : (
              ticket.replies.map((r, i) => (
                <Message key={r.id} index={i} authorEmail={r.authorEmail} authorRole={r.authorRole} body={r.body} createdAt={r.createdAt} t={t} />
              ))
            )}
          </section>

          <section className="card glass sup-compose">
            <textarea className="input sup-textarea" value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder={t('tickets.replyPlaceholder')} maxLength={5000} aria-label={t('tickets.reply')} />
            <div className="sup-compose-foot">
              {closed && <p>{t('tickets.closedWarning')}</p>}
              <button
                type="button"
                onClick={() => (closed ? handleReopen(ticket.id) : handleReply(ticket.id))}
                className="btn btn-primary"
                disabled={busy || !replyText.trim()}
              >
                {busy ? '…' : closed ? t('tickets.reopen') : t('tickets.reply')}
              </button>
            </div>
          </section>
        </div>
      </div>
    )
  }

  // List view (default)
  return (
    <div className="sup-wrap">
      {errorBanner}
      <PageHead
        as="h1"
        title={t('tickets.title')}
        count={loading ? null : tickets.length}
        countUnit={t('tickets.countUnit')}
        subtitle={t('tickets.subtitle')}
        actions={
          <button onClick={() => setView('form')} className="btn btn-primary">
            {t('tickets.newTicket')}
          </button>
        }
      />

      <section className="card glass sup-list" aria-busy={loading || undefined}>
        {loading ? (
          [0, 1, 2].map((i) => (
            <div key={i} className="sup-row skel" aria-hidden="true">
              <span className="skeleton" style={{ width: 64 }} />
              <span className="sup-main">
                <span className="skeleton" style={{ width: '46%' }} />
                <span className="skeleton" style={{ width: '72%', marginTop: 8 }} />
              </span>
              <span className="skeleton" style={{ width: 72 }} />
              <span className="skeleton" style={{ width: 40 }} />
              <span />
            </div>
          ))
        ) : tickets.length === 0 ? (
          <div className="sup-empty">
            <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 22h8l2 4h8l2-4h8" />
              <path d="M6 22v10a2 2 0 0 0 2 2h24a2 2 0 0 0 2-2V22L29 8H11L6 22z" />
              <path d="M14 14h12M15 18h10" />
            </svg>
            <b>{t('tickets.empty')}</b>
            <p>{t('tickets.emptyHint')}</p>
          </div>
        ) : (
          tickets.map((ticket, i) => (
            <button
              key={ticket.id}
              type="button"
              className="sup-row"
              style={{ '--i': i } as React.CSSProperties}
              onClick={async () => {
                try { setView({ ticket: await ticketApi.get(ticket.id) }) } catch { showError(t('common.error')) }
              }}
            >
              <StatusWord status={ticket.status} t={t} />
              <span className="sup-main">
                <span className="sup-title">{ticket.title}</span>
                {ticket.latestReply && (
                  <span className="sup-last">
                    <span className="who">{ticket.latestReply.authorRole === 'admin' ? t('admin.staff') : t('tickets.me')}</span>
                    {' · '}
                    {ticket.latestReply.body}
                  </span>
                )}
              </span>
              <span className="sup-meta"><MetaChips category={ticket.category} priority={ticket.priority} t={t} /></span>
              <time className="sup-date num" dateTime={ticket.updatedAt}>{fmtDay(ticket.updatedAt)}</time>
              <svg className="sup-chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>
            </button>
          ))
        )}
      </section>
    </div>
  )
}
