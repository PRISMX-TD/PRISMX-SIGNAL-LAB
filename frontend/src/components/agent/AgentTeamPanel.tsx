// 代理页「团队」（rev 47 代理层级）：我和我全部下级代理的树。
//
// 树由后端给的扁平列表（宽度优先、自己在最前）按 parentEmail 拼起来；自己那一行没有上级——
// 下级看不到上级是后端的硬规则，前端没有什么可藏的。每个人四个数：直属客户 / 整个团队的
// 客户 / 近 7 日活跃 / 已连 MT5（后两个只算他直属的，口径同「我的链接」卡片）。
//
// 只有一级代理（canManage）看得到「撤销代理」：撤掉之后他的链接停用并转给他的上级，
// 客户仍在树上，他的下级整体上移一级（见后端 services/agent_tree.remove_node）。
//
// 每个代理下面还能展开他的直属普通客户（2026-10-24 加：只列代理的树里看不到「下线」）。
// 已经是代理的直属客户本来就画成子节点，这里过滤掉不重复；每人最多拉 20 个，多的去
// 「全部客户」看。团队不大（≤ 10 个代理）时默认全部展开，大了默认收起，免得一进页就发一串请求。
//
// Agent view "Team" (rev 47): the caller and every agent below them, assembled
// from the server's flat breadth-first list by parentEmail. The caller's own row
// has no parent — looking upwards is impossible server-side. Only top-level
// agents (canManage) see "Remove agent". Each agent can also expand their direct
// non-agent customers (up to 20; more lives in "All customers"); small teams
// start expanded, large ones collapsed to avoid a burst of requests.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { agentApi } from '../../api/client'
import { fmtDate, localizeApiError } from '../../api/utils'
import { useBackToClose } from '../../utils/useBackToClose'
import ConfirmModal from '../ConfirmModal'
import type { AgentTeam, AgentTeamNode, AgentTreeUser } from '../../api/types'
import { LastActive, PlanBadge } from './customerCells'

const CUSTOMERS_PER_NODE = 20
const AUTO_EXPAND_MAX_NODES = 10

