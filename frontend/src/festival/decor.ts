// 节日小装饰 / small festival decorations
//
// art.ts 画的是「场景」（首屏布景、问候卡、空状态），这里画的是挂在界面零件上的
// 小东西：按钮上的积雪和中国结、头像上的帽子、分区角落的灯笼与蛛网、页脚上沿的
// 一排彩旗、新信号进场时迸出来的碎片。
// art.ts draws scenes; this file draws the small things hung on interface
// parts: snow and knots on buttons, hats on the avatar, lanterns and webs in
// section corners, bunting along the footer, and the confetti that bursts out
// when a new signal arrives.
//
// 所有装饰都只是叠加层：不改变宿主元素的颜色、尺寸和可点击区域。
// Every decoration is an overlay: it never changes its host's colour, size or
// hit area.

import type { FestivalKey } from './calendar'
import { GOLD, GOLD_DEEP, bat, moon, sparklePath, star5 } from './art'

let uid = 0
const pre = () => 'fd' + ++uid + '-'
const r1 = (n: number) => Math.round(n * 10) / 10

function svg(viewBox: string, body: string, cls = '', extra = '') {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg"' + (viewBox ? ' viewBox="' + viewBox + '"' : '') + ' class="' + cls +
    '" aria-hidden="true" focusable="false" overflow="visible" ' + extra + '>' + body + '</svg>'
  )
}

const RED = '#D23A2F'
const RED_DEEP = '#9A1D17'
const SNOW = '#F2F5F8'

// ── 零件 / small parts ───────────────────────────────────────────────────────

// top：绳头在外层坐标里的 y（默认绳长 40）。角饰里传 -2，绳子一直接到卡片上沿。
// top: the string's top in outer coordinates (default length 40). Corners pass -2
// so the string runs all the way up to the card's top edge.
function miniLantern(x: number, y: number, s: number, glyph = false, top?: number) {
  const y1 = top === undefined ? -40 : r1((top - y) / s)
  return (
    '<g transform="translate(' + x + ' ' + y + ') scale(' + s + ')"><g class="fd-sway">' +
    '<line x1="0" y1="' + y1 + '" x2="0" y2="0" stroke="' + GOLD_DEEP + '" stroke-width="1.4"/>' +
    '<rect x="-8" y="-1" width="16" height="4" rx="1.5" fill="' + GOLD + '"/>' +
    '<ellipse cx="0" cy="14" rx="17" ry="13" fill="' + RED + '"/>' +
    '<ellipse cx="0" cy="14" rx="9.5" ry="13" fill="none" stroke="' + RED_DEEP + '" stroke-width="1.1" opacity=".75"/>' +
    '<path d="M-13 7 C-17 12 -16 19 -12 23" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" opacity=".16"/>' +
    (glyph ? '<text x="0" y="15" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="700" fill="' + GOLD + '" class="fa-kai">福</text>' : '') +
    '<rect x="-8" y="25" width="16" height="4" rx="1.5" fill="' + GOLD + '"/>' +
    '<g class="fd-sway-soft" stroke="' + GOLD + '" stroke-width="1.1" stroke-linecap="round"><line x1="-2" y1="29" x2="-2.6" y2="40"/><line x1="0" y1="29" x2="0" y2="42"/><line x1="2" y1="29" x2="2.6" y2="40"/></g>' +
    '</g></g>'
  )
}

// 中国结：菱形盘长结 + 金环 + 流苏。/ Chinese knot: diamond weave, gold ring, tassel
function knot() {
  return (
    '<g class="fd-sway">' +
    '<line x1="8" y1="-6" x2="8" y2="3" stroke="' + GOLD_DEEP + '" stroke-width="1.2"/>' +
    '<circle cx="8" cy="4.5" r="2.2" fill="none" stroke="' + GOLD + '" stroke-width="1.3"/>' +
    '<g transform="translate(8 15) rotate(45)">' +
    '<rect x="-6.5" y="-6.5" width="13" height="13" rx="2" fill="' + RED + '"/>' +
    '<path d="M-6.5 -2 H6.5 M-6.5 2 H6.5 M-2 -6.5 V6.5 M2 -6.5 V6.5" stroke="' + RED_DEEP + '" stroke-width="1"/>' +
    '<rect x="-6.5" y="-6.5" width="13" height="13" rx="2" fill="none" stroke="' + GOLD + '" stroke-width=".8" opacity=".7"/>' +
    '</g>' +
    '<rect x="6" y="24" width="4" height="3" rx="1" fill="' + GOLD + '"/>' +
    '<g class="fd-sway-soft" stroke="' + RED + '" stroke-width="1.2" stroke-linecap="round"><line x1="6.6" y1="27" x2="6" y2="38"/><line x1="8" y1="27" x2="8" y2="40"/><line x1="9.4" y1="27" x2="10" y2="38"/></g>' +
    '</g>'
  )
}

// 定价卡角上的「福」：菱形中心在 (0,0)，下角 (0,25.2) 接一颗金扣，流苏从扣下垂。
// The 福 on the pricing card's corner: diamond centred on (0,0); a gold cap on
// its bottom point (0,25.2) and the tassel hanging from that cap.
function fuTassel() {
  return (
    '<g class="fd-sway-soft">' +
    '<rect x="-2.4" y="22.4" width="4.8" height="6" rx="1.2" fill="' + GOLD + '"/>' +
    '<g stroke="' + RED + '" stroke-width="2.2" stroke-linecap="round"><line x1="-1.3" y1="28.2" x2="-2" y2="52"/><line x1="0" y1="28.2" x2="0" y2="55"/><line x1="1.3" y1="28.2" x2="2" y2="52"/></g>' +
    '</g>' +
    '<g transform="rotate(45)">' +
    '<rect x="-17" y="-17" width="34" height="34" rx="4" fill="' + RED + '" stroke="' + GOLD + '" stroke-width="2.4"/>' +
    '</g>' +
    '<text x="0" y="1" text-anchor="middle" dominant-baseline="central" font-size="24" font-weight="700" fill="' + GOLD + '" class="fa-kai">福</text>'
  )
}

