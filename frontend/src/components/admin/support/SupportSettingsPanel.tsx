// 客服台设置（设计 §7.6）：补偿天数直接生效上限、跟进默认期限、外包每日查看电话上限、异常提醒阈值。
// Support-desk settings (design §7.6): comp-days cap, default follow-up term, outsourced daily
// phone-reveal cap and the anomaly alert thresholds.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminSupportApi } from '../../../api/client'
import type { SupportSettings } from '../../../api/supportTypes'
import { SkeletonLine } from '../../Skeleton'
import { errText } from '../../support/supportUi'

const FIELDS: { key: keyof SupportSettings; min: number; max: number }[] = [
  { key: 'support_comp_days_max', min: 0, max: 365 },
  { key: 'support_follow_up_days', min: 1, max: 365 },
  { key: 'support_outsourced_reveal_daily', min: 0, max: 10000 },
  { key: 'support_alert_reveal_per_hour', min: 0, max: 10000 },
  { key: 'support_alert_views_per_hour', min: 0, max: 100000 },
]

export default function SupportSettingsPanel({ onToast }: { onToast: (kind: 'ok' | 'err', text: string) => void }) {
  const { t } = useTranslation()
  const [saved, setSaved] = useState<SupportSettings | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const apply = (s: SupportSettings) => {
    setSaved(s)
    setDraft(Object.fromEntries(FIELDS.map((f) => [f.key, String(s[f.key])])))
  }

  useEffect(() => {
    adminSupportApi.settings().then(apply).catch((err) => onToast('err', errText(err, t('admin.loadError'))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!saved) return <div className="glass space-y-3 p-5"><SkeletonLine /><SkeletonLine width="60%" /></div>

  const valid = FIELDS.every((f) => /^\d+$/.test(draft[f.key] ?? '') && Number(draft[f.key]) >= f.min && Number(draft[f.key]) <= f.max)
  const dirty = FIELDS.some((f) => draft[f.key] !== String(saved[f.key]))

  const save = async () => {
    setSaving(true)
    try {
      const patch = Object.fromEntries(FIELDS.map((f) => [f.key, Number(draft[f.key])])) as Partial<SupportSettings>
      apply(await adminSupportApi.saveSettings(patch))
      onToast('ok', t('admin.saved'))
    } catch (err) {
      onToast('err', errText(err, t('admin.saveError')))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="glass max-w-xl space-y-4 p-5">
      {FIELDS.map((f) => (
        <label key={f.key} className="block">
          <span className="block text-sm text-neutral-200">{t(`admin.support.settings.${f.key}`)}</span>
          <span className="mb-1.5 block text-[11px] text-neutral-500">{t(`admin.support.settings.${f.key}_hint`)}</span>
          <input className="input w-32" inputMode="numeric" value={draft[f.key] ?? ''}
            onChange={(e) => setDraft((prev) => ({ ...prev, [f.key]: e.target.value.trim() }))} />
        </label>
      ))}
      <button type="button" className="btn-primary px-5 py-2 text-sm disabled:opacity-40" disabled={!valid || !dirty || saving} onClick={() => void save()}>
        {saving ? t('common.loading') : t('common.save')}
      </button>
    </div>
  )
}
