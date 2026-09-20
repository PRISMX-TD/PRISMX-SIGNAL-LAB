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
// 2026-07-15：按用户要求全站统一显示 UTC+8（马来西亚/新加坡/中国标准时间，
// 全年无夏令时切换）。仍然显式标注"UTC+8"后缀而不是裸时间——不标注时区的
// 教训（国际用户会把它当成自己的本地时间、读错实际发生时刻）依然适用，只是
// 现在固定展示的时区从 UTC 换成了 UTC+8。
// Backend stores UTC. If the string carries no tz marker, treat it as UTC.
// 2026-07-15: per request, the whole site now displays UTC+8 (Malaysia/
// Singapore/China standard time, no DST year-round). Still labeled explicitly
// with a "UTC+8" suffix rather than a bare time — the earlier lesson (an
// unlabeled time reads as the viewer's own local time and gets misread)
// still applies; only the fixed timezone being shown has changed.
export function fmtTime(iso: string | null | undefined): string {
  const d = parseTime(iso)
  if (!d) return '-'
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }) + ' UTC+8'
}

// 格式化为含年月日的完整日期时间（用于订阅到期等需要明确年份的场景）
// Format with full date incl. year (for subscription expiry etc. where the year matters).
export function fmtDate(iso: string | null | undefined): string {
  const d = parseTime(iso)
  if (!d) return '-'
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }) + ' UTC+8'
}

// 解析后端时间为带时区的 Date / parse backend time as a tz-aware Date
//
// **全站唯一一处**做这个判断。后端的 DateTime 列存的是不带时区的 UTC，经 pydantic
// 序列化后要么是 `2026-09-19T11:23:45`（无后缀），要么是 `...Z`（带时区的值会被
// 归一成 Z），所以规则是：认不出时区就当 UTC 补一个 Z。
//
// 这段逻辑一度被抄了五份（本文件三处、OrdersPage、AccountPage），而 AccountPage
// 那份把 `\d` 写成了 `d`，成了一颗只在特定输入下才响的哑弹。2026-09-19 审计后全部
// 收口到这里——往别处再抄一份就是在重新种下同一个 bug。
//
// The single place in the app that makes this decision. Backend DateTime columns
// hold naive UTC; pydantic emits either `2026-09-19T11:23:45` or `...Z` (aware
// values are normalised to Z), so the rule is: no recognisable zone means UTC.
//
// This logic was copied five times (three here, OrdersPage, AccountPage) and
// AccountPage's copy had `d` where it needed `\d` — a latent bug waiting on the
// right input. Consolidated here by the 2026-09-19 audit; copying it again is
// replanting the same bug.
export function parseTime(iso: string | null | undefined): Date | null {
  if (!iso) return null
  const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso)
  return new Date(hasTz ? iso : iso + 'Z')
}