// 一朵梅花，(x, y) 是花心；s=1 时花瓣外缘离花心 5.9。/ a plum blossom centred on (x, y); petals reach 5.9 at s=1
function blossom(x: number, y: number, s: number) {
  let petals = ''
  for (let i = 0; i < 5; i++) {
    const a = ((i * 72 - 90) * Math.PI) / 180
    petals += '<circle cx="' + r1(Math.cos(a) * 3.2) + '" cy="' + r1(Math.sin(a) * 3.2) + '" r="2.7" fill="' + (i % 2 ? '#F2A7B8' : '#F6C3CE') + '"/>'
  }
  return '<g transform="translate(' + x + ' ' + y + ') scale(' + s + ')">' + petals + '<circle r="1.5" fill="#F2CC72"/></g>'
}

// 一片落地的花瓣：扁椭圆，最低点在 y=24。/ a fallen petal: a flat ellipse whose lowest point is y=24
function fallen(x: number, rot: number, color: string) {
  return '<ellipse cx="' + x + '" cy="22.5" rx="3.6" ry="1.5" fill="' + color + '" transform="rotate(' + rot + ' ' + x + ' 24)"/>'
}

function tinyPumpkin() {
  return (
    '<ellipse cx="11" cy="20" rx="9" ry="1.6" fill="#000" opacity=".35"/>' +
    '<path d="M10 5 C9.5 2.5 10.6 1 12.4 0.4 L13 1.6 C11.8 2.3 11.6 3.6 12 5 Z" fill="#6B7445"/>' +
    '<ellipse cx="6.4" cy="12.2" rx="6" ry="7.2" fill="#D8662A"/><ellipse cx="15.6" cy="12.2" rx="6" ry="7.2" fill="#D8662A"/>' +
    '<ellipse cx="11" cy="12" rx="6" ry="7.6" fill="#EE7B34"/>' +
    '<g class="fd-flicker" fill="#FFC75E"><path d="M6.6 10.6 L9.2 10.6 L7.9 8.2 Z"/><path d="M12.8 10.6 L15.4 10.6 L14.1 8.2 Z"/>' +
    '<path d="M6.4 13.4 Q11 17.8 15.6 13.4 L13.6 14 L12.8 15.4 L11.6 14.3 L10.4 14.3 L9.2 15.4 L8.4 14 Z"/></g>'
  )
}

function holly(x: number, y: number, s: number) {
  return (
    '<g transform="translate(' + x + ' ' + y + ') scale(' + s + ')">' +
    '<path d="M0 0 C6 -7 15 -5 17 0 C11 -1 6 3 0 0 Z" fill="#2E6B58"/>' +
    '<path d="M0 2 C4 9 13 10 17 5 C11 3 6 5 0 2 Z" fill="#265A4A"/>' +
    '<path d="M0 1 C-6 -6 -15 -4 -16 1 C-10 0 -5 3 0 1 Z" fill="#2A6352"/>' +
    '<circle cx="0" cy="1" r="2.8" fill="#D6453D"/><circle cx="3.6" cy="-1.6" r="2.4" fill="#D6453D"/><circle cx="-3" cy="-1.8" r="2.2" fill="#B8362F"/>' +
    '</g>'
  )
}

function sparkles(pts: [number, number, number, string][]) {
  return pts
    .map(
      ([x, y, r, c], i) =>
        '<g transform="translate(' + x + ' ' + y + ')"><path class="fd-twinkle" style="animation-delay:-' + r1(i * 0.7) + 's" d="' +
        sparklePath(r) + '" fill="' + c + '"/></g>'
    )
    .join('')
}

function bauble(x: number, len: number, r: number, color: string, shine: string, p: string, i: number) {
  return (
    '<g transform="translate(' + x + ' 0)"><g class="fd-sway fd-drop" style="animation-delay:-' + r1(i * 0.9) + 's">' +
    '<line x1="0" y1="0" x2="0" y2="' + len + '" stroke="' + GOLD_DEEP + '" stroke-width="1.2"/>' +
    '<defs><radialGradient id="' + p + 'b' + i + '" cx=".34" cy=".3" r=".8"><stop offset="0" stop-color="' + shine + '"/><stop offset=".55" stop-color="' + color + '"/><stop offset="1" stop-color="#15121F"/></radialGradient></defs>' +
    '<rect x="-4" y="' + (len - 1) + '" width="8" height="6" rx="1.4" fill="' + GOLD + '"/>' +
    '<circle cx="0" cy="' + (len + 5 + r) + '" r="' + r + '" fill="url(#' + p + 'b' + i + ')"/>' +
    '<path d="M' + r1(-r * 0.62) + ' ' + r1(len + 5 + r * 0.7) + ' Q0 ' + r1(len + 5 + r * 1.05) + ' ' + r1(r * 0.62) + ' ' + r1(len + 5 + r * 0.7) + '" fill="none" stroke="' + GOLD + '" stroke-width="1.2" opacity=".6"/>' +
    '<ellipse cx="' + r1(-r * 0.38) + '" cy="' + r1(len + 5 + r * 0.6) + '" rx="' + r1(r * 0.22) + '" ry="' + r1(r * 0.34) + '" fill="#fff" opacity=".45"/>' +
    '</g></g>'
  )
}

// ════════════════════════════════════════════════════════════════════════════
// 按钮装饰 / button toppers
// ════════════════════════════════════════════════════════════════════════════
// 返回若干个定位好的小块（HTML 字符串 + 一个定位类）。积雪用 <pattern> 横向铺满，
// 任意宽度都不变形。
// Returns a few positioned pieces. The snow cap tiles a <pattern> horizontally,
// so it never distorts at any button width.

