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
// 2026-10-28 重画：每个推荐官一张节点卡（头像、名字与层级、四个数、操作；1280 以上一行排完），
// 卡与卡之间画树线——竖线从上级头像正下方落下，弯进下级头像。第 3、4 层改窄台阶（层级徽标
// 只有一级推荐官看得到，别人全靠缩进分辨上下级），第 5 层起不再缩进。直属客户展开在卡内。
//
// Agent view "Team" (rev 47): the caller and every agent below them, assembled
// from the server's flat breadth-first list by parentEmail. The caller's own row
// has no parent — looking upwards is impossible server-side. Only top-level
// agents (canManage) see "Remove agent". Each agent can also expand their direct
// non-agent customers (up to 20; more lives in "All customers"); small teams
// start expanded, large ones collapsed to avoid a burst of requests.
// Redrawn 2026-10-28: one node card per ambassador (avatar, name and level, four figures,
// actions; a single row from 1280px) joined by tree lines that drop from the parent's avatar
// and bend into the child's. Depths 3–4 take a narrow step (only top-level ambassadors see
// level badges, so everyone else reads the hierarchy from the indent); indenting stops at
// depth 5. Direct clients expand inside the card.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { agentApi } from '../../api/client'
import { fmtDate, localizeApiError } from '../../api/utils'
import { useBackToClose } from '../../utils/useBackToClose'
import ConfirmModal from '../ConfirmModal'
import type { AgentTeam, AgentTeamNode, AgentTreeUser } from '../../api/types'
import { IconArrow, IconChevron, IconInfo } from './agentIcons'
import { LastActive, Person, PlanBadge, initialOf } from './customerCells'

const CUSTOMERS_PER_NODE = 20
const AUTO_EXPAND_MAX_NODES = 10

