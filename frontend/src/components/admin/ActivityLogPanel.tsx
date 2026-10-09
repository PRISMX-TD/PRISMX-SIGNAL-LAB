// 管理后台「操作日志」页签（设计 2026-10-09 §6）：每件事一行，一句大白话——时间 / 用户（昵称 +
// 邮箱）/ MT5 账户 / 谁操作 / 发生了什么。数据来自 GET /admin/activity（五个源合并、游标翻页、
// 不返回总数），句子由 activity/renderEvent 按当前语言拼。
//
// 几个刻意的取舍：
//   · 翻页用「加载更多」而不是页码：后端没有总数（不 COUNT 是为了不压数据库），页码给不出来。
//   · 换了任何筛选条件就丢掉游标从头取（契约 §1.1），并中止上一次请求——筛选连点、搜索防抖之后
//     先发的响应后到会把当前条件的结果盖掉。
//   · 自动刷新默认关；开了也只在「页面可见、列表在顶部、详情没开」时真刷新，否则只偷看一眼，
//     有新的就亮「有新记录 ↑」，不把正在读的行从眼皮底下挪走（feedState.autoRefreshAction）。
//   · 上次选的分类、自动刷新开关记在本机（读写失败当没有）；从用户表「日志」按钮或深链带着
//     用户 / 账号进来时，分类回到「全部」——要看的是这个人的全部经过。
//
// The admin "activity log" tab (design §6): one plain-language line per event — time /
// user (nickname + email) / MT5 account / actor / what happened — from GET /admin/activity
// (five merged sources, keyset paged, no totals), with sentences built by
// activity/renderEvent. "Load more" instead of page numbers (there is no total by design);
// any filter change drops the cursor and aborts the previous request; auto-refresh is off
// by default and only refreshes while visible, at the top and with no drawer open,
// otherwise it peeks and lights a "new records" pill. The last category and the
// auto-refresh switch are remembered per device; arriving with a user / login preset
// resets the category to "all".
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { adminApi, isAbortError } from '../../api/client'
import { localizeApiError } from '../../api/utils'
import type { ActivityCatFilter, ActivityItem, ActivityPage, ActivityPerson, ActivityQuery, ActivitySub } from '../../api/types'
import { isAppHidden } from '../../utils/appVisibility'
import { useIsPhone } from '../../utils/useMediaQuery'
import { segBtn } from '../../utils/segBtn'
import { useToast } from '../../utils/useToast'
import Select from '../Select'
import Switch from '../Switch'
import { SkeletonLine } from '../Skeleton'
import AdminSheet from './AdminSheet'
import ToastBar from './invite/ToastBar'
import ActivityDetailSheet from './activity/ActivityDetailSheet'
import { DESKTOP_GRID, DesktopRow, EmptyState, PhoneCard, type RowHandlers } from './activity/ActivityBits'
import {
  AT_TOP_PX, AUTO_REFRESH_MS, PAGE_LIMIT, acceptLoadMore, autoRefreshAction, canLoadMore, isLoginQuery, isNewer, loadFailureReport,
  mergePage, phoneMatches, queryDigits, readPrefs, sortByTs, withChildren, writePrefs, type ActivityPrefs,
} from './activity/feedState'
import { DATE_PRESETS, bjDayKey, bjHm, dateRange, dayLabel, groupByDay, type DatePreset } from './activity/time'

const CATS: ActivityCatFilter[] = ['all', 'account', 'mt5', 'trade', 'admin']
const SUBS: ActivitySub[] = ['all', 'open_close', 'sltp']
const LIMIT_KEYS = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8']
// 一页被合并规则整页收掉时 items 为空、next 不为空（契约 §1.1），接着往下取，最多这么多次。
// A page can come back empty with a cursor when merging swallowed it (contract §1.1); keep
// reading, at most this many times.
const EMPTY_PAGE_RETRIES = 3
// 日期分隔行吸在站点顶栏下面，偏移与 Layout 里其它吸顶条一致。
// Day separators stick below the site header, at the same offset as Layout's other sticky bars.
const STICKY_TOP = 'top-[calc(57px+env(safe-area-inset-top))] sm:top-[calc(65px+env(safe-area-inset-top))]'

