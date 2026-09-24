// 节日插画 / festival illustrations
//
// 全部手绘 SVG，按「部件」组织：南瓜、灯笼、月亮、玉兔、松树、烟花……Logo 彩蛋、
// 问候卡、空状态、落地页布景都从同一批部件拼出来，所以笔触、配色、比例处处一致。
// All hand-drawn SVG, organised as parts. The logo ornament, greeting card,
// empty state and landing set dressing are all built from the same parts, so
// line weight, palette and proportion match everywhere.
//
// 风格沿用产品的「颜料，不是光」：实色面 + 细线，渐变只用在物体自身的体积上，
// 不给界面加外发光。唯一的例外是**真实光源**（南瓜里的烛火、灯串的灯泡），
// 它们本来就会照亮周围，而且只照亮插画内部，不照亮任何界面元素。
// Style follows "pigment, not glow": flat fills and hairlines, gradients only
// for an object's own volume, no glow on interface. The one exception is real
// light sources (candlelight in a pumpkin, bulbs on a string), which do light
// their surroundings, and only inside the illustration.
//
// 需要被动画单独驱动的部位都挂了 fa-* 类（翅膀、灯笼穗、兔耳、眼睛……），
// 由 motion.ts 的 GSAP 时间线或 festival.css 的循环动画取用。
// Parts that animate independently carry fa-* classes (wings, tassels, ears,
// eyes…), picked up by the GSAP timelines in motion.ts or the loops in
// festival.css.
//
// 输出是字符串，由 <SvgArt> 以 innerHTML 挂载：内容全部来自本文件的常量，没有
// 任何外部输入。
// Output is strings mounted by <SvgArt> via innerHTML; every byte comes from
// constants in this file, never from external input.

import type { FestivalKey } from './calendar'

export type ArtKey = FestivalKey | 'none'

// ── 工具 / utilities ─────────────────────────────────────────────────────────

// 确定性随机：同一个种子每次画出同一片星空，重渲染时画面不跳。
// Deterministic PRNG so a starfield is identical on every render.
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const r1 = (n: number) => Math.round(n * 10) / 10

// 同一文档里会同时存在多份 SVG，渐变 / 裁剪的 id 必须带实例前缀。
// Many SVGs share one document, so gradient/clip ids carry a per-instance prefix.
let uid = 0
const prefix = () => 'fa' + ++uid + '-'

function svg(viewBox: string, body: string, cls = '', extra = '') {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + viewBox + '" class="' + cls +
    '" aria-hidden="true" focusable="false" ' + extra + '>' + body + '</svg>'
  )
}

const T = (x: number, y: number, s = 1, rot = 0) =>
  'translate(' + r1(x) + ' ' + r1(y) + ')' + (rot ? ' rotate(' + rot + ')' : '') + (s !== 1 ? ' scale(' + s + ')' : '')

function stars(n: number, w: number, maxY: number, seed: number, color: string) {
  const rand = rng(seed)
  let out = ''
  for (let i = 0; i < n; i++) {
    const x = r1(rand() * w)
    const y = r1(rand() * maxY)
    const r = r1(0.6 + rand() * 1.2)
    const tw = rand() > 0.5
    out +=
      '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + color + '" opacity="' + r1(0.3 + rand() * 0.5) + '"' +
      (tw ? ' class="fa-twinkle" style="animation-delay:-' + r1(rand() * 5) + 's;animation-duration:' + r1(2.8 + rand() * 3) + 's"' : '') +
      '/>'
  }
  return out
}

export function sparklePath(r: number) {
  const k = r * 0.26
  return (
    'M0 ' + -r + ' C' + k + ' ' + -k + ' ' + k + ' ' + -k + ' ' + r + ' 0 C' + k + ' ' + k + ' ' + k + ' ' + k + ' 0 ' + r +
    ' C' + -k + ' ' + k + ' ' + -k + ' ' + k + ' ' + -r + ' 0 C' + -k + ' ' + -k + ' ' + -k + ' ' + -k + ' 0 ' + -r + ' Z'
  )
}

function sparkle(x: number, y: number, r: number, color: string, cls = 'fa-twinkle', delay = 0) {
  return (
    '<g transform="' + T(x, y) + '"><path class="' + cls + '" style="animation-delay:' + delay + 's" d="' + sparklePath(r) +
    '" fill="' + color + '"/></g>'
  )
}

// ── 调色 / palette ───────────────────────────────────────────────────────────

export const GOLD = '#F2CC72'
export const GOLD_DEEP = '#C9962F'
const PUMPKIN = { lobe: '#D8662A', core: '#EE7B34', rib: '#B24A18', hi: '#FFB072', stem: '#6B7445', carve: '#3A1A08', light: '#FFC75E' }
const PINE_C = '#1F4A40'
const PINE_SHADE = '#1A3F37'

// ── 部件：万圣节 / parts: Halloween ─────────────────────────────────────────

const CARVED =
  '<path d="M-25 -7 L-11 -7 L-18 -21 Z"/>' +
  '<path d="M11 -7 L25 -7 L18 -21 Z"/>' +
  '<path d="M-3.5 3 L3.5 3 L0 -4 Z"/>' +
  '<path d="M-28 9 Q0 34 28 9 L19 11 L15 18 L9 12 L-9 12 L-15 18 L-19 11 Z"/>'

// 南瓜：每一瓣都有自己的明暗，刻出来的脸从里面被烛光照亮，刻口内壁有一圈受光的
// 斜面；瓜蒂有纹理，旁边一截卷须和一片叶子。
// Pumpkin: each lobe carries its own light and shade, the carved face is lit
// from inside with a lit bevel around each cut, and the stem has texture, a
// curling tendril and a leaf beside it.
export function pumpkin(x: number, y: number, s: number, face: boolean, p: string, opts: { glow?: boolean; delay?: number } = {}) {
  const P = PUMPKIN
  return (
    '<defs>' +
    '<radialGradient id="' + p + 'pl" cx=".32" cy=".28" r=".85"><stop offset="0" stop-color="#F9A15A"/><stop offset=".55" stop-color="#E0702E"/><stop offset="1" stop-color="#A9481A"/></radialGradient>' +
    '<radialGradient id="' + p + 'pc" cx=".4" cy=".25" r=".85"><stop offset="0" stop-color="#FFB56C"/><stop offset=".5" stop-color="#F08238"/><stop offset="1" stop-color="#C45A20"/></radialGradient>' +
    '<radialGradient id="' + p + 'pi" cx=".5" cy=".55" r=".6"><stop offset="0" stop-color="#FFF6C2"/><stop offset=".45" stop-color="#FFD06A"/><stop offset="1" stop-color="#F29233"/></radialGradient>' +
    '<linearGradient id="' + p + 'ps" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9AA25C"/><stop offset="1" stop-color="#4E5A2E"/></linearGradient>' +
    (opts.glow && face
      ? '<radialGradient id="' + p + 'pglow"><stop offset="0" stop-color="#FFB14A" stop-opacity=".34"/><stop offset="1" stop-color="#FFB14A" stop-opacity="0"/></radialGradient>'
      : '') +
    '</defs>' +
    '<g transform="' + T(x, y, s) + '"><g class="fa-pumpkin">' +
    (opts.glow && face ? '<ellipse class="fa-candle-pool" cx="0" cy="36" rx="120" ry="22" fill="url(#' + p + 'pglow)"/>' : '') +
    '<ellipse cx="0" cy="36" rx="56" ry="7" fill="#000" opacity=".42"/>' +
    '<path d="M8 -52 C18 -64 30 -60 30 -50 C30 -44 24 -44 23 -48" fill="none" stroke="#5E6B34" stroke-width="2.2" stroke-linecap="round"/>' +
    '<path d="M-6 -40 C-22 -52 -38 -46 -40 -36 C-28 -38 -16 -34 -6 -40 Z" fill="#5E7A3A"/><path d="M-8 -40 C-18 -42 -28 -40 -38 -37" fill="none" stroke="#7E9B55" stroke-width=".8"/>' +
    '<path d="M-3 -33 C-6 -44 -1 -53 8 -57 L12 -52 C5 -48 4 -42 6 -33 Z" fill="url(#' + p + 'ps)"/>' +
    '<path d="M1 -35 C0 -43 3 -49 7 -53 M4 -34 C4 -41 6 -46 9 -50" fill="none" stroke="#3F4A24" stroke-width=".7" opacity=".6"/>' +
    '<ellipse cx="-27" cy="1" rx="31" ry="36" fill="url(#' + p + 'pl)"/>' +
    '<ellipse cx="27" cy="1" rx="31" ry="36" fill="url(#' + p + 'pl)"/>' +
    '<ellipse cx="0" cy="0" rx="31" ry="38" fill="url(#' + p + 'pc)"/>' +
    '<g fill="none" stroke-linecap="round">' +
    '<g stroke="#9A3E14" stroke-width="2" opacity=".5"><path d="M-15 -34 C-23 -12 -23 12 -15 35"/><path d="M15 -34 C23 -12 23 12 15 35"/><path d="M-40 -28 C-53 -9 -53 11 -40 30"/><path d="M40 -28 C53 -9 53 11 40 30"/></g>' +
    '<g stroke="#FFC48E" stroke-width="1.4" opacity=".32"><path d="M-12 -32 C-19 -12 -19 12 -12 32"/><path d="M-36 -26 C-47 -9 -47 10 -36 27"/><path d="M18 -32 C25 -12 25 12 18 32"/></g>' +
    '</g>' +
    '<ellipse cx="-9" cy="-24" rx="8" ry="4" transform="rotate(-24 -9 -24)" fill="#fff" opacity=".2"/>' +
    (face
      ? '<g fill="' + P.carve + '" stroke="' + P.carve + '" stroke-width="3" stroke-linejoin="round">' + CARVED + '</g>' +
        '<g fill="url(#' + p + 'pi)" class="fa-flicker" style="animation-delay:-' + (opts.delay || 0) + 's">' + CARVED + '</g>' +
        '<g fill="none" stroke="#B5561A" stroke-width="1.1" stroke-linejoin="round" opacity=".7">' + CARVED + '</g>'
      : '') +
    '</g></g>'
  )
}

