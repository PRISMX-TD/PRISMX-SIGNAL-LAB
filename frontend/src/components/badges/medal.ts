// frontend/src/components/badges/medal.ts
//
// V5 铸币勋章渲染器：从设计稿（badge-atlas.html，已批准的视觉方案）逐一对照
// 移植的纯函数，不依赖 React、不访问 DOM。两条轴——形状 = 家族（六种轮廓，
// 20 像素也能分辨），材质 = 稀有度（五种金属，只回答"多难得"）——具体数值、
// 路径、配色全部照抄原稿，不做"优化"。
//
// 为什么用字符串拼 SVG 而不是 JSX：17 枚纹章都是手绘路径 + 逐点计算的坐标
// （扇形、星形、桂叶沿贝塞尔切线排布……），产出的标记是纯静态、作者可控的
// ——这里没有一处数据来自用户输入（badge id 来自后端注册表，rarity 来自
// 前端自己的镜像表），所以调用方用 dangerouslySetInnerHTML 灌入是安全的；
// 真正需要防的是把不可信文本当 HTML 灌进去，这套渲染器通篇不碰那类数据。
//
// Why string-built SVG instead of JSX: the 17 emblems are hand-drawn paths
// with per-point computed geometry (sectors, stars, laurel leaves swept
// along a bezier tangent...). The output markup is fully static and
// author-controlled — nothing here originates from user input (the badge id
// comes from the backend registry, rarity from our own mirror table) — so a
// caller using dangerouslySetInnerHTML is safe. The thing to actually guard
// against is untrusted text treated as HTML, and none of that happens in
// this renderer.
//
// 本文件在模块作用域不触碰 window/document（SSR 预渲染安全）；唯一的运行时
// 环境探测（prefers-reduced-motion）延后到 renderMedalInner 调用时才做，并
// 带 typeof window 保护。
// This file touches no window/document at module scope (SSR-prerender
// safe); its one runtime environment check (prefers-reduced-motion) is
// deferred to call time inside renderMedalInner, guarded by typeof window.
import type { GamificationBadgeRarity } from '../../api/types'

// ---------------- 家族（= 形状） ----------------
export type BadgeFamily = 'growth' | 'evergreen' | 'discipline' | 'performance' | 'competition' | 'limited'

interface MaterialDef {
  name: string
  rim: [string, string, string]
  field: [string, string]
  L: string
  D: string
  H: string
  tick: string
  inlay: string | null
  sun?: boolean
  gems?: boolean
  rays?: boolean
  seal?: string
}

// exported so RankCoin.tsx can borrow the rim tuples for name-coins without
// re-declaring the same color values a second time.
export const MAT: Record<GamificationBadgeRarity, MaterialDef> = {
  common:    { name:'石墨',       rim:['#B8BBC4','#73767F','#40434B'], field:['#1D1D25','#0E0E13'], L:'#DEE0E6', D:'#5A5D66', H:'#F6F7FA', tick:'#3A3D45', inlay:null },
  rare:      { name:'银',         rim:['#FFFFFF','#BCC1CC','#6C7282'], field:['#1F2028','#0F1015'], L:'#F8F9FC', D:'#7A8090', H:'#FFFFFF', tick:'#4A505E', inlay:'#D5D9E2' },
  epic:      { name:'黑曜石镶金', rim:['#4C4C5A','#24242C','#0F0F13'], field:['#1A1A22','#0D0D11'], L:'#F0D38A', D:'#8A6A2C', H:'#FFF1C2', tick:'#5A4A2A', inlay:'#D2B06A' },
  legendary: { name:'足金',       rim:['#FFF0B8','#E4BE6A','#8E6626'], field:['#241E14','#120F0A'], L:'#FFEBB0', D:'#8C672A', H:'#FFFBEA', tick:'#6A4E22', inlay:'#F3D68F', sun:true, gems:true, rays:true },
  limited:   { name:'青铜火漆',   rim:['#F0BE8C','#B8763F','#5E3419'], field:['#2A1612','#170B09'], L:'#F5CFA6', D:'#7A4A2A', H:'#FFE9D2', tick:'#5A3A26', inlay:'#D89A66', sun:true, seal:'#D89A66' },
}

const ENAMEL: Record<string, [string, string]> = {
  evergreen: ['#2C6A4A', '#4F9A72'], discipline: ['#3A5B80', '#6A8DB5'],
  competition: ['#8A2D3B', '#C0555F'], seal: ['#6E2626', '#A24444'],
}

// 勋章 id -> 家族。id 集合与后端注册表（services/gamification/badges.py）/
// 前端镜像表（badgeRarity.ts）一一对应，17 条。
// Badge id -> family. The id set mirrors the backend registry
// (services/gamification/badges.py) / the frontend mirror (badgeRarity.ts),
// 17 entries.
const FAMILY: Record<string, BadgeFamily> = {
  profile_complete: 'growth', first_close: 'growth', first_real_trade: 'growth', comp_finisher: 'competition',
  evergreen_3m: 'evergreen', discipline_90_7: 'discipline', hundred_wins: 'performance', midas_touch: 'performance', profit_factor_2: 'performance',
  evergreen_6m: 'evergreen', discipline_90_30: 'discipline', no_bad_sl_50: 'discipline', comp_podium: 'competition',
  evergreen_12m: 'evergreen', comp_winner: 'competition', comp_back_to_back: 'competition', founder_2026: 'limited',
}

const FAM_ENAMEL: Partial<Record<BadgeFamily, string>> = {
  evergreen: 'evergreen', discipline: 'discipline', competition: 'competition', limited: 'seal',
}

// 未知 id 的兜底家族——圆章 + 素圈纹章，绝不抛错。
// Fallback family for an unknown id — a plain coin with a bare-ring emblem, never throws.
const FALLBACK_FAMILY: BadgeFamily = 'growth'

export const BADGE_FAMILY: Record<string, BadgeFamily> = FAMILY

export function FAMILY_OF(id: string): BadgeFamily {
  return FAMILY[id] ?? FALLBACK_FAMILY
}

