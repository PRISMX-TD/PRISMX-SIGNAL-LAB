// 代理页的客户行零件：头像 + 名字、MT5 绑定、等级徽标与到期、手机卡片的事实格、最近活跃日，
// 以及分区标题、搜索框、翻页、空态。「我的链接」名单、「全部客户」名单（rev 47 代理层级）与
// 「团队」里展开的直属客户共用，免得几份名单各自长成几种样子。样式在 styles/agent.css。
// Customer-row pieces for the agent view (avatar + name, MT5, tier, phone fact grid, last
// active) plus the section head, search box, pager and empty state. Shared by the per-link
// list, "All customers" (rev 47) and the clients under each Team node so they never drift.
// Styles live in styles/agent.css.
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { fmtDate } from '../../api/utils'
import type { AgentLinkUser, AgentMT5Account } from '../../api/types'
import { IconSearch, IconUsers } from './agentIcons'

// 「近 7 日」的分界日。后端给的 lastActiveDay 是北京时间的日历日字符串
// （YYYY-MM-DD），所以这里也按北京时间取当天，再直接比字符串——ISO 日期按
// 字典序比就是按时间比，不用解析成 Date（解析会把它当 UTC 零点再偏一次时区）。
// Cut-off day for "last 7 days". lastActiveDay is a Beijing-time calendar date
// string, so this one is too, and ISO dates compare correctly as strings —
// parsing them into Date would shift them by a timezone a second time.
const statsDay = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
const isRecentDay = (day: string) => day >= statsDay(Date.now() - 6 * 86_400_000)

const MT5_TYPE_KEY = { real: 'agent.mt5Real', demo: 'agent.mt5Demo', contest: 'agent.mt5Contest' } as const

