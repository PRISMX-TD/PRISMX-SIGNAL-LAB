// 节日粒子 / festival particles (canvas 2D)
//
// 雪、烟花、花瓣、金粉、地雾、彩纸——数量大、各自有物理的东西放在一张 canvas 上，
// 而不是几百个 DOM/SVG 节点：一次 clear + 一轮 drawImage，主线程几乎无感。
// Snow, fireworks, petals, gold dust, ground fog and confetti — many things
// with their own physics — live on one canvas rather than hundreds of DOM/SVG
// nodes: one clear and one round of drawImage per frame.
//
// 物理量全部以「像素 / 秒」计，按真实帧间隔积分，所以 60Hz 与 120Hz 屏幕上速度
// 一致；切到后台再回来时 dt 被钳住，不会一帧跳过去一大截。
// Everything is in pixels per second and integrated over the real frame delta,
// so 60 Hz and 120 Hz screens move at the same speed; dt is clamped so coming
// back from a background tab never jumps.
//
// 亮的东西（烟花、金粉）用 'lighter' 叠加——它们本来就是光源；雪、花瓣、雾用
// 普通叠加。
// Light sources (fireworks, gold dust) composite with 'lighter', because they
// are light; snow, petals and fog composite normally.

export type Effect = 'snow' | 'fireworks' | 'petals' | 'plumPetals' | 'golddust' | 'embers' | 'glitter' | 'fog' | 'confetti'

interface Options {
  effects: Effect[]
  // 烟花发射与花瓣生成的偏好区域（0–1，相对画布），避开左侧文案列。
  // Preferred region (0–1 of the canvas) for launches and spawns, keeping clear
  // of the copy column on the left.
  region?: { x0: number; x1: number }
  // 烟花可以只从几段水平区间里升起（例如手机两侧的空当）。
  // Fireworks may launch only from a few horizontal bands (e.g. either side of the phone).
  ranges?: [number, number][]
  // 手机上减量。/ fewer particles on phones
  lite?: boolean
  // 烟花炸开的高度区间（0–1，相对画布）。/ burst height band, 0–1 of the canvas
  burstY?: [number, number]
  // 数量倍率：App 里的环境层只要落地页的一小部分。
  // Count multiplier: the in-app ambient layer wants a fraction of the landing's.
  density?: number
}

const TAU = Math.PI * 2
const rand = (a: number, b: number) => a + Math.random() * (b - a)
const pick = <T,>(arr: readonly T[]) => arr[(Math.random() * arr.length) | 0]

// 预渲染的柔边圆点：每个粒子一次 drawImage，比每帧建渐变便宜一个数量级。
// Pre-rendered soft dots: one drawImage per particle is an order of magnitude
// cheaper than building a gradient per particle per frame.
function softSprite(color: string, size = 64, hardness = 0.35) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d') as CanvasRenderingContext2D
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  grd.addColorStop(0, color)
  grd.addColorStop(hardness, color)
  grd.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grd
  g.fillRect(0, 0, size, size)
  return c
}

// 六角冰晶：六根主枝，每根带两对小分叉。/ a six-armed crystal, each arm with two pairs of barbs
function crystal(size = 64) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d') as CanvasRenderingContext2D
  g.translate(size / 2, size / 2)
  g.strokeStyle = 'rgba(244,247,250,1)'
  g.lineCap = 'round'
  const R = size * 0.44
  for (let i = 0; i < 6; i++) {
    g.save()
    g.rotate((i * Math.PI) / 3)
    g.lineWidth = size * 0.05
    g.beginPath()
    g.moveTo(0, 0)
    g.lineTo(0, -R)
    g.stroke()
    g.lineWidth = size * 0.035
    ;[0.45, 0.7].forEach((f) => {
      const l = R * (f === 0.45 ? 0.26 : 0.18)
      g.beginPath()
      g.moveTo(0, -R * f)
      g.lineTo(-l, -R * f - l)
      g.moveTo(0, -R * f)
      g.lineTo(l, -R * f - l)
      g.stroke()
    })
    g.restore()
  }
  return c
}

function rgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16)
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')'
}

// ── 雪 / snow ────────────────────────────────────────────────────────────────
interface Flake {
  x: number
  y: number
  r: number
  vy: number
  sway: number
  freq: number
  phase: number
  a: number
  layer: number
  // 近层里约三分之一是六角冰晶，会慢慢转。/ about a third of the near layer are slowly turning crystals
  crystal: boolean
  rot: number
  vr: number
}

