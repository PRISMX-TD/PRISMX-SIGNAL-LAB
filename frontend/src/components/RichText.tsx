// 公告富文本的渲染件：把库里那段受限 HTML 解析成 React 节点。
//
// 刻意不用 dangerouslySetInnerHTML。这里走 DOMParser 建一棵**惰性文档**（脚本不
// 执行、img 不发请求），再按白名单一个标签一个标签地转成 React 元素——不在白名单
// 里的连同属性一起消失，绝不可能有一个 on* 属性活到真实 DOM 上。入库前后端已经
// 清洗过一遍（services/rich_text.py），这一层是第二道：库里的历史行、别处写进来
// 的行，都不该由渲染侧来赌。
//
// Renders an announcement's stored, restricted HTML as React nodes.
//
// dangerouslySetInnerHTML is deliberately absent. A DOMParser builds an inert
// document (no script execution, no image fetches), and each tag is converted to a
// React element against a whitelist — anything outside it disappears along with
// its attributes, so no on* handler can ever reach the live DOM. The backend
// already cleaned the value on the way in (services/rich_text.py); this is the
// second pass, because rows written earlier or by another path are not something
// the render side should gamble on.
import { createElement, type ReactNode } from 'react'
import { parseRichBody, richClassName, safeRichHref, safeRichSrc } from '../utils/richText'

// 直接落地成同名 React 元素的标签 / tags that become the React element of the same name
const PASSTHROUGH = new Set(['p', 'h2', 'h3', 'blockquote', 'ul', 'ol', 'li', 'strong', 'em', 'u', 's', 'span'])
// 内容为空时要留出一行高度的块——「空行」是管理员真的按了两次回车。
// Blocks that need a line's height when empty: a blank line is an admin pressing
// Enter twice, not an accident.
const KEEP_EMPTY = new Set(['p', 'h2', 'h3', 'blockquote'])

function renderNodes(nodes: ArrayLike<ChildNode>, path: string): ReactNode[] {
  const out: ReactNode[] = []
  Array.from(nodes).forEach((node, i) => {
    const key = `${path}.${i}`
    if (node.nodeType === 3) {
      const text = node.nodeValue || ''
      if (text) out.push(text)
      return
    }
    if (node.nodeType !== 1) return
    const el = node as Element
    const tag = el.tagName.toLowerCase()
    const className = richClassName(el.getAttribute('class') || '') || undefined

    if (tag === 'br') { out.push(<br key={key} />); return }
    if (tag === 'hr') { out.push(<hr key={key} className="ann-rich-rule" />); return }

    if (tag === 'img') {
      const src = safeRichSrc(el.getAttribute('src') || '')
      if (!src) return
      // 尺寸交给 CSS：等比缩到栏宽为止，不裁切、不拉伸。公告里的图常常是整张海报，
      // 切掉下半截等于把活动细则切掉。
      //
      // 刻意不加 loading="lazy"：正文图按原图比例展示，宽高都是 auto，没加载出来
      // 之前盒子是 0×0，浏览器的懒加载观察器永远等不到它"进入视口"——实测图片就这么
      // 一直不加载。一条公告顶多几张图，而且图本身就是内容，直接加载。
      // No loading="lazy" on purpose: body images size themselves from the file, so
      // before one loads its box is 0×0 and the lazy observer never sees it enter
      // the viewport — measured, the image simply never loads. A post carries a
      // handful of images and they are the content, so they load outright.
      out.push(<img key={key} src={src} alt={el.getAttribute('alt') || ''} decoding="async" />)
      return
    }

    if (tag === 'a') {
      const href = safeRichHref(el.getAttribute('href') || '')
      const children = renderNodes(el.childNodes, key)
      if (!href) { out.push(...children); return }
      // 外链一律新开页并断掉 opener：正文里的链接是管理员填的，但页面本身是用户
      // 正在读的东西，不该被一次点击顶替掉。
      // External links always open in a new tab with the opener severed: the URL
      // is admin-authored, but the page under it is what the reader is in the
      // middle of, and one click should not replace it.
      out.push(
        <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">
          {children}
        </a>,
      )
      return
    }

    if (PASSTHROUGH.has(tag)) {
      const children = renderNodes(el.childNodes, key)
      const empty = children.length === 0 || children.every((c) => typeof c === 'string' && !c.trim())
      out.push(createElement(tag, { key, className }, empty && KEEP_EMPTY.has(tag) ? <br /> : children))
      return
    }

    // 白名单外：外壳丢掉，内容留下 / outside the whitelist: drop the shell, keep the content
    out.push(...renderNodes(el.childNodes, key))
  })
  return out
}

export default function RichText({ html, className = 'ann-rich' }: { html: string; className?: string }) {
  const body = parseRichBody(html)
  if (!body) return null
  const nodes = renderNodes(body.childNodes, 'r')
  if (nodes.length === 0) return null
  return <div className={className}>{nodes}</div>
}
