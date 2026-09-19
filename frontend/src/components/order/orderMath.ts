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
import type { Quote } from '../../api/types'
import { contractSize, lotStep, minLot, roundLots, suggestVolumeByRisk, usdMarginBasis } from '../../api/utils'

const QUICK_LOTS_BASE = [0.01, 0.1, 0.5, 1.0]
export const QUICK_RISK_PCTS = [0.5, 1, 2, 3]
export const VOLUME_MIN = 0.01
export const VOLUME_MAX = 10

/** 快捷手数按品种过滤：步长 0.1 的品种（原油）填不出 0.01，别给用户一个点了就报错的按钮。
 *  Quick-lot chips filtered by the symbol's step: a 0.1-step symbol cannot take 0.01. */
export function quickLots(symbol?: string | null): number[] {
  const step = lotStep(symbol)
  const list = QUICK_LOTS_BASE.filter((v) => Math.abs(v - Math.round(v / step) * step) <= step * 1e-6)
  return list.length > 0 ? list : [minLot(symbol)]
}

/** 手数小数位数：由步长决定（0.01 → 2 位，0.1 → 1 位）。 */
function lotDigits(symbol?: string | null): number {
  return lotStep(symbol) >= 0.1 ? 1 : 2
}

/** 默认手数：用户上次自己设的手数（usePrefs 记忆，跨设备），没有就 0.01。
 *  以前按净值 ÷ 200 推一个——一万美元的账户一打开就是 1.00 手，用户每次都得
 *  改回去；现在从最小手数起步、记住上次的值。
 *  Default lots: the user's last explicitly-set volume (remembered via prefs),
 *  else 0.01. The old equity/200 heuristic opened a $10k account at 1.00 lot. */
export function defaultVolume(remembered?: number | string | null, symbol?: string | null): string {
  const v = typeof remembered === 'number' ? remembered : parseFloat(remembered ?? '')
  const d = lotDigits(symbol)
  if (!(v > 0)) return minLot(symbol).toFixed(d)
  return clampLots(Math.min(VOLUME_MAX, v), symbol).toFixed(d)
}

/** 手数夹到 [最小手数, 10]，并向下吸附到该品种的步长上。
 *  原先写死按 0.01 取整，对步长 0.1 的原油会产出 0.13 这种永远不会成交的手数。
 *  Clamp to [minLot, 10] and floor onto the symbol's step. The old hardcoded 0.01
 *  floor produced volumes like 0.13 on WTI, which can never fill. */
export function clampLots(raw: number, symbol?: string | null): number {
  const step = lotStep(symbol)
  const floored = Math.floor(raw / step + 1e-6) * step
  return roundLots(Math.max(minLot(symbol), Math.min(VOLUME_MAX, floored)))
}

/** 失焦时把输入框里的手数收敛到合法范围（空 / 非法 → 0.01，上限 10）。
 *  Normalize the typed volume on blur (empty / invalid → 0.01, capped at 10). */
export function normalizeVolume(raw: string, symbol?: string | null): string {
  const v = parseFloat(raw)
  if (!v || v <= 0) return minLot(symbol).toFixed(lotDigits(symbol))
  return clampLots(v, symbol).toFixed(lotDigits(symbol))
}

/** ± 一步（该品种的步长），夹在 [最小手数, 10]。/ Step by the symbol's lot step. */
export function stepVolume(raw: string, dir: 1 | -1, symbol?: string | null): string {
  const step = lotStep(symbol)
  const v = parseFloat(raw) || minLot(symbol)
  return clampLots(v + dir * step, symbol).toFixed(lotDigits(symbol))
}

