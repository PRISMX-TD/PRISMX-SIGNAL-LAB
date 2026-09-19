// 代理页（/agent）：管理员把邀请链接指派给某个用户后，该用户在这里看到名下每条
// 链接的点击数、注册人数、近 7 日活跃人数、已连 MT5 人数与状态，以及经它注册的
// 用户名单（含各人的最近活跃日与 MT5 绑定）。全程只读——后端 /agent/* 没有任何
// 写端点，名单里也没有手机号与用户 id（见后端 AgentLinkUserOut）。
// 两条口径不在这里算，全部由后端给：活跃 = page_visitor_days 里有行（到天为止，
// 没有时刻也没有时长），MT5 账户号是后端打好码的。前端只负责显示，别在这里补
// 任何"推算"——一推算就会和管理看板的数字对不上。
// 「代理」不是角色：入口由 /auth/me 的 isAgent 派生（至少持有一条被指派的链接），
// role 与权益都不动。链接 URL 拼 ORIGIN 而不是 window.location.origin，理由同
// 管理面板（预览域名上复制出去的仍要是正式域名）。
// Agent view (/agent): after an admin assigns invite links to a user, they see
// each link's clicks, signups and status here, plus the list of users who
// registered through it. Read-only end to end — /agent/* has no write endpoint
// and the list carries no phone or user id (see AgentLinkUserOut).
// "Agent" is not a role: the entry is derived from /auth/me's isAgent; role and
// entitlements are untouched. URLs are built from ORIGIN for the same reason as
// the admin panel.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import PageHead from '../components/PageHead'
import { SkeletonLine } from '../components/Skeleton'
import { agentApi } from '../api/client'
import { fmtTime, localizeApiError } from '../api/utils'
import { ORIGIN } from '../seo/meta'
import { useDocumentTitle } from '../utils/useDocumentTitle'
import type { AgentLink, AgentLinkUsers, AgentMT5Account } from '../api/types'

const PAGE_SIZE = 50
const linkUrl = (code: string) => `${ORIGIN}/?ref=${code}`

// 「近 7 日」的分界日。后端给的 lastActiveDay 是北京时间的日历日字符串
// （YYYY-MM-DD），所以这里也按北京时间取当天，再直接比字符串——ISO 日期按
// 字典序比就是按时间比，不用解析成 Date（解析会把它当 UTC 零点再偏一次时区）。
// Cut-off day for "last 7 days". lastActiveDay is a Beijing-time calendar date
// string, so this one is too, and ISO dates compare correctly as strings —
// parsing them into Date would shift them by a timezone a second time.
const statsDay = (ms: number) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
const isRecentDay = (day: string) => day >= statsDay(Date.now() - 6 * 86_400_000)

const MT5_TYPE_KEY = { real: 'agent.mt5Real', demo: 'agent.mt5Demo', contest: 'agent.mt5Contest' } as const

// 一条绑定此刻怎么说。分通道，因为「还连着吗」在两条通道上根本不是一回事：
// 直连由平台与券商保持连接，用户不用开电脑，压根没有"最近连接时间"这个概念
// （后端也不写心跳）；桥接要用户电脑上的程序在跑，离线时说"上次是什么时候"
// 才有意义。首版对两条通道一视同仁地读心跳，于是每个直连账号都显示「从未连接」。
// What one binding says right now, per channel — "still connected?" is not the
// same question on the two. A gateway binding is held by the platform and has no
// last-seen concept at all (no heartbeat is ever written); a bridge binding is up
// only while the user's desktop app runs, so its last-seen time is worth saying.
// The first cut read the heartbeat on both and called every gateway account
// "never connected".
type TFn = ReturnType<typeof useTranslation>['t']

function connectionText(a: AgentMT5Account, t: TFn): string {
  if (a.online) return t('agent.mt5Online')
  if (a.channel === 'gateway') return t('agent.mt5Offline')
  if (a.lastConnectedAt) return t('agent.mt5Last', { time: fmtTime(a.lastConnectedAt) })
  return t('agent.mt5Never')
}

