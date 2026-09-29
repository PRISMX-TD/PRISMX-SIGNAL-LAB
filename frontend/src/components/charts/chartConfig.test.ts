// 图表轮询的边界补拉时刻：只认 epoch 对齐的 1/5/15/60 分钟周期，边界后等 EA 推送再拉。
// Boundary catch-up timing: only epoch-aligned 1/5/15/60-minute intervals; wait for the EA push
// after the boundary before polling.
import { describe, expect, it } from 'vitest'
import { BOUNDARY_SETTLE_MS, POLL_MS, POLL_SLOW_MS, intervalSeconds, nextBoundaryPollDelayMs } from './chartConfig'

describe('chart poll cadence', () => {
  it('慢档比快档慢、快档对齐 EA 的 3 秒 / slow > fast, fast aligned to the EA 3s', () => {
    expect(POLL_MS).toBe(3000)
    expect(POLL_SLOW_MS).toBeGreaterThanOrEqual(8000)
  })

  it('intervalSeconds 只支持 epoch 对齐的周期', () => {
    expect(intervalSeconds('1')).toBe(60)
    expect(intervalSeconds('5')).toBe(300)
    expect(intervalSeconds('15')).toBe(900)
    expect(intervalSeconds('60')).toBe(3600)
    expect(intervalSeconds('240')).toBeNull()
    expect(intervalSeconds('D')).toBeNull()
  })

  it('M1：距下一根开盘 + 3.3 秒 / M1: time to next open plus the settle time', () => {
    const t = Date.UTC(2026, 8, 29, 10, 0, 30) // 10:00:30
    expect(nextBoundaryPollDelayMs('1', t)).toBe(30_000 + BOUNDARY_SETTLE_MS)
  })

  it('恰在边界上：等下一根，而不是 0 / exactly on the boundary waits for the next bar', () => {
    const t = Date.UTC(2026, 8, 29, 10, 0, 0)
    expect(nextBoundaryPollDelayMs('1', t)).toBe(60_000 + BOUNDARY_SETTLE_MS)
    expect(nextBoundaryPollDelayMs('60', t)).toBe(3_600_000 + BOUNDARY_SETTLE_MS)
  })

  it('不支持的周期返回 null（靠慢轮询发现新 bar）', () => {
    expect(nextBoundaryPollDelayMs('240', Date.now())).toBeNull()
    expect(nextBoundaryPollDelayMs('D', Date.now())).toBeNull()
  })
})
