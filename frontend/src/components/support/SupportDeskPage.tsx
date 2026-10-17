// 客服台 /support-desk（设计 §9）：客服与管理员共用。桌面：左列队列（工单 / 我的跟进），右侧会话 +
// 客户卡片（宽屏并排）；手机：单列，列表 ↔ 详情两屏，底部浮条切「工单 / 我的跟进」。
// 权限全在后端；外包客服整页铺半透明水印（昵称 + 日期，设计 §8）。
// The support desk at /support-desk (design §9), shared by agents and admins. Desktop: a queue
// column (tickets / my follow-ups) and the thread + customer card on the right (side by side on
// wide screens). Phone: one column, list ↔ detail screens, a floating bottom switch for tickets /
// follow-ups. All permissions are server-side; outsourced agents get a page-wide watermark.
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { supportApi } from '../../api/client'
import type { FollowUp, SupportCustomer, SupportMe } from '../../api/supportTypes'
import { useMediaQuery } from '../../utils/useMediaQuery'
import { useToast } from '../../utils/useToast'
import PageHead from '../PageHead'
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
      <div className="glass p-6 text-center text-sm">
        <p className="text-down">{meErr}</p>
        <button type="button" className="btn-ghost mt-3 px-4 py-1.5 text-xs" onClick={loadMe}>
          {t('supportDesk.retry')}
        </button>
      </div>
    )
  }
  if (!me) {
    return (
      <div className="glass space-y-3 p-5">
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

  // ---- 详情区 / detail area ----
  let detail: ReactNode = null
  if (sel?.kind === 'ticket') {
    const showCard = sel.customerId && (isWide || sel.pane === 'customer')
    const thread = (
      <TicketThread
        key={sel.id}
        ticketId={sel.id}
        me={me}
        onChanged={bump}
        onToast={showToast}
        // 宽屏一打开工单就在旁边放提交人卡片 / wide screens show the submitter's card right away
        onLoaded={(userId) => setSel((prev) => (prev?.kind === 'ticket' && prev.id === sel.id && !prev.customerId ? { ...prev, customerId: userId } : prev))}
        onOpenCustomer={(userId) => setSel({ ...sel, customerId: userId, pane: isWide ? 'thread' : 'customer' })}
      />
    )
    detail = isWide ? (
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,400px)] gap-4">
        <div className="min-w-0">{thread}</div>
        <div className="min-w-0">
          {showCard ? cardFor(sel.customerId!) : (
            <div className="glass p-6 text-center text-xs text-neutral-500">{t('supportDesk.pickCustomer')}</div>
          )}
        </div>
      </div>
    ) : sel.pane === 'customer' && sel.customerId ? (
      <div>
        <button type="button" className="btn-ghost mb-3 px-3 py-1.5 text-xs" onClick={() => setSel({ ...sel, pane: 'thread' })}>
          &larr; {t('supportDesk.backToThread')}
        </button>
        {cardFor(sel.customerId)}
      </div>
    ) : (
      thread
    )
  } else if (sel?.kind === 'customer') {
    detail = cardFor(sel.userId)
  }

  const list = (
    <div className="flex flex-col gap-3">
      {isDesktop && (
        <div className="flex rounded-xl bg-white/5 p-1" role="tablist">
          {(['tickets', 'followUps'] as Tab[]).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={tab === k}
              onClick={() => switchTab(k)}
              className={`flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                tab === k ? 'bg-prism-600/25 text-prism-100' : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {t(`supportDesk.tab.${k}`)}
            </button>
          ))}
        </div>
      )}
      {tab === 'tickets' ? (
        <TicketQueue selectedId={sel?.kind === 'ticket' ? sel.id : null} onSelect={openTicket} reloadKey={reloadKey} onError={onError} />
      ) : (
        <FollowUpList
          selectedUserId={sel?.kind === 'customer' ? sel.userId : null}
          onSelect={(f: FollowUp) => openCustomer(f.userId)}
          reloadKey={reloadKey}
          onError={onError}
        />
      )}
    </div>
  )

  const searchBox = (
    <form onSubmit={runSearch} className="flex gap-2">
      <input
        className="input min-w-0 flex-1"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value)
          if (!e.target.value) setResults(null)
        }}
        placeholder={t('supportDesk.search.placeholder')}
        aria-label={t('supportDesk.search.placeholder')}
        maxLength={200}
      />
      <button type="submit" className="btn-primary shrink-0 px-4 py-2 text-sm disabled:opacity-40" disabled={searching || !search.trim()}>
        {searching ? t('common.loading') : t('supportDesk.search.go')}
      </button>
    </form>
  )

  const searchResults = results && (
    <div className="glass p-3">
      {results.length === 0 ? (
        <p className="text-center text-xs text-neutral-500">{t('supportDesk.search.none')}</p>
      ) : (
        <ul className="space-y-1">
          {results.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => {
                  openCustomer(u.id)
                  setResults(null)
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-white/5"
              >
                <span className="truncate text-neutral-100">{u.nickname || t('supportDesk.card.noNickname')}</span>
                <span className="truncate text-xs text-neutral-500">{u.email}</span>
                <span className="ml-auto text-xs text-neutral-400">{u.plan}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  const tierLabel = me.isAdmin ? t('supportDesk.role.admin') : t(`supportDesk.tier.${me.tier}`)

  return (
    <div data-fd-plain className={isDesktop ? '' : 'pb-16'}>
      {me.watermark && <Watermark text={me.watermark} />}
      <PageHead
        as="h1"
        title={t('supportDesk.title')}
        subtitle={`${me.nickname || me.email} · ${tierLabel}`}
      />
      <ToastBar toast={toast} className="mb-3" />

      {isDesktop ? (
        <div className="grid grid-cols-[340px_minmax(0,1fr)] gap-4">
          <aside className="flex min-w-0 flex-col gap-3">
            {searchBox}
            {searchResults}
            {list}
          </aside>
          <section className="min-w-0">
            {detail ?? <div className="glass p-10 text-center text-sm text-neutral-500">{t('supportDesk.pickSomething')}</div>}
          </section>
        </div>
      ) : sel ? (
        <div>
          <button type="button" className="btn-ghost mb-3 px-3 py-1.5 text-xs" onClick={() => setSel(null)}>
            &larr; {t('supportDesk.backToList')}
          </button>
          {detail}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {searchBox}
          {searchResults}
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
