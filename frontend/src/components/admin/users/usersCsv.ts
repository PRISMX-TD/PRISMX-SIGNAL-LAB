// 用户表导出 CSV（2026-10-28）：按当前筛选导出的全部用户，Excel 直接打开（带 BOM，中文不乱码）。
// 公式注入防护：以 = + - @ 开头的单元格前面加一个单引号，免得昵称被 Excel 当公式执行。
// User-table CSV export (2026-10-28): every user matching the current filters, opens straight in
// Excel (BOM so Chinese renders). Formula-injection guard: cells starting with = + - @ get a
// leading apostrophe so a nickname is never executed as a formula.
import type { AdminUser } from '../../../api/types'
import { fmtDate } from '../../../api/utils'

export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function usersCsv(users: AdminUser[], linkLabel: (code: string | null | undefined) => string): string {
  const head = ['id', 'nickname', 'email', 'phone', 'role', 'plan', 'planExpiresAt', 'note', 'source', 'ambassador', 'mt5Accounts', 'emailVerified', 'disabled', 'createdAt', 'lastActiveAt']
  const rows = users.map((u) => [
    u.id,
    u.nickname ?? '',
    u.email,
    u.phone ?? '',
    u.role,
    u.plan,
    u.planExpiresAt ? fmtDate(u.planExpiresAt) : '',
    u.planNote ?? '',
    linkLabel(u.inviteCode),
    u.agentEmail ?? '',
    u.mt5AccountCount,
    u.emailVerifiedAt ? 'yes' : 'no',
    u.disabledAt ? 'yes' : 'no',
    u.createdAt ? fmtDate(u.createdAt) : '',
    u.lastActiveAt ? fmtDate(u.lastActiveAt) : '',
  ])
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')
}

export function downloadUsersCsv(users: AdminUser[], linkLabel: (code: string | null | undefined) => string) {
  const blob = new Blob(['﻿' + usersCsv(users, linkLabel)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const d = new Date()
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  a.href = url
  a.download = `users-${stamp}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
