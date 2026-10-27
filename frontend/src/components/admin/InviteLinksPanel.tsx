// 推广链接面板（rev 50 前叫「邀请链接」）：生成带标记名的推广链接，看点击/注册统计，改名与停用/启用。
// rev 50 起代理的任命 / 撤销 / 层级在「代理」分区（AgentsPanel），这里只给链接选主人。
// 通过链接注册的用户，备注栏写入注册当时的标记名（快照，改名不追溯）；注册
// 人数按隐藏归因码统计，管理员手改备注不影响数字。链接一律由 utils/promoLinkUrl
// 拼 ORIGIN 而不是 window.location.origin——在 Vercel 预览域名上操作后台时复制出去的
// 必须仍是正式域名（裸域名还会 308）。
// 2026-10-08 重做（设计 §5）：原来是一张 9 列、最小宽 1240px 的横向滚动大表，每行内联
// 改名框与一排开关。现在：顶部统计条 → 工具栏（分类分段 / 渠道 / 搜索 / 显示已停用 /
// 新建）→ 桌面 6 列紧凑表、手机卡片 → 点行或「编辑」开抽屉，改名、渠道、二维码、试用、
// 启停、代理都在抽屉里。三类链接（代理 / 平台 / 比赛推广）由后端推导，见 inviteLinkLogic。
// Invite-links panel: create labeled promo links, watch click/registration
// stats, rename, toggle. Labels are snapshotted into the user note at
// registration (renames don't backfill); counts group by the hidden
// attribution code. URLs come from utils/promoLinkUrl (ORIGIN, not
// window.location.origin) so copies stay canonical on preview hosts.
// Redesigned 2026-10-08 (design §5): the 9-column, 1240px-wide scrolling table with
// inline rename boxes became a stats strip, a toolbar (kind segments / channel / search /
// show disabled / new), a compact 6-column table (cards on phones) and an edit drawer.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useToast } from '../../utils/useToast'
import { adminApi } from '../../api/client'
import { fmtTime, localizeApiError } from '../../api/utils'
import { segBtn } from '../../utils/segBtn'
import ConfirmModal from '../ConfirmModal'
import Select from '../Select'
import Switch from '../Switch'
import { SkeletonLine } from '../Skeleton'
import CopyLinkButton from './invite/CopyLinkButton'
import InviteLinkCreateDrawer from './invite/InviteLinkCreateDrawer'
import InviteLinkEditDrawer from './invite/InviteLinkEditDrawer'
import ToastBar from './invite/ToastBar'
import {
  ALL_CHANNELS,
  DEFAULT_FILTER,
  KIND_FILTERS,
  NO_CHANNEL,
  channelOptions,
  deleteConfirmMessage,
  filterLinks,
  hasUnchanneled,
  kindBadgeClass,
  kindCounts,
  linkKind,
  secondaryLine,
  summarize,
  type LinkFilter,
} from './invite/inviteLinkLogic'
import type { AdminAgentTreeNode, InviteLink, InviteLinkCreate, InviteLinkPatch } from '../../api/types'

