// 按钮小饰 / button charms
//
// 大多数按钮在节日期间顶上坐一件小东西：春节一小枝梅花、中秋探出头的兔耳、万圣节
// 扒着边偷看的黑猫、圣诞一层积雪、新年几片彩纸。它们都画成「底边就是地面」的小图，
// 由 charm.css 用 ::before 放在按钮上沿的正中间——药丸按钮不管多窄，正中间永远是
// 平的，所以底边总能刚好压住边缘。
// 这里不引用 art.ts / decor.ts，保持很小：它跟着 FestivalProvider 进主包，登录页、
// 错误页这些不加载节日大图的地方也能用。
// During festivals most buttons get a small charm sitting on top: a plum sprig
// for Spring Festival, rabbit ears peeking up for Mid-Autumn, a black cat
// peering over the edge for Halloween, a layer of snow for Christmas, a few
// scraps of confetti for New Year. Each is drawn with its bottom edge as the
// ground, and charm.css places it with ::before at the centre of the button's
// top edge: however narrow a pill button is, its centre is always flat, so the
// base always lands exactly on the edge.
// Nothing here imports art.ts / decor.ts, keeping it tiny: it ships in the main
// bundle with FestivalProvider, so the login and error pages, which never load
// the festival artwork, still get it.
import type { FestivalKey } from './calendar'
import { collectInfo, hitsAny, type Box } from './layout'
import './charm.css'

export interface Charm {
  url: string // CSS url(...)
  w: number // 宽（px）；圣诞是平铺单元的宽 / width in px; for Christmas, the tile width
  h: number
  top: number // 伪元素的 top：让底边压进按钮上沿 1px / ::before top that sinks the base 1px into the edge
}

const svg = (w: number, h: number, body: string) =>
  'url("data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' + body + '</svg>') +
  '")'

// 梅花：花心 (x, y)，五瓣外缘离花心 5.9s。/ plum blossom centred on (x, y); petals reach 5.9s
function blossom(x: number, y: number, s: number) {
  let out = '<g transform="translate(' + x + ' ' + y + ') scale(' + s + ')">'
  for (let i = 0; i < 5; i++) {
    const a = ((i * 72 - 90) * Math.PI) / 180
    out += '<circle cx="' + (Math.cos(a) * 3.2).toFixed(2) + '" cy="' + (Math.sin(a) * 3.2).toFixed(2) + '" r="2.7" fill="' + (i % 2 ? '#F2A7B8' : '#F6C3CE') + '"/>'
  }
  return out + '<circle r="1.5" fill="#F2CC72"/></g>'
}

