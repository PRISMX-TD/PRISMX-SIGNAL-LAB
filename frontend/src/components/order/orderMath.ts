// 下单表单的纯计算：手数建议 / 步进 / 止损止盈方向校验 / 保证金与风险估算。
//
// 三个下单入口（信号滑动弹窗 SlideOrderModal、图表手动弹窗 ChartOrderModal、终端
// 停靠面板 OrderTicket）以前各自复制了一份这些公式，2026-09-06 合并到这里：改一处
// 三处同时生效，不会再出现"一处改了校验规则、另两处忘了"的分叉。全部是无副作用的
// 纯函数，与 React 无关；状态编排在 useOrderForm.ts。
//
// Pure order-form math shared by the three order entry points (signal slide
// modal, chart manual modal, docked terminal ticket). Each used to carry its own
// copy of these formulas; merged 2026-09-06 so a rule change lands everywhere at
// once. No React here — state orchestration lives in useOrderForm.ts.
import { contractSize, suggestVolumeByRisk, usdMarginBasis } from '../../api/utils'

export const QUICK_LOTS = [0.01, 0.1, 0.5, 1.0]
export const QUICK_RISK_PCTS = [0.5, 1, 2, 3]
export const VOLUME_MIN = 0.01
export const VOLUME_MAX = 10
export const VOLUME_STEP = 0.01

/** 按净值建议默认手数：净值 ÷ 200，夹在 0.01～1 手之间，向下取到 0.01。
 *  Default lots from equity: equity / 200, clamped to 0.01–1, floored to 0.01. */
export function suggestVolume(equity?: number | null): string {
  if (!equity || equity <= 0) return '0.10'
  const v = Math.max(VOLUME_MIN, Math.min(equity / 200, 1))
  return (Math.floor(v * 100) / 100).toFixed(2)
}

/** 失焦时把输入框里的手数收敛到合法范围（空 / 非法 → 0.01，上限 10）。
 *  Normalize the typed volume on blur (empty / invalid → 0.01, capped at 10). */
export function normalizeVolume(raw: string): string {
  const v = parseFloat(raw)
  return (!v || v <= 0 ? VOLUME_MIN : Math.min(VOLUME_MAX, v)).toFixed(2)
}

/** ± 一步（0.01 手），夹在 0.01～10。/ Step by 0.01 lot, clamped to 0.01–10. */
export function stepVolume(raw: string, dir: 1 | -1): string {
  const v = parseFloat(raw) || VOLUME_MIN
  return String(Math.max(VOLUME_MIN, Math.min(VOLUME_MAX, +(v + dir * VOLUME_STEP).toFixed(2))))
}

/** 只留数字和小数点 / keep digits and the decimal point only. */
export function sanitizeDecimal(raw: string): string {
  return raw.replace(/[^0-9.]/g, '')
}

/** 空串 → null，否则 parseFloat（可能是 NaN，由校验函数处理）。
 *  Empty → null, else parseFloat (NaN is handled by the validators). */
export function parseOptionalNumber(raw: string): number | null {
  return raw.trim() === '' ? null : parseFloat(raw)
}

export interface SlTpCheck {
  slInvalid: boolean
  tpInvalid: boolean
}

/**
 * 止损 / 止盈方向校验。买单：止损须低于参考价、止盈须高于参考价；卖单相反。
 * 即便拿不到参考价（entryRef 为 null），只要两者都填了，买单必须止损 < 止盈、
 * 卖单必须止损 > 止盈——挡住"把 SL / TP 填反"这类与参考价无关的错误，否则要等
 * 指令发到 MT5 才被拒。
 *
 * SL/TP side check. BUY: SL below and TP above the reference; SELL reversed.
 * Even with no reference price, a filled pair must satisfy SL < TP (BUY) or
 * SL > TP (SELL), catching a swapped SL/TP before MT5 has to reject it.
 */
