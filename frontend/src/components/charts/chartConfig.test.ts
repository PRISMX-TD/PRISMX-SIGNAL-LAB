// 图表轮询的边界补拉时刻：只认 epoch 对齐的 1/5/15/60 分钟周期，边界后等 EA 推送再拉。
// Boundary catch-up timing: only epoch-aligned 1/5/15/60-minute intervals; wait for the EA push
// after the boundary before polling.
import { describe, expect, it } from 'vitest'
import {
  BOUNDARY_SETTLE_MS, CANDLE_SCHEMES, DEFAULT_CANDLE_COLORS, POLL_MS, POLL_SLOW_MS, barCloseCountdownSec, barSpacingSeconds,
  candleSchemeOf, fmtCountdown, intervalSeconds, nextBoundaryPollDelayMs, normalizeCandleColors,
} from './chartConfig'

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

describe('barSpacingSeconds', () => {
  it('4H / 日线也有间距（只用于找缺口），分钟线与 intervalSeconds 一致', () => {
    expect(barSpacingSeconds('5')).toBe(300)
    expect(barSpacingSeconds('60')).toBe(3600)
    expect(barSpacingSeconds('240')).toBe(14400)
    expect(barSpacingSeconds('D')).toBe(86400)
    expect(barSpacingSeconds('W')).toBeNull()
  })
})

describe('bar-close countdown / K 线收线倒计时', () => {
  it('epoch 对齐周期按时钟算下一个边界', () => {
    const t0 = 1_700_000_100_000 // 某个 15 分钟边界后 100 秒附近
    const sec = barCloseCountdownSec('15', null, t0)
    expect(sec).not.toBeNull()
    expect(((t0 / 1000 + sec!) % 900)).toBe(0)
    expect(barCloseCountdownSec('1', null, 60_000 * 10 + 1000)).toBe(59)
  })

  it('4H / 日线用最后一根开盘 + 周期，落后超过一根返回 null', () => {
    const open = 1_700_000_000 - 3600 // 4H bar 开了 1 小时
    expect(barCloseCountdownSec('240', open, 1_700_000_000_000)).toBe(14400 - 3600)
    // 刚跨边界、新 bar 还没到：顺推一根
    expect(barCloseCountdownSec('240', open - 14400, 1_700_000_000_000)).toBe(14400 - 3600)
    // 落后两根以上：休市 / 断档
    expect(barCloseCountdownSec('240', open - 3 * 14400, 1_700_000_000_000)).toBeNull()
    expect(barCloseCountdownSec('D', null, 1_700_000_000_000)).toBeNull()
  })

  it('格式：一小时以内 mm:ss，以上 h:mm:ss', () => {
    expect(fmtCountdown(522)).toBe('08:42')
    expect(fmtCountdown(4122)).toBe('1:08:42')
    expect(fmtCountdown(0)).toBe('00:00')
  })
})

describe('candle colors / K 线配色', () => {
  it('坏值退回默认，预设可识别', () => {
    expect(normalizeCandleColors(null)).toEqual(DEFAULT_CANDLE_COLORS)
    expect(normalizeCandleColors({ up: 'red', down: '#123456' })).toEqual({ up: DEFAULT_CANDLE_COLORS.up, down: '#123456' })
    expect(candleSchemeOf(CANDLE_SCHEMES.redUp)).toBe('redUp')
    expect(candleSchemeOf({ up: '#2EE07E', down: '#FF4D67' })).toBe('greenUp')
    expect(candleSchemeOf({ up: '#38bdf8', down: '#ff4d67' })).toBe('custom')
  })
})
