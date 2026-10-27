// 单个策略的细节：三个问题，每个问题一块。
//   哪个时段更准？ / 做多还是做空更准？ / 一天里哪个小时更准？
// 标题直接是问句——新手不需要知道"分时段胜率"这种术语，只需要找到自己想问
// 的那个问题。每一行都是同一套读法：名字、百分比（颜色即判定）、拔河条。
// 钟点格后端只给止盈/止损笔数，这里用同一条 Wilson 公式补出区间，再走同一个
// verdictOf——整页一条规则，不给钟点格开特例。
//
// 「星期几更准」换成了「哪个小时更准」：产品要回答的是"一天里什么时候该盯"，
// 星期几回答不了。「一般多久出结果」整块删除。
//
// One strategy in depth: three questions, one block each — which session, long
// or short, which hour of the day. Titles are literal questions so a newcomer
// finds the one they are asking instead of decoding a term. Every row reads the
// same way: name, percentage (colour is the verdict), tug bar. Hour cells get
// their interval from the same Wilson formula and the same verdictOf — one rule
// for the page, no exception for them. The weekday grid became an hour grid
// because the product question is "when in the day should I watch", which a
// weekday cannot answer; the time-to-resolution block is gone entirely.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { HourOutcome, StrategyWinRate, SymbolWinRate, WinRateBucket } from '../../api/types'
import TugBar from './TugBar'
import {
  SIDE_COLORS, VERDICT_BG, VERDICT_COLOR,
  bandOf, fmtClock, fmtPct, isRated, verdictOf,
} from './shared'

function Block({ title, hint, children, className = '' }: {
  title: string; hint?: string; children: React.ReactNode
  // 网格定位类。三块是同一个网格的直接子项，桌面端的两列布局靠调用方传
  // col-start / row-start 摆出来（见下方网格处的说明）。
  // Grid placement classes. The three blocks are direct children of one grid and
  // the caller positions them into the desktop two-column layout with
  // col-start / row-start — see the note at the grid below.
  className?: string
}) {
  return (
    <section className={`wr-block ${className}`}>
      <h4>{title}</h4>
      {/* 提示用 12px 而不是 10px：这几行带着该块最重要的口径说明，手机上 10px
          中文会是整页最难读的字。/ 12px, not 10px: these lines carry the block's
          key caveats and 10px Chinese is the least legible text on a phone. */}
      {hint && <p className="hint">{hint}</p>}
      <div className="body">{children}</div>
    </section>
  )
}

function RateRow({ label, dotColor, bucket }: {
  label: string; dotColor: string; bucket: WinRateBucket
}) {
  const { t } = useTranslation()
  const kind = verdictOf(bucket)
  const hasRate = isRated(kind) && bucket.winRate !== null
  const aria = t('admin.winrate.aria.tug', {
    label, tp: bucket.hitTp, sl: bucket.hitSl, rate: hasRate ? fmtPct(bucket.winRate!) : '—',
  })
  return (
    <div className="wr-rate-row">
      <div className="top">
        <span className="lbl">
          <i style={{ backgroundColor: dotColor }} />
          <span className="txt">{label}</span>
        </span>
        <span className="pct num" style={{ color: VERDICT_COLOR[kind] }}>
          {hasRate ? fmtPct(bucket.winRate!) : '—'}
        </span>
      </div>
      {bucket.resolved > 0 && (
        <TugBar className="mt-2" size="sm" hitTp={bucket.hitTp} hitSl={bucket.hitSl} label={aria} />
      )}
    </div>
  )
}

/** 24 个钟点格，按**浏览者本地钟点**升序排。
 *
 *  后端按 UTC 分桶（它不可能知道读者在哪个时区），这里旋转过来：24 格是一个
 *  完整的循环，旋转无损。半小时时区（如 +5:30）也照样成立——每格的标签由
 *  UTC 钟点 + 偏移算出，会显示成「05:30」，格子边界本来就落在本地的半点上。
 *
 *  Twenty-four hour cells ordered by the **viewer's local clock**. The backend
 *  buckets in UTC (it cannot know the reader's zone) and the rotation here is
 *  lossless because 24 slots are a full cycle. Half-hour zones (+5:30 and the
 *  like) work too: each label is derived from the UTC hour plus the offset and
 *  renders as "05:30" — the bucket boundary genuinely falls on the local half
 *  hour. */
