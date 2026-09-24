// 管理后台页：运营指标 + 用户列表（可调整角色/订阅等级，支持批量修改）
// Admin page: operating metrics + user list (role/plan adjustable, bulk edit supported)
import { useEffect, useRef, useState, type FormEvent } from 'react'
import PageHead from '../components/PageHead'
import { useTranslation } from 'react-i18next'
import Switch from '../components/Switch'
import { useToast } from '../utils/useToast'
import { Link, useSearchParams } from 'react-router-dom'
import { adminApi, isAbortError } from '../api/client'
import { fmtDate, fmtDay, fmtTime, localizeApiError } from '../api/utils'
import Select from '../components/Select'
import ConfirmModal from '../components/ConfirmModal'
import OpsSettingsPanel from '../components/admin/OpsSettingsPanel'
import SystemSettingsPanel from '../components/admin/SystemSettingsPanel'
import DisableUserModal from '../components/admin/DisableUserModal'
import { isUserDisabled } from '../components/admin/userStatus'
import Pager from '../components/Pager'
import { SkeletonLine } from '../components/Skeleton'
import OverviewPanel from '../components/admin/overview/OverviewPanel'
import PlatformStrategiesPanel from '../components/admin/PlatformStrategiesPanel'
import AnnouncementsPanel from '../components/admin/AnnouncementsPanel'
import InviteLinksPanel from '../components/admin/InviteLinksPanel'
import StrategyWinratePanel from '../components/admin/StrategyWinratePanel'
import GamificationPanel from '../components/admin/GamificationPanel'
import CompetitionsPanel from '../components/admin/CompetitionsPanel'
import type { AdminUser, InviteLink, UserPlan, UserRole, Ticket, TicketCategory, TicketListItem, TicketPriority, TicketStatus } from '../api/types'

const PLAN_OPTIONS: UserPlan[] = ['FREE', 'PRO']
const ROLE_OPTIONS: UserRole[] = ['user', 'admin']

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
// 三档都在其内。
// 默认从 50 改成 20（2026-09-22）：这张表一行有七八个控件、一屏放不下 50 行，翻到
// 底的代价比翻页高；而「全选」勾的是**当前这一页**，一页 50 条时那一勾覆盖的人远
// 多于屏幕上看得见的，正是批量操作最容易估错人数的地方（见 handleSearch 的注释）。
// 此前这里写死 limit: 100 且没有任何翻页控件：第 101 位之后的用户在后台只能靠搜索
// 关键字撞，无法浏览；「全选」也只覆盖那 100 条，却看不出来。
// Rows per page, chosen by the admin; 20 by default. The backend caps `limit` at
// PAGE_SIZE_MAX=200, so all three fit.
// The default dropped from 50 to 20 (2026-09-22): a row here carries seven or
// eight controls, 50 of them never fit on a screen, and "select all" ticks the
// current page — at 50 that covers far more people than are visible, which is
// exactly how a bulk edit's count gets misjudged (see handleSearch's comment).
// It used to be a hard-coded limit: 100 with no pager at all — user 101 onwards
// was unreachable except by guessing a search term, and "select all" silently
// covered only those first 100.
const PAGE_SIZE_OPTIONS = [10, 20, 50]
const DEFAULT_PAGE_SIZE = 20

// 后台分为四类，与订单页的 Tab 模式一致：
// data   看数据（指标、页面访问统计）
// users  管人（搜索、批量、用户表）
// ops    改运营策略（定价、试用、券商锁）——影响用户看到什么、付多少钱
// system 调系统参数（纪律分算法、K 线保留、策略平台上限）——影响后台怎么算
// ops 与 system 的界线是"改了之后谁受影响"：ops 直接改变商业条款，system 改变
// 计算与存储行为。混在一起就是原来那个 7 组配置堆在一页、找不到东西的样子。
// 两段的表单与读写各自住在 components/admin/OpsSettingsPanel.tsx 与
// SystemSettingsPanel.tsx——与其余页签一样自成 Panel；本文件只剩页签路由和用户表。
// Four sections, mirroring the Orders page tab pattern. The ops/system split is
// by blast radius: ops changes commercial terms users see and pay, system
// changes how the backend computes and stores. Lumping them together is what
// made the original single page an unnavigable pile of seven config groups.
// guide 归入 ops 一侧的判断：策略介绍是对外文案，改了直接影响用户看到什么，
// 与 system 的"改后台怎么算"无关；但它是内容编辑而非配置项，表单形态差别太大，
// 所以单开一个页签而不是塞进 ops。
// Why `guide` is its own tab: strategy write-ups are user-facing copy, so by
// blast radius they belong on the ops side, not system ("how the backend
// computes"). But they are content editing rather than config, and the form
// shape differs too much to fold into ops.
// winrate 紧跟 data：两者都是"看数据"，但分策略 × 分时段的胜率矩阵有自己的
// 窗口选择和一整张宽表，塞进 data 页会把运营指标和页面访问统计挤到看不见。
// winrate sits right after data: both are "look at numbers", but the
// strategy x session matrix has its own range picker and a wide table, and
// folding it into data would bury the operating metrics and page stats.
type AdminTab = 'data' | 'winrate' | 'users' | 'invites' | 'ops' | 'system' | 'guide' | 'announcements' | 'tickets' | 'gamification' | 'competitions'
const ADMIN_TABS: AdminTab[] = ['data', 'winrate', 'users', 'invites', 'ops', 'system', 'guide', 'announcements', 'tickets', 'gamification', 'competitions']

interface Draft {
  role: UserRole
  plan: UserPlan
  planExpiresAt: string // yyyy-mm-dd，空字符串表示永不到期 / empty string = never expires
  planNote: string
}

function toDraft(u: AdminUser): Draft {
  return {
    role: u.role,
    plan: u.plan,
    planExpiresAt: u.planExpiresAt ? u.planExpiresAt.slice(0, 10) : '',
    planNote: u.planNote ?? '',
  }
}

function isDirty(u: AdminUser, d: Draft | undefined): boolean {
  if (!d) return false
  const origExpiry = u.planExpiresAt ? u.planExpiresAt.slice(0, 10) : ''
  return d.role !== u.role || d.plan !== u.plan || d.planExpiresAt !== origExpiry || d.planNote !== (u.planNote ?? '')
}

