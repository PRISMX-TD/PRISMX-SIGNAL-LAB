// 跟进页左栏：上面切「跟进客户 / 我的申请」，客户名单按状态标签筛选（只是标签，随时可改）。
// 名单顺序沿用后端（下次跟进时间、优先级、分配时间）。我的申请看补偿 / 申请跟进 / 开户标记审到哪了，
// 点一行打开那位客户。数据由 FollowUpsView 统一拉，这里只负责显示。
// The follow-ups page's left pane: a switch between customers and my requests; customers filter by
// status label (labels only, always changeable). Order is the backend's. Requests show where comp
// days / follow-up / open-account claims stand; a row opens that customer. FollowUpsView owns the
// data; this only renders it.
import { useTranslation } from 'react-i18next'
import type { FollowUp, FollowUpStaffStatus, SupportRequest } from '../../api/supportTypes'
import { FOLLOW_UP_STAFF_STATUSES } from '../../api/supportTypes'
import { SkeletonLine } from '../Skeleton'
import { IconUsers } from './deskIcons'
import { Avatar, FU_PRIORITY_TONE, FU_STATUS_TONE, Tag, fmtListTime } from './supportUi'

export type FuFilter = 'all' | FollowUpStaffStatus
export type FuMode = 'customers' | 'requests'

const REQ_TONE: Record<string, string> = {
  pending: 'bg-amber-400/15 text-amber-300',
  approved: 'bg-[var(--up-bg)] text-[var(--up)]',
  rejected: 'bg-[var(--down-bg)] text-[var(--down)]',
}