function HourGrid({ hourly, now }: { hourly: HourOutcome[]; now: Date }) {
  const { t } = useTranslation()
  const offset = -now.getTimezoneOffset()
  const slots = hourly
    .map((h, utcHour) => ({ ...h, localMinutes: (((utcHour * 60 + offset) % 1440) + 1440) % 1440 }))
    .sort((a, b) => a.localMinutes - b.localMinutes)

  return (
    <div className="wr-hours">
      {slots.map((s) => {
        // 不设样本门槛（2026-10-11，与「最高 / 最低时段」同口径）：有一笔已判定就给
        // 百分比——否则榜单里写着 100% 的那个小时，在这里却是「—」。
        // No sample floor (2026-10-11, same rule as the best/worst lists): one resolved
        // trade earns a percentage, or a list's 100% hour would read "—" here.
        const n = s.tp + s.sl
        const label = fmtClock(s.localMinutes)
        if (n === 0) {
          return (
            <span key={s.localMinutes} className="wr-hour off">
              <span className="h num">{label}</span>
              <span className="p num">—</span>
            </span>
          )
        }
        const winRate = s.tp / n
        // 格子窄，百分比取整（下面的 fmtPct(..., 0)）——判定也要按整数切，
        // 否则 50.5% 会显示成「51%」却上橙色，和读者看到的数字对不上。
        // The cells are narrow so the percentage is rounded to an integer below;
        // the verdict must round the same way, or 50.5% shows as "51%" in amber.
        const kind = bandOf(winRate, 0)
        return (
          <span key={s.localMinutes} className="wr-hour"
                style={{ background: VERDICT_BG[kind], color: VERDICT_COLOR[kind] }}>
            <span className="h num">{label}</span>
            {/* 判定图形（↑↓=?）已按产品要求去掉，格子只剩钟点和百分比，判定由颜色
                承担。代价是这里变成纯颜色编码：色弱读者分不出绿和红，「差不多」和
                「还看不出」两种灰更是分不开。下面这行 sr-only 因此保留——它是读屏器
                唯一能拿到判定的地方。
                The verdict glyph was removed at the product owner's request: a cell
                is now just an hour and a percentage, with colour carrying the
                verdict. The cost is colour-only encoding — a colour-blind reader
                cannot separate green from red, and the two greys ("about even" vs
                "can't tell") not at all. The sr-only line below therefore stays: it
                is the only place a screen reader can get the verdict. */}
            <span className="sr-only">{t(`admin.winrate.verdict.${kind}`)}</span>
            <span className="p num">{fmtPct(winRate, 0)}</span>
          </span>
        )
      })}
    </div>
  )
}

/** 展开一张策略卡时默认落在哪个品种上。
 *
 *  黄金是平台信号量最大、也是用户开口就问的品种，展开直接就是它，比每次都让人
 *  多点一下强。该策略在窗口内没有黄金信号时退回「全部品种」——绝不能选一个不
 *  存在的页签，那会让整块详情空掉。
 *
 *  这是纯展示层的默认值，不影响任何统计口径：换页签只是换读哪一份已经算好的数。
 *
 *  Which symbol a strategy card lands on when expanded.
 *
 *  Gold carries the most signals on the platform and is the symbol users ask
 *  about first, so opening straight to it beats making them click every time.
 *  Falls back to "all symbols" when the strategy traded no gold inside the
 *  window — selecting a tab that does not exist would blank the whole detail
 *  block.
 *
 *  A presentation default only; it changes nothing about how anything is
 *  computed, just which already-computed slice is being read. */
const DEFAULT_SYMBOL = 'XAUUSD'

/** `wanted` 是卡片收起时选中的那个品种：展开后默认停在同一个上，否则收起写着
 *  WTI、点开却是黄金，同一张卡自相矛盾。它不在这个策略里（或没传）时退回黄金，
 *  再退回「全部品种」。
 *  `wanted` is the symbol picked on the collapsed card: the expanded view stays on
 *  it, or one card would say WTI collapsed and gold expanded. Falls back to gold,
 *  then to "all symbols", when absent or not given. */
const preferredTab = (row: StrategyWinRate, wanted?: string): string =>
  (wanted && row.symbols.some((s) => s.symbol === wanted) && wanted)
  || (row.symbols.some((s) => s.symbol === DEFAULT_SYMBOL) ? DEFAULT_SYMBOL : 'all')

