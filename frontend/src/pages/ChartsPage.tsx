// 实时行情图表页：自建 Lightweight Charts + 自建中央 MT5 喂价源。
// Live charts page: self-hosted Lightweight Charts + a self-hosted central MT5 feed.
//
// 历史 K 线由后端 /api/chart/history 返回（一次性快照，切品种/周期时拉取），
// 实时更新由 /api/chart/latest 轮询获得。两者都来自我们自己的域名，因此在
// 任何网络环境（含中国大陆）都可访问——不再依赖 TradingView 的脚本与行情
// 数据通道。详见项目根目录 CHART_SELFHOST_PLAN.md。
//
// History candles come from the backend's /api/chart/history (a one-shot
// snapshot fetched on symbol/interval change); live updates are polled from
// /api/chart/latest. Both are served from our own domain, so the page works
// in any network environment (including mainland China) — it no longer
// depends on TradingView's script or data channel. See CHART_SELFHOST_PLAN.md
// at the repo root.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { createChart, ColorType, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts'
import { chartApi } from '../api/client'
import type { Candle } from '../api/types'
import { usePrefs } from '../store/prefs'
import { useLive, useQuotes } from '../store/live'
import { useOrderPlacement, toastToneClass } from '../components/signals/hooks'
import DrawLayer from '../components/charts/DrawLayer'
import ChartOrderModal from '../components/ChartOrderModal'

// 固定品种预设：贵金属 / 能源 / 热门货币对。
// 须与 feeder/chart_feeder.py 的 BASE_SYMBOLS 保持一致（该文件仍会拉取更多品种，
// 多拉的不会在这里展示，无需为了收窄这个列表而重新打包喂价器）。
// Fixed symbol presets: metals / energy / popular FX pairs. Must stay a
// subset of feeder/chart_feeder.py's BASE_SYMBOLS (the feeder can keep
// fetching more than this list shows; no need to rebuild it just to narrow
// this selector).
const PRESET_SYMBOLS = ['XAUUSD', 'XAGUSD', 'USOIL', 'EURUSD', 'GBPUSD', 'USDJPY']

// 图表价格轴的小数位数：贵金属/原油 2~3 位，外汇对按经纪商常见的 5 位报价
// （日元对 3 位）。未在表中的品种回退到 2 位。
// Decimal precision for the price scale: metals/oil use 2~3 digits, FX pairs
// use the broker-standard 5-digit quoting (JPY pairs use 3). Unlisted
// symbols fall back to 2 digits.
const SYMBOL_DECIMALS: Record<string, number> = {
  XAUUSD: 2,
  XAGUSD: 3,
  USOIL: 2,
  EURUSD: 5,
  GBPUSD: 5,
  USDJPY: 3,
}
const INTERVALS: { code: string; label: string }[] = [
  { code: '1', label: '1m' },
  { code: '5', label: '5m' },
  { code: '15', label: '15m' },
  { code: '60', label: '1H' },
  { code: '240', label: '4H' },
  { code: 'D', label: '1D' },
]

// 向后兼容的 localStorage key / backward-compat localStorage keys
const INTERVAL_KEY = 'prismx.charts.interval'
const SYMBOL_KEY = 'prismx.charts.symbol'

// 最新价轮询间隔（毫秒）/ latest-price poll interval (ms)
const POLL_MS = 2000
// 超过这么久没收到喂价更新，视为数据延迟 / no feed update for this long => stale
const STALE_MS = 30_000

// 涨跌配色（与 SignalView 的 FOCUS_DOT 一致）/ up/down colors (match SignalView's FOCUS_DOT)
const UP_COLOR = '#2ee07e'
const DOWN_COLOR = '#ff4d67'

function toLwPoint(b: Candle) {
  return { time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c }
}

