// 操作日志的北京时间口径：跨零点分组、日期分隔行文字、日期筛选换算成 UTC 的 since / until。
// 这些全是算术，与运行测试的机器在哪个时区无关。
// Beijing-time rules of the activity log: grouping across midnight, day separator labels,
// and date filters converted to UTC since / until. Pure arithmetic, independent of the
// machine's own time zone.
import { describe, expect, it } from 'vitest'
import { bjClock, bjDate, bjDateTime, bjDayKey, bjDayStart, bjFull, bjHm, dateRange, dayLabel, groupByDay, shiftDay } from './time'
import { makeT } from './testT'

const zh = makeT('zh')
const en = makeT('en')

describe('北京日 / Beijing day', () => {
  it('UTC 16:00 是北京的零点 / 16:00 UTC is Beijing midnight', () => {
    expect(bjDayKey('2026-10-08T15:59:59.999999Z')).toBe('2026-10-08')
    expect(bjDayKey('2026-10-08T16:00:00.000000Z')).toBe('2026-10-09')
    expect(bjClock('2026-10-08T16:00:00.000000Z')).toBe('00:00:00')
    expect(bjClock('2026-10-09T06:03:21.123456Z')).toBe('14:03:21')
    expect(bjHm('2026-10-09T06:03:21.123456Z')).toBe('14:03')
    expect(bjDate('2026-11-08T17:00:00Z')).toBe('2026-11-09')
    expect(bjDateTime('2026-11-09T00:00:00.000000Z')).toBe('2026-11-09 08:00')
    expect(bjFull('2026-10-09T06:03:21Z')).toBe('2026-10-09 14:03:21 UTC+8')
  })

  it('不带时区的时间按 UTC（与全站 parseTime 同一条规矩）/ naive times are UTC, like parseTime', () => {
    expect(bjClock('2026-10-09T06:03:21')).toBe('14:03:21')
    expect(bjClock(null)).toBe('—')
    expect(bjDayKey('not a time')).toBe('')
  })

  it('跨月、跨年挪日子 / shifting across month and year ends', () => {
    expect(shiftDay('2026-11-01', -1)).toBe('2026-10-31')
    expect(shiftDay('2025-12-31', 1)).toBe('2026-01-01')
    expect(bjDayStart('2026-10-09')?.toISOString()).toBe('2026-10-08T16:00:00.000Z')
    expect(bjDayStart('2026-13-40x')).toBeNull()
  })
})

describe('按北京日分组 / grouping by Beijing day', () => {
  it('跨零点的两行落在两组，组内保持原顺序 / rows either side of midnight land in two groups', () => {
    const rows = [
      { key: 'a', ts: '2026-10-08T16:00:01.000000Z' }, // 北京 10-09 00:00:01
      { key: 'b', ts: '2026-10-08T16:00:00.000000Z' }, // 北京 10-09 00:00:00
      { key: 'c', ts: '2026-10-08T15:59:59.000000Z' }, // 北京 10-08 23:59:59
      { key: 'd', ts: '2026-10-07T20:00:00.000000Z' }, // 北京 10-08 04:00
    ]
    const groups = groupByDay(rows)
    expect(groups.map((g) => [g.day, g.items.map((i) => i.key)])).toEqual([
      ['2026-10-09', ['a', 'b']],
      ['2026-10-08', ['c', 'd']],
    ])
  })
})

describe('日期分隔行 / day separator label', () => {
  // 北京时间 2026-10-09 09:00（UTC 01:00），那天是周五 / Beijing 2026-10-09 09:00, a Friday
  const now = new Date('2026-10-09T01:00:00Z')
  it('今天 / 昨天 / 更早 / 往年 / today, yesterday, earlier, another year', () => {
    expect(dayLabel('2026-10-09', now, zh)).toBe('今天 · 10月9日 周五')
    expect(dayLabel('2026-10-08', now, zh)).toBe('昨天 · 10月8日 周四')
    expect(dayLabel('2026-10-01', now, zh)).toBe('10月1日 周四')
    expect(dayLabel('2025-12-31', now, zh)).toBe('2025年12月31日 周三')
    expect(dayLabel('2026-10-09', now, en)).toBe('Today · Fri 9 Oct')
    expect(dayLabel('2025-12-31', now, en)).toBe('Wed 31 Dec 2025')
  })
  it('北京已经过了零点、UTC 还没过：按北京算「今天」/ past Beijing midnight but not UTC midnight', () => {
    const late = new Date('2026-10-08T17:30:00Z') // 北京 10-09 01:30
    expect(dayLabel('2026-10-09', late, zh).startsWith('今天')).toBe(true)
    expect(dayLabel('2026-10-08', late, zh).startsWith('昨天')).toBe(true)
  })
})

describe('日期筛选 → since / until（UTC，左闭右开）/ date filter to since / until', () => {
  const morning = new Date('2026-10-09T01:00:00Z') // 北京 10-09 09:00
  it('今天、昨天、最近 7 天、指定日期 / today, yesterday, last 7 days, a picked day', () => {
    expect(dateRange('today', morning)).toEqual({ since: '2026-10-08T16:00:00.000Z', until: null })
    expect(dateRange('yesterday', morning)).toEqual({ since: '2026-10-07T16:00:00.000Z', until: '2026-10-08T16:00:00.000Z' })
    expect(dateRange('week', morning)).toEqual({ since: '2026-10-02T16:00:00.000Z', until: null })
    // 与契约 §1.1 的例子一致 / matches the contract §1.1 example
    expect(dateRange('day', morning, '2026-10-09')).toEqual({ since: '2026-10-08T16:00:00.000Z', until: '2026-10-09T16:00:00.000Z' })
  })
  it('跨零点按北京算 / across midnight it is Beijing that counts', () => {
    // UTC 10-08 23:30 已经是北京 10-09 07:30 / UTC 10-08 23:30 is already Beijing 10-09
    expect(dateRange('today', new Date('2026-10-08T23:30:00Z')).since).toBe('2026-10-08T16:00:00.000Z')
    // UTC 10-08 15:00 还是北京 10-08 23:00 / UTC 10-08 15:00 is still Beijing 10-08
    expect(dateRange('today', new Date('2026-10-08T15:00:00Z')).since).toBe('2026-10-07T16:00:00.000Z')
  })
  it('不限 / 没选好日子 = 不筛 / "any" or no valid day means no bounds', () => {
    expect(dateRange('all', morning)).toEqual({ since: null, until: null })
    expect(dateRange('day', morning, '')).toEqual({ since: null, until: null })
    expect(dateRange('day', morning, null)).toEqual({ since: null, until: null })
  })
})
