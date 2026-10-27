// 选链接主人（rev 50）：只能选已经是代理的人——谁是代理在「代理」分区里任命，链接只决定以后
// 经它注册的人归谁。拉一次全部代理，在本地按昵称 / 邮箱筛。嵌在编辑抽屉里，不 autoFocus：
// 手机上一打开就弹键盘会挡住上面的链接与二维码。
// Link-owner picker (rev 50): agents only — agents are appointed in the Agents section, a
// link only decides who future signups belong to. Loads every agent once and filters
// locally. No autoFocus: it would pop the phone keyboard over the link and QR above.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import { SkeletonLine } from '../../Skeleton'
import type { AdminAgentTreeNode } from '../../../api/types'

export default function AgentPicker({
  currentOwnerId,
  busy,
  onPick,
}: {
  currentOwnerId: string | null
  busy: boolean
  onPick: (agent: AdminAgentTreeNode) => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [agents, setAgents] = useState<AdminAgentTreeNode[] | null>(null)

  useEffect(() => {
    let alive = true
    adminApi
      .agentTree()
      .then((res) => {
        if (alive) setAgents(res.nodes)
      })
      .catch(() => {
        if (alive) setAgents([])
      })
    return () => {
      alive = false
    }
  }, [])

  const term = q.trim().toLowerCase()
  const shown = (agents ?? []).filter(
    (a) => !term || a.email.toLowerCase().includes(term) || (a.nickname ?? '').toLowerCase().includes(term),
  )

  return (
    <div>
      <input
        className="input mt-3 w-full"
        placeholder={t('admin.invite.ownerSearch')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="mt-2 max-h-56 overflow-y-auto">
        {agents == null ? (
          <div className="space-y-2 p-1">
            <SkeletonLine height={14} />
            <SkeletonLine width="70%" height={14} />
          </div>
        ) : shown.length === 0 ? (
          <p className="p-2 text-sm text-neutral-500">
            {agents.length === 0 ? t('admin.invite.ownerNoAgents') : t('admin.invite.assignNoResult')}
          </p>
        ) : (
          <ul className="divide-y divide-white/5">
            {shown.map((a) => {
              const current = a.userId === currentOwnerId
              return (
                <li key={a.userId}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-sm transition hover:bg-white/5 disabled:opacity-50 disabled:hover:bg-transparent"
                    disabled={busy || current}
                    onClick={() => onPick(a)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-neutral-100">{a.nickname || a.email}</span>
                      {a.nickname && <span className="block truncate text-xs text-neutral-500">{a.email}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-neutral-500">
                      {current ? t('admin.invite.assignAlready') : t('admin.invite.tree.level', { n: a.level })}
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
