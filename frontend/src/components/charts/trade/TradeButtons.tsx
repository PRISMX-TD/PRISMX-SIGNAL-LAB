// 图例下方的买卖按钮：左卖右买，各自显示实时买价 / 卖价，中间是手数。一键下单开着时点一下
// 直接按市价成交；关着时弹一个小确认（手机滑动确认）。点差显示在手数框上方。
// Buy / sell buttons under the legend: sell on the left, buy on the right, each with the live
// bid / ask, the volume in between. With one-click on, a click fills at market at once;
// otherwise a small confirm appears (slide-to-confirm on phones). The spread sits above the lots.
import { memo, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useGlobalQuote } from '../../../store/live'
import { baseSymbol, limitLotInput } from '../../../api/utils'
import { defaultVolume, normalizeVolume, stepVolume } from '../../order/orderMath'
import SlideToConfirm from '../../order/SlideToConfirm'
import { useMarketClosedText, useMarketStatus } from '../../order/useMarketStatus'
import { useLastVolume } from '../../../utils/useLastVolume'
import { pointSize, type Side } from './tradeMath'
import type { ChartPlace } from './useTradeActions'

interface Props {
  symbol: string
  digits: number
  /** 下单账户（在线的那个）；null = 没有在线账户 / the (online) account; null when none */
  login: string | null
  oneClick: boolean
  touch: boolean
  onPlace: ChartPlace
  quotesDown?: boolean
}

function PriceText({ v, digits }: { v: number | null; digits: number }) {
  if (v == null) return <span>—</span>
  const s = v.toFixed(digits)
  if (digits < 2) return <span>{s}</span>
  return <span>{s.slice(0, -2)}<b>{s.slice(-2)}</b></span>
}

function TradeButtons({ symbol, digits, login, oneClick, touch, onPlace, quotesDown = false }: Props) {
  const { t } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const q = useGlobalQuote(symbol)
  const bid = q?.bid ?? null
  const ask = q?.ask ?? null
  const { lastVolume, rememberVolume } = useLastVolume()
  const [vol, setVol] = useState(() => defaultVolume(lastVolume, symbol))
  const [ask_, setAsk] = useState<Side | null>(null)
  const [busy, setBusy] = useState<Side | null>(null)
  const market = useMarketStatus(symbol)
  const closedText = useMarketClosedText(market)
  const touched = useRef(false)
  // 换品种时按新品种的步长重算手数（原油步长 0.1）；用户手动改过的值在同一品种内保留。
  // Re-derive the volume for a new symbol (crude steps by 0.1); a typed value stays within a symbol.
  useEffect(() => { touched.current = false; setVol(defaultVolume(lastVolume, symbol)); setAsk(null) }, [symbol]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!touched.current) setVol(defaultVolume(lastVolume, symbol)) }, [lastVolume]) // eslint-disable-line react-hooks/exhaustive-deps

  const disabledWhy = !login ? tt('charts.trade.noAccount') : market.closed ? closedText : quotesDown ? tt('charts.trade.quotesDown') : null
  const spread = bid != null && ask != null ? Math.round((ask - bid) / pointSize(digits)) : null

  const fire = async (side: Side) => {
    const volume = parseFloat(normalizeVolume(vol, symbol))
    if (!(volume > 0) || disabledWhy) return
    setAsk(null)
    setBusy(side)
    try {
      const res = await onPlace({ side, volume, login, sl: null, tp: null, type: 'MARKET', price: null })
      // 接口报错时 onPlace 返回 undefined，不记手数 / undefined = the API refused; don't remember
      if (res && res.status !== 'REJECTED' && res.status !== 'FAILED') rememberVolume(volume)
    } finally {
      setBusy(null)
    }
  }
  const press = (side: Side) => {
    if (disabledWhy) return
    if (oneClick) void fire(side)
    else setAsk(ask_ === side ? null : side)
  }

  return (
    <div className={`chart-tbtns ${oneClick ? 'oneclick' : ''}`} onPointerDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
      <div className="chart-tbtns-row" title={disabledWhy ?? undefined}>
        <button type="button" className="chart-tbtn sell" disabled={!!disabledWhy || busy != null} aria-label={`${tt('charts.dock.sell')} ${bid?.toFixed(digits) ?? ''}`} onClick={() => press('SELL')}>
          <small>{tt('charts.dock.sell')}</small>
          <PriceText v={bid} digits={digits} />
        </button>
        <div className="chart-tbtn-mid">
          {spread != null && <small className="chart-tbtn-spread">{spread}</small>}
          <input
            className="chart-tbtn-vol"
            inputMode="decimal"
            aria-label={tt('charts.ticket.volume')}
            value={vol}
            onChange={(e) => { touched.current = true; setVol(limitLotInput(e.target.value, symbol)) }}
            onBlur={() => setVol(normalizeVolume(vol, symbol))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowUp') { e.preventDefault(); touched.current = true; setVol(stepVolume(vol, 1, symbol)) }
              if (e.key === 'ArrowDown') { e.preventDefault(); touched.current = true; setVol(stepVolume(vol, -1, symbol)) }
            }}
          />
        </div>
        <button type="button" className="chart-tbtn buy" disabled={!!disabledWhy || busy != null} aria-label={`${tt('charts.dock.buy')} ${ask?.toFixed(digits) ?? ''}`} onClick={() => press('BUY')}>
          <small>{tt('charts.dock.buy')}</small>
          <PriceText v={ask} digits={digits} />
        </button>
      </div>
      {oneClick && <small className="chart-tbtns-flag">{tt('charts.trade.oneClickOn')}</small>}
      {ask_ && !oneClick && (
        <div className={`chart-tbtns-confirm ${ask_ === 'BUY' ? 'buy' : 'sell'}`} role="dialog" aria-label={tt('charts.trade.confirmMarket', { side: tt(ask_ === 'BUY' ? 'charts.dock.buy' : 'charts.dock.sell'), lots: vol, symbol: baseSymbol(symbol) })}>
          <span>{tt('charts.trade.confirmMarket', { side: tt(ask_ === 'BUY' ? 'charts.dock.buy' : 'charts.dock.sell'), lots: vol, symbol: baseSymbol(symbol) })}</span>
          {touch
            ? <SlideToConfirm disabled={busy != null} onConfirm={() => void fire(ask_)} label={tt('charts.trade.slideConfirm')} />
            : (
              <div className="chart-tbtns-acts">
                <button type="button" onClick={() => setAsk(null)}>{tt('charts.posmark.cancel')}</button>
                <button type="button" className="go" autoFocus disabled={busy != null} onClick={() => void fire(ask_)}>{tt('charts.posmark.confirm')}</button>
              </div>
            )}
        </div>
      )}
    </div>
  )
}

export default memo(TradeButtons)
