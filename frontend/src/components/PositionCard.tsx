// 持仓卡片：展示盈亏并支持平仓/部分平仓/改 SL·TP
// Position card: shows P&L and supports close / partial close / modify SL·TP
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { orderApi } from '../api/client'
import { clientOrderId } from '../api/utils'
import type { Position } from '../api/types'

interface Props {
  position: Position
  onActionDone?: (msg: string, kind: 'success' | 'error' | 'info') => void
}

type Mode = 'view' | 'close' | 'modify'

export default function PositionCard({ position: p, onActionDone }: Props) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<Mode>('view')
  const [busy, setBusy] = useState(false)
  const [closeVol, setCloseVol] = useState(String(p.volume))
  const [sl, setSl] = useState(p.stopLoss ? String(p.stopLoss) : '')
  const [tp, setTp] = useState(p.takeProfit ? String(p.takeProfit) : '')

  const isBuy = p.side === 'BUY'
  const profitUp = p.profit >= 0
  const canAct = !!p.ticket

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
    if (!full && (!vol || vol <= 0 || vol > p.volume)) {
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
      onActionDone?.(e instanceof Error ? e.message : 'error', 'error')
    } finally {
      setBusy(false)
    }
  }

  const doModify = async () => {
    if (!p.ticket) return
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
      onActionDone?.(e instanceof Error ? e.message : 'error', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900/50 p-4">
      {/* 头部：品种 + 方向 + 盈亏 / header: symbol + side + P&L */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-base font-semibold text-slate-100">{p.symbol}</span>
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
            onClick={() => doClose(true)}
            disabled={busy}
            className="flex-1 rounded-lg border border-down/40 bg-down/10 py-1.5 text-xs font-medium text-down transition hover:bg-down/20 disabled:opacity-50"
          >
            {t('positions.closeAll')}
          </button>
          <button
            onClick={() => setMode('close')}
            disabled={busy}
            className="flex-1 rounded-lg border border-ink-600 bg-ink-800/60 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-ink-700 disabled:opacity-50"
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
        <div className="mt-3 space-y-2 rounded-lg border border-ink-700 bg-ink-950/40 p-3">
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
        <div className="mt-3 space-y-2 rounded-lg border border-ink-700 bg-ink-950/40 p-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-down">{t('positions.sl')}</label>
              <input
                type="number"
                step="0.00001"
                className="input font-mono text-sm"
                placeholder="0 = 清除"
                value={sl}
                onChange={(e) => setSl(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-up">{t('positions.tp')}</label>
              <input
                type="number"
                step="0.00001"
                className="input font-mono text-sm"
                placeholder="0 = 清除"
                value={tp}
                onChange={(e) => setTp(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={() => setMode('view')} className="btn-ghost flex-1 py-1.5 text-xs">
              {t('common.cancel')}
            </button>
            <button
              onClick={doModify}
              disabled={busy}
              className="btn-primary flex-1 py-1.5 text-xs"
            >
              {t('positions.confirmModify')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
