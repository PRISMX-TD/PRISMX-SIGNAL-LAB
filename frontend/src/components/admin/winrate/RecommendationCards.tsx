// 推荐区「现在该盯什么」：当前活跃时段（可多个）内，策略×时段按 Wilson 下限
// 降序出卡——样本少的高胜率区间宽、下限被压低，自动沉到后面；界面上仍显示
// 真实胜率+笔数，下限只管排序不管显示。判定停摆时（有信号但一条没判出）整
// 区只显示警示文案不出卡：判定链路断了还照常推荐，等于拿旧数据说假话。
// The "what to watch now" cards: within the currently active session(s), rank
// strategy x session by the Wilson lower bound — a thin high-rate sample has a
// wide interval and a depressed floor, so it sinks on its own; the card still
// shows the real win rate + count, the floor only drives order. When
// resolution is stalled (signals exist, none resolved) the whole area shows a
// warning instead of cards: recommending on a broken resolver is lying with
// stale data.
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import type { AdminStrategyWinRate, StrategyWinRate } from '../../../api/types'
import WinRateBar from './WinRateBar'
import { MIN_SAMPLES, SESSION_COLORS, fmtDurationHm, fmtDurationText, sessionStatus } from './shared'

// 金/银/铜三档徽章色；#4 起退回中性色——前三名才值得用颜色抢注意力。
// Gold/silver/bronze for the top three; #4+ falls back to neutral — only the
// podium earns a colour pull on attention.
const RANK_BADGES = ['bg-amber-400/20 text-amber-200', 'bg-neutral-300/20 text-neutral-200', 'bg-orange-700/25 text-orange-300']

