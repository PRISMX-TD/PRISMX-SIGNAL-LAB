// 周期语法、标签、分类、输入归一与券商时钟。
// Interval grammar, labels, kinds, input normalisation and the broker clock.
import { describe, expect, it } from 'vitest'
import {
  INTERVAL_PRESETS, MAX_DERIVE_FACTOR, NATIVE_INTERVALS, brokerBucketStart, brokerOffsetSec, intervalCode,
  intervalKind, intervalLabel, isValidInterval, minuteSource, nextMinuteBarOpen, normalizeIntervalInput, parseInterval,
} from './intervals'

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000

describe('parseInterval / isValidInterval', () => {
  it('老代码全部有效、含义不变 / existing codes stay valid', () => {
    expect(parseInterval('1')).toEqual({ unit: 'min', n: 1 })
    expect(parseInterval('30')).toEqual({ unit: 'min', n: 30 })
    expect(parseInterval('240')).toEqual({ unit: 'min', n: 240 })
    expect(parseInterval('D')).toEqual({ unit: 'D', n: 1 })
    expect(parseInterval('M')).toEqual({ unit: 'M', n: 1 })
    for (const c of NATIVE_INTERVALS) expect(isValidInterval(c)).toBe(true)
  })

  it('新语法：小时 = 60 的倍数，nD / nW / nM', () => {
    expect(parseInterval('720')).toEqual({ unit: 'min', n: 720 })
    expect(parseInterval('1440')).toEqual({ unit: 'min', n: 1440 })
    expect(parseInterval('2D')).toEqual({ unit: 'D', n: 2 })
    expect(parseInterval('W')).toEqual({ unit: 'W', n: 1 })
    expect(parseInterval('52W')).toEqual({ unit: 'W', n: 52 })
    expect(parseInterval('3M')).toEqual({ unit: 'M', n: 3 })
    expect(parseInterval('12M')).toEqual({ unit: 'M', n: 12 })
    expect(parseInterval('365D')).toEqual({ unit: 'D', n: 365 })
  })

  it('不合法：坏语法、非规范写法、超上限、合成倍数太大', () => {
    for (const c of ['', '0', '01', '1.5', '-5', ' 5', '5m', 'd', 'm', 'X', '1D', '1W', '1M', '1441', '10000',
      '366D', '53W', '13M', '0D', '1Y', 'DD']) {
      expect(isValidInterval(c), c).toBe(false)
    }
    expect(isValidInterval(null)).toBe(false)
    expect(isValidInterval(undefined)).toBe(false)
    // 合成倍数：M1 源最多 96 根 / derive factor cap
    expect(MAX_DERIVE_FACTOR).toBe(96)
    expect(isValidInterval('96')).toBe(true)
    expect(isValidInterval('97')).toBe(false)
    expect(isValidInterval('1439')).toBe(false)
    expect(isValidInterval('480')).toBe(true) // 5 × 96
    expect(isValidInterval('485')).toBe(false)
    expect(isValidInterval('495')).toBe(true) // 15 × 33
    expect(isValidInterval('1425')).toBe(true) // 15 × 95
  })

  it('intervalCode 是 parseInterval 的逆 / round trip', () => {
    for (const c of ['1', '45', '120', '1440', 'D', '2D', 'W', '3W', 'M', '6M', '12M']) {
      expect(intervalCode(parseInterval(c)!)).toBe(c)
    }
  })
})

describe('minuteSource', () => {
  it('{240,60,15,5,1} 里整除 n 的最大一个', () => {
    expect(minuteSource(2)).toBe(1)
    expect(minuteSource(7)).toBe(1)
    expect(minuteSource(10)).toBe(5)
    expect(minuteSource(30)).toBe(15)
    expect(minuteSource(45)).toBe(15)
    expect(minuteSource(90)).toBe(15)
    expect(minuteSource(120)).toBe(60)
    expect(minuteSource(360)).toBe(60)
    expect(minuteSource(720)).toBe(240)
    expect(minuteSource(1440)).toBe(240)
  })
})

describe('intervalLabel / intervalKind', () => {
  it('标签与老的写法同风格', () => {
    const got = ['1', '45', '60', '120', '240', '1440', 'D', '2D', 'W', 'M', '3M', '12M'].map(intervalLabel)
    expect(got).toEqual(['1m', '45m', '1H', '2H', '4H', '24H', '1D', '2D', '1W', '1M', '3M', '12M'])
    expect(intervalLabel('X')).toBe('X')
  })

  it('分类', () => {
    expect(intervalKind('1')).toBe('intraday')
    expect(intervalKind('720')).toBe('intraday')
    expect(intervalKind('D')).toBe('daily')
    expect(intervalKind('3D')).toBe('daily')
    expect(intervalKind('W')).toBe('weekly')
    expect(intervalKind('M')).toBe('monthly')
    expect(intervalKind('12M')).toBe('monthly')
  })
})

