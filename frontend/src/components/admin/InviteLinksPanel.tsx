// 邀请链接面板：生成带标记名的推广链接，看点击/注册统计，改名与停用/启用。
// 通过链接注册的用户，备注栏写入注册当时的标记名（快照，改名不追溯）；注册
// 人数按隐藏归因码统计，管理员手改备注不影响数字。链接拼 ORIGIN 而不是
// window.location.origin——在 Vercel 预览域名上操作后台时复制出去的必须仍是
// 正式域名（裸域名还会 308）。
// Invite-links panel: create labeled promo links, watch click/registration
// stats, rename, toggle. Labels are snapshotted into the user note at
// registration (renames don't backfill); counts group by the hidden
// attribution code. Links are built from ORIGIN, not window.location.origin —
// copied URLs must stay canonical even when the admin works on a preview host.
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi } from '../../api/client'
import { fmtTime, localizeApiError } from '../../api/utils'
import { SkeletonLine } from '../Skeleton'
import { ORIGIN } from '../../seo/meta'
import type { InviteLink } from '../../api/types'

const linkUrl = (code: string) => `${ORIGIN}/?ref=${code}`

export default function InviteLinksPanel() {
  const { t } = useTranslation()
  const [links, setLinks] = useState<InviteLink[]>([])
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [newLabel, setNewLabel] = useState('')
  // 'create' 或正在保存的链接 id；同一时刻只放行一个写操作，避免连点。
  // 'create' or the id being saved; one in-flight write at a time.
  const [busyId, setBusyId] = useState<string | null>(null)
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({})
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const showErr = (err: unknown, fallbackKey: string) =>
    setToast({
      kind: 'err',
      text: err instanceof Error ? localizeApiError(err.message) : t(fallbackKey),
    })

  useEffect(() => {
    adminApi
      .listInviteLinks()
      .then((res) => setLinks(res.links))
      .catch((err) => showErr(err, 'admin.loadError'))
      .finally(() => setLoading(false))
  }, [])

  const create = async (e: FormEvent) => {
    e.preventDefault()
    const label = newLabel.trim()
    if (!label || busyId) return
    setBusyId('create')
    try {
      const link = await adminApi.createInviteLink(label)
      setLinks((prev) => [link, ...prev])
      setNewLabel('')
    } catch (err) {
      showErr(err, 'admin.saveError')
    } finally {
      setBusyId(null)
    }
  }

  const saveLabel = async (l: InviteLink) => {
    const draft = (labelDrafts[l.id] ?? l.label).trim()
    if (!draft || draft === l.label || busyId) return
    setBusyId(l.id)
    try {
      const updated = await adminApi.updateInviteLink(l.id, { label: draft })
      setLinks((prev) => prev.map((x) => (x.id === l.id ? updated : x)))
      setLabelDrafts((prev) => {
        const next = { ...prev }
        delete next[l.id]
        return next
      })
    } catch (err) {
      showErr(err, 'admin.saveError')
    } finally {
      setBusyId(null)
    }
  }

  const toggle = async (l: InviteLink) => {
    if (busyId) return
    setBusyId(l.id)
    try {
      const updated = await adminApi.updateInviteLink(l.id, { isActive: !l.isActive })
      setLinks((prev) => prev.map((x) => (x.id === l.id ? updated : x)))
    } catch (err) {
      showErr(err, 'admin.saveError')
    } finally {
      setBusyId(null)
    }
  }

  const copy = async (l: InviteLink) => {
    try {
      // navigator.clipboard 在非安全上下文整体不存在（同步抛 TypeError 而不是
      // 返回被拒绝的 promise），所以整段包在 try 里（照 UpgradePage 的处理）。
      // navigator.clipboard is absent entirely outside secure contexts and
      // throws synchronously — hence the whole call sits inside the try.
      await navigator.clipboard.writeText(linkUrl(l.code))
      setCopiedId(l.id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch {
      setToast({ kind: 'err', text: t('admin.invite.copyFailed') })
    }
  }

  return (
    <div>
      {toast && (
        <div
          className={`mb-4 rounded-lg border px-4 py-2.5 text-sm ${
            toast.kind === 'err'
              ? 'border-down/40 bg-down/15 text-down'
              : 'border-up/40 bg-up/15 text-up'
          }`}
        >
          {toast.text}
        </div>
      )}

      <p className="mb-4 text-sm text-neutral-400">{t('admin.invite.hint')}</p>

      {/* 创建行 / create row */}
      <form onSubmit={create} className="glass mb-4 flex flex-wrap items-center gap-3 p-4">
        <input
          className="input flex-1 sm:max-w-xs"
          placeholder={t('admin.invite.labelPlaceholder')}
          value={newLabel}
          maxLength={64}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <button
          type="submit"
          className="btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
          disabled={!newLabel.trim() || busyId === 'create'}
        >
          {t('admin.invite.create')}
        </button>
      </form>

      {/* 链接表 / links table */}
      <div className="glass overflow-x-auto p-0">
        {loading ? (
          <div className="space-y-2 p-4">
            <SkeletonLine className="h-4 w-full" />
            <SkeletonLine className="h-4 w-2/3" />
          </div>
        ) : links.length === 0 ? (
          <div className="p-8 text-center text-sm text-neutral-500">
            {t('admin.invite.empty')}
          </div>
        ) : (
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-neutral-500">
                <th className="px-4 py-3 font-medium">{t('admin.invite.colLabel')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.invite.colLink')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.invite.colClicks')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.invite.colRegistrations')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.invite.colStatus')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.invite.colCreated')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => {
                const draft = labelDrafts[l.id] ?? l.label
                const dirty = draft.trim() !== '' && draft.trim() !== l.label
                return (
                  <tr key={l.id} className="border-b border-white/5 align-top last:border-0">
                    <td className="px-4 py-3">
                      <input
                        type="text"
                        className="input w-40 py-1 text-xs"
                        value={draft}
                        maxLength={64}
                        onChange={(e) =>
                          setLabelDrafts((prev) => ({ ...prev, [l.id]: e.target.value }))
                        }
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span className="num text-xs text-neutral-300">{linkUrl(l.code)}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="num">{l.clicks}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="num">{l.registrations}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          l.isActive ? 'bg-up/15 text-up' : 'bg-white/5 text-neutral-400'
                        }`}
                      >
                        {l.isActive ? t('admin.invite.active') : t('admin.invite.inactive')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-neutral-400">{fmtTime(l.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => void copy(l)}>
                          {copiedId === l.id ? t('admin.invite.copied') : t('admin.invite.copy')}
                        </button>
                        {dirty && (
                          <button
                            className="btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
                            disabled={busyId === l.id}
                            onClick={() => void saveLabel(l)}
                          >
                            {t('admin.invite.save')}
                          </button>
                        )}
                        <button
                          className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-40"
                          disabled={busyId === l.id}
                          onClick={() => void toggle(l)}
                        >
                          {l.isActive ? t('admin.invite.disable') : t('admin.invite.enable')}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
