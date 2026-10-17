// 客服后台 /support-desk（设计 §9）：客服与管理员共用。
// 桌面（≥1280）：三栏工作台，左队列（工单 / 我的跟进）、中会话、右客户卡片，各栏独立滚动；
// 1024–1279：两栏，客户卡片在中栏里切换显示。手机：单列，列表 ↔ 详情两屏，工单详情下面直接接
// 客户卡片，底部浮条切「工单 / 我的跟进」。权限全在后端；外包客服整页铺半透明水印（设计 §8）。
// The support console at /support-desk (design §9), shared by agents and admins.
// Desktop (≥1280): a three-pane workspace (queue, conversation, customer), each pane scrolling on
// its own; 1024–1279: two panes, the customer card toggled inside the middle pane. Phone: one
// column, list ↔ detail, with the customer card right below a ticket thread and a floating bottom
// switch for tickets / follow-ups. All permissions are server-side; outsourced agents get a
// page-wide watermark.
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { supportApi } from '../../api/client'
import type { FollowUp, SupportCustomer, SupportMe } from '../../api/supportTypes'
import { useMediaQuery } from '../../utils/useMediaQuery'
import { useToast } from '../../utils/useToast'
import { SkeletonLine } from '../Skeleton'
import ToastBar from '../admin/invite/ToastBar'
import CustomerCard from './CustomerCard'
import FollowUpList from './FollowUpList'
import TicketQueue from './TicketQueue'
import TicketThread from './TicketThread'
import Watermark from './Watermark'
import { errText } from './supportUi'

type Tab = 'tickets' | 'followUps'
type Sel =
  | { kind: 'ticket'; id: string; customerId: string | null; pane: 'thread' | 'customer' }
  | { kind: 'customer'; userId: string }
  | null

// 工作台高度 = 可视视口 − 站点顶栏（Layout 实测写进 --app-hdr / --app-vh）− 页面上下留白与本页标题行。
// Workspace height = visual viewport − site header (Layout measures --app-hdr / --app-vh) − the
// page's vertical padding and this page's header row.
const WORKSPACE_STYLE: CSSProperties = {
  height: 'calc(var(--app-vh, 100dvh) - var(--app-hdr, 65px) - 7.25rem)',
  minHeight: 520,
}

const CUSTOMER_ANCHOR = 'support-customer-card'

