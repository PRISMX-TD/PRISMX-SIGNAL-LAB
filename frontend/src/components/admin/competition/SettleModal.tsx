// 终审确认（§1.14）：取代原来那句纯文字的 ConfirmModal。打开即拉完整性报告 + 参赛名单
// （名次用来判断前 10），列出有标记的条目；前 10 有标记时必须勾选「已核查」才能点终审，
// 勾了就带 acknowledgeFlags:true（后端写审计）。前端判断的「前 10」只是近似——只要有标记
// 就给出勾选框，后端若仍 400，管理员勾上再点一次即可。报告拉不到时不挡终审（后端兜底）。
// Settle confirmation (§1.14), replacing the plain-text ConfirmModal. Loads the integrity
// report + participants (ranks decide top 10); a flagged top-10 row makes the
// acknowledgement mandatory and sends acknowledgeFlags:true (audited). The top-10 check
// here is approximate, so the box shows whenever anything is flagged; if the server still
// 400s, tick it and retry. A failed report load doesn't block settling (server gates).
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import AdminSheet from '../AdminSheet'
import { SkeletonLine } from '../../Skeleton'
import { adminApi } from '../../../api/client'
import { localizeApiError } from '../../../api/utils'
import type { CompetitionAdminRow } from '../../../api/types'
import FlagKinds from './FlagKinds'
import { formatFlagDetail, needsAck, rankFlags, type RankedFlag } from './promoLogic'

export default function SettleModal({
  comp,
  onConfirm,
  onCancel,
}: {
  comp: CompetitionAdminRow
  onConfirm: (acknowledgeFlags: boolean) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [flags, setFlags] = useState<RankedFlag[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [ack, setAck] = useState(false)

  useEffect(() => {
    let alive = true
    setFlags(null)
    setError(null)
    Promise.all([adminApi.competitionIntegrity(comp.id), adminApi.competitionParticipants(comp.id)])
      .then(([integrity, participants]) => {
        if (alive) setFlags(rankFlags(integrity.flags, participants))
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? localizeApiError(err.message) : String(err))
      })
    return () => {
      alive = false
    }
  }, [comp.id, attempt])

  const loading = flags == null && error == null
  const mustAck = flags != null && needsAck(flags)
  const showAck = error != null || (flags != null && flags.length > 0)
  const canConfirm = !loading && (!mustAck || ack)

  return (
    <AdminSheet title={t('admin.competitionPromo.settleTitle')} onClose={onCancel} widthClass="sm:w-[560px]">
      <p className="mt-3 text-sm leading-relaxed text-neutral-300">
        {comp.name} · {t('competition.admin.settleConfirm')}
      </p>

      <div className="mt-4">
        {loading ? (
          <div className="space-y-2">
            <p className="text-xs text-neutral-500">{t('admin.competitionPromo.settleChecking')}</p>
            <SkeletonLine height={14} />
            <SkeletonLine width="60%" height={14} />
          </div>
        ) : error ? (
          <div className="space-y-2">
            <p className="text-sm text-amber-400">{t('admin.competitionPromo.settleLoadError', { msg: error })}</p>
            <button type="button" className="btn-ghost px-3 py-1 text-xs" onClick={() => setAttempt((n) => n + 1)}>
              {t('admin.competitionPromo.retry')}
            </button>
          </div>
        ) : flags && flags.length === 0 ? (
          <p className="text-sm text-up">{t('admin.competitionPromo.settleNoFlags')}</p>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-neutral-400">{t('admin.competitionPromo.settleFlagsHint')}</p>
            <ul className="mt-2 max-h-56 space-y-1.5 overflow-y-auto">
              {(flags ?? []).map((f) => (
                <li
                  key={f.participantId}
                  className={`rounded-lg px-2 py-1.5 text-xs ${f.top ? 'bg-down/10' : 'bg-white/[0.03]'}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="num text-neutral-300">#{f.rank ?? '—'}</span>
                    <span className="num text-neutral-200">{f.login}</span>
                    {f.displayName && <span className="text-neutral-400">{f.displayName}</span>}
                    {f.top && <span className="tag bg-down/20 text-[10px] text-down">{t('admin.competitionPromo.settleTop')}</span>}
                    <FlagKinds kinds={f.kinds} />
                  </div>
                  {f.detail && <p className="mt-1 text-neutral-500">{formatFlagDetail(f.detail)}</p>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {showAck && (
        <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-neutral-200">
          <input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>{t('admin.competitionPromo.settleAck')}</span>
        </label>
      )}

      <div className="mt-5 flex gap-3">
        <button type="button" onClick={onCancel} className="btn-ghost flex-1 py-2 text-sm">
          {t('common.cancel')}
        </button>
        <button
          type="button"
          onClick={() => onConfirm(ack)}
          disabled={!canConfirm}
          className="btn-primary flex-1 py-2 text-sm disabled:opacity-40"
        >
          {t('competition.admin.settle')}
        </button>
      </div>
    </AdminSheet>
  )
}
