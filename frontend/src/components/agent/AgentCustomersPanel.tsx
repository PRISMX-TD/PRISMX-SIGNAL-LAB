// 代理页「全部客户」（rev 47 代理层级）：我和全部下级的链接带来的人，多一列「来自」。
//
// 行的口径与「我的链接」名单完全相同（零件在 customerCells），只多两样：来自哪个代理，以及
// 他自己是不是代理。可以按代理筛（「团队」里点「查看客户」就是带着筛选跳过来的）。
//
// 写操作：「升为代理」一级代理（canManage）整棵树都能升，二级起（canPromote，最后一级没有）只能升
// 自己的直属客户，弹窗与提示里不出现层级；调整会员（同一个 PlanDialog，走整棵树的端点）
// 看管理员给的改会员权限（canSetPlan，rev 51，与层级无关）。
// 升为代理时新代理的上级是他注册时那条链接的主人，不是点按钮的人；层级超过上限的行按钮置灰
// 并说明原因，免得点了才吃一个 409。
//
// Agent view "All customers" (rev 47): everyone brought in through the caller's
// and every descendant's links, plus "came through" and the row's own agent
// level. Top-level agents promote anyone in the tree; lower ones (not the last level)
// only their own direct clients, with no level shown. A promotion's parent is
// the owner of the link the user signed up through; rows that would exceed the
// max depth get a disabled button with the reason rather than a 409 after the click.
//
// 2026-10-28 重画：顶上一条工具栏（搜索、按推荐官筛、人数），行用和「我的链接」名单同一套零件
// （头像 + 名字、等级、活跃点），「来自」也带首字头像；手机上是事实格卡片。
// Redrawn 2026-10-28: one toolbar (search, ambassador filter, count); rows use the same parts
// as the per-link list (avatar + name, tier, activity dot), "came through" gets an initial
// avatar too; phones get fact-grid cards.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { agentApi } from '../../api/client'
import { fmtDate, localizeApiError } from '../../api/utils'
import { useBackToClose } from '../../utils/useBackToClose'
import ConfirmModal from '../ConfirmModal'
import Select from '../Select'
import { SkeletonLine } from '../Skeleton'
import PlanDialog from './PlanDialog'
import { IconInfo } from './agentIcons'
import {
  EmptyState,
  Fact,
  LastActive,
  Mt5List,
  Pager,
  Person,
  PlanBadge,
  PlanCell,
  SearchBox,
  initialOf,
  planExpiryText,
} from './customerCells'
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
  // 下级推荐官只能升挂在自己名下的客户（来自 = 自己）。/ Sub-ambassadors promote their own clients only.
  const selfEmail = team.nodes.find((n) => n.isSelf)?.email ?? ''
  const directPromote = !canManage && team.canPromote
  const canPromoteRow = (u: AgentTreeUser) => !u.isAgent && (canManage || (directPromote && u.viaEmail === selfEmail))
  // 操作列：能升代理或能改会员就有。/ The action column shows when either write is allowed.
  const hasActions = canManage || directPromote || canSetPlan
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
      const name = row.nickname || row.email
      setNotice(
        row.agentLevel != null ? t('agent.promote.done', { name, n: row.agentLevel }) : t('agent.promote.doneDirect', { name }),
      )
      onPromoted()
    } catch (err: unknown) {
      setError(localizeApiError(err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
      setPromoting(null)
    }
  }

  const total = page?.total ?? 0

  // 「来自」：上级推荐官的首字小头像 + 名字（有昵称时下面再带邮箱）。
  // "Came through": the ambassador's small initial avatar and name (email below when nicknamed).
  const via = (u: AgentTreeUser) =>
    u.viaEmail ? (
      <span className="agt-via">
        <span className="agt-via-dot" aria-hidden="true">
          {initialOf(u.viaNickname || u.viaEmail)}
        </span>
        <span className="agt-via-text">
          <span className="agt-via-name">{u.viaNickname || u.viaEmail}</span>
          {u.viaNickname && <span className="agt-via-mail num">{u.viaEmail}</span>}
        </span>
      </span>
    ) : (
      <span className="agt-dim">—</span>
    )

  const agentBadge = (u: AgentTreeUser) =>
    u.isAgent && (
      <span className="agt-tag is-violet">
        {u.agentLevel != null ? t('agent.customers.agentBadge', { n: u.agentLevel }) : t('agent.customers.agentBadgePlain')}
      </span>
    )

  // 升为代理按钮：已经是代理不出现；超过最大层级置灰并把原因写在 title 与手机上的说明里。
  // Promote: hidden for agents; disabled with the reason past the max depth.
  const promoteButton = (u: AgentTreeUser) => {
    if (!canPromoteRow(u)) return null
    const lvl = canManage ? nextLevel(u) : null
    const tooDeep = lvl != null && lvl > team.maxDepth
    return (
      <button
        type="button"
        className="btn btn-ghost"
        disabled={busy || tooDeep}
        title={tooDeep ? t('agent.promote.tooDeep', { max: team.maxDepth }) : undefined}
        onClick={() => setPromoting(u)}
      >
        {t('agent.promote.button')}
      </button>
    )
  }

  const planButton = (u: AgentTreeUser) =>
    canSetPlan && (
      <button
        type="button"
        className="btn btn-ghost"
        disabled={u.plan === 'PRO' && !u.planExpiresAt}
        onClick={() => setEditing(u)}
      >
        {t('agent.plan.adjust')}
      </button>
    )

  return (
    <section>
      {/* 工具栏：搜索、按推荐官筛、人数，一条排完；手机上上下叠。
          Toolbar: search, ambassador filter and the count in one strip; stacked on phones. */}
      <div className="agt-toolbar">
        <SearchBox value={search} onChange={setSearch} />
        <Select
          className="agt-toolbar-select"
          value={agentFilter}
          ariaLabel={t('agent.customers.filterAgent')}
          onChange={onAgentFilterChange}
          options={filterOptions}
        />
        <span className="agt-toolbar-count num">{page ? t('agent.customers.count', { n: page.total }) : ''}</span>
      </div>

      {(canManage || directPromote) && (
        <div className="agt-callout">
          <IconInfo size={16} />
          <div>
            <p>{t(canManage ? 'agent.promote.hint' : 'agent.promote.hintDirect')}</p>
          </div>
        </div>
      )}

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

      <div className="agt-sheet">
        {page == null && !error ? (
          <div className="space-y-3 p-5" aria-busy="true">
            <SkeletonLine height={16} />
            <SkeletonLine width="66%" height={16} />
            <SkeletonLine width="80%" height={16} />
          </div>
        ) : page && page.users.length === 0 ? (
          <EmptyState text={t(query ? 'agent.searchEmpty' : 'agent.customers.empty')} />
        ) : page ? (
          <>
            <div className="hidden overflow-x-auto sm:block">
              <table className="agt-table is-wide">
                <thead>
                  <tr>
                    <th>{t('agent.colUser')}</th>
                    <th>{t('agent.customers.colVia')}</th>
                    <th>{t('agent.colPlan')}</th>
                    <th>{t('agent.colMt5')}</th>
                    <th>{t('agent.colActive')}</th>
                    <th>{t('agent.colRegistered')}</th>
                    {hasActions && <th className="is-act">{t('agent.colAction')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {page.users.map((u, i) => (
                    <tr key={`${u.email}-${i}`}>
                      <td>
                        <Person nickname={u.nickname} email={u.email} agent={u.isAgent} badge={agentBadge(u)} />
                      </td>
                      <td className="is-small">{via(u)}</td>
                      <td>
                        <PlanCell user={u} />
                      </td>
                      <td className="is-small">
                        <Mt5List accounts={u.mt5Accounts} />
                      </td>
                      <td className="is-small">
                        <LastActive day={u.lastActiveDay} />
                      </td>
                      <td className="is-date num">{fmtDate(u.createdAt)}</td>
                      {hasActions && (
                        <td className="is-act">
                          <div className="agt-row-acts">
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
            <ul className="agt-mlist sm:hidden">
              {page.users.map((u, i) => {
                const plan = planButton(u)
                const promo = promoteButton(u)
                return (
                  <li key={`${u.email}-${i}`} className="agt-mcard">
                    <div className="agt-mcard-top">
                      <Person nickname={u.nickname} email={u.email} agent={u.isAgent} badge={agentBadge(u)} />
                      <PlanBadge plan={u.plan} />
                    </div>
                    <dl className="agt-facts">
                      <Fact label={t('agent.customers.colVia')} wide>
                        {via(u)}
                      </Fact>
                      <Fact label={t('agent.colActive')}>
                        <LastActive day={u.lastActiveDay} />
                      </Fact>
                      <Fact label={t('agent.colRegistered')}>
                        <span className="num">{fmtDate(u.createdAt)}</span>
                      </Fact>
                      {planExpiryText(u, t) && (
                        <Fact label={t('agent.colExpiry')} wide>
                          <span className="num">{planExpiryText(u, t)}</span>
                        </Fact>
                      )}
                      <Fact label={t('agent.colMt5')} wide>
                        <Mt5List accounts={u.mt5Accounts} />
                      </Fact>
                    </dl>
                    {(plan || promo) && (
                      <div className={`agt-mcard-acts${plan && promo ? ' has-two' : ''}`}>
                        {plan}
                        {promo}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            {total > PAGE_SIZE && <Pager offset={offset} pageSize={PAGE_SIZE} total={total} onChange={setOffset} />}
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
          message={
            canManage
              ? t('agent.promote.body', {
                  name: promoting.nickname || promoting.email,
                  parent: promoting.viaNickname || promoting.viaEmail || '',
                  n: nextLevel(promoting) ?? '',
                })
              : t('agent.promote.bodyDirect', { name: promoting.nickname || promoting.email })
          }
          confirmLabel={t('agent.promote.button')}
          onConfirm={() => void promote()}
          onCancel={() => setPromoting(null)}
        />
      )}
    </section>
  )
}
