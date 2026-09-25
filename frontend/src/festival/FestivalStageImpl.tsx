// 落地页节日布景 / landing festival set dressing
//
// 重的实现：页面用的是轻壳 FestivalStage.tsx，节日窗口内才动态加载这里。
// Heavy implementation: pages use the light shell FestivalStage.tsx, which
// loads this module only inside a festival window.
//
// 首屏的主角是那台 3D 手机，布景只做配角：月亮从手机背后升起、灯笼从导航下沿垂下、
// 南瓜蹲在手机脚边、雪落满首屏、烟花在手机两侧炸开。收尾 CTA 区另有一套。
// The hero belongs to the 3D phone and the set only supports it: the moon rises
// behind the phone, lanterns hang from under the nav, pumpkins sit at its feet,
// snow falls, fireworks burst either side of it. The closing section has its own set.
//
// 定位（见 layout.ts）：每件布景都相对**量出来的**锚点计算——手机屏幕的真实矩形、
// 文案块、导航下沿、收尾区的标题与按钮——而不是视口百分比，所以任何窗口尺寸下都
// 对得准。每件有几个备选位置，碰到文字或按钮就换下一个，都不行就不显示。落在地面
// 上的东西（南瓜、玉兔、月饼、松树）不参与指针视差，永远踩在手机的脚下。
// Placement (see layout.ts): every piece is computed from measured anchors —
// the phone screen's real rectangle, the copy block, the nav's bottom edge, the
// closing section's headline and button — never from viewport percentages, so
// it registers at every window size. Each piece has fallback positions; if one
// touches text or a control the next is tried, and if none fit it is not shown.
// Grounded things (pumpkins, the rabbit, the mooncake, pines) take no pointer
// parallax and always stand on the phone's baseline.
//
// 三种运动各司其职：GSAP 负责入场编排；一个 rAF 负责视差、灯笼单摆、跟随手机、
// 云的漂移与烛光闪烁（都用多频正弦叠加，不是机械的来回）；canvas 负责粒子。
// Three kinds of motion: GSAP for entrances; one rAF for parallax, lantern
// pendulums, following the phone, cloud drift and candle flicker (layered
// sines, never a mechanical back-and-forth); a canvas for particles.
import { useEffect, useMemo, useRef, useState } from 'react'
import { FESTIVAL_DEMO, useFestivalOptional } from './FestivalProvider'
import type { FestivalKey } from './calendar'
import { piece } from './art'
import { loadGsap } from './motion'
import { ParticleField, particleProfile, type Effect } from './particles'
import {
  bottom,
  centered,
  clamp,
  collectInfo,
  cx,
  cy,
  groundAt,
  hitsAny,
  inflate,
  intersects,
  relBox,
  right,
  topLeft,
  union,
  type Box,
} from './layout'
import SvgArt from './SvgArt'
import './festival.css'

export type Variant = 'hero' | 'finale'

interface Anchors {
  W: number
  H: number
  mobile: boolean
  nav: number // 导航（含问候条）下沿 / bottom of the nav (ribbon included)
  // 灯笼绳的挂点：问候条底下那条金线；没有问候条就是屏幕顶。导航行本身是透明的，
  // 绳子停在导航下沿会像悬在半空。
  // Where lantern strings are tied: the gold rule under the ribbon, or the
  // screen top without one. The nav row itself is transparent, so a string
  // stopping at its bottom edge would hang from thin air.
  hang: number
  phone: Box | null // 手机（含边框）/ the phone, bezel included
  copy: Box | null // 首屏文案块，或收尾区的标题+副标题 / hero copy, or the finale headline+subtitle
  cta: Box | null // 收尾区按钮+说明 / the finale button + note
  caption: Box | null // 手机下方的示例声明 / sample-data caption under the phone
}

type Placed = Record<string, Box>
type Placer = (a: Anchors, placed: Placed) => Box | null

interface PieceDef {
  id: string
  html: string
  place: Placer[] // 备选位置，按顺序尝试 / candidate positions, tried in order
  depth?: number // 指针视差（px）；地面上的东西为 0 / pointer parallax; 0 for grounded things
  kind?: 'lantern'
  soft?: boolean
  keep?: boolean // 叙事后几幕里仍保留（淡化）/ stays, dimmed, through later story scenes
  flip?: boolean
  follow?: boolean // 跟着手机走 / follows the phone as it moves
  drift?: [number, number] // 漂移幅度 x/y（px）/ drift amplitude
  hit?: [number, number, number, number] // 碰撞框内缩（上右下左，比例）/ collision box insets (t r b l, fractions)
  free?: boolean // 不做碰撞检查（星星这类细小背景）/ skip collision (tiny background like stars)
  // 按量出来的挂点现画（灯串）：自己负责避让，返回图层框和画好的 SVG。
  // Drawn from measured tie points (light strings): does its own avoidance and
  // returns the layer box plus the finished SVG.
  draw?: (a: Anchors, info: Box[], placed: Placed) => { box: Box; html: string } | null
}

interface Scene {
  pieces: PieceDef[]
  effects: Effect[]
  region?: (a: Anchors) => { x0: number; x1: number }
  ranges?: (a: Anchors) => [number, number][]
  burstY?: (a: Anchors) => [number, number]
  bats?: (a: Anchors) => { x: number; y: number }[][]
}

// 图片宽高比与「地面线」位置（0–1）。/ art aspect ratios and ground-line positions
const AR = {
  moon: 1,
  cloud: 146 / 50,
  wisp: 5,
  branch: 300 / 170,
  mooncake: 180 / 80,
  rabbit: 84 / 96,
  pumpkin: 260 / 124,
  bat: 68 / 28,
  plum: 320 / 260,
  lights: 1000 / 170,
  lightsWide: 2600 / 170,
  pines: 400 / 160,
  yearS: 400 / 480,
  yearW: 900 / 240,
}
const G = { pumpkin: 0.806, rabbit: 0.94, mooncake: 0.925, pines: 0.99 }
const lanternAR = (len: number) => 140 / (len + 176)
const LEN = { a: 70, b: 36, c: 220 }

// 南瓜图里瓜身只占宽度的 46%（其余是地上的烛光），按瓜身宽度反推整张图的宽度。
// The pumpkin body is 46% of its art's width (the rest is candlelight on the
// ground), so sizes are given as body widths and converted.
const pumpkinW = (bodyW: number) => bodyW / 0.46

// ════════════════════════════════════════════════════════════════════════════
// 首屏布景 / hero sets
// ════════════════════════════════════════════════════════════════════════════

