// 管理控制台的分组与分区（2026-10-17 重做）：原来 15 个平铺页签排两行，找一个功能要从头扫到尾。
// 现在按「改了之后谁受影响 / 管理员要做的是哪件事」收成 6 个子页面，每个子页面里的分区是原来的页签
// （客服页签里那排子页也提了上来，与工单并列，不再是页签里套页签）。
//
// 地址是 /admin/<分区>：分区 key 沿用原来的页签 key，所以旧的 ?tab=<key> 深链（后端通知里写死的
// /admin?tab=tickets&ticket=… 之类）只要换个路径就能落到同一个地方，其余查询参数原样带过去。
// 唯一改了含义的是 ?tab=support：那个页签已经拆成五个分区，落到第一个（成员），与原来的默认子页一致。
//
// The admin console's groups and sections (redone 2026-10-17). Fifteen flat tabs on two rows became
// six sub-pages grouped by what the admin is doing; each sub-page's sections are the old tabs (the
// support tab's own sub-pages were lifted up beside tickets instead of tabs inside a tab).
// URLs are /admin/<section>; section keys are the old tab keys, so a legacy ?tab=<key> deep link
// (the backend writes /admin?tab=tickets&ticket=… into notifications) maps to a path with every other
// query param carried over. Only ?tab=support changes meaning: that tab is now five sections and it
// lands on the first (staff), which was its default sub-page anyway.

export type AdminGroup = 'overview' | 'users' | 'growth' | 'content' | 'support' | 'settings'

export type AdminSection =
  | 'data'
  | 'health'
  | 'users'
  | 'logs'
  | 'invites'
  | 'competitions'
  | 'gamification'
  | 'guide'
  | 'winrate'
  | 'announcements'
  | 'email'
  | 'tickets'
  | 'staff'
  | 'assign'
  | 'progress'
  | 'approvals'
  | 'performance'
  | 'templates'
  | 'ops'
  | 'system'

// 顺序就是侧栏与分区标签的顺序。总览打头：出问题时第一个要看的是系统状态，它在总览里第二个。
// Order is the rail and tab order. Overview first: system status, the first thing to check when
// something breaks, is its second section.
export const ADMIN_GROUPS: { id: AdminGroup; sections: AdminSection[] }[] = [
  { id: 'overview', sections: ['data', 'health'] },
  { id: 'users', sections: ['users', 'logs'] },
  { id: 'growth', sections: ['invites', 'competitions', 'gamification'] },
  { id: 'content', sections: ['guide', 'winrate', 'announcements', 'email'] },
  { id: 'support', sections: ['tickets', 'staff', 'assign', 'progress', 'approvals', 'performance', 'templates'] },
  { id: 'settings', sections: ['ops', 'system'] },
]

export const DEFAULT_SECTION: AdminSection = 'data'

const ALL_SECTIONS: AdminSection[] = ADMIN_GROUPS.flatMap((g) => g.sections)

export function isAdminSection(v: string | null | undefined): v is AdminSection {
  return !!v && (ALL_SECTIONS as string[]).includes(v)
}

export function groupOf(section: AdminSection): AdminGroup {
  return (ADMIN_GROUPS.find((g) => g.sections.includes(section)) ?? ADMIN_GROUPS[0]).id
}

export function sectionsOf(group: AdminGroup): AdminSection[] {
  return ADMIN_GROUPS.find((g) => g.id === group)?.sections ?? []
}

// 旧页签 key → 新分区。只有 support 不是同名。
// Legacy tab key → section. Only `support` differs.
const LEGACY_TAB: Record<string, AdminSection> = { support: 'staff' }

// /admin?tab=… 的落点：返回要 replace 过去的完整地址（路径 + 剩余查询串）。没有 tab、或 tab 不认识时
// 落到默认分区，其余参数照样带上——数据看板的时间范围就写在查询串里。
// Where /admin?tab=… lands: the full path + remaining query to replace to. A missing or unknown tab
// falls back to the default section, still carrying the other params (the dashboard keeps its
// range in the query string).
// 操作日志的 user / login 不往下带：控制台挂载时已经由 readLogsDeepLink 读进筛选（日志面板只在挂载时
// 读一次筛选），留在地址栏的话管理员在页内去掉筛选、一刷新又被带回来。
// The activity log's user / login are not carried: the console read them into the filter on mount
// (readLogsDeepLink; the panel reads its filter once), and left in the address bar a filter removed
// in-page would come back on refresh.
export function legacyAdminTarget(search: string): string {
  const params = new URLSearchParams(search)
  const tab = params.get('tab')
  params.delete('tab')
  const mapped = tab ? LEGACY_TAB[tab] ?? tab : null
  const section = isAdminSection(mapped) ? mapped : DEFAULT_SECTION
  if (section === 'logs') {
    params.delete('user')
    params.delete('login')
  }
  const rest = params.toString()
  return `/admin/${section}${rest ? `?${rest}` : ''}`
}

// 带着用户 / MT5 账号进操作日志的深链：旧的 /admin?tab=logs&user=<id>&login=<login>，或新的
// /admin/logs?user=…。只在控制台挂载时读一次。
// A deep link into the activity log carrying a user / MT5 login: the legacy
// /admin?tab=logs&user=<id>&login=<login> or the new /admin/logs?user=…. Read once on mount.
export function readLogsDeepLink(pathname: string, search: string): { userId: string | null; login: string | null } | null {
  const params = new URLSearchParams(search)
  const onLogs = params.get('tab') === 'logs' || /^\/admin\/logs\/?$/i.test(pathname)
  if (!onLogs) return null
  const userId = params.get('user')
  const login = params.get('login')
  return userId || login ? { userId, login } : null
}

// 管理员不用客服后台（2026-10-17）：入口只给客服，管理员误进 /support-desk（旧书签、旧通知）时换到控制台里
// 对应的地方——工单深链进工单分区并打开那张工单，跟进深链进跟进进度并打开那条记录，其余落到工单。
// Admins don't use the support console (2026-10-17): its entry is for agents only, and an admin who
// lands on /support-desk (an old bookmark or notification) goes to the matching console section — a
// ticket link opens that ticket under tickets, a follow-up link opens that record under progress,
// anything else lands on tickets.
export function adminTargetForDesk(pathname: string, search: string): string {
  const params = new URLSearchParams(search)
  const inPath = pathname.match(/^\/support-desk\/tickets\/([^/]+)/)?.[1]
  let ticket = params.get('ticket')
  if (!ticket && inPath) {
    try {
      ticket = decodeURIComponent(inPath)
    } catch {
      ticket = inPath
    }
  }
  if (ticket) return `/admin/tickets?ticket=${encodeURIComponent(ticket)}`
  const followUp = params.get('followUp')
  if (followUp) return `/admin/progress?followUp=${encodeURIComponent(followUp)}`
  if (/^\/support-desk\/follow-ups(\/|$)/.test(pathname)) return '/admin/progress'
  return '/admin/tickets'
}
