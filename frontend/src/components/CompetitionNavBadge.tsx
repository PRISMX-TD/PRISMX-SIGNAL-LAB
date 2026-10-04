// 顶栏「比赛直播」徽标（电脑版）：有比赛正在进行时，挂在主导航「成长」后面的一枚
// 双行徽标——上面一行是带直播灯的大号斜体 LIVE（品牌紫的金属渐变 + 一道扫光），
// 下面一行是「比赛进行中」小字。灵感来自交易所顶栏的活动入口，但用的是我们自己的
// 字体与色彩，不是照搬。没有进行中的比赛、或比赛入口对该用户未开放（内测开关
// competitionsVisible）时整个不渲染，顶栏不留空位。
//
// 只有一场进行中时直接跳进那场的详情；多场时进比赛列表。只在 xl（≥1280px）显示：
// lg 到 xl 之间顶栏已经挤满 5 个导航项加右侧一排图标，英文更长，再塞一枚会溢出
// （同 Layout 里把桌面/手机分界挪到 lg 的那段测量）。手机端不挂，比赛入口在底栏
// 「成长」与仪表盘的跑马灯里。
//
// 数据与仪表盘跑马灯同源（GET /competitions），但各自轮询：这里只关心「有没有在
// 进行」，2 分钟一次足够发现新开赛与结束；切到后台标签页时暂停（usePollWhileVisible）。
//
// Top-bar "live competition" badge (desktop). While a competition is running, a
// two-line badge sits after the "Growth" nav item: a large italic LIVE with a live
// dot (brand-purple metallic gradient plus a shimmer sweep) over a small "contest
// live" line. Inspired by exchange top-bar promo entries, but in our own type and
// colour. Renders nothing when no competition is running or the competitions beta
// switch is off for this user, so the bar keeps no gap.
//
// One running competition links straight into it; several link to the list. Shown
// only at xl (≥1280px): between lg and xl the bar is already full with five nav
// items plus the icon row, longer in English, and one more item overflows (same
// measurement that moved the desktop/mobile switch to lg in Layout). Not on
// mobile, where competitions are reachable from the bottom bar and the dashboard
// ticker. Same source as the dashboard ticker (GET /competitions) but polled on
// its own: it only needs "is anything running", so every 2 minutes catches starts
// and ends; paused while the tab is hidden (usePollWhileVisible).
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { competitionApi } from '../api/client'
import type { CompetitionSummary } from '../api/types'
import { useAuth } from '../store/auth'
import { usePollWhileVisible } from '../utils/usePollWhileVisible'

const POLL_MS = 2 * 60_000

export default function CompetitionNavBadge() {
  const { t } = useTranslation()
  const { user } = useAuth()
  const visible = !!user?.competitionsVisible
  const [running, setRunning] = useState<CompetitionSummary[]>([])

  usePollWhileVisible(
    (isCurrent) => {
      competitionApi.list()
        .then((r) => { if (isCurrent()) setRunning(r.running) })
        .catch(() => {})
    },
    POLL_MS,
    [visible],
    { enabled: visible },
  )

  if (!visible || running.length === 0) return null

  const only = running.length === 1 ? running[0] : null
  const to = only ? `/competitions?c=${encodeURIComponent(only.id)}` : '/competitions'
  const label = only
    ? t('competition.navLiveOne', { name: only.name })
    : t('competition.navLiveMany', { n: running.length })

  return (
    <Link to={to} className="cmp-navlive hidden xl:inline-flex" aria-label={label} title={label}>
      <span className="cmp-navlive-top" aria-hidden>
        <i className="cmp-navlive-dot" />
        <b>LIVE</b>
      </span>
      <span className="cmp-navlive-sub" aria-hidden>
        {only ? t('competition.navLive') : t('competition.navLiveCount', { n: running.length })}
      </span>
    </Link>
  )
}
