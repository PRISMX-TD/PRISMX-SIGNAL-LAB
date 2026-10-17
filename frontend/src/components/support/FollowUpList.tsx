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
}: {
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
      setRequests(req.items.slice(0, 10))
    } catch (err) {
      onError(errText(err, t('common.error')))
    } finally {
      setLoading(false)
    }
  }, [onError, t])

  useEffect(() => { void load() }, [load, reloadKey])

  if (loading && items.length === 0) {
    return (
      <div className="glass space-y-3 p-4">
        <SkeletonLine width="60%" height={14} />
        <SkeletonLine />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-neutral-500">{t('supportDesk.followUps.count', { n: total })}</p>
      {items.length === 0 ? (
        <div className="glass p-6 text-center text-sm text-neutral-500">{t('supportDesk.followUps.empty')}</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onSelect(f)}
                aria-current={selectedUserId === f.userId}
                className={`w-full rounded-xl border px-3.5 py-3 text-left transition ${
                  selectedUserId === f.userId
                    ? 'border-prism-500/50 bg-prism-600/10'
                    : f.overdue
                      ? 'border-down/30 bg-down/[0.06] hover:bg-down/10'
                      : 'border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06]'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-100">
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
          ))}
        </ul>
      )}

      {requests.length > 0 && (
        <div className="glass mt-2 p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">{t('supportDesk.requests.title')}</h3>
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
