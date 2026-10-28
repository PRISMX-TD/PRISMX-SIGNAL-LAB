// 代理页（/agent）：管理员把邀请链接指派给某个用户后，该用户在这里看到名下每条
// 链接的点击数、注册人数、近 7 日活跃人数、已连 MT5 人数与状态，以及经它注册的
// 用户名单（含各人的最近活跃日与 MT5 绑定）。写操作只有两个：调整名下客户的会员
// （PlanDialog）与设置自己链接的开户链接（OpenAccountLinkEditor）；名单里没有手机号与
// 用户 id（见后端 AgentLinkUserOut）。
// 两条口径不在这里算，全部由后端给：活跃 = page_visitor_days 里有行（到天为止，
// 没有时刻也没有时长），MT5 账户号是后端打好码的。前端只负责显示，别在这里补
// 任何"推算"——一推算就会和管理看板的数字对不上。
// rev 50 起每条链接的名单走 /agent/customers?link=：来源是这条链接、此刻仍归我或我下级的人。
// 「代理」不是角色：入口由 /auth/me 的 isAgent 派生（在代理树上有节点），
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
// 手机返回能回到上一个页签。一级代理（/agent/team 的 canManage）整棵树升代理、撤代理；二级起除最后
// 一级（canPromote）只能升自己的直属客户；改会员看
// 管理员给的权限（canSetPlan，rev 51，与层级无关）——「我的链接」名单里的「调整会员」按钮也按它藏。
// rev 47 agent hierarchy: three tabs under the header — My links (above), Team
// (AgentTeamPanel) and All customers (AgentCustomersPanel), kept in ?tab= so the back
// gesture returns to the previous tab. Top-level agents (canManage) promote tree-wide and
// revoke; lower ones but the last (canPromote) promote their own direct clients only;
// changing plans follows the admin-granted canSetPlan (rev 51), per-link button included.
// 2026-10-28「代理」改名「推荐官」，页面按私行黑卡的语言重画：页头是推荐官凭证卡 + 团队核心数字
// （components/agent/AgentHero），页签是三格分区导航；链接卡做成一张票：上半是推荐码与复制，
// 下半隔一道齿孔是开户链接（只有一条链接时桌面上左右两栏）。几条口径说明收进「数据口径」折叠框，
// 看板与名单各有分区标题。样式在 styles/agent.css（只随本页加载）。路由 /agent 与接口都不变。
// Renamed "agent" → "ambassador" on 2026-10-28 and redrawn in a black-card language:
// the head is a credential card plus key team figures (AgentHero), the tabs a three-cell
// section rail; each link card is a ticket (code and copy above, the open-account link on a
// perforated stub below, two columns on desktop when there is a single link). The fine print
// folds into a "how these are counted" panel; the dashboard and the list get section heads.
// Styles in styles/agent.css (loaded with this page only). Route and API are unchanged.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { SkeletonLine } from '../components/Skeleton'
import AgentCustomersPanel from '../components/agent/AgentCustomersPanel'
import AgentHero from '../components/agent/AgentHero'
import AgentOverviewPanel from '../components/agent/AgentOverviewPanel'
import AgentTeamPanel from '../components/agent/AgentTeamPanel'
import PlanDialog from '../components/agent/PlanDialog'
import OpenAccountLinkEditor from '../components/agent/OpenAccountLinkEditor'
import { API_BASE, agentApi } from '../api/client'
import { fmtDate, localizeApiError } from '../api/utils'
import {
  EmptyState,
  Fact,
  LastActive,
  Mt5List,
  Pager,
  Person,
  PlanBadge,
  PlanCell,
  SearchBox,
  SectionHead,
  planExpiryText,
} from '../components/agent/customerCells'
import { IconCheck, IconChevron, IconCopy, IconInfo } from '../components/agent/agentIcons'
import { agentCompetitionUrl, inviteUrl } from '../utils/promoLinkUrl'
import { useDocumentTitle } from '../utils/useDocumentTitle'
import type { AgentLink, AgentLinkUser, AgentLinkUsers, AgentTeam } from '../api/types'
import '../styles/agent.css'

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
  // 团队接口第一次有了结果（成功或失败）。页头在此之前只出骨架。
  // The team call has settled once, either way; the head shows a skeleton until then.
  const [teamReady, setTeamReady] = useState(false)
  const canManage = team?.canManage ?? false
  const canSetPlan = team?.canSetPlan ?? false
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
      .finally(() => setTeamReady(true))
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
      .customers({ link: selectedId, limit: PAGE_SIZE, offset, q: query || undefined })
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

  const copyIcon = (l: AgentLink, which: 'invite' | 'comp') =>
    copiedId === `${which}:${l.id}` ? <IconCheck size={15} /> : <IconCopy size={15} />

  const selected = links?.find((l) => l.id === selectedId) ?? null
  const total = page?.total ?? 0

  return (
    <div className="agt-page mx-auto max-w-6xl">
      <AgentHero
        team={team}
        teamReady={teamReady}
        links={links}
        subtitle={
          !team?.isAgent || canSetPlan
            ? t('agent.subtitle')
            : canManage
              ? t('agent.subtitleNoPlan')
              : team.canPromote
                ? t('agent.subtitlePromote')
                : t('agent.subtitleReadOnly')
        }
      />

      {/* 页签：只有确实在推荐官树上（isAgent）才出现。三格等宽的分区导航：编号、名字、
          数量、一句说明（手机上收起说明）。数量都与页签里的内容同口径：链接条数；下级推荐官
          人数；全部客户 = 团队客户 + 下级推荐官本人（名单就是这两类人，见后端 scope_filter）。
          Tabs, only for ambassadors in the tree: three equal cells with an index, the
          name, a count and a one-line description (hidden on phones). Each count matches
          its tab's content: links; downline ambassadors; all customers = team customers
          plus the downline ambassadors themselves (exactly who the list holds). */}
      {team?.isAgent && (
        <div className="agt-tabs" role="tablist">
          {TABS.map((k, i) => {
            const self = team.nodes.find((n) => n.isSelf)
            const downline = Math.max(0, team.nodes.length - 1)
            const count =
              k === 'links' ? (links?.length ?? null) : k === 'team' ? downline : self ? self.teamCustomers + downline : null
            return (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                className={`agt-tab${tab === k ? ' is-on' : ''}`}
                onClick={() => switchTab(k)}
              >
                <span className="agt-tab-index num" aria-hidden="true">
                  {`0${i + 1}`}
                </span>
                <span className="agt-tab-head">
                  <span className="agt-tab-label">{t(`agent.tabs.${k}`)}</span>
                  {count != null && <span className="agt-tab-count num">{count.toLocaleString('en-US')}</span>}
                </span>
                <span className="agt-tab-desc">{t(`agent.tabDesc.${k}`)}</span>
              </button>
            )
          })}
        </div>
      )}

      {team && tab === 'team' && (
        <div className="agt-panel" key="team">
          <AgentTeamPanel
            team={team}
            onTeamChange={setTeam}
            onShowCustomers={(email) => {
              setCustomerAgent(email)
              switchTab('customers')
            }}
          />
        </div>
      )}
      {team && tab === 'customers' && (
        <div className="agt-panel" key="customers">
          <AgentCustomersPanel
            team={team}
            agentFilter={customerAgent}
            onAgentFilterChange={setCustomerAgent}
            onPromoted={loadTeam}
          />
        </div>
      )}

      {tab === 'links' && (
        <div className="agt-panel" key="links">
          {error && (
            <div className="mb-4 rounded-lg border border-down/40 bg-down/15 px-4 py-2.5 text-sm text-down" role="alert">
              {error}
            </div>
          )}

          {/* 链接卡：一条一张；多条时两列、点卡切换下方看板与名单，只有一条时整行宽、桌面上左右分栏。
              加载态只有主体出骨架，页头常驻。
              One card per link: two columns when there are several (click to switch the
              dashboard and list below), full width and split in two on desktop when there is
              one. Only the body shows a skeleton while loading; the head stays put. */}
          {links == null ? (
            <div className="agt-links is-single" aria-busy="true">
              <div className="agt-link">
                {/* 包一层：桌面上 body 是两栏网格，三条骨架得是同一个格子。
                    One wrapper: on desktop the body is a two-column grid, and the lines must share a cell. */}
                <div className="agt-link-body">
                  <div className="space-y-3">
                    <SkeletonLine width="30%" height={14} />
                    <SkeletonLine width="45%" height={36} />
                    <SkeletonLine height={42} />
                  </div>
                </div>
              </div>
            </div>
          ) : links.length === 0 ? (
            <div className="agt-sheet">
              <EmptyState text={t('agent.empty')} />
            </div>
          ) : (
            // 卡是 grid 项：必须 min-w-0，否则 nowrap 的链接 URL 会把整张卡的最小宽度顶到
            // 比手机屏还宽（grid 项默认 min-width:auto 取内容的 min-content）。.agt-link 自带。
            // The card is a grid item and needs min-width 0: otherwise the nowrap URL sets its
            // min-content wider than a phone screen. .agt-link carries it.
            <div className={`agt-links ${links.length > 1 ? 'is-multi' : 'is-single'}`}>
              {links.map((l, i) => {
                const pickable = links.length > 1
                const active = pickable && l.id === selectedId
                return (
                  <div
                    key={l.id}
                    role={pickable ? 'button' : undefined}
                    tabIndex={pickable ? 0 : undefined}
                    aria-pressed={pickable ? active : undefined}
                    onClick={() => select(l.id)}
                    onKeyDown={(e) => {
                      // 只认卡片自己的按键：卡里的复制按钮、开户链接输入框冒上来的回车 / 空格要留给它们自己。
                      // Only the card's own keys: Enter/Space from the copy buttons or the link input inside stay theirs.
                      if (e.target !== e.currentTarget) return
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        select(l.id)
                      }
                    }}
                    className={`agt-link${pickable ? ' is-pickable' : ''}${active ? ' is-active' : ''}`}
                    style={{ '--i': i } as React.CSSProperties}
                  >
                    <div className="agt-link-body">
                      <div className="agt-link-main">
                        <div className="agt-link-head">
                          <p className="agt-link-label">{l.label}</p>
                          <span className={`agt-chip${l.isActive ? ' is-on' : ''}`}>
                            {l.isActive ? t('agent.active') : t('agent.inactive')}
                          </span>
                        </div>
                        {/* 推荐码放大：当面报给别人、对着屏幕抄都靠它；完整链接退到下面一行。
                            The code is the hero: it gets read out and copied by eye; the full URL sits below. */}
                        <div className="agt-link-code">
                          <span className="agt-link-code-label">{t('agent.hero.code')}</span>
                          <span className="agt-link-code-value num">{l.code}</span>
                          <span className="agt-link-url num">{inviteUrl(l.code)}</span>
                        </div>
                        <div className={`agt-link-actions${featuredId ? ' has-two' : ''}`}>
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={(e) => {
                              e.stopPropagation()
                              void copy(l, 'invite')
                            }}
                          >
                            {copyIcon(l, 'invite')}
                            <span>{copyLabel(l, 'invite')}</span>
                          </button>
                          {featuredId && (
                            <button
                              type="button"
                              className="btn btn-ghost"
                              onClick={(e) => {
                                e.stopPropagation()
                                void copy(l, 'comp')
                              }}
                            >
                              {copyIcon(l, 'comp')}
                              <span>{copyLabel(l, 'comp')}</span>
                            </button>
                          )}
                        </div>
                      </div>
                      {/* 四个数字：点击 / 注册 / 近 7 日活跃 / 已连 MT5。窄卡里一排四格（手机两列），
                          整行宽的单卡在桌面上是右栏的 2×2 发丝线格。
                          Four figures: a row of four in a narrow card (two columns on phones), a 2×2
                          hairline grid in the right column of a full-width single card on desktop. */}
                      <dl className="agt-link-stats">
                        {[
                          { label: t('agent.clicks'), value: l.clicks },
                          { label: t('agent.registrations'), value: l.registrations },
                          { label: t('agent.active7d'), value: l.activeUsers7d },
                          { label: t('agent.mt5Users'), value: l.mt5Users },
                        ].map((s) => (
                          <div key={s.label}>
                            <dt>{s.label}</dt>
                            <dd className="num">{s.value.toLocaleString('en-US')}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                    {/* 票根：一道齿孔隔开，下面是这条链接的开户链接设置。
                        The stub, past a perforation: this link's open-account setting. */}
                    <div className="agt-link-stub">
                      <OpenAccountLinkEditor
                        link={l}
                        onSaved={(updated) =>
                          setLinks((cur) => (cur ? cur.map((x) => (x.id === updated.id ? updated : x)) : cur))
                        }
                      />
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* 口径说明收进折叠框：默认收起，要看的人点开。/ The fine print folds away until opened. */}
          {links && links.length > 0 && (
            <details className="agt-fine">
              <summary>
                <IconInfo size={15} />
                <span>{t('agent.notesTitle')}</span>
                <span className="agt-fine-chev">
                  <IconChevron size={15} />
                </span>
              </summary>
              <ul>
                <li>{t('agent.clicksNote')}</li>
                <li>{t('agent.statsNote')}</li>
                <li>{t('agent.mt5Note')}</li>
                {featuredId && <li>{t('agent.competitionLinkNote')}</li>}
              </ul>
            </details>
          )}

          {/* 看板跟着选中的链接走，与下方名单同一条链接——点哪张卡，两块一起切。
              The dashboard follows the selected link, same as the list below. */}
          {selected && (
            <AgentOverviewPanel linkId={selected.id} linkLabel={links && links.length > 1 ? selected.label : null} />
          )}

          {/* 名单：桌面表格、手机卡片（两棵 DOM，按断点切换）。
              The list: a table on desktop, cards on phones. */}
          {selected && (
            <section className="agt-sec">
              <SectionHead
                title={t('agent.usersTitle')}
                count={page ? page.total : null}
                sub={selected.label}
                tools={<SearchBox value={search} onChange={setSearch} />}
              />

              {pageError && (
                <div className="mb-4 rounded-lg border border-down/40 bg-down/15 px-4 py-2.5 text-sm text-down" role="alert">
                  {pageError}
                </div>
              )}

              <div className="agt-sheet">
                {page == null && !pageError ? (
                  <div className="space-y-3 p-5" aria-busy="true">
                    <SkeletonLine height={16} />
                    <SkeletonLine width="66%" height={16} />
                    <SkeletonLine width="80%" height={16} />
                  </div>
                ) : page && page.users.length === 0 ? (
                  <EmptyState text={t(query ? 'agent.searchEmpty' : 'agent.usersEmpty')} />
                ) : page ? (
                  <>
                    <div className="hidden overflow-x-auto sm:block">
                      <table className="agt-table">
                        <thead>
                          <tr>
                            <th>{t('agent.colUser')}</th>
                            <th>{t('agent.colPlan')}</th>
                            <th>{t('agent.colMt5')}</th>
                            <th>{t('agent.colActive')}</th>
                            <th>{t('agent.colRegistered')}</th>
                            {canSetPlan && <th className="is-act">{t('agent.colAction')}</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {page.users.map((u, i) => (
                            <tr key={`${u.email}-${i}`}>
                              <td>
                                <Person nickname={u.nickname} email={u.email} />
                              </td>
                              <td>
                                <PlanCell user={u} />
                              </td>
                              <td className="is-small">
                                <Mt5List accounts={u.mt5Accounts} />
                              </td>
                              <td className="is-small">
                                <LastActive day={u.lastActiveDay} />
                              </td>
                              <td className="is-date num">{fmtDate(u.createdAt)}</td>
                              {canSetPlan && (
                                <td className="is-act">
                                  <button
                                    type="button"
                                    className="btn btn-ghost"
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
                    {/* 手机卡：人和等级在上，下面一块事实格（每个时间都带标签），MT5 独占一行。
                        Phone card: person and tier on top, then a fact grid (every time labelled),
                        MT5 on its own row. */}
                    <ul className="agt-mlist sm:hidden">
                      {page.users.map((u, i) => (
                        <li key={`${u.email}-${i}`} className="agt-mcard">
                          <div className="agt-mcard-top">
                            <Person nickname={u.nickname} email={u.email} />
                            <PlanBadge plan={u.plan} />
                          </div>
                          <dl className="agt-facts">
                            <Fact label={t('agent.colActive')}>
                              <LastActive day={u.lastActiveDay} />
                            </Fact>
                            <Fact label={t('agent.colRegistered')}>
                              <span className="num">{fmtDate(u.createdAt)}</span>
                            </Fact>
                            {planExpiryText(u, t) && (
                              <Fact label={t('agent.colExpiry')} wide>
                                <span className="num">{planExpiryText(u, t)}</span>
                              </Fact>
                            )}
                            <Fact label={t('agent.colMt5')} wide>
                              <Mt5List accounts={u.mt5Accounts} />
                            </Fact>
                          </dl>
                          {canSetPlan && (
                            <div className="agt-mcard-acts">
                              <button
                                type="button"
                                className="btn btn-ghost"
                                disabled={u.plan === 'PRO' && !u.planExpiresAt}
                                onClick={() => setEditing(u)}
                              >
                                {t('agent.plan.adjust')}
                              </button>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                    {total > PAGE_SIZE && (
                      <Pager offset={offset} pageSize={PAGE_SIZE} total={total} onChange={setOffset} />
                    )}
                  </>
                ) : null}
              </div>
            </section>
          )}
        </div>
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
