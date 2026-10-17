// 「我的跟进」：后端已按下次跟进时间（逾期在前、没设的在后）+ 优先级排好序，这里只负责显示；
// 逾期的整行标红。下面附一段「我提交的申请」，看补偿 / 申请跟进 / 开户标记审到哪了。
// "My follow-ups": the backend already sorts by next contact time (overdue first, unset last)
// then priority; overdue rows are tinted red. "My requests" below shows where the comp-days /
// follow-up / open-account claims stand.
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supportApi } from '../../api/client'
import { fmtTime } from '../../api/utils'
import type { FollowUp, SupportRequest } from '../../api/supportTypes'
import { SkeletonLine } from '../Skeleton'
import { FU_PRIORITY_TONE, FU_STATUS_TONE, Tag, errText } from './supportUi'

const REQ_TONE: Record<string, string> = {
  pending: 'bg-amber-400/15 text-amber-300',
  approved: 'bg-up/15 text-up',
  rejected: 'bg-down/15 text-down',
}

export default function FollowUpList({
  selectedUserId,
  onSelect,
  reloadKey,
  onError,
  onCount,
}: {
  onCount?: (n: number) => void
  selectedUserId: string | null
  onSelect: (fu: FollowUp) => void
  reloadKey: number
  onError: (text: string) => void
}) {
  const { t } = useTranslation()
  const [items, setItems] = useState<FollowUp[]>([])
  const [total, setTotal] = useState(0)
  const [requests, setRequests] = useState<SupportRequest[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [fu, req] = await Promise.all([supportApi.followUps(), supportApi.myRequests()])
      setItems(fu.items)
      setTotal(fu.total)
      onCount?.(fu.total)
      setRequests(req.items.slice(0, 10))
    } catch (err) {
      onError(errText(err, t('common.error')))
    } finally {
      setLoading(false)
    }
  }, [onError, onCount, t])

  useEffect(() => { void load() }, [load, reloadKey])

  if (loading && items.length === 0) {
    return (
      <ul aria-busy="true" className="border-t border-white/[0.06]">
        {[0, 1, 2, 3].map((i) => (
          <li key={i} className="space-y-2 border-b border-white/[0.04] px-4 py-3">
            <SkeletonLine width="50%" height={12} />
            <SkeletonLine width="35%" height={10} />
          </li>
        ))}
      </ul>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto border-t border-white/[0.06]">
      <p className="px-4 pb-1 pt-2.5 text-[11px] text-neutral-500">{t('supportDesk.followUps.count', { n: total })}</p>
      {items.length === 0 ? (
        <div className="px-6 py-12 text-center text-sm text-neutral-500">{t('supportDesk.followUps.empty')}</div>
      ) : (
        <ul>
          {items.map((f) => {
            const sel = selectedUserId === f.userId
            return (
              <li key={f.id} className="border-b border-white/[0.04]">
                <button
                  type="button"
                  onClick={() => onSelect(f)}
                  aria-current={sel}
                  className={`relative w-full px-4 py-2.5 text-left transition ${
                    sel ? 'bg-prism-600/[0.12]' : f.overdue ? 'bg-down/[0.05] hover:bg-down/10' : 'hover:bg-white/[0.04]'
                  }`}
                >
                  {sel && <span className="absolute inset-y-0 left-0 w-0.5 bg-prism-400" aria-hidden="true" />}
                  <div className="flex items-center gap-2">
                    <span className={`min-w-0 flex-1 truncate text-[13px] ${sel ? 'font-semibold text-neutral-50' : 'font-medium text-neutral-100'}`}>
                      {f.nickname || t('supportDesk.card.noNickname')}
                    </span>
                    <Tag tone={FU_PRIORITY_TONE[f.priority]}>{t(`supportDesk.priority.${f.priority}`)}</Tag>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <Tag tone={FU_STATUS_TONE[f.status]}>{t(`supportDesk.status.${f.status}`)}</Tag>
                    <Tag tone="bg-white/5 text-neutral-400">{t(`supportDesk.goal.${f.goal}`)}</Tag>
                  </div>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {requests.length > 0 && (
        <div className="m-3 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3.5">
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{t('supportDesk.requests.title')}</h3>
          <ul className="space-y-2">
            {requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 text-xs">
                <Tag tone={REQ_TONE[r.status] ?? ''}>{t(`supportDesk.requests.status.${r.status}`)}</Tag>
                <span className="text-neutral-300">{t(`supportDesk.requests.kind.${r.kind}`)}</span>
                <span className="num ml-auto text-neutral-500">{fmtTime(r.createdAt)}</span>
                {r.note && <span className="w-full text-neutral-500">{r.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
