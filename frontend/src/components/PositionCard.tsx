// 持仓卡片：展示盈亏并支持平仓/部分平仓/改 SL·TP
// Position card: shows P&L and supports close / partial close / modify SL·TP
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { orderApi } from '../api/client'
import { clientOrderId, displaySymbol, localizeApiError } from '../api/utils'
import type { Position } from '../api/types'
import ConfirmModal from './ConfirmModal'
import { useBackToClose } from '../utils/useBackToClose'

interface Props {
  position: Position
  onActionDone?: (msg: string, kind: 'success' | 'error' | 'info') => void
}

type Mode = 'view' | 'close' | 'modify'

export default function PositionCard({ position: p, onActionDone }: Props) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<Mode>('view')
  const [busy, setBusy] = useState(false)
  const [confirmCloseAll, setConfirmCloseAll] = useState(false)
  // 全屏确认弹窗，手机上划返回应该先关掉它、而不是直接退出当前页面
  // （见 useBackToClose 的说明）。/ A full-screen confirm modal; on mobile,
  // swiping back should close it first rather than exiting the current page
  // outright (see useBackToClose's comment).
  useBackToClose(confirmCloseAll, () => setConfirmCloseAll(false))
  const [closeVol, setCloseVol] = useState(String(p.volume))
  const [sl, setSl] = useState(p.stopLoss ? String(p.stopLoss) : '')
  const [tp, setTp] = useState(p.takeProfit ? String(p.takeProfit) : '')

  const isBuy = p.side === 'BUY'
  const profitUp = p.profit >= 0
  const canAct = !!p.ticket

  // 改止损止盈的方向校验：买单止损须低于现价、止盈须高于现价，卖单相反。
  // 和开仓弹窗（SlideOrderModal）同样的规则——此前改单表单完全不校验，方向
  // 填反了也照发，最后被 MT5 拒绝，弹一句看不懂的错误。现价缺失时不校验。
  // Direction check for SL/TP edits: a BUY's SL must be below and TP above the
  // current price (reversed for a SELL) — same rule as the order modal. The
  // modify form used to validate nothing, so a wrong-side value went through
  // and got rejected by MT5 with a cryptic message. Skip when no current price.
  const modSl = sl.trim() === '' ? null : parseFloat(sl)
  const modTp = tp.trim() === '' ? null : parseFloat(tp)
  const modRef = p.currentPrice
  const slInvalid =
    modSl != null && !Number.isNaN(modSl) && modRef != null && modRef > 0 &&
    (isBuy ? modSl >= modRef : modSl <= modRef)
  const tpInvalid =
    modTp != null && !Number.isNaN(modTp) && modRef != null && modRef > 0 &&
    (isBuy ? modTp <= modRef : modTp >= modRef)

  // 浮盈百分比（相对入场价的价格变动）/ floating P&L percent vs entry
  const pnlPct =
    p.entryPrice && p.currentPrice && p.entryPrice > 0
      ? ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100 * (isBuy ? 1 : -1)
      : null

  const fmt = (n?: number | null) =>
    n == null ? '—' : n.toLocaleString(undefined, { maximumFractionDigits: 5 })

  const doClose = async (full: boolean) => {
    if (!p.ticket) return
    const vol = full ? undefined : parseFloat(closeVol)
    // 部分平仓：手数须在 [0.01, 持仓量] 之间。低于 0.01 手 MT5 无法成交，
    // 之前只挡了 ≤0，会把拆不开的小额平仓发出去再被拒。
    // Partial close volume must be within [0.01, position size]. Below 0.01
    // lots MT5 can't fill; the old check only blocked ≤0, letting an
    // un-fillable tiny close get sent only to be rejected.
    if (!full && (vol == null || Number.isNaN(vol) || vol < 0.01 || vol > p.volume)) {
      onActionDone?.(t('positions.invalidVolume'), 'error')
      return
    }
    setBusy(true)
    try {
      await orderApi.close({
        clientOrderId: clientOrderId(),
        ticket: p.ticket,
        symbol: p.symbol,
        side: p.side,
        mt5Login: p.login ?? null,
        volume: full ? undefined : vol,
      })
      onActionDone?.(t('positions.closeSent'), 'info')
      setMode('view')
    } catch (e) {
      onActionDone?.(e instanceof Error ? localizeApiError(e.message) : 'error', 'error')
    } finally {
      setBusy(false)
    }
  }

  const doModify = async () => {
    if (!p.ticket) return
    if (slInvalid || tpInvalid) {
      onActionDone?.(t(slInvalid ? 'order.slWrongSide' : 'order.tpWrongSide'), 'error')
      return
    }
    setBusy(true)
    try {
      await orderApi.modify({
        clientOrderId: clientOrderId(),
        ticket: p.ticket,
        symbol: p.symbol,
        side: p.side,
        mt5Login: p.login ?? null,
        stopLoss: parseFloat(sl) || 0,
        takeProfit: parseFloat(tp) || 0,
      })
      onActionDone?.(t('positions.modifySent'), 'info')
      setMode('view')
    } catch (e) {
      onActionDone?.(e instanceof Error ? localizeApiError(e.message) : 'error', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="glass-neon p-4">
      {/* 头部：品种 + 方向 + 盈亏 / header: symbol + side + P&L */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-base font-semibold text-slate-100">{displaySymbol(p.symbol)}</span>
            <span className={`tag ${isBuy ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
              {isBuy ? t('common.buy') : t('common.sell')}
            </span>
          </div>
          <div className="mt-1 font-mono text-xs text-slate-500">
            {p.volume} {t('positions.lots')}
            {p.ticket ? ` · #${p.ticket}` : ''}
          </div>
        </div>
        <div className="text-right">
          <div className={`font-mono text-lg font-bold ${profitUp ? 'text-up' : 'text-down'}`}>
            {profitUp ? '+' : ''}
            {p.profit.toFixed(2)}
          </div>
          {pnlPct != null && (
            <div className={`font-mono text-xs ${profitUp ? 'text-up' : 'text-down'}`}>
              {pnlPct >= 0 ? '+' : ''}
              {pnlPct.toFixed(2)}%
            </div>
          )}
        </div>
      </div>

      {/* 价格明细 / price details */}
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <div className="flex justify-between">
          <span className="text-slate-500">{t('positions.entry')}</span>
          <span className="font-mono text-slate-300">{fmt(p.entryPrice)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">{t('positions.current')}</span>
          <span className="font-mono text-slate-300">{fmt(p.currentPrice)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">{t('positions.sl')}</span>
          <span className="font-mono text-down">{p.stopLoss ? fmt(p.stopLoss) : '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-slate-500">{t('positions.tp')}</span>
          <span className="font-mono text-up">{p.takeProfit ? fmt(p.takeProfit) : '—'}</span>
        </div>
      </div>

      {/* PLACEHOLDER_ACTIONS */}
      {canAct && mode === 'view' && (
        <div className="mt-3 flex gap-2">
          <button
            onClick={() => setConfirmCloseAll(true)}
            disabled={busy}
            className="flex-1 rounded-lg border border-down/40 bg-down/10 py-1.5 text-xs font-medium text-down transition hover:bg-down/20 disabled:opacity-50"
          >
            {t('positions.closeAll')}
          </button>
          <button
            onClick={() => setMode('close')}
            disabled={busy}
            className="flex-1 rounded-lg border border-white/10 bg-white/[0.04] py-1.5 text-xs font-medium text-slate-300 transition hover:bg-white/[0.08] disabled:opacity-50"
          >
            {t('positions.partialClose')}
          </button>
          <button
            onClick={() => setMode('modify')}
            disabled={busy}
            className="flex-1 rounded-lg border border-prism-600/40 bg-prism-600/10 py-1.5 text-xs font-medium text-prism-300 transition hover:bg-prism-600/20 disabled:opacity-50"
          >
            {t('positions.editSlTp')}
          </button>
        </div>
      )}

      {canAct && mode === 'close' && (
        <div className="mt-3 space-y-2 rounded-lg border border-white/10 bg-ink-950/40 p-3">
          <label className="text-xs text-slate-400">
            {t('positions.closeVolume')} (max {p.volume})
          </label>
          <input
            type="number"
            step="0.01"
            min="0.01"
            max={p.volume}
            className="input font-mono text-sm"
            value={closeVol}
            onChange={(e) => setCloseVol(e.target.value)}
          />
          <div className="flex gap-2">
            <button onClick={() => setMode('view')} className="btn-ghost flex-1 py-1.5 text-xs">
              {t('common.cancel')}
            </button>
            <button
              onClick={() => doClose(false)}
              disabled={busy}
              className="btn-primary flex-1 py-1.5 text-xs"
            >
              {t('positions.confirmClose')}
            </button>
          </div>
        </div>
      )}

      {canAct && mode === 'modify' && (
        <div className="mt-3 space-y-2 rounded-lg border border-white/10 bg-ink-950/40 p-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-down">{t('positions.sl')}</label>
              <input
                type="number"
                step="0.00001"
                className={`input font-mono text-sm ${slInvalid ? 'border-down' : ''}`}
                placeholder={t('positions.clearHint')}
                value={sl}
                onChange={(e) => setSl(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-up">{t('positions.tp')}</label>
              <input
                type="number"
                step="0.00001"
                className={`input font-mono text-sm ${tpInvalid ? 'border-down' : ''}`}
                placeholder={t('positions.clearHint')}
                value={tp}
                onChange={(e) => setTp(e.target.value)}
              />
            </div>
          </div>
          {(slInvalid || tpInvalid) && (
            <p className="text-xs text-down">
              {slInvalid ? t('order.slWrongSide') : t('order.tpWrongSide')}
            </p>
          )}
          <div className="flex gap-2">
            <button onClick={() => setMode('view')} className="btn-ghost flex-1 py-1.5 text-xs">
              {t('common.cancel')}
            </button>
            <button
              onClick={doModify}
              disabled={busy || slInvalid || tpInvalid}
              className="btn-primary flex-1 py-1.5 text-xs disabled:opacity-50"
            >
              {t('positions.confirmModify')}
            </button>
          </div>
        </div>
      )}

      {confirmCloseAll && (
        <ConfirmModal
          title={t('positions.closeAllConfirmTitle')}
          message={t('positions.closeAllConfirm', { symbol: displaySymbol(p.symbol), volume: p.volume })}
          confirmLabel={t('positions.closeAll')}
          danger
          busy={busy}
          onConfirm={() => { setConfirmCloseAll(false); doClose(true) }}
          onCancel={() => setConfirmCloseAll(false)}
        />
      )}
    </div>
  )
}
