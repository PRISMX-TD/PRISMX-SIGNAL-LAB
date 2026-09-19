// 交易终端：报价条 / Trading terminal: quote strip.
//
// 图表上方常驻的一条：品种 + 大价格 + 买卖价 / 点差 / 日内高低 + 实时状态。
// 买卖价来自全站统一报价（EA 推送，见 store/live 的 useGlobalQuotes），日内
// 高低与涨跌幅由 ChartsPage 从已加载的 K 线窗口算出后传入（dayStats）。
// 大价格用外汇的「大手 + 点位」写法：1.16 小 · 23 大 · 8 上标（见 splitPrice）。
// 手机端压成两行：品种（可点，弹自选抽屉）+ 大价格一行，五个统计一行。
// The strip docked above the chart: symbol + big price + bid/ask/spread/day
// range + live state. Bid/ask come from the site-wide quote feed; day stats
// are computed by ChartsPage from the loaded candle window. The big price uses
// the FX big-figure/pip convention (see splitPrice). On mobile it folds to two
// rows and the symbol becomes a button that opens the watchlist sheet.
import { useTranslation } from 'react-i18next'
import { displaySymbol } from '../../api/utils'
import { symbolMeta } from '../../utils/symbolMeta'
import { useClock } from '../signals/hooks'
import { INTERVALS } from './chartConfig'

export interface DayStats {
  high: number
  low: number
  // 相对当前 K 线窗口首根开盘价的涨跌幅（小数，如 0.0052 = +0.52%）。
  // Change vs. the first open in the current candle window (fraction).
  changePct: number
}

interface Props {
  symbol: string
  interval: string
  bid: number | null
  ask: number | null
  digits: number
  dayStats: DayStats | null
  // 无实时报价时的兜底价（最新收盘价）/ fallback price when no live quote (latest close)
  fallbackPrice: number
  stale: boolean
  // 手机端点品种名打开自选抽屉 / mobile: tapping the symbol opens the watchlist sheet
  onSymbolClick?: () => void
}

function fmt(v: number | null | undefined, digits: number): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits)
}

// 大手 / 点位 / 末位：5 位价（1.16238）→ 1.16 · 23 · 8；3 位价（153.305）→ 153. · 30 · 5；
// 2 位价（4431.01）→ 4431. · 01，没有上标；更少位数不拆。
// Big figure / pips / last digit: 5-digit → 1.16 · 23 · 8; 3-digit → 153. · 30 · 5;
// 2-digit → 4431. · 01 with no superscript; fewer digits are not split.
export function splitPrice(price: number | null, digits: number): { base: string; pip: string; sup: string } | null {
  if (price == null || !Number.isFinite(price)) return null
  const s = price.toFixed(digits)
  if (digits >= 3) return { base: s.slice(0, -3), pip: s.slice(-3, -1), sup: s.slice(-1) }
  if (digits === 2) return { base: s.slice(0, -2), pip: s.slice(-2), sup: '' }
  return { base: s, pip: '', sup: '' }
}

// 右下角那个走秒的时钟单独成组件：时间一变只重渲染这一个 <span>，而不是整条报价
// 条（大价格 + 五个统计 + 中间价拆位都要重算）。用的是 signals/hooks 里那个全局
// 共享时钟——单定时器 + useSyncExternalStore + 无订阅自动停表，本文件原来自己又
// 写了一份 setInterval + useState，每秒把整条报价条重渲染一次。
// The ticking clock is its own component so a second's passing re-renders one
// <span> instead of the whole strip. It subscribes to the shared clock in
// signals/hooks (one interval, auto-stopped when unsubscribed); this file used to
// carry a duplicate setInterval that re-rendered the entire strip every second.
function Clock() {
  const now = useClock()
  return <>{new Date(now).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'Asia/Shanghai' })}</>
}

