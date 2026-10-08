// 比赛时钟与状态标签的纯函数：站内比赛页（CompetitionsPage）与公开比赛页
// （PublicCompetitionPage）共用。不依赖 React，也不 import 任何会拉起 useLive /
// Layout 的模块——公开页的 chunk 不该为几个函数背上站内页的依赖。
// Pure clock / status-tag helpers shared by the in-app competitions page and the
// public competition page. React-free, and nothing here pulls in useLive / Layout:
// the public page's chunk must not carry the in-app page's dependencies.
import type { TFunction } from 'i18next'
import { fmtDay, parseTime } from '../../api/utils'
import { fmtCountdown, regState } from '../../utils/competitionTime'
import type { CompetitionSummary } from '../../api/types'

// 时钟与标签只读这几个字段；公开载荷（PublicCompetition）与站内概览都满足。
// The clock and tag read only these fields; both the public payload and the in-app summary satisfy it.
export type CompTiming = Pick<CompetitionSummary, 'status' | 'startsAt' | 'endsAt' | 'enrollment' | 'regOpensAt' | 'regClosesAt'>

// 详情页的钟表：把倒计时拆成 天 / 小时 / 分 三格大数字（不足一天只给两格），
// 到点返回 parts=null 让页面写"即将"。与列表卡的一句话倒计时同一套时刻判定。
// The detail page clock: the countdown split into day / hour / minute cells of
// large numerals (two cells under a day); parts=null at zero so the page can say
// "any moment". Same target-instant rule as the one-line countdown on list cards.
export type ClockUnit = 'd' | 'h' | 'm'
export interface ClockPart { unit: ClockUnit; value: number }

export function clockOf(c: CompTiming, nowMs: number, t: TFunction):
    { label: string; parts: ClockPart[] | null } | null {
  // 已结束 / 已终审（可能是提前强制终审）没有什么可倒数的，哪怕 endsAt 还在未来。
  // Ended / settled (possibly force-settled early) has nothing left to count down,
  // even when endsAt is still in the future.
  if (c.status === 'ended' || c.status === 'settled') return null
  const starts = parseTime(c.startsAt)?.getTime() ?? null
  const ends = parseTime(c.endsAt)?.getTime() ?? null
  const target = starts != null && nowMs < starts
    ? { label: t('competition.cd.toStart'), at: starts }
    : ends != null && nowMs < ends
      ? { label: t('competition.cd.toEnd'), at: ends }
      : null
  if (!target) return null
  const mins = Math.floor((target.at - nowMs) / 60_000)
  if (mins <= 0) return { label: target.label, parts: null }
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  const parts: ClockPart[] = d > 0
    ? [{ unit: 'd', value: d }, { unit: 'h', value: h }, { unit: 'm', value: m }]
    : [{ unit: 'h', value: h }, { unit: 'm', value: m }]
  return { label: target.label, parts }
}

// 倒计时指向哪个时刻：未开赛看开赛，进行中看结束，已结束不再倒计时。
// Which instant the countdown targets: start before it begins, end while running,
// nothing once it's over.
export function countdownOf(c: CompTiming, nowMs: number, t: TFunction):
    { label: string; value: string } | null {
  if (c.status === 'ended' || c.status === 'settled') return null
  // parseTime 返回 Date，倒计时要的是毫秒差，先取时间戳。
  // parseTime returns a Date; the countdown needs a millisecond delta, so take the stamp.
  const starts = parseTime(c.startsAt)?.getTime() ?? null
  const ends = parseTime(c.endsAt)?.getTime() ?? null
  if (starts != null && nowMs < starts) {
    return { label: t('competition.cd.toStart'), value: fmtCountdown(starts - nowMs, t) }
  }
  if (ends != null && nowMs < ends) {
    return { label: t('competition.cd.toEnd'), value: fmtCountdown(ends - nowMs, t) }
  }
  return null
}

// 状态 tag 的取值集合与 i18n competition.status 的键一一对应：upcoming/running/
// settled 直接照抄 comp.status；仅两处不直接照抄——comp.status=="ended" 对应
// i18n 键是 "finished"（用户端措辞，不是内部状态名）；comp.status=="upcoming"
// 且报名制、当前恰好在报名窗口内时，细分成 "regOpen"，比笼统的"即将开始"更
// 有信息量（该干嘛写在 tag 上，用户不用点进详情才知道能不能报名）。
//
// The status-tag value set maps 1:1 onto the i18n competition.status keys:
// upcoming/running/settled are copied straight from comp.status. Two are not:
// comp.status=="ended" maps to the i18n key "finished" (user-facing wording,
// not the internal state name); and comp.status=="upcoming" with signup
// enrollment currently inside its registration window is narrowed to
// "regOpen" — more informative than a blanket "upcoming" tag, since it tells
// the user whether they can register without opening the detail view.
export function statusTagKey(c: CompTiming, nowMs: number): string {
  if (c.status === 'upcoming' && regState(c, nowMs) === 'open') return 'regOpen'
  if (c.status === 'ended') return 'finished'
  return c.status
}

// 列表上的时间窗口只到日：两端各带时分和时区的一串在手机上要折两行，而列表
// 只需要知道"哪几天"，精确到分钟的时刻详情页才需要。fmtDay 本身现在住在
// api/utils.ts（勋章详情/成就页的绝版截止日也要用同一个格式化）。
// Time windows on the list stop at the day: two full timestamps with zone wrap onto
// two lines on a phone, and the list only needs "which days"; minute precision
// belongs to the detail page. fmtDay itself now lives in api/utils.ts (the
// limited-badge closing date on the achievements/detail pages needs the same format).
// 带上时区后缀。fmtDay 走的是 Asia/Shanghai（UTC+8），而同一个「成长」壳下的
// 排行榜页按 UTC 显示周期区间——两个页签的日期本来就会差一天，此前**两边都没有
// 标注**，看到的人无从分辨是口径不同还是数据不对。api/utils 的 fmtDate/fmtTime
// 都已经带 "UTC+8" 后缀，唯独 fmtDay 没有；fmtDay 是共享工具（勋章绝版日等也在
// 用），不在本次改动范围内，所以后缀加在这个调用点上。
// Tag the zone. fmtDay renders in Asia/Shanghai (UTC+8) while the leaderboard tab
// under the same Growth shell shows its period range in UTC, so the two tabs can
// legitimately differ by a day — and neither was labelled, leaving no way to tell
// a zone difference from bad data. fmtDate/fmtTime in api/utils already carry a
// "UTC+8" suffix; fmtDay alone does not, and being a shared helper (limited-badge
// closing dates use it too) it is out of scope here, so the suffix goes on this
// call site.
export const fmtRange = (c: Pick<CompetitionSummary, 'startsAt' | 'endsAt'>) =>
  `${c.startsAt ? fmtDay(c.startsAt) : '—'} → ${c.endsAt ? fmtDay(c.endsAt) : '—'} UTC+8`

// 转播角标的读数：固定 DD:HH:MM，不足一天也补 00，读数的位置和宽度永远不变。
// The broadcast bug's readout: always DD:HH:MM, zero-padded under a day, so the
// readout never changes place or width.
export function bugReadout(parts: ClockPart[]): string {
  const v: Record<ClockUnit, number> = { d: 0, h: 0, m: 0 }
  for (const p of parts) v[p.unit] = p.value
  return [v.d, v.h, v.m].map((n) => String(n).padStart(2, '0')).join(':')
}
