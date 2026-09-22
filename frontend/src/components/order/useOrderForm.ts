// 下单表单的状态编排，三个下单入口共用（见 orderMath.ts 开头的说明）。
//
// 这个 hook 只管"表单里有什么、算出来是什么"，不管长什么样、怎么提交：账户选择
// （记忆上次用的账户）、手数（快捷 / 按风险%）、止损止盈及方向校验、参考价、
// 保证金与风险预览、本次下单的幂等号。各入口拿返回值去渲染自己的布局，提交时
// 把 `parsedVolume / login / slNum / tpNum / orderId` 交给自己的 onConfirm。
//
// 账户列表由调用方决定过滤方式再传进来：弹窗传 useStickyOnlineAccounts 的结果
// （在线标志抖一下不能把切换器卸载），停靠面板传纯在线过滤——这个差别是各自
// 场景的正确行为，不在这里统一。
//
// Form-state orchestration shared by the three order entry points: account pick
// (remembering the last used one), lots (quick / risk-%), SL/TP with side
// validation, reference price, margin and risk preview, and the per-order
// idempotency key. Rendering and submission stay in each caller. The caller
// also decides how the account list is filtered (sticky for modals, plain
// online for the docked ticket) — that difference is intentional.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MT5Account, OrderEntryType, PendingType, Quote } from '../../api/types'
import { brokerSymbol, limitLotInput, clientOrderId } from '../../api/utils'
import { pickDefaultAccount, useLastAccount } from '../../utils/useLastAccount'
import { useLastVolume } from '../../utils/useLastVolume'
import {
  canSizeByRisk,
  checkPendingPrice,
  checkSlTp,
  pendingTypeOf,
  clampLots,
  defaultVolume,
  estimateMargin,
  normalizeVolume,
  parseOptionalNumber,
  previewRisk,
  stepVolume,
  suggestVolumeForRisk,
} from './orderMath'

export type Side = 'BUY' | 'SELL'
export type SizeMode = 'quick' | 'risk'

export interface UseOrderFormArgs {
  symbol: string
  side: Side
  /** 可选账户（调用方已按自己的规则过滤）/ candidate accounts, pre-filtered by the caller */
  accounts: MT5Account[]
  /** 按交易商账户区分的报价：login -> {symbol: Quote} / per-account quotes */
  quotesByAccount: Record<string, Record<string, Quote>>
  /** 选中账户没有该品种报价时的兜底报价（全站 EA 推送）/ site-wide fallback quote */
  fallbackQuote?: Quote
  /** 连报价都没有时的参考价（图表最新价 / 信号入场价）/ last-resort reference price */
  refPrice?: number | null
  initialStopLoss?: number | null
  initialTakeProfit?: number | null
  /** 受控的选中账户（终端面板由 ChartsPage 持有，用于联动摘要 / 持仓 / 挂单）
   *  Controlled selection (the docked ticket's parent owns it to sync other panes) */
  login?: string
  onLoginChange?: (login: string) => void
}

export interface OrderForm {
  isBuy: boolean
  accounts: MT5Account[]
  hasAccounts: boolean
  login: string
  selected: MT5Account | null
  /** 用户主动选择：会记忆 / explicit pick, remembered */
  chooseLogin: (login: string) => void
  quote: Quote | undefined
  bid: number | null
  ask: number | null
  /** 入场参考价。市价单是「买用卖价、卖用买价」；挂单则是**用户填的触发价**——
   *  止损止盈校验、风险预览、保证金估算全都以它为准，这正是挂单该比的那个价。
   *  Entry reference: ask/bid for a market order, the user's trigger price for a
   *  pending one — which is exactly what its SL/TP, risk and margin must compare to. */
  entryRef: number | null
  /** 下单方式：市价 / 限价 / 止损 / market, limit or stop entry */
  entryType: OrderEntryType
  setEntryType: (t: OrderEntryType) => void
  /** 挂单触发价的输入值（市价模式下不用）/ the trigger price input (unused for MARKET) */
  price: string
  setPrice: (v: string) => void
  priceNum: number | null
  /** 触发价不合法时的 i18n key，合法为 null / i18n key when the trigger price is wrong */
  priceError: string | null
  /** 最终的 MT5 挂单类型；市价单为 null / the MT5 pending type, null for a market order */
  pendingType: PendingType | null
  volume: string
  /** 用户主动设置（快捷档等）：会记忆为下次默认 / explicit pick, remembered as the next default */
  setVolume: (v: string) => void
  /** 输入框 onChange 用：只留数字和小数点 / for the input's onChange */
  typeVolume: (raw: string) => void
  blurVolume: () => void
  stepLot: (dir: 1 | -1) => void
  /** 提交用：合法则为正数，否则 null / for submit: positive number or null */
  parsedVolume: number | null
  sizeMode: SizeMode
  setSizeMode: (m: SizeMode) => void
  riskPct: string
  setRiskPct: (p: string) => void
  /** 风险模式但没填止损 / risk mode without an SL */
  riskNeedsSl: boolean
  /** 风险模式但品种无法换算成美元 / risk mode on a symbol with no USD basis */
  riskUnsupported: boolean
  sl: string
  tp: string
  setSl: (v: string) => void
  setTp: (v: string) => void
  slNum: number | null
  tpNum: number | null
  slInvalid: boolean
  tpInvalid: boolean
  slTpInvalid: boolean
  estMargin: number | null
  riskPreview: ReturnType<typeof previewRisk>
  /** 本次下单的幂等号：重试复用，成功后才换新 / idempotency key, reused on retry */
  orderId: string
  /** 成功提交后调用，下一单换新号 / call after a successful submit */
  rotateOrderId: () => void
}