export default function FollowUpList({
  items,
  total,
  requests,
  loading,
  filter,
  onFilter,
  mode,
  onMode,
  selectedUserId,
  onSelect,
}: {
  items: FollowUp[]
  total: number
  requests: SupportRequest[]
  loading: boolean
  filter: FuFilter
  onFilter: (f: FuFilter) => void
  mode: FuMode
  onMode: (m: FuMode) => void
  selectedUserId: string | null
  onSelect: (userId: string) => void
}) {
  const { t } = useTranslation()
  const counts = FOLLOW_UP_STAFF_STATUSES.reduce<Record<string, number>>((acc, s) => {
    acc[s] = items.filter((f) => f.status === s).length
    return acc
  }, {})
  const shown = filter === 'all' ? items : items.filter((f) => f.status === filter)
  const pendingReq = requests.filter((r) => r.status === 'pending').length

  const chip = (key: FuFilter, label: string, n: number) => (
    <button
      key={key}
      type="button"
      aria-pressed={filter === key}
      onClick={() => onFilter(key)}
      className={`inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium transition ${
        filter === key ? 'bg-[var(--surface-2)] text-neutral-100 shadow-[inset_0_0_0_1px_var(--line-hi)]' : 'text-neutral-500 hover:text-neutral-200'
      }`}
    >
      {label}
      <span className="num text-[10px] text-neutral-500">{n}</span>
    </button>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2.5 px-3 pb-3 pt-3">
        <div className="sd-seg" role="group" aria-label={t('supportDesk.tab.followUps')}>
          <button type="button" aria-pressed={mode === 'customers'} onClick={() => onMode('customers')} className={mode === 'customers' ? 'is-on' : ''}>
            {t('supportDesk.followUps.tabCustomers')}
            <span className="num ml-1.5 text-[11px] text-neutral-500">{total}</span>
          </button>
          <button type="button" aria-pressed={mode === 'requests'} onClick={() => onMode('requests')} className={mode === 'requests' ? 'is-on' : ''}>
            {t('supportDesk.requests.title')}
            {pendingReq > 0 && <span className="num ml-1.5 text-[11px] text-amber-300">{pendingReq}</span>}
          </button>
        </div>
        {mode === 'customers' && items.length > 0 && (
          <div className="flex flex-wrap gap-1" role="group" aria-label={t('supportDesk.card.status')}>
            {chip('all', t('supportDesk.queue.all'), items.length)}
            {FOLLOW_UP_STAFF_STATUSES.filter((s) => counts[s] > 0 || filter === s).map((s) => chip(s, t(`supportDesk.status.${s}`), counts[s]))}
          </div>
        )}
      </div>

      <div className="sd-scroll min-h-0 flex-1 overflow-y-auto border-t border-[var(--line)]">
        {loading && items.length === 0 ? (
          <ul aria-busy="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i} className="flex gap-3 border-b border-[var(--line)] px-4 py-3.5">
                <SkeletonLine width={34} height={34} />
                <div className="flex-1 space-y-2">
                  <SkeletonLine width="50%" height={12} />
                  <SkeletonLine width="70%" height={10} />
                </div>
              </li>
            ))}
          </ul>
        ) : mode === 'requests' ? (
          requests.length === 0 ? (
            <p className="px-6 py-14 text-center text-xs text-neutral-500">{t('supportDesk.followUps.requestsEmpty')}</p>
          ) : (
            <ul>
              {requests.map((r, i) => (
                <li key={r.id} className="sd-rise border-b border-[var(--line)]" style={{ ['--i' as string]: Math.min(i, 12) }}>
                  <button
                    type="button"
                    onClick={() => onSelect(r.targetUserId)}
                    className={`sd-row relative w-full px-4 py-3.5 text-left ${selectedUserId === r.targetUserId ? 'is-sel' : ''}`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-neutral-100">{t(`supportDesk.requests.kind.${r.kind}`)}</span>
                      <Tag tone={REQ_TONE[r.status] ?? ''}>{t(`supportDesk.requests.status.${r.status}`)}</Tag>
                    </span>
                    <span className="mt-1 flex items-center gap-2 text-xs text-neutral-500">
                      <span className="min-w-0 flex-1 truncate text-neutral-400">{r.targetName || t('supportDesk.card.noNickname')}</span>
                      <span className="num shrink-0 text-[11px]">{fmtListTime(r.createdAt)}</span>
                    </span>
                    {r.note && <span className="mt-1 block truncate text-xs text-neutral-500">{r.note}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center px-8 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--nest)] text-neutral-500">
              <IconUsers size={20} />
            </span>
            <p className="mt-3 text-sm font-medium text-neutral-200">{t('supportDesk.followUps.empty')}</p>
            <p className="mt-1 text-xs text-neutral-500">{t('supportDesk.followUps.emptyHint')}</p>
          </div>
        ) : shown.length === 0 ? (
          <p className="px-6 py-14 text-center text-xs text-neutral-500">{t('supportDesk.followUps.noMatch')}</p>
        ) : (
          <ul>
            {shown.map((f, i) => {
              const sel = selectedUserId === f.userId
              return (
                <li key={f.id} className="sd-rise border-b border-[var(--line)]" style={{ ['--i' as string]: Math.min(i, 12) }}>
                  <button
                    type="button"
                    onClick={() => onSelect(f.userId)}
                    aria-current={sel}
                    className={`sd-row relative flex w-full gap-3 px-4 py-3.5 text-left ${sel ? 'is-sel' : ''}`}
                  >
                    <Avatar name={f.nickname || f.email} size={34} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className={`min-w-0 flex-1 truncate text-[13px] ${sel ? 'font-semibold text-neutral-50' : 'font-medium text-neutral-100'}`}>
                          {f.nickname || t('supportDesk.card.noNickname')}
                        </span>
                        <Tag tone={FU_STATUS_TONE[f.status]}>{t(`supportDesk.status.${f.status}`)}</Tag>
                      </span>
                      <span className="mt-1 flex items-center gap-2 text-xs text-neutral-500">
                        <span className="min-w-0 flex-1 truncate text-neutral-400">{t(`supportDesk.goal.${f.goal}`)}</span>
                        {f.priority === 'high' && <Tag tone={FU_PRIORITY_TONE.high}>{t('supportDesk.priority.high')}</Tag>}
                        <span className="num shrink-0 text-[11px]">{fmtListTime(f.createdAt)}</span>
                      </span>
                      {f.note && <span className="mt-1 block truncate text-xs text-neutral-500">{f.note}</span>}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
