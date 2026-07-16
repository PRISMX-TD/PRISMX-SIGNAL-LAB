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
import {
  createChart,
  ColorType,
  LineStyle,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { chartApi } from '../api/client'
import type { Candle } from '../api/types'
import { displaySymbol } from '../api/utils'
import { usePrefs } from '../store/prefs'
import { useLive, useQuotes } from '../store/live'
import { useOrderPlacement, toastToneClass } from '../components/signals/hooks'
import { sma, ema, bollinger, rsi, macd, closes } from '../utils/indicators'
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
// 客户端保留的最大 K 线根数，与后端 chart_store.MAX_BARS 对齐，避免图表页
// 开着很久时 candlesRef 无限增长。/ max bars kept client-side, matching the
// backend's chart_store.MAX_BARS so candlesRef doesn't grow unbounded over a
// long-lived page session.
const MAX_CLIENT_BARS = 500

// 涨跌配色（与 SignalView 的 FOCUS_DOT 一致）/ up/down colors (match SignalView's FOCUS_DOT)
const UP_COLOR = '#2ee07e'
const DOWN_COLOR = '#ff4d67'

// ---------- 指标开关与默认参数 / indicator toggles & default parameters ----------
// 周期/参数暂不做用户可调（先把"有没有"这道坎迈过去），后续如需自定义窗口
// 长度可以在这批常量上加输入框，不影响下面的计算与渲染管线。
// Periods/parameters aren't user-tunable yet (getting these onto the chart at
// all is this pass's goal); adding period inputs later only touches these
// constants, not the calc/render pipeline below.
interface IndicatorFlags {
  ma: boolean
  ema: boolean
  boll: boolean
  volume: boolean
  rsi: boolean
  macd: boolean
}
const DEFAULT_INDICATORS: IndicatorFlags = {
  ma: false,
  ema: false,
  boll: false,
  volume: true, // 默认开：这一整轮 EA/后端改造就是为了喂出 volume，默认可见让效果立刻看得见
  rsi: false,
  macd: false,
}
const INDICATOR_KEYS = Object.keys(DEFAULT_INDICATORS) as (keyof IndicatorFlags)[]

const MA_PERIODS = [7, 25, 99] as const
const MA_COLORS = ['#f5c451', '#a78bfa', '#22d3ee']
const EMA_PERIODS = [12, 26] as const
const EMA_COLORS = ['#38bdf8', '#fb7185']
const BOLL_PERIOD = 20
const BOLL_MULT = 2
const RSI_PERIOD = 14
const MACD_FAST = 12
const MACD_SLOW = 26
const MACD_SIGNAL = 9

function toLwPoint(b: Candle) {
  return { time: b.t as UTCTimestamp, open: b.o, high: b.h, low: b.l, close: b.c }
}

// 把一条可能含 null（预热期）的指标序列转成 lightweight-charts 的折线数据点，
// 丢掉 null 位置（而不是传 0，那样会在图上画出一条假的归零线）。
// Convert an indicator series that may contain null (warm-up) entries into
// lightweight-charts line-series points, dropping the null positions (rather
// than sending 0, which would draw a false line down to zero).
function toLinePoints(times: UTCTimestamp[], values: (number | null)[]): { time: UTCTimestamp; value: number }[] {
  const out: { time: UTCTimestamp; value: number }[] = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v != null) out.push({ time: times[i], value: v })
  }
  return out
}

