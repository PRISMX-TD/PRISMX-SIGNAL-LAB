// holdDocumentTitle：公开比赛页卸载时把标签页标题还原成进来之前的（→ /login 不再挂着比赛名）。
// holdDocumentTitle: the public competition page restores the previous tab title on unmount.
import { describe, expect, it } from 'vitest'
import { holdDocumentTitle } from './useDocumentTitle'

describe('holdDocumentTitle', () => {
  it('restores the title captured before the page changed it', () => {
    const doc = { title: 'Signal Lab' }
    const restore = holdDocumentTitle(doc)
    doc.title = '秋季模拟赛 · Signal Lab'
    doc.title = '秋季模拟赛（更新）· Signal Lab'
    restore()
    expect(doc.title).toBe('Signal Lab')
  })
})
