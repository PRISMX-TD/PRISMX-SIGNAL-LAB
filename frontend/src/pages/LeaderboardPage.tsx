// 排行榜页：两榜（收益率/胜率）× 周/月 seg-tabs + 领奖台（2|1|3）+ 幅度条榜单
// + 「我的名次」卡（已上榜/未上榜有进度/未上榜无基线三态）+ 空榜态。按批准的
// 铸币视觉方案（leaderboard-design.html）逐段移植：领奖台/榜单行复用勋章墙
// 同一套 V5 铸币渲染器（BadgeIcon）与新增的名次徽标（RankCoin），榜单本身的
// 数据流（board/period 状态、403 门控退化、loading 骨架、gates 门槛回显、
// isSelf/"你" 标签）与旧版一字不改。
// 入口本身按 leaderboardVisible 门控（见 Layout/UserMenu），这里只处理直接
// 打 URL 绕过入口的情况——理论上只有内测期的普通用户会撞上 403，兜底成一句
// 提示而不是把接口错误糊在脸上（照成就页 AchievementsPage 的模式）。
//
// Leaderboard page: two boards (return rate / win rate) x week/month seg-tabs,
// a podium (2|1|3) + a magnitude-bar list, a "my rank" card (three states:
// ranked / unranked-with-progress / unranked-without-baseline), and an empty
// state. Ported section by section from the approved minted-coin design board
// (leaderboard-design.html): the podium/list rows reuse the same V5 medal
// renderer as the badge wall (BadgeIcon) plus a new rank-coin (RankCoin). The
// data flow itself (board/period state, the 403-gate degradation, the loading
// skeleton, the gates echoed from the backend, the isSelf/"you" tag) is
// unchanged from the previous version.
// The entry point itself is gated on leaderboardVisible (see Layout/UserMenu);
// this only handles someone hitting the URL directly — in practice only a
// regular user during the beta window, degraded to one line of copy instead
// of a raw API error (same pattern as AchievementsPage).
import type { CSSProperties } from 'react'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { gamificationApi } from '../api/client'
import { SkeletonBlock, SkeletonLine } from '../components/Skeleton'
import BadgeIcon from '../components/badges/BadgeIcon'
import RankCoin from '../components/badges/RankCoin'
import { BADGE_RARITY } from '../components/badges/badgeRarity'
import type { LeaderboardBoard, LeaderboardPayload, LeaderboardRow } from '../api/types'

const BOARDS: LeaderboardBoard[] = ['return_pct', 'win_rate']
type Period = 'week' | 'month'
const PERIODS: Period[] = ['week', 'month']

// 上榜门槛：改由后端 payload 的 gates 字段下发（管理端可调），不再在前端写死
// 5/20/500——榜规文案与 notRanked 提示的 {{n}}/{{usd}} 都从 data.gates 取。
// DEFAULT_GATES 只在首个 payload 到达前当占位，避免 loading 阶段闪出
// "{{n}}" 这种未插值的原始 key；一旦 data 到位就完全让位给真实值，绝不会
// 展示成一个陈旧或错误的数字。
// Entry gates now come from the backend payload's gates field
// (admin-adjustable), no longer hardcoded to 5/20/500 in the frontend — both
// the gate chips and the notRanked hint's {{n}}/{{usd}} read from data.gates.
// DEFAULT_GATES is only a placeholder before the first payload arrives, so
// the loading phase never flashes the raw "{{n}}" token; once data lands it
// fully defers to the real values, never showing a stale or wrong number.
const DEFAULT_GATES = { minTradesReturn: 5, minTradesWinrate: 20, minBaselineUsd: 500,
                        winrateRequireProfit: false }

// 骨架尺寸按真实版式在浏览器里量过（桌面 ≥ 640px 三张领奖台卡、手机领奖台面板、
// 我的名次卡），骨架与内容等高，换入时页面不跳。
// Skeleton sizes measured in-browser against the real layout (desktop podium
// cards, mobile podium panel, my-rank card) so the swap doesn't shift the page.
const SKEL_PODIUM_SIDE = 165
const SKEL_PODIUM_CENTER = 193
const SKEL_PODIUM_MOBILE = 143
const SKEL_MINE = 90

// score 是分数（0.124 = 12.4%），两榜统一按百分比一位小数显示——收益率榜可能
// 为负（亏损），toFixed 对负数一样成立，不需要特判。收益率榜额外带正负号
// （设计稿的 pct() 输出 "+3.9%"/"−4.8%"），胜率榜不带号（永远非负）。
// score is a fraction (0.124 = 12.4%); both boards render it as a percentage
// with one decimal. The return board can be negative (a loss); toFixed
// handles that the same way. The return board additionally carries an
// explicit sign (the design board's pct() prints "+3.9%"), the win-rate
// board doesn't (always non-negative).
const fmtScorePct = (v: number): string => `${(v * 100).toFixed(1)}%`
const fmtScoreSigned = (v: number): string => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`

// 最低本金门槛的展示格式：整数美元不带小数（500 而不是 500.00），非整数才保留
// 两位——管理端目前只允许输入正数，没有强制整数，所以两种都要处理。
// Display formatting for USD figures: a whole-dollar amount renders without
// decimals (500, not 500.00); anything else keeps two. The admin form only
// requires a positive number, not an integer, so both shapes are possible.
const fmtUsd = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2))

// 周期边界/封存时间一律按 UTC 自然周/月定义（见后端 periods.py）——页头日期
// 必须跟着用 UTC 而不是浏览器本地时区，否则不同时区的用户会看到与后端判定
// 不一致的周期范围（比如周一 00:00 UTC 对西半球用户可能还是周日）。
// snapshotAt（"上次刷新"）例外：那是给用户一个直觉性的"最近一次"感知，不是
// 判定边界，用本地时间更自然。
// Period bounds / seal time are always defined in UTC (see backend
// periods.py) — the header dates must follow UTC, not the browser's local
// zone, or a user elsewhere would see a period range inconsistent with what
// the backend actually computed. snapshotAt ("last refreshed") is the
// exception: it's an intuitive "how recent" cue, not a boundary, so local
// time reads more naturally there.
const fmtUtcShortDate = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}
const fmtUtcClock = (iso: string): string => {
  const d = new Date(iso)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hh}:${mm} UTC`
}
const fmtLocalClock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

