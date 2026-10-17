// 客服成员（设计 §7.1）：tier、每日查看完整电话上限（空 = 全局默认）、在岗 / 停用、名下工单与跟进数、
// 今日查看次数。设为客服本身在「用户管理」改角色。
// Support members (design §7.1): tier, daily phone-reveal cap (blank = global default), status,
// open tickets / active follow-ups and today's reveals. Making someone support happens in Users.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminSupportApi } from '../../../api/client'
import { fmtTime } from '../../../api/utils'
import type { SupportMember, SupportTier } from '../../../api/supportTypes'
import Select from '../../Select'
import { SkeletonLine } from '../../Skeleton'
import { errText } from '../../support/supportUi'

export default function StaffPanel({ onToast }: { onToast: (kind: 'ok' | 'err', text: string) => void }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<SupportMember[] | null>(null)
  const [limits, setLimits] = useState<Record<string, string>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await adminSupportApi.members()
      setRows(r.items)
      setLimits(Object.fromEntries(r.items.map((m) => [m.id, m.revealLimit == null ? '' : String(m.revealLimit)])))
    } catch (err) {
      onToast('err', errText(err, t('admin.loadError')))
      setRows([])
    }
  }, [onToast, t])
  useEffect(() => { void load() }, [load])

  const patch = async (m: SupportMember, body: { tier?: SupportTier; revealLimit?: number | null }) => {
    setSavingId(m.id)
    try {
      await adminSupportApi.patchMember(m.id, body)
      onToast('ok', t('admin.saved'))
      await load()
    } catch (err) {
      onToast('err', errText(err, t('admin.saveError')))
    } finally {
      setSavingId(null)
    }
  }

  if (!rows) {
    return (
      <div className="glass space-y-3 p-5">
        <SkeletonLine width="50%" height={14} />
        <SkeletonLine />
      </div>
    )
  }
  if (rows.length === 0) return <div className="glass p-8 text-center text-sm text-neutral-500">{t('admin.support.staff.empty')}</div>

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {rows.map((m) => {
        const limitDraft = limits[m.id] ?? ''
        const limitChanged = limitDraft !== (m.revealLimit == null ? '' : String(m.revealLimit))
        const limitValid = limitDraft === '' || (/^\d+$/.test(limitDraft) && Number(limitDraft) <= 10000)
        return (
          <div key={m.id} className={`glass p-4 ${m.disabled ? 'opacity-60' : ''}`}>
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-neutral-100">{m.nickname || m.email}</div>
                <div className="truncate font-mono text-[11px] text-neutral-500">{m.email}</div>
              </div>
              <span className={`tag ${m.disabled ? 'bg-down/15 text-down' : 'bg-up/15 text-up'}`}>
                {m.disabled ? t('admin.statusDisabled') : t('admin.support.staff.onDuty')}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              {[
                [t('admin.support.staff.openTickets'), m.openTickets],
                [t('admin.support.staff.activeFollowUps'), m.activeFollowUps],
                [t('admin.support.staff.revealsToday'), m.revealsToday],
              ].map(([label, n]) => (
                <div key={String(label)} className="rounded-lg bg-white/[0.03] py-2">
                  <div className="num text-base font-semibold text-neutral-100">{n}</div>
                  <div className="text-[10px] text-neutral-500">{label}</div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-neutral-500">{t('admin.support.staff.tier')}</span>
              <Select
                value={m.tier ?? ''}
                onChange={(v) => void patch(m, { tier: v as SupportTier })}
                className="select-tight"
                ariaLabel={t('admin.support.staff.tier')}
                options={[
                  ...(m.tier ? [] : [{ value: '', label: t('admin.support.staff.tierUnset') }]),
                  { value: 'internal', label: t('admin.support.tier.internal') },
                  { value: 'outsourced', label: t('admin.support.tier.outsourced') },
                ]}
              />
            </div>
            {m.effectiveTier === 'outsourced' && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="text-neutral-500">{t('admin.support.staff.revealLimit')}</span>
                <input
                  className="input w-20 py-1 text-xs"
                  inputMode="numeric"
                  value={limitDraft}
                  placeholder={String(m.effectiveRevealLimit)}
                  onChange={(e) => setLimits((prev) => ({ ...prev, [m.id]: e.target.value.trim() }))}
                />
                <button
                  type="button"
                  className="btn-primary px-3 py-1 disabled:opacity-40"
                  disabled={!limitChanged || !limitValid || savingId === m.id}
                  onClick={() => void patch(m, { revealLimit: limitDraft === '' ? null : Number(limitDraft) })}
                >
                  {t('common.save')}
                </button>
                <span className="w-full text-[11px] text-neutral-500">{t('admin.support.staff.revealLimitHint', { n: m.effectiveRevealLimit })}</span>
              </div>
            )}
            <div className="mt-2 text-[11px] text-neutral-500">{t('admin.support.staff.lastActive', { time: fmtTime(m.lastActiveAt) })}</div>
          </div>
        )
      })}
    </div>
  )
}