// ── 烟花 / fireworks ─────────────────────────────────────────────────────────
interface Rocket {
  x: number
  y: number
  vx: number
  vy: number
  targetY: number
  palette: string[]
  kind: 'peony' | 'ring' | 'willow' | 'crackle'
}
interface Spark {
  x: number
  y: number
  px: number
  py: number
  vx: number
  vy: number
  life: number
  age: number
  color: string
  size: number
  drag: number
  grav: number
  twinkle: boolean
  trail: boolean
  // 柳和噼啪弹：拖尾上会不断掉下细小的闪光。/ willow and crackle shells shed glitter from their trails
  glitter?: boolean
}
interface Smoke {
  x: number
  y: number
  age: number
  life: number
  r: number
}
interface Flash {
  x: number
  y: number
  age: number
  color: string
  r: number
}

// ── 花瓣 / petals ────────────────────────────────────────────────────────────
interface Petal {
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  vr: number
  flip: number
  vflip: number
  size: number
  color: string
  kind: 'osmanthus' | 'plum'
}

// 金粉、余烬、亮片共用一种粒子：金粉和余烬往上飘，亮片往下落。
// Gold dust, embers and glitter share one particle: dust and embers rise,
// glitter falls.
interface Dust {
  x: number
  y: number
  vy: number
  vx: number
  r: number
  phase: number
  life: number
  age: number
  sprite: number
}

interface Fog {
  x: number
  y: number
  r: number
  vx: number
  a: number
}

interface Confetti {
  x: number
  y: number
  vx: number
  vy: number
  rot: number
  vr: number
  flip: number
  vflip: number
  w: number
  h: number
  color: string
  age: number
}

const FW_PALETTES = [
  ['#B7ABFF', '#8F7BFF', '#E9E4FF'],
  ['#F6DB9A', '#F1C46A', '#FFF3D6'],
  ['#EEF0F5', '#C9CED8', '#FFFFFF'],
  ['#F6DB9A', '#B7ABFF', '#FFFFFF'],
  ['#F5C1A0', '#F6DB9A', '#FFF1E6'],
]

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

// 粒子离文字 22px 以内开始淡出，进到文字框里完全消失。
// Particles start fading 22px from any text and vanish inside it.
const FEATHER = 22

export class ParticleField {
  private occ: Rect[] = []
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private opts: Options
  private w = 0
  private h = 0
  private dpr = 1
  private raf = 0
  private last = 0
  private t = 0
  private running = false
  private ro: ResizeObserver | null = null

  private flakes: Flake[] = []
  private flakeSprite: HTMLCanvasElement
  private crystalSprite: HTMLCanvasElement
  private smoke: Smoke[] = []
  private rockets: Rocket[] = []
  private sparks: Spark[] = []
  private flashes: Flash[] = []
  private nextLaunch = 0.6
  private salvo = 3
  private petals: Petal[] = []
  private petalClock = 0
  private dust: Dust[] = []
  private dustSprites: HTMLCanvasElement[]
  private fog: Fog[] = []
  private fogSprite: HTMLCanvasElement
  private confetti: Confetti[] = []

