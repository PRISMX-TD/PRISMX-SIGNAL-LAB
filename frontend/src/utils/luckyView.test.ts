import { describe, expect, it } from 'vitest'
import { isWheelClosed } from './luckyView'

const round = (phase: 'none' | 'upcoming' | 'active' | 'ended') => ({ id: 'r', startsAt: '', endsAt: '', phase })

describe('isWheelClosed', () => {
  it('is closed when the switch is off, there is no round, or the round is none / ended', () => {
    expect(isWheelClosed({ visible: false, round: null })).toBe(true)
    expect(isWheelClosed({ visible: true, round: null })).toBe(true)
    expect(isWheelClosed({ visible: true, round: round('none') })).toBe(true)
    expect(isWheelClosed({ visible: true, round: round('ended') })).toBe(true)
    expect(isWheelClosed({ visible: false, round: round('active') })).toBe(true)
  })

  it('is open for upcoming and active rounds', () => {
    expect(isWheelClosed({ visible: true, round: round('upcoming') })).toBe(false)
    expect(isWheelClosed({ visible: true, round: round('active') })).toBe(false)
  })
})