// 蝙蝠：左右翅膀是两个独立的组，绕翅根上下扇动，比整体 scaleY 真实得多。
// Bat: each wing is its own group flapping about its root, far more convincing
// than squashing the whole silhouette.
// 蝙蝠：翼膜是一段段扇贝形的弧，翼骨淡淡地画出来；左右翅膀各自绕翅根扇动。
// Bat: scalloped membrane between faint wing bones; each wing flaps about its root.
export function bat(color: string, flapDelay = 0, eye = '#F28A3A') {
  const wing = 'M2 -2 C6 -7 12 -11 18 -10 C21 -14 27 -15 32 -12 C29 -9 28 -5 29 -1 C26 -3 22 -2 20 1 C18 -2 14 -2 12 1 C9 -1 6 0 3 4 Z'
  const bones = 'M3 -1 L18 -10 M4 0 L20 1 M3.5 .6 L12 1 M18 -10 L31 -12'
  const d = 'style="animation-delay:-' + flapDelay + 's"'
  return (
    '<g fill="' + color + '">' +
    '<g class="fa-wing-r" ' + d + '><path d="' + wing + '"/><path d="' + bones + '" fill="none" stroke="#fff" stroke-opacity=".13" stroke-width=".7"/></g>' +
    '<g class="fa-wing-l" ' + d + '><g transform="scale(-1 1)"><path d="' + wing + '"/><path d="' + bones + '" fill="none" stroke="#fff" stroke-opacity=".13" stroke-width=".7"/></g></g>' +
    '<ellipse cx="0" cy="1.4" rx="4" ry="5.8"/>' +
    '<circle cx="0" cy="-4.6" r="3.4"/>' +
    '<path d="M-2.8 -6 L-3.9 -10.8 L-1 -7.6 Z M2.8 -6 L3.9 -10.8 L1 -7.6 Z"/>' +
    '<circle cx="-1.2" cy="-4.9" r=".62" fill="' + eye + '" opacity=".9"/><circle cx="1.2" cy="-4.9" r=".62" fill="' + eye + '" opacity=".9"/>' +
    '</g>'
  )
}

export function spiderSvg(threadLen: number) {
  let legs = ''
  ;[-1, 1].forEach((d) => {
    legs +=
      '<path d="M0 -2 C' + 8 * d + ' -10 ' + 12 * d + ' -8 ' + 15 * d + ' -2"/>' +
      '<path d="M0 0 C' + 9 * d + ' -4 ' + 13 * d + ' -1 ' + 16 * d + ' 5"/>' +
      '<path d="M0 2 C' + 9 * d + ' 2 ' + 12 * d + ' 6 ' + 14 * d + ' 11"/>' +
      '<path d="M0 3 C' + 7 * d + ' 6 ' + 9 * d + ' 11 ' + 10 * d + ' 16"/>'
  })
  return svg(
    '-30 0 60 ' + (threadLen + 40),
    '<line class="fa-thread" x1="0" y1="0" x2="0" y2="' + threadLen + '" stroke="#8A8494" stroke-width="1"/>' +
      '<g class="fa-spider" transform="translate(0 ' + (threadLen + 8) + ')">' +
      '<g class="fa-legs" fill="none" stroke="#3A3644" stroke-width="1.8" stroke-linecap="round">' + legs + '</g>' +
      '<ellipse cx="0" cy="2" rx="7" ry="8.5" fill="#0E0D12" stroke="#4A4555" stroke-width="1"/>' +
      '<circle cx="0" cy="-8" r="4.6" fill="#0E0D12" stroke="#4A4555" stroke-width="1"/>' +
      '<circle cx="-1.6" cy="-8.6" r="1" fill="#F28A3A"/><circle cx="1.6" cy="-8.6" r="1" fill="#F28A3A"/>' +
      '</g>',
    'fa-spider-svg',
    'overflow="visible"'
  )
}

// ── 部件：月亮与云 / parts: moon and clouds ─────────────────────────────────

// 月亮：柔和的径向体积、边缘融进去的月海、带亮边的环形山、右下角一点明暗交界，
// 外面一圈极淡的光晕——月亮是真光源，这是允许的那一种「光」。
// Moon: soft radial volume, maria that blend at their edges, craters with a lit
// rim, a touch of terminator shade toward the lower right, and a very faint halo
// — the moon is a real light source, the one kind of glow allowed here.
export function moon(p: string, cx: number, cy: number, r: number, tone: 'warm' | 'pale' = 'warm') {
  const c =
    tone === 'warm'
      ? { core: '#FFF9E6', mid: '#F7E8BC', edge: '#E6CC8C', rim: '#D2B272', mare: '#C4A15E', crater: '#D3B676', halo: '#F7E3AE' }
      : { core: '#FBF8EE', mid: '#EEE7D2', edge: '#D9CFB2', rim: '#C2B692', mare: '#B3A686', crater: '#C9BD9C', halo: '#E6E0CC' }
  const maria: [number, number, number, number, number][] = [
    [-0.3, -0.22, 0.27, 0.17, -18],
    [0.22, 0.28, 0.33, 0.2, 12],
    [0.34, -0.3, 0.15, 0.1, 30],
    [-0.22, 0.4, 0.16, 0.1, -10],
    [-0.52, 0.05, 0.1, 0.17, 8],
    [0.04, -0.02, 0.12, 0.08, -4],
  ]
  const craters: [number, number, number][] = [
    [0.12, -0.5, 0.05], [-0.58, -0.14, 0.04], [0.5, 0.1, 0.06], [-0.08, 0.18, 0.035],
    [0.3, -0.1, 0.03], [-0.38, 0.62, 0.045], [0.6, -0.42, 0.03], [-0.14, -0.62, 0.028],
  ]
  let m = ''
  maria.forEach(([dx, dy, rx, ry, rot]) => {
    m += '<ellipse cx="' + r1(cx + dx * r) + '" cy="' + r1(cy + dy * r) + '" rx="' + r1(rx * r) + '" ry="' + r1(ry * r) +
      '" transform="rotate(' + rot + ' ' + r1(cx + dx * r) + ' ' + r1(cy + dy * r) + ')" fill="url(#' + p + 'mm)"/>'
  })
  let k = ''
  craters.forEach(([dx, dy, rr]) => {
    const x = cx + dx * r
    const y = cy + dy * r
    const q = rr * r
    k += '<circle cx="' + r1(x) + '" cy="' + r1(y) + '" r="' + r1(q) + '" fill="' + c.crater + '" opacity=".55"/>' +
      '<path d="M' + r1(x - q) + ' ' + r1(y) + ' A' + r1(q) + ' ' + r1(q) + ' 0 0 1 ' + r1(x) + ' ' + r1(y - q) + '" fill="none" stroke="' + c.core + '" stroke-width="' + r1(Math.max(0.5, q * 0.28)) + '" opacity=".7"/>'
  })
  return (
    '<defs>' +
    '<radialGradient id="' + p + 'mb" cx=".38" cy=".34" r=".74"><stop offset="0" stop-color="' + c.core + '"/><stop offset=".5" stop-color="' + c.mid + '"/><stop offset=".88" stop-color="' + c.edge + '"/><stop offset="1" stop-color="' + c.rim + '"/></radialGradient>' +
    '<radialGradient id="' + p + 'mh"><stop offset=".68" stop-color="' + c.halo + '" stop-opacity=".2"/><stop offset="1" stop-color="' + c.halo + '" stop-opacity="0"/></radialGradient>' +
    '<radialGradient id="' + p + 'mm"><stop offset="0" stop-color="' + c.mare + '" stop-opacity=".5"/><stop offset=".62" stop-color="' + c.mare + '" stop-opacity=".26"/><stop offset="1" stop-color="' + c.mare + '" stop-opacity="0"/></radialGradient>' +
    '<linearGradient id="' + p + 'mt" x1=".18" y1=".12" x2=".92" y2=".96"><stop offset=".48" stop-color="#5A3E14" stop-opacity="0"/><stop offset="1" stop-color="#5A3E14" stop-opacity=".24"/></linearGradient>' +
    '</defs>' +
    '<circle class="fa-moon-halo" cx="' + cx + '" cy="' + cy + '" r="' + r1(r * 1.45) + '" fill="url(#' + p + 'mh)"/>' +
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="url(#' + p + 'mb)"/>' +
    m + k +
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="url(#' + p + 'mt)"/>' +
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + r1(r * 0.99) + '" fill="none" stroke="#FFFDF3" stroke-opacity=".3" stroke-width="' + r1(Math.max(0.6, r * 0.02)) + '"/>'
  )
}

