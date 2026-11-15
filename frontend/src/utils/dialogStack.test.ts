// #root 显隐只由栈顶决定：栈顶在 #root 外 → aria-hidden；在 #root 里或栈空 → 撤掉。
// #root visibility is decided by the top entry only.
import { describe, expect, it } from 'vitest'
import { isTopDialog, popDialog, pushDialog, type AppRoot } from './dialogStack'

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
