// 管理后台：公告编辑器。列表 + 单条编辑，逐条 POST / PUT / DELETE（与策略介绍的
// 整表覆盖不同：公告会越攒越多，且发布是一次性的副作用——广播、可选推送——
// 必须知道是哪一条刚被翻成发布）。
//
// 2026-09-21 重做：正文从「内容块」换成一个所见即所得的框（RichTextEditor），同时
// 把中英文从并排的四个输入框改成一个语言页签——一次只看一种语言的标题、摘要、正文。
// 并排填双语看着"信息齐全"，实际是让人在两列之间来回跳着写一段话。
//
// 一键翻译：把当前语言的标题、摘要与正文里每一块的纯文字打包送到
// /admin/announcements/translate，按位置填回另一种语言。正文只保留块级格式（标题、
// 字号、对齐、列表、图片）——段内加粗的位置在译文里对不上原词。
//
// Admin: the announcement editor. List plus one-at-a-time editing with per-item
// POST / PUT / DELETE (unlike the strategy guide's whole-list save: this list grows
// unbounded, and publishing has one-shot side effects — broadcast, optional push —
// so the backend must know which row just flipped).
//
// Reworked 2026-09-21: the body is one WYSIWYG box (RichTextEditor) instead of a
// block list, and the two languages moved from four side-by-side inputs to a
// language tab — one language's title, summary and body at a time. Side-by-side
// looks complete but in practice makes someone write one paragraph while hopping
// between two columns.
//
// One-click translate packs the current language's title, summary and the body's
// per-block plain text into one request and writes the result into the other
// language by position. Only block-level formatting survives in the body (heading,
// size, alignment, lists, images): an inline bold no longer covers the same words
// once they are translated.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Switch from '../Switch'
import ConfirmModal from '../ConfirmModal'
import { useToast } from '../../utils/useToast'
import { adminApi } from '../../api/client'
import { fmtDay, localizeApiError } from '../../api/utils'
import { richBlockTexts, richBodyForEdit, richIsEmpty, richWithTexts } from '../../utils/richText'
import ImageField from './ImageField'
import RichTextEditor from './RichTextEditor'
import type { Announcement, AnnouncementInput } from '../../api/types'

function errText(err: unknown): string {
  return localizeApiError(err instanceof Error ? err.message : String(err))
}

type Lang = 'zh' | 'en'

// 草稿里正文是两段富文本，保存时才合成 blocks 的那一块 rich——编辑过程中反复
// 拆装一个只有一个元素的数组没有意义。
// The draft keeps the body as two rich strings and assembles the single rich block
// at save time; packing and unpacking a one-element array on every keystroke buys
// nothing.
type Draft = Omit<AnnouncementInput, 'blocks'> & {
  id: string | null
  bodyZh: string
  bodyEn: string
  // 正文被**程序**改写过的次数（翻译填回）。编辑框是非受控的，只有这个数变了
  // 才会把 value 重新写回 DOM。/ How many times the body was rewritten *by code*
  // (a translation). The box is uncontrolled and only re-reads `value` when this
  // changes.
  bodyRev: number
}

function emptyDraft(): Draft {
  return {
    id: null,
    titleZh: '', titleEn: '', summaryZh: '', summaryEn: '',
    bodyZh: '', bodyEn: '', bodyRev: 0,
    coverImageUrl: '', pinned: false, published: false, notify: false, popup: false,
  }
}

function toDraft(a: Announcement): Draft {
  return {
    id: a.id,
    titleZh: a.titleZh, titleEn: a.titleEn, summaryZh: a.summaryZh, summaryEn: a.summaryEn,
    bodyZh: richBodyForEdit(a.blocks, 'zh'), bodyEn: richBodyForEdit(a.blocks, 'en'), bodyRev: 0,
    coverImageUrl: a.coverImageUrl, pinned: a.pinned, published: a.published, notify: false,
    popup: a.popup,
  }
}

function Field({ label, value, onChange, placeholder, maxLength }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; maxLength?: number
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-neutral-400">{label}</span>
      <input className="input w-full py-1.5 text-sm" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} maxLength={maxLength} />
    </label>
  )
}