export default function ChartsPage() {
  const { t } = useTranslation()
  const { getPref, setPref, loaded } = usePrefs()
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  // 已应用到图表的最新一根 K 线时间戳（epoch 秒）。lightweight-charts 的
  // series.update() 只接受 >= 最后一根的时间，喂价时间更早的 bar 会抛错并
  // 中断本次更新，导致最新价看似“不跳动、刷新才动”。用它过滤掉更早的 bar。
  // Timestamp (epoch s) of the newest bar already applied to the chart.
  // series.update() only accepts a time >= the last bar's; an earlier bar
  // throws and aborts the update, making the price look "stuck until refresh".
  // Use this to skip any bar older than what we've already applied.
  const lastTimeRef = useRef<number>(0)
  // 当前品种/周期的全部 K 线时间（升序），供画图层把非本周期锚点的时间插值成
  // 屏幕坐标（画线按品种保存、需跨周期显示）。/ ascending bar times of the current
  // symbol+interval, used by the draw layer to interpolate an anchor's time to
  // an x coordinate across intervals (drawings are saved per symbol).
  const barTimesRef = useRef<number[]>([])
  const getBarTimes = useCallback(() => barTimesRef.current, [])

  const [symbol, setSymbol] = useState<string>(
    () => {
      // 优先云端偏好 > localStorage 旧缓存 > 默认值
      // cloud prefs > legacy localStorage > default
      const cloud = getPref<string>('charts', 'symbol', '')
      if (cloud && PRESET_SYMBOLS.includes(cloud)) return cloud
      const saved = localStorage.getItem(SYMBOL_KEY)
      return saved && PRESET_SYMBOLS.includes(saved) ? saved : PRESET_SYMBOLS[0]
    }
  )
  const [interval, setIntervalCode] = useState<string>(
    () => getPref<string>('charts', 'interval', '') || localStorage.getItem(INTERVAL_KEY) || '15'
  )
  // 数据状态：加载中 / 有数据 / 空（该品种周期暂无数据）/延迟
  // data status: loading / has data / empty (no data for this symbol+interval) / stale
  const [hasData, setHasData] = useState(false)
  const [stale, setStale] = useState(false)

  // 画图层就绪标记：图表实例建好后再挂载 DrawLayer / mount DrawLayer once the chart is built
  const [drawReady, setDrawReady] = useState(false)
  // 最新收盘价：喂给画图层做重绘侦测，并作为无实时报价时的下单参考价
  // latest close: feeds the draw layer's repaint detection and the order modal's fallback price
  const [lastPrice, setLastPrice] = useState(0)
  // 手动下单弹窗：null 表示关闭 / manual order modal: null = closed
  const [orderSide, setOrderSide] = useState<'BUY' | 'SELL' | null>(null)

  const { accounts } = useLive()
  const quotes = useQuotes()
  const { toast, placeManualOrder } = useOrderPlacement()

  const handleOrderConfirm = async (
    volume: number,
    mt5Login: string | null,
    stopLoss: number | null,
    takeProfit: number | null,
  ) => {
    if (!orderSide) return
    // 不在这里关弹窗：ChartOrderModal 自己会展示"已提交"回执卡片，再调用
    // onCancel 关闭；立刻关闭会让回执卡片还没渲染出来就被卸载。
    // Don't close the modal here: ChartOrderModal shows its own "submitted"
    // receipt card and calls onCancel itself; closing immediately would
    // unmount it before the receipt card ever gets to render.
    await placeManualOrder(symbol, orderSide, volume, mt5Login, stopLoss, takeProfit)
  }

  // 云端偏好加载完成后覆盖本地初始值 / override initial values when cloud prefs arrive
  useEffect(() => {
    if (!loaded) return
    const cloudSym = getPref<string>('charts', 'symbol', '')
    if (cloudSym && PRESET_SYMBOLS.includes(cloudSym)) setSymbol(cloudSym)
    const cloudInt = getPref<string>('charts', 'interval', '')
    if (cloudInt) setIntervalCode(cloudInt)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only run when cloud prefs finish loading
  }, [loaded])

  useEffect(() => {
    setPref('charts', 'symbol', symbol)
  }, [symbol, setPref])

  useEffect(() => {
    setPref('charts', 'interval', interval)
  }, [interval, setPref])

  // 建图（只建一次），容器尺寸变化时自适配 / build the chart once; auto-sizes with the container
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: 'rgba(10, 7, 16, 1)' },
        textColor: '#94a3b8',
        // 关闭库自带的 TradingView 署名 logo；Apache-2.0 许可要求的署名改用
        // 下方免责声明旁边的文字链接满足（见 charts.disclaimer 附近的 <a>）。
        // Disable the library's built-in TradingView attribution logo; the
        // Apache-2.0 license's attribution requirement is satisfied instead
        // via the text link next to the disclaimer below.
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(139, 70, 255, 0.08)' },
        horzLines: { color: 'rgba(139, 70, 255, 0.08)' },
      },
      rightPriceScale: { borderColor: 'rgba(139, 70, 255, 0.15)' },
      timeScale: {
        borderColor: 'rgba(139, 70, 255, 0.15)',
        timeVisible: true,
        secondsVisible: false,
        // 固定按 UTC 展示，并在工具条标注"UTC"徽标(见下方 JSX)。此前固定按
        // 马来西亚时区却完全不标注，非马来西亚用户对着 K 线时间轴会以为看的
        // 是自己当地时间，读错开盘/信号触发的实际时刻。
        // (喂价器已把时间戳归一化到真 UTC，见 CHART_SELFHOST_PLAN.md §3.1.1)
        // Fixed to UTC, with a "UTC" badge in the toolbar below. This used to
        // be hardcoded to Malaysia time with zero indication — a non-Malaysia
        // user reading the candle time axis would assume it was their own
        // local time and misread when things actually happened.
        // (the feeder normalizes timestamps to true UTC — see plan §3.1.1)
        tickMarkFormatter: (time: UTCTimestamp) =>
          new Intl.DateTimeFormat('en-GB', {
            timeZone: 'UTC',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          }).format(new Date(time * 1000)),
      },
      crosshair: { mode: 0 },
      width: el.clientWidth,
      height: el.clientHeight,
    })
    const series = chart.addCandlestickSeries({
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      borderVisible: false,
    })
    chartRef.current = chart
    seriesRef.current = series
    setDrawReady(true)

    // 自适配容器尺寸：手动管理而不是用 lightweight-charts 的 autoSize 选项，
    // 在部分渲染环境下其内部 ResizeObserver 不会触发重绘（canvas 位图分辨率
    // 卡在浏览器默认的 300x150），显式 resize() 更可靠。
    // Track the container size ourselves instead of the library's autoSize
    // option — in some rendering environments its internal ResizeObserver
    // never repaints (the canvas bitmap resolution stays stuck at the
    // browser's default 300x150); an explicit resize() call is more reliable.
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      // forceRepaint=true：跳过内部按 requestAnimationFrame 批处理的重绘排期，
      // 立即同步重绘，resize 时不会有一帧尺寸不对的闪烁。
      // forceRepaint=true: skips the internal requestAnimationFrame-batched
      // redraw scheduling and repaints immediately/synchronously, avoiding a
      // one-frame flash of the wrong size on resize.
      if (width > 0 && height > 0) chart.resize(width, height, true)
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      setDrawReady(false)
    }
  }, [])

  // 切品种/周期：拉历史快照 + 起轮询最新价 / on symbol or interval change: fetch history + poll latest
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    let alive = true
    setHasData(false)
    setStale(false)
    setLastPrice(0)
    lastTimeRef.current = 0
    barTimesRef.current = []

    // 把一根 bar 应用到图表：只在其时间 >= 已应用的最新时间时更新，避免
    // lightweight-charts 对更早时间抛错而中断实时刷新。
    // Apply one bar to the chart, but only when its time >= the newest applied
    // time — otherwise lightweight-charts throws on an older time and the live
    // refresh stalls.
    const applyBar = (b: Candle) => {
      if (b.t < lastTimeRef.current) return
      series.update(toLwPoint(b))
      lastTimeRef.current = b.t
    }

    // 按品种设置价格轴小数位数，否则默认按 2 位显示，外汇对（如 EURUSD）
    // 会把 1.08543 截断成 1.09 这种不可用的精度。
    // Set the price-scale precision per symbol; otherwise it defaults to 2
    // digits, truncating FX pairs (e.g. EURUSD) to an unusable 1.08543 -> 1.09.
    const decimals = SYMBOL_DECIMALS[symbol] ?? 2
    series.applyOptions({
      priceFormat: { type: 'price', precision: decimals, minMove: Math.pow(10, -decimals) },
    })

    chartApi.history(symbol, interval).then((r) => {
      if (!alive) return
      if (r.bars.length > 0) {
        series.setData(r.bars.map(toLwPoint))
        lastTimeRef.current = r.bars[r.bars.length - 1].t
        setLastPrice(r.bars[r.bars.length - 1].c)
        barTimesRef.current = r.bars.map((b) => b.t)
        chartRef.current?.timeScale().fitContent()
        setHasData(true)
      } else {
        setHasData(false)
      }
    }).catch(() => {
      if (alive) setHasData(false)
    })

    const timer = window.setInterval(() => {
      chartApi.latest(symbol, interval).then((r) => {
        if (!alive) return
        for (const b of r.bars) applyBar(b)
        // 追加新出现的 bar 时间，保持 barTimesRef 与图表同步 / keep bar times in sync
        for (const b of r.bars) {
          const arr = barTimesRef.current
          if (arr.length && b.t > arr[arr.length - 1]) arr.push(b.t)
        }
        if (r.bars.length > 0) {
          setHasData(true)
          setLastPrice(r.bars[r.bars.length - 1].c)
        }
        const fresh = r.updatedAt != null && Date.now() / 1000 - r.updatedAt < STALE_MS / 1000
        setStale(r.updatedAt != null && !fresh)
      }).catch(() => {})
    }, POLL_MS)

    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [symbol, interval])

  return (
    <div className="flex flex-col">
      <div className="mb-5">
        <h2 className="font-display text-2xl font-bold text-slate-100">
          <span className="neon-text">{t('charts.title')}</span>
        </h2>
        <p className="mt-1 text-sm text-slate-400">{t('charts.subtitle')}</p>
      </div>

      {/* 控制条：品种 + 周期 / controls: symbol + interval */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-slate-500">
            {t('charts.symbol')}
          </span>
          <select
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="rounded-lg border border-white/10 bg-ink-800/80 px-3 py-1.5 text-sm text-slate-100 outline-none transition focus:border-prism-500"
          >
            {PRESET_SYMBOLS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-center gap-1 rounded-lg border border-white/10 bg-ink-800/50 p-1">
          {INTERVALS.map((iv) => (
            <button
              key={iv.code}
              onClick={() => setIntervalCode(iv.code)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                interval === iv.code
                  ? 'bg-prism-600/30 text-prism-200 shadow-prism'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {iv.label}
            </button>
          ))}
        </div>

        <span className="rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-medium text-slate-400" title={t('charts.utcHint')}>
          {t('charts.utcBadge')}
        </span>

        {stale && (
          <span className="rounded-md bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-400">
            {t('charts.stale')}
          </span>
        )}

        {/* 买 / 卖：点击弹出确认弹窗 / Buy / Sell: open the confirm modal */}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setOrderSide('BUY')}
            className="rounded-lg px-5 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-110"
            style={{ background: 'var(--up)' }}
          >
            {t('charts.order.buy')}
          </button>
          <button
            onClick={() => setOrderSide('SELL')}
            className="rounded-lg px-5 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-110"
            style={{ background: 'var(--down)' }}
          >
            {t('charts.order.sell')}
          </button>
        </div>
      </div>

      {/* 图表容器：跟随视口高度自适应，移动端给底部 Tab 栏留空间 */}
      {/* Chart container: viewport-relative height, leaves room for the mobile tab bar */}
      <div className="glass relative overflow-hidden p-1.5 h-[70vh] min-h-[420px] sm:h-[calc(100vh-15rem)]">
        <div ref={containerRef} className="h-full w-full" />
        {drawReady && chartRef.current && seriesRef.current && containerRef.current && (
          <DrawLayer
            chart={chartRef.current}
            series={seriesRef.current}
            host={containerRef.current}
            symbol={symbol}
            lastPrice={lastPrice}
            barTimes={getBarTimes}
            digits={SYMBOL_DECIMALS[symbol] ?? 2}
          />
        )}
        {!hasData && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-500">
            {t('charts.empty')}
          </div>
        )}
      </div>

      <p className="mt-3 text-center text-[11px] text-slate-600">
        {t('charts.disclaimer')}{' '}
        <a
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-dotted hover:text-slate-400"
        >
          Charting library by TradingView
        </a>
      </p>

      {orderSide && (
        <ChartOrderModal
          symbol={symbol}
          side={orderSide}
          accounts={accounts}
          quote={quotes[symbol]}
          refPrice={lastPrice}
          digits={SYMBOL_DECIMALS[symbol] ?? 2}
          onCancel={() => setOrderSide(null)}
          onConfirm={handleOrderConfirm}
        />
      )}

      {toast && (
        <div className={`fixed bottom-24 left-1/2 z-50 -translate-x-1/2 animate-fade-in-up rounded-xl border px-5 py-3 text-sm shadow-prism sm:bottom-6 ${toastToneClass(toast.kind)}`}>
          {toast.msg}
        </div>
      )}
    </div>
  )
}
