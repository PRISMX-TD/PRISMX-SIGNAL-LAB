// 滚动锁的引用计数：嵌套弹层只在最后一个关闭时还原；同一个释放函数调两次不会多减。
// Scroll-lock reference counting: nested sheets restore only when the last one closes;
// calling the same release twice does not over-decrement. No jsdom: a plain stub root.
import { describe, expect, it } from 'vitest'
import { lockScroll } from './scrollLock'

const fakeRoot = (overflow = '') => ({ style: { overflow } })

describe('lockScroll', () => {
  it('locks and restores the empty inline value', () => {
    const root = fakeRoot()
    const release = lockScroll(root)
    expect(root.style.overflow).toBe('hidden')
    release()
    expect(root.style.overflow).toBe('')
  })

  it('restores a previous inline value', () => {
    const root = fakeRoot('scroll')
    const release = lockScroll(root)
    expect(root.style.overflow).toBe('hidden')
    release()
    expect(root.style.overflow).toBe('scroll')
  })

  it('stays locked until the last nested lock is released', () => {
    const root = fakeRoot()
    const a = lockScroll(root)
    const b = lockScroll(root)
    a()
    expect(root.style.overflow).toBe('hidden')
    b()
    expect(root.style.overflow).toBe('')
  })

  it('ignores a second call of the same release', () => {
    const root = fakeRoot()
    const a = lockScroll(root)
    a()
    a()
    const b = lockScroll(root)
    expect(root.style.overflow).toBe('hidden')
    b()
    expect(root.style.overflow).toBe('')
  })
})