function heroScene(key: FestivalKey, year: number): Scene {
  // 手机右侧、文案与手机之间两块空地。/ the free zones: right of the phone, and between copy and phone
  const gap = (a: Anchors) => (a.copy && a.phone ? { x0: right(a.copy), x1: a.phone.x } : null)
  const rightZone = (a: Anchors) => (a.phone ? { x0: right(a.phone), x1: a.W } : null)
  // 手机版：文案以下到屏幕底的一条空带。/ phones: the free band below the copy
  const band = (a: Anchors) => {
    const top = a.copy ? bottom(a.copy) + 14 : a.H * 0.8
    return { y0: top, y1: a.H, h: a.H - top }
  }
  const stars = (seed: number, color: string): PieceDef => ({
    id: 'stars',
    html: piece.stars(44, seed, color),
    place: [(a) => (a.mobile ? null : { x: 0, y: 0, w: a.W, h: a.H * 0.62 })],
    depth: 2,
    keep: true,
    free: true,
  })

  switch (key) {
    case 'midautumn':
      return {
        effects: ['petals'],
        region: (a) => (a.phone && !a.mobile ? { x0: right(a.phone) / a.W - 0.05, x1: 1 } : { x0: 0.55, x1: 1 }),
        pieces: [
          stars(52, '#E8E0C6'),
          {
            id: 'moon',
            html: piece.moon('warm'),
            follow: true,
            depth: 3,
            hit: [0.12, 0.12, 0.12, 0.12],
            place: [
              // 月亮的圆心压在手机右上角外侧：一部分被机身挡住，像从手机背后升起。
              // Centre just outside the phone's upper-right corner: partly hidden by
              // the body, as if rising from behind it.
              (a) => {
                if (a.mobile || !a.phone) return null
                const m = clamp(a.phone.h * 0.6, 200, 520)
                const c = centered(right(a.phone) - a.phone.w * 0.02, a.phone.y + a.phone.h * 0.3, m, AR.moon)
                return c.y < a.nav + 10 ? { ...c, y: a.nav + 10 } : c
              },
              (a) => {
                if (a.mobile || !a.phone) return null
                const m = clamp(a.phone.h * 0.44, 170, 380)
                return centered(right(a.phone) + m * 0.32, a.phone.y + a.phone.h * 0.26 + 20, m, AR.moon)
              },
              (a) => {
                if (!a.mobile) return null
                const b = band(a)
                const m = Math.min(a.W * 0.48, b.h * 1.9)
                if (m < 90) return null
                return { x: a.W * 0.82 - m / 2, y: b.y0 + 6, w: m, h: m }
              },
            ],
          },
          {
            id: 'cloudA',
            html: piece.cloud('#17171E', '#E3D2A2'),
            follow: true,
            depth: 5,
            drift: [16, 3],
            hit: [0.25, 0.04, 0.1, 0.04],
            place: [
              (_a, p) => {
                const m = p.moon
                if (!m) return null
                const w = m.w * 0.58
                return topLeft(m.x + m.w * 0.42, m.y + m.h * 0.66, w, AR.cloud)
              },
            ],
          },
          {
            id: 'cloudB',
            html: piece.cloud('#15151C', '#B8A983'),
            depth: 4,
            drift: [12, 2],
            hit: [0.25, 0.04, 0.1, 0.04],
            place: [
              (a) => {
                const z = rightZone(a)
                if (a.mobile || !z || !a.phone || z.x1 - z.x0 < 120) return null
                const w = clamp((z.x1 - z.x0) * 0.5, 110, 190)
                return topLeft(z.x0 + (z.x1 - z.x0 - w) * 0.55, bottom(a.phone) - a.phone.h * 0.3, w, AR.cloud)
              },
            ],
          },
          {
            id: 'cloudFar',
            html: piece.cloud('#131319', '#6F6A5C'),
            depth: 3,
            keep: true,
            drift: [10, 2],
            hit: [0.25, 0.04, 0.1, 0.04],
            place: [
              (a) => {
                const g = gap(a)
                if (a.mobile || !g || g.x1 - g.x0 < 130) return null
                const w = clamp((g.x1 - g.x0) * 0.55, 100, 170)
                return topLeft(g.x0 + (g.x1 - g.x0 - w) / 2, a.nav + 26, w, AR.cloud)
              },
            ],
          },
          {
            id: 'branch',
            html: piece.osmanthusBranch(),
            keep: true,
            hit: [0.05, 0, 0.2, 0.2],
            place: [
              // 桂花枝从导航下沿的右端垂下来。/ the sprig hangs from the right end of the nav's bottom edge
              (a) => {
                if (a.mobile || !a.phone) return null
                const w = clamp(a.W - right(a.phone) + a.phone.w * 0.3, 260, 440)
                return topLeft(a.W - w, a.nav + 2, w, AR.branch)
              },
            ],
          },
          {
            id: 'mooncake',
            html: piece.mooncake(),
            follow: true,
            hit: [0.2, 0.05, 0, 0.05],
            place: [
              (a) => {
                if (a.mobile || !a.phone) return null
                const w = clamp(a.phone.w * 0.46, 110, 170)
                return groundAt(a.phone.x - w * 0.52, bottom(a.phone) + 4, w, AR.mooncake, G.mooncake)
              },
            ],
          },
          {
            id: 'rabbit',
            html: piece.rabbit(),
            follow: true,
            place: [
              (a) => {
                if (a.mobile || !a.phone) return null
                const h = clamp(a.phone.h * 0.14, 70, 110)
                const w = h * AR.rabbit
                return groundAt(right(a.phone) + w * 0.8, bottom(a.phone) + 4, w, AR.rabbit, G.rabbit)
              },
              (a, p) => {
                if (!a.mobile || !p.moon) return null
                const w = clamp(p.moon.w * 0.28, 38, 60)
                return groundAt(p.moon.x - w * 0.4, a.H - 6, w, AR.rabbit, G.rabbit)
              },
            ],
          },
        ],
      }

    case 'halloween':
      return {
        effects: ['fog'],
        region: () => ({ x0: 0, x1: 1 }),
        bats: (a) => {
          // 蝙蝠只在文案列右侧那块天空里飞：从右往左掠过手机上方，再绕回去。
          // Bats only fly in the sky right of the copy column: across above the
          // phone right-to-left, and back.
          if (a.mobile) {
            const b = band(a)
            const y = (f: number) => b.y0 + b.h * f
            return [
              [{ x: a.W + 30, y: y(0.3) }, { x: a.W * 0.6, y: y(0.15) }, { x: a.W * 0.2, y: y(0.35) }, { x: -40, y: y(0.2) }],
              [{ x: -40, y: y(0.55) }, { x: a.W * 0.4, y: y(0.42) }, { x: a.W * 0.8, y: y(0.58) }, { x: a.W + 40, y: y(0.45) }],
            ]
          }
          const x0 = a.copy ? right(a.copy) + 24 : a.W * 0.45
          const top = a.nav + 16
          const low = a.phone ? a.phone.y + a.phone.h * 0.5 : a.H * 0.5
          const X = (f: number) => x0 + (a.W - x0) * f
          const Y = (f: number) => top + (low - top) * f
          return [
            [{ x: a.W + 40, y: Y(0.5) }, { x: X(0.75), y: Y(0.2) }, { x: X(0.5), y: Y(0.4) }, { x: X(0.2), y: Y(0.1) }, { x: x0 - 30, y: Y(0.25) }],
            [{ x: a.W + 40, y: Y(0.1) }, { x: X(0.8), y: Y(0.45) }, { x: X(0.55), y: Y(0.3) }, { x: X(0.3), y: Y(0.62) }, { x: x0 - 30, y: Y(0.45) }],
            [{ x: x0 - 30, y: Y(0.35) }, { x: X(0.3), y: Y(0.12) }, { x: X(0.62), y: Y(0.3) }, { x: X(0.85), y: Y(0.15) }, { x: a.W + 40, y: Y(0.4) }],
            [{ x: a.W + 40, y: Y(0.8) }, { x: X(0.78), y: Y(0.62) }, { x: X(0.6), y: Y(0.88) }, { x: X(0.35), y: Y(0.7) }, { x: x0 - 30, y: Y(0.9) }],
          ]
        },
        pieces: [
          stars(31, '#E9DFC4'),
          {
            id: 'moon',
            html: piece.moon('pale'),
            follow: true,
            depth: 3,
            hit: [0.12, 0.12, 0.12, 0.12],
            place: [
              (a) => {
                if (a.mobile || !a.phone) return null
                const m = clamp(a.phone.h * 0.4, 160, 340)
                let c = centered(right(a.phone) + m * 0.26, a.phone.y + a.phone.h * 0.24, m, AR.moon)
                if (right(c) > a.W - 8) c = { ...c, x: a.W - 8 - m }
                return c.y < a.nav + 10 ? { ...c, y: a.nav + 10 } : c
              },
              (a) => {
                if (!a.mobile) return null
                const b = band(a)
                const m = Math.min(a.W * 0.38, b.h * 1.6)
                if (m < 80) return null
                return { x: a.W * 0.86 - m / 2, y: b.y0 + 6, w: m, h: m }
              },
            ],
          },
          {
            id: 'wispA',
            html: piece.wisp(),
            soft: true,
            follow: true,
            depth: 4,
            drift: [22, 2],
            free: true,
            place: [(a, p) => (p.moon && !a.mobile ? topLeft(p.moon.x - p.moon.w * 0.3, p.moon.y + p.moon.h * 0.52, p.moon.w * 1.4, AR.wisp) : null)],
          },
          {
            id: 'wispB',
            html: piece.wisp(),
            soft: true,
            follow: true,
            depth: 3,
            drift: [18, 2],
            free: true,
            place: [(a, p) => (p.moon && !a.mobile ? topLeft(p.moon.x + p.moon.w * 0.12, p.moon.y + p.moon.h * 0.18, p.moon.w, AR.wisp) : null)],
          },
          {
            id: 'spider',
            html: piece.spider(600),
            hit: [0.93, 0, 0, 0],
            place: [
              // 蜘蛛挂在文案与手机之间的空隙中线上，丝从导航下沿垂下。
              // The spider hangs on the midline of the gap between copy and
              // phone, its thread dropping from under the nav.
              (a) => {
                const g = gap(a)
                if (a.mobile || !g || !a.phone || g.x1 - g.x0 < 70) return null
                const w = 34
                const h = w * (640 / 60)
                const bodyY = a.phone.y + a.phone.h * 0.3
                return { x: (g.x0 + g.x1) / 2 - w / 2, y: bodyY - h * (608 / 640), w, h }
              },
            ],
          },
          ...['bat1', 'bat2', 'bat3', 'bat4'].map(
            (id, i): PieceDef => ({
              id,
              html: piece.bat(i % 2 ? '#241E2C' : '#0E0C12', i * 0.12),
              free: true,
              place: [(a) => ({ x: 0, y: 0, w: (a.mobile ? 30 : 40) * [1, 0.72, 0.86, 0.6][i], h: ((a.mobile ? 30 : 40) * [1, 0.72, 0.86, 0.6][i]) / AR.bat })],
            })
          ),
          {
            id: 'pumpkinL',
            html: piece.pumpkin(true, 0),
            follow: true,
            hit: [0.35, 0.3, 0.1, 0.3],
            place: [
              (a) => {
                if (a.mobile || !a.phone) return null
                const body = clamp(a.phone.w * 0.42, 90, 150)
                return groundAt(right(a.phone) + body * 0.62, bottom(a.phone) + 6, pumpkinW(body), AR.pumpkin, G.pumpkin)
              },
              (a) => {
                if (!a.mobile) return null
                const b = band(a)
                const body = Math.min(a.W * 0.2, b.h * 0.8)
                if (body < 40) return null
                return groundAt(a.W * 0.58, a.H - 6, pumpkinW(body), AR.pumpkin, G.pumpkin)
              },
            ],
          },
          {
            id: 'pumpkinS',
            html: piece.pumpkin(false),
            follow: true,
            hit: [0.35, 0.3, 0.1, 0.3],
            place: [
              (a) => {
                if (a.mobile || !a.phone) return null
                const body = clamp(a.phone.w * 0.26, 60, 96)
                return groundAt(a.phone.x - body * 0.7, bottom(a.phone) + 6, pumpkinW(body), AR.pumpkin, G.pumpkin)
              },
              (a) => {
                if (!a.mobile) return null
                const b = band(a)
                const body = Math.min(a.W * 0.13, b.h * 0.55)
                if (body < 30) return null
                return groundAt(a.W * 0.36, a.H - 6, pumpkinW(body), AR.pumpkin, G.pumpkin)
              },
            ],
          },
          {
            id: 'pumpkinT',
            html: piece.pumpkin(true, 0.7),
            follow: true,
            hit: [0.35, 0.3, 0.1, 0.3],
            place: [
              (a, p) => {
                if (a.mobile || !a.phone || !p.pumpkinS) return null
                const body = clamp(a.phone.w * 0.17, 40, 66)
                return groundAt(p.pumpkinS.x + p.pumpkinS.w * 0.5 + body * 1.35, bottom(a.phone) + 10, pumpkinW(body), AR.pumpkin, G.pumpkin)
              },
            ],
          },
        ],
      }

    case 'spring': {
      const lantern = (id: string, len: number, glyph: string | null, place: Placer[]): PieceDef => ({
        id,
        kind: 'lantern',
        html: piece.lantern(len, glyph),
        keep: true,
        hit: [len / (len + 176), 0.08, 0, 0.08],
        place,
      })
      return {
        effects: ['golddust', 'plumPetals'],
        region: (a) => (a.phone && !a.mobile ? { x0: right(a.phone) / a.W - 0.05, x1: 1 } : { x0: 0.4, x1: 1 }),
        pieces: [
          {
            id: 'cloudA',
            html: piece.cloudOutline('#C9962F'),
            depth: 3,
            drift: [12, 2],
            hit: [0.25, 0.04, 0.1, 0.04],
            place: [
              // 放在大标题上方的空白里，不和文案与手机之间那盏灯笼挤在一起。
              // In the empty space above the headline, clear of the lantern in the gap.
              (a) => {
                if (a.mobile || !a.copy) return null
                const room = a.copy.y - a.nav
                if (room < 90) return null
                const w = clamp(room * 0.8, 100, 150)
                return topLeft(a.copy.x + a.copy.w * 0.42, a.nav + (room - w / AR.cloud) * 0.42, w, AR.cloud)
              },
            ],
          },
          {
            id: 'cloudB',
            html: piece.cloudOutline('#C9962F'),
            depth: 3,
            drift: [12, 2],
            hit: [0.25, 0.04, 0.1, 0.04],
            place: [
              (a) => {
                const z = rightZone(a)
                if (a.mobile || !z || !a.phone || z.x1 - z.x0 < 130) return null
                const w = clamp((z.x1 - z.x0) * 0.46, 100, 150)
                return topLeft(z.x0 + 18, a.phone.y + a.phone.h * 0.46, w, AR.cloud)
              },
            ],
          },
          {
            id: 'plum',
            html: piece.plumBranch(),
            hit: [0.3, 0, 0, 0.3],
            place: [
              (a) => {
                const z = rightZone(a)
                if (a.mobile || !z) return null
                const w = clamp((z.x1 - z.x0) * 1.05, 190, 330)
                return topLeft(a.W - w, a.H - w / AR.plum, w, AR.plum)
              },
              (a) => {
                if (!a.mobile) return null
                const b = band(a)
                const w = Math.min(a.W * 0.46, b.h * AR.plum * 1.05)
                if (w < 90) return null
                return topLeft(a.W - w, a.H - w / AR.plum, w, AR.plum)
              },
            ],
          },
          // 灯笼都从导航下沿垂下来（绳子的上端正好藏在导航下面）。
          // Lanterns all hang from the nav's bottom edge, strings tucked under it.
          lantern('lanternA', LEN.a, '福', [
            (a) => {
              const g = gap(a)
              if (a.mobile || !g || g.x1 - g.x0 < 90) return null
              const w = clamp((g.x1 - g.x0) * 0.45, 70, 110)
              return topLeft((g.x0 + g.x1) / 2 - w / 2, a.nav - 4, w, lanternAR(LEN.a))
            },
            // 文案面板比文字宽、算不出空地时（1024 左右），先贴着手机左侧放，再由避让左右找空位。
            // When the copy panel is wider than its text and no gap shows (around
            // 1024), start beside the phone's left edge and let avoidance slide it.
            (a) => (a.mobile || !a.phone ? null : topLeft(a.phone.x - 10 - 52, a.nav - 4, 52, lanternAR(LEN.a))),
            (a) => (a.mobile ? topLeft(a.W - 44, a.nav - 4, 38, lanternAR(LEN.a)) : null),
          ]),
          lantern('lanternB', LEN.b, '福', [
            (a) => {
              const z = rightZone(a)
              if (a.mobile || !z || z.x1 - z.x0 < 120) return null
              const w = clamp((z.x1 - z.x0) * 0.38, 90, 140)
              return topLeft(z.x0 + (z.x1 - z.x0) * 0.42 - w / 2, a.nav - 4, w, lanternAR(LEN.b))
            },
          ]),
          lantern('lanternC', LEN.c, null, [
            (a) => {
              const z = rightZone(a)
              if (a.mobile || !z || z.x1 - z.x0 < 200) return null
              const w = 50
              return topLeft(a.W - w - 16, a.nav - 4, w, lanternAR(LEN.c))
            },
            (a) => (a.mobile ? topLeft(6, a.nav - 4, 26, lanternAR(LEN.c)) : null),
          ]),
        ],
      }
    }

    case 'christmas':
      return {
        effects: ['snow'],
        region: () => ({ x0: 0, x1: 1 }),
        pieces: [
          {
            // 灯串两段：左段系在问候条底下的金线上，垂下来接到手机左侧（接头藏在手机
            // 背后）；右段从手机右侧背后出来，一直拉出屏幕右缘。两端都有着落，没有
            // 停在半空的线头。视差为 0，系绳的点不会沿着金线滑动。
            // Two drapes: the left is tied to the gold rule under the ribbon and
            // runs to the phone's left side (its end hidden behind the phone); the
            // right comes out from behind the phone's right side and runs off the
            // screen's right edge. Both ends land somewhere; no wire stops in mid-air.
            // No parallax, so the tie point never slides along the rule.
            // 不跟到后面几幕：手机一挪开，藏在它背后的线头就会露在半空。
            // Not kept into later scenes: once the phone moves away, the wire ends
            // it was hiding would show in mid-air.
            id: 'lights',
            html: '',
            place: [],
            draw: (a, info) => {
              if (a.mobile || !a.phone || !a.copy) return null
              const ph = a.phone
              const yP = ph.y + ph.h * 0.1
              const drapes: number[][] = []
              // 左段系绳点：导航链接右边再让 40px，且不早于文案右缘。
              // Left tie point: 40px past the nav links, and not before the copy's right edge.
              const navRight = info.filter((b) => b.y > a.hang && b.y < a.nav && b.x < ph.x).reduce((m, b) => Math.max(m, right(b)), 0)
              const tx = Math.max(navRight + 40, right(a.copy) - 10)
              if (ph.x + 36 - tx > 110) drapes.push([tx, a.hang, ph.x + 36, yP, 60, 1])
              if (a.W - right(ph) > 90) drapes.push([right(ph) - 36, yP, a.W + 40, a.hang + 64, 70, 0])
              // 藏在手机背后的部分不画也不测。/ the part behind the phone is neither drawn nor tested
              const behind = (x: number, y: number) => x > ph.x + 6 && x < right(ph) - 6 && y > ph.y && y < bottom(ph)
              // 沿每段取样：线上每 16px 一个点，外加灯泡垂下去的范围；碰到字就整段不要。
              // Sample each drape every 16px plus the bulbs' drop; a drape that touches text is dropped whole.
              const ok = drapes.filter(([x0, y0, x1, y1, sag]) => {
                const qx = (x0 + x1) / 2
                const qy = Math.max(y0, y1) + sag
                for (let i = 1; i < 80; i++) {
                  const s = i / 80
                  const x = (1 - s) * (1 - s) * x0 + 2 * (1 - s) * s * qx + s * s * x1
                  const y = (1 - s) * (1 - s) * y0 + 2 * (1 - s) * s * qy + s * s * y1
                  if (y < a.hang + 4 || x > a.W || behind(x, y)) continue
                  if (hitsAny({ x: x - 8, y: y - 2, w: 16, h: 24 }, info, 10)) return false
                }
                return true
              })
              if (!ok.length) return null
              const x0 = Math.min(...ok.map((d) => d[0])) - 24
              const lowest = Math.max(...ok.map((d) => Math.max(d[1], d[3]) + d[4]))
              const box = { x: x0, y: 0, w: a.W - x0, h: lowest + 30 }
              const local = ok.map((d) => [d[0] - x0, d[1], d[2] - x0, d[3], d[4], d[5]])
              // 导航那一行只让光秃秃的电线穿过，灯泡从导航下面开始挂。
              // Only bare wire passes through the nav row; bulbs start below it.
              return { box, html: piece.lightsBetween(box.w, box.h, local, (x, y) => y < a.nav || behind(x + x0, y)) }
            },
          },
          {
            id: 'bank',
            html: piece.snowbank(),
            hit: [0.4, 0, 0, 0],
            place: [
              // 雪坡从示例声明右侧开始，铺到屏幕右缘。/ the snowbank starts right of the caption
              (a) => {
                if (a.mobile) {
                  const b = band(a)
                  return b.h > 40 ? { x: 0, y: a.H - 34, w: a.W, h: 34 } : null
                }
                const x = a.caption ? right(a.caption) + 18 : a.phone ? a.phone.x : a.W * 0.5
                const h = clamp(a.H * 0.08, 48, 84)
                return { x, y: a.H - h, w: a.W - x, h }
              },
            ],
          },
          {
            id: 'pines',
            html: piece.pines(),
            hit: [0.1, 0.05, 0, 0.05],
            place: [
              (a, p) => {
                const z = rightZone(a)
                if (a.mobile || !z || !p.bank) return null
                const w = clamp((z.x1 - z.x0) * 1.15, 200, 400)
                return groundAt(a.W - w / 2 - 12, a.H - p.bank.h * 0.42, w, AR.pines, G.pines)
              },
              (a, p) => {
                if (!a.mobile || !p.bank) return null
                const b = band(a)
                const w = Math.min(a.W * 0.5, b.h * AR.pines * 0.9)
                if (w < 90) return null
                return groundAt(a.W - w / 2 - 8, a.H - 16, w, AR.pines, G.pines)
              },
            ],
          },
        ],
      }

    case 'newyear':
      return {
        effects: ['fireworks', 'confetti'],
        region: (a) => (a.phone && !a.mobile ? { x0: right(a.phone) / a.W, x1: 1 } : { x0: 0.1, x1: 0.9 }),
        // 烟花只从手机两侧的空当升起，炸在文案列以外。/ launched through the gaps beside the phone
        ranges: (a) => {
          if (a.mobile || !a.phone || !a.copy) return [[0.1, 0.9]]
          const out: [number, number][] = []
          const g0 = (right(a.copy) + 30) / a.W
          const g1 = (a.phone.x - 20) / a.W
          if (g1 - g0 > 0.04) out.push([g0, g1])
          out.push([(right(a.phone) + 30) / a.W, 0.97])
          return out
        },
        burstY: (a) => (a.mobile ? [band(a).y0 / a.H + 0.06, 0.9] : [(a.nav + 70) / a.H, a.phone ? (a.phone.y + a.phone.h * 0.45) / a.H : 0.4]),
        pieces: [
          stars(21, '#D8D2F0'),
          {
            id: 'year',
            html: piece.yearStacked(year),
            follow: true,
            depth: 3,
            place: [
              // 竖排年份放进手机右侧那一栏正中。/ the stacked year centred in the column right of the phone
              (a) => {
                const z = rightZone(a)
                if (a.mobile || !z || !a.phone) return null
                const w = clamp(z.x1 - z.x0 - 48, 0, 260)
                if (w < 120) return null
                return centered((z.x0 + z.x1) / 2, cy(a.phone), w, AR.yearS)
              },
              (a) => {
                if (!a.mobile) return null
                const b = band(a)
                const w = Math.min(a.W * 0.86, b.h * AR.yearW * 0.8)
                if (w < 160) return null
                return centered(a.W / 2, b.y0 + b.h / 2, w, AR.yearW)
              },
            ],
          },
        ],
      }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 收尾区布景 / finale sets
// ════════════════════════════════════════════════════════════════════════════
// 收尾区左边是大标题、右边是注册按钮。布景只占：标题之上的顶带、内容之下的底带、
// 按钮右侧与标题左侧的窄边。
// The closing section has its headline left and the button right. The set only
// uses the band above the headline, the band below the content, and the narrow
// margins beside them.

function finaleScene(key: FestivalKey): Scene {
  const topBand = (a: Anchors) => {
    const y1 = Math.min(a.copy ? a.copy.y : a.H * 0.4, a.cta ? a.cta.y : a.H * 0.4) - 18
    return { y0: 0, y1, h: y1 }
  }
  const lowBand = (a: Anchors) => {
    const y0 = Math.max(a.copy ? bottom(a.copy) : a.H * 0.7, a.cta ? bottom(a.cta) : a.H * 0.7) + 14
    return { y0, y1: a.H, h: a.H - y0 }
  }
  // 横贯整个分区的一根绳：两端都伸出屏幕左右缘，中间微微下垂。灯笼挂在它上面，
  // 灯串就是它本身——每一样挂着的东西都有着落。
  // One cord across the whole section: both ends run off the screen's left and
  // right edges, sagging gently between. Lanterns hang from it and the light
  // string is the cord itself, so everything that hangs is tied to something.
  const CORD_Y = 14
  const cordSag = (a: Anchors) => clamp(a.W * 0.022, 10, 30)
  // 曲线从 x=-20 到 W+20、控制点在正中，所以 x 与参数 u 是线性关系：u = (x+20)/(W+40)。
  // The curve runs from x=-20 to W+20 with its control point centred, so x maps
  // linearly to the parameter: u = (x+20)/(W+40).
  const cordY = (a: Anchors, x: number) => {
    const u = clamp((x + 20) / (a.W + 40), 0, 1)
    return CORD_Y + cordSag(a) * 4 * u * (1 - u)
  }

  switch (key) {
    case 'midautumn':
      return {
        effects: ['petals'],
        region: (a) => ({ x0: a.cta ? right(a.cta) / a.W - 0.1 : 0.6, x1: 1 }),
        pieces: [
          {
            id: 'moon',
            html: piece.moon('warm'),
            depth: 3,
            hit: [0.12, 0.12, 0.12, 0.12],
            place: [
              // 月亮贴右缘、在按钮上方，半个藏在屏幕外。/ against the right edge above the button, half off-screen
              (a) => {
                const t = topBand(a)
                const m = clamp(Math.max(t.h * 1.25, 150), 150, 300)
                return centered(a.W - m * 0.12, Math.max(m * 0.42, t.y1 - m * 0.46), m, AR.moon)
              },
              (a) => {
                const t = topBand(a)
                const m = clamp(t.h * 0.95, 110, 200)
                return centered(a.W - m * 0.2, t.y1 - m * 0.55, m, AR.moon)
              },
            ],
          },
          {
            id: 'cloudA',
            html: piece.cloud('#17171E', '#E3D2A2'),
            depth: 5,
            drift: [14, 2],
            hit: [0.25, 0.04, 0.1, 0.04],
            place: [(_a, p) => (p.moon ? topLeft(p.moon.x - p.moon.w * 0.28, p.moon.y + p.moon.h * 0.55, p.moon.w * 0.62, AR.cloud) : null)],
          },
          {
            id: 'cloudFar',
            html: piece.cloud('#131319', '#6F6A5C'),
            depth: 3,
            drift: [10, 2],
            hit: [0.25, 0.04, 0.1, 0.04],
            place: [(a) => (a.copy && topBand(a).h > 70 ? topLeft(a.copy.x, 18, clamp(topBand(a).h * 1.2, 90, 140), AR.cloud) : null)],
          },
          {
            id: 'rabbit',
            html: piece.rabbit(),
            place: [
              (a) => {
                const l = lowBand(a)
                const h = clamp(l.h * 0.72, 44, 84)
                if (l.h < 50 || !a.copy) return null
                return groundAt(a.copy.x + h * 0.5, a.H - 8, h * AR.rabbit, AR.rabbit, G.rabbit)
              },
            ],
          },
          {
            id: 'mooncake',
            html: piece.mooncake(),
            place: [
              (a, p) => {
                const l = lowBand(a)
                if (!p.rabbit || l.h < 50) return null
                const w = clamp(l.h * 1.3, 80, 130)
                return groundAt(right(p.rabbit) + w * 0.62, a.H - 8, w, AR.mooncake, G.mooncake)
              },
            ],
          },
        ],
      }
    case 'halloween':
      return {
        effects: ['fog'],
        region: () => ({ x0: 0, x1: 1 }),
        bats: (a) => {
          const t = topBand(a)
          const Y = (f: number) => 10 + (t.y1 - 20) * f
          return [
            [{ x: a.W + 40, y: Y(0.6) }, { x: a.W * 0.7, y: Y(0.25) }, { x: a.W * 0.4, y: Y(0.55) }, { x: -40, y: Y(0.3) }],
            [{ x: -40, y: Y(0.4) }, { x: a.W * 0.35, y: Y(0.7) }, { x: a.W * 0.65, y: Y(0.35) }, { x: a.W + 40, y: Y(0.6) }],
          ]
        },
        pieces: [
          {
            id: 'moon',
            html: piece.moon('pale'),
            depth: 3,
            hit: [0.12, 0.12, 0.12, 0.12],
            place: [
              (a) => {
                const t = topBand(a)
                const m = clamp(t.h * 1.1, 120, 240)
                return centered(a.W - m * 0.3, Math.max(m * 0.45, t.y1 - m * 0.5), m, AR.moon)
              },
            ],
          },
          {
            id: 'wispA',
            html: piece.wisp(),
            soft: true,
            depth: 4,
            drift: [20, 2],
            free: true,
            place: [(_a, p) => (p.moon ? topLeft(p.moon.x - p.moon.w * 0.35, p.moon.y + p.moon.h * 0.52, p.moon.w * 1.35, AR.wisp) : null)],
          },
          ...['bat1', 'bat2'].map(
            (id, i): PieceDef => ({
              id,
              html: piece.bat(i ? '#241E2C' : '#0E0C12', i * 0.15),
              free: true,
              place: [(a) => ({ x: 0, y: 0, w: a.mobile ? 28 : 36, h: (a.mobile ? 28 : 36) / AR.bat })],
            })
          ),
          {
            id: 'pumpkinL',
            html: piece.pumpkin(true, 0),
            hit: [0.35, 0.3, 0.1, 0.3],
            place: [
              (a) => {
                const l = lowBand(a)
                const body = clamp(l.h * 0.9, 40, 110)
                if (l.h < 40) return null
                return groundAt(a.W - body * 1.1, a.H - 8, pumpkinW(body), AR.pumpkin, G.pumpkin)
              },
            ],
          },
          {
            id: 'pumpkinS',
            html: piece.pumpkin(false),
            hit: [0.35, 0.3, 0.1, 0.3],
            place: [
              (a) => {
                const l = lowBand(a)
                const body = clamp(l.h * 0.62, 32, 76)
                if (l.h < 36) return null
                return groundAt((a.copy ? a.copy.x : 40) + body * 0.3, a.H - 8, pumpkinW(body), AR.pumpkin, G.pumpkin)
              },
            ],
          },
          {
            id: 'pumpkinT',
            html: piece.pumpkin(true, 0.7),
            hit: [0.35, 0.3, 0.1, 0.3],
            place: [
              (a, p) => {
                const l = lowBand(a)
                if (!p.pumpkinS || l.h < 36) return null
                const body = clamp(l.h * 0.42, 24, 50)
                return groundAt(cx(p.pumpkinS) + p.pumpkinS.w * 0.24 + body, a.H - 6, pumpkinW(body), AR.pumpkin, G.pumpkin)
              },
            ],
          },
        ],
      }
    case 'spring': {
      // 顶带里一排灯笼挂在横贯分区的绳上，绳头正好是灯笼图里那段绳子的上端；最长的
      // 一盏的流苏也停在标题和按钮之上，碰到字的那盏就不挂。
      // A row of lanterns on the cord across the section, each string's top on
      // the cord; even the longest tassel stops above the headline and button,
      // and any lantern that would touch text is left off.
      const N = 7
      const row = (i: number, len: number, glyph: string | null): PieceDef => ({
        id: 'lantern' + i,
        kind: 'lantern',
        html: piece.lantern(len, glyph),
        hit: [len / (len + 176), 0.08, 0, 0.08],
        place: [
          (a) => {
            const t = topBand(a)
            if (a.mobile && i > 1) return null
            const xc = a.mobile ? a.W * [0.08, 0.92][i] : a.W * (0.07 + (i / (N - 1)) * 0.86)
            const top = cordY(a, xc)
            // 再留 14px：标题字形的外框比标题元素本身高出几像素。
            // 14px more headroom: the headline's glyph boxes stand a few px above the element itself.
            const w = clamp((t.h - top - 14) / ((len + 176) / 140), 28, a.mobile ? 40 : 84)
            return topLeft(xc - w / 2, top - 0.5, w, lanternAR(len))
          },
        ],
      })
      return {
        effects: ['golddust', 'plumPetals'],
        region: (a) => ({ x0: a.copy ? right(a.copy) / a.W : 0.5, x1: 1 }),
        pieces: [
          row(0, 44, '春'),
          row(1, 90, '福'),
          row(2, 30, null),
          row(3, 60, '福'),
          row(4, 30, '春'),
          row(5, 110, '福'),
          row(6, 40, null),
          {
            id: 'cord',
            html: '',
            draw: (a) => {
              const x0 = -20
              const x1 = a.W + 20
              const sag = cordSag(a)
              const h = CORD_Y + sag + 8
              // 二次曲线 (x0,Y)–(x1,Y)，控制点下沉 2×sag，中点正好下垂 sag。
              // Quadratic from (x0,Y) to (x1,Y) with the control point 2×sag down: the midpoint sags exactly sag.
              const d = 'M' + x0 + ' ' + CORD_Y + ' Q' + (a.W / 2).toFixed(1) + ' ' + (CORD_Y + sag * 2).toFixed(1) + ' ' + x1 + ' ' + CORD_Y
              const html =
                '<svg viewBox="0 0 ' + a.W.toFixed(1) + ' ' + h.toFixed(1) + '" overflow="visible">' +
                '<path d="' + d + '" fill="none" stroke="#B7862E" stroke-width="1.5"/>' +
                '<path d="' + d + '" fill="none" stroke="#F2CC72" stroke-width=".6" opacity=".45" transform="translate(0 -.4)"/></svg>'
              return { box: { x: 0, y: 0, w: a.W, h }, html }
            },
            place: [],
          },
          {
            id: 'plum',
            html: piece.plumBranch(),
            flip: true,
            hit: [0.3, 0.3, 0, 0],
            place: [
              (a) => {
                const l = lowBand(a)
                const w = clamp(l.h * AR.plum * 1.1, 80, 200)
                if (l.h < 50) return null
                return topLeft(0, a.H - w / AR.plum, w, AR.plum)
              },
            ],
          },
        ],
      }
    }
    case 'christmas':
      return {
        effects: ['snow'],
        region: () => ({ x0: 0, x1: 1 }),
        pieces: [
          {
            // 一整跨灯串：两端伸出屏幕左右缘，中间自然下垂，没有凭空吊起的尖。
            // One span of lights: both ends run off the screen edges and it sags
            // naturally between, with no peaks held up by nothing.
            id: 'lights',
            html: '',
            place: [],
            draw: (a, info) => {
              const t = topBand(a)
              const sag = cordSag(a) * 1.4
              const h = CORD_Y + sag + 34
              if (t.h < h) return null
              const drape = [-20, CORD_Y, a.W + 20, CORD_Y, sag, 0]
              const html = piece.lightsBetween(a.W, h, [drape])
              // 灯泡垂到的最低处不能碰到字。/ the lowest bulbs must stay clear of text
              if (hitsAny({ x: 0, y: CORD_Y, w: a.W, h: sag + 30 }, info, 10)) return null
              return { box: { x: 0, y: 0, w: a.W, h }, html }
            },
          },
          {
            id: 'bank',
            html: piece.snowbank(),
            hit: [0.4, 0, 0, 0],
            place: [
              (a) => {
                const l = lowBand(a)
                const h = clamp(l.h * 0.55, 26, 70)
                return l.h > 30 ? { x: 0, y: a.H - h, w: a.W, h } : null
              },
            ],
          },
          {
            id: 'pines',
            html: piece.pines(),
            hit: [0.1, 0.05, 0, 0.05],
            place: [
              (a, p) => {
                const l = lowBand(a)
                if (!p.bank) return null
                const w = clamp((l.h + p.bank.h * 0.4) * AR.pines * 0.95, 110, 320)
                return groundAt(a.W - w / 2 - 12, a.H - p.bank.h * 0.42, w, AR.pines, G.pines)
              },
            ],
          },
          {
            id: 'pinesL',
            html: piece.pines(),
            flip: true,
            hit: [0.1, 0.05, 0, 0.05],
            place: [
              (a, p) => {
                const l = lowBand(a)
                if (!p.bank || a.mobile) return null
                const w = clamp((l.h + p.bank.h * 0.4) * AR.pines * 0.6, 90, 200)
                return groundAt(w / 2 + 12, a.H - p.bank.h * 0.4, w, AR.pines, G.pines)
              },
            ],
          },
        ],
      }
    case 'newyear':
      return {
        effects: ['fireworks', 'confetti'],
        region: (a) => ({ x0: a.cta ? a.cta.x / a.W : 0.6, x1: 1 }),
        ranges: () => [[0.04, 0.96]],
        burstY: (a) => [0.08, Math.max(0.12, (topBand(a).y1 - 50) / a.H)],
        pieces: [],
      }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 组件 / components
// ════════════════════════════════════════════════════════════════════════════

function useIsPhone() {
  const q = '(max-width: 1023px)'
  const [phone, setPhone] = useState(() => {
    try {
      return window.matchMedia(q).matches
    } catch {
      return false
    }
  })
  useEffect(() => {
    let mq: MediaQueryList
    try {
      mq = window.matchMedia(q)
    } catch {
      return
    }
    const on = () => setPhone(mq.matches)
    if (mq.addEventListener) mq.addEventListener('change', on)
    else mq.addListener(on)
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', on)
      else mq.removeListener(on)
    }
  }, [])
  return phone
}

// 首屏布景。scene 是叙事的幕序号：第一幕完整呈现；之后只留粒子和顶部挂件，淡一半。
// The hero set. `scene` is the story index: scene one shows everything; later
// scenes keep only particles and the hanging pieces, half-faded.
export default function FestivalStage({ scene: sceneIndex }: { scene: number }) {
  const f = useFestivalOptional()
  const key = f ? f.festival : null
  const phone = useIsPhone()
  if (!f || !key) return null
  return (
    <Stage
      key={key + ':' + f.replay + ':' + (phone ? 'm' : 'd')}
      festival={key}
      variant="hero"
      phone={phone}
      ambient={sceneIndex > 0}
      reduced={f.reducedMotion}
      year={f.newYear}
    />
  )
}

// 收尾 CTA 区的布景：第一次滚到这里才挂载，入场正好在用户眼前播。
// The closing-section set, mounted the first time it scrolls into view.
export function FestivalFinale() {
  const f = useFestivalOptional()
  const key = f ? f.festival : null
  const phone = useIsPhone()
  const host = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(false)
  useEffect(() => {
    const el = host.current
    if (!el || seen) return
    if (typeof IntersectionObserver === 'undefined') return setSeen(true)
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setSeen(true), { threshold: 0.3 })
    io.observe(el)
    return () => io.disconnect()
  }, [seen, key])
  if (!f || !key) return null
  return (
    <div ref={host} className="fa-finale-host" aria-hidden>
      {seen && (
        <Stage
          key={key + ':' + f.replay + ':' + (phone ? 'm' : 'd')}
          festival={key}
          variant="finale"
          phone={phone}
          ambient={false}
          reduced={f.reducedMotion}
          year={f.newYear}
        />
      )}
    </div>
  )
}

interface StageProps {
  festival: FestivalKey
  variant: Variant
  phone: boolean
  ambient: boolean
  reduced: boolean
  year: number
}

// 量锚点。/ measure the anchors
function measure(root: HTMLElement, variant: Variant, mobile: boolean): { anchors: Anchors; info: Box[] } {
  const origin = root.getBoundingClientRect()
  const W = origin.width
  const H = origin.height
  if (variant === 'hero') {
    const stage = root.parentElement as HTMLElement
    const header = document.querySelector('header')
    const screen = relBox(stage.querySelector('.dev-screen'), origin)
    // 屏幕矩形外扩一圈边框，得到整台手机。/ screen rect grown by the bezel gives the whole phone
    const phone = screen ? inflate(screen, screen.w * 0.06, screen.h * 0.028) : null
    const hb = header ? header.getBoundingClientRect() : null
    const ribbon = header ? header.querySelector('.fa-ribbon') : null
    const rr = ribbon ? ribbon.getBoundingClientRect() : null
    const extras = Array.prototype.slice
      .call(stage.querySelectorAll('.story-ticks, .scroll-cue'))
      .map((e: Element) => relBox(e, origin))
      .filter(Boolean) as Box[]
    const info = extras.concat(collectInfo([stage, header], origin, {
      // 桌面上布景在手机背后，手机屏幕里的字挡不到；手机版布景在上层，屏幕里的字也要让。
      // On desktop the set is behind the phone; on phones it is above, so the
      // screen's text must be avoided too.
      // WebGL 模式下 .dev-screen 不在 .story-phone 里面，两个都要排除。
      // In WebGL mode .dev-screen is not inside .story-phone, so both are excluded.
      exclude: mobile ? undefined : '.story-phone, .dev-screen',
      always: '.story-phone > p',
    }))
    return {
      anchors: {
        W,
        H,
        mobile,
        // 导航是固定在视口顶端的，它的下沿就是它自己的高度——不能用「导航下沿减舞台
        // 顶」来算：页面滚下去以后舞台顶是负几千像素，那样算出来的锚点会把月亮、桂花枝
        // 推到几千像素之外，出现在后面的分区里。
        // The nav is fixed to the top of the viewport, so its bottom is simply its
        // height. Computing "nav bottom minus stage top" breaks once the page is
        // scrolled: the stage top is thousands of pixels negative and every piece
        // hung from the nav would land in a later section.
        nav: hb ? hb.height : 0,
        // 只在舞台顶贴着视口顶时才布局，所以问候条下沿减舞台顶就是它在舞台里的位置；
        // 减 1px 让绳头藏进金线下面。
        // Layout only runs with the stage flush to the viewport top, so ribbon
        // bottom minus stage top is its position in the stage; 1px less tucks
        // the string's end under the gold rule.
        hang: rr && rr.height > 4 ? Math.max(0, rr.bottom - origin.top - 1) : 0,
        phone,
        copy: relBox(stage.querySelector('[data-panel="hero"] .panel-inner'), origin),
        cta: null,
        caption: relBox(stage.querySelector('.story-phone > p'), origin),
      },
      info,
    }
  }
  // finale：host 的兄弟节点就是收尾区 section。/ the host's sibling is the closing section
  const wrap = (root.parentElement as HTMLElement).parentElement as HTMLElement
  const section = wrap.querySelector('section')
  const h2 = section ? section.querySelector('h2') : null
  const sub = h2 ? h2.nextElementSibling : null
  const btn = section ? section.querySelector('button') : null
  const note = btn ? btn.nextElementSibling : null
  const info = collectInfo([section], origin)
  return {
    anchors: {
      W,
      H,
      mobile,
      nav: 0,
      hang: 0,
      phone: null,
      copy: union([relBox(h2, origin), relBox(sub, origin)].filter(Boolean) as Box[]),
      cta: union([relBox(btn, origin), relBox(note, origin)].filter(Boolean) as Box[]),
      caption: null,
    },
    info,
  }
}

function hitBox(b: Box, inset?: [number, number, number, number]): Box {
  if (!inset) return b
  const [t, r, bt, l] = inset
  return { x: b.x + b.w * l, y: b.y + b.h * t, w: b.w * (1 - l - r), h: b.h * (1 - t - bt) }
}

function Stage({ festival, variant, phone, ambient, reduced, year }: StageProps) {
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const field = useRef<ParticleField | null>(null)
  const visibleRef = useRef(true)
  const def = useMemo(() => (variant === 'hero' ? heroScene(festival, year) : finaleScene(festival)), [festival, year, variant])
  // 每次布局的结果：id → 框（null 表示这次不显示）；布局时的手机位置，用来算跟随位移。
  // The latest layout: id → box (null = hidden this time), plus the phone's
  // position at layout time, used for the follow offset.
  const [layout, setLayout] = useState<{
    boxes: Record<string, Box | null>
    anchors: Anchors | null
    strings: Record<string, number>
    htmls: Record<string, string>
  }>({
    boxes: {},
    anchors: null,
    strings: {},
    htmls: {},
  })
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  // ── 布局 / layout ──
  useEffect(() => {
    const el = root.current
    if (!el) return
    let raf = 0
    const run = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        // 首屏布景只在「真的停在首屏」时量：舞台顶贴着视口顶、且处在第一幕。其余时候
        // 文案面板是透明的、舞台可能已经滚走，量出来的东西不可信，保留上一次的布局。
        // The hero only measures while genuinely on the first screen: stage top
        // flush with the viewport and on scene one. At any other time the copy
        // panel is transparent and the stage may have scrolled away, so the
        // measurement cannot be trusted and the last layout is kept.
        if (variant === 'hero' && (ambient || Math.abs(el.getBoundingClientRect().top) > 4)) return
        const { anchors, info } = measure(el, variant, phone)
        const boxes: Record<string, Box | null> = {}
        const strings: Record<string, number> = {}
        const htmls: Record<string, string> = {}
        const placed: Placed = {}
        const bodies: Box[] = []
        // 首屏的灯笼：绳子从挂点一直垂到灯笼顶。绳子也不能穿过导航里的字和按钮，灯笼
        // 身不能叠在另一盏灯笼或手机上；不行就左右挪，挪到最近的空位。
        // Hero lanterns: the string runs from the tie point down to the cap. It
        // may not cross nav text or buttons, and the body may not overlap another
        // lantern or the phone; otherwise the lantern slides sideways to the
        // nearest free spot.
        const strung = (p: PieceDef) => variant === 'hero' && p.kind === 'lantern'
        // 手机屏上布景盖在界面上面，灯笼只能贴着屏幕两侧挂，最多挪 24px，绳子离字 8px；
        // 桌面上可以在空地里挪到 160px，绳子离字 14px。
        // On phones the set lies above the UI, so lanterns may only hang at the
        // screen sides, sliding at most 24px with 8px string clearance; desktops
        // may slide up to 160px through empty space with 14px clearance.
        const clear = anchors.mobile ? 8 : 14
        const slide = anchors.mobile ? 6 : 40
        const lanternFits = (p: PieceDef, b: Box, margin: number) => {
          const body = hitBox(b, p.hit)
          if (b.x < 2 || right(b) > anchors.W - 2) return false
          if (hitsAny(body, info, margin)) return false
          if (body.y - anchors.hang > 1 && hitsAny({ x: cx(b) - clear, y: anchors.hang, w: clear * 2, h: body.y - anchors.hang }, info, 0)) return false
          const grown = inflate(body, 4)
          if (bodies.some((o) => intersects(grown, o))) return false
          if (anchors.phone && !anchors.mobile && intersects(grown, anchors.phone)) return false
          return true
        }
        for (const p of def.pieces) {
          let chosen: Box | null = null
          // 边距 = 14px + 视差幅度：指针把它推到最远时也不会碰到字。
          // Margin = 14px + parallax travel, so even at full deflection it clears the text.
          const margin = 14 + (p.depth || 0)
          if (p.draw) {
            const r = p.draw(anchors, info, placed)
            if (r) {
              chosen = r.box
              htmls[p.id] = r.html
            }
          }
          for (const cand of p.place) {
            const b = cand(anchors, placed)
            if (!b || b.w < 4 || b.h < 4) continue
            if (strung(p)) {
              for (let k = 0; k <= slide && !chosen; k++) {
                const d = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 8
                const s = { x: b.x + d, y: b.y, w: b.w, h: b.h }
                if (lanternFits(p, s, margin)) chosen = s
              }
              if (chosen) break
              continue
            }
            if (!p.free && hitsAny(hitBox(b, p.hit), info, margin)) continue
            chosen = b
            break
          }
          boxes[p.id] = chosen
          if (chosen) {
            placed[p.id] = chosen
            if (strung(p)) {
              bodies.push(hitBox(chosen, p.hit))
              if (chosen.y - anchors.hang > 0.5) strings[p.id] = chosen.y - anchors.hang
            }
          }
        }
        // 现画的图只在几何真的变了时才换，避免每次重量都重建 DOM、打断入场动画。
        // Drawn art is only replaced when its geometry really changed, so a
        // re-measure does not rebuild the DOM and cut the entrance short.
        const prev = layoutRef.current.htmls
        Object.keys(htmls).forEach((k) => {
          if (prev[k] && prev[k].replace(/id="[^"]*"|url\(#[^)]*\)/g, '') === htmls[k].replace(/id="[^"]*"|url\(#[^)]*\)/g, '')) htmls[k] = prev[k]
        })
        setLayout({ boxes, anchors, strings, htmls })
        // 演示构建里把布局数据挂在节点上，方便自动化审查（生产构建不挂）。
        // In demo builds the layout data hangs on the node for automated audits.
        if (FESTIVAL_DEMO) (el as unknown as { __fa: unknown }).__fa = { anchors, info, boxes }
        const pf = field.current
        if (pf) {
          pf.setOcclusion(info)
          pf.setZones(
            def.region ? def.region(anchors) : undefined,
            def.ranges ? def.ranges(anchors) : undefined,
            def.burstY ? def.burstY(anchors) : undefined
          )
        }
      })
    }
    // 字体、问候条、面板淡入都会改变布局，头几秒多量几次。
    // Fonts, the ribbon and panel fades all shift layout; re-measure a few times early on.
    run()
    const timers = [300, 900, 1800, 3200].map((ms) => window.setTimeout(run, ms))
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(run) : null
    if (ro) {
      ro.observe(el)
      const header = document.querySelector('header')
      if (header && variant === 'hero') ro.observe(header)
    }
    window.addEventListener('resize', run)
    return () => {
      cancelAnimationFrame(raf)
      timers.forEach((t) => window.clearTimeout(t))
      if (ro) ro.disconnect()
      window.removeEventListener('resize', run)
    }
  }, [def, variant, phone, ambient])

  // ── 粒子 / particles ──
  useEffect(() => {
    if (reduced || !canvas.current) return
    // 与 App 环境层同一套档位：手机限 30fps，弱机 DPR 限 1（数量仍按 lite，不再额外减）。
    // Same tiers as the in-app ambient layer: 30 fps on phones, DPR 1 on weak
    // devices (counts stay on the lite setting, no further cut).
    const prof = particleProfile()
    const pf = new ParticleField(canvas.current, { effects: def.effects, lite: phone, maxFps: prof.maxFps, maxDpr: prof.maxDpr })
    field.current = pf
    const a = layoutRef.current.anchors
    if (a) pf.setZones(def.region ? def.region(a) : undefined, def.ranges ? def.ranges(a) : undefined, def.burstY ? def.burstY(a) : undefined)
    const onVis = () => {
      if (document.hidden || !visibleRef.current) pf.stop()
      else pf.start()
    }
    document.addEventListener('visibilitychange', onVis)
    let io: IntersectionObserver | null = null
    if (root.current && typeof IntersectionObserver !== 'undefined') {
      io = new IntersectionObserver((es) => {
        visibleRef.current = es.some((e) => e.isIntersecting)
        onVis()
      })
      io.observe(root.current)
    }
    const t = window.setTimeout(() => {
      onVis()
      if (def.effects.indexOf('confetti') !== -1) pf.confettiBurst(phone ? 60 : 110)
    }, 700)
    return () => {
      window.clearTimeout(t)
      document.removeEventListener('visibilitychange', onVis)
      if (io) io.disconnect()
      pf.destroy()
      field.current = null
    }
  }, [def, phone, reduced])

  // ── 编排 + 物理 + 视差 / choreography, physics and parallax ──
  const ready = !!layout.anchors
  useEffect(() => {
    const el = root.current
    if (!el || !ready) return
    const get = (id: string) => el.querySelector('[data-id="' + id + '"]') as HTMLElement | null
    const inner = (id: string) => {
      const n = get(id)
      return n ? (n.firstElementChild as HTMLElement) : null
    }
    const cleanups: (() => void)[] = []
    if (reduced) return

    el.style.visibility = 'hidden'
    let alive = true
    loadGsap().then((gsap) => {
      if (!alive) return
      el.style.visibility = ''
      const tl = gsap.timeline({ onComplete: () => el.querySelectorAll('.fa-art').forEach((n) => n.classList.add('fa-live')) })
      cleanups.push(() => tl.kill())
      const loops: { kill: () => void }[] = []
      cleanups.push(() => loops.forEach((l) => l.kill()))
      const box = (id: string) => layoutRef.current.boxes[id]
      const fadeIn = (id: string, at: number, extra: Record<string, unknown> = {}) => {
        const n = inner(id)
        if (n) tl.from(n, { opacity: 0, duration: 1.6, ease: 'power2.out', ...extra }, at)
      }
      // 统一的缓动签名：出场用 expo/power3 的长尾减速，落地用带一点回弹的 back / elastic。
      // One easing signature: long decelerating tails for arrivals, a little
      // back/elastic overshoot for landings.
      switch (festival) {
        case 'midautumn': {
          fadeIn('stars', 0, { duration: 2.4 })
          const moon = inner('moon')
          const mb = box('moon')
          if (moon && mb) tl.from(moon, { y: mb.h * 0.22, scale: 0.95, opacity: 0, duration: 3.2, ease: 'expo.out' }, 0.1)
          ;['cloudA', 'cloudB', 'cloudFar'].forEach((id, i) => fadeIn(id, 0.8 + i * 0.2, { x: (i % 2 ? -1 : 1) * 40, duration: 2.6, ease: 'power3.out' }))
          const br = inner('branch')
          if (br) {
            tl.from(br, { rotation: -14, opacity: 0, transformOrigin: '100% 0%', duration: 2.4, ease: 'elastic.out(1, 0.55)' }, 0.5)
            loops.push(gsap.to(br, { rotation: 1.2, transformOrigin: '100% 0%', duration: 5.2, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 3 }))
          }
          fadeIn('mooncake', 1.4, { y: 16, duration: 1.4, ease: 'power3.out' })
          const rb = inner('rabbit')
          if (rb) {
            const body = rb.querySelector('.fa-rabbit-body')
            tl.from(rb, { x: 70, opacity: 0, duration: 1.5, ease: 'power1.out' }, 1.6)
            if (body) {
              tl.to(body, { y: -14, duration: 0.25, ease: 'power2.out', yoyo: true, repeat: 5 }, 1.6)
              const hop = () => {
                if (!alive) return
                const h = gsap.timeline({ onComplete: () => { loops.push(gsap.delayedCall(7 + Math.random() * 7, hop)) } })
                h.to(body, { scaleY: 0.9, scaleX: 1.06, transformOrigin: '50% 100%', duration: 0.12, ease: 'power2.out' })
                  .to(body, { y: -12, scaleY: 1.06, scaleX: 0.96, duration: 0.26, ease: 'power2.out' })
                  .to(body, { y: 0, scaleY: 1, scaleX: 1, duration: 0.32, ease: 'bounce.out' })
                loops.push(h)
              }
              loops.push(gsap.delayedCall(8, hop))
            }
          }
          break
        }
        case 'halloween': {
          fadeIn('stars', 0, { duration: 2.4 })
          const moon = inner('moon')
          if (moon) tl.from(moon, { y: 40, opacity: 0, duration: 2.8, ease: 'expo.out' }, 0.1)
          fadeIn('wispA', 1, { x: -40, duration: 2.6 })
          fadeIn('wispB', 1.3, { x: 34, duration: 2.6 })
          const sp = inner('spider')
          const sb = box('spider')
          if (sp && sb) {
            tl.from(sp, { y: -sb.h * 0.55, duration: 2.6, ease: 'elastic.out(1, 0.32)' }, 1.2)
            const climb = () => {
              if (!alive) return
              const c = gsap.timeline({ onComplete: () => { loops.push(gsap.delayedCall(5 + Math.random() * 6, climb)) } })
              c.to(sp, { y: -sb.h * 0.12, duration: 1.6, ease: 'power2.inOut' }).to(sp, { y: 0, duration: 1.8, ease: 'elastic.out(1, 0.35)' }, '+=0.6')
              loops.push(c)
            }
            loops.push(gsap.delayedCall(7, climb))
          }
          ;['pumpkinL', 'pumpkinS', 'pumpkinT'].forEach((id, i) => {
            const n = inner(id)
            const pk = n && n.querySelector('.fa-pumpkin')
            if (pk) tl.from(pk, { y: 50, scaleY: 0.55, scaleX: 1.2, transformOrigin: '50% 100%', opacity: 0, duration: 1.2, ease: 'elastic.out(1, 0.45)' }, 0.5 + i * 0.18)
          })
          const a = layoutRef.current.anchors
          const paths = a && def.bats ? def.bats(a) : []
          ;['bat1', 'bat2', 'bat3', 'bat4'].forEach((id, i) => {
            const n = get(id)
            const path = paths[i]
            if (!n || !path) return
            const b = box(id)
            const w = b ? b.w : 30
            const h = b ? b.h : 12
            const pts = path.map((q) => ({ x: q.x - w / 2, y: q.y - h / 2 }))
            gsap.set(n, { x: pts[0].x, y: pts[0].y })
            loops.push(
              gsap.to(n, {
                // 朝左飞时航向约 180°，补 180° 让身体保持正立。/ offset 180° when flying left to stay upright
                motionPath: { path: pts, curviness: 1.3, autoRotate: pts[0].x > pts[pts.length - 1].x ? 180 : true },
                duration: 8 + i * 1.6 + Math.random() * 1.5,
                ease: 'sine.inOut',
                repeat: -1,
                repeatDelay: 2 + Math.random() * 4,
                delay: 1.2 + i * 1.3,
              })
            )
          })
          break
        }
        case 'spring': {
          ;['cloudA', 'cloudB'].forEach((id, i) => fadeIn(id, 0.6 + i * 0.3, { x: (i ? -1 : 1) * 30 }))
          el.querySelectorAll('[data-kind="lantern"]').forEach((n, i) => {
            const b = box((n as HTMLElement).dataset.id || '')
            // 灯身和上面那段绳子一起落下。/ the lantern and the string above it drop together
            if (n.children.length && b) tl.from(Array.prototype.slice.call(n.children), { y: -b.h, duration: 1.3, ease: 'power3.out' }, 0.1 + i * 0.18)
          })
          const plum = inner('plum')
          if (plum) {
            tl.from(plum, { opacity: 0, y: 16, duration: 1.2, ease: 'power2.out' }, 0.4)
            tl.from(plum.querySelectorAll('.fa-bloom'), { scale: 0, transformOrigin: '50% 50%', duration: 0.6, ease: 'back.out(2.4)', stagger: 0.07 }, 0.8)
          }
          break
        }
        case 'christmas': {
          const lights = inner('lights')
          if (lights) {
            const wires = Array.prototype.slice.call(lights.querySelectorAll('svg > path')) as SVGPathElement[]
            wires.forEach((w) => {
              const len = w.getTotalLength()
              gsap.set(w, { strokeDasharray: len, strokeDashoffset: len })
            })
            tl.to(wires, { strokeDashoffset: 0, duration: 1.6, ease: 'power2.inOut', stagger: 0.25 }, 0.2)
            tl.from(lights.querySelectorAll('.fa-bulb'), { opacity: 0, scale: 0.4, transformOrigin: '50% 0%', duration: 0.4, ease: 'back.out(2)', stagger: 0.04 }, 0.9)
          }
          fadeIn('bank', 0.2, { y: 24, duration: 1.4, ease: 'power3.out' })
          ;['pines', 'pinesL'].forEach((id, i) => {
            const pn = inner(id)
            if (pn) tl.from(pn.querySelectorAll('svg > g'), { y: 50, opacity: 0, duration: 1.2, ease: 'power3.out', stagger: 0.1 }, 0.4 + i * 0.2)
          })
          break
        }
        case 'newyear': {
          fadeIn('stars', 0, { duration: 2 })
          const yr = inner('year')
          const txts = yr ? (Array.prototype.slice.call(yr.querySelectorAll('.fa-year')) as SVGTextElement[]) : []
          if (txts.length) {
            gsap.set(txts, { strokeDasharray: 1400, strokeDashoffset: 1400, opacity: 0.9 })
            tl.to(txts, { strokeDashoffset: 0, duration: 2.4, ease: 'power2.inOut', stagger: 0.5 }, 0.2).to(txts, { opacity: 0.5, duration: 1.4, ease: 'power2.out' }, '-=0.6')
          }
          break
        }
      }

      // 玉兔：随机眨眼、随机抖耳朵，不按固定节拍。/ the rabbit blinks and twitches at random, never on a beat
      const rabbitEl = inner('rabbit')
      if (rabbitEl) {
        const eye = rabbitEl.querySelector('.fa-eye')
        const ear = rabbitEl.querySelector('.fa-ear-f')
        const blink = () => {
          if (!alive) return
          if (eye) loops.push(gsap.to(eye, { scaleY: 0.1, transformOrigin: '50% 50%', duration: 0.07, yoyo: true, repeat: Math.random() < 0.25 ? 3 : 1 }))
          loops.push(gsap.delayedCall(2.4 + Math.random() * 4.5, blink))
        }
        const twitch = () => {
          if (!alive) return
          if (ear) loops.push(gsap.timeline().to(ear, { rotation: -14, transformOrigin: '50% 100%', duration: 0.09 }).to(ear, { rotation: 0, duration: 0.6, ease: 'elastic.out(1, 0.3)' }))
          loops.push(gsap.delayedCall(4 + Math.random() * 7, twitch))
        }
        loops.push(gsap.delayedCall(3, blink), gsap.delayedCall(5, twitch))
      }
    })

    // 每只蝙蝠扇翅的节奏各不相同。/ every bat flaps at its own rate
    el.querySelectorAll('.fa-wing-r, .fa-wing-l').forEach((w) => {
      const host = w.closest('[data-id]')
      const seed = host ? (host as HTMLElement).dataset.id!.length * 0.037 : 0
      ;(w as SVGElement).style.animationDuration = (0.34 + ((seed * 7.3) % 0.16)).toFixed(3) + 's'
    })

    // ── rAF ──
    const fine = (() => {
      try {
        return window.matchMedia('(pointer: fine)').matches
      } catch {
        return false
      }
    })()
    const target = { x: 0, y: 0 }
    const cur = { x: 0, y: 0 }
    let px = -1
    let pvx = 0
    let py = -1
    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      target.x = ((e.clientX - r.left) / r.width) * 2 - 1
      target.y = ((e.clientY - r.top) / r.height) * 2 - 1
      if (px >= 0) pvx = pvx * 0.6 + (e.clientX - px) * 0.4
      px = e.clientX
      py = e.clientY
    }
    if (fine) window.addEventListener('pointermove', onMove, { passive: true })

    // 单摆按灯身的横向位移（px）来算，再换成角度：绳子接到挂点以后摆臂变长了，
    // 同样的角度会让灯身甩出去几十像素，碰到手机和字；按位移算，摆幅永远是几像素。
    // The pendulum runs on the body's sideways displacement in px, converted to
    // an angle: with strings reaching the tie point the arm is much longer, and
    // the same angle would fling the body tens of pixels into the phone or text.
    // In displacement terms the swing always stays a few pixels.
    const lanterns = Array.prototype.slice.call(el.querySelectorAll('[data-kind="lantern"]')).map((n: HTMLElement, i: number) => {
      const pd = def.pieces.find((q) => q.id === n.dataset.id)
      const h0 = pd && pd.hit ? pd.hit[0] : 0.3
      return {
        n,
        id: n.dataset.id || '',
        // 灯身中心在图高里的比例 = 绳长占比 + 灯身半高占比。/ body centre as a fraction of the art height
        mid: h0 + (48 / 176) * (1 - h0),
        tassel: n.querySelector('.fa-tassel') as SVGGElement | null,
        x: 7 * (i % 2 ? -1 : 1),
        v: 0,
        ph: 0,
        pw: 0,
        seed: i * 1.7,
      }
    })
    // 漂移：两个不同周期的正弦叠加，读起来是「被风推着」，不是来回摆。
    // Drift: two sines of different periods, reading as pushed by wind rather than swinging.
    const drifters = def.pieces
      .filter((p) => p.drift)
      .map((p, i) => ({ el: get(p.id), amp: p.drift as [number, number], ph: i * 2.1, f: 0.07 + i * 0.013 }))
      .filter((d) => d.el)
      .map((d) => ({ ...d, svg: (d.el as HTMLElement).querySelector('svg') as SVGSVGElement | null }))
    // 烛光与灯笼的光：多频正弦合成的「噪声」，没有可见的节拍。
    // Candle and lantern light: a noise built from several sines, with no visible beat.
    const flames = Array.prototype.slice.call(el.querySelectorAll('.fa-flicker, .fa-candle-pool, .fa-lan-glow')) as SVGElement[]
    const followers = def.pieces.filter((p) => p.follow).map((p) => get(p.id)).filter(Boolean) as HTMLElement[]
    const screenEl = variant === 'hero' ? (el.parentElement as HTMLElement).querySelector('.dev-screen') : null

    let raf = 0
    let last = performance.now()
    let t = 0
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      t += dt
      if (fine) {
        cur.x += (target.x - cur.x) * Math.min(1, dt * 3)
        cur.y += (target.y - cur.y) * Math.min(1, dt * 3)
        el.style.setProperty('--mx', cur.x.toFixed(3))
        el.style.setProperty('--my', cur.y.toFixed(3))
      }
      // 跟随手机：手机随滚动移动时，贴着它的布景一起走，永远对准。
      // Follow the phone: as it moves with scroll, attached pieces move with it
      // and stay in register.
      const la = layoutRef.current.anchors
      if (screenEl && la && la.phone && followers.length) {
        const r = screenEl.getBoundingClientRect()
        const o = el.getBoundingClientRect()
        const nowCx = r.left - o.left + r.width / 2
        const nowCy = r.top - o.top + r.height / 2
        const dx = nowCx - cx(la.phone)
        const dy = nowCy - cy(la.phone)
        for (const f of followers) {
          f.style.setProperty('--ax', dx.toFixed(1) + 'px')
          f.style.setProperty('--ay', dy.toFixed(1) + 'px')
        }
      }
      for (const d of drifters) {
        if (!d.svg) continue
        const x = d.amp[0] * (Math.sin(t * d.f * 6.283 + d.ph) + 0.45 * Math.sin(t * d.f * 2.7 * 6.283 + d.ph * 1.7))
        const y = d.amp[1] * Math.sin(t * d.f * 1.6 * 6.283 + d.ph)
        d.svg.style.transform = 'translate(' + x.toFixed(2) + 'px,' + y.toFixed(2) + 'px)'
      }
      flames.forEach((fl, i) => {
        const s = i * 1.37
        const n = 0.5 + 0.22 * Math.sin(t * 7.3 + s) + 0.16 * Math.sin(t * 13.1 + s * 2) + 0.12 * Math.sin(t * 23.7 + s * 3)
        const glow = fl.classList.contains('fa-lan-glow')
        fl.style.opacity = (glow ? 0.75 + 0.25 * Math.sin(t * 1.3 + s) * 0.6 + 0.1 * n : 0.7 + 0.3 * n).toFixed(3)
      })
      for (const l of lanterns) {
        const lb = layoutRef.current.boxes[l.id]
        if (!lb) continue
        // 摆臂 = 挂点到灯身中心。/ arm = tie point to the body's centre
        const arm = Math.max(30, (layoutRef.current.strings[l.id] || 0) + lb.h * l.mid)
        const K = 3.4
        const C = 0.55
        const wind = 2.6 * Math.sin(t * 0.7 + l.seed) + 1.3 * Math.sin(t * 1.9 + l.seed * 2)
        let push = 0
        if (fine && py >= 0) {
          const r = l.n.getBoundingClientRect()
          if (px > r.left && px < r.right && py > r.top + r.height * 0.4 && py < r.bottom) push = pvx * 3.2
        }
        const acc = -K * l.x - C * l.v + wind + push
        l.v += acc * dt
        // 被指针拨得再狠，灯身也只偏 10px。/ however hard the pointer pushes, the body moves at most 10px
        l.x = clamp(l.x + l.v * dt, -10, 10)
        l.n.style.transform = 'rotate(' + (l.x / arm).toFixed(5) + 'rad)'
        if (l.tassel) {
          const pa = -16 * l.ph - 1.6 * l.pw - acc * 0.045
          l.pw += pa * dt
          l.ph += l.pw * dt
          l.tassel.style.transform = 'rotate(' + l.ph.toFixed(4) + 'rad)'
        }
      }
      pvx *= Math.exp(-dt * 6)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      alive = false
      cancelAnimationFrame(raf)
      if (fine) window.removeEventListener('pointermove', onMove)
      cleanups.forEach((c) => c())
      el.style.visibility = ''
    }
  }, [festival, variant, phone, reduced, def, ready])

  return (
    <div
      ref={root}
      className={'fa-stage fa-' + variant + (phone ? ' is-phone' : '') + (ambient ? ' is-ambient' : '')}
      aria-hidden
    >
      {def.pieces.map((p) => {
        const b = layout.boxes[p.id]
        const ext = b ? layout.strings[p.id] || 0 : 0
        // 这次布局没放下的，保留节点但隐藏（入场动画的引用不会断）。
        // Pieces that did not fit keep their node but are hidden, so animation
        // references stay valid.
        const style = b
          ? ({
              left: b.x + 'px',
              top: b.y + 'px',
              width: b.w + 'px',
              height: b.h + 'px',
              ['--d' as string]: p.depth || 0,
              // 单摆的支点在绳子的挂点上。/ the pendulum pivots at the tie point
              ...(ext ? { transformOrigin: '50% ' + (-ext).toFixed(1) + 'px' } : null),
            } as React.CSSProperties)
          : ({ display: 'none' } as React.CSSProperties)
        return (
          <div
            key={p.id}
            data-id={p.id}
            data-kind={p.kind}
            className={'fa-layer' + (p.soft ? ' fa-soft' : '') + (p.keep ? ' fa-keep' : '') + (p.flip ? ' fa-flip' : '') + (p.kind === 'lantern' ? ' fa-lantern-hang' : '')}
            style={style}
          >
            <SvgArt html={layout.htmls[p.id] || p.html} />
            {p.kind === 'lantern' && (
              // 绳子向上接到挂点：线宽与灯笼图里那段绳子一致（1.4 个图单位）。
              // The string continues up to the tie point, as thick as the art's own string (1.4 art units).
              <i
                className="fa-lan-string"
                style={ext && b ? { height: ext + 1.5 + 'px', width: Math.max(0.8, (b.w * 1.4) / 140).toFixed(2) + 'px' } : { display: 'none' }}
              />
            )}
          </div>
        )
      })}
      <canvas ref={canvas} />
    </div>
  )
}
