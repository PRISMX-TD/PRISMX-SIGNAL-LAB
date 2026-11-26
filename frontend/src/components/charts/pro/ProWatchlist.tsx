// 专业版终端的自选表（TradingView 式的行情表，取代经典版的卡片列表）：
//   分类胶囊（全部 / 自选 / 外汇 / 商品…，可切到筛选框）+ 用户分组胶囊 + 「新建分组」·
//   列头（商品 · 趋势 · 最新价 · 涨跌幅）·
//   「全部」下先列用户分组、再按分类分组，组头可折叠并显示数量 · 每行：品种图标（SymbolLogo：外汇双国旗、指数国旗 / 数字、商品与币种图形）+ 代码、五格多周期趋势
//   （M5 / M15 / M30 / H1 / H4，信号页同一份 trends 数据）、跳价闪色的价格、日内涨跌幅、星标。
// 顶部齿轮是列表设置：趋势列、报价列可各自关掉（存进专业版偏好 wlTrend / wlPrice），涨跌幅列存 chartv2 / wlChg。
// 日内涨跌幅：现价对前一交易日收盘（useDayChange，后端 /chart/day-refs，60 秒共享轮询），红绿跟图表设置的涨跌提示色。
// 用户分组（chartv2 / wlGroups，见 wlGroups.ts）：点「+」建组；行上右键（电脑）或长按（触屏）
//   打开行菜单，勾选加入 / 移出分组；再点一次当前分组胶囊可以重命名、删除。
// 键盘：焦点在列表里时 ↑ / ↓ 直接切换主图品种（TradingView 要点鼠标）。
// 跳价与经典版一样走跳价簿（watchTicks）：每行只订阅自己的品种，面板本身不随报价重渲染。
// The pro terminal's watchlist (a TradingView-style quote table replacing the classic card
// list): category chips (all / favourites / forex / commodities…, swappable for a filter
// field) plus the user's group chips and "new group" · column header (symbol · trend · last ·
// change %) · under "all", the user's groups first, then rows grouped by category, with
// collapsible group headers and counts · each row: round avatar + ticker, five trend cells
// (M5 / M15 / M30 / H1 / H4, the same trends feed as the signals page), a price that flashes
// on ticks, the day change % and a star. The gear holds column settings (trend / price in the
// pro prefs, change % in chartv2 / wlChg). Day change = live bid vs the previous close
// (useDayChange: /chart/day-refs, one shared 60 s poll), tinted with the chart's up/down cue
// colours. User groups (chartv2 / wlGroups, see wlGroups.ts): "+" creates one; right-click,
// long-press (touch) opens a row menu to tick groups; clicking the active
// group chip again renames / deletes it. Keyboard: with focus in the list, ↑ / ↓ switch the
// chart symbol. Ticks go through the same tick book as the classic list (watchTicks): each row
// subscribes to its own symbol only, the panel never re-renders for a quote.
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChartDayRef, Trend } from '../../../api/types'
import { useGlobalQuotesPeek, useGlobalQuotesSubscribe, useLive } from '../../../store/live'
import { usePrefs } from '../../../store/prefs'
import { displaySymbol } from '../../../api/utils'
import SymbolLogo from './SymbolLogo'
import { SYMBOL_CATEGORIES, symbolCategory, type SymbolCategory } from '../../../utils/symbolCategory'
import { EMPTY } from '../../../utils/format'
import { FavoriteStar, useSymbolTabs } from '../../signals/SymbolTabs'
import { createWatchTicks, type WatchTicks } from '../watchTicks'
import ChartPopover from '../ChartPopover'
import { IcCheck, IcChevron, IcClose, IcGear, IcMore, IcPlus, IcSearch, IcWifiOff } from './icons'
import { useProPrefs } from './proPrefs'
import { useBackToClose } from '../../../utils/useBackToClose'
import { CHART_PREFS_NS } from '../useChartPrefs'
import { calcDayChange, fmtPct, useDayRefs, useDirColors } from '../useDayChange'
import { MAX_GROUPS, MAX_GROUP_NAME, newGroupId, useWlGroups, type WlGroup } from './wlGroups'