// 每日信号数迷你柱图：一根柱子一天（推荐区恒 7 根，详情区跟随天数切换器可到
// 14/30 根），当天（最后一根）用强调色，其余用弱化白。
// 呼应 dataviz 对 stat-tile trend sparkline 的规范——"弱化色画历史，强调色画
// 当前一格"，让人不用看数字就知道"这几天热不热、今天算不算爆量"。
// 只约束宽度、不给固定高度：SVG 用 preserveAspectRatio="none" 按容器拉伸，
// 固定高度会和它打架变形。相邻柱之间留 2 个 viewBox 单位的底色间隙（同
// WinRateBar 的 GAP 换算），不是描边分隔——反模式清单明确禁止靠描边分段。
// 品种层 dailySamples 恒为 null，调用方在渲染前已经判过，这里只处理非空输入。
// A tiny per-day signal-count bar chart: one bar per day (always 7 in the
// recommendation area; 14 or 30 in the detail area, which follows the range
// picker), the last (today) in the
// accent hue, the rest de-emphasized — the stat-tile trend sparkline pattern
// from dataviz, so a glance says "busy lately / spiking today" without
// reading numbers. Width-only, no fixed height: preserveAspectRatio="none"
// stretches to the container, and a fixed height would fight that and
// distort. A 2-viewBox-unit background gap separates adjacent bars (same math
// as WinRateBar's GAP) — never a stroke; the anti-patterns list rules that
// out. Symbol-level dailySamples is always null; callers already gate on that
// before rendering, so this only handles a non-empty array.
//
// 悬浮读数要有键盘等价路径（code review Important 1）：原生 <title> 只在鼠标
// hover 时出现，键盘用户 Tab 不到也读不到。等价路径挂在 **svg 一层**，不是每根
// 柱子一个：dataviz 的 interaction.md 只要求"键盘焦点与 hover 等价"，没要求逐
// 元素可聚焦，而 WCAG 明确不建议把不可激活的内容放进 Tab 序——柱子点了没反应，
// 它不是控件。逐柱 tabIndex 的写法让三张推荐卡一共塞进 27 个 Tab 停靠点（3 × (1
// 卡 + 7 柱 + 1 链接)）挡在下方策略选择器前面；改成 svg 自己 tabIndex={0} +
// role="img" + 一句读出整条序列的 aria-label（"近 7 天信号数：1,2,3…"），信息量
// 一样，1 个停靠点替掉 7 个。role 也随之从 "group" 回到 "img"：现在子节点没有
// 自己的标签要暴露，这张图就是一张图。柱子保留 <title> 供鼠标逐根读数。
// 顺带删掉了原来为逐柱焦点打的 onKeyDown Space 补丁。注意它删掉的**不是**那个
// 场景：svg 自己带 tabIndex={0}，焦点仍然能停在柱图上，而 Card 的 keydown 守卫
// （if (e.target !== e.currentTarget) return）对冒泡上来的事件照样放行，所以按
// Space 依然会触发浏览器默认的翻页滚动——只是从每卡 7 个可触发元素收敛成了 1 个。
// 这是浏览器对"聚焦了一个不可激活元素"的原生语义，刻意不再拦截：柱图不是控件，
// 用户按 Space 想要的本来就是滚屏，吞掉它反而是在制造一个静默失灵的按键。
// The hover readout needs a keyboard-equivalent path (code review Important 1):
// a native <title> only fires on mouse hover, unreachable and unreadable by
// keyboard. That path belongs on the **svg**, not on every bar: dataviz's
// interaction.md asks for "keyboard focus equivalent to hover", not for
// per-element focusability, and WCAG advises against putting non-activatable
// content in the tab order — a bar does nothing when activated; it isn't a
// control. Per-bar tabIndex put 27 tab stops (3 x (1 card + 7 bars + 1 link))
// in front of the strategy selector below. Now the svg itself takes
// tabIndex={0} + role="img" + one aria-label that reads the whole series
// ("Signals, last 7 days: 1,2,3…"): same information, 1 stop instead of 7. The
// role goes back from "group" to "img" too — no child has its own label to
// expose any more, so this really is one picture. Bars keep their <title> for
// per-bar mouse readout.
// This also removes the onKeyDown Space patch that per-bar focus needed. Note
// what it does NOT remove: the svg carries tabIndex={0}, so focus can still rest
// on the chart, and Card's keydown guard (if (e.target !== e.currentTarget)
// return) lets a bubbled event through — so Space still triggers the browser's
// default page scroll, just from 1 element per card instead of 7. That is the
// browser's native semantics for "a non-activatable element has focus", and it
// is deliberately left alone: the chart isn't a control, scrolling is exactly
// what a user pressing Space wants there, and swallowing it would manufacture a
// silently dead key instead.
export function DailyBars({ daily }: { daily: number[] }) {
  const { t } = useTranslation()
  const max = Math.max(...daily, 1)
  const w = 100 / daily.length
  // 天数取自数组长度而不是写死 7：这个组件在「全部」页签里吃的是跟随天数切换器
  // 的那份 payload，days=30 时 dailySamples 就有 30 个格子。
  // The day count comes from the array, not a hardcoded 7: in the "all" tab this
  // component renders the payload that follows the range picker, so at days=30
  // dailySamples carries 30 buckets.
  const seriesLabel = t('admin.winrate.dailyBarsLabel', {
    days: daily.length, counts: daily.join(', '),
  })
  return (
    <svg viewBox="0 0 100 16" className="h-4 w-24 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80"
         preserveAspectRatio="none" tabIndex={0} role="img" aria-label={seriesLabel}>
      {daily.map((v, i) => (
        <rect key={i} x={i * w + 1} y={16 - (v / max) * 14 - 1} width={w - 2}
              height={(v / max) * 14 + 1} rx={1}
              fill={i === daily.length - 1 ? 'var(--purple-hi, #c084fc)' : 'rgba(255,255,255,0.25)'}>
          {/* 原生 title 悬浮提示，与 SessionTimeline 的时段色带同一手法——这个项目
              没有自建 tooltip 组件，轻量原生方案就是既有约定。键盘等价路径是 svg
              一层的 aria-label，见函数顶部注释。
              Native title hover, same technique as SessionTimeline's session
              bands — this codebase has no custom tooltip component, so the
              light-weight native one is the established convention. The
              keyboard-equivalent path is the svg-level aria-label; see the
              function-level comment for why. */}
          <title>{t('admin.winrate.dailyBarHint', { count: v })}</title>
        </rect>
      ))}
    </svg>
  )
}