  constructor(canvas: HTMLCanvasElement, opts: Options) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d') as CanvasRenderingContext2D
    this.opts = opts
    this.flakeSprite = softSprite('rgba(242,245,248,1)', 64, 0.45)
    this.crystalSprite = crystal()
    this.dustSprites = [
      softSprite('rgba(246,214,140,1)', 32, 0.2), // 金 / gold
      softSprite('rgba(255,160,90,1)', 32, 0.25), // 余烬 / ember
      softSprite('rgba(183,171,255,1)', 32, 0.3), // 亮片·紫 / glitter violet
      softSprite('rgba(238,240,245,1)', 32, 0.3), // 亮片·银 / glitter silver
    ]
    this.fogSprite = softSprite('rgba(120,108,140,1)', 128, 0)
    this.resize()
    if (typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => this.resize())
      this.ro.observe(canvas)
    }
    this.seed()
  }

  private has(e: Effect) {
    return this.opts.effects.indexOf(e) !== -1
  }

  // 信息区（文字行、按钮）：粒子在这些框附近淡出，绝不压在字上。
  // Information areas (text lines, buttons): particles fade near them and are
  // never drawn over text.
  setOcclusion(boxes: Rect[]) {
    this.occ = boxes.map((b) => ({ x: b.x - 4, y: b.y - 4, w: b.w + 8, h: b.h + 8 }))
  }

  // 生成区域、烟花发射通道、炸开高度：随布局重新测量而更新。
  // Spawn region, launch lanes and burst heights, updated whenever layout is re-measured.
  setZones(region?: { x0: number; x1: number }, ranges?: [number, number][], burstY?: [number, number]) {
    if (region) this.opts.region = region
    if (ranges) this.opts.ranges = ranges
    if (burstY) this.opts.burstY = burstY
  }

  private fade(x: number, y: number) {
    let a = 1
    for (const b of this.occ) {
      const dx = Math.max(b.x - x, 0, x - (b.x + b.w))
      const dy = Math.max(b.y - y, 0, y - (b.y + b.h))
      if (dx > FEATHER || dy > FEATHER) continue
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d < FEATHER) {
        const k = d / FEATHER
        a = Math.min(a, k * k * (3 - 2 * k))
        if (a === 0) return 0
      }
    }
    return a
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect()
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    if (w === this.w && h === this.h && dpr === this.dpr) return
    const first = this.w === 0
    this.w = w
    this.h = h
    this.dpr = dpr
    this.canvas.width = Math.round(w * dpr)
    this.canvas.height = Math.round(h * dpr)
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (!first) this.seed()
  }

  // 初始铺满：雪和雾一开始就分布在整个画面里，而不是从顶上一点点落下来。
  // Initial fill: snow and fog start spread across the frame instead of
  // trickling in from the top edge.
  private seed() {
    const area = this.w * this.h
    const lite = this.opts.lite
    const k = this.opts.density === undefined ? 1 : this.opts.density
    if (this.has('snow')) {
      const n = Math.round(Math.min(lite ? 90 : 240, Math.round(area / (lite ? 5200 : 6500))) * k)
      this.flakes = []
      for (let i = 0; i < n; i++) this.flakes.push(this.makeFlake(true))
    }
    if (this.has('fog')) {
      this.fog = []
      const n = Math.max(2, Math.round((lite ? 5 : 8) * k))
      for (let i = 0; i < n; i++) {
        this.fog.push({
          x: rand(-0.2, 1.2) * this.w,
          y: this.h * rand(0.72, 1.02),
          r: rand(260, 520) * (lite ? 0.7 : 1),
          vx: rand(6, 16) * (Math.random() < 0.5 ? -1 : 1),
          a: rand(0.05, 0.09),
        })
      }
    }
    if (this.has('golddust') || this.has('embers') || this.has('glitter')) {
      this.dust = []
      const n = Math.round((lite ? 26 : 56) * k)
      for (let i = 0; i < n; i++) this.dust.push(this.makeDust(true))
    }
  }

  private makeFlake(anywhere: boolean): Flake {
    // 三层景深：远层小、慢、淡；近层大、快、亮。数量上远层最多。
    // Three depth layers: far is small, slow, faint; near is large, fast, bright.
    const roll = Math.random()
    const layer = roll < 0.55 ? 0 : roll < 0.87 ? 1 : 2
    const r = [rand(0.7, 1.3), rand(1.4, 2.2), rand(2.6, 3.8)][layer]
    return {
      x: rand(0, this.w),
      y: anywhere ? rand(0, this.h) : rand(-40, -8),
      r,
      vy: [rand(14, 22), rand(26, 38), rand(46, 64)][layer],
      sway: [8, 14, 22][layer] * rand(0.6, 1.2),
      freq: rand(0.3, 0.9),
      phase: rand(0, TAU),
      a: [0.38, 0.62, 0.88][layer],
      layer,
      crystal: layer === 2 && Math.random() < 0.35,
      rot: rand(0, TAU),
      vr: rand(-0.8, 0.8),
    }
  }

  private makeDust(anywhere: boolean): Dust {
    const region = this.opts.region || { x0: 0, x1: 1 }
    const glitter = this.has('glitter')
    return {
      x: rand(region.x0, region.x1) * this.w,
      y: anywhere ? rand(0, 1) * this.h : glitter ? -10 : this.h + 10,
      vy: glitter ? rand(6, 14) : -rand(8, 22),
      vx: rand(-4, 4),
      r: rand(1.4, 3.2),
      phase: rand(0, TAU),
      life: rand(7, 14),
      age: anywhere ? rand(0, 6) : 0,
      sprite: glitter ? (Math.random() < 0.4 ? 0 : Math.random() < 0.5 ? 2 : 3) : this.has('embers') ? 1 : 0,
    }
  }

  // 一次性彩纸：新年入场时从画面上方撒下来。
  // One-shot confetti, thrown from above when the New Year scene enters.
  confettiBurst(count = 110) {
    const region = this.opts.region || { x0: 0, x1: 1 }
    const cx = ((region.x0 + region.x1) / 2) * this.w
    const colors = ['#B7ABFF', '#F1D08A', '#E6E8EE', '#8F7BFF', '#F5C1A0']
    for (let i = 0; i < count; i++) {
      const a = rand(-Math.PI * 0.85, -Math.PI * 0.15)
      const sp = rand(260, 560)
      this.confetti.push({
        x: cx + rand(-60, 60),
        y: this.h * 0.35,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        rot: rand(0, TAU),
        vr: rand(-8, 8),
        flip: rand(0, TAU),
        vflip: rand(6, 14),
        w: rand(5, 9),
        h: rand(8, 14),
        color: pick(colors),
        age: 0,
      })
    }
    if (!this.running) this.start()
  }

  start() {
    if (this.running) return
    this.running = true
    this.last = performance.now()
    const loop = (now: number) => {
      if (!this.running) return
      const dt = Math.min(0.05, (now - this.last) / 1000)
      this.last = now
      this.step(dt)
      this.draw()
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  destroy() {
    this.stop()
    if (this.ro) this.ro.disconnect()
  }

  // ── 积分 / integration ──────────────────────────────────────────────────
  private step(dt: number) {
    this.t += dt
    const t = this.t
    // 风：两个不同周期的正弦叠加出「阵风」，所有轻的东西共享同一阵风。
    // Wind: two sines of different periods make gusts, shared by everything light.
    const wind = Math.sin(t * 0.13) * 16 + Math.sin(t * 0.41 + 1.3) * 7

    for (const f of this.flakes) {
      f.rot += f.vr * dt
      f.y += f.vy * dt
      f.x += (wind * (0.5 + f.layer * 0.35) + Math.cos(t * f.freq + f.phase) * f.sway) * dt
      if (f.y > this.h + 10) Object.assign(f, this.makeFlake(false))
      if (f.x < -20) f.x += this.w + 40
      else if (f.x > this.w + 20) f.x -= this.w + 40
    }

    if (this.has('fireworks')) this.stepFireworks(dt)

    if (this.has('petals') || this.has('plumPetals')) {
      this.petalClock -= dt
      const cap = Math.round((this.opts.lite ? 12 : 26) * (this.opts.density === undefined ? 1 : this.opts.density))
      if (this.petalClock <= 0 && this.petals.length < cap) {
        this.petalClock = rand(0.35, 0.9)
        this.petals.push(this.makePetal())
      }
      for (let i = this.petals.length - 1; i >= 0; i--) {
        const p = this.petals[i]
        p.vx += (wind * 0.9 - p.vx) * dt * 0.6
        p.x += (p.vx + Math.sin(t * 1.3 + p.rot) * 10) * dt
        p.y += p.vy * dt
        p.rot += p.vr * dt
        p.flip += p.vflip * dt
        if (p.y > this.h + 20 || p.x < -40 || p.x > this.w + 40) this.petals.splice(i, 1)
      }
    }

    for (const d of this.dust) {
      d.age += dt
      d.y += d.vy * dt
      d.x += (d.vx + Math.sin(t * 0.8 + d.phase) * 6 + wind * 0.2) * dt
      if (d.age > d.life || d.y < -10 || d.y > this.h + 10) Object.assign(d, this.makeDust(false))
    }

    for (const f of this.fog) {
      f.x += f.vx * dt
      if (f.x < -f.r) f.x = this.w + f.r
      else if (f.x > this.w + f.r) f.x = -f.r
    }

    for (let i = this.confetti.length - 1; i >= 0; i--) {
      const c = this.confetti[i]
      c.age += dt
      c.vx *= Math.exp(-2.2 * dt)
      c.vy = c.vy * Math.exp(-2.2 * dt) + 380 * dt
      // 纸片下落有终端速度，并随风飘。/ paper has a terminal velocity and drifts
      if (c.vy > 90) c.vy = 90
      c.x += (c.vx + wind * 1.4 + Math.sin(c.flip) * 18) * dt
      c.y += c.vy * dt
      c.rot += c.vr * dt
      c.flip += c.vflip * dt
      if (c.y > this.h + 20) this.confetti.splice(i, 1)
    }
  }

  private makePetal(): Petal {
    const plum = this.has('plumPetals') && (!this.has('petals') || Math.random() < 0.5)
    const region = this.opts.region || { x0: 0.6, x1: 1 }
    return {
      x: rand(region.x0, region.x1 + 0.05) * this.w,
      y: plum ? rand(-20, -6) : rand(0, 0.18) * this.h,
      vx: rand(-30, -6),
      vy: rand(22, 42),
      rot: rand(0, TAU),
      vr: rand(-2.4, 2.4),
      flip: rand(0, TAU),
      vflip: rand(2.5, 5.5),
      size: plum ? rand(4, 6.5) : rand(2.6, 3.6),
      color: plum ? pick(['#F2A3AC', '#F7BEC4', '#EA8C98']) : pick(['#F2B544', '#F6C765', '#E9A534']),
      kind: plum ? 'plum' : 'osmanthus',
    }
  }

  private stepFireworks(dt: number) {
    const region = this.opts.region || { x0: 0.4, x1: 0.96 }
    this.nextLaunch -= dt
    if (this.nextLaunch <= 0) {
      // 开场先连放三发，之后 1.2–2.8 秒一发，偶尔来个双发。
      // A three-shot salvo to open, then one every 1.2–2.8 s with the odd double.
      if (this.salvo > 0) {
        this.salvo--
        this.nextLaunch = rand(0.22, 0.42)
      } else {
        this.nextLaunch = rand(1.2, 2.8)
        if (Math.random() < 0.18) this.salvo = 1
      }
      this.launch(region)
    }

    const G = 170
    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i]
      r.vy += G * 0.35 * dt
      r.x += r.vx * dt
      r.y += r.vy * dt
      // 尾焰：每帧撒几颗很快熄灭的火星。/ exhaust: a few short-lived sparks per frame
      for (let k = 0; k < 2; k++) {
        this.sparks.push({
          x: r.x + rand(-1, 1), y: r.y + rand(0, 3), px: r.x, py: r.y,
          vx: rand(-14, 14), vy: rand(10, 40), life: rand(0.25, 0.55), age: 0,
          color: '#FFE8C2', size: rand(0.8, 1.4), drag: 3, grav: 60, twinkle: false, trail: false,
        })
      }
      if (r.y <= r.targetY || r.vy >= -30) {
        this.explode(r)
        this.rockets.splice(i, 1)
      }
    }

    const wind = Math.sin(this.t * 0.13) * 16
    for (let i = this.smoke.length - 1; i >= 0; i--) {
      const m = this.smoke[i]
      m.age += dt
      m.x += wind * 0.6 * dt
      m.y -= 6 * dt
      if (m.age > m.life) this.smoke.splice(i, 1)
    }
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i]
      s.age += dt
      if (s.age >= s.life) {
        this.sparks.splice(i, 1)
        continue
      }
      if (s.glitter && Math.random() < 0.09 && this.sparks.length < 1400) {
        this.sparks.push({
          x: s.x, y: s.y, px: s.x, py: s.y, vx: rand(-8, 8), vy: rand(0, 18), life: rand(0.3, 0.6), age: 0,
          color: '#FFF6DC', size: rand(0.6, 1), drag: 2.5, grav: 50, twinkle: true, trail: false,
        })
      }
      s.px = s.x
      s.py = s.y
      const k = Math.exp(-s.drag * dt)
      s.vx *= k
      s.vy = s.vy * k + s.grav * dt
      s.x += s.vx * dt
      s.y += s.vy * dt
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      this.flashes[i].age += dt
      if (this.flashes[i].age > 0.35) this.flashes.splice(i, 1)
    }
  }

  private launch(region: { x0: number; x1: number }) {
    const lane = this.opts.ranges ? pick(this.opts.ranges) : [region.x0, region.x1]
    const x = rand(lane[0], lane[1]) * this.w
    // 手机上首屏被内容占满，烟花只在底部那条空当里炸开。
    // On phones the first screen is full of content, so bursts stay in the free bottom band.
    const band = this.opts.burstY || (this.opts.lite ? [0.72, 0.86] : [0.1, 0.38])
    const targetY = rand(band[0], band[1]) * this.h
    // 按目标高度反推初速度，让火箭恰好在目标附近减速到顶点。
    // Solve launch speed from target height so the rocket peaks near it.
    const dist = this.h - targetY
    const vy = -Math.sqrt(2 * 170 * 0.35 * dist) * rand(1.02, 1.1)
    this.rockets.push({
      x,
      y: this.h + 6,
      vx: rand(-18, 18),
      vy,
      targetY,
      palette: pick(FW_PALETTES),
      kind: pick(['peony', 'peony', 'ring', 'willow', 'crackle'] as const),
    })
  }

  private explode(r: Rocket) {
    const lite = this.opts.lite
    this.flashes.push({ x: r.x, y: r.y, age: 0, color: r.palette[2], r: r.kind === 'willow' ? 120 : 90 })
    // 炸开后留下一团很淡的烟，随风飘散。/ a faint puff of smoke stays behind and drifts off
    this.smoke.push({ x: r.x, y: r.y, age: 0, life: rand(2.2, 3.2), r: r.kind === 'willow' ? 150 : 110 })
    const add = (n: number, speed: () => number, life: () => number, opts: Partial<Spark>) => {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + rand(-0.06, 0.06)
        const sp = speed()
        this.sparks.push({
          x: r.x, y: r.y, px: r.x, py: r.y,
          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
          life: life(), age: 0,
          color: pick(r.palette), size: rand(1.2, 2),
          drag: 1.6, grav: 70, twinkle: false, trail: true,
          ...opts,
        })
      }
    }
    const m = lite ? 0.55 : 1
    switch (r.kind) {
      case 'peony':
        add(Math.round(90 * m), () => rand(60, 190), () => rand(1.1, 1.9), {})
        break
      case 'ring':
        add(Math.round(64 * m), () => rand(150, 165), () => rand(1.2, 1.6), { drag: 1.4 })
        add(Math.round(24 * m), () => rand(30, 70), () => rand(0.8, 1.2), {})
        break
      case 'willow':
        // 柳：慢、长寿、下垂的金色拖尾。/ willow: slow, long-lived, drooping gold
        add(Math.round(70 * m), () => rand(50, 120), () => rand(2.2, 3.2), { color: '#F6D48A', drag: 1.9, grav: 46, size: 1.4, glitter: true })
        break
      case 'crackle':
        add(Math.round(80 * m), () => rand(70, 170), () => rand(0.9, 1.5), { twinkle: true, glitter: true })
        break
    }
  }

  // ── 绘制 / drawing ───────────────────────────────────────────────────────
  private draw() {
    const g = this.ctx
    g.clearRect(0, 0, this.w, this.h)

    if (this.fog.length) {
      g.globalCompositeOperation = 'source-over'
      for (const f of this.fog) {
        g.globalAlpha = f.a
        g.drawImage(this.fogSprite, f.x - f.r, f.y - f.r * 0.45, f.r * 2, f.r * 0.9)
      }
    }

    if (this.flakes.length) {
      g.globalCompositeOperation = 'source-over'
      for (const f of this.flakes) {
        const o = this.fade(f.x, f.y)
        if (o <= 0) continue
        g.globalAlpha = f.a * o
        if (f.crystal) {
          const s = f.r * 3.4
          g.save()
          g.translate(f.x, f.y)
          g.rotate(f.rot)
          g.drawImage(this.crystalSprite, -s / 2, -s / 2, s, s)
          g.restore()
          continue
        }
        const s = f.r * 2.6
        g.drawImage(this.flakeSprite, f.x - s / 2, f.y - s / 2, s, s)
      }
    }

    if (this.petals.length) {
      g.globalCompositeOperation = 'source-over'
      for (const p of this.petals) {
        const o = this.fade(p.x, p.y)
        if (o <= 0) continue
        g.save()
        g.translate(p.x, p.y)
        g.rotate(p.rot)
        // 翻面：水平方向按 cos 缩放，看起来像在空中翻转。
        // Flip: horizontal scale follows cos, reading as tumbling in the air.
        const sx = Math.max(0.12, Math.abs(Math.cos(p.flip)))
        g.scale(sx, 1)
        g.globalAlpha = 0.92 * o
        g.fillStyle = p.color
        if (p.kind === 'osmanthus') {
          for (let i = 0; i < 4; i++) {
            const a = (i * Math.PI) / 2
            g.beginPath()
            g.arc(Math.cos(a) * p.size * 0.7, Math.sin(a) * p.size * 0.7, p.size * 0.62, 0, TAU)
            g.fill()
          }
        } else {
          g.beginPath()
          g.ellipse(0, 0, p.size, p.size * 0.66, 0, 0, TAU)
          g.fill()
        }
        g.restore()
      }
    }

    if (this.dust.length) {
      g.globalCompositeOperation = 'lighter'
      for (const d of this.dust) {
        const fade = Math.min(1, d.age / 1.2, (d.life - d.age) / 1.5)
        const tw = 0.55 + 0.45 * Math.sin(this.t * 3 + d.phase)
        g.globalAlpha = Math.max(0, fade * tw * 0.8 * this.fade(d.x, d.y))
        const s = d.r * 4
        g.drawImage(this.dustSprites[d.sprite], d.x - s / 2, d.y - s / 2, s, s)
      }
    }

    if (this.smoke.length) {
      g.globalCompositeOperation = 'source-over'
      for (const m of this.smoke) {
        const k = m.age / m.life
        const rr = m.r * (0.5 + k * 0.8)
        g.globalAlpha = 0.07 * (1 - k) * this.fade(m.x, m.y)
        g.drawImage(this.fogSprite, m.x - rr, m.y - rr, rr * 2, rr * 2)
      }
    }
    if (this.flashes.length || this.sparks.length || this.rockets.length) {
      g.globalCompositeOperation = 'lighter'
      for (const f of this.flashes) {
        const k = (1 - f.age / 0.35) * this.fade(f.x, f.y)
        if (k <= 0) continue
        const grd = g.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.r)
        grd.addColorStop(0, rgba(f.color, 0.16 * k))
        grd.addColorStop(1, rgba(f.color, 0))
        g.globalAlpha = 1
        g.fillStyle = grd
        g.fillRect(f.x - f.r, f.y - f.r, f.r * 2, f.r * 2)
      }
      g.lineCap = 'round'
      for (const s of this.sparks) {
        const k = 1 - s.age / s.life
        let a = Math.pow(k, 1.4)
        if (s.twinkle && k < 0.55) a *= Math.random() < 0.5 ? 0.15 : 1
        a *= this.fade(s.x, s.y)
        if (a <= 0.01) continue
        g.globalAlpha = a
        g.strokeStyle = s.color
        g.fillStyle = s.color
        if (s.trail) {
          g.lineWidth = s.size
          g.beginPath()
          // 拖尾长度取两帧位移的 3 倍，速度越快尾巴越长。
          // Trail is 3x the per-frame displacement, so faster sparks streak more.
          g.moveTo(s.x - (s.x - s.px) * 3, s.y - (s.y - s.py) * 3)
          g.lineTo(s.x, s.y)
          g.stroke()
        } else {
          g.beginPath()
          g.arc(s.x, s.y, s.size, 0, TAU)
          g.fill()
        }
      }
      g.globalAlpha = 1
      g.fillStyle = '#FFF1D6'
      for (const r of this.rockets) {
        g.beginPath()
        g.arc(r.x, r.y, 1.8, 0, TAU)
        g.fill()
      }
    }

    if (this.confetti.length) {
      g.globalCompositeOperation = 'source-over'
      for (const c of this.confetti) {
        const o = this.fade(c.x, c.y)
        if (o <= 0) continue
        g.save()
        g.translate(c.x, c.y)
        g.rotate(c.rot)
        g.scale(1, Math.max(0.1, Math.abs(Math.cos(c.flip))))
        g.globalAlpha = Math.max(0, Math.min(1, 3 - c.age * 0.3)) * o
        g.fillStyle = c.color
        g.fillRect(-c.w / 2, -c.h / 2, c.w, c.h)
        g.restore()
      }
    }

    g.globalAlpha = 1
    g.globalCompositeOperation = 'source-over'
  }
}
