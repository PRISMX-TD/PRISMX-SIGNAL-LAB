// 管理后台：公告编辑器。列表 + 单条编辑，逐条 POST / PUT / DELETE（与策略介绍的
// 整表覆盖不同：公告会越攒越多，且发布是一次性的副作用——广播、可选推送——
// 必须知道是哪一条刚被翻成发布）。正文复用策略介绍的内容块编辑器与图片上传。
//
// 一键翻译：把标题、摘要与每个内容块的源语言文字打包送到 /admin/announcements/translate，
// 按位置填回目标语言字段。目标字段已有内容时先确认再覆盖。后端未配置密钥时按钮置灰。
//
// Admin: the announcement editor. List plus one-at-a-time editing with per-item
// POST / PUT / DELETE (unlike the strategy guide's whole-list save: this list grows
// unbounded, and publishing has one-shot side effects — broadcast, optional push —
// so the backend must know which row just flipped). The body reuses the guide's
// block editor and image upload. One-click translate packs title, summary and each
// block's text into one request and writes results back by position, confirming
// before overwriting non-empty target fields; dimmed when the key isn't configured.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Switch from '../Switch'
import ConfirmModal from '../ConfirmModal'
import { useToast } from '../../utils/useToast'
import { adminApi } from '../../api/client'
import { localizeApiError, parseTime } from '../../api/utils'
import ImageField from './ImageField'
import StrategyBlocksEditor from './StrategyBlocksEditor'
import type { Announcement, AnnouncementInput } from '../../api/types'

function errText(err: unknown): string {
  return localizeApiError(err instanceof Error ? err.message : String(err))
}

type Draft = AnnouncementInput & { id: string | null }

function emptyDraft(): Draft {
  return {
    id: null,
    titleZh: '', titleEn: '', summaryZh: '', summaryEn: '',
    blocks: [], coverImageUrl: '', pinned: false, published: false, notify: false,
  }
}

function toDraft(a: Announcement): Draft {
  return {
    id: a.id,
    titleZh: a.titleZh, titleEn: a.titleEn, summaryZh: a.summaryZh, summaryEn: a.summaryEn,
    blocks: a.blocks, coverImageUrl: a.coverImageUrl, pinned: a.pinned, published: a.published, notify: false,
  }
}

function fmtDay(iso: string | null): string {
  const d = iso ? parseTime(iso) : null
  return d ? d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }) : ''
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
  const [pendingTranslate, setPendingTranslate] = useState<'en' | 'zh' | null>(null)
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
      const { id, ...payload } = draft
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

  // 翻译：源语言字段 → 目标语言字段，标题 / 摘要 / 每块文字打成一个数组。
  // Translate source → target: title / summary / each block's text as one array.
  const runTranslate = async (target: 'en' | 'zh') => {
    if (!draft) return
    setPendingTranslate(null)
    const src = target === 'en'
      ? [draft.titleZh, draft.summaryZh, ...draft.blocks.map((b) => b.textZh)]
      : [draft.titleEn, draft.summaryEn, ...draft.blocks.map((b) => b.textEn)]
    setTranslating(true)
    try {
      const res = await adminApi.translate(src, target)
      const [title, summary, ...rest] = res.texts
      if (target === 'en') {
        patch({ titleEn: title, summaryEn: summary, blocks: draft.blocks.map((b, i) => ({ ...b, textEn: rest[i] ?? b.textEn })) })
      } else {
        patch({ titleZh: title, summaryZh: summary, blocks: draft.blocks.map((b, i) => ({ ...b, textZh: rest[i] ?? b.textZh })) })
      }
      showToast('ok', t('admin.announcements.translateDone'))
    } catch (err) {
      showToast('err', errText(err))
    } finally {
      setTranslating(false)
    }
  }
  const askTranslate = (target: 'en' | 'zh') => {
    if (!draft) return
    const targetHasText = target === 'en'
      ? !!(draft.titleEn.trim() || draft.summaryEn.trim() || draft.blocks.some((b) => b.textEn.trim()))
      : !!(draft.titleZh.trim() || draft.summaryZh.trim() || draft.blocks.some((b) => b.textZh.trim()))
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

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('admin.announcements.titleZh')} value={draft.titleZh} onChange={(v) => patch({ titleZh: v })} maxLength={120} />
            <Field label={t('admin.announcements.titleEn')} value={draft.titleEn} onChange={(v) => patch({ titleEn: v })} maxLength={120} />
            <Field label={t('admin.announcements.summaryZh')} value={draft.summaryZh} onChange={(v) => patch({ summaryZh: v })} placeholder={t('admin.announcements.summaryHint')} maxLength={300} />
            <Field label={t('admin.announcements.summaryEn')} value={draft.summaryEn} onChange={(v) => patch({ summaryEn: v })} placeholder={t('admin.announcements.summaryHint')} maxLength={300} />
          </div>

          <div className="mt-3">
            <ImageField label={t('admin.announcements.cover')} value={draft.coverImageUrl} onChange={(url) => patch({ coverImageUrl: url })} />
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <span className="text-xs text-neutral-400">{t('admin.announcements.blocks')}</span>
              <span className="text-xs text-neutral-500">{t('admin.announcements.blocksHint')}</span>
            </div>
            <StrategyBlocksEditor blocks={draft.blocks} onChange={(blocks) => patch({ blocks })} />
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
          </div>
          <p className="mt-2 text-xs text-neutral-500">{t('admin.announcements.notifyHint')}</p>

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
              <span className={`tag ${a.published ? 'bg-up/15 text-up' : 'bg-white/5 text-neutral-400'}`}>
                {a.published ? t('admin.announcements.published') : t('admin.announcements.draft')}
              </span>
              <span className="font-mono text-xs text-neutral-500">{fmtDay(a.publishedAt ?? a.updatedAt)}</span>
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