export default function SupportDeskPage() {
  const { t } = useTranslation()
  const [me, setMe] = useState<SupportMe | null>(null)
  const [meErr, setMeErr] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('tickets')
  const [sel, setSel] = useState<Sel>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const [search, setSearch] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<SupportCustomer[] | null>(null)
  const [ticketCount, setTicketCount] = useState<number | null>(null)
  const [fuCount, setFuCount] = useState<number | null>(null)
  const { toast, showToast } = useToast()
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const isWide = useMediaQuery('(min-width: 1280px)')
  const [params, setParams] = useSearchParams()

  const onError = useCallback((text: string) => showToast('err', text), [showToast])
  const bump = useCallback(() => setReloadKey((k) => k + 1), [])

  const loadMe = useCallback(() => {
    setMeErr(null)
    supportApi.me().then(setMe).catch((err) => setMeErr(errText(err, t('common.error'))))
  }, [t])
  useEffect(() => { loadMe() }, [loadMe])

  // 通知深链：?ticket=<id>（新工单 / 回复）、?followUp=<id>（到点 / 新分配提醒）。读一次就从地址栏抹掉。
  // Notification deep links: ?ticket=<id> and ?followUp=<id>; read once, then cleared.
  useEffect(() => {
    const ticket = params.get('ticket')
    const followUp = params.get('followUp')
    if (!ticket && !followUp) return
    const next = new URLSearchParams(params)
    next.delete('ticket')
    next.delete('followUp')
    setParams(next, { replace: true })
    if (ticket) {
      setTab('tickets')
      setSel({ kind: 'ticket', id: ticket, customerId: null, pane: 'thread' })
    } else if (followUp) {
      setTab('followUps')
      supportApi
        .followUp(followUp)
        .then((r) => setSel({ kind: 'customer', userId: r.followUp.userId }))
        .catch((err) => onError(errText(err, t('common.error'))))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
      <div className="glass rounded-2xl p-6 text-center text-sm">
        <p className="text-down">{meErr}</p>
        <button type="button" className="btn-ghost mt-3 px-4 py-1.5 text-xs" onClick={loadMe}>
          {t('supportDesk.retry')}
        </button>
      </div>
    )
  }
  if (!me) {
    return (
      <div className="glass space-y-3 rounded-2xl p-5">
        <SkeletonLine width="40%" height={16} />
        <SkeletonLine />
        <SkeletonLine width="70%" />
      </div>
    )
  }

  const openTicket = (id: string) => setSel({ kind: 'ticket', id, customerId: null, pane: 'thread' })
  const openCustomer = (userId: string) => setSel({ kind: 'customer', userId })
  const switchTab = (next: Tab) => {
    setTab(next)
    if (!isDesktop) setSel(null)
  }

  const cardFor = (userId: string) => (
    <CustomerCard
      key={userId}
      userId={userId}
      me={me}
      onMeChanged={(patch) => setMe((prev) => (prev ? { ...prev, ...patch } : prev))}
      onChanged={bump}
      onOpenTicket={(id) => {
        setTab('tickets')
        openTicket(id)
      }}
      onToast={showToast}
    />
  )

  const emptyPane = (text: string) => (
    <div className="glass flex h-full min-h-[240px] items-center justify-center rounded-2xl p-8 text-center">
      <p className="max-w-[18rem] text-sm text-neutral-500">{text}</p>
    </div>
  )

  // ---- 会话 / 客户区 / conversation and customer areas ----
  let middle: ReactNode = null
  let right: ReactNode = null
  if (sel?.kind === 'ticket') {
    const thread = (
      <TicketThread
        key={sel.id}
        ticketId={sel.id}
        me={me}
        onChanged={bump}
        onToast={showToast}
        // 一打开工单就记下提交人，宽屏 / 手机直接显示其卡片 / remember the submitter so wide screens and phones show the card
        onLoaded={(userId) => setSel((prev) => (prev?.kind === 'ticket' && prev.id === sel.id && !prev.customerId ? { ...prev, customerId: userId } : prev))}
        onOpenCustomer={(userId) => {
          if (isWide) {
            setSel({ ...sel, customerId: userId })
          } else if (isDesktop) {
            setSel({ ...sel, customerId: userId, pane: 'customer' })
          } else {
            setSel({ ...sel, customerId: userId })
            document.getElementById(CUSTOMER_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
          }
        }}
      />
    )
    if (isWide) {
      middle = thread
      right = sel.customerId ? cardFor(sel.customerId) : null
    } else if (isDesktop) {
      middle = sel.pane === 'customer' && sel.customerId ? (
        <div className="h-full overflow-y-auto pr-1">
          <button type="button" className="btn-ghost mb-3 px-3 py-1.5 text-xs" onClick={() => setSel({ ...sel, pane: 'thread' })}>
            &larr; {t('supportDesk.backToThread')}
          </button>
          {cardFor(sel.customerId)}
        </div>
      ) : thread
    } else {
      middle = (
        <div className="flex flex-col gap-4">
          {thread}
          {sel.customerId && <div id={CUSTOMER_ANCHOR} className="scroll-mt-20">{cardFor(sel.customerId)}</div>}
        </div>
      )
    }
  } else if (sel?.kind === 'customer') {
    if (isWide) {
      right = cardFor(sel.userId)
    } else {
      middle = isDesktop ? <div className="h-full overflow-y-auto pr-1">{cardFor(sel.userId)}</div> : cardFor(sel.userId)
    }
  }

  const fmtCount = (n: number | null, cap?: number) => (n == null ? null : cap != null && n >= cap ? `${cap}+` : String(n))
  const counts: Record<Tab, string | null> = { tickets: fmtCount(ticketCount, 50), followUps: fmtCount(fuCount) }

  const tabSwitch = (
    <div className="flex rounded-xl bg-white/5 p-1" role="tablist">
      {(['tickets', 'followUps'] as Tab[]).map((k) => (
        <button
          key={k}
          type="button"
          role="tab"
          aria-selected={tab === k}
          onClick={() => switchTab(k)}
          className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
            tab === k ? 'bg-prism-600/25 text-prism-100' : 'text-neutral-400 hover:text-neutral-200'
          }`}
        >
          {t(`supportDesk.tab.${k}`)}
          {counts[k] != null && <span className={`num text-[11px] ${tab === k ? 'text-prism-200/80' : 'text-neutral-500'}`}>{counts[k]}</span>}
        </button>
      ))}
    </div>
  )

  const list = tab === 'tickets' ? (
    <TicketQueue
      selectedId={sel?.kind === 'ticket' ? sel.id : null}
      onSelect={openTicket}
      reloadKey={reloadKey}
      onError={onError}
      onCount={setTicketCount}
    />
  ) : (
    <FollowUpList
      selectedUserId={sel?.kind === 'customer' ? sel.userId : null}
      onSelect={(f: FollowUp) => openCustomer(f.userId)}
      reloadKey={reloadKey}
      onError={onError}
      onCount={setFuCount}
    />
  )

  const searchBox = (
    <form onSubmit={runSearch} className="flex w-full gap-2 lg:w-[22rem]">
      <input
        className="input min-w-0 flex-1 py-1.5 text-sm"
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
      <button type="submit" className="btn-primary shrink-0 px-4 py-1.5 text-sm disabled:opacity-40" disabled={searching || !search.trim()}>
        {searching ? t('common.loading') : t('supportDesk.search.go')}
      </button>
    </form>
  )

  const searchResults = results && (
    <div className="glass rounded-2xl p-2 lg:absolute lg:right-0 lg:top-full lg:z-40 lg:mt-2 lg:w-[26rem] lg:max-h-[60vh] lg:overflow-y-auto">
      {results.length === 0 ? (
        <p className="px-2 py-3 text-center text-xs text-neutral-500">{t('supportDesk.search.none')}</p>
      ) : (
        <ul className="space-y-0.5">
          {results.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => {
                  openCustomer(u.id)
                  setResults(null)
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-white/5"
              >
                <span className="min-w-0 truncate text-neutral-100">{u.nickname || t('supportDesk.card.noNickname')}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-neutral-500">{u.email}</span>
                <span className="shrink-0 text-xs text-neutral-400">{u.plan}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  const tierLabel = me.isAdmin ? t('supportDesk.role.admin') : t(`supportDesk.tier.${me.tier}`)

  const header = (
    <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="font-display text-xl font-semibold text-neutral-50">{t('supportDesk.title')}</h1>
        <span className="min-w-0 truncate text-xs text-neutral-500">
          {me.nickname || me.email}
          <span className="ml-2 rounded-md bg-white/5 px-1.5 py-0.5 text-[11px] text-neutral-400">{tierLabel}</span>
        </span>
      </div>
      {(isDesktop || !sel) && (
        <div className="relative flex flex-col gap-2 lg:ml-auto">
          {searchBox}
          {searchResults}
        </div>
      )}
    </div>
  )

  return (
    <div data-fd-plain className={isDesktop ? '' : 'pb-16'}>
      {me.watermark && <Watermark text={me.watermark} />}
      {header}
      <ToastBar toast={toast} className="mb-3" />

      {isDesktop ? (
        <div
          className={`grid gap-3 ${isWide ? 'grid-cols-[340px_minmax(0,1fr)_380px]' : 'grid-cols-[320px_minmax(0,1fr)]'}`}
          style={WORKSPACE_STYLE}
        >
          <aside className="glass flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl">
            <div className="shrink-0 p-3">{tabSwitch}</div>
            {list}
          </aside>
          <section className="min-h-0 min-w-0">
            {middle ?? emptyPane(t('supportDesk.pickSomething'))}
          </section>
          {isWide && (
            <aside className="min-h-0 min-w-0 overflow-y-auto pr-1">
              {right ?? emptyPane(t('supportDesk.pickCustomer'))}
            </aside>
          )}
        </div>
      ) : sel ? (
        <div>
          <button type="button" className="btn-ghost mb-3 px-3 py-1.5 text-xs" onClick={() => setSel(null)}>
            &larr; {t('supportDesk.backToList')}
          </button>
          {middle}
        </div>
      ) : (
        <div className="glass flex flex-col overflow-hidden rounded-2xl">
          <div className="pt-3" />
          {list}
        </div>
      )}

      {/* 手机底部切换：浮在 App 底栏之上（.above-tabbar 读 Layout 量出的底栏高度）。
          Phone switch, floating above the app tab bar (.above-tabbar reads Layout's measured height). */}
      {!isDesktop && !sel && (
        <div className="above-tabbar fixed left-1/2 z-30 -translate-x-1/2">
          <div className="flex rounded-full border border-white/10 bg-ink-950/90 p-1 shadow-lg backdrop-blur-lg" role="tablist">
            {(['tickets', 'followUps'] as Tab[]).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={tab === k}
                onClick={() => switchTab(k)}
                className={`rounded-full px-5 py-2 text-sm font-medium transition ${
                  tab === k ? 'bg-prism-600 text-white' : 'text-neutral-400'
                }`}
              >
                {t(`supportDesk.tab.${k}`)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
