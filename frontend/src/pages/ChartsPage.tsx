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
import { displaySymbol } from '../api/utils'
import { usePrefs } from '../store/prefs'
import { useLive, useQuotes } from '../store/live'
import { useOrderPlacement, toastToneClass } from '../components/signals/hooks'
import DrawLayer from '../components/charts/DrawLayer'
import ChartOrderModal from '../components/ChartOrderModal'

// 图表价格轴的小数位数：贵金属/原油 2~3 位，外汇对按经纪商常见的 5 位报价
// （日元对 3 位），加密货币 2 位。未在表中的品种回退到 2 位。
// Decimal precision for the price scale: metals/oil use 2~3 digits, FX pairs
// use the broker-standard 5-digit quoting (JPY pairs use 3), crypto uses 2.
// Unlisted symbols fall back to 2 digits.
const SYMBOL_DECIMALS: Record<string, number> = {
  XAUUSD: 2,
  XAGUSD: 3,
  WTI: 2,
  EURUSD: 5,
  GBPUSD: 5,
  USDJPY: 3,
  BTCUSD: 2,
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

// 时间轴刻度和十字准线悬浮时间标签是 lightweight-charts 两套独立的格式化配置
// （timeScale.tickMarkFormatter 只管坐标轴刻度；localization.timeFormatter 才
// 管鼠标悬停时显示的精确时间）。之前只设了前者，鼠标悬停显示的还是浏览器本地
// 时区，跟坐标轴上标的 UTC+8 对不上——这正是"图表时间还是不对"的真正原因。
// 两处统一用同一个格式化函数，确保悬停时间与坐标轴时间口径一致。
// Tick-mark labels and the crosshair's hover time readout are two separate
// lightweight-charts formatting hooks (timeScale.tickMarkFormatter only
// controls the axis ticks; localization.timeFormatter controls the precise
// time shown while hovering). Only the former was set, so hovering still
// showed the browser's local timezone while the axis said UTC+8 — this
// mismatch was the actual "chart time is still wrong" bug. Both now share one
// formatter so the hover time and the axis time always agree.
function fmtChartTime(time: UTCTimestamp): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(time * 1000))
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

  // 初始值只是尽力猜测（此刻 activeSymbols 还没从后端加载回来，无法校验是否
  // 真的还活跃）；下面那个 effect 会在 activeSymbols 就绪后校正——若猜的品种
  // 已不在活跃列表里（或还没猜出来，是空字符串），改成活跃列表的第一个。
  // The initial value is only a best-effort guess (activeSymbols hasn't
  // loaded from the backend yet, so we can't verify it's still active); the
  // effect below corrects it once activeSymbols is ready — falls back to the
  // active list's first entry if the guess is no longer active (or empty).
  const [symbol, setSymbol] = useState<string>(
    () => getPref<string>('charts', 'symbol', '') || localStorage.getItem(SYMBOL_KEY) || ''
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

  const { accounts, activeSymbols } = useLive()
  const accountQuotes = useQuotes()
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
    if (cloudSym) setSymbol(cloudSym)
    const cloudInt = getPref<string>('charts', 'interval', '')
    if (cloudInt) setIntervalCode(cloudInt)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only run when cloud prefs finish loading
  }, [loaded])

  // 校正当前品种：activeSymbols 首次加载完成前是空数组，此时任何猜测都无法
  // 校验；一旦有了真实列表，若当前品种已不在其中（EA 端删掉了、或还没猜出
  // 值），改用活跃列表的第一个。EA 增删品种时也会顺带把已失效的选择带回来。
  // Correct the current symbol: activeSymbols is empty until it first loads,
  // so nothing can be validated yet. Once the real list is in, if the current
  // symbol isn't in it (removed on the EA side, or never resolved), fall back
  // to the active list's first entry. Also re-corrects if the EA's symbol set
  // changes later and the current selection falls out of it.
  useEffect(() => {
    if (activeSymbols.length === 0) return
    if (!activeSymbols.includes(symbol)) setSymbol(activeSymbols[0])
  }, [activeSymbols, symbol])

  useEffect(() => {
    if (!symbol) return // 尚未校正出有效品种前不写回偏好，避免用空字符串覆盖已保存的选择
                         // don't persist before a valid symbol is resolved, so we never overwrite a saved pref with ''
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
        // 坐标轴刻度用的格式化函数，见上方 fmtChartTime 的说明。
        // Axis tick-mark formatter — see fmtChartTime's comment above.
        tickMarkFormatter: fmtChartTime,
      },
      // localization.timeFormatter 管十字准线悬停时显示的精确时间，必须跟
      // tickMarkFormatter 用同一个函数，否则悬停时间会掉回浏览器本地时区。
      // localization.timeFormatter controls the crosshair's hover time
      // readout; must share the same formatter as tickMarkFormatter or the
      // hover time falls back to the browser's local timezone.
      localization: { timeFormatter: fmtChartTime },
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
    if (!series || !symbol) return // symbol 为空说明 activeSymbols 还没校正出有效值，等下一轮
                                    // empty symbol means activeSymbols hasn't resolved a valid value yet
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
            disabled={activeSymbols.length === 0}
            className="rounded-lg border border-white/10 bg-ink-800/80 px-3 py-1.5 text-sm text-slate-100 outline-none transition focus:border-prism-500 disabled:opacity-50"
          >
            {activeSymbols.length === 0 ? (
              <option value="">{t('common.loading')}</option>
            ) : (
              activeSymbols.map((s) => (
                <option key={s} value={s}>
                  {displaySymbol(s)}
                </option>
              ))
            )}
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

      {/* 时区标注：紧贴在图表下方，而不是塞进顶部一堆控件里，让"这是 UTC+8"
          这件事离图表本身最近，不容易被忽略。
          Timezone label: sits right under the chart itself rather than buried
          in the top control row, so "this is UTC+8" stays next to the chart
          it describes and isn't easy to miss. */}
      <div className="mt-2 flex items-center justify-center gap-1.5 text-[11px] text-slate-500">
        <span>{t('charts.utcHint')}</span>
        <span className="rounded-md border border-white/10 bg-white/5 px-2 py-0.5 font-medium text-slate-400">
          {t('charts.utcBadge')}
        </span>
      </div>

      <p className="mt-2 text-center text-[11px] text-slate-600">
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
          quotesByAccount={accountQuotes}
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
