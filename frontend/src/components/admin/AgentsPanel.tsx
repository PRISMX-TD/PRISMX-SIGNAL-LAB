// 管理后台「代理」分区（rev 50，设计 docs/superpowers/specs/2026-10-27-agent-invite-redesign.md §7）：
// 全部代理按树排开，任命、撤销、改挂上级、最大层级都在这里。原来是推广链接页里的一个抽屉
// （AgentTreeDrawer），任命要靠「在链接上指派」——rev 50 起谁是代理只看代理树，链接只决定以后
// 经它注册的人归谁，所以代理的增删改从链接里搬了出来。
//
// - 任命：搜一个用户 → 选上级（或一级）→ 一律给他生成一条专属链接（不再可选）。他已经归属的客户不动。
// - 撤销：他名下的客户与链接交给上级（一级则客户变平台客户、链接变平台链接），下级整体上移一级；
//   一级代理下面还有人时后端 409，先改挂或撤下级。
// - 改挂上级：连同整棵子树（客户本来就归他们，一起过去）。选项里已经去掉他自己、他的下级、
//   他现在的上级，以及挂过去会超过最大层级的位置；后端同样会挡。
// - 可改会员（rev 51）：每行一个开关，只有这里能开关；默认关，一级也要开。开了的代理能在代理页
//   给自己整支团队的客户改会员。
// - 调低最大层级不动已有的代理，只是不能再往下升。
//
// Admin "Agents" section (rev 50): the whole tree, plus appoint, revoke, re-parent and the
// max depth. It used to be a drawer on the links page where appointing meant assigning a
// link; since rev 50 the tree alone says who is an agent, so agent management moved here.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../api/client'
import { localizeApiError } from '../../api/utils'
import { SkeletonLine } from '../Skeleton'
import Switch from '../Switch'
import ConfirmModal from '../ConfirmModal'
import Select from '../Select'
import type { AdminAgentTree, AdminAgentTreeNode, AdminUser } from '../../api/types'

