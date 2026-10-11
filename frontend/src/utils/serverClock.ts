// 服务器时钟：本机时钟与服务器的偏差估计，供 K 线收线倒计时用。手机时间不准（手动调过、
// 没开自动对时）时，直接拿 Date.now() 倒计时会和真实收线差出几秒甚至几分钟。
// 样本来自 /chart/latest 响应里的 now（服务器 epoch 秒）：偏差 = now − 请求往返的中点。
// 只保留往返最短的那次——往返越短，中点越接近服务器打时间戳的那一刻。
// Server clock: an estimate of the device clock's offset from the server, for the
// chart's bar-close countdown. Samples come from /chart/latest's `now`; offset =
// now − the round trip's midpoint. Only the shortest round trip is kept, since its
// midpoint is closest to the moment the server stamped the time.

let offsetMs = 0
let bestRttMs = Infinity
let sampledAt = 0

// 样本最多信这么久：手机睡眠 / 改时间之后旧偏差会失效，过期就允许更长往返的样本覆盖。
// Trust a sample this long; after sleep or a manual clock change the old offset may be wrong.
const SAMPLE_TTL_MS = 10 * 60_000

export function recordServerTime(serverSec: number | null | undefined, sentAtMs: number, receivedAtMs: number): void {
  if (typeof serverSec !== 'number' || !Number.isFinite(serverSec)) return
  const rtt = receivedAtMs - sentAtMs
  if (rtt < 0) return
  if (rtt > bestRttMs && receivedAtMs - sampledAt < SAMPLE_TTL_MS) return
  bestRttMs = rtt
  sampledAt = receivedAtMs
  offsetMs = serverSec * 1000 - (sentAtMs + rtt / 2)
}

// 校准后的「现在」（毫秒）/ calibrated "now" in ms
export function serverNowMs(): number {
  return Date.now() + offsetMs
}