// MACD 柱状图：同上但带正负配色 / MACD histogram: same, but colored by sign
function toHistPoints(times: UTCTimestamp[], values: (number | null)[]): { time: UTCTimestamp; value: number; color: string }[] {
  const out: { time: UTCTimestamp; value: number; color: string }[] = []
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v != null) out.push({ time: times[i], value: v, color: v >= 0 ? UP_COLOR : DOWN_COLOR })
  }
  return out
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

  // 当前品种/周期的完整 OHLCV 历史（升序），指标计算的唯一数据来源。与主
  // K 线 series 分开维护，因为指标要用到全部历史做窗口计算，而主 series 的
  // update() 只关心增量。/ full ascending OHLCV history for the current
  // symbol+interval — the sole data source for indicator math. Kept separate
  // from the main candlestick series because indicators need the whole
  // window to compute over, while the main series' update() only cares about
  // the incremental tail.
  const candlesRef = useRef<Candle[]>([])

  // 主图叠加指标的 series 句柄：MA/EMA/布林带 —— 这些从建图起就一直存在，
  // 开关只是切换 visible，不做动态增删（同一 pane 内没有下标错位问题，动态
  // 增删反而更复杂）。/ Main-pane overlay series handles: MA/EMA/Bollinger —
  // these exist for the chart's whole lifetime; toggling only flips `visible`
  // rather than adding/removing (no pane-index bookkeeping issue within the
  // same pane, so dynamic add/remove would only add complexity).
  const maSeriesRef = useRef<ISeriesApi<'Line'>[]>([])
  const emaSeriesRef = useRef<ISeriesApi<'Line'>[]>([])
  const bollSeriesRef = useRef<{ mid: ISeriesApi<'Line'>; upper: ISeriesApi<'Line'>; lower: ISeriesApi<'Line'> } | null>(null)

  // 副图指标（成交量/RSI/MACD）的 series 句柄：这三个各自占一个独立 pane，
  // 关闭时整个 series 连同 pane 一起移除（隐藏 series 并不会让 pane 消失，
  // 会留一条空白的轴），开启时重新创建，见下方的开关 effect。
  // Sub-pane indicators (volume/RSI/MACD): each occupies its own pane, so
  // turning one off removes the series (and its now-empty pane) entirely
  // (merely hiding the series would leave a blank axis gutter behind); turning
  // it on recreates it — see the toggle effect below.
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const rsiSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  const macdSeriesRef = useRef<{ macd: ISeriesApi<'Line'>; signal: ISeriesApi<'Line'>; hist: ISeriesApi<'Histogram'> } | null>(null)

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
  // 指标开关：按品种/周期无关，跟随用户走（云端同步，见下方持久化 effect）。
  // Indicator toggles: independent of symbol/interval, follow the user (cloud
  // synced; see the persistence effect below).
  const [indicators, setIndicatorsState] = useState<IndicatorFlags>(
    () => ({ ...DEFAULT_INDICATORS, ...getPref<Partial<IndicatorFlags>>('charts', 'indicators', {}) })
  )
  // 指标面板展开态 + 面板外点击收起 / indicator panel open state + outside-click-to-close
  const [indPanelOpen, setIndPanelOpen] = useState(false)
  const indPanelRef = useRef<HTMLDivElement>(null)

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
    const cloudInd = getPref<Partial<IndicatorFlags> | null>('charts', 'indicators', null)
    if (cloudInd) setIndicatorsState({ ...DEFAULT_INDICATORS, ...cloudInd })
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

  // 指标开关落库：与 symbol/interval 同一套模式——只在 setState 的更新函数
  // 里做纯粹的状态计算，落库放到单独的 effect 里对状态变化作出反应。
  // 之前的实现在 setIndicatorsState 的更新函数内部直接调用 setPref（属于
  // PrefsProvider 的另一个 setState），触发了 React 的
  // "Cannot update a component while rendering a different component" 警告——
  // 更新函数在某些时序下会被多次调用，连带 setPref 也跟着多次触发，实测会
  // 导致开关状态被异常带乱（例如只点一个开关，另外几个也跟着变了）。
  // Persist indicator toggles the same way symbol/interval already do: the
  // setState updater only computes the next state; persisting happens in its
  // own effect reacting to the state change. The previous implementation
  // called setPref (another component's — PrefsProvider's — setState)
  // directly inside setIndicatorsState's updater function, which is exactly
  // what triggers React's "Cannot update a component while rendering a
  // different component" warning — the updater can be invoked more than once
  // under certain timings, and setPref would fire right along with it,
  // observed in testing to scramble the toggle state (e.g. clicking one
  // toggle also flipping others).
  useEffect(() => {
    setPref('charts', 'indicators', indicators)
  }, [indicators, setPref])

  const toggleIndicator = useCallback((key: keyof IndicatorFlags) => {
    setIndicatorsState((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  // 指标面板展开时，点击面板外部收起 / while the indicator panel is open, close it on an outside click
  useEffect(() => {
    if (!indPanelOpen) return
    const onClick = (e: MouseEvent) => {
      if (indPanelRef.current && !indPanelRef.current.contains(e.target as Node)) setIndPanelOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [indPanelOpen])

  // 按当前 candlesRef 重算全部指标并写回各自的 series。用 useCallback 空依赖
  // 数组保持函数引用稳定（只依赖 ref，不依赖任何 state），这样无论从哪个
  // effect/定时器闭包里调用，读到的都是当时最新的 candlesRef 内容,不会有
  // 陈旧闭包的问题。主图叠加（MA/EMA/BOLL）的 series 从建图起就常驻，因此
  // 不论开关与否都照算——代价可忽略（几百个点的数组运算），换来的是打开开关
  // 那一刻数据已经是对的，不需要额外补一次"刚打开，先算一遍"的逻辑。副图
  // （成交量/RSI/MACD）的 series 只在打开时才存在，靠 ref 是否为 null 天然
  // 跳过关闭状态的计算。
  // Recompute every indicator from the current candlesRef and write it back
  // to its series. useCallback with an empty dep array keeps this function's
  // identity stable (it only reads refs, no state), so no matter which
  // effect/timer closure calls it, it always sees the latest candlesRef
  // contents — no stale-closure risk. Main-pane overlays (MA/EMA/BOLL) always
  // exist once the chart is built, so they're recomputed unconditionally
  // regardless of their toggle (negligible cost for a few-hundred-point
  // array), which means the moment a toggle flips on the data is already
  // correct — no separate "just turned on, backfill now" step needed.
  // Sub-pane indicators (volume/RSI/MACD) only exist while enabled, so a
  // null ref naturally skips the work while off.
  const recomputeIndicators = useCallback(() => {
    const bars = candlesRef.current
    if (bars.length === 0) return
    const times = bars.map((b) => b.t as UTCTimestamp)
    const cl = closes(bars)

    MA_PERIODS.forEach((period, i) => {
      maSeriesRef.current[i]?.setData(toLinePoints(times, sma(cl, period)))
    })
    EMA_PERIODS.forEach((period, i) => {
      emaSeriesRef.current[i]?.setData(toLinePoints(times, ema(cl, period)))
    })
    if (bollSeriesRef.current) {
      const { mid, upper, lower } = bollinger(cl, BOLL_PERIOD, BOLL_MULT)
      bollSeriesRef.current.mid.setData(toLinePoints(times, mid))
      bollSeriesRef.current.upper.setData(toLinePoints(times, upper))
      bollSeriesRef.current.lower.setData(toLinePoints(times, lower))
    }
    if (volumeSeriesRef.current) {
      volumeSeriesRef.current.setData(
        bars.map((b) => ({ time: b.t as UTCTimestamp, value: b.v, color: b.c >= b.o ? UP_COLOR : DOWN_COLOR }))
      )
    }
    if (rsiSeriesRef.current) {
      rsiSeriesRef.current.setData(toLinePoints(times, rsi(cl, RSI_PERIOD)))
    }
    if (macdSeriesRef.current) {
      const { macd: macdLine, signal, hist } = macd(cl, MACD_FAST, MACD_SLOW, MACD_SIGNAL)
      macdSeriesRef.current.macd.setData(toLinePoints(times, macdLine))
      macdSeriesRef.current.signal.setData(toLinePoints(times, signal))
      macdSeriesRef.current.hist.setData(toHistPoints(times, hist))
    }
  }, [])

  // 按容器高度重新分配各 pane 的高度：主图占大头，副图（成交量/RSI/MACD）
  // 平分剩余空间，每个不低于 70px 以保证波形仍可辨认。resize 与副图开关都
  // 会调用它。/ Redistribute pane heights from the container's height: the
  // main pane gets the lion's share, sub-panes (volume/RSI/MACD) split what's
  // left, each floored at 70px so the waveform stays legible. Called on
  // resize and whenever a sub-pane indicator is toggled.
  const applyPaneHeights = useCallback(() => {
    const chart = chartRef.current
    const host = containerRef.current
    if (!chart || !host) return
    const panes = chart.panes()
    const total = host.clientHeight
    if (panes.length <= 1 || total <= 0) return
    const subCount = panes.length - 1
    const subTotal = Math.max(total * 0.35, subCount * 70)
    const mainHeight = Math.max(total - subTotal, total * 0.4)
    const subHeight = Math.floor((total - mainHeight) / subCount)
    panes[0].setHeight(Math.floor(mainHeight))
    for (let i = 1; i < panes.length; i++) panes[i].setHeight(subHeight)
  }, [])

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
    // v5：series 创建统一走 addSeries(SeriesType, options)，取代 v4 的
    // addCandlestickSeries(options)；坐标换算类 API（DrawLayer 用到的
    // timeToCoordinate/priceToCoordinate 等）在 v4→v5 之间未变。
    // v5: series creation is unified as addSeries(SeriesType, options),
    // replacing v4's addCandlestickSeries(options); the coordinate-conversion
    // APIs (timeToCoordinate/priceToCoordinate etc., used by DrawLayer) are
    // unchanged between v4 and v5.
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      borderVisible: false,
    })
    chartRef.current = chart
    seriesRef.current = series

    // 主图叠加指标 series：一次性建好、常驻，初始 visible:false，真正的可见性
    // 由下方按开关同步的 effect 立即接管（见 indicators.ma/ema/boll 那个
    // effect），这里的初始值只是个无所谓的占位。
    // Main-pane overlay series: created once, permanent; start with
    // visible:false — the actual visibility is taken over immediately by the
    // effect below that syncs it to the toggles (see the
    // indicators.ma/ema/boll effect); the initial value here is a
    // don't-care placeholder.
    maSeriesRef.current = MA_PERIODS.map((_, i) =>
      chart.addSeries(LineSeries, { color: MA_COLORS[i], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, visible: false })
    )
    emaSeriesRef.current = EMA_PERIODS.map((_, i) =>
      chart.addSeries(LineSeries, { color: EMA_COLORS[i], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, visible: false })
    )
    bollSeriesRef.current = {
      mid: chart.addSeries(LineSeries, { color: '#a78bfa', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, visible: false }),
      upper: chart.addSeries(LineSeries, {
        color: '#a78bfa',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        visible: false,
      }),
      lower: chart.addSeries(LineSeries, {
        color: '#a78bfa',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        visible: false,
      }),
    }

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
      if (width > 0 && height > 0) {
        chart.resize(width, height, true)
        applyPaneHeights()
      }
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      maSeriesRef.current = []
      emaSeriesRef.current = []
      bollSeriesRef.current = null
      volumeSeriesRef.current = null
      rsiSeriesRef.current = null
      macdSeriesRef.current = null
      setDrawReady(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- build the chart once; applyPaneHeights is stable (empty deps)
  }, [])

  // 主图叠加指标可见性同步：MA/EMA/布林带的 series 常驻，开关只切换 visible。
  // Sync main-pane overlay visibility: MA/EMA/Bollinger series are permanent;
  // toggling only flips `visible`.
  useEffect(() => {
    maSeriesRef.current.forEach((s) => s.applyOptions({ visible: indicators.ma }))
    emaSeriesRef.current.forEach((s) => s.applyOptions({ visible: indicators.ema }))
    if (bollSeriesRef.current) {
      bollSeriesRef.current.mid.applyOptions({ visible: indicators.boll })
      bollSeriesRef.current.upper.applyOptions({ visible: indicators.boll })
      bollSeriesRef.current.lower.applyOptions({ visible: indicators.boll })
    }
  }, [indicators.ma, indicators.ema, indicators.boll])

  // 副图指标（成交量/RSI/MACD）开关：先整体拆掉旧的三个副图 series（移除后
  // 空 pane 会被库自动删除），再按当前开关状态依次重建，用
  // chart.panes().length 作为新 pane 的下标即可保证总是追加在最后——不需要
  // 手动维护"谁在第几个 pane"这本账。
  // Sub-pane indicator toggles (volume/RSI/MACD): tear down all three
  // existing sub-pane series first (removing them auto-deletes their
  // now-empty panes), then recreate whichever are enabled, using
  // chart.panes().length as the new pane's index — this always appends as
  // the last pane, so there's no manual "which indicator lives in which pane"
  // bookkeeping to get wrong.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return

    if (volumeSeriesRef.current) {
      chart.removeSeries(volumeSeriesRef.current)
      volumeSeriesRef.current = null
    }
    if (rsiSeriesRef.current) {
      chart.removeSeries(rsiSeriesRef.current)
      rsiSeriesRef.current = null
    }
    if (macdSeriesRef.current) {
      chart.removeSeries(macdSeriesRef.current.hist)
      chart.removeSeries(macdSeriesRef.current.signal)
      chart.removeSeries(macdSeriesRef.current.macd)
      macdSeriesRef.current = null
    }

    if (indicators.volume) {
      volumeSeriesRef.current = chart.addSeries(
        HistogramSeries,
        { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false },
        chart.panes().length
      )
    }
    if (indicators.rsi) {
      const s = chart.addSeries(
        LineSeries,
        { color: '#facc15', lineWidth: 1, priceLineVisible: false, lastValueVisible: false },
        chart.panes().length
      )
      // 30/70 参考线：超买/超卖的传统阈值 / 30/70 reference lines: the conventional overbought/oversold thresholds
      s.createPriceLine({ price: 70, color: 'rgba(148,163,184,0.5)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '70' })
      s.createPriceLine({ price: 30, color: 'rgba(148,163,184,0.5)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '30' })
      rsiSeriesRef.current = s
    }
    if (indicators.macd) {
      const paneIndex = chart.panes().length
      const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, paneIndex)
      const macdLine = chart.addSeries(LineSeries, { color: '#38bdf8', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, paneIndex)
      const signal = chart.addSeries(LineSeries, { color: '#fb7185', lineWidth: 1, priceLineVisible: false, lastValueVisible: false }, paneIndex)
      macdSeriesRef.current = { macd: macdLine, signal, hist }
    }

    applyPaneHeights()
    recomputeIndicators()
  }, [indicators.volume, indicators.rsi, indicators.macd, applyPaneHeights, recomputeIndicators])

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
    candlesRef.current = []

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

    // 把一根 bar 合并进 candlesRef：相同时间戳覆盖（形成中的 bar），新时间戳
    // 追加并按 MAX_CLIENT_BARS 截断——语义上镜像后端 chart_store.merge_bars。
    // Merge one bar into candlesRef: same timestamp overwrites (bar still
    // forming), newer timestamp appends and gets trimmed to
    // MAX_CLIENT_BARS — mirrors the backend's chart_store.merge_bars semantics.
    const mergeCandle = (b: Candle) => {
      const arr = candlesRef.current
      const lastT = arr.length ? arr[arr.length - 1].t : -Infinity
      if (b.t < lastT) return
      if (b.t === lastT) arr[arr.length - 1] = b
      else {
        arr.push(b)
        if (arr.length > MAX_CLIENT_BARS) arr.shift()
      }
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
        candlesRef.current = r.bars.slice(-MAX_CLIENT_BARS)
        recomputeIndicators()
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
        for (const b of r.bars) mergeCandle(b)
        // 追加新出现的 bar 时间，保持 barTimesRef 与图表同步 / keep bar times in sync
        for (const b of r.bars) {
          const arr = barTimesRef.current
          if (arr.length && b.t > arr[arr.length - 1]) arr.push(b.t)
        }
        if (r.bars.length > 0) {
          setHasData(true)
          setLastPrice(r.bars[r.bars.length - 1].c)
          recomputeIndicators()
        }
        const fresh = r.updatedAt != null && Date.now() / 1000 - r.updatedAt < STALE_MS / 1000
        setStale(r.updatedAt != null && !fresh)
      }).catch(() => {})
    }, POLL_MS)

    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [symbol, interval, recomputeIndicators])

  return (
    <div className="flex flex-col">
      <div className="mb-5">
        <h2 className="font-display text-2xl font-bold text-slate-100">
          <span className="neon-text">{t('charts.title')}</span>
        </h2>
        <p className="mt-1 text-sm text-slate-400">{t('charts.subtitle')}</p>
      </div>

      {/* 控制条：品种 + 周期 + 指标 / controls: symbol + interval + indicators */}
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

        {/* 指标开关面板 / indicator toggle panel */}
        <div className="relative" ref={indPanelRef}>
          <button
            type="button"
            onClick={() => setIndPanelOpen((v) => !v)}
            className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition ${
              indPanelOpen
                ? 'border-prism-500/60 bg-prism-600/20 text-prism-200'
                : 'border-white/10 bg-ink-800/50 text-slate-400 hover:text-slate-100'
            }`}
          >
            {t('charts.indicators.button')}
          </button>
          {indPanelOpen && (
            <div className="absolute left-0 top-full z-30 mt-2 w-56 rounded-xl border border-white/10 bg-ink-900/95 p-3 shadow-prism backdrop-blur">
              {INDICATOR_KEYS.map((key) => (
                <label key={key} className="flex cursor-pointer items-center justify-between gap-2 py-1.5 text-sm text-slate-300">
                  <span>{t(`charts.indicators.${key}`)}</span>
                  <input
                    type="checkbox"
                    checked={indicators[key]}
                    onChange={() => toggleIndicator(key)}
                    className="h-4 w-4 accent-prism-500"
                  />
                </label>
              ))}
            </div>
          )}
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
