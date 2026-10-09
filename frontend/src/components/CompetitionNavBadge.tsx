// 顶栏比赛徽标：有比赛正在进行或正在报名时，挂在顶栏右侧图标区的最前面。两种状态
// 两种配色，一眼分得开：
//   进行中 → 品牌紫金属渐变的斜体 LIVE + 绿色状态词
//   报名中 → 香槟金金属渐变的斜体 JOIN + 金色状态词
// 两种同时存在时优先显示进行中（正在发生的事比能报名的事更急）。字上有一道定时扫光。
// 灵感来自交易所顶栏的活动入口，但用的是我们自己的字体与色彩。
//
// 两个尺寸：
// - 电脑（xl，≥1280px）：两行大徽标——呼吸灯 + 大号 LIVE / JOIN，下行「比赛进行中 /
//   比赛报名中」（多场时是「N 场比赛…」）。lg 到 xl 之间顶栏已经挤满导航项加右侧一排
//   图标，不挂。
// - 手机 / App（< lg）：同结构的迷你版，约 50px 宽，下行只有一个短状态词（进行中 /
//   报名中），不只写英文。手机顶栏左边 Logo 约 145px、右边信号 / 连接 / 铃铛约 136px，
//   375px 宽的屏只剩这么多。
// 同一状态只有一场时直接跳进那场的详情；多场时进比赛列表。完整说明（「比赛进行中：
// 某某赛」）在 aria-label 与电脑版的悬停提示里。都没有、或比赛入口对该用户未开放
// （内测开关 competitionsVisible）时整个不渲染。
//
// 数据与仪表盘跑马灯同源（GET /competitions），但各自轮询：这里只关心「有没有在进行 /
// 在报名」，2 分钟一次足够；切到后台标签页时暂停（usePollWhileVisible）。报名窗口按
// 渲染时的当前时间判断，不挂秒级时钟——顶栏每秒重渲染不值得，窗口开关最多晚 2 分钟露出。
//
// 上一次拿到的列表记在 localStorage（30 分钟内有效），打开页面时先按它画：主导航是在
// Logo 与右侧图标区之间居中的，徽标要是等请求回来才冒出来，整排导航会在首屏往左跳。
// 有了缓存，导航只在比赛状态真的变了（开赛、报名截止）时挪一次。超过 30 分钟的缓存
// 不用，免得早已结束的比赛闪一下。
//
// Top-bar competition badge, at the front of the right-hand icon row while a
// competition is running or open for signup. Two states, two palettes: running → an
// italic LIVE in brand-purple metal with a green status line; signup open → an italic
// JOIN in champagne-gold metal with a gold one. Running wins when both exist. A
// periodic shimmer runs across the word. Inspired by exchange top-bar promo entries,
// in our own type and colour.
//
// Two sizes:
// - Desktop (xl, ≥1280px): the two-line badge — breathing dot, large LIVE / JOIN, and
//   "contest live / signup open" below ("N contests …" when several). Not shown between
//   lg and xl, where the bar is already full.
// - Phone / App (< lg): a ~50px mini version of the same build with one short status
//   word below, so it never reads as bare English. On a 375px phone the logo takes
//   ~145px and signal / connection / bell ~136px, which leaves about that much.
// A single competition links straight into it; several link to the list. The full
// wording ("contest live: X") is in the aria-label and the desktop tooltip. Renders
// nothing when neither state applies or the competitions beta switch is off.
//
// Same source as the dashboard ticker (GET /competitions), polled on its own every 2
// minutes and paused while hidden. The signup window is judged at render time rather
// than on a per-second clock; a window opening or closing shows up at most two
// minutes late. The last list is kept in localStorage (trusted for 30 minutes) and
// drawn first on load, so the centred nav doesn't jump left when the badge would
// otherwise pop in after the request; it moves only when the state really changes.
// Older entries are ignored so a long-finished competition never flashes up.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { competitionApi } from '../api/client'
import { parseTime } from '../api/utils'
import type { CompetitionListGrouped, CompetitionSummary } from '../api/types'
import { useAuth } from '../store/auth'
import { usePollWhileVisible } from '../utils/usePollWhileVisible'
import { readJson, writeJson } from '../utils/safeStorage'

const POLL_MS = 2 * 60_000
const CACHE_KEY = 'cmp-navbadge'
const CACHE_TTL_MS = 30 * 60_000

export type BadgeData = Pick<CompetitionListGrouped, 'running' | 'upcoming'>

function readCache(): BadgeData | null {
  const c = readJson<{ at: number; data: BadgeData } | null>(CACHE_KEY, null)
  if (!c || typeof c.at !== 'number' || Date.now() - c.at >= CACHE_TTL_MS) return null
  // 形状不对就当没有：这份数据在顶栏渲染路径上，坏值不能把整个页头弄崩。
  // Wrong shape counts as absent: this sits on the header's render path.
  return c.data && Array.isArray(c.data.running) && Array.isArray(c.data.upcoming) ? c.data : null
}

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

// preset：游客预览直接给（公开比赛数据），不轮询、不读写缓存。
// preset: handed in by the guest preview (public competition data); no polling, no cache.
export default function CompetitionNavBadge({ preset }: { preset?: BadgeData | null } = {}) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const visible = preset !== undefined || !!user?.competitionsVisible
  const [polled, setData] = useState<BadgeData | null>(() => (preset !== undefined ? null : readCache()))
  const data = preset !== undefined ? preset : polled

  usePollWhileVisible(
    (isCurrent) => {
      competitionApi.list()
        .then((r) => {
          if (!isCurrent()) return
          const next = { running: r.running, upcoming: r.upcoming }
          setData(next)
          writeJson(CACHE_KEY, { at: Date.now(), data: next })
        })
        .catch(() => {})
    },
    POLL_MS,
    [visible],
    { enabled: visible && preset === undefined },
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

  const word = kind === 'live' ? 'LIVE' : 'JOIN'
  const sub = kind === 'live'
    ? (only ? t('competition.navLive') : t('competition.navLiveCount', { n: list.length }))
    : (only ? t('competition.navJoin') : t('competition.navJoinCount', { n: list.length }))
  const subShort = t(kind === 'live' ? 'competition.navLiveShort' : 'competition.navJoinShort')

  return (
    <>
      {/* 电脑（xl+）：两行大徽标，带呼吸灯与完整状态词。
          Desktop (xl+): the full two-line badge with dot and status line. */}
      <Link to={to} className={`cmp-navlive is-${kind} hidden xl:inline-flex`} aria-label={label} title={label}>
        <span className="cmp-navlive-top" aria-hidden>
          <i className="cmp-navlive-dot" />
          <b>{word}</b>
        </span>
        <span className="cmp-navlive-sub" aria-hidden>{sub}</span>
      </Link>
      {/* 手机 / App（< lg）：同结构的迷你版，下行只放一个短状态词。
          Phone / App (< lg): the mini variant, one short status word below. */}
      <Link to={to} className={`cmp-navlive is-${kind} is-mini inline-flex lg:hidden`} aria-label={label}>
        <span className="cmp-navlive-top" aria-hidden><b>{word}</b></span>
        <span className="cmp-navlive-sub" aria-hidden>{subShort}</span>
      </Link>
    </>
  )
}
