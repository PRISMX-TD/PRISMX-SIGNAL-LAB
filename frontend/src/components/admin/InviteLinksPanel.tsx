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
import { useToast } from '../../utils/useToast'
import { adminApi } from '../../api/client'
import { fmtTime, localizeApiError } from '../../api/utils'
import { SkeletonLine } from '../Skeleton'
import { ORIGIN } from '../../seo/meta'
import type { InviteLink } from '../../api/types'

const linkUrl = (code: string) => `${ORIGIN}/?ref=${code}`

export default function InviteLinksPanel({ globalTrialEnabled = false }: { globalTrialEnabled?: boolean }) {
  const { t } = useTranslation()
  const [links, setLinks] = useState<InviteLink[]>([])
  const [loading, setLoading] = useState(true)
  const [newLabel, setNewLabel] = useState('')
  // 'create' 或正在保存的链接 id；同一时刻只放行一个写操作，避免连点。
  // 'create' or the id being saved; one in-flight write at a time.
  const [busyId, setBusyId] = useState<string | null>(null)
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({})
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const { toast, showToast } = useToast()

  const showErr = (err: unknown, fallbackKey: string) =>
    showToast('err', err instanceof Error ? localizeApiError(err.message) : t(fallbackKey))

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
      showToast('ok', t('admin.saved'))
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
      showToast('ok', t('admin.saved'))
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
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showErr(err, 'admin.saveError')
    } finally {
      setBusyId(null)
    }
  }

  const toggleGrantsTrial = async (l: InviteLink) => {
    if (busyId) return
    setBusyId(l.id)
    try {
      const updated = await adminApi.updateInviteLink(l.id, { grantsTrial: !l.grantsTrial })
      setLinks((prev) => prev.map((x) => (x.id === l.id ? updated : x)))
      showToast('ok', t('admin.saved'))
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
      showToast('err', t('admin.invite.copyFailed'))
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
      {/* 下面所有写操作按钮一律按 busyId !== null 禁用，而不是只禁用"自己那一行"
          （busyId === l.id）：create / saveLabel / toggle 三个处理函数都是只要
          busyId 有值就直接 return。只禁自己那行的话，A 行保存期间点 B 行的保存或
          停用、或点创建，按钮看着能按、点下去却什么都不发生，也没有任何提示，
          管理员只会以为后台坏了。禁用状态必须如实反映处理函数的行为。
          Every write button is disabled on busyId !== null, not just on its own
          row (busyId === l.id): create / saveLabel / toggle all bail out when
          busyId is truthy. Disabling per-row only means that while row A saves,
          Save or Disable on row B — or Create — looks clickable but does
          nothing at all, with no feedback, which reads as a broken admin panel.
          The disabled state must reflect what the handlers actually do. */}
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
          disabled={!newLabel.trim() || busyId !== null}
        >
          {t('admin.invite.create')}
        </button>
      </form>

      {/* 链接表 / links table */}
      <div className="glass overflow-x-auto p-0">
        {loading ? (
          <div className="space-y-2 p-4">
            {/* SkeletonLine 用 width/height props 定尺寸，不是 className——组件把
                宽高当内联样式写，className 里的 h-4/w-2/3 会被内联样式盖掉，
                照用户表（AdminPage.tsx）的调用方式改。
                SkeletonLine sizes via width/height props, not className — the
                component applies width/height as inline styles, which silently
                win over Tailwind classes. Follows the users-table call convention. */}
            <SkeletonLine height={16} />
            <SkeletonLine width="66%" height={16} />
          </div>
        ) : links.length === 0 ? (
          <div className="p-8 text-center text-sm text-neutral-500">
            {t('admin.invite.empty')}
          </div>
        ) : (
          <table className="w-full min-w-[1020px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-neutral-500">
                <th className="px-4 py-3 font-medium">{t('admin.invite.colLabel')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.invite.colLink')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.invite.colClicks')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.invite.colRegistrations')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.invite.colStatus')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.invite.colGrantsTrial')}</th>
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
                    {/* 全局免费试用关闭时整列置灰并给出原因。没有这句提示，
                        管理员打开了开关却一个试用都没发出去，而页面上没有任何
                        线索指向真正的原因（运营设置里的那个总闸），只能怀疑
                        后台坏了。开关本身仍可点——记录意图是有意义的，全局一开
                        它立刻生效。
                        The whole column greys out with a reason when the global
                        trial is off. Without the hint an admin flips this on,
                        sees zero trials granted, and has nothing pointing at the
                        actual cause (the master gate in operations settings).
                        The toggle still works — recording intent is useful, and
                        it takes effect the moment the global switch opens. */}
                    <td className="px-4 py-3">
                      <button
                        className={`rounded-full px-2 py-0.5 text-xs disabled:opacity-40 ${
                          l.grantsTrial ? 'bg-prism-500/20 text-prism-200' : 'bg-white/5 text-neutral-400'
                        } ${globalTrialEnabled ? '' : 'opacity-50'}`}
                        disabled={busyId !== null}
                        title={globalTrialEnabled ? undefined : t('admin.invite.grantsTrialBlocked')}
                        onClick={() => void toggleGrantsTrial(l)}
                      >
                        {l.grantsTrial ? t('admin.invite.grantsTrialOn') : t('admin.invite.grantsTrialOff')}
                      </button>
                      {l.grantsTrial && !globalTrialEnabled && (
                        <p className="mt-1 max-w-[14rem] text-[11px] leading-snug text-neutral-500">
                          {t('admin.invite.grantsTrialBlocked')}
                        </p>
                      )}
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
                            disabled={busyId !== null}
                            onClick={() => void saveLabel(l)}
                          >
                            {t('admin.invite.save')}
                          </button>
                        )}
                        <button
                          className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-40"
                          disabled={busyId !== null}
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
