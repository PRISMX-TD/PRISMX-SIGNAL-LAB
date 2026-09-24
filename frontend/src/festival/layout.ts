// 节日布景的定位与避让 / placement and collision avoidance for festival sets
//
// 上一版按视口百分比摆放（「月亮在 75% 处」），换一个窗口尺寸就和手机、文案对
// 不上：要么跑位，要么压到字。这一版反过来：先量出页面上真实元素的位置（手机、
// 文案块、导航、按钮），每件布景都相对这些锚点计算；再把页面上所有**可见的文字
// 行和可点控件**收集成「信息区」，任何一件布景只要碰到信息区就换备选位置，都不行
// 就不显示。粒子同理：飘进信息区时逐渐淡出，不会压在字上。
// The previous version placed pieces by viewport percentage ("the moon at 75%"),
// so any other window size put them out of register with the phone and copy —
// drifting, or sitting on text. This version measures the real elements first
// (phone, copy block, nav, buttons) and places every piece relative to them.
// Every visible text line and control on the page is then collected as an
// "information area"; a piece that touches one tries its fallback positions and
// is dropped if none fit. Particles fade out as they drift into those areas, so
// nothing is ever drawn over text.

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export const right = (b: Box) => b.x + b.w
export const bottom = (b: Box) => b.y + b.h
export const cx = (b: Box) => b.x + b.w / 2
export const cy = (b: Box) => b.y + b.h / 2
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

export function inflate(b: Box, px: number, py = px): Box {
  return { x: b.x - px, y: b.y - py, w: b.w + px * 2, h: b.h + py * 2 }
}

export function intersects(a: Box, b: Box) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

export function union(list: Box[]): Box | null {
  if (!list.length) return null
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const b of list) {
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export function relBox(el: Element | null, origin: DOMRect): Box | null {
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return null
  return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }
}

// 节日层自己的节点永远不算「信息」。/ The festival layer's own nodes are never information.
const OWN = '.fa-stage, .fa-finale-host, .fd-topper, .fd-corner, .fd-garland, .fd-ground, .fa-logo-ornament, .fa-demo, .fd-ambient'

// 按祖先链累乘不透明度，并检查 visibility / display。叙事区里其余几幕的文案面板
// 是透明的但仍在原位，不能把它们当成信息。
// Multiplies opacity up the ancestor chain and checks visibility/display. The
// other story scenes' copy panels are transparent but still in place and must
// not count as information.
function makeVisibility(stopAt: Element, anyOpacity = false) {
  const cache = new Map<Element, number>()
  const alpha = (el: Element | null): number => {
    if (!el || el === document.documentElement) return 1
    const hit = cache.get(el)
    if (hit !== undefined) return hit
    const cs = getComputedStyle(el)
    let a = cs.display === 'none' || cs.visibility === 'hidden' ? 0 : anyOpacity ? 1 : parseFloat(cs.opacity || '1')
    if (a > 0 && el !== stopAt) a *= alpha(el.parentElement)
    cache.set(el, a)
    return a
  }
  return (el: Element) => alpha(el) > 0.08
}

export interface InfoOptions {
  // 额外排除的子树（例如桌面上布景在手机背后，手机屏幕里的字不会被挡）。
  // Extra subtrees to ignore (on desktop the set sits behind the phone, so the
  // phone's screen text cannot be covered).
  exclude?: string
  // 无论如何都算信息的元素（例如手机下方那行示例声明）。
  // Elements that always count (e.g. the sample-data caption under the phone).
  always?: string
  // 不把这个控件的外框算进去（装饰就挂在它身上），但它里面的文字照算。
  // Ignore this control's outer box (the decoration hangs on it) while still
  // counting the text inside it.
  ignoreControl?: Element | null
  // 不看透明度：还在淡入的文字也算（按钮小饰让位时要按「终将出现」的内容来判断）。
  // Ignore opacity: text still fading in counts too (the button charm makes way for content that is about to appear).
  anyOpacity?: boolean
}

// 收集 roots 下所有可见的文字行矩形与可点控件矩形，坐标相对 origin。
// Collects every visible text-line box and control box under the roots,
// relative to origin.
export function collectInfo(roots: (Element | null)[], origin: DOMRect, opts: InfoOptions = {}): Box[] {
  const out: Box[] = []
  const range = document.createRange()
  roots.forEach((root) => {
    if (!root) return
    const visible = makeVisibility(root, !!opts.anyOpacity)
    const skip = (el: Element) => {
      if (el.closest(OWN)) return true
      if (opts.always && el.closest(opts.always)) return false
      return !!(opts.exclude && el.closest(opts.exclude))
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    })
    let n: Node | null
    while ((n = walker.nextNode())) {
      const el = n.parentElement
      if (!el || skip(el) || !visible(el)) continue
      range.selectNodeContents(n)
      const rects = range.getClientRects()
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i]
        if (r.width > 1 && r.height > 1) out.push({ x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height })
      }
    }
    root.querySelectorAll('button, a[href], input, select, textarea, [role="button"]').forEach((el) => {
      if (el === opts.ignoreControl || skip(el) || !visible(el)) return
      const b = relBox(el, origin)
      if (b) out.push(b)
    })
  })
  return merge(out)
}

// 把挨得很近的行框并成块：碰撞检测和粒子遮挡都用块，既快又不会从两行字的缝里钻过去。
// Merge boxes that nearly touch into blocks — faster for collision and particle
// occlusion, and nothing can slip through the gap between two lines of text.
export function merge(list: Box[], gap = 10): Box[] {
  const boxes = list.slice()
  let changed = true
  while (changed) {
    changed = false
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        if (intersects(inflate(boxes[i], gap), boxes[j])) {
          boxes[i] = union([boxes[i], boxes[j]]) as Box
          boxes.splice(j, 1)
          changed = true
          break outer
        }
      }
    }
  }
  return boxes
}

export function hitsAny(b: Box, info: Box[], margin: number) {
  const g = inflate(b, margin)
  for (const i of info) if (intersects(g, i)) return true
  return false
}

// 按宽度与宽高比生成框的几个小工具。/ helpers building boxes from a width and aspect ratio
export const centered = (cxv: number, cyv: number, w: number, ar: number): Box => ({ x: cxv - w / 2, y: cyv - w / ar / 2, w, h: w / ar })
export const topLeft = (x: number, y: number, w: number, ar: number): Box => ({ x, y, w, h: w / ar })
// groundAt：让图里的「地面线」（比例 g，0–1）落在 y 上。/ puts the art's ground line (fraction g) on y
export const groundAt = (cxv: number, y: number, w: number, ar: number, g: number): Box => {
  const h = w / ar
  return { x: cxv - w / 2, y: y - h * g, w, h }
}
