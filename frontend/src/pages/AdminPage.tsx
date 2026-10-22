// 管理控制台 /admin/<分区>（2026-10-17 重做）：左侧常驻导航把原来 15 个平铺页签收成 6 个子页面
// （总览 / 用户 / 增长 / 内容 / 客服 / 设置，见 components/admin/console/sections.ts），子页面里的分区
// 用页头下的标签切换。本文件只管外壳：侧栏、页头、分区路由、浮动提示，以及几个分区之间互相带人的
// 状态（用户表 → 邮件 / 跟进分配 / 操作日志，运营设置 → 邀请链接的「试用是否开着」）。
// 每个分区的读写都在各自的 Panel 里；权限边界在后端每个 /admin/* 接口上。
// The admin console at /admin/<section> (redone 2026-10-17). A persistent rail folds the old 15
// flat tabs into six sub-pages (overview / users / growth / content / support / settings, see
// components/admin/console/sections.ts); each sub-page switches sections with tabs under its
// header. This file is the shell only: rail, header, section routing, the floating toast, and the
// state sections hand to each other (users → email / assign / activity log, ops settings → the
// invites tab's "is the trial on"). Each section reads and writes inside its own Panel; the real
// permission boundary is the backend on every /admin/* endpoint.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Link, Navigate, useLocation, useMatch, useNavigate, useSearchParams } from 'react-router-dom'
import { adminApi, adminSupportApi } from '../api/client'
import { useAuth } from '../store/auth'
import { useToast } from '../utils/useToast'
import { Avatar } from '../components/support/supportUi'
import ActivityLogPanel, { type LogsPreset } from '../components/admin/ActivityLogPanel'
import AdminTicketsPanel from '../components/admin/AdminTicketsPanel'
import AnnouncementsPanel from '../components/admin/AnnouncementsPanel'
import CompetitionsPanel from '../components/admin/CompetitionsPanel'
import EmailAutomationPanel from '../components/admin/EmailAutomationPanel'
import EmailPanel from '../components/admin/EmailPanel'
import GamificationPanel from '../components/admin/GamificationPanel'
import InviteLinksPanel from '../components/admin/InviteLinksPanel'
import LuckyWheelPanel from '../components/admin/lucky/LuckyWheelPanel'
import OpsSettingsPanel from '../components/admin/OpsSettingsPanel'
import PlatformStrategiesPanel from '../components/admin/PlatformStrategiesPanel'
import StrategyWinratePanel from '../components/admin/StrategyWinratePanel'
import SystemSettingsPanel from '../components/admin/SystemSettingsPanel'
import SystemStatusPanel from '../components/admin/SystemStatusPanel'
import UsersPanel from '../components/admin/UsersPanel'
import OverviewPanel from '../components/admin/overview/OverviewPanel'
import ApprovalsPanel from '../components/admin/support/ApprovalsPanel'
import AssignPanel from '../components/admin/support/AssignPanel'
import PerformancePanel from '../components/admin/support/PerformancePanel'
import ProgressPanel from '../components/admin/support/ProgressPanel'
import StaffPanel from '../components/admin/support/StaffPanel'
import TemplatesPanel from '../components/admin/support/TemplatesPanel'
import { GroupIcon, IconReplay } from '../components/admin/console/consoleIcons'
import {
  ADMIN_GROUPS,
  groupOf,
  isAdminSection,
  legacyAdminTarget,
  readLogsDeepLink,
  sectionsOf,
  type AdminGroup,
  type AdminSection,
} from '../components/admin/console/sections'
import '../styles/admin.css'

// 角标数字封顶，与客服后台一致 / badge cap, same as the support console
const fmtBadge = (n: number | null) => (n ? (n >= 50 ? '50+' : String(n)) : null)

export default function AdminPage() {
  const location = useLocation()
  const match = useMatch('/admin/:section')
  // /admin 本身：旧的 ?tab= 深链或直接进来，换成分区地址（replace，不在历史里多留一条）。
  // /admin itself: a legacy ?tab= deep link or a plain visit, replaced with the section URL.
  if (/^\/admin\/?$/i.test(location.pathname)) return <Navigate to={legacyAdminTarget(location.search)} replace />
  const raw = match?.params.section?.toLowerCase()
  if (!isAdminSection(raw)) return <Navigate to="/admin/data" replace />
  return <AdminConsole section={raw} />
}