/**
 * 把用户敲进价格 / 手数输入框的东西规整成一个能被 parseFloat 正确读出来的十进制串。
 *
 * 这不只是"过滤非法字符"，几种最常见的输入都必须被**读懂**而不是被丢掉：
 *
 *   全角数字 `３３００`  中文输入法没切回半角就会打出来，双语界面上极其常见。
 *                      直接按非法字符删掉等于把用户填的止损清空。→ 转成半角。
 *   逗号小数点 `3300,5` 许多地区的小数点就是逗号。只删非法字符会得到 `33005`
 *                      ——比原来错得更离谱。→ 当成小数点。
 *   多个小数点 `1.2.3`  多半是手滑。`parseFloat` 会悄悄读成 `1.2`，而 `1.2` 作为
 *                      黄金的止损方向校验还恰好通过。→ 只保留第一个小数点。
 *
 * 为什么这件事值得这么较真：止损输入框此前完全不过滤，上面三种输入都会静默产生
 * 一个错误的止损、或者干脆变成 NaN 最后以 `null` 发出去——下的是裸单，而界面全程
 * 不报错（2026-09-19 审计）。
 *
 * Normalize what a user typed into a price / lot field into a string parseFloat
 * can read correctly. This deliberately *understands* the common inputs instead of
 * discarding them: full-width digits (a Chinese IME left in full-width mode, very
 * likely on a bilingual UI), a comma decimal separator (stripping it turns 3300,5
 * into 33005 — worse than the original), and a stray second dot (parseFloat
 * silently reads 1.2.3 as 1.2, which even passes the SL side check for gold).
 *
 * The stop-loss field previously applied no filtering at all, so each of these
 * silently produced a wrong stop or a NaN that went out as `null` — a naked order,
 * with no error shown anywhere (2026-09-19 audit).
 */
export function sanitizeDecimal(raw: string): string {
  const normalized = raw
    // 全角数字 / 全角句点 / 全角逗号 → 半角 / full-width digits and separators → ASCII
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/[，,]/g, '.')
    .replace(/[^0-9.]/g, '')
  // 只保留第一个小数点，其余丢掉（`1.2.3` → `1.23`，而不是被 parseFloat 读成 `1.2`）
  // Keep only the first decimal point, dropping the rest.
  const first = normalized.indexOf('.')
  if (first === -1) return normalized
  return normalized.slice(0, first + 1) + normalized.slice(first + 1).replace(/\./g, '')
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
  // 「填了但读不出来」必须判非法，不能当成「没填」。
  //
  // 原来这里是 `slOk = slNum != null && !Number.isNaN(slNum)`，NaN 走进了「没填」
  // 那一支：slInvalid 恒为 false，界面不报错、滑动确认不禁用，而 NaN 经
  // JSON.stringify 会变成 `null` —— 下出去的是一张没有止损的裸单，用户却以为自己
  // 设了止损。sanitizeDecimal 已经在输入层把常见的脏输入救回来了，这里是最后一道
  // 兜底（比如用户只敲了一个 `.`）。
  //
  // "Filled but unreadable" must be invalid, never "empty". NaN used to fall into
  // the empty branch, leaving slInvalid false — no error shown, submission not
  // blocked — while JSON.stringify turns NaN into `null`, i.e. a naked order the
  // user believes is protected. sanitizeDecimal now rescues the common cases at the
  // input layer; this is the last-resort backstop (a lone "." still parses to NaN).
  const slNan = slNum != null && Number.isNaN(slNum)
  const tpNan = tpNum != null && Number.isNaN(tpNum)
  const slOk = slNum != null && !slNan
  const tpOk = tpNum != null && !tpNan
  const cross = slOk && tpOk && (isBuy ? slNum! >= tpNum! : slNum! <= tpNum!)
  const slInvalid = slNan || cross || (slOk && entryRef != null && (isBuy ? slNum! >= entryRef : slNum! <= entryRef))
  const tpInvalid = tpNan || cross || (tpOk && entryRef != null && (isBuy ? tpNum! <= entryRef : tpNum! >= entryRef))
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
export function estimateMargin(symbol: string, volumeRaw: string, leverage: number | null | undefined, entryRef: number | null, spec?: SymbolSpec): number | null {
  const vol = parseFloat(volumeRaw)
  if (!vol || vol <= 0 || !leverage || leverage <= 0) return null
  const basis = usdMarginBasis(symbol)
  if (basis == null) return null
  const size = specContractSize(spec) ?? contractSize(symbol)
  if (basis === 'base') return (vol * size) / leverage
  if (!entryRef || entryRef <= 0) return null
  return (vol * size * entryRef) / leverage
}

