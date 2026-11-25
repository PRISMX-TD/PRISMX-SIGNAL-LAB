import { describe, expect, it } from 'vitest'
import { olderBarsChanged, tailHasHole } from './tailRepair'

const bar = (t: number, p: number, h = p, l = p, c = p) => ({ t, o: p, h, l, c, v: 0 })

describe('tailHasHole', () => {
  it('flags a gap after the last server-confirmed bar even when local fake bars fill it', () => {
    // 服务器确认到 15:05（900），本地凭过期报价开到了 15:35；回来后轮询返回 15:35 / 15:40
    expect(tailHasHole(900, 900 + 6 * 300, 300)).toBe(true)
  })
  it('accepts the normal [previous, forming] poll response', () => {
    expect(tailHasHole(900, 900, 300)).toBe(false)
    expect(tailHasHole(900, 1200, 300)).toBe(false)
  })
  it('does nothing without a spacing, a confirmed bar or a response', () => {
    expect(tailHasHole(900, 9999, null)).toBe(false)
    expect(tailHasHole(0, 9999, 300)).toBe(false)
    expect(tailHasHole(900, undefined, 300)).toBe(false)
  })
})

describe('olderBarsChanged', () => {
  const local = [bar(0, 10), bar(300, 11), bar(600, 11), bar(900, 11)]
  it('is false when older response bars match the local copy', () => {
    expect(olderBarsChanged(local, [bar(600, 11), bar(900, 12)], 900)).toBe(false)
  })
  it('is true when an older bar was a local flat fake the server now corrects', () => {
    expect(olderBarsChanged(local, [bar(600, 11, 14, 9, 13), bar(900, 12)], 900)).toBe(true)
  })
  it('is true when an older response bar is missing locally', () => {
    expect(olderBarsChanged([bar(0, 10), bar(900, 11)], [bar(600, 11), bar(900, 11)], 900)).toBe(true)
  })
  it('ignores bars at or after the local last time (those go through update())', () => {
    expect(olderBarsChanged(local, [bar(900, 99), bar(1200, 99)], 900)).toBe(false)
  })
})