// 祥云 / auspicious cloud
export function cloudPath() {
  return 'M0 20 H122 C134 20 138 6 128 0 C124 -10 110 -11 105 -1 C103 -19 80 -24 72 -8 C66 -23 43 -21 41 -4 C33 -13 18 -8 21 4 C9 2 0 10 0 20 Z'
}
export function cloud(fill: string, stroke: string, sw = 1.6, p = prefix()) {
  const d = cloudPath()
  const solid = fill !== 'none'
  return (
    (solid
      ? '<defs><linearGradient id="' + p + 'cs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + stroke + '" stop-opacity=".16"/><stop offset=".7" stop-color="' + stroke + '" stop-opacity="0"/></linearGradient></defs>'
      : '') +
    '<path d="' + d + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + sw + '" stroke-linejoin="round"/>' +
    (solid ? '<path d="' + d + '" fill="url(#' + p + 'cs)"/>' : '') +
    // 内侧再描一道细线，祥云的双勾。/ an inner second contour, the double outline of a xiangyun cloud
    '<path d="' + d + '" transform="translate(7 2.2) scale(.89)" fill="none" stroke="' + stroke + '" stroke-width="' + r1(sw * 0.7) + '" stroke-linejoin="round" opacity=".35"/>' +
    '<g fill="none" stroke="' + stroke + '" stroke-width="' + sw + '" stroke-linecap="round">' +
    '<path d="M105 -1 C101 8 111 13 116 6"/><path d="M72 -8 C69 3 80 7 85 0"/><path d="M41 -4 C39 5 47 9 52 4"/></g>'
  )
}

function leaf(x: number, y: number, rot: number, s: number, color = '#2F4B3F') {
  return (
    '<g transform="' + T(x, y, s, rot) + '">' +
    '<path d="M0 0 C8 -7 22 -7 31 0 C22 7 8 7 0 0 Z" fill="' + color + '"/>' +
    '<path d="M0 0 C8 -7 22 -7 31 0 C22 -2 8 -2 0 0 Z" fill="#fff" opacity=".07"/>' +
    '<path d="M2 0 L28 0" stroke="#5B7F6C" stroke-width=".9"/>' +
    '<path d="M9 0 L13 -3.4 M15 0 L19 -3 M11 0 L15 3.2 M18 0 L22 2.8" stroke="#4E705E" stroke-width=".6" opacity=".8"/></g>'
  )
}

function osmanthus(x: number, y: number, s: number) {
  let f = ''
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + 0.4
    f += '<ellipse cx="' + r1(Math.cos(a) * 2.5) + '" cy="' + r1(Math.sin(a) * 2.5) + '" rx="2.4" ry="2" transform="rotate(' + r1((a * 180) / Math.PI) + ' ' + r1(Math.cos(a) * 2.5) + ' ' + r1(Math.sin(a) * 2.5) + ')"/>'
  }
  return (
    '<g transform="' + T(x, y, s) + '"><g fill="#F5BD4E">' + f + '</g>' +
    '<circle r="1.9" fill="#FFE39A" opacity=".7"/><circle r="1.1" fill="#C9801C"/></g>'
  )
}

// 桂花枝：从右上角垂下来。整枝绕枝根（右上角）摆动。
// Osmanthus branch hanging from the top-right corner; it sways about its root.
export function osmanthusBranch() {
  const L = [
    [240, 36, 150, 1.1], [206, 60, 240, 1.05], [196, 110, 265, 1], [168, 82, 200, 1.1], [140, 98, 150, 1.15],
    [122, 80, 190, 1], [258, 28, 230, 0.9], [236, 10, 170, 0.85], [150, 116, 250, 0.9, '#28413A'], [282, 40, 175, 1, '#28413A'],
    [96, 126, 205, 0.95], [80, 108, 160, 0.9, '#28413A'],
  ] as const
  const F = [
    [228, 58, 1.1], [222, 66, 0.9], [234, 64, 0.8], [182, 80, 1], [176, 90, 0.85], [200, 104, 1], [192, 126, 0.9],
    [134, 108, 1], [142, 114, 0.8], [116, 78, 0.9], [248, 24, 0.9], [260, 44, 0.8], [104, 118, 0.9], [88, 124, 0.85],
  ] as const
  return svg(
    '0 0 300 170',
    '<g class="fa-branch">' +
      '<g fill="none" stroke="#3B2E26" stroke-linecap="round">' +
      '<path d="M310 36 C240 56 188 70 128 112 C110 124 96 128 78 130" stroke-width="5.5"/>' +
      '<path d="M220 60 C200 88 190 110 194 140" stroke-width="3"/>' +
      '<path d="M168 88 C148 80 128 84 104 74" stroke-width="3"/>' +
      '<path d="M266 46 C260 24 248 12 230 4" stroke-width="2.5"/></g>' +
      L.map((l) => leaf(l[0], l[1], l[2], l[3], (l as readonly (number | string)[])[4] as string | undefined)).join('') +
      F.map((f) => osmanthus(f[0], f[1], f[2])).join('') +
      '</g>',
    'fa-branch-svg',
    'overflow="visible"'
  )
}

// 玉兔：毛色有体积（受光面暖白、背光面偏灰），有胡须、腮红、眼睛高光。
// The rabbit: fur with volume (warm white in light, grey in shade), whiskers,
// blush and a highlight in the eye.
export function rabbit(p = prefix()) {
  return (
    '<defs>' +
    '<radialGradient id="' + p + 'rf" cx=".34" cy=".28" r=".85"><stop offset="0" stop-color="#FDFBF6"/><stop offset=".55" stop-color="#EDE6D8"/><stop offset="1" stop-color="#CFC4B0"/></radialGradient>' +
    '<linearGradient id="' + p + 're" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F4C9C1"/><stop offset="1" stop-color="#DE9E94"/></linearGradient>' +
    '</defs>' +
    '<g class="fa-rabbit">' +
    '<ellipse class="fa-rabbit-shadow" cx="2" cy="24" rx="34" ry="5" fill="#000" opacity=".35"/>' +
    '<g class="fa-rabbit-body">' +
    '<g class="fa-ear-b"><path d="M-27 -28 C-38 -57 -26 -64 -19 -31 Z" fill="#DDD4C4"/><path d="M-26 -31 C-33 -52 -27 -56 -22 -33 Z" fill="#D9A69E" opacity=".6"/></g>' +
    '<ellipse cx="4" cy="4" rx="27" ry="21" fill="url(#' + p + 'rf)"/>' +
    '<ellipse cx="13" cy="9" rx="15" ry="14" fill="url(#' + p + 'rf)"/>' +
    '<path d="M2 10 C6 -2 22 -3 27 9" fill="none" stroke="#CDBFAA" stroke-width="1" opacity=".7"/>' +
    '<circle cx="-18" cy="-16" r="14.5" fill="url(#' + p + 'rf)"/>' +
    '<g class="fa-ear-f"><path d="M-17 -28 C-12 -61 2 -60 -9 -27 Z" fill="url(#' + p + 'rf)"/><path d="M-14 -31 C-11 -53 -3 -53 -10 -30 Z" fill="url(#' + p + 're)"/></g>' +
    '<circle cx="28" cy="6" r="7" fill="#FFFDF8"/><circle cx="30.5" cy="3.6" r="4" fill="#fff" opacity=".7"/>' +
    '<ellipse cx="-12" cy="21" rx="9" ry="4" fill="#F9F5EE"/><path d="M-16 22.5 L-16 20 M-12 23 L-12 20.4 M-8 22.5 L-8 20" stroke="#D8CDBA" stroke-width=".7"/>' +
    '<circle cx="-24" cy="-11" r="3.2" fill="#F2B8B0" opacity=".45"/>' +
    '<ellipse class="fa-eye" cx="-25" cy="-19" rx="2" ry="2.1" fill="#2E2222"/><circle cx="-25.6" cy="-19.7" r=".65" fill="#fff"/>' +
    '<path d="M-32.6 -13.4 C-31.6 -12.4 -30.8 -12.4 -30 -13.4 C-30.6 -14.2 -32 -14.2 -32.6 -13.4 Z" fill="#D69A92"/>' +
    '<g stroke="#C9BCA7" stroke-width=".55" stroke-linecap="round" opacity=".9"><path d="M-33 -12 L-42 -14"/><path d="M-33 -11 L-42 -10"/><path d="M-32 -10 L-40 -6.5"/></g>' +
    '</g></g>'
  )
}