// ---------------- 几何 ----------------
export const P = (r: number, a: number, cx = 32, cy = 32): [number, number] => {
  const t = (a - 90) * Math.PI / 180
  return [cx + r * Math.cos(t), cy + r * Math.sin(t)]
}
export const f = (n: number): string => (+n).toFixed(2)
export const sector = (R: number, r: number, a1: number, a2: number): string => {
  const [x1, y1] = P(R, a1), [x2, y2] = P(R, a2), [x3, y3] = P(r, a2), [x4, y4] = P(r, a1)
  const lg = (a2 - a1) > 180 ? 1 : 0
  return `M${f(x1)} ${f(y1)}A${R} ${R} 0 ${lg} 1 ${f(x2)} ${f(y2)}L${f(x3)} ${f(y3)}A${r} ${r} 0 ${lg} 0 ${f(x4)} ${f(y4)}Z`
}
export const poly = (n: number, r: number, rot = 0): string => {
  let d = ''
  for (let i = 0; i < n; i++) { const [x, y] = P(r, rot + i * 360 / n); d += (i ? 'L' : 'M') + f(x) + ' ' + f(y) }
  return d + 'Z'
}
export const starN = (n: number, R: number, r: number, rot = 0): string => {
  let d = ''
  for (let i = 0; i < 2 * n; i++) { const [x, y] = P(i % 2 ? r : R, rot + i * 180 / n); d += (i ? 'L' : 'M') + f(x) + ' ' + f(y) }
  return d + 'Z'
}
export const scallop = (n: number, r: number, amp: number): string => {
  let d = ''
  for (let i = 0; i < n; i++) {
    const a = i * 360 / n, b = (i + 1) * 360 / n
    const [x1, y1] = P(r, a), [cx, cy] = P(r + amp, (a + b) / 2), [x2, y2] = P(r, b)
    d += (i ? '' : `M${f(x1)} ${f(y1)}`) + `Q${f(cx)} ${f(cy)} ${f(x2)} ${f(y2)}`
  }
  return d + 'Z'
}
type Pt = [number, number]
type CubicPts = [Pt, Pt, Pt, Pt]
export const bez = (p: CubicPts, t: number): Pt => {
  const [a, b, c, d] = p; const u = 1 - t
  return [u * u * u * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t * t * t * d[0],
          u * u * u * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t * t * t * d[1]]
}
export const bezT = (p: CubicPts, t: number): Pt => {
  const [a, b, c, d] = p; const u = 1 - t
  return [3 * u * u * (b[0] - a[0]) + 6 * u * t * (c[0] - b[0]) + 3 * t * t * (d[0] - c[0]),
          3 * u * u * (b[1] - a[1]) + 6 * u * t * (c[1] - b[1]) + 3 * t * t * (d[1] - c[1])]
}
export const leaf = (x: number, y: number, ang: number, L: number, w: number): string =>
  `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(ang)})"><path d="M0 0C${f(L * .3)} ${f(-w)} ${f(L * .72)} ${f(-w * .95)} ${f(L)} 0C${f(L * .72)} ${f(w * .95)} ${f(L * .3)} ${f(w)} 0 0Z" fill="{E}"/><path d="M${f(L * .1)} 0L${f(L * .86)} 0" stroke="{D}" stroke-width=".55" opacity=".9"/><path d="M${f(L * .28)} ${f(-w * .55)}L${f(L * .34)} ${f(-w * .05)}M${f(L * .5)} ${f(-w * .62)}L${f(L * .56)} ${f(-w * .05)}M${f(L * .28)} ${f(w * .55)}L${f(L * .34)} ${f(w * .05)}M${f(L * .5)} ${f(w * .62)}L${f(L * .56)} ${f(w * .05)}" stroke="{D}" stroke-width=".35" opacity=".6"/></g>`
export const sprig = (p: CubicPts, n: number, side: number, L = 6.2, w = 2.2, stemW = 1.4): string => {
  let s = `<path d="M${f(p[0][0])} ${f(p[0][1])}C${f(p[1][0])} ${f(p[1][1])} ${f(p[2][0])} ${f(p[2][1])} ${f(p[3][0])} ${f(p[3][1])}" fill="none" stroke="{G}" stroke-width="${stemW}" stroke-linecap="round"/>`
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n
    const [x, y] = bez(p, t)
    const [dx, dy] = bezT(p, t)
    const ang = Math.atan2(dy, dx) * 180 / Math.PI
    const sd = side === 0 ? (i % 2 ? 1 : -1) : side
    s += leaf(x, y, ang + sd * 52, L * (0.85 + 0.15 * Math.sin(t * Math.PI)), w)
  }
  return s
}
export const star5 = (cx: number, cy: number, R: number, r = R * .42): string => {
  let d = ''
  for (let i = 0; i < 10; i++) { const [x, y] = P(i % 2 ? r : R, i * 36, cx, cy); d += (i ? 'L' : 'M') + f(x) + ' ' + f(y) }
  return d + 'Z'
}
export const gem = (cx: number, cy: number, s = 1, col = '{E}'): string =>
  `<g transform="translate(${f(cx)} ${f(cy)}) scale(${s})"><path d="M0-3.2L2.7 0 0 3.2-2.7 0z" fill="${col}"/><path d="M0-3.2L2.7 0 0 0z" fill="#fff" opacity=".35"/><path d="M0 0L0 3.2-2.7 0z" fill="#000" opacity=".28"/><path d="M0-3.2L2.7 0 0 3.2-2.7 0z" fill="none" stroke="{H}" stroke-width=".4" opacity=".7"/></g>`