// ---- 券商合约规格 / broker contract spec ------------------------------------
//
// 桥接 v1.3.23 起，按账户报价（Quote）自带这家券商对该品种的真实规格：每手标的数量
// contractSize、最小变动价位 tickSize、以及一个 tick 的亏损方向盈亏 tickValue（账户
// 货币）。有它就用 MT5 自己的盈亏公式：
//     亏损 = 手数 × (止损距离 ÷ tickSize) × tickValue
// 对外汇直盘 / 交叉盘 / 贵金属 / 加密 / 指数一律成立，不再需要"美元在报价方还是
// 基础方"的分支，也不再依赖写死的合约规模表——那张表在合作券商上 ETHUSD、WTI 就
// 各错了 10 倍，换一家券商更没法保证。拿不到规格（网关账户 / 旧版桥接 / EA 全站
// 报价）才退回下面按基准 + 兜底表的老算法。
//
// Since bridge 1.3.23 a per-account Quote carries the broker's real spec for
// the symbol (units per lot, tick size, loss-side tick value in the deposit
// currency). With it we use MT5's own P&L formula, valid for every asset class
// and independent of the hard-coded table (which was 10x off for ETHUSD and
// WTI at the partner broker). Without it, fall back to the basis + table math.
export type SymbolSpec = Pick<Quote, 'contractSize' | 'tickSize' | 'tickValue'> | null | undefined

interface TickSpec { tickSize: number; tickValue: number }

/** 有完整 tick 规格 → 可精确换算成账户货币 / full tick spec → exact conversion */
export function hasTickSpec(spec: SymbolSpec): spec is TickSpec & { contractSize?: number } {
  return !!spec && (spec.tickSize ?? 0) > 0 && (spec.tickValue ?? 0) > 0
}

/** 券商上报的每手规模（无 / 非正数 → null）/ broker-reported units per lot */
function specContractSize(spec: SymbolSpec): number | null {
  return spec?.contractSize && spec.contractSize > 0 ? spec.contractSize : null
}

/** 价格距离 → 每手亏损（账户货币）/ price distance → loss per lot (deposit currency) */
function lossPerLot(priceDist: number, spec: TickSpec): number {
  return (priceDist / spec.tickSize) * spec.tickValue
}

/** 该品种能否按风险%算手数：有券商规格一定能；否则要在美元基准表里。
 *  Whether risk-% sizing is possible: always with a broker spec, else only
 *  for symbols with a known USD basis. */
export function canSizeByRisk(symbol: string, spec?: SymbolSpec): boolean {
  return hasTickSpec(spec) || usdMarginBasis(symbol) != null
}

export interface RiskPreview {
  riskUsd: number | null
  rewardUsd: number | null
  rr: number | null
}

/** 风险 / 盈利预览（账户货币）：优先券商规格，否则基准 + 兜底表近似。盈利侧也用
 *  亏损方向的 tickValue，比真实盈利略保守（差一个换算点差），预览够用。
 *  Risk / reward preview in the deposit currency: broker spec first, else the
 *  basis + table approximation. The reward side reuses the loss-side tick
 *  value, slightly conservative — fine for a preview. */
export function previewRisk(symbol: string, volumeRaw: string, entryRef: number | null, slNum: number | null, tpNum: number | null, spec?: SymbolSpec): RiskPreview | null {
  if (entryRef == null || slNum == null || Number.isNaN(slNum)) return null
  const vol = parseFloat(volumeRaw)
  if (!vol || vol <= 0) return null
  let toUsd: (priceDist: number) => number | null
  if (hasTickSpec(spec)) {
    toUsd = (priceDist) => lossPerLot(priceDist, spec) * vol
  } else {
    const basis = usdMarginBasis(symbol)
    if (basis == null) return null
    const size = specContractSize(spec) ?? contractSize(symbol)
    toUsd = (priceDist) => {
      if (basis === 'base') {
        if (!entryRef || entryRef <= 0) return null
        return (priceDist * size * vol) / entryRef
      }
      return priceDist * size * vol
    }
  }
  const riskUsd = toUsd(Math.abs(entryRef - slNum))
  const rewardUsd = tpNum != null && !Number.isNaN(tpNum) ? toUsd(Math.abs(tpNum - entryRef)) : null
  const rr = riskUsd && rewardUsd ? rewardUsd / riskUsd : null
  return { riskUsd, rewardUsd, rr }
}