// ---- 工单管理面板 / Ticket Management Panel ----

function AdminTicketsPanel() {
  const { t } = useTranslation()
  const [tickets, setTickets] = useState<TicketListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [detail, setDetail] = useState<Ticket | null>(null)
  const [replyText, setReplyText] = useState('')
  const [replyStatus, setReplyStatus] = useState<TicketStatus | ''>('')
  const [replyPriority, setReplyPriority] = useState<TicketPriority | ''>('')
  const [sending, setSending] = useState(false)
  const { toast, showToast } = useToast()

  // 每次加载中止上一次：两个筛选下拉是最容易连点的地方，先发的响应后到就会把
  // 当前筛选的结果覆盖掉，表格与筛选条对不上且没有任何提示。中止之后 fetch 会以
  // AbortError 拒绝，用 isAbortError 认出来直接忽略——那不是故障，是我们自己取消的。
  // 组件卸载时也中止，顺带解决卸载后 setState 的告警。
  // Every load aborts the previous one: the two filter selects are the easiest
  // thing to click through quickly, and an earlier response landing last
  // overwrites the current filter's results with no sign that it happened. After
  // an abort fetch rejects with AbortError, which isAbortError recognises and
  // drops — that is not a failure, it is our own cancellation. The same
  // controller aborts on unmount, which also removes the setState-after-unmount
  // warning.
  const loadCtrl = useRef<AbortController | null>(null)

  const load = async () => {
    loadCtrl.current?.abort()
    const ctrl = new AbortController()
    loadCtrl.current = ctrl
    setLoading(true)
    try {
      const rows = await adminApi.listTickets({
        status: statusFilter || undefined,
        category: categoryFilter || undefined,
      }, ctrl.signal)
      setTickets(rows)
    } catch (err) {
      if (isAbortError(err)) return
      showToast('err', err instanceof Error ? err.message : 'Load failed')
    } finally {
      // 只有仍是最新那一次才收起加载态：被中止的那次在这里把 loading 关掉，
      // 会让接替它的请求在途中却显示成「加载完了、但表是空的」。
      // Only the still-current request clears the loading flag: letting an
      // aborted one do it would show "loaded, but empty" while its replacement
      // is still in flight.
      if (loadCtrl.current === ctrl) setLoading(false)
    }
  }

  useEffect(() => { load() }, [statusFilter, categoryFilter])
  useEffect(() => () => loadCtrl.current?.abort(), [])

  // 通知里的深链：?ticket=<id> 直接打开那条工单（新工单通知会带上）。参数打开后
  // 就抹掉，避免在页内退回列表后一刷新又被弹回详情；页签参数由 AdminPage 自己
  // 消费，这里只动 ticket 这一个键。
  // Deep link from a notification: ?ticket=<id> opens that thread (the new-ticket
  // notification carries one). The param is cleared once used, so backing out to
  // the list and refreshing doesn't bounce back into the detail. The tab param is
  // consumed by AdminPage itself; only the ticket key is touched here.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const id = searchParams.get('ticket')
    if (!id) return
    const next = new URLSearchParams(searchParams)
    next.delete('ticket')
    setSearchParams(next, { replace: true })
    adminApi.getTicket(id).then(setDetail).catch(() => {})
  }, [])

  const openDetail = async (id: string) => {
    try {
      setDetail(await adminApi.getTicket(id))
      setReplyText('')
      setReplyStatus('')
      setReplyPriority('')
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Load failed')
    }
  }

  const sendReply = async () => {
    if (!replyText.trim() || !detail) return
    setSending(true)
    try {
      const updated = await adminApi.replyTicket(detail.id, replyText.trim(), {
        ...(replyStatus ? { status: replyStatus as TicketStatus } : {}),
        ...(replyPriority ? { priority: replyPriority as TicketPriority } : {}),
      })
      setDetail(updated)
      setReplyText('')
      setReplyStatus('')
      setReplyPriority('')
      showToast('ok', t('tickets.admin.replySent'))
      load()
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSending(false)
    }
  }

  const updateMeta = async (patch: { status?: TicketStatus; priority?: TicketPriority }) => {
    if (!detail) return
    try {
      setDetail(await adminApi.updateTicket(detail.id, patch))
      showToast('ok', t('tickets.admin.statusUpdated'))
      load()
    } catch (err) {
      showToast('err', err instanceof Error ? err.message : 'Save failed')
    }
  }

  const statusClass: Record<string, string> = {
    open: 'bg-amber-400/15 text-amber-300',
    in_progress: 'bg-blue-400/15 text-blue-300',
    closed: 'bg-neutral-500/15 text-neutral-400',
  }
  const priorityClass: Record<string, string> = {
    low: 'bg-neutral-500/15 text-neutral-400',
    normal: 'bg-blue-400/15 text-blue-300',
    urgent: 'bg-down/15 text-down',
  }

  return (
    <div>
      {toast && (
        <div className={`mb-4 rounded-lg border px-4 py-2.5 text-sm ${
          toast.kind === 'err' ? 'border-down/40 bg-down/15 text-down' : 'border-up/40 bg-up/15 text-up'
        }`}>
          {toast.text}
        </div>
      )}

      {detail ? (
        <div>
          <button onClick={() => setDetail(null)} className="btn-ghost mb-4 px-3 py-1.5 text-sm">
            &larr; {t('tickets.backToList')}
          </button>
          <div className="glass mb-4 p-5">
            <h2 className="font-display text-lg font-bold text-neutral-100 mb-3">{detail.title}</h2>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className={`tag ${statusClass[detail.status]}`}>{t(`tickets.status.${detail.status}`)}</span>
              <span className={`tag ${priorityClass[detail.priority]}`}>{t(`tickets.priority.${detail.priority}`)}</span>
              <span className="tag bg-white/5 text-neutral-400">{t(`tickets.category.${detail.category}`)}</span>
              <span className="ml-auto text-xs text-neutral-500">{detail.userEmail}</span>
            </div>
            <div className="flex gap-2 mt-3">
              {(['open', 'in_progress', 'closed'] as TicketStatus[]).map((s) => (
                <button key={s} onClick={() => updateMeta({ status: s })}
                  className={`rounded-lg px-3 py-1 text-xs transition ${
                    detail.status === s ? 'bg-prism-600/20 text-prism-200' : 'bg-white/5 text-neutral-500 hover:bg-white/10'
                  }`}>
                  {t(`tickets.status.${s}`)}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-4">
            {detail.replies.map((r) => (
              <div key={r.id} className={`flex ${r.authorRole === 'admin' ? 'justify-start' : 'justify-end'} mb-3`}>
                <div className={`max-w-[80%] rounded-xl px-4 py-3 ${r.authorRole === 'admin' ? 'bg-prism-600/10' : 'bg-white/5'}`}>
                  <div className="mb-1 flex items-center gap-2 text-[11px] text-neutral-500">
                    <span className="font-medium text-neutral-300">{r.authorEmail}</span>
                    {r.authorRole === 'admin' && <span className="rounded bg-prism-600/20 px-1.5 py-0.5 text-[10px] text-prism-300">{t('admin.staff')}</span>}
                    {/* 统一走 api/utils 的格式化：裸 toLocaleString 既不补 Z、也按
                        浏览器本地时区渲染，欧美时区的管理员看到的时刻整段偏移，
                        而且没有任何后缀说明这是哪个时区（见 api/utils 的头注）。
                        Formatted through api/utils: a bare toLocaleString neither
                        appends Z nor pins the zone, so an admin outside UTC+8 sees
                        shifted times with nothing saying which zone they are in
                        (see api/utils' header). */}
                    <span>{fmtDate(r.createdAt)}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm text-neutral-200">{r.body}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="glass p-4 space-y-3">
            <div className="flex gap-3">
              <select className="input w-auto py-1 text-xs" value={replyStatus}
                onChange={(e) => setReplyStatus(e.target.value as TicketStatus | '')}>
                <option value="">{t('common.noChange')}</option>
                {(['open', 'in_progress', 'closed'] as TicketStatus[]).map((s) => (
                  <option key={s} value={s}>{t(`tickets.status.${s}`)}</option>
                ))}
              </select>
              <select className="input w-auto py-1 text-xs" value={replyPriority}
                onChange={(e) => setReplyPriority(e.target.value as TicketPriority | '')}>
                <option value="">{t('common.noChange')}</option>
                {(['low', 'normal', 'urgent'] as TicketPriority[]).map((p) => (
                  <option key={p} value={p}>{t(`tickets.priority.${p}`)}</option>
                ))}
              </select>
            </div>
            <textarea className="input min-h-[80px] w-full resize-y" value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              placeholder={t('tickets.replyPlaceholder')} maxLength={5000} />
            <button onClick={sendReply}
              className="btn-primary px-5 py-2 text-sm disabled:opacity-40" disabled={sending || !replyText.trim()}>
              {sending ? '...' : t('tickets.reply')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="glass mb-4 flex flex-wrap items-center gap-3 p-4">
            <select className="input w-auto py-1 text-sm" value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="">{t('tickets.admin.all')}</option>
              {(['open', 'in_progress', 'closed'] as TicketStatus[]).map((s) => (
                <option key={s} value={s}>{t(`tickets.status.${s}`)}</option>
              ))}
            </select>
            <select className="input w-auto py-1 text-sm" value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="">{t('tickets.admin.all')}</option>
              {(['account', 'payment', 'technical', 'feature'] as TicketCategory[]).map((c) => (
                <option key={c} value={c}>{t(`tickets.category.${c}`)}</option>
              ))}
            </select>
          </div>

          <div className="glass overflow-x-auto p-0">
            {loading ? (
              <div className="flex flex-col gap-3 p-5">
                <SkeletonLine width="60%" height={14} />
                <SkeletonLine />
                <SkeletonLine width="75%" />
              </div>
            ) : tickets.length === 0 ? (
              <div className="p-8 text-center text-sm text-neutral-500">{t('tickets.empty')}</div>
            ) : (
              <table className="w-full min-w-[700px] text-left text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-neutral-500">
                    <th className="px-4 py-3 font-medium">{t('tickets.admin.colTitle')}</th>
                    <th className="px-4 py-3 font-medium">{t('tickets.admin.colUser')}</th>
                    <th className="px-4 py-3 font-medium">{t('tickets.admin.colCategory')}</th>
                    <th className="px-4 py-3 font-medium">{t('tickets.admin.colPriority')}</th>
                    <th className="px-4 py-3 font-medium">{t('tickets.admin.colStatus')}</th>
                    <th className="px-4 py-3 font-medium">{t('tickets.admin.colUpdated')}</th>
                  </tr>
                </thead>
                <tbody>
                  {tickets.map((ticket) => (
                    <tr key={ticket.id} onClick={() => openDetail(ticket.id)}
                      className="cursor-pointer border-b border-white/5 transition hover:bg-white/[0.03]">
                      <td className="px-4 py-3">
                        <div className="max-w-[220px] truncate text-neutral-200">{ticket.title}</div>
                        {ticket.latestReply && (
                          <div className="mt-0.5 max-w-[220px] truncate text-[11px] text-neutral-500">
                            {ticket.latestReply.authorEmail}: {ticket.latestReply.body}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-neutral-400">
                        {ticket.userEmail || '-'}
                      </td>
                      <td className="px-4 py-3">
                        <span className="tag bg-white/5 text-neutral-400">{t(`tickets.category.${ticket.category}`)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`tag ${priorityClass[ticket.priority]}`}>{t(`tickets.priority.${ticket.priority}`)}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`tag ${statusClass[ticket.status]}`}>{t(`tickets.status.${ticket.status}`)}</span>
                      </td>
                      {/* 同上：改走 fmtDay（固定 UTC+8）/ same as above: fmtDay pins UTC+8 */}
                      <td className="px-4 py-3 text-xs text-neutral-500">{fmtDay(ticket.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export default function AdminPage() {
  const { t } = useTranslation()
  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  // 用户表当前页（从 0 起，与 components/Pager 的约定一致）。
  // Current user-table page, zero-based to match components/Pager's contract.
  const [page, setPage] = useState(0)
  // 当前分类页签。初值读 ?tab=——站内通知要能一步落到工单页签上，而页签本身
  // 是状态不是路由，所以只在首次挂载时取一次；之后点页签不写回地址栏（那会给
  // 每次切页签留一条历史记录，划返回变成在页签之间来回走）。
  // Active section tab. The initial value comes from ?tab= so a notification can
  // land straight on the tickets tab; tabs are state rather than routes, so it is
  // read once on mount and never written back — writing it would add a history
  // entry per tab click and turn "back" into tab-hopping.
  const [searchParams] = useSearchParams()
  const [tab, setTab] = useState<AdminTab>(() => {
    const wanted = searchParams.get('tab')
    return (ADMIN_TABS as string[]).includes(wanted ?? '') ? (wanted as AdminTab) : 'data'
  })
  const [loading, setLoading] = useState(true)
  const [query, setQuery] = useState('')
  const [planFilter, setPlanFilter] = useState('')
  // 按注册归因筛选：'' = 全部，NO_INVITE = 只看没有归因的人，其余是某条链接的 code。
  // Filter by attribution: '' all, NO_INVITE only unattributed, otherwise a link's code.
  const [inviteFilter, setInviteFilter] = useState('')
  // 邀请链接表：既给筛选器和批量指派当选项，也负责把用户行上的 code 映射成人
  // 看得懂的备注名。归因列显示的是备注，不是那串随机码。
  // The invite links: options for the filter and the bulk assign box, and the
  // code → label map for the attribution column. Nobody can read the raw code.
  const [inviteLinks, setInviteLinks] = useState<InviteLink[]>([])
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const { toast, showToast } = useToast()

  // 邀请页签的「送试用」列要判断"全局试用现在到底是不是开着"。试用表单本身住在运营
  // 设置页签（OpsSettingsPanel）里且是草稿，保存成功后经 onTrialSaved 回传到这里；首屏
  // 在 load() 里和用户表一起读一次已保存值。传给 InviteLinksPanel 的必须是这个已保存
  // 值，不能是草稿——草稿被改过、还没保存时会给出错误答案（勾了没存 → 列会显示送
  // 试用可用，实际发不出去；反之亦然）。
  // The invites tab needs "is the global trial actually on right now". The trial form
  // lives on the ops tab (OpsSettingsPanel) and is a draft; a successful save reports
  // back via onTrialSaved, and load() reads the persisted value once alongside the user
  // list. InviteLinksPanel must get this persisted value, never the draft — an edited
  // but unsaved draft gives the wrong answer in both directions.
  const [savedTrialEnabled, setSavedTrialEnabled] = useState(false)

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
  const [bulkSaving, setBulkSaving] = useState(false)
  const headerCheckboxRef = useRef<HTMLInputElement>(null)

  // 与工单面板同款的竞态守卫：搜索连点、快速翻页时，先发的响应后到会覆盖后发的
  // 结果——表格显示的是上一次查询，而搜索框、筛选器和页码显示的是这一次。
  // Same race guard as the tickets panel: with rapid searches or page flips an
  // earlier response can land last, leaving the table showing the previous query
  // while the search box, filter and page number describe the current one.
  // 卸载时中止并置空：置空之后下面那句 `loadCtrl.current !== ctrl` 的守卫同时
  // 兼任"组件已经没了，别再 setState"。/ Abort and null on unmount: nulling makes
  // the `loadCtrl.current !== ctrl` guard below double as "we're gone, don't setState".
  const loadCtrl = useRef<AbortController | null>(null)
  useEffect(() => () => {
    loadCtrl.current?.abort()
    loadCtrl.current = null
  }, [])

  const load = async (opts: { q?: string; plan?: string; invite?: string; size?: number; page?: number } = {}) => {
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
      // 用户表与「全局试用是否开着」一起读；后者只给邀请页签用（见 savedTrialEnabled）。
      // 七组设置的读写已搬进 OpsSettingsPanel / SystemSettingsPanel，在各自面板里各自成败。
      // 两个请求各自 settle：一个失败另一个照常显示，只提示"N 项没加载出来"。
      // The user list plus "is the global trial on" (invites tab only; see
      // savedTrialEnabled). The seven settings sections now load inside
      // OpsSettingsPanel / SystemSettingsPanel and fail independently there. The two
      // calls settle separately so one failure never hides the other's data.
      const results = await Promise.allSettled([
        adminApi.listUsers(
          {
            q: (opts.q ?? query) || undefined,
            plan: (opts.plan ?? planFilter) || undefined,
            inviteCode: (opts.invite ?? inviteFilter) || undefined,
            limit: wantedSize,
            offset: wantedPage * wantedSize,
          },
          ctrl.signal,
        ),
        adminApi.getTrial(),
        // 链接表给归因列/筛选器/批量指派用。拉不到会进那句"N 项没加载出来"的
        // 提示，但界面照常可用：归因列退化成显示原始 code（仍然看得出谁挂在哪，
        // 只是不好读），两个下拉只剩固定选项。allSettled 保证它挂掉不连累用户表。
        // The link list feeds the attribution column, the filter and the bulk
        // assign box. A failure is not fatal: the column falls back to the raw
        // code — still correct, just unreadable — and the two dropdowns are left
        // with their fixed options. allSettled keeps it from taking the table down.
        adminApi.listInviteLinks(),
      ])
      // 这一批已经被后来的一次 load 取代：getTrial 没有 signal、照样会成功返回，若继续
      // 往下走就会用上一次的数据把新的一次盖掉——正是这里要防的那件事。
      // Superseded by a later load: getTrial carries no signal and still resolves, so
      // falling through would overwrite the newer load's data with this one's.
      if (loadCtrl.current !== ctrl) return
      const [usersRes, trialRes, linksRes] = results
      setPage(wantedPage)
      setPageSize(wantedSize)
      if (usersRes.status === 'fulfilled') {
        setUsers(usersRes.value.users)
        setTotal(usersRes.value.total)
        setDrafts(Object.fromEntries(usersRes.value.users.map((u) => [u.id, toDraft(u)])))
      }
      if (trialRes.status === 'fulfilled') setSavedTrialEnabled(trialRes.value.trialEnabled)
      if (linksRes.status === 'fulfilled') setInviteLinks(linksRes.value.links)
      const firstErr = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
      if (firstErr) {
        const failed = results.filter((r) => r.status === 'rejected').length
        const reason = firstErr.reason
        const detail = reason instanceof Error ? localizeApiError(reason.message) : ''
        // 分隔符用破折号而不是全角「：」：中式标点在英文界面下会渲染成「... loaded：detail」。
        // An em dash rather than a fullwidth colon, which reads wrong on the English UI.
        showToast('err', t('admin.loadPartialError', { n: failed, total: results.length }) + (detail ? ` — ${detail}` : ''))
      }
    } finally {
      if (loadCtrl.current === ctrl) setLoading(false)
    }
  }

  useEffect(() => {
    load()
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
    load({ page: 0 })
  }

  // 归因筛选改一下就立刻查，不用再点一次「搜索」：它是个下拉，选完就是明确的
  // 意图，而下拉改了表格不动会让人以为没生效。新值走 opts 传进去——setState
  // 是异步的，load() 里读到的还会是旧值。
  // The attribution filter queries on change instead of waiting for the search
  // button: picking from a dropdown is already an unambiguous intent, and a
  // table that doesn't move reads as broken. The new value goes through opts
  // because setState is async and load() would otherwise read the old one.
  const changeInviteFilter = (value: string) => {
    setInviteFilter(value)
    setSelectedIds(new Set())
    load({ invite: value, page: 0 })
  }

  // 改每页条数：回第一页并清空勾选，理由同搜索与翻页（勾的必须是看得见的）。
  // Changing the page size returns to page one and clears the selection, for the
  // same reason searching and paging do: what is ticked must be what is visible.
  const changePageSize = (value: string) => {
    const next = Number(value)
    setSelectedIds(new Set())
    load({ size: next, page: 0 })
  }

  // code → 链接备注。链接拉不到、或者用户挂着一条已被删掉的码时退回显示码本身，
  // 绝不显示空白——空白会被读成"没有归因"，而那是另一回事。
  // code → label, falling back to the code itself when the link list is missing
  // or the code is unknown. Never blank: blank reads as "no attribution", which
  // is a different fact.
  const linkLabel = (code: string) => inviteLinks.find((l) => l.code === code)?.label || code

  const goToPage = (next: number) => {
    setSelectedIds(new Set())
    load({ page: next })
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
    const payload: Partial<{ role: UserRole; plan: UserPlan; planExpiresAt: string | null; inviteCode: string | null }> = {}
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
    return { payload, changes }
  }

  // 二次确认：一次点击原本就能把最多一整页的账号 role 批量改成 admin，或者把
  // 套餐整批降级 / 清掉到期日——没有确认、没有撤销、后端也没有降权审计。同一份
  // 代码库里危险操作一律走 ConfirmModal（公告、比赛、游戏化、邀请链接、代理端
  // 的会员调整都有），唯独权限最大的这一处没有。
  // Second confirmation: one click could bulk-set up to a whole page of accounts
  // to role=admin, or downgrade plans and wipe expiry dates — with no
  // confirmation, no undo, and no demotion audit on the backend. Every other
  // dangerous action in this codebase goes through ConfirmModal (announcements,
  // competitions, gamification, invite links, the agent-side plan change); the
  // one with the largest blast radius was the exception.
  const [bulkConfirm, setBulkConfirm] = useState(false)

  const applyBulk = async () => {
    if (!bulkRole && !bulkPlan && !bulkSetExpiry && !bulkInvite) return
    setBulkConfirm(false)
    setBulkSaving(true)
    try {
      const { payload } = bulkPayload()
      const res = await adminApi.bulkUpdateUsers(Array.from(selectedIds), payload)
      showToast('ok', t('admin.bulkSaved', { n: res.updated }))
      setSelectedIds(new Set())
      setBulkRole('')
      setBulkPlan('')
      setBulkSetExpiry(false)
      setBulkExpiry('')
      setBulkInvite('')
      load()
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
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

  // 单条保存里唯一需要拦一道的是提权：user → admin 是本页最不可逆的动作（后端
  // 没有降权审计），而下拉框选错一行 + 点保存就生效。其余字段（等级、到期日、
  // 备注）改错了当场改回来即可，不值得为它们多一次点击。
  // The one single-row change worth interrupting is a promotion: user → admin is
  // the least reversible action here (the backend keeps no demotion audit) and
  // it takes one mis-picked dropdown plus Save. The other fields (plan, expiry,
  // note) can be corrected on the spot and don't deserve an extra click.
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

  // reason 为 null 表示"恢复"，非 null 表示"停用并附上这个原因"。合成一个函数
  // 是因为两条路除了调用哪个端点之外，成功/失败后的处理完全一样。
  // A null reason means restore, a non-null one means disable with that reason.
  // One function because the two paths differ only in which endpoint is called;
  // everything after the response is identical.
  const applyDisabled = async (u: AdminUser, reason: string | null) => {
    setStatusSavingId(u.id)
    try {
      const updated = reason === null ? await adminApi.enableUser(u.id) : await adminApi.disableUser(u.id, reason)
      // 后端返回整行就地替换，否则重拉——见 client.ts 里这两个端点的注释：
      // 返回体的形状还没跟后端最终确认，这里不拿它当前提。
      // Replace the row in place when the backend returns one, otherwise refetch
      // — see the comment on these two endpoints in client.ts: the response
      // shape is not finalised with the backend, so nothing here depends on it.
      if (updated?.id === u.id) {
        setUsers((prev) => prev.map((x) => (x.id === u.id ? updated : x)))
        setDrafts((prev) => ({ ...prev, [u.id]: toDraft(updated) }))
      } else {
        void load()
      }
      showToast('ok', reason === null ? t('admin.enabledOk') : t('admin.disabledOk'))
      setDisableTarget(null)
      setEnableTarget(null)
    } catch (err) {
      // 刻意不关弹窗：失败时保留已填的原因，管理员可以直接重试。
      // The dialog stays open on failure so the typed reason survives a retry.
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
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
        plan: d.plan,
        planExpiresAt: d.planExpiresAt ? new Date(`${d.planExpiresAt}T00:00:00Z`).toISOString() : null,
        planNote: d.planNote.trim() || null,
      })
      setUsers((prev) => prev.map((x) => (x.id === u.id ? updated : x)))
      setDrafts((prev) => ({ ...prev, [u.id]: toDraft(updated) }))
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingId(null)
    }
  }

  return (
    // 后台是内部工具，不加节日按钮小饰。/ admin is an internal tool: no festival button charms
    <div data-fd-plain>
      <PageHead as="h1" title={t('admin.title')} subtitle={t('admin.subtitle')} />

      {toast && (
        <div
          className={`mb-4 rounded-lg border px-4 py-2.5 text-sm ${
            toast.kind === 'err' ? 'border-down/40 bg-down/15 text-down' : 'border-up/40 bg-up/15 text-up'
          }`}
        >
          {toast.text}
        </div>
      )}

      {/* 分类页签 / section tabs */}
      <div className="mb-5 flex flex-wrap gap-2" role="tablist">
        {ADMIN_TABS.map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`rounded-xl px-4 py-2 text-sm font-medium transition ${
              tab === key
                ? 'bg-prism-600/20 text-prism-200'
                : 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
            }`}
          >
            {t(`admin.tab.${key}`)}
          </button>
        ))}
      </div>

      {tab === 'data' && <OverviewPanel />}

      {tab === 'ops' && <OpsSettingsPanel onTrialSaved={setSavedTrialEnabled} />}

      {tab === 'system' && <SystemSettingsPanel />}

      {tab === 'winrate' && <StrategyWinratePanel />}

      {tab === 'guide' && <PlatformStrategiesPanel />}

      {tab === 'announcements' && <AnnouncementsPanel />}

      {/* 传已保存值、不传 trial 表单草稿：见上面 savedTrialEnabled 的定义与注释。
          Pass the persisted value, not the trial form draft — see
          savedTrialEnabled's definition and comment above. */}
      {tab === 'invites' && <InviteLinksPanel globalTrialEnabled={savedTrialEnabled} />}

      {tab === 'tickets' && <AdminTicketsPanel />}

      {tab === 'gamification' && <GamificationPanel />}

      {tab === 'competitions' && <CompetitionsPanel />}

      {tab === 'users' && (
        <>
      {/* 搜索与筛选 / search & filter */}
      <form onSubmit={handleSearch} className="glass mb-4 flex flex-wrap items-center gap-3 p-4">
        <input
          className="input flex-1 sm:max-w-xs"
          placeholder={t('admin.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Select
          value={planFilter}
          onChange={setPlanFilter}
          options={[{ value: '', label: t('signals.all') }, ...PLAN_OPTIONS.map((p) => ({ value: p, label: p }))]}
        />
        <span className="text-xs text-neutral-500">{t('admin.colInvite')}</span>
        <Select
          value={inviteFilter}
          onChange={changeInviteFilter}
          options={[
            { value: '', label: t('signals.all') },
            { value: NO_INVITE, label: t('admin.inviteNone') },
            ...inviteLinks.map((l) => ({ value: l.code, label: l.label })),
          ]}
        />
        <button type="submit" className="btn-primary px-5 py-2 text-sm">{t('admin.search')}</button>
        {/* 每页条数挨着总数放：两者说的是同一件事（这张表现在给你看多少），
            而翻页控件在表格下方、滚到底才看得见。
            Rows-per-page sits next to the total: both answer "how much of this
            table am I being shown", while the pager is below the table and only
            visible after scrolling. */}
        <span className="ml-auto flex items-center gap-2 text-xs text-neutral-500">
          {t('admin.perPage')}
          <Select
            value={String(pageSize)}
            onChange={changePageSize}
            ariaLabel={t('admin.perPage')}
            options={PAGE_SIZE_OPTIONS.map((n) => ({ value: String(n), label: String(n) }))}
          />
          {t('admin.totalCount', { n: total })}
        </span>
      </form>

      {/* 批量操作条：勾选至少一位用户后出现 / bulk action bar, shown once ≥1 user is selected */}
      {selectedIds.size > 0 && (
        <div className="glass mb-4 flex flex-wrap items-center gap-3 border-prism-600/40 p-4">
          <span className="text-sm font-medium text-prism-200">{t('admin.bulkSelected', { n: selectedIds.size })}</span>
          <span className="text-xs text-neutral-500">{t('admin.colRole')}</span>
          <Select
            value={bulkRole}
            onChange={setBulkRole}
            openUpward
            options={[{ value: '', label: t('admin.bulkNoChange') }, ...ROLE_OPTIONS.map((r) => ({ value: r, label: r }))]}
          />
          <span className="text-xs text-neutral-500">{t('admin.colPlan')}</span>
          <Select
            value={bulkPlan}
            onChange={setBulkPlan}
            openUpward
            options={[{ value: '', label: t('admin.bulkNoChange') }, ...PLAN_OPTIONS.map((p) => ({ value: p, label: p }))]}
          />
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-neutral-500">
            <input
              type="checkbox"
              checked={bulkSetExpiry}
              onChange={(e) => setBulkSetExpiry(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-white/20 bg-white/5 accent-prism-500"
            />
            {t('admin.colExpiresAt')}
          </label>
          {bulkSetExpiry && (
            <input
              type="date"
              className="input w-auto py-1 text-xs"
              value={bulkExpiry}
              onChange={(e) => setBulkExpiry(e.target.value)}
            />
          )}
          <span className="text-xs text-neutral-500">{t('admin.colInvite')}</span>
          {/* 停用的链接照样列出来：归因是历史事实，把人补挂到一条已下线的合作
              链接下是正当操作（那条链接的数据还要继续看）。
              Retired links stay in the list: attribution is a historical fact and
              backfilling onto a link that is no longer handed out is legitimate —
              its numbers are still being read. */}
          <Select
            value={bulkInvite}
            onChange={setBulkInvite}
            openUpward
            options={[
              { value: '', label: t('admin.bulkNoChange') },
              { value: BULK_CLEAR_INVITE, label: t('admin.inviteClear') },
              ...inviteLinks.map((l) => ({ value: l.code, label: l.label })),
            ]}
          />
          <button
            className="btn-primary px-4 py-1.5 text-xs disabled:opacity-40"
            disabled={(!bulkRole && !bulkPlan && !bulkSetExpiry && !bulkInvite) || bulkSaving}
            onClick={() => setBulkConfirm(true)}
          >
            {bulkSaving ? t('common.loading') : t('admin.bulkApply')}
          </button>
          <button className="btn-ghost px-4 py-1.5 text-xs" onClick={() => setSelectedIds(new Set())}>
            {t('admin.bulkClear')}
          </button>
        </div>
      )}

      {/* 用户表 / user table */}
      <div className="glass overflow-x-auto p-0">
        {loading ? (
          <div className="flex flex-col gap-3 p-5">
            <SkeletonLine width="55%" height={14} />
            <SkeletonLine />
            <SkeletonLine width="80%" />
          </div>
        ) : users.length === 0 ? (
          <div className="p-8 text-center text-sm text-neutral-500">{t('admin.noUsers')}</div>
        ) : (
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-neutral-500">
                <th className="px-3 py-3">
                  <input
                    ref={headerCheckboxRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                    aria-label={t('admin.bulkSelectAll')}
                  />
                </th>
                {/* 邮箱格里同时放手机号与注册时间：手机号本来占一整列（列宽 100+），
                    但它不是可改的设置项，把它挤在设置之间等于用最贵的横向空间放
                    一条只读信息。搜索框本来就同时搜邮箱与手机号，两者同格也更贴近
                    管理员的心智。表头写成「邮箱 / 手机号」，免得列没了被当成不再显示。
                    The email cell carries the phone and signup time too. Phone used
                    to own a full column although it is not an editable setting —
                    the most expensive horizontal space spent on read-only text. The
                    search box already matches both, so they belong together. The
                    header says "Email / Phone" so the missing column doesn't read
                    as the field being gone. */}
                <th className="px-3 py-3 font-medium">{t('admin.colEmail')} / {t('admin.colPhone')}</th>
                {/* 状态列紧跟邮箱：停用是这张表上唯一"人还在不在"的信息，排在角色/
                    等级后面就会被一排下拉框淹没。同一格既是指示灯也是开关。
                    The status column sits right after the email: it is the only
                    "can this person still get in" fact in the table, and further
                    right it drowns among the dropdowns. One cell is both the
                    indicator and the control. */}
                <th className="px-3 py-3 font-medium">{t('admin.colStatus')}</th>
                <th className="px-3 py-3 font-medium">{t('admin.colRole')}</th>
                <th className="px-3 py-3 font-medium">{t('admin.colPlan')}</th>
                <th className="px-3 py-3 font-medium">{t('admin.colExpiresAt')}</th>
                <th className="px-3 py-3 font-medium">{t('admin.colNote')}</th>
                {/* 归因列：这个人算在哪条邀请链接名下，也就是哪个代理能看到他。
                    只读——改它走批量指派（勾一个人也走那条路），免得一张表里
                    多出第五个会写库的控件。
                    Which link this user counts towards, i.e. whose agent page
                    they appear on. Read-only; changes go through bulk assign
                    (ticking one row works), rather than adding a fifth
                    write-capable control to this table. */}
                <th className="whitespace-nowrap px-3 py-3 font-medium">{t('admin.colInvite')}</th>
                <th className="px-3 py-3 font-medium">{t('admin.colMt5Count')}</th>
                <th className="px-3 py-3 font-medium">{t('admin.colLastActive')}</th>
                <th className="px-3 py-3 font-medium">{t('admin.colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const d = drafts[u.id] ?? toDraft(u)
                const dirty = isDirty(u, d)
                const disabled = isUserDisabled(u)
                return (
                  // 停用行整行染红，压过勾选的紫底：勾选是"我正在操作它"，停用是
                  // "它现在的状态"，后者更该被一眼看见，而两种底色叠在一起谁也读不清。
                  // A disabled row is tinted red, overriding the selection tint:
                  // selection means "I'm working on it", disabled is what it *is*,
                  // and the latter deserves the glance. Stacking both reads as neither.
                  <tr
                    key={u.id}
                    className={`border-b border-white/5 align-top last:border-0 ${
                      disabled ? 'bg-down/[0.07]' : selectedIds.has(u.id) ? 'bg-prism-600/[0.06]' : ''
                    }`}
                  >
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(u.id)}
                        onChange={() => toggleSelected(u.id)}
                        className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                        aria-label={u.email}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <div className="max-w-[220px] truncate font-mono text-xs text-neutral-200">{u.email}</div>
                      {/* 手机号：存量用户为空。用「—」而不是留白，否则看起来像渲染坏了。
                          Empty for grandfathered users; an em dash rather than blank
                          space, which would read as a rendering bug. */}
                      <div className="mt-1 whitespace-nowrap font-mono text-[11px] text-neutral-400">
                        {u.phone || <span className="text-neutral-600">—</span>}
                      </div>
                      <div className="mt-0.5 text-[11px] text-neutral-500">{fmtTime(u.createdAt)}</div>
                    </td>
                    {/* 状态：开关走全站唯一的 Switch（见 components/Switch.tsx 与
                        设计约定），checked = 账号可用。它不是即时开关——两个方向都
                        先开确认框，状态只在后端确认之后才翻，所以按下去到翻过来
                        之间开关保持原样并转圈（busy）。
                        Status: the toggle is the site's one Switch component (see
                        components/Switch.tsx and the UI conventions), checked =
                        the account works. It is not an instant toggle — both
                        directions open a confirmation first and the state flips
                        only after the backend agrees, so between press and flip it
                        stays put and spins (busy). */}
                    <td className="px-3 py-3">
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
                      {/* 停用时间与原因跟在开关下面：没有它们，一行"已停用"只回答
                          了"是不是"，回答不了客服真正会被问到的"什么时候、为什么"。
                          原因可能很长，截断显示并把全文放进 title。
                          Time and reason sit under the toggle: without them a bare
                          "disabled" answers only whether, not the when and why
                          support will actually be asked. The reason can run long,
                          so it is clamped with the full text in the title. */}
                      {disabled && (
                        <div className="mt-1.5 max-w-[200px] space-y-0.5">
                          <div className="text-[11px] text-neutral-500">{fmtTime(u.disabledAt)}</div>
                          {u.disabledReason && (
                            <div className="truncate text-[11px] text-neutral-400" title={u.disabledReason}>
                              {u.disabledReason}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3">
                      <Select
                        value={d.role}
                        onChange={(v) => updateDraft(u.id, { role: v as UserRole })}
                        className="select-tight"
                        options={ROLE_OPTIONS.map((r) => ({ value: r, label: r }))}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <Select
                        value={d.plan}
                        onChange={(v) => updateDraft(u.id, { plan: v as UserPlan })}
                        className="select-tight"
                        options={PLAN_OPTIONS.map((p) => ({ value: p, label: p }))}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <input
                        type="date"
                        className="input w-[132px] py-1 text-xs"
                        value={d.planExpiresAt}
                        onChange={(e) => updateDraft(u.id, { planExpiresAt: e.target.value })}
                      />
                    </td>
                    {/* 占位文字只写「内部备注」，完整的「用户不可见」放进 title：
                        这一列收窄之后长占位会被截成半句，而截掉的恰好是最要紧的
                        那半句。
                        The placeholder is short enough to fit; "not shown to the
                        user" moved into the title, because the truncated version
                        cut off exactly the part that matters. */}
                    <td className="px-3 py-3">
                      <input
                        type="text"
                        className="input w-28 py-1 text-xs"
                        placeholder={t('admin.notePlaceholder')}
                        title={t('admin.noteHint')}
                        value={d.planNote}
                        onChange={(e) => updateDraft(u.id, { planNote: e.target.value })}
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-3 text-xs">
                      {u.inviteCode ? (
                        <span className="text-neutral-200" title={u.inviteCode}>{linkLabel(u.inviteCode)}</span>
                      ) : (
                        <span className="text-neutral-600">{t('admin.inviteNone')}</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center font-mono text-xs text-neutral-300">{u.mt5AccountCount}</td>
                    <td className="px-3 py-3 text-xs text-neutral-400">{fmtTime(u.lastActiveAt)}</td>
                    <td className="px-3 py-3">
                      <div className="flex gap-2">
                        <button
                          className="btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
                          disabled={!dirty || savingId === u.id}
                          onClick={() => requestSave(u)}
                        >
                          {savingId === u.id ? t('common.loading') : t('common.save')}
                        </button>
                        {dirty && (
                          <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => resetDraft(u)}>
                            {t('common.reset')}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* 翻页：复用订单页/已平仓列表/回测明细在用的那套 Pager（页码从 0 起）。
          总数走后端返回的 total，所以"共 N 位用户"与页数是同一个来源。
          Paging reuses the same Pager as the orders page, closed-trades list and
          backtest detail (zero-based). Page count comes from the backend's
          `total`, so the "N users total" caption and the page count agree. */}
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
        </>
      )}

      {/* 批量修改的二次确认。文案里把受影响人数与每一条具体改动都列出来——
          「确定吗？」式的空确认框只会被训练成条件反射，真正拦住误操作的是让人
          在按下去之前读到「12 位用户 · 角色 → admin」。
          Bulk-edit confirmation. The copy spells out the affected count and every
          individual change: a content-free "are you sure?" only trains reflexive
          clicking, whereas reading "12 users · role → admin" before pressing is
          what actually stops the mistake. */}
      {bulkConfirm && (() => {
        const { changes } = bulkPayload()
        const promoting = bulkRole === 'admin'
        // 指派归因 = 把这些人的邮箱交给那个代理（/agent 的名单页返回邮箱）。
        // 这是本操作唯一对外可见、且撤不回来的后果——撤销只能停止继续显示，
        // 看过的人已经看过了。所以它和"提权成管理员"一样进确认框正文。
        // Assigning attribution hands these people's email addresses to that
        // agent (the /agent list returns them). It is the one outward-visible,
        // unrecallable consequence here — undoing only stops future display —
        // so it goes in the dialog body, like the promote-to-admin warning.
        const assigningInvite = !!bulkInvite && bulkInvite !== BULK_CLEAR_INVITE
        return (
          <ConfirmModal
            center
            danger
            busy={bulkSaving}
            title={t('admin.bulkConfirmTitle')}
            message={
              t('admin.bulkConfirmBody', { n: selectedIds.size, changes: changes.join(' · ') }) +
              // 拼成一段而不是换行：ConfirmModal 的 message 渲染在普通 <p> 里，
              // 不保留换行符，写了也是白写（要保留就得改 ConfirmModal 的样式，
              // 而那会影响它全部十来个调用点）。
              // Joined into one paragraph rather than split by newlines:
              // ConfirmModal renders `message` in a plain <p> that collapses
              // them. Preserving them would mean changing ConfirmModal's styling,
              // which every one of its dozen call sites would inherit.
              (promoting ? ' ' + t('admin.bulkConfirmAdminWarn') : '') +
              (assigningInvite ? ' ' + t('admin.bulkConfirmInviteWarn', { agent: linkLabel(bulkInvite) }) : '')
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

      {/* 恢复的确认。用普通 ConfirmModal 且不标 danger——恢复是把权限还回去，
          不是破坏性操作；文案里带上当初停用的原因，省得管理员去别处翻"当时为什么
          停的"就直接放行。
          Restore confirmation: plain ConfirmModal and not danger — handing access
          back is not destructive. The copy carries the original reason so nobody
          has to go looking elsewhere for why it was disabled before undoing it. */}
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

      {/* 历史信号回放：功能内部试用中，暂不对普通用户开放，也不放进主导航或
          仪表盘/订单页——入口只留在管理者页面最底下，需要的人自己找得到，
          不需要的人完全看不见。真正的权限边界仍在后端 require_admin。
          Signal replay: in internal trial, not released to regular users, and
          kept out of the main nav / dashboard / orders page — the only entry
          point is this quiet link at the bottom of the admin page. The real
          boundary is still the backend's require_admin. */}
      <div className="mt-8 border-t border-white/5 pt-4 text-right">
        <Link to="/simulator" className="text-xs text-neutral-500 hover:text-neutral-400">
          {t('simulator.entry')}
        </Link>
      </div>
    </div>
  )
}