// 只到日的日期，不带时分——用于只需要"哪一天"的场景（绝版勋章截止日等），
// 精确到分钟的时刻详情已经有 fmtDate/fmtTime。
// Date-only, no time-of-day — for spots that only need "which day" (limited
// badge closing dates, etc.); minute-precision detail already has fmtDate/fmtTime.
export function fmtDay(iso: string | null | undefined, fallback?: string): string {
  // fallback：空值 / 解析失败时要显示什么。不传则沿用旧行为（渲染出 'Invalid Date'）。
  // 账户页、主页、公告面板以前各自包一层"空值返回 —/空串"，2026-09-21 收口到这里。
  // fallback: what to render for an empty or unparsable value; omitted keeps the old
  // behaviour ('Invalid Date'). Account, profile and announcements each wrapped this
  // themselves; folded in on 2026-09-21.
  const parsed = parseTime(iso)
  if (fallback !== undefined && (!parsed || Number.isNaN(parsed.getTime()))) return fallback
  const d = parsed ?? new Date(NaN)
  return d.toLocaleDateString('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

// 同年省略年份的短日期，外加"没有值就返回空串"——列表里的日期列（通知铃铛、
// 工单列表）本来各写一份，现在共用这一份。
//
// 为什么"是不是同一年"要用 UTC+8 的年份而不是 d.getFullYear()：后者读的是**浏览器
// 本地时区**的年份。跨年那几个小时里，欧美时区的用户会拿本地的 2025 去比一个按
// UTC+8 渲染成 2026 的日期，于是该省年份的省了、该写的没写——日期本身是对的，
// 年份却和它不在同一个时区里。判据必须和渲染用的是同一个时区。
//
// A short date that drops the year within the current year, and returns an empty
// string when there is no value — the notification bell and the ticket list each
// carried their own copy of this.
// The same-year test uses the UTC+8 year rather than d.getFullYear(), which
// reads the *browser's* local year: during the hours around New Year a viewer
// outside UTC+8 would compare their local 2025 against a date rendered as 2026,
// omitting the year exactly when it is needed (and vice versa). The test has to
// run in the zone the date is rendered in.
export function fmtDayShort(iso: string | null | undefined): string {
  const d = parseTime(iso)
  if (!d || Number.isNaN(d.getTime())) return ''
  const yearIn = (x: Date) => x.toLocaleDateString('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric' })
  const sameYear = yearIn(d) === yearIn(new Date())
  return d.toLocaleDateString(
    'en-GB',
    sameYear
      ? { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' }
      : { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' },
  )
}
// ---------- 数字格式化（榜单 / 成就 / 比赛 / 现金流规则共用） ----------
//
// 下面五个函数以前散在 2~4 个文件里各抄一份，每份旁边都有一条"只此一处重复、不值得抽"
// 的注释——fmtScorePct 抄到第 4 份时那条注释本身已经过期。口径统一放在这里：
// Number formatting shared by leaderboard / achievements / competitions / cashflow
// rules. Each used to be copied into 2–4 files with a "sole duplicate, not worth
// extracting" note beside it; by the 4th copy of fmtScorePct that note was stale.

// 分数 → 百分比，一位小数：0.124 → "12.4%"。榜单 score 与比赛得分都是分数。
// 收益榜可能为负，toFixed 同样处理；要带正号的看 LeaderboardPage 的 fmtScoreSigned。
// Fraction → percent with one decimal (0.124 → "12.4%"). Negative values (return board)
// go through toFixed unchanged; the signed variant lives in LeaderboardPage.
export function fmtScorePct(v: number): string {
  return `${(v * 100).toFixed(1)}%`
}

// 美元数额：整数不带小数（500 而不是 500.00），非整数保留两位。管理端只要求正数、
// 不强制整数，所以两种形状都要处理。
// USD amounts: whole dollars render without decimals, anything else keeps two. The
// admin form only requires a positive number, so both shapes occur.
export function fmtUsd(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2)
}

// 进度数字：手数类条件可能带小数（统计四舍五入到 4 位），笔数 / 天数是整数。
// 统一"整数不带小数点，小数最多两位"，不按条件类型特判。
// Progress numbers: lot-based conditions can carry a fraction (stats round to 4dp),
// trade/day counts are integers. Uniformly "no decimals when whole, at most 2dp".
export function fmtProgressNum(n: number): string {
  const rounded = Math.round(n * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
}

// 勋章持有比例。population 为 0（数据库为空的边界情况）时不做除零——直接报 0.0%，
// 比 NaN% 更能看。
// Badge ownership share. A zero population (empty-database edge case) avoids a
// divide-by-zero and reports 0.0% outright rather than NaN%.
export function fmtOwnerPct(owners: number, population: number): string {
  if (population <= 0) return '0.0%'
  return `${((owners / population) * 100).toFixed(1)}%`
}

// 金额两位小数带千分位（回测面板 / 模拟器的账户曲线）。下单表单那边的
// components/order/orderMath.formatMoney 是另一套口径（按品种精度），别混用。
// Two-decimal money with thousands separators (backtest panel / simulator). The order
// form's orderMath.formatMoney is a different rule (per-symbol precision); don't mix.
export function fmtMoney(v: number): string {
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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

// 平台 / 信号侧的品种名 → 券商 MT5 侧的基础名（不含后缀），与后端
// services/symbol_aliases.broker_symbol 同一张表、同一条通用规则：TradingView 的加密
// 警报一律以 USDT 计价（BTCUSDT / ETHUSDT），MT5 券商的加密 CFD 一律叫 …USD。
// 真实信号存的就是 "BTCUSDT"，以前下单表单拿它直接查合约规模 / 美元基准 / 按账户
// 报价，一个都查不到——风险百分比对比特币永远"暂不支持"，现价也拿不到券商报价。
// Signal-side symbol → broker MT5 base name, mirroring the backend's
// broker_symbol(): TradingView crypto alerts are USDT-quoted while broker CFDs
// are …USD. Real signals store "BTCUSDT", which used to miss every table and
// quote lookup in the order form, so risk-% sizing never worked for bitcoin.
const BROKER_NAMES: Record<string, string> = {
  BTCUSDT: 'BTCUSD',
  USOIL: 'WTI',
  XTIUSD: 'WTI',
  WTICOUSD: 'WTI',
}

export function brokerSymbol(symbol: string): string {
  const s = symbol.trim().toUpperCase()
  const mapped = BROKER_NAMES[s]
  if (mapped) return mapped
  if (s.endsWith('USDT') && s.length > 4) return s.slice(0, -1)
  return s
}

// 去掉券商后缀后取基础品种名，并归一到券商叫法（BTCUSDT → BTCUSD），所以下面所有
// 按品种查表的函数对信号名和券商名一视同仁。
// Strip the broker suffix and normalize to the broker's name (BTCUSDT → BTCUSD),
// so every per-symbol table below accepts signal-side and broker-side names alike.
export function baseSymbol(symbol: string): string {
  return brokerSymbol(symbol.toUpperCase().replace(/[._-].*$/, ''))
}

// 展示名映射：MT5/信号引擎/桥接上下行全程用的都是 BTCUSD（这是 MT5 上实际的
// 品种名，下单、报价、持仓、成交明细全靠这个字符串精确匹配），但用户更熟悉
// "BTCUSDT" 这个叫法。只在渲染给用户看的地方转换显示文本，绝不能把转换后的
// 值传回下单/查价/i18n 键名等逻辑路径——那些地方仍然只认 BTCUSD。
// Display-name mapping: everywhere upstream (MT5, the signal engine, the
// bridge) the symbol is literally "BTCUSD" — that's the real MT5 symbol name
// and every order/quote/position/closed-trade match depends on that exact
// string — but users know it as "BTCUSDT". Only convert at render sites;
// never feed the converted value back into order placement, quote lookups,
// or i18n key names, which still only recognize BTCUSD.
const SYMBOL_DISPLAY_NAMES: Record<string, string> = {
  BTCUSD: 'BTCUSDT',
}

export function displaySymbol(symbol: string): string {
  return SYMBOL_DISPLAY_NAMES[baseSymbol(symbol)] ?? symbol
}

// 每手合约规模（标的单位数）——**兜底表**。桥接 v1.3.23 起按账户报价自带券商真实
// 规格（Quote.contractSize / tickSize / tickValue），下单表单优先用那个；这张表只在
// 拿不到时用：网关账户（合作券商 Make Capital，没有按账户报价）、旧版桥接、EA 全站
// 报价。所以表里的数按合作券商品种表（MT4 symbols.raw，2026-09-07 实测）填：
// 黄金 100 盎司、白银 5000 盎司、BTC 1 枚、ETH **10** 枚、WTI **100** 桶——后两项
// 此前按"常见值"写成 1 和 1000，在合作券商上风险金额 / 建议手数各错 10 倍。
// Contract size per lot — the *fallback* table. Bridge >= 1.3.23 sends the
// broker's real spec with per-account quotes and the order form prefers it;
// this table only serves gateway accounts (partner broker, no per-account
// quotes), older bridges and the site-wide EA feed. Values therefore follow the
// partner broker's symbol table (MT4 symbols.raw, verified 2026-09-07): ETH is
// 10 per lot and WTI 100 barrels — the old 1 / 1000 were off by 10x there.
const CONTRACT_SIZE: Record<string, number> = {
  XAUUSD: 100,
  XAGUSD: 5000,
  BTCUSD: 1,
  ETHUSD: 10,
  WTI: 100,
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
  XAUUSD: 'quote', XAGUSD: 'quote', BTCUSD: 'quote', ETHUSD: 'quote', WTI: 'quote',
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
// contractSizeOverride：券商上报的真实每手规模（有则优先于兜底表）。
// contractSizeOverride: the broker-reported units per lot, preferred over the table.
export function suggestVolumeByRisk(
  symbol: string,
  equity: number | null | undefined,
  riskPct: number,
  slPriceDistance: number,
  refPrice?: number | null,
  contractSizeOverride?: number | null,
): number | null {
  if (!equity || equity <= 0 || !slPriceDistance || slPriceDistance <= 0 || riskPct <= 0) return null
  const basis = usdMarginBasis(symbol)
  if (basis == null) return null
  const riskAmount = equity * (riskPct / 100)
  const size = contractSizeOverride && contractSizeOverride > 0 ? contractSizeOverride : contractSize(symbol)
  let raw: number
  if (basis === 'quote') {
    raw = riskAmount / (slPriceDistance * size)
  } else {
    if (!refPrice || refPrice <= 0) return null
    raw = (riskAmount * refPrice) / (slPriceDistance * size)
  }
  // 吸附到该品种的步长，而不是写死的 0.01 粒度。
  //
  // 原来是 Math.floor(raw * 100) / 100，对 WTI（步长 0.1，见下方 LOT_STEP）会算出
  // 0.23 这种离步长的手数——而离步长的手数**不会被 MT5 拒绝**，它会变成一张永远不
  // 成交、并且卡住该持仓后续所有平仓操作的单子。目前线上没事，是因为唯一的调用方
  // （components/order/orderMath 的 suggestVolumeForRisk）后面又过了一道 clampLots；
  // 但这是个导出的公共函数，下一个直接用它的人就会踩。步长知识收在这里，别留在调用方。
  //
  // Snap to the symbol's lot step instead of a hard-coded 0.01 grid. The old
  // Math.floor(raw * 100) / 100 produced values like 0.23 for WTI (step 0.1, see
  // LOT_STEP below) — and an off-step volume is not rejected by MT5: it becomes an
  // order that can never fill and then blocks every later close on that position.
  // Nothing breaks today only because the sole caller
  // (components/order/orderMath's suggestVolumeForRisk) runs the result through
  // clampLots afterwards. This is an exported helper, so the next caller to use it
  // directly would step straight into it. Step knowledge belongs here, not at the
  // call site.
  return Math.min(10, snapLot(raw, symbol))
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

// 手数展示：抹掉浮点噪音。手数在链路里经过步长规整 / 分批平仓的减法后会带出
// 1.1400000000001 这类尾巴（2026-09-11 用户截到），MT5 的手数步长最小 0.001，
// 所以先按千分之一取整再格式化，最多 3 位小数。所有展示手数的地方都走这里，
// 表单输入框的默认值也用它——把带噪音的数原样填进去再发回 MT5 会被拒。
// Lot display: strips float noise (1.1400000000001 → 1.14, seen 2026-09-11).
// Volume step is at most 0.001 in MT5, so round to thousandths first, then
// format with up to 3 decimals. Every lot display goes through this, and so
// do form defaults — echoing a noisy value back to MT5 gets it rejected.
export function roundLots(n: number): number {
  return Math.round(n * 1000) / 1000
}
// 每手手数步长 —— 按品种。合作券商实测（2026-09-17 负责人确认）：除原油 WTI 是
// 0.1 以外，其余品种都是 0.01。步长同时决定了最小手数：步长 0.1 的品种填不出
// 0.01，最小就是 0.1。
//
// 为什么非管不可：不是整数倍的手数**不会被 MT5 当场拒绝**，而是被接受成一张永远
// 不会成交的订单，挂在仓位上把这张仓位后续的平仓全部挡掉。2026-09-17 有用户对一张
// 黄金仓位提交了 0.015 手的部分平仓，此后三个半小时平不掉，最后爆仓。
//
// 这张表是**兜底**，与 CONTRACT_SIZE 同一性质：真正权威的是券商品种表，由 gateway
// 在下单前逐笔校验。这里管的是"别让用户填错"，让错误停在输入框而不是交易所。
//
// Lot step per symbol. Verified at the partner broker: 0.1 for WTI crude, 0.01 for
// everything else. The step also sets the minimum: a 0.1-step symbol cannot take 0.01.
// An off-step volume is NOT rejected by MT5 — it becomes an order that can never fill
// and then blocks every later close on that position. This table is the fallback; the
// gateway validates against the broker's real symbol table. Its job is to stop the
// mistake at the input box.
const LOT_STEP: Record<string, number> = {
  WTI: 0.1,
}
const DEFAULT_LOT_STEP = 0.01

export function lotStep(symbol: string | null | undefined): number {
  if (!symbol) return DEFAULT_LOT_STEP
  return LOT_STEP[baseSymbol(symbol)] ?? DEFAULT_LOT_STEP
}

/** 该品种的最小手数：步长比 0.01 粗时，最小手数就是步长本身。 */
export function minLot(symbol: string | null | undefined): number {
  return Math.max(DEFAULT_LOT_STEP, lotStep(symbol))
}

/**
 * 手数是否落在该品种的步长上。
 *
 * 不能直接取模：浮点下 0.03 % 0.01 得到 0.009999999999999998，合法手数会被误判。
 * 一律除完取整再比残差，容差取步长的百万分之一。
 *
 * A plain modulo is unusable: 0.03 % 0.01 is 0.009999999999999998 in binary floating
 * point, which would reject a valid volume. Divide, round, compare the residual.
 */
export function isLotOnStep(n: number, symbol?: string | null): boolean {
  if (!Number.isFinite(n)) return false
  const step = lotStep(symbol)
  const k = Math.round(n / step)
  return Math.abs(n - k * step) <= step * 1e-6
}

/** 该品种手数允许的小数位数：步长 0.1 → 1 位，步长 0.01 → 2 位。 */
export function lotDecimals(symbol?: string | null): number {
  return lotStep(symbol) >= 0.1 ? 1 : 2
}

/**
 * 手数输入框的实时过滤：只留数字和小数点，并把小数位数截到该品种允许的位数。
 *
 * 只在失焦时吸附是不够的——用户能一路把 0.8902 打进去，看着像个合法手数，直到
 * 提交才被拒；而且在手机上滑动确认时输入框未必先失焦。这里让多余的位数根本
 * 打不进去：黄金最多两位，原油最多一位。
 *
 * 中间态必须放行，否则输入框没法用："" / "0" / "0." / "0.8" 都要能停留。
 *
 * Live filter for the lot input: digits and one dot, with decimals truncated to what
 * the symbol allows. Snapping only on blur lets 0.8902 sit there looking valid until
 * submit, and on mobile the slider may fire without blurring first. Intermediate
 * states ("", "0", "0.", "0.8") must pass through or the field becomes unusable.
 */
export function limitLotInput(raw: string, symbol?: string | null): string {
  const cleaned = raw.replace(/[^0-9.]/g, '')
  const firstDot = cleaned.indexOf('.')
  if (firstDot < 0) return cleaned
  // 多打的小数点直接丢掉，别让 "0.8.9" 这种串留在框里
  const head = cleaned.slice(0, firstDot)
  const tail = cleaned.slice(firstDot + 1).replace(/\./g, '')
  return head + '.' + tail.slice(0, lotDecimals(symbol))
}

/** 把手数向下吸附到该品种的步长上，并保证不低于最小手数。 */
export function snapLot(n: number, symbol?: string | null): number {
  const step = lotStep(symbol)
  const floored = Math.floor(n / step + 1e-6) * step
  return roundLots(Math.max(step, floored))
}

export function fmtLots(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return roundLots(n).toLocaleString('en-US', { maximumFractionDigits: 3 })
}
