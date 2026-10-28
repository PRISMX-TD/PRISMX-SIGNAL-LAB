// 管理端用户档案（2026-10-28）：一个接口（GET /admin/users/{id}/overview）给齐资料、MT5、登录 IP、
// 最近动态。两种用法：UserDrawer 从任何列表点开的抽屉；工单详情右栏直接嵌一份（不用离开工单就能
// 核对比赛名次、转盘奖品）。凡是客户信息都能点一下复制。
// The admin user profile (2026-10-28): one endpoint (GET /admin/users/{id}/overview) returns the
// details, MT5 accounts, login IPs and recent activity. Two uses: UserDrawer, opened from any list;
// and embedded in the ticket detail's side column, so contest ranks and wheel prizes can be checked
// without leaving the ticket. Every piece of customer info copies on click.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { AdminUserOverview } from '../../../api/supportTypes'
import { fmtDate, fmtDay } from '../../../api/utils'
import Copyable, { copyToClipboard, flashCopied } from '../../Copyable'
import { SkeletonLine } from '../../Skeleton'
import ActivityTimeline from '../../support/ActivityTimeline'
import { Avatar } from '../../support/supportUi'
import AdminSheet from '../AdminSheet'

// 控制台外壳提供：打开档案、以及从档案跳去别的分区 / provided by the console shell
export interface UserDrawerActions {
  openUser: (userId: string) => void
  showLogs?: (userId: string, label: string) => void
  emailUser?: (userId: string) => void
  findInList?: (email: string) => void
  openTicket?: (ticketId: string) => void
}

export const UserDrawerContext = createContext<UserDrawerActions | null>(null)

export function useUserDrawer() {
  return useContext(UserDrawerContext)
}

// 头像 / 名字做成「打开档案」的按钮；不在控制台里（没有 provider）就是普通元素。
// Makes an avatar / name an "open profile" button; plain when there is no provider.
export function OpenUserButton({ userId, children, className = '' }: { userId: string | null | undefined; children: ReactNode; className?: string }) {
  const { t } = useTranslation()
  const ctx = useUserDrawer()
  if (!ctx || !userId) return <>{children}</>
  return (
    <span
      role="button"
      tabIndex={0}
      title={t('admin.userDrawer.openHint')}
      aria-label={t('admin.userDrawer.open')}
      className={`cursor-pointer rounded-full transition hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--purple-hi)] ${className}`}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        ctx.openUser(userId)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          e.stopPropagation()
          ctx.openUser(userId)
        }
      }}
    >
      {children}
    </span>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl border border-[var(--line)] bg-white/[0.02] px-3 py-2">
      <div className="truncate text-[11px] text-neutral-500">{label}</div>
      <div className="mt-0.5 truncate text-[13px] font-medium text-neutral-100">{children}</div>
    </div>
  )
}

function Section({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-t border-[var(--line)] pt-4">
      <div className="mb-3 flex items-center gap-2">
        <h4 className="text-[13px] font-semibold text-neutral-100">{title}</h4>
        {extra && <div className="ml-auto">{extra}</div>}
      </div>
      {children}
    </section>
  )
}

// 「复制资料」的纯文本：发给同事或贴进工单备注 / plain-text summary for "copy details"
export function overviewText(o: AdminUserOverview): string {
  const u = o.user
  const c = o.customer
  const lines = [
    `${u.nickname || '-'} <${u.email}>`,
    u.phone ? `Phone: ${u.phone}` : null,
    `Plan: ${u.plan}${u.planExpiresAt ? ` → ${fmtDay(u.planExpiresAt)}` : ''}`,
    `ID: ${u.id}`,
    ...c.mt5Accounts.map((a) => `MT5: ${a.login ?? '-'} ${a.server ?? a.broker ?? ''}`.trim()),
    c.inviteLabel || c.inviteCode ? `Source: ${c.inviteLabel || c.inviteCode}` : null,
    u.agentEmail ? `Ambassador: ${u.agentEmail}` : null,
  ]
  return lines.filter(Boolean).join('\n')
}

