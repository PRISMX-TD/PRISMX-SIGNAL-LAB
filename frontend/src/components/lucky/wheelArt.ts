// 转盘的纯绘图数据：默认配色、扇区路径、文字该用深色还是浅色、奖品名怎么断成两行、灯珠排布。
// 放在 .ts 里是因为仓库没有 DOM 测试环境；LuckyWheel.tsx 只负责把这些画出来。
// Pure drawing data for the wheel: default palette, slice paths, dark-or-light label ink, how a prize
// name breaks into two lines, and where the rim bulbs go. Kept in .ts (no DOM test env); LuckyWheel.tsx
// only renders what these return.
import type { LuckyPrizeKind } from '../../api/luckyTypes'
import { slotSpan } from '../../utils/luckyWheel'

// 默认配色跟着站里的「黑 + 紫」走：深浅交替，相邻两格一定拉得开；金色只出现一次，留给最显眼的那格。
// 以前是一条彩虹（紫青橙红蓝绿粉），和全站只有紫一种彩度的设计语言冲突。管理员自己选的颜色照常优先。
// The default palette follows the site's black + violet: dark and light alternate so neighbours always
// separate, and gold appears once. The old rainbow fought a design language whose only chroma is violet.
// A colour the admin picked still wins.
export const PALETTE = ['#5A22EE', '#E9E4FF', '#2A2A33', '#9284FF', '#E0A83C', '#3B1C9C', '#C9C9D1', '#6E42FF']

export const slotColor = (color: string | null | undefined, i: number) =>
  color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : PALETTE[i % PALETTE.length]

