// 「前台才轮询 + 回前台立即补一次（2 秒去重）」的统一模板，取代各处手写的
// setInterval + visibilitychange + focus 三件套。
//
//   · 挂载 / deps 变化：立即 load（immediate:false 时不立即，行为与旧写法一致）。
//   · 之后按 intervalMs 轮询，页面/App 在后台时跳过。intervalMs 可以是函数（例如 WS 在线
//     3 分钟、断线 45 秒）：它在每次检查时现读，所以间隔变化**不需要**重跑 effect，
//     也就不会在 WS 抖动时多打一次请求。检查粒度最长 10 秒，间隔变短最多晚 10 秒生效。
//   · 回前台（focus / visibilitychange / apppack:foreground）：距上次 load 不足 2 秒就跳过。
//     去重只罩住这条路径；deps 变化触发的 load（例如新平仓）不受影响。
//
// One template for "poll only while visible + refetch on return (2s de-dupe)", replacing the
// hand-written setInterval + visibilitychange + focus trio. Mount / deps change loads at once
// (unless immediate:false, matching the old behaviour); then polls every intervalMs, skipping
// while backgrounded. intervalMs may be a function (e.g. 3 min with WS up, 45 s without): it is
// read on each check, so a change needs no effect re-run and a flapping WS causes no extra
// request. Check granularity is at most 10s. Return-to-foreground skips if the last load was
// under 2s ago; that de-dupe covers only this path — deps-triggered loads (e.g. a new close)
// are never swallowed.
import { useEffect, useRef, type DependencyList } from 'react'
import { isAppHidden, onForeground, FOREGROUND_DEDUPE_MS } from './appVisibility'

export const POLL_CHECK_MAX_MS = 10_000

export interface PollOptions {
  /** 挂载 / deps 变化时是否立即执行，默认 true / run immediately on mount or deps change (default true) */
  immediate?: boolean
  /** 不启用时什么都不做 / do nothing when false (default true) */
  enabled?: boolean
}

/** 与 React 无关的核心，便于单测。返回停止函数。/ React-free core for unit tests; returns stop. */
export function startPolling(
  load: () => void,
  intervalMs: number | (() => number),
  immediate = true,
): () => void {
  let stopped = false
  let lastAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const currentMs = () => (typeof intervalMs === 'function' ? intervalMs() : intervalMs)
  const run = () => {
    lastAt = Date.now()
    load()
  }
  if (immediate) run()
  const schedule = () => {
    // 下一次检查落在「到期时刻」，但最长 10 秒，这样间隔变化最多晚 10 秒生效。
    // The next check lands on the due moment, capped at 10s so an interval change takes effect
    // at most 10s late.
    const remaining = currentMs() - (Date.now() - lastAt)
    timer = setTimeout(check, Math.min(POLL_CHECK_MAX_MS, Math.max(remaining, 100)))
  }
  const check = () => {
    if (stopped) return
    // 50ms 容差：定时器略早触发时不至于跳过一整轮 / 50ms tolerance so a slightly early timer doesn't skip a cycle
    if (!isAppHidden() && Date.now() - lastAt >= currentMs() - 50) run()
    schedule()
  }
  schedule()
  const off = onForeground(() => {
    if (Date.now() - lastAt < FOREGROUND_DEDUPE_MS) return
    run()
  })
  return () => {
    stopped = true
    if (timer !== undefined) clearTimeout(timer)
    off()
  }
}

export function usePollWhileVisible(
  // isCurrent()：这一轮 effect 是否仍有效（卸载 / deps 变化后为 false），用来丢掉过期响应。
  // isCurrent(): whether this effect run is still live (false after unmount / deps change).
  load: (isCurrent: () => boolean) => void,
  intervalMs: number | (() => number),
  deps: DependencyList,
  opts: PollOptions = {},
) {
  const loadRef = useRef(load)
  loadRef.current = load
  const msRef = useRef(intervalMs)
  msRef.current = intervalMs
  const { immediate = true, enabled = true } = opts
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const stop = startPolling(
      () => loadRef.current(() => alive),
      () => (typeof msRef.current === 'function' ? msRef.current() : msRef.current),
      immediate,
    )
    return () => {
      alive = false
      stop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, enabled, immediate])
}

// 胜率卡 / 已平仓明细的轮询间隔：WS 在线时 CLOSED_TRADE_NEW 已经推 closedTradeTick，轮询只是兜底，
// 放到 3 分钟；WS 断开回到 45 秒。（wsConnected 在心跳判死前可能仍为 true，最坏 3 分钟才兜底。）
// Poll interval for the win-rate card / closed trades: with the WS up CLOSED_TRADE_NEW already bumps
// closedTradeTick so polling is only a fallback (3 min); 45s while it is down. (wsConnected may stay
// true until the heartbeat declares a zombie dead, so the worst-case fallback is 3 minutes.)
export const WINRATE_POLL_MS = 45_000
export const WINRATE_POLL_WS_MS = 180_000
export const winratePollMs = (wsConnected: boolean) => (wsConnected ? WINRATE_POLL_WS_MS : WINRATE_POLL_MS)
