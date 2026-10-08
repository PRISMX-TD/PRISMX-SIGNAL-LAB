// 比赛时钟 / 状态标签的纯函数（从 CompetitionsPage 抽出，公开页与站内页共用）。
// Pure competition clock / status-tag helpers shared by the public and in-app pages.
import { describe, expect, it } from 'vitest'
import type { TFunction } from 'i18next'
import { bugReadout, clockOf, countdownOf, fmtRange, statusTagKey, type CompTiming } from './compClock'

const t = ((k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k)) as unknown as TFunction
const NOW = Date.parse('2026-10-10T00:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const MIN = 60_000

function comp(over: Partial<CompTiming> = {}): CompTiming {
  return {
    status: 'upcoming',
    enrollment: 'signup',
    startsAt: iso(NOW + 2 * 1440 * MIN + 3 * 60 * MIN + 4 * MIN + 30_000),
    endsAt: iso(NOW + 10 * 1440 * MIN),
    regOpensAt: iso(NOW - 1440 * MIN),
    regClosesAt: iso(NOW + 1440 * MIN),
    ...over,
  }
}

describe('statusTagKey', () => {
  it('narrows upcoming + open signup window to regOpen', () => {
    expect(statusTagKey(comp(), NOW)).toBe('regOpen')
  })
  it('keeps upcoming when the window is not open yet', () => {
    expect(statusTagKey(comp({ regOpensAt: iso(NOW + MIN) }), NOW)).toBe('upcoming')
  })
  it('maps ended to finished and copies the rest', () => {
    expect(statusTagKey(comp({ status: 'ended' }), NOW)).toBe('finished')
    expect(statusTagKey(comp({ status: 'running' }), NOW)).toBe('running')
    expect(statusTagKey(comp({ status: 'settled' }), NOW)).toBe('settled')
  })
})

describe('clockOf', () => {
  it('splits time-to-start into d/h/m', () => {
    expect(clockOf(comp(), NOW, t)).toEqual({
      label: 'competition.cd.toStart',
      parts: [{ unit: 'd', value: 2 }, { unit: 'h', value: 3 }, { unit: 'm', value: 4 }],
    })
  })
  it('uses two cells under a day and targets the end once started', () => {
    const c = comp({ status: 'running', startsAt: iso(NOW - MIN), endsAt: iso(NOW + 5 * 60 * MIN + 7 * MIN + 30_000) })
    expect(clockOf(c, NOW, t)).toEqual({ label: 'competition.cd.toEnd', parts: [{ unit: 'h', value: 5 }, { unit: 'm', value: 7 }] })
  })
  it('returns parts=null inside the last minute and null once over', () => {
    expect(clockOf(comp({ startsAt: iso(NOW + 30_000) }), NOW, t)).toEqual({ label: 'competition.cd.toStart', parts: null })
    expect(clockOf(comp({ status: 'settled' }), NOW, t)).toBeNull()
    expect(clockOf(comp({ status: 'running', startsAt: iso(NOW - 2 * MIN), endsAt: iso(NOW - MIN) }), NOW, t)).toBeNull()
  })
})

describe('countdownOf', () => {
  it('formats via fmtCountdown with the right label', () => {
    expect(countdownOf(comp(), NOW, t)).toEqual({ label: 'competition.cd.toStart', value: 'competition.cd.dh:{"d":2,"h":3}' })
    expect(countdownOf(comp({ status: 'ended' }), NOW, t)).toBeNull()
  })
})

describe('bugReadout / fmtRange', () => {
  it('always renders DD:HH:MM', () => {
    expect(bugReadout([{ unit: 'h', value: 5 }, { unit: 'm', value: 7 }])).toBe('00:05:07')
    expect(bugReadout([{ unit: 'd', value: 12 }, { unit: 'h', value: 0 }, { unit: 'm', value: 9 }])).toBe('12:00:09')
  })
  it('renders a dash for a missing end and tags the zone', () => {
    expect(fmtRange({ startsAt: null, endsAt: null })).toBe('— → — UTC+8')
  })
})
