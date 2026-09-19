// 客服工单：列表 → 表单 → 详情对话，三个视图由 view 状态切换（不走路由）。
// 2026-09-08 视觉重做，数据流与接口调用不变；样式在 styles/support.css（.sup-*）。
// 例外是 ?ticket=<id>：站内通知「工单有新回复」要能一步落到那条工单上，而视图
// 是状态不是路由，所以进页时读一次查询参数把对应工单打开，随即把参数从地址栏
// 抹掉（replace，不留历史记录）——否则用户在页内退回列表后一刷新又被弹回详情。
// Support tickets: list → form → thread, switched by the `view` state (not routes).
// Relaid 2026-09-08 with the data flow and API calls unchanged; styled by
// styles/support.css (.sup-*). One exception: ?ticket=<id>, so the "new reply on
// your ticket" notification can land on that thread in one step. Views are state
// rather than routes, so the param is read once on entry and then stripped from
// the URL (replace, no history entry) — otherwise backing out to the list and
// refreshing would bounce the user into the thread again.
import { useEffect, useState, type FormEvent } from 'react'
import PageHead from '../components/PageHead'
import SocialLinks from '../components/SocialLinks'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { ticketApi } from '../api/client'
import Select from '../components/Select'
import { fmtDayShort, parseTime } from '../api/utils'
import type { Ticket, TicketCategory, TicketListItem, TicketPriority, TicketStatus } from '../api/types'

type View = 'list' | 'form' | { ticket: Ticket }

const CATEGORY_OPTIONS: TicketCategory[] = ['account', 'payment', 'technical', 'feature']

// 更新日期：列表里只要「几号」，同一年内省掉年份。改走 api/utils 的 fmtDayShort，
// 不再本地实现——原来那份用 toLocaleDateString(undefined, …)，渲染在**浏览器本地
// 时区**里，而全站约定是固定 UTC+8（见 api/utils 头注）。
// Updated date: day-level in the list, via api/utils' fmtDayShort rather than a
// local copy — the old one used toLocaleDateString(undefined, …) and rendered in
// the browser's zone, while the site fixes everything to UTC+8 (api/utils header).
const fmtDay = fmtDayShort

// 对话气泡上的时刻：要到分钟，所以不能用 fmtDay/fmtDate（前者没有时分，后者带年份
// 且拼了 UTC+8 后缀，对一串气泡来说太长）。时区仍显式固定成 Asia/Shanghai，与全站
// 一致——原来这里是 undefined，等于跟着浏览器走。
// The timestamp on a thread bubble needs minutes, so neither fmtDay (no time) nor
// fmtDate (carries the year and a UTC+8 suffix, too long on a run of bubbles)
// fits. The zone is still pinned to Asia/Shanghai like everywhere else; it used
// to be undefined, i.e. whatever the browser says.
function fmtStamp(iso: string): string {
  const d = parseTime(iso)
  if (!d || Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
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

  // 通知里的深链：?ticket=<id> 直接打开那条工单。取不到（被删、不是自己的）就
  // 静静留在列表——从通知点进来发现"工单不存在"的红条没有任何用处。
  // Deep link from a notification: ?ticket=<id> opens that thread. A miss
  // (deleted, someone else's) quietly leaves the list up — arriving from a
  // notification onto a red "ticket not found" banner helps nobody.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const id = searchParams.get('ticket')
    if (!id) return
    // 只删 ticket 这一个键，不是把整个查询串清空。
    // 原来是 setSearchParams(new URLSearchParams())，从带 ?ref=xxx&ticket=yyy 这类
    // 链接进来时会把 ref 等其它参数一并抹掉。/support 当前确实没有别的参数，所以
    // 这是一颗埋着的雷而不是现成的故障；AdminPage 那边的同款逻辑写的就是 delete。
    // Delete only the ticket key rather than wiping the whole query string. This
    // used to be setSearchParams(new URLSearchParams()), which also dropped ref
    // and anything else when arriving from a link like ?ref=xxx&ticket=yyy.
    // /support carries no other params today, so this is a buried mine rather
    // than a live failure; the equivalent code in AdminPage already uses delete.
    const next = new URLSearchParams(searchParams)
    next.delete('ticket')
    setSearchParams(next, { replace: true })
    ticketApi.get(id).then((ticket) => setView({ ticket })).catch(() => {})
  }, [])

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

      {/* 工单之外的联系方式。放在列表下方而不是页头：工单才是这一页的主路径，
          社群入口是「这里没解决的话还可以去哪」，抢在提交工单之前出现反而会把
          人从有记录、可追踪的渠道推到没记录的渠道去。
          Contact routes beyond tickets. Below the list rather than in the header:
          filing a ticket is this page's main path, and the community links answer
          "where else, if that didn't work" — surfacing them first would push
          people off a tracked channel onto an untracked one. */}
      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-white/[0.06] pt-5 text-[13px] text-neutral-500">
        <span>{t('social.findUs')}</span>
        <SocialLinks size={17} />
      </div>
    </div>
  )
}
