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
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import type { Time } from 'lightweight-charts'
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
import DrawLayer, { type DrawLayerHandle } from '../components/charts/DrawLayer'
import IndicatorDialog from '../components/charts/ind/IndicatorDialog'
import IndicatorEditor from '../components/charts/ind/IndicatorEditor'
import Toast from '../components/Toast'
import Switch from '../components/Switch'
import SymbolHeader from '../components/charts/SymbolHeader'
import WatchlistPanel from '../components/charts/WatchlistPanel'
import AccountSummary from '../components/charts/AccountSummary'
import OrderTicket from '../components/charts/OrderTicket'
import PositionsDock from '../components/charts/PositionsDock'
import PositionOverlay, { type DraftRequest } from '../components/charts/PositionOverlay'
import TradeButtons from '../components/charts/trade/TradeButtons'
import PlusOrderButton from '../components/charts/trade/PlusOrderButton'
import ExecutionMarkers from '../components/charts/trade/ExecutionMarkers'
import { useFillSound } from '../components/charts/trade/useFillSound'
import { autoEntryType } from '../components/charts/trade/tradeMath'
import type { ChartPlace } from '../components/charts/trade/useTradeActions'
import type { SymbolSpec } from '../components/order/orderMath'
import { brokerSymbol, clientOrderId, localizeApiError } from '../api/utils'
import DrawToolsRow from '../components/charts/DrawToolsRow'
import PositionMarkerToggle from '../components/charts/PositionMarkerToggle'
import IntervalSeg from '../components/charts/IntervalSeg'
import PaneLegends, { type LegendActions } from '../components/charts/ind/PaneLegends'
import { useIndLayout } from '../components/charts/ind/useIndLayout'
import { defOf } from '../components/charts/ind/registry'
import { MK_KEYS } from '../components/charts/ind/registry3'
import { addInstance, duplicateInstance, moveInstance, movePane, removeInstance, removePane, setPane, updateInstance } from '../components/charts/ind/store'
import FullscreenToolbar from '../components/charts/FullscreenToolbar'
import BarCountdown from '../components/charts/BarCountdown'
import ChartSettingsDialog from '../components/charts/ChartSettingsDialog'
import IntervalMenu from '../components/charts/IntervalMenu'
import ChartTypeMenu from '../components/charts/ChartTypeMenu'
import ChartLegend from '../components/charts/ChartLegend'
import ChartBottomBar, { RANGE_INTERVAL, rangeFrom, type RangeKey } from '../components/charts/ChartBottomBar'
import GoToDateDialog from '../components/charts/GoToDateDialog'
import ShortcutsDialog from '../components/charts/ShortcutsDialog'
import QuickInput from '../components/charts/QuickInput'
import ChartPriceLines from '../components/charts/ChartPriceLines'
import MeasureOverlay from '../components/charts/MeasureOverlay'
import BackToLatest from '../components/charts/BackToLatest'
import ChartContextMenu, { type CtxState } from '../components/charts/ChartContextMenu'
import { SessionBreaks } from '../components/charts/sessionBreaks'
import { useChartHotkeys } from '../components/charts/useChartHotkeys'
import { useChartPrefs } from '../components/charts/useChartPrefs'
import { CHART_PALETTES, resolveChartTheme } from '../components/charts/chartTheme'
import { makeTimeFormatters } from '../components/charts/chartTime'
import { PRICE_BASED_TYPES, normalizeChartPrefs, type ScaleMode } from '../components/charts/chartPrefs'
import { intervalKind, intervalLabel, isValidInterval } from '../components/charts/intervals'
import { canCopyImage, composeScreenshot, copyScreenshot, saveScreenshot, type ShotResult } from '../components/charts/chartScreenshot'
import { useChartFullscreen } from '../components/charts/useChartFullscreen'
import { useChartEngine, type ChartView, type IndView } from '../components/charts/useChartEngine'
import { useChartData, withLiveClose } from '../components/charts/useChartData'
import { useAccountQuotesSelect, useGlobalQuote, useGlobalQuotesPeek, useGlobalQuotesSelect, usePendingOrders, usePositions } from '../store/live'
import type { Order, Quote } from '../api/types'
import type { Side } from '../components/order/useOrderForm'
import {
  FALLBACK_DECIMALS, INTERVAL_KEY, SYMBOL_KEY, isKnownInterval,
  priceDigits, resolvePriceDigits, intervalSeconds, MAX_CLIENT_BARS, INTERVALS,
  normalizeCandleColors, type CandleColors,
} from '../components/charts/chartConfig'
import { readStorage } from '../utils/safeStorage'
import { isAppHidden } from '../utils/appVisibility'
import { serverNowMs } from '../utils/serverClock'
// 本页专属样式：跟着本页 chunk 按需加载，不进首屏的全站 CSS（见 styles/index.css 文件头）。
import '../styles/terminal.css'
import '../styles/chart-alerts.css'
import AlertLines from '../components/charts/alert/AlertLines'
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
import ProCommand, { type ProAction, type ProCommandMode } from '../components/charts/pro/ProCommand'
import { ProDock, ProIsland, ProTabBar, type IslandEvent, type ProTab } from '../components/charts/pro/ProChrome'
import { IcBell, IcCamera, IcClassic, IcDock, IcExpand, IcFocus, IcFx, IcGear, IcKeyboard, IcList, IcPlus, IcSpark, IcTrade, IcCalendar } from '../components/charts/pro/icons'


type Sheet = 'watchlist' | 'trade' | 'positions' | null

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

