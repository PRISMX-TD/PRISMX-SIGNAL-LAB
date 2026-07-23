// 交易终端：品种行情头 / Trading terminal: symbol quote header.
//
// 图表上方常驻的一条：品种名 + 买价/卖价/点差/日内高低/涨跌。买卖价来自
// 全站统一报价（EA 推送，见 store/live 的 useGlobalQuotes），日内高低与涨跌
// 幅由 ChartsPage 从已加载的 K 线窗口算出后传入（dayStats）——都用已有数据，
// 不需要新后端。
// The strip docked above the chart: symbol + bid/ask/spread/day range/change.
// Bid/ask come from the site-wide quote feed (EA-pushed, useGlobalQuotes);
// day high/low and change% are computed by ChartsPage from the loaded candle
// window and passed in (dayStats). All from existing data — no new backend.
import { displaySymbol } from '../../api/utils'

export interface DayStats {
  high: number
  low: number
  // 相对当前 K 线窗口首根开盘价的涨跌幅（小数，如 0.0052 = +0.52%）。
  // Change vs. the first open in the current candle window (fraction).
  changePct: number
}

interface Props {
  symbol: string
  bid: number | null
  ask: number | null
  digits: number
  dayStats: DayStats | null
  // 无实时报价时的兜底价（最新收盘价）/ fallback price when no live quote (latest close)
  fallbackPrice: number
}

function fmt(v: number | null | undefined, digits: number): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits)
}

export default function SymbolHeader({ symbol, bid, ask, digits, dayStats, fallbackPrice }: Props) {
  // 点差按最小价位单位（point）计：(ask - bid) × 10^digits，四舍五入。
  // Spread in points: (ask - bid) × 10^digits, rounded.
  const spread =
    bid != null && ask != null && ask >= bid
      ? Math.round((ask - bid) * Math.pow(10, digits))
      : null
  const changePct = dayStats?.changePct ?? null
  const up = changePct != null && changePct >= 0
  const changeStr =
    changePct == null ? '—' : `${up ? '+' : ''}${(changePct * 100).toFixed(2)}%`
  const bidStr = fmt(bid ?? (fallbackPrice || null), digits)
  const askStr = fmt(ask ?? (fallbackPrice || null), digits)

  return (
    <div className="term-symhead">
      <div className="term-symhead-id">
        <div className="term-symhead-sym">{symbol || '—'}</div>
        <div className="term-symhead-name">{symbol ? displaySymbol(symbol) : ''}</div>
      </div>
      <div className="term-symhead-stats no-sb">
        <Stat k="买价 Bid" v={bidStr} tone="up" />
        <Stat k="卖价 Ask" v={askStr} tone="down" />
        <Stat k="点差" v={spread == null ? '—' : String(spread)} />
        <Stat k="日内高" v={fmt(dayStats?.high, digits)} />
        <Stat k="日内低" v={fmt(dayStats?.low, digits)} />
        <Stat k="涨跌" v={changeStr} tone={changePct == null ? undefined : up ? 'up' : 'down'} />
      </div>
    </div>
  )
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: 'up' | 'down' }) {
  const cls = tone === 'up' ? 'up' : tone === 'down' ? 'down' : ''
  return (
    <div className="term-sstat">
      <span className="term-sstat-k">{k}</span>
      <span className={`term-sstat-v num ${cls}`}>{v}</span>
    </div>
  )
}