// 一个代理名下的直属普通客户（懒加载）。team 变了（升 / 撤代理之后）重新拉。
// One agent's direct non-agent customers, fetched on mount; refetched when the team changes.
function NodeCustomers({
  team,
  agentEmail,
  onShowAll,
}: {
  team: AgentTeam
  agentEmail: string
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

  const plain = (rows ?? []).filter((u) => !u.isAgent)
  const more = total - (rows?.length ?? 0)
  if (error) return <p className="agt-clients-note is-err">{error}</p>
  if (rows === null) return <p className="agt-clients-note">{t('common.loading')}</p>
  return (
    <>
      <ul className="agt-clients">
        {plain.map((u) => (
          <li key={u.email} className="agt-client">
            <Person nickname={u.nickname} email={u.email} small />
            <div className="agt-client-meta">
              <PlanBadge plan={u.plan} />
              <span className="agt-client-seen">
                <span>{t('agent.colActive')}</span>
                <LastActive day={u.lastActiveDay} />
              </span>
            </div>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <button type="button" className="agt-clients-more" onClick={onShowAll}>
          {t('agent.team.customersMore', { n: more })}
          <IconArrow size={14} />
        </button>
      )}
    </>
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

  // depth：自己是 0，直属下级 1，以此类推。子列表的 class 带上深度档位，样式据此收窄、停止缩进。
  // depth: 0 for yourself, 1 for direct downline, and so on; the child list carries a depth
  // tier so the stylesheet knows where to narrow and then stop the indent.
  const renderNode = (n: AgentTeamNode, depth: number): React.ReactNode => {
    const kids = children.get(n.email) ?? []
    // 直属客户里已经是代理的就是 kids（新代理的上级 = 他注册所用链接的主人），减掉才是普通客户数。
    // Direct customers who became agents are exactly `kids`; the rest are plain customers.
    const plainCount = Math.max(0, n.directCustomers - kids.length)
    const open = plainCount > 0 && isOpen(n.email)
    const canRemove = team.canManage && !n.isSelf
    const childDepth = depth + 1
    return (
      <li key={n.email} className="agt-tree-item">
        <article className={`agt-node${n.isSelf ? ' is-self' : ''}`}>
          <div className="agt-node-row">
            {/* 自己那一圈是全息箔。/ Your own avatar wears the foil ring. */}
            <span className="agt-avatar" aria-hidden="true">
              {initialOf(n.nickname || n.email)}
            </span>
            <div className="agt-node-who">
              <p className="agt-node-name">
                <span className="agt-node-name-text">{n.nickname || n.email}</span>
                {/* 层级只有一级推荐官看得到（后端二级起不下发）。/ Levels reach top-level ambassadors only. */}
                {n.level != null && <span className="agt-tag is-violet">{t('agent.team.level', { n: n.level })}</span>}
                {n.isSelf && <span className="agt-tag">{t('agent.team.you')}</span>}
              </p>
              {n.nickname && <p className="agt-node-sub num">{n.email}</p>}
              {!n.isSelf && n.createdAt && (
                <p className="agt-node-sub">{t('agent.team.since', { date: fmtDate(n.createdAt) })}</p>
              )}
            </div>
            <dl className="agt-node-stats">
              {[
                { label: t('agent.team.direct'), value: n.directCustomers },
                { label: t('agent.team.total'), value: n.teamCustomers },
                { label: t('agent.active7d'), value: n.activeUsers7d },
                { label: t('agent.mt5Users'), value: n.mt5Users },
              ].map((s) => (
                <div key={s.label}>
                  <dt>{s.label}</dt>
                  <dd className="num">{s.value.toLocaleString('en-US')}</dd>
                </div>
              ))}
            </dl>
            <div className={`agt-node-actions${canRemove ? ' has-two' : ''}`}>
              <button type="button" className="btn btn-ghost" onClick={() => onShowCustomers(n.email)}>
                <span>{t('agent.team.showCustomers')}</span>
                <IconArrow size={14} />
              </button>
              {canRemove && (
                <button type="button" className="btn btn-ghost is-danger" disabled={busy} onClick={() => setRemoving(n)}>
                  {t('agent.team.remove')}
                </button>
              )}
              {/* 自己那张卡没有「撤销」：宽屏上放一个看不见的同款占位，操作栏和别的卡一样宽，
                  四个数字的列才对得齐（哪种语言的按钮多宽都一样）。
                  Your own card has no Remove: on wide screens an invisible twin keeps the actions
                  as wide as everyone else's, so the figure columns line up in every language. */}
              {team.canManage && n.isSelf && (
                <span className="btn btn-ghost agt-node-spacer" aria-hidden="true">
                  {t('agent.team.remove')}
                </span>
              )}
            </div>
          </div>
          {plainCount > 0 && (
            <button type="button" className="agt-node-toggle" aria-expanded={open} onClick={() => toggle(n.email)}>
              <span>{open ? t('agent.team.customersHide') : t('agent.team.customersShow', { n: plainCount })}</span>
              <IconChevron size={15} />
            </button>
          )}
          {open && <NodeCustomers team={team} agentEmail={n.email} onShowAll={() => onShowCustomers(n.email)} />}
        </article>
        {kids.length > 0 && (
          <ul className={`agt-tree is-sub${childDepth >= 3 ? ' is-deep' : ''}${childDepth >= 5 ? ' is-flat' : ''}`}>
            {kids.map((k) => renderNode(k, childDepth))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <section>
      <div className="agt-callout">
        <IconInfo size={16} />
        <div>
          <p>
            {team.canManage ? t('agent.team.topHint', { max: team.maxDepth }) : t('agent.team.readOnlyHint')}{' '}
            {t(team.canSetPlan ? 'agent.team.planOnHint' : 'agent.team.planOffHint')}
          </p>
          <p className="is-dim">{t('agent.team.countNote')}</p>
        </div>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-down/40 bg-down/15 px-4 py-2.5 text-sm text-down" role="alert">
          {error}
        </div>
      )}

      {self && <ul className={`agt-tree${team.canManage ? ' can-manage' : ''}`}>{renderNode(self, 0)}</ul>}
      {subCount === 0 && (
        <div className="agt-sheet agt-tree-empty">{team.canManage ? t('agent.team.emptyTop') : t('agent.team.empty')}</div>
      )}

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
