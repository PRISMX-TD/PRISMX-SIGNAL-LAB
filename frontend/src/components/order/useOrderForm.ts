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
import type { MT5Account, Quote } from '../../api/types'
import { clientOrderId, usdMarginBasis } from '../../api/utils'
import { pickDefaultAccount, useLastAccount } from '../../utils/useLastAccount'
import {
  checkSlTp,
  estimateMargin,
  normalizeVolume,
  parseOptionalNumber,
  previewRisk,
  sanitizeDecimal,
  stepVolume,
  suggestVolume,
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
  /** 入场参考价：买用卖价、卖用买价 / entry reference: ask for BUY, bid for SELL */
  entryRef: number | null
  volume: string
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
  const quote = (selected && quotesByAccount[selected.login]?.[symbol]) || fallbackQuote
  const ref = refPrice != null && refPrice > 0 ? refPrice : null
  const bid = quote?.bid ?? ref
  const ask = quote?.ask ?? ref
  const entryRef = isBuy ? ask : bid

  // ---- 手数 / volume ----------------------------------------------------------
  const [volume, setVolume] = useState(() => suggestVolume(accounts[0]?.equity))
  const [sizeMode, setSizeMode] = useState<SizeMode>('quick')
  const [riskPct, setRiskPct] = useState('1')
  const typeVolume = (raw: string) => setVolume(sanitizeDecimal(raw))
  const blurVolume = () => setVolume(normalizeVolume(volume))
  const stepLot = (dir: 1 | -1) => setVolume(stepVolume(volume, dir))
  const parsedVolumeRaw = parseFloat(volume)
  const parsedVolume = parsedVolumeRaw > 0 ? parsedVolumeRaw : null

  // ---- 止损止盈 / SL & TP -----------------------------------------------------
  const [sl, setSl] = useState(() => (initialStopLoss != null ? String(initialStopLoss) : ''))
  const [tp, setTp] = useState(() => (initialTakeProfit != null ? String(initialTakeProfit) : ''))
  const slNum = parseOptionalNumber(sl)
  const tpNum = parseOptionalNumber(tp)
  const { slInvalid, tpInvalid } = checkSlTp(isBuy, slNum, tpNum, entryRef)

  // 换账户时按净值重估默认手数（仅手数模式；风险模式由下面的 effect 负责）。
  // Re-suggest the default lots on account change (lots mode only).
  useEffect(() => {
    if (sizeMode === 'quick') setVolume(suggestVolume(selected?.equity))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.login])

  // 按风险百分比建议手数：净值 × 风险% ÷ 止损距离，随 SL / 净值 / 风险% / 报价变化重算。
  // Risk-% sizing, recomputed whenever SL, equity, risk % or the quote moves.
  useEffect(() => {
    if (sizeMode !== 'risk') return
    const suggested = suggestVolumeForRisk(symbol, selected?.equity, riskPct, slNum, entryRef)
    if (suggested != null) setVolume(suggested)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- slNum/entryRef derive from these
  }, [sizeMode, riskPct, sl, selected?.equity, symbol, quote?.bid, quote?.ask, refPrice])

  const riskNeedsSl = sizeMode === 'risk' && slNum == null
  const riskUnsupported = sizeMode === 'risk' && slNum != null && usdMarginBasis(symbol) == null

  // ---- 估算 / estimates -------------------------------------------------------
  const estMargin = useMemo(
    () => estimateMargin(symbol, volume, selected?.leverage, entryRef),
    [symbol, volume, selected?.leverage, entryRef],
  )
  const riskPreview = useMemo(
    () => previewRisk(symbol, volume, entryRef, slNum, tpNum),
    [symbol, volume, entryRef, slNum, tpNum],
  )

  // ---- 幂等号 / idempotency key ----------------------------------------------
  // 在一次表单生命周期内固定不变：滑动 / 点击失败后再试复用同一个号，避免"已收单
  // 但没收到回执 → 再来一次"变成两笔。成功提交后才换新号（停靠面板会连续下多单）。
  // Fixed across retries so "received but no receipt → try again" can't double-
  // place; rotated only after a successful submit (the docked ticket places many).
  const orderIdRef = useRef<string>('')
  if (!orderIdRef.current) orderIdRef.current = clientOrderId()
  const [orderId, setOrderId] = useState(orderIdRef.current)
  const rotateOrderId = () => { orderIdRef.current = clientOrderId(); setOrderId(orderIdRef.current) }

  return {
    isBuy, accounts, hasAccounts: accounts.length > 0, login, selected, chooseLogin,
    quote, bid, ask, entryRef,
    volume, setVolume, typeVolume, blurVolume, stepLot, parsedVolume,
    sizeMode, setSizeMode, riskPct, setRiskPct, riskNeedsSl, riskUnsupported,
    sl, tp, setSl, setTp, slNum, tpNum, slInvalid, tpInvalid, slTpInvalid: slInvalid || tpInvalid,
    estMargin, riskPreview,
    orderId, rotateOrderId,
  }
}