export default function StrategyDetail({ row, days, now, defaultSymbol }: {
  row: StrategyWinRate
  // 卡片收起时选中的品种，展开后默认停在它上面。
  // The symbol picked on the collapsed card; the expanded view opens on it.
  defaultSymbol?: string
  days: number
  // 只用来把 UTC 钟点格旋转成浏览者本地钟点。面板持有唯一的每分钟计时器，
  // 组件一律接收 now，不自己 new Date()。
  // Only used to rotate the UTC hour cells into the viewer's local clock. The
  // panel owns the single per-minute timer; components take `now` rather than
  // calling new Date() themselves.
  now: Date
}) {
  const { t } = useTranslation()
  const [symbolTab, setSymbolTab] = useState<string>(() => preferredTab(row, defaultSymbol))
  // 只在策略换人时重置。列表用 key={row.strategy} 渲染，实例是稳定的，所以这个
  // effect 实际上不会在挂载后再触发——留着是防御性的：哪天列表改成按序号 key，
  // 复用的实例会带着上一个策略的品种页签，而那个页签指向的品种可能根本不在新
  // 策略里。数据轮询刷新不该走这里（依赖只有 strategy 名），否则用户每 N 秒被
  // 弹回默认品种一次。
  // Reset only when the strategy itself changes. The list renders with
  // key={row.strategy}, so instances are stable and this effect never fires
  // after mount; it stays as defence for the day the list is keyed by index
  // instead, when a reused instance would carry the previous strategy's symbol
  // tab — possibly naming a symbol the new strategy never traded. A data poll
  // must not trigger it (the dep is the name alone), or the user's chosen symbol
  // would snap back to the default every few seconds.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setSymbolTab(preferredTab(row, defaultSymbol)) }, [row.strategy, defaultSymbol])
  // 派生值兜底：页签指向的品种若不在当前 row 里，同一次 render 内退回「全部」。
  // Derived fallback: a tab naming a symbol absent from this row snaps to "all"
  // within the same render.
  const effectiveTab = row.symbols.some((s) => s.symbol === symbolTab) ? symbolTab : 'all'
  const target: StrategyWinRate | SymbolWinRate =
    effectiveTab === 'all' ? row : row.symbols.find((s) => s.symbol === effectiveTab)!
  // 钟点格跟着选中的品种走：后端从 2026-08-26 起在品种层的 total 上也下发 hourly，
  // 所以「这个策略在这个品种上，一天里哪个小时更准」是能直接读出来的。
  // The hour grid follows the selected symbol: since 2026-08-26 the backend also
  // ships `hourly` on each symbol's total, so "which hour is this strategy best
  // at on this symbol" reads straight off the payload.
  const hourly = target.total.hourly

  // 品种页签用全站的 .seg-pill（信号板筛选器同一套药丸），不再自带一套半透明紫。
  // Symbol tabs use the site-wide .seg-pill (the board's filter pills), not a
  // bespoke translucent-violet variant.
  return (
    <div className="wr-detail">
      <div className="wr-detail-intro">
        <span>{t('admin.winrate.detail.intro')}</span>
        {row.symbols.length > 0 && (
          <div className="seg-pill flex-wrap" role="tablist">
            <button type="button" role="tab" aria-selected={effectiveTab === 'all'}
                    onClick={() => setSymbolTab('all')} className={effectiveTab === 'all' ? 'on' : ''}>
              {t('admin.winrate.detail.allSymbols')}
            </button>
            {row.symbols.map((s) => (
              <button key={s.symbol} type="button" role="tab" aria-selected={effectiveTab === s.symbol}
                      onClick={() => setSymbolTab(s.symbol)} className={`num${effectiveTab === s.symbol ? ' on' : ''}`}>
                {s.symbol}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 两块：钟点 → 方向。原来最前面还有一块「按亚 / 欧 / 美盘」，2026-10-11 按产品
          要求去掉——时段一律按小时看。
          Two blocks: hours -> direction. A leading Asia / Europe / New York block was
          removed on 2026-10-11 at the product owner's request; time of day is read
          by the hour only. */}
      <div className="grid gap-4 lg:grid-cols-2">
        {hourly && (
          <Block title={t('admin.winrate.detail.byHour')} hint={t('admin.winrate.detail.byHourHint', { days })}>
            <HourGrid hourly={hourly} now={now} />
          </Block>
        )}

        <Block title={t('admin.winrate.detail.bySide')} hint={t('admin.winrate.detail.bySideHint')}>
          {(['BUY', 'SELL'] as const).map((k) => target.sides[k] && (
            <RateRow key={k} label={t(`admin.winrate.side.${k}`)} dotColor={SIDE_COLORS[k]} bucket={target.sides[k]} />
          ))}
        </Block>
      </div>
    </div>
  )
}