/** 按风险百分比建议手数：手数 = 净值 × 风险% ÷ 每手止损亏损。有券商规格按
 *  (距离 ÷ tickSize) × tickValue 精确算；否则走基准 + 兜底表。算不出（无止损 /
 *  无参考价 / 无净值 / 不支持的品种）返回 null。
 *  Lots from a risk percentage: equity × pct ÷ loss per lot at the SL. Exact
 *  with a broker spec, basis + table otherwise; null when it can't be sized. */
export function suggestVolumeForRisk(symbol: string, equity: number | null | undefined, riskPctRaw: string, slNum: number | null, entryRef: number | null, spec?: SymbolSpec): string | null {
  if (slNum == null || Number.isNaN(slNum) || entryRef == null) return null
  const distance = Math.abs(entryRef - slNum)
  const pct = parseFloat(riskPctRaw) || 0
  if (hasTickSpec(spec)) {
    if (!equity || equity <= 0 || distance <= 0 || pct <= 0) return null
    return clampLots((equity * pct / 100) / lossPerLot(distance, spec), symbol).toFixed(lotDigits(symbol))
  }
  const suggested = suggestVolumeByRisk(symbol, equity, pct, distance, entryRef, specContractSize(spec))
  return suggested != null ? clampLots(suggested, symbol).toFixed(lotDigits(symbol)) : null
}

export function formatMoney(n?: number | null, dash = '-'): string {
  return n == null ? dash : n.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

/** 保证金比例（MT5 终端里的「预付款比例」）= 净值 ÷ 已用保证金 × 100%。
 *
 * 空仓时券商给的 margin 是 0，MT5 自己在这种情况下也不显示比例——除以 0 得到的
 * Infinity 不是"比例极高"而是"这个量此刻没有意义"，所以这里返回 null 交给展示侧
 * 显示「—」。margin 为 null/undefined（存量行还没刷新过、或桥接版本太旧不上报）
 * 同样返回 null：两种"没有比例"在界面上看起来一样，但绝不能拿 0 去顶替未知。
 *
 * MT5's margin level: equity / margin. Returns null when flat (margin 0 —
 * Infinity would read as "extremely healthy" rather than "not meaningful here")
 * and when margin is unknown (legacy row or an old bridge). The caller renders
 * both as an em dash; never substitute 0 for unknown.
 */
export function marginLevel(equity?: number | null, margin?: number | null): number | null {
  if (equity == null || margin == null || margin <= 0) return null
  return (equity / margin) * 100
}

/** 保证金比例的显示形式：千分位 + 百分号。
 *
 * 小数位分两档。1000% 以下跟 MT5 终端一样留两位——这一档是真正有风险含义的区间
 * （券商的追加保证金/强平线通常在 100%、50% 上下），差几个点都值得看清。1000% 以上
 * 只在几乎空仓时出现（0.01 手黄金能算出 46 万%），两位小数全是噪音，还把这一格
 * 撑得比旁边六格加起来还宽，所以取整。两档的前几位有效数字一致，跟终端上的数字
 * 对照不会看出矛盾。
 *
 * Two decimals below 1000% — the band where margin call / stop-out levels live and
 * single points matter, same as the MT5 terminal. Above that (only reachable when
 * all but flat: 0.01 lot of gold yields ~465,000%) the decimals are pure noise and
 * blow out the cell width, so it rounds. The leading digits agree either way. */
export function formatMarginLevel(equity?: number | null, margin?: number | null, dash = '—'): string {
  const lvl = marginLevel(equity, margin)
  if (lvl == null) return dash
  const digits = lvl < 1000 ? 2 : 0
  return `${lvl.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`
}