export default function AgentsPanel() {
  const { t } = useTranslation()
  const [tree, setTree] = useState<AdminAgentTree | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [depth, setDepth] = useState('')
  // 改挂：正在给谁选新上级、选了谁（'' = 改成一级）。/ Re-parent: whose upline, the pick ('' = top).
  const [moving, setMoving] = useState<AdminAgentTreeNode | null>(null)
  const [moveTo, setMoveTo] = useState<string | null>(null)
  const [confirmMove, setConfirmMove] = useState(false)
  const [revoking, setRevoking] = useState<AdminAgentTreeNode | null>(null)
  const [appointing, setAppointing] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    adminApi
      .agentTree()
      .then((res) => {
        if (!alive) return
        setTree(res)
        setDepth(String(res.maxDepth))
      })
      .catch((err: unknown) => {
        if (alive) setError(localizeApiError(err instanceof Error ? err.message : String(err)))
      })
    return () => {
      alive = false
    }
  }, [])

  const children = useMemo(() => {
    const m = new Map<string | null, AdminAgentTreeNode[]>()
    const ids = new Set((tree?.nodes ?? []).map((n) => n.userId))
    for (const n of tree?.nodes ?? []) {
      // 上级不在列表里（脏数据）的当根显示，别让人凭空消失。/ Orphans render as roots.
      const key = n.parentUserId && ids.has(n.parentUserId) ? n.parentUserId : null
      const list = m.get(key) ?? []
      list.push(n)
      m.set(key, list)
    }
    return m
  }, [tree])

  const byId = useMemo(() => new Map((tree?.nodes ?? []).map((n) => [n.userId, n])), [tree])
  const nameOf = (n: AdminAgentTreeNode | undefined) => (n ? n.nickname || n.email : '')

  // 某个代理自己 + 全部下级的 id，以及他下面最深还有几层。/ Self + descendants, and how deep below.
  const subtreeOf = (n: AdminAgentTreeNode) => {
    const ids = new Set<string>([n.userId])
    let height = 0
    const walk = (id: string, rel: number) => {
      for (const k of children.get(id) ?? []) {
        if (ids.has(k.userId)) continue
        ids.add(k.userId)
        height = Math.max(height, rel + 1)
        walk(k.userId, rel + 1)
      }
    }
    walk(n.userId, 0)
    return { ids, height }
  }

  const moveOptions = useMemo(() => {
    if (!moving || !tree) return []
    const { ids, height } = subtreeOf(moving)
    const opts: { value: string; label: string }[] = []
    if (moving.parentUserId != null && 1 + height <= tree.maxDepth) {
      opts.push({ value: '', label: t('admin.invite.tree.moveTop') })
    }
    for (const n of tree.nodes) {
      if (ids.has(n.userId) || n.userId === moving.parentUserId) continue
      if (n.level + 1 + height > tree.maxDepth) continue
      opts.push({ value: n.userId, label: `${nameOf(n)} · ${t('admin.invite.tree.level', { n: n.level })}` })
    }
    return opts
    // subtreeOf 只读 children（由 tree 派生）。/ subtreeOf only reads children, derived from tree.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moving, tree, t])

  // 所有写操作的唯一入口：单飞闸，成功后换上后端回来的整棵树。
  // The one entry for writes: single-flight, then swap in the tree the server returns.
  const run = async (fn: () => Promise<AdminAgentTree>, done: string): Promise<boolean> => {
    if (busy) return false
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const res = await fn()
      setTree(res)
      setDepth(String(res.maxDepth))
      setNotice(done)
      return true
    } catch (err: unknown) {
      setError(localizeApiError(err instanceof Error ? err.message : String(err)))
      return false
    } finally {
      setBusy(false)
    }
  }

  const doMove = async () => {
    if (!moving || moveTo === null) return
    const ok = await run(() => adminApi.moveAgent(moving.userId, moveTo || null), t('admin.invite.tree.moveDone'))
    setConfirmMove(false)
    if (ok) {
      setMoving(null)
      setMoveTo(null)
    }
  }

  const doRevoke = async () => {
    if (!revoking) return
    const ok = await run(() => adminApi.revokeAgent(revoking.userId), t('admin.agents.revokeDone', { name: nameOf(revoking) }))
    if (ok) setRevoking(null)
  }

  const togglePlanRight = (n: AdminAgentTreeNode, enabled: boolean) =>
    void run(
      () => adminApi.setAgentPlanRight(n.userId, enabled),
      t(enabled ? 'admin.agents.planRightOn' : 'admin.agents.planRightOff', { name: nameOf(n) }),
    )

  const depthNum = Number(depth)
  const depthValid = Number.isInteger(depthNum) && depthNum >= 1 && depthNum <= 20

  const renderNode = (n: AdminAgentTreeNode, indent: number): React.ReactNode => (
    <li key={n.userId}>
      <div
        className={`py-2.5 pr-1 ${indent > 0 ? 'border-l border-white/10' : ''}`}
        style={{ marginLeft: `${Math.min(indent, 5) * 14}px`, paddingLeft: indent > 0 ? '10px' : '0' }}
      >
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-neutral-100">
          <span className="truncate">{nameOf(n)}</span>
          <span className="rounded-full bg-prism-500/15 px-1.5 py-0.5 text-[11px] text-prism-200">
            {t('admin.invite.tree.level', { n: n.level })}
          </span>
          <span className="ml-auto flex items-center gap-3">
            <label
              className="flex cursor-pointer items-center gap-1.5 text-xs text-neutral-300"
              title={t('admin.agents.planRightHint')}
            >
              <Switch
                checked={n.canSetPlan}
                disabled={busy}
                onChange={(v) => togglePlanRight(n, v)}
                aria-label={t('admin.agents.planRight')}
              />
              {t('admin.agents.planRight')}
            </label>
            {moving?.userId !== n.userId && (
              <button
                type="button"
                className="text-xs text-prism-300 hover:text-prism-200 disabled:opacity-40"
                disabled={busy}
                onClick={() => {
                  setMoving(n)
                  setMoveTo(null)
                }}
              >
                {t('admin.invite.tree.move')}
              </button>
            )}
            <button
              type="button"
              className="text-xs text-neutral-400 hover:text-down disabled:opacity-40"
              disabled={busy}
              onClick={() => setRevoking(n)}
            >
              {t('admin.agents.revoke')}
            </button>
          </span>
        </p>
        {n.nickname && <p className="num break-all text-xs text-neutral-400">{n.email}</p>}
        <p className="mt-1 text-[11px] text-neutral-500">
          {t('admin.invite.tree.counts', { direct: n.directCustomers, total: n.teamCustomers })}
          {' · '}
          {n.links.length === 0
            ? t('admin.agents.noLinks')
            : n.links.map((l, i) => (
                <span key={l.id} className={l.isActive ? '' : 'line-through'}>
                  {i > 0 && '、'}
                  {l.label} <span className="num">({l.code})</span>
                </span>
              ))}
        </p>
        {moving?.userId === n.userId && (
          <div className="mt-2 rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
            {moveOptions.length === 0 ? (
              <p className="text-xs text-neutral-500">{t('admin.invite.tree.moveNone')}</p>
            ) : (
              <>
                <label className="label">{t('admin.invite.tree.moveTo')}</label>
                <Select
                  value={moveTo ?? '__pick'}
                  onChange={setMoveTo}
                  ariaLabel={t('admin.invite.tree.moveTo')}
                  options={[{ value: '__pick', label: t('admin.invite.tree.movePick') }, ...moveOptions].filter(
                    (o) => o.value !== '__pick' || moveTo === null,
                  )}
                />
              </>
            )}
            <div className="mt-2 flex items-center gap-2">
              {moveOptions.length > 0 && (
                <button
                  type="button"
                  className="btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
                  disabled={moveTo === null || moveTo === '__pick' || busy}
                  onClick={() => setConfirmMove(true)}
                >
                  {t('admin.invite.tree.moveConfirm')}
                </button>
              )}
              <button
                type="button"
                className="px-2 py-1.5 text-xs text-neutral-400 hover:text-neutral-200"
                onClick={() => setMoving(null)}
              >
                {t('admin.invite.tree.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
      {(children.get(n.userId) ?? []).length > 0 && (
        <ul>{(children.get(n.userId) ?? []).map((k) => renderNode(k, indent + 1))}</ul>
      )}
    </li>
  )

  return (
    <div>
      <p className="mb-4 text-sm leading-relaxed text-neutral-400">{t('admin.agents.hint')}</p>

      <div className="glass mb-4 flex flex-wrap items-end gap-4 p-4">
        <div>
          <label className="label" htmlFor="agent-max-depth">
            {t('admin.invite.tree.maxDepth')}
          </label>
          <div className="flex items-center gap-2">
            <input
              id="agent-max-depth"
              className="input w-24"
              type="number"
              inputMode="numeric"
              min={1}
              max={20}
              value={depth}
              onChange={(e) => setDepth(e.target.value)}
            />
            <button
              type="button"
              className="btn-ghost px-4 py-1.5 text-xs disabled:opacity-40"
              disabled={!tree || !depthValid || busy || depthNum === tree.maxDepth}
              onClick={() => void run(() => adminApi.setAgentMaxDepth(depthNum), t('admin.invite.tree.saved'))}
            >
              {t('admin.invite.tree.save')}
            </button>
          </div>
          <p className="mt-1.5 max-w-sm text-[11px] leading-snug text-neutral-500">{t('admin.invite.tree.maxDepthHint')}</p>
        </div>
        <button
          type="button"
          className="btn-primary ml-auto px-4 py-1.5 text-xs disabled:opacity-40"
          disabled={!tree || busy}
          onClick={() => setAppointing(true)}
        >
          + {t('admin.agents.appoint')}
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-down/40 bg-down/15 px-3 py-2 text-xs text-down" role="alert">
          {error}
        </div>
      )}
      {notice && !error && <div className="mb-3 rounded-lg bg-up/10 px-3 py-2 text-xs text-up">{notice}</div>}

      {appointing && tree && (
        <AppointForm
          tree={tree}
          busy={busy}
          onCancel={() => setAppointing(false)}
          onSubmit={async (userId, parentUserId, label) => {
            const ok = await run(
              () => adminApi.appointAgent(userId, parentUserId),
              t('admin.agents.appointDone', { name: label }),
            )
            if (ok) setAppointing(false)
          }}
        />
      )}

      <div className="glass p-4">
        {tree == null && !error ? (
          <div className="space-y-2" aria-busy="true">
            <SkeletonLine height={14} />
            <SkeletonLine width="70%" height={14} />
          </div>
        ) : tree && tree.nodes.length === 0 ? (
          <p className="text-sm text-neutral-500">{t('admin.invite.tree.empty')}</p>
        ) : (
          <ul className="divide-y divide-white/5">{(children.get(null) ?? []).map((n) => renderNode(n, 0))}</ul>
        )}
      </div>

      {confirmMove && moving && moveTo !== null && (
        <ConfirmModal
          center
          busy={busy}
          title={t('admin.invite.tree.moveTitle')}
          message={
            moveTo
              ? t('admin.agents.moveBody', { name: nameOf(moving), parent: nameOf(byId.get(moveTo)) })
              : t('admin.agents.moveBodyTop', { name: nameOf(moving) })
          }
          confirmLabel={t('admin.invite.tree.moveConfirm')}
          onConfirm={() => void doMove()}
          onCancel={() => setConfirmMove(false)}
        />
      )}
      {revoking && (
        <ConfirmModal
          center
          danger
          busy={busy}
          title={t('admin.agents.revokeTitle', { name: nameOf(revoking) })}
          message={
            revoking.parentUserId && byId.has(revoking.parentUserId)
              ? t('admin.agents.revokeBody', { name: nameOf(revoking), parent: nameOf(byId.get(revoking.parentUserId)) })
              : t('admin.agents.revokeBodyTop', { name: nameOf(revoking) })
          }
          confirmLabel={t('admin.agents.revoke')}
          onConfirm={() => void doRevoke()}
          onCancel={() => setRevoking(null)}
        />
      )}
    </div>
  )
}

// 任命表单：搜人（复用管理员用户搜索）→ 选上级 → 要不要顺手生成专属链接。已经是代理的人不能选。
// Appoint form: search a user → pick the parent → whether to mint a link. Existing agents are disabled.
function AppointForm({
  tree,
  busy,
  onCancel,
  onSubmit,
}: {
  tree: AdminAgentTree
  busy: boolean
  onCancel: () => void
  onSubmit: (userId: string, parentUserId: string | null, label: string) => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<AdminUser[] | null>(null)
  const [picked, setPicked] = useState<AdminUser | null>(null)
  const [parent, setParent] = useState('')

  useEffect(() => {
    const term = q.trim()
    if (!term) {
      setResults(null)
      return
    }
    let alive = true
    const timer = window.setTimeout(() => {
      adminApi
        .listUsers({ q: term, limit: 20 })
        .then((res) => {
          if (alive) setResults(res.users)
        })
        .catch(() => {
          if (alive) setResults([])
        })
    }, 300)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [q])

  const agentIds = new Set(tree.nodes.map((n) => n.userId))
  // 上级只能选还没到最大层级的代理。/ Only agents above the max depth can take a sub-agent.
  const parentOptions = [
    { value: '', label: t('admin.agents.parentTop') },
    ...tree.nodes
      .filter((n) => n.level < tree.maxDepth)
      .map((n) => ({ value: n.userId, label: `${n.nickname || n.email} · ${t('admin.invite.tree.level', { n: n.level })}` })),
  ]

  return (
    <div className="glass mb-4 p-4">
      <p className="mb-3 text-sm font-semibold text-neutral-100">{t('admin.agents.appointTitle')}</p>
      {picked ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-2 text-sm">
          <span className="min-w-0 truncate text-neutral-100">{picked.email}</span>
          <button type="button" className="text-xs text-prism-300" onClick={() => setPicked(null)}>
            {t('admin.agents.repick')}
          </button>
        </div>
      ) : (
        <>
          <input
            className="input w-full"
            placeholder={t('admin.invite.assignSearch')}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {results && results.length === 0 && (
            <p className="p-2 text-sm text-neutral-500">{t('admin.invite.assignNoResult')}</p>
          )}
          {results && results.length > 0 && (
            <ul className="mt-2 max-h-56 divide-y divide-white/5 overflow-y-auto">
              {results.map((u) => {
                const already = agentIds.has(u.id)
                return (
                  <li key={u.id}>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-sm transition hover:bg-white/5 disabled:opacity-50 disabled:hover:bg-transparent"
                      disabled={already}
                      onClick={() => setPicked(u)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-neutral-100">{u.email}</span>
                        {u.agentEmail && (
                          <span className="block truncate text-xs text-neutral-500">
                            {t('admin.colAgent')}: {u.agentEmail}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-xs text-neutral-500">
                        {already ? t('admin.agents.alreadyAgent') : `${u.role} · ${u.plan}`}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}

      <div className="mt-3 sm:max-w-xs">
        <label className="label">{t('admin.agents.parent')}</label>
        <Select value={parent} onChange={setParent} ariaLabel={t('admin.agents.parent')} options={parentOptions} />
      </div>
      <p className="mt-2 text-[11px] leading-snug text-neutral-500">{t('admin.agents.appointHint')}</p>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="btn-primary px-4 py-1.5 text-xs disabled:opacity-40"
          disabled={!picked || busy}
          onClick={() => picked && onSubmit(picked.id, parent || null, picked.nickname || picked.email)}
        >
          {t('admin.agents.appointConfirm')}
        </button>
        <button type="button" className="px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200" onClick={onCancel}>
          {t('admin.invite.tree.cancel')}
        </button>
      </div>
    </div>
  )
}