interface Props {
  symbols: string[]
  active: string
  onSelect: (symbol: string) => void
  digitsFor: (symbol: string) => number
  quotesDown?: boolean
  // 手机抽屉（经典版手机端的「行情」）：行更高、代码下面带中文名、按钮放大到手指能点
  // Phone sheet (the classic phone 行情 sheet): taller rows, the name under the ticker, finger-sized buttons
  mobile?: boolean
}

// M1 只是参考箭头、不计入综合判断（见 SignalView），表里不占格
// M1 is a reference arrow only and never weighs in (see SignalView), so it gets no cell
const TFS = ['M5', 'M15', 'M30', 'H1', 'H4'] as const
const GROUP_ORDER: SymbolCategory[] = [...SYMBOL_CATEGORIES, 'other']
// 涨跌幅列的开关存在 chartv2 / wlChg（专业版偏好归页面那边管）/ the change-% column toggle lives in chartv2 / wlChg
const WL_CHG_KEY = 'wlChg'
const TAB_NS = 'markets'
const TAB_KEY = 'proWatchTab'
const GRP = 'grp:'
const LONG_PRESS_MS = 480

type Section = { key: string; label: string; syms: string[]; user?: boolean }
type MenuState =
  | { kind: 'row'; symbol: string }
  | { kind: 'group'; id: string }
  | { kind: 'create' }
  | null

