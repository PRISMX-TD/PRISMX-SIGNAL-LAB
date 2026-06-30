// 通用工具 / Common utilities

// 生成幂等下单 ID / generate idempotent client order id
export function clientOrderId(): string {
  return 'co_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

// 格式化时间 / format timestamp
// 后端统一存 UTC 时间。若字符串无时区标记（Postgres TIMESTAMP 读出时常无），
// 补 'Z' 当作 UTC 解析，避免被浏览器按本地时区误读导致差 8 小时；
// 再固定按马来西亚时区（Asia/Kuala_Lumpur, UTC+8）显示。
// Backend stores UTC. If the string carries no tz marker, treat it as UTC,
// then always render in Malaysia time.
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)
  const d = new Date(hasTz ? iso : iso + 'Z')
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Kuala_Lumpur',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

// 解析后端时间为带时区的 Date / parse backend time as a tz-aware Date
function parseTime(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)
  return new Date(hasTz ? iso : iso + 'Z')
}

// 每个品种一个 pip 的价格大小，用于把价差换算成点数。
// 匹配不到的品种返回 null，调用方只显示价差、不显示点数。
// Price size of one pip per symbol, to convert price distance into pips.
// Unknown symbols return null; callers then show price distance only.
const PIP_SIZE: Record<string, number> = {
  EURUSD: 0.0001,
  GBPUSD: 0.0001,
  AUDUSD: 0.0001,
  NZDUSD: 0.0001,
  USDCHF: 0.0001,
  USDCAD: 0.0001,
  EURGBP: 0.0001,
  EURJPY: 0.01,
  GBPJPY: 0.01,
  USDJPY: 0.01,
  XAUUSD: 0.1,
  XAGUSD: 0.01,
  BTCUSD: 1,
  ETHUSD: 0.1,
}

// 去掉券商后缀后取基础品种名 / strip broker suffix to get the base symbol
function baseSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/[._-].*$/, '')
}

// 价差换算为点数；未知品种返回 null / price distance to pips; null if unknown symbol
export function toPips(symbol: string, priceDiff: number): number | null {
  const size = PIP_SIZE[baseSymbol(symbol)]
  if (!size) return null
  return Math.abs(priceDiff) / size
}

export interface RiskReward {
  // 风险/回报的点数（未知品种为 null）/ risk & reward in pips (null if unknown)
  riskPips: number | null
  rewardPips: number | null
  // 价格差绝对值 / absolute price distances
  riskPrice: number
  rewardPrice: number
  // 回报/风险比，风险为 0 时为 null / reward-to-risk ratio, null if risk is 0
  rr: number | null
}

// 由 entry/SL/TP 计算风险回报；缺失任一价格则返回 null。
// Compute risk-reward from entry/SL/TP; null if any price is missing.
export function calcRiskReward(
  symbol: string,
  entry: number | null,
  stopLoss: number | null,
  takeProfit: number | null,
): RiskReward | null {
  if (entry == null || stopLoss == null || takeProfit == null) return null
  const riskPrice = Math.abs(entry - stopLoss)
  const rewardPrice = Math.abs(takeProfit - entry)
  return {
    riskPrice,
    rewardPrice,
    riskPips: toPips(symbol, riskPrice),
    rewardPips: toPips(symbol, rewardPrice),
    rr: riskPrice > 0 ? rewardPrice / riskPrice : null,
  }
}

export interface Countdown {
  // 距到期的毫秒数（已过期为 0）/ ms until expiry (0 if expired)
  remainMs: number
  // 剩余占总时长的比例 0~1 / remaining fraction of the full lifespan 0~1
  fraction: number
  // 是否已过期 / whether already expired
  expired: boolean
  // mm:ss 文本 / mm:ss text
  text: string
}

// 计算信号到期倒计时。totalMs 为信号的总有效时长（默认 10 分钟，与后端一致）。
// Compute expiry countdown. totalMs is the signal lifespan (default 10 min, matching backend).
export function calcCountdown(
  expireAt: string | null | undefined,
  totalMs = 10 * 60 * 1000,
  now: number = Date.now(),
): Countdown | null {
  const exp = parseTime(expireAt)
  if (!exp) return null
  const remainMs = Math.max(0, exp.getTime() - now)
  const expired = remainMs <= 0
  const totalMins = Math.floor(remainMs / 60000)
  const secs = Math.floor((remainMs % 60000) / 1000)
  const text = `${String(totalMins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return {
    remainMs,
    fraction: Math.max(0, Math.min(1, totalMs > 0 ? remainMs / totalMs : 0)),
    expired,
    text,
  }
}
