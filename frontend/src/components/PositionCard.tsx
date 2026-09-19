// 持仓卡片：展示盈亏并支持平仓/部分平仓/改 SL·TP
// Position card: shows P&L and supports close / partial close / modify SL·TP
//
// 两种形态，同一套数据与动作：
//   · 桌面卡（默认）：品种 + 盈亏抬头、四格价格、三个动作按钮常驻。
//   · 手机卡（mobile，手机版订单页）：同样是卡，但按手机重排——抬头（头像 / 品种 / 方向 /
//     手数·单号，右侧盈亏大字）下面不是四格表，而是一条「价格轨」：上方入场 → 现价，
//     轨道两端是止损 / 止盈，轨上一个点标出现价在止损与止盈之间的位置、入场到现价之间
//     按盈亏着色。止损止盈缺一个就退回四格。三个动作按钮照旧。动作面板两形态共用。
//     试过一行一仓（点开才见动作），产品负责人要卡片，2026-09-11 换回卡。
// Two shapes over one set of data and actions. Desktop card (default): symbol +
// P&L header, four price cells, three actions. Phone card (mobile): still a card,
// re-laid for phones — the header, then a "price rail" instead of the 2×2 grid:
// entry → current above, SL / TP at the two ends, a dot marking where price sits
// between them with the entry→current span tinted by P&L. Falls back to the grid
// when SL or TP is missing. A row-per-position shape was tried and the product
// owner asked for cards (2026-09-11).
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { orderApi } from '../api/client'
import { clientOrderId, displaySymbol, fmtLots, isLotOnStep, localizeApiError,
         limitLotInput, lotStep, minLot, roundLots, snapLot } from '../api/utils'
import type { Position } from '../api/types'
import ConfirmModal from './ConfirmModal'
import { useBackToClose } from '../utils/useBackToClose'
import { symbolMeta } from '../utils/symbolMeta'

interface Props {
  position: Position
  onActionDone?: (msg: string, kind: 'success' | 'error' | 'info') => void
  // 手机版卡 / the phone card shape
  mobile?: boolean
}

type Mode = 'view' | 'close' | 'modify'

