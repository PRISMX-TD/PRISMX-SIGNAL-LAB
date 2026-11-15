// 读屏播报：先清空再隔 50ms 写入；同一句话连说两次也会重新写；没登记区域时不报错。
// Announcements: clear, then write 50ms later; an identical line is re-written; no region is a no-op.
// jsdom isn't installed, so a live region is a bare { textContent } stub.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { announce, registerLiveRegion } from './announce'

const region = () => ({ textContent: '' }) as unknown as HTMLElement

describe('announce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    registerLiveRegion('polite', null)
    registerLiveRegion('assertive', null)
    vi.useRealTimers()
  })

  it('先清空，50ms 后写进对应的区域，另一个区域不动', () => {
    const polite = region()
    const assertive = region()
    registerLiveRegion('polite', polite)
    registerLiveRegion('assertive', assertive)
    polite.textContent = 'old'
    announce('已成交 @ 2650.10', 'polite')
    expect(polite.textContent).toBe('')
    vi.advanceTimersByTime(50)
    expect(polite.textContent).toBe('已成交 @ 2650.10')
    expect(assertive.textContent).toBe('')
  })

  it('同一句话连说两次：第二次也先清空再写回', () => {
    const el = region()
    registerLiveRegion('assertive', el)
    announce('下单被拒绝：No money', 'assertive')
    vi.advanceTimersByTime(50)
    announce('下单被拒绝：No money', 'assertive')
    expect(el.textContent).toBe('')
    vi.advanceTimersByTime(50)
    expect(el.textContent).toBe('下单被拒绝：No money')
  })

  it('连续两句只留最后一句', () => {
    const el = region()
    registerLiveRegion('polite', el)
    announce('一', 'polite')
    announce('二', 'polite')
    vi.advanceTimersByTime(50)
    expect(el.textContent).toBe('二')
  })

  it('没有登记区域时什么都不做', () => {
    expect(() => announce('x')).not.toThrow()
  })
})