function Card({ row, sessionKey, rank, onSelect }: {
  row: StrategyWinRate; sessionKey: string; rank: number; onSelect: (name: string) => void
}) {
  const { t } = useTranslation()
  const bucket = row.sessions[sessionKey]
  // 卡片下方最多带 3 个该策略在这个时段表现最好的品种——同样按 Wilson 下限排,
  // 同样先滤掉样本不够的组合，不然又是"三笔 100%"冒充结论。
  // Up to 3 top symbols for this strategy in this session, ranked by the same
  // Wilson floor and gated by the same sample floor — otherwise a 3-trade
  // 100% would pass itself off as a conclusion again.
  const topSymbols = row.symbols
    .filter((s) => s.sessions[sessionKey] && s.sessions[sessionKey].resolved >= MIN_SAMPLES)
    .sort((a, b) => (b.sessions[sessionKey].wilsonLow ?? 0) - (a.sessions[sessionKey].wilsonLow ?? 0))
    .slice(0, 3)
  // 整卡可点选策略，但卡片里还嵌了一个真的 <Link>（追踪中笔数跳转 /app），以及
  // DailyBars 那个可聚焦的 svg（code review Important 2）。HTML5 的 <button>
  // content model 不允许交互后代——<a> 嵌 <button> 是"非法但多数浏览器会渲染"，
  // Tab 顺序和读屏语义因浏览器而异；外壳换成 div[role=button] + tabIndex + 手动
  // 处理 Enter/Space，语义仍是按钮，但不再限制后代不能交互。
  // The whole card selects a strategy on click, but it also nests a real <Link>
  // (jump to /app for pending trades) plus DailyBars' focusable svg (code review
  // Important 2). A <button>'s content model forbids interactive descendants —
  // <a> inside <button> is invalid HTML that most browsers render anyway, with
  // tab order and AT semantics varying by browser. The wrapper becomes a
  // div[role=button] + tabIndex + manual Enter/Space handling instead: same
  // button semantics, but descendants may be interactive.
  return (
    <div role="button" tabIndex={0} onClick={() => onSelect(row.strategy)}
         onKeyDown={(e) => {
           // 只处理"这个 div 自己"收到的按键，不处理从内部可聚焦子元素（Link、
           // DailyBars 的 svg）冒泡上来的按键（code review 复审：新回归）。少了
           // 这道守卫时，键盘用户 Tab 到「追踪中 →」按 Enter，浏览器对聚焦 <a>
           // 的默认行为（模拟点击、触发导航）会被这里的 e.preventDefault() 吞掉
           // ——因为 preventDefault 作用于整个事件，不区分是谁调用的——变成
           // 导航不发生、反而选中了整张卡；焦点停在柱图上按 Enter/Space 同理会
           // 误选卡片。
           // e.target !== e.currentTarget 就是在说"这个按键不是发生在 div 本身
           // 上，是从后代冒泡上来的"，直接放行，不拦截也不代为处理。
           // Only handle a key that landed on this div itself, not one bubbling
           // up from an inner focusable descendant (the Link, or DailyBars' svg)
           // (code review re-review: a regression introduced by the previous
           // fix). Without this guard, a keyboard user tabbing to "tracking N →"
           // and pressing Enter gets the browser's default Enter-on-a-focused-<a>
           // behaviour (simulate a click, navigate) swallowed by this handler's
           // e.preventDefault() — preventDefault applies to the whole event, it
           // doesn't know which listener called it — so navigation never happens
           // and the card gets selected instead; Enter/Space with focus on the
           // bar chart misselects the card the same way.
           // e.target !== e.currentTarget means "this keypress didn't happen on
           // the div itself, it bubbled from a descendant" — let it through
           // untouched.
           if (e.target !== e.currentTarget) return
           if (e.key === 'Enter' || e.key === ' ') {
             e.preventDefault()
             onSelect(row.strategy)
           }
         }}
         className="glass w-full cursor-pointer p-4 text-left transition hover:bg-white/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white/80">
      <div className="mb-2 flex items-center gap-2">
        <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${RANK_BADGES[rank] ?? 'bg-white/10 text-neutral-400'}`}>
          #{rank + 1}
        </span>
        <span className="font-display text-sm font-semibold text-neutral-100">
          {row.strategy || t('admin.winrate.unnamed')}
        </span>
      </div>
      <WinRateBar bucket={bucket} />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-neutral-400">
        {bucket.dailySamples && <DailyBars daily={bucket.dailySamples} />}
        <span className="tabular-nums">{t('admin.winrate.weekly', { count: bucket.weeklySignals })}</span>
        {bucket.avgResolveSeconds !== null && (
          <span className="tabular-nums">
            {t('admin.winrate.avgResolve', { time: fmtDurationText(t, bucket.avgResolveSeconds) })}
          </span>
        )}
        {bucket.pending > 0 && (
          <Link to="/app" onClick={(e) => e.stopPropagation()} className="text-prism-300 hover:text-prism-200 tabular-nums">
            {t('admin.winrate.tracking', { count: bucket.pending })} →
          </Link>
        )}
      </div>
      {topSymbols.length > 0 && (
        <div className="mt-2 grid grid-cols-3 gap-2">
          {topSymbols.map((s) => (
            <span key={s.symbol} className="text-[10px] text-neutral-400">
              <span className="text-neutral-300">{s.symbol}</span>
              <WinRateBar bucket={s.sessions[sessionKey]} mini />
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export default function RecommendationCards({ data, now, onSelectStrategy }: {
  data: AdminStrategyWinRate; now: Date; onSelectStrategy: (name: string) => void
}) {
  const { t } = useTranslation()
  // 业务规则 1：判定停摆时不出卡。窗口内有信号但一条都没判出胜负，几乎一定是
  // /webhook/trend 链路断了（六周判不出结果的真实故障就是这样）而不是"行情还
  // 没走到"——继续按旧数据出推荐等于在故障期间撒谎，所以整区收起卡片只留警示。
  // Business rule 1: no cards while resolution is stalled. Signals exist in
  // the window but none resolved is almost always a broken /webhook/trend
  // pipeline (the real six-week incident looked exactly like this), not
  // "price hasn't got there yet" — recommending off stale data during an
  // outage is lying, so the whole area collapses to a warning.
  const stalled = data.overall.total.samples > 0 && data.overall.total.resolved === 0
  const statuses = data.sessions.map((s) => ({ s, st: sessionStatus(s, now) }))
  const active = statuses.filter((x) => x.st.state === 'active')
  // 都不活跃 → 预览最先开盘的时段 / none active: preview the next to open
  const preview = active.length === 0
    ? statuses.reduce((a, b) =>
        (a.st.state === 'upcoming' ? a.st.minutesToStart : 1e9) <=
        (b.st.state === 'upcoming' ? b.st.minutesToStart : 1e9) ? a : b)
    : null
  const shown = active.length > 0 ? active : [preview!]

  if (stalled) {
    return (
      <div className="glass border border-amber-400/40 bg-amber-400/10 p-4 text-[12px] leading-5 text-amber-200">
        {t('admin.winrate.recoStalled')}
      </div>
    )
  }
  return (
    <div className="space-y-4">
      {shown.map(({ s, st }) => {
        // 业务规则 2：排序用 Wilson 下限降序，不是原始胜率。样本少的高胜率区间
        // 宽、下限被压得低，自动沉到列表后面；卡片里仍然显示真实胜率与笔数
        // （WinRateBar 已经画了），下限只当排序键，不覆盖显示。
        // Business rule 2: sort by the Wilson lower bound descending, not the
        // raw win rate. A thin high-rate sample has a wide interval and a
        // depressed floor, so it sinks on its own; the card still shows the
        // real rate and count (WinRateBar already draws them) — the floor
        // only drives order, never the display.
        const ranked = data.strategies
          .map((row) => ({ row, b: row.sessions[s.key] }))
          .filter((x) => x.b && x.b.resolved >= MIN_SAMPLES)
          .sort((a, b) => (b.b.wilsonLow ?? 0) - (a.b.wilsonLow ?? 0))
        // 业务规则 3：已判定不足 MIN_SAMPLES 的组合不入榜，折叠进底部「样本积累
        // 中」——展开只给名字和笔数，不给百分比，避免几笔结果冒充结论。
        // Business rule 3: combos below MIN_SAMPLES resolved don't make the
        // list — they fold into a bottom "accumulating" disclosure that shows
        // only the name and count, never a percentage, so a handful of trades
        // never passes itself off as a conclusion.
        const thin = data.strategies.filter((row) => {
          const b = row.sessions[s.key]
          return b && b.samples > 0 && b.resolved < MIN_SAMPLES
        })
        return (
          <div key={s.key}>
            <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-neutral-200">
              <i className="h-2 w-2 rounded-full" style={{ backgroundColor: SESSION_COLORS[s.key] }} />
              {st.state === 'active'
                ? t('admin.winrate.recoActive', { session: t(`admin.winrate.session.${s.key}`) })
                : t('admin.winrate.recoNext', {
                    // 「2h14m 后」而不是「02:14 后」：这是时长不是钟点，见
                    // shared.ts 里 fmtDurationHm 与 fmtClock 各自的注释。
                    // "in 2h14m", not "in 02:14": this is a duration, not a clock
                    // reading — see fmtDurationHm / fmtClock in shared.ts.
                    time: fmtDurationHm(st.state === 'upcoming' ? st.minutesToStart : 0),
                    session: t(`admin.winrate.session.${s.key}`),
                  })}
            </h4>
            {ranked.length === 0 ? (
              <p className="text-[12px] leading-5 text-neutral-500">
                {/* 冷启动文案的 resolved 必须是**这个时段内**的已判定数，不是
                    data.overall.total.resolved（全平台所有时段合计）。这句话渲染在
                    「亚洲盘 · 该盯什么」标题正下方，回答的问题是"亚洲盘还差多少笔
                    才会出卡"；填全平台数字就是答非所问，而且必然偏大——按设计文档
                    的数据现实，头两三周推荐区大概率是空的，这句话是管理员上线后
                    看得最多的一句。
                    data.overall.sessions[key] 是后端已经算好的"该时段全策略合计"桶，
                    与"逐策略 sessions[key].resolved 求和"逐条等价（同一批信号的两种
                    分组），直接用现成的。
                    The cold-start line's `resolved` must be this session's resolved
                    count, not data.overall.total.resolved (every session on the
                    platform combined). It renders directly under "Asian session ·
                    what to watch" and answers "how far is the Asian session from
                    producing a card" — a platform-wide figure answers a different
                    question, and always overstates. Per the design doc's data
                    reality the recommendation area is likely empty for the first
                    two or three weeks, which makes this the single line an admin
                    reads most after launch.
                    data.overall.sessions[key] is the backend's precomputed
                    all-strategies bucket for that session — identical to summing
                    sessions[key].resolved across strategies (same signals, two
                    groupings) — so use the one that already exists. */}
                {t('admin.winrate.recoEmpty', {
                  resolved: data.overall.sessions[s.key]?.resolved ?? 0,
                  min: MIN_SAMPLES,
                })}
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {ranked.map((x, i) => (
                  <Card key={x.row.strategy} row={x.row} sessionKey={s.key} rank={i} onSelect={onSelectStrategy} />
                ))}
              </div>
            )}
            {thin.length > 0 && (
              <details className="mt-2 text-[11px] text-neutral-500">
                <summary className="cursor-pointer">{t('admin.winrate.accumulating', { count: thin.length })}</summary>
                <p className="mt-1">
                  {thin.map((row) => `${row.strategy || t('admin.winrate.unnamed')} (${row.sessions[s.key].resolved})`).join(' · ')}
                </p>
              </details>
            )}
          </div>
        )
      })}
    </div>
  )
}