export default function PositionCard({ position: p, onActionDone, mobile = false }: Props) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<Mode>('view')
  const [busy, setBusy] = useState(false)
  // 平仓指令已被接受、正在等持仓推送把这张卡拿掉：卡压暗、动作全部禁用。
  // 卡随持仓消失而卸载，所以正常路径下不需要复位；只留一个超时兜底，防止回执
  // 丢失时卡永远压着。
  // A close has been accepted and the card is waiting for the positions feed to
  // remove it: dimmed, actions disabled. The card unmounts with the position, so
  // only a timeout release is needed for the lost-receipt case.
  const [closing, setClosing] = useState(false)
  const closingTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => { if (closingTimer.current) window.clearTimeout(closingTimer.current) }, [])
  const enterClosing = () => {
    setClosing(true)
    if (closingTimer.current) window.clearTimeout(closingTimer.current)
    closingTimer.current = window.setTimeout(() => { setClosing(false); setBusy(false) }, 12000)
  }
  const [confirmCloseAll, setConfirmCloseAll] = useState(false)
  // 全屏确认弹窗，手机上划返回应该先关掉它、而不是直接退出当前页面
  // （见 useBackToClose 的说明）。/ A full-screen confirm modal; on mobile,
  // swiping back should close it first rather than exiting the current page
  // outright (see useBackToClose's comment).
  useBackToClose(confirmCloseAll, () => setConfirmCloseAll(false))
  const [closeVol, setCloseVol] = useState(String(roundLots(p.volume)))
  // 手数步长按品种取（原油 0.1，其余 0.01）：步长决定输入框的 step/min，
  // 也决定失焦时往下吸附到哪一档。/ Per-symbol lot step drives the input.
  const step = lotStep(p.symbol)
  const minVol = minLot(p.symbol)
  const [sl, setSl] = useState(p.stopLoss ? String(p.stopLoss) : '')
  const [tp, setTp] = useState(p.takeProfit ? String(p.takeProfit) : '')

  const isBuy = p.side === 'BUY'
  const profitUp = p.profit >= 0
  const canAct = !!p.ticket
  const meta = symbolMeta(p.symbol)

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
    // 还要卡手数步长：非整数倍的手数会被券商收下却永不成交，并锁死这张仓位。
    // Also gate on the lot step: an off-step volume is accepted but never fills,
    // and then locks the position (see isLotOnStep).
    if (!full && (vol == null || Number.isNaN(vol) || vol < minVol || vol > p.volume
                  || !isLotOnStep(vol, p.symbol))) {
      onActionDone?.(t('positions.invalidVolume'), 'error')
      return
    }
    setBusy(true)
    // 点下去就进入"平仓中"，不等接口——第一反应要即时。被拒或出错再退回来。
    // Enter "closing" on the click itself, not on the response; revert on rejection.
    enterClosing()
    setMode('view')
    try {
      const res = await orderApi.close({
        clientOrderId: clientOrderId(),
        ticket: p.ticket,
        symbol: p.symbol,
        side: p.side,
        mt5Login: p.login ?? null,
        volume: full ? undefined : vol,
      })
      // 网关账号当场成交：给成交价；桥接账号只是收单：说"已发出"。卡保持压暗，
      // 直到持仓推送把它拿掉（全平）或手数更新（部分平仓时下一拍就放开）。
      // Gateway fills synchronously (show the price); bridge merely accepts. The
      // card stays dimmed until the positions feed removes or updates it.
      if (res.status === 'FILLED') {
        onActionDone?.(t('positions.closed', { price: res.filledPrice != null ? res.filledPrice : '—' }), 'success')
        if (!full) { setClosing(false); setBusy(false) }
      } else if (res.status === 'REJECTED' || res.status === 'FAILED') {
        setClosing(false)
        setBusy(false)
        onActionDone?.(res.message ? localizeApiError(res.message) : t('positions.closeFailed'), 'error')
      } else {
        onActionDone?.(t('positions.closeSent'), 'info')
        if (!full) { setClosing(false); setBusy(false) }
      }
    } catch (e) {
      setClosing(false)
      setBusy(false)
      onActionDone?.(e instanceof Error ? localizeApiError(e.message) : 'error', 'error')
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
      const res = await orderApi.modify({
        clientOrderId: clientOrderId(),
        ticket: p.ticket,
        symbol: p.symbol,
        side: p.side,
        mt5Login: p.login ?? null,
        stopLoss: parseFloat(sl) || 0,
        takeProfit: parseFloat(tp) || 0,
      })
      if (res.status === 'FILLED') onActionDone?.(t('positions.modified'), 'success')
      else if (res.status === 'REJECTED' || res.status === 'FAILED') onActionDone?.(res.message ? localizeApiError(res.message) : 'error', 'error')
      else onActionDone?.(t('positions.modifySent'), 'info')
      setMode('view')
    } catch (e) {
      onActionDone?.(e instanceof Error ? localizeApiError(e.message) : 'error', 'error')
    } finally {
      setBusy(false)
    }
  }

  // 进入某个表单时用**当前**持仓值重置一次。卡的 key 是 ticket，持仓推送更新时组件
  // 不会重建，所以 useState 的初值停在挂载那一刻：部分平仓之后仓位手数变小了，
  // closeVol 还是旧的全量值；桥接报回新的止损止盈后，改单表单里还是旧数字，
  // 用户"只改止盈"就会把刚变的止损又覆盖回去。
  // Reset from the *current* position when entering a form. The card is keyed by
  // ticket and never remounts on a feed update, so the useState initial values
  // stay frozen at mount: after a partial close, closeVol still holds the old full
  // size, and a bridge-reported SL/TP change leaves stale numbers in the modify
  // form — so "just editing the TP" would write the old SL back.
  const openForm = (next: Exclude<Mode, 'view'>) => {
    if (next === 'close') setCloseVol(String(roundLots(p.volume)))
    else {
      setSl(p.stopLoss ? String(p.stopLoss) : '')
      setTp(p.takeProfit ? String(p.takeProfit) : '')
    }
    setMode(next)
  }

  // ── 两形态共用的动作区 / action area shared by both shapes ──
  const actions = canAct && mode === 'view' && (
    <div className="mt-3 flex gap-2">
      <button
        onClick={() => setConfirmCloseAll(true)}
        disabled={busy}
        className="flex-1 rounded-lg border border-down/40 bg-down/10 py-1.5 text-xs font-medium text-down transition hover:bg-down/20 disabled:opacity-50"
      >
        {t('positions.closeAll')}
      </button>
      <button
        onClick={() => openForm('close')}
        disabled={busy}
        className="flex-1 rounded-lg border border-white/10 bg-white/[0.04] py-1.5 text-xs font-medium text-neutral-300 transition hover:bg-white/[0.08] disabled:opacity-50"
      >
        {t('positions.partialClose')}
      </button>
      <button
        onClick={() => openForm('modify')}
        disabled={busy}
        className="flex-1 rounded-lg border border-prism-600/40 bg-prism-600/10 py-1.5 text-xs font-medium text-prism-300 transition hover:bg-prism-600/20 disabled:opacity-50"
      >
        {t('positions.editSlTp')}
      </button>
    </div>
  )

  const closeForm = canAct && mode === 'close' && (
    <div className="mt-3 space-y-2 rounded-lg border border-white/10 bg-ink-950/40 p-3">
      <label className="text-xs text-neutral-400">
        {t('positions.closeVolume')} (max {fmtLots(p.volume)})
      </label>
      <input
        type="number"
        step={step}
        min={minVol}
        max={roundLots(p.volume)}
        className="input font-mono text-sm"
        value={closeVol}
        // 失焦就把手数吸附到该品种的步长上。只校验不吸附的话，用户得自己猜哪个
        // 数合法；不是整数倍的手数发出去不会被当场拒绝，而是锁死这张仓位。
        // Snap to the symbol's step on blur: an off-step volume is accepted by the
        // broker and then locks the position, so don't leave the user guessing.
        onBlur={() => {
          const v = parseFloat(closeVol)
          if (Number.isFinite(v) && v > 0) {
            setCloseVol(String(Math.min(roundLots(p.volume), snapLot(v, p.symbol))))
          }
        }}
        // 实时截掉超出该品种步长的小数位，多余的位数根本打不进去。
        onChange={(e) => setCloseVol(limitLotInput(e.target.value, p.symbol))}
      />
      <p className="text-[11px] text-neutral-500">
        {t('positions.lotStepHint', { step, min: minVol })}
      </p>
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
  )

  const modifyForm = canAct && mode === 'modify' && (
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
  )

  const confirm = confirmCloseAll && (
    <ConfirmModal
      title={t('positions.closeAllConfirmTitle')}
      message={t('positions.closeAllConfirm', { symbol: displaySymbol(p.symbol), volume: p.volume })}
      confirmLabel={t('positions.closeAll')}
      danger
      busy={busy}
      onConfirm={() => { setConfirmCloseAll(false); doClose(true) }}
      onCancel={() => setConfirmCloseAll(false)}
    />
  )

  const sideTag = (
    <span className={`tag ${isBuy ? 'bg-up/15 text-up' : 'bg-down/15 text-down'}`}>
      {isBuy ? t('common.buy') : t('common.sell')}
    </span>
  )
  const ava = (
    <span className="sym-ava" style={{ background: meta.color + '33', color: meta.ink }}>
      {meta.letter}
    </span>
  )

  // ── 手机卡 / phone card ──
  if (mobile) {
    // 价格轨：止损与止盈是两端，现价与入场落在其间。做空时止盈在下、止损在上，轨道
    // 按价格从低到高排，两端的标签跟着几何走，不按"左止损右止盈"硬排。
    // The rail spans min..max of SL/TP; for a short the TP is the lower end, so
    // the end labels follow the geometry rather than a fixed left-SL/right-TP.
    const rail = (() => {
      const { stopLoss: sl, takeProfit: tp, entryPrice: en, currentPrice: cu } = p
      if (!sl || !tp || !en || !cu || sl === tp) return null
      const lo = Math.min(sl, tp)
      const hi = Math.max(sl, tp)
      const pct = (x: number) => Math.min(1, Math.max(0, (x - lo) / (hi - lo)))
      const ent = pct(en)
      const cur = pct(cu)
      return {
        ent,
        cur,
        fillLeft: Math.min(ent, cur),
        fillWidth: Math.abs(cur - ent),
        left: sl < tp ? { k: t('positions.sl'), v: sl, cls: 'text-down' } : { k: t('positions.tp'), v: tp, cls: 'text-up' },
        right: sl < tp ? { k: t('positions.tp'), v: tp, cls: 'text-up' } : { k: t('positions.sl'), v: sl, cls: 'text-down' },
      }
    })()
    return (
      <article className={`pos-mc ${profitUp ? 'up' : 'down'} ${closing ? 'closing' : ''}`}>
        <header className="pos-mc-hd">
          {ava}
          <div className="pos-mc-id">
            <div className="pos-mc-sym">
              <b>{displaySymbol(p.symbol)}</b>
              {sideTag}
            </div>
            <div className="pos-mc-sub">
              {fmtLots(p.volume)}<small>{t('positions.lots')}</small>
              {p.ticket ? <> · #{p.ticket}</> : null}
            </div>
          </div>
          <div className={`pos-mc-pnl ${profitUp ? 'text-up' : 'text-down'}`}>
            <b>{profitUp ? '+' : ''}{p.profit.toFixed(2)}</b>
            {pnlPct != null && <small>{pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%</small>}
          </div>
        </header>

        {rail ? (
          <div className="pos-mc-rail" style={{ '--ent': rail.ent, '--cur': rail.cur, '--fl': rail.fillLeft, '--fw': rail.fillWidth } as CSSProperties}>
            <div className="pos-mc-path">
              <span><span className="ord-k">{t('positions.entry')}</span><b>{fmt(p.entryPrice)}</b></span>
              <span className="pos-mc-arr" aria-hidden="true">→</span>
              <span><span className="ord-k">{t('positions.current')}</span><b>{fmt(p.currentPrice)}</b></span>
            </div>
            <div className="pos-mc-track" aria-hidden="true">
              <i className="pos-mc-fill" />
              <i className="pos-mc-ent" />
              <i className="pos-mc-dot" />
            </div>
            <div className="pos-mc-ends">
              <span className={rail.left.cls}><span className="ord-k">{rail.left.k}</span><b>{fmt(rail.left.v)}</b></span>
              <span className={rail.right.cls}><span className="ord-k">{rail.right.k}</span><b>{fmt(rail.right.v)}</b></span>
            </div>
          </div>
        ) : (
          <div className="pos-mc-grid">
            <span><span className="ord-k">{t('positions.entry')}</span><b>{fmt(p.entryPrice)}</b></span>
            <span><span className="ord-k">{t('positions.current')}</span><b>{fmt(p.currentPrice)}</b></span>
            <span><span className="ord-k">{t('positions.sl')}</span><b className="text-down">{p.stopLoss ? fmt(p.stopLoss) : '—'}</b></span>
            <span><span className="ord-k">{t('positions.tp')}</span><b className="text-up">{p.takeProfit ? fmt(p.takeProfit) : '—'}</b></span>
          </div>
        )}

        {actions}
        {closeForm}
        {modifyForm}
        {confirm}
      </article>
    )
  }

  // ── 卡片形态（桌面）/ card shape (desktop) ──
  return (
    <div className={`glass-neon pos-card p-4 ${closing ? 'closing' : ''}`}>
      {/* 头部：品种 + 方向 + 盈亏 / header: symbol + side + P&L */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            {ava}
            <span className="font-mono text-base font-semibold text-neutral-100">{displaySymbol(p.symbol)}</span>
            {sideTag}
          </div>
          <div className="mt-1 font-mono text-xs text-neutral-500">
            {fmtLots(p.volume)} {t('positions.lots')}
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
          <span className="text-neutral-500">{t('positions.entry')}</span>
          <span className="font-mono text-neutral-300">{fmt(p.entryPrice)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-neutral-500">{t('positions.current')}</span>
          <span className="font-mono text-neutral-300">{fmt(p.currentPrice)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-neutral-500">{t('positions.sl')}</span>
          <span className="font-mono text-down">{p.stopLoss ? fmt(p.stopLoss) : '—'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-neutral-500">{t('positions.tp')}</span>
          <span className="font-mono text-up">{p.takeProfit ? fmt(p.takeProfit) : '—'}</span>
        </div>
      </div>

      {actions}
      {closeForm}
      {modifyForm}
      {confirm}
    </div>
  )
}