export const crown = (cx: number, cy: number, s = 1): string => `<g transform="translate(${f(cx)} ${f(cy)}) scale(${s})">
    <path d="M-13 9V-6l6 6 3.6-10.5L0-3l3.4-7.5L7 0l6-6V9z" fill="{G}"/><path d="M-13 9V-6l6 6 3.6-10.5L0-3l3.4-7.5L7 0l6-6V9z" fill="none" stroke="{D}" stroke-width=".5" opacity=".8"/>
    <path d="M-13 5h26v5h-26z" fill="{D}" opacity=".55"/><path d="M-13 5h26" stroke="{H}" stroke-width=".5" opacity=".7"/>
    <circle cx="-13" cy="-6" r="1.4" fill="{H}"/><circle cx="-7" cy="-10.5" r="1.4" fill="{H}"/><circle cx="0" cy="-10.5" r="1.7" fill="{H}"/><circle cx="7" cy="-10.5" r="1.4" fill="{H}"/><circle cx="13" cy="-6" r="1.4" fill="{H}"/>
    ${gem(-6.5, 7, .62)}${gem(0, 7, .75)}${gem(6.5, 7, .62)}<path d="M-3 -2Q0 1 3 -2" fill="none" stroke="{D}" stroke-width=".5" opacity=".6"/></g>`

// ---------------- 纹章 ----------------
interface EmblemDef { off: [number, number]; art: string }

