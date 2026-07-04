// 滑动确认下单弹窗 / Slide-to-confirm order modal
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { MT5Account, Quote, Signal } from '../api/types'
import { calcCountdown, contractSize, suggestVolumeByRisk } from '../api/utils'
import { SIGNAL_LIFESPAN_MS } from './signals/signalView'
import { useNow } from './signals/hooks'

interface Props {
  signal: Signal
  accounts: MT5Account[]
  quote?: Quote
  onCancel: () => void
  onConfirm: (
    volume: number,
    mt5Login: string | null,
    stopLoss: number | null,
    takeProfit: number | null,
  ) => Promise<void>
}

const QUICK_LOTS = [0.01, 0.10, 0.50, 1.00]

export default function SlideOrderModal({ signal, accounts, quote, onCancel, onConfirm }: Props) {
  const { t } = useTranslation()
  const [submitting, setSubmitting] = useState(false)
  const [receipt, setReceipt] = useState<'waiting' | 'ok' | 'error' | null>(null)
  const [error, setError] = useState('')

  const onlineAccounts = accounts.filter((a) => a.online)
  const [login, setLogin] = useState<string>(() => onlineAccounts[0]?.login ?? '')
  const selected = onlineAccounts.find((a) => a.login === login) || null
  const [acctMenuOpen, setAcctMenuOpen] = useState(false)

  const suggestVolume = (eq?: number | null): string => {
    if (!eq || eq <= 0) return '0.10'
    const v = Math.max(0.01, Math.min(eq / 200, 1))
    return (Math.floor(v * 100) / 100).toFixed(2)
  }
  const [volume, setVolume] = useState(() => suggestVolume(onlineAccounts[0]?.equity))
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

  useEffect(() => {
    if (!login && onlineAccounts[0]) setLogin(onlineAccounts[0].login)
  }, [onlineAccounts, login])

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
  const slInvalid =
    slNum != null && !Number.isNaN(slNum) && entryRef != null &&
    (isBuy ? slNum >= entryRef : slNum <= entryRef)
  const tpInvalid =
    tpNum != null && !Number.isNaN(tpNum) && entryRef != null &&
    (isBuy ? tpNum <= entryRef : tpNum >= entryRef)

  // 按风险百分比建议手数：净值 × 风险% ÷ 止损距离，随 SL/净值/风险%变化自动重算。
  // Suggest volume from a risk percentage: equity × risk% ÷ SL distance;
  // recomputed whenever SL, equity or the risk percentage changes.
  useEffect(() => {
    if (sizeMode !== 'risk') return
    if (slNum == null || Number.isNaN(slNum) || entryRef == null) return
    const distance = Math.abs(entryRef - slNum)
    const pct = parseFloat(riskPct) || 0
    const suggested = suggestVolumeByRisk(signal.symbol, selected?.equity, pct, distance)
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

  // 手机端返回手势/按钮：关闭本弹窗而非切换页面
  // Mobile back gesture/button: close this modal instead of navigating pages
  useEffect(() => {
    let poppedByBack = false
    window.history.pushState({ __orderModal: true }, '')
    const onPop = () => { poppedByBack = true; onCancelRef.current() }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // 若通过点 X / 确认关闭（非返回触发），回收压入的历史条目
      // If closed via X / confirm (not back), pop the history entry we pushed
      if (!poppedByBack && window.history.state?.__orderModal) window.history.back()
    }
  }, [])

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
      await onConfirm(vol, login || null, slNum, tpNum)
      setReceipt('ok')
      setTimeout(() => onCancel(), 2000)
    } catch (err) {
      setReceipt('error')
      setError(err instanceof Error ? err.message : 'error')
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

  const hasAccounts = onlineAccounts.length > 0
  const offlineMsg = accounts.length === 0 ? t('order.noBridge') : t('order.allOffline')
  const canSubmit = hasAccounts && !expired && !slInvalid && !tpInvalid

  const fmtMoney = (n?: number | null) =>
    n == null ? '-' : n.toLocaleString(undefined, { maximumFractionDigits: 2 })

  // 粗估保证金占用：手数 × 品种合约规模 / 杠杆，仅作量级提示
  // Rough margin estimate: lots × the symbol's contract size / leverage, indicative only
  const estMargin = (() => {
    const vol = parseFloat(volume)
    const lev = selected?.leverage
    if (!vol || vol <= 0 || !lev || lev <= 0) return null
    return (vol * contractSize(signal.symbol)) / lev
  })()

  return (
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
            {isBuy ? t('common.buy') : t('common.sell')} {signal.symbol}
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
          {onlineAccounts.length > 1 && (
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
          <div className="mb-3 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">{offlineMsg}</div>
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
              {receipt === 'ok' && <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>{t('order.filled', { price: '' })}</>}
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
    </div>
  )
}
