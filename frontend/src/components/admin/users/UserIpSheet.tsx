// 用户列表「登录 IP」侧栏：最近 10 个 IP、地区、同 IP 的其他账户。同 IP 只做提醒——
// 手机网络大量用户共用出口 IP，底部灰字写明仅供参考（spec §6）。
// Login-IP sheet: the latest 10 IPs, their region and other accounts on the same IP.
// A reminder only — carrier-grade NAT shares exit IPs widely.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../../api/client'
import type { AdminIpUser, AdminUserIp } from '../../../api/types'
import { fmtTime, localizeApiError } from '../../../api/utils'
import AdminSheet from '../AdminSheet'
import { SkeletonLine } from '../../Skeleton'

type Props = { userId: string; userLabel: string; onClose: () => void; onPickUser: (email: string) => void }

function region(r: AdminUserIp): string | null {
  const parts = [r.country, r.province, r.city].filter((p, i, a): p is string => !!p && a.indexOf(p) === i)
  return parts.length ? parts.join(' · ') : null
}

export default function UserIpSheet({ userId, userLabel, onClose, onPickUser }: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<AdminUserIp[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openIp, setOpenIp] = useState<string | null>(null)
  const [others, setOthers] = useState<AdminIpUser[] | null>(null)

  useEffect(() => {
    let cancelled = false
    adminApi.userIps(userId).then(
      (d) => { if (!cancelled) setRows(d) },
      (err: unknown) => { if (!cancelled) setError(err instanceof Error ? localizeApiError(err.message) : '') },
    )
    return () => { cancelled = true }
  }, [userId])

  const toggle = (ip: string) => {
    if (openIp === ip) { setOpenIp(null); return }
    setOpenIp(ip)
    setOthers(null)
    adminApi.ipUsers(ip).then(
      (list) => setOthers(list.filter((u) => u.userId !== userId)),
      () => setOthers([]),
    )
  }

  return (
    <AdminSheet title={t('admin.users.ip.title')} badge={<span className="text-xs text-neutral-400">{userLabel}</span>} onClose={onClose}>
      {error !== null && <p className="text-xs text-down">{t('admin.users.ip.failed')}{error ? `：${error}` : ''}</p>}
      {error === null && !rows && <SkeletonLine height={120} />}
      {rows && rows.length === 0 && <p className="text-xs text-neutral-500">{t('admin.users.ip.empty')}</p>}
      {rows && rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.ip} className="rounded-lg bg-white/5 p-3 text-xs">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-mono text-neutral-100">{r.ip}</span>
                <span className="text-neutral-400">{region(r) ?? t('admin.users.ip.unknownRegion')}</span>
              </div>
              <div className="mt-1 text-[11px] text-neutral-500">
                {t('admin.users.ip.firstSeen', { time: fmtTime(r.firstSeenAt) })} · {t('admin.users.ip.lastSeen', { time: fmtTime(r.lastSeenAt) })}
              </div>
              {r.otherUsers > 0 ? (
                <button type="button" onClick={() => toggle(r.ip)} aria-expanded={openIp === r.ip} className="mt-1 text-[11px] text-amber-300 hover:underline">
                  {openIp === r.ip ? t('admin.users.ip.hideOthers') : t('admin.users.ip.others', { count: r.otherUsers })}
                </button>
              ) : (
                <div className="mt-1 text-[11px] text-neutral-600">{t('admin.users.ip.noOthers')}</div>
              )}
              {openIp === r.ip && (
                <div className="mt-2 border-t border-white/10 pt-2">
                  {!others ? <SkeletonLine height={40} /> : (
                    <ul className="space-y-1">
                      {others.map((u) => (
                        <li key={u.userId} className="flex justify-between gap-3">
                          <button type="button" onClick={() => onPickUser(u.email)} className="truncate text-left text-prism-300 hover:underline">
                            {u.nickname ? `${u.nickname} · ${u.email}` : u.email}
                          </button>
                          <span className="shrink-0 text-neutral-500">{fmtTime(u.lastSeenAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-[11px] text-neutral-500">{t('admin.users.ip.note')}</p>
    </AdminSheet>
  )
}
