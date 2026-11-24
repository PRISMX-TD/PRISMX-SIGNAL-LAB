// 已平仓明细的数据源（订单页「历史」页签）。
//
// 2026-11-24 之前：接口固定给「所有账号合计最新 200 条」，页面再按账号筛。一个账号平仓多，
// 另一个账号的记录就被挤出这 200 条——真实账号 166 条只显示得出 5 条。
//
// 现在按账号取，而且没有上限：
//   · 最新一页跟以前一样轮询，新平仓落库（tick 变化）立刻重拉；
//   · 更早的页由列表在用户快翻到已加载的末尾时调 loadMore 取回，拼在后面；
//   · 轮询刷新只更新最新一页，已经取回的更早记录原样保留（按 id 合并），所以翻到第 30 页
//     时来一次刷新，不会把人弹回去，也不会丢掉已加载的内容。
//
// Data source for the closed-trade list. The endpoint used to return the newest 200
// legs across every account and the page filtered by account, so a busy account crowded
// the others out. Now it is fetched per account with no cap: the newest page polls as
// before, older pages are appended on demand via loadMore, and a poll refresh merges by
// id so already-loaded history stays put.
import { useCallback, useRef, useState } from 'react'
import { orderApi } from '../api/client'
import type { ClosedTrade } from '../api/types'
import { usePollWhileVisible, winratePollMs } from './usePollWhileVisible'

/** 按 id 合并两批平仓腿（同 id 以 fresh 为准），最新在前。
 *  后端一页里会带上「本页仓位落在后面页里的腿」，下一页会再返回它们，所以必须去重；
 *  排序与后端一致（平仓时间倒序，同一时刻按 id 倒序），列表分组依赖「最新在前」。
 *  Merge two batches of legs by id (fresh wins), newest first. Pages overlap by design
 *  (a page carries its positions' later-page legs), hence the de-dupe. */
export function mergeClosedLegs(fresh: ClosedTrade[], kept: ClosedTrade[]): ClosedTrade[] {
  const byId = new Map<string, ClosedTrade>()
  for (const leg of kept) byId.set(leg.id, leg)
  for (const leg of fresh) byId.set(leg.id, leg)
  return [...byId.values()].sort((a, b) => {
    const ta = a.closedAt ?? ''
    const tb = b.closedAt ?? ''
    if (ta !== tb) return ta < tb ? 1 : -1
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
  })
}

interface Loaded {
  /** 这批数据属于哪个账号 / which account this data belongs to */
  key: string
  trades: ClosedTrade[]
  total: number | null
  /** 取更早一页用的游标；null = 已经到头 / cursor for the next older page; null at the end */
  cursor: string | null
}

export interface ClosedTradesState {
  /** null = 加载中 / loading */
  trades: ClosedTrade[] | null
  /** 该账号的仓位总数（分页器显示总页数用）/ position count for the pager */
  totalPositions: number | null
  hasMore: boolean
  loadingMore: boolean
  /** 取更早的一页。manual = 用户主动翻页触发；上次失败后只有 manual 才会重试，
   *  免得自动预取在断网时原地打转。
   *  Fetch the next older page. After a failure only a manual call retries, so the
   *  automatic prefetch can't spin while offline. */
  loadMore: (manual?: boolean) => void
}

export function useClosedTrades(
  login: string | null,
  opts: { enabled: boolean; tick: number; wsConnected: boolean },
): ClosedTradesState {
  const { enabled, tick, wsConnected } = opts
  const key = login ?? ''
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  // 正在取更早一页的账号（null = 没在取）。带上账号，切账号后旧请求的「加载中」不会串过来。
  // The account whose older page is in flight; keyed so it can't leak across an account switch.
  const [moreKey, setMoreKey] = useState<string | null>(null)

  const keyRef = useRef(key)
  keyRef.current = key
  const loadedRef = useRef(loaded)
  loadedRef.current = loaded
  const flight = useRef<{ key: string; loading: boolean; failed: boolean }>({ key, loading: false, failed: false })
  if (flight.current.key !== key) flight.current = { key, loading: false, failed: false }

  usePollWhileVisible(
    (isCurrent) =>
      // 把 Promise 交回去：失败时 usePollWhileVisible 记下，回前台立刻重拉。
      // Hand the Promise back: on failure usePollWhileVisible retries on return to the foreground.
      orderApi.closedTrades({ login: login ?? undefined })
        .then((r) => {
          if (!isCurrent()) return
          setLoaded((prev) => {
            const same = prev?.key === key
            return {
              key,
              trades: mergeClosedLegs(r.trades, same ? prev.trades : []),
              total: r.totalPositions ?? null,
              // 已经往前翻过就沿用现有游标：它指向已加载内容的末尾，最新一页的游标会倒退回去。
              // Keep the existing cursor once set — it marks the end of what is loaded.
              cursor: same ? prev.cursor : (r.nextCursor ?? null),
            }
          })
        })
        .catch((e) => {
          if (isCurrent()) setLoaded((prev) => (prev?.key === key ? prev : { key, trades: [], total: null, cursor: null }))
          throw e
        }),
    () => winratePollMs(wsConnected),
    // tick 变化 = 后端刚记下新平仓，立刻重拉（不受 2 秒回前台去重影响）。
    // A bumped tick means a new close just landed — refetch now.
    [tick, key],
    { enabled },
  )

  const loadMore = useCallback((manual = false) => {
    const st = flight.current
    const cur = loadedRef.current
    if (!cur || cur.key !== st.key || !cur.cursor || st.loading) return
    if (st.failed && !manual) return
    st.loading = true
    st.failed = false
    const forKey = st.key
    setMoreKey(forKey)
    orderApi.closedTrades({ login: forKey || undefined, cursor: cur.cursor })
      .then((r) => {
        setLoaded((prev) => (prev?.key === forKey
          ? { ...prev, trades: mergeClosedLegs(r.trades, prev.trades), cursor: r.nextCursor ?? null }
          : prev))
      })
      .catch(() => { st.failed = true })
      .finally(() => {
        st.loading = false
        setMoreKey((k) => (k === forKey ? null : k))
      })
  }, [])

  const cur = enabled && loaded?.key === key ? loaded : null
  return {
    trades: cur ? cur.trades : null,
    totalPositions: cur?.total ?? null,
    hasMore: !!cur?.cursor,
    loadingMore: moreKey === key,
    loadMore,
  }
}