// 一个代理名下的直属普通客户（懒加载）。team 变了（升 / 撤代理之后）重新拉。
// One agent's direct non-agent customers, fetched on mount; refetched when the team changes.
function NodeCustomers({
  team,
  agentEmail,
  indent,
  onShowAll,
}: {
  team: AgentTeam
  agentEmail: string
  indent: number
  onShowAll: () => void
}) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<AgentTreeUser[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setError(null)
    agentApi
      .customers({ agent: agentEmail, limit: CUSTOMERS_PER_NODE })
      .then((r) => {
        if (!alive) return
        setRows(r.users)
        setTotal(r.total)
      })
      .catch((err: unknown) => {
        if (alive) setError(localizeApiError(err instanceof Error ? err.message : String(err)))
      })
    return () => {
      alive = false
    }
  }, [team, agentEmail])

  const plain = (rows ?? []).filter((u) => u.agentLevel == null)
  const more = total - (rows?.length ?? 0)
  return (
    <div
      className="border-l border-dashed border-white/10 pb-3 pr-4"
      style={{ marginLeft: `${Math.min(indent + 1, 5) * 14}px`, paddingLeft: '12px' }}
    >
      {error ? (
        <p className="text-xs text-down">{error}</p>
      ) : rows === null ? (
        <p className="text-xs text-neutral-500">{t('common.loading')}</p>
      ) : (
        <ul className="space-y-1.5">
          {plain.map((u) => (
            <li key={u.email} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg bg-white/[0.03] px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-[13px] text-neutral-200">{u.nickname || t('agent.noNickname')}</p>
                <p className="num break-all text-[11px] text-neutral-500">{u.email}</p>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-[11px] text-neutral-500">
                <PlanBadge plan={u.plan} />
                <span>{t('agent.colActive')}</span>
                <LastActive day={u.lastActiveDay} />
              </div>
            </li>
          ))}
          {more > 0 && (
            <li>
              <button type="button" className="text-xs text-prism-300 hover:text-prism-200" onClick={onShowAll}>
                {t('agent.team.customersMore', { n: more })}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

export default function AgentTeamPanel({
  team,
  onTeamChange,
  onShowCustomers,
}: {
  team: AgentTeam
  onTeamChange: (team: AgentTeam) => void
  onShowCustomers: (email: string) => void
}) {
  const { t } = useTranslation()
  const [removing, setRemoving] = useState<AgentTeamNode | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useBackToClose(removing !== null, () => setRemoving(null))

  // 按 parentEmail 分组；列表本来就是宽度优先，组内顺序即任命先后。
  // Grouped by parentEmail; the list is breadth-first, so order within a group is appointment order.
  const children = useMemo(() => {
    const m = new Map<string, AgentTeamNode[]>()
    for (const n of team.nodes) {
      if (!n.parentEmail) continue
      const list = m.get(n.parentEmail) ?? []
      list.push(n)
      m.set(n.parentEmail, list)
    }
    return m
  }, [team.nodes])
  const self = team.nodes.find((n) => n.isSelf) ?? null
  const subCount = team.nodes.length - 1
  // 展开状态：只记「和默认不一样」的那些人，团队刷新后默认值照样适用。
  // Only deviations from the default are stored, so the default survives a team refresh.
  const autoOpen = team.nodes.length <= AUTO_EXPAND_MAX_NODES
  const [toggled, setToggled] = useState<Set<string>>(() => new Set())
  const isOpen = (email: string) => autoOpen !== toggled.has(email)
  const toggle = (email: string) =>
    setToggled((prev) => {
      const next = new Set(prev)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })

  const remove = async () => {
    if (!removing) return
    setBusy(true)
    setError(null)
    try {
      onTeamChange(await agentApi.demote(removing.email))
      setRemoving(null)
    } catch (err: unknown) {
      setError(localizeApiError(err instanceof Error ? err.message : String(err)))
      setRemoving(null)
    } finally {
      setBusy(false)
    }
  }

  const renderNode = (n: AgentTeamNode, indent: number): React.ReactNode => {
    const kids = children.get(n.email) ?? []
    // 直属客户里已经是代理的就是 kids（新代理的上级 = 他注册所用链接的主人），减掉才是普通客户数。
    // Direct customers who became agents are exactly `kids`; the rest are plain customers.
    const plainCount = Math.max(0, n.directCustomers - kids.length)
    const open = plainCount > 0 && isOpen(n.email)
    return (
      <li key={n.email}>
        {/* 缩进封顶 4 层：手机屏宽有限，再往里缩名字就挤没了；层级另有「第 N 级」徽标说明。
            Indent is capped at four steps — on a phone deeper indents squeeze the name
            out; the level badge carries the depth anyway. */}
        <div
          className={`py-3 pr-4 ${indent > 0 ? 'border-l border-white/10' : ''}`}
          style={{ marginLeft: `${Math.min(indent, 4) * 14}px`, paddingLeft: indent > 0 ? '12px' : '16px' }}
        >
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-1.5 text-sm text-neutral-100">
                <span className="truncate">{n.nickname || n.email}</span>
                <span className="rounded-full bg-prism-500/15 px-1.5 py-0.5 text-[11px] text-prism-200">
                  {t('agent.team.level', { n: n.level })}
                </span>
                {n.isSelf && (
                  <span className="rounded-full bg-white/5 px-1.5 py-0.5 text-[11px] text-neutral-400">
                    {t('agent.team.you')}
                  </span>
                )}
              </p>
              {n.nickname && <p className="num break-all text-xs text-neutral-400">{n.email}</p>}
              {!n.isSelf && n.createdAt && (
                <p className="mt-0.5 text-[11px] text-neutral-500">{t('agent.team.since', { date: fmtDate(n.createdAt) })}</p>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => onShowCustomers(n.email)}>
                {t('agent.team.showCustomers')}
              </button>
              {team.canManage && !n.isSelf && (
                <button
                  type="button"
                  className="btn-ghost px-3 py-1.5 text-xs text-down disabled:opacity-40"
                  disabled={busy}
                  onClick={() => setRemoving(n)}
                >
                  {t('agent.team.remove')}
                </button>
              )}
            </div>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: t('agent.team.direct'), value: n.directCustomers },
              { label: t('agent.team.total'), value: n.teamCustomers },
              { label: t('agent.active7d'), value: n.activeUsers7d },
              { label: t('agent.mt5Users'), value: n.mt5Users },
            ].map((s) => (
              <div key={s.label} className="min-w-0">
                <p className="truncate text-[11px] text-neutral-500">{s.label}</p>
                <p className="num text-base text-neutral-100">{s.value}</p>
              </div>
            ))}
          </div>
          {plainCount > 0 && (
            <button
              type="button"
              className="mt-2 text-xs text-prism-300 hover:text-prism-200"
              aria-expanded={open}
              onClick={() => toggle(n.email)}
            >
              {open ? t('agent.team.customersHide') : t('agent.team.customersShow', { n: plainCount })}
            </button>
          )}
        </div>
        {open && (
          <NodeCustomers team={team} agentEmail={n.email} indent={indent} onShowAll={() => onShowCustomers(n.email)} />
        )}
        {kids.length > 0 && <ul>{kids.map((k) => renderNode(k, indent + 1))}</ul>}
      </li>
    )
  }

  return (
    <section className="mt-4">
      <div className="mb-3 space-y-1 text-xs leading-relaxed text-neutral-400">
        <p>
          {team.canManage
            ? t('agent.team.topHint', { max: team.maxDepth })
            : t('agent.team.readOnlyHint', { n: team.level ?? 0 })}
        </p>
        <p className="text-neutral-500">{t('agent.team.countNote')}</p>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-down/40 bg-down/15 px-4 py-2.5 text-sm text-down" role="alert">
          {error}
        </div>
      )}

      <div className="glass p-0">
        {self && <ul className="divide-y divide-white/5">{renderNode(self, 0)}</ul>}
        {subCount === 0 && (
          <p className="border-t border-white/5 px-4 py-4 text-sm text-neutral-500">
            {team.canManage ? t('agent.team.emptyTop') : t('agent.team.empty')}
          </p>
        )}
      </div>

      {removing && (
        <ConfirmModal
          center
          danger
          busy={busy}
          title={t('agent.team.removeTitle')}
          message={t('agent.team.removeBody', { name: removing.nickname || removing.email })}
          confirmLabel={t('agent.team.remove')}
          onConfirm={() => void remove()}
          onCancel={() => setRemoving(null)}
        />
      )}
    </section>
  )
}