export default function SymbolHeader({ symbol, interval, bid, ask, digits, dayStats, fallbackPrice, stale, onSymbolClick }: Props) {
  const { t } = useTranslation()
  // 点差按最小价位单位（point）计：(ask - bid) × 10^digits，四舍五入。
  // Spread in points: (ask - bid) × 10^digits, rounded.
  const spread =
    bid != null && ask != null && ask >= bid
      ? Math.round((ask - bid) * Math.pow(10, digits))
      : null
  const changePct = dayStats?.changePct ?? null
  const up = changePct != null && changePct >= 0
  const changeStr = changePct == null ? '—' : `${up ? '+' : ''}${(changePct * 100).toFixed(2)}%`
  const bidStr = fmt(bid ?? (fallbackPrice || null), digits)
  const askStr = fmt(ask ?? (fallbackPrice || null), digits)
  // 大字用中间价：买卖价的公允折中。/ The headline is the mid price.
  const mid = bid != null && ask != null ? (bid + ask) / 2 : fallbackPrice || null
  const parts = splitPrice(mid, digits)
  const meta = symbolMeta(symbol)
  const ivLabel = INTERVALS.find((iv) => iv.code === interval)?.label ?? interval

  return (
    <div className="term-qs">
      <button type="button" className="term-qs-id" onClick={onSymbolClick} aria-label={String(t('charts.watchlist.title'))}>
        <span className="sym-ava" style={{ background: meta.color + '33', color: meta.ink }}>{meta.letter}</span>
        <div>
          <h2>
            {symbol || '—'}
            <svg className="lg:hidden" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
          </h2>
          <p>{symbol ? `${displaySymbol(symbol)} · ${ivLabel}` : ''}</p>
        </div>
      </button>

      <div className="term-qs-px">
        <div className="term-big num">
          {parts ? (
            <>
              {parts.base}
              {parts.pip && <span className="pip">{parts.pip}</span>}
              {parts.sup && <sup>{parts.sup}</sup>}
            </>
          ) : '—'}
        </div>
        <div className={`term-chg ${changePct == null ? '' : up ? 'up' : 'down'}`}>
          <span>{changeStr}</span>
          <small>{t('charts.symhead.change')}</small>
        </div>
      </div>

      <div className="term-qs-st no-sb">
        {/* 配色跟下单票的连体按钮走：卖（bid）红、买（ask）绿——同一个页面上报价条
            和下单票的颜色以前恰好相反（报价条 bid 绿 ask 红），仪表盘的报价表
            （QuotesTable）也是 bid 红 ask 绿，三处里只有这里是反的。
            （标签措辞本身的口径问题另议，见审计 T-52：那要产品先定「买价 = ask
            还是 bid」，这里只对齐颜色，不动取值与文案。）
            Colors follow the ticket's conjoined buttons — sell (bid) red, buy
            (ask) green. This strip was the only place with the inverse; the
            dashboard's quotes table already matched the ticket. The label wording
            is a separate, product-level question (audit T-52) and is untouched. */}
        <Stat k={String(t('charts.symhead.bid'))} v={bidStr} tone="down" />
        <Stat k={String(t('charts.symhead.ask'))} v={askStr} tone="up" />
        <Stat k={String(t('charts.symhead.spread'))} v={spread == null ? '—' : String(spread)} />
        <Stat k={String(t('charts.symhead.high'))} v={fmt(dayStats?.high, digits)} />
        <Stat k={String(t('charts.symhead.low'))} v={fmt(dayStats?.low, digits)} />
      </div>

      <div className={`term-qs-live ${stale ? 'stale' : ''}`}>
        <i />
        {stale ? t('charts.stale') : 'Live'} · UTC+8 <Clock />
      </div>
    </div>
  )
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: 'up' | 'down' }) {
  return (
    <div className="term-st">
      <div className="k">{k}</div>
      <div className={`v num ${tone ?? ''}`}>{v}</div>
    </div>
  )
}
