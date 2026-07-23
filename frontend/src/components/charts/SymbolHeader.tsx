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
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
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
  // 中间价：手机端大字号主价格用它——买卖价分开列两行在窄屏上不如 Web3 手机
  // 交易 App 那种"一个大数字"直观，且中间价本来就是买卖价的公允折中。
  // Mid price: the mobile big-number headline — separately listing bid/ask
  // reads worse on a narrow screen than the single big number Web3 mobile
  // trading apps lead with, and the mid is the fair midpoint of the two anyway.
  const mid = bid != null && ask != null ? (bid + ask) / 2 : fallbackPrice || null
  const midStr = fmt(mid, digits)

  return (
    <>
      {/* 桌面行情条：品种 + 六格统计横排。可见性放在这层普通 wrapper 上而不是
          直接给 .term-symhead 加 hidden——理由同 ChartsPage 里其它折叠面板的
          注释（自带 display 的自定义类会盖掉 Tailwind 的 .hidden）。
          Desktop quote bar: symbol + six stats in a row. Visibility lives on
          this plain wrapper for the same reason documented elsewhere in
          ChartsPage (a custom class with its own display would override
          Tailwind's .hidden). */}
      <div className="hidden lg:block">
        <div className="term-symhead">
          <div className="term-symhead-id">
            <div className="term-symhead-sym">{symbol || '—'}</div>
            <div className="term-symhead-name">{symbol ? displaySymbol(symbol) : ''}</div>
          </div>
          <div className="term-symhead-stats no-sb">
            <Stat k={String(t('charts.symhead.bid'))} v={bidStr} tone="up" />
            <Stat k={String(t('charts.symhead.ask'))} v={askStr} tone="down" />
            <Stat k={String(t('charts.symhead.spread'))} v={spread == null ? '—' : String(spread)} />
            <Stat k={String(t('charts.symhead.high'))} v={fmt(dayStats?.high, digits)} />
            <Stat k={String(t('charts.symhead.low'))} v={fmt(dayStats?.low, digits)} />
            <Stat k={String(t('charts.symhead.change'))} v={changeStr} tone={changePct == null ? undefined : up ? 'up' : 'down'} />
          </div>
        </div>
      </div>

      {/* 手机端行情卡（紧凑版）：品种名 + 大字号价格 + 涨跌徽章挤在同一行，
          买卖价/点差/日内高低压成下方一条横排内联小字。只占两行高度。
          Mobile quote card (compact): symbol + big price + change badge share
          one row; bid/ask/spread/day range collapse into a single inline row of
          small text below. Two rows tall total. */}
      <div className="lg:hidden">
        <div className="term-symhead-m">
          <div className="term-symhead-m-top">
            <div className="term-symhead-m-id">
              <span className="sym">{symbol || '—'}</span>
              <span className="nm">{symbol ? displaySymbol(symbol) : ''}</span>
            </div>
            <div className={`term-symhead-m-price num ${changePct == null ? '' : up ? 'up' : 'down'}`}>
              {midStr}
            </div>
            <span className={`term-symhead-m-chg ${changePct == null ? '' : up ? 'up' : 'down'}`}>
              {changeStr}
            </span>
          </div>
          {/* 次要统计与策略入口同一行：统计小字靠左（可横滑），自定义策略缩成
              右侧一个小 chip——不再占一整行的大按钮。
              Secondary stats and the strategy entry share one row: stats on the
              left (scrollable), custom-strategy shrinks to a small chip on the
              right — no longer a full-width button taking its own row.
              自定义策略为 PRO 功能，2026-07 起对全体开放；未订阅者进页面会看到
              升级提示，这里不用重复判断。/ Custom-strategy is PRO, opened to all
              in 2026-07; non-PRO users get an upgrade hint on the page itself. */}
          <div className="term-symhead-m-btm">
            <div className="term-symhead-m-stats no-sb">
              <span>{t('charts.symhead.mBid')} <b className="num up">{bidStr}</b></span>
              <span>{t('charts.symhead.mAsk')} <b className="num down">{askStr}</b></span>
              <span>{t('charts.symhead.mSpread')} <b className="num">{spread == null ? '—' : spread}</b></span>
              <span>{t('charts.symhead.mHigh')} <b className="num">{fmt(dayStats?.high, digits)}</b></span>
              <span>{t('charts.symhead.mLow')} <b className="num">{fmt(dayStats?.low, digits)}</b></span>
            </div>
            <Link to="/strategies" className="term-symhead-m-strat" aria-label={t('nav.strategies')}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" /></svg>
              <span>{t('nav.strategies')}</span>
            </Link>
          </div>
        </div>
      </div>
    </>
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
