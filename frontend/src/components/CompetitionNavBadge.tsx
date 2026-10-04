// 顶栏比赛徽标（电脑版）：有比赛正在进行或正在报名时，挂在顶栏右侧图标区最前面的
// 一枚单行胶囊，后面跟一条细分隔线，把「活动入口」和右边的「系统状态」（信号 / 连接 /
// 铃铛）分成两组。两种状态两种配色，一眼分得开：
//   进行中 → 绿色呼吸灯 + 品牌紫金属渐变的斜体 LIVE
//   报名中 → 金色呼吸灯 + 香槟金金属渐变的斜体 JOIN
// 两种同时存在时优先显示进行中（正在发生的事比能报名的事更急）。字上有一道定时扫光。
// 灵感来自交易所顶栏的活动入口，但用的是我们自己的字体与色彩。
//
// 尺寸刻意跟右边的「14ms」「已连接」胶囊对齐（同高、同圆角、同边框粗细），只放一个
// 词：顶栏内容最宽只有 max-w-7xl（1280px），主导航在 Logo 与右侧图标区之间居中，右边
// 每多一点宽度导航就被往左挤一点。完整说明（「比赛进行中：某某赛」）放在悬停提示与
// aria-label 里；同一状态有多场时，像连接徽标的「×2」一样在词后加场数。
//
// 同一状态只有一场时直接跳进那场的详情；多场时进比赛列表。只在 xl（≥1280px）显示：
// lg 到 xl 之间顶栏已经挤满导航项加右侧一排图标，英文更长。手机端不挂，比赛入口在
// 底栏「成长」与仪表盘的跑马灯里。都没有、或比赛入口对该用户未开放（内测开关
// competitionsVisible）时整个不渲染，分隔线也一起消失。
//
// 数据与仪表盘跑马灯同源（GET /competitions），但各自轮询：这里只关心「有没有在进行 /
// 在报名」，2 分钟一次足够；切到后台标签页时暂停（usePollWhileVisible）。报名窗口按
// 渲染时的当前时间判断，不挂秒级时钟——顶栏每秒重渲染不值得，窗口开关最多晚 2 分钟露出。
//
// 上一次拿到的列表记在 localStorage（30 分钟内有效），打开页面时先按它画：主导航是在
// Logo 与右侧图标区之间居中的，徽标要是等请求回来才冒出来，整排导航会在首屏往左跳
// 约 50px。有了缓存，导航只在比赛状态真的变了（开赛、报名截止）时挪一次。超过 30 分钟
// 的缓存不用，免得早已结束的比赛闪一下。
//
// Top-bar competition badge (desktop): a single-row pill at the front of the right-hand
// icon row while a competition is running or open for signup, followed by a hairline
// divider that separates this promo entry from the system-status group (signal /
// connection / bell). Two states, two palettes:
//   running     → green breathing dot + italic LIVE in brand-purple metal
//   signup open → gold breathing dot + italic JOIN in champagne-gold metal
// Running wins when both exist. A periodic shimmer runs across the word. Inspired by
// exchange top-bar promo entries, in our own type and colour.
//
// Sized to match the "14ms" / "connected" pills beside it (same height, radius and
// border), with a single word: the bar's content is capped at max-w-7xl (1280px) and
// the main nav is centred between the logo and the right-hand row, so every extra pixel
// here pushes the nav left. The full wording ("contest live: X") lives in the tooltip
// and aria-label; several competitions in that state add a count after the word, like
// the connection pill's "×2".
//
// A single competition links straight into it; several link to the list. xl (≥1280px)
// only; not on mobile, where competitions are reachable from the bottom bar and the
// dashboard ticker. Renders nothing (divider included) when neither state applies or
// the competitions beta switch is off. Same source as the dashboard ticker (GET
// /competitions) polled on its own every 2 minutes, paused while hidden. The signup
// window is judged at render time rather than on a per-second clock; a window opening
// or closing shows up at most two minutes late.
//
// The last list is kept in localStorage (trusted for 30 minutes) and drawn first on
// load: the main nav is centred between the logo and the right-hand row, so a badge
// that only appeared once the request returned would make the whole nav jump ~50px
// left on first paint. With the cache the nav moves only when the state really changes
// (a start, a signup close). Older entries are ignored so a long-finished competition
// never flashes up.
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

type BadgeData = Pick<CompetitionListGrouped, 'running' | 'upcoming'>

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

export default function CompetitionNavBadge() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const visible = !!user?.competitionsVisible
  const [data, setData] = useState<BadgeData | null>(readCache)

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

  return (
    <div className="hidden items-center gap-3 xl:flex">
      <Link to={to} className={`cmp-navlive is-${kind}`} aria-label={label} title={label}>
        <i className="cmp-navlive-dot" aria-hidden />
        <b aria-hidden>{kind === 'live' ? 'LIVE' : 'JOIN'}</b>
        {!only && <span className="cmp-navlive-n num" aria-hidden>×{list.length}</span>}
      </Link>
      <span className="cmp-navlive-sep" aria-hidden />
    </div>
  )
}
