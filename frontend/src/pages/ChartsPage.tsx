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
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { usePrefs } from '../store/prefs'
import { useLive } from '../store/live'
import { useOrderPlacement } from '../components/signals/hooks'
import { useBackToClose } from '../utils/useBackToClose'
import { useLastAccount } from '../utils/useLastAccount'
import {
  DEFAULT_INDICATOR_SETTINGS,
  mergeIndicatorSettings,
  type IndicatorSettings,
} from '../components/charts/indicatorSettings'
import DrawLayer, { type DrawLayerHandle } from '../components/charts/DrawLayer'
import IndicatorSettingsModal from '../components/charts/IndicatorSettingsModal'
import Toast from '../components/Toast'
import Switch from '../components/Switch'
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
import { useGlobalQuote, useGlobalQuotesPeek, useGlobalQuotesSelect, usePendingOrders, usePositions } from '../store/live'
import type { Quote } from '../api/types'
import type { Side } from '../components/order/useOrderForm'
import {
  DEFAULT_INDICATORS, FALLBACK_DECIMALS, INTERVAL_KEY, SYMBOL_KEY,
  priceDigits, resolvePriceDigits, type IndicatorFlags,
} from '../components/charts/chartConfig'
import { readStorage } from '../utils/safeStorage'
// 本页专属样式：跟着本页 chunk 按需加载，不进首屏的全站 CSS（见 styles/index.css 文件头）。
import '../styles/terminal.css'

// IndicatorFlags 原本定义在这里，IndicatorSettingsModal 等按老路径引用；保留再导出。
// IndicatorFlags used to be defined here; re-exported so old import paths keep working.
export type { IndicatorFlags }

type Sheet = 'watchlist' | 'trade' | 'positions' | null

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

