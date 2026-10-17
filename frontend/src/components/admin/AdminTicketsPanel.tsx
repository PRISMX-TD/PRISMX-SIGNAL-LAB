// 管理控制台「客服 › 工单」：按状态 / 分类筛的工单列表 + 单条会话与回复。2026-10-17 从 AdminPage 拆出来，
// 视觉改成客服后台的语言（一整块列表面、点 + 词的状态、左右气泡、底部回复框）。完整的多栏工作台在
// 客服后台；这里留给管理员按分类翻一遍、顺手回一条。
// The console's Support › Tickets: a list filtered by status / category plus one thread with a
// reply box. Split out of AdminPage on 2026-10-17 and restyled in the support console's language
// (one list plane, dot-and-word status, left / right bubbles, composer at the bottom). The full
// multi-pane workspace is the support console; this is for paging through by category and
// answering in passing.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { adminApi, isAbortError } from '../../api/client'
import { fmtDate, fmtDay } from '../../api/utils'
import type { Ticket, TicketCategory, TicketListItem, TicketPriority, TicketStatus as TicketStatusValue } from '../../api/types'
import Select from '../Select'
import { SkeletonLine } from '../Skeleton'
import { TicketImageGrid, TicketImagePicker, useTicketImages } from '../TicketImages'
import { Avatar, TicketStatus } from '../support/supportUi'

const STATUSES: TicketStatusValue[] = ['open', 'in_progress', 'closed']
const PRIORITIES: TicketPriority[] = ['low', 'normal', 'urgent']
const CATEGORIES: TicketCategory[] = ['account', 'payment', 'claim', 'technical', 'feature', 'follow_up']

const PRIORITY_PILL: Record<string, string> = {
  low: '',
  normal: 'is-info',
  urgent: 'is-down',
}

