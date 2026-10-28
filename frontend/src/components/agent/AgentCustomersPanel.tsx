// 代理页「全部客户」（rev 47 代理层级）：我和全部下级的链接带来的人，多一列「来自」。
//
// 行的口径与「我的链接」名单完全相同（零件在 customerCells），只多两样：来自哪个代理，以及
// 他自己是不是代理。可以按代理筛（「团队」里点「查看客户」就是带着筛选跳过来的）。
//
// 写操作：「升为代理」只给一级代理（canManage）；调整会员（同一个 PlanDialog，走整棵树的端点）
// 看管理员给的改会员权限（canSetPlan，rev 51，与层级无关）。
// 升为代理时新代理的上级是他注册时那条链接的主人，不是点按钮的人；层级超过上限的行按钮置灰
// 并说明原因，免得点了才吃一个 409。
//
// Agent view "All customers" (rev 47): everyone brought in through the caller's
// and every descendant's links, plus "came through" and the row's own agent
// level. Writes (membership, promote) are top-level only. A promotion's parent is
// the owner of the link the user signed up through; rows that would exceed the
// max depth get a disabled button with the reason rather than a 409 after the click.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { agentApi } from '../../api/client'
import { fmtDate, localizeApiError } from '../../api/utils'
import { useBackToClose } from '../../utils/useBackToClose'
import ConfirmModal from '../ConfirmModal'
import Select from '../Select'
import { SkeletonLine } from '../Skeleton'
import PlanDialog from './PlanDialog'
import { CardRow, LastActive, Mt5List, PlanBadge, PlanCell, planExpiryText } from './customerCells'
import type { AgentTeam, AgentTreeUser, AgentTreeUsers } from '../../api/types'

const PAGE_SIZE = 50