/** 相对亮度（WCAG）/ relative luminance (WCAG) */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 0
  const n = parseInt(m[1], 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

export const INK_DARK = '#141418'
export const INK_LIGHT = '#F4F4F6'

/** 压在这块颜色上的字用深还是浅：取对比度更高的那个 / Label ink with the higher contrast on this fill. */
export function labelInk(fill: string): string {
  const l = luminance(fill)
  const vsDark = (l + 0.05) / (luminance(INK_DARK) + 0.05)
  const vsLight = (luminance(INK_LIGHT) + 0.05) / (l + 0.05)
  return vsDark > vsLight ? INK_DARK : INK_LIGHT
}

/** 第 i 格的扇形路径（半径 r，0 度在正上方，顺时针）/ Slice path for slot i (0° at the top, clockwise). */
export function slicePath(i: number, n: number, r: number): string {
  const span = slotSpan(n)
  const a0 = ((i * span - 90) * Math.PI) / 180
  const a1 = (((i + 1) * span - 90) * Math.PI) / 180
  const large = span > 180 ? 1 : 0
  const p = (a: number) => `${(r * Math.cos(a)).toFixed(3)} ${(r * Math.sin(a)).toFixed(3)}`
  return `M0 0 L${p(a0)} A${r} ${r} 0 ${large} 1 ${p(a1)} Z`
}

// 字宽估算：汉字、假名、韩文、泰文按 1 个字号宽，其余（拉丁、数字）按 0.58。
// Width estimate: CJK / kana / Hangul / Thai count as one em, everything else 0.58 em.
const WIDE = /[฀-๿ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/
export const charEm = (ch: string) => (WIDE.test(ch) ? 1 : 0.58)
export const textEm = (s: string) => [...s].reduce((a, c) => a + charEm(c), 0)

/**
 * 把奖品名断成最多两行，每行不超过 maxEm 个字宽；第二行放不下就截断加「…」。
 * 优先在空格处断（英文、泰文名不会被拦腰切开），找不到空格才按字切。
 * Break a prize name into at most two lines of maxEm ems each; truncate line two with an ellipsis.
 * Prefer breaking at a space so Latin / Thai words stay whole; fall back to a character break.
 */
export function splitLabel(name: string, maxEm: number): string[] {
  const s = name.trim().replace(/\s+/g, ' ')
  if (!s) return ['']
  if (textEm(s) <= maxEm) return [s]
  const chars = [...s]
  let cut = 0
  let w = 0
  while (cut < chars.length && w + charEm(chars[cut]) <= maxEm) { w += charEm(chars[cut]); cut++ }
  const space = chars.lastIndexOf(' ', cut)
  if (space > 0 && space >= cut * 0.5) cut = space
  const first = chars.slice(0, cut).join('').trim()
  let rest = chars.slice(cut).join('').trim()
  if (textEm(rest) > maxEm) {
    const rc = [...rest]
    let k = 0
    let rw = 0
    while (k < rc.length && rw + charEm(rc[k]) <= maxEm - 1) { rw += charEm(rc[k]); k++ }
    rest = rc.slice(0, k).join('').trimEnd() + '…'
  }
  return rest ? [first, rest] : [first]
}

/**
 * 按格数给出字号与每行可容纳的字宽。名字写在半径 R 附近，那里的弧长是 2πR/n，
 * 再留出两侧分隔线的余量。
 * Font size and line capacity by slot count. Names sit near radius R, where the arc is 2πR/n, minus
 * room for the divider lines either side.
 */
export function labelMetrics(n: number, fontSize?: number): { size: number; maxEm: number; r: number } {
  const size = fontSize ?? (n <= 4 ? 11 : n <= 6 ? 10 : n <= 8 ? 9 : 8)
  const r = 66
  const arc = (2 * Math.PI * r) / Math.max(n, 1)
  // 保留一位小数，不取整：取整会白白丢掉将近一个字宽，「7 天 PRO 会员」这种就被截了。
  // One decimal, not an integer: flooring throws away up to a whole em and truncates names like "7 天 PRO 会员".
  const maxEm = Math.max(3, Math.min(9, Math.floor(((arc * 0.78) / size) * 10) / 10))
  return { size, maxEm, r }
}

/**
 * 给一格的名字定字号和断行：先用这个格数的标准字号，两行放不下就每次缩 1 号（最小 7）再试，
 * 都放不下才用最小号截断。
 * Pick the font size and lines for a slot name: the standard size for this slot count first, then one
 * size smaller at a time (down to 7) while two lines can't hold it; only then truncate at the smallest.
 */
export function fitLabel(name: string, n: number): { lines: string[]; size: number } {
  const base = labelMetrics(n).size
  const bare = (s: string) => s.replace(/\s+/g, '')
  let last = { lines: [''], size: base }
  for (let size = base; size >= Math.min(base, 7); size--) {
    const lines = splitLabel(name, labelMetrics(n, size).maxEm)
    last = { lines, size }
    if (bare(lines.join('')) === bare(name)) return last
  }
  return last
}

/**
 * 灯珠个数：至少 16 颗，并且是格数的整数倍，让每条分隔线正对一颗灯。
 * Bulb count: at least 16 and a multiple of the slot count, so every divider lines up with a bulb.
 */
export function bulbCount(n: number): number {
  const k = Math.max(1, Math.ceil(16 / Math.max(n, 1)))
  return Math.max(n, 1) * k
}

/** 奖品种类在格子里的小图标路径（24×24 网格、居中于 0,0）/ Kind glyph path on a 24-grid centred at 0,0. */
export const KIND_GLYPH: Record<LuckyPrizeKind, string> = {
  // 皇冠 / crown
  pro_days: 'M-7 4 L-7 -3 L-3.2 0.4 L0 -5 L3.2 0.4 L7 -3 L7 4 Z',
  // 礼盒 / gift box
  custom: 'M-7 -2 H7 V1 H-7 Z M-6 1 H6 V7 H-6 Z M-0.9 -2 V7 M0.9 -2 V7 M0 -2 C-2 -6 -6 -5 -4 -2 M0 -2 C2 -6 6 -5 4 -2',
  // 循环箭头 / circular arrow
  retry: 'M5.6 -2.4 A6 6 0 1 0 6 1.6 M5.6 -2.4 L6.4 -6.6 M5.6 -2.4 L1.6 -3.4',
  // 四角星 / four-point sparkle
  none: 'M0 -6 C0.8 -1.6 1.6 -0.8 6 0 C1.6 0.8 0.8 1.6 0 6 C-0.8 1.6 -1.6 0.8 -6 0 C-1.6 -0.8 -0.8 -1.6 0 -6 Z',
}

/** 描边型图标（其余为实心）/ Glyphs drawn as strokes rather than fills. */
export const STROKE_GLYPH: Partial<Record<LuckyPrizeKind, true>> = { retry: true, custom: true }
