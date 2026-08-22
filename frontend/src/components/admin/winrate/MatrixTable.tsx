// 策略 × 时段胜率矩阵表——从 StrategyWinratePanel.tsx 抽出，便于单独维护/复用。
// 搬移铁律：Cell 的四态判断（—/待判/中断/百分比）、Row 的汇总行样式、表头两行
// 时段小字、外层 overflow-x-auto + min-w-[560px] 容器——原样保留，不改行为；
// 三处升级（活跃列高亮/格子迷你条/策略名可点）叠加其上，不重写。
// The strategy × session win-rate matrix, split out of StrategyWinratePanel so
// it can be maintained/reused on its own. Hard rule for the move: Cell's
// four-state logic (—/pending/stale/percentage), the summary row styling, the
// two-line session header, and the overflow-x-auto + min-w-[560px] wrapper
// carry over unchanged; the three upgrades (active-column highlight, per-cell
// mini bar, clickable strategy name) are additive, not a rewrite.
import { useTranslation } from 'react-i18next'
import type { AdminStrategyWinRate, StrategyWinRate, WinRateBucket } from '../../../api/types'
import { MIN_SAMPLES, SESSION_COLORS, localWindow } from './shared'
import WinRateBar from './WinRateBar'

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

// 胜率配色只有三档，且只在样本足够时才上色——给一个 3 笔样本的格子涂绿色，
// 等于用颜色替读者下了一个数据支撑不了的结论。
// Three colour steps, applied only when the sample is large enough: colouring a
// three-trade cell green would use colour to assert a conclusion the data can't
// support.
function winRateClass(rate: number): string {
  if (rate >= 0.6) return 'text-up'
  if (rate <= 0.4) return 'text-down'
  return 'text-neutral-100'
}

function Cell({ bucket }: { bucket: WinRateBucket }) {
  const { t } = useTranslation()
  // 完整的四态明细统一挂在 title 上：表格里放不下，但排查时第一个想看的就是它。
  // The full four-state breakdown always goes on the title: there's no room for
  // it in the table, yet it's the first thing anyone debugging wants to see.
  const hint = t('admin.winrate.cellHint', {
    tp: bucket.hitTp, sl: bucket.hitSl, pending: bucket.pending, stale: bucket.stale,
  })
  if (bucket.samples === 0) {
    return <span className="text-neutral-600">—</span>
  }
  // 一条都没判定出来：显示待判定/追踪中断的条数，而不是"0 笔"。
  // "0 笔" 是这个面板上线后第一个真实故障现场给出的读数，而它把两种完全不同的
  // 情况（这个格子没信号 / 有一批信号但判定链路根本没跑）显示成了同一个样子——
  // 判定只在 POST /webhook/trend 带 high/low 时触发，链路一断就是满屏 0 笔。
  // Nothing resolved: show how many are pending or stale instead of "0 trades".
  // "0" was the readout from this panel's first real incident, and it rendered
  // two entirely different situations identically (no signals in this cell vs. a
  // pile of signals the resolver never touched). Resolution only fires on POST
  // /webhook/trend with high/low, so a broken feed means a screen full of zeros.
  if (bucket.resolved === 0) {
    return (
      <span className="text-amber-400/80" title={hint}>
        {bucket.pending > 0
          ? t('admin.winrate.pendingOnly', { count: bucket.pending })
          : t('admin.winrate.staleOnly', { count: bucket.stale })}
      </span>
    )
  }
  if (bucket.winRate === null || bucket.resolved < MIN_SAMPLES) {
    return (
      <span className="text-neutral-500" title={hint}>
        {/* count 而不是 resolved：i18next 靠这个参数名选单复数形式（英文 1 笔 / N 笔）。
            count, not resolved: i18next keys plural selection off this exact name. */}
        {t('admin.winrate.thinSample', { count: bucket.resolved })}
      </span>
    )
  }
  // 升级：只有真的显示百分比的格子才在数字下方加一行迷你堆叠条——待判/中断/
  // 样本不足三态维持原样，不裹这层竖排布局。
  // Upgrade: only the cell that actually renders a percentage gets a mini bar
  // beneath the numbers; the pending/stale/thin-sample states stay unwrapped.
  return (
    <span className="flex flex-col items-end gap-0.5" title={hint}>
      <span>
        <span className={`font-medium tabular-nums ${winRateClass(bucket.winRate)}`}>{fmtPct(bucket.winRate)}</span>
        <span className="ml-1.5 text-[10px] tabular-nums text-neutral-500">
          {bucket.hitTp}/{bucket.resolved}
        </span>
      </span>
      {/* mini 条的分段间隙随容器宽度浮动（固定 viewBox + preserveAspectRatio="none"
          的固有限制）。实测：52px 宽时物理间隙只有约 1.04px，太薄；96px（与
          WinRateBar 自身注释里"非 mini 参考宽度 w-24"一致）时约 1.92px，与该
          组件设计目标的 2px 间隙基本吻合——所以在格子这一侧给它 96px 的下限，
          不去改 WinRateBar 本身。真实矩阵里数字列通常会被表格自动布局撑到
          100~120px（策略名列挤占的空间有限），96px 只是极端情况下的兜底。
          The mini bar's segment gap floats with container width (fixed viewBox +
          preserveAspectRatio="none"). Measured: at 52px the physical gap is only
          ~1.04px — too thin; at 96px (matching the "non-mini reference width w-24"
          WinRateBar's own comments cite) it's ~1.92px, close to that component's
          2px design target. So give the cell a 96px floor here, not inside
          WinRateBar. In a real matrix these columns are usually stretched past
          that by the table's auto layout (the strategy column only claims so
          much); 96px is the floor for the pathological case. */}
      <span className="w-full min-w-[96px]">
        <WinRateBar bucket={bucket} mini />
      </span>
    </span>
  )
}

