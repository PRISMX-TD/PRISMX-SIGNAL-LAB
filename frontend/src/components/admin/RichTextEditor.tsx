// 后台的公告正文编辑器：一个所见即所得的框，不再是一串内容块。
//
// 为什么换掉分块编辑：发一条活动公告要点七八次「+ 段落」，而管理员想做的只是
// 在一个框里打字，顺手调字号、加粗、空一行、插张图。分块模型当初是为了让渲染侧
// 不解析任何标记（见 StrategyBlocksEditor 顶部那段说明）——那条约束没有放弃，只是
// 挪到了两端：入库前后端按白名单重建 HTML（services/rich_text.py），渲染时前端按
// 同一份白名单解析成 React 节点（components/RichText.tsx）。全程没有 innerHTML。
//
// 实现上刻意不引编辑器库：整个前端只有 gsap / lightweight-charts 两个体积项，为了
// 一个后台页面再加 100KB+ 的 ProseMirror 不划算。contenteditable + execCommand 是
// 老 API，但它的产物（<font size>、<div>、内联 style）在 utils/richText 里被统一
// 归一成规范 HTML，浏览器之间的差异不会漏到库里。
//
// 光标为什么不跳：这个框是**非受控**的。value 只在 docKey 变化时写回 DOM（切换
// 语言页签、换一条公告），打字过程中只往外吐归一化后的 HTML，从不回写。
//
// The admin's announcement body editor: one WYSIWYG box instead of a block list.
//
// Why blocks went away: publishing one campaign post meant pressing "+ paragraph"
// eight times, when all an admin wants is to type and reach for bold, a size, a
// blank line, an image. The constraint blocks bought — the renderer parses no
// markup (see the note atop StrategyBlocksEditor) — is not abandoned, only moved
// to both ends: the backend rebuilds the HTML against a whitelist before storing
// it (services/rich_text.py) and the client parses it into React nodes against the
// same whitelist (components/RichText.tsx). innerHTML appears nowhere.
//
// No editor library on purpose: the whole frontend carries only gsap and
// lightweight-charts as heavy dependencies, and 100KB+ of ProseMirror for one
// admin page does not pay for itself. contenteditable + execCommand is an old API,
// but what it emits (<font size>, <div>, inline styles) is folded into canonical
// HTML by utils/richText, so browser differences never reach the database.
//
// Why the caret doesn't jump: this box is *uncontrolled*. `value` is written back
// to the DOM only when docKey changes (a language tab, a different announcement);
// while typing it only emits normalised HTML and is never written back.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../api/client'
import { localizeApiError } from '../../api/utils'
import {
  RICH_ALIGN_CLASSES,
  RICH_COLORS,
  RICH_FONT_SIZE_STEPS,
  normalizeRichHtml,
  plainToRichHtml,
  safeRichHref,
} from '../../utils/richText'

type Cmd = 'bold' | 'italic' | 'underline' | 'strikeThrough'

const MARKS: { cmd: Cmd; label: string; key: string; cls: string }[] = [
  { cmd: 'bold', label: 'B', key: 'bold', cls: 'font-bold' },
  { cmd: 'italic', label: 'I', key: 'italic', cls: 'italic font-serif' },
  { cmd: 'underline', label: 'U', key: 'underline', cls: 'underline' },
  { cmd: 'strikeThrough', label: 'S', key: 'strike', cls: 'line-through' },
]

const BLOCK_FORMATS = [
  { tag: 'p', key: 'paragraph' },
  { tag: 'h2', key: 'h2' },
  { tag: 'h3', key: 'h3' },
  { tag: 'blockquote', key: 'quote' },
]