export default function AdminTicketsPanel({ onToast }: { onToast: (kind: 'ok' | 'err', text: string) => void }) {
  const { t } = useTranslation()
  const [tickets, setTickets] = useState<TicketListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [detail, setDetail] = useState<Ticket | null>(null)
  const [replyText, setReplyText] = useState('')
  const [replyStatus, setReplyStatus] = useState<TicketStatusValue | ''>('')
  const [replyPriority, setReplyPriority] = useState<TicketPriority | ''>('')
  const [sending, setSending] = useState(false)
  const replyImages = useTicketImages((msg) => onToast('err', msg))

  // 每次加载中止上一次：两个筛选下拉是最容易连点的地方，先发的响应后到就会把
  // 当前筛选的结果覆盖掉，表格与筛选条对不上且没有任何提示。中止之后 fetch 会以
  // AbortError 拒绝，用 isAbortError 认出来直接忽略——那不是故障，是我们自己取消的。
  // 组件卸载时也中止，顺带解决卸载后 setState 的告警。
  // Every load aborts the previous one: the two filter selects are the easiest
  // thing to click through quickly, and an earlier response landing last
  // overwrites the current filter's results with no sign that it happened. After
  // an abort fetch rejects with AbortError, which isAbortError recognises and
  // drops — that is not a failure, it is our own cancellation. The same
  // controller aborts on unmount, which also removes the setState-after-unmount
  // warning.
  const loadCtrl = useRef<AbortController | null>(null)

  const load = async () => {
    loadCtrl.current?.abort()
    const ctrl = new AbortController()
    loadCtrl.current = ctrl
    setLoading(true)
    try {
      const rows = await adminApi.listTickets({
        status: statusFilter || undefined,
        category: categoryFilter || undefined,
      }, ctrl.signal)
      setTickets(rows)
    } catch (err) {
      if (isAbortError(err)) return
      onToast('err', err instanceof Error ? err.message : 'Load failed')
    } finally {
      // 只有仍是最新那一次才收起加载态：被中止的那次在这里把 loading 关掉，
      // 会让接替它的请求在途中却显示成「加载完了、但表是空的」。
      // Only the still-current request clears the loading flag: letting an
      // aborted one do it would show "loaded, but empty" while its replacement
      // is still in flight.
      if (loadCtrl.current === ctrl) setLoading(false)
    }
  }

  useEffect(() => { void load() }, [statusFilter, categoryFilter])
  useEffect(() => () => loadCtrl.current?.abort(), [])

  // 通知里的深链：?ticket=<id> 直接打开那条工单（新工单通知会带上）。参数打开后
  // 就抹掉，避免在页内退回列表后一刷新又被弹回详情。
  // Deep link from a notification: ?ticket=<id> opens that thread (the new-ticket
  // notification carries one). The param is cleared once used, so backing out to
  // the list and refreshing doesn't bounce back into the detail.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const id = searchParams.get('ticket')
    if (!id) return
    const next = new URLSearchParams(searchParams)
    next.delete('ticket')
    setSearchParams(next, { replace: true })
    adminApi.getTicket(id).then(setDetail).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const openDetail = async (id: string) => {
    try {
      setDetail(await adminApi.getTicket(id))
      setReplyText('')
      setReplyStatus('')
      setReplyPriority('')
      replyImages.clear()
    } catch (err) {
      onToast('err', err instanceof Error ? err.message : 'Load failed')
    }
  }

  const canSend = (!!replyText.trim() || replyImages.keys.length > 0) && !replyImages.uploading

  const sendReply = async () => {
    if (!canSend || !detail) return
    setSending(true)
    try {
      const updated = await adminApi.replyTicket(detail.id, replyText.trim(), {
        ...(replyStatus ? { status: replyStatus as TicketStatusValue } : {}),
        ...(replyPriority ? { priority: replyPriority as TicketPriority } : {}),
        images: replyImages.keys,
      })
      setDetail(updated)
      setReplyText('')
      replyImages.clear()
      setReplyStatus('')
      setReplyPriority('')
      onToast('ok', t('tickets.admin.replySent'))
      void load()
    } catch (err) {
      onToast('err', err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSending(false)
    }
  }

  const updateMeta = async (patch: { status?: TicketStatusValue; priority?: TicketPriority }) => {
    if (!detail) return
    try {
      setDetail(await adminApi.updateTicket(detail.id, patch))
      onToast('ok', t('tickets.admin.statusUpdated'))
      void load()
    } catch (err) {
      onToast('err', err instanceof Error ? err.message : 'Save failed')
    }
  }

  if (detail) {
    return (
      <div className="space-y-4">
        <button type="button" onClick={() => { replyImages.clear(); setDetail(null) }} className="adm-btn is-quiet">
          &larr; {t('tickets.backToList')}
        </button>

        <div className="adm-card overflow-hidden p-0">
          <header className="border-b border-[var(--line)] px-5 py-4 sm:px-6">
            <h2 className="font-display text-[18px] font-semibold leading-snug text-neutral-50">{detail.title}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <TicketStatus status={detail.status} label={t(`tickets.status.${detail.status}`)} />
              <span className={`adm-pill ${PRIORITY_PILL[detail.priority] ?? ''}`}>{t(`tickets.priority.${detail.priority}`)}</span>
              <span className="adm-pill">{t(`tickets.category.${detail.category}`)}</span>
              <span className="ml-auto truncate font-mono text-xs text-neutral-500">{detail.userEmail}</span>
            </div>
            <div className="adm-seg mt-4 w-max" role="group" aria-label={t('tickets.admin.colStatus')}>
              {STATUSES.map((s) => (
                <button key={s} type="button" aria-pressed={detail.status === s} className={detail.status === s ? 'is-on' : ''} onClick={() => void updateMeta({ status: s })}>
                  {t(`tickets.status.${s}`)}
                </button>
              ))}
            </div>
          </header>

          <div className="adm-well space-y-4 px-4 py-5 sm:px-6">
            {detail.replies.map((r) => {
              const fromStaff = r.authorRole !== 'user'
              const name = fromStaff && r.authorName ? r.authorName : r.authorEmail
              return (
                <div key={r.id} className={`flex gap-2.5 ${fromStaff ? 'flex-row-reverse' : ''}`}>
                  <Avatar name={name} size={28} tone={r.internal ? 'note' : fromStaff ? 'staff' : 'neutral'} />
                  <div className={`flex min-w-0 max-w-[85%] flex-col sm:max-w-[72%] ${fromStaff ? 'items-end' : 'items-start'}`}>
                    <div className={`mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1 text-[11px] text-neutral-500 ${fromStaff ? 'justify-end' : ''}`}>
                      <span className="max-w-full truncate font-medium text-neutral-300">{name}</span>
                      {fromStaff && <span className="adm-pill is-brand">{r.authorRole === 'support' ? t('supportDesk.role.support') : t('admin.staff')}</span>}
                      {/* 内部备注（rev 41）：用户永远看不到 / internal notes (rev 41): never user-visible */}
                      {r.internal && <span className="adm-pill is-warn">{t('supportDesk.thread.internalTag')}</span>}
                      {/* 统一走 api/utils 的格式化（固定 UTC+8）：裸 toLocaleString 按浏览器时区渲染，
                          欧美时区的管理员看到的时刻整段偏移，且没有任何后缀说明。
                          Formatted through api/utils (pinned to UTC+8): a bare toLocaleString
                          renders in the browser's zone with nothing saying which. */}
                      <span className="num">{fmtDate(r.createdAt)}</span>
                    </div>
                    <div
                      className={`rounded-[18px] px-3.5 py-2.5 ${
                        r.internal
                          ? 'rounded-tr-md border border-dashed border-amber-400/45 bg-amber-400/[0.07]'
                          : fromStaff
                            ? 'rounded-tr-md border border-[rgb(var(--purple-rgb)/0.38)] bg-[rgb(var(--purple-rgb)/0.2)]'
                            : 'rounded-tl-md bg-[var(--surface-2)]'
                      }`}
                    >
                      {r.body && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-neutral-100">{r.body}</p>}
                      <TicketImageGrid urls={r.images} count={r.imageCount} />
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="border-t border-[var(--line)] p-4 sm:p-5" {...replyImages.dropProps}>
            <div className="adm-composer">
              <textarea
                rows={3}
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                onPaste={replyImages.onPaste}
                placeholder={t('tickets.replyPlaceholder')}
                aria-label={t('tickets.replyPlaceholder')}
                maxLength={5000}
              />
              <div className="px-3 pb-2">
                <TicketImagePicker state={replyImages} disabled={sending} />
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-[var(--line)] px-3 py-2.5">
                <div className="adm-filter">
                  <span>{t('tickets.admin.colStatus')}</span>
                  <Select
                    value={replyStatus}
                    onChange={(v) => setReplyStatus(v as TicketStatusValue | '')}
                    openUpward
                    className="select-tight"
                    ariaLabel={t('tickets.admin.colStatus')}
                    options={[{ value: '', label: t('common.noChange') }, ...STATUSES.map((s) => ({ value: s, label: t(`tickets.status.${s}`) }))]}
                  />
                </div>
                <div className="adm-filter">
                  <span>{t('tickets.admin.colPriority')}</span>
                  <Select
                    value={replyPriority}
                    onChange={(v) => setReplyPriority(v as TicketPriority | '')}
                    openUpward
                    className="select-tight"
                    ariaLabel={t('tickets.admin.colPriority')}
                    options={[{ value: '', label: t('common.noChange') }, ...PRIORITIES.map((p) => ({ value: p, label: t(`tickets.priority.${p}`) }))]}
                  />
                </div>
                <button type="button" onClick={() => void sendReply()} className="adm-btn is-primary ml-auto" disabled={sending || !canSend}>
                  {sending ? t('common.loading') : replyImages.uploading ? t('tickets.images.uploading') : t('tickets.reply')}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="adm-toolbar">
        <div className="adm-filter">
          <span>{t('tickets.admin.colStatus')}</span>
          <Select
            value={statusFilter}
            onChange={setStatusFilter}
            ariaLabel={t('tickets.admin.colStatus')}
            options={[{ value: '', label: t('tickets.admin.all') }, ...STATUSES.map((s) => ({ value: s, label: t(`tickets.status.${s}`) }))]}
          />
        </div>
        <div className="adm-filter">
          <span>{t('tickets.admin.colCategory')}</span>
          <Select
            value={categoryFilter}
            onChange={setCategoryFilter}
            ariaLabel={t('tickets.admin.colCategory')}
            options={[{ value: '', label: t('tickets.admin.all') }, ...CATEGORIES.map((c) => ({ value: c, label: t(`tickets.category.${c}`) }))]}
          />
        </div>
        {!loading && (
          <div className="adm-toolbar-end">
            <span className="adm-count">{t('admin.console.ticketCount', { n: tickets.length })}</span>
          </div>
        )}
      </div>

      <div className="adm-card overflow-hidden p-0">
        {loading ? (
          <div className="flex flex-col gap-3 p-6">
            <SkeletonLine width="60%" height={14} />
            <SkeletonLine />
            <SkeletonLine width="75%" />
          </div>
        ) : tickets.length === 0 ? (
          <div className="adm-empty">
            <p className="adm-empty-title">{t('tickets.empty')}</p>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--line)]">
            {tickets.map((ticket, i) => (
              <li key={ticket.id} className="adm-rise" style={{ ['--i' as string]: Math.min(i, 12) }}>
                <button
                  type="button"
                  onClick={() => void openDetail(ticket.id)}
                  className="adm-row grid w-full grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3.5 gap-y-1 px-5 py-4 text-left sm:grid-cols-[auto_minmax(0,1fr)_auto]"
                >
                  <Avatar name={ticket.userEmail || ticket.title} size={34} />
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-medium text-neutral-50">{ticket.title}</span>
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-neutral-500">{ticket.userEmail || '-'}</span>
                    {ticket.latestReply && (
                      <span className="mt-1.5 block truncate text-xs text-neutral-400">
                        {ticket.latestReply.authorEmail}: {ticket.latestReply.body || t('tickets.images.preview')}
                      </span>
                    )}
                  </span>
                  <span className="col-start-2 flex flex-wrap items-center gap-2 sm:col-start-3 sm:flex-col sm:items-end">
                    <TicketStatus status={ticket.status} label={t(`tickets.status.${ticket.status}`)} />
                    <span className="flex items-center gap-1.5">
                      <span className="adm-pill">{t(`tickets.category.${ticket.category}`)}</span>
                      <span className={`adm-pill ${PRIORITY_PILL[ticket.priority] ?? ''}`}>{t(`tickets.priority.${ticket.priority}`)}</span>
                    </span>
                    {/* fmtDay 固定 UTC+8 / fmtDay pins UTC+8 */}
                    <span className="num text-[11px] text-neutral-500">{fmtDay(ticket.updatedAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