// 按账户过滤持仓 / 挂单：scopeLogin 为 null 即不过滤（单账户或数据不带 login，见
// ChartsPage 里 scopeLogin 的说明）。/ Positions / pending orders scoped to an
// account; null means unscoped (see scopeLogin in ChartsPage).
function useScopedPositions(scopeLogin: string | null) {
  const positions = usePositions()
  return useMemo(
    () => (scopeLogin ? positions.filter((p) => String(p.login ?? '') === String(scopeLogin)) : positions),
    [positions, scopeLogin],
  )
}
function useScopedPendingOrders(scopeLogin: string | null) {
  const pendingOrders = usePendingOrders()
  return useMemo(
    () => (scopeLogin ? pendingOrders.filter((o) => String(o.login ?? '') === String(scopeLogin)) : pendingOrders),
    [pendingOrders, scopeLogin],
  )
}

// 下单账户这个品种的券商合约规格（拖动读数、盈亏换算用）。只订阅三个数拼成的字符串，跳价不重渲染。
// The trading account's contract spec for the symbol (readouts, P/L maths). Subscribes to a
// string of the three numbers only, so ticks don't re-render.
function useSymbolSpec(login: string | null, symbol: string): SymbolSpec {
  const key = useAccountQuotesSelect((m) => {
    if (!login) return ''
    const q = m[login]?.[symbol] ?? m[login]?.[brokerSymbol(symbol)]
    return q && q.tickSize && q.tickValue ? `${q.contractSize ?? 0}|${q.tickSize}|${q.tickValue}` : ''
  })
  return useMemo(() => {
    if (!key) return undefined
    const [c, ts, tv] = key.split('|').map(Number)
    return { contractSize: c > 0 ? c : undefined, tickSize: ts, tickValue: tv }
  }, [key])
}

type OverlayProps = Omit<ComponentProps<typeof PositionOverlay>, 'positions' | 'pendingOrders' | 'spec'> & { scopeLogin: string | null }
function LiveOverlay({ scopeLogin, ...rest }: OverlayProps) {
  const positions = useScopedPositions(scopeLogin)
  const pendingOrders = useScopedPendingOrders(scopeLogin)
  const spec = useSymbolSpec(rest.login, rest.symbol)
  return <PositionOverlay {...rest} spec={spec} positions={positions} pendingOrders={pendingOrders} />
}

