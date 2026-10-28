// 工单会话里工作人员共用的小工具（2026-10-28）：客服后台的会话与管理端的工单详情都用。
// - fillTemplate：快捷回复里的 {nickname} / {email} / {ticket} 换成这张工单的值；
// - TicketMetaEditor：改分类、改标题（客服也能改，后端 PATCH /admin/tickets/{id} 记审计）；
// - SaveTemplateButton：把回复框里写好的话存成快捷回复（admin 与内部客服，外包不显示）。
// Small staff tools for a ticket thread (2026-10-28), used by the support desk thread and the
// admin ticket detail:
// - fillTemplate: swaps {nickname} / {email} / {ticket} in a canned reply for this ticket's values;
// - TicketMetaEditor: change category and title (agents too; the backend PATCH audits it);
// - SaveTemplateButton: save the composer's text as a canned reply (admins and internal agents).
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi, adminSupportApi, supportApi } from '../../api/client'
import type { Ticket, TicketCategory } from '../../api/types'
import Select from '../Select'
import { errText } from './supportUi'

export const TICKET_CATEGORIES: TicketCategory[] = ['account', 'payment', 'claim', 'technical', 'feature', 'follow_up']

export function fillTemplate(body: string, ticket: Pick<Ticket, 'userEmail' | 'title' | 'userNickname'> | null): string {
  if (!ticket) return body
  const nickname = ticket.userNickname || (ticket.userEmail || '').split('@')[0] || ''
  return body
    .replace(/\{nickname\}/g, nickname)
    .replace(/\{email\}/g, ticket.userEmail || '')
    .replace(/\{ticket\}/g, ticket.title || '')
}

export function TicketMetaEditor({
  ticket,
  onSaved,
  onToast,
  inputClass = 'adm-input',
}: {
  ticket: Ticket
  onSaved: (next: Ticket) => void
  onToast: (kind: 'ok' | 'err', text: string) => void
  inputClass?: string
}) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(ticket.title)
  const [busy, setBusy] = useState(false)

  const patch = async (p: { category?: TicketCategory; title?: string }, okMsg: string) => {
    setBusy(true)
    try {
      onSaved(await adminApi.updateTicket(ticket.id, p))
      onToast('ok', okMsg)
      setEditing(false)
    } catch (err) {
      onToast('err', errText(err, t('common.error')))
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <div className="flex w-full flex-wrap items-center gap-2">
        <input
          className={`${inputClass} min-w-0 flex-1`}
          value={title}
          maxLength={200}
          autoFocus
          aria-label={t('supportDesk.ticketEdit.editTitle')}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && title.trim()) void patch({ title: title.trim() }, t('supportDesk.ticketEdit.titleSaved'))
            if (e.key === 'Escape') setEditing(false)
          }}
        />
        <button
          type="button"
          className="btn btn-primary h-8 px-3 text-xs"
          disabled={busy || !title.trim() || title.trim() === ticket.title}
          onClick={() => void patch({ title: title.trim() }, t('supportDesk.ticketEdit.titleSaved'))}
        >
          {t('supportDesk.ticketEdit.save')}
        </button>
        <button type="button" className="btn btn-ghost h-8 px-3 text-xs" onClick={() => setEditing(false)}>
          {t('supportDesk.ticketEdit.cancel')}
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Select
        value={ticket.category}
        onChange={(v) => v !== ticket.category && void patch({ category: v as TicketCategory }, t('supportDesk.ticketEdit.categorySaved'))}
        className="select-tight"
        ariaLabel={t('supportDesk.ticketEdit.category')}
        options={TICKET_CATEGORIES.map((c) => ({ value: c, label: t(`tickets.category.${c}`) }))}
      />
      <button
        type="button"
        className="rounded-full border border-[var(--line-hi)] px-2.5 py-1 text-[11px] text-neutral-300 transition hover:bg-white/[0.05]"
        onClick={() => {
          setTitle(ticket.title)
          setEditing(true)
        }}
      >
        {t('supportDesk.ticketEdit.editTitle')}
      </button>
    </div>
  )
}

export function SaveTemplateButton({
  body,
  admin,
  onSaved,
  onToast,
}: {
  body: string
  // 管理员走 /admin/support/templates，内部客服走 /support/templates / admins vs internal agents
  admin: boolean
  onSaved?: () => void
  onToast: (kind: 'ok' | 'err', text: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  if (!body.trim()) return null

  const save = async () => {
    if (!title.trim()) return
    setBusy(true)
    try {
      const tpl = { title: title.trim(), body: body.trim(), lang: null }
      if (admin) {
        await adminSupportApi.createTemplate(tpl)
      } else {
        await supportApi.createTemplate(tpl)
      }
      onToast('ok', t('supportDesk.ticketEdit.templateSaved'))
      setOpen(false)
      setTitle('')
      onSaved?.()
    } catch (err) {
      onToast('err', errText(err, t('common.error')))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button type="button" className="text-[11px] font-medium text-[var(--purple-hi)] hover:underline" onClick={() => setOpen(true)}>
        {t('supportDesk.ticketEdit.saveTemplate')}
      </button>
    )
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        className="h-7 w-40 rounded-lg border border-[var(--line-hi)] bg-transparent px-2 text-[11px] text-neutral-100 outline-none placeholder:text-neutral-500"
        placeholder={t('supportDesk.ticketEdit.templateTitle')}
        aria-label={t('supportDesk.ticketEdit.templateTitle')}
        maxLength={100}
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            void save()
          }
          if (e.key === 'Escape') setOpen(false)
        }}
      />
      <button type="button" className="text-[11px] font-semibold text-[var(--purple-hi)] disabled:opacity-50" disabled={busy || !title.trim()} onClick={() => void save()}>
        {t('supportDesk.ticketEdit.save')}
      </button>
      <button type="button" className="text-[11px] text-neutral-500" onClick={() => setOpen(false)}>
        {t('supportDesk.ticketEdit.cancel')}
      </button>
    </span>
  )
}
