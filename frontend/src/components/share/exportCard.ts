// 把一张分享卡（HTML 字符串 + 模板 CSS）导出成 1080×1350 的 PNG，不引第三方库：
// 卡片放进 SVG <foreignObject>，字体与 logo 内联成 data URL（SVG 当图片加载时取不到外部资源），
// 再画到 canvas 上。卡片本身只用了这条路径能渲染的 CSS（设计稿阶段已排除 backdrop-filter 等）。
//
// Exports a share card (HTML string + template CSS) to a 1080x1350 PNG without a library:
// the card goes into an SVG <foreignObject>, fonts and the logo are inlined as data URLs (an
// SVG loaded as an image can't fetch external resources), then it's drawn onto a canvas. The
// templates only use CSS this path can render (backdrop-filter etc. were ruled out in design).
import { createCard } from './templates'
import { fitHero } from './fitHero'
import type { CardStyle, CardType, CardState } from './cardEnv'

export const CARD_W = 360
export const CARD_H = 450

// 模板在设计稿里跑在一张只有 box-sizing 重置的页面上；预览（Shadow DOM）与导出都用这同一份底样式，
// 不吃站内 Tailwind preflight（它会把 svg/img 改成 block，排版就和设计稿不一样了）。
// Templates were designed on a page whose only reset was box-sizing; preview (Shadow DOM) and
// export share this base so Tailwind's preflight (which makes svg/img block) can't leak in.
export const BASE_CSS = '*{box-sizing:border-box}'

const cache = new Map<string, Promise<string>>()
function dataUrl(url: string): Promise<string> {
  let p = cache.get(url)
  if (!p) {
    p = fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`${url} ${r.status}`); return r.blob() })
      .then((b) => new Promise<string>((res, rej) => {
        const fr = new FileReader()
        fr.onload = () => res(fr.result as string)
        fr.onerror = () => rej(fr.error)
        fr.readAsDataURL(b)
      }))
    p.catch(() => cache.delete(url))
    cache.set(url, p)
  }
  return p
}

async function fontCss(): Promise<string> {
  const archivo = await dataUrl('/fonts/archivo-400-800-87-125-latin.woff2')
  return `@font-face{font-family:'Archivo';font-style:normal;font-weight:400 800;font-stretch:87% 125%;src:url(${archivo}) format('woff2')}`
}

export function renderCardHtml(style: CardStyle, type: CardType, data: Record<string, unknown>, state: CardState) {
  const tpl = createCard(style, data)
  return { css: tpl.css, html: tpl.render(type, state) }
}

export async function exportCardPng(css: string, html: string, scale = 3): Promise<Blob> {
  const [fonts, logo] = await Promise.all([fontCss(), dataUrl('/logo-256.png')])
  const host = document.createElement('div')
  host.style.cssText = `width:${CARD_W}px;height:${CARD_H}px`
  const st = document.createElement('style')
  // 导出图不要圆角：圆角外的四角是透明像素，相册和聊天软件会把它显示成白边。直角让卡片底色铺满整张图。
  // No rounded corners in the export: the transparent corner pixels show up as white in galleries and chats.
  st.textContent = fonts + BASE_CSS + css + '.sl-card{border-radius:0!important}'
  host.appendChild(st)
  const card = document.createElement('div')
  card.innerHTML = html.split('/logo-256.png').join(logo)
  host.appendChild(card)
  // 先挂到屏幕外量一次大数字，超宽就缩小（与预览同一个 fitHero），再序列化。
  // Mount off-screen so fitHero can measure and shrink an over-wide hero (same as the preview), then serialize.
  const stage = document.createElement('div')
  stage.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none;opacity:0'
  const shadow = stage.attachShadow({ mode: 'open' })
  shadow.appendChild(host)
  document.body.appendChild(stage)
  try {
    await document.fonts?.ready
    fitHero(card.querySelector('.sl-card'))
  } finally {
    stage.remove()
  }
  // XMLSerializer 输出合法 XHTML（<img> 自闭合、带命名空间），foreignObject 才解析得了。
  // XMLSerializer emits valid XHTML (self-closed <img>, namespaced), which foreignObject requires.
  host.style.transform = `scale(${scale})`
  host.style.transformOrigin = '0 0'
  const xhtml = new XMLSerializer().serializeToString(host)
  const W = CARD_W * scale, H = CARD_H * scale
  // 放大用 foreignObject 里的 CSS transform，不用 viewBox：iOS Safari 不按 viewBox 缩放 foreignObject 的
  // 网页内容，只按原尺寸画在左上角（导出图只有左上 1/3 是卡片，其余透明显示成白）。CSS transform 两边一致。
  // Upscale with a CSS transform inside the foreignObject, not the viewBox: iOS Safari ignores viewBox scaling
  // for foreignObject HTML and paints it unscaled in the top-left third. A CSS transform behaves the same everywhere.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject x="0" y="0" width="${W}" height="${H}">${xhtml}</foreignObject></svg>`
  const img = new Image()
  img.decoding = 'sync'
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d unavailable')
  // 内联字体在第一次绘制时可能还没就绪，隔一帧重画一次。/ Inline fonts may not be ready on the first draw; redraw a frame later.
  ctx.drawImage(img, 0, 0, W, H)
  await new Promise((r) => setTimeout(r, 120))
  ctx.clearRect(0, 0, W, H)
  ctx.drawImage(img, 0, 0, W, H)
  return new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'))
}