function mooncake(x: number, y: number, s: number) {
  const flower = (fill: string, dy: number) => {
    let b = '<circle cx="0" cy="' + dy + '" r="40" fill="' + fill + '"/>'
    for (let i = 0; i < 12; i++) {
      const a = (i * Math.PI) / 6
      b += '<circle cx="' + r1(Math.cos(a) * 42) + '" cy="' + r1(Math.sin(a) * 42 + dy) + '" r="11" fill="' + fill + '"/>'
    }
    return b
  }
  return (
    '<g transform="' + T(x, y, s) + '">' +
    '<ellipse cx="0" cy="26" rx="84" ry="18" fill="#1D1D25" stroke="#34343E" stroke-width="1.2"/>' +
    '<g transform="scale(1 .52)">' + flower('#8F561E', 22) + flower('#C98A43', 0) +
    '<circle r="31" fill="none" stroke="#A56A2A" stroke-width="2.2"/>' +
    '<circle r="36" fill="none" stroke="#DDA35C" stroke-width="1" opacity=".6"/>' +
    '<text x="0" y="1" text-anchor="middle" dominant-baseline="central" font-size="34" font-weight="700" fill="#8E5A21" class="fa-kai">月</text>' +
    '</g></g>'
  )
}

// ── 部件：春节 / parts: Spring Festival ─────────────────────────────────────

// 灯笼：绳 + 灯体 + 穗子三层。整盏绕绳顶摆，穗子绕穗顶再摆一次（滞后），
// 这是「有重量」的来源。坐标原点在绳顶。
// Lantern in three layers: string, body, tassel. The whole lantern swings from
// the string top and the tassel swings again from its own top, lagging behind —
// that lag is what reads as weight. Origin is the string top.
// 灯笼：从里面点亮（中心暖亮、边缘深红），金色顶盖和底盖有倒角高光，竹骨一深一浅
// 交替，下面依次是金珠、红色小结、流苏。外面一圈很淡的暖光——灯笼是真光源。
// 三层：绳 + 灯体 + 流苏。整盏绕绳顶摆，流苏绕自己的顶再摆一次（滞后）。坐标原点在绳顶。
// The lantern is lit from within (warm bright core, deep red rim); the gold caps
// carry a bevel highlight, the ribs alternate dark and light, and below come a
// gold bead, a small red knot and the tassel. A faint warm halo surrounds it — a
// lantern is a real light source. Three layers: string, body, tassel; the whole
// swings from the string top and the tassel swings again from its own top,
// lagging behind. Origin is the string top.
export function lanternSvg(p: string, len: number, glyph: string | null, cls = '') {
  let tassel = ''
  for (let i = -4; i <= 4; i++) {
    tassel += '<line x1="' + r1(i * 1.3) + '" y1="6" x2="' + r1(i * 2.1) + '" y2="' + (52 - Math.abs(i) * 1.6) + '"/>'
  }
  return svg(
    '-70 0 140 ' + (len + 176),
    '<defs>' +
      '<radialGradient id="' + p + 'lb" cx=".46" cy=".42" r=".66"><stop offset="0" stop-color="#FF8F66"/><stop offset=".3" stop-color="#EE4632"/><stop offset=".72" stop-color="#C2221A"/><stop offset="1" stop-color="#82110F"/></radialGradient>' +
      '<radialGradient id="' + p + 'lg"><stop offset="0" stop-color="#FF7A45" stop-opacity=".24"/><stop offset=".5" stop-color="#FF7A45" stop-opacity=".08"/><stop offset="1" stop-color="#FF7A45" stop-opacity="0"/></radialGradient>' +
      '<linearGradient id="' + p + 'gd" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFEDB5"/><stop offset=".45" stop-color="#F2C866"/><stop offset="1" stop-color="#C28A2A"/></linearGradient>' +
      '<linearGradient id="' + p + 'gh" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#A9761E"/><stop offset=".35" stop-color="#FFE9A6"/><stop offset=".7" stop-color="#E2AE48"/><stop offset="1" stop-color="#946618"/></linearGradient>' +
      '<linearGradient id="' + p + 'ts" gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="54"><stop offset="0" stop-color="#F8D983"/><stop offset="1" stop-color="#B7862E"/></linearGradient>' +
      '</defs>' +
      '<line x1="0" y1="0" x2="0" y2="' + (len - 12) + '" stroke="#B7862E" stroke-width="1.4"/>' +
      '<circle cx="0" cy="' + (len - 10) + '" r="3" fill="url(#' + p + 'gh)"/>' +
      '<g transform="translate(0 ' + len + ')">' +
      '<circle class="fa-lan-glow" cx="0" cy="48" r="96" fill="url(#' + p + 'lg)"/>' +
      '<rect x="-8" y="-14" width="16" height="6" rx="2" fill="url(#' + p + 'gh)"/>' +
      '<rect x="-24" y="-9" width="48" height="12" rx="3" fill="url(#' + p + 'gh)"/>' +
      '<rect x="-24" y="1" width="48" height="2" fill="#6E4812" opacity=".4"/>' +
      '<ellipse cx="0" cy="48" rx="62" ry="51" fill="url(#' + p + 'lb)"/>' +
      '<g fill="none" stroke="#7F120F" stroke-width="1.4" opacity=".55"><ellipse cx="0" cy="48" rx="48" ry="51"/><ellipse cx="0" cy="48" rx="29" ry="51"/><ellipse cx="0" cy="48" rx="10" ry="51"/></g>' +
      '<g fill="none" stroke="#FFB08C" stroke-width="1" opacity=".16"><ellipse cx="0" cy="48" rx="39" ry="51"/><ellipse cx="0" cy="48" rx="19" ry="51"/></g>' +
      '<path d="M-50 16 Q0 5 50 16" fill="none" stroke="url(#' + p + 'gd)" stroke-width="2.4"/>' +
      '<path d="M-50 80 Q0 91 50 80" fill="none" stroke="url(#' + p + 'gd)" stroke-width="2.4"/>' +
      '<path d="M-42 22 C-54 40 -52 62 -40 78" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".15"/>' +
      '<ellipse cx="-24" cy="27" rx="6.5" ry="3" transform="rotate(-32 -24 27)" fill="#fff" opacity=".2"/>' +
      (glyph
        ? '<text x="0" y="50" text-anchor="middle" dominant-baseline="central" font-size="36" font-weight="700" fill="url(#' + p + 'gd)" stroke="#6E120E" stroke-width="1.4" paint-order="stroke" class="fa-kai">' + glyph + '</text>'
        : '') +
      '<rect x="-24" y="93" width="48" height="12" rx="3" fill="url(#' + p + 'gh)"/>' +
      '<rect x="-24" y="93" width="48" height="2" fill="#FFF3C8" opacity=".45"/>' +
      '<circle cx="0" cy="110" r="4.2" fill="url(#' + p + 'gh)"/>' +
      '<rect x="-4.6" y="113" width="9.2" height="9.2" rx="1.6" transform="rotate(45 0 117.6)" fill="#C4221A" stroke="#E9B955" stroke-width="1"/>' +
      '<g transform="translate(0 122)"><g class="fa-tassel">' +
      '<rect x="-5.5" y="0" width="11" height="6" rx="2" fill="url(#' + p + 'gh)"/>' +
      '<g stroke="url(#' + p + 'ts)" stroke-width="1.5" stroke-linecap="round">' + tassel + '</g>' +
      '</g></g>' +
      '</g>',
    'fa-lantern ' + cls,
    'overflow="visible"'
  )
}

