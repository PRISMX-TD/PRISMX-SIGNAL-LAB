// 滑动确认下单弹窗 / Slide-to-confirm order modal
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { MT5Account, Quote, Signal } from '../api/types'
import { calcCountdown, clientOrderId, contractSize, displaySymbol, localizeApiError, suggestVolumeByRisk, usdMarginBasis } from '../api/utils'
import { SIGNAL_LIFESPAN_MS } from './signals/SignalView'
import { useNow } from './signals/hooks'
import { useBackToClose } from '../utils/useBackToClose'
import { useStickyOnlineAccounts } from '../utils/useStickyOnlineAccounts'
import OrderConnectNotice from './OrderConnectNotice'

interface Props {
  signal: Signal
  accounts: MT5Account[]
  // 按交易商账户区分的报价：login -> {symbol: Quote}。选中哪个账户就用哪个
  // 交易商的报价，而不是跨账户合并的一份。/ Per-broker-account quotes:
  // login -> {symbol: Quote}. Whichever account is selected drives which
  // broker's quote is used, instead of a cross-account merged one.
  quotesByAccount: Record<string, Record<string, Quote>>
  onCancel: () => void
  onConfirm: (
    volume: number,
    mt5Login: string | null,
    stopLoss: number | null,
    takeProfit: number | null,
    clientOrderId: string,
  ) => Promise<void>
}

const QUICK_LOTS = [0.01, 0.10, 0.50, 1.00]

