// 代理页（/agent）：管理员把邀请链接指派给某个用户后，该用户在这里看到名下每条
// 链接的点击数、注册人数、近 7 日活跃人数、已连 MT5 人数与状态，以及经它注册的
// 用户名单（含各人的最近活跃日与 MT5 绑定）。写操作只有两个：调整名下客户的会员
// （PlanDialog）与设置自己链接的开户链接（OpenAccountLinkEditor）；名单里没有手机号与
// 用户 id（见后端 AgentLinkUserOut）。
// 两条口径不在这里算，全部由后端给：活跃 = page_visitor_days 里有行（到天为止，
// 没有时刻也没有时长），MT5 账户号是后端打好码的。前端只负责显示，别在这里补
// 任何"推算"——一推算就会和管理看板的数字对不上。
// 「代理」不是角色：入口由 /auth/me 的 isAgent 派生（至少持有一条被指派的链接），
// role 与权益都不动。链接 URL 由 utils/promoLinkUrl 统一拼（ORIGIN，不是
// window.location.origin，理由同管理面板）。每条链接两个复制按钮（设计 §1.2）：
// 邀请链接 /?ref=码、比赛链接 /c?ref=码（固定链接，打开时显示当前主推比赛；
// 没有主推比赛时这个按钮不出现）。
// Agent view (/agent): after an admin assigns invite links to a user, they see
// each link's clicks, signups and status here, plus the list of users who
// registered through it. The only writes are a client's membership (PlanDialog) and
// the agent's own open-account URL (OpenAccountLinkEditor); the list carries no phone
// or user id (see AgentLinkUserOut).
// "Agent" is not a role: the entry is derived from /auth/me's isAgent; role and
// entitlements are untouched. URLs come from utils/promoLinkUrl. Two copy buttons per
// link (design §1.2): invite /?ref=code and competition /c?ref=code (fixed; resolves to
// the featured competition, hidden when there is none).
// 每张卡底部还有「我的开户链接」（components/agent/OpenAccountLinkEditor）：代理自己填
// Make Capital 开户链接，经他链接进比赛页的访客点「开户」时跳那里。
// Each card also carries "My open-account link" (OpenAccountLinkEditor): the agent's own
// Make Capital link, used when their visitors tap "Open account" on a competition page.
// rev 47 代理层级：页头下三个页签——「我的链接」（上面说的这些）、「团队」（我和全部下级代理，
// AgentTeamPanel）、「全部客户」（整棵子树的客户，AgentCustomersPanel）。页签记在 ?tab= 里，
// 手机返回能回到上一个页签。只有一级代理（/agent/team 的 canManage）能改会员、升 / 撤代理，
// 二级及以下只读——「我的链接」名单里的「调整会员」按钮也按它藏。
// rev 47 agent hierarchy: three tabs under the header — My links (above), Team
// (AgentTeamPanel) and All customers (AgentCustomersPanel), kept in ?tab= so the back
// gesture returns to the previous tab. Only top-level agents (canManage) may write;
// lower levels are read-only, so the per-link "Membership" button hides for them too.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import PageHead from '../components/PageHead'
import { SkeletonLine } from '../components/Skeleton'
import AgentCustomersPanel from '../components/agent/AgentCustomersPanel'
import AgentOverviewPanel from '../components/agent/AgentOverviewPanel'
import AgentTeamPanel from '../components/agent/AgentTeamPanel'
import PlanDialog from '../components/agent/PlanDialog'
import OpenAccountLinkEditor from '../components/agent/OpenAccountLinkEditor'
import { API_BASE, agentApi } from '../api/client'
import { fmtDate, localizeApiError } from '../api/utils'
import { CardRow, LastActive, Mt5List, PlanBadge, PlanCell, planExpiryText } from '../components/agent/customerCells'
import { agentCompetitionUrl, inviteUrl } from '../utils/promoLinkUrl'
import { segBtn } from '../utils/segBtn'
import { useDocumentTitle } from '../utils/useDocumentTitle'
import type { AgentLink, AgentLinkUser, AgentLinkUsers, AgentTeam } from '../api/types'

const PAGE_SIZE = 50

type Tab = 'links' | 'team' | 'customers'
const TABS: Tab[] = ['links', 'team', 'customers']

