// 排行榜页：两榜（收益率/胜率）× 周/月 seg-tabs + 表格 + 底部固定「我的名次」条。
// 入口本身按 leaderboardVisible 门控（见 Layout/UserMenu），这里只处理直接
// 打 URL 绕过入口的情况——理论上只有内测期的普通用户会撞上 403，兜底成一句
// 提示而不是把接口错误糊在脸上（照成就页 AchievementsPage 的模式）。
// Leaderboard page: two boards (return rate / win rate) x week/month seg-tabs,
// a table, and a sticky-bottom "my rank" bar. The entry point itself is gated
// on leaderboardVisible (see Layout/UserMenu); this only handles someone
// hitting the URL directly — in practice only a regular user during the beta
// window, degraded to one line of copy instead of a raw API error (same
// pattern as AchievementsPage).
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { gamificationApi } from '../api/client'
import { SkeletonPage } from '../components/Skeleton'
import BadgeIcon from '../components/badges/BadgeIcon'
import { BADGE_RARITY } from '../components/badges/badgeRarity'
import type { LeaderboardBoard, LeaderboardPayload } from '../api/types'

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
// the rules copy and the notRanked hint's {{n}}/{{usd}} read from
// data.gates. DEFAULT_GATES is only a placeholder before the first payload
// arrives, so the loading phase never flashes the raw "{{n}}" token; once
// data lands it fully defers to the real values, never showing a stale or
// wrong number.
const DEFAULT_GATES = { minTradesReturn: 5, minTradesWinrate: 20, minBaselineUsd: 500 }

// 勋章稀有度镜像表：见 components/badges/badgeRarity.ts 的说明——现在与
// CompetitionsPage 的比赛榜共用同一份，拆出去后这里只剩 import。
// Badge-rarity mirror: see components/badges/badgeRarity.ts — now shared with
// CompetitionsPage's competition board, hence just an import here.

// score 是分数（0.124 = 12.4%），两榜统一按百分比一位小数显示——收益率榜可能
// 为负（亏损），toFixed 对负数一样成立，不需要特判。
// score is a fraction (0.124 = 12.4%); both boards render it as a percentage
// with one decimal. The return board's score can be negative (a loss);
// toFixed handles that the same way, no special-casing needed.
const fmtScorePct = (v: number): string => `${(v * 100).toFixed(1)}%`

// 最低本金门槛的展示格式：整数美元不带小数（500 而不是 500.00），非整数才保留
// 两位——管理端目前只允许输入正数，没有强制整数，所以两种都要处理。
// Display formatting for the minimum-baseline gate: a whole-dollar figure
// renders without decimals (500, not 500.00); anything else keeps two. The
// admin form only requires a positive number, not an integer, so both shapes
// are possible.
const fmtUsd = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2))

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

  return (
    <div className="mx-auto max-w-[1100px] space-y-6 pb-24 lg:pb-6">
      <h2 className="font-display text-2xl font-bold text-neutral-100">
        <span className="neon-text">{t('leaderboard.title')}</span>
      </h2>

      <div className="flex flex-wrap items-center gap-3">
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

      {/* 榜规说明：随选中的 board 换文案，两榜口径完全不同（收益率看本金门槛、
          胜率看笔数与盈亏），不能共用一句话。
          Rules line: switches with the selected board — the two boards' rules
          are unrelated (the return board gates on a capital baseline, the
          win-rate board on trade count and P&L), so one shared sentence
          wouldn't fit either. */}
      <p className="text-xs leading-relaxed text-neutral-500">
        {t(`leaderboard.rules.${board}`, { n: rankThreshold[board], usd: fmtUsd(gates.minBaselineUsd) })}
      </p>

      <section className="card glass overflow-hidden p-0">
        {data.rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-neutral-400">{t('leaderboard.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-xs text-neutral-500">
                  <th className="py-2.5 pl-4 pr-2 font-medium">{t('leaderboard.colRank')}</th>
                  <th className="py-2.5 pr-2 font-medium">{t('leaderboard.colTrader')}</th>
                  <th className="py-2.5 pr-2 font-medium">{t('leaderboard.colAccount')}</th>
                  <th className="py-2.5 pr-2 font-medium">{t(`leaderboard.colScore.${board}`)}</th>
                  <th className="py-2.5 pr-4 font-medium">{t('leaderboard.colSample')}</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr
                    key={row.rank}
                    className={`border-t border-white/5 ${row.isSelf ? 'bg-prism-600/10' : ''}`}
                  >
                    <td className="num py-2.5 pl-4 pr-2 text-neutral-300">{row.rank}</td>
                    <td className="py-2.5 pr-2">
                      <div className="flex items-center gap-2">
                        {row.equippedBadge && (
                          <BadgeIcon
                            id={row.equippedBadge}
                            rarity={BADGE_RARITY[row.equippedBadge] ?? 'common'}
                            earned
                            size={20}
                          />
                        )}
                        <span className={row.isSelf ? 'font-semibold text-neutral-100' : 'text-neutral-200'}>
                          {row.displayName}
                        </span>
                        {row.isSelf && (
                          <span className="tag shrink-0 bg-prism-600/25 text-[11px] text-prism-300">
                            {t('leaderboard.youTag')}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="num py-2.5 pr-2 text-neutral-400">{row.login}</td>
                    <td className="num py-2.5 pr-2 font-semibold text-neutral-100">
                      {fmtScorePct(row.score)}
                    </td>
                    <td className="num py-2.5 pr-4 text-neutral-500">{row.sample}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 底部固定「我的名次」条：me 为 null 表示本期未上榜（含未参与），此时
          n 取当前选中榜在 data.gates 里的门槛笔数——两榜门槛不同，且管理端可调，
          写死一个数字既会在切榜之后说错话，也会在管理员调松/调严门槛后过时。
          bottom 在 lg 以下额外抬高，让开移动端固定底栏（.lg-tabbar，见
          Layout.tsx），否则两条固定在底部的条会叠在一起。
          Sticky-bottom "my rank" bar: me is null when not ranked this period
          (including not participating), in which case n is the threshold for
          the currently selected board, read from data.gates — the two boards
          differ and the admin can retune either, so a hardcoded number would
          misstate itself both across boards and after any admin change. The
          bottom offset is raised below lg to clear the mobile fixed tab bar
          (.lg-tabbar, see Layout.tsx), or the two bottom-pinned bars would
          overlap. */}
      <div className="sticky bottom-[84px] z-20 lg:bottom-4">
        <div className="card glass flex flex-wrap items-center justify-between gap-3 p-4 shadow-prism">
          <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
            {t('leaderboard.myRank')}
          </span>
          {data.me ? (
            <div className="flex items-center gap-4 text-sm">
              <span className="num font-semibold text-neutral-100">#{data.me.rank}</span>
              <span className="num text-neutral-300">{fmtScorePct(data.me.score)}</span>
              <span className="num text-neutral-500">{data.me.sample}</span>
            </div>
          ) : (
            <span className="text-sm text-neutral-400">
              {t('leaderboard.notRanked', { n: rankThreshold[board] })}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
