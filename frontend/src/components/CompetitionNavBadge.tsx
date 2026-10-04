// 顶栏比赛徽标（电脑版）：有比赛正在进行或正在报名时，挂在顶栏右侧图标区最前面的
// 一枚双行徽标。两种状态两种配色，一眼分得开：
//   进行中 → 品牌紫金属渐变的大号斜体 LIVE + 绿色「比赛进行中」
//   报名中 → 香槟金金属渐变的大号斜体 JOIN + 金色「比赛报名中」
// 两种同时存在时优先显示进行中（正在发生的事比能报名的事更急）。上行都带一道定时
// 扫光和一盏呼吸灯。灵感来自交易所顶栏的活动入口，但用的是我们自己的字体与色彩。
// 都没有、或比赛入口对该用户未开放（内测开关 competitionsVisible）时整个不渲染。
//
// 同一状态只有一场时直接跳进那场的详情；多场时进比赛列表，下行显示场数。只在 xl
// （≥1280px）显示：lg 到 xl 之间顶栏已经挤满导航项加右侧一排图标，英文更长，再塞
// 一枚会溢出（同 Layout 里把桌面/手机分界挪到 lg 的那段测量）。手机端不挂，比赛入口
// 在底栏「成长」与仪表盘的跑马灯里。
//
// 数据与仪表盘跑马灯同源（GET /competitions），但各自轮询：这里只关心「有没有在进行 /
// 在报名」，2 分钟一次足够；切到后台标签页时暂停（usePollWhileVisible）。报名窗口按
// 渲染时的当前时间判断，不挂秒级时钟——顶栏每秒重渲染不值得，窗口开关最多晚 2 分钟露出。
//
// Top-bar competition badge (desktop): a two-line badge at the front of the right-hand
// icon row while a competition is running or open for signup. Two states, two
// palettes, distinguishable at a glance:
//   running     → large italic LIVE in brand-purple metal + green "contest live"
//   signup open → large italic JOIN in champagne-gold metal + gold "signup open"
// Running wins when both exist (what is happening beats what can be joined). Both
// carry a periodic shimmer and a breathing dot. Inspired by exchange top-bar promo
// entries, in our own type and colour. Renders nothing when neither applies or the
// competitions beta switch is off for this user.
//
// A single competition in that state links straight into it; several link to the
// list, with the count on the second line. Shown only at xl (≥1280px): between lg
// and xl the bar is full and one more item overflows (same measurement that moved the
// desktop/mobile switch to lg in Layout). Not on mobile, where competitions are
// reachable from the bottom bar and the dashboard ticker. Same source as the dashboard
// ticker (GET /competitions) polled on its own every 2 minutes, paused while hidden.
// The signup window is judged against the time at render rather than a per-second
// clock — re-rendering the top bar every second isn't worth it; a window opening or
// closing shows up at most two minutes late.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { competitionApi } from '../api/client'
import { parseTime } from '../api/utils'
import type { CompetitionListGrouped, CompetitionSummary } from '../api/types'
import { useAuth } from '../store/auth'
import { usePollWhileVisible } from '../utils/usePollWhileVisible'

const POLL_MS = 2 * 60_000

// 报名窗口是否开着——与 utils/competitionTime 的 regState(...) === 'open' 同义。没直接
// import 那个文件：它还带着倒计时文案（competition.cd.*），一 import 这些键就算进了
// Layout 的依赖图，i18n.test 会要求它们全进核心包，为了一个三行判断不值得。
// Whether signup is open — same meaning as regState(...) === 'open' in
// utils/competitionTime. Not imported: that module also carries the countdown copy
// (competition.cd.*), which would pull those keys into Layout's graph and, per
// i18n.test, into the core bundle — not worth it for a three-line check.
function signupOpen(c: CompetitionSummary, nowMs: number): boolean {
  if (c.enrollment !== 'signup') return false
  const opens = parseTime(c.regOpensAt)?.getTime()
  const closes = parseTime(c.regClosesAt)?.getTime()
  return opens != null && closes != null && opens <= nowMs && nowMs < closes
}

export default function CompetitionNavBadge() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const visible = !!user?.competitionsVisible
  const [data, setData] = useState<Pick<CompetitionListGrouped, 'running' | 'upcoming'> | null>(null)

  usePollWhileVisible(
    (isCurrent) => {
      competitionApi.list()
        .then((r) => { if (isCurrent()) setData({ running: r.running, upcoming: r.upcoming }) })
        .catch(() => {})
    },
    POLL_MS,
    [visible],
    { enabled: visible },
  )

  if (!visible || !data) return null

  const now = Date.now()
  const running = data.running
  const signup = data.upcoming.filter((c) => signupOpen(c, now))
  const kind = running.length > 0 ? 'live' : signup.length > 0 ? 'join' : null
  if (!kind) return null

  const list = kind === 'live' ? running : signup
  const only = list.length === 1 ? list[0] : null
  const to = only ? `/competitions?c=${encodeURIComponent(only.id)}` : '/competitions'
  const label = kind === 'live'
    ? (only ? t('competition.navLiveOne', { name: only.name }) : t('competition.navLiveMany', { n: list.length }))
    : (only ? t('competition.navJoinOne', { name: only.name }) : t('competition.navJoinMany', { n: list.length }))
  const sub = kind === 'live'
    ? (only ? t('competition.navLive') : t('competition.navLiveCount', { n: list.length }))
    : (only ? t('competition.navJoin') : t('competition.navJoinCount', { n: list.length }))

  return (
    <Link to={to} className={`cmp-navlive is-${kind} hidden xl:inline-flex`} aria-label={label} title={label}>
      <span className="cmp-navlive-top" aria-hidden>
        <i className="cmp-navlive-dot" />
        <b>{kind === 'live' ? 'LIVE' : 'JOIN'}</b>
      </span>
      <span className="cmp-navlive-sub" aria-hidden>{sub}</span>
    </Link>
  )
}
