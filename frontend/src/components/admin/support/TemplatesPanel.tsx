// 快捷回复模板（设计 §3 / §7.5）：admin 维护，客服在工单会话里只读插入。语言留空 = 所有语言可见。
// Canned replies (design §3 / §7.5): admins maintain them, agents insert them read-only in the
// ticket thread. A blank language means visible for every language.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminSupportApi } from '../../../api/client'
import type { SupportTemplate } from '../../../api/supportTypes'
import { APP_LANGS } from '../../../i18n'
import ConfirmModal from '../../ConfirmModal'
import Select from '../../Select'
import { SkeletonLine } from '../../Skeleton'
import { errText } from '../../support/supportUi'

interface Draft {
  id: string | null
  title: string
  body: string
  lang: string
}
const EMPTY: Draft = { id: null, title: '', body: '', lang: '' }

export default function TemplatesPanel({ onToast }: { onToast: (kind: 'ok' | 'err', text: string) => void }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<SupportTemplate[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<SupportTemplate | null>(null)

  const load = useCallback(async () => {
    try {
      setRows((await adminSupportApi.templates()).items)
    } catch (err) {
      onToast('err', errText(err, t('admin.loadError')))
      setRows([])
    }
  }, [onToast, t])
  useEffect(() => { void load() }, [load])

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const body = { title: draft.title.trim(), body: draft.body, lang: draft.lang || null }
      if (draft.id) await adminSupportApi.patchTemplate(draft.id, body)
      else await adminSupportApi.createTemplate(body)
      onToast('ok', t('admin.saved'))
      setDraft(null)
      await load()
    } catch (err) {
      onToast('err', errText(err, t('admin.saveError')))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!deleting) return
    setSaving(true)
    try {
      await adminSupportApi.deleteTemplate(deleting.id)
      setDeleting(null)
      await load()
    } catch (err) {
      onToast('err', errText(err, t('admin.saveError')))
    } finally {
      setSaving(false)
    }
  }

  const langLabel = (code: string | null) => (code ? APP_LANGS.find((l) => l.code === code)?.label ?? code : t('admin.support.templates.anyLang'))

  return (
    <div className="space-y-3">
      {draft ? (
        <div className="glass space-y-3 p-4">
          <div className="flex flex-wrap gap-2">
            <input className="input min-w-0 flex-1" maxLength={100} placeholder={t('admin.support.templates.title')}
              value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
            <Select value={draft.lang} onChange={(v) => setDraft({ ...draft, lang: v })} ariaLabel={t('admin.support.templates.lang')}
              options={[{ value: '', label: t('admin.support.templates.anyLang') }, ...APP_LANGS.map((l) => ({ value: l.code, label: l.label }))]} />
          </div>
          <textarea className="input min-h-[140px] w-full" maxLength={5000} placeholder={t('admin.support.templates.body')}
            value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          <div className="flex gap-2">
            <button type="button" className="btn-primary px-4 py-2 text-sm disabled:opacity-40" disabled={saving || !draft.title.trim() || !draft.body.trim()} onClick={() => void save()}>
              {saving ? t('common.loading') : t('common.save')}
            </button>
            <button type="button" className="btn-ghost px-4 py-2 text-sm" onClick={() => setDraft(null)}>{t('common.cancel')}</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn-primary px-4 py-2 text-sm" onClick={() => setDraft(EMPTY)}>
          {t('admin.support.templates.add')}
        </button>
      )}

      {!rows ? (
        <div className="glass space-y-3 p-5"><SkeletonLine /><SkeletonLine width="70%" /></div>
      ) : rows.length === 0 ? (
        <div className="glass p-8 text-center text-sm text-neutral-500">{t('admin.support.templates.empty')}</div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="glass p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-neutral-100">{r.title}</span>
                <span className="tag bg-white/5 text-neutral-400">{langLabel(r.lang)}</span>
                <div className="ml-auto flex gap-2">
                  <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={() => setDraft({ id: r.id, title: r.title, body: r.body, lang: r.lang ?? '' })}>
                    {t('admin.support.templates.edit')}
                  </button>
                  <button type="button" className="btn-ghost px-3 py-1 text-xs text-down" onClick={() => setDeleting(r)}>
                    {t('common.delete')}
                  </button>
                </div>
              </div>
              <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-xs text-neutral-400">{r.body}</p>
            </li>
          ))}
        </ul>
      )}

      {deleting && (
        <ConfirmModal
          center
          danger
          busy={saving}
          title={t('common.delete')}
          message={t('admin.support.templates.deleteBody', { title: deleting.title })}
          onConfirm={() => void remove()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
