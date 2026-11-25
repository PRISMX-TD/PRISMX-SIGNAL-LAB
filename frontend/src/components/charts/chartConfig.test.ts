// 图表轮询的边界补拉时刻：只认 epoch 对齐的 1/5/15/60 分钟周期，边界后等 EA 推送再拉。
// Boundary catch-up timing: only epoch-aligned 1/5/15/60-minute intervals; wait for the EA push
// after the boundary before polling.
import { describe, expect, it } from 'vitest'
import {
  BOUNDARY_SETTLE_MS, CANDLE_SCHEMES, DRAG_LOCK_SCROLL, scrollAfterDrag, DEFAULT_CANDLE_COLORS, POLL_MS, POLL_SLOW_MS, barCloseCountdownSec, barSpacingSeconds,
  candleSchemeOf, fmtCountdown, intervalSeconds, nextBoundaryPollDelayMs, normalizeCandleColors,
  INTERVALS, isKnownInterval,
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

  it('自定义周期：整除 60 的按 epoch 对齐，其余（券商锚定）null', () => {
    for (const [c, s] of [['2', 120], ['3', 180], ['4', 240], ['6', 360], ['10', 600], ['12', 720], ['20', 1200], ['30', 1800]] as const) {
      expect(intervalSeconds(c)).toBe(s)
    }
    for (const c of ['7', '45', '90', '120', '720', '1440', '2D', 'W', 'M', '3M', 'X']) expect(intervalSeconds(c), c).toBeNull()
    const t = Date.UTC(2026, 8, 29, 10, 3, 0)
    expect(nextBoundaryPollDelayMs('10', t)).toBe(7 * 60_000 + BOUNDARY_SETTLE_MS)
    expect(nextBoundaryPollDelayMs('45', t)).toBeNull()
    expect(nextBoundaryPollDelayMs('120', t)).toBeNull()
    expect(nextBoundaryPollDelayMs('W', t)).toBeNull()
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

  it('自定义周期：所有分钟周期都有间距，多日 / 周 / 月没有', () => {
    expect(barSpacingSeconds('7')).toBe(420)
    expect(barSpacingSeconds('45')).toBe(2700)
    expect(barSpacingSeconds('120')).toBe(7200)
    expect(barSpacingSeconds('720')).toBe(43200)
    expect(barSpacingSeconds('1440')).toBe(86400)
    expect(barSpacingSeconds('2D')).toBeNull()
    expect(barSpacingSeconds('2W')).toBeNull()
    expect(barSpacingSeconds('3M')).toBeNull()
    expect(barSpacingSeconds('X')).toBeNull()
  })
})

describe('INTERVALS / 老的 8 个周期', () => {
  it('代码与标签不变 / codes and labels unchanged', () => {
    expect(INTERVALS).toEqual([
      { code: '1', label: '1m' }, { code: '5', label: '5m' }, { code: '15', label: '15m' }, { code: '30', label: '30m' },
      { code: '60', label: '1H' }, { code: '240', label: '4H' }, { code: 'D', label: '1D' }, { code: 'M', label: '1M' },
    ])
    for (const iv of INTERVALS) expect(isKnownInterval(iv.code)).toBe(true)
    expect(isKnownInterval('45')).toBe(true)
    expect(isKnownInterval('12M')).toBe(true)
    expect(isKnownInterval('1439')).toBe(false)
    expect(isKnownInterval(null)).toBe(false)
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

  it('自定义周期：epoch 对齐的按时钟，券商锚定的按最后一根推，7m 最后一桶在券商零点收', () => {
    const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi)
    // 10m：epoch 对齐 / epoch-aligned
    expect(barCloseCountdownSec('10', null, utc(2026, 10, 14, 9, 3))).toBe(420)
    // 45m：最后一根 21:00 UTC（夏令时券商零点），现在 21:30 → 还剩 15 分钟
    expect(barCloseCountdownSec('45', utc(2026, 10, 13, 21) / 1000, utc(2026, 10, 13, 21, 30))).toBe(900)
    // 2H：最后一根 21:00，现在 23:10（刚跨边界、新 bar 没到）→ 顺推到 01:00
    expect(barCloseCountdownSec('120', utc(2026, 10, 13, 21) / 1000, utc(2026, 10, 13, 23, 10))).toBe(110 * 60)
    // 7m：20:55 那桶只有 5 分钟，21:00 收 / the 20:55 bucket closes at broker midnight 21:00
    expect(barCloseCountdownSec('7', utc(2026, 10, 13, 20, 55) / 1000, utc(2026, 10, 13, 20, 57))).toBe(180)
    // 多日 / 周 / 月：不显示 / hidden
    expect(barCloseCountdownSec('2D', utc(2026, 10, 13, 21) / 1000, utc(2026, 10, 14))).toBeNull()
    expect(barCloseCountdownSec('W', utc(2026, 10, 13, 21) / 1000, utc(2026, 10, 14))).toBeNull()
    expect(barCloseCountdownSec('3M', utc(2026, 10, 13, 21) / 1000, utc(2026, 10, 14))).toBeNull()
    expect(barCloseCountdownSec('X', utc(2026, 10, 13, 21) / 1000, utc(2026, 10, 14))).toBeNull()
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

describe('scrollAfterDrag（拖线后恢复图表拖动，踩坑 #221）', () => {
  it('原样恢复拖线前的值，手机价格轴的 vertTouchDrag: true 不会被关掉', () => {
    const before = { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true }
    expect(scrollAfterDrag(before)).toEqual(before)
  })

  it('返回新对象：chart.options() 给的内部对象被锁定改掉后，快照不受影响', () => {
    const live = { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true }
    const snap = scrollAfterDrag(live)
    Object.assign(live, DRAG_LOCK_SCROLL)
    expect(snap).not.toBe(live)
    expect(snap).toMatchObject({ vertTouchDrag: true, horzTouchDrag: true, pressedMouseMove: true })
  })

  it('布尔值原样返回，没有快照时退回全开', () => {
    expect(scrollAfterDrag(false)).toBe(false)
    expect(scrollAfterDrag(null)).toEqual({ mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true })
  })

  it('锁定期间三种拖动都关、不碰滚轮', () => {
    expect(DRAG_LOCK_SCROLL).toEqual({ pressedMouseMove: false, horzTouchDrag: false, vertTouchDrag: false })
  })
})