function Icon({ d, size = 15 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

const PATHS = {
  alignLeft: 'M4 6h16M4 12h10M4 18h14',
  alignCenter: 'M4 6h16M7 12h10M5 18h14',
  alignRight: 'M4 6h16M10 12h10M6 18h14',
  bullet: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  numbered: 'M10 6h10M10 12h10M10 18h10M4 6h2M4 6V4M4 12h2v2H4v2h2M4 18h2',
  rule: 'M3 12h18',
  link: 'M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1',
  image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6',
  clear: 'M6 6l12 12M18 6L6 18',
}

export default function RichTextEditor({
  value,
  docKey,
  onChange,
  placeholder,
}: {
  value: string
  /** 换文档的信号：变了就把 value 写回 DOM，不变就绝不碰（不然光标每打一个字就回到开头）。
   *  The "different document" signal: on a change `value` is written back to the
   *  DOM, otherwise the DOM is left alone — writing back mid-typing sends the caret
   *  to the start on every keystroke. */
  docKey: string
  onChange: (html: string) => void
  placeholder?: string
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const savedRange = useRef<Range | null>(null)
  const emitted = useRef('')
  const [empty, setEmpty] = useState(true)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // 空文档也要有一个 <p>：往真正空的 contenteditable 里打字，浏览器落下的是一个
    // 裸文本节点而不是段落，之后「居中」「清除格式」这些按块生效的控件就找不到块，
    // 按下去毫无反应。先垫一段，第一行字就落在段落里。
    // An empty document still gets a <p>: typing into a truly empty contenteditable
    // leaves a bare text node rather than a paragraph, and the controls that act per
    // block (align, clear formatting) then find nothing to act on and do nothing when
    // pressed. Seeding one paragraph puts the first line inside a block.
    el.innerHTML = value || '<p><br></p>'
    emitted.current = value || ''
    setEmpty(!el.textContent?.trim() && !el.querySelector('img,hr'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey])

  // 让 execCommand 产出标签而不是内联 style：<b> 比 <span style="font-weight:700">
  // 好归一，也让"清除格式"真的清得掉。两个开关是文档级的，浏览器在某些操作后会
  // 重置，所以每次聚焦都重设一遍。
  // Make execCommand emit tags rather than inline styles: <b> normalises better
  // than <span style="font-weight:700">, and it makes "clear formatting" actually
  // clear. Both switches are document-level and some browsers reset them, so they
  // are re-applied on every focus.
  const setupCommands = () => {
    try {
      document.execCommand('styleWithCSS', false, 'false')
      document.execCommand('defaultParagraphSeparator', false, 'p')
    } catch {
      /* 老浏览器不认这两个开关，归一化照样兜得住 / older browsers ignore these; normalisation still catches it */
    }
  }

  const emit = () => {
    const el = ref.current
    if (!el) return
    setEmpty(!el.textContent?.trim() && !el.querySelector('img,hr'))
    const html = normalizeRichHtml(el.innerHTML)
    if (html === emitted.current) return
    emitted.current = html
    onChange(html)
  }

  const focusBack = () => {
    const el = ref.current
    if (!el) return
    el.focus()
    if (savedRange.current) {
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(savedRange.current)
    }
  }

  const rememberSelection = () => {
    const sel = window.getSelection()
    const el = ref.current
    if (!sel || sel.rangeCount === 0 || !el) return
    const range = sel.getRangeAt(0)
    if (el.contains(range.commonAncestorContainer)) savedRange.current = range.cloneRange()
  }

  const exec = (cmd: string, arg?: string) => {
    focusBack()
    setupCommands()
    try {
      document.execCommand(cmd, false, arg)
    } catch {
      /* 命令不被支持就当没按 / an unsupported command is a no-op */
    }
    rememberSelection()
    emit()
  }

  /** 根一级的裸文本收进段落。浏览器在某些编辑动作后会把文字留在根上（粘贴、
   *  全选删除之后重新打字），按块生效的控件因此会落空。
   *  Fold bare root-level text into a paragraph. Browsers leave text at the root
   *  after some edits (a paste, retyping after select-all-delete), which is exactly
   *  when the per-block controls would otherwise find nothing. */
  const ensureBlocks = () => {
    const el = ref.current
    if (!el) return
    if (!el.firstChild) { el.innerHTML = '<p><br></p>'; return }
    const bare = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.nodeValue || '').trim())
    if (bare) {
      focusBack()
      try { document.execCommand('formatBlock', false, '<p>') } catch { /* 不支持就维持原样 / leave as is */ }
    }
  }

  /** 选区覆盖到的顶层块。工具栏里按块生效的那几个（对齐、清除块格式）用它。
   *  The top-level blocks the selection touches, for the per-block controls
   *  (alignment, clearing block formatting). */
  const selectedBlocks = (): HTMLElement[] => {
    const el = ref.current
    if (!el) return []
    const sel = window.getSelection()
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : savedRange.current
    const blocks = Array.from(el.children) as HTMLElement[]
    if (!range) return blocks.slice(0, 1)
    const hit = blocks.filter((b) => range.intersectsNode(b))
    return hit.length > 0 ? hit : blocks.slice(0, 1)
  }

  const applyAlign = (cls: string) => {
    focusBack()
    ensureBlocks()
    for (const block of selectedBlocks()) {
      // 列表的对齐落在条目上：ul 本身没有文字，把 class 挂在它身上是挂给一个空壳。
      // A list aligns on its items: the ul itself holds no text, so the class would
      // sit on an empty shell.
      const targets = block.tagName === 'UL' || block.tagName === 'OL'
        ? (Array.from(block.children) as HTMLElement[])
        : [block]
      for (const el of targets) {
        for (const c of RICH_ALIGN_CLASSES) el.classList.remove(c)
        if (cls) el.classList.add(cls)
      }
    }
    emit()
  }

  const clearFormatting = () => {
    exec('removeFormat')
    focusBack()
    ensureBlocks()
    for (const block of selectedBlocks()) {
      block.removeAttribute('class')
      for (const child of Array.from(block.querySelectorAll('[class]'))) child.removeAttribute('class')
    }
    exec('formatBlock', '<p>')
  }

  const applyLink = () => {
    const href = safeRichHref(linkUrl.trim())
    setLinkOpen(false)
    setLinkUrl('')
    if (!href) return
    exec('createLink', href)
  }

  const insertImage = async (file: File) => {
    setError(null)
    setUploading(true)
    try {
      const res = await adminApi.uploadImage(file)
      exec('insertImage', res.url)
    } catch (err) {
      setError(localizeApiError(err instanceof Error ? err.message : String(err)))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  // 粘贴一律转成纯文本再按行分段。从 Word / 网页复制过来的 HTML 带着一整套外部
  // 样式与结构，归一化能挡住危险的部分，但挡不住它把版面搅成另一副样子。
  // Paste always comes in as plain text, split into paragraphs by line. HTML copied
  // from Word or a web page drags a whole foreign stylesheet and structure with it;
  // normalisation stops the dangerous parts but not the ransacked layout.
  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    if (!text) return
    const html = plainToRichHtml(text)
    focusBack()
    setupCommands()
    try {
      document.execCommand('insertHTML', false, html || text)
    } catch {
      document.execCommand('insertText', false, text)
    }
    emit()
  }

  const btn = 'rte-btn'
  const hold = (fn: () => void) => ({
    // mousedown 上 preventDefault：不拦的话点按钮会先把选区清掉，命令就作用在空处。
    // preventDefault on mousedown: without it the click clears the selection first
    // and the command lands on nothing.
    onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); rememberSelection() },
    onClick: (e: React.MouseEvent) => { e.preventDefault(); fn() },
  })

  return (
    <div className="rte">
      <div className="rte-bar" role="toolbar" aria-label={t('admin.announcements.editor.toolbar')}>
        <select
          className="rte-select"
          aria-label={t('admin.announcements.editor.style')}
          defaultValue="p"
          onMouseDown={rememberSelection}
          onChange={(e) => { exec('formatBlock', `<${e.target.value}>`); e.currentTarget.value = 'p' }}
        >
          <option value="p" disabled>{t('admin.announcements.editor.style')}</option>
          {BLOCK_FORMATS.map((f) => (
            <option key={f.tag} value={f.tag}>{t(`admin.announcements.editor.${f.key}`)}</option>
          ))}
        </select>

        <select
          className="rte-select"
          aria-label={t('admin.announcements.editor.size')}
          defaultValue=""
          onMouseDown={rememberSelection}
          onChange={(e) => { exec('fontSize', e.target.value); e.currentTarget.value = '' }}
        >
          <option value="" disabled>{t('admin.announcements.editor.size')}</option>
          {RICH_FONT_SIZE_STEPS.map((s, i) => (
            <option key={s.step} value={s.step}>
              {t(['sizeSm', 'sizeMd', 'sizeLg', 'sizeXl'].map((k) => `admin.announcements.editor.${k}`)[i])}
            </option>
          ))}
        </select>

        <span className="rte-sep" />

        {MARKS.map((m) => (
          <button key={m.cmd} type="button" className={`${btn} ${m.cls}`} title={t(`admin.announcements.editor.${m.key}`)} aria-label={t(`admin.announcements.editor.${m.key}`)} {...hold(() => exec(m.cmd))}>
            {m.label}
          </button>
        ))}

        <span className="rte-sep" />

        <div className="rte-colors" role="group" aria-label={t('admin.announcements.editor.color')}>
          {RICH_COLORS.map((c) => (
            <button
              key={c.cls}
              type="button"
              className="rte-swatch"
              style={{ background: c.hex }}
              title={t(`admin.announcements.editor.color_${c.cls.slice(2)}`)}
              aria-label={t(`admin.announcements.editor.color_${c.cls.slice(2)}`)}
              {...hold(() => exec('foreColor', c.hex))}
            />
          ))}
        </div>

        <span className="rte-sep" />

        <button type="button" className={btn} title={t('admin.announcements.editor.alignLeft')} aria-label={t('admin.announcements.editor.alignLeft')} {...hold(() => applyAlign(''))}>
          <Icon d={PATHS.alignLeft} />
        </button>
        <button type="button" className={btn} title={t('admin.announcements.editor.alignCenter')} aria-label={t('admin.announcements.editor.alignCenter')} {...hold(() => applyAlign('ta-center'))}>
          <Icon d={PATHS.alignCenter} />
        </button>
        <button type="button" className={btn} title={t('admin.announcements.editor.alignRight')} aria-label={t('admin.announcements.editor.alignRight')} {...hold(() => applyAlign('ta-right'))}>
          <Icon d={PATHS.alignRight} />
        </button>

        <span className="rte-sep" />

        <button type="button" className={btn} title={t('admin.announcements.editor.bullet')} aria-label={t('admin.announcements.editor.bullet')} {...hold(() => exec('insertUnorderedList'))}>
          <Icon d={PATHS.bullet} />
        </button>
        <button type="button" className={btn} title={t('admin.announcements.editor.numbered')} aria-label={t('admin.announcements.editor.numbered')} {...hold(() => exec('insertOrderedList'))}>
          <Icon d={PATHS.numbered} />
        </button>
        <button type="button" className={btn} title={t('admin.announcements.editor.rule')} aria-label={t('admin.announcements.editor.rule')} {...hold(() => exec('insertHorizontalRule'))}>
          <Icon d={PATHS.rule} />
        </button>

        <span className="rte-sep" />

        <button type="button" className={btn} title={t('admin.announcements.editor.link')} aria-label={t('admin.announcements.editor.link')} {...hold(() => { setLinkOpen((v) => !v); setError(null) })}>
          <Icon d={PATHS.link} />
        </button>
        <button type="button" className={btn} disabled={uploading} title={t('admin.announcements.editor.image')} aria-label={t('admin.announcements.editor.image')} {...hold(() => fileRef.current?.click())}>
          {uploading ? <span className="rte-spin" /> : <Icon d={PATHS.image} />}
        </button>
        <button type="button" className={btn} title={t('admin.announcements.editor.clear')} aria-label={t('admin.announcements.editor.clear')} {...hold(clearFormatting)}>
          <Icon d={PATHS.clear} size={13} />
        </button>

        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void insertImage(f) }}
        />
      </div>

      {linkOpen && (
        <div className="rte-link">
          <input
            className="input min-w-0 flex-1 py-1 text-xs"
            value={linkUrl}
            autoFocus
            placeholder={t('admin.announcements.editor.linkUrl')}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyLink() } if (e.key === 'Escape') setLinkOpen(false) }}
          />
          <button type="button" className="btn-ghost px-3 py-1 text-xs" onMouseDown={(e) => e.preventDefault()} onClick={applyLink}>
            {t('admin.announcements.editor.linkApply')}
          </button>
          <button type="button" className="btn-ghost px-3 py-1 text-xs" onMouseDown={(e) => e.preventDefault()} onClick={() => exec('unlink')}>
            {t('admin.announcements.editor.unlink')}
          </button>
        </div>
      )}

      <div className="rte-shell">
        {empty && placeholder && <span className="rte-ph" aria-hidden="true">{placeholder}</span>}
        <div
          ref={ref}
          className="ann-rich rte-input"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={t('admin.announcements.body')}
          spellCheck={false}
          onFocus={setupCommands}
          onInput={emit}
          onBlur={() => { rememberSelection(); emit() }}
          onKeyUp={rememberSelection}
          onMouseUp={rememberSelection}
          onPaste={onPaste}
        />
      </div>

      {error && <p className="mt-1 text-xs text-down">{error}</p>}
    </div>
  )
}