const EMB: Record<string, EmblemDef> = {
  profile_complete: { off: [0, .4], art: `
    <ellipse cx="32" cy="32" rx="11.5" ry="14.5" fill="none" stroke="{G}" stroke-width="2.2"/><ellipse cx="32" cy="32" rx="9.6" ry="12.6" fill="none" stroke="{D}" stroke-width=".5" opacity=".7"/>
    ${[0, 36, 72, 108, 144, 180, 216, 252, 288, 324].map(a => { const t = (a - 90) * Math.PI / 180; return `<circle cx="${f(32 + Math.cos(t) * 11.5)}" cy="${f(32 + Math.sin(t) * 14.5)}" r=".95" fill="{H}"/>` }).join('')}
    <path d="M32 21.8c2.9 0 4.7 2.4 4.7 5.1 0 2.2-1 4-2.6 4.9v1.7c4.2.9 6.9 3.7 7.7 8.1-2.6 1.9-6 2.9-9.8 2.9s-7.2-1-9.8-2.9c.8-4.4 3.5-7.2 7.7-8.1v-1.7c-1.6-.9-2.6-2.7-2.6-4.9 0-2.7 1.8-5.1 4.7-5.1z" fill="{G}"/>
    <path d="M29.1 26.9c0 2.2 1 4 2.6 4.9M26.6 41.2c1.4-3 3.4-4.8 5.4-5.2" fill="none" stroke="{D}" stroke-width=".5" opacity=".7"/>` },
  first_close: { off: [0, -1.2], art: `
    <path fill-rule="evenodd" d="M32 18.5a13.5 13.5 0 1 0 .01 0zM32 23.2a8.8 8.8 0 1 1-.01 0z" fill="{G}"/><path d="M32 18.5a13.5 13.5 0 1 0 .01 0z" fill="none" stroke="{D}" stroke-width=".5" opacity=".8"/><path d="M32 23.2a8.8 8.8 0 1 1-.01 0z" fill="none" stroke="{H}" stroke-width=".5" opacity=".6"/>
    <path d="M24.5 40.5h15a1.6 1.6 0 0 1 1.6 1.6v5a1.6 1.6 0 0 1-1.6 1.6h-15a1.6 1.6 0 0 1-1.6-1.6v-5a1.6 1.6 0 0 1 1.6-1.6z" fill="{G}"/><path d="M24.5 40.5h15a1.6 1.6 0 0 1 1.6 1.6v5a1.6 1.6 0 0 1-1.6 1.6h-15a1.6 1.6 0 0 1-1.6-1.6v-5a1.6 1.6 0 0 1 1.6-1.6z" fill="none" stroke="{D}" stroke-width=".5"/>
    <circle cx="27.3" cy="44.6" r="1" fill="{D}"/><circle cx="36.7" cy="44.6" r="1" fill="{D}"/><path d="M30.2 44.6l1.4 1.5 2.6-3" fill="none" stroke="{H}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>` },
  first_real_trade: { off: [0, 0], art: `
    <circle cx="32" cy="32" r="13.5" fill="{G}"/><circle cx="32" cy="32" r="13.5" fill="none" stroke="{D}" stroke-width=".6"/><circle cx="32" cy="32" r="11" fill="none" stroke="{D}" stroke-width=".6" opacity=".8"/>
    ${[...Array(24)].map((_, i) => `<line x1="32" y1="19.6" x2="32" y2="21" transform="rotate(${i * 15} 32 32)" stroke="{D}" stroke-width=".6"/>`).join('')}
    <path d="M30.2 25.2h3.6v13.6h-3.6z" fill="{D}"/><path d="M29.8 24.6h4.4v14.8h-4.4z" fill="none" stroke="{H}" stroke-width=".45" opacity=".7"/><path d="M27.6 24.6h8.8v2.1h-8.8zM27.6 37.3h8.8v2.1h-8.8z" fill="{D}"/>
    <path d="M43.5 22.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" fill="{H}"/>` },
  comp_finisher: { off: [0, 1.2], art: `
    <path d="M22 15.5v32" stroke="{G}" stroke-width="2.2" stroke-linecap="round"/><circle cx="22" cy="15.2" r="1.8" fill="{H}"/>
    <path d="M23.5 18.5c4-2.2 8 1.6 12-.4s6.5-2.2 9.5-.2v12.4c-3-2-6 .2-9.5 1.6s-8-1.6-12 .6z" fill="{E}"/>
    ${[[24.5, 20], [36.5, 18.3], [30.5, 24.6], [24.5, 30], [36.5, 28.3]].map(([x, y]) => `<path d="M${x} ${y}c1.9-.6 3.9-.4 5.5.2v4.6c-1.6-.6-3.6-.8-5.5-.2z" fill="{L}"/>`).join('')}
    <path d="M23.5 18.5c4-2.2 8 1.6 12-.4s6.5-2.2 9.5-.2v12.4c-3-2-6 .2-9.5 1.6s-8-1.6-12 .6z" fill="none" stroke="{D}" stroke-width=".6"/>` },
  evergreen_3m: { off: [1.4, 1.6], art: `${sprig([[23, 45], [24, 34], [32, 24], [42, 19]], 3, 0, 6.6, 2.4)}` },
  discipline_90_7: { off: [0, 1.2], art: `
    <circle cx="32" cy="15.6" r="2.4" fill="none" stroke="{G}" stroke-width="1.6"/><path d="M32 18v13.5" stroke="{G}" stroke-width="1.2"/>
    <path d="M27.8 31.5h8.4v2.6h-8.4z" fill="{G}"/><path d="M27.8 31.5h8.4v2.6h-8.4z" fill="none" stroke="{D}" stroke-width=".5"/>
    <path d="M28.2 34.1h7.6l-.8 5.6L32 48l-3-8.3z" fill="{E}"/><path d="M28.2 34.1h7.6l-.8 5.6L32 48l-3-8.3z" fill="none" stroke="{D}" stroke-width=".6"/>
    <path d="M30.2 35.2l1.1 4.4 1 6.6" stroke="{EL}" stroke-width=".6" opacity=".7"/><path d="M29.2 39.7h5.6" stroke="{H}" stroke-width=".7" opacity=".8"/>` },
  hundred_wins: { off: [-.7, -.6], art: `
    <path d="${sector(13.5, 8.4, -155, 155)}" transform="rotate(180 32 32)" fill="{G}"/><path d="${sector(13.5, 8.4, -155, 155)}" transform="rotate(180 32 32)" fill="none" stroke="{D}" stroke-width=".55"/>
    <path d="${sector(12.6, 9.3, -150, 150)}" transform="rotate(180 32 32)" fill="none" stroke="{H}" stroke-width=".4" opacity=".5"/>
    <path d="${star5(43.8, 32, 3.4)}" fill="{H}"/><path d="${star5(43.8, 32, 3.4)}" fill="none" stroke="{D}" stroke-width=".4"/><path d="${star5(41.2, 23.6, 1.9)}" fill="{H}"/><path d="${star5(41.2, 40.4, 1.9)}" fill="{H}"/>` },
  midas_touch: { off: [-1.9, 1.0], art: `
    <path d="M21 45.5l10.8-10.8" stroke="{G}" stroke-width="6.6" stroke-linecap="round"/><path d="M21 45.5l10.8-10.8" stroke="{D}" stroke-width=".6" opacity=".6"/>
    <path d="M29.4 32.4a2.7 2.7 0 0 1 3.6 3.6" fill="none" stroke="{H}" stroke-width=".9" stroke-linecap="round"/><path d="M18.6 46.6c-1.2-1.2-.8-3 0-3.8" fill="none" stroke="{H}" stroke-width=".7" opacity=".7"/>
    <circle cx="40.2" cy="24" r="6.2" fill="{G}"/><circle cx="40.2" cy="24" r="6.2" fill="none" stroke="{D}" stroke-width=".6"/><circle cx="40.2" cy="24" r="4.4" fill="none" stroke="{D}" stroke-width=".5" opacity=".7"/><path d="M39.2 21.2h2v5.6h-2z" fill="{D}"/>
    ${[0, 45, 90, 135].map(a => `<line x1="40.2" y1="14.2" x2="40.2" y2="16.4" transform="rotate(${a} 40.2 24)" stroke="{H}" stroke-width="1" stroke-linecap="round"/><line x1="40.2" y1="14.2" x2="40.2" y2="16.4" transform="rotate(${a + 180} 40.2 24)" stroke="{H}" stroke-width="1" stroke-linecap="round"/>`).join('')}` },
  profit_factor_2: { off: [-1.1, 1.4], art: `
    <path d="M32 19.5v22" stroke="{G}" stroke-width="1.8" stroke-linecap="round"/><path d="M24 44.5l2-3.5h12l2 3.5z" fill="{G}"/><path d="M24 44.5l2-3.5h12l2 3.5z" fill="none" stroke="{D}" stroke-width=".5"/><circle cx="32" cy="19" r="2.2" fill="{H}"/>
    <g transform="rotate(-9 32 23)"><path d="M18 23h28" stroke="{G}" stroke-width="1.8" stroke-linecap="round"/><path d="M18 23l-4 9M18 23l4 9M46 23l-4 9M46 23l4 9" stroke="{D}" stroke-width=".7"/>
      <path d="M11.5 32.5q6.5 6 13 0z" fill="{G}"/><path d="M11.5 32.5q6.5 6 13 0z" fill="none" stroke="{D}" stroke-width=".5"/><path d="M39.5 32.5q6.5 6 13 0z" fill="{G}"/><path d="M39.5 32.5q6.5 6 13 0z" fill="none" stroke="{D}" stroke-width=".5"/>
      <circle cx="18" cy="35.2" r="1.3" fill="{H}"/><circle cx="16" cy="35.2" r="1.3" fill="{H}"/><circle cx="20" cy="35.2" r="1.3" fill="{H}"/><circle cx="46" cy="34.6" r="1.1" fill="{D}"/></g>` },
  evergreen_6m: { off: [0, -1.0], art: `${sprig([[28, 47], [19, 40], [17, 27], [23, 18]], 3, -1, 6.2, 2.2)}${sprig([[36, 47], [45, 40], [47, 27], [41, 18]], 3, 1, 6.2, 2.2)}<path d="M28 47.5q4 2.5 8 0" fill="none" stroke="{G}" stroke-width="1.6" stroke-linecap="round"/>` },
  discipline_90_30: { off: [0, 0], art: `
    <rect x="15.5" y="27.5" width="33" height="9" rx="2" fill="{G}"/><rect x="15.5" y="27.5" width="33" height="9" rx="2" fill="none" stroke="{D}" stroke-width=".6"/>
    <rect x="15.5" y="27.5" width="3.2" height="9" fill="{D}" opacity=".5"/><rect x="45.3" y="27.5" width="3.2" height="9" fill="{D}" opacity=".5"/>
    <rect x="25" y="29.6" width="14" height="4.8" rx="2.4" fill="{E}"/><rect x="25" y="29.6" width="14" height="4.8" rx="2.4" fill="none" stroke="{D}" stroke-width=".5"/>
    <path d="M30.2 29.6v4.8M33.8 29.6v4.8" stroke="{H}" stroke-width=".5" opacity=".8"/><ellipse cx="32" cy="31.6" rx="2.2" ry="1.4" fill="{EL}"/><ellipse cx="31.3" cy="31.1" rx=".8" ry=".45" fill="#fff" opacity=".8"/>
    <path d="M17.5 32h4M42.5 32h4" stroke="{H}" stroke-width=".6" opacity=".7"/><path d="M32 21.5v4.6M32 38v4.5" stroke="{G}" stroke-width="1.4" stroke-linecap="round"/>` },
  no_bad_sl_50: { off: [0, -2.8], art: `
    <path d="M17 42l8.5-14 3.5 5.5 4.5-11.5 4 7.5 2.5-3.5L47 42z" fill="{E}"/><path d="M25.5 28l3.5 5.5 4.5-11.5 4 7.5 2.5-3.5" fill="none" stroke="{D}" stroke-width=".6" opacity=".8"/>
    <path d="M33.5 22l-1.6 4.1 1.9.7 1.5-2.4 1.2 2.3 1.4-1.9z" fill="{H}"/><path d="M25.5 28l-1.7 2.8 1.6.6 1.4-1.9z" fill="{H}"/>
    <path d="M33.5 22l-4 11.5-4.5-6L17 42h30z" fill="none" stroke="{D}" stroke-width=".6"/><path d="M36 32.5l-5.5 9.5" stroke="{D}" stroke-width=".5" opacity=".6"/>
    <path d="M15 45h34" stroke="{G}" stroke-width="3" stroke-linecap="round"/><path d="M15 45h34" stroke="{H}" stroke-width=".6" opacity=".6"/><path d="M15 42.5v5M49 42.5v5" stroke="{G}" stroke-width="1.8" stroke-linecap="round"/>` },
  comp_podium: { off: [0, -2.8], art: `
    <path d="M17.5 45.5v-8.8l2-1.6h7.5v10.4zM27 45.5V25.2l2-1.6h8l-2 1.6v20.3zM37 45.5V32.5l2-1.6h7.5v14.6z" fill="{G}"/>
    <path d="M17.5 36.7l2-1.6h7.5M27 25.2l2-1.6h8M37 32.5l2-1.6h7.5" fill="none" stroke="{H}" stroke-width=".6"/><path d="M19.5 35.1v10.4M29 23.6v21.9M39 30.9v14.6" fill="none" stroke="{D}" stroke-width=".55" opacity=".8"/>
    <path d="M17.5 45.5v-8.8l2-1.6h7.5v10.4zM27 45.5V25.2l2-1.6h8l-2 1.6v20.3zM37 45.5V32.5l2-1.6h7.5v14.6z" fill="none" stroke="{D}" stroke-width=".5"/>
    <path d="M29.6 26.4h5.4v2.2h-5.4z" fill="{E}"/><path d="${star5(32.3, 31.6, 2.3)}" fill="{H}"/><path d="M15 46h34" stroke="{D}" stroke-width=".8" opacity=".7"/>` },
  evergreen_12m: { off: [0, 0], art: `
    <circle cx="32" cy="32" r="8.6" fill="{G}"/><circle cx="32" cy="32" r="8.6" fill="none" stroke="{D}" stroke-width=".6"/><circle cx="32" cy="32" r="6.2" fill="none" stroke="{H}" stroke-width=".45" opacity=".6"/>
    ${[...Array(12)].map((_, i) => `<path d="M32 21.6l-2.1 4.2h4.2z" transform="rotate(${i * 30} 32 32)" fill="{G}"/><path d="M32 21.6l-2.1 4.2h4.2z" transform="rotate(${i * 30} 32 32)" fill="none" stroke="{D}" stroke-width=".4"/>`).join('')}
    ${[...Array(12)].map((_, i) => `<line x1="32" y1="20.4" x2="32" y2="17.2" transform="rotate(${i * 30 + 15} 32 32)" stroke="{E}" stroke-width="1.3" stroke-linecap="round"/>`).join('')}
    <circle cx="32" cy="32" r="2.6" fill="{H}"/>` },
  comp_winner: { off: [0, 2.3], art: `${crown(32, 31, 1.12)}` },
  comp_back_to_back: { off: [0, -2.0], art: `
    <path d="M22 44l-2.5 6h9l-1.5-6zM42 44l2.5 6h-9l1.5-6z" fill="{E}"/><path d="M22 44l-2.5 6h9l-1.5-6zM42 44l2.5 6h-9l1.5-6z" fill="none" stroke="{D}" stroke-width=".5"/>
    ${sprig([[26, 45], [18, 38], [17, 26], [24, 20]], 4, -1, 4.8, 1.7, 1.2)}${sprig([[38, 45], [46, 38], [47, 26], [40, 20]], 4, 1, 4.8, 1.7, 1.2)}${crown(32, 31.5, .82)}` },
  founder_2026: { off: [0, 2.0], art: `
    <path d="M24.5 21.5h15l3.8 19H20.7z" fill="{G}"/><path d="M24.5 21.5h15l3.8 19H20.7z" fill="none" stroke="{D}" stroke-width=".6"/><path d="M26.3 23.4h11.4l2.9 15.1H23.4z" fill="none" stroke="{H}" stroke-width=".45" opacity=".6"/>
    <path d="M24.5 21.5l1.8 1.9M39.5 21.5l-1.8 1.9M20.7 40.5l2.7-2M43.3 40.5l-2.7-2" stroke="{D}" stroke-width=".5" opacity=".8"/><path d="M27 31h10" stroke="{D}" stroke-width=".7"/><path d="M27 31.9h10" stroke="{H}" stroke-width=".5" opacity=".6"/>
    <path d="${star5(32, 14.6, 3.6)}" fill="{H}"/><path d="${star5(32, 14.6, 3.6)}" fill="none" stroke="{D}" stroke-width=".4"/>` },
}

