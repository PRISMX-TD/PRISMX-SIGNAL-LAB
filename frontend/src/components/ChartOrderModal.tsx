// 图表页手动下单弹窗（不绑定信号）：买/卖 + 手数 + 止盈止损 + 选择 MT5 账户，
// 滑动确认。与 SlideOrderModal 视觉一致（复用 .slide-* 样式），但去掉了信号
// 倒计时/过期逻辑，参考价取实时报价或图表最新价。
//
// Manual (non-signal) order modal for the charts page: buy/sell + lots + SL/TP
// + MT5 account picker, slide to confirm. Visually consistent with
// SlideOrderModal (reuses the .slide-* styles) but without the signal
// countdown/expiry; the reference price comes from the live quote or the
// chart's latest price.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import type { MT5Account, Quote } from '../api/types'
import { clientOrderId, contractSize, displaySymbol, localizeApiError, suggestVolumeByRisk, usdMarginBasis } from '../api/utils'
import { useBackToClose } from '../utils/useBackToClose'

interface Props {
  symbol: string
  side: 'BUY' | 'SELL'
  accounts: MT5Account[]
  // 按交易商账户区分的报价：login -> {symbol: Quote}，见 SlideOrderModal.tsx 同名注释
  // Per-broker-account quotes: login -> {symbol: Quote}; see SlideOrderModal.tsx's matching comment
  quotesByAccount: Record<string, Record<string, Quote>>
  // 图表最新收盘价：无实时报价时作为参考价 / chart's latest close, used when no live quote
  refPrice?: number
  // 价格显示小数位 / price display precision
  digits?: number
  // 预填止损止盈（如来自自定义策略触发的信号）；省略则保持原有空白手填行为
  // Prefilled SL/TP (e.g. from a triggered custom-strategy signal); omitted
  // keeps the original blank-and-fill-by-hand behavior
  initialStopLoss?: number
  initialTakeProfit?: number
  onCancel: () => void
  onConfirm: (
    volume: number,
    mt5Login: string | null,
    stopLoss: number | null,
    takeProfit: number | null,
    clientOrderId: string,
  ) => Promise<void>
}

const QUICK_LOTS = [0.01, 0.1, 0.5, 1.0]
const QUICK_RISK_PCTS = [0.5, 1, 2, 3]

