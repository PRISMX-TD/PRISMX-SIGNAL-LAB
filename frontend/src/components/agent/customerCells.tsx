// 代理页的客户行零件：MT5 绑定、等级徽标与到期、手机卡片的标签行、最近活跃日。
// 「我的链接」名单与「全部客户」名单（rev 47 代理层级）共用，从 pages/AgentPage.tsx 搬出来，
// 免得两份名单各自长成两种样子。
// Customer-row pieces for the agent view, shared by the per-link list and the
// "All customers" list (rev 47 agent hierarchy) so the two never drift apart.
import { useTranslation } from 'react-i18next'
import { fmtDate } from '../../api/utils'
import type { AgentLinkUser, AgentMT5Account } from '../../api/types'

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
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs ${
        plan === 'PRO' ? 'bg-prism-500/20 text-prism-200' : 'bg-white/5 text-neutral-400'
      }`}
    >
      {plan}
    </span>
  )
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
      {expiry && (
        <p className="num mt-1 text-[11px] text-neutral-500">{t('agent.plan.until', { time: expiry })}</p>
      )}
    </div>
  )
}

// 手机卡里的一行「标签 + 值」。四行共用一个组件，标签宽度就自然对齐成一列；
// 手机上每个时间都必须自带标签——桌面有表头，手机没有，两个时间叠在一起谁也
// 认不出哪个是到期、哪个是注册（2026-09-19 负责人就是这么发现的）。
// One labelled row on the phone card. A shared component keeps the label column
// aligned, and on a phone every timestamp needs its own label: there is no table
// header here, so two stacked times are indistinguishable.
export function CardRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-1.5 flex items-baseline gap-2 text-xs">
      <span className="w-16 shrink-0 text-[11px] text-neutral-500">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

export function LastActive({ day }: { day: string | null }) {
  const { t } = useTranslation()
  if (!day) return <span className="text-neutral-500">{t('agent.neverActive')}</span>
  // 近 7 日内的亮着，更早的压灰——一眼看出哪些人已经不来了。
  // Recent days stay bright, older ones grey out: who stopped coming, at a glance.
  return (
    <span className={`num whitespace-nowrap ${isRecentDay(day) ? 'text-neutral-100' : 'text-neutral-500'}`}>
      {day}
    </span>
  )
}