export default function ProWatchlist({ symbols, active, onSelect, digitsFor, quotesDown = false, mobile = false }: Props) {
  const { t } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const { trends } = useLive()
  const peekQuotes = useGlobalQuotesPeek()
  const subscribeQuotes = useGlobalQuotesSubscribe()
  const [ticks] = useState(() => {
    const book = createWatchTicks()
    book.ingest(peekQuotes())
    return book
  })
  useEffect(() => {
    ticks.ingest(peekQuotes())
    return subscribeQuotes(() => ticks.ingest(peekQuotes()))
  }, [ticks, peekQuotes, subscribeQuotes])

  const { tabs, tab, setTab, visible, favEnabled, favSet, toggleFavorite } = useSymbolTabs(symbols, TAB_KEY)
  const { getPref, setPref } = usePrefs()
  // 用户分组：只在登录后（有云端偏好）出现 / user groups: signed-in only (they live in the cloud prefs)
  const [groupsAll, dispatchGroups] = useWlGroups()
  const groupsOn = favEnabled
  const groups = groupsOn ? groupsAll : []
  const storedTab = getPref<string>(TAB_NS, TAB_KEY, 'all')
  const grpTab: WlGroup | null = groupsOn && typeof storedTab === 'string' && storedTab.startsWith(GRP)
    ? groups.find((g) => g.id === storedTab.slice(GRP.length)) ?? null
    : null
  const pickGroup = (id: string) => setPref(TAB_NS, TAB_KEY, GRP + id)

  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  useBackToClose(searching, () => { setSearching(false); setQuery('') })
  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  // 列设置：趋势、报价可各自关掉（存进专业版偏好，跨设备跟着账户走）；涨跌幅另存 chartv2 / wlChg
  // Column settings: trend and price can each be turned off (stored in the pro prefs); change % in chartv2 / wlChg
  const [prefs, setPrefs] = useProPrefs()
  const showTrend = prefs.wlTrend
  const showPrice = prefs.wlPrice
  const showChg = getPref<unknown>(CHART_PREFS_NS, WL_CHG_KEY, true) !== false
  const gearRef = useRef<HTMLButtonElement>(null)
  const [menu, setMenu] = useState(false)
  // 行菜单 / 分组菜单 / 新建分组：同一个弹层，锚点随打开的地方换
  // Row menu / group menu / new group: one popover whose anchor follows whatever opened it
  const [pop, setPop] = useState<MenuState>(null)
  const popAnchor = useRef<HTMLElement | null>(null)
  const openPop = useCallback((m: NonNullable<MenuState>, el: HTMLElement | null) => {
    popAnchor.current = el
    setPop(m)
  }, [])
  const closePop = useCallback(() => setPop(null), [])
  const dayRefs = useDayRefs()
  const dirColors = useDirColors()

  // 分类标签一行放不下时横向滚：滚动条是藏起来的，鼠标滚轮默认只上下滚，这里把滚轮
  // 换成左右滚（触控板横扫本来就行）；切换分类时把选中的标签滚进视野。
  // The category chips scroll sideways when they don't fit. The scrollbar is hidden and a
  // mouse wheel only scrolls vertically, so the wheel is turned into horizontal scrolling
  // here (trackpad swipes already work); switching tabs brings the active chip into view.
  const chipsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = chipsRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
      e.preventDefault()
      el.scrollLeft += e.deltaY
    }
    // 滚到头就去掉右边的渐隐，最后一个标签不再半透明 / drop the right fade once scrolled to the end
    const onScroll = () => el.classList.toggle('at-end', el.scrollLeft + el.clientWidth >= el.scrollWidth - 2)
    onScroll()
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('wheel', onWheel); el.removeEventListener('scroll', onScroll) }
  }, [searching, groups.length])
  useEffect(() => {
    const el = chipsRef.current
    const on = el?.querySelector<HTMLElement>('button.on')
    if (!el || !on) return
    const l = on.offsetLeft - el.offsetLeft
    if (l < el.scrollLeft) el.scrollLeft = l - 8
    else if (l + on.offsetWidth > el.scrollLeft + el.clientWidth) el.scrollLeft = l + on.offsetWidth - el.clientWidth + 18
  }, [tab, grpTab?.id, searching])

  const symSet = useMemo(() => new Set(symbols), [symbols])
  const q = query.trim().toUpperCase()
  const rows = useMemo(() => {
    if (q) return symbols.filter((s) => s.toUpperCase().includes(q) || displaySymbol(s).toUpperCase().includes(q))
    // 分组里不在当前活跃列表的品种（EA 没推）先不显示 / group symbols the EA isn't pushing stay hidden
    if (grpTab) return grpTab.symbols.filter((s) => symSet.has(s))
    return visible
  }, [q, symbols, grpTab, symSet, visible])
  // 只有「全部」且不在筛选时分组：先用户分组，再分类；分类标签 / 用户分组标签本身就是一组
  // Group only under "all" without a filter: user groups first, then categories
  const grouped = !q && !grpTab && tab === 'all'
  const sections = useMemo<Section[] | null>(() => {
    if (!grouped) return null
    const out: Section[] = []
    for (const g of groups) {
      const syms = g.symbols.filter((s) => symSet.has(s))
      if (syms.length) out.push({ key: GRP + g.id, label: g.name, syms, user: true })
    }
    const by = new Map<SymbolCategory, string[]>()
    for (const s of rows) {
      const c = symbolCategory(s)
      const arr = by.get(c)
      if (arr) arr.push(s)
      else by.set(c, [s])
    }
    for (const c of GROUP_ORDER) {
      const syms = by.get(c)
      if (syms) out.push({ key: c, label: c === 'other' ? tt('charts.pro.wl.other') : tt(`signals.symbolTabs.${c}`), syms })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tt follows the language
  }, [grouped, rows, groups, symSet, t])
  // 键盘上下键按屏幕顺序走，折叠组里的跳过；同一品种在分组和分类里都出现时只算第一次
  // Arrow keys follow screen order, skipping folded groups; a symbol listed twice counts once
  const order = useMemo(() => (sections ? [...new Set(sections.flatMap((g) => (shut.has(g.key) ? [] : g.syms)))] : rows), [sections, rows, shut])

  const closeSearch = () => { setSearching(false); setQuery('') }
  const toggleGroup = (k: string) => setShut((prev) => {
    const next = new Set(prev)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    return next
  })
  const setShowChg = (v: boolean) => setPref(CHART_PREFS_NS, WL_CHG_KEY, v)

  // 切品种后把当前行滚进视野（命令面板、图表快捷键切的也算）
  // Keep the active row in view after a switch (from the palette or chart shortcuts too)
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-sym="${CSS.escape(active)}"]`)
    // 手机抽屉一打开就把当前品种放到中间，不贴着底边（底下常有浮层）/ phone sheet: centre it rather than hugging the bottom edge
    el?.scrollIntoView({ block: mobile ? 'center' : 'nearest' })
  }, [active, mobile])

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    if (order.length === 0) return
    e.preventDefault()
    const i = order.indexOf(active)
    const next = order[i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + order.length) % order.length]
    onSelect(next)
    requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-sym="${CSS.escape(next)}"] .pt-wr-pick`)?.focus())
  }

  const emptyText = symbols.length === 0
    ? tt('charts.watchlist.loading')
    : q ? tt('charts.watchlist.noMatch')
      : grpTab ? tt('charts.wl.groupEmpty')
        : tab === 'fav' ? tt('signals.symbolTabs.favEmpty') : tt('signals.symbolTabs.empty')

  const onRowMenu = groupsOn ? (sym: string, el: HTMLElement) => openPop({ kind: 'row', symbol: sym }, el) : undefined
  const row = (sym: string) => (
    <WatchRow
      key={sym}
      sym={sym}
      ticks={ticks}
      trend={trends[sym]}
      digits={digitsFor(sym)}
      active={sym === active}
      showTrend={showTrend}
      showPrice={showPrice}
      showChg={showChg}
      dayRef={dayRefs[sym]}
      colors={dirColors}
      mobile={mobile}
      favEnabled={favEnabled}
      fav={favSet.has(sym)}
      onSelect={onSelect}
      onToggleFav={toggleFavorite}
      onMenu={onRowMenu}
    />
  )

  // 列宽：按开着的列拼 grid-template-columns（取代以前按 class 组合写死的几条规则）
  // Column tracks: built from the visible columns (replacing the old per-class-combo rules)
  // 涨跌幅列开着时其它列收窄一点，面板默认 312px 下品种代码仍放得下
  // With the change column on the others tighten so tickers still fit the default 312px panel
  const favW = mobile ? 32 : 24
  const cols = ['minmax(0, 1fr)', showTrend ? (showChg ? '40px' : '46px') : '', showPrice ? (showChg ? 'minmax(56px, auto)' : 'minmax(76px, auto)') : '', showChg ? 'minmax(48px, auto)' : '', `${favW}px`].filter(Boolean).join(' ')

  const menuGroup = pop?.kind === 'group' ? groups.find((g) => g.id === pop.id) ?? null : null
  return (
    <div className={`pt-wl ${mobile ? 'pt-wl--m' : ''} ${quotesDown ? 'down' : ''} ${showTrend ? '' : 'no-tr'} ${showPrice ? '' : 'no-px'} ${showChg ? 'has-chg' : ''}`} style={{ '--wl-cols': cols } as CSSProperties}>
      <div className="pt-wl-top">
        {searching ? (
          <label className="pt-wl-search">
            <IcSearch size={14} />
            <input
              ref={inputRef}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch() }
                else if (e.key === 'Enter' && rows[0]) { onSelect(rows[0]); closeSearch() }
              }}
              placeholder={tt('charts.watchlist.searchPlaceholder')}
              aria-label={tt('charts.watchlist.searchLabel')}
              spellCheck={false}
              autoComplete="off"
            />
            <button type="button" className="pt-wl-x" onClick={closeSearch} aria-label={tt('charts.pro.cmd.close')}><IcClose size={13} /></button>
          </label>
        ) : (
          <>
            <div ref={chipsRef} className="pt-chips no-sb" role="tablist">
              {tabs.map((k) => {
                const on = !grpTab && k === tab
                return (
                  <button key={k} type="button" role="tab" aria-selected={on} className={on ? 'on' : undefined} onClick={() => setTab(k)}>
                    {tt(`signals.symbolTabs.${k}`)}
                  </button>
                )
              })}
              {groups.map((g) => {
                const on = grpTab?.id === g.id
                return (
                  <button
                    key={g.id}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    aria-haspopup={on ? 'menu' : undefined}
                    className={`pt-chip-grp ${on ? 'on' : ''}`}
                    title={on ? tt('charts.wl.groupMenu', { name: g.name }) : g.name}
                    onClick={(e) => (on ? openPop({ kind: 'group', id: g.id }, e.currentTarget) : pickGroup(g.id))}
                    onContextMenu={(e) => { e.preventDefault(); openPop({ kind: 'group', id: g.id }, e.currentTarget) }}
                  >
                    {g.name}
                    {on && <IcMore size={13} />}
                  </button>
                )
              })}
              {groupsOn && groups.length < MAX_GROUPS && (
                <button
                  type="button"
                  className="pt-chip-add"
                  title={tt('charts.wl.newGroup')}
                  aria-label={tt('charts.wl.newGroup')}
                  aria-haspopup="dialog"
                  onClick={(e) => openPop({ kind: 'create' }, e.currentTarget)}
                >
                  <IcPlus size={13} />
                </button>
              )}
            </div>
            <button type="button" className="pt-icon sm" onClick={() => setSearching(true)} title={tt('charts.watchlist.searchLabel')} aria-label={tt('charts.watchlist.searchLabel')}>
              <IcSearch size={14} />
            </button>
            <button
              ref={gearRef}
              type="button"
              className={`pt-icon sm ${menu ? 'on' : ''}`}
              onClick={() => setMenu((v) => !v)}
              title={tt('charts.pro.wl.settings')}
              aria-label={tt('charts.pro.wl.settings')}
              aria-haspopup="menu"
              aria-expanded={menu}
            >
              <IcGear size={14} />
            </button>
            <ChartPopover open={menu} onClose={() => setMenu(false)} anchorRef={gearRef} width={200} align="end" label={tt('charts.pro.wl.settings')} className="pt-menu">
              <div className="pt-menu-list" role="menu">
                <CheckItem label={tt('charts.pro.wl.showTrend')} on={showTrend} onToggle={() => setPrefs({ wlTrend: !showTrend })} />
                <CheckItem label={tt('charts.pro.wl.showPrice')} on={showPrice} onToggle={() => setPrefs({ wlPrice: !showPrice })} />
                <CheckItem label={tt('charts.wl.showChg')} on={showChg} onToggle={() => setShowChg(!showChg)} />
              </div>
            </ChartPopover>
          </>
        )}
      </div>
      <div className="pt-wl-cols" aria-hidden>
        <span>{tt('charts.pro.wl.symbol')}</span>
        {showTrend && <span className="c-tr" title={TFS.join(' · ')}>{tt('charts.pro.wl.trend')}</span>}
        {showPrice && <span className="c-px">{tt('charts.pro.wl.last')}</span>}
        {showChg && <span className="c-px" title={tt('charts.wl.chgTip')}>{tt('charts.wl.chg')}</span>}
        <span />
      </div>
      {quotesDown && <p className="pt-wl-down"><IcWifiOff size={13} />{tt('charts.quotesDown')}</p>}
      <ul ref={listRef} className="pt-wl-list" aria-label={tt('charts.pro.w.watch')} onKeyDown={onListKey}>
        {rows.length === 0 && !(sections && sections.length) ? (
          <li className="pt-wl-empty">{emptyText}</li>
        ) : sections ? (
          sections.map((g) => {
            const open = !shut.has(g.key)
            return (
              <li key={g.key} className={`pt-wl-grp ${g.user ? 'user' : ''}`}>
                <button type="button" className="pt-wl-gh" aria-expanded={open} onClick={() => toggleGroup(g.key)}>
                  <IcChevron size={11} className={open ? 'open' : ''} />
                  <span>{g.label}</span>
                  <b>{g.syms.length}</b>
                </button>
                {open && <ul>{g.syms.map(row)}</ul>}
              </li>
            )
          })
        ) : (
          rows.map(row)
        )}
      </ul>
      <ChartPopover
        open={pop != null && !!popAnchor.current}
        onClose={closePop}
        anchorRef={popAnchor as RefObject<HTMLElement>}
        width={pop?.kind === 'row' ? 220 : 240}
        align={pop?.kind === 'row' ? 'end' : 'start'}
        label={pop?.kind === 'row' ? tt('charts.wl.rowMenu', { symbol: pop.symbol }) : pop?.kind === 'group' && menuGroup ? tt('charts.wl.groupMenu', { name: menuGroup.name }) : tt('charts.wl.newGroup')}
        className="pt-menu pt-wl-pop"
      >
        {pop?.kind === 'row' && (
          <RowMenu
            symbol={pop.symbol}
            groups={groups}
            onToggle={(id) => dispatchGroups({ type: 'toggle', id, symbol: pop.symbol })}
            onCreate={(name) => { dispatchGroups({ type: 'create', id: newGroupId(), name, symbols: [pop.symbol] }); closePop() }}
          />
        )}
        {pop?.kind === 'group' && menuGroup && (
          <GroupMenu
            key={menuGroup.id}
            group={menuGroup}
            onRename={(name) => { dispatchGroups({ type: 'rename', id: menuGroup.id, name }); closePop() }}
            onDelete={() => {
              dispatchGroups({ type: 'delete', id: menuGroup.id })
              if (grpTab?.id === menuGroup.id) setTab('all')
              closePop()
            }}
          />
        )}
        {pop?.kind === 'create' && (
          <div className="pt-menu-list">
            <p className="pt-menu-cap">{tt('charts.wl.newGroup')}</p>
            <NameForm
              submitLabel={tt('charts.wl.create')}
              onSubmit={(name) => {
                const id = newGroupId()
                dispatchGroups({ type: 'create', id, name })
                pickGroup(id)
                closePop()
              }}
            />
          </div>
        )}
      </ChartPopover>
    </div>
  )
}