export function useOrderForm({
  symbol, side, accounts, quotesByAccount, fallbackQuote, refPrice,
  initialStopLoss, initialTakeProfit, login: controlledLogin, onLoginChange,
}: UseOrderFormArgs): OrderForm {
  const isBuy = side === 'BUY'

  // ---- 账户 / account ---------------------------------------------------------
  const { lastLogin, rememberAccount } = useLastAccount()
  const [localLogin, setLocalLogin] = useState<string>(() => pickDefaultAccount(accounts, lastLogin))
  const login = controlledLogin || localLogin
  const setLogin = (v: string) => { setLocalLogin(v); onLoginChange?.(v) }
  // 只在用户主动选择时记忆；下面那个兜底走 setLogin，不能写记忆——否则偏好的账户
  // 掉线一次，记忆就被兜底值冲掉，等它恢复也不会再被默认选中。
  // Only an explicit pick is remembered; the fallback below must not overwrite it.
  const chooseLogin = (v: string) => { setLogin(v); rememberAccount(v) }
  const selected = accounts.find((a) => a.login === login) ?? accounts[0] ?? null

  // 兜底：还没选、或选中的账户已不在列表里（被解绑 / 掉线且不在保留名单）时拉回默认。
  // 这条路径是代码在纠正状态，不是用户的选择，所以不记忆。
  // Fallback when nothing is selected or the selection left the list: code
  // correcting state, not a user pick, so not remembered.
  useEffect(() => {
    if ((!login || !accounts.some((a) => a.login === login)) && accounts[0]) {
      setLogin(pickDefaultAccount(accounts, lastLogin))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, login, lastLogin])

  // ---- 报价与参考价 / quote & reference ---------------------------------------
  // 按账户报价按券商品种名（BTCUSD）键入，信号名可能是 BTCUSDT：两个名字都查一遍。
  // Per-account quotes are keyed by the broker's name (BTCUSD); the signal may
  // say BTCUSDT, so try both spellings.
  const accountQuotes = selected ? quotesByAccount[selected.login] : undefined
  const quote = accountQuotes?.[symbol] || accountQuotes?.[brokerSymbol(symbol)] || fallbackQuote
  const ref = refPrice != null && refPrice > 0 ? refPrice : null
  const bid = quote?.bid ?? ref
  const ask = quote?.ask ?? ref
  const marketRef = isBuy ? ask : bid

  // ---- 下单方式与触发价 / entry mode & trigger price ---------------------------
  const [entryType, setEntryTypeState] = useState<OrderEntryType>('MARKET')
  const [price, setPrice] = useState('')
  const priceNum = parseOptionalNumber(price)
  // 切到挂单时把触发价预填成当前市价：用户接下来要做的是「把它改到想挂的位置」，
  // 从一个空框开始等于要求他先抄一遍现价。切回市价不清空——来回切一下不该丢掉
  // 刚填的价格。/ Prefill the trigger with the current market when switching to a
  // pending mode: the next thing the user does is nudge it, and an empty field would
  // make them copy the current price by hand first. Switching back to MARKET keeps
  // the value, so toggling twice doesn't discard what was typed.
  const setEntryType = (t: OrderEntryType) => {
    setEntryTypeState(t)
    if (t !== 'MARKET' && price.trim() === '' && marketRef != null) {
      setPrice(marketRef.toString())
    }
  }
  const pendingType = pendingTypeOf(isBuy, entryType)
  const priceError = checkPendingPrice(entryType, isBuy, priceNum, bid, ask)

  // 挂单的参考价是触发价本身，不是市价。挂单的止损止盈、风险、保证金全部相对
  // 触发价而言——拿市价去比，一张「现价 3900、挂 3950 买入止损、止损 3930」的单
  // 会被判成「止损高于入场价」而报错，而它其实完全正确。
  // A pending order's reference is its own trigger, not the market: its SL/TP, risk
  // and margin are all relative to where it will enter. Comparing against the market
  // would flag a perfectly valid buy-stop at 3950 with a stop at 3930 as invalid.
  const entryRef = entryType === 'MARKET' ? marketRef : (priceError == null ? priceNum : null)

  // ---- 手数 / volume ----------------------------------------------------------
  // 默认 = 用户上次自己设的手数（没有就 0.01），不再按净值推算。只有用户主动
  // 设置（输入后失焦 / ± 步进 / 快捷档 / 成功下单）才写记忆；风险模式自动算出
  // 的手数只进表单不进记忆——用户定的是"风险 1%"，不是那个手数。
  // Default = the user's last explicitly-set lots (else 0.01); no more
  // equity-based guess. Only explicit edits (blur / step / quick chip / a
  // successful submit) are remembered; risk-mode auto-sizing fills the form
  // but never the memory — the user chose "1% risk", not that lot number.
  const { lastVolume, rememberVolume } = useLastVolume()
  const [volume, setVolumeState] = useState(() => defaultVolume(lastVolume, symbol))
  const [sizeMode, setSizeMode] = useState<SizeMode>('quick')
  const [riskPct, setRiskPct] = useState('1')
  const touchedRef = useRef(false)
  const setVolume = (v: string) => { touchedRef.current = true; setVolumeState(v); rememberVolume(v) }
  const typeVolume = (raw: string) => { touchedRef.current = true; setVolumeState(limitLotInput(raw, symbol)) }
  const blurVolume = () => setVolume(normalizeVolume(volume, symbol))
  const stepLot = (dir: 1 | -1) => setVolume(stepVolume(volume, dir, symbol))
  // 提交用的手数必须落在该品种的步长上**且不超过上限**。输入时已按位数截断、失焦还会
  // 吸附，但手机上滑动确认可能不先失焦，所以这里再收敛一次兜底——按钮上显示的也是这个
  // 值，用户在滑之前就能看到最终手数，不会被"悄悄改了"。
  //
  // 这里用 `clampLots` 而不是 `snapLot`：两者都会把手数向下吸附到步长，但只有
  // `clampLots` 带上限（VOLUME_MAX，10 手）。`snapLot` 没有上限，于是"在手机上输入
  // 50 手、直接滑动确认、全程不失焦"这条路径会把 50 手原样提交——失焦那条路径明明
  // 夹到 10。上限是风控闸，不能取决于用户有没有点一下别处。
  //
  // The submitted volume must sit on the symbol's step *and* respect the cap.
  // Typing truncates and blur snaps, but the mobile slider can fire without a blur,
  // so converge once more here; the button label reads this value, so the user sees
  // the final lots before confirming.
  //
  // `clampLots`, not `snapLot`: both floor onto the step, but only clampLots applies
  // the VOLUME_MAX ceiling. With snapLot, "type 50 lots on a phone and slide to
  // confirm without ever blurring" submitted 50 — while the blur path capped it at
  // 10. A risk limit must not depend on whether the user happened to tap elsewhere.
  const parsedVolumeRaw = parseFloat(volume)
  const parsedVolume = parsedVolumeRaw > 0 ? clampLots(parsedVolumeRaw, symbol) : null

  // 偏好从云端晚到（本地缓存为空的新设备 / 新浏览器）：用户还没碰过手数时补应用记忆值。
  // Prefs arriving late from the cloud (fresh device, empty local cache): apply
  // the remembered lots as long as the user hasn't touched the field yet.
  useEffect(() => {
    if (touchedRef.current || sizeMode !== 'quick') return
    setVolumeState(defaultVolume(lastVolume, symbol))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastVolume])

  // ---- 止损止盈 / SL & TP -----------------------------------------------------
  const [sl, setSl] = useState(() => (initialStopLoss != null ? String(initialStopLoss) : ''))
  const [tp, setTp] = useState(() => (initialTakeProfit != null ? String(initialTakeProfit) : ''))
  const slNum = parseOptionalNumber(sl)
  const tpNum = parseOptionalNumber(tp)
  const { slInvalid, tpInvalid } = checkSlTp(isBuy, slNum, tpNum, entryRef)

  // 按风险百分比建议手数：净值 × 风险% ÷ 每手止损亏损，随 SL / 净值 / 风险% / 报价
  // （含券商规格）变化重算。选中账户的报价自带该券商的合约规格（桥接 ≥ 1.3.23），
  // 所以换账户 / 换券商自动按新规格算，见 orderMath 的说明。
  // Risk-% sizing, recomputed whenever SL, equity, risk % or the quote (incl.
  // the broker spec it carries) moves. The selected account's quote brings its
  // own broker's contract spec, so switching accounts re-sizes correctly.
  useEffect(() => {
    if (sizeMode !== 'risk') return
    const suggested = suggestVolumeForRisk(symbol, selected?.equity, riskPct, slNum, entryRef, quote)
    if (suggested != null) setVolumeState(suggested)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slNum/entryRef derive from these
    // entryType / price 也在列：挂单模式下 entryRef 是触发价，改触发价就得按新的
    // 入场价重算手数——漏了它，用户把触发价从 3900 拖到 3950 之后，手数还停在按
    // 3900 算出来的那个数，风险就不是他选的 1% 了。
    // entryType / price belong here: in a pending mode entryRef *is* the trigger, so
    // moving it must resize. Without them, dragging the trigger from 3900 to 3950
    // leaves the lots sized for 3900 and the risk is no longer the 1% that was chosen.
  }, [sizeMode, riskPct, sl, selected?.equity, symbol, quote?.bid, quote?.ask, quote?.tickSize, quote?.tickValue, quote?.contractSize, refPrice, entryType, price])

  const riskNeedsSl = sizeMode === 'risk' && slNum == null
  const riskUnsupported = sizeMode === 'risk' && slNum != null && !canSizeByRisk(symbol, quote)

  // ---- 估算 / estimates -------------------------------------------------------
  const estMargin = useMemo(
    () => estimateMargin(symbol, volume, selected?.leverage, entryRef, quote),
    [symbol, volume, selected?.leverage, entryRef, quote],
  )
  const riskPreview = useMemo(
    () => previewRisk(symbol, volume, entryRef, slNum, tpNum, quote),
    [symbol, volume, entryRef, slNum, tpNum, quote],
  )

  // ---- 幂等号 / idempotency key ----------------------------------------------
  // 在一次表单生命周期内固定不变：滑动 / 点击失败后再试复用同一个号，避免"已收单
  // 但没收到回执 → 再来一次"变成两笔。成功提交后才换新号（停靠面板会连续下多单）。
  // Fixed across retries so "received but no receipt → try again" can't double-
  // place; rotated only after a successful submit (the docked ticket places many).
  const orderIdRef = useRef<string>('')
  if (!orderIdRef.current) orderIdRef.current = clientOrderId()
  const [orderId, setOrderId] = useState(orderIdRef.current)
  // 成功下单也算"用户定下了这个手数"（仅手数模式）：输入完直接滑动确认、没触发
  // 失焦的情况也能记住。/ A successful submit also settles the lots (lots mode
  // only), covering "type then slide" flows that never blur the input.
  const rotateOrderId = () => {
    if (sizeMode === 'quick') rememberVolume(normalizeVolume(volume, symbol))
    orderIdRef.current = clientOrderId()
    setOrderId(orderIdRef.current)
  }

  return {
    isBuy, accounts, hasAccounts: accounts.length > 0, login, selected, chooseLogin,
    quote, bid, ask, entryRef,
    entryType, setEntryType, price, setPrice, priceNum, priceError, pendingType,
    volume, setVolume, typeVolume, blurVolume, stepLot, parsedVolume,
    sizeMode, setSizeMode, riskPct, setRiskPct, riskNeedsSl, riskUnsupported,
    sl, tp, setSl, setTp, slNum, tpNum, slInvalid, tpInvalid, slTpInvalid: slInvalid || tpInvalid,
    estMargin, riskPreview,
    orderId, rotateOrderId,
  }
}
