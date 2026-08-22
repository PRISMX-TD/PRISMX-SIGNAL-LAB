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
import type { TFunction } from 'i18next'
import { Link } from 'react-router-dom'
import type { AdminStrategyWinRate, StrategyWinRate } from '../../../api/types'
import WinRateBar from './WinRateBar'
import { MIN_SAMPLES, SESSION_COLORS, fmtClock, fmtDuration, sessionStatus } from './shared'

// 金/银/铜三档徽章色；#4 起退回中性色——前三名才值得用颜色抢注意力。
// Gold/silver/bronze for the top three; #4+ falls back to neutral — only the
// podium earns a colour pull on attention.
const RANK_BADGES = ['bg-amber-400/20 text-amber-200', 'bg-neutral-300/20 text-neutral-200', 'bg-orange-700/25 text-orange-300']

// 秒数 → 拼好单位的人话文本。fmtDuration 刻意只吐 {value, unit}，单位词交给
// 调用方过 i18n（否则中文界面会混进英文分钟）；这里统一拼成"12 分钟"/"12 min"，
// 数字与单位之间留空格，和本文件其余"{{days}} 天"式写法保持一致。
// Seconds → a humanized string. fmtDuration deliberately returns only
// {value, unit} so the unit word goes through i18n (a bare English word would
// leak into the Chinese UI); this glues them as "12 分钟" / "12 min", with a
// space between number and unit to match this codebase's "{{days}} 天" style.
function fmtDurationText(t: TFunction, seconds: number): string {
  const { value, unit } = fmtDuration(seconds)
  return `${value} ${t(`admin.winrate.unit.${unit}`)}`
}

// 每日信号数迷你柱图：7 根柱子，当天（最后一根）用强调色，其余用弱化白。
// 呼应 dataviz 对 stat-tile trend sparkline 的规范——"弱化色画历史，强调色画
// 当前一格"，让人不用看数字就知道"这几天热不热、今天算不算爆量"。
// 只约束宽度、不给固定高度：SVG 用 preserveAspectRatio="none" 按容器拉伸，
// 固定高度会和它打架变形。相邻柱之间留 2 个 viewBox 单位的底色间隙（同
// WinRateBar 的 GAP 换算），不是描边分隔——反模式清单明确禁止靠描边分段。
// 品种层 dailySamples 恒为 null，调用方在渲染前已经判过，这里只处理非空输入。
// A tiny per-day signal-count bar chart: 7 bars, the last (today) in the
// accent hue, the rest de-emphasized — the stat-tile trend sparkline pattern
// from dataviz, so a glance says "busy lately / spiking today" without
// reading numbers. Width-only, no fixed height: preserveAspectRatio="none"
// stretches to the container, and a fixed height would fight that and
// distort. A 2-viewBox-unit background gap separates adjacent bars (same math
// as WinRateBar's GAP) — never a stroke; the anti-patterns list rules that
// out. Symbol-level dailySamples is always null; callers already gate on that
// before rendering, so this only handles a non-empty array.
export function DailyBars({ daily }: { daily: number[] }) {
  const { t } = useTranslation()
  const max = Math.max(...daily, 1)
  const w = 100 / daily.length
  return (
    <svg viewBox="0 0 100 16" className="h-4 w-24" preserveAspectRatio="none" role="img"
         aria-label={t('admin.winrate.dailyBarsLabel')}>
      {daily.map((v, i) => {
        return (
          <rect key={i} x={i * w + 1} y={16 - (v / max) * 14 - 1} width={w - 2}
                height={(v / max) * 14 + 1} rx={1}
                fill={i === daily.length - 1 ? 'var(--purple-hi, #c084fc)' : 'rgba(255,255,255,0.25)'}>
            {/* 原生 title 悬浮提示，与 SessionTimeline 的时段色带同一手法——这个项目
                没有自建 tooltip 组件，轻量原生方案就是既有约定。
                Native title hover, same technique as SessionTimeline's session
                bands — this codebase has no custom tooltip component, so the
                light-weight native one is the established convention. */}
            <title>{t('admin.winrate.dailyBarHint', { count: v })}</title>
          </rect>
        )
      })}
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
  return (
    <button type="button" onClick={() => onSelect(row.strategy)}
            className="glass w-full p-4 text-left transition hover:bg-white/[0.06]">
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
    </button>
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
                    session: t(`admin.winrate.session.${s.key}`),
                    time: fmtClock(st.state === 'upcoming' ? st.minutesToStart : 0),
                  })}
            </h4>
            {ranked.length === 0 ? (
              <p className="text-[12px] leading-5 text-neutral-500">
                {t('admin.winrate.recoEmpty', { resolved: data.overall.total.resolved, min: MIN_SAMPLES })}
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