function Row({
  row,
  sessionKeys,
  isSummary,
  onSelectStrategy,
}: {
  row: StrategyWinRate
  sessionKeys: string[]
  isSummary?: boolean
  onSelectStrategy: (name: string) => void
}) {
  const { t } = useTranslation()
  const label = isSummary ? t('admin.winrate.allStrategies') : row.strategy || t('admin.winrate.unnamed')
  return (
    <tr className={isSummary ? 'border-t border-white/10 bg-white/[0.03]' : 'border-t border-white/5'}>
      <td className={`py-2 pr-3 ${isSummary ? 'font-medium text-neutral-100' : 'text-neutral-200'}`}>
        {isSummary ? (
          label
        ) : (
          // 汇总行不加按钮：它不是某一个具体策略，没有"选中它"这回事。
          // The summary row gets no button: it isn't a single strategy, so there's
          // nothing meaningful to "select".
          <button
            type="button"
            onClick={() => onSelectStrategy(row.strategy)}
            className="text-left hover:text-prism-200 transition"
          >
            {label}
          </button>
        )}
      </td>
      <td className="py-2 pr-3 text-right">
        <Cell bucket={row.total} />
      </td>
      {sessionKeys.map((key) => (
        <td key={key} className="py-2 pr-3 text-right">
          <Cell bucket={row.sessions[key]} />
        </td>
      ))}
    </tr>
  )
}

