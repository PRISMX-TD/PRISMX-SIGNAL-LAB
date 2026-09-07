// 滑动确认下单弹窗的共用外壳：头部（品种 / 方向 / 现价 / 账户）、账户切换器、
// 手数（快捷 / 按风险%）、止损止盈、保证金估算、风险提示、回执卡、滑动轨道。
//
// SlideOrderModal（信号）与 ChartOrderModal（图表手动）以前各持一份几乎相同的
// 500 行 JSX，2026-09-06 合并成这一份。两者的差别只剩：头部多不多一行倒计时、
// 有没有"信号已过期"的拦截、止损止盈的占位符——都由 props 传进来。表单状态来自
// useOrderForm，提交 / 回执状态在这里。
//
// Shared shell for the slide-to-confirm order modals. SlideOrderModal (signal)
// and ChartOrderModal (manual) used to carry near-identical 500-line copies;
// merged 2026-09-06. What differs (countdown row, expiry block, SL/TP
// placeholders) comes in as props. Form state is useOrderForm's; submit and
// receipt state live here.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { displaySymbol, localizeApiError } from '../../api/utils'
import { useBackToClose } from '../../utils/useBackToClose'
import OrderConnectNotice from '../OrderConnectNotice'
import SlideToConfirm from './SlideToConfirm'
import { QUICK_LOTS, QUICK_RISK_PCTS, formatMoney } from './orderMath'
import type { OrderForm } from './useOrderForm'

export type OrderConfirm = (
  volume: number,
  mt5Login: string | null,
  stopLoss: number | null,
  takeProfit: number | null,
  clientOrderId: string,
) => Promise<void>

interface Props {
  form: OrderForm
  symbol: string
  /** 原始账户数（含离线），用于"从没连过桥接"与"全部离线"的区分 / raw count for the connect notice */
  totalAccounts: number
  /** 头部显示的现价文本，由调用方按自己的精度格式化 / formatted current price */
  priceText: string
  /** 头部附加行（信号倒计时）/ extra head row (signal countdown) */
  headExtra?: ReactNode
  /** 拦截提交：有值时显示横幅、滑动时报这条错 / blocks submit: banner + error text */
  blocked?: { banner: ReactNode; error: string } | null
  slPlaceholder?: string
  tpPlaceholder?: string
  onCancel: () => void
  onConfirm: OrderConfirm
}

const segBtn = (on: boolean) =>
  `px-2.5 py-1 rounded-md text-xs font-medium border ${on ? 'border-prism-500/60 bg-prism-600/20 text-prism-200' : 'border-white/10 bg-white/5 text-neutral-400'}`
const chipBtn = (on: boolean) =>
  `px-2 py-0.5 rounded-md border text-xs font-mono ${on ? 'border-prism-500/60 bg-prism-600/20 text-prism-200' : 'border-white/10 bg-white/5 text-neutral-300'}`