function CheckItem({ label, on, onToggle, icon }: { label: string; on: boolean; onToggle: () => void; icon?: ReactNode }) {
  return (
    <button type="button" role="menuitemcheckbox" aria-checked={on} className={`pt-menu-item pt-check ${on ? 'on' : ''}`} onClick={onToggle}>
      {icon}
      <span>{label}</span>
      <IcCheck size={16} />
    </button>
  )
}

// 分组名称输入（新建 / 重命名共用）/ group-name field, shared by create and rename
function NameForm({ initial = '', submitLabel, onSubmit }: { initial?: string; submitLabel: string; onSubmit: (name: string) => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState(initial)
  const ok = name.trim().length > 0 && name.trim() !== initial
  return (
    <form className="pt-wl-name" onSubmit={(e) => { e.preventDefault(); if (ok) onSubmit(name.trim()) }}>
      <input
        autoFocus
        value={name}
        maxLength={MAX_GROUP_NAME}
        onChange={(e) => setName(e.target.value)}
        placeholder={String(t('charts.wl.groupName'))}
        aria-label={String(t('charts.wl.groupName'))}
        spellCheck={false}
        autoComplete="off"
      />
      <button type="submit" className="pt-btn sm tint" disabled={!ok}>{submitLabel}</button>
    </form>
  )
}

function RowMenu({ symbol, groups, onToggle, onCreate }: { symbol: string; groups: WlGroup[]; onToggle: (id: string) => void; onCreate: (name: string) => void }) {
  const { t } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const [creating, setCreating] = useState(false)
  return (
    <div className="pt-menu-list" role="menu">
      <p className="pt-menu-cap">{tt('charts.wl.addTo', { symbol })}</p>
      {groups.map((g) => (
        <CheckItem key={g.id} label={g.name} on={g.symbols.includes(symbol)} onToggle={() => onToggle(g.id)} />
      ))}
      {groups.length > 0 && <hr />}
      {creating ? (
        <NameForm submitLabel={tt('charts.wl.create')} onSubmit={onCreate} />
      ) : groups.length < MAX_GROUPS ? (
        <button type="button" role="menuitem" className="pt-menu-item" onClick={() => setCreating(true)}>
          <IcPlus size={15} />
          <span>{tt('charts.wl.newGroupWith')}</span>
        </button>
      ) : (
        <p className="pt-menu-cap">{tt('charts.wl.maxGroups', { n: MAX_GROUPS })}</p>
      )}
    </div>
  )
}

function GroupMenu({ group, onRename, onDelete }: { group: WlGroup; onRename: (name: string) => void; onDelete: () => void }) {
  const { t } = useTranslation()
  const tt = (k: string, o?: Record<string, unknown>) => String(t(k, o))
  const [arm, setArm] = useState(false)
  return (
    <div className="pt-menu-list" role="menu">
      <p className="pt-menu-cap">{tt('charts.wl.rename')}</p>
      <NameForm initial={group.name} submitLabel={tt('charts.wl.save')} onSubmit={onRename} />
      <hr />
      {/* 删除分组只删分组本身，品种不受影响；点两下确认 / deleting removes the group only; two taps to confirm */}
      <button type="button" role="menuitem" className={`pt-menu-item pt-wl-del ${arm ? 'arm' : ''}`} onClick={() => (arm ? onDelete() : setArm(true))}>
        <IcClose size={15} />
        <span>{arm ? tt('charts.wl.confirmDelete') : tt('charts.wl.deleteGroup')}</span>
      </button>
    </div>
  )
}

const WatchRow = memo(function WatchRow({ sym, ticks, trend, digits, active, showTrend, showPrice, showChg, dayRef, colors, mobile, favEnabled, fav, onSelect, onToggleFav, onMenu }: {
  sym: string
  ticks: WatchTicks
  trend: Trend | undefined
  digits: number
  active: boolean
  showTrend: boolean
  showPrice: boolean
  showChg: boolean
  dayRef: ChartDayRef | undefined
  colors: { up: string; down: string }
  mobile: boolean
  favEnabled: boolean
  fav: boolean
  onSelect: (symbol: string) => void
  onToggleFav: (symbol: string) => void
  onMenu?: (symbol: string, el: HTMLElement) => void
}) {
  const { t } = useTranslation()
  // 报价列、涨跌幅列都关掉时不订阅跳价，行不再随报价重渲染 / with price and change off, skip tick subscriptions
  const live = showPrice || showChg
  const subscribe = useCallback((cb: () => void) => (live ? ticks.subscribe(sym, cb) : () => {}), [ticks, sym, live])
  const get = useCallback(() => ticks.get(sym), [ticks, sym])
  const { bid, dir } = useSyncExternalStore(subscribe, get, get)
  const name = String(t(`signals.symbolNames.${sym}`, { defaultValue: displaySymbol(sym) }))
  const tfs = trend?.timeframes
  const trendTip = tfs ? TFS.map((tf) => `${tf} ${tfs[tf] === 'UP' ? '↑' : tfs[tf] === 'DOWN' ? '↓' : '–'}`).join('  ') : undefined
  const chg = showChg ? calcDayChange(bid, dayRef) : null

  // 长按（触屏）打开行菜单；长按之后的那次点击不切品种
  // Long-press (touch) opens the row menu; the click that follows it doesn't switch symbols
  const liRef = useRef<HTMLLIElement>(null)
  const press = useRef<{ id: number; x: number; y: number; fired: boolean } | null>(null)
  const cancelPress = () => { if (press.current) window.clearTimeout(press.current.id); if (press.current && !press.current.fired) press.current = null }
  const menuProps = onMenu ? {
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      if (press.current?.fired) return
      if (liRef.current) onMenu(sym, liRef.current)
    },
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return
      const id = window.setTimeout(() => {
        if (!press.current) return
        press.current.fired = true
        if (liRef.current) onMenu(sym, liRef.current)
      }, LONG_PRESS_MS)
      press.current = { id, x: e.clientX, y: e.clientY, fired: false }
    },
    onPointerMove: (e: React.PointerEvent) => {
      const p = press.current
      if (p && !p.fired && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 8) cancelPress()
    },
    onPointerUp: cancelPress,
    onPointerCancel: () => { if (press.current) window.clearTimeout(press.current.id); press.current = null },
    onClickCapture: (e: React.MouseEvent) => {
      if (press.current?.fired) { e.preventDefault(); e.stopPropagation(); press.current = null }
    },
  } : {}

  return (
    <li ref={liRef} className={`pt-wr ${active ? 'on' : ''}`} data-sym={sym} {...menuProps}>
      <span className="pt-wr-id">
        <SymbolLogo symbol={sym} className="pt-wr-ava" />
        <button type="button" className="pt-wr-pick" aria-current={active ? 'true' : undefined} onClick={() => onSelect(sym)} title={name !== sym && !mobile ? name : undefined}>
          {sym}
          {mobile && name !== sym && <small className="pt-wr-nm">{name}</small>}
        </button>
      </span>
      {showTrend && (
        <span className="pt-wr-tr" title={trendTip} aria-label={trendTip}>
          {TFS.map((tf) => {
            const d = tfs?.[tf]
            return <i key={tf} className={d === 'UP' ? 'up' : d === 'DOWN' ? 'dn' : ''} />
          })}
        </span>
      )}
      {showPrice && <span className={`pt-wr-px ${dir ?? ''}`}>{bid == null ? EMPTY : bid.toFixed(digits)}</span>}
      {showChg && (
        <span className="pt-wr-chg" style={chg && Math.abs(chg.pct) >= 0.005 ? { color: chg.pct > 0 ? colors.up : colors.down } : undefined}>
          {chg ? fmtPct(chg.pct) : EMPTY}
        </span>
      )}
      <span className="pt-wr-fav">
        {favEnabled && <FavoriteStar on={fav} onToggle={() => onToggleFav(sym)} symbol={sym} />}
      </span>
    </li>
  )
})
