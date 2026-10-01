// 大数字防溢出：模板的字号是按设计稿里的短数字定的（例如隐私模式 80px 对 "+3.42%"），
// 真实数据可能长得多（"+1,186.1%"、五位数金额），会冲出卡片。渲染后实际量一次，
// 超出卡片左右留白就把这一组等比缩小。预览与导出都调用它，所以两边一致。
// 模板里用 data-fit 标出要守护的那一组：
//   data-fit="left"    HTML 容器，靠左对齐，以左上角为原点缩放
//   data-fit="center"  SVG <g>，居中对齐，以 data-ox / data-oy 为原点缩放
//
// Hero-number overflow guard: template sizes were tuned for the mockup's short numbers, but
// real values ("+1,186.1%", five-digit amounts) can run off the card. Measure after render and
// scale the marked group down until it fits inside the side padding. Both preview and export
// call this, so they match. Templates mark the group with data-fit ("left" = HTML box scaled
// from its top-left; "center" = SVG <g> scaled about data-ox/data-oy).
const PAD = 18

function unionRect(el: Element): DOMRect | null {
  let l = Infinity, r = -Infinity, t = Infinity, b = -Infinity
  const take = (n: Element) => {
    const rc = n.getBoundingClientRect()
    if (rc.width <= 0 || rc.height <= 0) return
    l = Math.min(l, rc.left); r = Math.max(r, rc.right); t = Math.min(t, rc.top); b = Math.max(b, rc.bottom)
  }
  // 量文字本身：SVG 设了 overflow:visible 时，外框不含冲出去的字形。
  // Measure the glyphs themselves: with overflow:visible an SVG's box excludes spilling text.
  el.querySelectorAll('text, span, b, i, em').forEach(take)
  if (l === Infinity) take(el)
  return l === Infinity ? null : new DOMRect(l, t, r - l, b - t)
}

export function fitHero(card: Element | null) {
  if (!card) return
  const box = card.getBoundingClientRect()
  if (box.width <= 0) return
  // 预览外层有 transform: scale()，量到的是缩放后的像素；换算回卡片自身的 CSS 像素。
  // The preview sits under transform: scale(); convert measured pixels back to card CSS px.
  const unit = box.width / 360
  const pad = PAD * unit
  card.querySelectorAll<HTMLElement | SVGGElement>('[data-fit]').forEach((el) => {
    el.style.transform = ''
    el.removeAttribute('transform')
    const u = unionRect(el)
    if (!u) return
    const mode = el.getAttribute('data-fit')
    if (mode === 'center') {
      const k = Math.min(1, (box.width - 2 * pad) / u.width)
      if (k >= 0.999) return
      const ox = Number(el.getAttribute('data-ox') || 180), oy = Number(el.getAttribute('data-oy') || 0)
      el.setAttribute('transform', `translate(${ox} ${oy}) scale(${k.toFixed(4)}) translate(${-ox} ${-oy})`)
    } else {
      const left = Math.min(u.left, el.getBoundingClientRect().left)
      const k = Math.min(1, (box.right - pad - left) / (u.right - left))
      if (k >= 0.999) return
      el.style.transformOrigin = 'left center'
      el.style.transform = `scale(${k.toFixed(4)})`
    }
  })
}