function AdminConsole({ section }: { section: AdminSection }) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const group = groupOf(section)
  const { toast, showToast } = useToast()

  // 带进操作日志的筛选：用户表每行的「日志」按钮，或深链（见 readLogsDeepLink）。深链只在挂载时读一次，
  // 日志面板发现筛选已经不是带进来的那个时会回调清掉它，下次进分区不再带回来。
  // The filter carried into the activity log: the user table's per-row Log button or a deep link
  // (see readLogsDeepLink), read once on mount. The panel calls back to drop it once its filter
  // has moved on, so the next visit doesn't bring it back.
  const [logsPreset, setLogsPreset] = useState<LogsPreset | null>(() => readLogsDeepLink(location.pathname, location.search))
  useEffect(() => {
    if (section !== 'logs' || (!searchParams.has('user') && !searchParams.has('login'))) return
    const next = new URLSearchParams(searchParams)
    next.delete('user')
    next.delete('login')
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section])
  // 用户表批量坞「发邮件」/「分配跟进」带过去的那批人；对应面板挂载时读一次。
  // Users handed over by the dock's Email / Assign; each panel reads them once on mount.
  const [emailPreset, setEmailPreset] = useState<string[]>([])
  const [assignPreset, setAssignPreset] = useState<string[]>([])

  // 邀请链接的「送试用」列要判断"全局试用现在到底是不是开着"。试用表单住在运营设置里且是草稿，
  // 保存成功后经 onTrialSaved 回传到这里；进控制台时先读一次已保存值。传给邀请面板的必须是这个
  // 已保存值，不能是草稿——改了没存的草稿两个方向都会给出错误答案。
  // The invites section needs "is the global trial actually on". The trial form lives in ops
  // settings as a draft; a successful save reports back via onTrialSaved, and the persisted value
  // is read once on entry. The invites panel must get the persisted value, never the draft.
  const [savedTrialEnabled, setSavedTrialEnabled] = useState(false)
  useEffect(() => {
    let alive = true
    adminApi.getTrial().then((r) => { if (alive) setSavedTrialEnabled(r.trialEnabled) }).catch(() => {})
    return () => { alive = false }
  }, [])

  // 侧栏与分区标签上的两个角标：没人接的工单、待审批（申请 + 待审核的转化）。每次换分区重取一次——
  // 处理完回来数字就对上了，又不用在后台一直轮询。
  // Two badges: unclaimed tickets, and approvals (requests + conversions pending review). Refetched
  // on each section change, so the numbers are right after handling them, with no background polling.
  const [awaiting, setAwaiting] = useState<number | null>(null)
  const [pendingApprovals, setPendingApprovals] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    adminApi
      .listTickets({ assignee: 'none', status: 'active', limit: 50, offset: 0 })
      .then((rows) => { if (alive) setAwaiting(rows.length) })
      .catch(() => {})
    Promise.all([adminSupportApi.requests('pending'), adminSupportApi.conversions({ status: 'pending_review' })])
      .then(([r, c]) => { if (alive) setPendingApprovals(r.items.length + c.items.length) })
      .catch(() => {})
    return () => { alive = false }
  }, [section])

  // 每个子页面记住上次停在哪个分区：从「操作日志」去别处再点回「用户」，回到的是操作日志。
  // Each sub-page remembers its last section: leave the activity log and click Users again, and you
  // land back on the log.
  const lastSection = useRef<Partial<Record<AdminGroup, AdminSection>>>({})
  lastSection.current[group] = section

  // 手机上子页面条和分区标签都能横滑：换分区后把选中项滑到中间，否则「客服」这类靠右的项选中了也看不见。
  // Both the strip and the tabs scroll sideways on phones: centre the active item after a section
  // change, or a right-hand item like Support is selected but off-screen.
  const stripRef = useRef<HTMLElement>(null)
  const tabsRef = useRef<HTMLElement>(null)
  useEffect(() => {
    for (const nav of [stripRef.current, tabsRef.current]) {
      const active = nav?.querySelector<HTMLElement>('[aria-current="page"]')
      if (!nav || !active || nav.scrollWidth <= nav.clientWidth) continue
      const n = nav.getBoundingClientRect()
      const a = active.getBoundingClientRect()
      nav.scrollLeft += a.left - n.left - (n.width - a.width) / 2
    }
  }, [section])

  const sectionBadge = (s: AdminSection): { text: string; label: string } | null => {
    if (s === 'tickets') {
      const text = fmtBadge(awaiting)
      return text ? { text, label: t('supportDesk.nav.awaiting', { n: awaiting }) } : null
    }
    if (s === 'approvals') {
      const text = fmtBadge(pendingApprovals)
      return text ? { text, label: t('admin.console.pendingApprovals', { n: pendingApprovals }) } : null
    }
    return null
  }
  const supportBadge = (awaiting ?? 0) + (pendingApprovals ?? 0)

  const go = (s: AdminSection) => navigate(`/admin/${s}`)

  let content: ReactNode
  switch (section) {
    case 'data':
      content = <OverviewPanel />
      break
    case 'health':
      content = <SystemStatusPanel />
      break
    case 'users':
      content = (
        <UsersPanel
          onToast={showToast}
          onEmailUsers={(ids) => { setEmailPreset(ids); go('email') }}
          onAssignUsers={(ids) => { setAssignPreset(ids); go('assign') }}
          onShowLogs={(preset) => { setLogsPreset(preset); go('logs') }}
        />
      )
      break
    case 'logs':
      // 日志详情里的「打开用户资料」：回到用户列表并按邮箱搜出这个人（用户面板读 ?q=）。
      // "Open user profile" in the activity drawer: back to the user list, searched by email (?q=).
      content = (
        <ActivityLogPanel
          preset={logsPreset}
          onPresetCleared={() => setLogsPreset(null)}
          onOpenUser={(email) => navigate(`/admin/users?q=${encodeURIComponent(email)}`)}
        />
      )
      break
    case 'invites':
      content = <InviteLinksPanel globalTrialEnabled={savedTrialEnabled} />
      break
    case 'competitions':
      content = <CompetitionsPanel />
      break
    case 'gamification':
      content = <GamificationPanel />
      break
    case 'luckywheel':
      content = <LuckyWheelPanel />
      break
    case 'guide':
      content = <PlatformStrategiesPanel />
      break
    case 'winrate':
      content = <StrategyWinratePanel />
      break
    case 'announcements':
      content = <AnnouncementsPanel />
      break
    case 'email':
      content = <EmailPanel presetUserIds={emailPreset} onPresetCleared={() => setEmailPreset([])} />
      break
    case 'autoemail':
      content = <EmailAutomationPanel />
      break
    case 'tickets':
      content = <AdminTicketsPanel onToast={showToast} />
      break
    case 'staff':
      content = <StaffPanel onToast={showToast} />
      break
    case 'assign':
      content = <AssignPanel presetUserIds={assignPreset} onPresetCleared={() => setAssignPreset([])} onToast={showToast} />
      break
    case 'progress':
      content = <ProgressPanel onToast={showToast} />
      break
    case 'approvals':
      content = <ApprovalsPanel onToast={showToast} />
      break
    case 'performance':
      content = <PerformancePanel onToast={showToast} />
      break
    case 'templates':
      content = <TemplatesPanel onToast={showToast} />
      break
    case 'ops':
      content = <OpsSettingsPanel onTrialSaved={setSavedTrialEnabled} />
      break
    case 'system':
      content = <SystemSettingsPanel />
      break
  }

  const sections = sectionsOf(group)
  const groupHref = (g: AdminGroup) => `/admin/${lastSection.current[g] ?? sectionsOf(g)[0]}`

  return (
    // 后台是内部工具，不加节日按钮小饰。/ admin is an internal tool: no festival button charms
    <div data-fd-plain className="adm">
      <div className="adm-shell">
        <aside className="adm-rail" aria-label={t('admin.console.title')}>
          <div className="adm-rail-id">
            <Avatar name={user?.email} size={36} tone="staff" />
            <div className="min-w-0">
              <div className="adm-rail-title">{t('admin.console.title')}</div>
              <div className="adm-rail-sub" title={user?.email}>{user?.email}</div>
            </div>
          </div>
          <nav className="adm-rail-nav">
            {ADMIN_GROUPS.map((g) => {
              const active = g.id === group
              const badge = g.id === 'support' ? fmtBadge(supportBadge) : null
              return (
                <Link
                  key={g.id}
                  to={groupHref(g.id)}
                  className={`adm-rail-item ${active ? 'is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                >
                  <GroupIcon group={g.id} />
                  <span className="min-w-0 flex-1 truncate">{t(`admin.console.group.${g.id}`)}</span>
                  {badge && <span className="adm-badge num">{badge}</span>}
                </Link>
              )
            })}
          </nav>
          {/* 历史信号回放：功能内部试用中，不放进主导航或仪表盘，入口只留在后台侧栏最底下，需要的人
              自己找得到。真正的权限边界仍在后端 require_admin。
              Signal replay: in internal trial and kept out of the main nav; the only entry is this
              quiet link at the foot of the rail. The real boundary is the backend's require_admin. */}
          <div className="adm-rail-foot">
            <Link to="/simulator" className="adm-rail-link">
              <IconReplay size={15} />
              <span>{t('simulator.entry')}</span>
            </Link>
          </div>
        </aside>

        <div className="adm-main">
          {/* 手机 / 窄屏：侧栏换成一条可横滑的子页面条 / phones: the rail becomes a swipeable strip */}
          <nav ref={stripRef} className="adm-strip no-scrollbar" aria-label={t('admin.console.title')}>
            {ADMIN_GROUPS.map((g) => (
              <Link key={g.id} to={groupHref(g.id)} className={`adm-strip-item ${g.id === group ? 'is-active' : ''}`} aria-current={g.id === group ? 'page' : undefined}>
                <GroupIcon group={g.id} size={16} />
                <span>{t(`admin.console.group.${g.id}`)}</span>
                {g.id === 'support' && fmtBadge(supportBadge) && <span className="adm-badge num">{fmtBadge(supportBadge)}</span>}
              </Link>
            ))}
          </nav>

          <header className="adm-head">
            <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
              <div className="min-w-0">
                <h1 className="adm-title">{t(`admin.console.group.${group}`)}</h1>
                <p className="adm-desc">{t(`admin.console.groupDesc.${group}`)}</p>
              </div>
            </div>
            {sections.length > 1 && (
              <nav ref={tabsRef} className="adm-tabs no-scrollbar" aria-label={t(`admin.console.group.${group}`)}>
                {sections.map((s) => {
                  const badge = sectionBadge(s)
                  return (
                    <Link key={s} to={`/admin/${s}`} className={`adm-tab ${s === section ? 'is-active' : ''}`} aria-current={s === section ? 'page' : undefined}>
                      <span>{t(`admin.console.section.${s}`)}</span>
                      {badge && (
                        <span className="adm-badge num" title={badge.label} aria-label={badge.label}>
                          {badge.text}
                        </span>
                      )}
                    </Link>
                  )
                })}
              </nav>
            )}
          </header>

          {/* key=分区：换分区就重挂载，与原来切页签卸载面板的行为一致，也让淡入重播一次。
              key=section remounts on switch, as switching tabs used to, and replays the fade. */}
          <div key={section} className="adm-body adm-enter">
            {content}
          </div>
        </div>
      </div>

      {/* 提示浮在顶栏下方：不推动内容，抽屉 / 操作坞里的操作结果也看得见。
          The toast floats under the site header: it never shifts content, and stays visible over
          drawers and the bulk dock. */}
      {toast &&
        createPortal(
          <div className="pointer-events-none fixed inset-x-0 z-[80] flex justify-center px-4" style={{ top: 'calc(var(--app-hdr, 65px) + 12px)' }}>
            <div role="status" className={`adm-toast pointer-events-auto ${toast.kind === 'err' ? 'is-err' : 'is-ok'}`}>
              {toast.text}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
