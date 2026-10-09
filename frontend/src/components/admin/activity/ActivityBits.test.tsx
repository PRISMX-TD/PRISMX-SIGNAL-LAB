// 列表行的渲染冒烟：契约里每个例子（含 children）在电脑端一行、手机端一张卡都渲染得出来，
// 用户栏是「昵称 + 邮箱」（老板点名要邮箱），账号、谁操作、句子都在。用服务端渲染，不需要 DOM。
// Render smoke test for list rows: every contract example (children too) renders as a desktop
// row and a phone card, with the user column showing nickname + email (the owner asked for
// the email), plus the login, actor and sentence. Server-rendered, no DOM needed.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import type { ReactElement } from 'react'
import type { ActivityItem } from '../../../api/types'
import examples from './contractExamples.json'
import { DesktopRow, EmptyState, PhoneCard, type RowHandlers } from './ActivityBits'
import { actorLabel, renderEvent } from './renderEvent'
import { makeI18n } from './testT'

const EXAMPLES = (examples as unknown as ActivityItem[]).flatMap((i) => [i, ...(i.children ?? [])])
const handlers: RowHandlers = { onOpen: () => {}, onUser: () => {}, onLogin: () => {} }

// 标记里的文字：去标签、还原实体 / the markup's text: tags stripped, entities decoded
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')

describe.each(['zh', 'en'] as const)('%s 行渲染 / row rendering', (lang) => {
  const i18n = makeI18n(lang)
  const t = i18n.getFixedT(lang)
  const render = (el: ReactElement) => textOf(renderToStaticMarkup(<I18nextProvider i18n={i18n}>{el}</I18nextProvider>))

  for (const ex of EXAMPLES) {
    it(`${ex.kind} ${ex.key}`, () => {
      for (const Row of [DesktopRow, PhoneCard]) {
        const text = render(<Row item={ex} handlers={handlers} expanded={false} onToggle={() => {}} />)
        if (ex.user) {
          if (ex.user.email) expect(text).toContain(ex.user.email)
          if (ex.user.nickname) expect(text).toContain(ex.user.nickname)
        }
        if (ex.login) expect(text).toContain(ex.login)
        expect(text).toContain(actorLabel(ex, t))
        // 句子里的每一段文字都在（盈亏段格式化后也在）/ every sentence fragment is present
        expect(text.replace(/\s+/g, '')).toContain(renderEvent(ex, t).text.replace(/\s+/g, ''))
        expect(text).not.toMatch(/admin\.log\.|\{\{/)
      }
    })
  }

  it('合并行有「展开」，展开后变「收起」/ merged rows offer expand, then collapse', () => {
    const merged = EXAMPLES.find((e) => e.kind === 'trade.close_all')!
    const closed = render(<DesktopRow item={merged} handlers={handlers} expanded={false} onToggle={() => {}} />)
    const open = render(<DesktopRow item={merged} handlers={handlers} expanded onToggle={() => {}} />)
    expect(closed).toContain(t('admin.log.expand', { n: merged.children!.length }))
    expect(open).toContain(t('admin.log.collapse'))
  })

  it('已解绑 / 授权失效的账号带文字小标签 / unlinked and revoked accounts carry text tags', () => {
    const base = EXAMPLES.find((e) => e.kind === 'trade.open' && e.login && e.account)!
    const withAcct = (removed: boolean, revoked: boolean): ActivityItem => ({ ...base, account: { ...base.account!, removed, revoked } })
    for (const Row of [DesktopRow, PhoneCard]) {
      const plain = render(<Row item={withAcct(false, false)} handlers={handlers} />)
      expect(plain).not.toContain(t('admin.log.acct.removed'))
      expect(plain).not.toContain(t('admin.log.acct.revoked'))
      const removed = render(<Row item={withAcct(true, false)} handlers={handlers} />)
      expect(removed).toContain(t('admin.log.acct.removed'))
      expect(removed).not.toContain(t('admin.log.acct.revoked'))
      const both = render(<Row item={withAcct(true, true)} handlers={handlers} />)
      expect(both).toContain(t('admin.log.acct.removed'))
      expect(both).toContain(t('admin.log.acct.revoked'))
    }
    if (lang === 'zh') {
      expect(render(<DesktopRow item={withAcct(true, false)} handlers={handlers} />)).toContain('已解绑')
      expect(render(<PhoneCard item={withAcct(false, true)} handlers={handlers} />)).toContain('授权失效')
    }
  })

  it('批量修改显示「N 位用户」，平台设置显示「—（平台设置）」/ bulk shows N users, platform rows a dash', () => {
    const bulk = EXAMPLES.find((e) => e.kind === 'admin.bulk_edit')!
    expect(render(<DesktopRow item={bulk} handlers={handlers} />)).toContain(t('admin.log.user.count', { count: bulk.users_count ?? 0 }))
    const setting = EXAMPLES.find((e) => e.kind === 'admin.setting')!
    expect(render(<PhoneCard item={setting} handlers={handlers} />)).toContain(t('admin.log.user.platform'))
  })
})

describe('空状态 / empty state', () => {
  const i18n = makeI18n('zh')
  const t = i18n.getFixedT('zh')
  const render = (el: ReactElement) => textOf(renderToStaticMarkup(<I18nextProvider i18n={i18n}>{el}</I18nextProvider>))

  it('普通搜索：通用的「没有符合条件的记录」/ a plain search: the generic empty message', () => {
    const text = render(<EmptyState loginQuery={null} phoneUsers={null} onPickUser={() => {}} />)
    expect(text).toContain(t('admin.log.empty'))
  })

  it('纯数字：明说按 MT5 账号和手机号都查过了，并提示手机号要带「+」/ digits: says it searched logins and phones, and how to search a phone', () => {
    const text = render(<EmptyState loginQuery="13800138000" phoneUsers={[]} onPickUser={() => {}} />)
    expect(text).toContain('没有 MT5 账号或手机号是 13800138000 的记录')
    expect(text).toContain('带上「+」和区号')
    expect(text).not.toContain(t('admin.log.empty'))
  })

  it('手机号对得上的用户列出来，可以点 / users whose phone matches are listed as buttons', () => {
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={i18n}>
        <EmptyState loginQuery="13800138000" phoneUsers={[{ id: 'u1', nickname: '美琳', email: 'meilin@example.com' }]} onPickUser={() => {}} />
      </I18nextProvider>,
    )
    expect(textOf(html)).toContain(t('admin.log.phoneHits'))
    expect(html).toMatch(/<button[^>]*>美琳 · meilin@example\.com<\/button>/)
  })
})