export default function OrderSheet({ form, symbol, totalAccounts, priceText, headExtra, blocked, slPlaceholder = 'SL', tpPlaceholder = 'TP', onCancel, onConfirm }: Props) {
  const { t } = useTranslation()
  const [submitting, setSubmitting] = useState(false)
  const [receipt, setReceipt] = useState<'waiting' | 'ok' | 'error' | null>(null)
  const [error, setError] = useState('')
  const [acctMenuOpen, setAcctMenuOpen] = useState(false)
  const onCancelRef = useRef(onCancel)
  onCancelRef.current = onCancel

  // 账户切换菜单套在这个（已全屏的）弹窗内部：划返回应该先收起菜单，再收起外层弹窗。
  // 弹窗本身的返回手势由渲染它的页面用 useBackToClose 处理——这里绝不能再挂一个裸的
  // popstate 监听（历史上那个监听收到任何 popstate 都关整个弹窗，把账户切换器弄得不可用）。
  // The nested account menu closes on the first back swipe, the modal on the
  // second. The modal's own back gesture is the rendering page's useBackToClose;
  // never add a raw popstate listener here (the old one closed the whole modal on
  // any popstate and broke the account switcher).
  useBackToClose(acctMenuOpen, () => setAcctMenuOpen(false))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onCancelRef.current() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [submitting])

  const { isBuy, selected, accounts } = form
  const canSubmit = form.hasAccounts && !blocked && !form.slTpInvalid

  const handleSubmit = async () => {
    if (blocked) { setError(blocked.error); return }
    if (form.slTpInvalid) { setError(t('order.slTpInvalid')); return }
    const vol = form.parsedVolume
    if (vol == null) { setError(t('order.volume')); return }
    setReceipt('waiting')
    setSubmitting(true)
    setError('')
    try {
      await onConfirm(vol, form.login || null, form.slNum, form.tpNum, form.orderId)
      form.rotateOrderId()
      setReceipt('ok')
      setTimeout(() => onCancelRef.current(), 2000)
    } catch (err) {
      setReceipt('error')
      setError(err instanceof Error ? localizeApiError(err.message) : 'error')
      setTimeout(() => { setReceipt(null); setSubmitting(false) }, 2000)
    }
  }

  const symLetter = (symbol[0] ?? '?').toUpperCase()
  const tone = isBuy ? 'var(--up)' : 'var(--down)'
  const avaBg = isBuy ? 'rgba(46,224,126,0.15)' : 'rgba(255,77,103,0.15)'

  // 用 Portal 挂到 body：页面内容外层 .page-enter 有 transform 动画，会成为 fixed 定位的
  // 包含块，导致弹窗相对内容区而非视口定位。/ Portal to body: the .page-enter wrapper's
  // transform would become the containing block for fixed and mislocate the modal.
  return createPortal(
    <div className="slide-overlay" onClick={onCancel}>
      <div className="slide-sheet" onClick={(e) => e.stopPropagation()}>
        <button className="slide-cancel-x" onClick={onCancel}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>

        <div className="slide-sheet-head">
          <div className="flex items-center justify-center gap-2">
            <div className="slide-sheet-ava" style={{ background: avaBg, color: tone }}>{symLetter}</div>
          </div>
          <h3 className="text-lg mt-2.5 text-white font-bold">
            {isBuy ? t('common.buy') : t('common.sell')} {displaySymbol(symbol)}
          </h3>
          <p className="text-xs text-neutral-300 mt-1">
            {t('order.currentPrice')} <span className="num" style={{ color: tone }}>{priceText}</span>
            {selected && <> · {t('order.account')} {selected.login}</>}
          </p>
          {headExtra}
        </div>

        <div className="slide-sheet-rows">
          {accounts.length > 1 && (
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
                      {accounts.map((a) => (
                        <button
                          type="button"
                          key={a.login}
                          className={`slide-acct-opt ${a.login === form.login ? 'active' : ''}`}
                          onClick={() => { form.chooseLogin(a.login); setAcctMenuOpen(false) }}
                        >
                          <span className="opt-login">
                            {/* 列表会保留本次弹窗里掉线的账号（见 useStickyOnlineAccounts），状态必须标出来。
                                The list keeps accounts that went offline mid-modal, so their state has to show. */}
                            <i className={`opt-dot ${a.online ? 'on' : ''}`} />
                            {a.login}{a.accountName ? ` · ${a.accountName}` : ''}
                          </span>
                          <span className="opt-equity num">{formatMoney(a.equity)} {a.accountCurrency ?? ''}</span>
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
                {formatMoney(selected.equity)} <i>/ {formatMoney(selected.balance)} {selected.accountCurrency ?? ''}</i>
              </span>
            </div>
          )}
          <div className="slide-row">
            <span className="k">{t('order.sizeMode')}</span>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => form.setSizeMode('quick')} className={segBtn(form.sizeMode === 'quick')}>{t('order.sizeModeLots')}</button>
              <button type="button" onClick={() => form.setSizeMode('risk')} className={segBtn(form.sizeMode === 'risk')}>{t('order.sizeModeRisk')}</button>
            </div>
          </div>
          <div className="slide-row">
            <span className="k">{t('order.volume')}</span>
            <span className="stepper">
              <button onClick={() => form.stepLot(-1)}>−</button>
              <input
                className="lot-val num lot-input"
                value={form.volume}
                inputMode="decimal"
                onChange={(e) => form.typeVolume(e.target.value)}
                onBlur={form.blurVolume}
              />
              <button onClick={() => form.stepLot(1)}>+</button>
            </span>
          </div>
          {form.sizeMode === 'quick' ? (
            <div className="slide-row">
              <span className="k" />
              <div className="flex gap-1.5">
                {QUICK_LOTS.map((q) => (
                  <button key={q} onClick={() => form.setVolume(q.toFixed(2))} className="px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-xs text-neutral-300 hover:border-prism-500/50 hover:text-prism-300 font-mono">
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
                  <button key={p} onClick={() => form.setRiskPct(String(p))} className={chipBtn(form.riskPct === String(p))}>{p}%</button>
                ))}
              </div>
            </div>
          )}
          {form.riskNeedsSl && (
            <div className="slide-row">
              <span className="k" />
              <span className="text-xs text-amber-400/90">{t('order.riskNeedsSl')}</span>
            </div>
          )}
          {form.riskUnsupported && (
            <div className="slide-row">
              <span className="k" />
              <span className="text-xs text-amber-400/90">{t('order.riskUnsupportedPair')}</span>
            </div>
          )}
          <div className="slide-row">
            <span className="k">{t('signals.colSl')} / {t('signals.colTp')}</span>
            <div className="flex items-center gap-2">
              <input className={`h-8 w-[90px] rounded-lg bg-white/5 border px-2 text-sm num text-down text-right ${form.slInvalid ? 'border-down' : 'border-down/40'}`} value={form.sl} onChange={(e) => form.setSl(e.target.value)} placeholder={slPlaceholder} />
              <i className="text-neutral-500">/</i>
              <input className={`h-8 w-[90px] rounded-lg bg-white/5 border px-2 text-sm num text-up text-right ${form.tpInvalid ? 'border-down' : 'border-up/40'}`} value={form.tp} onChange={(e) => form.setTp(e.target.value)} placeholder={tpPlaceholder} />
            </div>
          </div>
          {form.slTpInvalid && (
            <div className="slide-row">
              <span className="k" />
              <span className="text-xs text-down">{form.slInvalid ? t('order.slWrongSide') : t('order.tpWrongSide')}</span>
            </div>
          )}
          {form.estMargin != null && (
            <div className="slide-row">
              <span className="k">{t('order.estMargin')}</span>
              <span className="v num">≈ {form.estMargin.toLocaleString(undefined, { maximumFractionDigits: 0 })} {selected?.accountCurrency ?? ''}</span>
            </div>
          )}
          {/* 止损处的亏损金额（有止盈再带盈利与盈亏比），让用户能核对手数 / 风险% 算得对不对
              Loss at the SL (plus profit and R:R when a TP is set) so the user can sanity-check the sizing */}
          {form.riskPreview?.riskUsd != null && (
            <div className="slide-row">
              <span className="k">{t('charts.ticket.riskAmount')}</span>
              <span className="v num">
                <span className="text-down">−{formatMoney(form.riskPreview.riskUsd)}</span>
                {form.riskPreview.rewardUsd != null && <i> / <span className="text-up">+{formatMoney(form.riskPreview.rewardUsd)}</span></i>}
                {' '}{selected?.accountCurrency ?? ''}
                {form.riskPreview.rr != null && <i> · 1 : {form.riskPreview.rr.toFixed(2)}</i>}
              </span>
            </div>
          )}
        </div>

        <div className="slide-note">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" /></svg>
          <span>{t('order.riskNote')}</span>
        </div>
        <p className="px-1 -mt-2.5 mb-3 text-[11px] leading-relaxed text-neutral-500">{t('order.timeoutNote')}</p>

        {!form.hasAccounts && <OrderConnectNotice neverConnected={totalAccounts === 0} />}
        {form.hasAccounts && blocked?.banner}
        {error && (
          <div className="mb-3 rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">{error}</div>
        )}

        {receipt && (
          <div className="receipt-card">
            <div className={`receipt-line ${receipt === 'ok' ? 'ok' : 'wait'}`}>
              {receipt === 'waiting' && <><span className="spinner" />{t('order.submitting')}...</>}
              {/* 提交成功那一刻订单几乎总是还是 PENDING（真正成交要等桥接执行 + 回执），
                  所以这里如实写"已提交"，成交 / 拒绝由页面级 toast（监听 WS ORDER_UPDATE）稍后报告。
                  The order is still PENDING the instant submit resolves; the honest label is
                  "submitted", and the fill/reject arrives via the page-level toast. */}
              {receipt === 'ok' && <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>{t('order.submitted')}</>}
              {receipt === 'error' && <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round"><circle cx="12" cy="12" r="9" /><path d="M15 9l-6 6M9 9l6 6" /></svg>{error || t('order.rejected', { msg: '' })}</>}
            </div>
          </div>
        )}

        {!submitting && canSubmit && <SlideToConfirm disabled={submitting} onConfirm={handleSubmit} />}

        {receipt && (
          <button onClick={onCancel} className="btn btn-ghost slide-close-btn">{t('common.close')}</button>
        )}
      </div>
    </div>,
    document.body,
  )
}
