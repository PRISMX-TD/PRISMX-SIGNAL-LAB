import { describe, expect, it } from 'vitest'
import { intersects, merge, inflate, type Box } from './layout'

const row = (i: number): Box => ({ x: 0, y: i * 20, w: 300, h: 16 })

describe('festival layout merge', () => {
  it('merges touching boxes and leaves distant ones apart', () => {
    const out = merge([row(0), row(1), { x: 1000, y: 0, w: 10, h: 10 }])
    expect(out).toHaveLength(2)
    expect(out.find((b) => b.x === 0)).toEqual({ x: 0, y: 0, w: 300, h: 36 })
  })

  it('returns mutually non-touching blocks', () => {
    const boxes: Box[] = []
    for (let i = 0; i < 200; i++) boxes.push({ x: (i * 37) % 900, y: (i * 53) % 700, w: 20 + (i % 7) * 9, h: 12 })
    const out = merge(boxes)
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) expect(intersects(inflate(out[i], 10), out[j])).toBe(false)
  })

  // 表格式内容：几千行一行挨一行。原实现每并一次就从头再比，是 O(n³)，这里会跑上好几秒。
  // Table-like content: thousands of stacked rows. The old restart-from-zero merge was
  // O(n³) and took seconds here.
  it('handles thousands of stacked rows quickly', () => {
    const rows: Box[] = []
    for (let i = 3000; i > 0; i--) rows.push(row(i))
    const t0 = performance.now()
    const out = merge(rows)
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(out).toHaveLength(1)
  })
})
