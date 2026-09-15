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
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useToast } from '../../utils/useToast'
import { adminApi } from '../../api/client'
import { fmtTime, localizeApiError } from '../../api/utils'
import { SkeletonLine } from '../Skeleton'
import { ORIGIN } from '../../seo/meta'
import { useBackToClose } from '../../utils/useBackToClose'
import type { AdminUser, InviteLink } from '../../api/types'

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
  // 正在为哪条链接指派代理（弹窗打开态）/ which link the assign sheet is open for
  const [assignFor, setAssignFor] = useState<InviteLink | null>(null)

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

  // 指派 / 移除代理：后端两边都回整条链接（含最新 agents），直接替换那一行。
  // Assign / remove an agent: both return the full link, so the row is swapped whole.
  const assignAgent = async (l: InviteLink, userId: string) => {
    if (busyId) return
    setBusyId(l.id)
    try {
      const updated = await adminApi.assignInviteAgent(l.id, userId)
      setLinks((prev) => prev.map((x) => (x.id === l.id ? updated : x)))
      setAssignFor(updated)
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showErr(err, 'admin.saveError')
    } finally {
      setBusyId(null)
    }
  }

  const unassignAgent = async (l: InviteLink, userId: string) => {
    if (busyId) return
    setBusyId(l.id)
    try {
      const updated = await adminApi.unassignInviteAgent(l.id, userId)
      setLinks((prev) => prev.map((x) => (x.id === l.id ? updated : x)))
      setAssignFor((cur) => (cur && cur.id === l.id ? updated : cur))
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
          <table className="w-full min-w-[1240px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-neutral-500">
                <th className="px-4 py-3 font-medium">{t('admin.invite.colLabel')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.invite.colLink')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.invite.colClicks')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.invite.colRegistrations')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.invite.colStatus')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.invite.colGrantsTrial')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.invite.colAgents')}</th>
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
                    {/* 代理：一人一枚小标签（昵称优先，没有就邮箱），× 移除；「指派」开搜索弹窗。
                        代理不是角色，这里不动 role——见后端 InviteLinkAgent 模型注释。
                        Agents: one chip per user (nickname, else email) with × to remove;
                        Assign opens the search sheet. Not a role — see the model's comment. */}
                    <td className="px-4 py-3">
                      <div className="flex max-w-[16rem] flex-wrap items-center gap-1.5">
                        {(l.agents ?? []).map((a) => (
                          <span
                            key={a.userId}
                            className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-xs text-neutral-200"
                            title={a.email}
                          >
                            {a.nickname || a.email}
                            <button
                              type="button"
                              className="text-neutral-500 hover:text-down disabled:opacity-40"
                              aria-label={t('admin.invite.unassign')}
                              disabled={busyId !== null}
                              onClick={() => void unassignAgent(l, a.userId)}
                            >
                              ×
                            </button>
                          </span>
                        ))}
                        <button
                          type="button"
                          className="btn-ghost px-2 py-0.5 text-xs disabled:opacity-40"
                          disabled={busyId !== null}
                          onClick={() => setAssignFor(l)}
                        >
                          + {t('admin.invite.assign')}
                        </button>
                      </div>
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

      {assignFor && (
        <AssignAgentSheet
          link={assignFor}
          busy={busyId !== null}
          onAssign={(userId) => void assignAgent(assignFor, userId)}
          onUnassign={(userId) => void unassignAgent(assignFor, userId)}
          onClose={() => setAssignFor(null)}
        />
      )}
    </div>
  )
}

// 指派代理的搜索弹窗：复用管理员用户搜索接口（邮箱 / 手机号模糊），点一行即指派。
// portal 到 body（.glass 卡片会成为 fixed 的包含块，见 ConfirmModal 的注释）；接住
// 手机返回手势（useBackToClose）。300ms 防抖，空查询不打接口。
// Agent-assignment sheet: reuses the admin user search (email / phone fuzzy); one
// click on a row assigns. Portaled to body (see ConfirmModal's containing-block
// note) and claims the phone back gesture. 300ms debounce; empty query = no request.
function AssignAgentSheet({
  link,
  busy,
  onAssign,
  onUnassign,
  onClose,
}: {
  link: InviteLink
  busy: boolean
  onAssign: (userId: string) => void
  onUnassign: (userId: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [results, setResults] = useState<AdminUser[] | null>(null)
  const [searching, setSearching] = useState(false)
  useBackToClose(true, onClose)

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

  const assigned = new Set((link.agents ?? []).map((a) => a.userId))

  return createPortal(
    <div className="slide-overlay" onClick={onClose}>
      <div className="slide-sheet sm:w-[420px]" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-white">{t('admin.invite.assignTitle')}</h3>
        <p className="mt-1 text-xs text-neutral-400">{link.label}</p>
        <p className="mt-3 text-xs leading-relaxed text-neutral-500">{t('admin.invite.assignHint')}</p>

        {(link.agents ?? []).length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {(link.agents ?? []).map((a) => (
              <span
                key={a.userId}
                className="inline-flex items-center gap-1 rounded-full bg-prism-500/15 px-2 py-0.5 text-xs text-prism-200"
                title={a.email}
              >
                {a.nickname || a.email}
                <button
                  type="button"
                  className="text-prism-300/70 hover:text-down disabled:opacity-40"
                  aria-label={t('admin.invite.unassign')}
                  disabled={busy}
                  onClick={() => onUnassign(a.userId)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <input
          className="input mt-4 w-full"
          autoFocus
          placeholder={t('admin.invite.assignSearch')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />

        <div className="mt-3 max-h-64 overflow-y-auto">
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
                const done = assigned.has(u.id)
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

        <div className="mt-5 flex">
          <button type="button" onClick={onClose} className="btn-ghost flex-1 py-2 text-sm">
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
