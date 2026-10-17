// 工单队列：按「我的 / 未分配 / 全部」+ 状态筛选，点一行打开右侧（手机上是下一屏）的会话。
// 列表接口对客服单页最多 50（设计 §8），这里给翻页而不是一次拉完。
// The ticket queue: filter by mine / unassigned / all plus status; a row opens the thread on the
// right (the next screen on phones). Agents get at most 50 per page (design §8), hence paging.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi, isAbortError } from '../../api/client'
import { fmtDayShort } from '../../api/utils'
import type { TicketListItem, TicketStatus } from '../../api/types'
import { segBtn } from '../../utils/segBtn'
import { SkeletonLine } from '../Skeleton'
import { TICKET_PRIORITY_TONE, TICKET_STATUS_TONE, Tag, errText } from './supportUi'

const PAGE = 50
type Scope = 'me' | 'none' | 'all'
const SCOPES: Scope[] = ['me', 'none', 'all']
const STATUSES: ('' | TicketStatus)[] = ['', 'open', 'in_progress', 'closed']

export default function TicketQueue({
  selectedId,
  onSelect,
  reloadKey,
  onError,
}: {
  selectedId: string | null
  onSelect: (id: string) => void
  // 会话里改了状态 / 指派后加一，队列跟着刷新 / bumped after the thread changes status or assignee
  reloadKey: number
  onError: (text: string) => void
}) {
  const { t } = useTranslation()
  const [scope, setScope] = useState<Scope>('me')
  const [status, setStatus] = useState<'' | TicketStatus>('open')
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<TicketListItem[]>([])
  const [loading, setLoading] = useState(true)
  const ctrlRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setLoading(true)
    try {
      const list = await adminApi.listTickets(
        { assignee: scope === 'all' ? undefined : scope, status: status || undefined, limit: PAGE, offset: page * PAGE },
        ctrl.signal,
      )
      setRows(list)
    } catch (err) {
      if (!isAbortError(err)) onError(errText(err, t('common.error')))
    } finally {
      if (ctrlRef.current === ctrl) setLoading(false)
    }
  }, [scope, status, page, onError, t])

  useEffect(() => { void load() }, [load, reloadKey])
  useEffect(() => () => ctrlRef.current?.abort(), [])
  useEffect(() => setPage(0), [scope, status])

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar" role="group" aria-label={t('supportDesk.queue.scope')}>
        {SCOPES.map((s) => (
          <button key={s} type="button" className={`${segBtn(scope === s)} shrink-0`} aria-pressed={scope === s} onClick={() => setScope(s)}>
            {t(`supportDesk.queue.${s}`)}
          </button>
        ))}
      </div>
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar" role="group" aria-label={t('supportDesk.queue.status')}>
        {STATUSES.map((s) => (
          <button key={s || 'any'} type="button" className={`${segBtn(status === s)} shrink-0`} aria-pressed={status === s} onClick={() => setStatus(s)}>
            {s ? t(`tickets.status.${s}`) : t('supportDesk.queue.anyStatus')}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="glass space-y-3 p-4">
          <SkeletonLine width="60%" height={14} />
          <SkeletonLine />
          <SkeletonLine width="75%" />
        </div>
      ) : rows.length === 0 ? (
        <div className="glass p-6 text-center text-sm text-neutral-500">{t('supportDesk.queue.empty')}</div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onSelect(r.id)}
                aria-current={selectedId === r.id}
                className={`w-full rounded-xl border px-3.5 py-3 text-left transition ${
                  selectedId === r.id
                    ? 'border-prism-500/50 bg-prism-600/10'
                    : 'border-white/[0.06] bg-white/[0.03] hover:bg-white/[0.06]'
                }`}
              >
                <div className="flex items-start gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-100">{r.title}</span>
                  <span className="num shrink-0 text-[11px] text-neutral-500">{fmtDayShort(r.updatedAt)}</span>
                </div>
                <div className="mt-1 truncate text-[11px] text-neutral-500">
                  {r.userEmail || '—'}
                  {r.latestReply && (
                    <>
                      {' · '}
                      {r.latestReply.internal ? `[${t('supportDesk.thread.internalTag')}] ` : ''}
                      {r.latestReply.body || t('tickets.images.preview')}
                    </>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Tag tone={TICKET_STATUS_TONE[r.status] ?? ''}>{t(`tickets.status.${r.status}`)}</Tag>
                  {r.priority !== 'normal' && <Tag tone={TICKET_PRIORITY_TONE[r.priority] ?? ''}>{t(`tickets.priority.${r.priority}`)}</Tag>}
                  <Tag tone="bg-white/5 text-neutral-400">{t(`tickets.category.${r.category}`)}</Tag>
                  <span className="ml-auto truncate text-[11px] text-neutral-500">
                    {r.assigneeName ? t('supportDesk.queue.assignedTo', { name: r.assigneeName }) : t('supportDesk.queue.unassignedTag')}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}

      {(page > 0 || rows.length === PAGE) && (
        <div className="flex items-center justify-center gap-3 text-xs">
          <button type="button" className="btn-ghost px-3 py-1.5 disabled:opacity-40" disabled={page === 0 || loading} onClick={() => setPage(page - 1)}>
            {t('common.prevPage')}
          </button>
          <span className="num text-neutral-500">{page + 1}</span>
          <button type="button" className="btn-ghost px-3 py-1.5 disabled:opacity-40" disabled={rows.length < PAGE || loading} onClick={() => setPage(page + 1)}>
            {t('common.nextPage')}
          </button>
        </div>
      )}
    </div>
  )
}