function parsePeriodKey(key: string, period: Period): { year: string; week: string; month: string } {
  if (period === 'week') {
    const [y, w] = key.split('-W')
    return { year: y, week: String(Number(w)), month: '' }
  }
  const [y, m] = key.split('-')
  return { year: y, week: '', month: String(Number(m)) }
}

function scoreColorClass(board: LeaderboardBoard, v: number): string {
  if (board !== 'return_pct') return 'text-neutral-100'
  return v >= 0 ? 'text-up' : 'text-down'
}
function scoreBarColor(board: LeaderboardBoard, v: number): string {
  if (board !== 'return_pct') return 'var(--purple-hi)'
  return v >= 0 ? 'var(--up)' : 'var(--down)'
}
function fmtScore(board: LeaderboardBoard, v: number): string {
  return board === 'return_pct' ? fmtScoreSigned(v) : fmtScorePct(v)
}

// 领奖台的径向底色——按材质（金/银/铜）打一层极淡的色调，数值原样照抄设计稿
// （leaderboard-design.html 的 .pod.r1/.r2/.r3 --tint），与 RankCoin 用的
// MAT 家族语义呼应但独立取值，不从 medal.ts 借（那套是勋章场，不是榜位场）。
const PODIUM_TINT: Record<number, string> = {
  1: 'radial-gradient(circle at 20% 0%, rgba(228,190,106,.22), transparent 55%)',
  2: 'radial-gradient(circle at 20% 0%, rgba(188,193,204,.16), transparent 55%)',
  3: 'radial-gradient(circle at 20% 0%, rgba(184,118,63,.18), transparent 55%)',
}

// 生长动画：首帧宽度 0，挂载后的下一帧过渡到目标宽度——双 rAF 确保浏览器先
// 画出 0% 那一帧，否则初次 setState 和挂载合并成一帧，过渡不会播放。
// prefers-reduced-motion 用户由 motion-reduce:transition-none 直接跳过整个
// 过渡（首帧即目标宽度，不会经历"从 0 长出来"的观感）。
// Grow-in: renders at 0 width, transitions to the target on the next frame —
// double rAF makes sure the browser paints the 0% frame first, or the
// initial setState collapses into the mount frame and the transition never
// plays. prefers-reduced-motion users skip the transition via
// motion-reduce:transition-none (first frame is already the target width).
function useGrowWidth(targetPct: number): number {
  const [w, setW] = useState(0)
  useEffect(() => {
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setW(targetPct))
    })
    return () => {
      cancelAnimationFrame(raf1)
      cancelAnimationFrame(raf2)
    }
  }, [targetPct])
  return w
}

function GrowBar({ pct, className, style }: { pct: number; className?: string; style?: CSSProperties }) {
  const w = useGrowWidth(Math.max(0, Math.min(100, pct)))
  return (
    <div
      className={`transition-[width] duration-700 ease-out motion-reduce:transition-none ${className ?? ''}`}
      style={{ ...style, width: `${w}%` }}
    />
  )
}

function PodiumCard({ row, board, maxAbs }: { row: LeaderboardRow; board: LeaderboardBoard; maxAbs: number }) {
  const { t } = useTranslation()
  const isReturn = board === 'return_pct'
  const big = row.rank === 1
  const barPct = isReturn ? (Math.abs(row.score) / maxAbs) * 100 : row.score * 100
  const barColor = scoreBarColor(board, row.score)

  return (
    <article
      className={`lb-podium-card glass relative overflow-hidden rounded-[20px] px-[22px] pb-[18px] ${big ? 'pt-[30px]' : 'pt-[22px]'} ${row.rank === 1 ? 'order-first md:order-none' : ''}`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{ backgroundImage: PODIUM_TINT[row.rank] }}
      />
      <div className="relative flex items-center gap-3">
        <RankCoin rank={row.rank} size={44} className="sm:hidden" />
        <RankCoin rank={row.rank} size={big ? 64 : 52} className="hidden sm:block" />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-neutral-100 sm:flex-initial">
              {row.displayName}
            </span>
            {row.equippedBadge && (
              <BadgeIcon id={row.equippedBadge} rarity={BADGE_RARITY[row.equippedBadge] ?? 'common'} earned size={20} />
            )}
            {row.isSelf && (
              <span className="tag shrink-0 bg-prism-600/25 text-[11px] text-prism-300">{t('leaderboard.youTag')}</span>
            )}
            {/* 手机端把账户号并进同一行，省一行竖直空间；桌面端仍走下面单独一行。
                Mobile folds the account number into this same line to save a row
                of vertical space; desktop keeps it on its own line below. */}
            <span className="num shrink-0 text-xs text-neutral-500 sm:hidden">{row.login}</span>
          </div>
          <div className="num mt-0.5 hidden text-xs text-neutral-500 sm:block">{row.login}</div>
        </div>
      </div>
      <div className="relative mt-[18px] flex items-baseline gap-2.5">
        <b
          className={`num font-display font-extrabold leading-none tracking-tight text-[30px] ${big ? 'sm:text-[42px]' : 'sm:text-[34px]'} ${scoreColorClass(board, row.score)}`}
        >
          {fmtScore(board, row.score)}
        </b>
        <small className="num text-xs text-neutral-500">{t('leaderboard.sampleCount', { n: row.sample })}</small>
      </div>
      <div className="relative mt-3.5 h-[3px] overflow-hidden rounded-full bg-white/[0.06]">
        <GrowBar
          pct={barPct}
          className="h-full rounded-full"
          style={{ background: `linear-gradient(90deg, ${barColor}, color-mix(in srgb, ${barColor} 40%, transparent))` }}
        />
      </div>
    </article>
  )
}