export default function AgentCustomersPanel({
  team,
  agentFilter,
  onAgentFilterChange,
  onPromoted,
}: {
  team: AgentTeam
  agentFilter: string
  onAgentFilterChange: (email: string) => void
  onPromoted: () => void
}) {
  const { t } = useTranslation()
  const canManage = team.canManage
  const canSetPlan = team.canSetPlan
  // 操作列：能升代理或能改会员就有。/ The action column shows when either write is allowed.
  const hasActions = canManage || canSetPlan
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<AgentTreeUsers | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<AgentTreeUser | null>(null)
  const [promoting, setPromoting] = useState<AgentTreeUser | null>(null)
  const [busy, setBusy] = useState(false)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  useBackToClose(promoting !== null, () => setPromoting(null))

  useEffect(() => {
    const id = setTimeout(() => {
      setQuery(search.trim())
      setOffset(0)
    }, 300)
    return () => clearTimeout(id)
  }, [search])

  useEffect(() => setOffset(0), [agentFilter])

  useEffect(() => {
    let alive = true
    setPage(null)
    setError(null)
    agentApi
      .customers({ limit: PAGE_SIZE, offset, q: query || undefined, agent: agentFilter || undefined })
      .then((res) => {
        if (alive) setPage(res)
      })
      .catch((err: unknown) => {
        if (alive) setError(localizeApiError(err instanceof Error ? err.message : String(err)))
      })
    return () => {
      alive = false
    }
  }, [offset, query, agentFilter])

  // 代理邮箱 → 层级：算「升为代理之后是第几级」用（上级是他来自的那个代理）。
  // Agent email → level, for "what level would a promotion create".
  const levelOf = useMemo(() => new Map(team.nodes.map((n) => [n.email, n.level])), [team.nodes])
  const nextLevel = (u: AgentTreeUser) => (u.viaEmail ? (levelOf.get(u.viaEmail) ?? 1) + 1 : null)

  const filterOptions = useMemo(
    () => [
      { value: '', label: t('agent.customers.allAgents') },
      ...team.nodes.map((n) => ({
        value: n.email,
        label: n.level != null ? `${n.nickname || n.email} · ${t('agent.team.level', { n: n.level })}` : n.nickname || n.email,
      })),
    ],
    [team.nodes, t],
  )

  const replaceRow = (updated: AgentTreeUser) =>
    setPage((cur) => (cur ? { ...cur, users: cur.users.map((u) => (u.email === updated.email ? updated : u)) } : cur))

  const promote = async () => {
    if (!promoting) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const row = await agentApi.promote(promoting.email)
      replaceRow(row)
      setNotice(t('agent.promote.done', { name: row.nickname || row.email, n: row.agentLevel ?? '' }))
      onPromoted()
    } catch (err: unknown) {
      setError(localizeApiError(err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
      setPromoting(null)
    }
  }

  const total = page?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pageNo = Math.floor(offset / PAGE_SIZE) + 1

  const via = (u: AgentTreeUser) =>
    u.viaEmail ? (
      <span className="min-w-0">
        <span className="block truncate text-neutral-200">{u.viaNickname || u.viaEmail}</span>
        {u.viaNickname && <span className="num block break-all text-[11px] text-neutral-500">{u.viaEmail}</span>}
      </span>
    ) : (
      <span className="text-neutral-500">—</span>
    )

  const agentBadge = (u: AgentTreeUser) =>
    u.isAgent && (
      <span className="ml-1.5 rounded-full bg-prism-500/15 px-1.5 py-0.5 text-[11px] text-prism-200">
        {u.agentLevel != null ? t('agent.customers.agentBadge', { n: u.agentLevel }) : t('agent.customers.agentBadgePlain')}
      </span>
    )

  // 升为代理按钮：已经是代理不出现；超过最大层级置灰并把原因写在 title 与手机上的说明里。
  // Promote: hidden for agents; disabled with the reason past the max depth.
  const promoteButton = (u: AgentTreeUser, wide = false) => {
    if (!canManage || u.isAgent) return null
    const lvl = nextLevel(u)
    const tooDeep = lvl != null && lvl > team.maxDepth
    return (
      <button
        type="button"
        className={`btn-ghost text-xs disabled:opacity-40 ${wide ? 'w-full py-1.5' : 'px-3 py-1.5'}`}
        disabled={busy || tooDeep}
        title={tooDeep ? t('agent.promote.tooDeep', { max: team.maxDepth }) : undefined}
        onClick={() => setPromoting(u)}
      >
        {t('agent.promote.button')}
      </button>
    )
  }

  const planButton = (u: AgentTreeUser, wide = false) =>
    canSetPlan && (
      <button
        type="button"
        className={`btn-ghost text-xs disabled:opacity-40 ${wide ? 'w-full py-1.5' : 'px-3 py-1.5'}`}
        disabled={u.plan === 'PRO' && !u.planExpiresAt}
        onClick={() => setEditing(u)}
      >
        {t('agent.plan.adjust')}
      </button>
    )

  return (
    <section className="mt-4">
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('agent.searchPlaceholder')}
          aria-label={t('agent.searchPlaceholder')}
          maxLength={128}
          className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-white/30 focus:outline-none sm:max-w-xs"
        />
        <Select
          className="w-full sm:w-64"
          value={agentFilter}
          ariaLabel={t('agent.customers.filterAgent')}
          onChange={onAgentFilterChange}
          options={filterOptions}
        />
        <span className="num text-xs text-neutral-500 sm:ml-auto">
          {page ? t('agent.customers.count', { n: page.total }) : ''}
        </span>
      </div>

      {canManage && <p className="mb-3 text-xs leading-relaxed text-neutral-500">{t('agent.promote.hint')}</p>}

      {notice && (
        <div className="mb-3 rounded-lg border border-up/30 bg-up/10 px-4 py-2.5 text-sm text-up" role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className="mb-3 rounded-lg border border-down/40 bg-down/15 px-4 py-2.5 text-sm text-down" role="alert">
          {error}
        </div>
      )}

      <div className="glass p-0">
        {page == null && !error ? (
          <div className="space-y-2 p-4" aria-busy="true">
            <SkeletonLine height={16} />
            <SkeletonLine width="66%" height={16} />
            <SkeletonLine width="80%" height={16} />
          </div>
        ) : page && page.users.length === 0 ? (
          <div className="p-8 text-center text-sm text-neutral-500">
            {t(query ? 'agent.searchEmpty' : 'agent.customers.empty')}
          </div>
        ) : page ? (
          <>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="px-4 py-3 font-medium">{t('agent.colUser')}</th>
                    <th className="px-4 py-3 font-medium">{t('agent.customers.colVia')}</th>
                    <th className="px-4 py-3 font-medium">{t('agent.colPlan')}</th>
                    <th className="px-4 py-3 font-medium">{t('agent.colMt5')}</th>
                    <th className="px-4 py-3 font-medium">{t('agent.colActive')}</th>
                    <th className="px-4 py-3 font-medium">{t('agent.colRegistered')}</th>
                    {hasActions && <th className="px-4 py-3 text-right font-medium">{t('agent.colAction')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {page.users.map((u, i) => (
                    <tr key={`${u.email}-${i}`} className="border-b border-white/5 align-top last:border-0">
                      <td className="px-4 py-3">
                        <span className="block text-neutral-100">
                          {u.nickname || <span className="text-neutral-500">{t('agent.noNickname')}</span>}
                          {agentBadge(u)}
                        </span>
                        <span className="num block break-all text-xs text-neutral-400">{u.email}</span>
                      </td>
                      <td className="px-4 py-3 text-xs">{via(u)}</td>
                      <td className="px-4 py-3">
                        <PlanCell user={u} />
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <Mt5List accounts={u.mt5Accounts} />
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <LastActive day={u.lastActiveDay} />
                      </td>
                      <td className="num whitespace-nowrap px-4 py-3 text-xs text-neutral-400">{fmtDate(u.createdAt)}</td>
                      {hasActions && (
                        <td className="px-4 py-3 text-right">
                          <div className="flex flex-wrap justify-end gap-2">
                            {planButton(u)}
                            {promoteButton(u)}
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-white/5 sm:hidden">
              {page.users.map((u, i) => (
                <li key={`${u.email}-${i}`} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm text-neutral-100">
                        {u.nickname || <span className="text-neutral-500">{t('agent.noNickname')}</span>}
                        {agentBadge(u)}
                      </p>
                      <p className="num break-all text-xs text-neutral-400">{u.email}</p>
                    </div>
                    <PlanBadge plan={u.plan} />
                  </div>
                  <CardRow label={t('agent.customers.colVia')}>{via(u)}</CardRow>
                  {planExpiryText(u, t) && (
                    <CardRow label={t('agent.colExpiry')}>
                      <span className="num text-neutral-300">{planExpiryText(u, t)}</span>
                    </CardRow>
                  )}
                  <CardRow label={t('agent.colActive')}>
                    <LastActive day={u.lastActiveDay} />
                  </CardRow>
                  <CardRow label={t('agent.colRegistered')}>
                    <span className="num text-neutral-400">{fmtDate(u.createdAt)}</span>
                  </CardRow>
                  <CardRow label={t('agent.colMt5')}>
                    <Mt5List accounts={u.mt5Accounts} />
                  </CardRow>
                  {hasActions && (
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      {planButton(u, true)}
                      {promoteButton(u, true)}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {pages > 1 && (
              <div className="flex items-center justify-between gap-3 border-t border-white/10 px-4 py-3 text-xs text-neutral-400">
                <button
                  type="button"
                  className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-40"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  {t('agent.prev')}
                </button>
                <span className="num">{t('agent.pageOf', { page: pageNo, pages })}</span>
                <button
                  type="button"
                  className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-40"
                  disabled={offset + PAGE_SIZE >= total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  {t('agent.next')}
                </button>
              </div>
            )}
          </>
        ) : null}
      </div>

      {editing && (
        <PlanDialog
          linkId={null}
          user={editing}
          onDone={(updated) => {
            replaceRow(updated)
            setEditing(null)
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {promoting && (
        <ConfirmModal
          center
          busy={busy}
          title={t('agent.promote.title')}
          message={t('agent.promote.body', {
            name: promoting.nickname || promoting.email,
            parent: promoting.viaNickname || promoting.viaEmail || '',
            n: nextLevel(promoting) ?? '',
          })}
          confirmLabel={t('agent.promote.button')}
          onConfirm={() => void promote()}
          onCancel={() => setPromoting(null)}
        />
      )}
    </section>
  )
}
