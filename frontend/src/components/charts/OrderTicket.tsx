// 交易终端：停靠式下单面板（右栏）/ Trading terminal: docked order ticket.
//
// 取代原来"点击买卖→弹窗"的流程：手数、止损止盈、账户、风险预览都内嵌在图表
// 右侧常驻面板里，点"下单"即提交。下单/回执逻辑复用父级传入的 onPlace（内部
// 走 useOrderPlacement.placeManualOrder），本组件只管表单与就地回执提示。
// 校验规则（止损止盈方向、按风险%估手数、保证金估算）与 ChartOrderModal 一致。
// Replaces the old "click buy/sell → modal" flow: volume, SL/TP, account and a
// risk preview all live inline in the docked right-rail panel; clicking Place
// submits. Placement/receipt logic reuses the parent's onPlace (which calls
// useOrderPlacement.placeManualOrder); this component owns only the form and an
// inline receipt. Validation (SL/TP direction, risk-% sizing, margin estimate)
// matches ChartOrderModal.
import { useEffect, useMemo, useState } from 'react'
import type { MT5Account, Quote } from '../../api/types'
import {
  clientOrderId,
  contractSize,
  localizeApiError,
  suggestVolumeByRisk,
  usdMarginBasis,
} from '../../api/utils'

interface Props {
  symbol: string
  accounts: MT5Account[]
  // 按交易商账户区分的报价：login -> {symbol: Quote}（下单参考价用选中账户的）
  // Per-account quotes: login -> {symbol: Quote} (entry price uses the selected account's)
  quotesByAccount: Record<string, Record<string, Quote>>
  // 全站统一报价（EA 推送）：选中账户没有该品种报价时的兜底 bid/ask
  // Site-wide quote (EA-pushed): fallback bid/ask when the account has none
  globalQuote: Quote | undefined
  // 图表最新收盘价：连报价都没有时的最后兜底 / chart's latest close, last-resort fallback
  refPrice: number
  digits: number
  onPlace: (
    side: 'BUY' | 'SELL',
    volume: number,
    mt5Login: string | null,
    stopLoss: number | null,
    takeProfit: number | null,
    clientOrderId: string,
  ) => Promise<void>
  className?: string
}

const QUICK_LOTS = [0.01, 0.1, 0.5, 1.0]
const QUICK_RISK = [0.5, 1, 2, 3]

function suggestVolume(eq?: number | null): string {
  if (!eq || eq <= 0) return '0.10'
  const v = Math.max(0.01, Math.min(eq / 200, 1))
  return (Math.floor(v * 100) / 100).toFixed(2)
}

