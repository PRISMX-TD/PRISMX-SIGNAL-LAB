// 跟进页没选客户时的右侧：跟进概览。一条按状态分段的比例条、每个状态一格（点一下就在左边按它筛选）、
// 跟进目标的分布，以及高优先级人数。数字全部来自左边那份名单，不另外请求。
// The follow-ups page's right side when no customer is open: a proportion bar split by status, one
// tile per status (clicking filters the list), the goal mix and the high-priority count. Every
// number comes from the roster already loaded; nothing is fetched here.
import { useTranslation } from 'react-i18next'
import { FOLLOW_UP_GOALS, FOLLOW_UP_STAFF_STATUSES, type FollowUp, type FollowUpStaffStatus } from '../../api/supportTypes'
import { SkeletonLine } from '../Skeleton'
import { IconUsers } from './deskIcons'

// 比例条与格子上的状态色（实色），与标签同一套色相 / solid status colours, same hues as the labels
const SOLID: Record<FollowUpStaffStatus, string> = {
  pending: 'bg-amber-400',
  contacted: 'bg-blue-400',
  interested: 'bg-[var(--purple-hi)]',
  converted: 'bg-[var(--up)]',
  no_interest: 'bg-neutral-500',
  unreachable: 'bg-neutral-600',
}

export default function FollowUpOverview({
  items,
  total,
  loading,
  onPick,
}: {
  items: FollowUp[]
  total: number
  loading: boolean
  onPick: (status: FollowUpStaffStatus) => void
}) {
  const { t } = useTranslation()

  if (loading && items.length === 0) {
    return (
      <div className="mx-auto max-w-[760px] space-y-4 px-6 py-10 sm:px-10">
        <SkeletonLine width={160} height={22} />
        <SkeletonLine width={220} height={12} />
        <SkeletonLine height={10} />
        <div className="grid grid-cols-3 gap-2">
          {[0, 1, 2, 3, 4, 5].map((i) => <SkeletonLine key={i} height={76} />)}
        </div>
      </div>
    )
  }

  if (total === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 py-16 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--nest)] text-neutral-400">
          <IconUsers size={24} />
        </span>
        <p className="mt-4 font-display text-[15px] font-semibold text-neutral-100">{t('supportDesk.followUps.empty')}</p>
        <p className="mt-1.5 max-w-[20rem] text-xs leading-relaxed text-neutral-500">{t('supportDesk.followUps.emptyHint')}</p>
      </div>
    )
  }

  const byStatus = FOLLOW_UP_STAFF_STATUSES.map((s) => ({ s, n: items.filter((f) => f.status === s).length }))
  const byGoal = FOLLOW_UP_GOALS.map((g) => ({ g, n: items.filter((f) => f.goal === g).length })).filter((x) => x.n > 0)
  const maxGoal = Math.max(1, ...byGoal.map((x) => x.n))
  const high = items.filter((f) => f.priority === 'high').length

  return (
    <div className="mx-auto max-w-[760px] px-6 py-10 sm:px-10">
      <h2 className="font-display text-[22px] font-semibold tracking-tight text-neutral-50">{t('supportDesk.followUps.overviewTitle')}</h2>
      <p className="mt-1 text-sm text-neutral-400">
        {t('supportDesk.followUps.overviewLead', { n: total })}
        {high > 0 && <span className="ml-2 text-[var(--down)]">{t('supportDesk.followUps.highCount', { n: high })}</span>}
      </p>

      {/* 按状态分段的比例条 / proportion bar by status */}
      <div className="mt-7 flex h-2.5 gap-[3px] overflow-hidden rounded-full" aria-hidden="true">
        {byStatus.filter((x) => x.n > 0).map((x) => (
          <span key={x.s} className={`${SOLID[x.s]} h-full`} style={{ flexGrow: x.n, flexBasis: 0 }} />
        ))}
      </div>

      <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {byStatus.map((x) => (
          <button
            key={x.s}
            type="button"
            onClick={() => onPick(x.s)}
            disabled={x.n === 0}
            className="sd-fact text-left transition hover:border-[var(--line-hi)] hover:bg-white/[0.05] disabled:cursor-default disabled:opacity-50 disabled:hover:border-[var(--line)] disabled:hover:bg-white/[0.03]"
          >
            <span className="flex items-center gap-2 text-[11px] text-neutral-400">
              <i className={`h-2 w-2 rounded-full ${SOLID[x.s]}`} aria-hidden="true" />
              {t(`supportDesk.status.${x.s}`)}
            </span>
            <span className="num mt-2 block text-[26px] font-semibold leading-none text-neutral-50">{x.n}</span>
          </button>
        ))}
      </div>

      {byGoal.length > 0 && (
        <div className="mt-9">
          <h3 className="text-[13px] font-semibold text-neutral-100">{t('supportDesk.card.goal')}</h3>
          <ul className="mt-3 space-y-3">
            {byGoal.map((x) => (
              <li key={x.g} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_2.5rem] items-center gap-3 text-xs">
                <span className="truncate text-neutral-300">{t(`supportDesk.goal.${x.g}`)}</span>
                <span className="h-1.5 rounded-full bg-[rgb(var(--purple-hi-rgb)/0.7)]" style={{ width: `${Math.max(4, (x.n / maxGoal) * 100)}%` }} />
                <span className="num text-right text-neutral-400">{x.n}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-10 border-t border-[var(--line)] pt-5 text-xs text-neutral-500">{t('supportDesk.followUps.pickHint')}</p>
    </div>
  )
}
