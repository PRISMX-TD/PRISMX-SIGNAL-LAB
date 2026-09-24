// 节日日历 / festival calendar
//
// 纯函数、零依赖：给一个本地日期，返回命中的节日窗口（或 null）。
// Pure and dependency-free: given a local date, return the matching festival
// window or null.
//
// 用**本地日历日**判定而不是 UTC：新加坡用户 10 月 31 日晚上 11 点打开，
// 看到的应该还是万圣节，而那一刻 UTC 已经是 11 月 1 日。
// Matching uses the local calendar day, not UTC: a Singapore user opening the
// app at 23:00 on 31 October should still see Halloween, although UTC has
// already moved to 1 November.
//
// 农历节日（春节、中秋）每年公历日期不同。与其引入农历库，不如把五年的日期
// 直接写死：数据极小、零计算，到 2030 年补一行即可。表外的年份这两个节日
// 静默不出现，不会报错。
// Lunar festivals move every year. Five hard-coded years beat a lunar library:
// tiny, zero computation, one line to extend. Years outside the table simply
// skip those two festivals rather than failing.

export type FestivalKey = 'spring' | 'midautumn' | 'halloween' | 'christmas' | 'newyear'

export interface FestivalWindow {
  key: FestivalKey
  // 'YYYY-MM-DD'，闭区间 / inclusive
  start: string
  end: string
}

// 春节：[除夕, 元宵]；窗口再往前放一天（除夕前一天起）。
// Spring Festival: [New Year's Eve, Lantern Festival]; the window opens a day earlier.
const SPRING: Record<number, [string, string]> = {
  2026: ['2026-02-16', '2026-03-03'],
  2027: ['2027-02-05', '2027-02-20'],
  2028: ['2028-01-25', '2028-02-09'],
  2029: ['2029-02-12', '2029-02-27'],
  2030: ['2030-02-02', '2030-02-17'],
}

// 中秋当天（农历八月十五）；窗口为前三天至后一天。
// Mid-Autumn day itself; the window runs three days before to one day after.
const MID_AUTUMN: Record<number, string> = {
  2026: '2026-09-25',
  2027: '2027-09-15',
  2028: '2028-10-03',
  2029: '2029-09-22',
  2030: '2030-09-12',
}

export const LUNAR_YEARS = { first: 2026, last: 2030 }

function pad(n: number) {
  return (n < 10 ? '0' : '') + n
}

// 本地日历日 → 'YYYY-MM-DD'。定长字符串的字典序就是日期序，省掉时区换算。
// Local calendar day as 'YYYY-MM-DD'; fixed-width strings sort as dates do.
export function ymd(d: Date): string {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

export function parseYmd(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  // 中午而不是零点：避开个别时区在零点切夏令时导致的「日期前跳一天」。
  // Noon rather than midnight, so a DST switch at 00:00 cannot roll the day back.
  return new Date(+m[1], +m[2] - 1, +m[3], 12)
}

function shift(s: string, days: number): string {
  const d = parseYmd(s) as Date
  d.setDate(d.getDate() + days)
  return ymd(d)
}

// 某一年「开始于」该年的所有窗口，按开始日排序。顺序即重叠时的优先级
// （目前五个窗口互不重叠）。
// Every window that starts in year y, sorted by start. Order doubles as overlap
// priority, though no two windows overlap today.
export function windowsStartingIn(y: number): FestivalWindow[] {
  const out: FestivalWindow[] = []
  const sp = SPRING[y]
  if (sp) out.push({ key: 'spring', start: shift(sp[0], -1), end: sp[1] })
  const ma = MID_AUTUMN[y]
  if (ma) out.push({ key: 'midautumn', start: shift(ma, -3), end: shift(ma, 1) })
  out.push({ key: 'halloween', start: y + '-10-25', end: y + '-10-31' })
  out.push({ key: 'christmas', start: y + '-12-18', end: y + '-12-26' })
  // 跨年：12/30 → 次年 1/2 / spans the year boundary
  out.push({ key: 'newyear', start: y + '-12-30', end: y + 1 + '-01-02' })
  return out.sort((a, b) => (a.start < b.start ? -1 : 1))
}

export function detect(date: Date): FestivalWindow | null {
  const today = ymd(date)
  const y = date.getFullYear()
  // 上一年开始的窗口也要查：1 月 1 日落在去年 12 月 30 日开始的新年窗口里。
  // Windows that began last year count too: 1 January sits inside the New Year
  // window that opened on 30 December.
  const candidates = windowsStartingIn(y - 1).concat(windowsStartingIn(y))
  for (const w of candidates) {
    if (today >= w.start && today <= w.end) return w
  }
  return null
}

export function nextWindow(date: Date): FestivalWindow | null {
  const today = ymd(date)
  const y = date.getFullYear()
  const all = windowsStartingIn(y).concat(windowsStartingIn(y + 1))
  for (const w of all) if (w.start > today) return w
  return null
}

// 新年插画上的年份：12 月里显示「即将到来的那一年」。
// The year printed in the New Year art: in December it is the coming year.
export function newYearNumber(date: Date): number {
  return date.getMonth() === 11 ? date.getFullYear() + 1 : date.getFullYear()
}

// 关闭记录按「节日 + 窗口起始日」记，所以关掉今年中秋不等于关掉万圣节，
// 也不等于关掉明年的中秋。
// Dismissals are keyed by festival + window start, so closing this year's
// Mid-Autumn closes neither Halloween nor next year's Mid-Autumn.
export function windowId(w: FestivalWindow): string {
  return w.key + '@' + w.start
}