export default function InviteLinksPanel({ globalTrialEnabled = false }: { globalTrialEnabled?: boolean }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [links, setLinks] = useState<InviteLink[]>([])
  const [loading, setLoading] = useState(true)
  // 'create' 或正在保存的链接 id；同一时刻只放行一个写操作，避免连点。
  // 所有写操作按钮（表格、抽屉、确认框）一律按 busyId !== null 禁用，而不是只禁用
  // "自己那一行"：runWrite 只要 busyId 有值就直接返回。只禁自己那行的话，A 行保存期间
  // 点 B 行的启停、或点新建，按钮看着能按、点下去却什么都不发生，也没有任何提示，
  // 管理员只会以为后台坏了。禁用状态必须如实反映处理函数的行为。
  // 'create' or the id being saved; one in-flight write at a time. Every write button
  // (table, drawers, confirm) disables on busyId !== null, not just its own row:
  // runWrite bails whenever busyId is set, so a per-row disable would leave buttons that
  // look clickable but silently do nothing. The disabled state must reflect the handlers.
  const [busyId, setBusyId] = useState<string | null>(null)
  const [filter, setFilter] = useState<LinkFilter>(DEFAULT_FILTER)
  // 抽屉记 id 而不是对象：写操作替换 links 里那一行后，抽屉自动拿到新值。
  // The drawer keeps an id, not the object, so it re-reads the row after each write.
  const [editId, setEditId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  // 待确认的「换主人 / 收回」（rev 50）：agent 为 null = 收回成平台链接。moveCustomers 默认不勾——
  // 换主人只影响以后注册的人；勾上才把来源是这条链接、仍归旧主人的客户一起转过去。
  // 用非 center 版：它要压在编辑抽屉（z-80 的 slide-overlay）上面，见 AdminSheet 注释。
  // The pending owner change (null = back to a platform link). moveCustomers starts
  // unticked: a new owner only affects future signups unless the admin opts in.
  // Non-centered so it stacks above the drawer (see AdminSheet).
  const [ownerTarget, setOwnerTarget] = useState<{ link: InviteLink; agent: AdminAgentTreeNode | null } | null>(null)
  const [moveCustomers, setMoveCustomers] = useState(false)
  // 待确认的「删除链接」。危险态确认框，同样用非 center 版压在抽屉上面。
  // The pending "delete link": a danger-styled, non-centered confirm above the drawer.
  const [deleteTarget, setDeleteTarget] = useState<InviteLink | null>(null)

  const ownerName = (a: { nickname: string | null; email: string } | null | undefined) => (a ? a.nickname || a.email : '')

  const { toast, showToast } = useToast()

  const showErr = (err: unknown, fallbackKey: string) =>
    showToast('err', err instanceof Error ? localizeApiError(err.message) : t(fallbackKey))

  useEffect(() => {
    adminApi
      .listInviteLinks()
      .then((res) => setLinks(res.links))
      .catch((err) => showErr(err, 'admin.loadError'))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 所有写操作的唯一入口：单飞闸 + 整行替换（后端每个写接口都回整条链接，含最新
  // agents / kind）。新建的链接插到最前。
  // The one entry for writes: single-flight gate + whole-row swap (every write endpoint
  // returns the full link, fresh agents/kind included). New links go first.
  const runWrite = async (key: string, fn: () => Promise<InviteLink>): Promise<InviteLink | null> => {
    if (busyId) return null
    setBusyId(key)
    try {
      const updated = await fn()
      setLinks((prev) =>
        prev.some((x) => x.id === updated.id) ? prev.map((x) => (x.id === updated.id ? updated : x)) : [updated, ...prev],
      )
      showToast('ok', t('admin.saved'))
      return updated
    } catch (err) {
      showErr(err, 'admin.saveError')
      return null
    } finally {
      setBusyId(null)
    }
  }

  // 新建成功直接打开它的编辑抽屉：管理员下一步几乎总是复制链接或下载二维码。
  // After creating, open its drawer: the next step is almost always copy or QR.
  const create = async (body: InviteLinkCreate) => {
    const link = await runWrite('create', () => adminApi.createInviteLink(body))
    if (!link) return false
    setCreating(false)
    setEditId(link.id)
    return true
  }

  const save = async (l: InviteLink, patch: InviteLinkPatch) =>
    (await runWrite(l.id, () => adminApi.updateInviteLink(l.id, patch))) != null

  const toggleActive = (l: InviteLink) => void runWrite(l.id, () => adminApi.updateInviteLink(l.id, { isActive: !l.isActive }))

  const toggleTrial = (l: InviteLink) =>
    void runWrite(l.id, () => adminApi.updateInviteLink(l.id, { grantsTrial: !l.grantsTrial }))

  const requestOwner = (l: InviteLink, agent: AdminAgentTreeNode | null) => {
    setMoveCustomers(false)
    setOwnerTarget({ link: l, agent })
  }

  const applyOwner = async () => {
    if (!ownerTarget || busyId) return
    const { link, agent } = ownerTarget
    const ok = await runWrite(link.id, () => adminApi.setLinkOwner(link.id, agent?.userId ?? null, moveCustomers))
    if (ok) setOwnerTarget(null)
  }

  // 删除不走 runWrite：它不回整条链接，成功后是把这一行从列表里拿掉。单飞闸照样遵守。
  // Delete bypasses runWrite (no row comes back — the row is removed) but keeps the gate.
  const deleteLink = async (l: InviteLink) => {
    if (busyId) return
    setBusyId(l.id)
    try {
      await adminApi.deleteInviteLink(l.id)
      setLinks((prev) => prev.filter((x) => x.id !== l.id))
      setDeleteTarget(null)
      setEditId((cur) => (cur === l.id ? null : cur))
      showToast('ok', t('admin.invite.deleted'))
    } catch (err) {
      showErr(err, 'admin.saveError')
    } finally {
      setBusyId(null)
    }
  }

  const copyFailed = () => showToast('err', t('admin.invite.copyFailed'))

  const summary = useMemo(() => summarize(links), [links])
  const counts = useMemo(() => kindCounts(links, filter.showInactive), [links, filter.showInactive])
  const channels = useMemo(() => channelOptions(links), [links])
  const visible = useMemo(() => filterLinks(links, filter), [links, filter])
  const editing = editId ? (links.find((l) => l.id === editId) ?? null) : null

  const channelSelectOptions = [
    { value: ALL_CHANNELS, label: t('admin.invite.channelAll') },
    ...channels.map((c) => ({ value: c, label: c })),
    ...(hasUnchanneled(links) ? [{ value: NO_CHANNEL, label: t('admin.invite.channelNone') }] : []),
  ]

  const stats = [
    { key: 'links', label: t('admin.invite.statLinks'), value: `${summary.active} / ${summary.total}` },
    { key: 'clicks', label: t('admin.invite.statClicks'), value: String(summary.clicks) },
    { key: 'regs', label: t('admin.invite.statRegistrations'), value: String(summary.registrations) },
    {
      key: 'month',
      label: t('admin.invite.statMonth'),
      value: summary.registrationsMonth == null ? '—' : String(summary.registrationsMonth),
    },
  ]

  return (
    <div>
      <ToastBar toast={toast} className="mb-4" />

      <p className="mb-4 text-sm text-neutral-400">{t('admin.invite.hint')}</p>

      {/* ① 统计条：全量，不随筛选变 / stats strip: every link, unaffected by filters */}
      <div className="adm-kpis is-quad mb-4">
        {stats.map((s) => (
          <div key={s.key} className="adm-kpi">
            <p className="adm-kpi-label">{s.label}</p>
            <p className="adm-kpi-value num">{loading ? '—' : s.value}</p>
          </div>
        ))}
      </div>

      {/* ② 工具栏 / toolbar */}
      <div className="glass mb-4 flex flex-wrap items-center gap-3 p-4">
        <div className="flex flex-wrap gap-1.5" role="group">
          {KIND_FILTERS.map((k) => (
            <button
              key={k}
              type="button"
              className={segBtn(filter.kind === k)}
              aria-pressed={filter.kind === k}
              onClick={() => setFilter((f) => ({ ...f, kind: k }))}
            >
              {t(`admin.invite.kind.${k}`)} <span className="num opacity-60">{counts[k]}</span>
            </button>
          ))}
        </div>
        <Select
          className="w-full sm:w-44"
          value={filter.channel}
          ariaLabel={t('admin.invite.channelFilter')}
          onChange={(v) => setFilter((f) => ({ ...f, channel: v }))}
          options={channelSelectOptions}
        />
        <input
          className="input w-full sm:w-56"
          type="search"
          placeholder={t('admin.invite.searchPlaceholder')}
          value={filter.q}
          onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))}
        />
        <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-400">
          <Switch checked={filter.showInactive} onChange={(v) => setFilter((f) => ({ ...f, showInactive: v }))} />
          {t('admin.invite.showInactive')}
        </label>
        <button type="button" className="btn-ghost ml-auto px-4 py-1.5 text-xs" onClick={() => navigate('/admin/agents')}>
          {t('admin.invite.tree.open')}
        </button>
        <button
          type="button"
          className="btn-primary px-4 py-1.5 text-xs disabled:opacity-40"
          disabled={busyId !== null}
          onClick={() => setCreating(true)}
        >
          + {t('admin.invite.newLink')}
        </button>
      </div>

      {/* ③ 列表 / list */}
      {loading ? (
        <div className="glass space-y-2 p-4">
          {/* SkeletonLine 用 width/height props 定尺寸，不是 className——组件把宽高当内联
              样式写，className 里的 h-4/w-2/3 会被内联样式盖掉。
              SkeletonLine sizes via width/height props, not className (inline styles win). */}
          <SkeletonLine height={16} />
          <SkeletonLine width="66%" height={16} />
        </div>
      ) : links.length === 0 ? (
        <div className="glass p-8 text-center text-sm text-neutral-500">{t('admin.invite.empty')}</div>
      ) : visible.length === 0 ? (
        <div className="glass p-8 text-center text-sm text-neutral-500">{t('admin.invite.noMatch')}</div>
      ) : (
        <>
          {/* 桌面：6 列紧凑表。外层不加 overflow-x-auto——复制菜单是绝对定位的，会被裁掉；
              table-fixed + 定宽列；lg 起才用表（md 宽度下 6 列太挤），以下用卡片。
              Desktop: compact 6-column table. No overflow-x-auto on the wrapper (it would
              clip the copy menu); table-fixed with fixed columns, used from lg up (six columns
              are too cramped at md); cards below. */}
          <div className="glass hidden p-0 lg:block">
            <table className="w-full table-fixed text-left text-sm">
              <colgroup>
                <col />
                <col className="w-20" />
                <col className="w-28" />
                <col className="w-36" />
                <col className="w-36" />
                <col className="w-44" />
              </colgroup>
              <thead>
                <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-neutral-500">
                  <th className="px-4 py-3 font-medium">{t('admin.invite.colLink')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.invite.colClicks')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.invite.colRegistrations')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.invite.colStatus')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.invite.colCreated')}</th>
                  <th className="px-4 py-3 font-medium">{t('admin.colAction')}</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l) => (
                  <tr
                    key={l.id}
                    onClick={() => setEditId(l.id)}
                    className="cursor-pointer border-b border-white/5 align-top transition last:border-0 hover:bg-white/[0.03]"
                  >
                    <td className="px-4 py-3">
                      <LinkTitle l={l} />
                    </td>
                    <td className="num px-4 py-3 text-neutral-200">{l.clicks}</td>
                    <td className="px-4 py-3">
                      <span className="num text-neutral-200">{l.registrations}</span>
                      {linkKind(l) === 'competition' && (
                        <div className="text-[11px] text-neutral-500">{t('admin.invite.entriesN', { n: l.entries })}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <StatusCell l={l} globalTrialEnabled={globalTrialEnabled} />
                    </td>
                    <td className="px-4 py-3 text-xs text-neutral-400">{fmtTime(l.createdAt)}</td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <div className="flex flex-wrap gap-2">
                        <CopyLinkButton link={l} onFail={copyFailed} />
                        <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setEditId(l.id)}>
                          {t('admin.invite.edit')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 手机 / 平板：卡片 / phones and tablets: cards */}
          <div className="space-y-3 lg:hidden">
            {visible.map((l) => (
              <div key={l.id} className="glass min-w-0 p-4" onClick={() => setEditId(l.id)}>
                <LinkTitle l={l} />
                <div className="mt-3 grid grid-cols-3 gap-3">
                  <div>
                    <p className="text-[11px] text-neutral-500">{t('admin.invite.colClicks')}</p>
                    <p className="num text-lg text-neutral-100">{l.clicks}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-neutral-500">{t('admin.invite.colRegistrations')}</p>
                    <p className="num text-lg text-neutral-100">{l.registrations}</p>
                  </div>
                  {linkKind(l) === 'competition' && (
                    <div>
                      <p className="text-[11px] text-neutral-500">{t('admin.competitionPromo.step.entries')}</p>
                      <p className="num text-lg text-neutral-100">{l.entries}</p>
                    </div>
                  )}
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                  <StatusCell l={l} globalTrialEnabled={globalTrialEnabled} />
                  <span className="text-[11px] text-neutral-500">{fmtTime(l.createdAt)}</span>
                </div>
                <div className="mt-3 flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                  <CopyLinkButton link={l} onFail={copyFailed} />
                  <button type="button" className="btn-ghost px-3 py-1.5 text-xs" onClick={() => setEditId(l.id)}>
                    {t('admin.invite.edit')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {creating && (
        <InviteLinkCreateDrawer
          busy={busyId !== null}
          toast={toast}
          onCreate={create}
          onClose={() => setCreating(false)}
        />
      )}

      {editing && (
        <InviteLinkEditDrawer
          link={editing}
          busy={busyId !== null}
          globalTrialEnabled={globalTrialEnabled}
          toast={toast}
          onSave={(patch) => save(editing, patch)}
          onToggleActive={() => toggleActive(editing)}
          onToggleTrial={() => toggleTrial(editing)}
          onRequestOwner={(agent) => requestOwner(editing, agent)}
          onRequestDelete={() => setDeleteTarget(editing)}
          onCopyFail={copyFailed}
          onClose={() => setEditId(null)}
        />
      )}

      {ownerTarget && (() => {
        const oldOwner = (ownerTarget.link.agents ?? [])[0] ?? null
        const n = ownerTarget.link.ownedCustomers ?? 0
        return (
          <ConfirmModal
            busy={busyId !== null}
            title={ownerTarget.agent ? t('admin.invite.ownerConfirmTitle') : t('admin.invite.ownerClearTitle')}
            message={
              ownerTarget.agent
                ? t('admin.invite.ownerConfirmBody', { label: ownerTarget.link.label, name: ownerName(ownerTarget.agent) })
                : t('admin.invite.ownerClearBody', { label: ownerTarget.link.label })
            }
            confirmLabel={t('common.confirm')}
            onConfirm={() => void applyOwner()}
            onCancel={() => setOwnerTarget(null)}
          >
            {/* 只有旧主人名下还有经这条链接来的客户时才给这个选项。/ Only when there is someone to move. */}
            {oldOwner && n > 0 && (
              <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm text-neutral-300">
                <input
                  type="checkbox"
                  className="adm-check mt-0.5"
                  checked={moveCustomers}
                  onChange={(e) => setMoveCustomers(e.target.checked)}
                />
                <span>
                  {ownerTarget.agent
                    ? t('admin.invite.ownerMoveCustomers', { n, from: ownerName(oldOwner) })
                    : t('admin.invite.ownerMoveCustomersPlatform', { n, from: ownerName(oldOwner) })}
                </span>
              </label>
            )}
          </ConfirmModal>
        )
      })()}

      {deleteTarget && (
        <ConfirmModal
          danger
          busy={busyId !== null}
          title={t('admin.invite.deleteConfirmTitle', { label: deleteTarget.label })}
          message={(() => {
            const m = deleteConfirmMessage(deleteTarget.registrations)
            return t(m.key, m.params)
          })()}
          confirmLabel={t('admin.invite.delete')}
          onConfirm={() => void deleteLink(deleteTarget)}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}

// 链接列：标记（粗体）+ 类型徽标 + 渠道小标签；第二行灰字是比赛名 / 代理名，平台链接显示码。
// Link cell: bold label + kind badge + channel chip; grey second line is the competition
// or agent names (the code for platform links).
function LinkTitle({ l }: { l: InviteLink }) {
  const { t } = useTranslation()
  const kind = linkKind(l)
  const sub = secondaryLine(l)
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="truncate font-semibold text-neutral-100">{l.label}</span>
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${kindBadgeClass(kind)}`}>
          {t(`admin.invite.kind.${kind}`)}
        </span>
        {l.channel && (
          <span className="rounded-full border border-white/10 px-1.5 py-0.5 text-[10px] text-neutral-400">{l.channel}</span>
        )}
      </div>
      <div className="mt-0.5 truncate text-xs text-neutral-500">{sub || <span className="num">{l.code}</span>}</div>
    </div>
  )
}

// 状态：圆点 + 启用 / 停用；送试用时加小标，全局试用关闭时小标置灰并给出原因（title）。
// Status: dot + active/disabled, plus a trial chip that greys out with a reason when the
// global trial is off.
function StatusCell({ l, globalTrialEnabled }: { l: InviteLink; globalTrialEnabled: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className={`inline-block h-2 w-2 rounded-full ${l.isActive ? 'bg-up' : 'bg-neutral-600'}`} aria-hidden />
      <span className={l.isActive ? 'text-neutral-200' : 'text-neutral-500'}>
        {l.isActive ? t('admin.invite.active') : t('admin.invite.inactive')}
      </span>
      {l.grantsTrial && (
        <span
          className={`rounded-full bg-prism-500/20 px-1.5 py-0.5 text-[10px] text-prism-200 ${globalTrialEnabled ? '' : 'opacity-50'}`}
          title={globalTrialEnabled ? undefined : t('admin.invite.grantsTrialBlocked')}
        >
          {t('admin.invite.trialTag')}
        </span>
      )}
    </div>
  )
}
