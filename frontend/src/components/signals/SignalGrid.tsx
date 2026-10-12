// 信号面板独立视图：看板页头 + 筛选器 + 信号牌面网格
// Signal panel view: board head + filters + signal card grid
import { type CSSProperties, type FC, memo, useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { usePrefs } from '../../store/prefs'
import MultiSelect from '../MultiSelect'
import { signalApi } from '../../api/client'
import PageHead from '../PageHead'
import type { Signal, UserPlan } from '../../api/types'
import { calcRiskReward, displaySymbol, parseTime } from '../../api/utils'
import { effectiveStatus, fmtIssueClock, fmtPx, priceDecimals, resultLabel, resultTone, riskFraction, rrTone, type DisplaySignal } from './SignalView'
import TtlRing from './TtlRing'
import { useClock, useNewSignalIds } from './hooks'
import { symbolMeta } from '../../utils/symbolMeta'
import FestivalEmpty from '../../festival/FestivalEmpty'
import { FestivalBurst } from '../../festival/FestivalDecor'

interface Props {
  signals: Signal[]
  onTrade: (s: Signal) => void
  userPlan?: UserPlan
  // 全平台活跃品种（EA 正在推的那份，useLive().activeSymbols）。品种下拉列的是
  // 它，而不是"这批信号里出现过的品种"——见 symbolOptions 的说明。
  // The platform's active symbols (the list the EA is currently pushing,
  // useLive().activeSymbols). The symbol dropdown lists these rather than "the
  // symbols in this batch of signals" — see symbolOptions.
  activeSymbols: string[]
}

// ── 倒计时环 / countdown ring ──
// 订阅共享时钟自行每秒刷新，不牵动整张卡片/网格重渲染。环本身是三处共用的
// TtlRing（signals/TtlRing.tsx）。原来是一条 5px 的横向进度条，占卡片整整一行；
// 换成 22px 的环嵌在页脚里，同样的信息只占一个图标的位置，把省下的一行还给价格阶梯。
// Subscribes to the shared clock and ticks on its own, without dragging the
// whole card/grid into a per-second re-render. The ring is the shared TtlRing;
// it replaced a full-row 5px bar and gave that row back to the price ladder.
const Countdown: FC<{ expireAt: string | null; label: string }> = memo(({ expireAt, label }) => {
  const now = useClock()
  return <TtlRing expireAt={expireAt} now={now} label={label} />
})

// 策略筛选的键：平台信号用策略名（indicator），个人策略信号统一归到「我的策略」一项
// （它们的 indicator 只是一个显示用的徽标文案，随语言变，不能当键）。
// Strategy filter key: platform signals use the strategy name (indicator); personal
// strategy signals all fold into one "my strategies" entry (their indicator is just a
// localized badge, unusable as a key).
export const MY_STRATEGY_KEY = '__mine__'
const NO_STRATEGY_KEY = '__none__'
export function strategyKeyOf(sig: Signal): string {
  if ((sig as DisplaySignal).strategySignal) return MY_STRATEGY_KEY
  return sig.indicator || NO_STRATEGY_KEY
}

// 云端读回来的多选值：只认字符串数组，其它一律当「全部」。
// Multi-select values from the cloud: string arrays only, anything else means "all".
function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

const SignalGrid: FC<Props> = ({ signals, onTrade, userPlan, activeSymbols }) => {
  const { t } = useTranslation()
  const { getPref, setPref, loaded } = usePrefs()

  // 品种筛选（2026-08-26 顶掉原来的方向筛选）。存进 usePrefs 的 signals 命名空间，
  // 和 sortF 同一套：那是**云端按用户落库**的偏好，还会通过 WS 推到该用户的其它
  // 设备——比 localStorage 强，localStorage 只认浏览器不认人。
  // Symbol filter (replaced the direction filter on 2026-08-26). Stored in the
  // same `signals` namespace of usePrefs as sortF: a cloud-persisted, per-user
  // preference that is also pushed to that user's other devices over WS — unlike
  // localStorage, which knows browsers rather than people.
  //
  // 2026-10-11 品种改成多选（signals.symbolsF，空数组 = 全部），并新增策略多选
  // （signals.strategiesF）。老用户的单选值 symbolF 第一次读时折成一个元素的数组。
  // 2026-10-11: symbols became multi-select (signals.symbolsF, empty = all) and a
  // strategy multi-select was added (signals.strategiesF). A legacy single symbolF
  // is folded into a one-element list on first read.
  const [symbolsF, setSymbolsF] = useState<string[]>(() => {
    const saved = getPref<unknown>('signals', 'symbolsF', null)
    if (saved != null) return asStringList(saved)
    const legacy = getPref<string>('signals', 'symbolF', 'ALL')
    return legacy && legacy !== 'ALL' ? [legacy] : []
  })
  const [strategiesF, setStrategiesF] = useState<string[]>(
    () => asStringList(getPref<unknown>('signals', 'strategiesF', []))
  )
  const [sortF, setSortF] = useState<'latest' | 'expiry'>(
    () => (getPref<string>('signals', 'sortF', 'latest')) as 'latest' | 'expiry'
  )

  // 云端偏好晚于首屏到达时（本机没有缓存，比如新设备），用云端那份覆盖初值。
  // When cloud prefs arrive after first render (no local cache, e.g. a new device), take them.
  useEffect(() => {
    if (!loaded) return
    const cloudSymbols = getPref<unknown>('signals', 'symbolsF', null)
    if (cloudSymbols != null) setSymbolsF(asStringList(cloudSymbols))
    const cloudStrategies = getPref<unknown>('signals', 'strategiesF', null)
    if (cloudStrategies != null) setStrategiesF(asStringList(cloudStrategies))
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only when cloud prefs finish loading
  }, [loaded])
  useEffect(() => { setPref('signals', 'symbolsF', symbolsF) }, [symbolsF, setPref])
  useEffect(() => { setPref('signals', 'strategiesF', strategiesF) }, [strategiesF, setPref])
  useEffect(() => { setPref('signals', 'sortF', sortF) }, [sortF, setPref])

  // 手机端：点击循环切换筛选值，无需列出全部选项 / mobile: tap to cycle filter value
  const cycleSort = () => setSortF(s => (s === 'latest' ? 'expiry' : 'latest'))
  const sortLabel = sortF === 'latest' ? t('signals.sort.latest') : t('signals.sort.expiry')

  const isFree = userPlan === 'FREE'

  // 刚到达的信号短暂标记：hooks 里这个钩子早就写好了，网格一直没接。新牌上
  // 桌时 1px 边转成品牌紫、并带一次进场位移，6 秒后自行褪回——盯盘的人余光
  // 就能知道「哪张是新的」，不必逐张对时间戳。
  // Freshly arrived signals get a brief mark: the hook existed in hooks.ts but
  // the grid never used it. A new card lands with a violet 1px edge and one
  // entrance move, fading back after 6s — peripheral vision tells the reader
  // which card is new without comparing timestamps.
  const newIds = useNewSignalIds(signals)

  // 这批信号里**实际出现过**的品种，而不是一份写死的清单：写死的话，某个品种
  // 停发信号之后它还挂在下拉里，选中只会得到一张空网格。
  // 注意必须从「套用品种筛选之前」的列表里取——从筛完的列表里取，选中一个品种后
  // 选项就只剩它自己，再也换不回去。
  // The symbols this batch of signals actually contains, not a hard-coded list:
  // a hard-coded one would keep offering a symbol that stopped firing, and
  // picking it would yield an empty grid. It must be derived from the list
  // *before* the symbol filter runs — deriving it after would collapse the
  // options to the current pick, with no way back.
  //
  // 列**全平台的品种**，不是"这批信号里出现过的品种"。后者会让下拉随信号来去
  // 忽长忽短：某个品种这一刻没有活跃信号，它就整个消失，用户看到的是一份每隔几
  // 分钟就变一次的清单，也无从知道这个平台到底覆盖哪些品种。品种是平台的固定
  // 属性，不该由此刻恰好有没有信号来决定。
  //
  // 取 `activeSymbols`（EA 正在推的那份动态列表，全站三处品种清单都已改读它）
  // 与"信号里出现过的品种"的**并集**：前者是主来源，后者兜底——某个品种的行情
  // 推送短暂断了会掉出 activeSymbols，但它的信号还在网格里，这时候它必须仍然
  // 可选，否则用户看得见卡片却筛不出来。
  //
  // 代价：选中一个此刻没有信号的品种会得到一张空网格。这是诚实的——它就是没有
  // 信号，而不是被藏起来了；空态那行字会说明。
  //
  // List **every symbol the platform covers**, not just those in this batch of
  // signals. The latter makes the dropdown grow and shrink as signals come and
  // go: a symbol with no live signal right now vanishes entirely, leaving the
  // reader with a list that changes every few minutes and no way to know what
  // the platform actually covers. The symbol set is a property of the platform,
  // not of whichever signals happen to be live this minute.
  //
  // Takes the **union** of `activeSymbols` (the dynamic list the EA is pushing,
  // already the source for all three other symbol lists in the app) and the
  // symbols present in signals: the former is the primary source, the latter a
  // backstop — a symbol whose price feed briefly drops falls out of
  // activeSymbols while its signals are still on the grid, and it must stay
  // selectable or the reader can see cards they cannot filter to.
  //
  // The cost: picking a symbol with no current signals yields an empty grid.
  // That is honest — there are none, rather than them being hidden — and the
  // empty-state line says so.
  const symbolOptions = useMemo(() => {
    const evalNow = Date.now()
    // 按**展示名**去重，不是原始品种名。同一个标的可能有两种写法——线上 signals
    // 表里 `BTCUSD` 与 `BTCUSDT` 同时存在（本地库 1322 条 / 1 条，来自不同时期的
    // 推送方），而 displaySymbol() 把两者都渲染成「BTCUSDT」。按原始名去重会出现
    // 两个长得一模一样的选项，用户分不出，选哪个都只筛到一半。
    //
    // ⚠ 拿展示名当筛选键是安全的，**因为这个筛选完全发生在前端**：它只跟另一个
    // 展示名比对，不会作为品种名进任何请求、字典查找或下单路径。PRD 6.15 那条
    // 「绝不把展示名回传进任何逻辑路径」的界线没有被越过。
    //
    // Deduplicate by **display name**, not raw symbol: one instrument can carry
    // two spellings (`BTCUSD` and `BTCUSDT` both occur in signals) that
    // displaySymbol() renders identically, so deduplicating by raw symbol yields
    // two indistinguishable options, each filtering to half the rows.
    //
    // ⚠ A display name is safe as the filter key **only because this filter is
    // entirely client-side**: it is compared against another display name and
    // never travels as a symbol into a request, a dictionary lookup, or the
    // order path. PRD 6.15's line is not crossed here.
    const seen = new Set<string>()
    for (const sym of activeSymbols) seen.add(displaySymbol(sym))
    for (const sig of signals) {
      if (!isFree && effectiveStatus(sig, evalNow) === 'EXPIRED') continue
      seen.add(displaySymbol(sig.symbol))
    }
    // 「全部」不在这份清单里：MultiSelect 自己在菜单顶上放一项「全部」（= 清空选择），
    // 这是个**筛选器**，没有全部就没法看回完整列表。
    // "All" isn't in this list: MultiSelect puts its own "All" row (= clear) on top —
    // this is a *filter*, and without it there is no way back to the full board.
    return [...seen].sort().map((name) => ({ value: name, label: name }))
  }, [signals, activeSymbols, isFree])

  // 存下来的品种可能已经不在清单里了（那个品种下架了）。只留还在的；一个都不剩就是
  // 「全部」——否则用户打开就是一张空网格，而下拉里根本没有那个选项可以让他看出是怎么回事。
  // Stored symbols may have left the list (delisted). Keep only those still offered;
  // none left means "all" — otherwise the user lands on an empty grid with no option
  // in the dropdown explaining why.
  const effectiveSymbols = useMemo(
    () => symbolsF.filter((v) => symbolOptions.some((o) => o.value === v)),
    [symbolsF, symbolOptions],
  )

  // 平台全部策略名（近 30 天发过信号的，后端 /signals/strategy-names）。2026-10-12 起
  // 策略下拉列全部策略，不再只列此刻有信号的——和品种下拉同一个道理（见 symbolOptions）。
  // 取不到就退回只用这批信号里的。
  // Every platform strategy name (signals in the last 30 days, /signals/strategy-names).
  // Since 2026-10-12 the dropdown lists them all, not just those live right now — the
  // same reasoning as symbolOptions. On failure it falls back to this batch only.
  const [allStrategyNames, setAllStrategyNames] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    signalApi.strategyNames()
      .then((res) => { if (!cancelled) setAllStrategyNames(asStringList(res.names)) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // 策略选项：平台全部策略 + 这批信号里出现过的（新策略刚上线、名单缓存还没刷新）
  // + 用户已经选中的（勾不该凭空消失，否则筛选会悄悄变成「全部」）。个人策略统一成
  // 「我的策略」一项。
  // Strategy options: every platform strategy, plus those in this batch (a brand-new
  // strategy before the name list refreshes), plus whatever the user already picked
  // (a tick shouldn't silently vanish and turn the filter into "all"). Personal
  // strategies fold into one entry.
  const strategyOptions = useMemo(() => {
    const evalNow = Date.now()
    const keys = new Set<string>([...allStrategyNames, ...strategiesF])
    for (const sig of signals) {
      if (!isFree && effectiveStatus(sig, evalNow) === 'EXPIRED') continue
      keys.add(strategyKeyOf(sig))
    }
    const label = (k: string) =>
      k === MY_STRATEGY_KEY ? String(t('strategy.myStrategyBadge')) : k === NO_STRATEGY_KEY ? String(t('signals.indicatorNone')) : k
    const rows = [...keys].map((k) => ({ value: k, label: label(k) }))
    // 平台策略按名字排，「我的策略」垫底 / platform strategies by name, "mine" last
    rows.sort((a, b) => (a.value === MY_STRATEGY_KEY ? 1 : b.value === MY_STRATEGY_KEY ? -1 : a.label.localeCompare(b.label)))
    return rows
  }, [signals, strategiesF, allStrategyNames, isFree, t])

  const filterCount = effectiveSymbols.length + strategiesF.length
  const clearFilters = () => { setSymbolsF([]); setStrategiesF([]) }

  const filtered = useMemo(() => {
    // 到期判定只在信号数组变化时求值（新信号 / WS 置为 EXPIRED 都会触发重算），
    // 不再依赖每秒的时钟，避免整张网格每秒重新过滤/排序。
    // Expiry is evaluated only when the signals array changes (a new signal or a
    // WS EXPIRED flip both trigger it); no longer tied to the per-second clock,
    // so the whole grid stops re-filtering/sorting every second.
    const evalNow = Date.now()
    let list = signals
      .filter(s => {
        const eff = effectiveStatus(s, evalNow)
        // PRO 用户隐藏已过期信号（他们已通过 WS 实时看过 ACTIVE 阶段）
        // FREE 用户保留 EXPIRED 信号（这是他们唯一能看到的信号）
        if (!isFree && eff === 'EXPIRED') return false
        // 与 symbolOptions 同一把尺子：那边按展示名建选项，这边就必须按展示名比对，
        // 否则选中的「BTCUSDT」匹配不上原始名为 BTCUSD 的那 1322 条。
        // The same yardstick as symbolOptions: options are built from display
        // names, so the comparison must use one too, or picking "BTCUSDT" would
        // miss every row whose raw symbol is BTCUSD.
        if (effectiveSymbols.length > 0 && !effectiveSymbols.includes(displaySymbol(s.symbol))) return false
        if (strategiesF.length > 0 && !strategiesF.includes(strategyKeyOf(s))) return false
        return true
      })
    if (sortF === 'expiry') {
      // 按到期时间升序 = 按剩余时间升序，无需当前时间 / expireAt asc == remaining asc
      list.sort((a, b) => (parseTime(a.expireAt)?.getTime() ?? 0) - (parseTime(b.expireAt)?.getTime() ?? 0))
    } else {
      list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    }
    return list
  }, [signals, effectiveSymbols, strategiesF, sortF, isFree])

  return (
    <div>
      {/* 看板页头：左边标题 + 计数 + 副题，右边筛选器。原来是「标题一行、筛选
          一行」两层叠着；筛选器与标题同属页头这一层级，并排之后网格上方少一
          层，牌面直接顶到页头下面。窄屏筛选器自动折到第二行（仍可横向滚动）。
          Board head: title + count + subtitle on the left, filters on the right.
          They used to stack as two rows; the filters belong to the same level as
          the title, and sitting beside it removes one layer above the grid. On
          narrow screens the filters wrap to a second line (still scrollable). */}
      {/* 计数从实色紫药丸改成一个紫色等宽数字：页头里唯一的彩度就是它。
          Count moves from a solid violet pill to one violet tabular numeral, the
          only chroma in the head. */}
      <PageHead
        title={t('signals.title')}
        count={filtered.length}
        countUnit={t('signals.countUnit')}
        subtitle={t('signals.subtitle')}
        actions={
        /* 筛选器。品种是下拉，桌面手机共用同一个控件——下拉在窄屏本来就好用，
            不需要再单独做一套「点击循环」。排序仍是桌面药丸 / 手机循环两套：它只有
            两个值，为两个值开一个下拉是多余的层级。
            Filters. The symbol picker is one dropdown shared by both breakpoints — a
            dropdown already works on narrow screens, so it needs no separate
            tap-to-cycle variant. Sort keeps its pills/cycle split: with only two
            values, a dropdown would be more chrome than choice. */
        <div className="sig-filters">
          <div className="fgroup">
            <span className="fk">{t('signals.filterSymbol')}</span>
            {/* 用共享的自定义 Select：原生 <select> 的弹出列表由浏览器/系统渲染，
                深色主题下压不住样式，实测是一片白底黑字。
                The shared custom Select: a native popup list is rendered by the
                browser/OS and will not take dark-theme styling — a slab of white. */}
            <MultiSelect
              className={`sig-symbol-select${effectiveSymbols.length > 0 ? ' on' : ''}`}
              ariaLabel={t('signals.filterSymbol')}
              allLabel={t('signals.all')}
              values={effectiveSymbols}
              options={symbolOptions}
              onChange={setSymbolsF}
            />
          </div>
          <span className="fsep hidden sm:block" />
          <div className="fgroup">
            <span className="fk">{t('signals.filterStrategy')}</span>
            <MultiSelect
              className={`sig-symbol-select${strategiesF.length > 0 ? ' on' : ''}`}
              ariaLabel={t('signals.filterStrategy')}
              allLabel={t('signals.all')}
              values={strategiesF}
              options={strategyOptions}
              onChange={setStrategiesF}
            />
          </div>
          <span className="fsep hidden sm:block" />
          <div className="fgroup">
            <span className="fk">{t('signals.sortBy')}</span>
            {/* 桌面：药丸；手机：点击循环 / desktop pills, mobile tap-to-cycle */}
            <div className="seg-pill hidden sm:flex">
              <button className={sortF === 'latest' ? 'on' : ''} onClick={() => setSortF('latest')}>{t('signals.sort.latest')}</button>
              <button className={sortF === 'expiry' ? 'on' : ''} onClick={() => setSortF('expiry')}>{t('signals.sort.expiry')}</button>
            </div>
            <button className="filter-cycle flex sm:hidden" onClick={cycleSort}>
              <span>{sortLabel}</span>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
            </button>
          </div>
        </div>
        }
      />

      {/* FREE 用户提醒：升级看实时信号 / FREE tier notice: upgrade for live signals */}
      {isFree && (
        <div className="mb-5 rounded-xl border border-prism-400/30 bg-prism-500/10 px-4 py-3 text-sm text-neutral-300">
          {t('upgrade.freeBanner')}{" "}
          <Link to="/upgrade" className="font-semibold text-prism-400 underline hover:text-prism-300">
            {t('nav.upgrade')}
          </Link>
        </div>
      )}

      {/* 筛选生效提示：多选之后很容易忘了自己筛过，以为信号变少了。一键清空。
          Active-filter notice: with multi-select it's easy to forget a filter is on
          and conclude signals dried up. One tap clears it. */}
      {filterCount > 0 && (
        <div className="sig-filter-note">
          <span>
            {t('signals.filterActive')}
          </span>
          <button type="button" onClick={clearFilters}>{t('signals.clearFilters')}</button>
        </div>
      )}

      {/* Signal grid */}
      <div className="sig-grid">
        {filtered.length === 0 && (
          // 选了具体品种却筛不出东西，和整个面板本来就空，是两回事：前者要说清楚
          // 「这个品种现在没有信号」，不然读者会以为筛选器坏了。
          // Filtering to a symbol with no hits is not the same as an empty panel:
          // say which symbol has nothing right now, or the reader concludes the
          // filter is broken.
          <div className="sig-empty">
            {filterCount === 0 ? (
              // 整个面板为空时，节日期间换成节日插画；原句保留在插画下方。
              // An empty panel shows festival art in season; the original line stays below it.
              <FestivalEmpty fallback={t('signals.focus.noExecutable')} />
            ) : (
              t('signals.noneForFilter')
            )}
          </div>
        )}
        {filtered.map((sig, idx) => {
          const oRr = calcRiskReward(sig.symbol, sig.entry, sig.stopLoss, sig.takeProfit)
          const isBuy = sig.side === 'BUY'
          // FREE 用户是这个网格里唯一会看到 EXPIRED 信号的人(PRO 已在上面被过滤掉)；
          // 过期信号点「下单」只会在弹窗里被告知已过期，与其让按钮看起来能点却总是
          // 走空,不如直接禁用并如实标注状态。
          // FREE users are the only ones who ever see an EXPIRED signal in this grid
          // (PRO's are filtered out above); tapping "Trade" on one only reveals it's
          // expired inside the modal. Disable it up front and label it honestly
          // instead of a button that looks live but always dead-ends.
          const isExpired = sig.status === 'EXPIRED'
          const meta = symbolMeta(sig.symbol)
          const decimals = priceDecimals(sig.entry, sig.stopLoss, sig.takeProfit)

          // 价格阶梯的分割点见 SignalView.riskFraction：止损永远在左、止盈在右。
          // The ladder split lives in SignalView.riskFraction: SL left, TP right.
          const riskFrac = oRr ? riskFraction(oRr.riskPrice, oRr.rewardPrice) : null
          const style = {
            '--i': Math.min(idx, 8),
            ...(riskFrac != null ? { '--risk': `${(riskFrac * 100).toFixed(1)}%` } : {}),
          } as CSSProperties

          return (
            <article
              key={sig.id}
              className={`card glass sig-card${newIds.has(sig.id) ? ' is-new' : ''}${isExpired ? ' is-expired' : ''}`}
              style={style}
            >
              {/* 新信号进场：节日期间从右上角迸一小把节日碎片，牌面本身不动。
                  A new arrival bursts a few festival shards from the top-right
                  corner in season; the card itself is untouched. */}
              {newIds.has(sig.id) && <FestivalBurst />}
              {/* 牌头：身份芯片 + 品种（展示字宽）+ 方向；右侧盈亏比。策略名与
                  发出时间从页脚挪到品种下面——它们是这条信号的「署名」，跟品种
                  是一组，不该和下单按钮挤在最后一行。
                  Head: identity chip + symbol (display width) + side; R:R on the
                  right. Strategy and timestamp move up from the footer to sit under
                  the symbol — they are the signal's byline and belong with it, not
                  crammed on the last row beside the CTA. */}
              <header className="sig-card-head">
                <span
                  className="sym-ava"
                  style={{ background: meta.color + '33', color: meta.ink }}
                >
                  {meta.letter}
                </span>
                <div className="sig-card-id">
                  <div className="sig-card-sym">
                    <b className="font-display">{displaySymbol(sig.symbol)}</b>
                    <span className={`chip ${isBuy ? 'chip-buy' : 'chip-sell'}`}>
                      {isBuy ? t('common.buy') : t('common.sell')}
                    </span>
                  </div>
                  <div className="sig-card-meta">
                    <span className="strat">{sig.indicator || t('signals.indicatorNone')}</span>
                    <span className="at num">{fmtIssueClock(sig.createdAt)}</span>
                  </div>
                </div>
                <div className="sig-card-rr">
                  <b className={`num ${rrTone(oRr?.rr ?? null)}`}>
                    {oRr?.rr != null ? `1:${oRr.rr.toFixed(2)}` : '-'}
                  </b>
                  <span>{t('signals.focus.rrLabel')}</span>
                </div>
              </header>

              {/* 价格阶梯：止损｜入场｜止盈 + 风险/回报比例条。入场价是这张牌上
                  最大的数字——它是下单要对的那个数。
                  Price ladder: SL | entry | TP over the risk/reward rule. Entry is the
                  largest figure on the card — it is the number an order is checked
                  against. */}
              <div className="sig-ladder">
                <div className="sig-ladder-row">
                  <div className="lv sl">
                    <span className="cap">{t('signals.colSl')}</span>
                    <b className="num">{fmtPx(sig.stopLoss, decimals)}</b>
                  </div>
                  <div className="lv en">
                    <span className="cap">{t('signals.colEntry')}</span>
                    <b className="num">{fmtPx(sig.entry, decimals)}</b>
                  </div>
                  <div className="lv tp">
                    <span className="cap">{t('signals.colTp')}</span>
                    <b className="num">{fmtPx(sig.takeProfit, decimals)}</b>
                  </div>
                </div>
                <div className={`sig-ladder-bar${riskFrac == null ? ' none' : ''}`} aria-hidden="true">
                  <i className="risk" />
                  <i className="reward" />
                  <i className="mark" />
                </div>
              </div>

              <footer className="sig-card-foot">
                {isExpired ? (
                  // FREE 用户唯一能看到的信号就是这些已过期的——让延迟信号本身说话：
                  // 展示它最终判定的输赢，并提示 PRO 用户提前看到了它。数据早就在
                  // 后端返回体里（signal_resolution.py 判定），此前前端完全没用它。
                  // FREE users only ever see already-expired signals — let the delayed
                  // signal make its own case: show its final win/loss and note that PRO
                  // users saw it before it expired. The data was already in the API
                  // response (judged by signal_resolution.py); the frontend just never
                  // used it before.
                  <div className="sig-result">
                    <b className={resultTone(sig.result)}>{resultLabel(sig.result, t)}</b>
                    <span>{t('signals.proSawFirst')}</span>
                  </div>
                ) : (
                  <Countdown expireAt={sig.expireAt} label={t('signals.focus.remainingTtl')} />
                )}
                <button
                  onClick={() => !isExpired && onTrade(sig)}
                  disabled={isExpired}
                  className={`btn sig-cta ${isExpired ? 'btn-secondary' : 'btn-primary'}`}
                >
                  {isExpired ? t('signals.expired') : t('signals.trade')}
                </button>
              </footer>
            </article>
          )
        })}
      </div>
    </div>
  )
}

// memo：signals/onTrade/userPlan 不变时跳过重渲染（如父页因报价刷新而重渲染）。
// memo: skip re-render when signals/onTrade/userPlan are unchanged (e.g. when the
// parent page re-renders due to a quote tick).
export default memo(SignalGrid)
