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
//
// 2026-09-06 拆分：常量与纯函数在 components/charts/chartConfig.ts，图表实例与
// 指标 series 在 useChartEngine，历史/轮询在 useChartData，全屏在 useChartFullscreen。
// 2026-09-08 外壳重做（样式见 styles/terminal.css 头注）：桌面「一块地三条发丝线」
// 撑满顶栏以下整个视口；手机端不再是顶部四页签切换，而是图表占满 + 底部固定
// 「卖 | 点差 | 买」交易条，自选 / 下单票 / 持仓都是底部抽屉。图表容器始终挂载
// ——抽屉只是盖在上面，绝不卸载图表（否则会丢掉 lightweight-charts 实例与画线）。
// Split 2026-09-06 (config → chartConfig, chart instance → useChartEngine,
// history/poll → useChartData, fullscreen → useChartFullscreen). Shell redone
// 2026-09-08 (see the header comment in styles/terminal.css): on desktop one
// ground with three hairlines filling the viewport below the header; on mobile
// the chart fills the screen with a fixed sell | spread | buy bar, and the
// watchlist / ticket / positions open as bottom sheets. The chart container is
// always mounted — sheets overlay it, never unmount it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { usePrefs } from '../store/prefs'
import { useLive, useQuotes } from '../store/live'
import { useOrderPlacement, toastToneClass } from '../components/signals/hooks'
import { useBackToClose } from '../utils/useBackToClose'
import { useLastAccount } from '../utils/useLastAccount'
import {
  DEFAULT_INDICATOR_SETTINGS,
  mergeIndicatorSettings,
  type IndicatorSettings,
} from '../components/charts/indicatorSettings'
import DrawLayer, { type DrawLayerHandle } from '../components/charts/DrawLayer'
import IndicatorSettingsModal from '../components/charts/IndicatorSettingsModal'
import SymbolHeader from '../components/charts/SymbolHeader'
import WatchlistPanel from '../components/charts/WatchlistPanel'
import AccountSummary from '../components/charts/AccountSummary'
import OrderTicket from '../components/charts/OrderTicket'
import PositionsDock from '../components/charts/PositionsDock'
import PositionOverlay from '../components/charts/PositionOverlay'
import DrawToolsRow from '../components/charts/DrawToolsRow'
import PositionMarkerToggle from '../components/charts/PositionMarkerToggle'
import IntervalSeg from '../components/charts/IntervalSeg'
import IndicatorLegends from '../components/charts/IndicatorLegends'
import FullscreenToolbar from '../components/charts/FullscreenToolbar'
import { useChartFullscreen } from '../components/charts/useChartFullscreen'
import { useChartEngine } from '../components/charts/useChartEngine'
import { useChartData } from '../components/charts/useChartData'
import { useGlobalQuotes, usePositions } from '../store/live'
import type { Side } from '../components/order/useOrderForm'
import {
  DEFAULT_INDICATORS, INTERVAL_KEY, SYMBOL_DECIMALS, SYMBOL_KEY, type IndicatorFlags,
} from '../components/charts/chartConfig'

// IndicatorFlags 原本定义在这里，IndicatorSettingsModal 等按老路径引用；保留再导出。
// IndicatorFlags used to be defined here; re-exported so old import paths keep working.
export type { IndicatorFlags }

type Sheet = 'watchlist' | 'trade' | 'positions' | null