export function UserOverviewBody({ userId, compact = false }: { userId: string; compact?: boolean }) {
  const { t } = useTranslation()
  const ctx = useUserDrawer()
  const [data, setData] = useState<AdminUserOverview | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(() => {
    setErr(null)
    setData(null)
    let alive = true
    adminApi
      .userOverview(userId)
      .then((d) => { if (alive) setData(d) })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : t('admin.userDrawer.loadFail')) })
    return () => { alive = false }
  }, [userId, t])

  useEffect(() => load(), [load])

  if (err) {
    return (
      <div className="py-8 text-center text-sm">
        <p className="text-down">{err}</p>
        <button type="button" className="adm-btn mt-3" onClick={() => load()}>
          {t('admin.userDrawer.retry')}
        </button>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="space-y-3 py-2">
        <div className="flex items-center gap-3">
          <SkeletonLine width={44} height={44} />
          <div className="flex-1 space-y-2">
            <SkeletonLine width="45%" height={14} />
            <SkeletonLine width="65%" height={10} />
          </div>
        </div>
        <SkeletonLine height={56} />
        <SkeletonLine width="80%" />
        <SkeletonLine width="60%" />
      </div>
    )
  }

  const u = data.user
  const c = data.customer
  const disabled = !!u.disabledAt
  const label = u.nickname || u.email

  return (
    <div className="space-y-4">
      {/* 身份 / identity */}
      <div className="flex items-start gap-3">
        <Avatar name={label} size={compact ? 40 : 46} tone={u.role === 'user' ? 'neutral' : 'staff'} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[16px] font-semibold text-neutral-50">
            {u.nickname ? <Copyable text={u.nickname} label={t('supportDesk.copy.nickname')} /> : <span className="text-neutral-500">-</span>}
          </div>
          <div className="truncate font-mono text-xs text-neutral-400">
            <Copyable text={u.email} label={t('supportDesk.copy.email')} />
          </div>
          {u.phone && (
            <div className="truncate font-mono text-xs text-neutral-400">
              <Copyable text={u.phone} label={t('supportDesk.copy.phone')} />
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className={`adm-pill ${u.plan === 'PRO' ? 'is-brand' : ''}`}>
              {u.plan}
              {c.planIsTrial ? ` · ${t('admin.userDrawer.trial')}` : ''}
            </span>
            {u.role !== 'user' && <span className="adm-pill is-info">{t(`admin.support.role.${u.role}`, { defaultValue: u.role })}</span>}
            <span className={`adm-pill ${u.emailVerifiedAt ? 'is-up' : 'is-warn'}`}>
              {u.emailVerifiedAt ? t('admin.userDrawer.verified') : t('admin.userDrawer.unverified')}
            </span>
            {disabled && <span className="adm-pill is-down">{t('admin.userDrawer.disabled')}</span>}
          </div>
        </div>
      </div>

      {/* 概况 / facts */}
      <div className={`grid gap-2 ${compact ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3'}`}>
        <Fact label={t('admin.userDrawer.expires')}>
          {u.plan === 'PRO' ? (u.planExpiresAt ? fmtDay(u.planExpiresAt) : t('admin.userDrawer.permanent')) : '-'}
        </Fact>
        <Fact label={t('admin.userDrawer.registered')}>{fmtDay(u.createdAt, '-')}</Fact>
        <Fact label={t('admin.userDrawer.lastActive')}>{u.lastActiveAt ? fmtDate(u.lastActiveAt) : '-'}</Fact>
        {c.paidTotalUsd != null && <Fact label={t('admin.userDrawer.paid')}>{`$${c.paidTotalUsd.toFixed(2)}`}</Fact>}
        <Fact label={t('admin.userDrawer.source')}>{c.inviteLabel || c.inviteCode || '-'}</Fact>
        <Fact label={t('admin.userDrawer.agent')}>
          {u.agentEmail ? <Copyable text={u.agentEmail} label={t('supportDesk.copy.email')} /> : '-'}
        </Fact>
      </div>
      {u.planNote && (
        <p className="rounded-xl border-l-2 border-[var(--purple-hi)] bg-white/[0.025] px-3 py-2 text-xs text-neutral-300">
          <span className="mr-1 text-neutral-500">{t('admin.userDrawer.note')}</span>
          <Copyable text={u.planNote} />
        </p>
      )}

      {/* 快捷操作 / actions */}
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          className="adm-btn"
          onClick={(e) => {
            const el = e.currentTarget
            void copyToClipboard(overviewText(data)).then((ok) =>
              flashCopied(el, ok ? t('admin.userDrawer.copyAllDone') : t('supportDesk.copy.failed'), !ok),
            )
          }}
        >
          {t('admin.userDrawer.copyAll')}
        </button>
        {ctx?.showLogs && (
          <button type="button" className="adm-btn" onClick={() => ctx.showLogs?.(u.id, label)}>
            {t('admin.userDrawer.logs')}
          </button>
        )}
        {ctx?.emailUser && (
          <button type="button" className="adm-btn" onClick={() => ctx.emailUser?.(u.id)}>
            {t('admin.bulkEmail')}
          </button>
        )}
        {ctx?.findInList && (
          <button type="button" className="adm-btn" onClick={() => ctx.findInList?.(u.email)}>
            {t('admin.userDrawer.findInList')}
          </button>
        )}
      </div>

      <Section title={t('supportDesk.activity.title')}>
        <ActivityTimeline items={data.activity} initial={compact ? 5 : 8} onOpenTicket={ctx?.openTicket} />
      </Section>

      <Section title={t('admin.userDrawer.mt5')}>
        {c.mt5Accounts.length === 0 ? (
          <p className="text-xs text-neutral-500">{t('admin.userDrawer.noMt5')}</p>
        ) : (
          <ul className="grid gap-2">
            {c.mt5Accounts.map((a) => (
              <li key={a.id} className="rounded-xl border border-[var(--line)] bg-white/[0.02] px-3 py-2.5 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13px] font-medium text-neutral-100">
                    <Copyable text={a.login} label={t('supportDesk.copy.account')} />
                  </span>
                  {a.real != null && (
                    <span className={`adm-pill ${a.real ? 'is-up' : ''}`}>{a.real ? t('admin.userDrawer.real') : t('admin.userDrawer.demo')}</span>
                  )}
                  <span className={`ml-auto text-[11px] ${a.online ? 'text-[var(--up)]' : 'text-neutral-500'}`}>
                    {a.online ? t('admin.userDrawer.online') : t('admin.userDrawer.offline')}
                  </span>
                </div>
                {(a.server || a.broker) && (
                  <div className="mt-1 text-neutral-500">
                    <Copyable text={a.server || a.broker} />
                  </div>
                )}
                {a.balance != null && (
                  <div className="mt-1 text-neutral-400">
                    {t('admin.userDrawer.balance')} <span className="num text-neutral-100">{a.balance.toFixed(2)}</span>
                    {a.equity != null && (
                      <>
                        {' · '}
                        {t('admin.userDrawer.equity')} <span className="num text-neutral-100">{a.equity.toFixed(2)}</span>
                      </>
                    )}
                    {a.currency ? ` ${a.currency}` : ''}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={t('admin.userDrawer.ips')}
        extra={data.sameIpUsers > 0 ? <span className="adm-pill is-warn">{t('admin.userDrawer.sameIp', { n: data.sameIpUsers })}</span> : undefined}
      >
        {data.ips.length === 0 ? (
          <p className="text-xs text-neutral-500">{t('admin.userDrawer.noIps')}</p>
        ) : (
          <ul className="space-y-1.5 text-xs">
            {data.ips.map((ip) => (
              <li key={ip.ip} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-mono text-neutral-200">
                  <Copyable text={ip.ip} />
                </span>
                {ip.place && <span className="text-neutral-400">{ip.place}</span>}
                <span className="num ml-auto text-[11px] text-neutral-500">{fmtDate(ip.lastSeenAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

export default function UserDrawer({ userId, onClose }: { userId: string; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <AdminSheet title={t('admin.userDrawer.title')} onClose={onClose} widthClass="sm:w-[580px]">
      <div className="mt-4">
        <UserOverviewBody key={userId} userId={userId} />
      </div>
    </AdminSheet>
  )
}
