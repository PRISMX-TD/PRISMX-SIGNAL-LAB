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
import Pager from '../components/Pager'
import { SkeletonLine } from '../components/Skeleton'
import OverviewPanel from '../components/admin/overview/OverviewPanel'
import PlatformStrategiesPanel from '../components/admin/PlatformStrategiesPanel'
import AnnouncementsPanel from '../components/admin/AnnouncementsPanel'
import InviteLinksPanel from '../components/admin/InviteLinksPanel'
import StrategyWinratePanel from '../components/admin/StrategyWinratePanel'
import GamificationPanel from '../components/admin/GamificationPanel'
import CompetitionsPanel from '../components/admin/CompetitionsPanel'
import type { AdminBrokerSettings, AdminPricingSettings, AdminEmailGateSettings, AdminSocialSettings, AdminTrialSettings, AdminCandleSettings, AdminStrategySettings, AdminUser, UserPlan, UserRole, Ticket, TicketCategory, TicketListItem, TicketPriority, TicketStatus } from '../api/types'

const PLAN_OPTIONS: UserPlan[] = ['FREE', 'PRO']
const ROLE_OPTIONS: UserRole[] = ['user', 'admin']

// 用户表每页条数。跟后端 routers/admin.py 的 PAGE_SIZE_DEFAULT 对齐（上限
// PAGE_SIZE_MAX=200），也跟代理页的 PAGE_SIZE 一致——同一套「上一页/下一页」
// 控件在两边表现一样，管理员不用重新建立手感。
// 此前这里写死 limit: 100 且没有任何翻页控件：第 101 位之后的用户在后台只能
// 靠搜索关键字撞，无法浏览；「全选」也只覆盖那 100 条，却看不出来。
// Rows per page in the user table, matching the backend's PAGE_SIZE_DEFAULT in
// routers/admin.py (ceiling PAGE_SIZE_MAX=200) and the agent page's PAGE_SIZE,
// so the same prev/next control behaves identically in both places. This used
// to be a hard-coded limit: 100 with no pager at all — user 101 onwards was
// unreachable except by guessing a search term, and "select all" silently
// covered only those first 100.
const PAGE_SIZE = 50

// 后台分为四类，与订单页的 Tab 模式一致：
// data   看数据（指标、页面访问统计）
// users  管人（搜索、批量、用户表）
// ops    改运营策略（定价、试用、券商锁）——影响用户看到什么、付多少钱
// system 调系统参数（纪律分算法、K 线保留、策略平台上限）——影响后台怎么算
// ops 与 system 的界线是"改了之后谁受影响"：ops 直接改变商业条款，system 改变
// 计算与存储行为。混在一起就是原来那个 7 组配置堆在一页、找不到东西的样子。
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