export default function ChartOrderModal({ symbol, side, accounts, quotesByAccount, refPrice, digits = 2, initialStopLoss, initialTakeProfit, onCancel, onConfirm }: Props) {
  const { t } = useTranslation()
  const [submitting, setSubmitting] = useState(false)
  const [receipt, setReceipt] = useState<'waiting' | 'ok' | 'error' | null>(null)
  const [error, setError] = useState('')

  const isBuy = side === 'BUY'
  const onlineAccounts = accounts.filter((a) => a.online)
  const [login, setLogin] = useState<string>(() => onlineAccounts[0]?.login ?? '')
  const selected = onlineAccounts.find((a) => a.login === login) || null
  const [acctMenuOpen, setAcctMenuOpen] = useState(false)
  // 账户切换菜单套在这个（已全屏的）弹窗内部：划返回应该先收起菜单，
  // 再收起外层弹窗，而不是一划就把两层都带走。
  // The account-switcher menu nests inside this (already full-screen) modal:
  // swiping back should close the menu first, then the outer modal on a
  // second swipe, not take both out in one go.
  useBackToClose(acctMenuOpen, () => setAcctMenuOpen(false))
  // 选中账户对应交易商的实时报价 / the selected account's own broker quote
  const quote = quotesByAccount[login]?.[symbol]

  const suggestVolume = (eq?: number | null): string => {
    if (!eq || eq <= 0) return '0.10'
    const v = Math.max(0.01, Math.min(eq / 200, 1))
    return (Math.floor(v * 100) / 100).toFixed(2)
  }
  const [volume, setVolume] = useState(() => suggestVolume(onlineAccounts[0]?.equity))
  const [sl, setSl] = useState(() => (initialStopLoss != null ? String(initialStopLoss) : ''))
  const [tp, setTp] = useState(() => (initialTakeProfit != null ? String(initialTakeProfit) : ''))
  const [sizeMode, setSizeMode] = useState<'quick' | 'risk'>('quick')
  const [riskPct, setRiskPct] = useState('1')

  const trackRef = useRef<HTMLDivElement>(null)
  const knobRef = useRef<HTMLDivElement>(null)
  const fillRef = useRef<HTMLDivElement>(null)
  const sliding = useRef(false)
  const pctRef = useRef(0)
  const travelRef = useRef(0)
  const rectRef = useRef({ left: 0, width: 0 })
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  // 本次下单的幂等号：整个弹窗生命周期内固定不变，重试复用同一个号，避免
  // 重复下单（详见 SlideOrderModal.tsx 同名注释）。
  // Idempotency key for this order, fixed for the modal's lifetime so retries
  // reuse it and never double-place (see SlideOrderModal.tsx's matching note).
  const orderIdRef = useRef<string>('')
  if (!orderIdRef.current) orderIdRef.current = clientOrderId()

  useEffect(() => {
    if (!login && onlineAccounts[0]) setLogin(onlineAccounts[0].login)
  }, [onlineAccounts, login])

  useEffect(() => {
    setVolume(suggestVolume(selected?.equity))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.login])

  // 参考价：优先实时报价（买用 ask、卖用 bid），否则用图表最新价
  // Reference price: live quote first (ask for buy, bid for sell), else chart's latest
  const entryRef =
    quote != null
      ? isBuy
        ? quote.ask ?? refPrice ?? null
        : quote.bid ?? refPrice ?? null
      : refPrice && refPrice > 0
        ? refPrice
        : null

  const slNum = sl.trim() === '' ? null : parseFloat(sl)
  const tpNum = tp.trim() === '' ? null : parseFloat(tp)
  // 止损/止盈相对关系校验：即便拿不到参考价（entryRef 为 null），只要两者都填了，
  // 买单必须止损 < 止盈、卖单必须止损 > 止盈，挡住"把 SL / TP 填反"这类错误。
  // Relative SL/TP check: even with no reference price (entryRef null), if both
  // are filled a BUY needs SL < TP and a SELL needs SL > TP — catches a swapped SL/TP.
  const slTpCross =
    slNum != null && tpNum != null && !Number.isNaN(slNum) && !Number.isNaN(tpNum) &&
    (isBuy ? slNum >= tpNum : slNum <= tpNum)
  const slInvalid =
    slTpCross ||
    (slNum != null && !Number.isNaN(slNum) && entryRef != null && (isBuy ? slNum >= entryRef : slNum <= entryRef))
  const tpInvalid =
    slTpCross ||
    (tpNum != null && !Number.isNaN(tpNum) && entryRef != null && (isBuy ? tpNum <= entryRef : tpNum >= entryRef))

  // 按风险百分比建议手数 / suggest volume from a risk percentage
  useEffect(() => {
    if (sizeMode !== 'risk') return
    if (slNum == null || Number.isNaN(slNum) || entryRef == null) return
    const distance = Math.abs(entryRef - slNum)
    const pct = parseFloat(riskPct) || 0
    const suggested = suggestVolumeByRisk(symbol, selected?.equity, pct, distance, entryRef)
    if (suggested != null) setVolume(suggested.toFixed(2))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizeMode, riskPct, sl, selected?.equity, symbol, quote?.bid, quote?.ask, refPrice])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onCancelRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [submitting])

  // 手机端返回手势：关闭弹窗而非切换页面 / mobile back gesture closes the modal
  useEffect(() => {
    let poppedByBack = false
    window.history.pushState({ __chartOrderModal: true }, '')
    const onPop = () => {
      poppedByBack = true
      onCancelRef.current()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      if (!poppedByBack && window.history.state?.__chartOrderModal) window.history.back()
    }
  }, [])

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
    if (slInvalid || tpInvalid) {
      setError(t('order.slTpInvalid'))
      return
    }
    const vol = parseFloat(volume)
    if (!vol || vol <= 0) {
      setError(t('order.volume'))
      return
    }
    setReceipt('waiting')
    setSubmitting(true)
    setError('')
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

  const symLetter = (symbol[0] ?? '?').toUpperCase()
  const avaBg = isBuy ? 'rgba(46,224,126,0.15)' : 'rgba(255,77,103,0.15)'
  const avaColor = isBuy ? 'var(--up)' : 'var(--down)'
  const priceColor = isBuy ? 'var(--up)' : 'var(--down)'

  const hasAccounts = onlineAccounts.length > 0
  const offlineMsg = accounts.length === 0 ? t('order.noBridge') : t('order.allOffline')
  const canSubmit = hasAccounts && !slInvalid && !tpInvalid

  const fmtMoney = (n?: number | null) => (n == null ? '-' : n.toLocaleString(undefined, { maximumFractionDigits: 2 }))
  const fmtPrice = (n?: number | null) => (n == null ? '-' : n.toFixed(digits))

  // 保证金估算公式说明见 SlideOrderModal.tsx 同名注释
  // see SlideOrderModal.tsx's matching comment for the formula rationale
  const estMargin = (() => {
    const vol = parseFloat(volume)
    const lev = selected?.leverage
    if (!vol || vol <= 0 || !lev || lev <= 0) return null
    const basis = usdMarginBasis(symbol)
    if (basis == null) return null
    const size = contractSize(symbol)
    if (basis === 'base') return (vol * size) / lev
    if (!entryRef || entryRef <= 0) return null
    return (vol * size * entryRef) / lev
  })()

  // 用 Portal 挂到 body：见 SlideOrderModal.tsx 同名说明——页面内容外层
  // .page-enter 的 transform 动画会成为 fixed 的包含块，导致弹窗定位错乱。
  // Portal to body: see SlideOrderModal.tsx's matching note — the .page-enter
  // wrapper's transform animation becomes the containing block for fixed and
  // mislocates the modal.
  return createPortal(
    <div className="slide-overlay" onClick={onCancel}>
      <div className="slide-sheet" onClick={(e) => e.stopPropagation()}>
        <button className="slide-cancel-x" onClick={onCancel}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>

        <div className="slide-sheet-head">
          <div className="flex items-center justify-center gap-2">
            <div className="slide-sheet-ava" style={{ background: avaBg, color: avaColor }}>{symLetter}</div>
          </div>
          <h3 className="text-lg mt-2.5 text-white font-bold">
            {isBuy ? t('common.buy') : t('common.sell')} {displaySymbol(symbol)}
          </h3>
          <p className="text-xs text-slate-300 mt-1">
            {t('order.currentPrice')}{' '}
            <span className="num" style={{ color: priceColor }}>{fmtPrice(entryRef)}</span>
            {selected && <> · {t('order.account')} {selected.login}</>}
          </p>
        </div>

        <div className="slide-sheet-rows">
          {onlineAccounts.length > 1 && (
            <div className="slide-row slide-row-acct">
              <span className="k">{t('order.account')}</span>
              <div className="slide-acct-picker">
                <button type="button" className="slide-acct-trigger" onClick={() => setAcctMenuOpen((v) => !v)}>
                  <span>{selected?.login}{selected?.accountName ? ` · ${selected.accountName}` : ''}</span>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ transform: acctMenuOpen ? 'rotate(180deg)' : undefined }}><path d="M6 9l6 6 6-6" /></svg>
                </button>
                {acctMenuOpen && (
                  <>
                    <div className="slide-acct-backdrop" onClick={() => setAcctMenuOpen(false)} />
                    <div className="slide-acct-menu">
                      {onlineAccounts.map((a) => (
                        <button
                          type="button"
                          key={a.login}
                          className={`slide-acct-opt ${a.login === login ? 'active' : ''}`}
                          onClick={() => { setLogin(a.login); setAcctMenuOpen(false) }}
                        >
                          <span className="opt-login">{a.login}{a.accountName ? ` · ${a.accountName}` : ''}</span>
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
          {sizeMode === 'risk' && slNum != null && usdMarginBasis(symbol) == null && (
            <div className="slide-row">
              <span className="k" />
              <span className="text-xs text-amber-400/90">{t('order.riskUnsupportedPair')}</span>
            </div>
          )}
          <div className="slide-row">
            <span className="k">{t('signals.colSl')} / {t('signals.colTp')}</span>
            <div className="flex items-center gap-2">
              <input className={`h-8 w-[90px] rounded-lg bg-white/5 border px-2 text-sm num text-down text-right ${slInvalid ? 'border-down' : 'border-down/40'}`} value={sl} onChange={(e) => setSl(e.target.value)} placeholder="SL" />
              <i className="text-slate-500">/</i>
              <input className={`h-8 w-[90px] rounded-lg bg-white/5 border px-2 text-sm num text-up text-right ${tpInvalid ? 'border-down' : 'border-up/40'}`} value={tp} onChange={(e) => setTp(e.target.value)} placeholder="TP" />
            </div>
          </div>
          {(slInvalid || tpInvalid) && (
            <div className="slide-row">
              <span className="k" />
              <span className="text-xs text-down">{slInvalid ? t('order.slWrongSide') : t('order.tpWrongSide')}</span>
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
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
          <span>{t('order.riskNote')}</span>
        </div>
        <p className="px-1 -mt-2.5 mb-3 text-[11px] leading-relaxed text-slate-500">{t('order.timeoutNote')}</p>

        {!hasAccounts && (
          <div className="mb-3 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">{offlineMsg}</div>
        )}
        {error && (
          <div className="mb-3 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">{error}</div>
        )}

        {receipt && (
          <div className="receipt-card">
            <div className={`receipt-line ${receipt === 'ok' ? 'ok' : 'wait'}`}>
              {receipt === 'waiting' && <><span className="spinner" />{t('order.submitting')}...</>}
              {receipt === 'ok' && <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>{t('order.submitted')}</>}
              {receipt === 'error' && <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6M9 9l6 6" /></svg>{error || t('order.rejected', { msg: '' })}</>}
            </div>
          </div>
        )}

        {!submitting && canSubmit && (
          <div ref={trackRef} className="slide-track" style={{ touchAction: 'none' }}>
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
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7" /></svg>
            </div>
          </div>
        )}

        {receipt && (
          <button onClick={onCancel} className="btn btn-ghost slide-close-btn">{t('common.close')}</button>
        )}
      </div>
    </div>,
    document.body,
  )
}
