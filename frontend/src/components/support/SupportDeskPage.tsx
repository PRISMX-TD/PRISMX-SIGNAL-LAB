// 客服后台 /support-desk（设计 §9）：客服与管理员共用。两个子页面各有自己的地址和排版：
//   /support-desk/tickets[/<工单号>]       工单：队列 | 会话 | 提交人资料（≥1280 三栏）
//   /support-desk/follow-ups[/<用户 ID>]   我的跟进：客户名单 | 概览或客户工作区
// 本文件只管外壳：页头（身份、客户搜索、子页面切换）、水印、提示条、客户资料抽屉，以及通知
// 深链 ?ticket= / ?followUp= 的跳转。权限全在后端；外包客服整页铺半透明水印（设计 §8）。
// The support console at /support-desk (design §9), shared by agents and admins. Two sub-pages,
// each with its own URL and layout (tickets: queue | thread | submitter; follow-ups: roster |
// overview or customer workspace). This file is the shell only: header (identity, customer
// search, sub-page tabs), watermark, toast, the customer drawer, and the ?ticket= / ?followUp=
// notification deep links. All permissions are server-side; outsourced agents get a watermark.
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { adminApi, supportApi } from '../../api/client'
import type { SupportCustomer, SupportMe } from '../../api/supportTypes'
import { useMediaQuery } from '../../utils/useMediaQuery'
import { useToast } from '../../utils/useToast'
import { SkeletonLine } from '../Skeleton'
import CustomerDrawer from './CustomerDrawer'
import FollowUpsView from './FollowUpsView'
import TicketsView from './TicketsView'
import Watermark from './Watermark'
import { IconSearch } from './deskIcons'
import { Avatar, errText } from './supportUi'
import '../../styles/support-desk.css'

// 两个子页面共用的上下文 / what both sub-pages get from the shell
export interface DeskCtx {
  me: SupportMe
  patchMe: (patch: Partial<SupportMe>) => void
  reloadKey: number
  bump: () => void
  toast: (kind: 'ok' | 'err', text: string) => void
  onError: (text: string) => void
  openCustomer: (userId: string) => void
}

// 待回复数（没人接、没关闭的工单）：页头角标用，前台时 15 秒刷新一次，和队列同频。
// The awaiting-reply count (unclaimed, not closed) for the tab badge, refreshed every 15s while visible.
const POLL_MS = 15_000

