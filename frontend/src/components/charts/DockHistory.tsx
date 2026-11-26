// 图表底部停靠区的「历史」页签：已平仓的仓位，一个仓位一行（分批平仓合成一行，口径与交易页
// 「历史」相同，见 ClosedTradesList.groupPositions）。只在切到这个页签时挂载，所以不看就不轮询。
// 数据走 useClosedTrades：最新一页随新平仓重拉，滚到底点「加载更早的记录」再往前取。
// The dock's History tab: closed positions, one row each (partial closes merged, same rules
// as the Orders page history). Mounted only while the tab is open, so it polls only when seen.
import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useLive } from '../../store/live'
import { useClosedTrades } from '../../utils/useClosedTrades'
import { groupPositions } from '../ClosedTradesList'
import { displaySymbol, fmtLots, fmtStamp, parseTime } from '../../api/utils'
import { EMPTY } from '../../utils/format'
import SymbolLogo from './pro/SymbolLogo'

interface Props {
  /** 账号范围，与持仓列表同一口径；null = 不限账号 / account scope, same as the positions list */
  login: string | null
  digitsFor: (symbol: string) => number
}

// 停靠区一行放不下完整时间戳，只到分钟（跨年才带年份）/ compact stamp: minutes, year only when it differs
const stamp = (iso: string | null) => {
  const d = parseTime(iso)
  return d ? fmtStamp(d, { clock: 'hm' }) : EMPTY
}

function DockHistory({ login, digitsFor }: Props) {
  const { t } = useTranslation()
  const { closedTradeTick, wsConnected } = useLive()
  const { trades, hasMore, loadingMore, loadMore } = useClosedTrades(login, { enabled: true, tick: closedTradeTick, wsConnected })
  const rows = useMemo(() => (trades ? groupPositions(trades) : null), [trades])

  if (!rows) {
    return (
      <div aria-busy="true" aria-live="polite">
        {[0, 1].map((i) => (
          <div key={i} className="flex items-center justify-between px-4" style={{ minHeight: 48, borderBottom: '1px solid var(--line)' }} aria-hidden="true">
            <span className="skeleton" style={{ display: 'block', width: 120, height: 14 }} />
            <span className="skeleton" style={{ display: 'block', width: 64, height: 14, marginLeft: 'auto' }} />
          </div>
        ))}
      </div>
    )
  }
  if (rows.length === 0) {
    return (
      <div className="term-dk-empty">
        <b>{t('charts.dock.noHistory')}</b>
        <span>{t('charts.dock.noHistoryHint')}</span>
      </div>
    )
  }
  const cell = (area: string, k: string, v: string, tone?: string) => (
    <div className={area}>
      <div className="k">{k}</div>
      <div className={`v ${tone ?? ''}`}>{v}</div>
    </div>
  )
  return (
    <>
      {rows.map((r) => {
        const d = digitsFor(r.symbol)
        const isBuy = r.side === 'BUY'
        const up = r.net >= 0
        return (
          <div key={r.key} className="term-pr hist">
            <div className="term-pr-id">
              <SymbolLogo symbol={r.symbol} size={20} className="sym-ava" />
              <b>{displaySymbol(r.symbol)}</b>
              <span className={`term-tag ${isBuy ? 'buy' : 'sell'}`}>{isBuy ? t('charts.dock.buy') : t('charts.dock.sell')} {fmtLots(r.volume)}</span>
            </div>
            {cell('c-e', String(t('orders.closed.openPrice')), r.openPrice != null ? r.openPrice.toFixed(d) : EMPTY)}
            {cell('c-c', String(t('orders.closed.closePrice')), r.closePrice != null ? r.closePrice.toFixed(d) : EMPTY)}
            {cell('c-sl', String(t('orders.closed.openTime')), stamp(r.openTime))}
            {cell('c-tp', String(t('orders.closed.closeTime')), stamp(r.closeTime))}
            <div className={`term-pnl pnl ${up ? 'up' : 'down'}`}>{up ? '+' : ''}{r.net.toFixed(2)}</div>
          </div>
        )
      })}
      {hasMore && (
        <button type="button" className="term-dk-more" disabled={loadingMore} onClick={() => loadMore(true)}>
          {loadingMore ? t('charts.dock.loadingMore') : t('charts.dock.loadMore')}
        </button>
      )}
    </>
  )
}

export default memo(DockHistory)
