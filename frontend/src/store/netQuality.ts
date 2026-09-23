// 连接质量：由 useClientSocket 的心跳 PING→PONG 往返写入，顶栏信号图标读取。
// 单独一个模块级小仓库而不是塞进 LiveContext：延迟每 10 秒变一次，放进 context
// 会让所有 useLive() 的组件跟着重渲染，而关心它的只有一个图标。
//
// Connection quality: written by useClientSocket from heartbeat PING→PONG round
// trips, read by the header signal icon. A module-level store rather than part of
// LiveContext: latency changes every 10s, and putting it in the context would
// re-render every useLive() consumer when only one icon cares.
import { useSyncExternalStore } from 'react'

export type NetState = 'connecting' | 'online' | 'offline'
export type NetLevel = 0 | 1 | 2 | 3 | 4

export interface NetQuality {
  state: NetState
  // 最近若干次往返（毫秒），新的在后 / recent round trips in ms, newest last
  samples: number[]
  // 最后一次收到任意帧的时间 / last time any frame arrived
  lastFrameAt: number | null
  // 本次页面生命周期内断线重连次数 / reconnects during this page's lifetime
  reconnects: number
}

// 颜色分界（毫秒）。改这里即可。/ Latency thresholds in ms — tune here.
export const GOOD_MS = 150
export const FAIR_MS = 400
const MAX_SAMPLES = 10

let snap: NetQuality = { state: 'connecting', samples: [], lastFrameAt: null, reconnects: 0 }
const listeners = new Set<() => void>()
let everOnline = false

const emit = (next: NetQuality) => {
  snap = next
  listeners.forEach((l) => l())
}

export const netQuality = {
  setState(state: NetState) {
    if (state === snap.state) return
    const reconnects = state === 'online' && everOnline ? snap.reconnects + 1 : snap.reconnects
    if (state === 'online') everOnline = true
    // 断线后旧样本不代表新连接 / old samples say nothing about the next connection
    emit({ ...snap, state, reconnects, samples: state === 'online' ? snap.samples : [] })
  },
  addSample(ms: number) {
    emit({ ...snap, samples: [...snap.samples, Math.round(ms)].slice(-MAX_SAMPLES) })
  },
  // 不 emit：每 1.5 秒一帧报价，没必要为此重渲染；图标打开面板时自己按秒刷新。
  // No emit: quotes arrive every 1.5s; the open panel ticks on its own.
  touch() {
    snap.lastFrameAt = Date.now()
  },
}

// 捎在下一帧 PING 里给服务端做管理后台统计（services/net_quality.py）。
// 不另发请求：心跳本来就要发，多带两个数字。
// Rides on the next PING for the admin stats (services/net_quality.py) — no
// extra request, the heartbeat goes out anyway.
export function pingPayload(): { rtt?: number; jit?: number; app: boolean } {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  const app = !!cap?.isNativePlatform?.()
  if (snap.state !== 'online' || !snap.samples.length) return { app }
  return { rtt: snap.samples[snap.samples.length - 1], jit: jitter(snap) ?? undefined, app }
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useNetQuality(): NetQuality {
  return useSyncExternalStore(subscribe, () => snap)
}

// 用最近 3 次的中位数定格数：单次尖峰不至于让图标乱跳。
// Bars from the median of the last 3 samples, so one spike doesn't flicker the icon.
export function latestRtt(q: NetQuality): number | null {
  if (!q.samples.length) return null
  const recent = q.samples.slice(-3).sort((a, b) => a - b)
  return recent[Math.floor(recent.length / 2)]
}

export function jitter(q: NetQuality): number | null {
  if (q.samples.length < 2) return null
  let sum = 0
  for (let i = 1; i < q.samples.length; i++) sum += Math.abs(q.samples[i] - q.samples[i - 1])
  return Math.round(sum / (q.samples.length - 1))
}

export function netLevel(q: NetQuality): NetLevel {
  if (q.state !== 'online') return 0
  const rtt = latestRtt(q)
  if (rtt == null) return 3 // 刚连上还没测到 / just connected, not yet measured
  if (rtt < GOOD_MS) return 4
  if (rtt < FAIR_MS) return 3
  return 2
}
