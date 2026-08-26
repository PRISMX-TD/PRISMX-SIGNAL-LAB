// 信号面板独立视图：筛选器 + 信号网格
// Signal panel view: filters + signal cards grid
import { type FC, memo, useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { usePrefs } from '../../store/prefs'
import Select from '../Select'
import type { Signal, UserPlan } from '../../api/types'
import { calcRiskReward, calcCountdown, displaySymbol, fmtTime, parseTime } from '../../api/utils'
import { SIGNAL_LIFESPAN_MS, effectiveStatus, resultLabel, resultTone, rrTone } from './SignalView'
import { useClock } from './hooks'
import { symbolMeta } from '../../utils/symbolMeta'

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

// 倒计时叶子：订阅共享时钟自行每秒刷新，不牵动整张卡片/网格重渲染。
// Countdown leaf: subscribes to the shared clock and ticks on its own, without
// dragging the whole card/grid into a per-second re-render.
const Countdown: FC<{ expireAt: string | null; label: string }> = memo(({ expireAt, label }) => {
  const now = useClock()
  const cd = calcCountdown(expireAt, SIGNAL_LIFESPAN_MS, now)
  return (
    <>
      <div className="flex justify-between text-[11px] mb-1">
        <span className="text-neutral-500">{label}</span>
        <span className="num text-prism-300">{cd?.text ?? '-'}</span>
      </div>
      <div className="sig-ttl-bar">
        <i style={{ width: `${Math.round((cd?.fraction ?? 0) * 100)}%` }} />
      </div>
    </>
  )
})

const SignalGrid: FC<Props> = ({ signals, onTrade, userPlan, activeSymbols }) => {
  const { t } = useTranslation()
  const { getPref, setPref } = usePrefs()

  // 品种筛选（2026-08-26 顶掉原来的方向筛选）。存进 usePrefs 的 signals 命名空间，
  // 和 sortF 同一套：那是**云端按用户落库**的偏好，还会通过 WS 推到该用户的其它
  // 设备——比 localStorage 强，localStorage 只认浏览器不认人。
  // Symbol filter (replaced the direction filter on 2026-08-26). Stored in the
  // same `signals` namespace of usePrefs as sortF: a cloud-persisted, per-user
  // preference that is also pushed to that user's other devices over WS — unlike
  // localStorage, which knows browsers rather than people.
  const [symbolF, setSymbolF] = useState<string>(
    () => getPref<string>('signals', 'symbolF', 'ALL')
  )
  const [sortF, setSortF] = useState<'latest' | 'expiry'>(
    () => (getPref<string>('signals', 'sortF', 'latest')) as 'latest' | 'expiry'
  )

  useEffect(() => { setPref('signals', 'symbolF', symbolF) }, [symbolF, setPref])
  useEffect(() => { setPref('signals', 'sortF', sortF) }, [sortF, setPref])

  // 手机端：点击循环切换筛选值，无需列出全部选项 / mobile: tap to cycle filter value
  const cycleSort = () => setSortF(s => (s === 'latest' ? 'expiry' : 'latest'))
  const sortLabel = sortF === 'latest' ? t('signals.sort.latest') : t('signals.sort.expiry')

  const isFree = userPlan === 'FREE'

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
    const rows = [...seen].sort().map((name) => ({ value: name, label: name }))
    // 「全部」留着，而且是默认值：这是个**筛选器**，没有全部就没法看回完整列表。
    // （仪表盘那张卡刻意没有「全部」，因为那里是「选一路来分析」，不是筛选。）
    // "All" stays, and is the default: this is a *filter*, and without it there is
    // no way back to the full board. (The dashboard card deliberately omits "all"
    // because there you are choosing one line to analyse, not filtering a list.)
    return [{ value: 'ALL', label: t('signals.all') }, ...rows]
  }, [signals, activeSymbols, isFree, t])

  // 存下来的品种可能已经不在这批信号里了（那个品种最近没发信号，或者换了套餐后
  // 可见范围变了）。这时候退回「全部」——否则用户打开就是一张空网格，而下拉里
  // 根本没有那个选项可以让他看出是怎么回事。
  // The stored symbol may be absent from this batch (it stopped firing, or the
  // visible set changed with the plan). Fall back to ALL — otherwise the user
  // lands on an empty grid with no option in the dropdown explaining why.
  const effectiveSymbol = symbolOptions.some((o) => o.value === symbolF) ? symbolF : 'ALL'

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
        if (effectiveSymbol !== 'ALL' && displaySymbol(s.symbol) !== effectiveSymbol) return false
        return true
      })
    if (sortF === 'expiry') {
      // 按到期时间升序 = 按剩余时间升序，无需当前时间 / expireAt asc == remaining asc
      list.sort((a, b) => (parseTime(a.expireAt)?.getTime() ?? 0) - (parseTime(b.expireAt)?.getTime() ?? 0))
    } else {
      list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    }
    return list
  }, [signals, effectiveSymbol, sortF, isFree])

  return (
    <div>
      {/* Page head */}
      <div className="sig-page-head">
        <h2>{t('signals.title')}</h2>
        <span className="count-badge">{filtered.length}</span>
        <p>{t('signals.subtitle')}</p>
      </div>

      {/* FREE 用户提醒：升级看实时信号 / FREE tier notice: upgrade for live signals */}
      {isFree && (
        <div className="mb-4 rounded-xl border border-prism-400/30 bg-prism-500/10 px-4 py-3 text-sm text-neutral-300">
          {t('upgrade.freeBanner')}{" "}
          <Link to="/upgrade" className="font-semibold text-prism-400 underline hover:text-prism-300">
            {t('nav.upgrade')}
          </Link>
        </div>
      )}

      {/* 筛选器。品种是下拉，桌面手机共用同一个控件——下拉在窄屏本来就好用，
          不需要再单独做一套「点击循环」。排序仍是桌面药丸 / 手机循环两套：它只有
          两个值，为两个值开一个下拉是多余的层级。
          Filters. The symbol picker is one dropdown shared by both breakpoints — a
          dropdown already works on narrow screens, so it needs no separate
          tap-to-cycle variant. Sort keeps its pills/cycle split: with only two
          values, a dropdown would be more chrome than choice. */}
      <div className="sig-filters">
        <div className="fgroup">
          <span className="fk">{t('signals.filterSymbol')}</span>
          {/* 用共享的自定义 Select：原生 <select> 的弹出列表由浏览器/系统渲染，
              深色主题下压不住样式，实测是一片白底黑字。
              The shared custom Select: a native popup list is rendered by the
              browser/OS and will not take dark-theme styling — a slab of white. */}
          <Select
            className={`sig-symbol-select${effectiveSymbol !== 'ALL' ? ' on' : ''}`}
            ariaLabel={t('signals.filterSymbol')}
            value={effectiveSymbol}
            options={symbolOptions}
            onChange={setSymbolF}
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

      {/* Signal grid */}
      <div className="sig-grid">
        {filtered.length === 0 && (
          // 选了具体品种却筛不出东西，和整个面板本来就空，是两回事：前者要说清楚
          // 「这个品种现在没有信号」，不然读者会以为筛选器坏了。
          // Filtering to a symbol with no hits is not the same as an empty panel:
          // say which symbol has nothing right now, or the reader concludes the
          // filter is broken.
          <div className="sig-empty">
            {effectiveSymbol === 'ALL'
              ? t('signals.focus.noExecutable')
              : t('signals.noneForSymbol', { symbol: effectiveSymbol })}
          </div>
        )}
        {filtered.map((sig) => {
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

          return (
            <div
              key={sig.id}
              className="card glass p-4"
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  {/* 身份芯片：数据早就在 symbolMeta() 里，此前只有报价表用它。
                      Identity chip; the data was always there. */}
                  <span
                    className="sym-ava"
                    style={{ background: symbolMeta(sig.symbol).color + '33', color: symbolMeta(sig.symbol).ink }}
                  >
                    {symbolMeta(sig.symbol).letter}
                  </span>
                  <b className="text-lg font-bold text-white">{displaySymbol(sig.symbol)}</b>
                  <span className={`chip ${isBuy ? 'chip-buy' : 'chip-sell'}`}>
                    {isBuy ? t('common.buy') : t('common.sell')}
                  </span>
                </div>
                <div className="text-right">
                  <div className={`text-xl font-bold ${rrTone(oRr?.rr ?? null)}`}>
                    {oRr?.rr != null ? `1:${oRr.rr.toFixed(2)}` : '-'}
                  </div>
                  <div className="text-[10px] uppercase text-neutral-500">{t('signals.focus.rrLabel')}</div>
                </div>
              </div>

              <div className="sl-tp-grid three mt-3">
                <div className="exec-tile" style={{ background: 'rgba(255,255,255,0.03)' }}>
                  <div className="cap">{t('signals.colEntry')}</div>
                  <div className="val num" style={{ color: '#fff', fontSize: '13px' }}>{sig.entry ?? '-'}</div>
                </div>
                <div className="exec-tile tile-sl">
                  <div className="cap">{t('signals.colSl')}</div>
                  <div className="val num" style={{ fontSize: '13px' }}>{sig.stopLoss ?? '-'}</div>
                </div>
                <div className="exec-tile tile-tp">
                  <div className="cap">{t('signals.colTp')}</div>
                  <div className="val num" style={{ fontSize: '13px' }}>{sig.takeProfit ?? '-'}</div>
                </div>
              </div>

              {isExpired ? (
                // FREE 用户唯一能看到的信号就是这些已过期的——让延迟信号本身说话：
                // 展示它最终判定的输赢，并提示 PRO 用户提前看到了它。数据早就在
                // 后端返回体里（signal_resolution.py 判定），此前前端完全没用它。
                // FREE users only ever see already-expired signals — let the delayed
                // signal make its own case: show its final win/loss and note that PRO
                // users saw it before it expired. The data was already in the API
                // response (judged by signal_resolution.py); the frontend just never
                // used it before.
                <div className="mt-3 flex items-center justify-between rounded-lg bg-white/[0.03] px-3 py-2">
                  <span className={`text-xs font-bold ${resultTone(sig.result)}`}>
                    {resultLabel(sig.result, t)}
                  </span>
                  <span className="text-[10px] text-neutral-500">{t('signals.proSawFirst')}</span>
                </div>
              ) : (
                <div className="mt-3">
                  <Countdown expireAt={sig.expireAt} label={t('signals.focus.remainingTtl')} />
                </div>
              )}

              <div className="flex items-center justify-between mt-3">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-neutral-300 truncate">{sig.indicator || '-'}</div>
                  <div className="text-[10px] text-neutral-500 mt-0.5">{fmtTime(sig.createdAt)}</div>
                </div>
                <button
                  onClick={() => !isExpired && onTrade(sig)}
                  disabled={isExpired}
                  className={`btn rounded-xl px-6 py-2 text-[13px] font-semibold shrink-0 ml-3 ${
                    isExpired
                      ? 'cursor-not-allowed border border-white/10 bg-white/5 text-neutral-500'
                      : 'btn-primary'
                  }`}
                >
                  {isExpired ? t('signals.expired') : t('signals.trade')}
                </button>
              </div>
            </div>
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