export function plum(x: number, y: number, s: number, open: boolean, cls = 'fa-bloom', p = prefix()) {
  if (!open) {
    return (
      '<g transform="' + T(x, y, s) + '"><g class="' + cls + '">' +
      '<circle r="4.4" fill="#E2707D"/><path d="M-3 -1 C-1 -4 2 -4 3 -1" fill="none" stroke="#F7B5BE" stroke-width="1" opacity=".7"/>' +
      '<path d="M-2 3 L0 5.6 L2 3" fill="#6B2A22"/></g></g>'
    )
  }
  let petals = ''
  for (let i = 0; i < 5; i++) {
    const a = (i * 2 * Math.PI) / 5 - Math.PI / 2
    petals += '<circle cx="' + r1(Math.cos(a) * 6.5) + '" cy="' + r1(Math.sin(a) * 6.5) + '" r="6.6"/>'
  }
  let st = ''
  for (let j = 0; j < 8; j++) {
    const b = (j * 2 * Math.PI) / 8 + 0.2
    const ex = r1(Math.cos(b) * 5.4)
    const ey = r1(Math.sin(b) * 5.4)
    st += '<line x1="0" y1="0" x2="' + ex + '" y2="' + ey + '"/><circle cx="' + ex + '" cy="' + ey + '" r=".75" stroke="none" fill="#F7D98A"/>'
  }
  return (
    '<defs><radialGradient id="' + p + 'pb"><stop offset="0" stop-color="#FFE6EA"/><stop offset=".55" stop-color="#F6AEB7"/><stop offset="1" stop-color="#E8828F"/></radialGradient></defs>' +
    '<g transform="' + T(x, y, s) + '"><g class="' + cls + '">' +
    '<g fill="url(#' + p + 'pb)">' + petals + '</g>' +
    '<g stroke="#C4505E" stroke-width=".6">' + st + '</g>' +
    '<circle r="2.2" fill="' + GOLD + '"/></g></g>'
  )
}

// 梅枝：从右下角向上伸出。花朵带 fa-bloom，入场时依次绽开。
// Plum branch rising from the bottom-right corner; blossoms bloom in sequence.
export function plumBranch() {
  return svg(
    '0 0 320 260',
    '<g fill="none" stroke="#2E1B18" stroke-linecap="round">' +
      '<path d="M330 262 C270 240 230 214 200 168 C180 138 150 118 110 110" stroke-width="6"/>' +
      '<path d="M236 222 C222 196 220 170 228 146" stroke-width="3.2"/>' +
      '<path d="M178 132 C170 104 158 88 140 76" stroke-width="3"/>' +
      '<path d="M290 246 C282 226 270 214 254 206" stroke-width="2.6"/></g>' +
      plum(110, 110, 1, true) + plum(142, 78, 1.1, true) + plum(186, 150, 1.15, true) + plum(228, 146, 0.95, true) +
      plum(206, 176, 0.8, true) + plum(254, 206, 1, true) + plum(160, 124, 0.85, true) + plum(270, 236, 0.8, true) +
      plum(126, 100, 1, false) + plum(236, 190, 1, false) + plum(168, 96, 1, false) + plum(200, 160, 1, false),
    'fa-plum-svg',
    'overflow="visible"'
  )
}

// ── 部件：圣诞 / parts: Christmas ───────────────────────────────────────────

const PINE = 'M0 -150 L40 -92 L21 -94 L56 -42 L29 -44 L68 0 L-68 0 L-29 -44 L-56 -42 L-21 -94 L-40 -92 Z'
const PINE_HALF = 'M0 -150 L40 -92 L21 -94 L56 -42 L29 -44 L68 0 L0 0 Z'

export function pine(x: number, y: number, s: number, color = PINE_C, shade: string | null = PINE_SHADE) {
  // 三层枝叶各自有一道受光的左缘和几笔枝纹；每层枝梢都托着一小团雪。
  // Each of the three tiers has a lit left rim and a few branch strokes; every
  // tier's tips hold a small clump of snow.
  return (
    '<g transform="' + T(x, y, s) + '">' +
    '<rect x="-7" y="-2" width="14" height="20" fill="#3A2C24"/><rect x="-7" y="-2" width="5" height="20" fill="#4E3C30"/>' +
    '<path d="' + PINE + '" fill="' + color + '"/>' +
    (shade ? '<path d="' + PINE_HALF + '" fill="' + shade + '"/>' : '') +
    '<g fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="1.6" stroke-linecap="round"><path d="M-2 -146 L-38 -93"/><path d="M-20 -93 L-54 -43"/><path d="M-28 -43 L-66 -1"/></g>' +
    '<g fill="none" stroke="#10302A" stroke-opacity=".5" stroke-width="1.2" stroke-linecap="round"><path d="M-6 -120 L-16 -108 M8 -118 L18 -106 M-12 -70 L-26 -56 M14 -72 L28 -58 M-20 -26 L-36 -12 M20 -28 L36 -12 M0 -60 L0 -48"/></g>' +
    '<g fill="#EEF2F6">' +
    '<path d="M0 -150 L15 -128 Q10 -123 5 -127 Q1 -121 -4 -126 Q-9 -121 -15 -128 Z"/>' +
    '<path d="M-40 -92 L-21 -94 L-24 -90 Q-29 -87 -33 -90 Q-37 -87 -40 -92 Z"/>' +
    '<path d="M40 -92 L21 -94 L24 -90 Q29 -87 33 -90 Q37 -87 40 -92 Z" opacity=".82"/>' +
    '<path d="M-56 -42 L-29 -44 L-33 -39.5 Q-40 -36.5 -45 -39.5 Q-51 -36.5 -56 -42 Z"/>' +
    '<path d="M56 -42 L29 -44 L33 -39.5 Q40 -36.5 45 -39.5 Q51 -36.5 56 -42 Z" opacity=".82"/>' +
    '<path d="M-68 0 L-44 -1 Q-50 4 -56 2 Q-62 5 -68 0 Z" opacity=".9"/><path d="M68 0 L44 -1 Q50 4 56 2 Q62 5 68 0 Z" opacity=".75"/>' +
    '</g></g>'
  )
}

export function star5(x: number, y: number, r: number, color: string, cls = '') {
  let d = ''
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI) / 5 - Math.PI / 2
    const rr = i % 2 ? r * 0.44 : r
    d += (i ? 'L' : 'M') + r1(x + Math.cos(a) * rr) + ' ' + r1(y + Math.sin(a) * rr) + ' '
  }
  return '<path class="' + cls + '" d="' + d + 'Z" fill="' + color + '"/>'
}

