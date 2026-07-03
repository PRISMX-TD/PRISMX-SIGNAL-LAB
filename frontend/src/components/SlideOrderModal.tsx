// 滑动确认下单弹窗 / Slide-to-confirm order modal
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { MT5Account, Quote, Signal } from '../api/types'

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
  const [slidePct, setSlidePct] = useState(0)

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

  const trackRef = useRef<HTMLDivElement>(null)
  const sliding = useRef(false)
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  useEffect(() => {
    if (!login && onlineAccounts[0]) setLogin(onlineAccounts[0].login)
  }, [onlineAccounts, login])

  useEffect(() => {
    setVolume(suggestVolume(selected?.equity))
  }, [selected?.login])

  // Escape key（用 ref 避免依赖漂移 / use ref to avoid dependency drift）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onCancelRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting])

  const getPct = (clientX: number) => {
    const el = trackRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    const pct = ((clientX - rect.left) / rect.width) * 100
    return Math.max(0, Math.min(100, pct))
  }

  const onStart = (clientX: number) => {
    if (submitting) return
    sliding.current = true
    setSlidePct(getPct(clientX))
  }
  const onMove = (clientX: number) => {
    if (!sliding.current || submitting) return
    const pct = getPct(clientX)
    setSlidePct(pct)
    if (pct >= 95) {
      sliding.current = false
      setSlidePct(100)
      handleSubmit()
    }
  }
  const onEnd = () => {
    if (!sliding.current || submitting) return
    sliding.current = false
    if (slidePct >= 95) {
      setSlidePct(100)
      handleSubmit()
    } else {
      setSlidePct(0)
    }
  }

  const handleSubmit = async () => {
    setReceipt('waiting')
    setSubmitting(true)
    setError('')
    const vol = parseFloat(volume)
    if (!vol || vol <= 0) {
      setError(t('order.volume'))
      setSlidePct(0)
      setSubmitting(false)
      setReceipt(null)
      return
    }
    const slNum = sl.trim() === '' ? null : parseFloat(sl)
    const tpNum = tp.trim() === '' ? null : parseFloat(tp)
    try {
      await onConfirm(vol, login || null, slNum, tpNum)
      setReceipt('ok')
      setTimeout(() => onCancel(), 2000)
    } catch (err) {
      setReceipt('error')
      setError(err instanceof Error ? err.message : 'error')
      setTimeout(() => {
        setReceipt(null)
        setSlidePct(0)
        setSubmitting(false)
      }, 2000)
    }
  }

  const stepLot = (dir: number) => {
    const v = parseFloat(volume) || 0.01
    const next = Math.max(0.01, Math.min(10, +(v + dir * 0.01).toFixed(2)))
    setVolume(String(next))
  }

  const isBuy = signal.side === 'BUY'
  const symLetter = (signal.symbol[0] ?? '?').toUpperCase()
  const avaBg = isBuy ? 'rgba(46,224,126,0.15)' : 'rgba(255,77,103,0.15)'
  const avaColor = isBuy ? 'var(--up)' : 'var(--down)'
  const priceColor = isBuy ? 'var(--up)' : 'var(--down)'

  const hasAccounts = onlineAccounts.length > 0
  const offlineMsg = accounts.length === 0 ? t('order.noBridge') : t('order.allOffline')

  const fmtMoney = (n?: number | null) =>
    n == null ? '-' : n.toLocaleString(undefined, { maximumFractionDigits: 2 })

  // 粗估保证金占用：手数 × 合约规模(假定 100k) / 杠杆，仅作量级提示
  // Rough margin estimate: lots × contract size (assume 100k) / leverage, indicative only
  const estMargin = (() => {
    const vol = parseFloat(volume)
    const lev = selected?.leverage
    if (!vol || vol <= 0 || !lev || lev <= 0) return null
    return (vol * 100000) / lev
  })()

  return (
    <div className="slide-overlay" onClick={onCancel}>
      <div className="slide-sheet" onClick={(e) => e.stopPropagation()}>
        <button className="slide-cancel-x" onClick={onCancel}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>

        <div className="slide-sheet-head">
          <div className="slide-sheet-ava" style={{ background: avaBg, color: avaColor }}>{symLetter}</div>
          <h3 className="text-lg mt-2.5 text-white font-bold">
            {isBuy ? t('common.buy') : t('common.sell')} {signal.symbol}
          </h3>
          <p className="text-xs text-slate-300 mt-1">
            现价 <span className="num" style={{ color: priceColor }}>
              {quote ? (isBuy ? (quote.ask?.toFixed(quote.digits ?? 5) ?? signal.entry) : (quote.bid?.toFixed(quote.digits ?? 5) ?? signal.entry)) : signal.entry ?? '-'}
            </span>
            {selected && <> · 账户 {selected.login}</>}
          </p>
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
          <div className="slide-row">
            <span className="k">{t('signals.colSl')} / {t('signals.colTp')}</span>
            <div className="flex items-center gap-2">
              <input className="h-8 w-[90px] rounded-lg bg-white/5 border border-down/40 px-2 text-sm num text-down text-right" value={sl} onChange={(e) => setSl(e.target.value)} placeholder={signal.stopLoss != null ? String(signal.stopLoss) : 'SL'} />
              <i className="text-slate-500">/</i>
              <input className="h-8 w-[90px] rounded-lg bg-white/5 border border-up/40 px-2 text-sm num text-up text-right" value={tp} onChange={(e) => setTp(e.target.value)} placeholder={signal.takeProfit != null ? String(signal.takeProfit) : 'TP'} />
            </div>
          </div>
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
        {!submitting && hasAccounts && (
          <div
            ref={trackRef}
            className={`slide-track ${slidePct >= 95 ? 'done' : ''}`}
            style={{ touchAction: 'none' }}
          >
            <div className="slide-track-fill" style={{ width: `${slidePct}%` }} />
            <div className="slide-track-label">{t('order.slideToConfirm', '滑动确认下单')}</div>
            <div
              className="slide-knob"
              style={{ left: `calc(5px + ${slidePct / 100} * (100% - 56px))`, touchAction: 'none' }}
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
