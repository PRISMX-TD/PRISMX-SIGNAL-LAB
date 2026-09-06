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
// 2026-09-06 拆分：这个文件原来 2222 行。常量与纯函数在 components/charts/chartConfig.ts，
// 图表实例与指标 series 在 useChartEngine，历史/轮询在 useChartData，全屏在
// useChartFullscreen，工具行 / 图例 / 全屏工具栏 / 周期按钮各自成组件。这里只剩
// 用户偏好、账户选择与布局。
// Split 2026-09-06 (was 2222 lines): constants → chartConfig, chart instance and
// indicator series → useChartEngine, history/poll → useChartData, fullscreen →
// useChartFullscreen, toolbar rows / legends / fullscreen toolbar / interval
// buttons → their own components. What remains is prefs, account selection and layout.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import ChartOrderModal from '../components/ChartOrderModal'
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
import {
  DEFAULT_INDICATORS, INTERVAL_KEY, SYMBOL_DECIMALS, SYMBOL_KEY, type IndicatorFlags,
} from '../components/charts/chartConfig'

// IndicatorFlags 原本定义在这里，IndicatorSettingsModal 等按老路径引用；保留再导出。
// IndicatorFlags used to be defined here; re-exported so old import paths keep working.
export type { IndicatorFlags }

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
  // 指标设置弹窗展开态 / indicator settings modal open state
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

  // 手动下单弹窗：null 表示关闭 / manual order modal: null = closed
  const [orderSide, setOrderSide] = useState<'BUY' | 'SELL' | null>(null)

  // 手机端终端视图切换：图表 / 自选 / 交易 / 持仓。桌面（lg+）忽略此状态，
  // 三栏同时展示；手机上用顶部分段控件一次切一个视图。图表容器始终挂载
  // （切走时只用 CSS 隐藏，绝不卸载——否则会丢掉 lightweight-charts 实例与画线）。
  // Mobile terminal view switch: chart / watchlist / trade / positions. Ignored
  // at lg+ (all three columns show at once); on mobile a top segmented control
  // shows one view at a time. The chart container stays mounted always (hidden
  // via CSS when switched away, never unmounted — that would drop the
  // lightweight-charts instance and drawings).
  const [mobileView, setMobileView] = useState<'chart' | 'watchlist' | 'trade' | 'positions'>('chart')
  // 手机端画线工具是否展开：桌面工具栏一直平铺展示全部画线工具，手机端默认
  // 收起（只留周期切换 + 画笔开关 + 添加指标三件套），点画笔才展开完整工具行
  // ——参考 Web3 手机端交易 App（如 Hyperliquid/dYdX）默认界面精简、进阶操作
  // 收进一个入口的做法，避免小屏被十几个小图标塞满。
  // Whether the mobile draw-tool row is expanded: the desktop toolbar always
  // shows every draw tool inline; mobile starts collapsed (interval switch +
  // a draw toggle + add-indicator only) and expands the full row on tap —
  // mirrors how Web3 mobile trading apps (Hyperliquid, dYdX) keep the default
  // screen lean and tuck power-user controls behind one entry point instead of
  // packing a dozen small icons onto a narrow screen.
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false)

  // 这两个都是全屏弹窗，手机上划返回应该先关掉弹窗、而不是直接退出图表页
  // （见 useBackToClose 的说明）。/ Both are full-screen modals; on mobile,
  // swiping back should close the modal first rather than exiting the charts
  // page outright (see useBackToClose's comment).
  useBackToClose(settingsOpen, () => setSettingsOpen(false))
  useBackToClose(orderSide != null, () => setOrderSide(null))

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

  // 每个品种的价格轴小数位（与图表 series 精度一致），供自选列表/行情头统一取用。
  // Per-symbol price precision (matches the chart series), shared by the
  // watchlist and symbol header.
  const digitsFor = useCallback((s: string) => SYMBOL_DECIMALS[s] ?? 2, [])

  // 当前品种的全站统一报价（EA 推送，含 bid/ask）；行情头与右栏下单价用它。
  // The active symbol's site-wide quote (EA-pushed, bid/ask); used by the
  // symbol header and the order price on the right rail.
  const activeQuote = symbol ? globalQuotes[symbol] : undefined

  // 右栏账户摘要展示的账户：优先在线账号，否则第一个绑定的。
  // Account shown in the right-rail summary: prefer an online one, else the first bound.
  const primaryAccount = accounts.find((a) => a.online) ?? accounts[0] ?? null

  // 当前选中的交易账户（login）——由下单面板的账户下拉驱动，提升到这里让账户摘要、
  // 底部持仓/挂单都跟着切换，而不是永远只显示第一个账户。空串表示还没手动选，
  // 走 primaryAccount 兜底。/ Currently selected trading account (login), driven by
  // the ticket's account picker and lifted here so the account summary and the
  // positions/orders dock all follow the selection instead of being stuck on the
  // first account. Empty string means no manual pick yet — falls back to primary.
  const [selectedLogin, setSelectedLogin] = useState<string>('')
  // 上次下单用过的账户。它不只喂给下单栏——右侧账户摘要、底部持仓/挂单都跟着
  // selectedLogin 走，所以要在这一层就认，否则会出现「下单栏显示记住的账户、
  // 账户面板还显示兜底账户」这种自相矛盾的画面。
  // The remembered account is applied at this level, not just inside the ticket:
  // the account summary and positions/orders dock all follow selectedLogin, so
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

  const handleOrderConfirm = async (
    volume: number,
    mt5Login: string | null,
    stopLoss: number | null,
    takeProfit: number | null,
    clientOrderId: string,
  ) => {
    if (!orderSide) return
    // 不在这里关弹窗：ChartOrderModal 自己会展示"已提交"回执卡片，再调用
    // onCancel 关闭；立刻关闭会让回执卡片还没渲染出来就被卸载。
    // Don't close the modal here: ChartOrderModal shows its own "submitted"
    // receipt card and calls onCancel itself; closing immediately would
    // unmount it before the receipt card ever gets to render.
    await placeManualOrder(symbol, orderSide, volume, mt5Login, stopLoss, takeProfit, clientOrderId)
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
  // mobileView 作为 refitKey：手机端切回图表视图时补一次 resize（原来的 effect 就是这个用途）。
  // Chart instance / indicator series / legend / panes → useChartEngine; history /
  // paging / polling → useChartData. mobileView is the refit key (the old
  // "returning to the chart view forces a resize" effect).
  const engine = useChartEngine(containerRef, indicators, indicatorSettings, mobileView)
  const { chartRef, seriesRef, getBarTimes, legend, paneOffsets, drawReady } = engine
  const { hasData, stale, lastPrice, dayStats } = useChartData(symbol, interval, engine)

  const decimals = SYMBOL_DECIMALS[symbol] ?? 2

  return (
    <div className="term-shell">
      {/* drawVersion 用于外部画线工具栏状态变更时强制 ChartsPage 重渲染 */}
      {void drawVersion}

      {/* 左栏：自选品种列表（桌面常驻；窄屏隐藏，手机端终端在阶段 3 单独做）。
          可见性放在这层普通 wrapper 上，而不是直接给 .term-panel 加 hidden——
          .term-panel 的 display:flex 在样式表里排在 Tailwind .hidden 之后，会盖
          掉它，wrapper 不是 .term-panel 就没有这个冲突。
          Left column: watchlist (desktop only for now). Visibility lives on this
          plain wrapper, not on .term-panel directly — .term-panel's display:flex
          comes after Tailwind's .hidden in the sheet and would override it; the
          wrapper isn't a .term-panel so there's no conflict. */}
      <div className="term-col-left hidden min-h-0 lg:flex lg:flex-col">
        <WatchlistPanel
          className="flex-1"
          symbols={activeSymbols}
          quotes={globalQuotes}
          active={symbol}
          onSelect={setSymbol}
          digitsFor={digitsFor}
        />
      </div>

      {/* 中栏：行情头 + 控制条 + 图表 / center: symbol header + controls + chart */}
      <div className="term-center">
        {/* 手机端视图切换（桌面隐藏；全屏时隐藏）：图表 / 自选 / 交易 / 持仓。
            Mobile view switcher (hidden on desktop & in fullscreen). */}
        {!isFullscreen && (
          <div className="term-mtabs lg:hidden">
            {(['chart', 'watchlist', 'trade', 'positions'] as const).map((key) => (
              <button
                key={key}
                type="button"
                className={mobileView === key ? 'on' : ''}
                onClick={() => setMobileView(key)}
              >
                {t(`charts.mtabs.${key}`)}
              </button>
            ))}
          </div>
        )}

        {/* 图表视图：桌面恒显示（三栏之一）；手机端仅在"图表"视图显示。
            图表容器无论如何都保持挂载，切走时靠外层 max-lg:hidden 隐藏而非卸载。
            Chart view: always shown on desktop; on mobile only in the chart view.
            The chart stays mounted regardless — hidden via max-lg:hidden, never
            unmounted. */}
        <div className={`term-chartview ${mobileView === 'chart' ? '' : 'max-lg:hidden'}`}>
        {/* 品种行情头（全屏时隐藏）/ symbol header (hidden in fullscreen) */}
        {!isFullscreen && (
          <SymbolHeader
            symbol={symbol}
            bid={activeQuote?.bid ?? null}
            ask={activeQuote?.ask ?? null}
            digits={decimals}
            dayStats={dayStats}
            fallbackPrice={lastPrice}
          />
        )}

      {/* 桌面单条工具栏（全屏时隐藏）：周期钉左 · 画线工具中部横滑 · 添加指标钉右。
          可见性放在这层普通 wrapper 上而不是直接给 .term-toolbar 加 hidden——
          .term-toolbar 自带 display:flex，在样式表里排在 Tailwind .hidden 之后会
          盖掉它（与左栏自选同一个坑，见其注释）。
          Desktop single toolbar (hidden in fullscreen): interval pinned left ·
          draw tools scroll in the middle · add-indicator pinned right.
          Visibility lives on this plain wrapper, not on .term-toolbar directly —
          it has its own display:flex which would override Tailwind's .hidden
          coming earlier in the sheet (same pitfall as the watchlist; see its
          comment). */}
      {!isFullscreen && (
        <div className="hidden lg:block">
          <div className="term-toolbar">
            <IntervalSeg value={interval} onChange={setIntervalCode} />
            {drawReady && <DrawToolsRow drawLayerRef={drawLayerRef} bumpDraw={bumpDraw} t={t} />}
            <div className="term-toolbar-right">
              {stale && <span className="term-stale">{t('charts.stale')}</span>}
              <PositionMarkerToggle on={showPositions} onToggle={() => setShowPositions((v) => !v)} t={t} />
              <button type="button" onClick={() => setSettingsOpen(true)} className="term-tool-indicator">
                {t('charts.indicators.button')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 手机端工具栏（全屏时隐藏）：周期切换 + 画笔开关 + 添加指标三件套，参考
          Web3 手机交易 App 的精简默认界面——画线工具默认收起，点画笔才展开成
          下面的可换行工具行，避免十几个小图标常驻挤在窄屏上。
          Mobile toolbar (hidden in fullscreen): interval switch + a draw toggle +
          add-indicator only, mirroring the lean default screen of Web3 mobile
          trading apps — draw tools start collapsed and expand into the wrapping
          row below on tap, instead of a dozen small icons permanently crowding a
          narrow screen. */}
      {!isFullscreen && (
        <div className="lg:hidden">
          <div className="term-toolbar-m">
            <IntervalSeg value={interval} onChange={setIntervalCode} />
            <div className="term-toolbar-m-right">
              {stale && <span className="term-stale">{t('charts.stale')}</span>}
              <PositionMarkerToggle on={showPositions} onToggle={() => setShowPositions((v) => !v)} t={t} />
              {drawReady && (
                <button
                  type="button"
                  onClick={() => setMobileToolsOpen((v) => !v)}
                  aria-label={String(t('charts.draw.button'))}
                  className={`term-tool-btn ${mobileToolsOpen ? 'on' : ''}`}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
                </button>
              )}
              <button type="button" onClick={() => setSettingsOpen(true)} className="term-tool-indicator">
                {t('charts.indicators.button')}
              </button>
            </div>
          </div>
          {drawReady && mobileToolsOpen && (
            <div className="term-toolbar-m-expand">
              <DrawToolsRow drawLayerRef={drawLayerRef} bumpDraw={bumpDraw} t={t} wrap />
            </div>
          )}
        </div>
      )}

      {/* 手机端·常驻买卖条：紧贴周期/工具栏下方（不再挤在图表下面要滚动才能
          看到），矮一些更省高度。点开走既有的滑动确认下单弹窗（ChartOrderModal）。
          桌面隐藏（右栏已有完整下单面板）。全屏时隐藏。
          Mobile docked buy/sell bar: right under the interval/toolbar row
          (no longer squeezed below the chart, out of easy reach), shorter to
          save height. Opens the existing slide-to-confirm order modal. Hidden
          on desktop (the right rail has the full ticket) and in fullscreen. */}
      {!isFullscreen && (
        <div className="term-mbuysell lg:hidden">
          <button type="button" className="sell" onClick={() => setOrderSide('SELL')}>
            <span className="lab">{t('charts.ticket.sell')}</span>
            <span className="px num">{activeQuote?.bid != null ? activeQuote.bid.toFixed(decimals) : lastPrice ? lastPrice.toFixed(decimals) : '—'}</span>
          </button>
          <button type="button" className="buy" onClick={() => setOrderSide('BUY')}>
            <span className="lab">{t('charts.ticket.buy')}</span>
            <span className="px num">{activeQuote?.ask != null ? activeQuote.ask.toFixed(decimals) : lastPrice ? lastPrice.toFixed(decimals) : '—'}</span>
          </button>
        </div>
      )}

      {/* 图表容器：无缝（无自身边框/圆角/内边距），窄屏 70vh，桌面填满中栏剩余
          高度（.term-chart 内处理）。/ Chart container: seamless (no own border/
          radius/padding); 70vh on narrow screens, fills the center column on
          desktop (handled in .term-chart). */}
      <div className={`term-chart ${isFullscreen ? 'chart-fullscreen-container' : ''}`}>
        {/* 全屏开关按钮（仅手机端显示）：同一个按钮进出，进入自动横屏，退出恢复竖屏 */}
        <button
          type="button"
          onClick={isFullscreen ? exitFullscreen : enterFullscreen}
          aria-label={isFullscreen ? t('charts.fullscreen.exit') : t('charts.fullscreen.enter')}
          title={isFullscreen ? t('charts.fullscreen.exit') : t('charts.fullscreen.enter')}
          className="lg:hidden absolute top-2 left-2 z-30 flex h-7 w-7 items-center justify-center rounded-md border border-white/10 bg-ink-900/70 text-neutral-300 backdrop-blur-sm transition hover:text-white hover:border-white/20 active:scale-90"
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

        {/* 全屏态时间周期切换：右上角横排，紧凑按钮，方便横屏时切周期 */}
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
        {!hasData && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-neutral-500">
            {t('charts.empty')}
          </div>
        )}

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
      </div>
      {/* /term-chartview */}

      {/* 底部持仓 / 挂单（桌面终端常驻；全屏时隐藏）。固定高度，不抢图表的
          flex 空间。手机端由下方"持仓"视图承载。
          Positions/orders dock (desktop terminal; hidden in fullscreen). Fixed
          height so it doesn't steal the chart's flex space. On mobile the
          "positions" view below carries this instead. */}
      {!isFullscreen && (
        <div className="hidden lg:flex lg:h-[196px] lg:flex-shrink-0 lg:flex-col">
          <PositionsDock
            className="flex-1"
            positions={accountPositions}
            orders={accountOrders}
            digitsFor={digitsFor}
            onToast={showToast}
          />
        </div>
      )}

      {/* 手机端·自选视图：点某品种即切换主图并跳回图表视图 / mobile watchlist
          view: tapping a symbol switches the chart and jumps back to it */}
      {!isFullscreen && (
        <div className={`term-mview lg:hidden ${mobileView === 'watchlist' ? 'flex flex-col' : 'hidden'}`}>
          <WatchlistPanel
            className="flex-1"
            symbols={activeSymbols}
            quotes={globalQuotes}
            active={symbol}
            onSelect={(s) => { setSymbol(s); setMobileView('chart') }}
            digitsFor={digitsFor}
          />
        </div>
      )}

      {/* 手机端·交易视图：完整停靠下单面板 / mobile trade view: full docked ticket */}
      {!isFullscreen && (
        <div className={`term-mview lg:hidden ${mobileView === 'trade' ? 'flex flex-col gap-2.5' : 'hidden'}`}>
          <OrderTicket
            symbol={symbol}
            accounts={accounts}
            quotesByAccount={accountQuotes}
            globalQuote={activeQuote}
            refPrice={lastPrice}
            digits={decimals}
            selectedLogin={effectiveLogin}
            onSelectLogin={setSelectedLogin}
            onPlace={(side, volume, mt5Login, stopLoss, takeProfit, coid) =>
              placeManualOrder(symbol, side, volume, mt5Login, stopLoss, takeProfit, coid)
            }
          />
          {/* 手机交易视图也带上账户摘要——桌面端常驻、手机端此前只在持仓视图有，
              交易页填补了下单按钮下方的空白。/ Show the account summary here too;
              on desktop it's always visible, mobile previously only had it on the
              positions view — this fills the blank below the place button. */}
          <AccountSummary account={activeAccount} />
        </div>
      )}

      {/* 手机端·持仓视图：持仓/挂单 + 账户摘要 / mobile positions view */}
      {!isFullscreen && (
        <div className={`term-mview lg:hidden ${mobileView === 'positions' ? 'flex flex-col gap-2.5' : 'hidden'}`}>
          <PositionsDock
            className="flex-1"
            positions={accountPositions}
            orders={accountOrders}
            digitsFor={digitsFor}
            onToast={showToast}
          />
          <AccountSummary account={activeAccount} />
        </div>
      )}

      {/* 免责声明：仅手机端图表视图显示 / disclaimer: mobile chart view only */}
      {!isFullscreen && mobileView === 'chart' && (
        <p className="mt-2 text-center text-[11px] text-neutral-500 lg:hidden">
          {t('charts.footer')}
        </p>
      )}
      </div>
      {/* /term-center */}

      {/* 右栏：停靠式下单面板 + 账户摘要（桌面常驻；窄屏隐藏，手机端在阶段 3
          单独做）。下单面板占据剩余高度并可内部滚动，账户摘要固定在底部。
          Right column: docked order ticket + account summary (desktop only).
          The ticket takes the remaining height and scrolls internally; the
          account summary stays pinned at the bottom. */}
      <div className="term-col-right term-right hidden min-h-0 flex-col lg:flex">
        <OrderTicket
          className="min-h-0 flex-1"
          symbol={symbol}
          accounts={accounts}
          quotesByAccount={accountQuotes}
          globalQuote={activeQuote}
          refPrice={lastPrice}
          digits={decimals}
          selectedLogin={effectiveLogin}
          onSelectLogin={setSelectedLogin}
          onPlace={(side, volume, mt5Login, stopLoss, takeProfit, coid) =>
            placeManualOrder(symbol, side, volume, mt5Login, stopLoss, takeProfit, coid)
          }
        />
        <AccountSummary account={activeAccount} />
      </div>

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

      {orderSide && (
        <ChartOrderModal
          symbol={symbol}
          side={orderSide}
          accounts={accounts}
          quotesByAccount={accountQuotes}
          refPrice={lastPrice}
          digits={decimals}
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
