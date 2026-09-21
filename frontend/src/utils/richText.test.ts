// 公告富文本工具的单元测试。
//
// 只覆盖不依赖 DOM 的那一半：这个仓库的 vitest 跑在 node 环境（没装 jsdom），
// normalizeRichHtml / RichText 的解析走的是浏览器的 DOMParser，测不到。真正要守的
// 安全边界在后端（backend/tests/test_announcement_rich_text.py 按同一份白名单逐条
// 验过），这里守的是链接与图片地址的判定、旧内容块的转换、以及"空正文"的判断——
// 后两者直接决定保存时会不会把一条公告存成空白。
//
// Unit tests for the announcement rich-text helpers. Only the DOM-free half is
// covered: vitest runs in the node environment here (no jsdom), so
// normalizeRichHtml and RichText — which go through the browser's DOMParser —
// cannot be exercised. The real security boundary lives on the backend
// (backend/tests/test_announcement_rich_text.py walks the same whitelist); what is
// guarded here is URL adjudication, the legacy-block conversion, and the
// "is the body empty" call that decides whether a save stores a blank post.
import { describe, expect, it } from 'vitest'
import {
  announcementRichBody,
  legacyBlocksToRich,
  plainToRichHtml,
  richBodyForEdit,
  richClassName,
  richIsEmpty,
  safeRichHref,
  safeRichSrc,
} from './richText'

describe('safeRichHref', () => {
  it('accepts http, https and mailto', () => {
    expect(safeRichHref('https://prismxsignallab.com')).toBe('https://prismxsignallab.com')
    expect(safeRichHref('http://a.test/x?y=1')).toBe('http://a.test/x?y=1')
    expect(safeRichHref('mailto:a@b.com')).toBe('mailto:a@b.com')
  })

  it('rejects every other scheme', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x', '/local', '#top', '']) {
      expect(safeRichHref(bad)).toBe('')
    }
  })

  it('strips control characters that would smuggle a scheme through', () => {
    expect(safeRichHref('java\nscript:alert(1)')).toBe('')
    expect(safeRichHref('  https://a.test  ')).toBe('https://a.test')
  })
})

describe('safeRichSrc', () => {
  it('takes http(s) only — no data: URLs', () => {
    expect(safeRichSrc('https://cdn.test/a.png')).toBe('https://cdn.test/a.png')
    expect(safeRichSrc('data:image/svg+xml,<svg onload=alert(1)>')).toBe('')
  })
})

describe('richClassName', () => {
  it('keeps whitelisted classes in written order and drops the rest', () => {
    expect(richClassName('fs-lg made-up ta-center')).toBe('fs-lg ta-center')
    expect(richClassName('ta-center fs-lg')).toBe('ta-center fs-lg')
    expect(richClassName('')).toBe('')
    expect(richClassName('anything')).toBe('')
  })

  it('does not repeat a class written twice', () => {
    expect(richClassName('fs-lg fs-lg')).toBe('fs-lg')
  })
})

describe('plainToRichHtml', () => {
  it('turns each line into a paragraph', () => {
    expect(plainToRichHtml('a\nb')).toBe('<p>a</p><p>b</p>')
  })

  it('keeps a blank line as a blank paragraph', () => {
    // 粘贴进来的空行是作者排的版，不该在落地时被压掉。
    // A blank line in pasted text is the author's typesetting, not slack to remove.
    expect(plainToRichHtml('a\n\nb')).toBe('<p>a</p><p><br></p><p>b</p>')
  })

  it('escapes markup rather than letting it through', () => {
    expect(plainToRichHtml('<script>x</script>')).toBe('<p>&lt;script&gt;x&lt;/script&gt;</p>')
  })

  it('is empty for whitespace only', () => {
    expect(plainToRichHtml('  \n \n')).toBe('')
    expect(plainToRichHtml('')).toBe('')
  })

  it('normalises CRLF', () => {
    expect(plainToRichHtml('a\r\nb')).toBe('<p>a</p><p>b</p>')
  })
})

