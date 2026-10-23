// 管理后台「代理层级」抽屉（rev 47）：全部代理按树排开，外加「最大层级」设置。
//
// 一级代理 = 管理员在链接上指派的人；下级是一级代理在代理页里升的。管理员在这里只看、只改
// 最大层级——撤某个下级仍走链接编辑里的「取消指派」（等同代理页的撤销：链接停用并转给他的
// 上级），一级代理下面还有人时后端会拒绝（409），先处理下级。
// 调低最大层级不动已有的代理，只是不能再往下升。
//
// Admin "Agent hierarchy" drawer (rev 47): every agent laid out as a tree plus the
// max-depth setting. Removing a sub-agent still goes through unassigning their link
// (same as an agent-side removal); lowering the max depth demotes nobody.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import AdminSheet from '../AdminSheet'
import { adminApi } from '../../../api/client'
import { localizeApiError } from '../../../api/utils'
import { SkeletonLine } from '../../Skeleton'
import type { AdminAgentTree, AdminAgentTreeNode } from '../../../api/types'

export default function AgentTreeDrawer({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const [tree, setTree] = useState<AdminAgentTree | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [depth, setDepth] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

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

  const depthNum = Number(depth)
  const depthValid = Number.isInteger(depthNum) && depthNum >= 1 && depthNum <= 20

  const save = async () => {
    if (!depthValid || saving) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const res = await adminApi.setAgentMaxDepth(depthNum)
      setTree(res)
      setDepth(String(res.maxDepth))
      setSaved(true)
    } catch (err: unknown) {
      setError(localizeApiError(err instanceof Error ? err.message : String(err)))
    } finally {
      setSaving(false)
    }
  }

  const renderNode = (n: AdminAgentTreeNode, indent: number): React.ReactNode => (
    <li key={n.userId}>
      <div
        className={`py-2.5 pr-3 ${indent > 0 ? 'border-l border-white/10' : ''}`}
        style={{ marginLeft: `${Math.min(indent, 5) * 14}px`, paddingLeft: indent > 0 ? '10px' : '0' }}
      >
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-neutral-100">
          <span className="truncate">{n.nickname || n.email}</span>
          <span className="rounded-full bg-prism-500/15 px-1.5 py-0.5 text-[11px] text-prism-200">
            {t('admin.invite.tree.level', { n: n.level })}
          </span>
        </p>
        {n.nickname && <p className="num break-all text-xs text-neutral-400">{n.email}</p>}
        <p className="mt-1 text-[11px] text-neutral-500">
          {t('admin.invite.tree.counts', { direct: n.directCustomers, total: n.teamCustomers })}
          {n.links.length > 0 && ' · '}
          {n.links.map((l, i) => (
            <span key={l.id} className={l.isActive ? '' : 'line-through'}>
              {i > 0 && '、'}
              {l.label} <span className="num">({l.code})</span>
            </span>
          ))}
        </p>
      </div>
      {(children.get(n.userId) ?? []).length > 0 && (
        <ul>{(children.get(n.userId) ?? []).map((k) => renderNode(k, indent + 1))}</ul>
      )}
    </li>
  )

  return (
    <AdminSheet title={t('admin.invite.tree.title')} onClose={onClose}>
      <p className="mt-2 text-xs leading-relaxed text-neutral-500">{t('admin.invite.tree.hint')}</p>

      <div className="mt-4 rounded-lg border border-white/10 p-3">
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
            onChange={(e) => {
              setDepth(e.target.value)
              setSaved(false)
            }}
          />
          <button
            type="button"
            className="btn-primary px-4 py-1.5 text-xs disabled:opacity-40"
            disabled={!tree || !depthValid || saving || depthNum === tree.maxDepth}
            onClick={() => void save()}
          >
            {saving ? t('admin.invite.tree.saving') : t('admin.invite.tree.save')}
          </button>
          {saved && <span className="text-xs text-up">{t('admin.invite.tree.saved')}</span>}
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-neutral-500">{t('admin.invite.tree.maxDepthHint')}</p>
      </div>

      {error && (
        <div className="mt-3 rounded-lg border border-down/40 bg-down/15 px-3 py-2 text-xs text-down" role="alert">
          {error}
        </div>
      )}

      <div className="mt-4">
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
    </AdminSheet>
  )
}
