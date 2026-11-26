import { describe, expect, it } from 'vitest'
import type { IndDef, IndInstance } from '../ind/types'
import { barChange, indicatorRows } from './dataWindowRows'

const candle = { up: '#2ee07e', down: '#ff4d67' }
const row = (o: Partial<{ o: number; c: number; prev: number | null }>) => ({ t: 1, o: 10, h: 12, l: 9, c: 11, v: 5, prev: 10, hovering: false, ...o })

describe('barChange', () => {
  it('is relative to the previous close', () => {
    const r = barChange(row({ c: 11, prev: 10 }))!
    expect(r.chg).toBeCloseTo(1)
    expect(r.pct).toBeCloseTo(10)
  })
  it('falls back to the open without a previous bar', () => {
    const r = barChange(row({ o: 20, c: 19, prev: null }))!
    expect(r.chg).toBeCloseTo(-1)
    expect(r.pct).toBeCloseTo(-5)
  })
  it('handles no row and a zero base', () => {
    expect(barChange(null)).toBeNull()
    expect(barChange(row({ prev: 0, c: 1 }))!.pct).toBeNull()
  })
})

const def: IndDef = {
  id: 'fake', abbr: 'FK', group: 'momentum', overlay: false, inputs: [],
  plots: [
    { key: 'a', kind: 'line', color: '#112233', label: 'A' },
    { key: 'h', kind: 'hist', color: 'up', colors: ['up', 'down'], label: 'H' },
    { key: 'n', kind: 'line', color: '#445566', label: 'N', noLegend: true },
    { key: 'g', kind: 'line', color: '#778899', label: 'G', gaps: true },
  ],
  compute: () => ({}),
}
const inst = (o: Partial<IndInstance> = {}): IndInstance => ({ uid: 'u1', type: 'fake', inputs: {}, styles: {}, pane: 'p1', ...o })

describe('indicatorRows', () => {
  it('lists visible legend plots with values and resolved colours', () => {
    const [r] = indicatorRows([inst()], { u1: { a: 1.5, h: -2, n: 9, g: null } }, candle, () => def)
    expect(r.plots.map((p) => p.key)).toEqual(['a', 'h'])
    expect(r.plots[0]).toMatchObject({ value: 1.5, color: '#112233' })
    // 多色柱按正负取色：负值用最后一个颜色 / multi-colour plots: negative takes the last colour
    expect(r.plots[1]).toMatchObject({ value: -2, color: candle.down })
  })
  it('keeps hidden instances as a name only and skips style-hidden plots and unknown types', () => {
    const rows = indicatorRows(
      [inst({ hidden: true }), inst({ uid: 'u2', styles: { a: { visible: false } } }), inst({ uid: 'u3', type: 'gone' })],
      { u2: { a: 1, h: 3, g: 4 } },
      candle,
      (t) => (t === 'fake' ? def : undefined),
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ uid: 'u1', hidden: true, plots: [] })
    expect(rows[1].plots.map((p) => [p.key, p.value, p.color])).toEqual([['h', 3, candle.up], ['g', 4, '#778899']])
  })
})
