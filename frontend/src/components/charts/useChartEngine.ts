// 图表引擎：lightweight-charts 实例、主图/副图指标 series 的建与拆、指标重算、
// pane 高度分配、图例数据。它持有所有 ref，页面与数据 hook 通过返回值使用。
// 2026-09-06 从 pages/ChartsPage.tsx 搬出。2026-09-08 指标层泛化：不再为每个指标
// 写一套 ref / effect，而是按 indicatorCatalog 的描述统一建 series、算数值、读图例
// ——主图叠加按目录逐个对账（条数变了才重建，否则只改选项），副图按开关顺序
// 整体拆掉重建（移除后空 pane 会被库自动删除，追加时用 panes().length 当下标）。
// Chart engine: the lightweight-charts instance, indicator series lifecycle,
// recompute, pane heights and legend data. Moved out of ChartsPage 2026-09-06.
// 2026-09-08 the indicator layer was generalized over indicatorCatalog: one
// reconcile pass for main-pane overlays (rebuild only when the series count
// changes, otherwise applyOptions), and a tear-down/rebuild pass for sub-panes
// in catalog order (removing series auto-deletes empty panes; new ones append
// at panes().length).
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
  type LineWidth,
} from 'lightweight-charts'
import type { Candle } from '../../api/types'
import { fmtChartTime, toLinePoints } from '../../utils/chartSeries'
import type { IndicatorSettings } from './indicatorSettings'
import {
  MAIN_IDS, SUB_IDS, PANE_SIZE_WEIGHT, computeIndicator, lineStyleOf, refLines, seriesSpecs,
  type IndicatorId, type SeriesSpec,
} from './indicatorCatalog'
import { markChartDisposed } from './chartLifecycle'
import { DOWN_COLOR, EMPTY_LEGEND, UP_COLOR, toHistPoints, type IndicatorFlags, type LegendValues } from './chartConfig'

type LineApi = ISeriesApi<'Line'>
type HistApi = ISeriesApi<'Histogram'>
interface Handle { spec: SeriesSpec; api: LineApi | HistApi }
interface SubEntry { handles: Handle[]; refLines: IPriceLine[] }