describe('normalizeIntervalInput', () => {
  it.each([
    ['5', '5'], ['5m', '5'], ['5 min', '5'], [' 45m ', '45'], ['m', '1'],
    ['2h', '120'], ['2H', '120'], ['h', '60'], ['12h', '720'], ['24h', 'D'], ['1440', 'D'],
    ['d', 'D'], ['1d', 'D'], ['D', 'D'], ['3d', '3D'], ['3D', '3D'],
    ['w', 'W'], ['1w', 'W'], ['2W', '2W'],
    ['M', 'M'], ['1M', 'M'], ['3M', '3M'], ['mo', 'M'], ['6mo', '6M'], ['y', '12M'],
    ['15分钟', '15'], ['4小时', '240'], ['周', 'W'], ['3个月', '3M'],
  ])('%s → %s', (input, code) => {
    expect(normalizeIntervalInput(input)).toBe(code)
  })

  it.each(['', '0', '0m', 'abc', '2x', '1441', '25h', '13M', '2y', '53w', '366d', '97m', '5.5'])('%s → null', (input) => {
    expect(normalizeIntervalInput(input)).toBeNull()
  })
})

describe('INTERVAL_PRESETS', () => {
  it('分组与内容，全部合法', () => {
    expect(INTERVAL_PRESETS.map((g) => g.group)).toEqual(['minutes', 'hours', 'days', 'weeks', 'months'])
    expect(INTERVAL_PRESETS.flatMap((g) => g.codes.map(intervalLabel))).toEqual([
      '1m', '2m', '3m', '5m', '10m', '15m', '30m', '45m',
      '1H', '2H', '3H', '4H', '6H', '12H', '1D', '1W', '1M', '3M', '6M', '12M',
    ])
    for (const g of INTERVAL_PRESETS) for (const c of g.codes) expect(isValidInterval(c)).toBe(true)
  })
})

describe('brokerOffsetSec', () => {
  it('2026：3 月 8 日 07:00 UTC 起 GMT+3，11 月 1 日 06:00 UTC 起 GMT+2', () => {
    expect(brokerOffsetSec(utc(2026, 1, 15))).toBe(7200)
    expect(brokerOffsetSec(utc(2026, 3, 8, 7) - 1)).toBe(7200)
    expect(brokerOffsetSec(utc(2026, 3, 8, 7))).toBe(10800)
    expect(brokerOffsetSec(utc(2026, 7, 1))).toBe(10800)
    expect(brokerOffsetSec(utc(2026, 11, 1, 6) - 1)).toBe(10800)
    expect(brokerOffsetSec(utc(2026, 11, 1, 6))).toBe(7200)
    expect(brokerOffsetSec(utc(2026, 12, 31, 23, 59))).toBe(7200)
  })

  it('其它年份（缓存换年）：2025 是 3/9 与 11/2，2027 是 3/14 与 11/7', () => {
    expect(brokerOffsetSec(utc(2025, 3, 9, 7) - 1)).toBe(7200)
    expect(brokerOffsetSec(utc(2025, 3, 9, 7))).toBe(10800)
    expect(brokerOffsetSec(utc(2025, 11, 2, 6) - 1)).toBe(10800)
    expect(brokerOffsetSec(utc(2025, 11, 2, 6))).toBe(7200)
    expect(brokerOffsetSec(utc(2027, 3, 14, 7))).toBe(10800)
    expect(brokerOffsetSec(utc(2027, 11, 7, 6) - 1)).toBe(10800)
    expect(brokerOffsetSec(utc(2026, 3, 8, 7))).toBe(10800)
  })
})

describe('brokerBucketStart / nextMinuteBarOpen', () => {
  it('7m 在券商零点重新起算，当天最后一桶只有 5 分钟', () => {
    // 夏令时：券商零点 = 21:00 UTC / summer: broker midnight = 21:00 UTC
    const toUtc = (t: number) => brokerBucketStart(7, t) - brokerOffsetSec(t)
    expect(toUtc(utc(2026, 10, 13, 20, 54))).toBe(utc(2026, 10, 13, 20, 48))
    expect(toUtc(utc(2026, 10, 13, 20, 59))).toBe(utc(2026, 10, 13, 20, 55))
    expect(toUtc(utc(2026, 10, 13, 21, 0))).toBe(utc(2026, 10, 13, 21, 0))
    expect(toUtc(utc(2026, 10, 13, 21, 7))).toBe(utc(2026, 10, 13, 21, 7))
    expect(nextMinuteBarOpen(7, utc(2026, 10, 13, 20, 55))).toBe(utc(2026, 10, 13, 21, 0))
    expect(nextMinuteBarOpen(7, utc(2026, 10, 13, 20, 48))).toBe(utc(2026, 10, 13, 20, 55))
    // 冬令时券商零点 = 22:00 UTC / winter: 22:00 UTC
    expect(nextMinuteBarOpen(7, utc(2026, 12, 9, 21, 55))).toBe(utc(2026, 12, 9, 22, 0))
    // 整除 1440 的不受零点截断 / divisors of 1440 just add n
    expect(nextMinuteBarOpen(45, utc(2026, 10, 13, 20, 15))).toBe(utc(2026, 10, 13, 21, 0))
    expect(nextMinuteBarOpen(240, utc(2026, 10, 13, 21))).toBe(utc(2026, 10, 14, 1))
  })
})