// 未知 id 的兜底纹章：素圈，绝不抛错。
// Fallback emblem for an unknown id: a bare ring, never throws.
const FALLBACK_EMB: EmblemDef = {
  off: [0, 0],
  art: `<circle cx="32" cy="32" r="10.5" fill="none" stroke="{G}" stroke-width="2.2"/><circle cx="32" cy="32" r="10.5" fill="none" stroke="{D}" stroke-width=".5" opacity=".7"/>`,
}

// ---------------- 形状（= 家族） ----------------
const SHIELD = 'M32 4.5C40.5 4.5 48 6.6 52.5 9V30.5C52.5 46.5 42.5 55.5 32 60.5C21.5 55.5 11.5 46.5 11.5 30.5V9C16 6.6 23.5 4.5 32 4.5Z'
const HEX = 'M32 3.5L55.5 17.5V46.5L32 60.5L8.5 46.5V17.5Z'
const inset = (d: string, s: number): string => `<path d="${d}" transform="translate(32 32) scale(${s}) translate(-32 -32)"`

interface ShapeDef {
  kind: 'round' | 'laurel' | 'path' | 'star' | 'seal'
  R?: number
  d?: string
  emb: number
  fieldS?: number
  bevelS?: number
  gemR: number
}

const SHAPES: Record<BadgeFamily, ShapeDef> = {
  growth:      { kind: 'round',  R: 29,  emb: 1.06, gemR: 25.6 },
  evergreen:   { kind: 'laurel', R: 29,  emb: .92,  gemR: 23.2 },
  discipline:  { kind: 'path',   d: SHIELD, emb: .9,  fieldS: .84, bevelS: .92, gemR: 22 },
  performance: { kind: 'path',   d: HEX,    emb: .92, fieldS: .84, bevelS: .92, gemR: 22 },
  competition: { kind: 'star',   emb: .88,  gemR: 22.5 },
  limited:     { kind: 'seal',   emb: .98,  gemR: 22 },
}