export default function SlideOrderModal({ signal, accounts, quotesByAccount, onCancel, onConfirm }: Props) {
  const { t } = useTranslation()
  const [submitting, setSubmitting] = useState(false)
  const [receipt, setReceipt] = useState<'waiting' | 'ok' | 'error' | null>(null)
  const [error, setError] = useState('')

  // 不用 accounts.filter(a => a.online)：在线标志抖一下就会把切换器整个卸载，
  // 表现为"一点切换账号，弹窗就没了"。见 useStickyOnlineAccounts 的说明。
  // Not a plain online filter — a flickering flag would unmount the switcher
  // mid-click. See useStickyOnlineAccounts.
  const availableAccounts = useStickyOnlineAccounts(accounts)
  const [login, setLogin] = useState<string>(() => availableAccounts[0]?.login ?? '')
  const selected = availableAccounts.find((a) => a.login === login) || null
  const [acctMenuOpen, setAcctMenuOpen] = useState(false)
  // 账户切换菜单套在这个（已全屏的）弹窗内部：划返回应该先收起菜单，
  // 再收起外层弹窗，而不是一划就把两层都带走。
  // The account-switcher menu nests inside this (already full-screen) modal:
  // swiping back should close the menu first, then the outer modal on a
  // second swipe, not take both out in one go.
  useBackToClose(acctMenuOpen, () => setAcctMenuOpen(false))
  // 选中账户对应交易商的实时报价：账户切换时自动跟着换成那家交易商的价格
  // The selected account's own broker quote: switching accounts automatically
  // switches which broker's price is used
  const quote = quotesByAccount[login]?.[signal.symbol]

  const suggestVolume = (eq?: number | null): string => {
    if (!eq || eq <= 0) return '0.10'
    const v = Math.max(0.01, Math.min(eq / 200, 1))
    return (Math.floor(v * 100) / 100).toFixed(2)
  }
  const [volume, setVolume] = useState(() => suggestVolume(availableAccounts[0]?.equity))
  const [sl, setSl] = useState(signal.stopLoss != null ? String(signal.stopLoss) : '')
  const [tp, setTp] = useState(signal.takeProfit != null ? String(signal.takeProfit) : '')

  // 手数模式：快捷手数 / 按风险百分比建议 / sizing mode: quick lots vs risk-percent suggestion
  const [sizeMode, setSizeMode] = useState<'quick' | 'risk'>('quick')
  const [riskPct, setRiskPct] = useState('1')
  const QUICK_RISK_PCTS = [0.5, 1, 2, 3]

  // 倒计时：弹窗打开期间信号也可能到期，到期即禁止滑动确认。
  // Countdown: the signal can expire while this modal is open; once expired,
  // the slide-to-confirm is disabled.
  const now = useNow(1000)
  const cd = calcCountdown(signal.expireAt, SIGNAL_LIFESPAN_MS, now)
  const expired = cd?.expired ?? false
  const cdTone = cd && cd.remainMs < 2 * 60 * 1000 ? 'text-down' : 'text-slate-300'

  const trackRef = useRef<HTMLDivElement>(null)
  const knobRef = useRef<HTMLDivElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const sliding = useRef(false)
  const pctRef = useRef(0)
  const travelRef = useRef(0) // 轨道可滑动像素范围 / draggable pixel range
  const rectRef = useRef({ left: 0, width: 0 })
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  // 本次下单的幂等号：整个弹窗生命周期内固定不变，重试（滑动失败后再滑）复用
  // 同一个号，避免"已收单但没收到回执→再滑一次"重复下单。弹窗每次打开都是
  // 新实例（activeSignal 变化时重新挂载），自然拿到新号。
  // Idempotency key for this order: fixed for the modal's whole lifetime so a
  // retry (slide again after a failure) reuses it, preventing a duplicate order
  // on "received but no receipt → slide again". Each open is a fresh instance
  // (remounts when activeSignal changes), so it naturally gets a new key.
  const orderIdRef = useRef<string>('')
  if (!orderIdRef.current) orderIdRef.current = clientOrderId()

  useEffect(() => {
    if (!login && availableAccounts[0]) setLogin(availableAccounts[0].login)
  }, [availableAccounts, login])

  useEffect(() => {
    setVolume(suggestVolume(selected?.equity))
  }, [selected?.login])

  // 校验止损/止盈是否在正确的方向：买单止损须低于现价、止盈须高于现价，卖单相反。
  // Validate SL/TP sit on the correct side of the reference price: for a BUY
  // the SL must be below and TP above the price; reversed for a SELL.
  const isBuy = signal.side === 'BUY'
  const entryRef = quote != null
    ? (isBuy ? quote.ask ?? signal.entry : quote.bid ?? signal.entry)
    : signal.entry
  const slNum = sl.trim() === '' ? null : parseFloat(sl)
  const tpNum = tp.trim() === '' ? null : parseFloat(tp)
  // 止损/止盈相对关系校验：即便拿不到参考价（既无实时报价、信号又无入场价，
  // entryRef 为 null），只要两者都填了，买单必须止损 < 止盈、卖单必须止损 > 止盈。
  // 这挡住"把 SL / TP 填反"这类和参考价无关的错误——否则要等指令发到 MT5 才被拒。
  // Relative SL/TP check: even with no reference price (no live quote and the
  // signal carries no entry, so entryRef is null), if both are filled a BUY
  // needs SL < TP and a SELL needs SL > TP. Catches a swapped SL/TP — an error
  // independent of the reference price — instead of only surfacing once MT5 rejects it.
  const slTpCross =
    slNum != null && tpNum != null && !Number.isNaN(slNum) && !Number.isNaN(tpNum) &&
    (isBuy ? slNum >= tpNum : slNum <= tpNum)
  const slInvalid =
    slTpCross ||
    (slNum != null && !Number.isNaN(slNum) && entryRef != null &&
      (isBuy ? slNum >= entryRef : slNum <= entryRef))
  const tpInvalid =
    slTpCross ||
    (tpNum != null && !Number.isNaN(tpNum) && entryRef != null &&
      (isBuy ? tpNum <= entryRef : tpNum >= entryRef))

  // 按风险百分比建议手数：净值 × 风险% ÷ 止损距离，随 SL/净值/风险%变化自动重算。
  // Suggest volume from a risk percentage: equity × risk% ÷ SL distance;
  // recomputed whenever SL, equity or the risk percentage changes.
  useEffect(() => {
    if (sizeMode !== 'risk') return
    if (slNum == null || Number.isNaN(slNum) || entryRef == null) return
    const distance = Math.abs(entryRef - slNum)
    const pct = parseFloat(riskPct) || 0
    const suggested = suggestVolumeByRisk(signal.symbol, selected?.equity, pct, distance, entryRef)
    if (suggested != null) setVolume(suggested.toFixed(2))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- entryRef/slNum derived each render; deps below cover real inputs
  }, [sizeMode, riskPct, sl, selected?.equity, signal.symbol, quote?.bid, quote?.ask])

  // Escape key（用 ref 避免依赖漂移 / use ref to avoid dependency drift）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onCancelRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting])

  // 这里曾经有一段自己接管返回手势的 useEffect：pushState 一条记录，再挂一个
  // popstate 监听无条件调 onCancel。它已被删除，因为渲染本弹窗的三个页面
  // （SignalsPage / DashboardPage / ChartsPage）都已经用 useBackToClose 做了同一件
  // 事，而那个裸监听器有一个致命缺陷——**收到任何 popstate 都关整个弹窗**。
  //
  // 后果是账户切换器彻底不可用：收起账户菜单时，菜单自己那层 useBackToClose 会调
  // history.back() 回收它压入的记录，这个裸监听器收到那次 popstate 就把整个下单弹窗
  // 关掉了。用户看到的是「一选另一个账号，弹窗就没了」，多账号用户根本换不了账号。
  //
  // useBackToClose 里的 selfInitiatedBacks / openStack 正是为这种嵌套场景写的：
  // 自己发起的 back 不算用户返回，非栈顶的实例不响应。裸监听器绕过了全部这些判断。
  //
  // This used to be a hand-rolled back-gesture handler: pushState an entry, listen
  // for popstate, unconditionally call onCancel. Deleted — all three pages that
  // render this modal already do it via useBackToClose, and the raw listener closed
  // the whole modal on *any* popstate. That made the account switcher unusable:
  // closing the account menu makes its own useBackToClose call history.back() to
  // reclaim its entry, and this listener read that as "close the order modal".
  // useBackToClose's selfInitiatedBacks/openStack bookkeeping exists precisely for
  // this nesting case; the raw listener bypassed all of it.

  // 拖动时直接操作 DOM，避免频繁 setState 触发整卡重渲染导致卡顿
  // Drive the DOM directly while dragging so we never re-render the whole card (kills jank)
  const paint = (pct: number) => {
    pctRef.current = pct
    const knob = knobRef.current
    const fill = fillRef.current
    if (knob) knob.style.transform = `translate(${(pct / 100) * travelRef.current}px, -50%)`
    if (fill) fill.style.width = `${pct}%`
  }

  const getPct = (clientX: number) => {
    const { left, width } = rectRef.current
    const travel = width - 56
    if (travel <= 0) return 0
    // 让滑块中心跟随手指 / keep the knob centered under the finger
    const x = clientX - left - 28
    return Math.max(0, Math.min(100, (x / travel) * 100))
  }

  const onStart = (clientX: number) => {
    if (submitting) return
    const el = trackRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    rectRef.current = { left: r.left, width: r.width }
    travelRef.current = r.width - 56
    sliding.current = true
    el.classList.add('dragging')
    paint(getPct(clientX))
  }
  const onMove = (clientX: number) => {
    if (!sliding.current || submitting) return
    const pct = getPct(clientX)
    paint(pct)
    if (pct >= 95) {
      sliding.current = false
      const el = trackRef.current
      el?.classList.remove('dragging')
      el?.classList.add('done')
      paint(100)
      handleSubmit()
    }
  }
  const onEnd = () => {
    if (!sliding.current) return
    sliding.current = false
    const el = trackRef.current
    el?.classList.remove('dragging')
    if (pctRef.current >= 95) {
      el?.classList.add('done')
      paint(100)
      handleSubmit()
    } else {
      paint(0)
    }
  }

  const handleSubmit = async () => {
    if (expired) {
      setError(t('order.signalExpiredInModal'))
      return
    }
    if (slInvalid || tpInvalid) {
      setError(t('order.slTpInvalid'))
      return
    }
    setReceipt('waiting')
    setSubmitting(true)
    setError('')
    const vol = parseFloat(volume)
    if (!vol || vol <= 0) {
      setError(t('order.volume'))
      setSubmitting(false)
      setReceipt(null)
      return
    }
    try {
      await onConfirm(vol, login || null, slNum, tpNum, orderIdRef.current)
      setReceipt('ok')
      setTimeout(() => onCancel(), 2000)
    } catch (err) {
      setReceipt('error')
      setError(err instanceof Error ? localizeApiError(err.message) : 'error')
      setTimeout(() => {
        setReceipt(null)
        setSubmitting(false)
      }, 2000)
    }
  }

  const stepLot = (dir: number) => {
    const v = parseFloat(volume) || 0.01
    const next = Math.max(0.01, Math.min(10, +(v + dir * 0.01).toFixed(2)))
    setVolume(String(next))
  }

  const symLetter = (signal.symbol[0] ?? '?').toUpperCase()
  const avaBg = isBuy ? 'rgba(46,224,126,0.15)' : 'rgba(255,77,103,0.15)'
  const avaColor = isBuy ? 'var(--up)' : 'var(--down)'
  const priceColor = isBuy ? 'var(--up)' : 'var(--down)'

  const hasAccounts = availableAccounts.length > 0
  const canSubmit = hasAccounts && !expired && !slInvalid && !tpInvalid

  const fmtMoney = (n?: number | null) =>
    n == null ? '-' : n.toLocaleString(undefined, { maximumFractionDigits: 2 })

  // 粗估保证金占用（假定账户货币为 USD）：'quote' 基准品种(如 XAUUSD/EURUSD)
  // 是 手数×合约规模×现价/杠杆——此前漏乘现价，黄金/白银/加密货币等的估算
  // 会偏小上千倍；'base' 基准品种(如 USDJPY)现价已经内含在合约规模的美元
  // 价值里，不应再乘现价。基准未知的交叉盘(如 EURGBP)没有可靠现价能单独
  // 换算成美元，返回 null 而不是给一个算错的数字。
  // Rough margin estimate (assumes a USD account currency): 'quote'-basis
  // symbols (XAUUSD/EURUSD, ...) need lots × contract size × current price /
  // leverage — this used to omit the price factor, understating gold/silver/
  // crypto estimates by up to thousands of times; 'base'-basis symbols
  // (USDJPY, ...) already have their USD notional value in the contract size
  // alone and must NOT be multiplied by price again. Cross pairs with an
  // unknown basis (EURGBP, ...) have no single reliable price to convert to
  // USD with, so this returns null rather than a plausible-looking wrong number.
  const estMargin = (() => {
    const vol = parseFloat(volume)
    const lev = selected?.leverage
    if (!vol || vol <= 0 || !lev || lev <= 0) return null
    const basis = usdMarginBasis(signal.symbol)
    if (basis == null) return null
    const size = contractSize(signal.symbol)
    if (basis === 'base') return (vol * size) / lev
    if (!entryRef || entryRef <= 0) return null
    return (vol * size * entryRef) / lev
  })()

  // 用 Portal 挂到 body：页面内容外层 .page-enter 有 transform 动画，会成为
  // fixed 定位的包含块，导致弹窗相对内容区而非视口定位、位置错乱。挂到 body
  // 可脱离该祖先，让 fixed 重新相对视口。/ Portal to body: the .page-enter
  // wrapper around page content has a transform animation, which becomes the
  // containing block for fixed positioning and mislocates the modal relative to
  // the content area instead of the viewport. Portaling to body escapes that
  // ancestor so fixed positions against the viewport again.
  return createPortal(
    <div className="slide-overlay" onClick={onCancel}>
      <div className="slide-sheet" onClick={(e) => e.stopPropagation()}>
        <button className="slide-cancel-x" onClick={onCancel}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>

        <div className="slide-sheet-head">
          <div className="flex items-center justify-center gap-2">
            <div className="slide-sheet-ava" style={{ background: avaBg, color: avaColor }}>{symLetter}</div>
          </div>
          <h3 className="text-lg mt-2.5 text-white font-bold">
            {isBuy ? t('common.buy') : t('common.sell')} {displaySymbol(signal.symbol)}
          </h3>
          <p className="text-xs text-slate-300 mt-1">
            {t('order.currentPrice')} <span className="num" style={{ color: priceColor }}>
              {quote ? (isBuy ? (quote.ask?.toFixed(quote.digits ?? 5) ?? signal.entry) : (quote.bid?.toFixed(quote.digits ?? 5) ?? signal.entry)) : signal.entry ?? '-'}
            </span>
            {selected && <> · {t('order.account')} {selected.login}</>}
          </p>
          {cd && (
            <div className={`mt-2 flex items-center justify-center gap-1.5 text-xs font-semibold ${cdTone}`}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
              </svg>
              <span>{t('order.signalExpiresIn')}</span>
              <span className="num">{cd.text}</span>
            </div>
          )}
        </div>

        <div className="slide-sheet-rows">
          {availableAccounts.length > 1 && (
            <div className="slide-row slide-row-acct">
              <span className="k">{t('order.account')}</span>
              <div className="slide-acct-picker">
                <button
                  type="button"
                  className="slide-acct-trigger"
                  onClick={() => setAcctMenuOpen((v) => !v)}
                >
                  <span>{selected?.login}{selected?.accountName ? ` · ${selected.accountName}` : ''}</span>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: acctMenuOpen ? 'rotate(180deg)' : undefined }}><path d="M6 9l6 6 6-6"/></svg>
                </button>
                {acctMenuOpen && (
                  <>
                    <div className="slide-acct-backdrop" onClick={() => setAcctMenuOpen(false)} />
                    <div className="slide-acct-menu">
                      {availableAccounts.map((a) => (
                        <button
                          type="button"
                          key={a.login}
                          className={`slide-acct-opt ${a.login === login ? 'active' : ''}`}
                          onClick={() => { setLogin(a.login); setAcctMenuOpen(false) }}
                        >
                          <span className="opt-login">
                            {/* 列表会保留本次弹窗里掉线的账号（见 useStickyOnlineAccounts），
                                所以状态必须标出来，不能让用户以为它一定可用。
                                The list keeps accounts that went offline mid-modal, so their
                                state has to show — silence would imply they're all usable. */}
                            <i className={`opt-dot ${a.online ? 'on' : ''}`} />
                            {a.login}{a.accountName ? ` · ${a.accountName}` : ''}
                          </span>
                          <span className="opt-equity num">{fmtMoney(a.equity)} {a.accountCurrency ?? ''}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          {selected && (
            <div className="slide-row">
              <span className="k">{t('bind.equity')} / {t('bind.balance')}</span>
              <span className="v num">
                {fmtMoney(selected.equity)} <i>/ {fmtMoney(selected.balance)} {selected.accountCurrency ?? ''}</i>
              </span>
            </div>
          )}
          <div className="slide-row">
            <span className="k">{t('order.sizeMode')}</span>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setSizeMode('quick')}
                className={`px-2.5 py-1 rounded-md text-xs font-medium border ${sizeMode === 'quick' ? 'border-prism-500/60 bg-prism-600/20 text-prism-200' : 'border-white/10 bg-white/5 text-slate-400'}`}
              >
                {t('order.sizeModeLots')}
              </button>
              <button
                type="button"
                onClick={() => setSizeMode('risk')}
                className={`px-2.5 py-1 rounded-md text-xs font-medium border ${sizeMode === 'risk' ? 'border-prism-500/60 bg-prism-600/20 text-prism-200' : 'border-white/10 bg-white/5 text-slate-400'}`}
              >
                {t('order.sizeModeRisk')}
              </button>
            </div>
          </div>
          <div className="slide-row">
            <span className="k">{t('order.volume')}</span>
            <span className="stepper">
              <button onClick={() => stepLot(-1)}>−</button>
              <input
                className="lot-val num lot-input"
                value={volume}
                inputMode="decimal"
                onChange={(e) => setVolume(e.target.value.replace(/[^0-9.]/g, ''))}
                onBlur={() => {
                  const v = parseFloat(volume)
                  setVolume((!v || v <= 0 ? 0.01 : Math.min(10, v)).toFixed(2))
                }}
              />
              <button onClick={() => stepLot(1)}>+</button>
            </span>
          </div>
          {sizeMode === 'quick' ? (
            <div className="slide-row">
              <span className="k" />
              <div className="flex gap-1.5">
                {QUICK_LOTS.map((q) => (
                  <button key={q} onClick={() => setVolume(q.toFixed(2))} className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-xs text-slate-300 hover:border-prism-500/50 hover:text-prism-300 font-mono">
                    {q.toFixed(2)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="slide-row">
              <span className="k">{t('order.riskPct')}</span>
              <div className="flex items-center gap-1.5">
                {QUICK_RISK_PCTS.map((p) => (
                  <button
                    key={p}
                    onClick={() => setRiskPct(String(p))}
                    className={`px-2 py-0.5 rounded-md border text-xs font-mono ${riskPct === String(p) ? 'border-prism-500/60 bg-prism-600/20 text-prism-200' : 'border-white/10 bg-white/5 text-slate-300'}`}
                  >
                    {p}%
                  </button>
                ))}
              </div>
            </div>
          )}
          {sizeMode === 'risk' && slNum == null && (
            <div className="slide-row">
              <span className="k" />
              <span className="text-xs text-amber-400/90">{t('order.riskNeedsSl')}</span>
            </div>
          )}
          {sizeMode === 'risk' && slNum != null && usdMarginBasis(signal.symbol) == null && (
            <div className="slide-row">
              <span className="k" />
              <span className="text-xs text-amber-400/90">{t('order.riskUnsupportedPair')}</span>
            </div>
          )}
          <div className="slide-row">
            <span className="k">{t('signals.colSl')} / {t('signals.colTp')}</span>
            <div className="flex items-center gap-2">
              <input className={`h-8 w-[90px] rounded-lg bg-white/5 border px-2 text-sm num text-down text-right ${slInvalid ? 'border-down' : 'border-down/40'}`} value={sl} onChange={(e) => setSl(e.target.value)} placeholder={signal.stopLoss != null ? String(signal.stopLoss) : 'SL'} />
              <i className="text-slate-500">/</i>
              <input className={`h-8 w-[90px] rounded-lg bg-white/5 border px-2 text-sm num text-up text-right ${tpInvalid ? 'border-down' : 'border-up/40'}`} value={tp} onChange={(e) => setTp(e.target.value)} placeholder={signal.takeProfit != null ? String(signal.takeProfit) : 'TP'} />
            </div>
          </div>
          {(slInvalid || tpInvalid) && (
            <div className="slide-row">
              <span className="k" />
              <span className="text-xs text-down">
                {slInvalid ? t('order.slWrongSide') : t('order.tpWrongSide')}
              </span>
            </div>
          )}
          {estMargin != null && (
            <div className="slide-row">
              <span className="k">{t('order.estMargin')}</span>
              <span className="v num">≈ {estMargin.toLocaleString(undefined, { maximumFractionDigits: 0 })} {selected?.accountCurrency ?? ''}</span>
            </div>
          )}
        </div>

        <div className="slide-note">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>
          <span>{t('order.riskNote')}</span>
        </div>
        <p className="px-1 -mt-2.5 mb-3 text-[11px] leading-relaxed text-slate-500">
          {t('order.timeoutNote')}
        </p>

        {!hasAccounts && (
          <OrderConnectNotice neverConnected={accounts.length === 0} />
        )}
        {hasAccounts && expired && (
          <div className="mb-3 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">{t('order.signalExpiredInModal')}</div>
        )}
        {error && (
          <div className="mb-3 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">{error}</div>
        )}

        {/* Receipt card */}
        {receipt && (
          <div className="receipt-card">
            <div className={`receipt-line ${receipt === 'ok' ? 'ok' : 'wait'}`}>
              {receipt === 'waiting' && <><span className="spinner" />{t('order.submitting')}...</>}
              {/* 提交成功那一刻订单几乎总是还是 PENDING（真正成交要等桥接轮询执行+回执），
                  之前这里显示"已成交"是假的；改成如实的"已提交，等待成交回执"，
                  真正的成交/拒绝结果由页面级 toast（监听 WS ORDER_UPDATE）稍后报告。
                  The order is almost always still PENDING the instant submit resolves
                  (the real fill happens later via the bridge's poll+execute+ack); this
                  used to claim "filled", which wasn't true. Show the honest "submitted,
                  awaiting receipt" instead — the real fill/reject result is reported a
                  moment later by the page-level toast that watches WS ORDER_UPDATE. */}
              {receipt === 'ok' && <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>{t('order.submitted')}</>}
              {receipt === 'error' && <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>{error || t('order.rejected', { msg: '' })}</>}
            </div>
          </div>
        )}

        {/* Slide track：Pointer Capture 让拖动离开轨道也持续跟手；
            touch-action:none 防止移动端拖动时带动页面滚动。
            Pointer capture keeps the drag tracking even outside the track;
            touch-action none stops the page from scrolling under the drag. */}
        {!submitting && canSubmit && (
          <div
            ref={trackRef}
            className="slide-track"
            style={{ touchAction: 'none' }}
          >
            <div ref={fillRef} className="slide-track-fill" />
            <div className="slide-track-label">{t('order.slideToConfirm', '滑动确认下单')}</div>
            <div
              ref={knobRef}
              className="slide-knob"
              style={{ touchAction: 'none' }}
              onPointerDown={(e: RPointerEvent<HTMLDivElement>) => {
                e.preventDefault()
                e.currentTarget.setPointerCapture(e.pointerId)
                onStart(e.clientX)
              }}
              onPointerMove={(e: RPointerEvent<HTMLDivElement>) => onMove(e.clientX)}
              onPointerUp={onEnd}
              onPointerCancel={onEnd}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </div>
          </div>
        )}

        {/* Slide done state: close button */}
        {receipt && (
          <button onClick={onCancel} className="btn btn-ghost slide-close-btn">
            {t('common.close')}
          </button>
        )}
      </div>
    </div>,
    document.body,
  )
}
