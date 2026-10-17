// 工单队列：默认列出全部工单。谁先回复用户工单就归谁（后端自动认领），每行标出「我的 / 某某
// 跟进中 / 待回复」，其他客服一眼就知道有人在跟。上方一排筛选：全部 / 我的 / 待回复（没人接、没关闭）。
// 每行是一条账本：头像 | 标题、提交人、最新回复 | 时间、状态、归属。客服单页最多 50（设计 §8），这里给翻页。
// The ticket queue: all tickets by default. The first agent to reply owns the ticket (auto-claimed
// server-side); each row says mine / <name> is on it / awaiting reply. One filter row: all / mine /
// awaiting (unclaimed and not closed). Rows are ledger lines: avatar | title, submitter, latest
// reply | time, status, owner. Agents get at most 50 per page, so it pages.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '../../store/auth'
import { adminApi, isAbortError } from '../../api/client'
import type { TicketListItem } from '../../api/types'
import { SkeletonLine } from '../Skeleton'
import { IconInbox } from './deskIcons'
import { Avatar, TicketStatus, errText, fmtListTime } from './supportUi'

const PAGE = 50
// 新工单自动出现：页面在前台时每 15 秒静默拉一次（50 行、一条带索引的查询，很轻），
// 切回前台立即补一次。后台不轮询。
// New tickets appear on their own: a silent refetch every 15s while visible (50 rows, one indexed
// query — cheap), plus one on returning to the foreground. No polling in the background.
const POLL_MS = 15_000
type Scope = 'all' | 'me' | 'none'
const SCOPES: Scope[] = ['all', 'me', 'none']

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
    } catch (err) {
      if (!isAbortError(err) && !silent) onError(errText(err, t('common.error')))
    } finally {
      if (ctrlRef.current === ctrl) {
        ctrlRef.current = null
        setLoading(false)
      }
    }
  }, [scope, page, onError, t])

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
      <div className="shrink-0 px-3 pb-3 pt-3">
        <div className="sd-seg" role="group" aria-label={t('supportDesk.queue.scope')}>
          {SCOPES.map((sc) => (
            <button
              key={sc}
              type="button"
              aria-pressed={scope === sc}
              onClick={() => { setScope(sc); setPage(0) }}
              className={scope === sc ? 'is-on' : ''}
            >
              {sc === 'none' ? t('supportDesk.queue.unassignedTag') : t(`supportDesk.queue.${sc}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="sd-scroll min-h-0 flex-1 overflow-y-auto border-t border-[var(--line)]">
        {loading ? (
          <ul aria-busy="true">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <li key={i} className="flex gap-3 border-b border-[var(--line)] px-4 py-3.5">
                <SkeletonLine width={32} height={32} />
                <div className="flex-1 space-y-2">
                  <SkeletonLine width="60%" height={12} />
                  <SkeletonLine width="90%" height={10} />
                  <SkeletonLine width="35%" height={10} />
                </div>
              </li>
            ))}
          </ul>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center px-8 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--nest)] text-neutral-500">
              <IconInbox size={20} />
            </span>
            <p className="mt-3 text-sm font-medium text-neutral-200">{t('supportDesk.queue.emptyTitle')}</p>
            <p className="mt-1 text-xs text-neutral-500">{t('supportDesk.queue.emptyHint')}</p>
          </div>
        ) : (
          <ul>
            {rows.map((r, i) => {
              const sel = selectedId === r.id
              const mine = !!r.assigneeId && r.assigneeId === user?.id
              // 已关闭的不再标「待回复」/ closed tickets never read as awaiting reply
              const awaiting = !r.assigneeId && r.status !== 'closed'
              return (
                <li key={r.id} className="sd-rise border-b border-[var(--line)]" style={{ ['--i' as string]: Math.min(i, 12) }}>
                  <button
                    type="button"
                    onClick={() => onSelect(r.id)}
                    aria-current={sel}
                    className={`sd-row relative flex w-full gap-3 px-4 py-3.5 text-left ${sel ? 'is-sel' : ''}`}
                  >
                    <Avatar name={r.userEmail} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span
                          className={`min-w-0 flex-1 truncate text-[13px] ${
                            awaiting || sel ? 'font-semibold text-neutral-50' : 'font-medium text-neutral-200'
                          }`}
                        >
                          {r.title}
                        </span>
                        <span className="num shrink-0 text-[11px] text-neutral-500">{fmtListTime(r.updatedAt)}</span>
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-neutral-400">{r.userEmail || '-'}</span>
                      {r.latestReply && (
                        <span className="mt-0.5 block truncate text-xs text-neutral-500">
                          {r.latestReply.internal ? `${t('supportDesk.thread.internalTag')} · ` : ''}
                          {r.latestReply.body || t('tickets.images.preview')}
                        </span>
                      )}
                      <span className="mt-2 flex items-center gap-2.5">
                        <TicketStatus status={r.status} label={t(`tickets.status.${r.status}`)} />
                        <span className="truncate text-[11px] text-neutral-500">{t(`tickets.category.${r.category}`)}</span>
                        {r.priority === 'urgent' && (
                          <span className="shrink-0 rounded-full bg-[var(--down-bg)] px-1.5 py-px text-[10px] font-semibold text-[var(--down)]">
                            {t('tickets.priority.urgent')}
                          </span>
                        )}
                        {mine ? (
                          <span className="ml-auto shrink-0 rounded-full bg-[rgb(var(--purple-rgb)/0.22)] px-2 py-px text-[10px] font-semibold text-[var(--purple-hi)]">
                            {t('supportDesk.queue.me')}
                          </span>
                        ) : r.assigneeId ? (
                          <span className="ml-auto min-w-0 truncate text-[11px] text-neutral-500">
                            {t('supportDesk.queue.assignedTo', { name: r.assigneeName || '-' })}
                          </span>
                        ) : awaiting ? (
                          <span className="ml-auto shrink-0 rounded-full bg-[var(--mid-bg)] px-2 py-px text-[10px] font-semibold text-[var(--mid)]">
                            {t('supportDesk.queue.unassignedTag')}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {(page > 0 || rows.length === PAGE) && (
          <div className="flex items-center justify-center gap-3 py-4 text-xs">
            <button type="button" className="btn btn-ghost h-8 px-4 text-xs" disabled={page === 0 || loading} onClick={() => setPage(page - 1)}>
              {t('common.prevPage')}
            </button>
            <span className="num text-neutral-500">{page + 1}</span>
            <button type="button" className="btn btn-ghost h-8 px-4 text-xs" disabled={rows.length < PAGE || loading} onClick={() => setPage(page + 1)}>
              {t('common.nextPage')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
