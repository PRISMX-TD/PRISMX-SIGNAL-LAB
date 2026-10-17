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
        { limit: PAGE, offset: page * PAGE },
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
  }, [page, onError, t])

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
    <div className="flex min-h-0 flex-col gap-3">
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
                  {r.assigneeId && r.assigneeId === user?.id ? (
                    <span className="ml-auto shrink-0 rounded-md bg-prism-600/20 px-1.5 py-0.5 text-[11px] font-medium text-prism-200">
                      {t('supportDesk.queue.me')}
                    </span>
                  ) : r.assigneeId ? (
                    <span className="ml-auto truncate text-[11px] text-neutral-400">
                      {t('supportDesk.queue.assignedTo', { name: r.assigneeName || '—' })}
                    </span>
                  ) : (
                    <span className="ml-auto shrink-0 text-[11px] text-amber-300/80">{t('supportDesk.queue.unassignedTag')}</span>
                  )}
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