// 线型 series 的选项：颜色 / 线宽 / 虚实来自指标设置，SAR 走「只画点不画线」。
// crosshairMarkerVisible:false 去掉十字准线悬停时每条线上的圆点（用户反馈是噪音）。
// Line-series options from the indicator settings; SAR draws points only.
// crosshairMarkerVisible:false removes the per-line hover dots (user feedback: noise).
function lineOptions(spec: SeriesSpec, st: { width: number; dash: 'solid' | 'dashed' }, visible: boolean) {
  return {
    color: spec.color,
    lineWidth: st.width as LineWidth,
    lineStyle: spec.dashed || st.dash === 'dashed' ? LineStyle.Dashed : LineStyle.Solid,
    priceLineVisible: false,
    lastValueVisible: false,
    crosshairMarkerVisible: false,
    visible,
    ...(spec.kind === 'points' ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.8 } : { lineVisible: true, pointMarkersVisible: false }),
  }
}

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
  const lastTimeRef = useRef<number>(0)
  // 当前品种/周期的全部 K 线时间（升序），供画图层把非本周期锚点的时间插值成
  // 屏幕坐标（画线按品种保存、需跨周期显示）。/ ascending bar times of the current
  // symbol+interval, used by the draw layer to interpolate an anchor's time to
  // an x coordinate across intervals (drawings are saved per symbol).
  const barTimesRef = useRef<number[]>([])
  const getBarTimes = useCallback(() => barTimesRef.current, [])
  // 往左翻页的状态。用 ref 而非 state：可视范围回调触发得非常频繁（拖动期间每帧
  // 都可能触发），用 state 会让每次滚动都重渲染整个图表页。
  // Paging state as refs: the visible-range callback fires every frame while
  // dragging; state would re-render the whole page on every scroll.
  const loadingOlderRef = useRef(false)
  const hasMoreHistoryRef = useRef(true)
  // 用户当前是否在跟踪实时行情（可视范围右边缘在最新 bar 附近）。
  // Whether the user is following live data (right edge near the latest bar).
  const isFollowingLiveRef = useRef(true)

  // 当前品种/周期的完整 OHLCV 历史（升序），指标计算的唯一数据来源。
  // Full ascending OHLCV history for the current symbol+interval — the sole
  // data source for indicator math.
  const candlesRef = useRef<Candle[]>([])

  // 主图叠加 series：按指标存一组句柄，常驻，开关只切 visible。
  // 副图 series：只在开启时存在，关闭即移除（隐藏不会让 pane 消失，会留一条空轴）。
  // Main-pane overlays: one handle list per indicator, permanent, toggles flip
  // visible. Sub-panes: exist only while enabled (hiding would leave an empty axis).
  const mainRef = useRef<Partial<Record<IndicatorId, Handle[]>>>({})
  const subRef = useRef<Partial<Record<IndicatorId, SubEntry>>>({})

  // 图例的"最新值"缓存：不悬停十字准线时用这份兜底。
  // Cached "latest value" legend used while the crosshair isn't hovering.
  const latestLegendRef = useRef<LegendValues>(EMPTY_LEGEND)
  // 当前是否正悬停/触摸拖动十字准线（由 onCrosshairMove 维护）。每 2 秒一次的报价
  // 轮询会调用 recomputeIndicators()，若它无条件 setLegend(latest)，会把用户正悬停
  // 的历史值每 2 秒打回"最新值"——所以只在不悬停时更新图例。
  // Whether the crosshair is hovering. The 2s quote poll calls
  // recomputeIndicators(); an unconditional setLegend there would stomp the
  // hovered value every 2s, so the legend only updates while not hovering.
  const hoveringRef = useRef(false)

  const [legend, setLegend] = useState<LegendValues>(EMPTY_LEGEND)
  // 各已开启副图 pane 的顶部像素偏移，供图例定位；由 applyPaneHeights 算出。
  // Top pixel offset of each enabled sub-pane, for legend positioning.
  const [paneOffsets, setPaneOffsets] = useState<Partial<Record<IndicatorId, number>>>({})

  // 画图层就绪标记：图表实例建好后再挂载 DrawLayer / mount DrawLayer once the chart is built
  const [drawReady, setDrawReady] = useState(false)

  const indicatorSettingsRef = useRef(indicatorSettings)
  useEffect(() => {
    indicatorSettingsRef.current = indicatorSettings
  }, [indicatorSettings])

  // 按当前 candlesRef 重算全部有 series 的指标并写回，同时刷新"最新值"图例缓存。
  // 空依赖保持函数引用稳定（只读 ref），从任何 effect / 定时器闭包调用都不会陈旧。
  // 主图叠加常驻所以不论开关都照算（几百个点的数组运算，可忽略），打开开关那一刻
  // 数据已经是对的；副图只在开启时有句柄，天然跳过。
  // Recompute every indicator that has series and refresh the latest-value
  // legend. Empty deps keep the identity stable (refs only). Main overlays are
  // permanent so they're computed regardless of toggle (negligible cost) and are
  // correct the moment a toggle flips; sub-panes only have handles while on.
  const recomputeIndicators = useCallback(() => {
    const bars = candlesRef.current
    if (bars.length === 0) return
    const times = bars.map((b) => b.t as UTCTimestamp)
    const s = indicatorSettingsRef.current
    const next: LegendValues = {}
    const feed = (id: IndicatorId, handles: Handle[]) => {
      const out = computeIndicator(id, bars, s)
      const row: Record<string, number | null> = {}
      for (const h of handles) {
        const values = out[h.spec.key] ?? []
        if (h.spec.kind === 'hist') {
          const api = h.api as HistApi
          if (h.spec.histColor === 'candle') {
            const up = (s[id] as { upColor?: string }).upColor ?? UP_COLOR
            const down = (s[id] as { downColor?: string }).downColor ?? DOWN_COLOR
            api.setData(bars.map((b, i) => ({ time: times[i], value: values[i] ?? 0, color: b.c >= b.o ? up : down })))
          } else {
            api.setData(toHistPoints(times, values, UP_COLOR, DOWN_COLOR))
          }
        } else {
          (h.api as LineApi).setData(toLinePoints(times, values))
        }
        row[h.spec.key] = values[values.length - 1] ?? null
      }
      next[id] = row
    }
    for (const id of MAIN_IDS) {
      const handles = mainRef.current[id]
      if (handles) feed(id, handles)
    }
    for (const id of SUB_IDS) {
      const entry = subRef.current[id]
      if (entry) feed(id, entry.handles)
    }
    latestLegendRef.current = next
    if (!hoveringRef.current) setLegend(next)
  }, [])

  // 按容器高度重新分配各 pane：主图至少 40%，副图按各自的高度档（小 / 中 / 大）
  // 加权分剩余部分，每个不低于 60px；同时记下每个副图的顶部偏移供图例定位
  // （副图顺序 = 目录顺序，与创建顺序一致）。resize、开关、改高度档都会调用。
  // Redistribute pane heights: main pane ≥ 40%, sub-panes split the rest by
  // their size weight (sm/md/lg), each ≥ 60px; records each sub-pane's top
  // offset for its legend (order = catalog order = creation order).
  const applyPaneHeights = useCallback(() => {
    const chart = chartRef.current
    const host = containerRef.current
    if (!chart || !host) return
    const panes = chart.panes()
    const total = host.clientHeight
    const enabled = SUB_IDS.filter((id) => subRef.current[id])
    if (panes.length <= 1 || total <= 0 || enabled.length === 0) {
      setPaneOffsets({})
      return
    }
    const s = indicatorSettingsRef.current
    const weights = enabled.map((id) => PANE_SIZE_WEIGHT[(s[id] as { size?: 'sm' | 'md' | 'lg' }).size ?? 'md'])
    const wsum = weights.reduce((a, b) => a + b, 0)
    // 副图总占比随数量增长但封顶 60%，再按权重分；单个至少 60px。
    // Sub-pane share grows with count, capped at 60%; then split by weight, ≥ 60px each.
    const share = Math.min(0.6, 0.2 + 0.1 * enabled.length)
    const subTotal = Math.max(total * share, enabled.length * 60)
    const mainHeight = Math.max(total - subTotal, total * 0.4)
    const avail = total - mainHeight
    panes[0].setHeight(Math.floor(mainHeight))
    let offset = Math.floor(mainHeight)
    const offsets: Partial<Record<IndicatorId, number>> = {}
    enabled.forEach((id, i) => {
      const h = Math.max(60, Math.floor((avail * weights[i]) / wsum))
      panes[i + 1]?.setHeight(h)
      offsets[id] = offset
      offset += h
    })
    setPaneOffsets(offsets)
  }, [])

  // 建图（只建一次），容器尺寸变化时自适配 / build the chart once; auto-sizes with the container
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: 'rgba(10, 7, 16, 1)' },
        textColor: '#94a3b8',
        // 关闭库自带的 TradingView 署名 logo；Apache-2.0 许可要求的署名改用免责声明旁的
        // 文字链接满足。/ Attribution handled by the text link next to the disclaimer.
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
        // 最新 K 线右侧预留空白，便于把趋势线 / 斐波那契画到未来区域。
        // Whitespace right of the latest candle so drawings can extend into the future.
        rightOffset: 8,
        tickMarkFormatter: fmtChartTime,
      },
      // 悬停时间与刻度必须用同一个格式化函数，否则悬停时间掉回浏览器本地时区。
      // Hover time and axis ticks must share one formatter or they disagree on timezone.
      localization: { timeFormatter: fmtChartTime },
      crosshair: { mode: 0 },
      // 移动端纵向滑动穿透到页面滚动，保留横向拖动平移图表
      handleScroll: { vertTouchDrag: false, horzTouchDrag: true, mouseWheel: true },
      width: el.clientWidth,
      height: el.clientHeight,
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
      borderVisible: false,
    })
    chartRef.current = chart
    seriesRef.current = series
    setDrawReady(true)

    // 十字准线/触摸拖动 → 图例：param.time 有值表示落在数据区内，用 seriesData 查各
    // series 当时的值；undefined 表示移出，回退到缓存的"最新值"。
    // Crosshair / touch drag → legend from param.seriesData; leaving falls back
    // to the cached latest values.
    const onCrosshairMove: Parameters<typeof chart.subscribeCrosshairMove>[0] = (param) => {
      if (param.time == null) {
        hoveringRef.current = false
        setLegend(latestLegendRef.current)
        return
      }
      hoveringRef.current = true
      const read = (api: LineApi | HistApi): number | null => {
        const d = param.seriesData.get(api) as { value?: number } | undefined
        return d?.value ?? null
      }
      const next: LegendValues = {}
      const collect = (id: IndicatorId, handles: Handle[]) => {
        const row: Record<string, number | null> = {}
        for (const h of handles) row[h.spec.key] = read(h.api)
        next[id] = row
      }
      for (const id of MAIN_IDS) { const h = mainRef.current[id]; if (h) collect(id, h) }
      for (const id of SUB_IDS) { const e = subRef.current[id]; if (e) collect(id, e.handles) }
      setLegend(next)
    }
    chart.subscribeCrosshairMove(onCrosshairMove)

    // 自适配容器尺寸：手动管理而不是用 autoSize，部分渲染环境下其内部 ResizeObserver
    // 不会触发重绘（canvas 卡在 300x150）。/ Explicit resize() is more reliable than autoSize.
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
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
      // 登记销毁：子组件的 cleanup 在本函数之后才跑，它们要靠这个标记跳过 detachPrimitive。
      // Mark disposed so child cleanups (run after this) skip detachPrimitive.
      markChartDisposed(chart)
      chartRef.current = null
      seriesRef.current = null
      mainRef.current = {}
      subRef.current = {}
      setDrawReady(false)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- build the chart once; applyPaneHeights is stable (empty deps)
  }, [])

  // 主图叠加对账：每个指标按目录算出应有的 series 列表，条数 / 类型变了（均线加减）
  // 就整组拆掉重建，否则只 applyOptions（可见、颜色、线宽、线型）。挂载时句柄为空，
  // 天然完成初始创建。/ Reconcile main-pane overlays: rebuild an indicator's set
  // only when its series count/kinds change (line lists grow/shrink), otherwise
  // applyOptions. The first run creates everything.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    for (const id of MAIN_IDS) {
      const specs = seriesSpecs(id, indicatorSettings)
      const st = lineStyleOf(id, indicatorSettings)
      const existing = mainRef.current[id]
      const same = existing && existing.length === specs.length && existing.every((h, i) => h.spec.kind === specs[i].kind)
      if (!same) {
        existing?.forEach((h) => chart.removeSeries(h.api))
        mainRef.current[id] = specs.map((spec) => ({ spec, api: chart.addSeries(LineSeries, lineOptions(spec, st, indicators[id])) }))
      } else {
        existing.forEach((h, i) => { h.spec = specs[i]; (h.api as LineApi).applyOptions(lineOptions(specs[i], st, indicators[id])) })
      }
    }
    recomputeIndicators()
  }, [indicators, indicatorSettings, recomputeIndicators])

  // 副图开关：先整体拆掉旧的副图 series（移除后空 pane 会被库自动删除），再按目录
  // 顺序重建已开启的，用 chart.panes().length 作为新 pane 的下标保证总是追加在最后。
  // Sub-pane toggles: tear down all sub series (empty panes auto-delete), then
  // recreate the enabled ones in catalog order at panes().length.
  const subKey = SUB_IDS.map((id) => (indicators[id] ? id : '')).join(',')
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    const s = indicatorSettingsRef.current
    for (const id of SUB_IDS) {
      const e = subRef.current[id]
      if (!e) continue
      e.handles.forEach((h) => chart.removeSeries(h.api))
      delete subRef.current[id]
    }
    for (const id of SUB_IDS) {
      if (!indicators[id]) continue
      const paneIndex = chart.panes().length
      const st = lineStyleOf(id, s)
      const handles: Handle[] = seriesSpecs(id, s).map((spec) => ({
        spec,
        api: spec.kind === 'hist'
          ? chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false, ...(id === 'volume' ? { priceFormat: { type: 'volume' as const } } : {}) }, paneIndex)
          : chart.addSeries(LineSeries, lineOptions(spec, st, true), paneIndex),
      }))
      // 参考线（超买超卖 / ±100 / 80·20）挂在第一条线上，价位可客制化时由下方同步 effect 重建。
      // Reference lines hang off the first line series; rebuilt by the sync effect when levels change.
      const firstLine = handles.find((h) => h.spec.kind === 'line')?.api as LineApi | undefined
      const lines = firstLine ? refLines(id, s).map((r) => firstLine.createPriceLine({
        price: r.value, color: 'rgba(148,163,184,0.5)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: r.label,
      })) : []
      subRef.current[id] = { handles, refLines: lines }
    }
    applyPaneHeights()
    recomputeIndicators()
  // eslint-disable-next-line react-hooks/exhaustive-deps -- subKey encodes exactly the toggles that matter
  }, [subKey, applyPaneHeights, recomputeIndicators])

  // 参数 / 样式变化：副图 series 的选项与参考线同步、高度档重排、数值重算。
  // 主图叠加的选项在上面的对账 effect 里已经同步过。
  // Settings changes: sync sub-pane options and reference lines, redistribute
  // heights, recompute values. Main overlays were synced by the reconcile effect.
  useEffect(() => {
    const s = indicatorSettings
    for (const id of SUB_IDS) {
      const e = subRef.current[id]
      if (!e) continue
      const st = lineStyleOf(id, s)
      const specs = seriesSpecs(id, s)
      e.handles.forEach((h, i) => {
        const spec = specs[i] ?? h.spec
        h.spec = spec
        if (spec.kind !== 'hist') (h.api as LineApi).applyOptions(lineOptions(spec, st, true))
      })
      const firstLine = e.handles.find((h) => h.spec.kind === 'line')?.api as LineApi | undefined
      if (firstLine) {
        e.refLines.forEach((pl) => firstLine.removePriceLine(pl))
        e.refLines = refLines(id, s).map((r) => firstLine.createPriceLine({
          price: r.value, color: 'rgba(148,163,184,0.5)', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: r.label,
        }))
      }
    }
    applyPaneHeights()
    recomputeIndicators()
  }, [indicatorSettings, applyPaneHeights, recomputeIndicators])

  // refitKey 变化（进出全屏）时补一次 resize，确保图表填满、不残留默认位图。
  // On refitKey change (fullscreen in/out) resize once so the chart fills.
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
