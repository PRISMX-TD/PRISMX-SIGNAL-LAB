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
            <Stat k="买价 Bid" v={bidStr} tone="up" />
            <Stat k="卖价 Ask" v={askStr} tone="down" />
            <Stat k="点差" v={spread == null ? '—' : String(spread)} />
            <Stat k="日内高" v={fmt(dayStats?.high, digits)} />
            <Stat k="日内低" v={fmt(dayStats?.low, digits)} />
            <Stat k="涨跌" v={changeStr} tone={changePct == null ? undefined : up ? 'up' : 'down'} />
          </div>
        </div>
      </div>

      {/* 手机端行情卡：参考 Web3 手机交易 App（Hyperliquid/dYdX 等）的"品种名 +
          一个大字号价格 + 涨跌徽章"呈现。价格独占一行左对齐；买卖价/点差/日内
          高低改成价格下方一排等宽的"标签在上、数值在下"小列——比挤在价格右侧
          的两行小字更整齐好读。
          Mobile quote card: symbol + one big price + a change badge, the way
          Web3 mobile trading apps (Hyperliquid, dYdX, …) lead. The price gets
          its own left-aligned row; bid/ask/spread/day range become a row of
          evenly-spaced label-over-value mini columns below the price — tidier
          and more legible than two cramped lines crowded to the price's right. */}
      <div className="lg:hidden">
        <div className="term-symhead-m">
          <div className="term-symhead-m-top">
            <div className="term-symhead-m-id">
              <span className="sym">{symbol || '—'}</span>
              <span className="nm">{symbol ? displaySymbol(symbol) : ''}</span>
            </div>
            <span className={`term-symhead-m-chg ${changePct == null ? '' : up ? 'up' : 'down'}`}>
              {changeStr}
            </span>
          </div>
          <div className={`term-symhead-m-price num ${changePct == null ? '' : up ? 'up' : 'down'}`}>
            {midStr}
          </div>
          <div className="term-symhead-m-stats">
            <MStat k="买价 Bid" v={bidStr} tone="up" />
            <MStat k="卖价 Ask" v={askStr} tone="down" />
            <MStat k="点差" v={spread == null ? '—' : String(spread)} />
            <MStat k="日内高" v={fmt(dayStats?.high, digits)} />
            <MStat k="日内低" v={fmt(dayStats?.low, digits)} />
          </div>
          {/* 自定义策略入口（PRO 专属功能，2026-07 起对全体用户开放）：放在价格
              卡片正下方，点开直接跳转策略页；未订阅 PRO 的用户进页面会看到
              清楚的升级提示，这里不用重复判断。/ Custom-strategy entry point
              (PRO-exclusive, opened to everyone in 2026-07): sits right under
              the price card, tapping goes straight to the strategies page — a
              non-PRO user sees a clear upgrade hint once there, no need to
              duplicate that check here. */}
          <Link to="/strategies" className="term-symhead-m-strat">
            <span>{t('nav.strategies')}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
          </Link>
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

// 手机端行情头的单个统计小列：标签在上、数值在下，一排等宽平铺。
// Mobile quote-header stat: label over value, laid out in an even row.
function MStat({ k, v, tone }: { k: string; v: string; tone?: 'up' | 'down' }) {
  const cls = tone === 'up' ? 'up' : tone === 'down' ? 'down' : ''
  return (
    <div className="term-mstat">
      <span className="term-mstat-k">{k}</span>
      <span className={`term-mstat-v num ${cls}`}>{v}</span>
    </div>
  )
}
