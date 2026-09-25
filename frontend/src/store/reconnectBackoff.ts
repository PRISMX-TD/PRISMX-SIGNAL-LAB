// WebSocket 断线重连的退避时长（纯函数，单独可测）。见 useClientSocket 的 scheduleReconnect。
// Reconnect backoff for the client WebSocket (pure, unit-tested). See scheduleReconnect.
//
// 首次重试约 300ms：绝大多数断线是一次性的（切网、代理换连接、部署重启某个 worker），
// 用户要的是「断一下马上回来」，以前固定先等 2 秒，正好够看见横幅闪一下。
// 连续失败才按 2 倍退避，封顶 10 秒——再长的话，网络恢复后用户要白等十几二十秒；
// 真正长时间断线时，online / visibilitychange 监听会立刻重连，不必等计时器。
// 抖动 ±50%：后端重启时所有标签页同时掉线，首轮 300ms 若不散开，就是同一毫秒的
// 一波重连洪峰；300ms 的基数本身很小，±50% 的绝对值也只有 150ms。
//
// The first retry is ~300ms: most drops are one-offs (network switch, proxy
// recycling the connection, a worker restarting in a deploy), and the user wants
// "blip and back" — the old flat 2s was just long enough to flash the banner.
// Only repeated failures back off (×2), capped at 10s; longer means waiting
// pointlessly once the network is back, and genuinely long outages are handled
// by the online / visibilitychange listeners reconnecting at once. ±50% jitter:
// a backend restart drops every tab together, and an un-spread 300ms first round
// would be a single-millisecond reconnect surge; on a 300ms base ±50% is ±150ms.
export const RECONNECT_BASE_MS = 300
export const RECONNECT_MAX_MS = 10_000
export const RECONNECT_JITTER = 0.5

/** attempt 从 0 起计；rand 为 [0,1) 的随机数（测试可注入）/ attempt is 0-based; rand ∈ [0,1) */
export function reconnectDelay(attempt: number, rand: number = Math.random()): number {
  const n = Math.max(0, Math.floor(attempt))
  // 2 ** n 在 n 很大时会变成 Infinity，Math.min 照样夹到上限 / 2**n → Infinity is still capped
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** n)
  const jittered = base * (1 - RECONNECT_JITTER + rand * 2 * RECONNECT_JITTER)
  // 抖动之后也不越过上限 / jitter must not exceed the cap either
  return Math.min(RECONNECT_MAX_MS, Math.round(jittered))
}
