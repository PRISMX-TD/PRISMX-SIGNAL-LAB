// 通用工具 / Common utilities
import i18n from '../i18n'

// 生成幂等下单 ID / generate idempotent client order id
export function clientOrderId(): string {
  return 'co_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

// 后端报错统一是"中文 / English"双语字符串（见各路由的 detail=、mt5_worker.py
// 的 _reject_reason 等），此前不管界面语言设置成什么，用户永远看到两种语言
// 一起怼过来。按当前界面语言取其中一半展示；判断"这是不是双语格式"时要求
// 分隔符前半段含中文字符，避免把偶然带 " / " 的普通英文消息（如残缺的分数、
// 路径）误判成双语格式而错误截断。不是这个格式就原样返回。
// Backend errors are consistently bilingual "中文 / English" strings (each
// router's detail=, mt5_worker.py's _reject_reason, etc.) — regardless of the
// UI language setting, the user always saw both languages shoved together.
// Pick the half matching the current UI language; treating something as this
// bilingual shape requires the first half to actually contain CJK characters,
// so an ordinary English message that happens to contain " / " (a fraction, a
// path) isn't mistakenly split. Falls back to the raw string otherwise.
export function localizeApiError(message: string): string {
  const idx = message.indexOf(' / ')
  if (idx === -1) return message
  const zhPart = message.slice(0, idx).trim()
  const enPart = message.slice(idx + 3).trim()
  if (!zhPart || !enPart || !/[一-鿿]/.test(zhPart)) return message
  const lang = i18n.language?.startsWith('zh') ? 'zh' : 'en'
  return lang === 'zh' ? zhPart : enPart
}

// 格式化时间 / format timestamp
// 后端统一存 UTC 时间。若字符串无时区标记（Postgres TIMESTAMP 读出时常无），
// 补 'Z' 当作 UTC 解析，避免被浏览器按本地时区误读导致差 8 小时。
// 之前这里固定按马来西亚时区显示却完全不标注，国际用户看到的时间点会跟自己
// 的钟差 8 小时却毫无察觉；改为统一显示 UTC 并显式标注"UTC"后缀，不再依赖
// 用户猜时区、也不用再按用户所在地做时区转换。
// Backend stores UTC. If the string carries no tz marker, treat it as UTC.
// This used to render in a hardcoded Malaysia timezone with no label at
// all — an international user's clock would silently be off by up to 8
// hours from what they saw. Now always shown in UTC with an explicit "UTC"
// suffix, so nobody has to guess the timezone or needs per-user conversion.
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '-'
  const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)
  const d = new Date(hasTz ? iso : iso + 'Z')
  return d.toLocaleString('en-GB', {
    timeZone: 'UTC',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }) + ' UTC'
}

// 格式化为含年月日的完整日期时间（用于订阅到期等需要明确年份的场景）
// Format with full date incl. year (for subscription expiry etc. where the year matters).
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '-'
  const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)
  const d = new Date(hasTz ? iso : iso + 'Z')
  return d.toLocaleString('en-GB', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }) + ' UTC'
}

// 解析后端时间为带时区的 Date / parse backend time as a tz-aware Date
export function parseTime(iso: string | null | undefined): Date | null {
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
export function baseSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/[._-].*$/, '')
}

// 每手合约规模（标的单位数），用于按风险百分比估算手数。
// 与保证金估算一样是量级提示：真实合约规模以经纪商 MT5 规格为准。
// Contract size per lot (units of the underlying), used to size volume by a
// risk percentage. Like the margin estimate, this is indicative only — the
// real contract size is whatever the broker's MT5 spec says.
const CONTRACT_SIZE: Record<string, number> = {
  XAUUSD: 100,
  XAGUSD: 5000,
  BTCUSD: 1,
  ETHUSD: 1,
  USOIL: 1000, // 常见经纪商 WTI CFD 标准手规模(桶)，各家可能不同,仅作量级提示
               // common broker standard-lot size (barrels) for WTI CFDs; varies by broker, indicative only
}
const DEFAULT_CONTRACT_SIZE = 100000 // 标准外汇对 / standard FX pairs

export function contractSize(symbol: string): number {
  return CONTRACT_SIZE[baseSymbol(symbol)] ?? DEFAULT_CONTRACT_SIZE
}

