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
//
// 2026-11-27 阶段 6 多图布局：一张图的全部（引擎、数据、浮层、画线、区域放大……）拆进
// components/charts/ChartPane.tsx，本页按网格挂 1–4 格（components/charts/layout/）。第 0 格仍用全站
// 偏好（品种、周期、指标），单图时只挂这一格，与拆分前一模一样；页面的工具条、快捷键、弹窗经
// ChartPaneHandle 作用在当前格上。
// Phase 6 multi-chart layout (2026-11-27): everything about one chart (engine, data, overlays,
// drawings, zoom…) moved into components/charts/ChartPane.tsx; this page mounts 1–4 cells by grid
// (components/charts/layout/). Cell 0 still uses the app-wide prefs (symbol, interval, indicators), and a
// single chart mounts just that cell, exactly as before the split; the page's toolbars, hotkeys and
// dialogs act on the active cell through ChartPaneHandle.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentProps, type RefObject } from 'react'
import { useOverflowHint } from '../utils/useOverflowHint'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { usePrefs } from '../store/prefs'
import { useAuth } from '../store/auth'
import { useLive } from '../store/live'
import { useOrderPlacement } from '../components/signals/hooks'
import { useBackToClose } from '../utils/useBackToClose'
import { usePresence, SHEET_EXIT_MS } from '../utils/usePresence'
import { useScrollLock } from '../utils/scrollLock'
import { useSheetDrag } from '../utils/useSheetDrag'
import { useDialogA11y } from '../utils/useDialogA11y'
import { pickDefaultAccount, useLastAccount } from '../utils/useLastAccount'
import { useMediaQuery } from '../utils/useMediaQuery'
import type { DrawLayerHandle } from '../components/charts/DrawLayer'
import IndicatorDialog from '../components/charts/ind/IndicatorDialog'
import IndicatorEditor from '../components/charts/ind/IndicatorEditor'
import Toast from '../components/Toast'
import Switch from '../components/Switch'
import SymbolHeader from '../components/charts/SymbolHeader'
import WatchlistPanel from '../components/charts/WatchlistPanel'
import AccountSummary from '../components/charts/AccountSummary'
import OrderTicket from '../components/charts/OrderTicket'
import PositionsDock from '../components/charts/PositionsDock'
import { useFillSound } from '../components/charts/trade/useFillSound'
import { autoEntryType } from '../components/charts/trade/tradeMath'
import type { ChartPlaceReq } from '../components/charts/trade/useTradeActions'
import { clampLots, defaultVolume } from '../components/order/orderMath'
import ConfirmModal from '../components/ConfirmModal'
import { useLastVolume } from '../utils/useLastVolume'
import { clientOrderId, localizeApiError, lotDecimals } from '../api/utils'
import DrawToolsRow from '../components/charts/DrawToolsRow'
import PositionMarkerToggle from '../components/charts/PositionMarkerToggle'
import IntervalSeg from '../components/charts/IntervalSeg'
import { useIndLayout, type IndLayoutUpdate } from '../components/charts/ind/useIndLayout'
import type { IndLayout } from '../components/charts/ind/types'
import { defOf } from '../components/charts/ind/registry'
import { MK_KEYS } from '../components/charts/ind/registry3'
import { addInstance, normalizeLayout, removeInstance, updateInstance } from '../components/charts/ind/store'
import FullscreenToolbar from '../components/charts/FullscreenToolbar'
import ChartSettingsDialog from '../components/charts/ChartSettingsDialog'
import IntervalMenu from '../components/charts/IntervalMenu'
import ChartTypeMenu from '../components/charts/ChartTypeMenu'
import ChartBottomBar, { type RangeKey } from '../components/charts/ChartBottomBar'
import GoToDateDialog from '../components/charts/GoToDateDialog'
import ShortcutsDialog from '../components/charts/ShortcutsDialog'
import QuickInput from '../components/charts/QuickInput'
import ChartLoupe from '../components/charts/ChartLoupe'
import ChartContextMenu, { type CtxState } from '../components/charts/ChartContextMenu'
import { useChartHotkeys } from '../components/charts/useChartHotkeys'
import { useChartPrefs } from '../components/charts/useChartPrefs'
import { CHART_PALETTES, resolveChartTheme } from '../components/charts/chartTheme'
import { CHART_TYPE_GROUPS, normalizeChartPrefs, type ChartType, type ScaleMode } from '../components/charts/chartPrefs'
import { isValidInterval } from '../components/charts/intervals'
import { canCopyImage } from '../components/charts/chartScreenshot'
import { useChartFullscreen } from '../components/charts/useChartFullscreen'
import { useGlobalQuote, useGlobalQuotesPeek, useGlobalQuotesSelect } from '../store/live'
import type { Order, Quote } from '../api/types'
import { draftEntryType, type Side, type DraftFill } from '../components/order/useOrderForm'
import {
  FALLBACK_DECIMALS, INTERVAL_KEY, SYMBOL_KEY, isKnownInterval,
  priceDigits, resolvePriceDigits, INTERVALS,
  normalizeCandleColors, dirColorsOf, type CandleColors,
} from '../components/charts/chartConfig'
import { readStorage } from '../utils/safeStorage'
// 本页专属样式：跟着本页 chunk 按需加载，不进首屏的全站 CSS（见 styles/index.css 文件头）。
import '../styles/terminal.css'
import '../styles/chart-alerts.css'
import AlertDialog, { type AlertInit } from '../components/charts/alert/AlertDialog'
import AlertManager from '../components/charts/alert/AlertManager'
import { useChartAlerts } from '../components/charts/alert/alertStore'
import { onChartAlertFired } from '../utils/chartAlertEvents'
import { useSearchParams } from 'react-router-dom'
import { EMPTY } from '../utils/format'
// 专业版终端：同一张图表的第二套外壳（见 components/charts/pro/ 与 styles/chart-pro.css）
// The pro terminal: a second shell around the same chart (components/charts/pro/, styles/chart-pro.css)
import '../styles/chart-pro.css'
import { useProPrefs, type ProLayout } from '../components/charts/pro/proPrefs'
import ProTopBar from '../components/charts/pro/ProTopBar'
import ProWidgets, { ProAlerts, ProDetails } from '../components/charts/pro/ProWidgets'
import ProWatchlist from '../components/charts/pro/ProWatchlist'
import ProDrawRail from '../components/charts/pro/ProDrawRail'
import ProCommand, { type ProAction, type ProCommandMode } from '../components/charts/pro/ProCommand'
import { ProDock, ProIsland, ProTabBar, type IslandEvent, type ProTab } from '../components/charts/pro/ProChrome'
import { IcBell, IcCamera, IcClassic, IcData, IcDock, IcExpand, IcFocus, IcFx, IcGear, IcKeyboard, IcList, IcPlus, IcSpark, IcTrade, IcCalendar } from '../components/charts/pro/icons'
// 阶段 6：一格图表 + 多图布局 / phase 6: one chart cell + the multi-chart layout
import ChartPane, { EMPTY_PANE_INFO, samePaneInfo, useScopedPendingOrders, useScopedPositions, type ChartPaneHandle, type DrawOrderCtx, type DrawOrderReq, type PaneEnv, type PaneInfo } from '../components/charts/ChartPane'
import type { CompareEntry, PaneState } from '../components/charts/layout/paneState'
import { DEFAULT_SYNC, MAX_PANES, cellArea, clampIdx, gridTemplate, patchPanes, visibleCells, withGrid, type GridId, type LayoutDoc, type SyncFlags } from '../components/charts/layout/layoutModel'
import { createSyncBus } from '../components/charts/layout/syncBus'
import { useChartLayouts } from '../components/charts/layout/useChartLayouts'
import LayoutMenu from '../components/charts/layout/LayoutMenu'
// 阶段 6：回放 / 对比 / 数据窗口 / phase 6: replay / compare / data window
import { ReplayButton } from '../components/charts/replay/ReplayBar'
import CompareDialog, { CompareButton } from '../components/charts/compare/CompareDialog'
import type { CompareHandle } from '../components/charts/compare/useCompare'
import DataWindow from '../components/charts/datawin/DataWindow'
import type { CandleColors as DwCandle } from '../components/charts/chartConfig'

// data = 数据窗口（阶段 6）/ data = the data window (phase 6)
type Sheet = 'watchlist' | 'trade' | 'positions' | 'data' | null

// charts.interval 只写旧 App 包也认识的 8 个代码（踩坑 #220：旧包把新代码发给后端得 400）；
// 新代码（2m、45m、2H、1W…）只存在 chartv2.prefs.interval。
// charts.interval only ever gets the 8 codes old App bundles know (pitfall #220: an old bundle
// sent a new code to the backend and got 400); new codes live in chartv2.prefs.interval only.
const LEGACY_INTERVALS: ReadonlySet<string> = new Set(INTERVALS.map((i) => i.code))

// ── 高频数据下放 / high-frequency data pushed down ──────────────────────────────
// 本页以前在顶层订阅全部报价（全站 + 按账户）、持仓与挂单：任何一个品种跳一下价、
// 任何一张仓位的浮盈动一下，整页——图表外壳、工具条、自选、下单票、停靠区——全部
// 重渲染。现在顶层只订阅「低频」的东西（账户、订单、当前品种的价格精度），报价与
// 持仓由真正要用它们的叶子组件各自订阅：下单票自己读按账户报价、报价条 / 交易条按
// 当前品种读一条全站报价、持仓标记层与停靠区自己读持仓并按账户过滤。图上的持仓线、
// 挂单线照旧随推送实时更新——它们的订阅只是挪进了 LiveOverlay。
// This page used to subscribe at the top to every quote (site-wide and per
// account), positions and pending orders, so any symbol ticking or any position's
// P/L moving re-rendered everything — chart shell, toolbar, watchlist, ticket, dock.
// The top level now subscribes only to low-frequency data (accounts, orders, the
// active symbol's precision); quotes and positions are read by the leaves that use
// them. The on-chart position / pending lines still update live — their
// subscription simply moved into LiveOverlay.

// 全部品种的「品种:精度」签名：只有新品种出现、或券商精度变了它才变，于是
// digitsFor 不会因为每一跳价换新引用。/ A "symbol:digits" signature over all quotes;
// it changes only when a symbol appears or a broker's precision changes, so
// digitsFor keeps its identity across ticks.
function digitsSignature(quotes: Record<string, Quote>): string {
  let sig = ''
  for (const k in quotes) sig += `${k}:${quotes[k]?.digits ?? ''}|`
  return sig
}
type DockProps = Omit<ComponentProps<typeof PositionsDock>, 'positions' | 'pendingOrders'> & { scopeLogin: string | null }
function LiveDock({ scopeLogin, ...rest }: DockProps) {
  const positions = useScopedPositions(scopeLogin)
  const pendingOrders = useScopedPendingOrders(scopeLogin)
  return <PositionsDock {...rest} positions={positions} pendingOrders={pendingOrders} />
}

// 只渲染持仓数的小叶子（工具条按钮 / 抽屉抬头）/ a leaf that renders just the count
function PositionsCount({ scopeLogin }: { scopeLogin: string | null }) {
  return <>{useScopedPositions(scopeLogin).length}</>
}
// 专业版图标上的持仓数角标：0 时不画 / the pro icons' position-count badge, hidden at 0
function PositionsBadge({ scopeLogin, className }: { scopeLogin: string | null; className: string }) {
  const n = useScopedPositions(scopeLogin).length
  return n > 0 ? <b className={className}>{n}</b> : null
}

// 报价条：只订阅当前品种那一条全站报价 / quote strip reading just the active symbol's quote
function LiveSymbolHeader(props: Omit<ComponentProps<typeof SymbolHeader>, 'bid' | 'ask'>) {
  const q = useGlobalQuote(props.symbol)
  return <SymbolHeader {...props} bid={q?.bid ?? null} ask={q?.ask ?? null} />
}

// 齿轮：打开图表设置弹窗（2026-11-25 起取代 ChartSettingsMenu 的小菜单）。
// Gear: opens the chart settings dialog (replaces ChartSettingsMenu's popover since 2026-11-25).
function GearButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" title={label} aria-label={label} aria-haspopup="dialog" onClick={onClick} className="term-tool-btn">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </button>
  )
}
// 多图里 1–3 号格的指标：格子自己存 {list, panes, mainH}，收藏 / 最近 / 模板 / 默认参数仍跟全局走。
// 按原始对象缓存洗过的结果，别的格子一变不会让这一格的指标列表换引用（否则引擎会白白重算）。
// Indicators of cells 1–3: each stores its own {list, panes, mainH}; favourites / recent / templates /
// defaults stay global. Normalised results are cached by the raw object, so another cell's change doesn't
// give this cell a new list identity (the engine would recompute for nothing).
const indNormCache = new WeakMap<object, IndLayout>()
function paneIndOf(global: IndLayout, raw: unknown, merged: WeakMap<object, { g: IndLayout; v: IndLayout }>): IndLayout {
  if (!raw || typeof raw !== 'object') return global
  let n = indNormCache.get(raw)
  if (!n) { n = normalizeLayout(raw); indNormCache.set(raw, n) }
  const hit = merged.get(raw)
  if (hit && hit.g === global) return hit.v
  const v: IndLayout = { ...global, list: n.list, panes: n.panes, mainH: n.mainH }
  merged.set(raw, { g: global, v })
  return v
}
const indPart = (l: IndLayout) => ({ list: l.list, panes: l.panes, mainH: l.mainH })
const CHART_TYPES: ReadonlySet<string> = new Set(CHART_TYPE_GROUPS.flat())

