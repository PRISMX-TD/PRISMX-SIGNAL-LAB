// 管理控制台「用户 › 用户列表」：搜索 / 筛选、用户表（角色、等级、到期、备注、停用、邮箱验证）、批量修改。
// 2026-10-17 从 AdminPage 拆出来并重做视觉：工具条一整块、身份格带头像、批量操作改成浮在底部的操作坞
// （勾选之后不用滚回顶上找批量条）。数据与确认流程照旧，下面的注释大多是从原文件原样搬过来的。
// The console's Users › list: search / filters, the user table (role, plan, expiry, note, disable,
// email verification) and bulk edit. Split out of AdminPage on 2026-10-17 with a visual redo: one
// toolbar plane, an identity cell with an avatar, and bulk edit as a dock floating at the bottom
// (no scrolling back up to find the bulk bar). Data flow and confirmations are unchanged; most
// comments below moved over verbatim.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { adminApi, isAbortError } from '../../api/client'
import { fmtDayShort, fmtTime, localizeApiError } from '../../api/utils'
import type { AdminAgentTreeNode, AdminUser, InviteLink, UserPlan, UserRole } from '../../api/types'
import ConfirmModal from '../ConfirmModal'
import Pager from '../Pager'
import Select from '../Select'
import { SkeletonLine } from '../Skeleton'
import Switch from '../Switch'
import { Avatar, fmtClock } from '../support/supportUi'
import type { LogsPreset } from './ActivityLogPanel'
import DisableUserModal from './DisableUserModal'
import { IconClose, IconGlobe, IconHistory, IconSearch } from './console/consoleIcons'
import UserIpSheet from './users/UserIpSheet'
import { attributionOptions } from './invite/inviteLinkLogic'
import { isUserDisabled } from './userStatus'

const PLAN_OPTIONS: UserPlan[] = ['FREE', 'PRO']
// support = 客服（rev 41，设计 2026-10-17 §2）/ support = support-desk agent (rev 41)
const ROLE_OPTIONS: UserRole[] = ['user', 'support', 'admin']
type SupportTierDraft = '' | 'internal' | 'outsourced'

// 归因筛选里「只看没有归因的人」的哨兵值，与后端 routers/admin.py 的 NO_INVITE
// 是同一个字符串——真码是 8 位、字母表里没有 o，'none' 永远撞不上某条真链接。
// Sentinel for "only unattributed" in the filter; the same string as NO_INVITE in
// routers/admin.py. Real codes are 8 chars from an alphabet without "o".
const NO_INVITE = 'none'

// 批量指派下拉里「清除归因」的哨兵。只活在前端：发出去时翻译成 payload 里的
// null（见 bulkPayload）。不能用 NO_INVITE——那是"筛选出没归因的人"，不是"把
// 归因清掉"，两个意思撞在一个值上迟早会把筛选条件当成要写入的值发出去。
// Sentinel for "clear attribution" in the bulk dropdown. Frontend-only: it
// becomes a null in the payload (see bulkPayload). Deliberately not NO_INVITE,
// which means "show the unattributed" — one value for both would eventually send
// a filter term as a value to write.
const BULK_CLEAR_INVITE = '__clear__'

// 用户表每页条数：管理员自己选，默认 20。后端 `limit` 的上限是 PAGE_SIZE_MAX=200，
// 三档都在其内。默认 20 而不是 50：这张表一行有七八个控件、一屏放不下 50 行，而「全选」
// 勾的是**当前这一页**，一页 50 条时那一勾覆盖的人远多于屏幕上看得见的，正是批量操作最
// 容易估错人数的地方（见 handleSearch 的注释）。
// Rows per page, chosen by the admin; 20 by default (the backend caps `limit` at 200). Not 50:
// a row carries seven or eight controls, and "select all" ticks the current page — at 50 that
// covers far more people than are visible, which is how a bulk edit's count gets misjudged.
const PAGE_SIZE_OPTIONS = [10, 20, 50]
const DEFAULT_PAGE_SIZE = 20

interface Draft {
  role: UserRole
  supportTier: SupportTierDraft
  plan: UserPlan
  planExpiresAt: string // yyyy-mm-dd，空字符串表示永不到期 / empty string = never expires
  planNote: string
}

function toDraft(u: AdminUser): Draft {
  return {
    role: u.role,
    supportTier: u.supportTier ?? '',
    plan: u.plan,
    planExpiresAt: u.planExpiresAt ? u.planExpiresAt.slice(0, 10) : '',
    planNote: u.planNote ?? '',
  }
}

function isDirty(u: AdminUser, d: Draft | undefined): boolean {
  if (!d) return false
  const origExpiry = u.planExpiresAt ? u.planExpiresAt.slice(0, 10) : ''
  return d.role !== u.role || (d.role === 'support' && d.supportTier !== (u.supportTier ?? '')) || d.plan !== u.plan || d.planExpiresAt !== origExpiry || d.planNote !== (u.planNote ?? '')
}

// 表格里的时刻写短：「16/09 20:58」，完整的带秒、带 UTC+8 的写法放进 title。这张表横向最挤，
// 两列各省下一截，表格在 1440 宽的屏幕上就不用横向滚动。
// Short stamps in the table ("16/09 20:58"), the full seconds-and-UTC+8 form in the title. This table
// is the tightest horizontally; the saving lets it fit a 1440px screen without scrolling sideways.
function shortStamp(iso: string | null | undefined): string {
  const day = fmtDayShort(iso)
  return day ? `${day} ${fmtClock(iso)}` : '-'
}

