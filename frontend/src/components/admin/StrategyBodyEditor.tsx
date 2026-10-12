// 策略介绍「详细说明」的编辑器：一个富文本框，中英文分页签填写。
//
// 2026-10-12 按管理员要求换掉了逐块添加（小标题 / 段落 / 要点 / 图片各点一次「+」）：
// 实际写法是把整篇说明一次粘贴进来，再选中某几行改成标题、列表、加粗。公告那边
// 2026-09-21 已经走过同一条路，这里直接复用同一个框（RichTextEditor）与同一份白名单
// ——入库前后端清洗（services/rich_text.py），渲染时前端按白名单解析（components/RichText）。
//
// 存法：blocks 里只放一块 kind: 'rich'，textZh / textEn 各一段 HTML，与公告一致，
// 后端不用加列。旧的四种块型照样能读：打开时 richBodyForEdit 把它们现转成富文本放进框里，
// 管理员不改就原样不动；改一个字，这条就整体并成一块 rich。
//
// 粘贴一律按纯文本进来、每行一段（见 RichTextEditor 的 onPaste）：从 Word / 网页带进来的
// 样式会把版面搅乱，排版靠粘贴之后选中再改。
//
// Editor for a strategy write-up's long description: one rich-text box, one
// language tab at a time.
//
// Replaced the per-block editor on 2026-10-12 at the admin's request: the real
// workflow is pasting the whole write-up at once and then restyling a few lines as
// headings, lists or bold. Announcements took the same road on 2026-09-21, so this
// reuses that box (RichTextEditor) and its whitelist — cleaned by the backend before
// storage (services/rich_text.py) and parsed against the same list when rendered
// (components/RichText).
//
// Storage: a single kind: 'rich' block holding one HTML string per language, the
// same as announcements, so no new columns. The four legacy kinds still read:
// richBodyForEdit converts them into the box on open, they stay untouched if the
// admin changes nothing, and any edit collapses the entry into one rich block.
//
// Paste always arrives as plain text, one paragraph per line (RichTextEditor's
// onPaste): styles dragged in from Word or a web page would wreck the layout, so
// formatting happens after pasting, by selecting and restyling.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import RichTextEditor from './RichTextEditor'
import type { PlatformStrategyBlock } from '../../api/types'
import { richBodyForEdit, richIsEmpty } from '../../utils/richText'

type Lang = 'zh' | 'en'

export default function StrategyBodyEditor({
  strategyId,
  blocks,
  onChange,
}: {
  strategyId: string
  blocks: PlatformStrategyBlock[]
  onChange: (next: PlatformStrategyBlock[]) => void
}) {
  const { t } = useTranslation()
  const [lang, setLang] = useState<Lang>('zh')

  const write = (html: string) => {
    const zh = lang === 'zh' ? html : richBodyForEdit(blocks, 'zh')
    const en = lang === 'en' ? html : richBodyForEdit(blocks, 'en')
    // 两种语言都空了就存空数组：详情页按「没有说明」处理，而不是渲染一块空白。
    // Both languages empty means no blocks at all, so the page shows no section
    // rather than an empty block.
    onChange(richIsEmpty(zh) && richIsEmpty(en) ? [] : [{ kind: 'rich', textZh: zh, textEn: en, imageUrl: '' }])
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <span className="text-xs text-neutral-400">{t('admin.strategyGuide.blocks')}</span>
        <div className="seg-tabs" role="radiogroup" aria-label={t('admin.strategyGuide.bodyLanguage')}>
          {(['zh', 'en'] as Lang[]).map((l) => (
            <button
              key={l}
              type="button"
              role="radio"
              aria-checked={lang === l}
              className={lang === l ? 'on' : ''}
              onClick={() => setLang(l)}
            >
              {t(`admin.strategyGuide.lang_${l}`)}
            </button>
          ))}
        </div>
        <span className="text-xs text-neutral-500">{t('admin.strategyGuide.bodyHint')}</span>
      </div>
      <RichTextEditor
        docKey={`${strategyId}:${lang}`}
        value={richBodyForEdit(blocks, lang)}
        onChange={write}
        placeholder={t('admin.strategyGuide.bodyPlaceholder')}
      />
    </div>
  )
}
