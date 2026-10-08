// 指派代理的用户搜索：复用管理员用户搜索接口（邮箱 / 手机号模糊），点一行即指派。
// 300ms 防抖，空查询不打接口。原先是独立弹窗 AssignAgentSheet，现在嵌在编辑抽屉里。
// 不 autoFocus：嵌在抽屉里，手机上一打开就弹键盘会挡住上面的链接与二维码。
// Agent search: reuses the admin user search (email / phone fuzzy); one click assigns.
// 300ms debounce; empty query = no request. Formerly the standalone AssignAgentSheet,
// now embedded in the edit drawer. No autoFocus: it would pop the phone keyboard over
// the link and QR above it.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import { SkeletonLine } from '../../Skeleton'
import type { AdminUser } from '../../../api/types'

export default function AgentPicker({
  assignedIds,
  busy,
  onAssign,
}: {
  assignedIds: Set<string>
  busy: boolean
  onAssign: (userId: string) => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<AdminUser[] | null>(null)
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    const term = q.trim()
    if (!term) {
      setResults(null)
      return
    }
    let alive = true
    const timer = window.setTimeout(() => {
      setSearching(true)
      adminApi
        .listUsers({ q: term, limit: 20 })
        .then((res) => {
          if (alive) setResults(res.users)
        })
        .catch(() => {
          if (alive) setResults([])
        })
        .finally(() => {
          if (alive) setSearching(false)
        })
    }, 300)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [q])

  return (
    <div>
      <input
        className="input mt-3 w-full"
        placeholder={t('admin.invite.assignSearch')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="mt-2 max-h-56 overflow-y-auto">
        {searching && results == null ? (
          <div className="space-y-2 p-1">
            <SkeletonLine height={14} />
            <SkeletonLine width="70%" height={14} />
          </div>
        ) : results && results.length === 0 ? (
          <p className="p-2 text-sm text-neutral-500">{t('admin.invite.assignNoResult')}</p>
        ) : (
          <ul className="divide-y divide-white/5">
            {(results ?? []).map((u) => {
              const done = assignedIds.has(u.id)
              return (
                <li key={u.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 rounded-lg px-2 py-2 text-left text-sm transition hover:bg-white/5 disabled:opacity-50 disabled:hover:bg-transparent"
                    disabled={busy || done}
                    onClick={() => onAssign(u.id)}
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-neutral-100">{u.email}</span>
                      {u.phone && <span className="num block text-xs text-neutral-500">{u.phone}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-neutral-500">
                      {done ? t('admin.invite.assignAlready') : `${u.role} · ${u.plan}`}
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