function LastActive({ day }: { day: string | null }) {
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

// MT5 绑定：打码账号 + 实盘/模拟 + 服务器 + 最近连接。撤销的绑定照样列出并标
// 「需重连」——代理看见"绑过但掉了"才知道要去提醒人重新验证。
// One MT5 binding per line: masked login, real/demo, server, last seen. Revoked
// ones are listed and flagged rather than hidden, so the agent can nudge.
function Mt5List({ accounts }: { accounts: AgentMT5Account[] }) {
  const { t } = useTranslation()
  if (accounts.length === 0) return <span className="text-neutral-500">{t('agent.mt5None')}</span>
  return (
    <ul className="space-y-1.5">
      {accounts.map((a, i) => (
        <li key={`${a.login}-${i}`} className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="num text-neutral-100">{a.login}</span>
            <span
              className={`rounded-full px-1.5 py-0.5 text-[11px] ${
                a.accountType === 'real' ? 'bg-up/15 text-up' : 'bg-white/5 text-neutral-400'
              }`}
            >
              {t(a.accountType ? MT5_TYPE_KEY[a.accountType] : 'agent.mt5Unknown')}
            </span>
            {a.revoked && (
              <span className="rounded-full bg-down/15 px-1.5 py-0.5 text-[11px] text-down">
                {t('agent.mt5Revoked')}
              </span>
            )}
          </div>
          {/* 不用 truncate：手机上这一列很窄，截断正好把"最近连接什么时候"这半句
              吃掉，等于这行白写。让它换行，桌面上宽度够时仍是一行。
              No truncate: on a phone this column is narrow and truncation eats
              exactly the half that carries the time. Wrapping costs one line on
              a phone and nothing on desktop. */}
          <p className="break-words text-[11px] text-neutral-500">
            {a.server ? `${a.server} · ` : ''}
            {t(a.channel === 'gateway' ? 'agent.mt5Gateway' : 'agent.mt5Bridge')} ·{' '}
            <span className={a.online ? 'text-up' : undefined}>{connectionText(a, t)}</span>
          </p>
        </li>
      ))}
    </ul>
  )
}

export default function AgentPage() {
  const { t } = useTranslation()
  useDocumentTitle(t('agent.title'))

  const [links, setLinks] = useState<AgentLink[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // 名单按链接 + 页码拉取；切链接回到第一页。
  // The list is fetched per link + page; switching links resets to page one.
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState<AgentLinkUsers | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)

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

  useEffect(() => {
    if (!selectedId) return
    let alive = true
    setPage(null)
    setPageError(null)
    agentApi
      .linkUsers(selectedId, { limit: PAGE_SIZE, offset })
      .then((res) => {
        if (alive) setPage(res)
      })
      .catch((err: unknown) => {
        if (alive) setPageError(localizeApiError(err instanceof Error ? err.message : String(err)))
      })
    return () => {
      alive = false
    }
  }, [selectedId, offset])

  const select = (id: string) => {
    if (id === selectedId) return
    setSelectedId(id)
    setOffset(0)
  }

  const copy = async (l: AgentLink) => {
    try {
      // navigator.clipboard 在非安全上下文整体不存在（同步抛），整段包在 try 里。
      // navigator.clipboard is absent outside secure contexts and throws synchronously.
      await navigator.clipboard.writeText(linkUrl(l.code))
      setCopiedId(l.id)
      setTimeout(() => setCopiedId(null), 2000)
    } catch {
      setCopiedId(`err:${l.id}`)
      setTimeout(() => setCopiedId(null), 2500)
    }
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
        subtitle={t('agent.subtitle')}
        count={links && links.length > 1 ? links.length : null}
      />

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
                    <p className="num mt-1 truncate text-xs text-neutral-400">{linkUrl(l.code)}</p>
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
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    className="btn-ghost px-3 py-1.5 text-xs"
                    onClick={(e) => {
                      e.stopPropagation()
                      void copy(l)
                    }}
                  >
                    {copiedId === l.id
                      ? t('agent.copied')
                      : copiedId === `err:${l.id}`
                        ? t('agent.copyFailed')
                        : t('agent.copy')}
                  </button>
                </div>
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
        </div>
      )}

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

          <div className="glass p-0">
            {page == null && !pageError ? (
              <div className="space-y-2 p-4" aria-busy="true">
                <SkeletonLine height={16} />
                <SkeletonLine width="66%" height={16} />
                <SkeletonLine width="80%" height={16} />
              </div>
            ) : page && page.users.length === 0 ? (
              <div className="p-8 text-center text-sm text-neutral-500">{t('agent.usersEmpty')}</div>
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
                            <span
                              className={`rounded-full px-2 py-0.5 text-xs ${
                                u.plan === 'PRO' ? 'bg-prism-500/20 text-prism-200' : 'bg-white/5 text-neutral-400'
                              }`}
                            >
                              {u.plan}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs">
                            <Mt5List accounts={u.mt5Accounts} />
                          </td>
                          <td className="px-4 py-3 text-xs">
                            <LastActive day={u.lastActiveDay} />
                          </td>
                          <td className="num whitespace-nowrap px-4 py-3 text-xs text-neutral-400">
                            {fmtTime(u.createdAt)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="divide-y divide-white/5 sm:hidden">
                  {page.users.map((u, i) => (
                    <li key={`${u.email}-${i}`} className="px-4 py-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm text-neutral-100">
                            {u.nickname || <span className="text-neutral-500">{t('agent.noNickname')}</span>}
                          </p>
                          <p className="num break-all text-xs text-neutral-400">{u.email}</p>
                        </div>
                        <div className="shrink-0 text-right">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${
                              u.plan === 'PRO' ? 'bg-prism-500/20 text-prism-200' : 'bg-white/5 text-neutral-400'
                            }`}
                          >
                            {u.plan}
                          </span>
                          <p className="num mt-1 text-[11px] text-neutral-500">{fmtTime(u.createdAt)}</p>
                        </div>
                      </div>
                      {/* 手机上活跃与 MT5 换行放下面：右侧那一列已经被等级与注册时间占满，
                          再塞就只能压成两三个字。
                          On phones activity and MT5 go on their own rows — the right column
                          is already taken by tier and signup time. */}
                      <div className="mt-2 flex items-baseline gap-2 text-xs">
                        <span className="shrink-0 text-[11px] uppercase tracking-wide text-neutral-500">
                          {t('agent.colActive')}
                        </span>
                        <LastActive day={u.lastActiveDay} />
                      </div>
                      <div className="mt-1.5 flex items-baseline gap-2 text-xs">
                        <span className="shrink-0 text-[11px] uppercase tracking-wide text-neutral-500">
                          {t('agent.colMt5')}
                        </span>
                        <div className="min-w-0">
                          <Mt5List accounts={u.mt5Accounts} />
                        </div>
                      </div>
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
    </div>
  )
}