export default function AgentPage() {
  const { t } = useTranslation()
  useDocumentTitle(t('agent.title'))

  const [links, setLinks] = useState<AgentLink[] | null>(null)
  // 我在代理树上的位置（rev 47）：决定能不能写、页签里的团队与客户。加载失败就当只读，
  // 「我的链接」照常可用。
  // My place in the agent tree (rev 47): write access plus the Team / Customers tabs.
  // A failed load just means read-only; My links keeps working.
  const [team, setTeam] = useState<AgentTeam | null>(null)
  const canManage = team?.canManage ?? false
  const [params, setParams] = useSearchParams()
  const tabParam = params.get('tab') as Tab | null
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : 'links'
  // 「全部客户」按代理筛的邮箱；从「团队」点「查看客户」带过来。
  // The All-customers agent filter, set when Team's "View customers" jumps over.
  const [customerAgent, setCustomerAgent] = useState('')
  const switchTab = (next: Tab) => {
    if (next === tab) return
    setParams(next === 'links' ? {} : { tab: next })
  }
  const loadTeam = () => {
    agentApi
      .team()
      .then(setTeam)
      .catch(() => {})
  }
  useEffect(loadTeam, [])
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // 主推比赛 id（§1.3）。为 null 时不显示「复制比赛链接」——/c 没有可去的比赛时，
  // 发出去的链接只会落到一个空页。
  // Featured competition id (§1.3). null hides "Copy competition link": with nothing
  // featured, /c has nowhere to go.
  const [featuredId, setFeaturedId] = useState<string | null>(null)

  // 名单按链接 + 页码拉取；切链接回到第一页。
  // The list is fetched per link + page; switching links resets to page one.
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<AgentLinkUsers | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  // 正在调整会员的那个客户（弹窗开着）。改完就地替换这一行，不重拉整页——
  // 翻到第 3 页改一个人不该把人弹回第 1 页。
  // The client whose membership is being changed. The updated row is patched in
  // place rather than refetching: changing someone on page 3 must not jump back.
  const [editing, setEditing] = useState<AgentLinkUser | null>(null)
  // 搜索词：输入框即时更新，300ms 防抖后才去拉，并回到第一页。
  // Search: the box updates instantly; the fetch waits 300ms and resets to page one.
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => {
    const id = setTimeout(() => {
      setQuery(search.trim())
      setOffset(0)
    }, 300)
    return () => clearTimeout(id)
  }, [search])

  useEffect(() => {
    let alive = true
    agentApi
      .links()
      .then((res) => {
        if (!alive) return
        setLinks(res.links)
        setSelectedId((cur) => cur ?? res.links[0]?.id ?? null)
      })
      .catch((err: unknown) => {
        if (alive) setError(localizeApiError(err instanceof Error ? err.message : String(err)))
      })
    return () => {
      alive = false
    }
  }, [])

  // 裸 fetch 公开接口，不走 request()：这是锦上添花的信息，失败就当没有主推比赛；
  // request() 的入口切换、401 登出等副作用不该由它触发。
  // Bare fetch of the public endpoint, not request(): this is optional decoration —
  // failure just means "no featured competition"; request()'s entry-point switching and
  // 401 logout side effects must not be triggered by it.
  useEffect(() => {
    let alive = true
    fetch(`${API_BASE}/api/public/competitions/featured`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: unknown) => {
        const id = data && typeof data === 'object' ? (data as { id?: unknown }).id : null
        if (alive) setFeaturedId(typeof id === 'string' && id ? id : null)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!selectedId) return
    let alive = true
    setPage(null)
    setPageError(null)
    agentApi
      .linkUsers(selectedId, { limit: PAGE_SIZE, offset, q: query || undefined })
      .then((res) => {
        if (alive) setPage(res)
      })
      .catch((err: unknown) => {
        if (alive) setPageError(localizeApiError(err instanceof Error ? err.message : String(err)))
      })
    return () => {
      alive = false
    }
  }, [selectedId, offset, query])

  const select = (id: string) => {
    if (id === selectedId) return
    setSelectedId(id)
    setOffset(0)
  }

  const applyUpdated = (updated: AgentLinkUser) => {
    setPage((cur) =>
      cur ? { ...cur, users: cur.users.map((u) => (u.email === updated.email ? updated : u)) } : cur,
    )
    setEditing(null)
  }

  // 两个按钮各自显示「已复制 / 复制失败」，键是 `${which}:${id}`。
  // Each button shows its own copied/failed state, keyed `${which}:${id}`.
  const copy = async (l: AgentLink, which: 'invite' | 'comp') => {
    const key = `${which}:${l.id}`
    try {
      // navigator.clipboard 在非安全上下文整体不存在（同步抛），整段包在 try 里。
      // navigator.clipboard is absent outside secure contexts and throws synchronously.
      await navigator.clipboard.writeText(which === 'invite' ? inviteUrl(l.code) : agentCompetitionUrl(l.code))
      setCopiedId(key)
      setTimeout(() => setCopiedId(null), 2000)
    } catch {
      setCopiedId(`err:${key}`)
      setTimeout(() => setCopiedId(null), 2500)
    }
  }

  const copyLabel = (l: AgentLink, which: 'invite' | 'comp') => {
    const key = `${which}:${l.id}`
    if (copiedId === key) return t('agent.copied')
    if (copiedId === `err:${key}`) return t('agent.copyFailed')
    return which === 'invite' ? t('agent.copyInvite') : t('agent.copyCompetition')
  }

  const selected = links?.find((l) => l.id === selectedId) ?? null
  const total = page?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const pageNo = Math.floor(offset / PAGE_SIZE) + 1

  return (
    <div className="mx-auto max-w-6xl">
      <PageHead
        as="h1"
        title={t('agent.title')}
        subtitle={team && !canManage && team.level != null ? t('agent.subtitleReadOnly', { n: team.level }) : t('agent.subtitle')}
        count={tab === 'links' && links && links.length > 1 ? links.length : null}
      />

      {/* 页签：只有确实是代理（team.level 非空）才出现。/ Tabs, only for actual agents. */}
      {team && team.level != null && (
        <div className="mb-4 flex flex-wrap gap-1.5" role="tablist">
          {TABS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              className={segBtn(tab === k)}
              onClick={() => switchTab(k)}
            >
              {t(`agent.tabs.${k}`)}
              {k === 'team' && team.nodes.length > 1 && <span className="num ml-1 opacity-60">{team.nodes.length - 1}</span>}
            </button>
          ))}
        </div>
      )}

      {team && tab === 'team' && (
        <AgentTeamPanel
          team={team}
          onTeamChange={setTeam}
          onShowCustomers={(email) => {
            setCustomerAgent(email)
            switchTab('customers')
          }}
        />
      )}
      {team && tab === 'customers' && (
        <AgentCustomersPanel
          team={team}
          agentFilter={customerAgent}
          onAgentFilterChange={setCustomerAgent}
          onPromoted={loadTeam}
        />
      )}

      {tab === 'links' && (
      <>

      {error && (
        <div className="mb-4 rounded-lg border border-down/40 bg-down/15 px-4 py-2.5 text-sm text-down" role="alert">
          {error}
        </div>
      )}

      {/* 链接卡：一条一张；多条时点卡切换下方名单。加载态只有主体出骨架，页头常驻。
          One card per link; with several, clicking a card switches the list below.
          Only the body shows a skeleton while loading — the head stays put. */}
      {links == null ? (
        <div className="grid gap-3 sm:grid-cols-2" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="glass space-y-3 p-4">
              <SkeletonLine width="40%" height={14} />
              <SkeletonLine height={12} />
              <SkeletonLine width="60%" height={28} />
            </div>
          ))}
        </div>
      ) : links.length === 0 ? (
        <div className="glass p-8 text-center text-sm text-neutral-500">{t('agent.empty')}</div>
      ) : (
        // 卡是 grid 项：必须 min-w-0，否则 nowrap 的链接 URL 会把整张卡的最小宽度顶到
        // 比手机屏还宽（grid 项默认 min-width:auto 取内容的 min-content）。
        // The card is a grid item and needs min-w-0: otherwise the nowrap URL sets its
        // min-content wider than a phone screen (grid items default to min-width:auto).
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {links.map((l) => {
            const active = l.id === selectedId
            return (
              <div
                key={l.id}
                role={links.length > 1 ? 'button' : undefined}
                tabIndex={links.length > 1 ? 0 : undefined}
                onClick={() => select(l.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    select(l.id)
                  }
                }}
                className={`glass min-w-0 p-4 transition ${
                  links.length > 1 ? 'cursor-pointer' : ''
                } ${active && links.length > 1 ? 'ring-1 ring-prism-400/60' : ''}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-display text-base text-neutral-100">{l.label}</p>
                    <p className="num mt-1 truncate text-xs text-neutral-400">{inviteUrl(l.code)}</p>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                      l.isActive ? 'bg-up/15 text-up' : 'bg-white/5 text-neutral-400'
                    }`}
                  >
                    {l.isActive ? t('agent.active') : t('agent.inactive')}
                  </span>
                </div>
                {/* 四个数字一排：点击 / 注册 / 近 7 日活跃 / 已连 MT5。手机上两列换行，
                    复制按钮自成一行——四个数字挤在按钮旁边会把数字压到看不清。
                    Four numbers in a row, wrapping to two columns on phones; the copy
                    button gets its own row rather than squeezing the figures. */}
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    { label: t('agent.clicks'), value: l.clicks },
                    { label: t('agent.registrations'), value: l.registrations },
                    { label: t('agent.active7d'), value: l.activeUsers7d },
                    { label: t('agent.mt5Users'), value: l.mt5Users },
                  ].map((s) => (
                    <div key={s.label} className="min-w-0">
                      <p className="truncate text-[11px] uppercase tracking-wide text-neutral-500">{s.label}</p>
                      <p className="num text-2xl text-neutral-100">{s.value}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    className="btn-ghost px-3 py-1.5 text-xs"
                    onClick={(e) => {
                      e.stopPropagation()
                      void copy(l, 'invite')
                    }}
                  >
                    {copyLabel(l, 'invite')}
                  </button>
                  {featuredId && (
                    <button
                      type="button"
                      className="btn-ghost px-3 py-1.5 text-xs"
                      onClick={(e) => {
                        e.stopPropagation()
                        void copy(l, 'comp')
                      }}
                    >
                      {copyLabel(l, 'comp')}
                    </button>
                  )}
                </div>
                <OpenAccountLinkEditor
                  link={l}
                  onSaved={(updated) =>
                    setLinks((cur) => (cur ? cur.map((x) => (x.id === updated.id ? updated : x)) : cur))
                  }
                />
              </div>
            )
          })}
        </div>
      )}

      {links && links.length > 0 && (
        <div className="mt-3 space-y-1 text-xs leading-relaxed text-neutral-500">
          <p>{t('agent.clicksNote')}</p>
          <p>{t('agent.statsNote')}</p>
          <p>{t('agent.mt5Note')}</p>
          {featuredId && <p>{t('agent.competitionLinkNote')}</p>}
        </div>
      )}

      {/* 看板跟着选中的链接走，与下方名单同一条链接——点哪张卡，两块一起切。
          The dashboard follows the selected link, same as the list below. */}
      {selected && <AgentOverviewPanel linkId={selected.id} />}

      {/* 名单：桌面表格、手机卡片（两棵 DOM，按断点切换）。
          The list: a table on desktop, cards on phones. */}
      {selected && (
        <section className="mt-6">
          <PageHead
            title={t('agent.usersTitle')}
            subtitle={selected.label}
            count={page ? page.total : null}
            countUnit={t('agent.totalUnit')}
          />

          {pageError && (
            <div className="mb-4 rounded-lg border border-down/40 bg-down/15 px-4 py-2.5 text-sm text-down" role="alert">
              {pageError}
            </div>
          )}

          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('agent.searchPlaceholder')}
            aria-label={t('agent.searchPlaceholder')}
            maxLength={128}
            className="mb-3 w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-white/30 focus:outline-none sm:max-w-xs"
          />

          <div className="glass p-0">
            {page == null && !pageError ? (
              <div className="space-y-2 p-4" aria-busy="true">
                <SkeletonLine height={16} />
                <SkeletonLine width="66%" height={16} />
                <SkeletonLine width="80%" height={16} />
              </div>
            ) : page && page.users.length === 0 ? (
              <div className="p-8 text-center text-sm text-neutral-500">
                {t(query ? 'agent.searchEmpty' : 'agent.usersEmpty')}
              </div>
            ) : page ? (
              <>
                <div className="hidden overflow-x-auto sm:block">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-white/10 text-xs uppercase tracking-wide text-neutral-500">
                        <th className="px-4 py-3 font-medium">{t('agent.colUser')}</th>
                        <th className="px-4 py-3 font-medium">{t('agent.colPlan')}</th>
                        <th className="px-4 py-3 font-medium">{t('agent.colMt5')}</th>
                        <th className="px-4 py-3 font-medium">{t('agent.colActive')}</th>
                        <th className="px-4 py-3 font-medium">{t('agent.colRegistered')}</th>
                        {canManage && <th className="px-4 py-3 font-medium text-right">{t('agent.colAction')}</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {page.users.map((u, i) => (
                        <tr key={`${u.email}-${i}`} className="border-b border-white/5 last:border-0">
                          <td className="px-4 py-3">
                            <span className="block text-neutral-100">
                              {u.nickname || <span className="text-neutral-500">{t('agent.noNickname')}</span>}
                            </span>
                            <span className="num block break-all text-xs text-neutral-400">{u.email}</span>
                          </td>
                          <td className="px-4 py-3">
                            <PlanCell user={u} />
                          </td>
                          <td className="px-4 py-3 text-xs">
                            <Mt5List accounts={u.mt5Accounts} />
                          </td>
                          <td className="px-4 py-3 text-xs">
                            <LastActive day={u.lastActiveDay} />
                          </td>
                          <td className="num whitespace-nowrap px-4 py-3 text-xs text-neutral-400">
                            {fmtDate(u.createdAt)}
                          </td>
                          {canManage && (
                            <td className="px-4 py-3 text-right">
                              <button
                                type="button"
                                className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-40"
                                disabled={u.plan === 'PRO' && !u.planExpiresAt}
                                onClick={() => setEditing(u)}
                              >
                                {t('agent.plan.adjust')}
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="divide-y divide-white/5 sm:hidden">
                  {page.users.map((u, i) => (
                    <li key={`${u.email}-${i}`} className="px-4 py-3">
                      {/* 右上角只留等级徽标。两个时间以前裸着叠在这里，没有表头也没有
                          标签，「至 31/12」和「15/09 04:48」分不清谁是到期谁是注册——
                          全部挪进下面带标签的行里。
                          Only the tier badge sits top-right now. The two timestamps used
                          to stack here unlabelled, with no table header to tell them
                          apart; they moved into the labelled rows below. */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-neutral-100">
                            {u.nickname || <span className="text-neutral-500">{t('agent.noNickname')}</span>}
                          </p>
                          <p className="num break-all text-xs text-neutral-400">{u.email}</p>
                        </div>
                        <PlanBadge plan={u.plan} />
                      </div>
                      {planExpiryText(u, t) && (
                        <CardRow label={t('agent.colExpiry')}>
                          <span className="num text-neutral-300">{planExpiryText(u, t)}</span>
                        </CardRow>
                      )}
                      <CardRow label={t('agent.colActive')}>
                        <LastActive day={u.lastActiveDay} />
                      </CardRow>
                      <CardRow label={t('agent.colRegistered')}>
                        <span className="num text-neutral-400">{fmtDate(u.createdAt)}</span>
                      </CardRow>
                      <CardRow label={t('agent.colMt5')}>
                        <Mt5List accounts={u.mt5Accounts} />
                      </CardRow>
                      {canManage && (
                        <button
                          type="button"
                          className="btn-ghost mt-2 w-full py-1.5 text-xs disabled:opacity-40"
                          disabled={u.plan === 'PRO' && !u.planExpiresAt}
                          onClick={() => setEditing(u)}
                        >
                          {t('agent.plan.adjust')}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                {pages > 1 && (
                  <div className="flex items-center justify-between gap-3 border-t border-white/10 px-4 py-3 text-xs text-neutral-400">
                    <button
                      type="button"
                      className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-40"
                      disabled={offset === 0}
                      onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                    >
                      {t('agent.prev')}
                    </button>
                    <span className="num">{t('agent.pageOf', { page: pageNo, pages })}</span>
                    <button
                      type="button"
                      className="btn-ghost px-3 py-1.5 text-xs disabled:opacity-40"
                      disabled={offset + PAGE_SIZE >= total}
                      onClick={() => setOffset(offset + PAGE_SIZE)}
                    >
                      {t('agent.next')}
                    </button>
                  </div>
                )}
              </>
            ) : null}
          </div>
        </section>
      )}

      </>
      )}

      {editing && selected && (
        <PlanDialog
          linkId={selected.id}
          user={editing}
          onDone={applyUpdated}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
