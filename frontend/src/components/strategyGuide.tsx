// 平台策略介绍的共享渲染件：列表卡片与详情页都用这里的取值与块渲染逻辑。
// Shared rendering pieces for platform strategy write-ups, used by both the list
// cards and the detail page.
import type { PlatformStrategy, PlatformStrategyBlock } from '../api/types'
import { safeHttpUrl } from '../utils/safeUrl'

// 按当前界面语言取字段，缺失时回落到另一种语言——管理员可能只填了一种，
// 空白比串语言更糟。/ Pick the field for the current UI language, falling back to
// the other one: an admin may have filled in only one, and a blank reads worse
// than the wrong language.
export function pick(zh: string, en: string, isZh: boolean): string {
  const primary = isZh ? zh : en
  const fallback = isZh ? en : zh
  return (primary || '').trim() || (fallback || '').trim()
}

// 内容块渲染。全部走纯文本节点，不解析 HTML 或 Markdown——管理员输入不应该能
// 变成可执行标记。列表块按换行切分成条目。
// Renders the content blocks. Everything goes through plain text nodes; no HTML
// or Markdown is parsed, so admin input can never become executable markup. List
// blocks split on newlines.
export function StrategyBlocks({ blocks, isZh }: { blocks: PlatformStrategyBlock[]; isZh: boolean }) {
  return (
    <>
      {blocks.map((b, i) => {
        const text = pick(b.textZh, b.textEn, isZh)
        // 图片块允许没有图注，其余类型没文字就等于空块，跳过不占版面
        // Image blocks may have no caption; other kinds with no text are empty
        // blocks and are skipped rather than leaving a gap
        if (!text && !(b.kind === 'image' && b.imageUrl)) return null

        if (b.kind === 'heading') {
          return (
            <h2 key={i} className="mt-7 font-display text-lg font-bold text-neutral-100 first:mt-0">
              {text}
            </h2>
          )
        }

        if (b.kind === 'list') {
          const rows = text
            .split('\n')
            .map((r) => r.trim())
            .filter(Boolean)
          return (
            <ul key={i} className="mt-3 space-y-1.5">
              {rows.map((r, j) => (
                <li key={j} className="flex gap-2.5 text-sm leading-relaxed text-neutral-300">
                  <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-prism-400" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          )
        }

        if (b.kind === 'image') {
          return (
            <figure key={i} className="mt-5">
              {safeHttpUrl(b.imageUrl) && (
                <img
                  src={safeHttpUrl(b.imageUrl)}
                  alt={text}
                  loading="lazy"
                  className="mx-auto max-h-96 w-auto max-w-full rounded-xl border border-white/10"
                />
              )}
              {text && <figcaption className="mt-2 text-xs text-neutral-500">{text}</figcaption>}
            </figure>
          )
        }

        return (
          <p key={i} className="mt-3 text-sm leading-relaxed text-neutral-300">
            {text}
          </p>
        )
      })}
    </>
  )
}

// 详细说明的渲染入口。blocks 为空时回落到第一版的单段纯文本字段，避免早先录入的
// 内容在升级后凭空消失。/ Entry point for the long description. Falls back to the
// first version's single-blob fields when blocks is empty, so copy entered before
// the upgrade doesn't silently vanish.
export function StrategyDetail({ strategy, isZh }: { strategy: PlatformStrategy; isZh: boolean }) {
  const blocks = strategy.blocks ?? []
  if (blocks.length > 0) return <StrategyBlocks blocks={blocks} isZh={isZh} />

  const legacy = pick(strategy.detailZh, strategy.detailEn, isZh)
  if (!legacy) return null
  return (
    <p className="whitespace-pre-line text-sm leading-relaxed text-neutral-300">{legacy}</p>
  )
}