type ExecProps = Omit<ComponentProps<typeof ExecutionMarkers>, 'positions'> & { scopeLogin: string | null }
function LiveExecutions({ scopeLogin, ...rest }: ExecProps) {
  const positions = useScopedPositions(scopeLogin)
  return <ExecutionMarkers {...rest} positions={positions} />
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

// 实时 K 线收盘：券商 bid 一跳，最新一根的 close 立刻跟着动，并把 bid 留给轮询用。
// 跨过 K 线边界后的第一跳直接在本地开新 bar（o=h=l=c=bid），不再等开盘后 ~3.3 秒的边界补拉
// 才"卡一下"冒出来；零额外请求，随后的轮询按同一时间戳覆盖校正 O/H/L。只对按 epoch 对齐的
// 周期（intervalSeconds）做，4H / 日线边界取决于券商时区，仍靠轮询。
// Live bar close: each broker bid tick moves the forming bar's close and is kept for the poll.
// The first tick past a bar boundary opens the new bar locally (o=h=l=c=bid) instead of waiting
// ~3.3s for the boundary poll (the visible "hitch"); no extra requests, and the next poll
// overwrites it by timestamp. Epoch-aligned intervals only; 4H / daily still rely on the poll.
// dataKeyRef：图表里现有 K 线属于哪个「品种|周期」（useChartData 写）。切品种时本组件（子）的
// effect 先于页面清空旧数据执行，不比对的话新品种的 bid 会被钉到旧品种最后一根上，拉出一根巨柱。
// dataKeyRef: which "symbol|interval" the loaded candles belong to (written by useChartData). On a
// symbol switch this child's effect runs before the page clears the old data; without the check the
// new symbol's bid was stamped onto the old symbol's last bar, drawing one giant candle.
function LiveBarSync({ symbol, interval, engine, liveBidRef, dataKeyRef }: { symbol: string; interval: string; engine: ReturnType<typeof useChartEngine>; liveBidRef: { current: number | null }; dataKeyRef: { current: string } }) {
  const bid = useGlobalQuote(symbol)?.bid ?? null
  // 上一次处理过的 bid。engine 每次渲染都是新对象，页面一重渲染本 effect 就重跑——只有 bid 真的
  // 变了才算一跳。以前重跑也照样开新 bar：页面在后台时全站报价不更新（live.tsx 丢弃后台帧），
  // 可页面仍在重渲染，每过一个边界就拿过期 bid 开一根 o=h=l=c 的 bar，图上一排横线、刷新才好
  // （2026-11-25 用户截图）。
  // The last bid handled. engine is a new object every render, so this effect re-runs whenever
  // the page re-renders; only a real bid change counts as a tick. Re-runs used to open bars too:
  // while hidden the site-wide quotes freeze (live.tsx drops background frames) but the page still
  // re-renders, so each boundary opened an o=h=l=c bar from the stale bid — a row of flat dashes
  // until refresh (2026-11-25 user report).
  const handledBidRef = useRef<number | null>(null)
  useEffect(() => { liveBidRef.current = null; handledBidRef.current = null }, [symbol, liveBidRef])
  useEffect(() => {
    liveBidRef.current = bid
    const isTick = bid !== handledBidRef.current
    handledBidRef.current = bid
    if (!isTick || isAppHidden()) return
    const arr = engine.candlesRef.current
    const series = engine.seriesRef.current
    if (bid == null || !series || arr.length === 0 || dataKeyRef.current !== `${symbol}|${interval}`) return
    const last = arr[arr.length - 1]
    if (last.t !== engine.lastTimeRef.current) return
    const iv = intervalSeconds(interval)
    if (iv != null) {
      // 用服务器校准过的时钟：手机时间不准时，Date.now() 会把新 bar 开早 / 开晚。
      // Server-calibrated clock: a skewed device clock opened bars early / late with Date.now().
      const openT = Math.floor(serverNowMs() / 1000 / iv) * iv
      // 只开紧挨着的下一根：差太多说明数据断档 / 休市，交给轮询。
      // Only the immediately next bar; a bigger gap means a data hole / closed market — leave it to the poll.
      if (openT === last.t + iv) {
        // 开盘价取上一根的收盘（边界前最后一跳），而不是边界后这一跳：报价是连续的，真实开盘价
        // 几乎就是它；用 bid 做 o=h=l=c 会画出一条悬空的横线，等轮询回来再"跳"成正常蜡烛。
        // Open at the previous close (the last tick before the boundary), not this tick: quotes
        // are continuous, so that is ~the real open. o=h=l=c=bid drew a floating dash that then
        // "jumped" into a normal candle when the poll landed.
        const o = last.c
        const bar = { t: openT, o, h: Math.max(o, bid), l: Math.min(o, bid), c: bid, v: 0 }
        arr.push(bar)
        if (arr.length > MAX_CLIENT_BARS) arr.shift()
        engine.lastTimeRef.current = openT
        engine.renderTail()
        engine.recomputeIndicators()
        if (engine.isFollowingLiveRef.current) engine.chartRef.current?.timeScale().scrollToRealTime()
        return
      }
      // 最后一根已经是好几根之前的了（App 冻在后台刚回来）：别把现价钉到它身上——那会把一根旧蜡烛
      // 拉成一根几十点的大阳线，看着像跳空（2026-10-08 100502 截图）。等轮询发现缺口、重拉尾部历史。
      // The last bar is several bars old (the app just came back from being frozen): don't pin the
      // live bid onto it — that stretched an old candle into a tall bar that looked like a gap
      // (2026-10-08, login 100502). The poll spots the hole and refills the tail.
      if (openT > last.t + iv) return
    }
    const next = withLiveClose(last, bid)
    if (next.c === last.c && next.h === last.h && next.l === last.l) return
    arr[arr.length - 1] = next
    engine.renderTail()
  }, [bid, symbol, interval, engine, liveBidRef, dataKeyRef])
  return null
}

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
  const [indLayout, updateInd] = useIndLayout()
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 正在编辑设置的实例 / the instance whose settings dialog is open
  const [editUid, setEditUid] = useState<string | null>(null)
  // 最大化的窗格（不存盘）/ maximised pane (not persisted)
  const [maxPane, setMaxPane] = useState<string | null>(null)
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
  // 专业版终端开关（存在 chartv2 / pro，跨设备同步）。两套外壳共用同一个图表容器：
  // 下面所有外壳部件都是「条件槽位」，图表容器在 React 树里的位置不变，切换时不会重建图表。
  // The pro terminal switch (chartv2 / pro, synced). Both shells share one chart container:
  // every shell part below is a conditional slot, so the container keeps its place in the
  // React tree and switching never rebuilds the chart.
  const [proPrefs, updatePro] = useProPrefs()
  const pro = proPrefs.layout === 'pro'
  const setLayout = useCallback((l: ProLayout) => updatePro({ layout: l }), [updatePro])
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
  const exactDigits = useGlobalQuotesSelect((q) => resolvePriceDigits(symbol, symbol ? q[symbol] : undefined))
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
  const quoteNow = useCallback(() => {
    const q = peekQuotes()[symbol]
    return { bid: q?.bid ?? null, ask: q?.ask ?? null }
  }, [peekQuotes, symbol])
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

  // /charts?symbol=XAUUSD（警报通知点进来）：云端偏好到了之后切过去，再把参数抹掉。
  // 品种名大小写按活跃列表对齐（警报里存的是大写）。
  // /charts?symbol=XAUUSD (from an alert notification): switch once cloud prefs are in, then drop
  // the param. Case is matched against the active list (alerts store upper case).
  const [searchParams, setSearchParams] = useSearchParams()
  const wantSymbol = searchParams.get('symbol')
  const pickSymbolLoose = useCallback((s: string) => {
    const up = s.toUpperCase()
    setSymbol(activeSymbols.find((x) => x.toUpperCase() === up) ?? s)
  }, [activeSymbols])
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
  const shownList = useMemo(
    () => (isPro ? indLayout.list : indLayout.list.filter((i) => !defOf(i.type)?.pro)),
    [indLayout.list, isPro],
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
  // 图表现在从不被藏起，refitKey 只在进出全屏时变（那两次容器尺寸确实变了）。
  // Chart instance / indicator series / legend / panes → useChartEngine; history /
  // paging / polling → useChartData. The chart is never hidden any more, so the
  // refit key only changes on entering/leaving fullscreen (a real resize).
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
  const ivKind = intervalKind(interval)
  const timeFmt = useMemo(() => makeTimeFormatters(cprefs.timezone, ivKind, lang), [cprefs.timezone, ivKind, lang])
  // 画线层：轴标签 / 坐标页签的时间格式与画布底色 / drawing layer: time labels and canvas colours
  const drawFmtTime = useCallback((x: number) => timeFmt.crosshair(x as Time), [timeFmt])
  const drawTheme = useMemo(() => ({ bg: palette.bg, text: palette.text }), [palette.bg, palette.text])
  const watermark = cprefs.canvas.watermark && symbol ? `${symbol} · ${intervalLabel(interval)}` : null
  const view = useMemo<ChartView>(() => ({
    chartType: cprefs.chartType,
    palette,
    candle: cprefs.candle,
    lineWidth: cprefs.lineWidth,
    lineColor: cprefs.lineColor,
    scaleMode: cprefs.scaleMode,
    invertScale: cprefs.invertScale,
    grid: cprefs.canvas.grid,
    crosshair: cprefs.canvas.crosshair,
    crossStyle: cprefs.canvas.crossStyle,
    rightOffset: cprefs.canvas.rightOffset,
    lastPrice: cprefs.lines.lastPrice,
    indicatorLabels: cprefs.lines.indicatorLabels,
    transform: cprefs.transform,
    watermark,
    time: timeFmt,
  }), [cprefs.chartType, palette, cprefs.candle, cprefs.lineWidth, cprefs.lineColor, cprefs.scaleMode, cprefs.invertScale, cprefs.canvas.grid, cprefs.canvas.crosshair, cprefs.canvas.crossStyle, cprefs.canvas.rightOffset, cprefs.lines.lastPrice, cprefs.lines.indicatorLabels, cprefs.transform, watermark, timeFmt])
  const priceBased = PRICE_BASED_TYPES.has(cprefs.chartType)
  // 买卖按钮：桌面常驻；手机平时底部已有交易条，只在全屏横屏时显示。
  // Buy / sell buttons: always on desktop; phones already have the bottom trade bar, so fullscreen only.
  // 专业版手机没有底部交易条（换成了标签栏），买卖按钮浮在图上。
  // The pro phone layout has no bottom trade bar (a tab bar instead), so the buttons float on the chart.
  const showTradeBtns = cprefs.trading.buttons && (isDesktop || isFullscreen || pro)

  const indView = useMemo<IndView>(() => ({
    list: shownList, panes: indLayout.panes, mainH: indLayout.mainH, maxPane, interval, digits: decimals, symbol,
  }), [shownList, indLayout.panes, indLayout.mainH, maxPane, interval, decimals, symbol])
  // 拖窗格分隔条后把像素高度存成权重（比例不变，换屏幕尺寸照样成立）
  // After a separator drag, store the pixel heights as weights (ratios survive other screen sizes)
  const onPaneResize = useCallback((mainPx: number, panes: Record<string, number>) => {
    updateInd((l) => ({ ...l, mainH: Math.max(0.1, mainPx / 100), panes: l.panes.map((p) => (panes[p.id] != null ? { ...p, h: Math.max(0.1, panes[p.id] / 100) } : p)) }))
  }, [updateInd])
  const engine = useChartEngine(containerRef, indView, isFullscreen, candleColors, markerText, view, onPaneResize)
  const { chartRef, seriesRef, getBarTimes, legendStore, paneBoxes, drawReady } = engine
  const legendActions = useMemo<LegendActions>(() => ({
    toggleHidden: (uid) => updateInd((l) => updateInstance(l, uid, (i) => ({ ...i, hidden: !i.hidden || undefined }))),
    settings: (uid) => setEditUid(uid),
    remove: (uid) => updateInd((l) => removeInstance(l, uid)),
    duplicate: (uid) => updateInd((l) => duplicateInstance(l, uid)),
    moveTo: (uid, target) => updateInd((l) => moveInstance(l, uid, target)),
    scale: (uid, pin) => updateInd((l) => updateInstance(l, uid, { scale: pin })),
    saveDefault: (uid) => updateInd((l) => {
      const i = l.list.find((x) => x.uid === uid)
      return i ? { ...l, defaults: { ...l.defaults, [i.type]: { inputs: i.inputs, styles: i.styles } } } : l
    }),
    paneMove: (id, dir) => updateInd((l) => movePane(l, id, dir)),
    paneMax: (id) => setMaxPane(id),
    paneCollapse: (id, collapsed) => updateInd((l) => setPane(l, id, { collapsed: collapsed || undefined })),
    paneRemove: (id) => { updateInd((l) => removePane(l, id)); setMaxPane((m) => (m === id ? null : m)) },
  }), [updateInd])
  const addIndicator = useCallback((type: string) => { updateInd((l) => addInstance(l, type)?.layout ?? l) }, [updateInd])
  const liveBidRef = useRef<number | null>(null)
  const dataKeyRef = useRef('')
  const { hasData, stale, lastPrice, dayStats, ensureHistory } = useChartData(symbol, interval, decimals, engine, liveBidRef, dataKeyRef)

  // ── 阶段 1 的图表交互 / phase-1 chart interactions ──
  const cvRef = useRef<HTMLDivElement>(null)
  const [chartSetOpen, setChartSetOpen] = useState(false)
  const [gotoOpen, setGotoOpen] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const [quick, setQuick] = useState<string | null>(null)
  const [measureOn, setMeasureOn] = useState(false)
  const [ctx, setCtx] = useState<CtxState | null>(null)
  const [rangeBusy, setRangeBusy] = useState(false)
  const chartBoxRef = useRef<HTMLDivElement>(null)
  const focusChart = useCallback(() => { chartBoxRef.current?.focus({ preventScroll: true }) }, [])

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
  const autoScale = useCallback(() => { chartRef.current?.priceScale('right').applyOptions({ autoScale: true }) }, [chartRef])
  const resetView = useCallback(() => {
    const c = chartRef.current
    if (!c) return
    c.timeScale().resetTimeScale()
    c.priceScale('right').applyOptions({ autoScale: true })
  }, [chartRef])

  // 截图 / screenshot
  const shotToast = useCallback((r: ShotResult) => {
    if (r === 'saved') showToast(t('charts.shot.saved'), 'success')
    else if (r === 'copied') showToast(t('charts.shot.copied'), 'success')
    else if (r === 'unsupported') showToast(t('charts.shot.unsupported'), 'error')
    else showToast(t('charts.shot.failed'), 'error')
  }, [showToast, t])
  const takeShot = useCallback(async (mode: 'save' | 'copy') => {
    const c = chartRef.current
    if (!c) return
    const now = Math.floor(Date.now() / 1000)
    const canvas = composeScreenshot(c, `${symbol} · ${intervalLabel(interval)} · ${timeFmt.crosshair(now as never)}`, palette.bg, palette.text)
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
    shotToast(mode === 'copy' ? await copyScreenshot(canvas) : await saveScreenshot(canvas, `${symbol}_${intervalLabel(interval)}_${stamp}`))
  }, [chartRef, symbol, interval, timeFmt, palette, shotToast])

  // 时间范围快捷键：先切到对应周期，等新数据到了再补历史、设可见范围。
  // Range presets: switch to the matching interval, then once its data is in, page history
  // as needed and set the visible range.
  const pendingRangeRef = useRef<{ k: RangeKey; tries: number } | null>(null)
  const [rangeTick, setRangeTick] = useState(0)
  const applyRange = useCallback((k: RangeKey) => {
    pendingRangeRef.current = { k, tries: 0 }
    const iv = RANGE_INTERVAL[k]
    if (iv !== interval) setIntervalCode(iv)
    setRangeTick((x) => x + 1)
  }, [interval])
  useEffect(() => {
    const job = pendingRangeRef.current
    if (!job) return
    const c = chartRef.current
    if (!c || dataKeyRef.current !== `${symbol}|${interval}` || engine.candlesRef.current.length === 0) {
      // 新周期的数据还没到：稍后再看（最多约 10 秒）/ new data not in yet: look again (≤ ~10s)
      if (job.tries++ > 40) { pendingRangeRef.current = null; return }
      const id = window.setTimeout(() => setRangeTick((x) => x + 1), 250)
      return () => window.clearTimeout(id)
    }
    pendingRangeRef.current = null
    const from = rangeFrom(job.k)
    if (from == null) { c.timeScale().fitContent(); return }
    let alive = true
    setRangeBusy(true)
    ensureHistory(from).finally(() => {
      if (!alive) return
      setRangeBusy(false)
      const to = Math.floor(Date.now() / 1000)
      try { chartRef.current?.timeScale().setVisibleRange({ from: from as never, to: to as never }) } catch { /* 无数据 / no data */ }
    })
    return () => { alive = false; setRangeBusy(false) }
  }, [rangeTick, symbol, interval, hasData, chartRef, engine.candlesRef, ensureHistory])

  // 跳转到日期：补够历史后把那一根放到屏幕中间。/ Go to date: page enough history, then centre that bar.
  const goToTime = useCallback(async (ts: number) => {
    setRangeBusy(true)
    try { await ensureHistory(ts) } finally { setRangeBusy(false) }
    const c = chartRef.current
    if (!c) return
    const times = engine.barTimesRef.current
    if (times.length === 0) return
    let lo = 0
    let hi = times.length - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < ts) lo = mid + 1; else hi = mid }
    const ts2 = c.timeScale()
    const r = ts2.getVisibleLogicalRange()
    const half = r ? Math.max(10, (r.to - r.from) / 2) : 60
    ts2.setVisibleLogicalRange({ from: lo - half, to: lo + half })
    if (lo === 0 && times[0] > ts) showToast(t('charts.goto.earliest'), 'error')
  }, [ensureHistory, chartRef, engine.barTimesRef, showToast, t])

  // 键盘快捷键（列表见 ShortcutsDialog）/ keyboard shortcuts (listed in ShortcutsDialog)
  useChartHotkeys(cvRef, {
    quickInput: (c) => setQuick(c),
    reset: resetView,
    goto: () => setGotoOpen(true),
    toggleLog: () => setScaleMode(cprefs.scaleMode === 1 ? 0 : 1),
    togglePercent: () => setScaleMode(cprefs.scaleMode === 2 ? 0 : 2),
    toggleInvert: () => updatePrefs({ invertScale: !cprefs.invertScale }),
    scroll: (n) => { const ts = chartRef.current?.timeScale(); if (ts) ts.scrollToPosition(ts.scrollPosition() + n, false) },
    zoom: (f) => {
      const ts = chartRef.current?.timeScale()
      if (!ts) return
      ts.applyOptions({ barSpacing: Math.max(0.5, Math.min(60, ts.options().barSpacing * f)) })
    },
    screenshot: () => { void takeShot('save') },
    help: () => setKeysOpen(true),
    alert: () => openAlert({ price: quoteNow().bid ?? undefined }),
  }, !isFullscreen)

  // 交易日分隔线 primitive / session-break primitive
  const breaksRef = useRef<SessionBreaks | null>(null)
  const breaksOn = cprefs.lines.sessionBreaks && ivKind === 'intraday' && !priceBased
  useEffect(() => {
    const series = seriesRef.current
    if (!drawReady || !series || !breaksOn) return
    const sb = new SessionBreaks()
    sb.enabled = true
    sb.color = palette.sessionBreak
    series.attachPrimitive(sb)
    breaksRef.current = sb
    return () => { try { series.detachPrimitive(sb) } catch { /* 图表已销毁 / chart gone */ } breaksRef.current = null }
  }, [drawReady, seriesRef, breaksOn, palette.sessionBreak])

  // 右键菜单（桌面）/ context menu (desktop)
  const onChartContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDesktop || e.defaultPrevented) return
    const c = chartRef.current
    const s = seriesRef.current
    const host = containerRef.current
    if (!c || !s || !host) return
    e.preventDefault()
    const r = host.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const zone = x > c.timeScale().width() ? 'price' : 'pane'
    const price = s.coordinateToPrice(y)
    setCtx({ x: e.clientX, y: e.clientY, zone, price: price == null ? null : Number(price) })
  }, [isDesktop, chartRef, seriesRef])
  const closeCtx = useCallback(() => setCtx(null), [])
  const doneMeasure = useCallback(() => setMeasureOn(false), [])

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
        <GearButton onClick={() => setChartSetOpen(true)} label={String(t('charts.settings.title'))} />
        <button type="button" onClick={() => setLayout('pro')} className="term-tbr-btn pt-entry" aria-label={String(t('charts.pro.enter'))} title={String(t('charts.pro.enter'))}>
          <IcSpark size={13} />{t('charts.pro.short')}
        </button>
      </div>
    </>
  )

  // ── 专业版终端：命令面板动作、手机标签栏 / pro terminal: palette actions, phone tab bar ──
  const pickSymbolPro = useCallback((s: string) => { setSymbol(s); focusChart() }, [focusChart])
  const pickIntervalPro = useCallback((c: string) => { setIntervalCode(c); focusChart() }, [focusChart])
  const addIndicatorPro = useCallback((id: string) => {
    if (defOf(id)?.pro && !isPro) { setSettingsOpen(true); return }
    addIndicator(id)
  }, [addIndicator, isPro])
  const closeCmd = useCallback(() => { setCmd(null); focusChart() }, [focusChart])
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
  const pickFromSheet = useCallback((s: string) => { setSymbol(s); setSheet(null) }, [])

  // 稳定的下单回调：OrderTicket 已 memo，内联箭头函数会让它每次都重渲染。
  // A stable place callback: OrderTicket is memoized and an inline arrow would defeat it.
  const onPlace = useCallback<ComponentProps<typeof OrderTicket>['onPlace']>(
      async (side, volume, mt5Login, stopLoss, takeProfit, coid, orderType, price) => {
        // silent：下单票按钮下面有就地回执，不在屏幕正中再弹同一句（见 hooks.ts 的 SubmitOrderOptions）。
        // silent: the ticket shows an inline receipt under its button; no centred repeat.
        const placed = await placeManualOrder(symbol, side, volume, mt5Login, stopLoss, takeProfit, coid, orderType, price, { silent: true })
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
      [placeManualOrder, reportPlaced, symbol, afterPlaceOpen],
  )

  // 图上发起的下单（反手、投影单、买卖按钮）：走同一个 placeManualOrder，结果照常弹提示。
  // 接口报错在这里提示并返回 undefined，调用方当作没成功处理。
  // Orders started on the chart (reverse, projected order, buy / sell buttons) share
  // placeManualOrder and toast as usual. API errors are toasted here and come back undefined.
  const chartPlace = useCallback<ChartPlace>(async (r): Promise<Order | void> => {
    try {
      return await placeManualOrder(symbol, r.side, r.volume, r.login, r.sl, r.tp, clientOrderId(), r.type, r.price)
    } catch (e) {
      showToast(e instanceof Error ? localizeApiError(e.message) : String(t('charts.ticket.placeFailed')), 'error')
      return undefined
    }
  }, [placeManualOrder, showToast, symbol, t])

  // 图上投影单：右键菜单、价格轴边的「+」、多空仓位工具的「转为订单」都从这里开一张。
  // The projected order: opened from the context menu, the "+" button or a long/short drawing.
  const [draftReq, setDraftReq] = useState<DraftRequest | null>(null)
  const openDraft = useCallback((side: 'BUY' | 'SELL', price: number, sl?: number | null, tp?: number | null) => {
    const f = exactDigits != null ? Math.pow(10, exactDigits) : null
    const r = (v: number | null | undefined) => (v == null ? null : f != null ? Math.round(v * f) / f : v)
    setShowPositions(true)
    setDraftReq({ nonce: Date.now(), side, price: r(price) as number, sl: r(sl), tp: r(tp) })
  }, [exactDigits])
  useFillSound(accountOrders, symbol, cprefs.trading.sound)

  // 下单票自己订阅报价（按账户 + 当前品种的全站报价），这里不再传。
  // The ticket subscribes to its own quotes (per account + the symbol's site-wide one).
  const ticket = (initialSide?: Side) => (
    <OrderTicket
      key={initialSide ?? 'desk'}
      symbol={symbol}
      accounts={accounts}
      refPrice={lastPrice}
      digits={decimals}
      selectedLogin={effectiveLogin}
      onSelectLogin={setSelectedLogin}
      initialSide={initialSide}
      onPlace={onPlace}
      quotesDown={wsDisconnected}
    />
  )

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
          symbol={symbol}
          interval={interval}
          digits={decimals}
          dayStats={dayStats}
          fallbackPrice={lastPrice}
          quotesDown={wsDisconnected}
          favIntervals={cprefs.favIntervals}
          onInterval={pickIntervalPro}
          onFavIntervals={setFavIntervals}
          chartType={cprefs.chartType}
          onChartType={(v) => updatePrefs({ chartType: v })}
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
            active={symbol}
            onSelect={setSymbol}
            digitsFor={digitsFor}
            quotesDown={wsDisconnected}
          />
        </aside>
      )}

      {/* 中栏：报价条 + [竖轨 | 工具条 / 图表] + 持仓停靠 / center: quote strip + [rail | toolbar / chart] + dock */}
      <section className="term-center">
        <LiveBarSync symbol={symbol} interval={interval} engine={engine} liveBidRef={liveBidRef} dataKeyRef={dataKeyRef} />
        {!isFullscreen && !pro && (
          <LiveSymbolHeader
            symbol={symbol}
            interval={interval}
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
          {!isFullscreen && (!pro || (isDesktop && !proPrefs.focus)) && (drawReady
            ? <DrawToolsRow variant="rail" drawLayerRef={drawLayerRef} bumpDraw={bumpDraw} t={t} measureOn={measureOn} onMeasure={() => setMeasureOn((v) => !v)} />
            : <div className="term-rail" />)}

          {/* 工具条：周期钉左；右侧 持仓（手机）· 画笔（手机）· 持仓标记 · 添加指标
              Toolbar: intervals left; positions (mobile) · pen (mobile) · markers · indicators right */}
          {!isFullscreen && !pro && (
            <div className="term-tb">
              <IntervalSeg value={interval} onChange={setIntervalCode} codes={cprefs.favIntervals} />
              <IntervalMenu value={interval} onChange={setIntervalCode} favorites={cprefs.favIntervals} onFavorites={setFavIntervals} />
              <span className="term-toolbar-divider" aria-hidden />
              <ChartTypeMenu value={cprefs.chartType} onChange={(v) => updatePrefs({ chartType: v })} />
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

          {/* 图表容器：无缝，填满网格剩余高度。/ Chart container: seamless, fills the grid. */}
          {/* tabIndex 让图表本身能拿到焦点：点一下图表焦点就落到这里，图表快捷键（画线的
              Alt+字母、Delete，快速输入的数字 / 字母，见 useChartHotkeys）只在焦点处于图表区时
              生效；键盘用户也能 Tab 到图表再用这些键。role="group" 加名字，读屏进来时报「行情图表，分组」。
              tabIndex makes the chart itself focusable: a click on the chart lands focus
              here, and the chart shortcuts (DrawLayer's Alt+letter and Delete, quick input's
              digits / letters, see useChartHotkeys) only act while focus is in the chart
              area; keyboard users can Tab to the chart and use them too.
              role="group" with a name, so a screen reader says "Charts, group" on entry. */}
          <div
            ref={chartBoxRef}
            className={`term-chart ${isFullscreen ? 'chart-fullscreen-container' : ''} ${cprefs.legend.title || cprefs.legend.ohlc || cprefs.legend.change || cprefs.legend.volume ? 'has-status' : ''} ${cprefs.legend.indicators ? '' : 'no-ind-legend'} ${showTradeBtns ? 'has-tbtns' : ''} ${maxPane && maxPane !== 'main' && indLayout.panes.some((p) => p.id === maxPane) ? 'main-min' : ''}`}
            data-ctheme={themeName}
            tabIndex={0}
            role="group"
            aria-label={t('nav.charts')}
            onContextMenu={onChartContextMenu}
          >
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
            {isFullscreen && <IntervalSeg variant="fullscreen" value={interval} onChange={setIntervalCode} codes={cprefs.favIntervals} />}

            <div ref={containerRef} className="h-full w-full" />
            {/* 持仓标记层：入场价/止损/止盈线 + 拖动改单。刻意排在画图层之前——两层
                都用「悬停到自己的目标才抢指针事件」的策略，DOM 上后者在上，于是画线
                操作天然优先于拖止损线，不会互相抢。/ Position markers: entry/SL/TP
                lines + drag-to-modify. Deliberately mounted before the draw layer:
                both only capture pointer events while hovering their own targets, and
                being later in the DOM puts the draw layer on top, so drawing
                naturally takes precedence over dragging an SL line. */}
            {drawReady && chartRef.current && seriesRef.current && (
              <LiveOverlay
                chart={chartRef.current}
                series={seriesRef.current}
                scopeLogin={scopeLogin}
                symbol={symbol}
                digits={decimals}
                exactDigits={exactDigits}
                refPrice={lastPrice}
                visible={showPositions}
                onToast={showToast}
                trading={cprefs.trading}
                balance={activeAccount?.balance ?? null}
                currency={activeAccount?.accountCurrency ?? ''}
                login={tradeLogin}
                quote={quoteNow}
                onPlace={chartPlace}
                draftRequest={draftReq}
              />
            )}
            {drawReady && chartRef.current && seriesRef.current && cprefs.trading.executions && !priceBased && (
              <LiveExecutions
                chart={chartRef.current}
                series={seriesRef.current}
                scopeLogin={scopeLogin}
                symbol={symbol}
                login={activeAccount?.login ?? null}
                orders={accountOrders}
                barTimes={getBarTimes}
                dataKey={`${interval}|${hasData}|${lastPrice}`}
                visible={showPositions}
              />
            )}
            {drawReady && chartRef.current && seriesRef.current && isDesktop && (
              <PlusOrderButton chart={chartRef.current} series={seriesRef.current} digits={decimals} quote={quoteNow}
                onPick={showPositions && tradeLogin ? openDraft : null} onAlert={(price) => openAlert({ price })} />
            )}
            {showCountdown && !priceBased && hasData && drawReady && chartRef.current && seriesRef.current && (
              <BarCountdown
                chart={chartRef.current}
                series={seriesRef.current}
                interval={interval}
                candlesRef={engine.candlesRef}
                colors={candleColors}
                stale={stale}
              />
            )}
            {drawReady && chartRef.current && seriesRef.current && containerRef.current && (
              <DrawLayer
                ref={drawLayerRef}
                chart={chartRef.current}
                series={seriesRef.current}
                host={containerRef.current}
                symbol={symbol}
                barTimes={getBarTimes}
                digits={decimals}
                interval={interval}
                fmtTime={drawFmtTime}
                theme={drawTheme}
                onStateChange={bumpDraw}
                onToOrder={(o) => openDraft(o.side, o.price, o.sl, o.tp)}
                onAlert={(d) => openAlert({ drawing: d })}
              />
            )}
            {!hasData && <div className="term-chart-empty">{t('charts.empty')}</div>}

            {/* 主图状态行：品种 · 周期 · OHLC · 涨跌 / main status line */}
            <ChartLegend store={engine.ohlcStore} symbol={symbol} interval={interval} chartType={cprefs.chartType} decimals={decimals} legend={cprefs.legend} colors={candleColors} />
            {/* 买卖按钮（桌面，或手机全屏横屏时）/ buy & sell buttons (desktop, or phone fullscreen) */}
            {showTradeBtns && (
              <TradeButtons symbol={symbol} digits={decimals} login={tradeLogin} oneClick={cprefs.trading.oneClick} touch={!isDesktop} onPlace={chartPlace} quotesDown={wsDisconnected} />
            )}
            {/* 指标图例（主图叠加 + 各副图）/ indicator legends (main-pane overlays + each sub-pane) */}
            <PaneLegends layout={indLayout} list={shownList} boxes={paneBoxes} legendStore={legendStore} digits={decimals} candle={candleColors}
              axisW={chartRef.current ? chartRef.current.priceScale('right').width() : 56} maxPane={maxPane} actions={legendActions} showRows={cprefs.legend.indicators} />

            {drawReady && chartRef.current && seriesRef.current && (
              <ChartPriceLines
                chart={chartRef.current}
                series={seriesRef.current}
                symbol={symbol}
                interval={interval}
                candlesRef={engine.candlesRef}
                palette={palette}
                bidAsk={cprefs.lines.bidAsk}
                highLow={cprefs.lines.highLow}
                prevClose={cprefs.lines.prevClose && !priceBased}
                labels={{ bid: String(t('charts.lines.bid')), ask: String(t('charts.lines.ask')), high: String(t('charts.lines.high')), low: String(t('charts.lines.low')), prev: String(t('charts.lines.prev')) }}
              />
            )}
            {drawReady && chartRef.current && seriesRef.current && (
              <AlertLines
                chart={chartRef.current}
                series={seriesRef.current}
                symbol={symbol}
                digits={decimals}
                bid={alertBid}
                label={String(t('charts.alert.lineTitle'))}
                dragTip={String(t('charts.alert.dragTip'))}
                onEdit={(a) => openAlert({ edit: a })}
                onError={(m) => showToast(m ? localizeApiError(m) : String(t('charts.alert.err.save')), 'error')}
              />
            )}
            {drawReady && chartRef.current && seriesRef.current && containerRef.current && (
              <MeasureOverlay chart={chartRef.current} series={seriesRef.current} host={containerRef.current} armed={measureOn} onDone={doneMeasure} decimals={decimals} barTimes={getBarTimes} colors={candleColors} />
            )}
            {drawReady && chartRef.current && <BackToLatest chart={chartRef.current} />}
            {quick != null && (
              <QuickInput
                initial={quick}
                symbols={activeSymbols}
                onInterval={setIntervalCode}
                onSymbol={setSymbol}
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
              busy={rangeBusy}
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
        {alertMgrOpen && (
          <AlertManager
            symbol={symbol}
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
            symbol={symbol}
            digits={decimals}
            chartInterval={interval}
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
              orderAt: tradeLogin ? openDraft : null,
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
          <MobileTradeBar symbol={symbol} decimals={decimals} lastPrice={lastPrice} onTrade={openTrade} quotesDown={wsDisconnected} />
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
          watch={<WatchlistPanel className="flex min-h-0 flex-1 flex-col" symbols={activeSymbols} active={symbol} onSelect={pickSymbolPro} digitsFor={digitsFor} quotesDown={wsDisconnected} />}
          details={<ProDetails symbol={symbol} digits={decimals} dayStats={dayStats} fallback={lastPrice} stale={stale} down={wsDisconnected} />}
          trade={<>{ticket()}<AccountSummary account={activeAccount} /></>}
          alerts={(
            <ProAlerts
              symbol={symbol}
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
          <div className="term-ph"><h3>{t('charts.ticket.title')}</h3><span>{symbol || EMPTY}</span></div>
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
                <h3 id={termSheetTitleId}>{shownSheet === 'watchlist' ? t('charts.watchlist.title') : shownSheet === 'trade' ? t('charts.sheetTicket') : t('charts.openPositions')}</h3>
                <span>{shownSheet === 'watchlist' ? activeSymbols.length : shownSheet === 'trade' ? `${symbol} · ${activeAccount ? `#${activeAccount.login}` : ''}` : <PositionsCount scopeLogin={scopeLogin} />}</span>
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
              {shownSheet === 'watchlist' && (
                <WatchlistPanel
                  className="flex min-h-0 flex-1 flex-col"
                  symbols={activeSymbols}
                  active={symbol}
                  onSelect={pickFromSheet}
                  digitsFor={digitsFor}
                  quotesDown={wsDisconnected}
                />
              )}
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
          layout={indLayout}
          update={updateInd}
          isPro={isPro}
          onAdd={addIndicator}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {indEditor.shown && (
        <IndicatorEditor
          uid={indEditor.shown}
          closing={indEditor.closing}
          layout={indLayout}
          interval={interval}
          candle={candleColors}
          symbols={activeSymbols}
          onChange={(next) => updateInd((l) => updateInstance(l, next.uid, () => next))}
          onSaveDefault={(i) => updateInd((l) => ({ ...l, defaults: { ...l.defaults, [i.type]: { inputs: i.inputs, styles: i.styles } } }))}
          onClose={() => setEditUid(null)}
        />
      )}

      {pro && (
        <ProCommand
          open={cmd != null}
          mode={cmd ?? 'all'}
          onClose={closeCmd}
          symbols={activeSymbols}
          activeSymbol={symbol}
          interval={interval}
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