export default function UsersPanel({
  onToast,
  onEmailUsers,
  onAssignUsers,
  onShowLogs,
}: {
  onToast: (kind: 'ok' | 'err', text: string) => void
  // 批量坞「发邮件」/「分配跟进」把勾中的人带到对应分区；「日志」把这个人带进操作日志。
  // The dock's Email / Assign carry the ticked users to those sections; Log carries one user to the log.
  onEmailUsers: (ids: string[]) => void
  onAssignUsers: (ids: string[]) => void
  onShowLogs: (preset: LogsPreset) => void
}) {
  const { t } = useTranslation()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  // 用户表当前页（从 0 起，与 components/Pager 的约定一致）。
  // Current user-table page, zero-based to match components/Pager's contract.
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  // ?q=<邮箱>：操作日志详情里的「打开用户资料」、后端通知里的 /admin?tab=users&q=… 都带着它进来。
  // 只在挂载时读一次，读完从地址栏抹掉（同工单深链），免得管理员清掉搜索后一刷新又被带回来。
  // ?q=<email> arrives from the activity drawer's "open user" and backend notifications
  // (/admin?tab=users&q=…). Read once on mount, then removed (as the ticket deep link does) so a
  // cleared search doesn't come back on refresh.
  const [searchParams, setSearchParams] = useSearchParams()
  const [initialQ] = useState(() => searchParams.get('q') ?? '')
  const [query, setQuery] = useState(initialQ)
  // 登录 IP 侧栏的目标用户 / target of the login-IP sheet
  const [ipSheet, setIpSheet] = useState<{ id: string; label: string } | null>(null)
  const [planFilter, setPlanFilter] = useState('')
  // 按注册归因筛选：'' = 全部，NO_INVITE = 只看没有归因的人，其余是某条链接的 code。
  // Filter by attribution: '' all, NO_INVITE only unattributed, otherwise a link's code.
  const [inviteFilter, setInviteFilter] = useState('')
  // 邀请链接表：既给筛选器和批量指派当选项，也负责把用户行上的 code 映射成人
  // 看得懂的备注名。归因列显示的是备注，不是那串随机码。
  // The invite links: options for the filter and the bulk assign box, and the
  // code → label map for the attribution column. Nobody can read the raw code.
  const [inviteLinks, setInviteLinks] = useState<InviteLink[]>([])
  // rev 50：归属代理与来源分开。agentFilter：'' = 全部，NO_INVITE = 平台客户，其余是代理 user id。
  // agents 是全部代理（筛选、批量改归属的选项）。
  // rev 50: owning agent is separate from the source. agentFilter: '' all, NO_INVITE platform
  // customers, otherwise an agent's user id. agents feeds the filter and the bulk box.
  const [agentFilter, setAgentFilter] = useState('')
  const [agents, setAgents] = useState<AdminAgentTreeNode[]>([])
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [savingId, setSavingId] = useState<string | null>(null)

  // 批量选择与批量修改：勾选后统一改角色/等级，空字符串代表"不修改该字段"
  // bulk selection & bulk edit: '' means "leave this field unchanged"
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkRole, setBulkRole] = useState('')
  const [bulkPlan, setBulkPlan] = useState('')
  // 到期时间需要单独一个"是否要改"开关：日期本身留空是合法值（永不到期），
  // 不能用空字符串同时表示"不改"和"清除到期时间" / expiry needs its own
  // on/off switch — an empty date is a valid value (never expires), so an
  // empty string can't double as both "leave unchanged" and "clear it"
  const [bulkSetExpiry, setBulkSetExpiry] = useState(false)
  const [bulkExpiry, setBulkExpiry] = useState('')
  // 批量指派归因：'' = 不修改，BULK_CLEAR_INVITE = 清除归因，其余是链接 code。
  // 清除要单独一档而不是复用空串：空串同时表示"不改"和"清空"的话，管理员想撤回
  // 一次指派就做不到——而指派错人恰恰是这个功能最可能出的错。
  // Bulk attribution: '' leaves it alone, BULK_CLEAR_INVITE clears it, anything
  // else is a link code. Clearing needs its own option — if the empty string
  // meant both "unchanged" and "clear", an assignment could never be undone,
  // and assigning the wrong people is exactly this feature's likely mistake.
  const [bulkInvite, setBulkInvite] = useState('')
  // 批量改归属代理：'' = 不改，BULK_CLEAR_INVITE = 改成平台客户，其余是代理 user id。
  // Bulk owning agent: '' unchanged, BULK_CLEAR_INVITE = platform customer, else an agent id.
  const [bulkAgent, setBulkAgent] = useState('')
  const [bulkSaving, setBulkSaving] = useState(false)
  const headerCheckboxRef = useRef<HTMLInputElement>(null)

  // 竞态守卫：搜索连点、快速翻页时，先发的响应后到会覆盖后发的结果——表格显示的是上一次
  // 查询，而搜索框、筛选器和页码显示的是这一次。卸载时中止并置空：置空之后下面那句
  // `loadCtrl.current !== ctrl` 的守卫同时兼任"组件已经没了，别再 setState"。
  // Race guard: with rapid searches or page flips an earlier response can land last, leaving
  // the table showing the previous query while the search box, filter and page number describe
  // the current one. Abort and null on unmount: nulling makes the `loadCtrl.current !== ctrl`
  // guard below double as "we're gone, don't setState".
  const loadCtrl = useRef<AbortController | null>(null)
  useEffect(() => () => {
    loadCtrl.current?.abort()
    loadCtrl.current = null
  }, [])

  const load = async (opts: { q?: string; plan?: string; invite?: string; agent?: string; size?: number; page?: number } = {}) => {
    loadCtrl.current?.abort()
    const ctrl = new AbortController()
    loadCtrl.current = ctrl
    const wantedPage = opts.page ?? page
    // 新值走 opts：setState 是异步的，改完每页条数紧接着 load()，这里读到的还是旧值，
    // 于是第一次请求仍按旧条数发，表格与下拉说的不是一回事。
    // The new value comes through opts: setState is async, so a load() fired right
    // after changing the page size would still send the old limit and the table
    // would disagree with the dropdown.
    const wantedSize = opts.size ?? pageSize
    setLoading(true)
    try {
      // 用户表与邀请链接各自 settle：一个失败另一个照常显示，只提示"N 项没加载出来"。
      // 链接拉不到时归因列退化成显示原始 code（仍然看得出谁挂在哪，只是不好读），两个下拉
      // 只剩固定选项。includeDeleted：已删除（软删）的链接仍有人归因在上面，归因列与筛选器
      // 要能显示它的名字。
      // The user list and the invite links settle separately so one failure never hides the
      // other. Without links the attribution column falls back to the raw code — still correct,
      // just unreadable — and the dropdowns keep their fixed options. includeDeleted:
      // soft-deleted links still have users attributed to them.
      const results = await Promise.allSettled([
        adminApi.listUsers(
          {
            q: (opts.q ?? query) || undefined,
            plan: (opts.plan ?? planFilter) || undefined,
            inviteCode: (opts.invite ?? inviteFilter) || undefined,
            agent: (opts.agent ?? agentFilter) || undefined,
            limit: wantedSize,
            offset: wantedPage * wantedSize,
          },
          ctrl.signal,
        ),
        adminApi.listInviteLinks({ includeDeleted: true }),
        adminApi.agentTree(),
      ])
      // 这一批已经被后来的一次 load 取代：链接请求没有 signal、照样会成功返回，若继续往下走
      // 就会用上一次的数据把新的一次盖掉——正是这里要防的那件事。
      // Superseded by a later load: the links call carries no signal and still resolves, so
      // falling through would overwrite the newer load's data with this one's.
      if (loadCtrl.current !== ctrl) return
      const [usersRes, linksRes, treeRes] = results
      setPage(wantedPage)
      setPageSize(wantedSize)
      if (usersRes.status === 'fulfilled') {
        setUsers(usersRes.value.users)
        setTotal(usersRes.value.total)
        setDrafts(Object.fromEntries(usersRes.value.users.map((u) => [u.id, toDraft(u)])))
      }
      if (linksRes.status === 'fulfilled') setInviteLinks(linksRes.value.links)
      if (treeRes.status === 'fulfilled') setAgents(treeRes.value.nodes)
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      // 被中止的那次不算失败：那是我们自己取消的 / an abort is our own cancellation, not a failure
      if (rejected.length && !rejected.every((r) => isAbortError(r.reason))) {
        const reason = rejected[0].reason
        const detail = reason instanceof Error ? localizeApiError(reason.message) : ''
        onToast('err', t('admin.loadPartialError', { n: rejected.length, total: results.length }) + (detail ? ` (${detail})` : ''))
      }
    } finally {
      if (loadCtrl.current === ctrl) setLoading(false)
    }
  }

  useEffect(() => {
    void load({ q: initialQ })
    if (searchParams.has('q')) {
      const next = new URLSearchParams(searchParams)
      next.delete('q')
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 搜索与翻页都回到第一页并清空勾选。
  // 清勾选是有意的：批量操作是本页最危险的动作，而"选中的人跨页留着、屏幕上却
  // 只看得到当前这一页"正是会让人按下确认时算错人数的那种状态。规则统一成
  // 「你勾的就是你看得见的」，确认框里的 N 与屏幕上的勾一一对上。
  // Searching and paging both return to page one and clear the selection. The
  // clearing is deliberate: bulk edits are the most dangerous action on this
  // page, and a selection that survives across pages while only the current page
  // is visible is exactly the state in which someone misjudges the count at the
  // confirm prompt. The rule is "what you ticked is what you can see", so the N
  // in the dialog always matches the ticks on screen.
  const handleSearch = (e: FormEvent) => {
    e.preventDefault()
    setSelectedIds(new Set())
    void load({ page: 0 })
  }

  // 等级与归因两个下拉改一下就立刻查，不用再点一次「搜索」：选完就是明确的意图，而下拉改了
  // 表格不动会让人以为没生效。新值走 opts 传进去——setState 是异步的，load() 里读到的还会是旧值。
  // The plan and attribution dropdowns query on change instead of waiting for the search button:
  // picking is already an unambiguous intent, and a table that doesn't move reads as broken. The
  // new value goes through opts because setState is async.
  const changePlanFilter = (value: string) => {
    setPlanFilter(value)
    setSelectedIds(new Set())
    void load({ plan: value, page: 0 })
  }
  const changeInviteFilter = (value: string) => {
    setInviteFilter(value)
    setSelectedIds(new Set())
    void load({ invite: value, page: 0 })
  }
  const changeAgentFilter = (value: string) => {
    setAgentFilter(value)
    setSelectedIds(new Set())
    void load({ agent: value, page: 0 })
  }
  const agentOptions = agents.map((a) => ({ value: a.userId, label: `${a.nickname || a.email} · L${a.level}` }))
  const agentLabel = (id: string) => {
    const a = agents.find((x) => x.userId === id)
    return a ? a.nickname || a.email : id
  }

  // 改每页条数：回第一页并清空勾选，理由同搜索与翻页（勾的必须是看得见的）。
  // Changing the page size returns to page one and clears the selection, for the
  // same reason searching and paging do: what is ticked must be what is visible.
  const changePageSize = (value: string) => {
    setSelectedIds(new Set())
    void load({ size: Number(value), page: 0 })
  }

  // code → 链接备注。链接拉不到、或者用户挂着一条已被删掉的码时退回显示码本身，
  // 绝不显示空白——空白会被读成"没有归因"，而那是另一回事。
  // code → label, falling back to the code itself when the link list is missing
  // or the code is unknown. Never blank: blank reads as "no attribution", which
  // is a different fact.
  const linkLabel = (code: string) => inviteLinks.find((l) => l.code === code)?.label || code

  const goToPage = (next: number) => {
    setSelectedIds(new Set())
    void load({ page: next })
  }

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = users.length > 0 && users.every((u) => selectedIds.has(u.id))
  const someSelected = users.some((u) => selectedIds.has(u.id))
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  useEffect(() => {
    if (headerCheckboxRef.current) {
      headerCheckboxRef.current.indeterminate = someSelected && !allSelected
    }
  }, [someSelected, allSelected])

  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      if (allSelected) return new Set()
      const next = new Set(prev)
      users.forEach((u) => next.add(u.id))
      return next
    })
  }

  // 批量修改要落的具体字段，同时给确认框当文案素材。
  // 写成一个函数而不是在两处各拼一遍：确认框里说的必须和真正发出去的 payload
  // 是同一份东西，分开写迟早对不上——而这正是"确认框说改等级、实际把人提成了
  // 管理员"这类事故的来源。
  // The exact fields a bulk edit will write, doubling as the confirm dialog's
  // copy. One function rather than two parallel constructions: what the dialog
  // says must be the same thing the payload sends, and two copies eventually
  // disagree — which is how "the dialog said plan, the request said admin"
  // happens.
  const bulkPayload = () => {
    const payload: Partial<{ role: UserRole; plan: UserPlan; planExpiresAt: string | null; inviteCode: string | null; agentUserId: string | null }> = {}
    const changes: string[] = []
    if (bulkRole) {
      payload.role = bulkRole as UserRole
      changes.push(t('admin.changeRole', { value: bulkRole }))
    }
    if (bulkPlan) {
      payload.plan = bulkPlan as UserPlan
      changes.push(t('admin.changePlan', { value: bulkPlan }))
    }
    if (bulkSetExpiry) {
      payload.planExpiresAt = bulkExpiry ? new Date(`${bulkExpiry}T00:00:00Z`).toISOString() : null
      changes.push(t('admin.changeExpiry', { value: bulkExpiry || t('admin.neverExpires') }))
    }
    if (bulkInvite) {
      const clearing = bulkInvite === BULK_CLEAR_INVITE
      payload.inviteCode = clearing ? null : bulkInvite
      changes.push(t('admin.changeInvite', { value: clearing ? t('admin.inviteNone') : linkLabel(bulkInvite) }))
    }
    if (bulkAgent) {
      const clearing = bulkAgent === BULK_CLEAR_INVITE
      payload.agentUserId = clearing ? null : bulkAgent
      changes.push(t('admin.changeAgent', { value: clearing ? t('admin.agentNone') : agentLabel(bulkAgent) }))
    }
    return { payload, changes }
  }

  // 二次确认：一次点击就能把最多一整页的账号 role 批量改成 admin，或者把套餐整批降级 /
  // 清掉到期日。所有修改都会记录在操作日志里（一次批量是一行、展开看每个人），但查得到
  // 不等于撤得回，所以确认照旧。
  // Second confirmation: one click could bulk-set a whole page of accounts to role=admin, or
  // downgrade plans and wipe expiry dates. Every change lands in the activity log (one row per
  // bulk edit, expandable per user), but traceable is not reversible, so the confirmation stays.
  const [bulkConfirm, setBulkConfirm] = useState(false)
  const bulkHasChange = !!(bulkRole || bulkPlan || bulkSetExpiry || bulkInvite || bulkAgent)

  const clearBulk = () => {
    setSelectedIds(new Set())
    setBulkRole('')
    setBulkPlan('')
    setBulkSetExpiry(false)
    setBulkExpiry('')
    setBulkInvite('')
    setBulkAgent('')
  }

  const applyBulk = async () => {
    if (!bulkHasChange) return
    setBulkConfirm(false)
    setBulkSaving(true)
    try {
      const { payload } = bulkPayload()
      const res = await adminApi.bulkUpdateUsers(Array.from(selectedIds), payload)
      onToast('ok', t('admin.bulkSaved', { n: res.updated }))
      clearBulk()
      void load()
    } catch (err) {
      onToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setBulkSaving(false)
    }
  }

  const updateDraft = (id: string, patch: Partial<Draft>) => {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }

  const resetDraft = (u: AdminUser) => {
    setDrafts((prev) => ({ ...prev, [u.id]: toDraft(u) }))
  }

  // 单条保存里唯一需要拦一道的是提权：user → admin 是本页最不可逆的动作（新管理员
  // 立刻拿到全部后台权限，降回去之前他做过的事已经做了——操作日志事后查得到每一项，
  // 但挡不住），而下拉框选错一行 + 点保存就生效。其余字段（等级、到期日、备注）改错
  // 了当场改回来即可，不值得为它们多一次点击。
  // The one single-row change worth interrupting is a promotion: user → admin is
  // the least reversible action here (the new admin has every permission at once,
  // and whatever they do before a demotion is done — the activity log records it
  // afterwards but cannot prevent it), and it takes one mis-picked dropdown plus
  // Save. The other fields (plan, expiry, note) can be corrected on the spot and
  // don't deserve an extra click.
  const [promoteTarget, setPromoteTarget] = useState<AdminUser | null>(null)

  // ---- 停用 / 恢复 ----
  //
  // 两个方向都要确认，理由不对称但都成立：停用会立刻把人挡在门外（他的每个接口
  // 都变 403，正在用的会话当场断），恢复则是把一个曾被判定有问题的账号重新放
  // 进来——后者点错的代价比前者小，但一样是"对别人生效、自己看不见后果"的操作。
  //
  // savingId 没有复用：它管的是同一行的"保存"按钮，和停用开关是两个独立的
  // 请求，共用一个 id 会让其中一个转圈时把另一个也禁掉。
  //
  // Both directions confirm. The reasons differ but both hold: disabling locks
  // someone out at once (every endpoint turns 403, live sessions drop mid-use),
  // while restoring lets an account previously judged problematic back in — a
  // cheaper mistake, but still one that takes effect on someone else, out of
  // sight of whoever clicked.
  //
  // savingId is deliberately not reused: it drives that row's Save button, and
  // the status toggle is an independent request — sharing one id would have
  // either spinner disable the other control.
  const [disableTarget, setDisableTarget] = useState<AdminUser | null>(null)
  const [enableTarget, setEnableTarget] = useState<AdminUser | null>(null)
  const [statusSavingId, setStatusSavingId] = useState<string | null>(null)

  // ---- 手动标记邮箱已验证 ----
  // 给收不到验证信的用户兜底。只有「标记」没有「撤销」（见后端
  // admin.mark_email_verified 的说明），所以先确认一次。
  // Fallback for users whose verification mail never arrives. One-way (no
  // "unverify", see the backend docstring), hence the confirmation.
  const [verifyTarget, setVerifyTarget] = useState<AdminUser | null>(null)
  const [verifySavingId, setVerifySavingId] = useState<string | null>(null)

  // 后端返回整行就地替换，否则重拉——见 client.ts 里这几个端点的注释：返回体的形状没拿它当前提。
  // Replace the row in place when the backend returns one, otherwise refetch — see the comment
  // on these endpoints in client.ts: nothing here depends on the response shape.
  const replaceRow = (u: AdminUser, updated: AdminUser | null | undefined) => {
    if (updated?.id === u.id) {
      setUsers((prev) => prev.map((x) => (x.id === u.id ? updated : x)))
      setDrafts((prev) => ({ ...prev, [u.id]: toDraft(updated) }))
    } else {
      void load()
    }
  }

  const applyVerified = async (u: AdminUser) => {
    setVerifySavingId(u.id)
    try {
      replaceRow(u, await adminApi.markEmailVerified(u.id))
      onToast('ok', t('admin.verifyEmailOk'))
      setVerifyTarget(null)
    } catch (err) {
      onToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setVerifySavingId(null)
    }
  }

  // reason 为 null 表示"恢复"，非 null 表示"停用并附上这个原因"。合成一个函数
  // 是因为两条路除了调用哪个端点之外，成功/失败后的处理完全一样。
  // A null reason means restore, a non-null one means disable with that reason.
  // One function because the two paths differ only in which endpoint is called;
  // everything after the response is identical.
  const applyDisabled = async (u: AdminUser, reason: string | null) => {
    setStatusSavingId(u.id)
    try {
      replaceRow(u, reason === null ? await adminApi.enableUser(u.id) : await adminApi.disableUser(u.id, reason))
      onToast('ok', reason === null ? t('admin.enabledOk') : t('admin.disabledOk'))
      setDisableTarget(null)
      setEnableTarget(null)
    } catch (err) {
      // 刻意不关弹窗：失败时保留已填的原因，管理员可以直接重试。
      // The dialog stays open on failure so the typed reason survives a retry.
      onToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setStatusSavingId(null)
    }
  }

  const requestSave = (u: AdminUser) => {
    const d = drafts[u.id]
    if (!d) return
    if (d.role === 'admin' && u.role !== 'admin') {
      setPromoteTarget(u)
      return
    }
    void save(u)
  }

  const save = async (u: AdminUser) => {
    const d = drafts[u.id]
    if (!d) return
    setPromoteTarget(null)
    setSavingId(u.id)
    try {
      const updated = await adminApi.updateUser(u.id, {
        role: d.role,
        // 客服带 tier；未选 = 按外包处理（后端同口径）/ support carries a tier; unset reads as outsourced
        ...(d.role === 'support' && d.supportTier !== (u.supportTier ?? '') ? { supportTier: d.supportTier || null } : {}),
        plan: d.plan,
        planExpiresAt: d.planExpiresAt ? new Date(`${d.planExpiresAt}T00:00:00Z`).toISOString() : null,
        planNote: d.planNote.trim() || null,
      })
      setUsers((prev) => prev.map((x) => (x.id === u.id ? updated : x)))
      setDrafts((prev) => ({ ...prev, [u.id]: toDraft(updated) }))
      onToast('ok', t('admin.saved'))
    } catch (err) {
      onToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* 工具条：搜索 + 两个筛选 + 每页条数与总数。每页条数挨着总数放：两者说的是同一件事
          （这张表现在给你看多少），而翻页控件在表格下方、滚到底才看得见。
          Toolbar: search, two filters, rows-per-page beside the total — both answer "how much of
          this table am I being shown", while the pager sits below the table. */}
      <form onSubmit={handleSearch} className="adm-toolbar">
        <label className="adm-search">
          <IconSearch />
          <input
            type="search"
            placeholder={t('admin.searchPlaceholder')}
            aria-label={t('admin.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" className="adm-search-go">{t('admin.search')}</button>
        </label>
        <div className="adm-filter">
          <span>{t('admin.colPlan')}</span>
          <Select
            value={planFilter}
            onChange={changePlanFilter}
            ariaLabel={t('admin.colPlan')}
            options={[{ value: '', label: t('signals.all') }, ...PLAN_OPTIONS.map((p) => ({ value: p, label: p }))]}
          />
        </div>
        <div className="adm-filter">
          <span>{t('admin.colInvite')}</span>
          <Select
            value={inviteFilter}
            onChange={changeInviteFilter}
            ariaLabel={t('admin.colInvite')}
            options={[
              { value: '', label: t('signals.all') },
              { value: NO_INVITE, label: t('admin.inviteNone') },
              ...attributionOptions(inviteLinks, t('admin.inviteDeletedTag')),
            ]}
          />
        </div>
        <div className="adm-filter">
          <span>{t('admin.colAgent')}</span>
          <Select
            value={agentFilter}
            onChange={changeAgentFilter}
            ariaLabel={t('admin.colAgent')}
            options={[
              { value: '', label: t('signals.all') },
              { value: NO_INVITE, label: t('admin.agentNone') },
              ...agentOptions,
            ]}
          />
        </div>
        <div className="adm-toolbar-end">
          <span className="adm-count">{t('admin.totalCount', { n: total })}</span>
          <div className="adm-filter">
            <span>{t('admin.perPage')}</span>
            <Select
              value={String(pageSize)}
              onChange={changePageSize}
              ariaLabel={t('admin.perPage')}
              options={PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
            />
          </div>
        </div>
      </form>

      {/* 用户表 / user table */}
      <div className="adm-table-wrap">
        {loading && users.length === 0 ? (
          <div className="flex flex-col gap-3 p-6">
            <SkeletonLine width="35%" height={14} />
            <SkeletonLine />
            <SkeletonLine width="80%" />
            <SkeletonLine width="60%" />
          </div>
        ) : users.length === 0 ? (
          <div className="adm-empty">
            <p className="adm-empty-title">{t('admin.noUsers')}</p>
          </div>
        ) : (
          <table className={`adm-table min-w-[1020px] ${loading ? 'is-loading' : ''}`}>
            <thead>
              <tr>
                <th className="adm-th-check">
                  <input
                    ref={headerCheckboxRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    className="adm-check"
                    aria-label={t('admin.bulkSelectAll')}
                  />
                </th>
                {/* 身份格同时放昵称、邮箱、手机号与注册时间：手机号不是可改的设置项，单占一列等于
                    用最贵的横向空间放一条只读信息；搜索框本来就同时搜这几样。
                    The identity cell carries nickname, email, phone and signup time: the phone is
                    not an editable setting, and the search box already matches all of them. */}
                <th>{t('admin.colNickname')} / {t('admin.colEmail')} / {t('admin.colPhone')}</th>
                {/* 状态列紧跟身份：停用是这张表上唯一"人还在不在"的信息，排在角色/等级后面就会被
                    一排下拉框淹没。同一格既是指示灯也是开关。
                    Status right after identity: the only "can this person still get in" fact,
                    which further right drowns among dropdowns. One cell is indicator and control. */}
                <th>{t('admin.colStatus')}</th>
                <th>{t('admin.colRole')}</th>
                {/* 等级与到期叠在一格：两者说的是同一份订阅 / plan and expiry share a cell: one subscription */}
                <th>{t('admin.colPlan')} / {t('admin.colExpiresAt')}</th>
                <th>{t('admin.colNote')}</th>
                {/* 归因列：这个人算在哪条邀请链接名下，也就是哪个代理能看到他。只读——改它走批量
                    指派（勾一个人也走那条路），免得一张表里多出第五个会写库的控件。
                    Which link this user counts towards, i.e. whose agent page they appear on.
                    Read-only; changes go through bulk assign (ticking one row works). */}
                <th className="whitespace-nowrap">{t('admin.colInvite')} / {t('admin.colAgent')}</th>
                <th>{t('admin.colLastActive')}</th>
                <th className="text-right">{t('admin.colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => {
                const d = drafts[u.id] ?? toDraft(u)
                const dirty = isDirty(u, d)
                const disabled = isUserDisabled(u)
                const selected = selectedIds.has(u.id)
                return (
                  // 停用行整行染红，压过勾选的底色：勾选是"我正在操作它"，停用是"它现在的状态"，
                  // 后者更该被一眼看见，而两种底色叠在一起谁也读不清。改了没存的行左侧亮一条紫线。
                  // A disabled row is tinted red over the selection tint: selection is "I'm working
                  // on it", disabled is what it *is*. An edited-but-unsaved row gets a violet edge.
                  <tr
                    key={u.id}
                    className={`adm-rise ${disabled ? 'is-disabled' : selected ? 'is-sel' : ''} ${dirty ? 'is-dirty' : ''}`}
                    style={{ ['--i' as string]: Math.min(i, 12) }}
                  >
                    <td className="adm-th-check">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleSelected(u.id)}
                        className="adm-check"
                        aria-label={u.email}
                      />
                    </td>
                    <td>
                      <div className="flex min-w-0 items-start gap-3">
                        <Avatar name={u.nickname || u.email} size={34} tone={u.role === 'user' ? 'neutral' : 'staff'} />
                        <div className="min-w-0 max-w-[196px]">
                          {/* 昵称：没设过就不占行 / nickname: omitted when unset */}
                          {u.nickname && (
                            <div className="truncate text-[13px] font-semibold text-neutral-50" title={u.nickname}>
                              {u.nickname}
                            </div>
                          )}
                          <div className={`truncate font-mono text-xs ${u.nickname ? 'text-neutral-400' : 'text-neutral-100'}`} title={u.email}>
                            {u.email}
                          </div>
                          <div className="mt-1 flex items-center gap-2 whitespace-nowrap text-[11px] text-neutral-500">
                            {/* 手机号：存量用户为空，用「-」而不是留白，否则看起来像渲染坏了。
                                Empty for grandfathered users; a dash, not blank space. */}
                            <span className="font-mono text-neutral-400">{u.phone || '-'}</span>
                            <span aria-hidden="true" className="h-2.5 w-px bg-white/10" />
                            <span title={fmtTime(u.createdAt)}>{shortStamp(u.createdAt)}</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    {/* 状态：开关走全站唯一的 Switch，checked = 账号可用。它不是即时开关——两个方向
                        都先开确认框，状态只在后端确认之后才翻，所以按下去到翻过来之间保持原样并转圈。
                        Status: the site's one Switch, checked = the account works. Not instant —
                        both directions confirm first, and it spins (busy) until the backend agrees. */}
                    <td>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={!disabled}
                          busy={statusSavingId === u.id}
                          onChange={(next) => (next ? setEnableTarget(u) : setDisableTarget(u))}
                          aria-label={t(disabled ? 'admin.enable' : 'admin.disable')}
                        />
                        <span className={`whitespace-nowrap text-xs ${disabled ? 'font-semibold text-down' : 'text-neutral-400'}`}>
                          {t(disabled ? 'admin.statusDisabled' : 'admin.statusActive')}
                        </span>
                      </div>
                      {/* 邮箱未验证，带一个手动标记的入口。只认 === null（见 AdminUser.emailVerifiedAt）。
                          Unverified email, with a manual mark action. Only === null counts. */}
                      {u.emailVerifiedAt === null && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <span className="adm-pill is-warn">{t('admin.emailUnverified')}</span>
                          <button
                            type="button"
                            onClick={() => setVerifyTarget(u)}
                            disabled={verifySavingId === u.id}
                            className="adm-link-btn"
                          >
                            {t('admin.markVerified')}
                          </button>
                        </div>
                      )}
                      {/* 停用时间与原因：一行"已停用"只回答了"是不是"，回答不了客服真正会被问到的
                          "什么时候、为什么"。原因可能很长，截断显示并把全文放进 title。
                          Time and reason: a bare "disabled" answers only whether, not when and why.
                          The reason is clamped with the full text in the title. */}
                      {disabled && (
                        <div className="mt-2 max-w-[200px] space-y-0.5">
                          <div className="text-[11px] text-neutral-500">{fmtTime(u.disabledAt)}</div>
                          {u.disabledReason && (
                            <div className="truncate text-[11px] text-neutral-400" title={u.disabledReason}>
                              {u.disabledReason}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <Select
                        value={d.role}
                        onChange={(v) => updateDraft(u.id, { role: v as UserRole })}
                        className="select-tight"
                        ariaLabel={t('admin.colRole')}
                        options={ROLE_OPTIONS.map((r) => ({ value: r, label: t(`admin.support.role.${r}`) }))}
                      />
                      {d.role === 'support' && (
                        <div className="mt-1.5">
                          <Select
                            value={d.supportTier}
                            onChange={(v) => updateDraft(u.id, { supportTier: v as SupportTierDraft })}
                            className="select-tight"
                            ariaLabel={t('admin.support.staff.tier')}
                            options={[
                              { value: '', label: t('admin.support.staff.tierUnset') },
                              { value: 'internal', label: t('admin.support.tier.internal') },
                              { value: 'outsourced', label: t('admin.support.tier.outsourced') },
                            ]}
                          />
                        </div>
                      )}
                    </td>
                    <td>
                      <Select
                        value={d.plan}
                        onChange={(v) => updateDraft(u.id, { plan: v as UserPlan })}
                        className="select-tight"
                        ariaLabel={t('admin.colPlan')}
                        options={PLAN_OPTIONS.map((p) => ({ value: p, label: p }))}
                      />
                      <input
                        type="date"
                        className="adm-input mt-1.5 block w-[136px]"
                        aria-label={t('admin.colExpiresAt')}
                        title={t('admin.colExpiresAt')}
                        value={d.planExpiresAt}
                        onChange={(e) => updateDraft(u.id, { planExpiresAt: e.target.value })}
                      />
                    </td>
                    {/* 占位文字只写「内部备注」，完整的「用户不可见」放进 title：这一列窄，长占位会被
                        截成半句，而截掉的恰好是最要紧的那半句。
                        A short placeholder; "not shown to the user" lives in the title, because the
                        truncated version cut off exactly the part that matters. */}
                    <td>
                      <input
                        type="text"
                        className="adm-input w-28"
                        placeholder={t('admin.notePlaceholder')}
                        title={t('admin.noteHint')}
                        aria-label={t('admin.colNote')}
                        value={d.planNote}
                        onChange={(e) => updateDraft(u.id, { planNote: e.target.value })}
                      />
                    </td>
                    <td className="whitespace-nowrap text-xs">
                      {u.inviteCode ? (
                        <span className="text-neutral-200" title={u.inviteCode}>{linkLabel(u.inviteCode)}</span>
                      ) : (
                        <span className="text-neutral-600">{t('admin.inviteNone')}</span>
                      )}
                      {/* 归属代理：代理本人显示「代理」标，他的位置在「代理」分区里看。
                          Owning agent; agents themselves get a tag (their place is in the Agents section). */}
                      <div className="mt-1 text-[11px]">
                        {u.isAgent ? (
                          <span className="rounded-full bg-prism-500/15 px-1.5 py-0.5 text-prism-200">{t('admin.agentTag')}</span>
                        ) : u.agentUserId ? (
                          <span className="text-neutral-300" title={u.agentEmail ?? undefined}>
                            {t('admin.colAgent')}: {u.agentEmail || agentLabel(u.agentUserId)}
                          </span>
                        ) : (
                          <span className="text-neutral-600">{t('admin.agentNone')}</span>
                        )}
                      </div>
                    </td>
                    {/* 最近活跃下面带 MT5 账户数：两者都是「这个人在不在用」的只读事实，各占一列太贵。
                        MT5 count under last active: both are read-only "is this person using it" facts. */}
                    <td className="whitespace-nowrap text-xs">
                      <div className="num text-neutral-300" title={fmtTime(u.lastActiveAt)}>{shortStamp(u.lastActiveAt)}</div>
                      <div className="mt-1 text-[11px] text-neutral-500">
                        {t('admin.colMt5Count')} <span className="num text-neutral-300">{u.mt5AccountCount}</span>
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1.5">
                        {dirty && (
                          <button type="button" className="adm-btn is-quiet" onClick={() => resetDraft(u)}>
                            {t('common.reset')}
                          </button>
                        )}
                        <button
                          type="button"
                          className="adm-btn is-primary"
                          disabled={!dirty || savingId === u.id}
                          onClick={() => requestSave(u)}
                        >
                          {savingId === u.id ? t('common.loading') : t('common.save')}
                        </button>
                        {/* 跳到操作日志并只看这个人 / jump to the activity log filtered to this user */}
                        <button
                          type="button"
                          className="adm-icon-btn"
                          title={t('admin.log.userRowBtnHint')}
                          aria-label={t('admin.log.userRowBtn')}
                          onClick={() => onShowLogs({ userId: u.id, userLabel: u.nickname || u.email })}
                        >
                          <IconHistory size={15} />
                        </button>
                        {/* 登录 IP 与同 IP 账户（rev 48，仅管理员可见此面板）/ login IPs, admin-only panel */}
                        <button
                          type="button"
                          className="adm-icon-btn"
                          title={t('admin.users.ip.rowBtnHint')}
                          aria-label={t('admin.users.ip.rowBtn')}
                          onClick={() => setIpSheet({ id: u.id, label: u.nickname || u.email })}
                        >
                          <IconGlobe size={15} />
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

      {/* 翻页：复用订单页在用的那套 Pager（页码从 0 起）。总数走后端返回的 total，
          所以"共 N 位用户"与页数是同一个来源。
          Paging reuses the orders page's Pager (zero-based); the page count comes from the
          backend's `total`, the same source as the "N users" caption. */}
      {totalPages > 1 && (
        <Pager
          page={page}
          totalPages={totalPages}
          total={total}
          loading={loading}
          onPrev={() => goToPage(page - 1)}
          onNext={() => goToPage(page + 1)}
        />
      )}
      {/* 操作坞出现时给表格底下留出位置，最后一行不会被它盖住 / room under the table so the dock never covers the last row */}
      {selectedIds.size > 0 && <div aria-hidden="true" className="h-24" />}

      {/* 批量操作坞：勾选至少一位用户后浮在页面底部，滚到哪儿都够得着。
          Bulk dock: floats at the bottom once ≥1 user is ticked, reachable wherever you scroll. */}
      {selectedIds.size > 0 &&
        createPortal(
          <div data-fd-plain className="adm-dock-layer">
            <div className="adm-dock" role="region" aria-label={t('admin.bulkSelected', { n: selectedIds.size })}>
              <div className="adm-dock-count">
                {t('admin.console.selectedPre') && <span>{t('admin.console.selectedPre')}</span>}
                <span className="num">{selectedIds.size}</span>
                <span>{t('admin.console.selectedPost')}</span>
              </div>
              <span className="adm-dock-sep" aria-hidden="true" />
              <div className="adm-dock-fields">
                <div className="adm-filter">
                  <span>{t('admin.colRole')}</span>
                  <Select
                    value={bulkRole}
                    onChange={setBulkRole}
                    openUpward
                    ariaLabel={t('admin.colRole')}
                    options={[{ value: '', label: t('admin.bulkNoChange') }, ...ROLE_OPTIONS.map((r) => ({ value: r, label: t(`admin.support.role.${r}`) }))]}
                  />
                </div>
                <div className="adm-filter">
                  <span>{t('admin.colPlan')}</span>
                  <Select
                    value={bulkPlan}
                    onChange={setBulkPlan}
                    openUpward
                    ariaLabel={t('admin.colPlan')}
                    options={[{ value: '', label: t('admin.bulkNoChange') }, ...PLAN_OPTIONS.map((p) => ({ value: p, label: p }))]}
                  />
                </div>
                <label className="adm-filter cursor-pointer">
                  <input
                    type="checkbox"
                    checked={bulkSetExpiry}
                    onChange={(e) => setBulkSetExpiry(e.target.checked)}
                    className="adm-check"
                  />
                  <span>{t('admin.colExpiresAt')}</span>
                </label>
                {bulkSetExpiry && (
                  <input
                    type="date"
                    className="adm-input w-[140px]"
                    aria-label={t('admin.colExpiresAt')}
                    value={bulkExpiry}
                    onChange={(e) => setBulkExpiry(e.target.value)}
                  />
                )}
                {/* 停用的链接照样列出来：归因是历史事实，把人补挂到一条已下线的合作链接下是正当
                    操作（那条链接的数据还要继续看）。已删除的不给。
                    Retired links stay listed: backfilling onto a link no longer handed out is
                    legitimate. Deleted links are not offered. */}
                <div className="adm-filter">
                  <span>{t('admin.colInvite')}</span>
                  <Select
                    value={bulkInvite}
                    onChange={setBulkInvite}
                    openUpward
                    ariaLabel={t('admin.colInvite')}
                    options={[
                      { value: '', label: t('admin.bulkNoChange') },
                      { value: BULK_CLEAR_INVITE, label: t('admin.inviteClear') },
                      ...attributionOptions(inviteLinks, '', false),
                    ]}
                  />
                </div>
                <div className="adm-filter">
                  <span>{t('admin.colAgent')}</span>
                  <Select
                    value={bulkAgent}
                    onChange={setBulkAgent}
                    openUpward
                    ariaLabel={t('admin.colAgent')}
                    options={[
                      { value: '', label: t('admin.bulkNoChange') },
                      { value: BULK_CLEAR_INVITE, label: t('admin.agentClear') },
                      ...agentOptions,
                    ]}
                  />
                </div>
              </div>
              <div className="adm-dock-actions">
                <button
                  type="button"
                  className="adm-btn is-primary"
                  disabled={!bulkHasChange || bulkSaving}
                  onClick={() => setBulkConfirm(true)}
                >
                  {bulkSaving ? t('common.loading') : t('admin.bulkApply')}
                </button>
                <button type="button" className="adm-btn" onClick={() => onEmailUsers(Array.from(selectedIds))}>
                  {t('admin.bulkEmail')}
                </button>
                <button type="button" className="adm-btn" onClick={() => onAssignUsers(Array.from(selectedIds))}>
                  {t('admin.support.bulkAssign')}
                </button>
                <button type="button" className="adm-icon-btn" onClick={clearBulk} title={t('admin.bulkClear')} aria-label={t('admin.bulkClear')}>
                  <IconClose />
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* 批量修改的二次确认。文案里把受影响人数与每一条具体改动都列出来——「确定吗？」式的空
          确认框只会被训练成条件反射，真正拦住误操作的是让人在按下去之前读到「12 位用户 · 角色 → admin」。
          Bulk-edit confirmation spelling out the count and every change: a content-free "are you
          sure?" trains reflexive clicking, reading "12 users · role → admin" stops the mistake. */}
      {bulkConfirm && (() => {
        const { changes } = bulkPayload()
        const promoting = bulkRole === 'admin'
        // 改归属代理 = 把这些人的邮箱交给那个代理及其上级（/agent 的名单页返回邮箱）。这是本操作
        // 唯一对外可见、且撤不回来的后果——撤销只能停止继续显示，看过的人已经看过了。rev 50 起改来源
        // （归因链接）不再动归属，所以这条提醒只跟着归属走。
        // Re-owning hands these people's emails to that agent and their uplines (/agent lists
        // them) — the one outward-visible, unrecallable consequence. Since rev 50 the source
        // link no longer decides ownership, so the warning follows the owner only.
        const assigningAgent = !!bulkAgent && bulkAgent !== BULK_CLEAR_INVITE
        return (
          <ConfirmModal
            center
            danger
            busy={bulkSaving}
            title={t('admin.bulkConfirmTitle')}
            message={
              t('admin.bulkConfirmBody', { n: selectedIds.size, changes: changes.join(' · ') }) +
              // 拼成一段：ConfirmModal 的 message 渲染在普通 <p> 里，不保留换行符。
              // One paragraph: ConfirmModal renders `message` in a plain <p> that collapses newlines.
              (promoting ? ' ' + t('admin.bulkConfirmAdminWarn') : '') +
              (assigningAgent ? ' ' + t('admin.bulkConfirmInviteWarn', { agent: agentLabel(bulkAgent) }) : '')
            }
            confirmLabel={t('admin.bulkApply')}
            onConfirm={() => void applyBulk()}
            onCancel={() => setBulkConfirm(false)}
          />
        )
      })()}

      {/* 单条提权的确认（user → admin）/ single-row promotion confirmation */}
      {promoteTarget && (
        <ConfirmModal
          center
          danger
          busy={savingId === promoteTarget.id}
          title={t('admin.promoteTitle')}
          message={t('admin.promoteBody', { email: promoteTarget.email })}
          onConfirm={() => void save(promoteTarget)}
          onCancel={() => setPromoteTarget(null)}
        />
      )}

      {/* 停用的确认（带原因输入）/ disable confirmation, with the reason field */}
      {disableTarget && (
        <DisableUserModal
          email={disableTarget.email}
          busy={statusSavingId === disableTarget.id}
          onConfirm={(reason) => void applyDisabled(disableTarget, reason)}
          onCancel={() => setDisableTarget(null)}
        />
      )}

      {verifyTarget && (
        <ConfirmModal
          center
          busy={verifySavingId === verifyTarget.id}
          title={t('admin.verifyEmailTitle')}
          message={t('admin.verifyEmailBody', { email: verifyTarget.email })}
          confirmLabel={t('admin.verifyEmailConfirm')}
          onConfirm={() => void applyVerified(verifyTarget)}
          onCancel={() => setVerifyTarget(null)}
        />
      )}

      {/* 恢复的确认。普通 ConfirmModal、不标 danger——恢复是把权限还回去，不是破坏性操作；文案里
          带上当初停用的原因，省得管理员去别处翻"当时为什么停的"就直接放行。
          Restore confirmation: not danger — handing access back is not destructive. The copy
          carries the original reason so nobody restores without seeing why it was disabled. */}
      {enableTarget && (
        <ConfirmModal
          center
          busy={statusSavingId === enableTarget.id}
          title={t('admin.enableTitle')}
          message={
            t('admin.enableBody', { email: enableTarget.email }) +
            (enableTarget.disabledReason ? ' ' + t('admin.enableOldReason', { reason: enableTarget.disabledReason }) : '')
          }
          confirmLabel={t('admin.enableConfirm')}
          onConfirm={() => void applyDisabled(enableTarget, null)}
          onCancel={() => setEnableTarget(null)}
        />
      )}
      {ipSheet && (
        <UserIpSheet
          key={ipSheet.id}
          userId={ipSheet.id}
          userLabel={ipSheet.label}
          onClose={() => setIpSheet(null)}
          onPickUser={(email) => {
            // 搜索靠提交触发：关侧栏后把邮箱填进搜索框并直接查一次（新值走 opts）。
            // Search is submit-driven: close the sheet, fill the box and load once (value via opts).
            setIpSheet(null)
            setQuery(email)
            setSelectedIds(new Set())
            void load({ q: email, page: 0 })
          }}
        />
      )}
    </div>
  )
}
