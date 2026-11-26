// 交易时段换算的单测（阶段 6）/ unit tests for the session conversion (phase 6)
import { describe, expect, it } from 'vitest'
import { convertSessions, fmtMin } from './symbolMeta'

const H = 60
describe('convertSessions', () => {
  it('keeps sessions when the chart is in server time', () => {
    expect(convertSessions([{ day: 1, open: 1 * H, close: 23 * H }], 2 * 3600, 2 * H)).toEqual([{ day: 1, from: 60, to: 1380 }])
  })
  it('shifts server time (UTC+2) to the chart timezone (UTC+8)', () => {
    // 周一 01:00–23:00 服务器 = 周一 07:00 到周二 05:00 / Mon 01:00–23:00 server = Mon 07:00 – Tue 05:00
    expect(convertSessions([{ day: 1, open: 1 * H, close: 23 * H }], 2 * 3600, 8 * H)).toEqual([
      { day: 1, from: 7 * H, to: 1440 },
      { day: 2, from: 0, to: 5 * H },
    ])
  })
  it('wraps Sunday back into Saturday and merges touching parts', () => {
    const out = convertSessions([{ day: 0, open: 0, close: 2 * H }, { day: 6, open: 22 * H, close: 1440 }], 0, -3 * H)
    expect(out).toEqual([{ day: 6, from: 19 * H, to: 23 * H }])
  })
  it('drops junk rows', () => {
    expect(convertSessions([{ day: 9, open: 0, close: 10 }, { day: 1, open: 50, close: 50 }], 0, 0)).toEqual([])
  })
  it('formats minutes', () => {
    expect(fmtMin(0)).toBe('00:00')
    expect(fmtMin(605)).toBe('10:05')
  })
})