export default function ChartsPage() {
  const { t } = useTranslation()
  const { getPref, setPref, loaded } = usePrefs()
  const containerRef = useRef<HTMLDivElement>(null)
  const drawLayerRef = useRef<DrawLayerHandle>(null)

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
  // 指标开关 + 参数：都跟随用户走，云端同步（见下方持久化 effect），与
  // 品种/周期无关。/ Indicator toggles + settings: follow the user, cloud
  // synced (see the persistence effects below); independent of symbol/interval.
  const [indicators, setIndicatorsState] = useState<IndicatorFlags>(
    () => ({ ...DEFAULT_INDICATORS, ...getPref<Partial<IndicatorFlags>>('charts', 'indicators', {}) })
  )
  const [indicatorSettings, setIndicatorSettingsState] = useState<IndicatorSettings>(() =>
    mergeIndicatorSettings(DEFAULT_INDICATOR_SETTINGS, getPref<Partial<IndicatorSettings>>('charts', 'indicatorSettings', {}))
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [drawVersion, setDrawVersion] = useState(0)
  const bumpDraw = useCallback(() => setDrawVersion((v) => v + 1), [])
  // 持仓标记显隐：跟随用户走、云端同步（与指标开关同一套持久化模式）。默认开，
  // 有单时直接看得到入场/止损/止盈，不需要先去翻某个开关。
  // Position-marker visibility: follows the user, cloud synced (same persistence
  // pattern as the indicator toggles). On by default so an open position's
  // entry/SL/TP show up without hunting for a toggle first.
  const [showPositions, setShowPositions] = useState<boolean>(
    () => getPref<boolean>('charts', 'showPositions', true)
  )

  // 手机端抽屉：自选 / 下单票 / 持仓，一次只开一个；tradeSide 记住从交易条的哪一侧
  // 点进来。桌面（lg+）三栏常驻，抽屉不渲染（CSS 里 ≥1024 直接 display:none）。
  // Mobile sheets: watchlist / ticket / positions, one at a time; tradeSide
  // remembers which side of the trade bar opened the ticket. Desktop shows the
  // three columns and the sheets are display:none at ≥1024.
  const [sheet, setSheet] = useState<Sheet>(null)
  const [tradeSide, setTradeSide] = useState<Side>('BUY')
  // 手机端画线工具是否展开：默认收起（只留周期 + 持仓 + 画笔 + 指标），点画笔才展开
  // 换行工具行，避免小屏被十几个小图标塞满。
  // Mobile draw tools start collapsed and expand into the wrapping row on tap.
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false)

  // 这些都是覆盖层，手机上划返回应该先关掉它们、而不是直接退出图表页
  // （见 useBackToClose 的说明）。/ All overlays: swiping back on mobile should
  // close them first rather than leaving the page (see useBackToClose).
  useBackToClose(settingsOpen, () => setSettingsOpen(false))
  useBackToClose(sheet != null, () => setSheet(null))

  // 手机端全屏模式（CSS 全屏 + 原生 Fullscreen API + 横屏锁定）与全屏工具栏拖动
  // Mobile fullscreen + floating toolbar drag: see useChartFullscreen
  const {
    isFullscreen, enterFullscreen, exitFullscreen,
    fsToolbarRef, fsToolbarPos, onFsToolbarPointerDown, onFsToolbarPointerMove, onFsToolbarPointerUp,
  } = useChartFullscreen(containerRef)

  const { accounts, activeSymbols, orders } = useLive()
  const accountQuotes = useQuotes()
  const globalQuotes = useGlobalQuotes()
  const positions = usePositions()
  const { toast, placeManualOrder, showToast } = useOrderPlacement()

  // 每个品种的价格轴小数位（与图表 series 精度一致），供自选列表/报价条统一取用。
  // Per-symbol price precision (matches the chart series), shared by the
  // watchlist and quote strip.
  const digitsFor = useCallback((s: string) => SYMBOL_DECIMALS[s] ?? 2, [])

  // 当前品种的全站统一报价（EA 推送，含 bid/ask）；报价条与下单价用它。
  // The active symbol's site-wide quote (EA-pushed, bid/ask); used by the
  // quote strip and the ticket's price.
  const activeQuote = symbol ? globalQuotes[symbol] : undefined

  // 右栏账户条展示的账户：优先在线账号，否则第一个绑定的。
  // Account shown in the right-rail strip: prefer an online one, else the first bound.
  const primaryAccount = accounts.find((a) => a.online) ?? accounts[0] ?? null

  // 当前选中的交易账户（login）——由下单票的账户下拉驱动，提升到这里让账户条、
  // 底部持仓/挂单都跟着切换，而不是永远只显示第一个账户。空串表示还没手动选，
  // 走 primaryAccount 兜底。/ Currently selected trading account (login), driven by
  // the ticket's account picker and lifted here so the account strip and the
  // positions/orders dock all follow the selection instead of being stuck on the
  // first account. Empty string means no manual pick yet — falls back to primary.
  const [selectedLogin, setSelectedLogin] = useState<string>('')
  // 上次下单用过的账户。它不只喂给下单票——账户条、持仓/挂单都跟着 selectedLogin
  // 走，所以要在这一层就认，否则会出现「下单票显示记住的账户、账户条还显示兜底
  // 账户」这种自相矛盾的画面。
  // The remembered account is applied at this level, not just inside the ticket:
  // the account strip and positions/orders dock all follow selectedLogin, so
  // resolving it lower down would leave the panels disagreeing with the ticket.
  const { lastLogin } = useLastAccount()
  const effectiveLogin = selectedLogin || (accounts.some((a) => a.login === lastLogin) ? lastLogin : '')
  const activeAccount = accounts.find((a) => a.login === effectiveLogin) ?? primaryAccount

  // 选中账户不存在（账户列表变化）时，把选择重置回兜底账户。
  // Reset the pick to the fallback when the selected account disappears.
  useEffect(() => {
    if (selectedLogin && !accounts.some((a) => a.login === selectedLogin)) setSelectedLogin('')
  }, [accounts, selectedLogin])

  // 按选中账户过滤持仓/挂单：多账户时才过滤，单账户或数据没带 login 时照旧全展示，
  // 避免误伤。/ Filter positions/orders by the selected account — only when there
  // are multiple accounts; single-account or login-less data shows as-is.
  const multiAccount = accounts.length > 1
  const accountPositions = useMemo(
    () => (multiAccount && activeAccount ? positions.filter((p) => String(p.login ?? '') === String(activeAccount.login)) : positions),
    [multiAccount, activeAccount, positions],
  )
  const accountOrders = useMemo(
    () => (multiAccount && activeAccount ? orders.filter((o) => String(o.mt5Login ?? '') === String(activeAccount.login)) : orders),
    [multiAccount, activeAccount, orders],
  )

  // 云端偏好加载完成后覆盖本地初始值 / override initial values when cloud prefs arrive
  useEffect(() => {
    if (!loaded) return
    const cloudSym = getPref<string>('charts', 'symbol', '')
    if (cloudSym) setSymbol(cloudSym)
    const cloudInt = getPref<string>('charts', 'interval', '')
    if (cloudInt) setIntervalCode(cloudInt)
    const cloudInd = getPref<Partial<IndicatorFlags> | null>('charts', 'indicators', null)
    if (cloudInd) setIndicatorsState({ ...DEFAULT_INDICATORS, ...cloudInd })
    const cloudSettings = getPref<Partial<IndicatorSettings> | null>('charts', 'indicatorSettings', null)
    if (cloudSettings) setIndicatorSettingsState(mergeIndicatorSettings(DEFAULT_INDICATOR_SETTINGS, cloudSettings))
    const cloudShowPos = getPref<boolean | null>('charts', 'showPositions', null)
    if (cloudShowPos != null) setShowPositions(cloudShowPos)
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

  // 指标开关/参数落库：与 symbol/interval 同一套模式——setState 的更新函数
  // 只做纯粹的状态计算，落库放到单独的 effect 里对状态变化作出反应，绝不在
  // 更新函数内部直接调用 setPref（那是另一个组件 PrefsProvider 的
  // setState）。曾经的实现在更新函数里直接调 setPref，触发过 React 的
  // "Cannot update a component while rendering a different component" 警告，
  // 实测会导致开关状态被异常带乱（点一个开关，另外几个也跟着变了）。
  // Persist indicator toggles/settings the same way symbol/interval already
  // do: the setState updater only computes the next state; persisting
  // happens in its own effect. Never call setPref (another component's —
  // PrefsProvider's — setState) directly inside an updater function — an
  // earlier version of this code did exactly that and triggered React's
  // "Cannot update a component while rendering a different component"
  // warning, observed in testing to scramble the toggle state (clicking one
  // toggle also flipped others).
  useEffect(() => {
    setPref('charts', 'indicators', indicators)
  }, [indicators, setPref])

  useEffect(() => {
    setPref('charts', 'indicatorSettings', indicatorSettings)
  }, [indicatorSettings, setPref])

  useEffect(() => {
    setPref('charts', 'showPositions', showPositions)
  }, [showPositions, setPref])

  const toggleIndicator = useCallback((key: keyof IndicatorFlags) => {
    setIndicatorsState((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const resetIndicatorSettings = useCallback(() => {
    setIndicatorSettingsState(DEFAULT_INDICATOR_SETTINGS)
  }, [])

  // 图表实例、指标 series、图例、pane 高度 → useChartEngine；历史 / 翻页 / 轮询 → useChartData。
  // 图表现在从不被藏起，refitKey 只在进出全屏时变（那两次容器尺寸确实变了）。
  // Chart instance / indicator series / legend / panes → useChartEngine; history /
  // paging / polling → useChartData. The chart is never hidden any more, so the
  // refit key only changes on entering/leaving fullscreen (a real resize).
  const engine = useChartEngine(containerRef, indicators, indicatorSettings, isFullscreen)
  const { chartRef, seriesRef, getBarTimes, legend, paneOffsets, drawReady } = engine
  const { hasData, stale, lastPrice, dayStats } = useChartData(symbol, interval, engine)

  const decimals = SYMBOL_DECIMALS[symbol] ?? 2
  const px = (v: number | null | undefined) => (v != null ? v.toFixed(decimals) : lastPrice ? lastPrice.toFixed(decimals) : '—')
  const spreadPts = activeQuote && activeQuote.ask >= activeQuote.bid ? Math.round((activeQuote.ask - activeQuote.bid) * Math.pow(10, decimals)) : null
  const openTrade = (side: Side) => { setTradeSide(side); setSheet('trade') }

  const ticket = (initialSide?: Side) => (
    <OrderTicket
      key={initialSide ?? 'desk'}
      symbol={symbol}
      accounts={accounts}
      quotesByAccount={accountQuotes}
      globalQuote={activeQuote}
      refPrice={lastPrice}
      digits={decimals}
      selectedLogin={effectiveLogin}
      onSelectLogin={setSelectedLogin}
      initialSide={initialSide}
      onPlace={(side, volume, mt5Login, stopLoss, takeProfit, coid) =>
        placeManualOrder(symbol, side, volume, mt5Login, stopLoss, takeProfit, coid)
      }
    />
  )

  return (
    <div className="term-shell">
      {/* drawVersion 用于外部画线工具栏状态变更时强制 ChartsPage 重渲染 */}
      {void drawVersion}

      {/* 左栏：自选（桌面常驻；手机从报价条的品种名点开抽屉）
          Left column: watchlist (desktop; on mobile it opens as a sheet from the quote strip) */}
      <aside className="term-col term-col-left">
        <div className="term-ph"><h3>{t('charts.watchlist.title')}</h3><span>{activeSymbols.length}</span></div>
        <WatchlistPanel
          className="flex min-h-0 flex-1 flex-col"
          symbols={activeSymbols}
          quotes={globalQuotes}
          active={symbol}
          onSelect={setSymbol}
          digitsFor={digitsFor}
        />
      </aside>

      {/* 中栏：报价条 + [竖轨 | 工具条 / 图表] + 持仓停靠 / center: quote strip + [rail | toolbar / chart] + dock */}
      <section className="term-center">
        {!isFullscreen && (
          <SymbolHeader
            symbol={symbol}
            interval={interval}
            bid={activeQuote?.bid ?? null}
            ask={activeQuote?.ask ?? null}
            digits={decimals}
            dayStats={dayStats}
            fallbackPrice={lastPrice}
            stale={stale}
            onSymbolClick={() => setSheet('watchlist')}
          />
        )}

        <div className="term-cv">
          {/* 画线竖轨（桌面；全屏时换成悬浮工具栏）。引擎就绪前先占位，免得网格跳动。
              Draw rail (desktop; fullscreen uses the floating toolbar). A placeholder
              holds the column before the engine is ready so the grid doesn't jump. */}
          {!isFullscreen && (drawReady
            ? <DrawToolsRow variant="rail" drawLayerRef={drawLayerRef} bumpDraw={bumpDraw} t={t} />
            : <div className="term-rail" />)}

          {/* 工具条：周期钉左；右侧 持仓（手机）· 画笔（手机）· 持仓标记 · 添加指标
              Toolbar: intervals left; positions (mobile) · pen (mobile) · markers · indicators right */}
          {!isFullscreen && (
            <div className="term-tb">
              <IntervalSeg value={interval} onChange={setIntervalCode} />
              <div className="term-tbr">
                <button type="button" className="term-tbr-btn lg:hidden" onClick={() => setSheet('positions')}>
                  {t('charts.openPositions')} <b>{accountPositions.length}</b>
                </button>
                {drawReady && (
                  <button
                    type="button"
                    onClick={() => setMobileToolsOpen((v) => !v)}
                    aria-label={String(t('charts.draw.button'))}
                    aria-pressed={mobileToolsOpen}
                    className={`term-tool-btn lg:hidden ${mobileToolsOpen ? 'on' : ''}`}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                  </button>
                )}
                <PositionMarkerToggle on={showPositions} onToggle={() => setShowPositions((v) => !v)} t={t} />
                <button type="button" onClick={() => setSettingsOpen(true)} className="term-tbr-btn">
                  {t('charts.indicators.button')}
                </button>
              </div>
            </div>
          )}

          {/* 图表容器：无缝，填满网格剩余高度。/ Chart container: seamless, fills the grid. */}
          <div className={`term-chart ${isFullscreen ? 'chart-fullscreen-container' : ''}`}>
            {/* 全屏开关（仅手机端）：同一个按钮进出，进入自动横屏，退出恢复竖屏 */}
            <button
              type="button"
              onClick={isFullscreen ? exitFullscreen : enterFullscreen}
              aria-label={isFullscreen ? t('charts.fullscreen.exit') : t('charts.fullscreen.enter')}
              title={isFullscreen ? t('charts.fullscreen.exit') : t('charts.fullscreen.enter')}
              className="lg:hidden absolute top-2 right-2 z-30 flex h-7 w-7 items-center justify-center rounded-md border border-white/10 bg-ink-900/70 text-neutral-300 backdrop-blur-sm transition hover:text-white hover:border-white/20 active:scale-90"
            >
              {isFullscreen ? (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="10" y1="14" x2="3" y2="21" />
                </svg>
              ) : (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              )}
            </button>

            {/* 全屏态时间周期切换：右上角横排 */}
            {isFullscreen && <IntervalSeg variant="fullscreen" value={interval} onChange={setIntervalCode} />}

            <div ref={containerRef} className="h-full w-full" />
            {/* 持仓标记层：入场价/止损/止盈线 + 拖动改单。刻意排在画图层之前——两层
                都用「悬停到自己的目标才抢指针事件」的策略，DOM 上后者在上，于是画线
                操作天然优先于拖止损线，不会互相抢。/ Position markers: entry/SL/TP
                lines + drag-to-modify. Deliberately mounted before the draw layer:
                both only capture pointer events while hovering their own targets, and
                being later in the DOM puts the draw layer on top, so drawing
                naturally takes precedence over dragging an SL line. */}
            {drawReady && chartRef.current && seriesRef.current && (
              <PositionOverlay
                chart={chartRef.current}
                series={seriesRef.current}
                positions={accountPositions}
                symbol={symbol}
                digits={decimals}
                visible={showPositions}
                onToast={showToast}
              />
            )}
            {drawReady && chartRef.current && seriesRef.current && containerRef.current && (
              <DrawLayer
                ref={drawLayerRef}
                chart={chartRef.current}
                series={seriesRef.current}
                host={containerRef.current}
                symbol={symbol}
                lastPrice={lastPrice}
                barTimes={getBarTimes}
                digits={decimals}
              />
            )}
            {!hasData && <div className="term-chart-empty">{t('charts.empty')}</div>}

            {/* 指标图例（主图叠加 + 各副图）/ indicator legends (main-pane overlays + each sub-pane) */}
            <IndicatorLegends indicators={indicators} indicatorSettings={indicatorSettings} legend={legend} paneOffsets={paneOffsets} decimals={decimals} />

            {/* 全屏态悬浮画线工具栏（可拖移）*/}
            {isFullscreen && drawReady && (
              <FullscreenToolbar
                toolbarRef={fsToolbarRef}
                pos={fsToolbarPos}
                onPointerDown={onFsToolbarPointerDown}
                onPointerMove={onFsToolbarPointerMove}
                onPointerUp={onFsToolbarPointerUp}
                drawLayerRef={drawLayerRef}
                bumpDraw={bumpDraw}
                showPositions={showPositions}
                onTogglePositions={() => setShowPositions((v) => !v)}
              />
            )}
          </div>

          {/* 手机端展开的画线行 / mobile expanded draw row */}
          {!isFullscreen && drawReady && mobileToolsOpen && (
            <div className="lg:hidden term-tools-slot">
              <DrawToolsRow variant="wrap" drawLayerRef={drawLayerRef} bumpDraw={bumpDraw} t={t} />
            </div>
          )}
        </div>

        {/* 持仓 / 挂单停靠（桌面；手机走底部抽屉）/ positions dock (desktop; mobile uses the sheet) */}
        {!isFullscreen && (
          <div className="hidden lg:flex lg:flex-shrink-0 lg:flex-col">
            <PositionsDock positions={accountPositions} orders={accountOrders} digitsFor={digitsFor} onToast={showToast} />
          </div>
        )}

        {/* 手机端底部交易条：卖 | 点差 | 买，点开下单票抽屉
            Mobile trade bar: sell | spread | buy, opens the ticket sheet */}
        {!isFullscreen && (
          <div className="term-mbar">
            <button type="button" className="sell" onClick={() => openTrade('SELL')}>
              <span className="lab">{t('charts.ticket.sell')}</span>
              <span className="px"><PipText s={px(activeQuote?.bid)} /></span>
            </button>
            <div className="sp">{t('charts.ticket.spreadUnit')}<b>{spreadPts ?? '—'}</b></div>
            <button type="button" className="buy" onClick={() => openTrade('BUY')}>
              <span className="lab">{t('charts.ticket.buy')}</span>
              <span className="px"><PipText s={px(activeQuote?.ask)} /></span>
            </button>
          </div>
        )}
      </section>

      {/* 右栏：下单票 + 账户条（桌面常驻）。票占剩余高度并可内部滚动，账户条钉底。
          Right column: ticket + account strip (desktop). The ticket takes the
          remaining height and scrolls internally; the strip stays pinned at the bottom. */}
      <aside className="term-col term-col-right">
        <div className="term-ph"><h3>{t('charts.ticket.title')}</h3><span>{symbol || '—'}</span></div>
        {ticket()}
        <AccountSummary account={activeAccount} />
      </aside>

      {/* 手机端抽屉：走 portal 挂到 body——页面切换动画（.page-enter）会给 <main>
          造一个层叠上下文，抽屉留在里面的话 z-index 再高也压不过全站底栏（z-40）。
          Mobile sheets are portalled to body: the page-enter animation gives
          <main> its own stacking context, inside which no z-index beats the app
          tab bar (z-40). */}
      {sheet && !isFullscreen && createPortal(
        <>
          <div className="term-scrim" onClick={() => setSheet(null)} />
          <div className="term-sheet" role="dialog" aria-modal="true">
            <div className="term-ph">
              <h3>{sheet === 'watchlist' ? t('charts.watchlist.title') : sheet === 'trade' ? t('charts.sheetTicket') : t('charts.openPositions')}</h3>
              <span>{sheet === 'watchlist' ? activeSymbols.length : sheet === 'trade' ? `${symbol} · ${activeAccount ? `#${activeAccount.login}` : ''}` : accountPositions.length}</span>
            </div>
            <div className="term-sheet-body no-sb">
              {sheet === 'watchlist' && (
                <WatchlistPanel
                  className="flex min-h-0 flex-1 flex-col"
                  symbols={activeSymbols}
                  quotes={globalQuotes}
                  active={symbol}
                  onSelect={(s) => { setSymbol(s); setSheet(null) }}
                  digitsFor={digitsFor}
                />
              )}
              {sheet === 'trade' && (
                <>
                  {ticket(tradeSide)}
                  <AccountSummary account={activeAccount} />
                </>
              )}
              {sheet === 'positions' && (
                <PositionsDock positions={accountPositions} orders={accountOrders} digitsFor={digitsFor} onToast={showToast} />
              )}
            </div>
          </div>
        </>,
        document.body,
      )}

      {settingsOpen && (
        <IndicatorSettingsModal
          indicators={indicators}
          onToggle={toggleIndicator}
          settings={indicatorSettings}
          onChange={setIndicatorSettingsState}
          onReset={resetIndicatorSettings}
          onClose={() => setSettingsOpen(false)}
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

// 价格末两位加粗（点位）/ bold the last two digits (the pips)
function PipText({ s }: { s: string }) {
  if (s.length < 3 || s === '—') return <>{s}</>
  return <>{s.slice(0, -2)}<b>{s.slice(-2)}</b></>
}
