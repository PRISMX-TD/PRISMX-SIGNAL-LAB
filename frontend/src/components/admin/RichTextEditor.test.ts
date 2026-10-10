// 公告编辑器写进 contentEditable 之前的那份 HTML（editorSeedHtml）必须先过白名单。
//
// vitest 跑在 node 环境、没有 jsdom，DOMParser 不存在。这里垫一个只够用的极简
// DOMParser（标签 / 属性 / 文本三样），让 normalizeRichHtml 走真实的归一化路径；
// 另一条用例在没有解析器时验证"宁可空文档、不回落原串"。
//
// What the announcement editor writes into its contentEditable (editorSeedHtml) must be
// whitelisted first. vitest runs in node without jsdom, so a minimal DOMParser (tags,
// attributes, text) is stubbed in to drive the real normalisation path; another case
// checks that without a parser it fails closed to an empty document.
import { afterEach, describe, expect, it, vi } from 'vitest'

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr'])

function decode(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

class FakeText {
  nodeType = 3
  constructor(public nodeValue: string) {}
}

class FakeEl {
  nodeType = 1
  childNodes: (FakeEl | FakeText)[] = []
  tagName: string
  attrs: Record<string, string>
  classList: { contains: (c: string) => boolean }
  constructor(tag: string, attrs: Record<string, string>) {
    this.tagName = tag.toUpperCase()
    this.attrs = attrs
    this.classList = { contains: (c: string) => (this.attrs.class || '').split(/\s+/).includes(c) }
  }
  get children(): FakeEl[] {
    return this.childNodes.filter((n): n is FakeEl => n instanceof FakeEl)
  }
  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null
  }
}

class FakeDOMParser {
  parseFromString(src: string): { body: FakeEl } {
    const html = src.replace(/^<body>/, '').replace(/<\/body>$/, '')
    const root = new FakeEl('body', {})
    const stack: FakeEl[] = [root]
    const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(html))) {
      if (m[1]) {
        const tag = m[1].toUpperCase()
        const i = stack.map((e) => e.tagName).lastIndexOf(tag)
        if (i > 0) stack.length = i
      } else if (m[2]) {
        const attrs: Record<string, string> = {}
        const ar = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
        let a: RegExpExecArray | null
        while ((a = ar.exec(m[3]))) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '')
        const el = new FakeEl(m[2], attrs)
        stack[stack.length - 1].childNodes.push(el)
        if (!VOID.has(m[2].toLowerCase()) && !m[3].trim().endsWith('/')) stack.push(el)
      } else if (m[4]) {
        stack[stack.length - 1].childNodes.push(new FakeText(decode(m[4])))
      }
    }
    return { body: root }
  }
}

async function loadWithParser() {
  vi.resetModules()
  vi.stubGlobal('DOMParser', FakeDOMParser)
  return import('./RichTextEditor')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('editorSeedHtml', () => {
  it('<img src=x onerror=...> 进不了编辑框 / an onerror image never reaches the editor', async () => {
    const { editorSeedHtml } = await loadWithParser()
    const out = editorSeedHtml('<p>hi</p><img src=x onerror=alert(1)>')
    expect(out).not.toMatch(/onerror/i)
    expect(out).not.toMatch(/<img/i)
    expect(out).toContain('<p>hi</p>')
  })

  it('合法图片留下、事件属性剥掉 / a valid image stays, its handlers go', async () => {
    const { editorSeedHtml } = await loadWithParser()
    const out = editorSeedHtml('<img src="https://cdn.example/a.png" onload="steal()" onerror=alert(1)>')
    expect(out).toBe('<img src="https://cdn.example/a.png">')
  })

  it('脚本、事件、危险链接都不留 / scripts, handlers and bad links are stripped', async () => {
    const { editorSeedHtml } = await loadWithParser()
    const out = editorSeedHtml(
      '<p onclick="x()">a<script>alert(1)</script><a href="javascript:alert(1)">b</a></p><svg onload=alert(1)></svg>',
    )
    expect(out).toBe('<p>ab</p>')
  })

  it('空值给一个空段落 / empty input seeds one blank paragraph', async () => {
    const { editorSeedHtml } = await loadWithParser()
    expect(editorSeedHtml('')).toBe('<p><br></p>')
    expect(editorSeedHtml('<script>alert(1)</script>')).toBe('<p><br></p>')
  })

  it('没有解析器时不回落原串 / without a parser it fails closed', async () => {
    vi.resetModules()
    const { editorSeedHtml } = await import('./RichTextEditor')
    expect(editorSeedHtml('<img src=x onerror=alert(1)>')).toBe('<p><br></p>')
  })
})
