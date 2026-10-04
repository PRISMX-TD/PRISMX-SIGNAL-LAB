// 比赛的时间工具：比赛页与仪表盘走马灯共用。从 CompetitionsPage 抽出来，
// 这样仪表盘不必为了几个函数把整个比赛页的代码块拉进来。
// Competition time helpers shared by the competitions page and the dashboard
// marquee. Lifted out of CompetitionsPage so the dashboard needn't pull in the
// whole page chunk for a few functions.
import { useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import { parseTime } from '../api/utils'
import type { CompetitionSummary } from '../api/types'

// 每 30 秒走一次的时钟：倒计时与"进行中/已结束"的判定都读它。30 秒够用——
// 倒计时最小单位是分钟，秒级刷新只是白白重渲染整页。
// A 30s clock driving both the countdown and the running/ended checks. 30s is
// enough: the countdown's smallest unit is a minute, and a per-second tick would
// re-render the whole page for nothing.
export function useNowTicker(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

// 倒计时文案：只取最大的两个单位（3 天 5 小时 / 5 小时 12 分 / 12 分），
// 不足一分钟给"即将"。比赛跨度以天计，精确到秒既没用也让人焦虑。
// Countdown copy: the two largest units only (3d 5h / 5h 12m / 12m), with
// "any moment" under a minute. Competitions span days; second-level precision
// would be useless and needlessly anxious.
export function fmtCountdown(ms: number, t: TFunction): string {
  if (ms <= 0) return ''
  const mins = Math.floor(ms / 60_000)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  if (d > 0) return t('competition.cd.dh', { d, h })
  if (h > 0) return t('competition.cd.hm', { h, m })
  if (m > 0) return t('competition.cd.m', { m })
  return t('competition.cd.soon')
}

// 报名窗口状态：仅 enrollment=="signup" 且报名窗口两端都有值时才有意义——auto
// 参赛没有报名这回事，signup 赛的报名窗口后端建库时已强制两端必填（见
// routers/competitions.py 的 _validate_reg_window），这里仍防御性地处理 null。
// Registration-window state: only meaningful for enrollment=="signup" with
// both window ends set — auto-enrollment has no such window, and a signup
// competition's window is enforced non-null at creation server-side (see
// routers/competitions.py's _validate_reg_window); null is still handled
// defensively here.
export function regState(c: CompetitionSummary, nowMs: number): 'notOpen' | 'open' | 'closed' | null {
  if (c.enrollment !== 'signup') return null
  const opens = c.regOpensAt ? parseTime(c.regOpensAt)?.getTime() : null
  const closes = c.regClosesAt ? parseTime(c.regClosesAt)?.getTime() : null
  if (opens == null || closes == null) return null
  if (nowMs < opens) return 'notOpen'
  if (nowMs >= closes) return 'closed'
  return 'open'
}
