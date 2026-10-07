import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { isoToLocalInput, localInputToIso } from './CompetitionsPanel'

// 固定在 UTC+8 跑：在 UTC 环境下裸 new Date 的 bug 不会暴露。
// Pin to UTC+8: in a UTC environment the bare-new-Date bug would not show.
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env
let prevTz: string | undefined

beforeAll(() => {
  prevTz = env.TZ
  env.TZ = 'Asia/Shanghai'
})

afterAll(() => {
  if (prevTz === undefined) delete env.TZ
  else env.TZ = prevTz
})

describe('isoToLocalInput / localInputToIso', () => {
  it('时区确实切到了 UTC+8 / TZ is actually UTC+8', () => {
    expect(new Date(2026, 9, 7).getTimezoneOffset()).toBe(-480)
  })

  it('后端 naive UTC 按 UTC 解释 / naive backend time is read as UTC', () => {
    expect(isoToLocalInput('2026-10-07T12:00:00')).toBe('2026-10-07T20:00')
    expect(isoToLocalInput('2026-10-07T12:00:00Z')).toBe('2026-10-07T20:00')
  })

  it('加载后原样保存是同一时刻 / load then save unchanged keeps the instant', () => {
    for (const iso of ['2026-10-07T12:00:00', '2026-10-07T12:00:00Z', '2026-12-31T23:30:00+00:00']) {
      const saved = localInputToIso(isoToLocalInput(iso))
      expect(saved).toBe(`${iso.slice(0, 16)}:00.000Z`)
    }
  })

  it('空值 / 坏值 / empty and invalid', () => {
    expect(isoToLocalInput(null)).toBe('')
    expect(isoToLocalInput('garbage')).toBe('')
    expect(localInputToIso('')).toBeNull()
  })
})