// 灯串：两段悬链线，灯泡沿曲线等距分布。灯泡的亮暗是一道沿着灯串传播的波
// （animation-delay 按序号递减），而不是各闪各的。
// A string of lights in two catenary drapes with evenly spaced bulbs. Brightness
// travels along the string as a wave (animation-delay stepped by index) rather
// than each bulb blinking on its own.
export function fairyLights(width = 1000, count = 2) {
  const drapes: number[][] = []
  for (let i = 0; i < count; i++) {
    const x0 = (width / count) * i
    const x1 = (width / count) * (i + 1)
    drapes.push([x0, i % 2 ? 16 : 10, x1, i % 2 ? 4 : 16, i % 2 ? 96 : 120])
  }
  const colors = ['#F5E6BE', '#F3CE6A', '#A99BFF', '#F5E6BE', '#E9B7A0']
  const lp = prefix()
  let defs =
    '<linearGradient id="' + lp + 'cap" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3A3944"/><stop offset=".45" stop-color="#8A8898"/><stop offset="1" stop-color="#34333D"/></linearGradient>'
  colors.forEach((c, i) => {
    defs += '<radialGradient id="' + lp + 'b' + i + '" cx=".5" cy=".42" r=".6"><stop offset="0" stop-color="#FFFDF4"/><stop offset=".45" stop-color="' + c + '"/><stop offset="1" stop-color="' + c + '" stop-opacity=".85"/></radialGradient>'
  })
  let wire = ''
  let bulbs = ''
  let idx = 0
  drapes.forEach(([x0, y0, x1, y1, sag]) => {
    const cx = (x0 + x1) / 2
    const cy = Math.max(y0, y1) + sag
    wire += '<path d="M' + x0 + ' ' + y0 + ' Q' + cx + ' ' + cy + ' ' + x1 + ' ' + y1 + '" fill="none" stroke="#3B3A45" stroke-width="2"/>'
    const n = 11
    for (let i = 1; i < n; i++) {
      const t = i / n
      const x = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1
      const y = (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1
      const c = colors[idx % colors.length]
      // 玻璃灯泡：中心有一点灯丝的白热，往外过渡到灯泡本色；灯座是金属渐变。
      // A glass bulb: a white-hot filament at the centre shading out to the bulb's
      // colour, on a metal cap.
      bulbs +=
        '<g transform="' + T(x, y) + '">' +
        '<rect x="-3.2" y="0" width="6.4" height="6.5" rx="1.5" fill="url(#' + lp + 'cap)"/>' +
        '<g class="fa-bulb" style="animation-delay:' + r1(-idx * 0.16) + 's">' +
        '<circle cx="0" cy="15" r="20" fill="' + c + '" opacity=".09"/><circle cx="0" cy="15" r="11" fill="' + c + '" opacity=".15"/>' +
        '<ellipse cx="0" cy="14.5" rx="5.2" ry="8.2" fill="url(#' + lp + 'b' + (idx % colors.length) + ')"/>' +
        '<ellipse cx="-1.7" cy="11.6" rx="1.3" ry="2.8" fill="#fff" opacity=".6"/>' +
        '</g></g>'
      idx++
    }
  })
  return svg('0 0 ' + width + ' 170', '<defs>' + defs + '</defs>' + wire + bulbs, 'fa-lights-svg', 'overflow="visible" preserveAspectRatio="xMidYMin meet"')
}

// 在真实的挂点之间拉灯串，坐标就是像素（布局时量出来的）。每段 [x0, y0, x1, y1,
// 下垂量, 起点是否系在金线上]；灯泡按弧长约 42px 一颗，skip 为真的位置（藏在手机
// 背后）不画。
// Lights strung between real tie points, in pixels measured at layout time.
// Each drape is [x0, y0, x1, y1, sag, tiedAtStart]; bulbs sit every ~42px of arc
// length, and positions where skip() is true (hidden behind the phone) are left out.
export function lightsBetween(w: number, h: number, drapes: number[][], skip: (x: number, y: number) => boolean = () => false) {
  const colors = ['#F5E6BE', '#F3CE6A', '#A99BFF', '#F5E6BE', '#E9B7A0']
  const lp = prefix()
  let defs =
    '<linearGradient id="' + lp + 'cap" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3A3944"/><stop offset=".45" stop-color="#8A8898"/><stop offset="1" stop-color="#34333D"/></linearGradient>'
  colors.forEach((c, i) => {
    defs += '<radialGradient id="' + lp + 'b' + i + '" cx=".5" cy=".42" r=".6"><stop offset="0" stop-color="#FFFDF4"/><stop offset=".45" stop-color="' + c + '"/><stop offset="1" stop-color="' + c + '" stop-opacity=".85"/></radialGradient>'
  })
  let wire = ''
  let ties = ''
  let bulbs = ''
  let idx = 0
  drapes.forEach(([x0, y0, x1, y1, sag, tied]) => {
    const qx = (x0 + x1) / 2
    const qy = Math.max(y0, y1) + sag
    wire += '<path d="M' + r1(x0) + ' ' + r1(y0) + ' Q' + r1(qx) + ' ' + r1(qy) + ' ' + r1(x1) + ' ' + r1(y1) + '" fill="none" stroke="#3B3A45" stroke-width="1.6"/>'
    // 系在金线上的一端：绕一个小圈。/ where it is tied to the rule, a small loop
    if (tied) ties += '<circle cx="' + r1(x0) + '" cy="' + r1(y0 + 2.4) + '" r="2.2" fill="none" stroke="#4A4956" stroke-width="1.3"/>'
    let run = 0
    let next = 26
    let px = x0
    let py = y0
    for (let i = 1; i <= 240; i++) {
      const s = i / 240
      const x = (1 - s) * (1 - s) * x0 + 2 * (1 - s) * s * qx + s * s * x1
      const y = (1 - s) * (1 - s) * y0 + 2 * (1 - s) * s * qy + s * s * y1
      run += Math.sqrt((x - px) * (x - px) + (y - py) * (y - py))
      px = x
      py = y
      if (run < next) continue
      next += 42
      if (x > w - 4 || skip(x, y)) continue
      const c = idx % colors.length
      bulbs +=
        '<g transform="translate(' + r1(x) + ' ' + r1(y) + ') scale(.82)">' +
        '<rect x="-3.2" y="0" width="6.4" height="6.5" rx="1.5" fill="url(#' + lp + 'cap)"/>' +
        '<g class="fa-bulb" style="animation-delay:' + r1(-idx * 0.16) + 's">' +
        '<circle cx="0" cy="15" r="20" fill="' + colors[c] + '" opacity=".09"/><circle cx="0" cy="15" r="11" fill="' + colors[c] + '" opacity=".15"/>' +
        '<ellipse cx="0" cy="14.5" rx="5.2" ry="8.2" fill="url(#' + lp + 'b' + c + ')"/>' +
        '<ellipse cx="-1.7" cy="11.6" rx="1.3" ry="2.8" fill="#fff" opacity=".6"/>' +
        '</g></g>'
      idx++
    }
  })
  return svg('0 0 ' + r1(w) + ' ' + r1(h), '<defs>' + defs + '</defs>' + wire + ties + bulbs, 'fa-lights-svg', 'overflow="visible"')
}

// ── 部件：新年 / parts: New Year ────────────────────────────────────────────

export function burst(cx: number, cy: number, r: number, color: string, n: number, cls = 'fa-burst', delay = 0) {
  let rays = ''
  for (let i = 0; i < n; i++) {
    const a = (i * 2 * Math.PI) / n
    const c = Math.cos(a)
    const s = Math.sin(a)
    rays +=
      '<line x1="' + r1(c * r * 0.3) + '" y1="' + r1(s * r * 0.3) + '" x2="' + r1(c * r * 0.82) + '" y2="' + r1(s * r * 0.82) + '"/>' +
      '<circle cx="' + r1(c * r) + '" cy="' + r1(s * r) + '" r="2.4" stroke="none"/>'
  }
  return (
    '<g transform="' + T(cx, cy) + '"><g class="' + cls + '" style="animation-delay:' + delay + 's">' +
    '<g stroke="' + color + '" fill="' + color + '" stroke-width="2" stroke-linecap="round">' + rays + '</g>' +
    '<circle r="3.2" fill="' + color + '"/></g></g>'
  )
}

// 竖排两行：放在手机右侧那一栏里，整组数字都看得见。
// Two stacked lines for the column right of the phone, so every digit is visible.
export function yearStacked(year: number) {
  const y = String(year)
  return svg(
    '0 0 400 480',
    '<text class="fa-year" x="200" y="210" text-anchor="middle">' + y.slice(0, 2) + '</text>' +
      '<text class="fa-year" x="200" y="440" text-anchor="middle">' + y.slice(2) + '</text>',
    'fa-year-svg'
  )
}

export function yearOutline(year: number) {
  return svg(
    '0 0 900 240',
    '<text class="fa-year" x="450" y="196" text-anchor="middle">' + year + '</text>',
    'fa-year-svg'
  )
}

// ── 烧瓶（品牌主体）/ the flask from the brand mark ─────────────────────────

const FLASK_BODY = 'M228 118 L228 204 L112 390 Q100 414 128 416 L372 416 Q400 414 388 390 L272 204 L272 118 Z'

// ════════════════════════════════════════════════════════════════════════════
// Logo 彩蛋 / logo ornaments
// ════════════════════════════════════════════════════════════════════════════
// 叠在 logo.png 上的一层，坐标 0–100 对齐 logo 方框。瓶口约在 x 40–60、
// y 9–13。Logo 在导航里只有 28–40px，所以彩蛋画得偏大偏粗，并允许溢出方框。
// Overlay on logo.png in a 0–100 box. The flask rim sits at x 40–60, y 9–13.
// The nav renders the logo at 28–40px, so ornaments are oversized, bold, and
// may overflow the box.

function ornamentBody(key: ArtKey, p: string): string {
  switch (key) {
    case 'halloween':
      return (
        '<g class="fa-o-hat">' +
        '<path d="M37 10 C41 0 46 -10 58 -20 C56 -10 58 0 63 10 Z" fill="#1C1724" stroke="#F28A3A" stroke-width="1.6" stroke-linejoin="round"/>' +
        '<path d="M38.6 5.6 Q50 8.4 61.6 5.6 L62.8 9.4 Q50 12.2 37.4 9.4 Z" fill="#F28A3A"/>' +
        '<ellipse cx="50" cy="10.6" rx="22" ry="4.6" fill="#1C1724" stroke="#F28A3A" stroke-width="1.6"/>' +
        '</g>' +
        '<g class="fa-o-bat" transform="translate(88 26) scale(.46)"><g class="fa-float"><g class="fa-o-bat-in">' + bat('#F28A3A', 0.2) + '</g></g></g>'
      )
    case 'midautumn':
      return (
        '<g class="fa-o-moon">' + moon(p, 84, 14, 13) + '</g>' +
        '<g class="fa-o-cloud"><path d="M68 26 H96 C100 26 101 21 98 19 C97 15 92 15 90 18 C89 12 81 11 79 16 C76 12 70 14 71 19 C67 19 65 23 68 26 Z" fill="#1B1B21" stroke="#E3D2A2" stroke-width="1.2" stroke-linejoin="round"/></g>'
      )
    case 'spring':
      // 瓶颈上系一圈红绳，绳头打个小盘长结垂下流苏——像给瓶子系上的吉祥结，挂在
      // 实物上，而不是一盏悬在瓶子旁边半空里的灯笼。瓶颈在 x 41–59、瓶口下沿约 y 16。
      // A red cord tied round the flask's neck, its end knotted into a small
      // endless knot with a tassel, like a charm tied on a bottle: hung from the
      // object itself rather than a lantern floating beside it. The neck spans
      // x 41–59, just under the rim at about y 16.
      return (
        '<path class="fa-o-cord" d="M40.6 16.4 Q50 19.8 59.6 16.6" fill="none" stroke="#D02C23" stroke-width="2.2" stroke-linecap="round"/>' +
        '<g transform="translate(60.4 17.4)"><g class="fa-o-lantern">' +
        '<circle cx="0" cy="0" r="1.9" fill="none" stroke="' + GOLD + '" stroke-width="1.1"/>' +
        '<g transform="translate(0 7.4) rotate(45)"><rect x="-4.3" y="-4.3" width="8.6" height="8.6" rx="1.3" fill="#D02C23"/>' +
        '<path d="M-4.3 -1.4 H4.3 M-4.3 1.4 H4.3 M-1.4 -4.3 V4.3 M1.4 -4.3 V4.3" stroke="#8F1814" stroke-width=".7"/>' +
        '<rect x="-4.3" y="-4.3" width="8.6" height="8.6" rx="1.3" fill="none" stroke="' + GOLD + '" stroke-width=".5" opacity=".7"/></g>' +
        '<rect x="-1.8" y="13" width="3.6" height="2.4" rx=".8" fill="' + GOLD + '"/>' +
        '<g class="fa-o-tassel" stroke="#D02C23" stroke-width="1.1" stroke-linecap="round"><line x1="-1" y1="15.2" x2="-1.5" y2="23"/><line x1="0" y1="15.2" x2="0" y2="24.4"/><line x1="1" y1="15.2" x2="1.5" y2="23"/></g>' +
        '</g></g>'
      )
    case 'christmas':
      return (
        '<g class="fa-o-snow"><path d="M35 11 Q36 3 43 4 Q50 0 57 4 Q64 3 65 11 Q66 16 62 15 Q59 19 55.5 15 Q52 19 49 15.5 Q45.5 19 42.5 15 Q38.5 17.5 35 13.5 Z" fill="#F2F5F8"/></g>' +
        '<g class="fa-o-holly">' +
        '<path d="M60 7 C66 1 74 3 76 8 C71 7 66 10 60 7 Z" fill="#2E6B58"/>' +
        '<path d="M61 9 C64 15 72 16 76 12 C71 10 66 12 61 9 Z" fill="#265A4A"/>' +
        '<circle cx="61" cy="8.5" r="2.3" fill="#D6453D"/><circle cx="64.2" cy="6.4" r="2" fill="#D6453D"/><circle cx="64" cy="10.4" r="1.8" fill="#B8362F"/>' +
        '</g>'
      )
    case 'newyear':
      return (
        sparkle(84, 12, 8, '#F1D08A', 'fa-o-spark') + sparkle(18, 22, 5.5, '#E6E8EE', 'fa-o-spark') +
        sparkle(90, 38, 4, '#A99BFF', 'fa-o-spark') + sparkle(66, 2, 3.5, '#F1D08A', 'fa-o-spark')
      )
    default:
      return ''
  }
}

export function ornament(key: ArtKey): string {
  const body = ornamentBody(key, prefix())
  return body ? svg('0 0 100 100', body, 'fa-ornament', 'overflow="visible"') : ''
}

// ════════════════════════════════════════════════════════════════════════════
// 小场景（问候卡图标，64 × 64）/ mini scenes for the greeting card
// ════════════════════════════════════════════════════════════════════════════

export function icon(key: ArtKey): string {
  const p = prefix()
  let b = ''
  switch (key) {
    case 'halloween':
      b =
        '<rect width="64" height="64" fill="#15111A"/>' + stars(6, 64, 30, 4, '#E9DFC4') +
        '<g transform="translate(50 14) scale(.34)"><g class="fa-float"><g class="fa-i-bat">' + bat('#6E6479', 0.3) + '</g></g></g>' +
        pumpkin(31, 40, 0.36, true, p)
      break
    case 'midautumn':
      b =
        '<rect width="64" height="64" fill="#101520"/>' + stars(6, 64, 34, 9, '#E8E0C6') +
        '<g class="fa-i-moon">' + moon(p, 32, 30, 17) + '</g>' +
        '<g transform="translate(6 40) scale(.36)"><g class="fa-i-cloud">' + cloud('#15151D', '#E3D2A2', 3) + '</g></g>'
      break
    case 'spring':
      b =
        '<rect width="64" height="64" fill="#1B0F11"/>' +
        '<g transform="translate(32 -2) scale(.3)"><g class="fa-sway"><g class="fa-i-lantern">' +
        lanternSvg(p, 20, '福').replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '') + '</g></g></g>' +
        sparkle(12, 18, 3, GOLD, 'fa-twinkle', 0.4) + sparkle(54, 44, 2.4, GOLD, 'fa-twinkle', 1.2)
      break
    case 'christmas':
      b =
        '<rect width="64" height="64" fill="#0F141B"/>' +
        '<path d="M0 54 C20 50 44 50 64 54 L64 64 L0 64 Z" fill="#DDE4EA"/>' +
        pine(32, 55, 0.28) +
        '<g class="fa-i-star">' + star5(32, 10.5, 5.5, '#F3CE6A') + '</g>' +
        '<circle class="fa-twinkle" cx="27" cy="30" r="1.4" fill="#F3D27A"/><circle class="fa-twinkle" style="animation-delay:-.8s" cx="37" cy="38" r="1.4" fill="#A99BFF"/><circle class="fa-twinkle" style="animation-delay:-1.6s" cx="30" cy="45" r="1.4" fill="#F5F1E6"/>'
      break
    case 'newyear':
      // 底下一排 K 线形的小楼是静态的，烟花在循环里炸开又熄灭时，画面也不会空。
      // A static row of candlestick towers along the bottom keeps the icon from
      // ever reading empty between bursts.
      b =
        '<rect width="64" height="64" fill="#110F1B"/>' + stars(5, 64, 30, 12, '#D8D2F0') +
        burst(32, 24, 16, '#F1D08A', 12, 'fa-i-burst') + burst(14, 14, 7, '#A99BFF', 8, 'fa-i-burst', 0.9) +
        burst(51, 15, 8, '#E6E8EE', 8, 'fa-i-burst', 1.7) +
        '<g fill="#232330">' +
        '<rect x="6" y="46" width="7" height="18"/><rect x="16" y="40" width="7" height="24"/><rect x="26" y="49" width="7" height="15"/>' +
        '<rect x="36" y="42" width="7" height="22"/><rect x="46" y="47" width="7" height="17"/><rect x="56" y="44" width="7" height="20"/></g>' +
        '<g stroke="#2E2E3C" stroke-width="1"><line x1="19.5" y1="36" x2="19.5" y2="40"/><line x1="39.5" y1="38" x2="39.5" y2="42"/><line x1="59.5" y1="40" x2="59.5" y2="44"/></g>' +
        '<g fill="#F1D08A" opacity=".6"><rect x="18" y="45" width="1.6" height="1.6"/><rect x="38" y="47" width="1.6" height="1.6"/><rect x="48" y="52" width="1.6" height="1.6"/><rect x="8" y="51" width="1.6" height="1.6"/></g>'
      break
    default:
      b =
        '<rect width="64" height="64" fill="#141319"/>' +
        '<g transform="translate(32 33) scale(.13) translate(-250 -260)">' +
        '<rect x="204" y="98" width="92" height="20" rx="10" fill="none" stroke="#ECE8F2" stroke-width="16"/>' +
        '<path d="' + FLASK_BODY + '" fill="#5A22EE" stroke="#ECE8F2" stroke-width="16" stroke-linejoin="round"/></g>'
  }
  return svg('0 0 64 64', b, 'fa-icon')
}

