// 公开页预览：拿 /admin/competitions/{id}/public-preview（与公开接口同一份载荷，忽略
// 总开关与 public_view、不缓存）渲染成一张只读的简表。目的是让管理员在打开总开关前
// 验收「访客会看到什么」：匿名选手是否正确、开户链接是否对、有没有泄露账户号。
// 榜单复用 Part E 的 Ladder + publicLadderRows（与访客所见同一套渲染）；不复用整页（带落地页布局与埋点）。
// Public-page preview: the same payload as the public endpoint (switches ignored,
// uncached) as a plain read-only board, so admins can check what visitors will see before
// the global switch opens. Board reuses Ladder + publicLadderRows; not the whole page (layout + tracking).
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import AdminSheet from '../AdminSheet'
import { SkeletonLine } from '../../Skeleton'
import { adminApi } from '../../../api/client'
import { fmtDate, fmtTime, localizeApiError } from '../../../api/utils'
import { safeHttpUrl } from '../../../utils/safeUrl'
import Ladder from '../../competition/Ladder'
import { publicLadderRows } from '../../../utils/publicCompetition'
import type { PublicCompetitionPayload } from '../../../api/types'

export default function PublicPreviewModal({ compId, onClose }: { compId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [data, setData] = useState<PublicCompetitionPayload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    adminApi
      .competitionPublicPreview(compId)
      .then((d) => {
        if (alive) setData(d)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? localizeApiError(err.message) : String(err))
      })
    return () => {
      alive = false
    }
  }, [compId])

  const href = data?.openAccountUrl ? safeHttpUrl(data.openAccountUrl) : ''

  return (
    <AdminSheet title={t('admin.competitionPromo.previewTitle')} onClose={onClose} widthClass="sm:w-[640px]">
      <p className="mt-1 text-xs text-neutral-500">{t('admin.competitionPromo.previewNote')}</p>
      {error && <p className="mt-3 text-sm text-down">{error}</p>}
      {!data && !error && (
        <div className="mt-4 space-y-2">
          <SkeletonLine height={16} />
          <SkeletonLine width="70%" height={14} />
          <SkeletonLine height={14} />
        </div>
      )}
      {data && (
        <div className="mt-4 space-y-4">
          <div>
            <p className="font-display text-xl text-neutral-100">{data.name}</p>
            <p className="num mt-1 text-xs text-neutral-400">
              {data.startsAt ? fmtDate(data.startsAt) : '—'} → {data.endsAt ? fmtDate(data.endsAt) : '—'} ·{' '}
              {t('admin.competitionPromo.participantsN', { n: data.participants })}
            </p>
            {data.prizeNote && <p className="mt-2 text-sm text-prism-200">{data.prizeNote}</p>}
            {data.description && (
              <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-neutral-400">
                {data.description}
              </p>
            )}
          </div>
          <div className="text-xs">
            <span className="text-neutral-500">{t('admin.competitionPromo.openAccount')}：</span>
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer" className="break-all text-prism-300 underline">
                {href}
              </a>
            ) : (
              <span className="text-amber-400">{t('admin.competitionPromo.notSet')}</span>
            )}
          </div>
          {data.snapshotAt && (
            <p className="text-[11px] text-neutral-500">
              {t('admin.competitionPromo.snapshotAt', { time: fmtTime(data.snapshotAt) })}
            </p>
          )}
          <Ladder
            rows={publicLadderRows(data.rows, t('admin.competitionPromo.anonymous'), (n) => t('competition.pub.sample', { n }))}
            emptyText={t('admin.competitionPromo.noRows')}
          />
        </div>
      )}
    </AdminSheet>
  )
}
