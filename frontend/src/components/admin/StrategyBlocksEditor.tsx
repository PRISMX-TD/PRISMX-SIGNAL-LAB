// 详细说明的内容块编辑器：逐块添加、排序、删除，每块可选类型。
//
// 为什么不做富文本编辑器：所见即所得要么产出 HTML（渲染时就得解析，管理员输入
// 成了注入面），要么引入一个编辑器库及其体积。分块把排版限制在四种已知类型内，
// 渲染侧一行标记都不用解析。
//
// 图片块支持直接上传（走后端代理到 Supabase Storage），也允许手填外链——后台没
// 配置存储时上传端点返回 503，手填仍然可用，功能不会整体不可用。
//
// Editor for the long description's content blocks: add, reorder, delete, each
// with a type.
//
// Why not a rich-text editor: WYSIWYG either produces HTML (which then must be
// parsed at render time, making admin input an injection surface) or pulls in an
// editor library and its weight. Blocks keep layout inside four known types, so
// the render side parses no markup at all.
//
// Image blocks accept a direct upload (proxied through the backend to Supabase
// Storage) and also a pasted URL: when storage isn't configured the upload
// endpoint returns 503, and the URL field still works, so the feature never
// becomes wholly unavailable.
import { useTranslation } from 'react-i18next'
import ImageField from './ImageField'
import type { PlatformStrategyBlock, PlatformStrategyBlockKind } from '../../api/types'

const KINDS: PlatformStrategyBlockKind[] = ['heading', 'paragraph', 'list', 'image']

function emptyBlock(kind: PlatformStrategyBlockKind): PlatformStrategyBlock {
  return { kind, textZh: '', textEn: '', imageUrl: '' }
}

export default function StrategyBlocksEditor({
  blocks,
  onChange,
}: {
  blocks: PlatformStrategyBlock[]
  onChange: (next: PlatformStrategyBlock[]) => void
}) {
  const { t } = useTranslation()

  const patch = (i: number, changes: Partial<PlatformStrategyBlock>) => {
    onChange(blocks.map((b, j) => (j === i ? { ...b, ...changes } : b)))
  }

  const add = (kind: PlatformStrategyBlockKind) => {
    onChange([...blocks, emptyBlock(kind)])
  }

  const remove = (i: number) => {
    onChange(blocks.filter((_, j) => j !== i))
  }

  const move = (i: number, delta: number) => {
    const target = i + delta
    if (target < 0 || target >= blocks.length) return
    const next = [...blocks]
    ;[next[i], next[target]] = [next[target], next[i]]
    onChange(next)
  }

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-xs text-slate-400">{t('admin.strategyGuide.blocks')}</span>
        <span className="text-xs text-slate-500">{t('admin.strategyGuide.blocksHint')}</span>
      </div>

      {blocks.length === 0 && (
        <p className="mb-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-4 text-center text-xs text-slate-500">
          {t('admin.strategyGuide.blocksEmpty')}
        </p>
      )}

      <div className="space-y-2">
        {blocks.map((b, i) => (
          <div key={i} className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {/* 类型切换用原生 select：这是密集表单里的一个小控件，
                  自定义下拉在这里只会增加高度和键盘操作成本。
                  A native select for the type: this is one small control in a
                  dense form, and a custom dropdown would only add height and
                  keyboard cost. */}
              <select
                className="input py-1 text-xs"
                value={b.kind}
                onChange={(e) => patch(i, { kind: e.target.value as PlatformStrategyBlockKind })}
                aria-label={t('admin.strategyGuide.blockKind')}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`admin.strategyGuide.kind.${k}`)}
                  </option>
                ))}
              </select>
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                aria-label={t('admin.strategyGuide.moveUp')}
                className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-white/10 disabled:opacity-30"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(i, 1)}
                disabled={i === blocks.length - 1}
                aria-label={t('admin.strategyGuide.moveDown')}
                className="rounded px-2 py-1 text-xs text-slate-400 hover:bg-white/10 disabled:opacity-30"
              >
                ↓
              </button>
              <button
                type="button"
                onClick={() => remove(i)}
                className="rounded px-2 py-1 text-xs text-down hover:bg-down/10"
              >
                {t('admin.strategyGuide.delete')}
              </button>
            </div>

            {b.kind === 'image' && (
              <div className="mb-2">
                <ImageField
                  value={b.imageUrl}
                  onChange={(url) => patch(i, { imageUrl: url })}
                  compact
                />
              </div>
            )}

            <div className="grid gap-2 sm:grid-cols-2">
              {/* 标题是单行，正文和列表是多行；列表每行一条。图片块这里填的是图注。
                  Headings are single-line, body and lists multi-line (one bullet
                  per line). For image blocks this is the caption. */}
              {b.kind === 'heading' ? (
                <>
                  <input
                    className="input w-full py-1.5 text-sm"
                    value={b.textZh}
                    onChange={(e) => patch(i, { textZh: e.target.value })}
                    placeholder={t('admin.strategyGuide.zhPlaceholder')}
                    maxLength={4000}
                  />
                  <input
                    className="input w-full py-1.5 text-sm"
                    value={b.textEn}
                    onChange={(e) => patch(i, { textEn: e.target.value })}
                    placeholder={t('admin.strategyGuide.enPlaceholder')}
                    maxLength={4000}
                  />
                </>
              ) : (
                <>
                  <textarea
                    className="input min-h-[72px] w-full resize-y text-sm"
                    value={b.textZh}
                    onChange={(e) => patch(i, { textZh: e.target.value })}
                    placeholder={
                      b.kind === 'list'
                        ? t('admin.strategyGuide.listPlaceholder')
                        : t('admin.strategyGuide.zhPlaceholder')
                    }
                    maxLength={4000}
                  />
                  <textarea
                    className="input min-h-[72px] w-full resize-y text-sm"
                    value={b.textEn}
                    onChange={(e) => patch(i, { textEn: e.target.value })}
                    placeholder={t('admin.strategyGuide.enPlaceholder')}
                    maxLength={4000}
                  />
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => add(k)}
            className="btn-ghost px-3 py-1 text-xs"
          >
            + {t(`admin.strategyGuide.kind.${k}`)}
          </button>
        ))}
      </div>
    </div>
  )
}