function ListRow({ row, board, maxAbs }: { row: LeaderboardRow; board: LeaderboardBoard; maxAbs: number }) {
  const { t } = useTranslation()
  const isReturn = board === 'return_pct'
  const barColor = scoreBarColor(board, row.score)
  const halfPct = isReturn ? (Math.abs(row.score) / maxAbs) * 50 : 0
  const leftOriginPct = isReturn ? 0 : row.score * 100

  return (
    <div
      className={`lb-row relative grid grid-cols-[40px_minmax(0,1fr)_84px] items-center gap-2 border-t border-white/[0.08] px-3 py-3 md:grid-cols-[56px_minmax(0,1.4fr)_120px_minmax(0,1.2fr)_88px] md:gap-3 md:px-[18px] ${row.isSelf ? 'bg-prism-600/[0.07]' : ''}`}
    >
      {row.isSelf && <span aria-hidden className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r-[3px] bg-prism-400" />}
      <span className={`num text-[15px] ${row.isSelf ? 'font-semibold text-neutral-100' : 'text-neutral-400'}`}>
        {String(row.rank).padStart(2, '0')}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        {row.equippedBadge && (
          <BadgeIcon id={row.equippedBadge} rarity={BADGE_RARITY[row.equippedBadge] ?? 'common'} earned size={20} />
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`truncate ${row.isSelf ? 'font-semibold text-neutral-100' : 'text-neutral-200'}`}>
              {row.displayName}
            </span>
            {row.isSelf && (
              <span className="tag shrink-0 bg-prism-600/25 text-[11px] text-prism-300">{t('leaderboard.youTag')}</span>
            )}
          </div>
          {/* 手机端隐藏了账户号列和幅度条，笔数搬到名字下面这行补上；桌面端
              自己有独立列显示笔数，这行只在手机端出现。
              Mobile hides the account column and the magnitude bar, so the trade
              count moves to this line under the name instead; desktop already
              has its own column for it, so this line only shows on mobile. */}
          <div className="text-[11px] text-neutral-500 md:hidden">{t('leaderboard.sampleCount', { n: row.sample })}</div>
        </div>
      </div>
      <span className="num hidden text-[13px] text-neutral-500 md:block">{row.login}</span>
      <div className="hidden items-center gap-3 md:flex">
        <b className={`num min-w-[64px] text-right text-sm font-semibold ${scoreColorClass(board, row.score)}`}>
          {fmtScore(board, row.score)}
        </b>
        <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/[0.05]">
          {isReturn && <span aria-hidden className="absolute -inset-y-0.5 left-1/2 w-px bg-white/[0.18]" />}
          {isReturn ? (
            <GrowBar
              pct={halfPct}
              className={`absolute inset-y-0 rounded-full opacity-85 ${row.score >= 0 ? 'left-1/2' : 'right-1/2'}`}
              style={{ background: barColor }}
            />
          ) : (
            <GrowBar
              pct={leftOriginPct}
              className="absolute inset-y-0 left-0 rounded-full opacity-85"
              style={{ background: barColor }}
            />
          )}
        </div>
      </div>
      <b className={`num text-right text-sm font-semibold md:hidden ${scoreColorClass(board, row.score)}`}>
        {fmtScore(board, row.score)}
      </b>
      <span className="num hidden text-right text-[13px] text-neutral-500 md:block">{row.sample}</span>
    </div>
  )
}

// ═══════════════════════ 手机端 v2（< 640px）专用组件 ═══════════════════════
// 领奖台三列（2|1|3，中间抬高）、密排榜单行、钉在底栏上方的名次条——都只在
// < 640px 渲染，desktop（≥ 640px）继续走上面已有的 PodiumCard / ListRow /
// MyRankCard，一像素不改。
// ═══════════════════════ mobile v2 (< 640px) only components ═══════════════
// Three-column podium (2|1|3, center raised), a dense list row, and the
// rank bar pinned above the tab bar — all render only below 640px; desktop
// (≥ 640px) keeps using PodiumCard / ListRow / MyRankCard above, unchanged.

// 领奖台底色光斑只打在中间（冠军）列，颜色照抄 PODIUM_TINT[1]（金）——领奖台
// 面板本身没有分材质底色，光斑是唯一提示"这是冠军位"的视觉线索。
// The podium's tint spot only sits behind the center (champion) column,
// reusing PODIUM_TINT[1]'s gold — the panel itself has no per-rank field
// color, so the spot is the only cue marking "this is the champion slot".
function PodiumColumnMobile({ row, board, center }: { row: LeaderboardRow; board: LeaderboardBoard; center: boolean }) {
  const { t } = useTranslation()
  return (
    <div className={`relative flex min-w-0 flex-col items-center gap-1 text-center ${center ? '-translate-y-2' : 'pt-4'}`}>
      {center && (
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-x-3 -top-4 -z-10 h-24 opacity-80"
          style={{ backgroundImage: 'radial-gradient(circle at 50% 25%, rgba(228,190,106,.28), transparent 65%)' }}
        />
      )}
      <RankCoin rank={row.rank} size={center ? 48 : 38} />
      <div className="flex w-full min-w-0 items-center justify-center gap-1">
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold text-neutral-100">{row.displayName}</span>
        {row.equippedBadge && (
          <BadgeIcon id={row.equippedBadge} rarity={BADGE_RARITY[row.equippedBadge] ?? 'common'} earned size={14} className="shrink-0" />
        )}
      </div>
      <b
        className={`num font-display font-extrabold leading-none tracking-tight ${center ? 'text-[22px]' : 'text-[17px]'} ${scoreColorClass(board, row.score)}`}
      >
        {fmtScore(board, row.score)}
      </b>
      <small className="num text-[10.5px] text-neutral-500">{t('leaderboard.sampleCount', { n: row.sample })}</small>
    </div>
  )
}

// 密排榜单行：无卡片外壳，靠 divide-y 分隔；账户号/幅度条整体不出现在手机端
// （宽度不够摆下，笔数已经搬到名字下面那行）。
// Dense list row: no card shell, separated by divide-y; the account column
// and the magnitude bar don't appear on mobile at all (no room, and the
// trade count already moved under the name).
function ListRowMobile({ row, board }: { row: LeaderboardRow; board: LeaderboardBoard }) {
  const { t } = useTranslation()
  return (
    <div
      className={`relative grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 py-2.5 ${row.isSelf ? 'bg-prism-600/[0.07]' : ''}`}
    >
      {row.isSelf && <span aria-hidden className="absolute bottom-1 left-0 top-1 w-[3px] rounded-r-[3px] bg-prism-400" />}
      <span className={`num text-[13px] ${row.isSelf ? 'font-semibold text-neutral-100' : 'text-neutral-400'}`}>
        {String(row.rank).padStart(2, '0')}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        {row.equippedBadge && (
          <BadgeIcon id={row.equippedBadge} rarity={BADGE_RARITY[row.equippedBadge] ?? 'common'} earned size={16} className="shrink-0" />
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={`truncate text-[13px] ${row.isSelf ? 'font-semibold text-neutral-100' : 'text-neutral-200'}`}>
              {row.displayName}
            </span>
            {row.isSelf && (
              <span className="tag shrink-0 bg-prism-600/25 text-[11px] text-prism-300">{t('leaderboard.youTag')}</span>
            )}
          </div>
          <div className="text-[11px] text-neutral-500">{t('leaderboard.sampleCount', { n: row.sample })}</div>
        </div>
      </div>
      <b className={`num text-right text-[13px] font-semibold ${scoreColorClass(board, row.score)}`}>{fmtScore(board, row.score)}</b>
    </div>
  )
}

// 名次栏钉在底栏上方：背景/模糊照抄 .lg-tabbar-inner 的例外做法——它也是常驻
// 悬浮在滚动内容之上的一层，模糊在这里同样"有功能"（见 index.css 该组件的
// 注释）。bottom 的 100px = 底栏自身离屏幕底边 12px + 底栏自身高度（约
// 78px：8 内边距×2 + 26 图标 + 4 间距 + 约 13 文字）+ 10px 间隙，整体再叠上
// env(safe-area-inset-bottom)。
// The rank bar pinned above the tab bar: background/blur copies the one
// exception at .lg-tabbar-inner — it's also a persistent layer floating over
// scrolling content, so blur is functional there too (see that rule's own
// comment in index.css). The 100px in `bottom` = the tab bar's own 12px gap
// from the screen edge + its own ~78px height (8+8 padding, 26 icon, 4 gap,
// ~13 label) + a 10px clearance, stacked on top of the safe-area inset.
const MY_RANK_BAR_BOTTOM = 'calc(env(safe-area-inset-bottom) + 100px)'

// 用 Portal 挂到 body：页面内容外层 .page-enter 有 transform 动画（见
// SlideOrderModal.tsx/ChartOrderModal.tsx/ConfirmModal.tsx 同一条注释），会
// 成为 fixed 定位的包含块，导致这张钉住的条相对内容区而非视口定位——量出来
// 会紧贴在内容末尾附近而不是贴着底栏。挂到 body 可脱离该祖先，让 fixed 重新
// 相对视口计算。
// Portal to body: the .page-enter wrapper around page content has a
// transform animation (same note as SlideOrderModal.tsx /
// ChartOrderModal.tsx / ConfirmModal.tsx), which becomes the containing
// block for fixed positioning — without this the pinned bar ends up
// anchored near the end of the content box instead of the viewport bottom,
// nowhere near the tab bar. Portaling to body escapes that ancestor so
// fixed positions against the viewport again.
function MyRankBarMobile({ data, board }: { data: LeaderboardPayload; board: LeaderboardBoard }) {
  const { t } = useTranslation()

  if (data.me) {
    const above = data.rows.find((r) => r.rank === data.me!.rank - 1)
    let cta: string | null = null
    if (data.me.rank === 1) {
      cta = t('leaderboard.atTop')
    } else if (above) {
      const gap = above.score - data.me.score
      cta = t('leaderboard.gapToNext', { gap: fmtScore(board, gap), rank: data.me.rank - 1 })
    }
    return createPortal(
      <div
        className="lb-mine-m fixed inset-x-3 z-20 flex h-14 items-center gap-2 rounded-[16px] border border-white/[0.14] bg-ink-950/85 px-3 backdrop-blur-lg sm:hidden"
        style={{ bottom: MY_RANK_BAR_BOTTOM }}
      >
        <RankCoin rank={data.me.rank} size={32} />
        <span className="num shrink-0 text-base font-bold leading-none text-neutral-100">#{data.me.rank}</span>
        <b className={`num shrink-0 text-sm font-semibold ${scoreColorClass(board, data.me.score)}`}>
          {fmtScore(board, data.me.score)}
        </b>
        <span className="shrink-0 text-[11px] text-neutral-500">{t('leaderboard.sampleCount', { n: data.me.sample })}</span>
        {cta && <span className="ml-auto min-w-0 truncate text-right text-xs text-neutral-400">{cta}</span>}
      </div>,
      document.body,
    )
  }

  if (data.progress) {
    const p = data.progress
    const belowBaseline = p.baselineUsd < p.minBaselineUsd
    const pct = Math.max(0, Math.min(100, (p.sample / Math.max(1, p.minTrades)) * 100))
    return createPortal(
      <div
        className="lb-mine-m fixed inset-x-3 z-20 overflow-hidden rounded-[16px] border border-white/[0.14] bg-ink-950/85 backdrop-blur-lg sm:hidden"
        style={{ bottom: MY_RANK_BAR_BOTTOM }}
      >
        <div className="flex h-14 items-center gap-2 px-3">
          <span className="shrink-0 text-sm font-bold text-neutral-500">{t('leaderboard.notRankedShort')}</span>
          <span className="ml-auto min-w-0 truncate text-right text-xs text-neutral-400">
            {t('leaderboard.progressCount', { s: p.sample, n: p.minTrades })}
            {' · '}
            {belowBaseline
              ? t('leaderboard.progressBaselineLow', { usd: fmtUsd(p.baselineUsd), gap: fmtUsd(p.minBaselineUsd - p.baselineUsd) })
              : t('leaderboard.progressBaselineOk', { usd: fmtUsd(p.baselineUsd) })}
          </span>
        </div>
        <div className="h-[3px] w-full bg-white/[0.08]">
          <GrowBar pct={pct} className="h-full" style={{ background: 'linear-gradient(90deg, var(--purple), var(--purple-hi))' }} />
        </div>
      </div>,
      document.body,
    )
  }

  return null
}

// 「我的名次」卡：三态——已上榜（名次徽标 + 成绩 + 追赶提示）/ 未上榜但本期
// 已拍基线（进度条 + 本金门槛回显）/ 未上榜且无基线（沿用旧版 notRanked 提示）。
// "My rank" card: three states — ranked (rank coin + score + a catch-up
// hint) / unranked but with a baseline taken this period (a progress bar +
// the baseline-gate echo) / unranked with no baseline at all (the previous
// version's notRanked hint, unchanged).
function MyRankCard({ data, board, rankThreshold }: { data: LeaderboardPayload; board: LeaderboardBoard; rankThreshold: number }) {
  const { t } = useTranslation()

  if (data.me) {
    const above = data.rows.find((r) => r.rank === data.me!.rank - 1)
    let cta: string | null = null
    if (data.me.rank === 1) {
      cta = t('leaderboard.atTop')
    } else if (above) {
      const gap = above.score - data.me.score
      cta = t('leaderboard.gapToNext', { gap: fmtScore(board, gap), rank: data.me.rank - 1 })
    }
    return (
      // < 640px 这一态改由 MyRankBarMobile 钉在底栏上方渲染，这里只在
      // ≥ 640px 显示——桌面这张卡本身一像素不改。
      // Below 640px this state is rendered by MyRankBarMobile instead,
      // pinned above the tab bar — this card only shows at ≥ 640px and is
      // otherwise untouched.
      <div className="lb-my-rank glass hidden flex-col gap-4 p-[18px_22px] sm:flex sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <RankCoin rank={data.me.rank} size={44} />
          <div>
            <div className="text-[11px] uppercase tracking-wider text-neutral-500">{t('leaderboard.myRank')}</div>
            <div className="num font-display text-[28px] font-extrabold leading-tight tracking-tight text-neutral-100">
              #{data.me.rank}
            </div>
          </div>
        </div>
        {/* 手机端三项统计排成 2 列网格（不是任其自然换行）：3 项换行会变成
            "2 + 孤零零 1 个"，网格至少让第二行占满第一列，观感更稳。桌面端
            照旧横排 flex-wrap。
            Mobile lays the three stats out as a 2-col grid instead of letting
            them wrap freely — free-wrapping 3 items becomes "2 + 1 orphan";
            the grid at least anchors the second row to column 1. Desktop keeps
            the original flex-wrap row. */}
        <div className="grid grid-cols-2 gap-4 sm:flex sm:flex-wrap sm:gap-6">
          <div>
            <span className="block text-[11px] uppercase tracking-wider text-neutral-500">
              {t(`leaderboard.colScore.${board}`)}
            </span>
            <b className={`num text-base font-semibold ${scoreColorClass(board, data.me.score)}`}>
              {fmtScore(board, data.me.score)}
            </b>
          </div>
          <div>
            <span className="block text-[11px] uppercase tracking-wider text-neutral-500">{t('leaderboard.colSample')}</span>
            <b className="num text-base font-semibold text-neutral-100">{t('leaderboard.sampleCount', { n: data.me.sample })}</b>
          </div>
          <div>
            <span className="block text-[11px] uppercase tracking-wider text-neutral-500">{t('leaderboard.colAccount')}</span>
            <b className="num text-base font-semibold text-neutral-100">{data.me.login}</b>
          </div>
        </div>
        {cta && <div className="max-w-[34ch] text-sm text-neutral-400 sm:text-right">{cta}</div>}
      </div>
    )
  }

  if (data.progress) {
    const p = data.progress
    const belowBaseline = p.baselineUsd < p.minBaselineUsd
    return (
      // 同上：< 640px 由 MyRankBarMobile 顶替（带底部进度线），这张卡只在
      // ≥ 640px 显示。Same as above: below 640px MyRankBarMobile takes over
      // (with a bottom progress line); this card only shows at ≥ 640px.
      <div className="lb-my-rank glass hidden gap-3 p-[18px_22px] sm:grid sm:grid-cols-[auto_1fr] sm:gap-[22px]">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-neutral-500">{t('leaderboard.myRank')}</div>
          <div className="font-display text-[28px] font-extrabold leading-tight tracking-tight text-neutral-500">
            {t('leaderboard.notRankedShort')}
          </div>
        </div>
        <div>
          <div className="text-sm text-neutral-300">
            {t('leaderboard.progressCount', { s: p.sample, n: p.minTrades })}
            {' · '}
            {belowBaseline
              ? t('leaderboard.progressBaselineLow', { usd: fmtUsd(p.baselineUsd), gap: fmtUsd(p.minBaselineUsd - p.baselineUsd) })
              : t('leaderboard.progressBaselineOk', { usd: fmtUsd(p.baselineUsd) })}
          </div>
          <div className="mt-2 h-1.5 max-w-[420px] overflow-hidden rounded-full bg-white/[0.06]">
            <GrowBar
              pct={(p.sample / Math.max(1, p.minTrades)) * 100}
              className="h-full rounded-full"
              style={{ background: 'linear-gradient(90deg, var(--purple), var(--purple-hi))' }}
            />
          </div>
          {data.periodStart && (
            <p className="mt-2 text-[11px] text-neutral-600">
              {t('leaderboard.progressNote', { time: fmtUtcClock(data.periodStart) })}
            </p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="lb-my-rank glass flex flex-wrap items-center justify-between gap-3 p-4">
      <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">{t('leaderboard.myRank')}</span>
      <span className="text-sm text-neutral-400">{t('leaderboard.notRanked', { n: rankThreshold })}</span>
    </div>
  )
}

function EmptyState({ data, board, rankThreshold, minBaselineUsd }: {
  data: LeaderboardPayload
  board: LeaderboardBoard
  rankThreshold: number
  minBaselineUsd: number
}) {
  const { t } = useTranslation()
  return (
    <section className="glass grid justify-items-center gap-2.5 px-4 py-7 text-center sm:px-7 sm:py-11">
      <h3 className="text-lg font-bold text-neutral-100">{t('leaderboard.emptyHeading')}</h3>
      <p className="max-w-[52ch] text-sm text-neutral-300">
        {data.periodStart
          ? t('leaderboard.emptyBody', { time: fmtUtcClock(data.periodStart), n: rankThreshold, usd: fmtUsd(minBaselineUsd) })
          : t('leaderboard.empty')}
      </p>
      {(data.snapshotAt || data.previousWinner) && (
        <div className="mt-1 flex flex-wrap justify-center gap-2">
          {data.snapshotAt && (
            <span className="chip border border-white/10 bg-white/[0.04] text-neutral-400">
              {t('leaderboard.lastRefresh', { time: fmtLocalClock(data.snapshotAt) })}
            </span>
          )}
          {data.previousWinner && (
            <span className="chip border border-white/10 bg-white/[0.04] text-neutral-400">
              {t('leaderboard.prevWinner', { name: data.previousWinner.displayName })}
              <b className={`num ml-1 ${scoreColorClass(board, data.previousWinner.score)}`}>
                {fmtScore(board, data.previousWinner.score)}
              </b>
            </span>
          )}
        </div>
      )}
    </section>
  )
}

// 榜单主体：领奖台 / 名次列表 / 我的名次。从页面拆出来是为了让页头、分段控件、
// 榜规在加载期间始终留在原位——切榜时只有这一块在骨架与数据之间切换，不再整页
// 消失又出现（用户反馈"点击时卡顿闪烁一下才出现内容"的根因）。
// Board body: podium / ranked list / my rank. Split out of the page so the
// header, segmented controls and gate chips stay put while loading — only this
// region swaps between skeleton and data on a toggle, instead of the whole page
// vanishing and reappearing (root cause of the reported "flash before content").
function BoardBody({
  data,
  board,
  rankThreshold,
  minBaselineUsd,
}: {
  data: LeaderboardPayload
  board: LeaderboardBoard
  rankThreshold: number
  minBaselineUsd: number
}) {
  const { t } = useTranslation()
  const isReturn = board === 'return_pct'
  const podiumRows = data.rows.slice(0, 3)
  const listRows = data.rows.slice(3)
  const maxAbs = isReturn ? Math.max(1e-9, ...data.rows.map((r) => Math.abs(r.score))) : 1
  const visualOrder = [2, 1, 3].filter((rank) => podiumRows.some((r) => r.rank === rank))
  const rowByRank = new Map(podiumRows.map((r) => [r.rank, r]))
  const gridTemplate = visualOrder.length === 3 ? '1fr 1.18fr 1fr' : visualOrder.length === 2 ? '1fr 1.18fr' : '1fr'

  return (
    <>
      {data.rows.length === 0 ? (
        <EmptyState data={data} board={board} rankThreshold={rankThreshold} minBaselineUsd={minBaselineUsd} />
      ) : (
        <>
          {/* ≥ 640px：三张卡（PodiumCard），布局/断点原样不动。
              ≥ 640px: the three PodiumCard cards, layout and breakpoints
              untouched. */}
          {podiumRows.length > 0 && (
            <div
              className="lb-podium hidden flex-col gap-3 sm:flex md:grid md:items-end md:gap-3.5"
              style={{ gridTemplateColumns: gridTemplate }}
            >
              {visualOrder.map((rank) => {
                const row = rowByRank.get(rank)
                if (!row) return null
                return <PodiumCard key={row.rank} row={row} board={board} maxAbs={maxAbs} />
              })}
            </div>
          )}

          {/* < 640px：真领奖台——一块玻璃面板，2|1|3 三列，中间列抬高+金色光斑。
              < 640px: a real podium — one glass panel, three columns in
              2|1|3 order, the center column raised with a gold spotlight. */}
          {podiumRows.length > 0 && (
            <div
              className={`lb-podium-m glass relative grid items-end gap-2 p-3 sm:hidden ${
                visualOrder.length === 3 ? 'grid-cols-3' : visualOrder.length === 2 ? 'grid-cols-2' : 'grid-cols-1 justify-items-center'
              }`}
            >
              {visualOrder.map((rank) => {
                const row = rowByRank.get(rank)
                if (!row) return null
                return <PodiumColumnMobile key={row.rank} row={row} board={board} center={row.rank === 1} />
              })}
            </div>
          )}

          {listRows.length > 0 && (
            <section className="lb-list-m divide-y divide-white/[0.08] sm:hidden">
              {listRows.map((row) => (
                <ListRowMobile key={row.rank} row={row} board={board} />
              ))}
            </section>
          )}

          {/* ≥ 640px：原表头 + ListRow，一像素不改。
              ≥ 640px: the original header row + ListRow, untouched. */}
          {listRows.length > 0 && (
            <section className="glass hidden overflow-hidden p-0 sm:block">
              <div className="grid grid-cols-[40px_minmax(0,1fr)_84px] gap-2 px-3 pb-2 pt-2.5 text-[11px] uppercase tracking-wider text-neutral-500 md:grid-cols-[56px_minmax(0,1.4fr)_120px_minmax(0,1.2fr)_88px] md:gap-3 md:px-[18px]">
                <span>{t('leaderboard.colRank')}</span>
                <span>{t('leaderboard.colTrader')}</span>
                <span className="hidden md:block">{t('leaderboard.colAccount')}</span>
                <span>{t(`leaderboard.colScore.${board}`)}</span>
                <span className="hidden text-right md:block">{t('leaderboard.colSample')}</span>
              </div>
              {listRows.map((row) => (
                <ListRow key={row.rank} row={row} board={board} maxAbs={maxAbs} />
              ))}
            </section>
          )}
        </>
      )}

      <MyRankCard data={data} board={board} rankThreshold={rankThreshold} />
      <MyRankBarMobile data={data} board={board} />
    </>
  )
}

// 贴合榜单版式的骨架：桌面三张领奖台卡 / 手机一块领奖台面板，加四行名次和一张
// 我的名次卡。靠 .lb-skel 延迟 150ms 才显形——本地或缓存命中时请求几十毫秒就
// 回来，骨架根本轮不到露面，也就不会出现"骨架闪一下再换内容"的二次闪烁。
// Layout-matched skeleton: three podium cards on desktop / one podium panel on
// mobile, plus four ranked rows and a my-rank card. .lb-skel delays it 150ms —
// a fast (local / cached) response lands before it ever shows, so there is no
// "skeleton blinks, then content" double flash.
function BoardSkeleton() {
  return (
    <div className="lb-skel space-y-6" aria-hidden>
      <div className="hidden items-end gap-3.5 sm:grid" style={{ gridTemplateColumns: '1fr 1.18fr 1fr' }}>
        <SkeletonBlock height={SKEL_PODIUM_SIDE} radius="var(--r-lg)" />
        <SkeletonBlock height={SKEL_PODIUM_CENTER} radius="var(--r-lg)" />
        <SkeletonBlock height={SKEL_PODIUM_SIDE} radius="var(--r-lg)" />
      </div>
      <div className="sm:hidden">
        <SkeletonBlock height={SKEL_PODIUM_MOBILE} radius="var(--r-lg)" />
      </div>
      <div className="skeleton-card divide-y divide-white/[0.06] overflow-hidden">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-4 sm:px-[18px] sm:py-2.5">
            <SkeletonBlock width={28} height={28} radius={999} />
            <SkeletonLine width={i % 2 ? '30%' : '40%'} height={12} />
            <SkeletonLine width={64} height={12} className="ml-auto" />
          </div>
        ))}
      </div>
      {/* 手机端「我的名次」是钉在底栏上的浮动条（portal），不占页面高度，骨架也不占。
          On mobile the my-rank bar is a fixed portal above the tab bar and takes no page
          height, so its skeleton is desktop-only too. */}
      <div className="hidden sm:block">
        <SkeletonBlock height={SKEL_MINE} radius="var(--r-lg)" />
      </div>
    </div>
  )
}

export default function LeaderboardPage() {
  const { t } = useTranslation()
  const [board, setBoard] = useState<LeaderboardBoard>('return_pct')
  const [period, setPeriod] = useState<Period>('week')
  // 按 (榜单, 周期) 缓存 payload：切回看过的组合零等待直接出内容并后台静默刷新；
  // 没看过的组合只把榜单主体换成骨架，页头 / 控件 / 榜规原地不动。
  // Payload cache keyed by (board, period): a seen combo renders instantly and
  // refreshes silently in the background; an unseen one swaps only the board
  // body for a skeleton while header / controls / gate chips stay in place.
  const [cache, setCache] = useState<Partial<Record<string, LeaderboardPayload>>>({})
  const [forbidden, setForbidden] = useState(false)
  const key = `${board}:${period}`
  const data = cache[key]

  useEffect(() => {
    let cancelled = false
    const k = `${board}:${period}`
    gamificationApi
      .leaderboard(board, period)
      .then((res) => {
        if (!cancelled) setCache((c) => ({ ...c, [k]: res }))
      })
      .catch(() => {
        // 唯一预期的失败是入口理论上已隐藏、用户直接打 URL 撞上 403——不细分
        // 错误类型，统一退化成内测提示（同 AchievementsPage）。
        // The one expected failure is someone hitting a URL whose entry is
        // already hidden and getting a 403 — not worth distinguishing error
        // kinds; everything degrades to the same beta hint (same as
        // AchievementsPage).
        if (!cancelled) setForbidden(true)
      })
    return () => {
      cancelled = true
    }
  }, [board, period])

  if (forbidden) {
    return (
      <div className="mx-auto flex min-h-[40vh] max-w-[1100px] items-center justify-center">
        <p className="card glass p-6 text-center text-sm text-neutral-400">
          {t('gamification.admin.visibleOff')}
        </p>
      </div>
    )
  }

  // 榜规不随榜单 / 周期变，周期区间不随榜单变：任一已到的 payload 都能先顶上，
  // 切榜时榜规芯片和周期行就不会跟着闪空；只有首屏什么都没有时才放占位。
  // Gates don't vary by board / period and the period range doesn't vary by
  // board, so any payload already in hand can stand in — chips and the period
  // line never blank out on a toggle; placeholders appear only on a cold start.
  const anyPayload = data ?? Object.values(cache).find(Boolean)
  const periodSrc = data ?? BOARDS.map((b) => cache[`${b}:${period}`]).find(Boolean)
  // data.gates should always be present once a payload lands (the backend
  // always sends it) — the fallback is defensive only, so a mid-rollout
  // mismatch degrades to the old hardcoded numbers instead of throwing.
  const gates = anyPayload?.gates ?? DEFAULT_GATES
  const rankThreshold: Record<LeaderboardBoard, number> = {
    return_pct: gates.minTradesReturn,
    win_rate: gates.minTradesWinrate,
  }
  const isReturn = board === 'return_pct'

  const { year, week, month } = parsePeriodKey(periodSrc?.periodKey ?? '', period)
  const sealed = periodSrc?.sealAt ? Date.now() >= new Date(periodSrc.sealAt).getTime() : false

  // quantitative: true 的几条（笔数/本金/盈亏为正）手机端常显；false 的几条
  // 是说明性文案（比收益率不比金额、入金并入分母、按账户·打码·明示），手机端
  // 用 hidden sm:inline-flex 藏起来腾地方，桌面端仍然全部显示、不变。
  // quantitative: true entries (trade count / baseline / positive P&L) stay
  // visible on mobile; the false ones are descriptive copy (metric framing,
  // deposit handling, identity policy) hidden on mobile via
  // hidden sm:inline-flex to save room — desktop still shows all of them,
  // unchanged.
  const gateChips: { text: string; quantitative: boolean }[] = isReturn
    ? [
        { text: t('leaderboard.gates.returnMetric'), quantitative: false },
        { text: t('leaderboard.gates.minTradesReturn', { n: gates.minTradesReturn }), quantitative: true },
        { text: t('leaderboard.gates.minBaseline', { usd: fmtUsd(gates.minBaselineUsd) }), quantitative: true },
        { text: t('leaderboard.gates.deposits'), quantitative: false },
        { text: t('leaderboard.gates.identity'), quantitative: false },
      ]
    : [
        { text: t('leaderboard.gates.minTradesWinrate', { n: gates.minTradesWinrate }), quantitative: true },
        // 盈亏正闸是可配的（管理端默认关）——关着的时候这条榜规不成立，不能挂在页面上。
        // The profit gate is configurable (off by default in admin); while it's off the
        // rule isn't true, so the chip must not be shown.
        ...(gates.winrateRequireProfit
          ? [{ text: t('leaderboard.gates.positive'), quantitative: true }]
          : []),
        { text: t('leaderboard.gates.identity'), quantitative: false },
      ]

  return (
    // pb-[76px]：手机端把「我的名次」钉在底栏上方，页面内容需要留出净空，
    // 否则榜单最后几行会被那张浮动条挡住摸不到；桌面端 sm:pb-10 原样不变。
    // pb-[76px]: mobile pins the rank bar above the tab bar, so page content
    // needs clearance or the list's last rows end up trapped under it;
    // desktop keeps the original sm:pb-10 unchanged.
    <div className="mx-auto max-w-[1100px] space-y-6 pb-[76px] sm:pb-10">
      <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="font-display text-2xl font-bold text-neutral-100">
            <span className="neon-text">{t('leaderboard.title')}</span>
          </h2>
          {periodSrc?.periodStart && periodSrc.periodEnd && (
            <>
              {/* ≥ 640px：原样不动。桌面这行一像素不改。
                  ≥ 640px: unchanged verbatim — pixel-identical to before. */}
              <div className="mt-2 hidden flex-wrap items-center gap-x-3.5 gap-y-2 text-[13px] text-neutral-400 sm:flex">
                <span className="font-semibold text-neutral-100">
                  {period === 'week' ? t('leaderboard.periodWeek', { year, week }) : t('leaderboard.periodMonth', { year, month })}
                </span>
                <span className="text-neutral-600">·</span>
                <span className="num">
                  {fmtUtcShortDate(periodSrc.periodStart)} –{' '}
                  {fmtUtcShortDate(new Date(new Date(periodSrc.periodEnd).getTime() - 86400000).toISOString())}
                </span>
                <span className="text-neutral-600">·</span>
                <span className="chip inline-flex items-center gap-1.5 border border-white/10 text-neutral-300">
                  <i
                    aria-hidden
                    className={`h-1.5 w-1.5 rounded-full ${sealed ? 'bg-neutral-500' : 'bg-up shadow-[0_0_0_3px_rgba(53,201,122,.15)]'}`}
                  />
                  {sealed || !periodSrc.sealAt ? t('leaderboard.sealed') : t('leaderboard.sealRunning', { time: fmtUtcClock(periodSrc.sealAt) })}
                </span>
              </div>
              {/* < 640px：周期+日期揉成一条 13px 的浅色行，封存 chip 收窄 padding，
                  两者放进同一个 flex-wrap 行，装不下才换行——不是原本桌面版那种
                  永远分成两三段的写法。
                  < 640px: the period label and dates fold into one muted 13px
                  line, and the seal chip gets tighter padding; both sit in one
                  flex-wrap row that only breaks onto a second line when it
                  doesn't fit, unlike the desktop version's always-segmented
                  layout. */}
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 sm:hidden">
                <span className="text-[13px] text-neutral-400">
                  {period === 'week' ? t('leaderboard.periodWeek', { year, week }) : t('leaderboard.periodMonth', { year, month })}
                  <span className="text-neutral-600"> · </span>
                  <span className="num">
                    {fmtUtcShortDate(periodSrc.periodStart)} –{' '}
                    {fmtUtcShortDate(new Date(new Date(periodSrc.periodEnd).getTime() - 86400000).toISOString())}
                  </span>
                </span>
                <span className="chip inline-flex items-center gap-1.5 border border-white/10 px-2 py-1 text-[11px] text-neutral-300">
                  <i
                    aria-hidden
                    className={`h-1.5 w-1.5 rounded-full ${sealed ? 'bg-neutral-500' : 'bg-up shadow-[0_0_0_3px_rgba(53,201,122,.15)]'}`}
                  />
                  {sealed || !periodSrc.sealAt ? t('leaderboard.sealed') : t('leaderboard.sealRunning', { time: fmtUtcClock(periodSrc.sealAt) })}
                </span>
              </div>
            </>
          )}
          {/* 冷启动占位：撑住周期行的高度，payload 一到就被真实周期行顶掉。
              Cold-start placeholder holding the period line's height until the
              first payload replaces it. */}
          {!periodSrc && (
            <div className="lb-skel mt-3.5 space-y-2">
              <SkeletonLine width={280} height={14} />
              {/* 手机端周期行会折成两行（日期 + 封存芯片），多撑一枚芯片高度。
                  On mobile the period line wraps to two rows (dates + seal chip),
                  so hold one extra chip-height there. */}
              <SkeletonLine width={150} height={22} className="sm:!hidden" />
            </div>
          )}
        </div>
        <div className="lb-controls flex flex-row items-center gap-2 sm:flex-wrap sm:gap-2.5">
          <div className="lb-seg-board seg-tabs w-full sm:w-fit" role="tablist">
            {BOARDS.map((b) => (
              <button
                key={b}
                type="button"
                role="tab"
                aria-selected={board === b}
                onClick={() => setBoard(b)}
                className={`flex-1 sm:flex-none ${board === b ? 'on' : ''}`}
              >
                {t(`leaderboard.boards.${b}`)}
              </button>
            ))}
          </div>
          <div className="lb-seg-period seg-tabs w-full sm:w-fit" role="tablist">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={period === p}
                onClick={() => setPeriod(p)}
                className={`flex-1 sm:flex-none ${period === p ? 'on' : ''}`}
              >
                {t(`leaderboard.periods.${p}`)}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="lb-gates -mx-4 flex flex-nowrap gap-2 overflow-x-auto px-4 no-scrollbar sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
        {!anyPayload &&
          [120, 96, 132].map((w) => (
            <span key={w} className="lb-skel shrink-0">
              <SkeletonBlock width={w} height={26} radius={999} />
            </span>
          ))}
        {anyPayload &&
          gateChips.map((chip) => (
          <span
            key={chip.text}
            className={`chip shrink-0 border border-white/10 bg-white/[0.04] h-[26px] px-2.5 text-[11px] text-neutral-400 sm:h-auto sm:px-2 sm:py-1 sm:text-xs ${chip.quantitative ? '' : 'hidden sm:inline-flex'}`}
          >
            {chip.text}
          </span>
        ))}
      </div>

      {data ? (
        // key 跟着 (榜单, 周期) 走：换组合时主体整块淡入，同一组合的后台刷新
        // 只更新数据、不重新播动画。
        // Keyed by (board, period): switching combos fades the whole body in;
        // a background refresh of the same combo just updates data, no replay.
        <div key={key} className="content-fade space-y-6">
          <BoardBody data={data} board={board} rankThreshold={rankThreshold[board]} minBaselineUsd={gates.minBaselineUsd} />
        </div>
      ) : (
        <BoardSkeleton />
      )}
    </div>
  )
}