// ════════════════════════════════════════════════════════════════════════════
// 空状态（240 × 170）/ empty-state vignettes
// ════════════════════════════════════════════════════════════════════════════

export function empty(key: ArtKey): string {
  const p = prefix()
  let b = ''
  switch (key) {
    case 'halloween':
      b =
        stars(10, 240, 90, 3, '#E9DFC4') +
        '<g transform="translate(184 38) scale(.7)"><g class="fa-float"><g class="fa-e-bat">' + bat('#6E6479', 0) + '</g></g></g>' +
        '<g transform="translate(58 52) scale(.5)"><g class="fa-float" style="animation-delay:-1.3s"><g class="fa-e-bat">' + bat('#4A4254', 0.35) + '</g></g></g>' +
        pumpkin(120, 112, 0.92, true, p, { glow: true })
      break
    case 'midautumn':
      b =
        stars(8, 240, 90, 9, '#E8E0C6') +
        '<g class="fa-e-moon">' + moon(p, 120, 74, 50) + '</g>' +
        '<g transform="translate(52 108) scale(.8)"><g class="fa-drift">' + cloud('#1B1B21', '#E3D2A2') + '</g></g>' +
        '<g transform="translate(178 142) scale(.56)">' + rabbit() + '</g>'
      break
    case 'spring':
      b =
        '<g transform="translate(120 0) scale(.72)"><g class="fa-sway"><g class="fa-e-lantern">' +
        lanternSvg(p, 8, '福').replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '') + '</g></g></g>' +
        '<g fill="none" stroke="#3A2320" stroke-linecap="round"><path d="M10 168 C40 150 60 146 82 128" stroke-width="3"/><path d="M52 150 C56 138 62 130 70 126" stroke-width="2"/></g>' +
        plum(82, 126, 0.7, true) + plum(56, 146, 0.62, true) + plum(70, 124, 0.7, false) + plum(30, 160, 0.55, true) +
        sparkle(186, 56, 5, GOLD) + sparkle(200, 118, 3.5, GOLD, 'fa-twinkle', 1.3)
      break
    case 'christmas':
      b =
        '<path d="M0 150 C60 140 180 140 240 150 L240 170 L0 170 Z" fill="#DDE4EA" opacity=".9"/>' +
        '<g transform="translate(120 152) scale(.78)">' + pine(0, 0, 1) +
        '<circle class="fa-twinkle" cx="-18" cy="-60" r="3" fill="#F3D27A"/>' +
        '<circle class="fa-twinkle" style="animation-delay:-.7s" cx="16" cy="-40" r="3" fill="#A99BFF"/>' +
        '<circle class="fa-twinkle" style="animation-delay:-1.4s" cx="-30" cy="-18" r="3" fill="#F5F1E6"/>' +
        '<circle class="fa-twinkle" style="animation-delay:-2s" cx="28" cy="-10" r="3" fill="#F3D27A"/>' +
        '<circle class="fa-twinkle" style="animation-delay:-1s" cx="4" cy="-96" r="3" fill="#F5F1E6"/>' +
        '<g class="fa-e-star">' + star5(0, -156, 13, '#F3CE6A') + '</g></g>'
      break
    case 'newyear':
      b =
        burst(120, 64, 48, '#A99BFF', 14, 'fa-e-burst') + burst(52, 50, 22, '#F1D08A', 10, 'fa-e-burst', 1.1) +
        burst(190, 60, 26, '#E6E8EE', 10, 'fa-e-burst', 2)
      break
    default:
      b =
        '<g transform="translate(120 88) scale(.34) translate(-250 -260)" opacity=".55">' +
        '<rect x="204" y="98" width="92" height="20" rx="10" fill="none" stroke="#9C9CA6" stroke-width="7"/>' +
        '<path d="' + FLASK_BODY + '" fill="none" stroke="#9C9CA6" stroke-width="7" stroke-linejoin="round"/>' +
        '<polyline points="150,372 204,334 262,362 322,322" fill="none" stroke="#9284FF" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/>' +
        '</g>'
  }
  return svg('0 0 240 170', b, 'fa-empty')
}