export function buttonCharm(key: FestivalKey): Charm {
  switch (key) {
    case 'spring':
      // 一小枝梅花平躺在上沿：枝条最低点 y≈9.4，两朵花的下沿也在这条线上。
      // A plum sprig lying on the top edge: the twig's lowest point is y≈9.4, as are both blossoms' lower edges.
      return {
        url: svg(
          30,
          10,
          '<path d="M2 9.1 C9 8.6 17 9.4 28 8.2" fill="none" stroke="#6A4434" stroke-width="1.3" stroke-linecap="round"/>' +
            '<path d="M15 9 C16 7.6 17.4 6.6 19 6.2" fill="none" stroke="#6A4434" stroke-width=".9" stroke-linecap="round"/>' +
            blossom(10, 5.7, 0.62) +
            blossom(21.4, 6.4, 0.5) +
            '<circle cx="27.4" cy="7" r="1.2" fill="#E07A93"/>'
        ),
        w: 30,
        h: 10,
        top: -8.4,
      }
    case 'midautumn':
      // 兔耳从按钮后面探出来：耳根就是图的底边。/ rabbit ears peeking from behind the button; their base is the art's bottom edge
      return {
        url: svg(
          16,
          12,
          '<g transform="scale(.6667)">' +
            '<path d="M6 18 C3 10 5 1 8 1.6 C10.8 2.2 10 11 9.6 18 Z" fill="#E2DBCE"/>' +
            '<path d="M13.4 18 C13 10 14.6 0.6 17.6 1 C20.6 1.4 19 10.6 16.8 18 Z" fill="#ECE6DA"/>' +
            '<path d="M14.8 17 C14.8 11 15.8 4 17.4 4.2 C18.8 4.4 17.8 11 16.4 17 Z" fill="#E6B4AC"/>' +
            '<path d="M2 18 C4 14.2 20 14.2 22 18 Z" fill="#ECE6DA"/></g>'
        ),
        w: 16,
        h: 12,
        top: -11,
      }
    case 'halloween':
      // 黑猫扒着上沿偷看：头顶两只尖耳，一对橙色的眼睛，下巴被按钮挡住。
      // A black cat peering over the top edge: two pointed ears, a pair of orange eyes, its chin hidden by the button.
      return {
        url: svg(
          22,
          11,
          '<path d="M3 11 C3 6.4 5 4.2 6 3.6 L5.6 0.6 L8.6 2.6 C10.2 2.2 11.8 2.2 13.4 2.6 L16.4 0.6 L16 3.6 C17 4.2 19 6.4 19 11 Z" fill="#16121C" stroke="#4A4258" stroke-width=".7" stroke-linejoin="round"/>' +
            '<ellipse cx="8.6" cy="7.4" rx="1.5" ry="1.8" fill="#F59A45"/><ellipse cx="13.4" cy="7.4" rx="1.5" ry="1.8" fill="#F59A45"/>' +
            '<rect x="8.25" y="6.1" width=".7" height="2.6" rx=".35" fill="#16121C"/><rect x="13.05" y="6.1" width=".7" height="2.6" rx=".35" fill="#16121C"/>'
        ),
        w: 22,
        h: 11,
        top: -10,
      }
    case 'christmas':
      // 积雪平铺单元（与按钮挂件同一条雪线），由 CSS 横向重复、两端淡出。
      // A snow tile (the same snowline as the button topper), repeated across by CSS and faded at both ends.
      return {
        url: svg(26, 10, '<path d="M0 6 C4 1.2 9 1 13 4.2 C17 1 22 1.6 26 6 L26 9 C21 10.4 17 8.2 13 10 C9 8.4 4 10.4 0 9 Z" fill="#F2F5F8"/>'),
        w: 26,
        h: 10,
        top: -6,
      }
    case 'newyear':
      // 几片彩纸平躺在上沿，上方一颗小星光。/ a few confetti scraps lying on the top edge, one small sparkle above
      return {
        url: svg(
          26,
          10,
          '<rect x="2" y="7.4" width="5.6" height="2" rx=".5" fill="#8F7BFF" transform="rotate(-8 4.8 8.4)"/>' +
            '<rect x="9.4" y="7.8" width="5" height="1.9" rx=".5" fill="#F1D08A" transform="rotate(6 11.9 8.8)"/>' +
            '<rect x="16.6" y="7.6" width="5.4" height="2" rx=".5" fill="#E6E8EE" transform="rotate(-5 19.3 8.6)"/>' +
            '<path d="M21 0.4 L21.9 2.6 L24.1 3.5 L21.9 4.4 L21 6.6 L20.1 4.4 L17.9 3.5 L20.1 2.6 Z" fill="#F1D08A"/>'
        ),
        w: 26,
        h: 10,
        top: -9,
      }
  }
}

// 写到 <html> 上的 CSS 变量；festival 为 null 时清掉。/ CSS variables on <html>; cleared when there is no festival
export function applyCharm(key: FestivalKey | null) {
  const s = document.documentElement.style
  if (!key) {
    ;['--fd-charm', '--fd-charm-w', '--fd-charm-h', '--fd-charm-top'].forEach((p) => s.removeProperty(p))
    return
  }
  const c = buttonCharm(key)
  s.setProperty('--fd-charm', c.url)
  s.setProperty('--fd-charm-w', c.w + 'px')
  s.setProperty('--fd-charm-h', c.h + 'px')
  s.setProperty('--fd-charm-top', c.top + 'px')
}

