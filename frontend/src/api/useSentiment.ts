// 社区多空情绪 hook：读后端缓存接口（数据源见后端 sentiment_store.py 说明）。
// Community sentiment hook: reads the backend cache endpoint (data source
// documented in the backend's sentiment_store.py).
//
// 数据放在模块级（useSyncExternalStore），不放组件 state：仪表盘是路由页，切页来回一次就
// 重挂一次，以前每次都重新打 /sentiment。现在 5 分钟内重挂直接用缓存；定时器只在有订阅者
// 时才跑，最后一个订阅者离开就停，没人看的页面不会在后台继续轮询。
// State lives at module level (useSyncExternalStore) rather than per component: the dashboard
// is a routed page and remounts on every visit, refetching /sentiment each time. Now a remount
// within 5 minutes uses the cache; the timer runs only while someone is subscribed and stops
// when the last subscriber leaves, so an unwatched page never polls in the background.
import { useSyncExternalStore } from 'react'
import { sentimentApi } from './client'
import type { SentimentRatio } from './types'

export const SENTIMENT_POLL_MS = 5 * 60 * 1000 // 每 5 分钟刷新一次 / refresh every 5 min

export interface SentimentState {
  sentiment: Record<string, SentimentRatio>
  loading: boolean
  error: string | null
}

const INITIAL: SentimentState = { sentiment: {}, loading: true, error: null }
let state: SentimentState = INITIAL
// 上次成功拉取的时刻；0 = 还没成功过 / when the last fetch succeeded; 0 = never
let fetchedAt = 0
let timer: ReturnType<typeof setTimeout> | undefined
let inflight: Promise<void> | null = null
const subs = new Set<() => void>()

function emit(next: SentimentState) {
  state = next
  subs.forEach((fn) => fn())
}

async function refresh(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    try {
      const data = await sentimentApi.get()
      fetchedAt = Date.now()
      emit({ sentiment: data.sentiment, loading: false, error: null })
    } catch (err: unknown) {
      // 失败保留上一份数据，只挂上错误 / keep the previous data, just attach the error
      emit({ ...state, loading: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      inflight = null
    }
  })()
  return inflight
}

function schedule(delayMs: number) {
  if (timer !== undefined) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = undefined
    if (subs.size === 0) return
    void refresh().finally(() => {
      if (subs.size > 0) schedule(SENTIMENT_POLL_MS)
    })
  }, delayMs)
}

export function subscribeSentiment(listener: () => void): () => void {
  subs.add(listener)
  if (subs.size === 1) {
    // 第一个订阅者：缓存不足 5 分钟就直接用，并把下一次刷新排在缓存到期那一刻。
    // First subscriber: use the cache if it is under 5 minutes old and schedule the next refresh
    // for the moment it goes stale.
    const age = Date.now() - fetchedAt
    if (fetchedAt > 0 && age < SENTIMENT_POLL_MS) {
      schedule(SENTIMENT_POLL_MS - age)
    } else {
      void refresh().finally(() => {
        if (subs.size > 0) schedule(SENTIMENT_POLL_MS)
      })
    }
  }
  return () => {
    subs.delete(listener)
    if (subs.size === 0 && timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
}

export function getSentimentState(): SentimentState {
  return state
}

/** 仅测试用 / test-only */
export function __resetSentimentForTest() {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  inflight = null
  subs.clear()
  fetchedAt = 0
  state = INITIAL
}

export function useSentiment(): SentimentState {
  return useSyncExternalStore(subscribeSentiment, getSentimentState, getSentimentState)
}