// ---------------- 渲染 ----------------
export interface RenderMedalOpts {
  earned?: boolean
  spin?: boolean
  upTo?: number
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

/**
 * 渲染一枚勋章的 SVG *内层*标记（defs + 六层：环缘/底座 → 切面+倒角 →
 * 流光（被底板遮住）→ 底板+雕花 → 浮雕纹章 → 高光/宝石/闪光）。外层 <svg>
 * 由调用方（BadgeIcon.tsx）负责，因为 width/height/viewBox/role/aria-label
 * 这些是 React 该管的事，不该塞进字符串模板。
 *
 * Renders one badge's SVG *inner* markup (defs + six layers: rim/mount →
 * facets+bevel → sheen (hidden under the field) → field+engraving → relief
 * emblem → highlight/gems/flash). The outer <svg> is the caller's
 * (BadgeIcon.tsx) job — width/height/viewBox/role/aria-label belong to
 * React, not a string template.
 *
 * @param key 调用方传入的唯一片段（通常是 React useId()），替代原设计稿里
 *   的模块级自增计数器，用于给这枚勋章自己的渐变/裁剪 id 加前缀，避免同页
 *   多枚勋章的 <defs> 相互冲突。
 *   A unique fragment from the caller (typically React's useId()),
 *   replacing the design reference's module-level auto-increment counter —
 *   prefixes this medal's own gradient/clip ids so multiple badges on one
 *   page don't collide in <defs>.
 */
export function renderMedalInner(
  id: string,
  rarity: GamificationBadgeRarity,
  size: number,
  key: string,
  opts: RenderMedalOpts = {},
): string {
  const m = MAT[rarity] ?? MAT.common
  // useId() 之类的 key 可能带冒号（如 ":r1:"），拼进 SVG id 前先去掉非
  // id-safe 字符，保留一个稳定前缀。
  // A caller key like useId()'s may carry colons (":r1:") — strip
  // non-id-safe characters before splicing it into an SVG id.
  const k = 'm' + key.replace(/[^a-zA-Z0-9_-]/g, '')
  const big = size >= 40
  const fam = FAMILY[id] ?? FALLBACK_FAMILY
  const sh = SHAPES[fam]
  const enKey = FAM_ENAMEL[fam]
  const en = enKey ? ENAMEL[enKey] : null
  const E = en ? en[0] : m.L, EL = en ? en[1] : m.H

  const tone = (s: string, G: string) => s.replace(/\{G\}/g, G).replace(/\{L\}/g, m.L).replace(/\{D\}/g, m.D).replace(/\{H\}/g, m.H).replace(/\{EL\}/g, EL).replace(/\{E\}/g, E)
  const shadow = (s: string) => s.replace(/\{G\}|\{L\}|\{H\}|\{EL\}|\{E\}|\{D\}/g, m.D)

  const embDef = EMB[id] ?? FALLBACK_EMB
  const [ox, oy] = embDef.off
  const art = embDef.art
  const emblem = `<g class="emb"><g transform="translate(32 32) scale(${sh.emb}) translate(${-32 + ox} ${-32 + oy})"><g transform="translate(1 1)" opacity=".55">${shadow(art)}</g><g>${tone(art, `url(#${k}-g)`)}</g></g></g>`

  let outerD = '', mount = '', ticks = '', bevel = '', fieldD: string | null = null, fieldClipD = '', inlay = '', deco = ''

  if (sh.kind === 'round') {
    const R = sh.R as number
    outerD = `M32 ${32 - R}a${R} ${R} 0 1 0 .01 0z`
    let t = ''
    for (let i = 0; i < 60; i++) { t += `<line x1="32" y1="${f(32 - R + .4)}" x2="32" y2="${f(32 - R + 3)}" transform="rotate(${i * 6} 32 32)"/>` }
    ticks = `<g stroke="${m.tick}" stroke-width="1" opacity=".9">${t}</g>`
    bevel = `<circle cx="32" cy="32" r="${R - 2.1}" fill="none" stroke="url(#${k}-b)" stroke-width="1.9"/><circle cx="32" cy="32" r="${R - 3.15}" fill="none" stroke="${m.H}" stroke-width=".45" opacity=".55"/>`
    const fr = R - 3.6
    fieldD = `M32 ${32 - fr}a${fr} ${fr} 0 1 0 .01 0z`
    fieldClipD = fieldD
    inlay = `<circle cx="32" cy="32" r="${f(fr - 3)}" fill="none" stroke="${m.inlay || m.rim[2]}" stroke-width="${m.inlay ? .9 : .8}" opacity="${m.inlay ? .8 : .6}"/>`
  } else if (sh.kind === 'laurel') {
    const R = 27.5
    outerD = `M32 ${32 - R}a${R} ${R} 0 1 0 .01 0z`
    // 环缘即桂冠：16 片叶沿切线排布（珐琅绿 + 金属叶脉）
    let lv = ''
    for (let i = 0; i < 16; i++) { const a = i * 22.5; const [x, y] = P(24.6, a); lv += leaf(x, y, a - 90 + 8, 7.6, 2.7) }
    deco = `<g>${tone(lv, `url(#${k}-g)`)}</g>`
    bevel = `<circle cx="32" cy="32" r="21.9" fill="none" stroke="url(#${k}-b)" stroke-width="1.6"/><circle cx="32" cy="32" r="21" fill="none" stroke="${m.H}" stroke-width=".45" opacity=".55"/>`
    const fr = 20.6
    fieldD = `M32 ${32 - fr}a${fr} ${fr} 0 1 0 .01 0z`
    fieldClipD = fieldD
    inlay = `<circle cx="32" cy="32" r="${f(fr - 2.6)}" fill="none" stroke="${m.inlay || m.rim[2]}" stroke-width=".8" opacity=".7"/>`
  } else if (sh.kind === 'path') {
    const d = sh.d as string
    outerD = d
    const bevelS = sh.bevelS as number
    bevel = `${inset(d, bevelS)} fill="none" stroke="url(#${k}-b)" stroke-width="1.8"/>${inset(d, bevelS - .035)} fill="none" stroke="${m.H}" stroke-width=".45" opacity=".55"/>`
    // 切面：从顶点向内的棱线
    if (fam === 'performance') {
      ticks = `<g stroke="${m.rim[2]}" stroke-width=".7" opacity=".7">${[[32, 3.5], [55.5, 17.5], [55.5, 46.5], [32, 60.5], [8.5, 46.5], [8.5, 17.5]].map(([x, y]) => `<line x1="${x}" y1="${y}" x2="${f(32 + (x - 32) * bevelS)}" y2="${f(32 + (y - 32) * bevelS)}"/>`).join('')}</g>`
    } else {
      ticks = `<g stroke="${m.tick}" stroke-width=".9" opacity=".85">${[...Array(22)].map((_, i) => { const [x1, y1] = P(27.2, i * 360 / 22), [x2, y2] = P(29.2, i * 360 / 22); return `<line x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}"/>` }).join('')}</g>`
    }
    fieldD = null
    fieldClipD = d
    const fieldS = sh.fieldS as number
    inlay = `${inset(d, fieldS - .1)} fill="none" stroke="${m.inlay || m.rim[2]}" stroke-width="${m.inlay ? .9 : .8}" opacity="${m.inlay ? .8 : .6}"/>`
  } else if (sh.kind === 'star') {
    outerD = starN(8, 31, 23.5, 22.5)
    bevel = `<path d="${starN(8, 28.6, 21.6, 22.5)}" fill="none" stroke="url(#${k}-b)" stroke-width="1.6"/><path d="${starN(8, 27.6, 20.9, 22.5)}" fill="none" stroke="${m.H}" stroke-width=".45" opacity=".55"/>`
    ticks = `<g stroke="${m.rim[2]}" stroke-width=".6" opacity=".7">${[...Array(8)].map((_, i) => { const [x, y] = P(31, 22.5 + i * 45), [x2, y2] = P(20.5, 22.5 + i * 45); return `<line x1="${f(x)}" y1="${f(y)}" x2="${f(x2)}" y2="${f(y2)}"/>` }).join('')}</g>`
    const fr = 20.2
    fieldD = `M32 ${32 - fr}a${fr} ${fr} 0 1 0 .01 0z`
    fieldClipD = fieldD
    inlay = `<circle cx="32" cy="32" r="${f(fr - 2.6)}" fill="none" stroke="${m.inlay || m.rim[2]}" stroke-width="${m.inlay ? .9 : .8}" opacity="${m.inlay ? .8 : .6}"/>`
  } else if (sh.kind === 'seal') {
    outerD = scallop(30, 27.6, 1.1)
    bevel = `<circle cx="32" cy="32" r="25.9" fill="none" stroke="url(#${k}-b)" stroke-width="1.4"/><circle cx="32" cy="32" r="25" fill="none" stroke="${m.H}" stroke-width=".4" opacity=".5"/>`
    const fr = 24.6
    fieldD = `M32 ${32 - fr}a${fr} ${fr} 0 1 0 .01 0z`
    fieldClipD = fieldD
    inlay = `<circle cx="32" cy="32" r="${f(fr - 3)}" fill="none" stroke="${m.inlay}" stroke-width=".9" opacity=".8"/>`
    const [e0, e1] = ENAMEL.seal
    mount = `<g><path d="M24 46l-7 16h10l3-6z" fill="${e0}"/><path d="M40 46l7 16H37l-3-6z" fill="${e0}"/><path d="M24 46l-7 16M40 46l7 16" stroke="${m.rim[1]}" stroke-width=".9"/><path d="M27 62l3-6M37 62l-3-6" stroke="${e1}" stroke-width=".8" opacity=".8"/><path d="M17 62h10M37 62h10" stroke="${m.rim[1]}" stroke-width=".8"/></g>`
  }

  // 传说：星芒底座（星形本身已是芒，不叠）
  if (m.rays && sh.kind !== 'star') {
    let rays = ''
    const base = sh.kind === 'laurel' ? 26.5 : 26.5
    for (let i = 0; i < 24; i++) {
      const long = i % 6 === 0
      const R2 = long ? 32 : 30.2
      const [x1, y1] = P(R2, i * 15), [x2, y2] = P(base, i * 15 - 3.3), [x3, y3] = P(base, i * 15 + 3.3)
      rays += `<path d="M${f(x2)} ${f(y2)}L${f(x1)} ${f(y1)}L${f(x3)} ${f(y3)}Z"/>`
    }
    mount = `<g fill="url(#${k}-r)" stroke="${m.rim[2]}" stroke-width=".35">${rays}</g>` + mount
  }

  const outer = `${mount}<path d="${outerD}" fill="url(#${k}-r)"/><path d="${outerD}" fill="none" stroke="${m.rim[2]}" stroke-width=".55" opacity=".8"/>`
  const field = fieldD ? `<path d="${fieldD}" fill="url(#${k}-f)"/>` : `${inset(sh.d as string, sh.fieldS as number)} fill="url(#${k}-f)"/>`

  let sun = ''
  if (m.sun) {
    for (let i = 0; i < 48; i++) { sun += `<line x1="32" y1="26" x2="32" y2="6" transform="rotate(${i * 7.5} 32 32)"/>` }
    sun = `<g stroke="${m.L}" stroke-width=".8" opacity="${rarity === 'limited' ? '.10' : '.14'}">${sun}</g>`
  }
  let guil = ''
  if (rarity === 'epic' || rarity === 'rare') {
    for (let i = 0; i < 10; i++) { guil += `<ellipse cx="32" cy="32" rx="21" ry="7.5" transform="rotate(${i * 18} 32 32)"/>` }
    guil = `<g fill="none" stroke="${m.inlay}" stroke-width=".45" opacity="${rarity === 'epic' ? '.16' : '.10'}">${guil}</g>`
  }
  const legend = (fam === 'limited' && big)
    ? `<defs><path id="${k}-arc" d="M11.6 40.5A22 22 0 1 1 52.4 40.5"/></defs><text font-family="JetBrains Mono, ui-monospace, monospace" font-size="3.55" letter-spacing=".5" fill="${m.L}" opacity=".95"><textPath href="#${k}-arc" startOffset="50%" text-anchor="middle">PRISMX · MMXXVI · FOUNDING MEMBER</textPath></text>`
    : (fam === 'limited' ? `<circle cx="32" cy="32" r="22.6" fill="none" stroke="${m.seal}" stroke-width="1" stroke-dasharray="1.8 2.6" opacity=".9"/>` : '')
  const gems = (m.gems && big) ? [45, 135, 225, 315].map(a => { const [x, y] = P(sh.gemR, a); return gem(x, y, .8, '{E}') }).join('').replace(/\{E\}/g, ENAMEL.competition[0]).replace(/\{H\}/g, m.H) : ''
  const spin = opts.spin && !prefersReducedMotion() ? `<animateTransform attributeName="transform" type="rotate" from="0 32 32" to="360 32 32" dur="16s" repeatCount="indefinite"/>` : ''
  const sheen = `<g class="sheen" clip-path="url(#${k}-cp)"><g>${spin}<rect x="-12" y="4" width="88" height="11" fill="url(#${k}-s)" opacity=".5" transform="rotate(-45 32 32)"/><rect x="-12" y="49" width="88" height="11" fill="url(#${k}-d)" opacity=".45" transform="rotate(-45 32 32)"/></g></g>`
  const upTo = opts.upTo ?? 99

  const L: string[] = []
  L.push(outer)                                                                 // 0 环缘/底座
  L.push(`${deco}${ticks}${bevel}`)                                             // 1 桂叶/切面/齿边 + 倒角
  L.push(sheen)                                                                 // 2 流光（在底板之下，只照亮环缘）
  L.push(`<g class="fieldwrap">${field}<g clip-path="url(#${k}-fc)">${sun}${guil}</g>${inlay}${legend}</g>`) // 3 底板与雕花
  L.push(emblem)                                                                // 4 浮雕纹章
  L.push(`${gems}<path d="M13.5 20.5A22 22 0 0 1 24 10.4" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity=".32"/><path class="flash" d="${fieldClipD}" fill="url(#${k}-fl)" opacity="0"/>`) // 5 高光/宝石/闪光

  return `<defs>
      <linearGradient id="${k}-r" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${m.rim[0]}"/><stop offset=".55" stop-color="${m.rim[1]}"/><stop offset="1" stop-color="${m.rim[2]}"/></linearGradient>
      <linearGradient id="${k}-b" x1="1" y1="1" x2="0" y2="0"><stop offset="0" stop-color="${m.rim[0]}"/><stop offset="1" stop-color="${m.rim[2]}"/></linearGradient>
      <radialGradient id="${k}-f" cx=".42" cy=".36" r=".78"><stop offset="0" stop-color="${m.field[0]}"/><stop offset="1" stop-color="${m.field[1]}"/></radialGradient>
      <linearGradient id="${k}-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${m.H}"/><stop offset=".45" stop-color="${m.L}"/><stop offset="1" stop-color="${m.D}"/></linearGradient>
      <linearGradient id="${k}-s" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
      <linearGradient id="${k}-d" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset=".5" stop-color="#000" stop-opacity=".6"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
      <radialGradient id="${k}-fl" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#fff" stop-opacity=".95"/><stop offset=".55" stop-color="#fff" stop-opacity=".35"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
      <clipPath id="${k}-cp"><path d="${outerD}"/></clipPath><clipPath id="${k}-fc"><path d="${fieldClipD}"/></clipPath>
    </defs>${L.slice(0, upTo + 1).join('')}`
}