/** 从用户表或深链带进来的筛选。/ A filter carried in from the users table or a deep link. */
export interface LogsPreset {
  userId?: string | null
  userLabel?: string | null
  login?: string | null
}

interface UserFilter {
  id: string
  label: string | null
}

async function fetchPage(query: ActivityQuery, signal: AbortSignal): Promise<ActivityPage> {
  let page = await adminApi.activity(query, signal)
  for (let i = 0; i < EMPTY_PAGE_RETRIES && page.items.length === 0 && page.next; i++) {
    page = await adminApi.activity({ ...query, cursor: page.next }, signal)
  }
  return page
}

export default function ActivityLogPanel({
  preset,
  onPresetCleared,
  onOpenUser,
}: {
  preset?: LogsPreset | null
  onPresetCleared?: () => void
  onOpenUser?: (email: string) => void
}) {
  const { t } = useTranslation()
  const isPhone = useIsPhone()
  const { toast, showToast } = useToast()

  const hasPreset = !!(preset?.userId || preset?.login)
  const [prefs, setPrefs] = useState<ActivityPrefs>(readPrefs)
  const [cat, setCat] = useState<ActivityCatFilter>(hasPreset ? 'all' : prefs.cat)
  const [sub, setSub] = useState<ActivitySub>(hasPreset ? 'all' : prefs.sub)
  const [abnormal, setAbnormal] = useState(false)
  const [datePreset, setDatePreset] = useState<DatePreset>('all')
  const [day, setDay] = useState(() => bjDayKey(new Date()))
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [userFilter, setUserFilter] = useState<UserFilter | null>(
    preset?.userId ? { id: preset.userId, label: preset.userLabel ?? null } : null,
  )
  const [login, setLogin] = useState<string | null>(preset?.login ?? null)

  const [items, setItems] = useState<ActivityItem[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [hasNew, setHasNew] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<ActivityItem | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  // 纯数字搜不到时，手机号对得上的用户（见下方的 effect）/ users whose phone matches an empty digit search
  const [phoneHits, setPhoneHits] = useState<{ q: string; users: ActivityPerson[] } | null>(null)

  const savePrefs = (patch: Partial<ActivityPrefs>) => {
    setPrefs((prev) => {
      const nextPrefs = { ...prev, ...patch }
      writePrefs(nextPrefs)
      return nextPrefs
    })
  }

  // 搜索框 300ms 防抖 / debounce the search box by 300ms
  useEffect(() => {
    const id = window.setTimeout(() => setQ(search.trim()), 300)
    return () => window.clearTimeout(id)
  }, [search])

  // 当前筛选 → 请求参数。日期在发请求那一刻再换算：面板开过零点，「今天」也跟着换。
  // Filters → request params. Dates are converted at request time so "today" follows midnight.
  const buildQuery = (): ActivityQuery => {
    const { since, until } = dateRange(datePreset, new Date(), day)
    return {
      cat,
      sub,
      abnormal,
      q: q || undefined,
      userId: userFilter?.id,
      login: login ?? undefined,
      since: since ?? undefined,
      until: until ?? undefined,
      limit: PAGE_LIMIT,
    }
  }
  const queryRef = useRef(buildQuery)
  queryRef.current = buildQuery
  const filterKey = JSON.stringify([cat, sub, abnormal, q, userFilter?.id ?? null, login, datePreset, datePreset === 'day' ? day : null])

  // 同一代请求共用一个 AbortController：换筛选 / 刷新时 abort 掉上一代，连同它的「加载更多」。
  // One controller per generation: a filter change or refresh aborts the previous one,
  // including its "load more".
  const ctrlRef = useRef<AbortController | null>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const busyRef = useRef(false)
  busyRef.current = phase === 'loading' || refreshing || loadingMore
  const overlayRef = useRef(false)
  overlayRef.current = detail !== null || filtersOpen
  const hasNewRef = useRef(hasNew)
  hasNewRef.current = hasNew
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const nextRef = useRef(next)
  nextRef.current = next

  const loadFirst = useCallback(
    async (mode: 'initial' | 'refresh') => {
      ctrlRef.current?.abort()
      const ctrl = new AbortController()
      ctrlRef.current = ctrl
      // 两个标志都按这一代重设：被中止的上一代不会再回来收拾它们（见 finally 的守卫）
      // Both flags are reset for this generation; an aborted one never comes back to clear them
      setLoadingMore(false)
      setRefreshing(mode === 'refresh')
      if (mode === 'initial') {
        setPhase('loading')
        setItems([])
        setNext(null)
        setExpanded(new Set())
      }
      try {
        const page = await fetchPage(queryRef.current(), ctrl.signal)
        if (ctrlRef.current !== ctrl) return
        setItems(sortByTs(page.items))
        setNext(page.next)
        setPhase('ready')
        setLoadError(null)
        setUpdatedAt(new Date())
        setHasNew(false)
      } catch (err) {
        if (isAbortError(err) || ctrlRef.current !== ctrl) return
        const text = err instanceof Error ? localizeApiError(err.message) : t('admin.log.loadError')
        // 首次读不出来给整块错误 + 重试；刷新失败保留旧列表，只弹一条提示。已经停在错误块上时
        // （自动刷新每分钟重试）只更新那一块，不每分钟叠一条提示（feedState.loadFailureReport）。
        // A failed first load shows an error block; a failed refresh keeps the old list with
        // one toast. While the error block is already up (auto-refresh retries every minute)
        // only the block is updated, never a toast a minute.
        if (loadFailureReport(mode, phaseRef.current) === 'block') {
          setPhase('error')
          setLoadError(text)
        } else showToast('err', `${t('admin.log.loadError')} — ${text}`)
      } finally {
        if (ctrlRef.current === ctrl) setRefreshing(false)
      }
    },
    [showToast, t],
  )

  useEffect(() => {
    void loadFirst('initial')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterKey])

  useEffect(() => () => ctrlRef.current?.abort(), [])

  // 刷新进行中不让加载更多；回来时游标已被刷新换掉的那一页也丢掉：拿旧游标取的下一页拼到
  // 新的第一页后面，中间会无声地漏掉几行（feedState.canLoadMore / acceptLoadMore）。
  // No "load more" during a refresh, and a page whose cursor a refresh has since replaced is
  // dropped: appended to the new first page it would silently skip the rows in between.
  const loadMore = async () => {
    const ctrl = ctrlRef.current
    const cursor = next
    if (!cursor || !ctrl || !canLoadMore({ next: cursor, loadingMore, refreshing })) return
    setLoadingMore(true)
    try {
      const page = await fetchPage({ ...queryRef.current(), cursor }, ctrl.signal)
      if (ctrlRef.current !== ctrl || !acceptLoadMore(cursor, nextRef.current)) return
      setItems((prev) => mergePage(prev, page.items))
      setNext(page.next)
    } catch (err) {
      if (isAbortError(err) || ctrlRef.current !== ctrl) return
      showToast('err', `${t('admin.log.loadError')} — ${err instanceof Error ? localizeApiError(err.message) : ''}`)
    } finally {
      if (ctrlRef.current === ctrl) setLoadingMore(false)
    }
  }

  // 偷看最新一条：不中止当前这一代，结果只用来决定亮不亮「有新记录」。
  // Peek at the newest row without aborting the current generation; it only decides the pill.
  const peek = useCallback(async () => {
    const gen = ctrlRef.current
    try {
      const page = await adminApi.activity({ ...queryRef.current(), limit: 1 })
      if (ctrlRef.current !== gen) return
      if (isNewer(page.items[0], itemsRef.current)) setHasNew(true)
    } catch {
      // 偷看失败不打扰人：下一轮再看 / a failed peek stays silent; the next tick tries again
    }
  }, [])

  // 自动刷新：60 秒一轮，做什么由 autoRefreshAction 决定（见 feedState）。
  // Auto-refresh: every 60s, autoRefreshAction decides what to do (see feedState).
  useEffect(() => {
    if (!prefs.auto) return
    const id = window.setInterval(() => {
      const action = autoRefreshAction({
        hidden: isAppHidden(),
        busy: busyRef.current,
        atTop: window.scrollY < AT_TOP_PX,
        overlayOpen: overlayRef.current,
        hasNew: hasNewRef.current,
      })
      if (action === 'refresh') void loadFirst('refresh')
      else if (action === 'peek') void peek()
    }, AUTO_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [prefs.auto, loadFirst, peek])

  // 用户 / 账号筛选不再是带进来的那个了，就告诉上层清掉预设——下次进这个页签别又带回来。
  // Once the user / login filter is no longer the carried-in one, tell the parent to drop the
  // preset so the next visit to this tab doesn't bring it back.
  useEffect(() => {
    if (!hasPreset) return
    if ((preset?.userId ?? null) !== (userFilter?.id ?? null) || (preset?.login ?? null) !== login) onPresetCleared?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userFilter?.id, login])

  // 5–12 位纯数字后端先按 MT5 账号、再按手机号包含查；还是一条都没有时，多半是带着本地前导 0
  // 的手机号：用用户表的搜索（与「用户」页签同一口径，前导 0 也认）找手机号对得上的人，空状态
  // 里给出「点一下看 TA 的日志」。只在这种空结果时查一次、最多 5 个——一次几百行用户表上的查询。
  // A 5–12 digit search runs as an MT5 login, then as a phone substring in the backend; when it
  // still finds nothing it is most likely a phone typed with a local leading 0. Look the
  // digits up through the users-table search (the Users tab's rule, which handles that) and
  // offer the matching users in the empty state. Only on such an empty result, at most 5
  // users — one query on a few-hundred-row table.
  const phoneLookup = phase === 'ready' && items.length === 0 && isLoginQuery(q) ? queryDigits(q) : null
  useEffect(() => {
    if (!phoneLookup) return
    const ctrl = new AbortController()
    adminApi
      .listUsers({ q: phoneLookup, limit: 5 }, ctrl.signal)
      .then((res) => {
        const users = res.users
          .filter((u) => phoneMatches(phoneLookup, u.phone))
          .map((u) => ({ id: u.id, nickname: u.nickname ?? null, email: u.email }))
        setPhoneHits({ q: phoneLookup, users })
      })
      .catch(() => {
        // 查不到就只给「带上 + 再搜」的提示 / on failure only the "add the +" tip shows
        if (!ctrl.signal.aborted) setPhoneHits({ q: phoneLookup, users: [] })
      })
    return () => ctrl.abort()
  }, [phoneLookup])

  const changeCat = (c: ActivityCatFilter) => {
    setCat(c)
    setSub('all')
    savePrefs({ cat: c, sub: 'all' })
  }
  const changeSub = (s: ActivitySub) => {
    setSub(s)
    savePrefs({ sub: s })
  }
  const filterUser = (u: ActivityPerson) => {
    setUserFilter({ id: u.id, label: u.nickname || u.email })
    setDetail(null)
  }
  const filterLogin = (l: string) => {
    setLogin(l)
    setDetail(null)
  }
  const toggleExpanded = (key: string) =>
    setExpanded((prev) => {
      const nextSet = new Set(prev)
      if (nextSet.has(key)) nextSet.delete(key)
      else nextSet.add(key)
      return nextSet
    })

  const refreshNow = () => {
    setHasNew(false)
    if (window.scrollY > 0) window.scrollTo({ top: 0, behavior: 'smooth' })
    void loadFirst(phase === 'ready' ? 'refresh' : 'initial')
  }

  const handlers: RowHandlers = { onOpen: setDetail, onUser: filterUser, onLogin: filterLogin }

  // 用户筛选的名字：从用户表带进来的有；深链只有 id，就从已加载的行里找，再不行显示 id 开头。
  // The user chip's name: carried in from the users table, or found among loaded rows for a
  // deep link, else the start of the id.
  const userChipName = useMemo(() => {
    if (!userFilter) return ''
    if (userFilter.label) return userFilter.label
    const hit = items.find((i) => i.user?.id === userFilter.id)?.user
    return hit?.nickname || hit?.email || `${userFilter.id.slice(0, 8)}…`
  }, [userFilter, items])

  const chips = [
    userFilter && { key: 'user', label: t('admin.log.chip.user', { name: userChipName }), clear: () => setUserFilter(null) },
    login && { key: 'login', label: t('admin.log.chip.login', { login }), clear: () => setLogin(null) },
    // 纯数字是按 MT5 账号 / 手机号查的，标签照实说 / a digits-only query searched logins, then phones; say so
    q && { key: 'q', label: t(isLoginQuery(q) ? 'admin.log.chip.qLogin' : 'admin.log.chip.q', { q }), clear: () => { setSearch(''); setQ('') } },
    datePreset !== 'all' && {
      key: 'date',
      label: datePreset === 'day' ? day : t(`admin.log.date.${datePreset}`),
      clear: () => setDatePreset('all'),
    },
    abnormal && { key: 'abnormal', label: t('admin.log.chip.abnormal'), clear: () => setAbnormal(false) },
  ].filter((c): c is { key: string; label: string; clear: () => void } => !!c)
  const clearAll = () => {
    setUserFilter(null)
    setLogin(null)
    setSearch('')
    setQ('')
    setDatePreset('all')
    setAbnormal(false)
  }
  // 手机上收进「筛选」面板的那几项，按钮上标个数 / phone: count of filters tucked into the sheet
  const sheetFilterCount = (datePreset !== 'all' ? 1 : 0) + (abnormal ? 1 : 0)

  const now = new Date()
  const groups = groupByDay(items)

  // ---- 筛选控件 / filter controls ----
  const catButtons = (
    <div className={isPhone ? '-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-0.5 no-scrollbar' : 'flex flex-wrap gap-1.5'} role="group" aria-label={t('admin.log.title')}>
      {CATS.map((c) => (
        <button key={c} type="button" className={`${segBtn(cat === c)} shrink-0`} aria-pressed={cat === c} onClick={() => changeCat(c)}>
          {t(`admin.log.cat.${c}`)}
        </button>
      ))}
    </div>
  )
  const subButtons = cat === 'trade' && (
    <div className={isPhone ? '-mx-4 flex gap-1.5 overflow-x-auto px-4 no-scrollbar' : 'flex flex-wrap gap-1.5'} role="group">
      {SUBS.map((s) => (
        <button
          key={s}
          type="button"
          className={`shrink-0 rounded-lg px-2.5 py-1 text-xs transition ${
            sub === s ? 'bg-white/10 text-neutral-100' : 'text-neutral-500 hover:bg-white/5 hover:text-neutral-200'
          }`}
          aria-pressed={sub === s}
          onClick={() => changeSub(s)}
        >
          {t(`admin.log.sub.${s}`)}
        </button>
      ))}
    </div>
  )
  const dayInput = datePreset === 'day' && (
    <input
      type="date"
      className="input w-auto py-1 text-xs"
      value={day}
      aria-label={t('admin.log.date.day')}
      onChange={(e) => e.target.value && setDay(e.target.value)}
    />
  )
  const abnormalSwitch = (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-400" title={t('admin.log.abnormalHint')}>
      <Switch checked={abnormal} onChange={setAbnormal} />
      {t('admin.log.abnormal')}
    </label>
  )
  const autoSwitch = (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-neutral-400" title={t('admin.log.autoRefreshHint')}>
      <Switch checked={prefs.auto} onChange={(v) => savePrefs({ auto: v })} />
      {t('admin.log.autoRefresh')}
    </label>
  )
  const searchBox = (
    <input
      className={`input py-1.5 text-sm ${isPhone ? 'min-w-0 flex-1' : 'w-72'}`}
      type="search"
      placeholder={t('admin.log.search')}
      title={t('admin.log.searchHint')}
      value={search}
      maxLength={100}
      onChange={(e) => setSearch(e.target.value)}
    />
  )
  const refreshBlock = (
    <div className="flex items-center gap-2 text-xs text-neutral-500">
      {updatedAt && <span className="num">{t('admin.log.updated', { time: bjHm(updatedAt) })}</span>}
      <button
        type="button"
        onClick={refreshNow}
        disabled={phase === 'loading' || refreshing}
        className="rounded-lg px-2 py-1 text-prism-200 transition hover:bg-white/5 disabled:opacity-50"
      >
        {refreshing ? t('admin.log.refreshing') : t('admin.log.refresh')}
      </button>
    </div>
  )

  return (
    <div>
      <ToastBar toast={toast} className="mb-4" />

      <div className="glass mb-4 space-y-3 p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-white">{t('admin.log.title')}</h2>
            <p className="mt-0.5 text-xs text-neutral-500">{t('admin.log.tz')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {refreshBlock}
            {!isPhone && autoSwitch}
          </div>
        </div>

        {catButtons}
        {subButtons}

        {isPhone ? (
          <div className="flex items-center gap-2">
            {searchBox}
            <button type="button" className="btn-ghost shrink-0 px-3 py-1.5 text-xs" onClick={() => setFiltersOpen(true)}>
              {sheetFilterCount ? t('admin.log.filtersCount', { n: sheetFilterCount }) : t('admin.log.filters')}
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            {searchBox}
            <span className="text-xs text-neutral-500">{t('admin.log.date.label')}</span>
            <Select
              value={datePreset}
              onChange={(v) => setDatePreset(v as DatePreset)}
              ariaLabel={t('admin.log.date.label')}
              options={DATE_PRESETS.map((d) => ({ value: d, label: t(`admin.log.date.${d}`) }))}
            />
            {dayInput}
            {abnormalSwitch}
          </div>
        )}

        {/* 输入纯数字时当场说明怎么查（title 提示在手机上看不到）/ said in place: title tooltips never show on phones */}
        {isLoginQuery(search) && <p className="-mt-1 text-[11px] text-neutral-500">{t('admin.log.searchDigits')}</p>}

        {chips.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            {chips.map((c) => (
              <span key={c.key} className="inline-flex max-w-full items-center gap-1 rounded-full bg-prism-600/15 py-0.5 pl-2.5 pr-1 text-xs text-prism-200">
                <span className="truncate">{c.label}</span>
                <button
                  type="button"
                  onClick={c.clear}
                  aria-label={t('admin.log.chip.remove')}
                  title={t('admin.log.chip.remove')}
                  className="rounded-full px-1.5 leading-none text-prism-200/80 transition hover:bg-white/10 hover:text-white"
                >
                  ×
                </button>
              </span>
            ))}
            {chips.length > 1 && (
              <button type="button" onClick={clearAll} className="px-1.5 text-xs text-neutral-500 transition hover:text-neutral-200">
                {t('admin.log.chip.clearAll')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* 有新记录：吸在顶栏下面，点了回到顶部并刷新 / new-records pill: sticks below the header */}
      {hasNew && (
        <div className={`pointer-events-none sticky z-20 -mb-9 flex justify-center ${STICKY_TOP}`}>
          <button
            type="button"
            onClick={refreshNow}
            className="pointer-events-auto mt-1 rounded-full bg-prism-600 px-4 py-1.5 text-xs font-semibold text-white shadow-lg transition hover:bg-prism-500"
          >
            {t('admin.log.newRecords')}
          </button>
        </div>
      )}

      {phase === 'loading' ? (
        <div className="glass space-y-3 p-5">
          <SkeletonLine width="55%" height={14} />
          <SkeletonLine />
          <SkeletonLine width="80%" />
        </div>
      ) : phase === 'error' ? (
        <div className="glass p-6 text-center">
          <p className="text-sm text-down">{t('admin.log.loadError')}</p>
          {loadError && <p className="mt-1 text-xs text-neutral-500">{loadError}</p>}
          <button type="button" className="btn-ghost mt-3 px-4 py-1.5 text-xs" onClick={() => void loadFirst('initial')}>
            {t('admin.log.retry')}
          </button>
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          loginQuery={isLoginQuery(q) ? queryDigits(q) : null}
          phoneUsers={phoneHits && phoneHits.q === queryDigits(q) ? phoneHits.users : null}
          onPickUser={(u) => {
            setSearch('')
            setQ('')
            filterUser(u)
          }}
        />
      ) : (
        // 不用 .glass：它悬停换底色，吸顶的日期行就和底色对不上了；也不加 overflow——会让吸顶失效。
        // Not .glass (its hover tint would mismatch the sticky separators) and no overflow
        // (which would break sticky).
        <div className="rounded-[var(--r-lg)] bg-[color:var(--surface)]">
          {!isPhone && (
            <div className={`${DESKTOP_GRID} border-b border-white/10 px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-neutral-500`}>
              <span>{t('admin.log.col.time')}</span>
              <span>{t('admin.log.col.user')}</span>
              <span>{t('admin.log.col.account')}</span>
              <span>{t('admin.log.col.actor')}</span>
              <span>{t('admin.log.col.what')}</span>
            </div>
          )}
          {groups.map((g) => (
            <div key={g.day}>
              <div
                className={`sticky z-10 border-b border-white/5 bg-[color:var(--surface)] px-4 py-1.5 text-xs font-semibold text-neutral-400 ${STICKY_TOP}`}
              >
                {dayLabel(g.day, now, t)}
              </div>
              {withChildren(g.items, expanded).map((r) => {
                const Row = isPhone ? PhoneCard : DesktopRow
                return r.child ? (
                  <Row key={r.key} item={r.item} child handlers={handlers} />
                ) : (
                  <Row
                    key={r.key}
                    item={r.item}
                    expanded={expanded.has(r.key)}
                    onToggle={() => toggleExpanded(r.key)}
                    handlers={handlers}
                  />
                )
              })}
            </div>
          ))}
        </div>
      )}

      {phase === 'ready' && items.length > 0 && (
        <div className="mt-4 flex flex-col items-center gap-2">
          {next ? (
            <button
              type="button"
              className="btn-ghost px-5 py-2 text-sm disabled:opacity-50"
              onClick={() => void loadMore()}
              disabled={!canLoadMore({ next, loadingMore, refreshing })}
            >
              {loadingMore ? t('admin.log.loadingMore') : t('admin.log.loadMore')}
            </button>
          ) : (
            <span className="text-xs text-neutral-500">{t('admin.log.end')}</span>
          )}
          <span className="num text-xs text-neutral-500">{t('admin.log.shown', { n: items.length })}</span>
        </div>
      )}

      {/* 这一页看不到的（设计 §8）/ what this page cannot show (design §8) */}
      <div className="mt-6 rounded-lg border border-white/5 p-4 text-xs leading-relaxed text-neutral-500">
        <p className="mb-2 font-medium text-neutral-400">{t('admin.log.limits.title')}</p>
        <ul className="list-disc space-y-1 pl-4">
          {LIMIT_KEYS.map((k) => (
            <li key={k}>{t(`admin.log.limits.${k}`)}</li>
          ))}
        </ul>
      </div>

      {detail && (
        <ActivityDetailSheet
          item={detail}
          filters={{ cat, abnormal, q: q || undefined, userId: userFilter?.id }}
          onClose={() => setDetail(null)}
          onUser={filterUser}
          onLogin={filterLogin}
          onOpenUser={onOpenUser}
        />
      )}

      {/* 手机：日期、只看异常、自动刷新收进底部面板 / phone: date, problems-only and auto-refresh live in a sheet */}
      {filtersOpen && (
        <AdminSheet title={t('admin.log.filters')} onClose={() => setFiltersOpen(false)}>
          <div className="mt-4 space-y-4">
            <div>
              <p className="mb-2 text-xs text-neutral-500">{t('admin.log.date.label')}</p>
              <div className="flex flex-wrap gap-1.5">
                {DATE_PRESETS.map((d) => (
                  <button key={d} type="button" className={segBtn(datePreset === d)} aria-pressed={datePreset === d} onClick={() => setDatePreset(d)}>
                    {t(`admin.log.date.${d}`)}
                  </button>
                ))}
              </div>
              {dayInput && <div className="mt-2">{dayInput}</div>}
            </div>
            {abnormalSwitch}
            {autoSwitch}
            <button type="button" className="btn-primary w-full py-2 text-sm" onClick={() => setFiltersOpen(false)}>
              {t('admin.log.filtersDone')}
            </button>
          </div>
        </AdminSheet>
      )}
    </div>
  )
}
