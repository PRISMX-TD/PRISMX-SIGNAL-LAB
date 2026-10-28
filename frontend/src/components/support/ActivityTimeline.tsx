// 用户「最近动态」时间线（2026-10-28）：比赛报名与名次、转盘奖品、付款、会员变更、工单、登录 / 绑定。
// 后端 services/user_activity.py 已按查看者权限裁剪，这里只负责显示。客服台客户卡片与管理端
// 用户档案共用；默认只露前几条，「显示全部」展开。
// The recent-activity timeline (2026-10-28): contest entries and ranks, wheel prizes, payments,
// plan changes, tickets, logins / binds. The backend (services/user_activity.py) already trims
// per viewer; this only renders. Shared by the desk's customer card and the admin user drawer;
// the first few show by default, "show all" expands.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fmtDate, fmtDay } from '../../api/utils'
import type { UserActivityItem } from '../../api/supportTypes'

const DOT: Record<UserActivityItem['kind'], string> = {
  signup: 'bg-neutral-500',
  comp: 'bg-amber-400',
  lucky: 'bg-pink-400',
  payment: 'bg-up',
  plan: 'bg-[var(--purple-hi)]',
  ticket: 'bg-blue-400',
  event: 'bg-neutral-600',
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`

export default function ActivityTimeline({
  items,
  initial = 6,
  onOpenTicket,
}: {
  items: UserActivityItem[] | undefined
  initial?: number
  onOpenTicket?: (ticketId: string) => void
}) {
  const { t } = useTranslation()
  const [all, setAll] = useState(false)
  if (!items || items.length === 0) return <p className="text-xs text-neutral-500">{t('supportDesk.activity.empty')}</p>
  const shown = all ? items : items.slice(0, initial)

  const planValue = (field: string, v: string | null) => {
    if (!v) return '-'
    return field === 'plan_expires_at' ? fmtDay(v, v) : v
  }

  const line = (it: UserActivityItem) => {
    switch (it.kind) {
      case 'signup':
        return { main: t('supportDesk.activity.signup') }
      case 'comp': {
        const rank = it.disqualified
          ? t('supportDesk.activity.dq')
          : it.rank == null
            ? t('supportDesk.activity.unranked')
            : it.total
              ? t('supportDesk.activity.rankOf', { rank: it.rank, total: it.total })
              : t('supportDesk.activity.rank', { rank: it.rank })
        const score =
          it.score == null || it.disqualified
            ? null
            : it.metric === 'win_rate'
              ? t('supportDesk.activity.winRate', { v: pct(it.score) })
              : t('supportDesk.activity.return', { v: pct(it.score) })
        return {
          main: t('supportDesk.activity.compJoin', { name: it.name }),
          chips: [t(`supportDesk.activity.compStatus.${it.status}`, { defaultValue: it.status })],
          sub: [rank, score, it.login].filter(Boolean).join(' · '),
          strong: !it.disqualified && it.rank != null && it.rank <= 3,
        }
      }
      case 'lucky':
        return {
          main: it.soldOut ? t('supportDesk.activity.luckySoldOut') : t('supportDesk.activity.lucky', { prize: it.prize ?? '-' }),
          chips: it.soldOut ? [] : [t(`supportDesk.activity.luckyStatus.${it.status}`, { defaultValue: it.status })],
          ticketId: it.ticketId,
        }
      case 'payment':
        return { main: t('supportDesk.activity.payment', { amount: it.amountUsd.toFixed(2), plan: it.plan }) }
      case 'plan':
        return {
          main: t('supportDesk.activity.plan', {
            field: t(`supportDesk.activity.field.${it.field}`, { defaultValue: it.field }),
            old: planValue(it.field, it.old),
            new: planValue(it.field, it.new),
          }),
          sub: it.by ? t('supportDesk.activity.by', { name: it.by }) : undefined,
        }
      case 'ticket':
        return {
          main: t('supportDesk.activity.ticket', { title: it.title }),
          chips: [t(`tickets.category.${it.category}`, { defaultValue: it.category })],
          ticketId: it.ticketId,
        }
      case 'event':
        return {
          main: t(`supportDesk.activity.event.${it.event.replace(/\./g, '_')}`, {
            login: it.login ?? '',
            defaultValue: t('supportDesk.activity.event.other'),
          }),
        }
    }
  }

  return (
    <div>
      <ol className="relative ml-1.5 space-y-3 border-l border-white/10 pl-4">
        {shown.map((it, i) => {
          const l = line(it)
          const ticketId = 'ticketId' in l ? l.ticketId : null
          return (
            <li key={`${it.kind}-${it.at}-${i}`} className="relative">
              <span className={`absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-[var(--surface)] ${DOT[it.kind]}`} aria-hidden="true" />
              <div className="flex flex-wrap items-center gap-1.5 text-[13px] leading-snug">
                {ticketId && onOpenTicket ? (
                  <button type="button" className="text-left text-neutral-100 underline-offset-2 hover:underline" onClick={() => onOpenTicket(ticketId)}>
                    {l.main}
                  </button>
                ) : (
                  <span className={'strong' in l && l.strong ? 'font-semibold text-amber-200' : 'text-neutral-100'}>{l.main}</span>
                )}
                {'chips' in l &&
                  l.chips?.map((c) => (
                    <span key={c} className="rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-neutral-400">
                      {c}
                    </span>
                  ))}
              </div>
              {'sub' in l && l.sub && <div className="mt-0.5 text-[11px] text-neutral-400">{l.sub}</div>}
              <div className="num text-[11px] text-neutral-500">{fmtDate(it.at)}</div>
            </li>
          )
        })}
      </ol>
      {items.length > initial && (
        <button type="button" className="mt-3 text-[11px] font-medium text-[var(--purple-hi)] hover:underline" onClick={() => setAll((v) => !v)}>
          {all ? t('supportDesk.activity.less') : t('supportDesk.activity.more', { n: items.length })}
        </button>
      )}
    </div>
  )
}