// 数据窗口（当前格）：对比品种的值来自 useCompare 的行仓库（十字线那根），隐藏的不列
// The data window (active cell): compare values come from useCompare's row store (the crosshair bar); hidden ones are skipped
const NO_ROWS = { rows: [], leftInset: 0 }
const noSub = () => () => {}
function LiveDataWindow({ info, timezone, candle }: { info: PaneInfo; timezone: string; candle: DwCandle }) {
  const cmp: CompareHandle | null = info.compare
  const snap = useSyncExternalStore(cmp ? cmp.rows.subscribe : noSub, cmp ? cmp.rows.get : () => NO_ROWS)
  const compare = useMemo(
    () => snap.rows.filter((r) => !r.hidden).map((r) => ({ symbol: r.symbol, color: r.color, value: r.value, decimals: r.digits })),
    [snap],
  )
  if (!info.ohlcStore || !info.legendStore) return null
  return (
    <DataWindow ohlcStore={info.ohlcStore} legendStore={info.legendStore} list={info.list} symbol={info.symbol} interval={info.interval}
      decimals={info.decimals} timezone={timezone} candle={candle} compare={compare} />
  )
}

export default function ChartsPage() {
  const { t } = useTranslation()
  const { getPref, setPref, loaded } = usePrefs()

  // 初始值只是尽力猜测（此刻 activeSymbols 还没从后端加载回来，无法校验是否
  // 真的还活跃）；下面那个 effect 会在 activeSymbols 就绪后校正——若猜的品种
  // 已不在活跃列表里（或还没猜出来，是空字符串），改成活跃列表的第一个。
  // The initial value is only a best-effort guess (activeSymbols hasn't
  // loaded from the backend yet, so we can't verify it's still active); the
  // effect below corrects it once activeSymbols is ready — falls back to the
  // active list's first entry if the guess is no longer active (or empty).
  // 阶段 6 起这是第 0 格的品种 / since phase 6 this is cell 0's symbol
  const [symbol, setSymbol] = useState<string>(
    // 走 readStorage 而不是裸 localStorage：这两行在 useState 的初始化器里，
    // 位于 ErrorBoundary 的渲染路径上——隐私模式 / 站点数据被禁用时，连属性访问
    // 本身都会抛 SecurityError，图表页就直接变成错误卡。读不到当成"没存过"即可，
    // 云端 prefs 才是这个偏好的真源。见 utils/safeStorage.ts 的开头。
    // readStorage rather than a bare localStorage: these two run inside useState
    // initialisers, on the render path — in private mode or with site data
    // blocked even the property access throws SecurityError and the charts page
    // degrades to an error card. A failed read simply means "nothing stored";
    // the cloud prefs are this preference's real source. See utils/safeStorage.ts.
    () => getPref<string>('charts', 'symbol', '') || readStorage(SYMBOL_KEY) || ''
  )
  // 存下来的周期先校验：周期表以后增删时，旧值不会把图表卡在一个后端不认的周期上。
  // Stored intervals are validated, so a stale code never strands the chart on an
  // interval nothing can serve.
  const [interval, setIntervalCode] = useState<string>(() => {
    const v2 = normalizeChartPrefs(getPref<unknown>('chartv2', 'prefs', null), isValidInterval).interval
    if (v2) return v2
    const cloud = getPref<string>('charts', 'interval', '')
    if (isKnownInterval(cloud)) return cloud
    const local = readStorage(INTERVAL_KEY)
    return isKnownInterval(local) ? local : '15'
  })
  // 指标开关 + 参数：都跟随用户走，云端同步（见下方持久化 effect），与
  // 品种/周期无关。/ Indicator toggles + settings: follow the user, cloud
  // synced (see the persistence effects below); independent of symbol/interval.
  // 2026-11-25 阶段 4：指标是实例列表（chartv2 / ind），见 components/charts/ind/。
  // Phase 4: indicators are an instance list (chartv2 / ind), see components/charts/ind/.
  // 阶段 6 起这是第 0 格（以及没有自己指标的格子）的指标 / since phase 6: cell 0's (and cells without their own) indicators
  const [indLayout, updateInd] = useIndLayout()
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 正在编辑设置的实例 / the instance whose settings dialog is open
  const [editUid, setEditUid] = useState<string | null>(null)
  // 外部画线工具栏（DrawToolsRow / FullscreenToolbar）改的是 DrawLayer 内部状态，
  // 经 ref 调用，不会让本页重渲染——按钮的按下态就不会跟着变。这个计数器只为
  // "踢一脚重渲染"存在，值本身没人读，所以只取 setter。
  // The draw toolbars mutate DrawLayer state through a ref, which doesn't
  // re-render this page (so their pressed states would go stale). This counter
  // exists only to force one; nobody reads the value, hence setter-only.
  const [, setDrawVersion] = useState(0)
  const bumpDraw = useCallback(() => setDrawVersion((v) => v + 1), [])
  // 持仓标记显隐：跟随用户走、云端同步（与指标开关同一套持久化模式）。默认开，
  // 有单时直接看得到入场/止损/止盈，不需要先去翻某个开关。
  // Position-marker visibility: follows the user, cloud synced (same persistence
  // pattern as the indicator toggles). On by default so an open position's
  // entry/SL/TP show up without hunting for a toggle first.
  const [showPositions, setShowPositions] = useState<boolean>(
    () => getPref<boolean>('charts', 'showPositions', true)
  )
  // 手机上下完单自动把抽屉切到「持仓」。默认开：下完单第一件想做的事就是看它成没
  // 成、仓位长什么样，而手机上那张下单票占满整屏，不切过去就什么都看不见。
  // 开关放在持仓抽屉的抬头里——正是它弹出来的那个地方，嫌烦的人一眼就能关掉。
  // Auto-switch the mobile sheet to positions after placing. On by default: the first
  // thing you want after an order is to see whether it landed, and on a phone the
  // ticket fills the screen so nothing is visible until you switch. The switch lives in
  // the header of the very sheet that pops up, where anyone annoyed by it will look.
  const [afterPlaceOpen, setAfterPlaceOpen] = useState<boolean>(
    () => getPref<boolean>('charts', 'afterPlaceShowPositions', true)
  )
  // K 线收线倒计时开关（默认开）与 K 线涨跌色，都在工具条齿轮菜单里改，云端同步。
  // Bar-close countdown switch (on by default) and candle colors, set from the
  // toolbar's gear menu and cloud synced.
  const [showCountdown, setShowCountdown] = useState<boolean>(
    () => getPref<boolean>('charts', 'showCountdown', true)
  )
  const [candleColors, setCandleColorsState] = useState<CandleColors>(
    () => normalizeCandleColors(getPref<unknown>('charts', 'candleColors', null))
  )

  // 手机端抽屉：自选 / 下单票 / 持仓，一次只开一个；tradeSide 记住从交易条的哪一侧
  // 点进来。桌面（lg+）三栏常驻，抽屉不挂载（见下方 isDesktop）。
  // Mobile sheets: watchlist / ticket / positions, one at a time; tradeSide
  // remembers which side of the trade bar opened the ticket. Desktop shows the
  // three columns and never mounts the sheets (see isDesktop below).
  const [sheet, setSheet] = useState<Sheet>(null)
  // 抽屉里的持仓停靠区打开时落在哪个页签：下的是挂单就直接看挂单（体验报告 M3），其余
  // 一律从持仓开始。/ Which dock tab the sheet opens on: a pending order lands on the
  // orders tab (QA report M3); everything else starts on positions.
  const [sheetDockTab, setSheetDockTab] = useState<'positions' | 'orders'>('positions')
  // 下单回来之后要判断「当时是不是从抽屉里下的」，必须读**那一刻**的值而不是渲染
  // 闭包里的：等回执期间用户完全可能自己把抽屉关了，那就不该再替他弹开。
  // Read at callback time, not from the render closure: the user can close the sheet
  // while the fill is in flight, and we must not pop it back open on their behalf.
  const sheetRef = useRef<Sheet>(null)
  sheetRef.current = sheet
  const [tradeSide, setTradeSide] = useState<Side>('BUY')
  // 手机端画线工具是否展开：默认收起（只留周期 + 持仓 + 画笔 + 指标），点画笔才展开
  // 换行工具行，避免小屏被十几个小图标塞满。
  // Mobile draw tools start collapsed and expand into the wrapping row on tap.

  // 这些都是覆盖层，手机上划返回应该先关掉它们、而不是直接退出图表页
  // （见 useBackToClose 的说明）。/ All overlays: swiping back on mobile should
  // close them first rather than leaving the page (see useBackToClose).
  useBackToClose(settingsOpen, () => setSettingsOpen(false))
  useBackToClose(sheet != null, () => setSheet(null))

  // 桌面三栏 / 手机「图表 + 抽屉」的分界，与 terminal.css 的 1024px 断点同一条线。
  // 两边互相看不见的部分不再挂载：手机上的左右栏与停靠区，桌面上的交易条与抽屉。
  // display:none 只是不画，组件照样订阅报价与持仓、每一跳都重渲染。桌面上点报价条
  // 的品种名也不再打开那个看不见的自选抽屉（以前会多压一条返回记录，第一次「返回」
  // 什么都不发生）。
  // The desktop three-column / phone chart-plus-sheets split, on the same 1024px line as
  // terminal.css. What one side can't see is no longer mounted: the side columns and dock
  // on phones, the trade bar and sheets on desktop. display:none only skips painting; the
  // components still subscribed to quotes and positions and re-rendered on every tick.
  // Clicking the symbol name on desktop no longer opens that invisible watchlist sheet
  // either (it pushed a back-history entry, so the first Back did nothing visible).
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  // 多图布局只在 ≥768px（平板、桌面）显示；手机永远只显示当前格。
  // The multi-chart grid shows at ≥768px only (tablet, desktop); phones always show just the active cell.
  const canMulti = useMediaQuery('(min-width: 768px)')
  // 专业版终端开关。两套外壳共用同一个图表容器：下面所有外壳部件都是「条件槽位」，图表容器在
  // React 树里的位置不变，切换时不会重建图表。每次进页面都先是经典版（2026-11-26 用户要求），
  // 专业版由用户自己切，不再记住；专业版的面板宽度等布局偏好仍存在 chartv2 / pro。
  // The pro terminal switch. Both shells share one chart container: every shell part below is a
  // conditional slot, so the container keeps its place in the React tree and switching never
  // rebuilds the chart. The page always opens in the classic shell (user request 2026-11-26); the
  // pro shell is the user's own switch and is no longer remembered. Its panel sizes etc. still
  // live in chartv2 / pro.
  const [proPrefs, updatePro] = useProPrefs()
  const [layout, setLayoutState] = useState<ProLayout>('classic')
  const pro = layout === 'pro'
  // 经典版工具条放不下时横向滚动：右缘渐隐提示，鼠标竖滚轮也能横滑
  // Classic toolbar scrolls sideways when it doesn't fit: a right-edge fade as the cue, and a vertical wheel scrolls it too
  const tbHint = useOverflowHint<HTMLDivElement>()
  const tbRef = useCallback((el: HTMLDivElement | null) => {
    tbHint(el)
    if (!el) return
    el.onwheel = (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth + 1) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
  }, [tbHint])
  const setLayout = useCallback((l: ProLayout) => setLayoutState(l), [])
  const [cmd, setCmd] = useState<ProCommandMode | null>(null)
  const [proDraw, setProDraw] = useState(false)
  useEffect(() => {
    if (!pro) { setCmd(null); setProDraw(false); return }
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setCmd((m) => (m ? null : 'all'))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pro])
  // 桌面专业版的全屏 = 浏览器全屏整个终端（手机仍走原来的图表横屏全屏）
  // Desktop pro fullscreen = the browser's fullscreen on the whole terminal (phones keep the
  // chart's landscape fullscreen)
  const [docFs, setDocFs] = useState(false)
  useEffect(() => {
    const on = () => setDocFs(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])
  const toggleDocFs = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void document.documentElement.requestFullscreen?.().catch(() => {})
  }, [])
  // 视口从手机宽度变到桌面宽度（平板转屏、拖宽窗口）时收起开着的抽屉。
  // Crossing to desktop width (tablet rotation, widening the window) closes an open sheet.
  useEffect(() => {
    if (isDesktop) setSheet(null)
  }, [isDesktop])

  // ── 阶段 6：多图布局 / phase 6: multi-chart layout ──
  // cg.panes[0] 只是占位（第 0 格的品种 / 周期 / 指标来自全站偏好，见上），1–3 号格的状态在这里。
  // cg.panes[0] is a placeholder (cell 0's symbol / interval / indicators come from the app-wide prefs
  // above); cells 1–3 live here.
  const [cg, setCg] = useState<LayoutDoc>(() => ({ v: 1, grid: '1', sync: { ...DEFAULT_SYNC }, active: 0, panes: [{ symbol: '', interval: '15' }] }))
  const cgRef = useRef(cg)
  cgRef.current = cg
  // 最大化的格子（不存盘）/ the maximised cell (not persisted)
  const [maxIdx, setMaxIdx] = useState<number | null>(null)
  const { mounted, shown } = visibleCells(cg.grid, cg.active, canMulti, maxIdx)
  const multi = mounted.length > 1
  const activeIdx = clampIdx(cg.active, mounted.length > 1 ? mounted.length : cg.panes.length)
  const activeRef = useRef(activeIdx)
  activeRef.current = activeIdx
  const paneSym = (i: number) => (i === 0 ? symbol : cg.panes[i]?.symbol || symbol)
  const paneIv = (i: number) => (i === 0 ? interval : cg.panes[i]?.interval || interval)
  const paneType = (i: number): ChartType | undefined => {
    const v = i === 0 ? undefined : cg.panes[i]?.chartType
    return v && CHART_TYPES.has(v) ? (v as ChartType) : undefined
  }
  // 当前格的品种 / 周期：页面上所有「当前品种」都是它（报价条、下单票、自选高亮、命令面板…）
  // The active cell's symbol / interval: every "current symbol" on the page is this one (quote strip, ticket, watchlist highlight, palette…)
  const activeSymbol = paneSym(activeIdx)
  const activeInterval = paneIv(activeIdx)
  // 各格的 ChartPaneHandle；当前格的那个就是页面工具条作用的对象
  // Each cell's ChartPaneHandle; the active one is what the page's toolbars act on
  const handles = useRef<(ChartPaneHandle | null)[]>([])
  const paneRefs = useMemo(() => Array.from({ length: MAX_PANES }, (_, i) => (h: ChartPaneHandle | null) => { handles.current[i] = h }), [])
  const act = useCallback(() => handles.current[activeRef.current] ?? null, [])
  // 画线层 / 图表容器的「当前格代理」：画线栏、全屏读 .current 时拿到的是当前格的那个
  // "Active cell proxies" for the drawing layer / chart container: the draw bars and fullscreen read the active cell's
  const drawLayerRef = useMemo(() => ({ get current() { return handles.current[activeRef.current]?.drawLayer() ?? null } }) as RefObject<DrawLayerHandle>, [])
  const containerRef = useMemo(() => ({ get current() { return handles.current[activeRef.current]?.container() ?? null } }) as RefObject<HTMLDivElement>, [])
  const focusChart = useCallback(() => { act()?.focus() }, [act])
  // 当前格报上来的动态状态 / the active cell's reported dynamic state
  const [info, setInfo] = useState<PaneInfo>(EMPTY_PANE_INFO)
  const onPaneInfo = useCallback((i: number, inf: PaneInfo) => {
    if (i !== activeRef.current) return
    setInfo((prev) => (samePaneInfo(prev, inf) ? prev : inf))
  }, [])
  const { hasData, stale, lastPrice, dayStats, drawReady } = info

  // 手机端全屏模式（CSS 全屏 + 原生 Fullscreen API + 横屏锁定）与全屏工具栏拖动
  // Mobile fullscreen + floating toolbar drag: see useChartFullscreen
  const {
    isFullscreen, enterFullscreen, exitFullscreen,
    fsToolbarRef, fsToolbarPos, onFsToolbarPointerDown, onFsToolbarPointerMove, onFsToolbarPointerUp,
  } = useChartFullscreen(containerRef)

  // 手机抽屉的键盘与读屏：Esc 关、Tab 困住、焦点进出（utils/useDialogA11y）。抽屉在本组件里
  // 条件渲染，所以传 open。ref 不能叫 sheetRef——下面已有一个存 sheet 状态值的 sheetRef。
  // Keyboard/screen reader for the mobile sheet (utils/useDialogA11y). The sheet is
  // rendered conditionally here, hence `open`. Not named sheetRef: that one already
  // exists below and holds the sheet state value.
  const termSheetRef = useRef<HTMLDivElement>(null)
  const termSheetTitleId = 'term-sheet-title'
  useDialogA11y(termSheetRef, () => setSheet(null), { open: sheet != null && !isFullscreen })
  // 手机抽屉：关闭后多留 240ms 播退场（usePresence，内容按留下来的值渲染，退场途中不会变空）；
  // 打开期间锁页面滚动；把手与抽屉头可下拉关闭，正文不起拖。指标库同样有退场。
  // Phone sheets: kept 240ms after closing for the exit (usePresence; the content renders
  // from the kept value so it doesn't blank mid-exit); page scroll is locked while open;
  // the handle and header drag it down to close, the body never starts a drag. The
  // indicator library gets the same exit.
  const termSheet = usePresence(sheet != null && !isFullscreen && !isDesktop ? sheet : null, SHEET_EXIT_MS)
  const shownSheet = termSheet.shown
  const termScrimRef = useRef<HTMLDivElement>(null)
  const termDrag = useSheetDrag({ sheetRef: termSheetRef, scrimRef: termScrimRef, onDismiss: () => setSheet(null), ignore: '.term-sheet-body' })
  useScrollLock(sheet != null && !isFullscreen && !isDesktop)
  const indDialog = usePresence(settingsOpen ? true : null, SHEET_EXIT_MS)
  const indEditor = usePresence(editUid, SHEET_EXIT_MS)
  useBackToClose(editUid != null, () => setEditUid(null))

  // 断线状态往下传给报价条、自选、交易条、下单票：信号页的下单弹窗断线时会直说，图表页以前
  // 四处价格照常显示、报价条还写着 Live。布尔值只在断开 / 恢复时变，memo 的下单票不会因此多渲染。
  // The disconnect flag goes down to the quote strip, watchlist, trade bar and ticket: the
  // signals page's order sheet says so when disconnected, while this page kept showing four sets
  // of prices and "Live". A boolean that only flips on disconnect / reconnect, so the memo'd
  // ticket doesn't re-render for it otherwise.
  const { accounts, activeSymbols, orders, wsDisconnected } = useLive()
  const { toast, placeManualOrder, showToast, reportPlaced } = useOrderPlacement()

  // 每个品种的价格轴小数位：**优先用券商随报价上报的 digits**，拿不到才退回
  // chartConfig 里那张兜底表。这条链一路喂给报价条、下单票、自选表、持仓面板与
  // 图上的持仓标记层——以前它只查一张 7 条的写死表，表外品种（AUDUSD 之流）一律
  // 按 2 位，点差恒显示 0、止损点数差三个量级。
  // Per-symbol price precision, preferring the broker-reported Quote.digits and
  // falling back to the table only when no quote has arrived. Feeds the quote
  // strip, ticket, watchlist, positions dock and the on-chart markers.
  // 依赖的是精度签名而不是整张报价表：跳价不换引用，精度变了才换（见 digitsSignature）。
  // Keyed on the precision signature, not the quote map: ticks keep the identity.
  const peekQuotes = useGlobalQuotesPeek()
  const digitsKey = useGlobalQuotesSelect(digitsSignature)
  const digitsFor = useCallback(
    (s: string) => priceDigits(s, peekQuotes()[s]),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- digitsKey is the change signal
    [peekQuotes, digitsKey],
  )

  // exactDigits 为 null = 这个品种的精度我们还不知道（没收到报价、也不在兜底表
  // 里）。展示走 decimals（退回 2 位只是显示难看），但**发给 MT5 的价格绝不能按
  // 一个猜的位数取整**——所以拖动改单那层拿的是 exactDigits，见 PositionOverlay。
  // exactDigits === null means the precision is genuinely unknown. Display falls
  // back to 2 digits (merely ugly), but prices sent to MT5 must never be rounded
  // to a guessed precision — hence PositionOverlay takes exactDigits.
  // 只订阅「当前品种的精度」这个原始值，跳价不会让本页重渲染。
  // Subscribes to the active symbol's precision only; ticks don't re-render the page.
  const exactDigits = useGlobalQuotesSelect((q) => resolvePriceDigits(activeSymbol, activeSymbol ? q[activeSymbol] : undefined))
  const decimals = exactDigits ?? FALLBACK_DECIMALS

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

  // 选中（或记住）的账户掉线时，把选择挪到一个在线账户上。这件事以前由桌面右栏的
  // 下单票顺手完成（useOrderForm 的兜底 effect 会回调 onSelectLogin），手机上那张票
  // 虽然看不见但一直挂着。现在手机不挂那张票，兜底提到这一层，账户条、图上持仓线和
  // 持仓抽屉照旧跟着在线账户走。规则与 useOrderForm 一致：只在有在线账户时才挪，
  // 挑法是 pickDefaultAccount（记住的账户在线就用它，否则第一个在线的），不写记忆。
  // 桌面上下单票仍会做同样的事，两边写入的是同一个值。
  // When the selected (or remembered) account goes offline, move the pick to an online one.
  // The desktop ticket used to do this as a side effect (useOrderForm's fallback effect calls
  // onSelectLogin), and on phones that ticket was mounted, just invisible. Phones no longer
  // mount it, so the fallback lives here and the account strip, on-chart position lines and
  // positions sheet keep following an online account. Same rule as useOrderForm: only when an
  // online account exists, chosen by pickDefaultAccount, never remembered. On desktop the
  // ticket still does the same and both write the same value.
  useEffect(() => {
    if (!effectiveLogin) return
    const online = accounts.filter((a) => a.online)
    if (online.length === 0 || online.some((a) => a.login === effectiveLogin)) return
    setSelectedLogin(pickDefaultAccount(online, lastLogin))
  }, [accounts, effectiveLogin, lastLogin])

  // 按选中账户过滤持仓/挂单：多账户时才过滤，单账户或数据没带 login 时照旧全展示，
  // 避免误伤。/ Filter positions/orders by the selected account — only when there
  // are multiple accounts; single-account or login-less data shows as-is.
  const multiAccount = accounts.length > 1
  // 持仓 / 挂单的过滤账号：多账户才限定到选中账户，否则 null 不过滤。过滤本身在叶子
  // 组件里做（useScopedPositions），见文件前部「高频数据下放」。挂单的键名是 login，
  // 与持仓一致，不是订单那边的 mt5Login。
  // The account positions / pending orders are scoped to: the selection only when
  // there are several accounts, else null (unscoped). The filtering happens in the
  // leaves (useScopedPositions); see "high-frequency data pushed down" above.
  const scopeLogin = multiAccount && activeAccount ? activeAccount.login : null
  const accountOrders = useMemo(
    () => (multiAccount && activeAccount ? orders.filter((o) => String(o.mt5Login ?? '') === String(activeAccount.login)) : orders),
    [multiAccount, activeAccount, orders],
  )
  // 图表交易（阶段 3）下单用的账户：选中的那个在线才用它，掉线就是没有（面板会说明）。
  // The account chart trading places on (phase 3): the selected one when online, else none.
  const tradeLogin = activeAccount?.online ? activeAccount.login : null
  // 读一眼当前品种的买卖价，不订阅（回调里用）/ peek the symbol's bid / ask without subscribing
  const quoteOf = useCallback((s: string) => {
    const q = peekQuotes()[s]
    return { bid: q?.bid ?? null, ask: q?.ask ?? null }
  }, [peekQuotes])
  const quoteNow = useCallback(() => quoteOf(activeSymbol), [quoteOf, activeSymbol])
  // 停靠区「全部平仓」的作用范围，必须跟 accountPositions 一个口径：多账户才限定
  // 到选中账户，否则不限（null）——单账户或数据没带 login 时，列表本来就是全部。
  // 两者一旦不一致，那个按钮就会平掉屏幕上看不见的仓位。
  // The dock's close-all scope, kept in lockstep with accountPositions: narrowed to
  // the selected account only when there are several, otherwise unscoped (null),
  // which is exactly the list's own scope. Drift here closes off-screen positions.
  const closeAllLogin = scopeLogin
  const closeAllLabel = activeAccount
    ? `${activeAccount.login}${activeAccount.company ? ` · ${activeAccount.company}` : ''}`
    : ''

  // 云端偏好加载完成后覆盖本地初始值 / override initial values when cloud prefs arrive
  useEffect(() => {
    if (!loaded) return
    const cloudSym = getPref<string>('charts', 'symbol', '')
    if (cloudSym) setSymbol(cloudSym)
    const v2Int = normalizeChartPrefs(getPref<unknown>('chartv2', 'prefs', null), isValidInterval).interval
    const cloudInt = getPref<string>('charts', 'interval', '')
    if (v2Int) setIntervalCode(v2Int)
    else if (isKnownInterval(cloudInt)) setIntervalCode(cloudInt)
    const cloudShowPos = getPref<boolean | null>('charts', 'showPositions', null)
    if (cloudShowPos != null) setShowPositions(cloudShowPos)
    const cloudCountdown = getPref<boolean | null>('charts', 'showCountdown', null)
    if (cloudCountdown != null) setShowCountdown(cloudCountdown)
    const cloudCandle = getPref<unknown>('charts', 'candleColors', null)
    if (cloudCandle) setCandleColorsState(normalizeCandleColors(cloudCandle))
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
  // 1–3 号格同样校正 / cells 1–3 are corrected the same way
  useEffect(() => {
    if (activeSymbols.length === 0) return
    if (!cg.panes.some((p, i) => i > 0 && p.symbol && !activeSymbols.includes(p.symbol))) return
    setCg((d) => ({ ...d, panes: d.panes.map((p, i) => (i > 0 && p.symbol && !activeSymbols.includes(p.symbol) ? { ...p, symbol: activeSymbols[0] } : p)) }))
  }, [activeSymbols, cg.panes])

  // ── 改某一格的品种 / 周期 / 图表类型（同步开着时作用到所有格）──
  // ── set a cell's symbol / interval / chart type (all cells when that sync is on) ──
  const setPaneSymbol = useCallback((i: number, s: string) => {
    const all = cgRef.current.sync.symbol && cgRef.current.grid !== '1'
    if (i === 0 || all) setSymbol(s)
    if (i !== 0 || all) setCg((d) => patchPanes(d, i, { symbol: s }, all))
  }, [])
  const setPaneInterval = useCallback((i: number, c: string) => {
    const all = cgRef.current.sync.interval && cgRef.current.grid !== '1'
    if (i === 0 || all) setIntervalCode(c)
    if (i !== 0 || all) setCg((d) => patchPanes(d, i, { interval: c }, all))
  }, [])
  const setActiveSymbol = useCallback((s: string) => setPaneSymbol(activeRef.current, s), [setPaneSymbol])
  const setActiveInterval = useCallback((c: string) => setPaneInterval(activeRef.current, c), [setPaneInterval])
  const paneIntervalSetters = useMemo(() => Array.from({ length: MAX_PANES }, (_, i) => (c: string) => setPaneInterval(i, c)), [setPaneInterval])

  // /charts?symbol=XAUUSD（警报通知点进来）：云端偏好到了之后切过去，再把参数抹掉。
  // 品种名大小写按活跃列表对齐（警报里存的是大写）。
  // /charts?symbol=XAUUSD (from an alert notification): switch once cloud prefs are in, then drop
  // the param. Case is matched against the active list (alerts store upper case).
  const [searchParams, setSearchParams] = useSearchParams()
  const wantSymbol = searchParams.get('symbol')
  const pickSymbolLoose = useCallback((s: string) => {
    const up = s.toUpperCase()
    setActiveSymbol(activeSymbols.find((x) => x.toUpperCase() === up) ?? s)
  }, [activeSymbols, setActiveSymbol])
  useEffect(() => {
    if (!wantSymbol || !loaded || activeSymbols.length === 0) return
    pickSymbolLoose(wantSymbol)
    setSearchParams((p) => { const n = new URLSearchParams(p); n.delete('symbol'); return n }, { replace: true })
  }, [wantSymbol, loaded, activeSymbols.length, pickSymbolLoose, setSearchParams])

  useEffect(() => {
    if (!symbol) return // 尚未校正出有效品种前不写回偏好，避免用空字符串覆盖已保存的选择
                         // don't persist before a valid symbol is resolved, so we never overwrite a saved pref with ''
    setPref('charts', 'symbol', symbol)
  }, [symbol, setPref])

  // 图表偏好 v2（图表类型、主题、时区、坐标、画布…）/ chart prefs v2
  const [cprefs, updatePrefs, resetPrefs] = useChartPrefs()
  useEffect(() => {
    if (LEGACY_INTERVALS.has(interval)) setPref('charts', 'interval', interval)
    // 云端偏好没回来之前不写 chartv2：防抖保存会拿默认值盖掉云端那份。
    // Don't write chartv2 before the cloud prefs arrive: the debounced save would overwrite them with defaults.
    if (loaded) updatePrefs((p) => (p.interval === interval ? p : { ...p, interval }))
  }, [interval, setPref, loaded, updatePrefs])
  // 当前格的图表类型：第 0 格 = 全局；其它格自己存（没存就跟全局）
  // The active cell's chart type: cell 0 = the global one; the others store their own (else follow the global)
  const activeChartType = paneType(activeIdx) ?? cprefs.chartType
  const setActiveChartType = useCallback((v: ChartType) => {
    const i = activeRef.current
    if (i === 0) updatePrefs({ chartType: v })
    else setCg((d) => patchPanes(d, i, { chartType: v }, false))
  }, [updatePrefs])

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
    setPref('charts', 'showPositions', showPositions)
  }, [showPositions, setPref])

  useEffect(() => {
    setPref('charts', 'afterPlaceShowPositions', afterPlaceOpen)
  }, [afterPlaceOpen, setPref])

  useEffect(() => {
    setPref('charts', 'showCountdown', showCountdown)
  }, [showCountdown, setPref])

  useEffect(() => {
    setPref('charts', 'candleColors', candleColors)
  }, [candleColors, setPref])

  // 换 K 线颜色时成交量柱一起换：成交量的涨跌色本来是指标设置里单独一项，不同步的话
  // 换成红涨绿跌后量柱还是绿涨红跌，上下两块颜色意思相反。之后想单独改量柱仍可去指标面板。
  // Volume bars follow a candle color change: their colors are a separate indicator
  // setting, and leaving them would show volume in the opposite scheme to the candles.
  // They can still be tuned separately in the indicator panel afterwards.
  // 阶段 4 起成交量默认色就是「跟随涨跌色」（'up' / 'down'），不用再同步。
  // Since phase 4 the volume colours default to following the candle colours ('up' / 'down').
  const changeCandleColors = useCallback((c: CandleColors) => {
    setCandleColorsState(c)
  }, [])
  // 涨跌提示色：现价标签 / 倒计时 / 图例涨跌 / 测量用红绿，不跟自选的 K 线颜色（见 dirColorsOf）
  // Up/down cue colours for the countdown / legend change / measure: red/green, not custom candle colours
  const dirColors = useMemo(() => dirColorsOf(candleColors), [candleColors])

  // Pro 专属指标（MA 趋势蜡烛）：保存的开关原样保留（续费后自动恢复），但只有当前是 Pro
  // 才真正画出来。会员到期由后端降级 plan，这里进页面刷新一次、之后每 5 分钟刷新一次，
  // 降级后自动隐藏。/ Pro-only indicators: the saved toggle is kept (restored on
  // renewal) but only drawn while the user is Pro. Expiry downgrades `plan` server
  // side; we refresh on entry and every 5 min so it hides automatically.
  const { user, refreshUser } = useAuth()
  const isPro = user?.plan === 'PRO'
  useEffect(() => {
    refreshUser()
    const id = window.setInterval(() => refreshUser(), 5 * 60_000)
    return () => window.clearInterval(id)
  }, [refreshUser])

  // ── 每格的指标布局：第 0 格 = 全局；1–3 号格各存一份（没存就跟全局）──
  // ── per-cell indicator layout: cell 0 = the global one; cells 1–3 keep their own (else follow the global) ──
  const mergedIndCache = useRef(new WeakMap<object, { g: IndLayout; v: IndLayout }>())
  const paneIndList = useMemo(
    () => Array.from({ length: MAX_PANES }, (_, i) => (i === 0 ? indLayout : paneIndOf(indLayout, cg.panes[i]?.ind, mergedIndCache.current))),
    [indLayout, cg.panes],
  )
  const paneIndRef = useRef(paneIndList)
  paneIndRef.current = paneIndList
  const paneIndUpdaters = useMemo(() => Array.from({ length: MAX_PANES }, (_, i): ((u: IndLayoutUpdate) => void) => {
    if (i === 0) return updateInd
    return (u) => {
      const cur = paneIndRef.current[i]
      const next = u(cur)
      if (next === cur) return
      // 收藏 / 最近 / 模板 / 默认参数是用户级的，写回全局 / favourites / recent / templates / defaults are per user: write them globally
      if (next.favs !== cur.favs || next.recent !== cur.recent || next.tpls !== cur.tpls || next.defaults !== cur.defaults) {
        updateInd((g) => ({ ...g, favs: next.favs, recent: next.recent, tpls: next.tpls, defaults: next.defaults }))
      }
      if (next.list !== cur.list || next.panes !== cur.panes || next.mainH !== cur.mainH) {
        const part = indPart(next)
        setCg((d) => ({ ...d, panes: d.panes.map((p, j) => (j === i ? { ...p, ind: part } : p)) }))
      }
    }
  }), [updateInd])
  const activeInd = paneIndList[activeIdx] ?? indLayout
  const updateActiveInd = useCallback((u: IndLayoutUpdate) => paneIndUpdaters[activeRef.current]?.(u), [paneIndUpdaters])
  const shownList = useMemo(
    () => (isPro ? activeInd.list : activeInd.list.filter((i) => !defOf(i.type)?.pro)),
    [activeInd.list, isPro],
  )
  // 指标标记文字：合作指标的买卖字样 + 第三批的形态名、表格行名等（charts.ind.mk.*，以 'mk.' 前缀查）
  // Indicator marker texts: partner buy / sell words plus batch 3 pattern names, table rows etc. (charts.ind.mk.*, looked up as 'mk.<key>')
  const markerText = useMemo(() => {
    const extra = Object.fromEntries(MK_KEYS.map((k) => [`mk.${k}`, String(t(`charts.ind.mk.${k}`))]))
    return { buy: String(t('charts.indicators.buyMark')), sell: String(t('charts.indicators.sellMark')),
      closeBuy: String(t('charts.indicators.closeBuyMark')), closeSell: String(t('charts.indicators.closeSellMark')),
      slBuy: String(t('charts.indicators.slBuyMark')), slSell: String(t('charts.indicators.slSellMark')), ...extra }
  }, [t])


  // 图表实例、指标 series、图例、pane 高度 → useChartEngine；历史 / 翻页 / 轮询 → useChartData。
  // 阶段 6 起两者都在 ChartPane 里，每格一份。
  // Chart instance / indicator series / legend / panes → useChartEngine; history / paging / polling →
  // useChartData. Since phase 6 both live in ChartPane, one per cell.
  // 引擎的外观输入：主题色板、时区时间格式、坐标模式、K 线部件……全部来自 chartv2。
  // The engine's look: palette, timezone formatters, scale mode, candle parts… all from chartv2.
  const { i18n } = useTranslation()
  const lang = i18n.language || 'zh'
  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  const themeName = resolveChartTheme(cprefs.theme, systemDark)
  const palette = useMemo(() => {
    const base = CHART_PALETTES[themeName]
    return cprefs.canvas.bg ? { ...base, bg: cprefs.canvas.bg } : base
  }, [themeName, cprefs.canvas.bg])

  // ── 阶段 1 的图表交互 / phase-1 chart interactions ──
  const cvRef = useRef<HTMLDivElement>(null)
  const [chartSetOpen, setChartSetOpen] = useState(false)
  const [gotoOpen, setGotoOpen] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const [quick, setQuick] = useState<string | null>(null)
  const [measureOn, setMeasureOn] = useState(false)
  const [ctx, setCtx] = useState<CtxState | null>(null)

  // ── 阶段 5：图表警报 / phase 5: chart alerts ──
  // 新建 / 编辑弹窗的起点（null = 关）与管理器开关；触发时在图表页弹一条提示（站内通知 / 推送另由后端发）。
  // The create / edit dialog's starting point (null = closed) and the manager; a fire toasts on the
  // charts page (in-app notification / push are sent by the backend separately).
  const [alertInit, setAlertInit] = useState<AlertInit | null>(null)
  const [alertMgrOpen, setAlertMgrOpen] = useState(false)
  const { alerts: chartAlerts } = useChartAlerts()
  const activeAlertCount = useMemo(() => chartAlerts.filter((a) => a.status === 'active').length, [chartAlerts])
  const openAlert = useCallback((init: AlertInit) => { setCtx(null); setAlertInit(init) }, [])
  const alertBid = useCallback(() => quoteNow().bid, [quoteNow])
  // 专业版里触发提示走图表顶部的「灵动岛」，经典版照旧弹 toast。
  // In the pro terminal a fire shows in the chart's top island; the classic layout keeps the toast.
  const [island, setIsland] = useState<IslandEvent | null>(null)
  const proRef = useRef(pro)
  proRef.current = pro
  useEffect(() => onChartAlertFired((ev) => {
    if (proRef.current) setIsland({ id: Date.now(), symbol: ev.symbol, message: ev.message, price: ev.price ?? null })
    else showToast(ev.message || ev.symbol, 'info')
  }), [showToast])
  const dismissIsland = useCallback(() => setIsland(null), [])
  const setFavIntervals = useCallback((codes: string[]) => updatePrefs({ favIntervals: codes }), [updatePrefs])
  const setScaleMode = useCallback((m: ScaleMode) => updatePrefs({ scaleMode: m }), [updatePrefs])
  const autoScale = useCallback(() => { act()?.autoScale() }, [act])
  const resetView = useCallback(() => { act()?.resetView() }, [act])

  // 截图（当前格）/ screenshot (the active cell)
  const takeShot = useCallback(async (mode: 'save' | 'copy') => { await act()?.takeShot(mode) }, [act])

  // 时间范围快捷键 / 跳转到日期：作用在当前格；「日期范围」同步开着时作用到每一格。
  // Range presets / go to date: on the active cell, or on every cell while "date range" sync is on.
  const dateTargets = useCallback((): ChartPaneHandle[] => {
    const d = cgRef.current
    const all = d.sync.date && d.grid !== '1' && canMulti
    const idxs = all ? Array.from({ length: mounted.length }, (_, i) => i) : [activeRef.current]
    return idxs.map((i) => handles.current[i]).filter((h): h is ChartPaneHandle => !!h)
  }, [canMulti, mounted.length])
  const applyRange = useCallback((k: RangeKey) => { dateTargets().forEach((h) => h.applyRange(k)) }, [dateTargets])
  const goToTime = useCallback(async (ts: number) => { await Promise.all(dateTargets().map((h) => h.goToTime(ts))) }, [dateTargets])

  // 键盘快捷键（列表见 ShortcutsDialog）/ keyboard shortcuts (listed in ShortcutsDialog)
  useChartHotkeys(cvRef, {
    quickInput: (c) => setQuick(c),
    reset: resetView,
    goto: () => setGotoOpen(true),
    toggleLog: () => setScaleMode(cprefs.scaleMode === 1 ? 0 : 1),
    togglePercent: () => setScaleMode(cprefs.scaleMode === 2 ? 0 : 2),
    toggleInvert: () => updatePrefs({ invertScale: !cprefs.invertScale }),
    scroll: (n) => { const ts = act()?.chart()?.timeScale(); if (ts) ts.scrollToPosition(ts.scrollPosition() + n, false) },
    zoom: (f) => {
      const ts = act()?.chart()?.timeScale()
      if (!ts) return
      ts.applyOptions({ barSpacing: Math.max(0.5, Math.min(60, ts.options().barSpacing * f)) })
    },
    screenshot: () => { void takeShot('save') },
    help: () => setKeysOpen(true),
    alert: () => openAlert({ price: quoteNow().bid ?? undefined }),
  }, !isFullscreen)

  const closeCtx = useCallback(() => setCtx(null), [])
  const doneMeasure = useCallback(() => setMeasureOn(false), [])
  // 专业版左栏：区域放大（每放大一次记下之前的范围，缩小逐级退回）、一键隐藏 / 删除全部指标
  // Pro left bar: zoom-in area (each zoom remembers the previous range; zoom-out steps back) and
  // hide / remove all indicators at once
  const [zoomOn, setZoomOn] = useState(false)
  const endZoom = useCallback(() => setZoomOn(false), [])
  // 换品种 / 周期 / 当前格时收起区域放大与测量 / switching symbol / interval / active cell drops zoom-in and measure
  useEffect(() => { setZoomOn(false) }, [activeSymbol, activeInterval])
  useEffect(() => { setZoomOn(false); setMeasureOn(false) }, [activeIdx])
  const zoomOut = () => { act()?.zoomOut() }
  const indAllHidden = shownList.length > 0 && shownList.every((i) => i.hidden)
  const hideAllIndicators = useCallback((hide: boolean) => {
    updateActiveInd((l) => ({ ...l, list: l.list.map((i) => ({ ...i, hidden: hide || undefined })) }))
  }, [updateActiveInd])
  const removeAllIndicators = useCallback(() => {
    updateActiveInd((l) => l.list.reduce((acc, i) => removeInstance(acc, i.uid), l))
  }, [updateActiveInd])
  const addIndicator = useCallback((type: string) => { updateActiveInd((l) => addInstance(l, type)?.layout ?? l) }, [updateActiveInd])

  // ── 网格 / 同步 / 当前格 / 最大化 / grid / sync / active cell / maximise ──
  const setActivePane = useCallback((i: number) => {
    setCg((d) => (d.active === i ? d : { ...d, active: i }))
  }, [])
  const toggleMax = useCallback((i: number) => {
    setActivePane(i)
    setMaxIdx((m) => (m === i ? null : i))
  }, [setActivePane])
  useBackToClose(maxIdx != null && multi, () => setMaxIdx(null))
  // Esc 还原最大化的格子（焦点在图表区、没有别的浮层先拿走 Esc 时）
  // Escape restores a maximised cell (while focus is in the chart area and nothing else took the key)
  useEffect(() => {
    if (maxIdx == null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const scope = cvRef.current
      if (scope && document.activeElement && !scope.contains(document.activeElement) && document.activeElement !== document.body) return
      setMaxIdx(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [maxIdx])
  // 新格子从当前格复制品种 / 周期 / 图表类型 / 指标 / new cells copy the active cell's symbol / interval / chart type / indicators
  const setGrid = useCallback((g: GridId) => {
    const i = activeRef.current
    const seed: PaneState = { symbol: paneSym(i), interval: paneIv(i), ind: indPart(paneIndRef.current[i] ?? indLayout) }
    const ct = paneType(i)
    if (ct) seed.chartType = ct
    else if (i === 0) seed.chartType = cprefs.chartType
    setCg((d) => withGrid(d, g, seed))
    setMaxIdx(null)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- paneSym / paneIv / paneType read this render's state
  }, [symbol, interval, cg.panes, indLayout, cprefs.chartType])
  // 打开品种 / 周期同步时，先把当前格的值铺到所有格 / turning symbol / interval sync on spreads the active cell's value to all
  const setSync = useCallback((patch: Partial<SyncFlags>) => {
    const i = activeRef.current
    setCg((d) => {
      let next: LayoutDoc = { ...d, sync: { ...d.sync, ...patch } }
      if (patch.symbol) next = patchPanes(next, i, { symbol: i === 0 ? symbol : d.panes[i]?.symbol }, true)
      if (patch.interval) next = patchPanes(next, i, { interval: i === 0 ? interval : d.panes[i]?.interval }, true)
      return next
    })
    if (patch.symbol && i !== 0) { const s = cgRef.current.panes[i]?.symbol; if (s) setSymbol(s) }
    if (patch.interval && i !== 0) { const c = cgRef.current.panes[i]?.interval; if (c) setIntervalCode(c) }
  }, [symbol, interval])
  const onCompareChange = useCallback((i: number, c: CompareEntry[]) => {
    setCg((d) => ({ ...d, panes: d.panes.map((p, j) => (j === i ? { ...p, compare: c } : p)) }))
  }, [])

  // 十字线 / 可见范围同步总线 / the crosshair / visible-range sync bus
  const syncBus = useMemo(() => createSyncBus(), [])
  useEffect(() => { syncBus.setActive(activeIdx) }, [syncBus, activeIdx])
  useEffect(() => {
    syncBus.setFlags({ crosshair: multi && cg.sync.crosshair, time: multi && cg.sync.time })
  }, [syncBus, multi, cg.sync.crosshair, cg.sync.time])

  // 布局保存 / 载入 / 自动保存（第 0 格按全站偏好填进去）/ layout save / load / autosave (cell 0 filled from the app-wide prefs)
  const layoutDoc = useMemo<LayoutDoc>(() => ({
    ...cg,
    active: activeIdx,
    panes: cg.panes.slice(0, MAX_PANES).map((p, i) => (i === 0 ? { ...p, symbol, interval, chartType: cprefs.chartType, ind: indPart(indLayout) } : p)),
  }), [cg, activeIdx, symbol, interval, cprefs.chartType, indLayout])
  const applyLayoutDoc = useCallback((d: LayoutDoc, full: boolean) => {
    const fixIv = (c: string) => (isValidInterval(c) ? c : interval)
    if (full) {
      const p0 = d.panes[0]
      if (p0?.symbol) setSymbol(p0.symbol)
      if (p0?.interval && isValidInterval(p0.interval)) setIntervalCode(p0.interval)
      if (p0?.chartType && CHART_TYPES.has(p0.chartType)) updatePrefs({ chartType: p0.chartType as ChartType })
      if (p0?.ind) {
        const n = normalizeLayout(p0.ind)
        updateInd((g) => ({ ...g, list: n.list, panes: n.panes, mainH: n.mainH }))
      }
    }
    setCg({ ...d, panes: d.panes.map((p, i) => (i === 0 ? p : { ...p, interval: fixIv(p.interval) })) })
    setMaxIdx(null)
  }, [interval, updatePrefs, updateInd])
  const layouts = useChartLayouts({
    ready: loaded,
    doc: layoutDoc,
    fallback: { symbol, interval },
    apply: applyLayoutDoc,
    onError: (m) => showToast(m ? localizeApiError(m) : String(t('charts.layout.err')), 'error'),
    defaultName: String(t('charts.layout.defaultName')),
    copyName: (name) => String(t('charts.layout.copyName', { name })),
    tooBig: String(t('charts.layout.tooBig')),
  })
  // 对比设置弹窗开在哪一格（null = 关）/ which cell's compare dialog is open (null = closed)
  const [cmpIdx, setCmpIdx] = useState<number | null>(null)
  const openCompareFor = useCallback((i: number) => setCmpIdx(i), [])
  useBackToClose(cmpIdx != null, () => setCmpIdx(null))
  const activeCompare = cg.panes[activeIdx]?.compare ?? []

  // 回放 / 对比按钮（当前格）/ replay / compare buttons (the active cell)
  const replayBtn = (cls: string, label = false) => info.replay
    ? <ReplayButton replay={info.replay} disabled={!hasData} className={cls} showLabel={label} />
    : null
  const compareBtn = (cls: string, label = false) => (
    <CompareButton count={activeCompare.length} onClick={() => openCompareFor(activeIdx)} className={cls} showLabel={label} />
  )
  // 专业版右栏「对象树」面板的容器（callback ref → state，当前格把对象树 portal 进来）
  // The pro right panel's object-tree host (callback ref → state; the active cell portals its tree in)
  const [treeHost, setTreeHost] = useState<HTMLDivElement | null>(null)
  const layoutMenu = (variant: 'classic' | 'pro') => canMulti
    ? <LayoutMenu variant={variant} grid={cg.grid} onGrid={setGrid} sync={cg.sync} onSync={setSync} api={layouts} onToast={showToast} />
    : null

  // 手机报价条第二行：左边约 2/3 是常驻的画线工具横条（左右滑动看全部工具），
  // 右边是「指标」和设置齿轮（设置里含显示持仓开关）。底部工具条只留周期与持仓，一行放得下。
  // The mobile quote strip's second row: the left ~2/3 is the always-on draw-tools bar
  // (swipe sideways for every tool); the right holds Indicators and the settings gear (which
  // has the show-positions switch). The bottom toolbar keeps only intervals + positions.
  const mobileTools = (
    <>
      <div className="term-qs-draw">
        {drawReady && <DrawToolsRow variant="strip" drawLayerRef={drawLayerRef} bumpDraw={bumpDraw} t={t} />}
      </div>
      <div className="term-qs-acts">
        <button type="button" onClick={() => setSettingsOpen(true)} className="term-tbr-btn" aria-label={String(t('charts.indicators.button'))}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l5-6 4 4 8-9" /><path d="M3 21h18" /></svg>
          {t('charts.indicators.short')}
        </button>
        <button type="button" onClick={() => setAlertMgrOpen(true)} className="term-tbr-btn alert-tb-btn" aria-label={String(t('charts.alert.manager'))}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 16V11a6 6 0 0112 0v5l2 2H4z" /><path d="M10 21h4" /></svg>
          {activeAlertCount > 0 && <b>{activeAlertCount}</b>}
        </button>
        {compareBtn('term-tbr-btn')}
        {replayBtn('term-tbr-btn')}
        <button type="button" onClick={() => setSheet('data')} className="term-tbr-btn" aria-label={String(t('charts.pro.w.data'))} title={String(t('charts.pro.w.data'))}>
          <IcData size={14} />
        </button>
        <GearButton onClick={() => setChartSetOpen(true)} label={String(t('charts.settings.title'))} />
        <button type="button" onClick={() => setLayout('pro')} className="term-tbr-btn pt-entry" aria-label={String(t('charts.pro.enter'))} title={String(t('charts.pro.enter'))}>
          <IcSpark size={13} />{t('charts.pro.short')}
        </button>
      </div>
    </>
  )

  // ── 专业版终端：命令面板动作、手机标签栏 / pro terminal: palette actions, phone tab bar ──
  const pickSymbolPro = useCallback((s: string) => { setActiveSymbol(s); focusChart() }, [focusChart, setActiveSymbol])
  const pickIntervalPro = useCallback((c: string) => { setActiveInterval(c); focusChart() }, [focusChart, setActiveInterval])
  const addIndicatorPro = useCallback((id: string) => {
    if (defOf(id)?.pro && !isPro) { setSettingsOpen(true); return }
    addIndicator(id)
  }, [addIndicator, isPro])
  const closeCmd = useCallback(() => { setCmd(null); focusChart() }, [focusChart])

  // 返回手势 / 返回键（PWA 与 App）：先收掉最上面那层，再退出专业版，最后才离开图表页。
  // 弹窗类（ChartDialog / ChartPopover / ConfirmModal / 抽屉 / 全屏）各自已接管；这里补上图表页自己的
  // 模式与浮层。Back gesture / key (PWA and App): peel off the top layer first, then leave the pro
  // layout, and only then leave the charts page. Dialogs, popovers, sheets and fullscreen already claim
  // it themselves; these are the page's own modes and floating layers.
  useBackToClose(cmd != null, closeCmd)
  useBackToClose(proDraw, () => setProDraw(false))
  useBackToClose(quick != null, () => setQuick(null))
  useBackToClose(measureOn, () => setMeasureOn(false))
  useBackToClose(zoomOn, () => setZoomOn(false))
  useBackToClose(ctx != null, () => setCtx(null))
  useBackToClose(pro, () => setLayout('classic'))
  const toggleFocus = useCallback(() => updatePro((p) => ({ ...p, focus: !p.focus })), [updatePro])
  const proActions = useMemo<ProAction[]>(() => {
    const L = (k: string) => String(t(k))
    const list: (ProAction | false)[] = [
      { id: 'newAlert', label: L('charts.alert.new'), icon: <IcPlus size={15} />, hint: 'Alt+A', run: () => openAlert({ price: quoteNow().bid ?? undefined }) },
      { id: 'alerts', label: L('charts.alert.manager'), icon: <IcBell size={15} />, run: () => setAlertMgrOpen(true) },
      { id: 'ind', label: L('charts.indicators.button'), icon: <IcFx size={15} />, run: () => setSettingsOpen(true) },
      { id: 'shot', label: L('charts.shot.save'), icon: <IcCamera size={15} />, hint: 'Ctrl+Alt+S', run: () => { void takeShot('save') } },
      { id: 'goto', label: L('charts.goto.title'), icon: <IcCalendar size={15} />, run: () => setGotoOpen(true) },
      { id: 'reset', label: L('charts.ctx.reset'), icon: <IcExpand size={15} />, run: resetView },
      { id: 'settings', label: L('charts.settings.title'), icon: <IcGear size={15} />, run: () => setChartSetOpen(true) },
      isDesktop && { id: 'watch', label: L('charts.pro.w.watch'), icon: <IcList size={15} />, run: () => updatePro({ widget: 'watch', focus: false }) },
      isDesktop && { id: 'trade', label: L('charts.pro.w.trade'), icon: <IcTrade size={15} />, run: () => updatePro({ widget: 'trade', focus: false }) },
      isDesktop && { id: 'dock', label: L('charts.pro.dock'), icon: <IcDock size={15} />, run: () => updatePro((p) => ({ ...p, dockOpen: !p.dockOpen, focus: false })) },
      isDesktop && { id: 'focus', label: L('charts.pro.focus'), icon: <IcFocus size={15} />, run: toggleFocus },
      { id: 'fs', label: L('charts.fullscreen.enter'), icon: <IcExpand size={15} />, run: isDesktop ? toggleDocFs : enterFullscreen },
      isDesktop && { id: 'keys', label: L('charts.keys.title'), icon: <IcKeyboard size={15} />, hint: '?', run: () => setKeysOpen(true) },
      { id: 'classic', label: L('charts.pro.toClassic'), icon: <IcClassic size={15} />, run: () => setLayout('classic') },
    ]
    return list.filter((a): a is ProAction => !!a)
  }, [t, isDesktop, openAlert, quoteNow, takeShot, resetView, updatePro, toggleFocus, toggleDocFs, enterFullscreen, setLayout])
  const proTab: ProTab | null = sheet === 'watchlist' ? 'watch' : sheet === 'positions' ? 'pos' : sheet === 'trade' ? 'trade' : settingsOpen ? 'ind' : proDraw ? 'draw' : null
  const onProTab = useCallback((tab: ProTab) => {
    if (tab === 'draw') { setProDraw((v) => !v); return }
    if (tab === 'ind') { setSettingsOpen(true); return }
    if (tab === 'pos') { setSheetDockTab('positions'); setSheet('positions'); return }
    setSheet(tab === 'watch' ? 'watchlist' : 'trade')
  }, [])

  const openTrade = useCallback((side: Side) => { setTradeSide(side); setSheet('trade') }, [])
  const openWatchlistSheet = useCallback(() => setSheet('watchlist'), [])
  const pickFromSheet = useCallback((s: string) => { setActiveSymbol(s); setSheet(null) }, [setActiveSymbol])

  // 稳定的下单回调：OrderTicket 已 memo，内联箭头函数会让它每次都重渲染。
  // A stable place callback: OrderTicket is memoized and an inline arrow would defeat it.
  const onPlace = useCallback<ComponentProps<typeof OrderTicket>['onPlace']>(
      async (side, volume, mt5Login, stopLoss, takeProfit, coid, orderType, price) => {
        // silent：下单票按钮下面有就地回执，不在屏幕正中再弹同一句（见 hooks.ts 的 SubmitOrderOptions）。
        // silent: the ticket shows an inline receipt under its button; no centred repeat.
        const placed = await placeManualOrder(activeSymbol, side, volume, mt5Login, stopLoss, takeProfit, coid, orderType, price, { silent: true })
        // 只在「这一单是从手机的下单抽屉里下的」时才切。判据就是抽屉当时开在
        // trade 上——桌面右栏下单时 sheet 恒为 null，绝不会误触发（桌面本来就
        // 三栏全见，也没有「切过去」这回事）。
        // Switch only when the order came from the mobile ticket sheet, which is exactly
        // what `sheet === 'trade'` means: on desktop it is always null, so the
        // right-rail ticket can never trip this — and desktop shows all three columns
        // anyway, so there is nothing to switch to.
        // 被拒 / 结果未知的单不切走：那两种情况下用户要看的是下单票底下那条就地
        // 回执（写着为什么失败），切到持仓等于把错误原因从他眼前拿掉，而持仓那边
        // 什么新东西都没有。
        // Don't switch on a rejected or unconfirmed order: there the user needs the
        // inline receipt under the ticket, which says why. Switching hides the reason
        // and shows a positions list that gained nothing.
        const settled = placed && (placed.status === 'REJECTED' || placed.status === 'FAILED')
        if (afterPlaceOpen && !settled && sheetRef.current === 'trade') {
          setSheetDockTab(placed?.action === 'PENDING' ? 'orders' : 'positions')
          setSheet('positions')
          // 抽屉切到持仓，下单票卸载，就地回执也跟着没了：这时补一条 toast，否则这一单没有任何回音。
          // Switching the sheet unmounts the ticket and its inline receipt; toast instead, or the
          // order would get no echo at all.
          reportPlaced(placed)
        }
        return placed
      },
      [placeManualOrder, reportPlaced, activeSymbol, afterPlaceOpen],
  )

  // 图上发起的下单（反手、投影单、买卖按钮）：走同一个 placeManualOrder，结果照常弹提示。
  // 接口报错在这里提示并返回 undefined，调用方当作没成功处理。品种由发起的那一格给出。
  // Orders started on the chart (reverse, projected order, buy / sell buttons) share
  // placeManualOrder and toast as usual. API errors are toasted here and come back undefined.
  // The symbol comes from the cell that started it.
  const chartPlace = useCallback(async (sym: string, r: ChartPlaceReq): Promise<Order | void> => {
    try {
      return await placeManualOrder(sym, r.side, r.volume, r.login, r.sl, r.tp, clientOrderId(), r.type, r.price)
    } catch (e) {
      showToast(e instanceof Error ? localizeApiError(e.message) : String(t('charts.ticket.placeFailed')), 'error')
      return undefined
    }
  }, [placeManualOrder, showToast, t])

  useFillSound(accountOrders, activeSymbol, cprefs.trading.sound)

  // 多空仓位工具的「下单」：按画线的方向、入场、止损、止盈和图上显示的手数直接下单（先弹确认；开了
  // 一键下单就不确认）。入场价离现价近按市价，否则自动选限价 / 止损挂单。没有在线账户时退回填下单票
  // （票上会说明为什么下不了）；全屏时退回图上投影单。
  // The long/short tool's order button places the order straight away from the drawing's side, entry,
  // SL, TP and the lots shown on the chart (after a confirm, skipped with one-click on). Near the market
  // it's a market order, otherwise a limit / stop. With no online account it fills the ticket instead
  // (which explains why); in fullscreen it falls back to the projected order on the chart.
  const [ticketPrefill, setTicketPrefill] = useState<(DraftFill & { nonce: number }) | null>(null)
  const clearTicketPrefill = useCallback(() => setTicketPrefill(null), [])
  const { lastVolume } = useLastVolume()
  const [drawOrder, setDrawOrder] = useState<{ req: ChartPlaceReq; symbol: string; decimals: number } | null>(null)
  const [drawOrderBusy, setDrawOrderBusy] = useState(false)
  // 画线下单确认接返回手势（下单在途时不响应）/ the draw-order confirm claims back (ignored while placing)
  useBackToClose(drawOrder != null && !drawOrderBusy, () => setDrawOrder(null))
  const placeDrawOrder = useCallback(async (job: { req: ChartPlaceReq; symbol: string; decimals: number }) => {
    setDrawOrderBusy(true)
    const placed = await chartPlace(job.symbol, job.req)
    setDrawOrderBusy(false)
    setDrawOrder(null)
    if (!placed) return
    const dec = job.decimals
    if (placed.status === 'PLACED') showToast(String(t('charts.ticket.pendingPlaced', { price: placed.price != null ? placed.price.toFixed(dec) : EMPTY })), 'success')
    else if (placed.status === 'FILLED') showToast(String(t('charts.ticket.filledAt', { price: placed.filledPrice != null ? placed.filledPrice.toFixed(dec) : EMPTY })), 'success')
    else if (placed.status === 'REJECTED' || placed.status === 'FAILED') showToast(placed.message ? localizeApiError(placed.message) : String(t('charts.ticket.placeFailed')), 'error')
    else showToast(String(t(activeAccount?.source === 'gateway' ? 'charts.ticket.acceptedGateway' : 'charts.ticket.accepted')), 'info')
  }, [chartPlace, showToast, t, activeAccount?.source])
  const drawToOrder = useCallback((c: DrawOrderCtx, o: DrawOrderReq) => {
    if (isFullscreen) { c.openDraft(o.side, o.price, o.sl, o.tp); return }
    const f = c.exactDigits != null ? Math.pow(10, c.exactDigits) : null
    const r = (v: number) => (f != null ? Math.round(v * f) / f : v)
    if (!tradeLogin) {
      setTicketPrefill({ nonce: Date.now(), side: o.side, price: r(o.price), sl: r(o.sl), tp: r(o.tp) })
      if (isDesktop) { if (pro) updatePro({ widget: 'trade', focus: false }) } else { setTradeSide(o.side); setSheet('trade') }
      return
    }
    const q = quoteOf(c.symbol)
    const type = draftEntryType(o.side === 'BUY', o.price, q.bid, q.ask)
    const raw = o.volume != null && o.volume > 0 ? o.volume : parseFloat(defaultVolume(lastVolume, c.symbol))
    const req: ChartPlaceReq = {
      side: o.side, volume: clampLots(raw, c.symbol), login: tradeLogin,
      sl: r(o.sl), tp: r(o.tp), type, price: type === 'MARKET' ? null : r(o.price),
    }
    const job = { req, symbol: c.symbol, decimals: c.decimals }
    if (cprefs.trading.oneClick) void placeDrawOrder(job)
    else setDrawOrder(job)
  }, [isFullscreen, tradeLogin, isDesktop, pro, updatePro, quoteOf, lastVolume, cprefs.trading.oneClick, placeDrawOrder])
  const drawOrderMsg = (() => {
    if (!drawOrder) return ''
    const { req, symbol: dSym, decimals: dDec } = drawOrder
    const q = quoteOf(dSym)
    const buy = req.side === 'BUY'
    const typeText = req.type === 'MARKET'
      ? String(t(buy ? 'charts.trade.mktBuy' : 'charts.trade.mktSell'))
      : String(t(`order.pending.type.${req.side}_${req.type}`))
    const px = req.price ?? (buy ? q.ask : q.bid)
    const fx = (v: number | null) => (v != null ? v.toFixed(dDec) : EMPTY)
    return String(t('charts.trade.draftMsg', { type: typeText, symbol: dSym, lots: req.volume.toFixed(lotDecimals(dSym)), price: fx(px), sl: fx(req.sl), tp: fx(req.tp) }))
  })()

  // 各格共用的环境 / the environment every cell shares
  const editInd = useCallback((uid: string) => setEditUid(uid), [])
  const paneEnv = useMemo<PaneEnv>(() => ({
    cprefs, candleColors, dirColors, palette, themeName, lang, markerText, isPro, isDesktop, pro,
    tradeButtons: cprefs.trading.buttons && (isDesktop || pro),
    showPositions, setShowPositions, showCountdown,
    scopeLogin, tradeLogin, accountLogin: activeAccount?.login ?? null,
    balance: activeAccount?.balance ?? null, currency: activeAccount?.accountCurrency ?? '',
    accountOrders, quotesDown: wsDisconnected, peekQuotes, showToast,
    place: chartPlace, drawToOrder, openAlert, bumpDraw, onContextMenu: setCtx, onEditInd: editInd,
    syncBus: multi ? syncBus : null,
    openCompare: openCompareFor,
  }), [cprefs, candleColors, dirColors, palette, themeName, lang, markerText, isPro, isDesktop, pro, showPositions, showCountdown,
    scopeLogin, tradeLogin, activeAccount?.login, activeAccount?.balance, activeAccount?.accountCurrency, accountOrders, wsDisconnected,
    peekQuotes, showToast, chartPlace, drawToOrder, openAlert, bumpDraw, editInd, multi, syncBus, openCompareFor])

  // 下单票自己订阅报价（按账户 + 当前品种的全站报价），这里不再传。
  // The ticket subscribes to its own quotes (per account + the symbol's site-wide one).
  const ticket = (initialSide?: Side) => (
    <OrderTicket
      key={initialSide ?? 'desk'}
      symbol={activeSymbol}
      accounts={accounts}
      refPrice={lastPrice}
      digits={decimals}
      selectedLogin={effectiveLogin}
      onSelectLogin={setSelectedLogin}
      initialSide={initialSide}
      onPlace={onPlace}
      quotesDown={wsDisconnected}
      prefill={ticketPrefill}
      onPrefillUsed={clearTicketPrefill}
    />
  )

  // 只挂在当前格里的页面部件（DOM 顺序与拆分前一致）/ page parts mounted in the active cell only (pre-split DOM order)
  const extrasTop = (
    <>
      {/* 全屏开关（仅手机端）：同一个按钮进出，进入自动横屏，退出恢复竖屏。
          专业版手机从顶栏「更多」进入全屏，这里只留退出。
          Phone fullscreen toggle; the pro phone layout enters from its top bar's More menu,
          so here it only exits. */}
      {(!pro || isFullscreen) && <button
        type="button"
        onClick={isFullscreen ? exitFullscreen : enterFullscreen}
        aria-label={isFullscreen ? t('charts.fullscreen.exit') : t('charts.fullscreen.enter')}
        title={isFullscreen ? t('charts.fullscreen.exit') : t('charts.fullscreen.enter')}
        className="hit-44 lg:hidden absolute top-2 right-2 z-30 flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-ink-900/70 text-neutral-300 backdrop-blur-sm transition hover:text-white hover:border-white/20 active:scale-[0.96] motion-reduce:active:scale-100"
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
      </button>}

      {/* 全屏态时间周期切换：右上角横排 */}
      {isFullscreen && <IntervalSeg variant="fullscreen" value={activeInterval} onChange={setActiveInterval} codes={cprefs.favIntervals} />}
    </>
  )
  const extrasEnd = (
    <>
      {quick != null && (
        <QuickInput
          initial={quick}
          symbols={activeSymbols}
          onInterval={setActiveInterval}
          onSymbol={setActiveSymbol}
          onClose={() => { setQuick(null); focusChart() }}
        />
      )}

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

      {/* 专业版：顶部灵动岛（断线 / 警报触发）+ 手机画线条（标签栏「画线」开合）
          Pro: the top island (offline / alert fired) + the phone draw strip (tab bar "Draw") */}
      {pro && !isFullscreen && (
        <ProIsland down={wsDisconnected} event={island} digits={digitsFor} onOpen={() => (isDesktop ? updatePro({ widget: 'alerts', focus: false }) : setAlertMgrOpen(true))} onDismiss={dismissIsland} />
      )}
      {pro && !isDesktop && !isFullscreen && proDraw && drawReady && (
        <div className="pt-drawbar no-sb">
          <DrawToolsRow variant="strip" drawLayerRef={drawLayerRef} bumpDraw={bumpDraw} t={t} />
        </div>
      )}
    </>
  )
  const tpl = gridTemplate(maxIdx != null && multi ? '1' : cg.grid)
  const treeOpen = pro && isDesktop && !proPrefs.focus && proPrefs.widget === 'tree'
  const dataWin = <LiveDataWindow info={info} timezone={cprefs.timezone} candle={candleColors} />

  return (
    <div
      className={`term-shell ${pro ? `pt ${isDesktop ? 'pt-d' : 'pt-m'} ${proPrefs.focus && isDesktop ? 'pt-focus' : ''} ${proPrefs.widget && !(proPrefs.focus && isDesktop) ? 'has-panel' : ''}` : ''}`}
      style={pro ? ({ '--pt-panel-w': `${proPrefs.panelW}px` } as React.CSSProperties) : undefined}
    >
      <h1 className="sr-only">{t('nav.charts')}</h1>
      {/* 专业版顶栏（经典版是全站顶栏 + 报价条 + 工具条）/ pro top bar (classic: site header + quote strip + toolbar) */}
      {pro && !isFullscreen && (
        <ProTopBar
          desktop={isDesktop}
          symbol={activeSymbol}
          interval={activeInterval}
          digits={decimals}
          dayStats={dayStats}
          fallbackPrice={lastPrice}
          quotesDown={wsDisconnected}
          favIntervals={cprefs.favIntervals}
          onInterval={pickIntervalPro}
          onFavIntervals={setFavIntervals}
          chartType={activeChartType}
          onChartType={setActiveChartType}
          onIndicators={() => setSettingsOpen(true)}
          onAlerts={() => (isDesktop ? updatePro({ widget: 'alerts', focus: false }) : setAlertMgrOpen(true))}
          alertCount={activeAlertCount}
          onCommand={() => setCmd('all')}
          onSymbol={() => (isDesktop ? setCmd('symbols') : setSheet('watchlist'))}
          onShot={() => { void takeShot('save') }}
          onSettings={() => setChartSetOpen(true)}
          onKeys={() => setKeysOpen(true)}
          focus={proPrefs.focus}
          onFocus={toggleFocus}
          fullscreen={isDesktop ? docFs : isFullscreen}
          onFullscreen={isDesktop ? toggleDocFs : enterFullscreen}
          onLayout={setLayout}
          layoutMenu={layoutMenu('pro')}
          tools={<>{compareBtn('pt-icon')}{replayBtn('pt-icon')}</>}
        />
      )}
      {/* 左栏：自选（桌面常驻；手机从报价条的品种名点开抽屉）
          Left column: watchlist (desktop; on mobile it opens as a sheet from the quote strip) */}
      {isDesktop && !pro && (
        <aside className="term-col term-col-left">
          <div className="term-ph"><h3>{t('charts.watchlist.title')}</h3><span>{activeSymbols.length}</span></div>
          <WatchlistPanel
            className="flex min-h-0 flex-1 flex-col"
            symbols={activeSymbols}
            active={activeSymbol}
            onSelect={setActiveSymbol}
            digitsFor={digitsFor}
            quotesDown={wsDisconnected}
          />
        </aside>
      )}

      {/* 中栏：报价条 + [竖轨 | 工具条 / 图表] + 持仓停靠 / center: quote strip + [rail | toolbar / chart] + dock */}
      <section className="term-center">
        {!isFullscreen && !pro && (
          <LiveSymbolHeader
            symbol={activeSymbol}
            interval={activeInterval}
            digits={decimals}
            dayStats={dayStats}
            fallbackPrice={lastPrice}
            stale={stale}
            quotesDown={wsDisconnected}
            onSymbolClick={isDesktop ? undefined : openWatchlistSheet}
            tools={mobileTools}
          />
        )}

        <div ref={cvRef} className={`term-cv ${isDesktop && !isFullscreen ? 'has-bb' : ''}`}>
          {/* 画线竖轨（桌面；全屏时换成悬浮工具栏）。引擎就绪前先占位，免得网格跳动。
              Draw rail (desktop; fullscreen uses the floating toolbar). A placeholder
              holds the column before the engine is ready so the grid doesn't jump. */}
          {/* 经典版与专业版同一条 TradingView 式画线栏（2026-11-26 起；以前经典版是带颜色圆点的
              DrawToolsRow 竖轨，颜色现在都在选中画线的浮动工具条里改）。多图时作用在当前格。
              Classic and pro share the TradingView-style draw bar since 2026-11-26 (classic
              used to have DrawToolsRow's rail with colour dots; colour lives in the floating bar).
              With several charts it acts on the active cell. */}
          {!isFullscreen && (!pro || (isDesktop && !proPrefs.focus)) && (drawReady
            ? (
              <ProDrawRail
                drawLayerRef={drawLayerRef}
                bumpDraw={bumpDraw}
                t={t}
                measureOn={measureOn}
                onMeasure={() => { setZoomOn(false); setMeasureOn((v) => !v) }}
                zoomOn={zoomOn}
                onZoom={() => { setMeasureOn(false); setZoomOn((v) => !v) }}
                canZoomOut={info.canZoomOut}
                onZoomOut={zoomOut}
                indCount={shownList.length}
                indHidden={indAllHidden}
                onHideIndicators={hideAllIndicators}
                positionsShown={showPositions}
                onShowPositions={setShowPositions}
                onRemoveIndicators={removeAllIndicators}
              />
            )
            : <div className="term-rail" />)}

          {/* 工具条：周期钉左；右侧 持仓（手机）· 画笔（手机）· 持仓标记 · 添加指标
              Toolbar: intervals left; positions (mobile) · pen (mobile) · markers · indicators right */}
          {!isFullscreen && !pro && (
            <div className="term-tb" ref={tbRef}>
              <IntervalSeg value={activeInterval} onChange={setActiveInterval} codes={cprefs.favIntervals} />
              <IntervalMenu value={activeInterval} onChange={setActiveInterval} favorites={cprefs.favIntervals} onFavorites={setFavIntervals} />
              <span className="term-toolbar-divider" aria-hidden />
              <ChartTypeMenu value={activeChartType} onChange={setActiveChartType} />
              {/* 多图布局（≥768px）/ multi-chart layout (≥768px) */}
              {canMulti && <>
                <span className="term-toolbar-divider" aria-hidden />
                {layoutMenu('classic')}
              </>}
              {/* 对比 / 回放（桌面；手机在报价条第二行）/ compare / replay (desktop; phones use the quote strip's second row) */}
              {isDesktop && <>
                {compareBtn('term-tool-btn')}
                {replayBtn('term-tool-btn')}
              </>}
              <div className="term-tbr">
                <button type="button" className="term-tbr-btn term-tbr-btn--pos lg:hidden" onClick={() => { setSheetDockTab('positions'); setSheet('positions') }}>
                  {t('charts.openPositions')} <b><PositionsCount scopeLogin={scopeLogin} /></b>
                </button>
                {/* 持仓标记 / 设置 / 指标：手机端搬到报价条第二行（mobileTools），这里只在桌面显示。
                    Markers / settings / indicators: on mobile they move to the quote strip's second
                    row (mobileTools); here they're desktop-only. */}
                <div className="hidden lg:contents">
                  <PositionMarkerToggle on={showPositions} onToggle={() => setShowPositions((v) => !v)} t={t} />
                  <button type="button" className="term-tool-btn" onClick={() => void takeShot('save')} title={`${t('charts.shot.save')} (Ctrl+Alt+S)`} aria-label={String(t('charts.shot.save'))}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
                  </button>
                  <button type="button" className="term-tool-btn alert-tb-btn" onClick={() => setAlertMgrOpen(true)} title={`${t('charts.alert.manager')} (Alt+A)`} aria-label={String(t('charts.alert.manager'))}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 16V11a6 6 0 0112 0v5l2 2H4z" /><path d="M10 21h4" /></svg>
                    {activeAlertCount > 0 && <b>{activeAlertCount}</b>}
                  </button>
                  <GearButton onClick={() => setChartSetOpen(true)} label={String(t('charts.settings.title'))} />
                  <button type="button" onClick={() => setSettingsOpen(true)} className="term-tbr-btn">
                    {t('charts.indicators.button')}
                  </button>
                  {/* 切到专业版终端 / switch to the pro terminal */}
                  <button type="button" onClick={() => setLayout('pro')} className="term-tbr-btn pt-entry" title={String(t('charts.pro.enterTip'))}>
                    <IcSpark size={13} />{t('charts.pro.enter')}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* 图表网格：单图时只有第 0 格，外观与拆分前一样；多图时 2–4 格，当前格描一圈淡紫。
              每格的 tabIndex / role / 浮层见 ChartPane。第 0 格的 key 永远是 0，换外壳、换网格都不重建。
              The chart grid: a single chart mounts only cell 0 and looks as before the split; a
              multi-chart grid mounts 2–4 cells with a faint violet ring on the active one. Each
              cell's tabIndex / role / overlays live in ChartPane. Cell 0's key is always 0, so shell
              or grid switches never rebuild it. */}
          <div
            className={`term-grid${multi ? ' multi' : ''}`}
            data-grid={multi ? (maxIdx != null ? 'max' : cg.grid) : undefined}
            style={multi ? { gridTemplateColumns: tpl.cols, gridTemplateRows: tpl.rows } : undefined}
          >
            {mounted.map((i) => (
              <ChartPane
                key={i}
                ref={paneRefs[i]}
                idx={i}
                env={paneEnv}
                symbol={paneSym(i)}
                interval={paneIv(i)}
                chartType={paneType(i)}
                ind={paneIndList[i] ?? indLayout}
                updateInd={paneIndUpdaters[i]}
                onInterval={paneIntervalSetters[i]}
                active={i === activeIdx}
                multi={multi}
                hidden={!shown.includes(i)}
                area={multi ? cellArea(cg.grid, i) : undefined}
                maximised={multi && maxIdx === i}
                fullscreen={isFullscreen && i === activeIdx}
                measureOn={measureOn && i === activeIdx}
                zoomOn={zoomOn && i === activeIdx}
                onMeasureDone={doneMeasure}
                onZoomEnd={endZoom}
                onActivate={setActivePane}
                onToggleMax={toggleMax}
                onInfo={onPaneInfo}
                extrasTop={i === activeIdx ? extrasTop : undefined}
                extrasEnd={i === activeIdx ? extrasEnd : undefined}
                compare={cg.panes[i]?.compare}
                onCompareChange={onCompareChange}
                treeHost={i === activeIdx && treeOpen ? treeHost : null}
              />
            ))}
            {/* 触屏拖动画线点 / 止盈止损线时的放大镜（全局只挂一个）/ the touch-drag loupe (one for the page) */}
            {drawReady && <ChartLoupe />}
          </div>

          {isDesktop && !isFullscreen && (
            <ChartBottomBar
              timezone={cprefs.timezone}
              onTimezone={(tz) => updatePrefs({ timezone: tz })}
              scaleMode={cprefs.scaleMode}
              onScaleMode={setScaleMode}
              onAutoScale={autoScale}
              onRange={applyRange}
              onGoToDate={() => setGotoOpen(true)}
              busy={info.rangeBusy}
            />
          )}
        </div>

        {chartSetOpen && (
          <ChartSettingsDialog
            prefs={cprefs}
            update={updatePrefs}
            reset={resetPrefs}
            candleColors={candleColors}
            onCandleColors={changeCandleColors}
            showCountdown={showCountdown}
            onShowCountdown={setShowCountdown}
            showPositions={showPositions}
            onShowPositions={setShowPositions}
            afterPlaceOpen={afterPlaceOpen}
            onAfterPlaceOpen={setAfterPlaceOpen}
            onClose={() => setChartSetOpen(false)}
          />
        )}
        {gotoOpen && <GoToDateDialog timezone={cprefs.timezone} onGo={(ts) => { void goToTime(ts) }} onClose={() => { setGotoOpen(false); focusChart() }} />}
        {keysOpen && <ShortcutsDialog onClose={() => { setKeysOpen(false); focusChart() }} />}
        {drawOrder && (
          <ConfirmModal
            title={String(t('charts.trade.draftTitle'))}
            message={drawOrderMsg}
            confirmLabel={String(t('charts.trade.toOrderShort'))}
            busy={drawOrderBusy}
            center
            onConfirm={() => { void placeDrawOrder(drawOrder) }}
            onCancel={() => setDrawOrder(null)}
          />
        )}
        {alertMgrOpen && (
          <AlertManager
            symbol={activeSymbol}
            bid={alertBid}
            onNew={() => openAlert({ price: quoteNow().bid ?? undefined })}
            onEdit={(a, clone) => openAlert({ edit: a, clone })}
            onPickSymbol={pickSymbolLoose}
            onToast={showToast}
            onClose={() => { setAlertMgrOpen(false); focusChart() }}
          />
        )}
        {alertInit && (
          <AlertDialog
            init={alertInit}
            symbol={activeSymbol}
            digits={decimals}
            chartInterval={activeInterval}
            indicators={shownList}
            drawings={drawLayerRef.current?.getDrawings() ?? []}
            bid={alertBid}
            onClose={() => { setAlertInit(null); if (!alertMgrOpen) focusChart() }}
            onSaved={(a, created) => showToast(String(t(created ? 'charts.alert.created' : 'charts.alert.saved', { msg: a.message })), 'success')}
          />
        )}
        {ctx && (
          <ChartContextMenu
            state={ctx}
            onClose={closeCtx}
            decimals={decimals}
            actions={{
              reset: resetView,
              copyPrice: (pr) => { void navigator.clipboard?.writeText(pr.toFixed(decimals)).then(() => showToast(t('charts.ctx.copied'), 'success')).catch(() => {}) },
              goto: () => setGotoOpen(true),
              screenshot: () => { void takeShot('save') },
              copyShot: canCopyImage() ? () => { void takeShot('copy') } : null,
              settings: () => setChartSetOpen(true),
              help: () => setKeysOpen(true),
              autoScale,
              scaleMode: cprefs.scaleMode,
              setScaleMode,
              invert: cprefs.invertScale,
              setInvert: (v) => updatePrefs({ invertScale: v }),
              orderAt: tradeLogin ? (side, price) => act()?.openDraft(side, price) : null,
              alertAt: (price) => openAlert({ price }),
              orderLabel: (side, price) => {
                const q = quoteNow()
                return String(t(`order.pending.type.${side}_${autoEntryType(side, price, q.bid, q.ask)}`))
              },
            }}
          />
        )}

        {/* 持仓 / 挂单停靠（桌面；手机走底部抽屉）/ positions dock (desktop; mobile uses the sheet) */}
        {isDesktop && !isFullscreen && !pro && (
          <div className="hidden lg:flex lg:flex-shrink-0 lg:flex-col">
            <LiveDock scopeLogin={scopeLogin} orders={accountOrders} digitsFor={digitsFor} onToast={showToast} mt5Login={closeAllLogin} accountLabel={closeAllLabel} />
          </div>
        )}
        {/* 专业版交易面板：可拖高、可从右侧图标栏收起 / pro trading panel: resizable, toggled from the strip */}
        {pro && isDesktop && proPrefs.dockOpen && !proPrefs.focus && (
          <ProDock height={proPrefs.dockH} onHeight={(h) => updatePro({ dockH: h })}>
            <LiveDock scopeLogin={scopeLogin} orders={accountOrders} digitsFor={digitsFor} onToast={showToast} mt5Login={closeAllLogin} accountLabel={closeAllLabel} />
          </ProDock>
        )}

        {/* 手机端底部交易条：卖 | 点差 | 买，点开下单票抽屉
            Mobile trade bar: sell | spread | buy, opens the ticket sheet */}
        {!isDesktop && !isFullscreen && !pro && (
          <MobileTradeBar symbol={activeSymbol} decimals={decimals} lastPrice={lastPrice} onTrade={openTrade} quotesDown={wsDisconnected} />
        )}
        {pro && !isDesktop && !isFullscreen && (
          <ProTabBar active={proTab} onTab={onProTab} posBadge={<PositionsBadge scopeLogin={scopeLogin} className="pt-tab-badge" />} />
        )}
      </section>

      {/* 专业版右侧：面板 + 图标栏 / pro right side: panel + icon strip */}
      {pro && isDesktop && (
        <ProWidgets
          widget={proPrefs.focus ? null : proPrefs.widget}
          onWidget={(w) => updatePro({ widget: w, focus: false })}
          width={proPrefs.panelW}
          onWidth={(px) => updatePro({ panelW: px })}
          watch={<ProWatchlist symbols={activeSymbols} active={activeSymbol} onSelect={pickSymbolPro} digitsFor={digitsFor} quotesDown={wsDisconnected} />}
          details={<ProDetails symbol={activeSymbol} digits={decimals} dayStats={dayStats} fallback={lastPrice} stale={stale} down={wsDisconnected} timezone={cprefs.timezone} />}
          data={dataWin}
          tree={<div ref={setTreeHost} className="pt-tree-host" />}
          trade={<>{ticket()}<AccountSummary account={activeAccount} /></>}
          alerts={(
            <ProAlerts
              symbol={activeSymbol}
              bid={alertBid}
              onNew={() => openAlert({ price: quoteNow().bid ?? undefined })}
              onEdit={(a) => openAlert({ edit: a })}
              onManage={() => setAlertMgrOpen(true)}
              onPickSymbol={pickSymbolLoose}
              onToast={showToast}
            />
          )}
          alertCount={activeAlertCount}
          onKeys={() => setKeysOpen(true)}
          dockOpen={proPrefs.dockOpen && !proPrefs.focus}
          onDock={() => updatePro((p) => ({ ...p, dockOpen: p.focus ? true : !p.dockOpen, focus: false }))}
          posBadge={<PositionsBadge scopeLogin={scopeLogin} className="pt-strip-badge" />}
        />
      )}

      {/* 右栏：下单票 + 账户条（桌面常驻）。票占剩余高度并可内部滚动，账户条钉底。
          Right column: ticket + account strip (desktop). The ticket takes the
          remaining height and scrolls internally; the strip stays pinned at the bottom. */}
      {isDesktop && !pro && (
        <aside className="term-col term-col-right">
          <div className="term-ph"><h3>{t('charts.ticket.title')}</h3><span>{activeSymbol || EMPTY}</span></div>
          {ticket()}
          <AccountSummary account={activeAccount} />
        </aside>
      )}

      {/* 手机端抽屉：走 portal 挂到 body——页面切换动画（.page-enter）会给 <main>
          造一个层叠上下文，抽屉留在里面的话 z-index 再高也压不过全站底栏（z-40）。
          Mobile sheets are portalled to body: the page-enter animation gives
          <main> its own stacking context, inside which no z-index beats the app
          tab bar (z-40). */}
      {shownSheet && createPortal(
        <>
          <div ref={termScrimRef} className={`term-scrim${termSheet.closing ? ' closing' : ''}`} onClick={() => setSheet(null)} />
          <div ref={termSheetRef} className={`term-sheet${termSheet.closing ? ' closing' : ''}`} role="dialog" aria-modal="true" aria-labelledby={termSheetTitleId} tabIndex={-1} {...termDrag}>
            {/* 把手：拖拽区的一部分（见 terminal.css .term-sheet-grab）。
                The handle is part of the drag zone (see .term-sheet-grab in terminal.css). */}
            <div className="term-sheet-grab" aria-hidden="true" />
            {/* 抽屉头：标题与副信息靠左成一组，右侧是关闭按钮——抽屉本身没有别的退出手势
                提示，点遮罩关闭对不少用户并不显然。
                Sheet head: title and meta grouped on the left, a close button on the right —
                the sheet offers no other visible way out, and tapping the scrim isn't obvious. */}
            <div className="term-ph term-sheet-ph">
              <div className="term-sheet-ttl">
                <h3 id={termSheetTitleId}>{shownSheet === 'watchlist' ? t('charts.watchlist.title') : shownSheet === 'trade' ? t('charts.sheetTicket') : shownSheet === 'data' ? t('charts.pro.w.data') : t('charts.openPositions')}</h3>
                <span>{shownSheet === 'watchlist' ? activeSymbols.length : shownSheet === 'trade' ? `${activeSymbol} · ${activeAccount ? `#${activeAccount.login}` : ''}` : shownSheet === 'data' ? activeSymbol : <PositionsCount scopeLogin={scopeLogin} />}</span>
              </div>
              {/* 「下单后自动打开」就放在它自己弹出来的这张抽屉的抬头里：嫌它烦的人
                  正好在这儿，不用去设置页里找一个自己都不知道叫什么的开关。
                  The "open after placing" switch sits in the header of the sheet that
                  does the popping — whoever is annoyed by it is already looking here,
                  instead of hunting a settings page for a name they don't know. */}
              {shownSheet === 'positions' && (
                <label className="term-sheet-pref">
                  <span>{t('charts.autoOpenAfterPlace')}</span>
                  <Switch checked={afterPlaceOpen} onChange={setAfterPlaceOpen} aria-label={String(t('charts.autoOpenAfterPlace'))} />
                </label>
              )}
              <button type="button" className="term-sheet-x" onClick={() => setSheet(null)} aria-label={t('common.close')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <div className="term-sheet-body no-sb">
              {/* 手机「行情」抽屉用专业版同一张行情表（品种图标、多周期趋势、分组、列设置），
                  两边不再各长各的 / The phone sheet uses the pro terminal's quote table so the two stay in sync */}
              {shownSheet === 'watchlist' && (
                <ProWatchlist
                  mobile
                  symbols={activeSymbols}
                  active={activeSymbol}
                  onSelect={pickFromSheet}
                  digitsFor={digitsFor}
                  quotesDown={wsDisconnected}
                />
              )}
              {shownSheet === 'data' && dataWin}
              {shownSheet === 'trade' && (
                <>
                  {ticket(tradeSide)}
                  <AccountSummary account={activeAccount} />
                </>
              )}
              {shownSheet === 'positions' && (
                <LiveDock scopeLogin={scopeLogin} orders={accountOrders} digitsFor={digitsFor} onToast={showToast} mt5Login={closeAllLogin} accountLabel={closeAllLabel} initialTab={sheetDockTab} />
              )}
            </div>
          </div>
        </>,
        document.body,
      )}

      {indDialog.shown && (
        <IndicatorDialog
          closing={indDialog.closing}
          layout={activeInd}
          update={updateActiveInd}
          isPro={isPro}
          onAdd={addIndicator}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {indEditor.shown && (
        <IndicatorEditor
          uid={indEditor.shown}
          closing={indEditor.closing}
          layout={activeInd}
          interval={activeInterval}
          candle={candleColors}
          symbols={activeSymbols}
          onChange={(next) => updateActiveInd((l) => updateInstance(l, next.uid, () => next))}
          onSaveDefault={(i) => updateActiveInd((l) => ({ ...l, defaults: { ...l.defaults, [i.type]: { inputs: i.inputs, styles: i.styles } } }))}
          onClose={() => setEditUid(null)}
        />
      )}

      {cmpIdx != null && (
        <CompareDialog
          symbols={activeSymbols}
          mainSymbol={paneSym(cmpIdx)}
          entries={cg.panes[cmpIdx]?.compare ?? []}
          onChange={(next) => onCompareChange(cmpIdx, next)}
          onClose={() => { setCmpIdx(null); focusChart() }}
        />
      )}

      {pro && (
        <ProCommand
          open={cmd != null}
          mode={cmd ?? 'all'}
          onClose={closeCmd}
          symbols={activeSymbols}
          activeSymbol={activeSymbol}
          interval={activeInterval}
          onSymbol={pickSymbolPro}
          onInterval={pickIntervalPro}
          onIndicator={addIndicatorPro}
          isPro={isPro}
          actions={proActions}
        />
      )}

      {toast && (
        <Toast key={toast.id} toast={toast} />
      )}
    </div>
  )
}


// 手机端底部交易条：卖 | 点差 | 买。自己订阅当前品种的报价，跳价只重画这一条。
// Mobile trade bar: sell | spread | buy. Subscribes to the active symbol's quote itself,
// so a tick repaints just this bar.
function MobileTradeBar({ symbol, decimals, lastPrice, onTrade, quotesDown }: {
  symbol: string
  decimals: number
  lastPrice: number
  onTrade: (side: Side) => void
  quotesDown: boolean
}) {
  const { t } = useTranslation()
  const q = useGlobalQuote(symbol)
  const px = (v: number | null | undefined) => (v != null ? v.toFixed(decimals) : lastPrice ? lastPrice.toFixed(decimals) : EMPTY)
  const spreadPts = q && q.ask >= q.bid ? Math.round((q.ask - q.bid) * Math.pow(10, decimals)) : null
  return (
    <div className={`term-mbar ${quotesDown ? 'quotes-down' : ''}`}>
      {/* 手机上报价条的状态位是隐藏的（terminal.css 里 .term-qs-live 在 ≤1023px 不显示），断线只能写在这里。
          The quote strip's status is hidden on phones (.term-qs-live at ≤1023px), so the disconnect is stated here. */}
      {quotesDown && <p className="term-mbar-down">{t('charts.quotesDown')}</p>}
      <button type="button" className="sell" onClick={() => onTrade('SELL')}>
        <span className="lab">{t('charts.ticket.sell')}</span>
        <span className="px"><PipText s={px(q?.bid)} /></span>
      </button>
      <div className="sp">{t('charts.ticket.spreadUnit')}<b>{spreadPts ?? EMPTY}</b></div>
      <button type="button" className="buy" onClick={() => onTrade('BUY')}>
        <span className="lab">{t('charts.ticket.buy')}</span>
        <span className="px"><PipText s={px(q?.ask)} /></span>
      </button>
    </div>
  )
}

// 价格末两位加粗（点位）/ bold the last two digits (the pips)
function PipText({ s }: { s: string }) {
  if (s.length < 3 || s === EMPTY) return <>{s}</>
  return <>{s.slice(0, -2)}<b>{s.slice(-2)}</b></>
}
