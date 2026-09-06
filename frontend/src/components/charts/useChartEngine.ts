// 图表引擎：lightweight-charts 实例、主图/副图指标 series 的建与拆、指标重算、
// pane 高度分配、图例数据。它持有所有 ref，页面与数据 hook 通过返回值使用。
// 2026-09-06 从 pages/ChartsPage.tsx 搬出，内容逐行原样（只把 mobileView 参数
// 一般化成 refitKey：任何值变化都补一次 resize，隐藏时 clientWidth=0 自然跳过）。
// Chart engine: the lightweight-charts instance, indicator series lifecycle,
// recompute, pane heights and legend data. Owns every ref; the page and the data
// hook consume the returned handles. Moved out of ChartsPage verbatim on
// 2026-09-06 (mobileView generalized to refitKey).
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import {
  createChart,
  ColorType,
  LineStyle,
  CandlestickSeries,
  LineSeries,
  HistogramSeries,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { Candle } from '../../api/types'
import { fmtChartTime, toLinePoints } from '../../utils/chartSeries'
import { sma, ema, bollinger, rsi, macd, closes } from '../../utils/indicators'
import type { IndicatorSettings } from './indicatorSettings'
import { markChartDisposed } from './chartLifecycle'
import { DOWN_COLOR, EMPTY_LEGEND, UP_COLOR, toHistPoints, type IndicatorFlags, type LegendValues } from './chartConfig'

export function useChartEngine(
  containerRef: RefObject<HTMLDivElement>,
  indicators: IndicatorFlags,
  indicatorSettings: IndicatorSettings,
  refitKey: unknown,
) {
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
  // 往左翻页的状态。用 ref 而非 state：可视范围回调触发得非常频繁（拖动期间每帧
  // 都可能触发），用 state 会让每次滚动都重渲染整个图表页；这两个值也只在回调
  // 内部读写，不参与渲染。
  // Paging state. Refs rather than state: the visible-range callback fires very
  // frequently (potentially every frame while dragging) and using state would
  // re-render the whole chart page on every scroll; these values are also only
  // read and written inside the callback and never rendered.
  const loadingOlderRef = useRef(false)
  const hasMoreHistoryRef = useRef(true)
  // 用户当前是否在跟踪实时行情（可视范围右边缘在最新 bar 附近）。
  // 初始为 true，用户手动左滑查看历史后变 false，滑回右侧恢复。
  // Whether the user is following live data (right edge near the latest bar).
  // Initially true; set false when the user scrolls left to history, restored
  // when they scroll back to the right edge.
  const isFollowingLiveRef = useRef(true)

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
  // 会留一条空白的轴），开启时重新创建，见下方的开关 effect。RSI 额外持有
  // 30/70（可客制化）参考线的句柄，供设置变化时更新价位而不必重建整条 series。
  // Sub-pane indicators (volume/RSI/MACD): each occupies its own pane, so
  // turning one off removes the series (and its now-empty pane) entirely
  // (merely hiding the series would leave a blank axis gutter behind); turning
  // it on recreates it — see the toggle effect below. RSI additionally holds
  // its (customizable) overbought/oversold reference-line handles, so a
  // settings change can update their price without rebuilding the whole series.
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const rsiSeriesRef = useRef<{ series: ISeriesApi<'Line'>; obLine: IPriceLine; osLine: IPriceLine } | null>(null)
  const macdSeriesRef = useRef<{ macd: ISeriesApi<'Line'>; signal: ISeriesApi<'Line'>; hist: ISeriesApi<'Histogram'> } | null>(null)

  // 图例的"最新值"缓存：不悬停十字准线时用这份兜底（见 recomputeIndicators）。
  // Cached "latest value" snapshot for the legend: used when the crosshair
  // isn't being hovered/dragged (see recomputeIndicators).
  const latestLegendRef = useRef<LegendValues>(EMPTY_LEGEND)
  // 当前是否正悬停/触摸拖动十字准线（由 onCrosshairMove 维护）。真正修复的
  // bug：每 2 秒一次的报价轮询会调用 recomputeIndicators()，若它无条件
  // setLegend(latest)，会把用户正悬停的那个历史值每 2 秒打回"最新值"一次——
  // 实测就是这个问题，而不是十字准线没接住数据（用临时调试钩子直接读了
  // lightweight-charts 在悬停点的原始 seriesData，证实库本身给的值完全正确，
  // 是这里的"轮询无条件覆盖"吃掉了它）。recomputeIndicators 因此只在没有
  // 悬停时才更新图例，悬停时的图例完全交给 onCrosshairMove 自己维护。
  // Whether the crosshair is currently being hovered/touch-dragged
  // (maintained by onCrosshairMove). This ref exists to fix a real bug: the
  // 2-second quote-poll timer calls recomputeIndicators(), and if that
  // unconditionally called setLegend(latest), it would stomp the user's
  // currently-hovered historical value back to "latest" every 2 seconds —
  // confirmed via a temporary debug hook that read lightweight-charts' raw
  // seriesData at the hovered point directly, proving the library itself
  // supplies the correct value and the poll's unconditional overwrite was
  // what erased it. recomputeIndicators now only updates the legend while
  // not hovering; the legend while hovering is owned entirely by
  // onCrosshairMove.
  const hoveringRef = useRef(false)

  // 图例：随十字准线/触摸拖动更新，初始为空占位 / legend: updates with the crosshair/touch drag; starts as an empty placeholder
  const [legend, setLegend] = useState<LegendValues>(EMPTY_LEGEND)
  // 各已开启副图（成交量/RSI/MACD）pane 的顶部像素偏移，供图例定位；由
  // applyPaneHeights 在每次布局变化时一并算出。/ top pixel offset of each
  // enabled sub-pane (volume/RSI/MACD), for positioning its legend; computed
  // by applyPaneHeights alongside the pane heights themselves whenever the
  // layout changes.
  const [paneOffsets, setPaneOffsets] = useState<{ volume: number | null; rsi: number | null; macd: number | null }>({
    volume: null,
    rsi: null,
    macd: null,
  })

  // 画图层就绪标记：图表实例建好后再挂载 DrawLayer / mount DrawLayer once the chart is built
  const [drawReady, setDrawReady] = useState(false)

  // 按当前 candlesRef 重算全部指标并写回各自的 series，同时刷新"最新值"图例
  // 缓存。用 useCallback 空依赖数组保持函数引用稳定（只依赖 ref，不依赖任何
  // state），这样无论从哪个 effect/定时器闭包里调用，读到的都是当时最新的
  // candlesRef/indicatorSettingsRef 内容，不会有陈旧闭包的问题。主图叠加
  // （MA/EMA/BOLL）的 series 从建图起就常驻，因此不论开关与否都照算——代价
  // 可忽略（几百个点的数组运算），换来的是打开开关那一刻数据已经是对的，不
  // 需要额外补一次"刚打开，先算一遍"的逻辑。副图（成交量/RSI/MACD）的
  // series 只在打开时才存在，靠 ref 是否为 null 天然跳过关闭状态的计算。
  // Recompute every indicator from the current candlesRef, write it back to
  // its series, and refresh the "latest value" legend cache. useCallback with
  // an empty dep array keeps this function's identity stable (it only reads
  // refs, no state), so no matter which effect/timer closure calls it, it
  // always sees the latest candlesRef/indicatorSettingsRef contents — no
  // stale-closure risk. Main-pane overlays (MA/EMA/BOLL) always exist once
  // the chart is built, so they're recomputed unconditionally regardless of
  // their toggle (negligible cost for a few-hundred-point array), which means
  // the moment a toggle flips on the data is already correct — no separate
  // "just turned on, backfill now" step needed. Sub-pane indicators
  // (volume/RSI/MACD) only exist while enabled, so a null ref naturally skips
  // the work while off.
  const indicatorSettingsRef = useRef(indicatorSettings)
  useEffect(() => {
    indicatorSettingsRef.current = indicatorSettings
  }, [indicatorSettings])

  const recomputeIndicators = useCallback(() => {
    const bars = candlesRef.current
    if (bars.length === 0) return
    const times = bars.map((b) => b.t as UTCTimestamp)
    const cl = closes(bars)
    const s = indicatorSettingsRef.current
    const next: LegendValues = {
      ma: new Array(s.ma.periods.length).fill(null),
      ema: new Array(s.ema.periods.length).fill(null),
      boll: { mid: null, upper: null, lower: null },
      volume: null,
      rsi: null,
      macd: { macd: null, signal: null, hist: null },
    }

    s.ma.periods.forEach((period, i) => {
      const line = sma(cl, period)
      maSeriesRef.current[i]?.setData(toLinePoints(times, line))
      next.ma[i] = line[line.length - 1] ?? null
    })
    s.ema.periods.forEach((period, i) => {
      const line = ema(cl, period)
      emaSeriesRef.current[i]?.setData(toLinePoints(times, line))
      next.ema[i] = line[line.length - 1] ?? null
    })
    if (bollSeriesRef.current) {
      const { mid, upper, lower } = bollinger(cl, s.boll.period, s.boll.mult)
      bollSeriesRef.current.mid.setData(toLinePoints(times, mid))
      bollSeriesRef.current.upper.setData(toLinePoints(times, upper))
      bollSeriesRef.current.lower.setData(toLinePoints(times, lower))
      next.boll = { mid: mid[mid.length - 1] ?? null, upper: upper[upper.length - 1] ?? null, lower: lower[lower.length - 1] ?? null }
    }
    if (volumeSeriesRef.current) {
      volumeSeriesRef.current.setData(
        bars.map((b) => ({ time: b.t as UTCTimestamp, value: b.v, color: b.c >= b.o ? s.volume.upColor : s.volume.downColor }))
      )
      next.volume = bars[bars.length - 1]?.v ?? null
    }
    if (rsiSeriesRef.current) {
      const line = rsi(cl, s.rsi.period)
      rsiSeriesRef.current.series.setData(toLinePoints(times, line))
      next.rsi = line[line.length - 1] ?? null
    }
    if (macdSeriesRef.current) {
      const { macd: macdLine, signal, hist } = macd(cl, s.macd.fast, s.macd.slow, s.macd.signal)
      macdSeriesRef.current.macd.setData(toLinePoints(times, macdLine))
      macdSeriesRef.current.signal.setData(toLinePoints(times, signal))
      macdSeriesRef.current.hist.setData(toHistPoints(times, hist, UP_COLOR, DOWN_COLOR))
      next.macd = {
        macd: macdLine[macdLine.length - 1] ?? null,
        signal: signal[signal.length - 1] ?? null,
        hist: hist[hist.length - 1] ?? null,
      }
    }

    latestLegendRef.current = next
    // 只在没有悬停/触摸拖动时才更新图例；正悬停时图例完全交给
    // onCrosshairMove 维护，避免 2 秒一次的报价轮询把用户正看着的历史值打回
    // "最新值"（见 hoveringRef 的说明）。
    // Only update the legend while not hovering/touch-dragging; while
    // hovering, the legend is owned entirely by onCrosshairMove — otherwise
    // the 2-second quote-poll timer would stomp the user's currently-viewed
    // historical value back to "latest" (see hoveringRef's comment).
    if (!hoveringRef.current) setLegend(next)
  }, [])

  // 按容器高度重新分配各 pane 的高度：主图占大头，副图（成交量/RSI/MACD）
  // 平分剩余空间，每个不低于 70px 以保证波形仍可辨认；同时把每个已开启副图
  // 的顶部像素偏移记下来供图例定位（顺序固定为 成交量→RSI→MACD，与下方开关
  // effect 里创建它们的顺序一致）。resize 与副图开关都会调用它。
  // Redistribute pane heights from the container's height: the main pane gets
  // the lion's share, sub-panes (volume/RSI/MACD) split what's left, each
  // floored at 70px so the waveform stays legible; also records each enabled
  // sub-pane's top pixel offset for positioning its legend (fixed order:
  // volume -> RSI -> MACD, matching the creation order in the toggle effect
  // below). Called on resize and whenever a sub-pane indicator is toggled.
  const applyPaneHeights = useCallback(() => {
    const chart = chartRef.current
    const host = containerRef.current
    if (!chart || !host) return
    const panes = chart.panes()
    const total = host.clientHeight
    if (panes.length <= 1 || total <= 0) {
      setPaneOffsets({ volume: null, rsi: null, macd: null })
      return
    }
    const subCount = panes.length - 1
    const subTotal = Math.max(total * 0.35, subCount * 70)
    const mainHeight = Math.max(total - subTotal, total * 0.4)
    const subHeight = Math.floor((total - mainHeight) / subCount)
    panes[0].setHeight(Math.floor(mainHeight))
    for (let i = 1; i < panes.length; i++) panes[i].setHeight(subHeight)

    let offset = Math.floor(mainHeight)
    const offsets: { volume: number | null; rsi: number | null; macd: number | null } = { volume: null, rsi: null, macd: null }
    if (volumeSeriesRef.current) {
      offsets.volume = offset
      offset += subHeight
    }
    if (rsiSeriesRef.current) {
      offsets.rsi = offset
      offset += subHeight
    }
    if (macdSeriesRef.current) {
      offsets.macd = offset
      offset += subHeight
    }
    setPaneOffsets(offsets)
  }, [])

  // 建图（只建一次），容器尺寸变化时自适配 / build the chart once; auto-sizes with the container
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const initSettings = indicatorSettingsRef.current

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
        // 最新 K 线右侧预留一段空白，便于把趋势线/斐波那契等画到未来区域
        // （配合 DrawLayer 的逻辑索引外推坐标转换）。/ Reserve whitespace to the
        // right of the latest candle so trend lines / fib etc. can be drawn into
        // the future (works with DrawLayer's logical-index coordinate mapping).
        rightOffset: 8,
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
      // 移动端纵向滑动穿透到页面滚动，保留横向拖动平移图表
      handleScroll: { vertTouchDrag: false, horzTouchDrag: true, mouseWheel: true },
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

    // 布林带 series：一次性建好、常驻，初始 visible:false，真正的可见性由下方
    // 按开关同步的 effect 立即接管。crosshairMarkerVisible:false 去掉十字准线
    // 悬停时每条线上出现的圆点——那是 lightweight-charts 的默认行为，用户反馈
    // 这些圆点没有必要、观感上是噪音。MA/EMA 不在这里创建——它们是条数可变的
    // 均线列表（用户可加/删），由各自专门的 effect（见下方）负责创建/重建，
    // 那个 effect 在挂载时也会跑一次，天然完成"初始创建"，不需要在这里重复。
    // Bollinger series: created once, permanent; starts with visible:false —
    // the actual visibility is taken over immediately by the effect below
    // that syncs it to the toggles. crosshairMarkerVisible:false removes the
    // little circle lightweight-charts draws on each line at the crosshair's
    // position by default — user feedback was that these dots are
    // unnecessary visual noise. MA/EMA are NOT created here — they're
    // variable-length line lists (the user can add/remove lines), owned by
    // their own dedicated effects below, which also run once on mount and
    // naturally handle the "initial creation" case, so there's no need to
    // duplicate it here.
    bollSeriesRef.current = {
      mid: chart.addSeries(LineSeries, {
        color: initSettings.boll.color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        visible: false,
      }),
      upper: chart.addSeries(LineSeries, {
        color: initSettings.boll.color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        visible: false,
      }),
      lower: chart.addSeries(LineSeries, {
        color: initSettings.boll.color,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        visible: false,
      }),
    }

    setDrawReady(true)

    // 十字准线/触摸拖动 → 图例：param.time 有值表示鼠标悬停或手指拖动落在
    // 数据区内，用 param.seriesData 查该时刻各 series 的值；undefined 表示
    // 鼠标移出图表/未在拖动，回退到 recomputeIndicators 缓存的"最新值"。
    // lightweight-charts 对触摸事件的处理与鼠标共用同一套订阅，移动端手指
    // 拖动天然会触发这个回调，不需要额外适配；v5 默认的 trackingMode
    // （OnNextTap）也已经让触摸场景下十字准线在松手后继续停留，直到下一次点击。
    // Crosshair hover / touch-drag -> legend: param.time is set when the
    // mouse is hovering or a finger is dragging within the data area; look up
    // each series' value at that moment via param.seriesData. undefined means
    // the mouse left the chart / no active drag, so fall back to
    // recomputeIndicators' cached "latest value". lightweight-charts routes
    // touch events through the same subscription as mouse events, so a
    // finger drag on mobile fires this callback with no extra wiring needed;
    // v5's default trackingMode (OnNextTap) already keeps the crosshair
    // in place after lifting the finger, until the next tap elsewhere.
    const onCrosshairMove: Parameters<typeof chart.subscribeCrosshairMove>[0] = (param) => {
      if (param.time == null) {
        hoveringRef.current = false
        setLegend(latestLegendRef.current)
        return
      }
      hoveringRef.current = true
      const readLine = (s: ISeriesApi<'Line'> | undefined): number | null => {
        if (!s) return null
        const d = param.seriesData.get(s) as { value?: number } | undefined
        return d?.value ?? null
      }
      const readHist = (s: ISeriesApi<'Histogram'> | undefined): number | null => {
        if (!s) return null
        const d = param.seriesData.get(s) as { value?: number } | undefined
        return d?.value ?? null
      }
      const next: LegendValues = {
        ma: maSeriesRef.current.map((s) => readLine(s)),
        ema: emaSeriesRef.current.map((s) => readLine(s)),
        boll: {
          mid: readLine(bollSeriesRef.current?.mid),
          upper: readLine(bollSeriesRef.current?.upper),
          lower: readLine(bollSeriesRef.current?.lower),
        },
        volume: readHist(volumeSeriesRef.current ?? undefined),
        rsi: readLine(rsiSeriesRef.current?.series),
        macd: {
          macd: readLine(macdSeriesRef.current?.macd),
          signal: readLine(macdSeriesRef.current?.signal),
          hist: readHist(macdSeriesRef.current?.hist),
        },
      }
      setLegend(next)
    }
    chart.subscribeCrosshairMove(onCrosshairMove)

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
      chart.unsubscribeCrosshairMove(onCrosshairMove)
      chart.remove()
      // 登记销毁：子组件的 cleanup 在本函数之后才跑（React 按父 → 子清理），
      // 它们要靠这个标记跳过 detachPrimitive，见 chartLifecycle.ts。
      // Mark it disposed: child cleanups run after this one (React cleans up
      // parent-first) and rely on this flag to skip detachPrimitive. See
      // chartLifecycle.ts.
      markChartDisposed(chart)
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

  // MA 均线：条数可变（用户可在设置弹窗里逐条加/删），条数变化时整体拆掉重建
  // （同一 pane 内，不涉及 pane 下标管理，比副图的动态增删简单）；只是编辑
  // 已有条目的周期/颜色或开关时不重建，只更新 visible/color 并重算数值。
  // 这个 effect 在挂载时也会跑一次（此时 maSeriesRef.current 是空数组，长度
  // 必然不等于设置里的条数），天然完成初始创建，不需要在建图 effect 里重复。
  // MA lines: variable count (the user can add/remove lines one at a time in
  // the settings modal); a count change tears down and rebuilds the whole set
  // (simpler than the sub-panes' dynamic add/remove since this stays within
  // the same pane — no pane-index bookkeeping involved). Editing an existing
  // line's period/color, or just toggling on/off, doesn't rebuild — only
  // updates visible/color and recomputes the values. This effect also runs
  // once on mount (maSeriesRef.current starts empty, so its length never
  // matches the settings' line count), naturally handling initial creation
  // without duplicating it in the chart-build effect.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const want = indicatorSettings.ma.periods.length
    if (maSeriesRef.current.length !== want) {
      maSeriesRef.current.forEach((s) => chart.removeSeries(s))
      maSeriesRef.current = indicatorSettings.ma.periods.map((_, i) =>
        chart.addSeries(LineSeries, {
          color: indicatorSettings.ma.colors[i],
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          visible: indicators.ma,
        })
      )
    } else {
      maSeriesRef.current.forEach((s, i) => s.applyOptions({ visible: indicators.ma, color: indicatorSettings.ma.colors[i] }))
    }
    recomputeIndicators()
  }, [indicators.ma, indicatorSettings.ma, recomputeIndicators])

  // EMA：与上面 MA 的处理完全一致，只是换一套 ref/设置 / EMA: identical handling to MA above, just a different ref/settings pair
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const want = indicatorSettings.ema.periods.length
    if (emaSeriesRef.current.length !== want) {
      emaSeriesRef.current.forEach((s) => chart.removeSeries(s))
      emaSeriesRef.current = indicatorSettings.ema.periods.map((_, i) =>
        chart.addSeries(LineSeries, {
          color: indicatorSettings.ema.colors[i],
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          visible: indicators.ema,
        })
      )
    } else {
      emaSeriesRef.current.forEach((s, i) => s.applyOptions({ visible: indicators.ema, color: indicatorSettings.ema.colors[i] }))
    }
    recomputeIndicators()
  }, [indicators.ema, indicatorSettings.ema, recomputeIndicators])

  // 布林带可见性 + 颜色同步：固定 3 条线（中/上/下轨），形状不像 MA/EMA 那样
  // 可变，不需要重建逻辑。/ Sync Bollinger visibility + color: a fixed shape
  // (mid/upper/lower), unlike MA/EMA it's never variable-length, so no
  // rebuild logic is needed.
  useEffect(() => {
    if (!bollSeriesRef.current) return
    const c = indicatorSettings.boll.color
    bollSeriesRef.current.mid.applyOptions({ visible: indicators.boll, color: c })
    bollSeriesRef.current.upper.applyOptions({ visible: indicators.boll, color: c })
    bollSeriesRef.current.lower.applyOptions({ visible: indicators.boll, color: c })
  }, [indicators.boll, indicatorSettings.boll.color])

  // RSI 参考线价位同步：overbought/oversold 可客制化，改动时更新已存在的两条
  // 价格线，不需要重建整条 series。/ Sync RSI reference-line prices:
  // overbought/oversold are customizable; update the two existing price
  // lines on change without rebuilding the whole series.
  useEffect(() => {
    if (!rsiSeriesRef.current) return
    rsiSeriesRef.current.obLine.applyOptions({ price: indicatorSettings.rsi.overbought, title: String(indicatorSettings.rsi.overbought) })
    rsiSeriesRef.current.osLine.applyOptions({ price: indicatorSettings.rsi.oversold, title: String(indicatorSettings.rsi.oversold) })
    rsiSeriesRef.current.series.applyOptions({ color: indicatorSettings.rsi.color })
  }, [indicatorSettings.rsi.overbought, indicatorSettings.rsi.oversold, indicatorSettings.rsi.color])

  // MACD 线条颜色同步 / sync MACD line colors
  useEffect(() => {
    if (!macdSeriesRef.current) return
    macdSeriesRef.current.macd.applyOptions({ color: indicatorSettings.macd.macdColor })
    macdSeriesRef.current.signal.applyOptions({ color: indicatorSettings.macd.signalColor })
  }, [indicatorSettings.macd.macdColor, indicatorSettings.macd.signalColor])

  // 任何会影响数值本身的参数变化（周期、布林带倍数、成交量涨跌配色等）都要
  // 重新计算——直接依赖整个 indicatorSettings 对象最简单：多算几遍主图叠加
  // 指标的开销可忽略，换来不必逐字段精确列依赖的简单性。
  // Any change that affects the values themselves (periods, Bollinger
  // multiplier, volume up/down colors, etc.) needs a recompute — depending on
  // the whole indicatorSettings object is simplest: the extra cost of
  // recomputing the always-present main-pane overlays a few more times is
  // negligible, in exchange for not having to list every field individually.
  useEffect(() => {
    recomputeIndicators()
  }, [indicatorSettings, recomputeIndicators])

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
    const s = indicatorSettingsRef.current

    if (volumeSeriesRef.current) {
      chart.removeSeries(volumeSeriesRef.current)
      volumeSeriesRef.current = null
    }
    if (rsiSeriesRef.current) {
      chart.removeSeries(rsiSeriesRef.current.series)
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
      const line = chart.addSeries(
        LineSeries,
        { color: s.rsi.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
        chart.panes().length
      )
      // 超买/超卖参考线（价位可客制化，见上方同步 effect）/ overbought/oversold reference lines (customizable price, see the sync effect above)
      const obLine = line.createPriceLine({
        price: s.rsi.overbought,
        color: 'rgba(148,163,184,0.5)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: String(s.rsi.overbought),
      })
      const osLine = line.createPriceLine({
        price: s.rsi.oversold,
        color: 'rgba(148,163,184,0.5)',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: String(s.rsi.oversold),
      })
      rsiSeriesRef.current = { series: line, obLine, osLine }
    }
    if (indicators.macd) {
      const paneIndex = chart.panes().length
      const hist = chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, paneIndex)
      const macdLine = chart.addSeries(
        LineSeries,
        { color: s.macd.macdColor, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
        paneIndex
      )
      const signal = chart.addSeries(
        LineSeries,
        { color: s.macd.signalColor, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false },
        paneIndex
      )
      macdSeriesRef.current = { macd: macdLine, signal, hist }
    }

    applyPaneHeights()
    recomputeIndicators()
  }, [indicators.volume, indicators.rsi, indicators.macd, applyPaneHeights, recomputeIndicators])

  // 手机端切回"图表"视图时强制重绘：容器此前是 display:none（尺寸为 0），
  // 恢复显示后 ResizeObserver 一般会触发，但个别浏览器不稳，这里主动补一次
  // resize，确保图表填满、不残留 300×150 默认位图。桌面（lg+）此状态恒为
  // 'chart'，effect 只在挂载时跑一次，无副作用。
  // Force a repaint when returning to the "chart" view on mobile: the container
  // was display:none (zero size), and while the ResizeObserver usually fires on
  // reveal, some browsers are flaky — so proactively resize once to ensure the
  // chart fills and doesn't keep the 300×150 default bitmap. At lg+ this stays
  // 'chart', so the effect runs once on mount with no side effect.
  useEffect(() => {
    const el = containerRef.current
    const chart = chartRef.current
    if (!el || !chart) return
    const raf = requestAnimationFrame(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        chart.resize(el.clientWidth, el.clientHeight, true)
        applyPaneHeights()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [refitKey, applyPaneHeights])

  return {
    chartRef, seriesRef, candlesRef, lastTimeRef, barTimesRef, getBarTimes,
    loadingOlderRef, hasMoreHistoryRef, isFollowingLiveRef,
    legend, paneOffsets, drawReady,
    recomputeIndicators, applyPaneHeights,
  }
}

export type ChartEngine = ReturnType<typeof useChartEngine>