export function checkSlTp(isBuy: boolean, slNum: number | null, tpNum: number | null, entryRef: number | null): SlTpCheck {
  const slOk = slNum != null && !Number.isNaN(slNum)
  const tpOk = tpNum != null && !Number.isNaN(tpNum)
  const cross = slOk && tpOk && (isBuy ? slNum! >= tpNum! : slNum! <= tpNum!)
  const slInvalid = cross || (slOk && entryRef != null && (isBuy ? slNum! >= entryRef : slNum! <= entryRef))
  const tpInvalid = cross || (tpOk && entryRef != null && (isBuy ? tpNum! <= entryRef : tpNum! >= entryRef))
  return { slInvalid, tpInvalid }
}

/**
 * 粗估保证金占用（假定账户货币为 USD）：'quote' 基准品种（如 XAUUSD / EURUSD）是
 * 手数 × 合约规模 × 现价 ÷ 杠杆——早期漏乘现价，黄金 / 白银 / 加密货币的估算偏小
 * 上千倍；'base' 基准品种（如 USDJPY）现价已内含在合约规模的美元价值里，不能再乘。
 * 基准未知的交叉盘（如 EURGBP）没有可靠现价能单独换算成美元，返回 null 而不是给
 * 一个算错的数。
 *
 * Rough margin (assumes a USD account). 'quote'-basis symbols need lots ×
 * contract size × price / leverage (omitting the price once understated gold /
 * crypto by thousands of times); 'base'-basis symbols already carry their USD
 * notional in the contract size. Unknown-basis crosses return null rather than
 * a plausible-looking wrong number.
 */
export function estimateMargin(symbol: string, volumeRaw: string, leverage: number | null | undefined, entryRef: number | null): number | null {
  const vol = parseFloat(volumeRaw)
  if (!vol || vol <= 0 || !leverage || leverage <= 0) return null
  const basis = usdMarginBasis(symbol)
  if (basis == null) return null
  const size = contractSize(symbol)
  if (basis === 'base') return (vol * size) / leverage
  if (!entryRef || entryRef <= 0) return null
  return (vol * size * entryRef) / leverage
}

export interface RiskPreview {
  riskUsd: number | null
  rewardUsd: number | null
  rr: number | null
}

/** 风险 / 盈利预览（美元近似）：入场→止损 / 止盈的距离 × 每点价值。
 *  Risk / reward preview (USD approx): distance to SL / TP × per-point value. */
export function previewRisk(symbol: string, volumeRaw: string, entryRef: number | null, slNum: number | null, tpNum: number | null): RiskPreview | null {
  if (entryRef == null || slNum == null || Number.isNaN(slNum)) return null
  const basis = usdMarginBasis(symbol)
  if (basis == null) return null
  const size = contractSize(symbol)
  const vol = parseFloat(volumeRaw)
  if (!vol || vol <= 0) return null
  const toUsd = (priceDist: number): number | null => {
    if (basis === 'base') {
      if (!entryRef || entryRef <= 0) return null
      return (priceDist * size * vol) / entryRef
    }
    return priceDist * size * vol
  }
  const riskUsd = toUsd(Math.abs(entryRef - slNum))
  const rewardUsd = tpNum != null && !Number.isNaN(tpNum) ? toUsd(Math.abs(tpNum - entryRef)) : null
  const rr = riskUsd && rewardUsd ? rewardUsd / riskUsd : null
  return { riskUsd, rewardUsd, rr }
}

/** 按风险百分比建议手数：净值 × 风险% ÷ 止损距离；算不出（无止损 / 无参考价 /
 *  不支持的品种）返回 null。/ Lots from a risk percentage; null when it can't be sized. */
export function suggestVolumeForRisk(symbol: string, equity: number | null | undefined, riskPctRaw: string, slNum: number | null, entryRef: number | null): string | null {
  if (slNum == null || Number.isNaN(slNum) || entryRef == null) return null
  const distance = Math.abs(entryRef - slNum)
  const pct = parseFloat(riskPctRaw) || 0
  const suggested = suggestVolumeByRisk(symbol, equity, pct, distance, entryRef)
  return suggested != null ? suggested.toFixed(2) : null
}

export function formatMoney(n?: number | null, dash = '-'): string {
  return n == null ? dash : n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}
