// 新建邀请链接（设计 §5.5）：标记、渠道、可选「关联比赛」——选了即为比赛推广链接，
// 创建后关联不可改（后端 InviteLinkUpdate 不含 competitionId）。
// 比赛列表拉不到时降级成只能建普通链接，不挡住整个抽屉。
// New invite link (§5.5): label, channel, optional competition (which makes it a
// competition promo link; immutable afterwards). If competitions fail to load the
// drawer degrades to plain links instead of blocking.
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import AdminSheet from '../AdminSheet'
import Select from '../../Select'
import { adminApi } from '../../../api/client'
import type { Toast } from '../../../utils/useToast'
import type { CompetitionAdminRow, InviteLinkCreate } from '../../../api/types'
import ChannelField from './ChannelField'
import ToastBar from './ToastBar'
import { normalizeChannel } from './inviteLinkLogic'

export default function InviteLinkCreateDrawer({
  busy,
  toast,
  onCreate,
  onClose,
}: {
  busy: boolean
  toast: Toast | null
  onCreate: (body: InviteLinkCreate) => Promise<boolean>
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [label, setLabel] = useState('')
  const [channel, setChannel] = useState('')
  const [competitionId, setCompetitionId] = useState('')
  const [comps, setComps] = useState<CompetitionAdminRow[] | null>(null)
  const [compsError, setCompsError] = useState(false)

  useEffect(() => {
    let alive = true
    adminApi
      .competitions()
      .then((rows) => {
        if (alive) setComps(rows)
      })
      .catch(() => {
        if (alive) {
          setComps([])
          setCompsError(true)
        }
      })
    return () => {
      alive = false
    }
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const trimmed = label.trim()
    if (!trimmed || busy) return
    const body: InviteLinkCreate = { label: trimmed, channel: normalizeChannel(channel) }
    if (competitionId) body.competitionId = competitionId
    await onCreate(body)
  }

  return (
    <AdminSheet title={t('admin.invite.createTitle')} onClose={onClose}>
      <ToastBar toast={toast} className="mt-3" />
      <form className="mt-4 space-y-4" onSubmit={submit}>
        <div>
          <label className="label">{t('admin.invite.fieldLabel')}</label>
          <input
            className="input w-full"
            placeholder={t('admin.invite.labelPlaceholder')}
            value={label}
            maxLength={64}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div>
          <label className="label">{t('admin.invite.fieldChannel')}</label>
          <ChannelField value={channel} onChange={setChannel} disabled={busy} />
        </div>
        <div>
          <label className="label">{t('admin.invite.fieldCompetitionOptional')}</label>
          <Select
            value={competitionId}
            onChange={setCompetitionId}
            ariaLabel={t('admin.invite.fieldCompetitionOptional')}
            options={[
              { value: '', label: t('admin.invite.competitionNone') },
              ...(comps ?? []).map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          {compsError && <p className="mt-1 text-[11px] text-amber-400">{t('admin.invite.compsLoadError')}</p>}
          {competitionId && (
            <p className="mt-1 text-[11px] leading-snug text-neutral-500">{t('admin.invite.competitionHint')}</p>
          )}
        </div>
        <button
          type="submit"
          className="btn-primary w-full py-2 text-sm disabled:opacity-40"
          disabled={!label.trim() || busy}
        >
          {t('admin.invite.create')}
        </button>
      </form>
    </AdminSheet>
  )
}