export interface Piece {
  cls: string
  html: string
}

// hang=false：不要往下垂的挂件（顶栏里的按钮下面就是滚动的内容，垂下去会压住它）。
// hang=false drops hanging pieces (below a header button the content scrolls,
// and anything hanging would lie on top of it).
export function buttonTopper(key: FestivalKey, hang = true): Piece[] {
  const p = pre()
  // 春节的挂件只有中国结（会往下垂），顶栏按钮上就不放：旁边首屏的灯笼绳正从这里垂下。
  // Spring's only button piece is the knot, which hangs; the header button gets
  // none, since the hero lantern strings come down right beside it.
  if (!hang && key === 'spring') return []
  switch (key) {
    case 'christmas':
      return [
        {
          cls: 'fd-cap',
          html: svg(
            '',
            '<defs><pattern id="' + p + 'snow" width="26" height="12" patternUnits="userSpaceOnUse">' +
              '<path d="M0 6 C4 1.2 9 1 13 4.2 C17 1 22 1.6 26 6 L26 9 C21 10.4 17 8.2 13 10 C9 8.4 4 10.4 0 9 Z" fill="' + SNOW + '"/></pattern></defs>' +
              '<rect x="0" y="0" width="100%" height="12" fill="url(#' + p + 'snow)"/>',
            'fd-fill',
            'height="100%" width="100%"'
          ),
        },
      ]
    case 'spring':
      return [{ cls: 'fd-knot', html: svg('0 -6 16 48', knot()) }]
    case 'halloween':
      return [{ cls: 'fd-pumpkin', html: svg('0 0 22 22', tinyPumpkin()) }]
    case 'midautumn':
      // 兔耳从按钮上沿探出来：只画露在上沿之上的部分，像兔子躲在按钮后面。
      // Rabbit ears peeking over the top edge: only what shows above it, as if
      // the rabbit were hiding behind the button.
      return [
        {
          cls: 'fd-ears',
          html: svg(
            '0 0 24 18',
            '<g class="fd-ear-b"><path d="M6 18 C3 10 5 1 8 1.6 C10.8 2.2 10 11 9.6 18 Z" fill="#E2DBCE"/></g>' +
              '<g class="fd-ear-f"><path d="M13.4 18 C13 10 14.6 0.6 17.6 1 C20.6 1.4 19 10.6 16.8 18 Z" fill="#ECE6DA"/><path d="M14.8 17 C14.8 11 15.8 4 17.4 4.2 C18.8 4.4 17.8 11 16.4 17 Z" fill="#E6B4AC"/></g>' +
              '<path d="M2 18 C4 14.2 20 14.2 22 18 Z" fill="#ECE6DA"/>'
          ),
        },
      ]
    case 'newyear':
      return [
        {
          cls: 'fd-sparks',
          html: svg('0 0 30 30', sparkles([[22, 6, 5.4, '#F1D08A'], [9, 3, 3.2, '#E6E8EE'], [27, 20, 3, '#A99BFF']])),
        },
      ]
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 头像帽子 / avatar hats  (0–100 对齐头像方框 / 0–100 box on the avatar)
// ════════════════════════════════════════════════════════════════════════════

export function avatarHat(key: FestivalKey): string {
  const p = pre()
  switch (key) {
    case 'christmas':
      return svg(
        '0 0 100 100',
        '<g class="fd-hat" transform="rotate(14 60 20)">' +
          '<path d="M22 22 C34 -6 62 -18 86 -4 C78 -2 72 6 70 22 Z" fill="#C8332B"/>' +
          '<path d="M30 16 C40 -2 60 -10 76 -4" fill="none" stroke="#E4574D" stroke-width="3" stroke-linecap="round" opacity=".6"/>' +
          '<rect x="16" y="17" width="62" height="13" rx="6.5" fill="' + SNOW + '"/>' +
          '<circle cx="88" cy="-3" r="8" fill="' + SNOW + '"/>' +
          '</g>'
      )
    case 'halloween':
      return svg(
        '0 0 100 100',
        '<g class="fd-hat" transform="rotate(-10 50 20)">' +
          '<path d="M30 18 C38 0 48 -14 70 -26 C64 -12 66 4 72 18 Z" fill="#1C1724" stroke="#F28A3A" stroke-width="2.4" stroke-linejoin="round"/>' +
          '<path d="M32 11 Q51 16 70 11 L71.6 17 Q51 22 30.6 17 Z" fill="#F28A3A"/>' +
          '<ellipse cx="51" cy="19" rx="36" ry="7.5" fill="#1C1724" stroke="#F28A3A" stroke-width="2.4"/>' +
          '</g>'
      )
    case 'midautumn':
      return svg(
        '0 0 100 100',
        '<g class="fd-ear-b"><path d="M30 16 C18 -18 30 -34 40 -30 C48 -26 44 -2 42 18 Z" fill="#E2DBCE"/></g>' +
          '<g class="fd-ear-f"><path d="M58 18 C58 -6 64 -34 74 -32 C86 -30 80 -6 70 18 Z" fill="#ECE6DA"/><path d="M62 12 C63 -8 67 -26 72 -25 C78 -24 74 -6 68 12 Z" fill="#E6B4AC"/></g>'
      )
    case 'spring':
      return svg(
        '0 0 100 100',
        '<g class="fd-hat" transform="translate(84 84) rotate(45)">' +
          '<rect x="-17" y="-17" width="34" height="34" rx="4" fill="' + RED + '" stroke="' + GOLD + '" stroke-width="2.4"/>' +
          '<text x="0" y="1" transform="rotate(-45)" text-anchor="middle" dominant-baseline="central" font-size="24" font-weight="700" fill="' + GOLD + '" class="fa-kai">福</text>' +
          '</g>'
      )
    case 'newyear':
      return svg(
        '0 0 100 100',
        '<defs><clipPath id="' + p + 'cone"><path d="M28 22 L60 -30 L80 22 Z"/></clipPath></defs>' +
          '<g class="fd-hat" transform="rotate(12 54 10)">' +
          '<path d="M28 22 L60 -30 L80 22 Z" fill="#5A22EE"/>' +
          '<g clip-path="url(#' + p + 'cone)" stroke="' + GOLD + '" stroke-width="5"><line x1="20" y1="4" x2="90" y2="-10"/><line x1="20" y1="20" x2="90" y2="6"/><line x1="20" y1="-12" x2="90" y2="-26"/></g>' +
          '<ellipse cx="54" cy="22" rx="27" ry="5" fill="#E6E8EE"/>' +
          '<circle cx="60" cy="-31" r="6.5" fill="' + GOLD + '"/>' +
          '</g>' +
          sparkles([[92, 4, 6, '#F1D08A'], [12, 10, 4, '#A99BFF']])
      )
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 小角标（Tab、铃铛）/ mini corner pieces for tabs and the bell  (0 0 24 24)
// ════════════════════════════════════════════════════════════════════════════

export function mini(key: FestivalKey): string {
  const p = pre()
  switch (key) {
    case 'christmas':
      return svg('0 0 24 24', holly(12, 12, 0.62))
    case 'spring':
      // 一小枝梅花别在角上（和圣诞的冬青同一种做法）。不用红色菱形：铃铛角上的红标会被读成「有未读」。
      // A small plum sprig pinned at the corner, like Christmas's holly. No red
      // diamond: a red mark on the bell's corner would read as "unread".
      return svg(
        '0 0 24 24',
        '<path d="M3 20 C8 16 12 12 20 5" fill="none" stroke="#5A3A2E" stroke-width="1.6" stroke-linecap="round"/><path d="M11 13 C12 10 12 8 11 6" fill="none" stroke="#5A3A2E" stroke-width="1.1" stroke-linecap="round"/>' +
          blossom(16, 8, 1) + blossom(8, 16, 0.8) + '<circle cx="11" cy="5.6" r="1.6" fill="#E07A93"/>'
      )
    case 'halloween':
      // 蝙蝠整张图宽 68，缩到 .34 正好装进 24 的方框，翅膀不会伸到隔壁的按钮上。
      // The bat art is 68 wide; at .34 it fits the 24 box, so its wings never reach the neighbouring button.
      return svg('0 0 24 24', '<g transform="translate(12 12) scale(.34)"><g class="fd-float">' + bat('#F28A3A', 0.2) + '</g></g>')
    case 'midautumn':
      return svg('0 0 24 24', moon(p, 12, 12, 8))
    case 'newyear':
      return svg('0 0 24 24', sparkles([[14, 9, 6, '#F1D08A'], [5, 17, 3.2, '#A99BFF']]))
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 分区角落 / section corners  (0 0 220 240, 贴右上角 / anchored top-right)
// ════════════════════════════════════════════════════════════════════════════

export function corner(key: FestivalKey): string {
  const p = pre()
  switch (key) {
    case 'spring':
      return svg(
        '0 0 220 240',
        '<g class="fd-c-a">' + miniLantern(150, 70, 1.35, true, -2) + '</g>' +
          '<g class="fd-c-b">' + miniLantern(196, 44, 0.95, false, -2) + '</g>' +
          '<g class="fd-c-c" transform="translate(30 150) scale(.5)"><path d="M0 20 H122 C134 20 138 6 128 0 C124 -10 110 -11 105 -1 C103 -19 80 -24 72 -8 C66 -23 43 -21 41 -4 C33 -13 18 -8 21 4 C9 2 0 10 0 20 Z" fill="none" stroke="' + GOLD_DEEP + '" stroke-width="2.4" stroke-linejoin="round"/></g>' +
          sparkles([[92, 40, 5, GOLD], [120, 190, 3.6, GOLD]])
      )
    case 'christmas':
      return svg(
        '0 0 220 240',
        // 顶上一段松枝：左端钉在卡片上沿，右端伸出卡片右缘；下面垂着三颗彩球，
        // 挂绳从上沿垂下。
        // A pine swag: its left end pinned to the card's top edge, its right end
        // running out past the card's right edge; three baubles hang below on
        // strings from the top edge.
        '<g class="fd-c-swag">' +
          '<path d="M40 -3 C90 34 150 34 236 -2" fill="none" stroke="#1D3F37" stroke-width="10" stroke-linecap="round"/>' +
          '<path d="M40 -3 C90 34 150 34 236 -2" fill="none" stroke="#2A5A4C" stroke-width="4" stroke-dasharray="2 6" stroke-linecap="round"/>' +
          holly(122, 22, 1) +
          '</g>' +
          bauble(88, 36, 15, '#C9A24E', '#FFF1C8', p, 0) + bauble(142, 58, 19, '#6A4BE0', '#D9CFFF', p, 1) + bauble(190, 30, 13, '#AEB7C2', '#FFFFFF', p, 2)
      )
    case 'halloween': {
      // 蛛网：织在卡片右上角里。最外两根丝就贴着上沿和右沿（两面「墙」），中间的
      // 放射丝止于最外一圈横丝，没有伸到半空的线头；丝线入场时一根根「织」出来。
      // A web spun into the card's top-right corner. The outermost threads run
      // along the top and right edges (the two "walls"); the inner spokes stop at
      // the outer ring, with no ends dangling in the air. Woven in thread by
      // thread on entrance.
      const cx = 220
      const cy = 0
      const angles = [90, 112, 135, 158, 180]
      const spokes = angles
        .map((a, i) => {
          const rad = (a * Math.PI) / 180
          const len = i === 0 || i === angles.length - 1 ? 220 : 158
          return '<line class="fd-web" x1="' + cx + '" y1="' + cy + '" x2="' + r1(cx + Math.cos(rad) * len) + '" y2="' + r1(cy + Math.sin(rad) * len) + '"/>'
        })
        .join('')
      let rings = ''
      ;[40, 78, 118, 158].forEach((r) => {
        let d = ''
        angles.forEach((a, i) => {
          const rad = (a * Math.PI) / 180
          const x = r1(cx + Math.cos(rad) * r)
          const y = r1(cy + Math.sin(rad) * r)
          if (i === 0) d += 'M' + x + ' ' + y
          else {
            const mid = ((angles[i - 1] + a) / 2) * (Math.PI / 180)
            const qx = r1(cx + Math.cos(mid) * r * 0.86)
            const qy = r1(cy + Math.sin(mid) * r * 0.86)
            d += ' Q' + qx + ' ' + qy + ' ' + x + ' ' + y
          }
        })
        rings += '<path class="fd-web" d="' + d + '"/>'
      })
      return svg(
        '0 0 220 240',
        '<g fill="none" stroke="#9A93A6" stroke-width="1" opacity=".55">' + spokes + rings + '</g>' +
          '<g class="fd-c-spider" transform="translate(150 0)"><g class="fd-bob">' +
          '<line x1="0" y1="0" x2="0" y2="118" stroke="#8A8494" stroke-width="1"/>' +
          '<g transform="translate(0 126)"><g fill="none" stroke="#3A3644" stroke-width="1.6" stroke-linecap="round">' +
          '<path d="M0 -2 C-7 -9 -11 -7 -13 -2"/><path d="M0 0 C-8 -3 -11 0 -14 5"/><path d="M0 2 C-8 2 -10 6 -12 10"/>' +
          '<path d="M0 -2 C7 -9 11 -7 13 -2"/><path d="M0 0 C8 -3 11 0 14 5"/><path d="M0 2 C8 2 10 6 12 10"/></g>' +
          '<ellipse cx="0" cy="2" rx="6" ry="7.4" fill="#0E0D12" stroke="#4A4555"/><circle cx="0" cy="-7" r="4" fill="#0E0D12" stroke="#4A4555"/>' +
          '<circle cx="-1.4" cy="-7.4" r=".9" fill="#F28A3A"/><circle cx="1.4" cy="-7.4" r=".9" fill="#F28A3A"/></g>' +
          '</g></g>' +
          '<g class="fd-c-bat" transform="translate(64 190) scale(.9)"><g class="fd-float">' + bat('#2C2536', 0.3) + '</g></g>'
      )
    }
    case 'midautumn':
      return svg(
        '0 0 220 240',
        '<g class="fd-c-sprig"><g class="fd-sway-slow">' +
          '<path d="M230 4 C190 20 160 40 130 78 C118 94 110 104 96 110" fill="none" stroke="#3B2E26" stroke-width="4" stroke-linecap="round"/>' +
          '<path d="M170 34 C160 56 156 72 160 92" fill="none" stroke="#3B2E26" stroke-width="2.4" stroke-linecap="round"/>' +
          leafs([[186, 24, 150], [158, 50, 230], [146, 70, 190], [120, 92, 150], [164, 84, 260], [104, 104, 200], [200, 12, 170]]) +
          flowers([[176, 34], [170, 44], [150, 62], [140, 80], [158, 78], [114, 100], [124, 90], [162, 96]]) +
          '</g></g>' +
          '<g class="fd-c-moon">' + moon(p, 60, 170, 26) + '</g>' +
          '<g class="fd-c-cloud" transform="translate(20 184) scale(.5)"><path d="M0 20 H122 C134 20 138 6 128 0 C124 -10 110 -11 105 -1 C103 -19 80 -24 72 -8 C66 -23 43 -21 41 -4 C33 -13 18 -8 21 4 C9 2 0 10 0 20 Z" fill="#15151C" stroke="#E3D2A2" stroke-width="2.4" stroke-linejoin="round"/></g>'
      )
    case 'newyear': {
      // 彩带：从顶上垂下的卷曲丝带，入场时从上往下「展开」。
      // Streamers: curling ribbons hanging from the top, unfurling downward on entrance.
      const ribbon = (x: number, len: number, color: string, i: number) => {
        let d = 'M' + x + ' 0'
        for (let y = 0; y < len; y += 24) {
          const dir = (y / 24) % 2 ? -1 : 1
          d += ' C' + (x + 14 * dir) + ' ' + (y + 6) + ' ' + (x + 14 * dir) + ' ' + (y + 18) + ' ' + x + ' ' + (y + 24)
        }
        return '<path class="fd-streamer" style="animation-delay:-' + r1(i * 0.8) + 's" d="' + d + '" fill="none" stroke="' + color + '" stroke-width="3.2" stroke-linecap="round"/>'
      }
      let dots = ''
      const cols = ['#A99BFF', '#F1D08A', '#E6E8EE']
      for (let i = 0; i < 16; i++) {
        const x = r1(40 + ((i * 53) % 170))
        const y = r1(30 + ((i * 37) % 190))
        dots += '<rect class="fd-conf" x="' + x + '" y="' + y + '" width="5" height="8" rx="1" fill="' + cols[i % 3] + '" transform="rotate(' + ((i * 47) % 180) + ' ' + x + ' ' + y + ')"/>'
      }
      return svg(
        '0 0 220 240',
        ribbon(110, 150, '#8F7BFF', 0) + ribbon(150, 190, '#F1D08A', 1) + ribbon(190, 120, '#E6E8EE', 2) + ribbon(76, 96, '#F1D08A', 3) +
          dots + sparkles([[60, 60, 7, '#F1D08A'], [180, 210, 5, '#A99BFF'], [30, 140, 4, '#E6E8EE']])
      )
    }
  }
}

function leafs(arr: [number, number, number][]) {
  return arr
    .map(
      ([x, y, rot]) =>
        '<g transform="translate(' + x + ' ' + y + ') rotate(' + rot + ')"><path d="M0 0 C7 -6 19 -6 27 0 C19 6 7 6 0 0 Z" fill="#2F4B3F"/><path d="M2 0 L24 0" stroke="#4A6C5B" stroke-width=".8"/></g>'
    )
    .join('')
}
function flowers(arr: [number, number][]) {
  return arr
    .map(
      ([x, y]) =>
        '<g transform="translate(' + x + ' ' + y + ')"><g fill="#F2B544"><circle cx="2.4" cy="1" r="2.1"/><circle cx="-1" cy="2.4" r="2.1"/><circle cx="-2.4" cy="-1" r="2.1"/><circle cx="1" cy="-2.4" r="2.1"/></g><circle r="1.2" fill="#C9801C"/></g>'
    )
    .join('')
}

// ════════════════════════════════════════════════════════════════════════════
// 地面饰带（页脚上沿）/ ground strips along the top of footers
// ════════════════════════════════════════════════════════════════════════════
// 横向用 <pattern> 铺满全宽，两端再放几件「主角」。
// A <pattern> tiles the full width; a few feature pieces sit at the ends.

export function ground(key: FestivalKey): { strip: string; end: string } {
  const p = pre()
  switch (key) {
    case 'spring':
      // 落在分隔线上的梅花和花瓣：每一朵、每一片的下沿都正好在地面线 y=24 上。
      // Plum blossoms and petals fallen on the rule: every blossom and petal
      // rests with its lower edge exactly on the ground line y=24.
      return {
        strip: svg(
          '',
          '<defs><pattern id="' + p + 'g" width="168" height="24" patternUnits="userSpaceOnUse">' +
            blossom(20, 24 - 5.9, 1) + blossom(104, 24 - 5.9 * 0.78, 0.78) +
            fallen(44, 0, '#F2A7B8') + fallen(58, 18, '#E07A93') + fallen(76, -10, '#F2A7B8') + fallen(128, 12, '#F6C3CE') + fallen(146, -16, '#E07A93') + fallen(160, 6, '#F2A7B8') +
            '</pattern></defs><rect width="100%" height="24" fill="url(#' + p + 'g)"/>',
          'fd-fill fd-bottom',
          'height="100%" width="100%"'
        ),
        end: '',
      }
    case 'newyear':
      // 落在分隔线上的彩纸片和卷起来的彩带头：都平躺在地面线 y=24 上。
      // Confetti and curled streamer scraps lying flat on the ground line y=24.
      return {
        strip: svg(
          '',
          '<defs><pattern id="' + p + 'g" width="150" height="24" patternUnits="userSpaceOnUse">' +
            [[10, 6, '#8F7BFF'], [34, -9, GOLD], [49, 4, '#E6E8EE'], [88, -5, '#8F7BFF'], [101, 11, GOLD], [131, -3, '#E6E8EE']]
              .map(([x, a, c]) => '<rect x="' + x + '" y="21.6" width="6.4" height="2.2" rx=".6" fill="' + c + '" transform="rotate(' + a + ' ' + (Number(x) + 3.2) + ' 23)"/>')
              .join('') +
            '<path d="M60 23.4 C62 18.6 67 18.6 67.6 21.6 C68.2 24 64.6 24.2 64.4 22 C64.2 19.8 68.6 18.8 71 21.4 C72.2 22.8 73.6 23.6 76 23.4" fill="none" stroke="' + GOLD + '" stroke-width="1.6" stroke-linecap="round"/>' +
            '<path d="M112 23.4 C114.6 19.2 119.2 19.4 119.4 22 C119.6 24 116.4 24 116.4 22.2 C116.4 20 120.6 19.4 123 22 C124.2 23.2 126 23.6 128 23.4" fill="none" stroke="#8F7BFF" stroke-width="1.6" stroke-linecap="round"/>' +
            '</pattern></defs><rect width="100%" height="24" fill="url(#' + p + 'g)"/>',
          'fd-fill fd-bottom',
          'height="100%" width="100%"'
        ),
        end: svg('0 0 60 40', sparkles([[40, 10, 7, '#F1D08A'], [14, 22, 4, '#A99BFF']]), 'fd-sparks-end'),
      }
    case 'christmas':
      return {
        strip: svg(
          '',
          '<defs><pattern id="' + p + 'g" width="180" height="30" patternUnits="userSpaceOnUse">' +
            '<path d="M0 18 C30 10 60 12 90 16 C120 20 150 12 180 18 L180 30 L0 30 Z" fill="' + SNOW + '" opacity=".9"/>' +
            '<path d="M0 18 C30 10 60 12 90 16 C120 20 150 12 180 18" fill="none" stroke="#fff" stroke-width="1.2" opacity=".6"/>' +
            '</pattern></defs><rect width="100%" height="30" fill="url(#' + p + 'g)"/>',
          'fd-fill fd-bottom',
          'height="100%" width="100%"'
        ),
        end: svg(
          '0 0 150 70',
          [[26, 70, 0.3], [70, 70, 0.44], [112, 70, 0.36]]
            .map(([x, y, s]) => '<g transform="translate(' + x + ' ' + y + ') scale(' + s + ')"><rect x="-6" y="-8" width="12" height="10" fill="#3A2C24"/><path d="M0 -150 L40 -92 L21 -94 L56 -42 L29 -44 L68 0 L-68 0 L-29 -44 L-56 -42 L-21 -94 L-40 -92 Z" fill="#1F4A40"/><path d="M0 -150 L15 -128 Q8 -122 2 -127 Q-4 -121 -10 -126 L-15 -128 Z" fill="' + SNOW + '"/></g>')
            .join('') + star5(70, 3, 5, '#F3CE6A', 'fd-twinkle'),
          'fd-end-pines'
        ),
      }
    case 'halloween':
      return {
        strip: svg(
          '',
          '<defs><pattern id="' + p + 'g" width="64" height="24" patternUnits="userSpaceOnUse">' +
            '<path d="M0 24 L3 14 L5 24 L8 10 L11 24 L15 16 L17 24 L22 12 L25 24 L30 18 L33 24 L38 9 L41 24 L46 15 L49 24 L54 12 L57 24 L61 17 L64 24 Z" fill="#1A1622"/>' +
            '</pattern></defs><rect width="100%" height="24" fill="url(#' + p + 'g)"/>',
          'fd-fill fd-bottom',
          'height="100%" width="100%"'
        ),
        end: svg(
          '0 0 120 50',
          '<g transform="translate(0 16)">' + tinyPumpkin() + '</g>' +
            '<g transform="translate(26 4) scale(1.5)">' + tinyPumpkin() + '</g>' +
            '<g transform="translate(88 18) scale(1.1)">' + tinyPumpkin() + '</g>',
          'fd-end-pumpkins'
        ),
      }
    case 'midautumn':
      return {
        strip: svg(
          '',
          '<defs><pattern id="' + p + 'g" width="150" height="28" patternUnits="userSpaceOnUse">' +
            '<g transform="translate(10 12) scale(.46)"><path d="M0 20 H122 C134 20 138 6 128 0 C124 -10 110 -11 105 -1 C103 -19 80 -24 72 -8 C66 -23 43 -21 41 -4 C33 -13 18 -8 21 4 C9 2 0 10 0 20 Z" fill="none" stroke="#8E7F5C" stroke-width="2.2" stroke-linejoin="round"/></g>' +
            '<g fill="#F2B544" opacity=".8"><circle cx="100" cy="10" r="1.6"/><circle cx="118" cy="18" r="1.3"/><circle cx="134" cy="8" r="1.1"/></g>' +
            '</pattern></defs><rect width="100%" height="28" fill="url(#' + p + 'g)"/>',
          'fd-fill',
          'height="100%" width="100%"'
        ),
        end: svg(
          '-44 -66 84 96',
          '<g class="fa-rabbit"><ellipse cx="2" cy="24" rx="34" ry="5" fill="#000" opacity=".35"/><g class="fa-rabbit-body">' +
            '<path d="M-27 -28 C-37 -57 -25 -63 -20 -31 Z" fill="#E2DBCE"/><ellipse cx="4" cy="4" rx="27" ry="21" fill="#ECE6DA"/><circle cx="-18" cy="-16" r="14.5" fill="#ECE6DA"/>' +
            '<g class="fa-ear-f"><path d="M-17 -28 C-12 -60 1 -60 -9 -27 Z" fill="#ECE6DA"/><path d="M-14 -31 C-11 -52 -4 -53 -10 -30 Z" fill="#E6B4AC"/></g>' +
            '<circle cx="28" cy="6" r="7" fill="#F7F3EB"/><ellipse class="fa-eye" cx="-25" cy="-19" rx="1.9" ry="1.9" fill="#3A2A2A"/><circle cx="-31.5" cy="-12.5" r="1.4" fill="#D69A92"/></g></g>',
          'fd-end-rabbit'
        ),
      }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 顶栏下沿的挂饰（App）/ garland under the app header
// ════════════════════════════════════════════════════════════════════════════

export function garland(key: FestivalKey): { strip: string; left: string; right: string } {
  const p = pre()
  switch (key) {
    // 顶栏是吸顶的，垂到它外面的东西会压住滚到下面的内容，而钉在顶栏内边距里的饰带
    // 又没有东西可挂。所以这里只有两端的挂件：挂绳都从 y=0（图的上沿）开始，CSS 把
    // 图的上沿对准顶栏下沿那条分隔线，只在内容栏两侧有空白时出现（≥1440px）。
    // The header is sticky: anything hanging below it would lie over content
    // scrolling underneath, and a strip pinned inside its padding has nothing to
    // hang from. So only the two end pieces remain. Every string starts at y=0
    // (the art's top edge); CSS puts that edge on the header's bottom rule, and
    // they only appear where the content column leaves margins (≥1440px).
    case 'christmas':
      return {
        strip: '',
        left: svg('0 0 40 70', bauble(20, 26, 10, '#C9A24E', '#FFF1C8', p, 0)),
        right: svg('0 0 40 70', bauble(20, 34, 11, '#6A4BE0', '#D9CFFF', p, 1)),
      }
    case 'newyear': {
      const curl = (color: string, i: number) =>
        svg(
          '0 0 40 70',
          '<path class="fd-streamer" style="animation-delay:-' + r1(i * 0.8) + 's" d="M20 0 C31 6 31 16 20 22 C9 28 9 38 20 44 C31 50 31 58 22 64" fill="none" stroke="' + color + '" stroke-width="3" stroke-linecap="round"/>'
        )
      return { strip: '', left: curl(GOLD, 0), right: curl('#8F7BFF', 1) }
    }
    case 'spring':
      return { strip: '', left: svg('0 0 40 70', miniLantern(20, 14, 0.8, true, 0)), right: svg('0 0 40 70', miniLantern(20, 14, 0.8, true, 0)) }
    case 'halloween':
      return {
        strip: '',
        left: svg(
          '0 0 60 60',
          '<g fill="none" stroke="#9A93A6" stroke-width=".8" opacity=".5"><line x1="0" y1="0" x2="58" y2="4"/><line x1="0" y1="0" x2="46" y2="30"/><line x1="0" y1="0" x2="20" y2="52"/><line x1="0" y1="0" x2="4" y2="58"/>' +
            '<path d="M18 1 Q16 8 15 10 Q10 14 6 17 Q6 17 1.4 18"/><path d="M36 2.6 Q31 14 30 20 Q20 28 13 34 Q8 36 2.6 36"/></g>'
        ),
        // 倒挂的蝙蝠：一根丝从顶栏下沿垂下来。/ an upside-down bat on a thread from the header's bottom rule
        right: svg('-34 0 68 44', '<line x1="0" y1="0" x2="0" y2="12" stroke="#8A8494" stroke-width=".8"/><g transform="translate(0 16) rotate(180)"><g class="fd-float">' + bat('#F28A3A', 0.1) + '</g></g>'),
      }
    case 'midautumn':
      return {
        strip: '',
        left: '',
        right: svg(
          '0 0 120 60',
          '<g class="fd-sway-slow"><path d="M122 0 C100 10 84 20 66 38" fill="none" stroke="#3B2E26" stroke-width="2.6" stroke-linecap="round"/>' +
            leafs([[104, 8, 150], [88, 18, 210], [76, 28, 160], [96, 22, 250]]) + flowers([[96, 14], [84, 24], [72, 34], [92, 28]]) + '</g>'
        ),
      }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 新信号迸发的碎片 / shards for the new-signal burst
// ════════════════════════════════════════════════════════════════════════════

export function shards(key: FestivalKey): string[] {
  switch (key) {
    case 'christmas': {
      const flake = (c: string) =>
        svg('-10 -10 20 20', '<g stroke="' + c + '" stroke-width="1.6" stroke-linecap="round">' +
          [0, 60, 120].map((a) => '<line x1="0" y1="-8" x2="0" y2="8" transform="rotate(' + a + ')"/><line x1="-2.6" y1="-6" x2="0" y2="-4" transform="rotate(' + a + ')"/><line x1="2.6" y1="-6" x2="0" y2="-4" transform="rotate(' + a + ')"/>').join('') + '</g>')
      return [flake('#F2F5F8'), flake('#DBEAF5'), flake('#F3CE6A')]
    }
    case 'spring':
      return [
        svg('-10 -10 20 20', '<circle r="8" fill="' + GOLD + '"/><circle r="6" fill="none" stroke="' + GOLD_DEEP + '" stroke-width="1"/><rect x="-2.4" y="-2.4" width="4.8" height="4.8" fill="#1B0F11"/>'),
        svg('-10 -10 20 20', '<g fill="#F2A3AC">' + [0, 72, 144, 216, 288].map((a) => '<circle cx="0" cy="-4.6" r="4.4" transform="rotate(' + a + ')"/>').join('') + '</g><circle r="1.8" fill="' + GOLD + '"/>'),
        svg('-10 -10 20 20', '<path d="' + sparklePath(8) + '" fill="' + GOLD + '"/>'),
      ]
    case 'halloween':
      return [
        svg('-30 -14 60 26', bat('#F28A3A')),
        svg('-10 -10 20 20', '<circle r="3.2" fill="#FFB14A"/>'),
        svg('-10 -10 20 20', '<path d="' + sparklePath(7) + '" fill="#F5A263"/>'),
      ]
    case 'midautumn':
      return [
        svg('-10 -10 20 20', '<g fill="#F2B544"><circle cx="3.2" cy="1.2" r="2.9"/><circle cx="-1.2" cy="3.2" r="2.9"/><circle cx="-3.2" cy="-1.2" r="2.9"/><circle cx="1.2" cy="-3.2" r="2.9"/></g><circle r="1.6" fill="#C9801C"/>'),
        svg('-10 -10 20 20', '<path d="' + sparklePath(7) + '" fill="#F4E3B0"/>'),
        svg('-10 -10 20 20', star5(0, 0, 7, '#F4E3B0')),
      ]
    case 'newyear':
      return [
        svg('-10 -10 20 20', '<rect x="-3" y="-5" width="6" height="10" rx="1" fill="#A99BFF"/>'),
        svg('-10 -10 20 20', '<rect x="-3" y="-5" width="6" height="10" rx="1" fill="#F1D08A"/>'),
        svg('-10 -10 20 20', '<path d="' + sparklePath(8) + '" fill="#E6E8EE"/>'),
      ]
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 定价卡（PRO 实色紫面）的装饰 / decorations for the solid-violet PRO card
// ════════════════════════════════════════════════════════════════════════════
// 只动卡片的轮廓（上沿、右上角），价格、权益列表、按钮都不碰。
// Only the card's silhouette changes (top edge, top-right corner); price,
// feature list and button are untouched.

export function cardTopper(key: FestivalKey): Piece[] {
  const p = pre()
  switch (key) {
    case 'christmas':
      return buttonTopper('christmas')
    case 'spring':
      return [
        { cls: 'fd-card-fu', html: svg('-26 -26 52 84', fuTassel()) },
      ]
    case 'halloween':
      return [
        {
          cls: 'fd-card-bat',
          html: svg('-34 -16 68 44', '<line x1="0" y1="-16" x2="0" y2="-4" stroke="#8A8494" stroke-width=".8"/><g transform="rotate(180)"><g class="fd-float">' + bat('#1C1724', 0.2) + '</g></g>'),
        },
        { cls: 'fd-pumpkin', html: svg('0 0 22 22', tinyPumpkin()) },
      ]
    case 'midautumn':
      return [
        { cls: 'fd-ears', html: buttonTopper('midautumn')[0].html },
        { cls: 'fd-card-moon', html: svg('0 0 40 40', moon(p, 20, 20, 16)) },
      ]
    case 'newyear':
      return [
        {
          cls: 'fd-card-sparks',
          html: svg('0 0 70 50', sparkles([[52, 14, 9, '#F1D08A'], [30, 6, 5, '#FFFFFF'], [64, 36, 5, '#E6E8EE'], [14, 18, 3.4, '#F1D08A']])),
        },
      ]
  }
}
