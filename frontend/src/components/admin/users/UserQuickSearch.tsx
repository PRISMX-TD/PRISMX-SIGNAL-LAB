// 全局「搜索用户」（2026-10-28）：控制台任何分区按 Ctrl + K（Mac ⌘ + K）或点页头按钮打开，
// 输入昵称 / 邮箱 / 手机号，回车或点结果直接打开用户档案，不用先切到用户列表。复用 /admin/users 的 q。
// Global "find user" (2026-10-28): Ctrl + K (⌘ + K on Mac) or the header button opens it from any
// console section; type a nickname / email / phone and Enter or click opens the user profile
// without switching to the user list first. Reuses /admin/users?q=.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi, isAbortError } from '../../../api/client'
import type { AdminUser } from '../../../api/types'
import { Avatar } from '../../support/supportUi'
import AdminSheet from '../AdminSheet'

export default function UserQuickSearch({ onPick, onClose }: { onPick: (userId: string) => void; onClose: () => void }) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<AdminUser[] | null>(null)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // AdminSheet 先把焦点给关闭按钮；这里是搜索框，直接聚焦输入框更顺手
  // AdminSheet focuses its close button first; for a search box, the input should have it
  useEffect(() => {
    const id = window.setTimeout(() => inputRef.current?.focus(), 30)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    const term = q.trim()
    if (term.length < 2) {
      setRows(null)
      return
    }
    const ctrl = new AbortController()
    const id = window.setTimeout(() => {
      adminApi
        .listUsers({ q: term, limit: 8 }, ctrl.signal)
        .then((r) => {
          setRows(r.users)
          setActive(0)
        })
        .catch((e) => { if (!isAbortError(e)) setRows([]) })
    }, 220)
    return () => {
      window.clearTimeout(id)
      ctrl.abort()
    }
  }, [q])

  const pick = (u: AdminUser | undefined) => {
    if (!u) return
    onPick(u.id)
  }

  return (
    <AdminSheet title={t('admin.quickSearch.button')} onClose={onClose} widthClass="sm:w-[520px]">
      <input
        ref={inputRef}
        type="search"
        className="adm-input mt-4 w-full"
        placeholder={t('admin.quickSearch.placeholder')}
        aria-label={t('admin.quickSearch.placeholder')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (!rows?.length) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setActive((i) => Math.min(rows.length - 1, i + 1))
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setActive((i) => Math.max(0, i - 1))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            pick(rows[active])
          }
        }}
      />
      <p className="mt-2 text-[11px] text-neutral-500">{t('admin.quickSearch.hint')}</p>
      <div className="mt-3 min-h-[120px]">
        {q.trim().length < 2 ? (
          <p className="py-6 text-center text-xs text-neutral-500">{t('admin.quickSearch.typeMore')}</p>
        ) : rows && rows.length === 0 ? (
          <p className="py-6 text-center text-xs text-neutral-500">{t('admin.quickSearch.empty')}</p>
        ) : (
          <ul className="space-y-1" role="listbox">
            {(rows ?? []).map((u, i) => (
              <li key={u.id} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(u)}
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition ${i === active ? 'bg-white/[0.06]' : 'hover:bg-white/[0.04]'}`}
                >
                  <Avatar name={u.nickname || u.email} size={30} tone={u.role === 'user' ? 'neutral' : 'staff'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-neutral-50">{u.nickname || u.email}</span>
                    <span className="block truncate font-mono text-[11px] text-neutral-500">
                      {u.email}
                      {u.phone ? ` · ${u.phone}` : ''}
                    </span>
                  </span>
                  <span className={`adm-pill ${u.plan === 'PRO' ? 'is-brand' : ''}`}>{u.plan}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </AdminSheet>
  )
}