// 通知深链只落在 /support-desk 本身：?ticket= 进工单，?followUp= 换成用户 ID 进跟进，都用 replace。
// Notification deep links land on /support-desk itself; both are resolved with replace.
function DeskIndex({ onError }: { onError: (text: string) => void }) {
  const { t } = useTranslation()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  useEffect(() => {
    const ticket = params.get('ticket')
    const followUp = params.get('followUp')
    if (ticket) {
      navigate(`/support-desk/tickets/${encodeURIComponent(ticket)}`, { replace: true })
      return
    }
    if (!followUp) {
      navigate('/support-desk/tickets', { replace: true })
      return
    }
    let alive = true
    supportApi
      .followUp(followUp)
      .then((r) => { if (alive) navigate(`/support-desk/follow-ups/${encodeURIComponent(r.followUp.userId)}`, { replace: true }) })
      .catch((err) => {
        if (!alive) return
        onError(errText(err, t('common.error')))
        navigate('/support-desk/follow-ups', { replace: true })
      })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

export default function SupportDeskPage() {
  const { t } = useTranslation()
  const [me, setMe] = useState<SupportMe | null>(null)
  const [meErr, setMeErr] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [drawerUser, setDrawerUser] = useState<string | null>(null)
  const [awaiting, setAwaiting] = useState<number | null>(null)
  const [fuTotal, setFuTotal] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<SupportCustomer[] | null>(null)
  const searchRef = useRef<HTMLDivElement>(null)
  const { toast, showToast } = useToast()
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const location = useLocation()
  const navigate = useNavigate()

  const onError = useCallback((text: string) => showToast('err', text), [showToast])
  const bump = useCallback(() => setReloadKey((k) => k + 1), [])
  const patchMe = useCallback((patch: Partial<SupportMe>) => setMe((prev) => (prev ? { ...prev, ...patch } : prev)), [])
  const openCustomer = useCallback((userId: string) => setDrawerUser(userId), [])

  const loadMe = useCallback(() => {
    setMeErr(null)
    supportApi.me().then(setMe).catch((err) => setMeErr(errText(err, t('common.error'))))
  }, [t])
  useEffect(() => { loadMe() }, [loadMe])

  // 页头两个角标 / the two tab badges
  useEffect(() => {
    if (!me) return
    let alive = true
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      adminApi
        .listTickets({ assignee: 'none', status: 'active', limit: 50, offset: 0 })
        .then((rows) => { if (alive) setAwaiting(rows.length) })
        .catch(() => {})
    }
    tick()
    const id = window.setInterval(tick, POLL_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      alive = false
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [me, reloadKey])
  useEffect(() => {
    if (!me) return
    let alive = true
    supportApi.followUps().then((r) => { if (alive) setFuTotal(r.total) }).catch(() => {})
    return () => { alive = false }
  }, [me, reloadKey])

  // 点搜索框外面收起结果 / clicking outside the search closes its results
  useEffect(() => {
    if (!results) return
    const onDown = (e: PointerEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setResults(null)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [results])

  const runSearch = async (e: FormEvent) => {
    e.preventDefault()
    const q = search.trim()
    if (!q) return
    setSearching(true)
    try {
      const r = await supportApi.search(q)
      setResults(r.results)
    } catch (err) {
      onError(errText(err, t('common.error')))
    } finally {
      setSearching(false)
    }
  }

  if (meErr) {
    return (
      <div className="glass mx-auto max-w-md rounded-3xl p-8 text-center text-sm">
        <p className="text-down">{meErr}</p>
        <button type="button" className="btn btn-ghost mt-4 h-9 px-5 text-xs" onClick={loadMe}>
          {t('supportDesk.retry')}
        </button>
      </div>
    )
  }
  if (!me) {
    return (
      <div className="space-y-5">
        <SkeletonLine width={180} height={24} />
        <div className="sd-frame space-y-3 p-6">
          <SkeletonLine width="40%" height={14} />
          <SkeletonLine />
          <SkeletonLine width="70%" />
        </div>
      </div>
    )
  }

  const ctx: DeskCtx = { me, patchMe, reloadKey, bump, toast: showToast, onError, openCustomer }
  const inDetail = /^\/support-desk\/(tickets|follow-ups)\/[^/]+/.test(location.pathname)
  // 手机上进了详情就收起页头，把整屏留给会话 / 客户 / on phones a detail view gets the whole screen
  const showHeader = isDesktop || !inDetail
  const tierLabel = me.isAdmin ? t('supportDesk.role.admin') : t(`supportDesk.tier.${me.tier}`)
  const revealLeft = me.revealLimit != null && me.revealsToday != null ? Math.max(0, me.revealLimit - me.revealsToday) : null

  const tabs = [
    {
      to: '/support-desk/tickets',
      label: t('supportDesk.tab.tickets'),
      badge: awaiting ? (awaiting >= 50 ? '50+' : String(awaiting)) : null,
      badgeLabel: awaiting ? t('supportDesk.nav.awaiting', { n: awaiting }) : undefined,
      warm: true,
    },
    {
      to: '/support-desk/follow-ups',
      label: t('supportDesk.tab.followUps'),
      badge: fuTotal ? String(fuTotal) : null,
      badgeLabel: fuTotal ? t('supportDesk.followUps.count', { n: fuTotal }) : undefined,
      warm: false,
    },
  ]

  const searchBox = (
    <div ref={searchRef} className="relative w-full lg:w-[25rem]">
      <form onSubmit={runSearch} className="sd-search flex h-10 items-center gap-2 pl-4 pr-1">
        <span className="text-neutral-500"><IconSearch size={15} /></span>
        <input
          className="min-w-0 flex-1 bg-transparent text-[13px] text-neutral-100 outline-none placeholder:text-neutral-500"
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            if (!e.target.value) setResults(null)
          }}
          placeholder={t('supportDesk.search.placeholder')}
          aria-label={t('supportDesk.search.placeholder')}
          maxLength={200}
        />
        <button
          type="submit"
          className="h-8 shrink-0 rounded-full bg-[var(--nest)] px-3.5 text-xs font-medium text-neutral-200 transition hover:bg-[var(--nest-hi)] disabled:opacity-40"
          disabled={searching || !search.trim()}
        >
          {searching ? t('common.loading') : t('supportDesk.search.go')}
        </button>
      </form>
      {results && (
        <div className="sd-pop absolute inset-x-0 top-full z-40 mt-2 max-h-[60vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-neutral-500">{t('supportDesk.search.none')}</p>
          ) : (
            <ul>
              {results.map((u) => (
                <li key={u.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setResults(null)
                      openCustomer(u.id)
                    }}
                    className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left transition hover:bg-white/[0.05]"
                  >
                    <Avatar name={u.nickname || u.email} size={30} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-neutral-100">{u.nickname || t('supportDesk.card.noNickname')}</span>
                      <span className="block truncate font-mono text-[11px] text-neutral-500">{u.email || '-'}</span>
                    </span>
                    <span className="shrink-0 text-[11px] font-medium text-neutral-400">{u.plan}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div data-fd-plain className="sd-page">
      {me.watermark && <Watermark text={me.watermark} />}

      {showHeader && (
        <header className="mb-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
            <div className="flex min-w-0 items-center gap-3.5">
              <Avatar name={me.nickname || me.email} size={40} tone="staff" />
              <div className="min-w-0">
                <h1 className="font-display text-[22px] font-semibold leading-tight tracking-tight text-neutral-50">{t('supportDesk.title')}</h1>
                <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-neutral-500">
                  <span className="truncate text-neutral-300">{me.nickname || me.email}</span>
                  <span className="rounded-full border border-[var(--line-hi)] px-2 py-px text-[11px] text-neutral-400">{tierLabel}</span>
                  {revealLeft != null && <span>{t('supportDesk.card.revealLeft', { n: revealLeft })}</span>}
                </p>
              </div>
            </div>
            <div className="lg:ml-auto">{searchBox}</div>
          </div>

          <nav className="mt-5 flex gap-7 border-b border-[var(--line)]" aria-label={t('supportDesk.title')}>
            {tabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                className={({ isActive }) => `sd-tab ${isActive ? 'is-active' : ''}`}
              >
                <span>{tab.label}</span>
                {tab.badge && (
                  <span
                    className={`num rounded-full px-1.5 py-px text-[11px] font-semibold ${
                      tab.warm ? 'bg-[var(--mid-bg)] text-[var(--mid)]' : 'bg-white/[0.06] text-neutral-400'
                    }`}
                    title={tab.badgeLabel}
                    aria-label={tab.badgeLabel}
                  >
                    {tab.badge}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
        </header>
      )}

      {/* 提示浮在顶栏下方、压在抽屉之上：不推动工作台，抽屉里的操作结果也看得见
          The toast floats under the site header, above the drawer: it never shifts the
          workspace, and results of actions inside the drawer stay visible. */}
      {toast &&
        createPortal(
          <div className="pointer-events-none fixed inset-x-0 z-[80] flex justify-center px-4" style={{ top: 'calc(var(--app-hdr, 65px) + 12px)' }}>
            <div
              role="status"
              className={`sd-toast pointer-events-auto max-w-md rounded-full border bg-[var(--surface-2)] px-4 py-2 text-[13px] font-medium shadow-[0_12px_32px_rgb(0_0_0/0.45)] ${
                toast.kind === 'err' ? 'border-[rgb(var(--down-rgb)/0.45)] text-[var(--down)]' : 'border-[rgb(var(--up-rgb)/0.45)] text-[var(--up)]'
              }`}
            >
              {toast.text}
            </div>
          </div>,
          document.body,
        )}

      <Routes>
        <Route index element={<DeskIndex onError={onError} />} />
        <Route path="tickets/:ticketId?" element={<TicketsView ctx={ctx} />} />
        <Route path="follow-ups/:userId?" element={<FollowUpsView ctx={ctx} />} />
        <Route path="*" element={<Navigate to="/support-desk/tickets" replace />} />
      </Routes>

      {drawerUser && (
        <CustomerDrawer
          userId={drawerUser}
          ctx={ctx}
          onClose={() => setDrawerUser(null)}
          onOpenTicket={(id) => {
            // replace 掉抽屉压的那条历史，返回键不会落回一个已经关掉的抽屉
            // replace the drawer's history entry so Back never lands on a closed drawer
            navigate(`/support-desk/tickets/${encodeURIComponent(id)}`, { replace: true })
            setDrawerUser(null)
          }}
        />
      )}
    </div>
  )
}