// 品种换算到美元(假定账户货币为 USD)所用的基准：
// 'quote' = 报价货币是 USD(如 EURUSD/XAUUSD/BTCUSD)——价格变动 × 合约规模
//           已经是美元金额，无需再乘/除现价。
// 'base'  = 基础货币是 USD(如 USDJPY/USDCHF/USDCAD)——价格变动 × 合约规模
//           算出的是"计价货币"金额，还要再除以现价才能换成美元。
// 未列出的品种（如 EURGBP 这类既非直盘对也非以 USD 报价的交叉盘）返回 null——
// 没有可靠的现价能把它单独换算成美元，调用方应放弃展示估算，而不是给一个
// 看似合理、实则算错的数字。
// USD conversion basis per symbol (assumes a USD account currency):
// 'quote' = quote currency is USD (EURUSD/XAUUSD/BTCUSD, ...) — a price move
//           × contract size is already a USD amount, no extra price factor.
// 'base'  = base currency is USD (USDJPY/USDCHF/USDCAD) — a price move ×
//           contract size yields an amount in the quote currency, which must
//           still be divided by the current price to become USD.
// Symbols not listed (e.g. EURGBP — a cross pair quoted in neither currency
// as USD) return null: there's no single reliable price to convert it to USD
// with, so callers should omit the estimate rather than show a plausible but
// wrong number.
const USD_MARGIN_BASIS: Record<string, 'quote' | 'base'> = {
  EURUSD: 'quote', GBPUSD: 'quote', AUDUSD: 'quote', NZDUSD: 'quote',
  XAUUSD: 'quote', XAGUSD: 'quote', BTCUSD: 'quote', ETHUSD: 'quote', USOIL: 'quote',
  USDJPY: 'base', USDCHF: 'base', USDCAD: 'base',
}

export function usdMarginBasis(symbol: string): 'quote' | 'base' | null {
  return USD_MARGIN_BASIS[baseSymbol(symbol)] ?? null
}

// 按风险百分比建议手数：riskAmount = equity * riskPct / 100。
// 'quote' 基准：手数 = riskAmount / (止损价格距离 × 合约规模)——价格变动本就是
//   美元金额（如 EURUSD/XAUUSD）。
// 'base' 基准：手数 = riskAmount × 现价 / (止损价格距离 × 合约规模)——价格变动
//   算出的是计价货币金额，需要现价把它换算回美元（如 USDJPY：不除以现价会让
//   建议手数偏小近现价倍数，风险百分比功能形同虚设却不报错）。
// 品种基准未知（交叉盘）、止损距离为 0、缺净值或（'base' 品种）缺现价时返回
// null，不给一个算错的数字。
// Suggest a volume from a risk percentage: riskAmount = equity * riskPct/100.
// 'quote' basis: volume = riskAmount / (SL distance × contract size) — a
//   price move is already a USD amount (EURUSD/XAUUSD).
// 'base' basis: volume = riskAmount × current price / (SL distance × contract
//   size) — a price move yields a quote-currency amount that must be rescaled
//   by the current price back to USD (USDJPY: omitting this made the
//   suggested volume too small by roughly the current price's magnitude,
//   silently defeating the risk-percent feature instead of erroring).
// Returns null (no wrong number) when the symbol's basis is unknown (cross
// pairs), the SL distance is 0, equity is missing, or ('base' symbols) the
// current price is missing.
export function suggestVolumeByRisk(
  symbol: string,
  equity: number | null | undefined,
  riskPct: number,
  slPriceDistance: number,
  refPrice?: number | null,
): number | null {
  if (!equity || equity <= 0 || !slPriceDistance || slPriceDistance <= 0 || riskPct <= 0) return null
  const basis = usdMarginBasis(symbol)
  if (basis == null) return null
  const riskAmount = equity * (riskPct / 100)
  const size = contractSize(symbol)
  let raw: number
  if (basis === 'quote') {
    raw = riskAmount / (slPriceDistance * size)
  } else {
    if (!refPrice || refPrice <= 0) return null
    raw = (riskAmount * refPrice) / (slPriceDistance * size)
  }
  return Math.max(0.01, Math.min(10, Math.floor(raw * 100) / 100))
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