export default function MatrixTable({
  data,
  activeKeys,
  now,
  onSelectStrategy,
}: {
  data: AdminStrategyWinRate
  activeKeys: string[]
  // 时钟从 props 进来，组件不自己 new Date()：`now` 只喂表头的"你的时间
  // HH:MM–HH:MM"换算，而 activeKeys（同一行表头的高亮）是 StrategyWinratePanel
  // 用它那个每分钟计时器的 now 算出来的。自己取一次 new Date() 就是第二个时钟，
  // 两者在整分钟边界会短暂不一致：一列被判成活跃并高亮，旁边的窗口文字却还按
  // 上一分钟的偏移渲染。面板的注释已经把"两个组件都不带自己的计时器就是为了
  // 对齐同一个 now"写成约定，这里遵守它。
  // The clock arrives as a prop; this component never calls new Date(). `now`
  // feeds only the header's "your time HH:MM–HH:MM" conversion, while
  // activeKeys — the highlight on that same header row — is computed by
  // StrategyWinratePanel from its own per-minute timer's `now`. A local
  // new Date() would be a second clock, and the two disagree briefly at every
  // minute boundary: a column highlighted as active beside a window label still
  // rendered at the previous minute's offset. The panel's comments already state
  // the convention — no component carries its own timer, precisely so they all
  // share one `now`.
  now: Date
  onSelectStrategy: (name: string) => void
}) {
  const { t } = useTranslation()
  // outside 桶固定排在三个时段之后：它不是一个"盘"，是三个盘之间的空档。
  // The outside bucket always sorts after the three real sessions — it isn't a
  // session, it's the gaps between them.
  const sessionKeys = [...(data.sessions ?? []).map((s) => s.key), 'outside']

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-xs">
        <thead>
          <tr className="text-left align-bottom text-neutral-500">
            <th className="pb-2 pr-3 font-medium">{t('admin.winrate.colStrategy')}</th>
            <th className="pb-2 pr-3 text-right font-medium">{t('admin.winrate.colTotal')}</th>
            {(data.sessions ?? []).map((s) => {
              const w = localWindow(s, now)
              // 升级：活跃时段列加一条底部彩色下划线 + 更亮的文字色。outside 不是
              // 真实时段（SESSION_COLORS 里没有它的颜色），activeKeys 也不会带它，
              // 所以这段高亮逻辑只覆盖这个 map，不延伸到下面单独渲染的 outside 表头。
              // Upgrade: an active session column gets a coloured bottom underline
              // and brighter text. "outside" isn't a real session (no colour in
              // SESSION_COLORS, never in activeKeys), so this highlight logic stays
              // scoped to this map and doesn't extend to the outside header below.
              //
              // 文字变亮必须加在时段名那个 <div> 上，不能只加在 <th> 上：三行文字都
              // 各自包着显式 text-* 类的 <div>，子元素一旦自己声明了 color，祖先的
              // color 类无论优先级多高都不会覆盖它——加在 <th> 上是永远不可见的死
              // class（这是代码审查抓到的问题，这里已按审查建议改成子元素响应）。
              // The brighter text has to live on the session-name <div>, not the
              // <th>: all three lines are wrapped in <div>s with their own explicit
              // text-* class, and once a descendant declares its own color, no
              // ancestor color class can override it regardless of specificity —
              // putting it on the <th> was dead, invisible CSS (caught in code
              // review; fixed here per the reviewer's suggestion of making the
              // child respond instead).
              const active = activeKeys.includes(s.key)
              return (
                <th
                  key={s.key}
                  className="pb-2 pr-3 text-right font-medium"
                  style={active ? { boxShadow: `inset 0 -2px 0 ${SESSION_COLORS[s.key]}` } : undefined}
                >
                  <div className={active ? 'text-neutral-100' : 'text-neutral-300'}>
                    {t(`admin.winrate.session.${s.key}`)}
                  </div>
                  {/* 两行：上面是该金融中心的本地时间（口径本身），下面是换算到
                      管理员本地时区的钟点（实际几点看盘）。只给其中一个都会让人
                      在夏令时前后怀疑数据错了。
                      Two lines: the centre's own local window (the definition) above,
                      the same window in the admin's clock below. Showing only one of
                      them invites "the data looks wrong" every changeover. */}
                  <div className="text-[10px] font-normal tabular-nums text-neutral-600">
                    {String(s.startHour).padStart(2, '0')}:00–{String(s.endHour).padStart(2, '0')}:00 {s.tz}
                  </div>
                  <div className="text-[10px] font-normal tabular-nums text-neutral-600">
                    {t('admin.winrate.yourTime', { start: w.start, end: w.end })}
                  </div>
                </th>
              )
            })}
            <th className="pb-2 pr-3 text-right font-medium">
              <div className="text-neutral-300">{t('admin.winrate.session.outside')}</div>
              <div className="text-[10px] font-normal text-neutral-600">{t('admin.winrate.outsideNote')}</div>
            </th>
          </tr>
        </thead>
        <tbody>
          <Row row={data.overall} sessionKeys={sessionKeys} isSummary onSelectStrategy={onSelectStrategy} />
          {data.strategies.map((row) => (
            <Row key={row.strategy} row={row} sessionKeys={sessionKeys} onSelectStrategy={onSelectStrategy} />
          ))}
        </tbody>
      </table>
    </div>
  )
}