export default function AnnouncementsPanel() {
  const { t } = useTranslation()
  const [items, setItems] = useState<Announcement[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Announcement | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [translateOk, setTranslateOk] = useState<boolean | null>(null)
  const [translating, setTranslating] = useState(false)
  const [pendingTranslate, setPendingTranslate] = useState<Lang | null>(null)
  const [lang, setLang] = useState<Lang>('zh')
  const { toast, showToast } = useToast()

  const load = () =>
    adminApi
      .listAnnouncements()
      .then((res) => setItems(res.items))
      .catch((err) => showToast('err', errText(err)))
      .finally(() => setLoading(false))

  useEffect(() => {
    load()
    adminApi.translateStatus().then((r) => setTranslateOk(r.configured)).catch(() => setTranslateOk(false))
  }, [])

  const patch = (changes: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...changes } : d))

  const save = async () => {
    if (!draft) return
    if (draft.published && !draft.titleZh.trim() && !draft.titleEn.trim()) {
      showToast('err', t('admin.announcements.needTitle'))
      return
    }
    setSaving(true)
    try {
      const { id, bodyZh, bodyEn, bodyRev: _rev, ...rest } = draft
      // 正文两种语言都空就不留块：库里存一个空的 rich 块，详情页要多判一次"这块
      // 其实没内容"。/ No block when both languages are empty: storing an empty
      // rich block only makes the detail page check for "a block with nothing in
      // it" one more time.
      const bodyEmpty = richIsEmpty(bodyZh) && richIsEmpty(bodyEn)
      const payload: AnnouncementInput = {
        ...rest,
        blocks: bodyEmpty ? [] : [{ kind: 'rich', textZh: bodyZh, textEn: bodyEn, imageUrl: '' }],
      }
      if (id) await adminApi.updateAnnouncement(id, payload)
      else await adminApi.createAnnouncement(payload)
      showToast('ok', t('admin.announcements.saved'))
      setDraft(null)
      await load()
    } catch (err) {
      showToast('err', errText(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await adminApi.deleteAnnouncement(deleteTarget.id)
      if (draft?.id === deleteTarget.id) setDraft(null)
      setDeleteTarget(null)
      await load()
    } catch (err) {
      showToast('err', errText(err))
    } finally {
      setDeleting(false)
    }
  }

  // 翻译：源语言 → 目标语言。标题 / 摘要 / 正文每一块的纯文字打成一个数组按位置
  // 对应；正文用译文重建同一套块结构（见 utils/richText.richWithTexts）。
  // 接口一次最多 80 段，超了就分批——公告正文长起来一页十几段很常见。
  // Translate source → target: title, summary and each body block's plain text as
  // one positional array, with the body rebuilt on the same block structure (see
  // utils/richText.richWithTexts). The endpoint takes 80 strings at a time, so
  // longer bodies go in chunks — a dozen-odd blocks is an ordinary post.
  const translateAll = async (texts: string[], target: Lang): Promise<string[]> => {
    const out: string[] = []
    for (let i = 0; i < texts.length; i += 80) {
      const res = await adminApi.translate(texts.slice(i, i + 80), target)
      out.push(...res.texts)
    }
    return out
  }

  const runTranslate = async (target: Lang) => {
    if (!draft) return
    setPendingTranslate(null)
    const srcBody = target === 'en' ? draft.bodyZh : draft.bodyEn
    const src = target === 'en'
      ? [draft.titleZh, draft.summaryZh, ...richBlockTexts(srcBody)]
      : [draft.titleEn, draft.summaryEn, ...richBlockTexts(srcBody)]
    setTranslating(true)
    try {
      const texts = await translateAll(src, target)
      const [title, summary, ...rest] = texts
      const body = richWithTexts(srcBody, rest)
      if (target === 'en') patch({ titleEn: title, summaryEn: summary, bodyEn: body, bodyRev: draft.bodyRev + 1 })
      else patch({ titleZh: title, summaryZh: summary, bodyZh: body, bodyRev: draft.bodyRev + 1 })
      // 译完直接切到那一边：填了看不见等于没填，管理员还得自己想起来点页签。
      // Switch to that side once it lands: filling a tab nobody is looking at reads
      // as nothing happening, and leaves the admin to remember to go check.
      setLang(target)
      showToast('ok', t('admin.announcements.translateDone'))
    } catch (err) {
      showToast('err', errText(err))
    } finally {
      setTranslating(false)
    }
  }

  const askTranslate = (target: Lang) => {
    if (!draft) return
    const targetHasText = target === 'en'
      ? !!(draft.titleEn.trim() || draft.summaryEn.trim() || !richIsEmpty(draft.bodyEn))
      : !!(draft.titleZh.trim() || draft.summaryZh.trim() || !richIsEmpty(draft.bodyZh))
    if (targetHasText) setPendingTranslate(target)
    else void runTranslate(target)
  }

  if (loading) {
    return (
      <div className="glass flex items-center justify-center py-16">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-prism-600/30 border-t-prism-500" />
      </div>
    )
  }

  const translateBtn = 'btn-ghost px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <div>
      {toast && (
        <div className={`mb-4 rounded-lg border px-4 py-2.5 text-sm ${toast.kind === 'err' ? 'border-down/40 bg-down/15 text-down' : 'border-up/40 bg-up/15 text-up'}`}>
          {toast.text}
        </div>
      )}

      <div className="glass mb-4 p-4">
        <p className="text-sm text-neutral-400">{t('admin.announcements.hint')}</p>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setDraft(emptyDraft())} disabled={!!draft && !draft.id} className="btn-primary px-4 py-1.5 text-sm disabled:opacity-40">
          + {t('admin.announcements.add')}
        </button>
        <span className="text-xs text-neutral-500">{items.length} {t('announcements.countUnit')}</span>
      </div>

      {draft && (
        <div className="glass mb-4 p-4">
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <h3 className="flex-1 font-display text-base font-semibold text-neutral-100">
              {draft.id ? t('admin.announcements.editing') : t('admin.announcements.creating')}
            </h3>
            <button type="button" onClick={() => askTranslate('en')} disabled={!translateOk || translating} title={translateOk === false ? t('admin.announcements.translateNotConfigured') : undefined} className={translateBtn}>
              {translating ? t('admin.announcements.translating') : t('admin.announcements.translateToEn')}
            </button>
            <button type="button" onClick={() => askTranslate('zh')} disabled={!translateOk || translating} title={translateOk === false ? t('admin.announcements.translateNotConfigured') : undefined} className={translateBtn}>
              {t('admin.announcements.translateToZh')}
            </button>
          </div>
          {translateOk === false && <p className="mb-3 text-xs text-amber-300">{t('admin.announcements.translateNotConfigured')}</p>}

          {/* 语言页签：标题、摘要、正文一起换。并排双语看着齐全，写的时候是在两列
              之间来回跳。/ One language tab for title, summary and body together:
              side-by-side looks complete but writes as a hop between two columns. */}
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <div className="seg-tabs" role="radiogroup" aria-label={t('admin.announcements.language')}>
              {(['zh', 'en'] as Lang[]).map((l) => (
                <button
                  key={l}
                  type="button"
                  role="radio"
                  aria-checked={lang === l}
                  className={lang === l ? 'on' : ''}
                  onClick={() => setLang(l)}
                >
                  {t(`admin.announcements.lang_${l}`)}
                </button>
              ))}
            </div>
            <span className="text-xs text-neutral-500">{t('admin.announcements.langHint')}</span>
          </div>

          <div className="grid gap-3">
            {lang === 'zh' ? (
              <>
                <Field label={t('admin.announcements.titleZh')} value={draft.titleZh} onChange={(v) => patch({ titleZh: v })} maxLength={120} />
                <Field label={t('admin.announcements.summaryZh')} value={draft.summaryZh} onChange={(v) => patch({ summaryZh: v })} placeholder={t('admin.announcements.summaryHint')} maxLength={300} />
              </>
            ) : (
              <>
                <Field label={t('admin.announcements.titleEn')} value={draft.titleEn} onChange={(v) => patch({ titleEn: v })} maxLength={120} />
                <Field label={t('admin.announcements.summaryEn')} value={draft.summaryEn} onChange={(v) => patch({ summaryEn: v })} placeholder={t('admin.announcements.summaryHint')} maxLength={300} />
              </>
            )}
          </div>

          <div className="mt-3">
            {/* 去掉封面图时顺手把弹窗开关也关掉：弹窗主体就是这张图，后端保存时
                同样会归一。在这里先关，是为了让管理员立刻看到"没图就没弹窗"，
                而不是保存后重新打开才发现开关自己弹回去了。
                Clearing the cover also clears the popup switch — the image *is* the
                popup, and the backend normalises it on save anyway. Doing it here
                shows "no image, no popup" immediately instead of after a save and
                reopen. */}
            <ImageField
              label={t('admin.announcements.cover')}
              value={draft.coverImageUrl}
              onChange={(url) => patch({ coverImageUrl: url, ...(url ? {} : { popup: false }) })}
            />
            <p className="mt-1 text-xs text-neutral-500">{t('admin.announcements.coverHint')}</p>
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <span className="text-xs text-neutral-400">{t('admin.announcements.body')}</span>
              <span className="text-xs text-neutral-500">{t('admin.announcements.bodyHint')}</span>
            </div>
            <RichTextEditor
              docKey={`${draft.id ?? 'new'}:${lang}:${draft.bodyRev}`}
              value={lang === 'zh' ? draft.bodyZh : draft.bodyEn}
              onChange={(html) => patch(lang === 'zh' ? { bodyZh: html } : { bodyEn: html })}
              placeholder={t('admin.announcements.bodyPlaceholder')}
            />
          </div>

          <div className="mt-4 flex flex-col gap-3 border-t border-white/10 pt-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-6">
            <label className="flex items-center gap-2 text-sm text-neutral-300">
              <Switch checked={draft.pinned} onChange={(v) => patch({ pinned: v })} />
              {t('admin.announcements.pinnedLabel')}
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-300">
              <Switch checked={draft.published} onChange={(v) => patch({ published: v })} />
              {t('admin.announcements.publishedLabel')}
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-300" title={t('admin.announcements.notifyHint')}>
              <Switch checked={draft.notify} disabled={!draft.published} onChange={(v) => patch({ notify: v })} />
              {t('admin.announcements.notifyLabel')}
            </label>
            <label
              className="flex items-center gap-2 text-sm text-neutral-300"
              title={draft.coverImageUrl ? t('admin.announcements.popupHint') : t('admin.announcements.popupNeedsCover')}
            >
              <Switch checked={draft.popup} disabled={!draft.coverImageUrl} onChange={(v) => patch({ popup: v })} />
              {t('admin.announcements.popupLabel')}
            </label>
          </div>
          <p className="mt-2 text-xs text-neutral-500">{t('admin.announcements.notifyHint')}</p>
          <p className="mt-1 text-xs text-neutral-500">
            {draft.coverImageUrl ? t('admin.announcements.popupHint') : t('admin.announcements.popupNeedsCover')}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={save} disabled={saving} className="btn-primary px-5 py-1.5 text-sm disabled:opacity-40">
              {saving ? '...' : t('admin.announcements.save')}
            </button>
            <button type="button" onClick={() => setDraft(null)} disabled={saving} className="btn-ghost px-4 py-1.5 text-sm">
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {items.length === 0 ? (
        <div className="glass py-12 text-center text-sm text-neutral-500">{t('admin.announcements.empty')}</div>
      ) : (
        <div className="space-y-2">
          {items.map((a) => (
            <div key={a.id} className={`glass flex flex-wrap items-center gap-3 p-4${draft?.id === a.id ? ' border-prism-500/40' : ''}`}>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-neutral-100">{a.titleZh || a.titleEn || t('admin.announcements.untitled')}</div>
                {(a.summaryZh || a.summaryEn) && <div className="mt-0.5 truncate text-xs text-neutral-500">{a.summaryZh || a.summaryEn}</div>}
              </div>
              {a.pinned && <span className="tag bg-prism-600/20 text-prism-200">{t('admin.announcements.pinned')}</span>}
              {a.popup && <span className="tag bg-amber-400/15 text-amber-300">{t('admin.announcements.popupTag')}</span>}
              <span className={`tag ${a.published ? 'bg-up/15 text-up' : 'bg-white/5 text-neutral-400'}`}>
                {a.published ? t('admin.announcements.published') : t('admin.announcements.draft')}
              </span>
              <span className="font-mono text-xs text-neutral-500">{fmtDay(a.publishedAt ?? a.updatedAt, '')}</span>
              <button type="button" onClick={() => setDraft(toDraft(a))} className="rounded px-2 py-1 text-xs text-neutral-300 hover:bg-white/10">
                {t('admin.announcements.edit')}
              </button>
              <button type="button" onClick={() => setDeleteTarget(a)} className="rounded px-2 py-1 text-xs text-down hover:bg-down/10">
                {t('common.delete')}
              </button>
            </div>
          ))}
        </div>
      )}

      {deleteTarget && (
        <ConfirmModal
          title={t('admin.announcements.deleteConfirmTitle')}
          message={t('admin.announcements.deleteConfirm')}
          confirmLabel={t('common.delete')}
          danger
          busy={deleting}
          onConfirm={remove}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
      {pendingTranslate && (
        <ConfirmModal
          title={t('admin.announcements.translateOverwriteTitle')}
          message={t('admin.announcements.translateOverwrite')}
          confirmLabel={t('common.confirm')}
          onConfirm={() => void runTranslate(pendingTranslate)}
          onCancel={() => setPendingTranslate(null)}
        />
      )}
    </div>
  )
}