// ── 让位 / making way ──
// CSS 不知道按钮上方挨着什么。这里逐个看：小饰要占的那块地方（按钮上沿正中往上）
// 如果碰到字或别的控件，就给按钮标上 data-fd-crowded，charm.css 让它不画。页面载入、
// 窗口缩放、字体到位、页面内容换了（切路由）都会重看一遍；价格跳动这类文字更新不触发。
// CSS cannot know what sits right above a button, so each one is checked here:
// if the patch the charm would occupy (the centre of the top edge, upwards)
// touches text or another control, the button gets data-fd-crowded and
// charm.css skips it. Re-checked on load, resize, when fonts arrive and when
// page content changes (route switches); text updates such as ticking prices
// do not trigger it.
const SEL = '.btn-primary, .btn-ghost, .btn-secondary, .btn-brand'

function scan() {
  const root = document.documentElement
  const key = root.getAttribute('data-festival')
  if (!key) return
  const vars = getComputedStyle(root)
  const w = parseFloat(vars.getPropertyValue('--fd-charm-w')) || 0
  const h = parseFloat(vars.getPropertyValue('--fd-charm-h')) || 0
  const top = parseFloat(vars.getPropertyValue('--fd-charm-top')) || 0
  const origin = { left: 0, top: 0, width: 0, height: 0 } as DOMRect
  const buttons = Array.prototype.slice.call(document.querySelectorAll(SEL)) as HTMLElement[]
  buttons.forEach((el) => {
    const b = el.getBoundingClientRect()
    if (b.width < 1 || b.height < 1) return
    const box: Box =
      key === 'christmas'
        ? { x: b.left + b.width * 0.22, y: b.top + top, w: b.width * 0.56, h }
        : { x: b.left + b.width / 2 - w / 2, y: b.top + top, w, h }
    const scope = el.closest('section, form, article, main, footer, header, [role="dialog"]') || el.parentElement
    // 按钮自己的文字整个落在按钮里，不算邻居。/ the button's own label lies wholly inside it and is not a neighbour
    const info = collectInfo([scope], origin, { ignoreControl: el, anyOpacity: true }).filter(
      (i) => !(i.x >= b.left - 0.5 && i.y >= b.top - 0.5 && i.x + i.w <= b.right + 0.5 && i.y + i.h <= b.bottom + 0.5)
    )
    if (hitsAny(box, info, 3)) el.setAttribute('data-fd-crowded', '')
    else el.removeAttribute('data-fd-crowded')
  })
}

export function startCharmGuard(): () => void {
  let pending = 0
  // 按钮滚进视野时再看一次：分区的入场动画（上移、淡入）结束后位置才是最终的。只观察新出现
  // 的按钮——重新 observe 会立刻回调一次，反复观察会变成死循环。
  // Look again when a button scrolls into view: a section's reveal (slide up,
  // fade in) must finish before positions are final. Only newly seen buttons are
  // observed; re-observing fires an immediate callback and would loop forever.
  const observed = typeof WeakSet !== 'undefined' ? new WeakSet<Element>() : null
  const io =
    typeof IntersectionObserver !== 'undefined' && observed
      ? new IntersectionObserver((es) => {
          if (es.some((e) => e.isIntersecting)) window.setTimeout(run, 700)
        })
      : null
  const watch = () => {
    if (!io || !observed) return
    Array.prototype.forEach.call(document.querySelectorAll(SEL), (e: Element) => {
      if (observed.has(e)) return
      observed.add(e)
      io.observe(e)
    })
  }
  // 节流而不是防抖：内容一直在变时也会隔一会儿看一次。/ throttled, not debounced: it still runs while content keeps changing
  function run() {
    if (pending) return
    pending = window.setTimeout(() => {
      pending = 0
      watch()
      scan()
    }, 300)
  }
  const timers = [60, 900, 2600].map((ms) => window.setTimeout(run, ms))
  const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(run) : null
  if (mo) mo.observe(document.body, { childList: true, subtree: true })
  window.addEventListener('resize', run)
  const fonts = (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts
  if (fonts) fonts.ready.then(run, () => undefined)
  return () => {
    timers.forEach((t) => window.clearTimeout(t))
    window.clearTimeout(pending)
    if (mo) mo.disconnect()
    if (io) io.disconnect()
    window.removeEventListener('resize', run)
    Array.prototype.forEach.call(document.querySelectorAll('[data-fd-crowded]'), (e: Element) => e.removeAttribute('data-fd-crowded'))
  }
}