// MT5 绑定：打码账号 + 实盘/模拟 + 服务器，外加「连没连上」。
//
// 这一列只回答代理真正要问的那一句：这个人接进来了没有。通道（直连/桥接）、
// 此刻在不在线、最近一次连接是什么时候，2026-09-19 全部撤掉——代理拿它们做不了
// 任何决定，而且两条通道口径不同摆在一起只会被误读（桥接的在线随客户关电脑闪烁；
// 直连的"在线"其实是平台自己那台网关的健康状态、全站共享）。别再加回来。
//
// 不能跟单的绑定（直连授权作废）照样列出，只是压灰标「未连接」：跟能用的账号
// 长得一样，代理会以为客户在跟单，其实没有。
//
// One binding per line: masked login, real/demo, server, and whether it is
// connected. That last bit is the only question an agent can act on; channel,
// live online state and last-seen were all removed (see the backend schema).
// Unusable bindings are greyed out rather than hidden — looking identical to a
// working account would have the agent believe their client is trading.
export function Mt5List({ accounts }: { accounts: AgentMT5Account[] }) {
  const { t } = useTranslation()
  if (accounts.length === 0) return <span className="text-neutral-500">{t('agent.mt5None')}</span>
  return (
    <ul className="space-y-1.5">
      {accounts.map((a, i) => (
        <li key={`${a.login}-${i}`} className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`num ${a.connected ? 'text-neutral-100' : 'text-neutral-500 line-through'}`}>
              {a.login}
            </span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[11px] ${
                a.accountType === 'real' && a.connected ? 'bg-up/15 text-up' : 'bg-white/5 text-neutral-400'
              }`}
            >
              {t(a.accountType ? MT5_TYPE_KEY[a.accountType] : 'agent.mt5Unknown')}
            </span>
            {!a.connected && (
              <span className="rounded-full bg-white/5 px-1.5 py-0.5 text-[11px] text-neutral-400">
                {t('agent.mt5None')}
              </span>
            )}
          </div>
          {a.server && <p className="break-words text-[11px] text-neutral-500">{a.server}</p>}
        </li>
      ))}
    </ul>
  )
}

export function PlanBadge({ plan }: { plan: string }) {
  return <span className={`agt-plan${plan === 'PRO' ? ' is-pro' : ''}`}>{plan}</span>
}

// 会员到期文案。FREE 没有到期可言（返回 null，调用方整行不画）；不限期（PRO 且
// 没有到期日）是管理员手动给的，直接说出来，免得代理点了才吃一个 409。
//
// **带年份**（fmtDate 而不是 fmtTime）：到期日常常落在明年，只写「31/12」谁也说不清
// 是哪一年，而这恰恰是代理点「延长」之前最需要看准的一个数。
// Expiry caption; null for FREE. Uses fmtDate (with the year) rather than
// fmtTime: an expiry routinely lands in a later year, and "31/12" alone cannot
// say which — precisely the number an agent checks before extending.
export type TFn = ReturnType<typeof useTranslation>['t']

export function planExpiryText(user: AgentLinkUser, t: TFn): string | null {
  if (user.plan !== 'PRO') return null
  return user.planExpiresAt ? fmtDate(user.planExpiresAt) : t('agent.plan.noExpiry')
}

// 桌面表格的「等级」格：徽标 + 到期（带标签，否则与右边的注册时间分不清）。
// Desktop tier cell: badge plus a labelled expiry — without the label it reads
// as just another timestamp next to the signup one.
export function PlanCell({ user }: { user: AgentLinkUser }) {
  const { t } = useTranslation()
  const expiry = planExpiryText(user, t)
  return (
    <div className="min-w-0">
      <PlanBadge plan={user.plan} />
      {expiry && <p className="agt-plan-until num">{t('agent.plan.until', { time: expiry })}</p>}
    </div>
  )
}

// 手机卡里的一格「标签在上、值在下」。手机上每个时间都必须自带标签——桌面有表头，手机
// 没有，两个时间叠在一起谁也认不出哪个是到期、哪个是注册（2026-09-19 负责人就是这么发现的）。
// wide 的那格独占一行（MT5 绑定可能有好几条）。
// One phone-card cell, label above value. On a phone every timestamp needs its own label:
// there is no table header, so two stacked times are indistinguishable. wide spans the row.
export function Fact({ label, wide, children }: { label: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`agt-fact${wide ? ' is-wide' : ''}`}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

// 头像是名字的首字（没有头像图可用）。/ The avatar is the name's first character.
export const initialOf = (name: string) => Array.from(name.trim())[0]?.toUpperCase() ?? '·'

// 名单里的「人」：首字头像 + 昵称（没有就写「未设昵称」）+ 邮箱；badge 跟在名字后面。
// 推荐官本人的头像套紫圈，一眼分出名单里谁也在带人。
// A person in a list: initial avatar, nickname (or "no nickname"), email, an optional badge
// after the name. Ambassadors get a violet ring so they stand out in a customer list.
export function Person({
  nickname,
  email,
  badge,
  agent,
  small,
}: {
  nickname: string | null
  email: string
  badge?: ReactNode
  agent?: boolean
  small?: boolean
}) {
  const { t } = useTranslation()
  return (
    <div className={`agt-person${small ? ' is-sm' : ''}`}>
      <span className={`agt-avatar${agent ? ' is-agent' : ''}`} aria-hidden="true">
        {initialOf(nickname || email)}
      </span>
      <div className="agt-person-text">
        <p className="agt-person-name">
          {nickname ? <span>{nickname}</span> : <span className="is-dim">{t('agent.noNickname')}</span>}
          {badge}
        </p>
        <p className="agt-person-mail num">{email}</p>
      </div>
    </div>
  )
}

// 分区标题：标题 + 人数胶囊 + 一行副标题，右边放这一区的工具（时间范围、搜索框）。
// Section head: title, count pill, subtitle, and the section's tools on the right.
export function SectionHead({
  title,
  count,
  sub,
  tools,
}: {
  title: string
  count?: number | null
  sub?: ReactNode
  tools?: ReactNode
}) {
  return (
    <div className="agt-sec-head">
      <div className="agt-sec-titles">
        <h2 className="agt-sec-title">
          {title}
          {count != null && <span className="agt-sec-count num">{count.toLocaleString('en-US')}</span>}
        </h2>
        {sub && <p className="agt-sec-sub">{sub}</p>}
      </div>
      {tools && <div className="agt-sec-tools">{tools}</div>}
    </div>
  )
}

export function SearchBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useTranslation()
  return (
    <label className="agt-search">
      <IconSearch size={15} />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('agent.searchPlaceholder')}
        aria-label={t('agent.searchPlaceholder')}
        maxLength={128}
        className="input"
      />
    </label>
  )
}

export function EmptyState({ text }: { text: string }) {
  return (
    <div className="agt-empty">
      <span className="agt-empty-icon">
        <IconUsers size={20} />
      </span>
      <p>{text}</p>
    </div>
  )
}

// 翻页条：上一页 / 第几页 / 下一页。只有一页时调用方不画。
// Pager: previous / page x of y / next; callers skip it for a single page.
export function Pager({
  offset,
  pageSize,
  total,
  onChange,
}: {
  offset: number
  pageSize: number
  total: number
  onChange: (offset: number) => void
}) {
  const { t } = useTranslation()
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const pageNo = Math.floor(offset / pageSize) + 1
  return (
    <div className="agt-pager">
      <button
        type="button"
        className="btn btn-ghost"
        disabled={offset === 0}
        onClick={() => onChange(Math.max(0, offset - pageSize))}
      >
        {t('agent.prev')}
      </button>
      <span className="num">{t('agent.pageOf', { page: pageNo, pages })}</span>
      <button
        type="button"
        className="btn btn-ghost"
        disabled={offset + pageSize >= total}
        onClick={() => onChange(offset + pageSize)}
      >
        {t('agent.next')}
      </button>
    </div>
  )
}

export function LastActive({ day }: { day: string | null }) {
  const { t } = useTranslation()
  // 前面一颗点：近 7 日内是绿点、字亮着，更早的灰点压灰，从没来过是空心圈——一眼看出哪些人已经不来了。
  // A leading dot: green and bright within 7 days, grey for older, hollow for never — who
  // stopped coming, at a glance.
  if (!day)
    return (
      <span className="agt-seen is-never">
        <i aria-hidden="true" />
        {t('agent.neverActive')}
      </span>
    )
  return (
    <span className={`agt-seen num${isRecentDay(day) ? ' is-recent' : ''}`}>
      <i aria-hidden="true" />
      {day}
    </span>
  )
}