export default function OrderTicket({ symbol, accounts, quotesByAccount, globalQuote, refPrice, digits, onPlace, className = '' }: Props) {
  const onlineAccounts = useMemo(() => accounts.filter((a) => a.online), [accounts])
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY')
  const [login, setLogin] = useState<string>(() => onlineAccounts[0]?.login ?? '')
  const [volume, setVolume] = useState(() => suggestVolume(onlineAccounts[0]?.equity))
  const [sl, setSl] = useState('')
  const [tp, setTp] = useState('')
  const [sizeMode, setSizeMode] = useState<'quick' | 'risk'>('quick')
  const [riskPct, setRiskPct] = useState('1')
  const [submitting, setSubmitting] = useState(false)
  const [receipt, setReceipt] = useState<{ kind: 'ok' | 'error' | 'info'; msg: string } | null>(null)

  const selected = onlineAccounts.find((a) => a.login === login) ?? onlineAccounts[0] ?? null
  const isBuy = side === 'BUY'

  // 选中账户没在线时把 login 拉回第一个在线账户 / snap login to the first online account
  useEffect(() => {
    if ((!login || !onlineAccounts.some((a) => a.login === login)) && onlineAccounts[0]) {
      setLogin(onlineAccounts[0].login)
    }
  }, [onlineAccounts, login])

  // 报价：优先选中账户的交易商报价，否则全站统一报价 / prefer the account's broker quote, else the site-wide one
  const quote = (selected && quotesByAccount[selected.login]?.[symbol]) || globalQuote
  const bid = quote?.bid ?? (refPrice > 0 ? refPrice : null)
  const ask = quote?.ask ?? (refPrice > 0 ? refPrice : null)
  // 入场参考价：买用卖价、卖用买价 / entry reference: ask for buy, bid for sell
  const entryRef = isBuy ? ask : bid

  const slNum = sl.trim() === '' ? null : parseFloat(sl)
  const tpNum = tp.trim() === '' ? null : parseFloat(tp)
  const slTpCross =
    slNum != null && tpNum != null && !Number.isNaN(slNum) && !Number.isNaN(tpNum) &&
    (isBuy ? slNum >= tpNum : slNum <= tpNum)
  const slInvalid =
    slTpCross ||
    (slNum != null && !Number.isNaN(slNum) && entryRef != null && (isBuy ? slNum >= entryRef : slNum <= entryRef))
  const tpInvalid =
    slTpCross ||
    (tpNum != null && !Number.isNaN(tpNum) && entryRef != null && (isBuy ? tpNum <= entryRef : tpNum >= entryRef))

  // 按风险%估手数 / size volume from a risk percentage
  useEffect(() => {
    if (sizeMode !== 'risk') return
    if (slNum == null || Number.isNaN(slNum) || entryRef == null) return
    const distance = Math.abs(entryRef - slNum)
    const pct = parseFloat(riskPct) || 0
    const suggested = suggestVolumeByRisk(symbol, selected?.equity, pct, distance, entryRef)
    if (suggested != null) setVolume(suggested.toFixed(2))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sizeMode, riskPct, sl, selected?.equity, symbol, quote?.bid, quote?.ask, refPrice])

  // 换账户时按净值重估默认手数（仅手数模式，风险模式由上面的 effect 负责）
  // Re-suggest default volume on account change (lots mode only)
  useEffect(() => {
    if (sizeMode === 'quick') setVolume(suggestVolume(selected?.equity))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.login])

  const estMargin = useMemo(() => {
    const vol = parseFloat(volume)
    const lev = selected?.leverage
    if (!vol || vol <= 0 || !lev || lev <= 0) return null
    const basis = usdMarginBasis(symbol)
    if (basis == null) return null
    const size = contractSize(symbol)
    if (basis === 'base') return (vol * size) / lev
    if (!entryRef || entryRef <= 0) return null
    return (vol * size * entryRef) / lev
  }, [volume, selected?.leverage, symbol, entryRef])

  // 风险/盈利预览（美元近似）：用入场→止损/止盈的距离 × 每点价值估算。
  // Risk/reward preview (USD approx): distance to SL/TP × per-point value.
  const rrPreview = useMemo(() => {
    if (entryRef == null || slNum == null || Number.isNaN(slNum)) return null
    const basis = usdMarginBasis(symbol)
    if (basis == null) return null
    const size = contractSize(symbol)
    const vol = parseFloat(volume)
    if (!vol || vol <= 0) return null
    const toUsd = (priceDist: number) => {
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
  }, [entryRef, slNum, tpNum, symbol, volume])

  const stepLot = (dir: number) => {
    const v = parseFloat(volume) || 0.01
    setVolume(String(Math.max(0.01, Math.min(10, +(v + dir * 0.01).toFixed(2)))))
  }

  const hasAccounts = onlineAccounts.length > 0
  const canSubmit = hasAccounts && !slInvalid && !tpInvalid && !submitting
  const ccy = selected?.accountCurrency ?? ''

  const submit = async () => {
    const vol = parseFloat(volume)
    if (!vol || vol <= 0) {
      setReceipt({ kind: 'error', msg: '手数无效 / invalid volume' })
      return
    }
    setSubmitting(true)
    setReceipt({ kind: 'info', msg: '提交中…' })
    try {
      await onPlace(side, vol, login || null, slNum, tpNum, clientOrderId())
      setReceipt({ kind: 'ok', msg: '已提交，等待回执' })
      setTimeout(() => setReceipt(null), 2500)
    } catch (e) {
      setReceipt({ kind: 'error', msg: e instanceof Error ? localizeApiError(e.message) : '下单失败' })
    } finally {
      setSubmitting(false)
    }
  }

  const px = (v: number | null) => (v == null ? '—' : v.toFixed(digits))
  const money = (v: number | null | undefined) =>
    v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: 2 })

  return (
    <div className={`term-panel ${className}`}>
      <div className="term-pane-head">
        快速下单 <span className="term-pane-head-r">{symbol || '—'}</span>
      </div>
      <div className="term-ticket no-sb">
        {/* 买卖切换 / buy-sell toggle */}
        <div className="term-bs-row">
          <button type="button" className={`term-bs sell ${!isBuy ? 'on' : ''}`} onClick={() => setSide('SELL')}>
            <span className="lab">卖 SELL</span>
            <span className="px num">{px(bid)}</span>
          </button>
          <button type="button" className={`term-bs buy ${isBuy ? 'on' : ''}`} onClick={() => setSide('BUY')}>
            <span className="lab">买 BUY</span>
            <span className="px num">{px(ask)}</span>
          </button>
        </div>

        {/* 账户选择（多个在线账户时）/ account picker (when >1 online) */}
        {onlineAccounts.length > 1 && (
          <label className="term-field">
            <span className="term-field-k">账户 Account</span>
            <select className="term-select num" value={login} onChange={(e) => setLogin(e.target.value)}>
              {onlineAccounts.map((a) => (
                <option key={a.login} value={a.login}>
                  {a.login}{a.accountName ? ` · ${a.accountName}` : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        {/* 手数模式切换 / size mode */}
        <div className="term-seg2">
          <button type="button" className={sizeMode === 'quick' ? 'on' : ''} onClick={() => setSizeMode('quick')}>手数</button>
          <button type="button" className={sizeMode === 'risk' ? 'on' : ''} onClick={() => setSizeMode('risk')}>按风险%</button>
        </div>

        {/* 手数输入 / volume */}
        <label className="term-field">
          <span className="term-field-k">手数 Volume</span>
          <div className="term-stepper">
            <button type="button" onClick={() => stepLot(-1)}>−</button>
            <input
              className="num"
              value={volume}
              inputMode="decimal"
              onChange={(e) => setVolume(e.target.value.replace(/[^0-9.]/g, ''))}
              onBlur={() => {
                const v = parseFloat(volume)
                setVolume((!v || v <= 0 ? 0.01 : Math.min(10, v)).toFixed(2))
              }}
            />
            <button type="button" onClick={() => stepLot(1)}>＋</button>
          </div>
        </label>

        {sizeMode === 'quick' ? (
          <div className="term-chips">
            {QUICK_LOTS.map((q) => (
              <button key={q} type="button" className="term-chip num" onClick={() => setVolume(q.toFixed(2))}>
                {q.toFixed(2)}
              </button>
            ))}
          </div>
        ) : (
          <div className="term-chips">
            {QUICK_RISK.map((p) => (
              <button
                key={p}
                type="button"
                className={`term-chip num ${riskPct === String(p) ? 'on' : ''}`}
                onClick={() => setRiskPct(String(p))}
              >
                {p}%
              </button>
            ))}
          </div>
        )}
        {sizeMode === 'risk' && slNum == null && (
          <p className="term-ticket-warn">按风险%估手数需要先填止损 / risk sizing needs a stop-loss</p>
        )}

        {/* 止损止盈 / SL & TP */}
        <div className="term-field-row">
          <label className="term-field">
            <span className="term-field-k down">止损 SL</span>
            <div className={`term-inp ${slInvalid ? 'bad' : ''}`}>
              <input className="num" value={sl} inputMode="decimal" placeholder="—" onChange={(e) => setSl(e.target.value.replace(/[^0-9.]/g, ''))} />
            </div>
          </label>
          <label className="term-field">
            <span className="term-field-k up">止盈 TP</span>
            <div className={`term-inp ${tpInvalid ? 'bad' : ''}`}>
              <input className="num" value={tp} inputMode="decimal" placeholder="—" onChange={(e) => setTp(e.target.value.replace(/[^0-9.]/g, ''))} />
            </div>
          </label>
        </div>
        {(slInvalid || tpInvalid) && (
          <p className="term-ticket-warn">止损止盈方向填反了 / SL and TP are on the wrong side</p>
        )}

        {/* 风险预览 / risk preview */}
        <div className="term-risk">
          <span className="k">风险金额</span>
          <span className="v down">{rrPreview?.riskUsd != null ? `−${money(rrPreview.riskUsd)} ${ccy}` : '—'}</span>
          <span className="k">潜在盈利</span>
          <span className="v up">{rrPreview?.rewardUsd != null ? `+${money(rrPreview.rewardUsd)} ${ccy}` : '—'}</span>
          <span className="k">盈亏比</span>
          <span className="v">{rrPreview?.rr != null ? `1 : ${rrPreview.rr.toFixed(2)}` : '—'}</span>
          <span className="k">所需保证金</span>
          <span className="v">{estMargin != null ? `≈ ${money(estMargin)} ${ccy}` : '—'}</span>
        </div>

        {!hasAccounts && (
          <p className="term-ticket-warn">
            {accounts.length === 0 ? '未连接 MT5，先连接 PRISMX Bridge' : '账户离线，先连接桥接程序'}
          </p>
        )}

        <button
          type="button"
          className={`term-place ${isBuy ? 'buy' : 'sell'}`}
          disabled={!canSubmit}
          onClick={submit}
        >
          {submitting ? '提交中…' : `${isBuy ? '买入 BUY' : '卖出 SELL'} · ${parseFloat(volume) || 0} 手`}
        </button>

        {receipt && (
          <p className={`term-ticket-receipt ${receipt.kind}`}>{receipt.msg}</p>
        )}
      </div>
    </div>
  )
}
