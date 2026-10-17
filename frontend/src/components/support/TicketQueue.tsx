// 工单队列：默认列出全部工单，不做筛选。谁先回复用户工单就归谁（后端自动认领），
// 每行标出「我的 / 某某跟进中 / 待回复」，其他客服一眼就知道有人在跟。
// 点一行打开右侧（手机上是下一屏）的会话。客服单页最多 50（设计 §8），这里给翻页。
// The ticket queue: all tickets, no filters. The first agent to reply owns the ticket (auto-claimed
// server-side); each row says mine / <name> is on it / awaiting reply so others can see who's on it.
// A row opens the thread on the right (the next screen on phones). Agents get at most 50 per page.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../store/auth'
import { adminApi, isAbortError } from '../../api/client'
import { fmtDayShort } from '../../api/utils'
import type { TicketListItem } from '../../api/types'
import { SkeletonLine } from '../Skeleton'
import { TICKET_PRIORITY_TONE, TICKET_STATUS_TONE, Tag, errText } from './supportUi'

const PAGE = 50
// 新工单自动出现：页面在前台时每 15 秒静默拉一次（50 行、一条带索引的查询，很轻），
// 切回前台立即补一次。后台不轮询。
// New tickets appear on their own: a silent refetch every 15s while visible (50 rows, one indexed
// query — cheap), plus one on returning to the foreground. No polling in the background.
const POLL_MS = 15_000
// 一排简单筛选：全部 / 我的 / 待回复（还没人接的）。/ One simple row: all / mine / awaiting reply (unclaimed).
type Scope = 'all' | 'me' | 'none'
const SCOPES: Scope[] = ['all', 'me', 'none']

export default function TicketQueue({
  selectedId,
  onSelect,
  reloadKey,
  onError,
  onCount,
}: {
  onCount?: (n: number) => void
  selectedId: string | null
  onSelect: (id: string) => void
  // 会话里改了状态 / 指派后加一，队列跟着刷新 / bumped after the thread changes status or assignee
  reloadKey: number
  onError: (text: string) => void
}) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const [scope, setScope] = useState<Scope>('all')
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<TicketListItem[]>([])
  const [loading, setLoading] = useState(true)
  const ctrlRef = useRef<AbortController | null>(null)

  const load = useCallback(async (silent = false) => {
    // 静默刷新不打断进行中的请求，也不闪骨架屏 / a silent refresh never aborts a pending load or flashes the skeleton
    if (silent && ctrlRef.current) return
    ctrlRef.current?.abort()
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    if (!silent) setLoading(true)
    try {
      const list = await adminApi.listTickets(
        { assignee: scope === 'all' ? undefined : scope, status: scope === 'none' ? 'active' : undefined, limit: PAGE, offset: page * PAGE },
        ctrl.signal,
      )
      setRows(list)
      onCount?.(list.length)
    } catch (err) {
      if (!isAbortError(err) && !silent) onError(errText(err, t('common.error')))
    } finally {
      if (ctrlRef.current === ctrl) {
        ctrlRef.current = null
        setLoading(false)
      }
    }
  }, [scope, page, onError, onCount, t])

  useEffect(() => { void load() }, [load, reloadKey])
  useEffect(() => () => ctrlRef.current?.abort(), [])
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') void load(true) }
    const id = window.setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [load])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 gap-1 overflow-x-auto px-3 pb-2.5 no-scrollbar" role="group" aria-label={t('supportDesk.queue.scope')}>
        {SCOPES.map((sc) => (
          <button
            key={sc}
            type="button"
            aria-pressed={scope === sc}
            onClick={() => { setScope(sc); setPage(0) }}
            className={`shrink-0 rounded-md px-2.5 py-1 text-[11px] font-medium transition ${
              scope === sc ? 'bg-white/10 text-neutral-100' : 'text-neutral-500 hover:text-neutral-200'
            }`}
          >
            {sc === 'none' ? t('supportDesk.queue.unassignedTag') : t(`supportDesk.queue.${sc}`)}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto border-t border-white/[0.06]">
      {loading ? (
        <ul aria-busy="true">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="space-y-2 border-b border-white/[0.04] px-4 py-3">
              <SkeletonLine width="65%" height={12} />
              <SkeletonLine width="90%" height={10} />
              <SkeletonLine width="35%" height={10} />
            </li>
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <div className="px-6 py-14 text-center">
          <p className="text-sm font-medium text-neutral-300">{t('supportDesk.queue.emptyTitle')}</p>
          <p className="mt-1 text-xs text-neutral-500">{t('supportDesk.queue.emptyHint')}</p>
        </div>
      ) : (
        <ul>
          {rows.map((r) => {
            const sel = selectedId === r.id
            return (
            <li key={r.id} className="border-b border-white/[0.04]">
              <button
                type="button"
                onClick={() => onSelect(r.id)}
                aria-current={sel}
                className={`relative w-full px-4 py-2.5 text-left transition ${
                  sel ? 'bg-prism-600/[0.12]' : 'hover:bg-white/[0.04]'
                }`}
              >
                {sel && <span className="absolute inset-y-0 left-0 w-0.5 bg-prism-400" aria-hidden="true" />}
                <div className="flex items-baseline gap-2">
                  <span className={`min-w-0 flex-1 truncate text-[13px] ${sel ? 'font-semibold text-neutral-50' : 'font-medium text-neutral-100'}`}>{r.title}</span>
                  <span className="num shrink-0 text-[11px] text-neutral-500">{fmtDayShort(r.updatedAt)}</span>
                </div>
                <div className="mt-0.5 truncate text-xs text-neutral-500">
                  <span className="text-neutral-400">{r.userEmail || '-'}</span>
                  {r.latestReply && (
                    <span className="ml-1.5">
                      {r.latestReply.internal ? `[${t('supportDesk.thread.internalTag')}] ` : ''}
                      {r.latestReply.body || t('tickets.images.preview')}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <Tag tone={TICKET_STATUS_TONE[r.status] ?? ''}>{t(`tickets.status.${r.status}`)}</Tag>
                  {r.priority !== 'normal' && <Tag tone={TICKET_PRIORITY_TONE[r.priority] ?? ''}>{t(`tickets.priority.${r.priority}`)}</Tag>}
                  <Tag tone="bg-white/5 text-neutral-400">{t(`tickets.category.${r.category}`)}</Tag>
                  {r.assigneeId && r.assigneeId === user?.id ? (
                    <span className="ml-auto shrink-0 text-[11px] font-medium text-prism-300">{t('supportDesk.queue.me')}</span>
                  ) : r.assigneeId ? (
                    <span className="ml-auto min-w-0 truncate text-[11px] text-neutral-500">
                      {t('supportDesk.queue.assignedTo', { name: r.assigneeName || '-' })}
                    </span>
                  ) : r.status !== 'closed' ? (
                    // 已关闭的不再标「待回复」/ closed tickets never read as awaiting reply
                    <span className="ml-auto shrink-0 text-[11px] text-amber-300/80">{t('supportDesk.queue.unassignedTag')}</span>
                  ) : null}
                </div>
              </button>
            </li>
            )
          })}
        </ul>
      )}

      {(page > 0 || rows.length === PAGE) && (
        <div className="flex items-center justify-center gap-3 py-3 text-xs">
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
    </div>
  )
}
