// #root 显隐只由栈顶决定：栈顶在 #root 外 → aria-hidden；在 #root 里或栈空 → 撤掉。
// #root visibility is decided by the top entry only.
import { describe, expect, it } from 'vitest'
import { isTopDialog, popDialog, pushDialog, settleFocus, type AppRoot, type FocusTarget } from './dialogStack'

function fakeApp(inside: unknown[]) {
  const attrs = new Map<string, string>()
  const app: AppRoot = {
    contains: (o) => inside.includes(o),
    setAttribute: (n, v) => { attrs.set(n, v) },
    removeAttribute: (n) => { attrs.delete(n) },
  }
  return { app, hidden: () => attrs.get('aria-hidden') === 'true' }
}

describe('dialogStack', () => {
  it('hides #root while a portalled dialog is open and restores it on close', () => {
    const portal = {}
    const { app, hidden } = fakeApp([])
    const id = pushDialog(portal, app)
    expect(hidden()).toBe(true)
    expect(isTopDialog(id)).toBe(true)
    popDialog(id, app)
    expect(hidden()).toBe(false)
    expect(isTopDialog(id)).toBe(false)
  })

  it('never hides #root for a dialog rendered inside it', () => {
    const sheet = {}
    const { app, hidden } = fakeApp([sheet])
    const id = pushDialog(sheet, app)
    expect(hidden()).toBe(false)
    popDialog(id, app)
    expect(hidden()).toBe(false)
  })

  it('follows the topmost dialog when they nest', () => {
    const sheet = {}
    const confirm = {}
    const { app, hidden } = fakeApp([sheet])
    const a = pushDialog(sheet, app)
    expect(hidden()).toBe(false)
    const b = pushDialog(confirm, app)
    expect(hidden()).toBe(true)
    expect(isTopDialog(b)).toBe(true)
    expect(isTopDialog(a)).toBe(false)
    popDialog(b, app)
    expect(hidden()).toBe(false)
    expect(isTopDialog(a)).toBe(true)
    popDialog(a, app)
    expect(hidden()).toBe(false)
  })

  it('stays hidden until the last portalled dialog closes, whatever the close order', () => {
    const one = {}
    const two = {}
    const { app, hidden } = fakeApp([])
    const a = pushDialog(one, app)
    const b = pushDialog(two, app)
    popDialog(a, app)
    expect(hidden()).toBe(true)
    popDialog(b, app)
    expect(hidden()).toBe(false)
  })

  it('tolerates a missing #root and unknown ids', () => {
    const id = pushDialog({}, null)
    expect(() => popDialog(id, null)).not.toThrow()
    expect(() => popDialog(999999, null)).not.toThrow()
  })
})

// 入栈前焦点必须已离开 #root（否则 Chrome 拦下 aria-hidden）/ focus must leave #root before the push
describe('settleFocus', () => {
  function fakeDialog(focusable: boolean, doc: { activeElement: unknown }) {
    const attrs = new Map<string, string>()
    const inner = {}
    const dlg: FocusTarget = {
      contains: (o) => o === dlg || o === inner,
      focus: () => { if (focusable) doc.activeElement = dlg },
      hasAttribute: (n) => attrs.has(n),
      setAttribute: (n, v) => { attrs.set(n, v) },
    }
    return { dlg, inner, attrs }
  }

  it('leaves focus alone when it is already inside the dialog', () => {
    const doc = { activeElement: null as unknown }
    const { dlg, inner, attrs } = fakeDialog(true, doc)
    doc.activeElement = inner
    settleFocus(dlg, doc)
    expect(doc.activeElement).toBe(inner)
    expect(attrs.has('tabindex')).toBe(false)
  })

  it('falls back to the container when the first target did not take focus', () => {
    let blurred = false
    const doc = { activeElement: { blur: () => { blurred = true } } as unknown }
    const { dlg, attrs } = fakeDialog(true, doc)
    settleFocus(dlg, doc)
    expect(doc.activeElement).toBe(dlg)
    expect(attrs.get('tabindex')).toBe('-1')
    expect(blurred).toBe(false)
  })

  it('drops the old focus when even the container cannot be focused', () => {
    let blurred = false
    const doc = { activeElement: { blur: () => { blurred = true } } as unknown }
    const { dlg } = fakeDialog(false, doc)
    settleFocus(dlg, doc)
    expect(blurred).toBe(true)
  })
})