// ════════════════════════════════════════════════════════════════════════════
// 落地页布景的单件 / landing set pieces
// ════════════════════════════════════════════════════════════════════════════
// 每件是一个独立的 <svg>，由 FestivalStage 单独定位、单独加景深视差。

export const piece = {
  moon(tone: 'warm' | 'pale' = 'warm') {
    return svg('0 0 200 200', moon(prefix(), 100, 100, 100, tone), 'fa-moon-svg', 'overflow="visible"')
  },
  cloud(fill: string, stroke: string, sw = 1.6) {
    return svg('-4 -26 146 50', cloud(fill, stroke, sw, prefix()), 'fa-cloud-svg', 'overflow="visible"')
  },
  // 飘过月面的薄雾（万圣节）：几团互相叠着的柔边椭圆，而不是描边的线条——线条在
  // 亮月面上读成一道道横纹。
  // Mist drifting across the moon (Halloween): overlapping soft-edged ellipses,
  // not stroked lines, which read as stripes against the bright moon.
  wisp() {
    const p = prefix()
    const blobs: [number, number, number, number, number][] = [
      [40, 34, 46, 9, 0.5], [96, 30, 60, 12, 0.62], [160, 36, 56, 10, 0.55], [214, 31, 50, 9, 0.5], [262, 35, 38, 7, 0.4],
      [120, 42, 70, 7, 0.35], [200, 43, 60, 6, 0.3],
    ]
    return svg(
      '0 0 300 60',
      '<defs><radialGradient id="' + p + 'w"><stop offset="0" stop-color="#8C8198" stop-opacity=".55"/><stop offset=".6" stop-color="#6E6380" stop-opacity=".25"/><stop offset="1" stop-color="#6E6380" stop-opacity="0"/></radialGradient></defs>' +
        blobs.map(([x, y, rx, ry, o]) => '<ellipse cx="' + x + '" cy="' + y + '" rx="' + rx + '" ry="' + ry + '" fill="url(#' + p + 'w)" opacity="' + o + '"/>').join(''),
      'fa-wisp-svg'
    )
  },
  bat(color: string, delay = 0) {
    return svg('-34 -16 68 28', bat(color, delay), 'fa-bat-svg', 'overflow="visible"')
  },
  pumpkin(face: boolean, delay = 0) {
    return svg('-130 -64 260 124', pumpkin(0, 0, 1, face, prefix(), { glow: face, delay }), 'fa-pumpkin-svg', 'overflow="visible"')
  },
  rabbit() {
    return svg('-44 -66 84 96', rabbit(prefix()), 'fa-rabbit-svg', 'overflow="visible"')
  },
  mooncake() {
    return svg('-90 -30 180 80', mooncake(0, 0, 1), 'fa-mooncake-svg', 'overflow="visible"')
  },
  stars(n: number, seed: number, color: string) {
    return svg('0 0 1000 400', stars(n, 1000, 400, seed, color), 'fa-stars-svg', 'preserveAspectRatio="xMidYMid slice"')
  },
  spider(threadLen: number) {
    return spiderSvg(threadLen)
  },
  lantern(len: number, glyph: string | null) {
    return lanternSvg(prefix(), len, glyph)
  },
  // 右下角的一道雪坡，松树立在上面。/ a snowbank in the bottom-right for the pines
  snowbank() {
    return svg(
      '0 0 600 90',
      '<defs><linearGradient id="fa-snowbank" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#E9EEF3"/><stop offset="1" stop-color="#B9C4CF"/></linearGradient></defs>' +
        '<path d="M0 90 C90 60 180 40 300 38 C420 36 520 30 600 22 L600 90 Z" fill="url(#fa-snowbank)" opacity=".92"/>' +
        '<path d="M60 76 C150 52 250 44 360 44 C450 44 530 38 600 32" fill="none" stroke="#fff" stroke-width="2" opacity=".5"/>',
      'fa-snowbank-svg',
      'preserveAspectRatio="none"'
    )
  },
  cloudOutline(stroke: string) {
    return svg('-4 -26 146 50', cloud('none', stroke, 1.6), 'fa-cloud-svg', 'overflow="visible"')
  },
  plumBranch() {
    return plumBranch()
  },
  osmanthusBranch() {
    return osmanthusBranch()
  },
  fairyLights() {
    return fairyLights()
  },
  // 收尾区横跨全宽的扁长灯串。/ the long, flat string across the closing section
  lightsBetween(w: number, h: number, drapes: number[][], skip?: (x: number, y: number) => boolean) {
    return lightsBetween(w, h, drapes, skip)
  },
  fairyLightsWide() {
    return fairyLights(2600, 4)
  },
  year(y: number) {
    return yearOutline(y)
  },
  yearStacked(y: number) {
    return yearStacked(y)
  },
  pines() {
    return svg(
      '0 0 400 160',
      pine(40, 156, 0.5, '#15302B', null) + pine(110, 160, 0.72, '#183A33', '#15302B') + pine(200, 158, 0.9, PINE_C) +
        pine(290, 160, 0.62, '#183A33', '#15302B') + pine(360, 156, 0.46, '#15302B', null),
      'fa-pines-svg',
      'overflow="visible"'
    )
  },
}
