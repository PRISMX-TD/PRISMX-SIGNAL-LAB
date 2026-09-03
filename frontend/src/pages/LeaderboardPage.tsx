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
import { useTranslation } from 'react-i18next'
import { gamificationApi } from '../api/client'
import { SkeletonPage } from '../components/Skeleton'
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
const DEFAULT_GATES = { minTradesReturn: 5, minTradesWinrate: 20, minBaselineUsd: 500 }

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
      className={`glass relative overflow-hidden rounded-[20px] px-[22px] pb-[18px] transition-transform duration-300 ease-out hover:-translate-y-1 motion-reduce:hover:translate-y-0 ${big ? 'pt-[30px]' : 'pt-[22px]'} ${row.rank === 1 ? 'order-first md:order-none' : ''}`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{ backgroundImage: PODIUM_TINT[row.rank] }}
      />
      <div className="relative flex items-center gap-3">
        <RankCoin rank={row.rank} size={big ? 64 : 52} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold text-neutral-100">{row.displayName}</span>
            {row.equippedBadge && (
              <BadgeIcon id={row.equippedBadge} rarity={BADGE_RARITY[row.equippedBadge] ?? 'common'} earned size={20} />
            )}
            {row.isSelf && (
              <span className="tag shrink-0 bg-prism-600/25 text-[11px] text-prism-300">{t('leaderboard.youTag')}</span>
            )}
          </div>
          <div className="num mt-0.5 text-xs text-neutral-500">{row.login}</div>
        </div>
      </div>
      <div className="relative mt-[18px] flex items-baseline gap-2.5">
        <b
          className={`num font-display font-extrabold leading-none tracking-tight ${big ? 'text-[42px]' : 'text-[34px]'} ${scoreColorClass(board, row.score)}`}
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
      className={`relative grid grid-cols-[40px_minmax(0,1fr)_84px] items-center gap-2 border-t border-white/[0.08] px-3 py-3 md:grid-cols-[56px_minmax(0,1.4fr)_120px_minmax(0,1.2fr)_88px] md:gap-3 md:px-[18px] ${row.isSelf ? 'bg-prism-600/[0.07]' : ''}`}
    >
      {row.isSelf && <span aria-hidden className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r-[3px] bg-prism-400" />}
      <span className={`num text-[15px] ${row.isSelf ? 'font-semibold text-neutral-100' : 'text-neutral-400'}`}>
        {String(row.rank).padStart(2, '0')}
      </span>
      <div className="flex min-w-0 items-center gap-2">
        {row.equippedBadge && (
          <BadgeIcon id={row.equippedBadge} rarity={BADGE_RARITY[row.equippedBadge] ?? 'common'} earned size={20} />
        )}
        <span className={`truncate ${row.isSelf ? 'font-semibold text-neutral-100' : 'text-neutral-200'}`}>
          {row.displayName}
        </span>
        {row.isSelf && (
          <span className="tag shrink-0 bg-prism-600/25 text-[11px] text-prism-300">{t('leaderboard.youTag')}</span>
        )}
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
      <div className="glass flex flex-col gap-4 p-[18px_22px] sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <RankCoin rank={data.me.rank} size={40} />
          <div>
            <div className="text-[11px] uppercase tracking-wider text-neutral-500">{t('leaderboard.myRank')}</div>
            <div className="num font-display text-[28px] font-extrabold leading-tight tracking-tight text-neutral-100">
              #{data.me.rank}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-6">
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
      <div className="glass grid gap-3 p-[18px_22px] sm:grid-cols-[auto_1fr] sm:gap-[22px]">
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
    <div className="glass flex flex-wrap items-center justify-between gap-3 p-4">
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
    <section className="glass grid justify-items-center gap-2.5 px-7 py-11 text-center">
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

export default function LeaderboardPage() {
  const { t } = useTranslation()
  const [board, setBoard] = useState<LeaderboardBoard>('return_pct')
  const [period, setPeriod] = useState<Period>('week')
  const [data, setData] = useState<LeaderboardPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [forbidden, setForbidden] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setForbidden(false)
    gamificationApi
      .leaderboard(board, period)
      .then((res) => {
        if (!cancelled) setData(res)
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
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [board, period])

  if (loading) {
    return (
      <div className="mx-auto max-w-[1100px]">
        <SkeletonPage cards={3} />
      </div>
    )
  }

  if (forbidden || !data) {
    return (
      <div className="mx-auto flex min-h-[40vh] max-w-[1100px] items-center justify-center">
        <p className="card glass p-6 text-center text-sm text-neutral-400">
          {t('gamification.admin.visibleOff')}
        </p>
      </div>
    )
  }

  // data.gates should always be present once a payload lands (the backend
  // always sends it) — the fallback is defensive only, so a mid-rollout
  // mismatch degrades to the old hardcoded numbers instead of throwing.
  const gates = data.gates ?? DEFAULT_GATES
  const rankThreshold: Record<LeaderboardBoard, number> = {
    return_pct: gates.minTradesReturn,
    win_rate: gates.minTradesWinrate,
  }

  const isReturn = board === 'return_pct'
  const podiumRows = data.rows.slice(0, 3)
  const listRows = data.rows.slice(3)
  const maxAbs = isReturn ? Math.max(1e-9, ...data.rows.map((r) => Math.abs(r.score))) : 1
  const visualOrder = [2, 1, 3].filter((rank) => podiumRows.some((r) => r.rank === rank))
  const rowByRank = new Map(podiumRows.map((r) => [r.rank, r]))
  const gridTemplate = visualOrder.length === 3 ? '1fr 1.18fr 1fr' : visualOrder.length === 2 ? '1fr 1.18fr' : '1fr'

  const { year, week, month } = parsePeriodKey(data.periodKey, period)
  const sealed = data.sealAt ? Date.now() >= new Date(data.sealAt).getTime() : false

  const gateChips: string[] = isReturn
    ? [
        t('leaderboard.gates.returnMetric'),
        t('leaderboard.gates.minTradesReturn', { n: gates.minTradesReturn }),
        t('leaderboard.gates.minBaseline', { usd: fmtUsd(gates.minBaselineUsd) }),
        t('leaderboard.gates.deposits'),
        t('leaderboard.gates.identity'),
      ]
    : [
        t('leaderboard.gates.minTradesWinrate', { n: gates.minTradesWinrate }),
        t('leaderboard.gates.positive'),
        t('leaderboard.gates.identity'),
      ]

  return (
    <div className="mx-auto max-w-[1100px] space-y-6 pb-10">
      <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <h2 className="font-display text-2xl font-bold text-neutral-100">
            <span className="neon-text">{t('leaderboard.title')}</span>
          </h2>
          {data.periodStart && data.periodEnd && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-2 text-[13px] text-neutral-400">
              <span className="font-semibold text-neutral-100">
                {period === 'week' ? t('leaderboard.periodWeek', { year, week }) : t('leaderboard.periodMonth', { year, month })}
              </span>
              <span className="text-neutral-600">·</span>
              <span className="num">
                {fmtUtcShortDate(data.periodStart)} – {fmtUtcShortDate(new Date(new Date(data.periodEnd).getTime() - 86400000).toISOString())}
              </span>
              <span className="text-neutral-600">·</span>
              <span className="chip inline-flex items-center gap-1.5 border border-white/10 text-neutral-300">
                <i
                  aria-hidden
                  className={`h-1.5 w-1.5 rounded-full ${sealed ? 'bg-neutral-500' : 'bg-up shadow-[0_0_0_3px_rgba(53,201,122,.15)]'}`}
                />
                {sealed || !data.sealAt ? t('leaderboard.sealed') : t('leaderboard.sealRunning', { time: fmtUtcClock(data.sealAt) })}
              </span>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="seg-tabs" role="tablist">
            {BOARDS.map((b) => (
              <button
                key={b}
                type="button"
                role="tab"
                aria-selected={board === b}
                onClick={() => setBoard(b)}
                className={board === b ? 'on' : ''}
              >
                {t(`leaderboard.boards.${b}`)}
              </button>
            ))}
          </div>
          <div className="seg-tabs" role="tablist">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                role="tab"
                aria-selected={period === p}
                onClick={() => setPeriod(p)}
                className={period === p ? 'on' : ''}
              >
                {t(`leaderboard.periods.${p}`)}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        {gateChips.map((chip) => (
          <span key={chip} className="chip border border-white/10 bg-white/[0.04] text-neutral-400">
            {chip}
          </span>
        ))}
      </div>

      {data.rows.length === 0 ? (
        <EmptyState data={data} board={board} rankThreshold={rankThreshold[board]} minBaselineUsd={gates.minBaselineUsd} />
      ) : (
        <>
          {podiumRows.length > 0 && (
            <div className="flex flex-col gap-3 md:grid md:items-end md:gap-3.5" style={{ gridTemplateColumns: gridTemplate }}>
              {visualOrder.map((rank) => {
                const row = rowByRank.get(rank)
                if (!row) return null
                return <PodiumCard key={row.rank} row={row} board={board} maxAbs={maxAbs} />
              })}
            </div>
          )}

          {listRows.length > 0 && (
            <section className="glass overflow-hidden p-0">
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

      <MyRankCard data={data} board={board} rankThreshold={rankThreshold[board]} />
    </div>
  )
}