type OverlayProps = Omit<ComponentProps<typeof PositionOverlay>, 'positions' | 'pendingOrders'> & { scopeLogin: string | null }
function LiveOverlay({ scopeLogin, ...rest }: OverlayProps) {
  const positions = useScopedPositions(scopeLogin)
  const pendingOrders = useScopedPendingOrders(scopeLogin)
  return <PositionOverlay {...rest} positions={positions} pendingOrders={pendingOrders} />
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

// 报价条：只订阅当前品种那一条全站报价 / quote strip reading just the active symbol's quote
function LiveSymbolHeader(props: Omit<ComponentProps<typeof SymbolHeader>, 'bid' | 'ask'>) {
  const q = useGlobalQuote(props.symbol)
  return <SymbolHeader {...props} bid={q?.bid ?? null} ask={q?.ask ?? null} />
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
  const [interval, setIntervalCode] = useState<string>(
    () => getPref<string>('charts', 'interval', '') || readStorage(INTERVAL_KEY) || '15'
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

  // 手机端抽屉：自选 / 下单票 / 持仓，一次只开一个；tradeSide 记住从交易条的哪一侧
  // 点进来。桌面（lg+）三栏常驻，抽屉不渲染（CSS 里 ≥1024 直接 display:none）。
  // Mobile sheets: watchlist / ticket / positions, one at a time; tradeSide
  // remembers which side of the trade bar opened the ticket. Desktop shows the
  // three columns and the sheets are display:none at ≥1024.
  const [sheet, setSheet] = useState<Sheet>(null)
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
  const { toast, placeManualOrder, showToast } = useOrderPlacement()

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

  useEffect(() => {
    setPref('charts', 'afterPlaceShowPositions', afterPlaceOpen)
  }, [afterPlaceOpen, setPref])

  const toggleIndicator = useCallback((key: keyof IndicatorFlags) => {
    setIndicatorsState((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  // 图表实例、指标 series、图例、pane 高度 → useChartEngine；历史 / 翻页 / 轮询 → useChartData。
  // 图表现在从不被藏起，refitKey 只在进出全屏时变（那两次容器尺寸确实变了）。
  // Chart instance / indicator series / legend / panes → useChartEngine; history /
  // paging / polling → useChartData. The chart is never hidden any more, so the
  // refit key only changes on entering/leaving fullscreen (a real resize).
  const engine = useChartEngine(containerRef, indicators, indicatorSettings, isFullscreen)
  const { chartRef, seriesRef, getBarTimes, legend, paneOffsets, drawReady } = engine
  const { hasData, stale, lastPrice, dayStats } = useChartData(symbol, interval, decimals, engine)

  const openTrade = useCallback((side: Side) => { setTradeSide(side); setSheet('trade') }, [])
  const openWatchlistSheet = useCallback(() => setSheet('watchlist'), [])
  const pickFromSheet = useCallback((s: string) => { setSymbol(s); setSheet(null) }, [])

  // 稳定的下单回调：OrderTicket 已 memo，内联箭头函数会让它每次都重渲染。
  // A stable place callback: OrderTicket is memoized and an inline arrow would defeat it.
  const onPlace = useCallback<ComponentProps<typeof OrderTicket>['onPlace']>(
      async (side, volume, mt5Login, stopLoss, takeProfit, coid, orderType, price) => {
        const placed = await placeManualOrder(symbol, side, volume, mt5Login, stopLoss, takeProfit, coid, orderType, price)
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
        if (afterPlaceOpen && !settled && sheetRef.current === 'trade') setSheet('positions')
        return placed
      },
      [placeManualOrder, symbol, afterPlaceOpen],
  )

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
    />
  )

  return (
    <div className="term-shell">
      {/* 左栏：自选（桌面常驻；手机从报价条的品种名点开抽屉）
          Left column: watchlist (desktop; on mobile it opens as a sheet from the quote strip) */}
      <aside className="term-col term-col-left">
        <div className="term-ph"><h3>{t('charts.watchlist.title')}</h3><span>{activeSymbols.length}</span></div>
        <WatchlistPanel
          className="flex min-h-0 flex-1 flex-col"
          symbols={activeSymbols}
          active={symbol}
          onSelect={setSymbol}
          digitsFor={digitsFor}
        />
      </aside>

      {/* 中栏：报价条 + [竖轨 | 工具条 / 图表] + 持仓停靠 / center: quote strip + [rail | toolbar / chart] + dock */}
      <section className="term-center">
        {!isFullscreen && (
          <LiveSymbolHeader
            symbol={symbol}
            interval={interval}
            digits={decimals}
            dayStats={dayStats}
            fallbackPrice={lastPrice}
            stale={stale}
            onSymbolClick={openWatchlistSheet}
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
                <button type="button" className="term-tbr-btn term-tbr-btn--pos lg:hidden" onClick={() => setSheet('positions')}>
                  {t('charts.openPositions')} <b><PositionsCount scopeLogin={scopeLogin} /></b>
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
            <LiveDock scopeLogin={scopeLogin} orders={accountOrders} digitsFor={digitsFor} onToast={showToast} mt5Login={closeAllLogin} accountLabel={closeAllLabel} />
          </div>
        )}

        {/* 手机端底部交易条：卖 | 点差 | 买，点开下单票抽屉
            Mobile trade bar: sell | spread | buy, opens the ticket sheet */}
        {!isFullscreen && (
          <MobileTradeBar symbol={symbol} decimals={decimals} lastPrice={lastPrice} onTrade={openTrade} />
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
            {/* 抽屉头：标题与副信息靠左成一组，右侧是关闭按钮——抽屉本身没有别的退出手势
                提示，点遮罩关闭对不少用户并不显然。
                Sheet head: title and meta grouped on the left, a close button on the right —
                the sheet offers no other visible way out, and tapping the scrim isn't obvious. */}
            <div className="term-ph term-sheet-ph">
              <div className="term-sheet-ttl">
                <h3>{sheet === 'watchlist' ? t('charts.watchlist.title') : sheet === 'trade' ? t('charts.sheetTicket') : t('charts.openPositions')}</h3>
                <span>{sheet === 'watchlist' ? activeSymbols.length : sheet === 'trade' ? `${symbol} · ${activeAccount ? `#${activeAccount.login}` : ''}` : <PositionsCount scopeLogin={scopeLogin} />}</span>
              </div>
              {/* 「下单后自动打开」就放在它自己弹出来的这张抽屉的抬头里：嫌它烦的人
                  正好在这儿，不用去设置页里找一个自己都不知道叫什么的开关。
                  The "open after placing" switch sits in the header of the sheet that
                  does the popping — whoever is annoyed by it is already looking here,
                  instead of hunting a settings page for a name they don't know. */}
              {sheet === 'positions' && (
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
              {sheet === 'watchlist' && (
                <WatchlistPanel
                  className="flex min-h-0 flex-1 flex-col"
                  symbols={activeSymbols}
                  active={symbol}
                  onSelect={pickFromSheet}
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
                <LiveDock scopeLogin={scopeLogin} orders={accountOrders} digitsFor={digitsFor} onToast={showToast} mt5Login={closeAllLogin} accountLabel={closeAllLabel} />
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
          onSetIndicators={setIndicatorsState}
          getCandles={() => engine.candlesRef.current}
          settings={indicatorSettings}
          onChange={setIndicatorSettingsState}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {toast && (
        <Toast kind={toast.kind} message={toast.msg} />
      )}
    </div>
  )
}

// 手机端底部交易条：卖 | 点差 | 买。自己订阅当前品种的报价，跳价只重画这一条。
// Mobile trade bar: sell | spread | buy. Subscribes to the active symbol's quote itself,
// so a tick repaints just this bar.
function MobileTradeBar({ symbol, decimals, lastPrice, onTrade }: {
  symbol: string
  decimals: number
  lastPrice: number
  onTrade: (side: Side) => void
}) {
  const { t } = useTranslation()
  const q = useGlobalQuote(symbol)
  const px = (v: number | null | undefined) => (v != null ? v.toFixed(decimals) : lastPrice ? lastPrice.toFixed(decimals) : '—')
  const spreadPts = q && q.ask >= q.bid ? Math.round((q.ask - q.bid) * Math.pow(10, decimals)) : null
  return (
    <div className="term-mbar">
      <button type="button" className="sell" onClick={() => onTrade('SELL')}>
        <span className="lab">{t('charts.ticket.sell')}</span>
        <span className="px"><PipText s={px(q?.bid)} /></span>
      </button>
      <div className="sp">{t('charts.ticket.spreadUnit')}<b>{spreadPts ?? '—'}</b></div>
      <button type="button" className="buy" onClick={() => onTrade('BUY')}>
        <span className="lab">{t('charts.ticket.buy')}</span>
        <span className="px"><PipText s={px(q?.ask)} /></span>
      </button>
    </div>
  )
}

// 价格末两位加粗（点位）/ bold the last two digits (the pips)
function PipText({ s }: { s: string }) {
  if (s.length < 3 || s === '—') return <>{s}</>
  return <>{s.slice(0, -2)}<b>{s.slice(-2)}</b></>
}
