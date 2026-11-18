// 「客服来信」(follow_up) 分类只有管理员能改（后端对客服回 403）：客服的改分类下拉里没有这一项，
// 已经是客服来信的工单分类直接锁住（2026-11-18 审计）。
// Only admins may move tickets into or out of follow_up (the backend 403s agents): agents
// don't get the option, and a ticket that already is one shows a locked category.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import type { Ticket } from '../../api/types'
import { makeI18n } from '../admin/activity/testT'
import { TicketMetaEditor, editableCategories } from './ticketTools'

const ticket = (category: Ticket['category']) => ({ id: 't1', title: 'x', category }) as unknown as Ticket

const render = (category: Ticket['category'], canEditFollowUp: boolean) =>
  renderToStaticMarkup(
    <I18nextProvider i18n={makeI18n('zh')}>
      <TicketMetaEditor ticket={ticket(category)} onSaved={() => {}} onToast={() => {}} canEditFollowUp={canEditFollowUp} />
    </I18nextProvider>,
  )

describe('ticket category editor and follow_up', () => {
  it('agents are not offered follow_up; admins are', () => {
    expect(editableCategories(false)).not.toContain('follow_up')
    expect(editableCategories(true)).toContain('follow_up')
    expect(editableCategories(false)).toHaveLength(editableCategories(true).length - 1)
  })

  it('a follow_up ticket is locked for agents but editable for admins', () => {
    expect(render('follow_up', false)).not.toContain('aria-haspopup')
    expect(render('follow_up', false)).toContain('客服来信')
    expect(render('follow_up', true)).toContain('aria-haspopup')
    expect(render('account', false)).toContain('aria-haspopup')
  })
})