describe('richIsEmpty', () => {
  it('treats blank paragraphs as empty', () => {
    expect(richIsEmpty('')).toBe(true)
    expect(richIsEmpty('<p></p>')).toBe(true)
    expect(richIsEmpty('<p><br></p><p>   </p>')).toBe(true)
  })

  it('counts text, images and rules as content', () => {
    expect(richIsEmpty('<p>a</p>')).toBe(false)
    expect(richIsEmpty('<img src="https://cdn.test/a.png">')).toBe(false)
    expect(richIsEmpty('<hr>')).toBe(false)
  })
})

describe('legacyBlocksToRich', () => {
  const blocks = [
    { kind: 'heading', textZh: '标题', textEn: 'Heading', imageUrl: '' },
    { kind: 'paragraph', textZh: '第一段\n第二段', textEn: 'One', imageUrl: '' },
    { kind: 'list', textZh: 'a\nb', textEn: '', imageUrl: '' },
    { kind: 'image', textZh: '图注', textEn: '', imageUrl: 'https://cdn.test/a.png' },
  ]

  it('converts each old kind to its rich equivalent', () => {
    const html = legacyBlocksToRich(blocks, 'zh')
    expect(html).toContain('<h2>标题</h2>')
    expect(html).toContain('<p>第一段</p><p>第二段</p>')
    expect(html).toContain('<ul><li>a</li><li>b</li></ul>')
    expect(html).toContain('<img src="https://cdn.test/a.png" alt="图注">')
    expect(html).toContain('<p class="fs-sm c-dim">图注</p>')
  })

  it('skips blocks with nothing in that language', () => {
    const html = legacyBlocksToRich(blocks, 'en')
    expect(html).toContain('<h2>Heading</h2>')
    expect(html).not.toContain('<ul>')
  })

  it('drops an image whose URL is not http(s)', () => {
    expect(legacyBlocksToRich([{ kind: 'image', textZh: '', textEn: '', imageUrl: 'javascript:x' }], 'zh')).toBe('')
  })

  it('escapes text coming out of the old blocks', () => {
    expect(legacyBlocksToRich([{ kind: 'heading', textZh: '<b>x</b>', textEn: '', imageUrl: '' }], 'zh')).toBe(
      '<h2>&lt;b&gt;x&lt;/b&gt;</h2>',
    )
  })
})

describe('announcementRichBody', () => {
  const rich = [{ kind: 'rich', textZh: '<p>中文</p>', textEn: '<p>English</p>', imageUrl: '' }]

  it('reads the rich block for the asked language', () => {
    expect(announcementRichBody(rich, 'zh')).toBe('<p>中文</p>')
    expect(announcementRichBody(rich, 'en')).toBe('<p>English</p>')
  })

  it('falls back to the other language when one side is empty', () => {
    // 空白比串语言更糟，与标题 / 摘要同一个口径。
    // A blank body reads worse than the wrong language — the same call titles make.
    const half = [{ kind: 'rich', textZh: '<p>只有中文</p>', textEn: '', imageUrl: '' }]
    expect(announcementRichBody(half, 'en')).toBe('<p>只有中文</p>')
  })

  it('converts a pre-2026-09-21 announcement on the fly', () => {
    const legacy = [{ kind: 'paragraph', textZh: '旧内容', textEn: '', imageUrl: '' }]
    expect(announcementRichBody(legacy, 'zh')).toBe('<p>旧内容</p>')
    expect(announcementRichBody(legacy, 'en')).toBe('<p>旧内容</p>')
  })

  it('survives a missing body', () => {
    expect(announcementRichBody([], 'zh')).toBe('')
    expect(announcementRichBody(null, 'zh')).toBe('')
  })
})

describe('richBodyForEdit', () => {
  it('shows exactly what that language holds, with no fallback', () => {
    // 后台回落会让管理员以为英文已经填过，保存之后中文被当成英文正文固定下来。
    // A fallback here would read as "English is already written" and freeze the
    // Chinese copy in as the English body on the next save.
    const half = [{ kind: 'rich', textZh: '<p>只有中文</p>', textEn: '', imageUrl: '' }]
    expect(richBodyForEdit(half, 'en')).toBe('')
    expect(richBodyForEdit(half, 'zh')).toBe('<p>只有中文</p>')
  })
})
