import { describe, expect, it } from 'vitest'
import { joinAlpha, splitAlpha } from './ColorPicker'
import { withAlpha } from '../draw/paint'

describe('colour + opacity in one string', () => {
  it('keeps 6-digit colours at full opacity and round-trips 8-digit ones', () => {
    expect(splitAlpha('#22d3ee')).toEqual({ color: '#22d3ee', opacity: 100 })
    expect(joinAlpha('#22d3ee', 100)).toBe('#22d3ee')
    expect(joinAlpha('#22D3EE', 50)).toBe('#22d3ee80')
    expect(splitAlpha('#22d3ee80')).toEqual({ color: '#22d3ee', opacity: 50 })
  })
  it('withAlpha multiplies an existing alpha instead of ignoring it', () => {
    expect(withAlpha('#22d3ee', 0.5)).toBe('#22d3ee80')
    expect(withAlpha('#22d3ee80', 0.5)).toBe('#22d3ee40')
  })
})
