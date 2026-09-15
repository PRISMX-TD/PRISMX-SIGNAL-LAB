// 代理页（/agent）：管理员把邀请链接指派给某个用户后，该用户在这里看到名下每条
// 链接的点击数、注册人数、状态，以及经它注册的用户名单。全程只读——后端 /agent/*
// 没有任何写端点，名单里也没有手机号、完整邮箱与 id（见后端 AgentLinkUserOut）。
// 「代理」不是角色：入口由 /auth/me 的 isAgent 派生（至少持有一条被指派的链接），
// role 与权益都不动。链接 URL 拼 ORIGIN 而不是 window.location.origin，理由同
// 管理面板（预览域名上复制出去的仍要是正式域名）。
// Agent view (/agent): after an admin assigns invite links to a user, they see
// each link's clicks, signups and status here, plus the list of users who
// registered through it. Read-only end to end — /agent/* has no write endpoint
// and the list carries no phone, full email or id (see AgentLinkUserOut).
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
import type { AgentLink, AgentLinkUsers } from '../api/types'

const PAGE_SIZE = 50
const linkUrl = (code: string) => `${ORIGIN}/?ref=${code}`

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
    <div className="mx-auto max-w-5xl">
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
                <div className="mt-4 flex items-end justify-between gap-3">
                  <div className="flex gap-6">
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-neutral-500">{t('agent.clicks')}</p>
                      <p className="num text-2xl text-neutral-100">{l.clicks}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-neutral-500">{t('agent.registrations')}</p>
                      <p className="num text-2xl text-neutral-100">{l.registrations}</p>
                    </div>
                  </div>
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
        <p className="mt-3 text-xs leading-relaxed text-neutral-500">{t('agent.clicksNote')}</p>
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
                        <th className="px-4 py-3 font-medium">{t('agent.colRegistered')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {page.users.map((u, i) => (
                        <tr key={`${u.emailMasked}-${i}`} className="border-b border-white/5 last:border-0">
                          <td className="px-4 py-3">
                            <span className="block text-neutral-100">
                              {u.nickname || <span className="text-neutral-500">{t('agent.noNickname')}</span>}
                            </span>
                            <span className="num block text-xs text-neutral-500">{u.emailMasked}</span>
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
                          <td className="num px-4 py-3 text-xs text-neutral-400">{fmtTime(u.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="divide-y divide-white/5 sm:hidden">
                  {page.users.map((u, i) => (
                    <li key={`${u.emailMasked}-${i}`} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-neutral-100">
                          {u.nickname || <span className="text-neutral-500">{t('agent.noNickname')}</span>}
                        </p>
                        <p className="num truncate text-xs text-neutral-500">{u.emailMasked}</p>
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