// 社交平台字段表：数组顺序就是后台表单顺序。平台名是品牌名，不进 i18n；
// placeholder 给出该平台「官方主页」的典型形状，省得填的人去猜要放个人页、
// 分享短链还是 App 内跳转链接——这五个平台的链接形态差别不小。
// Social field table; array order is the form order. Platform names are brands
// and stay out of i18n. Each placeholder shows what that platform's official
// page URL normally looks like, so nobody has to guess between a profile page,
// a share shortlink and an in-app deep link — the five differ a fair amount.
const SOCIAL_FIELDS: { key: keyof AdminSocialSettings; label: string; placeholder: string }[] = [
  { key: 'facebookUrl', label: 'Facebook', placeholder: 'https://www.facebook.com/yourpage' },
  { key: 'instagramUrl', label: 'Instagram', placeholder: 'https://www.instagram.com/youraccount' },
  { key: 'xUrl', label: 'X', placeholder: 'https://x.com/youraccount' },
  { key: 'discordUrl', label: 'Discord', placeholder: 'https://discord.gg/xxxxxxx' },
  { key: 'telegramUrl', label: 'Telegram', placeholder: 'https://t.me/yourchannel' },
]

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
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [savingId, setSavingId] = useState<string | null>(null)
  const { toast, showToast } = useToast()

  // 合作券商锁设置（patterns 在输入框里以逗号分隔编辑）
  // partner-broker lock settings (patterns edited as a comma-separated string)
  const [brokerSettings, setBrokerSettings] = useState<AdminBrokerSettings | null>(null)
  const [brokerPatternsText, setBrokerPatternsText] = useState('')
  const [savingBroker, setSavingBroker] = useState(false)

  // 订阅定价设置 / subscription pricing settings
  const [pricing, setPricing] = useState<AdminPricingSettings | null>(null)
  const [savingPricing, setSavingPricing] = useState(false)

  // 免费试用设置 / free-trial settings
  const [trial, setTrial] = useState<AdminTrialSettings | null>(null)
  const [savingTrial, setSavingTrial] = useState(false)
  // trial 是表单草稿：ops 分页勾选框每点一下就改它，只在 load()/saveTrial()
  // 时才跟服务器对齐。邀请分页的送试用列要判断"全局试用现在到底是不是开着"，
  // 读草稿会在草稿被改过、还没保存时给出错误答案（勾了没存 → 列会显示送
  // 试用可用，实际发不出去；反之亦然）。所以单独存一份已保存值，只在
  // load()/saveTrial() 里更新，传给 InviteLinksPanel 的必须是这个。
  // `trial` is a form draft: the ops-tab checkbox mutates it on every click and
  // it only reconciles with the server in load()/saveTrial(). The invites tab
  // needs "is the global trial actually on right now", and reading the draft
  // gives the wrong answer whenever it has been edited but not saved yet
  // (ticked-not-saved makes the trial column look live when it isn't, and vice
  // versa). Keep the persisted value separate, updated only in load() and
  // saveTrial(), and pass THAT to InviteLinksPanel.
  const [savedTrialEnabled, setSavedTrialEnabled] = useState(false)


  // 注册邮箱限制（一次性邮箱闸门）/ signup email gate
  //
  // 两个名单在界面上是多行文本框，state 里也就存文本而不是数组：管理员正在
  // 敲的中间状态（空行、还没打完的域名）如果每次 onChange 都往数组里塞，光标
  // 会因为重新渲染跳走，空行也会被吃掉。保存时才切成数组，和券商锁那个
  // brokerPatternsText 是同一个先例。
  //
  // The two lists are textareas, so the draft lives as text rather than an
  // array: parsing on every keystroke eats the blank line the admin is typing
  // through and moves the caret. Split on save — same precedent as
  // brokerPatternsText above.
  const [emailGate, setEmailGate] = useState<AdminEmailGateSettings | null>(null)
  const [emailBlockedText, setEmailBlockedText] = useState('')
  const [emailAllowedText, setEmailAllowedText] = useState('')
  const [savingEmailGate, setSavingEmailGate] = useState(false)

  // 官方社交主页 / official social links
  const [social, setSocial] = useState<AdminSocialSettings | null>(null)
  const [savingSocial, setSavingSocial] = useState(false)

  // K 线历史保留策略设置 / candle-history retention settings
  const [candleSettings, setCandleSettings] = useState<AdminCandleSettings | null>(null)
  const [savingCandle, setSavingCandle] = useState(false)

  // 自定义策略平台设置 / custom-strategy platform settings
  const [strategySettings, setStrategySettings] = useState<AdminStrategySettings | null>(null)
  const [savingStrategy, setSavingStrategy] = useState(false)

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

  const load = async (opts: { q?: string; plan?: string; page?: number } = {}) => {
    loadCtrl.current?.abort()
    const ctrl = new AbortController()
    loadCtrl.current = ctrl
    const wantedPage = opts.page ?? page
    setLoading(true)
    try {
      // 八个接口分区加载：以前是一个 Promise.all，任一失败整页报错、其余几块
      // 明明拿到了数据也不显示。现在各自成败各自算，失败的块保留旧值（首屏就是
      // 空态），只提示"N 项没加载出来"。其它页面早就吃过这个教训。
      // Eight endpoints settle independently: a single Promise.all used to fail the
      // whole page when any one of them failed, hiding data the others had
      // already returned. Each section now keeps its previous value on failure
      // and one toast says how many didn't load.
      const results = await Promise.allSettled([
        adminApi.listUsers(
          {
            q: (opts.q ?? query) || undefined,
            plan: (opts.plan ?? planFilter) || undefined,
            limit: PAGE_SIZE,
            offset: wantedPage * PAGE_SIZE,
          },
          ctrl.signal,
        ),
        adminApi.getSettings(),
        adminApi.getPricing(),
        adminApi.getTrial(),
        adminApi.getSocial(),
        adminApi.getEmailGate(),
        adminApi.getCandleHistory(),
        adminApi.getStrategySettings(),
      ])
      // 这一批已经被后来的一次 load 取代：其余七个接口没有 signal、照样会成功返回，
      // 若继续往下走就会用上一次的数据把新的一次盖掉——正是这里要防的那件事。
      // This batch has been superseded by a later load: the other seven calls
      // carry no signal and still resolve, so falling through would overwrite the
      // newer load's data with this one's — exactly what the guard is for.
      if (loadCtrl.current !== ctrl) return
      const [usersRes, settingsRes, pricingRes, trialRes, socialRes, emailGateRes, candleRes, strategyRes] = results
      setPage(wantedPage)
      let failed = 0
      const ok = <T,>(r: PromiseSettledResult<T>): T | null => {
        if (r.status === 'fulfilled') return r.value
        failed += 1
        return null
      }
      const users = ok(usersRes)
      if (users) {
        setUsers(users.users)
        setTotal(users.total)
        setDrafts(Object.fromEntries(users.users.map((u) => [u.id, toDraft(u)])))
      }
      const settings = ok(settingsRes)
      if (settings) {
        setBrokerSettings(settings)
        setBrokerPatternsText(settings.brokerPatterns.join(', '))
      }
      const pricingVal = ok(pricingRes)
      if (pricingVal) setPricing(pricingVal)
      const trialVal = ok(trialRes)
      if (trialVal) {
        setTrial(trialVal)
        setSavedTrialEnabled(trialVal.trialEnabled)
      }
      const socialVal = ok(socialRes)
      if (socialVal) setSocial(socialVal)
      const emailGateVal = ok(emailGateRes)
      if (emailGateVal) {
        setEmailGate(emailGateVal)
        setEmailBlockedText(emailGateVal.extraBlockedDomains.join('\n'))
        setEmailAllowedText(emailGateVal.extraAllowedDomains.join('\n'))
      }
      const candleVal = ok(candleRes)
      if (candleVal) setCandleSettings(candleVal)
      const strategyVal = ok(strategyRes)
      if (strategyVal) setStrategySettings(strategyVal)
      if (failed > 0) {
        const firstErr = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
        const reason = firstErr?.reason
        const detail = reason instanceof Error ? localizeApiError(reason.message) : ''
        // 分隔符用破折号而不是原来那个硬编码的全角「：」——中式标点在英文界面下
        // 会渲染成「... loaded：detail」。破折号在两种语言里都成立，也就不必按语言
        // 分叉，更不必为一个标点新开一条 i18n 文案。
        // An em dash rather than the hard-coded fullwidth colon this used to
        // carry: Chinese punctuation renders as "... loaded：detail" on the
        // English UI. A dash reads correctly in both languages, so no
        // per-language branch and no i18n entry for a punctuation mark.
        showToast('err', t('admin.loadPartialError', { n: failed, total: results.length }) + (detail ? ` — ${detail}` : ''))
      }
    } finally {
      if (loadCtrl.current === ctrl) setLoading(false)
    }
  }

  const saveBrokerSettings = async () => {
    if (!brokerSettings) return
    setSavingBroker(true)
    try {
      const updated = await adminApi.updateSettings({
        ...brokerSettings,
        brokerPatterns: brokerPatternsText.split(',').map((p) => p.trim()).filter(Boolean),
      })
      setBrokerSettings(updated)
      setBrokerPatternsText(updated.brokerPatterns.join(', '))
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingBroker(false)
    }
  }

  const savePricing = async () => {
    if (!pricing) return
    setSavingPricing(true)
    try {
      const updated = await adminApi.updatePricing(pricing)
      setPricing(updated)
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingPricing(false)
    }
  }

  const saveTrial = async () => {
    if (!trial) return
    setSavingTrial(true)
    try {
      const updated = await adminApi.updateTrial(trial)
      setTrial(updated)
      setSavedTrialEnabled(updated.trialEnabled)
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingTrial(false)
    }
  }

  const saveSocial = async () => {
    if (!social) return
    // 先在本地挡一道协议错误。后端也校验，但那是一条英文 422，管理员看到的是
    // 一串字段名而不是"Telegram 这一行填错了"——填五个框的表单必须说清是哪个。
    // Catch the scheme error locally first. The backend validates too, but its
    // 422 names the raw field, not "the Telegram row is wrong" — on a five-box
    // form the message has to say which box.
    const bad = SOCIAL_FIELDS.find((f) => {
      const v = (social[f.key] || '').trim()
      return v !== '' && !/^https?:\/\//i.test(v)
    })
    if (bad) {
      showToast('err', t('admin.socialInvalidUrl', { platform: bad.label }))
      return
    }
    setSavingSocial(true)
    try {
      const updated = await adminApi.updateSocial(social)
      setSocial(updated)
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingSocial(false)
    }
  }

  const saveEmailGate = async () => {
    if (!emailGate) return
    setSavingEmailGate(true)
    try {
      const split = (text: string) =>
        text.split('\n').map((d) => d.trim()).filter(Boolean)
      const updated = await adminApi.updateEmailGate({
        ...emailGate,
        extraBlockedDomains: split(emailBlockedText),
        extraAllowedDomains: split(emailAllowedText),
      })
      setEmailGate(updated)
      // 回填后端规范化后的结果：后端会去掉粘贴时带的 @、结尾的点并去重，不回填
      // 的话框里留着的还是管理员刚敲的原样，下次保存又要被规范化一遍，看着像没存上。
      // Reflect the server's normalisation (stripped @ prefixes, trailing dots,
      // duplicates) — otherwise the box still shows the raw input and the next
      // save looks like it didn't take.
      setEmailBlockedText(updated.extraBlockedDomains.join('\n'))
      setEmailAllowedText(updated.extraAllowedDomains.join('\n'))
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingEmailGate(false)
    }
  }

  const saveCandleSettings = async () => {
    if (!candleSettings) return
    setSavingCandle(true)
    try {
      const updated = await adminApi.updateCandleHistory(candleSettings)
      setCandleSettings(updated)
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingCandle(false)
    }
  }

  const saveStrategySettings = async () => {
    if (!strategySettings) return
    setSavingStrategy(true)
    try {
      const updated = await adminApi.updateStrategySettings(strategySettings)
      setStrategySettings(updated)
      showToast('ok', t('admin.saved'))
    } catch (err) {
      showToast('err', err instanceof Error ? localizeApiError(err.message) : t('admin.saveError'))
    } finally {
      setSavingStrategy(false)
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
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

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
    const payload: Partial<{ role: UserRole; plan: UserPlan; planExpiresAt: string | null }> = {}
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
    if (!bulkRole && !bulkPlan && !bulkSetExpiry) return
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
    <div>
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

      {tab === 'ops' && (
        <>
      {/* 合作券商锁设置 / partner-broker lock settings */}
      {brokerSettings && (
        <div className="glass mb-5 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-lg font-semibold text-neutral-100">{t('admin.brokerTitle')}</h3>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
              <Switch checked={brokerSettings.brokerLockEnabled} onChange={(v) => setBrokerSettings({ ...brokerSettings, brokerLockEnabled: v })} />
              {t('admin.brokerLockEnabled')}
            </label>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <label className="label">{t('admin.brokerPatterns')}</label>
              <input
                className="input"
                value={brokerPatternsText}
                onChange={(e) => setBrokerPatternsText(e.target.value)}
                placeholder="MakeCapital"
              />
              <p className="mt-1.5 text-xs text-neutral-500">{t('admin.brokerPatternsHint')}</p>
            </div>
            <div>
              <label className="label">{t('admin.brokerDisplayName')}</label>
              <input
                className="input"
                value={brokerSettings.brokerDisplayName}
                onChange={(e) => setBrokerSettings({ ...brokerSettings, brokerDisplayName: e.target.value })}
                placeholder="MakeCapital"
              />
            </div>
            <div>
              <label className="label">{t('admin.brokerReferralUrl')}</label>
              <input
                className="input"
                value={brokerSettings.brokerReferralUrl}
                onChange={(e) => setBrokerSettings({ ...brokerSettings, brokerReferralUrl: e.target.value })}
                placeholder="https://…"
              />
              {/* 这个字段以前填了没有任何效果（前端没人渲染它）。现在它同时决定
                  三处推广位是否出现，所以把作用范围写在旁边。
                  This field used to have no effect at all (nothing rendered it).
                  It now gates three promo placements, so say so next to it. */}
              <p className="mt-1.5 text-xs text-neutral-500">{t('admin.brokerReferralUrlHint')}</p>
            </div>
          </div>
          <button
            className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-40"
            disabled={savingBroker}
            onClick={saveBrokerSettings}
          >
            {savingBroker ? t('common.loading') : t('common.save')}
          </button>
        </div>
      )}

      {/* 订阅定价设置 / subscription pricing settings */}
      {pricing && (
        <div className="glass mb-5 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-lg font-semibold text-neutral-100">{t('admin.pricingTitle')}</h3>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
              <Switch checked={pricing.saleEnabled} onChange={(v) => setPricing({ ...pricing, saleEnabled: v })} />
              {t('admin.saleEnabled')}
            </label>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div>
              <label className="label">{t('admin.proMonthlyPrice')}</label>
              <div className="flex items-center gap-1">
                <span className="text-neutral-400">$</span>
                <input
                  type="number"
                  className="input"
                  step="0.01"
                  min="0"
                  value={pricing.proMonthlyPrice}
                  onChange={(e) => setPricing({ ...pricing, proMonthlyPrice: parseFloat(e.target.value) || 0 })}
                />
              </div>
              <p className="mt-1 text-[11px] text-neutral-500">{t('admin.proMonthlyPriceHint')}</p>
            </div>
            <div>
              <label className="label">{t('admin.proYearlyPrice')}</label>
              <div className="flex items-center gap-1">
                <span className="text-neutral-400">$</span>
                <input
                  type="number"
                  className="input"
                  step="0.01"
                  min="0"
                  value={pricing.proYearlyPrice}
                  onChange={(e) => setPricing({ ...pricing, proYearlyPrice: parseFloat(e.target.value) || 0 })}
                />
              </div>
              <p className="mt-1 text-[11px] text-neutral-500">{t('admin.proYearlyPriceHint')}</p>
            </div>
            <div>
              <label className="label">{t('admin.salePercent')}</label>
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  className="input"
                  min="0"
                  max="100"
                  value={pricing.salePercent}
                  onChange={(e) => setPricing({ ...pricing, salePercent: Math.min(100, Math.max(0, parseInt(e.target.value) || 0)) })}
                  disabled={!pricing.saleEnabled}
                />
                <span className="text-neutral-400">%</span>
              </div>
              <p className="mt-1 text-[11px] text-neutral-500">{t('admin.salePercentHint')}</p>
            </div>
            <div>
              <label className="label">{t('admin.saleBadge')}</label>
              <input
                className="input"
                value={pricing.saleBadge}
                onChange={(e) => setPricing({ ...pricing, saleBadge: e.target.value })}
                disabled={!pricing.saleEnabled}
                placeholder="SUMMER"
                maxLength={32}
              />
              <p className="mt-1 text-[11px] text-neutral-500">{t('admin.saleBadgeHint')}</p>
            </div>
          </div>
          {pricing.saleEnabled && (
            <div className="mt-4 rounded-lg border border-prism-400/20 bg-prism-500/10 px-4 py-3 text-sm text-prism-300">
              {/* toFixed(2)：29.9 × 0.85 的浮点结果是 25.414999999999996，而这正是
                  管理员用来判断"这个折扣要不要保存"的那个数字。
                  toFixed(2): 29.9 × 0.85 renders as 25.414999999999996 in binary
                  floating point, and this is the number the admin reads to decide
                  whether to save the discount. */}
              {t('admin.salePreview')}:{" "}
              <strong>${(pricing.proMonthlyPrice * (1 - pricing.salePercent / 100)).toFixed(2)}</strong> /{t('upgrade.monthly')}{" "}
              &middot;{" "}
              <strong>${(pricing.proYearlyPrice * (1 - pricing.salePercent / 100)).toFixed(2)}</strong> /{t('upgrade.yearly')}
            </div>
          )}
          <button
            className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-40"
            disabled={savingPricing}
            onClick={savePricing}
          >
            {savingPricing ? t('common.loading') : t('common.save')}
          </button>
        </div>
      )}

      {/* 免费试用设置 / free-trial settings */}
      {trial && (
        <div className="glass mb-5 p-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-lg font-semibold text-neutral-100">{t('admin.trialTitle')}</h3>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
              <Switch checked={trial.trialEnabled} onChange={(v) => setTrial({ ...trial, trialEnabled: v })} />
              {t('admin.trialEnabled')}
            </label>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div>
              <label className="label">{t('admin.trialDays')}</label>
              <input
                type="number"
                className="input"
                min="1"
                max="90"
                value={trial.trialDays}
                onChange={(e) => setTrial({ ...trial, trialDays: Math.min(90, Math.max(1, parseInt(e.target.value) || 1)) })}
                disabled={!trial.trialEnabled}
              />
            </div>
          </div>
          <button
            className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-40"
            disabled={savingTrial}
            onClick={saveTrial}
          >
            {savingTrial ? t('common.loading') : t('common.save')}
          </button>
        </div>
      )}

      {/* 注册邮箱限制 / signup email gate */}
      {emailGate && (
        <div className="glass mb-5 p-5">
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-lg font-semibold text-neutral-100">{t('admin.emailGateTitle')}</h3>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
              <Switch
                checked={emailGate.disposableBlockEnabled}
                onChange={(v) => setEmailGate({ ...emailGate, disposableBlockEnabled: v })}
              />
              {t('admin.emailGateEnabled')}
            </label>
          </div>
          <p className="mb-4 text-xs text-neutral-500">{t('admin.emailGateHint')}</p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div>
              <label className="label">{t('admin.emailGateExtraBlocked')}</label>
              <textarea
                className="input min-h-28 font-mono text-xs"
                spellCheck={false}
                value={emailBlockedText}
                onChange={(e) => setEmailBlockedText(e.target.value)}
                placeholder={'mailinator.com\n10minutemail.com'}
              />
              <p className="mt-1.5 text-xs text-neutral-500">{t('admin.emailGateListHint')}</p>
            </div>
            <div>
              <label className="label">{t('admin.emailGateExtraAllowed')}</label>
              <textarea
                className="input min-h-28 font-mono text-xs"
                spellCheck={false}
                value={emailAllowedText}
                onChange={(e) => setEmailAllowedText(e.target.value)}
                placeholder={'mycompany.com\nuniversity.edu.cn'}
              />
              <p className="mt-1.5 text-xs text-neutral-500">{t('admin.emailGateAllowedHint')}</p>
            </div>
          </div>
          <button
            className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-40"
            disabled={savingEmailGate}
            onClick={saveEmailGate}
          >
            {savingEmailGate ? t('common.loading') : t('common.save')}
          </button>
        </div>
      )}

      {/* 官方社交主页 / official social links */}
      {social && (
        <div className="glass mb-5 p-5">
          <h3 className="mb-1.5 font-display text-lg font-semibold text-neutral-100">{t('admin.socialTitle')}</h3>
          <p className="mb-4 text-xs text-neutral-500">{t('admin.socialHint')}</p>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {SOCIAL_FIELDS.map((f) => (
              <div key={f.key}>
                <label className="label">{f.label}</label>
                <input
                  className="input"
                  type="url"
                  inputMode="url"
                  spellCheck={false}
                  maxLength={512}
                  value={social[f.key]}
                  onChange={(e) => setSocial({ ...social, [f.key]: e.target.value })}
                  placeholder={f.placeholder}
                />
              </div>
            ))}
          </div>
          <button
            className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-40"
            disabled={savingSocial}
            onClick={saveSocial}
          >
            {savingSocial ? t('common.loading') : t('common.save')}
          </button>
        </div>
      )}

        </>
      )}

      {tab === 'system' && (
        <>
      {/* K 线历史保留策略设置 / candle-history retention settings */}
      {candleSettings && (
        <div className="glass mb-5 p-5">
          <h3 className="mb-4 font-display text-lg font-semibold text-neutral-100">{t('admin.candleHistoryTitle')}</h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div>
              <label className="label">{t('admin.candleM1Retention')}</label>
              <input
                type="number"
                className="input"
                min="1"
                max="365"
                value={candleSettings.m1RetentionDays}
                onChange={(e) => setCandleSettings({ m1RetentionDays: Math.min(365, Math.max(1, parseInt(e.target.value) || 1)) })}
              />
            </div>
          </div>
          <button
            className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-40"
            disabled={savingCandle}
            onClick={saveCandleSettings}
          >
            {savingCandle ? t('common.loading') : t('common.save')}
          </button>
        </div>
      )}

      {/* 自定义策略平台设置 / custom-strategy platform settings */}
      {strategySettings && (
        <div className="glass mb-5 p-5">
          <h3 className="mb-4 font-display text-lg font-semibold text-neutral-100">{t('admin.strategyPlatformTitle')}</h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div>
              <label className="label">{t('admin.strategyMaxPerUser')}</label>
              <input
                type="number"
                className="input"
                min="1"
                max="50"
                value={strategySettings.maxStrategiesPerUser}
                onChange={(e) => setStrategySettings({ ...strategySettings, maxStrategiesPerUser: Math.min(50, Math.max(1, parseInt(e.target.value) || 1)) })}
              />
            </div>
            <div className="flex items-end pb-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-neutral-300">
                <Switch checked={strategySettings.proOnly} onChange={(v) => setStrategySettings({ ...strategySettings, proOnly: v })} />
                {t('admin.strategyProOnly')}
              </label>
            </div>
          </div>
          <button
            className="btn-primary mt-4 px-5 py-2 text-sm disabled:opacity-40"
            disabled={savingStrategy}
            onClick={saveStrategySettings}
          >
            {savingStrategy ? t('common.loading') : t('common.save')}
          </button>
        </div>
      )}

        </>
      )}

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
        <button type="submit" className="btn-primary px-5 py-2 text-sm">{t('admin.search')}</button>
        <span className="ml-auto text-xs text-neutral-500">{t('admin.totalCount', { n: total })}</span>
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
          <button
            className="btn-primary px-4 py-1.5 text-xs disabled:opacity-40"
            disabled={(!bulkRole && !bulkPlan && !bulkSetExpiry) || bulkSaving}
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
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-neutral-500">
                <th className="px-4 py-3">
                  <input
                    ref={headerCheckboxRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                    aria-label={t('admin.bulkSelectAll')}
                  />
                </th>
                <th className="px-4 py-3 font-medium">{t('admin.colEmail')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.colPhone')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.colRole')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.colPlan')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.colExpiresAt')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.colNote')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.colMt5Count')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.colLastActive')}</th>
                <th className="px-4 py-3 font-medium">{t('admin.colAction')}</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const d = drafts[u.id] ?? toDraft(u)
                const dirty = isDirty(u, d)
                return (
                  <tr key={u.id} className={`border-b border-white/5 align-top last:border-0 ${selectedIds.has(u.id) ? 'bg-prism-600/[0.06]' : ''}`}>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(u.id)}
                        onChange={() => toggleSelected(u.id)}
                        className="h-4 w-4 rounded border-white/20 bg-white/5 accent-prism-500"
                        aria-label={u.email}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <div className="max-w-[220px] truncate font-mono text-xs text-neutral-200">{u.email}</div>
                      <div className="mt-1 text-[11px] text-neutral-500">{fmtTime(u.createdAt)}</div>
                    </td>
                    {/* 手机号：存量用户为空。用「—」而不是留白，否则看起来像渲染坏了。
                        Empty for grandfathered users; an em dash rather than blank
                        space, which would read as a rendering bug. */}
                    <td className="px-4 py-3">
                      <div className="whitespace-nowrap font-mono text-xs text-neutral-300">
                        {u.phone || <span className="text-neutral-500">—</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Select
                        value={d.role}
                        onChange={(v) => updateDraft(u.id, { role: v as UserRole })}
                        options={ROLE_OPTIONS.map((r) => ({ value: r, label: r }))}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <Select
                        value={d.plan}
                        onChange={(v) => updateDraft(u.id, { plan: v as UserPlan })}
                        options={PLAN_OPTIONS.map((p) => ({ value: p, label: p }))}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="date"
                        className="input w-auto py-1 text-xs"
                        value={d.planExpiresAt}
                        onChange={(e) => updateDraft(u.id, { planExpiresAt: e.target.value })}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="text"
                        className="input w-40 py-1 text-xs"
                        placeholder={t('admin.notePlaceholder')}
                        value={d.planNote}
                        onChange={(e) => updateDraft(u.id, { planNote: e.target.value })}
                      />
                    </td>
                    <td className="px-4 py-3 text-center font-mono text-xs text-neutral-300">{u.mt5AccountCount}</td>
                    <td className="px-4 py-3 text-xs text-neutral-400">{fmtTime(u.lastActiveAt)}</td>
                    <td className="px-4 py-3">
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
              (promoting ? ' ' + t('admin.bulkConfirmAdminWarn') : '')
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
